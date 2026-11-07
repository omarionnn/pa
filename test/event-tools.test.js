// The event tools (src/eventtools.js) through runTool, the way a turn calls them: making an event
// only once every setup answer is in, the owner told about finished creations only, who is shown
// which tool under each REASON_EVENTS setting, and every organizer action — updates that tell guests
// only what they can see, releases, blasts, rotation, removal, cancellation — refused to anybody
// but the organizer exactly as a made-up event is.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { withYes } from "./fixture-yes.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-tools-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_EVENTS = "on";

const { runTool, toolsFor } = await import("../src/tools.js");
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
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: "+14155559876", name: "Kofi" });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: "+13475550000", name: "Ama" });
  db.upsertAccount({ conversationId: YAW_C, channel: "fake", address: "+16465550111", name: "Yaw" });
});

/** Says and sends the way the runtime does, with the outbox's one-row-per-key rule. */
function fakeRuntime() {
  const said = [];
  const sent = [];
  return {
    said, sent,
    say(conversationId, text) { said.push({ conversationId, text }); return text; },
    async _tell(conversationId, text, { idempotencyKey }) {
      const have = db.db.prepare("SELECT * FROM outbox WHERE idem_key = ?").get(idempotencyKey);
      if (have) return { ok: true, outbox_id: have.id, duplicate: true };
      sent.push({ conversationId, text });
      const now = clock.now();
      const id = db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, created_at, updated_at)
        VALUES (?, ?, 'fake', 'x', ?, 'sent', ?, ?)`).run(idempotencyKey, conversationId, text, now, now).lastInsertRowid;
      return { ok: true, outbox_id: Number(id) };
    },
  };
}
const tool = (name, input, c, rt = fakeRuntime()) => runTool(name, input, { conversationId: c, messages: [], events: rt });
// A blast the organizer said yes to (audit lead 28: every blast needs one).
const blastYes = (input, c, rt = fakeRuntime()) => withYes(runTool, "event_blast", input, { conversationId: c, messages: [], events: rt });
const answers = (over = {}) => ({
  name: "Halloween Party", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St, Apt 4",
  welcome_message: "so glad you're coming!", password: "pumpkin", show_time_on_join: true, show_location_on_join: false,
  guest_list_visible: true, ...over,
});
async function made(c = KOFI_C, over = {}, rt = fakeRuntime()) {
  const out = await tool("event_create", answers(over), c, rt);
  assert.equal(out.ok, true, JSON.stringify(out));
  return { ev: db.getEventRow(out.event.event_id), out, rt };
}
const joinAs = async (c, name = "Halloween Party", password = "pumpkin") => {
  const r = await events.joinExisting({ conversationId: c, name, password });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.attendee;
};

test("creation: missing answers make nothing; the finished event hands back name, password and link; the owner is told", async () => {
  const rt = fakeRuntime();
  const half = await tool("event_create", { name: "Halloween Party", password: "pumpkin" }, KOFI_C, rt);
  assert.equal(half.ok, false);
  assert.ok(half.missing.includes("show_location_on_join") && half.missing.includes("show_time_on_join"), JSON.stringify(half));
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0, "an abandoned setup leaves no row");
  assert.equal(rt.sent.length, 0, "and the owner hears nothing about it");

  const { ev, out } = await made(KOFI_C, {}, rt);
  assert.equal(out.share.name, "Halloween Party");
  assert.equal(out.share.password, "pumpkin");
  assert.equal(out.share.link, `https://files.example.test/e/${ev.public_id}`);
  assert.equal(out.event.time_shown_to_guests, true);
  assert.equal(out.event.location_shown_to_guests, false);
  // News, not an emergency: one line in the owner's daily digest, nothing in his chat now (2026-11-06).
  assert.equal(rt.sent.filter(s => s.conversationId === OWNER_C).length, 0);
  const toOwner = (await import("../src/opsdigest.js")).pending().filter(r => r.key === `event-created:${ev.id}`);
  assert.equal(toOwner.length, 1);
  // Never who or what (owner, 2026-11-06): that an event was made, and the status page.
  assert.match(toOwner[0].text, /A new event was made on Reason/);
  assert.doesNotMatch(toOwner[0].text, /Halloween|Kofi|4155559876/);
  assert.ok(!toOwner[0].text.includes(ev.organizer_token), "never the organizer's own key");
  assert.ok(!/pumpkin/.test(toOwner[0].text), "never the password");
  assert.ok(!/pumpkin/.test(JSON.stringify(sealTravelers("event_create", { input: answers(), out }))), "sealed in every log line");
});

