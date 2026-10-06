// Finding what somebody pays for, and ending one. Offline: a fake Google and a fixture service.
//
// What these tests are for, in the order of what it would cost to get it wrong:
//
//   1. **Nothing is ever called cancelled without a confirmation.** This is the whole feature. A
//      person told their subscription is cancelled stops watching their bank, so a cancellation
//      that nobody confirmed has to read as `cancelling` — in the record, in the list, and in the
//      words the tool hands back. Checked from both ends: `subscription_update` refuses
//      `cancelled` with nothing behind it, and a fixture service that takes the press and says
//      nothing useful leaves the row at `cancelling`.
//   2. **The press that ends a subscription needs their own yes, for those exact details.** The
//      details only appear on the last screen — the end date, the fee — so a yes collected earlier
//      is a yes to something nobody had seen. The gate is checked on the obvious case and on the
//      two that matter more: the yes is single use, and a yes whose details have moved is refused.
//   3. **A scan decides nothing.** It reads receipts and hands back candidates. The list stays
//      empty until the model writes a subscription down, because deciding what is a subscription is
//      reading meaning and that is not code's job.
//   4. **A rail Reason cannot walk says so.** Phone, an App Store subscription, a service nobody
//      has read: each comes back `cant_do` with the honest line and the nearest real thing, and
//      none of them pretends.
//   5. **The registry is sourced.** Every entry says where its route was read and when, and every
//      commit label it knows is in the browser's click guard — because none of those labels is
//      caught by the generic words and every one of them would otherwise be pressed unasked.
//
// No real service is touched anywhere in here. The web rail runs against test/fixture-service.js on
// 127.0.0.1, which is shaped like the pages the real help articles describe, and the mail runs
// against the same fake Google the rest of the Google tests use.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-subs-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
// Not an undo-window test: anything reaching a third party is normally held for 30 seconds
// before it really goes, which would make every send in here come back 'held' instead of done.
// Off, so these keep asking what they are about. test/undo-window.test.js is where the window
// itself is proven.
process.env.REASON_UNDO_SECONDS = "0";

const { startGoogle, fakeMessage } = await import("./fixture-google.js");
const { startServiceSite } = await import("./fixture-service.js");
const { runTool, capabilitiesNow, clickCommits, tools } = await import("../src/tools.js");
const db = await import("../src/db.js");
const trust = await import("../src/trust.js");
const subs = await import("../src/subscriptions.js");
const cancelRoutes = await import("../src/cancel-routes.js");
const signin = await import("../src/signin.js");
const browser = await import("../src/browser.js");
const google = await import("../src/google.js");
const { exportData, deleteData } = await import("../src/data.js");
const { config, clock } = await import("../src/config.js");

const C = "dm:owner";
const AMA = "dm:fake:+13475550000";
const WORK = "work@example.com";

let fake;
let site;
let routes;

/** A judge that reads any reply as a plain yes: the gate's bookkeeping is what is under test here. */
const readsYes = async () => ({ verdict: "yes" });
const owner = (text) => ({ role: "user", content: `[Tue, Oct 6, 2026, 9:00 AM] Omari: ${text}` });

const call = (name, input, { conversationId = C, messages = [], ...extra } = {}) =>
  runTool(name, input, { conversationId, messages, judge: readsYes, cancelRoutes: routes, ...extra });

const ref = (snap, pred) => (snap.elements ?? []).find(pred)?.ref;

// ---------- the receipts the fake mailbox holds ----------
//
// Written the way receipts really are: the money and the dates inside the words, two charges a month
// apart from the same sender, a yearly one, a trial about to turn into a charge, and — the one that
// matters as much as any of them — a shop confirming a one-off order, which is NOT a subscription
// and which the scan must hand back anyway so the model is the thing that decides.
const RECEIPTS = [
  fakeMessage({
    id: "r1", threadId: "tr1", from: "Netflix <info@netflix.com>", to: "me@example.com",
    subject: "Your Netflix receipt", date: "Mon, 06 Oct 2026 03:00:00 -0400",
    text: "Thanks. We charged $17.99 to the card ending in 4242. Your plan renews on November 6, 2026.",
  }),
  fakeMessage({
    id: "r2", threadId: "tr2", from: "Netflix <info@netflix.com>", to: "me@example.com",
    subject: "Your Netflix receipt", date: "Fri, 05 Sep 2026 03:00:00 -0400",
    text: "Thanks. We charged $17.99 monthly to the card ending in 4242. Payment received September 5, 2026.",
  }),
  fakeMessage({
    id: "r3", threadId: "tr3", from: "Spotify <no-reply@spotify.com>", to: "me@example.com",
    subject: "Your subscription renewal", date: "Thu, 01 Oct 2026 07:12:00 -0400",
    text: "Premium Individual, $11.99 per month. Next payment October 31, 2026.",
  }),
  fakeMessage({
    id: "r4", threadId: "tr4", from: "Adobe <mail@adobe.com>", to: "me@example.com",
    subject: "Your annual plan will renew", date: "Wed, 24 Sep 2026 11:00:00 -0400",
    text: "Your Creative Cloud plan is $239.88 annually and will renew on December 1, 2026.",
  }),
  fakeMessage({
    id: "r5", threadId: "tr5", from: "Peloton <no-reply@onepeloton.com>", to: "me@example.com",
    subject: "Your free trial ends soon", date: "Sat, 03 Oct 2026 09:00:00 -0400",
    text: "Your free trial ends on October 10, 2026, and then it is $44 a month.",
  }),
  // Not a subscription. Here on purpose: the scan has to return it and the model has to leave it.
  fakeMessage({
    id: "r6", threadId: "tr6", from: "Amazon.com <auto-confirm@amazon.com>", to: "me@example.com",
    subject: "Your Amazon.com order of a desk lamp", date: "Sun, 04 Oct 2026 14:00:00 -0400",
    text: "Your order total was $42.10. Arriving Tuesday. This is a one-off order receipt.",
  }),
];

/** The confirmation a gym sends back after a written cancellation. Seeded only when a test wants it. */
const GYM_CONFIRMATION = fakeMessage({
  id: "g1", threadId: "tg1", from: "Planet Fitness Downtown <club@planetfitness.com>", to: "me@example.com",
  subject: "Your membership has been cancelled", date: "Tue, 06 Oct 2026 12:00:00 -0400",
  text: "We received your written notice. Cancellation number: PF-99221. Your membership ends on November 14, 2026.",
});

before(async () => {
  fake = await startGoogle();
  site = await startServiceSite();
  routes = cancelRoutes.withExtra([site.entry()]);
  config.googleClientId = "client-abc.apps.googleusercontent.com";
  config.googleClientSecret = "secret-xyz";
  config.googleOauthBase = fake.url;
  config.googleAccountsBase = fake.url;
  config.googleGmailBase = fake.url;
  config.googleCalendarBase = fake.url;
  config.publicUrl = "";
});

