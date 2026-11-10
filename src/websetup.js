// The web setup (heyreason.com/start → Messages), behind REASON_WEB_SETUP (default off).
//
// Tapping "Text Reason" on the site opens four short screens before Messages: their name, the name
// they want for Reason, an optional Amazon and email connect, then Messages with the first text typed
// for them: `hey jarvis, it's kofi · r7k2`. The visitor has no phone number and no conversation yet,
// so everything they choose is kept on a setup (src/websetupstore.js) under a stand-in conversation,
// and their first text claims it by its code:
//
//   - their name goes on the account, the name they gave Reason on the contact card;
//   - what they connected (a Google grant, an Amazon sign-in in Reason's browser) moves to them;
//   - the text intro's questions are skipped: never ask on the phone what was answered on the page
//     (src/onboarding.js webHandoff), and the Amazon offer is not made to them (the AMAZON HOOK).
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

// ---------- the claim ----------

/**
 * Their first text, from an account it just made: claim the setup its code names. Returns what was
 * claimed (`{ setupId, user, reasonName, amazon, email }`) or null — no code, no open setup with it,
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
  const moved = fresh ? moveConnections(from, conversationId) : (dropConnections(from), { email: false, amazon: false });
  // Amazon signed in on the page: the follow-up the text intro would have run after its link (read
  // their orders, bring back one or two real things), a little after the hello.
  if (moved.amazon) db.createTimer(conversationId, { fireAt: clock.now() + 90_000, note: amazon.followUpNote() });
  log({ websetup_claim: "claimed", setup: row.id, amazon: moved.amazon, email: moved.email, ...(fresh ? {} : { connections: "dropped_late" }) });
  return { setupId: row.id, user: row.user_name, reasonName: row.reason_name || DEFAULT_CARD_NAME, text: withoutCode(text), ...moved };
}

/** What the stand-in holds, moved to the real conversation: Google rows, the Amazon check, the saved browser profile. */
export function moveConnections(from, to) {
  let email = false, amazonOk = false;
  db.atomically(() => {
    // A grant this conversation already has for the same address stays; the setup's copy is dropped.
    for (const t of db.db.prepare("SELECT id, provider, account_label FROM oauth_tokens WHERE conversation_id = ?").all(from)) {
      const clash = db.db.prepare("SELECT 1 FROM oauth_tokens WHERE conversation_id = ? AND provider = ? AND account_label = ?").get(to, t.provider, t.account_label);
      if (clash) db.db.prepare("DELETE FROM oauth_tokens WHERE id = ?").run(t.id);
      else { db.db.prepare("UPDATE oauth_tokens SET conversation_id = ? WHERE id = ?").run(to, t.id); email = true; }
    }
    const rows = db.db.prepare("UPDATE connected_accounts SET conversation_id = ? WHERE conversation_id = ?").run(to, from);
    if (rows.changes) amazonOk = amazon.connected(to);
    db.db.prepare("DELETE FROM oauth_states WHERE conversation_id = ?").run(from);
  });
  // The Amazon sign-in lives in the browser profile it was made in. A brand-new account has none, so
  // the setup's becomes theirs; one that somehow does keeps its own, and the Amazon check goes with it.
  const src = profilePath(from), dst = profilePath(to);
  if (existsSync(src)) {
    if (!existsSync(dst)) { try { renameSync(src, dst); } catch { amazonOk = false; } }
    else { rmSync(src, { recursive: true, force: true }); if (amazonOk) { db.db.prepare("DELETE FROM connected_accounts WHERE conversation_id = ? AND name = 'amazon'").run(to); amazonOk = false; } }
  }
  return { email, amazon: amazonOk };
}

/** Did this conversation do the setup on the web? Then the text intro asks none of it again. */
export function handledOnWeb(conversationId) {
  return on() && !!store.claimedBy(conversationId);
}

