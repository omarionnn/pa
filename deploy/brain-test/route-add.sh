#!/bin/bash
# Root. Adds the brain test route to Caddy under the deploy lock: backup, validate, graceful reload, checks, restore on any miss.
set -u
LOCK=/root/.deploy-lock
if ! ( set -o noclobber; echo "brain-test $(date -u +%FT%TZ)" > $LOCK ) 2>/dev/null; then echo "LOCK_BUSY: $(cut -c1-40 $LOCK)"; exit 3; fi
release() { grep -q '^brain-test ' $LOCK 2>/dev/null && rm -f $LOCK; }
trap release EXIT
F=/etc/caddy/Caddyfile; TS=$(date -u +%Y%m%dT%H%M%SZ); B=$F.bak-brain-test-$TS
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@"; }
URLS="https://app.heyreason.com/health https://files.heyreason.com/privacy https://events.heyreason.com/"
before=$(for u in $URLS; do printf '%s ' "$(code $u)"; done); echo "before: $before"
grep -q 'handle /brain-test/\*' $F && { echo "route already there"; exit 0; }
cp -p $F $B
python3 - "$F" "$F.new" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
lines = open(src).read().split("\n")
i = lines.index("app.heyreason.com {")
block = ["\t# The brain test line (experiment; docs/calls-brain-first.md). Its own process on 8790; removed by brain-test-teardown.sh.",
         "\thandle /brain-test/* {", "\t\treverse_proxy 127.0.0.1:8790 {", "\t\t\tflush_interval -1", "\t\t}", "\t}"]
open(dst, "w").write("\n".join(lines[:i+1] + block + lines[i+1:]))
PY
chmod --reference=$F $F.new; chown --reference=$F $F.new
if ! caddy validate --config $F.new --adapter caddyfile >/tmp/bf-caddy-validate.log 2>&1; then echo "VALIDATE_FAILED"; grep -iE 'error' /tmp/bf-caddy-validate.log | sed -E 's/(header_up [^ ]+ )[^ ]+/\1<redacted>/g' | cut -c1-200 | head -3; rm -f $F.new /tmp/bf-caddy-validate.log; exit 4; fi
rm -f /tmp/bf-caddy-validate.log
mv $F.new $F
if ! systemctl reload caddy; then echo "RELOAD_FAILED: restoring"; cp -p $B $F; systemctl reload caddy; exit 5; fi
sleep 3
after=$(for u in $URLS; do printf '%s ' "$(code $u)"; done); echo "after:  $after"
bt=$(code -X POST https://app.heyreason.com/brain-test/selftest -d '{}')
echo "brain-test without bearer via proxy: $bt"
if [ "$before" != "$after" ] || [ "$(code https://app.heyreason.com/health)" != 200 ] || [ "$bt" != 401 ]; then echo "CHECK_FAILED: restoring"; cp -p $B $F; systemctl reload caddy; sleep 2; echo "restored: $(for u in $URLS; do printf '%s ' "$(code $u)"; done)"; exit 6; fi
echo "ROUTE_OK backup=$B"
