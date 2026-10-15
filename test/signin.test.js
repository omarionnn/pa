// Saved sign-ins: the person signs in, Reason keeps the session, and nobody ever types a password
// into a conversation.
//
// The things that have to hold, and what each one costs if it does not:
//
//   1. **Signed in is read off the site, never assumed.** A window that was closed proves nothing.
//      If closing a sign-in page counted as success, the next errand would set off believing it
//      had an account and die at a login screen with the owner told it was in hand.
//   2. **Signed out is provable; signed in is inferred, and says so.** The sites nobody could load
//      a signed-in page on have no positive marker, so `inferred` is set and the words say the
//      state was read from an absence. A probe that cannot recognise a signed-out page would
//      report every stranger as signed in, so that case is tested against each site's real markers.
//   3. **One profile per person, and no path to anybody else's.** The directory comes from the
//      conversation id and nothing else.
//   4. **No password, in words.** Reason's refusal is a value the tool returns, not something the
//      model is trusted to improvise.
//   5. **People who are not at the Mac are told the truth** — including that a password form is
//      ruled out rather than missing.
//
// No real site is touched: the signed-in reader is a pure function over a page's text and URL, so
// every state can be put to it exactly.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-signin-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";

const { runTool } = await import("../src/tools.js");
const signin = await import("../src/signin.js");
const sites = await import("../src/sites.js");
const browser = await import("../src/browser.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
const call = (name, input, conversationId = OMARI) => runTool(name, input, { conversationId, messages: [] });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM connected_accounts; DELETE FROM accounts; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
});

// ---------- reading a page ----------

test("each site's real signed-out page is read as signed out", () => {
  // These are the pages the 2026-10-05 probe actually loaded, reduced to the words and the landing
  // URL. If this ever stops passing, the markers in the registry have gone stale and the probe is
  // about to start calling strangers signed in.
  const cases = [
    ["amazon", "https://www.amazon.com/ap/signin?openid.return_to=x", "Sign in Email or mobile phone number Continue"],
    ["fandango", "https://www.fandango.com/accounts/sign-in?source=dashboard", "Sign in to Fandango Email* Password* Forgot your password?"],
    ["uber", "https://m.uber.com/go/home", "Uber Ride Rent Login Sign up Get a ride Pickup location Dropoff location"],
  ];
  for (const [name, url, text] of cases) {
    const out = sites.readSignedInState(sites.site(name), { url, text, status: 200 });
    assert.equal(out.state, "signed_out", `${name}: ${out.why}`);
    assert.ok(out.why, `${name} should say what gave it away`);
  }
});

test("the Uber trap: the words on its signed-out ride form must not read as signed in", () => {
  // The first draft of the registry used "pickup" and "where to" as signed-in markers. Both are on
  // m.uber.com while signed out, so every stranger would have been reported as signed in. This test
  // is that mistake, pinned.
  const out = sites.readSignedInState(sites.site("uber"), {
    url: "https://m.uber.com/go/home",
    text: "Get a ride Pickup location Dropoff location Pickup now For me Search Login Sign up",
    status: 200,
  });
  assert.equal(out.state, "signed_out");
});

test("a page with no sign-in prompt reads as signed in, and admits the reading is an inference", () => {
  const out = sites.readSignedInState(sites.site("amazon"), {
    url: "https://www.amazon.com/gp/css/order-history",
    text: "Your Orders Orders placed in the last 30 days. Delivered 2 October. Kettle, black.",
    status: 200,
  });
  assert.equal(out.state, "signed_in");
  assert.equal(out.inferred, true, "nobody has loaded a signed-in Amazon page here to learn what one says");
  assert.match(out.why, /asked for no sign-in/i);
  assert.match(out.why, /Inferred from what is absent/i);
});

test("a blocked or empty page is unknown, never signed in", () => {
  const amazon = sites.site("amazon");
  const blocked = [
    [{ url: "https://www.doordash.com/orders", text: "", status: 403 }, /HTTP 403/],
    [{ error: "net::ERR_HTTP2_PROTOCOL_ERROR" }, /ERR_HTTP2/],
    [{ url: "x", text: "Access Denied", status: 444 }, /HTTP 444/],
    [{ url: "https://www.amazon.com/gp/css/order-history", text: "  ", status: 200 }, /almost no readable text/],
  ];
  for (const [page, why] of blocked) {
    const out = sites.readSignedInState(amazon, page);
    assert.equal(out.state, "unknown", JSON.stringify(page));
    assert.match(out.why, why);
  }
  // The important half: "could not tell" is not "signed in". A site that answers a bot wall must
  // never produce a connected account.
  for (const [page] of blocked) assert.notEqual(sites.readSignedInState(amazon, page).state, "signed_in");
});

