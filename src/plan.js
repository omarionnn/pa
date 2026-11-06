// The free trial and the subscription (2026-10-31, the owner's decisions at 23:09 ET).
//
// Reason is free for 25 sessions, then $24.99 a month. A SESSION is a stretch of chat: an inbound
// message that lands 30 minutes or more after the previous one starts a new one, however many texts
// each stretch holds. The count is bumped where the day's turns are counted (accounts.countUse), so a
// burst of three texts is one turn and one visit, never three.
//
//   - `plan` is one row per conversation: sessions used, when they were first seen, where they stand
//     (trial | free | paid | lapsed | cancelled) and the Stripe ids. NOT `subscriptions` — that table
//     is a person's own merchant subscriptions (src/subs.js), nothing to do with paying for Reason.
//   - Grandfathered — free, for good: the operator, every number in REASON_TEST_NUMBERS, and every
//     account made before the switch was first turned on (the flip moment, written once in ops_state;
//     REASON_PAYWALL_SHIP_TS may only move it later — shipTs() below).
//   - At the 25th session the turn's own reply still answers them; THEN three short bubbles go, the
//     onboarding way (one ordered chain, a beat apart): what Reason really did for them, counted from
//     the record (stamps.completions); the ask; the link on its own line. Once, ever.
//   - The WIN RULE (owner, 2026-11-01, the pricing page's words: "pay once it's done something real
//     for you"): the ask at the 25th goes only if Reason has at least one win for them — any finished
//     errand on the record (stamps.completions: a done task, a call that got somewhere, an order
//     placed). No win yet: nothing is said and the trial keeps going a session at a time, up to the
//     30th. The ask then goes on the first inbound after a win lands, or at the 30th regardless, with a
//     softer first line when there is still nothing to point to.
//   - Lapsed (26th session on, unpaid): questions are still answered. Anything that acts — a call, an
//     order, a reminder, research, directions, an event — is refused at the tool with ONE line and the
//     link, at most once a session, and their standing things are held (pause.pauseAll) until they pay.
//   - Paid: Stripe says so by webhook (POST /stripe/webhook, src/http.js). Everything held comes back
//     (pause.resumeAll) and one line says they're all set. Cancelling is a tool (subscription_cancel):
//     at the period's end, with the date access stops said back.
//
// REASON_PAYWALL (off | owner | on). Off is the default and what live runs until the owner flips it
// (2026-11-05: Reason is free for everyone for now): nothing is counted, nothing is ever said, no tool
// is ever refused or shown, the /pay pages are not served and Stripe's webhook acts on nothing. `owner`: the operator's own thread only — and HIS
// grandfather rules are skipped there, or there would be nothing to try. `on`: everybody, minus the
// grandfathered. Read at call time, so a test sets the env and a restart is the only switch.
import * as db from "./db.js";
import { config, clock } from "./config.js";
import * as stripe from "./stripe.js";
import * as stamps from "./stamps.js";

export const TRIAL_SESSIONS = Number(process.env.REASON_PAYWALL_SESSIONS || 25);
/** The trial's hard end when no win has landed: the ask goes here whatever the record says. */
export const TRIAL_MAX_SESSIONS = Math.max(TRIAL_SESSIONS, Number(process.env.REASON_PAYWALL_MAX_SESSIONS || 30));
export const SESSION_GAP_MS = Number(process.env.REASON_PAYWALL_GAP_MIN || 30) * 60_000;
export const PRICE = "$24.99";
export const PRICE_LINE = `${PRICE} a month`;
/** How long one Checkout Session link is handed out again before a fresh one is made (Stripe's expire at 24h). */
const CHECKOUT_REUSE_MS = 20 * 3_600_000;

db.db.exec(`
  CREATE TABLE IF NOT EXISTS plan (
    conversation_id TEXT PRIMARY KEY,
    sessions_used INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_inbound_at INTEGER,
    -- trial | free | paid | lapsed | cancelled  (free is written by scripts/plan-set.js or on the first
    -- grandfather read; the live answer is always status(), which reads the account too)
    status TEXT NOT NULL DEFAULT 'trial',
    stripe_customer_id TEXT NOT NULL DEFAULT '',
    stripe_subscription_id TEXT NOT NULL DEFAULT '',
    paid_until INTEGER,
    -- the 25th-session bubbles: owed after that session's reply, and when they went
    ask_due INTEGER NOT NULL DEFAULT 0,
    asked_at INTEGER,
    -- the session (sessions_used) in which the trial-over line was last said: once a session
    told_session INTEGER,
    -- when the paywall itself held their standing things (pause.pauseAll); null when it did not,
    -- so a pause THEY asked for before lapsing is never undone by a payment
    held_at INTEGER,
    checkout_url TEXT NOT NULL DEFAULT '',
    checkout_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stripe_events (
    event_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
`);
const q = (sql) => db.db.prepare(sql);

