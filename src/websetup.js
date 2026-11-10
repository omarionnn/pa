// The web setup (heyreason.com/start → Messages), behind REASON_WEB_SETUP (default off).
//
// Tapping "Text Reason" on the site opens four short screens before Messages: their name, the name
// they want for Reason, an optional Amazon, email and card connect, then Messages with the first text
// typed for them: `hey jarvis, it's kofi · r7k2`. The visitor has no phone number and no conversation
// yet, so everything they choose is kept on a setup (src/websetupstore.js) under a stand-in
// conversation, and their first text claims it by its code:
//
//   - their name goes on the account, the name they gave Reason on the contact card;
//   - what they connected moves to them: a Google grant; a card saved in Crossmint's own form; an
//     Amazon sign-in made through the store sign-in Reason's checkouts use (owner, 11-10:
//     shopconnect.setupStoreLink, Crossmint's sealed password field on Reason's /web/connect page —
//     never Reason's own browser, so no thread, no texted code and no code gate), which rides the
//     same Crossmint user and browser profile as the card (shop.adoptSetup, claim ≤ PAY_CLAIM_MS);
//   - the text intro's questions are skipped: never ask on the phone what was answered on the page
//     (src/onboarding.js webHandoff). The thread still makes its Amazon offer after the card UNLESS
//     Amazon was connected on the page (per connection: skipped or failed there → offered; the
//     AMAZON HOOK reads shop.isConnected).
//   - Uber is OFF the page (owner, 11-10): `/api/capabilities` says uber:false and the uber connect
//     endpoint refuses (404, nothing made); the claim still moves a grant an older stand-in holds.
//
// Without a code (or with one that does not match) the normal text intro runs unchanged. Event and
// invite joiners never claim (their first text is the event's or invite's, router #claimEvent /
// #claimInvite), so they keep the intro and its Amazon offer.
//
// The claim is code's, not the model's: the code is an exact token at the end of their first text,
// and the setup's own names have to be in that text too, so a guessed code alone attaches nothing.
//
// The HTTP side is JSON under /setup/api/*, reached through the website's signed proxy so it is
// same-origin on heyreason.com. A browser proves it owns a setup with the `rs_setup` cookie set when
// it was made; the connect gate (src/connectgate.js browserConversation) reads the same cookie, which
// is what lets the Google callback and the Amazon sign-in page finish for a setup that has no thread
// to text a code to. Nothing personal is logged: setup ids and outcomes only.
import { existsSync, renameSync, rmSync } from "node:fs";
import * as db from "./db.js";
import * as store from "./websetupstore.js";
import { config, clock } from "./config.js";
import { cardName, nameCase, vcard, liveLineNumber, DEFAULT_CARD_NAME } from "./contact.js";
import { nameLine } from "./onboarding.js";
import * as amazon from "./amazonconnect.js";
import * as google from "./google.js";
import * as shop from "./shopconnect.js";
import { profilePath } from "./browser.js";
import { cookieDomain } from "./pages/siteproxy.js";
import { clientIp } from "./opspassword.js";

export const on = () => ["1", "true", "on", "yes"].includes(String(process.env.REASON_WEB_SETUP ?? "").trim().toLowerCase());
export const PATH = "/setup";

const MAX_USER = 40;
const MAX_REASON = 18;

// ---------- the first text ----------

/** The first text the page types for them. Lowercase, the code last after a middle dot. */
export function firstText({ user, reasonName, code }) {
  const r = String(reasonName ?? "").trim() || DEFAULT_CARD_NAME;
  return `hey ${r.toLowerCase()}, it's ${String(user ?? "").trim().toLowerCase()} · ${code}`;
}

/** The code at the very end of a text, after a middle dot (or a hyphen/pipe a keyboard might swap in). */
export function codeInText(text) {
  const m = /(?:^|\s)[·•|\-–—]\s*([a-z0-9]{4})\s*$/i.exec(String(text ?? ""));
  if (!m) return null;
  const code = m[1].toLowerCase();
  return store.CODE_RE.test(code) ? code : null;
}

const has = (text, name) => !name || String(text).toLowerCase().includes(String(name).trim().toLowerCase());