test("the owner making his own event is not texted about it", async () => {
  const rt = fakeRuntime();
  await made(OWNER_C, {}, rt);
  assert.equal(rt.sent.length, 0);
});

test("who is shown which tool: off nobody; owner = only the owner creates, anybody may be a guest; on = everybody creates", async () => {
  const names = (c) => toolsFor(c).map(t => t.name).filter(n => n.startsWith("event_"));
  config.events = false;
  assert.deepEqual(names(OWNER_C), []);
  assert.equal((await tool("event_list", {}, KOFI_C)).blocked, "not_available");
  config.events = "owner";
  assert.ok(names(OWNER_C).includes("event_create"));
  assert.ok(!names(KOFI_C).includes("event_create"));
  assert.ok(names(KOFI_C).includes("event_list"));
  assert.ok(!names(KOFI_C).includes("event_blast"), "no organizer tools for somebody who organizes nothing");
  assert.equal((await tool("event_create", answers(), KOFI_C)).blocked, "not_available", "and the dispatch refuses it too");
  config.events = true;
  assert.ok(names(KOFI_C).includes("event_create"));
});

test("isolation: every organizer tool answers a stranger exactly like a made-up id, tells a guest they're a guest there, and changes nothing", async () => {
  const { ev } = await made();
  await joinAs(AMA_C);
  const before = JSON.stringify([db.getEventRow(ev.id), db.attendeesOf(ev.id, { state: null })]);
  const calls = [
    ["event_guests", {}], ["event_update", { location: "elsewhere" }], ["event_release", { detail: "location" }],
    ["event_blast", { message: "hi" }], ["event_password_rotate", { new_password: "mine!" }],
    ["event_guest_remove", { guest_id: 1 }], ["event_cancel", {}],
  ];
  for (const c of [AMA_C, YAW_C]) {
    for (const [name, extra] of calls) {
      const out = await tool(name, { event_id: ev.id, ...extra }, c);
      const fake = await tool(name, { event_id: 99999, ...extra }, c);
      assert.equal(out.ok, false, `${c} ${name}`);
      if (c === AMA_C) assert.equal(out.reason, "guest_there", `${name}: a guest is told they're a guest there (spec v3 §11)`);
      else assert.equal(out.error.replace(String(ev.id), "N"), fake.error.replace("99999", "N"), `${name}: somebody else's event reads exactly like no event`);
      assert.ok(!/Elm|pumpkin|Ama/.test(JSON.stringify(out)), `${name} leaks nothing`);
    }
  }
  assert.equal(JSON.stringify([db.getEventRow(ev.id), db.attendeesOf(ev.id, { state: null })]), before, "nothing changed");
});

test("a time change tells guests when the time is out; a change to a hidden location is saved quietly", async () => {
  const { ev } = await made();
  await joinAs(AMA_C); await joinAs(YAW_C);
  const rt = fakeRuntime();
  const out = await tool("event_update", { event_id: ev.id, starts_at: "2026-10-31T22:30", location: "40 Oak Ave" }, KOFI_C, rt);
  assert.equal(out.ok, true);
  assert.deepEqual(out.saved_quietly, ["location"]);
  assert.equal(rt.sent.length, 2, "both guests told");
  for (const s of rt.sent) {
    assert.match(s.text, /new time: Sat, Oct 31.*10:30/);
    assert.ok(!/Oak|Elm/.test(s.text), "the hidden address is not in the update");
  }
  assert.equal(events.deliveryReport(ev)[0].sent, 2);
});

