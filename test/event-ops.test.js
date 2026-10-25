// Events on the owner's status page (src/events.js opsSummary/pause/resume, src/pages/ops.js,
// src/http.js opsRequest): creations, joins and wrong passwords; per message whether it actually
// reached guests; pause (joining and blasts stop, pages say so), resume (what was held goes out
// once), retry (never a second copy) — only for the signed-in owner. Never a password or a hash.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-ops-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_EVENTS = "owner";
delete process.env.REASON_OPS_PASSWORD_HASH;

const events = await import("../src/events.js");
const { opsRequest, eventRequestFor } = await import("../src/http.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const AMA_C = "dm:fake:+13475550000";
const YAW_C = "dm:fake:+16465550111";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = "owner";
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM page_sessions;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: "+13475550000", name: "Ama" });
  db.upsertAccount({ conversationId: YAW_C, channel: "fake", address: "+16465550111", name: "Yaw" });
  db.startPageSession("ops", "tok-owner", { conversationId: OWNER_C });
});

function fakeRuntime({ fail = new Set() } = {}) {
  const sent = [];
  return {
    sent, say() {},
    async _tell(conversationId, text, { idempotencyKey }) {
      const have = db.db.prepare("SELECT * FROM outbox WHERE idem_key = ?").get(idempotencyKey);
      if (have) return { ok: have.state === "sent", outbox_id: have.id, duplicate: true };
      const state = fail.has(conversationId) ? "failed" : "sent";
      if (state === "sent") sent.push({ conversationId, text });
      const now = clock.now();
      const id = db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, created_at, updated_at) VALUES (?, ?, 'fake', 'x', ?, ?, ?, ?)`).run(idempotencyKey, conversationId, text, state, now, now).lastInsertRowid;
      return state === "sent" ? { ok: true, outbox_id: Number(id) } : { ok: false, outbox_id: Number(id), error: "nope" };
    },
  };
}
const ops = (o = {}) => opsRequest({ method: "GET", headers: { cookie: "reason_page=tok-owner" }, readBody: async () => "", runtime: o.runtime ?? fakeRuntime(), log: () => {}, ...o });
const press = (action, id, runtime, cookie = "reason_page=tok-owner") => opsRequest({ method: "POST", headers: { cookie }, readBody: async () => `action=${action}&event_id=${id}`, runtime, log: () => {} });

async function setup(rt) {
  const ev = events.create(OWNER_C, { name: "Halloween Party", description: "d", starts_at: "2026-10-31T21:00", location: "12 Elm St", password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true }).event;
  await runTool("event_join", { name: "Halloween Party", password: "pumpkin" }, { conversationId: AMA_C, messages: [], events: rt });
  await runTool("event_join", { name: "Halloween Party", password: "pumpkin" }, { conversationId: YAW_C, messages: [], events: rt });
  await events.joinExisting({ conversationId: "dm:fake:+15550001234", name: "Halloween Party", password: "wrong!" });
  return ev;
}

test("the events section: counts, delivery per message, buttons — never a password, hash or phone number", async () => {
  const rt = fakeRuntime({ fail: new Set([YAW_C]) });
  const ev = await setup(rt);
  await runTool("event_blast", { event_id: ev.id, message: "snacks" }, { conversationId: OWNER_C, messages: [], events: rt });
  const s = events.opsSummary();
  assert.equal(s.created_7d, 1);
  assert.equal(s.joins_7d, 2);
  assert.equal(s.failed_joins_24h, 1);
  const row = s.events[0];
  assert.equal(row.going, 2);
  assert.equal(row.failed_joins_24h, 1);
  assert.equal(row.failed_deliveries, 2, "Yaw's welcome and blast");
  assert.deepEqual(row.messages.map(m => [m.kind, m.sent, m.failed]), [["blast", 1, 1], ["welcome", 0, 1], ["welcome", 1, 0]]);
  const page = await ops();
  assert.equal(page.status, 200);
  assert.match(page.body, /<h2>Events<\/h2>/);
  assert.match(page.body, /Halloween Party/);
  assert.match(page.body, /value="event_pause"/);
  assert.match(page.body, /Retry 2 failed/);
  assert.match(page.body, /1\/2 reached/);
  for (const leak of [/scrypt/, /pumpkin/, /\+1\d{10}|3475550000|6465550111/]) assert.ok(!leak.test(page.body), `no ${leak}`);
  const json = JSON.parse((await ops({ json: true })).body);
  assert.equal(json.events.events[0].name, "Halloween Party");
  assert.ok(!/scrypt|password_hash|pumpkin/.test(JSON.stringify(json.events)));
});

test("pause from the status page: joining and blasts stop and the page says so; resume sends what was held, once", async () => {
  const rt = fakeRuntime();
  const ev = await setup(rt);
  const p = await press("event_pause", ev.id, rt);
  assert.equal(p.status, 303);
  assert.equal(db.getEventRow(ev.id).status, "paused");
  assert.equal((await events.joinExisting({ conversationId: "dm:fake:+15550002222", name: "Halloween Party", password: "pumpkin", displayName: "Z" })).reason, "paused");
  const blast = await runTool("event_blast", { event_id: ev.id, message: "x" }, { conversationId: OWNER_C, messages: [], events: rt });
  assert.equal(blast.ok, false);
  const page = await eventRequestFor({ publicId: ev.public_id, method: "GET", headers: {}, readBody: async () => null, router: null });
  assert.match(page.body, /Joining is paused/);
  rt.sent.length = 0;
  await runTool("event_update", { event_id: ev.id, starts_at: "2026-10-31T22:00" }, { conversationId: OWNER_C, messages: [], events: rt });
  assert.equal(rt.sent.length, 0, "held while paused");
  await press("event_resume", ev.id, rt);
  assert.equal(db.getEventRow(ev.id).status, "active");
  assert.equal(rt.sent.length, 2, "each guest gets the held update once");
  await press("event_resume", ev.id, rt);
  assert.equal(rt.sent.length, 2, "resuming again sends nothing");
});

test("retry from the status page reaches the failed guest once; pressing again sends nothing", async () => {
  const failing = fakeRuntime({ fail: new Set([YAW_C]) });
  const ev = await setup(failing);
  await runTool("event_blast", { event_id: ev.id, message: "snacks" }, { conversationId: OWNER_C, messages: [], events: failing });
  const ok = fakeRuntime();
  await press("event_retry", ev.id, ok);
  assert.equal(ok.sent.filter(s => s.conversationId === YAW_C).length, 2, "the welcome and the blast");
  await press("event_retry", ev.id, ok);
  assert.equal(ok.sent.length, 2);
  assert.equal(events.opsSummary().events[0].failed_deliveries, 0);
});

test("nobody but the signed-in owner can press them", async () => {
  const rt = fakeRuntime();
  const ev = await setup(rt);
  db.startPageSession("somepage", "tok-ama", { conversationId: AMA_C });
  await press("event_pause", ev.id, rt, "reason_page=tok-ama");
  await press("event_pause", ev.id, rt, "");
  assert.equal(db.getEventRow(ev.id).status, "active");
  const anon = await opsRequest({ method: "GET", headers: {}, readBody: async () => "", runtime: rt, log: () => {} });
  assert.ok(!/Halloween Party/.test(anon.body), "the gate shows nothing about events");
});

test("the owner's creation text links the status page", async () => {
  config.events = true;
  const said = [];
  const rt = { ...fakeRuntime(), async _tell(c, text) { said.push({ c, text }); return { ok: true }; } };
  await runTool("event_create", { name: "Dinner", description: "d", starts_at: "2026-11-01T19:00", location: "x", password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }, { conversationId: AMA_C, messages: [], events: rt });
  assert.match(said[0].text, /on the status page: .*\/ops\?k=.*focus=events#events/);
});

test("retry is offered only for what a retry could still send, and not while paused; cancelled-while-paused can't be resumed", async () => {
  const failing = fakeRuntime({ fail: new Set([YAW_C]) });
  const ev = await setup(failing);
  assert.equal(events.opsSummary().events[0].failed_deliveries, 1, "Yaw's welcome");
  db.updateAttendeeRow(db.attendeeRow(ev.id, YAW_C).id, { state: "removed" });
  assert.equal(events.opsSummary().events[0].failed_deliveries, 0, "nothing owed to somebody taken off");
  db.updateAttendeeRow(db.attendeeRow(ev.id, YAW_C).id, { state: "joined" });
  await press("event_pause", ev.id, failing);
  const page = await ops();
  assert.ok(!/Retry \d+ failed/.test(page.body), "no retry while paused");
  assert.match(page.body, /class="act-ev"/, "plain forms, not the Check-again script's");
  await runTool("event_cancel", { event_id: ev.id }, { conversationId: OWNER_C, messages: [], events: failing });
  await press("event_resume", ev.id, failing);
  assert.equal(db.getEventRow(ev.id).status, "cancelled");
});

test("a paused or failing event beyond the 20 newest is still shown; the JSON button path answers", async () => {
  const rt = fakeRuntime();
  const old = events.create(OWNER_C, { name: "Old One", description: "d", starts_at: "2026-10-31T21:00", location: "x", password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }).event;
  for (let i = 0; i < 21; i++) events.create(OWNER_C, { name: `E${i}`, description: "d", starts_at: "2026-10-31T21:00", location: "x", password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true });
  assert.ok(!events.opsSummary().events.some(e => e.id === old.id));
  const r = await opsRequest({ method: "POST", headers: { cookie: "reason_page=tok-owner", accept: "application/json" }, readBody: async () => `action=event_pause&event_id=${old.id}`, runtime: rt, log: () => {} });
  assert.equal(JSON.parse(r.body).ok, true);
  assert.ok(events.opsSummary().events.some(e => e.id === old.id), "paused, so shown");
});
