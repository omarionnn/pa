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
import { profilePath, realProfilePath } from "./browser.js";
import { cookieDomain } from "./pages/siteproxy.js";
import { clientIp } from "./opspassword.js";
import * as invites from "./invites.js";
import { liveLine } from "./contact.js";
import { inTheirNight } from "./notice.js";

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
export function claimFromText({ conversationId, text, address = null, log = () => {} }) {
  if (!on() || !conversationId || store.isSetupConversation(conversationId)) return null;
  const code = codeInText(text);
  if (!code) return claimTextMeReply({ conversationId, text, address, log });
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
 * REASON_INVITE_START: the setup's first text, from a number with NO account, when the setup was
 * started from an invite link. The same proof as any setup claim (the code at the end, and the setup's
 * names in the text); then the invite is spent and the account made in one transaction
 * (invites.claimForSetup → db.redeemInvite), so the invite rules hold exactly as for a texted code:
 * one use, nothing spent before this text, and the losing side of a race is told it was claimed.
 * Null when this is not such a text (the caller carries on: event, texted invite code, admission).
 * The setup itself is claimed right after by claimFromText, on the account this made.
 */
export function claimInviteFromText({ channel, address, text, log = () => {} }) {
  if (!on() || !invites.startOn()) return null;
  const code = codeInText(text);
  if (!code) {
    // A reply, with any words, from the number Reason texted first for an invite setup: the phone is
    // the proof (only it can reply from that number), and the invite is spent the same way, in the
    // same transaction, with the same race rules as a coded first text.
    const pending = store.byTextMe(normalizeE164(address));
    if (!pending?.invite_id || !pending.user_name) return null;
    const out = invites.claimForSetup({ inviteId: pending.invite_id, channel, address, name: nameCase(pending.user_name) });
    log({ websetup_invite: out ? (out.joined ? "joined" : out.reason) : "member", setup: pending.id, invite: pending.invite_id, via: "text_me" });
    return out;
  }
  const row = store.byCode(code);
  if (!row?.invite_id) return null;
  // Without its names the text proves nothing; claimFromText counts the miss if they get in another way.
  if (!row.user_name || !has(text, row.user_name) || !has(text, row.reason_name)) return null;
  const out = invites.claimForSetup({ inviteId: row.invite_id, channel, address, name: nameCase(row.user_name) });
  log({ websetup_invite: out ? (out.joined ? "joined" : out.reason) : "member", setup: row.id, invite: row.invite_id });
  return out;
}

/**
 * The reply to Reason's first text (text-me-first), from an account it just made: the setup that asked
 * Reason to text this number is claimed and its names applied. Nothing the stand-in connected moves:
 * the reply proves the phone, not who built the page, so a setup pointed at somebody else's number
 * hands them no Gmail, Amazon or card. Null when this number has no open setup waiting on it.
 */
function claimTextMeReply({ conversationId, text, address, log }) {
  const row = store.byTextMe(normalizeE164(address));
  if (!row || !row.user_name) return null;
  if (!store.markClaimed(row.id, conversationId)) return null;
  const from = store.conversationOf(row.id);
  db.setAccountName(conversationId, nameCase(row.user_name));
  db.setContactCardName(conversationId, cardName(row.reason_name || DEFAULT_CARD_NAME));
  dropConnections(from);
  log({ websetup_claim: "claimed", setup: row.id, via: "text_me" });
  return { setupId: row.id, user: row.user_name, reasonName: row.reason_name || DEFAULT_CARD_NAME, text: String(text ?? "").trim(),
    email: false, amazon: false, uber: false, card: false, amazonStore: false, viaTextMe: true };
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
  // The real browser's profile (src/browser.js realProfilePath) moves the same way, or goes.
  const rsrc = realProfilePath(from), rdst = realProfilePath(to);
  if (existsSync(rsrc)) {
    if (!existsSync(rdst)) { try { renameSync(rsrc, rdst); } catch { rmSync(rsrc, { recursive: true, force: true }); } }
    else rmSync(rsrc, { recursive: true, force: true });
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
  rmSync(realProfilePath(c), { recursive: true, force: true });
}

/** Setups past their day: what they connected is let go, and the row with it. */
export function sweep(now = clock.now()) {
  for (const id of store.expiredUnclaimed(now)) {
    dropConnections(store.conversationOf(id));
    store.remove(id);
  }
  store.pruneMarks(now);
}

// ---------- the ready screen's way in (first-text, 11-17) ----------
//
// A first text typed by the page can leave the phone as a plain SMS (a green bubble) when the iPhone
// has not yet learned the number does iMessage, and that never reaches Reason. So the ready screen
// tells the server when its text button was tapped (/tapped), asks whether the text arrived
// (/status, every few seconds for two minutes), and when it has not, offers "send it again" and,
// behind REASON_TEXT_ME_FIRST, "i can text you first" (/text-me). An invite setup still unclaimed
// NUDGE_AFTER_MS after the tap gets one line to the inviter (nudgeInviters).

const truthy = (v) => ["1", "true", "on", "yes"].includes(String(v ?? "").trim().toLowerCase());
/**
 * Reason texting first, from its own number (REASON_TEXT_ME_FIRST, default off). Off by default
 * because the Sendblue line on the live install is on the AI Agent plan, which declines a first
 * message to somebody who has not texted it (INBOUND_ONLY_PLAN, seen live 4 times 10-27..11-11).
 * Only for invite setups (REASON_INVITE_START): the invite is the admission rule.
 */
export const textMeOn = () => on() && invites.startOn() && truthy(process.env.REASON_TEXT_ME_FIRST);
/** An invite setup still unclaimed this long after its text button was tapped: the inviter hears. */
export const NUDGE_AFTER_MS = 10 * 60_000;
/** Reason's first texts: tries per setup, per invite (ever), and how many numbers a setup may name (one, changed once). */
export const TEXT_ME = Object.freeze({ perSetup: 2, perInvite: 3, numbers: 2 });
const envCount = (k, d) => { const v = Number.parseInt(String(process.env[k] ?? ""), 10); return Number.isFinite(v) && v >= 0 ? v : d; };
/** Hourly caps on /text-me: per address (REASON_TEXT_ME_IP_HOURLY, 3) and for everybody (REASON_TEXT_ME_HOURLY, 10). */
export const textMeCaps = () => ({ ip: envCount("REASON_TEXT_ME_IP_HOURLY", 3), all: envCount("REASON_TEXT_ME_HOURLY", 10) });

/**
 * A US or Canadian mobile number (the North American plan) as E.164, or null. That is all the line
 * is used for today; anything else is refused rather than guessed at.
 */
export function usCanada(raw) {
  const s = String(raw ?? "").trim().replace(/[\s().\-]/g, "");
  if (!/^\+?\d{10,11}$/.test(s)) return null;
  let d = s.replace(/^\+/, "");
  if (s.startsWith("+") && d.length !== 11) return null;
  if (d.length === 11) { if (d[0] !== "1") return null; d = d.slice(1); }
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? `+1${d}` : null;
}
const normalizeE164 = (address) => usCanada(address) ?? String(address ?? "").trim();

/** A name fit to go in a text to a number nobody has heard from yet: letters only, or nothing. */
const plainName = (v) => { const s = String(v ?? "").trim(); return s && /^[\p{L}' ]{1,40}$/u.test(s) ? s : ""; };

/**
 * Reason's first text to them, in the web welcome's voice ("hey kofi, Jarvis here. you're in, invited
 * by Omari."), but nothing is spent until they answer, so it does not say they are in yet. No link,
 * no number, short: Sendblue declines those before a contact's first reply (limits, pre-reply rules).
 */
export function textMeLine({ user, reasonName, inviter }) {
  const who = plainName(user).toLowerCase();
  const me = cardName(plainName(reasonName) || DEFAULT_CARD_NAME);
  const by = plainName(inviter) || "a friend";
  return `hey${who ? ` ${who}` : ""}, ${me} here. ${by} got you in. say anything back and we're off`;
}

/** The line the inviter gets when their friend's first text has not come (once per setup). */
export function nudgeLine({ who, textMe }) {
  return `${who} got to the last step, but their first text hasn't reached me yet. if it went as a green bubble it won't get to me, so tell them to tap the text button on that page again${textMe ? ", or to ask me to text them first from the same page" : ""}.`;
}

const inviteOf = (row) => row?.invite_id ? db.db.prepare("SELECT id, conversation_id, state FROM invites WHERE id = ?").get(row.invite_id) ?? null : null;

/** What the ready screen is told about text-me-first for this setup. */
function textMeView(row) {
  const inv = inviteOf(row);
  if (!textMeOn() || row.claimed_by || inv?.state !== "unused" || !row.user_name) return { available: false };
  const left = Math.max(0, Math.min(TEXT_ME.perSetup - row.textme_sends, TEXT_ME.perInvite - store.inviteSends(row.invite_id)));
  return { available: left > 0, sent: row.textme_sends > 0, left, canChange: !row.textme_hash || row.textme_sets < TEXT_ME.numbers };
}

/**
 * Tell inviters whose friend tapped the text button NUDGE_AFTER_MS ago and has not arrived. One line
 * per setup, through `say` (runtime.say, the path the join notice takes), never in the inviter's
 * night: a setup due then waits for their morning, and goes only if it is still unclaimed. Returns
 * how many were told.
 */
export function nudgeInviters({ say, now = clock.now(), log = () => {} } = {}) {
  if (!on() || typeof say !== "function") return 0;
  let told = 0;
  for (const row of store.dueNudges(NUDGE_AFTER_MS, now)) {
    const inv = inviteOf(row);
    if (!inv || inv.state !== "unused") { store.markNudged(row.id, now); continue; }
    if (inTheirNight(inv.conversation_id, now)) continue;
    if (!store.markNudged(row.id, now)) continue;
    const who = plainName(row.user_name) ? nameCase(row.user_name) : "your friend";
    try { say(inv.conversation_id, nudgeLine({ who, textMe: textMeOn() })); told++; }
    catch (e) { log({ websetup_nudge_failed: (e?.message ?? String(e)).split("\n")[0] }); continue; }
    log({ websetup_nudge: "told_inviter", setup: row.id, invite: row.invite_id });
  }
  return told;
}

/** /api/<id>/status, /tapped, /text-me. */
async function wayIn({ method, which, id, secret, ip, body, router, log }) {
  if (which === "status" && method === "GET") {
    const row = store.ownedAny(id, secret);
    if (!row) return json(404, { error: "not found" });
    return json(200, { claimed: !!row.claimed_by, tapped: !!row.tapped_at, textMe: textMeView(row) });
  }
  if (method !== "POST") return json(405, { error: "method" });
  const row = store.owned(id, secret);
  if (!row) return json(404, { error: "not found" });
  if (which === "tapped") {
    if (!limits.write(ip)) return json(429, { error: "slow down" });
    if (store.markTapped(row.id)) log({ websetup: "tapped", setup: row.id });
    return json(200, { ok: true });
  }
  // text-me
  if (!textMeOn()) return json(404, { error: "not found" });
  const say = (why, extra = {}) => { log({ websetup_textme: why, setup: row.id }); return json(200, { ok: false, why, ...extra }); };
  const inv = inviteOf(row);
  if (inv?.state !== "unused") return say("no_invite");
  if (!row.user_name) return say("no_name");
  const b = (await body()) ?? {};
  const e164 = usCanada(b.number);
  if (!e164) return say("bad_number");
  if (row.textme_hash && !store.textMeIs(row, e164) && row.textme_sets >= TEXT_ME.numbers) return say("no_more_changes");
  if (row.textme_sends >= TEXT_ME.perSetup || store.inviteSends(row.invite_id) >= TEXT_ME.perInvite) return say("no_more_sends");
  // The caps come before anything that reads who is on Reason, so the page cannot be used to ask
  // about many numbers.
  if (!limits.textMeIp(ip)) { log({ websetup_textme: "slow_down", setup: row.id }); return json(429, { ok: false, why: "slow_down" }); }
  if (!limits.textMeAll("all")) { log({ websetup_textme: "busy", setup: row.id }); return json(429, { ok: false, why: "busy" }); }
  if (db.accountByNumber(e164)) return say("has_account");
  if (db.isBlocked(e164)) return say("cant_reach");
  const live = liveLine(router);
  if (!live || typeof router?.sendNow !== "function") return say("unavailable");
  const line = textMeLine({ user: row.user_name, reasonName: row.reason_name, inviter: invites.inviterName(inv.conversation_id) });
  let out = null;
  try { out = await router.sendNow({ channel: live.name, to: e164, text: line }); } catch (e) { out = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
  // Every try counts against the caps, sent or refused: a refusal is still a request to the provider.
  store.noteTextMeSend(row.id, row.invite_id);
  if (!out?.ok) {
    const said = `${out?.error_key ?? ""} ${out?.error ?? ""}`;
    return say(/INBOUND_ONLY_PLAN/i.test(said) ? "cant_text_first" : /OPTED_OUT/i.test(said) ? "cant_reach" : "not_sent");
  }
  // Linked only once the text went: a reply from that number now claims this setup (until it expires).
  store.setTextMe(row.id, e164);
  log({ websetup_textme: "sent", setup: row.id, invite: row.invite_id });
  const fresh = store.get(row.id);
  return json(200, { ok: true, textMe: textMeView(fresh) });
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

/** The invite a setup carries, for its page: who sent it. Never the token, never a price. */
function inviteView(row) {
  if (!row?.invite_id) return {};
  const inv = db.db.prepare("SELECT conversation_id, state FROM invites WHERE id = ?").get(row.invite_id);
  return inv ? { invite: { from: invites.inviterName(inv.conversation_id) || "A friend", state: inv.state } } : {};
}

export function view(row, opts = {}) {
  return {
    id: row.id, code: row.code, user: row.user_name, reasonName: row.reason_name, ...inviteView(row),
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
// The text-me caps read their env values when made (boot, or resetLimits in a test).
const textMeLimits = () => { const c = textMeCaps(); return { textMeIp: limiter(c.ip, 3_600_000), textMeAll: limiter(c.all, 3_600_000) }; };
export const limits = {
  create: limiter(12, 3_600_000),
  nameLine: limiter(30, 600_000),
  connect: limiter(20, 3_600_000),
  write: limiter(120, 3_600_000),
  ...textMeLimits(),
};
export function resetLimits() {
  limits.create = limiter(12, 3_600_000);
  limits.nameLine = limiter(30, 600_000);
  limits.connect = limiter(20, 3_600_000);
  limits.write = limiter(120, 3_600_000);
  Object.assign(limits, textMeLimits());
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
    // Started from an invite link (REASON_INVITE_START): the setup carries a live invite, read only.
    // A claimed or canceled one is not carried (the page says so and the setup goes on as anybody's).
    const b = invites.startOn() ? ((await body()) ?? {}) : {};
    const inv = b.invite ? invites.inviteForSetup(String(b.invite)) : null;
    const s = store.create(undefined, { origin: o && setupOrigins().includes(o) ? o : "", inviteId: inv?.state === "unused" ? inv.id : null });
    log({ websetup: "created", setup: s.id, ...(inv ? { invite: inv.id, invite_state: inv.state } : {}) });
    return json(201, { id: s.id, code: s.code, expiresAt: s.expiresAt, ...(inv ? { invite: { from: inv.from, state: inv.state } } : {}) }, { "Set-Cookie": setupCookie(s.secret, headers) });
  }

  const w = /^\/api\/([A-Za-z0-9_-]{16})\/(status|tapped|text-me)$/.exec(path);
  if (w) return wayIn({ method, which: w[2], id: w[1], secret, ip, body, router, log });

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
      // keyed by its token alone, so it opens on any browser; no setup cookie, no code. Near the window's
      // end the sign-in would not move to them anyway (and its form's JWT ends at the mark): say so
      // instead of starting one.
      if (clock.now() - row.created_at > PAY_CLAIM_MS - 2 * 60_000) {
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
