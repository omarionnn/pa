#!/usr/bin/env node
// The Cartesia listening test (an owner-only experiment, 2026-11-12; docs/calls-cartesia.md). Eight
// short lines in Reason's own phone voice, said by five Cartesia voices, each made twice — exactly as
// a call would carry it (8 kHz μ-law, in a .wav) and at full quality — with how long each took to
// start sounding. Nothing here is on the call path: it reads a key, makes audio files and one page to
// play them from. No call is placed and nothing on the server is read or changed.
//
//   node scripts/cartesia-listen.mjs --dry-run       the plan and its size; calls nobody
//   node scripts/cartesia-listen.mjs                 makes the folder (needs CARTESIA_API_KEY)
//   node scripts/cartesia-listen.mjs --today         also today's call voice, for comparison (OPENAI_API_KEY)
//   node scripts/cartesia-listen.mjs --emotion       also each line with its emotion asked for (beta)
//   node scripts/cartesia-listen.mjs --voices gemma,lucy,fiona,pippa      a British-only pass (or any voice id / name)
//   node scripts/cartesia-listen.mjs --lines laugh,heavy --out <dir>
//   node scripts/cartesia-listen.mjs --list-voices [words]    British women's voices to pick from; free
//
// A real run SPENDS Cartesia credits (about 6,700 for the full set; the dry run says exactly). At a
// terminal it just runs; from a script or an agent's shell it runs only with --yes.
// The key: CARTESIA_API_KEY from the environment, else ./.env, else ~/Desktop/pa/.env. Never printed.
// Docs read 2026-11-12 (docs.cartesia.ai): api-reference/tts/websocket (the request, `chunk`/`done`/
// `error`), api-reference/voices/list, use-the-api/api-conventions (X-API-Key, Cartesia-Version),
// capability-guides/volume-speed-emotion ([laughter], the emotion list), tts-models/latest (voice ids).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { ulawToPcm } from "../src/calls/ulaw.js";

export const VERSION = "2026-08-14";
export const MODEL = "sonic-3.6";
/** Cartesia's API. CARTESIA_API_BASE points it at a stand-in (the script's own end-to-end check). */
export const apiBase = () => (process.env.CARTESIA_API_BASE || "https://api.cartesia.ai").replace(/\/+$/, "");

/**
 * The lines, written for the ear. `[laughter]` is Cartesia's own tag for a laugh; `emotion` is what
 * --emotion asks for on that line (values from their list), empty where the words carry it alone.
 * The phone number is one kept for fiction (555-01xx), written plain so their normalizer groups it.
 */
export const LINES = [
  { id: "greeting", what: "a greeting", emotion: "happy", text: "Oh, hey! Good to hear from you. How's your day going?" },
  { id: "time", what: "a quick answer, with a time", emotion: "", text: "Yep, you're fine. The train's at quarter past six, so you've got about forty minutes." },
  { id: "bad-news", what: "bad news, then the best alternative", emotion: "apologetic", text: "So, bad news: they're fully booked tonight. But they've got a table at half eight tomorrow, and I can grab it right now if you want." },
  { id: "laugh", what: "something funny, answered with a real laugh", emotion: "", text: "Wait, he turned up in a full tuxedo? [laughter] Oh, that's brilliant. Okay, that is going straight in the diary." },
  { id: "mm-hm", what: "a soft go-on", emotion: "calm", text: "Mm-hm. Go on." },
  { id: "number", what: "a number read back in groups", emotion: "", text: "Okay, reading that back: 212-555-0147. Have I got that right?" },
  { id: "heavy", what: "a heavy moment, handled gently", emotion: "sympathetic", text: "Oh, I'm so sorry. That's a lot to carry. Take all the time you need, I'm right here, and everything else can wait." },
  { id: "goodbye", what: "a warm goodbye", emotion: "affectionate", text: "Alright, you're all set. Go and enjoy your evening, and ring me if anything comes up. Bye for now!" },
];

/**
 * The voices, picked from Cartesia's own lists and catalogue (read 2026-11-12): two it suggests for
 * agents ("stable"), two it lists for emotional range, and the British woman its own description puts
 * nearest today's persona. No voice of theirs is labelled young or London: the ear decides.
 */
