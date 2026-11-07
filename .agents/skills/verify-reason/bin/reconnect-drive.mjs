#!/usr/bin/env node
// A stranger rings the line, then later texts and becomes a user: their first reply says it's good to
// reconnect, once; a different number gets nothing; the second message does not repeat it. Real turns
// on claude-cli (the subscription, never the API), a fake Sendblue, a throwaway db. Nobody's phone rings.
//
//   REASON_DB_PATH=$(mktemp -d)/r.db REASON_BACKEND=claude-cli REASON_AUTO_ADMIT=1 \
//     REASON_TEST_NUMBERS=+12025551234,+13475559999,+13475558888 node .agents/skills/verify-reason/bin/reconnect-drive.mjs
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER ||= "+12025551234";
process.env.REASON_MASTER_NUMBER ||= process.env.REASON_OWNER_NUMBER;
process.env.REASON_OWNER_NAME ||= "Omari";
process.env.REASON_TZ ||= "America/New_York";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";
process.env.SENDBLUE_API_KEY_ID = "drive-fake";
process.env.SENDBLUE_API_SECRET_KEY = "drive-fake";
process.env.SENDBLUE_FROM_NUMBER = "+12025550101";
process.env.SENDBLUE_WEBHOOK_SECRET = "drive-secret";
process.env.SENDBLUE_API_BASE = "http://127.0.0.1:9";
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/todo.db");
    process.exit(2);
  }
  process.env.REASON_DATA_DIR ||= dirname(db) + "/data";
  process.env.REASON_RECORDING_ROOT ||= dirname(db) + "/recordings";
}
for (const k of ["ANTHROPIC_API_KEY", "LINQ_API_KEY", "TWILIO_AUTH_TOKEN", "BLAND_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
if (process.env.REASON_BACKEND !== "claude-cli" || !process.env.REASON_TEST_NUMBERS || process.env.REASON_AUTO_ADMIT !== "1") {
  console.error("refusing: this drive is the real model on the subscription — set REASON_BACKEND=claude-cli, REASON_TEST_NUMBERS and REASON_AUTO_ADMIT=1");
  process.exit(2);
}

const { mkdirSync, writeFileSync } = await import("node:fs");
const out = process.argv[2] || null;
if (out) mkdirSync(out, { recursive: true });

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Router } = await imp("src/channels/router.js");
const { SendblueChannel } = await imp("src/channels/sendblue.js");
const { ConsoleChannel } = await imp("src/channels/console.js");
const { Runtime } = await imp("src/runtime.js");
const { FakeCallProvider } = await imp("src/calls/fake.js");
const { makeDeliver } = await imp("src/deliver.js");
const { createServer } = await imp("src/http.js");
const strangerCalls = await imp("src/strangercalls.js");
const stranger = await imp("src/calls/stranger.js");
const voice = await imp("src/calls/voice.js");
const db = await imp("src/db.js");
const { clock } = await imp("src/config.js");

const OWNER = process.env.REASON_OWNER_NUMBER;
const CALLER = "+13475559999";  // rang the line as a stranger, then texts
const OTHER = "+13475558888";   // never rang
let failed = 0;
const step = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`); };

// Every text Reason sends, as Sendblue would have received it.
const texts = [];
let handles = 0;
const fetchImpl = async (url, init = {}) => {
  const u = String(url);
  if ((init.method ?? "GET") === "POST" && /send-message|send-group-message/.test(u)) {
    let body = {};
    try { body = JSON.parse(init.body); } catch {}
    texts.push({ at: clock.now(), to: body.number, content: body.content ?? "", media: body.media_url ?? null });
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `drive-out-${++handles}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (/upload-file/.test(u)) {
    return new Response(JSON.stringify({ status: "OK", media_url: `https://cdn.example.test/drive-${++handles}.wav` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ data: [], messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
};

const logs = [];
const log = (e) => logs.push(e);
const calls = new FakeCallProvider();
const router = new Router({ log });
const consoleChannel = new ConsoleChannel({ write: () => {} });
const deliver = makeDeliver({ router, consoleChannel, log, warn: () => {} });
const runtime = new Runtime({ log, channels: router, calls, deliver });
router.runtime = runtime;
router.register(consoleChannel);
router.register(new SendblueChannel({ fetchImpl }));
runtime.on("outbound", async (e) => { await deliver({ ...e, media: null }); });
const server = createServer({ router, runtime, log });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

/** POST one signed Sendblue webhook, then wait for the turn it starts to end. */
async function inbound(content, from = OWNER) {
  const mark = logs.length;
  const handle = `drive-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const res = await fetch(`http://127.0.0.1:${port}/channels/sendblue/webhook`, {
    method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": "drive-secret" },
    body: JSON.stringify({ content, number: from, from_number: from, is_outbound: false, status: "RECEIVED", message_type: "message", message_handle: handle, date_sent: new Date().toISOString() }),
  });
  const body = await res.json().catch(() => ({}));
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    if (logs.slice(mark).some(e => e?.cli?.stop || e?.turn_failed)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 1500));
  await runtime.outbox();
  const tools = logs.slice(mark).filter(e => e?.tool).map(e => e.tool);
  return { status: res.status, body, tools };
}


// 1. The stranger's call as the line takes it: kept against the number, a pitch turn records what they asked. Placed "yesterday".
const kept = strangerCalls.open({ phone: CALLER, externalId: "conv_drive" });
const pitchTurn = stranger.strangerTurn({
  body: { model: "reason", messages: [{ role: "assistant", content: stranger.introLine() }, { role: "user", content: "How do I sign up?" }, { role: "assistant", content: "Go to hey reason dot com." }, { role: "user", content: "Can it book a dentist for me?" }], extra_body: { reason_kind: "stranger", reason_stranger_call: kept.id, reason_stranger_token: kept.token } },
  generate: async function* () { yield { type: "text", text: "It can, once you've texted it from hey reason dot com." }; },
  sseChunk: voice.sseChunk, SSE_DONE: voice.SSE_DONE,
});
for await (const _ of pitchTurn) { /* drained */ }
db.db.prepare("UPDATE stranger_calls SET started_at = started_at - 26 * 3600 * 1000 WHERE id = ?").run(kept.id);
const row = db.db.prepare("SELECT * FROM stranger_calls WHERE id = ?").get(kept.id);
step("the call is kept against the number, with what they asked", row.phone === CALLER && /dentist/.test(row.summary), row.summary);

const said = (to, from) => texts.filter(t => t.to === to && t.at >= from).map(t => t.content).join(" | ");
const RECONNECT = /reconnect|spoke on the phone|talked on the phone|on the phone yesterday|called .{0,20}yesterday/i;

// 2. Somebody else texts first: nothing about any call.
let t = clock.now();
await inbound("hey, what is this?", OTHER);
const other = said(OTHER, t);
step("a different number gets no reconnect", other && !RECONNECT.test(other), other);

// 3. The caller texts: their Reason recognises them, once.
t = clock.now();
await inbound("hey! saw the site, giving this a go", CALLER);
const first = said(CALLER, t);
step("first reply says it's good to reconnect", RECONNECT.test(first), first);
const conv = db.accountByNumber(CALLER)?.conversation_id;
const facts = conv ? JSON.stringify(db.recall(conv, "me")) : "";
step("the call is in THEIR memory", /Called Reason's number/.test(facts), facts.slice(0, 200));
const otherConv = db.accountByNumber(OTHER)?.conversation_id;
step("and in nobody else's", !otherConv || !/Called Reason's number/.test(JSON.stringify(db.recall(otherConv, "me"))));

t = clock.now();
await inbound("what can you do?", CALLER);
const second = said(CALLER, t);
step("the second reply does not repeat it", second && !RECONNECT.test(second), second);

server.close();
console.log(failed ? `FAIL (${failed})` : "ok");
process.exit(failed ? 1 : 0);
