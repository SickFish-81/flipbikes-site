#!/usr/bin/env python3
"""
FLIP label print agent — puts NZ Post consignment labels on paper.

    sale -> app creates the consignment -> THIS -> label waiting in the printer

WHY THIS EXISTS
---------------
The shop runs on Vercel, in a datacentre. It cannot reach a printer sitting on
the workshop network, and no API changes that. Something inside the building has
to pull the label down and print it. This is that something.

It is deliberately dull: poll, download, print, say so. No service to sign up
for, no monthly bill, nothing in the path we don't control. If it breaks you can
read the whole thing in ten minutes.

RUNS ANYWHERE
-------------
Python 3.8+, standard library only. No pip install, no printer driver.

Two ways to print, tried in this order:

  1. IPP straight to the printer's IP. The Brother HL-L2375DW speaks IPP and
     AirPrint (which *is* IPP), so this works with no driver installed on any
     OS. Preferred: a driver update can never break it.
  2. The operating system's own print queue - `lp` on macOS and Linux, and
     PowerShell on Windows - for when the printer is already set up on the
     machine and you'd rather use it.

CONFIGURE WITH ENVIRONMENT VARIABLES (never edit secrets into this file)
------------------------------------------------------------------------
    FLIP_API_BASE    https://www.flipbikes.co.nz
    FLIP_AGENT_TOKEN the shared secret the endpoint checks
    FLIP_PRINTER     printer IP for IPP (e.g. 192.168.1.50), or a queue name
                     for the OS route (e.g. Brother_HL_L2375DW)
    FLIP_POLL_SECS   how often to look, default 60
    FLIP_LOG         where to write the log, default ./flip-label-agent.log

USE
---
    python3 flip_label_agent.py --selftest   # print a test label, prove the path
    python3 flip_label_agent.py --once       # one pass, then exit
    python3 flip_label_agent.py              # poll forever
    python3 flip_label_agent.py --dry-run    # fetch and report, print nothing

THE DUPLEX TRAP
---------------
The HL-L2375DW has automatic two-sided printing ON by default. Without
`sides=one-sided` two labels can land on the two faces of one sheet, and a
label printed on the back of another label is useless. Both print paths below
force one-sided. Do not remove it.

ON FAILURE
----------
Nothing is marked printed unless printing actually succeeded, so the next pass
retries it. A failure is also reported back to the app so it shows up where
someone will see it, instead of a label quietly never existing.
"""

import argparse
import json
import os
import socket
import struct
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import pwg_raster

# ---------------------------------------------------------------- configuration

API_BASE = os.environ.get("FLIP_API_BASE", "https://www.flipbikes.co.nz").rstrip("/")
TOKEN = os.environ.get("FLIP_AGENT_TOKEN", "")
PRINTER = os.environ.get("FLIP_PRINTER", "")
POLL_SECS = int(os.environ.get("FLIP_POLL_SECS", "60"))
LOG_PATH = os.environ.get("FLIP_LOG", "flip-label-agent.log")
HTTP_TIMEOUT = 30


def log(msg):
    """Timestamped, to screen and to file. The file is what you read at 7am
    when Craig says a label didn't come out."""
    line = f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}  {msg}"
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass  # a missing log file must never stop a label printing


# ------------------------------------------------------------------- IPP client
#
# Enough of IPP/2.0 to send one Print-Job and read the status back. The wire
# format is simple: a header, then groups of attributes, then the document.
#
#   version (2 bytes) | operation-id (2) | request-id (4)
#   0x01  operation attributes ...
#   0x02  job attributes ...
#   0x03  end of attributes
#   <the PDF>
#
# Each attribute is: value-tag (1) | name length (2) | name | value length (2) | value

TAG_OPERATION_ATTRS = 0x01
TAG_JOB_ATTRS = 0x02
TAG_END_OF_ATTRS = 0x03

TAG_INTEGER = 0x21
TAG_KEYWORD = 0x44
TAG_NAME = 0x42
TAG_URI = 0x45
TAG_CHARSET = 0x47
TAG_LANGUAGE = 0x48
TAG_MIMETYPE = 0x49

OP_PRINT_JOB = 0x0002


def _attr(tag, name, value):
    if isinstance(value, int):
        payload = struct.pack(">i", value)
    else:
        payload = value.encode("utf-8")
    name_b = name.encode("utf-8")
    return struct.pack(">BH", tag, len(name_b)) + name_b + struct.pack(">H", len(payload)) + payload


