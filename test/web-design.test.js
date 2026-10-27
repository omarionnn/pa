// Reason Web in the owner's design handoff (2026-10-26; src/pages/webkit.js, websignin.js, webconvo.js).
// One pinned test per screen state and per rule the handoff calls non-negotiable:
//
//   - the tokens are the handoff's table, hex for hex, Paper and Night, with Auto following the phone
//   - reduced motion means no motion at all; keyboard focus is a 2px ink outline offset 3px
//   - every screen state carries its copy, its roles (status / alert / log) and real controls with names
//   - no screen coaches a phrase to type (owner rule 10-25), the approval nudge included
//   - Reason's words: lists become 01 02 03, Reason's own links become cards, titles only from rows
//     this conversation owns; photos, voice notes and files in history are drawn from /web/media/…,
//     never from the address they came from (test/web-compose.test.js pins the inputs)
//   - instant replies: the live stream may be heard on the pages host, with CORS for the website's
//     origin only, and /web/live is not sent round to the website like the rest of /web
//   - fonts are self-hosted; nothing comes from Google
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-web-design-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_EVENTS_URL = "https://events.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_SITE_PROXY_SECRET = "design-test-secret";
process.env.REASON_WEB = "on";
delete process.env.REASON_WEB_STREAM;

const kit = await import("../src/pages/webkit.js");
const ws = await import("../src/pages/websignin.js");
const wc = await import("../src/pages/webconvo.js");
const web = await import("../src/web.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const { createServer } = await import("../src/http.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver } = await import("../src/deliver.js");

const KOFI = "+14155559876", AMA = "+13475550000";
const KOFI_C = `dm:fake:${KOFI}`, AMA_C = `dm:fake:${AMA}`;
const LINE = "+16562167455";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  config.webStream = "";
  db.db.exec("DELETE FROM accounts; DELETE FROM threads; DELETE FROM messages; DELETE FROM page_sessions; DELETE FROM pages; DELETE FROM tasks; DELETE FROM timers; DELETE FROM confirmations;");
  for (const [c, a, n] of [[KOFI_C, KOFI, "Kofi Mensah"], [AMA_C, AMA, "Ama"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: false });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
});

/** Every page Web can draw, by state name. */
function allScreens() {
  const account = db.getAccount(KOFI_C);
  return {
    signin: ws.renderSignin({ joinNumber: LINE, formToken: "t" }),
    signedOut: ws.renderSignin({ joinNumber: LINE, formToken: "t", out: true }),
    signinPause: ws.renderSignin({ joinNumber: LINE, formToken: "t", error: { kind: "pause", waitMs: 299_000 } }),
    signinOrigin: ws.renderSignin({ joinNumber: LINE, formToken: "t", error: { kind: "origin" } }),
    code: ws.renderCode({ number: "(415) 555-0142", formToken: "t" }),
    codeWrong: ws.renderCode({ number: "(415) 555-0142", formToken: "t", error: { kind: "wrong" } }),
    codeExpired: ws.renderCode({ number: "(415) 555-0142", formToken: "t", error: { kind: "expired" } }),
    codeTries: ws.renderCode({ number: "(415) 555-0142", formToken: "t", error: { kind: "tries", waitMs: 299_000 } }),
    codeResend: ws.renderCode({ number: "(415) 555-0142", formToken: "t", error: { kind: "resend", leftMs: 600_000 } }),
    join: ws.renderJoin({ joinNumber: LINE }),
    notConnected: ws.renderJoin({ joinNumber: null }),
    first: wc.renderFirstVisit({ account }),
    home: wc.renderHome({ account, csrf: "c", sendId: "s" }),
    homeInHand: wc.renderHome({ account, csrf: "c", sendId: "s", items: [{ kind: "task", state: "working", href: "/web/ongoing/task/1", title: "A cabin for Nov 14–16", status: "WORKING", words: "working on it" }] }),
    thread: wc.renderConversation({ account, csrf: "c", lines: [], more: false, sendId: "s" }),
    ongoing: wc.renderOngoing({ csrf: "c" }),
    error: wc.renderError(),
    memory: wc.soonPage({ which: "memory", account, headers: {} }),
    settings: wc.soonPage({ which: "settings", account, headers: {} }),
  };
}

// ---------- the kit ----------

