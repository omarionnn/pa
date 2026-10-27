// Reason Web, Memory at volume (v2 handoff Gap 6; reference sheet-memory-volume 6A/6B). One pinned
// test per rule:
//
//   - FIND A FACT is a GET form (works without script); filters with real counts (ALL 48 · …), the
//     current one marked, groups with nothing left out
//   - each group: its count in the heading, its first 3 lines, then "Show N more →" (?g=<group>)
//   - a filter shows its whole group; a no-script visit to a line past the first 3 opens its group
//   - guesses: one paper card, REASON THINKS… · N GUESSES, the newest first, SEE ALL ↓ / FOLD ↑
//   - search: every group and the guesses, matches underlined in pen, lines about the same person
//     after the direct matches, `N FACTS · N GUESS(ES)`, CLEAR, the no-match line; never their own
//     self as "related"; never another account's lines; everything escaped
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-memvol-"));
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
  const i = html.search(new RegExp(`>${title} · \\d+</h2>`));
  if (i < 0) return null;
  const end = html.indexOf("</section>", i);
  return html.slice(i, end);
};


const seed = () => {
  const ids = {};
  for (const [i, x] of ["Aisle seats, never middle", "Oat milk, always", "Weekend trips: under 3 hours' drive", "Morning flights", "No cilantro"].entries()) ids[`p${i}`] = fact(OWNER_C, "Omari", x, "preferences");
  ids.juno = fact(OWNER_C, "Juno", "Juno is your dog", "people");
  ids.vet = fact(OWNER_C, "Juno", "Juno's vet is Dr. Lee, Thursdays", "people");
  ids.dogf = fact(OWNER_C, "Omari", "Dog-friendly places only when Juno comes", "preferences");
  ids.gym = fact(OWNER_C, "Omari", "Gym on Mondays, 6 PM", "routines");
  return ids;
};

test("6A: FIND A FACT, filters with real counts, ALL current, empty groups left out", async () => {
  seed();
  const h = (await call({ b: browser(OWNER_C) })).body;
  assert.match(h, /<form class="find" role="search" method="GET" action="\/web\/memory"><label class="lbl" for="mem-q">FIND A FACT<\/label>/);
  assert.match(h, /<input class="find-in" id="mem-q" name="q" type="search" value="" placeholder="dentist, aisle seats, juno…"/);
  assert.match(h, /<a class="fx clr" href="\/web\/memory" hidden>CLEAR<\/a>/);
  const nav = h.slice(h.indexOf('<nav class="flt"'), h.indexOf("</nav>", h.indexOf('<nav class="flt"')));
  assert.equal([...nav.matchAll(/class="flt-a" href="([^"]+)"(?: aria-current="true")?>([^<]+)</g)].map(m => `${m[1]} ${m[2]}`).join(" | "),
    "/web/memory ALL 9 | /web/memory?g=preferences PREFERENCES 6 | /web/memory?g=people PEOPLE 2 | /web/memory?g=routines ROUTINES 1");
  assert.match(nav, /href="\/web\/memory" aria-current="true">ALL 9</);
  assert.doesNotMatch(nav, /PLACES|WHY/, "a group with nothing is not a filter");
});

test("6A: each group shows its count and first 3 lines, then Show N more → to the whole group", async () => {
  seed();
  const h = (await call({ b: browser(OWNER_C) })).body;
  const pref = sectionOf(h, "PREFERENCES");
  assert.match(h, />PREFERENCES · 6<\/h2>/);
  assert.equal((pref.match(/class="fr"/g) ?? []).length, 6, "every line is on the page");
  assert.equal((pref.match(/class="fr" [^>]*hidden>/g) ?? []).length, 3, "three shown, the rest folded");
  assert.match(pref, /<a class="more" href="\/web\/memory\?g=preferences#gh-preferences" data-more="preferences">Show 3 more <span aria-hidden="true">→<\/span><\/a>/);
  const people = sectionOf(h, "PEOPLE");
  assert.match(h, />PEOPLE · 2<\/h2>/);
  assert.doesNotMatch(people, /hidden>|class="more"/, "3 or fewer: nothing folded, no link");
});

