// Events, the data and the rules around it (src/events.js, src/db.js): passwords only ever as a
// scrypt hash, names matched loosely and links by their random id, the attempt limit, capacity, and
// above all isolation — an event is the first thing shared between people, so who may read or
// manage what is enforced in code and pinned here, path by path.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-events-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_EVENTS = "on";

const events = await import("../src/events.js");
const db = await import("../src/db.js");
const { sealTravelers } = await import("../src/privacy.js");
const { clock, config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const KOFI_C = "dm:fake:+14155559876";
const AMA_C = "dm:fake:+13475550000";
const YAW_C = "dm:fake:+16465550111";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM threads;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: "+14155559876", name: "Kofi" });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: "+13475550000", name: "Ama" });
  db.upsertAccount({ conversationId: YAW_C, channel: "fake", address: "+16465550111", name: "Yaw" });
});

const answers = (over = {}) => ({
  name: "Halloween Party", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St, Apt 4",
  welcome_message: "so glad you're coming!", password: "pumpkin", show_time_on_join: true, show_location_on_join: false,
  guest_list_visible: true, ...over,
});
const make = (c = KOFI_C, over = {}) => {
  const out = events.create(c, answers(over));
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.event;
};

// ---------- passwords ----------

test("the password is stored as a scrypt hash only; case and spacing do not count", () => {
  const ev = make();
  const raw = JSON.stringify(db.db.prepare("SELECT * FROM events").all());
  assert.ok(!/pumpkin/i.test(raw), "no plaintext anywhere in the row");
  assert.match(ev.password_hash, /^scrypt\$16384\$8\$1\$/);
  assert.ok(events.checkPassword("  Pumpkin ", ev.password_hash));
  assert.ok(!events.checkPassword("pumpkins", ev.password_hash));
  assert.notEqual(events.hashPassword("pumpkin"), events.hashPassword("pumpkin"), "salted");
});

test("a password is sealed out of every tool log that could carry one", () => {
  for (const tool of ["event_create", "event_join", "event_password_rotate"]) {
    const sealed = JSON.stringify(sealTravelers(tool, { name: "x", password: "pumpkin", new_password: "ghost" }));
    assert.ok(!/pumpkin|ghost/.test(sealed), `${tool}: ${sealed}`);
  }
  assert.equal(sealTravelers("recall", { password: "x" }).password, "x", "other tools untouched");
});

// ---------- creating ----------

test("creation needs every setup answer, and an abandoned setup leaves no row", () => {
  const out = events.create(KOFI_C, { name: "Halloween Party", password: "pumpkin" });
  assert.equal(out.ok, false);
  assert.deepEqual(out.missing.sort(), ["description", "guest_list_visible", "location", "show_location_on_join", "show_time_on_join", "starts_at"].sort());
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  assert.equal(events.create(KOFI_C, answers({ password: "abc" })).problem, "password_too_short");
  assert.equal(events.create(KOFI_C, answers({ starts_at: "next friday" })).problem, "bad_time");
  assert.equal(events.create(KOFI_C, answers({ capacity: 0 })).problem, "bad_capacity");
});