test("release: one detail at a time, every guest texted it, once", async () => {
  const { ev } = await made(KOFI_C, { show_time_on_join: false });
  await joinAs(AMA_C);
  const rt = fakeRuntime();
  const loc = await tool("event_release", { event_id: ev.id, detail: "location" }, KOFI_C, rt);
  assert.equal(loc.ok, true);
  assert.match(rt.sent[0].text, /where: 12 Elm St/);
  assert.ok(!/when:/.test(rt.sent[0].text), "the time stays hidden");
  assert.equal((await tool("event_release", { event_id: ev.id, detail: "location" }, KOFI_C, rt)).already, true);
  assert.equal(rt.sent.length, 1, "releasing twice texts once");
  assert.equal(events.guestView(db.getEventRow(ev.id), db.attendeeRow(ev.id, AMA_C)).where, "12 Elm St, Apt 4");
  assert.equal(events.guestView(db.getEventRow(ev.id), db.attendeeRow(ev.id, AMA_C)).when, null);
});

test("blast: to every unmuted guest, tracked; refused while paused", async () => {
  const { ev } = await made();
  await joinAs(AMA_C); const y = await joinAs(YAW_C);
  db.updateAttendeeRow(y.id, { muted: 1 });
  const rt = fakeRuntime();
  const out = await blastYes({ event_id: ev.id, message: "bring snacks" }, KOFI_C, rt);
  assert.equal(out.sent.guests, 1);
  assert.equal(out.sent.skipped_muted, 1);
  assert.match(rt.sent[0].text, /^Halloween Party — from Kofi:\nbring snacks$/);
  db.updateEventRow(ev.id, { status: "paused" });
  const held = await tool("event_blast", { event_id: ev.id, message: "again" }, KOFI_C, rt);
  assert.equal(held.ok, false);
  assert.match(held.error, /paused/);
  assert.equal(rt.sent.length, 1);
});

test("rotation: joined guests stay, the old password stops working, the new one works", async () => {
  const { ev } = await made();
  await joinAs(AMA_C);
  const out = await tool("event_password_rotate", { event_id: ev.id, new_password: "ghosts" }, KOFI_C);
  assert.equal(out.share.password, "ghosts");
  assert.equal(db.attendeeRow(ev.id, AMA_C).state, "joined");
  assert.equal((await events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: "pumpkin" })).reason, "no_match");
  assert.equal((await events.joinExisting({ conversationId: YAW_C, name: "Halloween Party", password: "ghosts" })).ok, true);
  assert.ok(!JSON.stringify(db.getEventRow(ev.id)).includes("ghosts"));
});

