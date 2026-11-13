// A CARD IS AN OFFER TO DO THE WHOLE JOB (Omari, 2026-11-12 23:00 ET; src/cardroutes.js, src/actionengine.js).
//
// The night before, the note carried four cards Reason could not finish (replace a key, verify a
// cloud account, fix a billing problem, cancel a subscription). One was tapped: a meaningless page
// and the same sign-in link three times. What these tests hold:
//
//   1. the sender check: Gmail's own verdict, passing and aligned with the From address; a spoofed
//      "your account is suspended" never becomes a card or a line, and cannot stand in for the real one
//   2. a route with the permission granted is a card; the same route without it is not
//   3. a site: a saved session that checks out NOW is a card; no saved session, a lapsed one, one that
//      could not be checked, and a site in the dated blocked findings are not
//   4. pay: a store the checkout has reached an exact total at is a card; one it has not, one that
//      needs their sign-in, no card on file, no checkout are not
//   5. call: a number in the candidate's own words, the line up, inside calling hours
//   6. "also worth knowing": only an authenticated notice, at most two, said once, one line on the
//      page with nothing to tap; no card but something worth knowing → one honest text, no link
//   7. nothing finishable and nothing worth knowing → nothing is sent
//   8. the tap: done only on proof (the ledger), pending while their yes is out and settled by the
//      sweep; a failed tap says one line, sends no link (the sign-in tools refuse, twice, and again
//      for the job that wakes up later), comes off the note, and is not offered again
//
// No model, no network, no API key.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cards-finish-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Kofi Mensah";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_TOKEN_KEY = "48".repeat(32);
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.SENDBLUE_FROM_NUMBER = "+14155550199";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_ACTION_CARDS = "on";
process.env.REASON_SHOP_CONNECT = "on";
process.env.REASON_BACKEND = "claude-cli";
process.env.REASON_CARDS_CLI_MODEL = "sonnet";

const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const cards = await import("../src/actioncards.js");
const engine = await import("../src/actionengine.js");
const routes = await import("../src/cardroutes.js");
const page = await import("../src/pages/actioncards.js");
const webnotes = await import("../src/pages/webnotes.js");
const harm = await import("../src/harm.js");
const google = await import("../src/google.js");
const signin = await import("../src/signin.js");
const findings = await import("../src/sitefindings.js");
await import("../src/shopconnect.js");
const background = await import("../src/background.js");
const { runTool } = await import("../src/tools.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { cliConfig } = await import("../src/backends/cli.js");
cliConfig.bin = join(dir, "no-claude-here");

const C = "dm:owner";
const TZ = "America/New_York";
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
// Tuesday 2026-11-17, 08:00 in New York.
const NOW = Date.parse("2026-11-17T13:00:00Z");
const ACCT = { account: "kofi@example.com", token: "tok" };
const tokensFor = async () => ({ ok: true, accounts: [ACCT] });
const FULL_SCOPE = `${google.GMAIL_SCOPE} ${google.CALENDAR_EVENTS_SCOPE} ${google.CALENDAR_READ_SCOPE}`;
const grant = (scope) => db.saveOauthTokens(C, google.PROVIDER, { accessToken: "at", refreshToken: "rt", scope, expiresAt: NOW + HOUR, accountLabel: ACCT.account });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  process.env.REASON_ACTION_CARDS = "on";
  process.env.REASON_SHOP_CONNECT = "on";
  process.env.REASON_BACKEND = "claude-cli";
  config.autoAdmit = true;
  config.onboarding = "off";
  engine.resetEngine();
  engine.setCardsAsk(async () => ({ value: { cards: [], skipped: [] } }));
  background.resetLane({ gapMs: 0 });
  db.db.exec(`DELETE FROM action_digests; DELETE FROM action_cards; DELETE FROM action_card_dismissed; DELETE FROM action_card_events;
    DELETE FROM action_card_days; DELETE FROM action_card_sources; DELETE FROM card_skip_rules; DELETE FROM treat_rules;
    DELETE FROM messages; DELETE FROM timers; DELETE FROM flights; DELETE FROM subscriptions; DELETE FROM notice_seen; DELETE FROM notice_budget;
    DELETE FROM usage; DELETE FROM accounts; DELETE FROM outbox; DELETE FROM conversations; DELETE FROM event_log; DELETE FROM oauth_tokens;
    DELETE FROM site_findings; DELETE FROM shop_cards; DELETE FROM shop_runs; DELETE FROM shop_payments; DELETE FROM action_ledger;
    DELETE FROM confirmations; DELETE FROM held_actions; DELETE FROM calls; DELETE FROM tasks; DELETE FROM threads; DELETE FROM inbound_messages;`);
  db.db.exec("DELETE FROM connected_accounts");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Kofi Mensah", isOperator: true });
});

// ---------------------------------------------------------------- a fake Google

const PASS = (d) => `mx.google.com; dkim=pass header.i=@${d} header.s=s1 header.b=abc; spf=pass (google.com: domain of bounce@${d} designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@${d}; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${d}`;
const domainIn = (From) => (/@([^>\s]+)/.exec(From)?.[1] ?? "example.com").toLowerCase();
/** `auth`: undefined = Gmail's passing verdict for the From domain; null = no verdict at all; a string or an array = exactly that. */
const msg = ({ id, thread = id, from, subject, date = "Mon, 16 Nov 2026 09:00:00 -0500", snippet = "", unread = true, auth, extra = {}, labels = [] }) => ({
  id, threadId: thread, labelIds: [...(unread ? ["INBOX", "UNREAD"] : ["INBOX"]), ...labels], snippet,
  payload: { headers: [
    ...(auth === null ? [] : (Array.isArray(auth) ? auth : [auth ?? PASS(domainIn(from))]).map(value => ({ name: "Authentication-Results", value }))),
    { name: "From", value: from }, { name: "Subject", value: subject }, { name: "Date", value: date }, { name: "To", value: ACCT.account },
    ...Object.entries(extra).map(([name, value]) => ({ name, value })),
  ] },
});
const ev = ({ id, summary, start, self = "accepted", organizer = "ana@example.com" }) => ({
  id, summary, status: "confirmed", organizer: { email: organizer },
  start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + HOUR).toISOString() },
  attendees: [{ email: ACCT.account, responseStatus: self, self: true }, { email: organizer, responseStatus: "accepted", displayName: "Ana Lopez" }],
});
function fakeGoogle({ mail = [], events = [] } = {}) {
  const byId = new Map(mail.map(m => [m.id, m]));
  const subjOf = (m) => m.payload.headers.find(h => h.name === "Subject")?.value ?? "";
  const asked = [];
  const read = async (acct, method, path, opts = {}) => {
    asked.push({ method, path, headers: opts.query?.metadataHeaders ?? null });
    if (method !== "GET") throw new Error("the morning only reads");
    const q = String(opts.query?.q ?? "");
    if (path === "/gmail/v1/users/me/messages") {
      const notices = /newer_than:30d/.test(q);
      const pick = mail.filter(m => (notices ? /expir|suspen|on hold|action required|response required|payment failed|declined|past due|overdue|renew|turned off/i.test(subjOf(m)) : m.labelIds.includes("UNREAD")));
      return { ok: true, status: 200, body: { messages: pick.map(m => ({ id: m.id, threadId: m.threadId })) } };
    }
    let m;
    if ((m = path.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/))) { const one = byId.get(decodeURIComponent(m[1])); return one ? { ok: true, status: 200, body: one } : { ok: false, status: 404 }; }
    if ((m = path.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/))) { const list = mail.filter(x => x.threadId === decodeURIComponent(m[1])); return list.length ? { ok: true, status: 200, body: { messages: list } } : { ok: false, status: 404 }; }
    if (path === "/calendar/v3/calendars/primary/events") return { ok: true, status: 200, body: { items: events } };
    return { ok: false, status: 404 };
  };
  return { read, asked };
}

