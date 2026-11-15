// Their bank, read-only, through Plaid (owner brief 2026-11-12). REASON_PLAID = off | owner | on.
//
// What this is: a person connects a bank with Plaid's Hosted Link (there is no app, so the link is
// texted), and Reason can then answer about THEIR money by text: what they spent, on what, which
// charges repeat, what is in the account. It reads. Nothing here can move money: the only Plaid
// products asked for are Transactions and Balance, and no endpoint that pays, transfers or returns
// an account or routing number is called anywhere in this file.
//
// Plaid's docs as read 2026-11-12 (plaid.com/docs, SDK `plaid` v51):
//   - /link/token/create with a `hosted_link` object returns `hosted_link_url`, good for 30 minutes
//     when Plaid is not the one delivering it. `completion_redirect_uri` is opened whether they
//     finished or backed out, so the page it points at never assumes success.
//   - The public token arrives on the LINK / SESSION_FINISHED webhook; /link/token/get has the same
//     for six hours, which is the fallback when the webhook is late or lost.
//   - /transactions/sync with a cursor per Item; a TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION
//     error means start that sync again from the cursor it began with.
//   - /accounts/balance/get is the real-time balance (the cached one on /accounts/get is not used
//     for a balance check). p50 ~3s, p95 ~11s, and billed per call in production.
//   - /transactions/recurring/get is an add-on that needs a product access request; without it the
//     subscriptions list is worked out here from the synced transactions.
//   - Webhooks are signed: the Plaid-Verification header is an ES256 JWT whose key comes from
//     /webhook_verification_key/get, with `iat` no older than five minutes and the SHA-256 of the
//     raw body inside it.
//   - Update mode: a link token made with the Item's access_token and no products.
//
// Plaid's real Sandbox, run through this file 2026-11-13 (scripts/plaid-sandbox-proof.mjs; the
// recorded shapes are test/fixtures/plaid/). What it showed that the docs alone did not:
//   - The first /transactions/sync after a connection ALWAYS answers with nothing: NOT_READY, no
//     transactions, an empty cursor. They arrive 3 to 8 seconds later, the whole first month re-sent
//     as `modified` when the history lands, and in two runs of four HISTORICAL_UPDATE_COMPLETE was
//     reported, still with an empty cursor, before any had arrived. So a read never trusts what is
//     stored to be current, nor that status alone: it syncs first (freshen).
//   - A webhook answered 401 or 404 is never retried (Plaid's webhook docs), so a late, lost or
//     refused webhook must not be the only way transactions get here. It is not: see freshen.
//   - Loan accounts carry their own lines ("Interest charged", "Monthly payment"): interest accruing
//     on a loan is not money the person spent, and it was nearly half of one week's "spending".
//   - When Plaid has no merchant name the bank's own line is all there is, and it carries long runs
//     of digits (references, card fragments): those are taken out before a name is kept (txName).
//   - /transactions/recurring/get answers in Sandbox without any request for access (200, streams),
//     and PRODUCT_NOT_READY when asked in the first seconds after a connection.
//   - A token whose Item was removed fails ITEM_NOT_FOUND. /link/token/get on a link nobody has
//     opened has no `link_sessions` at all.
//
// Privacy rules this file keeps (each has a test in test/plaid.test.js):
//   - the access token is sealed with REASON_TOKEN_KEY before it touches the table (and again under
//     the person's own key with REASON_ENCRYPT_REST2=on), is never returned to the model, never
//     logged and never exported;
//   - what is kept of an account is its name, its type and the LAST FOUR digits Plaid calls `mask`;
//     full account and routing numbers are never requested (no Auth product), so they cannot leak;
//   - every read is `conversation_id = ?`; a webhook finds its person by the Item id Plaid sent and
//     everything after that is scoped by the conversation that row names;
//   - nothing here renders on a page: the one page (/bank/done) says connected or not, no numbers.
import { createHash, createPublicKey, verify as cryptoVerify, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import * as secretbox from "./secretbox.js";
import { sealCell } from "./restcrypt.js";
import { config, clock, callbackUrl } from "./config.js";
import { zoneFor } from "./zone.js";
import { revokeAll as revokeCheckinGrants } from "./bankgrant.js";
import * as digest from "./opsdigest.js";

// ---------------------------------------------------------------- the switch
/** off | owner | on. Read on every call, so a restart is the only switch. */
export function plaidMode() {
  const v = String(process.env.REASON_PLAID ?? "off").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}
export function plaidOnFor({ isOperator = false, onCall = false } = {}) {
  if (onCall) return false;
  const m = plaidMode();
  return m === "on" || (m === "owner" && !!isOperator);
}
export function plaidOn(conversationId) {
  if (!conversationId) return false;
  const m = plaidMode();
  if (m === "owner") { try { return !!accounts.ownerOf(conversationId).isOperator; } catch { return false; } }
  if (m !== "on") return false;
  // On: a person Reason has let in (an active account, src/accounts.js admit), or the owner's own thread.
  try {
    if (accounts.ownerOf(conversationId).isOperator) return true;
    const row = db.getAccount(conversationId);
    return !!row && (row.state ?? "active") === "active";
  } catch { return false; }
}
/** sandbox unless PLAID_ENV says production. Anything else reads as sandbox: a typo never reaches real banks. */
export const plaidEnv = () => (String(process.env.PLAID_ENV ?? "sandbox").trim().toLowerCase() === "production" ? "production" : "sandbox");
/** PLAID_SECRET, or the one named for the environment (PLAID_SECRET_SANDBOX / PLAID_SECRET_PRODUCTION). */
const secret = () => String(process.env.PLAID_SECRET || (plaidEnv() === "sandbox" ? process.env.PLAID_SECRET_SANDBOX : process.env.PLAID_SECRET_PRODUCTION) || "").trim();
export const configured = () => !!(String(process.env.PLAID_CLIENT_ID ?? "").trim() && secret());

// ---------------------------------------------------------------- tables
db.db.exec(`
  -- One connected bank (Plaid calls it an Item). access_token is the credential: sealed, never exported.
  CREATE TABLE IF NOT EXISTS plaid_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    item_id TEXT NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    institution TEXT NOT NULL DEFAULT '',
    cursor TEXT NOT NULL DEFAULT '',
    -- Plaid's transactions_update_status at the last sync: '' | NOT_READY | INITIAL_UPDATE_COMPLETE | HISTORICAL_UPDATE_COMPLETE
    history TEXT NOT NULL DEFAULT '',
    -- ok | login_required | removing (they disconnected and Plaid has not confirmed the removal yet)
    status TEXT NOT NULL DEFAULT 'ok',
    connected_at INTEGER NOT NULL,
    synced_at INTEGER,
    relink_sent_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS plaid_items_conv ON plaid_items (conversation_id);
  -- An account at that bank: its name, its kind and the last four digits. Never the full number.
  CREATE TABLE IF NOT EXISTS plaid_accounts (
    conversation_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    mask TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT '',
    subtype TEXT NOT NULL DEFAULT '',
    UNIQUE (conversation_id, account_id)
  );
  -- A synced transaction. The day and the ids are plain so a range can be read; what it was and how
  -- much (data, JSON) is sealed under the person's key when REASON_ENCRYPT_REST2 is on.
  CREATE TABLE IF NOT EXISTS plaid_transactions (
    conversation_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    date TEXT NOT NULL,
    pending INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    UNIQUE (conversation_id, transaction_id)
  );
  CREATE INDEX IF NOT EXISTS plaid_tx_conv_date ON plaid_transactions (conversation_id, date);
  -- One Hosted Link that was texted. id is the random value in the page's address; link_token is
  -- what Plaid's webhook names. Short-lived, single-use.
  CREATE TABLE IF NOT EXISTS plaid_links (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    link_token TEXT NOT NULL,
    token_hash TEXT NOT NULL DEFAULT '',
    item_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    finished_at INTEGER,
    outcome TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS plaid_links_hash ON plaid_links (token_hash);
  -- When a bank read was answered, so the reply that carried the numbers is kept out of the memory
  -- extractor and the nightly review (their own words are still read). Times only.
  CREATE TABLE IF NOT EXISTS plaid_reads (
    conversation_id TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS plaid_reads_conv ON plaid_reads (conversation_id, at);
  -- Every bank (Item) ever made through Reason, kept after a disconnect: Plaid's Trial counts Items
  -- ever created and /item/remove does not give one back. who is the hash Plaid knows them by
  -- (clientUserId), emptied when they delete their data; the row stays so the count stays true.
  CREATE TABLE IF NOT EXISTS plaid_slots (
    item_hash TEXT PRIMARY KEY,
    who TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  -- Asked to connect while connections were full: told once when there is room.
  CREATE TABLE IF NOT EXISTS plaid_waits (
    conversation_id TEXT PRIMARY KEY,
    asked_at INTEGER NOT NULL,
    told_at INTEGER
  );
  -- "that looks short" said before a pay step: which payment, and how many texts they had sent by then.
  CREATE TABLE IF NOT EXISTS plaid_pay_checks (
    conversation_id TEXT NOT NULL,
    payment_id INTEGER NOT NULL,
    warned_at INTEGER NOT NULL,
    owner_msgs INTEGER NOT NULL DEFAULT 0,
    UNIQUE (conversation_id, payment_id)
  );
`);
// A table made before `history` was kept gains the column.
if (!db.db.prepare("PRAGMA table_info(plaid_items)").all().some(col => col.name === "history")) db.db.exec("ALTER TABLE plaid_items ADD COLUMN history TEXT NOT NULL DEFAULT ''");
const q = (sql) => db.db.prepare(sql);
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
// Banks connected before the count was kept are counted too.
for (const r of q("SELECT conversation_id, item_id, connected_at FROM plaid_items").all()) {
  q("INSERT OR IGNORE INTO plaid_slots (item_hash, who, created_at) VALUES (?, ?, ?)").run(sha("plaid-item:" + r.item_id), `r_${sha("plaid-user:" + r.conversation_id).slice(0, 32)}`, r.connected_at);
}
const sealTok = (c, t) => sealCell("plaid_items", "access_token", c, secretbox.seal(t));
const openTok = (v) => secretbox.open(v);
const last4 = (mask) => String(mask ?? "").replace(/\D/g, "").slice(-4);

// ---------------------------------------------------------------- the client
let fetchImpl = null;
let cached = null;
/** Tests: every Plaid request goes to this fetch, through the real SDK. */
export function _setFetch(fn) { fetchImpl = fn; cached = null; keyCache.clear(); }
async function client() {
  if (!configured()) throw Object.assign(new Error("Plaid keys are not set (PLAID_CLIENT_ID, PLAID_SECRET or PLAID_SECRET_SANDBOX)."), { code: "not_configured" });
  const sig = `${plaidEnv()}:${sha(process.env.PLAID_CLIENT_ID + ":" + secret()).slice(0, 12)}`;
  if (cached?.sig === sig) return cached.client;
  const { PlaidClient, PlaidEnvironment } = await import("plaid");
  const c = new PlaidClient({
    environment: plaidEnv() === "production" ? PlaidEnvironment.Production : PlaidEnvironment.Sandbox,
    clientId: process.env.PLAID_CLIENT_ID.trim(), secret: secret(),
    timeoutInSeconds: 30, maxRetries: 1,
    // The SDK's own logger is off: a request body carries the secret and the access token.
    logging: { silent: true },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  cached = { sig, client: c };
  return c;
}
/** Plaid's error code from whatever the SDK threw, and nothing else of it (the body can name the token). */
export function errorCode(e) {
  const b = e?.body && typeof e.body === "object" ? e.body : null;
  return String(b?.error_code ?? e?.code ?? "").slice(0, 80) || (e?.name === "PlaidTimeoutError" ? "TIMEOUT" : "UNKNOWN");
}
const NEEDS_LOGIN = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT"]);

// ---------------------------------------------------------------- rows
const viewItem = (r) => (r ? { id: r.id, conversationId: r.conversation_id, itemId: r.item_id, institution: r.institution || "your bank", status: r.status, connectedAt: r.connected_at, syncedAt: r.synced_at, cursor: r.cursor, history: r.history ?? "", relinkSentAt: r.relink_sent_at } : null);
/** Their banks. `removing` rows are ones they already disconnected: never shown, never read. */
export const itemsOf = (c) => q("SELECT * FROM plaid_items WHERE conversation_id = ? AND status != 'removing' ORDER BY id").all(c).map(viewItem);
const itemOf = (c, itemId) => viewItem(q("SELECT * FROM plaid_items WHERE conversation_id = ? AND item_id = ?").get(c, itemId));
const tokenOf = (c, itemId) => { const r = q("SELECT access_token FROM plaid_items WHERE conversation_id = ? AND item_id = ?").get(c, itemId); return r ? openTok(r.access_token) : ""; };
export const accountsOf = (c, itemId = null) => (itemId
  ? q("SELECT * FROM plaid_accounts WHERE conversation_id = ? AND item_id = ? ORDER BY rowid").all(c, itemId)
  : q("SELECT * FROM plaid_accounts WHERE conversation_id = ? ORDER BY rowid").all(c));
export const hasBank = (c) => itemsOf(c).length > 0;
/** An account's own name, with any long run of digits a bank put in it taken out (the last four are shown beside it). */
const safeName = (s) => String(s ?? "").replace(/[x*•.#-]*\d{5,}/gi, "").replace(/\s+/g, " ").trim().slice(0, 40);
/** "Chase Total Checking ••1234": bank, account name, last four. The only way an account is ever named. */
export const accountLabel = (a, institution = "") => [institution, safeName(a.name) || a.subtype || a.type, a.mask ? `••${last4(a.mask)}` : ""].filter(Boolean).join(" ");
/** Every account of theirs, across every connected bank: its label and its kind. */
function accountMap(c) {
  const inst = new Map(itemsOf(c).map(i => [i.itemId, i.institution]));
  return new Map(accountsOf(c).map(a => [a.account_id, { label: accountLabel(a, inst.get(a.item_id) ?? ""), type: a.type }]));
}

function saveAccounts(c, itemId, list = []) {
  for (const a of list) {
    if (!a?.account_id) continue;
    q(`INSERT INTO plaid_accounts (conversation_id, item_id, account_id, name, mask, type, subtype) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, account_id) DO UPDATE SET name = excluded.name, mask = excluded.mask, type = excluded.type, subtype = excluded.subtype, item_id = excluded.item_id`)
      .run(c, itemId, a.account_id, sealCell("plaid_accounts", "name", c, safeName(a.name)), sealCell("plaid_accounts", "mask", c, last4(a.mask)), String(a.type ?? ""), String(a.subtype ?? ""));
  }
}

// ---------------------------------------------------------------- connecting: Hosted Link
export const LINK_TTL_S = 30 * 60;
/** What Plaid knows this person as: a hash, never their number. */
export const clientUserId = (c) => `r_${sha("plaid-user:" + c).slice(0, 32)}`;
export const webhookUrl = () => (config.publicUrl ? `${config.publicUrl}/plaid/webhook` : "");

// ---------------------------------------------------------------- the cap: Plaid's Trial plan
// Plaid's Trial is 10 Production Items EVER: "Removing Items created on a Trial plan (using
// /item/remove) will not allow you to create more Items" (plaid.com/docs/account/billing, read
// 2026-11-13). So a new connection is checked BEFORE its link is made, against every bank ever
// connected (plaid_slots) plus links other people have open right now. There is no per-person limit
// (owner, 2026-11-15: "don't put any cap on any bank limit for anybody"): anybody may connect as many
// banks as the plan has room for. Signing in again to a bank already connected (update mode) makes no
// new Item and is never checked.
/** Banks ever connected through Reason, removed or not. */
export const slotsUsed = () => Math.max(Number(q("SELECT COUNT(*) AS n FROM plaid_slots").get().n), Number(q("SELECT COUNT(*) AS n FROM plaid_items").get().n));
const slotsOf = (c) => Number(q("SELECT COUNT(*) AS n FROM plaid_slots WHERE who = ?").get(clientUserId(c)).n);
/** New-bank links still open (not finished, not expired), other than this person's: each may become an Item. */
const openLinks = (exceptC = "") => Number(q("SELECT COUNT(*) AS n FROM plaid_links WHERE item_id = '' AND finished_at IS NULL AND expires_at > ? AND conversation_id != ?").get(clock.now(), exceptC).n);
/** Said when the plan's total is used up: a limit on all of Reason, not on this person. */
export const FULL_WORDS = "i can't connect a new bank right now: reason has used every bank connection its current plan allows. that's a limit for everyone, not just you. i'll text you as soon as there's room";
/** The owner's line in the daily digest (src/opsdigest.js) when somebody was turned away: numbers only. */
export const FULL_OWNER_LINE = (used, cap) => `Plaid: somebody asked to connect a bank and was told connections are full (${used} of ${cap} bank connections on the plan used). They are texted once there is room: raise REASON_PLAID_PLAN_ITEMS after raising the Plaid plan.`;
/** May `c` connect one more bank now? A fresh link of theirs replaces their own open one, so that is not counted. */
export function connectRoom(c) {
  const cap = config.plaidPlanItems, used = slotsUsed();
  if (used + openLinks(c) + 1 > cap) return { ok: false, why: "full", used, cap };
  return { ok: true, used, cap };
}
const wait = (c) => q("INSERT INTO plaid_waits (conversation_id, asked_at) VALUES (?, ?) ON CONFLICT (conversation_id) DO UPDATE SET asked_at = excluded.asked_at, told_at = NULL").run(c, clock.now());
/**
 * The hourly sweep (src/serve.js): somebody who was told connections were full is told once when one
 * of theirs fits, as many as there is room for, longest waiting first.
 */
export function tellWaiting() {
  if (!sayFn) return 0;
  let room = config.plaidPlanItems - slotsUsed() - openLinks(), n = 0;
  for (const r of q("SELECT conversation_id FROM plaid_waits WHERE told_at IS NULL ORDER BY asked_at").all()) {
    if (room <= 0) break;
    if (!plaidOn(r.conversation_id) || !connectRoom(r.conversation_id).ok) continue;
    q("UPDATE plaid_waits SET told_at = ? WHERE conversation_id = ?").run(clock.now(), r.conversation_id);
    say(r.conversation_id, "there's room now to connect your bank. want me to send the link?");
    room--; n++;
  }
  return n;
}
/** Said before the first link a person is ever sent: what Reason sees, keeps, and how to undo it. */
export const CONSENT_WORDS = `before you tap: this connects your bank through Plaid, read-only. i can see your balances, transactions and account names (last 4 digits only), and i can't move money. i keep the last 60 days of transactions. you can tell me to disconnect your bank anytime, and i remove it at Plaid and delete what i had.`;
const firstTime = (c) => slotsOf(c) === 0 && !q("SELECT 1 FROM plaid_items WHERE conversation_id = ?").get(c);

/**
 * Make a Hosted Link, now, for sending now (it lasts 30 minutes). With `itemId` it is update mode:
 * the same bank signed in again, no products named (Plaid's update-mode rule).
 */
export async function createLink(c, { itemId = "" } = {}) {
  if (!itemId) {
    const room = connectRoom(c);
    if (!room.ok) {
      wait(c); logFn({ plaid_connect_refused: room.why, used: room.used, cap: room.cap });
      // The owner hears it in the next daily digest, one line however many asked (keyed); the plan
      // meter's 50/80/100% texts (src/planmeter.js) still come live as the count climbs.
      try { digest.hold({ key: "plaid:connections_full", text: FULL_OWNER_LINE(room.used, room.cap) }); } catch (e) { logFn({ plaid_full_notice_failed: String(e?.message ?? e).split("\n")[0].slice(0, 120) }); }
      return { ok: false, error: "connections_full" };
    }
  }
  const api = await client();
  const state = randomBytes(18).toString("base64url");
  const update = itemId ? tokenOf(c, itemId) : "";
  if (itemId && !update) return { ok: false, error: "no_such_bank" };
  const hook = webhookUrl();
  const req = {
    client_name: "Reason", language: "en", country_codes: ["US"],
    user: { client_user_id: clientUserId(c) },
    // 180 days is what Plaid's recurring detection wants to work from (its docs); it is Plaid's own
    // history. Reason stores the last 60 days of it and nothing older (cutoffDay).
    ...(update ? { access_token: update } : { products: ["transactions"], transactions: { days_requested: 180 } }),
    ...(hook ? { webhook: hook } : {}),
    hosted_link: { completion_redirect_uri: callbackUrl(`/bank/done?s=${state}`), url_lifetime_seconds: LINK_TTL_S, is_mobile_app: false },
  };
  let out;
  try { out = await api.link.createToken(req); } catch (e) { return { ok: false, error: errorCode(e) }; }
  if (!out?.hosted_link_url || !out?.link_token) return { ok: false, error: "no_hosted_link" };
  const now = clock.now();
  q("INSERT INTO plaid_links (id, conversation_id, link_token, token_hash, item_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(state, c, sealCell("plaid_links", "link_token", c, secretbox.seal(out.link_token)), sha(out.link_token), itemId, now, now + LINK_TTL_S * 1000);
  return { ok: true, url: out.hosted_link_url, state, minutes: LINK_TTL_S / 60, update: !!itemId };
}

let sayFn = null;
let logFn = () => {};
/** src/runtime.js hands over how to text somebody; a webhook and the done page both use it. */
export function attach({ say = null, log = null } = {}) { if (say) sayFn = say; if (log) logFn = log; }
const say = (c, text) => { try { sayFn?.(c, text); } catch (e) { logFn({ plaid_text_failed: true, why: String(e?.message ?? e).split("\n")[0].slice(0, 120) }); } };

const finishing = new Map(); // link id -> promise: the webhook and the page arriving together do the work once
/**
 * A Hosted Link session ended. Called by the SESSION_FINISHED webhook (with the public tokens) and
 * by the done page (without, so they are read from /link/token/get). Exchanges, saves, syncs, texts.
 * The link row is found by its own id or by Plaid's link token; the conversation is the row's.
 */
export function finishLink({ state = "", linkToken = "", publicTokens = null } = {}) {
  // The link token or the page's state IS the identity here; everything after is scoped by row.conversation_id.
  const row = state
    ? q("SELECT id, conversation_id, link_token, item_id, expires_at, finished_at, outcome FROM plaid_links WHERE id = ?").get(state)
    : q("SELECT id, conversation_id, link_token, item_id, expires_at, finished_at, outcome FROM plaid_links WHERE token_hash = ?").get(sha(linkToken));
  if (!row) return Promise.resolve({ ok: false, error: "unknown_link" });
  if (row.finished_at) return Promise.resolve({ ok: row.outcome === "connected" || row.outcome === "reconnected", outcome: row.outcome, already: true });
  if (finishing.has(row.id)) return finishing.get(row.id);
  const p = finishOnce(row, publicTokens).finally(() => finishing.delete(row.id));
  finishing.set(row.id, p);
  return p;
}
async function finishOnce(row, publicTokens) {
  const c = row.conversation_id;
  const done = (outcome) => q("UPDATE plaid_links SET finished_at = ?, outcome = ? WHERE id = ? AND conversation_id = ? AND finished_at IS NULL").run(clock.now(), outcome, row.id, c).changes === 1;
  const api = await client();
  let tokens = Array.isArray(publicTokens) ? publicTokens.filter(Boolean) : [];
  // succeeded: Plaid says the session ended well (the webhook's status, or on_success / a result in /link/token/get).
  let exited = false, succeeded = Array.isArray(publicTokens);
  if (!tokens.length) {
    try {
      const got = await api.link.getToken({ link_token: openTok(row.link_token) });
      for (const s of got?.link_sessions ?? []) {
        for (const r of s?.results?.item_add_results ?? []) if (r?.public_token) tokens.push(r.public_token);
        if (!tokens.length && s?.on_success?.public_token) tokens.push(s.on_success.public_token);
        if (s?.on_success || s?.results?.item_add_results?.length) succeeded = true;
        if (s?.finished_at || s?.exit || s?.on_exit) exited = true;
      }
    } catch (e) { return { ok: false, error: errorCode(e), pending: true }; }
  }
  // Update mode hands back no new token: the same Item works again once they have signed in.
  if (row.item_id) {
    // Backed out of signing in again (Plaid opens the page then too): the bank still needs them, the link still works.
    if (!succeeded) { if (clock.now() > row.expires_at) done("expired"); return { ok: false, pending: clock.now() <= row.expires_at, outcome: exited ? "exited" : "open" }; }
    if (!done("reconnected")) return { ok: true, outcome: "reconnected", already: true };
    const sentAt = itemOf(c, row.item_id)?.relinkSentAt ?? clock.now();
    q("UPDATE plaid_items SET status = 'ok' WHERE conversation_id = ? AND item_id = ?").run(c, row.item_id);
    // The proof is a call that works. If the bank still refuses, sync marks it again (no second text
    // inside a day) and nothing here says "reconnected".
    let synced = { ok: false };
    try { synced = await sync(c, row.item_id); } catch { /* the next webhook syncs */ }
    if (synced.error === "login_required") { q("UPDATE plaid_links SET outcome = 'failed' WHERE id = ? AND conversation_id = ?").run(row.id, c); return { ok: false, outcome: "failed" }; }
    q("UPDATE plaid_items SET relink_sent_at = NULL WHERE conversation_id = ? AND item_id = ? AND relink_sent_at = ?").run(c, row.item_id, sentAt);
    say(c, `${itemOf(c, row.item_id)?.institution ?? "your bank"} is reconnected, you're all set`);
    return { ok: true, outcome: "reconnected" };
  }
  if (!tokens.length) {
    // They backed out, or have not finished: the link stays usable until it expires.
    if (clock.now() > row.expires_at) done("expired");
    return { ok: false, pending: clock.now() <= row.expires_at, outcome: exited ? "exited" : "open" };
  }
  if (!done("connected")) return { ok: true, outcome: "connected", already: true };
  const names = [];
  for (const pt of tokens) {
    let ex;
    try { ex = await api.item.exchangePublicToken({ public_token: pt }); } catch (e) { logFn({ plaid_exchange_failed: errorCode(e) }); continue; }
    if (!ex?.access_token || !ex?.item_id) continue;
    let institution = "", accts = [];
    try {
      const got = await api.accounts.get({ access_token: ex.access_token });
      accts = got?.accounts ?? [];
      institution = String(got?.item?.institution_name ?? "");
    } catch (e) { logFn({ plaid_accounts_failed: errorCode(e) }); }
    q(`INSERT INTO plaid_items (conversation_id, item_id, access_token, institution, connected_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (item_id) DO UPDATE SET access_token = excluded.access_token, status = 'ok'`)
      .run(c, ex.item_id, sealTok(c, ex.access_token), sealCell("plaid_items", "institution", c, institution), clock.now());
    // Counted for good: Plaid's Trial counts this Item even after it is removed.
    q("INSERT OR IGNORE INTO plaid_slots (item_hash, who, created_at) VALUES (?, ?, ?)").run(sha("plaid-item:" + ex.item_id), clientUserId(c), clock.now());
    q("DELETE FROM plaid_waits WHERE conversation_id = ?").run(c);
    saveAccounts(c, ex.item_id, accts);
    names.push(institution || "your bank");
    // The first sync. Plaid may still be pulling history; SYNC_UPDATES_AVAILABLE brings the rest.
    try { await sync(c, ex.item_id); } catch (e) { logFn({ plaid_first_sync_failed: errorCode(e) }); }
  }
  if (!names.length) {
    q("UPDATE plaid_links SET outcome = 'failed' WHERE id = ? AND conversation_id = ?").run(row.id, c);
    say(c, "that bank connection didn't go through on my end. want me to send a fresh link?");
    return { ok: false, outcome: "failed" };
  }
  say(c, `${names.join(" and ")} is connected. i can see balances and transactions, nothing else, and i can't move money. ask me what you spent this week, what your subscriptions are, anything like that`);
  return { ok: true, outcome: "connected", banks: names };
}
/** What the done page may know about a link: how it ended, and nothing about the person or the bank. */
export function linkOutcome(state) {
  const r = q("SELECT finished_at, outcome, expires_at FROM plaid_links WHERE id = ?").get(String(state ?? ""));
  if (!r) return "unknown";
  if (r.finished_at) return r.outcome;
  return clock.now() > r.expires_at ? "expired" : "open";
}

/**
 * The bank wants them to sign in again. Text a fresh update-mode link, once a day at most per bank.
 * Returns what was done; never throws.
 */
export async function askReconnect(c, itemId, { force = false } = {}) {
  const it = itemOf(c, itemId);
  if (!it || it.status === "removing") return { ok: false, error: "no_such_bank" };
  q("UPDATE plaid_items SET status = 'login_required' WHERE conversation_id = ? AND item_id = ?").run(c, itemId);
  const now = clock.now();
  if (!force && it.relinkSentAt && now - it.relinkSentAt < 24 * 3600_000) return { ok: true, already_sent: true };
  let link;
  try { link = await createLink(c, { itemId }); } catch (e) { link = { ok: false, error: errorCode(e) }; }
  if (!link.ok) return link;
  q("UPDATE plaid_items SET relink_sent_at = ? WHERE conversation_id = ? AND item_id = ?").run(now, c, itemId);
  if (!force) say(c, `${it.institution} signed me out, so i can't see your account right now. tap here to reconnect (same as before, read-only, good for 30 min):\n${link.url}`);
  return { ok: true, url: link.url, institution: it.institution };
}

// ---------------------------------------------------------------- retention: 60 days of transactions
export const KEEP_DAYS = 60;
/** The oldest day kept. A transaction dated before it is never stored, and is deleted once it ages past. */
export const cutoffDay = (now = clock.now()) => addDays(new Date(now).toISOString().slice(0, 10), -KEEP_DAYS);
/** The retention sweep (src/serve.js, at start and hourly): everybody's transactions older than 60 days go. */
export function purgeOld({ now = clock.now() } = {}) {
  // Cross-person on purpose: a retention sweep by date.
  return Number(q("DELETE FROM plaid_transactions WHERE date < ?").run(cutoffDay(now)).changes);
}

// ---------------------------------------------------------------- sync
/**
 * What a charge is called: Plaid's merchant name when it has one. Otherwise the bank's own line,
 * with every run of five or more digits taken out: real ones read "WITHDRAWAL DEBIT CARD ... DATE
 * 04/12 23978676735612 63546108 CARD 94353" (Sandbox, 2026-11-13), and a transfer's line can carry
 * the whole number of the account it went to.
 */
export const txName = (t) => String(t?.merchant_name || String(t?.name ?? "").replace(/[#x*•-]*\d{5,}/gi, " ").replace(/\s+/g, " ").trim()).slice(0, 120);
const slim = (t) => ({
  amount: Number(t.amount) || 0, currency: t.iso_currency_code || t.unofficial_currency_code || "USD",
  name: txName(t),
  primary: String(t.personal_finance_category?.primary ?? ""), detailed: String(t.personal_finance_category?.detailed ?? ""),
});
/**
 * Pull what changed for one bank with /transactions/sync and apply it. The cursor is saved only when
 * a whole run of pages has been applied; a mutation mid-pagination restarts from the cursor it began with.
 */
export async function sync(c, itemId) {
  const it = itemOf(c, itemId);
  if (!it || it.status === "removing") return { ok: false, error: "no_such_bank" };
  const api = await client();
  const access_token = tokenOf(c, itemId);
  const put = q(`INSERT INTO plaid_transactions (conversation_id, item_id, account_id, transaction_id, date, pending, data) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (conversation_id, transaction_id) DO UPDATE SET account_id = excluded.account_id, date = excluded.date, pending = excluded.pending, data = excluded.data`);
  const drop = q("DELETE FROM plaid_transactions WHERE conversation_id = ? AND transaction_id = ?");
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor = it.cursor || undefined, added = [], modified = [], removed = [], more = true, pages = 0, accts = null, status = "";
    try {
      while (more && pages++ < 40) {
        const page = await api.transactions.sync({ access_token, ...(cursor ? { cursor } : {}), count: 500 });
        added.push(...(page.added ?? [])); modified.push(...(page.modified ?? [])); removed.push(...(page.removed ?? []));
        if (page.accounts?.length) accts = page.accounts;
        status = page.transactions_update_status ?? status;
        cursor = page.next_cursor; more = !!page.has_more;
      }
    } catch (e) {
      const code = errorCode(e);
      if (code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") continue;
      if (NEEDS_LOGIN.has(code)) { await askReconnect(c, itemId); return { ok: false, error: "login_required" }; }
      return { ok: false, error: code };
    }
    db.db.exec("BEGIN");
    try {
      const cutoff = cutoffDay();
      for (const t of [...added, ...modified]) {
        if (!t?.transaction_id) continue;
        // Older than 60 days: never stored (the first sync brings months of history), and dropped if it was.
        if (String(t.date ?? "").slice(0, 10) < cutoff) { drop.run(c, t.transaction_id); continue; }
        put.run(c, itemId, String(t.account_id ?? ""), t.transaction_id, String(t.date ?? "").slice(0, 10), t.pending ? 1 : 0, sealCell("plaid_transactions", "data", c, JSON.stringify(slim(t))));
      }
      for (const r of removed) if (r?.transaction_id) drop.run(c, r.transaction_id);
      q("DELETE FROM plaid_transactions WHERE conversation_id = ? AND date < ?").run(c, cutoff);
      q("UPDATE plaid_items SET cursor = ?, synced_at = ?, history = ?, status = CASE WHEN status = 'login_required' THEN 'ok' ELSE status END WHERE conversation_id = ? AND item_id = ?").run(cursor ?? "", clock.now(), status || it.history || "", c, itemId);
      db.db.exec("COMMIT");
    } catch (e) { db.db.exec("ROLLBACK"); throw e; }
    if (accts) saveAccounts(c, itemId, accts);
    return { ok: true, added: added.length, modified: modified.length, removed: removed.length, history: status };
  }
  return { ok: false, error: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" };
}

// ---------------------------------------------------------------- reading: up to date first
/** A bank synced this recently, with its history in, is read as it stands. */
export const SYNC_FRESH_MS = 30_000;
/** A bank connected less than this long ago with nothing stored yet is still arriving, whatever status Plaid gave. */
const SETTLING_MS = 10 * 60_000;
const HISTORY_IN = "HISTORICAL_UPDATE_COMPLETE";
/**
 * Before a read of transactions: bring every connected bank up to date, without waiting on a
 * webhook. Against Plaid's real Sandbox the first sync after a connection always had nothing, the
 * transactions came seconds later, and the status once ran ahead of them; and a webhook that is
 * late, lost or refused is never sent again after a 4xx. Without this, "you spent $0.00" stands as
 * an answer. /transactions/sync is not billed per call (Transactions is a monthly fee per Item).
 * A bank synced in the last 30 seconds whose history is in is left alone, unless it was connected in
 * the last ten minutes and has nothing stored: that one is asked every time until something lands.
 * Returns the banks with nothing in yet (`loading`) and those whose older weeks are still coming (`partial`).
 */
export async function freshen(c) {
  const loading = [], partial = [];
  const count = q("SELECT COUNT(*) AS n FROM plaid_transactions WHERE conversation_id = ? AND item_id = ?");
  for (const it of itemsOf(c)) {
    if (it.status !== "ok") continue; // a bank that needs signing in to is said by the caller
    const settling = clock.now() - it.connectedAt < SETTLING_MS;
    const empty = () => !Number(count.get(c, it.itemId)?.n ?? 0);
    let history = it.history;
    const fresh = history === HISTORY_IN && !!it.syncedAt && clock.now() - it.syncedAt < SYNC_FRESH_MS && !(settling && empty());
    if (!fresh) { try { const r = await sync(c, it.itemId); if (r.ok) history = r.history || history; } catch (e) { logFn({ plaid_refresh_failed: errorCode(e) }); } }
    if (empty() && (history !== HISTORY_IN || settling)) loading.push(it.institution);
    else if (history === "NOT_READY" || history === "INITIAL_UPDATE_COMPLETE") partial.push(it.institution);
  }
  return { loading, partial };
}
const STILL_LOADING = (banks) => ({ ok: false, error: "still_loading", still_loading: banks, say: `${banks.join(" and ")} was only just connected and its transactions have not arrived from the bank yet (it takes a minute or so). Say that in one line and to ask again in a minute. Do not give a number: $0 would be wrong.` });
const loadingNote = (f) => ({
  ...(f.loading.length ? { still_loading: f.loading, loading_note: `${f.loading.join(" and ")} was only just connected and its transactions are still coming in, so none of it is in this answer yet. Say that in a few words; never give this as their whole spending.` } : {}),
  ...(f.partial.length ? { history_still_arriving: f.partial, history_note: `${f.partial.join(" and ")}: the last month is in and the weeks before it are still arriving. Say so only if they asked about further back than a month.` } : {}),
});

// ---------------------------------------------------------------- reading: spending
/** Plaid's personal_finance_category primaries, said the way a person would. */
export const CATEGORY = {
  FOOD_AND_DRINK: "food", TRANSPORTATION: "transport", TRAVEL: "travel", GENERAL_MERCHANDISE: "shopping", HOME_IMPROVEMENT: "shopping",
  RENT_AND_UTILITIES: "bills", LOAN_PAYMENTS: "bills", ENTERTAINMENT: "entertainment", MEDICAL: "health", PERSONAL_CARE: "health",
  GENERAL_SERVICES: "services", GOVERNMENT_AND_NON_PROFIT: "services", BANK_FEES: "fees", OTHER: "other",
};
/** Money that moved but was not spent: pay, transfers between their own accounts, paying off a card. */
const NOT_SPENDING = new Set(["INCOME", "TRANSFER_IN", "TRANSFER_OUT", "LOAN_DISBURSEMENTS"]);
const isSpend = (t) => t.amount > 0 && !NOT_SPENDING.has(t.primary) && t.detailed !== "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";
export const categoryOf = (t) => CATEGORY[t.primary] ?? "other";
const ymd = (ms, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A named stretch as two days in THEIR time zone. Weeks start Monday. */
export function periodDays(period, { now = clock.now(), tz = "America/New_York" } = {}) {
  const today = ymd(now, tz);
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const monthStart = `${today.slice(0, 8)}01`;
  switch (period) {
    case "today": return { from: today, to: today };
    case "yesterday": return { from: addDays(today, -1), to: addDays(today, -1) };
    case "this_week": return { from: addDays(today, -dow), to: today };
    case "last_week": return { from: addDays(today, -dow - 7), to: addDays(today, -dow - 1) };
    case "last_month": { const end = addDays(monthStart, -1); return { from: `${end.slice(0, 8)}01`, to: end }; }
    case "last_30_days": return { from: addDays(today, -29), to: today };
    case "last_60_days": return { from: addDays(today, -59), to: today };
    case "this_month": default: return { from: monthStart, to: today };
  }
}
const money = (n) => `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function rowsIn(c, from, to) {
  return q("SELECT account_id, item_id, transaction_id, date, pending, data FROM plaid_transactions WHERE conversation_id = ? AND date >= ? AND date <= ? ORDER BY date DESC")
    .all(c, from, to).map(r => { let d = {}; try { d = JSON.parse(r.data); } catch { /* unreadable row: skipped below */ } return { ...d, date: r.date, pending: !!r.pending, account_id: r.account_id, item_id: r.item_id, transaction_id: r.transaction_id }; })
    .filter(t => typeof t.amount === "number");
}
/** A word they used ("food", "groceries", "uber") against a transaction: our category, Plaid's finer one, or the merchant. */
function matches(t, word) {
  const w = String(word ?? "").trim().toLowerCase().replace(/s$/, "");
  if (!w) return true;
  if (categoryOf(t) === w || categoryOf(t).replace(/s$/, "") === w) return true;
  return t.detailed.toLowerCase().replace(/_/g, " ").includes(w) || t.name.toLowerCase().includes(w);
}
const MOVES = new Set(["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"]);
const isCardPayment = (t) => t.detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";
/**
 * Money moved between their OWN connected accounts, found by both sides being visible: an amount
 * out of one account and the same amount into another within three days, where Plaid called at
 * least one side a transfer or a loan payment. (That last condition is what keeps a $20 purchase on
 * one card and a $20 refund on another from being read as a transfer.) Each side is used once.
 * Money arriving in a LOAN account is never the other half: what they pay toward a mortgage, a car
 * or a student loan is spending whether or not that loan is connected. (A card is the opposite:
 * what was bought on it is the spending, so paying it off is a move.)
 * Returns the transaction ids of both sides.
 */
function ownMoves(rows, accts = new Map()) {
  const internal = new Set();
  const ins = rows.filter(t => t.amount < 0 && accts.get(t.account_id)?.type !== "loan");
  for (const out of rows.filter(t => t.amount > 0)) {
    const hit = ins.find(u => !internal.has(u.transaction_id) && u.account_id !== out.account_id && Math.abs(u.amount + out.amount) < 0.005
      && Math.abs(Date.parse(u.date) - Date.parse(out.date)) <= 3 * 86400_000 && (MOVES.has(out.primary) || MOVES.has(u.primary)));
    if (hit) { internal.add(out.transaction_id); internal.add(hit.transaction_id); }
  }
  return internal;
}
/**
 * What they spent between two days, across EVERY connected account: the total, by category, by
 * account, and the biggest few. Their rows only. Not counted, so nothing is counted twice:
 *   - anything Plaid categorises TRANSFER_IN / TRANSFER_OUT, income, loan money arriving, and a
 *     credit card payment (the purchases on that card are the spending, when the card is connected);
 *   - both sides of a move between their own accounts (ownMoves), even when Plaid mislabelled one.
 * When only ONE side is connected there is nothing to match, so Plaid's category is all there is:
 * a transfer or card payment Plaid labelled correctly is left out, and `not_counted` says how much
 * went to a card Reason cannot see (what was bought on it is not in the total) and how much was
 * transferred out. One that Plaid labelled as something else is counted as spending.
 * Nothing on a loan account is spending: interest accruing there and payments arriving there are
 * the loan's own bookkeeping, and the payment that left their cash account is already counted.
 */
export function spending(c, { from, to, category = "" } = {}) {
  const accts = accountMap(c);
  const wide = rowsIn(c, addDays(from, -3), addDays(to, 3));
  const internal = ownMoves(wide, accts);
  const inRange = wide.filter(t => t.date >= from && t.date <= to);
  const all = inRange.filter(isSpend).filter(t => accts.get(t.account_id)?.type !== "loan").filter(t => !internal.has(t.transaction_id)).filter(t => matches(t, category));
  const total = all.reduce((s, t) => s + t.amount, 0);
  const sumBy = (key) => { const m = new Map(); for (const t of all) m.set(key(t), (m.get(key(t)) ?? 0) + t.amount); return m; };
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  const byAccount = sumBy(t => accts.get(t.account_id)?.label ?? "an account");
  const outside = inRange.filter(t => t.amount > 0 && !internal.has(t.transaction_id));
  const unseenCard = outside.filter(t => isCardPayment(t) && accts.get(t.account_id)?.type === "depository").reduce((s, t) => s + t.amount, 0);
  const sentOut = outside.filter(t => t.primary === "TRANSFER_OUT").reduce((s, t) => s + t.amount, 0);
  // A card payment with no other half: a card they have not connected, or (when a card IS connected) one that has not shown the payment yet.
  const hasCard = [...accts.values()].some(a => a.type === "credit");
  return {
    from, to, total: money(total), count: all.length,
    by_category: top(sumBy(categoryOf), 8).map(([name, n]) => ({ category: name, amount: money(n) })),
    ...(byAccount.size > 1 ? { by_account: top(byAccount, 8).map(([account, n]) => ({ account, amount: money(n) })) } : {}),
    top_merchants: top(sumBy(t => t.name), 5).map(([name, n]) => ({ name, amount: money(n) })),
    pending_included: all.some(t => t.pending),
    ...(!category && (unseenCard || sentOut) ? { not_counted: {
      ...(unseenCard ? { paid_to_cards_not_connected: money(unseenCard) } : {}), ...(sentOut ? { transfers_out: money(sentOut) } : {}),
      note: `${unseenCard ? `They paid toward a card ${hasCard ? "and no connected card shows that payment (a card that isn't connected, or one that hasn't posted it yet)" : "that isn't connected"}, so what was bought on that card isn't in this total. ` : ""}${sentOut ? "Transfers out (to another account or a person) aren't counted as spending. " : ""}Mention it in a few words only if it matters to what they asked.` } } : {}),
  };
}
/** Their transactions in a stretch, newest first, optionally narrowed by a word. Account shown as last four. */
export function transactions(c, { from, to, search = "", limit = 20 } = {}) {
  const accts = accountMap(c);
  const rows = rowsIn(c, from, to).filter(t => matches(t, search));
  return {
    from, to, count: rows.length,
    transactions: rows.slice(0, Math.max(1, Math.min(50, limit))).map(t => ({
      date: t.date, name: t.name, amount: t.amount < 0 ? `+${money(-t.amount)}` : money(t.amount), category: NOT_SPENDING.has(t.primary) ? t.primary.toLowerCase().replace(/_/g, " ") : isCardPayment(t) ? "card payment" : categoryOf(t),
      ...(t.pending ? { pending: true } : {}), ...(accts.get(t.account_id) ? { account: accts.get(t.account_id).label } : {}),
    })),
  };
}

// ---------------------------------------------------------------- reading: subscriptions
/** How many times a year each of Plaid's frequencies comes round. A monthly charge costs exactly itself a month. */
const PER_YEAR = { WEEKLY: 52, BIWEEKLY: 26, SEMI_MONTHLY: 24, MONTHLY: 12, ANNUALLY: 1 };
const perMonth = (amount, freq) => (PER_YEAR[freq] ? amount * PER_YEAR[freq] / 12 : amount);
/**
 * Recurring charges worked out from the 60 days kept, across every account: the same name, about the
 * same amount, twice, about a month apart. A yearly charge cannot be seen this way; only Plaid's
 * recurring endpoint can name one.
 */
export function localRecurring(c, { now = clock.now(), tz = "America/New_York" } = {}) {
  const today = ymd(now, tz);
  const groups = new Map();
  const accts = accountMap(c);
  for (const t of rowsIn(c, cutoffDay(now), today).filter(isSpend).filter(t => !t.pending && accts.get(t.account_id)?.type !== "loan")) {
    const k = t.name.toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const days = list.map(t => t.date).sort();
    const gaps = days.slice(1).map((d, i) => (Date.parse(d) - Date.parse(days[i])) / 86400_000);
    const amounts = list.map(t => t.amount);
    const avg = amounts.reduce((s, n) => s + n, 0) / amounts.length;
    const steady = amounts.every(n => Math.abs(n - avg) <= Math.max(1, avg * 0.15));
    if (!steady || !gaps.every(g => g >= 26 && g <= 35)) continue;
    const last = days[days.length - 1];
    out.push({ name: list[0].name, amount: avg, last_amount: list.find(t => t.date === last)?.amount ?? avg, frequency: "MONTHLY", last_date: last, next_date: addDays(last, 30), category: categoryOf(list[0]) });
  }
  return out;
}
/**
 * What they pay for on repeat. Plaid's /transactions/recurring/get when the plan has it (it is an
 * add-on); otherwise worked out here, and the answer says which.
 */
export async function subscriptions(c, { now = clock.now() } = {}) {
  const tz = zoneFor(c) || "America/New_York";
  const today = ymd(now, tz);
  let streams = [], source = "plaid", asked = 0, unready = 0;
  try {
    const api = await client();
    const accts = accountMap(c);
    for (const it of itemsOf(c)) {
      if (it.status !== "ok") continue;
      asked++;
      let out;
      // A bank connected seconds ago answers PRODUCT_NOT_READY (real Sandbox): it is left out, and the others still count.
      try { out = await api.transactions.getRecurring({ access_token: tokenOf(c, it.itemId) }); }
      catch (e) { if (errorCode(e) === "PRODUCT_NOT_READY") { unready++; continue; } throw e; }
      for (const s of out?.outflow_streams ?? []) {
        if (s.is_active === false || s.status === "TOMBSTONED") continue;
        if (accts.get(s.account_id)?.type === "loan") continue; // interest accruing on a loan is not a charge they pay
        const t = { primary: s.personal_finance_category?.primary ?? "", detailed: s.personal_finance_category?.detailed ?? "" };
        if (NOT_SPENDING.has(t.primary) || t.detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") continue;
        streams.push({ name: String(s.merchant_name || s.description || "").slice(0, 120), amount: Math.abs(Number(s.average_amount?.amount) || 0), last_amount: Math.abs(Number(s.last_amount?.amount) || 0), frequency: s.frequency || "UNKNOWN", last_date: s.last_date || "", next_date: s.predicted_next_date || "", category: categoryOf(t) });
      }
    }
    if (asked && unready === asked) throw Object.assign(new Error("recurring not ready"), { code: "PRODUCT_NOT_READY" });
  } catch (e) {
    // Not on the plan, not ready yet, or Plaid is down: the local reading is still an honest answer.
    source = "worked_out_here"; streams = localRecurring(c, { now, tz });
    logFn({ plaid_recurring_fallback: errorCode(e) });
  }
  const month = today.slice(0, 7);
  streams = streams.filter(s => s.name && s.amount > 0);
  const costs = (s) => perMonth(s.last_amount || s.amount, s.frequency); // what it last cost: the amount listed
  const list = [...streams].sort((a, b) => costs(b) - costs(a)).map(s => ({
    name: s.name, amount: money(s.last_amount || s.amount), every: s.frequency.toLowerCase().replace(/_/g, " "), category: s.category,
    ...(s.last_date ? { last_charged: s.last_date } : {}), ...(s.next_date ? { next_expected: s.next_date } : {}),
    gone_out_this_month: !!s.last_date && s.last_date.startsWith(month),
  }));
  // The monthly total is of the amounts listed (what each last cost), so the list adds up to it.
  return { subscriptions: list, per_month: money(streams.reduce((s, x) => s + costs(x), 0)), count: list.length, source, today };
}

// ---------------------------------------------------------------- reading: balance (always fresh)
/** Real-time balances from /accounts/balance/get. Never a stored number: nothing here is kept. */
export async function balances(c) {
  const api = await client();
  const out = [], problems = [];
  for (const it of itemsOf(c)) {
    if (it.status !== "ok") { problems.push({ bank: it.institution, problem: "needs_reconnect" }); continue; }
    try {
      const got = await api.accounts.getBalance({ access_token: tokenOf(c, it.itemId) });
      for (const a of got?.accounts ?? []) {
        out.push({ bank: it.institution, account: accountLabel({ ...a, mask: a.mask }, ""), type: a.type, subtype: a.subtype ?? "", available: a.balances?.available ?? null, current: a.balances?.current ?? null, limit: a.balances?.limit ?? null, currency: a.balances?.iso_currency_code ?? "USD" });
      }
    } catch (e) {
      const code = errorCode(e);
      if (NEEDS_LOGIN.has(code)) { await askReconnect(c, it.itemId); problems.push({ bank: it.institution, problem: "needs_reconnect" }); }
      else problems.push({ bank: it.institution, problem: code });
    }
  }
  return { accounts: out, problems };
}
const spendable = (a) => (a.type === "depository" ? (a.available ?? a.current) : null);

/**
 * Before a pay step: is there enough in a linked account for this amount? Fresh from Plaid.
 *   { checked: false }                 nothing linked, the switch is off, or Plaid could not say: the pay step goes on as before
 *   { checked: true, short: false }
 *   { checked: true, short: true, ... } the caller tells them and waits for a fresh yes (payWarned / payCleared)
 * "Enough" is the fullest checking or savings account covering it: Reason cannot know which account a
 * card draws on, so it only speaks up when NO linked cash account would cover the amount.
 */
export async function balanceCheck(c, amount) {
  const need = Number(amount);
  if (!plaidOn(c) || !configured() || !hasBank(c) || !(need > 0)) return { checked: false };
  let got;
  try { got = await balances(c); } catch { return { checked: false }; }
  const cash = got.accounts.filter(a => spendable(a) !== null);
  if (!cash.length) return { checked: false };
  const best = cash.reduce((m, a) => (spendable(a) > spendable(m) ? a : m));
  noteRead(c);
  if (spendable(best) >= need) return { checked: true, short: false };
  return { checked: true, short: true, account: [best.bank, best.account].filter(Boolean).join(" "), available: money(spendable(best)), needed: money(need) };
}
/** They were told it looks short for this payment, having sent `ownerMsgs` texts so far. */
export function payWarned(c, paymentId, ownerMsgs) {
  q("INSERT INTO plaid_pay_checks (conversation_id, payment_id, warned_at, owner_msgs) VALUES (?, ?, ?, ?) ON CONFLICT (conversation_id, payment_id) DO NOTHING").run(c, paymentId, clock.now(), ownerMsgs);
}
/** True once they have texted again after the warning: that later yes is the go-ahead. */
export function payCleared(c, paymentId, ownerMsgs) {
  const r = q("SELECT owner_msgs FROM plaid_pay_checks WHERE conversation_id = ? AND payment_id = ?").get(c, paymentId);
  return !!r && ownerMsgs > r.owner_msgs;
}

// ---------------------------------------------------------------- memory: the numbers stay out
export const READ_WINDOW_MS = 5 * 60_000;
/** A bank read was just answered for them. */
export function noteRead(c) { try { q("INSERT INTO plaid_reads (conversation_id, at) VALUES (?, ?)").run(c, clock.now()); q("DELETE FROM plaid_reads WHERE conversation_id = ? AND at < ?").run(c, clock.now() - 60 * 86400_000); } catch { /* a missed mark only means one reply is read */ } }
/** Did Reason answer from their bank in the minutes before `at`? Then that reply is not memory material. */
export function financeReply(c, at = clock.now()) {
  try { return !!q("SELECT 1 AS x FROM plaid_reads WHERE conversation_id = ? AND at <= ? AND at >= ? LIMIT 1").get(c, at, at - READ_WINDOW_MS); } catch { return false; }
}
/** For the nightly review: its messages without Reason's replies that carried bank numbers. Their own words stay. */
export function withoutFinanceReplies(c, rows = []) {
  let marks;
  try { marks = q("SELECT at FROM plaid_reads WHERE conversation_id = ? ORDER BY at").all(c).map(r => r.at); } catch { return rows; }
  if (!marks.length) return rows;
  return rows.filter(r => r.role !== "assistant" || !marks.some(m => m <= r.at && m >= r.at - READ_WINDOW_MS));
}

// ---------------------------------------------------------------- disconnect
function wipeLocal(c, itemId) {
  q("DELETE FROM plaid_transactions WHERE conversation_id = ? AND item_id = ?").run(c, itemId);
  q("DELETE FROM plaid_accounts WHERE conversation_id = ? AND item_id = ?").run(c, itemId);
  q("DELETE FROM plaid_links WHERE conversation_id = ? AND item_id = ?").run(c, itemId);
}
/**
 * Disconnect a bank: /item/remove at Plaid, then the token and everything synced from it. Their data
 * goes at once whatever Plaid answers; if Plaid could not be reached the sealed token alone is kept,
 * marked `removing`, so the removal is tried again (retryRemovals) instead of leaving a live grant behind.
 */
export async function disconnect(c, { itemId = "", all = false } = {}) {
  const mine = itemsOf(c);
  const targets = all ? mine : mine.filter(i => i.itemId === itemId);
  if (!targets.length) return { ok: false, error: mine.length ? "which_bank" : "no_bank", banks: mine.map(i => i.institution) };
  const removed = [], pending = [];
  for (const it of targets) {
    wipeLocal(c, it.itemId);
    let gone = false;
    try { const api = await client(); await api.item.remove({ access_token: tokenOf(c, it.itemId) }); gone = true; }
    catch (e) { const code = errorCode(e); gone = code === "ITEM_NOT_FOUND" || code === "INVALID_ACCESS_TOKEN"; if (!gone) logFn({ plaid_remove_failed: code }); }
    if (gone) q("DELETE FROM plaid_items WHERE conversation_id = ? AND item_id = ?").run(c, it.itemId);
    else { q("UPDATE plaid_items SET status = 'removing', cursor = '', institution = '' WHERE conversation_id = ? AND item_id = ?").run(c, it.itemId); pending.push(it.institution); }
    removed.push(it.institution);
  }
  if (!itemsOf(c).length) { q("DELETE FROM plaid_links WHERE conversation_id = ?").run(c); q("DELETE FROM plaid_pay_checks WHERE conversation_id = ?").run(c);  revokeCheckinGrants(c); }
  return { ok: true, removed, ...(pending.length ? { plaid_removal_pending: pending } : {}) };
}
/** Removals Plaid has not confirmed, tried again. Called from the webhook path and the hourly sweep. */
export async function retryRemovals() {
  if (!configured()) return 0;
  let n = 0;
  // Cross-person on purpose: a sweep of rows whose owner already asked for them to go.
  for (const r of q("SELECT conversation_id, item_id, access_token FROM plaid_items WHERE status = 'removing'").all()) {
    try { const api = await client(); await api.item.remove({ access_token: openTok(r.access_token) }); }
    catch (e) { const code = errorCode(e); if (code !== "ITEM_NOT_FOUND" && code !== "INVALID_ACCESS_TOKEN") continue; }
    q("DELETE FROM plaid_items WHERE conversation_id = ? AND item_id = ?").run(r.conversation_id, r.item_id); n++;
  }
  return n;
}
/** For a full delete of somebody's data (src/data.js): let go at Plaid first, while the tokens are still here. */
export async function removeAllAtPlaid(conversation = null) {
  // The count of banks ever connected stays (Plaid still counts them); whose they were does not.
  if (conversation) q("UPDATE plaid_slots SET who = '' WHERE who = ?").run(clientUserId(conversation));
  else q("UPDATE plaid_slots SET who = ''").run();
  if (!configured()) return { removed: 0, failed: 0 };
  const rows = conversation
    ? q("SELECT conversation_id, item_id, access_token FROM plaid_items WHERE conversation_id = ?").all(conversation)
    : q("SELECT conversation_id, item_id, access_token FROM plaid_items").all();
  let removed = 0, failed = 0;
  for (const r of rows) {
    try { const api = await client(); await api.item.remove({ access_token: openTok(r.access_token) }); removed++; }
    catch (e) { const code = errorCode(e); if (code === "ITEM_NOT_FOUND" || code === "INVALID_ACCESS_TOKEN") removed++; else failed++; }
  }
  return { removed, failed };
}

// ---------------------------------------------------------------- webhooks
const keyCache = new Map(); // kid -> { key (KeyObject), expired }
const b64json = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
/**
 * Plaid's webhook verification, as documented: the Plaid-Verification header is a JWT signed ES256;
 * its key is fetched by `kid` (and cached), the signature is checked, `iat` must be within five
 * minutes, and the SHA-256 of the raw body must equal `request_body_sha256`, compared in constant time.
 */
export async function verifyWebhook({ rawBody = "", headers = {}, nowMs = clock.now() } = {}) {
  const jwt = String(headers["plaid-verification"] ?? headers["Plaid-Verification"] ?? "");
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, why: "no signature" };
  let head, claims;
  try { head = b64json(parts[0]); claims = b64json(parts[1]); } catch { return { ok: false, why: "unreadable signature" }; }
  if (head?.alg !== "ES256" || !head?.kid) return { ok: false, why: "wrong algorithm" };
  let entry = keyCache.get(head.kid);
  if (!entry) {
    try {
      const api = await client();
      const got = await api.webhook.getVerificationKey({ key_id: String(head.kid) });
      const jwk = got?.key;
      if (!jwk?.x || !jwk?.y) return { ok: false, why: "no key" };
      entry = { key: createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" }), expired: jwk.expired_at != null };
      if (keyCache.size > 20) keyCache.clear();
      keyCache.set(head.kid, entry);
    } catch (e) { return { ok: false, why: `key lookup failed: ${errorCode(e)}` }; }
  }
  if (entry.expired) return { ok: false, why: "expired key" };
  let good = false;
  try { good = cryptoVerify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: entry.key, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url")); } catch { good = false; }
  if (!good) return { ok: false, why: "bad signature" };
  const iat = Number(claims?.iat) * 1000;
  if (!Number.isFinite(iat) || Math.abs(nowMs - iat) > 5 * 60_000) return { ok: false, why: "stale" };
  const want = Buffer.from(String(claims?.request_body_sha256 ?? ""), "utf8");
  const have = Buffer.from(sha(rawBody), "utf8");
  if (want.length !== have.length || !timingSafeEqual(want, have)) return { ok: false, why: "body does not match" };
  return { ok: true };
}

/** Whose Item is this? The Item id Plaid sent is the identity; the row names the conversation. */
const ownerOfItem = (itemId) => q("SELECT conversation_id, item_id, status FROM plaid_items WHERE item_id = ?").get(String(itemId ?? "")) ?? null;

/** Act on a verified webhook. Always answers; a webhook for an Item nobody has is acknowledged and dropped. */
export async function handleWebhook(event = {}) {
  const type = String(event.webhook_type ?? ""), code = String(event.webhook_code ?? "");
  if (type === "LINK") {
    if (code === "SESSION_FINISHED" && event.link_token) {
      const tokens = event.public_tokens ?? (event.public_token ? [event.public_token] : []);
      if (String(event.status ?? "").toLowerCase() === "success" || tokens.length) return { handled: code, ...(await finishLink({ linkToken: event.link_token, publicTokens: tokens })) };
    }
    return { handled: false };
  }
  const own = ownerOfItem(event.item_id);
  if (!own || own.status === "removing") { retryRemovals().catch(() => {}); return { handled: false, matched: false }; }
  const c = own.conversation_id, itemId = own.item_id;
  if (type === "TRANSACTIONS") {
    if (code === "SYNC_UPDATES_AVAILABLE") return { handled: code, ...(await sync(c, itemId)) };
    return { handled: false }; // DEFAULT_UPDATE and friends are /transactions/get's; the sync webhook covers them
  }
  if (type === "ITEM") {
    const err = String(event.error?.error_code ?? "");
    if ((code === "ERROR" && NEEDS_LOGIN.has(err)) || code === "PENDING_EXPIRATION" || code === "PENDING_DISCONNECT") return { handled: code, ...(await askReconnect(c, itemId)) };
    if (code === "LOGIN_REPAIRED") { q("UPDATE plaid_items SET status = 'ok', relink_sent_at = NULL WHERE conversation_id = ? AND item_id = ?").run(c, itemId); return { handled: code, ok: true }; }
    if (code === "USER_PERMISSION_REVOKED" || code === "USER_ACCOUNT_REVOKED") {
      // They took the permission away at the bank: their data goes here too, the same as a disconnect.
      const name = itemOf(c, itemId)?.institution ?? "your bank";
      const out = await disconnect(c, { itemId });
      say(c, `${name} told me you turned off my access, so i've disconnected it and deleted what i had from it`);
      return { handled: code, ...out };
    }
  }
  return { handled: false };
}

// ---------------------------------------------------------------- the model's rules and the tool
// No rule in the system prompt (it is at its size budget): everything the model needs is in the tool's description.
export const PLAID_TOOLS = new Set(["bank"]);
export const plaidToolVisible = (name, conversationId) => !PLAID_TOOLS.has(name) || plaidOn(conversationId);
const PERIODS = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_30_days", "last_60_days"];
export const PLAID_TOOL_DEFS = [{
  name: "bank",
  description: "Their own bank accounts, READ-ONLY through Plaid: balances and transactions. It cannot pay, transfer or move money, and never returns a full account or routing number (last four only). Actions: "
    + "\"connect\" makes a secure Plaid link to connect a bank (or, with `bank`, to sign back in to one that needs it). Your reply is ONE short heads-up in your own voice (they connect through Plaid; you can only read balances and transactions, never move money) and then the url ON ITS OWN LINE as the last thing, untouched; it works for 30 minutes, so only call it when you are about to send it. A confirmation text goes by code when they finish. The first time a person connects, the answer has tell_first: send it word for word before the url. When connections are full the answer has say_exactly and no url: send that as it is. "
    + "\"status\" lists what is connected. "
    + "\"spending\" totals what they spent in a `period` (or `from`/`to` days), optionally one `category` (food, transport, travel, shopping, bills, entertainment, health, services, fees, or a word like groceries, coffee, rent, or a merchant). Say the total first, then a short breakdown only if it helps. Transfers, card payments, income and interest accruing on a loan are not counted as spending; a payment toward a loan is. "
    + "\"transactions\" lists them, optionally narrowed by `search`. "
    + "\"subscriptions\" lists recurring charges with what each costs, when it last went out and when the next is expected (gone_out_this_month answers \"has rent gone out yet\"). "
    + "\"balance\" fetches balances fresh from the bank (it takes a few seconds). "
    + "\"disconnect\" removes a connection at Plaid and deletes its stored token and everything synced from it. With more than one connected and none named, it answers with the list: ask which one, naming each by bank, account name and last four; `bank` takes the bank's name or an account's last four, `all` true is \"disconnect all\". Only when they ask. "
    + "\"checkin_answer\" records their answer when their message answers Reason's question whether a check-in may read their bank (\"…will read your bank each time it runs. OK to do that every time?\", \"…needs your OK to read your bank…\", \"…is still waiting on your OK to read your bank…\"): `answer` yes or no, as they said it; send the say_exactly it gives. \"checkin_stop\" when they say a check-in should stop reading their bank (`series_id` or `timer_id`, or `all`). A check-in reads their bank only after their own yes. "
    + "They can connect several banks and cards; every answer covers all of them together, and moves between their own accounts and card payments are not counted twice. When it helps, say which account a charge came from, by the account label given (name and last four) and nothing more. "
    + "You keep only the last 60 days of transactions: asked about anything older, say so plainly (\"i only keep the last 60 days\"). A yearly subscription shows only when the bank data reports it. "
    + "A bank's transactions take a minute to arrive after it is connected: when an answer says still_loading, say so and give no number. "
    + "No bank connected → offer the connect link, never a guess. Any question about their own money (what they spent, subscriptions, a balance, whether rent went out) is answered from this tool, never from a guess or memory; the number first, short, in your normal voice. Explain their numbers; never investment, tax or insurance advice, and never what to buy, sell or invest in. What you read is for this answer only: never save it with remember, and never put it on a page, an event, a card or anything another person can see.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["connect", "status", "spending", "transactions", "subscriptions", "balance", "disconnect", "checkin_answer", "checkin_stop"] },
      answer: { type: "string", enum: ["yes", "no"], description: "For checkin_answer: what their own message said." },
      series_id: { type: "integer", description: "For checkin_stop: the check-in (series_list) that should stop reading their bank." },
      timer_id: { type: "integer", description: "For checkin_stop: a timer, instead of series_id." },
      period: { type: "string", enum: PERIODS, description: "For spending and transactions. Weeks start Monday, in their time zone. Default this_month." },
      from: { type: "string", description: "First day, YYYY-MM-DD, instead of period." },
      to: { type: "string", description: "Last day, YYYY-MM-DD, instead of period." },
      category: { type: "string", description: "For spending: one category or a word to narrow by." },
      search: { type: "string", description: "For transactions: a merchant or word to narrow by." },
      bank: { type: "string", description: "For connect (reconnect) and disconnect: the bank's name as status gave it, or an account's last four digits." },
      all: { type: "boolean", description: "For disconnect: every connected bank; for checkin_stop: every check-in." },
    },
    required: ["action"],
  },
}];
export const PLAID_SCHEMAS = {
  bank: z.object({
    action: z.enum(["connect", "status", "spending", "transactions", "subscriptions", "balance", "disconnect", "checkin_answer", "checkin_stop"]),
    answer: z.enum(["yes", "no"]).optional(), series_id: z.number().int().optional(), timer_id: z.number().int().optional(),
    period: z.enum(PERIODS).optional(), from: z.string().regex(DAY_RE).optional(), to: z.string().regex(DAY_RE).optional(),
    category: z.string().max(60).optional(), search: z.string().max(60).optional(), bank: z.string().max(80).optional(), all: z.boolean().optional(),
  }),
};

const NO_BANK = { ok: false, error: "no_bank_connected", say: "No bank is connected, so there is nothing to read. Don't guess a number. Offer in one line to send a secure link to connect their bank (read-only), and call bank connect when they say yes or if they already asked to connect." };
const BEYOND = { ok: false, error: "beyond_60_days", say: `You only keep the last ${KEEP_DAYS} days of their transactions, so there is nothing for that period. Say that plainly in one line ("i only keep the last 60 days") and offer what you can see. Never estimate.` };
/** Which connection they mean: an account's last four first (two cards at one bank), then the bank's name. Null when none or more than one fits. */
function pickBank(c, list, name) {
  const w = String(name ?? "").trim().toLowerCase();
  if (!w) return null;
  const four = (w.match(/\d{4}/g) ?? []).pop();
  const byFour = four ? list.filter(i => accountsOf(c, i.itemId).some(a => last4(a.mask) === four)) : [];
  if (byFour.length === 1) return byFour[0];
  const byName = list.filter(i => i.institution.toLowerCase().includes(w) || w.includes(i.institution.toLowerCase()));
  return byName.length === 1 ? byName[0] : null;
}
const listing = (c, list) => list.map(i => ({ bank: i.institution, accounts: accountsOf(c, i.itemId).map(a => accountLabel(a, "")) }));

export async function runPlaidTool(name, input = {}, { conversationId: c, now = clock.now() } = {}) {
  if (!plaidOn(c)) return { ok: false, error: "Not available." };
  if (!configured()) return { ok: false, error: "not_set_up", say: "Bank connections aren't set up on this install yet. Say so plainly in one line; don't guess any numbers." };
  const mine = itemsOf(c);
  const tz = zoneFor(c) || "America/New_York";
  const stale = mine.filter(i => i.status === "login_required");
  // The stretch asked about, held to the 60 days kept: wholly older → nothing to read; partly older → from the cutoff, and said.
  const days = () => {
    const d = input.from && input.to ? { from: input.from, to: input.to } : periodDays(input.period ?? "this_month", { now, tz });
    const cut = cutoffDay(now);
    if (d.to < cut) return null;
    return d.from < cut ? { from: cut, to: d.to, limited: { only_last_60_days: true, window_note: `They asked about more than you keep. This covers ${cut} onward only; tell them in a few words that you only keep the last 60 days.` } } : d;
  };
  // Read after freshen: a sync that met an expired login has just marked that bank.
  const reconnectNote = () => { const stale = itemsOf(c).filter(i => i.status === "login_required"); return stale.length ? { needs_reconnect: stale.map(i => i.institution), note: `${stale.map(i => i.institution).join(" and ")} needs them to sign in again, so its numbers may be behind. Say that in a few words and offer the reconnect link (bank connect with bank).` } : {}; };
  try {
    switch (input.action) {
      case "connect": {
        const target = pickBank(c, mine, input.bank) ?? (stale.length === 1 && !input.bank ? stale[0] : null);
        const first = !target && firstTime(c);
        const link = target ? await askReconnect(c, target.itemId, { force: true }) : await createLink(c);
        if (link.error === "connections_full") {
          return { ok: false, error: link.error, say_exactly: FULL_WORDS, say: "No link was made. Send say_exactly as it is, and nothing else about connecting a bank." };
        }
        if (!link.ok) return { ok: false, error: link.error, say: "The link could not be made just now. Say so in one line and offer to try again in a minute." };
        return { ok: true, url: link.url, minutes: LINK_TTL_S / 60, ...(target ? { reconnecting: target.institution } : {}), ...(first ? { tell_first: CONSENT_WORDS } : {}),
          say: target
            ? `One short line that ${target.institution} needs them to sign in again (same as before, read-only), then this url ON ITS OWN LINE as the last thing, untouched. It works for 30 minutes.`
            : first
            ? "Their first bank: send tell_first word for word, before the link, then this url ON ITS OWN LINE as the last thing, untouched. It works for 30 minutes. Don't say it's connected; a text goes by code when they finish."
            : "One short heads-up in your own voice, lowercase: they connect through Plaid, and you can only read balances and transactions, never move money. Then this url ON ITS OWN LINE as the last thing, untouched. It works for 30 minutes. Don't say it's connected; a text goes by code when they finish." };
      }
      case "status":
        if (!mine.length) return NO_BANK;
        return { ok: true, keeps: `the last ${KEEP_DAYS} days of transactions`, banks: mine.map(i => ({ bank: i.institution, status: i.status === "ok" ? "connected" : "needs_reconnect", accounts: accountsOf(c, i.itemId).map(a => accountLabel(a, "")), ...(i.syncedAt ? { last_synced: new Date(i.syncedAt).toISOString() } : {}), ...(i.status === "ok" && i.history !== HISTORY_IN ? { transactions: "still coming in from the bank" } : {}) })), can: "read balances and transactions", cannot: "move money" };
      case "spending": {
        if (!mine.length) return NO_BANK;
        const d = days();
        if (!d) return BEYOND;
        const f = await freshen(c);
        if (f.loading.length === mine.length) return STILL_LOADING(f.loading);
        noteRead(c);
        return { ok: true, ...spending(c, { from: d.from, to: d.to, category: input.category ?? "" }), ...(d.limited ?? {}), ...reconnectNote(), ...loadingNote(f), say: "Lead with the total, lowercase and short, then a brief breakdown only if it helps. No advice about what to do with their money beyond what they asked." };
      }
      case "transactions": {
        if (!mine.length) return NO_BANK;
        const d = days();
        if (!d) return BEYOND;
        const f = await freshen(c);
        if (f.loading.length === mine.length) return STILL_LOADING(f.loading);
        noteRead(c);
        return { ok: true, ...transactions(c, { from: d.from, to: d.to, search: input.search ?? "" }), ...(d.limited ?? {}), ...reconnectNote(), ...loadingNote(f) };
      }
      case "subscriptions": {
        if (!mine.length) return NO_BANK;
        const f = await freshen(c);
        if (f.loading.length === mine.length) return STILL_LOADING(f.loading);
        noteRead(c);
        const out = await subscriptions(c, { now });
        return { ok: true, ...out, ...reconnectNote(), ...loadingNote(f), say: `Lead with how many and the monthly total, then the list, short.${out.source === "worked_out_here" ? " This list was worked out from the last 60 days of their transactions, so say it may miss yearly ones." : ""}` };
      }
      case "balance": {
        if (!mine.length) return NO_BANK;
        noteRead(c);
        const out = await balances(c);
        if (!out.accounts.length) return { ok: false, error: "no_balance", problems: out.problems, say: out.problems.some(p => p.problem === "needs_reconnect") ? "The bank needs them to sign in again before you can see a balance; a reconnect link was texted. Say that in one line." : "The bank didn't answer just now. Say so in one line; don't give an old number." };
        return { ok: true, accounts: out.accounts.map(a => ({ account: [a.bank, a.account].filter(Boolean).join(" "), ...(a.available != null ? { available: money(a.available) } : {}), ...(a.current != null ? { current: money(a.current) } : {}), ...(a.limit != null ? { limit: money(a.limit) } : {}) })), ...(out.problems.length ? { problems: out.problems } : {}), fresh: true, say: "The number first. For a card, current is what they owe." };
      }
      case "disconnect": {
        if (!mine.length) return { ok: false, error: "no_bank_connected", say: "No bank is connected, so there is nothing to disconnect. Say so in one line." };
        const target = input.all ? null : pickBank(c, mine, input.bank) ?? (mine.length === 1 && !input.bank ? mine[0] : null);
        if (!target && !input.all) return { ok: false, error: "which_bank", connections: listing(c, mine), say: "Nothing was disconnected. Ask in one line which one, naming each by bank, account name and last four, or whether they mean all of them." };
        const out = await disconnect(c, input.all ? { all: true } : { itemId: target.itemId });
        return { ...out, say: `Say in one short line that ${out.removed.join(" and ")} is disconnected and what you had from it is deleted.` };
      }
      default: return { ok: false, error: "unknown action" };
    }
  } catch (e) {
    if (e?.code === "not_configured") return { ok: false, error: "not_set_up" };
    logFn({ plaid_tool_failed: errorCode(e), action: input.action });
    return { ok: false, error: errorCode(e), say: "The bank lookup failed just now. Say so in one line and don't guess a number." };
  }
}

/** Tests only. */
export function _reset() { cached = null; keyCache.clear(); finishing.clear(); sayFn = null; logFn = () => {}; }
