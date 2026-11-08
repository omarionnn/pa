// The organizer's own event page (src/pages/eventmanage.js): /e/{id} on the organizer's own browser
// is where they run the event, and every change there is the text tool's own call. Pinned here:
//
//   - every POST is refused — the flat not-found — for a browser that is signed out, a guest's, a
//     stranger's, and the organizer of a DIFFERENT event; a post from another site is refused too;
//   - each action does what the text tool does (the same rows, the same words to guests);
//   - what the page previews is exactly what guests are sent;
//   - anything that texts guests or cannot be undone takes a confirm step first.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

const dir = mkdtempSync(pathJoin(tmpdir(), "reason-event-manage-"));
process.env.REASON_DB_PATH = pathJoin(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_CADDY_SECRET = "caddy-test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_EVENTS = "on";
process.env.REASON_EVENT_RIDES = "on";
delete process.env.REASON_AUTO_ADMIT;

const events = await import("../src/events.js");
const tools = await import("../src/eventtools.js");
const { eventRequestFor } = await import("../src/http.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234", AMA = "+13475550000", KOFI = "+13475550001", YAW = "+13475550002";
const OWNER_C = config.ownerConversation, AMA_C = `dm:fake:${AMA}`, KOFI_C = `dm:fake:${KOFI}`, YAW_C = `dm:fake:${YAW}`;
const LINE = "+16562167455";
const COOKIE = { owner: "reason_page=tok-owner-manage-0001", ama: "reason_page=tok-ama-manage-0001", kofi: "reason_page=tok-kofi-manage-0001" };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = true;
  config.eventRides = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations;
    DELETE FROM inbound_messages; DELETE FROM page_sessions;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  for (const [c, a, n] of [[AMA_C, AMA, "Ama"], [KOFI_C, KOFI, "Kofi"], [YAW_C, YAW, "Yaw"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
    db.db.prepare("UPDATE accounts SET contact_card_sent_at = 1 WHERE conversation_id = ?").run(c);
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: false });
  }
  db.startPageSession("p-owner", "tok-owner-manage-0001", { conversationId: OWNER_C });
  db.startPageSession("p-ama", "tok-ama-manage-0001", { conversationId: AMA_C });
  db.startPageSession("p-kofi", "tok-kofi-manage-0001", { conversationId: KOFI_C });
});

function harness() {
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router, channel };
}
const make = (organizer, over = {}) => {
  const out = events.create(organizer, {
    name: "Halloween Party", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St, Apt 4",
    welcome_message: "so glad you're coming!", password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true, ...over,
  });
  assert.equal(out.ok, true);
  return out.event;
};
const join = async (c, ev, pw = "pumpkin") => (await events.joinExisting({ conversationId: c, link: events.eventUrl(ev), password: pw, inDirectory: true })).attendee;
const form = (o) => new URLSearchParams(o).toString();
async function req(h, ev, { sub = null, method = "GET", body = null, query = {}, cookie = "", origin = null } = {}) {
  const headers = { cookie, "x-forwarded-for": "203.0.113.9", "x-files-domain": "true", "x-reason-caddy": "caddy-test", host: "files.example.test" };
  if (origin) headers.origin = origin;
  return await eventRequestFor({ publicId: ev.public_id, sub, method, query, headers, remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router });
}
const post = (h, ev, fields, cookie = COOKIE.owner, extra = {}) => req(h, ev, { sub: "manage", method: "POST", body: form(fields), cookie, ...extra });
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const bubbles = (html) => [...html.matchAll(/<p class="mg-bubble"[^>]*>([\s\S]*?)<\/p>/g)].map(m => unesc(m[1]));
const sentTo = (h, to) => h.channel.sent.filter(m => m.to === to).map(m => m.text);
const settle = () => new Promise(r => setTimeout(r, 30));

// Every action, at the step that would change something.
const ACTIONS = (ev, guestId) => [
  { action: "welcome", welcome: "new words" },
  { action: "welcome", clear: "1" },
  { action: "blast", step: "send", message: "hello all" },
  { action: "blast", step: "preview", message: "hello all" },
  { action: "details", step: "save", name: "Renamed", description: "costumes mandatory", starts_at: "2026-10-31T22:00", timezone: "America/New_York", location: "elsewhere" },
  { action: "release", step: "do", detail: "location" },
  { action: "remove", step: "do", guest: String(guestId) },
  { action: "password", step: "do", password: "newpass" },
  { action: "rides", step: "do", enabled: "1" },
  { action: "cover_remove", step: "do" },
  { action: "cancel", step: "do", confirm_name: ev.name, message: "sorry" },
];
const snapshot = (ev) => JSON.stringify({
  ev: db.getEventRow(ev.id), messages: db.eventMessages(ev.id, { limit: 100 }).length,
  guests: db.attendeesOf(ev.id, { state: null }).map(a => [a.id, a.state]),
});

