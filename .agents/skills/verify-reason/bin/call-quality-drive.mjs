#!/usr/bin/env node
// Replay a whole own call (call 79's shape, 2026-11-08) through the REAL GPT-Live session and Reason's
// REAL call turn on claude-cli (the subscription, never the API), behind a fake Twilio stream into the
// real upgrade route — the same harness as gptlive-drive.mjs, with a script of caller clips instead of
// one question. A throwaway database seeded with a "today" thread (a bar picked by text at 12:08, "7 pm
// or later", a 6 pm reminder); nobody's phone rings and nothing is texted. ~3 min, ~15¢ of OpenAI voice.
//
// Run on the live server (OVH, root@15.204.113.250) from a copy of the code (main for "before", the branch for "after"):
//
//   E=$(sudo -u reason .agents/skills/verify-reason/bin/drive-env.sh OPENAI_API_KEY CLAUDE_CODE_OAUTH_TOKEN)   # keys never on argv
//   sudo -u reason env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/reason REASON_DB_PATH=$(sudo -u reason mktemp -d)/q.db \
//     node --env-file="$E" .agents/skills/verify-reason/bin/call-quality-drive.mjs <clips-dir> [--out file.json]; rm -f "$E"
//
// <clips-dir> holds 1.ulaw … N.ulaw (8 kHz mono μ-law, e.g. `say -o 1.aiff "…" && ffmpeg -i 1.aiff -ar
// 8000 -ac 1 -f mulaw 1.ulaw`). Each clip is played after Reason's reply to the one before has gone quiet
// for 1.5 s (or 25 s passed), the way a person waits for an answer. Prints one JSON object: per reply —
// what they said, what the caller heard Reason say, latency from the end of their clip to Reason's first
// speech, seconds of Reason's speech, holding lines (the code's, and the voice's own "let me check"
// phrasing), and any Reason speech that went out while their clip was still playing (talk-over).
// Totals at the end. Exits 0 unless a delegation never ran or the call never answered.
//
// --seed call80 (2026-11-08): call 80's world instead — a Sunday-afternoon "Call me", his saved places
// (work 430 W 17th, home 164 W 26th, the laundry), his week as facts ("works Thu to Sun shifts", embedded
// so a search by meaning finds them), the profile block call 80 had ("night shift every Monday"), and
// call 80's own rule ("on a call, just say the answer out loud…"). Texts go to a stand-in channel and are
// listed under `texted`. Each reply also gets `first_piece_ms` (Reason's first words handed to the voice)
// and the line's `hard_stops` (runs whose last 5 ms are still at voice level: no fade).
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
  console.error("usage: REASON_DB_PATH=… node --env-file=<bin/drive-env.sh file> call-quality-drive.mjs <clips-dir> [--out file.json]");
  process.exit(2);
}
Object.assign(process.env, {
  REASON_DATA_DIR: dirname(dbPath) + "/data", REASON_RECORDING_ROOT: dirname(dbPath) + "/recordings",
  REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner", REASON_WEB: "on",
  REASON_OWNER_NUMBER: "+12025550100", // REASON_DRIVE_CALL_BACKEND=api (owner-approved paid replays only, 11-08): the call turn on the API and
  // model live uses (REASON_CALL_MODEL from the env file), everything else still on claude-cli.
  ...(process.env.REASON_DRIVE_CALL_BACKEND === "api"
    ? { REASON_CALL_BACKEND: "api", REASON_CALL_MODEL: process.env.REASON_CALL_MODEL || "claude-sonnet-5-5" }
    : { ANTHROPIC_API_KEY: "", REASON_CALL_BACKEND: "claude-cli" }),
  REASON_BACKEND: "claude-cli",
  REASON_CALL_VOICE: "gptlive", REASON_CALL_IDENTITY: "owner", REASON_PUBLIC_URL: "http://127.0.0.1",
});
const flag = (k) => process.argv.indexOf(k);
const outFile = flag("--out") > 0 ? process.argv[flag("--out") + 1] : "";
const seedKind = flag("--seed") > 0 ? process.argv[flag("--seed") + 1] : "call79";
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
const seed80 = [
  ["user", `[${nyDay}, ${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(today)}] Omari: Call me`, -1],
  ["assistant", "Calling you now.", -1],
];
const thread = seedKind === "call80" ? seed80 : seed;
db.saveConversation(C, thread.map(([role, content]) => ({ role, content })));
for (const [role, text, minAgo] of thread) db.writeMessage({ conversationId: C, role, channel: "sendblue", text: text.replace(/^\[[^\]]*\]\s*Omari:\s*/, ""), at: nowMs + minAgo * 60_000 });
void stamp;
if (seedKind === "call80") {
  db.savePlace(C, { name: "work", address: "430 W 17th St, New York, NY 10011", lat: 40.7432, lng: -74.0064 });
  db.savePlace(C, { name: "home", address: "164 W 26th St, New York, NY 10001", lat: 40.7454, lng: -73.9935 });
  db.savePlace(C, { name: "Lionel's laundry", address: "150 W 25th St, New York, NY 10001", lat: 40.7446, lng: -73.9930 });
  const { embedAndStore } = await import(`${REPO}/src/embedding.js`);
  for (const f of ["Works Thu to Sun shifts", "Works a 12-hour shift", "His shift runs until 8pm", "Gets a ride home from work at 430 W 17th on a shift day"]) {
    const r = db.remember(C, "Omari", f);
    const id = r?.factId;
    if (id) await embedAndStore(C, id, `Omari: ${f}`).catch((e) => console.error("embed failed:", e.message));
  }
  db.saveProfile(C, "**Omari**\n- Night shift every Monday\n- Lives in Chelsea, Manhattan", []);
  db.addRule(C, { rule: "on a call, just say the answer out loud. don't offer to text it or stall with 'one sec'" });
}
// A stand-in texting channel: what Reason texts on the call is kept here, never sent.
const texted = [];
const channels = {
  list: () => [{ name: "sendblue" }],
  send: async (m) => { texted.push({ ms: streamClock.at ? Date.now() - streamClock.at : null, text: String(m?.text ?? m?.body ?? "").slice(0, 400) }); return { ok: true, delivered: true, handle: `fake-${texted.length}` }; },
  get: () => ({ readLocation: async () => ({ ok: true, sharing: false }), requestLocation: async () => { texted.push({ ms: Date.now() - streamClock.at, text: "[Share My Location card]" }); return { ok: true }; } }),
};
const row = db.createCall(C, { provider: "gptlive", toNumber: "+12025550100", isOwner: true, goal: "Omari asked to be called. Find out what he wants to talk about and help with it.", facts: [], announcement: "Hey Omari, what's up?", state: "placing" });

