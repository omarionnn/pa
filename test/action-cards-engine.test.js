// The Action Cards ENGINE (src/actionengine.js): what decides which cards exist and the morning text.
//
//   1. the spec's 20-item eval against gather + Stage 1 on a fake Google: the ten that should card
//      reach the model, the ten that should not never do (zero false cards from the skip set), and
//      every reason is counted
//   2. Stage 2's answer is re-validated by code: a bad key, a 13-word title, a second-person prefill
//      or an unknown drawing is dropped, not fixed; one retry on a bad answer, then the day is skipped
//   3. dedupe and rank: a struck-out title never returns, an open card is not doubled, the page's cap
//   4. the morning run end to end: the digest written through createDigest, the sources sealed, the
//      day row with counts and cost, the approved copy for 1 / 2 / 3+ cards, the text counted as
//      proactive and never as a turn, no cards → no text, a capped person gets cards but no text
//   5. the scheduler: 7:30–9:30 their clock, once a day, never two at once, the lane parked past
//      9:30 writes the day off; the API backend never runs it
//   6. the urgent single: only a calendar thing inside two hours, outside quiet hours, two texts a day
//   7. "where did this come from" (class + day, never a subject), "forget it" and "stop showing me X"
//      (mirrored into treat_rules, retired by memory_drop), the tools hidden when the flag is off
//   8. the sweep's own texts limited to time-critical calendar things when cards are on
//
// No model, no network, no API key.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cards-engine-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Kofi Mensah";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_TOKEN_KEY = "47".repeat(32);
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.SENDBLUE_FROM_NUMBER = "+14155550199";
process.env.REASON_ACTION_CARDS = "on";
process.env.REASON_BACKEND = "claude-cli";
process.env.REASON_CARDS_CLI_MODEL = "sonnet";

const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const cards = await import("../src/actioncards.js");
const engine = await import("../src/actionengine.js");
const accounts = await import("../src/accounts.js");
const notice = await import("../src/notice.js");
const background = await import("../src/background.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { Runtime } = await import("../src/runtime.js");
const { cliConfig } = await import("../src/backends/cli.js");
cliConfig.bin = join(dir, "no-claude-here");

const C = "dm:owner";
const OTHER = "dm:sendblue:+13105550000";
const TZ = "America/New_York";
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
// Tuesday 2026-11-17, 08:00 in New York: the eval's dates (Nov 15, 18, 20, 24, 30) sit around it.
const NOW = Date.parse("2026-11-17T13:00:00Z");
const ACCT = { account: "kofi@example.com", token: "tok" };
const tokensFor = async () => ({ ok: true, accounts: [ACCT] });
const noGoogle = async () => ({ ok: false, status: "not_connected" });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  clock.set?.(NOW);
  process.env.REASON_ACTION_CARDS = "on";
  process.env.REASON_BACKEND = "claude-cli";
  engine.resetEngine();
  // Under the test runner the engine refuses the real CLI (whyNot "test_runner") unless a scripted answer is set.
  engine.setCardsAsk(async () => ({ value: { cards: [], skipped: [] } }));
  background.resetLane({ gapMs: 0 });
  db.db.exec(`DELETE FROM action_digests; DELETE FROM action_cards; DELETE FROM action_card_dismissed; DELETE FROM action_card_events;
    DELETE FROM action_card_days; DELETE FROM action_card_sources; DELETE FROM card_skip_rules; DELETE FROM treat_rules;
    DELETE FROM messages; DELETE FROM timers; DELETE FROM flights; DELETE FROM subscriptions; DELETE FROM notice_seen; DELETE FROM notice_budget;
    DELETE FROM usage; DELETE FROM accounts; DELETE FROM outbox; DELETE FROM conversations; DELETE FROM event_log;`);
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Kofi Mensah", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "test", address: "+13105550000", name: "Ama", isOperator: false });
});

// ---------------------------------------------------------------- a fake Google

const hdr = (From, Subject, Date, extra = {}) => [{ name: "From", value: From }, { name: "Subject", value: Subject }, { name: "Date", value: Date }, { name: "To", value: "kofi@example.com" },
  ...Object.entries(extra).map(([name, value]) => ({ name, value }))];
const msg = ({ id, thread = id, from, subject, date = "Mon, 16 Nov 2026 09:00:00 -0500", snippet = "", unread = true, extra = {} }) =>
  ({ id, threadId: thread, labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"], snippet, payload: { headers: hdr(from, subject, date, extra) } });
const mine = (id, thread, snippet, date = "Mon, 16 Nov 2026 12:00:00 -0500") => msg({ id, thread, from: "Kofi Mensah <kofi@example.com>", subject: "Re:", date, snippet, unread: false });
const ev = ({ id, summary, start, location = "", status = "confirmed", self = "accepted", organizer = "ana@example.com", description = "" }) => ({
  id, summary, status, description, ...(location ? { location } : {}), organizer: { email: organizer },
  start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + HOUR).toISOString() },
  attendees: [{ email: "kofi@example.com", responseStatus: self, self: true }, { email: organizer, responseStatus: "accepted", displayName: "Ana Lopez" }],
});