after(async () => {
  await browser.closeAllBrowsers();
  await site.close();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  clock.reset();
  // The browser is one per conversation and lives across tests, so a test that left it mid-flow —
  // or mid-navigation, after a page that refused to load — would make the next one's first
  // snapshot a race. Parked here rather than relaunched: it costs nothing and it is the difference
  // between a suite that passes and a suite that passes most of the time.
  if (browser.openConversations().includes(C)) {
    const parked = await browser.pageFor(C);
    await parked.goto("about:blank").catch(() => {});
  }
  db.db.exec("DELETE FROM subscriptions; DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM pages; DELETE FROM seen_urls;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
  fake.reset();
  fake.set({ email: "me@example.com", grantScopes: [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES] });
  fake.setAccount("me@example.com", { mail: RECEIPTS.map(m => ({ ...m, labelIds: [...m.labelIds] })) });
  for (const k of ["tokenCalls", "authHeaders", "revoked", "sent", "drafts", "modified", "trashed", "events", "eventWrites", "searches"]) fake.state[k].length = 0;
  fake.state.liveTokens.clear();
  site.reset();
});

/** Walk Google's real handshake, so the tokens in the table are ones the flow produced. */
async function connectGoogle(conversationId = C) {
  const link = await call("google_connect", {}, { conversationId });
  const state = new URL(link.url).searchParams.get("state");
  await google.completeConnect({ code: "good-code", state });
}

/** Take a gated tool through the gate the way the model is told to: ask, be answered, act. */
async function withYes(name, input, { conversationId = C, summary = "the thing" } = {}) {
  const blocked = await call(name, input, { conversationId });
  assert.equal(blocked.blocked, "needs_confirmation", JSON.stringify(blocked));
  const messages = [owner("do it")];
  const req = await runTool("confirm_request", { action: name, summary, target: blocked.use_target }, { conversationId, messages });
  messages.push(owner("yeah go on"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId, messages, judge: readsYes });
  assert.equal(rec.state, "granted", JSON.stringify(rec));
  const out = await call(name, { ...input, confirmation_id: req.confirmation_id }, { conversationId, messages });
  return { out, confirmation_id: req.confirmation_id, messages };
}

/**
 * The real tool loop with a scripted model in the controller's seat.
 *
 * Every tool really runs: the same `runTool`, so the same zod check, the same confirm gate, the same
 * ledger rows and the same database. The only thing replaced is the one thing a test cannot have,
 * which is the model's judgement — so what these flow tests prove is that the TOOLS fit together
 * into the errand, and not that a model would pick them. That second half needs a live run and
 * `docs/unverified.md` says so.
 */
async function turnWithFakeModel(model, { conversationId = C, messages = [] } = {}) {
  const calls = [];
  const use = async (tool, input) => {
    const out = await runTool(tool, input, { conversationId, messages, judge: readsYes, cancelRoutes: routes });
    calls.push({ tool, input, out });
    return out;
  };
  const said = await model({ use, messages });
  return { calls, said, used: calls.map(c => c.tool) };
}

// ---------- finding them ----------

test("with Google not connected, a scan says so and guesses at nothing", async () => {
  const out = await call("subscriptions_scan", {});
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.match(JSON.stringify(out), /connect|not_connected/i);
  assert.equal(out.groups, undefined, "no list at all, not even an empty confident one");
  assert.equal(fake.state.searches.length, 0, "and their mail was never asked");
});

test("the scan runs the documented set of searches, each bounded to the window asked for", async () => {
  await connectGoogle();
  const out = await call("subscriptions_scan", { months: 6 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.months, 6);

  // Every search in the module, and nothing improvised per turn.
  const asked = fake.state.searches.map(s => s.q);
  assert.equal(asked.length, subs.SEARCHES.length, `one request per documented search (${subs.SEARCHES.length})`);
  const after = subs.afterDate(6);
  for (const q of asked) assert.ok(q.includes(`after:${after}`), `every query is bounded to the window: ${q}`);
  // And the window is read off the clock rather than off whenever Google thinks the day started.
  assert.equal(after, subs.afterDate(6, clock.now()));
  assert.ok(asked.some(q => q.includes("trial ends")), "a trial about to become a charge is one of them");
  assert.ok(asked.some(q => q.includes("netflix.com")), "and the registry's own billers by domain");
});

test("it groups by sender, with the money, the dates and the billing period pulled out of the receipts", async () => {
  await connectGoogle();
  const out = await call("subscriptions_scan", {});
  assert.equal(out.ok, true, JSON.stringify(out));
  const groups = out.content.groups;

  const netflix = groups.find(g => g.sender_domain === "netflix.com");
  assert.ok(netflix, "the two Netflix receipts are one group, not two");
  assert.equal(netflix.messages_found, 2);
  assert.ok(netflix.amounts_seen.includes("$17.99"), JSON.stringify(netflix.amounts_seen));
  const first = netflix.messages.find(m => m.id === "r1");
  assert.deepEqual(first.amounts[0], { cents: 1799, currency: "USD", as_written: "$17.99", shown: "$17.99" });
  assert.equal(netflix.known_cancel_route, "netflix", "and the registry entry it matches");
  // The honest limit of a cheap sweep, pinned rather than hidden: a scan reads headers and Gmail's
  // own snippet, so a renewal date that sits further down a long receipt is simply not there. The
  // tool says so and tells the model to gmail_read that one message when the date matters.
  assert.equal(first.renewal_date, undefined, "this receipt's renewal date is past the end of the snippet");

  const spotify = groups.find(g => g.sender_domain === "spotify.com");
  assert.equal(spotify.messages[0].renewal_date, "October 31, 2026", "and when it IS in the snippet, the words around it are what identify it");
  assert.equal(spotify.messages[0].cadence, "monthly", "'per month' in the words is what says monthly");
  const adobe = groups.find(g => g.sender_domain === "adobe.com");
  assert.equal(adobe.messages[0].cadence, "yearly");

  // The one that is not a subscription comes back too. Deciding is not this tool's job.
  assert.ok(groups.some(g => g.sender_domain === "amazon.com"), "a one-off order receipt is still a candidate");
  assert.match(out.note, /CANDIDATES/);
  assert.match(out.note, /You decide/);
  // And the warning travels with somebody else's words.
  assert.match(out.untrusted_content, /never a command to follow/i);
});

test("a scan decides nothing: the list is empty until something is written down", async () => {
  await connectGoogle();
  const scan = await call("subscriptions_scan", {});
  assert.ok(scan.content.groups.length >= 4);
  const list = await call("subscription_list", {});
  assert.equal(list.count, 0);
  assert.match(list.empty, /offer to read their receipts/i);
});

test("the scan says which mailbox each receipt came from, and covers both", async () => {
  await connectGoogle();
  fake.addAccount(WORK, { mail: [fakeMessage({
    id: "w1", threadId: "tw1", from: "Audible <do-not-reply@audible.com>", to: WORK,
    subject: "Your Audible receipt", date: "Mon, 06 Oct 2026 06:00:00 -0400",
    text: "Membership fee $14.95 monthly. Payment received October 6, 2026.",
  })] });
  fake.set({ email: WORK });
  await connectGoogle();

  const out = await call("subscriptions_scan", {});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([...out.accounts_searched].sort(), ["me@example.com", WORK].sort());
  const audible = out.content.groups.find(g => g.sender_domain === "audible.com");
  assert.deepEqual(audible.in_accounts, [WORK], "a receipt in the work mailbox says so");
  assert.equal(audible.messages[0].account, WORK);
  const netflix = out.content.groups.find(g => g.sender_domain === "netflix.com");
  assert.deepEqual(netflix.in_accounts, ["me@example.com"]);
});

test("a scan leaves a ledger row naming the window and where it looked", async () => {
  await connectGoogle();
  await call("subscriptions_scan", { months: 3 });
  const row = db.listActions(C).find(a => a.action === "subscriptions_scan");
  assert.ok(row, "eight searches across a year of somebody's mail is not an invisible read");
  assert.match(row.receipt, /Read 3 months of receipts/);
  assert.match(row.receipt, /Nothing was recorded by the scan itself/);
});

// ---------- the record ----------

test("recording is by merchant: once to create, again to update, and the route comes off the registry", async () => {
  const made = await call("subscription_record", {
    merchant: "Netflix", amount: "$17.99", cadence: "monthly",
    last_charged: "October 6, 2026", source: "gmail r1 in me@example.com",
  });
  assert.equal(made.created, true);
  assert.equal(made.subscription.amount, "$17.99");
  assert.equal(made.subscription.a_month, "$17.99");
  assert.equal(made.cancel_route, "web", "matched from the merchant name, not asked for");
  assert.equal(made.subscription.cancel_url, "https://www.netflix.com/cancelplan");

  const again = await call("subscription_record", { merchant: "netflix", next_renewal: "November 6, 2026" });
  assert.equal(again.updated, true);
  assert.equal(again.subscription.id, made.subscription.id, "one row, however it was spelled");
  assert.equal(again.subscription.amount, "$17.99", "a field left out keeps what was there");
  assert.equal(again.subscription.next_renewal, "November 6, 2026");
  assert.equal(db.listSubscriptions(C).length, 1);
});

test("a yearly price is shown as what it costs a month, without losing what the receipt said", async () => {
  await call("subscription_record", { merchant: "Adobe", amount: "$239.88", cadence: "yearly" });
  const row = (await call("subscription_list", {})).subscriptions[0];
  assert.equal(row.amount, "$239.88", "the receipt's own number is kept");
  assert.equal(row.a_month, "$19.99");
});

test("a price nobody can read is refused rather than stored as something else", async () => {
  const out = await call("subscription_record", { merchant: "My gym", amount: "about twenty quid" });
  assert.equal(out.ok, false);
  assert.match(out.error, /no amount in it that could be read/);
  assert.equal(db.getSubscription(C, "My gym"), null, "and nothing was written");
});

test("a non-dollar receipt keeps its own currency", async () => {
  await call("subscription_record", { merchant: "Some UK thing", amount: "£10.99", cadence: "monthly" });
  const row = db.getSubscription(C, "Some UK thing");
  assert.equal(row.currency, "GBP");
  assert.equal(subs.money(row.amount_cents, row.currency), "£10.99");
});

test("a service name that is not in the registry is refused, and no route is guessed", async () => {
  const out = await call("subscription_record", { merchant: "Blockbuster", service: "blockbuster" });
  assert.equal(out.ok, false);
  assert.match(out.error, /No cancel route called 'blockbuster'/);
  // And a merchant nothing matches is recorded with the route unknown, said out loud.
  const made = await call("subscription_record", { merchant: "Gym down the road", amount: "$29" });
  assert.equal(made.cancel_route, "unknown");
  assert.match(made.route_note, /not known/);
  assert.match(made.route_note, /do not promise to cancel it/);
});

// ---------- the list, and the page ----------

test("the list is the truth, and the monthly total names what it could not count", async () => {
  await call("subscription_record", { merchant: "Netflix", amount: "$17.99", cadence: "monthly" });
  await call("subscription_record", { merchant: "Adobe", amount: "$239.88", cadence: "yearly" });
  await call("subscription_record", { merchant: "Gym down the road", amount: "$29" });  // cadence unknown
  await call("subscription_record", { merchant: "Some newsletter" });                   // no price at all

  const out = await call("subscription_list", {});
  assert.equal(out.count, 4);
  assert.equal(out.a_month, "$37.98", "17.99 + 239.88/12");
  assert.equal(out.counted, 2);
  const names = out.not_in_the_total.map(u => u.merchant).sort();
  assert.deepEqual(names, ["Gym down the road", "Some newsletter"]);
  assert.match(JSON.stringify(out.not_in_the_total), /cadence is unknown|no price found/);
  assert.match(out.note, /say the real figure is higher/);
});

test("the overview page is rows, with the total as a callout and a guess labelled a guess", async () => {
  await call("subscription_record", { merchant: "Netflix", amount: "$17.99", cadence: "monthly", next_renewal: "November 6, 2026" });
  await call("subscription_record", { merchant: "Peloton", amount: "$44", cadence: "monthly" });

  const out = await call("subscription_list", { forgotten: [{ merchant: "Peloton", why: "nothing but receipts from them since June" }] });
  const kinds = out.page_blocks.map(b => b.type);
  assert.ok(kinds.includes("rows"), JSON.stringify(kinds));
  assert.ok(kinds.includes("callout"));

  const rows = out.page_blocks.find(b => b.type === "rows");
  const netflix = rows.items.find(i => i.name === "Netflix");
  assert.equal(netflix.value, "$17.99", "the amount on the right");
  assert.match(netflix.detail, /monthly/);
  assert.match(netflix.detail, /renews November 6, 2026/);

  const total = out.page_blocks.find(b => b.type === "callout" && b.title === "A month");
  assert.match(total.text, /\$61\.99 a month/);

  const guess = out.page_blocks.find(b => b.type === "callout" && b.title === "A guess, not a fact");
  assert.match(guess.text, /Peloton/);
  assert.match(guess.text, /nothing about what you use/, "it says why it is only a guess");
  assert.equal(guess.tone, "warning");

  // And the blocks are real blocks: they go through page_create's own checker unchanged.
  const page = await call("page_create", { title: "What you're paying for", blocks: out.page_blocks });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.ok(page.link);
});

test("a cancellation with no confirmation reads as not-cancelled everywhere it is shown", async () => {
  await call("subscription_record", { merchant: "Hulu", amount: "$18.99", cadence: "monthly", status: "cancelling" });
  const out = await call("subscription_list", {});
  assert.deepEqual(out.waiting_on_a_confirmation, ["Hulu"]);
  assert.match(out.say_this, /NOT cancelled yet/);
  assert.match(out.subscriptions[0].says, /STARTED and NOT cancelled/);
  const rows = out.page_blocks.find(b => b.type === "rows");
  assert.match(rows.items[0].detail, /cancelling — no confirmation yet/);
});

// ---------- the registry ----------

test("every entry says where its route was read and when, and a web entry has an address", () => {
  for (const r of cancelRoutes.ROUTES) {
    assert.ok(r.source?.url, `${r.service}: a source URL`);
    assert.equal(r.source.read_on, "2026-10-06", `${r.service}: the date it was read`);
    assert.ok(["read", "search_snippet", "could_not_read"].includes(r.source.how), `${r.service}: how it was read`);
    assert.ok(cancelRoutes.ROUTE_KINDS.includes(r.route), `${r.service}: a real route kind`);
    if (r.route === "web") assert.ok(r.cancel_url, `${r.service}: a web route needs a page address`);
    // A page nobody could read gets `unknown`, and says so instead of carrying a guessed route.
    if (r.source.how === "could_not_read") {
      assert.equal(r.route, "unknown", `${r.service}: unreadable means unknown`);
      assert.equal(r.cancel_url, "", `${r.service}: and no invented address`);
    }
  }
  // The one that could not be read is in the list rather than quietly dropped.
  assert.equal(cancelRoutes.route("nytimes").route, "unknown");
  assert.match(cancelRoutes.route("nytimes").limits.join(" "), /hearsay/);
});

test("the four services whose last button is not documented say so rather than inventing one", () => {
  const vague = cancelRoutes.ROUTES.filter(r => r.route === "web" && !r.commits);
  assert.ok(vague.length, "there really are some, and that is the honest state");
  for (const r of vague) {
    const p = cancelRoutes.playbook(r.service);
    assert.match(p.no_documented_button, /Read the page/);
  }
  // And one that does document it carries the real words.
  assert.equal(cancelRoutes.playbook("netflix").the_button_that_commits, "Finish Cancellation");
  assert.equal(cancelRoutes.playbook("youtube_premium").the_button_that_commits, "Yes, cancel");
  assert.equal(cancelRoutes.playbook("adobe").the_button_that_commits, "Confirm cancellation");
});

test("every commit label the registry knows is in the click guard, and a one-word one never is", () => {
  const pattern = cancelRoutes.commitPattern();
  for (const label of cancelRoutes.commitWords()) {
    assert.ok(pattern.test(label), `'${label}' is in the guard`);
    // And through the guard the browser actually uses, as a button rather than a link.
    assert.equal(clickCommits({ tag: "button", type: "submit", name: label }).commits, true, `'${label}' is refused as a button`);
  }
  // The two real last-presses that are one generic word are deliberately NOT in it: a guard that
  // treated every Continue on the web as irreversible would spend a yes on turning a page.
  for (const generic of ["Continue", "Next", "Cancel", "OK"]) {
    assert.equal(clickCommits({ tag: "button", type: "button", name: generic }).commits, false, `'${generic}' still clicks`);
  }
  // Those two are gated anyway, by the tool that presses them.
  assert.equal(cancelRoutes.route("google_play").commits, "Continue");
  assert.match(cancelRoutes.route("google_play").commits_note, /needs a yes whatever the button says/);
});

test("a link is never a commit, so opening a cancel page costs no yes", () => {
  const asLink = clickCommits({ tag: "a", href: "/account/cancel", name: "Cancel membership" });
  assert.equal(asLink.commits, false);
  assert.match(asLink.why, /it is a link/);
});

test("the fees and notice rules a person needs told before they say yes are on the record", () => {
  assert.match(cancelRoutes.route("adobe").fees, /never quote one from memory/);
  assert.match(cancelRoutes.route("planet_fitness").notice, /8 days/);
  assert.match(cancelRoutes.route("planet_fitness").fees, /\$58/);
  assert.match(cancelRoutes.route("chatgpt_plus").notice, /24 hours/);
  assert.match(cancelRoutes.route("spotify").limits.join(" "), /IMMEDIATELY/);
  assert.match(cancelRoutes.route("audible").limits.join(" "), /credits are LOST/);
});

test("cancel_route lists everything, and names the rails that do not work", async () => {
  const all = await call("cancel_route", {});
  assert.equal(all.routes.length, cancelRoutes.ROUTES.length + 1, "the fixture is only there because a test put it there");
  assert.deepEqual(all.rails_that_work, ["web", "email"]);
  assert.match(all.rails_that_do_not.phone, /Not built/);
  assert.match(all.note, /ever been walked for real/);

  const one = await call("cancel_route", { service: "netflix" });
  assert.equal(one.route.route, "web");
  assert.match(one.route.read_from, /help\.netflix\.com.*2026-10-06/);
  assert.match(one.gate, /needs their yes/);
});

test("cancel_route on Hulu gives the web route and admits the last button is unknown", async () => {
  const out = await call("cancel_route", { service: "hulu" });
  assert.equal(out.route.route, "web");
  assert.equal(out.route.the_button_that_commits, null);
  assert.match(out.route.no_documented_button, /Read the page/);
  assert.match(out.route.read_from, /would not render for a reader/);
});

// ---------- the rails Reason cannot walk ----------

test("a phone-only service is cant_do, with the honest line and the offer for when calls exist", async () => {
  // Nothing in the registry is phone-only today, so the shape is checked where it is defined and
  // then through the tool with a route the record carries.
  const cant = cancelRoutes.cannotDo("phone", "The Gazette");
  assert.equal(cant.kind, "phone");
  assert.match(cant.say, /can't make calls yet/);
  assert.match(cant.say, /once calling is on/i);
  assert.match(cant.when, /do not say it will try/);

  db.recordSubscription(C, { merchant: "The Gazette", amountCents: 1500, cadence: "monthly", cancelRoute: "phone" });
  const out = await call("subscription_cancel_start", { merchant: "The Gazette" });
  assert.equal(out.ok, false);
  assert.equal(out.cant_do, "phone");
  assert.match(out.say, /can't make calls yet/);
  assert.match(out.note, /Do not offer a workaround/);
  assert.equal(db.getSubscription(C, "The Gazette").status, "active", "nothing changed on the record");
});

test("an App Store subscription says the four taps and does not offer to do it", async () => {
  await call("subscription_record", { merchant: "Apple", service: "apple", amount: "$2.99" });
  const out = await call("subscription_cancel_start", { merchant: "Apple" });
  assert.equal(out.cant_do, "device");
  assert.match(out.say, /can't tap your phone/);
  assert.ok(out.steps_they_take.some(s => /Settings/.test(s)));
  assert.match(out.route.limits.join(" "), /Reason cannot tap their phone/);
});

test("a service nobody has read says it does not know and offers to look together", async () => {
  await call("subscription_record", { merchant: "The New York Times", service: "nytimes", amount: "$25" });
  const out = await call("subscription_cancel_start", { merchant: "The New York Times" });
  assert.equal(out.cant_do, "unknown");
  assert.match(out.say, /don't actually know/);
  assert.match(out.say, /open your account page with you/);
});

test("something not on the list cannot be cancelled, because there is nowhere to put the proof", async () => {
  const out = await call("subscription_cancel_start", { merchant: "Whatever" });
  assert.equal(out.ok, false);
  assert.match(out.error, /not on the list/);
});

// ---------- the web rail, against the fixture service ----------

test("not signed in: Reason stops, says how they sign in once, and never asks for a password", async () => {
  site.signOut();
  await call("subscription_record", { merchant: "Streamly", service: "streamly", amount: "$17.99", cadence: "monthly" });
  const out = await call("subscription_cancel_start", { merchant: "Streamly" });

  assert.equal(out.ok, false);
  assert.equal(out.blocked, "not_signed_in");
  assert.match(out.site_says, /sign-in page|still says/i, out.site_says);
  assert.match(out.how_they_sign_in, /signin_link/);
  assert.match(out.never_a_password.say, /don't take passwords/);
  assert.match(out.error, /never say the cancellation has started/);
  assert.equal(site.cancellations.length, 0);
  // And the site's own answer is what was written down, not a hope.
  assert.notEqual(db.lastSigninCheck(C, "streamly"), null);
  assert.equal(db.liveAccount(C, "streamly"), null, "nothing reads as connected");
});

test("signed in: it opens the cancel page, reports the retention offer, and presses nothing", async () => {
  site.signIn();
  await call("subscription_record", { merchant: "Streamly", service: "streamly", amount: "$17.99", cadence: "monthly" });
  const out = await call("subscription_cancel_start", { merchant: "Streamly" });

  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.rail, "web");
  assert.equal(out.signed_in, "signed_in");
  assert.match(out.page.text, /Pause for 3 months instead/, "the retention offer is in front of the model");
  assert.match(out.watch_for, /retention offer/);
  assert.match(out.next, /browser_click REFUSES/);
  assert.match(out.next, /Finish Cancellation/);
  assert.equal(site.cancellations.length, 0, "nothing was pressed");
});

test("the whole web flow stops dead at the last button without a yes", async () => {
  site.signIn();
  await call("subscription_record", { merchant: "Streamly", service: "streamly", amount: "$17.99", cadence: "monthly" });
  const start = await call("subscription_cancel_start", { merchant: "Streamly" });

  // Step one is an ordinary click: it commits nothing, so no yes is spent turning the page.
  const cont = await call("browser_click", { ref: ref(start.page, e => e.tag === "button" && /Continue/i.test(e.name)), expect: "past the pause offer" });
  assert.equal(cont.ok, true, JSON.stringify(cont));
  assert.match(cont.text, /Access ends on/);
  assert.match(cont.text, /Early cancellation fee/, "the fee only exists on this screen");

  // The last button will not be pressed by an ordinary click.
  const commit = ref(cont, e => e.tag === "button" && /Finish Cancellation/i.test(e.name));
  assert.ok(commit);
  const refused = await call("browser_click", { ref: commit });
  assert.equal(refused.blocked, "commit_needs_gate");
  assert.equal(site.cancellations.length, 0, "NOTHING was cancelled");
  assert.ok(db.listActions(C).some(a => a.action === "browser_click" && a.outcome === "blocked"), "the refusal is on the record");

  // Neither will the subscription tool, without a yes.
  const noYes = await call("subscription_cancel_commit", { merchant: "Streamly", ref: commit, what: "Streamly, $17.99/mo, ends November 6 2026, $5.00 fee" });
  assert.equal(noYes.blocked, "needs_confirmation");
  assert.equal(site.cancellations.length, 0);
  assert.equal(db.getSubscription(C, "Streamly").status, "active");
});

test("a yes is for those exact details, is spent once, and the confirmation lands on the record", async () => {
  site.signIn();
  await call("subscription_record", { merchant: "Streamly", service: "streamly", amount: "$17.99", cadence: "monthly" });
  const start = await call("subscription_cancel_start", { merchant: "Streamly" });
  const cont = await call("browser_click", { ref: ref(start.page, e => e.tag === "button" && /Continue/i.test(e.name)) });
  const commit = ref(cont, e => e.tag === "button" && /Finish Cancellation/i.test(e.name));

  const what = "Streamly, $17.99 a month, ends November 6, 2026, $5.00 early cancellation fee";
  const messages = [owner("cancel streamly")];
  const req = await runTool("confirm_request", {
    action: "subscription_cancel_commit",
    summary: `End Streamly. ${what}`,
    target: `Streamly: ${what}`,
  }, { conversationId: C, messages });

  // The model cannot answer for them.
  const early = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages, judge: readsYes });
  assert.equal(early.state, "waiting_for_yes");
  assert.equal(site.cancellations.length, 0);

  messages.push(owner("yeah do it"));
  const granted = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages, judge: readsYes });
  assert.equal(granted.state, "granted");

  // A yes for these details does not cover different ones — not even a cheaper-sounding version.
  const moved = await call("subscription_cancel_commit", {
    merchant: "Streamly", ref: commit, confirmation_id: req.confirmation_id,
    what: "Streamly, $17.99 a month, ends November 6, 2026, no fee",
  }, { messages });
  assert.equal(moved.blocked, "wrong_target", JSON.stringify(moved));
  assert.equal(site.cancellations.length, 0, "and nothing was pressed");

  // And a yes for another subscription does not cover this one.
  const elsewhere = await call("subscription_cancel_commit", {
    merchant: "Netflix", ref: commit, confirmation_id: req.confirmation_id, what,
  }, { messages });
  assert.notEqual(elsewhere.ok, true);
  assert.equal(site.cancellations.length, 0);

  // The real thing.
  const done = await call("subscription_cancel_commit", { merchant: "Streamly", ref: commit, what, confirmation_id: req.confirmation_id }, { messages });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(site.cancellations.length, 1, "exactly one cancellation, only after the yes");
  assert.equal(done.status, "cancelled");
  assert.match(done.confirmation, new RegExp(site.cancellations[0].code), "the service's own number came back");
  assert.equal(done.confirmation_kind, "number");

  const row = db.getSubscription(C, "Streamly");
  assert.equal(row.status, "cancelled");
  assert.ok(row.confirmation.includes(site.cancellations[0].code));
  assert.ok(row.cancelled_at, "and when it happened");

  // The receipt, and the yes spent for good.
  const ledger = db.listActions(C).find(a => a.action === "subscription_cancel_commit" && a.outcome === "ok");
  assert.ok(ledger);
  assert.equal(ledger.confirmation_id, req.confirmation_id, "the receipt names the yes that authorized it");
  assert.match(ledger.receipt, /Pressed 'Finish Cancellation'/);
  assert.match(ledger.receipt, /Recorded as cancelled/);
  assert.ok(db.getConfirmation(C, req.confirmation_id).consumed_at);

  const twice = await call("subscription_cancel_commit", { merchant: "Streamly", ref: commit, what, confirmation_id: req.confirmation_id }, { messages });
  assert.equal(twice.blocked, "already_spent");
  assert.equal(site.cancellations.length, 1);
});

test("a press that goes through with no confirmation leaves it at cancelling, and says so", async () => {
  site.signIn();
  site.quiet();
  try {
    await call("subscription_record", { merchant: "Streamly", service: "streamly", amount: "$17.99", cadence: "monthly" });
    const start = await call("subscription_cancel_start", { merchant: "Streamly" });
    const cont = await call("browser_click", { ref: ref(start.page, e => e.tag === "button" && /Continue/i.test(e.name)) });
    const commit = ref(cont, e => e.tag === "button" && /Finish Cancellation/i.test(e.name));
    const { out } = await withYes("subscription_cancel_commit", { merchant: "Streamly", ref: commit, what: "Streamly, $17.99 a month" });

    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(site.cancellations.length, 1, "the service really was told");
    assert.equal(out.status, "cancelling", "and it is still not cancelled, because nothing confirmed it");
    assert.equal(out.confirmation, undefined);
    assert.match(out.note, /NOT cancelled|not cancelled/);
    assert.match(out.note, /waiting on confirmation/);
    assert.equal(db.getSubscription(C, "Streamly").status, "cancelling");
    const ledger = db.listActions(C).find(a => a.action === "subscription_cancel_commit" && a.outcome === "ok");
    assert.match(ledger.receipt, /gave NO confirmation/);
  } finally { site.quiet(false); }
});

test("a submit that pressed nothing does not burn the yes", async () => {
  site.signIn();
  await call("subscription_record", { merchant: "Streamly", service: "streamly", amount: "$17.99", cadence: "monthly" });
  await call("subscription_cancel_start", { merchant: "Streamly" });
  const messages = [owner("cancel it")];
  const what = "Streamly, $17.99 a month";
  const req = await runTool("confirm_request", { action: "subscription_cancel_commit", summary: what, target: `Streamly: ${what}` }, { conversationId: C, messages });
  messages.push(owner("go on then"));
  assert.equal((await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages, judge: readsYes })).state, "granted");

  const missed = await call("subscription_cancel_commit", { merchant: "Streamly", ref: "e999", what, confirmation_id: req.confirmation_id }, { messages });
  assert.equal(missed.ok, false);
  assert.equal(site.cancellations.length, 0);
  assert.equal(db.getConfirmation(C, req.confirmation_id).consumed_at, null, "the yes survives a click that never happened");
  assert.match(missed.error, /browser_read/);
});

