#!/usr/bin/env node
// Measure the event pages' text boxes against their buttons in headless Chromium, the way a phone
// sees them: the sign-in number box, the code box (sign-in and the private-page gate) and the join
// step's boxes, at 320/375/390/430 wide (mobile) and 1280 (desktop), dark and light. Renders the
// pages in process from src/pages/event.js — no server, no database rows, nothing sent anywhere.
//
//   cd ~/Desktop/pa && node .agents/skills/verify-reason/bin/event-inputs.mjs [--shot out.png]
//
// One line per page × width × scheme, `ok` or `FAIL`; exits non-zero on any FAIL. A box passes when
// its left/right edges are the button's, it is ≥48px tall with ≥16px text (no iOS zoom), and the
// page has no sideways scroll — also with a long number typed in. `--shot` saves the 390px dark
// sign-in page.
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { createRequire } = await import("node:module");
// Importing the page modules opens the database module; give it a throwaway file, never a real one.
process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "ev-inputs-")), "x.db");
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[k];

const root = new URL("../../../../", import.meta.url);
const ev = await import(new URL("src/pages/event.js", root));
const { chromium } = createRequire(new URL("package.json", root))("playwright");
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : "";

const e = { id: 1, public_id: "abcdEFGH12345678", name: "Game Night", place: "Somewhere", description: "Board games", guest_list_visible: 1, organizer_token: "x" };
const html = (r) => typeof r === "string" ? r : r.body;
const pages = [
  ["signin", html(ev.renderSignin({ ev: e })), "#number"],
  ["signin long number", html(ev.renderSignin({ ev: e, number: "+1 (555) 123-4567 ext 99999999" })), "#number"],
  ["signin code", html(ev.renderSignin({ ev: e, number: "+15551234567", sent: true })), "#code"],
  ["gate code", html(ev.renderGate({ ev: e, token: "t", sent: true })), "#code"],
  ["join", html(ev.renderJoin({ ev: e })), "#display_name"],
];

let fails = 0;
const b = await chromium.launch();
try {
  for (const scheme of ["dark", "light"]) for (const [name, body, sel] of pages) for (const w of [320, 375, 390, 430, 1280]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 }, isMobile: w < 1000, hasTouch: w < 1000, deviceScaleFactor: 2, colorScheme: scheme });
    const p = await ctx.newPage();
    await p.setContent(body);
    const m = await p.evaluate((sel) => {
      const f = document.querySelector(sel), btn = f.form.querySelector("button[type=submit]");
      const a = f.getBoundingClientRect(), c = btn.getBoundingClientRect();
      return { l: [a.left, c.left].map(Math.round), r: [a.right, c.right].map(Math.round), h: Math.round(a.height),
        fs: parseFloat(getComputedStyle(f).fontSize), hscroll: document.documentElement.scrollWidth > innerWidth };
    }, sel);
    const ok = m.l[0] === m.l[1] && m.r[0] === m.r[1] && m.h >= 48 && m.fs >= 16 && !m.hscroll;
    if (!ok) fails++;
    console.log(`${ok ? "ok  " : "FAIL"} ${scheme} ${name} ${w}px — box ${m.l[0]}–${m.r[0]} button ${m.l[1]}–${m.r[1]}, ${m.h}px tall, ${m.fs}px text${m.hscroll ? ", SIDEWAYS SCROLL" : ""}`);
    if (shot && scheme === "dark" && name === "signin" && w === 390) await p.screenshot({ path: shot });
    await ctx.close();
  }
} finally { await b.close(); }
process.exit(fails ? 1 : 0);
