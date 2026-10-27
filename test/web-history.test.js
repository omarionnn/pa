// Reason Web, chat history (v2 handoff Gap 7; reference sheet-history 7A/7B; src/pages/webhistory.js).
// One pinned test per rule:
//
//   - 7A: this month's days one by one (Today · Yesterday · Tuesday, Oct 20 · Oct 12), typed
//     `WEB + IMESSAGE · 14 MESSAGES` (the first row names the unit, as drawn), earlier months one row
//     each (`58 MESSAGES · 19 DAYS`), FIND A MESSAGE, the Caveat note, ← MEMORY; days are the person's own
//   - 7B: a day read-only: every line with who · where · when, oldest first, no composer, "Go to chat →"
//   - a month's days; a day or month with nothing of theirs is a 404
//   - search: every word, both channels, underlined in pen, each hit opening its day at that line
//   - only the session's conversation, ever; signed out goes to sign in; read-only (GET only)
//   - Memory's MANAGE CHAT HISTORY → leads here
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-history-"));
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
const hist = await import("../src/pages/webhistory.js");
const groups = await import("../src/factgroups.js");
const db = await import("../src/db.js");
const { memoryNotes } = await import("../src/memorynote.js");
const { config, clock } = await import("../src/config.js");

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
  const i = html.search(new RegExp(`>${title} · \\d+</h2>`));
  if (i < 0) return null;
  const end = html.indexOf("</section>", i);
  return html.slice(i, end);
};


// Now: Monday Oct 26 2026, 6 PM in New York.
const NOW = Date.UTC(2026, 9, 26, 22, 0);
clock.now = () => NOW;
const NY = (mo, d, h, mi = 0) => Date.UTC(2026, mo - 1, d, h + 4, mi); // EDT
const NYS = (mo, d, h, mi = 0) => Date.UTC(2026, mo - 1, d, h + 5, mi); // EST, after Nov 1 (not used) / before Mar
let seq = 0;
const say = (conv, role, channel, text, at) => db.writeMessage({ conversationId: conv, role, channel, externalId: role === "user" ? `e${++seq}` : null, outboxId: role === "user" ? null : 1000 + ++seq, text, at });

function seedHistory() {
  for (let i = 0; i < 14; i++) say(OWNER_C, i % 2 ? "assistant" : "user", i < 4 ? "web" : "fake", `today line ${i}`, NY(10, 26, 9, i));
  for (let i = 0; i < 6; i++) say(OWNER_C, i % 2 ? "assistant" : "user", "fake", `yesterday line ${i}`, NY(10, 25, 10, i));
  say(OWNER_C, "assistant", "fake", "calling now. i'll tell them it's recorded.", NY(10, 20, 9, 3));
  say(OWNER_C, "assistant", "fake", "thursday 3pm with dr. patel. here's the call.", NY(10, 20, 9, 20));
  say(OWNER_C, "user", "fake", "perfect", NY(10, 20, 9, 21));
  say(OWNER_C, "user", "fake", "late one <b>bold</b>", NY(10, 20, 23, 30)); // 03:30 UTC on the 21st: still the 20th in New York
  for (let i = 0; i < 4; i++) say(OWNER_C, "user", "fake", `train times ${i}`, NY(10, 12, 12, i));
  for (let d = 1; d <= 19; d++) for (let i = 0; i < (d === 1 ? 4 : 3); i++) say(OWNER_C, "user", "fake", `september ${d}.${i}`, NY(9, d, 12, i));
  say(KOFI_C, "user", "fake", "kofi's dentist secret", NY(10, 20, 10));
}
const historyCall = (b, query = {}, extra = {}) => call({ sub: "memory/history", b, query, ...extra });

