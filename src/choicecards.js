// Choice cards: a few real options, each its own picture, one bubble apiece (owner, 2026-10-30).
//
// When somebody has a handful of real options — three cleansers at different prices, which of two
// Joe Coffees — a numbered list in one bubble makes them read the whole thing to tell them apart.
// The idea (not the look) is Instinct's: each option is a card with a big number, its photo, its
// name and the one detail that decides it, sent as its own image so the thread reads 1, 2, 3.
//
// Only for SHOPPING (products, which size or variant, a few buy options) and PLACES (restaurants,
// cafes, stores, hotels, which branch). Whether a moment is one of those is the model's call, off
// the tool's description, never a keyword match. Never for a yes/no, a single answer, or when
// Reason already knows which they mean.
//
// The flow:
//   1. the model calls show_choices with 2–4 options, each with an image_url a tool returned in this
//      conversation (db.hasSeenUrl — a picture typed from memory is refused, as on pages).
//   2. every photo is fetched here (src/media.js fetchImage: https only, private hosts refused, size
//      and time capped, HEIC converted) and drawn INTO the card, so a phone never hotlinks a
//      retailer and a card is never a broken image. One photo missing and the whole set is a short
//      numbered text list instead, so the numbers always mean the same thing.
//   3. the model's reply is the one short line that goes above them. The runtime sends that line,
//      then each card, in order, each awaited before the next (sendQueued).
//   4. the set stays open for CHOICE_TTL_MS. The next thing they send is read with the cards in front
//      of the model (inboundChoiceLine): a number, "the blue one", a name, an inline reply on a card,
//      or a tapback.
//
// A tapback is not an event on Sendblue: it arrives as an ordinary text, "Loved “got it…”" (a real
// one from 2026-10 is in test/choicecards.test.js). On a card it is "Loved an image", which does not
// say WHICH image, so with more than one card it is read as "one of them, ask which" — never a
// guess. An inline reply on a card does carry the card's handle, and that one is exact.
//
// Behind REASON_CHOICE_CARDS (off | owner | on), off by default.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { z } from "zod";
import { config, clock } from "./config.js";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { esc } from "./pages/render.js";
import { wordmark, WORDMARK_CSS } from "./pages/wordmark.js";
import { TOKENS } from "./pages/webkit.js";
import { RENDER_TIMEOUT_MS, shootWithChromium } from "./pages/card.js";
import { fetchImage } from "./media.js";
import { checkUrl } from "./pictures.js";
import { webLookup } from "./weblookup.js";

export const CHOICE_TOOLS = new Set(["show_choices"]);

/** Bump when the drawing changes, so every kept card is drawn again. */
export const CHOICE_CARD_VERSION = 2;
/** How long a set of cards is still the thing their next message may be answering. */
export const CHOICE_TTL_MS = 12 * 3_600_000;
/** 360×450 points, drawn at 3× — crisp on any iPhone, about the shape of a portrait photo. */
export const CARD_PT_W = 360;
export const CARD_PT_H = 450;
export const CARD_SCALE = 3;
/** Between one card and the next, so the provider's queue cannot hand them over out of order. */
const GAP_MS = Number(process.env.REASON_CHOICE_GAP_MS ?? 900);

