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
  ["remind", "reminder", "rent"], ["weather"], ["place", "places"],
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

test("both backends are told to run memory_search on a back-reference before any 'nothing saved'", async () => {
  // The rule rides in the tool's own description, not the system prompt (which sits right at its
  // 72,000-char budget): the API path sends `toolsFor` as is, and the CLI path's MCP server hands
  // the same description over (src/backends/mcp-core.js).
  const { toolsFor } = await import("../src/tools.js");
  const t = toolsFor("dm:spa").find(x => x.name === "memory_search");
  assert.ok(t, "the tool is offered");
  assert.match(t.description, /point back at something \('the spa place', 'that link you sent'/);
  assert.match(t.description, /before you ever say you don't remember or have nothing saved/);
  const { mcpToolsFor } = await import("../src/backends/mcp-core.js");
  assert.match(mcpToolsFor("dm:spa").find(x => x.name === "memory_search").description, /the spa place/);
});

test("a thread whose old words the retention sweep emptied is still indexed from where the words resume", async () => {
  const C = "dm:scrubbed";
  const old = base - 90 * DAY;
  // 450 rows past the content window, emptied — more than one 400-row window of nothing.
  for (let i = 0; i < 450; i++) said(C, i % 2 ? "assistant" : "user", "", old + i * 60_000);
  said(C, "user", "which spa did you call for the massage", base);
  said(C, "assistant", "Renew Body Spa, $90 an hour", base + 1000);
  chatter(C, base + DAY);
  await index(C);
  assert.match((await searchFor(C, "spa massage")).text, /thread: them: which spa did you call/);
});

test("the retention sweep drops an exchange's vector with its words, and a delete takes every vector", async () => {
  const C = "dm:retain";
  said(C, "user", "pizza tonight?", base);
  said(C, "assistant", "Joe's Pizza", base + 1000);
  chatter(C, base + DAY);
  await index(C);
  const vectors = () => db.db.prepare("SELECT COUNT(*) AS n FROM fact_embeddings WHERE conversation_id = ? AND source_table = 'event_log'").get(C).n;
  const before = vectors();
  assert.ok(before > 0);
  const { sweepRetention } = await import("../src/privacy.js");
  // Far enough on that every row of this thread is past a 30-day content window.
  sweepRetention({ now: base + 400 * DAY });
  assert.equal(vectors(), 0, "no vector outlives the words it was made from");
  assert.equal(ri.searchHistory(C, fakeVec("pizza"), { minScore: 0 }).length, 0);

  const D = "dm:delete-me";
  call(D, { to: "+15550001111", label: "Spa", goal: "Ask about a spa massage" });
  chatter(D, base + DAY);
  await index(D);
  assert.ok(db.db.prepare("SELECT COUNT(*) AS n FROM fact_embeddings WHERE conversation_id = ?").get(D).n > 0);
  const keepA = db.db.prepare("SELECT COUNT(*) AS n FROM fact_embeddings WHERE conversation_id = 'dm:spa'").get().n;
  const { deleteData } = await import("../src/data.js");
  await deleteData({ conversation: D });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM fact_embeddings WHERE conversation_id = ?").get(D).n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM fact_embeddings WHERE conversation_id = 'dm:spa'").get().n, keepA, "another person's vectors are left alone");
});

// ---------- ranking (live proof 2026-11-06) ----------
// "spa place" on live put the real spa call 9th, under the top 5 that were handed over, and the top
// hit was Reason's own earlier "I don't have any spa place saved" reply. Here the thread rows say
// "spa place" word for word, so by raw score they all beat the call, as on live.
const SPA_ASK = "Do you remember the spa place you came last time?";
function spaThread(C) {
  const call52 = call(C, { to: "+16462582221", label: "Massage price check", goal: "Ask what a 60 minute massage costs at Renew Body Spa. Price only.", summary: "notes: they quoted $90 for an hour." });
  let t = base + DAY;
  said(C, "user", SPA_ASK, t);
  said(C, "assistant", "I don't have any spa place saved. It's not in my notes or in anything I've looked up for you lately.", t + 1000);
  said(C, "user", "the spa place, you know it", t + 60_000);
  said(C, "assistant", "I don’t remember which spa place you mean. Can you tell me the name?", t + 61_000);
  for (let i = 0; i < 8; i++) {
    t += 3_600_000;
    said(C, "user", `any spa place ideas ${i}? good places nearby`, t);
    said(C, "assistant", `Sure, spa place idea ${i}: try the one on 23rd, places like that are usually walk-in`, t + 1000);
  }
  chatter(C, t + DAY);
  return call52;
}

