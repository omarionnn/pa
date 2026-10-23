#!/usr/bin/env bash
# One spoken turn of a phone call with Reason, against the caged instance. No phone, no ElevenLabs.
#
# ElevenLabs reaches Reason through the custom-LLM endpoint (POST /calls/elevenlabs/llm, OpenAI chat
# completions over SSE) and sends each turn as the call's spoken words only. This posts exactly that:
# the history so far plus the new line, with the cage's own bearer, and prints what Reason would say,
# how long the first spoken content took, and any tool calls handed back to the platform.
#
# The real call brain runs — the call model on the API (REASON_CALL_BACKEND), the harm screen, Reason's
# tools — against the caged database. A tool that would reach a person still cannot: texting and calling
# credentials are blanked by caged.sh.
#
# Usage:
#   call-turn.sh new                 open a fresh owner call (an in_progress row) and clear the history
#   call-turn.sh "what they say"     one turn; the reply is appended to the history for the next turn
#   call-turn.sh show                the call row's state and its lookups record (PR #60)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
RUN="${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}"
[ -f "$RUN/port" ] || { echo "no caged instance — bin/caged.sh start first" >&2; exit 1; }
PORT="$(cat "$RUN/port")"
[ "$PORT" = "8787" ] && { echo "refusing to drive 8787" >&2; exit 1; }

cd "$REPO"
eval "$("$HERE/caged.sh" env | sed 's/^/export /')"

case "${1:-}" in
new)
  node --env-file-if-exists=.env --input-type=module -e '
    const db = await import("./src/db.js");
    const { config } = await import("./src/config.js");
    const c = config.ownerConversation;
    const row = db.createCall(c, {
      provider: "elevenlabs", toNumber: process.env.REASON_VERIFY_OWNER, isOwner: true,
      goal: "the owner called Reason (verification)", facts: [], direction: "in",
      externalId: "conv_verify_" + Date.now(), state: "in_progress",
    });
    console.log(JSON.stringify({ call: row.id, conversation: c }));
  ' | tee "$RUN/call.json"
  echo "[]" > "$RUN/call-history.json"
  ;;

show)
  [ -f "$RUN/call.json" ] || { echo "no call yet — call-turn.sh new" >&2; exit 1; }
  node --env-file-if-exists=.env --input-type=module -e '
    const db = await import("./src/db.js");
    const { call, conversation } = JSON.parse(process.argv[1]);
    const row = db.getCall(conversation, call);
    console.log(JSON.stringify({ call: row.id, state: row.state, lookups: db.callLookups(row) }, null, 2));
  ' "$(cat "$RUN/call.json")"
  ;;

""|-h|--help)
  sed -n 2,17p "$0" | sed 's/^# \{0,1\}//'
  exit 2
  ;;

*)
  [ -f "$RUN/call.json" ] || { echo "no call yet — call-turn.sh new" >&2; exit 1; }
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const [said, port, secret, callFile, histFile] = process.argv.slice(1);
    const { call, conversation } = JSON.parse(readFileSync(callFile, "utf8"));
    const history = JSON.parse(readFileSync(histFile, "utf8"));
    history.push({ role: "user", content: said });
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/calls/elevenlabs/llm`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model: "reason", stream: true,
        messages: [{ role: "system", content: "dashboard prompt (ignored by Reason)" }, ...history],
        elevenlabs_extra_body: { reason_call_id: call, reason_conversation_id: conversation },
      }),
    });
    if (!res.ok) { console.log(`HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
    let spoken = "", first = null, buf = "";
    const tools = [];
    for await (const part of res.body) {
      buf += Buffer.from(part).toString("utf8");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
        if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
        const d = JSON.parse(line.slice(6)).choices?.[0]?.delta ?? {};
        if (d.content) { if (first === null) first = Date.now() - t0; spoken += d.content; }
        for (const t of d.tool_calls ?? []) tools.push(t.function?.name);
      }
    }
    history.push({ role: "assistant", content: spoken.trim() || "(said nothing)" });
    writeFileSync(histFile, JSON.stringify(history));
    console.log(JSON.stringify({ first_content_ms: first, total_ms: Date.now() - t0, platform_tools: tools }));
    console.log(`Reason: ${spoken.trim()}`);
  ' "$1" "$PORT" "$ELEVENLABS_LLM_SECRET" "$RUN/call.json" "$RUN/call-history.json"
  ;;
esac