test("the time is the organizer's wall clock in their zone; the link carries a random id, never the name", () => {
  const ev = make();
  assert.equal(new Date(ev.starts_at).toISOString(), "2026-11-01T01:00:00.000Z", "9pm EDT on Oct 31");
  assert.match(events.whenLine(ev), /Sat, Oct 31.*9:00\s?PM EDT/);
  assert.match(ev.public_id, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(!events.eventUrl(ev).toLowerCase().includes("halloween"));
  assert.equal(events.publicIdFromLink(`look ${events.eventUrl(ev)} !`), ev.public_id);
  assert.equal(events.publicIdFromLink(`${events.eventUrl(ev)}/who?t=abc`), ev.public_id);
  const other = make(AMA_C);
  assert.notEqual(other.public_id, ev.public_id, "two Halloween Parties, two links");
});

test("REASON_EVENTS: off makes nothing; owner lets only the owner make one but anybody join; on is everybody", () => {
  config.events = false;
  assert.equal(events.create(KOFI_C, answers()).problem, "not_available");
  assert.equal(events.joinExisting({ conversationId: AMA_C, name: "x", password: "pumpkin" }).reason, "not_available");
  config.events = "owner";
  assert.equal(events.create(KOFI_C, answers()).problem, "not_available");
  const ev = make(OWNER_C);
  const joined = events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" });
  assert.equal(joined.ok, true, "a guest joins the owner's event with the flag at owner");
  assert.equal(joined.event.id, ev.id);
  config.events = true;
  assert.equal(events.create(KOFI_C, answers()).ok, true);
});

// ---------- joining ----------

test("join by name: right password in, wrong password out, the account kept as it was", () => {
  const ev = make();
  const before = JSON.stringify(db.getAccount(AMA_C));
  assert.equal(events.joinExisting({ conversationId: AMA_C, name: "halloween party", password: "nope" }).reason, "wrong_password");
  const ok = events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "Pumpkin" });
  assert.equal(ok.ok, true);
  assert.equal(ok.attendee.display_name, "Ama", "their Reason name by default");
  assert.equal(ok.attendee.via, "text");
  assert.equal(ok.attendee.new_account, 0);
  assert.equal(JSON.stringify(db.getAccount(AMA_C)), before, "the account is untouched");
  assert.equal(events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" }).already, true, "joining twice is once");
  assert.equal(events.joinExisting({ conversationId: YAW_C, name: "no such thing", password: "pumpkin" }).reason, "no_event");
  assert.equal(events.joinExisting({ conversationId: KOFI_C, name: "Halloween Party", password: "pumpkin" }).reason, "organizer");
  assert.equal(db.joinedCount(ev.id), 1);
});

test("two events with one name: the password picks; the same password on both asks who is organizing", () => {
  const kofis = make(KOFI_C, { password: "pumpkin" });
  const amas = make(AMA_C, { password: "ghosts" });
  assert.equal(events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: "ghosts" }).event.id, amas.id);
  const omaris = make(OWNER_C, { password: "pumpkin" });
  const amb = events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: "pumpkin" });
  assert.equal(amb.reason, "ambiguous");
  assert.deepEqual(amb.organizers.sort(), ["Kofi", "Omari"]);
  const picked = events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: "pumpkin", organizer: "kofi" });
  assert.equal(picked.event.id, kofis.id);
  assert.ok(omaris);
});

test("join by pasted link: the link names the event, the password still has to be right", () => {
  const ev = make();
  make(AMA_C, { password: "pumpkin" }); // same name, same password — the link settles it
  const link = events.eventUrl(ev);
  assert.equal(events.joinExisting({ conversationId: YAW_C, link, password: "wrong" }).reason, "wrong_password");
  assert.equal(events.joinExisting({ conversationId: YAW_C, link: "https://files.example.test/e/AAAAAAAAAAAAAAAA", password: "pumpkin" }).reason, "bad_link");
  const ok = events.joinExisting({ conversationId: YAW_C, link, password: "pumpkin" });
  assert.equal(ok.ok, true);
  assert.equal(ok.event.id, ev.id);
  assert.equal(ok.attendee.via, "link");
});

