// Several Google accounts for one person: a personal Gmail and a work Gmail, both working at once.
//
// What these tests are for, in order of how much it would cost to get them wrong:
//
//   1. **A yes is pinned to one account.** The confirm gate's target carries the sending address, so an
//      approval to send from their work mail cannot be spent from their personal mail. That is the one
//      thing here that, if it broke, would send somebody's words out of an address they never chose.
//   2. **An id from one account is never used against another.** Every message, thread, label and event
//      id Google hands out means something only inside the account it came from, and the same string in
//      the other mailbox is other mail. Pairing them is refused with the right account named — not met
//      as a 404, and never silently applied to whatever happens to share the id.
//   3. **A reply goes from the account that received it.** Enforced by checking the message is really in
//      the sending account, not by trusting whoever picked.
//   4. **One dead account is one dead account.** Their work grant expiring must leave their personal
//      mail readable, and must say which one needs reconnecting.
//   5. **Reading covers all of them and says which is which**, so "any mail from the landlord?" is
//      answered about their mail rather than about whichever mailbox was looked in first.
//   6. **Nothing that already worked broke.** The migration from the one-account-per-person shape keeps
//      every row, including the refresh token that IS somebody's live connection — tested in a separate
//      process against a database built in the old shape, and tested twice to prove it is safe to rerun.
//
// No real credentials and no network: the base URLs point at the fixture, which is now able to be two
// different Google accounts at once and decides which one every request is for from its bearer token.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { startGoogle, fakeMessage } from "./fixture-google.js";

const dir = mkdtempSync(join(tmpdir(), "reason-google-accounts-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
// Not an undo-window test: anything reaching a third party is normally held for 30 seconds
// before it really goes, which would make every send in here come back 'held' instead of done.
// Off, so these keep asking what they are about. test/undo-window.test.js is where the window
// itself is proven.
process.env.REASON_UNDO_SECONDS = "0";

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const google = await import("../src/google.js");
const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
// The connect link is Reason's start page (src/connectgate.js); the provider's own address, what
// these assertions are about, is kept on the state row it names.
const providerUrl = (u) => db.db.prepare("SELECT authorize_url FROM oauth_states WHERE state = ?").get(new URL(u).searchParams.get("state"))?.authorize_url ?? u;
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
const ME = "me@example.com";
const WORK = "work@company.example";

let fake;
const call = (name, input, conversationId = OMARI, messages = []) => runTool(name, input, { conversationId, messages });
const owner = (text) => ({ role: "user", content: `[Sat Oct 3 2026, 9:00 AM] Omari: ${text}` });
const readsYes = () => async () => ({ verdict: "yes" });

/** The work account's own mail, so "which account did this come from" is a real question. */
const WORK_MAIL = [
  fakeMessage({
    id: "w1", threadId: "wt1", from: "Landlord <landlord@example.com>", to: WORK,
    subject: "Rent", date: "Sat, 03 Oct 2026 11:00:00 -0400",
    text: "rent's due friday",
  }),
  fakeMessage({
    id: "w2", threadId: "wt2", from: "Payroll <payroll@company.example>", to: WORK,
    subject: "Payslip", date: "Fri, 02 Oct 2026 08:00:00 -0400",
    text: "your payslip is ready", labels: ["INBOX"],
  }),
];

before(async () => {
  fake = await startGoogle();
  config.googleClientId = "client-abc.apps.googleusercontent.com";
  config.googleClientSecret = "secret-xyz";
  config.googleOauthBase = fake.url;
  config.googleAccountsBase = fake.url;
  config.googleGmailBase = fake.url;
  config.googleCalendarBase = fake.url;
  config.publicUrl = "";
});
after(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM confirmations;");
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
  fake.reset();
  for (const k of ["tokenCalls", "authHeaders", "revoked", "sent", "drafts", "modified", "trashed", "events", "eventWrites", "searches"]) fake.state[k].length = 0;
  fake.state.liveTokens.clear();
  fake.state.refreshCounter = 0;
});

/**
 * Connect one Google account, walking the real handshake: ask for a link, then be the browser Google
 * redirects back to. Selecting the address on the fake stands in for the person choosing an account on
 * Google's own chooser, which never touches this server.
 */
async function connect(address, conversationId = OMARI, { mail = null, timeZone = null } = {}) {
  if (!fake.accounts().includes(address)) {
    fake.addAccount(address, { ...(mail ? { mail } : {}), ...(timeZone ? { calendarTimeZone: timeZone } : {}) });
  }
  fake.set({ email: address });
  const link = await call("google_connect", {}, conversationId);
  assert.equal(link.ok, true, JSON.stringify(link));
  const state = new URL(link.url).searchParams.get("state");
  const done = await google.completeConnect({ code: "good-code", state });
  return { link, done };
}

/** Both of Omari's: a personal mailbox and a work one, each with its own mail. */
async function connectBoth() {
  await connect(ME);
  await connect(WORK, OMARI, { mail: WORK_MAIL });
}

/** Take a gated tool through the gate the way the model is told to: ask, be answered, act. */
async function withYes(name, input, conversationId = OMARI) {
  const blocked = await call(name, input, conversationId);
  assert.equal(blocked.blocked, "needs_confirmation", JSON.stringify(blocked));
  const msgs = [owner("do it")];
  const req = await runTool("confirm_request", { action: name, summary: "the thing", target: blocked.use_target }, { conversationId, messages: msgs });
  msgs.push(owner("yes go"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId, messages: msgs, judge: readsYes() });
  assert.equal(rec.state, "granted", JSON.stringify(rec));
  return { out: await call(name, { ...input, confirmation_id: req.confirmation_id }, conversationId, msgs), confirmation_id: req.confirmation_id, messages: msgs, target: blocked.use_target };
}

// ---------- connecting a second one ----------

test("two accounts connect, both are kept, and both are listed by address", async () => {
  await connectBoth();

  const rows = db.listOauthTokens(OMARI, "google");
  assert.equal(rows.length, 2, "two rows, not one overwriting the other");
  assert.deepEqual(rows.map(r => r.account_label), [ME, WORK]);
  assert.ok(rows.every(r => r.refresh_token), "each keeps its own refresh token");
  assert.notEqual(rows[0].refresh_token, rows[1].refresh_token, "and they are different grants");

  const list = await call("google_accounts", {});
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.count, 2);
  assert.deepEqual(list.accounts.map(a => a.account), [ME, WORK]);
  for (const a of list.accounts) assert.deepEqual(a.can.sort(), ["calendar", "mail"]);

  // And the status everything else reads names both, so "what's connected?" cannot answer with one.
  const st = trust.accountStatus(OMARI, "gmail");
  assert.equal(st.status, "connected");
  assert.deepEqual(st.accounts, [ME, WORK]);
  const cap = capabilitiesNow({ conversationId: OMARI }).find(c => c.name === "email");
  assert.equal(cap.status, "live");
  for (const a of [ME, WORK]) assert.ok(cap.what.includes(a), `the capability names ${a}`);
});

