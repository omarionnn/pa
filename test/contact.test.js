// Reason's contact card, and the picture on a page link. No model, no network, no browser.
//
// Why both are here: they are the two halves of one complaint — "all of Reason's pages never have
// the preview" (Omari, 2026-10-06). Apple only expands links from a saved contact, so the card gets
// Reason saved; and the picture on the link does not wait on anybody's phone to decide anything.
//
//   is the card a vCard a phone can save, with the line's number on it?        (vcard)
//   is it served from this process at a .vcf address, and only with a live line? (assetRequest)
//   does "yes" send the welcome and then the card, once?                        (router + access)
//   does the startup pass reach everybody who already had an account, once?    (backfill)
//   does a page link leave with the page's picture on it, and other links bare? (deliver)
//   can the picture be fetched by whoever may see the page, and nobody else?    (cardRequest)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-contact-"));
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://textreason.example.test";
process.env.REASON_BURST_QUIET_MS = "0";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver, withPageCards, pageForLink } = await import("../src/deliver.js");
const { vcard, contactCardUrl, offerContactCard, backfillContactCards, CARD_LINE, CONTACT_PATH, RETRY_AFTER_MS } = await import("../src/contact.js");
const { assetRequest, cardRequest, pageRequest } = await import("../src/http.js");
const { cardHtml, cardPath, pageCard, cardFilename } = await import("../src/pages/card.js");
const { cardUrl } = await import("../src/pages/render.js");
const { runTool } = await import("../src/tools.js");
const { LINK, TEXT } = await import("../src/plain.js");
const access = await import("../src/access.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const KOFI = "+14155559876";
const LINE = "+18085550123";
const C = config.ownerConversation;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM inbound_messages; DELETE FROM pages; DELETE FROM page_sessions; DELETE FROM usage;");
});

// A one-pixel PNG, so a "drawn" picture has real bytes without a browser.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const fakeShoot = async () => PNG;
const fakeDraw = (page, opts) => pageCard(page, { ...opts, shoot: fakeShoot });

function harness({ verdict = "yes", live = true } = {}) {
  const turns = [];
  const logs = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text, kind }) => { turns.push({ conversationId, text, kind }); return "ok"; } });
  const judge = async () => ({ verdict });
  const router = new Router({ runtime, judge, log: (e) => logs.push(e), timers: { set: (fn) => { fn(); return 0; }, clear: () => {} } });
  const channel = router.register(new FakeChannel({ number: LINE, live }));
  router.register(new ConsoleChannel({ write: () => {} }));
  return { runtime, router, channel, turns, logs, judge };
}

const texts = (from, body, id = String(Math.random())) => ({ channel: "fake", externalId: id, from, text: body, at: clock.now() });
const cards = (channel, to) => channel.sent.filter(m => m.to === to && m.media?.url);

// ---------- the card itself ----------

