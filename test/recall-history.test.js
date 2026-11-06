// Recall reaches what Reason DID and SAID, not only the facts it saved (src/recallindex.js).
//
// The incident (2026-10-31): "Do you remember the spa place you came last time?" → "I don't have any
// spa place saved." Two days earlier Reason had itself called Renew Body Spa (call 52). The call was
// a row in `calls`, never a fact, and recall searched only facts.
//
// No network: the embeddings API is a local fake (OPENAI_API_BASE) that puts each concept on its own
// axis, so "closest in meaning" is decided by which concepts two texts share. What is tested is what
// gets indexed, what memory_search hands the model, and that one person's rows never reach another's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-recallhist-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TZ = "America/New_York";

// The fake embeddings API. `apiDown` makes it answer 503, as OpenAI does in an outage.
let apiDown = false;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", d => { body += d; });
  req.on("end", () => {
    if (apiDown) { res.writeHead(503); res.end("down"); return; }
    const { input } = JSON.parse(body);
    const data = (Array.isArray(input) ? input : [input]).map((t, index) => ({ index, embedding: [...fakeVec(t)] }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data }));
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
server.unref();
process.env.OPENAI_API_KEY = "test-key-local-fake";
process.env.OPENAI_API_BASE = `http://127.0.0.1:${server.address().port}`;

const { clock } = await import("../src/config.js");
const db = await import("../src/db.js");
const ri = await import("../src/recallindex.js");
const { runTool } = await import("../src/tools.js");

const CONCEPTS = [
  ["spa", "massage"], ["link", "page", "brunch"], ["pizza"], ["dentist"], ["flight", "flights"],
  ["remind", "reminder", "rent"], ["weather"],
];
/** A fake embedding: one axis per concept the text mentions, plus a small shared axis. */
function fakeVec(text) {
  const t = String(text).toLowerCase();
  const v = new Float32Array(CONCEPTS.length + 1);
  CONCEPTS.forEach((words, i) => { if (words.some(w => t.includes(w))) v[i] = 1; });
  v[CONCEPTS.length] = 0.3;
  return v;
}
const fakeEmbed = async (texts) => (Array.isArray(texts) ? texts : [texts]).map(fakeVec);

const DAY = 86_400_000;
let base = Date.UTC(2026, 9, 29, 20, 46);

function call(c, { to, goal, label, outcome = "they answered", summary = "", at = base }) {
  return Number(db.db.prepare(`INSERT INTO calls (conversation_id, provider, to_number, goal, state, outcome, summary, label, created_at, updated_at, ended_at)
    VALUES (?, 'gptlive', ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`).run(c, to, goal, outcome, summary, label, at, at, at + 60_000).lastInsertRowid);
}
function said(c, role, content, at) {
  return Number(db.db.prepare("INSERT INTO event_log (conversation_id, role, content, at) VALUES (?, ?, ?, ?)").run(c, role, content, at).lastInsertRowid);
}
/** Enough later chatter that `at`-era messages fall out of the window the model is already reading. */
function chatter(c, from, n = 44) {
  for (let i = 0; i < n; i++) said(c, i % 2 ? "assistant" : "user", i % 2 ? "sure thing" : `weather today ${i}`, from + i * 60_000);
}
const index = (c) => { ri.resetBackoff(); return ri.indexPending({ conversationId: c, embedFn: fakeEmbed, now: clock.now() + 365 * DAY }); };
/** What the model is handed when it searches: the history part of memory_search, as one string. */
const searchFor = async (c, q) => {
  const out = await runTool("memory_search", { query: q }, { conversationId: c });
  assert.equal(out.ok, true, JSON.stringify(out));
  return { out, text: `${(out.history ?? []).map(h => `- ${h.date} · ${h.kind}: ${h.text}`).join("\n")}\n${out.note ?? ""}` };
};

test("the spa case: a call Reason made is found when they point back at 'the spa place'", async () => {
  const C = "dm:spa";
  call(C, { to: "+16462582221", label: "Massage price check", goal: "Ask what a 60 minute massage costs at Renew Body Spa. Price only.", summary: "Reason called … The call service's notes: they quoted $90 for an hour." });
  chatter(C, base + DAY);
  assert.ok(await index(C) > 0);

  const notes = (await searchFor(C, "the spa place they asked about")).text;
  assert.match(notes, /Renew Body Spa/);
  assert.match(notes, /\+16462582221/);
  assert.match(notes, /Oct 29 · call:/, "the date rides with it");
  assert.match(notes, /\$90/, "how it went, not only what it was for");
  // A message about something else is not handed any of it.
  const other = await searchFor(C, "dentist number");
  assert.doesNotMatch(other.text, /Renew Body Spa/);
  assert.match(other.out.note, /Only now is it true that you have nothing on it/);
});

test("the link case: a page Reason made and sent is found by 'that link you sent'", async () => {
  const C = "dm:link";
  db.recordAction({ conversationId: C, action: "page_create", attempted: { title: "Cheap brunch spots" }, outcome: "ok", result: { ok: true },
    receipt: 'Made the page "Cheap brunch spots": https://files.heyreason.com/qlIjGEBXZh?k=abc' });
  db.recordAction({ conversationId: C, action: "asked_back", attempted: {}, outcome: "asked", result: {}, receipt: "asked back: which brunch link?" });
  chatter(C, clock.now() + DAY);
  await index(C);
  const notes = (await searchFor(C, "brunch link sent")).text;
  assert.match(notes, /files\.heyreason\.com\/qlIjGEBXZh/);
  assert.doesNotMatch(notes, /asked back/, "bookkeeping rows are not indexed");
});

test("two spas: both are handed over, with the instruction to ask which one, naming them", async () => {
  const C = "dm:twospa";
  call(C, { to: "+16462582221", label: "Massage price", goal: "Ask what a 60 minute massage costs at Renew Body Spa." });
  call(C, { to: "+19177935957", label: "Massage price", goal: "Ask what a full body massage costs at Chelsea Spa and Beauty.", at: base + DAY });
  chatter(C, base + 2 * DAY);
  await index(C);
  const notes = (await searchFor(C, "spa place")).text;
  assert.match(notes, /Renew Body Spa/);
  assert.match(notes, /Chelsea Spa and Beauty/);
  assert.match(notes, /If more than one of these could be what they mean, ask ONE short question naming them/);
});

test("SEALED: one person's calls, links and thread never reach another person's search", async () => {
  const A = "dm:sendblue:+15550000001", B = "dm:sendblue:+15550000002";
  const aCall = call(A, { to: "+15551112222", label: "Spa", goal: "Ask Alice's Secret Spa about a massage" });
  said(A, "user", "my spa password is hunter2, massage at 5", base);
  said(A, "assistant", "noted the spa massage", base + 1000);
  chatter(A, base + DAY);
  said(B, "user", "hello", base);
  chatter(B, base + DAY);
  await index(A);
  await index(B);

  // The same vector, B's conversation: nothing of A's.
  const vec = fakeVec("spa massage");
  const bHits = ri.searchHistory(B, vec, { minScore: 0 });
  assert.ok(bHits.every(h => !/Alice|hunter2/.test(h.text)), JSON.stringify(bHits));
  const bNotes = (await searchFor(B, "spa massage")).text;
  assert.doesNotMatch(bNotes, /Alice|hunter2|\+15551112222/);
  // A forged store row in B's name pointing at A's call still reads nothing: the source row is
  // read on B's conversation too.
  db.db.prepare("INSERT INTO fact_embeddings (conversation_id, fact_id, source_table, embedding, created_at) VALUES (?, ?, 'calls_forged', x'00', 0)").run(B, aCall);
  assert.equal(ri.snippetFor(B, "calls", aCall), null);
  assert.equal(ri.keywordHistory(B, "Alice Secret Spa massage").length, 0);
  // And the tool, run as B, finds nothing of A's either.
  const out = await runTool("memory_search", { query: "Alice's Secret Spa massage" }, { conversationId: B });
  assert.doesNotMatch(JSON.stringify(out), /Alice|hunter2/);
  // A, of course, still finds its own.
  assert.match((await searchFor(A, "spa massage")).text, /Alice's Secret Spa/);
});

test("past thread exchanges are indexed as exchanges, in their own words", async () => {
  const C = "dm:thread";
  said(C, "user", "[3 min ago you showed them cards]\nwhere should we get pizza friday", base);
  said(C, "assistant", "Joe's Pizza on Carmine St, open till 4am", base + 1000);
  chatter(C, base + DAY);
  await index(C);
  const notes = (await searchFor(C, "pizza place you told me about")).text;
  assert.match(notes, /thread: them: where should we get pizza friday \/? ?you: Joe's Pizza/);
  assert.doesNotMatch(notes, /showed them cards/, "Reason's own bracket notes are not their words");
});

test("reminders they set are found", async () => {
  const C = "dm:remind";
  db.createTimer(C, { fireAt: base + 3 * DAY, note: "pay the rent to the landlord" });
  chatter(C, base + DAY);
  await index(C);
  assert.match((await searchFor(C, "reminder about rent")).text, /reminder: reminder for .*pay the rent/);
});

test("indexing is idempotent: a second pass embeds nothing", async () => {
  const C = "dm:spa";
  assert.equal(await index(C), 0);
});

test("embeddings API down: indexing logs and backs off, the search falls back to words, never a bare 'nothing'", async () => {
  const C = "dm:down";
  call(C, { to: "+16462582221", label: "Massage price check", goal: "Ask what a 60 minute massage costs at Renew Body Spa." });
  const logs = [];
  ri.resetBackoff();
  const n = await ri.indexPending({ conversationId: C, embedFn: async () => { throw new Error("OpenAI embeddings 503"); }, log: l => logs.push(l), now: clock.now() + 365 * DAY });
  assert.equal(n, 0);
  assert.ok(logs.some(l => /503/.test(l.recall_index_failed ?? "")), JSON.stringify(logs));
  // Backed off: the next pass inside five minutes does not call the API at all.
  let called = false;
  await ri.indexPending({ conversationId: C, embedFn: async (t) => { called = true; return fakeEmbed(t); }, now: clock.now() + 365 * DAY + 1000 });
  assert.equal(called, false);

  apiDown = true;
  try {
    const out = await runTool("memory_search", { query: "the spa place" }, { conversationId: C });
    assert.equal(out.ok, true);
    assert.match(out.searched, /by words only/);
    assert.match(JSON.stringify(out.history), /Renew Body Spa/);
    const none = await runTool("memory_search", { query: "zebra crossing" }, { conversationId: C });
    assert.match(none.note, /Do not tell them nothing is saved/);
  } finally {
    apiDown = false;
  }
});

test("recall with no saved fact points at memory_search instead of saying nothing is there", async () => {
  const out = await runTool("recall", { about: "the spa place" }, { conversationId: "dm:spa" });
  assert.match(out.note, /memory_search/);
});

test("both backends' system prompt sends a back-reference to memory_search before any 'nothing saved'", async () => {
  // The CLI backend builds its system prompt from the same systemFor (src/backends/claude-cli.js).
  const { systemFor } = await import("../src/agent.js");
  const accounts = await import("../src/accounts.js");
  const prompt = systemFor(accounts.ownerOf("dm:spa"));
  assert.match(prompt, /Pointing back \("the spa place", "that link"\)\? memory_search before ever saying "nothing saved"/);
  const { toolsFor } = await import("../src/tools.js");
  assert.ok(toolsFor("dm:spa").some(t => t.name === "memory_search"), "the tool is offered");
});