export function choiceCardsOn(conversationId) {
  const v = String(process.env.REASON_CHOICE_CARDS ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  return v === "owner" && !!conversationId && accounts.ownerOf(conversationId).isOperator;
}

export function choiceToolVisible(name, conversationId) {
  if (!CHOICE_TOOLS.has(name)) return true;
  return choiceCardsOn(conversationId);
}

// ---------- the tool ----------

export const CHOICE_TOOL_DEFS = [
  {
    name: "show_choices",
    description: "Show them a few real options as picture cards — each option its own numbered card (photo, name, price or the deciding detail), sent as its own bubble after your line."
      + " Use it INSTEAD of writing a list whenever your answer would end with them picking one of 2–4 products or places: they see the photos and answer with a number, a name or a description."
      + " Narrow first if there are more than four: pick the best 2–4 for what they asked, and say in your line what they have in common."
      + " ONLY for shopping (a few products, which size or variant, the same thing at different prices) and places (restaurants, cafes, stores, hotels, which branch of a chain), and only when there really are 2 to 4 options worth choosing between or you are unsure which one they mean."
      + " Never for a yes/no, a single answer, a list of facts, or when you already know which one they mean — then just answer."
      + " Every option needs image_url or url (its product page or the place's own page) from a tool result in this conversation — never typed from memory; with only the page, its own preview picture is used."
      + " After it returns ok, your reply is ONE short line that goes above the cards: how many and what, and that it is their pick. Do not list the options again in words; the cards say them."
      + " For a product, give url (the store listing) for each one: the price and size on a card are checked against the listing its photo came from and left off when it does not say the same."
      + " If it returns fallback: \"text\", write the options as a short numbered list instead (the numbers are kept either way).",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["shopping", "places"], description: "shopping: products and buy options. places: somewhere to go." },
        options: {
          type: "array", minItems: 2, maxItems: 4,
          description: "2 to 4 options, in the order to number them.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "What it is, short: 'Hydrating Facial Cleanser', 'Joe Coffee — Flatiron'." },
              brand: { type: "string", description: "Shopping: the brand or the shop selling it. Places: the neighbourhood. Optional." },
              price: { type: "string", description: "Shopping: the price as found, '$15.99'. Places: the price level if known. Optional." },
              detail: { type: "string", description: "The one detail that tells it apart: size, rating, distance, hours — '16 oz', '4.6 ★ · 3 min walk'. Optional." },
              why: { type: "string", description: "Optional, two or three words on why it is here: 'cheapest', 'closest', 'best reviewed'." },
              image_url: { type: "string", description: "The https image address a tool returned for THIS option, if you have one." },
              url: { type: "string", description: "Its page (the product page, the place's own site or listing) as a tool returned it. Without image_url, the page's own preview picture is used." },
            },
            required: ["name"],
          },
        },
      },
      required: ["kind", "options"],
    },
  },
];

const opt = z.object({
  name: z.string().min(1).max(120),
  brand: z.string().max(60).optional(),
  price: z.string().max(40).optional(),
  detail: z.string().max(80).optional(),
  why: z.string().max(40).optional(),
  image_url: z.string().max(2000).optional(),
  url: z.string().max(2000).optional(),
}).refine(o => o.image_url || o.url, { message: "each option needs image_url or url" });
export const CHOICE_SCHEMAS = {
  show_choices: z.object({ kind: z.enum(["shopping", "places"]), options: z.array(opt).min(2).max(4) }),
};

// ---------- the drawing ----------

const font = (f) => `data:font/woff2;base64,${readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64")}`;
let FONTS = null;
const fonts = () => (FONTS ??= { serif: font("instrument-serif-italic-latin.woff2"), sans: font("inter-web.woff2"), hand: font("caveat-latin.woff2") });

/** Light unless they chose Night on Web. "auto" follows a phone we cannot see, so Light. */
export function themeFor(conversationId) {
  try { return db.webTheme(conversationId) === "night" ? "night" : "paper"; } catch { return "paper"; }
}

/**
 * One card's HTML, laid out in points (360×450) and zoomed 3× so the picture is 1080×1350.
 * `photo` is a data: URI — the bytes are already here, nothing is fetched while drawing.
 */
