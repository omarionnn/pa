// The wordmark on every page Reason made goes to "Your pages" (owner ask 2026-11-01: "if a user clicks
// the logo on the top left corner, it should go to a page where they can see all their pages and
// search too"). The list is Reason Web's Saved, pages only (heyreason.com/web/saved?kind=pages):
//
//   - the link: on an ordinary page and on a designed (v2) page, the same address for everybody, with
//     nothing of the page or its owner in it; not on a printed copy or Saved's own read-only frame
//   - signed out: sent to sign in, and signing in lands back on the list (and only ever on a Saved
//     path; anything else in the remembered cookie is ignored)
//   - own only: every page of theirs, newest first, title + type + date; nobody else's, ever; a
//     stranger who opens the owner's page and then the wordmark sees their own pages, not the owner's
//   - search: FIND SOMETHING reads titles and what the page says, still only theirs
//   - archived pages stay listed, marked ARCHIVED
//   - the empty list
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pages-index-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_CADDY_SECRET = "caddy-test"; // what Caddy adds beside its marker (src/pages/siteproxy.js caddyClientIp)
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";
delete process.env.REASON_AUTO_ADMIT;
delete process.env.REASON_BACKEND;

const { webRequestFor } = await import("../src/http.js");
const ws = await import("../src/pages/websignin.js");
const { renderPage } = await import("../src/pages/render.js");
const madedata = await import("../src/pages/madedata.js");
const { yourPagesHref, YOUR_PAGES_PATH } = await import("../src/pages/wordmark.js");
const { renderFrame } = await import("../src/pages/websaved.js");
const saved = await import("../src/saved.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const KOFI = "+14155559876";
const LINE = "+16562167455";
const OWNER_C = config.ownerConversation;
const KOFI_C = `dm:fake:${KOFI}`;
const DAY = 86_400_000;
const INDEX = "https://heyreason.test/web/saved?kind=pages";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations; DELETE FROM page_sessions;
    DELETE FROM page_codes; DELETE FROM page_attempts; DELETE FROM pages; DELETE FROM page_choices; DELETE FROM saved_marks; DELETE FROM messages;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi" });
  for (const [c, a] of [[OWNER_C, MASTER], [KOFI_C, KOFI]]) db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true });
});

function harness() {
  const logs = [];
  const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: async () => "ok" });
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await runtime.deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  return { runtime, router, channel, logs };
}
const form = (o) => new URLSearchParams(o).toString();
async function req(h, { sub = null, method = "GET", query = {}, body = null, cookie = "" } = {}) {
  const headers = { host: "heyreason.test", cookie, origin: "https://heyreason.test", "x-forwarded-for": "203.0.113.9", "x-files-domain": "true", "x-reason-caddy": "caddy-test" };
  return await webRequestFor({ sub, method, query, headers, remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router, log: (e) => h.logs.push(e) });
}
const setCookies = (out) => [].concat(out.headers["Set-Cookie"] ?? []);
const cookieValue = (out, name) => setCookies(out).map(c => new RegExp(`^${name}=([^;]*)`).exec(c)?.[1]).find(Boolean) ?? null;
const until = async (pred, ms = 2000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); return pred(); };
const codesTo = (h, to) => h.channel.sent.filter(m => m.to === to).map(m => /\b(\d{6})\b/.exec(m.text)?.[1]).filter(Boolean);

