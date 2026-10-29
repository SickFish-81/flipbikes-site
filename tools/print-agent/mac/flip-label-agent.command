#!/bin/bash
#
# FLIP label printer — the workshop end.
#
#   a customer pays  ->  the shop books the courier  ->  THIS  ->  a label in
#   the printer, ready to tape to the box.
#
# WHY THIS IS A SHELL SCRIPT AND NOT AN APP
#
# Everything it needs, a Mac already has: curl to fetch the label and lp to
# print it. No Python, nothing to install, nothing to keep updated, and no
# "unidentified developer" warning to click past. If it ever misbehaves you can
# read the whole thing in ten minutes.
#
# TO SET IT UP
#
#   1. Add the printer: System Settings > Printers & Scanners > Add. The
#      Brother appears by itself over AirPrint; no driver download.
#   2. Open flip-agent.conf next to this file and fill in the two blanks.
#   3. Double-click this file. A Terminal window opens and stays open. That
#      window IS the agent — closing it stops the printing.
#
# Craig: if the window says it cannot reach the shop, that is usually the
# internet rather than this. If it says the printer is not responding, check
# the printer is on and awake.

set -uo pipefail
cd "$(dirname "$0")"

CONF="flip-agent.conf"
# First run: make the settings file from the example and stop, rather than
# failing with something cryptic. The example is what ships; the real one is
# never committed, because it holds the key.
if [ ! -f "$CONF" ]; then
  if [ -f "$CONF.example" ]; then
    cp "$CONF.example" "$CONF"
    echo "I've made a settings file for you: $CONF"
    echo "Open it, fill in the two blanks, save it, then double-click this again."
    open -e "$CONF" 2>/dev/null || true
  else
    echo "Can't find $CONF next to this script."
  fi
  read -r -p "Press return to close."; exit 1
fi
# shellcheck disable=SC1090
. "./$CONF"

API="${FLIP_API_BASE:-https://www.flipbikes.co.nz}"
TOKEN="${FLIP_AGENT_TOKEN:-}"
QUEUE="${FLIP_PRINTER:-}"
EVERY="${FLIP_POLL_SECS:-60}"
LOG="${FLIP_LOG:-flip-label-agent.log}"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

[ -n "$TOKEN" ] || { say "FLIP_AGENT_TOKEN is empty in $CONF — nothing can be fetched without it."; read -r -p "Press return to close."; exit 1; }
[ -n "$QUEUE" ] || { say "FLIP_PRINTER is empty in $CONF — I don't know which printer to use."; echo; echo "Printers this Mac knows about:"; lpstat -p 2>/dev/null | sed 's/^/   /'; read -r -p "Press return to close."; exit 1; }

if ! lpstat -p "$QUEUE" >/dev/null 2>&1; then
  say "This Mac has no printer called '$QUEUE'."
  echo "Printers it does have:"; lpstat -p 2>/dev/null | sed 's/^/   /'
  echo "Put one of those names in $CONF."
  read -r -p "Press return to close."; exit 1
fi

say "started — printing to '$QUEUE', checking every ${EVERY}s"
say "leave this window open; closing it stops the printing"

# Mark a label done (or failed) back at the shop. Never fatal: a label that
# printed and could not be reported is a nuisance, a crash here is an outage.
report() {
  local id="$1" ok="$2" msg="${3:-}"
  local body
  if [ "$ok" = "yes" ]; then body='{"printed":true}'
  else body="{\"printed\":false,\"error\":$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')}"
  fi
  curl -fsS -m 30 -X POST "$API/api/labels/$id/printed" \
       -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
       -d "$body" >/dev/null 2>&1 \
    || say "  (couldn't tell the shop about $id — it will be offered again)"
}

print_one() {
  local id="$1" pdf job out
  pdf="$(mktemp -t fliplabel).pdf"

  if ! curl -fsS -m 60 -o "$pdf" -H "Authorization: Bearer $TOKEN" "$API/api/labels/$id/pdf"; then
    say "  $id: couldn't download the label"
    report "$id" no "could not download the label sheet"
    rm -f "$pdf"; return
  fi
  # A PDF starts with %PDF-. Anything else is an error page we should not print.
  if ! head -c 5 "$pdf" | grep -q '%PDF-'; then
    say "  $id: what came back wasn't a PDF"
    report "$id" no "the shop returned something that was not a PDF"
    rm -f "$pdf"; return
  fi

  # sides=one-sided is NOT optional. The Brother duplexes by default, and a
  # label printed on the back of another label is useless.
  out="$(lp -d "$QUEUE" -o sides=one-sided -o media=A4 -t "FLIP label $id" "$pdf" 2>&1)" || {
    say "  $id: lp refused it — $out"
    report "$id" no "lp refused the job: $out"
    rm -f "$pdf"; return
  }
  job="$(printf '%s' "$out" | sed -n 's/.*request id is \([^ ]*\).*/\1/p')"
  rm -f "$pdf"

  # ACCEPTED IS NOT PRINTED. On 28 Oct the printer sat asleep accepting jobs
  # and printing none of them, reporting nothing wrong. So watch the job leave
  # the queue instead of trusting that lp took it.
  local waited=0
  while [ "$waited" -lt 180 ]; do
    if ! lpstat -o "$QUEUE" 2>/dev/null | grep -q "^${job} "; then
      say "  $id: printed"
      report "$id" yes
      return
    fi
    sleep 5; waited=$((waited + 5))
  done
  say "  $id: still queued after 3 minutes — printer asleep, out of paper, or stuck"
  report "$id" no "job $job was accepted but had not printed after 3 minutes"
}

quiet_since=""
while true; do
  resp="$(curl -fsS -m 30 -H "Authorization: Bearer $TOKEN" "$API/api/labels/pending" 2>/dev/null)"
  code=$?
  if [ $code -ne 0 ]; then
    # 503 is the shop saying label printing isn't switched on yet. Say it once,
    # not sixty times an hour.
    if [ "$quiet_since" != "unreachable" ]; then
      say "can't reach the shop (or it isn't switched on yet) — will keep trying quietly"
      quiet_since="unreachable"
    fi
  else
    quiet_since=""
    # Picking the ids out with grep rather than a JSON parser, because a Mac
    # has no jq and this is the one thing in the reply we need. Tolerant of
    # whitespace on purpose: '"id": 1006' and '"id":1006' are the same thing,
    # and a pattern that only matched one of them would quietly print nothing
    # the day the server's formatting changed.
    ids="$(printf '%s' "$resp" | grep -Eo '"id"[[:space:]]*:[[:space:]]*[0-9]+' | grep -Eo '[0-9]+')"
    if [ -n "$ids" ]; then
      n="$(printf '%s\n' "$ids" | wc -l | tr -d ' ')"
      say "$n label(s) to print"
      for id in $ids; do print_one "$id"; done
    fi
  fi
  sleep "$EVERY"
done
