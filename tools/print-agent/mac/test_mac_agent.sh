#!/bin/bash
# Exercise the Mac agent against a fake shop and a fake printer, so the thing
# that goes to Craig has been run before he runs it.
set -uo pipefail
cd "$(dirname "$0")"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"; kill %1 2>/dev/null' EXIT
fails=0
check() { if [ "$2" = "yes" ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fails=$((fails+1)); fi; }

# ---- a fake shop
cat > "$WORK/shop.py" <<'PY'
import http.server, json, sys
STATE = {"printed": [], "errors": [], "pdf_ok": True}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _auth(self):
        return self.headers.get("Authorization") == "Bearer testtoken"
    def do_GET(self):
        if not self._auth(): self.send_response(401); self.end_headers(); self.wfile.write(b"no"); return
        if self.path == "/api/labels/pending":
            body = json.dumps({"labels":[{"id":1006,"name":"A","pdf_url":"/api/labels/1006/pdf"},
                                         {"id":1007,"name":"B","pdf_url":"/api/labels/1007/pdf"}]}).encode()
            self.send_response(200); self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body); return
        if self.path.endswith("/pdf"):
            body = b"%PDF-1.4 fake" if STATE["pdf_ok"] else b"<html>error</html>"
            self.send_response(200); self.send_header("Content-Length",str(len(body))); self.end_headers()
            self.wfile.write(body); return
        self.send_response(404); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("Content-Length","0")); raw = self.rfile.read(n)
        d = json.loads(raw or b"{}")
        lid = self.path.split("/")[3]
        (STATE["printed"] if d.get("printed") else STATE["errors"]).append((lid, d.get("error","")))
        open("/tmp/flip_test_state.json","w").write(json.dumps(STATE))
        self.send_response(200); self.send_header("Content-Length","2"); self.end_headers(); self.wfile.write(b"ok")
http.server.HTTPServer(("127.0.0.1", 8731), H).serve_forever()
PY
python3 "$WORK/shop.py" & sleep 1

# ---- a fake printer: lp records the job, lpstat clears it
mkdir -p "$WORK/bin"
cat > "$WORK/bin/lp" <<'SH'
#!/bin/bash
echo "$@" >> /tmp/flip_test_lp.log
echo "request id is FakeQ-77 (1 file(s))"
SH
cat > "$WORK/bin/lpstat" <<'SH'
#!/bin/bash
case "$1" in
  -p) if [ -z "${2:-}" ] || [ "${2}" = "FakeQ" ]; then echo "printer FakeQ is idle."; exit 0; fi; echo "lpstat: Invalid destination name"; exit 1 ;;
  -o) exit 0 ;;   # queue empty = the job printed
esac
SH
chmod +x "$WORK/bin/lp" "$WORK/bin/lpstat"
export PATH="$WORK/bin:$PATH"
# This VM sends everything through an HTTPS proxy; the fake shop is local.
export no_proxy="127.0.0.1,localhost" NO_PROXY="127.0.0.1,localhost"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
rm -f /tmp/flip_test_lp.log /tmp/flip_test_state.json

cat > "$WORK/conf" <<'C'
FLIP_API_BASE="http://127.0.0.1:8731"
FLIP_AGENT_TOKEN="testtoken"
FLIP_PRINTER="FakeQ"
FLIP_POLL_SECS=1
FLIP_LOG="/tmp/flip_test_agent.log"
C
cp flip-label-agent.command "$WORK/agent.command"; cp flip-agent.conf.example "$WORK/flip-agent.conf.example"; cp "$WORK/conf" "$WORK/flip-agent.conf"
rm -f /tmp/flip_test_agent.log
( cd "$WORK" && timeout 20 bash agent.command >/tmp/flip_test_out.log 2>&1 )

echo "=== the happy path ==="
grep -q "2 label(s) to print" /tmp/flip_test_out.log && check "found both labels in the pending list" yes || check "found both labels in the pending list" no
grep -q "1006: printed" /tmp/flip_test_out.log && check "printed 1006" yes || check "printed 1006" no
grep -q "1007: printed" /tmp/flip_test_out.log && check "printed 1007" yes || check "printed 1007" no

echo "=== the duplex trap ==="
grep -q -- "-o sides=one-sided" /tmp/flip_test_lp.log && check "lp was told sides=one-sided" yes || check "lp was told sides=one-sided" no
grep -q -- "-o media=A4" /tmp/flip_test_lp.log && check "lp was told media=A4" yes || check "lp was told media=A4" no
grep -q -- "-d FakeQ" /tmp/flip_test_lp.log && check "lp was given the configured printer" yes || check "lp was given the configured printer" no

echo "=== it reported back ==="
python3 - <<'PY'
import json
s = json.load(open("/tmp/flip_test_state.json"))
print("  printed reported:", [i for i,_ in s["printed"]])
print("  errors reported:", s["errors"])
PY

echo "=== refusing to work half-configured ==="
cat > "$WORK/flip-agent.conf" <<'C'
FLIP_API_BASE="http://127.0.0.1:8731"
FLIP_AGENT_TOKEN=""
FLIP_PRINTER="FakeQ"
C
( cd "$WORK" && echo | timeout 10 bash agent.command >/tmp/flip_test_notoken.log 2>&1 )
grep -q "FLIP_AGENT_TOKEN is empty" /tmp/flip_test_notoken.log && check "no token: refuses and says which setting" yes || check "no token: refuses and says which setting" no

cat > "$WORK/flip-agent.conf" <<'C'
FLIP_API_BASE="http://127.0.0.1:8731"
FLIP_AGENT_TOKEN="testtoken"
FLIP_PRINTER="NotARealPrinter"
C
( cd "$WORK" && echo | timeout 10 bash agent.command >/tmp/flip_test_badq.log 2>&1 )
grep -q "no printer called" /tmp/flip_test_badq.log && check "unknown printer: says so and lists the real ones" yes || check "unknown printer: says so and lists the real ones" no

echo
[ "$fails" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "$fails FAILED"
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
