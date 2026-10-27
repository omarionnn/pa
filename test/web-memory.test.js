// Reason Web, Memory (src/pages/webmemory.js; handoff §5, reference desk-memory / sheet-memory 7A–7C).
// One pinned test per rule:
//
//   - the list: every active fact, grouped PREFERENCES · PEOPLE · PLACES · ROUTINES · WHY by the row's
//     filed group, empty groups not drawn, somebody else's facts named as a readable line
//   - the five groups are filed by a model (src/factgroups.js), never on the API, one conversation per read
//   - empty: "Nothing saved yet." + "i'll jot things down as i learn them."
//   - correct in place (7B): the row is replaced in the store, "got it." beside it; dedupe by factKey
//   - forget (7C): the row stops being recalled — recall, the profile, search — and the chat history stays
//   - REASON THINKS…: real guesses only; yes makes a fact, no dismisses it for good
//   - another account's row id is refused; signed out, cross-site, or without the secret is refused
//   - no script: every action is a link or a form post that comes back to the page
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-memory-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";
delete process.env.REASON_BACKEND;

const { webRequestFor } = await import("../src/http.js");
const mem = await import("../src/pages/webmemory.js");
const groups = await import("../src/factgroups.js");
const db = await import("../src/db.js");
const { memoryNotes } = await import("../src/memorynote.js");
const { config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const KOFI_C = "dm:fake:+14155559876";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  config.web = true;
  groups.setFilingReader(null);
  groups.resetFiling();
  db.db.exec(`DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM page_sessions; DELETE FROM people;
    DELETE FROM person_facts; DELETE FROM guesses; DELETE FROM whys; DELETE FROM profile_blocks; DELETE FROM fact_embeddings; DELETE FROM messages;`);
  for (const [c, a, n, op] of [[OWNER_C, "+12025551234", "Omari", true], [KOFI_C, "+14155559876", "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
});

let n = 0;
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { token, cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token) };
}
const headersFor = (b, extra = {}) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}), ...extra });
async function call({ sub = "memory", method = "GET", b = null, query = {}, body = null, headers = {} } = {}) {
  return await webRequestFor({ sub, method, query, headers: headersFor(b, headers), remoteAddress: "127.0.0.1", readBody: async () => body, runtime: null, router: null, log: () => {} });
}
const form = (o) => new URLSearchParams(o).toString();
const JSONH = { accept: "application/json" };
function fact(conv, about, text, group = "", category = "") {
  return db.remember(conv, about, text, { group, category }).factId;
}
const sectionOf = (html, title) => {
  const i = html.indexOf(`>${title}</h2>`);
  if (i < 0) return null;
  const end = html.indexOf("</section>", i);
  return html.slice(i, end);
};