test("removal: the guest is told, loses the directory token, cannot rejoin; their account is untouched", async () => {
  const { ev } = await made();
  const a = await joinAs(AMA_C);
  const rt = fakeRuntime();
  const acct = JSON.stringify(db.getAccount(AMA_C));
  const out = await tool("event_guest_remove", { event_id: ev.id, guest_id: a.id }, KOFI_C, rt);
  assert.equal(out.ok, true);
  assert.equal(rt.sent[0].conversationId, AMA_C);
  assert.match(rt.sent[0].text, /no longer on the guest list/);
  assert.equal(db.attendeeByToken(a.token).state, "removed");
  assert.equal(events.viewFor(AMA_C, ev.id), null);
  assert.equal((await events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" })).reason, "removed");
  assert.equal(JSON.stringify(db.getAccount(AMA_C)), acct);
});

test("cancellation: everyone told, muted guests too; nothing about it changes afterwards", async () => {
  const { ev } = await made();
  await joinAs(AMA_C); const y = await joinAs(YAW_C);
  db.updateAttendeeRow(y.id, { muted: 1 });
  const rt = fakeRuntime();
  const out = await tool("event_cancel", { event_id: ev.id, message: "sorry all" }, KOFI_C, rt);
  assert.equal(out.sent.guests, 2);
  assert.ok(rt.sent.every(s => /Halloween Party is cancelled\.\nsorry all/.test(s.text)));
  assert.equal(db.getEventRow(ev.id).status, "cancelled");
  assert.match((await tool("event_blast", { event_id: ev.id, message: "x" }, KOFI_C, rt)).error, /cancelled/);
});

test("event_list: the organizer's view of their own, a guest's view of joined ones, nothing hidden leaking", async () => {
  const { ev } = await made(KOFI_C, { show_time_on_join: false });
  await joinAs(AMA_C);
  const kofi = await tool("event_list", {}, KOFI_C);
  assert.equal(kofi.organizing[0].where, "12 Elm St, Apt 4");
  const ama = await tool("event_list", {}, AMA_C);
  assert.equal(ama.going_to[0].event_id, ev.id);
  assert.ok(!/Elm|9:00 PM|Oct 31/.test(JSON.stringify(ama)), JSON.stringify(ama));
  assert.deepEqual(await tool("event_list", {}, YAW_C), { ok: true, organizing: [], going_to: [] });
});

test("the owner's creation line is held once for the digest and marked told when it is", async () => {
  const digest = await import("../src/opsdigest.js");
  const rt = fakeRuntime();
  const { ev } = await made(KOFI_C, {}, rt);
  assert.ok(db.getEventRow(ev.id).owner_told_at);
  assert.equal(digest.pending().filter(r => r.key === `event-created:${ev.id}`).length, 1);
  assert.equal(rt.sent.filter(s => s.conversationId === OWNER_C).length, 0, "nothing live");
});

test("while the operator has an event paused, updates and removals are held — then sent on resume to whoever is still owed them", async () => {
  const { ev } = await made();
  await joinAs(AMA_C); const y = await joinAs(YAW_C);
  db.updateEventRow(ev.id, { status: "paused" });
  const rt = fakeRuntime();
  const up = await tool("event_update", { event_id: ev.id, starts_at: "2026-10-31T22:00" }, KOFI_C, rt);
  assert.equal(up.sent.held, 2);
  assert.match(up.paused, /resumed/);
  await tool("event_guest_remove", { event_id: ev.id, guest_id: y.id }, KOFI_C, rt);
  assert.equal(rt.sent.length, 0, "nothing went out while paused");
  const report = events.deliveryReport(db.getEventRow(ev.id));
  assert.equal(report.reduce((n, m) => n + m.held, 0), 3);
  const resumed = db.updateEventRow(ev.id, { status: "active" });
  const out = await events.releaseHeld({ runtime: rt, ev: resumed });
  assert.equal(out.sent, 2, "Ama's update and Yaw's removal line");
  assert.equal(out.dropped, 1, "the update to Yaw, removed since, is not sent");
  assert.deepEqual(rt.sent.map(s => s.conversationId).sort(), [AMA_C, YAW_C].sort());
  assert.match(rt.sent.find(s => s.conversationId === YAW_C).text, /no longer on the guest list/);
});

test("cancelling a paused event still tells guests, as the bare fact", async () => {
  const { ev } = await made();
  await joinAs(AMA_C);
  db.updateEventRow(ev.id, { status: "paused" });
  const rt = fakeRuntime();
  await tool("event_cancel", { event_id: ev.id, message: "anything the organizer wants" }, KOFI_C, rt);
  assert.deepEqual(rt.sent.map(s => s.text), ["Halloween Party is cancelled."]);
});

test("a zone on its own keeps the wall-clock time and moves the moment; an unknown zone is refused", async () => {
  const { ev } = await made(KOFI_C, { starts_at: "2026-10-31T20:00", timezone: "America/Los_Angeles" });
  await joinAs(AMA_C);
  const rt = fakeRuntime();
  const out = await tool("event_update", { event_id: ev.id, timezone: "America/New_York" }, KOFI_C, rt);
  assert.equal(out.event.starts_at_local, "2026-10-31T20:00");
  assert.equal(out.event.timezone, "America/New_York");
  assert.match(rt.sent[0].text, /8:00\s?PM EDT/);
  assert.equal((await tool("event_update", { event_id: ev.id, timezone: "Mars/Olympus" }, KOFI_C)).ok, false);
});

test("a password typed into a setup that never finished is scrubbed too", async () => {
  db.saveConversation(KOFI_C, [{ role: "user", content: "party password: batcave" }]);
  const out = await tool("event_create", { name: "Halloween Party", password: "batcave" }, KOFI_C);
  assert.equal(out.ok, false);
  assert.ok(!/batcave/.test(JSON.stringify(db.loadConversation(KOFI_C))));
});

test("event_list and event_guests read only your own rows, so they still answer under a non-clear screen; changing tools are held", async () => {
  const { ev } = await made();
  const harm = { verdict: "borderline" };
  const list = await runTool("event_list", {}, { conversationId: KOFI_C, messages: [], harm });
  assert.equal(list.ok, true);
  const blast = await runTool("event_blast", { event_id: ev.id, message: "x" }, { conversationId: KOFI_C, messages: [], harm });
  assert.equal(blast.blocked, "harm_screen");
});
