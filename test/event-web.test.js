// The event's pages and the text that finishes a web join (src/pages/event.js, src/channels/router.js
// #claimEvent): the public page shows the name and description and nothing else; a browser with a
// Reason page session is joined on the spot as the account it already is; anybody else finishes with
// one text that proves the phone, which makes a new account through the event (no invite spent) or
// finds the existing one; then the welcome, the card and one question — or, for somebody already on
// Reason, the welcome alone. And the who's-going page: attendee-only, opt-in, Instagram as a link,
// never a phone number.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-web-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_EVENTS = "owner";
delete process.env.REASON_AUTO_ADMIT;

const events = await import("../src/events.js");
const { eventRequestFor } = await import("../src/http.js");
const { Runtime } = await import("../src/runtime.js");
const { Router, EVENT_CARD_LINE, EVENT_QUESTION } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const AMA = "+13475550000";
const NEW1 = "+16465550101";
const OWNER_C = config.ownerConversation;
const AMA_C = `dm:fake:${AMA}`;
const LINE = "+16562167455";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = "owner";
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations;
    DELETE FROM inbound_messages; DELETE FROM access_requests; DELETE FROM invite_allowances; DELETE FROM page_sessions;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: AMA, name: "Ama" });
  db.db.prepare("UPDATE accounts SET contact_card_sent_at = 1 WHERE conversation_id = ?").run(AMA_C);
  db.upsertThread({ conversationId: AMA_C, channel: "fake", address: AMA, isOwner: true });
});

function harness() {
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "ok"; } });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router, channel, turns };
}
let seq = 0;
const texts = (from, body) => ({ channel: "fake", externalId: `m${++seq}`, from, text: body, at: clock.now() });
const sentTo = (channel, to) => channel.sent.filter(m => m.to === to);

function ownerEvent(over = {}) {
  const out = events.create(OWNER_C, {
    name: "Halloween Party", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St, Apt 4",
    welcome_message: "so glad you're coming!", password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true, ...over,
  });
  assert.equal(out.ok, true);
  return out.event;
}
const form = (o) => new URLSearchParams(o).toString();
async function req(h, ev, { sub = null, method = "GET", body = null, query = {}, cookie = "", ip = "203.0.113.9" } = {}) {
  return await eventRequestFor({
    publicId: ev.public_id, sub, method, query, headers: { cookie, "x-forwarded-for": ip, "x-files-domain": "true" }, remoteAddress: "127.0.0.1",
    readBody: async () => body, runtime: h.runtime, router: h.router,
  });
}

// ---------- the public page ----------

