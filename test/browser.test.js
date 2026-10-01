// The body, without the model: drive the fixture booking site through the tools and prove
// the gate holds at the last click. No API key needed. Nothing live is ever touched.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBookingSite } from "./fixture-booking.js";

const dir = mkdtempSync(join(tmpdir(), "reason-browser-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const browser = await import("../src/browser.js");
const { clock } = await import("../src/config.js");
const { readableText } = await import("../src/weblookup.js");

const C = "dm:browser";
const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });
let site;
let messages;

before(async () => { site = await startBookingSite(); });
after(async () => {
  await browser.closeAllBrowsers();
  await site.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clock.reset();
  messages = [owner("book me a table")];
  db.db.exec("DELETE FROM action_ledger; DELETE FROM confirmations;");
  site.bookings.length = 0; // so "how many reservations exist" means "this test made them"
});

// What the owner's reply means is the judge's call, and these tests are about the browser tools
// and the gate's bookkeeping, so the verdict is stated outright. See flow-gate.test.js for the
// judge reading real sentences.
const readsYes = async () => ({ verdict: "yes" });
const call = (name, input) => runTool(name, input, { conversationId: C, messages, judge: readsYes });
const ref = (snap, pred) => snap.elements.find(pred)?.ref;

test("readableText strips markup and keeps the words", () => {
  const r = readableText("<html><head><title>Hi &amp; bye</title><style>p{}</style></head><body><p>one</p><script>x</script><p>two</p></body></html>");
  assert.equal(r.title, "Hi & bye");
  assert.match(r.text, /one/);
  assert.match(r.text, /two/);
  assert.doesNotMatch(r.text, /x|p\{\}/);
});

test("web_lookup reads the fixture page and leaves a receipt", async () => {
  const out = await call("web_lookup", { url: site.url });
  assert.equal(out.ok, true);
  assert.equal(out.title, "Tablesmith — find a table");
  assert.match(out.text, /Find a table in New York/);
  const led = db.listActions(C);
  assert.equal(led.length, 1);
  assert.equal(led[0].outcome, "ok");
  assert.match(led[0].receipt, /^Read http/);
});

test("web_lookup refuses a non-URL and a non-http scheme", async () => {
  assert.equal((await call("web_lookup", { url: "carbone" })).ok, false);
  assert.equal((await call("web_lookup", { url: "file:///etc/passwd" })).ok, false);
});

test("browser_open returns a snapshot with refs, and leaves a receipt", async () => {
  const out = await call("browser_open", { url: site.url });
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.match(out.text, /Tablesmith/);
  assert.ok(out.elements.length >= 4, "the form's fields and button are all in the snapshot");
  const q = out.elements.find(e => /Restaurant, cuisine/i.test(e.name));
  assert.ok(q, "inputs are described by their label, not by CSS");
  assert.equal(q.type, "text");
  assert.ok(out.elements.some(e => e.tag === "select" && e.options?.includes("4")), "a select shows its options");
  assert.match(db.listActions(C)[0].receipt, /^Opened http/);
});

test("the full booking loop stops dead at the last click without a yes", async () => {
  // search
  let snap = await call("browser_open", { url: site.url });
  await call("browser_type", { ref: ref(snap, e => /Restaurant, cuisine/i.test(e.name)), text: "italian" });
  snap = await call("browser_read", {});
  await call("browser_type", { ref: ref(snap, e => /^Date/i.test(e.name)), text: "2026-10-09" });
  snap = await call("browser_read", {});
  await call("browser_type", { ref: ref(snap, e => e.tag === "select"), text: "4" });
  snap = await call("browser_read", {});
  const results = await call("browser_click", { ref: ref(snap, e => e.tag === "button" && /Search/i.test(e.name)) });
  assert.equal(results.ok, true);
  assert.match(results.text, /Carbone/);
  assert.match(results.text, /Party of 4/);

  // pick a time
  const slot = results.elements.find(e => e.tag === "a" && e.name === "8:00 PM" && /carbone/.test(e.href));
  assert.ok(slot, "time slots are clickable");
  const form = await call("browser_click", { ref: slot.ref });
  assert.equal(form.ok, true);
  assert.match(form.text, /Carbone/);
  assert.match(form.text, /8:00 PM/);

  // fill the form
  await call("browser_type", { ref: ref(form, e => /Name on the reservation/i.test(e.name)), text: "Omari" });
  snap = await call("browser_read", {});
  await call("browser_type", { ref: ref(snap, e => /Mobile number/i.test(e.name)), text: "555-0100" });
  snap = await call("browser_read", {});

  // the commit button: browser_click will not press it
  const commit = ref(snap, e => e.tag === "button" && /Confirm reservation/i.test(e.name));
  assert.ok(commit);
  const refused = await call("browser_click", { ref: commit });
  assert.equal(refused.ok, false);
  assert.equal(refused.blocked, "commit_needs_gate");
  assert.equal(site.bookings.length, 0, "NOTHING was booked");
  assert.ok(db.listActions(C).some(a => a.action === "browser_click" && a.outcome === "blocked"), "the refusal is on the record");

  // browser_submit with no confirmation at all: also refused
  const noYes = await call("browser_submit", { ref: commit, what: "Carbone, party of 4, Oct 9 at 8:00 PM" });
  assert.equal(noYes.blocked, "needs_confirmation");
  assert.equal(site.bookings.length, 0, "still nothing booked");

  // the model cannot self-authorize in the same turn
  const req = await call("confirm_request", { action: "browser_submit", summary: "Book Carbone, party of 4, Thu Oct 9 at 8:00 PM under Omari, 555-0100. $25/person cancellation hold.", stakes: "both" });
  const early = await call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal(early.state, "waiting_for_yes");
  assert.equal((await call("browser_submit", { ref: commit, what: "Carbone" })).blocked, "needs_confirmation");
  assert.equal(site.bookings.length, 0);

  // a real yes from the owner
  messages.push(owner("yes book it"));
  const granted = await call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal(granted.state, "granted");
  assert.equal(granted.quote, "yes book it");

  const done = await call("browser_submit", {
    ref: commit, what: "Carbone, party of 4, Thu Oct 9 at 8:00 PM under Omari",
    confirmation_id: req.confirmation_id,
  });
  assert.equal(done.ok, true);
  assert.equal(site.bookings.length, 1, "exactly one reservation, made only after the yes");
  const b = site.bookings[0];
  assert.equal(b.place_name, "Carbone");
  assert.equal(b.time, "8:00 PM");
  assert.equal(b.party, "4");
  assert.equal(b.name, "Omari");
  assert.match(done.page_text, new RegExp(b.code), "the real confirmation code came back from the site");

  // the receipt
  const row = db.listActions(C).find(a => a.action === "browser_submit" && a.outcome === "ok");
  assert.ok(row, "the commit is in the ledger");
  assert.equal(row.confirmation_id, req.confirmation_id, "the receipt names the yes that authorized it");
  assert.match(row.receipt, /Carbone/);
  assert.ok(db.getConfirmation(C, req.confirmation_id).consumed_at, "the yes is spent, so it cannot book twice");

  // and it cannot book twice on that yes
  const twice = await call("browser_submit", { ref: commit, what: "Carbone again", confirmation_id: req.confirmation_id });
  assert.equal(twice.blocked, "already_spent");
  assert.equal(site.bookings.length, 1, "still exactly one reservation");
});

