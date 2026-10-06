// How much care a job is worth, and what "done" costs at each level.
//
// The failure this is built against runs both ways. Hold a lunch suggestion to the checks a lease
// needs and Reason becomes an interrogation nobody wants to text; hold a lease to the checks a
// lunch spot needs and somebody signs a twelve-month commitment Reason never opened. So the sheet
// carries one mark — low, money, binding — the model puts it there, and **code** decides from it
// how deep the check before `done` goes. The model cannot talk its way past the depth, and it does
// not have to argue for a shallow one either: it says which kind of job this is, once.
//
// What each level has to be true, and these tests are the whole of it:
//
//   - every level: a step that was asked about and never executed still blocks `done`, and the
//     links in the closing line still have to open. Those two are never traded away.
//   - `money`: the fee check as well. This is also what an UNMARKED job gets, which is the point —
//     the default is exactly what every job got before the mark existed, so adding the mark
//     tightened nothing retroactively. Only `binding` is stricter than the old behaviour, and only
//     `low` is looser, and both have to be asked for.
//   - `binding`: the real terms have to be on the sheet — not a summary page about them — and a
//     price it closes on has to have the page it came from on the sheet. Those are the two things
//     that only matter when somebody cannot walk away from the result.
//   - `failed` and `cancelled` are never checked at any level. An honest close is never the blocked
//     path — that is the one rule the stakes mark must not be able to touch.
//
// The web is stated rather than reached (`lookup`), so none of this leaves the machine. No API key.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-stakes-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { checkFinish } = await import("../src/verify.js");
const { parseSheet, applyPatch, sheetView, stakesOf, STAKES, DEFAULT_STAKES } = await import("../src/sheet.js");

const C = "dm:stakes";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM confirmations;");
});

const call = (name, input = {}, ctx = {}) => runTool(name, input, { conversationId: C, ...ctx });
/** The web, stated: every link opens unless it is the dead one. */
const lookup = async (url) => (url.includes("gone")
  ? { ok: false, status: 404, error: "not found" }
  : { ok: true, url, status: 200, title: "a page", text: "words" });

const PRICE = { what: "rent", amount: "$1,850/mo", where: "https://listings.example.com/441-graham" };
const DOC = { what: "the lease", where: "https://listings.example.com/441-graham/lease.pdf", says: "two months' rent to break it, 60 days' notice, no fee" };

// ---------------------------------------------------------------- the mark itself

test("the mark is one of three words, and the model is the one who sets it", () => {
  assert.deepEqual(STAKES, ["low", "money", "binding"]);

  for (const s of STAKES) {
    const r = applyPatch({}, { stakes: s });
    assert.equal(r.ok, true, s);
    assert.equal(r.sheet.stakes, s);
  }

  const bad = applyPatch({}, { stakes: "high" });
  assert.equal(bad.ok, false, "'high' is not one of the three, so it is refused rather than guessed at");
  assert.match(bad.error, /low, money, binding/);
  assert.match(bad.error, /lease|contract|flight/, "the refusal says what each word is for");
});