// ---------- who may post ----------

test("every manage POST is refused for signed-out, guest, stranger and another event's organizer — nothing changes", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  const ama = await join(AMA_C, ev);
  // Kofi organizes his own event: an organizer, but not of this one.
  make(KOFI_C, { name: "Kofi's Dinner", password: "jollof" });
  const before = snapshot(ev);
  for (const fields of ACTIONS(ev, ama.id)) {
    for (const [who, cookie] of [["signed out", ""], ["a guest", COOKIE.ama], ["another event's organizer", COOKIE.kofi], ["a made-up session", "reason_page=nope-nope-nope"]]) {
      const out = await post(h, ev, fields, cookie);
      assert.equal(out.status, 404, `${who} posting ${fields.action}/${fields.step ?? ""} gets the flat not-found`);
      assert.ok(!/Halloween/.test(out.body), `${who}: the not-found says nothing about the event`);
    }
  }
  assert.equal(snapshot(ev), before, "nothing about the event changed");
  assert.equal(h.channel.sent.length, 0, "nobody was texted");
});

test("the organizer's own browser posting to a different event's manage address is refused", async () => {
  const h = harness();
  const mine = make(OWNER_C);
  const kofis = make(KOFI_C, { name: "Kofi's Dinner", password: "jollof" });
  await join(AMA_C, kofis, "jollof");
  const before = snapshot(kofis);
  for (const fields of ACTIONS(kofis, 1)) assert.equal((await post(h, kofis, fields, COOKIE.owner)).status, 404);
  assert.equal(snapshot(kofis), before);
  assert.equal(h.channel.sent.length, 0);
  assert.ok(mine);
});

test("a post from another site is refused even with the organizer's cookie; same-origin goes through", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  await join(AMA_C, ev);
  const evil = await post(h, ev, { action: "blast", step: "send", message: "phish" }, COOKIE.owner, { origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  const cross = await req(h, ev, { sub: "manage", method: "POST", body: form({ action: "welcome", welcome: "x" }), cookie: COOKIE.owner, origin: "null" });
  assert.equal(cross.status, 403, "Origin: null without the browser's same-origin word");
  assert.equal(h.channel.sent.length, 0);
  assert.equal(db.getEventRow(ev.id).welcome, "so glad you're coming!");
  const ok = await post(h, ev, { action: "welcome", welcome: "fresh" }, COOKIE.owner, { origin: "https://files.example.test" });
  assert.equal(ok.status, 303);
  assert.equal(db.getEventRow(ev.id).welcome, "fresh");
});

test("a GET to the manage address never changes anything, and a cancelled event's is gone", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  const g = await req(h, ev, { sub: "manage", cookie: COOKIE.owner });
  assert.equal(g.status, 303);
  assert.equal((await req(h, ev, { sub: "manage", cookie: COOKIE.ama })).status, 404);
  db.updateEventRow(ev.id, { status: "cancelled" });
  assert.equal((await post(h, ev, { action: "welcome", welcome: "x" })).status, 404);
});

// ---------- the page ----------

test("the organizer's /e/{id} is the manage page; a guest and a stranger never see it", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  await join(AMA_C, ev);
  const own = await req(h, ev, { cookie: COOKIE.owner });
  assert.equal(own.status, 200);
  for (const s of ["Your event", "Your guest list", "Welcome message", "Message guests", "Details", "Guests", "Sharing", "Cancel the event", 'action="/e/']) assert.ok(own.body.includes(s.toUpperCase()) || own.body.includes(s), `has ${s}`);
  assert.match(own.body, /HIDDEN FROM GUESTS/, "the hidden location says so");
  assert.ok(!/3475550000/.test(own.body), "no phone numbers");
  const guest = await req(h, ev, { cookie: COOKIE.ama });
  assert.ok(!/MESSAGE GUESTS|mg-sec/.test(guest.body));
  const stranger = await req(h, ev);
  assert.ok(!/MESSAGE GUESTS|mg-sec|Elm St/.test(stranger.body));
});