export function choiceCardHtml({ n, kind = "shopping", name, brand = "", price = "", detail = "", why = "", photo, theme = "paper" }) {
  const t = TOKENS[theme === "night" ? "night" : "paper"];
  const f = fonts();
  const product = kind !== "places";
  const meta = [price, detail].filter(Boolean).map(esc).join('<span class="dot">·</span>');
  // One column: the photo takes whatever height the words and the foot leave, so a one-line name
  // with no price is a bigger photo, never an empty band under the text.
  return `<!doctype html><html data-theme="${theme === "night" ? "dark" : "light"}"><head><meta charset="utf-8"><style>
@font-face{font-family:"Card Serif";font-style:italic;font-weight:400;src:url(${f.serif}) format("woff2")}
@font-face{font-family:"Card Sans";font-weight:100 900;src:url(${f.sans}) format("woff2")}
@font-face{font-family:"Card Hand";font-weight:400;src:url(${f.hand}) format("woff2")}
${WORDMARK_CSS}
*{margin:0;box-sizing:border-box}
html{zoom:${CARD_SCALE}}
html,body{width:${CARD_PT_W}px;height:${CARD_PT_H}px}
body{background:${t.lifted};color:${t.ink};display:flex;flex-direction:column;padding:14px 14px 0;overflow:hidden;-webkit-font-smoothing:antialiased;font-family:"Card Sans",Inter,system-ui,sans-serif}
.ph{position:relative;flex:1 1 auto;min-height:200px;border-radius:14px;overflow:hidden;background:${product ? "#ffffff" : t.photo};box-shadow:0 0 0 1px ${t.hair}}
.ph img{position:absolute;inset:0;width:100%;height:100%;object-fit:${product ? "contain" : "cover"};${product ? "padding:12px;" : ""}display:block}
.num{position:absolute;left:0;top:0;width:58px;height:58px;border-bottom-right-radius:16px;background:${t.pen};color:${theme === "night" ? t.deep : "#fff"};font:italic 400 44px/58px "Card Serif",Georgia,serif;text-align:center;letter-spacing:-.02em}
.tx{flex:none;padding:14px 8px 0}
.eb{font:600 10.5px/1 "Card Sans",sans-serif;letter-spacing:.14em;text-transform:uppercase;color:${t.muted};margin-bottom:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
h1{font:italic 400 ${String(name).length > 24 ? 26 : 29}px/1.06 "Card Serif",Georgia,serif;letter-spacing:-.015em;color:${t.ink};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{margin-top:8px;font:500 15px/1.25 "Card Sans",sans-serif;color:${t.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta .dot{color:${t.muted};padding:0 6px}
.ft{flex:none;height:40px;display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 6px}
.why{font:400 21px/1 "Card Hand",Caveat,cursive;color:${t.pen};transform:rotate(-2deg);transform-origin:left;white-space:nowrap}
.wm{margin-left:auto}
.wm .wordmark{font-size:15px;color:${t.muted}}
.wm .wm-bubble path{stroke:${t.pen}}
</style></head><body>
<div class="ph"><img src="${photo}" alt=""><div class="num">${Number(n)}</div></div>
<div class="tx">${brand ? `<p class="eb">${esc(brand)}</p>` : ""}<h1>${esc(name)}</h1>${meta ? `<p class="meta">${meta}</p>` : ""}</div>
<div class="ft">${why ? `<p class="why">${esc(why)}</p>` : ""}<div class="wm">${wordmark()}</div></div>
</body></html>`;
}

const cardsDir = () => join(config.dataDir, "choice-cards");
/** A kept card's file, by name only — the one shape a card's address may take (see cardFile). */
const NAME_RE = /^[0-9a-f]{20}\.jpg$/;
export function cardFile(name) {
  const n = basename(String(name ?? ""));
  return NAME_RE.test(n) ? join(cardsDir(), n) : null;
}
export const isCardFile = (file) => !!file && cardFile(basename(String(file))) === String(file);

/**
 * Draw one card, or read it if this exact card was drawn before. Returns { file, name }.
 * The key covers the design version, the theme, every word on it and the photo's bytes.
 */
export async function drawCard(card, { shoot = shootWithChromium } = {}) {
  const key = createHash("sha256")
    .update(JSON.stringify([CHOICE_CARD_VERSION, card.theme, card.kind, card.n, card.name, card.brand, card.price, card.detail, card.why]))
    .update(card.photo)
    .digest("hex").slice(0, 20);
  const name = `${key}.jpg`;
  const file = join(cardsDir(), name);
  if (existsSync(file) && readFileSync(file).length) return { file, name };
  const html = choiceCardHtml(card);
  let t;
  const clock_ = new Promise((_, rej) => { t = setTimeout(() => rej(new Error("drawing the choice card took too long")), RENDER_TIMEOUT_MS); });
  const pic = await Promise.race([shoot(html, { width: CARD_PT_W * CARD_SCALE, height: CARD_PT_H * CARD_SCALE, type: "jpeg" }), clock_]).finally(() => clearTimeout(t));
  if (!pic?.length) throw new Error("the renderer gave back an empty picture");
  mkdirSync(cardsDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, pic);
  renameSync(tmp, file);
  return { file, name };
}

/**
 * The picture a page names for itself — og:image, then twitter:image — the one a phone would draw
 * for its link. A shop's product page and a cafe's own site nearly always have one. Fetched like
 * any page Reason reads: https only, never this machine's network, small and quick.
 */
