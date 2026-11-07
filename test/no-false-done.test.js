// No "done" without a tool behind it (src/said.js claim check, src/tools.js turnActs, src/runtime.js).
//
// The incidents this pins:
//   2026-10-31  "I've started the Ulta checkout" — and the failure reached the owner 45 minutes later.
//   2026-11-03  "I made you walking directions" — with no link in the text.
// What these hold, through the real Runtime and the real runTool (no model, no network):
//   1. every tool call of a turn is recorded with whether it worked and the links it returned;
//   2. the check in front of the reply is shown that record and the jobs on record, on every reply;
//   3. a claim the check says nothing backs is rewritten once, and the false line never goes out;
//   4. a claim of a link the text does not carry is rewritten with the link the tool returned;
//   5. a checkout Crossmint stops answering about is told within about a minute, once.
// The judging itself is the model's (CHECK_INSTRUCTIONS); here a stub stands in for it and states
// what it was shown.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-no-false-done-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_SHOP_CONNECT = "owner";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const said = await import("../src/said.js");
const shop = await import("../src/shopconnect.js");
const { config, clock } = await import("../src/config.js");

const OWNER = "+12025551234";
const C = "dm:owner";
const ULTA = "https://www.ulta.com/p/foaming-facial-cleanser-xlsImpprod5140065?sku=2541605";

