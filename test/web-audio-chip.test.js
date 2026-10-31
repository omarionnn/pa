// Reason Web: voice notes and call recordings play in their own chip (src/pages/webcompose.js
// audioChip, src/sentfiles.js audio roots, src/webaudio.js, src/webmedia.js). 2026-10-30: a voice
// note Reason spoke and a call's recording drew with nothing to open (their files sit in
// data/audio-tmp and data/recordings, outside the roots files were served from), and a voice note
// texted in came back as a .caf, which desktop Chrome cannot play.
//
// Only the conversation's own signed-in browser hears any of it. Everyone else, a signed-out
// browser, a guessed row or index, a path that leaves its root: the same 404.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-audio-"));
const outside = mkdtempSync(join(tmpdir(), "reason-web-audio-outside-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";

const db = await import("../src/db.js");
const { config } = await import("../src/config.js");
const convo = await import("../src/pages/webconvo.js");
const media = await import("../src/webmedia.js");
const { findConverter } = await import("../src/expressive.js");

const KOFI_C = "dm:fake:+14155559876", AMA_C = "dm:fake:+13475550000";
// A CAF header and enough bytes to look like one; and an MP3 (ID3) sibling.
const CAF = Buffer.concat([Buffer.from("caff\x00\x01\x00\x00desc"), Buffer.alloc(4000, 3)]);
const MP3 = Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00"), Buffer.alloc(6000, 5)]);
after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
beforeEach(() => {
  config.web = true;
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM messages; DELETE FROM page_sessions; DELETE FROM calls;");
  for (const [c, a, nm] of [[KOFI_C, "+14155559876", "Kofi"], [AMA_C, "+13475550000", "Ama"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: nm, isOperator: false });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
});
let n = 0;
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { cookie: `reason_page=${token}` };
}
const H = (b, extra = {}) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}), ...extra });
const getMedia = (b, path, extra, fetchImpl) => media.webMediaRoute({ path, method: "GET", headers: H(b, extra), fetchImpl });

/** Something Reason sent with a file on the outbox row, the way the send path stores it. */
function reasonSent(conv, { file, bytes = CAF, mime = "audio/x-caf", filename, text = "", obMedia = {} }) {
  if (bytes) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, bytes); }
  const ob = db.enqueueOutbound({ idemKey: `k${++n}`, conversationId: conv, channel: "fake", address: "+1", body: text, media: { file, mimeType: mime, filename, ...obMedia } }).row;
  db.writeMessage({ conversationId: conv, role: "assistant", channel: "sendblue", outboxId: ob.id, text, media: [{ kind: "file", mimeType: mime, filename }], at: Date.now() });
  const r = db.db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 1").get();
  return { ...r, media: JSON.parse(r.media) };
}
const voiceNote = (conv) => reasonSent(conv, { file: join(config.audioTmpRoot, `voice-${++n}.caf`), filename: `voice-${n}.caf`, text: "here it is out loud" });
function callRecording(conv, { callConv = conv, sibling = true } = {}) {
  const id = db.createCall(callConv, { provider: "fake", toNumber: "+15555550123", isOwner: false, goal: "book a table" }).id;
  const base = join(config.recordingRoot, `call-${id}`);
  mkdirSync(config.recordingRoot, { recursive: true });
  if (sibling) writeFileSync(`${base}.mp3`, MP3);
  db.db.prepare("UPDATE calls SET recording_state = 'stored', recording_file = ? WHERE id = ?").run(`${base}.${sibling ? "mp3" : "caf"}`, id);
  return { id, row: reasonSent(conv, { file: `${base}.caf`, filename: `call-${id}-15555550123.caf`, text: "Booked for 8. The recording:", obMedia: { call_id: id, seconds: 154 } }) };
}