test("the welcome preview is welcomeText; saving and clearing go through event_update", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  const own = await req(h, ev, { cookie: COOKIE.owner });
  const [preview] = bubbles(own.body);
  const real = events.welcomeText(ev, { token: "PREVIEW", in_directory: 1 }).split(events.directoryUrl(ev, { token: "PREVIEW" })).join("[their own who's-going link]");
  assert.equal(preview, real, "the preview is the welcome a new guest gets");
  assert.ok(preview.startsWith("so glad you're coming!\n\nyou're in for Halloween Party"));
  assert.match(own.body, /22 \/ 1000/, "a character count");
  assert.equal((await post(h, ev, { action: "welcome", welcome: "  bring snacks  " })).status, 303);
  assert.equal(db.getEventRow(ev.id).welcome, "bring snacks");
  assert.equal((await post(h, ev, { action: "welcome", welcome: "ignored", clear: "1" })).status, 303);
  assert.equal(db.getEventRow(ev.id).welcome, "");
  const tooLong = await post(h, ev, { action: "welcome", welcome: "x".repeat(1001) });
  assert.equal(tooLong.status, 200);
  assert.match(tooLong.body, /up to 1000 characters/);
  assert.equal(h.channel.sent.length, 0, "saving a welcome texts nobody");
});

test("message everyone: preview shows the exact text and the count, nothing goes until send, and the sent text is the preview", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  await join(AMA_C, ev);
  await join(YAW_C, ev);
  db.updateAttendeeRow(db.attendeeRow(ev.id, YAW_C).id, { muted: 1 });
  await settle();
  const welcomes = h.channel.sent.length;
  const prev = await post(h, ev, { action: "blast", step: "preview", message: "  doors at 9, bring a costume  " });
  assert.equal(prev.status, 200);
  const [shown] = bubbles(prev.body);
  assert.equal(shown, tools.blastBody(ev, "doors at 9, bring a costume"));
  assert.equal(shown, "Halloween Party — from Omari:\ndoors at 9, bring a costume", "the from-the-organizer header is in the preview");
  assert.match(prev.body, /Send to 1 guest/);
  assert.match(prev.body, /1 guest muted this event/);
  assert.equal(h.channel.sent.length, welcomes, "a preview texts nobody");
  const sent = await post(h, ev, { action: "blast", step: "send", message: "  doors at 9, bring a costume  " });
  assert.equal(sent.status, 303);
  assert.match(sent.headers.Location, /done=blast&n=1&f=0&g=1#message/);
  await settle();
  assert.deepEqual(sentTo(h, AMA).slice(-1), [shown], "the guest got exactly the preview");
  assert.equal(sentTo(h, YAW).filter(t => t === shown).length, 0, "the muted guest did not");
  // The same words through the text tool make the same message (and, inside ten minutes, are the same one).
  const viaText = await tools.runEventTool("event_blast", { event_id: ev.id, message: "doors at 9, bring a costume" }, { conversationId: OWNER_C, events: h.runtime });
  assert.equal(db.eventMessage(viaText.sent.message_id).body, shown);
  const history = events.sentMessages(ev);
  assert.equal(history.length, 1);
  assert.deepEqual([history[0].kind, history[0].body, history[0].total, history[0].sent], ["blast", shown, 1, 1]);
  const page = await req(h, ev, { cookie: COOKIE.owner, query: { done: "blast", n: "1", f: "0", g: "1" } });
  assert.match(page.body, /Reached 1 of 1/);
  assert.match(page.body, /Sent\. Reached 1 of 1\./);
});

test("message everyone is refused while the operator has the event paused", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  await join(AMA_C, ev);
  await settle();
  const n = h.channel.sent.length;
  events.pause(ev.id);
  const page = await req(h, ev, { cookie: COOKIE.owner });
  assert.match(page.body, /paused this event/, "the organizer still gets their page, saying it's paused");
  const out = await post(h, ev, { action: "blast", step: "send", message: "hi" });
  assert.match(out.body, /paused/);
  assert.equal(h.channel.sent.length, n);
});