const lines = [];
const streamClock = { at: 0 };
const log = (o) => lines.push({ ...o, drive_ms: streamClock.at ? Date.now() - streamClock.at : null });
let call = null;
const server = createServer((_, res) => res.end());
server.on("upgrade", (req, socket) => {
  const path = new URL(req.url, "http://x").pathname;
  const ws = acceptUpgrade(req, socket);
  if (ws) call = gl.acceptStream({ token: path.slice(gl.STREAM_PATH.length), socket: ws, settle: settleCall, runtime: seedKind === "call80" ? { turnExtras: { channels } } : null, log });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const clips = readdirSync(clipsDir).filter(f => /^\d+\.ulaw$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b)).map(f => readFileSync(join(clipsDir, f)));
const speechAt = [];
// Every frame Reason sent down the line, for the fade check (the last 5 ms of each run).
const framesOut = [];
let hungUpAt = null;
const twilio = new WebSocket(`ws://127.0.0.1:${port}${gl.STREAM_PATH}${row.webhook_token}`);
let startAt = 0;
twilio.onmessage = (m) => {
  const e = JSON.parse(String(m.data));
  if (e.event === "media") framesOut.push({ ms: Date.now() - startAt, b: Buffer.from(e.media.payload, "base64") });
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
  // Reason's answer is in (no hand-off still running) and has gone quiet for 1.5 s, or 35 s: the way a
  // person waits through "one sec" for the answer before saying the next thing.
  const until = Date.now() + 35_000;
  // Their words handed over? Then Reason's answer must have come back and been spoken, then 1.5 s quiet.
  const resultAt = () => lines.filter(l => "gptlive_result" in l && l.drive_ms > p.from).at(-1)?.drive_ms ?? null;
  const handed = () => lines.some(l => "gptlive_delegation" in l && l.drive_ms > p.from);
  const answered = () => {
    const now = Date.now() - startAt;
    if (call?.pending?.size || !speechAt.some(ms => ms > p.to) || now - speechAt.at(-1) < 1500) return false;
    if (!handed()) return now - p.to > 3000;
    const r = resultAt();
    return r != null && speechAt.at(-1) > r;
  };
  await sleep(1500);
  while (Date.now() < until && hungUpAt == null && !answered()) await sleep(50);
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
const delegationAt = lines.filter(l => "gptlive_delegation" in l).map(l => l.drive_ms);
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
    // The backend's share: from their words to the model's first word or tool (voice_first_event, a
    // build that logs it), and what came after that before any sound — the code's and the voice's share.
    ...(() => {
      const d = delegationAt.find(ms => ms > p.from && ms < next);
      const f = d == null ? null : lines.find(l => "voice_first_event" in l && l.drive_ms >= d && l.drive_ms < next);
      if (!f) return {};
      return { backend_first_after_ms: f.drive_ms - p.to, silence_after_backend_ms: mine.length ? Math.max(0, mine[0].from - f.drive_ms) : null };
    })(),
    speech_s: Math.round(mine.reduce((n, r) => n + (r.to - r.from), 0) / 100) / 10,
    own_holding_phrase: OWN_HOLD.test(words.split(/[.!?]/)[0] ?? ""),
    talked_over_ms: Math.max(0, Math.round(over)),
    // Reason's first words handed to the voice, from the hand-off (streamed: the first sentence).
    first_piece_ms: (() => { const d = delegationAt.find(ms => ms > p.from && ms < next); const r = lines.find(l => "gptlive_result" in l && l.drive_ms > (d ?? Infinity) && l.drive_ms < next + 30_000); return r?.first_piece_ms ?? (r ? r.ms : null); })(),
  };
});
const pick = (k) => lines.filter(l => k in l);
// A run ends hard when the last frame with speech in it still carries voice level in its final 5 ms.
const rms = (b, from, to) => { let s = 0; for (let i = from; i < to; i++) { const x = gl.ulawToPcm(b[i]); s += x * x; } return Math.sqrt(s / Math.max(1, to - from)); };
let hardStops = 0, runEnds = 0;
for (let i = 0; i < framesOut.length; i++) {
  const f = framesOut[i];
  const next = framesOut[i + 1];
  if (!gl.hasSpeech(f.b.toString("base64")) || (next && gl.hasSpeech(next.b.toString("base64")))) continue;
  runEnds++;
  if (rms(f.b, f.b.length - 40, f.b.length) > 1000) hardStops++;
}

