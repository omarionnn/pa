// Purchase approval by passkey: Face ID / Touch ID (or the device PIN) on the person's own phone or
// computer approves one Crossmint payment, for its exact amount, at its exact store. Behind
// REASON_PASSKEY_PAY (off | owner | on), off by default, and only where Crossmint checkouts are on.
//
// Why our own passkey and not Crossmint's (docs.crossmint.com, read 2026-10-31): Crossmint's passkey
// belongs to a card NETWORK rail of an order intent (Visa's or Mastercard's own verification, shown by
// OrderIntentVerification). Agent Checkouts use that network rail when it is ready and otherwise the
// `encrypted-card` rail, so Crossmint's passkey would gate some payments, on some cards, some of the
// time. This one gates every payment Reason answers.
//
// The `encrypted-card` rail is NOT always ready (this file said it "never needs verification" until
// 2026-11-08): Crossmint keeps a saved card's CVC for a limited time, and once it lapses the rail reads
// `pending_cvc_recollection` and the checkout cannot fill the card (the owner's Amazon run 650f8c4c that
// day). src/shopconnect.js reads the intent's rails after making it; when the CVC is needed, the approve
// page collects it right after Face ID in Crossmint's own hosted field (CrossmintCvcRecollection), and
// only then is the order intent handed to the checkout.
//
// What makes a yes here stronger than a texted yes:
//   **User verification required.** Options ask for it and the assertion must carry the UV flag:
//   presence alone (a tap) never pays. On an iPhone that is Face ID, or the passcode.
//   **Bound to the payment.** The WebAuthn challenge is a hash of the payment row (its id, run, request,
//   amount, currency, store, item) and a random nonce kept with the link. The server recomputes it
//   from the row when the assertion comes back, so an assertion made for one payment can't pay another
//   amount, another store or another request, and a row that changed since the link was made pays
//   nothing (`details_changed`).
//   **One link, one use, thirty minutes.** The link's token is kept only as a hash; it is claimed with
//   one UPDATE … WHERE state = 'open', so two taps can't both pay; it runs out at thirty minutes (it was
//   five, cut further by Crossmint's ten-minute hold, until 2026-11-07: one face wash took 20 hours, and
//   the CVS link died before he reached it). The store's own hold still decides whether a tap can pay:
//   when it lets go first, src/shopconnect.js asks the store again and texts a fresh link.
//   **heyreason.com only.** The origin and RP ID are fixed server-side. A passkey made for heyreason.com
//   can't be used by a lookalike site at all (the browser refuses), and a response signed anywhere
//   else fails the origin check.
//   **The sign counter.** Kept per passkey; a counter that goes backwards is refused (synced passkeys
//   report 0 and stay 0, which is allowed).
//   **A new passkey waits.** The first one works at once. Any later one (a lost phone, a second
//   device) can approve only after COOL_MS, and Reason texts the person when it's added, so somebody
//   who got into their Reason Web can't add a passkey and pay with it before they hear about it.
//
// Logged (pay_approval_log): what happened to which payment, and its amount and store. Never a card
// detail (none ever comes here), never a credential's key.
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { clock } from "./config.js";