// ---------------------------------------------------------------- the switch

export function mode() {
  const v = String(process.env.REASON_PAYWALL ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}

// The grandfather cut-off (owner, 2026-11-05: "Reason is free for everyone for now"; when the switch
// goes on, only people who join FROM THAT MOMENT get the trial, everyone before stays free for good).
//
//   - ON_KEY in ops_state is the flip moment: written once, the first time this process sees the switch
//     `on` (at boot, below), never moved after. The old key `paywall_ship_ts` (written by the 11-01
//     owner-mode trial) is never read again: it predates the decision.
//   - REASON_PAYWALL_SHIP_TS can only push the cut-off LATER, never earlier: the cut-off is the later of
//     the env and the flip moment. So the Oct 31 value still sitting in live .env (1793500000000) can never
//     put anybody who joined while Reason was free onto a trial. To re-flip after a later off spell and
//     keep everybody who joined during it free, set REASON_PAYWALL_SHIP_TS to the new flip moment.
//   - Owner mode reaches only the operator and skips his grandfather rule, so it records nothing.
const ON_KEY = "paywall_on_since";

function envShipTs() {
  const raw = String(process.env.REASON_PAYWALL_SHIP_TS ?? "").trim();
  if (!raw) return null;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** The flip moment, ms: when the switch was first seen `on`, written then. Null until it has been. */
export function onSince() {
  const stored = Number(db.opsGet(ON_KEY));
  if (stored) return stored;
  if (mode() !== "on") return null;
  const now = clock.now();
  db.opsSet(ON_KEY, now);
  return now;
}

/** The grandfather cut-off, ms: accounts made before it are free for good. Null while the switch is not on. */
export function shipTs() {
  if (mode() !== "on") return null;
  const flip = onSince();
  const env = envShipTs();
  return env && env > flip ? env : flip;
}

// Written at boot when the switch is on, so a newcomer admitted in the very first turn after a flip is
// made AFTER it, and everybody already on the line is before it.
if (mode() === "on") { try { onSince(); } catch { /* read again on first use */ } }

const isOperator = (conversationId, row = db.getAccount(conversationId)) => conversationId === config.ownerConversation || !!row?.is_operator;

/** Does the paywall reach this conversation at all, under the switch as it is? */
export function appliesTo(conversationId) {
  if (!conversationId) return false;
  const m = mode();
  if (m === "off") return false;
  if (m === "owner") return isOperator(conversationId);
  return true;
}

/** Free for good: the operator, a test number, or an account from before the paywall shipped. */
export function grandfathered(conversationId) {
  const row = db.getAccount(conversationId);
  if (mode() === "owner" && isOperator(conversationId, row)) return false; // so he can try it on himself
  if (isOperator(conversationId, row)) return true;
  if (row?.address && config.testNumbers.some(n => String(n).replace(/[^\d+]/g, "") === String(row.address).replace(/[^\d+]/g, ""))) return true;
  const ship = shipTs();
  if (row?.created_at && ship && row.created_at < ship) return true;
  return false;
}

// ---------------------------------------------------------------- the row

export const row = (conversationId) => q("SELECT * FROM plan WHERE conversation_id = ?").get(conversationId) ?? null;

function ensure(conversationId, now = clock.now()) {
  q(`INSERT INTO plan (conversation_id, sessions_used, first_seen_at, status, updated_at) VALUES (?, 0, ?, 'trial', ?)
     ON CONFLICT(conversation_id) DO NOTHING`).run(conversationId, now, now);
  return row(conversationId);
}

const COLUMNS = new Set(["sessions_used", "last_inbound_at", "status", "stripe_customer_id", "stripe_subscription_id", "paid_until", "ask_due", "asked_at", "told_session", "held_at", "checkout_url", "checkout_at"]);
function write(conversationId, fields, now = clock.now()) {
  ensure(conversationId, now);
  const keys = Object.keys(fields).filter(k => COLUMNS.has(k));
  if (!keys.length) return row(conversationId);
  q(`UPDATE plan SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE conversation_id = ?`)
    .run(...keys.map(k => fields[k]), now, conversationId);
  return row(conversationId);
}

/**
 * Where this person stands, live: `{ status, sessions_used, left, paid_until, applies }`.
 * `status` is one of off | free | trial | paid | cancelled | lapsed. "off" means nothing here reaches
 * them (switch off, or not their thread under `owner`); "cancelled" still has access until paid_until.
 */
export function status(conversationId, now = clock.now()) {
  const r = row(conversationId);
  const used = r?.sessions_used ?? 0;
  // Extended: past the 25th on the trial with the ask neither owed nor gone — the win rule is holding it.
  const extended = !!r && r.status === "trial" && used >= TRIAL_SESSIONS && used < TRIAL_MAX_SESSIONS && !r.asked_at && !r.ask_due;
  const base = { sessions_used: used, left: Math.max(0, TRIAL_SESSIONS - used), paid_until: r?.paid_until ?? null, trial_sessions: TRIAL_SESSIONS, extended: false };
  if (!appliesTo(conversationId)) return { status: "off", applies: false, ...base };
  if (grandfathered(conversationId) || r?.status === "free") return { status: "free", applies: true, ...base };
  if (!r) return { status: "trial", applies: true, ...base };
  if (r.status === "paid") return { status: "paid", applies: true, ...base };
  if (r.status === "cancelled") return { status: r.paid_until && r.paid_until > now ? "cancelled" : "lapsed", applies: true, ...base };
  // Lapsed is written by noteTurn (a new session after the ask has gone), never inferred from the
  // count alone: somebody past 25 who was never asked is still on the trial until they have been.
  if (r.status === "lapsed") return { status: "lapsed", applies: true, ...base };
  if (extended) return { status: "trial", applies: true, ...base, left: Math.max(0, TRIAL_MAX_SESSIONS - used), trial_sessions: TRIAL_MAX_SESSIONS, extended: true };
  return { status: "trial", applies: true, ...base };
}

/** Is this person past their trial and unpaid — the state in which acting tools are refused? */
export const blocked = (conversationId, now = clock.now()) => status(conversationId, now).status === "lapsed";

/**
 * One inbound turn (accounts.countUse, kind "turn", a positive count). Starts a session when 30
 * minutes have passed since the last inbound; at the 25th owes the ask; past it, lapses. Counted
 * under every mode — a row nobody reads is not a behaviour — but owed and lapsed only where the
 * paywall reaches. Returns what happened, for the log.
 */
export function noteTurn(conversationId, now = clock.now()) {
  if (!conversationId) return null;
  // Nothing is counted where the paywall does not reach (switch off; everybody but the operator under
  // `owner`): no row, no number, so a flip later starts nobody part-way through a trial.
  if (!appliesTo(conversationId)) return null;
  const r = ensure(conversationId, now);
  const fresh = !r.last_inbound_at || now - r.last_inbound_at >= SESSION_GAP_MS;
  const fields = { last_inbound_at: now };
  let used = r.sessions_used;
  if (fresh) { used += 1; fields.sessions_used = used; }
  const subject = appliesTo(conversationId) && !grandfathered(conversationId) && r.status === "trial";
  // The ask comes before any lapse, always: a session at or past the 25th with the ask never sent owes
  // it (this covers somebody whose sessions were counted while the switch was off), and only a NEW
  // session after the ask has gone lapses them. No ask gone — no link to pay with — no lapse.
  // The win rule: between the 25th and the 30th the ask waits for a win, and is checked on EVERY
  // inbound (not only a new session), so it goes on the first text after the win lands.
  let extended = false;
  if (subject && used >= TRIAL_SESSIONS && !r.asked_at && !r.ask_due) {
    if (used >= TRIAL_MAX_SESSIONS || hasWin(conversationId)) fields.ask_due = 1;
    else extended = true;
  }
  if (fresh && subject && used > TRIAL_SESSIONS && r.asked_at) fields.status = "lapsed";
  write(conversationId, fields, now);
  return { session_started: fresh, sessions_used: used, ask_due: !!fields.ask_due, extended, lapsed: fields.status === "lapsed" };
}

/**
 * Every finished errand on their record, oldest first: stamps.completions (a done task, a call that got
 * somewhere, an AgentCard order) plus the orders placed through a store checkout (shop_runs, the live
 * buy path since 2026-10-30), as `{ kind, id, at }`.
 */
export function wins(conversationId) {
  const out = [];
  try { out.push(...stamps.completions(conversationId)); } catch { /* the rows below still count */ }
  try {
    for (const r of q("SELECT run_id, COALESCE(stage_at, updated_at) AS at FROM shop_runs WHERE conversation_id = ? AND status = 'succeeded' AND stage = 'placed'").all(conversationId)) out.push({ kind: "purchase", id: r.run_id, at: r.at });
  } catch { /* no checkouts on this install */ }
  return out.sort((a, b) => a.at - b.at);
}

/** Has Reason done something real for them yet — at least one win on the record? */
export function hasWin(conversationId) {
  return wins(conversationId).length > 0;
}

// ---------------------------------------------------------------- the link

/** Who a Stripe object is for: a token safe in a Payment Link's client_reference_id (letters, digits, - and _). */
export const refFor = (conversationId) => Buffer.from(String(conversationId), "utf8").toString("base64url");
export function conversationOfRef(ref) {
  try { const s = Buffer.from(String(ref ?? ""), "base64url").toString("utf8"); return /^[\w:+.@-]{1,120}$/.test(s) ? s : null; } catch { return null; }
}

// Where Stripe sends a person afterwards: the website (heyreason.com proxies /pay/* to this server,
// 2026-11-01). A person never lands on the server's own address (owner rule, 2026-11-01).
const base = () => (config.siteUrl || config.publicUrl || "https://heyreason.com").replace(/\/+$/, "");

/**
 * The link that starts paying: STRIPE_PAYMENT_LINK_URL when the owner set one (his own pricing page),
 * else a Checkout Session made for this person and reused for the day. Null when neither can be had
 * — the caller says so instead of handing over a broken link.
 */
export async function payLink(conversationId, { fetchImpl = globalThis.fetch, log = () => {}, now = clock.now() } = {}) {
  const e = stripe.env();
  const ref = refFor(conversationId);
  if (e.paymentLink) return `${e.paymentLink}?client_reference_id=${ref}`;
  const r = row(conversationId);
  if (r?.checkout_url && r.checkout_at && now - r.checkout_at < CHECKOUT_REUSE_MS) return r.checkout_url;
  if (!stripe.configured()) { log({ paywall_no_link: conversationId, why: "no STRIPE_SECRET_KEY / STRIPE_PRICE_ID" }); return null; }
  const out = await stripe.createCheckoutSession({ ref, conversationId, successUrl: `${base()}/pay/done`, cancelUrl: `${base()}/pay/back`, fetchImpl });
  const url = out.ok ? String(out.body?.url ?? "") : "";
  if (!url) { log({ paywall_checkout_failed: conversationId, status: out.status, why: out.body?.error?.message ?? "no url" }); return null; }
  write(conversationId, { checkout_url: url, checkout_at: now }, now);
  return url;
}

// ---------------------------------------------------------------- what Reason did for them

/** Plain human counts of what really got done, from the record. Zeros are left out. */
export async function recapCounts(conversationId) {
  const counts = { calls: 0, orders: 0, tasks: 0, reminders: 0, events: 0 };
  for (const c of wins(conversationId)) {
    if (c.kind === "call") counts.calls++;
    else if (c.kind === "purchase") counts.orders++;
    else if (c.kind === "task") counts.tasks++;
  }
  try { counts.reminders = q("SELECT COUNT(*) AS n FROM timers WHERE conversation_id = ? AND fired_at IS NOT NULL AND call_goal IS NULL AND COALESCE(label, '') = ''").get(conversationId).n; } catch {}
  try { counts.events = q("SELECT COUNT(*) AS n FROM events WHERE organizer_conversation_id = ?").get(conversationId).n; } catch {}
  return counts;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "made 3 calls that got answers, placed an order and fired 12 reminders" — nothing with a zero in it. */
export function recapLine(counts) {
  const bits = [];
  if (counts.calls) bits.push(`made ${plural(counts.calls, "call")} that got ${counts.calls === 1 ? "an answer" : "answers"}`);
  if (counts.orders) bits.push(`placed ${counts.orders === 1 ? "an order" : plural(counts.orders, "order")}`);
  if (counts.tasks) bits.push(`finished ${plural(counts.tasks, "thing")} you asked for`);
  if (counts.reminders) bits.push(`sent ${plural(counts.reminders, "reminder")} on time`);
  if (counts.events) bits.push(`set up ${counts.events === 1 ? "an event" : plural(counts.events, "event")}`);
  if (!bits.length) return "";
  if (bits.length === 1) return bits[0];
  return `${bits.slice(0, -1).join(", ")} and ${bits.at(-1)}`;
}

/**
 * The three bubbles when the ask goes. Warm, short, no "unlock", no "upgrade". `sessions` is how many
 * chats it took (25, or up to 30 under the win rule); with nothing real to point to — the 30th with
 * no win — the first line is softer and owns it.
 */
export function askBubbles({ counts, url, name = "", sessions = TRIAL_SESSIONS }) {
  const did = recapLine(counts);
  const who = name ? `, ${name}` : "";
  const first = did
    ? `that's ${sessions} chats between us${who}. so far i've ${did}.`
    : `that's ${sessions} chats between us${who}. i haven't pulled off something real for you yet, and i'd like the chance to.`;
  const ask = `from here it's ${PRICE_LINE} to keep going. everything stays exactly as it is — what i remember, your reminders, all of it — and you can cancel any time just by telling me.`;
  return url ? [first, ask, url] : [first, ask];
}

// ---------------------------------------------------------------- after a turn

const realSleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.());
const beat = () => config.onboardingGapMs + Math.floor(Math.random() * 600);

/**
 * Right after their turn's reply went (Router.drain): the 25th session's bubbles if they are owed, and
 * the hold if they have lapsed and nothing of theirs is held yet. Both idempotent, both logged, neither
 * ever throws into the turn.
 */
export async function afterTurn({ conversationId, router = null, sleep = realSleep, fetchImpl = globalThis.fetch, log = () => {}, now = clock.now() } = {}) {
  const st = status(conversationId, now);
  const r = row(conversationId);
  if (!r) return { did: "nothing" };
  // No longer lapsed but still held by us — set free or paid by hand (scripts/plan-set.js), or
  // grandfathered after the fact: their things come back on this turn.
  if (st.status !== "lapsed" && r.held_at > 0) { await release(conversationId, { log, now }); return { did: "released" }; }
  if (!st.applies || st.status === "free" || st.status === "off") return { did: "nothing" };
  if (st.status === "lapsed" && !r.held_at) {
    await hold(conversationId, { log, now });
  }
  if (r.ask_due && !r.asked_at) {
    const url = await payLink(conversationId, { fetchImpl, log, now });
    if (!url) return { did: "ask_held", why: "no link" }; // owed still; tried again next turn
    const account = db.getAccount(conversationId);
    const counts = await recapCounts(conversationId);
    const bubbles = askBubbles({ counts, url, name: account?.name ? firstName(account.name) : "", sessions: r.sessions_used }).slice(0, Math.max(3, config.maxBubbles));
    // Claimed before the first send so a second drain in the same moment cannot say it twice.
    if (q("UPDATE plan SET asked_at = ?, ask_due = 0, updated_at = ? WHERE conversation_id = ? AND asked_at IS NULL").run(now, now, conversationId).changes !== 1) return { did: "nothing" };
    const sent = await sayBubbles({ conversationId, router, bubbles, key: `paywall:ask:${conversationId}`, sleep, log });
    log({ paywall_asked: conversationId, sessions: r.sessions_used, bubbles: bubbles.length, sent });
    return { did: "asked", bubbles, sent };
  }
  return { did: "nothing" };
}

const firstName = (name) => String(name ?? "").trim().split(/\s+/)[0] ?? "";

/** Code's bubbles into their thread, a beat apart, and into the model's history so the turn after knows. */
async function sayBubbles({ conversationId, router, bubbles, key, sleep, log }) {
  const account = db.getAccount(conversationId);
  const thread = db.getThread?.(conversationId) ?? null;
  let sent = 0;
  if (router?.send && account?.channel && account.channel !== "console") {
    for (const [i, text] of bubbles.entries()) {
      if (i) await sleep(beat());
      const r = await router.send({
        channel: account.channel, to: account.address, chatId: thread?.chat_id ?? null, text,
        conversationId, toOwner: true, idempotencyKey: `${key}#${i + 1}`,
      }).catch(e => ({ ok: false, error: e?.message }));
      if (r?.ok === false) { log({ paywall_bubble_held: conversationId, n: i + 1, why: r.error ?? "unknown" }); break; }
      sent++;
    }
  } else {
    log({ paywall_not_sent: conversationId, why: router ? "no channel on the account" : "no router" });
  }
  try {
    const messages = db.loadConversation(conversationId);
    messages.push({ role: "assistant", content: bubbles.join("\n\n") });
    db.saveConversation(conversationId, messages);
  } catch {}
  return sent;
}

// ---------------------------------------------------------------- held and resumed

/** Hold their standing things while they are lapsed — only if nothing of theirs is already held by their own choice. */
export async function hold(conversationId, { log = () => {}, now = clock.now() } = {}) {
  const pause = await import("./pause.js");
  let paused = false;
  if (!pause.isPaused(conversationId)) {
    try { paused = !!pause.pauseAll({ conversationId, said: "free trial ended", now }).ok; }
    catch (e) { log({ paywall_hold_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] }); }
  }
  write(conversationId, { held_at: paused ? now : -1 }, now);
  log({ paywall_held: conversationId, paused });
  return paused;
}

/** Everything the paywall held comes back. A pause they asked for themselves is left exactly alone. */
export async function release(conversationId, { log = () => {}, now = clock.now() } = {}) {
  const r = row(conversationId);
  if (!r?.held_at) return false;
  let resumed = false;
  if (r.held_at > 0) {
    const pause = await import("./pause.js");
    if (pause.isPaused(conversationId)) {
      try { resumed = !!pause.resumeAll({ conversationId, now }).ok; }
      catch (e) { log({ paywall_release_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] }); }
    }
  }
  write(conversationId, { held_at: null }, now);
  log({ paywall_released: conversationId, resumed });
  return resumed;
}

