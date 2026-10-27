// The contact card's photo wears the brand pen colour — orange on 10-25, brick red since 10-26, the
// Web handoff's italic "r" + outlined bubble since 10-27 — and the owner, only the owner, gets a new
// card once per change he asks for (scripts/card-to-owner.js: 10-25 orange, 10-27 the new mark). Temp database, stubbed sender, no network, no model:
//
//   is the card's photo the brand-red one, never the old blue or orange one?
//   does the vCard carry that photo?
//   does the one-off send reach only the owner's dm:owner thread, once, and refuse without --confirm?
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "reason-card-brand-"));
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const { vcard } = await import("../src/contact.js");
const S = await import("../scripts/card-to-owner.js");

const PHOTO = new URL("../assets/reason-contact.jpg", import.meta.url);
// sha256 of assets/reason-contact.jpg. BRAND = the Web handoff's contact mark (owner, 2026-10-27):
// Instrument Serif italic "r" + the pen #9c3b2e speech-bubble outline on paper #f2ebe0, rendered
// from the handoff's reason-contact.svg in headless Chromium with assets/fonts. If the photo is
// redrawn on purpose, update BRAND; BLUE, ORANGE (10-25), RED1 (first brick red) and RED2 (the
// filled-ring #9c3b2e photo of 10-26 ~23:45) must never come back.
const BRAND = "dbefb618a1bc62752c1a1ac2da9a56d217e3cadf5f727765f473778a4ddbaf20";
const RED2 = "bbee1c8d4362a008e75834c6911dc38f83c2a5843b64b8de15c9d71c2b49151d";
const RED1 = "5b965ff3b76f9b228f37727f6c2a9dcc605af2373a1deb751d4153e81fcc3ca5";
const ORANGE = "5213b3e9877e863725dc9ac7c84074d1f283f4964bb42974351ff307fad30bc9";
const BLUE = "f29eadd2272eb5148002306adbbdccbf1fdf06518b655d965108aca961809d23";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  db.db.exec("DELETE FROM accounts;");
  rmSync(S.markerFor(S.SEND_ID, dir), { force: true });
});

function stubRouter() {
  const sent = [];
  return {
    sent,
    get: () => ({ status: () => ({ number: "+16562167455" }) }),
    sendMediaUrl: async (m) => { sent.push(m); return { ok: true, delivered: { message_id: `m${sent.length}` } }; },
  };
}

test("the card's photo is the brand-red one, never the old blue or orange", () => {
  const bytes = readFileSync(PHOTO);
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.notEqual(sha, BLUE, "the blue-bubble photo is back");
  assert.notEqual(sha, ORANGE, "the orange-bubble photo is back");
  assert.notEqual(sha, RED1, "the first brick-red photo is back");
  assert.notEqual(sha, RED2, "the filled-ring photo is back");
  assert.equal(sha, BRAND);
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8, "still a JPEG (iOS saves JPEG card photos reliably)");
  assert.ok(vcard({ number: "+16562167455" }).replace(/\r\n /g, "").includes(bytes.toString("base64")), "the vCard carries this photo");
});

test("the one-off send reaches only the owner's thread, once", async () => {
  db.upsertAccount({ conversationId: "dm:owner", channel: "sendblue", address: "+12025551234", name: "Owner" });
  db.db.prepare("UPDATE accounts SET is_operator = 1 WHERE conversation_id = 'dm:owner'").run();
  db.upsertAccount({ conversationId: "dm:sendblue:+14155550001", channel: "sendblue", address: "+14155550001", name: "Someone" });
  const router = stubRouter();
  const marker = S.markerFor(S.SEND_ID, dir);
  const r = await S.sendCardToOwner({ router, marker });
  assert.equal(r.outcome, "sent");
  assert.equal(r.conversationId, "dm:owner");
  assert.deepEqual(router.sent.map(m => m.to), ["+12025551234"]);
  assert.match(router.sent[0].mediaUrl, /^https:\/\/reason\.example\.test\/reason-[0-9a-f]{8}\.vcf$/);
  assert.ok(existsSync(marker));
  assert.equal((await S.sendCardToOwner({ router, marker })).outcome, "already");
  assert.equal(router.sent.length, 1, "a rerun sends nothing");
});

test("a failed send releases the claim, so a later run can try again", async () => {
  db.upsertAccount({ conversationId: "dm:owner", channel: "sendblue", address: "+12025551234", name: "Owner" });
  db.db.prepare("UPDATE accounts SET is_operator = 1 WHERE conversation_id = 'dm:owner'").run();
  const marker = S.markerFor(S.SEND_ID, dir);
  const down = { ...stubRouter(), sendMediaUrl: async () => ({ ok: false, error: "down" }) };
  assert.equal((await S.sendCardToOwner({ router: down, marker })).outcome, "failed");
  assert.ok(!existsSync(marker));
  const router = stubRouter();
  assert.equal((await S.sendCardToOwner({ router, marker })).outcome, "sent");
  assert.equal(router.sent.length, 1);
});

test("no owner, or two owner numbers: it refuses and sends nothing", async () => {
  const router = stubRouter();
  await assert.rejects(S.sendCardToOwner({ router, marker: S.markerFor(S.SEND_ID, dir) }), /exactly one owner/);
  for (const n of ["+12025551234", "+12025559999"]) {
    db.upsertAccount({ conversationId: `dm:sendblue:${n}`, channel: "sendblue", address: n, name: "x" });
  }
  db.db.prepare("UPDATE accounts SET is_operator = 1").run();
  await assert.rejects(S.sendCardToOwner({ router, marker: S.markerFor(S.SEND_ID, dir) }), /exactly one owner/);
  assert.equal(router.sent.length, 0);
});

test("the CLI refuses without --confirm", () => {
  let code = 0, err = "";
  try {
    execFileSync(process.execPath, [new URL("../scripts/card-to-owner.js", import.meta.url).pathname], { env: { ...process.env }, stdio: "pipe" });
  } catch (e) { code = e.status; err = String(e.stderr); }
  assert.equal(code, 2);
  assert.match(err, /--confirm=card-mark-1027/);
});