test("an unmarked job counts as money, because the cheap mistake is over-checking", () => {
  assert.equal(DEFAULT_STAKES, "money");
  assert.equal(parseSheet({}).stakes, null, "nothing is invented on the sheet itself");
  assert.equal(stakesOf({}), "money", "but everything that reads it treats unmarked as money");
  assert.equal(stakesOf({ stakes: "low" }), "low");
  assert.equal(stakesOf('{"stakes":"binding"}'), "binding", "including a sheet that is still a string");

  const view = sheetView({});
  assert.match(view.stakes, /^money \(you have not marked this job/, "and the model is told it is unmarked rather than told it is money");
});

test("the note the model gets is the one for the level it is on", () => {
  assert.match(sheetView({ stakes: "low" }).stakes_note, /Do not interview them about a lunch spot/);
  assert.match(sheetView({ stakes: "money" }).stakes_note, /page you actually saw it on/);
  assert.match(sheetView({ stakes: "binding" }).stakes_note, /ACTUAL document/);
  assert.match(sheetView({ stakes: "binding" }).stakes_note, /cannot close this job as done without it/);
});

// ---------------------------------------------------------------- low

test("low: a lunch spot is not held to a lease's checks", async () => {
  const sheet = { stakes: "low", constraints: { fees_included: { value: "yes", source: "them", said: "with fees" } } };
  // A bare total with no fee line on it, which would be refused at money and above.
  const r = await checkFinish({ sheet, outcome: "got you a table at Mu Ramen, $34", lookup });
  assert.equal(r.ok, true, "low stakes is not held to the fee check");
  assert.equal(r.stakes, "low");
  assert.ok(r.could_not.some(x => /low stakes/.test(x)), "and it says out loud that it skipped it");
});

test("low: the two checks that are never traded away still hold", async () => {
  const sheet = { stakes: "low" };

  const dead = await checkFinish({ sheet, outcome: "all booked: https://example.com/gone", lookup });
  assert.equal(dead.ok, false, "a dead link is a dead link at any stakes");
  assert.equal(dead.blocked, "link_is_dead");

  const asked = await checkFinish({
    sheet, outcome: "done",
    gates: [{ id: 7, action: "message_send", summary: "text Kofi the address?" }],
    lookup,
  });
  assert.equal(asked.ok, false, "and 'done' never means 'started', however small the job");
  assert.equal(asked.blocked, "asked_but_never_done");
});

// ---------------------------------------------------------------- money

test("money: the fee check runs, and it does not at low", async () => {
  const sheet = { constraints: { fees_included: { value: "yes", source: "them", said: "with the fees in it" } } };

  const held = await checkFinish({ sheet: { ...sheet, stakes: "money" }, outcome: "got it for $1,850", lookup });
  assert.equal(held.ok, false, "they asked for fees and this is a bare price");
  assert.equal(held.blocked, "fees_not_shown");
  assert.equal(held.stakes, "money");

  const low = await checkFinish({ sheet: { ...sheet, stakes: "low" }, outcome: "got it for $1,850", lookup });
  assert.equal(low.ok, true, "the same line closes a low job");
  assert.ok(low.could_not.some(x => /low stakes/.test(x)), "and it says which check it skipped");
});

test("money: a number with no source behind it still closes, and is not claimed as checked", async () => {
  const r = await checkFinish({ sheet: { stakes: "money" }, outcome: "booked it, $1,850 all in", lookup });
  assert.equal(r.ok, true, "a price source is not required to close a money job — only a binding one");
  assert.equal(r.checked.some(x => /price/.test(x)), false, "and nothing claims a price was checked");
});

test("a price with its page on the sheet is reported, and one site is said to be one site", async () => {
  const one = await checkFinish({ sheet: { stakes: "money", prices: [PRICE] }, outcome: "booked it, $1,850 all in", lookup });
  assert.equal(one.ok, true);
  assert.ok(one.checked.some(x => /listings\.example\.com/.test(x)), "it says which site the number came off");
  assert.ok(one.could_not.some(x => /one site/.test(x)), "and that it was only the one");

  const two = await checkFinish({
    sheet: { stakes: "money", prices: [PRICE, { what: "rent", amount: "$1,850/mo", where: "https://other.example.org/441-graham" }] },
    outcome: "booked it, $1,850 all in", lookup,
  });
  assert.equal(two.could_not.some(x => /one site/.test(x)), false, "a second site clears that caveat");
});

test("an unmarked sheet is checked exactly as money is, which is exactly as before the mark existed", async () => {
  const sheet = { constraints: { fees_included: { value: "yes", source: "them", said: "with the fees in it" } } };

  const bare = await checkFinish({ sheet, outcome: "got it for $1,850", lookup });
  assert.equal(bare.ok, false, "nobody marked it, so it gets the money checks");
  assert.equal(bare.blocked, "fees_not_shown");
  assert.equal(bare.stakes, "money");

  const fine = await checkFinish({ sheet, outcome: "got it for $1,850 plus $120 fees, $1,970 all in", lookup });
  assert.equal(fine.ok, true, "and a good close on an unmarked job is not made harder by the mark existing");
});

// ---------------------------------------------------------------- binding

test("binding: a lease cannot be closed by somebody who never opened the lease", async () => {
  const r = await checkFinish({ sheet: { stakes: "binding", prices: [PRICE] }, outcome: "signed, $1,850/mo all in", lookup });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, "terms_never_read");
  assert.match(r.error, /sheet\.document/);
  assert.match(r.error, /not reachable/, "and says what to do when the document genuinely cannot be got at");
  assert.match(r.error, /summary page/, "a page about the terms is not the terms");
});

test("binding: and it cannot be closed on a number with no page behind it", async () => {
  const r = await checkFinish({ sheet: { stakes: "binding", document: DOC }, outcome: "signed, $1,850/mo all in", lookup });
  assert.equal(r.ok, false, "the terms were read, but the rent is a figure from nowhere");
  assert.equal(r.blocked, "price_with_no_source");
  assert.match(r.error, /sheet\.prices/, "the refusal names the field that fixes it");
  assert.match(r.error, /'failed'/, "and names the honest close as a real alternative");

  const noNumber = await checkFinish({ sheet: { stakes: "binding", document: DOC }, outcome: "signed and the keys are with the super", lookup });
  assert.equal(noNumber.ok, true, "the check is on a number in the closing line, not on every binding job");
});

