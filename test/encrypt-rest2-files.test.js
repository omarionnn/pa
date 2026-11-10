// Encryption at rest, phase 2, files on disk (src/restfiles.js, REASON_ENCRYPT_REST2=on).
// What has to hold:
//   - a person's recordings, uploads, documents, photos, cards are written sealed under their key:
//     a byte scan of every file under the data directory finds none of what was written into them
//     (the mutation check: drop one writeSealed/sealInPlace and this fails);
//   - every reader gets the plain bytes back: the recording export, the /f/ document route, the
//     /img/ route (what Sendblue fetches by URL), Sendblue's own upload, a Web upload's fetch shim;
//   - a tool that needs a path gets a plain temp copy that is gone afterwards;
//   - files already on disk are sealed by the migration, and opened again by the rollback;
//   - "forget everything" re-seals the files that stay under the new key; old key gone.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-encrest2f-"));
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_DOCUMENT_ROOT = join(dir, "documents");
process.env.REASON_IMAGEN_OUTPUT = join(dir, "images");
process.env.REASON_WEB_AUDIO_ROOT = join(dir, "web-audio");
process.env.REASON_AUDIO_TMP = join(dir, "audio-tmp");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_REST2 = "on";
process.env.REASON_ENCRYPT_STRICT = "0";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "55".repeat(32);
process.env.REASON_TOKEN_KEY ||= "44".repeat(32);

const d = await import("../src/db.js");
const rc = d.restcrypt;
const rf = await import("../src/restfiles.js");
const rec = await import("../src/calls/recordings.js");
const docs = await import("../src/documents/store.js");
const uploads = await import("../src/webuploads.js");
const http = await import("../src/http.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const C = "dm:sendblue:+15550007777";
const MARK = "AMA-SESAME-7731-PRIVATE";
// A WAV whose samples spell the marker, so a plain copy anywhere on disk is found by a byte scan.
function wav(extra = MARK) {
  const data = Buffer.from(extra.repeat(200));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(MARK.repeat(20))]);
const PDF = Buffer.from(`%PDF-1.4\n${MARK}\n%%EOF\n`);

function* everyFile(root) {
  if (!existsSync(root)) return;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) yield* everyFile(p); else yield p;
  }
}
/** Every file under the data directory except the databases themselves (those have their own scan). */
function plainFilesWith(needle) {
  return [...everyFile(dir)].filter(p => !/\/(reason|keys)\.db/.test(p)).filter(p => readFileSync(p).includes(Buffer.from(needle)));
}

let callId, docId, upload, imgName;

