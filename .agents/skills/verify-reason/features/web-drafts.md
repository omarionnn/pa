# Reason Web: replies appear as they're written (`REASON_WEB_DRAFTS`)

**What the person sees.** On Web, Reason's reply grows in place, a sentence at a time, drawn exactly
as a finished Reason line (same REASON · WEB · time label, same type). The "on it." working line
stays until the first words land. The saved reply then takes the draft's place without a second
arrive animation. iMessage is unchanged.

**Switch.** `REASON_WEB_DRAFTS`: unset / `0` / `off` → never (prod default); `on` / `1` / `all` →
everyone; otherwise a comma list of conversation ids. (Not `REASON_WEB_STREAM`: that one names the
live stream's origin.) Only a user turn from Web, cleared by the harm screen, on the claude-cli
backend, with no `shouldSend` hold. Never the said-check rewrite.

**What can never reach the tab** (`src/webdraft.js`, pinned in `test/web-stream.test.js`, 11 tests):
- anything before the said check (`src/said.js checkDraft`) passed THAT text — each piece is checked
  first; a rejected piece stops the stream and takes back what was shown; the rewrite arrives whole;
- the words of a message that calls a tool (narration on the way to the answer); taken back if a
  piece slipped out before the tool began;
- a self-note first line (held until it can be judged by `withoutSelfNote`), `NO_REPLY`, a figure
  the figures check (`guardReply`) would mark — the stream stops instead.
The finished reply's own said check is the matching piece's check, shared (one call, not two).

**Cost.** One said-check call per shown piece when the ledger has claims (prod: API, ~1 s each; a
fresh account with no claims: no call). Locally on the CLI fallback a check is 3–4 s, so pieces come
in fewer, bigger steps.

## Drive (real claude-cli turn, scratch instance on this Mac — never Hetzner, never `.env`)

```bash
S=$(mktemp -d); mkdir -p $S/data
cat > $S/env.sh <<E
export REASON_DATA_DIR=$S/data REASON_DB_PATH=$S/data/reason.db REASON_TOKEN_KEY=$(openssl rand -hex 32)
export REASON_BACKEND=claude-cli REASON_OWNER_NAME=Sam REASON_CONVERSATION=dm:owner
export REASON_OWNER_NUMBER=+15555550100 REASON_MASTER_NUMBER=+15555550100 REASON_TEST_NUMBERS=+15555550100
export REASON_TZ=America/New_York REASON_WEB=on REASON_PORT=8799 REASON_PUBLIC_URL=http://localhost:8799
export REASON_SITE_URL=http://localhost:8799 REASON_PAGES_URL=http://localhost:8799 REASON_WEB_DRAFTS=on
E
# a throwaway account + Web session (prints the token)
env -i PATH=$PATH HOME=$HOME sh -c ". $S/env.sh; node -e '
  const db = await import(\"$HOME/Desktop/pa/src/db.js\"); const C=\"dm:owner\", A=\"+15555550100\";
  db.upsertAccount({ conversationId: C, channel: \"console\", address: A, name: \"Sam\", isOperator: true });
  db.upsertThread({ conversationId: C, channel: \"console\", address: A, isOwner: true, service: \"iMessage\" });
  const t = \"throwaway-\" + Date.now(); db.startPageSession(\"wsign:\" + C, t, { conversationId: C }); console.log(t);' --input-type=module" > $S/token
# the server: USER/LOGNAME/TMPDIR so the CLI finds its login; stdin held open for the console channel
env -i PATH=$PATH HOME=$HOME USER=$USER LOGNAME=$LOGNAME TMPDIR=$TMPDIR sh -c \
  ". $S/env.sh; cd ~/Desktop/pa; tail -f /dev/null | node src/serve.js --log" > $S/server.log 2>&1 &
node bin/web-drafts-drive.mjs http://localhost:8799 "$(cat $S/token)" $S/shots "how do i get from lisbon airport to the centre? walk me through it"
```

2026-10-27 (wt/web-stream): first words 11.1 s, 12 draft states, saved reply 14.9 s, draft gone;
with ledger claims (CLI checks, 3–4 s each) first words 14.6 s vs saved 18.7 s. Evidence:
`~/Desktop/reason-web-design-previews/web-stream-1027/` (`real/*.png`, `real-turn.mp4`).
Staging (`reason-web-staging.netlify.app/conversation.html`): the stand-in live stream grows the
sample reply through the real `draftHtml`, then the saved line replaces it.