test("the link for a second account asks Google for the chooser; the first one does not", async () => {
  const first = await call("google_connect", {});
  assert.equal(new URL(providerUrl(first.url)).searchParams.get("prompt"), "consent", "nothing to choose between yet");
  assert.equal(new URL(providerUrl(first.url)).searchParams.has("login_hint"), false);

  // A grant made by today's first connect plus mail, so the plain link names nothing new for it.
  fake.set({ grantScopes: [...google.DEFAULT_SCOPES, google.GMAIL_SCOPE] });
  await connect(ME);
  const second = await call("google_connect", {});
  // Documented: prompt is "a space-delimited, case-sensitive list", and only `none` may not be combined.
  assert.equal(new URL(providerUrl(second.url)).searchParams.get("prompt"), "select_account consent");
  assert.equal(new URL(providerUrl(second.url)).searchParams.get("access_type"), "offline", "still asking for a refresh token");
  assert.deepEqual(second.already_connected, [ME]);
  assert.match(second.adding_another, /chooser/);

  // Reconnecting a NAMED one is the opposite: hint that account, no chooser.
  const back = await call("google_connect", { account: ME });
  assert.equal(new URL(providerUrl(back.url)).searchParams.get("login_hint"), ME);
  assert.equal(new URL(providerUrl(back.url)).searchParams.get("prompt"), "consent", "a hint and a chooser would contradict each other");
  assert.equal(back.reconnecting, ME);
});

test("connecting the same address again is one row, refreshed — never a second copy", async () => {
  await connectBoth();
  const before = db.listOauthTokens(OMARI, "google").find(r => r.account_label === WORK);

  clock.skip(60_000);
  const { done } = await connect(WORK);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.added, false, "and it knows this was not a new account");

  const rows = db.listOauthTokens(OMARI, "google");
  assert.equal(rows.length, 2, "still two accounts");
  const after = rows.find(r => r.account_label === WORK);
  assert.equal(after.id, before.id, "the same row was updated");
  assert.notEqual(after.access_token, before.access_token, "with a fresh token on it");

  // Said back as a reconnect rather than as a new account, so nobody is told they have three.
  assert.match(google.connectedLine(done), /reconnected/);
});