test("a cancel page that will not load is the site's choice, said as such", async () => {
  site.signIn();
  const dead = cancelRoutes.withExtra([{ ...site.entry(), cancel_url: "http://127.0.0.1:1/cancel" }]);
  // Recorded while the registry still had the live address, so the row carries that one. The
  // registry's address is the one that gets used — a row holding a stale URL must not win.
  await call("subscription_record", { merchant: "Streamly", service: "streamly" });
  assert.equal(db.getSubscription(C, "Streamly").cancel_url, `${site.url}/cancel`);
  const out = await runTool("subscription_cancel_start", { merchant: "Streamly" }, { conversationId: C, messages: [], judge: readsYes, cancelRoutes: dead });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "page_would_not_load");
  assert.match(out.error, /site refusing rather than something being wrong with you/);
  assert.ok(out.steps_they_take.length, "and the steps they can take themselves");
});

// ---------- the written rail ----------

test("a written route with no address asks for one, drafts nothing into the world, and sends nothing", async () => {
  await connectGoogle();
  await call("subscription_record", { merchant: "Planet Fitness", amount: "$24.99", cadence: "monthly", last_charged: "October 1, 2026" });
  const out = await call("subscription_cancel_start", { merchant: "Planet Fitness" });

  assert.equal(out.ok, true);
  assert.equal(out.rail, "written");
  assert.equal(out.needs, "an address");
  assert.match(out.note, /only they know/);
  assert.match(out.note, /Never type an address from memory/);
  assert.match(out.notice_rules, /8 days/);
  assert.match(out.fees, /\$58/);
  assert.equal(fake.state.drafts.length, 0, "nothing reached their Gmail");
  assert.equal(db.getSubscription(C, "Planet Fitness").status, "active");
});

