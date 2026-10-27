// Reason Web v2, the edge builder's scope (SCOPE-v2 SR8, SR9, desk-sign-in / sheet-signed-out, L3–L7,
// E1, E5, F1), pinned on the server side. The same states in a real browser: test/web-edge-browser.test.js.
//
//   SR8  every "Text Reason →" on Web is sms:<line>&body=hey with OPENS MESSAGES WITH “HEY” READY TO SEND
//        under it; the number is never written; desktop puts the QR card first, then "or Text Reason →"
//   SR9  a wrong or expired code stays in the cells and every underline turns pen
//   L3–L5  the loading kit: ruled lines in the border colour, role=status, a 1.6 s fade unless reduced
//        motion, no spinner, no shimmer, eight seconds before "still looking"; on every Web page
//   L6/L7  the sign-in's own words change once a form is on its way
//   E1   an unknown /web address: 404, "Back to the thread →" only signed in, OR GO TO HEYREASON.COM
//   E5   the maintenance switch: ops_state (never .env), from /ops and the CLI, BACK BY ABOUT {time} ET,
//        503 for every /web page (JSON for the page's own script), lapses at its time; fonts still load
//   F1   one ring, :focus-visible only; destructive in pen; skip link; the input line; icon rings; cards 4px
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-edge-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_WEB = "on";
process.env.REASON_WEB_STREAM = "off";
process.env.REASON_SITE_URL = "https://heyreason.com";
delete process.env.REASON_PAGES_URL;
delete process.env.REASON_PUBLIC_URL;
delete process.env.REASON_OPS_PASSWORD_HASH;

const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const ws = await import("../src/pages/websignin.js");
const kit = await import("../src/pages/webkit.js");
const load = await import("../src/pages/webloading.js");
const edge = await import("../src/pages/webedge.js");
const wc = await import("../src/pages/webconvo.js");
const og = await import("../src/pages/webongoing.js");
const { createServer, opsRequest } = await import("../src/http.js");
const { renderOps } = await import("../src/pages/ops.js");
const cli = await import("../scripts/web-maintenance.mjs");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");

