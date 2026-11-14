// Retry, don't offer (src/retry.js, src/tools.js runToolOnTheirClock, src/runtime.js reply check,
// src/calls/cartesia.js spoken). What these hold, with no model and no network:
//   1. a read-only lookup that fails for a passing reason is tried again in code, bounded, inside a
//      time cap, and its result says how many tries in a numbers-only field;
//   2. a refusal, a limit or a wall is never retried, and a must-not tool is never wrapped at all;
//   3. every try failed: one re-check timer is set (once), and the note states it, never an offer;
//   4. the reply check turns "if you want, I can try again" after a failed lookup into a re-run (tries
//      left) or a plain line with the re-check (code's, no model call), leaves a declined payment as a
//      plain statement with no retry, and never touches a genuine question that needs their choice;
//   5. on a call, the spoken answer drops the offer and says the answer will come by text.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-no-offers-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const said = await import("../src/said.js");
const retry = await import("../src/retry.js");
const { config, clock } = await import("../src/config.js");

const OWNER = "+12025551234";
const C = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM pending_inbound; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM outbox; DELETE FROM requests; DELETE FROM request_messages;
    DELETE FROM open_questions; DELETE FROM sent_claims; DELETE FROM timers;`);
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.saidLedger = true;
  config.claimCheck = "acting";
  config.burstQuietMs = 20;
  config.burstMaxMs = 200;
  said.setRecorder(() => ({ claims: [], supersedes: [], questions: [], closes: [], declined: [] }));
  said.setChecker(() => ({ changed_silently: [], asks_closed: [], unbacked: [] }));
});

const noSleep = async () => {};
const GOOD = { current: { temperature_2m: 50, apparent_temperature: 48, weather_code: 1, wind_speed_10m: 5, precipitation: 0 }, daily: { temperature_2m_max: [55], temperature_2m_min: [40], precipitation_probability_max: [10], weather_code: [1] }, utc_offset_seconds: 0 };
const respond = (status, body = GOOD) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const AT = { latitude: 40.7, longitude: -74.0 };

// ---------- 1, 2: the helper and the classes ----------

test("a transient failure is tried again, and the tries are counted", async () => {
  let n = 0;
  const got = await retry.retryTransient(async () => (++n < 2 ? { ok: false, error: "Tavily answered 502" } : { ok: true }), { sleep: noSleep });
  assert.equal(got.out.ok, true);
  assert.equal(got.tries, 2);
  const down = await retry.retryTransient(async () => ({ ok: false, error: "Tavily did not answer within 20s." }), { sleep: noSleep, now: () => 0 });
  assert.equal(down.tries, retry.ATTEMPTS, "bounded: three tries and no more");
});

test("never retried: a refusal, a wrong password, a bot wall, a limit, a declined payment, a not-found", async () => {
  for (const out of [
    { ok: false, error: "the Tavily key was rejected" },
    { ok: false, error: "wrong password" },
    { ok: false, error: "captcha on the page; bot wall" },
    { ok: false, status: "rate_limited", error: "Google is rate-limiting this" },
    { ok: false, error: "the payment was declined (timed out waiting)" },
    { ok: false, error: "No saved place called home." },
  ]) {
    let n = 0;
    const got = await retry.retryTransient(async () => { n++; return out; }, { sleep: noSleep });
    assert.equal(n, 1, `tried once: ${out.error}`);
    assert.equal(retry.isTransient(out), false);
  }
});

test("the time cap: a try as slow as the last one would not fit, so none is started", async () => {
  let t = 0;
  let n = 0;
  const got = await retry.retryTransient(async () => { n++; t += 5_000; return { ok: false, error: "timed out" }; }, { sleep: noSleep, now: () => t, capMs: retry.CALL_CAP_MS });
  assert.equal(n, 1, "5 s gone of a 6 s cap: no second 5 s try");
  assert.equal(got.tries, 1);
});

test("only read-only lookups are wrapped: nothing that buys, sends, books, calls or signs in", () => {
  for (const name of ["purchase", "purchase_confirm", "uber_request", "flight_book", "message_send", "gmail_send", "call_place", "account_signin", "signin_email", "x_post", "confirm_request"]) {
    assert.equal(retry.RETRY_TOOLS.has(name), false, name);
  }
  for (const name of ["web_search", "web_lookup", "weather", "nearby_places", "gmail_read", "gmail_search"]) assert.ok(retry.RETRY_TOOLS.has(name), name);
});

// ---------- 1, 3: through the real runTool ----------

test("weather: a 503 then a reading comes back as the reading, after 2 tries", async () => {
  let calls = 0;
  const out = await runTool("weather", AT, { conversationId: C, kind: "user", fetchImpl: async () => (++calls === 1 ? respond(503) : respond(200)) });
  assert.equal(out.ok, true);
  assert.equal(out.tries, 2);
  assert.equal(typeof out.tries, "number");
  assert.equal(db.pendingLabelledTimers(C, retry.RECHECK_LABEL).length, 0, "it worked: no re-check");
});

test("weather down on every try: one re-check is set, the note states it, and nothing offers", async () => {
  const fetchImpl = async () => respond(503);
  const out = await runTool("weather", AT, { conversationId: C, kind: "user", fetchImpl });
  assert.equal(out.ok, false);
  assert.equal(out.tries, 3);
  assert.equal(out.recheck_in_min, 10);
  assert.match(out.note, /isn't answering right now \(3 tries\)/);
  assert.match(out.note, /I'll check again in 10 minutes and text you/);
  assert.doesNotMatch(out.note.replace(/Never offer to try again, and never ask if they want you to\./, ""), /want me to|if you want|try again\?/i);
  const timers = db.pendingLabelledTimers(C, retry.RECHECK_LABEL);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].fire_at - clock.now() >= 9 * 60_000);
  assert.equal(db.listTimers(C).length, 0, "code's re-check is not one of their reminders");
  // Down again: still one re-check.
  const again = await runTool("weather", AT, { conversationId: C, kind: "user", fetchImpl });
  assert.match(again.note, /A re-check is already set/);
  assert.equal(db.pendingLabelledTimers(C, retry.RECHECK_LABEL).length, 1, "once");
  // The re-check's own firing fails too: no further re-check.
  db.cancelTimer(C, timers[0].id);
  const fired = db.createTimer(C, { fireAt: clock.now(), note: "Re-check, once: weather {}", label: retry.RECHECK_LABEL });
  db.db.prepare("UPDATE timers SET fired_at = ? WHERE id = ?").run(clock.now(), fired.id);
  await runTool("weather", AT, { conversationId: C, kind: "event", fromTimer: fired.id, fetchImpl });
  assert.equal(db.pendingLabelledTimers(C, retry.RECHECK_LABEL).length, 0, "a re-check never sets another");
});

test("the lookup works later in the same conversation: the pending re-check is called off", async () => {
  await runTool("weather", AT, { conversationId: C, kind: "user", fetchImpl: async () => respond(503) });
  assert.equal(db.pendingLabelledTimers(C, retry.RECHECK_LABEL).length, 1);
  const ok = await runTool("weather", AT, { conversationId: C, kind: "user", fetchImpl: async () => respond(200) });
  assert.equal(ok.ok, true);
  assert.equal(db.pendingLabelledTimers(C, retry.RECHECK_LABEL).length, 0);
});

// ---------- 4: the reply check, fixtures ----------

const OFFER = "Looks like I haven't got a fresh confirmed update on it. If you want, I can try again in a bit.";

test("fixture: an offer after a transient lookup failure with tries left goes back to run it again", () => {
  const fix = retry.fixOffer({ draft: OFFER, acts: [{ name: "web_search", ok: false, result: "Tavily did not answer", tries: 1 }] });
  assert.equal(fix.kind, "rerun");
  assert.match(fix.note, /run web_search again yourself now/);
});

test("fixture: an offer after every try failed is stated with the re-check, by code", async () => {
  await runTool("weather", AT, { conversationId: C, kind: "user", fetchImpl: async () => respond(503) });
  const fix = retry.fixOffer({ draft: "The weather service isn't answering. Want me to try again?", acts: [{ name: "weather", ok: false, result: "503", tries: 3 }], conversationId: C });
  assert.equal(fix.kind, "stated_with_recheck");
  assert.equal(fix.text, "The weather service isn't answering. I'll check again in 10 minutes and text you.");
});

test("fixture: an offer after a declined payment is left a plain statement, and nothing is re-run", () => {
  const fix = retry.fixOffer({ draft: "The payment was declined, so nothing was charged. Want me to try again?", acts: [{ name: "purchase_confirm", ok: false, result: "declined", tries: undefined }], conversationId: C });
  assert.equal(fix.kind, "stated");
  assert.equal(fix.note, undefined, "no rewrite, so nothing runs again");
  assert.equal(fix.text, "The payment was declined, so nothing was charged.");
});

test("fixture: a genuine question that needs their choice is not touched, and an offer with nothing failed is not this check's", () => {
  assert.equal(retry.fixOffer({ draft: "I found two flights: the 7am and the 9am. Which of these two?", acts: [{ name: "web_search", ok: false, result: "timed out", tries: 3 }] }), null);
  assert.equal(retry.fixOffer({ draft: "Here's the forecast. Want me to check again tomorrow morning?", acts: [{ name: "weather", ok: true, result: "{}" }] }), null);
  assert.equal(retry.offersInDraft("Do you want the window or the aisle?").length, 0);
});

/** The real Runtime: the turn runs the tools for real, then drafts `draft`; a rewrite drafts `rewrite`. */
function harness({ tools, draft, rewrite = () => "rewritten" }) {
  const turns = [];
  const runtime = new Runtime({
    log: () => {},
    runTurn: async (args) => {
      turns.push(args.text);
      const rewriting = /Your draft reply was NOT sent/.test(args.text);
      if (!rewriting) for (const [name, input, extra] of tools) await runTool(name, input, { ...args, ...(extra ?? {}) });
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
const settle = async (fake, n = 1) => { const t0 = Date.now(); while (fake.sent.length < n && Date.now() - t0 < 5_000) await new Promise(r => setTimeout(r, 5)); };

test("Runtime: weather down on every try and a draft that offers: what goes is the outcome and the re-check, with no second turn", async () => {
  const h = harness({ tools: [["weather", AT, { fetchImpl: async () => respond(503) }]], draft: "The weather service isn't answering right now. If you want, I can try again in a bit." });
  await h.router.deliver({ channel: "fake", externalId: "W-1", from: OWNER, text: "what's the weather", chatId: null, service: "iMessage" });
  await settle(h.fake);
  assert.deepEqual(h.fake.sent.map(m => m.text), ["The weather service isn't answering right now. I'll check again in 10 minutes and text you."]);
  assert.equal(h.turns.length, 1, "no extra model call");
  const last = db.loadConversation(C).at(-1);
  assert.equal(last.content, "The weather service isn't answering right now. I'll check again in 10 minutes and text you.", "the thread holds what went");
});

test("Runtime: a lookup that failed once (not transient) and a draft that offers: the one rewrite is asked to run it again", async () => {
  const h = harness({
    tools: [["weather", AT, { fetchImpl: async () => respond(200, { current: {}, daily: {} }) }]],
    draft: "I couldn't get a reading. Want me to try again?",
    rewrite: (note) => { assert.match(note, /run weather again yourself now/); return "It's 50°F and clear."; },
  });
  await h.router.deliver({ channel: "fake", externalId: "W-2", from: OWNER, text: "weather?", chatId: null, service: "iMessage" });
  await settle(h.fake);
  assert.deepEqual(h.fake.sent.map(m => m.text), ["It's 50°F and clear."]);
  assert.equal(h.turns.length, 2, "rewritten once");
});

// ---------- 5: on a call ----------

test("call: the spoken answer drops the offer, and says it will text when a re-check is set", async () => {
  assert.equal(retry.callLine("It's sunny and 50.", C), "It's sunny and 50.");
  assert.equal(retry.callLine(OFFER, C), "Looks like I haven't got a fresh confirmed update on it.");
  await runTool("web_search", { query: "score" }, { conversationId: C, kind: "user", onCall: 1 }).catch(() => null);
  db.createTimer(C, { fireAt: clock.now() + 600_000, note: "Re-check, once: web_search {}", label: retry.RECHECK_LABEL });
  assert.equal(retry.callLine(OFFER, C), "Looks like I haven't got a fresh confirmed update on it. I'll text you the answer when I have it.");
});

test("not offers: the call passphrase ask, the call deferral line, a team flag and a save-login question are never rewritten", async () => {
  const { LINES } = await import("../src/calls/calltrust.js");
  const { DEFERRED_LINE } = await import("../src/calls/cartesia.js");
  const fixed = [DEFERRED_LINE, ...Object.values(LINES).filter((l) => typeof l === "string"),
    "Can I flag this to Reason's team? I'd send: \"The Netflix sign-in failed twice and it is still not signed in.\"",
    "Want me to save this login, so next time I can sign in to Netflix for you myself?"];
  for (const line of fixed) {
    assert.deepEqual(retry.offersInDraft(line), [], line);
    assert.equal(retry.callLine(line, null), line, line);
    assert.equal(retry.fixOffer({ draft: line, acts: [{ name: "weather", ok: false, result: "timed out" }] }), null, line);
  }
  // The control: a real offer is still caught.
  assert.equal(retry.offersInDraft("It timed out. Want me to try again?").length, 1);
});