test("a second account Google will not name is refused, rather than stored as one nobody can address", async () => {
  await connect(ME);
  // Both ways of learning the address have to be gone: the Gmail profile endpoint failing, and no
  // calendar scope to fall back on. With one account already connected there would then be no way to
  // tell the new one from it, or to say which to send from.
  fake.addAccount("mystery@example.com", { grantScopes: [google.GMAIL_SCOPE] });
  fake.setAccount("mystery@example.com", { profileWorks: false });
  fake.set({ email: "mystery@example.com" });
  const link = await call("google_connect", {});
  const done = await google.completeConnect({ code: "good-code", state: new URL(link.url).searchParams.get("state") });

  assert.equal(done.ok, false);
  assert.equal(done.reason, "no_address");
  assert.match(done.error, /Nothing was saved/);
  assert.deepEqual(db.listOauthTokens(OMARI, "google").map(r => r.account_label), [ME], "and the one that worked is untouched");
});

// ---------- reading looks everywhere ----------

test("a search covers every account and says which one each message came from", async () => {
  await connectBoth();

  const out = await call("gmail_search", {});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.accounts_searched, [ME, WORK]);
  const msgs = out.content.messages;
  assert.ok(msgs.length > 0);
  for (const m of msgs) assert.ok([ME, WORK].includes(m.account), `every message says which account: ${JSON.stringify(m)}`);
  assert.ok(msgs.some(m => m.account === ME && m.subject === "Saturday"), "the personal one's mail is there");
  assert.ok(msgs.some(m => m.account === WORK && m.subject === "Rent"), "and the work one's");
  assert.match(out.note, /which `account`/);

  // Naming one looks only there.
  const justWork = await call("gmail_search", { account: WORK });
  assert.equal(justWork.ok, true);
  assert.ok(justWork.content.messages.every(m => m.account === WORK));
  assert.equal(justWork.content.messages.some(m => m.subject === "Saturday"), false, "the personal mailbox was not read");
});

test("a calendar read covers both, in each calendar's own zone, in time order", async () => {
  await connect(ME, OMARI, { timeZone: "America/New_York" });
  await connect(WORK, OMARI, { mail: WORK_MAIL, timeZone: "Europe/London" });
  fake.seedEventFor(ME, { summary: "Gym", start: { dateTime: "2026-10-09T07:00:00-04:00" }, end: { dateTime: "2026-10-09T08:00:00-04:00" } });
  fake.seedEventFor(WORK, { summary: "Standup", start: { dateTime: "2026-10-09T05:00:00-04:00" }, end: { dateTime: "2026-10-09T05:15:00-04:00" } });

  const out = await call("calendar_events", { from: "2026-10-09", to: "2026-10-10" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.count, 2);
  assert.deepEqual(out.content.events.map(e => e.summary), ["Standup", "Gym"], "one day, in time order across both calendars");
  assert.deepEqual(out.content.events.map(e => e.account), [WORK, ME]);
  assert.deepEqual(out.time_zones, [{ account: ME, time_zone: "America/New_York" }, { account: WORK, time_zone: "Europe/London" }]);
  // Each calendar was asked in its own zone, never in one of the two for both.
  const lists = fake.state.eventWrites.filter(w => w.what === "list");
  assert.equal(lists.length, 2);
  assert.ok(lists.find(l => l.account === WORK).timeMin.endsWith("+01:00"), "London's offset for the London calendar");
  assert.ok(lists.find(l => l.account === ME).timeMin.endsWith("-04:00"), "and New York's for the other");
});

test("labels come back per account, because a label id means nothing in the other mailbox", async () => {
  await connectBoth();
  const out = await call("gmail_labels", {});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.by_account.map(a => a.account), [ME, WORK]);
  assert.equal("labels" in out, false, "not one flat list that would read as shared ids");
  assert.match(out.note, /only works on the account it is listed under/);

  // One account on its own still gets the plain list it always got.
  const one = await call("gmail_labels", { account: WORK });
  assert.equal(one.account, WORK);
  assert.ok(one.labels.length > 0);
});

// ---------- an id belongs to one account ----------

test("an id from one account used against another is refused, with the right account named", async () => {
  await connectBoth();

  // Reading it in the wrong account.
  const read = await call("gmail_read", { message_id: "w1", account: ME });
  assert.equal(read.ok, false, JSON.stringify(read));
  assert.equal(read.status, "wrong_account");
  assert.equal(read.in_account, WORK);
  assert.match(read.error, /not in me@example\.com/);

  // And acting on it. Nothing moves.
  const archive = await call("gmail_archive", { message_ids: ["w1"], account: ME });
  assert.equal(archive.ok, false, JSON.stringify(archive));
  assert.equal(archive.status, "wrong_account");
  assert.deepEqual(archive.strays, [{ id: "w1", in_account: WORK }]);
  assert.ok(fake.mailOf(WORK).find(m => m.id === "w1").labels.includes("INBOX"), "the work mail never moved");
  assert.deepEqual(fake.state.modified, [], "and nothing at all was written");
});