export async function pagePhoto(pageUrl, { fetchImpl = globalThis.fetch, timeoutMs = 6000, maxBytes = 1_500_000 } = {}) {
  const ok = checkUrl(pageUrl);
  if (!ok.ok) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(ok.url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", accept: "text/html" } });
    if (!res.ok || !checkUrl(res.url || ok.url).ok) return null;
    const html = (await res.text()).slice(0, maxBytes);
    for (const key of ["og:image:secure_url", "og:image", "twitter:image"]) {
      const m = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i").exec(html);
      const c = m && /content=["']([^"']+)["']/i.exec(m[0]);
      if (c) {
        const abs = new URL(c[1].replace(/&amp;/g, "&"), res.url || ok.url);
        abs.protocol = "https:";
        return abs.href;
      }
    }
    return null;
  } catch { return null; } finally { clearTimeout(t); }
}

/** One option's photo as a data: URI, or null with why. Never a link a phone would have to follow. */
async function photoFor(conversationId, url, { fetchImpl, fetchPhoto = fetchImage, pageUrl = null, findPagePhoto = pagePhoto } = {}) {
  let u = String(url ?? "").trim();
  // No usable picture address, but a page a tool found: the page's own picture.
  if ((!u || !db.hasSeenUrl(conversationId, u)) && pageUrl && db.hasSeenUrl(conversationId, pageUrl)) {
    u = (await findPagePhoto(pageUrl, fetchImpl ? { fetchImpl } : {})) ?? u;
    if (u && u !== String(url ?? "").trim()) db.rememberSeenUrls(conversationId, [u], { kind: "page", from: pageUrl });
  }
  if (!/^https:\/\/\S+$/.test(u)) return { ok: false, why: "not an https image address" };
  if (!db.hasSeenUrl(conversationId, u)) return { ok: false, why: "that image address did not come from a tool in this conversation" };
  // The name decides whether fetchImage will try; a CDN address often has no extension at all.
  const filename = /\.(jpe?g|png|webp|gif|heic|heif|avif)(\?|$)/i.test(u) ? "" : "photo.jpg";
  const got = await fetchPhoto({ url: u, filename, ...(fetchImpl ? { fetchImpl } : {}), headers: { "user-agent": "Reason/1.0 (choice cards)" } });
  if (!got?.ok) return { ok: false, why: got?.why ?? "it could not be fetched" };
  if (!got.base64) return { ok: false, why: "it came back empty" };
  return { ok: true, uri: `data:${got.mediaType ?? "image/jpeg"};base64,${got.base64}` };
}

// A set drawn this turn, waiting for the reply line to go first. Per process and per turn only: a
// set that is never sent (the turn said nothing) is dropped by sendQueued, never carried forward.
const queued = new Map();

export function takeQueued(conversationId) {
  const q = queued.get(conversationId) ?? null;
  queued.delete(conversationId);
  return q;
}

const textLine = (o, i) => `${i + 1}. ${[o.name, o.price, o.detail].filter(Boolean).join(" — ")}${o.why ? ` (${o.why})` : ""}`;

// ---------- the listing check ----------
//
// A card's price and size are only as good as where they came from. The first CeraVe samples put
// "16 oz" over a photo of the 12 oz bottle: the model had the size from one result and the picture
// from another. So for a product, the price and any size on the card must be what the store listing
// the PHOTO came from says — read again here — or they are left off the card. Never a mismatch.

