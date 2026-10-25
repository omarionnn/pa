// Reason's trademark orange (owner, 2026-10-25), the one place it is written down. Every orange on
// every page Reason serves — the "An event" kicker, the way back to Reason, a connector's error line,
// the cover's kicker — reads one of these two, never its own hex.
//
// BRAND_ORANGE is the light-page orange: 5.4:1 on white, 4.5:1 on the paper page (#f2ebe0), so small
// uppercase text passes AA and white on it does too. On a dark page that same orange is too dim
// (≈2.8:1), so dark pages take BRAND_ORANGE_DARK: the same hue and saturation, lightness 38% → 56%,
// 5.9:1 on the dark card (#1b1916), 6.4:1 on the dark ground, 5.6:1 on the dark soft fill.

export const BRAND_ORANGE = "#B8460B";
export const BRAND_ORANGE_DARK = "#F26F2B";

// The light page is the marketing site's paper (~/Desktop/reason-site-new/public/styles.css, owner
// 2026-10-25): its ground, raised paper, warm fill, rule and ink, copied hex for hex, plus the same
// faint fractal-noise grain the site lays over its body. Every page Reason serves reads its light
// colours from here; dark pages keep their own. One change from the site: its secondary text
// (#78705f) is 4.1:1 on its own ground, so `dim` is the same hue darkened to #6a6253 (5.1:1 on bg,
// 4.8:1 on the warm fill, 5.6:1 on paper). Brand orange is 4.5:1 on bg, 5.0:1 on paper; on the ground
// (4.3:1) it is only ever the wordmark bubble, a graphic, never text (bin/theme-all.mjs checks).
export const PAPER = {
  ground: "#ede5d8", // site --bg-warm: the strip behind the top line, and the phone's chrome
  bg: "#f2ebe0",     // site --bg: the page itself
  card: "#faf6ee",   // site --paper: cards, inputs, tables
  soft: "#ede5d8",   // site --bg-warm: quiet fills
  line: "#d4c9b5",   // site --border
  ink: "#2a2520",    // site --text
  dim: "#6a6253",    // site --text-secondary, darkened for 4.5:1
};
export const PAPER_GRAIN = `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E")`;
