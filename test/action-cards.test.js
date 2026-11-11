// Action Cards (src/actioncards.js, src/pages/actioncards.js, REASON_ACTION_CARDS): the daily note's
// page and its plumbing, without the engine. What these hold:
//   1. the switch: off by default and every address a plain 404; owner; on
//   2. the token: made-up, forged, unknown, run out (7 days) and all-handled addresses show the paper
//      gone page, never a card; only a good token draws the note
//   3. the page: eyebrows, headline, drawings, sms: links in the person's own voice (no card id in the
//      body), the link card's tags (og:title "Ready for you", picture per token and state, no og:url)
//   4. dismiss: recorded server-side with no confirm, gone on reload, the rest renumbered, the title
//      remembered for the engine; done cards sink below the open ones and the eyebrow says "2 OPEN"
//   5. a text that is a card's words runs as the normal turn and the card is done once it replied;
//      the threshold and the shapes it does and does not match
//   6. the log: view, tap, reply, dismiss, done per card
//   7. the picture: drawn once per state, served as PNG, the generic card when a digest is gone
//   8. in a real browser: tap opens the sms: link, dismiss strikes and renumbers, done sinks
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-action-cards-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.REASON_TOKEN_KEY = "46".repeat(32);
process.env.SENDBLUE_FROM_NUMBER = "+1 (415) 555-0199";
process.env.REASON_ACTION_CARDS = "on";
delete process.env.REASON_WELCOME_CARDS;

const cards = await import("../src/actioncards.js");
const page = await import("../src/pages/actioncards.js");
const { art, DRAW } = await import("../src/pages/actionart.js");
const { SAMPLE_CARDS, seed } = await import("../scripts/action-cards-seed.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");

