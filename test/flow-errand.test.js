// One errand end to end in a DM, driven by the real model: book a table.
// The site is a local fixture, so no reservation is ever made anywhere real.
// Ground truth is the fixture server's booking list plus the DB. Skipped without ANTHROPIC_API_KEY.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBookingSite } from "./fixture-booking.js";

const dir = mkdtempSync(join(tmpdir(), "reason-errand-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";

const { Runtime } = await import("../src/runtime.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const skip = !process.env.ANTHROPIC_API_KEY;
const C = "dm:errand";
const called = [];
const rt = new Runtime({ log: (e) => { if (e.tool) called.push(e.tool); } });
let site;

before(async () => { clock.reset(); site = await startBookingSite(); });
after(async () => { await rt.shutdown(); await site.close(); rmSync(dir, { recursive: true, force: true }); });

const since = () => { const n = called.length; return () => called.slice(n); };

test("drives the booking site to the confirm step and stops there", { skip }, async () => {
  const used = since();
  const reply = await rt.inbound(C,
    `book me a table for 4 at carbone on 2026-10-09 at 8pm. the site is ${site.url} — name on it is Omari, number 555-0100`);

  assert.ok(used().includes("browser_open"), `it used the browser; called: ${used().join(",")}`);
  assert.equal(site.bookings.length, 0, "NOTHING was booked before Omari said yes");

  // It got far enough to see the real details and write down what it intends to commit.
  const pending = db.pendingConfirmations(C).filter(x => x.action === "browser_submit");
  assert.ok(pending.length >= 1, `it asked before committing; called: ${used().join(",")}`);
  const summary = pending[0].summary.toLowerCase();
  assert.match(summary, /carbone/, "the summary names the place");
  assert.match(summary, /8[:. ]?00|8 ?pm/, "the summary names the time");
  assert.equal(pending[0].granted_at, null, "no yes on it yet");

  assert.ok(reply && reply.length > 0, "it said something and waited");
  // The browser really reached the reservation form, and every page it opened has a receipt.
  const opens = db.listActions(C).filter(a => a.action === "browser_open");
  assert.ok(opens.length >= 1, "opening the site left a receipt");
  assert.ok(!db.listActions(C).some(a => a.action === "browser_submit" && a.outcome === "ok"), "no commit yet");
});

test("an explicit yes books it once, for real, with a receipt", { skip }, async () => {
  const used = since();
  await rt.inbound(C, "yeah do it");

  assert.ok(used().includes("confirm_record"), `it recorded the yes; called: ${used().join(",")}`);
  assert.equal(site.bookings.length, 1, "exactly one reservation on the site");
  const b = site.bookings[0];
  assert.equal(b.place_name, "Carbone");
  assert.equal(b.party, "4");
  assert.match(b.time, /8:00 PM/);
  assert.match(b.name, /Omari/i);
  assert.ok(b.phone.includes("555-0100"), "the real phone number went in");

  const row = db.listActions(C).find(a => a.action === "browser_submit" && a.outcome === "ok");
  assert.ok(row, "the commit is in the ledger");
  assert.ok(row.confirmation_id, "the receipt names the yes that authorized it");
  const conf = db.getConfirmation(C, row.confirmation_id);
  assert.ok(conf.granted_at && conf.consumed_at, "granted and spent");
  assert.match(conf.granted_quote, /y/i, "Omari's own words are on the record");
});

test("'did it actually go through' is answered from the ledger", { skip }, async () => {
  const used = since();
  const reply = await rt.inbound(C, "did that actually go through? what's the confirmation number");
  assert.ok(used().includes("ledger_list") || used().includes("browser_read"),
    `it went back to the record, not its memory; called: ${used().join(",")}`);
  assert.ok(reply.includes(site.bookings[0].code), "it quotes the code the site actually returned");
  assert.equal(site.bookings.length, 1, "asking about it did not book a second one");
});