// ---------------------------------------------------------------- the tool gate

/**
 * Refuse an acting tool while lapsed. The first refusal in a session carries the one line and the
 * link for the model to say; later ones say only that the part cannot be done, so the line is never
 * repeated. Null when the tool may run.
 */
export async function gate(conversationId, name, { fetchImpl = globalThis.fetch, log = () => {}, now = clock.now() } = {}) {
  if (!blocked(conversationId, now)) return null;
  const r = row(conversationId);
  const told = r && r.told_session === r.sessions_used;
  let url = null;
  if (!told) {
    url = await payLink(conversationId, { fetchImpl, log, now });
    write(conversationId, { told_session: r?.sessions_used ?? 0 }, now);
  }
  log({ paywall_refused: conversationId, tool: name, told_before: !!told });
  return {
    ok: false, blocked: "trial_over", pay_url: url,
    error: told
      ? `Not done: their free trial is over and this part needs the subscription. They were ALREADY told this session — do not repeat the price, the line or the link. Say plainly, in a few words, that you can't do that part right now, and answer anything else in words.`
      : `Not done: their 25 free sessions are used up and this part needs the subscription. Say ONE short warm line — the free chats are used up, it's ${PRICE_LINE} to keep going, cancel any time by text — then ${url ? "the link on its own line as the last thing in the message, untouched: " + url : "say the person running Reason is sorting out the payment link and you'll have it soon"}. Never say "unlock" or "upgrade". Then answer anything else they asked in words. Do not say this again this session.`,
  };
}