test("the card is a vCard with the line's number, a photo, and the site on it", () => {
  const v = vcard({ number: LINE });
  assert.match(v, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
  assert.match(v, /\r\nFN:Reason\r\n/);
  assert.match(v, new RegExp(`\\r\\nTEL;TYPE=CELL,VOICE,pref:\\${LINE}\\r\\n`));
  assert.match(v, /\r\nURL:https:\/\/textreason\.example\.test\r\n/);
  assert.match(v, /\r\nPHOTO;ENCODING=b;TYPE=PNG:/);
  assert.match(v, /END:VCARD\r\n$/);
  // Folded: no line over 75 octets, and a continuation starts with one space.
  for (const line of v.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `${Buffer.byteLength(line)} octets: ${line.slice(0, 20)}`);
  assert.match(v, /\r\n [A-Za-z0-9+/=]/, "the photo continues on folded lines");
});

test("no number, no card: a contact nobody can save against the thread is not made", () => {
  assert.equal(vcard({ number: "" }), null);
  assert.equal(vcard({ number: "the line" }), null);
});

test("the card is served at /reason.vcf from the live line, and not without one", () => {
  const { router } = harness();
  const res = assetRequest({ pathname: CONTACT_PATH, router });
  assert.equal(res.status, 200);
  assert.match(res.headers["Content-Type"], /^text\/vcard/);
  assert.match(res.headers["Content-Disposition"], /Reason\.vcf/);
  assert.match(res.body, new RegExp(`TEL[^\\r]*:\\${LINE}`));
  assert.equal(contactCardUrl(), `https://reason.example.test${CONTACT_PATH}`);

  const dead = harness({ live: false });
  assert.equal(assetRequest({ pathname: CONTACT_PATH, router: dead.router }).status, 404, "no live line means no card");
  assert.equal(assetRequest({ pathname: "/somewhere-else", router }), null, "anything else is not an asset");
});

test("the icon and the site's picture are served, cached, as PNG", () => {
  for (const p of ["/apple-touch-icon.png", "/og.png"]) {
    const res = assetRequest({ pathname: p });
    assert.equal(res.status, 200, p);
    assert.equal(res.headers["Content-Type"], "image/png");
    assert.match(res.headers["Cache-Control"], /max-age/);
    assert.equal(res.body.subarray(1, 4).toString(), "PNG", `${p} starts like a PNG`);
  }
});

// ---------- when it goes out ----------

test("yes sends the welcome, then the card to save — once", async () => {
  const h = harness({ verdict: "yes" });
  await h.router.deliver(texts(KOFI, "hi", "a"));
  // The master's reply, through the real path.
  await h.router.deliver(texts(OWNER, "yeah go on then", "b"));

  const toKofi = h.channel.sent.filter(m => m.to === KOFI);
  const welcomeAt = toKofi.findIndex(m => /you're in/i.test(m.text));
  const cardAt = toKofi.findIndex(m => m.media?.url);
  assert.ok(welcomeAt >= 0, "welcomed");
  assert.ok(cardAt > welcomeAt, "the card comes after the welcome, not before it");
  assert.equal(toKofi[cardAt].media.url, contactCardUrl());
  assert.equal(toKofi[cardAt].text, CARD_LINE);
  assert.ok(db.getAccount(`dm:fake:${KOFI}`).contact_card_sent_at, "remembered on the account");

  // Their next text does not bring another.
  await h.router.deliver(texts(KOFI, "remind me about dinner friday", "c"));
  assert.equal(cards(h.channel, KOFI).length, 1);
});

test("a pre-approved number's first text makes the account and sends the card once", async () => {
  const before = config.testNumbers.slice();
  config.testNumbers.push(KOFI);
  try {
    const h = harness();
    await h.router.deliver(texts(KOFI, "yo", "a"));
    await h.router.deliver(texts(KOFI, "u there", "b"));
    assert.equal(cards(h.channel, KOFI).length, 1, "one card across two texts");
    assert.ok(db.getAccount(`dm:fake:${KOFI}`).contact_card_sent_at);
  } finally {
    config.testNumbers.length = 0;
    config.testNumbers.push(...before);
  }
});

test("everybody who already had an account gets the card at startup, and never again", async () => {
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: `dm:fake:${KOFI}`, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
  db.upsertAccount({ conversationId: "dm:console", channel: "console", address: "console", name: "", isOperator: false });
  const h = harness();

  const first = await backfillContactCards({ router: h.router });
  assert.equal(first.sent, 2, "both people on a texting channel");
  assert.equal(first.skipped, 1, "the console is not a phone");
  assert.equal(cards(h.channel, OWNER).length, 1);
  assert.equal(cards(h.channel, KOFI).length, 1);

  const again = await backfillContactCards({ router: h.router });
  assert.equal(again.sent, 0, "a restart sends nothing");
  assert.equal(h.channel.sent.filter(m => m.media?.url).length, 2);
});

test("a card that would not go is tried again later, not on every text", async () => {
  db.upsertAccount({ conversationId: `dm:fake:${KOFI}`, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
  const h = harness();
  h.channel.mediaFailWith = "the line is down";
  const account = () => db.getAccount(`dm:fake:${KOFI}`);

  assert.equal((await offerContactCard({ router: h.router, account: account() })).outcome, "failed");
  assert.equal((await offerContactCard({ router: h.router, account: account() })).outcome, "skipped", "not again straight away");
  assert.equal(account().contact_card_sent_at, null);

  clock.skip(RETRY_AFTER_MS + 1);
  h.channel.mediaFailWith = null;
  assert.equal((await offerContactCard({ router: h.router, account: account() })).outcome, "sent");
  assert.ok(account().contact_card_sent_at);
});

test("without a public address there is nothing to point Sendblue at, so nothing is sent", async () => {
  db.upsertAccount({ conversationId: `dm:fake:${KOFI}`, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
  const h = harness();
  const was = config.publicUrl;
  config.publicUrl = "";
  try {
    const r = await offerContactCard({ router: h.router, account: db.getAccount(`dm:fake:${KOFI}`) });
    assert.equal(r.outcome, "skipped");
    assert.match(r.why, /REASON_PUBLIC_URL/);
    assert.equal(h.channel.sent.length, 0);
  } finally {
    config.publicUrl = was;
  }
});

// ---------- the picture on the link ----------

async function makePage(title = "Friday dinner", blocks = [{ type: "text", text: "Three places, all walkable." }]) {
  const out = await runTool("page_create", { title, blocks }, { conversationId: C });
  assert.equal(out.ok, true, out.error);
  return { ...out, page: db.getPage(out.page_id) };
}

test("the picture is the page's words in the page's palette, drawn once per revision", async () => {
  const { page } = await makePage("Build a bigger back");
  const html = cardHtml({ title: page.title, subtitle: "Two days a week.", forName: "Omari", when: "Oct 6" });
  assert.match(html, /Build a bigger back/);
  assert.match(html, /Made for Omari · Oct 6/);
  assert.match(html, /Two days a week\./);
  assert.match(html, /width:1200px;height:630px/);
  assert.doesNotMatch(html, /http/, "nothing fetched from anywhere");
  // Escaped on the way through, like every page.
  assert.match(cardHtml({ title: "<b>x</b> & y" }), /&lt;b&gt;x&lt;\/b&gt; &amp; y/);

  let drawn = 0;
  const shoot = async () => { drawn++; return PNG; };
  const a = await pageCard(page, { shoot });
  const b = await pageCard(page, { shoot });
  assert.equal(a.file, cardPath(page));
  assert.equal(a.fresh, true);
  assert.equal(b.fresh, false);
  assert.equal(drawn, 1, "the second ask reads the file");
  assert.equal(cardFilename(page), "build-a-bigger-back.png");
});

test("a page link leaves with the page's picture on it; other links and the words go bare", async () => {
  const { link, page } = await makePage();
  const parts = [
    { kind: LINK, text: link },
    { kind: LINK, text: "https://example.com/somewhere" },
    { kind: TEXT, text: "here's your shortlist" },
  ];
  const items = await withPageCards(parts, { conversationId: C, draw: fakeDraw });
  assert.equal(items.length, 3);
  assert.equal(items[0].media?.mimeType, "image/png");
  assert.equal(items[0].media?.file, cardPath(page));
  assert.equal(items[0].media?.filename, "friday-dinner.png");
  assert.equal(items[1].media, null, "a link that is not a page is left alone");
  assert.equal(items[2].media, null);
});

test("somebody else's private page is not decorated from this conversation; a shared one is", async () => {
  const { link, page } = await makePage();
  assert.equal(pageForLink(link, "dm:fake:+19999999999"), null, "not theirs, not shared");
  assert.equal(pageForLink(link, C)?.id, page.id, "the owner's own");
  await runTool("page_share", { page_id: page.id }, { conversationId: C });
  assert.equal(pageForLink(link, "dm:fake:+19999999999")?.id, page.id, "shared: anyone holding the link may read it");
  assert.equal(pageForLink("https://elsewhere.test/p/abcdefgh", C), null, "another host's /p/ is not ours");
});

test("a picture that cannot be drawn costs the link nothing", async () => {
  const { link } = await makePage();
  const logs = [];
  const items = await withPageCards([{ kind: LINK, text: link }], {
    conversationId: C, log: (e) => logs.push(e),
    draw: async () => { throw new Error("no Chromium here"); },
  });
  assert.equal(items[0].text, link);
  assert.equal(items[0].media, null);
  assert.ok(logs.some(e => e.link_card_failed), "said in the log");
});

test("through the real delivery: the link bubble carries the picture, the words bubble does not", async () => {
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  const { link } = await makePage();
  const sent = [];
  const router = new Router({ log: () => {} });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: LINE }));
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: (l) => sent.push({ warned: l }), draw: fakeDraw });

  const r = await deliver({ conversationId: C, text: `here's your shortlist ${link}`, media: null, channel: "fake", to: OWNER, chatId: null, fromOwner: true });
  assert.equal(r.ok, true);
  const mine = fake.sent.filter(m => m.to === OWNER);
  assert.equal(mine.length, 2, "two bubbles: the link, then the words");
  assert.equal(mine[0].text, link);
  assert.equal(mine[0].media?.mimeType, "image/png");
  assert.ok(mine[0].media?.bytes > 0, "real bytes went");
  assert.equal(mine[1].text, "here's your shortlist");
  assert.equal(mine[1].media ?? null, null);

  // A reply that is nothing but the link gets the picture too.
  const only = await deliver({ conversationId: C, text: link, media: null, channel: "fake", to: OWNER, chatId: null, fromOwner: true });
  assert.equal(only.ok, true);
  const last = fake.sent[fake.sent.length - 1];
  assert.equal(last.text, link);
  assert.equal(last.media?.mimeType, "image/png");
});

test("REASON_LINK_CARDS=off sends links bare without a deploy", async () => {
  const { link } = await makePage();
  const was = config.linkCards;
  config.linkCards = false;
  try {
    const items = await withPageCards([{ kind: LINK, text: link }], { conversationId: C, draw: fakeDraw });
    assert.equal(items[0].media, null);
  } finally {
    config.linkCards = was;
  }
});

// ---------- fetching the picture ----------

test("a page names its picture, keyed when private and bare when shared", async () => {
  const { page, link } = await makePage();
  const key = new URL(link).searchParams.get("k");
  const res = await pageRequest({ id: page.id, key, method: "GET", headers: {}, readBody: async () => "" });
  assert.equal(res.status, 200);
  const img = /<meta property="og:image" content="([^"]+)"/.exec(res.body)?.[1];
  assert.ok(img, "og:image is on the page");
  const u = new URL(img.replace(/&amp;/g, "&"));
  assert.equal(u.pathname, `/p/${page.id}/card.png`);
  assert.equal(u.searchParams.get("k"), key, "the fetcher already holds this key");
  assert.equal(u.searchParams.get("v"), "1");
  assert.match(res.body, /<link rel="apple-touch-icon" href="https:\/\/reason\.example\.test\/apple-touch-icon\.png">/);
  assert.match(res.body, /twitter:card" content="summary_large_image"/);

  await runTool("page_share", { page_id: page.id }, { conversationId: C });
  const shared = db.getPage(page.id);
  assert.equal(new URL(cardUrl(shared)).searchParams.get("k"), null, "a shared page's picture needs no key");
});