test("a filter shows its whole group and marks itself; an unknown filter is ALL", async () => {
  seed();
  const b = browser(OWNER_C);
  const h = (await call({ b, query: { g: "preferences" } })).body;
  assert.match(h, /href="\/web\/memory\?g=preferences" aria-current="true">PREFERENCES 6</);
  assert.equal(sectionOf(h, "PEOPLE"), null);
  assert.doesNotMatch(sectionOf(h, "PREFERENCES"), /hidden>|class="more"/);
  const odd = (await call({ b, query: { g: "<script>" } })).body;
  assert.match(odd, /href="\/web\/memory" aria-current="true">ALL 9</);
  assert.doesNotMatch(odd, /&lt;script|g=<script>/);
});

test("no script: CORRECT, FORGET or got it. on a folded line opens its group", async () => {
  const ids = seed();
  const b = browser(OWNER_C);
  const oldest = `fact-${ids.p0}`; // newest first, so the first-written line is folded
  const plain = sectionOf((await call({ b })).body, "PREFERENCES");
  assert.match(plain, new RegExp(`id="f-${oldest}"[^>]*hidden>`));
  for (const q of [{ correct: oldest }, { forget: oldest }, { fixed: oldest }]) {
    const pref = sectionOf((await call({ b, query: q })).body, "PREFERENCES");
    assert.doesNotMatch(pref, /class="fr" [^>]*hidden>|class="more"/, JSON.stringify(q));
  }
});

test("guesses: one card, REASON THINKS… · N GUESSES, the first shown, SEE ALL ↓ as a real button / FOLD ↑", async () => {
  seed();
  for (const g of ["you like places with a fireplace", "Saturdays are for your family", "often up past midnight"]) db.noteGuess(OWNER_C, { about: "Omari", guess: g });
  const b = browser(OWNER_C);
  const h = (await call({ b })).body;
  assert.match(h, /<div class="card gc"><div class="gc-h"><h2 class="gh pen gc-l" id="gh-guess" tabindex="-1">REASON THINKS… · 3 GUESSES<\/h2>/);
  assert.match(h, /<form class="gc-f" method="GET" action="\/web\/memory#gh-guess"><input type="hidden" name="guesses" value="all"><button class="fx gc-t" type="submit" aria-controls="gs-list" aria-expanded="false">SEE ALL ↓<\/button><\/form>/);
  assert.equal((h.match(/<div class="gs" id="g-\d+">/g) ?? []).length, 1, "one guess open");
  assert.equal((h.match(/<div class="gs" id="g-\d+" hidden>/g) ?? []).length, 2);
  assert.ok(h.indexOf('class="card gc"') < h.indexOf(">PREFERENCES · "), "the card comes before the groups (phone order; desktop puts it in the margin)");
  const all = (await call({ b, query: { guesses: "all" } })).body;
  assert.equal((all.match(/<div class="gs" id="g-\d+">/g) ?? []).length, 3);
  assert.match(all, /aria-expanded="true">FOLD ↑<\/button>/);
  db.db.exec("DELETE FROM guesses");
  db.noteGuess(OWNER_C, { about: "Omari", guess: "you like jazz" });
  const one = (await call({ b })).body;
  assert.match(one, /REASON THINKS… · 1 GUESS</);
  assert.doesNotMatch(one, />SEE ALL ↓</, "one guess: nothing to see all of");
});