test("an event id from the other calendar is named as that, not met as a 404", async () => {
  await connect(ME);
  await connect(WORK, OMARI, { mail: WORK_MAIL });
  const theirs = fake.seedEventFor(WORK, { summary: "Review", start: { dateTime: "2026-10-09T10:00:00-04:00" }, end: { dateTime: "2026-10-09T11:00:00-04:00" } });

  const out = await call("calendar_delete", { event_id: theirs.id, account: ME });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.status, "wrong_account");
  assert.equal(out.in_account, WORK);
  assert.equal(fake.state.eventWrites.some(w => w.what === "delete"), false, "nothing was cancelled");
});

test("an id with no account named is found in whichever account really has it", async () => {
  await connectBoth();
  // Reading changes nothing, so finding the mail beats making them say where it is.
  const out = await call("gmail_read", { message_id: "w1" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.account, WORK);
  assert.match(out.content.message.subject, /Rent/);
  assert.match(out.note, /work@company\.example/);
});

test("an address that is not theirs is refused by name and reaches Google not at all", async () => {
  await connectBoth();
  fake.state.authHeaders.length = 0;
  const out = await call("gmail_search", { account: "someone@else.example" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "unknown_account");
  assert.deepEqual(out.accounts, [ME, WORK]);
  assert.equal(fake.state.authHeaders.length, 0, "no request was made with anybody's token");
});

// ---------- acting happens on one named account ----------

test("a send with several connected and none named asks which, and sends nothing", async () => {
  await connectBoth();
  const out = await call("gmail_send", { to: ["kofi@example.com"], subject: "hi", body: "Hello.\n\nOmari's assistant, Reason" });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.blocked, "which_account");
  assert.deepEqual(out.accounts, [ME, WORK]);
  assert.match(out.error, /Nothing was done/);
  assert.match(out.error, /set_default/, "and it says how to stop being asked");
  assert.deepEqual(fake.state.sent, [], "nothing left either mailbox");
});

test("a default they set is used when they do not say, and is shown as that", async () => {
  await connectBoth();
  const set = await call("google_accounts", { set_default: ME });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.default_set_to, ME);
  assert.equal(set.accounts.find(a => a.account === ME).used_when_they_do_not_say, true);
  assert.equal(set.accounts.find(a => a.account === WORK).used_when_they_do_not_say, false);

  const { out } = await withYes("gmail_send", { to: ["kofi@example.com"], subject: "hi", body: "Hello.\n\nOmari's assistant, Reason" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.account, ME, "their default, not the other one");
  assert.equal(fake.state.sent.at(-1).account, ME, "and the server agrees whose token sent it");

  // A default has to be one of theirs.
  const bad = await call("google_accounts", { set_default: "nope@example.com" });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, "unknown_account");
});

test("one account is enough on its own: nothing is asked and nothing has to be named", async () => {
  await connect(ME);
  const { out } = await withYes("gmail_send", { to: ["kofi@example.com"], subject: "hi", body: "Hello.\n\nOmari's assistant, Reason" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.account, ME);
});

// ---------- the gate is pinned to one account ----------

test("a yes to send from one account cannot be spent from the other", async () => {
  await connectBoth();

  // Asked for, and approved for, the work address.
  const blocked = await call("gmail_send", { to: ["landlord@example.com"], subject: "Rent", body: "Rent will be paid on Friday.\n\nOmari's assistant, Reason", account: WORK });
  assert.equal(blocked.blocked, "needs_confirmation");
  assert.ok(blocked.use_target.startsWith(`from=${WORK}|`), `the account is in what they say yes to: ${blocked.use_target}`);

  const msgs = [owner("send it from work")];
  const req = await runTool("confirm_request", { action: "gmail_send", summary: "the email", target: blocked.use_target }, { conversationId: OMARI, messages: msgs });
  msgs.push(owner("yes go"));
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: OMARI, messages: msgs, judge: readsYes() });

  // The same email, the same yes, the other mailbox. Refused.
  const wrong = await call("gmail_send", { to: ["landlord@example.com"], subject: "Rent", body: "Rent will be paid on Friday.\n\nOmari's assistant, Reason", account: ME, confirmation_id: req.confirmation_id }, OMARI, msgs);
  assert.equal(wrong.ok, false, JSON.stringify(wrong));
  assert.equal(wrong.blocked, "wrong_target");
  assert.deepEqual(fake.state.sent, [], "and nothing was sent from either");

  // The account it was approved for still goes through, once.
  const right = await call("gmail_send", { to: ["landlord@example.com"], subject: "Rent", body: "Rent will be paid on Friday.\n\nOmari's assistant, Reason", account: WORK, confirmation_id: req.confirmation_id }, OMARI, msgs);
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.equal(right.account, WORK);
  assert.equal(fake.state.sent.length, 1);
  assert.equal(fake.state.sent[0].account, WORK, "the server saw the work account's token");
});

