#!/usr/bin/env node
// Replay a whole own call (call 79's shape, 2026-11-08) through the REAL GPT-Live session and Reason's
// REAL call turn on claude-cli (the subscription, never the API), behind a fake Twilio stream into the
// real upgrade route — the same harness as gptlive-drive.mjs, with a script of caller clips instead of
// one question. A throwaway database seeded with a "today" thread (a bar picked by text at 12:08, "7 pm
// or later", a 6 pm reminder); nobody's phone rings and nothing is texted. ~3 min, ~15¢ of OpenAI voice.
//
// Run on the Hetzner box from a copy of the code (main for "before", the branch for "after"):
//
//   sudo -u reason env -i PATH=… HOME=/home/reason OPENAI_API_KEY=… CLAUDE_CODE_OAUTH_TOKEN=… \
//     REASON_DB_PATH=$(sudo -u reason mktemp -d)/q.db node .agents/skills/verify-reason/bin/call-quality-drive.mjs <clips-dir> [--out file.json]
//
// <clips-dir> holds 1.ulaw … N.ulaw (8 kHz mono μ-law, e.g. `say -o 1.aiff "…" && ffmpeg -i 1.aiff -ar
// 8000 -ac 1 -f mulaw 1.ulaw`). Each clip is played after Reason's reply to the one before has gone quiet
// for 1.5 s (or 25 s passed), the way a person waits for an answer. Prints one JSON object: per reply —
// what they said, what the caller heard Reason say, latency from the end of their clip to Reason's first
// speech, seconds of Reason's speech, holding lines (the code's, and the voice's own "let me check"
// phrasing), and any Reason speech that went out while their clip was still playing (talk-over).
// Totals at the end. Exits 0 unless a delegation never ran or the call never answered.
const { resolve, dirname, join } = await import("node:path");
const { existsSync, readFileSync, realpathSync, readdirSync, writeFileSync } = await import("node:fs");
const { createServer } = await import("node:http");
const { tmpdir } = await import("node:os");
const dbPath = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
const parent = dbPath && existsSync(dirname(dbPath)) ? realpathSync(dirname(dbPath)) + "/" : "";
const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
if (!dbPath || existsSync(dbPath) || !parent || !roots.some(r => parent.startsWith(r))) {
  console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/q.db");
  process.exit(2);
}
const clipsDir = process.argv[2];
if (!process.env.OPENAI_API_KEY || !clipsDir || !existsSync(clipsDir)) {
  console.error("usage: OPENAI_API_KEY=… REASON_DB_PATH=… call-quality-drive.mjs <clips-dir> [--out file.json]");
  process.exit(2);
}
Object.assign(process.env, {
  REASON_DATA_DIR: dirname(dbPath) + "/data", REASON_RECORDING_ROOT: dirname(dbPath) + "/recordings",
  REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner", REASON_WEB: "on",
  REASON_OWNER_NUMBER: "+12025550100", ANTHROPIC_API_KEY: "", REASON_CALL_BACKEND: "claude-cli", REASON_BACKEND: "claude-cli",
  REASON_CALL_VOICE: "gptlive", REASON_CALL_IDENTITY: "owner", REASON_PUBLIC_URL: "http://127.0.0.1",
});
const flag = (k) => process.argv.indexOf(k);
const outFile = flag("--out") > 0 ? process.argv[flag("--out") + 1] : "";
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "../../../..");
const gl = await import(`${REPO}/src/calls/gptlive.js`);
const { acceptUpgrade } = await import(`${REPO}/src/calls/wsserver.js`);
const voice = await import(`${REPO}/src/calls/voice.js`);
const db = await import(`${REPO}/src/db.js`);
const { settleCall } = await import(`${REPO}/src/tools.js`);
const { config } = await import(`${REPO}/src/config.js`);
await voice.prime();