/** Their first text without its code: what is stored, and what the model reads. */
export function withoutCode(text) {
  return String(text ?? "").replace(/\s*[·•|\-–—]\s*[a-z0-9]{4}\s*$/i, "").trim();
}

/**
 * What they connected on the page moves to the phone only when the claim comes soon after the setup
 * was made. The person who builds a setup taps "text" a minute later; a setup made by someone else and
 * sent to a stranger as a pre-typed text (so its Amazon or Gmail would become theirs) mostly is not
 * sent that fast. Later claims still take the names; the connections are dropped.
 */
export const CONNECT_CLAIM_MS = 60 * 60_000;
/**
 * Uber (where they are picked up and dropped off) and a card (what pays) move on a tighter clock: a
 * claim within fifteen minutes of the setup. A setup planted on somebody else would have to be texted
 * that quickly, and its card page's Crossmint access (SETUP_JWT_SEC) has mostly run out by then too.
 */
export const PAY_CLAIM_MS = 15 * 60_000;
/**
 * How long a setup's card page may hand Crossmint access (its JWT) for: never past the setup's
 * PAY_CLAIM_MS mark, so no token for a Crossmint user an account adopts outlives the window. 0 = too late.
 */
export function setupJwtSec(conversationId, now = clock.now()) {
  const row = store.get(store.idOf(conversationId), now);
  if (!row) return 0;
  return Math.max(0, Math.min(shop.SETUP_JWT_SEC, Math.floor((row.created_at + PAY_CLAIM_MS - now) / 1000)));
}

// ---------- the claim ----------

/**
 * Their first text, from an account it just made: claim the setup its code names. Returns what was
 * claimed (`{ setupId, user, reasonName, amazon, email, uber, card }`) or null — no code, no open setup with it,
 * or a text that does not carry the setup's names (then nothing is touched and the intro runs).
 */
export function claimFromText({ conversationId, text, log = () => {} }) {
  if (!on() || !conversationId || store.isSetupConversation(conversationId)) return null;
  const code = codeInText(text);
  if (!code) return null;
  const row = store.byCode(code);
  if (!row || !row.user_name || !has(text, row.user_name) || !has(text, row.reason_name)) {
    if (row) store.miss(row.id);
    log({ websetup_claim: "no_match" });
    return null;
  }
  if (!store.markClaimed(row.id, conversationId)) return null;
  const from = store.conversationOf(row.id);
  db.setAccountName(conversationId, nameCase(row.user_name));
  db.setContactCardName(conversationId, cardName(row.reason_name || DEFAULT_CARD_NAME));
  const fresh = clock.now() - row.created_at <= CONNECT_CLAIM_MS;
  if (fresh && clock.now() - row.created_at > PAY_CLAIM_MS) dropRidesAndCard(from);
  const moved = fresh ? moveConnections(from, conversationId) : (dropConnections(from), { email: false, amazon: false, uber: false, card: false, amazonStore: false });
  // An older setup's Amazon sign-in in Reason's own browser: the follow-up the text intro would have run
  // after its link (read their orders), a little after the hello. The store sign-in (Crossmint) is for
  // buying only: nothing to read, no follow-up.
  if (moved.amazon) db.createTimer(conversationId, { fireAt: clock.now() + 90_000, note: amazon.followUpNote() });
  log({ websetup_claim: "claimed", setup: row.id, amazon: moved.amazon, amazon_store: moved.amazonStore, email: moved.email, uber: moved.uber, card: moved.card, ...(fresh ? {} : { connections: "dropped_late" }) });
  return { setupId: row.id, user: row.user_name, reasonName: row.reason_name || DEFAULT_CARD_NAME, text: withoutCode(text), ...moved };
}

/**
 * What the stand-in holds, moved to the real conversation: Google and Uber grants, the Amazon check,
 * the saved browser profile, the card (and the Crossmint user it was saved under).
 */