let n = 0;
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return `reason_page=${token}`;
}
function page(conv, title, { at = Date.now(), blocks = [{ type: "text", text: "words" }] } = {}) {
  const p = db.createPage(conv, { title, blocks });
  db.db.prepare("UPDATE pages SET created_at = ?, updated_at = ? WHERE id = ?").run(at, at, p.id);
  return p.id;
}
const rowsOf = (body) => [...body.matchAll(/<a class="sv-row[^"]*" href="([^"]+)"[^>]*><span class="sv-t">([^<]*)<\/span>(?:<span class="sv-d">([^<]*)<\/span>)?[^]*?<span class="sv-m">([^<]*)<\/span>/g)]
  .map(m => ({ href: m[1], title: m[2].replace(/&#39;/g, "'"), day: m[3] ?? "", meta: m[4] }));

// ---------------------------------------------------------------- the link

test("the wordmark on an ordinary page links to Your pages, the same address for everybody", () => {
  assert.equal(YOUR_PAGES_PATH, "/web/saved?kind=pages");
  assert.equal(yourPagesHref(), INDEX);
  const id = page(OWNER_C, "Omari's secret list");
  const html = renderPage(db.getPage(id), { interactive: true });
  const brand = /<div class="brand">(<a [^>]*>)<span class="wordmark"/.exec(html);
  assert.ok(brand, "the wordmark sits inside the link");
  assert.equal(brand[1], `<a class="wm-home" href="${INDEX}" target="_top" aria-label="Reason: your pages">`);
  // Nothing of this page or its owner rides in the link.
  assert.doesNotMatch(brand[1], new RegExp(id));
  assert.doesNotMatch(brand[1], /owner|dm:|Omari/);
  // A shared copy (somebody else reading it) carries exactly the same link.
  const shared = renderPage(db.getPage(id), { interactive: false, forName: "Omari" });
  assert.ok(shared.includes(brand[1]));
});

test("the wordmark on a designed (v2) page links there too; not on paper or in Saved's frame", () => {
  const was = config.pagesV2;
  config.pagesV2 = true;
  try {
    const id = page(OWNER_C, "Dinner, Friday", {
      blocks: [
        { type: "cards", items: [{ title: "Peaches", text: "Soul food" }, { title: "Lilia", text: "Pasta" }] },
        { type: "choice", key: "c1", options: [{ label: "Peaches" }, { label: "Lilia" }] },
      ],
    });
    const html = madedata.renderMadePage(db.getPage(id), { interactive: true });
    assert.ok(html, "drawn as a designed shortlist");
    assert.match(html, new RegExp(`<header class="top"><a class="wm-home" href="${INDEX.replace(/[?.]/g, "\\$&")}" target="_top"[^>]*><span class="wm"`));
  } finally { config.pagesV2 = was; }
  const id2 = page(OWNER_C, "Plain");
  assert.doesNotMatch(renderPage(db.getPage(id2), { printing: true }), /class="wm-home"/, "a printed copy has no link");
  assert.doesNotMatch(renderFrame(db.getPage(id2)), /class="wm-home"/, "Saved's read-only frame has no link");
});

// ---------------------------------------------------------------- signed out → sign in → back

test("signed out: the list sends them to sign in, and signing in lands back on Your pages", async () => {
  const h = harness();
  const out = await req(h, { sub: "saved", query: { kind: "pages" } });
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, "/web");
  const next = cookieValue(out, ws.NEXT_COOKIE);
  assert.equal(decodeURIComponent(next), "/web/saved?kind=pages");
  assert.match(setCookies(out).find(c => c.startsWith(`${ws.NEXT_COOKIE}=`)), /; Path=\/web; Max-Age=1800; HttpOnly; SameSite=Lax; Secure$/);
  assert.doesNotMatch(out.body, /sv-row/, "nothing listed to a browser signed in to nobody");

  // The sign-in page, a code, the code typed: lands on the list, and the remembered place is cleared.
  const landing = await req(h, { cookie: `${ws.NEXT_COOKIE}=${next}` });
  const f = cookieValue(landing, ws.FORM_COOKIE);
  const jar = `${ws.FORM_COOKIE}=${f}; ${ws.NEXT_COOKIE}=${next}`;
  const before = h.channel.sent.length;
  await req(h, { sub: "signin", method: "POST", body: form({ number: KOFI, f }), cookie: jar });
  assert.ok(await until(() => h.channel.sent.length > before));
  const done = await req(h, { sub: "code", method: "POST", body: form({ number: KOFI, code: codesTo(h, KOFI).at(-1), f }), cookie: jar });
  assert.equal(done.status, 303);
  assert.equal(done.headers.Location, "/web/saved?kind=pages");
  assert.ok(cookieValue(done, "reason_page"), "signed in");
  assert.match(setCookies(done).find(c => c.startsWith(`${ws.NEXT_COOKIE}=`)), /Max-Age=0/);
});

test("signing in with no remembered place, or a forged one, lands on the arrival as before", async () => {
  for (const forged of ["", "https://evil.test/web/saved", "//evil.test", "/web/settings", "/web/saved/../settings", "/web/saved?kind=pages\r\nX: y"]) {
    const h = harness();
    db.db.exec("DELETE FROM page_codes; DELETE FROM page_attempts; DELETE FROM outbox;");
    const landing = await req(h);
    const f = cookieValue(landing, ws.FORM_COOKIE);
    const jar = `${ws.FORM_COOKIE}=${f}${forged ? `; ${ws.NEXT_COOKIE}=${encodeURIComponent(forged)}` : ""}`;
    const before = h.channel.sent.length;
    await req(h, { sub: "signin", method: "POST", body: form({ number: KOFI, f }), cookie: jar });
    assert.ok(await until(() => h.channel.sent.length > before));
    const done = await req(h, { sub: "code", method: "POST", body: form({ number: KOFI, code: codesTo(h, KOFI).at(-1), f }), cookie: jar });
    assert.equal(done.headers.Location, "/web?home", `forged: ${JSON.stringify(forged)}`);
  }
  assert.equal(ws.safeNext("/web/saved?kind=pages&q=dinner%20list"), "/web/saved?kind=pages&q=dinner%20list");
  assert.equal(ws.safeNext("/web/saved/page/Ab3_dE-9"), "/web/saved/page/Ab3_dE-9");
});

// ---------------------------------------------------------------- own only

test("Your pages: every page of theirs, newest first, title + type + date; nobody else's", async () => {
  const h = harness();
  const now = Date.now();
  page(OWNER_C, "Oldest plan", { at: now - 40 * DAY });
  page(OWNER_C, "Dinner, Friday", { at: now - 2 * DAY, blocks: [
    { type: "cards", items: [{ title: "Peaches" }, { title: "Lilia" }, { title: "Via Carota" }] },
    { type: "choice", key: "c1", options: [{ label: "Peaches" }, { label: "Lilia" }, { label: "Via Carota" }] },
  ] });
  page(OWNER_C, "Newest notes", { at: now - 60_000 });
  page(KOFI_C, "Kofi's private page", { at: now });
  // Saved's other kinds never show on the pages list.
  db.createCall(OWNER_C, { provider: "fake", toNumber: "+12125550000", isOwner: false, goal: "Call the plumber", facts: [] });

  const out = await req(h, { sub: "saved", query: { kind: "pages" }, cookie: browser(OWNER_C) });
  assert.equal(out.status, 200);
  assert.match(out.body, /<h1 class="sv-h1">Your pages<\/h1>/);
  assert.match(out.body, /<title>Your pages · Reason<\/title>/);
  const rows = rowsOf(out.body);
  assert.deepEqual(rows.map(r => r.title), ["Newest notes", "Dinner, Friday", "Oldest plan"], "all of them, newest first, none folded");
  assert.equal(rows[1].meta, "PAGE · SHORTLIST");
  assert.equal(rows[0].meta, "PAGE");
  assert.ok(rows.every(r => r.day), "each row carries its date");
  assert.doesNotMatch(out.body, /Kofi&#39;s private page|Kofi's private page/);
  assert.doesNotMatch(out.body, /plumber/i);

  // Kofi, signed in on his own browser, sees only his.
  const k = await req(h, { sub: "saved", query: { kind: "pages" }, cookie: browser(KOFI_C) });
  assert.deepEqual(rowsOf(k.body).map(r => r.title), ["Kofi's private page"]);
  assert.doesNotMatch(k.body, /Newest notes|Dinner, Friday|Oldest plan/);
});

test("a stranger who opens the owner's page and taps the wordmark gets their own list or a sign-in, never the owner's", async () => {
  const h = harness();
  const id = page(OWNER_C, "Omari's apartment shortlist");
  page(OWNER_C, "Omari's other page");
  // What the stranger's browser is handed: the page, whose wordmark link is the generic one.
  const html = renderPage(db.getPage(id), { interactive: false, forName: "Omari" });
  assert.ok(html.includes(`href="${INDEX}"`));
  assert.doesNotMatch(html, /Omari's other page/);
  // Following it signed out: a sign-in, nothing listed.
  const out = await req(h, { sub: "saved", query: { kind: "pages" } });
  assert.equal(out.status, 303);
  assert.doesNotMatch(out.body, /Omari/);
  // Following it signed in as themselves: their own (empty) list.
  const k = await req(h, { sub: "saved", query: { kind: "pages" }, cookie: browser(KOFI_C) });
  assert.equal(k.status, 200);
  assert.doesNotMatch(k.body, /Omari&#39;s|Omari's/);
  // And the owner's page id opened inside Kofi's Saved is simply not found.
  const opened = await req(h, { sub: `saved/page/${id}`, cookie: browser(KOFI_C) });
  assert.notEqual(opened.status, 200);
  assert.doesNotMatch(opened.body ?? "", /apartment shortlist/);
});

// ---------------------------------------------------------------- search

test("FIND SOMETHING on Your pages reads titles and what the page says, still only theirs", async () => {
  const h = harness();
  page(OWNER_C, "Dinner, Friday", { blocks: [{ type: "text", text: "three places near the West Village" }] });
  page(OWNER_C, "Dentist options", { blocks: [{ type: "text", text: "cleaning on Tuesday" }] });
  page(KOFI_C, "Kofi in the West Village", { blocks: [{ type: "text", text: "village walk" }] });
  const me = browser(OWNER_C);
  const byTitle = await req(h, { sub: "saved", query: { kind: "pages", q: "dentist" }, cookie: me });
  assert.deepEqual(rowsOf(byTitle.body).map(r => r.title), ["Dentist options"]);
  const byText = await req(h, { sub: "saved", query: { kind: "pages", q: "west village" }, cookie: me });
  assert.deepEqual(rowsOf(byText.body).map(r => r.title), ["Dinner, Friday"], "matched on what the page says; Kofi's never");
  assert.match(byText.body, /<input type="hidden" name="kind" value="pages">/, "search stays on pages");
  assert.match(byText.body, /value="west village"/);
  const none = await req(h, { sub: "saved", query: { kind: "pages", q: "zebra" }, cookie: me });
  assert.deepEqual(rowsOf(none.body), []);
  assert.match(none.body, /nothing saved matches that\. try fewer words\./);
});

// ---------------------------------------------------------------- archived, empty

test("an archived page stays on the list, marked ARCHIVED", async () => {
  const h = harness();
  const id = page(OWNER_C, "Last month's trip");
  page(OWNER_C, "This week's plan");
  db.db.prepare("UPDATE pages SET state = 'archived', archived_at = ? WHERE id = ?").run(Date.now(), id);
  const item = saved.savedItems(OWNER_C).find(i => i.id === id);
  assert.equal(item.archived, true);
  assert.equal(item.meta, "PAGE · ARCHIVED");
  const out = await req(h, { sub: "saved", query: { kind: "pages" }, cookie: browser(OWNER_C) });
  const rows = rowsOf(out.body);
  assert.equal(rows.find(r => r.title === "Last month's trip").meta, "PAGE · ARCHIVED");
  assert.equal(rows.find(r => r.title === "This week's plan").meta, "PAGE");
});

test("nothing made yet: the pages list says so in its own words", async () => {
  const h = harness();
  const out = await req(h, { sub: "saved", query: { kind: "pages" }, cookie: browser(OWNER_C) });
  assert.equal(out.status, 200);
  assert.match(out.body, /No pages<br>yet\./);
  assert.match(out.body, /when i make you a page,<br>a list, a plan, a receipt, it lands here\./);
  // Saved itself keeps its own empty line.
  assert.match((await req(h, { sub: "saved", cookie: browser(OWNER_C) })).body, /Nothing saved<br>yet\./);
});