/** What the turn is told about where they stand. Empty for everybody the paywall does not reach. */
export function note(conversationId, now = clock.now()) {
  const st = status(conversationId, now);
  if (!st.applies || st.status === "free" || st.status === "off") return "";
  if (st.status === "lapsed") {
    return `PLAN: their ${TRIAL_SESSIONS} free sessions are used up and they have not subscribed (${PRICE_LINE}). Keep talking and answer questions as always.`
      + ` Anything that ACTS — a call, an order, a reminder or series, research, directions, an event, a message to somebody — is refused by the tool itself, and the refusal says exactly what to say (once a session, then only that you can't do that part).`
      + ` Their standing reminders and check-ins are held until they subscribe; say so if they ask, and that everything comes back the moment they do. subscription_show has the facts. Never "unlock" or "upgrade".`;
  }
  if (st.status === "cancelled") {
    return `PLAN: they cancelled; everything keeps working until ${when(st.paid_until, conversationId)}, then holds. subscription_show has the facts; only mention it if they ask.`;
  }
  if (st.status === "trial" && st.extended) {
    return `PLAN: they are past ${TRIAL_SESSIONS} free sessions (${st.sessions_used} so far) and the trial is running on, up to ${TRIAL_MAX_SESSIONS}, because nothing real has been finished for them yet. Nothing has been said to them about paying and nothing should be: do not bring up a plan, a price or a trial unless they ask (then subscription_show has the facts). Do something real for them.`;
  }
  if (st.status === "trial" && st.sessions_used >= TRIAL_SESSIONS) {
    return `PLAN: this is their last free session and they were just told about the ${PRICE_LINE} plan (subscription_show has the facts). Answer questions about it plainly if asked; never push, never "unlock" or "upgrade".`;
  }
  return "";
}