const LINE = "+16562167455";
const HINT = "OPENS MESSAGES WITH “HEY” READY TO SEND";
const C = "dm:owner";
const words = (h) => h.replace(/&#39;/g, "'");
let server, base;

before(async () => {
  config.web = true;
  const router = new Router({ log: () => {} });
  router.register(new FakeChannel({ number: LINE }));
  server = createServer({ router, runtime: { say: () => {}, interval: {}, on() {} } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clock.reset();
  config.web = true;
  db.db.exec("DELETE FROM ops_state; DELETE FROM page_sessions; DELETE FROM accounts; DELETE FROM threads;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: C, channel: "fake", address: "+12025551234", isOwner: true, service: "iMessage" });
});
const signedIn = (tok = `tok-${Math.random().toString(36).slice(2)}`) => { db.startPageSession(`wsign:${C}`, tok, { conversationId: C }); return `reason_page=${tok}`; };

// ---------------------------------------------------------------- SR8

test("SR8: every Text Reason → is sms:<line>&body=hey with the typed hint under it; the number is never written", () => {
  assert.equal(ws.smsHref(LINE), `sms:${LINE}&body=hey`);
  assert.equal(kit.TEXT_HINT, HINT);
  assert.equal(kit.textReason("sms:x"), `<div class="tr"><a class="act" href="sms:x">Text Reason <span aria-hidden="true">→</span></a><span class="tr-h">${HINT}</span></div>`);
  const pages = {
    signin: ws.renderSignin({ joinNumber: LINE, formToken: "t" }),
    join: ws.renderJoin({ joinNumber: LINE }),
    maint: edge.renderMaintenance({ until: Date.now() + 30 * 60_000, joinNumber: LINE }),
  };
  for (const [name, h] of Object.entries(pages)) {
    const links = [...h.matchAll(/<a class="act" href="(sms:[^"]*)">((?:or )?Text Reason) <span aria-hidden="true">→<\/span><\/a>(<span class="tr-h">[^<]*<\/span>)?/g)];
    assert.ok(links.length >= 1, `${name}: a Text Reason →`);
    for (const m of links) {
      assert.equal(m[1], `sms:${LINE}&amp;body=hey`, `${name}: lowercase hey`);
      assert.equal(m[3], `<span class="tr-h">${HINT}</span>`, `${name}: the hint under it`);
    }
    assert.doesNotMatch(h.replace(/href="sms:[^"]*"/g, "").replace(/<svg[^]*?<\/svg>/g, ""), /656|216-?7455/, `${name}: no number on the page`);
  }
  // Desktop sign-in: NEW TO REASON, the headline, the QR card, then "or Text Reason →" and its hint, then the Caveat.
  assert.match(pages.signin, /<\/h2><figure class="qr">[^]*?<\/figure><div class="tr tr-or"><a class="act" href="sms:[^"]+">or Text Reason <span aria-hidden="true">→<\/span><\/a><span class="tr-h">[^<]+<\/span><\/div><p class="hand">then come back here to sign in\.<\/p><\/section>/);
  assert.match(pages.signin, /\.tr-or \.act\{font-size:28px\}/);
  // 6D: the headline, Text Reason → + hint, the QR card (ON A LAPTOP? SCAN), the Caveat; 30px between.
  assert.match(pages.join, /is the sign-up\.<\/em><\/h1><div class="tr">[^]*?<\/div><figure class="qr">[^]*?On a laptop\? Scan[^]*?<\/figure><p class="hand">then come back here to sign in\.<\/p>/);
  assert.match(pages.join, /class="so-in so-solo so-6d"/);
  assert.match(pages.join, /\.so-6d\{gap:30px\}/);
  // The hint: typed, 11px, tracked, muted; 6px under its link.
  assert.match(kit.KIT_CSS, /\.tr\{display:flex;flex-direction:column;gap:6px;align-items:flex-start\}/);
  assert.match(kit.KIT_CSS, /\.tr-h\{font:400 11px\/1\.4 var\(--mono\);letter-spacing:\.14em;color:var\(--muted\)\}/);
  // The QR carries the same lowercase hello.
  assert.ok(pages.signin.includes('aria-label="QR code to text Reason"'));
});

// ---------------------------------------------------------------- SR9 + L6/L7

test("SR9: a wrong or expired code stays in the six cells and every underline turns pen; too many tries keeps none", () => {
  const wrong = ws.renderCode({ number: "(415) 555-0142", formToken: "t", error: { kind: "wrong", code: "481092" } });
  assert.match(wrong, /<div class="digits bad"><input id="code"[^>]* value="481092" aria-invalid="true" aria-describedby="code-note">/);
  assert.match(words(wrong), /<p class="hand" id="code-note" role="alert">that's not it\. try again\?<\/p>/);
  const expired = ws.renderCode({ number: "(415) 555-0142", formToken: "t", error: { kind: "expired", code: "123456" } });
  assert.match(expired, /<div class="digits bad"><input id="code"[^>]* value="123456"/);
  const tries = ws.renderCode({ number: "(415) 555-0142", formToken: "t", error: { kind: "tries", waitMs: 60_000, code: "999999" } });
  assert.doesNotMatch(tries, /value="999999"/);
  // Never anything but digits back on the page.
  assert.doesNotMatch(ws.renderCode({ number: "1", formToken: "t", error: { kind: "wrong", code: "<b>" } }), /value="</);
  // Pen underlines (cells and the input's own rule without script); no ring on the digits (the input line rule).
  assert.match(wrong, /\.digits\.bad \.cell,\.digits\.bad \.cell\.on\{border-bottom-color:var\(--pen\)\}/);
  assert.match(wrong, /\.digits\.bad input\{border-bottom-color:var\(--pen\)\}/);
  assert.doesNotMatch(wrong, /\.digits input:focus-visible\{outline:2px/);
  // Typing again replaces it: selected on focus, the pen goes on the first keystroke.
  assert.match(wrong, /if\(d\.classList\.contains\('bad'\)\)try\{i\.select\(\)\}/);
  assert.match(wrong, /d\.classList\.remove\('bad'\);i\.removeAttribute\('aria-invalid'\)/);
});

test("L6/L7: on its way, the action's words change and nothing can be sent twice; the digits stay with CHECKING…", () => {
  const s = ws.renderSignin({ joinNumber: LINE, formToken: "t" });
  assert.match(s, /s\.className='act busy';s\.setAttribute\('role','status'\);s\.textContent='Texting you a code…';b\.replaceWith\(s\)/);
  assert.match(s, /n\.readOnly=true/);
  assert.match(s, /if\(f\.dataset\.busy\)\{e\.preventDefault\(\);return\}/);
  assert.match(s, /\.act\.busy\{color:var\(--muted\);cursor:default;pointer-events:none\}/);
  assert.match(s, /\.ul-in\[readonly\]\{color:var\(--muted\)\}/);
  assert.match(s, /p\.className='lbl checking';p\.setAttribute\('role','status'\);p\.textContent='CHECKING…'/);
  // After the submit event, so the form's own data has gone: readOnly, never disabled (a disabled field isn't sent).
  assert.match(s, /setTimeout\(function\(\)\{var n=f\.querySelector\('#number'\)/);
  assert.doesNotMatch(s, /n\.disabled=true|c\.disabled=true/);
});

// ---------------------------------------------------------------- L3–L5

test("L3–L5: the loading kit is on every Web page; ruled lines in border colour; status; 1.6 s fade; no spinner or shimmer", () => {
  for (const h of [ws.renderSignin({ joinNumber: LINE, formToken: "t" }), wc.renderOngoing({ csrf: "c" }), edge.renderWebNotFound({})]) {
    assert.ok(h.includes(load.LOAD_CSS), "the CSS");
    assert.match(h, /window\.reasonLoad=\{go:go,kindOf:kindOf\}/, "the client");
  }
  assert.equal(load.SLOW_MS, 8000);
  assert.deepEqual(load.LOAD_COPY, {
    ongoing: "GATHERING WHAT’S IN HAND…", detail: "PUTTING THE SUMMARY TOGETHER…", list: "LOOKING…",
    slow: "STILL LOOKING…", slowNote: "taking a little longer than usual. still here.",
  });
  assert.match(load.LOAD_CSS, /\.ln\{display:block;height:2px;background:var\(--hair\)\}/);
  assert.match(load.LOAD_CSS, /animation:ld-fade 1\.6s ease-in-out infinite alternate/);
  assert.match(load.LOAD_CSS, /@keyframes ld-fade\{from\{opacity:1\}to\{opacity:\.5\}\}/);
  assert.match(load.LOAD_CSS, /@media \(prefers-reduced-motion:reduce\)\{\.ld-lines,\.ld-row,\.ld-rule\{animation:none\}\}/);
  const js = load.loadJs("<span>wm</span>");
  assert.doesNotMatch(load.LOAD_CSS + js, /spin|shimmer|skeleton|gradient/i);
  // The status is a status; ruled lines are hidden from screen readers.
  assert.match(js, /p\.setAttribute\('role','status'\)/);
  assert.match(js, /setAttribute\('aria-hidden','true'\)/);
  // Which links: the Ongoing tab, a row's detail, Saved, or an opt-in.
  assert.match(js, /u\.searchParams\.get\('tab'\)==='ongoing'\)return'ongoing'/);
  assert.match(js, /\(approval\|task\|timer\|series\)/);
  assert.match(js, /getAttribute\('data-load'\)/);
  // A real fetch, never a timer standing in for one; a redirect (signed out) is the browser's to follow.
  assert.match(js, /fetch\(url,\{credentials:'same-origin',redirect:'manual'/);
  assert.match(js, /r\.type==='opaqueredirect'/);
  assert.doesNotMatch(js, /location\.reload\(\)/, "never re-POSTs");
  // The wordmark goes in as the server drew it, never as a closing script tag.
  assert.doesNotMatch(load.loadJs("</script><b>"), /<\/script>/);
});

// ---------------------------------------------------------------- F1

test("F1: one 2px ink ring 3px out on :focus-visible; destructive in pen; inputs ring-less with a pen caret; icons round; cards 4px", () => {
  const css = kit.KIT_CSS;
  assert.match(css, /:focus-visible\{outline:2px solid var\(--ink\);outline-offset:3px\}/);
  assert.doesNotMatch(css.replace(/:focus-visible/g, ""), /:focus\{outline:2px/, "never on mouse focus");
  assert.match(css, /a:focus-visible,button:focus-visible,summary:focus-visible,\[tabindex\]:focus-visible\{border-radius:3px\}/);
  assert.match(css, /input:not\(\[type=radio\]\):not\(\[type=checkbox\]\):focus-visible,textarea:focus-visible,select:focus-visible\{outline:none\}/);
  assert.match(css, /input,textarea\{caret-color:var\(--pen\)\}/);
  assert.match(css, /\.danger:focus-visible,\.fg-go:focus-visible,\.every:focus-visible,\.ff:focus-visible\{outline-color:var\(--pen\)\}/);
  assert.match(css, /\.ic:focus-visible,\.menu-b:focus-visible\{border-radius:50%\}/);
  assert.match(css, /\.send:focus-visible\{border-radius:3px\}/);
  assert.match(css, /\.card:focus-visible,a\.card:focus-visible[^{]*\{outline-offset:4px;border-radius:4px\}/);
  assert.match(css, /\.th-o input:focus-visible\+span\{outline:2px solid var\(--ink\);outline-offset:3px;border-radius:3px\}/);
  assert.match(css, /\.skip\{position:fixed;[^}]*background:var\(--lifted\);border-radius:3px;padding:10px 14px;font:400 12px\/1\.3 var\(--mono\);letter-spacing:\.14em/);
  assert.match(css, /\.skip:not\(:focus\)\{position:absolute;width:1px;height:1px/);
  // The composer's own rule thickens 1 → 2px while it has focus (webconvo), so the input line needs no ring.
  assert.match(wc.renderOngoing({ csrf: "c" }), /\.cform:focus-within\{border-top-width:2px/);
});

test("F1: the skip link is the first thing in every page; the thread's lands at the composer, others at the content", () => {
  const thread = wc.renderConversation({ account: { conversation_id: C, name: "Omari" }, csrf: "c", lines: [], more: false, sendId: "s" });
  assert.match(thread, /<body class="has-tabs"><a class="skip" href="#thread">SKIP TO THE THREAD ↓<\/a>/);
  assert.match(thread, /<div class="composer"><span class="skip-to" id="thread" tabindex="-1"><\/span>/);
  assert.equal((thread.match(/id="thread"/g) ?? []).length, 1);
  // Tab order follows reading order: top bar → thread → composer → margin → tabs.
  const order = ["<header class=\"top\"", "<ol class=\"thread\"", "<div class=\"composer\"", "<aside class=\"og\"", "<nav class=\"tabs\""].map(t => thread.indexOf(t));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), `reading order ${order}`);
  const signin = ws.renderSignin({ joinNumber: LINE, formToken: "t" });
  assert.match(signin, /<body><a class="skip" href="#content">SKIP TO CONTENT ↓<\/a>/);
  assert.match(signin, /<main class="so"><span class="skip-to" id="content" tabindex="-1"><\/span>/);
  assert.deepEqual(kit.skipTo('<main id="m">x</main>'), { html: '<main id="m">x</main>', link: '<a class="skip" href="#m">SKIP TO CONTENT ↓</a>' });
  assert.deepEqual(kit.skipTo("<div>no main</div>"), { html: "<div>no main</div>", link: "" });
  assert.match(kit.KIT_CSS, /\.skip-to\{position:absolute;width:1px;height:1px;overflow:hidden\}/);
});

// ---------------------------------------------------------------- E1

test("E1: an unknown /web address is 404 'This page isn't here. Nothing's lost.'; Back to the thread → only signed in", async () => {
  const out = edge.renderWebNotFound({ signedIn: true });
  assert.match(out, /<div class="torn" aria-hidden="true"><span style="width:80%"><\/span><span style="width:55%"><\/span><\/div><p class="lbl">404<\/p><h1 id="eg-h" class="h1">This page isn’t here\.<br><em>Nothing’s lost\.<\/em><\/h1><p class="eg-q">The link may have a typo, or the page moved\.<\/p><a class="act" href="\/web\?thread">Back to the thread <span aria-hidden="true">→<\/span><\/a><a class="act2" href="https:\/\/heyreason\.com">OR GO TO HEYREASON\.COM<\/a>/);
  assert.match(out, /clip-path:polygon\(0 0,100% 0,100% 78%,86% 92%,70% 80%,52% 96%,34% 82%,18% 95%,0 84%\)/);
  assert.doesNotMatch(edge.renderWebNotFound({ signedIn: false }), /Back to the thread/);
  for (const [cookie, back] of [[signedIn(), true], ["", false]]) {
    const r = await fetch(`${base}/web/nope/deeper`, { headers: cookie ? { cookie } : {} });
    assert.equal(r.status, 404);
    const body = await r.text();
    assert.match(body, /This page isn’t here\./);
    assert.equal(/Back to the thread/.test(body), back);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
  }
  // A row that's gone is the same calm page, with the way back.
  const gone = og.ongoingRequest({ kind: "task", id: "999999", headers: { cookie: signedIn() } });
  assert.equal(gone.status, 404);
  assert.match(gone.body, /This page isn’t here\.[^]*Back to the thread/);
  // The known screens still answer as they did.
  assert.equal((await fetch(`${base}/web`, { redirect: "manual" })).status, 200);
  // Off: no /web at all, the flat 404 as before.
  config.web = false;
  try { assert.doesNotMatch(await (await fetch(`${base}/web/nope`)).text(), /This page isn’t here/); } finally { config.web = true; }
});

// ---------------------------------------------------------------- E5

test("E5: the switch is a row in ops_state with a return time; it lapses at that time; HH:MM is Eastern", () => {
  const now = Date.UTC(2026, 9, 26, 18, 0); // 2:00 PM ET
  assert.deepEqual(edge.maintenance(now), { on: false, until: null });
  const until = edge.parseUntil("15:30", now);
  assert.equal(new Date(until).toISOString(), "2026-10-26T19:30:00.000Z");
  assert.equal(edge.etTime(until), "3:30 PM");
  assert.equal(edge.parseUntil("45", now), now + 45 * 60_000);
  assert.equal(edge.parseUntil("10:00", now), Date.UTC(2026, 9, 27, 14, 0), "a time already gone today is tomorrow's");
  assert.equal(edge.parseUntil("25:00", now), null);
  assert.equal(edge.parseUntil("soon", now), null);
  assert.deepEqual(edge.startMaintenance({ until: now - 1, now }), { ok: false, reason: "past" });
  assert.deepEqual(edge.startMaintenance({ until: now + 25 * 3600_000, now }), { ok: false, reason: "too_far" });
  assert.deepEqual(edge.startMaintenance({ until, by: "ops", now }), { ok: true, until });
  assert.equal(JSON.parse(db.opsGet(edge.MAINT_KEY)).until, until);
  assert.equal(edge.maintenance(now).on, true);
  assert.equal(edge.maintenance(until).on, false, "lapses at its time");
  edge.endMaintenance();
  assert.equal(db.opsGet(edge.MAINT_KEY), null);
});

test("E5: the page: the mark in a dashed ring, BACK BY ABOUT {time} ET, Tidying up for a few minutes., texting still works", () => {
  const until = Date.UTC(2026, 9, 26, 19, 30);
  const h = words(edge.renderMaintenance({ until, joinNumber: LINE }));
  assert.match(h, /<main class="eg eg-m" aria-labelledby="eg-h"><span class="skip-to" id="content" tabindex="-1"><\/span><div class="eg-ring" aria-hidden="true"><svg class="bub"[^]*?<\/svg><\/div><p class="lbl">BACK BY ABOUT 3:30 PM ET<\/p><h1 id="eg-h" class="h1">Tidying up <em>for a few minutes\.<\/em><\/h1><p class="eg-q">The web is paused while we work on it\. Texting Reason still works, and nothing you’ve handed over stops\.<\/p><p class="hand">text me in the meantime\. i’m still here\.<\/p><div class="tr">/);
  assert.match(h, /\.eg-ring\{align-self:flex-start;width:120px;height:120px;border-radius:50%;border:1px dashed var\(--hair\)/);
  // With no live line there is nothing to text: no link, no promise that texting works.
  const none = edge.renderMaintenance({ until, joinNumber: null });
  assert.doesNotMatch(none, /sms:|Texting Reason still works|text me in the meantime/);
});

test("E5: every /web address answers 503 while it's on (JSON for the page's script), fonts still load; texting is untouched", async () => {
  edge.startMaintenance({ until: Date.now() + 30 * 60_000, by: "test" });
  try {
    const page = await fetch(`${base}/web?thread`, { headers: { cookie: signedIn() } });
    assert.equal(page.status, 503);
    assert.ok(Number(page.headers.get("retry-after")) >= 60);
    const body = await page.text();
    assert.match(body, /BACK BY ABOUT \d{1,2}:\d{2} [AP]M ET/);
    assert.ok(body.includes(`href="sms:${LINE}&amp;body=hey"`));
    const j = await fetch(`${base}/web/history?after=0`, { headers: { accept: "application/json" } });
    assert.equal(j.status, 503);
    assert.equal((await j.json()).error, "maintenance");
    assert.equal((await fetch(`${base}/web/fonts/serif.woff2`)).status, 200);
    assert.equal((await fetch(`${base}/web/nope`)).status, 503, "even an unknown address");
    assert.equal((await fetch(`${base}/health`)).status, 200, "the rest of Reason runs on");
  } finally { edge.endMaintenance(); }
  assert.equal((await fetch(`${base}/web`)).status, 200);
});

test("E5 from /ops: the owner pauses Web until a time and opens it again; a time that doesn't read is said plainly", async () => {
  db.startPageSession("ops", "tok-ops", { conversationId: C });
  const headers = { cookie: "reason_page=tok-ops" };
  const runtime = { say: () => {}, interval: {}, lastSweepAt: clock.now(), on() {} };
  const post = (body) => opsRequest({ method: "POST", headers, readBody: async () => body, runtime, log: () => {} });
  const on = await post("action=web_maint_on&until=45");
  assert.equal(on.status, 303);
  assert.equal(on.headers.Location, "/ops?focus=web#web");
  assert.equal(edge.maintenance().on, true);
  const shown = await opsRequest({ method: "GET", headers, readBody: async () => "", runtime, log: () => {} });
  assert.match(shown.body, /<section class="sec" id="web"><h2>Reason Web<\/h2><p class="okline"><b>Web is paused<\/b> · back by about \d{1,2}:\d{2} [AP]M ET<\/p>/);
  assert.match(shown.body, /value="web_maint_off"><button class="btn sm" data-busy="Working…">Open Web again<\/button>/);
  const bad = await post("action=web_maint_on&until=whenever");
  assert.equal(bad.status, 400);
  assert.match(bad.body, /That time didn&#39;t read\.|That time didn't read\./);
  assert.equal((await post("action=web_maint_off")).status, 303);
  assert.equal(edge.maintenance().on, false);
  // A stranger's post changes nothing.
  await opsRequest({ method: "POST", headers: {}, readBody: async () => "action=web_maint_on&until=45", runtime, log: () => {} });
  assert.equal(edge.maintenance().on, false);
  // Off altogether, the section isn't drawn.
  assert.doesNotMatch(renderOps({ report: null, web: null }), /id="web"/);
});

test("E5 from the CLI: on HH:MM | minutes, off, status — one ops_state row, never .env", () => {
  const now = Date.UTC(2026, 9, 26, 18, 0);
  assert.deepEqual(cli.run([], now), { code: 0, out: "Web is open." });
  assert.equal(cli.run(["on"], now).code, 2);
  assert.deepEqual(cli.run(["on", "15:30"], now), { code: 0, out: "Web is paused. Back by about 3:30 PM ET (turns itself off then)." });
  assert.equal(JSON.parse(db.opsGet(edge.MAINT_KEY)).by, "cli");
  assert.match(cli.run(["status"], now).out, /^Web is paused\. Back by about 3:30 PM ET \(set by cli\)\.$/);
  assert.deepEqual(cli.run(["off"], now), { code: 0, out: "Web is open." });
  assert.equal(cli.run(["sideways"], now).code, 2);
});
