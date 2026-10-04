// The gate reading real sentences, with the real model. These are the four replies the old word
// lists got wrong. Nothing here asserts wording: only what is in the confirmations table and what
// is on the fixture site's booking list. Skipped with no model reachable (no API key, no claude-cli backend).
//
// The last one is the dangerous case. "ok but make it 9 instead" contains "ok", so a word list
// granted it and booked the 8:00 he had just rejected. Here it must authorize nothing.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBookingSite } from "./fixture-booking.js";

const dir = mkdtempSync(join(tmpdir(), "reason-gate-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const browser = await import("../src/browser.js");
const { clock } = await import("../src/config.js");

const { skip } = await import("./live.js");
const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });
let site;

before(async () => { site = await startBookingSite(); });
after(async () => {
  await browser.closeAllBrowsers();
  await site.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM conversations;");
  site.bookings.length = 0;
});

const SUMMARY = "Book Carbone, party of 4, Fri Oct 9 2026 at 8:00 PM, under Omari, 555-0100. $25 per person cancellation hold.";

/** Ask, let the owner answer that sentence, and hand back the confirmation row itself. */
async function answered(conversationId, reply, summary = SUMMARY) {
  const messages = [owner("book me a table at carbone")];
  const ctx = { conversationId, messages };
  const req = await runTool("confirm_request", { action: "browser_submit", summary, stakes: "both" }, ctx);
  messages.push(owner(reply));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, ctx);
  return { rec, row: db.getConfirmation(conversationId, req.confirmation_id) };
}

// Each of these contains a word the old NEGATIVE or AFFIRMATIVE list tripped over.
for (const reply of ["no problem, book it", "don't wait, do it now", "perfect, lock it in"]) {
  test(`"${reply}" is a go-ahead`, { skip }, async () => {
    const { rec, row } = await answered(`dm:gate-yes-${reply.length}`, reply);
    assert.equal(rec.state, "granted", `state was ${rec.state}: ${rec.error ?? ""}`);
    assert.ok(row.granted_at, "granted in the table");
    assert.equal(row.granted_quote, reply, "their exact words are on the record");
    assert.equal(row.refused_at, null);
  });
}

test('"ok but make it 9 instead" authorizes nothing', { skip }, async () => {
  const { rec, row } = await answered("dm:gate-change", "ok but make it 9 instead");
  assert.equal(rec.state, "changed", `state was ${rec.state}: ${rec.error ?? ""}`);
  assert.equal(row.granted_at, null, "the 8:00 PM he just rejected is NOT authorized");
  assert.equal(row.refused_at, null, "and he did not say no, so it is not dead either");
  assert.equal(site.bookings.length, 0, "nothing was booked");

  // That yes cannot be spent on the action it was asked for.
  const blocked = await runTool("browser_submit",
    { ref: "e1", what: "Carbone 8:00 PM", confirmation_id: row.id },
    { conversationId: "dm:gate-change", messages: [] });
  assert.equal(blocked.blocked, "not_granted");
  assert.equal(site.bookings.length, 0);
});

test('a bare "no" is refused', { skip }, async () => {
  const { rec, row } = await answered("dm:gate-no", "no");
  assert.equal(rec.state, "refused");
  assert.ok(row.refused_at);
  assert.equal(row.granted_at, null);
});

// End to end: the detail he changed is the detail that gets booked, and only after a fresh yes.
test("a changed detail is re-asked and the booking lands on the new time", { skip }, async () => {
  const C = "dm:gate-flow";
  const rt = new Runtime();
  try {
    await rt.inbound(C, `book me a table for 4 at carbone on 2026-10-09 at 8pm. the site is ${site.url} — name on it is Omari, number 555-0100`);
    const first = db.pendingConfirmations(C).filter(x => x.action === "browser_submit");
    assert.ok(first.length >= 1, "it asked before committing");
    assert.equal(site.bookings.length, 0, "nothing booked before any yes");

    // He approves, but moves the time. The 8:00 on record must not go through.
    await rt.inbound(C, "ok but make it 9 instead");
    assert.equal(site.bookings.length, 0, "the 8:00 he rejected was NOT booked");
    assert.equal(db.getConfirmation(C, first[0].id).granted_at, null, "the 8:00 yes was never granted");

    // It should have come back with the new time and asked again.
    const reasked = db.pendingConfirmations(C)
      .filter(x => x.action === "browser_submit" && x.id !== first[0].id);
    assert.ok(reasked.length >= 1, "it asked again with the corrected details");
    assert.match(reasked.at(-1).summary, /9[:. ]?00|9 ?pm/i, "the new ask names the time he wanted");

    // Now the yes is for 9:00, and that is what gets booked.
    await rt.inbound(C, "yeah that's it");
    assert.equal(site.bookings.length, 1, "exactly one reservation");
    assert.match(site.bookings[0].time, /9:00 PM/, "booked at the time he changed it to");
    assert.equal(site.bookings[0].party, "4");

    const row = db.listActions(C).find(a => a.action === "browser_submit" && a.outcome === "ok");
    assert.ok(row, "the commit is in the ledger");
    assert.equal(row.confirmation_id, reasked.at(-1).id, "authorized by the second yes, not the first");
    assert.ok(db.getConfirmation(C, first[0].id).granted_at === null, "the 8:00 confirmation never counted");
  } finally {
    await rt.shutdown();
  }
});