test("6B search: across groups, matches underlined in pen, the same person's lines after, the guess in Caveat, the count, CLEAR, the no-match line", async () => {
  const ids = seed();
  db.noteGuess(OWNER_C, { about: "Juno", guess: "You'd rather not leave Juno overnight" });
  db.noteGuess(OWNER_C, { about: "Omari", guess: "you like jazz" });
  const b = browser(OWNER_C);
  const h = (await call({ b, query: { q: "  DOG " } })).body;
  assert.match(h, /<main class="mem searching"/);
  assert.match(h, /value="DOG"/);
  assert.match(h, /<a class="fx clr" href="\/web\/memory">CLEAR<\/a>/);
  assert.match(h, /<p class="cnt" role="status">3 FACTS · 1 GUESS<\/p>/);
  assert.match(h, /Juno is your <mark>dog<\/mark>/);
  assert.match(h, /<mark>Dog<\/mark>-friendly places only when Juno comes/);
  assert.match(h, /Juno(&#39;|')s vet is Dr\. Lee, Thursdays<\/p>/, "about Juno, so it comes with the matches, unmarked");
  assert.ok(h.indexOf(`f-fact-${ids.vet}`) > h.indexOf(`f-fact-${ids.juno}`) && h.indexOf(`f-fact-${ids.vet}`) > h.indexOf(`f-fact-${ids.dogf}`), "direct matches first");
  assert.match(h, /<p class="hand sg">reason thinks: you(&#39;|')d rather not leave Juno overnight\.<\/p>/);
  assert.doesNotMatch(h, /jazz|Aisle seats|Gym on Mondays/, "their own other lines are not related to everything");
  assert.match(h, /<p class="nomore">Nothing else matches\. You can tell Reason something new in the chat\.<\/p>/);
  assert.doesNotMatch(h, /<nav class="flt"|class="card gc"|class="grp/, "search is one list");
  assert.match(h, new RegExp(`<a class="fx fc" href="/web/memory\\?correct=fact-${ids.juno}#f-fact-${ids.juno}">CORRECT`), "a found line keeps CORRECT and FORGET");
  const words = (await call({ b, query: { q: "never aisle" } })).body;
  assert.match(words, /3 FACTS|1 FACT · 0 GUESSES/);
  assert.match(words, /<mark>Aisle<\/mark> seats, <mark>never<\/mark> middle/, "every word typed, each underlined");
});

test("6B: no match is 0 FACTS · 0 GUESSES and the line; a query is escaped and capped; another account's lines are never found", async () => {
  seed();
  fact(KOFI_C, "Kofi", "Kofi's zebra print couch", "preferences");
  const b = browser(OWNER_C);
  const none = (await call({ b, query: { q: "zebra" } })).body;
  assert.match(none, /<p class="cnt" role="status">0 FACTS · 0 GUESSES<\/p>/);
  assert.match(none, /Nothing else matches\. You can tell Reason something new in the chat\./);
  assert.doesNotMatch(none, /couch/);
  const evil = (await call({ b, query: { q: `"><script>alert(1)</script>` } })).body;
  assert.doesNotMatch(evil, /<script>alert/);
  assert.match(evil, /value="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  const long = (await call({ b, query: { q: "x".repeat(500) } })).body;
  assert.match(long, new RegExp(`value="x{${mem.MAX_QUERY}}"`));
});

test("markedHtml: any case, every word, escaped around and inside the marks", () => {
  assert.equal(mem.markedHtml("Dog & <dog>", "DOG"), "<mark>Dog</mark> &amp; &lt;<mark>dog</mark>&gt;");
  assert.equal(mem.markedHtml("a <b> c", "<b>"), "a <mark>&lt;b&gt;</mark> c");
  assert.equal(mem.markedHtml("plain", ""), "plain");
  assert.equal(mem.searchCount({ facts: [1], guesses: [1, 2] }), "1 FACT · 2 GUESSES");
});

test("after a forget the counts are the store's: the heading and ALL drop by one", async () => {
  const ids = seed();
  const b = browser(OWNER_C);
  const r = await call({ b, method: "POST", sub: "memory/forget", headers: JSONH, body: form({ c: b.csrf, k: `fact-${ids.p0}` }) });
  assert.equal(JSON.parse(r.body).ok, true);
  const h = (await call({ b })).body;
  assert.match(h, />PREFERENCES · 5<\/h2>/);
  assert.match(h, />ALL 8</);
});

test("the page's script: search as you type swaps only the list, keeps the address, falls back to the plain GET", async () => {
  seed();
  const h = (await call({ b: browser(OWNER_C) })).body;
  assert.match(h, /<div id="mem-body" class="mem-body">/);
  assert.match(h, /q\.addEventListener\('input'/);
  assert.match(h, /history\.replaceState\(null,'',url\)/);
  assert.match(h, /catch\(function\(\)\{if\(n===seq\)location\.href=url\}\)/);
  assert.match(h, /a\.more\[data-more\]/);
});