/** A date in their words: "Nov 30". */
export function when(ms, conversationId = null) {
  if (!ms) return "the end of the period";
  let tz = config.installTz;
  try { if (conversationId) { const z = db.getAccount(conversationId)?.time_zone; if (z) tz = z; } } catch {}
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(ms); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
}

// ---------------------------------------------------------------- Stripe telling us

/** The conversation a Stripe object is about: our reference first, then the ids we already hold. */
function conversationFor(obj) {
  const byRef = conversationOfRef(obj?.client_reference_id);
  if (byRef && db.getAccount(byRef)) return byRef;
  const meta = obj?.metadata?.conversation_id;
  if (meta && db.getAccount(meta)) return meta;
  const subId = typeof obj?.subscription === "string" ? obj.subscription : obj?.object === "subscription" ? obj.id : null;
  if (subId) { const r = q("SELECT conversation_id FROM plan WHERE stripe_subscription_id = ?").get(subId); if (r) return r.conversation_id; }
  const cus = typeof obj?.customer === "string" ? obj.customer : null;
  if (cus) { const r = q("SELECT conversation_id FROM plan WHERE stripe_customer_id = ?").get(cus); if (r) return r.conversation_id; }
  return null;
}

const PAID_LINE = "you're all set — thank you. everything's back on, and i'm here whenever you need me.";
const ENDED_LINE = "your plan's ended, so i've paused the things i was doing for you. text me any time to pick it back up.";