test("details: a visible change asks first and shows the exact update; a hidden one saves quietly", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  await join(AMA_C, ev);
  await settle();
  const n = h.channel.sent.length;
  const base = { action: "details", name: ev.name, description: ev.description, starts_at: "2026-10-31T21:00", timezone: "America/New_York", location: ev.location };
  // The location is hidden: saved quietly, nobody told, no confirm step.
  const quiet = await post(h, ev, { ...base, step: "review", location: "99 Oak Ave" });
  assert.equal(quiet.status, 303);
  assert.match(quiet.headers.Location, /done=details_quiet/);
  assert.equal(db.getEventRow(ev.id).location, "99 Oak Ave");
  assert.equal(h.channel.sent.length, n);
  // The time is shown: a confirm page with the exact text, nothing saved yet.
  const ask = await post(h, ev, { ...base, location: "99 Oak Ave", step: "review", starts_at: "2026-10-31T22:30" });
  assert.equal(ask.status, 200);
  const plan = tools.planEventUpdate(db.getEventRow(ev.id), { starts_at: "2026-10-31T22:30", timezone: "America/New_York" });
  assert.deepEqual(bubbles(ask.body), [plan.body]);
  assert.match(plan.body, /^update for Halloween Party:\nnew time: Sat, Oct 31, 10:30/);
  assert.equal(db.getEventRow(ev.id).starts_at, ev.starts_at, "not saved before the yes");
  assert.equal(h.channel.sent.length, n);
  const save = await post(h, ev, { ...base, location: "99 Oak Ave", step: "save", starts_at: "2026-10-31T22:30" });
  assert.equal(save.status, 303);
  assert.match(save.headers.Location, /done=details&n=1&f=0&g=1/);
  await settle();
  assert.deepEqual(sentTo(h, AMA).slice(-1), [plan.body], "guests got exactly what the page showed");
  // Nothing changed: said so, nothing sent.
  const none = await post(h, ev, { ...base, location: "99 Oak Ave", starts_at: "2026-10-31T22:30", step: "review" });
  assert.match(none.headers.Location, /done=nothing/);
  // A bad zone is said plainly and saves nothing.
  const bad = await post(h, ev, { ...base, location: "99 Oak Ave", starts_at: "2026-10-31T22:30", timezone: "Mars/Olympus", step: "save" });
  assert.match(bad.body, /time zone isn&#39;t one Reason knows/);
});

test("release: confirm shows the exact text; doing it shares the detail the way event_release does", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  await join(AMA_C, ev);
  await settle();
  const ask = await post(h, ev, { action: "release", step: "review", detail: "location" });
  assert.deepEqual(bubbles(ask.body), [tools.releaseBody(ev, "location")]);
  assert.equal(bubbles(ask.body)[0], "update for Halloween Party — where: 12 Elm St, Apt 4");
  assert.match(ask.body, /can&#39;t be hidden from guests again/);
  assert.equal(db.getEventRow(ev.id).location_released, 0);
  const done = await post(h, ev, { action: "release", step: "do", detail: "location" });
  assert.equal(done.status, 303);
  assert.equal(db.getEventRow(ev.id).location_released, 1);
  await settle();
  assert.equal(sentTo(h, AMA).slice(-1)[0], "update for Halloween Party — where: 12 Elm St, Apt 4");
  assert.equal(db.eventMessages(ev.id)[0].kind, "release");
});

test("remove a guest: confirm first, then the event_guest_remove result — removed, told, can't rejoin", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  const ama = await join(AMA_C, ev);
  await settle();
  const page = await req(h, ev, { cookie: COOKIE.owner });
  assert.match(page.body, /<b>Ama<\/b>/);
  assert.match(page.body, /joined from a pasted link/);
  const ask = await post(h, ev, { action: "remove", step: "review", guest: String(ama.id) });
  assert.match(ask.body, /Take Ama off the event\?/);
  assert.deepEqual(bubbles(ask.body), [tools.removedBody(ev)]);
  assert.equal(db.attendeeRow(ev.id, AMA_C).state, "joined");
  assert.equal((await post(h, ev, { action: "remove", step: "do", guest: String(ama.id) })).status, 303);
  assert.equal(db.attendeeRow(ev.id, AMA_C).state, "removed");
  await settle();
  assert.equal(sentTo(h, AMA).slice(-1)[0], "you're no longer on the guest list for Halloween Party.");
  const again = await events.joinExisting({ conversationId: AMA_C, link: events.eventUrl(ev), password: "pumpkin" });
  assert.equal(again.reason, "removed");
  // A guest of another event, by id, is not this event's to remove.
  const other = make(KOFI_C, { name: "Kofi's Dinner", password: "jollof" });
  const yaw = await join(YAW_C, other, "jollof");
  const wrong = await post(h, ev, { action: "remove", step: "do", guest: String(yaw.id) });
  assert.match(wrong.body, /isn&#39;t on the event/);
  assert.equal(db.attendeeRow(other.id, YAW_C).state, "joined");
});