// ---------- what gets written down ----------

test("only a probe writes a sign-in, and a signed-out probe takes the connection away", () => {
  assert.equal(db.liveAccount(OMARI, "amazon"), null);

  db.recordSiteSignin(OMARI, "amazon", { state: "signed_in", evidence: "order history loaded" });
  const row = db.liveAccount(OMARI, "amazon");
  assert.equal(row.state, "signed_in");
  assert.equal(row.evidence, "order history loaded");
  assert.ok(row.checked_at);

  // The session expires and the next probe sees a login page. The row must stop claiming it works.
  db.recordSiteSignin(OMARI, "amazon", { state: "signed_out", evidence: "bounced to /ap/signin" });
  assert.equal(db.liveAccount(OMARI, "amazon"), null, "no longer connected");
  const last = db.lastSigninCheck(OMARI, "amazon");
  assert.equal(last.state, "signed_out");
  assert.match(last.evidence, /ap\/signin/, "and why is still answerable");
});

test("a check that found nothing is written down as a check, and still never reads as connected", () => {
  // Both halves matter. The fact that an attempt was made at a time belongs in the record — the
  // first version of this wrote nothing, and `npm run signin -- --list` then said "never checked"
  // one second after a real check, which reads as a tool that did not run.
  const row = db.recordSiteSignin(OMARI, "doordash", { state: "unknown", evidence: "HTTP 403" });
  assert.equal(row.state, "unknown");
  assert.match(row.evidence, /403/);
  assert.ok(row.checked_at);
  // And the half that must not slip: a row recording a failed check is not access.
  assert.ok(row.revoked_at, "it goes in already revoked");
  assert.equal(db.liveAccount(OMARI, "doordash"), null, "nothing anywhere may read as connected");
  assert.deepEqual(JSON.parse(row.scopes), [], "and it grants nothing");
});

test("a signed-out check shows up in the listing with when it happened", async () => {
  db.recordSiteSignin(OMARI, "amazon", { state: "signed_out", evidence: "bounced to /ap/signin" });
  const amazon = (await call("signin_status", { site: "amazon" })).sites[0];
  assert.equal(amazon.state, "signed_out");
  assert.ok(amazon.last_checked, "when, not 'never checked'");
  assert.match(amazon.evidence, /ap\/signin/);
  assert.equal(amazon.how_to_sign_in, "npm run signin -- amazon");
});

test("signin_status reports every site, when it was checked, and how to sign in", async () => {
  db.recordSiteSignin(OMARI, "amazon", { state: "signed_in", evidence: "order history loaded" });
  const out = await call("signin_status", {});
  assert.equal(out.ok, true);
  assert.equal(out.can_sign_in_here, true);
  assert.equal(out.sites.length, 9);

  const amazon = out.sites.find(s => s.site === "amazon");
  assert.equal(amazon.state, "signed_in");
  assert.ok(amazon.last_checked, "when it was checked is the point of the field");
  assert.equal(amazon.checked_minutes_ago, 0);
  assert.equal(amazon.how_to_sign_in, undefined, "already in, so nothing to do");

  const fandango = out.sites.find(s => s.site === "fandango");
  assert.equal(fandango.state, "never_signed_in");
  assert.equal(fandango.how_to_sign_in, "npm run signin -- fandango");

  // Never read as current without saying how old it is.
  assert.match(out.note, /from the last check, not from right now/i);
  assert.match(out.note, /recheck: true/);
});

test("signin_status says a stale check is stale", async () => {
  db.recordSiteSignin(OMARI, "amazon", { state: "signed_in", evidence: "order history loaded" });
  clock.skip(5 * 24 * 60 * 60 * 1000);
  const amazon = (await call("signin_status", { site: "amazon" })).sites[0];
  assert.equal(amazon.state, "signed_in");
  assert.equal(amazon.checked_minutes_ago, 7200, "five days, and it says so rather than implying now");
});