test("tokens are the handoff's table, hex for hex, and Night/Auto switch the same names", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(kit.TOKENS.paper).filter(([k]) => !/shadow|hover/.test(k))),
    { ground: "#f2ebe0", deep: "#ede5d8", lifted: "#faf6ee", ink: "#2a2520", muted: "#78705f", hair: "#d4c9b5", pen: "#9c3b2e", photo: "#e3d9c8" });
  assert.deepEqual(
    Object.fromEntries(Object.entries(kit.TOKENS.night).filter(([k]) => !/shadow|hover/.test(k))),
    { ground: "#1c1814", deep: "#151210", lifted: "#27211b", ink: "#efe6d6", muted: "#a89d88", hair: "#3e362c", pen: "#d46a5c", photo: "#332b23" });
  const css = kit.KIT_CSS;
  assert.match(css, /:root\{--ground:#f2ebe0;/);
  assert.match(css, /:root\[data-theme=dark\]\{--ground:#1c1814;/, "Night when chosen");
  assert.match(css, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{--ground:#1c1814;/, "Auto follows the phone");
  assert.match(css, /--sh:2px 3px 0 rgba\(0,0,0,0\.05\)/, "hard offset, no blur");
  assert.match(kit.KIT_CSS, /--sh:2px 3px 0 rgba\(0,0,0,0\.35\)/, "Night shadow");
});

test("reduced motion is no motion at all, and focus is a 2px ink outline offset 3px", () => {
  assert.match(kit.KIT_CSS, /@media \(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important\}html\.loading \.loader\{display:none\}\}/);
  assert.match(kit.KIT_CSS, /:focus-visible\{outline:2px solid var\(--ink\);outline-offset:3px\}/);
  assert.match(kit.KIT_CSS, /\.arrive\{animation:arrive \.3s ease-out both\}/);
  assert.match(kit.KIT_CSS, /translateY\(6px\)/, "new lines rise 6px");
});

test("+ and the mic are on every composer, hidden until the page's script can make them work (owner 10-26: build them, then show +)", () => {
  let composers = 0;
  for (const [name, html] of Object.entries(allScreens())) {
    if (!html.includes('class="cform"')) continue;
    composers++;
    assert.match(html, /<button class="ic c-add" type="button" aria-label="Add a photo or file" hidden>/, `${name}: + is drawn hidden`);
    assert.match(html, /<button class="ic c-mic" type="button" aria-label="Speak instead" hidden>/, `${name}: the mic is drawn hidden`);
  }
  assert.ok(composers >= 3, "home, home in hand and the thread all carry the composer");
});

test("instant replies: the stream is the path, the 4 s poll only its fallback (owner 10-26)", () => {
  const s = allScreens().thread;
  assert.match(s, /setInterval\(function\(\)\{if\(!live\|\|Date\.now\(\)-beat>40000\)poll\(\)\},4000\)/, "no poll beside a live stream, even while a reply is awaited");
  assert.match(s, /es\.addEventListener\('ping',function\(\)\{beat=Date\.now\(\)\}\)/);
  config.webStream = "";
  const was = [config.siteUrl, config.pagesUrl];
  config.siteUrl = "https://heyreason.com"; config.pagesUrl = "https://files.heyreason.com";
  try { assert.equal(wc.streamPath(), "https://files.heyreason.com/web/live", "on by default in production's shape, no env needed"); }
  finally { [config.siteUrl, config.pagesUrl] = was; }
});

test("the wordmark: reas◯n with the bubble in pen, skewed −10°; the loader is reas◯n + ing and only where asked", () => {
  const wm = kit.wordmark();
  assert.match(wm, /role="img" aria-label="reason">reas<svg class="bub" aria-hidden="true"/);
  assert.match(kit.KIT_CSS, /\.wm \.bub\{[^}]*color:var\(--pen\);transform:skewX\(-10deg\)/);
  const thread = allScreens().thread;
  assert.match(thread, /data-loader="1"/);
  assert.match(thread, /<div class="loader" role="status" aria-label="Loading"><p>reas<svg[^]*?<\/svg>n<span class="ing">ing<\/span>/);
  assert.match(thread, /prefers-reduced-motion: reduce/, "the head script never starts it under reduced motion");
  assert.match(thread, /Math\.max\(0,1200-/, "held at least 1.2 s");
  assert.ok(!allScreens().signin.includes('class="loader"'));
});

test("the theme switch is Paper · Night · Auto as a real radio group, hidden until it can work", () => {
  const s = kit.themeSwitch();
  assert.match(s, /^<fieldset class="themes" hidden><legend class="sr">Theme<\/legend>/);
  for (const [v, t] of [["paper", "Paper"], ["night", "Night"], ["auto", "Auto"]]) assert.match(s, new RegExp(`<input type="radio" name="theme-th" value="${v}"[^>]*><span>${t}</span>`));
  // Every copy on a page is its own group, so the menu, footer and Settings copies each keep their tick.
  const names = (html) => new Set([...html.matchAll(/<input type="radio" name="(theme[^"]*)"/g)].map(m => m[1]));
  for (const [name, html] of Object.entries(allScreens())) assert.equal(names(html).size, (html.match(/class="themes"/g) || []).length, `${name}: one group per switch`);
  // The choice is the one every Reason page reads.
  assert.match(allScreens().signin, /localStorage\.getItem\('reason-theme'\)/);
  for (const [name, html] of Object.entries(allScreens())) assert.match(html, /class="themes"/, `${name} carries the switch`);
});

test("fonts are self-hosted: five faces at /web/fonts, nothing from Google, CSP font-src self", () => {
  for (const name of ["serif", "roman", "hand", "handbold", "sans"]) {
    const out = kit.webFont(name);
    assert.equal(out.status, 200, name);
    assert.equal(out.headers["Content-Type"], "font/woff2");
    assert.equal(out.body.subarray(0, 4).toString(), "wOF2", `${name} is woff2`);
  }
  assert.equal(kit.webFont("../etc"), null);
  assert.equal(kit.webFont("constructor"), null);
  for (const [name, html] of Object.entries(allScreens())) assert.ok(!/googleapis|gstatic/.test(html), name);
  assert.match(ws.SECURITY_HEADERS["Content-Security-Policy"], /font-src 'self' data:/);
  assert.match(kit.KIT_CSS, /font-family:"Reason Hand";font-style:normal;font-weight:600;[^}]*url\(\/web\/fonts\/handbold\.woff2\)/);
  assert.match(kit.KIT_CSS, /font-family:"Reason Sans";font-style:normal;font-weight:400 600;[^}]*url\(\/web\/fonts\/sans\.woff2\)/);
});

// ---------- signed out (sheet 6) ----------

test("6A sign-in: the number on an underline, the Caveat note, a text action, and the way in for somebody new", () => {
  const s = allScreens().signin;
  assert.match(s, /<h1 id="so-title" class="h1">What's your number\?<\/h1>/);
  assert.match(s, /<label for="number">PHONE NUMBER<\/label><input class="ul-in" id="number" name="number" type="tel" inputmode="tel" autocomplete="tel" placeholder="\(555\) 000-0000"/);
  assert.match(s, /<p class="hand">the same line you already text me on\.<\/p>/);
  assert.match(s, /<button class="act" type="submit">Text me a code <span aria-hidden="true">→<\/span><\/button>/);
  assert.match(s, /<a class="act2 so-new" href="\/web\?join=1">NEW TO REASON\? START WITH A TEXT →<\/a>/);
  // Desktop: the join block to the right, with the real live number and a real QR.
  assert.match(s, /<section class="so-join" aria-labelledby="dj-title"><p class="lbl">NEW TO REASON<\/p><h2 id="dj-title" class="so-h2">Your first text<br><em>is the sign-up\.<\/em><\/h2>/);
  assert.match(s, /<figure class="qr"><svg[^>]*role="img" aria-label="QR code to text Reason"/);
  assert.match(s, /<\/h2><a class="act" href="sms:\+16562167455&amp;body=Hey">Text Reason <span aria-hidden="true">→<\/span><\/a><figure class="qr">/);
  assert.doesNotMatch(s.replace(/href="sms:[^"]*"/g, ""), /656|216-?7455|so-num/, "the number is never written on the page");
  assert.match(s, /then come back here to sign in\./);
  assert.ok(!s.includes("you&#39;ve been signed out"));
});

test("6F: signed out (or the session ran out) puts the Caveat line above the sign-in, as a status", () => {
  assert.match(allScreens().signedOut, /<p class="hand tilt" role="status">you&#39;ve been signed out\. everything&#39;s still here\.<\/p><h1/);
});

test("sign-in errors are calm Caveat lines where the eye is: too many tries counts down, a foreign form is said plainly", () => {
  const { signinPause, signinOrigin } = allScreens();
  assert.match(signinPause, /<p class="hand" role="alert">let&#39;s pause a minute\.<\/p><p class="so-wait" data-left="299000">TRY AGAIN IN <span class="left">4:59<\/span><\/p>/);
  assert.match(signinPause, /id="number"[^>]* disabled>/);
  assert.ok(!/Text me a code/.test(signinPause), "no action while paused");
  assert.match(signinOrigin, /role="alert">that didn&#39;t come from this page\. here it is again\./);
  assert.equal(ws.clockLeft(299_000), "4:59");
  assert.equal(ws.clockLeft(60_000), "1:00");
});

test("6B code: six cells over one real one-time-code input, the current digit in pen, the browser's AutoFill note", () => {
  const s = allScreens().code;
  assert.match(s, /<a class="act2" href="\/web">← USE A DIFFERENT NUMBER<\/a>/);
  assert.match(s, /<h1 id="so-title" class="h1">Check your texts\.<\/h1><p class="so-sub">Six digits, sent to ••• ••• 0142\.<\/p>/);
  assert.match(s, /<fieldset class="code-f"><legend class="sr">Six-digit code<\/legend><label class="sr" for="code">/);
  assert.match(s, /<input id="code" type="text" name="code" autocomplete="one-time-code" inputmode="numeric"/);
  assert.equal((s.match(/<span class="cell" aria-hidden="true"><\/span>/g) ?? []).length, 6);
  assert.match(s, /\.digits \.cell\.cur\{border-bottom-color:var\(--pen\);color:var\(--pen\)\}/);
  assert.match(s, /it fills in by itself if your browser offers it\./);
  assert.match(s, /<button class="act2" type="submit">SEND A NEW CODE<\/button>/);
  assert.match(s, /CODE GOOD FOR 15 MIN/);
  assert.equal(ws.maskedNumber("+1 (415) 555-0142"), "••• ••• 0142");
  assert.equal(ws.maskedNumber("12"), "your number");
});

test("code errors: wrong, expired, too many tries with a countdown, resend limit — each an alert under the digits", () => {
  const { codeWrong, codeExpired, codeTries, codeResend } = allScreens();
  assert.match(codeWrong, /<div class="digits bad"><input id="code"[^>]*aria-invalid="true">/);
  assert.match(codeWrong, /<p class="hand" role="alert">that&#39;s not it\. try again\?<\/p>/);
  assert.match(codeExpired, /role="alert">that one expired\.<\/p><form method="POST" action="\/web\/signin">[^]*?<input type="hidden" name="again" value="1"><button class="act act-sm" type="submit">Send a fresh one <span aria-hidden="true">→<\/span>/);
  assert.match(codeTries, /role="alert">let&#39;s pause a minute\.<\/p><p class="so-wait" data-left="299000">TRY AGAIN IN <span class="left">4:59/);
  assert.match(codeTries, /<input id="code"[^>]* disabled/);
  assert.ok(!codeTries.includes("SEND A NEW CODE"));
  assert.match(codeResend, /role="alert">i&#39;ve sent a few\. give it a moment\.<\/p><p class="so-quiet">The last code still works for 10 minutes\.<\/p>/);
  assert.ok(!codeResend.includes("SEND A NEW CODE"));
});

test("6D new to Reason: the live number, a real QR, Text Reason →; 6E with no live line: no number, no QR", () => {
  const { join: j, notConnected } = allScreens();
  assert.match(j, /<a class="act2" href="\/web">← SIGN IN<\/a>/);
  assert.match(j, /<h1 id="so-title" class="h1">Your first text<br><em>is the sign-up\.<\/em><\/h1><a class="act" href="sms:\+16562167455&amp;body=Hey">Text Reason <span aria-hidden="true">→<\/span><\/a><figure class="qr">/);
  assert.doesNotMatch(j.replace(/href="sms:[^"]*"/g, ""), /656|216-?7455|so-num/, "the number is never written on the page");
  assert.match(j, /On a laptop\? Scan/);
  assert.match(notConnected, /We can't finish joining right now\.<\/h1><p class="so-sub">Reason's line isn't taking new people for the moment\. Nothing on your side went wrong\.<\/p><p class="hand tilt">i&#39;ll be back soon\.<\/p><a class="act2" href="\/web">ALREADY A MEMBER\? SIGN IN →<\/a>/);
  assert.ok(!/sms:|<figure class="qr"|\d{3}\) \d{3}-\d{4}/.test(notConnected));
  assert.ok(!/<figure class="qr"/.test(ws.renderSignin({ joinNumber: null, formToken: "t" })), "the desktop column says the same with no line");
});

// ---------- the conversation (Chat · mobile, Desktop, sheets 4–5) ----------

const row = (over) => ({ id: 1, role: "assistant", channel: "fake", text: "", media: [], at: clock.now(), external_id: null, ...over });

test("labels say who, where and when; yours are serif right, Reason's Inter left; no bubbles", () => {
  const you = wc.rowOut(row({ id: 1, role: "user", channel: "web", text: "Yes, check the 14th." }), { conversationId: KOFI_C });
  const re = wc.rowOut(row({ id: 2, text: "Hudson is open both nights." }), { conversationId: KOFI_C, service: "iMessage" });
  assert.match(you.html, /^<p class="lbl"><span>YOU · WEB · <\/span><time datetime="[^"]+">/);
  assert.match(you.html, /<div class="said">Yes, check the 14th\.<\/div>$/);
  assert.match(re.html, /^<p class="lbl"><span>REASON · IMESSAGE · <\/span><time/);
  assert.match(re.html, /<div class="rsay"><p>Hudson is open both nights\.<\/p><\/div>$/);
  const css = allScreens().thread;
  assert.match(css, /\.said\{margin:0;text-align:right;font:italic 400 23px\/1\.25 var\(--serif\)/);
  assert.match(css, /\.rsay p\{margin:0;font-size:16px;line-height:1\.55/);
  assert.ok(!/border-radius:14px/.test(css), "no bubble shapes");
});

test("day labels, and Caveat 'Continued on Web' where the person moved to Web", () => {
  const day = 864e5, now = clock.now();
  const html = wc.listHtml([
    wc.rowOut(row({ id: 1, role: "user", channel: "fake", text: "a", at: now - day }), { conversationId: KOFI_C }),
    wc.rowOut(row({ id: 2, role: "user", channel: "web", text: "b", at: now }), { conversationId: KOFI_C }),
  ], { now });
  assert.match(html, /<li class="day" role="separator"><p class="lbl">YESTERDAY<\/p><\/li>/);
  assert.match(html, /<li class="day" role="separator"><p class="lbl">TODAY<\/p><\/li><li class="cont" role="separator" aria-label="Continued on Web"><span aria-hidden="true"><\/span><span class="hand">Continued on Web<\/span>/);
});

test("Reason's lists become 01 02 03 in pen between dashed rules; a trailing price gets its own column", () => {
  const b = wc.reasonBody("Three that fit:\n1. Farmhouse inn — $540\n2. Lake cabin $480\n- Woodstock hotel\n\nWant me to hold one?", KOFI_C);
  assert.match(b, /^<p>Three that fit:<\/p><ol class="rl"><li><span class="rl-n" aria-hidden="true">01<\/span><span class="rl-t">Farmhouse inn<\/span><span class="rl-p">\$540<\/span><\/li><li><span class="rl-n" aria-hidden="true">02<\/span><span class="rl-t">Lake cabin<\/span><span class="rl-p">\$480<\/span><\/li><li><span class="rl-n" aria-hidden="true">03<\/span><span class="rl-t">Woodstock hotel<\/span><\/li><\/ol><p>Want me to hold one\?<\/p>$/);
  assert.match(allScreens().thread, /\.rl-n\{font:400 13px\/1 var\(--mono\);color:var\(--pen\)\}/);
  assert.match(allScreens().thread, /\.rl li\{[^}]*border-top:1px dashed var\(--hair\)/);
  // Escaped first: a list item is never markup.
  assert.match(wc.reasonBody("1. <b>x</b>", KOFI_C), /<span class="rl-t">&lt;b&gt;x&lt;\/b&gt;<\/span>/);
});

test("Reason's own links become paper cards; a page's title shows only for the conversation that made it", () => {
  db.createPage(KOFI_C, { title: "Three weekends upstate", blocks: [{ type: "text", text: "x" }] });
  const page = db.db.prepare("SELECT id FROM pages WHERE conversation_id = ?").get(KOFI_C).id;
  const mine = wc.reasonBody(`Put them side by side:\nhttps://files.heyreason.test/${page}`, KOFI_C);
  assert.match(mine, /^<p>Put them side by side:<\/p><a class="card lcard" href="https:\/\/files\.heyreason\.test\/[^"]+" rel="noopener noreferrer nofollow" target="_blank"><span class="lc-dom">FILES\.HEYREASON\.TEST<\/span><span class="lc-t">Three weekends upstate<\/span><span class="lc-go">Open <span aria-hidden="true">→<\/span><\/span><\/a>$/);
  const theirs = wc.reasonBody(`look https://files.heyreason.test/${page}`, AMA_C);
  assert.ok(!theirs.includes("Three weekends"), "Ama never reads Kofi's page title");
  assert.match(theirs, /<span class="lc-t">A page Reason made<\/span>/);
  // Somebody else's host is a plain link, never a card.
  assert.ok(!wc.reasonBody("https://example.com/x", KOFI_C).includes("lcard"));
  assert.match(wc.reasonBody("https://files.heyreason.test/i/abcdefghijklmnop", KOFI_C), /An invite to Reason/);
});

test("an event link with a known date is the date-block card (organiser's own); otherwise a plain card", () => {
  const starts = Date.UTC(2026, 10, 14, 23, 0);
  db.db.prepare(`INSERT INTO events (public_id, organizer_conversation_id, name, name_key, starts_at, tz, password_hash, organizer_token, created_at, updated_at)
    VALUES ('evtpublicid00001', ?, 'Weekend away', 'weekend away', ?, 'America/New_York', 'x', 'orgtoken-design', ?, ?)`).run(KOFI_C, starts, clock.now(), clock.now());
  const card = wc.reasonBody("https://events.heyreason.test/e/evtpublicid00001", KOFI_C);
  assert.match(card, /<a class="card lcard ev"[^>]*><span class="ev-date"><span class="ev-mon">NOV<\/span><span class="ev-day">14<\/span><\/span><span class="ev-txt"><span class="lc-dom">EVENTS\.HEYREASON\.TEST<\/span><span class="ev-t">Weekend away<\/span>/);
  const other = wc.reasonBody("https://events.heyreason.test/e/evtpublicid00001", AMA_C);
  assert.match(other, /<span class="lc-t">An event<\/span>/);
  assert.ok(!other.includes("Weekend away"));
});

test("photos, voice notes and files already in history: a tilted frame, a Caveat transcript, a typed slip — never a fetched address", () => {
  const m = wc.rowOut(row({ role: "user", channel: "fake", text: "also see if they take dogs", media: [{ mimeType: "audio/x-caf", filename: "Audio.caf", url: "https://secret.example/a" }] }), { conversationId: KOFI_C });
  assert.match(m.html, /YOU · VOICE · IMESSAGE · /);
  assert.match(m.html, /<p class="said hand">also see if they take dogs<\/p><button type="button" class="vplay" data-src="\/web\/media\/m\/\d+\/0" aria-label="Play voice note">/);
  const p = wc.rowOut(row({ role: "user", channel: "fake", text: "", media: [{ mimeType: "image/jpeg", filename: "IMG.JPG" }, { mimeType: "application/pdf", filename: "lease.pdf" }] }), { conversationId: KOFI_C });
  assert.match(p.html, /<div class="photo" role="img" aria-label="Photo you sent"><span class="lbl">PHOTO<\/span><\/div><span class="slip">LEASE\.PDF<\/span>/, "an item with no address to serve is still drawn");
  const q = wc.rowOut(row({ role: "user", channel: "fake", text: "", media: [{ kind: "image", filename: "IMG.HEIC", url: "https://secret.example/p" }] }), { conversationId: KOFI_C });
  assert.match(q.html, /<a class="photo" href="\/web\/media\/m\/\d+\/0" target="_blank" rel="noopener"><img src="\/web\/media\/m\/\d+\/0" alt="Photo you sent"/, "a texted photo is served from Web's own address");
  assert.ok(!JSON.stringify(q).includes("secret.example"), "a media address never leaves the server");
  assert.ok(!JSON.stringify(p).includes("secret.example"), "a media address never leaves the server");
  assert.match(allScreens().thread, /\.photo\{[^}]*transform:rotate\(2deg\)/);
});

test("the thread page: a log, ↑ SHOW EARLIER, 'on it.' as a status, the one-line composer, the tab bar", () => {
  const account = db.getAccount(KOFI_C);
  const lines = [wc.rowOut(row({ id: 5, text: "hi" }), { conversationId: KOFI_C })];
  const s = wc.renderConversation({ account, csrf: "c", lines, more: true, sendId: "s", items: [] });
  assert.match(s, /<ol class="thread" role="log" aria-live="polite" aria-relevant="additions">/);
  assert.match(s, /<button class="act2" type="button">↑ SHOW EARLIER MESSAGES<\/button>/);
  assert.match(s, /<div class="onit" role="status" aria-label="Reason is working on it" hidden><span class="ring"><svg class="bub"/);
  assert.match(s, /<span class="hand">on it\.<\/span>/);
  assert.ok(!/c-dots|Reason is working on it<\/span>/.test(s), "no three dots");
  assert.match(s, /<label class="sr" for="c-input">Message Reason<\/label><input id="c-input" type="text" name="text" maxlength="4000" placeholder="Tell Reason what you need"/);
  assert.match(s, /<button class="send" type="submit" aria-label="Send">/);
  assert.match(s, /\.cform input:placeholder-shown~\.send\{display:none\}/, "send appears only with text");
  assert.match(s, /<p class="under">Replies come here, not to your phone as well\.<\/p>/);
  // Owner 10-26: + and the mic, built, shown once the script can run them (test/web-compose.test.js).
  assert.match(s, /aria-label="Add a photo or file" hidden>[^]*aria-label="Speak instead" hidden>/);
  assert.match(s, /<form class="cform" method="POST" action="\/web\/send"><input type="hidden" name="c" value="[^"]*"><input type="hidden" name="id" value="[^"]*"><button class="ic c-add" type="button" aria-label="Add a photo or file" hidden>[^]*?<\/button><input class="c-file" type="file"[^>]*hidden[^>]*><label class="sr" for="c-input">Message Reason<\/label><input id="c-input"[^>]*><button class="ic c-mic" type="button" aria-label="Speak instead" hidden>[^]*?<\/button><button class="send" type="submit" aria-label="Send">[^]*?<\/button><\/form>/, "+ · the input · the mic · send (composer 01)");
  assert.match(s, /<nav class="tabs" aria-label="Sections"><a href="\/web\?thread" aria-current="page">Chat<\/a><a href="\/web\?tab=ongoing">Ongoing<\/a><\/nav>/);
  assert.match(s, /<nav aria-label="Account"><a class="act2" href="\/web\/memory">MEMORY<\/a><a class="act2" href="\/web\/settings">SETTINGS<\/a><\/nav>/);
  assert.match(s, /<button class="menu-b" type="button" aria-label="Menu" aria-expanded="false" aria-controls="menu">/);
  assert.match(s, /\.composer\{position:sticky;bottom:0/, "desktop: pinned to the bottom");
  assert.match(s, /body\.typing \.tabs\{display:none\}/, "the tab bar hides while typing");
});

test("delivery states in the page's script: SENDING…, SENT that fades, WAITING TO SEND offline, a retry button that reuses the id", () => {
  const s = allScreens().thread;
  for (const t of ["SENDING\\u2026", "'SENT \\u00b7 '+fmt(m.at)", "WAITING TO SEND", "didn't go. tap to try again.", "IT WON'T SEND TWICE", "you're offline. i'll send it when you're back.", "lost the line for a sec. nothing's lost."]) assert.ok(s.includes(t), t);
  assert.match(s, /b\.className='retry';[^]*?b\.onclick=function\(\)\{if\(li\.retry\)return li\.retry\(\);send\(stored\(li\),li\)\}/, "a retry is the same id: the server's claim makes it one turn");
  assert.match(s, /<p class="netline" role="status" hidden><\/p>/);
  assert.match(s, /Still working on it\.<br><em>Sign back in to see\.<\/em>/, "9D when the session ends mid-task");
});

test("approval card: NEEDS YOUR APPROVAL, NOTHING BOOKED/CHARGED YET, no approve button, and the nudge is intent", () => {
  const c = kit.approvalCard({ title: "Hold the Hudson inn, $540" });
  assert.match(c, /^<div class="card appr"><p class="lbl pen">NEEDS YOUR APPROVAL<\/p><p class="appr-t">Hold the Hudson inn, \$540<\/p><p class="lbl">NOTHING BOOKED YET<\/p><\/div><p class="hand">just tell me in the chat when you want it\.<\/p>$/);
  assert.match(kit.approvalCard({ title: "Buy it", money: true }), /NOTHING CHARGED YET/);
  assert.match(kit.approvalCard({ title: "x", href: "/web/x" }), /<a class="appr-go" href="\/web\/x">Review details <span aria-hidden="true">→<\/span><\/a>/);
  assert.ok(!/<button/.test(c) && !/approve/i.test(c.replace("APPROVAL", "")));
  // A pending confirmation for THIS conversation shows; another's never does.
  db.askConfirmation({ conversationId: KOFI_C, action: "book", summary: "Hold the Hudson inn, $540", stakes: "money", askedAfterMsgs: 0 });
  assert.equal(wc.waitingApprovals(KOFI_C)[0].title, "Hold the Hudson inn, $540");
  assert.deepEqual(wc.waitingApprovals(AMA_C), []);
});

test("arrival: the greeting, then examples that fill the composer (B2) or quiet in-hand rows (B), then 'pick up from iMessage'", () => {
  const { home, homeInHand } = allScreens();
  assert.match(home, /<h1 class="greet">What&#39;s good, Kofi\?<\/h1>/);
  assert.match(home, /\.greet\{[^}]*-webkit-line-clamp:2/, "greetings clamp to two lines");
  assert.match(home, /<section class="start-w" aria-label="You could start with" hidden><p class="lbl">YOU COULD START WITH<\/p>/);
  for (const t of wc.EXAMPLES) assert.ok(home.includes(`<button class="ex" type="button" data-text="${t}">"${t}"</button>`), t);
  assert.ok(!homeInHand.includes("YOU COULD START WITH"));
  // STAGING-REVIEW 7: quiet rows between dashed rules, as on Ongoing; no boxed slips.
  assert.match(homeInHand, /<section class="inhand" aria-label="Already in hand"><p class="lbl">ALREADY IN HAND<\/p><div class="ogv-l home-l"><a class="ogv" href="\/web\/ongoing\/task\/1" data-state="working" data-flight="WORKING"><span class="ogv-t">A cabin for Nov 14–16<\/span><span class="ogv-r"><span class="lbl">WORKING<\/span><\/span><\/a><\/div><\/section>/);
  assert.match(homeInHand, /\.home-l\{border-top:1px dashed var\(--hair\);border-bottom:1px dashed var\(--hair\)\}/);
  assert.ok(!/slipc|class="slips"/.test(homeInHand));
  // ALREADY IN HAND is only ever real: open tasks and pending timers of this conversation.
  db.createTask(KOFI_C, { title: "Refund for the boots", goal: "g", maxAttempts: 3 });
  assert.deepEqual(wc.inHand(KOFI_C).map(x => [x.title, x.status]), [["Refund for the boots", "WORKING"]]);
  assert.deepEqual(wc.inHand(AMA_C), []);
});

test("'pick up from iMessage': the last two texts, quoted, one link into the thread; never Web lines", async () => {
  const conv = KOFI_C;
  db.writeMessage({ conversationId: conv, role: "user", channel: "fake", text: "Under 3 hours. Keep it under $600.", at: clock.now() - 5000 });
  db.writeMessage({ conversationId: conv, role: "assistant", channel: "fake", text: "Got it. I'll pull a short list.", at: clock.now() - 4000 });
  db.writeMessage({ conversationId: conv, role: "user", channel: "web", text: "a web line", at: clock.now() - 3 * 60 * 60_000 });
  const tok = "tok-design-pick";
  db.startPageSession(`wsign:${conv}`, tok, { conversationId: conv });
  db.markWebNoticeSeen(conv);
  const html = wc.conversationPage({ account: db.getAccount(conv), headers: { cookie: `reason_page=${tok}` }, sendId: "s" });
  assert.match(html, /<a class="pick" href="\/web\?thread" aria-label="Pick up from iMessage: continue the thread"><span class="pick-h"><span class="hand">pick up from iMessage<\/span>/);
  assert.match(html, /<span class="pick-q"><span class="y">Under 3 hours\. Keep it under \$600\.<\/span><span class="r">Got it\. I&#39;ll pull a short list\.<\/span><\/span>/);
  assert.match(html, /Same Reason, same thread\. What you send here stays on Web\./);
  assert.ok(!html.includes("a web line"));
});

test("5C first visit (once), the Ongoing tab's empty state, MEMORY/SETTINGS pages, and 9B — each in its own words", () => {
  const { first, ongoing, error, memory, settings } = allScreens();
  assert.match(first, /<h1 id="fv-h" class="h1">One Reason\.<br><em>Pick up anywhere\.<\/em><\/h1><p class="body">This is the same Reason you text\. What you send here stays here; it won&#39;t show up in your iMessage thread\.<\/p><p class="hand tilt">either place works\. i&#39;ll keep up\.<\/p><a class="act" href="\/web">Got it <span aria-hidden="true">→<\/span><\/a>/);
  assert.match(ongoing, /<h1 class="h1">Nothing left<br>to chase\.<\/h1><p class="hand tilt">whatever you hand me shows up here while i work\.<\/p>/);
  assert.match(ongoing, /<a href="\/web\?tab=ongoing" aria-current="page">Ongoing<\/a>/);
  assert.match(error, /Something went wrong\.<br><em>Nothing was lost\.<\/em><\/h1><p class="quiet">Your messages and anything I'm working on are safe\.<\/p><a class="act" href="\/web">Try again/);
  assert.match(memory, /What Reason <em>remembers<\/em>/);
  assert.match(settings, /<button class="act2" type="submit">SIGN OUT OF THIS BROWSER<\/button>/);
  assert.match(settings, /<p class="lbl">THEME<\/p><fieldset class="themes"/);
});

test("320px: labels and titles cut with …, messages always wrap in full, never under 20px at the sides", () => {
  const s = allScreens().thread;
  assert.match(kit.KIT_CSS, /\.lbl\{[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/);
  assert.match(s, /\.said\{[^}]*overflow-wrap:anywhere/);
  assert.match(s, /\.rsay p\{[^}]*overflow-wrap:anywhere/);
  assert.match(s, /\.og-row b\{[^}]*text-overflow:ellipsis/);
  assert.match(kit.KIT_CSS, /@media \(max-width:359px\)\{:root\{--gut:20px\}/);
  assert.match(allScreens().signin, /@media \(max-width:359px\)\{\.so-head,\.so\{padding-left:20px;padding-right:20px\}\}/);
});

test("a11y on every screen: no click handlers on divs, every input labelled, every icon button named, lang set", () => {
  for (const [name, html] of Object.entries(allScreens())) {
    assert.match(html, /<html lang="en"/, name);
    assert.ok(!/<(div|span|p|li)[^>]*\sonclick=/.test(html), `${name}: no clickable non-controls`);
    for (const m of html.matchAll(/<input id="([^"]+)"/g)) assert.ok(html.includes(`for="${m[1]}"`), `${name}: #${m[1]} has a label`);
    for (const m of html.matchAll(/<button([^>]*)>(\s*<svg[^]*?<\/svg>\s*)<\/button>/g)) assert.match(m[1], /aria-label="[^"]+"/, `${name}: icon button named`);
    assert.match(html, /\.act\{[^}]*min-height:52px/, `${name}: text actions are tall enough`);
  }
});

test("no screen coaches a phrase to type: intent only (the three tap-to-fill examples are the only quotes)", () => {
  const quoted = /(?:say|reply|text|type|send)\s+(?:&quot;|"|“|&#39;|')[^"”']{1,40}(?:&quot;|"|”|&#39;|')/i;
  for (const [name, html] of Object.entries(allScreens())) {
    const words = html.replace(/<script>[^]*?<\/script>|<style>[^]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
    assert.ok(!quoted.test(words), `${name}: ${quoted.exec(words)?.[0]}`);
    for (const m of words.matchAll(/"([^"]{6,})"/g)) assert.ok(wc.EXAMPLES.includes(m[1]), `${name}: unexpected quote ${m[1]}`);
  }
  assert.ok(!quoted.test(kit.APPROVAL_NUDGE));
});

// ---------- instant replies ----------

test("the stream origin: the pages host under the website's domain by default; off, a stranger or the site itself never", () => {
  assert.equal(web.webStreamOrigin(), "https://files.heyreason.test");
  config.webStream = "off";
  assert.equal(web.webStreamOrigin(), null);
  config.webStream = "https://evil.test";
  assert.equal(web.webStreamOrigin(), null, "not under the website's domain: the cookie must never go there");
  config.webStream = "https://heyreason.test";
  assert.equal(web.webStreamOrigin(), null, "the site itself is the buffered path");
  config.webStream = "http://files.heyreason.test";
  assert.equal(web.webStreamOrigin(), null, "https only");
  config.webStream = "https://live.heyreason.test";
  assert.equal(web.webStreamOrigin(), "https://live.heyreason.test");
  config.webStream = "";
  assert.match(ws.SECURITY_HEADERS["Content-Security-Policy"], /connect-src 'self' https:\/\/files\.heyreason\.test;/);
  assert.equal(wc.streamPath(), "https://files.heyreason.test/web/live");
  assert.match(allScreens().thread, /stream:"https:\/\/files\.heyreason\.test\/web\/live"/);
  config.webStream = "off";
  assert.equal(wc.streamPath(), "/web/stream");
});

function harness() {
  const router = new Router({ log: () => {} });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  const runtime = new Runtime({ log: () => {}, channels: router, deliver, runTurn: async ({ text }) => `re: ${text}` });
  router.runtime = runtime;
  router.register(consoleChannel);
  router.register(new FakeChannel({ number: LINE }));
  router.register(new WebChannel());
  return { router, runtime };
}

test("/web/live on the pages host: not sent round to the website; CORS with credentials for the website only; signed-in only", async () => {
  const h = harness();
  const server = createServer({ router: h.router, runtime: h.runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const tok = "tok-design-live";
  db.startPageSession(`wsign:${KOFI_C}`, tok, { conversationId: KOFI_C });
  db.writeMessage({ conversationId: KOFI_C, role: "assistant", channel: "web", text: "hello from the stream" });
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { host: "files.heyreason.test", ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; if (body.includes("hello from the stream")) res.destroy(); });
      res.on("close", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on("error", reject); r.end();
  });
  try {
    const ok = await get("/web/live?after=0", { cookie: `reason_page=${tok}`, origin: "https://heyreason.test", "sec-fetch-site": "same-site" });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(ok.headers["access-control-allow-origin"], "https://heyreason.test");
    assert.equal(ok.headers["access-control-allow-credentials"], "true");
    assert.match(ok.body, /event: message\ndata: .*hello from the stream/);
    const evil = await get("/web/live", { cookie: `reason_page=${tok}`, origin: "https://evil.test" });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
    assert.ok(!evil.body.includes("hello"));
    const sub = await get("/web/live", { cookie: `reason_page=${tok}`, origin: "https://files.heyreason.test" });
    assert.equal(sub.status, 403, "only the website's own origin, not a sibling host");
    const out = await get("/web/live", { origin: "https://heyreason.test" });
    assert.equal(out.status, 401);
    assert.ok(!out.body.includes("hello"));
    // The reconnect preflight (Last-Event-ID): the website's origin only, and it carries nothing.
    const pre = (origin) => new Promise((resolve, reject) => { const r = request({ host: "127.0.0.1", port, path: "/web/live", method: "OPTIONS", headers: { host: "files.heyreason.test", origin, "access-control-request-headers": "last-event-id" } }, (res) => { res.resume(); res.on("end", () => resolve(res)); }); r.on("error", reject); r.end(); });
    const good = await pre("https://heyreason.test");
    assert.equal(good.statusCode, 204);
    assert.equal(good.headers["access-control-allow-headers"], "last-event-id");
    assert.equal(good.headers["access-control-allow-origin"], "https://heyreason.test");
    const bad = await pre("https://evil.test");
    assert.equal(bad.statusCode, 403);
    assert.equal(bad.headers["access-control-allow-origin"], undefined);
    // Everything else under /web on the pages host is still sent round to the website.
    assert.equal((await get("/web/stream", { cookie: `reason_page=${tok}` })).status, 301);
  } finally {
    server.close();
  }
});

test("review fixes: unsent messages are keyed to ONE conversation and cleared on sign-out; a countdown never re-POSTs; a pasted code draws and sends", () => {
  const k = (conv) => /k:"([^"]+)"/.exec(wc.renderConversation({ account: db.getAccount(conv), csrf: "c", lines: [], more: false, sendId: "s" }))?.[1];
  assert.ok(k(KOFI_C) && k(AMA_C) && k(KOFI_C) !== k(AMA_C), "two people, two keys");
  assert.equal(/k:"([^"]+)"/.exec(wc.renderHome({ account: db.getAccount(KOFI_C), csrf: "c", sendId: "s" }))?.[1], k(KOFI_C), "home → thread hand-off uses the same key");
  const t = allScreens().thread;
  assert.match(t, /var KEY='reason-web-pending:'\+R\.k/);
  assert.match(t, /form\[action="\/web\/signout"\][^]*?sessionStorage\.removeItem/);
  const code = allScreens().codeTries;
  assert.ok(!/location\.reload\(\)/.test(code), "a 429 answered a POST: reloading it would re-POST");
  assert.match(code, /c\.disabled=false;w\.remove\(\)/);
  assert.match(allScreens().signinPause, /else location\.href='\/web'/);
  assert.match(allScreens().code, /i\.addEventListener\('paste',function\(\)\{setTimeout\(function\(\)\{i\.dispatchEvent\(new Event\('input'\)\)/);
});

test("review fixes: a guest who left never reads the event's name off a card", () => {
  db.db.prepare(`INSERT INTO events (public_id, organizer_conversation_id, name, name_key, starts_at, tz, password_hash, organizer_token, created_at, updated_at)
    VALUES ('evtpublicid00002', ?, 'Secret dinner', 'secret dinner', NULL, 'America/New_York', 'x', 'orgtoken-design-2', ?, ?)`).run(AMA_C, clock.now(), clock.now());
  const ev = db.eventByPublicId("evtpublicid00002");
  db.db.prepare("INSERT INTO event_attendees (event_id, conversation_id, via, token, state, joined_at, updated_at) VALUES (?, ?, 'link', 'att-token-design', 'left', ?, ?)").run(ev.id, KOFI_C, clock.now(), clock.now());
  assert.ok(!wc.reasonBody("https://events.heyreason.test/e/evtpublicid00002", KOFI_C).includes("Secret dinner"));
  db.db.prepare("UPDATE event_attendees SET state = 'joined' WHERE conversation_id = ?").run(KOFI_C);
  assert.ok(wc.reasonBody("https://events.heyreason.test/e/evtpublicid00002", KOFI_C).includes("Secret dinner"));
});

test("Web's pen matches the brand pen on every other page", async () => {
  const brand = await import("../src/pages/brand.js");
  assert.equal(brand.BRAND_PEN, "#9c3b2e");
  assert.equal(brand.BRAND_PEN_DARK, "#d46a5c");
});