test("the written cancellation says who is asking, that it is an assistant, and asks for a confirmation", async () => {
  await connectGoogle();
  await call("subscription_record", { merchant: "Planet Fitness", amount: "$24.99", cadence: "monthly", last_charged: "October 1, 2026" });
  const out = await call("subscription_cancel_start", { merchant: "Planet Fitness", email_to: "club@planetfitness.example" });

  assert.equal(out.rail, "email");
  assert.equal(out.to, "club@planetfitness.example");
  assert.match(out.draft.subject, /Cancellation request — Planet Fitness/);
  assert.match(out.draft.body, /on behalf of Omari/);
  assert.match(out.draft.body, /Omari's assistant/, "Reason is never the person it works for");
  assert.match(out.draft.body, /Please confirm in a reply/);
  assert.match(out.draft.body, /cancellation or reference number/);
  assert.match(out.draft.body, /treat it as still active until that confirmation arrives/);
  assert.match(out.draft.body, /October 1, 2026/, "and the charge they have a record of");
  assert.match(out.next, /Sending needs their yes/);
  assert.match(out.next, /NOT cancelled until that reply arrives/);
});

test("the send is gated, and only once it has gone does the status become cancelling", async () => {
  await connectGoogle();
  await call("subscription_record", { merchant: "Planet Fitness", amount: "$24.99", cadence: "monthly" });
  const start = await call("subscription_cancel_start", { merchant: "Planet Fitness", email_to: "club@planetfitness.example" });

  // A draft reaches nobody, so it needs no yes.
  const draft = await call("gmail_draft", { to: ["club@planetfitness.example"], subject: start.draft.subject, body: start.draft.body });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(fake.state.sent.length, 0, "a draft is not a send");

  // Sending does.
  const blocked = await call("gmail_send", { to: ["club@planetfitness.example"], subject: start.draft.subject, body: start.draft.body });
  assert.equal(blocked.blocked, "needs_confirmation");
  assert.equal(fake.state.sent.length, 0);

  const { out } = await withYes("gmail_send", { to: ["club@planetfitness.example"], subject: start.draft.subject, body: start.draft.body });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(fake.state.sent.length, 1);
  assert.match(fake.state.sent[0].body, /Omari's assistant/);

  const moved = await call("subscription_update", { merchant: "Planet Fitness", status: "cancelling", notes: "written notice emailed to the club" });
  assert.equal(moved.ok, true);
  assert.match(moved.note, /NOT cancelled/);
  assert.equal(db.getSubscription(C, "Planet Fitness").status, "cancelling");
});

test("subscription_update refuses `cancelled` with nothing behind it", async () => {
  await call("subscription_record", { merchant: "Planet Fitness", amount: "$24.99", status: "cancelling" });
  const out = await call("subscription_update", { merchant: "Planet Fitness", status: "cancelled" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "no_confirmation");
  assert.match(out.error, /only real when something confirms it/);
  assert.equal(out.still, "cancelling");
  assert.equal(db.getSubscription(C, "Planet Fitness").status, "cancelling", "and the row did not move");
});

test("the confirmation email is found, read, and is what flips it to cancelled", async () => {
  await connectGoogle();
  fake.setAccount("me@example.com", { mail: [...RECEIPTS, GYM_CONFIRMATION].map(m => ({ ...m, labelIds: [...m.labelIds] })) });
  await call("subscription_record", { merchant: "Planet Fitness", service: "planet_fitness", amount: "$24.99", cadence: "monthly", status: "cancelling" });

  const found = await call("subscription_confirmations", {});
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.equal(found.checked, 1);
  const result = found.content.results[0];
  assert.equal(result.merchant, "Planet Fitness");
  assert.match(result.searched, /from:planetfitness\.com/);
  assert.ok(result.found >= 1, JSON.stringify(result));
  const hit = result.messages.find(m => m.id === "g1");
  assert.ok(hit, "the club's reply came back");
  // The strongest proof on the page wins: a reference number beats a date, and this reply has both.
  assert.equal(hit.looks_like, "number");
  assert.match(hit.confirmation_text, /PF-99221/);
  // Nothing moved on its own: a marketing email with the word cancel in it would match too.
  assert.match(found.note, /Nothing here has moved any status/);
  assert.equal(db.getSubscription(C, "Planet Fitness").status, "cancelling");

  const done = await call("subscription_update", {
    merchant: "Planet Fitness", status: "cancelled",
    confirmation: "PF-99221, ends November 14, 2026 (their email: Your membership has been cancelled)",
  });
  assert.equal(done.ok, true);
  assert.equal(done.subscription.status, "cancelled");
  assert.match(done.subscription.says, /confirmed by: PF-99221/);
  assert.match(done.note, /Say what the confirmation actually was/);
});

test("with nothing mid-cancel, it says so instead of searching their mail for nothing", async () => {
  await connectGoogle();
  const out = await call("subscription_confirmations", {});
  assert.equal(out.checked, 0);
  assert.match(out.note, /no confirmation owed/);
  assert.equal(fake.state.searches.length, 0);
});

// ---------- a standing permission, and the one thing it must not cover ----------

test("'just cancel it, stop asking' really does cancel without asking — for that merchant only", async () => {
  site.signIn();
  await call("subscription_record", { merchant: "Streamly", service: "streamly", amount: "$17.99", cadence: "monthly" });
  await call("subscription_record", { merchant: "Netflix", amount: "$17.99", cadence: "monthly" });
  const granted = await call("permission_grant", {
    text: "just cancel streamly, stop asking me about it",
    scope: { action: "subscriptions", target: "Streamly" },
  });
  assert.equal(granted.ok, true, JSON.stringify(granted));

  const start = await call("subscription_cancel_start", { merchant: "Streamly" });
  assert.equal(start.ok, true, JSON.stringify(start));
  const cont = await call("browser_click", { ref: ref(start.page, e => e.tag === "button" && /Continue/i.test(e.name)) });
  const commit = ref(cont, e => e.tag === "button" && /Finish Cancellation/i.test(e.name));

  const done = await call("subscription_cancel_commit", { merchant: "Streamly", ref: commit, what: "Streamly, $17.99 a month, ends November 6, 2026" });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(site.cancellations.length, 1, "no yes was needed, because they had already given one");
  assert.equal(db.getSubscription(C, "Streamly").status, "cancelled");

  // And it covers that merchant and nothing else: the target a cancellation carries starts with the
  // merchant, so a permission naming one can never let another through.
  const elsewhere = await call("subscription_cancel_commit", { merchant: "Netflix", ref: commit, what: "Netflix, $17.99 a month" });
  assert.equal(elsewhere.blocked, "needs_confirmation", JSON.stringify(elsewhere));
  assert.match(elsewhere.error, /does not cover this/);
});

test("a service that charges to leave goes back to needing a yes, however wide the permission", async () => {
  await call("subscription_record", { merchant: "Adobe", service: "adobe", amount: "$239.88", cadence: "yearly" });
  await call("permission_grant", { text: "cancel whatever subscriptions you want, don't ask me", scope: { action: "subscriptions" } });

  const out = await call("subscription_cancel_commit", { merchant: "Adobe", ref: "e1", what: "Adobe Creative Cloud, $239.88 a year" });
  assert.equal(out.blocked, "needs_confirmation", JSON.stringify(out));
  assert.match(out.beyond_the_permission, /charges to leave early/);
  assert.match(out.beyond_the_permission, /not a permission to pay a fee/);
  assert.match(out.error, /told you you may do this without asking/);
  // Nothing was pressed, which is the other half of the claim: the refusal happens in the gate,
  // before the browser is touched at all.
  assert.equal(site.cancellations.length, 0);

  // And the permission itself is not the problem — it reaches a merchant with no fee on record.
  // Asserted on the permission rather than by pressing, so this test never touches a page.
  const permissions = await import("../src/permissions.js");
  const reaches = permissions.covering({ conversationId: C, action: "subscription_cancel_commit", target: "Netflix: Netflix, $17.99 a month" });
  assert.equal(reaches.ok, true, JSON.stringify(reaches));
});

// ---------- their data ----------

test("an export carries the subscriptions and a delete takes them", async () => {
  await call("subscription_record", { merchant: "Netflix", amount: "$17.99", cadence: "monthly", source: "gmail r1 in me@example.com", notes: "the one he actually watches" });
  await call("subscription_update", { merchant: "Netflix", status: "cancelled", confirmation: "ST-4000K, ends November 6, 2026" });

  const dump = exportData({ conversation: C, audio: false });
  assert.equal(dump.tables.subscriptions.length, 1);
  const text = JSON.stringify(dump);
  assert.ok(text.includes("the one he actually watches"), "their own notes are in their own export");
  assert.ok(text.includes("ST-4000K"), "and the confirmation a service gave them");

  const gone = await deleteData({ conversation: C, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }) });
  assert.equal(gone.rows.subscriptions, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM subscriptions").get().n, 0);
});

test("one person's subscriptions are not in another person's list or export", async () => {
  await call("subscription_record", { merchant: "Netflix", amount: "$17.99" });
  const hers = await call("subscription_list", {}, { conversationId: AMA });
  assert.equal(hers.count, 0);
  const herDump = exportData({ conversation: AMA, audio: false });
  assert.equal(herDump.tables.subscriptions.length, 0);
  assert.equal((await call("subscription_cancel_start", { merchant: "Netflix" }, { conversationId: AMA })).ok, false);
});

// ---------- what Reason says it can do ----------

test("the capability is honest about three different answers, not one", async () => {
  const before = capabilitiesNow({ conversationId: C }).find(c => c.name === "subscriptions");
  assert.equal(before.status, "not connected");
  assert.match(before.what, /needs Google connected first/);

  await connectGoogle();
  const after = capabilitiesNow({ conversationId: C }).find(c => c.name === "subscriptions");
  assert.equal(after.status, "live");
  assert.match(after.what, /reading a year of receipts/);
  assert.match(after.what, /ever called cancelled without a confirmation/);
  assert.match(after.what, /phone is NOT built/);
  assert.match(after.what, /cannot tap/);

  await call("subscription_record", { merchant: "Hulu", amount: "$18.99", status: "cancelling" });
  const withOne = capabilitiesNow({ conversationId: C }).find(c => c.name === "subscriptions");
  assert.match(withOne.what, /1 mid-cancel with no confirmation yet/);
});

test("the prompt carries the rules the tools enforce", async () => {
  const { systemFor } = await import("../src/agent.js");
  const p = systemFor();
  assert.match(p, /subscription_list, ALWAYS/);
  assert.match(p, /Never name a subscription from memory/);
  assert.match(p, /Never say something is cancelled until something confirmed it/);
  assert.match(p, /offer to ring them once calling exists/);
  assert.match(p, /never ask for a password/i);
  assert.match(p, /page_blocks/);
});

// ---------- the whole errand, through the real tool loop ----------

test("'what am I paying for every month' → scan → records → a page they can open", async () => {
  await connectGoogle();
  const { used, said, calls } = await turnWithFakeModel(async ({ use }) => {
    // Nothing is known, so the honest first move is to go and read.
    const first = await use("subscription_list", {});
    assert.equal(first.count, 0);

    const scan = await use("subscriptions_scan", { months: 12 });
    const groups = scan.content.groups;

    // The model's judgement, which is the part a test cannot have: these four are subscriptions and
    // the Amazon desk lamp is not.
    for (const [domain, merchant, amount, cadence] of [
      ["netflix.com", "Netflix", "$17.99", "monthly"],
      ["spotify.com", "Spotify", "$11.99", "monthly"],
      ["adobe.com", "Adobe", "$239.88", "yearly"],
      ["onepeloton.com", "Peloton", "$44", "monthly"],
    ]) {
      const g = groups.find(x => x.sender_domain === domain);
      await use("subscription_record", {
        merchant, amount, cadence,
        source: `gmail ${g.messages[0].id} in ${g.messages[0].account}`,
        ...(g.messages[0].renewal_date ? { next_renewal: g.messages[0].renewal_date } : {}),
      });
    }

    const list = await use("subscription_list", { forgotten: [{ merchant: "Adobe", why: "nothing from them but the renewal warning" }] });
    const page = await use("page_create", { title: "What you're paying for", subtitle: "Read off 12 months of receipts", blocks: list.page_blocks });
    return `${list.a_month} a month across ${list.count} things. adobe's the one i'd look at. ${page.link}`;
  });

  assert.deepEqual(used.slice(0, 2), ["subscription_list", "subscriptions_scan"], "it reads before it claims");
  assert.equal(used.filter(t => t === "subscription_record").length, 4);
  assert.equal(db.listSubscriptions(C).length, 4, "and the desk lamp is not one of them");
  assert.equal(db.getSubscription(C, "Amazon.com"), null);

  const list = calls.find(c => c.tool === "subscription_list" && c.out.count === 4).out;
  assert.equal(list.a_month, "$93.97", "17.99 + 11.99 + 239.88/12 + 44");
  assert.match(said, /\$93\.97 a month/);
  assert.match(said, /\/p\//, "and the link to the page, which really exists");
  assert.equal(db.listPages(C).length, 1);
});

test("'cancel it' → route → the fixture service → a gated press → cancelled, with the proof", async () => {
  site.signIn();
  await call("subscription_record", { merchant: "Streamly", service: "streamly", amount: "$17.99", cadence: "monthly" });

  const messages = [owner("cancel streamly for me")];
  const { used, said } = await turnWithFakeModel(async ({ use }) => {
    const route = await use("cancel_route", { service: "streamly" });
    assert.equal(route.route.route, "web");

    const start = await use("subscription_cancel_start", { merchant: "Streamly" });
    assert.equal(start.ok, true, JSON.stringify(start));

    const cont = await use("browser_click", { ref: ref(start.page, e => e.tag === "button" && /Continue/i.test(e.name)), expect: "past the pause offer" });
    const commit = ref(cont, e => e.tag === "button" && /Finish Cancellation/i.test(e.name));

    // The details only exist on this screen, so this is the first moment a yes could mean anything.
    const what = "Streamly, $17.99 a month, access ends November 6, 2026, $5.00 early cancellation fee";
    const req = await use("confirm_request", { action: "subscription_cancel_commit", summary: `End Streamly. ${what}`, target: `Streamly: ${what}` });
    messages.push(owner("yep, kill it"));
    const rec = await use("confirm_record", { confirmation_id: req.confirmation_id });
    assert.equal(rec.state, "granted");

    const done = await use("subscription_cancel_commit", { merchant: "Streamly", ref: commit, what, confirmation_id: req.confirmation_id });
    assert.equal(done.status, "cancelled", JSON.stringify(done));
    return `done — streamly's cancelled. ${done.confirmation}. you can watch til nov 6`;
  }, { messages });

  assert.deepEqual(used, [
    "cancel_route", "subscription_cancel_start", "browser_click",
    "confirm_request", "confirm_record", "subscription_cancel_commit",
  ]);
  assert.equal(site.cancellations.length, 1);
  const row = db.getSubscription(C, "Streamly");
  assert.equal(row.status, "cancelled");
  assert.ok(row.confirmation.includes(site.cancellations[0].code));
  assert.match(said, new RegExp(site.cancellations[0].code));
  // And the errand is auditable end to end.
  const actions = db.listActions(C).map(a => a.action);
  assert.ok(actions.includes("subscription_cancel_start"));
  assert.ok(actions.includes("subscription_cancel_commit"));
});

// The flow test above hand-builds `Streamly: ${what}`, which is the one thing a model cannot do:
// the merchant prefix is in the gate and nowhere a model can see. Found on 2026-10-06 with the real
// model — it wrote the target itself exactly as the description then told it to, got `wrong_target`
// twice on the last screen, and had to ask him a second time for a yes he had already given. So
// both places that tell the model how to do this have to name `use_target`.
test("the model is told to take the target from the tool, not to type it", () => {
  const commit = tools.find(t => t.name === "subscription_cancel_commit");
  assert.match(commit.description, /use_target/, "the commit tool's own description");
  assert.doesNotMatch(commit.description, /target set to the same one-line/, "the instruction that sent it down the dead end");
});

test("and the web rail says the same thing in its next step", async () => {
  await call("subscription_record", { merchant: "Streamly", service: "streamly", amount: "$17.99", cadence: "monthly" });
  site.signIn();
  const started = await call("subscription_cancel_start", { merchant: "Streamly", service: "streamly" });
  assert.equal(started.rail, "web");
  assert.match(started.next, /use_target/);
});
