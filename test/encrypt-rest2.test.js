// Encryption at rest, phase 2 (src/restcrypt.js SENSITIVE2, REASON_ENCRYPT_REST2=on on top of phase 1).
// What has to hold:
//   - message copies, call goal/facts, stranger call words, saved addresses (shipping name, phone,
//     email, street), rules, preferences, guesses, whys, pages and documents are written sealed;
//   - a raw byte scan of reason.db finds none of the phone numbers, emails or words written into
//     them (the mutation check: drop one seal call and this test fails, see the PR);
//   - everything reads back, and every exact-match lookup on those columns still works
//     (same preference twice, same guess twice, same rule twice, webMessageSent);
//   - phase 2 rolls back on its own (REASON_ENCRYPT_REST2=off + --open) while phase 1 stays sealed;
//   - "forget everything" re-keys phase-2 rows too, so an earlier backup copy is unreadable.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "reason-encrest2-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_REST2 = "on";
// REST2_BYTE_SCAN_ONLY=1 turns strict mode off, so the byte scan alone has to catch a missing seal
// (the mutation check in the PR: remove one seal2 call and run with it).
const scanOnly = process.env.REST2_BYTE_SCAN_ONLY === "1";
process.env.REASON_ENCRYPT_STRICT = scanOnly ? "0" : "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "33".repeat(32);
process.env.REASON_WEB = "1";
process.env.REASON_TOKEN_KEY ||= "44".repeat(32);

