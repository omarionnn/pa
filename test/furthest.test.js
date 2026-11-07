// Hand back the furthest point it got to.
//
// Omari, 2026-10-06: "when it fails, it should hand back the furthest point it got to, like a
// filled-in checkout that just needs your tap or a ready draft, never a plain 'couldn't do it'."
//
// Four things are checked here and none of them is a sentence the model wrote. The record is on the
// sheet and append-only. A job that got somewhere cannot be closed 'failed' or set 'blocked' with
// none of it handed over. A browser walk that stops writes down the URL it reached and what is
// filled in on the page, read off the page itself, against the fixture booking site. And the
// open-work page shows it, with the link where there is one.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBookingSite } from "./fixture-booking.js";
import { startSiteFixtures, COMMIT_LABELS } from "./fixture-sites.js";

const dir = mkdtempSync(join(tmpdir(), "reason-furthest-"));
// This suite's fixtures live on 127.0.0.1; outside a test, nothing may fetch there (src/netguard.js).
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1";
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const browser = await import("../src/browser.js");
const { clock, config } = await import("../src/config.js");
const sheet = await import("../src/sheet.js");
const { progressOn, madeFrom, handBackNeeded, filledFrom, shareable, fromWalk } = await import("../src/furthest.js");
const { activityBlocks } = await import("../src/activity.js");

const C = "dm:furthest";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });
const readsYes = async () => ({ verdict: "yes" });
// Shared so a yes he gives can be read out of his own words by the real gate, the way it is in
// production — see `approve` below and test/sites.test.js.
let messages;

let site;
before(async () => { site = await startBookingSite(); });
after(async () => {
  await browser.closeAllBrowsers();
  await site.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clock.reset();
  messages = [owner("sort it out for me")];
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM spend; DELETE FROM spend_caps; DELETE FROM unknown_outcomes;");
  site.bookings.length = 0;
});

// Every link in these tests is stated rather than fetched: the hand-back's link check is code's,
// and what the web did is not the thing under test. The fixture site is the exception — those
// addresses are real and really answer.
const opens = async (url) => ({ ok: true, url, status: 200, title: "" });
const dead = async (url) => ({ ok: false, status: 404, error: "not found", url });
const call = (name, input, ctx = {}) => runTool(name, input, { conversationId: C, messages, judge: readsYes, lookup: opens, ...ctx });

const startJob = async (extra = {}) => (await call("task_start", { title: "book carbone", goal: "a table for 4 friday", ...extra })).task;
const latestOn = (id) => sheet.latestFurthest(db.getTask(C, id).sheet);

const POINT = {
  form: "filled_form",
  what: "the Carbone reservation form, name and number filled in, friday 8pm",
  where: "https://example.com/reserve?place=carbone",
  filled: [{ field: "Name on the reservation", value: "Omari" }, { field: "Mobile number", value: "555-0100" }],
  one_action: "press 'Confirm reservation'",
  stopped: "needed_a_yes",
  because: "I can't press the last button without your say-so",
};

// ---------- the record on the sheet ----------

test("the furthest point goes on the sheet with everything that makes it usable", async () => {
  const { id } = await startJob();
  const out = await call("task_update", { task_id: id, sheet: { furthest: [POINT] } });
  assert.equal(out.ok, true, out.error);

  const point = sheet.latestFurthest(db.getTask(C, id).sheet);
  assert.equal(point.form, "filled_form");
  assert.equal(point.one_action, "press 'Confirm reservation'");
  assert.equal(point.stopped, "needed_a_yes");
  assert.equal(point.where, "https://example.com/reserve?place=carbone");
  assert.equal(point.where_known, "checked", "code says how the link was known to work, not the model");
  assert.deepEqual(point.filled.map(f => f.field), ["Name on the reservation", "Mobile number"]);
  assert.ok(point.at, "it is stamped, so 'how old is that form' is answerable");

  // And it comes back to the model with the order to lead with it.
  assert.equal(out.handed_back.what, POINT.what);
  assert.match(out.hand_back_note, /LEADS with it/);
  assert.match(out.hand_back_note, /press 'Confirm reservation'/);
});