export const VOICES = [
  { key: "gemma", name: "Gemma", id: "62ae83ad-4f6a-430b-af41-a9bede9286ca", kind: "agent", locale: "en-GB" },
  { key: "skylar", name: "Skylar", id: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", kind: "agent", locale: "en-US" },
  { key: "lucy", name: "Lucy", id: "2f251ac3-89a9-4a77-a452-704b474ccd01", kind: "emotive", locale: "en-GB" },
  { key: "tessa", name: "Tessa", id: "6ccbfb76-1fc6-48f7-b71d-91ac6298247b", kind: "emotive", locale: "en-US" },
  { key: "fiona", name: "Fiona", id: "a01c369f-6d2d-4185-bc20-b32c225eab70", kind: "persona", locale: "en-GB" },
];
/** More to try by name with --voices: other British women, and two more from the emotional lists. */
export const MORE_VOICES = [
  { key: "pippa", name: "Pippa", id: "81cd8d19-45e7-47b2-ad0e-bcd94f557ad0", kind: "chosen", locale: "en-GB" },
  { key: "charlotte", name: "Charlotte", id: "71a7ad14-091c-4e8e-a314-022ece01c121", kind: "chosen", locale: "en-GB" },
  { key: "saira", name: "Saira", id: "1e9b9b3d-d2ce-4cac-9d05-bc36a63fa28e", kind: "chosen", locale: "en-GB" },
  { key: "maya", name: "Maya", id: "cbaf8084-f009-4838-a096-07ee2e6612b1", kind: "emotive", locale: "en-US" },
  { key: "ariana", name: "Ariana", id: "ec1e269e-9ca0-402f-8a18-58e0e022355a", kind: "emotive", locale: "en-US" },
];

/** The two ways each line is made. The phone one is byte for byte what Twilio would be sent. */
export const FORMATS = [
  { key: "phone", output: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 }, rate: 8000, ulaw: true },
  { key: "full", output: { container: "raw", encoding: "pcm_s16le", sample_rate: 44100 }, rate: 44100, ulaw: false },
];

/** Today's persona, as src/calls/opener.js asks OpenAI's speech model for it (the test holds the two together). */
export const TODAY_PERSONA = "A young woman with a light, natural British (London) accent — warm, quick, relaxed, like a friend on the phone.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- the pure parts ----------

/**
 * Raw audio as a .wav any player opens: G.711 μ-law (format 7, with the `fact` chunk a non-PCM file
 * carries) or 16-bit PCM. Mono. The μ-law bytes are not touched: the file holds what the line carries.
 */
export function wav(body, { rate, ulaw = false }) {
  const fmt = ulaw ? 18 : 16;
  const pad = body.length % 2;
  const h = Buffer.alloc(20 + fmt + (ulaw ? 12 : 0) + 8);
  let o = 0;
  h.write("RIFF", o); h.writeUInt32LE(h.length - 8 + body.length + pad, o + 4); h.write("WAVE", o + 8); o += 12;
  h.write("fmt ", o); h.writeUInt32LE(fmt, o + 4); o += 8;
  h.writeUInt16LE(ulaw ? 7 : 1, o); h.writeUInt16LE(1, o + 2); h.writeUInt32LE(rate, o + 4);
  h.writeUInt32LE(ulaw ? rate : rate * 2, o + 8); h.writeUInt16LE(ulaw ? 1 : 2, o + 12); h.writeUInt16LE(ulaw ? 8 : 16, o + 14);
  o += fmt;
  if (ulaw) { h.write("fact", o); h.writeUInt32LE(4, o + 4); h.writeUInt32LE(body.length, o + 8); o += 12; }
  h.write("data", o); h.writeUInt32LE(body.length, o + 4);
  return Buffer.concat([h, body, Buffer.alloc(pad)]);
}

/** Count, median and worst of some times in ms (nothing measured: nulls). */
export function stats(ms) {
  const a = ms.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return { n: 0, median: null, worst: null };
  const m = a.length >> 1;
  return { n: a.length, median: Math.round(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2), worst: Math.round(a.at(-1)) };
}

/** How much quiet a μ-law clip opens with, in ms: the first byte is not yet the first sound. */
export function leadMs(ulaw, { peak = 600 } = {}) {
  const i = ulaw.findIndex(u => Math.abs(ulawToPcm(u)) > peak);
  return Math.round((i < 0 ? ulaw.length : i) / 8);
}