/** `read(account, method, path, opts)` over an in-memory mailbox and calendar. */
function fakeGoogle({ mail = [], threads = {}, events = [] } = {}) {
  const calls = [];
  const byId = new Map(mail.map(m => [m.id, m]));
  return {
    calls,
    read: async (acct, method, path, opts = {}) => {
      calls.push(`${method} ${path}`);
      const q = String(opts.query?.q ?? "");
      if (path === "/gmail/v1/users/me/messages") {
        const due = /subject:\(/.test(q);
        const pick = mail.filter(m => m.labelIds.includes("UNREAD") && (!due || /invoice|bill|statement|payment|due|receipt|appointment|reminder|confirmation/i.test(m.payload.headers.find(h => h.name === "Subject")?.value ?? "")));
        return { ok: true, status: 200, body: { messages: pick.slice(0, Number(opts.query?.maxResults ?? 25)).map(m => ({ id: m.id, threadId: m.threadId })) } };
      }
      let m;
      if ((m = path.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/))) {
        const one = byId.get(decodeURIComponent(m[1]));
        return one ? { ok: true, status: 200, body: one } : { ok: false, status: 404 };
      }
      if ((m = path.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/))) {
        const t = decodeURIComponent(m[1]);
        const list = threads[t] ?? mail.filter(x => x.threadId === t);
        return list.length ? { ok: true, status: 200, body: { messages: list } } : { ok: false, status: 404 };
      }
      if (path === "/calendar/v3/calendars/primary/events") return { ok: true, status: 200, body: { items: events } };
      if ((m = path.match(/^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/))) {
        const one = events.find(e => e.id === decodeURIComponent(m[1]));
        return one ? { ok: true, status: 200, body: one } : { ok: false, status: 404 };
      }
      return { ok: false, status: 404 };
    },
  };
}

/** A scripted Stage 2: one card per candidate it is shown, verb by kind, shaped like the spec's. */
const VERB_FOR = { mail_unread: "REPLY", mail_due: "PAY", alerts: "DIAGNOSE", calendar_rsvp: "REPLY", calendar_occasion: "PLAN", calendar_unbooked: "CONFIRM", calendar_place: "BOOK", chat: "CANCEL", flight_checkin: "CONFIRM", subscription_renewal: "RENEW", calendar_moved: "PLAN", calendar_new: "PLAN" };
function scriptedAsk(custom = null) {
  const asked = [];
  const ask = async ({ prompt, system, schema, model, feature }) => {
    asked.push({ prompt, system, model, feature, schema });
    if (custom) return custom({ prompt, asked });
    const keys = [...prompt.matchAll(/^- \[([^\]]+)\]/gm)].map(m => m[1]).filter(k => !k.startsWith("chat:") || /cancel|need to/i.test(prompt.split(`[${k}]`)[1]?.split("\n")[0] ?? ""));
    const made = keys.map((key, i) => {
      const kind = Object.keys(VERB_FOR).find(k => prompt.includes(`[${key}]`) && key.startsWith(k.split("_")[0] === "mail" ? "mail" : k.startsWith("calendar") ? "cal" : k === "chat" ? "chat" : "own")) ?? "mail_unread";
      const verb = key.startsWith("cal:") ? "PLAN" : key.startsWith("chat:") ? "CANCEL" : key.startsWith("own:flights") ? "CONFIRM" : key.startsWith("own:") ? "RENEW" : /alert|×/.test(prompt.split(`[${key}]`)[1]?.split("\n")[0] ?? "") ? "DIAGNOSE" : "REPLY";
      return { candidate_key: key, verb, title: `${verb[0]}${verb.slice(1).toLowerCase()} your thing number ${i + 1} by Nov 20`, why_now: `It is due soon and nothing is booked yet.`,
        lead: `your thing number ${i + 1} is due Nov 20`, prefill: `${verb[0]}${verb.slice(1).toLowerCase()} my thing number ${i + 1} by Nov 20`, offer: "want me to sort it?",
        drawing: ["key", "cake", "server", "calendar", "mail", "phone", "bag", "tooth", "note"][i % 9], urgency: 5 - (i % 5), effort_saved: 3, can_do: "most" };
    });
    return { value: { cards: made, skipped: [] }, usage: { input_tokens: 4200, output_tokens: 650 }, models: ["claude-sonnet-5-5"] };
  };
  return { ask, asked };
}

/** A runtime stand-in: records texts, honours a cap. */
function fakeRuntime({ allow = true } = {}) {
  const sent = [];
  return { sent, mayInterrupt: () => allow, _tell: async (c, text, meta) => { sent.push({ c, text, ...meta }); return { ok: true }; } };
}

// ---------------------------------------------------------------- 1. the eval