test("a hand-back with no one_action, no reason or no form is refused, and nothing is written", async () => {
  const { id } = await startJob();
  for (const [missing, patch] of [
    ["one_action", { ...POINT, one_action: "" }],
    ["because", { ...POINT, because: "  " }],
    ["form", { ...POINT, form: "nearly_done" }],
    ["stopped", { ...POINT, stopped: "it just didn't work" }],
  ]) {
    const out = await call("task_update", { task_id: id, sheet: { furthest: [patch] } });
    assert.equal(out.ok, false, `a point with no usable ${missing} went through`);
    assert.match(out.error, new RegExp(missing === "form" ? "form" : missing));
    assert.equal(sheet.latestFurthest(db.getTask(C, id).sheet), null, "nothing was written");
  }
});

test("it is append-only: getting further adds a point and the newest is the one offered", async () => {
  const { id } = await startJob();
  await call("task_update", { task_id: id, sheet: { furthest: [{ ...POINT, form: "partial", what: "three places found", one_action: "pick one", where: null }] } });
  await call("task_update", { task_id: id, sheet: { furthest: [POINT] } });

  const s = sheet.parseSheet(db.getTask(C, id).sheet);
  assert.equal(s.furthest.length, 2, "the earlier point is still on the record");
  assert.equal(sheet.latestFurthest(s).what, POINT.what, "the newest is what gets handed back");
  const view = sheet.sheetView(s);
  assert.equal(view.furthest_point.what, POINT.what);
  assert.match(view.furthest_note, /superseded/);
});

test("a link that does not open is refused as a hand-back, because tapping it is how they find out", async () => {
  const { id } = await startJob();
  const out = await call("task_update", { task_id: id, sheet: { furthest: [POINT] } }, { lookup: dead });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "handed_back_a_dead_link");
  assert.match(out.error, /leave 'where' off/);
  assert.equal(sheet.latestFurthest(db.getTask(C, id).sheet), null, "nothing was written, not even the part that was true");

  // Without the link, the same hand-back goes through: the words are still worth having.
  const { where, ...noLink } = POINT;
  const ok = await call("task_update", { task_id: id, sheet: { furthest: [noLink] } }, { lookup: dead });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(sheet.latestFurthest(db.getTask(C, id).sheet).where, null);
});

// ---------- the refusal of a bare failure ----------

test("progress is what EXISTS, not what was attempted", () => {
  assert.deepEqual(progressOn({}), [], "a fresh job has produced nothing");
  // Three dead ends and a question they never answered: still nothing to hand over.
  assert.deepEqual(progressOn({
    routes: [{ tried: "opentable", failed_because: "blocks automated browsers" }, { tried: "resy", failed_because: "no slots" }],
    needs: { question: "friday or saturday?", tradeoff: "friday is busier" },
    left: ["try calling them"],
  }), []);
  // An option with the page it is on is a thing that exists.
  assert.match(progressOn({ options: [{ id: "a", label: "Carbone", where: "https://example.com/a" }] })[0], /1 option/);
  assert.match(progressOn({ prices: [{ what: "table", amount: "$25", where: "https://example.com/p" }] })[0], /1 price/);
  assert.match(progressOn({ decisions: [{ what: "friday it is" }] })[0], /1 decision/);
  assert.match(progressOn({}, { made: ["a page you made for them"] })[0], /a page you made/);
  // A rejected option is ground covered, not a thing to hand back.
  assert.deepEqual(progressOn({ options: [{ id: "a", label: "Lilia", where: "https://example.com/a", status: "rejected", rejected_because: { words: "too far", reading: "location" } }] }), []);
});

test("the ledger rows that left something behind are the ones that count", () => {
  assert.deepEqual(madeFrom([{ action: "message_send" }, { action: "browser_open" }]), [],
    "a text that went out is not a furthest point — it happened");
  assert.deepEqual(madeFrom([{ action: "page_create" }, { action: "page_update" }]), ["a page you made for them"],
    "four edits to one page is one page");
  assert.deepEqual(madeFrom([{ action: "gmail_draft" }]), ["a draft sitting in their Gmail"]);
});

