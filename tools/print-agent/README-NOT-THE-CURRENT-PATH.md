# This is a road not taken — read before you use any of it

Everything in this folder works. None of it is in use, and the decision not to
use it was deliberate. If you are here because you found `flip_label_agent.py`
and wondered why nothing runs it, this is why.

## What it was for

A daemon on a machine in the workshop, polling the shop for labels and printing
them unattended, so a label is waiting in the printer before anyone walks over.
It was built, and on 28 October 2026 it printed a real consignment label at
Craig's workshop, end to end.

## Why it was retired, the same week

The shop does **four or five orders a month**, and Craig is already in the app
pressing "Packed and ready to send" on every one of them. Against that, the
agent asks for: a shared secret on a workshop machine, a Terminal window that
must stay open, a Mac that must never sleep, and a background service nobody
monitors. Every one of those is a new way for a label to silently not exist, to
save one click five times a month.

And the printer's worst habit makes the case on its own. The Brother sleeps
deeply enough to **accept print jobs and print none of them** while reporting
nothing wrong. That is invisible to a daemon and obvious to a person standing
at the printer watching nothing come out.

So printing is something Craig does, from a page in the app, on any device on
that network. The failure he can see costs ten seconds. The failure he cannot
see costs a customer.

> The rule worth keeping: **don't automate a step whose failure you can't
> detect, when a person doing it gets the feedback for free.**

## What is worth keeping in here anyway

Two things that cost real time to learn, and that nothing else in either repo
records:

**`pwg_raster.py` — the Brother cannot read PDFs.** Asked directly it accepts
only `application/octet-stream`, `image/urf` and `image/pwg-raster`. Sent a
PDF as `application/pdf` it answers IPP `0x040a`, document-format-not-supported.
Sent the *same* PDF as `octet-stream` — its own default — it **accepts the job
with status 0x0000 and silently bins it**, which is worse, because nothing
anywhere says the label did not print. A phone gets away with AirPrint because
iOS rasterises first. This file is that step: the 1796-byte CUPS v2 page header
plus PWG 5102.4 run-length lines, standard library only. An A4 page at 300dpi
is 8.7MB of pixels and leaves here around 550KB.

None of that matters when a browser prints, because the operating system does
the conversion. It matters a great deal if anyone ever talks to the printer
directly again.

**Checking that the paper came out.** `job_finished()` watches the job reach
`completed` rather than trusting the accept. It is the same lesson as
`emailed = true` not meaning delivered, and as a consignment id that is a lie —
this project has now been bitten three times by a layer reporting success for
something it did not do.

## What replaced it

`app/flip-orders/[invoice]/label` in the betterservice-app repo. One A4 sheet,
address on the top half, pick list on the bottom, cut line between. Craig prints
it like he prints everything else.

## If you are bringing this back

You would want to, if the shop ever does enough volume that a click per order
is a real cost. In that case:

- the two endpoints it polls (`/api/labels/pending`, `/api/labels/[id]/printed`)
  are still here and still tested, and both refuse until `FLIP_AGENT_TOKEN` is
  set in Vercel;
- `mac/flip-label-agent.command` is the version to start from on a Mac — no
  Python, no install, and CUPS does the rasterising;
- the printer is on wifi and DHCP. Use the node name `BRWDCE994372863.local`,
  never the address.