export function moveConnections(from, to) {
  let email = false, amazonOk = false, uberOk = false;
  db.atomically(() => {
    // A grant this conversation already has for the same provider and address stays; the setup's copy is dropped.
    for (const t of db.db.prepare("SELECT id, provider, account_label FROM oauth_tokens WHERE conversation_id = ?").all(from)) {
      const clash = db.db.prepare("SELECT 1 FROM oauth_tokens WHERE conversation_id = ? AND provider = ? AND account_label = ?").get(to, t.provider, t.account_label);
      if (clash) { db.db.prepare("DELETE FROM oauth_tokens WHERE id = ?").run(t.id); continue; }
      db.db.prepare("UPDATE oauth_tokens SET conversation_id = ? WHERE id = ?").run(to, t.id);
      if (t.provider === "google") email = true;
      if (t.provider === "uber") uberOk = true;
    }
    // One connected-accounts row per provider: the account's own wins over the setup's.
    const movedNames = new Set();
    for (const { name } of db.db.prepare("SELECT DISTINCT name FROM connected_accounts WHERE conversation_id = ?").all(from)) {
      if (db.db.prepare("SELECT 1 FROM connected_accounts WHERE conversation_id = ? AND name = ?").get(to, name)) db.db.prepare("DELETE FROM connected_accounts WHERE conversation_id = ? AND name = ?").run(from, name);
      else { db.db.prepare("UPDATE connected_accounts SET conversation_id = ? WHERE conversation_id = ? AND name = ?").run(to, from, name); movedNames.add(name); }
    }
    amazonOk = movedNames.has("amazon") && amazon.connected(to);
    db.db.prepare("DELETE FROM oauth_states WHERE conversation_id = ?").run(from);
    // Receipts email the card's registration may have learned on the page.
    if (!db.db.prepare("SELECT 1 FROM shop_shipping WHERE conversation_id = ?").get(to)) db.db.prepare("UPDATE shop_shipping SET conversation_id = ? WHERE conversation_id = ?").run(to, from);
    else db.db.prepare("DELETE FROM shop_shipping WHERE conversation_id = ?").run(from);
  });
  // The card and the Amazon store sign-in (shop.setupStoreLink) share the setup's Crossmint user and
  // browser profile: both move together, or neither (an account with Crossmint state keeps its own).
  const { card, stores } = shop.adoptSetup(from, to);
  // An older setup's Amazon sign-in in Reason's own browser lives in the profile it was made in. A
  // brand-new account has none, so the setup's becomes theirs; one that somehow does keeps its own.
  const src = profilePath(from), dst = profilePath(to);
  if (existsSync(src)) {
    if (!existsSync(dst)) { try { renameSync(src, dst); } catch { amazonOk = false; } }
    else { rmSync(src, { recursive: true, force: true }); if (amazonOk) { db.db.prepare("DELETE FROM connected_accounts WHERE conversation_id = ? AND name = 'amazon'").run(to); amazonOk = false; } }
  }
  return { email, amazon: amazonOk, uber: uberOk, card, amazonStore: stores.includes("amazon") };
}

/** Did this conversation do the setup on the web? Then the text intro asks none of it again. */
export function handledOnWeb(conversationId) {
  return on() && !!store.claimedBy(conversationId);
}

/** A stand-in's Uber grant and card, let go (a claim past PAY_CLAIM_MS keeps only Gmail and Amazon). */
export function dropRidesAndCard(c) {
  shop.dropSetupCard(c);
  db.db.prepare("DELETE FROM oauth_tokens WHERE conversation_id = ? AND provider = 'uber'").run(c);
  db.db.prepare("DELETE FROM connected_accounts WHERE conversation_id = ? AND name = 'uber'").run(c);
  db.db.prepare("DELETE FROM oauth_states WHERE conversation_id = ? AND provider = 'uber'").run(c);
}

/** Everything a setup's stand-in holds, let go. */
export function dropConnections(c) {
  shop.dropSetupCard(c);
  db.db.prepare("DELETE FROM shop_shipping WHERE conversation_id = ?").run(c);
  db.db.prepare("DELETE FROM oauth_tokens WHERE conversation_id = ?").run(c);
  db.db.prepare("DELETE FROM connected_accounts WHERE conversation_id = ?").run(c);
  db.db.prepare("DELETE FROM oauth_states WHERE conversation_id = ?").run(c);
  rmSync(profilePath(c), { recursive: true, force: true });
}