const d = await import("../src/db.js");
const rc = d.restcrypt;
const shipping = await import("../src/shipping.js");
const stranger = await import("../src/strangercalls.js");
const ios = await import("../src/ios/memory.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const C = "dm:sendblue:+15550003333";
// Numbers and emails that are NOT anyone's conversation id: they may only exist sealed.
const FRIEND_PHONE = "+19175550142";
const FRIEND_EMAIL = "kofi.mensah.example@gmail.com";
const STRANGER_PHONE = "+12125550199";
const SECRET = "the gate code is 7731 and Ama is allergic to sesame";

function fileHas(needle) {
  d.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const files = [process.env.REASON_DB_PATH, process.env.REASON_DB_PATH + "-wal"].filter(existsSync);
  return files.some(f => readFileSync(f).includes(Buffer.from(needle)));
}
const phase2 = () => rc.status(d.rawPrepare).filter(s => s.phase === 2);

let pageId, docId, strangerId, callId;

test("flag 2 on: every phase-2 write path seals, and reads back as written", () => {
  assert.ok(rc.flag2On());
  const said = `text ${FRIEND_PHONE} or mail ${FRIEND_EMAIL}: ${SECRET}`;
  assert.equal(d.claimInbound({ channel: "sendblue", externalId: "in-1", conversationId: C, text: said }), true);
  d.rememberInboundPart({ channel: "sendblue", baseHandle: "h1", partIndex: 0, conversationId: C, text: said });
  assert.equal(d.getInboundPart({ channel: "sendblue", baseHandle: "h1", partIndex: 0 }).text, said);
  d.holdInbound({ conversationId: C, channel: "sendblue", address: "+15550003333", externalId: "in-2", text: said, quietMs: 1000, maxMs: 5000 });
  assert.equal(d.takePendingInbound(C)[0].text, said);
  const out = d.enqueueOutbound({ idemKey: "o-1", conversationId: C, channel: "sendblue", address: "+15550003333", body: said });
  assert.equal(out.row.body, said);
  const call = d.createCall(C, { provider: "twilio", toNumber: "+15550004444", isOwner: true, goal: `ask ${FRIEND_EMAIL} about the gate`, facts: [SECRET] });
  callId = call.id;
  const back = d.getCall(C, call.id);
  assert.equal(back.goal, `ask ${FRIEND_EMAIL} about the gate`);
  assert.deepEqual(Array.isArray(back.facts) ? back.facts : JSON.parse(back.facts), [SECRET]);

  shipping.learn(C, { first_name: "Ama", last_name: "Owusu", address1: "77 Quietwater Lane", city: "Brooklyn", state: "NY", zip: "11216", phone: FRIEND_PHONE, email: FRIEND_EMAIL }, { source: "test" });
  const ship = shipping.profileRow(C);
  assert.equal(ship.address1, "77 Quietwater Lane");
  assert.equal(ship.phone, FRIEND_PHONE.slice(2), "shipping keeps the 10 digits");
  assert.equal(ship.email, FRIEND_EMAIL);
  shipping.learn(C, { address2: "Apt 4R" }, { source: "test" });
  assert.equal(shipping.profileRow(C).address2, "Apt 4R");

  d.savePlace(C, { name: "Gym", address: "12 Nostrand Quay", lat: 40.1, lng: -73.9, routeDescription: "the B44 to Fulton" });
  assert.equal(d.listPlaces(C).find(p => p.name === "Gym").address, "12 Nostrand Quay");

  assert.equal(d.learnPreference(C, { category: "food", words: SECRET, turnedDown: "Carbone" }).already_knew, false);
  assert.equal(d.learnPreference(C, { category: "food", words: SECRET, turnedDown: "Carbone" }).already_knew, true, "same preference twice is one");
  assert.equal(d.noteGuess(C, { about: "Ama", guess: SECRET }).already_guessed, false);
  assert.equal(d.noteGuess(C, { about: "Ama", guess: SECRET }).already_guessed, true, "same guess twice is one");
  assert.ok(d.confirmGuess(C, { about: "Ama", guess: SECRET, said: SECRET }).confirmed_at);
  assert.equal(d.stateWhy(C, { about: "the trip", why: "see Ama", said: SECRET }).already_knew, false);
  assert.equal(d.stateWhy(C, { about: "the trip", why: "see Ama", said: SECRET }).already_knew, true);
  const rule = d.addRule(C, { rule: "Never call before 9, the gate code is 7731", why: SECRET });
  assert.ok(rule.ok && !rule.already);
  assert.equal(d.addRule(C, { rule: "Never call before 9, the gate code is 7731" }).already, true, "same rule twice is one");
  assert.equal(d.getRule(C, rule.rule.id).why, SECRET);

  const page = d.createPage(C, { title: "Ama's sesame list", blocks: [{ type: "text", text: SECRET }], subtitle: FRIEND_EMAIL });
  pageId = page.id;
  assert.equal(d.getPage(page.id).title, "Ama's sesame list");
  d.updatePage(C, page.id, { title: "Ama's sesame list, v2", blocks: [{ type: "text", text: SECRET + "!" }] });
  assert.equal(d.getPage(page.id).blocks[0].text, SECRET + "!");
  docId = d.newDocumentId();
  d.createDocument(C, { id: docId, kind: "letter", title: "Letter to Kofi", blocks: [{ type: "text", text: SECRET }], filename: "letter.pdf", path: join(dir, "letter.pdf"), bytes: 1, sha256: "x" });
  assert.equal(d.getDocument(docId).blocks[0].text, SECRET);

  const s = stranger.open({ phone: STRANGER_PHONE });
  strangerId = s.id;
  stranger.noteTurn({ id: s.id, token: s.token, messages: [{ role: "user", content: `call me back on ${FRIEND_PHONE}, ${SECRET}` }] });

  for (const st of phase2()) assert.equal(st.plain, 0, `${st.column} has plain rows`);
  assert.ok(phase2().reduce((n, st) => n + st.sealed, 0) >= 25);
  const raw = d.rawPrepare("SELECT said FROM stranger_calls WHERE id = ?").get(s.id).said;
  assert.match(raw, /^enc:u1:/);
});

test("search vectors are sealed, and search still finds the nearest", async () => {
  const emb = await import("../src/embedding.js");
  const v = (x) => { const f = new Float32Array(1536); f[0] = x; f[1] = 1 - x; return f; };
  await emb.embedAndStore(C, 9001, "x", { vector: v(0.9) });
  await emb.embedAndStore(C, 9002, "y", { vector: v(0.1) });
  const raw = d.rawPrepare("SELECT embedding FROM fact_embeddings WHERE fact_id = 9001").get().embedding;
  assert.equal(typeof raw, "string");
  assert.match(raw, /^enc:u1:/);
  const hits = await emb.search(C, "", { vector: v(0.95), minScore: 0.5 });
  assert.equal(hits[0].factId, 9001);
  assert.equal(emb.vectorsFor(C, [9002]).get(9002)[0], Float32Array.from([0.1])[0]);
});

test("a raw byte scan of reason.db finds none of the numbers, emails or words", () => {
  for (const needle of [FRIEND_PHONE, FRIEND_PHONE.slice(2), STRANGER_PHONE.slice(2), FRIEND_EMAIL, "kofi.mensah", "7731", "sesame", "Quietwater", "Nostrand", "Owusu", "Letter to Kofi"]) {
    assert.equal(fileHas(needle), false, `"${needle}" is in the database file in plain text`);
  }
});

test("exact-match lookups on sealed columns still work", () => {
  const said = "the web words, exactly";
  const o = d.enqueueOutbound({ idemKey: "o-web", conversationId: C, channel: "web", address: "web:abc", body: said });
  d.writeMessage({ conversationId: C, role: "assistant", channel: "web", text: said, externalId: "w-1", outboxId: o.row.id });
  assert.ok(d.webMessageSent({ address: "web:abc", text: said, since: 0, until: Date.now() + 1e9 }), "webMessageSent finds a sealed body");
  // A stranger who rang from a number that later signs up is still found: the blind index matches.
  const later = "dm:sendblue:" + STRANGER_PHONE;
  d.upsertAccount({ conversationId: later, channel: "sendblue", address: STRANGER_PHONE });
  assert.equal(stranger.pendingFor(later)?.id, strangerId, "found by keyed hash, never by the stored number");
  assert.match(d.rawPrepare("SELECT phone FROM stranger_calls WHERE id = ?").get(strangerId).phone, /^bi1:/);
  assert.equal(stranger.pendingFor(C), null, "another number matches nothing");
});

test("strict mode refuses a plain write to a phase-2 column", { skip: scanOnly }, () => {
  assert.throws(() => d.db.prepare("UPDATE outbox SET body = 'plain words' WHERE conversation_id = ?").run(C), /plaintext write to outbox\.body with REASON_ENCRYPT_REST2=on/);
  assert.throws(() => d.db.prepare("UPDATE shop_shipping SET phone = '+19175550000' WHERE conversation_id = ?").run(C), /shop_shipping\.phone/);
  assert.throws(() => d.db.prepare("UPDATE guesses SET \"use\" = 'plain' WHERE conversation_id = ?").run(C), /guesses\.use/);
});

test("phase 2 rolls back on its own; phase 1 stays sealed; then seals again", () => {
  d.writeEvent({ conversationId: C, role: "user", content: SECRET });
  process.env.REASON_ENCRYPT_REST2 = "off";
  rc.installStrictTriggers(d.db); // drops the phase-2 triggers, keeps phase 1's
  while (rc.migrateBatch(d.rawPrepare, "open", 500, [2]) > 0) { /* batches */ }
  assert.ok(phase2().every(s => s.sealed === 0), "every phase-2 value is plain again");
  assert.ok(rc.status(d.rawPrepare).filter(s => s.phase === 1).every(s => s.plain === 0), "phase 1 untouched");
  assert.equal(shipping.profileRow(C).phone, FRIEND_PHONE.slice(2));
  assert.equal(d.getPage(pageId).blocks[0].text, SECRET + "!");
  assert.ok(d.rawPrepare("SELECT embedding FROM fact_embeddings WHERE fact_id = 9002").get().embedding instanceof Uint8Array, "--open writes the vector's bytes back");
  // Flag 2 off: new writes are plain, as before phase 2.
  d.enqueueOutbound({ idemKey: "o-off", conversationId: C, channel: "sendblue", address: "+15550003333", body: "written while off" });
  assert.equal(d.rawPrepare("SELECT body FROM outbox WHERE idem_key = 'o-off'").get().body, "written while off");

  process.env.REASON_ENCRYPT_REST2 = "on";
  rc.installStrictTriggers(d.db);
  while (rc.migrateBatch(d.rawPrepare, "seal", 500) > 0) { /* batches */ }
  assert.ok(phase2().every(s => s.plain === 0), "the online migration seals them all again");
  assert.equal(d.getDocument(docId).title, "Letter to Kofi");
  assert.equal(d.getCall(C, callId).goal, `ask ${FRIEND_EMAIL} about the gate`);
  assert.equal(fileHas(FRIEND_EMAIL), false, "secure_delete: the plain copy is not left in free pages");
  assert.ok(Buffer.isBuffer(d.rawPrepare("SELECT embedding FROM fact_embeddings WHERE fact_id = 9002").get().embedding) === false);
});

test("the stranger's words are under a key of their own, and survive a fresh process", async () => {
  assert.ok(rc.keystore().prepare("SELECT 1 FROM user_keys WHERE conversation_id = ?").get(`stranger:${strangerId}`));
  rc._resetForTests();
  await rc.init(process.env.REASON_DB_PATH);
  const row = d.db.prepare("SELECT said FROM stranger_calls WHERE id = ?").get(strangerId);
  assert.match(JSON.parse(row.said)[0], /call me back/);
});

test("forget everything re-keys phase-2 rows too: an earlier backup copy opens none of them", async () => {
  d.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const copy = join(dir, "before.db");
  copyFileSync(process.env.REASON_DB_PATH, copy);
  const oldKeyId = rc.keystore().prepare("SELECT id FROM user_keys WHERE conversation_id = ?").get(C).id;
  await ios.forgetEverything({ conversation_id: C });
  assert.equal(rc.keystore().prepare("SELECT 1 FROM user_keys WHERE id = ?").get(oldKeyId), undefined, "the old key is gone");
  const s = new DatabaseSync(copy);
  const old = s.prepare("SELECT address1 FROM shop_shipping WHERE conversation_id = ?").get(C).address1;
  s.close();
  assert.match(old, new RegExp(`^enc:u1:${oldKeyId}:`));
  assert.equal(rc.openAny(old), rc.SHREDDED, "the backup's copy reads as nothing");
  for (const st of phase2()) assert.equal(st.plain, 0, `${st.column} has plain rows after forget`);
});