/** A line with Cartesia's tags taken out, for a speech model that would read them aloud. */
export const plain = (text) => String(text).replace(/\[[a-z]+\]|<[^>]+>/gi, " ").replace(/\s+/g, " ").trim();

/** The lines and voices a run asks for. Throws, in words, on one it does not know. */
export function pick({ lines = "", voices = "" } = {}) {
  const want = (s) => String(s ?? "").split(",").map(x => x.trim()).filter(Boolean);
  const ls = want(lines).map(id => LINES.find(l => l.id === id) ?? (() => { throw new Error(`no line "${id}" (there are: ${LINES.map(l => l.id).join(", ")})`); })());
  const vs = want(voices).map(v => [...VOICES, ...MORE_VOICES].find(x => x.key === v.toLowerCase()) ?? (UUID.test(v) ? { key: v.slice(0, 8), name: "", id: v, kind: "chosen", locale: "" } : { key: v.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: v, id: "", kind: "chosen", locale: "" }));
  return { lines: ls.length ? ls : LINES, voices: vs.length ? vs : VOICES };
}

/** What a run makes and roughly what it uses: Cartesia bills about one credit a character. */
export function plan({ lines, voices, emotion = false, today = false }) {
  const chars = lines.reduce((n, l) => n + l.text.length, 0);
  const felt = lines.filter(l => l.emotion);
  const each = (lines.length + (emotion ? felt.length : 0)) * FORMATS.length;
  return {
    clips: each * voices.length + (today ? lines.length * FORMATS.length : 0),
    credits: (chars + (emotion ? felt.reduce((n, l) => n + l.text.length, 0) : 0)) * FORMATS.length * voices.length,
    todayChars: today ? lines.reduce((n, l) => n + plain(l.text).length, 0) : 0,
  };
}

/** The named values: from the environment, else the first .env file that has one. `from` says where. */
export function loadKeys(names, { env = process.env, files = [resolve(".env"), join(homedir(), "Desktop", "pa", ".env")] } = {}) {
  const read = files.map(f => { try { return [f, parseEnv(readFileSync(f, "utf8"))]; } catch { return [f, {}]; } });
  return Object.fromEntries(names.map(n => {
    if (String(env[n] ?? "").trim()) return [n, { value: String(env[n]).trim(), from: "the environment" }];
    const hit = read.find(([, kv]) => String(kv[n] ?? "").trim());
    return [n, hit ? { value: String(hit[1][n]).trim(), from: hit[0].replace(homedir(), "~") } : { value: "", from: "" }];
  }));
}

// ---------- Cartesia ----------

