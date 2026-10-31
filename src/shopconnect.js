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
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { config, clock } from "./config.js";
import { isPrivateHost } from "./pictures.js";
import * as passkey from "./passkey.js";
import * as shipping from "./shipping.js";
import { zoneFor } from "./zone.js";

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
/**
 * Any store works. A store's key is its site's name (amazon.com → "amazon", shop.costco.com → "costco").
 * STORES are hints only: a nice display name, the site, and whether a guest checkout is known not to
 * exist ("required"). A store not listed checks out as a guest first; if it turns out to need an
 * account, that is remembered for the store (shop_sites.sign_in) and the person gets the sign-in link.
 */
export const STORES = {
  target: { name: "Target", url: "https://www.target.com/", signIn: "required" },
  walmart: { name: "Walmart", url: "https://www.walmart.com/", signIn: "required" },
  bestbuy: { name: "Best Buy", url: "https://www.bestbuy.com/", signIn: "guest" },
  amazon: { name: "Amazon", url: "https://www.amazon.com/", signIn: "required" },
  costco: { name: "Costco", url: "https://www.costco.com/", signIn: "required" },
  cvs: { name: "CVS", url: "https://www.cvs.com/" },
  walgreens: { name: "Walgreens", url: "https://www.walgreens.com/" },
  homedepot: { name: "Home Depot", url: "https://www.homedepot.com/" },
  sephora: { name: "Sephora", url: "https://www.sephora.com/" },
  ulta: { name: "Ulta", url: "https://www.ulta.com/" },
  nike: { name: "Nike", url: "https://www.nike.com/" },
  apple: { name: "Apple", url: "https://www.apple.com/" },
};
const hostOf = (s) => {
  const t = String(s ?? "").trim().toLowerCase();
  let host = t;
  try { if (/^https?:\/\//.test(t)) host = new URL(t).hostname; } catch { return ""; }
  host = host.replace(/^www\d?\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && /[a-z]/.test(host.split(".").pop()) ? host : "";
};
/** amazon.com → amazon, shop.costco.com → costco, argos.co.uk → argos, boots.com.au → boots. */
export function siteKey(host) {
  const parts = String(host ?? "").split(".").filter(Boolean);
  if (parts.length < 2) return "";
  const two = parts.slice(-2).join(".");
  const label = parts.length >= 3 && /^(co|com|org|net|ac|gov|ne|or)\.[a-z]{2}$/.test(two) ? parts.at(-3) : parts.at(-2);
  return label.replace(/[^a-z0-9]/g, "");
}
const slug = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "").slice(0, 40);
/** "Target", "target.com", "https://www.amazon.com/dp/…", "sephora.com" → its key; a bare unknown name → null. */
export function storeKey(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;
  const host = hostOf(s);
  for (const [k, v] of Object.entries(STORES)) {
    if (s === k || s === v.name.toLowerCase() || slug(s) === k || (host && host === new URL(v.url).hostname.replace(/^www\./, ""))) return k;
  }
  if (!host) return null;
  const key = siteKey(host);
  // A lookalike (target.co, amazon-deals.net's "amazon") never borrows a known store's name: it is its own store.
  const real = STORES[key] && new URL(STORES[key].url).hostname.replace(/^www\./, "");
  if (real && host !== real && !host.endsWith(`.${real}`)) return slug(host) || null;
  return key || null;
}
/** The key for a checkout: the store's name if it is known, else the site the checkout starts on, else the name. */
export function checkoutStoreKey(store, startUrl) {
  const bySite = storeKey(startUrl), byName = storeKey(store);
  // The site the checkout runs on is the truth: "Target" on target.co is target.co.
  return bySite ?? byName ?? (slug(store) || null);
}
const titleCase = (k) => String(k ?? "").replace(/^./, (c) => c.toUpperCase());
export const storeName = (key) => (key ? STORES[key]?.name ?? (siteRow(key)?.name || titleCase(key)) : "");
/** "required" when this store is known (or was found) to have no guest checkout. */
export const storeSignIn = (key) => STORES[key]?.signIn ?? (siteRow(key)?.sign_in || "");
export const storeHost = (key) => (STORES[key] ? new URL(STORES[key].url).hostname : siteRow(key)?.host || "");

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
  CREATE TABLE IF NOT EXISTS shop_sites (
    store TEXT PRIMARY KEY,
    host TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    sign_in TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    icon_checked_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS shop_run_asks (
    run_id TEXT PRIMARY KEY,
    start_url TEXT NOT NULL,
    what TEXT NOT NULL,
    max_usd REAL NOT NULL,
    retried INTEGER NOT NULL DEFAULT 0
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
// The checkout job (2026-10-31, after the 10:58 CeraVe run): a run is a persistent job with a stage,
// kept moving by code across turns and restarts. A table already on live never gets a column from
// CREATE TABLE IF NOT EXISTS, so each one is added here.
function addRunColumn(column, decl) {
  const have = db.db.prepare("SELECT name FROM pragma_table_info('shop_runs')").all().map((r) => r.name);
  if (!have.includes(column)) db.db.exec(`ALTER TABLE shop_runs ADD COLUMN ${column} ${decl}`);
}
// A saved card's order-intent registration (2026-10-31, 16:23 UTC): the owner's Face ID approval
// failed with order_intent_failed because his card had never been registered — the PUT at save time
// was "best effort" with an empty catch, and Crossmint had refused it (400 CONSUMER_EMAIL_REQUIRED:
// the body needs the person's email). `registered` is NULL until known, 1 when Crossmint has the
// registration, 0 when it refused (`reg_error` says why, a code, never a value).
function addCardColumn(column, decl) {
  const have = db.db.prepare("SELECT name FROM pragma_table_info('shop_cards')").all().map((r) => r.name);
  if (!have.includes(column)) db.db.exec(`ALTER TABLE shop_cards ADD COLUMN ${column} ${decl}`);
}
addCardColumn("registered", "INTEGER");
addCardColumn("reg_error", "TEXT NOT NULL DEFAULT ''");
addCardColumn("asked_email", "INTEGER NOT NULL DEFAULT 0");
// When the page answered a sign-in link (2026-10-31: the page needs to know how long the store has been
// checking, from the record, so a reopened page says the right thing at once).
function addLinkColumn(column, decl) {
  const have = db.db.prepare("SELECT name FROM pragma_table_info('shop_links')").all().map((r) => r.name);
  if (!have.includes(column)) db.db.exec(`ALTER TABLE shop_links ADD COLUMN ${column} ${decl}`);
}
addLinkColumn("answered_at", "INTEGER");
addRunColumn("stage", "TEXT NOT NULL DEFAULT ''");
addRunColumn("stage_at", "INTEGER");
addRunColumn("revision", "INTEGER NOT NULL DEFAULT 0");
addRunColumn("progress_at", "INTEGER");
addRunColumn("told", "TEXT NOT NULL DEFAULT ''");
addRunColumn("question", "TEXT NOT NULL DEFAULT ''");
addRunColumn("request_json", "TEXT NOT NULL DEFAULT ''");
addRunColumn("paid_at", "INTEGER");
addRunColumn("order_ref", "TEXT NOT NULL DEFAULT ''");
addRunColumn("mail_until", "INTEGER");
addRunColumn("mail_checked_at", "INTEGER");
addRunColumn("mail_seen", "TEXT NOT NULL DEFAULT ''");
addRunColumn("last_ok_at", "INTEGER");
function siteRow(key) { return q("SELECT * FROM shop_sites WHERE store = ?").get(key) ?? null; }
/** What Reason learned about a store it was asked to shop at: its site and the name it was called by. */
export function noteStore({ store, name = "", url = "" }) {
  if (!store) return;
  const host = STORES[store] ? "" : hostOf(url);
  const nice = STORES[store] || hostOf(name) ? "" : String(name ?? "").trim().slice(0, 60);
  q(`INSERT INTO shop_sites (store, host, name) VALUES (?, ?, ?)
     ON CONFLICT (store) DO UPDATE SET host = CASE WHEN excluded.host != '' THEN excluded.host ELSE host END,
       name = CASE WHEN name = '' THEN excluded.name ELSE name END`).run(store, host, nice);
}

// ---------------------------------------------------------------- store icons
// The store's own icon, fetched from its site once and kept as a data: URL, so the page never shows
// a broken image and never makes the person's browser call the store. Nothing usable → "" (a monogram).
const ICON_MAX = 200_000;
const ICON_RETRY_MS = 24 * 3600_000;
// Never the real network under node --test unless a test hands in its own fake.
// The real one connects only to the addresses fetchPublic checked (pinnedGet); plain fetch would resolve the name again.
const realFetch = (url, init) => (process.env.NODE_TEST_CONTEXT ? Promise.reject(new Error("no network in tests")) : pinnedGet(url, init));
const realLookup = (host) => (process.env.NODE_TEST_CONTEXT ? Promise.reject(new Error("no DNS in tests")) : lookup(host, { all: true, verbatim: true }));
let iconFetch = realFetch;
let iconLookup = realLookup;
/** Tests hand in a fake web and, with it, a fake DNS (`host → [{ address }]`). */
export function _setIconFetch(f, l) { iconFetch = f ?? realFetch; iconLookup = l ?? realLookup; }
const PRIVATE_HOST = /(^|\.)(localhost|local|internal|lan|home|arpa|ts\.net|test|invalid)$/;
// The host comes from a checkout's URL, so this server is fetching a name somebody else chose. The name
// alone proves nothing (pinkfrog.example can point at 127.0.0.1 or 169.254.169.254), so every hop is
// resolved first and refused unless ALL its addresses are public (src/pictures.js isPrivateHost: loopback,
// 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, ::1, fc00::/7, fe80::/10, v4-mapped).
//
// And the fetch connects to THOSE addresses, not to whatever the name resolves to a moment later
// (2026-10-31, before opening checkouts to everyone): a name that answered a public address to the
// check and a private one to the connect — DNS rebinding — got through the check and reached the
// private one. So the checked addresses ride with the request as its `lookup` (pinnedGet below), and
// a name is never resolved twice for one hop. Every hop of a redirect is resolved, checked and pinned
// on its own.
async function publicAddresses(hostname, signal) {
  const h = hostname.replace(/^\[|\]$/g, "");
  if (isIP(h)) return isPrivateHost(h) ? null : [{ address: h, family: isIP(h) }];
  // The lookup rides the same 4s budget as the fetch: an abort mid-lookup refuses the host.
  const aborted = new Promise((resolve) => { if (signal?.aborted) resolve([]); signal?.addEventListener?.("abort", () => resolve([]), { once: true }); });
  const addrs = await Promise.race([iconLookup(h).catch(() => []), aborted]);
  if (!(addrs.length > 0 && addrs.every((a) => isIP(a?.address) && !isPrivateHost(a.address)))) return null;
  return addrs.map((a) => ({ address: a.address, family: a.family || isIP(a.address) }));
}
/** dns.lookup's shape, answering from the addresses already checked, whatever the name says now. */
export function _pinnedLookup(addresses) {
  const list = addresses.map((a) => ({ address: a.address, family: Number(a.family) || isIP(a.address) || 4 }));
  return (hostname, options, cb) => {
    if (typeof options === "function") { cb = options; options = {}; }
    if (options?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  };
}
/** One https GET to a pinned address: redirects are not followed here (fetchPublic re-checks each hop). */
function pinnedGet(url, { headers, signal, addresses }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest(u, { method: "GET", headers, signal, lookup: _pinnedLookup(addresses), servername: u.hostname }, (res) => {
      const h = {}; for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") h[k] = v;
      // A status that carries no body (204/205/304) is a Response with none — the constructor refuses a stream there.
      const bodiless = [204, 205, 304].includes(res.statusCode);
      if (bodiless) res.resume();
      try { resolve(new Response(bodiless ? null : Readable.toWeb(res), { status: res.statusCode, headers: h })); } catch (e) { res.destroy(); reject(e); }
    });
    req.on("error", reject);
    req.end();
  });
}
async function fetchPublic(url, { accept, signal }) {
  for (let hop = 0; hop < 4; hop++) {
    let u; try { u = new URL(url); } catch { return null; }
    if (u.protocol !== "https:" || (u.port && u.port !== "443") || u.username || u.password) return null;
    if (!hostOf(u.hostname) || PRIVATE_HOST.test(u.hostname)) return null;
    const addresses = await publicAddresses(u.hostname, signal);
    if (!addresses) return null;
    const res = await iconFetch(u.href, { redirect: "manual", signal, addresses, headers: { Accept: accept, "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" } });
    // A redirect's body is let go before the next hop, so its socket does not sit open until the abort.
    if (res.status >= 300 && res.status < 400 && res.headers?.get?.("location")) { res.body?.cancel?.()?.catch?.(() => {}); url = new URL(res.headers.get("location"), u).href; continue; }
    if (!res.ok) res.body?.cancel?.()?.catch?.(() => {});
    return res.ok ? res : null;
  }
  return null;
}
/** The body, read no further than `max` bytes. */
async function capped(res, max) {
  if (!res.body?.getReader) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const reader = res.body.getReader(); const parts = []; let n = 0;
  while (n < max) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
  reader.cancel().catch(() => {});
  return Buffer.concat(parts).subarray(0, max);
}
async function iconAt(url, signal) {
  const res = await fetchPublic(url, { accept: "image/*", signal }).catch(() => null);
  const type = String(res?.headers?.get?.("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!res || !/^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|webp|gif)$/.test(type)) return "";
  if (Number(res.headers?.get?.("content-length") ?? 0) > ICON_MAX) return "";
  const buf = await capped(res, ICON_MAX + 1);
  return buf.length >= 64 && buf.length <= ICON_MAX ? `data:${type};base64,${buf.toString("base64")}` : "";
}
/** The cached icon for a store, or "" (draw a monogram). */
export const storeIcon = (key) => (key ? siteRow(key)?.icon || "" : "");
/**
 * Looks for the store's icon (its page's apple-touch-icon / icon links, then the usual paths) at most
 * once a day, within `ms`. Never throws.
 */
export async function ensureIcon(key, { ms = 4000 } = {}) {
  try {
    const host = storeHost(key);
    if (!host) return "";
    const row = siteRow(key);
    if (row?.icon || (row && clock.now() - row.icon_checked_at < ICON_RETRY_MS)) return row?.icon || "";
    q("INSERT INTO shop_sites (store, host, icon_checked_at) VALUES (?, ?, ?) ON CONFLICT (store) DO UPDATE SET icon_checked_at = excluded.icon_checked_at").run(key, STORES[key] ? "" : host, clock.now());
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms); timer.unref?.();
    try {
      const base = `https://${host}/`;
      const found = [];
      const page = await fetchPublic(base, { accept: "text/html", signal: ctl.signal }).catch(() => null);
      if (page) {
        const html = (await capped(page, 300_000)).toString("utf8");
        for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
          const tag = m[0], rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "", href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
          if (!href || !/\bicon\b|apple-touch-icon/.test(rel)) continue;
          try { found.push({ url: new URL(href.replace(/&amp;/g, "&"), page.url || base).href, rank: /apple-touch/.test(rel) ? 0 : /\.svg/i.test(href) ? 1 : 2 }); } catch { /* bad href */ }
        }
      }
      const tries = [...found.sort((a, b) => a.rank - b.rank).map((f) => f.url), `${base}apple-touch-icon.png`, `${base}favicon.ico`];
      for (const url of [...new Set(tries)].slice(0, 6)) {
        const icon = await iconAt(url, ctl.signal);
        if (icon) { q("UPDATE shop_sites SET icon = ? WHERE store = ?").run(icon, key); return icon; }
      }
    } finally { clearTimeout(timer); }
  } catch { /* a monogram, then */ }
  return "";
}

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
  if (signIn || storeSignIn(store) === "required") return "sign_in";
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
  // The address on record goes into the instruction where it says to ship (2026-10-31): a checkout that
  // already has it rarely asks the form at all, and one that does is answered from the same record.
  let instruction = String(what ?? "").trim();
  try { instruction = shipping.withAddress(instruction, shipping.profileFor(conversationId)); } catch { /* as written */ }
  const body = {
    request: { startUrl, task: taskFor(plan, store, instruction) },
    constraints: { maxCost: { amount: Number(maxUsd).toFixed(2), currency: "USD" } },
  };
  if (plan !== "guest") body.browser = { profileId: await ensureProfile(conversationId) };
  const r = await server(conversationId, CHECKOUTS, { method: "POST", body });
  const runId = r.json?.runId ?? r.json?.id;
  if (!r.ok || !runId) return { ok: false, status: r.status, error: r.json?.message ?? r.json?.error ?? "Crossmint did not start the checkout." };
  const now = clock.now();
  q("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at, stage, stage_at, progress_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, 'started', ?, ?)")
    .run(runId, conversationId, store ?? "", String(item || "").trim().slice(0, 120), plan, now, now, now, now);
  q("INSERT OR REPLACE INTO shop_run_asks (run_id, start_url, what, max_usd) VALUES (?, ?, ?, ?)").run(runId, String(startUrl ?? ""), instruction, Number(maxUsd));
  if (plan === "signed") q("UPDATE shop_stores SET last_used_at = ? WHERE conversation_id = ? AND store = ?").run(now, conversationId, store);
  // A run still open for the same thing is over now, quietly (owner 2026-10-31: the Amazon run was
  // left running after the Walmart one started, and texted "stopped… want me to start it again?" ten
  // minutes later). Crossmint is told to cancel, its payment if any is declined, and nothing is said:
  // the new run is the one that gets talked about.
  const superseded = [];
  for (const old of q("SELECT * FROM shop_runs WHERE conversation_id = ? AND status = 'running' AND run_id <> ?").all(conversationId, runId)) {
    // Ended: a run for the same thing, or one already marked superseded (correctAndRestart marks the
    // old run before starting this one, whatever its item reads). Any other open run is left alone.
    if (!sameItem(old.item, item) && !toldOf(old).has("superseded")) continue;
    await endQuietly(old, `superseded by ${runId}`);
    superseded.push(old.run_id);
  }
  return { ok: true, runId, plan, ...(superseded.length ? { superseded } : {}) };
}
export const runRow = (runId) => q("SELECT * FROM shop_runs WHERE run_id = ?").get(runId) ?? null;
const ITEM_STOP = new Set(["the", "and", "for", "with", "from", "new", "one", "pack", "oz", "fl", "ml", "ct", "count"]);
const itemWords = (s) => new Set((String(s ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !ITEM_STOP.has(w) && !/^\d+$/.test(w)));
/** The same thing to buy, as two runs' items name it: most of the shorter one's words are in the other. */
export function sameItem(a, b) {
  const wa = itemWords(a), wb = itemWords(b);
  if (!wa.size || !wb.size) return false;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  let hit = 0;
  for (const w of small) if (big.has(w)) hit++;
  // Four words in five: "CeraVe Hydrating Facial Cleanser" is not "CeraVe Foaming Facial Cleanser" (three in four).
  return hit / small.size >= 0.8;
}
/** Does a message of theirs name the item: two of its words (one, for a one-word item). Looser than sameItem: "the cerave cleanser" is about it. */
export function mentionsItem(text, item) {
  const words = itemWords(item), said = itemWords(text);
  if (!words.size) return false;
  let hit = 0;
  for (const w of words) if (said.has(w)) hit++;
  return hit >= Math.min(2, words.size);
}
/** Crossmint is asked to cancel a run (202; 409 once it is over). Best effort: the row is the record either way. */
export async function cancelAtCrossmint(run) {
  try { const r = await server(run.conversation_id, `${CHECKOUTS}/${encodeURIComponent(run.run_id)}/cancel`, { method: "POST", body: {} }); return r.ok; } catch { return false; }
}
/** A run ended by Reason without a word to the person: cancelled at Crossmint, its open payment declined, told as said. */
async function endQuietly(run, result) {
  tellOnce(run.run_id, "superseded"); tellOnce(run.run_id, "end");
  const open = q("SELECT id FROM shop_payments WHERE run_id = ? AND status = 'asked'").get(run.run_id);
  if (open) { try { await declinePayment({ conversationId: run.conversation_id, paymentId: open.id }); } catch { /* it expires on its own */ } }
  if (runRow(run.run_id)?.status === "running") await cancelAtCrossmint(run);
  const now = clock.now();
  q("UPDATE shop_runs SET status = 'cancelled', stage = 'cancelled', stage_at = ?, updated_at = ?, progress_at = ?, result = ? WHERE run_id = ? AND status = 'running'").run(now, now, now, String(result).slice(0, 300), run.run_id);
  const link = openSigninLink(run.run_id);
  if (link) q("UPDATE shop_links SET state = 'failed' WHERE id = ?").run(link.id);
}

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
    kind: String((rq.request?.interaction ?? rq.interaction)?.kind ?? "form"),
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
 *   signin    — the store's sign-in questions, never answered on this link (`again`: the store was
 *               connected and signed them out, so this checkout ran signed in and was asked again)
 *   code      — a new question whose secret field is a one-time code
 *   wrongcode — a code asked for again after a code was answered (the store didn't take it)
 *   retry     — the same secret field asked again after it was answered (the store said no)
 *   checking  — answered, waiting for the store
 *   connected · expired · failed
 * `answered` says something was already answered on this link (a password, before a code);
 * `item` is what the checkout set out to buy, for the signed-out screen.
 */
export function linkView(link) {
  if (!link) return { state: "expired" };
  if (link.state === "connected") return { state: "connected", store: link.store, kind: link.kind };
  const run = link.run_id ? runRow(link.run_id) : null;
  if (link.state === "failed") return { state: "failed", store: link.store, kind: link.kind, reason: failReason(run) };
  // The checkout itself is over while the link still says open (the run died between two polls, or the
  // process was down when it did — 2026-10-31): the page says so, never "checking" for good.
  if (run && TERMINAL.has(run.status) && link.kind === "signin" && link.state === "open") {
    return run.status === "succeeded" ? { state: "connected", store: link.store, kind: link.kind } : { state: "failed", store: link.store, kind: link.kind, reason: failReason(run) };
  }
  if (link.state !== "open" || clock.now() > link.expires_at) return { state: "expired", store: link.store, kind: link.kind };
  if (link.kind === "card") return { state: "card", kind: "card" };
  const rq = link.request_json ? JSON.parse(link.request_json) : null;
  if (!rq || link.answered_request_id === link.request_id) {
    // Waiting on the store: since when (the answer, else the link), and how far the checkout has got.
    const since = link.answered_at ?? link.created_at;
    return { state: "checking", store: link.store, kind: link.kind, since, waited: Math.max(0, clock.now() - since), stage: run?.stage || "", answered: !!link.answered_at };
  }
  const answered = new Set(link.answered_keys ? link.answered_keys.split(",") : []);
  const secret = rq.fields.filter(isProtected);
  const again = secret.some((f) => answered.has(f.key));
  let state = "signin";
  if (secret.length && secret.every(isCodeField)) state = again ? "wrongcode" : "code";
  else if (again) state = "retry";
  return {
    state, store: link.store, kind: link.kind, request: rq, answered: answered.size > 0,
    ...(state === "signin" && run?.mode === "signed" ? { again: true, item: run.item || "" } : {}),
  };
}

/**
 * Why a sign-in link's checkout ended without the store letting them in, for the page's end screen:
 * "timeout" (the store or Crossmint was waiting and gave up), "lost" (Crossmint stopped answering),
 * "stopped" (the store or Crossmint ended it), "replaced" (Reason started the checkout over, so the
 * link is out of date: never the store's doing), "" when the run isn't known.
 */
export function failReason(run) {
  if (!run) return "";
  const r = String(run.result ?? "").toLowerCase();
  if (run.status === "cancelled" || /superseded|started again/.test(r)) return "replaced";
  if (/input_expired|expired|timed? ?out/.test(r)) return "timeout";
  if (/^lost\b/.test(r)) return "lost";
  return "stopped";
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
  if (!["signin", "code", "wrongcode", "retry"].includes(view.state)) return { ok: false, error: "not_open", state: view.state };
  if (requestId !== view.request.requestId) return { ok: false, error: "stale_request", state: view.state };
  const checked = checkAnswers(view.request, answers);
  if (!checked.ok) return checked;
  const part = { type: "input_response", requestId, action: "submit", response: { kind: "form", answers: checked.answers } };
  const r = await server(link.conversation_id, `${CHECKOUTS}/${encodeURIComponent(link.run_id)}/messages`, { method: "POST", body: { id: `msg_${randomUUID()}`, parts: [part] } });
  if (!r.ok) return { ok: false, error: "crossmint_refused", status: r.status };
  q("UPDATE shop_links SET answered_keys = ?, answered_request_id = ?, answered_at = ? WHERE id = ?").run(Object.keys(checked.answers).join(","), requestId, clock.now(), link.id);
  q("UPDATE shop_runs SET stage = 'in_progress', stage_at = ?, progress_at = ?, updated_at = ? WHERE run_id = ? AND stage = 'needs_input'").run(clock.now(), clock.now(), clock.now(), link.run_id);
  return { ok: true, state: "checking", waited: 0 };
}

// ---------------------------------------------------------------- the card
export function cardOf(conversationId) {
  const r = q("SELECT payment_method_id, brand, last4, saved_at, registered, reg_error FROM shop_cards WHERE conversation_id = ?").get(conversationId);
  return r ? { paymentMethodId: r.payment_method_id, brand: r.brand, last4: r.last4, savedAt: r.saved_at, registered: r.registered ?? null, regError: r.reg_error || "" } : null;
}
// ---------------------------------------------------------------- the card's registration
const REG_PATH = (id) => `/api/2026-09-16/payment-methods/${encodeURIComponent(id)}/order-intent-registration`;
const EMAIL_REQUIRED = "CONSUMER_EMAIL_REQUIRED";
/** True for Crossmint's "no registration for this card" refusal of an order intent, in any of its spellings. */
const noRegistration = (code) => /REGISTRATION_NOT_FOUND|ORDER_INTENT_REGISTRATION/i.test(String(code ?? ""));
/** "Card ••••1929", or "Your card" when the last four are not on record. */
const cardName = (card) => (card?.last4 ? `Card ••••${card.last4}` : "Your card");
/**
 * The email the card's receipts go to, by the owner's rule (2026-10-31): the one on their record, or
 * exactly one known anywhere (used, and announced by the caller), or none / two or more (their
 * decision, asked with what is on record and why). { email, inferred, choices }. Never logged.
 */
function receiptEmail(conversationId) {
  // Decided only when they gave it (said, typed in a form, corrected). An email gather() wrote from
  // their Gmail or a fact is a guess like any other: with a second one around, it is their choice.
  const row = shipping.profileRow(conversationId);
  const record = shipping.normalize("email", row?.email);
  if (record && shipping.emailDecided(row)) return { email: record, inferred: false, choices: [record] };
  let choices = [];
  try { choices = shipping.knownEmails(conversationId); } catch { choices = []; }
  if (choices.length === 1) {
    shipping.learn(conversationId, { email: choices[0] }, { source: "record" });
    return { email: choices[0], inferred: true, choices };
  }
  return { email: "", inferred: false, choices };
}
/** The ask for the email, with why and what is on record: none → why; two or more → which one. */
export function emailAsk(card, choices, { atPay = false } = {}) {
  const lead = atPay ? `Face ID worked, but ${cardName(card).replace(/^Card/, "card").replace(/^Your card/, "your card")} can't pay yet` : `${cardName(card)} is saved, but it can't pay`;
  const then = atPay ? " Tell me here, then tap the link again." : "";
  if (choices.length >= 2) return `${lead}: I need an email for its receipts, and I have ${choices.slice(0, -1).join(", ")} and ${choices[choices.length - 1]} on record. Which one?${then}`;
  return `${lead} until I have an email for its receipts. Which one should I use?${then}`;
}
/**
 * Registers the saved card for order intents, with the person's email — Crossmint refuses the
 * registration without one, and an unregistered card cannot pay (order_intent_failed). The row keeps
 * the outcome: registered 1, or 0 with the code.
 * { ok, email, inferred } | { ok: false, error: "email_required" | "crossmint_refused" | "crossmint_unreachable", status, code, choices }.
 * With `tell`, the person hears once what is needed (the ask names what is on record and why); the
 * outcome line ("set up to pay") is the caller's, so each moment is one text.
 */
export async function registerCard(conversationId, { tell = true } = {}) {
  const card = cardOf(conversationId);
  if (!card) return { ok: false, error: "no_card" };
  const mark = (registered, code = "") => q("UPDATE shop_cards SET registered = ?, reg_error = ? WHERE conversation_id = ?").run(registered, code, conversationId);
  const askEmail = async (choices) => {
    if (!tell || q("UPDATE shop_cards SET asked_email = 1 WHERE conversation_id = ? AND asked_email = 0").run(conversationId).changes !== 1) return;
    await notify(conversationId, emailAsk(card, choices));
  };
  const { email, inferred, choices } = receiptEmail(conversationId);
  if (!email) {
    mark(0, EMAIL_REQUIRED);
    logFn({ card_registration: "skipped", code: EMAIL_REQUIRED, known_emails: choices.length });
    await askEmail(choices);
    return { ok: false, error: "email_required", code: EMAIL_REQUIRED, choices };
  }
  let r;
  try { r = await asUser(conversationId, REG_PATH(card.paymentMethodId), { method: "PUT", body: { countryCode: "US", languageCode: "en-US", email } }); }
  catch (e) { logFn({ card_registration: "error", detail: short(e?.message ?? e, 60) }); return { ok: false, error: "crossmint_unreachable", detail: short(e?.message ?? e, 60), choices }; }
  if (r.ok) { mark(1, ""); q("UPDATE shop_cards SET asked_email = 0 WHERE conversation_id = ?").run(conversationId); logFn({ card_registration: "ok", status: r.status, inferred_email: inferred }); return { ok: true, email, inferred }; }
  const code = crossmintError(r.json);
  mark(0, code);
  logFn({ card_registration: "refused", status: r.status, code });
  if (code === EMAIL_REQUIRED) await askEmail(choices);
  return { ok: false, error: code === EMAIL_REQUIRED ? "email_required" : "crossmint_refused", status: r.status, code, choices };
}
/** They said which email receipts go to: kept on their record, and the card registered with it. */
export async function setReceiptEmail(conversationId, email) {
  if (!shipping.normalize("email", email)) return { ok: false, error: "bad_email" };
  shipping.learn(conversationId, { email }, { source: "said" });
  return cardOf(conversationId) ? registerCard(conversationId, { tell: false }) : { ok: true, no_card: true };
}
/**
 * After a restart: every saved card whose registration is unknown (saved before 2026-10-31, or never
 * checked) is read back from Crossmint once, and the row says what it found. Nothing is registered
 * here — that happens when the card is saved, or before it pays.
 */
export async function sweepCards() {
  const rows = q("SELECT conversation_id, payment_method_id FROM shop_cards WHERE registered IS NULL").all();
  const out = { checked: rows.length, registered: 0, missing: 0, unknown: 0 };
  for (const row of rows) {
    let r = null;
    try { r = await asUser(row.conversation_id, REG_PATH(row.payment_method_id)); } catch { /* unknown stays unknown */ }
    if (r?.ok) { q("UPDATE shop_cards SET registered = 1, reg_error = '' WHERE conversation_id = ?").run(row.conversation_id); out.registered++; }
    else if (r?.status === 404) { q("UPDATE shop_cards SET registered = 0, reg_error = ? WHERE conversation_id = ?").run(crossmintError(r.json) || "NOT_FOUND", row.conversation_id); out.missing++; }
    else out.unknown++;
  }
  if (rows.length) logFn({ card_registrations_swept: out });
  return out;
}
/** Settings / "Add a card": a link to Crossmint's card form. Owner-only while the flag says so. */
export function cardLink(conversationId) {
  return createLink({ conversationId, kind: "card" });
}
/**
 * The page saved a card at Crossmint; keep its id and display fields, and register it for order
 * intents with the person's email. The card row stays either way; `registered` says whether it can
 * pay yet, and the person hears once when their email is what it lacks.
 */
export async function saveCard(token, { paymentMethodId, brand = "", last4 = "" }) {
  const link = linkFor(token);
  if (linkView(link).state !== "card") return { ok: false, error: "not_open" };
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(paymentMethodId ?? ""))) return { ok: false, error: "bad_id" };
  const l4 = /^\d{4}$/.test(String(last4)) ? String(last4) : "";
  q(`INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered, reg_error, asked_email) VALUES (?, ?, ?, ?, ?, NULL, '', 0)
     ON CONFLICT (conversation_id) DO UPDATE SET payment_method_id = excluded.payment_method_id, brand = excluded.brand, last4 = excluded.last4, saved_at = excluded.saved_at, registered = NULL, reg_error = '', asked_email = 0`)
    .run(link.conversation_id, paymentMethodId, String(brand).slice(0, 20), l4, clock.now());
  q("UPDATE shop_links SET state = 'connected' WHERE id = ?").run(link.id);
  const card = cardOf(link.conversation_id);
  const reg = await registerCard(link.conversation_id);
  // Set up at save time, and said only when it is: one line, naming the email when it was Reason's pick.
  if (reg.ok) await notify(link.conversation_id, `${cardName(card)} is set up to pay.${reg.inferred ? ` Receipts go to ${reg.email}.` : ""}`);
  // Refused for another reason: what happened and what Reason will do next, never silence.
  else if (reg.error !== "email_required") await notify(link.conversation_id, `${cardName(card)} is saved, but it couldn't be set up to pay just now. I'll try again when it's time to pay and tell you if it still won't.`);
  return { ok: true, registered: !!reg.ok, ...(reg.ok ? {} : { needs_email: reg.error === "email_required", ...(reg.choices?.length ? { emails: reg.choices } : {}) }) };
}
export async function removeCard(conversationId) {
  const card = cardOf(conversationId);
  if (!card) return { ok: true };
  const r = await asUser(conversationId, `/api/2026-09-16/payment-methods/${encodeURIComponent(card.paymentMethodId)}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) return { ok: false, status: r.status };
  q("DELETE FROM shop_cards WHERE conversation_id = ?").run(conversationId);
  return { ok: true };
}

/**
 * Where and when this person's card was last used: their latest paid payment (shop_payments, status
 * 'paid', theirs only). { store, at } or null. The store is the merchant Crossmint named, else the
 * checkout's store.
 */
export function lastPaid(conversationId) {
  const r = q("SELECT run_id, merchant_name, answered_at FROM shop_payments WHERE conversation_id = ? AND status = 'paid' ORDER BY answered_at DESC, id DESC LIMIT 1").get(conversationId);
  if (!r) return null;
  return { store: r.merchant_name || storeName(runRow(r.run_id)?.store) || "", at: r.answered_at };
}

// ---------------------------------------------------------------- payment approval
export const paymentRow = (id) => q("SELECT * FROM shop_payments WHERE id = ?").get(id) ?? null;
export const openPayment = (conversationId) => q("SELECT * FROM shop_payments WHERE conversation_id = ? AND status = 'asked' ORDER BY id DESC").get(conversationId) ?? null;
/** "$9.79" for USD, "9.79 EUR" otherwise: Crossmint's string as given, never re-rounded. */
export const amountText = (row) => row.currency === "USD" ? `$${row.amount}` : `${row.amount} ${row.currency}`;
/** The ask, built from the row: Crossmint's amount, the store, what Reason set out to buy. */
export function paymentAsk(row, { allIn = false } = {}) {
  const where = row.merchant_name || storeName(runRow(row.run_id)?.store) || "the store";
  const upTo = row.amount_kind === "exact" ? "" : "up to ";
  // No breakdown to show (owner 2026-10-31): the one number is said to be the whole of it.
  const whole = allIn && row.amount_kind === "exact" ? " (total incl. shipping and tax)" : "";
  return `OK to pay ${upTo}${amountText(row)}${whole} at ${where}${row.item ? ` for ${row.item}` : ""}?`;
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
  // With a passkey, a texted yes never pays (src/passkey.js): only payByPasskey does.
  if (passkey.requiredFor(conversationId)) return { ok: false, error: "approve_with_passkey" };
  return payRow(row, { confirmationId });
}
/**
 * The day's cap, asked of a row before anything is paid: null when it fits, else the refusal both paths
 * hand back as it is. A row whose amount does not read as money is refused too (bad_amount), never sent
 * through as $0. The request Crossmint asked expires in about half an hour, so "tomorrow" means asking
 * for the order again, not this link.
 */
async function capRefusal(row) {
  const cents = Math.round(Number(row.amount) * 100);
  if (!Number.isFinite(cents) || cents <= 0) { logFn({ shop_pay_bad_amount: true, payment_id: row.id }); return { ok: false, error: "bad_amount", say: "The payment's amount could not be read, so nothing was paid. Tell them plainly and that you will look into it." }; }
  const cap = (await import("./trust.js")).checkSpendCap(row.conversation_id, cents);
  if (cap.ok) return null;
  logFn({ shop_pay_over_cap: true, payment_id: row.id, cap: cap.cap, spent_today: cap.spent_today, amount: cap.amount });
  return { ok: false, error: "over_daily_cap", blocked: "over_daily_cap", cap: cap.cap, spent_today: cap.spent_today, left: cap.left, amount: cap.amount, say: cap.error };
}
/** Crossmint's reason, short, from whatever shape it answers in. Never a card detail (none is in its errors). */
const crossmintError = (j) => short(j?.error?.code ?? j?.code ?? j?.error?.message ?? j?.message ?? (typeof j?.error === "string" ? j.error : "") ?? "", 60);
/** Pays a row both approval paths agreed on: Crossmint's exact amount, the row's store, the person's card. */
async function payRow(row, { confirmationId = null } = {}) {
  const conversationId = row.conversation_id;
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
  // The install's daily net (src/trust.js checkSpendCap, REASON_MAX_SPEND_PER_DAY) holds for every way
  // of paying. Until 2026-10-31 only AgentCard's purchase_confirm and browser_submit asked it, and a
  // Crossmint payment — texted yes or Face ID — was only COUNTED after the fact (countSpend below). Now
  // it is asked first, for everyone: the row stays asked, nothing reaches Crossmint, and the refusal
  // names the limit and what is already spent. A yes cannot talk past it; it waits for tomorrow.
  const capped = await capRefusal(row);
  if (capped) return capped;
  // Claimed before any call, so two shop_pay calls at once can't both pay it.
  if (q("UPDATE shop_payments SET status = 'paying' WHERE id = ? AND status = 'asked'").run(row.id).changes !== 1) return { ok: false, error: "payment_in_progress" };
  setStage(row.run_id, "approved");
  const reopen = () => { q("UPDATE shop_payments SET status = 'asked' WHERE id = ? AND status = 'paying'").run(row.id); setStage(row.run_id, "needs_approval"); };
  // Nothing was started yet, so the payment stays open for the same yes. Why it failed travels with
  // it and is logged (status + Crossmint's code): on 2026-10-31 at CVS only "order_intent_failed" was
  // logged, and the cause — the card had no order-intent registration — could not be read back.
  const failed = (status, detail, extra = {}) => {
    reopen();
    logFn({ order_intent_failed: true, payment_id: row.id, ...(status ? { status } : {}), ...(detail ? { code: detail } : {}), ...extra });
    return { ok: false, error: "order_intent_failed", ...(status ? { status } : {}), detail, ...extra };
  };
  // A card Crossmint has no registration for cannot pay: registered first (with their email), and if
  // that is what is missing the person is told what to send instead of a failure nobody can read.
  let receipts = null; // the email Reason picked at pay time, if it did: said with the outcome
  if (card.registered !== 1) {
    const reg = await registerCard(conversationId, { tell: false });
    if (!reg.ok) return failed(reg.status ?? null, reg.code ?? reg.detail ?? reg.error, reg.error === "email_required" ? { needs_email: true, emails: reg.choices ?? [] } : {});
    if (reg.inferred) receipts = reg.email;
  }
  const intent = async () => asUser(conversationId, "/api/unstable/order-intents", {
    method: "POST",
    body: {
      paymentMethodId: card.paymentMethodId,
      amount: { value: row.amount, currency: row.currency },
      merchant: { name: row.merchant_name, url: row.merchant_url, countryCode: row.merchant_country },
      description: (row.item || `${row.merchant_name} order`).slice(0, 120),
      expiresAt: new Date(clock.now() + 15 * 60_000).toISOString(),
    },
  });
  let oi;
  try { oi = await intent(); } catch (e) { return failed(null, short(e?.message ?? e, 60)); }
  // Crossmint says the registration is not there (the row thought it was, or the sweep never ran):
  // register now and try the intent once more. Only then is it a failure.
  if (!oi.ok && noRegistration(crossmintError(oi.json))) {
    const reg = await registerCard(conversationId, { tell: false });
    if (!reg.ok && reg.error === "email_required") return failed(oi.status, crossmintError(oi.json), { needs_email: true, emails: reg.choices ?? [] });
    if (reg.ok) { if (reg.inferred) receipts = reg.email; try { oi = await intent(); } catch (e) { return failed(null, short(e?.message ?? e, 60)); } }
  }
  const orderIntentId = oi.json?.orderIntentId;
  if (!oi.ok || !orderIntentId) return failed(oi.status, crossmintError(oi.json));
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
  // Counted against the day's and the month's caps the moment it is paid, by the real amount (owner
  // 2026-10-31: spend_today read $0.00 after the $25 Walmart payment). Never costs the payment.
  await countSpend(row, confirmationId);
  // Paid: the job moves on, and the order confirmation is watched for in their mail (bounded).
  setStage(row.run_id, "paid");
  q("UPDATE shop_runs SET paid_at = ?, mail_until = ? WHERE run_id = ?").run(clock.now(), clock.now() + MAIL_WATCH_MS, row.run_id);
  watchMail(row.run_id);
  return { ok: true, amount: amountText(row), merchant: row.merchant_name, ...(receipts ? { receipts_email: receipts } : {}) };
}
/** The ledger line for a paid row (src/trust.js noteSpend): the store, the item, the amount. */
export const spendLineOf = (row) => `${row.merchant_name || storeName(runRow(row.run_id)?.store) || "Store"}: ${row.item || "order"} (${amountText(row)})`;
async function countSpend(row, confirmationId = null) {
  try {
    const trust = await import("./trust.js");
    const cents = Math.round(Number(row.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return null;
    return trust.noteSpend({ conversationId: row.conversation_id, cents, what: spendLineOf(row), site: row.merchant_name || storeName(runRow(row.run_id)?.store) || "", confirmationId: confirmationId ?? null });
  } catch (e) { logFn({ spend_count_failed: true, payment_id: row.id, why: short(e?.message ?? e, 80) }); return null; }
}
/**
 * Paid rows the ledger never counted (the ones paid before this existed): counted now, once each, by
 * the day they were paid. Run at boot; returns how many were added.
 */
export async function backfillSpend() {
  let n = 0;
  try {
    const trust = await import("./trust.js");
    for (const row of q("SELECT * FROM shop_payments WHERE status = 'paid' AND answered_at IS NOT NULL").all()) {
      const what = spendLineOf(row);
      if (db.db.prepare("SELECT 1 AS x FROM spend WHERE conversation_id = ? AND what = ? AND site = ? LIMIT 1").get(row.conversation_id, what, row.merchant_name || storeName(runRow(row.run_id)?.store) || "")) continue;
      const cents = Math.round(Number(row.amount) * 100);
      if (!Number.isFinite(cents) || cents <= 0) continue;
      db.recordSpend({ conversationId: row.conversation_id, day: trust.spendDay(row.answered_at), cents, what, site: row.merchant_name || storeName(runRow(row.run_id)?.store) || "", confirmationId: row.confirmation_id ?? null });
      n++;
    }
  } catch (e) { logFn({ spend_backfill_failed: true, why: short(e?.message ?? e, 80) }); }
  return n;
}
// ---------------------------------------------------------------- approval by passkey
/** The Face ID link for an asked payment (five minutes, one use; src/passkey.js). */
export const approvalUrl = (row) => `${siteBase()}/web/approve/${passkey.createApproval(row)}`;
/** The ask once they have a passkey: the same words, and the link instead of "reply yes". */
export const passkeyAsk = (row, opts = {}) => `${paymentAsk(row, opts)} Approve it with Face ID here:\n${approvalUrl(row)}`;
/** What the approval page shows: the row's own amount, store and item, and the link's state. */
export function approvalView(token) {
  const a = passkey.approvalFor(token);
  if (!a || !connectAllowedFor(a.conversation_id) || !passkey.passkeyAllowedFor(a.conversation_id)) return null;
  const row = paymentRow(a.payment_id);
  if (!row) return null;
  const state = a.state === "open" && row.status !== "asked" ? "closed" : a.state;
  return { a, row, state, amount: amountText(row), store: row.merchant_name || storeName(runRow(row.run_id)?.store) || "the store", item: row.item, expiresAt: a.expires_at };
}
/**
 * The page's assertion: verified against the row as it is now (passkey.verifyApproval), the link
 * claimed, and only then the order intent for the row's exact amount. Nothing the page sends but the
 * assertion is used.
 */
export async function payByPasskey(token, response) {
  const v = approvalView(token);
  if (!v) return { ok: false, error: "not_found" };
  // The day's cap first, BEFORE the assertion is verified (verifying marks the link used): over it, the
  // link stays open and nothing was asked of Face ID. No model turn runs here, so the one plain line is
  // texted now, once per link; the page says it too (src/pages/webapprove.js WHY).
  const capped = v.row.status === "asked" ? await capRefusal(v.row) : null;
  if (capped) {
    const told = !!q("SELECT 1 AS x FROM pay_approval_log WHERE payment_id = ? AND event = 'pay_failed' AND detail = 'over_daily_cap' LIMIT 1").get(v.row.id);
    passkey.logEvent(v.row.conversation_id, v.row, "pay_failed", capped.error);
    if (capped.error === "over_daily_cap" && !told) {
      await notify(v.row.conversation_id, `${amountText(v.row)} at ${v.row.merchant_name || "the store"} is past the day's spending limit here ($${(capped.spent_today / 100).toFixed(2)} of $${(capped.cap / 100).toFixed(2)} already spent today). Nothing was charged. Tomorrow, ask me to start the order again.`);
    }
    return capped;
  }
  const ok = await passkey.verifyApproval(v.a, v.row, response);
  if (!ok.ok) return ok;
  const out = await payRow(v.row);
  passkey.logEvent(v.row.conversation_id, v.row, out.ok ? "paid" : out.unknown_outcome ? "unknown_outcome" : "pay_failed", out.ok ? "" : [out.error, out.status, out.detail].filter(Boolean).join(" "));
  if (out.ok) await notify(v.row.conversation_id, `Approved with Face ID. Paid ${out.amount} at ${out.merchant}; the store still has to place it, and I'll tell you when it's through.${out.receipts_email ? ` Receipts go to ${out.receipts_email}.` : ""}`);
  // No model turn runs here, so the one thing they can fix is said in plain words — what is on record
  // and why — once at this moment (a save-time ask was worded for that moment); the link opens again below.
  else if (out.needs_email && q("UPDATE shop_cards SET asked_email = 2 WHERE conversation_id = ? AND asked_email < 2").run(v.row.conversation_id).changes === 1) await notify(v.row.conversation_id, emailAsk(cardOf(v.row.conversation_id), out.emails ?? [], { atPay: true }));
  // Nothing started (no order intent, so no charge is possible): the link opens again for another tap,
  // under a fresh challenge, and the page says Face ID worked but the payment did not start. Once the
  // card may have reached the store (unknown_outcome) the link stays used: never paid twice.
  if (!out.ok && RETRYABLE.has(out.error) && passkey.reopenApproval(v.a, v.row, out.error)) return { ...out, retry: true };
  return out;
}
/** Failures before any order intent where another tap can only help. Never "in progress" (a pay is in flight) or a closed row. */
const RETRYABLE = new Set(["order_intent_failed", "no_card"]);
/** Decline from the page: no passkey needed to say no. */
export async function declineByLink(token) {
  const v = approvalView(token);
  if (!v || v.state !== "open") return { ok: false, error: "not_open" };
  passkey.closeApproval(v.a, "declined");
  const out = await declinePayment({ conversationId: v.row.conversation_id, paymentId: v.row.id });
  passkey.logEvent(v.row.conversation_id, v.row, "declined");
  if (out.ok) await notify(v.row.conversation_id, `Declined. Nothing was charged at ${v.store}.`);
  return out;
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

// ---------------------------------------------------------------- following a checkout: the job
//
// A checkout is a JOB, not a turn (2026-10-31). At 10:58 that day store_checkout started a real Ulta
// run for the owner; at 11:00 Crossmint asked a plain form (shipping and contact details), which this
// follower handed to nobody; at 11:10 the request expired, the run failed, and nothing was said. Asked
// "Updates?" at 11:17, the model — with no record to read — said the checkout had never started (false),
// started another, and that one died the same way, in the same silence. So:
//
//   - every run has a `stage` (started → in_progress → needs_input → needs_approval → approved → paid
//     → placed, or failed / cancelled), moved by code from Crossmint's answers, kept in the row;
//   - a plain question wakes the model (an event turn, once per request) to answer it with shop_answer
//     from what it knows, or to ask the person; a protected form still goes to the sign-in link; a
//     payment is texted as the ask, itemized when Crossmint itemizes it (plus the Face ID link);
//   - the end of a run is texted by code whatever the end was — expired input, blocked, cancelled,
//     placed — and so is a stall (STALL_MS without Crossmint's revision moving), each once;
//   - the record is in front of the model on their turns (checkoutNote) and on demand (shop_status),
//     and the reply guard (src/offers.js) refuses a "started" that has no run behind it;
//   - after a payment the person's mail is watched for the store's confirmation (MAIL_WATCH_MS), and
//     the model is woken to text the order number when one lands;
//   - a restart resumes every open run and every open mail watch (resumeFollowing).
const TERMINAL = new Set(["succeeded", "failed", "blocked", "cancelled", "expired"]);
export const STAGES = ["started", "in_progress", "needs_input", "needs_approval", "approved", "paid", "placed", "failed", "cancelled"];
// Past Crossmint's own 10-minute input expiry, so an expiring request is reported as expired, not as stalled.
export const STALL_MS = 12 * 60_000;
// Crossmint not answering about a run for this long (it forgot it, or the key no longer sees it): the run is over.
export const LOST_MS = 3 * STALL_MS;
export const MAIL_WATCH_MS = 24 * 3600_000;
export const MAIL_EVERY_MS = 10 * 60_000;
let sayFn = null;
let wakeFn = null;
// Web lives on the website (REASON_SITE_URL, heyreason.com): Crossmint's client key allows that origin only.
const siteBase = () => (process.env.REASON_SITE_URL || process.env.REASON_PUBLIC_URL || "https://heyreason.com").replace(/\/+$/, "");
let linkBase = () => `${siteBase()}/web/connect`;
/** A card link as the person taps it. */
export const cardLinkUrl = (conversationId) => `${linkBase()}/${cardLink(conversationId)}`;
/**
 * serve.js hands over how to text a person (`say`) and how to wake the model with an event turn
 * (`wake(conversationId, text, { key })`). Nothing is texted or woken before this.
 */
export function attach({ say, wake, base, log } = {}) { sayFn = say ?? null; wakeFn = wake ?? null; logFn = log ?? (() => {}); passkey.attach({ say }); if (base) linkBase = () => base; }
/** serve.js's structured log line; silent until attached. Codes and statuses only, never a value. */
let logFn = () => {};
const notify = async (c, text) => { try { if (sayFn) await sayFn(c, text); } catch { /* paid or declined either way */ } };
/** An event turn for the model. True once it was raised; false when it could not be (tried again next look). */
const wake = async (c, text, key) => { try { if (wakeFn) await wakeFn(c, text, { key }); return true; } catch { return false; } };

function setStage(runId, stage) {
  const now = clock.now();
  q("UPDATE shop_runs SET stage = ?, stage_at = ?, updated_at = ? WHERE run_id = ? AND stage <> ?").run(stage, now, now, runId, stage);
}
const toldOf = (run) => new Set(String(run?.told ?? "").split(",").filter(Boolean));
/** Claims an event as texted. False when it already was: each is said once, across restarts too. */
function tellOnce(runId, what) {
  const run = runRow(runId);
  if (!run) return false;
  const told = toldOf(run);
  if (told.has(what)) return false;
  told.add(what);
  q("UPDATE shop_runs SET told = ? WHERE run_id = ?").run([...told].join(","), runId);
  return true;
}
const storeOf = (run) => storeName(run.store) || "The store";
const itemOf = (run) => (run.item ? ` for ${run.item}` : "");
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const short = (s, n = 140) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * Crossmint's breakdown of a payment, when it gives one: "item $18.99, shipping $6.95, tax $2.30".
 * A structured breakdown first; failing that, the one written into the request's question. Walmart on
 * 2026-10-31 (run ce771938…) sent no breakdown field at all — the whole of it was in the words:
 *   "Order total $25.00 (item $15.97, shipping $6.99, estimated tax $2.04)."
 * — and the ask went out as "$25.00" alone. The words are read only when their parts add up to the
 * total (`total`, the row's amount), so a number that is not this order's never becomes its breakdown.
 */
export function itemized(it, { question = "", total = "" } = {}) {
  const cur = String(it?.amount?.currency ?? "USD").toUpperCase();
  const fmt = (n) => (cur === "USD" ? `$${n}` : `${n} ${cur}`);
  const src = it?.breakdown ?? it?.amount?.breakdown ?? it?.lineItems ?? null;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    const money = (v) => { const n = v?.value ?? v?.amount ?? v; return /^\d+(\.\d{1,4})?$/.test(String(n ?? "")) ? fmt(n) : ""; };
    const parts = [];
    for (const [k, label] of [["subtotal", "item"], ["items", "item"], ["item", "item"], ["shipping", "shipping"], ["tax", "tax"], ["fees", "fees"], ["discount", "discount"]]) {
      const m = money(src[k]);
      if (m && !parts.some((p) => p.startsWith(label))) parts.push(`${label} ${m}`);
    }
    if (parts.length) return parts.join(", ");
  }
  return itemizedFromWords(question, { total, fmt });
}
const BREAKDOWN_WORD = /\b(subtotal|items?|products?|merchandise|shipping|delivery|(?:estimated |est\.? )?tax(?:es)?|fees?|discounts?|savings?)\b[^$\d\n()]{0,24}\$?\s?(\d{1,6}\.\d{2})\b/gi;
const LABEL_OF = (w) => /^(subtotal|item|items|product|products|merchandise)$/i.test(w) ? "item" : /^(shipping|delivery)$/i.test(w) ? "shipping" : /tax/i.test(w) ? "tax" : /^fees?$/i.test(w) ? "fees" : "discount";
/** The breakdown a question carries in words, when it adds up to the total it is for; "" otherwise. */
export function itemizedFromWords(question, { total = "", fmt = (n) => `$${n}` } = {}) {
  const text = String(question ?? "");
  if (!text) return "";
  const seen = new Map();
  for (const m of text.matchAll(BREAKDOWN_WORD)) {
    const label = LABEL_OF(m[1]);
    if (!seen.has(label)) seen.set(label, Number(m[2]));
  }
  if (seen.size < 2 || !seen.has("item")) return "";
  const sum = [...seen].reduce((s, [k, v]) => s + (k === "discount" ? -v : v), 0);
  const want = Number(total);
  if (Number.isFinite(want) && want > 0 && Math.abs(sum - want) > 0.011) return "";
  return ["item", "shipping", "tax", "fees", "discount"].filter((k) => seen.has(k)).map((k) => `${k} ${fmt(seen.get(k).toFixed(2))}`).join(", ");
}
/**
 * The payment text: the ask (with the Face ID link where they have one), under the itemization when
 * there is one; with none, the ask says the amount is the total with shipping and tax in it.
 */
export function paymentText(run, row, it) {
  const parts = itemized(it, { question: row.question, total: row.amount });
  const ask = passkey.requiredFor(run.conversation_id) ? passkeyAsk(row, { allIn: !parts }) : paymentAsk(row, { allIn: !parts });
  if (!parts) return ask;
  const where = row.merchant_name || storeName(run.store) || "The store";
  return `${where}'s total${row.item ? ` for ${row.item}` : ""}: ${parts}; ${amountText(row)} all in.\n${ask}`;
}

/** "12:25 PM" in their zone: when the store stops holding the cart, said as a clock time, never as a countdown. */
function clockTime(ms, conversationId) {
  let tz = config.tz;
  try { tz = zoneFor(conversationId) || tz; } catch { /* install zone */ }
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms); } catch { return new Date(ms).toISOString().slice(11, 16); }
}
/**
 * The event that wakes the model for a plain question the record could not answer whole (2026-10-31):
 * what is filled already, what is still needed (only that is asked), and when the store needs it by —
 * a clock time, never "in the next 10 minutes or it times out", which is what went out at 12:16.
 */
