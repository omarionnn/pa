// Limits off (owner, 2026-11-15): who still has a limit, after three of them came off.
//
//   pictures: the 41st picture in a day, for somebody invited, and for the owner?   (goes out)
//             for somebody on the monthly free tier, or paying?                      (still 40 a day, unchanged)
//   voice:    somebody on the monthly free tier calls in: which voice?               (Cartesia, the Gemma voice)
//             and on GPT-Live (the fall-back), is the call cut at 5:00?              (no: only the platform ceiling)
//             their 2 calls a month?                                                  (still counted, still the gate)
//             everyone else?                                                         (as before)
//
// Banks (no per-person limit) are in test/plaid.test.js. No model, no network: every fetch is a stub,
// every timer is a fake clock.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-limits-off-"));
Object.assign(process.env, {
  REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: dir, REASON_RECORDING_ROOT: join(dir, "recordings"),
  REASON_OWNER_NAME: "Ola", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner",
  REASON_OWNER_NUMBER: "+12025551234", REASON_MASTER_NUMBER: "+12025551234",
  REASON_PUBLIC_URL: "https://reason.example.test", REASON_PAGES_URL: "https://files.example.test",
  REASON_DELIVERY_GATED: "off", REASON_UNDO_SECONDS: "0",
  REASON_PAYWALL: "on", REASON_FREE_TIER: "monthly", REASON_PAYWALL_SHIP_TS: "2026-10-31T00:00:00Z",
  REASON_CALL_CARTESIA: "on", REASON_CALL_FEEL: "classic",
  SENDBLUE_API_KEY_ID: "", SENDBLUE_API_SECRET_KEY: "", SENDBLUE_FROM_NUMBER: "", SENDBLUE_WEBHOOK_SECRET: "",
});
delete process.env.REASON_FREE_CALL_MINUTES; // as on live: not set

const { runTool } = await import("../src/tools.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const pictureout = await import("../src/pictureout.js");
const plan = await import("../src/plan.js");
const trial = await import("../src/calls/calltrial.js");
const gl = await import("../src/calls/gptlive.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const OWNER = "dm:owner";
const INVITED = "dm:fake:+13475550001";   // came in by the owner's invite: free for good
const FREE = "dm:fake:+13475550002";      // came in on their own after the flip: the monthly free tier
const PAID = "dm:fake:+13475550003";      // came in on their own and pays
const NUM = { [OWNER]: "+12025551234", [INVITED]: "+13475550001", [FREE]: "+13475550002", [PAID]: "+13475550003" };
const CDN = "https://cdn.shop.example/products/blue-mug.png?v=1";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e2b4cd2a0000000049454e44ae426082", "hex");
function fetchWith() {
  const calls = [];
  const fn = async (url) => { calls.push(url); return new Response(PNG, { status: 200, headers: new Headers({ "content-type": "image/png" }) }); };
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM picture_watches; DELETE FROM plan; DELETE FROM calls;");
  pictureout._reset();
  for (const c of [OWNER, INVITED, FREE, PAID]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: NUM[c], name: c === OWNER ? "Ola" : "Sam", isOperator: c === OWNER });
    db.upsertThread({ conversationId: c, channel: "fake", address: NUM[c], isOwner: true, service: "iMessage" });
  }
  db.db.prepare("UPDATE accounts SET invited_by = ? WHERE conversation_id = ?").run(OWNER, INVITED);
  db.db.prepare("INSERT INTO plan (conversation_id, status, first_seen_at, updated_at) VALUES (?, 'paid', ?, ?)").run(PAID, clock.now(), clock.now());
  Object.assign(config, { cartesiaKey: "ck-test", cartesiaAgentId: "agent_test", callFeel: "classic", callCartesia: "on" });
});

test("who is who: the owner and the invited person are free for good; the other two are not", () => {
  assert.equal(plan.freeForGood(OWNER), true);
  assert.equal(plan.freeForGood(INVITED), true);
  assert.equal(plan.freeForGood(FREE), false);
  assert.equal(plan.onFreeTier(FREE), true, "the monthly free tier");
  assert.equal(plan.freeForGood(PAID), false);
  assert.equal(plan.status(PAID).status, "paid");
});

// ---------------------------------------------------------------- pictures

