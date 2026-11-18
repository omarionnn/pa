# Reason Web: replies appear as they're written (`REASON_WEB_DRAFTS`)

**What the person sees.** On Web, Reason's reply grows in place, a sentence at a time, drawn exactly
as a finished Reason line (same REASON · WEB · time label, same type). The "on it." working line
stays until the first words land. The saved reply then takes the draft's place without a second
arrive animation. iMessage is unchanged.

**Switch.** `REASON_WEB_DRAFTS`: unset / `0` / `off` → never (prod default); `on` / `1` / `all` →
everyone; otherwise a comma list of conversation ids. (Not `REASON_WEB_STREAM`: that one names the
live stream's origin.) Only a user turn from Web, cleared by the harm screen, on the claude-cli
backend, with no `shouldSend` hold. Never the said-check rewrite. The backend test is
`this.runTurn !== realRunTurn` (src/runtime.js:259,607), so on `REASON_BACKEND=api` no draft streams
whatever the flag says. Live (2026-11-14): backend `claude-cli`, `REASON_WEB_DRAFTS` unset → off for everyone.

**What can never reach the tab** (`src/webdraft.js`, pinned in `test/web-stream.test.js`, 14 tests):
- anything before the said check (`src/said.js checkDraft`) passed THAT text — each piece is checked
  first; a rejected piece stops the stream and takes back what was shown; the rewrite arrives whole;
- the words of a message that calls a tool (narration on the way to the answer); taken back if a
  piece slipped out before the tool began;
- a self-note first line (held until it can be judged by `withoutSelfNote`), `NO_REPLY`, a figure
  the figures check (`guardReply`) would mark — the stream stops instead.
The finished reply's own said check is the matching piece's check, shared (one call, not two).

**Cost.** One said-check call per shown piece when the ledger has claims (a fresh account with no
claims: no call). Since #227 it is on the subscription only, never the API (`src/said.js` `checkDraft`
→ `askJson` with `config.saidCheckCliModel`, the turn's warm CLI from `warmCheck` when it has one;
a cold `claude -p` is ~3 s, so pieces come in fewer, bigger steps; 3–4 s each seen 2026-10-27).
A draft turn starts no `warmCheck` (src/runtime.js:611), and its pieces are checked without `fast`
(src/webdraft.js:118), so `REASON_FAST_REPLY`'s "nothing to match" skip (`said.cannotMatch`) never
applies to a streamed piece — only to a reply checked whole (src/runtime.js:650).

## Drive (real claude-cli turn, scratch instance on this Mac — never the live server, never `.env`)

This is a subscription turn (`model`: $0 metered). Run it on the TEST account token, never this Mac's own `claude`
login (that is live Reason's subscription): put `CLAUDE_CODE_OAUTH_TOKEN` in a 0600 env file (SKILL.md "Keys for a drive")
and start the server with `node --env-file=<that file>`, with `HOME`, `REASON_CLI_HOME` and `CLAUDE_CONFIG_DIR` on a scratch
dir (a tokenless `claude -p` there must answer "Not logged in").
Without it, the proof is `node --test test/web-stream.test.js` (14, scripted drafter + said check).

```bash
S=$(mktemp -d); mkdir -p $S/data
cat > $S/env.sh <<E
export REASON_DATA_DIR=$S/data REASON_DB_PATH=$S/data/reason.db REASON_TOKEN_KEY=$(openssl rand -hex 32)
export REASON_BACKEND=claude-cli REASON_OWNER_NAME=Sam REASON_CONVERSATION=dm:owner
export REASON_OWNER_NUMBER=+15555550100 REASON_MASTER_NUMBER=+15555550100 REASON_TEST_NUMBERS=+15555550100
export REASON_TZ=America/New_York REASON_WEB=on REASON_PORT=8799 REASON_PUBLIC_URL=http://localhost:8799
export REASON_SITE_URL=http://localhost:8799 REASON_PAGES_URL=http://localhost:8799 REASON_WEB_DRAFTS=on
E
# a throwaway account + Web session (prints the token). markWebNoticeSeen spends the one-time "One Reason." note (5C):
# without it the first GET is that note, there is no #c-input, and the drive times out with no turn run
env -i PATH=$PATH HOME=$HOME sh -c ". $S/env.sh; node -e '
  const db = await import(\"$HOME/Desktop/pa/src/db.js\"); const C=\"dm:owner\", A=\"+15555550100\";
  db.upsertAccount({ conversationId: C, channel: \"console\", address: A, name: \"Sam\", isOperator: true });
  db.upsertThread({ conversationId: C, channel: \"console\", address: A, isOwner: true, service: \"iMessage\" });
  db.markWebNoticeSeen(C); const t = \"throwaway-\" + Date.now(); db.startPageSession(\"wsign:\" + C, t, { conversationId: C }); console.log(t);' --input-type=module" > $S/token
# the server: USER/LOGNAME/TMPDIR so the CLI finds its login; stdin held open for the console channel
env -i PATH=$PATH HOME=$HOME USER=$USER LOGNAME=$LOGNAME TMPDIR=$TMPDIR sh -c \
  ". $S/env.sh; cd ~/Desktop/pa; tail -f /dev/null | node src/serve.js --log" > $S/server.log 2>&1 &
node bin/web-drafts-drive.mjs http://localhost:8799 "$(cat $S/token)" $S/shots "how do i get from lisbon airport to the centre? walk me through it"
```

2026-11-17 at `18b47891` (test token, scratch instance on 8853): first words 19.2 s, saved reply 19.5 s, 1 draft state,
draft gone after. 2026-10-27 (wt/web-stream): first words 11.1 s, 12 draft states, saved reply 14.9 s, draft gone;
with ledger claims (CLI checks, 3–4 s each) first words 14.6 s vs saved 18.7 s. Evidence:
`~/Desktop/reason-web-design-previews/web-stream-1027/` (`real/*.png`, `real-turn.mp4`).
Staging (`reason-web-staging.netlify.app/conversation.html`): the stand-in live stream grows the
sample reply through the real `draftHtml`, then the saved line replaces it.