const SIZE_RE = /(?<![\d.])(\d+(?:\.\d+)?)\s*[-_]?\s*(fl\.?\s*oz\.?|fluid\s+ounces?|ounces?|oz\.?|millilit(?:er|re)s?|ml|lit(?:er|re)s?|l|kilograms?|kg|grams?|g|pounds?|lbs?|count|ct|pack|pk)(?![a-z])/gi;
const unitOf = (u) => {
  u = u.toLowerCase().replace(/[.\s]/g, "");
  if (/oz|ounce/.test(u)) return "oz";
  if (/^ml|millil/.test(u)) return "ml";
  if (/^l$|^lit/.test(u)) return "l";
  if (/^kg|kilo/.test(u)) return "kg";
  if (/^g$|^gram/.test(u)) return "g";
  if (/^lb|pound/.test(u)) return "lb";
  if (/^ct|count/.test(u)) return "ct";
  return "pack";
};
/** Every size written in a piece of text — "16 fl oz", "473 mL", "12oz" in a file name. */
export function sizesIn(text) {
  return [...String(text ?? "").matchAll(SIZE_RE)].map(m => ({ n: Number(m[1]), unit: unitOf(m[2]), raw: m[0] }));
}
const sameSize = (a, b) => a.unit === b.unit && Math.abs(a.n - b.n) < 0.01;
/** The dollar amounts in a piece of text, as numbers. */
export function pricesIn(text) {
  return [...String(text ?? "").matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)].map(m => Number(m[1].replace(/,/g, "")));
}
const amountOf = (price) => { const p = pricesIn(price); return p.length ? p[0] : null; };
const tidy = (s) => String(s).replace(/\(\s*\)/g, "").replace(/\s*·\s*(·\s*)+/g, " · ").replace(/\s{2,}/g, " ").replace(/^[\s·,|–—-]+|[\s·,|–—-]+$/g, "").trim();
const STOP = new Set(["the", "and", "for", "with", "from", "facial", "new", "size"]);
const words = (s) => String(s ?? "").toLowerCase().match(/[a-z0-9]{3,}/g)?.filter(w => !STOP.has(w)) ?? [];

/**
 * Hold one option up against the listing its photo came from. Pure: `listing` is { title, text,
 * images } as webLookup read it (or null), `photoUrl` the picture the card will show (or "" when
 * the listing's own picture will be used). Returns { option, dropped } — the option with anything
 * the listing does not back taken off, and a short line per thing taken off.
 */
export function checkAgainstListing(o, listing, { photoUrl = "", photoFromListing = true } = {}) {
  const out = { ...o };
  const dropped = [];
  const fail = (why) => {
    if (amountOf(out.price) != null) { dropped.push(`price ${out.price} (${why})`); out.price = ""; }
    for (const k of ["name", "detail"]) {
      for (const s of sizesIn(out[k])) { dropped.push(`size ${s.raw.trim()} (${why})`); out[k] = tidy(out[k].replace(s.raw, " ")); }
    }
    return { option: out, dropped };
  };
  if (!listing) return fail("no store listing to check it against");
  if (!photoFromListing) return fail("the photo is not from its listing");
  const head = `${listing.title ?? ""}\n${String(listing.text ?? "").slice(0, 1500)}`.toLowerCase();
  const want = [...new Set(words(o.name))];
  if (want.length && want.filter(w => head.includes(w)).length / want.length < 0.5) return fail("the listing is a different product");
  // Price: one of the amounts the listing itself shows.
  const amt = amountOf(out.price);
  if (amt != null && !pricesIn(`${listing.title ?? ""}\n${listing.text ?? ""}`).some(p => Math.abs(p - amt) < 0.005)) {
    dropped.push(`price ${out.price} (not on the listing)`); out.price = "";
  }
  // Size: the size in the listing's own title — a page lists every size it comes in, the title is
  // the one this listing is — and never one the photo's own file name contradicts.
  const titled = sizesIn(listing.title);
  const pictured = sizesIn((() => { try { return photoUrl ? decodeURIComponent(new URL(photoUrl).pathname) : ""; } catch { return ""; } })());
  for (const k of ["name", "detail"]) {
    for (const s of sizesIn(out[k])) {
      const why = !titled.some(t => sameSize(t, s)) ? (titled.length ? `the listing says ${titled[0].raw.trim()}` : "the listing title gives no size")
        : pictured.length && !pictured.some(p => sameSize(p, s)) ? `the photo is the ${pictured[0].raw.replace(/[-_]/g, " ").trim()}` : null;
      if (why) { dropped.push(`size ${s.raw.trim()} (${why})`); out[k] = tidy(out[k].replace(s.raw, " ")); }
    }
  }
  return { option: out, dropped };
}

const LISTING_ASK = "this product's exact name, size or variant, and price on this listing";

/** Find the listing an option's photo came from, read it, and check the option against it. */
async function checkListing(c, o, { lookup = (u) => webLookup(u, { maxChars: 4000, timeoutMs: 12_000, objective: LISTING_ASK }) } = {}) {
  const img = String(o.image_url ?? "").trim();
  const from = img ? db.seenUrlInfo(c, img)?.from ?? "" : "";
  const page = [from, o.url].find(u => u && db.hasSeenUrl(c, u)) ?? "";
  if (!page) return checkAgainstListing(o, null);
  const listing = await lookup(page).catch(() => null);
  if (!listing?.ok || !(listing.title || listing.text)) return checkAgainstListing(o, null);
  // With no picture of its own the card shows this page's own picture, which is this listing.
  const photoFromListing = !img || from === page || (listing.images ?? []).includes(img);
  const checked = checkAgainstListing(o, listing, { photoUrl: img, photoFromListing });
  return { ...checked, option: { ...checked.option, url: checked.option.url || page } };
}

