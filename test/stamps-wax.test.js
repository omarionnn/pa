// The wax-seal book (REASON_STAMPS_WAX; handoff 2026-10-27 "S3 · Old money, made real"). One pinned
// test per rule:
//
//   - the Seal (src/seal.js): every layer of components/seal-oxblood.svg, the four waxes, black's rust
//     postmark, blank = relief only on paper, ids unique per seal, a flat disc that reads without filters
//   - words: numbers spelled out, dates in full ("Monday, the twenty-sixth of October")
//   - the catalog in wax: names, ring text spelled and ending " ·", stories ending "It was no trouble.",
//     no exclamation marks, full aria labels ("Oxblood seal: held on your behalf, fifty-two minutes")
//   - the book: 8 a page, the first errand / anniversary / suite key kept outside it, at most 2 not-yet
//     spots and only on the last page; existing stamps carry over to their wax
//   - awarding: the suite key (call + research + purchase + one more inside 2h of the first step's
//     start, logged as one job with its start); the anniversary at a year, serial = place
//   - routes at REASON_STAMPS_WAX=on: the book, Save image (1200×630) and the story (1080×1920), the
//     public page (noindex, og card, CTA), Stop sharing → 410; off → the typed book exactly as before
//   - REDACTION: nothing but name, duration/count, date and the optional first name leaves the book
//   - Home: New in your book is the newest seal, 104px, no postmark, its name and one line
//   - nothing about streaks, points, levels or loss
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-stamps-wax-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";
delete process.env.REASON_WEB_DAILY;
delete process.env.REASON_STAMPS_WAX;
delete process.env.REASON_BACKEND;