const C = config.ownerConversation;
db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025550100", name: "Omari", isOperator: true });
// Today's thread, as call 79's was (paraphrased): the bar Reason picked, his "7 or later", the reminder.
const today = new Date();
const stamp = (h, m) => { const d = new Date(today); d.setHours(h, m, 0, 0); return d.getTime(); };
const nyDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(today);
const nowMs = Date.now();
const seed = [
  ["user", `[${nyDay}, 12:08 PM] Omari: I want a place in Manhattan with a nice bar that's fairly active on a Tuesday night, somewhere I can go solo and meet people.`, -170],
  ["assistant", "My pick is Bo Peep. It's the cocktail bar downstairs from The Ragtrader, at 70 W 36th St in Midtown. Tuesday is their sing-along night, so the bar gets chatty. Backups: Pebble Bar near Rockefeller Center, and Joe's Pub on Lafayette.", -169],
  ["user", `[${nyDay}, 12:11 PM] Omari: Nice, I'll check the first one out`, -166],
  ["assistant", "Nice, hope you have fun there. Bo Peep is at 70 W 36th St, downstairs from The Ragtrader. Want me to remind you Tuesday?", -165],
  ["user", `[${nyDay}, 12:14 PM] Omari: Oh yeah. Will head there around like 7 pm or later`, -163],
  ["assistant", "Done, I'll text you Tuesday at 6pm so you can head over for 7.", -162],
  ["user", `[${nyDay}, 2:57 PM] Omari: Call me`, -1],
  ["assistant", "Calling you now.", -1],
];
db.saveConversation(C, seed.map(([role, content]) => ({ role, content })));
for (const [role, text, minAgo] of seed) db.writeMessage({ conversationId: C, role, channel: "sendblue", text: text.replace(/^\[[^\]]*\]\s*Omari:\s*/, ""), at: nowMs + minAgo * 60_000 });
void stamp;
const row = db.createCall(C, { provider: "gptlive", toNumber: "+12025550100", isOwner: true, goal: "Omari asked to be called. Find out what he wants to talk about and help with it.", facts: [], announcement: "Hey Omari, what's up?", state: "placing" });

const lines = [];
const streamClock = { at: 0 };
const log = (o) => lines.push({ ...o, drive_ms: streamClock.at ? Date.now() - streamClock.at : null });
let call = null;
const server = createServer((_, res) => res.end());
server.on("upgrade", (req, socket) => {
  const path = new URL(req.url, "http://x").pathname;
  const ws = acceptUpgrade(req, socket);
  if (ws) call = gl.acceptStream({ token: path.slice(gl.STREAM_PATH.length), socket: ws, settle: settleCall, runtime: null, log });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const clips = readdirSync(clipsDir).filter(f => /^\d+\.ulaw$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b)).map(f => readFileSync(join(clipsDir, f)));
const speechAt = [];
let hungUpAt = null;
const twilio = new WebSocket(`ws://127.0.0.1:${port}${gl.STREAM_PATH}${row.webhook_token}`);
let startAt = 0;
twilio.onmessage = (m) => {
  const e = JSON.parse(String(m.data));
  if (e.event === "media" && gl.hasSpeech(e.media.payload)) speechAt.push(Date.now() - startAt);
};
await new Promise((r, j) => { twilio.onopen = r; twilio.onerror = () => j(new Error("the stream socket did not open")); });
twilio.onclose = () => { hungUpAt ??= Date.now() - startAt; };
twilio.send(JSON.stringify({ event: "connected" }));
startAt = Date.now();
streamClock.at = startAt;
twilio.send(JSON.stringify({ event: "start", start: { streamSid: "MZq", callSid: "CAq" } }));

const silence = Buffer.alloc(160, 0xff);
const sendFrame = (b) => twilio.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: b.toString("base64") } }));
// Real time, 20 ms a frame, like Twilio; frames are sent on a steady clock so the line never stalls.
let queue = [];
const tick = setInterval(() => { if (hungUpAt == null) sendFrame(queue.length ? queue.shift() : silence); }, 20);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const playClip = async (buf) => {
  const frames = [];
  for (let i = 0; i < buf.length; i += 160) { const f = Buffer.alloc(160, 0xff); buf.copy(f, 0, i, Math.min(buf.length, i + 160)); frames.push(f); }
  const from = Date.now() - startAt;
  queue.push(...frames);
  while (queue.length && hungUpAt == null) await sleep(20);
  return { from, to: Date.now() - startAt };
};
// Wait for the greeting, then each clip after Reason's reply has gone quiet.
const quietFor = async (ms, max) => {
  const until = Date.now() + max;
  while (Date.now() < until && hungUpAt == null) {
    const now = Date.now() - startAt;
    const last = speechAt.at(-1) ?? 0;
    if (speechAt.length && now - last >= ms) return;
    await sleep(50);
  }
};
await quietFor(1200, 8000);
const played = [];
for (const [i, clip] of clips.entries()) {
  if (hungUpAt != null) break;
  await sleep(i === 0 ? 300 : 600);
  const p = await playClip(clip);
  played.push(p);
  // A reply has started and gone quiet for 1.5 s (a reply with a pause in it carries on), or 25 s.
  const until = Date.now() + 25_000;
  while (Date.now() < until && hungUpAt == null && !(speechAt.some(ms => ms > p.to) && Date.now() - startAt - speechAt.at(-1) >= 1500)) await sleep(50);
}
await sleep(4000);
clearInterval(tick);
if (hungUpAt == null) twilio.send(JSON.stringify({ event: "stop" }));
const until = Date.now() + 20_000;
while (Date.now() < until && db.getCall(C, row.id)?.state === "in_progress") await sleep(250);
server.close();