// ---------------------------------------------------------------- the flag
export function passkeyMode() {
  const v = String(process.env.REASON_PASSKEY_PAY ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}
export function passkeyAllowedFor(conversationId) {
  if (!conversationId) return false;
  const mode = passkeyMode();
  if (mode === "owner") return accounts.featureOwner(conversationId);
  return mode === "on";
}

/** Where the passkey lives. Web is on the website (heyreason.com), never on the API host. */
export const ORIGIN = () => new URL(process.env.REASON_PASSKEY_ORIGIN || process.env.REASON_SITE_URL || "https://heyreason.com").origin;
export const RP_ID = () => new URL(ORIGIN()).hostname;
/** The origins an assertion may name: the site, and its www. form (the same RP ID; the browser signs whichever host served the page). */
export function ORIGINS() {
  const o = new URL(ORIGIN());
  const alt = o.hostname.startsWith("www.") ? o.hostname.slice(4) : `www.${o.hostname}`;
  const bare = o.hostname.replace(/^\[|\]$/g, "");
  return o.hostname === "localhost" || isIP(bare) ? [o.origin] : [o.origin, `${o.protocol}//${alt}${o.port ? `:${o.port}` : ""}`];
}
export const APPROVAL_TTL_MS = 30 * 60_000;
export const COOL_MS = 24 * 3600_000;
const REG_TTL_MS = 5 * 60_000;

db.db.exec(`
  CREATE TABLE IF NOT EXISTS pay_passkeys (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '',
    device_type TEXT NOT NULL DEFAULT '',
    backed_up INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    usable_at INTEGER NOT NULL,
    last_used_at INTEGER,
    removed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS pay_passkeys_by_conv ON pay_passkeys (conversation_id);
  CREATE TABLE IF NOT EXISTS pay_passkey_regs (
    conversation_id TEXT PRIMARY KEY,
    challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pay_approvals (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    payment_id INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    challenge TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    credential_id TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS pay_approval_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    payment_id INTEGER,
    event TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    amount TEXT NOT NULL DEFAULT '',
    merchant TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  );
`);
const q = (sql) => db.db.prepare(sql);
// What a link approves (2026-10-31): 'pay' is a payment row (shop_payments); 'cap' is a raise of the
// person's daily spending limit (src/spendcap.js cap_changes). payment_id holds that kind's row id, so
// every match on it carries the kind too. The column is added to a live table, so ALTER, not CREATE.
if (!q("PRAGMA table_info(pay_approvals)").all().some((c) => c.name === "kind")) db.db.exec("ALTER TABLE pay_approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'pay'");
const kindOf = (x) => x?.kind ?? "pay";
const sha = (s) => createHash("sha256").update(s).digest();
const hashToken = (t) => sha(`pay-approval|${t}`).toString("hex");

let sayFn = null;
/** src/shopconnect.js hands over how to text a person (serve.js → shop.attach). */
export function attach({ say } = {}) { sayFn = say ?? null; }
const tell = async (c, text) => { try { if (sayFn) await sayFn(c, text); } catch { /* the passkey is saved either way */ } };

/** Every approval, decline and refusal: the payment, its amount and store, and why. Never a card detail. */
export function logEvent(conversationId, row, event, detail = "") {
  q("INSERT INTO pay_approval_log (conversation_id, payment_id, event, detail, amount, merchant, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(conversationId, row && kindOf(row) === "pay" ? row.id : null, event, String(detail).slice(0, 80), row ? `${row.amount} ${row.currency}` : "", row?.merchant_name ?? "", clock.now());
}
export const approvalLog = (conversationId) => q("SELECT payment_id, event, detail, amount, merchant, at FROM pay_approval_log WHERE conversation_id = ? ORDER BY id").all(conversationId);

// ---------------------------------------------------------------- passkeys
const live = (c) => q("SELECT * FROM pay_passkeys WHERE conversation_id = ? AND removed_at IS NULL ORDER BY created_at").all(c);
export const hasPasskey = (c) => live(c).length > 0;
/** Once someone has a passkey, a texted yes never pays again: the yes gets the Face ID link. */
export const requiredFor = (c) => passkeyAllowedFor(c) && hasPasskey(c);
/** For Settings: when it was set up, and whether a newer one is still waiting. Never a key. `ref` names it for removePasskey. */
export function passkeysOf(c) {
  return live(c).map((p) => ({ ref: refOf(p.id), createdAt: p.created_at, usableAt: p.usable_at, lastUsedAt: p.last_used_at, synced: !!p.backed_up }));
}
const refOf = (id) => sha(`pay-passkey-ref|${id}`).toString("hex").slice(0, 16);
/**
 * Take a passkey off (the safe direction: no Face ID, design B8). It stops approving at once and
 * passkeysOf no longer lists it; the row stays with removed_at set, so a later passkey still waits
 * COOL_MS like any second one. `ref` from passkeysOf. Returns whether one was removed.
 */
export function removePasskey(conversationId, ref) {
  const p = live(conversationId).find((k) => refOf(k.id) === String(ref ?? ""));
  if (!p) return false;
  const done = q("UPDATE pay_passkeys SET removed_at = ? WHERE id = ? AND conversation_id = ? AND removed_at IS NULL").run(clock.now(), p.id, conversationId).changes === 1;
  if (done) logEvent(conversationId, null, "passkey_removed");
  return done;
}
const descriptor = (p) => ({ id: p.id, transports: p.transports ? p.transports.split(",") : undefined });

/** An opaque per-person id for the authenticator: a hash, never their number or conversation. */
const userIdOf = (c) => new Uint8Array(sha(`reason-pay-user|${c}`).subarray(0, 16));

/**
 * Step 1 of adding a passkey (signed in to Web, flag on). The challenge is kept, single use, 5 minutes.
 * `allowed`: the caller's own switch, for a page outside purchases (the save-login page passes the
 * vault's); otherwise REASON_PASSKEY_PAY decides. One passkey per person serves both. Named "Reason".
 */
export async function registrationOptions(conversationId, { allowed = null } = {}) {
  if (!(allowed ?? passkeyAllowedFor(conversationId))) return { ok: false, error: "not_available" };
  const options = await generateRegistrationOptions({
    // The save-login page (it passes `allowed`) names it "Reason"; the purchase page keeps its old names,
    // so with the vault off nothing a person sees changes (review 2026-11-13).
    rpName: "Reason", rpID: RP_ID(), userID: userIdOf(conversationId),
    userName: allowed === null ? "Purchases" : "Reason", userDisplayName: allowed === null ? "Reason purchases" : "Reason",
    attestationType: "none", timeout: 120_000,
    excludeCredentials: live(conversationId).map(descriptor),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    preferredAuthenticatorType: "localDevice",
  });
  q(`INSERT INTO pay_passkey_regs (conversation_id, challenge, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (conversation_id) DO UPDATE SET challenge = excluded.challenge, expires_at = excluded.expires_at`)
    .run(conversationId, options.challenge, clock.now() + REG_TTL_MS);
  return { ok: true, options };
}

/** Step 2: the browser's answer. Saved only if it verifies with UV, for heyreason.com, against our challenge. `for: "login"`: the save-login page's words. */
export async function register(conversationId, response, { allowed = null, for: purpose = "pay" } = {}) {
  if (!(allowed ?? passkeyAllowedFor(conversationId))) return { ok: false, error: "not_available" };
  const reg = q("SELECT * FROM pay_passkey_regs WHERE conversation_id = ?").get(conversationId);
  q("DELETE FROM pay_passkey_regs WHERE conversation_id = ?").run(conversationId);
  if (!reg || reg.expires_at < clock.now()) return { ok: false, error: "expired" };
  let out;
  try {
    out = await verifyRegistrationResponse({ response, expectedChallenge: reg.challenge, expectedOrigin: ORIGIN(), expectedRPID: RP_ID(), requireUserVerification: true });
  } catch { return { ok: false, error: "not_verified" }; }
  if (!out?.verified || !out.registrationInfo) return { ok: false, error: "not_verified" };
  const { credential, credentialDeviceType, credentialBackedUp } = out.registrationInfo;
  if (q("SELECT 1 FROM pay_passkeys WHERE id = ?").get(credential.id)) return { ok: false, error: "already_saved" };
  // The first passkey works at once (until now a texted yes paid). Any later one waits, and they hear.
  const before = q("SELECT COUNT(*) AS n FROM pay_passkeys WHERE conversation_id = ?").get(conversationId).n;
  const now = clock.now();
  const usableAt = before ? now + COOL_MS : now;
  q(`INSERT INTO pay_passkeys (id, conversation_id, public_key, counter, transports, device_type, backed_up, created_at, usable_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(credential.id, conversationId, Buffer.from(credential.publicKey), credential.counter ?? 0,
    (credential.transports ?? []).join(","), credentialDeviceType ?? "", credentialBackedUp ? 1 : 0, now, usableAt);
  logEvent(conversationId, null, before ? "passkey_added_cooling" : "passkey_added");
  if (purpose === "login") {
    await tell(conversationId, before
      ? "A new Face ID was just set up for Reason. It can approve anything from tomorrow at this time. If that wasn't you, tell me now and I'll take it off."
      : "Face ID is set up for Reason. Saving a login, and widening what I may do with one, needs it.");
    return { ok: true, coolingUntil: before ? usableAt : null };
  }
  await tell(conversationId, before
    ? "A new Face ID was just set up to approve your purchases. It can approve payments from tomorrow at this time. If that wasn't you, tell me now and I'll take it off."
    : "Face ID now approves your purchases. When I'm about to pay, I'll text you a link; a texted yes on its own won't pay anymore.");
  return { ok: true, coolingUntil: before ? usableAt : null };
}

// ---------------------------------------------------------------- approval links
/**
 * The challenge for one payment: SHA-256 over the fields that say what is being paid, and the link's
 * nonce. Recomputed from the row at verify time, so it is the payment itself that is signed.
 */
export function bindingChallenge(row, nonce) {
  // A raise of the daily limit signs the change itself: which one, whose, from what to what.
  const fields = kindOf(row) === "cap"
    ? ["reason-cap-v1", row.id, row.conversation_id, row.from_cents, row.to_cents, row.amount, nonce]
    : ["reason-pay-v1", row.id, row.conversation_id, row.run_id, row.request_id, row.amount_kind, row.amount, row.currency,
      row.merchant_name, row.merchant_url, row.merchant_country, row.item, nonce];
  return sha(JSON.stringify(fields)).toString("base64url");
}

/**
 * A fresh link for an asked payment. The token is returned once; only its hash is kept. Older open links
 * for it close. It lasts APPROVAL_TTL_MS, or to `until` when sooner (a checkout asked again after the
 * store let go keeps the first ask's half hour, not a new one). Crossmint's hold on the row (expires_at)
 * no longer cuts the link: a tap past it pays nothing (payRow refuses an expired row), and the store is
 * asked again by code instead of the link dying at minute ten.
 */
export function createApproval(row, { until = null } = {}) {
  const token = randomBytes(24).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const now = clock.now();
  // A raise of the daily limit keeps its own question's deadline (src/spendcap.js changeTtlMs).
  const own = kindOf(row) === "cap" && row.expires_at ? Date.parse(row.expires_at) : NaN;
  const expiresAt = Math.min(now + APPROVAL_TTL_MS, Number.isFinite(until) && until > now ? until : Infinity, Number.isFinite(own) ? own : Infinity);
  q("UPDATE pay_approvals SET state = 'replaced' WHERE payment_id = ? AND kind = ? AND state = 'open'").run(row.id, kindOf(row));
  q(`INSERT INTO pay_approvals (id, conversation_id, payment_id, kind, nonce, challenge, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
    .run(hashToken(token), row.conversation_id, row.id, kindOf(row), nonce, bindingChallenge(row, nonce), now, expiresAt);
  logEvent(row.conversation_id, row, "link_sent");
  return token;
}
export function approvalFor(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token ?? ""))) return null;
  const a = q("SELECT * FROM pay_approvals WHERE id = ?").get(hashToken(token)) ?? null;
  if (a && a.state === "open" && a.expires_at < clock.now()) {
    q("UPDATE pay_approvals SET state = 'expired' WHERE id = ? AND state = 'open'").run(a.id);
    return { ...a, state: "expired" };
  }
  return a;
}
/** The link still open for a payment, if one is (and still in its time); else null. */
export function openApprovalFor(paymentId, kind = "pay") {
  const a = q("SELECT * FROM pay_approvals WHERE payment_id = ? AND kind = ? AND state = 'open' ORDER BY created_at DESC").get(paymentId, kind) ?? null;
  return a && a.expires_at >= clock.now() ? a : null;
}
/** Claims an open link (the CVC step's finish, src/shopconnect.js payAfterCvc): once, and only under the nonce it was read with. */
export const claimApproval = (a) => q("UPDATE pay_approvals SET state = 'used', used_at = ? WHERE id = ? AND state = 'open' AND nonce = ? AND expires_at >= ?").run(clock.now(), a.id, a.nonce, clock.now()).changes === 1;
export const closeApproval = (a, state) => q("UPDATE pay_approvals SET state = ? WHERE id = ? AND state = 'open'").run(state, a.id).changes === 1;

/** What the page asks the browser for: this link's bound challenge, this person's usable passkeys, UV required. */
export async function approvalOptions(a) {
  const now = clock.now();
  const keys = live(a.conversation_id).filter((p) => p.usable_at <= now);
  if (!keys.length) return { ok: false, error: hasPasskey(a.conversation_id) ? "cooling_off" : "no_passkey" };
  const options = await generateAuthenticationOptions({ rpID: RP_ID(), challenge: Buffer.from(a.challenge, "base64url"), allowCredentials: keys.map(descriptor), userVerification: "required", timeout: 120_000 });
  return { ok: true, options };
}

/**
 * The browser's assertion for a link, checked against the payment row as it is NOW. On success the link
 * is claimed (used) and { ok: true } returned; the caller then pays. Every refusal says why.
 */
export async function verifyApproval(a, row, response) {
  const fail = (error) => { logEvent(a.conversation_id, row, "rejected", error); return { ok: false, error }; };
  if (a.state !== "open") return fail(`link_${a.state}`);
  if (a.expires_at < clock.now()) { closeApproval(a, "expired"); return fail("link_expired"); }
  if (!row || row.id !== a.payment_id || row.conversation_id !== a.conversation_id || kindOf(row) !== kindOf(a)) return fail("no_such_payment");
  if (row.status !== "asked" || row.amount_kind !== "exact") return fail(`payment_${row.status !== "asked" ? row.status : "not_exact"}`);
  // The row must still be the payment the link was made for: amount, store, item, request.
  if (bindingChallenge(row, a.nonce) !== a.challenge) return fail("details_changed");
  const cred = typeof response?.id === "string" ? q("SELECT * FROM pay_passkeys WHERE id = ? AND conversation_id = ? AND removed_at IS NULL").get(response.id, a.conversation_id) : null;
  if (!cred) return fail("unknown_passkey");
  if (cred.usable_at > clock.now()) return fail("cooling_off");
  let out;
  try {
    out = await verifyAuthenticationResponse({
      response, expectedChallenge: a.challenge, expectedOrigin: ORIGINS(), expectedRPID: RP_ID(), requireUserVerification: true,
      credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: cred.transports ? cred.transports.split(",") : undefined },
    });
  } catch (e) { return fail(/counter/i.test(e?.message ?? "") ? "counter" : /verif/i.test(e?.message ?? "") ? "no_user_verification" : "not_verified"); }
  if (!out?.verified || !out.authenticationInfo?.userVerified) return fail("not_verified");
  // Claimed once: a second tap, or the same assertion again, finds it used.
  if (q("UPDATE pay_approvals SET state = 'used', used_at = ?, credential_id = ? WHERE id = ? AND state = 'open'").run(clock.now(), cred.id, a.id).changes !== 1) return fail("link_used");
  q("UPDATE pay_passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(out.authenticationInfo.newCounter ?? cred.counter, clock.now(), cred.id);
  logEvent(a.conversation_id, row, "approved");
  return { ok: true };
}

// ---------------------------------------------------------------- a saved login (kind 'login', vault PR 5)
// The save page signs one login for one site under one wording (src/loginintake.js builds the
// challenge from the link's row and the hash of the sealed blob). The link itself is the login_intake
// row, one use; here only the passkey part: options for the page, and the check of what came back.

/** What the save page needs to ask for Face ID: this person's usable passkeys, UV required. The page supplies the challenge. */
export function loginAssertionOptions(conversationId) {
  const now = clock.now();
  const keys = live(conversationId).filter((p) => p.usable_at <= now);
  if (!keys.length) return { ok: false, error: hasPasskey(conversationId) ? "cooling_off" : "no_passkey" };
  return { ok: true, options: { rpId: RP_ID(), timeout: 120_000, userVerification: "required", allowCredentials: keys.map((p) => ({ type: "public-key", ...descriptor(p) })) } };
}

/**
 * Check an assertion over `challenge` (base64url, recomputed by the caller from the link's row and the
 * blob): one of this person's passkeys, past its wait, Face ID or passcode (UV), heyreason.com, the sign
 * counter. → { ok: true, credentialId } | { ok: false, error }. Logged as kind login, never the assertion.
 */
export async function verifyLoginAssertion(conversationId, challenge, response) {
  const fail = (error) => { logEvent(conversationId, null, "login_rejected", error); return { ok: false, error }; };
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(challenge ?? ""))) return fail("bad_challenge");
  const cred = typeof response?.id === "string" ? q("SELECT * FROM pay_passkeys WHERE id = ? AND conversation_id = ? AND removed_at IS NULL").get(response.id, conversationId) : null;
  if (!cred) return fail("unknown_passkey");
  if (cred.usable_at > clock.now()) return fail("cooling_off");
  let out;
  try {
    out = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: ORIGINS(), expectedRPID: RP_ID(), requireUserVerification: true,
      credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: cred.transports ? cred.transports.split(",") : undefined },
    });
  } catch (e) { return fail(/counter/i.test(e?.message ?? "") ? "counter" : /challenge/i.test(e?.message ?? "") ? "details_changed" : /verif/i.test(e?.message ?? "") ? "no_user_verification" : "not_verified"); }
  if (!out?.verified || !out.authenticationInfo?.userVerified) return fail("not_verified");
  q("UPDATE pay_passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND conversation_id = ?").run(out.authenticationInfo.newCounter ?? cred.counter, clock.now(), cred.id, conversationId);
  logEvent(conversationId, null, "login_approved");
  return { ok: true, credentialId: cred.id };
}

/**
 * The payment did not start (no order intent, so nothing could have been charged — 2026-10-31 at CVS:
 * Face ID passed, Crossmint refused the order intent, and the link stayed "used", so the second tap
 * found nothing to approve). The link is opened again for a fresh tap, under a NEW nonce: the
 * assertion just made signs the old challenge and cannot pay later. The deadline does not move.
 * Never called once the card may have reached the store (unknown_outcome): that link stays used.
 */
export function reopenApproval(a, row, why = "") {
  const nonce = randomBytes(16).toString("base64url");
  const r = q("UPDATE pay_approvals SET state = 'open', used_at = NULL, credential_id = '', nonce = ?, challenge = ? WHERE id = ? AND state = 'used'")
    .run(nonce, bindingChallenge(row, nonce), a.id);
  if (r.changes !== 1) return false;
  // One open link per payment, as createApproval keeps it: any other made meanwhile closes.
  q("UPDATE pay_approvals SET state = 'replaced' WHERE payment_id = ? AND kind = ? AND state = 'open' AND id != ?").run(row.id, kindOf(row), a.id);
  logEvent(a.conversation_id, row, "link_reopened", why);
  return true;
}
