#!/usr/bin/env node
// Drive a GPT-Live call end to end with no phone: a fake Twilio media stream (a Node WebSocket client
// streaming a μ-law recording in real time) into the REAL upgrade route (src/calls/wsserver.js +
// gptlive.acceptStream), a REAL GPT-Live session on OpenAI (bills the voice layer, $0.05/min — about
// 2¢ a run), and Reason's REAL call turn on claude-cli (the subscription, never the API) behind it
// through client delegation. A throwaway database; nobody's phone rings and nothing is texted.
//
// Run on the Hetzner box, where OPENAI_API_KEY and the claude-cli login live, from a copy of the code:
//
//   REASON_DB_PATH=$(mktemp -d)/gl.db OPENAI_API_KEY=… CLAUDE_CODE_OAUTH_TOKEN=… \
//     node .agents/skills/verify-reason/bin/gptlive-drive.mjs caller.ulaw [seconds] [--expect identity] [--cold] [--ring ms]
//
// By default the call is placed the way the live one is: the voice is warmed up (`gptlive.prewarm`) and
// the phone "rings" for --ring ms (5000) before the stream starts. --cold skips that (the old path), for
// a before/after. Every run prints first_voice_ms: stream start to the first frame of speech the caller
// got (call 53, before the warm-up: 3,100 ms). --expect identity asks "do you know who I am? what's my
// name?" and passes only if the voice answers with the name, warmly, straight from its instructions.
// --expect made asks "who made you?": Omarion Nyarko for the operator, the Reason team (no name) for anyone else.
//
// caller.ulaw is raw 8 kHz mono μ-law (Mac: say -o q.aiff "…" && ffmpeg -i q.aiff -ar 8000 -ac 1 -f mulaw q.ulaw).
// Prints one JSON line: what Reason was asked, what it answered, what the voice said, what the
// caller heard when, the guard's trips, and the settled row. Exits non-zero unless a delegation went
// to Reason and the voice spoke after Reason's answer.
const { resolve, dirname } = await import("node:path");
const { existsSync, readFileSync, realpathSync } = await import("node:fs");
const { createServer } = await import("node:http");
const { tmpdir } = await import("node:os");
const dbPath = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
const parent = dbPath && existsSync(dirname(dbPath)) ? realpathSync(dirname(dbPath)) + "/" : "";
const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
if (!dbPath || existsSync(dbPath) || !parent || !roots.some(r => parent.startsWith(r))) {
  console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/gl.db");
  process.exit(2);
}
if (!process.env.OPENAI_API_KEY || !process.argv[2]) {
  console.error("usage: OPENAI_API_KEY=… REASON_DB_PATH=… gptlive-drive.mjs caller.ulaw [seconds]");
  process.exit(2);
}
Object.assign(process.env, {
  REASON_DATA_DIR: dirname(dbPath) + "/data", REASON_RECORDING_ROOT: dirname(dbPath) + "/recordings",
  REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner",
  REASON_OWNER_NUMBER: "+12025550100", ANTHROPIC_API_KEY: "", REASON_CALL_BACKEND: "claude-cli",
  REASON_CALL_VOICE: "gptlive", ELEVENLABS_LLM_SECRET: "drive-secret", REASON_PUBLIC_URL: "http://127.0.0.1",
});
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "../../../..");
const gl = await import(`${REPO}/src/calls/gptlive.js`);
const { acceptUpgrade } = await import(`${REPO}/src/calls/wsserver.js`);
const voice = await import(`${REPO}/src/calls/voice.js`);
const db = await import(`${REPO}/src/db.js`);
const { settleCall } = await import(`${REPO}/src/tools.js`);
const { config } = await import(`${REPO}/src/config.js`);
await voice.prime();

const C = config.ownerConversation;
db.saveConversation(C, []);
db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025550100", name: "Omari", isOperator: true });
// A little of what Reason knows about him, as the real profile block reads, so the voice has it to hand.
db.saveProfile(C, "**Omari**\n- Commutes to work on the 2 and 5 trains\n- Has a daily protein target of 170g", []);
// --as owner (default): the operator's own call. --as user: ANOTHER user's own call (Ama, not the
// operator) — her Reason must know her and nothing of Omari's. --as third: a call Reason makes for Omari
// to a business — "I'm Reason, calling for Omari", none of his profile, opens silent (no warm session).
const as = process.argv.indexOf("--as") > 0 ? process.argv[process.argv.indexOf("--as") + 1] : "owner";
const AMA = "sendblue:+13105550000";
db.saveConversation(AMA, []);
db.upsertAccount({ conversationId: AMA, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
db.saveProfile(AMA, "**Ama**\n- Is allergic to peanuts", []);
const row = as === "user"
  ? db.createCall(AMA, { provider: "gptlive", toNumber: "+13105550000", isOwner: true, goal: "a test call from the verify drive", facts: [], announcement: "Hey Ama, it's Reason.", state: "placing" })
  : as === "third"
    ? db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "ask whether they have a table for two at 7 tonight", facts: [], announcement: "", state: "placing" })
    : db.createCall(C, { provider: "gptlive", toNumber: "+12025550100", isOwner: true, goal: "a test call from the verify drive", facts: [], announcement: "Hey Omari, it's Reason.", state: "placing" });
const CONV = row.conversation_id;

