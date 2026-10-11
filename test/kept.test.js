// What Reason has kept for somebody rides on every turn they start, on both backends, and the
// thread keeps a short line for a sweep instead of the whole bundle.
//
// The incident (2026-10-06, 7:09 PM): "Workout", eight minutes after Reason's own 7pm nudge, got
// "go get it 💪" — with a back guide and a shoulders guide Reason had written the night before on
// two pages it could no longer see. Two things were true: the pages were outside the trimmed
// history and nothing else put them in front of the model, and the 4.6 KB watchful-sweep frame
// sat in the thread between the nudge and the answer to it.
//
// No model anywhere in here. What is tested is what the model is handed and what the thread keeps.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-kept-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { runTool } = await import("../src/tools.js");
const { keptNote } = await import("../src/kept.js");
const { userMessageFor } = await import("../src/agent.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");
const { Runtime } = await import("../src/runtime.js");
const notice = await import("../src/notice.js");

const C = "dm:owner";
const HOUR = 3600_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM pages; DELETE FROM timers; DELETE FROM conversations; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
});

const GUIDE = [
  { type: "section", title: "The plan" },
  { type: "text", text: "Rows and pull-ups, three days a week." },
];

async function makePage(title) {
  const out = await runTool("page_create", { title, blocks: GUIDE }, { conversationId: C });
  assert.equal(out.ok, true, out.error);
  return out;
}

/** A CLI turn with the CLI, the pictures and the MCP server all stubbed: what is left is the prompt and the record. */
async function cliTurn({ text, kind = "user", keep = null }) {
  let prompt;
  const reply = await runTurnViaCli({
    conversationId: C, text, kind, keep,
    startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
    images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }),
    run: async (args) => { prompt = args.prompt; return { ok: true, envelope: { result: "go get it" } }; },
  });
  return { prompt, reply, thread: db.loadConversation(C) };
}

// ---------- the note ----------

test("nothing kept, no note: an ordinary chat carries no weight", () => {
  assert.equal(keptNote(C), "");
});

test("the pages Reason made are in the note, newest first, with the link that opens on a tap", async () => {
  const back = await makePage("Your back building guide");
  clock.skip(HOUR);
  const shoulders = await makePage("Bigger shoulders guide");

  const note = keptNote(C);
  assert.match(note, /pages you have made/);
  assert.ok(note.indexOf("Bigger shoulders guide") < note.indexOf("Your back building guide"), "newest first");
  assert.ok(note.includes(back.link), "the owner's link is there, so it can be texted without another tool call");
  assert.ok(note.includes(shoulders.link));
  assert.ok(note.includes(`"page_id":"${back.page_id}"`));
  assert.match(note, /part of the moment, not a list to read out/);
  assert.match(note, /never ask whether they would like to see what you have kept/);
  // The content stays on the page: titles and links only.
  assert.doesNotMatch(note, /Rows and pull-ups/);
});

test("reminders not yet sent are in the note; fired and cancelled ones are not", () => {
  const soon = db.createTimer(C, { fireAt: clock.now() + 2 * HOUR, note: "nudge omari to do today's workout" });
  const later = db.createTimer(C, { fireAt: clock.now() + 30 * HOUR, note: "be at 455 broadway 5 min early" });
  const gone = db.createTimer(C, { fireAt: clock.now() + HOUR, note: "already fired" });
  db.markTimerFired(gone.id);
  const dropped = db.createTimer(C, { fireAt: clock.now() + HOUR, note: "called off" });
  db.cancelTimer(C, dropped.id);

  const note = keptNote(C);
  assert.match(note, /reminders you have set and not yet sent/);
  assert.ok(note.indexOf("today's workout") < note.indexOf("455 broadway"), "soonest first");
  assert.ok(note.includes(`"timer_id":${soon.id}`));
  assert.ok(note.includes(`"timer_id":${later.id}`));
  assert.doesNotMatch(note, /already fired/);
  assert.doesNotMatch(note, /called off/);
});