const MASTER = "+12025551234";
const LINE = "+16562167455";
let n = 0;
const newNumber = () => `+1415559${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;
const C = "dm:fake:+14155550100";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  process.env.REASON_ACTION_CARDS = "on";
  config.autoAdmit = true;
  config.onboarding = "off";
  config.siteUrl = "https://heyreason.com";
  db.db.exec("DELETE FROM accounts; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM timers; DELETE FROM action_digests; DELETE FROM action_cards; DELETE FROM action_card_dismissed; DELETE FROM action_card_events;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: C, channel: "fake", address: "+14155550100", name: "Kofi" });
  page.setActionCardShooter(null);
});

const get = (path, method = "GET") => page.actionCardsRequest({ method, path, now: clock.now() });
const post = (path) => page.actionCardsRequest({ method: "POST", path, now: clock.now() });
const tag = (html, prop) => new RegExp(`<meta (?:property|name)="${prop.replace(/[.:]/g, "\\$&")}" content="([^"]*)">`).exec(html)?.[1];
const eyebrows = (html) => [...String(html).matchAll(/<li class="card[^"]*"[^>]*>\s*<p class="eb"><b>(\d\d)<\/b> \/ (\d\d) · ([A-Z]+)<\/p>/g)].map(m => `${m[1]} / ${m[2]} · ${m[3]}`);
const liOrder = (html) => [...String(html).matchAll(/<li class="(card[^"]*)"[^>]*aria-label="([^"]*)"/g)].map(m => ({ cls: m[1].trim(), title: m[2] }));
const GONE_WORDS = /This note is no longer good\./;

// ---------- 1. the switch ----------

test("the switch: off by default, owner, on; off makes every address a plain 404 and matches nothing", async () => {
  delete process.env.REASON_ACTION_CARDS;
  assert.equal(cards.mode(), "off");
  assert.equal(cards.allowedFor(config.ownerConversation), false);
  const d = seed(C);
  const off = await get(`/a/${d.token}`);
  assert.equal(off.status, 404);
  assert.match(off.headers["Content-Type"], /json/);
  assert.doesNotMatch(off.body, /Anthropic/);
  assert.equal(await page.actionCardsOgRequest(page.ogImagePath(d.token)), null);
  assert.equal(cards.matchInbound(C, [SAMPLE_CARDS[0].prefill]), null);

  process.env.REASON_ACTION_CARDS = "owner";
  assert.equal(cards.mode(), "owner");
  assert.equal(cards.allowedFor(config.ownerConversation), true, "the operator's own thread");
  assert.equal(cards.allowedFor(C), false, "somebody else, under owner");
  assert.equal(cards.viewByToken(d.token), null, "their digest reads as nothing");
  assert.match((await get(`/a/${d.token}`)).body, GONE_WORDS);
  const mine = seed(config.ownerConversation);
  assert.equal((await get(`/a/${mine.token}`)).status, 200);

  process.env.REASON_ACTION_CARDS = "on";
  assert.equal(cards.allowedFor(C), true);
  assert.equal((await get(`/a/${d.token}`)).status, 200);
});

// ---------- 2. the token ----------

test("a digest: id, signed token, link on heyreason.com/a/, 7 days, three sample cards with codes", () => {
  const d = seed(C);
  assert.match(d.id, /^[A-Za-z0-9_-]{12}$/);
  assert.match(d.token, cards.TOKEN_RE);
  assert.equal(d.url, `https://heyreason.com/a/${d.token}`);
  assert.equal(d.expiresAt - d.createdAt, cards.DIGEST_TTL_MS);
  assert.equal(d.cards.length, 3);
  assert.deepEqual(d.cards.map(c => c.verb), ["REPLACE", "PLAN", "DIAGNOSE"]);
  assert.deepEqual(d.cards.map(c => c.status), ["open", "open", "open"]);
  for (const c of d.cards) assert.match(c.code, cards.CODE_RE);
  assert.equal(cards.readToken(d.token), d.id);
  assert.equal(cards.viewByToken(d.token).id, d.id);
});

test("no cards without a good token: made-up, forged, unknown and reshaped addresses all show the gone page, with nothing of anyone's on it", async () => {
  const d = seed(C);
  const forged = d.token.slice(0, 12) + (d.token[12] === "A" ? "B" : "A") + d.token.slice(13);
  const other = cards.tokenOf("zzzzzzzzzzzz");
  for (const bad of ["nonsense", d.token.slice(0, 27), `${d.token}x`, forged, other, d.id, "../web", "%2e%2e"]) {
    assert.equal(cards.readToken(bad) && cards.viewByToken(bad), null, bad);
    const res = await get(`/a/${bad}`);
    assert.equal(res.status, 404, bad);
    assert.match(res.body, GONE_WORDS, bad);
    assert.doesNotMatch(res.body, /Anthropic|birthday|server went down/, `${bad}: no card leaks`);
    assert.equal(res.headers["Cache-Control"], "no-store");
  }
  assert.match((await get("/a")).body, GONE_WORDS);
  assert.match((await get("/a/")).body, GONE_WORDS);
  // A post with a bad token is a plain 404 (nothing to draw a page for).
  assert.equal((await post(`/a/${forged}/dismiss/${d.cards[0].code}`)).status, 404);
  assert.deepEqual(cards.digestById(d.id).cards.map(c => c.status), ["open", "open", "open"], "the forged post changed nothing");
});

test("a digest runs out after 7 days: the gone page (410), the picture falls back, the match no longer fires", async () => {
  const d = seed(C);
  clock.skip(cards.DIGEST_TTL_MS - 1000);
  assert.equal((await get(`/a/${d.token}`)).status, 200, "still good a moment before");
  clock.skip(2000);
  const v = cards.viewByToken(d.token, { now: clock.now() });
  assert.equal(v.gone, true);
  const res = await get(`/a/${d.token}`);
  assert.equal(res.status, 410);
  assert.match(res.body, GONE_WORDS);
  assert.doesNotMatch(res.body, /Anthropic/);
  assert.equal((await post(`/a/${d.token}/dismiss/${d.cards[0].code}`)).status, 410);
  assert.equal(cards.matchInbound(C, [SAMPLE_CARDS[0].prefill], { now: clock.now() }), null, "an old card is not matched");
  assert.deepEqual(cards.openCards(C, { now: clock.now() }), []);
  page.setActionCardShooter(async () => Buffer.from("never"));
  const og = await page.actionCardsOgRequest(page.ogImagePath(d.token), { now: clock.now() });
  assert.equal(og.status, 200);
  assert.equal(og.body.subarray(1, 4).toString(), "PNG", "the generic card, not nothing: an old thread's preview still shows a picture");
});

test("a digest closes the moment its last card is handled: the link is gone", async () => {
  const d = seed(C);
  cards.dismiss(d.id, d.cards[0].code);
  cards.markDone(d.cards[1].id, C);
  assert.equal(cards.digestById(d.id).gone, false);
  const last = await post(`/a/${d.token}/dismiss/${d.cards[2].code}`);
  assert.equal(last.status, 200);
  assert.deepEqual(JSON.parse(last.body), { ok: true, status: "dismissed", open: 0, gone: true });
  assert.ok(cards.digestById(d.id).closedAt);
  assert.equal((await get(`/a/${d.token}`)).status, 410);
});

// ---------- 3. the page ----------

test("the note: date eyebrow, headline, three cards numbered 01/03.., a drawing each, Reply in their own voice, the signature; no card id in any body", async () => {
  const d = seed(C);
  const res = await page.actionCardsRequest({ method: "GET", path: `/a/${d.token}`, now: Date.parse("2026-11-11T12:34:00Z") });
  assert.equal(res.status, 200);
  assert.match(res.headers["Content-Type"], /text\/html/);
  assert.equal(res.headers["Cache-Control"], "no-store");
  const html = res.body;
  assert.match(html, /<p class="eb">WEDNESDAY · NOV 11<span id="openct"><\/span><\/p>/);
  assert.match(html, /<h1 id="h1">Three things I can take off your plate\.<\/h1>/);
  assert.deepEqual(eyebrows(html), ["01 / 03 · REPLACE", "02 / 03 · PLAN", "03 / 03 · DIAGNOSE"]);
  for (const c of SAMPLE_CARDS) {
    assert.ok(html.includes(`<h2>${c.title}</h2>`), c.title);
    assert.ok(html.includes(`~&gt; ${c.whyNow}`), "the margin note");
    assert.ok(html.includes(`href="sms:+14155550199&amp;body=${encodeURIComponent(c.prefill)}" data-sms>Reply</a>`), `Reply opens Messages with "${c.prefill}" typed`);
  }
  assert.equal((html.match(/<svg class="art"/g) ?? []).length, 3, "a drawing per card");
  assert.match(html, /~&gt; tap one and I'll start/);
  assert.match(html, /aria-label="reason"/, "the wordmark");
  const bodies = [...html.matchAll(/body=([^"]*)"/g)].map(m => decodeURIComponent(m[1]));
  assert.deepEqual(bodies, SAMPLE_CARDS.map(c => c.prefill), "each body is exactly the prefill: no card id, no code, no wrapper");
  for (const c of d.cards) assert.ok(html.includes(`data-code="${c.code}"`), "the code is on the element for the posts");
  assert.doesNotMatch(html, /dm:fake|\+14155550100|Kofi/, "nothing about the person on the page");
  assert.equal(cards.counts(d.cards[0].id, C).view, 0, "views are per digest, not per card");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM action_card_events WHERE digest_id = ? AND kind = 'view'").get(d.id).n, 1);
});

test("the link card: og:title Ready for you, site name, a 1200×630 picture per token and state on heyreason.com, no og:url", async () => {
  const d = seed(C);
  const html = (await get(`/a/${d.token}`)).body;
  assert.equal(tag(html, "og:title"), "Ready for you");
  assert.equal(tag(html, "og:site_name"), "Reason");
  assert.equal(tag(html, "og:image:width"), "1200");
  assert.equal(tag(html, "og:image:height"), "630");
  assert.equal(tag(html, "twitter:card"), "summary_large_image");
  assert.doesNotMatch(html, /og:url/);
  const img = new URL(tag(html, "og:image"));
  assert.equal(img.origin, "https://heyreason.com");
  assert.equal(img.pathname, `/web/og/a/${d.token}.png`);
  const v1 = img.searchParams.get("v");
  cards.dismiss(d.id, d.cards[2].code);
  const v2 = new URL(tag((await get(`/a/${d.token}`)).body, "og:image")).searchParams.get("v");
  assert.notEqual(v1, v2, "a change of state changes the picture's address");
  assert.doesNotMatch(tag(html, "og:image:alt"), /Anthropic/, "the alt names no card");
});

test("the sms: address: Apple's form by default, Android's on request, the number from the line, body URL-encoded; none without a number", () => {
  assert.equal(cards.reasonNumber(), "+14155550199");
  assert.equal(cards.smsHref("Plan my birthday dinner for Tue, Nov 24"), "sms:+14155550199&body=Plan%20my%20birthday%20dinner%20for%20Tue%2C%20Nov%2024");
  assert.equal(cards.smsHref("hi & bye", { apple: false }), "sms:+14155550199?body=hi%20%26%20bye");
  assert.equal(cards.smsHref("x", { number: "" }), "");
});

test("words: the headline for every count, the eyebrow date in the person's zone, titles shortened on whole words", () => {
  assert.equal(page.headline1(3), "Three things I can take off your plate.");
  assert.equal(page.headline1(1), "One thing I can take off your plate.");
  assert.equal(page.headline1(4), "Four things I can take off your plate.");
  assert.equal(page.headline1(0), "Nothing left on this note.");
  const t = Date.parse("2026-11-11T03:30:00Z");
  assert.equal(page.dateEyebrow(t, "America/New_York"), "TUESDAY · NOV 10");
  assert.equal(page.dateEyebrow(t, "Europe/London"), "WEDNESDAY · NOV 11");
  assert.equal(page.shorten("Find out why your server went down 6 times last night", 56), "Find out why your server went down 6 times last night");
  assert.equal(page.shorten("Find out why your server went down 6 times last night and what to do about it", 56), "Find out why your server went down 6 times last night…");
  assert.ok(page.shorten("a".repeat(100), 20).length <= 20);
});

test("drawings: the three from the mockups and a fallback; an unknown key never leaves a card without a picture", () => {
  for (const k of ["key", "cake", "server", "note"]) assert.ok(DRAW[k]?.length, k);
  assert.match(art("key", 1), /<svg class="art"/);
  assert.match(art("key", 1), /#9c3b2e/, "the pen is the brand red");
  assert.equal(art("no-such-thing", 2).includes(DRAW.note[0]), true);
  assert.notEqual(art("key", 1), art("key", 2), "the wobble differs by seed");
  assert.doesNotMatch(Object.values(DRAW).flat().join(""), /<image|href=/, "drawings, not logos: no pictures pulled in");
});

// ---------- 4. dismiss and done ----------

test("dismiss: no confirm, recorded at once, gone on reload, the others renumber 01/02 02/02, the title remembered; twice is once", async () => {
  const d = seed(C);
  const res = await post(`/a/${d.token}/dismiss/${d.cards[1].code}`);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, status: "dismissed", open: 2, gone: false });
  const after = cards.digestById(d.id);
  assert.deepEqual(after.cards.map(c => c.status), ["open", "dismissed", "open"]);
  assert.ok(after.cards[1].resolvedAt);
  const html = (await get(`/a/${d.token}`)).body;
  assert.deepEqual(eyebrows(html), ["01 / 02 · REPLACE", "02 / 02 · DIAGNOSE"], "renumbered");
  assert.doesNotMatch(html, /birthday dinner/, "the struck card is off the note");
  assert.match(html, /<h1 id="h1">Two things I can take off your plate\.<\/h1>/);
  assert.match(html, /<span id="openct"><\/span>/, "no OPEN count: everything on it is open");
  // Remembered for the engine.
  assert.equal(cards.wasDismissed(C, "Plan your birthday dinner for Tue, Nov 24"), true);
  assert.equal(cards.wasDismissed(C, "plan your birthday dinner for tue nov 24!"), true, "as good as the same title");
  assert.equal(cards.wasDismissed(C, "Replace your Anthropic key before it expires Nov 18"), false);
  assert.equal(cards.wasDismissed(config.ownerConversation, "Plan your birthday dinner for Tue, Nov 24"), false, "per person");
  assert.deepEqual(cards.dismissedTitles(C), ["Plan your birthday dinner for Tue, Nov 24"]);
  // Again: one strike, one event, nothing else moves.
  assert.equal((await post(`/a/${d.token}/dismiss/${d.cards[1].code}`)).status, 200);
  assert.equal(cards.counts(d.cards[1].id, C).dismiss, 1);
  assert.equal(cards.digestById(d.id).gone, false);
  // An unknown code: nothing.
  assert.equal((await post(`/a/${d.token}/dismiss/zzzzzzzz`)).status, 404);
  assert.equal((await post(`/a/${d.token}/dismiss/${d.cards[0].code.toUpperCase()}`)).status, 404);
});

test("done sinks: a finished card sits below the open ones with the pen check and 'done'; the eyebrow says 2 OPEN; the headline keeps the count", async () => {
  const d = seed(C);
  cards.markDone(d.cards[0].id, C);
  const html = (await get(`/a/${d.token}`)).body;
  const order = liOrder(html);
  assert.deepEqual(order.map(o => o.title), [SAMPLE_CARDS[1].title, SAMPLE_CARDS[2].title, `${SAMPLE_CARDS[0].title} (done)`]);
  assert.deepEqual(order.map(o => o.cls), ["card", "card", "card done"]);
  assert.deepEqual(eyebrows(html), ["01 / 03 · PLAN", "02 / 03 · DIAGNOSE", "03 / 03 · REPLACE"]);
  assert.match(html, /<span id="openct"> · <b>2 OPEN<\/b><\/span>/);
  assert.match(html, /<h1 id="h1">Three things I can take off your plate\.<\/h1>/);
  assert.match(html, /<svg class="check"/);
  assert.match(html, /<span class="donew">done<\/span>/);
  // A done card has no Reply, no Dismiss, no strike.
  const doneLi = html.slice(html.indexOf('class="card done"'), html.indexOf("</ol>"));
  assert.doesNotMatch(doneLi, /data-sms|class="dis"|class="strike"/);
  // Dismissing a done card is refused quietly; marking it done again changes nothing.
  cards.dismiss(d.id, d.cards[0].code);
  assert.equal(cards.digestById(d.id).cards[0].status, "done");
  cards.markDone(d.cards[0].id, C);
  assert.equal(cards.counts(d.cards[0].id, C).done, 1);
});

// ---------- 5. the match ----------

test("the match: the prefill scores 1, small edits stay above 0.75, a text that merely shares a subject stays below; you/your reads as I/my", () => {
  const d = seed(C);
  const key = cards.openCards(C)[0];
  assert.equal(key.title, SAMPLE_CARDS[0].title);
  const s = (t) => cards.scoreAgainst(t, key);
  assert.equal(s("Replace my Anthropic key before it expires Nov 18"), 1);
  assert.equal(s("replace my anthropic key before it expires nov 18!"), 1, "case and punctuation do not matter");
  assert.equal(s("hey, Replace my Anthropic key before it expires Nov 18 please"), 1, "contains the whole prefill");
  assert.ok(s("Replace my Anthropic key before it expires Nov 18 please") >= cards.MATCH_THRESHOLD);
  assert.ok(s("replace my anthropic key before nov 18") >= cards.MATCH_THRESHOLD, "two words dropped");
  assert.ok(s("Replace your Anthropic key before it expires Nov 18") >= cards.MATCH_THRESHOLD, "the title as written, pronoun swapped");
  assert.ok(s("what about my key") < cards.MATCH_THRESHOLD);
  assert.ok(s("plan my birthday dinner for tue nov 24") < cards.MATCH_THRESHOLD, "another card's words");
  assert.ok(s("yes do the first one") < cards.MATCH_THRESHOLD);
  assert.equal(s(""), 0);
  assert.equal(cards.MATCH_THRESHOLD, 0.75);
  // The best open card wins; the right one per text.
  assert.equal(cards.matchInbound(C, ["plan my birthday dinner for tue nov 24"]).card.id, d.cards[1].id);
  assert.equal(cards.matchInbound(C, ["Find out why my server went down 6 times last night"]).card.id, d.cards[2].id);
  assert.equal(cards.matchInbound(C, ["can you book me a table"]), null);
  assert.equal(cards.matchInbound(config.ownerConversation, [SAMPLE_CARDS[0].prefill]), null, "another person's text never matches this person's card");
  // Only open cards: a dismissed one is not answered.
  cards.dismiss(d.id, d.cards[1].code);
  assert.equal(cards.matchInbound(C, ["plan my birthday dinner for tue nov 24"]), null);
});

function harness() {
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "on it"; } });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { router, channel, turns };
}
const text = (from, body) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now() });