/**
 * One verified Stripe event. Idempotent on its id (stripe_events). Returns what it did, for the log.
 * `say(conversationId, text)` is how a line reaches them (runtime.say); never required.
 */
export async function handleStripeEvent(event, { say = null, log = () => {}, now = clock.now() } = {}) {
  const id = String(event?.id ?? "");
  const type = String(event?.type ?? "");
  if (!id || !type) return { ok: false, why: "no id or type" };
  // Switch off: Reason is free for everyone, so nothing Stripe says (an old test subscription renewing,
  // say) marks anybody paid or lapsed, or texts them. Taken (200) so Stripe stops retrying.
  if (mode() === "off") { log({ stripe_webhook: type, ignored: "paywall off" }); return { ok: true, ignored: true }; }
  if (q("INSERT OR IGNORE INTO stripe_events (event_id, type, received_at) VALUES (?, ?, ?)").run(id, type, now).changes !== 1) {
    return { ok: true, duplicate: true };
  }
  try {
    return await actOn(event, { say, log, now });
  } catch (e) {
    // The claim is given back so Stripe's retry is not answered "duplicate" for an event nothing acted on.
    q("DELETE FROM stripe_events WHERE event_id = ?").run(id);
    log({ stripe_webhook_failed: type, why: (e?.message ?? String(e)).split("\n")[0] });
    return { ok: false, why: (e?.message ?? String(e)).split("\n")[0] };
  }
}

