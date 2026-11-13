// The save-login link (vault PR 5; design A "The one Reason screen", B4, B8, B9, F; build brief
// docs/account-access-build/pr5.md). The person types a site's login once, on Reason's own page; it is
// sealed inside their browser to the intake key, and Face ID signs exactly this login, for this site,
// under this wording. This file is the link and the signature; the vault (src/savedlogins.js
// saveFromSealed) is the only code that opens what was sealed.
//
//   offerSaveLink   code decides a link may exist: the switch, not the never list, Reason's own browser
//                   reached the site's sign-in form just now (src/browser.js locateSigninPage) on the
//                   site itself, no wall on record. The pinned origin and path come from that visit,
//                   never from the AI and never from a link in mail.
//   viewFor         the page's data: what to show and what to seal to. Never a login.
//   storeFromIntake the page's POST: recompute the challenge from the row and the blob, check Face ID,
//                   claim the link once, hand the blob to the vault.
//
// The link: /web/save-login/<token>, 24 random bytes, kept only as a hash, one use, thirty minutes. Any
// refusal after the link is found closes it: it is refused once and never tried again.
//
// The challenge Face ID signs: SHA-256 over the server's part and the hash of the sealed blob. The
// server's part is SHA-256 of ["reason-login-v1", intake id, person, site, label, pinned origin,
// pinned path, permission, consent version, nonce]. The page is given the server's part for each
// permission it offers and adds the blob's hash itself, so the passkey call can run inside the tap
// (Safari) while the sealing happens as the boxes are typed. An edited row, another permission, or
// a swapped blob gives another challenge, and the signature fails.
import { createHash, randomBytes } from "node:crypto";
import * as db from "./db.js";
import { clock } from "./config.js";
import * as restcrypt from "./restcrypt.js";
import * as passkey from "./passkey.js";
import { classifySite, refusalFor, registrableOf } from "./sitepolicy.js";
import { signinFinding } from "./sitefindings.js";
import {
  savedLoginsMode, savedLoginsAllowedFor, intakeReadyFor, intakePublicKey, saveFromSealed, recordLoginEvent, listLogins, removeLogin,
} from "./savedlogins.js";

export { savedLoginsMode, savedLoginsAllowedFor, intakeReadyFor };

export const INTAKE_TTL_MS = 30 * 60_000;
/** The wording on the page is this version; a change to what Reason does with a login is a new one (B9). */
export const CONSENT_VERSION = "saved-login-v1";
export const LINK_PATH = "/web/save-login/";
const SEALED_MAX = 8_000; // base64url: RSA 4096 wrap (512) + the three fields, well under

/** What the tool returns, whatever happened: one fixed sentence (hard rule 2). The link is its own bubble. */
export const OFFER_SENTENCE = "Here's a link to save that login on Reason's own page. Type it there, not here: I never see it.";

