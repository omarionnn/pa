// Reason's own contact card, and when it goes out.
//
// Every page link Reason ever texted arrived as bare blue text, and the biggest reason is Apple's:
// a phone will not expand a link from a number that is not in the recipient's Contacts. Sendblue
// says so twice — the FAQ ("Apple blocks your phone from expanding links when a sender is not in
// your contact list") and guides/contact-card ("it allows any links you send to expand on the end
// users phone") — and their fix is the one here: send the person a contact card to save.
// Omari, 2026-10-06: "let's do the contact card."
//
// The card is a vCard this process serves itself (GET /reason-<sha8>.vcf, see contactCardUrl). Sendblue fetches `media_url`
// from its side, the file "must end with .vcf or .vcard", and the address has to be reachable from
// the internet — so without REASON_PUBLIC_URL there is no card to send and nothing here pretends.
//
// It goes out ONCE per account, and the accounts table remembers (`contact_card_sent_at`), so a
// restart does not send it twice:
//
//   - when the master says yes to somebody (router.js, after the welcome line);
//   - when a pre-approved number's first text makes their account (router.js);
//   - once at startup, to everybody who already had an account before this existed — "those that
//     already have it, just send them their contact card right now".
//
// A send that fails is tried again, but not more than once every few hours (`contact_card_tried_at`):
// a line that is down for an evening should not mean a card a day for the rest of time.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as db from "./db.js";
import { config, clock, normalizeNumber } from "./config.js";

/**
 * The old fixed address. Still served (the same card), but nothing sends it any more: Sendblue and
 * iMessage may keep a copy of a URL they have fetched, so a card whose photo changed at the same
 * address could arrive with the old photo. Every send uses contactCardUrl(), whose name carries
 * the first 8 hex of the card's own sha256 — a new photo is a new address.
 */
export const CONTACT_PATH = "/reason.vcf";

/** /reason.vcf, or /reason-<8 hex>.vcf. Any hash serves the current card (Sendblue fetches at once). */
export function isContactPath(pathname) {
  return pathname === CONTACT_PATH || /^\/reason-[0-9a-f]{8}\.vcf$/.test(pathname ?? "");
}

/** The card's REV: line. Bump it whenever the photo or the card's fields change. */
export const CARD_REVISED = "2026-10-26T03:20:00Z";

/** How long after a failed try before the card is tried again. */
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** The line that travels with the card. Short, and honest about why it is being sent. */
export const CARD_LINE = "one more thing — save me as a contact. your phone only shows link previews from saved numbers, so my pages will show up properly after that.";

const PHOTO = new URL("../assets/reason-contact.jpg", import.meta.url);
let photoB64 = null;
function photo() {
  if (photoB64 === null) {
    try { photoB64 = readFileSync(PHOTO).toString("base64"); } catch { photoB64 = ""; }
  }
  return photoB64;
}

/**
 * The first 8 hex of the sha256 of the card as it is served — photo, number, everything. With no
 * router (or no line number) the card is hashed without its number, which still changes with the
 * photo.
 */
export function cardHash({ router = null, channel = null } = {}) {
  const number = (router && channel && lineNumber(router, channel)) || "+10000000000";
  const card = vcard({ number, callNumber: config.elevenPhoneNumber }) ?? "";
  return createHash("sha256").update(card).digest("hex").slice(0, 8);
}

/** Where the card lives, by content, or null when this install has no public address. */
export function contactCardUrl({ router = null, channel = null } = {}) {
  return config.publicUrl ? `${config.publicUrl}/reason-${cardHash({ router, channel })}.vcf` : null;
}

/**
 * vCard 3.0 lines are at most 75 octets; longer ones continue on the next line after one space
 * (RFC 2425 §5.8.1). Only the photo is ever that long, but folding everything is simpler than
 * knowing which line will be.
 */
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

/** `;`, `,` and newlines mean something in a vCard value; a name or note must not carry them raw. */
function vEsc(v) {
  return String(v ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/**
 * The card itself. `number` is the line Reason texts from — read off the channel at request time,
 * never from the model. A card with no number would be a contact nobody can save against the
 * thread, so it is refused rather than made.
 */
export function vcard({ number, callNumber, name = "Reason", note = "Your personal concierge", url = config.siteUrl || config.publicUrl || "" } = {}) {
  const tel = normalizeNumber(number);
  if (!tel) return null;
  const call = normalizeNumber(callNumber);
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${vEsc(name)};;;;`,
    `FN:${vEsc(name)}`,
    `ORG:${vEsc(name)}`,
    `TEL;TYPE=CELL,VOICE,pref:${tel}`,
    ...(call ? [`item1.TEL:${call}`, `item1.X-ABLabel:call me`] : []),
    ...(url ? [`URL:${url}`] : []),
    `NOTE:${vEsc(note)}`,
    `REV:${CARD_REVISED}`,
    ...(photo() ? [`PHOTO;ENCODING=b;TYPE=JPEG:${photo()}`] : []),
    "END:VCARD",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** The number a channel sends from, as the channel reports it. */
export function lineNumber(router, channel) {
  const ch = router?.get?.(channel) ?? null;
  return ch?.status?.().number ?? ch?.from ?? null;
}

/**
 * Send one person the card, if they have not had it. Never throws, never blocks a turn: this is a
 * nicety sent alongside the real work, and a failure here is a log line and a later retry.
 *
 * Returns what happened, so the startup pass and the tests can count: `sent`, `already`, `skipped`
 * (no public address, a channel with no address to send a file by, the console) or `failed`.
 */
export async function offerContactCard({ router, account, log = () => {}, line = CARD_LINE }) {
  if (!account) return { outcome: "skipped", why: "no account" };
  if (account.contact_card_sent_at) return { outcome: "already" };
  if (!account.channel || account.channel === "console" || !account.address) return { outcome: "skipped", why: "no texting channel" };
  const url = contactCardUrl({ router, channel: account.channel });
  if (!url) return { outcome: "skipped", why: "REASON_PUBLIC_URL is not set, so there is no address to serve the card from" };
  const now = clock.now();
  if (account.contact_card_tried_at && now - account.contact_card_tried_at < RETRY_AFTER_MS) {
    return { outcome: "skipped", why: "tried recently" };
  }
  if (!lineNumber(router, account.channel)) return { outcome: "skipped", why: `${account.channel} reports no line number to put on the card` };

  db.markContactCardTried(account.conversation_id);
  let r;
  try {
    r = await router.sendMediaUrl({ channel: account.channel, to: account.address, text: line, mediaUrl: url });
  } catch (e) {
    r = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
  }
  if (!r?.ok) {
    log({ contact_card_failed: account.conversation_id, why: r?.error ?? "unknown", supported: r?.supported });
    // A channel that cannot do this at all will not learn to; nothing to retry.
    return { outcome: r?.supported === false ? "skipped" : "failed", why: r?.error };
  }
  db.markContactCardSent(account.conversation_id);
  log({ contact_card_sent: account.conversation_id, over: account.channel });
  return { outcome: "sent" };
}

/**
 * Everybody with an account and no card yet, once. Run after the server is listening — Sendblue
 * fetches the .vcf the moment it gets the request, and a card sent before the port is open is a
 * card pointing at nothing.
 */
export async function backfillContactCards({ router, log = () => {} }) {
  const out = { sent: 0, already: 0, skipped: 0, failed: 0 };
  for (const account of db.accountsWithoutContactCard()) {
    const r = await offerContactCard({ router, account, log });
    out[r.outcome] = (out[r.outcome] ?? 0) + 1;
  }
  return out;
}
