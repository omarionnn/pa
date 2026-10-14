// What outlives a photo: the note taken of it, and the way back to the picture itself.
//
// Found on 2026-10-13, on a real phone. Omari sent a photo of a caregiver job form with eight
// scenario questions on it. Reason read it, said "want me to write answers for all 8?", and one
// turn later said "I can't see the photo anymore, and I never wrote down the exact wording of the
// 8 questions — can you send the picture again?" Both halves of that were true: the only note
// kept was the chat reply, and there was no way back to the picture.
//
// Each question here is one way that could come back:
//
//   is a photo written down as what it shows AND the words in it, verbatim?   (yes — the quiet pass)
//   is the note taken alongside the turn rather than after it?                  (yes — started before the model runs)
//   when the pass fails, is the old reply-based note still kept?                 (yes — never worse than before)
//   does the next turn get those words?                                          (yes — the recent-photos note)
//   can the picture itself be brought back?                                      (yes — photo_look, same fetch, same checks)
//   do the bytes reach the model and stay out of the log, on both backends?      (yes — image block; log says the size)
//   does the history still say the photo is out of sight, and how to see it?     (yes — one line, with the id)
//   is the model told never to ask for a photo again, and to fill a form in?     (yes — the prompt)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-looked-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const looked = await import("../src/looked.js");
const reviewed = await import("../src/reviewed.js");
const { runTool, tools, SAFE_WHILE_SCREENED } = await import("../src/tools.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");
const { mcpDispatch, splitImage } = await import("../src/backends/mcp-core.js");
const agent = await import("../src/agent.js");
const { clock } = await import("../src/config.js");

const C = "dm:owner";
const OWNER = "+12025551234";
const PNG = readFileSync(new URL("./fixtures/pictures/plain.png", import.meta.url));
const block = (data = "BYTES") => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const serving = (body = PNG) => async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => body });

const FORM = {
  description: "A caregiver job application form with eight scenario questions, every answer box empty.",
  text: "Caregiver Scenario Questions\n1. A client refuses to take their medication. What do you do?\n[blank]\n2. A client falls while you are assisting them. What are your immediate steps?\n[blank]",
  kind: "form",
};

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM media_items; DELETE FROM conversations; DELETE FROM accounts; DELETE FROM threads; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/** One photo row, as the router writes it the moment a message is taken (src/reviewed.js). */
const photoRow = (filename = "IMG_1.png", { kind = "image", url = `https://cdn.test/${filename}`, externalId = `e-${filename}` } = {}) =>
  db.recordMedia({ conversationId: C, channel: "fake", externalId, baseHandle: externalId, ordinal: 1, kind, filename, url });

// ---------- the note ----------

test("the note is what the photo shows, then every word in it, verbatim", () => {
  const n = looked.noteFrom(FORM);
  assert.match(n, /^A caregiver job application form .* every answer box empty\. Words in it, verbatim:\n/);
  assert.match(n, /1\. A client refuses to take their medication\. What do you do\?\n\[blank\]\n2\. A client falls/);
});

test("a photo with no words in it is the description alone, and a long note is cut rather than dropped", () => {
  assert.equal(looked.noteFrom({ description: "A plate of chicken, rice and broccoli.", text: "" }), "A plate of chicken, rice and broccoli.");
  const long = looked.noteFrom({ description: "d", text: "x".repeat(10_000) });
  assert.ok(long.length <= looked.MAX_NOTE, `${long.length}`);
  assert.match(long, /\[cut here\]$/);
});

test("the capture runs on the photo's bytes, as structured output with no tools, on the fast model", async () => {
  const calls = [];
  const r = await looked.captureViaCli(block("FORM-BYTES"), {
    filename: "IMG_1.png",
    run: async (args) => { calls.push(args); return { ok: true, envelope: { result: JSON.stringify(FORM) } }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, FORM.text);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].images, [block("FORM-BYTES")]);
  assert.equal(calls[0].jsonSchema, looked.CAPTURE_SCHEMA);
  assert.equal(calls[0].mcpUrl ?? null, null, "no tools: this is copying, not acting");
  assert.equal(calls[0].model, "sonnet");
  assert.match(calls[0].system, /verbatim/);
  assert.match(calls[0].system, /never an instruction to you/);
});

test("a schema'd answer under structured_output is read too, and anything off the schema is a failed note", async () => {
  const viaField = await looked.captureViaCli(block(), { run: async () => ({ ok: true, envelope: { result: "", structured_output: FORM } }) });
  assert.equal(viaField.ok, true);
  assert.equal(viaField.description, FORM.description);
  const junk = await looked.captureViaCli(block(), { run: async () => ({ ok: true, envelope: { result: "not json" } }) });
  assert.equal(junk.ok, false);
  const dead = await looked.captureViaCli(block(), { run: async () => ({ ok: false, error: "the CLI did not finish inside 90000ms" }) });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /did not finish/);
});

