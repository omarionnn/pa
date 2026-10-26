// The one guest-list note after somebody who already has Reason joins an event (owner decision
// 2026-10-25, src/events.js afterJoin / listNoteText / sendListNote): listed by default under the
// name Reason knows, asked once about Instagram — or told the handle they shared before shows here
// too — nothing when the organizer keeps the list private, nothing at night, never twice. Their
// answer is the model's to read (event_directory / event_instagram); nothing here parses a reply.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-list-note-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_EVENTS = "owner";

const { runTool } = await import("../src/tools.js");
const events = await import("../src/events.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const AMA_C = "dm:fake:+13475550000";
const YAW_C = "dm:fake:+16465550111";
// 3pm and 11pm in New York on the Monday before the party (EDT).
const AFTERNOON = Date.parse("2026-10-26T19:00:00Z");
const NIGHT = Date.parse("2026-10-27T03:00:00Z");
const NEXT_MORNING = Date.parse("2026-10-27T13:05:00Z");
const at = (t) => { clock.reset(); clock.skip(t - Date.now()); };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  at(AFTERNOON);
  config.events = "owner";
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM conversations;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: "+13475550000", name: "Ama" });
  db.upsertAccount({ conversationId: YAW_C, channel: "fake", address: "+16465550111", name: "Yaw" });
});

