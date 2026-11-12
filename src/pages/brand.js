// Reason's brand pen colour, the one place it is written down: brick red (owner, 2026-10-26; deepened
// 10-26 ~23:45 to the values below), replacing the 10-25 orange (#B8460B light / #F26F2B dark). Every accent on every page Reason
// serves — the wordmark bubble, the "An event" kicker, the way back to Reason, a connector's error
// line, the cover's kicker — reads one of these two, never its own hex. (Reason Web's own files,
// src/pages/websignin.js and src/pages/webconvo.js, move on their own branch.)
//
// BRAND_PEN is the light-page red: AA for small text on white and on the paper page (#f2ebe0), and
// white on it passes too. On a dark page it is too dim, so dark pages take BRAND_PEN_DARK, a warm,
// lighter brick that is AA on the dark card (#1b1916), the dark ground and the dark soft fill.

export const BRAND_PEN = "#9c3b2e";
export const BRAND_PEN_DARK = "#d46a5c";

// A page's card is drawn once and kept on disk with the pen in its pixels, so its file name and `?v=`
// include this. Bump it with the pen (and INVITE_CARD_VERSION, DRAWN_COVER_VERSION for the other kept
// pictures) and every card is drawn again at a new address; #175 changed the pen without it.
export const BRAND_ART = "pen3";

// The light page is the marketing site's paper (~/Desktop/reason-site-new/public/styles.css, owner
// 2026-10-25): its ground, raised paper, warm fill, rule and ink, copied hex for hex, plus the same
// faint fractal-noise grain the site lays over its body. Every page Reason serves reads its light
// colours from here; dark pages keep their own. One change from the site: its secondary text
// (#78705f) is 4.1:1 on its own ground, so `dim` is the same hue darkened to #6a6253 (5.1:1 on bg,
// 4.8:1 on the warm fill, 5.6:1 on paper). Brand red is 5.8:1 on bg,
// 6.3:1 on paper and 5.5:1 on the ground, so it passes everywhere (bin/theme-all.mjs checks).
export const PAPER = {
  ground: "#ede5d8", // site --bg-warm: the strip behind the top line, and the phone's chrome
  bg: "#f2ebe0",     // site --bg: the page itself
  card: "#faf6ee",   // site --paper: cards, inputs, tables
  soft: "#ede5d8",   // site --bg-warm: quiet fills
  line: "#d4c9b5",   // site --border
  ink: "#2a2520",    // site --text
  dim: "#6a6253",    // site --text-secondary, darkened for 4.5:1
};
// The welcome cards' glow (scripts/make-welcome-cards.mjs `.c`, owner 2026-11-11: "the cards'
// background on every page"): a peach glow from the top-left and a faint brick one from the
// bottom-right, under the grain. The card is 1080×1350 with a 900×600 and an 800×600 ellipse; here
// the ellipses take the same share of the screen's width (83vw, 74vw, capped on wide desktops) and
// at least 44% of its height, so a phone reads like the card and a desktop is not a corner smudge.
// NIGHT_GLOW is the same two glows on a dark page (amber, then the dark pen), low enough that every
// text still clears 4.5:1 at the brightest point (.agents/skills/verify-reason/bin/glow-contrast.mjs).
// A page writes `--glow:${PAPER_GLOW}` in its light :root and `--glow:${NIGHT_GLOW}` in its dark one,
// its paper takes `background:${SHEET_BG}`, and GLOW_OFF drops the glow for prefers-contrast: more.
const GLOW_RY = "max(44vh,min(56vw,640px))";
export const PAPER_GLOW = `radial-gradient(min(83vw,1200px) ${GLOW_RY} at 0 0,rgba(246,206,160,.45),transparent 65%),radial-gradient(min(74vw,1100px) ${GLOW_RY} at 100% 100%,rgba(156,59,46,.10),transparent 60%)`;
export const NIGHT_GLOW = `radial-gradient(min(83vw,1200px) ${GLOW_RY} at 0 0,rgba(226,150,82,.07),transparent 65%),radial-gradient(min(74vw,1100px) ${GLOW_RY} at 100% 100%,rgba(212,106,92,.05),transparent 60%)`;
export const GLOW_OFF = "@media (prefers-contrast:more){:root,:root[data-theme]{--glow:none}}";
export const SHEET_BG = "var(--grain),var(--glow) var(--bg)";
export const PAPER_GRAIN = `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E")`;