test("change the password: confirm first; the new one works, the old one doesn't, and it's shown once with the invite", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  const ask = await post(h, ev, { action: "password", step: "review", password: "ghosts!" });
  assert.match(ask.body, /Everyone already in stays in/);
  assert.equal(db.getEventRow(ev.id).password_version, ev.password_version);
  const done = await post(h, ev, { action: "password", step: "do", password: "ghosts!" });
  assert.equal(done.status, 200);
  assert.match(done.body, /ghosts!/);
  assert.ok(unesc(done.body).includes(events.shareText(ev, "ghosts!")));
  const row = db.getEventRow(ev.id);
  assert.equal(row.password_version, ev.password_version + 1);
  assert.equal(await events.checkPassword("ghosts!", row.password_hash), true);
  assert.equal(await events.checkPassword("pumpkin", row.password_hash), false);
  const short = await post(h, ev, { action: "password", step: "do", password: "abc" });
  assert.match(short.body, /at least 4 characters/);
  assert.ok(!/ghosts!/.test((await req(h, ev, { cookie: COOKIE.owner })).body), "never shown again");
});

test("rides on asks first; off is one tap; both through event_rides_setting", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  const ask = await post(h, ev, { action: "rides", step: "review", enabled: "1" });
  assert.match(ask.body, /Turn on ride sharing\?/);
  assert.equal(db.getEventRow(ev.id).rides_enabled, 0);
  await post(h, ev, { action: "rides", step: "do", enabled: "1" });
  assert.equal(db.getEventRow(ev.id).rides_enabled, 1);
  await post(h, ev, { action: "rides", step: "do", enabled: "0" });
  assert.equal(db.getEventRow(ev.id).rides_enabled, 0);
});

test("cancel needs the typed name on both steps, shows the exact text, and is the event_cancel result", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  await join(AMA_C, ev);
  await settle();
  const wrongName = await post(h, ev, { action: "cancel", step: "review", confirm_name: "halloween", message: "sorry all" });
  assert.match(wrongName.body, /type the event&#39;s name exactly/);
  const skipped = await post(h, ev, { action: "cancel", step: "do", confirm_name: "nope", message: "sorry all" });
  assert.match(skipped.body, /type the event&#39;s name exactly/, "the confirm page can't be skipped to");
  assert.equal(db.getEventRow(ev.id).status, "active");
  const ask = await post(h, ev, { action: "cancel", step: "review", confirm_name: "halloween party", message: "sorry all" });
  assert.deepEqual(bubbles(ask.body), [tools.cancelBody(ev, "sorry all")]);
  assert.equal(bubbles(ask.body)[0], "Halloween Party is cancelled.\nsorry all");
  assert.match(ask.body, /can&#39;t be undone/);
  const done = await post(h, ev, { action: "cancel", step: "do", confirm_name: "Halloween Party", message: "sorry all" });
  assert.equal(done.status, 303);
  assert.equal(db.getEventRow(ev.id).status, "cancelled");
  await settle();
  assert.equal(sentTo(h, AMA).slice(-1)[0], "Halloween Party is cancelled.\nsorry all");
  const after = await req(h, ev, { cookie: COOKIE.owner });
  assert.ok(!/mg-sec/.test(after.body), "a cancelled event has no manage page");
});

test("the text tool and the page send the same words: event_update's message is planEventUpdate's", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  await join(AMA_C, ev);
  const plan = tools.planEventUpdate(ev, { name: "Halloween Bash", description: "costumes optional" });
  const out = await tools.runEventTool("event_update", { event_id: ev.id, name: "Halloween Bash", description: "costumes optional" }, { conversationId: OWNER_C, events: h.runtime });
  assert.equal(out.ok, true);
  assert.equal(db.eventMessage(out.sent.message_id).body, plan.body);
  assert.equal(plan.body, "update for Halloween Bash:\nit's now called Halloween Bash\nnew description: costumes optional");
});