// Crossmint, refusing to start anything (the run never existed).
let crossmint = [];
shop._setFetch(async (url, init = {}) => {
  crossmint.push({ method: init.method ?? "GET", path: new URL(url).pathname });
  return { status: 500, ok: false, text: async () => JSON.stringify({ message: "upstream error" }) };
});

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM pending_inbound; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM outbox; DELETE FROM requests; DELETE FROM request_messages;
    DELETE FROM open_questions; DELETE FROM sent_claims; DELETE FROM shop_runs;`);
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.saidLedger = true;
  config.claimCheck = "acting";
  config.burstQuietMs = 20;
  config.burstMaxMs = 200;
  said.setRecorder(() => ({ claims: [], supersedes: [], questions: [], closes: [], declined: [] }));
  said.setChecker(null);
  crossmint = [];
});

/** The real Runtime and Router, with a turn that runs the given tools for real and then drafts `draft`; the rewrite drafts `rewrite`. */
function harness({ tools, draft, rewrite }) {
  const turns = [];
  const runtime = new Runtime({
    log: () => {},
    runTurn: async (args) => {
      turns.push(args.text);
      const rewriting = /Your draft reply was NOT sent/.test(args.text);
      if (!rewriting) for (const [name, input] of tools) await runTool(name, input, args);
      const reply = rewriting ? rewrite(args.text) : draft;
      db.saveConversation(args.conversationId, [...db.loadConversation(args.conversationId), { role: "user", content: args.text }, { role: "assistant", content: reply }]);
      return reply;
    },
  });
  const router = new Router({ runtime, log: () => {} });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  return { router, fake, turns };
}
const settle = async (fake, n = 1) => { const t0 = Date.now(); while (fake.sent.length < n && Date.now() - t0 < 3_000) await new Promise(r => setTimeout(r, 5)); };

test("Ulta, 10-31: 'I've started the Ulta checkout' when the checkout did not start is rewritten before it goes", async () => {
  let shown = null;
  // The model's read, stood in for: it is handed the turn's tools and the jobs on record, and it names the claim.
  said.setChecker(({ acts, jobs, userText, prompt }) => {
    shown = { acts: acts.map(a => ({ ...a })), jobs, userText, prompt };
    return { changed_silently: [], asks_closed: [], unbacked: [{ quote: "I've started the Ulta checkout", problem: "not_done", fact: "store_checkout did not work; no checkout is running" }] };
  });
  const FALSE = "I've started the Ulta checkout for the CeraVe 16 oz. I'll text you when it needs your approval.";
  const HONEST = "The Ulta checkout didn't start: the checkout service turned it down. Nothing was charged. Want me to try again?";
  const h = harness({
    tools: [["store_checkout", { store: "Ulta", start_url: ULTA, what: "One CeraVe Foaming Facial Cleanser, 16 oz, shipped to home.", item: "CeraVe Foaming Facial Cleanser 16 oz", max_usd: 35 }]],
    draft: FALSE,
    rewrite: (note) => { assert.match(note, /nothing you ran this turn did that/); assert.match(note, /I've started the Ulta checkout/); return HONEST; },
  });
  await h.router.deliver({ channel: "fake", externalId: "U-1", from: OWNER, text: "yes buy the cerave from ulta", chatId: null, service: "iMessage" });
  await settle(h.fake);
  assert.ok(shown, "the check ran on a reply with nothing standing — every reply is read for claims now");
  assert.equal(shown.acts.length, 1);
  assert.equal(shown.acts[0].name, "store_checkout");
  assert.equal(shown.acts[0].ok, false, "the failed checkout is recorded as not working");
  assert.match(shown.prompt, /store_checkout: DID NOT WORK/);
  assert.match(shown.prompt, /On record:\n {2}\(none\)/, "and no run is on record");
  assert.equal(shown.userText, "yes buy the cerave from ulta");
  assert.deepEqual(h.fake.sent.map(m => m.text), [HONEST], "only the honest line went out");
  assert.equal(h.turns.length, 2, "rewritten once");
});

test("Ulta: a checkout that really is running backs 'it's running' — the record is shown, and a clean read sends the draft as written", async () => {
  config.claimCheck = "all"; // no acting tool this turn: only "all" reads it
  // A run on record, started a moment ago in an earlier turn.
  db.db.prepare("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at, stage, stage_at, progress_at) VALUES ('run_live', ?, 'ulta', 'CeraVe 16 oz', 'guest', 'running', ?, ?, 'in_progress', ?, ?)")
    .run(C, clock.now(), clock.now(), clock.now(), clock.now());
  let jobs = null;
  said.setChecker((x) => { jobs = x.jobs; return { changed_silently: [], asks_closed: [], unbacked: [] }; });
  const h = harness({ tools: [], draft: "Still running at Ulta, nothing charged yet.", rewrite: () => assert.fail("no rewrite") });
  await h.router.deliver({ channel: "fake", externalId: "U-2", from: OWNER, text: "updates?", chatId: null, service: "iMessage" });
  await settle(h.fake);
  assert.match(jobs, /checkout at Ulta for CeraVe 16 oz: running at Ulta's checkout/);
  assert.deepEqual(h.fake.sent.map(m => m.text), ["Still running at Ulta, nothing charged yet."]);
});

test("directions, 11-03: 'I made you walking directions' when the route failed is rewritten", async () => {
  config.directionsOn = true;
  let acts = null;
  said.setChecker((x) => { acts = x.acts.map(a => ({ ...a })); return { changed_silently: [], asks_closed: [], unbacked: [{ quote: "I made you walking directions to Joe's", problem: "not_done", fact: "directions did not work: the route couldn't be worked out" }] }; });
  const HONEST = "I couldn't work out the walking route to Joe's just now. Here's the address in Maps instead: https://maps.apple.com/?q=Joe%27s+Pizza";
  const h = harness({
    tools: [["directions", { to: "Joe's Pizza", to_latitude: 40.7306, to_longitude: -73.9866, from_latitude: 40.7296, from_longitude: -73.9876, place_name: "Joe's" }]],
    draft: "I made you walking directions to Joe's, about 5 minutes.",
    rewrite: () => HONEST,
  });
  // The route service is down.
  h.router.runtime.turnExtras.fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" });
  await h.router.deliver({ channel: "fake", externalId: "D-1", from: OWNER, text: "walk me to joe's", chatId: null, service: "iMessage" });
  await settle(h.fake);
  config.directionsOn = false;
  assert.equal(acts?.[0]?.name, "directions");
  assert.equal(acts[0].ok, false);
  assert.deepEqual(h.fake.sent.map(m => m.text), [HONEST]);
});

test("directions: made, but the link left out of the text — the rewrite is handed the link the tool returned", async () => {
  const acts = [];
  said.noteAct(acts, "directions", { ok: true, url: "https://pages.heyreason.test/d/abc123?k=key", walk: "6 MIN WALK · 450 M", say: "Send the link with one short line." }, { acting: true });
  said.setChecker(() => ({ changed_silently: [], asks_closed: [], unbacked: [{ quote: "I made you walking directions", problem: "no_artifact", fact: "the directions link is not in the text" }] }));
  const out = await said.checkDraft({ conversationId: C, draft: "I made you walking directions, 6 minutes.", acts, userText: "walk me to joe's" });
  assert.equal(out.ok, false);
  assert.match(out.note, /https:\/\/pages\.heyreason\.test\/d\/abc123\?k=key/, "the link is in the note, whole");
  assert.match(out.note, /on its own line/);
});

test("the reader cannot invent a claim: a quote that is not in the draft is ignored", async () => {
  said.setChecker(() => ({ changed_silently: [], asks_closed: [], unbacked: [{ quote: "I booked the table", problem: "not_done", fact: "nothing booked" }] }));
  const acts = [];
  said.noteAct(acts, "web_search", { ok: true, results: [] }, { acting: true });
  assert.deepEqual(await said.checkDraft({ conversationId: C, draft: "want me to book the table for 8?", acts, userText: "dinner?" }), { ok: true });
});

test("a call with no record of the turn's tools (an older caller) checks only what it always did", async () => {
  let asked = 0;
  said.setChecker(() => { asked++; return { changed_silently: [], asks_closed: [], unbacked: [] }; });
  assert.deepEqual(await said.checkDraft({ conversationId: C, draft: "I've started it." }), { ok: true });
  assert.equal(asked, 0);
});

test("REASON_CLAIM_CHECK=0: the claim check is off and the turn's tools are not read", async () => {
  config.claimCheck = false;
  let asked = 0;
  said.setChecker(() => { asked++; return { changed_silently: [], asks_closed: [], unbacked: [] }; });
  assert.deepEqual(await said.checkDraft({ conversationId: C, draft: "I've started it.", acts: [] }), { ok: true });
  assert.equal(asked, 0);
});

test("noteAct: a refusal, an error, a blocked call and a not-sent message all read as not working; links come back whole", () => {
  const acts = [];
  said.noteAct(acts, "a", { ok: false, error: "no" });
  said.noteAct(acts, "b", { error: "Unknown tool b" });
  said.noteAct(acts, "c", { ok: false, blocked: "harm_screen" });
  said.noteAct(acts, "d", { ok: false, not_sent: true });
  said.noteAct(acts, "e", { ok: true, url: `https://x.test/${"p".repeat(500)}`, _image: { data: "AAAA" } });
  assert.deepEqual(acts.map(a => a.ok), [false, false, false, false, true]);
  assert.equal(acts[4].links[0].length, "https://x.test/".length + 500, "the link is never cut");
  assert.ok(!acts[4].result.includes("AAAA"), "image bytes never ride into the check");
});