const EVAL = () => {
  const d = (n) => NOW + n * DAY;
  const mail = [
    // should card
    msg({ id: "m1", from: "Anthropic <support@anthropic.com>", subject: "Your Anthropic API key expires on Nov 18", snippet: "The key ending 4f2a expires on Nov 18. Create a new key before then.", date: "Tue, 17 Nov 2026 06:10:00 -0500" }),
    msg({ id: "m3", from: "Dana Park <dana@parkproperties.com>", subject: "Lease renewal due by Nov 30, reply to confirm", snippet: "Please reply to confirm you are renewing for another year by Nov 30." }),
    msg({ id: "m5", from: "Northwind Supply <billing@northwind.example>", subject: "Invoice #2231 due Nov 15", snippet: "Invoice #2231 for $420 is due Nov 15." }),
    msg({ id: "m8", from: "Bright Smiles Dental <office@brightsmiles.example>", subject: "Please confirm your appointment Nov 20, reply YES", snippet: "Reply YES to confirm your cleaning on Nov 20 at 10am." }),
    ...[1, 2, 3, 4, 5, 6].map(i => msg({ id: `a${i}`, thread: `a${i}`, from: "Monitoring <alerts@mon.example>", subject: `ALERT: web-1 is DOWN (check ${i})`, snippet: "HTTP check failed, host unreachable", date: `Tue, 17 Nov 2026 0${i}:00:00 -0500` })),
    // should skip
    msg({ id: "m11", from: "The Weekly <hello@theweekly.example>", subject: "This week in product", snippet: "Our newsletter", extra: { "List-Unsubscribe": "<mailto:u@theweekly.example>" } }),
    msg({ id: "m12", from: "Shop <orders@shop.example>", subject: "Your order has shipped", snippet: "Your package is on its way." }),
    msg({ id: "m13", from: "Yaw Owusu <yaw@example.org>", subject: "Can you send the deck by Friday?", snippet: "Need the deck before the call." }),
    msg({ id: "m14", from: "Acme Water <billing@acmewater.example>", subject: "Bill due Nov 19", snippet: "Your water bill is due Nov 19." }),
    msg({ id: "m16", from: "Globex <invoices@globex.example>", subject: "Invoice 88 due Nov 21", snippet: "Please pay invoice 88 by Nov 21." }),
    msg({ id: "m17", from: "CityRx Pharmacy <rx@cityrx.example>", subject: "Your refill is ready", snippet: "Your prescription refill is ready for pickup." }),
    msg({ id: "m18", from: "Gadget Store <deals@gadgets.example>", subject: "20% off this weekend", snippet: "Two days only." }),
  ];
  const threads = {
    m13: [mail.find(x => x.id === "m13"), mine("m13r", "m13", "Sent, let me know if the link works.")],
    m14: [mail.find(x => x.id === "m14"), mine("m14r", "m14", "paid, thanks")],
  };
  const events = [
    ev({ id: "e2", summary: "Dinner — Mom's birthday", start: d(7) + 6 * HOUR }),
    ev({ id: "e6", summary: "Design review with Ana", start: Date.parse("2026-11-19T14:00:00Z"), location: "455 Market St, San Francisco" }),
    ev({ id: "e10", summary: "Q4 planning", start: d(5), self: "needsAction", organizer: "ana@example.com" }),
    ev({ id: "e15", summary: "1:1 with Ana", start: d(3) }),
    ev({ id: "e19", summary: "Offsite", start: d(40), location: "Napa" }),
  ];
  return { mail, threads, events };
};

function seedOwnRows() {
  db.recordFlight(C, { airline: "Delta", flightNumber: "DL 404", departsLocal: "2026-11-18 06:00", timeZone: TZ, departsAt: NOW + 22 * HOUR, checkinOpensAt: NOW - 2 * HOUR, checkinWindowHours: 24, status: "booked", source: "they told me" });
  const say = (text, at) => db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, 'user', 'test', ?, ?)").run(C, text, at);
  say("I need to cancel the gym before December", NOW - 3 * DAY);
  say("remind me at 6 to call dad", NOW - 2 * DAY);
  say("lol ok", NOW - DAY);
  db.db.prepare("INSERT INTO timers (conversation_id, fire_at, note) VALUES (?, ?, ?)").run(C, NOW + 10 * HOUR, "call dad");
  engine.addSkipRule(C, { scope: "sender", value: "globex", said: "stop showing me invoices from Globex" });
}