test("before the password the page — and its link preview — shows the name and description and nothing else", async () => {
  const h = harness();
  const ev = ownerEvent({ show_time_on_join: true, show_location_on_join: false });
  await events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin", inDirectory: true });
  const out = await req(h, ev);
  assert.equal(out.status, 200);
  assert.match(out.body, /<h1>Halloween Party<\/h1>/);
  assert.match(out.body, /costumes mandatory/);
  assert.match(out.body, /og:title" content="Halloween Party"/);
  for (const leak of [/Elm St/, /Oct 31|9:00|21:00/, /Ama/, /\+1\d{10}/, /pumpkin|scrypt/]) assert.ok(!leak.test(out.body), `page leaks ${leak}`);
  assert.match(out.body, /Joining gives you access to Reason, an assistant you text that can help you with everything about this event \(and more\)/, "access framing, said plainly");
  assert.match(out.body, /Joining starts a text conversation between you and Reason/, "that joining starts a Reason conversation is said plainly");
  assert.ok(!/signs you up/.test(out.body), "never framed as a signup");
  assert.equal((await eventRequestFor({ publicId: "AAAAAAAAAAAAAAAA", method: "GET", headers: {}, readBody: async () => null, router: h.router })).status, 404);
});

test("a cancelled event's page says so and offers no form; a paused one says joining is paused", async () => {
  const h = harness();
  const ev = ownerEvent();
  db.updateEventRow(ev.id, { status: "paused" });
  let out = await req(h, ev);
  assert.match(out.body, /Joining is paused/);
  assert.ok(!/<form/.test(out.body));
  db.updateEventRow(ev.id, { status: "cancelled" });
  out = await req(h, ev);
  assert.match(out.body, /cancelled/);
  assert.ok(!/<form/.test(out.body) && !/costumes/.test(out.body));
});

test("a wrong password on the page is refused, and a browser guessing is held back", async () => {
  const h = harness();
  const ev = ownerEvent();
  const wrong = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "nope", display_name: "Esi" }) });
  assert.match(wrong.body, /password isn&#39;t right/);
  assert.ok(!/Last step/.test(wrong.body));
  for (let i = 0; i < 3; i++) await req(h, ev, { sub: "join", method: "POST", body: form({ password: `x${i}xx`, display_name: "Esi" }) });
  const held = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "pumpkin", display_name: "Esi" }) });
  assert.equal(held.status, 429);
  const other = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "pumpkin", display_name: "Kojo" }), ip: "198.51.100.7" });
  assert.match(other.body, /Last step/, "another browser is not held up");
  // A header written by the browser itself (not through the proxy) is not trusted for the count.
  const direct = await eventRequestFor({ publicId: ev.public_id, sub: "join", method: "POST", headers: { "x-forwarded-for": "1.2.3.4" }, remoteAddress: "203.0.113.50", readBody: async () => form({ password: "nah", display_name: "x" }), router: h.router });
  assert.ok(direct.status === 200);
  assert.ok(db.db.prepare("SELECT COUNT(*) AS n FROM event_join_attempts WHERE actor = 'ip:203.0.113.50'").get().n >= 1);
});

// ---------- a new guest ----------

test("a new guest: everything on the page, one text to finish; then welcome (released only), card, one question — in that order, no turn", async () => {
  const h = harness();
  const ev = ownerEvent();
  const page = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "Pumpkin", display_name: "Esi", instagram: "@esi.b", in_directory: "1" }) });
  assert.match(page.body, /Last step/);
  assert.match(page.body, /Text Reason to finish/);
  const href = /href="(sms:[^"]+)"/.exec(page.body)[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  assert.ok(href.startsWith(`sms:${LINE}?&body=`));
  const text = decodeURIComponent(href.split("body=")[1]);
  assert.match(text, /^Hi Reason, I'm joining Halloween Party with code [2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(db.accountByAddress("fake", NEW1), null, "nothing made until the phone proves itself");

  const r = await h.router.deliver(texts(NEW1, text));
  assert.equal(r.event, "joined");
  assert.equal(r.newAccount, true);
  assert.equal(h.turns.length, 0, "no model turn on the code text");
  const acct = db.accountByAddress("fake", NEW1);
  assert.equal(acct.joined_via_event, ev.id);
  assert.equal(acct.name, "Esi");
  assert.equal(db.inviteAllowance(acct.conversation_id), 0);
  const att = db.attendeeRow(ev.id, acct.conversation_id);
  assert.equal(att.via, "web_text");
  assert.equal(att.instagram, "esi.b");
  assert.equal(att.in_directory, 1);

  const got = sentTo(h.channel, NEW1);
  const all = got.map(m => m.text).join("\n---\n");
  const iWelcome = got.findIndex(m => /so glad you're coming/.test(m.text));
  const iCard = got.findIndex(m => m.text === EVENT_CARD_LINE);
  const iQuestion = got.findIndex(m => m.text === EVENT_QUESTION);
  assert.ok(iWelcome >= 0 && iCard > iWelcome && iQuestion > iCard, `order welcome → card → question: ${all}`);
  assert.ok(got[iCard].media?.url?.endsWith("/reason.vcf"), "the card is the contact card");
  assert.match(all, /when: Sat, Oct 31/);
  assert.ok(!/Elm/.test(all), "the hidden address is not sent");
  assert.match(all, new RegExp(`/e/${ev.public_id}/who\\?t=${att.token}`));
  assert.equal(events.deliveryReport(ev).find(m => m.kind === "welcome").sent, 1, "the welcome is a tracked delivery");

  // A provider retrying that same text: nothing twice.
  const before = h.channel.sent.length;
  await h.router.deliver({ ...texts(NEW1, text), externalId: `m${seq}` });
  assert.equal(h.channel.sent.length, before);

  // They skip the question and say something else: they stay joined, and it's a normal turn.
  await h.router.deliver(texts(NEW1, "lol later. when is it again?"));
  assert.equal(h.turns.length, 1);
  assert.equal(db.attendeeRow(ev.id, acct.conversation_id).state, "joined");
  const history = JSON.stringify(db.loadConversation(acct.conversation_id));
  assert.match(history, /what do you do/, "the turn their answer starts knows the question");
});

