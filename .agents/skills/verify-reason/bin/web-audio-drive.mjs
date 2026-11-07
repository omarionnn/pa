#!/usr/bin/env node
// Drive Reason Web's audio chips (src/pages/webcompose.js audioChip, src/sentfiles.js audio roots,
// src/webaudio.js, src/webmedia.js) over REAL HTTP: src/http.js createServer on a loopback port, history
// rows stored the way live stores them (a voice note texted in from a CDN, a voice note Reason spoke in
// data/audio-tmp, a call recording in data/recordings with its .mp3 beside the .caf), read back through
// /web?thread and the chip's /web/media/m/<row>/<i>. The .caf files are real (made with this machine's
// ffmpeg/afconvert) and are converted for the browser by the code under test. No model is called,
// nothing is texted; the CDN is a stand-in inside this process.
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && D=$(mktemp -d) && REASON_DATA_DIR=$D REASON_DB_PATH=$D/web.db node .agents/skills/verify-reason/bin/web-audio-drive.mjs [--shots=DIR]
//
// --shots=DIR also plays the call recording in WebKit (iPhone 390 wide) and Google Chrome (desktop),
// light and night, and saves the screenshots there. Prints one line per step, `ok` or `FAIL`, and exits
// non-zero on any FAIL.
process.env.REASON_WEB = "on";
process.env.REASON_SITE_URL = "http://127.0.0.1";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_TZ ||= "America/New_York";
delete process.env.REASON_SITE_PROXY_SECRET;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dbp = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = dbp && existsSync(dirname(dbp)) ? realpathSync(dirname(dbp)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  const data = process.env.REASON_DATA_DIR && existsSync(process.env.REASON_DATA_DIR) ? realpathSync(process.env.REASON_DATA_DIR) + "/" : "";
  if (!dbp || existsSync(dbp) || !parent || !roots.some(r => parent.startsWith(r)) || !data || !roots.some(r => data.startsWith(r))) {
    console.error("refusing: set REASON_DATA_DIR to a temp directory and REASON_DB_PATH to a new file in it");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET", "TWILIO_AUTH_TOKEN"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";
const shots = process.argv.find(a => a.startsWith("--shots="))?.slice(8) || "";

const { mkdirSync, writeFileSync, readFileSync, symlinkSync, readdirSync, existsSync, rmSync } = await import("node:fs");
const { join, relative } = await import("node:path");
const { execFileSync } = await import("node:child_process");
const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { createServer } = await imp("src/http.js");
const { config } = await imp("src/config.js");
const db = await imp("src/db.js");
const { findConverter, VOICE_AFCONVERT_ARGS, VOICE_FFMPEG_ARGS } = await imp("src/expressive.js");

const conv = findConverter();
if (!conv) { console.error("refusing: no ffmpeg or afconvert here to make a real .caf"); process.exit(2); }

const KOFI_C = "dm:fake:+14155559876", AMA_C = "dm:fake:+13475550000";
for (const [c, a, n] of [[KOFI_C, "+14155559876", "Kofi"], [AMA_C, "+13475550000", "Ama"]]) {
  db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
  db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
}
db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");

// ---------------------------------------------------------------- real audio
const work = join(process.env.REASON_DATA_DIR, "drive-src");
mkdirSync(work, { recursive: true });
/** Words spoken by macOS `say` where there is one, else a hum; returned as a WAV path. */
function speech(name, words, seconds) {
  const wav = join(work, `${name}.wav`);
  try { execFileSync("/usr/bin/say", ["-o", wav, "--data-format=LEI16@16000", words], { stdio: "ignore" }); if (existsSync(wav)) return wav; } catch { /* no say */ }
  const rate = 16000, n = seconds * rate, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 220 * i / rate) * (0.5 + 0.5 * Math.sin(i / rate * 3))), 44 + i * 2);
  writeFileSync(wav, b);
  return wav;
}
/** A WAV → the .caf iMessage records (Opus in CAF), the way src/voice.js speak makes one. */
// Some ffmpeg builds cannot write Opus into CAF ("Not yet implemented"); those get PCM in CAF, still a .caf no browser takes.
const toCaf = (wav, out) => {
  if (conv.kind === "afconvert") { execFileSync(conv.bin, VOICE_AFCONVERT_ARGS(wav, out), { stdio: "ignore" }); return out; }
  try { execFileSync(conv.bin, ["-y", "-v", "error", ...VOICE_FFMPEG_ARGS(wav, out)], { stdio: "ignore" }); } catch { /* below */ }
  if (!existsSync(out) || !readFileSync(out).length) execFileSync(conv.bin, ["-y", "-v", "error", "-i", wav, "-c:a", "pcm_s16le", "-f", "caf", out], { stdio: "ignore" });
  return out;
};
const toMp3OrWav = (wav, stem) => {
  if (conv.kind === "ffmpeg") { const out = `${stem}.mp3`; execFileSync(conv.bin, ["-y", "-v", "error", "-i", wav, "-c:a", "libmp3lame", "-b:a", "48k", out], { stdio: "ignore" }); return out; }
  const out = `${stem}.wav`; writeFileSync(out, readFileSync(wav)); return out;
};