/** Setups past their day: what they connected is let go, and the row with it. */
export function sweep(now = clock.now()) {
  for (const id of store.expiredUnclaimed(now)) {
    dropConnections(store.conversationOf(id));
    store.remove(id);
  }
}

// ---------- what the page sees ----------

const STEPS = 3;

/**
 * How long a connect that was started but never finished still reads "connecting". A person who
 * tapped Connect, then came back or refreshed, would otherwise see a card stuck on "connecting"
 * with no way out: past this, with no live sign-in going on, the card says failed (try again), and a
 * new tap always starts fresh (the providers clear their old state for the stand-in, and the Amazon
 * link replaces an open session).
 */
export const STALE_CONNECT_MS = 2 * 60_000;

/** An OAuth handshake still open for the stand-in, and fresh enough to be the one they are in the middle of. */
function openOauth(c, provider, now) {
  const st = db.db.prepare("SELECT created_at FROM oauth_states WHERE conversation_id = ? AND provider = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1").get(c, provider);
  return !!st && now - Number(st.created_at ?? 0) <= STALE_CONNECT_MS;
}

/** One card's state for the page: none | connecting | connected | failed, and which of three steps. */
export function connectState(row, which, { now = clock.now() } = {}) {
  const c = store.conversationOf(row.id);
  if (which === "amazon") {
    // The store sign-in (shop.setupStoreLink): connected once the store let them in; connecting while
    // the sign-in run is alive and Crossmint keeps answering about it (step 2 once the login was asked
    // for); a tap whose run died, or that nothing answers for two minutes, is failed (try again).
    if (shop.isConnected(c, "amazon")) return { state: "connected", step: STEPS, of: STEPS };
    const live = shop.setupStorePending(c, "amazon");
    if (live && now - Number(live.since ?? now) <= STALE_CONNECT_MS) return { state: "connecting", step: live.asked || live.answered ? 2 : 1, of: STEPS };
    if (row.amazon_state === "failed" || row.amazon_state === "pending") return { state: "failed", step: 1, of: STEPS };
    return { state: "none", step: 1, of: STEPS };
  }
  if (which === "uber") {
    if (db.db.prepare("SELECT 1 FROM oauth_tokens WHERE conversation_id = ? AND provider = 'uber'").get(c)) return { state: "connected", step: STEPS, of: STEPS };
    if (row.uber_state === "failed" || row.uber_state === "not_ready") return { state: "failed", step: 1, of: STEPS, ...(row.uber_state === "not_ready" ? { why: "not_ready" } : {}) };
    if (row.uber_state === "pending") return openOauth(c, "uber", now) ? { state: "connecting", step: 2, of: STEPS } : { state: "failed", step: 1, of: STEPS };
    return { state: "none", step: 1, of: STEPS };
  }
  if (which === "card") {
    const card = shop.cardOf(c);
    // The brand and last four are all the page is ever told, the same as Reason's own card screen.
    if (card) return { state: "connected", step: STEPS, of: STEPS, ...(card.last4 ? { last4: card.last4 } : {}) };
    if (row.card_state === "failed") return { state: "failed", step: 1, of: STEPS };
    if (row.card_state === "pending" && shop.setupCardPending(c)) return { state: "connecting", step: 2, of: STEPS };
    return { state: "none", step: 1, of: STEPS };
  }
  if (db.db.prepare("SELECT 1 FROM oauth_tokens WHERE conversation_id = ? AND provider = 'google'").get(c)) return { state: "connected", step: STEPS, of: STEPS, provider: "gmail" };
  if (row.email_state === "failed") return { state: "failed", step: 1, of: STEPS, provider: "gmail" };
  if (row.email_state === "pending") return openOauth(c, "google", now) ? { state: "connecting", step: 2, of: STEPS, provider: "gmail" } : { state: "failed", step: 1, of: STEPS, provider: "gmail" };
  return { state: "none", step: 1, of: STEPS };
}

export function view(row, opts = {}) {
  return {
    id: row.id, code: row.code, user: row.user_name, reasonName: row.reason_name,
    connections: { amazon: connectState(row, "amazon", opts), uber: connectState(row, "uber", opts), email: connectState(row, "email", opts), card: connectState(row, "card", opts) },
  };
}

