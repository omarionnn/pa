// Organising a Drive with the real model in the controller's seat.
//
// `test/driveorg.test.js` proves the tools: the request shapes, the scope split, the gate, the
// batch cap, the ledger. It drives them directly, so the one thing it cannot prove is the thing
// the whole design turns on — whether the model, asked to tidy something up, PROPOSES first and
// moves only on a yes. Three things, in the order of what it would cost to get them wrong:
//
//   1. **A folder that does not exist is made, and not asked about.** "make a folder called Taxes
//      2026" is an instruction, not a question. A model that answers it with "shall I?" has spent
//      a turn of his to learn nothing.
//   2. **More than one file is PROPOSED, never moved.** The gate would refuse a batch with no yes
//      anyway, so the failure to catch is not a stray move — it is a model that takes the refusal
//      as an error and says "I can't", or that asks him to approve a list of file ids. The ground
//      truth is the fake's own `driveUpdates`, which must still be empty when the proposal lands.
//   3. **"yes" moves exactly the two files that were proposed, and the reply says so in counts.**
//      Not a list, not ids, and never a third file swept in.
//
// One test, three turns, on purpose: this runs on Omari's Claude subscription and every turn is
// his money. No real Google — the same fake the rest of the Google suite uses, with the organising
// scope granted. Skipped with no model reachable.
//
//   REASON_BACKEND=claude-cli node --test test/flow-driveorg.test.js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-driveorg-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
// Not an undo-window test. Moving is not held anyway — off so that stays true if the rules widen.
process.env.REASON_UNDO_SECONDS = "0";

const { startGoogle, fakeFile } = await import("./fixture-google.js");
const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const google = await import("../src/google.js");
const { config, clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const C = "dm:owner";
const DOC = "application/vnd.google-apps.document";
const FOLDER = "application/vnd.google-apps.folder";
let fake;

/** Two receipts of his, a doc that is nothing to do with tax, and the folder they all live in. */
const HIS_FILES = () => [
  fakeFile({ id: "f-r1", name: "Receipt — plumber", mimeType: "application/pdf", modifiedTime: "2026-09-01T10:00:00.000Z", bytes: Buffer.from("%PDF-1.4 plumber"), parents: ["fol-root"] }),
  fakeFile({ id: "f-r2", name: "Receipt — dentist", mimeType: "application/pdf", modifiedTime: "2026-09-02T10:00:00.000Z", bytes: Buffer.from("%PDF-1.4 dentist"), parents: ["fol-root"] }),
  fakeFile({ id: "f-plan", name: "Moving plan", mimeType: DOC, modifiedTime: "2026-10-01T10:00:00.000Z", text: "1. boxes", parents: ["fol-root"] }),
  fakeFile({ id: "fol-root", name: "Documents", mimeType: FOLDER, modifiedTime: "2026-07-01T10:00:00.000Z" }),
];

before(async () => {
  fake = await startGoogle();
  config.googleClientId = "client-abc.apps.googleusercontent.com";
  config.googleClientSecret = "secret-xyz";
  config.googleOauthBase = fake.url;
  config.googleAccountsBase = fake.url;
  config.googleGmailBase = fake.url;
  config.googleCalendarBase = fake.url;
  config.googleDriveBase = fake.url;
  config.publicUrl = "";
});

after(async () => {
  await fake?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM held_actions; DELETE FROM conversations; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM outbox;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  fake.reset();
  fake.set({
    email: "me@example.com",
    grantScopes: [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES, ...google.DRIVE_ORGANISE_SCOPES],
    accessTtlSeconds: 3600, refreshTokenValid: true, giveRefreshToken: true,
    files: HIS_FILES(),
  });
});

/** Google connected through its real handshake, so the tokens are ones the flow produced. */
async function connectGoogle() {
  const link = await runTool("google_connect", { scopes: google.DRIVE_ORGANISE_SCOPES }, { conversationId: C, messages: [] });
  const state = new URL(link.url).searchParams.get("state");
  await google.completeConnect({ code: "good-code", state });
}

const taxFolder = () => fake.files().find(f => f.mimeType === FOLDER && /taxes/i.test(f.name));
const inTaxes = () => {
  const folder = taxFolder();
  return folder ? fake.files().filter(f => (f.parents ?? []).includes(folder.id)) : [];
};

test(`a folder is just made, a batch is proposed, and his yes moves exactly those two (${label})`, { skip }, async () => {
  await connectGoogle();
  const rt = new Runtime({ log: () => {} });

  // 1. An instruction, not a question. Making a folder reaches nobody and costs nothing, so the
  // only right answer is a made folder and a line saying so.
  const made = String(await rt.inbound(C, "make a folder in my drive called Taxes 2026"));

  const folder = taxFolder();
  assert.ok(folder, `no folder was made. it said: ${made}`);
  assert.match(folder.name, /Taxes 2026/i, `the folder is called ${folder.name}`);
  assert.match(made, /taxes 2026/i, `it did not say what it made: ${made}`);

  // 2. The tidy-up. Two files, so the gate refuses without a yes — and what matters is what the
  // model does with that refusal: say what is going where, in counts, and wait.
  const proposed = String(await rt.inbound(C, "ok now move my receipts into it"));

  assert.equal(fake.state.driveUpdates.length, 0, `it moved files with no yes. it said: ${proposed}`);
  assert.equal(inTaxes().length, 0, "the folder should still be empty");
  // It has to say what it is about to do. Two, or both, or the two names — and then a question.
  assert.match(proposed, /2|two|both|receipt/i, `it did not say what it would move: ${proposed}`);
  assert.match(proposed, /\?/, `it did not actually ask: ${proposed}`);
  // Never a list of ids put in front of a person.
  assert.doesNotMatch(proposed, /f-r1|f-r2|fol-root/, `it showed him file ids: ${proposed}`);
  // And it did not report the move as done while asking about it.
  assert.doesNotMatch(proposed, /moved them|i've moved|i have moved/i, `it claimed a move that has not happened: ${proposed}`);

  // 3. His yes.
  const done = String(await rt.inbound(C, "yes"));

  const landed = inTaxes().map(f => f.name).sort();
  assert.deepEqual(landed, ["Receipt — dentist", "Receipt — plumber"], `what ended up in the folder: ${landed.join(", ")}. it said: ${done}`);
  // The moving plan is not a receipt and was never mentioned; a tidy-up that sweeps in a third file
  // is the one nobody notices until they go looking for it.
  assert.deepEqual(fake.files().find(f => f.id === "f-plan").parents, ["fol-root"], "it moved a file he never asked about");
  // One ledger row per file that really moved, which is what makes "what did you do to my drive"
  // answerable file by file.
  const rows = db.listActions(C).filter(a => a.action === "drive_move" && a.outcome === "ok");
  assert.equal(rows.length, 2, `the ledger has ${rows.length} rows for a two-file move`);
  // And the reply is a line with counts in it, not a list and not an id.
  assert.doesNotMatch(done, /f-r1|f-r2/, `it said a file id out loud: ${done}`);
  assert.match(done, /2|two|both/i, `it did not say how many moved: ${done}`);
});
