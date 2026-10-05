// Real-site errands: the registry, the commit labels, and the two guards that stand between a
// request and a charge.
//
// Four things have to be true, and each one is a way the previous version could have lost money:
//
//   1. **Browsing and filling in a form are free.** Searching, picking an option and typing a name
//      commit nothing, so they must not need a yes. A guard that asked for one here would spend
//      the owner's approval before the button that matters ever appeared.
//   2. **The commit is gated, in the site's own words.** "Place your order" and "Request ride" are
//      what DoorDash and Uber call it, and neither matches the generic word list. These assert the
//      site labels from `src/sites.js` are really wired into the click guard.
//   3. **The yes has to name the total.** A page showing $58.40 and an approval that mentions no
//      money is not an approval for $58.40. Nothing is pressed.
//   4. **A total that moved voids the yes.** The gate already compares the approved details against
//      what is being submitted, and these prove that holds when the number is what changed.
//
// Plus the daily cap, which is the thing a per-action gate cannot do: twenty approvals in one
// afternoon are twenty honest yeses and one bill nobody agreed to.
//
// The fixture pages are local. No real site is touched, and nothing is ever bought anywhere.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSiteFixtures, COMMIT_LABELS } from "./fixture-sites.js";

const dir = mkdtempSync(join(tmpdir(), "reason-sites-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool, clickCommits } = await import("../src/tools.js");
const sites = await import("../src/sites.js");
const trust = await import("../src/trust.js");
const browser = await import("../src/browser.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = "dm:owner";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });

let fx;
let messages;
const readsYes = async () => ({ verdict: "yes" });

/** `siteHosts` is the documented test hook: treat the fixture's host as this real site. */
const call = (name, input, site = null) => runTool(name, input, {
  conversationId: C, messages, judge: readsYes,
  ...(site ? { siteHosts: { [fx.host]: site } } : {}),
});
const ref = (snap, pred) => snap.elements.find(pred)?.ref;

before(async () => { fx = await startSiteFixtures(); });
after(async () => {
  await browser.closeAllBrowsers();
  await fx.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clock.reset();
  messages = [owner("sort this out for me")];
  db.db.exec("DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM spend; DELETE FROM connected_accounts;");
  fx.orders.length = 0;
  for (const s of Object.keys(COMMIT_LABELS)) fx.setTotal(s, 58.4);
  config.maxSpendPerDay = 300;
});

/** Ask and get a yes for exactly these details. */
async function approve(what) {
  const req = await call("confirm_request", { action: "browser_submit", summary: `Going to commit: ${what}`, stakes: "both", target: what });
  messages.push(owner("yeah go on"));
  const rec = await call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal(rec.state, "granted", JSON.stringify(rec));
  return req.confirmation_id;
}

/** Walk a fixture site to its checkout page and return the snapshot plus the commit ref. */
async function toCheckout(site) {
  const home = await call("browser_open", { url: `${fx.url}/${site}` }, site);
  assert.equal(home.ok, true, JSON.stringify(home).slice(0, 300));
  const typed = await call("browser_type", { ref: ref(home, e => e.tag === "input" && e.type === "text"), text: "something" }, site);
  assert.equal(typed.ok, true, "typing into a search box commits nothing");
  const searched = await call("browser_click", { ref: ref(typed, e => /search/i.test(e.name)), expect: "see results" }, site);
  assert.equal(searched.ok, true, "pressing Search commits nothing");
  const picked = await call("browser_click", { ref: ref(searched, e => e.tag === "a" && /second/i.test(e.name)), expect: "open the checkout" }, site);
  assert.equal(picked.ok, true, "picking an option commits nothing");
  const named = await call("browser_type", { ref: ref(picked, e => e.tag === "input" && /name/i.test(e.name)), text: "Omari" }, site);
  const phoned = await call("browser_type", { ref: ref(named, e => e.tag === "input" && /mobile/i.test(e.name)), text: "+12025551234" }, site);
  assert.equal(phoned.ok, true, "filling a form commits nothing");
  return { snap: phoned, commit: ref(phoned, e => e.name === COMMIT_LABELS[site]) };
}

// ---------- the registry ----------

test("every site in the registry answers the questions an errand needs answered", () => {
  assert.equal(sites.SITES.length, 10);
  for (const s of sites.SITES) {
    assert.ok(s.entry.startsWith("https://"), `${s.site} needs somewhere to start`);
    assert.ok(s.signin_url.startsWith("https://"), `${s.site} needs a sign-in page`);
    assert.ok(["always", "to_commit", "never"].includes(s.needs_signin), `${s.site} needs_signin`);
    assert.ok(s.commit_labels.length, `${s.site} must say what its commit button is called`);
    assert.ok(s.limits.length, `${s.site} must say what is known to be hard about it`);
    assert.ok(s.signed_in.when_out.length, `${s.site} needs a way to recognise a signed-out page`);
    // The honest asymmetry: nobody could load a signed-in page on these sites, so `when_in` is
    // empty and signed-in is inferred. A guessed marker here is how a probe reports a stranger as
    // signed in, so the test pins that nobody has guessed one.
    assert.deepEqual(s.signed_in.when_in, [], `${s.site} must not claim a signed-in marker nobody has seen`);
  }
});

test("a URL maps to its site, and an unrelated one maps to nothing", () => {
  assert.equal(sites.siteFor("https://www.amazon.com/gp/cart").site, "amazon");
  assert.equal(sites.siteFor("https://m.uber.com/looking").site, "uber");
  assert.equal(sites.siteFor("https://smile.amazon.com/x").site, "amazon", "a subdomain is the same site");
  assert.equal(sites.siteFor("https://example.com"), null);
  assert.equal(sites.siteFor("not a url"), null);
  // Not fooled by a lookalike host: endsWith has to be on a dot boundary.
  assert.equal(sites.siteFor("https://notamazon.com/x"), null);
});

test("the probe's verdicts are recorded per site and nothing claims to work that does not", () => {
  for (const s of sites.SITES) {
    const r = trust.SITE_REACHABLE[s.site];
    assert.ok(r, `${s.site} needs a probe verdict`);
    assert.equal(typeof r.loads, "boolean");
    assert.ok(r.why, `${s.site} should say what happened`);
  }
  // Six of the ten refuse an automated browser. That is the finding, and the playbook has to say
  // so rather than letting somebody be promised an errand that cannot start.
  const blocked = sites.SITES.filter(s => !trust.SITE_REACHABLE[s.site].loads).map(s => s.site);
  assert.deepEqual(blocked.sort(), ["delta", "doordash", "opentable", "ticketmaster", "uber_eats", "united"]);
});

test("site_playbook says a blocked site cannot be used, in those words", async () => {
  const out = await call("site_playbook", { site: "doordash" });
  assert.equal(out.ok, true);
  assert.equal(out.playbook.site_loads, false);
  assert.match(out.playbook.cannot_be_used, /refuses Reason's browser/i);
  assert.match(out.playbook.cannot_be_used, /the site blocks it — not that Reason is broken/i);

  const fine = await call("site_playbook", { site: "amazon" });
  assert.equal(fine.playbook.site_loads, true);
  assert.equal(fine.playbook.cannot_be_used, undefined);
  assert.deepEqual(fine.playbook.commits_are_called, ["place your order", "place order", "buy now", "submit my order"]);
});

// ---------- the commit labels ----------

test("every site's commit label is recognised as a commit, from the element alone", () => {
  for (const [site, label] of Object.entries(COMMIT_LABELS)) {
    const verdict = clickCommits({ tag: "button", type: "submit", name: label, href: "", inForm: true, isSubmit: true });
    assert.equal(verdict.commits, true, `"${label}" on ${site} must be treated as a commit`);
    assert.ok(verdict.why, "and it must say why");
  }
});

test("'Place your order' is caught, which the generic word list missed", () => {
  // `place (the )?order` does not match "place YOUR order". This is the bug the site registry was
  // written for, so it gets its own test rather than hiding inside the loop above.
  assert.equal(clickCommits({ tag: "button", type: "submit", name: "Place your order", href: "", inForm: true, isSubmit: true }).commits, true);
  assert.equal(clickCommits({ tag: "button", type: "button", name: "Request ride", href: "", inForm: false, isSubmit: false }).commits, true);
  assert.equal(clickCommits({ tag: "button", type: "button", name: "Buy tickets", href: "", inForm: false, isSubmit: false }).commits, true);
});

test("a link is still a link, even one labelled the way a listing labels them", () => {
  // The rule that makes browsing free. Gating "Get tickets" on a Fandango listing would spend the
  // owner's yes opening a showtimes page, and there would be none left for the checkout.
  const link = (name) => clickCommits({ tag: "a", type: "", name, href: "https://www.fandango.com/x", inForm: false, isSubmit: false });
  assert.equal(link("Get tickets").commits, false);
  assert.equal(link("Reserve a table").commits, false);
  assert.equal(link("7:40 PM").commits, false);
  // Except money on tap, which is the one thing a GET cannot be trusted with.
  assert.equal(link("Buy now with 1-Click").commits, true);
});

test("ordinary buttons on these sites are still free", () => {
  for (const name of ["Add a note", "Next", "Filters", "See more times", "Add to cart", "Sign in"]) {
    assert.equal(clickCommits({ tag: "button", type: "button", name, href: "", inForm: false, isSubmit: false }).commits, false, `"${name}" commits nothing`);
  }
});

// ---------- the flow, end to end ----------

test("browsing and filling in a form is free; the commit is refused without a yes", async () => {
  const { commit } = await toCheckout("doordash");
  assert.ok(commit, "the commit button should be on the page");

  // Nothing has been gated so far, so no confirmation was spent getting here.
  assert.equal(db.pendingConfirmations(C).length, 0);

  const pressed = await call("browser_click", { ref: commit, expect: "place the order" }, "doordash");
  assert.equal(pressed.ok, false);
  assert.equal(pressed.blocked, "commit_needs_gate");
  assert.match(pressed.why, /place your order/i);
  assert.equal(fx.orders.length, 0, "nothing was ordered");

  const noYes = await call("browser_submit", { ref: commit, what: "DoorDash, the second one, $58.40" }, "doordash");
  assert.equal(noYes.blocked, "needs_confirmation");
  assert.equal(fx.orders.length, 0);
});

test("with a yes that names the total, the commit goes through and leaves a receipt", async () => {
  const { commit } = await toCheckout("doordash");
  const what = "DoorDash, the second one, total $58.40";
  const id = await approve(what);

  const done = await call("browser_submit", { ref: commit, what, confirmation_id: id }, "doordash");
  assert.equal(done.ok, true, JSON.stringify(done).slice(0, 400));
  assert.equal(fx.orders.length, 1);
  assert.equal(fx.orders[0].site, "doordash");
  assert.match(done.page_text, /All set/);
  assert.equal(done.counted_against_today, "$58.40");
  assert.equal(done.spent_today, "$58.40");

  const row = db.listActions(C).find(a => a.action === "browser_submit" && a.outcome === "ok");
  assert.match(row.receipt, /total \$58\.40/);
  assert.match(row.receipt, /Place your order/);
});

test("a yes with no amount on it will not commit on a page that shows a price", async () => {
  const { commit } = await toCheckout("amazon");
  const what = "Amazon, the second one"; // no money anywhere in it
  const id = await approve(what);

  const out = await call("browser_submit", { ref: commit, what, confirmation_id: id }, "amazon");
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "total_not_in_the_yes");
  assert.equal(out.page_shows, "$58.40");
  assert.match(out.error, /name no amount at all/i);
  assert.match(out.error, /confirm_request again/);
  assert.equal(fx.orders.length, 0, "nothing was bought");
  // Nothing happened, so the yes is not burned — but it cannot be used for this either.
  assert.equal(db.getConfirmation(C, id).consumed_at, null);
});

test("a yes that is only a number will not commit: the receipt has to say what the money was for", async () => {
  const { commit } = await toCheckout("amazon");
  const id = await approve("$58.40");
  const out = await call("browser_submit", { ref: commit, what: "$58.40", confirmation_id: id }, "amazon");
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "yes_says_only_a_number");
  assert.match(out.error, /what the money was for/i);
  assert.equal(fx.orders.length, 0);
});

test("a total that moved after the yes voids it, and nothing is pressed", async () => {
  const { commit } = await toCheckout("fandango");
  const id = await approve("Fandango, 2 tickets, total $58.40");

  // The site reprices while the owner is answering — fees, a surge, a seat that was not held. The
  // page has to be loaded again for that to show up, which is also what a real flow does: you go
  // back, or the site refreshes the quote before taking payment.
  fx.setTotal("fandango", 71.9);
  const fresh = await call("browser_open", { url: `${fx.url}/fandango/checkout?pick=second` }, "fandango");
  assert.match(fresh.text, /Total \$71\.90/, "the page really is showing the new number");
  await call("browser_type", { ref: ref(fresh, e => e.tag === "input" && /name/i.test(e.name)), text: "Omari" }, "fandango");
  const refilled = await call("browser_read", {}, "fandango");
  await call("browser_type", { ref: ref(refilled, e => e.tag === "input" && /mobile/i.test(e.name)), text: "+12025551234" }, "fandango");
  const ready = await call("browser_read", {}, "fandango");
  const freshCommit = ref(ready, e => e.name === COMMIT_LABELS.fandango);

  // The honest submit, carrying the new number, does not match the yes on record.
  const out = await call("browser_submit", { ref: freshCommit, what: "Fandango, 2 tickets, total $71.90", confirmation_id: id }, "fandango");
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "wrong_target");
  assert.match(out.error, /exact details/i);
  assert.equal(fx.orders.length, 0, "the new price was never charged");

  // Asking again for the real number works.
  const id2 = await approve("Fandango, 2 tickets, total $71.90");
  const again = await call("browser_submit", { ref: freshCommit, what: "Fandango, 2 tickets, total $71.90", confirmation_id: id2 }, "fandango");
  assert.equal(again.ok, true, JSON.stringify(again).slice(0, 300));
  assert.equal(fx.orders.length, 1);
  assert.equal(fx.orders[0].total, "71.90");
});

test("the summary the owner was shown is on the receipt, with the total in it", async () => {
  const { commit } = await toCheckout("ticketmaster");
  const what = "Ticketmaster, 2 tickets to the second one, total $58.40";
  const id = await approve(what);
  await call("browser_submit", { ref: commit, what, confirmation_id: id }, "ticketmaster");

  const row = db.listActions(C).find(a => a.action === "browser_submit" && a.outcome === "ok");
  assert.match(row.receipt, /\$58\.40/, "the receipt names the money");
  assert.match(row.receipt, /2 tickets/, "and what it was for");
  const conf = db.getConfirmation(C, id);
  assert.match(conf.summary, /\$58\.40/, "and so did the thing they said yes to");
  assert.ok(conf.consumed_at, "the yes is spent");
});

// ---------- the daily cap ----------

test("a commit over the day's limit is refused before it happens, with the real numbers", async () => {
  config.maxSpendPerDay = 60;
  const { commit } = await toCheckout("amazon");
  const what = "Amazon, a desk chair, total $58.40";
  const id = await approve(what);
  const first = await call("browser_submit", { ref: commit, what, confirmation_id: id }, "amazon");
  assert.equal(first.ok, true);
  assert.equal(first.left_today, "$1.60");

  // A second one, honestly approved, that does not fit.
  const back = await call("browser_open", { url: `${fx.url}/amazon/checkout?pick=third` }, "amazon");
  const commit2 = ref(back, e => e.name === COMMIT_LABELS.amazon);
  const what2 = "Amazon, a lamp, total $58.40";
  const id2 = await approve(what2);
  const out = await call("browser_submit", { ref: commit2, what: what2, confirmation_id: id2 }, "amazon");

  assert.equal(out.ok, false);
  assert.equal(out.blocked, "over_daily_cap");
  assert.match(out.error, /\$58\.40 and the day's limit is \$60\.00/);
  assert.match(out.error, /\$58\.40 is already committed/);
  assert.match(out.error, /\$1\.60 left/);
  assert.match(out.error, /Nothing was committed/);
  assert.match(out.error, /REASON_MAX_SPEND_PER_DAY/);
  assert.equal(fx.orders.length, 1, "only the first one happened");
});

test("the cap counts what really went through, not what was approved and refused", async () => {
  config.maxSpendPerDay = 60;
  const { commit } = await toCheckout("amazon");
  const what = "Amazon, a desk chair, total $58.40";
  // Approved but the submit fails on a stale ref: nothing happened, so nothing is counted.
  const id = await approve(what);
  const missed = await call("browser_submit", { ref: "e999", what, confirmation_id: id }, "amazon");
  assert.equal(missed.ok, false);
  assert.equal(trust.spendToday(C).spent_cents, 0, "a submit that pressed nothing cost nothing");

  const done = await call("browser_submit", { ref: commit, what, confirmation_id: id }, "amazon");
  assert.equal(done.ok, true, "and the yes survived, because nothing had happened");
  assert.equal(trust.spendToday(C).spent_cents, 5840);
});

test("spend_today reads off the table and shows every line", async () => {
  const { commit } = await toCheckout("fandango");
  const what = "Fandango, 2 tickets, total $58.40";
  const id = await approve(what);
  await call("browser_submit", { ref: commit, what, confirmation_id: id }, "fandango");

  const out = await call("spend_today", {});
  assert.equal(out.ok, true);
  assert.equal(out.spent, "$58.40");
  assert.equal(out.commits, 1);
  assert.equal(out.cap, "$300.00");
  assert.equal(out.left, "$241.60");
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].site, "fandango");
  assert.match(out.lines[0].what, /2 tickets/);
  // And it says what it cannot see, rather than reading as a complete account of the day.
  assert.match(out.counted_from, /named no amount is not in this total/);
});

