"""Verify the agent's IPP request is well-formed, by standing up a fake printer
that decodes it, and that the self-test PDF is a real PDF."""
import struct, threading, sys, os
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ["FLIP_PRINTER"] = "127.0.0.1:6310"
import flip_label_agent as A

received = {}

def decode_ipp(body):
    """Decode enough to prove we built it right."""
    ver, op, rid = struct.unpack(">HHI", body[:8])
    i = 8
    attrs, group = {}, None
    while i < len(body):
        tag = body[i]
        if tag == A.TAG_END_OF_ATTRS:
            i += 1
            break
        if tag in (A.TAG_OPERATION_ATTRS, A.TAG_JOB_ATTRS):
            group = tag; i += 1; continue
        nlen = struct.unpack(">H", body[i+1:i+3])[0]
        name = body[i+3:i+3+nlen].decode()
        j = i+3+nlen
        vlen = struct.unpack(">H", body[j:j+2])[0]
        val = body[j+2:j+2+vlen]
        attrs[name] = (group, tag, val)
        i = j+2+vlen
    return {"version": ver, "op": op, "request_id": rid, "attrs": attrs, "doc": body[i:]}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers["Content-Length"])
        body = self.rfile.read(n)
        received["ctype"] = self.headers["Content-Type"]
        received["path"] = self.path
        received.update(decode_ipp(body))
        # A minimal valid IPP success reply: version, status 0x0000, request-id
        reply = struct.pack(">HHI", 0x0200, 0x0000, received["request_id"]) + bytes([A.TAG_END_OF_ATTRS])
        self.send_response(200)
        self.send_header("Content-Type", "application/ipp")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

srv = HTTPServer(("127.0.0.1", 6310), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails = []
def check(label, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"   {detail}" if detail and not cond else ""))
    if not cond: fails.append(label)

print("=== the self-test PDF ===")
pdf = A.make_test_label(["FLIP test", "line two"])
check("starts with %PDF", pdf.startswith(b"%PDF-"))
check("ends with %%EOF", pdf.rstrip().endswith(b"%%EOF"))
check("has an xref table", b"\nxref\n" in pdf)
check("declares 174x100mm MediaBox", b"493.23 283.46" in pdf, pdf[:400])
check("plausible size", 600 < len(pdf) < 20000, f"{len(pdf)} bytes")

print("\n=== the IPP Print-Job request, as a printer sees it ===")
ok, detail = A.ipp_print("127.0.0.1:6310", pdf, "unit test")
check("printer accepted it", ok, detail)
check("posted to /ipp/print", received.get("path") == "/ipp/print", received.get("path"))
check("Content-Type is application/ipp", received.get("ctype") == "application/ipp")
check("IPP version 2.0", received.get("version") == 0x0200)
check("operation is Print-Job (0x0002)", received.get("op") == A.OP_PRINT_JOB)

at = received.get("attrs", {})
names = list(at)
check("attributes-charset is FIRST", names[:1] == ["attributes-charset"], names[:3])
check("attributes-natural-language is SECOND", names[1:2] == ["attributes-natural-language"], names[:3])
check("printer-uri present and a URI", at.get("printer-uri", (0,0,b""))[1] == A.TAG_URI)
check("printer-uri points at the right host",
      at.get("printer-uri", (0,0,b""))[2] == b"ipp://127.0.0.1:6310/ipp/print",
      at.get("printer-uri"))
check("document-format is application/pdf", at.get("document-format", (0,0,b""))[2] == b"application/pdf")
check("document-format tagged mimeMediaType", at.get("document-format", (0,0,b""))[1] == A.TAG_MIMETYPE)

print("\n=== the duplex trap ===")
check("sides attribute present", "sides" in at)
check("sides == one-sided", at.get("sides", (0,0,b""))[2] == b"one-sided", at.get("sides"))
check("sides is in the JOB group, not operation",
      at.get("sides", (0,0,b""))[0] == A.TAG_JOB_ATTRS)
check("media is A4", at.get("media", (0,0,b""))[2] == b"iso_a4_210x297mm")
check("copies is integer 1", struct.unpack(">i", at.get("copies", (0,0,b"\0\0\0\0"))[2])[0] == 1)

print("\n=== the document survived the encoding ===")
check("PDF arrived byte-identical", received.get("doc") == pdf,
      f"sent {len(pdf)}, got {len(received.get('doc', b''))}")

print("\n=== host vs queue detection ===")
for value, expect in [("192.168.1.50", True), ("192.168.1.50:631", True),
                      ("printer.local", True), ("Brother_HL_L2375DW", False),
                      ("Brother HL-L2375DW", False), ("", False)]:
    check(f"{value!r} -> {'IPP' if expect else 'queue'}", A.looks_like_host(value) == expect)

print("\n=== a rejecting printer is reported, not swallowed ===")
class Reject(Handler):
    def do_POST(self):
        n = int(self.headers["Content-Length"]); self.rfile.read(n)
        reply = struct.pack(">HHI", 0x0200, 0x0400, 1)  # client-error-bad-request
        self.send_response(200); self.send_header("Content-Length", str(len(reply))); self.end_headers()
        self.wfile.write(reply)
srv2 = HTTPServer(("127.0.0.1", 6311), Reject)
threading.Thread(target=srv2.serve_forever, daemon=True).start()
ok2, d2 = A.ipp_print("127.0.0.1:6311", pdf)
check("rejection returns ok=False", ok2 is False, d2)
check("rejection names the status code", "0x0400" in d2, d2)

ok3, d3 = A.ipp_print("127.0.0.1:6399", pdf)  # nothing listening
check("unreachable printer returns ok=False", ok3 is False)
check("unreachable printer explains itself", "failed" in d3.lower(), d3)

print()
print(f"{'ALL CHECKS PASSED' if not fails else str(len(fails)) + ' FAILED: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