/** The day's 40 already kept for `c`, the way send_picture keeps them. */
async function fortyKept(c) {
  for (let i = 0; i < pictureout.PICTURES_PER_DAY; i++) {
    const r = await pictureout.rehost({ url: CDN, conversationId: c, fetchImpl: fetchWith(), capped: false });
    assert.equal(r.ok, true, `picture ${i + 1}`);
  }
}
function router() {
  const r = new Router({ log: () => {} });
  const fake = r.register(new FakeChannel({ media: true, reportsDelivery: true }));
  return { router: r, fake };
}
const sendPicture = (c, h, f) => runTool("send_picture", { url: CDN }, { conversationId: c, channels: h.router, messages: [], kind: "user", fetchImpl: f });

test("pictures: the invited person's and the owner's 41st picture in a day goes out (fetched, kept, sent)", async () => {
  assert.equal(pictureout.PICTURES_PER_DAY, 40);
  for (const c of [INVITED, OWNER]) {
    await fortyKept(c);
    const h = router(); const f = fetchWith();
    const out = await sendPicture(c, h, f);
    assert.equal(out.ok, true, `${c}: ${JSON.stringify(out)}`);
    assert.deepEqual(f.calls, [CDN], `${c}: the 41st was fetched`);
    assert.equal(h.fake.sent.length, 1, `${c}: and sent`);
    assert.match(h.fake.sent[0].media.url, /^https:\/\/files\.example\.test\/web\/media\/u\//);
  }
});

test("pictures: the monthly free tier and paying accounts keep the 40 a day, unchanged: the 41st is not fetched, the link goes as text", async () => {
  for (const c of [FREE, PAID]) {
    await fortyKept(c);
    const h = router(); const f = fetchWith();
    const out = await sendPicture(c, h, f);
    assert.deepEqual(f.calls, [], `${c}: past the 40 nothing is fetched`);
    assert.equal(h.fake.sent.length, 1, `${c}: one text`);
    assert.equal(h.fake.sent[0].media ?? null, null, `${c}: no picture`);
    assert.equal(h.fake.sent[0].text, pictureout.FETCH_FAILED_LINE(CDN));
    assert.notEqual(out.delivery, "pending");
    // The count itself is as it was: capped unless the caller says otherwise.
    const direct = await pictureout.rehost({ url: CDN, conversationId: c, fetchImpl: fetchWith() });
    assert.equal(direct.limited, true);
  }
});

// ---------------------------------------------------------------- voice

const ownIn = (c) => db.createCall(c, { provider: "cartesia", toNumber: NUM[c], isOwner: true, goal: "They called Reason", facts: [], announcement: "", direction: "in", state: "in_progress" });

test("voice: the monthly free-tier caller is on Cartesia (the Gemma voice, classic feel) like everyone; nobody else's routing changed", () => {
  assert.equal(plan.FREE_CALL_SECONDS, null, "no free-tier cut is set");
  for (const c of [OWNER, INVITED, FREE, PAID]) {
    assert.equal(plan.callLimitSeconds(c), null, c);
    assert.equal(trial.cartesiaTrialFor(ownIn(c)), true, `${c}: Cartesia`);
  }
  // Unchanged: at "owner" only somebody who chose it (nobody here); off, nobody; never a call to somebody else.
  config.callCartesia = "owner";
  assert.deepEqual([OWNER, INVITED, FREE, PAID].map(c => trial.cartesiaTrialFor(ownIn(c))), [false, false, false, false]);
  config.callCartesia = "off";
  assert.deepEqual([OWNER, INVITED, FREE, PAID].map(c => trial.cartesiaTrialFor(ownIn(c))), [false, false, false, false]);
  config.callCartesia = "on";
  const errand = db.createCall(FREE, { provider: "cartesia", toNumber: "+13470000000", isOwner: false, goal: "book", facts: [], announcement: "hi", state: "placing" });
  assert.equal(trial.cartesiaTrialFor(errand), false, "an errand call is never Cartesia");
});

test("voice: on GPT-Live (the fall-back) a free-tier call is not cut at 5:00 or at 30:00; it ends only at the platform ceiling, as anyone's does", async () => {
  Object.assign(config, { callVoice: "gptlive", twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16465550000", openaiKey: "sk-test" });
  const start = (conversationId) => {
    let t = 1_000_000; let q = []; let id = 0;
    const timers = { now: () => t, setTimeout: (fn, ms) => { q.push({ id: ++id, at: t + ms, fn }); return id; }, clearTimeout: (x) => { q = q.filter(e => e.id !== x); },
      async advance(ms) { const end = t + ms; for (;;) { q.sort((a, b) => a.at - b.at); const nx = q[0]; if (!nx || nx.at > end) break; q.shift(); t = nx.at; nx.fn(); await new Promise(r => setImmediate(r)); } t = end; } };
    const row = db.createCall(conversationId, { provider: "gptlive", toNumber: NUM[conversationId], isOwner: true, goal: "chat", facts: [], announcement: "hey", state: "placing" });
    const h = { open: [], event: [], close: [] };
    const live = { send: () => {}, close: () => {}, on: (k, f) => h[k].push(f) };
    const twilio = { open: () => true, send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {} };
    const lines = [];
    const call = new gl.GptLiveCall({ call: row, twilio, openLive: () => live, brain: async () => ({ text: "", tools: [] }), now: timers.now, timers, log: (o) => lines.push(o), finish: async () => {} });
    call.connect();
    return { call, timers, lines };
  };
  for (const c of [FREE, INVITED]) {
    const s = start(c);
    await s.timers.advance(5 * 60_000 + 5000);
    assert.ok(!s.call.done, `${c}: still on at 5:05`);
    assert.ok(!s.lines.some(l => l.gptlive_free_call_wrap), `${c}: no wrap-up cue`);
    await s.timers.advance(25 * 60_000);
    assert.ok(!s.call.done, `${c}: still on at 30:05`);
    await s.timers.advance(config.callPlatformCapSeconds * 1000);
    assert.ok(s.call.done, `${c}: the platform ceiling still ends it`);
    assert.equal(s.call.endWhy, "duration_cap", c);
    assert.notEqual(s.call.endWhy, "free_call_limit");
  }
});

test("voice: the free tier's 2 calls a month still count and still gate; what they are told says 2 calls with no minutes", async () => {
  assert.equal(plan.callGate(FREE), null);
  plan.noteCall(FREE); plan.noteCall(FREE);
  assert.equal(plan.callGate(FREE)?.why, "calls", "both used: the next one is refused with the link");
  for (const c of [OWNER, INVITED, PAID]) { plan.noteCall(c); plan.noteCall(c); plan.noteCall(c); assert.equal(plan.callGate(c), null, c); }
  assert.equal(plan.freeCallsWords(), "2 calls");
  const v = await runTool("subscription_show", {}, { conversationId: FREE, messages: [] });
  assert.match(v.note, /20 conversations and 2 calls a month/);
  assert.doesNotMatch(JSON.stringify(v), /minutes each|up to 5/);
});

// Review 2026-11-15: freeForGood is exactly "the plan says free for good" (or the owner), on every way in
// and every way not in, so no monthly-free or paying account reads as uncapped and no invited one as capped.
test("review: freeForGood on every way in matches the plan's own 'free', and nobody else", () => {
  const add = (c, n) => { db.upsertAccount({ conversationId: c, channel: "fake", address: n, name: "Kit", isOperator: false }); return c; };
  const ship = plan.shipTs();
  const viaFreeTier = add("dm:fake:+13475550011", "+13475550011");   // invited by somebody on the monthly free tier
  db.db.prepare("UPDATE accounts SET invited_by = ? WHERE conversation_id = ?").run(FREE, viaFreeTier);
  const viaInvitee = add("dm:fake:+13475550012", "+13475550012");    // invited by the owner's invitee: free down the chain
  db.db.prepare("UPDATE accounts SET invited_by = ? WHERE conversation_id = ?").run(INVITED, viaInvitee);
  const early = add("dm:fake:+13475550013", "+13475550013");         // here before the paywall
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(ship - 86_400_000, early);
  const byHand = add("dm:fake:+13475550014", "+13475550014");        // made free by hand
  db.db.prepare("INSERT INTO plan (conversation_id, status, first_seen_at, updated_at) VALUES (?, 'free', ?, ?)").run(byHand, clock.now(), clock.now());
  const tester = add("dm:fake:+13475550015", "+13475550015");        // a test number
  const lapsedPaid = add("dm:fake:+13475550016", "+13475550016");    // cancelled after paying
  db.db.prepare("INSERT INTO plan (conversation_id, status, first_seen_at, updated_at) VALUES (?, 'cancelled', ?, ?)").run(lapsedPaid, clock.now(), clock.now());
  for (const c of [FREE, PAID, viaFreeTier, viaInvitee, byHand, tester, lapsedPaid]) db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(ship + 1000, c);
  const was = config.testNumbers;
  config.testNumbers = ["+13475550015"];
  try {
    const want = { [OWNER]: true, [INVITED]: true, [viaInvitee]: true, [early]: true, [byHand]: true, [tester]: true, [FREE]: false, [PAID]: false, [viaFreeTier]: false, [lapsedPaid]: false };
    for (const [c, yes] of Object.entries(want)) {
      assert.equal(plan.freeForGood(c), yes, c);
      if (c !== OWNER) assert.equal(plan.status(c).status === "free", yes, `${c}: the plan's own word agrees`);
    }
    assert.equal(plan.freeForGood(""), false);
    assert.equal(plan.freeForGood("dm:fake:+19995550000"), false, "no account: capped");
  } finally { config.testNumbers = was; }
});

test("review: nobody else's call changed, and nothing a stranger hears still says 5 minutes", async () => {
  for (const c of [OWNER, INVITED, PAID]) assert.equal(plan.callLimitSeconds(c), null, c);
  for (const c of [OWNER, INVITED, PAID, FREE]) assert.equal(trial.cartesiaTrialFor({ conversation_id: c, is_owner: 1 }), true, c);
  const { PUBLIC_FACTS } = await import("../src/calls/stranger.js");
  const price = PUBLIC_FACTS.find(l => /^Price/.test(l));
  assert.match(price, /20 conversations and 2 calls free every month/);
  assert.doesNotMatch(PUBLIC_FACTS.join(" "), /\b5 minutes\b|five minutes/);
});

// ---------------------------------------------------------------- uploads (owner 2026-11-15: "lift the upload limits")

const uploads = await import("../src/webuploads.js");
const GB = 1024 ** 3;
const roomyDisk = () => ({ blocks: 1000 * GB / 4096, bsize: 4096, bavail: 500 * GB / 4096 });
const big = (mb) => { const b = Buffer.alloc(mb * 1024 * 1024, 7); PNG.copy(b); return b; };

test("uploads: past 300 MB kept, the owner's and the invited person's next file is kept; the monthly free tier and a payer are refused as before; the 20 MB a file stays for everyone", async () => {
  const was = uploads.diskStats.statfs;
  uploads.diskStats.statfs = roomyDisk;
  try {
    assert.equal(uploads.QUOTA_BYTES, 300 * 1024 * 1024);
    for (const c of [OWNER, INVITED, FREE, PAID]) {
      // 300 MB already kept (16 files of ~19 MB), stored without the quota so the count is the same for all four.
      for (let i = 0; i < 16; i++) assert.ok(!uploads.store({ conversationId: c, bytes: big(19), name: `p${i}.png`, quota: false }).error);
      assert.ok(uploads.keptBytes(c) > uploads.QUOTA_BYTES - 19 * 1024 * 1024);
      const next = uploads.store({ conversationId: c, bytes: big(19), name: "next.png", quota: !plan.freeForGood(c) });
      if (c === OWNER || c === INVITED) assert.ok(next.id && !next.error, `${c}: kept past 300 MB`);
      else assert.deepEqual([next.error, next.limit], ["too_big", uploads.QUOTA_BYTES], `${c}: the 300 MB still holds`);
      // The quota is on by default: a caller that says nothing is capped, as before.
      assert.equal(uploads.store({ conversationId: c, bytes: big(19), name: "default.png" }).error, "too_big");
      // The per-file size is not what was lifted.
      assert.equal(uploads.store({ conversationId: c, bytes: big(21), name: "huge.png", quota: false }).error, "too_big", `${c}: 20 MB a file`);
    }
    assert.equal(uploads.KEEP_MS, 30 * 24 * 60 * 60_000, "kept 30 days, as before");
  } finally { uploads.diskStats.statfs = was; uploads.forget(null); }
});

test("uploads: the disk floor is for everyone, the owner too, and lifts by itself; REASON_UPLOAD_DISK_FLOOR_GB moves it", () => {
  const was = uploads.diskStats.statfs;
  try {
    assert.equal(uploads.diskFloorBytes(), 5 * GB, "5 GB by default");
    uploads.diskStats.statfs = () => ({ blocks: 72 * GB / 4096, bsize: 4096, bavail: 4.5 * GB / 4096 });
    for (const c of [OWNER, INVITED, FREE, PAID]) {
      const r = uploads.store({ conversationId: c, bytes: PNG, name: "a.png", quota: false, inbound: true });
      assert.equal(r.error, "disk_full", c);
      assert.equal(r.say, uploads.DISK_FULL_WORDS);
    }
    process.env.REASON_UPLOAD_DISK_FLOOR_GB = "4";
    assert.ok(!uploads.store({ conversationId: INVITED, bytes: PNG, name: "b.png", quota: false, inbound: true }).error, "a lower floor lets it through");
    process.env.REASON_UPLOAD_DISK_FLOOR_GB = "0";
    assert.equal(uploads.diskFloorBytes(), 0);
    delete process.env.REASON_UPLOAD_DISK_FLOOR_GB;
    uploads.diskStats.statfs = () => { throw new Error("no statfs here"); };
    assert.ok(!uploads.store({ conversationId: INVITED, bytes: PNG, name: "c.png", quota: false, inbound: true }).error, "a disk that can't be read is not a reason to refuse");
    uploads.diskStats.statfs = () => ({ blocks: 72 * GB / 4096, bsize: 4096, bavail: 4.5 * GB / 4096 });
    assert.equal(uploads.store({ conversationId: INVITED, bytes: PNG, name: "c2.png", quota: false, inbound: true }).error, "disk_full", "the next read works again: the guard was not switched off by the failed one");
    uploads.diskStats.statfs = roomyDisk;
    assert.ok(!uploads.store({ conversationId: FREE, bytes: PNG, name: "d.png", inbound: true }).error, "room again");
  } finally { uploads.diskStats.statfs = was; delete process.env.REASON_UPLOAD_DISK_FLOOR_GB; uploads.forget(null); }
});

test("pictures Reason keeps to send ride the same rule: no 300 MB for the invited person, still for the monthly free tier", async () => {
  const was = uploads.diskStats.statfs;
  uploads.diskStats.statfs = roomyDisk;
  try {
    for (const c of [INVITED, FREE]) for (let i = 0; i < 16; i++) uploads.store({ conversationId: c, bytes: big(19), name: `p${i}.png`, quota: false });
    assert.equal((await pictureout.rehost({ url: CDN, conversationId: INVITED, fetchImpl: fetchWith(), capped: false })).ok, true);
    const free = await pictureout.rehost({ url: CDN, conversationId: FREE, fetchImpl: fetchWith(), capped: true });
    assert.equal(free.ok, false);
  } finally { uploads.diskStats.statfs = was; uploads.forget(null); }

});

// Review 2026-11-15: below the floor only a file a PERSON sends is refused. What Reason makes or sends
// itself still saves, or a full disk would quietly break replies.
test("review: below the disk floor a person's upload is refused, while Reason's own card, table and picture still save", async () => {
  const was = uploads.diskStats.statfs;
  uploads.diskStats.statfs = () => ({ blocks: 72 * GB / 4096, bsize: 4096, bavail: 4.5 * GB / 4096 });
  try {
    for (const c of [OWNER, INVITED, FREE, PAID]) {
      assert.equal(uploads.store({ conversationId: c, bytes: PNG, name: "theirs.png", inbound: true }).error, "disk_full", c);
      for (const pub of ["card", "table", "picture"]) {
        const m = uploads.store({ conversationId: c, bytes: PNG, name: `reason-${pub}.png`, extra: { public: pub } });
        assert.ok(m.id && !m.error, `${c}: Reason's ${pub} still saves`);
      }
      assert.equal((await pictureout.rehost({ url: CDN, conversationId: c, fetchImpl: fetchWith(), capped: !plan.freeForGood(c) })).ok, true, `${c}: a picture Reason sends`);
    }
    assert.doesNotMatch(uploads.DISK_FULL_WORDS, /["“”`]|\btype\b|\btext (?:me|back)\b|\breply\b/i, "nothing for them to type");
  } finally { uploads.diskStats.statfs = was; uploads.forget(null); }
});

// The web upload door (src/webmedia.js, inbound: true) refusing with 507 is test/web-compose.test.js.

// Review 2026-11-15: past 300 MB (allowed now for the invited), Reason's own cards and tables still save:
// they are made by Reason, so they never count against anybody's total.
test("review: Reason's own cards and tables pass quota: false at their one call site each", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["choicecards.js", "tableimage.js"]) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    assert.match(src, /\(ctx\.store \?\? uploads\.store\)\(\{[^\n]*public: "(?:card|table)"[^\n]*quota: false \}\)/, f);
  }
  const was = uploads.diskStats.statfs;
  uploads.diskStats.statfs = roomyDisk;
  try {
    for (let i = 0; i < 16; i++) uploads.store({ conversationId: INVITED, bytes: big(19), name: `p${i}.png`, quota: false });
    assert.equal(uploads.store({ conversationId: INVITED, bytes: PNG, name: "x.png" }).error, "too_big", "the default still counts");
    assert.ok(uploads.store({ conversationId: INVITED, bytes: PNG, name: "reason-1.jpg", extra: { public: "card" }, quota: false }).id);
  } finally { uploads.diskStats.statfs = was; uploads.forget(null); }
});