async function actOn(event, { say, log, now }) {
  const type = String(event.type);
  const obj = event?.data?.object ?? {};
  const conversationId = conversationFor(obj);
  if (!conversationId) { log({ stripe_webhook: type, unmatched: true }); return { ok: true, matched: false }; }
  const tell = (text) => { if (say) { try { say(conversationId, text); } catch (e) { log({ paywall_text_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] }); } } };

  switch (type) {
    case "checkout.session.completed": {
      const before = row(conversationId)?.status;
      await markPaid(conversationId, {
        customerId: typeof obj.customer === "string" ? obj.customer : "",
        subscriptionId: typeof obj.subscription === "string" ? obj.subscription : "",
        paidUntil: null, log, now,
      });
      if (before !== "paid") tell(PAID_LINE);
      log({ stripe_webhook: type, conversation: conversationId, paid: true });
      return { ok: true, matched: true, conversationId, paid: true };
    }
    case "invoice.paid": {
      const before = row(conversationId)?.status;
      const end = obj?.lines?.data?.[0]?.period?.end ?? obj?.period_end ?? null;
      // Already cancelled at the period's end: the invoice (a retried or late first one) extends the
      // paid-until date and nothing else — the cancellation on record stands.
      if (before === "cancelled") {
        if (end) write(conversationId, { paid_until: Number(end) * 1000 }, now);
        log({ stripe_webhook: type, conversation: conversationId, cancelled_kept: true });
        return { ok: true, matched: true, conversationId };
      }
      await markPaid(conversationId, {
        customerId: typeof obj.customer === "string" ? obj.customer : "",
        subscriptionId: typeof obj.subscription === "string" ? obj.subscription : "",
        paidUntil: end ? Number(end) * 1000 : null, log, now,
      });
      if (before !== "paid" && before !== "cancelled") tell(PAID_LINE);
      log({ stripe_webhook: type, conversation: conversationId, paid: true });
      return { ok: true, matched: true, conversationId, paid: true };
    }
    case "customer.subscription.updated": {
      const end = obj.current_period_end ? Number(obj.current_period_end) * 1000 : null;
      const fields = { stripe_subscription_id: obj.id ?? "", ...(typeof obj.customer === "string" ? { stripe_customer_id: obj.customer } : {}), ...(end ? { paid_until: end } : {}) };
      const dead = ["canceled", "unpaid", "incomplete_expired"].includes(String(obj.status));
      if (dead) {
        write(conversationId, { ...fields, status: "lapsed" }, now);
        await hold(conversationId, { log, now });
      } else if (obj.cancel_at_period_end) {
        write(conversationId, { ...fields, status: "cancelled" }, now);
      } else if (["active", "trialing", "past_due"].includes(String(obj.status))) {
        const before = row(conversationId)?.status;
        await markPaid(conversationId, { customerId: fields.stripe_customer_id ?? "", subscriptionId: obj.id ?? "", paidUntil: end, log, now });
        if (before === "lapsed" || before === "trial") tell(PAID_LINE);
      } else write(conversationId, fields, now);
      log({ stripe_webhook: type, conversation: conversationId, status: obj.status, cancel_at_period_end: !!obj.cancel_at_period_end });
      return { ok: true, matched: true, conversationId };
    }
    case "customer.subscription.deleted": {
      const before = row(conversationId)?.status;
      write(conversationId, { status: "lapsed", paid_until: obj.current_period_end ? Number(obj.current_period_end) * 1000 : row(conversationId)?.paid_until ?? null }, now);
      await hold(conversationId, { log, now });
      if (before === "paid" || before === "cancelled") tell(ENDED_LINE);
      log({ stripe_webhook: type, conversation: conversationId, lapsed: true });
      return { ok: true, matched: true, conversationId, lapsed: true };
    }
    default:
      log({ stripe_webhook: type, ignored: true });
      return { ok: true, matched: true, conversationId, ignored: true };
  }
}

/** Paid: the row, the ids, and whatever the paywall held comes back. */
export async function markPaid(conversationId, { customerId = "", subscriptionId = "", paidUntil = null, log = () => {}, now = clock.now() } = {}) {
  const r = ensure(conversationId, now);
  write(conversationId, {
    status: "paid",
    ...(customerId ? { stripe_customer_id: customerId } : {}),
    ...(subscriptionId ? { stripe_subscription_id: subscriptionId } : {}),
    ...(paidUntil ? { paid_until: paidUntil } : {}),
    told_session: null,
  }, now);
  await release(conversationId, { log, now });
  return row(conversationId) ?? r;
}