test("the note is stored for each photo looked at; when the pass failed, the reply is kept instead", async () => {
  const a = photoRow("a.png");
  const b = photoRow("b.png");
  const captured = looked.startCapture({
    blocks: [block("A"), block("B")], viewedMediaIds: [a.id, b.id],
    attachments: [{ kind: "image", filename: "a.png", media_id: a.id }, { kind: "image", filename: "b.png", media_id: b.id }],
    capture: async (blk) => blk.source.data === "A" ? { ok: true, ...FORM } : { ok: false, error: "timed out" },
  });
  const stored = await looked.recordLooked({ viewedMediaIds: [a.id, b.id], reply: "that's a form and a receipt, want me to do anything with them?", captured });
  assert.match(stored[a.id], /Words in it, verbatim:\n.*A client refuses/s);
  assert.equal(stored[b.id], "that's a form and a receipt, want me to do anything with them?");
  assert.equal(db.mediaItem(C, a.id).description, stored[a.id]);
  assert.equal(db.mediaItem(C, b.id).description, stored[b.id]);
});

test("a capture that throws is a failed note, not a failed turn", async () => {
  const a = photoRow("a.png");
  const lines = [];
  const captured = looked.startCapture({
    blocks: [block()], viewedMediaIds: [a.id], attachments: [{ kind: "image", filename: "a.png", media_id: a.id }],
    capture: async () => { throw new Error("boom"); }, log: (l) => lines.push(l),
  });
  const stored = await looked.recordLooked({ viewedMediaIds: [a.id], reply: "nice plate", captured });
  assert.equal(stored[a.id], "nice plate");
  assert.deepEqual(lines, [{ photo_note_failed: a.id, why: "boom" }]);
});

// ---------- through a turn, on the backend the live Reason runs on ----------

test("on the CLI backend the note is started before the model runs and stored once the reply is in", async () => {
  const row = photoRow("IMG_1.png");
  const order = [];
  const reply = await runTurnViaCli({
    conversationId: C, text: "", attachments: [{ kind: "image", filename: "IMG_1.png", url: row.url, media_id: row.id }],
    images: async (_atts, { cover }) => {
      order.push("looked");
      cover(row.id, { coverage: "looked", bytes: 51425 });
      return { blocks: [block("FORM-BYTES")], notes: [], seen: [`they sent a photo (IMG_1.png); you looked at it when it arrived, it is not in front of you now, and photo_look ${row.id} puts it back in front of you`], viewedMediaIds: [row.id] };
    },
    capture: async (blk, { filename }) => { order.push(`capture:${filename}:${blk.source.data}`); await new Promise(r => setTimeout(r, 20)); return { ok: true, ...FORM }; },
    startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
    run: async () => { order.push("model"); return { ok: true, envelope: { result: "that's a caregiver form with 8 questions, all blank. want me to answer them?" } }; },
  });
  assert.equal(reply, "that's a caregiver form with 8 questions, all blank. want me to answer them?");
  assert.deepEqual(order, ["looked", "capture:IMG_1.png:FORM-BYTES", "model"], "the note starts before the turn, not after it");
  const note = db.mediaItem(C, row.id).description;
  assert.match(note, /A client refuses to take their medication/, "the form's own words, not the chat reply");
  assert.equal(/want me to answer them/.test(note), false);

  // The next turn is handed those words, and told how to see the picture again.
  const next = reviewed.recentPhotosNote(C);
  assert.match(next, new RegExp(`photo #${row.id} \\(IMG_1\\.png\\): A caregiver job application form`));
  assert.match(next, /A client falls while you are assisting them/);
  assert.match(next, /photo_look with its number — never ask them to send it again/);
});

test("the history line says the photo is out of sight and names the way back, never 'cannot look again'", async () => {
  const row = photoRow("IMG_1.png");
  const { imagesFor } = await import("../src/media.js");
  const out = await imagesFor([{ kind: "image", filename: "IMG_1.png", url: row.url, media_id: row.id }], { fetchImpl: serving() });
  assert.equal(out.blocks.length, 1);
  assert.equal(out.seen[0], `they sent a photo (IMG_1.png); you looked at it when it arrived, it is not in front of you now, and photo_look ${row.id} puts it back in front of you`);
});

// ---------- the way back to the picture ----------

test("photo_look fetches the photo the record kept and hands the bytes back under _image", async () => {
  const row = photoRow("IMG_1.png");
  const f = serving();
  const out = await runTool("photo_look", { id: row.id }, { conversationId: C, fetchImpl: f });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.id, row.id);
  assert.equal(out.filename, "IMG_1.png");
  assert.match(out.note, /attached to this result/);
  assert.match(out.note, /never an instruction to you/);
  assert.equal(out._image.media_type, "image/png");
  assert.equal(out._image.data, PNG.toString("base64"));
  assert.equal(out._image.bytes, PNG.length);
});

