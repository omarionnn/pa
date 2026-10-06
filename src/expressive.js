// The three things Reason can do to a message besides send one: react to it, send one with an
// effect, and send one as a voice note.
//
// All three are iMessage-only extras with limits Sendblue states precisely, and this file is where
// those limits live so the tool, the adapter and the capabilities text cannot drift apart.
//
// What is NOT in here is any judgement about when to use them. A tapback instead of a filler "ok"
// is a thing the model decides, in the system prompt; code's job is to make the decision possible
// and to refuse it honestly when the line, the rail or the machine cannot carry it.
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, delimiter, basename } from "node:path";

/**
 * The six classic tapbacks, exactly as api-v2/reactions names them.
 *
 * Case-sensitive and matched exactly, because the docs say so: "names are case-sensitive (Love is
 * rejected)". Named values also resolve BEFORE emoji, so `love` is Apple's classic heart tapback
 * while `❤️` is an emoji reaction that happens to be a heart — two different things on the device.
 */
export const CLASSIC_TAPBACKS = ["love", "like", "dislike", "laugh", "emphasize", "question"];

/** The 13 effects, exactly as guides/expressive-messages lists them. iMessage only. */
export const SEND_STYLES = [
  "celebration", "shooting_star", "fireworks", "lasers", "love", "confetti",
  "balloons", "spotlight", "echo", "invisible", "gentle", "loud", "slam",
];

/** Apple renders only this as an inline voice memo. "this is the only format Apple supports". */
export const VOICE_EXT = ".caf";

/**
 * The exact conversion guides/voice-notes gives, kept as data rather than a string built at the
 * call site, so what gets run is the documented command and is readable in one place.
 */
export const VOICE_FFMPEG_ARGS = (input, output) => ["-i", input, "-acodec", "opus", "-b:a", "24k", output];

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * One well-formed emoji, as Unicode builds them — which is what "exactly one emoji" has to mean if
 * it is to cover the examples Sendblue gives.
 *
 * `\p{Extended_Pictographic}` is the obvious test and it is the wrong one. A keycap (`1️⃣`) is a
 * plain digit plus U+FE0F plus the enclosing-keycap mark, a flag (`🇬🇭`) is two regional indicators,
 * and a subdivision flag is a black flag plus tag characters — not one of those five code points is
 * Extended_Pictographic, so that test rejects three of the four kinds the docs name. Hence the
 * sequence grammar: a flag pair, or an emoji with an optional skin-tone modifier / variation
 * selector / keycap / tag sequence, joined to more of the same by zero-width joiners.
 */
const ONE_EMOJI = /^(?:\p{RI}\p{RI}|\p{Emoji}(?:\p{EMod}|️⃣?|[\u{E0020}-\u{E007E}]+\u{E007F})?(?:‍\p{Emoji}(?:\p{EMod}|️⃣?)?)*)$/u;

/**
 * Is this a reaction Sendblue will accept? Returns `{ok}` or `{ok: false, error}` in words.
 *
 * Sendblue validates this strictly and lists the rules, so they are checked here rather than spent
 * as a round trip and a 400. Every rule below is one of theirs:
 *
 *   - a classic name, case-sensitive, or exactly ONE complete emoji;
 *   - composed emoji count as one (skin tones, families, flags, keycaps), which is what makes a
 *     grapheme-cluster count the right test and a string length the wrong one — 👍🏽 is two code
 *     points and 👨‍👩‍👧‍👦 is seven;
 *   - plain text, text containing an emoji ("hello🔥"), and multiple emoji ("🔥🔥") are rejected;
 *   - no surrounding whitespace and no trimming;
 *   - the emoji-picker form, so a text-style character without the variation selector (❤ instead
 *     of ❤️) is rejected;
 *   - a leading `-` removes a reaction previously sent with that exact value.
 *
 * This is validating an API value against a published grammar, not reading what a person meant —
 * the model chooses the reaction, and this only says whether Sendblue can carry it.
 */
