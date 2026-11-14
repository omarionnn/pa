#!/bin/bash
# Root, on the server: removes the brain test line completely (docs/calls-brain-first.md "Test line").
#   1. every test call's audio and transcript at Cartesia (DELETE /agents/calls/{id})
#   2. the test number (released) and the test agent (and its deployments)
#   3. the reason-brain-test unit, /opt/reason-brain-test (CLI login included), /etc/reason-brain-test
#   4. the Caddy route, under the deploy lock: backup, validate, graceful reload, checks, restore on any miss
# Never touches reason.service, /opt/reason or its .env. Prints no secret. Re-runnable.
set -u
AGENT=${AGENT:-agent_SNeXU5GCH55KCL4JGkjeaF}
NUMBER_ID=${NUMBER_ID:-ap_CaxcvfSXnSPapPQo8AvWQb}
KEYFILE=/opt/reason/.env

echo "== 1-2. Cartesia: calls, number, agent"
AGENT=$AGENT NUMBER_ID=$NUMBER_ID node --input-type=module -e '
import { readFileSync } from "node:fs"; import { parseEnv } from "node:util";
const key = parseEnv(readFileSync(process.argv[1] ?? "/opt/reason/.env", "utf8")).CARTESIA_API_KEY;
const H = { "X-API-Key": key, "Cartesia-Version": "2026-08-14" };
const api = (p, o = {}) => fetch("https://api.cartesia.ai" + p, { ...o, headers: H });
let after = "", n = 0, gone = 0;
for (let page = 0; page < 20; page++) {
  const r = await api(`/agents/calls?agent_id=${process.env.AGENT}&limit=100${after ? `&starting_after=${after}` : ""}`).then(x => x.json()).catch(() => ({}));
  const list = r.data ?? r.calls ?? [];
  for (const c of list) { n++; const d = await api(`/agents/calls/${c.id}`, { method: "DELETE" }); if (d.ok || d.status === 404) gone++; }
  if (!r.has_more || !list.length) break;
  after = r.next_page ?? list.at(-1).id;
}
console.log(JSON.stringify({ test_calls: n, deleted: gone }));
const num = await api(`/agents/phone-numbers/${process.env.NUMBER_ID}`, { method: "DELETE" });
console.log(JSON.stringify({ number_released: num.ok || num.status === 404, status: num.status }));
const ag = await api(`/agents/${process.env.AGENT}`, { method: "DELETE" });
console.log(JSON.stringify({ agent_deleted: ag.ok || ag.status === 404, status: ag.status }));
' "$KEYFILE"

echo "== 3. unit and files"
systemctl disable --now reason-brain-test.service 2>/dev/null || true
rm -f /etc/systemd/system/reason-brain-test.service; systemctl daemon-reload
rm -rf /opt/reason-brain-test /etc/reason-brain-test
ss -ltn | grep -q ':8790 ' && echo "port 8790 still open!" || echo "unit gone, port 8790 closed"

echo "== 4. Caddy route"
F=/etc/caddy/Caddyfile
if ! grep -q 'handle /brain-test/\*' $F; then echo "no route to remove"; else
  LOCK=/root/.deploy-lock
  until ( set -o noclobber; echo "brain-test-teardown $(date -u +%FT%TZ)" > $LOCK ) 2>/dev/null; do echo "lock busy ($(cut -c1-30 $LOCK)); waiting 2 min"; sleep 120; done
  trap 'grep -q "^brain-test-teardown " $LOCK 2>/dev/null && rm -f $LOCK' EXIT
  code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@"; }
  URLS="https://app.heyreason.com/health https://files.heyreason.com/privacy https://events.heyreason.com/"
  before=$(for u in $URLS; do printf '%s ' "$(code $u)"; done)
  B=$F.bak-brain-test-teardown-$(date -u +%Y%m%dT%H%M%SZ); cp -p $F $B
  python3 - "$F" "$F.new" <<'PY'
import sys
lines = open(sys.argv[1]).read().split("\n")
i = next(k for k, l in enumerate(lines) if l.strip() == "handle /brain-test/* {")
start = i - 1 if "brain test line" in lines[i - 1] else i
end = i + 4  # handle {, reverse_proxy {, flush_interval, }, }
assert lines[end].strip() == "}", "unexpected route shape"
open(sys.argv[2], "w").write("\n".join(lines[:start] + lines[end + 1:]))
PY
  chmod --reference=$F $F.new; chown --reference=$F $F.new
  if caddy validate --config $F.new --adapter caddyfile >/dev/null 2>&1 && mv $F.new $F && systemctl reload caddy; then
    sleep 3; after=$(for u in $URLS; do printf '%s ' "$(code $u)"; done)
    if [ "$before" != "$after" ]; then echo "CHECK_FAILED ($before -> $after): restoring"; cp -p $B $F; systemctl reload caddy; else echo "route removed; hosts $after"; fi
  else echo "VALIDATE_OR_RELOAD_FAILED: restoring"; rm -f $F.new; cp -p $B $F; systemctl reload caddy; fi
fi
echo "live service: $(systemctl is-active reason) pid $(systemctl show reason -p MainPID --value)"