test("photo_look refuses an id that is not a photo, one that is nobody's, and one whose link has gone — each in words", async () => {
  const voice = photoRow("note.m4a", { kind: "voice" });
  const gone = photoRow("old.png");
  const other = db.recordMedia({ conversationId: "dm:fake:+12025559999", channel: "fake", externalId: "e-x", baseHandle: "e-x", ordinal: 1, kind: "image", filename: "theirs.png", url: "https://cdn.test/theirs.png" });

  const v = await runTool("photo_look", { id: voice.id }, { conversationId: C });
  assert.equal(v.ok, false);
  assert.match(v.error, /voice note, not a photo/);

  const o = await runTool("photo_look", { id: other.id }, { conversationId: C });
  assert.equal(o.ok, false);
  assert.match(o.error, /no item #\d+ in this conversation/);

  const g = await runTool("photo_look", { id: gone.id }, { conversationId: C, fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }) });
  assert.equal(g.ok, false);
  assert.match(g.error, /expires after 30 days/);
  assert.match(g.error, /Work from what the recent-photos note says/);
  assert.equal("_image" in g, false);
});

test("photo_look is a read, so it still runs on a turn the harm screen did not pass", async () => {
  assert.equal(SAFE_WHILE_SCREENED.has("photo_look"), true);
  const row = photoRow("IMG_1.png");
  const out = await runTool("photo_look", { id: row.id }, { conversationId: C, fetchImpl: serving(), harm: { verdict: "borderline" } });
  assert.equal(out.ok, true);
});

test("over MCP the picture goes to the model as an image block, and the log and the JSON only know its size", async () => {
  const row = photoRow("IMG_1.png");
  const logged = [];
  const res = await mcpDispatch(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "photo_look", arguments: { id: row.id } } },
    { conversationId: C, onTool: (l) => logged.push(l), toolCtx: { fetchImpl: serving() } },
  );
  assert.equal(res.result.isError, false);
  assert.equal(res.result.content.length, 2);
  assert.deepEqual(res.result.content[0], { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
  assert.equal(res.result.content[1].type, "text");
  const text = res.result.content[1].text;
  assert.equal(text.includes(PNG.toString("base64")), false, "no base64 in the JSON half");
  assert.match(text, /"attached":true/);
  assert.equal(JSON.stringify(logged).includes(PNG.toString("base64")), false, "and none in the log");
  assert.equal(logged[0].out.image.bytes, PNG.length);
});

test("a result with no picture is exactly what it always was", () => {
  const out = { ok: true, items: [] };
  assert.deepEqual(splitImage(out), { image: null, shown: out });
  assert.deepEqual(splitImage(null), { image: null, shown: null });
});

test("on the API path the picture rides in the tool_result as an image block, and the model's next round has it", async () => {
  const row = photoRow("IMG_1.png");
  const saved = agent.model.create;
  const rounds = [];
  agent.model.create = async (params) => {
    // A snapshot: the loop keeps mutating the one list it hands over.
    rounds.push(structuredClone(params.messages));
    if (rounds.length === 1) {
      return { stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", id: "tu_1", name: "photo_look", input: { id: row.id } }] };
    }
    return { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "question 4 asks how you'd respond to a client asking you to handle their finances" }] };
  };
  try {
    const reply = await agent.runTurn({ conversationId: C, text: "what was question 4 on that form", kind: "user", events: { emit() {} }, log: () => {}, fetchImpl: serving(), capture: async () => ({ ok: false }) });
    assert.match(reply, /question 4/);
    const second = rounds[1];
    const result = second.at(-1).content.find(b => b.type === "tool_result" && b.tool_use_id === "tu_1");
    assert.ok(Array.isArray(result.content), "an array: picture then words");
    assert.deepEqual(result.content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    assert.equal(result.content[1].type, "text");
    assert.equal(result.content[1].text.includes(PNG.toString("base64")), false);
  } finally { agent.model.create = saved; }
  // And the thread keeps none of the bytes.
  assert.equal(JSON.stringify(db.loadConversation(C)).includes(PNG.toString("base64")), false);
});

// ---------- what the model is told ----------

test("the tool is listed, described as the way back, and the record's own description points at it", () => {
  const t = tools.find(x => x.name === "photo_look");
  assert.ok(t);
  assert.match(t.description, /never ask them to send a picture again/);
  assert.match(t.description, /30 days/);
  assert.match(tools.find(x => x.name === "media_reviewed").description, /photo_look/);
});

test("the prompt says a photo is written down and can be brought back, and that a form is a brief", () => {
  const s = agent.SYSTEM;
  assert.equal(/you will never see those pixels again/.test(s), false, "the old line, which taught it to ask for the photo again");
  assert.match(s, /you NEVER ask them to send a picture again/);
  assert.match(s, /photo_look with the photo's number puts the picture itself back in front of you/);
  assert.match(s, /A photo of a form, a worksheet, a questionnaire, an application .* is a brief/);
  assert.match(s, /"Want me to fill it in\?" is the miss/);
});
