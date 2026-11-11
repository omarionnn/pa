// The welcome gallery (src/welcome.js, REASON_WELCOME_CARDS), through the real router, outbox and
// database: seven picture cards, each its own message, in order, between the intro line and the
// question.
//
//   web setup → "hey kofi, Jarvis here…" → 7 cards → "What would you like help with first?";
//               their first reply → the normal turn → THEN the contact card (+ Amazon offer)
//   texted first → who Reason is → 7 cards → what's your name? → … → card → Amazon offer or
//               "What would you like help with first?" in place of the try line
//   a card that cannot go → its text line in its place; no files at all → seven lines
//   a restart mid-way finishes the chain, never repeats; off/owner → nothing changes
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-welcome-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_TOKEN_KEY = "44".repeat(32);
delete process.env.REASON_ONBOARDING;

const ob = await import("../src/onboarding.js");
const welcome = await import("../src/welcome.js");
const ws = await import("../src/websetup.js");
const amazon = await import("../src/amazonconnect.js");
const outbox = await import("../src/outbox.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const remote = await import("../src/signin-remote.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const LINE = "+16562167455";
let n = 0;
const newNumber = () => `+1415558${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  remote.forgetAllRemoteSignins();
  ws.resetLimits();
  ws.forgetNameLines();
  process.env.REASON_WELCOME_CARDS = "on";
  process.env.REASON_INTRO_AMAZON = "on";
  process.env.REASON_WEB_SETUP = "on";
  config.autoAdmit = true;
  config.onboarding = "on";
  config.onboardingNumbers = [];
  config.onboardingNudgeMin = 240;
  config.publicUrl = "https://reason.example.test";
  config.onboardingCardGapMs = 0;
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM timers; DELETE FROM web_setups;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

function harness(reads = {}, channelOpts = {}) {
  const turns = [], asked = [], gaps = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "on it"; } });
  const ask = async ({ prompt }) => {
    const said = prompt.replace(/^Their text, verbatim:\n/, "");
    asked.push(said);
    const r = reads[said];
    if (!r) return { error: "no stated read" };
    return { value: { name: "", card_name: "", reply: "", name_line: "", amazon: "", ...r } };
  };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async (ms) => { gaps.push(ms); }, amazonLink: async () => "https://x.test/s/link" } });
  const channel = router.register(new FakeChannel({ number: LINE, ...channelOpts }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { router, channel, turns, asked, gaps };
}
const text = (from, body) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now() });
const to = (h, num) => h.channel.sent.filter(m => m.to === num);
const show = (m) => m.carousel ? `[carousel ${m.carousel.length}]` : m.media?.file ? `[picture ${m.media.filename}]` : m.media?.url ? `${m.text} [card]` : m.text;
const PICS = welcome.CARDS.map(c => `[picture ${c.key}.jpg]`);
const LINES = welcome.CARDS.map(welcome.textLine);

async function api(method, path, { cookie = "", body = null } = {}) {
  const res = await ws.request({ method, path, query: {}, headers: { cookie: cookie ? `rs_setup=${cookie}` : "", host: "reason.example.test" }, remoteAddress: "1.2.3.4", readBody: async () => body ? JSON.stringify(body) : "" });
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}
async function newSetup(names = { user: "kofi", reasonName: "jarvis" }) {
  const made = await api("POST", "/api/new");
  const cookie = /rs_setup=([^;]+)/.exec(String(made.headers["Set-Cookie"] ?? ""))?.[1];
  await api("POST", `/api/${made.json.id}`, { cookie, body: names });
  return { ...made.json, cookie };
}

// ---------- the cards themselves ----------

test("seven cards, in the agreed order, each a small JPEG on disk with a title and one request", () => {
  assert.deepEqual(welcome.CARDS.map(c => c.key), ["calls", "events", "reminders", "shopping", "food", "booking", "more"]);
  for (const c of welcome.CARDS) {
    assert.ok(existsSync(c.file), c.file);
    assert.ok(statSync(c.file).size < 250_000, `${c.key} is small enough to send fast`);
    assert.ok(c.title && c.example);
  }
  assert.equal(welcome.eyebrowOf(welcome.CARDS[0]), "01 / 07 · CALLS");
  assert.equal(welcome.textLine(welcome.CARDS[0]), 'Calls: "Call my dentist and move my cleaning to next week."');
  assert.ok(!welcome.CARDS.some(c => /message|inbox|email|whatsapp/i.test(`${c.title} ${c.example}`)), "no card promises reading their messages or inbox");
});

test("the switch: off by default, owner, on", () => {
  delete process.env.REASON_WELCOME_CARDS;
  assert.equal(welcome.mode(), "off");
  process.env.REASON_WELCOME_CARDS = "owner";
  assert.equal(welcome.mode(), "owner");
  assert.equal(welcome.forEveryone(), false);
  process.env.REASON_WELCOME_CARDS = "on";
  assert.equal(welcome.forEveryone(), true);
});

// ---------- web setup ----------

test("web setup: the intro line from the page, the seven pictures in order, the question; no card yet, no read, no turn", async () => {
  const h = harness();
  const num = newNumber();
  const s = await newSetup();
  const out = await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.equal(out.onboarding, "awaiting_first");
  assert.deepEqual(to(h, num).map(show), ["hey kofi, Jarvis here. picking up from your setup, here's what i can do for you", ...PICS, welcome.HELP_FIRST]);
  assert.equal(h.asked.length, 0);
  assert.equal(h.turns.length, 0);
  assert.equal(db.getAccount(conv(num)).welcome_cards, "web");
  assert.equal(db.getAccount(conv(num)).contact_card_sent_at, null, "the contact card waits for their first reply");
  // The cards go back to back; the lines around them a beat apart.
  assert.deepEqual(h.gaps.slice(1, 7), Array(6).fill(config.onboardingCardGapMs));
  // The model's history says what went, picture by picture.
  assert.match(JSON.stringify(db.loadConversation(conv(num))), /\[picture card\] Calls: /);
});

test("web setup: their first reply gets the normal turn, THEN the card under the page's name and the Amazon offer", async () => {
  const h = harness({ "no thanks": { kind: "decline", amazon: "no" } });
  const num = newNumber();
  const s = await newSetup();
  await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  const before = to(h, num).length;
  const out = await h.router.deliver(text(num, "book a table for two friday at 8"));
  assert.equal(h.turns.length, 1, "their ask is answered by the turn");
  const after = to(h, num).slice(before).map(show);
  assert.deepEqual(after, ["on it", `${ob.WEB_CARD} [card]`, amazon.OFFER]);
  assert.equal(db.getAccount(conv(num)).contact_card_name, "Jarvis");
  assert.equal(db.getAccount(conv(num)).onboarding, "awaiting_amazon");
  // A no: no worries, and no question again (they were already asked it).
  const b2 = to(h, num).length;
  await h.router.deliver(text(num, "no thanks"));
  assert.deepEqual(to(h, num).slice(b2).map(show), [amazon.NO_LINE]);
  assert.equal(db.getAccount(conv(num)).onboarding, "complete");
  assert.ok(out);
});

test("web setup with the switch off: the hand-off as before (hello, card, offer)", async () => {
  process.env.REASON_WELCOME_CARDS = "off";
  const h = harness();
  const num = newNumber();
  const s = await newSetup();
  await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.deepEqual(to(h, num).map(show), [ob.WEB_HELLO("kofi"), `${ob.WEB_CARD} [card]`, amazon.OFFER]);
  assert.equal(db.getAccount(conv(num)).welcome_cards, null);
});

// ---------- texted first ----------

test("texted first: who Reason is, the seven pictures, their name asked; the rest of the intro unchanged, the question at the end", async () => {
  process.env.REASON_INTRO_AMAZON = "off";
  const h = harness({ hey: { kind: "greeting" }, kofi: { kind: "answer", name: "Kofi", name_line: "kofi, born on a friday. good start." }, jarvis: { kind: "answer", card_name: "Jarvis" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, ...PICS, ob.NAME_Q]);
  assert.equal(db.getAccount(conv(num)).welcome_cards, "direct");
  await h.router.deliver(text(num, "kofi"));
  assert.deepEqual(to(h, num).slice(9).map(show), ["kofi, born on a friday. good start.", ob.CARD_NAME_ASK]);
  await h.router.deliver(text(num, "jarvis"));
  assert.deepEqual(to(h, num).slice(11).map(show), [`${ob.CARD_SENT("Jarvis", true)} [card]`, welcome.HELP_FIRST]);
  assert.equal(db.getAccount(conv(num)).onboarding, "complete");
  assert.equal(to(h, num).filter(m => m.media?.file).length, 7, "the cards went once");
});

test("texted first with Amazon on: the card, then the Amazon offer; a yes ends on the question, not the old try line", async () => {
  const h = harness({ hey: { kind: "greeting" }, kofi: { kind: "answer", name: "Kofi" }, jarvis: { kind: "answer", card_name: "Jarvis" }, sure: { kind: "answer", amazon: "yes" } });
  const num = newNumber();
  for (const t of ["hey", "kofi", "jarvis"]) await h.router.deliver(text(num, t));
  assert.equal(to(h, num).at(-1).text, amazon.OFFER);
  const b = to(h, num).length;
  await h.router.deliver(text(num, "sure"));
  assert.deepEqual(to(h, num).slice(b).map(show), [amazon.LINK_LINE, "https://x.test/s/link", welcome.HELP_FIRST]);
});

test("a request as the very first text: the turn, then by-the-way, the pictures, the name ask", async () => {
  const h = harness({ "remind me to call mom at 5": { kind: "task" } });
  const num = newNumber();
  await h.router.deliver(text(num, "remind me to call mom at 5"));
  assert.deepEqual(to(h, num).map(show), ["on it", ob.BY_THE_WAY, ...PICS, ob.NAME_Q]);
});

test("switch off (or owner): the intro exactly as before, no pictures", async () => {
  for (const m of ["off", "owner"]) {
    process.env.REASON_WELCOME_CARDS = m;
    const h = harness({ hey: { kind: "greeting" } });
    const num = newNumber();
    await h.router.deliver(text(num, "hey"));
    assert.deepEqual(to(h, num).map(show), ob.OPENER);
  }
});

// ---------- delivery ----------

test("a card that cannot go for good goes as its text line, in its place; the rest of the set follows in order", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  // The third picture is refused (not retryable): its line stands in for it.
  const real = h.channel.sendMedia.bind(h.channel);
  h.channel.sendMedia = async (a) => a.filename === "reminders.jpg" ? { ok: false, supported: true, error: "Sendblue would not take the file (HTTP 400): bad" } : real(a);
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const want = [ob.INTRO, ...PICS, ob.NAME_Q];
  want[3] = LINES[2];
  assert.deepEqual(to(h, num).map(show), want);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'failed'").get().n, 0, "nothing failed, nothing behind it died");
});

test("a channel that cannot carry files: all seven as text lines, in order", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  Object.defineProperty(h.channel, "carriesFiles", { get: () => false });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, ...LINES, ob.NAME_Q]);
});

test("a send that stops mid-way (a retryable failure, a restart): the outbox finishes the set in order, never repeats one", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  const real = h.channel.sendMedia.bind(h.channel);
  let down = true;
  h.channel.sendMedia = async (a) => down && a.filename === "shopping.jpg" ? { ok: false, supported: true, retryable: true, error: "HTTP 503" } : real(a);
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, ...PICS.slice(0, 3)], "held at the fourth card");
  // Later (as after a restart): the sweep sends the rest, in order, once each.
  down = false;
  clock.skip(10 * 60_000);
  for (let i = 0; i < 12; i++) await outbox.pass({ router: h.router });
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, ...PICS, ob.NAME_Q]);
  // The same step again (a replay of the same text) queues nothing twice.
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE conversation_id = ?").get(conv(num)).n, 9);
});

test("never twice, never to existing people: an account that already had them, or that was never in the flow, gets none", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  const num = newNumber();
  db.upsertAccount({ conversationId: conv(num), channel: "fake", address: num, name: "Old" });
  db.setOnboarding(conv(num), { state: "complete" });
  await h.router.deliver(text(num, "hey"));
  assert.equal(to(h, num).filter(m => m.media?.file).length, 0);
});

test("the process stops while a card is being sent: that card goes as its line, the rest of the set and the question still follow", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  const real = h.channel.sendMedia.bind(h.channel);
  // The fourth card's send never comes back (the process "stops" mid-send): its row stays 'sending'.
  let crash = true;
  h.channel.sendMedia = (a) => crash && a.filename === "shopping.jpg" ? new Promise(() => {}) : real(a);
  const num = newNumber();
  void h.router.deliver(text(num, "hey"));
  for (let i = 0; i < 50 && to(h, num).length < 4; i++) await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, ...PICS.slice(0, 3)]);
  // Restart: the stranded row is unknown; the sweep resolves it as its line and finishes the chain.
  crash = false;
  outbox.recoverStranded({});
  for (let i = 0; i < 12; i++) await outbox.pass({ router: h.router });
  const want = [ob.INTRO, ...PICS, ob.NAME_Q];
  want[4] = LINES[3];
  assert.deepEqual(to(h, num).map(show), want);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'failed'").get().n, 0);
});

test("a reply while the gallery is still held: its answer waits behind the rest, never lands in the middle", async () => {
  const h = harness({ hey: { kind: "greeting" }, kofi: { kind: "answer", name: "Kofi" } });
  const real = h.channel.sendMedia.bind(h.channel);
  let down = true;
  h.channel.sendMedia = async (a) => down && a.filename === "food.jpg" ? { ok: false, supported: true, retryable: true, error: "HTTP 429" } : real(a);
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "kofi"));
  assert.equal(to(h, num).length, 5, "nothing more until the held card goes");
  down = false;
  clock.skip(10 * 60_000);
  for (let i = 0; i < 15; i++) await outbox.pass({ router: h.router });
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, ...PICS, ob.NAME_Q, ob.MET("Kofi"), ob.CARD_NAME_ASK]);
});

// ---------- the carousel (owner, 2026-11-11: one swipeable stack, not seven pictures down the thread) ----------

/** A channel with Sendblue's carousel: `fail` decides each try's answer. */
function withCarousel(h, fail = () => null) {
  const tries = [];
  h.channel.sendCarousel = async ({ to, mediaUrls }) => {
    tries.push(mediaUrls);
    const f = fail(tries.length);
    if (f) return { ok: false, supported: true, ...f };
    const delivered = { channel: "fake", to, text: "", carousel: mediaUrls, at: clock.now() };
    h.channel.sent.push(delivered);
    return { ok: true, supported: true, delivered };
  };
  return tries;
}
const V1 = { retryable: false, error: "Carousel messaging is only available on V2 lines" };

test("carousel: the intro, ONE message carrying all seven cards in order, then the question", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  const tries = withCarousel(h);
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, "[carousel 7]", ob.NAME_Q]);
  assert.deepEqual(tries[0].map(u => u.split("/").pop()), welcome.CARDS.map(c => c.file.split("/").pop()));
  assert.ok(tries[0].every(u => /^https:\/\/reason\.example\.test\/img\/welcome\/[0-9a-f]{8}\/\d\d-[a-z]+\.jpg$/.test(u)));
  // Each address really serves its card.
  const { assetRequest } = await import("../src/http.js");
  const got = assetRequest({ pathname: new URL(tries[0][4]).pathname });
  assert.equal(got.status, 200);
  assert.equal(got.headers["Content-Type"], "image/jpeg");
  assert.equal(assetRequest({ pathname: "/img/welcome/00000000/99-nope.jpg" }), null);
  assert.equal(assetRequest({ pathname: "/img/welcome/00000000/01-calls.jpg" }), null, "an old version is not today's card");
  assert.equal(assetRequest({ pathname: "/img/welcome/01-calls.jpg" }), null);
  // The model's history (and Web) carry the set as words.
  assert.match(JSON.stringify(db.loadConversation(conv(num))), /Calls: /);
});

test("carousel, web setup: the line from the page, the stack, the question", async () => {
  const h = harness();
  withCarousel(h);
  const num = newNumber();
  const s = await newSetup();
  await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.deepEqual(to(h, num).map(show), ["hey kofi, Jarvis here. picking up from your setup, here's what i can do for you", "[carousel 7]", welcome.HELP_FIRST]);
});

test("carousel refused (a V1 line): the seven pictures one by one in its place, then the question; nothing failed", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  withCarousel(h, () => V1);
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, ...PICS, ob.NAME_Q]);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'failed'").get().n, 0);
});

test("carousel refused AND a picture refused: that one card as its line, the rest in order", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  withCarousel(h, () => V1);
  const real = h.channel.sendMedia.bind(h.channel);
  h.channel.sendMedia = async (a) => a.filename === "food.jpg" ? { ok: false, supported: true, error: "HTTP 400" } : real(a);
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const want = [ob.INTRO, ...PICS, ob.NAME_Q];
  want[5] = LINES[4];
  assert.deepEqual(to(h, num).map(show), want);
});

test("carousel held on a passing failure: the sweep sends the stack later, then the question; never pictures as well", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  let down = true;
  withCarousel(h, () => down ? { retryable: true, error: "HTTP 503" } : null);
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  assert.deepEqual(to(h, num).map(show), [ob.INTRO]);
  down = false;
  clock.skip(10 * 60_000);
  for (let i = 0; i < 6; i++) await outbox.pass({ router: h.router });
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, "[carousel 7]", ob.NAME_Q]);
});

test("carousel out of tries: the pictures in its place, then the question", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  withCarousel(h, () => ({ retryable: true, error: "HTTP 503" }));
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  for (let i = 0; i < 20; i++) { clock.skip(60 * 60_000); await outbox.pass({ router: h.router }); }
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, ...PICS, ob.NAME_Q]);
});

test("the process stops while the carousel is being sent: after the restart the pictures go, then the question", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  let crash = true;
  h.channel.sendCarousel = () => crash ? new Promise(() => {}) : Promise.resolve({ ok: true });
  const num = newNumber();
  void h.router.deliver(text(num, "hey"));
  for (let i = 0; i < 50 && !db.db.prepare("SELECT 1 FROM outbox WHERE state = 'sending'").get(); i++) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(to(h, num).map(show), [ob.INTRO]);
  crash = false;
  outbox.recoverStranded({});
  for (let i = 0; i < 12; i++) await outbox.pass({ router: h.router });
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, ...PICS, ob.NAME_Q]);
});

test("a reply while the carousel is held waits behind it", async () => {
  const h = harness({ hey: { kind: "greeting" }, kofi: { kind: "answer", name: "Kofi" } });
  let down = true;
  withCarousel(h, () => down ? { retryable: true, error: "HTTP 429" } : null);
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "kofi"));
  assert.deepEqual(to(h, num).map(show), [ob.INTRO]);
  down = false;
  clock.skip(10 * 60_000);
  for (let i = 0; i < 8; i++) await outbox.pass({ router: h.router });
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, "[carousel 7]", ob.NAME_Q, ob.MET("Kofi"), ob.CARD_NAME_ASK]);
});

test("Sendblue's carousel: one POST to /api/send-carousel with the addresses; Sendblue's V1 refusal comes back as a failure, not retried", async () => {
  const { SendblueChannel } = await import("../src/channels/sendblue.js");
  const saved = { sendblueKeyId: config.sendblueKeyId, sendblueSecretKey: config.sendblueSecretKey, sendblueFrom: config.sendblueFrom, sendblueWebhookSecret: config.sendblueWebhookSecret };
  Object.assign(config, { sendblueKeyId: "k", sendblueSecretKey: "s", sendblueFrom: LINE, sendblueWebhookSecret: "w" });
  try {
    const calls = [];
    let answer = { status: 200, json: { status: "QUEUED", message_handle: "h1", message_type: "carousel" } };
    const sb = new SendblueChannel({ fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return new Response(JSON.stringify(answer.json), { status: answer.status }); } });
    const urls = ["https://f.test/img/welcome/x/01-calls.jpg", "https://f.test/img/welcome/x/02-events.jpg"];
    const ok = await sb.sendCarousel({ to: "+14155550123", mediaUrls: urls });
    assert.equal(ok.ok, true);
    assert.equal(calls[0].url, "https://api.sendblue.com/api/send-carousel");
    assert.deepEqual(calls[0].body, { number: "+14155550123", from_number: LINE, media_urls: urls });
    assert.equal(calls[0].headers["sb-api-key-id"], "k");
    answer = { status: 400, json: { status: "ERROR", message: "Carousel messaging is only available on V2 lines" } };
    const no = await sb.sendCarousel({ to: "+14155550123", mediaUrls: urls });
    assert.equal(no.ok, false);
    assert.notEqual(no.retryable, true);
    assert.match(no.error, /V2/);
    const bad = await sb.sendCarousel({ to: "+14155550123", mediaUrls: ["http://f.test/a.jpg", urls[0]] });
    assert.equal(bad.ok, false);
    assert.equal(calls.length, 2, "an http address never reaches Sendblue");
  } finally { Object.assign(config, saved); }
});

test("a carousel failing twice on passing errors goes as pictures, not after an hour of retries", async () => {
  const h = harness({ hey: { kind: "greeting" } });
  const tries = withCarousel(h, () => ({ retryable: true, error: "HTTP 503" }));
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  clock.skip(5 * 60_000);
  for (let i = 0; i < 4; i++) await outbox.pass({ router: h.router });
  assert.equal(tries.length, outbox.CAROUSEL_TRIES);
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, ...PICS, ob.NAME_Q]);
});

test("carousel turned into pictures with one held, and a reply: the answer waits behind the question, not beside it", async () => {
  const h = harness({ hey: { kind: "greeting" }, kofi: { kind: "answer", name: "Kofi" } });
  withCarousel(h, () => V1);
  const real = h.channel.sendMedia.bind(h.channel);
  let down = true;
  h.channel.sendMedia = async (a) => down && a.filename === "food.jpg" ? { ok: false, supported: true, retryable: true, error: "HTTP 429" } : real(a);
  let qDown = true;
  const realSend = h.channel.send.bind(h.channel);
  h.channel.send = async (a) => qDown && a.text === ob.NAME_Q ? { ok: false, retryable: true, error: "HTTP 503" } : realSend(a);
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "kofi"));
  down = false;
  clock.skip(10 * 60_000);
  for (let i = 0; i < 8; i++) await outbox.pass({ router: h.router });
  assert.ok(!to(h, num).some(m => m.text === ob.CARD_NAME_ASK), "nothing of the next step before the question");
  qDown = false;
  clock.skip(60 * 60_000);
  for (let i = 0; i < 8; i++) await outbox.pass({ router: h.router });
  assert.deepEqual(to(h, num).map(show), [ob.INTRO, ...PICS, ob.NAME_Q, ob.MET("Kofi"), ob.CARD_NAME_ASK]);
});