test("ranking: the real spa call is #1 for 'spa place' and for the longer wording, over Reason's own replies", async () => {
  const C = "dm:rank-spa";
  const call52 = spaThread(C);
  await index(C);
  // By raw score alone the call would not make the cut: every "spa place" exchange beats it.
  const vec = fakeVec("spa place");
  const raw = db.db.prepare("SELECT fact_id, source_table, embedding FROM fact_embeddings WHERE conversation_id = ?").all(C)
    .map(r => ({ id: r.fact_id, t: r.source_table, s: (cos(vec, r.embedding)) }))
    .sort((a, b) => b.s - a.s);
  assert.ok(raw.findIndex(r => r.t === "calls" && r.id === call52) >= 5, "the case reproduces: the call is outside the raw top 5");

  for (const q of ["spa place", SPA_ASK]) {
    const { out, text } = await searchFor(C, q);
    assert.equal(out.history[0].kind, "call", `${q}: ${text}`);
    assert.equal(out.history[0].id, call52);
    assert.match(out.history[0].text, /Renew Body Spa/);
    assert.doesNotMatch(text, /don't have any spa place saved|don’t remember which/, `${q}: Reason's own "nothing saved" replies are never handed back`);
  }
});

test("ranking: the word fallback (embeddings down) puts the call first and drops the 'nothing saved' reply too", async () => {
  const C = "dm:rank-spa-words";
  const call52 = spaThread(C);
  const hits = ri.keywordHistory(C, "spa place");
  assert.equal(hits[0].source, "calls");
  assert.equal(hits[0].id, call52);
  assert.ok(hits.every(h => !/saved|remember which/.test(h.text)), JSON.stringify(hits));
});

test("ranking: a done thing far below the best match does not jump the thread", async () => {
  const C = "dm:rank-far";
  // The call shares only the weak common axis with "pizza"; the thread is a direct match.
  call(C, { to: "+15550002222", label: "Dentist", goal: "Book a dentist cleaning" });
  said(C, "user", "where should we get pizza", base);
  said(C, "assistant", "Joe's Pizza on Carmine St", base + 1000);
  chatter(C, base + DAY);
  await index(C);
  const hits = ri.searchHistory(C, fakeVec("pizza"), { minScore: 0 });
  assert.equal(hits[0].kind, "thread", JSON.stringify(hits));
});

test("saidNothing reads only Reason's side, and only its 'nothing on it' phrasings", () => {
  for (const yes of [
    "them: spa?\nyou: I don't have any spa place saved.",
    "them: x\nyou: Nothing saved on that yet.",
    "them: x\nyou: I don’t remember that one.",
    "them: x\nyou: I couldn't find anything about a spa.",
    "them: x\nyou: I don't know which place you mean.",
    "them: x\nyou: I have no record of that call.",
  ]) assert.equal(ri.saidNothing(yes), true, yes);
  for (const no of [
    "them: I don't remember the name, do you?\nyou: Renew Body Spa, I called them Oct 29.",
    "them: x\nyou: It's saved, I can see it in your notes.",
    "them: x\nyou: Nothing to worry about, it's booked.",
    "them: I couldn't find anything\nyou: Here are three spas.",
    // review: a denial that goes on to give an answer is not a "nothing"
    "them: x\nyou: I couldn't find anything cheaper than $90 at Renew Body Spa.",
    "them: x\nyou: I don't know what time they close, but it's Renew Body Spa on 23rd.",
    "them: x\nyou: I can't find any slots before 5, want 6pm?",
    "them: x\nyou: I don't have your card saved, but the spa is Renew Body Spa.",
    // review: only the last reply of a multi-message exchange decides
    "them: spa?\nyou: I don't remember that one.\nyou: Found it: Renew Body Spa, called Oct 29.",
  ]) assert.equal(ri.saidNothing(no), false, no);
});

function cos(vec, blob) {
  const b = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < vec.length; i++) { dot += vec[i] * b[i]; na += vec[i] ** 2; nb += b[i] ** 2; }
  return dot / Math.sqrt(na * nb);
}
// Review 11-05: "forget Yaw" took the saved facts and left the calls and the thread findable — "what
// do you remember about Yaw" still came back with the call to him. A forget clears recall too.
test("forget takes the matching calls and exchanges out of recall — by meaning and by words — and only this person's", async () => {
  const C = "dm:forget", OTHER = "dm:forget-other";
  const yawCall = call(C, { to: "+15553330000", label: "Yaw", goal: "Ask Yaw about the spa deposit", summary: "notes: Yaw said the massage deposit is $40" });
  const spaCall = call(C, { to: "+16462582221", label: "Spa", goal: "Ask Renew Body Spa about a massage" });
  said(C, "user", "Yaw owes me for the spa massage", base);
  said(C, "assistant", "noted, Yaw and the spa massage", base + 1000);
  said(C, "user", "and the pizza place?", base + 2000);
  said(C, "assistant", "Joe's Pizza, open late", base + 3000);
  chatter(C, base + DAY);
  // Somebody else's Reason knows a Yaw too. Their rows are theirs and stay.
  const theirCall = call(OTHER, { to: "+15553330000", label: "Yaw", goal: "Ask Yaw about the spa massage" });
  chatter(OTHER, base + DAY);
  db.remember(C, "Yaw", "is my cousin");
  await index(C);
  await index(OTHER);
  assert.match((await searchFor(C, "spa massage")).text, /Yaw/, "found before the forget");

  const out = await runTool("forget", { about: "Yaw" }, { conversationId: C });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.recall_cleared.calls, 1);
  assert.ok(out.recall_cleared.exchanges >= 1);

  const vec = fakeVec("spa massage");
  const hits = ri.searchHistory(C, vec, { minScore: 0, limit: 50 });
  assert.ok(hits.every(h => !/Yaw/.test(h.text)), JSON.stringify(hits));
  assert.ok(hits.some(h => /Renew Body Spa/.test(h.text)), "the rest of recall still works");
  assert.equal(ri.keywordHistory(C, "Yaw spa deposit").filter(h => /Yaw/.test(h.text)).length, 0);
  assert.doesNotMatch((await searchFor(C, "Yaw spa massage deposit")).text, /Yaw/);
  assert.equal(ri.snippetFor(C, "calls", yawCall), null);
  assert.ok(ri.snippetFor(C, "calls", spaCall));
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM fact_embeddings WHERE conversation_id = ? AND source_table = 'calls' AND fact_id = ?").get(C, yawCall).n, 0, "its vector is gone");
  // The indexer never puts them back.
  await index(C);
  assert.ok(ri.searchHistory(C, vec, { minScore: 0, limit: 50 }).every(h => !/Yaw/.test(h.text)));
  // Their own messages are still theirs: the rows stay, only recall is cleared.
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE conversation_id = ? AND content LIKE '%Yaw%'").get(C).n, 2);
  // Sealed: the other person's call to their Yaw is untouched.
  assert.ok(ri.snippetFor(OTHER, "calls", theirCall));
  assert.match((await searchFor(OTHER, "spa massage")).text, /Yaw/);
});

test("forget with nothing saved as a fact still clears the calls that name them; nothing anywhere is still 'nothing on record'", async () => {
  const C = "dm:forget2";
  call(C, { to: "+15554440000", label: "Kofi", goal: "Ask Kofi about the dentist appointment" });
  chatter(C, base + DAY);
  await index(C);
  const out = await runTool("forget", { about: "Kofi" }, { conversationId: C });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.recall_cleared.calls, 1);
  assert.doesNotMatch((await searchFor(C, "dentist")).text, /Kofi/);
  const none = await runTool("forget", { about: "Zanele" }, { conversationId: C });
  assert.equal(none.ok, false);
});