test("a yes to bin mail in one account cannot bin the same ids in the other", async () => {
  await connectBoth();
  const blocked = await call("gmail_trash", { message_ids: ["m1"], account: ME });
  assert.ok(blocked.use_target.startsWith(`in=${ME}|`), blocked.use_target);
  const msgs = [owner("bin it")];
  const req = await runTool("confirm_request", { action: "gmail_trash", summary: "bin that", target: blocked.use_target }, { conversationId: OMARI, messages: msgs });
  msgs.push(owner("yes"));
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: OMARI, messages: msgs, judge: readsYes() });

  // The work mailbox has an m1 of its own as far as the ids go — and this yes does not cover it.
  const wrong = await call("gmail_trash", { message_ids: ["m1"], account: WORK, confirmation_id: req.confirmation_id }, OMARI, msgs);
  assert.equal(wrong.blocked, "wrong_target", JSON.stringify(wrong));
  assert.deepEqual(fake.state.trashed, []);
});

test("a yes for an event on one calendar does not cover the other's", async () => {
  await connect(ME);
  await connect(WORK, OMARI, { mail: WORK_MAIL });
  const blocked = await call("calendar_create", {
    summary: "Dinner", start: "2026-10-09T19:00:00", end: "2026-10-09T21:00:00",
    attendees: ["kofi@example.com"], account: ME,
  });
  assert.equal(blocked.blocked, "needs_confirmation");
  assert.ok(blocked.use_target.startsWith(`on=${ME}|`), blocked.use_target);
  const msgs = [owner("put it on")];
  const req = await runTool("confirm_request", { action: "calendar_create", summary: "dinner", target: blocked.use_target }, { conversationId: OMARI, messages: msgs });
  msgs.push(owner("yes"));
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: OMARI, messages: msgs, judge: readsYes() });

  const wrong = await call("calendar_create", {
    summary: "Dinner", start: "2026-10-09T19:00:00", end: "2026-10-09T21:00:00",
    attendees: ["kofi@example.com"], account: WORK, confirmation_id: req.confirmation_id,
  }, OMARI, msgs);
  assert.equal(wrong.blocked, "wrong_target", JSON.stringify(wrong));
  assert.equal(fake.state.eventWrites.some(w => w.what === "insert"), false, "nobody was invited to anything");
});

// ---------- a reply comes from the account that got it ----------

test("a reply goes from the account that received the message, and the wrong one is refused", async () => {
  await connectBoth();
  await call("google_accounts", { set_default: ME });

  // The landlord wrote to the WORK address. Replying from the personal one would write to them from an
  // address they have never seen — so it is refused, by name, and nothing is sent.
  const blocked = await call("gmail_send", { reply_to_message_id: "w1", body: "Rent will be paid on Friday.\n\nOmari's assistant, Reason", account: ME });
  assert.equal(blocked.blocked, "needs_confirmation", JSON.stringify(blocked));
  const msgs = [owner("reply to the landlord")];
  const req = await runTool("confirm_request", { action: "gmail_send", summary: "reply", target: blocked.use_target }, { conversationId: OMARI, messages: msgs });
  msgs.push(owner("yes"));
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: OMARI, messages: msgs, judge: readsYes() });
  const wrong = await call("gmail_send", { reply_to_message_id: "w1", body: "Rent will be paid on Friday.\n\nOmari's assistant, Reason", account: ME, confirmation_id: req.confirmation_id }, OMARI, msgs);
  assert.equal(wrong.ok, false, JSON.stringify(wrong));
  assert.equal(wrong.status, "wrong_account");
  assert.equal(wrong.in_account, WORK);
  assert.match(wrong.error, /a reply goes from the account that received it/);
  assert.deepEqual(fake.state.sent, [], "nothing went out of either address");

  // From the account that got it, it lands in the thread — all three of Google's conditions.
  const { out } = await withYes("gmail_send", { reply_to_message_id: "w1", body: "Rent will be paid on Friday.\n\nOmari's assistant, Reason", account: WORK });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.account, WORK);
  const sent = fake.state.sent.at(-1);
  assert.equal(sent.account, WORK);
  assert.equal(sent.lands_in_thread, true);
  assert.equal(sent.headers.from, WORK, "written from the address that received it");
});

