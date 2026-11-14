// The brain test line (src/calls/braintest.js, scripts/brain-test-server.mjs). No network, no model: the
// brain's turn and the Cartesia deleter are stand-ins. The bearer, the owner-and-attestation gate, the
// honest lines for anything that would act, and a database opened read-only that cannot be written.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "reason-braintest-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.BRAIN_TEST_VARIANT_FILE = join(dir, "variant.json");
process.env.BRAIN_TEST_NOTES_FILE = join(dir, "notes.jsonl");
delete process.env.ANTHROPIC_API_KEY;
const bt = await import("../src/calls/braintest.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const SECRET = "x".repeat(40);
const auth = { authorization: `Bearer ${SECRET}` };
const post = (path, body, headers = auth, deps = {}) => bt.handle({ method: "POST", path, headers, rawBody: JSON.stringify(body), secret: SECRET, deps: { open: async () => ({ system: "s", preloaded: [] }), ...deps } });
const lines = async (out) => { const all = []; for await (const l of out.stream) all.push(JSON.parse(l)); return all; };

test("no bearer, a wrong one, or a short secret: 401; anything off the path: 404", async () => {
  assert.equal((await post("/brain-test/start", {}, {})).status, 401);
  assert.equal((await post("/brain-test/start", {}, { authorization: "Bearer " + "y".repeat(40) })).status, 401);
  assert.equal(bt.bearerOk(`Bearer ${"s".repeat(10)}`, "s".repeat(10)), false);
  assert.equal((await post("/calls/brain/turn", {})).status, 404);
  assert.equal((await bt.handle({ method: "GET", path: "/brain-test/start", headers: auth, secret: SECRET })).status, 404);
});

test("another number hears the private line, the call ends, and nothing is opened for it", async () => {
  let opened = 0;
  const out = await post("/brain-test/start", { call_id: "c1", from: "+13105550000", attest: "TN-Validation-Passed-A" }, auth, { open: async () => { opened++; return {}; } });
  assert.deepEqual(JSON.parse(out.body), { ok: false, say: bt.PRIVATE_LINE, end: true });
  assert.equal(opened, 0);
  assert.equal((await post("/brain-test/turn", { call_id: "c1", history: [] })).status, 404);
});

test("the owner's number needs attestation A by default: missing or B/C is refused", async () => {
  for (const attest of ["", "No-TN-Validation", "TN-Validation-Passed-B", "TN-Validation-Passed-C", "TN-Validation-Failed"]) {
    assert.equal(bt.gate({ from: "+12025551234", attest }).ok, false, attest || "(none)");
  }
  assert.equal(bt.gate({ from: "+12025551234", attest: "TN-Validation-Passed-A" }).ok, true);
  assert.equal(bt.gate({ from: "+1 (202) 555-1234", metadata: { stir_verstat: "TN-Validation-Passed-A" } }).ok, true);
  // "number" mode (an owner decision in the variant file): the number alone, but a failed check still refuses.
  writeFileSync(process.env.BRAIN_TEST_VARIANT_FILE, JSON.stringify({ gate: "number" }));
  assert.equal(bt.gate({ from: "+12025551234" }).ok, true);
  assert.equal(bt.gate({ from: "+12025551234", attest: "TN-Validation-Passed-C" }).ok, false);
  assert.equal(bt.gate({ from: "+13105550000" }).ok, false);
  rmSync(process.env.BRAIN_TEST_VARIANT_FILE);
});

test("variants come from the file at each call's start; (ii) by default", () => {
  assert.equal(bt.variantNow().id, "ii");
  writeFileSync(process.env.BRAIN_TEST_VARIANT_FILE, JSON.stringify({ variant: "iii" }));
  assert.deepEqual([bt.variantNow().id, bt.variantNow().model, bt.variantNow().openers], ["iii", "claude-opus-5-5", true]);
  writeFileSync(process.env.BRAIN_TEST_VARIANT_FILE, JSON.stringify({ variant: "i" }));
  assert.equal(bt.variantNow().openers, false);
  writeFileSync(process.env.BRAIN_TEST_VARIANT_FILE, "{bad");
  assert.equal(bt.variantNow().id, "ii");
  rmSync(process.env.BRAIN_TEST_VARIANT_FILE);
});

test("the owner's call starts, its turns stream, and its end deletes the call's data at Cartesia", async () => {
  const seen = [];
  const deps = {
    turn: async function* ({ variant, model, openers, full }) { seen.push({ model, openers }); yield { type: "say", text: "We were on the events idea." }; yield { type: "done" }; },
    deleteCall: async (id) => { seen.push({ deleted: id }); return { deleted: true }; },
    gateOpts: { mode: "attested" },
  };
  const s = await post("/brain-test/start", { call_id: "own1", from: "+12025551234", attest: "TN-Validation-Passed-A" }, auth, deps);
  assert.equal(JSON.parse(s.body).ok, true);
  const t = await post("/brain-test/turn", { call_id: "own1", history: [{ role: "user", content: "where were we?" }] }, auth, deps);
  assert.deepEqual((await lines(t)).map(e => e.type), ["say", "done"]);
  assert.deepEqual(seen[0], { model: "claude-haiku-5-5", openers: true });
  assert.equal(bt.liveCalls(), 1);
  await post("/brain-test/end", { call_id: "own1", agent_call_id: "ac_1" }, auth, deps);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(bt.liveCalls(), 0);
  assert.deepEqual(seen.at(-1), { deleted: "ac_1" });
});

test("anything that would act, look up or check gets the honest test-line line; an action is noted locally", () => {
  assert.equal(bt.cannotFor([{ role: "user", content: "can you book the Genius Bar for me?" }]).text, bt.CANNOT.act);
  assert.equal(bt.cannotFor([{ role: "user", content: "did you send it?" }]).text, bt.CANNOT.done);
  assert.equal(bt.cannotFor([{ role: "user", content: "how much is it with tax?" }]).text, bt.CANNOT.lookup);
  assert.equal(bt.cannotFor([{ role: "user", content: "pay with my card" }]).text, bt.CANNOT.act);
  const notes = readFileSync(process.env.BRAIN_TEST_NOTES_FILE, "utf8").trim().split("\n");
  assert.equal(notes.length, 2);
  for (const line of Object.values(bt.CANNOT)) assert.ok(!/\b(?:done|booked|sent)\b/i.test(line.replace(/what's been done/, "")), line);
});

test("a real turn through the brain code: an action ask hands off and is answered with the honest line, no model word", async () => {
  const deps = { gateOpts: { mode: "attested" } };
  await post("/brain-test/start", { call_id: "own2", from: "+12025551234", attest: "TN-Validation-Passed-A" }, auth, deps);
  const t = await post("/brain-test/turn", { call_id: "own2", history: [{ role: "user", content: "did you book it?" }] }, auth, deps);
  const said = (await lines(t)).filter(e => e.type === "say").map(e => e.text);
  assert.equal(said.at(-1), bt.CANNOT.done);
  await post("/brain-test/end", { call_id: "own2" }, auth, deps);
});

test("the self-test streams a stand-in turn with no model and no memory", async () => {
  const out = await post("/brain-test/selftest", {});
  const said = (await lines(out)).filter(e => e.type === "say").map(e => e.text);
  assert.deepEqual(said, ["This is a stand-in turn.", "Nothing was read."]);
});

test("REASON_DB_READONLY=1: the app opens the database read-only, its schema step changes nothing, and a write fails", () => {
  const path = join(dir, "ro.db");
  // A database the app has already made (as the live one is).
  const made = spawnSync(process.execPath, ["-e", "await import('./src/db.js')"], { env: { ...process.env, REASON_DB_PATH: path, REASON_DB_READONLY: "" }, encoding: "utf8", input: "" , cwd: process.cwd() });
  assert.equal(made.status, 0, made.stderr);
  const before = new DatabaseSync(path).prepare("SELECT COUNT(*) n FROM sqlite_master").get().n;
  const probe = `const m = await import('./src/db.js'); let err = ''; try { m.db.prepare("INSERT INTO conversations (id, messages, updated_at) VALUES ('x','[]',1)").run(); } catch (e) { err = e.message; } console.log(JSON.stringify({ ro: m.READ_ONLY, err }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, REASON_DB_PATH: path, REASON_DB_READONLY: "1" }, encoding: "utf8", cwd: process.cwd() });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(o.ro, true);
  assert.match(o.err, /readonly|read-only/i);
  const d = new DatabaseSync(path);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM conversations WHERE id = 'x'").get().n, 0);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM sqlite_master").get().n, before);
  assert.ok(existsSync(path));
});