/** A scripted Stage 2: `plan(key, line)` gives the entry's fields for a candidate, or null to skip it. */
function scripted(plan) {
  const seen = [];
  const ask = async ({ prompt }) => {
    const made = [];
    for (const m of prompt.matchAll(/^- \[([^\]]+)\] (.*)$/gm)) {
      seen.push(m[1]);
      const e = plan(m[1], m[2]);
      if (e) made.push({ candidate_key: m[1], job: "do the whole thing; done when it is through", site: "", phone: "", verb: "CANCEL", why_now: "It is due soon.", offer: "want me to do it?", drawing: "note", urgency: 3, effort_saved: 3, ...e, prefill: e.prefill ?? String(e.title ?? "").replace(/\byour\b/gi, "my") });
    }
    return { value: { cards: made, skipped: [] }, usage: { input_tokens: 1000, output_tokens: 200 }, models: ["claude-sonnet-5-5"] };
  };
  return { ask, seen };
}
function fakeRuntime() {
  const sent = [];
  return { sent, mayInterrupt: () => true, _tell: async (c, text, meta) => { sent.push({ c, text, ...meta }); return { ok: true }; } };
}
const morning = (g, ask, extra = {}) => engine.runMorning(C, { now: NOW, tz: TZ, read: g.read, ask, tokensFor, ...extra });

// The four notices of 2026-11-12, as fixtures (invented addresses and wording; the shapes are real).
const KEY = () => msg({ id: "key", from: "Anthropic <no-reply@mail.anthropic.com>", subject: "Your API key \"Workbench\" expires on Nov 24", snippet: "The key expires on Nov 24. Create a new key in the Console before then.", unread: false });
const AWS = () => msg({ id: "aws", from: "Amazon Web Services <no-reply-aws@amazon.com>", subject: "Action required: your AWS account is suspended", snippet: "Your account is suspended. Verify your identity in the console to restore access.", unread: false });
const BILL = () => msg({ id: "bill", from: "Anthropic <billing@mail.anthropic.com>", subject: "Your payment failed and API access is turned off", snippet: "We could not process your payment. Update your billing details to restore access.", unread: false });

// ---------------------------------------------------------------- 1. the sender check

test("the sender check: Gmail's own verdict, passing and aligned with the From address; nothing else counts", () => {
  const h = (...values) => values.map(value => ({ name: "Authentication-Results", value }));
  const check = (from, ...values) => routes.senderCheck({ headers: h(...values), from });
  assert.deepEqual(check("no-reply-aws@amazon.com", PASS("amazon.com")), { pass: true, why: "dmarc" });
  // The From address at or under the domain Gmail checked lines up; a subdomain does not speak for its parent.
  assert.equal(check("billing@mail.anthropic.com", PASS("anthropic.com")).pass, true);
  assert.equal(check("billing@anthropic.com", PASS("mail.anthropic.com")).pass, false, "a subdomain's pass is not its parent's");
  assert.equal(check("billing@shop.example.co.uk", PASS("example.co.uk")).pass, true);
  assert.equal(check("billing@other.co.uk", PASS("example.co.uk")).pass, false, "co.uk is not an organisation");
  // Two tenants of one shared suffix do not speak for each other, by DMARC or by signature.
  assert.deepEqual(check("billing@victim.github.io", PASS("attacker.github.io")), { pass: false, why: "dmarc_other_domain" });
  assert.equal(check("billing@victim.github.io", "mx.google.com; dkim=pass header.i=@attacker.github.io header.s=a header.b=b; spf=pass smtp.mailfrom=x@attacker.github.io").pass, false);
  // Gmail prints ONE DMARC verdict: with a second one in its header (a crafted address echoed into it) nothing passes.
  assert.deepEqual(check("no-reply-aws@amazon.com", "mx.google.com; spf=pass smtp.mailfrom=x; dmarc=pass header.from=amazon.com; dkim=fail header.i=@amazon.com; dmarc=fail (p=REJECT) header.from=amazon.com"), { pass: false, why: "dmarc_twice" });
  assert.deepEqual(check("no-reply-aws@amazon.com", "mx.google.com; dmarc=fail (p=REJECT) header.from=amazon.com; dmarc=pass header.from=amazon.com"), { pass: false, why: "dmarc_twice" });
  // A trailing dot or capitals in either name change nothing.
  assert.equal(check("Billing@Mail.Anthropic.COM", PASS("anthropic.com.")).pass, true);
  // DMARC failed: a fail whatever else passed (the classic spoof: somebody else's signature, the victim's From).
  const spoof = "mx.google.com; dkim=pass header.i=@bulk-mailer.example header.s=x header.b=y; spf=softfail (google.com: domain of transitioning x@bulk-mailer.example does not designate 203.0.113.9 as permitted sender) smtp.mailfrom=x@bulk-mailer.example; dmarc=fail (p=QUARANTINE sp=QUARANTINE dis=QUARANTINE) header.from=amazon.com";
  assert.deepEqual(check("no-reply-aws@amazon.com", spoof), { pass: false, why: "dmarc_fail" });
  // No DMARC verdict: a passing signature of the From address's own domain counts; anyone else's does not; SPF alone never.
  assert.deepEqual(check("billing@acme.example", "mx.google.com; dkim=pass header.i=@acme.example header.s=a header.b=b; spf=pass smtp.mailfrom=bounce@acme.example"), { pass: true, why: "dkim_aligned" });
  assert.equal(check("billing@acme.example", "mx.google.com; dkim=pass header.d=sendgrid.net header.s=a header.b=b; spf=pass smtp.mailfrom=bounce@sendgrid.net").pass, false);
  assert.equal(check("billing@acme.example", "mx.google.com; spf=pass (google.com: domain of x@acme.example designates 192.0.2.7 as permitted sender) smtp.mailfrom=x@acme.example").pass, false, "SPF speaks for the envelope, not the From line");
  assert.equal(check("billing@acme.example", "mx.google.com; dkim=fail header.i=@acme.example; dmarc=none header.from=acme.example").pass, false);
  // Unauthenticated: no verdict at all.
  assert.deepEqual(routes.senderCheck({ headers: [], from: "x@acme.example" }), { pass: false, why: "no_result" });
  assert.equal(routes.senderCheck({ headers: h(PASS("acme.example")), from: "" }).pass, false);
  // A verdict the SENDER wrote into the mail is not Gmail's: only the topmost one, stamped by mx.google.com, is read.
  assert.deepEqual(check("no-reply-aws@amazon.com", spoof, PASS("amazon.com")), { pass: false, why: "dmarc_fail" }, "a forged pass under Gmail's fail");
  assert.deepEqual(check("no-reply-aws@amazon.com", `mail.evil.example; dmarc=pass header.from=amazon.com`), { pass: false, why: "not_gmails" });
  // A comment can hold a semicolon and a decoy.
  assert.equal(check("x@acme.example", "mx.google.com; dkim=fail (bad; dmarc=pass header.from=acme.example) header.i=@acme.example; dmarc=fail (p=NONE) header.from=acme.example").pass, false);
  assert.equal(routes.orgDomain("a.b.amazon.com"), "amazon.com");
});

