// Stamps for everyone (REASON_STAMPS_ALL, 2026-10-30). REASON_WEB_DAILY=owner kept the book, its awards and
// its shares to the operator. With REASON_STAMPS_ALL on, anyone with an account has them — the book, the
// STAMPS link, the "New in your book" tile on Home — without the daily edition, and nobody is told: the
// thread line about a seal stays behind REASON_WEB_DAILY=on. Off: exactly as before.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-stamps-all-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_WEB = "on";
delete process.env.REASON_BACKEND;

const db = await import("../src/db.js");
const stamps = await import("../src/stamps.js");
const { stampsRequest, shareRequest } = await import("../src/pages/webstamps.js");
const { conversationPage } = await import("../src/pages/webconvo.js");
const { stampsAllowedFor } = await import("../src/dailyflag.js");
const { clock } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const OTHER_C = "dm:+12025550000";
const T0 = Date.parse("2026-10-27T18:00:00Z"); // 2 PM in New York
const told = [];

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  process.env.REASON_WEB_DAILY = "owner";
  process.env.REASON_STAMPS_WAX = "on";
  process.env.REASON_STAMPS_EVERYDAY = "on";
  process.env.REASON_STAMPS_TIERS = "on";
  delete process.env.REASON_STAMPS_ALL;
  told.length = 0;
  stamps.installStamps({ tell: (c, line) => told.push([c, line]), delayMs: 0 });
  db.db.exec(`DELETE FROM accounts; DELETE FROM threads; DELETE FROM stamps; DELETE FROM stamp_shares; DELETE FROM stamp_jobs; DELETE FROM stamp_step_times;
    DELETE FROM messages; DELETE FROM tasks; DELETE FROM calls; DELETE FROM research;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari Nyarko", isOperator: true });
  db.upsertAccount({ conversationId: OTHER_C, channel: "fake", address: "+12025550000", name: "Ama Mensah", isOperator: false });
});

const setNow = (t) => { clock.reset(); clock.skip(t - Date.now()); };
const research = (conv, at) => {
  setNow(at);
  const id = Number(db.db.prepare("INSERT INTO research (conversation_id, question, created_at, updated_at) VALUES (?, 'which bike', ?, ?)").run(conv, at - 60_000, at - 60_000).lastInsertRowid);
  db.finishResearch(conv, id);
  return id;
};
const shown = (conv) => stamps.listStamps(conv).filter(s => s.type === "looked_into");
const account = (conv) => db.getAccount(conv);
// Home, past the one-time first-visit page.
const homeOf = (conv, now) => { db.markWebNoticeSeen(conv); return String(conversationPage({ account: account(conv), headers: {}, sendId: "s", query: { home: "" }, now })); };

test("off: someone who isn't the operator has no book, no awards, no link", () => {
  research(OTHER_C, T0);
  assert.equal(stampsAllowedFor(OTHER_C), false);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM stamps WHERE conversation_id = ?").get(OTHER_C).n, 0);
  return stampsRequest({ account: account(OTHER_C) }).then(r => {
    assert.equal(r, null);
    const home = homeOf(OTHER_C, T0);
    assert.ok(home.includes("greet") && !home.includes('href="/web/stamps"'));
  });
});

test("on: their research earns the seal, the book draws it, Home links to it and shows it — and nobody is told", async () => {
  process.env.REASON_STAMPS_ALL = "on";
  research(OTHER_C, T0);
  assert.equal(shown(OTHER_C).length, 1);
  assert.equal(told.length, 0, "the seal is never texted at REASON_WEB_DAILY=owner");
  const book = await stampsRequest({ account: account(OTHER_C) });
  assert.equal(book.status, 200);
  assert.match(book.body, /Looked into/i);
  const home = homeOf(OTHER_C, T0 + 60_000);
  assert.ok(home.includes('href="/web/stamps"'), "STAMPS in the top bar");
  assert.ok(home.includes("NEW IN YOUR BOOK"), "this week's seal on Home");
  // A week and more later the tile is gone; the link stays.
  const later = homeOf(OTHER_C, T0 + 8 * 86_400_000);
  assert.ok(later.includes('href="/web/stamps"') && !later.includes("NEW IN YOUR BOOK"));
});

test("on: their share opens; off again: it doesn't, and their book is a 404 as before", async () => {
  process.env.REASON_STAMPS_ALL = "on";
  research(OTHER_C, T0);
  const id = shown(OTHER_C)[0].id;
  const share = stamps.shareStamp(OTHER_C, id);
  const shareId = share.shareId;
  assert.equal((await shareRequest({ shareId })).status, 200);
  delete process.env.REASON_STAMPS_ALL;
  assert.equal((await shareRequest({ shareId })).status, 404);
  assert.equal(await stampsRequest({ account: account(OTHER_C) }), null);
});

test("on: the backfill covers everyone with an account and tells nobody", () => {
  research(OTHER_C, T0); // earned while off: not in their book
  process.env.REASON_STAMPS_ALL = "on";
  assert.equal(shown(OTHER_C).length, 0);
  const counts = stamps.backfill(OTHER_C, { dryRun: false });
  assert.ok(Object.values(counts).reduce((a, b) => a + b, 0) >= 1);
  assert.equal(shown(OTHER_C).length, 1);
  assert.equal(told.length, 0);
});