const lines = [];
const log = (o) => lines.push(o);
let call = null;
const server = createServer((_, res) => res.end());
server.on("upgrade", (req, socket) => {
  const path = new URL(req.url, "http://x").pathname;
  const ws = acceptUpgrade(req, socket);
  if (ws) call = gl.acceptStream({ token: path.slice(gl.STREAM_PATH.length), socket: ws, settle: settleCall, runtime: null, log });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const audio = readFileSync(process.argv[2]);
const seconds = Number(process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : 25);
const flag = (k) => process.argv.indexOf(k);
const expect = flag("--expect") > 0 ? process.argv[flag("--expect") + 1] : "delegation";
const cold = flag("--cold") > 0;
const ringMs = flag("--ring") > 0 ? Number(process.argv[flag("--ring") + 1]) : 5000;
if (!cold) {
  gl.prewarm(db.getCall(CONV, row.id), { log });
  await new Promise(r => setTimeout(r, ringMs));
}
const heardAt = [];
const speechAt = [];
const t0 = Date.now();
let startAt = 0;
const twilio = new WebSocket(`ws://127.0.0.1:${port}${gl.STREAM_PATH}${row.webhook_token}`);
twilio.onmessage = (m) => {
  const e = JSON.parse(String(m.data));
  if (e.event !== "media") return;
  heardAt.push(Date.now() - t0);
  if (gl.hasSpeech(e.media.payload)) speechAt.push(Date.now() - startAt);
};
await new Promise((r, j) => { twilio.onopen = r; twilio.onerror = () => j(new Error("the stream socket did not open")); });
twilio.send(JSON.stringify({ event: "connected" }));
startAt = Date.now();
twilio.send(JSON.stringify({ event: "start", start: { streamSid: "MZdrive", callSid: "CAdrive" } }));
// 3 s of line, the question, then silence — in real time, as Twilio sends it.
const frames = [];
const silence = Buffer.alloc(160, 0xff);
for (let i = 0; i < 150; i++) frames.push(silence);
for (let i = 0; i < audio.length; i += 160) frames.push(audio.subarray(i, i + 160));
while (frames.length < seconds * 50) frames.push(silence);
let i = 0;
await new Promise((r) => {
  const tick = setInterval(() => {
    if (i >= frames.length) { clearInterval(tick); return r(); }
    twilio.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: frames[i++].toString("base64") } }));
  }, 20);
});
twilio.send(JSON.stringify({ event: "stop" }));
const until = Date.now() + 20_000;
while (Date.now() < until && db.getCall(CONV, row.id)?.state === "in_progress") await new Promise(r => setTimeout(r, 250));
server.close();

const settled = db.getCall(CONV, row.id);
// When their question ended, and when the first speech after it reached them.
const askedEndMs = 3000 + (audio.length / 8);
const answerAt = speechAt.find(ms => ms > askedEndMs + 200);
const turns = db.callTurns(row.id);
const pick = (k) => lines.filter(l => k in l);
const out = {
  delegations: pick("gptlive_delegation").length,
  results: pick("gptlive_result").map(l => ({ ms: l.ms, chars: l.chars, tools: l.tools, error: l.error })),
  guard_trips: pick("gptlive_guard").length,
  voice_said: call?.turns.filter(t => t.who === "reason" && !t.seeded).map(t => t.text.trim()) ?? [],
  caller_said: call?.turns.filter(t => t.who === "them").map(t => t.text.trim()) ?? [],
  audio_frames_to_caller: heardAt.length,
  warm: !cold, ring_ms: cold ? 0 : ringMs,
  first_voice_ms: speechAt[0] ?? null,
  answer_after_question_ms: answerAt == null ? null : Math.round(answerAt - askedEndMs),
  turns: turns.map(t => ({ voice: t.voice, heard_ms: t.first_content_ms, real_ms: t.first_real_ms, total_ms: t.total_ms, tools: t.tools })),
  row: { state: settled.state, provider: settled.provider, end_reason: settled.end_reason, duration_s: settled.duration_s, cost_cents: settled.cost_cents, recording: settled.recording_state, tts_model: settled.tts_model },
  errors: pick("gptlive_error"),
};
const afterQuestion = (call?.turns ?? []).slice((call?.turns ?? []).findIndex(t => t.who === "them") + 1).filter(t => t.who === "reason").map(t => t.text).join(" ");
out.answer = afterQuestion.trim();
const leak = /peanut|2 and 5|protein|170/i;
const ok = expect === "made"
  ? (as === "user" ? /team/i.test(afterQuestion) && !/Omarion|Nyarko|\bOmari\b/i.test(out.voice_said.join(" ")) : /Omarion/i.test(afterQuestion)) && out.guard_trips === 0
  : expect === "identity" && as === "third"
  ? /\bReason\b/.test(afterQuestion) && /\bOmari\b/.test(afterQuestion) && !leak.test(out.voice_said.join(" ")) && out.guard_trips === 0
  : expect === "identity"
  ? new RegExp(`\\b${as === "user" ? "Ama" : "Omari"}\\b`).test(afterQuestion) && !/don['’]t know|not sure who/i.test(afterQuestion)
    && (as !== "user" || !/\bOmari\b|2 and 5|protein/i.test(out.voice_said.join(" "))) && out.guard_trips === 0 && (cold || (out.first_voice_ms ?? Infinity) < 600)
  : out.delegations > 0 && out.results.some(r => r.chars > 0) && turns.some(t => Number.isFinite(t.first_real_ms));
console.log(JSON.stringify({ as, expect, ...out }, null, 1));
console.log(ok ? "ok" : "FAIL");
process.exit(ok ? 0 : 1);