test("the picture is fetched with the key or on a shared page, and is a 404 to anyone else", async () => {
  const { page, link } = await makePage();
  const key = new URL(link).searchParams.get("k");

  const stranger = await cardRequest({ id: page.id, draw: fakeDraw });
  assert.equal(stranger.status, 404, "no key, not shared: nothing");
  assert.equal(stranger.headers["Content-Type"], "text/html; charset=utf-8");

  const owner = await cardRequest({ id: page.id, key, draw: fakeDraw });
  assert.equal(owner.status, 200);
  assert.equal(owner.headers["Content-Type"], "image/png");
  assert.equal(owner.body.subarray(1, 4).toString(), "PNG");

  await runTool("page_share", { page_id: page.id }, { conversationId: C });
  assert.equal((await cardRequest({ id: page.id, draw: fakeDraw })).status, 200, "shared: anyone");
  assert.equal((await cardRequest({ id: "NotARealPageId12", draw: fakeDraw })).status, 404);
});

test("the gate and the not-found page still build no card, picture or not", async () => {
  const { page } = await makePage("Kofi's present");
  const gate = await pageRequest({ id: page.id, method: "GET", headers: {}, readBody: async () => "" });
  assert.equal(gate.status, 401);
  assert.doesNotMatch(gate.body, /og:/);
  assert.doesNotMatch(gate.body, /card\.png/);
  assert.doesNotMatch(gate.body, /Kofi/);
  const missing = await pageRequest({ id: "ThisIsNotARealPageId123", method: "GET", headers: {}, readBody: async () => "" });
  assert.doesNotMatch(missing.body, /og:/);
  // Both carry the same icon link, so neither says more than the other.
  const icons = (html) => html.match(/<link rel="[^"]+" [^>]+>/g) ?? [];
  assert.deepEqual(icons(gate.body), icons(missing.body));
});