test("a code from before a password rotation, a used code and a full event are refused in a line, and nothing is made", async () => {
  const h = harness();
  const ev = ownerEvent({ capacity: 1 });
  const claim = events.makeClaim({ ev, displayName: "Esi" });
  db.updateEventRow(ev.id, { password_hash: events.hashPassword("ghosts"), password_version: ev.password_version + 1 });
  await h.router.deliver(texts(NEW1, events.claimText(ev, claim.code)));
  assert.match(sentTo(h.channel, NEW1).at(-1).text, /changed the event's password/);
  assert.equal(db.accountByAddress("fake", NEW1), null);
  const ev2 = db.getEventRow(ev.id);
  await events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "ghosts" });
  const c2 = events.makeClaim({ ev: ev2, displayName: "Esi" });
  await h.router.deliver(texts(NEW1, events.claimText(ev2, c2.code)));
  assert.match(sentTo(h.channel, NEW1).at(-1).text, /full/);
  assert.equal(db.accountByAddress("fake", NEW1), null);
});

// ---------- somebody already on Reason, on the page ----------

test("existing user with a page session: joined on the spot as their own account — no signup, no code, no onboarding", async () => {
  const h = harness();
  const ev = ownerEvent();
  db.startPageSession("somepage1", "tok-ama-session-0001", { conversationId: AMA_C });
  const cookie = "reason_page=tok-ama-session-0001";
  const get = await req(h, ev, { cookie });
  assert.match(get.body, /signed in to Reason as Ama/);
  assert.match(get.body, /so this just adds you to the event — its updates come to your Reason conversation/);
  assert.ok(!/Joining gives you access/.test(get.body), "no new-guest notice for somebody already on Reason");
  assert.ok(!/display_name/.test(get.body), "no name to pick: they already have one");
  const before = db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
  const out = await req(h, ev, { sub: "join", method: "POST", cookie, body: form({ password: "pumpkin", in_directory: "1" }) });
  assert.match(out.body, /You're in/);
  assert.ok(!/Last step|sms:/.test(out.body));
  assert.match(out.body, /See who's going/);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, before, "no new account");
  const att = db.attendeeRow(ev.id, AMA_C);
  assert.equal(att.via, "web");
  assert.equal(att.display_name, "Ama");
  const got = sentTo(h.channel, AMA).map(m => m.text);
  assert.ok(!got.some(t => t === EVENT_QUESTION || t === EVENT_CARD_LINE), "the welcome only: no card, no question");
  assert.match(got.join("\n"), /so glad you're coming/);
  assert.equal(events.deliveryReport(ev).filter(m => m.kind === "welcome").length, 1);
  assert.equal((await req(h, ev, { cookie })).body.includes("You're in"), true, "opening it again shows they're in");
});

test("existing user without a page session: the same one text finds their account and just joins them", async () => {
  const h = harness();
  const ev = ownerEvent();
  const page = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "pumpkin", display_name: "Ama B" }) });
  const text = decodeURIComponent(/body=([^"]+)"/.exec(page.body)[1].replace(/&amp;/g, "&"));
  const sansSeen = (a) => JSON.stringify({ ...a, last_seen_at: null });
  const acct = sansSeen(db.getAccount(AMA_C));
  const r = await h.router.deliver(texts(AMA, text));
  assert.equal(r.event, "joined");
  assert.equal(r.newAccount, false);
  assert.equal(h.turns.length, 0);
  assert.equal(sansSeen(db.getAccount(AMA_C)), acct, "their account untouched (beyond being seen)");
  const got = sentTo(h.channel, AMA).map(m => m.text);
  assert.match(got.join("\n"), /so glad you're coming/, "the welcome");
  assert.ok(!got.some(t => t === EVENT_QUESTION || t === EVENT_CARD_LINE));
  assert.equal(db.attendeeRow(ev.id, AMA_C).display_name, "Ama B", "the name they picked on the page, for this event only");
});

// ---------- the who's-going page ----------

test("who's going: only joined guests, opt-in, Instagram as a link, never a phone number; leaving ends access", async () => {
  const h = harness();
  const ev = ownerEvent();
  const a = (await events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin", inDirectory: true, instagram: "ama.k" })).attendee;
  db.upsertAccount({ conversationId: "dm:fake:+15550009999", channel: "fake", address: "+15550009999", name: "Hidden Hal" });
  await events.joinExisting({ conversationId: "dm:fake:+15550009999", name: "Halloween Party", password: "pumpkin" });
  const page = await req(h, ev, { sub: "who", query: { t: a.token } });
  assert.equal(page.status, 200);
  assert.match(page.body, /<a href="https:\/\/www\.instagram\.com\/ama\.k\/" rel="noopener noreferrer" target="_blank">@ama\.k<\/a>/);
  assert.ok(!/Hidden Hal/.test(page.body), "not opted in, not listed");
  assert.ok(!/\+1\d{10}|3475550000|5550009999/.test(page.body), "no phone numbers");
  assert.ok(!/Elm/.test(page.body), "the hidden address is not on the guest's page either");
  assert.equal((await req(h, ev, { sub: "who" })).status, 404, "no token, no page");
  assert.equal((await req(h, ev, { sub: "who", query: { t: "x".repeat(43) } })).status, 404);
  const org = await req(h, ev, { sub: "who", query: { t: ev.organizer_token } });
  assert.match(org.body, /Hidden Hal/);
  assert.match(org.body, /not listed/);
  assert.ok(!/5550009999/.test(org.body));
  // Opt out and drop Instagram from the page itself.
  const saved = await req(h, ev, { sub: "who", method: "POST", body: form({ t: a.token, display_name: "Ama", instagram: "" }) });
  assert.equal(saved.status, 303);
  assert.deepEqual(events.directoryEntries(ev), []);
  assert.equal(db.attendeeRow(ev.id, AMA_C).instagram, null);
  // Guest list turned off: guests see that it's private.
  db.updateEventRow(ev.id, { guest_list_visible: 0 });
  assert.match((await req(h, ev, { sub: "who", query: { t: a.token } })).body, /keeping the guest list private/);
  // Leaving ends access.
  db.updateAttendeeRow(a.id, { state: "left" });
  assert.equal((await req(h, ev, { sub: "who", query: { t: a.token } })).status, 404);
  // A token for one event opens nothing on another.
  const other = events.create(OWNER_C, { name: "Dinner", description: "d", starts_at: "2026-11-01T19:00", location: "x", password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }).event;
  assert.equal((await req(h, other, { sub: "who", query: { t: ev.organizer_token } })).status, 404);
});

test("a cancelled event closes the who's-going page too", async () => {
  const h = harness();
  const ev = ownerEvent();
  const a = (await events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" })).attendee;
  db.updateEventRow(ev.id, { status: "cancelled" });
  assert.equal((await req(h, ev, { sub: "who", query: { t: a.token } })).status, 404);
});

test("with events off, the pages are a flat not-found", async () => {
  const h = harness();
  const ev = ownerEvent();
  config.events = false;
  assert.equal((await req(h, ev)).status, 404);
});

test("the forms and links resolve to real routes from the address a guest actually opens", async () => {
  const h = harness();
  const ev = ownerEvent();
  const route = /^(?:\/p)?\/e\/([A-Za-z0-9_-]{16})(?:\/(join|who))?$/;
  const join = /action="([^"]+)"/.exec((await req(h, ev)).body)[1].replace(/&amp;/g, "&");
  for (const opened of [events.eventUrl(ev), `http://127.0.0.1:8797/e/${ev.public_id}`]) {
    const target = new URL(join, opened);
    const m = route.exec(target.pathname);
    assert.ok(m && m[1] === ev.public_id && m[2] === "join", `${opened} → ${target.pathname}`);
  }
  db.startPageSession("p1", "tok-ama-2", { conversationId: AMA_C });
  const joined = await req(h, ev, { sub: "join", method: "POST", cookie: "reason_page=tok-ama-2", body: form({ password: "pumpkin" }) });
  const who = /href="([^"]*\/who\?t=[^"]+)"/.exec(joined.body)[1].replace(/&amp;/g, "&");
  const target = new URL(who, events.eventUrl(ev));
  assert.equal(route.exec(target.pathname)?.[2], "who");
  const page = await req(h, ev, { sub: "who", query: { t: target.searchParams.get("t") } });
  const action = /<form class="ev-form" method="POST" action="([^"]+)"/.exec(page.body)[1];
  assert.equal(route.exec(new URL(action, events.eventUrl(ev)).pathname)?.[2], "who");
});

