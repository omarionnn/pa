// Reason's contact card, and the picture on a page link. No model, no network, no browser.
//
// Why both are here: they are the two halves of one complaint — "all of Reason's pages never have
// the preview" (Omari, 2026-10-06). Apple only expands links from a saved contact, so the card gets
// Reason saved; and the picture is what the phone then puts on the card it draws.
//
//   is the card a vCard a phone can save, with the line's number on it?        (vcard)
//   is it served from this process at a .vcf address, and only with a live line? (assetRequest)
//   does "yes" send the welcome and then the card, once?                        (router + access)
//   does the startup pass reach everybody who already had an account, once?    (backfill)
//   can the picture be fetched by whoever may see the page, and nobody else?    (cardRequest)
import { createHash } from "node:crypto";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
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
const { vcard, contactCardUrl, offerContactCard, backfillContactCards, CARD_LINE, CONTACT_PATH, RETRY_AFTER_MS } = await import("../src/contact.js");
const { assetRequest, cardRequest, pageRequest } = await import("../src/http.js");
const { cardHtml, cardPath, pageCard, cardFilename, illustrationPath } = await import("../src/pages/card.js");
const { cardUrl } = await import("../src/pages/render.js");
const { runTool } = await import("../src/tools.js");
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
  assert.match(v, /\r\nPHOTO;ENCODING=b;TYPE=JPEG:/);
  assert.match(v, /END:VCARD\r\n$/);
  // Folded: no line over 75 octets, and a continuation starts with one space.
  for (const line of v.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `${Buffer.byteLength(line)} octets: ${line.slice(0, 20)}`);
  assert.match(v, /\r\n [A-Za-z0-9+/=]/, "the photo continues on folded lines");
});

test("the card's note is the owner's tagline, \"Your personal concierge\" (10-25 copy change)", () => {
  const v = vcard({ number: LINE });
  assert.match(v, /\r?\nNOTE:Your personal concierge\r?\n/);
  assert.doesNotMatch(v, /lives in your texts/i);
});

test("the card includes a second number labeled 'call me' when a call number is given", () => {
  const CALL = "+19145551234";
  const v = vcard({ number: LINE, callNumber: CALL });
  assert.match(v, new RegExp(`\\r\\nTEL;TYPE=CELL,VOICE,pref:\\${LINE}\\r\\n`), "text number present");
  assert.match(v, new RegExp(`\\r\\nitem1\\.TEL:\\${CALL}\\r\\n`), "call number present");
  assert.match(v, /\r\nitem1\.X-ABLabel:call me\r\n/, "call number labeled");
});

test("the card omits the call number line when none is given or invalid", () => {
  assert.doesNotMatch(vcard({ number: LINE }), /item1\.TEL/);
  assert.doesNotMatch(vcard({ number: LINE, callNumber: "" }), /item1\.TEL/);
  assert.doesNotMatch(vcard({ number: LINE, callNumber: "not a number" }), /item1\.TEL/);
});

test("no number, no card: a contact nobody can save against the thread is not made", () => {
  assert.equal(vcard({ number: "" }), null);
  assert.equal(vcard({ number: "the line" }), null);
});