test("a job that got somewhere cannot be closed 'failed' with none of it handed over", async () => {
  const { id } = await startJob();
  await call("task_update", {
    task_id: id,
    sheet: { options: [{ id: "carbone", label: "Carbone 8pm", where: "https://example.com/carbone" }] },
  });

  const bare = await call("task_finish", { task_id: id, state: "failed", outcome: "couldn't get it booked" });
  assert.equal(bare.ok, false);
  assert.equal(bare.blocked, "no_furthest_point");
  assert.match(bare.error, /1 option/);
  assert.match(bare.error, /sheet\.furthest/, "the refusal names the one call that clears it");
  assert.equal(db.getTask(C, id).open, true, "and the job is still open, so nothing was quietly half-closed");

  // One call clears it, and then the honest close goes through — carrying the hand-back.
  await call("task_update", { task_id: id, sheet: { furthest: [POINT] } });
  const closed = await call("task_finish", { task_id: id, state: "failed", outcome: "form's filled, needs your tap" });
  assert.equal(closed.ok, true, closed.error);
  assert.equal(closed.handed_back.one_action, "press 'Confirm reservation'");
  assert.match(closed.note, /LEAD the message/);
});

test("a job that produced nothing is refused nothing: the bare failure IS the honest close", async () => {
  const { id } = await startJob();
  await call("task_update", {
    task_id: id,
    sheet: { routes: [{ tried: "the site", failed_because: "it refuses automated browsers" }] },
  });
  const out = await call("task_finish", { task_id: id, state: "failed", outcome: "the site blocks me and there's no other route" });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.handed_back, undefined);
});

test("'blocked' needs the hand-back too, and the state and the point can go in one call", async () => {
  const { id } = await startJob();
  await call("task_update", { task_id: id, sheet: { prices: [{ what: "the hold", amount: "$25 a head", where: "https://example.com/hold" }] } });

  const bare = await call("task_update", {
    task_id: id, state: "blocked",
    sheet: { blocked: { what: "can't press confirm", unblock: "a yes from you" } },
  });
  assert.equal(bare.ok, false);
  assert.equal(bare.blocked, "no_furthest_point");
  assert.equal(db.getTask(C, id).state, "running", "the state did not move either");

  const together = await call("task_update", {
    task_id: id, state: "blocked",
    sheet: { blocked: { what: "can't press confirm", unblock: "a yes from you" }, furthest: [POINT] },
  });
  assert.equal(together.ok, true, together.error);
  assert.equal(db.getTask(C, id).state, "blocked");
});

test("'cancelled' and 'done' are not touched by any of this", async () => {
  const { id } = await startJob();
  await call("task_update", { task_id: id, sheet: { stakes: "low", options: [{ id: "a", label: "Carbone", where: "https://example.com/a" }] } });
  const off = await call("task_finish", { task_id: id, state: "cancelled", outcome: "called off" });
  assert.equal(off.ok, true, off.error);

  const second = await startJob({ title: "find a price" });
  await call("task_update", { task_id: second.id, sheet: { stakes: "low", options: [{ id: "a", label: "Carbone", where: "https://example.com/a" }] } });
  const done = await call("task_finish", { task_id: second.id, state: "done", outcome: "booked it" });
  assert.equal(done.ok, true, done.error);
});

// ---------- what a stopped walk leaves behind ----------

test("filled is read off the page's own values, and a credential is never written down", () => {
  const filled = filledFrom([
    { ref: "e1", tag: "input", type: "text", name: "Name on the reservation", value: "Omari" },
    { ref: "e2", tag: "input", type: "tel", name: "Mobile number", value: "555-0100" },
    { ref: "e3", tag: "textarea", name: "Anything we should know?" },
    { ref: "e4", tag: "button", name: "Confirm reservation" },
    { ref: "e5", tag: "input", type: "password", name: "Password", value: "hunter2" },
    { ref: "e6", tag: "input", type: "text", name: "Card number", value: "4111 1111 1111 1111" },
    { ref: "e7", tag: "select", name: "Party size", value: "4" },
  ]);
  assert.deepEqual(filled.map(f => f.field), ["Name on the reservation", "Mobile number", "Card number", "Party size"]);
  assert.equal(filled[0].value, "Omari");
  assert.equal(filled.find(f => f.field === "Card number").value, "(filled in — not written down)",
    "that the box is filled is the useful part; the digits are not");
  assert.ok(!filled.some(f => f.field === "Password"), "a password box is never a row");
  assert.ok(!filled.some(f => f.field === "Anything we should know?"), "an empty box is not filled in");
});

