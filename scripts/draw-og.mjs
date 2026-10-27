// Draws assets/og.png, the picture an invite link falls back to when its own card cannot be drawn
// (src/http.js), from the invite card itself (src/invitecard.js) with no inviter name — so the
// fallback is always the current card look, never a design of its own. Run again after the card or
// the brand pen changes: `node scripts/draw-og.mjs`.
import { writeFileSync } from "node:fs";
import { inviteCardHtml } from "../src/invitecard.js";
import { shootWithChromium } from "../src/pages/card.js";

const out = new URL("../assets/og.png", import.meta.url);
writeFileSync(out, await shootWithChromium(inviteCardHtml("A friend")));
console.log(`drew ${out.pathname}`);