def build_print_job(printer_uri, pdf_bytes, job_name="FLIP label", request_id=1,
                    doc_format="application/pdf"):
    """The exact bytes of an IPP Print-Job request.

    attributes-charset MUST come first and attributes-natural-language second —
    the spec is strict about it and printers do reject requests that get it
    wrong."""
    out = struct.pack(">HHI", 0x0200, OP_PRINT_JOB, request_id)

    out += struct.pack(">B", TAG_OPERATION_ATTRS)
    out += _attr(TAG_CHARSET, "attributes-charset", "utf-8")
    out += _attr(TAG_LANGUAGE, "attributes-natural-language", "en")
    out += _attr(TAG_URI, "printer-uri", printer_uri)
    out += _attr(TAG_NAME, "requesting-user-name", "flip-label-agent")
    out += _attr(TAG_NAME, "job-name", job_name)
    out += _attr(TAG_MIMETYPE, "document-format", doc_format)

    out += struct.pack(">B", TAG_JOB_ATTRS)
    # The duplex trap. Not optional.
    out += _attr(TAG_KEYWORD, "sides", "one-sided")
    out += _attr(TAG_INTEGER, "copies", 1)
    # A4 out of the 250-sheet tray, which is the one that's already loaded.
    out += _attr(TAG_KEYWORD, "media", "iso_a4_210x297mm")

    out += struct.pack(">B", TAG_END_OF_ATTRS)
    return out + pdf_bytes


def ipp_status(response_bytes):
    """status-code lives in bytes 2..4 of the reply. Anything under 0x0100 is
    some flavour of success."""
    if len(response_bytes) < 8:
        return None
    return struct.unpack(">H", response_bytes[2:4])[0]




# ------------------------------------------------- asking the printer about itself
#
# THE LESSON OF 28 OCT 2026, in one sentence: do not assume a printer can read
# the thing you are sending it, and do not believe "accepted" means "printed".
#
# The Brother HL-L2375DW refuses application/pdf outright (0x040a) and ACCEPTS
# the same bytes as application/octet-stream before silently binning them. An
# hour went into that, plus a power cycle to clear the job it was stuck on.


def _ipp_request(hostport, op, extra=b"", payload=b"", timeout=None):
    uri = f"ipp://{hostport}/ipp/print"
    body = struct.pack(">HHI", 0x0200, op, 1)
    body += struct.pack(">B", TAG_OPERATION_ATTRS)
    body += _attr(TAG_CHARSET, "attributes-charset", "utf-8")
    body += _attr(TAG_LANGUAGE, "attributes-natural-language", "en")
    body += _attr(TAG_URI, "printer-uri", uri)
    body += _attr(TAG_NAME, "requesting-user-name", "flip-label-agent")
    body += extra
    body += struct.pack(">B", TAG_END_OF_ATTRS)
    body += payload
    req = urllib.request.Request(
        f"http://{hostport}/ipp/print", data=body, method="POST",
        headers={"Content-Type": "application/ipp", "Content-Length": str(len(body))},
    )
    with urllib.request.urlopen(req, timeout=timeout or HTTP_TIMEOUT) as resp:
        return resp.read()


def ipp_attributes(reply):
    """{name: [values]} out of an IPP reply. Multi-value attributes repeat the
    tag with an empty name, which is why the last seen name is carried."""
    out, name, i = {}, None, 8
    while i < len(reply):
        tag = reply[i]
        if tag in (0x01, 0x02, 0x03, 0x04, 0x05):
            i += 1
            if tag == 0x03:
                break
            continue
        if i + 3 > len(reply):
            break
        nlen = struct.unpack(">H", reply[i + 1:i + 3])[0]
        nm = reply[i + 3:i + 3 + nlen].decode("utf-8", "replace")
        j = i + 3 + nlen
        vlen = struct.unpack(">H", reply[j:j + 2])[0]
        val = reply[j + 2:j + 2 + vlen]
        if nlen:
            name = nm
        # 0x21 is integer, 0x23 is ENUM — and job-state and printer-state are
        # both enums. Decoding only 0x21 reads a state back as control
        # characters and makes every job look like it never printed, which is
        # exactly how this was found.
        if tag in (0x21, 0x23) and len(val) == 4:
            v = struct.unpack(">i", val)[0]
        else:
            v = val.decode("utf-8", "replace")
        out.setdefault(name, []).append(v)
        i = j + 2 + vlen
    return out


