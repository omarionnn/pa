// Reason Web, Ongoing at volume (owner's handoff v2, 2026-10-26: reference/sheet-ongoing-volume 2A/2B/2C,
// HANDOFF §4c item 2, STAGING-REVIEW items 3 and 7; SCOPE-v2 SR3, SR7, O1–O3). One pinned test per behaviour:
//
//   1. 2A, the phone: `17 THINGS · 2 NEED YOU`, a count on every heading, each group's top 3, serif "See all N →"
//   2. NEEDS YOU always shows every approval: the first on 2A's card, the rest as APPROVE rows with when it was asked
//   3. the real meta lines: `2 OF 3` + `WORKING · STARTED 2:55 PM`, `STARTED YESTERDAY`, `WORKING · CALLING NOW`
//      only while a call for it is on the line, `ON THE STORE · SINCE TUE`, `EVERY MONDAY`, `ONCE`
//   4. 2B, See all: ← ONGOING, `9 THINGS · NEWEST FIRST`, filter words with counts, newest first, every row's meta
//   5. long titles clamp at two lines then …; the status never wraps (the CSS that does it)
//   6. 2C, the desktop margin: the same top 3 + See all, 2C's smaller approval card, typed days
//   7. SR7, the arrival: the approval stays on paper; "already in hand" is quiet rows between dashed rules
//   8. routes: signed in only, the session's own rows only, through the real server too
//   9. the plumbing: timers.created_at, written when a timer is set; older rows sort last, nothing guessed
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-web-ogv-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_WEB = "on";
delete process.env.REASON_BACKEND;

const db = await import("../src/db.js");
const og = await import("../src/ongoing.js");
const page = await import("../src/pages/webongoing.js");
const wc = await import("../src/pages/webconvo.js");
const { createServer } = await import("../src/http.js");
const { seedOngoing } = await import("./fixture-ongoing.js");
const { clock, config } = await import("../src/config.js");