test("flag 2 on: recordings, documents, uploads and pictures are written sealed and read back plain", async () => {
  const call = d.createCall(C, { provider: "twilio", toNumber: "+15550004444", isOwner: true, goal: "x", facts: [] });
  callId = call.id;
  // From a provider URL ...
  const fetchImpl = async () => new Response(wav(), { status: 200, headers: { "content-type": "audio/wav" } });
  const saved = await rec.storeRecording(call.id, { url: "https://api.example/rec", format: "wav", seconds: 3 }, { fetchImpl, owner: C });
  assert.equal(saved.ok, true, saved.error);
  assert.ok(rc.isSealedBytes(readFileSync(saved.file)), "the recording on disk is sealed");
  assert.deepEqual(rec.readRecording(saved.file), wav(), "the export reads it plain");
  assert.equal(saved.bytes, wav().length);
  d.updateCall(C, call.id, { recording_state: "stored", recording_file: saved.file, recording_format: "wav" });
  // ... and a live-call tape already at its own path (GPT-Live writes it there itself).
  const call2 = d.createCall(C, { provider: "twilio", toNumber: "+15550004444", isOwner: true, goal: "y", facts: [] });
  const tape = rec.recordingFileFor(call2.id, "wav");
  writeFileSync(tape, wav());
  const s2 = await rec.storeRecording(call2.id, { path: tape, format: "wav", seconds: 3 }, { owner: C });
  assert.equal(s2.ok, true, s2.error);
  assert.ok(rc.isSealedBytes(readFileSync(tape)), "the tape is sealed in place");

  // A document.
  docId = d.newDocumentId();
  const w = docs.writeDocument({ id: docId, kind: "pdf", filename: "letter.pdf", bytes: PDF, owner: C });
  assert.equal(w.ok, true, w.error);
  assert.equal(w.bytes, PDF.length, "the plain size is on the row");
  d.createDocument(C, { id: docId, kind: "pdf", title: "Letter", blocks: [], filename: "letter.pdf", path: w.file, bytes: w.bytes, sha256: w.sha256 });
  const doc = d.getDocument(docId);
  const served = http.documentRequest({ id: docId, key: doc.owner_key });
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(served.body), PDF, "/f/ serves the plain PDF");

  // A Web upload: the file and its record (name, later its words).
  upload = uploads.store({ conversationId: C, bytes: PNG, name: `${MARK}.png` });
  assert.ok(upload.id, JSON.stringify(upload));
  assert.ok(rc.isSealedBytes(readFileSync(uploads.filePath(upload))));
  assert.equal(uploads.meta(upload.id).conversationId, C, "the sealed record still reads");
  uploads.update(upload.id, { transcript: MARK });
  assert.equal(uploads.meta(upload.id).transcript, MARK);
  const shim = uploads.localUpload(uploads.uploadUrl(upload.id, "x.png"), { conversationId: C });
  assert.deepEqual(Buffer.from(await (await shim.fetch()).arrayBuffer()), PNG, "the model's fetch gets the plain photo");

  // A generated picture, served by URL (Sendblue fetches /img/ for send_picture).
  mkdirSync(process.env.REASON_IMAGEN_OUTPUT, { recursive: true });
  imgName = "0b9c7a52-1111-4222-8333-944455556666.png";
  const imgPath = join(process.env.REASON_IMAGEN_OUTPUT, imgName);
  writeFileSync(imgPath, PNG);
  assert.equal(rf.sealInPlace(imgPath, C), true);
  const img = http.imageRequest(imgName);
  assert.equal(img.status, 200);
  assert.deepEqual(Buffer.from(img.body), PNG, "/img/ serves the plain picture");
  d.rememberSeenUrls(C, [`https://app.example/img/${imgName}`], { kind: "generated" });

  // Sendblue's upload reads the plain bytes off a sealed file.
  assert.deepEqual(new SendblueChannel().readFile(uploads.filePath(upload)), PNG);
});

test("a raw byte scan of every file finds none of what was written into them", () => {
  assert.deepEqual(plainFilesWith(MARK), []);
});

test("a tool that wants a path gets a plain copy, removed afterwards", async () => {
  const file = rec.recordingFileFor(callId, "wav");
  let seen = null;
  const r = await rf.withPlainPath(file, (p) => { seen = p; return readFileSync(p); });
  assert.deepEqual(r, wav());
  assert.notEqual(seen, file);
  assert.equal(existsSync(seen), false, "the plain copy is gone");
  // A plain file is handed over as it is.
  const plain = join(dir, "plain.txt"); writeFileSync(plain, "x");
  await rf.withPlainPath(plain, (p) => assert.equal(p, plain));
  rmSync(plain);
});

