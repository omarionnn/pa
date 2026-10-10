#!/usr/bin/env bash
# What actually landed in the caged database. The side-effect half of every proof.
#
# Usage:
#   peek.sh thread          what the model was handed and what it said back, in order
#   peek.sh inbound         the webhooks the adapter accepted
#   peek.sh outbox          what was queued to go out, with the state and any error
#   peek.sh pages           pages created, their ids and links
#   peek.sh confirms        the confirm gate's own rows: asked, granted, refused, quoted
#   peek.sh ledger          the action ledger — every gated action that really happened
#   peek.sh schema <table>  the columns of a table, when a query needs checking
#   peek.sh sql "SELECT …"  anything else
set -euo pipefail

RUN="${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}"
DB="${REASON_VERIFY_DB:-$RUN/reason.db}"
[ -f "$DB" ] || { echo "no caged database at $DB — run bin/caged.sh start first" >&2; exit 1; }

q() { node -e '
  const { DatabaseSync } = require("node:sqlite");
  const d = new DatabaseSync(process.argv[1], { readOnly: true });
  const rows = d.prepare(process.argv[2]).all();
  if (!rows.length) console.log("(no rows)");
  for (const r of rows) console.log(JSON.stringify(r, null, 1));
' "$DB" "$1"; }

case "${1:-}" in
  thread)
    node -e '
      const { DatabaseSync } = require("node:sqlite");
      const d = new DatabaseSync(process.argv[1], { readOnly: true });
      for (const c of d.prepare("SELECT id, messages FROM conversations").all()) {
        console.log("=== " + c.id + " ===");
        for (const m of JSON.parse(c.messages)) {
          const text = typeof m.content === "string" ? m.content
            : (m.content ?? []).map(b => b.type === "text" ? b.text
              : b.type === "tool_use" ? `«tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 300)}»`
              : b.type === "tool_result" ? `«tool_result ${JSON.stringify(b.content).slice(0, 300)}»`
              : `«${b.type}»`).join("\n");
          console.log("[" + m.role + "] " + text);
        }
      }
    ' "$DB"
    ;;
  inbound)  q "SELECT id, channel, external_id, conversation_id, received_at, text, thread_root FROM inbound_messages ORDER BY id" ;;
  outbox)   q "SELECT id, state, channel, address, attempts, last_error, substr(body,1,400) AS body, media, sent_at, failed_at FROM outbox ORDER BY id" ;;
  pages)    q "SELECT id, conversation_id, title, shared, created_at, updated_at FROM pages ORDER BY rowid" ;;
  # No `amount` column on purpose: the gate reads the figure out of `summary` (trust.js amountsIn),
  # so the summary IS the number of record.
  confirms) q "SELECT id, conversation_id, action, stakes, target, asked_at, granted_at, granted_quote, refused_at, consumed_at, task_id, substr(summary,1,300) AS summary FROM confirmations ORDER BY id" ;;
  ledger)   q "SELECT * FROM action_ledger ORDER BY rowid DESC LIMIT 20" ;;
  schema)   [ -n "${2:-}" ] || { echo "usage: peek.sh schema <table>" >&2; exit 2; }
            q "PRAGMA table_info($2)" ;;
  sql)      [ -n "${2:-}" ] || { echo "usage: peek.sh sql \"SELECT …\"" >&2; exit 2; }
            q "$2" ;;
  *) echo "usage: peek.sh thread|inbound|outbox|pages|confirms|ledger|schema <t>|sql \"…\"" >&2; exit 2 ;;
esac