const C = "dm:owner";
const K = "dm:fake:+14155559876";
const H = 60 * 60_000, D = 24 * H;
// Monday 2026-10-26, 3:10 PM in New York: "today" for every clock word below.
const MON = Date.parse("2026-10-26T15:10:00-04:00");
/** Put Reason's clock at `t` (it only skips; real milliseconds still pass, so equality below is to the second). */
const setNow = (t) => { clock.reset(); clock.skip(t - Date.now()); };
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  setNow(MON);
  config.web = true;
  db.db.exec(`DELETE FROM tasks; DELETE FROM task_log; DELETE FROM timers; DELETE FROM series; DELETE FROM confirmations; DELETE FROM agentcard_purchases;
    DELETE FROM calls; DELETE FROM accounts; DELETE FROM threads; DELETE FROM page_sessions;`);
  for (const [c, a, n, op] of [[C, "+12025551234", "Omari", true], [K, "+14155559876", "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
});
const words = (h) => h.replace(/&#39;/g, "'");
const visible = (h) => words(h.replace(/<style>[^]*?<\/style>/g, "").replace(/<script>[^]*?<\/script>/g, ""));
const tab = (conv = C) => words(wc.renderOngoing({ csrf: "c", ...og.ongoing(conv) }));
const margin = () => words(wc.renderConversation({ account: { conversation_id: C, name: "Omari" }, csrf: "c", lines: [], more: false, sendId: "s", ...og.ongoing(C) }));
/** Rows as drawn: [title, right-hand status text, meta]. */
const rows = (h) => [...h.matchAll(/<a class="ogv" [^>]*><span class="ogv-t">([^<]*)<\/span><span class="ogv-r">(?:<span class="lbl(?: pen)?">([^<]*)<\/span>|<span class="ogv-w">([^<]*)<\/span>)<\/span>(?:<span class="ogv-m">([^<]*)<\/span>)?<\/a>/g)]
  .map(m => [m[1], m[2] ?? m[3], m[4] ?? null]);
/** A task at a given start time, in a given state. */
function task(label, { at = clock.now(), state = null, sheet = null } = {}) {
  const was = clock.now();
  setNow(at);
  const t = db.createTask(C, { title: label.toLowerCase(), goal: "g", maxAttempts: 3, label, wakeAt: at + 30 * D });
  if (sheet || state) db.updateTask(C, t.id, { ...(sheet ? { sheet } : {}), ...(state ? { state } : {}) });
  setNow(was);
  return t.id;
}
/** The fixture plus enough to be "at volume": nine in hand, five back. */
function volume() {
  const ids = seedOngoing(C);
  task("Find a plumber who can come this week", { at: MON - 2 * H });
  task("Compare two phone plans", { at: MON - D });
  task("Dog sitter for Nov 14–16", { at: MON - 3 * D, state: "waiting_on_other", sheet: { waiting: [{ on: "Ama", for: "a yes for the dates" }] } });
  task("Refund for the boots from the store on Atlantic Ave, asked twice and still nothing back from them", { at: MON - 4 * D });
  db.createTimer(C, { fireAt: MON + 6 * D, note: "passport", label: "Passport renewal reminder" });
  for (const [l, s] of [["New insurance card, ordered", "done"], ["Return the lamp", "done"], ["Move the dentist", "failed"]]) {
    const t = db.createTask(C, { title: l, goal: "g", maxAttempts: 3, label: l });
    db.finishTask(C, t.id, { state: s, outcome: "x" });
  }
  return ids;
}

test("1. 2A: N THINGS · N NEED YOU, a count on every heading, each group's top 3, then a serif See all N →", () => {
  volume();
  const s = tab();
  assert.match(s, /<h1 class="h1">Ongoing<\/h1><p class="lbl">15 THINGS · 1 NEEDS YOU<\/p>/);
  const heads = [...s.matchAll(/<h2( class="pen")?>([A-Z ]+ · \d+)<\/h2>/g)].map(m => [m[2], !!m[1]]);
  assert.deepEqual(heads, [["NEEDS YOU · 1", true], ["IN HAND · 9", false], ["BACK TO YOU · 5", false]]);
  assert.match(s, /<aside class="og og-tab og-vol" id="og"/);
  const sec = (h) => s.slice(s.indexOf(`>${h} · `), s.indexOf("</section>", s.indexOf(`>${h} · `)));
  assert.equal(rows(sec("IN HAND")).length, 3);
  assert.equal(rows(sec("BACK TO YOU")).length, 3);
  assert.match(sec("IN HAND"), /<a class="og-more" href="\/web\/ongoing\/hand">See all 9 <span aria-hidden="true">→<\/span><\/a>$/);
  assert.match(sec("BACK TO YOU"), /<a class="og-more" href="\/web\/ongoing\/back">See all 5 <span aria-hidden="true">→<\/span><\/a>$/);
  // The phone's quiet rows: title, typed status; no meta line (2A draws none in hand).
  assert.deepEqual(rows(sec("IN HAND"))[0], ["Nov 14–16 at all three", "2 OF 3", null]);
  // A scheduled row sets its time in serif ("Mon 9:00"), never a typed label.
  const two = page.vRow(og.ongoing(C).items.find(x => x.title === "Call the landlord"));
  assert.match(two, /<span class="ogv-r"><span class="ogv-w">Wed 5:10<\/span><\/span>/);
  // Plural / singular.
  assert.equal(page.countLine({ items: [{ needs: true }], approvals: [{}] }), "2 THINGS · 2 NEED YOU");
  assert.equal(page.countLine({ items: [{}] }), "1 THING");
  // 2A's approval card: NEEDS YOUR APPROVAL in pen, the title, NOTHING CHARGED YET, Review details →.
  assert.match(s, /<div class="card og-vc"><span class="lbl pen">NEEDS YOUR APPROVAL<\/span><span class="ogv-t">Buy the CeraVe PM lotion from Target<\/span><span class="lbl">NOTHING CHARGED YET<\/span><a class="appr-go" href="\/web\/ongoing\/approval\/\d+">Review details <span aria-hidden="true">→<\/span><\/a><\/div>/);
  assert.match(s, /\.og-more\{[^}]*font:italic 400 20px\/1 var\(--serif\)\}/);
  assert.match(s, /\.og-sec>h2,\.og-sec>h3\{margin:0 0 4px;font:400 11px\/1\.4 var\(--mono\);letter-spacing:\.14em/);
});

test("2. NEEDS YOU shows every approval: the first on paper, the rest APPROVE rows with when they were asked", () => {
  volume();
  for (let i = 0; i < 4; i++) {
    setNow(MON - (i + 1) * H);
    db.askConfirmation({ conversationId: C, action: "browser_submit", summary: `Pay bill ${i}`, stakes: "money", target: `b${i}`, askedAfterMsgs: 0, amount: 10 + i });
  }
  setNow(MON);
  const s = tab();
  assert.match(s, /<h2 class="pen">NEEDS YOU · 5<\/h2>/);
  const needs = s.slice(s.indexOf("NEEDS YOU · 5"), s.indexOf("</section>", s.indexOf("NEEDS YOU · 5")));
  assert.equal((needs.match(/class="card og-vc"/g) ?? []).length, 1, "one card");
  const r = rows(needs);
  assert.equal(r.length, 4, "never cut at three, never a See all");
  assert.ok(!needs.includes("See all"));
  for (const [, right, meta] of r) { assert.equal(right, "APPROVE"); assert.match(meta, /^ASKED \d{1,2}:\d{2} (AM|PM)$/); }
  assert.match(needs, /<span class="lbl pen">APPROVE<\/span>/);
  assert.match(needs, /<div class="og-sp" aria-hidden="true"><\/div>/);
  assert.match(s, /<p class="lbl">19 THINGS · 5 NEED YOU<\/p>/);
});

test("3. the meta lines are the rows' own: steps, started, a live call, who it's on and since, the schedule", () => {
  const ids = volume();
  const all = og.ongoing(C).items;
  const meta = (title) => all.find(x => x.title === title)?.meta;
  // Started today: its time. Its steps say 2 OF 3 at the right.
  assert.equal(all.find(x => x.id === ids.working && x.kind === "task").of, "2 OF 3");
  assert.equal(meta("Nov 14–16 at all three"), "WORKING · STARTED 3:10 PM");
  assert.equal(meta("Compare two phone plans"), "STARTED YESTERDAY");
  assert.equal(meta("Refund for the boots from the store on Atlantic Ave, asked twice and still nothing back from them"), "STARTED THU");
  // The waits: on whom, and since when they started waiting (the sheet stamps it).
  assert.equal(meta("Refund for the boots"), "ON THE STORE · SINCE 3:10 PM");
  assert.equal(meta("Dog sitter for Nov 14–16"), "ON AMA · SINCE FRI");
  assert.equal(meta("Check in on the gym class"), "EVERY MONDAY");
  assert.equal(meta("Call the landlord"), "ONCE");
  // A call for the task on the line now: CALLING NOW. A row whose end never arrived, hours old, is not.
  const plumber = all.find(x => x.title === "Find a plumber who can come this week").id;
  const call = db.db.prepare("INSERT INTO calls (conversation_id, provider, to_number, goal, state, created_at, updated_at, task_id) VALUES (?, 'fake', '+12125550100', 'g', 'in_progress', ?, ?, ?)").run(C, MON - 60_000, MON - 60_000, plumber);
  assert.equal(og.ongoing(C).items.find(x => x.id === plumber && x.kind === "task").meta, "CALLING NOW");
  db.db.prepare("UPDATE calls SET created_at = ? WHERE id = ?").run(MON - 3 * H, call.lastInsertRowid);
  assert.equal(og.ongoing(C).items.find(x => x.id === plumber && x.kind === "task").meta, "STARTED 1:10 PM");
  db.db.prepare("UPDATE calls SET created_at = ?, state = 'completed' WHERE id = ?").run(MON - 60_000, call.lastInsertRowid);
  assert.equal(og.ongoing(C).items.find(x => x.id === plumber && x.kind === "task").meta, "STARTED 1:10 PM");
  // Back to you and approvals carry theirs.
  assert.match(og.ongoing(C).back[0].meta, /^(DONE|STOPPED) · 3:10 PM$/);
  assert.match(og.ongoing(C).approvals[0].meta, /^ASKED 3:10 PM$/);
  // The words.
  assert.equal(og.whenWord(MON - 5 * 60_000, MON), "3:05 PM");
  assert.equal(og.whenWord(MON - 20 * H, MON), "YESTERDAY");
  assert.equal(og.whenWord(MON - 6 * D, MON), "OCT 20");
  assert.equal(og.whenWord(MON - 5 * D, MON), "WED");
  assert.equal(og.whenWord(null, MON), null);
  assert.deepEqual(og.nextWords(MON + 7 * D, "America/New_York", MON), { serif: "Nov 2", typed: "NOV 2" });
});

let n = 0;
function browser(conversationId) {
  const token = `tok-ogv-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return `reason_page=${token}`;
}
const get = async (kind, cookie, query = {}) => page.ongoingRequest({ kind, method: "GET", query, headers: { host: "heyreason.test", ...(cookie ? { cookie } : {}) } });

test("4. 2B, See all: ← ONGOING, N THINGS · NEWEST FIRST, filter words with counts, newest first, every row's meta", async () => {
  volume();
  const me = browser(C);
  const r = await get("hand", me);
  assert.equal(r.status, 200);
  const s = words(r.body);
  assert.match(s, /<header class="ogd-h"><a class="act2" href="\/web\?tab=ongoing">← ONGOING<\/a><\/header>/);
  assert.match(s, /<main class="oga"><div class="oga-h"><h1 class="h1">In hand<\/h1><span class="lbl">9 THINGS · NEWEST FIRST<\/span><\/div>/);
  assert.match(s, /<nav class="ogf" aria-label="Filter"><a href="\/web\/ongoing\/hand" aria-current="true">ALL 9<\/a><a href="\/web\/ongoing\/hand\?f=working">WORKING 4<\/a><a href="\/web\/ongoing\/hand\?f=waiting">WAITING 2<\/a><a href="\/web\/ongoing\/hand\?f=scheduled">SCHEDULED 3<\/a><\/nav>/);
  const r9 = rows(s);
  assert.equal(r9.length, 9);
  assert.ok(r9.every(([, , m]) => m), "every row has its meta line");
  // Newest first: the two fixture tasks and the timers set now, then 2 h ago, yesterday, Fri, Thu.
  const order = r9.map(x => x[0]);
  assert.ok(order.indexOf("Find a plumber who can come this week") < order.indexOf("Compare two phone plans"));
  assert.ok(order.indexOf("Compare two phone plans") < order.indexOf("Dog sitter for Nov 14–16"));
  assert.equal(order.at(-1), "Refund for the boots from the store on Atlantic Ave, asked twice and still nothing back from them");
  assert.deepEqual(r9.find(x => x[0] === "Check in on the gym class"), ["Check in on the gym class", "Nov 2", "EVERY MONDAY"]);
  // The phone's tab bar, Ongoing current.
  assert.match(s, /<nav class="tabs" aria-label="Sections">[^]*aria-current="page">Ongoing<span class="n"/);
  assert.match(s, /<body class="has-tabs">/);
  // A filter: only those, its word underlined, its count in the line.
  const w = words((await get("hand", me, { f: "waiting" })).body);
  assert.deepEqual(rows(w).map(x => x[2]), ["ON THE STORE · SINCE 3:10 PM", "ON AMA · SINCE FRI"]);
  assert.match(w, /<a href="\/web\/ongoing\/hand\?f=waiting" aria-current="true">WAITING 2<\/a>/);
  assert.match(w, /2 THINGS · NEWEST FIRST/);
  assert.match(w, /\.ogf a\[aria-current=true\]\{color:var\(--ink\);border-bottom-color:var\(--ink\)\}/);
  // A filter it doesn't have (or none at all): everything.
  assert.match(words((await get("hand", me, { f: "stuck" })).body), /9 THINGS · NEWEST FIRST/);
  // Back to you.
  const b = words((await get("back", me)).body);
  assert.match(b, /<h1 class="h1">Back to you<\/h1><span class="lbl">5 THINGS · NEWEST FIRST<\/span>/);
  assert.match(b, /ALL 5<\/a><a href="\/web\/ongoing\/back\?f=ready">READY 3<\/a><a href="\/web\/ongoing\/back\?f=failed">DIDN'T WORK 2<\/a>/);
  // Nothing in a group: back to Ongoing.
  db.db.exec("DELETE FROM tasks; DELETE FROM timers; DELETE FROM series;");
  const e = await get("back", me);
  assert.equal(e.status, 303);
  assert.equal(e.headers.Location, "/web?tab=ongoing");
});

test("5. long titles clamp at two lines then …; the status label never wraps", () => {
  volume();
  const s = tab();
  assert.match(s, /\.ogv-t\{font-size:16px;font-weight:600;line-height:1\.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden/);
  assert.match(s, /\.ogv-r\{white-space:nowrap\}/);
  assert.match(s, /\.ogv\{[^}]*display:grid;grid-template-columns:minmax\(0,1fr\) auto;gap:4px 12px/);
  assert.match(s, /\.ogv\{[^}]*border-bottom:1px dashed var\(--hair\)/);
  // The whole title is in the page (the clamp is the look, not a cut).
  const long = "Refund for the boots from the store on Atlantic Ave, asked twice and still nothing back from them";
  assert.ok(page.renderSeeAll(og.ongoing(C), "hand").includes(long));
});

test("6. 2C, the desktop margin: the same top 3 and See all, 2C's smaller approval card, the days typed", () => {
  const ids = volume();
  const s = margin();
  assert.match(s, /<div class="og-h"><h2>Ongoing<\/h2><button class="act2 og-hide"/);
  assert.match(s, /\.og-h h2\{font-size:30px\}/);
  assert.match(s, new RegExp(`<h3 class="pen">NEEDS YOU · 1</h3><a class="card og-vc m" href="/web/ongoing/approval/${ids.approval}"><span class="ogv-t">Buy the CeraVe PM lotion from Target</span><span class="lbl">NOTHING CHARGED YET</span></a></section>`));
  assert.match(s, /<h3>IN HAND · 9<\/h3>[^]*?See all 9 [^]*?<h3>BACK TO YOU · 5<\/h3>[^]*?See all 5 /);
  const hand = s.slice(s.indexOf("IN HAND · 9"), s.indexOf("</section>", s.indexOf("IN HAND · 9")));
  assert.deepEqual(rows(hand).map(x => x[1]), ["2 OF 3", "WAITING", "WED"]);
  assert.ok(rows(hand).every(x => x[2] === null), "no meta lines in the margin");
  assert.match(s, /aria-label="Show Ongoing, 15 things"><span aria-hidden="true">ONGOING · 15<\/span>/);
});

test("7. SR7, the arrival: the approval stays on paper; already in hand is quiet rows between dashed rules, then See all", () => {
  volume();
  const m = og.ongoing(C);
  const s = words(wc.renderHome({ account: { conversation_id: C, name: "Omari" }, csrf: "c", sendId: "s", ...m }));
  assert.match(s, /<section class="approval" aria-label="Needs you"><div class="card appr"><p class="lbl pen">NEEDS YOUR APPROVAL<\/p><p class="appr-t">Buy the CeraVe PM lotion from Target<\/p>/);
  assert.match(s, /just tell me in the chat when you want it\./);
  const inhand = s.slice(s.indexOf('<section class="inhand"'), s.indexOf("</section>", s.indexOf('<section class="inhand"')));
  assert.match(inhand, /^<section class="inhand" aria-label="Already in hand"><p class="lbl">ALREADY IN HAND<\/p><div class="ogv-l home-l">/);
  assert.equal(rows(inhand).length, 3);
  assert.match(inhand, /<a class="og-more" href="\/web\?tab=ongoing">See all 9 <span aria-hidden="true">→<\/span><\/a>$/);
  assert.ok(!/slipc|class="slips"|card slip/.test(visible(s)), "no boxed slips");
  assert.match(s, /\.home-l\{border-top:1px dashed var\(--hair\);border-bottom:1px dashed var\(--hair\)\}/);
  // Three or fewer: no See all.
  db.db.exec("DELETE FROM tasks; DELETE FROM timers; DELETE FROM series;");
  task("Just one");
  const one = wc.renderHome({ account: { conversation_id: C, name: "Omari" }, csrf: "c", sendId: "s", ...og.ongoing(C) });
  assert.match(one, /<div class="ogv-l home-l"><a class="ogv"[^]*?Just one[^]*?<\/a><\/div><\/section>/);
});

test("8. routes: signed in only; the session's own rows only; through the real server", async () => {
  volume();
  seedOngoing(K, { withApproval: false });
  const mine = browser(C), kofi = browser(K);
  const out = await get("hand");
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, "/web");
  const k = words((await get("hand", kofi)).body);
  assert.match(k, /4 THINGS · NEWEST FIRST/);
  assert.ok(!/plumber|phone plans|Dog sitter|Passport/.test(k), "nothing of mine on his");
  const server = createServer({ router: null, runtime: null });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const fetchIt = (path, cookie) => new Promise((resolve, reject) => {
      const q = request(`http://127.0.0.1:${server.address().port}${path}`, { headers: { host: "127.0.0.1", cookie } }, (res) => {
        let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      q.on("error", reject); q.end();
    });
    const r = await fetchIt("/web/ongoing/hand?f=working", mine);
    assert.equal(r.status, 200);
    assert.match(words(r.body), /4 THINGS · NEWEST FIRST[^]*aria-current="true">WORKING 4</);
    assert.equal((await fetchIt("/web/ongoing/back", mine)).status, 200);
    assert.equal((await fetchIt("/web/ongoing/hand/3", mine)).status, 404);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test("9. the plumbing: a timer knows when it was set; older ones (none) sort after every dated row", () => {
  const cols = db.db.prepare("PRAGMA table_info(timers)").all().map(c => c.name);
  assert.ok(cols.includes("created_at"));
  const t = db.createTimer(C, { fireAt: MON + D, note: "n", label: "New one" });
  assert.ok(Math.abs(db.getTimer(C, t.id).created_at - MON) < 5000);
  const old = db.createTimer(C, { fireAt: MON + 2 * D, note: "n", label: "From before" });
  db.db.prepare("UPDATE timers SET created_at = NULL WHERE id = ?").run(old.id);
  task("Older task", { at: MON - 9 * D });
  const order = page.groupRows(og.ongoing(C), "hand").map(x => [x.title, x.started ?? null]);
  assert.deepEqual(order.map(x => x[0]), ["New one", "Older task", "From before"]);
  assert.equal(order.at(-1)[1], null, "no time made up for it");
});