/** A runtime with a per-conversation queue the test drains, the way Runtime.enqueue runs after a turn. */
function fakeRuntime() {
  const sent = [];
  const queue = [];
  return {
    sent,
    say() {},
    enqueue(_c, fn) { queue.push(fn); return Promise.resolve(); },
    async drain() { while (queue.length) await queue.shift()(); },
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
const tool = (name, input, c, rt) => runTool(name, input, { conversationId: c, messages: [], events: rt });
async function makeEvent(rt, over = {}) {
  const out = await tool("event_create", {
    name: "Halloween Party", description: "costumes", starts_at: "2026-10-31T21:00", location: "12 Elm St",
    password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true, ...over,
  }, OWNER_C, rt);
  assert.equal(out.ok, true, JSON.stringify(out));
  return db.getEventRow(out.event.event_id);
}
const notesTo = (rt, c) => rt.sent.filter(s => s.conversationId === c && /who's-going list/.test(s.text)).map(s => s.text);

test("text join, no Instagram yet: listed under the name Reason knows, then ONE note after the welcome asking once", async () => {
  const rt = fakeRuntime();
  const ev = await makeEvent(rt);
  await rt.drain();
  rt.sent.length = 0;
  const out = await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, AMA_C, rt);
  assert.equal(out.ok, true);
  assert.match(out.say, /Don't bring up the who's-going list or Instagram/);
  assert.deepEqual(rt.sent.map(s => s.conversationId), [AMA_C], "only the welcome goes inside the turn");
  await rt.drain();
  assert.equal(rt.sent.length, 2);
  assert.match(rt.sent[0].text, /you're in for Halloween Party/, "the welcome first");
  assert.equal(rt.sent[1].text, "you're on the who's-going list as Ama — if you'd like a different name, or would rather not be on it, just let me know. want your instagram on the guest list too? send your handle if so, no worries if not.");
  assert.deepEqual(events.directoryEntries(ev).map(e => [e.name, e.instagram]), [["Omari", null], ["Ama", null]], "listed by default");
  const thread = db.loadConversation(AMA_C);
  assert.equal(thread.at(-1).content, rt.sent[1].text, "in the thread as the last thing said, so the answer is read against it");
  // Never twice: the sweep, a re-join after leaving.
  assert.deepEqual(await events.sweepListNotes({ runtime: rt, now: clock.now() + 60 * 60_000 }), { sent: 0, dropped: 0, later: 0, queued: 0 });
  await tool("event_leave", { event_id: ev.id }, AMA_C, rt);
  await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, AMA_C, rt);
  await rt.drain();
  assert.equal(notesTo(rt, AMA_C).length, 1);
});

test("a handle shared in answer is kept on the profile and shown; the next event shows it and says so instead of asking", async () => {
  const rt = fakeRuntime();
  const ev = await makeEvent(rt);
  await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, AMA_C, rt);
  await rt.drain();
  const on = await tool("event_directory", { event_id: ev.id, instagram: "@ama.k" }, AMA_C, rt);
  assert.equal(on.you.instagram, "ama.k");
  assert.equal(db.getAccount(AMA_C).instagram, "ama.k");
  const ev2 = await makeEvent(rt, { name: "Friendsgiving", password: "turkey" });
  rt.sent.length = 0;
  await tool("event_join", { name: "Friendsgiving", password: "turkey" }, AMA_C, rt);
  await rt.drain();
  assert.deepEqual(notesTo(rt, AMA_C), ["you're on the who's-going list as Ama — if you'd like a different name, or would rather not be on it, just let me know. i'll show your instagram @ama.k on this guest list too; tell me anytime if you'd rather it not show."]);
  assert.equal(events.directoryEntries(ev2).find(e => e.name === "Ama").instagram, "ama.k");
});

test("guest list off: no note, the list and Instagram are never mentioned, and the organizer is not listed", async () => {
  const rt = fakeRuntime();
  const ev = await makeEvent(rt, { guest_list_visible: false });
  db.setAccountInstagram(AMA_C, "ama.k");
  const out = await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, AMA_C, rt);
  assert.match(out.say, /private; don't mention it/);
  await rt.drain();
  assert.equal(rt.sent.length, 1, "the welcome only");
  assert.ok(!/instagram|who's going|who's-going/i.test(rt.sent[0].text));
  assert.equal(db.attendeeRow(ev.id, AMA_C).list_note, null, "nothing owed, so nothing later either");
  assert.equal(db.organizerListing(ev.id), null);
  assert.deepEqual(await events.sweepListNotes({ runtime: rt, now: clock.now() + 60 * 60_000 }), { sent: 0, dropped: 0, later: 0, queued: 0 });
});

test("at night it waits: nothing after a late join, then once in the morning", async () => {
  const rt = fakeRuntime();
  await makeEvent(rt);
  await rt.drain();
  at(NIGHT);
  rt.sent.length = 0;
  await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, AMA_C, rt);
  await rt.drain();
  assert.equal(rt.sent.length, 1, "the welcome answers what they just did; the note waits");
  assert.equal((await events.sweepListNotes({ runtime: rt, now: NIGHT + 30 * 60_000 })).later, 1);
  assert.equal(rt.sent.length, 1);
  at(NEXT_MORNING);
  // Queued behind any turn of theirs, as the first send is; a second pass before it runs adds no copy.
  assert.equal((await events.sweepListNotes({ runtime: rt })).queued, 1);
  assert.equal((await events.sweepListNotes({ runtime: rt })).queued, 1);
  assert.equal(rt.sent.length, 1, "nothing sent until the queue runs it");
  await rt.drain();
  assert.deepEqual(await events.sweepListNotes({ runtime: rt }), { sent: 0, dropped: 0, later: 0, queued: 0 });
  assert.equal(notesTo(rt, AMA_C).length, 1);
});

test("hide me, hide my instagram (this list), remove my instagram (everywhere); the ask comes back on a new event after removal", async () => {
  const rt = fakeRuntime();
  const ev = await makeEvent(rt);
  const ev2 = await makeEvent(rt, { name: "Friendsgiving", password: "turkey" });
  await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, AMA_C, rt);
  await tool("event_directory", { event_id: ev.id, instagram: "ama.k" }, AMA_C, rt);
  await tool("event_join", { name: "Friendsgiving", password: "turkey" }, AMA_C, rt);
  await rt.drain();
  // Hide my Instagram on one list: gone there, kept on the profile and the other list.
  await tool("event_directory", { event_id: ev.id, event_named: "Halloween Party", remove_instagram: true }, AMA_C, rt);
  assert.equal(events.directoryEntries(ev).find(e => e.name === "Ama").instagram, null);
  assert.equal(events.directoryEntries(ev2).find(e => e.name === "Ama").instagram, "ama.k");
  assert.equal(db.getAccount(AMA_C).instagram, "ama.k");
  // Hide me: off that list.
  await tool("event_directory", { event_id: ev2.id, event_named: "Friendsgiving", in_directory: false }, AMA_C, rt);
  assert.ok(!events.directoryEntries(ev2).some(e => e.name === "Ama"));
  await tool("event_directory", { event_id: ev2.id, event_named: "Friendsgiving", in_directory: true }, AMA_C, rt);
  // Remove everywhere: profile and every list.
  const gone = await tool("event_instagram", { remove: true }, AMA_C, rt);
  assert.equal(gone.ok, true);
  assert.equal(db.getAccount(AMA_C).instagram, null);
  assert.equal(events.directoryEntries(ev2).find(e => e.name === "Ama").instagram, null);
  const ev3 = await makeEvent(rt, { name: "Game Night", password: "dice" });
  rt.sent.length = 0;
  await tool("event_join", { name: "Game Night", password: "dice" }, AMA_C, rt);
  await rt.drain();
  assert.match(notesTo(rt, AMA_C)[0], /want your instagram on the guest list too\? send your handle if so, no worries if not\./);
  assert.equal(events.directoryEntries(ev3).find(e => e.name === "Ama").instagram, null);
  assert.equal((await tool("event_instagram", { instagram: "javascript:x" }, AMA_C, rt)).ok, false, "handles are checked by shape (instagramHandle)");
});

