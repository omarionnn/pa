// A photo somebody texts reaches the model on the `claude` CLI backend — the one the live Reason
// actually runs on. No CLI, no network, no port: the turn's own decisions are what is tested.
//
// Found on 2026-10-05, on a real phone: a photo from an iPhone got "i can't open photos on this
// setup" the same afternoon the HEIC conversion shipped, because this backend never handed the
// model a picture at all. Each question here is one way that could come back:
//
//   is the picture handed to the CLI as a picture?            (yes — an image block on stdin)
//   does the model get told it cannot look?                    (never, when it can)
//   are several photos on one message handed over together?    (yes, in order, in one turn)
//   does the history keep megabytes of base64?                 (no — one line saying it was looked at)
//   does a photo that would not download say why?              (yes — that sentence, and no block)
//   is the Read tool opened up to make this work?              (no — still denied, with pictures)
//   does a turn with no photo change at all?                   (no — same argv as before)
//   is the envelope still found when the CLI streams events?   (yes — the last `result` line)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cli-photos-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");
const { cliInvocation, envelopeFrom } = await import("../src/backends/cli.js");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => db.saveConversation("dm:owner", []));

const block = (data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
const photo = (filename) => ({ kind: "image", filename, url: `https://cdn.example/${filename}`, media_id: null });
const noMcp = async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} });

/** A stand-in for src/media.js `imagesFor`: every .jpg is looked at, everything else is not. */
const looked = async (attachments) => {
  const out = { blocks: [], notes: [], seen: [], viewedMediaIds: [] };
  for (const a of attachments) {
    if (a.kind !== "image") continue;
    if (a.filename.endsWith(".jpg")) {
      out.blocks.push(block(`BYTES-${a.filename}`));
      out.seen.push(`they sent a photo (${a.filename}); you looked at it when it arrived and cannot look at it again`);
      if (a.media_id) out.viewedMediaIds.push(a.media_id);
    } else {
      out.notes.push(`they sent a photo (${a.filename}) and it could not be downloaded (HTTP 403), so you have not seen it. Say that once and ask what is in it if it matters.`);
    }
  }
  return out;
};

async function turn({ text = "", attachments = [] }) {
  const calls = [];
  const reply = await runTurnViaCli({
    conversationId: "dm:owner", text, attachments,
    images: looked, startMcp: noMcp,
    run: async (args) => { calls.push(args); return { ok: true, envelope: { result: "is this one you're looking at?" } }; },
  });
  return { reply, call: calls[0], history: db.loadConversation("dm:owner") };
}

test("a photo is handed to the CLI as a picture, and the model is not told it cannot look", async () => {
  const { reply, call } = await turn({ attachments: [photo("IMG_1.jpg")] });
  assert.equal(reply, "is this one you're looking at?");
  assert.deepEqual(call.images, [block("BYTES-IMG_1.jpg")]);
  assert.match(call.prompt, /the photo they sent with this message is attached above/);
  assert.equal(/cannot look|can't look|on this backend/i.test(call.prompt), false);
});

test("several photos on one message go over together, in the order they were sent", async () => {
  const { call } = await turn({ text: "which one", attachments: [photo("a.jpg"), photo("b.jpg"), photo("c.jpg")] });
  assert.deepEqual(call.images.map(b => b.source.data), ["BYTES-a.jpg", "BYTES-b.jpg", "BYTES-c.jpg"]);
  assert.match(call.prompt, /the 3 photos they sent with this message are attached above, in the order they sent them/);
});

test("the history keeps one line saying it was looked at, and none of the bytes", async () => {
  const { history } = await turn({ attachments: [photo("IMG_1.jpg")] });
  const stored = JSON.stringify(history);
  assert.equal(stored.includes("BYTES-IMG_1.jpg"), false);
  assert.match(history[0].content, /you looked at it when it arrived and cannot look at it again/);
  // "attached above" is true of the turn it arrived on and of no later one.
  assert.equal(/attached above/.test(history[0].content), false);
});

test("a photo that would not download says why, once, and hands over no picture", async () => {
  const { call, history } = await turn({ attachments: [photo("IMG_2.heic")] });
  assert.deepEqual(call.images, []);
  assert.match(call.prompt, /could not be downloaded \(HTTP 403\), so you have not seen it/);
  assert.equal(/attached above/.test(call.prompt), false);
  assert.match(history[0].content, /you have not seen it/);
});

test("one that opened and one that did not are each told as what happened", async () => {
  const { call } = await turn({ attachments: [photo("ok.jpg"), photo("bad.heic")] });
  assert.equal(call.images.length, 1);
  assert.match(call.prompt, /the photo they sent with this message is attached above/);
  assert.match(call.prompt, /bad\.heic\) and it could not be downloaded/);
});

test("a text with no photo is run exactly as it always was", async () => {
  const { call } = await turn({ text: "what's on my calendar" });
  assert.deepEqual(call.images, []);
  const inv = cliInvocation({ prompt: call.prompt, system: "s", mcpUrl: call.mcpUrl, images: call.images });
  assert.deepEqual(inv.args.slice(0, 4), ["-p", call.prompt, "--output-format", "json"]);
  assert.equal(inv.stdin, null);
});

test("with a picture the CLI is given it on stdin, ahead of the words, and Read stays denied", () => {
  const inv = cliInvocation({ prompt: "the words", system: "s", mcpUrl: "http://127.0.0.1:9/mcp", images: [block("AAAA")] });
  for (const flag of ["--input-format", "--output-format", "--verbose"]) assert.ok(inv.args.includes(flag), flag);
  assert.equal(inv.args[inv.args.indexOf("--input-format") + 1], "stream-json");
  assert.equal(inv.args[inv.args.indexOf("--output-format") + 1], "stream-json");
  // The prompt travels on stdin, not as an argument, or it would be sent twice.
  assert.equal(inv.args.includes("the words"), false);
  const denied = inv.args.slice(inv.args.indexOf("--disallowedTools") + 1, inv.args.indexOf("--max-turns"));
  for (const t of ["Read", "Bash", "Glob", "Grep", "WebFetch"]) assert.ok(denied.includes(t), `${t} must stay denied`);
  const sent = JSON.parse(inv.stdin);
  assert.equal(sent.type, "user");
  assert.deepEqual(sent.message.content.map(b => b.type), ["image", "text"]);
  assert.equal(sent.message.content[1].text, "the words");
  assert.equal(inv.stdin.endsWith("\n"), true);
});

test("the envelope is the last result event when the CLI streams, and the whole output when it does not", () => {
  const streamed = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    "not json at all",
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "a red hatchback" }),
    "",
  ].join("\n");
  assert.equal(envelopeFrom(streamed, { streamed: true }).result, "a red hatchback");
  assert.equal(envelopeFrom(JSON.stringify({ type: "system" }), { streamed: true }), null);
  assert.equal(envelopeFrom(JSON.stringify({ result: "hi", is_error: false })).result, "hi");
  assert.equal(envelopeFrom("garbage"), null);
});
