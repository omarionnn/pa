// The link card (og/twitter tags) for the public pages the website proxies to this install: /web
// signed out, /privacy and /terms. iMessage's LinkPresentation and facebookexternalhit fetch with no
// cookies, so what they read is always the signed-out page; a signed-in page never calls this, so
// nothing private can end up in a preview.
//
// The pictures live on the website (heyreason.com/og-*.png), drawn by tools/make-og-pages.mjs in
// ~/Desktop/reason-site-new in the homepage card's layout. Bump `v` with a redraw so phones refetch.
import { config } from "../config.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The website's origin; the domain itself when this install was not told one (the cards only live there). */
export const cardOrigin = () => (config.siteUrl || "https://heyreason.com").replace(/\/+$/, "");

export const CARDS = {
  web: {
    title: "Reason on the web",
    description: "Pick up your conversation with Reason from any browser.",
    path: "/web",
    image: "/og-web.png?v=1",
    alt: "Reason on the web. Pick up the thread from any browser.",
  },
  privacy: {
    title: "Reason · Privacy",
    description: "What Reason keeps, what leaves the machine, and how to get rid of all of it.",
    path: "/privacy",
    image: "/og-legal.png?v=1",
    alt: "Reason privacy and terms. The fine print, in plain words.",
  },
  terms: {
    title: "Reason · Terms",
    description: "What Reason is, what it promises, and what it does not.",
    path: "/terms",
    image: "/og-legal.png?v=1",
    alt: "Reason privacy and terms. The fine print, in plain words.",
  },
};

/** The head lines for one of `CARDS`. */
export function linkCardTags(name) {
  const card = CARDS[name];
  const origin = cardOrigin();
  const image = `${origin}${card.image}`;
  return [
    `<meta name="description" content="${esc(card.description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Reason">`,
    `<meta property="og:title" content="${esc(card.title)}">`,
    `<meta property="og:description" content="${esc(card.description)}">`,
    `<meta property="og:url" content="${esc(`${origin}${card.path}`)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc(card.alt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(card.title)}">`,
    `<meta name="twitter:description" content="${esc(card.description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
  ].join("\n");
}