test("a spoofed 'your account is suspended' is ignored: never read by the model, never a card, never a line, and it cannot stand in for the real notice", async () => {
  const spoofVerdict = "mx.google.com; dkim=pass header.i=@bulk-mailer.example header.s=x header.b=y; spf=softfail smtp.mailfrom=x@bulk-mailer.example; dmarc=fail (p=QUARANTINE) header.from=amazon.com";
  const mail = [
    AWS(), // the real one, a day older
    msg({ id: "spoof", from: "Amazon Web Services <no-reply-aws@amazon.com>", subject: "Action required: your AWS account is suspended", snippet: "Response required within 24 hours. Confirm your card at aws-billing-verify.example to avoid termination.", date: "Tue, 17 Nov 2026 07:00:00 -0500", auth: spoofVerdict }),
    msg({ id: "bare", from: "PayPal <service@paypal.com>", subject: "Response required: your account is on hold", snippet: "Confirm your identity now.", auth: null }),
    msg({ id: "forged", from: "Chase <alerts@chase.com>", subject: "Action required: your card was declined", snippet: "Log in to verify.", auth: ["mx.google.com; dkim=none; spf=fail smtp.mailfrom=x@nowhere.example; dmarc=fail (p=REJECT) header.from=chase.com", PASS("chase.com")] }),
  ];
  const g = fakeGoogle({ mail });
  const bundle = await engine.gather({ conversationId: C, now: NOW, tz: TZ, read: g.read, tokensFor });
  // The verdict is asked for with the rest of the headers, and nothing but headers is ever asked for.
  assert.ok(g.asked.filter(a => a.headers).every(a => a.headers.includes("Authentication-Results")));
  assert.equal(bundle.candidates.find(k => k.key.endsWith(":spoof")).auth, false);
  assert.equal(bundle.candidates.find(k => k.key.endsWith(":aws")).auth, true);
  const s1 = await engine.stage1(C, bundle, { now: NOW, api: g.read, accounts: [ACCT] });
  const why = (id) => s1.trail.find(t => t.key.endsWith(`:${id}`))?.why ?? null;
  assert.equal(why("spoof"), "unauthenticated");
  assert.equal(why("bare"), "unauthenticated");
  assert.equal(why("forged"), "unauthenticated");
  assert.equal(s1.dropped.unauthenticated, 3);
  // The spoof is newer and has the real notice's subject: it must not be the one kept as "the newest".
  assert.deepEqual(s1.keep.map(k => k.key.split(":").at(-1)), ["aws"]);
  // End to end: the model is shown the real one only; what it says about the spoof would be dropped anyway.
  const { ask, seen } = scripted((key) => ({ route: "none", title: "Verify your AWS account to lift the suspension", lead: "your AWS account is suspended" }));
  const rt = fakeRuntime();
  const r = await morning(g, ask, { runtime: rt });
  assert.deepEqual(seen.map(k => k.split(":").at(-1)), ["aws"]);
  assert.equal(r.outcome, "known");
  assert.equal(rt.sent.length, 1);
  assert.doesNotMatch(rt.sent[0].text, /paypal|chase|card was declined|on hold/i);
});

// ---------------------------------------------------------------- 2. a route with its permission, and without

test("calendar and email: with the grant a card, without it none; a machine's mail and a chat line are never an email card", async () => {
  const mail = [
    msg({ id: "dent", from: "Bright Smiles Dental <office@brightsmiles.example>", subject: "Please confirm your appointment Nov 20, reply YES", snippet: "Reply YES to confirm your cleaning on Nov 20 at 10am." }),
    msg({ id: "bot", from: "Scheduler <no-reply@clinic.example>", subject: "Action required: confirm your appointment Nov 21", snippet: "Confirm in the patient portal." }),
  ];
  const events = [ev({ id: "q4", summary: "Q4 planning", start: NOW + 5 * DAY, self: "needsAction" })];
  const g = fakeGoogle({ mail, events });
  db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, 'user', 'test', ?, ?)").run(C, "I need to email my landlord about the lease before Friday", NOW - DAY);
  const plan = (key) => key.startsWith("cal:") ? { route: "calendar", verb: "ACCEPT", title: "Accept Ana's Q4 planning invite for Nov 22", lead: "Ana's Q4 planning invite for Nov 22 is waiting on you" }
    : key.endsWith(":dent") ? { route: "email", verb: "CONFIRM", title: "Confirm your dental cleaning for Nov 20", lead: "your dentist wants a yes for Nov 20" }
    : key.endsWith(":bot") ? { route: "email", verb: "CONFIRM", title: "Confirm your clinic appointment for Nov 21", lead: "your clinic wants a yes for Nov 21" }
    : key.startsWith("chat:") ? { route: "email", verb: "SEND", title: "Send your landlord the lease question before Friday", lead: "your lease question is due Friday" } : null;

  // No Google grant on record at all: nothing is a card. (The clinic's notice is at most a line: see the "worth knowing" tests.)
  let r = await morning(g, scripted(plan).ask, { dry: true });
  assert.equal(r.ranked.cards.length, 0);
  assert.equal(r.outcome, "known");
  assert.deepEqual(r.known.map(k => k.line), ["your clinic wants a yes for Nov 21"]);
  assert.deepEqual(r.gate.why, { no_google_account: 2, nobody_reads_replies: 1, no_address_to_send_to: 1 });

  // Calendar granted, sending mail not: the invite is a card, the reply is not.
  grant(`${google.CALENDAR_EVENTS_SCOPE} ${google.CALENDAR_READ_SCOPE}`);
  r = await morning(g, scripted(plan).ask, { dry: true });
  assert.deepEqual(r.ranked.cards.map(k => k.routed.route), ["calendar"]);
  assert.equal(r.gate.why.no_send_permission, 1);

  // Sending granted, the calendar not: the other way round.
  grant(google.GMAIL_SCOPE);
  r = await morning(g, scripted(plan).ask, { dry: true });
  assert.deepEqual(r.ranked.cards.map(k => k.routed.route), ["email"]);
  assert.equal(r.gate.why.no_calendar_permission, 1);

  // Both granted: two cards. The no-reply clinic and the chat line still are not: nobody reads the one, and code cannot see who the other goes to.
  grant(FULL_SCOPE);
  const rt = fakeRuntime();
  r = await morning(g, scripted(plan).ask, { runtime: rt });
  assert.equal(r.outcome, "cards");
  const d = cards.digestById(r.digest);
  assert.deepEqual(d.cards.map(c => c.verb).sort(), ["ACCEPT", "CONFIRM"]);
  assert.deepEqual(d.also.map(a => a.line), ["your clinic wants a yes for Nov 21"]);
  assert.deepEqual(r.gate.why, { nobody_reads_replies: 1, no_address_to_send_to: 1 });
  // Each card keeps the route it promised (sealed with its source), and what DONE will mean.
  const kept = d.cards.map(c => engine.routeOf(c.id, C));
  assert.deepEqual(kept.map(k => k.route).sort(), ["calendar", "email"]);
  assert.ok(kept.every(k => k.outcome === "" && k.job));
  assert.match(rt.sent[0].text, /^morning kofi\. .* that and one more: https:\/\/heyreason\.com\/a\//);
  // The day's row says what the gate dropped, as reason words only.
  const row = engine.dayRow(C, "2026-11-17");
  assert.equal(row.outcome, "cards"); assert.equal(row.cards, 2);
  assert.equal(JSON.parse(row.dropped)["route:nobody_reads_replies"], 1);
});

