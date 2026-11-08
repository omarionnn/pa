#!/usr/bin/env node
// Drive the after-call read's machine labels against the redial guard (security run-2 R2-I), in
// process: the real settleGoal (src/calls/goalmet.js) with a stubbed read (no model), then the real
// safeToRedial (src/calls/redial.js) that call_place consults before it dials. A throwaway database.
// No model, no phone, nothing can leave this machine. Run under the cage's env:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/redial.db node .agents/skills/verify-reason/bin/redial-book-guard-drive.mjs
//
// One line per step, `ok` or `FAIL`; exits non-zero on any FAIL.
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER ||= "+12025550100";
process.env.REASON_MASTER_NUMBER ||= process.env.REASON_OWNER_NUMBER;
process.env.REASON_OWNER_NAME ||= "Omari";
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/redial.db");
    process.exit(2);
  }
  process.env.REASON_DATA_DIR ||= dirname(db) + "/data";
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "TWILIO_AUTH_TOKEN", "BLAND_API_KEY"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const db = await imp("src/db.js");
const goal = await imp("src/calls/goalmet.js");
const { safeToRedial } = await imp("src/calls/redial.js");
const { clock } = await imp("src/config.js");

const C = "dm:owner";
let failed = 0;
const step = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
db.upsertAccount({ conversationId: C, channel: "fake", address: process.env.REASON_OWNER_NUMBER, name: "Omari", isOperator: true });

const TRANSCRIPT = "Reason: Hi, a table for two Saturday at eight, under Omari?\nThem: Sure, you're booked for Saturday at eight.\nThem: Please leave a message after the tone.";
function dropped(to, brief) {
  const now = clock.now();
  const r = db.db.prepare(`INSERT INTO calls (conversation_id, provider, to_number, goal, is_owner, direction, brief, created_at, updated_at) VALUES (?, 'fake', ?, ?, 0, 'out', ?, ?, ?)`)
    .run(C, to, "Book a table for two Saturday at 8 under Omari.", JSON.stringify(brief), now, now);
  return db.updateCall(C, Number(r.lastInsertRowid), { state: "completed", transcript: TRANSCRIPT, outcome_kind: "dropped_before_confirmation", ended_at: now });
}
const reads = (how) => async () => ({ value: { met: false, how, why: "a recording" } });
const next = { goal: "Book a table for two Saturday at 8", approved: { book: true } };

let n = 0;
for (const how of ["recording", "voicemail_greeting", "voicemail_not_set_up"]) {
  const to = `+1616555020${n++}`;
  const row = dropped(to, { goal: "Book a table", approved: { book: true, maxCents: null, terms: [], upTo: "" } });
  const settled = await goal.settleGoal(C, row, { ask: reads(how) });
  const KIND = { recording: "machine_recording", voicemail_greeting: "voicemail_no_message", voicemail_not_set_up: "voicemail_full" };
  step(`book-cleared + read "${how}": label as before (${KIND[how]})`, settled.outcome_kind === KIND[how], settled.outcome_kind);
  const r = safeToRedial(C, { toNumber: to, brief: next });
  step(`book-cleared + read "${how}": redial is ask-only with booking off`, r.ok && r.mode === "ask" && r.brief?.approved?.book !== true, `${r.mode} book=${r.brief?.approved?.book}`);
}

// A call that could not have booked still names the machine and redials as a plain retry.
const ask = dropped("+16165550299", { goal: "Ask the hours", approved: { book: false, maxCents: null, terms: [], upTo: "" } });
const s2 = await goal.settleGoal(C, ask, { ask: reads("voicemail_not_set_up") });
step("asking-only + read voicemail_not_set_up: voicemail_full (unchanged)", s2.outcome_kind === "voicemail_full", s2.outcome_kind);
const r2 = safeToRedial(C, { toNumber: "+16165550299", brief: { goal: "Ask the hours", approved: { book: false } } });
step("asking-only: redial is retry (unchanged)", r2.ok && r2.mode === "retry", r2.mode);

console.log(failed ? `${failed} FAIL` : "all ok");
process.exit(failed ? 1 : 0);