test("password attempts: a few free, then a doubling wait, then a ceiling per day; a right one does not reset the count", () => {
  make();
  const tryIt = (pw) => events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: pw });
  for (let i = 0; i < 3; i++) assert.equal(tryIt("x" + i + "xx").reason, "wrong_password");
  const locked = tryIt("pumpkin");
  assert.equal(locked.reason, "rate_limited", "even the right password waits out the backoff");
  assert.ok(locked.retry_after_s >= 29 && locked.retry_after_s <= 30, String(locked.retry_after_s));
  clock.skip(31_000);
  assert.equal(tryIt("wrong4").reason, "wrong_password");
  assert.ok(tryIt("pumpkin").retry_after_s > 30, "the wait doubled");
  // A different person is not held up by Yaw's guessing.
  assert.equal(events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" }).ok, true);
  // The ceiling.
  for (let i = 0; i < 30; i++) { clock.skip(61 * 60_000); tryIt("bad" + i + "x"); }
  const capped = events.attemptGate(`conv:${YAW_C}`);
  assert.equal(capped.ok, false);
  assert.ok(db.db.prepare("SELECT COUNT(*) AS n FROM event_join_attempts WHERE ok = 0").get().n >= 20);
  assert.ok(!JSON.stringify(db.db.prepare("SELECT * FROM event_join_attempts").all()).includes("bad1x"), "attempts never hold the password tried");
});

test("capacity: the last place goes to one person", () => {
  const ev = make(KOFI_C, { capacity: 1 });
  assert.equal(events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" }).ok, true);
  assert.equal(events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: "pumpkin" }).reason, "full");
  db.updateAttendeeRow(db.attendeeRow(ev.id, AMA_C).id, { state: "left", left_at: clock.now() });
  assert.equal(events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: "pumpkin" }).ok, true, "a place freed by leaving is free");
});

test("paused and cancelled events take nobody; a removed guest cannot rejoin, a guest who left can", () => {
  const ev = make();
  db.updateEventRow(ev.id, { status: "paused" });
  assert.equal(events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" }).reason, "paused");
  db.updateEventRow(ev.id, { status: "active" });
  const a = events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" }).attendee;
  db.updateAttendeeRow(a.id, { state: "removed" });
  assert.equal(events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" }).reason, "removed");
  const y = events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: "pumpkin" }).attendee;
  db.updateAttendeeRow(y.id, { state: "left" });
  const back = events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: "pumpkin" });
  assert.equal(back.ok, true);
  assert.notEqual(back.attendee.token, y.token, "a fresh directory token on the way back in");
  db.updateEventRow(ev.id, { status: "cancelled" });
  assert.equal(events.joinExisting({ conversationId: "dm:fake:+15550001111", name: "Halloween Party", password: "pumpkin", displayName: "Zed" }).reason, "no_event", "a cancelled event is not found by name");
});

// ---------- isolation ----------

test("isolation: only the organizer manages; only joined guests read; nobody else learns an event exists", () => {
  const ev = make(KOFI_C);
  assert.ok(events.managed(KOFI_C, ev.id));
  for (const c of [AMA_C, YAW_C, OWNER_C]) assert.equal(events.managed(c, ev.id), null, `${c} cannot manage Kofi's event`);
  assert.equal(events.managed(AMA_C, 99999), null, "a made-up id answers the same as somebody else's");
  assert.equal(events.viewFor(YAW_C, ev.id), null, "not joined: no view at all");
  events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" });
  assert.equal(events.viewFor(AMA_C, ev.id).role, "guest");
  assert.equal(events.managed(AMA_C, ev.id), null, "a guest still cannot manage it");
  assert.deepEqual(events.listFor(YAW_C), { organizing: [], going_to: [] });
  assert.equal(events.listFor(AMA_C).going_to.length, 1);
  assert.equal(events.listFor(AMA_C).organizing.length, 0);
});

test("a guest never sees an unreleased detail, in any view they can reach", () => {
  const ev = make(KOFI_C, { show_time_on_join: false, show_location_on_join: false });
  const att = events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" }).attendee;
  const shapes = [events.viewFor(AMA_C, ev.id), events.listFor(AMA_C), events.guestView(ev, att), events.publicView(ev), events.welcomeText(ev, att)];
  for (const s of shapes) {
    const text = JSON.stringify(s);
    assert.ok(!/Elm St/.test(text), `no address: ${text}`);
    assert.ok(!/9:00|21:00|T01:00|Oct 31/.test(text), `no time: ${text}`);
    assert.ok(!/pumpkin|scrypt/.test(text), "never the password or its hash");
  }
  const pub = events.publicView(ev);
  assert.deepEqual(Object.keys(pub).sort(), ["description", "link", "name", "status"]);
  // Released: now they see it.
  const out = db.updateEventRow(ev.id, { location_released: 1 });
  assert.match(JSON.stringify(events.guestView(out, att)), /Elm St/);
  assert.ok(!/9:00/.test(JSON.stringify(events.guestView(out, att))), "each detail separately");
});