test("the card is served at its hashed address (and the old /reason.vcf) from the live line, and not without one", () => {
  const { router } = harness();
  const hashed = new URL(contactCardUrl({ router, channel: "fake" })).pathname;
  assert.match(hashed, /^\/reason-[0-9a-f]{8}\.vcf$/);
  const res = assetRequest({ pathname: hashed, router });
  assert.equal(hashed, `/reason-${createHash("sha256").update(res.body).digest("hex").slice(0, 8)}.vcf`, "the address is the served card's own hash");
  assert.equal(assetRequest({ pathname: CONTACT_PATH, router }).body, res.body, "the old address is an alias");
  assert.doesNotMatch(res.headers["Cache-Control"], /max-age=[1-9]/, "no long cache on the card");
  assert.match(res.body, /\r\nREV:\d{4}-\d\d-\d\dT[\d:]+Z\r\n/, "the card says when it was revised");
  assert.equal(res.status, 200);
  assert.match(res.headers["Content-Type"], /^text\/vcard/);
  assert.match(res.headers["Content-Disposition"], /Reason\.vcf/);
  assert.match(res.body, new RegExp(`TEL[^\\r]*:\\${LINE}`));

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
  assert.equal(toKofi[cardAt].media.url, contactCardUrl({ router: h.router, channel: "fake" }));
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

// ---------- the picture ----------

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

// ---------- fetching the picture ----------

test("a page names its picture, always keyed — a page is only ever its owner's", async () => {
  const { page, link } = await makePage();
  const key = new URL(link).searchParams.get("k");
  // A fetcher with the key and no cookie reads the gate, which carries the page's tags: the card
  // under the owner's own text is drawn from exactly what a preview fetcher is served.
  const res = await pageRequest({ id: page.id, key, method: "GET", headers: {}, readBody: async () => "" });
  assert.equal(res.status, 401);
  const img = /<meta property="og:image" content="([^"]+)"/.exec(res.body)?.[1];
  assert.ok(img, "og:image is on the gate the fetcher is served");
  const u = new URL(img.replace(/&amp;/g, "&"));
  assert.equal(u.pathname, `/p/${page.id}/card.png`);
  assert.equal(u.searchParams.get("k"), key, "the fetcher already holds this key");
  assert.equal(u.searchParams.get("v"), "1");
  // The icon is on the page's own host (root-relative), never the Tailscale address (10-26).
  assert.match(res.body, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png\?v=[0-9a-f]{10}">/);
  assert.doesNotMatch(res.body, /rel="(?:apple-touch-)?icon"[^>]*href="https?:/);
  assert.match(res.body, /twitter:card" content="summary_large_image"/);
  assert.equal(new URL(cardUrl(db.getPage(page.id))).searchParams.get("k"), key);
});

test("the picture is fetched with the key, and is a 404 to anyone else", async () => {
  const { page, link } = await makePage();
  const key = new URL(link).searchParams.get("k");

  const stranger = await cardRequest({ id: page.id, draw: fakeDraw });
  assert.equal(stranger.status, 404, "no key: nothing");
  assert.equal(stranger.headers["Content-Type"], "text/html; charset=utf-8");

  const owner = await cardRequest({ id: page.id, key, draw: fakeDraw });
  assert.equal(owner.status, 200);
  assert.equal(owner.headers["Content-Type"], "image/png");
  assert.equal(owner.body.subarray(1, 4).toString(), "PNG");

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

// ---------- illustrated cards ----------

test("when an illustration is on disk the card uses it as the background", async () => {
  const { page } = await makePage("Best restaurants in Accra");
  const ilPath = illustrationPath(page.id);
  mkdirSync(dirname(ilPath), { recursive: true });
  writeFileSync(ilPath, PNG);

  const html = cardHtml({ title: page.title, illustration: ilPath });
  assert.match(html, /Best restaurants in Accra/, "title is on the card");
  assert.match(html, /data:image\/png;base64,/, "illustration is inlined");
  assert.match(html, /class="brand"/, "brand mark present");
  assert.match(html, /Reason/, "Reason name present");
  assert.doesNotMatch(html, /Made for/, "illustrated card omits the 'made for' bar");
  assert.match(html, /width:1200px;height:630px/, "same dimensions");
});

test("the fallback card is a solid colour when no illustration exists", () => {
  const html = cardHtml({ title: "Morning workout plan", forName: "Kofi", when: "Oct 12" });
  assert.match(html, /Morning workout plan/);
  assert.match(html, /Made for Kofi/);
  assert.match(html, /background:#2c2520/, "solid dark background");
  assert.doesNotMatch(html, /data:image/, "no inlined image");
  assert.match(html, /width:1200px;height:630px/);
});

test("pageCard picks up a pre-generated illustration from disk", async () => {
  const { page } = await makePage("Flights to Lagos");
  const ilPath = illustrationPath(page.id);
  mkdirSync(dirname(ilPath), { recursive: true });
  writeFileSync(ilPath, PNG);

  let rendered;
  const shoot = async (html) => { rendered = html; return PNG; };
  await pageCard(page, { shoot });
  assert.match(rendered, /data:image\/png;base64,/, "the illustration was used");
});