// Reason's speech frames, grouped into runs (a gap over 700 ms starts a new one).
const runs = [];
for (const ms of speechAt) {
  const r = runs.at(-1);
  if (r && ms - r.to <= 700) r.to = ms + 20; else runs.push({ from: ms, to: ms + 20 });
}
const OWN_HOLD = /\b(?:let me (?:check|look|see|think)|lemme (?:check|look|have a)|looking (?:that|it) up|checking|hang on|hold on|one sec(?:ond)?|give me a (?:sec|moment)|just a (?:sec|moment)|bear with me)\b/i;
const reasonTurns = (call?.turns ?? []).filter(t => t.who === "reason" && !t.seeded);
const theirTurns = (call?.turns ?? []).filter(t => t.who === "them");
const replies = played.map((p, i) => {
  const next = played[i + 1]?.from ?? Infinity;
  const mine = runs.filter(r => r.from > p.to - 200 && r.from < next);
  const over = runs.filter(r => r.to > p.from + 100 && r.from < p.to - 100).reduce((n, r) => n + (Math.min(r.to, p.to) - Math.max(r.from, p.from)), 0);
  const words = reasonTurns.filter(t => t.at - startAt > p.to - 500 && t.at - startAt < next + 1500).map(t => t.text.replace(/\s+/g, " ").trim()).join(" ");
  return {
    them: theirTurns.find(t => t.at - startAt > p.from && t.at - startAt < next + 3000)?.text.replace(/\s+/g, " ").trim() ?? "",
    reason: words,
    first_speech_after_ms: mine.length ? mine[0].from - p.to : null,
    speech_s: Math.round(mine.reduce((n, r) => n + (r.to - r.from), 0) / 100) / 10,
    own_holding_phrase: OWN_HOLD.test(words.split(/[.!?]/)[0] ?? ""),
    talked_over_ms: Math.max(0, Math.round(over)),
  };
});
const pick = (k) => lines.filter(l => k in l);
const results = pick("gptlive_result");
const out = {
  code: process.env.DRIVE_LABEL ?? "",
  replies,
  totals: {
    clips: played.length,
    delegations: pick("gptlive_delegation").length,
    result_ms: results.map(l => l.ms),
    result_chars: results.map(l => l.chars),
    code_hold_lines: pick("gptlive_hold_line").map(l => ({ kind: l.kind, line: l.line, ms: l.ms, tool: l.tool })),
    replies_opening_with_holding_phrase: replies.filter(r => r.own_holding_phrase).length,
    replies_cut: pick("gptlive_reply_cut").length,
    talkover_held: pick("gptlive_talkover_held").map(l => l.held_ms),
    talkover_dropped: pick("gptlive_talkover_dropped").length,
    talked_over_ms_total: replies.reduce((n, r) => n + r.talked_over_ms, 0),
    first_voice_ms: speechAt[0] ?? null,
    first_answer_after_ms: replies[0]?.first_speech_after_ms ?? null,
    median_answer_after_ms: (() => { const a = replies.map(r => r.first_speech_after_ms).filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; })(),
    longest_reply_s: Math.max(0, ...replies.map(r => r.speech_s)),
    said_nothing_saved: /don['’]t have (?:anything|that)|nothing saved/i.test(replies.map(r => r.reason).join(" ")),
    pushed_past_their_time: /after (?:9|nine)/i.test(replies.map(r => r.reason).join(" ")),
    guard_trips: pick("gptlive_guard").length,
    errors: pick("gptlive_error").length,
  },
};
const json = JSON.stringify(out, null, 1);
if (outFile) writeFileSync(outFile, json);
console.log(json);
const ok = out.totals.delegations > 0 && results.length > 0 && speechAt.length > 0;
console.log(ok ? "ok" : "FAIL");
process.exit(ok ? 0 : 1);