// ---------------------------------------------------------------- the tools' views

/** What subscription_show says: status, sessions, the next bill or the end date. */
export function view(conversationId, now = clock.now()) {
  const st = status(conversationId, now);
  const r = row(conversationId);
  const out = { status: st.status, sessions_used: st.sessions_used, trial_sessions: st.trial_sessions, price: PRICE_LINE };
  if (st.status === "trial") { out.sessions_left = st.left; if (st.extended) out.extended = true; }
  if (st.status === "paid") { out.next_bill = st.paid_until ? when(st.paid_until, conversationId) : "unknown yet"; out.next_bill_at = st.paid_until; }
  if (st.status === "cancelled") { out.access_until = when(st.paid_until, conversationId); out.access_until_at = st.paid_until; }
  out.has_subscription = !!r?.stripe_subscription_id;
  return out;
}

/** Cancel at the period's end through Stripe, and say when access stops. */
export async function cancel(conversationId, { fetchImpl = globalThis.fetch, log = () => {}, now = clock.now() } = {}) {
  const st = status(conversationId, now);
  const r = row(conversationId);
  if (st.status === "free") return { ok: false, error: "Reason is free for them, for good — there is no subscription to cancel. Say that, warmly." };
  if (st.status === "trial") return { ok: false, error: `They are on the free trial (${st.sessions_used} of ${st.trial_sessions} sessions used) and have never subscribed, so there is nothing to cancel and nothing will be charged. Say that.` };
  if (st.status === "cancelled") return { ok: true, already: true, access_until: when(st.paid_until, conversationId), note: "Already cancelled. Nothing more will be charged; everything keeps working until access_until. Say that in one line." };
  if (!r?.stripe_subscription_id) return { ok: false, error: "No subscription id is on record here, so it cannot be cancelled from this side. Say the person running Reason will sort it, and that nothing further is charged until it is." };
  const out = await stripe.cancelAtPeriodEnd(r.stripe_subscription_id, { fetchImpl });
  if (!out.ok) {
    log({ paywall_cancel_failed: conversationId, status: out.status, why: out.body?.error?.message ?? "unknown" });
    return { ok: false, error: `Stripe would not take the cancellation just now (${out.body?.error?.message ?? `HTTP ${out.status}`}). Say it didn't go through and you'll try again; do not say it is cancelled.` };
  }
  const end = out.body?.current_period_end ? Number(out.body.current_period_end) * 1000 : (r.paid_until ?? null);
  write(conversationId, { status: "cancelled", paid_until: end }, now);
  log({ paywall_cancelled: conversationId, access_until: end });
  return { ok: true, access_until: when(end, conversationId), access_until_at: end, note: `Cancelled at the end of the paid period. Confirm in ONE line: nothing more is charged, and everything keeps working until ${when(end, conversationId)}. No guilt, no offer to stay.` };
}

/** The /ops label for one person: "trial 3/25", "trial 27/30 (no win yet)", "free", "paid", "lapsed", "cancelled · until Nov 30". Null when the switch is off. */
export function opsLabel(conversationId, now = clock.now()) {
  if (mode() === "off") return null;
  const st = status(conversationId, now);
  if (st.status === "off") return null;
  if (st.status === "trial") return st.extended ? `trial ${st.sessions_used}/${TRIAL_MAX_SESSIONS} (no win yet)` : `trial ${st.sessions_used}/${TRIAL_SESSIONS}`;
  if (st.status === "cancelled") return `cancelled · until ${when(st.paid_until, conversationId)}`;
  return st.status;
}

/**
 * scripts/plan-set.js: set one person's plan by hand. `lastInboundAt`: a time (ms) to pretend their
 * last text came, or null to forget it (so their very next text starts a new session); undefined
 * leaves it alone.
 */
export function setManually(conversationId, { status: s, sessions = null, paidUntil = null, lastInboundAt = undefined, now = clock.now() } = {}) {
  const allowed = new Set(["trial", "free", "paid", "lapsed", "cancelled"]);
  if (!allowed.has(s)) throw new Error(`status must be one of ${[...allowed].join(", ")}`);
  const fields = { status: s };
  if (sessions != null) fields.sessions_used = Number(sessions);
  if (paidUntil != null) fields.paid_until = paidUntil;
  if (lastInboundAt !== undefined) fields.last_inbound_at = lastInboundAt;
  if (s === "trial" || s === "free" || s === "paid") { fields.ask_due = 0; fields.told_session = null; }
  // Set back onto the trial under the 30th: the ask is owed again, so the rule can be watched once more.
  if (s === "trial" && sessions != null && Number(sessions) < TRIAL_MAX_SESSIONS) fields.asked_at = null;
  return write(conversationId, fields, now);
}