test("a link is handed back as the page it is, never as the form it is not", () => {
  const front = shareable("https://tablesmith.example/", []);
  assert.equal(front.shareable, false, "the site's front page is not where it got to");

  const typed = shareable("https://tablesmith.example/reserve?place=carbone&time=8:00%20PM", [{ field: "Name", value: "Omari" }]);
  assert.equal(typed.shareable, true);
  assert.deepEqual(typed.carries, [], "a name typed into a box is in the DOM, not in the address");
  assert.match(typed.why, /NOT in it/);

  const carried = shareable("https://tablesmith.example/reserve?place=carbone", [{ field: "place", value: "carbone" }]);
  assert.deepEqual(carried.carries, ["place"]);
  assert.match(carried.why, /carries everything/);

  assert.equal(shareable("about:blank").shareable, false);
  assert.equal(shareable("file:///etc/passwd").shareable, false);
});

test("a walk with nothing filled and no real address is not a hand-back", () => {
  assert.equal(fromWalk({ url: "about:blank", elements: [] }), null);
  const saved = fromWalk({ url: "https://tablesmith.example/search?q=italian", elements: [], stopped: "site_refused", because: "it would not load the next page" });
  assert.equal(saved.form, "saved_state", "a browser on the right page with nothing filled is still worth saying");
  assert.equal(saved.filled.length, 0);
});

test("the walk that stops at the commit writes down the real URL and the real filled fields", async () => {
  const { id } = await startJob();
  const snap = await call("browser_open", { url: `${site.url}/search?q=italian&date=2026-10-09&party=4` });
  const slot = snap.elements.find(e => e.tag === "a" && e.name === "8:00 PM" && /carbone/.test(e.href));
  const form = await call("browser_click", { ref: slot.ref });
  await call("browser_type", { ref: form.elements.find(e => /Name on the reservation/i.test(e.name)).ref, text: "Omari" });
  let now = await call("browser_read", {});
  await call("browser_type", { ref: now.elements.find(e => /Mobile number/i.test(e.name)).ref, text: "555-0100" });
  now = await call("browser_read", {});

  const refused = await call("browser_click", { ref: now.elements.find(e => e.tag === "button" && /Confirm reservation/i.test(e.name)).ref });
  assert.equal(refused.blocked, "commit_needs_gate", "the gate still holds — that is the point");
  assert.equal(site.bookings.length, 0);

  // And the work up to it is written down, by code, on the one open job.
  assert.equal(refused.written_on_task, id);
  const point = sheet.latestFurthest(db.getTask(C, id).sheet);
  assert.equal(point.form, "filled_form");
  assert.equal(point.stopped, "needed_a_yes");
  assert.match(point.where, /\/reserve\?/, "the address the browser really reached");
  assert.equal(point.where_known, "browser_reached");
  assert.equal(point.one_action, "press 'Confirm reservation'", "the page's own label for its last button");
  const fields = point.filled.filter(f => /name|mobile/i.test(f.field));
  assert.equal(fields.length, 2, `the two fields it filled: ${JSON.stringify(point.filled)}`);
  assert.ok(fields.some(f => f.value === "Omari"));
  assert.ok(fields.some(f => f.value === "555-0100"));

  // The model is told what the link does and does NOT carry.
  assert.match(refused.furthest_note, /NOT in it/);
});

test("with two jobs open, code does not guess which one the walk belongs to", async () => {
  await startJob();
  await startJob({ title: "find a flight", goal: "cheapest to accra" });
  const snap = await call("browser_open", { url: `${site.url}/reserve?place=carbone&time=8:00%20PM&date=2026-10-09&party=4` });
  await call("browser_type", { ref: snap.elements.find(e => /Name on the reservation/i.test(e.name)).ref, text: "Omari" });
  const now = await call("browser_read", {});
  const refused = await call("browser_click", { ref: now.elements.find(e => e.tag === "button" && /Confirm reservation/i.test(e.name)).ref });

  assert.equal(refused.written_on_task, undefined, "a filled checkout on the wrong errand is worse than one on none");
  assert.equal(refused.furthest.form, "filled_form", "it still comes back, so the model can record it");
  assert.match(refused.furthest_note, /NOTHING has written this down/);
  for (const t of db.listTasks(C)) assert.equal(sheet.latestFurthest(t.sheet), null);
});