// ---------------------------------------------------------------- 3. a site: a session that checks out now

test("a site: a saved session that checks out now is a card; none, lapsed, unchecked, or a blocked site is not", async () => {
  db.db.prepare("INSERT INTO timers (conversation_id, fire_at, note) VALUES (?, ?, ?)").run(C, NOW + 9 * DAY, "Remind Kofi to cancel Cardboard Starter before it renews Nov 27");
  const g = fakeGoogle();
  const plan = () => ({ route: "site", site: "cardboard.example", verb: "CANCEL", title: "Cancel your Cardboard Starter before it renews Nov 27", lead: "your Cardboard Starter renews Nov 27" });
  const entry = signin.anyEntryFor("cardboard.example");
  let probes = 0;
  const live = (state) => engine.setRouteDeps({ liveSession: async () => { probes++; return { state }; } });
  const run = async () => { const r = await morning(g, scripted(plan).ask, { dry: true }); return r.outcome === "cards" ? "card" : Object.keys(r.gate.why)[0]; };

  // Never signed in there: no card, and the site is not even asked.
  live("signed_in");
  assert.equal(await run(), "no_saved_session");
  assert.equal(probes, 0);
  // A reminder is theirs, not a notice: with no card there is nothing to say either.
  assert.equal((await morning(g, scripted(plan).ask, { dry: true })).known.length, 0);

  // A saved session that the site confirms right now: the card.
  db.recordSiteSignin(C, entry.site, { state: "signed_in", evidence: "the account page loaded" });
  assert.equal(await run(), "card");
  assert.equal(probes, 1, "the site was asked now, not a cookie trusted");

  // The same record, but the site now says signed out, or could not be read: no card.
  live("signed_out"); assert.equal(await run(), "session_lapsed");
  live("unknown"); assert.equal(await run(), "session_unchecked");

  // The site refuses Reason's browser (the dated findings, PR #521): no card, saved session or not.
  live("signed_in");
  findings.recordFinding(entry, { kind: "walled", status: 403, why: "its sign-in page answered Reason's browser with HTTP 403" });
  probes = 0;
  assert.equal(await run(), "site_blocked");
  assert.equal(probes, 0);
  db.db.exec("DELETE FROM site_findings");
  assert.equal(await run(), "card");
  // A registry site with a standing block of its own is the same.
  const walled = signin.signinNames().map(n => signin.anyEntryFor(n)).find(e => e?.signin_blocked);
  if (walled) {
    db.recordSiteSignin(C, walled.site, { state: "signed_in", evidence: "t" });
    const out = await routes.checkRoute(C, { route: "site", site: new URL(walled.signin_url).hostname }, { source: "own", kind: "reminder" }, { now: NOW, deps: { liveSession: async () => ({ state: "signed_in" }) } });
    assert.deepEqual(out, { ok: false, why: "site_blocked" });
  }
  // No site named at all, or a route that is not one.
  assert.deepEqual(await routes.checkRoute(C, { route: "site", site: "" }, {}, { now: NOW }), { ok: false, why: "no_site" });
  assert.deepEqual(await routes.checkRoute(C, { route: "remind" }, {}, { now: NOW }), { ok: false, why: "no_route" });
});

// ---------------------------------------------------------------- 4. pay: a total the checkout can reach

test("pay: a store the checkout has reached an exact total at is a card; unreachable, needs their sign-in, no card on file or no checkout is not", async () => {
  const mail = [msg({ id: "water", from: "Acme Water <billing@acmewater.example>", subject: "Your bill is due Nov 20", snippet: "Your water bill of $48.10 is due Nov 20. Pay online without signing in at acmewater.example/pay." })];
  const g = fakeGoogle({ mail });
  let site = "acmewater.example";
  const plan = () => ({ route: "pay", site, verb: "PAY", title: "Pay your water bill before Nov 20", lead: "your water bill is due Nov 20", drawing: "bag" });
  const run = async () => { const r = await morning(g, scripted(plan).ask, { dry: true }); return r.outcome === "cards" ? "card" : Object.keys(r.gate.why)[0]; };
  const saveCard = (registered = 1) => db.db.prepare("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_1', 'visa', '4242', ?, ?)").run(C, NOW - DAY, registered);
  const reached = (store, status = "paid") => {
    db.db.prepare("INSERT INTO shop_runs (run_id, conversation_id, store, mode, status, created_at, updated_at) VALUES (?, ?, ?, 'guest', 'done', ?, ?)").run(`run-${store}`, C, store, NOW - 30 * DAY, NOW - 30 * DAY);
    db.db.prepare("INSERT INTO shop_payments (conversation_id, run_id, request_id, amount, currency, amount_kind, status, created_at) VALUES (?, ?, ?, '48.10', 'USD', 'exact', ?, ?)").run(C, `run-${store}`, `rq-${store}`, status, NOW - 30 * DAY);
  };

  assert.equal(await run(), "no_card_on_file");
  saveCard(0);
  assert.equal(await run(), "no_card_on_file", "a card Crossmint has not registered cannot pay");
  saveCard(1);
  // The biller's public pay page, never tried: nobody knows the checkout gets to a total there. Not a card.
  assert.equal(await run(), "total_not_reachable");
  // Somebody else's checkout reaching a total there says nothing for this person's.
  db.db.prepare("INSERT INTO shop_runs (run_id, conversation_id, store, mode, status, created_at, updated_at) VALUES ('run-other', 'dm:other', 'acmewater', 'guest', 'done', ?, ?)").run(NOW, NOW);
  db.db.prepare("INSERT INTO shop_payments (conversation_id, run_id, request_id, amount, currency, amount_kind, status, created_at) VALUES ('dm:other', 'run-other', 'rq-other', '9', 'USD', 'exact', 'paid', ?)").run(NOW);
  assert.equal(await run(), "total_not_reachable");
  // Their own checkout got to an exact total there before: reachable, a card.
  reached("acmewater");
  assert.equal(await run(), "card");
  const r = await morning(g, scripted(plan).ask, { dry: true });
  assert.equal(r.ranked.cards[0].routed.target, "pay:acmewater");
  // A store that needs an account of theirs they have not connected: they would have to sign in. Not a card.
  site = "amazon.com";
  reached("amazon");
  assert.equal(await run(), "store_needs_their_sign_in");
  // No site named, or the checkout not on for them.
  site = "";
  assert.equal(await run(), "no_site");
  site = "acmewater.example";
  process.env.REASON_SHOP_CONNECT = "off";
  assert.equal(await run(), "no_checkout");
});