function inputEvent(run, rq, it, filling = null) {
  const store = storeOf(run);
  const expiresAt = Date.parse(rq.request?.expiresAt ?? "");
  const until = Number.isFinite(expiresAt) ? ` ${store} holds the cart until ${clockTime(expiresAt, run.conversation_id)}; say that as the time, never as a countdown or "or it times out".` : "";
  const fields = (it.fields ?? []).map((f) => `${f.key}${f.required ? "" : " (optional)"}: ${f.label ?? f.key}`).join("; ");
  const options = Array.isArray(it.options) ? ` Options: ${it.options.map((o) => (typeof o === "string" ? o : o?.label ?? o?.value ?? "")).filter(Boolean).join(", ")}.` : "";
  const filled = filling?.filled?.length ? ` Filled from their record already (do not ask for these): ${shipping.filledWords(it, filling.filled)}.` : "";
  const need = filling?.missing?.length
    ? ` Still needed, and the ONLY thing to ask for: ${filling.missing.map((m) => `${m.key} (${m.label})`).join(", ")}. shop_answer needs only those keys; the rest is filled in for you.`
    : "";
  return `[checkout] ${store}'s checkout${itemOf(run)} (run ${run.run_id}) is waiting on an answer. ${store} asks: "${short(rq.request?.question ?? "", 300)}".`
    + `${fields ? ` Fields (key: label): ${fields}.` : ""}${options}${filled}${need}`
    + " Answer it with shop_answer from what you know about them (their name, home address, phone, email; never a card number)."
    + (filling?.missing?.length ? " If you do not know what is still needed, ask them for exactly that in one line, say the rest is on file, and nothing else." : " If something it needs is not known, ask them for exactly that in one line and nothing else.")
    + `${until} Nothing is charged by this.`;
}
/** The one line after a form was answered from the record: where it ships, and that a word fixes it. */
function autoAnsweredText(run, row, it, filling) {
  const where = shipping.shortAddress(row);
  const hasAddress = (it.fields ?? []).some((f) => ["address1", "full_name", "city", "zip"].includes(shipping.roleOf(f)) && filling.filled.includes(f.key));
  const what = hasAddress && where ? `Shipping to ${where}` : `Answered ${storeOf(run)}'s ${shipping.filledWords(it, filling.filled) || "form"} from your record`;
  const how = filling.own === false ? "as you asked" : Number(row?.used ?? 0) > 0 ? "the usual" : "as you gave it to me before";
  return `${what}, ${how}. Say if that's wrong.`;
}
/** The checked answer, posted to Crossmint. Never logs or keeps the values. */
async function postAnswer(run, rq, answers) {
  const part = { type: "input_response", requestId: rq.requestId, action: "submit", response: { kind: rq.kind || "form", answers } };
  let r;
  try { r = await server(run.conversation_id, `${CHECKOUTS}/${encodeURIComponent(run.run_id)}/messages`, { method: "POST", body: { id: `msg_${randomUUID()}`, parts: [part] } }); } catch { return { ok: false, error: "crossmint_unreachable" }; }
  if (!r.ok) return { ok: false, error: "crossmint_refused", status: r.status, detail: short(r.json?.message ?? r.json?.error ?? r.json?.detail ?? "", 200) };
  const now = clock.now();
  q("UPDATE shop_runs SET stage = 'in_progress', stage_at = ?, progress_at = ?, updated_at = ? WHERE run_id = ?").run(now, now, now, run.run_id);
  return { ok: true };
}
/** A choice answered in words ("NY") becomes the option's value; anything else is left as given. */
function shapeAnswers(rq, answers) {
  const out = {};
  const fields = new Map((rq.fields ?? []).map((f) => [f.key, f]));
  for (const [k, v] of Object.entries(answers ?? {})) {
    const f = fields.get(k);
    if (f && f.input?.kind === "choice" && typeof v === "string") { const m = shipping.matchOption(f.input.options, v); out[k] = m === null ? v : m; }
    else out[k] = v;
  }
  return out;
}