test("asking for the yes is itself a stopped walk, and it is written down there too", async () => {
  const { id } = await startJob();
  const snap = await call("browser_open", { url: `${site.url}/reserve?place=carbone&time=8:00%20PM&date=2026-10-09&party=4` });
  await call("browser_type", { ref: snap.elements.find(e => /Name on the reservation/i.test(e.name)).ref, text: "Omari" });

  const ask = await call("confirm_request", {
    action: "browser_submit", task_id: id, stakes: "money",
    target: "Carbone friday 8pm, party of 4",
    summary: "Book Carbone for 4 on Fri Oct 9 at 8:00 PM under Omari. $25 per person hold.",
  });
  assert.ok(ask.confirmation_id, ask.error);
  assert.equal(ask.written_on_task, id, "the ordinary route to the last button records it too");
  const point = sheet.latestFurthest(db.getTask(C, id).sheet);
  assert.equal(point.stopped, "needed_a_yes");
  assert.match(point.where, /\/reserve\?/);
  assert.match(ask.furthest_note, /not lost if they never answer/);
});

test("a submit stopped by a spending limit hands back the filled checkout, not just a refusal", async () => {
  // Through the site fixtures rather than the booking one, because the limit guards only run on the
  // sites in src/sites.js — and `siteHosts` is the documented hook that says this fixture IS amazon.
  const fx = await startSiteFixtures();
  const asAmazon = { siteHosts: { [fx.host]: "amazon" } };
  try {
    fx.setTotal("amazon", 240);
    db.setSpendCaps(C, { perPurchaseCents: 100_000, monthlyCents: 500_000, said: "up to $1000 a go" });
    // The install's own daily net, which a yes does not lift: his limits are fine with $240 and
    // this machine's day is not, so the walk stops with the checkout filled in and the button
    // unpressed. That is the shape under test — a limit, not a dead end.
    const wasCap = config.maxSpendPerDay;
    config.maxSpendPerDay = 100;
    const { id } = await startJob({ title: "order the monitor", goal: "the one he picked, delivered" });

    const home = await call("browser_open", { url: `${fx.url}/amazon` }, asAmazon);
    const typed = await call("browser_type", { ref: home.elements.find(e => e.tag === "input" && e.type === "text").ref, text: "monitor" }, asAmazon);
    const found = await call("browser_click", { ref: typed.elements.find(e => /search/i.test(e.name)).ref }, asAmazon);
    const picked = await call("browser_click", { ref: found.elements.find(e => e.tag === "a" && /second/i.test(e.name)).ref }, asAmazon);
    const named = await call("browser_type", { ref: picked.elements.find(e => e.tag === "input" && /name/i.test(e.name)).ref, text: "Omari" }, asAmazon);
    const commit = named.elements.find(e => e.name === COMMIT_LABELS.amazon);

    const what = "the monitor he picked, $240.00 all in";
    const req = await call("confirm_request", { action: "browser_submit", task_id: id, stakes: "both", target: what, summary: `Order ${what}` }, asAmazon);
    messages.push(owner("yeah go on"));
    const rec = await call("confirm_record", { confirmation_id: req.confirmation_id }, asAmazon);
    assert.equal(rec.state, "granted", JSON.stringify(rec));
    const out = await call("browser_submit", { ref: commit.ref, what, confirmation_id: req.confirmation_id }, asAmazon);

    assert.equal(out.ok, false);
    config.maxSpendPerDay = wasCap;
    assert.equal(out.blocked, "over_daily_cap", JSON.stringify(out).slice(0, 300));
    assert.equal(fx.orders.length, 0, "nothing was ordered");
    // The guard still holds AND the work is handed back, which is the whole point: a limit
    // stopping a purchase should leave him a filled checkout, not a sentence about a limit.
    assert.equal(out.written_on_task, id);
    const point = latestOn(id);
    assert.equal(point.stopped, "cap_hit");
    assert.equal(point.form, "filled_form");
    assert.match(point.one_action, new RegExp(COMMIT_LABELS.amazon, "i"));
    assert.ok(point.filled.some(f => f.value === "Omari"), JSON.stringify(point.filled));
  } finally {
    await browser.closeBrowser(C);
    await fx.close();
  }
});

