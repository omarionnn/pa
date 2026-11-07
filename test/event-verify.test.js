// Spec v3 §12 and §14, pinned (§15 test 13): a private event page opens only on a browser Reason
// recognizes for that person. A new browser gets a gate that shows the event's name and nothing else,
// and a one-time code texted to the person the link belongs to — the same page code system every
// Reason page uses (hashed, 15 minutes, once, 5 wrong tries and 3 sends per 15 minutes). After the
// code, their role in THIS event is still checked; a verified non-member sees nothing private; a
// recognized browser is not asked again; a removed guest loses it at once; and a browser can be
// signed out, one or all.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-verify-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_CADDY_SECRET = "caddy-test"; // what Caddy adds beside its marker (src/pages/siteproxy.js caddyClientIp)
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_EVENTS = "on";

const events = await import("../src/events.js");
const db = await import("../src/db.js");
const { eventPageRequest } = await import("../src/pages/event.js");
const { runTool } = await import("../src/tools.js");
const { clock, config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const AMA = "+13475550000", YAW = "+16465550111", KOFI = "+14155559876";
const AMA_C = `dm:fake:${AMA}`, YAW_C = `dm:fake:${YAW}`, KOFI_C = `dm:fake:${KOFI}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM threads;
    DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  for (const [c, a, n] of [[AMA_C, AMA, "Ama"], [YAW_C, YAW, "Yaw"], [KOFI_C, KOFI, "Kofi"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true });
  }
});

function rig() {
  const texts = [];
  const logs = [];
  const runtime = { async _tell(conversationId, text) { texts.push({ conversationId, text }); return { ok: true }; } };
  const call = (ev, { sub = null, method = "GET", body = null, query = {}, cookie = "", ip = "203.0.113.7" } = {}) => eventPageRequest({
    publicId: ev.public_id, sub, method, query, headers: { cookie, "x-files-domain": "true", "x-reason-caddy": "caddy-test", "x-forwarded-for": ip }, remoteAddress: "127.0.0.1",
    readBody: async () => body, runtime, log: (e) => logs.push(e),
  });
  const codeFor = (c) => /code is ([0-9]{6}),/.exec([...texts].reverse().find(t => t.conversationId === c)?.text ?? "")?.[1] ?? null;
  return { texts, logs, call, codeFor };
}
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => /reason_page=([^;]+)/.exec(res.headers["Set-Cookie"] ?? "")?.[1] ?? null;

function party(over = {}) {
  const out = events.create(OWNER_C, {
    name: "Halloween Party", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St",
    password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true, ...over,
  });
  assert.equal(out.ok, true);
  return out.event;
}
const joined = async (c, name = "Halloween Party", password = "pumpkin", extra = {}) =>
  (await events.joinExisting({ conversationId: c, name, password, inDirectory: true, ...extra })).attendee;

test("a new browser on a guest's link: a gate with the name only; the code goes to the guest; then her page, and she isn't asked again", async () => {
  const r = rig();
  const ev = party();
  const ama = await joined(AMA_C, "Halloween Party", "pumpkin", { instagram: "ama.k" });
  const gate = await r.call(ev, { sub: "who", query: { t: ama.token } });
  assert.equal(gate.status, 200);
  assert.match(gate.body, /This page is private/);
  assert.match(gate.body, /Halloween Party/);
  assert.ok(!/Elm|ama\.k|Who's going|Oct 31/.test(gate.body), "nothing private before the code");
  assert.equal(r.texts.length, 0, "opening the link texts nobody");

  const sent = await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "send" }) });
  assert.match(sent.body, /The code from your texts/);
  assert.equal(r.texts.length, 1);
  assert.equal(r.texts[0].conversationId, AMA_C, "the code goes to the person the link belongs to");
  const code = r.codeFor(AMA_C);
  assert.ok(code);
  assert.ok(!JSON.stringify(db.db.prepare("SELECT * FROM page_codes").all()).includes(code), "the code is stored hashed, never as typed");
  assert.match(db.db.prepare("SELECT code FROM page_codes").get().code, /^sha256:/);

  const ok = await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "code", code: code.toLowerCase() }) });
  assert.equal(ok.status, 303);
  const tok = cookieOf(ok);
  assert.ok(tok);
  assert.match(ok.headers["Set-Cookie"], /Path=\/;.*HttpOnly; SameSite=Lax; Secure/);
  const page = await r.call(ev, { sub: "who", query: { t: ama.token }, cookie: `reason_page=${tok}` });
  assert.match(page.body, /Who's going/);
  assert.match(page.body, /ama\.k/);
  // A recognized browser is not asked again — on this event's other pages either.
  const home = await r.call(ev, { cookie: `reason_page=${tok}` });
  assert.match(home.body, /You're in/);
  assert.match(home.body, /12 Elm St/);
  assert.equal(r.texts.length, 1, "no second code");
  // No code in any log line.
  assert.ok(!JSON.stringify(r.logs).includes(code), "codes never reach a log");
});

test("wrong, expired and reused codes are refused; five wrong and even the right one waits", async () => {
  const r = rig();
  const ev = party();
  const ama = await joined(AMA_C);
  await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "send" }) });
  const code = r.codeFor(AMA_C);
  // Expired.
  clock.skip(16 * 60_000);
  const late = await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "code", code }) });
  assert.match(late.body, /That code isn(&#39;|')t right/);
  assert.equal(cookieOf(late), null);
  // Fresh one, used once, then reused from another browser.
  await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "send" }) });
  const c2 = r.codeFor(AMA_C);
  const first = await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "code", code: c2 }) });
  assert.ok(cookieOf(first));
  const again = await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "code", code: c2 }), ip: "198.51.100.4" });
  assert.equal(cookieOf(again), null, "a code works once");
  // Five wrong in the window: locked, and the right code is refused too until it passes.
  clock.skip(16 * 60_000);
  await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "send" }) });
  const c3 = r.codeFor(AMA_C);
  for (let i = 0; i < 5; i++) await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "code", code: "ZZZZZZ" }) });
  const locked = await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "code", code: c3 }) });
  assert.equal(locked.status, 429);
  assert.equal(cookieOf(locked), null);
  // The lock is that browser's: Ama on her own phone's browser still gets in with her code.
  const hers = await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "code", code: c3 }), ip: "198.51.100.77" });
  assert.ok(cookieOf(hers), "a stranger's wrong guesses never lock the real person out");
});

test("resends are limited: three codes per 15 minutes, then nothing more goes out until the window passes", async () => {
  const r = rig();
  const ev = party();
  const ama = await joined(AMA_C);
  const pages = [];
  for (let i = 0; i < 5; i++) pages.push(await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "send" }) }));
  assert.equal(r.texts.length, 3, "three, not five");
  // A page that sent says so; one that sent nothing never shows "Code sent ✓" (owner, 2026-10-25).
  const html = (x) => x.body ?? x;
  assert.match(html(pages[2]), /class="sent-ok"/);
  assert.doesNotMatch(html(pages[3]), /class="sent-ok"/);
  assert.match(html(pages[3]), /already texted this link/);
  // Asking to send a new one makes the old one dead: only the newest works.
  clock.skip(16 * 60_000);
  await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "send" }) });
  assert.equal(r.texts.length, 4);
});

test("a verified browser that isn't on this event sees nothing private — and a forwarded link texts its owner, not the holder", async () => {
  const r = rig();
  const ev = party({ show_location_on_join: false });
  const ama = await joined(AMA_C);
  // Yaw (on Reason, not on this event) typing his number here is texted nothing: he has no private
  // page on this event to sign in to, and joins with the password like anyone.
  const asked = await r.call(ev, { sub: "signin", method: "POST", body: form({ number: YAW }) });
  assert.match(asked.body, /If that number uses Reason/);
  assert.equal(r.codeFor(YAW_C), null, "no code for a non-member");
  // A browser verified as Yaw elsewhere (any Reason page of his).
  db.startPageSession("p-yaw", "tok-yaw-verify-0001", { conversationId: YAW_C });
  const cookie = "reason_page=tok-yaw-verify-0001";
  // The join page: the join form (password still needed), no details.
  const home = await r.call(ev, { cookie });
  assert.match(home.body, /signed in to Reason as Yaw/);
  assert.match(home.body, /Event password/);
  assert.ok(!/Elm|Who's going/.test(home.body));
  // Ama's forwarded who-link on Yaw's verified browser: the gate, and a code would go to Ama.
  const fwd = await r.call(ev, { sub: "who", query: { t: ama.token }, cookie });
  assert.match(fwd.body, /This page is private/);
  assert.ok(!/Ama|Elm/.test(fwd.body.replace(/Halloween Party/g, "")));
  await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "send" }), cookie });
  assert.equal(r.texts.at(-1).conversationId, AMA_C);
  // The organizer's link forwarded: same gate, code to the organizer.
  const orgFwd = await r.call(ev, { sub: "who", query: { t: ev.organizer_token }, cookie });
  assert.match(orgFwd.body, /This page is private/);
  assert.ok(!/Your guest list/.test(orgFwd.body));
});

test("sign in by number: a US number typed without +1, the way people type it, still finds the member", async () => {
  const r = rig();
  const ev = party();
  await joined(AMA_C);
  await r.call(ev, { sub: "signin", method: "POST", body: form({ number: "(347) 555-0000" }) });
  assert.ok(r.codeFor(AMA_C), "ten digits are her +1 number");
  // Eleven digits starting with 1, and a "+" number from elsewhere, are taken as typed.
  const r2 = rig();
  await r2.call(ev, { sub: "signin", method: "POST", body: form({ number: "1 347 555 0000" }) });
  assert.ok(r2.codeFor(AMA_C));
  const r3 = rig();
  await r3.call(ev, { sub: "signin", method: "POST", body: form({ number: "+3475550000" }) });
  assert.equal(r3.texts.length, 0, "a typed + is never rewritten");
});

test("sign in by number: a member is texted a code; a number with no account, or not on this event, gets the same words and no text", async () => {
  const r = rig();
  const ev = party();
  await joined(AMA_C);
  const stranger = await r.call(ev, { sub: "signin", method: "POST", body: form({ number: "+19175550123" }) });
  const nonMember = await r.call(ev, { sub: "signin", method: "POST", body: form({ number: YAW }) });
  const known = await r.call(ev, { sub: "signin", method: "POST", body: form({ number: AMA }) });
  const strip = (b) => b.replace(/value="[^"]*"/g, "");
  assert.equal(strip(stranger.body), strip(known.body), "the page never says which numbers use Reason");
  assert.equal(strip(nonMember.body), strip(known.body));
  assert.ok(r.codeFor(AMA_C), "the member got her code");
  // Signed in by number: her own view of the event.
  const inNow = await r.call(ev, { sub: "signin", method: "POST", body: form({ number: AMA, code: r.codeFor(AMA_C) }) });
  assert.match((await r.call(ev, { cookie: `reason_page=${cookieOf(inNow)}` })).body, /You're in/);
  assert.equal(r.texts.filter(t => t.conversationId !== AMA_C).length, 0, "nobody else is texted");
  assert.match(stranger.body, /Join as a new guest/);
  // A code typed for the unknown number is just wrong.
  const wrong = await r.call(ev, { sub: "signin", method: "POST", body: form({ number: "+19175550123", code: "ABCDEF" }) });
  assert.match(wrong.body, /That code isn(&#39;|')t right/);
  // One browser can't spray codes at numbers: ten an hour.
  for (let i = 0; i < 12; i++) await r.call(ev, { sub: "signin", method: "POST", body: form({ number: KOFI }), ip: "192.0.2.50" });
  const capped = await r.call(ev, { sub: "signin", method: "POST", body: form({ number: KOFI }), ip: "192.0.2.50" });
  assert.equal(capped.status, 429);
});

test("wrong codes typed against numbers answer the same whoever the number is — no enumeration, no lockout of the real person", async () => {
  const r = rig();
  const ev = party();
  await joined(AMA_C);
  await r.call(ev, { sub: "signin", method: "POST", body: form({ number: AMA }), ip: "198.51.100.200" });
  const amaCode = r.codeFor(AMA_C);
  const run = async (number, ip) => {
    const out = [];
    for (let i = 0; i < 6; i++) out.push((await r.call(ev, { sub: "signin", method: "POST", body: form({ number, code: "AAAAAA" }), ip })).status);
    return out;
  };
  const member = await run(AMA, "203.0.113.11");
  const nobody = await run("+19175550123", "203.0.113.12");
  const outsider = await run(YAW, "203.0.113.13");
  assert.deepEqual(member, nobody, "a real member's number and a made-up one answer alike");
  assert.deepEqual(outsider, nobody);
  assert.deepEqual(nobody, [200, 200, 200, 200, 200, 429], "only the browser's own limit is ever said");
  // Ama, from her own browser, still signs in with her real code.
  const hers = await r.call(ev, { sub: "signin", method: "POST", body: form({ number: AMA, code: amaCode }), ip: "198.51.100.200" });
  assert.ok(cookieOf(hers));
});

test("a sign-out posted from another site (no cookie sent) clears nothing", async () => {
  const r = rig();
  const ev = party();
  const out = await r.call(ev, { sub: "signout", method: "POST" });
  assert.equal(out.status, 303);
  assert.equal(out.headers["Set-Cookie"], undefined);
});

test("a removed guest loses access on her recognized browser at once; leaving does too", async () => {
  const r = rig();
  const ev = party();
  const ama = await joined(AMA_C);
  db.startPageSession("p-ama", "tok-ama-verify-0001", { conversationId: AMA_C });
  const cookie = "reason_page=tok-ama-verify-0001";
  assert.match((await r.call(ev, { sub: "who", query: { t: ama.token }, cookie })).body, /Who's going/);
  db.updateAttendeeRow(ama.id, { state: "removed", left_at: clock.now() });
  assert.equal((await r.call(ev, { sub: "who", query: { t: ama.token }, cookie })).status, 404);
  const home = await r.call(ev, { cookie });
  assert.ok(!/You're in|12 Elm/.test(home.body), "no details on the join page either");
});

test("the organizer's own pages need his browser too; a guest's verified browser never gets the organizer view", async () => {
  const r = rig();
  const ev = party();
  const ama = await joined(AMA_C);
  const cold = await r.call(ev, { sub: "who", query: { t: ev.organizer_token } });
  assert.match(cold.body, /This page is private/);
  await r.call(ev, { sub: "who", method: "POST", body: form({ t: ev.organizer_token, step: "send" }) });
  assert.equal(r.texts.at(-1).conversationId, OWNER_C);
  assert.match(r.texts.at(-1).text, /open your guest list for "Halloween Party"/);
  const ok = await r.call(ev, { sub: "who", method: "POST", body: form({ t: ev.organizer_token, step: "code", code: r.codeFor(OWNER_C) }) });
  const org = await r.call(ev, { sub: "who", query: { t: ev.organizer_token }, cookie: `reason_page=${cookieOf(ok)}` });
  assert.match(org.body, /Your guest list, with everyone/);
  // Ama, verified as herself, on the organizer's link: her own guest view.
  db.startPageSession("p-ama", "tok-ama-verify-0002", { conversationId: AMA_C });
  const asAma = await r.call(ev, { sub: "who", query: { t: ev.organizer_token }, cookie: "reason_page=tok-ama-verify-0002" });
  assert.ok(!/Your guest list, with everyone/.test(asAma.body));
  assert.match(asAma.body, /Name other guests see/);
  // And a guest's directory edit is hers alone, by session — a POST with somebody else's token edits nothing of theirs.
  assert.equal(ama.display_name, "Ama");
});

test("sign out: this browser, from the page; every browser, by text", async () => {
  const r = rig();
  const ev = party();
  const ama = await joined(AMA_C);
  db.startPageSession("p-ama", "tok-ama-out-0001", { conversationId: AMA_C });
  db.startPageSession("p-ama", "tok-ama-out-0002", { conversationId: AMA_C });
  const out = await r.call(ev, { sub: "signout", method: "POST", cookie: "reason_page=tok-ama-out-0001" });
  assert.equal(out.status, 303);
  assert.match(out.headers["Set-Cookie"], /reason_page=; Path=\/; Max-Age=0/);
  assert.match((await r.call(ev, { sub: "who", query: { t: ama.token }, cookie: "reason_page=tok-ama-out-0001" })).body, /This page is private/);
  assert.match((await r.call(ev, { sub: "who", query: { t: ama.token }, cookie: "reason_page=tok-ama-out-0002" })).body, /Who's going/, "the other browser is still hers");
  const all = await runTool("browsers_sign_out", {}, { conversationId: AMA_C, messages: [] });
  assert.equal(all.ok, true);
  assert.equal(all.signed_out, 1);
  assert.match((await r.call(ev, { sub: "who", query: { t: ama.token }, cookie: "reason_page=tok-ama-out-0002" })).body, /This page is private/);
});

test("server-side for every request: a page POST without a recognized browser changes nobody's entry", async () => {
  const r = rig();
  const ev = party();
  const ama = await joined(AMA_C, "Halloween Party", "pumpkin", { instagram: "ama.k" });
  const forged = await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, display_name: "Hacked", instagram: "evil" }) });
  assert.match(forged.body, /This page is private/);
  const row = db.attendeeRow(ev.id, AMA_C);
  assert.equal(row.display_name, "Ama");
  assert.equal(row.instagram, "ama.k");
});

test("a person's data export and delete reach their event sign-in codes, attempts and browsers", async () => {
  const r = rig();
  const ev = party();
  const ama = await joined(AMA_C);
  await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "send" }) });
  const ok = await r.call(ev, { sub: "who", method: "POST", body: form({ t: ama.token, step: "code", code: r.codeFor(AMA_C) }) });
  assert.ok(cookieOf(ok));
  const { exportData, deleteData } = await import("../src/data.js");
  const out = exportData({ conversation: AMA_C, audio: false, files: false });
  assert.ok(out.tables.page_codes.some(c => c.page_id === `esign:${AMA_C}`));
  assert.ok(out.tables.page_sessions.some(x => x.conversation_id === AMA_C));
  await deleteData({ conversation: AMA_C, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_codes WHERE page_id = ?").get(`esign:${AMA_C}`).n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions WHERE conversation_id = ?").get(AMA_C).n, 0);
});

test("two taps on \"Text me a code\" in the same millisecond: the code that arrives is the one that works", async () => {
  // An outbox that honours idempotency keys the way the real one does: a key it has seen is not sent again.
  const r = rig();
  const seen = new Set();
  const texts = [];
  const runtime = { async _tell(conversationId, text, { idempotencyKey } = {}) {
    if (seen.has(idempotencyKey)) return { ok: true, duplicate: true };
    seen.add(idempotencyKey); texts.push({ conversationId, text }); return { ok: true };
  } };
  const call = (ev, o) => eventPageRequest({
    publicId: ev.public_id, sub: "signin", method: "POST", query: {}, headers: { "x-files-domain": "true", "x-reason-caddy": "caddy-test", "x-forwarded-for": "203.0.113.7" },
    remoteAddress: "127.0.0.1", readBody: async () => o.body, runtime, log: () => {},
  });
  const ev = party();
  await joined(AMA_C);
  const realNow = clock.now;
  const t = realNow();
  clock.now = () => t;
  try {
    await call(ev, { body: form({ number: AMA }) });
    await call(ev, { body: form({ number: AMA }) });
    await new Promise(res => setImmediate(res));
  } finally { clock.now = realNow; }
  const mine = texts.filter(x => x.conversationId === AMA_C).map(x => /code is ([0-9]{6}),/.exec(x.text)?.[1]).filter(Boolean);
  assert.equal(mine.length, 2, "both codes were texted — the second is not deduped away");
  const inNow = await call(ev, { body: form({ number: AMA, code: mine.at(-1) }) });
  assert.ok(cookieOf(inNow), "the newest code texted is live");
  assert.match((await r.call(ev, { cookie: `reason_page=${cookieOf(inNow)}` })).body, /You're in/);
});