test("a drafted reply sits in the account that got the message", async () => {
  await connectBoth();
  const out = await call("gmail_draft", { reply_to_message_id: "w1", body: "ok", account: WORK });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.account, WORK);
  assert.equal(fake.state.drafts.at(-1).account, WORK);
  assert.match(out.note, /work@company\.example/);
});

// ---------- one dead account is one dead account ----------

test("one account's grant dying leaves the other working, and says which one needs doing again", async () => {
  await connectBoth();
  // Google ends the work grant. Their personal one is untouched.
  fake.setAccount(WORK, { refreshTokenValid: false });
  clock.skip(2 * 60 * 60 * 1000);

  const out = await call("gmail_search", {});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.accounts_searched, [ME], "the live one was still read");
  assert.ok(out.content.messages.length > 0);
  assert.deepEqual(out.accounts_not_searched.map(f => f.account), [WORK]);
  assert.equal(out.accounts_not_searched[0].status, "needs_reconnect");
  assert.match(out.incomplete, /work@company\.example/);
  assert.match(out.incomplete, /needs reconnecting/);

  // The dead one is dropped so nothing retries it; the live one keeps its row.
  assert.deepEqual(db.listOauthTokens(OMARI, "google").map(r => r.account_label), [ME]);
  const st = trust.accountStatus(OMARI, "gmail");
  assert.equal(st.status, "connected", "still connected, because one of them still is");
  assert.deepEqual(st.accounts, [ME]);
  assert.deepEqual(st.needs_reconnect, [WORK]);

  // And the live one can still be sent from, with nothing asked about the dead one.
  const { out: sent } = await withYes("gmail_send", { to: ["kofi@example.com"], subject: "hi", body: "Hello.\n\nOmari's assistant, Reason" });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.account, ME);
});

test("naming the dead account says it is that one, and offers to reconnect just it", async () => {
  await connectBoth();
  fake.setAccount(WORK, { refreshTokenValid: false });
  clock.skip(2 * 60 * 60 * 1000);
  await call("gmail_search", { account: WORK });

  const again = await call("gmail_search", { account: WORK });
  assert.equal(again.ok, false);
  assert.equal(again.status, "needs_reconnect");
  assert.equal(again.account, WORK);
  assert.match(again.error, new RegExp(`google_connect with account ${WORK}`));
  assert.match(again.error, /still fine/, "and says the other one is not the problem");

  const list = await call("google_accounts", {});
  assert.deepEqual(list.accounts.map(a => a.account), [ME]);
  assert.deepEqual(list.needs_reconnect, [WORK]);
});

test("reconnecting the dead one brings it back without touching the other", async () => {
  await connectBoth();
  const personalBefore = db.listOauthTokens(OMARI, "google").find(r => r.account_label === ME);
  fake.setAccount(WORK, { refreshTokenValid: false });
  clock.skip(2 * 60 * 60 * 1000);
  await call("gmail_search", { account: WORK });
  assert.deepEqual(trust.accountStatus(OMARI, "gmail").needs_reconnect, [WORK]);

  fake.setAccount(WORK, { refreshTokenValid: true });
  const { done } = await connect(WORK);
  assert.equal(done.ok, true, JSON.stringify(done));
  const st = trust.accountStatus(OMARI, "gmail");
  assert.deepEqual(st.accounts.sort(), [ME, WORK].sort());
  assert.equal("needs_reconnect" in st, false, "nothing is left marked dead");
  assert.equal(db.listOauthTokens(OMARI, "google").find(r => r.account_label === ME).refresh_token, personalBefore.refresh_token, "and the other one was never touched");
});

// ---------- disconnecting one of them ----------

test("disconnecting one account leaves the other connected and working", async () => {
  await connectBoth();
  const workRefresh = db.listOauthTokens(OMARI, "google").find(r => r.account_label === WORK).refresh_token;

  const out = await call("google_disconnect", { account: WORK });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.disconnected, [{ account: WORK, revoked_at_google: true }]);
  assert.deepEqual(out.still_connected, [ME]);
  assert.match(out.note, /still connected and still works/);
  assert.deepEqual(fake.state.revoked, [workRefresh], "only that account's grant was revoked at Google");

  assert.deepEqual(db.listOauthTokens(OMARI, "google").map(r => r.account_label), [ME]);
  const still = await call("gmail_search", {});
  assert.equal(still.ok, true, JSON.stringify(still));
  assert.ok(still.content.messages.every(m => m.account === ME));
  assert.equal(trust.accountStatus(OMARI, "gmail").status, "connected");
});