test("with the cap turned off, the per-action yes is the only thing left, and capabilities says so", async () => {
  config.maxSpendPerDay = 0;
  const { capabilitiesNow } = await import("../src/tools.js");
  const cap = capabilitiesNow({ conversationId: C }).find(c => c.name === "spending_cap");
  assert.equal(cap.status, "off");
  assert.match(cap.what, /no daily spending limit/i);
  assert.match(cap.what, /only the per-action yes/i);

  // And a big commit goes through on a yes alone, which is exactly what "off" means.
  const { commit } = await toCheckout("amazon");
  const what = "Amazon, a very expensive thing, total $58.40";
  const id = await approve(what);
  assert.equal((await call("browser_submit", { ref: commit, what, confirmation_id: id }, "amazon")).ok, true);
});

// ---------- a site Reason was not told about ----------

test("off the registry, an ordinary form submit is unchanged: no total is demanded", async () => {
  // The guards above are scoped to the registry sites on purpose. Plenty of ordinary forms have no
  // price on them at all, and demanding one everywhere would break every errand that is not
  // shopping. Same page, no site mapping: the commit is still gated, but the yes needs no money.
  const home = await call("browser_open", { url: `${fx.url}/amazon/checkout?pick=first` });
  const commit = ref(home, e => e.name === COMMIT_LABELS.amazon);
  await call("browser_type", { ref: ref(home, e => e.tag === "input" && /name/i.test(e.name)), text: "Omari" });
  const typed = await call("browser_read", {});
  const commit2 = ref(typed, e => e.name === COMMIT_LABELS.amazon);
  await call("browser_type", { ref: ref(typed, e => e.tag === "input" && /mobile/i.test(e.name)), text: "+12025551234" });

  const what = "the form on that page"; // no amount at all
  const id = await approve(what);
  const out = await call("browser_submit", { ref: commit2 ?? commit, what, confirmation_id: id });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(out.counted_against_today, undefined, "and nothing is counted against the cap");
});