// ---------- the open-work page ----------

test("the open page shows the furthest point on a stuck job, with the link as a link", () => {
  const stuck = {
    id: 1, title: "book carbone", state: "blocked", open: true, log: [],
    sheet: {
      ...sheet.emptySheet(),
      blocked: { what: "can't press the last button", unblock: "a yes from you", at: 1 },
      furthest: [{ ...POINT, where_known: "browser_reached", at: 2 }],
    },
  };
  const { blocks, headline } = activityBlocks({ tasks: [stuck], now: Date.now() });
  assert.match(headline, /1 stuck/);
  assert.match(blocks[0].detail, /one step left/i, "the top line says there is something they can do");

  const timeline = blocks.find(b => b.type === "timeline");
  const step = timeline.items.find(i => i.label === POINT.what);
  assert.ok(step, `the furthest point is a step: ${JSON.stringify(timeline.items)}`);
  assert.match(step.note, /one thing left: press 'Confirm reservation'/);
  assert.match(step.note, /already filled: Name on the reservation, Mobile number/);

  const links = blocks.find(b => b.type === "links");
  assert.ok(links, "the link is a link, because a URL in a note is not a tap");
  assert.equal(links.items[0].url, POINT.where);
  assert.equal(links.items[0].label, POINT.one_action);
});

test("a stuck job with nothing to hand back points at no page at all", () => {
  const stuck = {
    id: 1, title: "book carbone", state: "blocked", open: true, log: [],
    sheet: { ...sheet.emptySheet(), blocked: { what: "the site blocks me", unblock: "another site", at: 1 } },
  };
  const { blocks } = activityBlocks({ tasks: [stuck], now: Date.now() });
  assert.equal(blocks.find(b => b.type === "links"), undefined);
  assert.match(blocks[0].detail ?? "", /^Nothing here needs/);
});

test("a hand-back on a job that is still running is not shown as something for them to do", () => {
  const going = {
    id: 1, title: "book carbone", state: "running", open: true, log: [],
    sheet: { ...sheet.emptySheet(), furthest: [{ ...POINT, at: 2 }] },
  };
  const { blocks } = activityBlocks({ tasks: [going], now: Date.now() });
  assert.equal(blocks.find(b => b.type === "links"), undefined, "it is still working on it; the point is not the answer yet");
});

// ---------- the rule reaches both backends ----------

test("the sheet with the furthest point on it goes to the model, on both backends", () => {
  // Both build their prompt from `systemFor` in src/agent.js, so the rule lands once — and both
  // have to be the ones reading the open sheets, which is what carries the point itself. Asserted
  // against the source the way test/whatsnew.test.js does it: the claude-cli backend is what the
  // live Reason runs on, and a rule only the API path carried would be a rule nobody ever got.
  const system = readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
  assert.match(system, /hand back the furthest point you got to/, "the rule is in the one system prompt");
  assert.match(system, /Never a plain "couldn't do it"/);
  assert.match(system, /sheet\.furthest/);
  for (const file of ["../src/agent.js", "../src/backends/claude-cli.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /systemFor\(/, `${file} must build its prompt from the shared system text`);
    assert.match(src, /openWorkNote\(/, `${file} must put the open sheets — and so the furthest point — in front of the model`);
  }
});

test("the refusal and the record are code's, not a prompt's", () => {
  const src = readFileSync(new URL("../src/furthest.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /import .*agent\.js/, "nothing here depends on what the model was told");
  // The gate is a function of rows, so it cannot be talked out of.
  const sheetWithWork = { options: [{ id: "a", label: "Carbone", where: "https://example.com/a" }] };
  assert.ok(handBackNeeded({ sheet: sheetWithWork, closing: "failed" }), "work and no hand-back is refused");
  assert.equal(handBackNeeded({ sheet: sheetWithWork, closing: "failed", made: [] }).blocked, "no_furthest_point");
  assert.equal(handBackNeeded({ sheet: { ...sheetWithWork, furthest: [{ ...POINT, at: 1 }] }, closing: "failed" }), null);
  assert.equal(handBackNeeded({ sheet: {}, closing: "failed" }), null);
});