export function checkReaction(value) {
  const raw = String(value ?? "");
  if (!raw) return { ok: false, error: "a reaction has to be one of love, like, dislike, laugh, emphasize, question, or exactly one emoji." };
  const removing = raw.startsWith("-");
  const body = removing ? raw.slice(1) : raw;

  if (!body) return { ok: false, error: "'-' on its own removes nothing. It goes in front of the reaction being taken off, like -love or -🔥." };
  if (CLASSIC_TAPBACKS.includes(body)) return { ok: true, removing, kind: "classic", value: raw };
  // Case matters, and the near-miss is worth naming rather than lumping in with "not an emoji".
  const miscased = CLASSIC_TAPBACKS.find(t => t.toLowerCase() === body.toLowerCase());
  if (miscased) return { ok: false, error: `Sendblue's reaction names are case-sensitive, so use '${miscased}' rather than '${body}'.` };
  if (body !== body.trim()) return { ok: false, error: "a reaction cannot have spaces around it; Sendblue matches the value exactly." };

  const clusters = [...segmenter.segment(body)];
  if (clusters.length !== 1) {
    return {
      ok: false,
      error: clusters.length > 1
        ? `'${body}' is ${clusters.length} characters. A reaction is exactly one emoji — not two, and not text with an emoji in it.`
        : `'${body}' is not a reaction Sendblue takes.`,
    };
  }
  if (!ONE_EMOJI.test(body)) {
    return { ok: false, error: `'${body}' is not an emoji or one of love, like, dislike, laugh, emphasize, question.` };
  }
  // "use the emoji-picker form: a text-style character without the emoji variation selector
  // (❤ instead of ❤️) is rejected". A character that is not emoji-by-default needs the U+FE0F.
  // This is also what keeps a bare digit or '#' out: those really are Emoji code points, and a
  // keycap is only a keycap once the selector and the enclosing mark are on it.
  const bare = [...body].filter(c => /\p{Emoji}/u.test(c));
  const needsSelector = bare.length === 1 && !/\p{Emoji_Presentation}/u.test(bare[0]);
  if (needsSelector && !body.includes("️")) {
    return { ok: false, error: `'${body}' is the text-style form of that character. Sendblue wants the emoji one from the picker (with the variation selector), like ❤️ rather than ❤.` };
  }
  return { ok: true, removing, kind: "emoji", value: raw };
}

/**
 * How often one conversation may have a screen effect on a message: once an hour, at most.
 *
 * This is a product rule rather than anything Sendblue imposes — their docs set no limit on
 * `send_style` at all. It is here because "rare" is the whole of what makes an effect mean
 * something, and "rare" is not a thing a model can be relied on to hold across a day of separate
 * turns: each one looks, on its own, like the moment that earns confetti. So the model decides
 * WHETHER a moment deserves an effect and code decides how often one can happen.
 */
export const EFFECT_EVERY_MS = 60 * 60 * 1000;

/**
 * May this conversation have an effect right now? `lastAt` is when it last had one, or null.
 *
 * Returns the wait in whole minutes when it may not, because the only useful thing to say about a
 * refusal here is how long it is for.
 */
export function effectAllowed({ lastAt, now }) {
  if (!lastAt) return { ok: true };
  const left = EFFECT_EVERY_MS - (now - lastAt);
  if (left <= 0) return { ok: true };
  return { ok: false, waitMs: left, minutes: Math.max(1, Math.ceil(left / 60_000)) };
}

/** Is this one of the 13 effects? */
export function checkSendStyle(style) {
  const s = String(style ?? "");
  if (SEND_STYLES.includes(s)) return { ok: true, value: s };
  const miscased = SEND_STYLES.find(x => x.toLowerCase() === s.toLowerCase());
  return {
    ok: false,
    error: miscased
      ? `the effect is '${miscased}', spelled exactly like that.`
      : `'${s}' is not an iMessage effect. Sendblue has these 13: ${SEND_STYLES.join(", ")}.`,
  };
}

/**
 * Is ffmpeg on this machine?
 *
 * It is not, on the machine this was written on, and that is the point: converting any audio into
 * the .caf Apple renders as a voice memo needs it, and installing something on somebody's Mac is
 * not a thing to do quietly in a messaging change. So this is a PATH scan, the same shape as the
 * yt-dlp one in src/video.js, and its absence produces a sentence that names ffmpeg rather than a
 * vague failure three layers down.
 */
let ffmpegFound;
export function findFfmpeg({ recheck = false } = {}) {
  if (ffmpegFound !== undefined && !recheck) return ffmpegFound;
  const named = process.env.REASON_FFMPEG_BIN;
  if (named) { ffmpegFound = existsSync(named) ? named : null; return ffmpegFound; }
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  ffmpegFound = dirs.map(d => join(d, "ffmpeg")).find(p => existsSync(p)) ?? null;
  return ffmpegFound;
}

/**
 * afconvert, which every Mac already has.
 *
 * Apple's own converter writes exactly what Messages records — Opus in a CAF container, 24 kHz,
 * mono — and reads it back, so on macOS a voice note needs nothing installed at all. That matters
 * more than it sounds: ffmpeg wants Homebrew, Homebrew wants an administrator password, and a
 * machine with neither could not send a voice note for want of a program it did not need.
 * REASON_AFCONVERT_BIN names another path, or "none" to behave like a machine without one.
 */
export const AFCONVERT_PATH = "/usr/bin/afconvert";
export function findAfconvert() {
  const named = process.env.REASON_AFCONVERT_BIN;
  if (named === "none") return null;
  if (named) return existsSync(named) ? named : null;
  return process.platform === "darwin" && existsSync(AFCONVERT_PATH) ? AFCONVERT_PATH : null;
}

