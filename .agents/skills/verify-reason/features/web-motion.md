# Reason Web — §4h small details: pen writes in, stamp lands, paper grain, late night

v4 handoff §4h items 2, 3, 7 (+ 5, see web-notify.md), reference `sheet-small-details.html`. Code:
`src/pages/webkit.js` (GRAIN, LATE_GROUND, isLateNight, MOTION_CSS, INK_JS), hooks in
`src/pages/webconvo.js` CLIENT_JS (`working`, `workIs`, `settleIn`), `src/pages/webcompose.js` (`say`),
`src/pages/webnotify.js` (the 8B line after the first poll).

## Sub-features and how each is proved

- **2 pen writes itself in** — `.pen-in`: clip-path inset(0 100% 0 0) → inset(0), .5s
  cubic-bezier(.4,.1,.3,1). Played by `reasonInk(el,'pen-in')` only on something new arriving live:
  "on it." after a send/typing event, the long-work line when it appears after load, the "just wrapped"
  note of a task settled live, the composer's Caveat note, the 8B nudge after the first poll. Never on
  load, deferred L1 load, ↑ earlier messages, or reload.
- **3 stamp lands** — `.stamp-in`: opacity 0→1, `scale` 1.8 → .92 (58%) → 1, .45s cubic-bezier(.3,1.4,.5,1);
  the tilt stays in the inline `transform: rotate()`. Played on the DONE stamp of a fold that `settleIn`
  draws for the first time (no previous `.done[data-task]`). Stamps at load never animate.
- **7 grain** — `--grain` (the sheet's SVG URI) at 160px, `background-attachment:fixed` on body and the
  bars drawn in the ground (`.top,.netline,.composer,.tabs,.menu,.listen,.fg-wrap,.loader`) so no seam;
  lifted paper flat. `prefers-contrast: more` → none.
- **7 late night** — `<html class=late>` set in the head before paint when the browser's local hour is
  23–04, re-checked each minute; CSS swaps `--ground` #1c1814 → #221a13 on Night only (data-theme=dark,
  or Auto + dark scheme). `--ground` is a registered `@property`; `late-go` (2.1 s, only when it turns
  while open) fades it over 2 s.
- **Reduced motion** — the kit's global rule removes all animation/transition: end states at once,
  late-night swap instant.

## Drive

```bash
node --test test/web-4h-motion.test.js           # pure: hour edges 22:59/23:00/04:59/05:00, tokens, CSS, title
node --test test/web-4h-motion-browser.test.js   # Chromium: nothing at load; "on it." pen-in after a send;
                                                 # a task finished while watching → stamp-in + pen-in once;
                                                 # reduced motion; grain + contrast more; late night by page.clock
```

Live proof: open https://heyreason.com/web signed in (short-lived owner session) in Chromium with
`page.clock.install` at 23:30 local + colorScheme dark → body background rgb(34, 26, 19); at 15:00 →
rgb(28, 24, 20); body `background-image` is the grain URI. Tab: with an approval pending,
`document.title === "Reason · needs you"` and the icon link href is `favicon(-night)-needs-you.svg`.