test("signin_status refuses a password in words, every time it is asked", async () => {
  for (const input of [{}, { site: "amazon" }]) {
    const out = await call("signin_status", input);
    assert.equal(out.never_a_password.rule, "no_passwords_in_chat");
    assert.match(out.never_a_password.say, /don't take passwords/i);
    assert.match(out.never_a_password.say, /even if you sent one I would not use it/i);
    // And the reason, so the refusal is an explanation rather than a wall.
    assert.match(out.never_a_password.say, /in your messages forever/i);
    assert.match(out.never_a_password.say, /password to one site is usually the password to your email/i);
    assert.match(out.never_a_password.why, /nothing typed there is saved or logged/i);
  }
});

test("a bad site name is refused with the list, not quietly ignored", async () => {
  // This used to use "netflix" as the name nothing knows. It is a real one now — the subscription
  // cancel rail signs in to a service exactly the way an errand site does (src/cancel-routes.js),
  // so the resolver answers for both lists. A name in neither is still refused with the list.
  const out = await call("signin_status", { site: "blockbuster" });
  assert.equal(out.ok, false);
  assert.match(out.error, /No site called 'blockbuster'/);
  assert.match(out.error, /opentable/);
  assert.match(out.error, /netflix/, "and the list now names the services a subscription cancels on");
  assert.equal((await call("signin_status", { recheck: true })).ok, false, "a recheck needs to know which site");
});

test("a service a subscription cancels on answers as one row, and the nine errand sites are untouched", async () => {
  const all = await call("signin_status", {});
  assert.equal(all.sites.length, 9, "the errand sites are what 'what is signed in' has always meant");

  const netflix = await call("signin_status", { site: "netflix" });
  assert.equal(netflix.ok, true);
  assert.equal(netflix.sites.length, 1);
  assert.equal(netflix.sites[0].site, "netflix");
  assert.equal(netflix.sites[0].state, "never_signed_in");
  assert.equal(netflix.sites[0].for_cancelling_a_subscription, true);
  assert.match(netflix.sites[0].how_to_sign_in, /signin_link/);
});

// ---------- who can sign in at all ----------

test("the operator is told the command; anybody else is told the truth", () => {
  const mine = signin.signinRoute(OMARI);
  assert.equal(mine.can_sign_in, true);
  // Reason opens the window itself now (signin_open); the command is the same thing from a terminal.
  assert.match(mine.how, /signin_open/);
  assert.match(mine.how, /window opens on the Mac you run on, on that site's sign-in page/i);
  assert.match(mine.how, /not on their phone/i);
  assert.match(mine.how, /password manager, a code by text, Face ID/i);
  assert.equal(mine.command, "npm run signin -- <site>");

  const theirs = signin.signinRoute(AMA);
  assert.equal(theirs.can_sign_in, false);
  assert.match(theirs.why, /no window to show you/i);
  // The part that must not drift: a password form is ruled out, not on a roadmap.
  assert.match(theirs.never, /don't take passwords/i);
  // With no public address (as here) the hosted browser exists and cannot be reached; that is
  // what is said, and not that it is unbuilt. With one, they are sent a link — see
  // test/signin-remote.test.js.
  assert.match(theirs.what_it_would_take, /hosted browser you sign in through is built/i);
  assert.match(theirs.what_it_would_take, /REASON_PUBLIC_URL/);
  assert.equal(theirs.by_link.available, false);
  assert.match(signin.remoteSigninAnswer("amazon").never, /not a missing feature/i);
});

test("for somebody who is not at the Mac, signin_status offers the honest answer and no form", async () => {
  const out = await call("signin_status", { site: "amazon" }, AMA);
  assert.equal(out.ok, true);
  assert.equal(out.can_sign_in_here, false);
  assert.equal(out.how, null);
  assert.equal(out.remote.possible, false);
  assert.match(out.remote.for_now, /Ask Omari to do the bit that needs an account/i);
  assert.equal(out.sites[0].state, "never_signed_in");
  assert.match(out.never_a_password.say, /don't take passwords/i);
  assert.doesNotMatch(JSON.stringify(out), /send me your password|enter your password/i);
});

// ---------- isolation ----------

test("one person's signed-in site is invisible and unusable from another's conversation", async () => {
  db.recordSiteSignin(OMARI, "amazon", { state: "signed_in", evidence: "order history loaded" });

  assert.equal(db.liveAccount(AMA, "amazon"), null, "nothing of Ama's says signed in");
  const hers = await call("signin_status", { site: "amazon" }, AMA);
  assert.equal(hers.sites[0].state, "never_signed_in");
  assert.equal(hers.sites[0].evidence, "", "not even the evidence leaks");

  // And "what can you reach" agrees, per person.
  assert.equal((await call("account_list", {})).accounts.find(a => a.name === "amazon").status, "connected");
  assert.equal((await call("account_list", {}, AMA)).accounts.find(a => a.name === "amazon").status, "not_connected");
});

test("each person's logins live in their own directory, derived from the conversation and nothing else", () => {
  const mine = browser.profileDirFor(OMARI);
  const theirs = browser.profileDirFor(AMA);
  assert.notEqual(mine, theirs);
  assert.match(mine, /dm_owner$/);
  // A conversation id cannot climb out of the profile root, however it is spelled.
  const nasty = browser.profileDirFor("../../../etc/passwd");
  assert.ok(nasty.includes("profiles"), nasty);
  assert.doesNotMatch(nasty, /etc\/passwd/);
  // And the sign-in command writes to the same place the errand browser reads from, which is the
  // whole mechanism: two different paths here would be a sign-in that silently did not take.
  assert.equal(signin.profileDir(OMARI), mine);
});

// ---------- the status is honest about the site, not just the sign-in ----------

test("a site that refuses Reason's browser says so next to its sign-in state", async () => {
  const out = await call("signin_status", {});
  const dd = out.sites.find(s => s.site === "doordash");
  assert.equal(dd.site_loads_for_reason, false);
  const amz = out.sites.find(s => s.site === "amazon");
  assert.equal(amz.site_loads_for_reason, true);
});

test("connecting a site through account_connect is refused, with the command instead", async () => {
  const out = await call("account_connect", { name: "amazon" });
  assert.equal(out.ok, false);
  // Not even reaching the gate: there is nothing a yes could authorize here, because the thing
  // that connects it is the person signing in.
  assert.equal(out.blocked, "needs_confirmation");

  // With a yes, it still refuses — and says what to do instead. (The full version of this, with a
  // granted confirmation, is in trust.test.js.)
  assert.match(signin.signinCommand("amazon"), /npm run signin -- amazon/);
});

// ---------- a ride site: signed in is identity; ride access is said apart from it ----------
//
// Verified 2026-10-15. Uber's browser route needs a sign-in page that refuses this browser from
// the server, and its API route needs a privileged scope. So "signed in" cannot be allowed to
// read as "can book": the ride's own state travels next to the sign-in state. (Lyft was removed
// the same day on the owner's word — no web ride flow, no developer programme, no sign-in page
// reachable from here — so the ride site is Uber, and a ride site is still required to say this.)

test("every ride site says what a sign-in gets you, and what to hand over when it is not a ride", () => {
  const rides = sites.SITES.filter(s => s.what === "book a ride");
  assert.ok(rides.length >= 1);
  for (const s of rides) {
    assert.ok(s.ride_access, `${s.site} needs ride_access: signed in alone does not say whether a ride can be booked`);
    assert.ok(["unverified", "unsupported", "works"].includes(s.ride_access.state), `${s.site}: ${s.ride_access.state}`);
    assert.ok(s.ride_access.means && s.ride_access.why && s.ride_access.handoff, `${s.site} says what it means, why, and the handoff`);
  }
  assert.equal(sites.site("uber").ride_access.state, "unverified");
  assert.match(sites.site("uber").ride_access.handoff, /uber_link/);
  assert.equal(sites.site("lyft"), null, "Lyft is gone from the registry");
});

test("a signed-in Uber is reported as signed in AND as ride access unverified, everywhere the model can ask", async () => {
  db.recordSiteSignin(OMARI, "uber", { state: "signed_in", evidence: "test: the ride page loaded and asked for no sign-in" });

  const status = await call("signin_status", { site: "uber" });
  const row = status.sites.find(r => r.site === "uber");
  assert.equal(row.state, "signed_in");
  assert.equal(row.ride_access.state, "unverified");
  assert.match(row.ride_access.means, /identity/i);

  const pb = await call("site_playbook", { site: "uber" });
  assert.equal(pb.playbook.signed_in, true);
  assert.equal(pb.playbook.ride_access.state, "unverified");
  assert.equal(pb.playbook.official_fallback, "uber_ride");
});

test("what's signed in carries the sign-in wall for Uber instead of a way to sign in", async () => {
  const status = await call("signin_status", {});
  const uber = status.sites.find(r => r.site === "uber");
  const amazon = status.sites.find(r => r.site === "amazon");
  assert.equal(uber.state, "never_signed_in");
  assert.ok(uber.signin_blocked?.why, "the wall is said");
  assert.equal(uber.signin_blocked.seen, "2026-10-15");
  assert.equal(uber.how_to_sign_in, undefined, "no way to sign in is offered — it would only show the wall");
  assert.ok(amazon.how_to_sign_in, "a site that loads still says how");
  assert.equal(status.sites.find(r => r.site === "lyft"), undefined, "and Lyft is not listed at all");
});
