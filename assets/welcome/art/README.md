# Welcome card drawings

The seven line drawings from Reason's welcome cards, one SVG each: calls, events, reminders, shopping, food, booking, more. Omari approved them on 2026-11-11.

**How they're made**
- The paths are hand-written SVG on a 240×190 grid, in `DRAW` in `scripts/make-welcome-cards.mjs`. That file is the source. The SVGs here are written from it every time `node scripts/make-welcome-cards.mjs` runs, so make edits in the script, not here.
- There are two colours. Ink `#2a2520` draws the object. The brand pen `#9c3b2e` (the site's `--accent`) draws one accent per drawing: the signal waves, bunting, alarm lines, check mark, steam, candle flame or magnifier.
- Strokes are 6.5 wide on the 240 grid (about 2.7% of the width), with round caps and joins and no fills.
- The hand-drawn wobble comes from an SVG filter, not from the paths: `feTurbulence` (fractalNoise, baseFrequency 0.035, 2 octaves, seed = card number × 7) feeding `feDisplacementMap` at scale 3.2. Change the seed to get a different wobble, or remove the filter to get clean lines.
- The handset on the Calls card is the Feather phone icon scaled ×5.2. Its stroke is 1.25, which gives the same visual weight as 6.5 on the other drawings.

**Reusing on the site:** use an SVG as an `<img>` or paste it inline. On the site's paper colour (`#f2ebe0`) it matches the cards. For the dark theme, change the ink to `#efe6d6` and the pen to `#d46a5c` (the site's dark-mode colours). The rest of the card layout (mono eyebrow, Instrument Serif italic title, Caveat note, blue bubble) is the HTML template in the same script.