const q = (sql) => db.db.prepare(sql);
const sha = (b) => createHash("sha256").update(b).digest();
const hashToken = (t) => sha(`save-login|${t}`).toString("hex");
const intakeIdOf = (row) => String(row.token_hash).slice(0, 32);
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const log = (c, entry) => { try { recordLoginEvent(c, entry); } catch (e) { console.error(`save link: could not write the record (${e?.code ?? e?.name ?? "error"})`); } };
const oneLine = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const hostOf = (s) => { try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

// ---------------------------------------------------------------- the offer
/**
 * Make a save link for `site`, if code allows one. `quotedRequest`: the person's own words that asked
 * for the job (shown back on the page so a stranger's page can't fake it). `locate`: the visit
 * (src/browser.js locateSigninPage); in a test only a handed-in one runs.
 *   → { ok: true, link, site, label, careful } | { ok: false, error, say? }
 * Never throws for the AI's input; `say` is fixed words where the person should hear why.
 */
export async function offerSaveLink(conversationId, site, quotedRequest, { locate = null, label = "" } = {}) {
  const c = String(conversationId ?? "");
  if (!intakeReadyFor(c)) return { ok: false, error: "not_available" };
  const host = hostOf(String(site ?? ""));
  const verdict = classifySite(host);
  const name = oneLine(label, 40) || host;
  // Hard rule 3: the never list refuses, and says why.
  if (verdict.policy === "never") {
    const s = registrableOf(verdict.host) || "";
    log(c, { site: /^[a-z0-9.-]+$/.test(s) && s.includes(".") ? s : "", event: "refused_never_list", outcome: "stopped" });
    return { ok: false, error: "never_site", say: refusalFor(verdict.category, name) };
  }
  if (!host || !host.includes(".")) return { ok: false, error: "bad_site" };
  const base = registrableOf(host);
  const entry = { site: base, label: name, signin_url: `https://${host}/`, generic: true };
  // A wall on record: no link (a site that will not load is never asked for a login).
  const had = signinFinding(entry);
  if (had?.fresh && had.kind === "walled") return { ok: false, error: "walled" };
  const visit = locate ?? (process.env.NODE_TEST_CONTEXT ? null : (await import("./browser.js")).locateSigninPage);
  if (!visit) return { ok: false, error: "not_reached" };
  let at;
  try { at = await visit(entry); } catch { at = null; }
  if (!at?.found || typeof at.url !== "string") return { ok: false, error: "not_reached" };
  // Hard rule 1: the sign-in page Reason reached is the site's own, over https. A sign-in page on
  // another registrable domain gets no link (an identity host for the site is not handled yet).
  let u;
  try { u = new URL(at.url); } catch { return { ok: false, error: "not_reached" }; }
  if (u.protocol !== "https:" || u.username || u.password || registrableOf(u.hostname) !== base) return { ok: false, error: "off_site" };
  const there = classifySite(u.origin);
  if (there.policy === "never") return { ok: false, error: "never_site", say: refusalFor(there.category, name) };
  const careful = verdict.policy === "careful" || there.policy === "careful";
  const path = /^\/[^?#\s]{0,300}$/.test(u.pathname) ? u.pathname : "/";

  const token = randomBytes(24).toString("base64url");
  const now = clock.now();
  // One open link per person and site: an older one closes.
  q("UPDATE login_intake SET claimed_at = ? WHERE conversation_id = ? AND site = ? AND claimed_at IS NULL").run(now, c, base);
  q(`INSERT INTO login_intake (token_hash, conversation_id, site, label, signin_origin, signin_path, quoted_request, permission_offered,
      consent_version, nonce, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(hashToken(token), c, base, name, u.origin, path, restcrypt.sealFor(c, oneLine(quotedRequest, 200)),
      careful ? "each_time" : "standing", CONSENT_VERSION, randomBytes(16).toString("base64url"), now, now + INTAKE_TTL_MS);
  log(c, { site: base, event: "link_sent", outcome: "ok" });
  return { ok: true, link: `${passkey.ORIGIN()}${LINK_PATH}${token}`, site: base, label: name, careful };
}

// ---------------------------------------------------------------- the challenge
/** The permissions a link may be saved under: a careful site only ever "each time". */
export const permissionsOf = (row) => (row.permission_offered === "standing" ? ["standing", "each_time"] : ["each_time"]);
/** The server's part of the challenge for one permission (32 bytes). Recomputed from the row at save time. */
export function serverPart(row, permission) {
  return sha(JSON.stringify(["reason-login-v1", intakeIdOf(row), row.conversation_id, row.site, row.label, row.signin_origin, row.signin_path,
    permission, row.consent_version, row.nonce]));
}
/** The WebAuthn challenge: SHA-256(server's part | SHA-256(sealed blob)), base64url. The page computes the same. */
export const challengeOf = (part, sealed) => sha(Buffer.concat([part, sha(sealed)])).toString("base64url");

// ---------------------------------------------------------------- the row
// The token IS the identity here (a link anyone may open): looked up by its hash alone, as an
// approval link is; every statement after this one names the row's person.
function rowFor(token) {
  if (!TOKEN_RE.test(String(token ?? ""))) return null;
  return q("SELECT * FROM login_intake WHERE token_hash = ?").get(hashToken(token)) ?? null;
}
const stateOf = (row, now = clock.now()) => (row.claimed_at ? "used" : row.expires_at < now ? "expired" : "open");
const close = (row) => q("UPDATE login_intake SET claimed_at = ? WHERE token_hash = ? AND conversation_id = ? AND claimed_at IS NULL").run(clock.now(), row.token_hash, row.conversation_id);

/**
 * The page's data contract. null: no such link, or the vault is off for its person (the page is then
 * the same 404 as an unknown address). Never a login; the quoted request is theirs, opened for them.
 *   { state: open|used|expired, site, label, host, path, quoted, careful, warning, permissions,
 *     consentVersion, expiresAt, intakeId, parts: { [permission]: base64url }, publicKey (SPKI base64url),
 *     passkey: { ok, options } | { ok: false, error: no_passkey|cooling_off } }
 */
export async function viewFor(token) {
  const row = rowFor(token);
  if (!row || !intakeReadyFor(row.conversation_id)) return null;
  const state = stateOf(row);
  const verdict = classifySite(row.signin_origin);
  const base = {
    state, site: row.site, label: row.label, host: new URL(row.signin_origin).host, path: row.signin_path,
    quoted: restcrypt.openAny(row.quoted_request) ?? "", careful: row.permission_offered !== "standing",
    warning: row.permission_offered !== "standing" ? oneLine(verdict.reason, 200) : "",
    permissions: permissionsOf(row), consentVersion: row.consent_version, expiresAt: row.expires_at, conversationId: row.conversation_id,
  };
  if (state !== "open") return base;
  return {
    ...base, intakeId: intakeIdOf(row),
    parts: Object.fromEntries(permissionsOf(row).map((p) => [p, serverPart(row, p).toString("base64url")])),
    publicKey: await intakePublicKey(),
    passkey: passkey.loginAssertionOptions(row.conversation_id),
  };
}

// ---------------------------------------------------------------- the save
// Which record line a failed save writes: the vault's own codes map to its fixed outcomes.
const OUTCOME = { unwrap_failed: "unwrap_failed", open_failed: "open_failed", kms_failed: "unwrap_failed" };

/**
 * The page's POST: { sealed (base64url), permission, assertion }. null: no such link / vault off (404).
 *   → { ok: true, site, label, state: "unverified" } | { ok: false, error }
 * Hard rule 4: a used, expired, re-signed or swapped one is refused once, the link closes, nothing is retried.
 */
export async function storeFromIntake(token, body) {
  const row = rowFor(token);
  if (!row || !intakeReadyFor(row.conversation_id)) return null;
  const c = row.conversation_id;
  const refuse = (error, outcome = "stopped") => {
    close(row);
    log(c, { site: row.site, event: "save_failed", outcome });
    return { ok: false, error };
  };
  const state = stateOf(row);
  if (state !== "open") return refuse(`link_${state}`);
  const permission = String(body?.permission ?? "");
  if (!permissionsOf(row).includes(permission)) return refuse("bad_permission");
  const b64 = String(body?.sealed ?? "");
  if (!b64 || b64.length > SEALED_MAX || !/^[A-Za-z0-9_-]+$/.test(b64)) return refuse("bad_sealed");
  const sealed = Buffer.from(b64, "base64url");
  if (sealed.toString("base64url") !== b64) return refuse("bad_sealed");
  // The site must still be one a login may be kept for, by today's list.
  const verdict = classifySite(row.signin_origin);
  if (verdict.policy === "never") return refuse("never_site");
  if (verdict.policy === "careful" && permission === "standing") return refuse("careful_needs_each_time");
  const signed = await passkey.verifyLoginAssertion(c, challengeOf(serverPart(row, permission), sealed), body?.assertion);
  if (!signed.ok) return refuse(signed.error);
  // Claimed once: a second POST, or the same one again, finds it used.
  const now = clock.now();
  if (q("UPDATE login_intake SET claimed_at = ? WHERE token_hash = ? AND conversation_id = ? AND claimed_at IS NULL AND expires_at >= ?").run(now, row.token_hash, c, now).changes !== 1) {
    log(c, { site: row.site, event: "save_failed", outcome: "stopped" });
    return { ok: false, error: "link_used" };
  }
  try {
    const out = await saveFromSealed(c, {
      site: row.site, label: row.label, signinOrigin: row.signin_origin, signinPath: row.signin_path, permission,
      consentVersion: row.consent_version, consentAt: now, consentCredential: signed.credentialId,
    }, sealed, intakeIdOf(row));
    return { ok: true, site: out.site, label: row.label, state: out.state };
  } catch (e) {
    const code = typeof e?.code === "string" ? e.code : "store_failed";
    log(c, { site: row.site, event: "save_failed", outcome: OUTCOME[code] ?? "stopped" });
    return { ok: false, error: code };
  }
}

// ---------------------------------------------------------------- forgetting
/**
 * "Forget my <site> login": every saved login for that site goes (row, ciphertext and wrapped key), no
 * Face ID (the safe direction, design B8). Works with the switch off. → number removed.
 */
export function forgetSite(conversationId, site, { purpose = "" } = {}) {
  const base = registrableOf(hostOf(String(site ?? "")));
  if (!base) return 0;
  let n = 0;
  for (const l of listLogins(conversationId)) if (l.site === base && removeLogin(conversationId, l.id, { purpose })) n++;
  return n;
}

// ---------------------------------------------------------------- the page's own sealing
/**
 * The page's sealing, run in the person's browser (its source is drawn into the page) and by the tests
 * in Node's WebCrypto. A fresh AES-256-GCM key seals the three fields; RSA-OAEP SHA-256 wraps that key
 * to the intake public key. → the sealed bytes (Uint8Array), the layout src/savedlogins.js reads.
 * Self-contained: it runs from its own source text, so it may name nothing outside itself.
 */
export async function sealInBrowser(subtle, spkiBytes, intakeId, username, password, setupKey) {
  const enc = new TextEncoder();
  const parts = [username, password, setupKey || ""].map((s) => enc.encode(String(s)));
  let n = 0;
  for (const p of parts) { if (p.length > 0xffff) throw new Error("too long"); n += 2 + p.length; }
  const plain = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { plain[at] = p.length >> 8; plain[at + 1] = p.length & 0xff; plain.set(p, at + 2); at += 2 + p.length; }
  const pub = await subtle.importKey("spki", spkiBytes, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = new Uint8Array(12);
  (globalThis.crypto || self.crypto).getRandomValues(iv);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`sl-intake1|${intakeId}`) }, key, plain));
  plain.fill(0);
  const wrapped = new Uint8Array(await subtle.wrapKey("raw", key, pub, { name: "RSA-OAEP" }));
  const out = new Uint8Array(3 + wrapped.length + 12 + ct.length);
  out[0] = 1; out[1] = wrapped.length >> 8; out[2] = wrapped.length & 0xff;
  out.set(wrapped, 3); out.set(iv, 3 + wrapped.length); out.set(ct, 3 + wrapped.length + 12);
  return out;
}

// ---------------------------------------------------------------- a password sent by text
// A password texted into the thread is never used: not saved, not typed, not shown to the AI. The
// router (src/channels/router.js) swaps the stored copy for PASSWORD_PLACEHOLDER before the message
// is claimed, then answers with fixed words and the page's link instead of a turn. Narrow on purpose:
// only while this person has an open save link, and only a message that says "password is …", or one
// bare token of 8 to 128 characters with letters and digits that is not a link, an address or a code.
// A plain word ("perfect!", "thanks") is never taken for a password.
export const PASSWORD_PLACEHOLDER = "[they texted what looked like a password; Reason did not keep it and pointed them to the save page]";
export const TEXTED_PASSWORD_WORDS = "Don't text me passwords: texts are kept by your phone company and in my history. Use this instead:";
// "password is X" / "password: X" with X the last thing said, and X not a plain word ("password is wrong").
const PASSWORD_SAID = /\b(?:pass ?word|passcode|pwd)\s*(?:is|was|=|:|-)\s*(\S{6,128})\s*$/i;
const notAWord = (tok) => { const t = tok.replace(/[.!?,;]+$/, ""); return t.length >= 6 && /\p{L}/u.test(t) && /[^\p{L}]/u.test(t); };
const openLinkOf = (c) => q("SELECT * FROM login_intake WHERE conversation_id = ? AND claimed_at IS NULL AND expires_at >= ? ORDER BY created_at DESC LIMIT 1").get(c, clock.now()) ?? null;

/** Does this text look like a password sent while a save link is open for them? Never stores or logs it. */
export function looksLikeTextedPassword(conversationId, text) {
  const c = String(conversationId ?? "");
  if (!c || !intakeReadyFor(c) || !openLinkOf(c)) return false;
  const t = String(text ?? "").trim();
  const said = PASSWORD_SAID.exec(t);
  if (said) return notAWord(said[1]);
  if (!/^\S{8,128}$/.test(t) || /^(?:https?:|www\.)|@|^[0-9]+$/i.test(t)) return false;
  return /\p{L}/u.test(t) && /[0-9]/.test(t);
}

/**
 * The fixed answer to a texted password, with the page's link. The token was kept only as a hash, so
 * the open link gets a fresh token (the same pinned site, the same deadline); the old one stops
 * working. Called once the message is claimed, so a retried delivery never re-issues it. null: no link open.
 */
export function textedPasswordReply(conversationId) {
  const row = openLinkOf(String(conversationId ?? ""));
  if (!row) return null;
  const token = randomBytes(24).toString("base64url");
  if (q("UPDATE login_intake SET token_hash = ? WHERE token_hash = ? AND conversation_id = ? AND claimed_at IS NULL").run(hashToken(token), row.token_hash, row.conversation_id).changes !== 1) return null;
  return `${TEXTED_PASSWORD_WORDS}\n${passkey.ORIGIN()}${LINK_PATH}${token}`;
}