// ---------- limits ----------

/** A small per-address window count, in memory: a restart forgets it, which only ever lets more through. */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key, now = clock.now()) => {
    const list = (hits.get(key) ?? []).filter(t => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    return true;
  };
}
export const limits = {
  create: limiter(12, 3_600_000),
  nameLine: limiter(30, 600_000),
  connect: limiter(20, 3_600_000),
  write: limiter(120, 3_600_000),
};
export function resetLimits() {
  limits.create = limiter(12, 3_600_000);
  limits.nameLine = limiter(30, 600_000);
  limits.connect = limiter(20, 3_600_000);
  limits.write = limiter(120, 3_600_000);
}

// The model's name lines, kept by name: the same name typed by a hundred people is asked about once.
const lineCache = new Map();
export function forgetNameLines() { lineCache.clear(); }

// ---------- HTTP ----------

const JSONH = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const json = (status, body, extra = {}) => ({ status, headers: { ...JSONH, ...extra }, body: JSON.stringify(body) });

/**
 * The origins the setup pages may run on: the website, plus any listed in REASON_SETUP_ORIGINS (a
 * staging copy of the site, comma separated). A setup remembers the one it was made on, so its
 * Google return and its Amazon link come back to that same site (where its cookie is).
 */
const originOf = (u) => { try { return new URL(u).origin; } catch { return ""; } };
export function setupOrigins() {
  const listed = String(process.env.REASON_SETUP_ORIGINS ?? "").split(",").map(s => originOf(s.trim())).filter(Boolean);
  return [...new Set([originOf(config.siteUrl), originOf(config.pagesUrl), originOf(config.publicUrl), ...listed].filter(Boolean))];
}
const siteBase = () => (config.siteUrl || config.publicUrl || "").replace(/\/+$/, "");
const originFor = (row) => (row?.origin && setupOrigins().includes(row.origin)) ? row.origin : siteBase();

function setupCookie(secret, headers) {
  // Domain-wide on the website (so app.heyreason.com's Google return sees it too); host-only anywhere
  // else, or a staging copy's browser would refuse a cookie naming heyreason.com.
  const site = (() => { try { return new URL(config.siteUrl).hostname; } catch { return ""; } })();
  const from = (() => { try { return new URL(String(headers?.origin ?? "")).hostname; } catch { return ""; } })();
  const domain = !from || from === site || from.endsWith(`.${site}`) ? cookieDomain(headers ?? {}) : "";
  const secure = /^https:/i.test(config.publicUrl || config.siteUrl || "") ? "; Secure" : "";
  return `${store.COOKIE}=${secret}; Path=/${domain ? `; Domain=${domain}` : ""}; Max-Age=${Math.floor(store.TTL_MS / 1000)}; HttpOnly; SameSite=Lax${secure}`;
}

/** Only from the website's own pages: a POST from anywhere else is refused (the same rule Web keeps). */
function sameSite(headers = {}) {
  const origin = String(headers.origin ?? "");
  if (!origin) return true; // a same-origin fetch may omit it; the cookie is SameSite=Lax anyway
  try { return setupOrigins().includes(new URL(origin).origin) || new URL(origin).host === String(headers.host ?? ""); } catch { return false; }
}

const back = (row, which, ok) => `${originFor(row)}/start/connect?back=${which}${ok ? "" : "&failed=1"}`;
/** The setup's connect screen, on the site the setup was made on, for a page that has no thread to go back to. */
export function backUrlFor(conversationId, which) {
  const row = store.get(store.idOf(conversationId));
  return row ? back(row, which, true) : `${siteBase()}/start/connect`;
}

/** Where a Google callback for a setup sends the person: back to the connect screen, never a thread. */
export function googleCallbackDone(out) {
  const id = store.idOf(out?.conversationId);
  if (!id) return null;
  if (!out.ok) store.setConnectState(id, "email", "failed");
  else store.setConnectState(id, "email", "connected");
  return { status: 302, headers: { Location: back(store.get(id), "email", out.ok), "Cache-Control": "no-store" }, body: "" };
}