test("the organizer's guest list and the directory never carry a phone number; the directory shows only who opted in", () => {
  const ev = make();
  events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin", inDirectory: true, instagram: "@ama.k" });
  events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: "pumpkin" });
  const all = JSON.stringify([events.guestList(ev), events.directoryEntries(ev), events.directoryEntries(ev, { organizer: true })]);
  assert.ok(!/\+1|3475550000|6465550111|dm:fake/.test(all), all);
  assert.deepEqual(events.directoryEntries(ev).map(e => e.name), ["Ama"]);
  assert.equal(events.directoryEntries(ev)[0].instagram, "ama.k");
  assert.deepEqual(events.directoryEntries(ev, { organizer: true }).map(e => e.name).sort(), ["Ama", "Yaw"]);
});

test("guest-typed text is untrusted: display names are cleaned, Instagram is a handle or nothing", () => {
  assert.equal(events.cleanDisplayName("  <b>Ama</b>\n\nK  "), "bAma/bK");
  assert.equal(events.instagramHandle("https://instagram.com/ama.k?igsh=1"), "ama.k");
  assert.equal(events.instagramHandle("@ama_k"), "ama_k");
  assert.equal(events.instagramHandle("javascript:alert(1)"), null);
  assert.equal(events.instagramHandle("a..b"), null);
});

// ---------- web claims ----------

test("a web claim joins once, makes the account through an event (no invite spent), and dies on a password rotation", () => {
  const ev = make();
  const allowanceBefore = db.inviteAllowance(KOFI_C);
  const claim = events.makeClaim({ ev, displayName: "Esi", inDirectory: true });
  assert.match(claim.code, /^[2-9A-HJKMNP-Z]{8}$/);
  const r = db.redeemEventClaim({ code: claim.code, channel: "fake", address: "+15550002222" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.newAccount, true);
  assert.equal(r.account.joined_via_event, ev.id);
  assert.equal(r.account.invited_by, null);
  assert.equal(r.attendee.via, "web_text");
  assert.equal(db.inviteAllowance(KOFI_C), allowanceBefore, "nobody's invites spent");
  assert.equal(db.redeemEventClaim({ code: claim.code, channel: "fake", address: "+15550003333" }).reason, "used", "single use");
  const stale = events.makeClaim({ ev, displayName: "Kwame" });
  db.updateEventRow(ev.id, { password_hash: events.hashPassword("ghost"), password_version: ev.password_version + 1 });
  assert.equal(db.redeemEventClaim({ code: stale.code, channel: "fake", address: "+15550004444" }).reason, "password_changed");
  assert.equal(db.getAccount("dm:fake:+15550004444"), null, "nothing made on a failed claim");
});

test("a web claim sent by somebody who already has Reason keeps their account and makes no new one", () => {
  const ev = make();
  const claim = events.makeClaim({ ev, displayName: "Ama K" });
  const before = db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
  const r = db.redeemEventClaim({ code: claim.code, channel: "fake", address: "+13475550000", existingConversationId: AMA_C });
  assert.equal(r.ok, true);
  assert.equal(r.newAccount, false);
  assert.equal(r.account.conversation_id, AMA_C);
  assert.equal(r.account.name, "Ama", "their Reason name is not replaced by the event's display name");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, before);
  assert.equal(db.redeemEventClaim({ code: events.makeClaim({ ev, displayName: "K" }).code, channel: "fake", address: "+14155559876", existingConversationId: KOFI_C }).reason, "organizer");
});

