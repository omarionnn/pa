// The welcome gallery (owner, 2026-11-10): seven picture cards a new person gets in their first
// chat, one per thing Reason really does today, each with one request they could text right now.
// Drawn once by scripts/make-welcome-cards.mjs into assets/welcome/, the same for everybody.
//
//   REASON_WELCOME_CARDS=off    nobody (default)
//   REASON_WELCOME_CARDS=owner  nobody in the first chat; only scripts/welcome-to-owner.js, so the
//                               owner can see the real thing on his own phone before it goes on
//   REASON_WELCOME_CARDS=on     every new person's first chat (src/onboarding.js)
//
// Delivery: each card is its own message carrying only the picture, queued as one ordered outbox
// chain with the lines around it (src/onboarding.js commitStep), so iMessage stacks the seven in
// order and a restart mid-way finishes the chain instead of starting again. Each card row carries
// its text line (`fallbackText`): a card that cannot go for good (the upload already retried in
// place, src/channels/sendblue.js UPLOAD_RETRY_MS) goes as that line in the same place (src/outbox.js),
// so the set always arrives whole and in order. A channel that cannot carry files at all gets the
// seven lines instead.
//
// Only what Reason does for everybody today (checked 2026-11-10 against the tools and the live flags:
// calls, REASON_EVENTS, timers, REASON_SHOP_CONNECT + Face ID, REASON_FOOD, pages, search). No card
// for reading their messages or their inbox: Reason cannot read their iMessage or WhatsApp.
import { fileURLToPath } from "node:url";
import { join, dirname, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { config } from "./config.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "welcome");

export const CARDS = Object.freeze([
  { key: "calls", eyebrow: "CALLS", title: "Calls", note: "i make the call for you", example: "Call my dentist and move my cleaning to next week." },
  { key: "events", eyebrow: "EVENTS", title: "Events", note: "a page, a guest list, reminders", example: "Make an event for my birthday party Saturday." },
  { key: "reminders", eyebrow: "REMINDERS", title: "Reminders", note: "once, or every month", example: "Remind me to pay rent on the 1st." },
  { key: "shopping", eyebrow: "SHOPPING", title: "Shopping", note: "nothing is bought without your yes", example: "Reorder my CeraVe lotion." },
  { key: "food", eyebrow: "FOOD", title: "Food", note: "you see the total before it's placed", example: "Get me a chicken burrito for dinner." },
  { key: "booking", eyebrow: "BOOKING", title: "Booking", note: "i call the restaurant for you", example: "Book a table for two Friday at 8." },
  { key: "more", eyebrow: "AND THE REST", title: "Everything else", note: "search, plans, pages, to-do lists", example: "Find a vet open Sunday and make me a page with the best three." },
].map((c, i) => Object.freeze({ ...c, n: i + 1, file: join(DIR, `${String(i + 1).padStart(2, "0")}-${c.key}.jpg`) })));

/** The eyebrow on a card: "01 / 07 · CALLS". */
export const eyebrowOf = (c) => `${String(c.n).padStart(2, "0")} / ${String(CARDS.length).padStart(2, "0")} · ${c.eyebrow}`;

/** One card as words: what goes in its place when its picture cannot. */
export const textLine = (c) => `${c.title}: "${c.example}"`;

/** The question after the seven (owner wording). */
export const HELP_FIRST = "What would you like help with first?";

/** The line before the cards for somebody who came from the web setup: picks up where the page left off. */
export const WEB_INTRO = ({ user = "", reasonName = "Reason", invitedBy = null } = {}) =>
  `${user ? `hey ${String(user).toLowerCase()}` : "hey"}, ${reasonName || "Reason"} here. ${invitedBy ? `you're in, invited by ${invitedBy}. ` : ""}picking up from your setup, here's what i can do for you`;

export function mode() {
  const v = String(process.env.REASON_WELCOME_CARDS ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}

/** Do new people's first chats carry the cards? Only under `on`. */
export const forEveryone = () => mode() === "on";

/** Can this channel carry a picture (the adapter really sends files)? */
export function carriesFiles(router, channel) {
  const ch = router?.get?.(channel);
  return !!ch && ch.carriesFiles === true;
}

// The cards' public addresses, for the carousel: Sendblue fetches them (files.heyreason.com/img/* goes
// straight to the app, src/http.js assetRequest). The version is the set's own hash, so a redraw
// is a new address and no phone or cache keeps an old card.
let version = null;
export function setVersion() {
  if (version) return version;
  const h = createHash("sha256");
  for (const c of CARDS) { try { h.update(readFileSync(c.file)); } catch { return null; } }
  return (version = h.digest("hex").slice(0, 8));
}
export function cardUrls(base = config.pagesUrl || config.publicUrl) {
  const v = setVersion();
  if (!v || !/^https:\/\//.test(String(base ?? ""))) return null;
  return CARDS.map(c => `${String(base).replace(/\/+$/, "")}/img/welcome/${v}/${basename(c.file)}`);
}
/** `/img/welcome/<version>/NN-key.jpg` → the card's file on disk, or null. */
export function fileForPath(pathname) {
  // Only today's set: an old version's address is a 404, never today's picture cached as the old one.
  const m = /^\/img\/welcome\/([0-9a-f]{8})\/(\d\d-[a-z]+\.jpg)$/.exec(String(pathname ?? ""));
  if (!m || m[1] !== setVersion()) return null;
  return m ? CARDS.find(c => basename(c.file) === m[2])?.file ?? null : null;
}

const picture = (c) => ({ file: c.file, mimeType: "image/jpeg", filename: `${c.key}.jpg`, fallbackText: textLine(c) });

/**
 * The seven as bubbles for commitStep, in order of preference (owner, 2026-11-11):
 *   1. ONE carousel message (swipeable stack), when the channel has one and the cards have public
 *      addresses. If it cannot go, the outbox turns it into 2. in its place.
 *   2. Each its own picture message, its line kept for a fall-back.
 *   3. The lines themselves (no files on this channel, or a picture missing on disk).
 */
export function bubbles(router, channel) {
  const ch = router?.get?.(channel);
  const files = carriesFiles(router, channel) && CARDS.every(c => existsSync(c.file));
  const urls = files && typeof ch?.sendCarousel === "function" ? cardUrls() : null;
  if (urls) {
    return [{
      text: "", welcome: true,
      media: { carousel: urls, pictures: CARDS.map(picture), historyText: `(pictures, one swipeable set) ${CARDS.map(textLine).join(" · ")}` },
    }];
  }
  return CARDS.map(c => files ? { text: "", media: picture(c), welcome: true } : { text: textLine(c), welcome: true });
}