def printer_formats(hostport):
    """What this printer will actually accept. Empty list = we could not ask."""
    try:
        reply = _ipp_request(hostport, 0x000B)
    except Exception as e:  # noqa: BLE001 - any failure here means "don't know"
        log(f"  could not ask {hostport} what it accepts: {e}")
        return []
    return [f for f in ipp_attributes(reply).get("document-format-supported", [])
            if isinstance(f, str)]


def job_finished(hostport, job_id, wait_secs=120):
    """Did the paper actually come out? Returns (ok, detail).

    'Accepted' is not 'printed'. On 28 Oct the printer sat in deep sleep with
    its network card awake, accepting jobs and printing none of them, while
    reporting printer-state-reasons: none. The only way to know is to watch the
    job reach state 9 (completed) rather than 7/8 (cancelled/aborted)."""
    STATES = {3: "pending", 4: "held", 5: "processing", 6: "stopped",
              7: "cancelled", 8: "aborted", 9: "completed"}
    deadline = time.time() + wait_secs
    last = None
    while time.time() < deadline:
        try:
            reply = _ipp_request(hostport, 0x0009,  # Get-Job-Attributes
                                 extra=_attr(TAG_INTEGER, "job-id", job_id))
            attrs = ipp_attributes(reply)
        except Exception as e:  # noqa: BLE001
            return False, f"could not read job {job_id} back: {e}"
        state = (attrs.get("job-state") or [None])[0]
        last = STATES.get(state, state)
        if state == 9:
            return True, "printed"
        if state in (7, 8):
            why = ", ".join(str(r) for r in attrs.get("job-state-reasons", [])) or "no reason given"
            return False, f"the printer {last} the job ({why})"
        time.sleep(3)
    return False, (f"job {job_id} was accepted but never printed - still {last} after "
                   f"{wait_secs}s. Is the printer asleep, or stuck on an earlier job?")


# ------------------------------------------------------------------ making dots


def rasterise(pdf_bytes, dpi=300):
    """A PDF page as a greyscale bitmap, or None if this machine can't.

    Deliberately optional. A Mac has CUPS, which does this conversion itself on
    the way to an AirPrint printer, so os_print() needs none of it. This exists
    for the case proved on 28 Oct: printing from a machine where the printer
    isn't installed at all."""
    try:
        from PIL import Image  # noqa: PLC0415 - optional, and only on this path
    except ImportError:
        return None
    for tool in (["pdftoppm", "-r", str(dpi), "-gray", "-singlefile", "-png"],
                 None):
        if tool is None:
            break
        if not shutil.which(tool[0]):
            continue
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "in.pdf")
            with open(src, "wb") as fh:
                fh.write(pdf_bytes)
            out = os.path.join(d, "page")
            try:
                subprocess.run(tool + [src, out], capture_output=True, timeout=120, check=True)
            except (subprocess.SubprocessError, OSError):
                continue
            png = out + ".png"
            if os.path.exists(png):
                return Image.open(png).convert("L")
    if shutil.which("gs"):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "in.pdf")
            with open(src, "wb") as fh:
                fh.write(pdf_bytes)
            out = os.path.join(d, "page.png")
            try:
                subprocess.run(["gs", "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pnggray",
                                f"-r{dpi}", f"-sOutputFile={out}", src],
                               capture_output=True, timeout=120, check=True)
            except (subprocess.SubprocessError, OSError):
                return None
            if os.path.exists(out):
                return Image.open(out).convert("L")
    return None