test("a text in a card's words runs as the normal turn, as it is; the card is done once the turn replied; the log has reply and done", async () => {
  const h = harness();
  const num = newNumber();
  await h.router.deliver(text(num, "hi"));
  assert.equal(h.turns.length, 1);
  const d = seed(conv(num));
  await h.router.deliver(text(num, "Replace my Anthropic key before it expires Nov 18"));
  assert.equal(h.turns.length, 2);
  assert.equal(h.turns[1].conversationId, conv(num));
  assert.match(h.turns[1].text, /Replace my Anthropic key before it expires Nov 18/, "the turn reads the request itself");
  assert.doesNotMatch(h.turns[1].text, /card|digest/i, "no wrapper, no id");
  const after = cards.digestById(d.id);
  assert.deepEqual(after.cards.map(c => c.status), ["done", "open", "open"]);
  assert.deepEqual(cards.counts(d.cards[0].id, conv(num)), { view: 0, tap: 0, reply: 1, dismiss: 0, done: 1 });
  // An unrelated text leaves the others alone.
  await h.router.deliver(text(num, "what's the weather"));
  assert.deepEqual(cards.digestById(d.id).cards.map(c => c.status), ["done", "open", "open"]);
  assert.equal(cards.counts(d.cards[1].id, conv(num)).reply, 0);
  // The page now shows it done, under the open ones.
  const html = (await get(`/a/${d.token}`)).body;
  assert.deepEqual(liOrder(html).map(o => o.cls), ["card", "card", "card done"]);
});

