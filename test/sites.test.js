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
// This suite's fixtures live on 127.0.0.1; outside a test, nothing may fetch there (src/netguard.js).
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1";
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool, clickCommits } = await import("../src/tools.js");
const { grantsViaYes } = await import("./fixture-grant.js");
// Saving a permission waits for their yes now (src/tools.js permission_grant): granted through the real flow.
const viaYes = grantsViaYes(runTool);
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

/** No geocoder on the network in tests: known addresses only, everything else unplaceable. */
const GEO = {
  "430 W 17th St, New York, NY": { lat: 40.7433148, lng: -74.0053556 },
  "3247 Bruner Ave, Bronx, NY": { lat: 40.8759189, lng: -73.8401355 },
};
const geocode = async (q) => GEO[q] ?? null;

/** `siteHosts` is the documented test hook: treat the fixture's host as this real site. */
// permission_grant and caps_set rest on the owner's own words (src/trust.js ownerSaid): here the owner
// is taken to have just typed the sentence the tool is given, which is what these tests are about.
const saidIt = (name, input, messages) => (name === "permission_grant" || name === "caps_set") && input?.text
  ? [...messages, { role: "user", content: `[Wed, Sep 30, 2026, 2:59 PM] Omari: ${input.text}` }] : messages;
const call = (name, input, site = null) => viaYes(name, input, {
  conversationId: C, messages: saidIt(name, input, messages), judge: readsYes, geocode,
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
  db.db.exec("DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM spend; DELETE FROM connected_accounts; DELETE FROM permissions; DELETE FROM spend_caps; DELETE FROM unknown_outcomes;");
  fx.orders.length = 0;
  for (const s of Object.keys(COMMIT_LABELS)) fx.setTotal(s, 58.4);
  config.maxSpendPerDay = 300;
  // Limits a person set, the way somebody who has used Reason before has. Everything in this file is
  // about what happens AFTER that; the first-time question is `test/trustline.test.js`.
  db.setSpendCaps(C, { perPurchaseCents: 100_00, monthlyCents: 1_000_00, said: "up to $100 a go, $1000 a month" });
});

/**
 * Ask and get a yes for exactly these details.
 *
 * `stakes` says money only when the details really name a figure. An ask that claims money and
 * names none is refused now, and rightly: that is the one tool that commits money, saying money is
 * involved, leaving somebody to say yes to an amount nobody ever stated.
 */
