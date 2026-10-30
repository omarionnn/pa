// Shopping accounts for Crossmint agent checkouts: guest first, a store sign-in only when the store
// insists, a card kept by Crossmint, and a payment approved only on a yes to Crossmint's own amount.
//
// Written from Crossmint's docs (docs.crossmint.com, read 2026-10-30) and four live prod runs that day
// (/tmp/crossmint-target/STATE.md). What matters:
//
//   **Guest first.** Best Buy checks out as a guest and reached Crossmint's payment request for an
//   exact $9.79. Target and Walmart answer merchant.no_safe_path without an account. So a checkout
//   starts as a guest unless the store is known to need an account (STORES) or the model learned it
//   from a blocked run (`sign_in: true`), and then it starts in the person's browser profile.
//
//   **The password never comes here.** A sign-in question arrives as a form whose secret fields are
//   `handling: "protected"`. Reason texts a link to a page (src/pages/webconnect.js) where those fields
//   are Crossmint's own iframe (CrossmintProtectedInput); the page hands back `{ protectedInputId }`
//   and nothing else. `checkAnswers` refuses a protected field that is anything but that reference, so
//   even a tampered page cannot push a typed password through this server. Answers are never logged
//   and never stored: only the field KEYS are kept, so the page can tell a second password ask (wrong
//   password) from a code ask.
//
//   **One browser profile per person, one Crossmint user per person.** Crossmint allows ONE profile per
//   user (a second POST is 409) and pays only from that same user's card. So each person is one
//   Crossmint user (`crossmintUser`, a hash of their conversation, never their number) with one
//   profile that keeps every store they signed into; which stores they connected is kept here, per
//   person and store (shop_stores). Removing a store stops Reason using it; removing the last one
//   deletes the profile, which erases every saved sign-in at Crossmint.
//
//   **A card is Crossmint's.** Crossmint's card form saves it and gives back a paymentMethodId; only
//   that id, the brand and the last four are kept here.
//
//   **A payment is paid only on a yes to Crossmint's number.** The checkout pauses with an
//   input_request (`interaction.kind: "payment"`, `method: "card"`) carrying the amount. That amount
//   string is stored as given and is the only amount ever shown or approved: the ask is built from the
//   row, the gate's target is built from the row (src/tools.js confirmTargetFor "shop_pay"), and the
//   order intent is created for the row's amount. Nothing the model types can change it.
import { createHash, createSign, createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { config, clock } from "./config.js";

// ---------------------------------------------------------------- the flag
// REASON_SHOP_CONNECT (off | owner | on), off by default. `owner`: only the operator's conversation.
// Read at call time so a test can set it and a restart is the only switch.
export function connectMode() {
  const v = String(process.env.REASON_SHOP_CONNECT ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}
export function connectAllowedFor(conversationId) {
  if (!conversationId) return false;
  const mode = connectMode();
  if (mode === "owner") return accounts.ownerOf(conversationId).isOperator;
  return mode === "on";
}

// ---------------------------------------------------------------- stores
/** What Reason knows about a store. `signIn`: "required" (no guest checkout) or "guest". */
export const STORES = {
  target: { name: "Target", url: "https://www.target.com/", signIn: "required" },
  walmart: { name: "Walmart", url: "https://www.walmart.com/", signIn: "required" },
  bestbuy: { name: "Best Buy", url: "https://www.bestbuy.com/", signIn: "guest" },
};
/** "Target", "target.com", "https://www.bestbuy.com/site/…" → its key; anything else → null (unknown: guest first). */
export function storeKey(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;
  let host = s;
  try { if (/^https?:\/\//.test(s)) host = new URL(s).hostname; } catch { /* not a url */ }
  host = host.replace(/^www\./, "");
  for (const [k, v] of Object.entries(STORES)) {
    if (host === k || host === new URL(v.url).hostname.replace(/^www\./, "") || s === v.name.toLowerCase()) return k;
  }
  return null;
}
export const storeName = (key) => STORES[key]?.name ?? String(key ?? "");

// ---------------------------------------------------------------- tables
db.db.exec(`
  CREATE TABLE IF NOT EXISTS shop_profiles (
    conversation_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shop_stores (
    conversation_id TEXT NOT NULL,
    store TEXT NOT NULL,
    status TEXT NOT NULL,
    connected_at INTEGER,
    removed_at INTEGER,
    last_used_at INTEGER,
    PRIMARY KEY (conversation_id, store)
  );
  CREATE TABLE IF NOT EXISTS shop_runs (
    run_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    store TEXT NOT NULL,
    item TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    last_request_id TEXT NOT NULL DEFAULT '',
    signed_in INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shop_runs_by_conv ON shop_runs (conversation_id, created_at);
  CREATE TABLE IF NOT EXISTS shop_links (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    store TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT '',
    request_json TEXT NOT NULL DEFAULT '',
    answered_keys TEXT NOT NULL DEFAULT '',
    answered_request_id TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shop_cards (
    conversation_id TEXT PRIMARY KEY,
    payment_method_id TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    last4 TEXT NOT NULL DEFAULT '',
    saved_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shop_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    amount_kind TEXT NOT NULL,
    merchant_name TEXT NOT NULL DEFAULT '',
    merchant_url TEXT NOT NULL DEFAULT '',
    merchant_country TEXT NOT NULL DEFAULT '',
    item TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    confirmation_id INTEGER,
    order_intent_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  );
`);
const q = (sql) => db.db.prepare(sql);

// ---------------------------------------------------------------- identity at Crossmint
/** The person's Crossmint user: a hash of their conversation. Never their number, never their name. */
export function crossmintUser(conversationId) {
  return `reason-${createHash("sha256").update(`crossmint:${conversationId}`).digest("hex").slice(0, 24)}`;
}
const b64url = (b) => Buffer.from(b).toString("base64url");
function signingKey() {
  const pem = process.env.CROSSMINT_JWT_PRIVATE_KEY
    || (process.env.CROSSMINT_JWT_KEY_FILE ? readFileSync(process.env.CROSSMINT_JWT_KEY_FILE, "utf8") : "");
  if (!pem) throw new Error("CROSSMINT_JWT_PRIVATE_KEY is not set");
  return createPrivateKey(pem.replace(/\\n/g, "\n"));
}
const JWT_ISS = () => process.env.CROSSMINT_JWT_ISSUER || "https://heyreason.com";
const JWT_KID = () => process.env.CROSSMINT_JWT_KID || "reason-1";
/**
 * The person's 30-minute JWT for Crossmint's client SDK (bring-your-own-auth, RS256, the issuer
 * registered in Crossmint's console). `sub` is crossmintUser, so the page can act only as them.
 */
export function mintJwt(conversationId, { ttlSec = 30 * 60 } = {}) {
  const now = Math.floor(clock.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid: JWT_KID(), typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: JWT_ISS(), sub: crossmintUser(conversationId), aud: "crossmint.com", iat: now, exp: now + ttlSec }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(signingKey());
  return `${head}.${body}.${b64url(sig)}`;
}
/** The public half, for the issuer's JWKS (served at /web/connect/jwks.json). */
export function jwks() {
  const jwk = createPublicKey(signingKey()).export({ format: "jwk" });
  return { keys: [{ ...jwk, kid: JWT_KID(), alg: "RS256", use: "sig" }] };
}

// ---------------------------------------------------------------- Crossmint API
const BASE = () => (process.env.CROSSMINT_API_BASE || "https://www.crossmint.com").replace(/\/+$/, "");
let fetcher = (...a) => fetch(...a);
/** Tests point this at a fake Crossmint. */
export function _setFetch(f) { fetcher = f ?? ((...a) => fetch(...a)); }
/** Server key, scoped to the person by x-crossmint-user-id (Crossmint: without it, users share a profile). */
async function server(conversationId, path, { method = "GET", body } = {}) {
  const key = process.env.CROSSMINT_SERVER_KEY;
  if (!key) throw new Error("CROSSMINT_SERVER_KEY is not set");
  const res = await fetcher(`${BASE()}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-API-KEY": key, "x-crossmint-user-id": crossmintUser(conversationId) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json };
}
/** Client key + the person's JWT: order intents and saved cards are the user's own, not the server's. */
async function asUser(conversationId, path, { method = "GET", body } = {}) {
  const key = process.env.CROSSMINT_CLIENT_KEY;
  if (!key) throw new Error("CROSSMINT_CLIENT_KEY is not set");
  const res = await fetcher(`${BASE()}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-API-KEY": key, Authorization: `Bearer ${mintJwt(conversationId, { ttlSec: 300 })}`, Origin: JWT_ISS() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json };
}
const CHECKOUTS = "/api/unstable/agent-checkouts";

// ---------------------------------------------------------------- the browser profile
export function profileOf(conversationId) {
  return q("SELECT profile_id FROM shop_profiles WHERE conversation_id = ?").get(conversationId)?.profile_id ?? null;
}
/** This person's one profile: the one on record, or a new one (or theirs at Crossmint, after a 409). */
export async function ensureProfile(conversationId) {
  const have = profileOf(conversationId);
  if (have) return have;
  let r = await server(conversationId, `${CHECKOUTS}/browser-profiles`, { method: "POST", body: { label: "Reason" } });
  let id = r.json?.id ?? null;
  if (r.status === 409) {
    r = await server(conversationId, `${CHECKOUTS}/browser-profiles`);
    const list = Array.isArray(r.json) ? r.json : r.json?.data ?? r.json?.items ?? [];
    id = list[0]?.id ?? null;
  }
  if (!id) throw new Error(`Could not get a browser profile (${r.status})`);
  q("INSERT OR IGNORE INTO shop_profiles (conversation_id, profile_id, created_at) VALUES (?, ?, ?)").run(conversationId, id, clock.now());
  return profileOf(conversationId);
}

// ---------------------------------------------------------------- remembered stores
export function storeRow(conversationId, store) {
  return q("SELECT * FROM shop_stores WHERE conversation_id = ? AND store = ?").get(conversationId, store) ?? null;
}
export const isConnected = (conversationId, store) => storeRow(conversationId, store)?.status === "connected";
export function connectedStores(conversationId) {
  return q("SELECT store, connected_at, last_used_at FROM shop_stores WHERE conversation_id = ? AND status = 'connected' ORDER BY connected_at").all(conversationId)
    .map((r) => ({ store: r.store, name: storeName(r.store), connectedAt: r.connected_at, lastUsedAt: r.last_used_at }));
}
export function markConnected(conversationId, store) {
  const now = clock.now();
  q(`INSERT INTO shop_stores (conversation_id, store, status, connected_at, last_used_at) VALUES (?, ?, 'connected', ?, ?)
     ON CONFLICT (conversation_id, store) DO UPDATE SET status = 'connected', connected_at = excluded.connected_at, removed_at = NULL`).run(conversationId, store, now, now);
}
/**
 * Settings → remove a store. Reason stops using that sign-in at once. When it was the last store, the
 * whole profile is deleted at Crossmint, which erases every saved sign-in it held.
 */
export async function removeStore(conversationId, store) {
  q("UPDATE shop_stores SET status = 'removed', removed_at = ? WHERE conversation_id = ? AND store = ?").run(clock.now(), conversationId, store);
  if (connectedStores(conversationId).length) return { ok: true, erased: false };
  return { ok: true, erased: await eraseProfile(conversationId) };
}
async function eraseProfile(conversationId) {
  const id = profileOf(conversationId);
  if (!id) return true;
  const r = await server(conversationId, `${CHECKOUTS}/browser-profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) return false;
  q("DELETE FROM shop_profiles WHERE conversation_id = ?").run(conversationId);
  return true;
}

/**
 * How a checkout at this store starts, for this person:
 *   guest   — the store allows it and nothing says otherwise (no profile, nothing of theirs attached)
 *   signed  — they connected this store: their profile, already signed in
 *   sign_in — the store needs an account they have not connected: their profile, signing in first,
 *             and the sign-in questions go to the link (asked once, by text)
 */
export function checkoutPlan(conversationId, store, { signIn = false } = {}) {
  if (store && isConnected(conversationId, store)) return "signed";
  if (signIn || STORES[store]?.signIn === "required") return "sign_in";
  return "guest";
}

const PAY_LINE = "Pay by card through Crossmint: when you reach payment, request payment approval from me and wait. Do not type any card number into the store yourself, never use a card saved at the store, and never place the order without my approval.";
export function taskFor(plan, store, what) {
  const name = storeName(store) || "the store";
  if (plan === "guest") return `${what} Check out as a guest. ${PAY_LINE}`;
  if (plan === "signed") return `${what} I'm already signed in to my ${name} account; if ${name} asks me to sign in again, ask me. ${PAY_LINE}`;
  return `Sign in to my ${name} account first: ask me for my email, password and any code ${name} sends. Then: ${what} ${PAY_LINE}`;
}

/** Starts a checkout. `maxUsd` is a cap Crossmint enforces, never a price anyone agreed to. */
/** `item` is what the ask names ("a 4-ft USB-C cable"); `what` is the full instruction for the agent. */
export async function startCheckout({ conversationId, store, startUrl, what, item = "", maxUsd, signIn = false }) {
  const plan = checkoutPlan(conversationId, store, { signIn });
  const body = {
    request: { startUrl, task: taskFor(plan, store, String(what ?? "").trim()) },
    constraints: { maxCost: { amount: Number(maxUsd).toFixed(2), currency: "USD" } },
  };
  if (plan !== "guest") body.browser = { profileId: await ensureProfile(conversationId) };
  const r = await server(conversationId, CHECKOUTS, { method: "POST", body });
  const runId = r.json?.runId ?? r.json?.id;
  if (!r.ok || !runId) return { ok: false, status: r.status, error: r.json?.message ?? r.json?.error ?? "Crossmint did not start the checkout." };
  const now = clock.now();
  q("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)")
    .run(runId, conversationId, store ?? "", String(item || "").trim().slice(0, 120), plan, now, now);
  if (plan === "signed") q("UPDATE shop_stores SET last_used_at = ? WHERE conversation_id = ? AND store = ?").run(now, conversationId, store);
  return { ok: true, runId, plan };
}
export const runRow = (runId) => q("SELECT * FROM shop_runs WHERE run_id = ?").get(runId) ?? null;

// ---------------------------------------------------------------- the sign-in link
export const LINK_TTL_MS = 30 * 60_000;
const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");
/** A new link; the token is returned once and only its hash is kept. */
export function createLink({ conversationId, kind, store = "", runId = "", request = null, ttlMs = LINK_TTL_MS }) {
  const token = randomBytes(24).toString("base64url");
  const now = clock.now();
  q(`INSERT INTO shop_links (id, conversation_id, kind, store, run_id, request_id, request_json, state, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(hashToken(token), conversationId, kind, store, runId, request?.requestId ?? "", request ? JSON.stringify(publicRequest(request)) : "", now, now + ttlMs);
  return token;
}
export function linkFor(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token ?? ""))) return null;
  return q("SELECT * FROM shop_links WHERE id = ?").get(hashToken(token)) ?? null;
}
const openSigninLink = (runId) => q("SELECT * FROM shop_links WHERE run_id = ? AND kind = 'signin' AND state = 'open' ORDER BY created_at DESC").get(runId) ?? null;

/** Only what the page may show: the question, the request id and the field descriptors. */
function publicRequest(rq) {
  return {
    requestId: rq.requestId,
    question: String(rq.request?.question ?? rq.question ?? ""),
    expiresAt: rq.request?.expiresAt ?? rq.expiresAt ?? null,
    // Only what draws the field: a value Crossmint prefilled (an email) is never kept.
    fields: ((rq.request?.interaction ?? rq.interaction)?.fields ?? []).map((f) => ({ key: f?.key, label: f?.label, handling: f?.handling, input: f?.input, ...(f?.required !== undefined ? { required: f.required } : {}) })),
  };
}
const isProtected = (f) => f?.handling === "protected";
const isCodeField = (f) => isProtected(f) && (f.input?.autoComplete === "one-time-code" || f.input?.inputMode === "numeric" || f.input?.kind === "integer" || f.input?.kind === "number");

/**
 * What the page shows for a link, decided here from the record (never from the page):
 *   signin  — the store's sign-in questions, never answered on this link
 *   code    — a new question whose secret field is a one-time code
 *   retry   — the same secret field asked again after it was answered (the store said no)
 *   checking — answered, waiting for the store
 *   connected · expired · failed
 */
export function linkView(link) {
  if (!link) return { state: "expired" };
  if (link.state === "connected") return { state: "connected", store: link.store, kind: link.kind };
  if (link.state === "failed") return { state: "failed", store: link.store, kind: link.kind };
  if (link.state !== "open" || clock.now() > link.expires_at) return { state: "expired", store: link.store, kind: link.kind };
  if (link.kind === "card") return { state: "card", kind: "card" };
  const rq = link.request_json ? JSON.parse(link.request_json) : null;
  if (!rq || link.answered_request_id === link.request_id) return { state: "checking", store: link.store, kind: link.kind };
  const answered = new Set(link.answered_keys ? link.answered_keys.split(",") : []);
  const secret = rq.fields.filter(isProtected);
  let state = "signin";
  if (secret.length && secret.every(isCodeField)) state = "code";
  else if (answered.size && secret.some((f) => answered.has(f.key))) state = "retry";
  return { state, store: link.store, kind: link.kind, request: rq };
}

/**
 * The page's answer, checked before it goes anywhere. A protected field must be exactly
 * `{ protectedInputId }`: a string there would be a typed secret, and is refused. Only keys the open
 * question asked for, every required one present. Returns { ok, answers } or { ok: false, error }.
 */
export function checkAnswers(rq, answers) {
  if (!rq || !answers || typeof answers !== "object" || Array.isArray(answers)) return { ok: false, error: "bad_answers" };
  const fields = new Map(rq.fields.map((f) => [f.key, f]));
  const out = {};
  for (const [k, v] of Object.entries(answers)) {
    const f = fields.get(k);
    if (!f) return { ok: false, error: "unknown_field" };
    if (isProtected(f)) {
      const keys = v && typeof v === "object" ? Object.keys(v) : [];
      if (keys.length !== 1 || keys[0] !== "protectedInputId" || typeof v.protectedInputId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(v.protectedInputId)) {
        return { ok: false, error: "protected_must_be_reference" };
      }
      out[k] = { protectedInputId: v.protectedInputId };
    } else {
      if (!["string", "number", "boolean"].includes(typeof v) || String(v).length > 500) return { ok: false, error: "bad_value" };
      out[k] = v;
    }
  }
  for (const f of rq.fields) if (f.required && !(f.key in out)) return { ok: false, error: "missing_field" };
  return { ok: true, answers: out };
}

/** POST the checked answer to Crossmint. The answer's values are never logged and never stored. */
export async function answerLink(token, { requestId, answers }) {
  const link = linkFor(token);
  const view = linkView(link);
  if (!["signin", "code", "retry"].includes(view.state)) return { ok: false, error: "not_open", state: view.state };
  if (requestId !== view.request.requestId) return { ok: false, error: "stale_request", state: view.state };
  const checked = checkAnswers(view.request, answers);
  if (!checked.ok) return checked;
  const part = { type: "input_response", requestId, action: "submit", response: { kind: "form", answers: checked.answers } };
  const r = await server(link.conversation_id, `${CHECKOUTS}/${encodeURIComponent(link.run_id)}/messages`, { method: "POST", body: { id: `msg_${randomUUID()}`, parts: [part] } });
  if (!r.ok) return { ok: false, error: "crossmint_refused", status: r.status };
  q("UPDATE shop_links SET answered_keys = ?, answered_request_id = ? WHERE id = ?").run(Object.keys(checked.answers).join(","), requestId, link.id);
  return { ok: true, state: "checking" };
}

// ---------------------------------------------------------------- the card
export function cardOf(conversationId) {
  const r = q("SELECT payment_method_id, brand, last4, saved_at FROM shop_cards WHERE conversation_id = ?").get(conversationId);
  return r ? { paymentMethodId: r.payment_method_id, brand: r.brand, last4: r.last4, savedAt: r.saved_at } : null;
}
/** Settings / "Add a card": a link to Crossmint's card form. Owner-only while the flag says so. */
export function cardLink(conversationId) {
  return createLink({ conversationId, kind: "card" });
}
/** The page saved a card at Crossmint; keep its id and display fields, and register it (best effort). */
export async function saveCard(token, { paymentMethodId, brand = "", last4 = "" }) {
  const link = linkFor(token);
  if (linkView(link).state !== "card") return { ok: false, error: "not_open" };
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(paymentMethodId ?? ""))) return { ok: false, error: "bad_id" };
  const l4 = /^\d{4}$/.test(String(last4)) ? String(last4) : "";
  q(`INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (conversation_id) DO UPDATE SET payment_method_id = excluded.payment_method_id, brand = excluded.brand, last4 = excluded.last4, saved_at = excluded.saved_at`)
    .run(link.conversation_id, paymentMethodId, String(brand).slice(0, 20), l4, clock.now());
  q("UPDATE shop_links SET state = 'connected' WHERE id = ?").run(link.id);
  // Registration provisions card-network rails; without one, Agent Checkouts uses the encrypted card.
  try { await asUser(link.conversation_id, `/api/2026-09-16/payment-methods/${encodeURIComponent(paymentMethodId)}/order-intent-registration`, { method: "PUT", body: { countryCode: "US", languageCode: "en-US" } }); } catch { /* best effort */ }
  return { ok: true };
}
export async function removeCard(conversationId) {
  const card = cardOf(conversationId);
  if (!card) return { ok: true };
  const r = await asUser(conversationId, `/api/2026-09-16/payment-methods/${encodeURIComponent(card.paymentMethodId)}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) return { ok: false, status: r.status };
  q("DELETE FROM shop_cards WHERE conversation_id = ?").run(conversationId);
  return { ok: true };
}

// ---------------------------------------------------------------- payment approval
export const paymentRow = (id) => q("SELECT * FROM shop_payments WHERE id = ?").get(id) ?? null;
export const openPayment = (conversationId) => q("SELECT * FROM shop_payments WHERE conversation_id = ? AND status = 'asked' ORDER BY id DESC").get(conversationId) ?? null;
/** "$9.79" for USD, "9.79 EUR" otherwise: Crossmint's string as given, never re-rounded. */
export const amountText = (row) => row.currency === "USD" ? `$${row.amount}` : `${row.amount} ${row.currency}`;
/** The ask, built from the row: Crossmint's amount, the store, what Reason set out to buy. */
export function paymentAsk(row) {
  const where = row.merchant_name || storeName(runRow(row.run_id)?.store) || "the store";
  const upTo = row.amount_kind === "exact" ? "" : "up to ";
  return `OK to pay ${upTo}${amountText(row)} at ${where}${row.item ? ` for ${row.item}` : ""}?`;
}
/** What a yes is pinned to (src/tools.js confirmTargetFor): the row, its run and request, and the amount. */
export function payTarget(row) {
  return row ? `shop:#${row.id} ${row.amount_kind} ${row.amount} ${row.currency} at ${row.merchant_name || "?"} [${row.run_id}/${row.request_id}]` : "";
}
/** A payment request from Crossmint: kept as given, once per request id. */
export function recordPayment({ conversationId, runId, request, item = "" }) {
  const it = request.request?.interaction ?? request.interaction ?? {};
  const amount = it.amount ?? {};
  if (it.kind !== "payment" || it.method !== "card" || !/^\d+(\.\d{1,4})?$/.test(String(amount.value ?? ""))) return null;
  q(`INSERT OR IGNORE INTO shop_payments (conversation_id, run_id, request_id, amount, currency, amount_kind, merchant_name, merchant_url, merchant_country, item, question, expires_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'asked', ?)`).run(
    conversationId, runId, request.requestId, String(amount.value), String(amount.currency ?? "USD").toUpperCase(), String(amount.kind ?? "exact"),
    String(it.merchant?.name ?? ""), String(it.merchant?.url ?? ""), String(it.merchant?.countryCode ?? ""), item,
    String(request.request?.question ?? request.question ?? ""), String(request.request?.expiresAt ?? request.expiresAt ?? ""), clock.now());
  return q("SELECT * FROM shop_payments WHERE request_id = ?").get(request.requestId);
}
/**
 * Pays an asked payment. Only ever called by the shop_pay tool AFTER the gate (src/trust.js) found a
 * granted yes whose target is payTarget(row): the order intent is for the row's amount, to the row's
 * merchant, from the person's own card, and answers that one request.
 */
export async function payApproved({ conversationId, paymentId, confirmationId }) {
  const row = paymentRow(paymentId);
  if (!row || row.conversation_id !== conversationId) return { ok: false, error: "no_such_payment" };
  if (row.status !== "asked") return { ok: false, error: `payment_${row.status}` };
  // Only Crossmint's exact total is ever paid: a "maximum" is a ceiling nobody agreed to as a price.
  if (row.amount_kind !== "exact") return { ok: false, error: "not_exact_amount" };
  // An expiry that doesn't read counts as passed.
  if (row.expires_at && !(Date.parse(row.expires_at) >= clock.now())) {
    q("UPDATE shop_payments SET status = 'expired' WHERE id = ?").run(row.id);
    return { ok: false, error: "payment_expired" };
  }
  const card = cardOf(conversationId);
  if (!card) return { ok: false, error: "no_card" };
  // Claimed before any call, so two shop_pay calls at once can't both pay it.
  if (q("UPDATE shop_payments SET status = 'paying' WHERE id = ? AND status = 'asked'").run(row.id).changes !== 1) return { ok: false, error: "payment_in_progress" };
  const reopen = () => q("UPDATE shop_payments SET status = 'asked' WHERE id = ? AND status = 'paying'").run(row.id);
  let oi;
  try {
    oi = await asUser(conversationId, "/api/unstable/order-intents", {
      method: "POST",
      body: {
        paymentMethodId: card.paymentMethodId,
        amount: { value: row.amount, currency: row.currency },
        merchant: { name: row.merchant_name, url: row.merchant_url, countryCode: row.merchant_country },
        description: (row.item || `${row.merchant_name} order`).slice(0, 120),
        expiresAt: new Date(clock.now() + 15 * 60_000).toISOString(),
      },
    });
  } catch { reopen(); return { ok: false, error: "order_intent_failed" }; }
  const orderIntentId = oi.json?.orderIntentId;
  // No order intent yet means nothing can be charged: the payment stays open for the same yes.
  if (!oi.ok || !orderIntentId) { reopen(); return { ok: false, error: "order_intent_failed", status: oi.status }; }
  const part = { type: "input_response", requestId: row.request_id, action: "submit", response: { kind: "payment", orderIntentId } };
  // From here the card may have been offered to the store: any failure is an unknown outcome, never a retry.
  const unknown = (status = null) => {
    q("UPDATE shop_payments SET status = 'unknown', confirmation_id = ?, order_intent_id = ?, answered_at = ? WHERE id = ?").run(confirmationId ?? null, orderIntentId, clock.now(), row.id);
    return { ok: false, error: "crossmint_refused", unknown_outcome: true, status };
  };
  let r;
  try { r = await server(conversationId, `${CHECKOUTS}/${encodeURIComponent(row.run_id)}/messages`, { method: "POST", body: { id: `msg_${randomUUID()}`, parts: [part] } }); } catch { return unknown(); }
  if (!r.ok) return unknown(r.status);
  q("UPDATE shop_payments SET status = 'paid', confirmation_id = ?, order_intent_id = ?, answered_at = ? WHERE id = ?").run(confirmationId ?? null, orderIntentId, clock.now(), row.id);
  return { ok: true, amount: amountText(row), merchant: row.merchant_name };
}
/** A no (or a change of mind): Crossmint is told to decline, nothing is charged. */
export async function declinePayment({ conversationId, paymentId }) {
  const row = paymentRow(paymentId);
  if (!row || row.conversation_id !== conversationId || row.status !== "asked") return { ok: false, error: "not_open" };
  const part = { type: "input_response", requestId: row.request_id, action: "decline" };
  await server(conversationId, `${CHECKOUTS}/${encodeURIComponent(row.run_id)}/messages`, { method: "POST", body: { id: `msg_${randomUUID()}`, parts: [part] } });
  q("UPDATE shop_payments SET status = 'declined', answered_at = ? WHERE id = ?").run(clock.now(), row.id);
  return { ok: true };
}

// ---------------------------------------------------------------- following a checkout
const TERMINAL = new Set(["succeeded", "failed", "blocked", "cancelled", "expired"]);
let sayFn = null;
// Web lives on the website (REASON_SITE_URL, heyreason.com): Crossmint's client key allows that origin only.
let linkBase = () => `${(process.env.REASON_SITE_URL || process.env.REASON_PUBLIC_URL || "https://heyreason.com").replace(/\/+$/, "")}/web/connect`;
/** serve.js hands over how to text a person. Nothing is texted before this. */
export function attach({ say, base } = {}) { sayFn = say ?? null; if (base) linkBase = () => base; }

/**
 * One look at a run: what changed, and what to text. Returns the text(s) sent, for the caller's log.
 * A sign-in question → the link (texted once per run; later questions land on the same page).
 * A card payment → the ask, from the row. Anything else is left to the model (`question`).
 */
export async function step(runId) {
  const run = runRow(runId);
  if (!run || TERMINAL.has(run.status)) return { done: true };
  const r = await server(run.conversation_id, `${CHECKOUTS}/${encodeURIComponent(runId)}`);
  if (!r.ok || !r.json) return { done: false };
  const cur = r.json;
  const status = String(cur.status ?? "");
  const said = [];
  const say = async (text) => { said.push(text); if (sayFn) await sayFn(run.conversation_id, text); };
  const ra = cur.requiredAction;
  const requestId = ra?.requestId ?? "";
  if (requestId && requestId !== run.last_request_id) {
    q("UPDATE shop_runs SET last_request_id = ?, updated_at = ? WHERE run_id = ?").run(requestId, clock.now(), runId);
    const rq = { requestId, request: ra.request };
    const it = ra.request?.interaction ?? {};
    const link = openSigninLink(runId);
    if (it.kind === "payment") {
      // Past the sign-in: the store let them in.
      if (link || run.mode === "sign_in") finishSignin(run, link);
      const row = recordPayment({ conversationId: run.conversation_id, runId, request: rq, item: run.item });
      if (row && row.amount_kind !== "exact") {
        // A ceiling, not a total: nothing to say yes to. Declined, so nothing is charged.
        await declinePayment({ conversationId: run.conversation_id, paymentId: row.id });
        await say(`${row.merchant_name || storeName(run.store) || "The store"} only gave me a ceiling (${amountText(row)}), not the real total, so I stopped before paying. Nothing was charged.`);
      } else if (row && it.method === "card") await say(paymentAsk(row));
    } else if (it.kind === "form" && (it.fields ?? []).some(isProtected)) {
      if (link) {
        q("UPDATE shop_links SET request_id = ?, request_json = ? WHERE id = ?").run(requestId, JSON.stringify(publicRequest(rq)), link.id);
      } else {
        const token = createLink({ conversationId: run.conversation_id, kind: "signin", store: run.store, runId, request: rq });
        const name = storeName(run.store) || "the store";
        await say(`${name} needs you signed in before it lets anyone check out. Sign in once here and I'll use it for ${name} orders from now on. Your password goes to Crossmint, not to me.\n${linkBase()}/${token}`);
      }
    }
  }
  if (TERMINAL.has(status)) {
    q("UPDATE shop_runs SET status = ?, result = ?, updated_at = ? WHERE run_id = ?").run(status, String(cur.result?.code ?? cur.result?.summary ?? "").slice(0, 300), clock.now(), runId);
    const link = openSigninLink(runId);
    if (status === "succeeded" && (link || run.mode === "sign_in")) finishSignin(run, link);
    else if (link) q("UPDATE shop_links SET state = 'failed' WHERE id = ?").run(link.id);
    q("UPDATE shop_payments SET status = 'expired' WHERE run_id = ? AND status = 'asked'").run(runId);
    return { done: true, status, said };
  }
  return { done: false, status, said };
}
function finishSignin(run, link) {
  if (run.store) markConnected(run.conversation_id, run.store);
  q("UPDATE shop_runs SET signed_in = 1 WHERE run_id = ?").run(run.run_id);
  if (link) q("UPDATE shop_links SET state = 'connected' WHERE id = ?").run(link.id);
}
/** Follows a run every few seconds until it ends. In-process; resumeFollowing picks runs up after a restart. */
export function follow(runId, { everyMs = 3000 } = {}) {
  const tick = async () => {
    let out = { done: false };
    try { out = await step(runId); } catch { /* next tick */ }
    if (!out.done) setTimeout(tick, everyMs).unref?.();
  };
  setTimeout(tick, 0).unref?.();
}
export function resumeFollowing() {
  for (const r of q("SELECT run_id FROM shop_runs WHERE status = 'running'").all()) follow(r.run_id);
}