def ipp_print(host, pdf_bytes, job_name="FLIP label", verify=True):
    """Send straight to the printer, in a format it has told us it can read.

    Returns (ok, detail). Never guesses: if the printer cannot take a PDF and
    this machine cannot make dots, it says so and lets the caller fall back to
    the operating system's queue, which can do both."""
    hostport = host if ":" in host else f"{host}:631"
    printer_uri = f"ipp://{hostport}/ipp/print"

    formats = printer_formats(hostport)
    payload, doc_format = pdf_bytes, "application/pdf"

    if formats and "application/pdf" not in formats:
        if "image/pwg-raster" not in formats:
            return False, (f"{hostport} accepts {', '.join(formats)} - none of which we can "
                           "produce. Use the OS print queue instead.")
        img = rasterise(pdf_bytes)
        if img is None:
            return False, (f"{hostport} has no PDF interpreter and this machine has no "
                           "rasteriser (needs Pillow plus pdftoppm or gs). Use the OS "
                           "print queue instead - CUPS does the conversion itself.")
        payload, doc_format = pwg_raster.encode(img), "image/pwg-raster"

    body = build_print_job(printer_uri, payload, job_name, doc_format=doc_format)
    req = urllib.request.Request(
        f"http://{hostport}/ipp/print", data=body, method="POST",
        headers={"Content-Type": "application/ipp", "Content-Length": str(len(body))},
    )
    try:
        # Generous: the printer holds the reply while it spools a big raster.
        with urllib.request.urlopen(req, timeout=max(HTTP_TIMEOUT, 120)) as resp:
            reply = resp.read()
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        return False, f"IPP to {hostport} failed: {e}"

    code = ipp_status(reply)
    if code is None:
        return False, f"IPP to {hostport}: reply too short to be valid ({len(reply)} bytes)"
    if code >= 0x0100:
        return False, f"IPP rejected by {hostport} (status 0x{code:04x}, {doc_format})"

    sent = f"{doc_format}, {len(payload):,} bytes"
    if not verify:
        return True, f"IPP accepted by {hostport} ({sent})"

    job_id = (ipp_attributes(reply).get("job-id") or [None])[0]
    if not isinstance(job_id, int):
        return True, f"IPP accepted by {hostport} ({sent}); no job id to check"
    ok, how = job_finished(hostport, job_id)
    return ok, f"{hostport} job {job_id} ({sent}): {how}"


# --------------------------------------------------- the operating system's way


def os_print(queue, pdf_bytes, job_name="FLIP label"):
    """Hand it to the print queue already set up on this machine.

    Used when FLIP_PRINTER names a queue rather than an IP, or when IPP could
    not be reached. Same one-sided rule."""
    fd, path = tempfile.mkstemp(suffix=".pdf", prefix="flip-label-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(pdf_bytes)

        if sys.platform == "win32":
            # Windows has no lp. Out-Printer goes through the installed driver
            # and prints a PDF without opening anything.
            ps = (
                f"$ErrorActionPreference='Stop';"
                f"Get-Content -LiteralPath '{path}' -Raw -Encoding Byte | Out-Null;"
                f"Start-Process -FilePath '{path}' -Verb PrintTo"
                + (f" -ArgumentList '{queue}'" if queue else "")
                + " -PassThru | Wait-Process -Timeout 60"
            )
            cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps]
        else:
            # macOS and Linux both have lp via CUPS.
            cmd = ["lp", "-o", "sides=one-sided", "-o", "media=A4", "-t", job_name]
            if queue:
                cmd += ["-d", queue]
            cmd += [path]

        try:
            done = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        except FileNotFoundError:
            return False, f"no print command available on this platform ({sys.platform})"
        except subprocess.TimeoutExpired:
            return False, "the print command hung for 90s"

        if done.returncode == 0:
            return True, f"queued via {cmd[0]}: {(done.stdout or '').strip() or 'accepted'}"
        return False, f"{cmd[0]} exited {done.returncode}: {(done.stderr or done.stdout or '').strip()}"
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def looks_like_host(value):
    """An IP or hostname means 'go straight at it with IPP'. Anything with a
    space or an underscore is a queue name."""
    if not value:
        return False
    head = value.split(":")[0]
    if head.replace(".", "").isdigit():
        return True
    return "_" not in value and " " not in value and "." in head


def print_pdf(pdf_bytes, job_name="FLIP label"):
    """IPP first, then the OS queue. Returns (ok, detail)."""
    attempts = []
    if looks_like_host(PRINTER):
        ok, detail = ipp_print(PRINTER, pdf_bytes, job_name)
        attempts.append(detail)
        if ok:
            return True, detail
    ok, detail = os_print(PRINTER if not looks_like_host(PRINTER) else "", pdf_bytes, job_name)
    attempts.append(detail)
    return ok, " | ".join(attempts)


# ------------------------------------------------------------- a test label PDF
#
# Hand-built so --selftest needs no dependencies. One page at 174x100mm, the
# default NZ Post label size, so what comes out is the real shape.


