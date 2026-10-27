// Reason Web, Ongoing end to end (owner's design handoff 2026-10-26, "3 · Ongoing", sheets 2, 3 and 9D;
// src/ongoing.js + src/pages/webongoing.js). One pinned test per state the reference shows:
//
//   1. the mobile tab: "Ongoing", N THINGS · N NEEDS YOU, NEEDS YOU / IN HAND / BACK TO YOU, typed statuses
//   2. working: a real checklist (✓ / ○ pen / ○ muted, text alternatives), never a percentage
//   3. waiting (who, since), scheduled (time + EVERY MON), one-off (time + date)
//   4. back to you: READY → View result; DIDN'T WORK in pen with the Caveat reason and the next plan
//   5. the desktop margin: same groups, "2 OF 3" + the Caveat live line; at volume 2C's quiet rows (test/web-ongoing-volume.test.js)
//   (1–4 draw three things in hand, ongoing-mobile's fuller rows; four or more is "at volume", sheet 2A)
//   6. details 2A–2E and the approval detail, with only the fields each row really has
//   7. the approval stays chat-driven: no approve button; the nudge is intent; Face ID only for AgentCard
//   8. the plumbing the design needed: sheet.steps, task_finish's result, a confirmation's amount
//   9. routes: signed in only, the session's own rows only (cross-account is the same 404)
//  10. 9D: signed out mid-task draws the real card, faded; the mobile "needs a yes →" nudge
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-ongoing-"));
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
const sheet = await import("../src/sheet.js");
const { webRequestFor } = await import("../src/http.js");
const { seedOngoing } = await import("./fixture-ongoing.js");
const { clock, config } = await import("../src/config.js");