test("a voice note Reason spoke is a chip with a player, served to its own conversation as audio, with ranges", async () => {
  const row = voiceNote(KOFI_C);
  const { html } = convo.rowOut(row, { conversationId: KOFI_C });
  assert.match(html, new RegExp(`<div class="slip achip" data-src="/web/media/m/${row.id}/0"><button type="button" class="vplay ap" data-src="/web/media/m/${row.id}/0" aria-pressed="false" aria-label="Play voice note"`));
  assert.match(html, /<span class="fn">Voice note<\/span>/);
  assert.match(html, /class="ac-w" role="slider"/);
  const b = browser(KOFI_C);
  const got = await getMedia(b, `/web/media/m/${row.id}/0`);
  assert.equal(got.status, 200);
  assert.match(got.headers["Content-Type"], /^audio\//);
  assert.equal(got.headers["Accept-Ranges"], "bytes");
  const part = await getMedia(b, `/web/media/m/${row.id}/0`, { range: "bytes=0-9" });
  assert.equal(part.status, 206);
  assert.equal(part.body.length, 10);
  assert.match(part.headers["Content-Range"], /^bytes 0-9\/\d+$/);
});

test("anyone but the conversation gets 404: signed out, another person, a guessed row or index", async () => {
  const row = voiceNote(KOFI_C);
  assert.equal((await getMedia(browser(KOFI_C), `/web/media/m/${row.id}/0`)).status, 200, "its own conversation hears it");
  assert.equal((await getMedia(null, `/web/media/m/${row.id}/0`)).status, 404, "signed out");
  assert.equal((await getMedia({ cookie: "reason_page=nope" }, `/web/media/m/${row.id}/0`)).status, 404, "a made-up session");
  assert.equal((await getMedia(browser(AMA_C), `/web/media/m/${row.id}/0`)).status, 404, "another person");
  assert.equal((await getMedia(browser(KOFI_C), `/web/media/m/${row.id}/1`)).status, 404, "a wrong index");
  assert.equal((await getMedia(browser(KOFI_C), `/web/media/m/${row.id + 999}/0`)).status, 404, "a guessed row");
  assert.equal((await getMedia(browser(AMA_C), `/web/media/m/${row.id}/0`, { range: "bytes=0-1" })).status, 404, "a range changes nothing");
});

test("a call recording plays for the conversation whose call it was: its playable sibling, ranges, and nobody else", async () => {
  const { row } = callRecording(KOFI_C);
  const { html } = convo.rowOut(row, { conversationId: KOFI_C });
  assert.match(html, /<div class="slip achip call" data-src="\/web\/media\/m\/\d+\/0">/);
  assert.match(html, /<span class="fn">Call recording<\/span>/);
  assert.match(html, /aria-label="Play call recording, 154 seconds"/);
  assert.match(html, /<span class="vlen"> \/ <span class="vt">2:34<\/span><\/span> · CALL/);
  assert.doesNotMatch(html, /5555550123/, "the number is not on the page");
  const b = browser(KOFI_C);
  const got = await getMedia(b, `/web/media/m/${row.id}/0`);
  assert.equal(got.status, 200);
  assert.equal(got.headers["Content-Type"], "audio/mpeg", "the .mp3 beside the .caf, which every browser plays");
  assert.ok(Buffer.compare(got.body, MP3) === 0);
  const part = await getMedia(b, `/web/media/m/${row.id}/0`, { range: "bytes=100-" });
  assert.equal(part.status, 206);
  assert.equal(part.headers["Content-Range"], `bytes 100-${MP3.length - 1}/${MP3.length}`);
  assert.equal((await getMedia(browser(AMA_C), `/web/media/m/${row.id}/0`)).status, 404, "another person");
  assert.equal((await getMedia(null, `/web/media/m/${row.id}/0`)).status, 404, "signed out");
});

test("a recording row whose call is another conversation's serves nothing", async () => {
  const own = callRecording(KOFI_C).row;
  assert.equal((await getMedia(browser(KOFI_C), `/web/media/m/${own.id}/0`)).status, 200, "its own call's recording plays");
  const { row } = callRecording(KOFI_C, { callConv: AMA_C });
  assert.equal((await getMedia(browser(KOFI_C), `/web/media/m/${row.id}/0`)).status, 404);
  assert.equal((await getMedia(browser(AMA_C), `/web/media/m/${row.id}/0`)).status, 404);
  assert.doesNotMatch(convo.rowOut(row, { conversationId: KOFI_C }).html, /data-src=/, "and no player is drawn for it");
});

test("a path that leaves the audio roots is 404: dot-dot, a symlink out, a non-audio file in an audio root", async () => {
  const secret = join(outside, "secret.caf");
  writeFileSync(secret, CAF);
  mkdirSync(config.audioTmpRoot, { recursive: true });
  // The real file, reached from inside the root by climbing out of it.
  const climb = `${config.audioTmpRoot}/${relative(config.audioTmpRoot, secret)}`;
  assert.ok(climb.includes("/../") && existsSync(climb));
  const dotdot = reasonSent(KOFI_C, { file: climb, bytes: null, filename: "x.caf" });
  const link = join(config.audioTmpRoot, "voice-link.caf");
  symlinkSync(secret, link);
  const viaLink = reasonSent(KOFI_C, { file: link, bytes: null, filename: "voice-link.caf" });
  const linkedDir = join(config.recordingRoot, "elsewhere");
  mkdirSync(config.recordingRoot, { recursive: true });
  symlinkSync(outside, linkedDir);
  const viaDir = reasonSent(KOFI_C, { file: join(linkedDir, "secret.caf"), bytes: null, filename: "z.caf" });
  const text = reasonSent(KOFI_C, { file: join(config.audioTmpRoot, "notes.txt"), bytes: Buffer.from("not audio"), mime: "text/plain", filename: "notes.txt" });
  const b = browser(KOFI_C);
  assert.equal((await getMedia(b, `/web/media/m/${voiceNote(KOFI_C).id}/0`)).status, 200, "a voice note inside the root plays");
  for (const r of [dotdot, viaLink, viaDir, text]) {
    assert.equal((await getMedia(b, `/web/media/m/${r.id}/0`)).status, 404, r.media[0].filename);
  }
});

test("a voice note texted in as .caf goes to the browser as .m4a, converted once and kept under the data dir", { skip: findConverter() ? false : "no ffmpeg or afconvert here" }, async () => {
  const conv = findConverter();
  const src = join(outside, "in.caf");
  if (conv.kind === "ffmpeg") execFileSync(conv.bin, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", "-f", "caf", src]);
  else {
    const wav = join(outside, "in.wav");
    const pcm = Buffer.alloc(16000 * 2);
    for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 6)), i * 2);
    const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
    writeFileSync(wav, Buffer.concat([h, pcm]));
    execFileSync(conv.bin, ["-f", "caff", "-d", "LEI16", wav, src]);
  }
  const caf = (await import("node:fs")).readFileSync(src);
  db.writeMessage({ conversationId: KOFI_C, role: "user", channel: "sendblue", externalId: `in-${++n}`, text: "[they sent a voice note]", media: [{ kind: "voice", mimeType: "audio/x-caf", filename: "Audio Message.caf", url: "https://cdn.example.test/Audio%20Message.caf" }], at: Date.now() });
  const row = db.db.prepare("SELECT id FROM messages ORDER BY id DESC LIMIT 1").get();
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return new Response(caf, { status: 200, headers: { "content-type": "audio/x-caf" } }); };
  const got = await getMedia(browser(KOFI_C), `/web/media/m/${row.id}/0`, {}, fetchImpl);
  assert.equal(got.status, 200);
  assert.equal(got.headers["Content-Type"], "audio/mp4");
  assert.equal(got.body.toString("latin1", 4, 8), "ftyp", "an MP4 container");
  assert.match(got.headers["Content-Disposition"], /filename="Audio Message\.m4a"/);
  assert.ok(readdirSync(config.webAudioRoot).some(f => f.endsWith(".m4a")), "kept under data/web-audio");
  assert.ok(!readdirSync(config.webAudioRoot).some(f => f.startsWith(".")), "no half-written files left");
  const part = await getMedia(browser(KOFI_C), `/web/media/m/${row.id}/0`, { range: "bytes=0-1" }, fetchImpl);
  assert.equal(part.status, 206);
  assert.equal(fetched, 1, "the CDN is asked once");
  assert.equal((await getMedia(browser(AMA_C), `/web/media/m/${row.id}/0`, {}, fetchImpl)).status, 404);
  assert.ok(existsSync(config.webAudioRoot));
});