const results = pick("gptlive_result");
const out = {
  code: process.env.DRIVE_LABEL ?? "",
  // Who said what when (ms from the stream's start), and when each of Reason's answers came back.
  timeline: [
    ...(call?.turns ?? []).filter(t => !t.seeded).map(t => ({ ms: Math.round((t.from ?? t.at) - startAt), who: t.who, text: t.text.replace(/\s+/g, " ").trim().slice(0, 300) })),
    ...lines.filter(l => "gptlive_result" in l || "gptlive_delegation" in l || "gptlive_hold_line" in l || "gptlive_reply_cut" in l || "gptlive_talkover_held" in l || "gptlive_talkover_dropped" in l)
      .map(l => ({ ms: l.drive_ms, who: "code", text: JSON.stringify(Object.fromEntries(Object.entries(l).filter(([k]) => k !== "drive_ms"))) })),
  ].sort((a, b) => a.ms - b.ms),
  replies,
  // When each clip of theirs played and each run of Reason's speech reached the line (ms), for talk-over.
  played: played.map(p => [p.from, p.to]),
  speech_runs: runs.map(r => [r.from, r.to]),
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
    hard_stops: hardStops, run_ends: runEnds,
    lead_ins_dropped: pick("voice_lead_in_dropped").length,
    recall_late: pick("call_recall_late").length,
    tools_ran: pick("call_tool").map(l => `${l.call_tool}:${l.ok ? "ok" : "failed"}`),
    unbacked_send_swaps: pick("gptlive_unbacked_send").length,
    texted,
    errors: pick("gptlive_error").length,
  },
};
const json = JSON.stringify(out, null, 1);
if (outFile) writeFileSync(outFile, json);
console.log(json);
const ok = out.totals.delegations > 0 && results.length > 0 && speechAt.length > 0;
console.log(ok ? "ok" : "FAIL");
process.exit(ok ? 0 : 1);