const C = "dm:owner";
const K = "dm:fake:+14155559876";
const H = 60 * 60_000;
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  db.db.exec(`DELETE FROM tasks; DELETE FROM task_log; DELETE FROM timers; DELETE FROM series; DELETE FROM confirmations; DELETE FROM agentcard_purchases;
    DELETE FROM accounts; DELETE FROM threads; DELETE FROM page_sessions;`);
  for (const [c, a, n, op] of [[C, "+12025551234", "Omari", true], [K, "+14155559876", "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
});
/** Pages escape an apostrophe as &#39;; the tests read the words. */
const words = (h) => h.replace(/&#39;/g, "'");
const tab = () => words(wc.renderOngoing({ csrf: "c", ...og.ongoing(C) }));
/** The fixture with three things in hand (its one-off reminder off): ongoing-mobile's fuller rows, not volume's. */
const seedFew = (opts) => { const ids = seedOngoing(C, opts); db.cancelTimer(C, ids.timer); return ids; };
const margin = () => words(wc.renderConversation({ account: { conversation_id: C, name: "Omari" }, csrf: "c", lines: [], more: false, sendId: "s", ...og.ongoing(C) }));

test("1. the tab: Ongoing, N THINGS · N NEEDS YOU, the three groups in order with their counts, a typed status on every row", () => {
  seedFew();
  const s = tab();
  assert.match(s, /<h1 class="h1">Ongoing<\/h1><p class="lbl">6 THINGS · 1 NEEDS YOU<\/p>/);
  const heads = [...s.matchAll(/<h2( class="pen")?>([A-Z ]+ · \d+)<\/h2>/g)].map(m => [m[2], !!m[1]]);
  assert.deepEqual(heads, [["NEEDS YOU · 1", true], ["IN HAND · 3", false], ["BACK TO YOU · 2", false]]);
  for (const t of ["WORKING", "WAITING", "EVERY MON", "READY"]) assert.match(s, new RegExp(`<span class="lbl">${t}</span>`));
  assert.match(s, /<span class="lbl pen">DIDN'T WORK<\/span>/);
  assert.match(s, /<nav class="tabs"[^]*Ongoing<span class="n" aria-label="6 things">6<\/span>/);
  assert.ok(!s.includes("See all"), "nothing past the top three, so no See all");
  assert.ok(!/%|progress-bar|<progress/.test(s.replace(/<style>[^]*?<\/style>/, "")), "no percentages");
  // The approval on its paper card, with the reference's two lines under it.
  assert.match(s, /<div class="card appr og-appr"><p class="appr-t">Buy the CeraVe PM lotion from Target<\/p><p class="appr-d">\$16\.78 all-in from Target\.<\/p><p class="lbl">NOTHING CHARGED YET<\/p><div class="appr-f"><a class="appr-go" href="\/web\/ongoing\/approval\/\d+">Review details <span aria-hidden="true">→<\/span><\/a><span class="hand tilt15">or just reply in the chat<\/span>/);
  // Empty: Nothing left to chase.
  db.db.exec("DELETE FROM tasks; DELETE FROM timers; DELETE FROM series; DELETE FROM confirmations;");
  assert.match(tab(), /Nothing left<br>to chase\.<\/h1>[^]*whatever you hand me shows up here while i work\./);
});

test("2. working: the real steps, ✓ done · ○ pen in hand with its live words · ○ muted not started, each with a text alternative", () => {
  const ids = seedFew({ withApproval: false });
  const s = tab();
  const row = s.slice(s.indexOf(`href="/web/ongoing/task/${ids.working}"`), s.indexOf("</a>", s.indexOf(`href="/web/ongoing/task/${ids.working}"`)));
  assert.match(row, /data-state="working" data-flight="WORKING"/);
  assert.match(row, /<span class="og-st og-st-done"><span class="og-g" role="img" aria-label="Done">✓<\/span><span class="og-tx">Hudson inn: open, \$540<\/span>/);
  assert.match(row, /og-st-doing"><span class="og-g" role="img" aria-label="In progress">○<\/span><span class="og-tx">Waramaug cabin <span class="hand">on the phone now<\/span>/);
  assert.match(row, /og-st-todo"><span class="og-g" role="img" aria-label="Not started">○<\/span><span class="og-tx">Woodstock hotel/);
  assert.match(s, /\.og-steps \.og-st-doing \.og-g\{color:var\(--pen\)\}/);
  assert.match(s, /\.og-steps \.og-st-todo\{color:var\(--muted\)\}/);
  // A task with no steps on its sheet shows what its record says: progress lines done, what's left not started.
  const t = db.createTask(C, { title: "x", goal: "g", maxAttempts: 3, label: "Old one" });
  db.updateTask(C, t.id, { progress: "Called the shop", sheet: { left: ["Email the landlord"] } });
  const back = og.stepsOf(db.getTask(C, t.id));
  assert.equal(back.real, false);
  assert.deepEqual(back.steps.map(x => [x.text, x.state]), [["Called the shop", "done"], ["Email the landlord", "todo"]]);
  assert.equal(og.findItem(C, "task", t.id).of, null, "no 'N OF M' from a guess");
});

test("3. waiting says who and since; scheduled shows the time and EVERY MON; a one-off its time and date", () => {
  const ids = seedOngoing(C, { withApproval: false });
  const w = og.findItem(C, "task", ids.waiting);
  assert.equal(w.state, "waiting");
  assert.match(w.detail, /^On the store: a reply about the refund\. Asked \w+day, \d{1,2}:\d{2} (AM|PM)\.$/);
  const s = og.findItem(C, "series", ids.series);
  assert.equal(s.every, "EVERY MON");
  assert.equal(s.everyLong, "EVERY MONDAY");
  assert.equal(s.time, "9:00");
  assert.equal(s.period, "AM");
  assert.match(s.date, /^MON [A-Z]{3} \d{1,2}$/);
  assert.equal(s.description, "Call the gym about the 6 PM class, then text you what they say.");
  const t = og.findItem(C, "timer", ids.timer);
  assert.equal(t.every, null);
  assert.match(t.date, /^[A-Z]{3} [A-Z]{3} \d{1,2}$/);
  // A series' own firing is not drawn twice.
  assert.equal(og.ongoing(C).items.filter(x => x.kind === "timer").length, 1);
  assert.deepEqual(og.everyWords({ kind: "weekly", weekdays: [1, 4] }), { short: "EVERY MON · THU", long: "EVERY MONDAY AND THURSDAY" });
  assert.equal(og.everyWords({ kind: "daily" }).short, "EVERY DAY");
  db.cancelTimer(C, ids.timer);
  assert.match(tab(), /<span class="og-time">9:00<span class="ampm">AM<\/span><\/span>/);
});

test("4. back to you: READY with View result →; DIDN'T WORK with the Caveat reason and the next plan; gone after three days", () => {
  const ids = seedFew({ withApproval: false });
  const s = tab();
  assert.match(s, new RegExp(`<div class="og-row" data-state="ready"><span class="og-top"><b>Table for four, Saturday</b><span class="lbl">READY</span></span><a class="og-go" href="/web/ongoing/task/${ids.ready}">View result `));
  assert.match(s, /<b>Two tickets for Friday<\/b><span class="lbl pen">DIDN'T WORK<\/span><\/span><span class="hand">sold out before i got in\. sorry\.<\/span><span class="og-d">I'm watching resale/);
  clock.skip(og.BACK_WINDOW_MS + 1);
  assert.equal(og.ongoing(C).back.length, 0);
  // Cancelled is never "back to you".
  clock.reset();
  const c = db.createTask(C, { title: "c", goal: "g", maxAttempts: 3, label: "Called off" });
  db.finishTask(C, c.id, { state: "cancelled", outcome: "they called it off" });
  assert.ok(!og.ongoing(C).back.some(x => x.title === "Called off"));
});

test("5. the desktop margin: the same groups with counts, 2 OF 3 with the live line; at volume, 2C's quiet rows", () => {
  const ids = seedFew();
  const s = margin();
  assert.match(s, /<div class="og-h"><h2>Ongoing<\/h2><button class="act2 og-hide"/);
  assert.match(s, /<b>Nov 14–16 at all three<\/b><span class="lbl">2 OF 3<\/span><\/span><span class="hand">on the phone now<\/span>/);
  assert.match(s, /<b>Check in on the gym class<\/b><span class="when">Mon 9:00<\/span>/);
  assert.match(s, /<b>Table for four, Saturday<\/b><span class="og-v">View /);
  assert.match(s, /<h3>BACK TO YOU · 2<\/h3>/);
  assert.match(s, /<button class="og-back" type="button" aria-controls="og" aria-expanded="false" aria-label="Show Ongoing, 6 things"><span aria-hidden="true">ONGOING · 6<\/span><\/button>/);
  // A fourth thing in hand: volume. The top three, then a serif "See all 4 →" to IN HAND's own page.
  db.createTimer(C, { fireAt: clock.now() + 50 * H, note: "n", label: "Call the landlord" });
  const v = margin();
  assert.match(v, /<aside class="og og-vol" id="og"/);
  assert.match(v, /<h3>IN HAND · 4<\/h3><div class="ogv-l">(<a class="ogv" [^]*?<\/a>){3}<\/div><a class="og-more" href="\/web\/ongoing\/hand">See all 4 <span aria-hidden="true">→<\/span><\/a>/);
  assert.match(v, new RegExp(`<a class="card og-vc m" href="/web/ongoing/approval/${ids.approval}"><span class="ogv-t">Buy the CeraVe PM lotion from Target</span><span class="lbl">NOTHING CHARGED YET</span></a>`));
  assert.match(v, /<span class="ogv-t">Call the landlord<\/span><span class="ogv-r"><span class="lbl">[A-Z]{3}<\/span><\/span><\/a>/, "the margin types the day");
  assert.ok(!v.includes("Check in on the gym class"), "the fourth soonest is on See all");
});

test("6. details 2A–2E and the approval: ← ONGOING, a typed status, a serif headline, the row's real fields", () => {
  const ids = seedOngoing(C);
  const d = (kind, id) => words(page.renderDetail(og.findItem(C, kind, id)));
  for (const [kind, id] of [["approval", ids.approval], ["task", ids.working], ["task", ids.waiting], ["series", ids.series], ["timer", ids.timer], ["task", ids.ready], ["task", ids.failed]]) {
    assert.match(d(kind, id), /<header class="ogd-h"><a class="act2" href="\/web\?tab=ongoing">← ONGOING<\/a><\/header>/);
  }
  const w = d("task", ids.working);
  assert.match(w, /<p class="lbl">WORKING ON IT<\/p><h1 class="h1">Nov 14–16 at all three<\/h1>/);
  assert.match(w, /<li class="done"><span class="og-g" role="img" aria-label="Done">✓<\/span><span class="t">Hudson inn: open, \$540<\/span><span class="at"><time datetime="[^"]+">\d{1,2}:\d{2}<\/time><\/span><\/li>/);
  assert.match(w, /<p class="small">NOTHING BOOKED YET<\/p>/);
  assert.match(w, /Talk about it in the chat <span aria-hidden="true">→<\/span>/);
  assert.ok(!/Omari/.test(w.replace(/<script>[^]*?<\/script>/g, "")), "never their name in the third person");
  const wt = d("task", ids.waiting);
  assert.match(wt, /<p class="lbl">WAITING ON THE STORE<\/p>/);
  assert.match(wt, /<dt>ASKED<\/dt><span class="dots" aria-hidden="true"><\/span><dd>[A-Z]{3} · \d{1,2}:\d{2} (AM|PM)<\/dd>/);
  assert.match(wt, /<dt>FOR<\/dt>[^]*<dd>A REPLY ABOUT THE REFUND<\/dd>/);
  assert.match(wt, /<p class="hand big">i'll check again \w+day\.<\/p>/);
  const sc = d("series", ids.series);
  assert.match(sc, /<p class="lbl">SCHEDULED<\/p><p class="huge-t">9:00<span class="ampm">AM<\/span><\/p><p class="every">EVERY MONDAY<\/p>/);
  assert.match(sc, /<p class="small">NEXT · MON [A-Z]{3} \d{1,2}<\/p>/);
  assert.match(sc, /Change it in the chat /);
  const tm = d("timer", ids.timer);
  assert.match(tm, /<p class="every">[A-Z]+DAY [A-Z]{3} \d{1,2}<\/p>/);
  assert.ok(!tm.includes("NEXT ·"), "a one-off has no NEXT");
  const r = d("task", ids.ready);
  assert.match(r, /<p class="lbl">READY<\/p>[^]*<div class="bigcard"><p class="res-h">Via Carota<\/p><p class="res-f">SAT · 7:30 PM<br>4 PEOPLE · UNDER OMARI<\/p><p class="res-n">They'll hold the table 15 minutes\.<\/p><span class="stamp above stamp-pen">DONE<\/span>/);
  assert.match(r, /See it in the chat /);
  const f = d("task", ids.failed);
  assert.match(f, /<p class="hand huge">sold out before i got in\. sorry\.<\/p><div class="next"><p class="lbl">WHAT HAPPENS NEXT<\/p><p class="b">I'm watching resale/);
  assert.match(f, /<p class="small">NOTHING CHARGED<\/p>/);
  // A charge made while it was open: "nothing charged" is no longer true, so it is not said.
  db.db.prepare("UPDATE agentcard_purchases SET order_id = 'o1', created_at = ? WHERE buy_conversation_id = 'buy-1'").run(db.getTask(C, ids.failed).created_at);
  assert.ok(!d("task", ids.failed).includes("NOTHING CHARGED"));
  // A purchase whose outcome nobody knows, live while the task was open: not claimed either.
  db.db.prepare("UPDATE agentcard_purchases SET order_id = '', status = 'outcome_unknown', charge_status = 'unknown' WHERE buy_conversation_id = 'buy-1'").run();
  assert.ok(!d("task", ids.failed).includes("NOTHING CHARGED"));
  db.db.prepare("UPDATE agentcard_purchases SET status = 'cancelled', charge_status = 'none' WHERE buy_conversation_id = 'buy-1'").run();
  assert.ok(d("task", ids.failed).includes("NOTHING CHARGED"), "a cart that surely took nothing does not suppress it");
  // An older done task with no result card: its outcome, as Reason wrote it.
  const o = db.createTask(C, { title: "o", goal: "g", maxAttempts: 3, label: "Roundup" });
  db.finishTask(C, o.id, { state: "done", outcome: "Texted the three-story roundup" });
  assert.match(d("task", o.id), /<p class="res-b">Texted the three-story roundup<\/p>/);
});

test("7. the approval detail: only the fields its record has, NOTHING CHARGED YET stamp, chat-driven, never a Face ID promise", () => {
  const ids = seedOngoing(C);
  const a = words(page.renderDetail(og.findItem(C, "approval", ids.approval)));
  assert.match(a, /<p class="lbl pen">NEEDS YOUR APPROVAL<\/p><h1 class="h1">Buy the CeraVe PM lotion from Target<\/h1>/);
  for (const [k, v] of [["SHOP", "TARGET"], ["ITEM", "CERAVE PM MOISTURIZING FACE LOTION 3 FL OZ"], ["SHIPS TO", "BRONX, NY 10467"], ["HOLD UP TO", "\\$26\\.14"]]) {
    assert.match(a, new RegExp(`<dt>${k}</dt><span class="dots" aria-hidden="true"></span><dd>${v}</dd>`));
  }
  assert.match(a, /<div class="tot"><dt>TOTAL<\/dt><span class="dots" aria-hidden="true"><\/span><dd>\$16\.78<\/dd><\/div>/);
  const main = a.slice(a.indexOf("<main"), a.indexOf("</main>"));
  assert.ok(!/DATES|ROOM|DRIVE|CANCEL BY|\[[A-Z$]/.test(main), "nothing the record doesn't have, no placeholders");
  assert.match(a, /<span class="stamp below stamp-pen">NOTHING CHARGED YET<\/span>/);
  assert.match(a, /<p class="hand big">just tell me in the chat when you want it\.<\/p>/);
  assert.match(a, /<p class="hand big">just tell me in the chat when you want it\.<\/p><p class="q">Nothing is charged until you say so in the chat\.<\/p><\/div>/);
  assert.ok(!a.includes("Face ID"));
  assert.match(a, /Reply in the chat <span aria-hidden="true">→<\/span>/);
  assert.ok(!/<button[^>]*>[^<]*(Approve|Book|Buy|Yes)/i.test(a), "no approve button");
  assert.ok(!/reply "|say "|type "/i.test(a), "no command phrases");
  // A call ask: WHAT, TO, ASKED; no Face ID line, no total without an amount.
  const c = db.askConfirmation({ conversationId: C, action: "call_place", summary: "Call the dentist to move Tuesday", stakes: "third_party", target: "+12125550100", askedAfterMsgs: 0 });
  const call = page.renderDetail(og.findItem(C, "approval", c.id));
  assert.match(call, /<dt>WHAT<\/dt>[^]*<dd>CALL<\/dd>[^]*<dt>TO<\/dt>[^]*<dd>\+12125550100<\/dd>/);
  assert.ok(!call.includes("Face ID") && !call.includes("TOTAL") && !call.includes("Nothing is charged"));
  assert.match(call, /NOTHING BOOKED YET/);
  // A day old: no longer drawn as one that needs them, even by its address.
  clock.skip(og.APPROVAL_WINDOW_MS + 1);
  assert.equal(og.findItem(C, "approval", c.id), null);
  clock.reset();
  // Answered: no longer an approval.
  db.grantConfirmation(c.id, "yes");
  assert.equal(og.findItem(C, "approval", c.id), null);
});

test("8. the plumbing: steps on the sheet (one in hand, done times stamped), task_finish's result, a confirmation's amount", async () => {
  const s0 = sheet.emptySheet();
  const a = sheet.applyPatch(s0, { steps: [{ text: "One", state: "done" }, { text: "Two", state: "doing", live: "on it now" }, { text: "Three" }] }, { now: 1000 });
  assert.equal(a.ok, true);
  assert.deepEqual(a.sheet.steps.map(x => [x.text, x.state, x.at, x.live]), [["One", "done", 1000, null], ["Two", "doing", null, "on it now"], ["Three", "todo", null, null]]);
  const b = sheet.applyPatch(a.sheet, { steps: [{ text: "One", state: "done" }, { text: "Two", state: "done" }, { text: "Three", state: "doing" }] }, { now: 5000 });
  assert.deepEqual(b.sheet.steps.map(x => x.at), [1000, 5000, null], "a done step keeps when it was done");
  assert.equal(sheet.applyPatch(s0, { steps: [{ text: "a", state: "doing" }, { text: "b", state: "doing" }] }).ok, false);
  assert.equal(sheet.applyPatch(s0, { steps: [{ text: "a", state: "50%" }] }).ok, false);
  assert.ok(sheet.sheetView(b.sheet).steps.length === 3, "the model sees them");
  const tools = await import("../src/tools.js");
  assert.match(tools.tools.find(t => t.name === "task_update").input_schema.properties.sheet.description, /steps: \[\{id\?, text, state, live\?\}\]/);
  assert.ok(tools.tools.find(t => t.name === "task_finish").input_schema.properties.result);
  assert.deepEqual(og.resultFor("failed", { why: " sold out. ", next: "" }), { why: "sold out.", next: null });
  assert.equal(og.resultFor("cancelled", { why: "x" }), null);
  assert.equal(og.resultFor("done", {}), null);
  // Through the real tool: task_finish's result reaches the row (the input schema keeps it).
  const t = db.createTask(C, { title: "x", goal: "g", maxAttempts: 3, label: "Tickets" });
  const out = JSON.parse(JSON.stringify(await tools.runTool("task_finish", { task_id: t.id, state: "failed", outcome: "sold out", result: { why: "sold out before i got in.", next: "Watching resale." } }, { conversationId: C })));
  assert.notEqual(out.ok, false, JSON.stringify(out));
  assert.deepEqual(JSON.parse(db.getTask(C, t.id).result_json), { why: "sold out before i got in.", next: "Watching resale." });
  // confirm_request's amount reaches the row.
  const c = db.askConfirmation({ conversationId: C, action: "browser_submit", summary: "Book it", stakes: "money", target: "x", askedAfterMsgs: 0, amount: 240 });
  assert.equal(db.getConfirmation(C, c.id).amount_cents, 24000);
  assert.match(page.renderDetail(og.findItem(C, "approval", c.id)), /<dt>TOTAL<\/dt>[^]*<dd>\$240<\/dd>/);
});

let n = 0;
function browser(conversationId) {
  const token = `tok-og-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return `reason_page=${token}`;
}
const get = (path, cookie) => {
  const m = /^\/web\/ongoing(?:\/(state|approval|task|timer|series)(?:\/(\d+))?)?$/.exec(path);
  return page.ongoingRequest({ kind: m[1] || null, id: m[2] || null, method: "GET", headers: { host: "heyreason.test", ...(cookie ? { cookie } : {}) } });
};

test("9. routes: signed in only; the session's own rows only; somebody else's id is the same 404", async () => {
  const mine = seedOngoing(C);
  const theirs = seedOngoing(K, { withApproval: false });
  const me = browser(C), kofi = browser(K);
  assert.equal(get(`/web/ongoing/task/${mine.working}`, me).status, 200);
  assert.match(get(`/web/ongoing/task/${mine.working}`, me).body, /Nov 14–16 at all three/);
  // Kofi asking for mine, me asking for his: not found, and nothing of the other drawn.
  for (const [path, cookie] of [[`/web/ongoing/task/${mine.working}`, kofi], [`/web/ongoing/approval/${mine.approval}`, kofi], [`/web/ongoing/task/${theirs.ready}`, me], [`/web/ongoing/series/${theirs.series}`, me], [`/web/ongoing/timer/${theirs.timer}`, me]]) {
    const r = get(path, cookie);
    assert.equal(r.status, 404, path);
    assert.ok(!/Nov 14|Refund|Table for four|gym/.test(r.body));
  }
  assert.equal(og.findItem(K, "approval", mine.approval), null);
  // Signed out: the page goes to sign-in, the state answers 401.
  assert.equal(get(`/web/ongoing/task/${mine.working}`).status, 303);
  assert.equal(get(`/web/ongoing/task/${mine.working}`).headers.Location, "/web");
  assert.equal(get("/web/ongoing/state").status, 401);
  assert.deepEqual(JSON.parse(get("/web/ongoing/state", me).body), { ok: true, count: 7, needs: 1 });
  assert.equal(get("/web/ongoing", me).headers.Location, "/web?tab=ongoing");
  assert.equal(page.ongoingRequest({ kind: "task", id: "1", method: "POST", headers: {} }).status, 405);
  // Through the real router.
  const { createServer } = await import("node:http");
  void createServer;
  const r = await webRequestFor({ sub: null, method: "GET", query: { tab: "ongoing" }, headers: { host: "heyreason.test", cookie: me }, remoteAddress: "127.0.0.1", readBody: async () => null });
  assert.equal(r.status, 200);
});

test("10. 9D: the session runs out mid-task — the real card, faded, read off the page; the mobile 'needs a yes →' nudge", () => {
  const ids = seedOngoing(C);
  const s = margin();
  // The mid-task screen is drawn from the page's own in-flight row, never fetched for a signed-out browser.
  assert.match(page.NINE_D_JS, /querySelector\('\[data-flight\]'\)/);
  assert.match(page.NINE_D_JS, /Still working on it\.<br><em>Sign back in to see\.<\/em>/);
  assert.match(page.NINE_D_JS, /<div class="ghost" aria-hidden="true"><span class="lbl"><\/span><b><\/b><\/div><a class="act" href="\/web\?out=1">Sign in/);
  assert.match(page.NINE_D_JS, /textContent=s;[^]*textContent=t/, "words go in as text, never markup");
  assert.match(page.NINE_D_CSS, /\.nined \.ghost\{[^}]*opacity:\.5/);
  assert.ok(s.includes(page.NINE_D_JS));
  assert.match(s, /function expired\(\)\{if\(!window\.reasonMidTask\|\|!window\.reasonMidTask\(waiting>0\|\|!!until\)\)location\.href='\/web\?out=1'\}/);
  assert.match(s, new RegExp(`href="/web/ongoing/task/${ids.working}" data-state="working" data-flight="WORKING"`));
  // Nothing in flight: no card, the plain signed-out sign-in.
  const d = page.renderDetail(og.findItem(C, "task", ids.ready));
  assert.ok(!/<main[^>]*data-flight/.test(d));
  assert.match(page.renderDetail(og.findItem(C, "task", ids.working)), /<main class="ogd" data-flight="WORKING" data-title="Nov 14–16 at all three">/);
  // The Ongoing pages notice it too (they have no thread poll).
  assert.match(tab(), /fetch\('\/web\/ongoing\/state'/);
  // Mobile: the nudge above the composer, straight to the approval's detail; desktop has the margin instead.
  assert.match(s, new RegExp(`<a class="needs-yes" href="/web/ongoing/approval/${ids.approval}">the Target order needs a yes <span aria-hidden="true">→</span></a><div class="composer">`));
  assert.match(s, /@media \(min-width:900px\)\{\.needs-yes\{display:none\}\}/);
  // The chat's own approval card now has somewhere to review it.
  assert.match(s, new RegExp(`<a class="appr-go" href="/web/ongoing/approval/${ids.approval}">Review details`));
});

test("11. live (owner 10-26 D5): the margin, the rail's ONGOING · N and the tab count follow the list without a reload", () => {
  seedOngoing(C);
  const me = browser(C);
  const state = (query) => JSON.parse(page.ongoingRequest({ kind: "state", method: "GET", headers: { host: "heyreason.test", cookie: me }, query }).body);
  // The page carries the tag of the margin it drew; asking with it brings no html back.
  const m = og.ongoing(C);
  const s = wc.renderConversation({ account: { conversation_id: C, name: "Omari" }, csrf: "c", lines: [], more: false, sendId: "s", ...m });
  const v = /ogv:"([^"]+)"/.exec(s)[1];
  assert.deepEqual(state({ draw: "margin", v }), { ok: true, count: 7, needs: 1, v });
  // Something new lands: a new tag, the margin's html, and the new count.
  db.createTimer(C, { fireAt: clock.now() + 60 * 60_000, note: "n", label: "Call the dentist" });
  const j = state({ draw: "margin", v });
  assert.notEqual(j.v, v);
  assert.equal(j.count, 8);
  assert.match(j.html, /^<aside class="og og-vol" id="og" aria-label="Ongoing">/);
  assert.match(j.html, /Call the dentist/);
  assert.equal(j.html, page.ogMargin(og.ongoing(C)));
  // Without draw the answer is the old small one (the detail pages' sign-out check).
  assert.deepEqual(state({}), { ok: true, count: 8, needs: 1 });
  // The client: asked for beside every poll and stream event (and every 15 s), swapped in place keeping
  // never while focus is inside it; the rail and the tab's badge recounted; HIDE delegated (See all is a link since #191).
  assert.match(s, /\(j\.messages\|\|\[\]\)\.forEach\(add\);settleIn\(j\.settled\);ogLook\(\)/);
  assert.match(s, /es\.addEventListener\('message',function\(e\)\{[^}]*\}catch\(x\)\{\}ogLook\(\)\}\)/);
  assert.match(s, /setInterval\(ogLook,15000\)/);
  assert.match(s, /fetch\('\/web\/ongoing\/state\?draw=margin&v='\+encodeURIComponent\(R\.ogv\)/);
  assert.match(s, /if\(o2&&o2\.contains\(document\.activeElement\)\)return/);
  assert.match(s, /s\.textContent='ONGOING'\+\(n\?' \\u00b7 '\+n:''\)/);
  assert.match(s, /document\.addEventListener\('click',function\(e\)\{var o=ogEl\(\)/);
  // The page's script still parses.
  for (const js of s.match(/<script[^>]*>([\s\S]*?)<\/script>/g).map(t => t.replace(/^<script[^>]*>|<\/script>$/g, ""))) assert.doesNotThrow(() => new Function(js));
});

test("12. live on the phone's Ongoing tab: the list and the tab's count follow without a reload", () => {
  seedOngoing(C);
  const me = browser(C);
  const state = (query) => JSON.parse(page.ongoingRequest({ kind: "state", method: "GET", headers: { host: "heyreason.test", cookie: me }, query }).body);
  const s = wc.renderOngoing({ csrf: "c", ...og.ongoing(C) });
  const v = /REASON_OG=\{v:"([^"]+)"\}/.exec(s)[1];
  assert.equal(v, page.ogVersion(page.ogTabMain(og.ongoing(C))));
  assert.deepEqual(state({ draw: "tab", v }), { ok: true, count: 7, needs: 1, v });
  db.createTimer(C, { fireAt: clock.now() + 60 * 60_000, note: "n", label: "Call the dentist" });
  const j = state({ draw: "tab", v });
  assert.notEqual(j.v, v);
  assert.equal(j.count, 8);
  assert.match(j.html, /^<main class="og-list"><h1 class="h1">Ongoing<\/h1>[^]*Call the dentist[^]*<\/main>$/);
  assert.match(s, /fetch\('\/web\/ongoing\/state\?draw=tab&v='\+encodeURIComponent\(v\)/);
  assert.match(s, /if\(!m\|\|m\.contains\(document\.activeElement\)\)return/);
  for (const js of s.match(/<script[^>]*>([\s\S]*?)<\/script>/g).map(t => t.replace(/^<script[^>]*>|<\/script>$/g, ""))) assert.doesNotThrow(() => new Function(js));
});

test("13. D2 (owner 10-26): the Face ID line only when the card flow really will prompt, which Reason can't know before the yes; so every money ask says nothing is charged until they say so", () => {
  const ids = seedOngoing(C);
  const conv = (m) => words(wc.renderConversation({ account: { conversation_id: C, name: "Omari" }, csrf: "c", lines: [], more: false, sendId: "s", ...m }));
  const NOTHING = /<p class="hand">just tell me in the chat when you want it\.<\/p><p class="appr-q">Nothing is charged until you say so in the chat\.<\/p>/;
  // The AgentCard purchase ask: the detail and the chat's own approval card, never a Face ID promise.
  assert.equal("faceId" in og.findItem(C, "approval", ids.approval), false);
  assert.match(words(page.renderDetail(og.findItem(C, "approval", ids.approval))), /<p class="q">Nothing is charged until you say so in the chat\.<\/p>/);
  assert.match(conv(og.ongoing(C)), NOTHING);
  // Even when AgentCard has already paused this cart once for the passkey (the real signal, kept on the
  // purchase row: awaiting_approval + authorization + expiry), a new open yes still promises nothing:
  // whether the NEXT confirm pauses, and with which unlock, is AgentCard's call at that confirm.
  db.markAgentcardPurchase("buy-1", { status: "awaiting_approval", authorizationId: "cauth_test", approvalExpiresAt: clock.now() + 15 * 60_000 });
  const again = words(page.renderDetail(og.findItem(C, "approval", ids.approval)));
  assert.ok(!again.includes("Face ID"));
  assert.match(again, /Nothing is charged until you say so in the chat\./);
  assert.ok(!conv(og.ongoing(C)).includes("Face ID"));
  // An ask that spends nothing (a call): neither line, on the detail or the chat card.
  db.db.exec("DELETE FROM confirmations; DELETE FROM agentcard_purchases;");
  const c = db.askConfirmation({ conversationId: C, action: "call_place", summary: "Call the dentist to move Tuesday", stakes: "third_party", target: "+12125550100", askedAfterMsgs: 0 });
  const call = words(page.renderDetail(og.findItem(C, "approval", c.id)));
  const chat = conv(og.ongoing(C));
  assert.match(chat, /NEEDS YOUR APPROVAL[^]*Call the dentist to move Tuesday[^]*NOTHING BOOKED YET/);
  for (const h of [call, chat]) assert.ok(!h.includes("Face ID") && !h.includes("Nothing is charged"));
  // The nudge is unchanged and no command phrase crept in.
  assert.match(chat, /<p class="hand">just tell me in the chat when you want it\.<\/p>/);
  assert.ok(!/book it|reply "|say "|type "/i.test(chat + call));
});
