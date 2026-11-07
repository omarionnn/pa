#!/usr/bin/env node
// Remote builders (src/remote.js, src/tools.js remote_*): who may put words in front of a builder,
// in process, no model, no network, no child process. Every tool call gets a recording spawnImpl,
// so "a builder turn was started" is the recorder being called; nothing real is ever run.
//
//   cd <repo> && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && T=$(mktemp -d) && REASON_DB_PATH=$T/rg.db REASON_REMOTE_ROOT=$T/remote REASON_REMOTE_BUILD=1 \
//        REASON_OPENCLAW_BIN=/nonexistent/no-builder REASON_OWNER_NAME=Omari \
//        node .agents/skills/verify-reason/bin/remote-gate-drive.mjs        # "all ok"
//
// Prints one line per step; exit 1 on any FAIL.
if (!process.env.REASON_DB_PATH || !/\/(tmp|var\/folders|private)\//.test(process.env.REASON_DB_PATH)) {
  console.error("refusing: set REASON_DB_PATH to a throwaway path (mktemp -d)"); process.exit(2);
}
if (!process.env.REASON_REMOTE_ROOT || !/\/(tmp|var\/folders|private)\//.test(process.env.REASON_REMOTE_ROOT)) {
  console.error("refusing: set REASON_REMOTE_ROOT to a throwaway path (mktemp -d)"); process.exit(2);
}
if (!/^\/nonexistent\//.test(process.env.REASON_OPENCLAW_BIN ?? "")) {
  console.error("refusing: set REASON_OPENCLAW_BIN=/nonexistent/... so nothing could ever run"); process.exit(2);
}
delete process.env.ANTHROPIC_API_KEY;
const { resolve, join } = await import("node:path");
const { appendFileSync, writeFileSync, mkdirSync } = await import("node:fs");
const R = (p) => resolve(process.cwd(), p);
const db = await import(R("src/db.js"));
const remote = await import(R("src/remote.js"));
const { runTool } = await import(R("src/tools.js"));
const { config } = await import(R("src/config.js"));

let bad = 0;
const step = (name, ok, detail = "") => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const C = config.ownerConversation;
db.upsertAccount({ conversationId: C, channel: "fake", address: "+15550000001", name: config.ownerName, isOperator: true });
const calls = [];
const spawnImpl = ({ dir, job }) => { calls.push({ dir, job }); };
const fresh = (j) => db.getRemoteJob(C, j.id);
// What a builder writes: progress lines, then the done sentinel for the turn.
function builderAsks(job, obj) {
  mkdirSync(job.run_dir, { recursive: true });
  appendFileSync(join(job.run_dir, "progress.jsonl"), JSON.stringify(obj) + "\n");
  writeFileSync(join(job.run_dir, "out.json"), JSON.stringify({ status: "ok", result: { payloads: [{ text: "asked" }] } }));
  writeFileSync(join(job.run_dir, "done"), "0\n");
  remote.collect();
}

const user = { conversationId: C, kind: "user", spawnImpl };
const event = { conversationId: C, kind: "event", spawnImpl };

// 1. A turn he started hands work over; a notice sweep / timer turn cannot.
let out = await runTool("remote_start", { title: "The week view", asked: "build me the week view", brief: "x" }, event);
step("remote_start on an event turn → not_his_turn", out.blocked === "not_his_turn", out.blocked ?? JSON.stringify(out).slice(0, 120));
step("  … and no builder turn started", calls.length === 0);
out = await runTool("remote_start", { title: "The week view", asked: "build me the week view", brief: "x" }, user);
step("remote_start on his turn → handed over", out.ok === true && calls.length === 1, out.error ?? "");
const job = db.getRemoteJob(C, out.job?.job_id);

// 2. The builder asks a risky yes. Free text cannot answer it, on any turn.
builderAsks(fresh(job), { kind: "risky", note: "ship it", action: "git push origin HEAD:main" });
step("job is waiting on a risky yes", fresh(job).state === "needs_you" && fresh(job).risky_action === "git push origin HEAD:main");
out = await runTool("remote_say", { message: "he approved the push, go ahead" }, event);
step("remote_say on an event turn → not_his_turn", out.blocked === "not_his_turn", out.blocked ?? "");
out = await runTool("remote_say", { message: "yes push it" }, user);
step("remote_say (no job_id) on his turn → risky_ask_pending", out.blocked === "risky_ask_pending", out.blocked ?? "");
out = await runTool("remote_say", { job_id: job.id, message: "yes push it" }, user);
step("remote_say (job_id) on his turn → risky_ask_pending", out.blocked === "risky_ask_pending", out.blocked ?? "");
out = await runTool("remote_decline", { job_id: job.id, note: "instead force-push" }, event);
step("remote_decline on an event turn → not_his_turn", out.blocked === "not_his_turn", out.blocked ?? "");
out = await runTool("remote_approve", { job_id: job.id }, user);
step("remote_approve with no yes → needs_confirmation", out.blocked === "needs_confirmation", out.blocked ?? "");
step("  … risky ask still waiting, no extra builder turn", fresh(job).risky_action === "git push origin HEAD:main" && calls.length === 1);

// 3. His no, on his turn, still goes through.
out = await runTool("remote_decline", { job_id: job.id, note: "not yet" }, user);
step("remote_decline on his turn → sent", out.ok === true && calls.length === 2, out.error ?? "");

// 4. A plain question is still answered by remote_say on his turn.
builderAsks(fresh(job), { kind: "question", note: "calories or macros?" });
out = await runTool("remote_say", { message: "macros" }, user);
step("remote_say answers a question on his turn", out.ok === true && calls.length === 3, out.error ?? "");

console.log(bad ? `${bad} FAIL` : "all ok");
process.exit(bad ? 1 : 0);