test("the list: grouped under the five headings in order, empty ones not drawn, others' facts named", async () => {
  fact(OWNER_C, "Omari", "Aisle seats, never middle", "preferences");
  fact(OWNER_C, "Omari", "Gym on Mondays, 6 PM", "routines");
  fact(OWNER_C, "Juno", "Is your dog", "people");
  fact(OWNER_C, "Omari", "No red-eyes: can't sleep on planes", "why");
  const b = browser(OWNER_C);
  const r = await call({ b });
  assert.equal(r.status, 200);
  const h = r.body;
  assert.match(h, /What Reason <em>remembers<\/em>/);
  assert.match(h, /See it, correct it, or ask Reason to forget it\./);
  assert.match(sectionOf(h, "PREFERENCES"), /Aisle seats, never middle/);
  assert.match(sectionOf(h, "ROUTINES"), /Gym on Mondays, 6 PM/);
  assert.match(sectionOf(h, "PEOPLE"), /Juno: is your dog/);
  assert.match(sectionOf(h, "WHY"), /No red-eyes/);
  assert.equal(sectionOf(h, "PLACES"), null, "an empty group is not drawn");
  const order = ["PREFERENCES", "PEOPLE", "ROUTINES", "WHY"].map(t => h.indexOf(`>${t}</h2>`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(h, /href="\/web\?thread"[^>]*>← BACK TO THE CHAT/);
  assert.match(h, /MANAGE CHAT HISTORY/);
  assert.doesNotMatch(h, /coming|Nothing saved yet/);
  // Four groups: none spans; an odd count makes the last one wide, as WHY is in the reference.
  assert.doesNotMatch(h, /grp wide/);
  fact(OWNER_C, "Omari", "Work is in Midtown", "places");
  assert.match((await call({ b })).body, /class="grp wide" aria-labelledby="gh-why"/);
});

test("a fact not filed yet stands under its category's heading, and the whys table is WHY", async () => {
  fact(OWNER_C, "Omari", "Lives in Harlem", "", "location");
  db.db.prepare("INSERT INTO whys (conversation_id, about, why, said, stated_at) VALUES (?, ?, ?, ?, ?)").run(OWNER_C, "Omari", "Saving for a move", "i'm saving to move", Date.now());
  const h = (await call({ b: browser(OWNER_C) })).body;
  assert.match(sectionOf(h, "PLACES"), /Lives in Harlem/);
  assert.match(sectionOf(h, "WHY"), /Saving for a move/);
});

test("empty: Nothing saved yet, in the margin voice", async () => {
  const h = (await call({ b: browser(OWNER_C) })).body;
  assert.match(h, /<p class="e1">Nothing saved yet\.<\/p><p class="hand">i(&#39;|')ll jot things down as i learn them\.<\/p>/);
  assert.doesNotMatch(h, /REASON THINKS/);
  assert.doesNotMatch(h, /class="gh"/);
});

test("filing: a model reads one conversation's unfiled facts and files each under one of the five; nothing without a reader", async () => {
  const a = fact(OWNER_C, "Omari", "Likes oat milk");
  const k = fact(KOFI_C, "Kofi", "Runs on Saturdays");
  assert.equal(db.unfiledCount(), 2);
  assert.equal(await groups.fileFacts(), 0, "the API backend files nothing (never the paid API)");
  const seen = [];
  groups.setFilingReader(async (rows, ownKey) => { seen.push({ rows: rows.map(r => r.id), ownKey, prompt: groups.filingPrompt(rows, ownKey) }); return rows.map(r => ({ id: r.id, group: r.id === a ? "preferences" : "bogus" })); });
  assert.equal(await groups.fileFacts(), 1);
  assert.deepEqual(seen[0].rows, [a], "one conversation per read");
  assert.match(seen[0].prompt, /\[Omari \(the account holder\)\] Likes oat milk/);
  assert.equal(db.getFact(OWNER_C, a).memory_group, "preferences");
  // An answer outside the five is refused.
  groups.setFilingReader(async (rows) => rows.map(r => ({ id: r.id, group: "hobbies" })));
  await groups.fileFacts();
  assert.equal(db.getFact(KOFI_C, k).memory_group, "");
  // The extractor files as it writes.
  const { validateAndInsert } = await import("../src/extract.js");
  await validateAndInsert(OWNER_C, [{ about: "Omari", fact: "Takes the A train to work", category: "routine", group: "routines", confidence: 0.9 }], []);
  const row = db.memoryFacts(OWNER_C).find(f => f.fact === "Takes the A train to work");
  assert.equal(row.memory_group, "routines");
});

test("correct in place: the row is replaced in the store, the old words leave recall, got it. beside it", async () => {
  const id = fact(OWNER_C, "Omari", "Weekend trips: under 3 hours' drive", "preferences");
  const b = browser(OWNER_C);
  // 7B, no script: CORRECT is a link to the line as an input.
  const page = (await call({ b })).body;
  assert.match(page, new RegExp(`href="/web/memory\\?correct=fact-${id}#f-fact-${id}">CORRECT`));
  const editing = (await call({ b, query: { correct: `fact-${id}` } })).body;
  assert.match(editing, /<label class="lbl" for="mem-edit">CORRECTING<\/label>/);
  assert.match(editing, /value="Weekend trips: under 3 hours&#39;drive"|value="Weekend trips: under 3 hours(&#39;|')? ?drive"/);
  assert.match(editing, /Save <span aria-hidden="true">→<\/span>/);
  assert.match(editing, /CANCEL/);
  // The form post.
  const r = await call({ b, method: "POST", sub: "memory/correct", body: form({ c: b.csrf, k: `fact-${id}`, text: "Weekend trips: under 2 hours' drive" }) });
  assert.equal(r.status, 303);
  const now = db.memoryFacts(OWNER_C).find(f => f.fact.includes("2 hours"));
  assert.ok(now, "the new wording is saved");
  assert.equal(now.memory_group, "preferences", "the group comes along");
  assert.equal(r.headers.Location, `/web/memory?fixed=fact-${now.id}#f-fact-${now.id}`);
  assert.equal(db.getFact(OWNER_C, id), null, "the old row is no longer active");
  const facts = db.recall(OWNER_C, "Omari")[0].facts.map(f => f.fact);
  assert.ok(facts.includes("Weekend trips: under 2 hours' drive") && !facts.some(f => f.includes("3 hours")));
  const back = (await call({ b, query: { fixed: `fact-${now.id}` } })).body;
  assert.match(back, /2 hours(&#39;|')? drive<\/p><span class="got" role="status">got it\.<\/span>/);
  // With script: JSON, and the new line's markup to swap in.
  const j = await call({ b, method: "POST", sub: "memory/correct", headers: { ...JSONH, "x-reason-csrf": b.csrf }, body: form({ k: `fact-${now.id}`, text: "Weekend trips: under 90 minutes' drive" }) });
  assert.equal(j.status, 200);
  const out = JSON.parse(j.body);
  assert.equal(out.ok, true);
  assert.match(out.html, /90 minutes/);
  assert.match(out.html, /got it\./);
});

test("correct: a wording already on that subject (same factKey) is refused, both kept; empty refused", async () => {
  const a = fact(OWNER_C, "Omari", "Likes oat milk", "preferences");
  fact(OWNER_C, "Omari", "Hates mornings", "preferences");
  const b = browser(OWNER_C);
  const r = await call({ b, method: "POST", sub: "memory/correct", headers: JSONH, body: form({ c: b.csrf, k: `fact-${a}`, text: "hates mornings." }) });
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(r.body).error, "same_as_another");
  assert.equal(db.memoryFacts(OWNER_C).length, 2);
  const e = await call({ b, method: "POST", sub: "memory/correct", body: form({ c: b.csrf, k: `fact-${a}`, text: "   " }) });
  assert.equal(e.status, 303);
  assert.match(e.headers.Location, /correct=fact-\d+&err=empty/);
  assert.match((await call({ b, query: { correct: `fact-${a}`, err: "empty" } })).body, /role="alert">it needs some words\./);
});

test("forget: the card says its scope; the row stops being recalled everywhere a turn reads; the chat history stays", async () => {
  const id = fact(OWNER_C, "Omari", "Allergic to shellfish", "preferences");
  const keep = fact(OWNER_C, "Omari", "Likes oat milk", "preferences");
  db.saveProfile(OWNER_C, "**Omari**\n- Allergic to shellfish\n- Likes oat milk", [id, keep]);
  db.saveConversation(OWNER_C, [{ role: "user", content: "i'm allergic to shellfish" }, { role: "assistant", content: "Noted: Allergic to shellfish." }]);
  db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, 'user', 'fake', ?, ?)").run(OWNER_C, "i'm allergic to shellfish", Date.now());
  const b = browser(OWNER_C);
  const card = (await call({ b, query: { forget: `fact-${id}` } })).body;
  assert.match(card, /role="dialog" aria-modal="true"/);
  assert.match(card, /FORGET THIS\?/);
  assert.match(card, /"Allergic to shellfish"/);
  assert.match(card, /I'll stop recalling this\. The message where you said it stays in your chat history\./);
  assert.match(card, /<button class="fg-go" type="submit">Forget it<\/button>/);
  assert.match(card, /KEEP IT/);
  const r = await call({ b, method: "POST", sub: "memory/forget", body: form({ c: b.csrf, k: `fact-${id}` }) });
  assert.equal(r.status, 303);
  assert.equal(r.headers.Location, "/web/memory?gone=1");
  assert.equal(db.getFact(OWNER_C, id), null);
  assert.ok(!db.recall(OWNER_C, "Omari")[0].facts.some(f => f.fact.includes("shellfish")), "recall no longer has it");
  const notes = await memoryNotes(OWNER_C, "what should i eat", { enabled: false });
  assert.ok(!notes.join("\n").includes("shellfish"), "the profile riding on every turn no longer carries it");
  assert.equal(db.getProfile(OWNER_C), null, "the profile that carried it is gone until rebuilt");
  assert.ok(!JSON.stringify(db.loadConversation(OWNER_C).filter(m => m.role === "assistant")).includes("Allergic to shellfish"));
  assert.equal(db.loadConversation(OWNER_C)[0].content, "i'm allergic to shellfish", "their own words stay");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND text LIKE '%shellfish%'").get(OWNER_C).n, 1, "the visible history is untouched");
  const page = (await call({ b, query: { gone: "1" } })).body;
  assert.doesNotMatch(page, /Allergic to shellfish/);
  assert.match(page, /role="status" id="mem-live">Forgotten\./);
  // The extractor reading the old message again does not bring it back.
  const again = db.remember(OWNER_C, "Omari", "Allergic to shellfish", { source: "inferred" });
  assert.equal(again.refused, "taken_back");
});

test("REASON THINKS…: real guesses in the margin; yes saves a fact in their name, no dismisses it for good", async () => {
  const b = browser(OWNER_C);
  assert.doesNotMatch((await call({ b })).body, /REASON THINKS/, "no guesses, no section");
  const g1 = db.noteGuess(OWNER_C, { about: "Omari", guess: "you like places with a fireplace" });
  const g2 = db.noteGuess(OWNER_C, { about: "Omari", guess: "often up past midnight", how: "i_noticed_a_pattern" });
  const h = (await call({ b })).body;
  assert.match(h, /<h2 class="gh pen" id="gh-guess">REASON THINKS…<\/h2>/);
  assert.match(h, /<p class="gs-t">you like places with a fireplace\.<\/p>/);
  assert.match(h, /<p class="gs-t">often up past midnight\.<\/p>/, "patterns are guesses too");
  assert.match(h, /name="answer" value="yes">Yes, that's right<\/button>/);
  assert.match(h, /name="answer" value="no">No<\/button>/);
  const yes = await call({ b, method: "POST", sub: "memory/guess", body: form({ c: b.csrf, id: String(g1.id), answer: "yes" }) });
  assert.equal(yes.status, 303);
  const saved = db.memoryFacts(OWNER_C).find(f => f.fact === "you like places with a fireplace");
  assert.ok(saved, "now a fact");
  assert.equal(saved.source, "user_stated");
  assert.match(yes.headers.Location, new RegExp(`answered=1&fixed=fact-${saved.id}`));
  const no = await call({ b, method: "POST", sub: "memory/guess", headers: JSONH, body: form({ c: b.csrf, id: String(g2.id), answer: "no" }) });
  assert.equal(JSON.parse(no.body).ok, true);
  const after = (await call({ b })).body;
  assert.doesNotMatch(after, /REASON THINKS/);
  assert.equal(db.listPatterns(OWNER_C).length, 0, "a dismissed pattern is not used either");
  assert.equal(db.noteGuess(OWNER_C, { about: "Omari", guess: "often up past midnight", how: "i_noticed_a_pattern" }).already_guessed, true);
  assert.doesNotMatch((await call({ b })).body, /REASON THINKS/, "and never suggested again");
});

test("another account's row is refused: not found, nothing changed", async () => {
  const kofis = fact(KOFI_C, "Kofi", "Runs on Saturdays", "routines");
  const kg = db.noteGuess(KOFI_C, { about: "Kofi", guess: "likes jazz" });
  const b = browser(OWNER_C);
  for (const [sub, body] of [["memory/correct", { k: `fact-${kofis}`, text: "changed" }], ["memory/forget", { k: `fact-${kofis}` }], ["memory/guess", { id: String(kg.id), answer: "no" }]]) {
    const j = await call({ b, method: "POST", sub, headers: JSONH, body: form({ c: b.csrf, ...body }) });
    assert.equal(j.status, 404, sub);
    const f = await call({ b, method: "POST", sub, body: form({ c: b.csrf, ...body }) });
    assert.equal(f.status, 404, sub);
  }
  assert.equal(db.getFact(KOFI_C, kofis).fact, "Runs on Saturdays");
  assert.equal(db.getGuess(KOFI_C, kg.id).dismissed_at, null);
  const page = (await call({ b, query: { forget: `fact-${kofis}`, correct: `fact-${kofis}` } })).body;
  assert.doesNotMatch(page, /Runs on Saturdays/);
  assert.doesNotMatch(page, /<form class="fg-a"/);
});

test("signed out, cross-site, or without the session's secret: refused", async () => {
  const id = fact(OWNER_C, "Omari", "Likes oat milk", "preferences");
  const out = await call({});
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, "/web");
  const outPost = await call({ method: "POST", sub: "memory/forget", headers: JSONH, body: form({ k: `fact-${id}` }) });
  assert.equal(outPost.status, 401);
  const b = browser(OWNER_C);
  const noSecret = await call({ b, method: "POST", sub: "memory/forget", headers: JSONH, body: form({ k: `fact-${id}` }) });
  assert.equal(noSecret.status, 403);
  const wrong = await call({ b, method: "POST", sub: "memory/forget", body: form({ c: "nope", k: `fact-${id}` }) });
  assert.equal(wrong.status, 403);
  const cross = await call({ b, method: "POST", sub: "memory/forget", headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" }, body: form({ c: b.csrf, k: `fact-${id}` }) });
  assert.equal(cross.status, 403);
  // Kofi's own session cannot spend the owner's secret.
  const k = browser(KOFI_C);
  const theirs = await call({ b: k, method: "POST", sub: "memory/forget", body: form({ c: b.csrf, k: `fact-${id}` }) });
  assert.equal(theirs.status, 403);
  assert.ok(db.getFact(OWNER_C, id), "still there");
  const get = await call({ b, method: "POST" });
  assert.equal(get.status, 405);
});

test("no script: every control is a real link or form, labelled, with the page's own secret", async () => {
  const id = fact(OWNER_C, "Omari", "Likes oat milk", "preferences");
  db.noteGuess(OWNER_C, { about: "Omari", guess: "you like jazz" });
  const b = browser(OWNER_C);
  const h = (await call({ b })).body;
  assert.match(h, new RegExp(`<a class="fx fc" href="/web/memory\\?correct=fact-${id}#f-fact-${id}">CORRECT<span class="sr"> “Likes oat milk”</span></a>`));
  assert.match(h, new RegExp(`<a class="fx ff" href="/web/memory\\?forget=fact-${id}">FORGET<span class="sr"> “Likes oat milk”</span></a>`));
  assert.match(h, new RegExp(`<form class="gs-a" method="POST" action="/web/memory/guess"><input type="hidden" name="c" value="${b.csrf}">`));
  const card = (await call({ b, query: { forget: `fact-${id}` } })).body;
  assert.match(card, new RegExp(`<form class="fg-a" method="POST" action="/web/memory/forget"><input type="hidden" name="c" value="${b.csrf}"><input type="hidden" name="k" value="fact-${id}">`));
  assert.match(card, new RegExp(`href="/web/memory#f-fact-${id}">KEEP IT`));
  const edit = (await call({ b, query: { correct: `fact-${id}` } })).body;
  assert.match(edit, new RegExp(`<form class="fr fe" id="f-fact-${id}" method="POST" action="/web/memory/correct"><input type="hidden" name="c" value="${b.csrf}">`));
  // Night and Paper both come from the kit's tokens; the page never writes a hex colour of its own.
  const css = h.slice(h.indexOf(".mh{"), h.indexOf("</style>"));
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i);
});