test("organizers follow the same rules on their own list: listed under their name, one note after creating, can hide or add Instagram", async () => {
  const rt = fakeRuntime();
  db.setAccountInstagram(OWNER_C, "omari");
  const out = await tool("event_create", {
    name: "Rooftop", description: "drinks", starts_at: "2026-10-30T20:00", location: "roof", password: "skyline",
    show_time_on_join: true, show_location_on_join: true, guest_list_visible: true,
  }, OWNER_C, rt);
  assert.match(out.say, /Don't bring up the who's-going list or Instagram/);
  const ev = db.getEventRow(out.event.event_id);
  await rt.drain();
  assert.deepEqual(notesTo(rt, OWNER_C), ["you're on the who's-going list as Omari — if you'd like a different name, or would rather not be on it, just let me know. i'll show your instagram @omari on this guest list too; tell me anytime if you'd rather it not show."]);
  assert.deepEqual(events.directoryEntries(ev), [{ id: db.attendeeRow(ev.id, OWNER_C).id, name: "Omari", instagram: "omari", listed: true, organizer: true }]);
  assert.equal(events.organizerView(ev).going, 0, "never counted as a guest");
  const hid = await tool("event_directory", { event_id: ev.id, in_directory: false }, OWNER_C, rt);
  assert.equal(hid.ok, true);
  assert.equal(hid.directory_link, events.organizerPageUrl(ev), "the organizer's link is their guest-list page, which opens for them");
  assert.deepEqual(events.directoryEntries(ev), []);
});

test("page join by somebody already on Reason: the handle they typed is kept, and the note says it shows; a new account's typed handle is kept with no note", async () => {
  const rt = fakeRuntime();
  const ev = await makeEvent(rt);
  await rt.drain();
  rt.sent.length = 0;
  const out = events.admitExisting({ ev, conversationId: AMA_C, displayName: "Ama K", instagram: "ama.k", inDirectory: true, via: "web", actor: "test" });
  const att = events.afterJoin({ ev, att: out.attendee, typedInstagram: "ama.k" });
  await events.sendWelcome({ runtime: rt, ev, att });
  events.scheduleListNote({ runtime: rt, ev, att });
  await rt.drain();
  assert.equal(db.getAccount(AMA_C).instagram, "ama.k");
  assert.deepEqual(notesTo(rt, AMA_C), ["you're on the who's-going list as Ama K, with your instagram @ama.k — if you'd like a different name, or would rather not be on it, just let me know, or if you'd rather your instagram not show."]);
  // Unticked "show me" on the page: their choice, so no note about a list they're not on.
  const yaw = events.admitExisting({ ev, conversationId: YAW_C, displayName: "Yaw", inDirectory: false, via: "web", actor: "test" });
  const yatt = events.afterJoin({ ev, att: yaw.attendee });
  events.scheduleListNote({ runtime: rt, ev, att: yatt });
  await rt.drain();
  assert.equal(notesTo(rt, YAW_C).length, 0);
  assert.equal(db.attendeeRow(ev.id, YAW_C).list_note, "dropped");
  // A brand-new account from the page: the handle is kept for next time; the welcome flow is theirs, no note.
  const NEW_C = "dm:fake:+15550001234";
  db.upsertAccount({ conversationId: NEW_C, channel: "fake", address: "+15550001234", name: "Kofi" });
  const k = db.addAttendee({ eventId: ev.id, conversationId: NEW_C, displayName: "Kofi", instagram: "kofi.b", inDirectory: true, via: "web_text" });
  const katt = events.afterJoin({ ev, att: k.attendee, typedInstagram: "kofi.b", newAccount: true });
  assert.equal(db.getAccount(NEW_C).instagram, "kofi.b");
  assert.equal(katt.list_note, null);
});

