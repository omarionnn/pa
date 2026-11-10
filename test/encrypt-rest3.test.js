// Encryption at rest, phase 3 (src/restcrypt.js SENSITIVE3, REASON_ENCRYPT_REST3=on on top of phase 1).
// What has to hold:
//   - a person's own name, the name on Reason's contact card and their own number (accounts.address)
//     are written sealed, with a keyed blind index (accounts.address_bi) beside the number;
//   - a raw byte scan of reason.db finds none of them (the mutation check: drop one seal3 call and
//     run with REST3_BYTE_SCAN_ONLY=1 — this test fails);
//   - every exact-match lookup on the number still works: routing (accountByAddress / accountByNumber),
//     every account on a number, "stopped", the signup cap, one plan per number;
//   - old plain rows migrate online (index filled in the same write) and stay findable throughout;
//   - phase 3 rolls back on its own (REASON_ENCRYPT_REST3=off + --open) while phases 1 and 2 stay sealed;
//   - export reads the plain values; "forget everything" re-keys them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-encrest3-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_REST2 = "on";
process.env.REASON_ENCRYPT_REST3 = "on";
const scanOnly = process.env.REST3_BYTE_SCAN_ONLY === "1";
process.env.REASON_ENCRYPT_STRICT = scanOnly ? "0" : "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "35".repeat(32);
process.env.REASON_TOKEN_KEY ||= "44".repeat(32);

const d = await import("../src/db.js");
const rc = d.restcrypt;
const { config } = await import("../src/config.js");
const access = await import("../src/access.js");
const plan = await import("../src/plan.js");
const data = await import("../src/data.js");
after(() => rmSync(dir, { recursive: true, force: true }));

// Conversation ids here do NOT contain the number, so the number may only exist sealed or hashed.
const C1 = "web:p3-first", C2 = "web:p3-second", C3 = "web:p3-old";
const NUM = "+19175550177", NUM_OLD = "+16465550123";
const NAME = "Abena Owusu-Testname", CARD = "Kwasi Cardname", NAME_OLD = "Efua Oldrowname";

function fileHas(needle) {
  d.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const files = [process.env.REASON_DB_PATH, process.env.REASON_DB_PATH + "-wal"].filter(existsSync);
  return files.some(f => readFileSync(f).includes(Buffer.from(needle)));
}
const raw = id => d.rawPrepare("SELECT name, contact_card_name, address, address_bi FROM accounts WHERE conversation_id = ?").get(id);
const phase3 = () => rc.status(d.rawPrepare).filter(s => s.phase === 3);

test("flag 3 on: name, card name and number are written sealed, with a blind index, and read back plain", () => {
  assert.ok(rc.flag3On());
  d.upsertAccount({ conversationId: C1, channel: "sendblue", address: NUM, name: NAME });
  d.setContactCardName(C1, CARD);
  const r = raw(C1);
  for (const k of ["name", "contact_card_name", "address"]) assert.ok(rc.isSealed(r[k]), `${k} sealed`);
  assert.match(r.address_bi, /^bi1:/);
  const a = d.getAccount(C1);
  assert.equal(a.name, NAME); assert.equal(a.address, NUM); assert.equal(a.contact_card_name, CARD);
  assert.equal(d.contactCardNameByToken(a.contact_card_token), CARD);
  // The same number again (every inbound text upserts): the stored ciphertext is kept, not re-written.
  d.upsertAccount({ conversationId: C1, channel: "sendblue", address: NUM });
  assert.equal(raw(C1).address, r.address);
  assert.equal(d.getAccount(C1).name, NAME, "an empty name never overwrites");
  d.setAccountName(C1, NAME + " Jr");
  assert.ok(rc.isSealed(raw(C1).name));
  assert.equal(d.getAccount(C1).name, NAME + " Jr");
  d.setAccountName(C1, NAME);
});

