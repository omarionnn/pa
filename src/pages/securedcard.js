// "Secured by Reason": the link card for every link Reason texts that signs someone in, connects an
// account, saves a card or approves a payment (owner ask 2026-11-10: the Face ID purchase link
// unfurled as a bare address, while a competitor's connect link shows a soft card that says
// "Secured by <brand>" with "Connect Google" under it).
//
// iMessage's LinkPresentation (and facebookexternalhit) fetch the link with no cookie, so they read
// whatever a stranger holding the link would: a gate, a start page, the approval page itself. The
// tags here are the same for everybody who gets that kind of link. They name the action ("Approve
// purchase", "Connect Google") and never the person, the store, the item or an amount; no og:url
// either, so the link's token is never repeated in the card.
//
// The pictures are drawn once by scripts/make-secured-cards.mjs into assets/secured/<kind>.png and
// served by this install at /web/og/secured/<kind>.png (the website proxies /web/* here, so the
// address is heyreason.com's). Redraw → bump SECURED_CARD_VERSION, so phones fetch the new one.
import { readFileSync } from "node:fs";
import { config } from "../config.js";

export const SECURED_CARD_VERSION = 1;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * One entry per kind of link. `title` is og:title (the line iMessage prints under the picture, over
 * the domain); `eyebrow` is the small capitals on the picture. Words only about the action.
 */
export const SECURED_CARDS = {
  approve: { title: "Approve purchase", eyebrow: "APPROVE PURCHASE", description: "Approve with Face ID. Secured by Reason." },
  limit: { title: "Approve new daily limit", eyebrow: "APPROVE NEW LIMIT", description: "Approve with Face ID. Secured by Reason." },
  card: { title: "Save your card", eyebrow: "SAVE YOUR CARD", description: "Add a card for purchases. Secured by Reason." },
  store: { title: "Connect your store account", eyebrow: "CONNECT A STORE", description: "Sign in to a store for Reason. Secured by Reason." },
  signin: { title: "Sign in securely", eyebrow: "SIGN IN", description: "Sign in on Reason's browser. Secured by Reason." },
  google: { title: "Connect Google", eyebrow: "CONNECT GOOGLE", description: "Connect your Google account. Secured by Reason." },
  github: { title: "Connect GitHub", eyebrow: "CONNECT GITHUB", description: "Connect your GitHub account. Secured by Reason." },
  spotify: { title: "Connect Spotify", eyebrow: "CONNECT SPOTIFY", description: "Connect your Spotify account. Secured by Reason." },
  x: { title: "Connect X", eyebrow: "CONNECT X", description: "Connect your X account. Secured by Reason." },
  amazon: { title: "Connect Amazon", eyebrow: "CONNECT AMAZON", description: "Connect your Amazon account. Secured by Reason." },
  uber: { title: "Connect Uber", eyebrow: "CONNECT UBER", description: "Connect your Uber account. Secured by Reason." },
  web: { title: "Sign in to Reason", eyebrow: "SIGN IN TO REASON", description: "Pick up your conversation from any browser. Secured by Reason." },
  connect: { title: "Connect your account", eyebrow: "CONNECT AN ACCOUNT", description: "Connect an account to Reason. Secured by Reason." },
};

const KIND = /^[a-z]{1,16}$/;
/** The kind for an OAuth provider's connect link; the plain "connect" card for any other. */
const PROVIDERS = new Set(["google", "github", "spotify", "x", "uber"]);
export const providerKind = (provider) => (PROVIDERS.has(provider) ? provider : "connect");

/** Where the pictures are fetched from: the website (it proxies /web/* to this install). */
const imageOrigin = () => (config.siteUrl || process.env.REASON_SITE_URL || "https://heyreason.com").replace(/\/+$/, "");
export const securedImagePath = (kind) => `/web/og/secured/${kind}.png`;
export const securedImageUrl = (kind) => `${imageOrigin()}${securedImagePath(kind)}?v=${SECURED_CARD_VERSION}`;

/** The head lines for one kind. An unknown kind gets the plain "connect" card rather than nothing. */
export function securedCardTags(kind) {
  const k = Object.hasOwn(SECURED_CARDS, kind) ? kind : "connect";
  const card = SECURED_CARDS[k];
  const image = securedImageUrl(k);
  const alt = `Secured by Reason. ${card.title}.`;
  return [
    `<meta name="description" content="${esc(card.description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Reason">`,
    `<meta property="og:title" content="${esc(card.title)}">`,
    `<meta property="og:description" content="${esc(card.description)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:secure_url" content="${esc(image)}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc(alt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(card.title)}">`,
    `<meta name="twitter:description" content="${esc(card.description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
  ].join("\n");
}

const cache = new Map();
/**
 * GET /web/og/secured/<kind>.png: the picture, or null for anything that is not one. Same for
 * everybody, nothing of anybody's in it, so it is cached a day (the ?v= changes with a redraw).
 */
export function securedImageRequest(pathname) {
  const m = /^\/web\/og\/secured\/([a-z]{1,16})\.png$/.exec(String(pathname));
  if (!m || !KIND.test(m[1]) || !Object.hasOwn(SECURED_CARDS, m[1])) return null;
  let bytes = cache.get(m[1]);
  if (!bytes) {
    try { bytes = readFileSync(new URL(`../../assets/secured/${m[1]}.png`, import.meta.url)); } catch { return null; }
    cache.set(m[1], bytes);
  }
  return { status: 200, headers: { "Content-Type": "image/png", "Content-Length": bytes.length, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }, body: bytes };
}

/** A page already drawn, with the card's tags put in its head (just before its <title>). */
export const withSecuredCard = (html, kind) => String(html).replace("<title>", `${securedCardTags(kind)}\n<title>`);