test("an expired claim does nothing", () => {
  const ev = make();
  const claim = events.makeClaim({ ev, displayName: "Esi" });
  clock.skip(events.CLAIM_TTL_MS + 1);
  assert.equal(db.redeemEventClaim({ code: claim.code, channel: "fake", address: "+15550002222" }).reason, "expired");
});

// ---------- deliveries ----------

function fakeRuntime({ fail = new Set() } = {}) {
  const sent = [];
  return {
    sent,
    async _tell(conversationId, text, { idempotencyKey }) {
      // What the outbox does: one row per key, and a row that exists is not sent again.
      const have = db.db.prepare("SELECT * FROM outbox WHERE idem_key = ?").get(idempotencyKey);
      if (have) return { ok: have.state === "sent", outbox_id: have.id, duplicate: true };
      const state = fail.has(conversationId) ? "failed" : "sent";
      if (state === "sent") sent.push({ conversationId, text });
      const now = clock.now();
      const id = db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, created_at, updated_at)
        VALUES (?, ?, 'fake', 'x', ?, ?, ?, ?)`).run(idempotencyKey, conversationId, text, state, now, now).lastInsertRowid;
      return state === "sent" ? { ok: true, outbox_id: Number(id) } : { ok: false, outbox_id: Number(id), error: "nope" };
    },
  };
}

test("a blast reaches every guest once, tracks each delivery, skips the muted, and a retry never duplicates", async () => {
  const ev = make();
  events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" });
  const y = events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: "pumpkin" }).attendee;
  events.joinExisting({ conversationId: OWNER_C, name: "Halloween Party", password: "pumpkin" });
  db.updateAttendeeRow(db.attendeeRow(ev.id, OWNER_C).id, { muted: 1 });
  const rt = fakeRuntime({ fail: new Set([YAW_C]) });
  const out = await events.broadcast({ runtime: rt, ev, kind: "blast", body: "bring snacks" });
  assert.equal(out.guests, 2, "muted guest skipped");
  assert.equal(out.sent, 1);
  assert.equal(out.failed, 1);
  const report = events.deliveryReport(ev);
  assert.equal(report[0].failed, 1);
  // Delivering the same message again sends nothing new.
  await events.deliver({ runtime: rt, message: db.eventMessage(out.message_id), conversationId: AMA_C });
  assert.equal(rt.sent.filter(s => s.conversationId === AMA_C).length, 1);
  // Retry the failed one: now it works, once. A second retry finds nothing failed.
  rt.sent.length = 0;
  const failedId = report[0].failed_ids[0];
  const ok = new Set();
  const rt2 = fakeRuntime({ fail: ok });
  const r1 = await events.retryDelivery({ runtime: rt2, deliveryId: failedId });
  assert.equal(r1.ok, true);
  assert.equal(r1.state, "sent");
  const r2 = await events.retryDelivery({ runtime: rt2, deliveryId: failedId });
  assert.equal(r2.reason, "not_failed");
  assert.equal(rt2.sent.length, 1, "exactly one copy reached Yaw");
  assert.equal(events.deliveryReport(ev)[0].sent, 2);
  // The cancellation reaches the muted too.
  const c = await events.broadcast({ runtime: rt2, ev, kind: "cancel", body: "cancelled" });
  assert.equal(c.guests, 3);
  assert.ok(y);
});

test("two retries pressed at once move one delivery one step", async () => {
  const ev = make();
  events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" });
  const out = await events.broadcast({ runtime: fakeRuntime({ fail: new Set([AMA_C]) }), ev, kind: "blast", body: "hi" });
  const id = events.deliveryReport(ev)[0].failed_ids[0];
  const d = db.deliveryById(id);
  assert.ok(db.bumpDeliveryAttempt(id, d.attempt));
  assert.equal(db.bumpDeliveryAttempt(id, d.attempt), null, "the second press finds it already moved");
  assert.ok(out);
});