def make_test_label(text_lines):
    W, H = 174 / 25.4 * 72, 100 / 25.4 * 72  # mm -> points

    content = ["0.6 w", "6 6 %.2f %.2f re S" % (W - 12, H - 12), "BT /F1 13 Tf 18 %.2f Td" % (H - 30)]
    for i, line in enumerate(text_lines):
        safe = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        if i:
            content.append("0 -17 Td")
        content.append(f"({safe}) Tj")
    content.append("ET")
    stream = "\n".join(content).encode("latin-1", "replace")

    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
        % (W, H),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for n, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n" % (len(objs) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


# ----------------------------------------------------------------- the shop API


def api(path, method="GET", payload=None):
    url = f"{API_BASE}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else {}


def fetch_pending():
    got = api("/api/labels/pending")
    return got.get("labels", []) if isinstance(got, dict) else (got or [])


def fetch_label_pdf(label):
    """Either the app hands us base64 inline, or a URL to fetch."""
    import base64

    if label.get("pdf_base64"):
        return base64.b64decode(label["pdf_base64"])
    url = label.get("pdf_url")
    if not url:
        raise ValueError("label has neither pdf_base64 nor pdf_url")
    if url.startswith("/"):
        url = f"{API_BASE}{url}"
    headers = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read()


def mark_printed(label_id):
    api(f"/api/labels/{label_id}/printed", method="POST", payload={"printed": True})


def report_error(label_id, message):
    try:
        api(f"/api/labels/{label_id}/printed", method="POST",
            payload={"printed": False, "error": message[:500]})
    except Exception as e:  # reporting must never be what crashes the agent
        log(f"  (could not report the failure either: {e})")


# ------------------------------------------------------------------- one pass


def one_pass(dry_run=False):
    try:
        pending = fetch_pending()
    except Exception as e:
        log(f"could not ask the app for labels: {e}")
        return 0

    if not pending:
        return 0

    log(f"{len(pending)} label(s) to print")
    done = 0
    for label in pending:
        lid = label.get("id") or label.get("consignment_id") or "?"
        who = label.get("name") or label.get("tracking_number") or lid
        if dry_run:
            log(f"  [dry run] would print {lid} for {who}")
            continue
        try:
            pdf = fetch_label_pdf(label)
        except Exception as e:
            log(f"  {lid}: could not get the PDF: {e}")
            report_error(lid, f"could not get the PDF: {e}")
            continue

        ok, detail = print_pdf(pdf, job_name=f"FLIP label {lid}")
        if ok:
            log(f"  {lid} ({who}): printed - {detail}")
            try:
                mark_printed(lid)
                done += 1
            except Exception as e:
                # Printed but not recorded: it will print again next pass. Say
                # so loudly, because a duplicate label is confusing in a way a
                # missing one isn't.
                log(f"  {lid}: PRINTED BUT NOT RECORDED ({e}) - it may print again")
        else:
            log(f"  {lid} ({who}): NOT printed - {detail}")
            report_error(lid, detail)
    return done


def selftest():
    log("self test: building a 174x100mm test label")
    pdf = make_test_label([
        "FLIP label print agent - test page",
        "",
        f"printer:  {PRINTER or '(default queue)'}",
        f"host:     {socket.gethostname()}",
        f"platform: {sys.platform}",
        f"time:     {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "If this came out one-sided, the path works.",
    ])
    log(f"self test: PDF is {len(pdf)} bytes")
    if not PRINTER:
        log("self test: FLIP_PRINTER is not set - trying the default queue")
    ok, detail = print_pdf(pdf, job_name="FLIP agent self test")
    log(("self test: OK - " if ok else "self test: FAILED - ") + detail)
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="Print FLIP consignment labels.")
    ap.add_argument("--once", action="store_true", help="one pass, then exit")
    ap.add_argument("--selftest", action="store_true", help="print a test label and exit")
    ap.add_argument("--dry-run", action="store_true", help="fetch and report, print nothing")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    log(f"agent starting - api={API_BASE} printer={PRINTER or '(default queue)'} "
        f"every={POLL_SECS}s platform={sys.platform}")
    if not TOKEN:
        log("WARNING: FLIP_AGENT_TOKEN is not set; the endpoint will almost certainly refuse us")

    if args.once or args.dry_run:
        one_pass(dry_run=args.dry_run)
        return 0

    while True:
        try:
            one_pass()
        except KeyboardInterrupt:
            log("stopped")
            return 0
        except Exception as e:  # the loop outlives any single surprise
            log(f"unexpected error, carrying on: {e}")
        time.sleep(POLL_SECS)


if __name__ == "__main__":
    sys.exit(main())