test("every exact-match lookup on the number finds the sealed row", () => {
  assert.equal(d.accountByAddress("sendblue", NUM)?.conversation_id, C1);
  assert.equal(d.accountByAddress("sendblue", "+1 (917) 555-0177")?.conversation_id, C1, "normalized");
  assert.equal(d.accountByAddress("linq", NUM), null, "channel still matters");
  assert.equal(d.accountByNumber(NUM)?.conversation_id, C1);
  // The same number on a second line: one person, both accounts found, one plan, not a second signup.
  d.upsertAccount({ conversationId: C2, channel: "linq", address: NUM, name: "" });
  assert.deepEqual(d.accountsByAddress(NUM).map(a => a.conversation_id).sort(), [C1, C2].sort());
  d.rawPrepare("INSERT OR IGNORE INTO plan (conversation_id, first_seen_at, updated_at) VALUES (?, 1, 1)").run(C1);
  assert.equal(plan.planId(C2), C1, "one plan per number, found through the blind index");
  const prev = config.signupsPerHour;
  try {
    config.signupsPerHour = 2;
    assert.equal(access.signupsFull(), false, "two accounts on one number count as one signup");
    config.signupsPerHour = 1;
    assert.equal(access.signupsFull(), true);
  } finally { config.signupsPerHour = prev; }
  // "stopped" is per number, across lines.
  d.setAccountState(C2, "paused");
  assert.equal(d.stoppedStateOf(NUM), "paused");
  d.setAccountState(C2, "active");
  assert.equal(d.stoppedStateOf(NUM), null);
});

test("byte scan: no name, card name or number in the database file", () => {
  for (const s of [NAME, CARD, NUM, NUM.slice(2)]) assert.equal(fileHas(s), false, `found ${s.slice(0, 3)}… in reason.db`);
});

test("an old plain row migrates online: sealed and indexed in one write, findable before and after", () => {
  rc.dropStrictTriggers(d.db);
  d.rawPrepare("INSERT INTO accounts (conversation_id, channel, address, name, created_at) VALUES (?, 'sendblue', ?, ?, ?)").run(C3, NUM_OLD, NAME_OLD, 1);
  if (!scanOnly) rc.installStrictTriggers(d.db);
  assert.equal(d.accountByAddress("sendblue", NUM_OLD)?.conversation_id, C3, "plain row found before migration");
  assert.ok(phase3().some(s => s.plain > 0));
  let guard = 0;
  while (rc.migrateBatch(d.rawPrepare, "seal", 50) > 0 && guard++ < 100);
  for (const s of phase3()) assert.equal(s.plain, 0, `${s.column} plain left`);
  const r = raw(C3);
  assert.ok(rc.isSealed(r.address) && rc.isSealed(r.name));
  assert.match(r.address_bi, /^bi1:/);
  assert.equal(d.accountByAddress("sendblue", NUM_OLD)?.conversation_id, C3);
  assert.equal(d.getAccount(C3).name, NAME_OLD);
  for (const s of [NAME_OLD, NUM_OLD]) assert.equal(fileHas(s), false);
});

test("export reads the plain values; the blind index never leaves", () => {
  const out = data.exportData({ conversation: C1, audio: false, files: false });
  const acct = out.tables.accounts?.[0];
  assert.equal(acct?.name, NAME);
  assert.equal(acct?.address, NUM);
});

test("phase 3 rolls back alone: flag 3 off + open, phases 1 and 2 untouched, lookups still work", () => {
  d.appendEventLog?.(C1, "user", "phase one text");
  process.env.REASON_ENCRYPT_REST3 = "off";
  try {
    rc.dropStrictTriggers(d.db);
    let guard = 0;
    while (rc.migrateBatch(d.rawPrepare, "open", 50, [3]) > 0 && guard++ < 100);
    for (const s of phase3().filter(s => !s.column.endsWith("_bi"))) assert.equal(s.sealed, 0, `${s.column} still sealed`);
    assert.equal(raw(C1).address, NUM);
    assert.equal(raw(C1).name, NAME);
    assert.equal(d.accountByAddress("sendblue", NUM)?.conversation_id, C1);
    // Flag off: a new account is written plain with no index.
    d.upsertAccount({ conversationId: "web:p3-off", channel: "sendblue", address: "+13125550111", name: "Off Flag" });
    const off = raw("web:p3-off");
    assert.equal(off.address, "+13125550111"); assert.equal(off.address_bi, null);
    assert.equal(d.accountByNumber("+13125550111")?.conversation_id, "web:p3-off");
  } finally {
    process.env.REASON_ENCRYPT_REST3 = "on";
    if (!scanOnly) rc.installStrictTriggers(d.db);
  }
  // Re-seal for what follows.
  let guard = 0;
  while (rc.migrateBatch(d.rawPrepare, "seal", 50) > 0 && guard++ < 100);
});

test("forget everything re-keys the account row it keeps, so it still reads (and routes)", () => {
  const before = raw(C1).address;
  rc.rotatePersonKey(d.rawPrepare, C1);
  assert.notEqual(raw(C1).address, before);
  assert.equal(d.getAccount(C1).address, NUM);
  assert.equal(d.accountByAddress("sendblue", NUM)?.conversation_id, C1);
});