test("a voice note whose file is gone draws as a chip with nothing to press", () => {
  const row = reasonSent(KOFI_C, { file: join(config.audioTmpRoot, "gone.caf"), bytes: null, filename: "gone.caf" });
  const { html } = convo.rowOut(row, { conversationId: KOFI_C });
  assert.match(html, /<div class="slip achip off">/);
  assert.match(html, /VOICE NOTE · NOT KEPT HERE/);
  assert.doesNotMatch(html, /<button[^>]*vplay/);
});

test("a deleted recording is gone from Web too, though its .caf is still on disk", async () => {
  const { id, row } = callRecording(KOFI_C);
  assert.equal((await getMedia(browser(KOFI_C), `/web/media/m/${row.id}/0`)).status, 200);
  db.db.prepare("UPDATE calls SET recording_state = 'deleted', recording_file = NULL WHERE id = ?").run(id);
  assert.equal((await getMedia(browser(KOFI_C), `/web/media/m/${row.id}/0`)).status, 404);
  assert.doesNotMatch(convo.rowOut(row, { conversationId: KOFI_C }).html, /data-src=/);
});

test("conversion: the input format is pinned, file-only; bytes that are not audio are never converted; a failure is not retried at once; forgetPlayable removes the copy", async () => {
  const wa = await import("../src/webaudio.js");
  const args = wa.M4A_FFMPEG_ARGS("/in", "/out.m4a", "caf");
  assert.deepEqual(args.slice(args.indexOf("-protocol_whitelist"), args.indexOf("-i") + 2), ["-protocol_whitelist", "file", "-f", "caf", "-i", "/in"]);
  let runs = 0;
  const run = async () => { runs++; return { ok: false, error: "boom" }; };
  const converter = { kind: "ffmpeg", bin: "/nope/ffmpeg" };
  assert.equal(await wa.toM4a(Buffer.from("#EXTM3U\nfile:///etc/passwd\n".padEnd(64, " ")), { converter, run }), null, "a playlist is not audio");
  assert.equal(runs, 0);
  const odd = Buffer.concat([Buffer.from("caff"), Buffer.alloc(64, n++)]);
  assert.equal(await wa.toM4a(odd, { converter, run }), null);
  assert.equal(await wa.toM4a(odd, { converter, run }), null);
  assert.equal(runs, 1, "the failure is remembered");
  // A copy made for a kept file is removed with it.
  const keep = join(config.recordingRoot, "call-forget.caf");
  mkdirSync(config.recordingRoot, { recursive: true });
  const bytes = Buffer.concat([Buffer.from("caff"), Buffer.alloc(64, 9)]);
  writeFileSync(keep, bytes);
  const made = await wa.toM4a(bytes, { converter, run: async (a) => { writeFileSync(a.at(-1), "m4a"); return { ok: true }; } });
  assert.ok(made && existsSync(made));
  wa.forgetPlayable(keep);
  assert.ok(!existsSync(made));
});