test("eval: the ten that should card reach the model and the ten that should not never do (Stage 1, fake Google)", async () => {
  seedOwnRows();
  const g = fakeGoogle(EVAL());
  const logs = [];
  const bundle = await engine.gather({ conversationId: C, now: NOW, tz: TZ, read: g.read, tokensFor, log: (l) => logs.push(l) });
  assert.equal(bundle.failed.length, 0);
  const s1 = await engine.stage1(C, bundle, { now: NOW, api: g.read, accounts: [ACCT], log: (l) => logs.push(l) });
  const kept = new Set(s1.keep.map(k => k.key));
  const has = (part) => [...kept].some(k => k.includes(part));
  const line = (part) => s1.keep.find(k => k.key.includes(part));
  const should = {
    1: has(":m1"), 2: has("e2@"), 3: has(":m3"), 4: has("own:flights:"), 5: has(":m5"), 6: has("e6@"),
    7: !!s1.keep.find(k => k.source === "chat" && /gym/.test(k.line)), 8: has(":m8"), 9: has(":a1") && line(":a1").count === 6 && /×6/.test(line(":a1").line), 10: has("e10@"),
  };
  const skip = {
    11: !has(":m11"), 12: !has(":m12"), 13: !has(":m13"), 14: !has(":m14"), 15: !has("e15@"), 16: !has(":m16"), 17: !has(":m17"), 18: !has(":m18"), 19: !has("e19@"),
    20: !s1.keep.find(k => k.source === "chat" && /call dad/.test(k.line)),
  };
  const score = [...Object.values(should), ...Object.values(skip)].filter(Boolean).length;
  const falseCards = Object.entries(skip).filter(([, ok]) => !ok).map(([n]) => n);
  // Printed so the PR carries the number.
  if (score < 20) console.log("eval misses:", JSON.stringify({ should, skip }));
  console.log(`eval: ${score}/20 (should-card ${Object.values(should).filter(Boolean).length}/10, should-skip ${Object.values(skip).filter(Boolean).length}/10)`);
  assert.deepEqual(falseCards, [], "zero false cards from the skip set");
  assert.ok(score >= 18, `pass bar is 18/20, got ${score}: ${JSON.stringify({ should, skip })}`);
  // Counts per reason, never a title, in the log.
  assert.equal(s1.dropped.bulk, 2, "newsletter + promo");
  assert.equal(s1.dropped.receipt, 1);
  assert.equal(s1.dropped.handled, 3, "replied, paid, the timer");
  assert.equal(s1.dropped.skip_rule, 1);
  assert.equal(s1.dropped.health, 1);
  assert.ok(s1.dropped.too_far >= 1);
  assert.equal(s1.keep.filter(k => k.source !== "chat").length <= engine.STAGE1_KEEP, true);
  const logged = JSON.stringify(logs);
  assert.doesNotMatch(logged, /Anthropic|Lease|Invoice|anthropic\.com|Mom's/);
  // Nothing of the mailbox beyond headers and snippets was read: no body fetch, no sent-mail probe.
  assert.ok(g.calls.every(cl => !/format=full|in:sent/.test(cl)));
});

test("Stage 2's answer is re-validated: bad key, long title, second-person prefill, unknown drawing are dropped; the titles pass the spec's bar", async () => {
  const known = new Set(["mail:a:1", "cal:a:2@x"]);
  const good = { candidate_key: "mail:a:1", verb: "REPLACE", title: "Replace your Anthropic key before it expires Nov 18", why_now: "It stops working next week.", lead: "your Anthropic key expires Nov 18", prefill: "Replace my Anthropic key before it expires Nov 18", drawing: "key", urgency: 4, effort_saved: 3, can_do: "most" };
  assert.ok(engine.validCard(good, known));
  assert.equal(engine.validCard({ ...good, candidate_key: "mail:a:9" }, known), null, "a key the model made up");
  assert.equal(engine.validCard({ ...good, title: "One two three four five six seven eight nine ten eleven twelve thirteen" }, known), null, "13 words");
  assert.equal(engine.validCard({ ...good, prefill: "Replace your key" }, known), null, "second person");
  assert.equal(engine.validCard({ ...good, prefill: "Please replace it" }, known), null, "not first person");
  assert.equal(engine.validCard({ ...good, drawing: "logo" }, known), null);
  assert.equal(engine.validCard({ ...good, verb: "FIX" }, known), null);
  assert.equal(engine.validCard({ ...good, lead: "" }, known), null);
  const v = engine.validCard({ ...good, urgency: 9, effort_saved: 0, offer: "want me to do it now for you right away please?" }, known);
  assert.equal(v.urgency, 5); assert.equal(v.effort, 1); assert.equal(v.offer, "", "an 11-word offer is dropped, not cut");
  // One retry on a bad answer, then skipped; a refusal is not retried.
  let n = 0;
  const bad = await engine.stage2(C, { candidates: [{ key: "mail:a:1", source: "mail", line: "x" }], chat: [], now: NOW, tz: TZ, ask: async () => { n++; return { error: "the answer was not JSON" }; } });
  assert.equal(n, 2); assert.equal(bad.error, "bad_answer");
  n = 0;
  const limited = await engine.stage2(C, { candidates: [{ key: "mail:a:1", source: "mail", line: "x" }], chat: [], now: NOW, tz: TZ, ask: async () => { n++; return { error: "Claude usage limit reached" }; } });
  assert.equal(n, 1); assert.equal(limited.error, "cli_unavailable");
});

test("dedupe and rank: a struck-out title never returns, an open card is not doubled, the page's cap holds, urgency wins", () => {
  const mk = (title, urgency = 3, effort = 3) => ({ key: `k:${title}`, verb: "PLAN", title, whyNow: "", lead: "x", prefill: `Plan my ${title.toLowerCase()}`, drawing: "note", urgency, effort, candidate: { due_at: NOW + DAY } });
  const d = cards.createDigest(C, [{ verb: "PLAN", title: "Plan your birthday dinner for Nov 24", prefill: "Plan my birthday dinner for Nov 24", drawing: "cake" }, { verb: "PAY", title: "Pay the water bill by Nov 19", prefill: "Pay my water bill by Nov 19", drawing: "note" }]);
  cards.dismiss(d.id, d.cards[1].code);
  const out = engine.dedupeAndRank(C, [
    mk("Plan your birthday dinner for Nov 24"), mk("Pay the water bill by Nov 19"), mk("Pay your water bill by Nov 19, please"),
    mk("Book a ride for Thursday", 2), mk("Replace your key by Nov 18", 5), mk("Renew the lease by Nov 30", 4), mk("Confirm the dentist Nov 20", 4, 5), mk("Cancel the gym", 1), mk("Call the landlord", 1),
  ], { now: NOW });
  assert.equal(out.dropped.open, 1); assert.equal(out.dropped.dismissed, 2);
  assert.equal(out.cards.length, cards.MAX_CARDS);
  assert.deepEqual(out.cards.slice(0, 3).map(c => c.title), ["Replace your key by Nov 18", "Confirm the dentist Nov 20", "Renew the lease by Nov 30"]);
});

test("the morning run: digest through createDigest, sources sealed, day row with cost, the approved copy, proactive not turn, no cards → no text", async () => {
  seedOwnRows();
  const g = fakeGoogle(EVAL());
  const { ask, asked } = scriptedAsk();
  const rt = fakeRuntime();
  const logs = [];
  const out = await engine.runMorning(C, { now: NOW, tz: TZ, read: g.read, tokensFor, ask, runtime: rt, log: (l) => logs.push(l) });
  assert.equal(out.outcome, "cards");
  assert.equal(asked.length, 1); assert.equal(asked[0].feature, "action_cards"); assert.equal(asked[0].model, "sonnet");
  assert.match(asked[0].system, /Kofi Mensah/); assert.match(asked[0].system, /Tuesday, Nov 17, 2026/);
  assert.match(asked[0].prompt, /What they said to Reason in the last week/);
  const open = cards.openCards(C, { now: NOW });
  assert.equal(open.length, cards.MAX_CARDS);
  assert.ok(open.every(c => /^[A-Z][a-z]+ your thing number \d+ by Nov 20$/.test(c.title)));
  // The day row: counts and cost, never a title.
  const day = engine.dayRow(C, "2026-11-17");
  assert.equal(day.outcome, "cards"); assert.equal(day.cards, cards.MAX_CARDS); assert.equal(day.texts_sent, 1); assert.ok(day.texted_at);
  assert.equal(day.input_tokens, 4200); assert.ok(day.cost_usd > 0); assert.equal(day.cost_from, "tokens"); assert.equal(day.model, "claude-sonnet-5-5");
  assert.ok(day.candidates > day.after_stage1); assert.match(day.dropped, /"bulk":2/);
  // The source rows: one per card, sealed refs, the kind and class.
  const srcs = db.db.prepare("SELECT * FROM action_card_sources WHERE conversation_id = ?").all(C);
  assert.equal(srcs.length, cards.MAX_CARDS);
  assert.ok(srcs.every(s => s.source_key && s.source));
  // The text: the approved copy, from the top card's lead, lowercased first name, the link.
  assert.equal(rt.sent.length, 1);
  assert.equal(rt.sent[0].text, `morning kofi. your thing number 1 is due Nov 20. that and ${cards.MAX_CARDS - 1} more when you want them: ${cards.urlOf(cards.tokenOf(day.digest_id))}`);
  assert.equal(rt.sent[0].idempotencyKey, `cards:${C}:2026-11-17:morning`);
  // Counted as proactive; never a turn (the free tier's conversations are untouched).
  const usage = db.db.prepare("SELECT * FROM usage WHERE conversation_id = ?").all(C);
  assert.equal(usage.reduce((n, u) => n + (u.proactive ?? 0), 0), 1);
  assert.equal(usage.reduce((n, u) => n + (u.turns ?? u.turn ?? 0), 0), 0);
  // Logs: counts and outcomes only.
  assert.doesNotMatch(JSON.stringify(logs), /thing number|Anthropic|Lease/);
  // Same day again: nothing, not even a read.
  const again = await engine.runMorning(C, { now: NOW + HOUR, tz: TZ, read: g.read, tokensFor, ask, runtime: rt });
  assert.equal(again.skipped, "already_ran"); assert.equal(asked.length, 1); assert.equal(rt.sent.length, 1);
  // Tomorrow, every candidate already a card → empty, no text, no digest.
  const next = await engine.runMorning(C, { now: NOW + DAY, tz: TZ, read: g.read, tokensFor, ask: async () => ({ value: { cards: [], skipped: [] } }), runtime: rt });
  assert.equal(next.outcome, "empty"); assert.equal(rt.sent.length, 1);
  assert.equal(engine.dayRow(C, "2026-11-18").outcome, "empty");
});

test("the copy for one, two and three cards; a capped person gets the page but no text; Google down skips the source", async () => {
  assert.equal(engine.morningText({ name: "kofi", lead: "your Anthropic key expires Nov 18.", count: 1, url: "L" }), "morning kofi. one thing i can take off your plate: your Anthropic key expires Nov 18. L");
  assert.equal(engine.morningText({ name: "kofi", lead: "your Anthropic key expires Nov 18", count: 2, url: "L" }), "morning kofi. your Anthropic key expires Nov 18. that and one more: L");
  assert.equal(engine.morningText({ name: "kofi", lead: "your Anthropic key expires Nov 18", count: 3, url: "L" }), "morning kofi. your Anthropic key expires Nov 18. that and 2 more when you want them: L");
  assert.equal(engine.urgentText({ name: "kofi", lead: "your 2pm with Ana moved to 1:30", offer: "want me to move your ride", url: "L" }), "kofi, your 2pm with Ana moved to 1:30. want me to move your ride? L");
  assert.equal(engine.morningText({ name: "", lead: "your lease renews Nov 30", count: 1, url: "L" }), "morning. one thing i can take off your plate: your lease renews Nov 30. L");
  seedOwnRows();
  const rt = fakeRuntime({ allow: false });
  const out = await engine.runMorning(C, { now: NOW, tz: TZ, tokensFor: noGoogle, ask: scriptedAsk().ask, runtime: rt });
  assert.equal(out.outcome, "cards", "the chat line and the flight carded without Google");
  assert.equal(rt.sent.length, 0, "mayInterrupt said no: no text");
  assert.equal(engine.dayRow(C, "2026-11-17").texts_sent, 0);
  assert.ok(cards.openCards(C).length >= 1, "the page still exists for when they ask");
});

test("the scheduler: 7:30–9:30 their clock, once a day, never two at once, the lane parked past 9:30 writes the day off, never on the API", async () => {
  db.setNoticeWindow(OTHER, { tz: "Asia/Tokyo" });
  const queued = [];
  const queue = (key, fn) => { queued.push(key); return new Promise(() => {}); }; // never settles: still running
  const at = (iso) => Date.parse(iso);
  // 07:29 New York: not yet. 07:30: queued. Tokyo at that moment is 21:30: no.
  assert.equal(engine.sweepCards({ now: at("2026-11-17T12:29:00Z"), queue }).queued, 0);
  assert.equal(engine.sweepCards({ now: at("2026-11-17T12:30:00Z"), queue }).queued, 1);
  assert.deepEqual(queued, [`cards:${C}`]);
  // Fifteen seconds later: still running, not queued twice.
  assert.equal(engine.sweepCards({ now: at("2026-11-17T12:30:15Z"), queue }).queued, 0);
  const fresh = () => { engine.resetEngine(); engine.setCardsAsk(async () => ({ value: { cards: [], skipped: [] } })); };
  // Ran: a row for today means nothing more today, even inside the window.
  fresh();
  db.db.prepare("INSERT INTO action_card_days (conversation_id, day, run_at, outcome) VALUES (?, '2026-11-17', ?, 'cards')").run(C, at("2026-11-17T12:31:00Z"));
  assert.equal(engine.sweepCards({ now: at("2026-11-17T13:00:00Z"), queue }).queued, 0);
  // Tokyo's own 7:30 (22:30 UTC the day before): queued for them on their day.
  const r = engine.sweepCards({ now: at("2026-11-17T22:30:00Z"), queue });
  assert.equal(r.queued, 1); assert.equal(queued.at(-1), `cards:${OTHER}`);
  // The lane never ran it and 9:30 came: the day is written off as lane_unavailable, once.
  fresh();
  db.db.exec("DELETE FROM action_card_days");
  const parked = (key, fn) => new Promise(() => {});
  engine.sweepCards({ now: at("2026-11-17T12:30:00Z"), queue: parked });
  assert.equal(engine.sweepCards({ now: at("2026-11-17T14:00:00Z"), queue: parked }).queued, 0, "still waiting in the lane: not queued twice");
  const late = engine.sweepCards({ now: at("2026-11-17T14:31:00Z"), queue: parked });
  assert.equal(late.skipped_days, 1);
  assert.equal(engine.dayRow(C, "2026-11-17").why, "lane_unavailable");
  assert.equal(engine.sweepCards({ now: at("2026-11-17T14:32:00Z"), queue: parked }).skipped_days, 0, "once");
  // The job the lane finally runs at noon finds the row and does nothing; one that lands late with no row is "late".
  assert.equal((await engine.runMorning(C, { now: at("2026-11-17T17:00:00Z"), tz: TZ, tokensFor: noGoogle })).skipped, "already_ran");
  db.db.exec("DELETE FROM action_card_days");
  assert.equal((await engine.runMorning(C, { now: at("2026-11-17T17:00:00Z"), tz: TZ, tokensFor: noGoogle })).skipped, "late");
  assert.equal(engine.dayRow(C, "2026-11-17").why, "late");
  db.db.exec("DELETE FROM action_card_days");
  // The API backend: never.
  process.env.REASON_BACKEND = "api";
  assert.equal(engine.sweepCards({ now: at("2026-11-18T12:30:00Z"), queue }).skipped, "not_on_cli");
  process.env.REASON_BACKEND = "claude-cli";
  // The flag off: nothing for anybody; owner: only the operator.
  process.env.REASON_ACTION_CARDS = "off";
  assert.equal(engine.sweepCards({ now: at("2026-11-18T12:30:00Z"), queue }).skipped, "off");
  process.env.REASON_ACTION_CARDS = "owner";
  queued.length = 0;
  fresh();
  engine.sweepCards({ now: at("2026-11-18T22:30:00Z"), queue });
  assert.deepEqual(queued, [], "Ama's 7:30 under owner mode: nothing");
});

test("the urgent single: a calendar thing inside two hours, outside quiet hours, one text, never a third text", async () => {
  const rt = fakeRuntime();
  const { ask } = scriptedAsk();
  const soon = new Date(NOW + 90 * MIN).toISOString();
  const cand = { kind: "calendar_moved", key: `k:1`, what: "Design review moved from 9:00 to 9:30", starts: soon, account: ACCT.account, event_id: "e6" };
  const queue = async (key, fn) => fn();
  const r = engine.urgentFrom(C, [cand], { now: NOW, tz: TZ, ask, queue, runtime: rt });
  assert.ok(r.queued);
  await new Promise(res => setTimeout(res, 20));
  assert.equal(rt.sent.length, 1);
  assert.match(rt.sent[0].text, /^kofi, your thing number 1 is due Nov 20\. want me to sort it\? https:\/\/heyreason\.com\/a\//);
  assert.equal(engine.dayRow(C, "2026-11-17").urgent_sent, 1);
  // The same thing again: already a card.
  assert.equal(engine.urgentFrom(C, [cand], { now: NOW + MIN, tz: TZ, ask, queue, runtime: rt }).skipped, "nothing_time_critical");
  // A mail thing, or a meeting three hours out: not urgent.
  assert.equal(engine.urgentFrom(C, [{ kind: "mail_waiting", key: "m", what: "x" }], { now: NOW, tz: TZ, ask, queue, runtime: rt }).skipped, "nothing_time_critical");
  assert.equal(engine.urgentFrom(C, [{ ...cand, key: "k:2", event_id: "e7", starts: new Date(NOW + 3 * HOUR).toISOString() }], { now: NOW, tz: TZ, ask, queue, runtime: rt }).skipped, "nothing_time_critical");
  // The morning text already went today: a second urgent would be a third text → no.
  db.db.prepare("UPDATE action_card_days SET texts_sent = 1 WHERE conversation_id = ?").run(C);
  assert.equal(engine.urgentFrom(C, [{ ...cand, key: "k:3", event_id: "e8" }], { now: NOW, tz: TZ, ask, queue, runtime: rt }).skipped, "two_texts_today");
  // Their night: no.
  assert.equal(engine.urgentFrom(C, [cand], { now: Date.parse("2026-11-18T04:00:00Z"), tz: TZ, ask, queue, runtime: rt }).skipped, "quiet_hours");
  // An urgent single before 7:30 does not count as the morning run: the run still happens.
  db.db.exec("DELETE FROM action_card_days");
  db.db.prepare("INSERT INTO action_card_days (conversation_id, day, run_at, outcome, urgent_sent) VALUES (?, '2026-11-17', ?, 'urgent', 1)").run(C, NOW);
  assert.equal(engine.ranToday(C, "2026-11-17"), false);
  const morning = await engine.runMorning(C, { now: NOW, tz: TZ, tokensFor: noGoogle, ask, runtime: rt });
  assert.equal(morning.outcome, "empty");
  assert.equal(engine.dayRow(C, "2026-11-17").urgent_sent, 1, "the urgent count survives the morning row");
  assert.equal(engine.textsToday(C, "2026-11-17"), 1);
});

test("where did this come from: a class and a day, never a subject; show_source hands the thread to gmail_read; forget it; stop showing me X", async () => {
  seedOwnRows();
  const g = fakeGoogle(EVAL());
  await engine.runMorning(C, { now: NOW, tz: TZ, read: g.read, tokensFor, ask: scriptedAsk().ask, runtime: fakeRuntime() });
  const open = cards.openCards(C, { now: NOW });
  const call = (name, input, conversationId = C) => runTool(name, input, { conversationId, kind: "message", messages: [] });
  const src = await call("action_card_source", { words: open[0].prefill });
  assert.equal(src.ok, true);
  assert.match(src.from, /^(from a mail on Tuesday|from a mail on Monday|on your calendar for Nov \d+|you mentioned it on \w+day|from something Reason is already keeping track of)/);
  assert.doesNotMatch(JSON.stringify(src), /anthropic\.com|Invoice #|ALERT|@/);
  const mailCard = open.map(c => ({ c, s: engine.sourceOf(C, c.id, { showSource: true }) })).find(x => x.s.source === "mail");
  if (mailCard) {
    assert.equal(mailCard.s.open_with.tool, "gmail_read");
    assert.ok(mailCard.s.open_with.thread_id);
    const shown = await call("action_card_source", { words: mailCard.c.prefill, show_source: true });
    assert.equal(shown.open_with.tool, "gmail_read");
  }
  assert.equal((await call("action_card_source", { words: "the moon landing" })).ok, false);
  // Forget it: struck out, never offered again.
  const gone = await call("action_card_forget", { words: open[1].prefill });
  assert.equal(gone.struck.now, "dismissed");
  assert.ok(cards.wasDismissed(C, open[1].title));
  assert.equal(cards.openCards(C, { now: NOW }).length, open.length - 1);
  // Stop showing me X: a structured rule AND a treat_rules row; dropping the rule retires both.
  const stop = await call("action_card_forget", { stop_scope: "kind", stop_value: "invoices", their_words: "stop showing me invoices" });
  assert.equal(stop.standing_rule.scope, "kind");
  assert.ok(stop.standing_rule.memory_rule_id);
  assert.match(db.activeRules(C).map(r => r.rule).join("|"), /Never offer me a card about invoices/);
  assert.equal(engine.skipRules(C).length, 2);
  const dropped = await call("memory_drop", { row: "rule", id: stop.standing_rule.memory_rule_id });
  assert.equal(dropped.ok, true);
  assert.equal(engine.skipRules(C).length, 1, "the skip rule went with its memory row");
  // Another person's cards are not reachable from here.
  assert.equal((await call("action_card_source", { words: open[0].prefill }, OTHER)).ok, false);
  // The tools are hidden when the flag does not reach them.
  assert.ok(toolsFor(C).some(t => t.name === "action_card_source"));
  process.env.REASON_ACTION_CARDS = "owner";
  assert.ok(!toolsFor(OTHER).some(t => t.name === "action_card_forget"));
  process.env.REASON_ACTION_CARDS = "off";
  assert.ok(!toolsFor(C).some(t => t.name === "action_card_source"));
});

test("a card they handled themselves is checked off when the page opens (settleHandled), bounded", async () => {
  const d = cards.createDigest(C, [{ verb: "REPLY", title: "Reply to Ana's Q4 planning invite", prefill: "Reply to Ana's Q4 planning invite", drawing: "calendar" }, { verb: "PLAN", title: "Plan the dinner", prefill: "Plan my dinner", drawing: "cake" }]);
  db.db.prepare("INSERT INTO action_card_sources (card_id, conversation_id, kind, source, source_key, refs, found_at) VALUES (?, ?, 'calendar_rsvp', 'calendar', 'cal:x', ?, ?)")
    .run(d.cards[0].id, C, db.seal2(C, JSON.stringify({ account: ACCT.account, event_id: "e10" })), NOW);
  const g = fakeGoogle({ events: [ev({ id: "e10", summary: "Q4 planning", start: NOW + DAY, status: "cancelled" })] });
  const r = await engine.settleHandled(d, { now: NOW, read: g.read, tokensFor });
  assert.equal(r.handled, 1);
  const after = cards.digestById(d.id, { now: NOW });
  assert.equal(after.cards[0].status, "done"); assert.equal(after.cards[1].status, "open");
  assert.equal(db.db.prepare("SELECT done_via FROM action_card_sources WHERE card_id = ?").get(d.cards[0].id).done_via, "handled");
  // A slow Google: the page is not held.
  const slow = async () => new Promise(res => setTimeout(() => res({ ok: true, status: 200, body: {} }), 500));
  const t0 = Date.now();
  const r2 = await engine.settleHandled(cards.digestById(d.id), { now: NOW, read: slow, tokensFor, timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 400); assert.equal(r2.handled, 0);
});

test("with cards on, the sweep's own texts are limited to time-critical calendar things; the rest is held for the 7:30 page", async () => {
  const turns = [];
  const rt = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push(text); return "NO_REPLY"; } });
  db.setNoticeWindow(C, { tz: TZ, askedAt: NOW - DAY, answeredAt: NOW - DAY, windowStart: 8, windowEnd: 22 });
  const gatherWith = async ({ conversationId }) => conversationId !== C ? { ok: false, status: "not_connected" } : ({ ok: true, time_zone: TZ, candidates: [
    { kind: "mail_waiting", key: "mail:a:t1@0d", thing: "mail:a:t1", what: "Dana emailed about the lease", account: ACCT.account, thread_id: "t1" },
  ], context: [], accounts: [ACCT.account] });
  const out = await rt.notice({ gatherWith, readWith: async () => ({ ok: true, status: 200, body: { messages: [{ id: "x", threadId: "t1", labelIds: ["UNREAD"], payload: { headers: [{ name: "From", value: "dana@x" }] } }] } }), now: NOW });
  assert.equal(out.turns, 0, "a mail thing is not the sweep's to text any more");
  assert.ok(out.held >= 1);
  assert.equal(turns.length, 0);
  db.db.exec("DELETE FROM notice_sweeps");
  const later = NOW + 3 * HOUR;
  const soon = new Date(later + 90 * MIN).toISOString();
  const gatherCal = async ({ conversationId }) => conversationId !== C ? { ok: false, status: "not_connected" } : ({ ok: true, time_zone: TZ, candidates: [
    { kind: "calendar_moved", key: "cal:a:e6@x", thing: "cal:a:e6", what: "Design review moved to 9:30", starts: soon, account: ACCT.account, event_id: "e6", state: soon },
  ], context: [], accounts: [ACCT.account] });
  const out2 = await rt.notice({ gatherWith: gatherCal, readWith: async () => ({ ok: true, status: 200, body: { status: "confirmed", start: { dateTime: soon } } }), now: later });
  assert.equal(out2.urgent_cards, 1, "a meeting inside two hours becomes an urgent single card");
  assert.equal(out2.turns, 0, "and the sweep's own turn does not text the same thing a second time");
});