const { webRequestFor, createServer } = await import("../src/http.js");
const db = await import("../src/db.js");
const stamps = await import("../src/stamps.js");
const sealKit = await import("../src/seal.js");
const ws = await import("../src/pages/webstamps.js");
const wx = await import("../src/pages/webseals.js");
const { renderDaily } = await import("../src/pages/webdaily.js");
const { config, clock } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const KOFI_C = "dm:fake:+14155559876";
const drawn = [];
const T0 = Date.parse("2026-10-26T16:00:00Z");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  process.env.REASON_WEB_DAILY = "on";
  process.env.REASON_STAMPS_WAX = "on";
  drawn.length = 0;
  rmSync(join(dir, "cards"), { recursive: true, force: true });
  ws.setStampShooter(async (html, size) => { drawn.push({ html, size }); return Buffer.from(`PNG:${drawn.length}`); });
  db.db.exec(`DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM page_sessions; DELETE FROM stamps; DELETE FROM stamp_shares; DELETE FROM stamp_jobs;
    DELETE FROM messages; DELETE FROM tasks; DELETE FROM calls; DELETE FROM research; DELETE FROM agentcard_purchases;`);
  for (const [c, a, n, op] of [[OWNER_C, "+12025551234", "Omari Nyarko", true], [KOFI_C, "+14155559876", "Kofi", false]]) {
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
async function call({ sub = "stamps", method = "GET", b = null, query = {}, body = null, headers = {} } = {}) {
  return await webRequestFor({ sub, method, query, headers: headersFor(b, headers), remoteAddress: "127.0.0.1", readBody: async () => body, runtime: null, router: null, log: () => {} });
}
function seed(conv, type, { at = T0, detail = {} } = {}) {
  const r = db.db.prepare(`INSERT INTO stamps (conversation_id, type, ref, earned_at, detail_json, rotation, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'live', ?)`)
    .run(conv, type, `t:${Math.random()}`, at, JSON.stringify(detail), stamps.rotationFor(conv, type, String(at)), at);
  return Number(r.lastInsertRowid);
}
async function share(b, id, showName = true) {
  const out = await call({ sub: `api/stamps/${id}/share`, method: "POST", b, body: JSON.stringify({ showName }), headers: { "content-type": "application/json", accept: "application/json", "x-reason-csrf": b.csrf } });
  return out.status === 200 ? JSON.parse(out.body) : null;
}
async function server(fn) {
  const s = createServer({ router: { statuses: () => [] }, runtime: null });
  await new Promise(r => s.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${s.address().port}`); } finally { await new Promise(r => s.close(r)); }
}
const setNow = (t) => { clock.reset(); clock.skip(t - Date.now()); };
const count = (s, re) => (s.match(re) ?? []).length;

// ---------------------------------------------------------------- the seal
test("seal: every layer of seal-oxblood.svg, in the oxblood palette, with the postmark", () => {
  const svg = sealKit.seal({ wax: "oxblood", ring: "HELD ON YOUR BEHALF · FIFTY-TWO MINUTES ·", date: "OCT 26 2026", label: "Oxblood seal: held on your behalf, fifty-two minutes" });
  assert.match(svg, /role="img" aria-label="Oxblood seal: held on your behalf, fifty-two minutes"/);
  assert.match(svg, /<feTurbulence[^>]*baseFrequency="0.028"[^>]*\/><feDisplacementMap[^>]*scale="14"/, "1: the displaced wax edge");
  assert.match(svg, /<circle cx="151" cy="153" r="111" fill="#3a0e0e"\/><circle cx="150" cy="148" r="108" fill="#6b1e1e"\/>/, "1: rim offset down, then the body");
  assert.equal(count(svg, /<ellipse cx="256" cy="178"|<ellipse cx="50" cy="112"|<circle cx="128" cy="262"|<circle cx="216" cy="254"/g), 8, "1: four drips, in the wax and again in the diffuse relief");
  assert.match(svg, /<circle cx="150" cy="148" r="83" fill="#561717"\/>/, "2: the pressed recess");
  assert.match(svg, /<textPath href="#ws[0-9a-z]+-ring">HELD ON YOUR BEHALF · FIFTY-TWO MINUTES ·<\/textPath>/, "2: the ring text");
  assert.match(svg, /font-style="italic" font-size="112" fill="currentColor">r<\/text><path d="M20 5C28.8/, "2: the italic r and the speech bubble");
  assert.match(svg, /mix-blend-mode:soft-light"><g filter="url\(#ws[0-9a-z]+-diffuse\)"/, "3: diffuse lighting in soft-light");
  assert.match(svg, /<feDiffuseLighting[^>]*><feDistantLight azimuth="235" elevation="38"\/>/);
  assert.match(svg, /mix-blend-mode:screen;opacity:.55"><g filter="url\(#ws[0-9a-z]+-spec\)"/, "3: specular in screen at 55%");
  assert.match(svg, /<feSpecularLighting[^>]*specularExponent="26"/);
  assert.match(svg, /r="106" fill="url\(#ws[0-9a-z]+-gloss\)"/, "4: the gloss");
  assert.match(svg, /filter="url\(#ws[0-9a-z]+-ink\)" opacity="0.8" fill="none" stroke="#2a2520"/, "5: the inked postmark");
  assert.match(svg, />HEYREASON<\/text>.*>OCT 26 2026<\/text>/);
  assert.equal(count(svg, /<path d="M40 (66|80|94)c9-7/g), 3, "5: three wavy cancel lines");
  assert.match(svg, /drop-shadow\(0 1.5px 1px rgba\(20,12,8,.45\)\) drop-shadow\(0 8px 10px rgba\(30,20,14,.28\)\)/, "the seal shadow");
});

test("seal: four waxes; black's postmark is rust; no postmark when asked; blank is a blind emboss on paper", () => {
  for (const [wax, p] of Object.entries(sealKit.WAX)) {
    const svg = sealKit.seal({ wax, ring: "X ·", date: "D" });
    for (const c of [p.base, p.rim, p.recess]) assert.ok(svg.includes(c), `${wax} ${c}`);
  }
  assert.match(sealKit.seal({ wax: "black", ring: "X ·", date: "D" }), /-ink\)" opacity="0.8" fill="none" stroke="#9c3b2e"/);
  assert.ok(!sealKit.seal({ wax: "green", ring: "X ·", postmark: false }).includes("HEYREASON"));
  const blank = sealKit.seal({ wax: "blank", ring: "NOT YET · A WHOLE TRIP, START TO FINISH ·", paper: "#f6efe0", label: "Not yet earned: a whole trip, start to finish" });
  assert.match(blank, /aria-label="Not yet earned: a whole trip, start to finish"/);
  assert.match(blank, /filter:none/);
  assert.ok(!blank.includes("HEYREASON") && !/#6b1e1e|#24483a|#1f2f4a|#2c2926/.test(blank), "no ink, no wax");
  assert.match(blank, /stop-color="#f6efe0"/, "pressed into the paper it sits on");
  assert.match(blank, /-diffuse\)"><circle cx="150" cy="150" r="104"/, "the relief only");
});

test("seal: ids are unique per seal, and a flat disc + recess + ring + monogram sit outside every filter", () => {
  const a = sealKit.seal({ wax: "navy", ring: "A ·" }), b = sealKit.seal({ wax: "navy", ring: "A ·" });
  const ids = (s) => [...s.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids(a).filter(x => ids(b).includes(x)).length, 0);
  // Drop everything drawn through a filter: what is left still draws the navy seal, its ring and its r.
  let flat = a;
  for (let i = 0; i < 10; i++) flat = flat.replace(/<g filter="[^"]+"[^>]*>(?:(?!<g filter=)[\s\S])*?<\/g>/g, "");
  assert.match(flat, /class="flat"><circle[^>]*fill="#0c1424"\/><circle[^>]*fill="#1f2f4a"\/>/);
  assert.match(flat, /r="83" fill="#18263d"/);
  assert.match(flat, /<textPath[^>]*>A ·<\/textPath>/);
  assert.match(flat, /<use href="#ws[0-9a-z]+-mono" color="#1f2f4a"\/>/);
});

test("words: numbers spelled out, ordinals, dates in full, the postmark date", () => {
  assert.deepEqual([0, 7, 14, 52, 100, 140, 1200].map(sealKit.words), ["zero", "seven", "fourteen", "fifty-two", "one hundred", "one hundred forty", "one thousand two hundred"]);
  assert.deepEqual([1, 2, 3, 12, 20, 21, 26, 30, 31].map(sealKit.ordinal), ["first", "second", "third", "twelfth", "twentieth", "twenty-first", "twenty-sixth", "thirtieth", "thirty-first"]);
  assert.equal(sealKit.fullDate(T0, "America/New_York"), "Monday, the twenty-sixth of October");
  assert.equal(sealKit.postmarkDate(T0, "America/New_York"), "OCT 26 2026");
});

// ---------------------------------------------------------------- the catalog in wax
test("catalog: wax by kind of errand, ring text spelled and ending ' ·', stories end 'It was no trouble.', no exclamation marks", () => {
  const wax = Object.fromEntries(Object.entries(stamps.SEALS).map(([k, v]) => [k, v.wax]));
  assert.deepEqual(wax, { long_hold: "oxblood", night_shift: "green", price_drop: "oxblood", human: "black", early: "green", abroad: "navy", whole_trip: "navy", three_in_one: "black", first: "green", anniversary: "green", suite_key: "black" });
  const detail = { minutes: 52, savedCents: 4000, days: 12, nights: 4, count: 3, place: "Delta", time: T0 };
  for (const type of Object.keys(stamps.SEALS)) {
    const s = stamps.summarize({ id: 1, conversation_id: OWNER_C, type, earned_at: T0, detail_json: JSON.stringify(detail), rotation: 3, message_id: 0 });
    assert.match(s.ring, /^[A-Z ,'·-]+ ·$/, `${type} ring: ${s.ring}`);
    assert.ok(!/\d/.test((s.ring + s.story + s.line + s.ariaLabel).replace(/\d{1,2}:\d{2} [ap]m/g, "")), `${type}: numbers spelled out (a clock time aside)`);
    assert.match(s.story, /It was no trouble\.$/, type);
    assert.ok(!/!/.test(s.story + s.line + s.name + s.ring), `${type}: no exclamation mark`);
    assert.match(s.ariaLabel, /^(Oxblood|Bottle green|Navy|Black) seal: /, type);
  }
  const held = stamps.summarize({ id: 1, conversation_id: OWNER_C, type: "long_hold", earned_at: T0, detail_json: JSON.stringify(detail), rotation: 3, message_id: 0 });
  assert.equal(held.name, "Held on your behalf");
  assert.equal(held.ring, "HELD ON YOUR BEHALF · FIFTY-TWO MINUTES ·");
  assert.equal(held.ariaLabel, "Oxblood seal: held on your behalf, fifty-two minutes");
  assert.equal(held.postmarkDate, "OCT 26 2026");
  assert.match(held.story, /held for fifty-two minutes with Delta on your behalf/);
  assert.equal(held.line, "Fifty-two minutes with Delta. It was no trouble.");
});

test("carry-over: stamps already earned read as their seals; the typed look is untouched when the flag is off", () => {
  seed(OWNER_C, "first", { at: T0 - 20 * 86_400_000 });
  seed(OWNER_C, "long_hold", { detail: { minutes: 41 } });
  const book = stamps.listStamps(OWNER_C);
  assert.deepEqual(book.map(s => [s.type, s.wax, s.outside]), [["first", "green", true], ["long_hold", "oxblood", false]]);
  process.env.REASON_STAMPS_WAX = "";
  const typed = stamps.listStamps(OWNER_C);
  assert.deepEqual(typed.map(s => s.name), ["First errand", "The long hold"]);
  assert.equal(typed[1].detail, "41 MIN");
});

// ---------------------------------------------------------------- the book
test("book: 8 a page newest first, one-offs kept outside, at most 2 not-yet spots and only on the last page", () => {
  const types = ["long_hold", "night_shift", "price_drop", "human", "early", "three_in_one"];
  const all = [];
  all.push({ ...stamps.summarize({ id: 1, conversation_id: OWNER_C, type: "first", earned_at: T0, detail_json: "{}", rotation: 0, message_id: 0 }) });
  for (let i = 0; i < 11; i++) all.push(stamps.summarize({ id: 10 + i, conversation_id: OWNER_C, type: types[i % types.length], earned_at: T0 + i, detail_json: '{"minutes":40}', rotation: 0, message_id: 0 }));
  const last = wx.sealBookView(all);
  assert.equal(last.pages, 2);
  assert.equal(last.count, 11, "the first errand is not a seal in the book");
  assert.deepEqual(last.outside.map(s => s.type), ["first"]);
  assert.equal(last.on.length, 3);
  assert.equal(last.on[0].id, 20, "newest first");
  assert.equal(last.blank.length, 2);
  for (const b of last.blank) assert.ok(!types.includes(b.type));
  const first = wx.sealBookView(all, { page: 1 });
  assert.equal(first.on.length, 8);
  assert.equal(first.blank.length, 0, "no not-yet spots on a full, earlier page");
});

test("the page: header, Your book., seals role=img with full labels, Share {name}, blanks engraved, aside, share panel, kept outside", async () => {
  seed(OWNER_C, "first", { at: T0 - 70 * 86_400_000 });
  seed(OWNER_C, "night_shift", { at: T0 - 5 * 86_400_000, detail: { time: T0 - 5 * 86_400_000 } });
  const held = seed(OWNER_C, "long_hold", { detail: { minutes: 52, place: "Delta" } });
  const out = await call({ b: browser(OWNER_C) });
  assert.equal(out.status, 200);
  const h = out.body;
  assert.match(h, /PAGE 1 · 2 SEALS SINCE OCTOBER/);
  assert.match(h, /<h1 class="sb-h1">Your book\.<\/h1>/);
  assert.match(h, /aria-current="page">STAMPS</);
  assert.match(h, /role="img" aria-label="Oxblood seal: held on your behalf, fifty-two minutes"/);
  assert.match(h, /role="img" aria-label="Bottle green seal: attended to overnight, while you slept"/);
  assert.match(h, new RegExp(`aria-label="Share Held on your behalf"`));
  assert.match(h, /OCT 26 · NEW/);
  assert.equal(count(h, /aria-label="Not yet earned: /g), 2);
  assert.match(h, /NOT YET · THREE ERRANDS IN ONE TEXT ·/);
  assert.match(h, /THE NEWEST<\/p><h2 id="sel-h">Held on your behalf\.<\/h2>/);
  assert.match(h, /It was no trouble\.<\/p>/);
  assert.match(h, />SHARE IT</);
  assert.match(h, /WITH THE COMPLIMENTS OF/);
  assert.match(h, /who held for fifty-two minutes on Omari&#39;s behalf/);
  assert.match(h, /MONDAY, THE TWENTY-SIXTH OF OCTOBER/);
  assert.match(h, /Show my first name/);
  assert.match(h, />Copy link</);
  assert.match(h, /data-sms[^>]*hidden>Send in iMessage</);
  assert.match(h, new RegExp(`/web/api/stamps/${held}/image.png\\?name=1"[^>]*>Save image<`));
  assert.match(h, /A shared seal says what kind of thing was done and how long it took\. Never who, where, or what it cost\./);
  assert.match(h, /KEPT OUTSIDE THE BOOK/);
  assert.match(h, /An embroidered patch on green twill: first errand, with Reason&#39;s r, dated AUG 17 2026/);
  assert.match(h, /six spots left on this page\./);
  assert.ok(!/streak|points|level|leaderboard|don&#39;t break|don't break|lose your/i.test(h.replace(/<script[\s\S]*?<\/script>/g, "")), "no streaks, points, levels or loss copy");
});

test("the page, flag off: the typed book exactly as before", async () => {
  process.env.REASON_STAMPS_WAX = "";
  seed(OWNER_C, "long_hold", { detail: { minutes: 52 } });
  const out = await call({ b: browser(OWNER_C) });
  assert.match(out.body, /Your stamp book\./);
  assert.ok(!out.body.includes("feDisplacementMap"));
});

// ---------------------------------------------------------------- awarding
function finished(kind, conv, { start, end, taskId = null }) {
  setNow(end);
  if (kind === "call") {
    const id = Number(db.db.prepare("INSERT INTO calls (conversation_id, provider, to_number, goal, created_at, updated_at, task_id) VALUES (?, 'fake', '+18005551212', 'g', ?, ?, ?)").run(conv, start, start, taskId).lastInsertRowid);
    db.db.prepare("UPDATE calls SET ended_at = ? WHERE id = ?").run(end, id);
    db.updateCall(conv, id, { state: "completed", outcome_kind: "confirmed" });
    return id;
  }
  if (kind === "research") {
    const id = Number(db.db.prepare("INSERT INTO research (conversation_id, question, task_id, created_at, updated_at) VALUES (?, 'q', ?, ?, ?)").run(conv, taskId, start, start).lastInsertRowid);
    db.finishResearch(conv, id);
    db.db.prepare("UPDATE research SET finished_at = ? WHERE id = ?").run(end, id);
    return id;
  }
  if (kind === "purchase") {
    const buy = `buy-${Math.random()}`;
    db.db.prepare("INSERT INTO agentcard_purchases (conversation_id, buy_conversation_id, status, merchant, amount_cents, created_at, updated_at) VALUES (?, ?, 'awaiting_approval', 'Target', 6000, ?, ?)").run(conv, buy, start, start);
    db.markAgentcardPurchase(buy, { status: "placed" });
    db.db.prepare("UPDATE agentcard_purchases SET updated_at = ? WHERE buy_conversation_id = ?").run(end, buy);
    return buy;
  }
  const id = Number(db.db.prepare("INSERT INTO tasks (conversation_id, title, goal, state, max_attempts, created_at, updated_at) VALUES (?, 't', 'g', 'running', 3, ?, ?)").run(conv, start, start).lastInsertRowid);
  db.finishTask(conv, id, { state: "done", outcome: "ok" });
  db.db.prepare("UPDATE tasks SET finished_at = ? WHERE id = ?").run(end, id);
  return id;
}
const M = 60_000;

test("suite key: call + research + online purchase + one more, all inside two hours of the first step, is one job with its start", () => {
  const s = T0 - 10 * 86_400_000;
  finished("call", OWNER_C, { start: s, end: s + 20 * M });
  finished("research", OWNER_C, { start: s + 5 * M, end: s + 40 * M });
  finished("purchase", OWNER_C, { start: s + 45 * M, end: s + 60 * M });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM stamps WHERE type = 'suite_key'").get().n, 0, "three is not a suite");
  finished("task", OWNER_C, { start: s + 61 * M, end: s + 110 * M });
  // Awarded live, by the fourth step's own completion event (the clock stood at each step's finish).
  const keys = db.db.prepare("SELECT * FROM stamps WHERE type = 'suite_key'").all();
  assert.equal(keys.length, 1);
  const job = db.db.prepare("SELECT * FROM stamp_jobs").get();
  assert.equal(job.started_at, s, "the job starts at the first step's start");
  assert.equal(job.kind, "suite");
  assert.deepEqual(JSON.parse(job.steps_json).map(x => x.kind).sort(), ["call", "purchase", "research", "task"]);
  assert.equal(keys[0].ref, `job:${job.id}`);
  stamps.awardLive(OWNER_C, stamps.suiteCandidates(OWNER_C, { all: true }));
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM stamps WHERE type = 'suite_key'").get().n, 1, "once per job");
});

test("suite key: not when a step lands past two hours, and a call's own task is not 'one more'", () => {
  const s = T0 - 20 * 86_400_000;
  const t = finished("task", OWNER_C, { start: s, end: s + 30 * M });
  finished("call", OWNER_C, { start: s + 1 * M, end: s + 20 * M, taskId: t });
  finished("research", OWNER_C, { start: s + 2 * M, end: s + 40 * M });
  finished("purchase", OWNER_C, { start: s + 3 * M, end: s + 60 * M });
  assert.deepEqual(stamps.suiteCandidates(OWNER_C, { all: true, dryRun: true }), [], "the task is the call's");
  const s2 = T0 - 30 * 86_400_000;
  finished("call", KOFI_C, { start: s2, end: s2 + 20 * M });
  finished("research", KOFI_C, { start: s2, end: s2 + 40 * M });
  finished("purchase", KOFI_C, { start: s2, end: s2 + 60 * M });
  finished("task", KOFI_C, { start: s2 + 10 * M, end: s2 + 121 * M });
  assert.deepEqual(stamps.suiteCandidates(KOFI_C, { all: true, dryRun: true }), []);
});

test("anniversary: a year after the account began, once, serial = the place among everyone who reached a year", () => {
  const year = 365 * 86_400_000;
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(T0 - year - 5 * 86_400_000, KOFI_C);
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(T0 - year - 1 * 86_400_000, OWNER_C);
  setNow(T0);
  stamps.checkAnniversary(KOFI_C);
  stamps.checkAnniversary(OWNER_C);
  stamps.checkAnniversary(OWNER_C);
  const rows = db.db.prepare("SELECT conversation_id, detail_json FROM stamps WHERE type = 'anniversary' ORDER BY earned_at").all();
  assert.deepEqual(rows.map(r => [r.conversation_id, JSON.parse(r.detail_json).serial]), [[KOFI_C, 1], [OWNER_C, 2]]);
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(T0 - 100 * 86_400_000, KOFI_C);
  db.db.exec("DELETE FROM stamps");
  assert.deepEqual(stamps.anniversaryCandidates(KOFI_C, { now: T0 }), [], "not before a year");
});

// ---------------------------------------------------------------- sharing
test("pictures: Save image is the 1200×630 card, the story is 1080×1920, both drawn from the public side only", async () => {
  const id = seed(OWNER_C, "long_hold", { detail: { minutes: 52, place: "Delta Air Lines" } });
  const b = browser(OWNER_C);
  const card = await call({ sub: `api/stamps/${id}/image.png`, b });
  assert.equal(card.status, 200);
  assert.equal(card.headers["Content-Type"], "image/png");
  assert.deepEqual(drawn.at(-1).size, { width: 1200, height: 630 });
  assert.match(drawn.at(-1).html, /background:#1f3a2e/);
  assert.match(drawn.at(-1).html, /who held for fifty-two minutes on Omari&#39;s behalf/);
  const story = await call({ sub: `api/stamps/${id}/story.png`, b, query: { name: "0" } });
  assert.equal(story.status, 200);
  assert.deepEqual(drawn.at(-1).size, { width: 1080, height: 1920 });
  assert.match(drawn.at(-1).html, /My concierge held for fifty-two minutes so I didn&#39;t have to\./);
  assert.match(drawn.at(-1).html, /who held for fifty-two minutes on my behalf/);
  assert.match(drawn.at(-1).html, /HEYREASON\.COM/);
  for (const d of drawn) assert.ok(!d.html.includes("Delta"));
});

test("public page: no sign-in, noindex, the large seal, its line, the date, og card, CTA with ref; Stop sharing → 410", async () => {
  const id = seed(OWNER_C, "long_hold", { detail: { minutes: 52 } });
  const b = browser(OWNER_C);
  const { url } = await share(b, id);
  const sid = url.split("/").pop();
  assert.match(sid, /^[0-9A-Za-z]{12}$/);
  assert.ok(!sid.includes(String(id)) || sid.length === 12);
  await server(async (base) => {
    const r = await fetch(`${base}/s/${sid}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    const h = await r.text();
    assert.match(h, /<meta name="robots" content="noindex/);
    assert.match(h, /role="img" aria-label="Oxblood seal: held on your behalf, fifty-two minutes"/);
    assert.match(h, /Reason held for fifty-two minutes on Omari&#39;s behalf\./);
    assert.match(h, /MONDAY, THE TWENTY-SIXTH OF OCTOBER/);
    assert.match(h, /property="og:image" content="https:\/\/heyreason\.test\/s\/[0-9A-Za-z]{12}\/og\.png\?v=w1"/);
    assert.match(h, /name="twitter:card" content="summary_large_image"/);
    assert.match(h, new RegExp(`Get your own Reason`));
    assert.match(h, new RegExp(`href="https://heyreason\\.test/\\?ref=s_${sid}"`));
    const og = await fetch(`${base}/s/${sid}/og.png`);
    assert.equal(og.status, 200);
    assert.deepEqual(drawn.at(-1).size, { width: 1200, height: 630 });
  });
  await call({ sub: `api/stamps/${id}/share/revoke`, method: "POST", b, body: JSON.stringify({}), headers: { "content-type": "application/json", accept: "application/json", "x-reason-csrf": b.csrf } });
  await server(async (base) => { assert.equal((await fetch(`${base}/s/${sid}`)).status, 410); });
});

test("REDACTION: name, duration or count, date and the optional first name only — never a place, price, merchant or person", async () => {
  const SECRETS = ["Comcast", "Xfinity", "Walgreens", "Lisbon", "Portugal", "$40", "forty dollars", "FORTY DOLLARS", "Kofi", "Mensah", "Nyarko", "replacement lamp"];
  const detail = { place: "Comcast Xfinity (Dr. Kofi Mensah)", merchant: "Walgreens", savedCents: 4000, city: "Lisbon, Portugal", what: "replacement lamp", minutes: 52, days: 9, nights: 4, count: 3, presses: 3 };
  const b = browser(OWNER_C);
  for (const type of Object.keys(stamps.SEALS)) {
    const id = seed(OWNER_C, type, { detail, at: T0 + Object.keys(stamps.SEALS).indexOf(type) * 1000 });
    const { url } = await share(b, id);
    const sid = url.split("/").pop();
    const row = db.db.prepare("SELECT * FROM stamps WHERE id = ?").get(id);
    const pub = stamps.publicSeal(row, "Omari");
    const outputs = [JSON.stringify(pub), wx.sealCardHtml({ pub, first: "Omari" }), wx.sealStoryHtml({ pub, first: "Omari" })];
    await server(async (base) => {
      const r = await fetch(`${base}/s/${sid}`);
      outputs.push(await r.text(), JSON.stringify([...r.headers]));
      await fetch(`${base}/s/${sid}/og.png`);
      outputs.push(drawn.at(-1)?.html ?? "");
    });
    const all = outputs.join("\n");
    for (const s of SECRETS) assert.ok(!all.includes(s), `${type}: "${s}" leaked`);
    assert.ok(all.includes(stamps.SEALS[type].name), `${type}: the name is there`);
  }
  // The owner's own book keeps the amount (private); the shared ring never does.
  assert.match(stamps.summarize({ id: 1, conversation_id: OWNER_C, type: "price_drop", earned_at: T0, detail_json: JSON.stringify(detail), rotation: 0, message_id: 0 }).ring, /FORTY DOLLARS/);
  assert.equal(stamps.publicSeal({ type: "price_drop", conversation_id: OWNER_C, earned_at: T0, detail_json: JSON.stringify(detail) }).ring, "A BETTER RATE, SECURED · ON YOUR BEHALF ·");
});

// ---------------------------------------------------------------- Home
test("Home: New in your book is the newest seal at 104px with no postmark, its name and one line; one-offs never", () => {
  seed(OWNER_C, "long_hold", { at: Date.now() - 86_400_000, detail: { minutes: 52, place: "Delta" } });
  const newest = stamps.newestStamp(OWNER_C);
  assert.equal(newest.type, "long_hold");
  const base = { issueNumber: 3, date: "2026-10-27", greeting: "morning.", overnight: [], linesOut: [], pickup: null };
  const h = renderDaily({ edition: { ...base, newestStamp: newest }, csrf: "x" });
  const tile = /<a class="dd-nb"[\s\S]*?<\/a>/.exec(h)[0];
  assert.match(tile, /width="104" height="104"/);
  assert.ok(!tile.includes("HEYREASON"), "no postmark");
  assert.match(tile, /NEW IN YOUR BOOK/);
  assert.match(tile, /<span class="dd-nbn">Held on your behalf\.<\/span>/);
  assert.match(tile, /<span class="dd-nbw">Fifty-two minutes with Delta\. It was no trouble\.<\/span>/);
  db.db.exec("DELETE FROM stamps");
  seed(OWNER_C, "first", { at: Date.now() - 86_400_000 });
  assert.equal(stamps.newestStamp(OWNER_C), null, "the patch is kept outside the book, not a seal");
});

test("flag off: no suite key, no job, no anniversary, nothing told — prod's book is untouched", () => {
  process.env.REASON_STAMPS_WAX = "";
  const s = T0 - 40 * 86_400_000;
  finished("call", OWNER_C, { start: s, end: s + 20 * M });
  finished("research", OWNER_C, { start: s + 5 * M, end: s + 40 * M });
  finished("purchase", OWNER_C, { start: s + 45 * M, end: s + 60 * M });
  finished("task", OWNER_C, { start: s + 61 * M, end: s + 110 * M });
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(T0 - 400 * 86_400_000, OWNER_C);
  stamps.checkAnniversary(OWNER_C);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM stamps WHERE type IN ('suite_key','anniversary')").get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM stamp_jobs").get().n, 0);
  assert.equal(stamps.tellLine(["suite_key"]), "", "a wax-only kind has no typed line, so nothing is sent");
});

test("suite key: an errand already in one job never counts toward another; a purchase keeps the time it was placed", () => {
  const s = T0 - 50 * 86_400_000;
  finished("call", OWNER_C, { start: s, end: s + 10 * M });
  finished("research", OWNER_C, { start: s + 1 * M, end: s + 20 * M });
  const buy = finished("purchase", OWNER_C, { start: s + 2 * M, end: s + 30 * M });
  finished("task", OWNER_C, { start: s + 3 * M, end: s + 40 * M });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM stamps WHERE type = 'suite_key'").get().n, 1);
  // A later write moves updated_at on; the purchase still finished when it was placed.
  db.db.prepare("UPDATE agentcard_purchases SET updated_at = ? WHERE buy_conversation_id = ?").run(s + 10 * 60 * M, buy);
  finished("call", OWNER_C, { start: s + 50 * M, end: s + 60 * M });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM stamps WHERE type = 'suite_key'").get().n, 1, "the second call alone makes no second key");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM stamp_jobs").get().n, 1);
});