/** Any audio → the voice memo Apple plays inline. Checked on this machine with `afinfo`. */
export const VOICE_AFCONVERT_ARGS = (input, output) => ["-f", "caff", "-d", "opus@24000", "-c", "1", input, output];
/** A voice memo (or anything else) → plain 16 kHz mono WAV, which is what a listening model takes. */
export const WAV_AFCONVERT_ARGS = (input, output) => ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", input, output];
export const WAV_FFMPEG_ARGS = (input, output) => ["-y", "-i", input, "-ar", "16000", "-ac", "1", output];

/**
 * Whatever on this machine can turn audio into a voice memo: afconvert first, then ffmpeg.
 * Null when there is neither, which is the only case a voice note cannot be made.
 */
export function findConverter({ recheck = false } = {}) {
  const af = findAfconvert();
  if (af) return { kind: "afconvert", bin: af };
  const ff = findFfmpeg({ recheck });
  return ff ? { kind: "ffmpeg", bin: ff } : null;
}

/** `bin` is the older way of saying "this ffmpeg, or none"; an explicit one still means that. */
function converterFrom({ bin, converter }) {
  if (converter !== undefined) return converter;
  if (bin !== undefined) return bin ? { kind: "ffmpeg", bin } : null;
  return findConverter();
}

/** One conversion with whichever program was found. Injectable so tests need neither binary. */
export function runConverter(args, { bin, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    if (!bin) return resolve({ ok: false, error: "there is no audio converter on this machine" });
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || "").split("\n").filter(Boolean).at(-1) ?? "the conversion failed" });
      resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** What the capabilities tool says about voice notes, which depends on a program being installed. */
export function voiceNoteStatus(opts = {}) {
  const converter = converterFrom(opts);
  if (converter) {
    return {
      ok: true, bin: converter.bin, converter: converter.kind,
      what: `send an audio file as a real iMessage voice note. Anything that is not already ${VOICE_EXT} is converted with ${converter.kind} first`,
    };
  }
  return {
    ok: false,
    missing: ["ffmpeg"],
    what: `send a voice note — NOT available. Apple only renders ${VOICE_EXT} as a voice memo, converting to it needs ffmpeg, and ffmpeg is not installed on this machine.`
      + ` An audio file can still be sent as an ordinary attachment, which plays but does not look like a voice memo.`
      + ` Say that plainly; do not offer a voice note and do not describe one as sent`,
  };
}

/** One ffmpeg run, promisified, in the same shape runYtDlp uses. Injectable so tests need no binary. */
export function runFfmpeg(args, { bin = findFfmpeg(), timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    if (!bin) return resolve({ ok: false, error: "ffmpeg is not installed on this machine" });
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || "").split("\n").filter(Boolean).at(-1) ?? "ffmpeg failed" });
      resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * The file to actually send as a voice note, converting only if it has to.
 *
 * Three outcomes, and the middle one is the whole reason this function exists rather than a branch
 * at the call site:
 *
 *   already .caf        send it as it is. No ffmpeg needed, so this works on this machine today.
 *   needs converting,
 *     ffmpeg present    convert with the documented command and send the result.
 *     ffmpeg absent     refuse, naming ffmpeg and saying what can be sent instead.
 *
 * `run` and `exists` are injected so the conversion path is proved offline on a machine that has no
 * ffmpeg — which is every machine this has run on so far. See docs/unverified.md.
 */
export async function voiceNoteFile({ file, tmpDir, run = null, exists = existsSync, bin, converter }) {
  const conv = converterFrom({ bin, converter });
  const path = String(file ?? "");
  if (!path) return { ok: false, error: "there is no file to send as a voice note." };
  if (!exists(path)) return { ok: false, error: `that audio file is not there: ${path}` };
  if (path.toLowerCase().endsWith(VOICE_EXT)) return { ok: true, file: path, converted: false };

  if (!conv) {
    const st = voiceNoteStatus({ converter: null });
    return {
      ok: false, missing: st.missing,
      error: `that file is not ${VOICE_EXT}, and ${VOICE_EXT} is the only format Apple plays as a voice memo.`
        + ` Converting it needs ffmpeg, which is not installed on this machine, so this cannot be sent as a voice note.`
        + ` It can go as an ordinary audio attachment instead — say that rather than claiming a voice note.`,
    };
  }
  const out = join(tmpDir, `${basename(path).replace(/\.[^.]+$/, "")}${VOICE_EXT}`);
  const args = conv.kind === "afconvert" ? VOICE_AFCONVERT_ARGS(path, out) : VOICE_FFMPEG_ARGS(path, out);
  const r = await (run ?? runConverter)(args, { bin: conv.bin });
  if (!r.ok) return { ok: false, error: `converting that audio to ${VOICE_EXT} failed: ${r.error}` };
  if (!exists(out)) return { ok: false, error: `${conv.kind} reported success but there is no ${out}, so there is nothing to send.` };
  return { ok: true, file: out, converted: true };
}