/** Everything a setup's stand-in holds, let go. */
export function dropConnections(c) {
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

/** One card's state for the page: none | connecting | connected | failed, and which of three steps. */
export function connectState(row, which, { remoteSession = null } = {}) {
  const c = store.conversationOf(row.id);
  if (which === "amazon") {
    if (amazon.connected(c)) return { state: "connected", step: STEPS, of: STEPS };
    const live = remoteSession ? remoteSession(c) : null;
    if (live) return { state: "connecting", step: live.started ? 2 : 1, of: STEPS };
    if (row.amazon_state === "failed") return { state: "failed", step: 1, of: STEPS };
    return { state: row.amazon_state === "pending" ? "failed" : "none", step: 1, of: STEPS };
  }
  if (db.db.prepare("SELECT 1 FROM oauth_tokens WHERE conversation_id = ? AND provider = 'google'").get(c)) return { state: "connected", step: STEPS, of: STEPS, provider: "gmail" };
  if (row.email_state === "failed") return { state: "failed", step: 1, of: STEPS, provider: "gmail" };
  if (row.email_state === "pending" && db.db.prepare("SELECT 1 FROM oauth_states WHERE conversation_id = ?").get(c)) return { state: "connecting", step: 2, of: STEPS, provider: "gmail" };
  return { state: "none", step: 1, of: STEPS };
}

export function view(row, opts = {}) {
  return {
    id: row.id, code: row.code, user: row.user_name, reasonName: row.reason_name,
    connections: { amazon: connectState(row, "amazon", opts), email: connectState(row, "email", opts) },
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

/** Where a Google callback for a setup sends the person: back to the connect screen, never a thread. */
export function googleCallbackDone(out) {
  const id = store.idOf(out?.conversationId);
  if (!id) return null;
  if (!out.ok) store.setConnectState(id, "email", "failed");
  else store.setConnectState(id, "email", "connected");
  return { status: 302, headers: { Location: back(store.get(id), "email", out.ok), "Cache-Control": "no-store" }, body: "" };
}

/**
 * One request under /setup. `path` is what follows /setup. Returns `{ status, headers, body }`.
 * Seams: `nameLineFor` (the model's line), `amazonLink` (the setup's Connect Amazon link),
 * `googleLink` (the setup's Google link), `remoteSession` (is an Amazon sign-in live).
 */
export async function request({ method = "GET", path = "", query = {}, headers = {}, remoteAddress = "", readBody = async () => "", router = null, log = () => {},
  nameLineFor = (name) => nameLine({ name, web: true }),
  amazonLink = (c) => amazon.setupConnectLink(c, { via: "web_setup", log }),
  googleLink = (c) => google.authorizeUrl(c),
  remoteSession = null } = {}) {
  if (!on()) return json(404, { error: "not found" });
  const ip = clientIp(headers, remoteAddress);
  const secret = store.readSecret(headers.cookie);
  const body = async () => { try { return JSON.parse(String((await readBody()) ?? "") || "{}"); } catch { return null; } };
  const session = remoteSession ?? (await import("./signin-remote.js")).remoteSessionFor;

  if (method === "GET" && path === "/api/capabilities") {
    return json(200, { amazon: !!config.publicUrl && amazon.setupAvailable(), gmail: google.googleStatus().connected === true, outlook: false });
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

  const m = /^\/api\/([A-Za-z0-9_-]{16})(?:\/connect\/(amazon|email))?$/.exec(path);
  if (!m) return json(404, { error: "not found" });
  const row = store.owned(m[1], secret);
  if (!row) return json(404, { error: "not found" });
  const c = store.conversationOf(row.id);

  if (method === "GET" && !m[2]) return json(200, view(row, { remoteSession: session }));

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
    if (!limits.connect(ip)) return json(429, { ok: false, why: "slow_down" });
    if (m[2] === "amazon") {
      const out = amazonLink(c);
      // The sign-in page checks this browser's setup cookie, which lives on the site the setup was made on.
      if (out?.ok && out.url) { const base = siteBase(), o = originFor(row); if (base && o !== base && out.url.startsWith(`${base}/`)) out.url = o + out.url.slice(base.length); }
      store.setConnectState(row.id, "amazon", out?.ok ? "pending" : "failed");
      log({ websetup_connect: "amazon", setup: row.id, ok: !!out?.ok });
      return json(200, out?.ok ? { ok: true, url: out.url } : { ok: false, why: out?.why || "unavailable" });
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