test("a turn that fails leaves the card open (replied, not done)", async () => {
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ text: t }) => { turns.push(t); throw new Error("model fell over"); } });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  const num = newNumber();
  await router.deliver(text(num, "hi"));
  const d = seed(conv(num));
  await router.deliver(text(num, "Plan my birthday dinner for Tue, Nov 24"));
  assert.equal(turns.length, 2);
  // The stall line went, so the turn "replied" something — but a failed turn is not the task done.
  const c = cards.digestById(d.id).cards[1];
  assert.equal(cards.counts(c.id, conv(num)).reply, 1);
  assert.equal(c.status, "open", "the stall line is not the task done");
  assert.equal(cards.counts(c.id, conv(num)).done, 0);
});

// ---------- 6. the log ----------

test("the log: a view per open, a tap when the page says so, each per card", async () => {
  const d = seed(C);
  await get(`/a/${d.token}`);
  await get(`/a/${d.token}`);
  // Neither a HEAD nor iMessage's own preview fetch (Apple's LinkPresentation says facebookexternalhit) is a view.
  assert.equal((await get(`/a/${d.token}`, "HEAD")).status, 200);
  assert.equal((await page.actionCardsRequest({ method: "GET", path: `/a/${d.token}`, headers: { "user-agent": "facebookexternalhit/1.1 Facebot Twitterbot/1.0" } })).status, 200);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM action_card_events WHERE digest_id = ? AND kind = 'view'").get(d.id).n, 2);
  assert.equal((await post(`/a/${d.token}/tap/${d.cards[0].code}`)).status, 200);
  assert.equal((await post(`/a/${d.token}/tap/${d.cards[0].code}`)).status, 200);
  assert.equal((await post(`/a/${d.token}/tap/nopenope`)).status, 404);
  assert.deepEqual(cards.counts(d.cards[0].id, C), { view: 0, tap: 2, reply: 0, dismiss: 0, done: 0 });
  assert.equal((await get(`/a/${d.token}/tap/${d.cards[0].code}`)).status, 405, "a GET is not a tap");
  assert.equal((await get(`/a/${d.token}`, "POST")).status, 405);
});

