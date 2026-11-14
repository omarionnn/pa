#!/bin/bash
# Root, on the server. Lays out /opt/reason-brain-test from /tmp/bf-upload, the secret, the unit; starts it.
# Touches nothing of reason.service, /opt/reason, its .env or its unit.
set -euo pipefail
U=/tmp/bf-upload; T=/opt/reason-brain-test
mkdir -p $T $T/state /etc/reason-brain-test
rm -rf $T/src $T/scripts $T/line-agent
cp -r $U/src $U/scripts $U/line-agent $T/; cp $U/package.json $T/
for d in /opt/reason/*; do b=$(basename "$d"); case $b in data|src|scripts|package.json|line-agent) ;; *) [ -e "$T/$b" ] || ln -s "$d" "$T/$b";; esac; done
[ -f $T/state/variant.json ] || echo '{"variant":"ii","gate":"attested"}' > $T/state/variant.json
chown -R root:root $T; chmod -R go-w $T; chown -R reason:reason $T/state; chmod 700 $T/state
if [ ! -s /etc/reason-brain-test/secret ]; then umask 077; openssl rand -hex 32 > /etc/reason-brain-test/secret; fi
chmod 600 /etc/reason-brain-test/secret; chmod 700 /etc/reason-brain-test
cp $U/reason-brain-test.service /etc/systemd/system/reason-brain-test.service
systemctl daemon-reload
systemctl enable --now reason-brain-test.service >/dev/null 2>&1 || true
systemctl restart reason-brain-test.service
sleep 4
systemctl is-active reason-brain-test.service
journalctl -u reason-brain-test -n 8 -o cat --no-pager | cut -c1-200
rm -rf $U