const inboundCaf = readFileSync(toCaf(speech("in", "Also flights to Lisbon in March, nothing before nine.", 4), join(work, "in.caf")));
mkdirSync(config.audioTmpRoot, { recursive: true });
mkdirSync(config.recordingRoot, { recursive: true });
const spoken = toCaf(speech("say", "Saturday: dinner at Lilia at eight, then the late show at nine forty five.", 6), join(config.audioTmpRoot, "voice-drive.caf"));

// The CDN, for this process only: Sendblue's address for the note texted in answers with its bytes.
const realFetch = globalThis.fetch;
let cdnAsked = 0;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith("https://cdn.drive.example/")) { cdnAsked++; return new Response(inboundCaf, { status: 200, headers: { "content-type": "audio/x-caf" } }); }
  return realFetch(url, opts);
};

// ---------------------------------------------------------------- rows, as live stores them
let seq = 0;
const at0 = Date.now() - 30 * 60_000;
const said = (c, role, text, media = [], outboxId = null) => db.writeMessage({ conversationId: c, role, channel: "sendblue", externalId: role === "user" ? `e${++seq}` : null, outboxId, text, media, at: at0 + (++seq) * 60_000 });
const lastRow = () => db.db.prepare("SELECT id FROM messages ORDER BY id DESC LIMIT 1").get().id;
const ob = (c, media, body) => db.enqueueOutbound({ idemKey: `k${++seq}`, conversationId: c, channel: "fake", address: "+1", body, media }).row.id;

said(KOFI_C, "user", "can you book Lilia for saturday? two of us, around 8");
said(KOFI_C, "assistant", "On it. I'll call them now and tell you how it goes.");
said(KOFI_C, "user", "[they sent a voice note]", [{ kind: "voice", mimeType: "audio/x-caf", filename: "Audio Message.caf", url: "https://cdn.drive.example/Audio%20Message.caf", seconds: 4, transcript: "also flights to lisbon in march, nothing before 9" }]);
const inRow = lastRow();
const call = db.createCall(KOFI_C, { provider: "fake", toNumber: "+15550100177", isOwner: false, goal: "book a table for two at Lilia, Saturday 8pm" });
const recStem = join(config.recordingRoot, `call-${call.id}`);
const recWav = speech("call", "Lilia, good evening. A table for two on Saturday at eight? Yes, we have that. Under Kofi. See you then.", 9);
toMp3OrWav(recWav, recStem);
const recCaf = toCaf(recWav, `${recStem}.caf`);
db.db.prepare("UPDATE calls SET recording_state = 'stored', recording_file = ? WHERE id = ?").run(recCaf, call.id);
said(KOFI_C, "assistant", "Called Lilia: you're booked for two, Saturday at 8, under Kofi. Here's the call.", [{ kind: "file", mimeType: "audio/x-caf", filename: `call-${call.id}-15550100177.caf` }],
  ob(KOFI_C, { call_id: call.id, file: recCaf, mimeType: "audio/x-caf", filename: `call-${call.id}-15550100177.caf`, seconds: 9 }, "Called Lilia"));
const callRow = lastRow();
said(KOFI_C, "assistant", "And here's Saturday, out loud.", [{ kind: "file", mimeType: "audio/x-caf", filename: "voice-drive.caf" }],
  ob(KOFI_C, { file: spoken, mimeType: "audio/x-caf", filename: "voice-drive.caf" }, "Saturday out loud"));
