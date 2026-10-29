"""PWG Raster — dots, for a printer that cannot read documents.

WHY THIS FILE EXISTS

The Brother HL-L2375DW has no PDF interpreter. Asked what it accepts
(Get-Printer-Attributes, 28 Oct 2026) it answers exactly three things:

    application/octet-stream
    image/urf
    image/pwg-raster

Sending it a PDF as application/pdf is refused outright: IPP status 0x040a,
document-format-not-supported. Sending the SAME PDF as octet-stream — the
printer's own default — is ACCEPTED with status 0x0000 and then silently
binned, which is worse, because nothing anywhere says the label did not print.

A phone gets away with AirPrint because iOS turns the page into dots before
anything reaches the printer. This is that step.

Standard library only, like the rest of the agent. The format is the 1796-byte
CUPS v2 page header (which PWG Raster reuses) followed by run-length encoded
lines per PWG 5102.4. A real A4 page at 300dpi is 8.7MB of pixels and comes out
around 550KB encoded.
"""

import struct

def _hdr(width, height, dpi=300, bpp=8, colorspace=18, page_w_pt=595.28, page_h_pt=841.89):
    b = bytearray(1796)
    def s(off, text, size):
        raw = text.encode("ascii")[:size-1]; b[off:off+len(raw)] = raw
    def u(off, *v): struct.pack_into(">" + "I"*len(v), b, off, *v)
    def f(off, *v): struct.pack_into(">" + "f"*len(v), b, off, *v)
    u(256, 0, 0, 0, 0)
    u(272, 0)                       # Duplex = one-sided
    u(276, dpi, dpi)
    u(284, 0, 0, 0, 0)
    u(300, 0, 0, 0); u(312, 0, 0); u(320, 0, 0, 0, 0, 0)
    u(340, 1); u(344, 0, 0)
    u(352, int(page_w_pt), int(page_h_pt))
    u(360, 0, 0, 0)
    u(372, width, height)
    u(380, 0)
    u(384, bpp, bpp)
    u(392, width * (bpp//8))
    u(396, 0, colorspace, 0)
    u(408, 0, 0, 0); u(420, 1)
    f(424, 1.0); f(428, page_w_pt, page_h_pt); f(436, 0.0, 0.0, page_w_pt, page_h_pt)
    s(1732, "iso_a4_210x297mm", 64)
    return bytes(b)

def _line(row):
    out = bytearray(); i, n = 0, len(row)
    while i < n:
        px = row[i]; run = 1
        while i+run < n and row[i+run] == px and run < 128: run += 1
        if run > 1:
            out.append(run-1); out.append(px); i += run
        else:
            lit = bytearray()
            while i < n and len(lit) < 128:
                if i+1 < n and row[i] == row[i+1]: break
                lit.append(row[i]); i += 1
            # A literal group encodes 2..128 pixels (257-N). A lone pixel has
            # to go out as a run of one, or the count byte overflows to 256.
            if len(lit) == 1:
                out.append(0)
            else:
                out.append(257-len(lit))
            out += lit
    return bytes(out)

def encode(img, dpi=300):
    w, h = img.size; data = img.tobytes()
    out = bytearray(b"RaS2"); out += _hdr(w, h, dpi=dpi)
    prev, repeat = None, 0
    for y in range(h):
        row = data[y*w:(y+1)*w]
        if row == prev and repeat < 255: repeat += 1; continue
        if prev is not None: out += bytes([repeat]) + _line(prev)
        prev, repeat = row, 0
    if prev is not None: out += bytes([repeat]) + _line(prev)
    return bytes(out)