test("'disconnect google' with several connected asks which, and cuts nothing off", async () => {
  await connectBoth();
  const out = await call("google_disconnect", {});
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.status, "which_account");
  assert.deepEqual(out.accounts, [ME, WORK]);
  assert.match(out.error, /Nothing was disconnected/);
  assert.equal(db.listOauthTokens(OMARI, "google").length, 2, "both are still there");
  assert.deepEqual(fake.state.revoked, []);

  // Saying all of them takes all of them.
  const every = await call("google_disconnect", { all: true });
  assert.equal(every.ok, true, JSON.stringify(every));
  assert.deepEqual(every.disconnected.map(d => d.account), [ME, WORK]);
  assert.deepEqual(every.still_connected, []);
  assert.equal(db.listOauthTokens(OMARI, "google").length, 0);
  assert.equal(trust.accountStatus(OMARI, "gmail").status, "connectable");
});

test("disconnecting an address that is not theirs cuts nothing off", async () => {
  await connectBoth();
  const out = await call("google_disconnect", { account: "someone@else.example" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "unknown_account");
  assert.equal(db.listOauthTokens(OMARI, "google").length, 2);
  assert.deepEqual(fake.state.revoked, []);
});

// ---------- still nobody else's ----------

test("several accounts for one person are still unreachable from another person's thread", async () => {
  await connectBoth();
  await connect("ama@example.com", AMA);

  fake.state.authHeaders.length = 0;
  const hers = await call("gmail_search", {}, AMA);
  assert.equal(hers.ok, true, JSON.stringify(hers));
  assert.ok(hers.content.messages.every(m => m.account === "ama@example.com"));
  assert.deepEqual([...new Set(fake.callersSoFar())], ["ama@example.com"], "her thread only ever used her token");

  // And naming one of Omari's addresses from her thread reaches nothing.
  fake.state.authHeaders.length = 0;
  const reach = await call("gmail_search", { account: WORK }, AMA);
  assert.equal(reach.ok, false);
  assert.equal(reach.status, "unknown_account");
  assert.equal(fake.state.authHeaders.length, 0, "no request was made at all");
});

test("the ledger row for a send says which account it went from", async () => {
  await connectBoth();
  await withYes("gmail_send", { to: ["kofi@example.com"], subject: "hi", body: "Hello.\n\nOmari's assistant, Reason", account: WORK });
  const row = db.listActions(OMARI).find(a => a.action === "gmail_send");
  assert.ok(row, "there is a receipt");
  assert.ok(row.target.includes(WORK), `and it names the account: ${row.target}`);
  assert.equal(/access-|refresh-/.test(JSON.stringify(row)), false, "and no token anywhere in it");
});

// ---------- the migration ----------

/**
 * A database in the shape that existed before this: oauth_tokens keyed UNIQUE(conversation_id,
 * provider), with somebody's live Google grant in it. This is the state the running Reason is in, so
 * the migration has to be proved against it rather than against a fresh install.
 */
function oldShapeDatabase(path) {
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE oauth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      expires_at INTEGER,
      account_label TEXT NOT NULL DEFAULT '',
      connected_at INTEGER NOT NULL,
      refreshed_at INTEGER,
      UNIQUE(conversation_id, provider)
    );
    CREATE TABLE connected_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      connected_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    INSERT INTO oauth_tokens (id, conversation_id, provider, access_token, refresh_token, scope, expires_at, account_label, connected_at, refreshed_at)
      VALUES (1, 'dm:owner', 'google', 'live-access', 'live-refresh', 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify', 9999999999999, 'omari@example.com', 1700000000000, 1700000000001);
    INSERT INTO oauth_tokens (id, conversation_id, provider, access_token, refresh_token, scope, expires_at, account_label, connected_at, refreshed_at)
      VALUES (2, 'dm:owner', 'spotify', 'sp-access', 'sp-refresh', 'user-read-private', 9999999999999, '', 1700000000000, 1700000000001);
    INSERT INTO connected_accounts (conversation_id, name, scopes, connected_at) VALUES ('dm:owner', 'gmail', '["read_mail"]', 1700000000000);
    INSERT INTO connected_accounts (conversation_id, name, scopes, connected_at) VALUES ('dm:owner', 'google_calendar', '["read_events"]', 1700000000000);
  `);
  old.close();
}

/**
 * Open that database through the real src/db.js, in its own process — the module holds one connection
 * for the life of a process, so the only honest way to test a migration is to run one.
 */
function openThrough(path) {
  const script = `
    process.env.REASON_DB_PATH = ${JSON.stringify(path)};
    process.env.REASON_DATA_DIR = ${JSON.stringify(dir)};
    process.env.REASON_CONVERSATION = "dm:owner";
    const db = await import(${JSON.stringify(new URL("../src/db.js", import.meta.url).href)});
    const sql = db.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'oauth_tokens'").get().sql;
    console.log(JSON.stringify({
      migration: db.oauthPerAccountMigration,
      unique_key_per_account: /UNIQUE\\(conversation_id, provider, account_label\\)/.test(sql),
      google: db.listOauthTokens("dm:owner", "google"),
      spotify: db.listOauthTokens("dm:owner", "spotify"),
      account_rows: db.db.prepare("SELECT name, account_label FROM connected_accounts ORDER BY name").all(),
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
}

test("the migration keeps every row of a database in the old shape, including the live refresh token", () => {
  const path = join(dir, "old-shape.db");
  oldShapeDatabase(path);
  const after = openThrough(path);

  assert.equal(after.migration.migrated, true, "it really did rebuild the table");
  assert.equal(after.migration.kept_every_row, true);
  assert.equal(after.unique_key_per_account, true, "and the key is per account now");

  // The one that matters: somebody's live connection, untouched.
  assert.equal(after.google.length, 1);
  assert.equal(after.google[0].id, 1, "the same row");
  assert.equal(after.google[0].refresh_token, "live-refresh", "the refresh token IS the connection");
  assert.equal(after.google[0].access_token, "live-access");
  assert.equal(after.google[0].account_label, "omari@example.com");
  assert.equal(after.google[0].is_default, 0, "and nothing was invented as a default");
  assert.equal(after.spotify.length, 1, "and the provider that is still one-per-person is untouched");
  assert.equal(after.spotify[0].refresh_token, "sp-refresh");

  // The account rows learn which address they were always about, so a dead one can be named later.
  assert.deepEqual(after.account_rows, [
    { name: "gmail", account_label: "omari@example.com" },
    { name: "google_calendar", account_label: "omari@example.com" },
  ]);
});

test("running the migration a second time changes nothing", () => {
  const path = join(dir, "old-shape-twice.db");
  oldShapeDatabase(path);
  const first = openThrough(path);
  assert.equal(first.migration.migrated, true);

  const second = openThrough(path);
  assert.equal(second.migration.migrated, false, "it saw the new key and left it alone");
  assert.match(second.migration.why, /already keyed per account/);
  assert.deepEqual(second.google, first.google, "and every row is exactly as it was");
  assert.deepEqual(second.spotify, first.spotify);
  assert.deepEqual(second.account_rows, first.account_rows);
});

test("a migrated connection goes on working, and a second account can be added to it", () => {
  const path = join(dir, "old-shape-usable.db");
  oldShapeDatabase(path);
  openThrough(path);

  // Opened again, the migrated row is readable through the ordinary single-account path — which is what
  // "no reconnect needed" means — and a second address can be stored alongside it.
  const script = `
    process.env.REASON_DB_PATH = ${JSON.stringify(path)};
    process.env.REASON_DATA_DIR = ${JSON.stringify(dir)};
    process.env.REASON_CONVERSATION = "dm:owner";
    const db = await import(${JSON.stringify(new URL("../src/db.js", import.meta.url).href)});
    const before = db.getOauthTokens("dm:owner", "google");
    db.saveOauthTokens("dm:owner", "google", { accessToken: "a2", refreshToken: "r2", scope: "s", expiresAt: null, accountLabel: "work@example.com" });
    console.log(JSON.stringify({
      before_label: before.account_label,
      before_refresh: before.refresh_token,
      labels: db.listOauthTokens("dm:owner", "google").map(r => r.account_label),
      original_still_there: db.getOauthTokens("dm:owner", "google", { account: "omari@example.com" }).refresh_token,
    }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
  assert.equal(out.before_label, "omari@example.com", "the old row answers an unnamed lookup, as it always did");
  assert.equal(out.before_refresh, "live-refresh");
  assert.deepEqual(out.labels, ["omari@example.com", "work@example.com"]);
  assert.equal(out.original_still_there, "live-refresh", "and adding one did not disturb it");
});

test("a plain connect from a pre-2026-11-11 grant (mail + broad calendar, no drive.file) still opens the chooser", async () => {
  fake.set({ grantScopes: [google.GMAIL_SCOPE, google.LEGACY_CALENDAR_SCOPE] });
  await connect(ME);
  const another = await call("google_connect", {});
  const q = new URL(providerUrl(another.url)).searchParams;
  assert.equal(q.get("prompt"), "select_account consent", "adding an account is not a top-up");
  assert.equal(q.has("login_hint"), false, "never hint the account they already have");
  assert.match(another.adding_another, /chooser/);
  // While a link NAMING what is missing is a top-up on that account.
  const drive = await call("google_connect", { scopes: google.DRIVE_SCOPES });
  assert.equal(new URL(providerUrl(drive.url)).searchParams.get("login_hint"), ME);
});