const voiceRow = lastRow();
// Rows that must serve nothing: a symlink out of the root, a climb out of it, a call that is Ama's.
const secret = join(process.env.REASON_DATA_DIR, "secret.caf"); writeFileSync(secret, inboundCaf);
const link = join(config.audioTmpRoot, "voice-link.caf"); symlinkSync(secret, link);
said(KOFI_C, "assistant", "x", [{ kind: "file", mimeType: "audio/x-caf", filename: "voice-link.caf" }], ob(KOFI_C, { file: link, mimeType: "audio/x-caf", filename: "voice-link.caf" }, "x"));
const linkRow = lastRow();
const climb = `${config.audioTmpRoot}/${relative(config.audioTmpRoot, secret)}`;
said(KOFI_C, "assistant", "x", [{ kind: "file", mimeType: "audio/x-caf", filename: "climb.caf" }], ob(KOFI_C, { file: climb, mimeType: "audio/x-caf", filename: "climb.caf" }, "x"));
const climbRow = lastRow();
const amaCall = db.createCall(AMA_C, { provider: "fake", toNumber: "+15550100188", isOwner: false, goal: "x" });
said(KOFI_C, "assistant", "x", [{ kind: "file", mimeType: "audio/x-caf", filename: "c.caf" }], ob(KOFI_C, { call_id: amaCall.id, file: recCaf, mimeType: "audio/x-caf", filename: "c.caf" }, "x"));
const foreignCallRow = lastRow();
// The three that must not draw are removed from the page's history after their routes are checked.