// ---------------------------------------------------------------- 5. call

test("call: the number is in the candidate's own words, the line is up, and it is calling hours where the phone rings", async () => {
  const cand = { source: "mail", kind: "mail_unread", line: "Dr. Lee's office: \"Please call to confirm\" — call us at (212) 555-0142 to confirm Tuesday 3pm", snippet: "call us at (212) 555-0142", subject: "Please call to confirm" };
  const up = { callsLive: () => true };
  const ok = await routes.checkRoute(C, { route: "call", phone: "212-555-0142" }, cand, { now: NOW, deps: up });
  assert.deepEqual(ok, { ok: true, route: "call", target: "call:2125550142", phone: "+12125550142" });
  // A number the model produced that the candidate never carried: not rung.
  assert.deepEqual(await routes.checkRoute(C, { route: "call", phone: "212-555-0199" }, cand, { now: NOW, deps: up }), { ok: false, why: "no_number_on_it" });
  assert.deepEqual(await routes.checkRoute(C, { route: "call", phone: "" }, cand, { now: NOW, deps: up }), { ok: false, why: "no_number_on_it" });
  // No phone line wired up (the default until the runtime says otherwise).
  assert.deepEqual(await routes.checkRoute(C, { route: "call", phone: "212-555-0142" }, cand, { now: NOW }), { ok: false, why: "no_phone_line" });
  // 8:00 in New York is 5:00 in San Francisco: the call-hours rule holds it, so it is not a card now.
  const west = { ...cand, line: "call us at (415) 555-0142", snippet: "" };
  assert.deepEqual(await routes.checkRoute(C, { route: "call", phone: "(415) 555-0142" }, west, { now: NOW, deps: up }), { ok: false, why: "outside_call_hours" });
  assert.equal((await routes.checkRoute(C, { route: "call", phone: "(415) 555-0142" }, west, { now: NOW + 4 * HOUR, deps: up })).ok, true);
});

// ---------------------------------------------------------------- 6. also worth knowing

test("also worth knowing: only an authenticated notice, at most two, said once; with no card the text is one honest line and no link", async () => {
  const mail = [KEY(), AWS(), BILL(),
    msg({ id: "dom", from: "Registrar <no-reply@registrar.example>", subject: "Your domain kofi.example renews on Dec 2", snippet: "Auto-renew is on. Your card will be charged on Dec 2.", unread: false })];
  const g = fakeGoogle({ mail });
  db.db.prepare("INSERT INTO timers (conversation_id, fire_at, note) VALUES (?, ?, ?)").run(C, NOW + 9 * DAY, "Remind Kofi to cancel Cardboard Starter before it renews Nov 27");
  // What the model says of each: the truth. None of the four can be finished; the key one it hopes to do on the site.
  const plan = (key) => key.endsWith(":key") ? { route: "site", site: "console.anthropic.com", verb: "REPLACE", title: "Replace your Anthropic key before it expires Nov 24", lead: "your Anthropic API key expires Nov 24", urgency: 4 }
    : key.endsWith(":aws") ? { route: "none", title: "Verify your AWS account to lift the suspension", lead: "your AWS account is suspended until you verify it", urgency: 5 }
    : key.endsWith(":bill") ? { route: "none", title: "Fix your Anthropic billing so API access returns", lead: "your Anthropic API access is off after a failed payment", urgency: 5 }
    : key.endsWith(":dom") ? { route: "none", title: "Renew your domain", lead: "your domain renews Dec 2", urgency: 2 }
    : { route: "site", site: "cardboard.example", verb: "CANCEL", title: "Cancel your Cardboard Starter before it renews Nov 27", lead: "your Cardboard Starter renews Nov 27", urgency: 3 };
  const rt = fakeRuntime();
  const r = await morning(g, scripted(plan).ask, { runtime: rt });
  // Not one card: Reason holds no session at either site, and "none" is none.
  assert.equal(r.outcome, "known");
  assert.equal(r.ranked.cards.length, 0);
  assert.deepEqual(r.gate.why, { no_saved_session: 2, model_said_cannot_finish: 3 });
  // Four notices could be mentioned; two are, the most pressing. The reminder is theirs: never a line.
  assert.equal(r.gate.known.length, 4);
  assert.deepEqual(r.known.map(k => k.key.split(":").at(-1)).sort(), ["aws", "bill"]);
  // One text. It names the two things, offers nothing, and carries no link.
  assert.equal(rt.sent.length, 1);
  assert.equal(rt.sent[0].text, "morning kofi. nothing i can finish for you today. worth knowing: your AWS account is suspended until you verify it, and your Anthropic API access is off after a failed payment.");
  assert.doesNotMatch(rt.sent[0].text, /https?:|want me to|i can (?!finish)|tap/i);
  assert.equal(rt.sent[0].idempotencyKey, `cards:${C}:2026-11-17:morning`);
  // The record: a note with no card and two lines, closed as written (there is no page to open).
  const d = cards.digestById(r.digest);
  assert.equal(d.cards.length, 0); assert.equal(d.also.length, 2); assert.equal(d.gone, true);
  assert.equal((await page.actionCardsRequest({ method: "GET", path: `/a/${d.token}`, now: NOW })).status, 410);
  assert.equal(cards.openCards(C).length, 0, "a line is not an open card");
  assert.equal(cards.matchInbound(C, ["your AWS account is suspended until you verify it"]), null, "and a text never matches one");
  const row = engine.dayRow(C, "2026-11-17");
  assert.equal(row.outcome, "known"); assert.equal(row.cards, 0); assert.equal(row.texts_sent, 1);
  assert.equal(engine.ranToday(C, "2026-11-17"), true, "one note a day: this was it");
  // "Where did you see that?" still has an answer, as a class and a day.
  assert.match(engine.sourceOf(C, d.also[0].id).from, /^from a mail on /);

  // An address never rides in a line or a title: the entry is dropped, not trimmed.
  const known1 = new Set(["mail:a:1"]);
  assert.equal(engine.validCard({ candidate_key: "mail:a:1", route: "none", lead: "your AWS account on kofi@example.com is suspended", urgency: 5, effort_saved: 2 }, known1), null);
  assert.ok(engine.validCard({ candidate_key: "mail:a:1", route: "none", lead: "AWS suspended your account on Nov 11", urgency: 5, effort_saved: 2 }, known1));
  assert.match(engine.systemPrompt({ name: "Kofi", day: "Tuesday", tz: TZ }), /the day it was SENT/);

  // The next morning: the two that were said are not said again; the two that were not, are.
  const next = NOW + DAY;
  const rt2 = fakeRuntime();
  const r2 = await engine.runMorning(C, { now: next, tz: TZ, read: g.read, ask: scripted(plan).ask, tokensFor, runtime: rt2 });
  assert.equal(r2.stage1.dropped.seen, 2);
  assert.deepEqual(r2.known.map(k => k.key.split(":").at(-1)).sort(), ["dom", "key"]);
  // And the morning after that there is nothing left to say: nothing is sent.
  const rt3 = fakeRuntime();
  const r3 = await engine.runMorning(C, { now: next + DAY, tz: TZ, read: g.read, ask: scripted(plan).ask, tokensFor, runtime: rt3 });
  assert.equal(r3.outcome, "empty");
  assert.equal(rt3.sent.length, 0);
});