async function approve(what) {
  const namesAFigure = /\$\s?\d/.test(what);
  const req = await call("confirm_request", {
    action: "browser_submit", summary: `Going to commit: ${what}`,
    stakes: namesAFigure ? "both" : "third_party", target: what,
  });
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
  assert.equal(sites.SITES.length, 9);
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
  assert.match(out.error, /\$58\.40 and their daily limit is \$60\.00 \(the default here\)/);
  assert.match(out.error, /\$58\.40 is already committed/);
  assert.match(out.error, /\$1\.60 left/);
  assert.match(out.error, /Nothing was committed/);
  // 2026-10-31: the person hears their limit and how to change it, never an env var.
  assert.match(out.say, /^Your daily limit is \$60 and this would take you to \$116\.80\. You can raise it in Settings → Shopping, or tell me a new limit\.$/);
  assert.doesNotMatch(out.error, /REASON_MAX_SPEND_PER_DAY/);
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

test("with every limit off, the per-action yes is the only thing left, and capabilities says so", async () => {
  // Both have to be off for that sentence to be true, and they are two different things: the daily
  // total the operator set for the install, and the two numbers this person set for themselves.
  config.maxSpendPerDay = 0;
  db.db.exec("DELETE FROM spend_caps");
  const { capabilitiesNow } = await import("../src/tools.js");
  const none = capabilitiesNow({ conversationId: C }).find(c => c.name === "spending_cap");
  assert.equal(none.status, "off");
  assert.match(none.what, /has not set a spending limit yet/i);
  assert.match(none.what, /no daily limit on this install/i);
  assert.match(none.what, /per-action yes/i);

  // With the install's cap still off but limits of their own, something does still stand in the way,
  // and it says whose numbers they are rather than naming one nobody set.
  db.setSpendCaps(C, { perPurchaseCents: 100_00, monthlyCents: 1_000_00 });
  const theirs = capabilitiesNow({ conversationId: C }).find(c => c.name === "spending_cap");
  assert.equal(theirs.status, "live");
  assert.match(theirs.what, /\$100\.00 on one thing/);
  assert.match(theirs.what, /\$1,?000\.00 in a calendar month/);

  // And a commit inside their limits goes through on a yes alone, which is what "no daily cap" means.
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

/** One end of a ride link, read the way Uber's web booking page reads it: a JSON place. */
function endOf(url, key) {
  const v = new URL(url).searchParams.get(key);
  if (v === null) return null;
  const o = JSON.parse(v);
  return { latitude: o.latitude, longitude: o.longitude, addressLine1: o.addressLine1, raw: v };
}
const pickupOf = (url) => endOf(url, "pickup") ?? {};
const dropOf = (url) => endOf(url, "drop[0]");

test("the uber link is the shape Uber documents, and says what it does not know", async () => {
  const out = await call("uber_link", { address: "Coit Tower, 1 Telegraph Hill Blvd" });
  assert.equal(out.ok, true);
  const u = new URL(out.url);
  assert.equal(u.origin + u.pathname, "https://m.uber.com/go/looking");
  const drop = dropOf(out.url);
  assert.equal(drop.addressLine1, "Coit Tower, 1 Telegraph Hill Blvd");
  assert.equal(drop.latitude, undefined);
  assert.match(out.note, /may not resolve it to the right place without coordinates/i);
  assert.match(out.note, /until they tap Request/);

  const precise = await call("uber_link", { address: "Coit Tower", latitude: 37.802374, longitude: -122.405818 });
  const drop2 = dropOf(precise.url);
  assert.equal(drop2.latitude, 37.802374);
  assert.equal(drop2.longitude, -122.405818);
  assert.equal(precise.has_coordinates, true);
  assert.match(precise.note, /Nothing is requested and nothing is charged/);

  assert.equal((await call("uber_link", { address: "   " })).ok, false);
});

// ---------- a ride is the link, every time (2026-10-23) ----------
// The regression: the playbook sent the model to uber_connect first, a sign-in Uber refuses to let
// book a ride for anybody it has not listed. Nobody had ever connected. A ride is the link.

test("a ride request is uber_link with their pickup, and needs no Uber connection at all", async () => {
  // Nothing about Uber is set up: no client id, no token for anybody.
  const saved = { id: config.uberClientId, secret: config.uberClientSecret };
  config.uberClientId = ""; config.uberClientSecret = "";
  try {
    const out = await call("uber_link", { pickup_latitude: 40.8569, pickup_longitude: -73.8312, pickup_address: "3247 Bruner Ave, Bronx", address: "430 W 17th St, New York" });
    assert.equal(out.ok, true);
    const u = new URL(out.url);
    const pickup = pickupOf(out.url);
    assert.equal(pickup.latitude, 40.8569);
    assert.equal(pickup.longitude, -73.8312);
    assert.equal(dropOf(out.url).addressLine1, "430 W 17th St, New York");
    assert.equal(out.has_pickup, true);
    // A pickup alone is a ride too: "get me an uber" with no destination.
    const bare = await call("uber_link", { pickup_latitude: 40.8569, pickup_longitude: -73.8312 });
    assert.equal(bare.ok, true);
    assert.equal(dropOf(bare.url), null);
    // Without a pickup it still works, and tells the model to go and get one.
    const noPickup = await call("uber_link", { address: "JFK Terminal 4" });
    assert.match(noPickup.next, /get_location/);
  } finally { config.uberClientId = saved.id; config.uberClientSecret = saved.secret; }
});

test("uber_connect is refused for a ride, and every place the model reads says a ride is uber_link first", async () => {
  const refused = await call("uber_connect", {});
  assert.equal(refused.ok, false);
  assert.equal(refused.blocked, "not_for_rides");
  assert.match(refused.error, /uber_link/);
  const { tools } = await import("../src/tools.js");
  assert.match(tools.find(t => t.name === "uber_link").description, /^THE way to get anybody a ride, every time/);
  assert.match(tools.find(t => t.name === "uber_link").description, /get_location/);
  assert.match(tools.find(t => t.name === "uber_connect").description, /^NOT for getting a ride/);
  const pb = await call("site_playbook", { site: "uber" });
  assert.match(pb.playbook.ride_access.means, /uber_link, every time/);
  const { SYSTEM } = await import("../src/agent.js");
  assert.match(SYSTEM, /A ride, every time: .* uber_link .* Never uber_connect for a ride/);
});

test("what Reason already knows comes before a question: a saved home is handed back and becomes the pickup", async () => {
  db.db.prepare("DELETE FROM saved_places WHERE conversation_id = ?").run(C);
  db.savePlace(C, { name: "home", address: "3247 Bruner Ave, Bronx, NY", lat: 40.8569, lng: -73.8312 });
  try {
    // No live share and no pin: the saved places come back instead of "you do not know".
    const loc = await runTool("get_location", { action: "auto" }, { conversationId: C });
    assert.equal(loc.source, "saved_places");
    assert.equal(loc.saved_places[0].name, "home");
    assert.equal(loc.saved_places[0].latitude, 40.8569);
    assert.match(loc.note, /say which you used/);
    // "home" as the pickup carries home's coordinates, so the car comes to the pin, and NYC gets the offer.
    const link = await runTool("uber_link", { pickup_address: "home", address: "430 W 17th St" }, { conversationId: C });
    const pickup = pickupOf(link.url);
    assert.equal(pickup.latitude, 40.8569);
    assert.equal(pickup.addressLine1, "3247 Bruner Ave, Bronx, NY");
    assert.ok(link.also_offer);
  } finally {
    db.db.prepare("DELETE FROM saved_places WHERE conversation_id = ?").run(C);
  }
});

test("addresses alone get real coordinates on both ends — Omari's first real ride link had none", async () => {
  // The exact call from 2026-10-23: work to home, both from what Reason remembered, no saved place.
  const out = await call("uber_link", { pickup_address: "430 W 17th St, New York, NY", address: "3247 Bruner Ave, Bronx, NY" });
  const u = new URL(out.url);
  const pickup = pickupOf(out.url);
  const drop = dropOf(out.url);
  assert.equal(pickup.latitude, 40.7433148);
  assert.equal(pickup.longitude, -74.0053556);
  assert.equal(pickup.addressLine1, "430 W 17th St, New York, NY");
  assert.equal(drop.latitude, 40.8759189);
  assert.equal(drop.longitude, -73.8401355);
  assert.equal(out.has_coordinates, true);
  assert.ok(out.also_offer, "a geocoded NYC pickup gets the car-service offer too");
  assert.match(out.note, /booking page in their browser/);
});

test("a saved place's own pin beats geocoding, matched by name or by its address", async () => {
  db.db.prepare("DELETE FROM saved_places WHERE conversation_id = ?").run(C);
  db.savePlace(C, { name: "work", address: "430 W 17th St, New York", lat: 40.7, lng: -74.0 });
  try {
    for (const pickup_address of ["work", "430 W 17th St, New York, NY"]) {
      const out = await call("uber_link", { pickup_address, address: "3247 Bruner Ave, Bronx, NY" });
      const pickup = pickupOf(out.url);
      assert.equal(pickup.latitude, 40.7, pickup_address);
      assert.equal(pickup.longitude, -74.0);
    }
  } finally {
    db.db.prepare("DELETE FROM saved_places WHERE conversation_id = ?").run(C);
  }
});

test("the link is Uber's web booking page, which fills the trip in — the app ignores pre-fills", async () => {
  // 2026-10-23, Omari's taps: every app-bound link (JSON or setPickup keys, /looking or /ul/)
  // opened the Uber app empty on his iPhone; the JSON link on the web page filled in on his Mac.
  // m.uber.com claims /looking and /ul for the app; /go/looking is not claimed, so it stays in
  // the browser on the page that reads the trip.
  const saved = config.uberClientId;
  config.uberClientId = "test-client";
  try {
    const out = await call("uber_link", { pickup_address: "430 W 17th St, New York, NY", address: "3247 Bruner Ave, Bronx, NY" });
    const u = new URL(out.url);
    assert.equal(u.origin + u.pathname, "https://m.uber.com/go/looking", "a path the app does not claim");
    assert.equal(u.searchParams.get("client_id"), "test-client");
    assert.deepEqual(JSON.parse(u.searchParams.get("pickup")), { latitude: 40.7433148, longitude: -74.0053556, addressLine1: "430 W 17th St, New York, NY" });
    assert.deepEqual(JSON.parse(u.searchParams.get("drop[0]")), { addressLine1: "3247 Bruner Ave, Bronx, NY", latitude: 40.8759189, longitude: -73.8401355 });
    assert.equal(u.searchParams.get("action"), null, "no app keys");
    assert.doesNotMatch(out.url, /\+/, "spaces as %20, not +");
    assert.match(out.note, /booking page in their browser/);
    // The app shape is still there for comparison, and nothing uses it by default.
    const app = sites.uberRideLink({ pickup_latitude: 1, pickup_longitude: 2, address: "x", format: "app" });
    assert.equal(new URL(app.url).searchParams.get("action"), "setPickup");
  } finally { config.uberClientId = saved; }
});

test("a tap-to-act link is sent again, never pointed at — in the prompt and on uber_link", async () => {
  // 2026-10-23: "same one as earlier, the link I sent at 2:42 still works", with no link in it.
  const { SYSTEM } = await import("../src/agent.js");
  assert.match(SYSTEM, /THE EXCEPTION is anything they tap to act on/);
  assert.match(SYSTEM, /never say an earlier one "still works"/);
  assert.match(SYSTEM, /Call the tool that made it again/);
  const { tools } = await import("../src/tools.js");
  assert.match(tools.find(t => t.name === "uber_link").description, /A second ask for a ride is a fresh call to this and a fresh link in the reply/);
});

test("an address nothing can place keeps its words and says so", async () => {
  const out = await call("uber_link", { pickup_address: "the usual spot", address: "nowhere known" });
  assert.equal(pickupOf(out.url).latitude, undefined);
  assert.equal(pickupOf(out.url).latitude, undefined);
  assert.equal(out.has_coordinates, false);
  assert.match(out.note, /No pickup point could be set/);
});

test("a place they said in the conversation is a pickup on its own, no coordinates needed", async () => {
  const out = await call("uber_link", { pickup_address: "Chelsea Market, 75 9th Ave", address: "JFK Terminal 4" });
  assert.equal(out.ok, true);
  assert.equal(out.has_pickup, true);
  assert.equal(pickupOf(out.url).addressLine1, "Chelsea Market, 75 9th Ave", "no geocode for it in tests, so the words go");
  assert.match(out.note, /say which address you meant/);
  assert.equal(out.next, undefined);
});

test("the ride rule puts what is known before asking, everywhere the model reads it", async () => {
  const { tools } = await import("../src/tools.js");
  assert.match(tools.find(t => t.name === "uber_link").description, /without asking anything you can already tell/);
  const { SYSTEM } = await import("../src/agent.js");
  assert.match(SYSTEM, /the pickup from what you already know/);
});

test("in New York the link comes with a car service to call, by a verified number; elsewhere nothing is offered", async () => {
  const nyc = await call("uber_link", { pickup_latitude: 40.8569, pickup_longitude: -73.8312 });
  const { CAR_SERVICES, isKnownCarService } = await import("../src/rides.js");
  assert.ok(nyc.also_offer, "a pickup in the city gets the offer");
  for (const s of nyc.also_offer.car_services) {
    assert.ok(isKnownCarService(s.phone), `${s.phone} is one of the verified numbers`);
    assert.ok(CAR_SERVICES.find(c => c.phone === s.phone).verified, "with where it was read");
  }
  assert.match(nyc.also_offer.say, /call_place/);
  const sf = await call("uber_link", { pickup_latitude: 37.7749, pickup_longitude: -122.4194 });
  assert.equal(sf.also_offer, undefined, "no number Reason has not verified is ever offered");
  const none = await call("uber_link", { address: "JFK Terminal 4" });
  assert.equal(none.also_offer, undefined);
});

test("the deep link does not pretend to be a booking", async () => {
  const out = await call("uber_link", { address: "JFK Terminal 4" });
  // The whole value of this is that Reason stops one step short. If the result read as "ride
  // booked", the model would say so and nobody would be in a car.
  assert.doesNotMatch(JSON.stringify(out), /booked|requested the ride|on its way/i);
  assert.match(out.note, /they tap Request/);
});

// ---------- a standing permission, on the one path that really spends money ----------
//
// The confirm gate and the standing permissions are the same gate: these are here rather than in
// test/trustline.test.js because this is the only place a real page with a real total is involved,
// and the number on the page is the one that would be charged.

test("a reorder they said to do without asking goes through with no yes, and the receipt says why", async () => {
  await call("permission_grant", {
    text: "you can reorder groceries without asking",
    scope: { action: "purchases", target: "groceries", max_amount: 80 },
  });

  const { commit } = await toCheckout("amazon");
  const what = "Amazon, the usual groceries, total $58.40";
  const out = await call("browser_submit", { ref: commit, what }, "amazon");

  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(fx.orders.length, 1, "it really went through");
  assert.equal(out.under_permission.said, "you can reorder groceries without asking");
  assert.equal(db.pendingConfirmations(C).length, 0, "nobody was asked anything");

  const row = db.listActions(C).find(a => a.action === "browser_submit" && a.outcome === "ok");
  assert.match(row.receipt, /No yes was asked for — under: "you can reorder groceries without asking"/);
  assert.equal(row.confirmation_id, null);
  // And it is counted against the day exactly as an approved commit is.
  assert.equal(trust.spendToday(C).spent_cents, 5840);
});

test("a purchase bigger than they said is refused at the gate, with what they HAD said quoted", async () => {
  await call("permission_grant", {
    text: "you can spend up to $40 on groceries without asking",
    scope: { action: "purchases", target: "groceries", max_amount: 40 },
  });

  const { commit } = await toCheckout("amazon");
  const what = "Amazon, the usual groceries, total $58.40";
  const out = await call("browser_submit", { ref: commit, what }, "amazon");

  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(fx.orders.length, 0, "nothing was bought");
  assert.match(out.error, /you can spend up to \$40 on groceries without asking/);
  assert.match(out.error, /tops out at \$40\.00 and this is \$58\.40/);
  assert.equal(trust.spendToday(C).spent_cents, 0);
});

test("a permission is checked against the total on the PAGE, not only the one in the details", async () => {
  await call("permission_grant", {
    text: "you can spend up to $40 on groceries without asking",
    scope: { action: "purchases", target: "groceries", max_amount: 40 },
  });
  // The details say $35 and the shop says $90. The details are what the permission's ceiling was
  // compared against at the gate; the page is what would actually be charged.
  fx.setTotal("amazon", 90);
  const { commit } = await toCheckout("amazon");
  const out = await call("browser_submit", { ref: commit, what: "Amazon, the usual groceries, total $35.00" }, "amazon");

  assert.equal(out.ok, false);
  assert.equal(out.blocked, "over_the_permission");
  assert.equal(fx.orders.length, 0, "nothing was pressed");
  assert.equal(out.page_shows, "$90.00");
  assert.match(out.error, /only goes up to \$40\.00/);
  assert.match(out.error, /a yes for this one does not raise it/);
});

test("a different kind of purchase is not covered by the grocery permission", async () => {
  await call("permission_grant", {
    text: "you can reorder groceries without asking",
    scope: { action: "purchases", target: "groceries", max_amount: 80 },
  });
  const { commit } = await toCheckout("amazon");
  const out = await call("browser_submit", { ref: commit, what: "Amazon, a desk chair, total $58.40" }, "amazon");
  assert.equal(out.blocked, "needs_confirmation");
  assert.match(out.error, /it covers 'groceries'/);
  assert.equal(fx.orders.length, 0);
});

test("a permission with no amount on it cannot be saved, so it can never authorize a charge", async () => {
  // The guard is at the grant, which is the honest place for it: a permission saved without a number
  // would look like permission and never once apply, and they would be told "ok, I won't ask".
  const out = await call("permission_grant", { text: "just order the groceries yourself", scope: { action: "purchases", target: "groceries" } });
  assert.equal(out.blocked, "needs_an_amount");
  const { commit } = await toCheckout("amazon");
  const sub = await call("browser_submit", { ref: commit, what: "Amazon, the usual groceries, total $58.40" }, "amazon");
  assert.equal(sub.blocked, "needs_confirmation");
  assert.equal(fx.orders.length, 0);
});

// ---------- the limits the person set ----------

test("the first thing that would ever spend money asks for their two numbers once", async () => {
  db.db.exec("DELETE FROM spend_caps");
  const { commit } = await toCheckout("amazon");
  const what = "Amazon, a desk chair, total $58.40";
  const id = await approve(what);

  const asked = await call("browser_submit", { ref: commit, what, confirmation_id: id }, "amazon");
  assert.equal(asked.blocked, "needs_caps");
  assert.equal(fx.orders.length, 0, "nothing was bought while the question was open");
  assert.match(asked.ask, /most i should ever spend on one thing/i);
  assert.match(asked.ask, /max per month/i);
  assert.match(asked.error, /do not suggest numbers/i);

  // They answer, and the same purchase goes straight through on the yes they already gave.
  const set = await call("caps_set", { per_purchase: 200, monthly: 1500, text: "$200 a thing, $1500 a month" });
  assert.equal(set.ok, true, JSON.stringify(set));
  const done = await call("browser_submit", { ref: commit, what, confirmation_id: id }, "amazon");
  assert.equal(done.ok, true, JSON.stringify(done).slice(0, 300));
  assert.equal(fx.orders.length, 1);
});

test("over the per-purchase limit it asks, even for something they said not to ask about", async () => {
  db.setSpendCaps(C, { perPurchaseCents: 2_000, monthlyCents: 100_000 });
  await call("permission_grant", {
    text: "you can reorder groceries without asking",
    scope: { action: "purchases", target: "groceries", max_amount: 200 },
  });
  const { commit } = await toCheckout("amazon");
  const what = "Amazon, the usual groceries, total $58.40";

  // The permission covers it. Their own per-purchase limit does not, and that wins.
  const out = await call("browser_submit", { ref: commit, what }, "amazon");
  assert.equal(out.blocked, "over_per_purchase");
  assert.equal(fx.orders.length, 0);
  assert.match(out.error, /never to spend more than \$20\.00 on one thing/);
  assert.match(out.error, /a yes for this one does not raise the limit/);

  // With a yes for this one it goes through, and the limit is untouched afterwards.
  const id = await approve(what);
  const done = await call("browser_submit", { ref: commit, what, confirmation_id: id }, "amazon");
  assert.equal(done.ok, true, JSON.stringify(done).slice(0, 300));
  assert.equal(db.getSpendCaps(C).per_purchase_cents, 2_000, "a yes did not raise the cap");
});

test("a purchase that would cross the month asks, and the month is counted per calendar month", async () => {
  db.setSpendCaps(C, { perPurchaseCents: 100_00, monthlyCents: 70_00 });
  await call("permission_grant", {
    text: "you can reorder groceries without asking",
    scope: { action: "purchases", target: "groceries", max_amount: 200 },
  });
  // $58.40 already committed this month.
  trust.noteSpend({ conversationId: C, cents: 5840, what: "groceries, earlier this month", site: "amazon" });

  const { commit } = await toCheckout("amazon");
  const what = "Amazon, the usual groceries, total $58.40";
  const out = await call("browser_submit", { ref: commit, what }, "amazon");
  assert.equal(out.blocked, "over_monthly");
  assert.equal(fx.orders.length, 0);
  assert.match(out.error, /\$58\.40 of Omari's \$70\.00/);
  assert.match(out.error, /does not raise the monthly limit/);

  // Next month is a clean sheet, with no yes needed, because the permission covers it again.
  clock.skip(40 * 24 * 60 * 60 * 1000);
  const next = await call("browser_submit", { ref: commit, what }, "amazon");
  assert.equal(next.ok, true, JSON.stringify(next).slice(0, 300));
  assert.equal(next.under_permission.said, "you can reorder groceries without asking");
});

test("caps_show reads off the table, and says plainly when they have set none", async () => {
  db.db.exec("DELETE FROM spend_caps");
  const none = await call("caps_show", {});
  assert.equal(none.has_limits, false);
  assert.match(none.note, /has not set per-purchase or monthly limits/);
  assert.doesNotMatch(none.note, /\$\d/, "it must not name a number nobody set");
  assert.ok(none.today?.cap, "the daily limit, which is real, rides along");

  await call("caps_set", { per_purchase: 200, monthly: 1500, text: "raise my limit to $200 a thing, $1500 a month" });
  trust.noteSpend({ conversationId: C, cents: 5840, what: "a chair", site: "amazon" });
  const shown = await call("caps_show", {});
  assert.equal(shown.per_purchase, "$200.00");
  assert.equal(shown.monthly, "$1500.00");
  assert.equal(shown.spent_this_month, "$58.40");
  assert.equal(shown.left_this_month, "$1441.60");
  assert.equal(shown.they_said, "raise my limit to $200 a thing, $1500 a month", "their own words are on the record");
});

test("limits the wrong way round are not saved", async () => {
  const out = await call("caps_set", { per_purchase: 500, monthly: 100 });
  assert.equal(out.ok, false);
  assert.match(out.error, /more than \$100\.00 for the whole month/);
  assert.equal(db.getSpendCaps(C).per_purchase_cents, 100_00, "the old ones are untouched");
});

test("one sentence can set a permission and the limits together", async () => {
  db.db.exec("DELETE FROM spend_caps");
  const out = await call("permission_grant", {
    text: "you can spend up to $40 on lunch without asking, and never more than $300 a month",
    scope: { action: "purchases", target: "lunch", max_amount: 40 },
    caps: { per_purchase: 40, monthly: 300 },
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.caps.per_purchase, "$40.00");
  assert.equal(out.caps.monthly, "$300.00");
  assert.equal(db.getSpendCaps(C).said, "you can spend up to $40 on lunch without asking, and never more than $300 a month");
});

// ---------- a commit whose outcome nobody knows ----------

test("a press that broke mid-commit is recorded unknown and is NOT tried again on its own", async () => {
  // Its own fixture shop, because the way to make a press genuinely ambiguous is to take the shop
  // away between the press and the answer — exactly what a dropped connection does on a real one.
  const gone = await startSiteFixtures();
  gone.setTotal("amazon", 58.4);
  const there = (name, input) => runTool(name, input, {
    conversationId: C, messages, judge: readsYes, siteHosts: { [gone.host]: "amazon" },
  });

  const page = await there("browser_open", { url: `${gone.url}/amazon/checkout?pick=second` });
  assert.equal(page.ok, true);
  const named = await there("browser_type", { ref: ref(page, e => e.tag === "input" && /name/i.test(e.name)), text: "Omari" });
  const filled = await there("browser_type", { ref: ref(named, e => e.tag === "input" && /mobile/i.test(e.name)), text: "+12025551234" });
  const commit = ref(filled, e => e.name === COMMIT_LABELS.amazon);

  const what = "Amazon, a desk chair, total $58.40";
  const id = await approve(what);
  await gone.close(); // the shop is unreachable from the instant the button is pressed

  const out = await there("browser_submit", { ref: commit, what, confirmation_id: id });
  assert.equal(out.ok, false, JSON.stringify(out).slice(0, 300));
  assert.equal(out.blocked, "outcome_unknown", JSON.stringify(out).slice(0, 300));
  assert.match(out.error, /NOBODY KNOWS whether that went through/);
  assert.match(out.error, /charged twice/);

  // It is `unknown` on the ledger, which is not the same row as a failure.
  const row = db.listActions(C).find(a => a.action === "browser_submit");
  assert.equal(row.outcome, "unknown");
  assert.match(row.receipt, /OUTCOME UNKNOWN/);
  assert.match(row.receipt, /Not retried/);

  // The same action again, with the yes that was already spent on it: refused, and nothing pressed.
  const again = await there("browser_submit", { ref: commit, what, confirmation_id: id });
  assert.equal(again.blocked, "outcome_unknown");
  assert.match(again.error, /It is not being retried/);
  assert.equal(db.listUnknownOutcomes(C).length, 1, "still open");

  // And a standing permission does not count as them saying to try again.
  await call("permission_grant", { text: "you can order that chair without asking", scope: { action: "purchases", target: "chair", max_amount: 200 } });
  const under = await there("browser_submit", { ref: commit, what });
  assert.equal(under.blocked, "outcome_unknown", "a permission is not them saying so");
  assert.equal(db.listUnknownOutcomes(C).length, 1, "still open after both");
});

test("only a yes given since the outcome went unknown lifts the block", () => {
  const what = "Amazon, a desk chair, total $58.40";
  // A yes granted BEFORE anything went wrong — the one spent on the attempt nobody can account for.
  // It cannot be the yes that authorizes trying again: they did not know there was a problem.
  const old = db.askConfirmation({ conversationId: C, action: "browser_submit", summary: what, stakes: "both", target: what, askedAfterMsgs: 0 });
  db.grantConfirmation(old.id, "yeah go on");
  trust.noteUnknownOutcome({ conversationId: C, action: "browser_submit", target: what, why: "the page never came back" });

  assert.equal(trust.retryBlocked({ conversationId: C, action: "browser_submit", target: what, confirmationId: old.id }).blocked, "outcome_unknown");
  assert.equal(trust.retryBlocked({ conversationId: C, action: "browser_submit", target: what }).blocked, "outcome_unknown");

  clock.skip(60_000);
  const fresh = db.askConfirmation({ conversationId: C, action: "browser_submit", summary: what, stakes: "both", target: what, askedAfterMsgs: 0 });
  db.grantConfirmation(fresh.id, "yeah try it again, nothing came through");
  assert.equal(trust.retryBlocked({ conversationId: C, action: "browser_submit", target: what, confirmationId: fresh.id }), null, "their yes, given since, lets it through");
  // Checking does not clear it. Only an attempt that got a real answer does, which is what stops a
  // refusal between the check and the press from quietly lifting a block nobody resolved.
  assert.equal(db.listUnknownOutcomes(C).length, 1);
  trust.settleUnknownOutcome({ conversationId: C, action: "browser_submit", target: what, confirmationId: fresh.id });
  assert.equal(db.listUnknownOutcomes(C).length, 0);
  assert.equal(db.listUnknownOutcomes(C, { includeCleared: true }).length, 1, "the record of it stays");
});

test("an unknown outcome blocks that one action, not every purchase", () => {
  trust.noteUnknownOutcome({ conversationId: C, action: "browser_submit", target: "Amazon, a desk chair, total $58.40", why: "the connection dropped" });
  const same = trust.retryBlocked({ conversationId: C, action: "browser_submit", target: "Amazon, a desk chair, total $58.40" });
  assert.equal(same.blocked, "outcome_unknown");
  const other = trust.retryBlocked({ conversationId: C, action: "browser_submit", target: "Amazon, the usual groceries, total $20.00" });
  assert.equal(other, null, "a different purchase is not blocked by somebody else's unknown");
});