const router = new Router({});
const runtime = new Runtime({ channels: router, deliver: async () => {}, runTurn: async () => "ok" });
router.runtime = runtime;
const server = createServer({ router, runtime });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const signIn = (c) => { const t = `drive-${Math.random().toString(36).slice(2)}`; db.startPageSession(`wsign:${c}`, t, { conversationId: c }); return { cookie: `reason_page=${t}`, token: t }; };
const get = async (b, path, extra = {}) => {
  const r = await realFetch(`${BASE}${path}`, { headers: { origin: BASE, "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}), ...extra } });
  return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
};
const kofi = signIn(KOFI_C), ama = signIn(AMA_C);
const m = (row) => `/web/media/m/${row}/0`;

try {
  const v = await get(kofi, m(voiceRow));
  step("Reason's spoken .caf → 200 audio/mp4 (converted)", v.status === 200 && v.headers.get("content-type") === "audio/mp4" && v.bytes.toString("latin1", 4, 8) === "ftyp", `${v.status} ${v.headers.get("content-type")} ${v.bytes.length} B`);
  const vr = await get(kofi, m(voiceRow), { range: "bytes=0-1023" });
  step("…Range → 206, 1024 bytes", vr.status === 206 && vr.bytes.length === 1024 && /^bytes 0-1023\/\d+$/.test(vr.headers.get("content-range") ?? ""), vr.headers.get("content-range"));
  const c = await get(kofi, m(callRow));
  const sibType = conv.kind === "ffmpeg" ? "audio/mpeg" : "audio/wav";
  step(`call recording → 200 ${sibType} (the sibling beside the .caf)`, c.status === 200 && c.headers.get("content-type") === sibType, `${c.status} ${c.headers.get("content-type")}`);
  const cr = await get(kofi, m(callRow), { range: "bytes=500-" });
  step("…Range → 206", cr.status === 206 && cr.headers.get("content-range") === `bytes 500-${c.bytes.length - 1}/${c.bytes.length}`, cr.headers.get("content-range"));
  const i1 = await get(kofi, m(inRow));
  step("voice note texted in (.caf from the CDN) → 200 audio/mp4", i1.status === 200 && i1.headers.get("content-type") === "audio/mp4" && i1.bytes.toString("latin1", 4, 8) === "ftyp", `${i1.status} ${i1.headers.get("content-type")}`);
  const i2 = await get(kofi, m(inRow), { range: "bytes=0-1" });
  step("…Range → 206; the CDN asked once", i2.status === 206 && cdnAsked === 1, `${i2.status}, asked ${cdnAsked}`);
  const kept = existsSync(config.webAudioRoot) ? readdirSync(config.webAudioRoot) : [];
  step("converted copies kept under data/web-audio, nothing half-written", kept.filter(f => f.endsWith(".m4a")).length === 2 && !kept.some(f => f.startsWith(".")), kept.join(","));
  for (const [who, b] of [["signed out", null], ["a made-up cookie", { cookie: "reason_page=nope" }], ["another person (Ama)", ama]]) {
    const codes = await Promise.all([voiceRow, callRow, inRow].map(r => get(b, m(r)).then(x => x.status)));
    step(`${who} → 404 on all three`, codes.every(s => s === 404), codes.join(","));
  }
  const odd = await Promise.all([`/web/media/m/${callRow}/1`, `/web/media/m/${callRow + 9999}/0`, m(linkRow), m(climbRow), m(foreignCallRow)].map(p => get(kofi, p).then(x => x.status)));
  step("wrong index, guessed row, symlink out, ../ climb, another conversation's call → 404", odd.every(s => s === 404), odd.join(","));
  step("no provider or CDN address reaches the browser", ![v, c, i1].some(x => /cdn\.drive|twilio|https?:/i.test(String(x.headers.get("content-disposition")))));
  db.db.prepare(`DELETE FROM messages WHERE id IN (${linkRow}, ${climbRow}, ${foreignCallRow})`).run();

  const page = await get(kofi, "/web?thread");
  const html = page.bytes.toString();
  const chips = html.match(/<div class="slip achip[^"]*" data-src="\/web\/media\/m\/\d+\/0">/g) ?? [];
  step("the thread draws three audio chips with players", page.status === 200 && chips.length === 3, `${chips.length}`);
  step("one is the call recording, labelled so", /<div class="slip achip call" data-src="\/web\/media\/m\/\d+\/0">[^]*?<span class="fn">Call recording<\/span>/.test(html));
  step("no number from the recording's filename on the page", !/15550100177/.test(html));
  const other = (await get(ama, "/web?thread")).bytes.toString();
  step("Ama's thread has none of them", !/achip/.test(other.replace(/<style[^]*?<\/style>|<script[^]*?<\/script>/g, "")));

  if (shots) {
    mkdirSync(shots, { recursive: true });
    const { webkit, chromium } = await import("playwright");
    const host = new URL(BASE).hostname;
    const runs = [["iphone", webkit, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: false, hasTouch: true }],
      ["desktop", chromium, { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 }, { channel: "chrome" }]];
    for (const [name, type, ctxOpts, launch = {}] of runs) {
      const browser = await type.launch({ headless: true, ...launch });
      for (const theme of ["light", "night"]) {
        const ctx = await browser.newContext({ ...ctxOpts, colorScheme: theme === "night" ? "dark" : "light" });
        await ctx.addCookies([{ name: "reason_page", value: kofi.token, domain: host, path: "/" }]);
        // The first-load wordmark plays once per tab; this tab has "already seen it".
        await ctx.addInitScript(() => { try { sessionStorage.setItem("reason-web-loaded", "1"); } catch { /* fine */ } });
        const pg = await ctx.newPage();
        await pg.goto(`${BASE}/web?thread`, { waitUntil: "load" });
        await pg.addStyleTag({ content: "*{animation-duration:0s!important;transition:none!important}" });
        const last = pg.locator(".achip").last();
        await last.scrollIntoViewIfNeeded();
        await pg.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
        await pg.waitForTimeout(400);
        let note = "";
        if (theme === "light") {
          // Play the call recording, let it run, and catch it mid-play.
          const callChip = pg.locator(".achip.call");
          await callChip.locator(".vplay").click();
          await pg.waitForFunction(() => { const c = document.querySelector(".achip.call"); return c && c.querySelector(".vplay").getAttribute("aria-pressed") === "true" && c.querySelector(".vnow").textContent !== "0:00"; }, null, { timeout: 15000 }).catch(() => {});
          const pressed = await callChip.locator(".vplay").getAttribute("aria-pressed");
          const now = await callChip.locator(".vnow").textContent();
          const p = await callChip.locator(".ac-w").evaluate(e => e.style.getPropertyValue("--p"));
          step(`${name}: the call recording plays (▶ → ❚❚, the clock runs, the wave fills)`, pressed === "true" && now !== "0:00" && parseFloat(p) > 0, `${pressed} ${now} ${p}`);
          // A tap on the wave seeks.
          const box = await callChip.locator(".ac-w").boundingBox();
          await pg.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
          await pg.waitForTimeout(300);
          const p2 = parseFloat(await callChip.locator(".ac-w").evaluate(e => e.style.getPropertyValue("--p")));
          step(`${name}: a tap at 60% of the wave seeks there`, p2 > 50 && p2 < 75, `${p2.toFixed(0)}%`);
          await pg.waitForTimeout(700);
          await callChip.locator(".vplay").click();
          // And the converted voice note (a .caf on disk) plays in this browser too.
          const vChip = pg.locator(".achip:not(.call)").last();
          await vChip.locator(".vplay").click();
          await pg.waitForFunction(() => { const c = [...document.querySelectorAll(".achip:not(.call)")].pop(); return c && c.querySelector(".vnow").textContent !== "0:00"; }, null, { timeout: 15000 }).catch(() => {});
          step(`${name}: Reason's converted voice note plays`, (await vChip.locator(".vnow").textContent()) !== "0:00");
          await vChip.locator(".vplay").click();
          await callChip.locator(".vplay").click();
          await pg.waitForFunction(() => document.querySelector(".achip.call .vnow").textContent >= "0:03", null, { timeout: 10000 }).catch(() => {});
          note = "-playing";
        }
        await pg.screenshot({ path: join(shots, `audio-chips-${name}-${theme}${note}.png`) });
        await ctx.close();
      }
      await browser.close();
    }
    console.log(`shots in ${shots}`);
  }
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