/** One REST call. `{ ok, status, json, error }` — the error in their own words, never the key. */
export async function api(key, path, { method = "GET", body = null, fetchImpl = globalThis.fetch } = {}) {
  let r;
  try {
    r = await fetchImpl(apiBase() + path, {
      method,
      headers: { "X-API-Key": key, "Cartesia-Version": VERSION, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, status: 0, json: null, error: `could not reach Cartesia: ${(e?.message ?? String(e)).split("\n")[0]}` };
  }
  const text = await r.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a plain-text error */ }
  const error = r.ok ? "" : [r.status, json?.error_code, json?.title ? `${json.title}:` : "", json?.message ?? text.slice(0, 200)].filter(Boolean).join(" ");
  return { ok: r.ok, status: r.status, json, error };
}

/**
 * The speech socket, opened once and kept: a call would hold one open too, so the time measured for a
 * line is from sending its words to its first audio, not the handshake (given apart, as `ready`).
 */
export function openTts(key, { WS = globalThis.WebSocket } = {}) {
  const t0 = performance.now();
  const ws = new WS(`${apiBase().replace(/^http/, "ws")}/tts/websocket?cartesia_version=${VERSION}`, { headers: { "X-API-Key": key, "Cartesia-Version": VERSION } });
  const waiting = new Map();
  let closed = "";
  const ready = new Promise((ok, no) => {
    ws.onopen = () => ok(Math.round(performance.now() - t0));
    ws.onerror = (e) => no(new Error(`the speech socket would not open (${e?.message || "refused"})`));
  });
  ws.onmessage = (m) => { let e; try { e = JSON.parse(String(m.data)); } catch { return; } waiting.get(e.context_id)?.(e); };
  ws.onclose = (e) => {
    closed = `the speech socket closed (code ${e?.code ?? 1006})`;
    for (const f of [...waiting.values()]) f({ type: "error", message: closed, error_code: "closed" });
  };
  /** One line. `{ audio, firstMs, serverMs, totalMs }`, or `{ error, code }`. Never throws. */
  const speak = ({ voiceId, text, language = "en", output, emotion = "" }, { timeoutMs = 30_000 } = {}) => new Promise((done) => {
    // A send on a closed socket is dropped without a word: said here instead of waited out.
    if (closed) return done({ error: closed, code: "closed" });
    const id = randomUUID();
    const parts = [];
    let firstMs = null, serverMs = null;
    const finish = (r) => { clearTimeout(timer); waiting.delete(id); done(r); };
    const timer = setTimeout(() => { try { ws.send(JSON.stringify({ context_id: id, cancel: true })); } catch { /* gone */ } finish({ error: "no audio within 30 s", code: "timeout" }); }, timeoutMs);
    const sent = performance.now();
    waiting.set(id, (e) => {
      if (e.type === "error") return finish({ error: [e.status_code, e.error_code, e.title ? `${e.title}:` : "", e.message].filter(Boolean).join(" "), code: e.error_code || String(e.status_code ?? "") });
      if (e.type === "chunk" && e.data) {
        if (firstMs == null) { firstMs = Math.round(performance.now() - sent); serverMs = Number.isFinite(e.step_time) ? Math.round(e.step_time) : null; }
        parts.push(Buffer.from(e.data, "base64"));
      }
      if (e.type === "done" || e.done) finish({ audio: Buffer.concat(parts), firstMs, serverMs, totalMs: Math.round(performance.now() - sent) });
    });
    try {
      ws.send(JSON.stringify({
        model_id: MODEL, transcript: text, voice: { id: voiceId }, language, context_id: id, continue: false, output_format: output,
        ...(emotion ? { generation_config: { emotion } } : {}),
      }));
    } catch (e) { finish({ error: `could not send: ${e?.message ?? e}`, code: "send" }); }
  });
  return { ready, speak, close: () => { try { ws.close(); } catch { /* already gone */ } } };
}

/** A voice as asked for (a known key, an id, or a name) made whole: its id and what Cartesia says of it. */
export async function resolveVoice(key, v, { fetchImpl } = {}) {
  let id = v.id;
  if (!id) {
    const r = await api(key, `/voices?limit=20&q=${encodeURIComponent(v.name)}`, { fetchImpl });
    if (!r.ok) return { ...v, error: r.error, status: r.status };
    const hits = r.json?.data ?? [];
    id = (hits.find(h => String(h.name).toLowerCase() === v.name.toLowerCase()) ?? hits[0])?.id ?? "";
    if (!id) return { ...v, error: `no Cartesia voice is called "${v.name}"` };
  }
  const r = await api(key, `/voices/${id}`, { fetchImpl });
  if (!r.ok) return { ...v, id, error: r.error, status: r.status };
  const m = r.json ?? {};
  const native = (m.accents ?? []).find(a => a.is_native)?.locale ?? "";
  return { ...v, id, name: m.name || v.name, locale: v.locale || native, tagline: m.tagline ?? "", description: m.description ?? "", gender: m.gender ?? "" };
}

/** British women's voices, to pick from: no credits used. */
async function listVoices(key, q) {
  let after = "";
  for (let page = 0; page < 5; page++) {
    const r = await api(key, `/voices?limit=100&language=en-GB&gender=feminine${q ? `&q=${encodeURIComponent(q)}` : ""}${after ? `&starting_after=${after}` : ""}`);
    if (!r.ok) throw new Error(r.error);
    for (const v of r.json?.data ?? []) console.log(`${v.id}  ${String(v.name).padEnd(14)} ${String(v.tagline ?? "").padEnd(24)} ${String(v.description ?? "").replace(/\s+/g, " ").slice(0, 110)}`);
    if (!r.json?.has_more || !r.json?.next_page) return;
    after = r.json.next_page;
  }
}

// ---------- today's voice, for comparison ----------

/**
 * The same lines through OpenAI's speech model with the call's voice name (config: `openerTtsModel`,
 * `gptliveVoice`) — the voice a call's pickup opener is already made with. The live voice itself
 * (GPT-Live) cannot be made offline, so its own timing and laughs are not in these files.
 */
async function todayVoice(lines, { key, dir, log }) {
  const [{ config }, { pcm24ToUlaw }] = await Promise.all([import("../src/config.js"), import("../src/calls/opener.js")]);
  const voice = { key: `today-${config.gptliveVoice}`, name: `Today (${config.gptliveVoice}, ${config.openerTtsModel})`, kind: "today", id: "", locale: "", description: "The call voice's name through OpenAI's speech model, as the pickup opener is made. Not the live voice's own timing, and it has no laugh tag: the laugh line is said without one." };
  const rows = [];
  mkdirSync(join(dir, voice.key), { recursive: true });
  for (const [i, line] of lines.entries()) {
    const base = `${String(i + 1).padStart(2, "0")}-${line.id}`;
    const sent = performance.now();
    let firstMs = null, pcm = null, error = "";
    try {
      const r = await fetch(`${config.openaiBase}/v1/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: config.openerTtsModel, voice: config.gptliveVoice, input: plain(line.text), response_format: "pcm", instructions: `${TODAY_PERSONA} Mid-conversation on a phone call, not a recording.` }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) error = `speech ${r.status}`;
      else {
        const parts = [];
        for await (const c of r.body) { if (firstMs == null) firstMs = Math.round(performance.now() - sent); parts.push(Buffer.from(c)); }
        pcm = Buffer.concat(parts);
      }
    } catch (e) { error = (e?.message ?? String(e)).split("\n")[0]; }
    for (const f of FORMATS) {
      const row = { voice: voice.key, line: line.id, format: f.key, emotion: "", file: `${voice.key}/${base}.${f.key}.wav`, firstMs, totalMs: Math.round(performance.now() - sent), error };
      if (pcm) {
        // The phone file is made the way the opener's is (24 kHz → 8 kHz μ-law, src/calls/opener.js).
        const body = f.ulaw ? pcm24ToUlaw(pcm) : pcm.subarray(0, pcm.length & ~1);
        writeFileSync(join(dir, row.file), wav(body, { rate: f.ulaw ? 8000 : 24000, ulaw: f.ulaw }));
        row.seconds = Math.round(body.length / (f.ulaw ? 8000 : 48000) * 10) / 10;
      }
      rows.push(row);
    }
    log(`  ${voice.key.padEnd(12)} ${base.padEnd(30)} ${error ? `FAILED: ${error}` : `first audio ${firstMs} ms`}`);
  }
  return { voice, rows };
}

// ---------- the run ----------

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** The page the owner plays the clips from: a row a line, a column a voice. */
export function page({ lines, voices, rows, summary, made }) {
  const cell = (v, l) => rows.filter(r => r.voice === v.key && r.line === l.id).map(r => r.error
    ? `<div class="e">${esc(r.format)}: ${esc(r.error)}</div>`
    : `<div><b>${esc(r.format)}${r.emotion ? ` · asked: ${esc(r.emotion)}` : ""}</b> <small>${r.firstMs ?? "?"} ms${r.leadMs != null ? ` + ${r.leadMs} ms quiet` : ""}</small><br><audio controls preload="none" src="${esc(r.file)}"></audio></div>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>Reason × Cartesia: listening test</title>
<style>body{font:15px/1.45 -apple-system,system-ui,sans-serif;margin:24px;color:#1c1c1e}table{border-collapse:collapse}td,th{border:1px solid #d9d9de;padding:10px;vertical-align:top;text-align:left}th small,td small{color:#6b6b72;font-weight:400}audio{height:32px;width:230px}td>div{margin-bottom:8px}.e{color:#b3261e}.t{max-width:230px}</style>
<h1>Reason × Cartesia: listening test</h1>
<p>Made ${esc(made)}. <b>phone</b> is exactly what a call would carry (8 kHz μ-law); <b>full</b> is the same line made again at full quality, so the two are separate performances. The time under each is from sending the words to the first audio back, measured where this was run; "quiet" is the silence the clip opens with. If a phone clip will not play in the browser, open the .wav in QuickTime.</p>
<p>${esc(summary)}</p>
<table><tr><th>Line</th>${voices.map(v => `<th>${esc(v.name || v.key)} <small>${esc([v.kind, v.locale, v.tagline].filter(Boolean).join(" · "))}<br>${esc(v.description ?? "")}</small></th>`).join("")}</tr>
${lines.map(l => `<tr><td class="t"><b>${esc(l.what)}</b><br>${esc(l.text)}</td>${voices.map(v => `<td>${cell(v, l)}</td>`).join("")}</tr>`).join("\n")}
</table>`;
}

/** First-audio times, said in a line each: per voice and over all, the phone format first. */
export function summarize(rows) {
  const ok = rows.filter(r => !r.error && r.voice && !r.voice.startsWith("today-"));
  const of = (list) => { const s = stats(list.map(r => r.firstMs)); return s.n ? `median ${s.median} ms, worst ${s.worst} ms (${s.n} clips)` : "nothing measured"; };
  const out = FORMATS.map(f => `First audio, ${f.key}: ${of(ok.filter(r => r.format === f.key))}.`);
  const lead = stats(ok.filter(r => r.leadMs != null).map(r => r.leadMs));
  if (lead.n) out.push(`Quiet before the first sound (phone): median ${lead.median} ms, worst ${lead.worst} ms.`);
  const server = stats(ok.map(r => r.serverMs));
  if (server.n) out.push(`Cartesia's own time for the first piece: median ${server.median} ms.`);
  return out;
}

async function main() {
  const { values: a, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" }, yes: { type: "boolean" }, today: { type: "boolean" }, emotion: { type: "boolean" }, "list-voices": { type: "boolean" },
      voices: { type: "string" }, lines: { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (a.help) { console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter(l => l.startsWith("//")).slice(0, 19).map(l => l.slice(3)).join("\n")); return 0; }
  const keys = loadKeys(["CARTESIA_API_KEY", "OPENAI_API_KEY", "OPENAI_API_BASE", "REASON_OPENER_TTS_MODEL", "REASON_GPTLIVE_VOICE"]);
  const key = keys.CARTESIA_API_KEY.value;
  const { lines, voices } = pick(a);
  // The folder is named for the local time it was made.
  const d = new Date(), two = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  const dir = resolve(String(a.out ?? join(homedir(), "Desktop", "reason-cartesia-listen", stamp)).replace(/^~(?=\/)/, homedir()));
  const wantToday = !!a.today && !!keys.OPENAI_API_KEY.value;
  const p = plan({ lines, voices, emotion: a.emotion, today: wantToday });
  const noKey = "No CARTESIA_API_KEY. Make one at https://play.cartesia.ai/keys and add a CARTESIA_API_KEY line to ~/Desktop/pa/.env, then run this again.";

  if (a["list-voices"]) {
    if (!key) { console.error(noKey); return 2; }
    await listVoices(key, positionals.join(" "));
    return 0;
  }

  console.log(`Lines (${lines.length}): ${lines.map(l => l.id).join(", ")}`);
  console.log(`Voices (${voices.length}): ${voices.map(v => `${v.name || v.id} [${v.kind}${v.locale ? `, ${v.locale}` : ""}]`).join("; ")}`);
  console.log(`Makes ${p.clips} clips (each line as the phone carries it and at full quality${a.emotion ? ", and again with its emotion asked for" : ""}) into ${dir.replace(homedir(), "~")}`);
  console.log(`Cartesia: about ${p.credits.toLocaleString("en-US")} credits (about one a character; ${MODEL}), one clip at a time.`);
  console.log(`CARTESIA_API_KEY: ${key ? `found in ${keys.CARTESIA_API_KEY.from}` : "not found"}`);
  if (a.today) console.log(keys.OPENAI_API_KEY.value ? `Today's voice too: ${p.todayChars} characters through OpenAI's speech model (about a cent). OPENAI_API_KEY found in ${keys.OPENAI_API_KEY.from}.` : "Today's voice: skipped, no OPENAI_API_KEY.");
  if (a["dry-run"]) { console.log("Dry run: nobody was called and nothing was written."); return 0; }
  if (!key) { console.error(noKey); return 2; }
  // A key found in a file is not a decision to spend: with no terminal attached (a script, an agent's
  // shell) the clips are made only when asked for outright.
  if (!a.yes && !process.stdout.isTTY) { console.error("Not run: this spends Cartesia credits and no terminal is attached. Add --yes to make the clips, or --dry-run for the plan."); return 2; }

  // Each voice looked up first (free): a wrong id or a refused key is said before anything is made.
  const found = [];
  for (const v of voices) {
    const r = await resolveVoice(key, v);
    if (r.status === 401 || r.status === 403) { console.error(`Cartesia refused the key (${r.error}). Check CARTESIA_API_KEY in ${keys.CARTESIA_API_KEY.from}.`); return 2; }
    if (r.error) { console.error(`Skipping ${v.name || v.id}: ${r.error}`); continue; }
    found.push(r);
  }
  if (!found.length) { console.error("None of the voices could be used."); return 1; }

  mkdirSync(dir, { recursive: true });
  const tts = openTts(key);
  let handshakeMs;
  try { handshakeMs = await tts.ready; } catch (e) { console.error(e.message); return 1; }
  console.log(`Speech socket open in ${handshakeMs} ms.`);
  const rows = [];
  let stop = "";
  run: for (const v of found) {
    mkdirSync(join(dir, v.key), { recursive: true });
    for (const [i, line] of lines.entries()) {
      for (const emotion of a.emotion && line.emotion ? ["", line.emotion] : [""]) {
        for (const f of FORMATS) {
          const file = `${v.key}/${String(i + 1).padStart(2, "0")}-${line.id}${emotion ? ".emotion" : ""}.${f.key}.wav`;
          const r = await tts.speak({ voiceId: v.id, text: line.text, language: v.locale || "en", output: f.output, emotion });
          const row = { voice: v.key, line: line.id, format: f.key, emotion, file, firstMs: r.firstMs ?? null, serverMs: r.serverMs ?? null, totalMs: r.totalMs ?? null, error: r.error ?? "" };
          if (r.audio?.length) {
            writeFileSync(join(dir, file), wav(r.audio, { rate: f.rate, ulaw: f.ulaw }));
            row.seconds = Math.round(r.audio.length / (f.ulaw ? f.rate : f.rate * 2) * 10) / 10;
            if (f.ulaw) row.leadMs = leadMs(r.audio);
          } else if (!row.error) row.error = "no audio came back";
          rows.push(row);
          console.log(`  ${v.key.padEnd(12)} ${file.split("/")[1].replace(/\.wav$/, "").padEnd(30)} ${row.error ? `FAILED: ${row.error}` : `first audio ${row.firstMs} ms, ${row.seconds} s`}`);
          // Out of credits, or the key or plan refused: nothing after this would work either.
          if (["quota_exceeded", "plan_upgrade_required", "closed", "401", "402", "403"].includes(String(r.code ?? ""))) { stop = row.error; break run; }
        }
      }
    }
  }
  tts.close();
  const shown = [...found];
  if (wantToday && !stop) {
    process.env.OPENAI_API_KEY = keys.OPENAI_API_KEY.value;
    for (const n of ["OPENAI_API_BASE", "REASON_OPENER_TTS_MODEL", "REASON_GPTLIVE_VOICE"]) if (keys[n].value && !process.env[n]) process.env[n] = keys[n].value;
    const t = await todayVoice(lines, { key: keys.OPENAI_API_KEY.value, dir, log: console.log });
    rows.push(...t.rows);
    shown.push(t.voice);
  }
  const summary = [`Speech socket handshake ${handshakeMs} ms.`, ...summarize(rows)];
  const made = new Date().toString().slice(0, 24);
  writeFileSync(join(dir, "timings.json"), JSON.stringify({ made, model: MODEL, version: VERSION, handshakeMs, summary, voices: shown.map(({ key: k, name, id, kind, locale, tagline }) => ({ key: k, name, id, kind, locale, tagline })), rows }, null, 2));
  writeFileSync(join(dir, "index.html"), page({ lines, voices: shown, rows, summary: summary.join(" "), made }));
  console.log(`\n${summary.join("\n")}`);
  if (stop) console.log(`\nStopped early: ${stop}`);
  console.log(`\nListen:  open "${join(dir, "index.html")}"`);
  return rows.some(r => !r.error) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e?.message ?? e); process.exitCode = 1; });
}