test("files already on disk: the migration seals them for their owner; the rollback opens them", async () => {
  // Written before phase 2 (plain): a recording named for its call, an upload, a screenshot.
  process.env.REASON_ENCRYPT_REST2 = "off";
  const call = d.createCall(C, { provider: "twilio", toNumber: "+15550004444", isOwner: true, goal: "z", facts: [] });
  const old = rec.recordingFileFor(call.id, "mp3");
  writeFileSync(old, Buffer.concat([Buffer.from("ID3"), Buffer.from(MARK)]));
  const sib = join(process.env.REASON_RECORDING_ROOT, `call-${call.id}.caf`);
  writeFileSync(sib, Buffer.from("caff" + MARK));
  const up = uploads.store({ conversationId: C, bytes: PNG, name: "old.png" });
  mkdirSync(process.env.REASON_SHOT_ROOT, { recursive: true });
  const shot = join(process.env.REASON_SHOT_ROOT, `${C.replace(/[^a-zA-Z0-9._-]/g, "_")}-1700000000000.png`);
  writeFileSync(shot, PNG);
  const nobody = join(process.env.REASON_IMAGEN_OUTPUT, "ffffffff-0000-4000-8000-000000000000.png");
  writeFileSync(nobody, Buffer.from("nobody's"));
  process.env.REASON_ENCRYPT_REST2 = "on";
  assert.ok(plainFilesWith(MARK).length >= 3);

  const s = await rf.migrateFiles(d.rawPrepare, "seal");
  assert.ok(s.sealed >= 5, JSON.stringify(s));
  assert.equal(s.unowned, 1, "the one file nobody is named for is left, and counted");
  assert.deepEqual(plainFilesWith(MARK), []);
  for (const p of [old, sib, uploads.filePath(up), shot]) assert.ok(rc.isSealedBytes(readFileSync(p)), p);
  assert.equal(rf.keyIdOfFile(old), rf.keyIdOfFile(uploads.filePath(upload)), "under the owner's own key");

  // Rollback: everything plain again, byte for byte.
  const o = await rf.migrateFiles(d.rawPrepare, "open");
  assert.ok(o.opened >= 8, JSON.stringify(o));
  assert.equal(rf.fileStatus().reduce((n, r) => n + r.sealed, 0), 0);
  assert.deepEqual(readFileSync(uploads.filePath(upload)), PNG);
  await rf.migrateFiles(d.rawPrepare, "seal");
  assert.deepEqual(plainFilesWith(MARK), []);
});

test("a sealed file's declared size is its plain size (Linq signs the upload's length)", () => {
  const file = rec.recordingFileFor(callId, "wav");
  assert.equal(rf.plainStat(file).size, wav().length);
  assert.equal(rf.plainSize(file), wav().length);
  assert.equal(rf.plainStat(file).isFile(), true);
});

test("flags off with only sealed files left (a rollback cut short): the keystore still unlocks", async () => {
  const file = rec.recordingFileFor(callId, "wav");
  process.env.REASON_ENCRYPT_REST = "off"; process.env.REASON_ENCRYPT_REST2 = "off";
  rc._resetForTests();
  await rc.init(process.env.REASON_DB_PATH, { hasSealed: () => rf.anySealedFile() });
  assert.equal(rc.active(), true);
  assert.deepEqual(rec.readRecording(file), wav());
  process.env.REASON_ENCRYPT_REST = "on"; process.env.REASON_ENCRYPT_REST2 = "on";
  rc._resetForTests();
  await rc.init(process.env.REASON_DB_PATH);
});

test("forget everything: the files that stay are re-sealed under the new key, the old key is gone", async () => {
  const ios = await import("../src/ios/memory.js");
  const file = rec.recordingFileFor(callId, "wav");
  const before = rf.keyIdOfFile(file);
  // A crash leftover (half-written temp of a sealed file) and a damaged file under the same key
  // must not stop the delete: the first is skipped by name, the second is left as it was.
  const raw = readFileSync(file);
  const leftover = `${file}.rs-4242-deadbeef`;
  writeFileSync(leftover, raw.subarray(0, raw.length - 7));
  const damaged = join(process.env.REASON_RECORDING_ROOT, "call-999999.wav");
  writeFileSync(damaged, Buffer.concat([raw.subarray(0, raw.length - 3), Buffer.from("xyz")]));
  await ios.forgetEverything({ conversation_id: C });
  const nowId = rf.keyIdOfFile(file);
  assert.ok(nowId && nowId !== before, "re-sealed under a new key");
  assert.equal(rc.keystore().prepare("SELECT 1 FROM user_keys WHERE id = ?").get(before), undefined, "the old key is destroyed");
  assert.deepEqual(rec.readRecording(file), wav(), "and the recording still plays");
  assert.ok(rc.unreadableFiles.includes(damaged), "the damaged one is reported, not fatal");
  assert.equal(rf.sweepPlainTmp() >= 1, true);
  assert.equal(existsSync(leftover), false, "the leftover temp is swept");
  rmSync(damaged);
});

test("a person deleted: their files open to nothing", () => {
  const file = uploads.filePath(upload);
  rc.destroyKey(C);
  assert.equal(rf.readPlain(file).length, 0);
});