test("the note is told not to come from a pattern: no code reads the reply, the tools say how the model maps it", async () => {
  const { EVENT_TOOL_DEFS } = await import("../src/eventtools.js");
  const dirTool = EVENT_TOOL_DEFS.find(t => t.name === "event_directory");
  assert.match(dirTool.description, /off the list/);
  assert.match(dirTool.description, /Instagram off this one list/);
  assert.match(dirTool.description, /decline or pass, call nothing/);
  assert.match(EVENT_TOOL_DEFS.find(t => t.name === "event_instagram").description, /remove their Instagram everywhere/);
});

test("left and back before the note went: owed afresh as things now stand; a paused event's notes wait off the queue", async () => {
  const rt = fakeRuntime();
  const ev = await makeEvent(rt);
  await rt.drain();
  at(NIGHT);
  await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, AMA_C, rt);
  assert.equal(db.attendeeRow(ev.id, AMA_C).list_note, "ask");
  await tool("event_leave", { event_id: ev.id }, AMA_C, rt);
  db.setAccountInstagram(AMA_C, "ama.k");
  await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, AMA_C, rt);
  assert.equal(db.attendeeRow(ev.id, AMA_C).list_note, "carried");
  assert.ok(db.attendeeRow(ev.id, AMA_C).list_note_at > clock.now(), "due again from now, not the old time");
  db.updateEventRow(ev.id, { status: "paused" });
  assert.deepEqual(db.owedListNotes(NEXT_MORNING), []);
  db.updateEventRow(ev.id, { status: "active" });
  at(NEXT_MORNING);
  await events.sweepListNotes({ runtime: rt });
  await rt.drain();
  assert.match(notesTo(rt, AMA_C).at(-1), /i'll show your instagram @ama\.k on this guest list too/);
});

test("the page's show-me box starts ticked (listed by default, visible on the form), and an untick survives a re-render", async () => {
  const { renderJoin } = await import("../src/pages/event.js");
  const ev = await makeEvent(fakeRuntime());
  const box = (html) => /name="in_directory" value="1" checked/.test(html);
  assert.equal(box(renderJoin({ ev, account: db.getAccount(AMA_C) })), true);
  assert.equal(box(renderJoin({ ev })), true, "a stranger may be somebody already on Reason on a new browser: the claim text then finds their account");
  assert.equal(box(renderJoin({ ev, account: db.getAccount(AMA_C), values: { in_directory: false } })), false, "their own untick survives a re-render");
});

test("the note never hands them a phrase to type: plain intent only, in every case (owner copy rule 2026-10-25)", () => {
  const ev = { guest_list_visible: 1 };
  const row = (over) => ({ state: "joined", in_directory: 1, display_name: "Ama", instagram: null, ...over });
  const all = [events.listNoteText(ev, row(), "ask"), events.listNoteText(ev, row({ instagram: "ama.k" }), "carried"),
    events.listNoteText(ev, row({ instagram: "ama.k" }), "shown"), events.listNoteText(ev, row({ display_name: "" }), "ask")];
  for (const t of all) {
    assert.ok(t);
    assert.ok(!/\b(say|text|reply|type)\b\s+["“']?(hide|skip|stop|remove|yes|no)\b/i.test(t), t);
    assert.ok(!/["“”]/.test(t), `no quoted phrase: ${t}`);
    assert.ok(!/, or skip\b/.test(t), t);
  }
  assert.equal(events.listNoteText({ guest_list_visible: 0 }, row({ instagram: "ama.k" }), "carried"), null);
});