test("binding: with the terms read and written down, it closes — and says what it read", async () => {
  const r = await checkFinish({
    sheet: { stakes: "binding", prices: [PRICE], document: DOC },
    outcome: "signed, $1,850/mo all in: https://listings.example.com/441-graham",
    lookup,
  });
  assert.equal(r.ok, true);
  assert.equal(r.stakes, "binding");
  assert.ok(r.checked.some(x => /the lease/.test(x)), "the summary names the document it read");
  assert.ok(r.checked.some(x => /link\(s\) in the closing line open/.test(x)));
});

test("binding: a part of the terms it could not read is carried into what it may not claim", async () => {
  const r = await checkFinish({
    sheet: { stakes: "binding", prices: [PRICE], document: { ...DOC, could_not: "the fee schedule is behind a login" } },
    outcome: "signed: https://listings.example.com/441-graham",
    lookup,
  });
  assert.equal(r.ok, true, "a partial read is not a refusal — it is a thing to say out loud");
  assert.ok(r.could_not.some(x => /fee schedule is behind a login/.test(x)));
  assert.match(r.note, /Do not say you verified something in that list/);
});

test("binding: the document has to be a real link with real words on it", () => {
  const noLink = applyPatch({}, { document: { where: "the lease they emailed me", says: "60 days" } });
  assert.equal(noLink.ok, false, "a description of a document is not a document");
  assert.match(noLink.error, /not a link/);

  const noWords = applyPatch({}, { document: { where: "https://example.com/lease.pdf" } });
  assert.equal(noWords.ok, false);
  assert.match(noWords.error, /cancellation, fees, dates/, "the refusal says what has to be read off it");

  const ok = applyPatch({}, { document: DOC });
  assert.equal(ok.ok, true);
  assert.equal(ok.sheet.document.says, DOC.says);
});

test("a price needs what it is for, the amount, and the page — all three", () => {
  for (const missing of ["what", "amount", "where"]) {
    const row = { ...PRICE };
    delete row[missing];
    const r = applyPatch({}, { prices: [row] });
    assert.equal(r.ok, false, `a price with no ${missing} is not a price`);
  }
  const notALink = applyPatch({}, { prices: [{ ...PRICE, where: "zillow" }] });
  assert.equal(notALink.ok, false, "and the source is a page, not the name of one");
  assert.match(notALink.error, /not a link/);
});

// ---------------------------------------------------------------- the floor

test("an honest close is never blocked, at any level", async () => {
  // Through the real tool, because this is the path that matters: `failed` and `cancelled` must not
  // touch checkFinish at all, whatever the sheet says and whatever is still open on the job.
  for (const [i, stakes] of ["low", "money", "binding"].entries()) {
    const started = await call("task_start", {
      title: `job ${i}`, goal: "something",
      sheet: { stakes, constraints: { fees_included: { value: "yes", source: "them", said: "fees in it" } } },
    });
    const id = started.task.task_id ?? started.task.id;
    const failed = await call("task_finish", { task_id: id, state: "failed", outcome: "could not, $1,850 and no source for it: https://example.com/gone" }, { lookup });
    assert.equal(failed.ok, true, `failed must go through on a ${stakes} job`);
  }

  const started = await call("task_start", { title: "a binding one", goal: "sign it", sheet: { stakes: "binding" } });
  const id = started.task.task_id ?? started.task.id;
  const cancelled = await call("task_finish", { task_id: id, state: "cancelled", outcome: "they called it off" }, { lookup });
  assert.equal(cancelled.ok, true, "and so must cancelled, with no document anywhere near the sheet");
});

test("the stakes depth reaches task_finish through the real tool", async () => {
  const started = await call("task_start", { title: "sign the lease", goal: "signed", sheet: { stakes: "binding", prices: [PRICE] } });
  const id = started.task.task_id ?? started.task.id;

  const held = await call("task_finish", { task_id: id, state: "done", outcome: "all signed, $1,850/mo" }, { lookup });
  assert.equal(held.ok, false, "the tool, not just the checker, refuses it");
  assert.equal(held.blocked, "terms_never_read");
  assert.equal(db.getTask(C, id).open, true, "and nothing was written: the job is still open");

  await call("task_update", { task_id: id, progress: "read the lease", sheet: { document: DOC } });
  const done = await call("task_finish", { task_id: id, state: "done", outcome: "all signed, $1,850/mo" }, { lookup });
  assert.equal(done.ok, true);
  assert.equal(db.getTask(C, id).state, "done");
});

test("the mark can be changed when a job turns out to be bigger than it looked", async () => {
  const started = await call("task_start", { title: "find lunch", goal: "a sandwich", sheet: { stakes: "low" } });
  const id = started.task.task_id ?? started.task.id;

  const up = await call("task_update", { task_id: id, progress: "turns out they want to put a deposit down", sheet: { stakes: "binding" } });
  assert.equal(up.ok, true);
  assert.equal(db.getTask(C, id).sheet.stakes, "binding", "changing the mark is an ordinary update, not a fight");
});