test("a line the day's cap kept back was never said: nothing is recorded, and it is still sayable the next morning", async () => {
  const g = fakeGoogle({ mail: [AWS()] });
  const plan = () => ({ route: "none", title: "Verify your AWS account", lead: "AWS suspended your account on Nov 16", urgency: 5 });
  const capped = { sent: [], mayInterrupt: () => false, _tell: async () => { throw new Error("must not be asked to send"); } };
  const r = await morning(g, scripted(plan).ask, { runtime: capped });
  assert.equal(r.outcome, "empty"); assert.equal(r.why, "known_unsent"); assert.equal(r.texted, false);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM action_digests").get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM action_card_sources").get().n, 0);
  assert.equal(engine.dayRow(C, "2026-11-17").outcome, "empty");
  const rt = fakeRuntime();
  const r2 = await engine.runMorning(C, { now: NOW + DAY, tz: TZ, read: g.read, ask: scripted(plan).ask, tokensFor, runtime: rt });
  assert.equal(r2.outcome, "known");
  assert.equal(rt.sent[0].text, "morning kofi. nothing i can finish for you today. worth knowing: AWS suspended your account on Nov 16.");
});

test("with a card on the note, what is worth knowing is one plain line at the bottom of the page: no button, no link, at most two", async () => {
  grant(FULL_SCOPE);
  const mail = [KEY(), AWS(), BILL(), msg({ id: "dent", from: "Bright Smiles Dental <office@brightsmiles.example>", subject: "Please confirm your appointment Nov 20, reply YES", snippet: "Reply YES to confirm your cleaning on Nov 20 at 10am." })];
  const g = fakeGoogle({ mail });
  const plan = (key) => key.endsWith(":dent") ? { route: "email", verb: "CONFIRM", title: "Confirm your dental cleaning for Nov 20", lead: "your dentist wants a yes for Nov 20", urgency: 3 }
    : key.endsWith(":key") ? { route: "none", title: "Replace your Anthropic key", lead: "your Anthropic API key expires Nov 24", urgency: 4 }
    : key.endsWith(":aws") ? { route: "none", title: "Verify your AWS account", lead: "your AWS account is suspended", urgency: 5 }
    : { route: "none", title: "Fix your Anthropic billing", lead: "your Anthropic API access is off after a failed payment", urgency: 3 };
  const rt = fakeRuntime();
  const r = await morning(g, scripted(plan).ask, { runtime: rt });
  assert.equal(r.outcome, "cards");
  const d = cards.digestById(r.digest);
  assert.equal(d.cards.length, 1); assert.equal(d.also.length, 2);
  // The text is the card's; the things Reason cannot finish are not in it.
  assert.match(rt.sent[0].text, /^morning kofi\. one thing i can take off your plate: your dentist wants a yes for Nov 20\. https:\/\/heyreason\.com\/a\//);
  assert.doesNotMatch(rt.sent[0].text, /AWS|Anthropic/);
  const html = (await page.actionCardsRequest({ method: "GET", path: `/a/${d.token}`, now: NOW })).body;
  assert.match(html, /One thing I can take off your plate\./);
  assert.equal([...html.matchAll(/<li class="card/g)].length, 1, "one card: the lines are not cards");
  const also = /<p class="also" id="also">([^<]*)<\/p>/.exec(html);
  assert.equal(also[1], "also worth knowing: your AWS account is suspended · your Anthropic API key expires Nov 24");
  assert.equal([...html.matchAll(/class="also"/g)].length, 1);
  assert.doesNotMatch(also[0], /href|data-sms|button/);
  assert.equal(page.alsoLine({ also: [] }), "");
  // The picture counts the card only.
  assert.match(page.actionCardsOgHtml(d, { now: NOW }), /One thing I can take off your plate\./);
});

// ---------------------------------------------------------------- 7. nothing to say

test("nothing Reason can finish and nothing worth knowing: nothing is sent, nothing is written but the day's row", async () => {
  const mail = [msg({ id: "water", from: "Acme Water <billing@acmewater.example>", subject: "Your bill is due Nov 20", snippet: "Your water bill of $48.10 is due Nov 20." })];
  const events = [ev({ id: "q4", summary: "Q4 planning", start: NOW + 5 * DAY, self: "needsAction" })];
  const g = fakeGoogle({ mail, events });
  db.db.prepare("INSERT INTO timers (conversation_id, fire_at, note) VALUES (?, ?, ?)").run(C, NOW + 9 * DAY, "Remind Kofi to cancel Cardboard Starter before it renews Nov 27");
  // The model tries everything, including calling a bill "none" (it is not a notice: no line for it).
  const plan = (key) => key.startsWith("cal:") ? { route: "calendar", verb: "ACCEPT", title: "Accept Ana's Q4 planning invite for Nov 22", lead: "Ana's Q4 planning invite is waiting" }
    : key.endsWith(":water") ? { route: "none", title: "Pay your water bill", lead: "your water bill is due Nov 20" }
    : { route: "site", site: "cardboard.example", verb: "CANCEL", title: "Cancel your Cardboard Starter before it renews Nov 27", lead: "your Cardboard Starter renews Nov 27" };
  const rt = fakeRuntime();
  const r = await morning(g, scripted(plan).ask, { runtime: rt });
  assert.equal(r.outcome, "empty"); assert.equal(r.why, "nothing_finishable");
  assert.equal(rt.sent.length, 0, "silence beats noise");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM action_digests").get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM action_cards").get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 0);
  const row = engine.dayRow(C, "2026-11-17");
  assert.equal(row.outcome, "empty"); assert.equal(row.texts_sent, 0);
  assert.equal(engine.ranToday(C, "2026-11-17"), true, "and it is not tried again that day");
  // The urgent single goes through the same gate: no route, no text.
  const soon = new Date(NOW + 90 * MIN).toISOString();
  const urgent = engine.urgentFrom(C, [{ kind: "calendar_moved", key: "k:1", what: "Design review moved from 9:00 to 9:30", starts: soon, account: ACCT.account, event_id: "e6" }],
    { now: NOW, tz: TZ, ask: scripted(() => ({ route: "calendar", verb: "MOVE", title: "Move your ride for the 9:30 design review", lead: "your design review moved to 9:30" })).ask, queue: async (key, fn) => fn(), runtime: rt });
  assert.ok(urgent.queued);
  await new Promise(res => setTimeout(res, 20));
  assert.equal(rt.sent.length, 0);
});

// ---------------------------------------------------------------- 8. the tap

/** A routed card on a real note for `c`, made the way the morning makes it. */
async function noteWith(c, { route, site = "", title, lead, verb, candidate }) {
  const made = [{ key: candidate.key, route, job: "do the whole thing; done when it is through", site, phone: "", verb, title, whyNow: "It is due soon.", lead, prefill: title.replace(/\byour\b/gi, "my"), drawing: "note", urgency: 3, effort: 3, offer: "", candidate }];
  const gate = await engine.routeGate(c, made, { now: clock.now() });
  assert.equal(gate.cards.length, 1, `the route is open (${JSON.stringify(gate.why)})`);
  const d = cards.createDigest(c, gate.cards.map(k => ({ verb: k.verb, title: k.title, whyNow: k.whyNow, prefill: k.prefill, drawing: k.drawing })), { now: clock.now() });
  db.db.prepare("INSERT INTO action_card_sources (card_id, conversation_id, kind, source, source_key, refs, first_name, found_at, route, route_target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(d.cards[0].id, c, candidate.kind, candidate.source, "k", db.seal2(c, JSON.stringify({ route: gate.cards[0].routed })), db.seal2(c, ""), clock.now(), gate.cards[0].routed.route, db.restcrypt.blindIndex("action_route", gate.cards[0].routed.target));
  return { d, card: d.cards[0], prefill: d.cards[0].prefill };
}
const LINE = "+16562167455";
let n = 0;
const newNumber = () => `+1415558${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;
const text = (from, body) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now() });
function harness(runTurn) {
  const turns = [];
  const runtime = new Runtime({ runTurn: async (t) => { turns.push(t); return await runTurn(t, turns.length); } });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { router, channel, turns, runtime };
}

test("a tapped card that cannot be finished: one plain line, no sign-in link (refused twice, and again for the job that wakes up later), off the note, not offered again", async () => {
  clock.reset();
  const num = newNumber(), c = conv(num);
  const tools = [];
  const h = harness(async ({ conversationId, text: t }, i) => {
    if (i === 1) return "hey";
    // What happened on 2026-11-12, replayed: the turn reaches for the sign-in link, and then for it again.
    tools.push(await runTool("signin_link", { site: "cardboard.example" }, { conversationId, kind: "user" }));
    tools.push(await runTool("signin_link", { site: "cardboard.example" }, { conversationId, kind: "user" }));
    return "I couldn't cancel Cardboard Starter: I'm not signed in there, so I can't finish it from here. Nothing was changed.";
  });
  await h.router.deliver(text(num, "hi"));
  engine.setRouteDeps({ liveSession: async () => ({ state: "signed_in" }) });
  const entry = signin.anyEntryFor("cardboard.example");
  db.recordSiteSignin(c, entry.site, { state: "signed_in", evidence: "t" });
  const cand = { key: "own:timers:1", kind: "reminder", source: "own", line: "a reminder they set" };
  const { d, card, prefill } = await noteWith(c, { route: "site", site: "cardboard.example", title: "Cancel your Cardboard Starter before it renews Nov 27", lead: "your Cardboard Starter renews Nov 27", verb: "CANCEL", candidate: cand });
  const before = h.channel.sent.length;

  await h.router.deliver(text(num, prefill));

  // The turn was told what the card promised, by which route, and how to fail.
  assert.match(h.turns[1].text, /a tap on a card from the note Reason left them: "Cancel your Cardboard Starter before it renews Nov 27"/);
  assert.match(h.turns[1].text, /saved signed-in session .*\(cardboard\.example\)/);
  // That note is code's, not theirs: a page never draws it, and the screen reads only their own words.
  assert.equal(webnotes.displayText(h.turns[1].text), prefill);
  assert.equal(harm.ownWords(h.turns[1].text), prefill);
  // Both asks for a sign-in link were refused by code: nothing was sent for them.
  assert.equal(tools.length, 2);
  for (const t of tools) { assert.equal(t.ok, false); assert.equal(t.blocked, "card_must_finish"); assert.match(t.error, /Do NOT send a sign-in link/); }
  // What they got: exactly one text, the plain line. No link in it, no second message.
  const got = h.channel.sent.slice(before).filter(m => m.to === num);
  assert.equal(got.length, 1);
  assert.match(got[0].text, /^I couldn't cancel Cardboard Starter/);
  assert.equal(got.filter(m => /https?:\/\//.test(m.text ?? "")).length, 0, "no link was sent");
  // The card is not "done" because a reply went out. It failed, it is off the note, and why is on record.
  assert.equal(cards.digestById(d.id).cards[0].status, "failed");
  const kept = engine.routeOf(card.id, c);
  assert.equal(kept.outcome, "failed");
  assert.equal(kept.why, "signin_link:card_must_finish", "it needed a sign-in Reason did not have");
  assert.equal(cards.digestById(d.id).gone, true, "nothing left on the note: the link no longer opens");
  // The job it left behind wakes up later (a restart resumed it on 11-12 and texted the link a third time): still refused.
  assert.equal(engine.runBlocksHandoff(c, { kind: "event" }), true);
  const later = await runTool("signin_link", { site: "cardboard.example" }, { conversationId: c, kind: "event" });
  assert.equal(later.blocked, "card_must_finish");
  assert.equal(h.channel.sent.slice(before).filter(m => m.to === num).length, 1, "still one text");
  // A turn they start themselves afterwards is theirs to ask for a link in: the guard is not on it.
  assert.equal(engine.runBlocksHandoff(c, { kind: "user" }), false);
  // And once they HAVE asked for one themselves, what follows is their own job, not the card's: the
  // sign-in they asked for may need a second link, and that one is not refused (kept on the card's
  // row, so a restart does not forget it).
  const own = await runTool("signin_link", { site: "cardboard.example" }, { conversationId: c, kind: "user" });
  assert.notEqual(own.blocked, "card_must_finish", "their own ask is not the card's");
  assert.equal(engine.runBlocksHandoff(c, { kind: "event" }), false, "what follows their own ask is theirs");
  const next = await runTool("signin_link", { site: "cardboard.example" }, { conversationId: c, kind: "event" });
  assert.notEqual(next.blocked, "card_must_finish");
  assert.equal(engine.noteOwnHandoff(c), 0, "written once");
  // Tomorrow the same card is not offered again: the route failed there, and the title is remembered as failed.
  assert.equal(engine.failedBefore(c, "site", `site:${entry.site}`), true);
  const again = await engine.routeGate(c, [{ key: cand.key, route: "site", site: "cardboard.example", job: "x", verb: "CANCEL", title: "Cancel your Cardboard Starter before it renews Nov 27", lead: "your Cardboard Starter renews Nov 27", urgency: 3, effort: 3, candidate: cand }]);
  assert.deepEqual(again.why, { failed_here_before: 1 });
  assert.equal(engine.dedupeAndRank(c, [{ key: "k2", title: "Cancel your Cardboard Starter before it renews Nov 27", prefill: "Cancel my Cardboard Starter before it renews Nov 27", urgency: 3, effort: 3 }]).dropped.failed, 1);
  // A failure is forgotten in time (two weeks), not held against the site for ever.
  assert.equal(engine.failedBefore(c, "site", `site:${entry.site}`, { now: clock.now() + 15 * DAY }), false);
});

test("a tapped card is done only on proof, and waits while their yes is out: pending after the ask, done when the mail has really gone, settled by the sweep", async () => {
  clock.reset();
  const num = newNumber(), c = conv(num);
  let sendIt = false;
  const h = harness(async ({ conversationId }, i) => {
    if (i === 1) return "hey";
    if (!sendIt) {
      // The email is shown and their yes is asked for: part of the one yes, and not yet anything done.
      db.askConfirmation({ conversationId, action: "gmail_send", summary: "Send \"Yes, Nov 20 at 10am works\" to office@brightsmiles.example", stakes: "an email from your address", target: "office@brightsmiles.example", askedAfterMsgs: 0 });
      return "Here's the reply: \"Yes, Nov 20 at 10am works.\" Send it?";
    }
    db.recordAction({ conversationId, action: "gmail_send", target: "office@brightsmiles.example", attempted: {}, outcome: "ok", result: { ok: true, id: "sent-1" }, receipt: "sent" });
    return "Sent.";
  });
  await h.router.deliver(text(num, "hi"));
  db.saveOauthTokens(c, google.PROVIDER, { accessToken: "at", refreshToken: "rt", scope: FULL_SCOPE, expiresAt: clock.now() + HOUR, accountLabel: "ama@example.com" });
  const cand = { key: "mail:ama@example.com:t1", kind: "mail_unread", source: "mail", from: "office@brightsmiles.example", bulk: false, auth: true, refs: { account: "ama@example.com", thread_id: "t1" } };
  const { d, card, prefill } = await noteWith(c, { route: "email", title: "Confirm your dental cleaning for Nov 20", lead: "your dentist wants a yes for Nov 20", verb: "CONFIRM", candidate: cand });

  await h.router.deliver(text(num, prefill));
  // Their yes is out: the card is neither done nor failed. It waits, still on the note.
  assert.equal(cards.digestById(d.id).cards[0].status, "open");
  assert.deepEqual([engine.routeOf(card.id, c).outcome, engine.routeOf(card.id, c).why], ["pending", "waiting_for_their_yes"]);
  assert.equal(engine.settleOpenRuns(c), 0, "still waiting");
  // They say yes; the mail goes; the ledger says so. The sweep reads it and only then is the card done.
  sendIt = true;
  await h.router.deliver(text(num, "yes"));
  db.db.prepare("UPDATE confirmations SET consumed_at = ? WHERE conversation_id = ?").run(clock.now(), c);
  assert.equal(engine.settleOpenRuns(c), 1);
  assert.equal(cards.digestById(d.id).cards[0].status, "done");
  assert.deepEqual([engine.routeOf(card.id, c).outcome, engine.routeOf(card.id, c).why], ["done", "gmail_send"]);
  assert.deepEqual(cards.counts(card.id, c), { view: 0, tap: 0, reply: 1, dismiss: 0, done: 1, fail: 0 });

  // A yes that never comes is nobody's failure: past the wait the run lapses and the card is still theirs to tap.
  const two = await noteWith(c, { route: "email", title: "Confirm your eye exam for Nov 25", lead: "your optician wants a yes for Nov 25", verb: "CONFIRM", candidate: { ...cand, key: "mail:ama@example.com:t2" } });
  sendIt = false;
  await h.router.deliver(text(num, two.prefill));
  assert.equal(engine.routeOf(two.card.id, c).outcome, "pending");
  engine.settleOpenRuns(c, { now: clock.now() + routes.PENDING_MS + MIN });
  assert.equal(engine.routeOf(two.card.id, c).outcome, "lapsed");
  assert.equal(cards.digestById(two.d.id).cards[0].status, "open");
});

test("what DONE means is read per route: a payment that reads paid, a call whose outcome is a success, never another route's proof", () => {
  clock.reset();
  const T = clock.now();
  const since = T - MIN;
  // Somebody else's proof is not this route's: a sent email does not finish a payment.
  db.recordAction({ conversationId: C, action: "gmail_send", target: "x", attempted: {}, outcome: "ok", result: { ok: true }, receipt: "sent" });
  assert.equal(routes.readOutcome(C, "pay", since).state, "failed");
  assert.deepEqual(routes.readOutcome(C, "email", since), { state: "done", via: "gmail_send" });
  // A mail that went out BEFORE the tap is not the tap's doing.
  assert.equal(routes.readOutcome(C, "email", T + MIN).state, "failed");
  // pay: the checkout still running is pending; the payment reading paid is done.
  db.db.prepare("INSERT INTO shop_runs (run_id, conversation_id, store, mode, status, created_at, updated_at) VALUES ('r1', ?, 'acmewater', 'guest', 'running', ?, ?)").run(C, T, T);
  assert.deepEqual(routes.readOutcome(C, "pay", since), { state: "pending", why: "checkout_running" });
  db.db.prepare("INSERT INTO shop_payments (conversation_id, run_id, request_id, amount, currency, amount_kind, status, created_at, answered_at) VALUES (?, 'r1', 'rq1', '48.10', 'USD', 'exact', 'paid', ?, ?)").run(C, T, T);
  assert.deepEqual(routes.readOutcome(C, "pay", since), { state: "done", via: "shop_pay" });
  // call: ringing is pending; a voicemail is not the goal met; an outcome that is a success is done.
  const call = (kind, ended) => db.db.prepare("INSERT INTO calls (conversation_id, provider, to_number, goal, state, outcome_kind, created_at, updated_at, ended_at) VALUES (?, 'fake', '+12125550142', 'confirm Tuesday 3pm', 'done', ?, ?, ?, ?)").run(C, kind, T, T, ended);
  call("", null);
  assert.deepEqual(routes.readOutcome(C, "call", since), { state: "pending", why: "call_in_progress" });
  db.db.exec("DELETE FROM calls");
  call("voicemail_left", T);
  assert.equal(routes.readOutcome(C, "call", since).state, "failed");
  call("confirmed", T);
  assert.deepEqual(routes.readOutcome(C, "call", since), { state: "done", via: "call_place" });
  // Nothing at all happened: failed, and it says so.
  assert.deepEqual(routes.readOutcome(C, "calendar", T + MIN), { state: "failed", why: "nothing_was_done" });
});
