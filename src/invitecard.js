// The picture an invite link turns into when it is forwarded: "<Name> thinks you should join reason"
// in the homepage's headline face, with "Free for you, for good." under it in the brand red
// handwriting, on the site's warm paper (owner, 2026-10-25).
//
// One picture per inviter NAME, not per link: every link Kofi sends shows the same card, so it is
// drawn once and kept under data/invite-cards by a hash of the name and the design's version. The
// fonts ride inline as data URIs (assets/fonts, both SIL Open Font License: Instrument Serif ©
// 2022 The Instrument Serif Project Authors, Caveat © 2014 The Caveat Project Authors), so the
// server's headless Chromium needs no network to draw it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { esc } from "./pages/render.js";
import { PAPER, PAPER_GRAIN, BRAND_PEN } from "./pages/brand.js";
import { wordmark, WORDMARK_CSS } from "./pages/wordmark.js";
import { CARD_W, CARD_H, RENDER_TIMEOUT_MS, shootWithChromium } from "./pages/card.js";

const font = (f) => `data:font/woff2;base64,${readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64")}`;
const SERIF = font("instrument-serif-italic-latin.woff2");
const HAND = font("caveat-latin.woff2");

// A link made FOR somebody (invite_link_create's for_name) greets them by name on the card. Three
// wordings were drawn for the owner to pick from (media/invite-personal): this one line picks.
//   A  "Dalen, Kwame thinks you should join reason"
//   B  "Hey Dalen. Kwame thinks you should join reason"
//   C  a small handwritten "For Dalen" above the unchanged "Kwame thinks you should join reason"
// A link with no name for anybody draws exactly the card it always did, byte for byte.
export const INVITEE_GREETING = "C"; // C: the headline stays exactly as it is, so a long pair never shrinks it

// ---------- the name a link is for ----------
//
// Free text from one person that ends up on a Reason-branded picture a stranger sees, so code owns its shape: one person's name, in letters, short. Anything else (a link, a
// handle, a number, a sentence, an insult, two people on one single-use link) is not refused out
// loud: the link is simply made plain, with today's card. Who the name is FOR is the model's read of
// what they said; this only decides whether it is safe to draw.