// The yes buys one real action, and a submit that pressed nothing is not one. Getting this
// backwards silently loses the booking: the owner says go, a bad ref presses nothing, and the
// honest retry is refused as already_spent, so nothing is ever booked and nobody is told why.
test("a submit that pressed nothing does not burn the yes", async () => {
  let snap = await call("browser_open", {
    url: `${site.url}/reserve?place=carbone&time=8%3A00%20PM&date=2026-10-09&party=4`,
  });
  await call("browser_type", { ref: ref(snap, e => /Name on the reservation/i.test(e.name)), text: "Omari" });
  snap = await call("browser_read", {});
  await call("browser_type", { ref: ref(snap, e => /Mobile number/i.test(e.name)), text: "555-0100" });
  snap = await call("browser_read", {});
  const commit = ref(snap, e => e.tag === "button" && /Confirm reservation/i.test(e.name));

  const req = await call("confirm_request", { action: "browser_submit", summary: "Book Carbone, party of 4, Oct 9 at 8:00 PM", stakes: "both" });
  messages.push(owner("yeah do it"));
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id })).state, "granted");

  // A ref from an older snapshot: the button is never found, so nothing is pressed.
  const missed = await call("browser_submit", { ref: "e99", what: "Carbone, party of 4", confirmation_id: req.confirmation_id });
  assert.equal(missed.ok, false);
  assert.equal(site.bookings.length, 0, "nothing was booked");
  assert.equal(db.getConfirmation(C, req.confirmation_id).consumed_at, null, "the yes was not spent on a click that never happened");
  assert.match(missed.error, /browser_read/, "it says how to recover");

  // So the same yes still covers the retry, and the booking actually lands.
  const done = await call("browser_submit", { ref: commit, what: "Carbone, party of 4, Oct 9 at 8:00 PM", confirmation_id: req.confirmation_id });
  assert.equal(done.ok, true);
  assert.equal(site.bookings.length, 1, "exactly one reservation, on the one yes");
  assert.ok(db.getConfirmation(C, req.confirmation_id).consumed_at, "now it is spent");

  // And it is spent for good: the retry that worked cannot be replayed.
  assert.equal((await call("browser_submit", { ref: commit, what: "Carbone again", confirmation_id: req.confirmation_id })).blocked, "already_spent");
  assert.equal(site.bookings.length, 1, "still exactly one reservation");
});

test("a stale ref is reported, not clicked blindly", async () => {
  await call("browser_open", { url: site.url });
  const out = await call("browser_click", { ref: "e999" });
  assert.equal(out.ok, false);
  assert.match(out.error, /browser_read/);
});

test("screenshot writes a real file", async () => {
  await call("browser_open", { url: site.url });
  const out = await call("browser_screenshot", {});
  assert.equal(out.ok, true);
  assert.ok(existsSync(out.path), "the PNG is on disk");
});

test("browser_close closes it and says so", async () => {
  await call("browser_open", { url: site.url });
  const out = await call("browser_close", {});
  assert.equal(out.ok, true);
  assert.equal(out.closed, true);
  assert.equal((await call("browser_close", {})).closed, false);
});