// ---------- 7. the picture ----------

test("the picture: drawn once per state and kept, served as PNG with the right headers; ≤4 cards, titles shortened, nothing of the person", async () => {
  const d = cards.createDigest(C, [
    ...SAMPLE_CARDS,
    { verb: "RENEW", title: "Renew your passport before the trip in March: the appointment slots in the city go six weeks out", prefill: "Renew my passport before the trip in March", drawing: "calendar" },
    { verb: "EXTRA", title: "A fifth card that never shows", prefill: "Fifth", drawing: "note" },
  ]);
  assert.equal(d.cards.length, 4, "never more than MAX_CARDS");
  const shots = [];
  page.setActionCardShooter(async (html) => { shots.push(html); return Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array(20).fill(1)]); });
  const res = await page.actionCardsOgRequest(page.ogImagePath(d.token));
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "image/png");
  assert.match(res.headers["Cache-Control"], /max-age=3600/);
  assert.equal(res.body.subarray(1, 4).toString(), "PNG");
  assert.equal(shots.length, 1);
  const html = shots[0];
  assert.equal((html.match(/class="mini/g) ?? []).length, 4);
  assert.match(html, /Four things I can take off your plate\./);
  assert.match(html, /Renew your passport before the trip in March[^<]*…/, "the long title is cut");
  assert.doesNotMatch(html, /fifth card/i);
  assert.doesNotMatch(html, /Kofi|\+1415|dm:fake/);
  assert.match(html, /<b>01<\/b> \/ 04 · REPLACE/);
  // Again: from disk, no second drawing.
  await page.actionCardsOgRequest(page.ogImagePath(d.token));
  assert.equal(shots.length, 1);
  assert.equal(readdirSync(join(dir, "cards")).filter(f => f.startsWith("action-")).length, 1);
  // A change of state: drawn again, the done card below with its check, the eyebrow 3 OPEN.
  cards.markDone(d.cards[0].id, C);
  await page.actionCardsOgRequest(page.ogImagePath(d.token));
  assert.equal(shots.length, 2);
  assert.match(shots[1], /<b>3 OPEN<\/b>/);
  assert.match(shots[1], /class="mini done"/);
  assert.ok(shots[1].indexOf("Renew your passport") < shots[1].indexOf("Anthropic key"), "the done card sinks");
  // Not one of ours: nothing.
  assert.equal(await page.actionCardsOgRequest("/web/og/a/nonsense.png"), null);
  assert.equal(await page.actionCardsOgRequest(`/web/og/a/${d.token}.jpg`), null);
  assert.equal(await page.actionCardsOgRequest(`/web/og/secured/approve.png`), null);
});

test("the picture cannot be drawn: the generic card goes out, the link never breaks", async () => {
  const d = seed(C);
  page.setActionCardShooter(async () => { throw new Error("no chromium"); });
  const res = await page.actionCardsOgRequest(page.ogImagePath(d.token));
  assert.equal(res.status, 200);
  assert.equal(res.body.subarray(1, 4).toString(), "PNG");
  assert.equal(existsSync(join(dir, "cards")) && readdirSync(join(dir, "cards")).some(f => f.includes(d.id)), false, "nothing wrong is kept");
});

// ---------- 8. the seed ----------

test("the seed script: three fictional cards, the mockups' words, for any account", () => {
  assert.equal(SAMPLE_CARDS.length, 3);
  assert.deepEqual(SAMPLE_CARDS.map(c => c.drawing), ["key", "cake", "server"]);
  for (const c of SAMPLE_CARDS) assert.match(c.prefill, /\bmy\b/, "first person");
  const d = seed(config.ownerConversation, { ttlMs: 3_600_000 });
  assert.equal(d.conversationId, config.ownerConversation);
  assert.equal(d.expiresAt - d.createdAt, 3_600_000);
  assert.throws(() => cards.createDigest(C, []), /at least one card/);
  assert.throws(() => cards.createDigest(C, [{ title: "no prefill" }]), /at least one card/);
});

// ---------- 9. in a browser ----------

test("in a real browser: a tap goes to the sms: link; press-and-hold shows the note; Dismiss strikes, fades and renumbers; done sits below", { timeout: 60_000 }, async (t) => {
  let chromium, browser;
  try { ({ chromium } = await import("playwright")); browser = await chromium.launch(); }
  catch (e) { t.skip(`no browser here: ${(e?.message ?? e).split("\n")[0]}`); return; }
  try {
    const d = seed(C);
    cards.markDone(d.cards[2].id, C);
    const html = (await get(`/a/${d.token}`)).body;
    const posted = [];
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", hasTouch: true, isMobile: true });
    await ctx.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (route.request().method() === "POST") { posted.push(u.pathname); return route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); }
      if (u.pathname === `/a/${d.token}`) return route.fulfill({ status: 200, contentType: "text/html", body: html });
      return route.fulfill({ status: 404, body: "" });
    });
    const p = await ctx.newPage();
    const navs = [];
    p.on("framenavigated", f => navs.push(f.url()));
    await p.goto(`https://heyreason.com/a/${d.token}`);
    const ebs = async () => p.$$eval("#cards .card .eb", els => els.map(e => e.textContent));
    assert.deepEqual(await ebs(), ["01 / 03 · REPLACE", "02 / 03 · PLAN", "03 / 03 · DIAGNOSE"]);
    assert.deepEqual(await p.$$eval("#cards .card", els => els.map(e => e.className)), ["card", "card", "card done"], "done below the open ones");
    assert.equal(await p.textContent("#openct"), " · 2 OPEN");
    // The sms: form stays Apple's on an iPhone.
    assert.match(await p.getAttribute("#cards .card a[data-sms]", "href"), /^sms:\+14155550199&body=/);
    // Press and hold the second card: it lifts and shows why-now with Reply / Dismiss.
    const second = p.locator("#cards .card").nth(1);
    const box = await second.boundingBox();
    await p.mouse.move(box.x + 60, box.y + 30); await p.mouse.down(); await p.waitForTimeout(600); await p.mouse.up();
    assert.ok(await second.evaluate(e => e.classList.contains("lift")));
    assert.match(await second.locator(".why").textContent(), /calendar shows the day/);
    // Dismiss it: the pen line, then it is gone and the others renumber.
    await second.locator("a.dis").click();
    assert.ok(await second.evaluate(e => e.classList.contains("struck")));
    await p.waitForTimeout(1500);
    assert.deepEqual(await ebs(), ["01 / 02 · REPLACE", "02 / 02 · DIAGNOSE"], "renumbered after the dismiss");
    assert.equal(await p.textContent("#h1"), "Two things I can take off your plate.");
    assert.equal(await p.textContent("#openct"), " · 1 OPEN");
    assert.ok(posted.some(x => x === `/a/${d.token}/dismiss/${d.cards[1].code}`), "the dismiss was posted");
    // A plain tap on the first card: a tap is posted and the page goes to the sms: link.
    const first = p.locator("#cards .card").first();
    await first.click();
    await p.waitForTimeout(300);
    assert.ok(posted.some(x => x === `/a/${d.token}/tap/${d.cards[0].code}`), "the tap was posted");
    await ctx.close();
    // Android: the ? form.
    const ctx2 = await browser.newContext({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" });
    await ctx2.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    const p2 = await ctx2.newPage();
    await p2.goto(`https://heyreason.com/a/${d.token}`);
    assert.match(await p2.getAttribute("#cards .card a[data-sms]", "href"), /^sms:\+14155550199\?body=/);
    await ctx2.close();
  } finally {
    await browser.close().catch(() => {});
  }
});