test("Ulta: a checkout Crossmint stops answering about is told within about a minute, once, and cancelled there", async () => {
  const runs = { run_9: { status: "running", requiredAction: null, revision: 1 } };
  const told = [];
  shop.attach({ say: (c, t) => told.push(t) });
  shop._setFetch(async (url, init = {}) => {
    const p = new URL(url).pathname;
    crossmint.push({ method: init.method ?? "GET", path: p });
    const m = /agent-checkouts\/([^/]+)(\/cancel)?$/.exec(p);
    if (m?.[2]) return { status: 202, ok: true, text: async () => "{}" };
    if (m && runs[m[1]]) return { status: 200, ok: true, text: async () => JSON.stringify({ runId: m[1], ...runs[m[1]] }) };
    return { status: 404, ok: false, text: async () => "" };
  });
  db.db.prepare("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at, stage, stage_at, progress_at) VALUES ('run_9', ?, 'ulta', 'CeraVe 16 oz', 'guest', 'running', ?, ?, 'started', ?, ?)")
    .run(C, clock.now(), clock.now(), clock.now(), clock.now());
  await shop.step("run_9");
  delete runs.run_9;
  await shop.step("run_9");
  clock.skip(30_000);
  assert.equal((await shop.step("run_9")).done, false);
  clock.skip(31_000);
  const s = await shop.step("run_9");
  assert.equal(s.lost, true, "61 seconds of a dead run is the end of it");
  assert.equal(told.length, 1);
  assert.match(told[0], /^I lost track of the Ulta checkout for CeraVe 16 oz/);
  assert.ok(crossmint.some(c => c.method === "POST" && c.path.endsWith("/run_9/cancel")), "cancelled at Crossmint so nothing is left running unwatched");
  assert.equal((await shop.step("run_9")).done, true);
  assert.equal(told.length, 1, "once");
});

test("review 11-06: a search or lookup is not an acting tool, so its reply never waits for the claim check", async () => {
  const acts = [];
  await runTool("web_search", { query: "weather boston" }, { conversationId: C, turnActs: acts });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].acting, false);
});

test("the gate: a reply whose turn called no tool that acts or makes something is not held for the claim check", async () => {
  let asked = 0;
  said.setChecker(() => { asked++; return { changed_silently: [], asks_closed: [], unbacked: [] }; });
  const reads = [];
  said.noteAct(reads, "recall", { people: [], count: 0 }, { acting: false });
  assert.deepEqual(await said.checkDraft({ conversationId: C, draft: "sunny, 61 till tonight.", acts: [], userText: "weather?" }), { ok: true });
  assert.deepEqual(await said.checkDraft({ conversationId: C, draft: "you told me tuesday.", acts: reads, userText: "when's the dentist?" }), { ok: true });
  assert.equal(asked, 0, "no tool that acts: no check, no wait");
  const acting = [];
  said.noteAct(acting, "timer_set", { ok: true, id: 4 }, { acting: true });
  await said.checkDraft({ conversationId: C, draft: "set for 5pm.", acts: acting, userText: "remind me at 5" });
  assert.equal(asked, 1, "a turn that acted is read");
  config.claimCheck = "all";
  await said.checkDraft({ conversationId: C, draft: "sunny, 61 till tonight.", acts: [], userText: "weather?" });
  assert.equal(asked, 2, "REASON_CLAIM_CHECK=all reads every reply");
});

test("runTool marks which calls act: store_checkout and directions do, recall does not", async () => {
  const { lapsedBlocked } = await import("../src/tools.js");
  assert.equal(lapsedBlocked("store_checkout"), true);
  assert.equal(lapsedBlocked("directions"), true);
  assert.equal(lapsedBlocked("timer_set"), true);
  assert.equal(lapsedBlocked("recall"), false);
});