test("the ceilings hold: forty pages do not go into every message", async () => {
  for (let i = 0; i < 12; i++) { await makePage(`Guide ${i}`); clock.skip(1000); }
  const note = keptNote(C, { pages: 3 });
  assert.equal((note.match(/"page_id"/g) || []).length, 3);
  assert.match(note, /Guide 11/);
  assert.doesNotMatch(note, /Guide 0"/);
});

// ---------- it reaches the model and not the thread, on both backends ----------

test("API path: the note goes to the model and not into the thread's history", () => {
  const { forModel, forHistory } = userMessageFor({
    prefix: "[Tue, Oct 6, 2026, 7:09 PM] Omari:", text: "Workout",
    turnNote: ["", 'pages you have made and kept for them: [{"title":"Your back building guide"}]'],
  });
  assert.match(forModel.content, /back building guide/);
  assert.doesNotMatch(forHistory.content, /back building guide/,
    "a copy left in the thread would go on listing pages that have since been deleted");
  assert.match(forHistory.content, /Workout/);
});

test("both backends read the note, including the one the live Reason runs on", () => {
  for (const file of ["../src/agent.js", "../src/backends/claude-cli.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /keptNote\(/, `${file} must put what is kept in front of the model`);
    assert.match(src, /openWorkNote\(/, `${file} must put the open sheets in front of the model`);
  }
});

test("CLI path: the page and its link are in the prompt on a turn they start, and nowhere in the thread", async () => {
  const back = await makePage("Your back building guide");
  const { prompt, thread } = await cliTurn({ text: "Workout" });
  assert.match(prompt, /Your back building guide/);
  assert.ok(prompt.includes(back.link));
  assert.match(prompt, /The new message:\n\[.*\] Omari: Workout/);
  const kept = thread.map(m => m.content).join("\n");
  assert.doesNotMatch(kept, /back building guide/, "the note is true of this turn only");
  assert.match(kept, /Omari: Workout/);
  assert.match(kept, /go get it/);
});

test("CLI path: an event turn is not their moment, so it carries no note", async () => {
  await makePage("Your back building guide");
  const { prompt } = await cliTurn({ text: "timer #59 fired. your note: \"nudge\"", kind: "event" });
  assert.doesNotMatch(prompt, /back building guide/);
});

// ---------- the thread keeps a short line for a sweep ----------

test("API path: `keep` is what the thread keeps; the model still gets the whole frame", () => {
  const { forModel, forHistory } = userMessageFor({
    prefix: "[event Tue, Oct 6, 2026, 7:05 PM]",
    text: "[watchful sweep] here are four kilobytes of unread mail…",
    keep: "[watchful sweep] you looked; 3 things were in front of you.",
  });
  assert.match(forModel.content, /four kilobytes/);
  assert.doesNotMatch(forHistory.content, /four kilobytes/);
  assert.match(forHistory.content, /\[event .*\] \[watchful sweep\] you looked; 3 things/);
});

test("CLI path: `keep` is what the thread keeps; the model still gets the whole frame", async () => {
  const { prompt, thread } = await cliTurn({
    kind: "event",
    text: "[watchful sweep] here are four kilobytes of unread mail…",
    keep: "[watchful sweep] you looked; 3 things were in front of you.",
  });
  assert.match(prompt, /four kilobytes/);
  const kept = thread.map(m => m.content).join("\n");
  assert.doesNotMatch(kept, /four kilobytes/);
  assert.match(kept, /\[event .*\] \[watchful sweep\] you looked; 3 things/);
});

test("the runtime hands `keep` through to the turn, and only when a caller set one", async () => {
  const seen = [];
  const rt = new Runtime({ runTurn: async (args) => { seen.push(args); return null; } });
  try {
    await rt._turn({ conversationId: C, text: "long", kind: "event", keep: "short" });
    await rt._turn({ conversationId: C, text: "plain", kind: "user" });
  } finally { rt.stop(); }
  assert.equal(seen[0].keep, "short");
  assert.equal("keep" in seen[1], false, "an ordinary turn keeps what was said");
});

test("the sweep and the digest each keep one line that says the look happened and how much was in front of it", () => {
  const candidates = [
    { kind: "mail_person", key: "a" }, { kind: "mail_person", key: "b" }, { kind: "cal_moved", key: "c" },
  ];
  const sweep = notice.sweepKept({ conversationId: C, candidates });
  assert.match(sweep, /^\[watchful sweep\] you looked at Omari's mail and calendar/);
  assert.match(sweep, /3 things/);
  assert.ok(sweep.length < 300, "it is a line, not a bundle");
  assert.match(notice.sweepKept({ conversationId: C, candidates: candidates.slice(0, 1) }), /1 thing they had not been told about was/);
  assert.match(notice.digestKept({ conversationId: C, candidates }), /^\[their digest\] .*3 held things/);

  // And the two passes actually use them.
  const src = readFileSync(new URL("../src/runtime.js", import.meta.url), "utf8");
  assert.match(src, /text: notice\.sweepFrame\([^\n]*\n\s*keep: notice\.sweepKept\(/, "the sweep keeps its short line");
  assert.match(src, /text: notice\.digestFrame\([^\n]*\n\s*keep: notice\.digestKept\(/, "the digest keeps its short line");
});
