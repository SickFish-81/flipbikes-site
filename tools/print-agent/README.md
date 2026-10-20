# FLIP label print agent

Puts NZ Post consignment labels on paper in the workshop.

    sale -> the shop creates the consignment -> this -> label waiting in the printer

## Why it exists

The shop runs on Vercel, in a datacentre. **It cannot reach a printer on the
workshop network**, and no API changes that. Something inside the building has
to pull the label down and print it. This is that something.

Email-to-print would have avoided it entirely, but the printer is a **Brother
HL-L2375DW**, which doesn't have it — Web Connect / Email Print is a higher-tier
Brother feature. (HP's equivalent, ePrint, is discontinued.) So: a small agent,
no third party in the path, no monthly bill.

## What it needs

Python 3.8+. **That's all** — standard library only, no `pip install`, and no
printer driver.

## Setup

```sh
export FLIP_API_BASE=https://www.flipbikes.co.nz
export FLIP_AGENT_TOKEN=...        # the shared secret the endpoint checks
export FLIP_PRINTER=192.168.1.50   # the printer's IP, or a queue name
python3 flip_label_agent.py --selftest
```

If a test label comes out, the hard part is done.

```sh
python3 flip_label_agent.py --once      # one pass, then exit
python3 flip_label_agent.py             # poll forever (default every 60s)
python3 flip_label_agent.py --dry-run   # fetch and report, print nothing
```

### `FLIP_PRINTER`: IP or queue name?

| You set | It does |
|---|---|
| `192.168.1.50` or `printer.local` | **IPP straight to the printer.** No driver needed, any OS. Preferred |
| `Brother_HL_L2375DW` | Hands it to the print queue already set up on this machine |
| unset | The machine's default printer |

IPP is tried first when the value looks like a host, and it falls back to the
OS queue if the printer can't be reached. **The HL-L2375DW speaks IPP and
AirPrint** (AirPrint *is* IPP), so the driverless path works on macOS, Windows
10+ and Linux alike — and a driver update can never break it.

Use the printer's **Ethernet** port rather than Wi-Fi. A label printer nobody is
watching is exactly where a sleeping wireless link costs you an order.

## The duplex trap

The HL-L2375DW has automatic two-sided printing **on by default**. Without
`sides=one-sided`, two labels can land on the two faces of one sheet — and a
label printed on the back of another label is useless.

Both print paths force one-sided, and `test_agent.py` asserts it. **Don't
remove it.**

## Running it unattended

- **macOS:** a LaunchAgent plist, or `screen`/`tmux` while you're proving it.
- **Linux / Raspberry Pi:** a systemd unit with `Restart=always`.
- **Windows:** Task Scheduler, "run whether user is logged on or not".

It writes `flip-label-agent.log` beside itself. That's the file to read when
Craig says a label didn't come out.

## What happens when things go wrong

- **A label is only marked printed if printing actually succeeded**, so the next
  pass retries it. Failures are reported back to the app so they appear where
  someone will see them, rather than a label quietly never existing.
- **Printed but not recorded** is logged loudly, because it means the label may
  print twice — and a duplicate is more confusing than a missing one.
- The poll loop survives any single error and carries on.

## Tests

```sh
python3 test_agent.py
```

29 checks. It stands up a **fake IPP printer**, decodes the request the agent
sends, and asserts the things a real printer is strict about: `attributes-charset`
first, `attributes-natural-language` second, `printer-uri` as a URI,
`document-format` as a mimeMediaType, `sides=one-sided` in the *job* group, and
the PDF arriving byte-identical. It also checks a rejecting printer and an
unreachable one both report failure rather than silently passing.

No printer required to run them.

## The app side

Both endpoints now exist (20 Oct 2026):

- `GET /api/labels/pending` → `{ "labels": [ { id, name, consignment_id, tracking_number, pdf_url } ] }`
- `POST /api/labels/:id/printed` → `{ printed: true }`, or `{ printed: false, error }`

`id` is the **invoice number** — short enough to read out over the phone, and
it keeps a customer's Stripe session id out of this agent's log file.

Both want `Authorization: Bearer $FLIP_AGENT_TOKEN`, and
**`FLIP_AGENT_TOKEN` is not set in Vercel yet**, so today both answer
`503 Label printing isn't switched on`. That is deliberate: an unset token is a
refusal, never a free pass. Set the same value here and in Vercel.

### It will say "nothing to print" for a while yet, and that is correct

A label is only offered once it has a consignment id **and** a stored PDF. The
consignment step is the part still to build, so nothing satisfies that
condition and `pending` returns `[]`. Offering a label with no PDF would have
this agent fail, report the error, and retry a minute later, forever.

`GET /api/labels/:id/pdf` — which `pdf_url` points at — arrives with that same
piece of work.

### What is guaranteed to you

- **A failed label stays pending.** Reporting `printed: false` records the
  reason and does *not* stamp `printed_at`, so the next poll tries again.
  Nothing makes a label quietly disappear.
- **Reporting the same print twice is safe.** The first timestamp wins and the
  reply says `already: true`.
- **A reported failure gets a 200.** The request succeeded — we now know the
  label didn't print. Answering 4xx would make you treat our record-keeping as
  broken and give up on the message that says something needs attention.

See `claude/flip-label-automation.md` in the project for the rest of the plan.