export async function runChoiceTool(name, input, ctx) {
  const c = ctx.conversationId;
  if (name !== "show_choices" || !choiceCardsOn(c)) return { ok: false, error: "Choice cards are not available here. Write the options as a short numbered list." };
  if (ctx.historyId && ctx.historyId !== c) return { ok: false, error: "This is a Web-only chat. Write the options as a short numbered list." };
  const asked = (input.options ?? []).slice(0, 4);
  if (asked.length < 2) return { ok: false, error: "Cards are for 2 to 4 real options. With one, just answer." };
  const theme = themeFor(c);
  const log = ctx.log ?? (() => {});

  // Products: price and size only as the listing the photo came from says them (checkListing).
  const checks = input.kind === "places" ? asked.map(o => ({ option: o, dropped: [] }))
    : await Promise.all(asked.map(o => checkListing(c, o, ctx.lookup ? { lookup: ctx.lookup } : {}).catch(() => checkAgainstListing(o, null))));
  const options = checks.map(x => x.option);
  const offCards = checks.flatMap((x, i) => x.dropped.map(d => `option ${i + 1}: ${d}`));
  if (offCards.length) log({ choice_cards_unbacked: c, dropped: offCards });
  const offNote = offCards.length ? ` Left off because the store listing does not back it — do not say these in your line either: ${offCards.join("; ")}.` : "";

  // Every photo or none: a set where card 2 is a picture and card 3 is a sentence reads as broken.
  const photos = await Promise.all(options.map(o => photoFor(c, o.image_url, { ...ctx, pageUrl: o.url ?? null }).catch(e => ({ ok: false, why: e?.message ?? String(e) }))));
  let cards = null;
  let why = photos.find(p => !p.ok)?.why ?? null;
  if (!why) {
    try {
      cards = [];
      for (const [i, o] of options.entries()) {
        cards.push(await drawCard({ n: i + 1, kind: input.kind, theme, ...o, photo: photos[i].uri }, { shoot: ctx.shoot ?? shootWithChromium }));
      }
    } catch (e) {
      cards = null;
      why = (e?.message ?? String(e)).split("\n")[0];
    }
  }
  const set = db.openChoiceSet({
    conversationId: c, kind: input.kind,
    options: options.map((o, i) => ({ n: i + 1, name: o.name, brand: o.brand ?? "", price: o.price ?? "", detail: o.detail ?? "", why: o.why ?? "", url: o.url ?? "", image_url: o.image_url ?? "", card: cards?.[i]?.name ?? null })),
    state: cards ? "queued" : "text", expiresAt: clock.now() + CHOICE_TTL_MS,
  });
  if (!cards) {
    log({ choice_cards_text: c, set: set.id, why });
    return {
      ok: true, fallback: "text", set_id: set.id,
      note: `No cards this time (${why}). Write them as a short numbered list in your reply, one line each, in this order — the numbers are kept, so a number back picks that one:\n${options.map(textLine).join("\n")}${offNote}`,
    };
  }
  queued.set(c, { setId: set.id, cards });
  log({ choice_cards_drawn: c, set: set.id, n: cards.length, theme });
  return {
    ok: true, set_id: set.id, cards: cards.length,
    note: `${cards.length} cards are drawn and go out right after your reply, one bubble each, numbered 1–${cards.length}. Your reply is just the one short line above them — what these are and that it is their pick. Do not list them again and do not mention cards or pictures.${offNote}`,
  };
}

/**
 * After the reply line went out: each card, in order, each send awaited before the next. A turn
 * whose words did not go sends no cards (the line is what makes them make sense) and the set is
 * dropped. Never throws; never costs anybody the reply that already went.
 */