test("7A: this month's days, earlier months grouped, typed counts, the find line, the note", async () => {
  seedHistory();
  const r = await historyCall(browser(OWNER_C));
  assert.equal(r.status, 200);
  const h = r.body;
  assert.match(h, /<a class="act2" href="\/web\/memory">← MEMORY<\/a>/);
  assert.match(h, /<h1 id="h-h" class="h1">Chat history<\/h1>/);
  assert.match(h, /Every message, from iMessage and the web, in one place\. Read-only for now\./);
  assert.match(h, /<form class="find" role="search" method="GET" action="\/web\/memory\/history"><label class="lbl" for="h-q">FIND A MESSAGE<\/label>/);
  assert.match(h, /placeholder="hudson, the dentist…"/);
  const rows = [...h.matchAll(/<a class="dy" href="([^"]+)"><span class="dy-d">([^<]+)<\/span><span class="dy-go" aria-hidden="true">→<\/span><span class="dy-m">(.*?)<\/span><\/a>/g)]
    .map(m => `${m[1]} | ${m[2]} | ${m[3].replace(/<span class="sr">[^<]*<\/span>/, "")}`);
  assert.deepEqual(rows, [
    "/web/memory/history?day=2026-10-26 | Today | WEB + IMESSAGE · 14 MESSAGES",
    "/web/memory/history?day=2026-10-25 | Yesterday | IMESSAGE · 6",
    "/web/memory/history?day=2026-10-20 | Tuesday, Oct 20 | IMESSAGE · 4",
    "/web/memory/history?day=2026-10-12 | Oct 12 | IMESSAGE · 4",
    "/web/memory/history?month=2026-09 | September | 58 MESSAGES · 19 DAYS",
  ]);
  assert.match(h, /IMESSAGE · 6<span class="sr"> messages<\/span>/, "the bare number still reads as messages");
  assert.match(h, /<p class="hand note">deleting history isn(&#39;|')t here yet\. forgetting a fact is, in memory\.<\/p>/);
  assert.doesNotMatch(h, /kofi/i);
  assert.doesNotMatch(h, /<textarea|class="composer|Paper<\/span>/, "no composer, no theme switch (Settings only)");
});

test("7B: a day, read-only: labels who · where · when, oldest first, no composer, Go to chat →", async () => {
  seedHistory();
  const h = (await historyCall(browser(OWNER_C), { day: "2026-10-20" })).body;
  assert.match(h, /<header class="hh"><a class="act2" href="\/web\/memory\/history">← HISTORY<\/a><span class="ro">READ-ONLY<\/span><\/header>/);
  assert.match(h, /<h1 id="h-h" class="h1">Tuesday, Oct 20<\/h1>/);
  const labels = [...h.matchAll(/<p class="lbl"><span>([^<]+)<\/span><time[^>]*>([^<]+)<\/time><\/p>/g)].map(m => m[1] + m[2]);
  assert.deepEqual(labels, ["REASON · IMESSAGE · 9:03 AM", "REASON · IMESSAGE · 9:20 AM", "YOU · IMESSAGE · 9:21 AM", "YOU · IMESSAGE · 11:30 PM"]);
  assert.match(h, /<li class="msg you" id="m-\d+">/);
  assert.match(h, /<li class="msg re" id="m-\d+">/);
  assert.match(h, /late one &lt;b&gt;bold&lt;\/b&gt;/, "every word escaped");
  assert.match(h, /<div class="tochat"><p>To change something, tell Reason\.<\/p><a class="act" href="\/web\?thread">Go to chat <span aria-hidden="true">→<\/span><\/a><\/div>/);
  assert.doesNotMatch(h, /<form|<textarea|<input/, "nothing to write or change here");
  assert.doesNotMatch(h, /kofi/i);
});

test("a month's days; a day in an earlier month goes back to its month; empty or malformed is a 404", async () => {
  seedHistory();
  const b = browser(OWNER_C);
  const m = (await historyCall(b, { month: "2026-09" })).body;
  assert.match(m, /<h1 id="h-h" class="h1">September<\/h1>/);
  assert.equal((m.match(/class="dy"/g) ?? []).length, 19);
  assert.match(m, /href="\/web\/memory\/history\?day=2026-09-19"><span class="dy-d">Sep 19<\/span>.*?IMESSAGE · 3 MESSAGES/);
  const d = (await historyCall(b, { day: "2026-09-01" })).body;
  assert.match(d, /href="\/web\/memory\/history\?month=2026-09">← HISTORY/);
  for (const q of [{ day: "2026-08-01" }, { month: "2025-01" }, { day: "yesterday" }, { month: "x" }]) assert.equal((await historyCall(b, q)).status, 404, JSON.stringify(q));
  // Kofi's day exists only in Kofi's conversation.
  db.db.exec(`DELETE FROM messages WHERE conversation_id = '${OWNER_C}'`);
  assert.equal((await historyCall(b, { day: "2026-10-20" })).status, 404);
  assert.match((await historyCall(b)).body, /<p class="nomore">Nothing here yet\.<\/p>/);
});

test("search: every word, both channels, underlined in pen, each hit opening its day at that line", async () => {
  seedHistory();
  say(OWNER_C, "user", "web", "book the Hudson Inn for Saturday, the dentist can wait", NY(10, 26, 15));
  const b = browser(OWNER_C);
  const h = (await historyCall(b, { q: "DENTIST hudson" })).body;
  assert.match(h, /<p class="cnt" role="status">1 MESSAGE<\/p>/);
  assert.match(h, /<a class="hit" href="\/web\/memory\/history\?day=2026-10-26#m-\d+"><span class="lbl">YOU · WEB · TODAY · 3:00 PM<\/span><span class="hit-t">book the <mark>Hudson<\/mark> Inn for Saturday, the <mark>dentist<\/mark> can wait<\/span><\/a>/);
  assert.match(h, /value="DENTIST hudson"/);
  assert.match(h, /<a class="act2 clr" href="\/web\/memory\/history">CLEAR<\/a>/);
  assert.doesNotMatch(h, /class="dy"/, "search replaces the days");
  const both = (await historyCall(b, { q: "line 2" })).body;
  assert.match(both, /3 MESSAGES/, "today line 2 and 12, yesterday line 2: every word, anywhere");
  assert.match(both, /YOU · WEB · TODAY/);
  assert.match(both, /YOU · IMESSAGE · YESTERDAY/);
  const none = (await historyCall(b, { q: "secret" })).body;
  assert.match(none, /<p class="cnt" role="status">0 MESSAGES<\/p>/);
  assert.match(none, /<p class="nomore">Nothing matches\.<\/p>/);
  assert.doesNotMatch(none, /kofi/i, "another account's words are never found");
  assert.match((await historyCall(b, { q: "%" })).body, /0 MESSAGES/, "a wildcard is just a character");
  say(OWNER_C, "user", "fake", "CAFÉ AU LAIT", NY(10, 26, 16));
  assert.match((await historyCall(b, { q: "café" })).body, /1 MESSAGE<\/p>.*<mark>CAFÉ<\/mark>/s, "any case beyond A–Z");
});

test("search: newest first, at most 50 shown with the total; a long message is cut around its match", async () => {
  for (let i = 0; i < 60; i++) say(OWNER_C, "user", "fake", `ping ${i}`, NY(10, 26, 8, i % 60));
  say(OWNER_C, "assistant", "fake", `${"a".repeat(400)} needle ${"b".repeat(400)}`, NY(10, 26, 10));
  const b = browser(OWNER_C);
  assert.match((await historyCall(b, { q: "ping" })).body, /60 MESSAGES · THE NEWEST 50/);
  const cut = (await historyCall(b, { q: "needle" })).body;
  assert.match(cut, /<span class="hit-t">…a+ <mark>needle<\/mark> b+…<\/span>/);
  assert.ok(hist.snippet(`${"a".repeat(400)} needle ${"b".repeat(400)}`, "needle").length <= 222);
});

test("signed out goes to sign in; read-only (a POST is refused); Memory leads here", async () => {
  seedHistory();
  const out = await historyCall(null);
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, "/web");
  const b = browser(OWNER_C);
  assert.equal((await historyCall(b, {}, { method: "POST", body: "" })).status, 405);
  assert.match((await call({ b })).body, /<a class="mem-manage" href="\/web\/memory\/history">MANAGE CHAT HISTORY →<\/a>/);
});

test("names of days: Today, Yesterday, this week by weekday, then the date; another year carries it", () => {
  assert.equal(hist.dayName("2026-10-26", NOW), "Today");
  assert.equal(hist.dayName("2026-10-25", NOW), "Yesterday");
  assert.equal(hist.dayName("2026-10-20", NOW), "Tuesday, Oct 20");
  assert.equal(hist.dayName("2026-10-19", NOW), "Oct 19");
  assert.equal(hist.dayName("2025-12-31", NOW), "Dec 31, 2025");
  assert.equal(hist.monthName("2026-09", NOW), "September");
  assert.equal(hist.monthName("2025-09", NOW), "September 2025");
  // The night clocks spring forward (Mar 8 2026, New York): 00:30 on the 9th is still a day after the 8th.
  assert.equal(hist.dayName("2026-03-08", Date.UTC(2026, 2, 9, 4, 30)), "Yesterday");
  assert.equal(hist.dayName("2026-03-07", Date.UTC(2026, 2, 9, 4, 30)), "Saturday, Mar 7");
  void NYS;
});