// ---------- the uber deep link ----------

test("the uber link is the shape Uber documents, and says what it does not know", async () => {
  const out = await call("uber_link", { address: "Coit Tower, 1 Telegraph Hill Blvd" });
  assert.equal(out.ok, true);
  const u = new URL(out.url);
  assert.equal(u.origin + u.pathname, "https://m.uber.com/looking");
  const drop = JSON.parse(u.searchParams.get("drop[0]"));
  assert.equal(drop.addressLine1, "Coit Tower, 1 Telegraph Hill Blvd");
  assert.equal(drop.latitude, undefined);
  assert.match(out.note, /may not resolve it to the right place without coordinates/i);
  assert.match(out.note, /Nothing is requested until they tap Request/);

  const precise = await call("uber_link", { address: "Coit Tower", latitude: 37.802374, longitude: -122.405818 });
  const drop2 = JSON.parse(new URL(precise.url).searchParams.get("drop[0]"));
  assert.equal(drop2.latitude, 37.802374);
  assert.equal(drop2.longitude, -122.405818);
  assert.equal(precise.has_coordinates, true);
  assert.match(precise.note, /Nothing is requested and nothing is charged/);

  assert.equal((await call("uber_link", { address: "   " })).ok, false);
});

test("the deep link does not pretend to be a booking", async () => {
  const out = await call("uber_link", { address: "JFK Terminal 4" });
  // The whole value of this is that Reason stops one step short. If the result read as "ride
  // booked", the model would say so and nobody would be in a car.
  assert.doesNotMatch(JSON.stringify(out), /booked|requested the ride|on its way/i);
  assert.match(out.note, /they tap Request/);
});
