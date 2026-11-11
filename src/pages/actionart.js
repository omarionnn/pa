// The drawings on Action Cards (src/pages/actioncards.js): hand-drawn line art in the welcome cards'
// style (assets/welcome/art/README.md): a 240×190 grid, ink #2a2520 with one pen accent (brand red),
// round strokes, and a little wobble from a turbulence filter so no two look machine-made. Drawings,
// not logos (owner, 2026-11-11): a thing is drawn, a brand is only ever a word in the title.
//
// `drawing` on a card names one of these; an unknown name gets `note`, a plain pen line, so a card
// is never without a picture. Add a drawing: a few paths on the grid, in ink() and pen().
import { PAPER, BRAND_PEN } from "./brand.js";

const INK = PAPER.ink, PEN = BRAND_PEN;
const ink = (d, w = null) => `<path d="${d}" stroke="${INK}"${w ? ` style="stroke-width:${w}"` : ""}/>`;
const pen = (d, w = null) => `<path d="${d}" stroke="${PEN}"${w ? ` style="stroke-width:${w}"` : ""}/>`;

export const DRAW = Object.freeze({
  // a key, with the "expires" sparks in pen
  key: [
    ink("M72 95a34 34 0 1 0 .1 0z"),
    ink("M106 95H214M186 95v20M204 95v26M164 95v14"),
    pen("M72 95a11 11 0 1 0 .1 0z"),
    pen("M196 40l-8 18M226 48l-16 14M232 76l-20 4"),
  ],
  // a two-tier cake, icing and flames in pen
  cake: [
    ink("M22 154H218M34 154q4 16 22 16h128q18 0 22-16"),
    ink("M48 154v-30h144v30M76 124V98h88v26"),
    pen("M48 132q12 12 24 0t24 0 24 0 24 0 24 0 24 0"),
    ink("M104 98V74M120 98V68M136 98V74"),
    pen("M104 64q-7-8 0-17 7 9 0 17zM120 58q-7-8 0-17 7 9 0 17zM136 64q-7-8 0-17 7 9 0 17z"),
  ],
  // a server rack, the pulse spiking in pen
  server: [
    ink("M62 36H178V150H62Z"),
    ink("M62 74H178M62 112H178"),
    ink("M150 55h12M150 93h12M150 131h12"),
    `<circle cx="80" cy="55" r="3.5" fill="${INK}" stroke="none"/><circle cx="80" cy="93" r="3.5" fill="${INK}" stroke="none"/>`,
    `<circle cx="80" cy="131" r="4" fill="${PEN}" stroke="none"/>`,
    pen("M10 178h34l8-22 8 44 8-34 8 20 6-8h22l8-22 8 44 8-34 8 20 6-8h86"),
  ],
  // a calendar page, one day ringed in pen
  calendar: [
    ink("M40 50H200V166H40Z"),
    ink("M40 82H200M72 36v26M168 36v26"),
    ink("M64 110h18M104 110h18M144 110h18M64 140h18M104 140h18"),
    pen("M160 140a14 14 0 1 0 .1 0z"),
  ],
  // an envelope, the flap's tip in pen
  mail: [
    ink("M34 56H206V150H34Z"),
    ink("M34 56l86 62 86-62"),
    pen("M34 150l64-50M206 150l-64-50"),
  ],
  // a phone handset, three rings in pen
  phone: [
    ink("M60 52q-18 10-6 44 16 44 56 76 32 24 56 10 16-10 4-24l-18-14q-8-6-18 2l-10 8q-26-18-44-52l10-8q8-8 2-18l-12-20q-8-12-20-4z"),
    pen("M150 44q14 4 22 18M156 24q26 8 40 36M164 6q36 12 52 50"),
  ],
  // a bag with a handle, the tag in pen
  bag: [
    ink("M52 78H188L178 166H62Z"),
    ink("M86 78V62q0-26 34-26t34 26v16"),
    pen("M150 100l20 20M170 100l-20 20"),
  ],
  // a tooth: the dentist
  tooth: [
    ink("M72 60q24-24 48-4 24-20 48 4 18 20-2 60l-10 50q-6 14-16 0l-8-30q-12-14-24 0l-8 30q-10 14-16 0L74 120q-20-40-2-60z"),
    pen("M98 86q22-14 44 0"),
  ],
  // a plain pen line: the fallback
  note: [
    ink("M36 60H204M36 96H204M36 132H160"),
    pen("M28 158q40-14 80-4t92 2"),
  ],
});

export const drawingKeys = () => Object.keys(DRAW);
export const hasDrawing = (k) => Object.hasOwn(DRAW, String(k ?? ""));

/**
 * One drawing as inline SVG. `seed` varies the wobble so two cards never bend the same way; `cls`
 * is the class the page styles size it with. An unknown key draws `note`.
 */
export function art(key, seed = 1, cls = "art") {
  const k = hasDrawing(key) ? key : "note";
  const s = Math.max(1, Math.round(Number(seed) || 1));
  return `<svg class="${cls}" viewBox="0 0 240 190" aria-hidden="true" focusable="false"><defs><filter id="w${s}" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="${s * 7}"/><feDisplacementMap in="SourceGraphic" scale="3.2"/></filter></defs><g filter="url(#w${s})" transform="translate(0 8)" fill="none" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">${DRAW[k].join("")}</g></svg>`;
}