test("a forged forwarding header never buys a fresh count: only Caddy's X-Forwarded-For on the files domain is read", async () => {
  const h = harness();
  const ev = ownerEvent();
  const guess = (headers, pw) => eventRequestFor({ publicId: ev.public_id, sub: "join", method: "POST", headers, remoteAddress: "127.0.0.1", readBody: async () => form({ password: pw, display_name: "x" }), router: h.router });
  for (let i = 0; i < 4; i++) await guess({ "x-files-domain": "true", "x-forwarded-for": "203.0.113.77", "x-nf-client-connection-ip": `10.0.0.${i}` }, `bad${i}xx`);
  const held = await guess({ "x-files-domain": "true", "x-forwarded-for": "203.0.113.77", "x-nf-client-connection-ip": "10.9.9.9" }, "pumpkin");
  assert.equal(held.status, 429, "the Netlify header is ignored on the files domain");
  const actors = db.db.prepare("SELECT DISTINCT actor FROM event_join_attempts WHERE actor LIKE 'ip:%'").all().map(r => r.actor);
  assert.deepEqual(actors, ["ip:203.0.113.77"]);
});

test("a page session for an account Reason no longer serves does not join or text anybody", async () => {
  const h = harness();
  const ev = ownerEvent();
  db.db.prepare("UPDATE accounts SET state = 'paused' WHERE conversation_id = ?").run(AMA_C);
  db.startPageSession("p2", "tok-ama-3", { conversationId: AMA_C });
  const out = await req(h, ev, { sub: "join", method: "POST", cookie: "reason_page=tok-ama-3", body: form({ password: "pumpkin", display_name: "Ama" }) });
  assert.equal(db.attendeeRow(ev.id, AMA_C), null);
  assert.equal(sentTo(h.channel, AMA).length, 0);
  assert.ok(!/You're in/.test(out.body));
  assert.match(out.body, /Last step|isn&#39;t connected/, "they get the ordinary page, not a dead end");
});

test("past an event's ceiling every browser waits, whatever address it claims; a phone still gets its first try", async () => {
  const h = harness();
  const ev = ownerEvent();
  for (let i = 0; i < events.JOIN_LIMITS.perEventHour; i++) db.recordJoinAttempt({ eventId: ev.id, actor: `event:${ev.id}`, route: "web", ok: false });
  const fresh = await eventRequestFor({ publicId: ev.public_id, sub: "join", method: "POST", headers: { "x-files-domain": "true", "x-forwarded-for": "198.18.0.99" }, remoteAddress: "127.0.0.1", readBody: async () => form({ password: "pumpkin", display_name: "x" }), router: h.router });
  assert.equal(fresh.status, 429, "a never-seen address is held too");
  assert.equal((await events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" })).ok, true, "by text, a real guest still gets in");
});