export async function sendQueued(conversationId, { router, route, withWords, log = () => {}, sleep = (ms) => new Promise(r => setTimeout(r, ms)) }) {
  const q = takeQueued(conversationId);
  if (!q) return null;
  if (!withWords || !router || !route?.channel || route.channel === "console") {
    db.setChoiceState(q.setId, "dropped");
    log({ choice_cards_dropped: conversationId, set: q.setId, why: withWords ? "no channel to send pictures on" : "the turn sent no words" });
    return { sent: 0 };
  }
  const handles = [];
  let sent = 0;
  for (const [i, card] of q.cards.entries()) {
    if (i) await sleep(GAP_MS);
    let r;
    try {
      r = await router.sendMedia({
        channel: route.channel, to: route.to, chatId: route.chatId ?? null, text: "",
        file: card.file, mimeType: "image/jpeg", filename: `reason-${i + 1}.jpg`,
        conversationId, toOwner: true, idempotencyKey: `choice:${q.setId}:${i + 1}`,
      });
    } catch (e) {
      r = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
    }
    if (!r?.ok) {
      log({ choice_card_failed: conversationId, set: q.setId, n: i + 1, why: r?.error ?? "unknown" });
      break;
    }
    handles[i] = r.delivered?.message_id ?? null;
    sent++;
  }
  db.setChoiceShown(q.setId, { handles, state: sent === q.cards.length ? "shown" : sent ? "partial" : "dropped" });
  log({ choice_cards_sent: conversationId, set: q.setId, sent, of: q.cards.length });
  return { sent };
}

// ---------- reading what came back ----------

const TAPBACK = /^\s*(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned|Reacted\s+\S+\s+to)\s+(an image|a photo|an attachment|“([\s\S]*)”|"([\s\S]*)")\s*$/u;

/** Is this text an iPhone tapback written out as words? `{ verb, image, quoted }` or null. */
export function readTapback(text) {
  const m = TAPBACK.exec(String(text ?? ""));
  if (!m) return null;
  return { verb: m[1].replace(/\s+/g, " "), image: !m[3] && !m[4], quoted: m[3] ?? m[4] ?? null };
}

const ago = (ms) => { const m = Math.round(ms / 60_000); return m < 60 ? `${Math.max(1, m)} min` : `${Math.round(m / 60)} h`; };

/**
 * The line put in front of their next message while a set is open: what each number was, and
 * anything exact about which card it points at. Empty when nothing is open.
 */
export function inboundChoiceLine(conversationId, { text = "", replyTo = null, now = clock.now() } = {}) {
  let set;
  try { set = db.openChoiceFor(conversationId, now); } catch { return ""; }
  if (!set) return "";
  try { db.countChoiceRead(set.id); } catch { /* best effort */ }
  const list = set.options.map(o => `${o.n} = ${[o.name, o.price, o.detail].filter(Boolean).join(", ")}`).join("; ");
  const shown = set.state === "text" ? "as a numbered list" : `as ${set.options.length} numbered picture cards`;
  let line = `[${ago(now - (set.shown_at ?? set.created_at))} ago you showed them ${set.options.length} options ${shown}: ${list}.`;
  const onCard = replyTo ? set.handles.findIndex(h => h && sameHandle(h, replyTo)) : -1;
  const tb = readTapback(text);
  if (onCard >= 0) {
    line += ` This is an inline reply on card ${onCard + 1} (${set.options[onCard].name}) — read it as about that one.`;
  } else if (tb && tb.image) {
    line += set.options.length === 1 || set.handles.filter(Boolean).length === 1
      ? ` This is a ${tb.verb.toLowerCase()} tapback on the card — that is their pick.`
      : ` This is a ${tb.verb.toLowerCase()} tapback on ONE of the cards, and the phone does not say which. Do not guess: ask which one in a few plain words.`;
  } else if (tb && tb.quoted) {
    const hit = set.options.find(o => tb.quoted.toLowerCase().includes(o.name.toLowerCase()));
    line += hit ? ` This is a tapback on the line naming option ${hit.n} — that is their pick.` : ` This is a tapback on one of your own texts, not a pick.`;
  } else {
    line += " If this message picks one — by number, by how it looks, by name — go ahead with that one. If it is about something else, leave the options be.";
  }
  return `${line}]`;
}

const sameHandle = (a, b) => String(a).split("_")[0] === String(b).split("_")[0];

/** Their message settled it, or a new set replaced it: closed, so the next message is not read against it. */
export function closeChoices(conversationId) {
  try { db.closeChoiceSets(conversationId); } catch { /* best effort */ }
}