/** One field of a store's form, in the person's words; "" for one with no plain name. */
function fieldWords(f) {
  const s = `${f?.key ?? ""} ${f?.label ?? ""}`.toLowerCase();
  if (/e-?mail/.test(s)) return "email";
  if (/phone|mobile|\btel\b/.test(s)) return "phone number";
  if (/addr|street|zip|postal|\bcity\b|\bstate\b|province|country|apartment|\bapt\b/.test(s)) return "shipping address";
  if (/first.?name|last.?name|full.?name|\bname\b/.test(s)) return "name";
  if (/\bsize\b/.test(s)) return "size";
  if (/colou?r/.test(s)) return "color";
  if (/quantity|\bqty\b/.test(s)) return "quantity";
  if (/delivery|ship(ping)?.?(method|option|speed)|pickup/.test(s)) return "delivery option";
  if (/promo|coupon|discount/.test(s)) return "promo code";
  if (/gift.?card/.test(s)) return "gift card";
  if (/gift/.test(s)) return "gift option";
  if (/password|otp|one.?time|verification code|\bcode\b/.test(s)) return "sign-in";
  // A label that only names the act of answering ("How to proceed", "What next", "Your choice") says
  // nothing about what was wanted: on 2026-10-31 the end text read "waiting for your how to proceed".
  if (META_LABEL.test(s)) return "";
  const label = String(f?.label ?? "").replace(/\s+/g, " ").trim();
  return label && label.length <= 24 && !/["'?:]/.test(label) ? label.toLowerCase() : "";
}
const META_LABEL = /how (?:to|should|would you like to|do you want to) proceed|what (?:to do|next|now)|next step|your (?:choice|decision|call)|proceed|continue\??$|^\s*(?:option|choice|action|path|decision)\s*$/i;
const andList = (xs) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
/**
 * What the store was waiting on, in the person's words — "your shipping address and phone number",
 * "your approval of the payment" — read from the request's fields, never the store's prompt. On
 * 2026-10-31 the end text quoted Ulta's whole prompt ("I'm at Ulta's guest checkout with…") back at the owner.
 */
export function askedFor(run) {
  let rq = null;
  try { rq = run.request_json ? JSON.parse(run.request_json) : null; } catch { rq = null; }
  // The last request recorded is what the store was waiting on: the payment, or a form.
  if (run.stage === "needs_approval" || rq?.kind === "payment") return "your approval of the payment";
  const names = [];
  for (const f of rq?.fields ?? []) { const n = fieldWords(f); if (n && !names.includes(n)) names.push(n); }
  if (names.length) return `your ${andList(names.slice(0, 4))}`;
  // No field with a plain name: what the store put to them, in plain words — a refusal it wanted a
  // decision on ("your word on the password reset"), else a choice between the options it offered.
  const refused = refusalOf(rq?.question);
  if (refused) return `your word on ${refused.topic}`;
  const options = (rq?.fields ?? []).flatMap((f) => (f?.input?.options ?? []).map((o) => (typeof o === "string" ? o : o?.label ?? o?.value ?? ""))).filter(Boolean);
  if (options.length >= 2) return `a choice (${options.slice(0, 3).map((o) => short(o, 40)).join(" / ")})`;
  const gist = short(String(rq?.question ?? "").replace(/[?.!]+$/, ""), 80);
  return gist ? `an answer to "${gist}"` : "an answer";
}
/**
 * A store turning the checkout away, read off the question it asked (owner 2026-10-31: Amazon's
 * "Password reset required… How should I proceed?"): what it wants, said as a reason to move on.
 */
const REFUSALS = [
  [/password reset|reset (?:your|the|their|my) password|new password/i, "the password reset", "wants a password reset"],
  [/account (?:is |has been )?(?:locked|suspended|disabled|on hold)|locked out|locked the account/i, "the locked account", "has locked the account"],
  [/verify (?:your|their|my) identity|identity (?:check|verification)|unusual activity|suspicious/i, "the identity check", "wants an identity check first"],
  [/not (?:able|allowed|possible) to (?:check ?out|proceed|continue|complete)|can'?t (?:check ?out|proceed|continue|complete)|(?:does not|doesn'?t|won'?t) (?:allow|let)/i, "its refusal", "wouldn't let the checkout through"],
];
export function refusalOf(question) {
  const text = String(question ?? "");
  if (!text) return null;
  for (const [re, topic, reason] of REFUSALS) if (re.test(text)) return { topic, reason };
  return null;
}
const STOP_OPTION = /\b(?:stop|cancel|abort|give up|don'?t (?:proceed|continue|reset)|do not (?:proceed|continue|reset)|leave it|never ?mind)\b/i;
const PROCEED_Q = /how (?:should|do|would) (?:i|you|we|reason) (?:like to )?proceed|how to proceed|what (?:should|do) (?:i|you|we) do(?: now| next)?\??|should i (?:proceed|continue|go ahead)/i;
/** The option on a refusal form that ends it ("Stop here"), or null when the form offers no way out. */
export function stopOptionOf(rq) {
  for (const f of rq?.fields ?? []) {
    if (f?.input?.kind !== "choice") continue;
    const o = (f.input.options ?? []).find((x) => STOP_OPTION.test(typeof x === "string" ? x : `${x?.label ?? ""} ${x?.value ?? ""}`));
    if (o) return { key: f.key, value: typeof o === "string" ? o : o?.value ?? o?.label };
  }
  return null;
}
/** What ended a run, in their words. `paid` is a payment of theirs that went out before the end. */
function endText(run, status, result, paid) {
  const store = storeOf(run);
  const code = String(result?.code ?? "").toLowerCase();
  const summary = short(result?.summary ?? result?.message ?? "", 160);
  if (paid) {
    return `${store}'s checkout${itemOf(run)} ended after the payment was approved (${summary || status}). I can't tell from here whether the order went through: check your email for ${store}'s confirmation, and if there's a charge with no order, tell me and I'll take it up with them.`;
  }
  const expired = code === "input_expired" || /expired while waiting/i.test(summary);
  if (expired) {
    return `The ${store} checkout${itemOf(run)} stopped: ${store} was waiting for ${askedFor(run)} and didn't get it in time, so it expired. Nothing was charged. Want me to start it again?`;
  }
  if (status === "cancelled") return `The ${store} checkout${itemOf(run)} was cancelled. Nothing was charged.`;
  return `The ${store} checkout${itemOf(run)} didn't go through${summary ? ` (${summary})` : code ? ` (${code})` : ""}. Nothing was charged. Want me to try again, or try another store?`;
}

// ---------------------------------------------------------------- a store turns the checkout away: the next one
/**
 * Another store this person was shown for the same item, with a listing to start from: the picture
 * cards they picked from (choice_sets) first, then the offers read for them, newest first. Never the
 * store that refused, nor one that already failed on this item in the last two hours.
 */
export function alternativeFor(run) {
  const c = run.conversation_id;
  const tried = new Set([run.store, ...q("SELECT store FROM shop_runs WHERE conversation_id = ? AND item = ? AND status <> 'running' AND created_at > ?").all(c, run.item, clock.now() - 2 * 3600_000).map((r) => r.store)]);
  const candidates = [];
  try {
    for (const set of db.db.prepare("SELECT options FROM choice_sets WHERE conversation_id = ? AND created_at > ? ORDER BY id DESC LIMIT 3").all(c, clock.now() - 3 * 3600_000)) {
      for (const o of JSON.parse(set.options || "[]")) if (o?.url) candidates.push({ name: o.name ?? "", url: o.url, store: o.brand || "" });
    }
  } catch { /* no cards shown */ }
  try {
    for (const o of db.db.prepare("SELECT url, product, seller FROM offers WHERE conversation_id = ? AND url <> '' AND fetched_at > ? ORDER BY id DESC LIMIT 20").all(c, clock.now() - 3 * 3600_000)) candidates.push({ name: o.product ?? "", url: o.url, store: o.seller ?? "" });
  } catch { /* no offers read */ }
  for (const cand of candidates) {
    const key = checkoutStoreKey(cand.store, cand.url);
    if (!key || tried.has(key)) continue;
    if (!/^https?:\/\//i.test(cand.url)) continue;
    if (cand.name && run.item && !sameItem(cand.name, run.item)) continue;
    return { store: key, url: cand.url, name: cand.name };
  }
  return null;
}
/**
 * The store refused (a password reset, a lock, a wall): by code, the next store they were shown is
 * started for the same thing and one line says so, no question (owner 2026-10-31: "Amazon wants a
 * password reset, so I moved it to Walmart, same bottle. Nothing charged."). A question is asked only
 * when there is no other store to move to. Returns what was said, for the step's log.
 */
export async function moveOn(run, reason, say, { stopAnswer = null, rq = null } = {}) {
  const store = storeOf(run);
  // The refusal form is answered with its way out first, so the store's side ends cleanly.
  if (stopAnswer && rq) { try { await postAnswer(run, rq, { [stopAnswer.key]: stopAnswer.value }); } catch { /* cancelled below either way */ } }
  const alt = alternativeFor(run);
  const ask = q("SELECT * FROM shop_run_asks WHERE run_id = ?").get(run.run_id);
  let again = null;
  if (alt && ask) {
    tellOnce(run.run_id, "moved");
    await endQuietly(run, `${reason}; moved to ${alt.store}`);
    again = await startCheckout({ conversationId: run.conversation_id, store: alt.store, startUrl: alt.url, what: ask.what, item: run.item, maxUsd: ask.max_usd, signIn: storeSignIn(alt.store) === "required" });
    if (again.ok) {
      follow(again.runId);
      await say(`${store} ${reason}, so I moved it to ${storeName(alt.store) || alt.store}${run.item ? ` for the same ${run.item}` : ""}. Nothing charged.`);
      return { moved: again.runId };
    }
  }
  await endQuietly(run, reason);
  await say(alt && !again?.ok
    ? `${store} ${reason}. Nothing charged, and ${storeName(alt.store) || alt.store} wouldn't start the same checkout. Want me to try another store?`
    : `${store} ${reason}. Nothing charged, and I have no other store lined up${run.item ? ` for ${run.item}` : ""}. Want me to find one?`);
  return { moved: null };
}
/** An order reference Crossmint names in a result, if it names one. */
export function orderRef(result) {
  for (const k of ["orderId", "orderNumber", "confirmationNumber", "orderReference", "reference"]) {
    const v = result?.[k] ?? result?.order?.[k];
    if (v && /^[A-Za-z0-9-]{4,40}$/.test(String(v))) return String(v);
  }
  return "";
}
const mailConnected = (conversationId) => { try { return db.listOauthTokens(conversationId, "google").length > 0; } catch { return false; } };
function placedText(run, result) {
  const ref = orderRef(result);
  const watch = mailConnected(run.conversation_id)
    ? `I'm watching your email for ${storeOf(run)}'s confirmation and will send the order number and delivery date when it lands.`
    : `Check your email for ${storeOf(run)}'s confirmation; I can't see your mail, so the order number and delivery date will be there.`;
  return `${storeOf(run)} placed the order${itemOf(run)}${ref ? ` (order ${ref})` : ""}. ${watch}`;
}
/** A stall — nothing moved for STALL_MS — said once per run. */
/** The wait updates: one at WAIT_MS in the same stage ("still working, not stuck"), one at WAIT_MORE_MS with what it is waiting on. */
export const WAIT_MS = 3 * 60_000, WAIT_MORE_MS = 8 * 60_000;
/** What a run is waiting on right now, in the person's words. */
function waitingOn(run) {
  const store = storeOf(run);
  if (run.stage === "needs_input") {
    if (openSigninLink(run.run_id)) return `waiting on your ${store} sign-in; the link I sent still works`;
    return `waiting on ${askedFor(run)}`;
  }
  return `waiting on ${store} to move the checkout along`;
}
/**
 * A run sat in one stage for a while, with nobody told (owner 2026-10-31: ten minutes of sign-in with
 * no word): one line at WAIT_MS that it is working and not stuck, one at WAIT_MORE_MS with what it is
 * waiting on. Never for a payment waiting on them (the ask said it all), never for a superseded run.
 */
async function waitUpdates(run, say) {
  if (!run || TERMINAL.has(run.status) || toldOf(run).has("superseded") || !["started", "in_progress", "needs_input"].includes(run.stage)) return {};
  const at = run.stage_at ?? run.created_at;
  const inStage = clock.now() - at;
  // A question the model put to THEM (woke / refused) is theirs to answer: "still working" would be
  // wrong, so only the line saying what it waits on goes (review 2026-10-31).
  const onThem = run.stage === "needs_input" && !openSigninLink(run.run_id) && [...toldOf(run)].some((t) => t.startsWith("woke:") || t.startsWith("refused:"));
  if (inStage >= WAIT_MORE_MS) {
    if (!tellOnce(run.run_id, `wait8:${at}`)) return {};
    await say(`Still on the ${storeOf(run)} checkout${itemOf(run)}: ${waitingOn(run)}. Not stuck, and nothing's charged.`);
    return { waited: 8 };
  }
  if (inStage >= WAIT_MS && !onThem) {
    if (!tellOnce(run.run_id, `wait3:${at}`)) return {};
    await say(`Still working on the ${storeOf(run)} checkout${itemOf(run)}, not stuck. Nothing's charged.`);
    return { waited: 3 };
  }
  return {};
}
async function stalled(run, say) {
  if (!run || TERMINAL.has(run.status) || toldOf(run).has("superseded")) return {};
  const since = run.progress_at ?? run.created_at;
  if (clock.now() - since < STALL_MS) return waitUpdates(run, say);
  if (!tellOnce(run.run_id, "stalled")) return { stalled: true };
  const where = run.stage === "needs_input" ? `waiting on an answer for ${storeOf(run)}` : run.stage === "needs_approval" ? `waiting on your approval at ${storeOf(run)}` : `at ${storeOf(run)}'s checkout`;
  await say(`Still ${where}${itemOf(run)}: nothing has moved for ${minutes(clock.now() - since)} minutes. Nothing has been charged. If it dies I'll say so.`);
  return { stalled: true };
}

/**
 * One look at a run: what changed, and what to text. Returns the text(s) sent, for the caller's log.
 * A sign-in question → the link (texted once per run; later questions land on the same page).
 * A card payment → the ask, from the row. A plain question → the model is woken (`woke`).
 * The end → the row's stage and status, and one text saying what happened.
 */
export async function step(runId) {
  const run = runRow(runId);
  if (!run || TERMINAL.has(run.status)) return { done: true };
  const said = [];
  const say = async (text) => { said.push(text); if (sayFn) await sayFn(run.conversation_id, text); };
  let r;
  try { r = await server(run.conversation_id, `${CHECKOUTS}/${encodeURIComponent(runId)}`); } catch { r = { ok: false, json: null }; }
  if (!r.ok || !r.json) {
    // Crossmint not answering about it at all, for LOST_MS: the run is over as far as anyone can tell.
    if (clock.now() - (run.last_ok_at ?? run.created_at) > LOST_MS) {
      q("UPDATE shop_runs SET status = 'failed', result = 'lost: Crossmint stopped answering about this run', stage = 'failed', stage_at = ?, updated_at = ? WHERE run_id = ?").run(clock.now(), clock.now(), runId);
      q("UPDATE shop_payments SET status = 'expired' WHERE run_id = ? AND status = 'asked'").run(runId);
      if (tellOnce(runId, "end")) await say(`I lost track of the ${storeOf(run)} checkout${itemOf(run)}: the checkout service stopped answering about it. Nothing was charged that I can see. Want me to start it again?`);
      return { done: true, status: "failed", said, lost: true };
    }
    return { done: false, said, ...(await stalled(run, say)) };
  }
  const cur = r.json;
  const status = String(cur.status ?? "");
  const now = clock.now();
  q("UPDATE shop_runs SET last_ok_at = ? WHERE run_id = ?").run(now, runId);
  const told = toldOf(run);
  // Progress is Crossmint's revision moving, a new request, or the end.
  const rev = Number(cur.revision ?? 0);
  if (rev !== Number(run.revision ?? 0)) q("UPDATE shop_runs SET revision = ?, progress_at = ?, updated_at = ? WHERE run_id = ?").run(rev, now, now, runId);
  const ra = cur.requiredAction;
  const requestId = ra?.requestId ?? "";
  let woke = null;
  if (requestId && requestId !== run.last_request_id) {
    const rq = { requestId, request: ra.request };
    const it = ra.request?.interaction ?? {};
    q("UPDATE shop_runs SET last_request_id = ?, question = ?, request_json = ?, progress_at = ?, updated_at = ? WHERE run_id = ?")
      .run(requestId, short(ra.request?.question ?? "", 600), JSON.stringify(publicRequest(rq)), now, now, runId);
    const link = openSigninLink(runId);
    if (it.kind === "payment") {
      // Past the sign-in: the store let them in.
      if (link || run.mode === "sign_in") finishSignin(run, link);
      const row = recordPayment({ conversationId: run.conversation_id, runId, request: rq, item: run.item });
      if (row && told.has("superseded")) {
        // Started over with a corrected address: this one's payment is declined, quietly. Nothing charged.
        await declinePayment({ conversationId: run.conversation_id, paymentId: row.id });
        q("UPDATE shop_runs SET status = 'cancelled', stage = 'cancelled', stage_at = ?, updated_at = ?, result = 'superseded' WHERE run_id = ?").run(now, now, runId);
        return { done: true, status: "cancelled", said };
      } else if (row && row.amount_kind !== "exact") {
        // A ceiling, not a total: nothing to say yes to. Declined, so nothing is charged.
        await declinePayment({ conversationId: run.conversation_id, paymentId: row.id });
        setStage(runId, "in_progress");
        await say(`${row.merchant_name || storeName(run.store) || "The store"} only gave me a ceiling (${amountText(row)}), not the real total, so I stopped before paying. Nothing was charged.`);
      } else if (row && it.method === "card") {
        setStage(runId, "needs_approval");
        await say(paymentText(run, row, it));
      } else {
        // A payment Reason cannot approve from here (not a card, or no readable amount): never the
        // model's to answer. Said once; the request expires on its own and the end is texted.
        setStage(runId, "in_progress");
        if (tellOnce(runId, `nopay:${requestId}`)) await say(`${storeOf(run)} asked for a payment I can't approve from here (${it.method ? `by ${it.method}` : "no readable amount"}), so I didn't. Nothing was charged.`);
      }
    } else if (it.kind === "form" && (it.fields ?? []).some(isProtected)) {
      setStage(runId, "needs_input");
      if (link) {
        q("UPDATE shop_links SET request_id = ?, request_json = ? WHERE id = ?").run(requestId, JSON.stringify(publicRequest(rq)), link.id);
      } else {
        const token = createLink({ conversationId: run.conversation_id, kind: "signin", store: run.store, runId, request: rq });
        const name = storeName(run.store) || "the store";
        // Never names Crossmint (owner 10-30): people know Reason, and the password goes on to the store.
        await say(run.mode === "signed"
          ? `${name} signed me out. Sign in again here and I'll pick up where we left off. Your password goes straight to ${name}, not to me.\n${linkBase()}/${token}`
          : `${name} needs you signed in before it lets anyone check out. Sign in once here and I'll use it for ${name} orders from now on. Your password goes straight to ${name}, not to me.\n${linkBase()}/${token}`);
      }
    } else if (told.has("superseded")) {
      // A run started over with a corrected address: this one's questions go unanswered and it expires.
      setStage(runId, "needs_input");
    } else {
      // A plain question — shipping details, a size, a choice. Answered from the record by code when the
      // record covers it (2026-10-31: his address was on file and he was asked for it anyway), with one
      // line saying where it ships; otherwise the model is woken once with what is still needed.
      setStage(runId, "needs_input");
      const pub = publicRequest(rq);
      // The store turning the checkout away, dressed as a question (Amazon's "Password reset required…
      // How should I proceed?", 2026-10-31): never the model's to answer. Code moves on to the next store.
      // Only a form that offers a way out ("Stop here") or asks how to proceed is a refusal: a real
      // form that happens to say "verify your identity" is still answered (review 2026-10-31).
      const refused = refusalOf(pub.question);
      const stop = stopOptionOf(pub);
      if (refused && (stop || PROCEED_Q.test(pub.question) || (pub.fields ?? []).some((f) => META_LABEL.test(`${f?.key ?? ""} ${f?.label ?? ""}`)))) {
        tellOnce(runId, `refusal:${requestId}`);
        const moved = await moveOn(runRow(runId), refused.reason, say, { stopAnswer: stop, rq: pub });
        return { done: true, status: "cancelled", said, ...moved };
      }
      const filling = autoFill(run, pub);
      if (filling.covered) {
        const posted = await postAnswer(run, pub, filling.answers);
        if (posted.ok) {
          tellOnce(runId, `auto:${requestId}`);
          await say(autoAnsweredText(run, filling.row, pub, filling));
          if (filling.own !== false) shipping.markUsed(run.conversation_id);
          return { done: false, status, said, answered: requestId, ...(await stalled(runRow(runId), say)) };
        }
        // Refused: the model gets the whole question (the record is not merged in again for this request) and decides.
        tellOnce(runId, `refused:${requestId}`);
        woke = requestId;
        if (await wake(run.conversation_id, `${inputEvent(run, rq, it, null)} (The store refused the answer from their record, HTTP ${posted.status ?? "error"}: give every required key yourself this time, from what you know or by asking them.)`, `shop:${runId}:${requestId}`)) tellOnce(runId, `woke:${requestId}`);
      } else {
        woke = requestId;
        if (await wake(run.conversation_id, inputEvent(run, rq, it, filling), `shop:${runId}:${requestId}`)) tellOnce(runId, `woke:${requestId}`);
      }
    }
  } else if (requestId && run.stage === "needs_input" && !told.has(`woke:${requestId}`) && !told.has(`auto:${requestId}`) && !told.has("superseded") && run.request_json) {
    // The same plain question, and the model was never reached for it (the wake failed): raised again.
    let rq = null;
    try { rq = JSON.parse(run.request_json); } catch { rq = null; }
    if (rq && rq.kind === "form" && !(rq.fields ?? []).some(isProtected)) {
      woke = requestId;
      if (await wake(run.conversation_id, inputEvent(run, { requestId, request: ra.request }, ra.request?.interaction ?? {}, autoFill(run, rq)), `shop:${runId}:${requestId}`)) tellOnce(runId, `woke:${requestId}`);
    }
  } else if (!requestId && !TERMINAL.has(status) && (run.stage === "started" || !run.stage)) {
    setStage(runId, "in_progress");
  }
  if (TERMINAL.has(status)) {
    const before = runRow(runId).stage;
    const result = cur.result ?? (cur.reason ? { code: String(cur.reason) } : null);
    q("UPDATE shop_runs SET status = ?, result = ?, updated_at = ?, progress_at = ? WHERE run_id = ?").run(status, String(result?.code ?? result?.summary ?? "").slice(0, 300), now, now, runId);
    const link = openSigninLink(runId);
    if (status === "succeeded" && (link || run.mode === "sign_in")) finishSignin(run, link);
    else if (link) q("UPDATE shop_links SET state = 'failed' WHERE id = ?").run(link.id);
    q("UPDATE shop_payments SET status = 'expired' WHERE run_id = ? AND status = 'asked'").run(runId);
    const paid = q("SELECT * FROM shop_payments WHERE run_id = ? AND status IN ('paid', 'unknown') ORDER BY id DESC").get(runId) ?? null;
    // A guest checkout the store walled off behind an account: remembered for this store, and the same
    // checkout starts again signed in, which sends them the sign-in link. Once per checkout.
    const ask = q("SELECT * FROM shop_run_asks WHERE run_id = ?").get(runId);
    if (!paid && run.mode === "guest" && status !== "succeeded" && status !== "cancelled" && ask && !ask.retried && !told.has("superseded") && needsAccount(result)) {
      q("UPDATE shop_run_asks SET retried = 1 WHERE run_id = ?").run(runId);
      if (run.store && !STORES[run.store]?.signIn) {
        q("INSERT INTO shop_sites (store, sign_in) VALUES (?, 'required') ON CONFLICT (store) DO UPDATE SET sign_in = 'required'").run(run.store);
      }
      setStage(runId, "failed");
      const again = await startCheckout({ conversationId: run.conversation_id, store: run.store, startUrl: ask.start_url, what: ask.what, item: run.item, maxUsd: ask.max_usd, signIn: true });
      if (again.ok) { tellOnce(runId, "end"); q("UPDATE shop_runs SET result = ? WHERE run_id = ?").run(`sign-in wall; started again signed in as ${again.runId}`, runId); follow(again.runId); }
      else if (tellOnce(runId, "end")) await say(`${storeName(run.store) || "The store"} wants an account to check out, and I couldn't start the signed-in checkout. Nothing was charged.`);
      return { done: true, status, said, retried: again.ok ? again.runId : null };
    }
    if (status === "succeeded") {
      const ref = orderRef(result);
      if (ref) q("UPDATE shop_runs SET order_ref = ? WHERE run_id = ?").run(ref, runId);
      setStage(runId, "placed");
      if (!runRow(runId).mail_until) { q("UPDATE shop_runs SET mail_until = ? WHERE run_id = ?").run(now + MAIL_WATCH_MS, runId); watchMail(runId); }
      // An order placed is a finished errand (src/stamps.js: the "orders" seal). Told after the write; never costs the text.
      try { db.completionBus.emit("order", { conversationId: run.conversation_id, runId, store: storeOf(run) }); } catch { /* a listener's failure is its own */ }
      if (tellOnce(runId, "end")) await say(placedText(run, result));
    } else {
      setStage(runId, status === "cancelled" ? "cancelled" : "failed");
      // Walled off or blocked, nothing paid: the next store they were shown, by code, rather than
      // "want me to try another store?" (owner 2026-10-31). The question is asked only with no store to move to.
      const code = String(result?.code ?? "").toLowerCase();
      const wall = !paid && status !== "cancelled" && !told.has("superseded") && !toldOf(runRow(runId)).has("end")
        && (status === "blocked" || code === "merchant.no_safe_path" || code.includes("blocked") || !!refusalOf(`${result?.summary ?? ""} ${result?.message ?? ""} ${result?.reason ?? ""}`));
      if (wall) {
        const summary = short(result?.summary ?? result?.message ?? "", 160);
        const why = refusalOf(`${result?.summary ?? ""} ${result?.message ?? ""} ${result?.reason ?? ""}`)?.reason ?? `stopped the checkout${summary ? ` (${summary})` : ""}`;
        const moved = await moveOn(runRow(runId), why, say);
        return { done: true, status, said, ...moved };
      }
      if (tellOnce(runId, "end")) await say(endText({ ...runRow(runId), stage: before }, status, result, paid));
    }
    return { done: true, status, said };
  }
  return { done: false, status, said, woke, ...(await stalled(runRow(runId), say)) };
}
/** Crossmint's result for a checkout the store wouldn't let a guest finish (Target, Walmart: merchant.no_safe_path at "Sign in or create account"). */
function needsAccount(result) {
  const code = String(result?.code ?? "").toLowerCase();
  const text = `${result?.summary ?? ""} ${result?.message ?? ""} ${result?.reason ?? ""}`.toLowerCase();
  const wall = /sign[\s-]?in|log[\s-]?in|create (an |your )?account|requires? (an )?account|membership/.test(text);
  if (/(^|[._])(sign_?in|login|account_required|requires_account|auth_required)([._]|$)/.test(code)) return true;
  return code === "merchant.no_safe_path" && (wall || !text.trim());
}
function finishSignin(run, link) {
  if (run.store) markConnected(run.conversation_id, run.store);
  q("UPDATE shop_runs SET signed_in = 1 WHERE run_id = ?").run(run.run_id);
  if (link) q("UPDATE shop_links SET state = 'connected' WHERE id = ?").run(link.id);
}

/**
 * The model's answer to a plain question (shop_answer): checked against the request on record, never
 * a protected field, posted to Crossmint. The values are never logged or stored (src/privacy.js seals
 * them out of the tool log), only that the request was answered.
 */
export async function answerRun(runId, { conversationId, answers }) {
  const run = runRow(runId);
  if (!run || run.conversation_id !== conversationId) return { ok: false, error: "no_such_run" };
  if (TERMINAL.has(run.status)) return { ok: false, error: "run_over", stage: run.stage, say: `That checkout is over (${run.stage}); nothing is waiting on an answer.` };
  let rq = null;
  try { rq = run.request_json ? JSON.parse(run.request_json) : null; } catch { rq = null; }
  // A form the record answered already, and they say part of it was wrong: the record is corrected and the
  // checkout starts over with it (the one running has the old address typed in; its payment is declined).
  // Open until the payment goes out, whatever the run has asked since.
  const autoTold = [...toldOf(run)].find((t) => t.startsWith("auto:"));
  const newFormOpen = !!(rq && rq.kind === "form" && run.stage === "needs_input" && autoTold && rq.requestId !== autoTold.slice(5));
  if (autoTold && !run.paid_at && !["approved", "paid", "placed"].includes(run.stage) && !newFormOpen) {
    return correctAndRestart(run, rq && rq.kind === "form" ? rq : null, answers);
  }
  if (!rq || !run.last_request_id || run.stage !== "needs_input") return { ok: false, error: "nothing_asked", stage: run.stage };
  // Only a plain form is the model's to answer: a payment is approved through shop_pay or Face ID, never here.
  if (rq.kind !== "form") return { ok: false, error: "not_a_form", kind: rq.kind };
  if ((rq.fields ?? []).some(isProtected)) return { ok: false, error: "needs_signin_link", say: "That question has a password or code in it: it goes through the sign-in link they were texted, never through you." };
  // What the model gives wins; what it leaves out comes from the record (2026-10-31); a choice in words
  // becomes the option's value (Ulta's state dropdown refused "NY" twice on 12:17).
  const given = shapeAnswers(rq, answers ?? {});
  // The record's answer to this very request was refused: not merged in again; the model gives it all.
  const fromRecord = toldOf(run).has(`refused:${rq.requestId}`) ? {} : autoFill(run, rq).answers;
  const merged = { ...fromRecord, ...given };
  const checked = checkAnswers(rq, merged);
  if (!checked.ok) return { ok: false, error: checked.error, fields: (rq.fields ?? []).map((f) => ({ key: f.key, label: f.label, required: !!f.required, ...(f.key in fromRecord ? { on_record: true } : {}) })) };
  const posted = await postAnswer(run, rq, checked.answers);
  if (!posted.ok) return posted;
  try { shipping.learnFromAnswers(conversationId, rq, given); } catch { /* the answer went through either way */ }
  const fromThem = Object.keys(given), fromUs = Object.keys(checked.answers).filter((k) => !(k in given));
  return { ok: true, run_id: runId, answered: Object.keys(checked.answers), from_them: fromThem, from_record: fromUs,
    say: `Answered; the checkout is moving again${fromUs.length ? `, the rest (${fromUs.join(", ")}) from their record` : ""}. Nothing is charged until they approve the exact total they'll be texted. Say so in one line if they're waiting, otherwise nothing.` };
}
/**
 * The record against a run's open form: the person's own, unless the run's instruction ships somewhere else
 * (a gift), which wins. Keys only leave here; the values go to Crossmint and nowhere else.
 */
function autoFill(run, rq) {
  try {
    const ask = q("SELECT what FROM shop_run_asks WHERE run_id = ?").get(run.run_id);
    const { row, own } = shipping.recordForRun(shipping.profileFor(run.conversation_id), ask?.what ?? "");
    return { ...shipping.fill(rq, row), row, own };
  } catch { return { answers: {}, filled: [], missing: (rq?.fields ?? []).filter((f) => f.required).map((f) => ({ key: f.key, label: f.label || f.key, ours: false })), covered: false, row: null, own: true }; }
}
/** Their correction to a form the record answered: the record learns it, the run is superseded, the same checkout starts again. */
async function correctAndRestart(run, rq, answers) {
  // The keys are the shipping record's own when the form is not the open request any more (the payment ask came since).
  const form = rq ?? { fields: shipping.FIELDS.map((k) => ({ key: k, label: k, input: { kind: "text" } })) };
  const given = Object.fromEntries(Object.entries(answers ?? {}).filter(([k]) => (form.fields ?? []).some((f) => f.key === k)));
  if (!Object.keys(given).length) return { ok: false, error: "unknown_field", fields: (form.fields ?? []).map((f) => ({ key: f.key, label: f.label })) };
  const before = shipping.profileRow(run.conversation_id);
  const row = shipping.learnFromAnswers(run.conversation_id, form, shapeAnswers(form, given), { source: "correction" });
  const changed = shipping.FIELDS.filter((f) => String(before?.[f] ?? "") !== String(row?.[f] ?? ""));
  if (!changed.length) return { ok: false, error: "nothing_changed", say: "That is what the record already says (or it did not read as an address part), so nothing changed and the checkout runs on. Ask them what to change, plainly." };
  const ask = q("SELECT * FROM shop_run_asks WHERE run_id = ?").get(run.run_id);
  if (!ask) return { ok: false, error: "cannot_restart", say: `The record is corrected, but this checkout cannot be started over from here. Say so, and that nothing was charged.` };
  tellOnce(run.run_id, "superseded"); tellOnce(run.run_id, "end");
  // A payment this run is asking for goes with the old address: declined, nothing charged.
  const open = q("SELECT id FROM shop_payments WHERE run_id = ? AND status = 'asked'").get(run.run_id);
  if (open) { try { await declinePayment({ conversationId: run.conversation_id, paymentId: open.id }); } catch { /* it expires on its own */ } }
  // The instruction carries the address as it was (startCheckout wrote the old record into it): the old one
  // — the one with the record's previous ZIP — is replaced whole, so a corrected ZIP is not read as a gift.
  let what = String(ask.what ?? "").replace(/\s+/g, " ").trim();
  const old = shipping.parseAddress(what);
  if (old && (!before?.zip || old.zip === before.zip || old.zip === row?.zip) && shipping.complete(row)) what = shipping.replaceAddress(what, old, row);
  const again = await startCheckout({ conversationId: run.conversation_id, store: run.store, startUrl: ask.start_url, what, item: run.item, maxUsd: ask.max_usd, signIn: run.mode === "sign_in" });
  if (!again.ok) return { ok: false, error: "restart_failed", status: again.status, say: "The record is corrected, but the store would not start the checkout again. Nothing was charged." };
  q("UPDATE shop_runs SET result = ? WHERE run_id = ?").run(`corrected address; started again as ${again.runId}`, run.run_id);
  follow(again.runId);
  return { ok: true, run_id: again.runId, corrected: Object.keys(given), superseded: run.run_id,
    say: `Fixed on the record (now ${shipping.shortAddress(row) || "as they said"}); I started ${storeOf(run)}'s checkout over with it. Say that in one line; nothing is charged until they approve the total.` };
}

// ---------------------------------------------------------------- the record, for the model
/** This person's runs: every open one, and the ones that started in the window. Newest first. */
export function runsOf(conversationId, { sinceMs = 48 * 3600_000, limit = 10 } = {}) {
  return q("SELECT * FROM shop_runs WHERE conversation_id = ? AND (status = 'running' OR created_at >= ?) ORDER BY created_at DESC LIMIT ?").all(conversationId, clock.now() - sinceMs, limit);
}
/** A run most recently started, within `withinMs`, or still open: what a "started" claim has to have behind it. */
export function recentRun(conversationId, { withinMs = 15 * 60_000 } = {}) {
  return q("SELECT * FROM shop_runs WHERE conversation_id = ? AND (status = 'running' OR created_at >= ?) ORDER BY created_at DESC LIMIT 1").get(conversationId, clock.now() - withinMs) ?? null;
}
const payOf = (run) => q("SELECT * FROM shop_payments WHERE run_id = ? ORDER BY id DESC").get(run.run_id) ?? null;
/** Where a run stands, in one line, from the row. */
export function stageLine(run) {
  const ago = (t) => { const m = minutes(clock.now() - (t ?? run.created_at)); return m < 120 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  const store = storeOf(run);
  const pay = payOf(run);
  const result = run.result ? ` (${short(run.result, 120)})` : "";
  switch (run.stage) {
    case "started": return `starting at ${store} (${ago(run.created_at)}); nothing charged`;
    case "in_progress": return `running at ${store}'s checkout, started ${ago(run.created_at)}, last moved ${ago(run.progress_at)}; nothing charged`;
    case "needs_input": {
      let need = "";
      try {
        const rq = run.request_json ? JSON.parse(run.request_json) : null;
        if (rq?.kind === "form" && !(rq.fields ?? []).some(isProtected)) {
          const f = autoFill(run, rq);
          need = f.missing.length ? `; still needed from them: ${f.missing.map((m) => m.label).join(", ")}${f.filled.length ? " (the rest is on record)" : ""}` : "";
        }
      } catch { /* the question alone */ }
      return `waiting since ${ago(run.stage_at)} on an answer to "${short(run.question, 120)}"${need} (answer it with shop_answer, run_id ${run.run_id}, giving only what is needed, or ask them for exactly that); nothing charged`;
    }
    case "needs_approval": return `waiting since ${ago(run.stage_at)} on their approval of ${pay ? amountText(pay) : "the total"} at ${pay?.merchant_name || store}; nothing charged yet`;
    case "approved": return `paying ${pay ? amountText(pay) : ""} at ${pay?.merchant_name || store} now`;
    case "paid": return `paid ${pay ? amountText(pay) : ""} at ${pay?.merchant_name || store} ${ago(run.paid_at)}; ${store} still has to place it`;
    case "placed": return `placed ${ago(run.stage_at)}${run.order_ref ? `, order ${run.order_ref}` : ""}${pay ? `, ${amountText(pay)} paid` : ""}`;
    case "cancelled": return `cancelled ${ago(run.stage_at)}; nothing charged`;
    case "failed": {
      const expired = /input_expired|expired while waiting/i.test(run.result);
      const why = expired ? ` (${store} was waiting for ${askedFor(run)} and it expired after 10 minutes)` : result;
      return `failed ${ago(run.stage_at)}${why}; ${pay && ["paid", "unknown"].includes(pay.status) ? `a payment of ${amountText(pay)} had gone out, outcome unknown` : "nothing charged"}`;
    }
    default: return `${run.status} ${ago(run.updated_at)}${result}`;
  }
}
/**
 * For a run waiting on approval: whether the person can still approve, and how. With Face ID, a link
 * that was used up without paying or ran out (2026-10-31: "did that go through?" after two taps) gets
 * a fresh one here, so Reason resends it instead of saying "not yet". An open link is named, not remade.
 */
function approvalHint(run) {
  const pay = payOf(run);
  if (!pay || pay.status !== "asked") return {};
  const deadline = pay.expires_at ? Date.parse(pay.expires_at) : NaN;
  if (Number.isFinite(deadline) && deadline < clock.now()) return { approval: `${storeOf(run)}'s payment window has passed, so this can't be approved anymore; the run will end on its own. Offer to start it again.` };
  if (!passkey.requiredFor(run.conversation_id)) return { approval: "they approve by replying yes to the payment text; if they haven't, ask again in one line." };
  const open = passkey.openApprovalFor(pay.id);
  if (open) return { approval: `their Face ID link from the payment text still works for ${minutes(open.expires_at - clock.now())} more minutes; nothing is paid until they approve there. If they say they have no link, call shop_pay with payment_id ${pay.id} for a fresh one.` };
  return { approve_url: approvalUrl(pay), approval: "their earlier Face ID link was used up without paying or ran out. Send this fresh url ON ITS OWN LINE as the last thing, untouched; it works once, for 5 minutes. Don't say it's paid." };
}
/** shop_status: the record the model answers from. */
export function statusView(conversationId) {
  const runs = runsOf(conversationId).map((run) => ({
    run_id: run.run_id, store: storeOf(run), item: run.item, stage: run.stage || run.status, status: run.status,
    started_minutes_ago: minutes(clock.now() - run.created_at), where: stageLine(run),
    // Whole, never cut (2026-10-31: cut at 200 it lost Walmart's "estimated tax $2.04", and the model
    // called the figure unverified).
    ...(run.question ? { last_question: run.question } : {}),
    ...(run.order_ref ? { order_ref: run.order_ref } : {}),
    ...(run.stage === "needs_approval" ? approvalHint(run) : {}),
  }));
  return { ok: true, runs, note: runs.length ? "This is the record. Answer from it, never from the chat; say the stage in plain words." : "No checkout has run for them in the last two days. Say so; do not say one is running." };
}
/** The note on their turns: every run of the last day, from the row, over anything the chat says. */
export function checkoutNote(conversationId) {
  try {
    if (!connectAllowedFor(conversationId)) return "";
    const runs = runsOf(conversationId, { sinceMs: 24 * 3600_000, limit: 5 });
    if (!runs.length) return "";
    const lines = runs.map((run) => `- ${storeOf(run)}${run.item ? `, ${run.item}` : ""}: ${stageLine(run)}.`);
    const card = cardOf(conversationId);
    const onFile = card ? `\nCard on file for paying: ${card.brand ? `${card.brand[0].toUpperCase()}${card.brand.slice(1)} ` : ""}••••${card.last4}. Never ask whether they have a card or which; the payment ask is texted for you with the total.` : "";
    return `Checkout record (code's own, from the database; it overrides anything the chat says about these orders):\n${lines.join("\n")}\n`
      + "Answer anything about an order or checkout from this (shop_status has the same). Never say a checkout started unless store_checkout returned a run_id this turn, and never say one never ran when it is listed here."
      + " A checkout you started is yours to finish: never offer them the store's page to buy it themselves instead." + onFile;
  } catch { return ""; }
}

// ---------------------------------------------------------------- the order confirmation, in their mail
let mailImpl = null;
/** Tests point this at a fake mailbox: (conversationId, { host, since }) → { ok, connected, hits }. */
export function _setMail(f) { mailImpl = f ?? null; }
async function readMail(conversationId, { host, since }) {
  const google = await import("./google.js");
  const tokens = await google.allAccessTokens(conversationId, { scope: google.GMAIL_SCOPE });
  if (!tokens.ok) return { ok: true, connected: false, hits: [] };
  const hits = [];
  for (const a of tokens.accounts ?? []) {
    const list = await google.api(a.token, "GET", "/gmail/v1/users/me/messages", { query: { q: `from:${host} after:${Math.floor(since / 1000)}`, maxResults: 5 } });
    if (!list.ok) continue;
    for (const m of list.body?.messages ?? []) {
      const one = await google.api(a.token, "GET", `/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`, { query: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] } });
      if (!one.ok) continue;
      const v = google.messageBrief(one.body);
      hits.push({ account: a.account, thread_id: v.thread_id, message_id: m.id, subject: v.subject, from: v.from, date: v.date });
    }
  }
  return { ok: true, connected: true, hits };
}
function mailEvent(run, hits) {
  const list = hits.slice(0, 3).map((h) => `"${short(h.subject, 120)}" from ${short(h.from, 80)} (${h.date}; account ${h.account}, thread_id ${h.thread_id})`).join("; ");
  return `[checkout] Mail from ${storeOf(run)} arrived after the order${itemOf(run)} (run ${run.run_id}): ${list}. Read it with gmail_read (thread_id, in that account) and text them the order number and the delivery estimate in one line. If it is not the confirmation for this order, say exactly NO_REPLY.`;
}
/**
 * One look at their mail for the store's confirmation. Stops (and says why, once) when the window
 * closes or no mail is connected; wakes the model, once, when something from the store arrives.
 */
export const MAIL_WAKES_MAX = 5;
export async function checkMail(runId) {
  const run = runRow(runId);
  if (!run || !run.mail_until || toldOf(run).has("mail")) return { done: true };
  const store = storeOf(run);
  if (clock.now() > run.mail_until) {
    // A placed order with nothing in the mail is not an alarm; a payment with no order might be.
    const worry = run.stage !== "placed";
    if (tellOnce(runId, "mail") && worry) await notify(run.conversation_id, `No confirmation email from ${store} in the 24 hours since the payment. Check ${store}'s site or your card for the charge, and tell me what you see; I'll take it from there.`);
    return { done: true, expired: true };
  }
  q("UPDATE shop_runs SET mail_checked_at = ? WHERE run_id = ?").run(clock.now(), runId);
  const host = storeHost(run.store).replace(/^www\./, "");
  if (!host) { tellOnce(runId, "mail"); return { done: true }; }
  let r;
  try { r = await (mailImpl ?? readMail)(run.conversation_id, { host, since: (run.paid_at ?? run.created_at) - 60_000 }); } catch { return { done: false }; }
  if (!r?.ok || !r.connected) { tellOnce(runId, "mail"); return { done: true, connected: false }; }
  // Every NEW message from the store is put to the model (it decides whether it is the confirmation);
  // the first one — a "rate your visit" — does not end the watch. Bounded: MAIL_WAKES_MAX wakes, then done.
  const seen = new Set(String(run.mail_seen ?? "").split(",").filter(Boolean));
  const fresh = (r.hits ?? []).filter((h) => h.message_id && !seen.has(h.message_id));
  if (!fresh.length) return { done: false };
  for (const h of fresh) seen.add(h.message_id);
  q("UPDATE shop_runs SET mail_seen = ? WHERE run_id = ?").run([...seen].slice(-50).join(","), runId);
  const wakes = [...toldOf(run)].filter((t) => t.startsWith("mailwake:")).length + 1;
  tellOnce(runId, `mailwake:${fresh[0].message_id}`);
  await wake(run.conversation_id, mailEvent(run, fresh), `shop:${runId}:mail:${fresh[0].message_id}`);
  if (wakes >= MAIL_WAKES_MAX) { tellOnce(runId, "mail"); return { done: true, hits: fresh.length, capped: true }; }
  return { done: false, hits: fresh.length };
}
/** Watches their mail every few minutes until the confirmation lands or the window closes. */
export function watchMail(runId, { everyMs = MAIL_EVERY_MS } = {}) {
  const tick = async () => {
    let out = { done: false };
    try { out = await checkMail(runId); } catch { /* next tick */ }
    if (!out.done) setTimeout(tick, everyMs).unref?.();
  };
  setTimeout(tick, 0).unref?.();
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
/** Orders placed (the row's own record): what the stamps book counts. Oldest first. */
export function ordersPlaced(conversationId) {
  return q("SELECT run_id, conversation_id, store, item, order_ref, stage_at, updated_at, created_at FROM shop_runs WHERE conversation_id = ? AND status = 'succeeded' AND stage = 'placed' ORDER BY stage_at, created_at").all(conversationId);
}
/**
 * The checkout record as a source for the figures a reply may name (src/offers.js guardReply): every
 * amount and question of this person's payments and runs of the last two days. On 2026-10-31 the
 * model read Walmart's "$2.04" off the record and the guard, knowing nothing of the record, marked it
 * "(unverified)" in the text.
 */
export function recordSource(conversationId, { sinceMs = 48 * 3600_000 } = {}) {
  try {
    const since = clock.now() - sinceMs;
    const pays = q("SELECT amount, currency, question FROM shop_payments WHERE conversation_id = ? AND created_at > ?").all(conversationId, since)
      .map((p) => `${amountText(p)} ${p.question}`);
    const runs = q("SELECT question, request_json, result FROM shop_runs WHERE conversation_id = ? AND created_at > ?").all(conversationId, since)
      .map((r) => `${r.question} ${r.request_json} ${r.result}`);
    return [...pays, ...runs].join("\n");
  } catch { return ""; }
}
/** After a restart: every open run is followed again, and every open mail watch resumed. */
export function resumeFollowing() {
  const runs = q("SELECT run_id FROM shop_runs WHERE status = 'running'").all().map((r) => r.run_id);
  for (const id of runs) follow(id);
  const mail = q("SELECT run_id, told FROM shop_runs WHERE mail_until IS NOT NULL AND mail_until > ?").all(clock.now()).filter((r) => !toldOf(r).has("mail")).map((r) => r.run_id);
  for (const id of mail) watchMail(id);
  // Cards saved before the registration was recorded: read back once, never waited on.
  setTimeout(() => { sweepCards().catch(() => {}); }, 0).unref?.();
  // Payments the ledger never counted: counted now, by the day they were paid.
  setTimeout(() => { backfillSpend().then((n) => { if (n) logFn({ spend_backfilled: n }); }).catch(() => {}); }, 0).unref?.();
  return { runs, mail };
}