const RELATION = /^(?:(?:it'?s |its )?for )?(?:my |our )?(?:(?:little|big|baby|older|younger|best|good|old|new) )?(?:friend|mate|buddy|pal|bestie|bff|sister|sis|brother|bro|cousin|mom|mum|mother|dad|father|aunt|auntie|uncle|wife|husband|partner|girlfriend|boyfriend|roommate|coworker|colleague|neighbou?r|son|daughter|niece|nephew|grandma|grandpa|boss)?,? ?/i;

/** Longest name drawn, in characters, and most words. */
export const INVITEE_MAX = 24;
const INVITEE_WORDS = 2;
const INVITEE_WORD_MAX = 20;
// Words that make it a message, not a name: little words a sentence is built from, the words a scam
// card would use, and insults. A name with one of these in it is not drawn.
const NOT_A_NAME = new Set((
  "a an the and or but if of to for from with without at on in into by as is are was were be been am im i me my mine "
  + "you your youre yours u ur we us our they them their he him his she her hers it its this that these those "
  + "not no yes yeah yep nope just only very so too now here there hi hey hello dear friend friends someone somebody anyone everyone "
  + "sister brother mom mum dad mother father cousin aunt uncle wife husband girlfriend boyfriend bestie bff "
  + "join joined free win winner won prize gift cash money pay paid click tap link url www http https com net org "
  + "reason official support admin team staff verify verified account password code login bank scam "
  + "love hate kill die dead death sucks suck stupid dumb idiot moron loser ugly fat gay lame trash "
  + "fuck fucking fucker shit bitch bastard ass asshole dick cock cunt pussy whore slut hoe retard nazi hitler"
).split(" "));

/**
 * The name to draw for the person a link is for, or "" when there is none or it is not plausibly one
 * person's name. Newlines, control and invisible characters and emoji go; then it must be one or
 * two words of letters (a hyphen, apostrophe or dot inside a word is fine: Alexandria-Marie, O'Neil,
 * J.R.), at most INVITEE_MAX characters, with no digit, @, link or any word that makes it a message.
 * The case is tidied ("dalen" → "Dalen"); the spelling is theirs.
 */
export function cleanInviteeName(raw) {
  let s = String(raw ?? "").normalize("NFKC");
  if (s.length > 200) return "";
  // A link, an address or a handle anywhere means it is not a name: nothing of it is drawn.
  if (/[@#/\\:<>{}[\]|=+_~^$%*]|www\.|\.(?:com|net|org|io|co|me|ly|app|link|xyz|gg)\b|\p{L}{2,}\.\p{L}{2,}/iu.test(s)) return "";
  if (/\p{N}/u.test(s)) return "";
  // A name is one line: anything on a line after it is not drawn.
  s = s.split(/[\r\n\u2028\u2029]+/).map(x => x.trim()).find(Boolean) ?? "";
  s = s.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/[\u2019\u2018`]/g, "'")
    .replace(/\s+/g, " ").trim()
    .replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "").replace(/[.,!?;]+$/, "").trim()
    // "for my sister Ama" is Ama: who they are to the inviter is not drawn.
    .replace(RELATION, "").trim();
  if (!s || s.length > INVITEE_MAX) return "";
  const words = s.split(" ");
  if (words.length > INVITEE_WORDS) return "";
  const word = /^\p{L}[\p{L}\p{M}]*(?:['.\-]\p{L}[\p{L}\p{M}]*)*\.?$/u;
  for (const w of words) {
    if (w.length > INVITEE_WORD_MAX || !word.test(w)) return "";
    if (NOT_A_NAME.has(w.toLowerCase().replace(/['.\-]/g, ""))) return "";
    for (const part of w.toLowerCase().split(/['.\-]/)) if (NOT_A_NAME.has(part) && part.length > 2) return "";
  }
  // A run of one letter ("aaaaaaa") or a word in all one case shouting is tidied, not trusted as typed.
  if (/(\p{L})\1{3,}/u.test(s)) return "";
  return words.map(w => w === w.toUpperCase() && w.length > 3 ? w[0] + w.slice(1).toLowerCase() : w)
    .map(w => w.replace(/(^|[-'.])(\p{Ll})/gu, (_, at, ch) => at + ch.toLocaleUpperCase()))
    .join(" ");
}

/** Bump when the drawing changes, so every cached card is drawn again. */
export const INVITE_CARD_VERSION = 5; // 3: pen colour brick red (10-26); 4: assets/og.png fallback redrawn red, so a phone that kept the blue one under a v3 address fetches again; 5: pen #9c3b2e / #d46a5c (10-26)

/**
 * The card's HTML. `invitee` is the person the link is for (already through cleanInviteeName); with
 * none, exactly the card it always was. With one, the greeting INVITEE_GREETING picks, and the
 * headline's size steps down on the two names together, so a long pair still fits.
 */
export function inviteCardHtml(name, invitee = "", greeting = INVITEE_GREETING) {
  const who = String(name || "A friend");
  const forWho = cleanInviteeName(invitee);
  // Today's step (a long inviter name drops to 96px) holds on its own; with the greeting in the
  // headline it reads the two names together.
  const pair = forWho && greeting !== "C" ? forWho.length + who.length + (greeting === "B" ? 4 : 0) : who.length;
  const size = !forWho ? (who.length > 18 ? 96 : 124) : pair > 30 ? 84 : pair > 18 ? 96 : 124;
  const headline = !forWho || greeting === "C" ? `${esc(who)} thinks you should join ${wordmark()}`
    : greeting === "B" ? `Hey ${esc(forWho)}. ${esc(who)} thinks you should join ${wordmark()}`
    : `${esc(forWho)}, ${esc(who)} thinks you should join ${wordmark()}`;
  const above = forWho && greeting === "C" ? `<p class="for">For ${esc(forWho)}</p>` : "";
  const forCss = above ? `\n.for{margin-bottom:22px;font:400 64px/1 "Card Hand",Caveat,cursive;color:${BRAND_PEN};transform:rotate(-2deg);transform-origin:left}` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Card Serif";font-style:italic;font-weight:400;src:url(${SERIF}) format("woff2")}
@font-face{font-family:"Card Hand";font-weight:400;src:url(${HAND}) format("woff2")}
${WORDMARK_CSS}
*{margin:0;box-sizing:border-box}html,body{width:${CARD_W}px;height:${CARD_H}px}
body{background:${PAPER_GRAIN} ${PAPER.bg};position:relative;overflow:hidden;-webkit-font-smoothing:antialiased}
.in{position:absolute;left:84px;right:60px;top:50%;transform:translateY(-54%)}
h1{font:italic 400 ${size}px/1.02 "Card Serif","Instrument Serif",Georgia,serif;letter-spacing:-.02em;color:${PAPER.ink};text-wrap:balance}
h1 .wordmark{font-size:1em;color:${PAPER.ink}}h1 .wm-bubble path{stroke:${BRAND_PEN}}
.hand{margin-top:34px;font:400 76px/1.1 "Card Hand",Caveat,cursive;color:${BRAND_PEN};transform:rotate(-1.5deg);transform-origin:left}${forCss}
</style></head><body><div class="in">${above}<h1>${headline}</h1><p class="hand">Free for you, for good.</p></div></body></html>`;
}

/**
 * The cache key, and the `?v=` a link carries so a phone never shows a stale card. The person a link
 * is for is in it (and the greeting chosen), so one person's card is never served on another's link;
 * with nobody, the key is exactly the one it always was, so every card already drawn is still used.
 */
export function inviteCardKey(name, invitee = "") {
  const forWho = cleanInviteeName(invitee);
  const what = forWho ? `${INVITE_CARD_VERSION}\n${name}\nfor:${INVITEE_GREETING}:${forWho}` : `${INVITE_CARD_VERSION}\n${name}`;
  return createHash("sha256").update(what).digest("hex").slice(0, 16);
}

function cardFile(name, invitee) {
  return join(config.dataDir, "invite-cards", `${inviteCardKey(name, invitee)}.png`);
}

function withTimeout(promise, ms) {
  let t;
  const clock = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`drawing the invite card took longer than ${Math.round(ms / 1000)}s`)), ms); });
  return Promise.race([promise, clock]).finally(() => clearTimeout(t));
}

// A forwarded link is often fetched by several preview bots at once; they share one drawing.
const drawing = new Map();

/** The card for one inviter name (and the person the link is for, if any): read from disk when drawn before, drawn and kept when not. */
export function inviteCard(name, { shoot = shootWithChromium, invitee = "" } = {}) {
  const key = inviteCardKey(name, invitee);
  if (!drawing.has(key)) drawing.set(key, draw(name, invitee, shoot).finally(() => drawing.delete(key)));
  return drawing.get(key);
}

async function draw(name, invitee, shoot) {
  const file = cardFile(name, invitee);
  if (existsSync(file)) {
    const png = readFileSync(file);
    if (png.length) return png;
  }
  const png = await withTimeout(shoot(inviteCardHtml(name, invitee)), RENDER_TIMEOUT_MS);
  if (!png?.length) throw new Error("the renderer gave back an empty picture");
  mkdirSync(join(config.dataDir, "invite-cards"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, png);
  renameSync(tmp, file);
  return png;
}