/** The same for Uber's return: back to the connect screen, never Uber's "you're connected" page. */
export function uberCallbackDone(out) {
  const id = store.idOf(out?.conversationId);
  if (!id || !store.get(id)) return null;
  store.setConnectState(id, "uber", out.ok ? "connected" : "failed");
  return { status: 302, headers: { Location: back(store.get(id), "uber", out.ok), "Cache-Control": "no-store" }, body: "" };
}

/**
 * One request under /setup. `path` is what follows /setup. Returns `{ status, headers, body }`.
 * Seams: `nameLineFor` (the model's line), `amazonLink` (the setup's Amazon store sign-in link,
 * shop.setupStoreLink), `googleLink` (the setup's Google link), `cardLink` (the setup's card-entry
 * link). The uber connect takes no seam: it is refused before anything is made.
 */
export async function request({ method = "GET", path = "", query = {}, headers = {}, remoteAddress = "", readBody = async () => "", router = null, log = () => {},
  nameLineFor = (name) => nameLine({ name, web: true }),
  amazonLink = (c) => shop.setupStoreLink(c, "amazon"),
  googleLink = (c) => google.authorizeUrl(c),
  cardLink = (c) => shop.setupCardLink(c) } = {}) {
  if (!on()) return json(404, { error: "not found" });
  const ip = clientIp(headers, remoteAddress);
  const secret = store.readSecret(headers.cookie);
  const body = async () => { try { return JSON.parse(String((await readBody()) ?? "") || "{}"); } catch { return null; } };

  if (method === "GET" && path === "/api/capabilities") {
    // Amazon and the card ride Crossmint: both need shop connect open to everyone and the keys. Uber
    // is off the page for good (11-10): false whatever the server could do, so a cached page never
    // shows its card.
    const crossmint = shop.connectMode() === "on" && !!process.env.CROSSMINT_CLIENT_KEY && !!process.env.CROSSMINT_SERVER_KEY;
    return json(200, { amazon: crossmint, gmail: google.googleStatus().connected === true, outlook: false, uber: false, card: crossmint });
  }

  if (method === "GET" && path === "/api/name-line") {
    const name = String(query.name ?? "").trim().slice(0, MAX_USER);
    if (name.length < 2) return { status: 204, headers: JSONH, body: "" };
    const key = name.toLowerCase();
    if (lineCache.has(key)) return lineCache.get(key) ? json(200, { line: lineCache.get(key) }) : { status: 204, headers: JSONH, body: "" };
    if (!limits.nameLine(ip)) return { status: 204, headers: JSONH, body: "" };
    let line = null;
    try { line = await nameLineFor(name); } catch { line = null; }
    line = webLine(line, name);
    if (lineCache.size > 2000) lineCache.clear();
    lineCache.set(key, line);
    return line ? json(200, { line }) : { status: 204, headers: JSONH, body: "" };
  }

  if (method === "GET" && path === "/contact.vcf") {
    const name = cardName(String(query.name ?? "").slice(0, MAX_REASON));
    const number = liveLineNumber(router);
    const card = number ? vcard({ number, callNumber: config.twilioFrom, name }) : null;
    if (!card) return json(404, { error: "no card" });
    const file = name.replace(/[^A-Za-z0-9 ._-]/g, "").trim() || "Reason";
    return { status: 200, headers: { "Content-Type": "text/vcard; charset=utf-8", "Content-Disposition": `attachment; filename="${file}.vcf"`, "Cache-Control": "no-cache" }, body: card };
  }

  if (method === "POST" && !sameSite(headers)) return json(403, { error: "forbidden" });

  if (method === "POST" && path === "/api/new") {
    if (!limits.create(ip)) return json(429, { error: "slow down" });
    sweep();
    const o = originOf(String(headers.origin ?? ""));
    const s = store.create(undefined, { origin: o && setupOrigins().includes(o) ? o : "" });
    log({ websetup: "created", setup: s.id });
    return json(201, { id: s.id, code: s.code, expiresAt: s.expiresAt }, { "Set-Cookie": setupCookie(s.secret, headers) });
  }

  const m = /^\/api\/([A-Za-z0-9_-]{16})(?:\/connect\/(amazon|email|uber|card))?$/.exec(path);
  if (!m) return json(404, { error: "not found" });
  const row = store.owned(m[1], secret);
  if (!row) return json(404, { error: "not found" });
  const c = store.conversationOf(row.id);

  if (method === "GET" && !m[2]) return json(200, view(row));

  if (method === "POST" && !m[2]) {
    if (!limits.write(ip)) return json(429, { error: "slow down" });
    const b = await body();
    if (!b) return json(400, { error: "bad json" });
    const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
    store.save(row.id, {
      ...(b.user !== undefined ? { user: clean(b.user, MAX_USER) } : {}),
      ...(b.reasonName !== undefined ? { reasonName: clean(b.reasonName, MAX_REASON) } : {}),
    });
    return json(200, { ok: true });
  }

  if (method === "POST" && m[2]) {
    // Uber left the page (11-10): refused outright, no link made, the setup untouched.
    if (m[2] === "uber") {
      log({ websetup_connect: "uber", setup: row.id, ok: false, why: "unavailable" });
      return json(404, { ok: false, why: "unavailable" });
    }
    if (!limits.connect(ip)) return json(429, { ok: false, why: "slow_down" });
    if (m[2] === "amazon") {
      // The store sign-in through Crossmint (shop.setupStoreLink): the link is Reason's /web/connect page,
      // keyed by its token alone, so it opens on any browser; no setup cookie, no code. Past the window
      // the sign-in would not move to them anyway: say so instead of starting one.
      if (clock.now() - row.created_at > PAY_CLAIM_MS - 60_000) {
        store.setConnectState(row.id, "amazon", "failed");
        log({ websetup_connect: "amazon", setup: row.id, ok: false, why: "too_late" });
        return json(200, { ok: false, why: "too_late" });
      }
      let out = null;
      try { out = await amazonLink(c); } catch { out = null; }
      store.setConnectState(row.id, "amazon", out?.ok ? "pending" : "failed");
      log({ websetup_connect: "amazon", setup: row.id, ok: !!out?.ok, ...(out?.ok ? {} : { why: out?.why || "unavailable" }) });
      return json(200, out?.ok && out.url ? { ok: true, url: out.url } : { ok: false, why: out?.why || "unavailable" });
    }
    if (m[2] === "card") {
      // Past the window a card would not move to them anyway: say so instead of taking it.
      if (clock.now() - row.created_at > PAY_CLAIM_MS - 60_000) {
        store.setConnectState(row.id, "card", "failed");
        log({ websetup_connect: "card", setup: row.id, ok: false, why: "too_late" });
        return json(200, { ok: false, why: "too_late" });
      }
      const out = cardLink(c);
      store.setConnectState(row.id, "card", out?.ok ? "pending" : "failed");
      log({ websetup_connect: "card", setup: row.id, ok: !!out?.ok });
      return json(200, out?.ok && out.url ? { ok: true, url: out.url } : { ok: false, why: out?.why || "unavailable" });
    }
    const b = (await body()) ?? {};
    if (String(b.provider ?? "gmail") !== "gmail") return json(200, { ok: false, why: "unavailable" });
    const out = googleLink(c);
    store.setConnectState(row.id, "email", out?.ok ? "pending" : "failed");
    log({ websetup_connect: "email", setup: row.id, ok: !!out?.ok });
    return json(200, out?.ok ? { ok: true, url: out.url } : { ok: false, why: "unavailable" });
  }
  return json(405, { error: "method" });
}

/**
 * The model's line shaped for the page, which shows it after `kofi — `: lowercase, its name dropped
 * from the front ("kofi, it means…" → "it means…"), one line. Null when there is nothing worth showing.
 */
export function webLine(line, name) {
  let v = String(line ?? "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  const n = String(name).trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  v = v.toLowerCase().replace(new RegExp(`^(?:nice to meet you,?\\s*)?${n}[\\s,:!.—-]*`, "u"), "").trim();
  // "nice to meet you" alone says nothing on a page that has not met them yet.
  if (!v || /^nice to meet you[\s,!.]*$/.test(v)) return null;
  return v.slice(0, 160);
}
