// Reason Web, Saved (src/saved.js index, src/pages/websaved.js; v2 handoff §4, reference sheet-saved
// S-A / S-B and desk-saved). One pinned test per rule:
//
//   - S-B: nothing made yet → "Nothing saved yet." + the Caveat line; Saved is the current tab
//   - the index is what Reason really made: its pages, calls it placed to somebody else that reached
//     someone, purchases that were really placed, events it organised and their albums — nothing of
//     anybody else's, no owner call, no cart that was only shown
//   - meta lines and stamps: PAGE · YOU PICKED X, CALL · 1:42 · TUE + BOOKED, RECEIPT · day + PAID /
//     CANCELED, EVENT · SHARED WITH N
//   - THIS WEEK / EARLIER IN <MONTH> / IN <MONTH>, folded with "+ N more", opened with ?all
//   - kinds: ALL N · PAGES · CALLS · RECEIPTS · EVENTS, the current one with its count; FIND SOMETHING
//     reads titles and what the page says
//   - pin → the PINNED card; unpin; remove → hidden from Saved, the thing untouched; PUT IT BACK
//   - the opened item: PIN · OPEN THE PAGE ↗ · FIND IT IN THE CHAT → (only when the chat has it), the
//     page itself framed (same origin only), REMOVE FROM SAVED; the thread opens at that message
//   - signed out, cross-site, without the secret, or another person's key: refused
//   - the tab bar is Chat · Ongoing · Saved everywhere; the desktop top links name SAVED
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-saved-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_EVENTS_URL = "https://events.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";
delete process.env.REASON_BACKEND;

const { webRequestFor } = await import("../src/http.js");
const db = await import("../src/db.js");
const saved = await import("../src/saved.js");
const ws = await import("../src/pages/websaved.js");
const { config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const KOFI_C = "dm:fake:+14155559876";
const DAY = 86_400_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  config.web = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM page_sessions; DELETE FROM pages; DELETE FROM page_choices;
    DELETE FROM calls; DELETE FROM agentcard_purchases; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_albums; DELETE FROM event_photos;
    DELETE FROM saved_marks; DELETE FROM messages;`);
  for (const [c, a, n, op] of [[OWNER_C, "+12025551234", "Omari", true], [KOFI_C, "+14155559876", "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
});

let n = 0;
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { token, cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token) };
}
const headersFor = (b, extra = {}) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}), ...extra });
async function call({ sub = "saved", method = "GET", b = null, query = {}, body = null, headers = {} } = {}) {
  return await webRequestFor({ sub, method, query, headers: headersFor(b, headers), remoteAddress: "127.0.0.1", readBody: async () => body, runtime: null, router: null, log: () => {} });
}
const form = (o) => new URLSearchParams(o).toString();
const ago = (ms) => Date.now() - ms;

function page(conv, title, { at = Date.now(), text = "words" } = {}) {
  const p = db.createPage(conv, { title, blocks: [{ type: "text", text }] });
  db.db.prepare("UPDATE pages SET created_at = ?, updated_at = ? WHERE id = ?").run(at, at, p.id);
  return p.id;
}
function placedCall(conv, { goal = "Book a cleaning at Dr. Patel's office", isOwner = false, state = "completed", kind = "confirmed", summary = "They booked Tuesday at 10.", dur = 102, at = Date.now(), label = null } = {}) {
  const c = db.createCall(conv, { provider: "fake", toNumber: "+12125550000", isOwner, goal, facts: [] });
  db.db.prepare("UPDATE calls SET state = ?, outcome_kind = ?, outcome = 'they answered', summary = ?, duration_s = ?, created_at = ?, ended_at = ?, label = ? WHERE id = ?").run(state, kind, summary, dur, at, at + 120_000, label, c.id);
  return c.id;
}
function purchase(conv, { status = "placed", merchant = "Con Ed", cents = 8740, at = Date.now() } = {}) {
  const r = db.db.prepare(`INSERT INTO agentcard_purchases (conversation_id, buy_conversation_id, status, amount_cents, merchant, what, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'October bill', ?, ?)`).run(conv, `buy-${Math.random()}`, status, cents, merchant, at, at);
  return Number(r.lastInsertRowid);
}
function event(conv, { name = "A weekend upstate", guests = 3, at = Date.now(), status = "active" } = {}) {
  const pid = `pub${Math.random().toString(36).slice(2, 12)}`;
  const r = db.db.prepare(`INSERT INTO events (public_id, organizer_conversation_id, name, name_key, starts_at, tz, password_hash, organizer_token, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'America/New_York', 'x', ?, ?, ?, ?)`).run(pid, conv, name, name.toLowerCase(), Date.UTC(2026, 10, 14, 17), `org${Math.random()}`, status, at, at);
  const id = Number(r.lastInsertRowid);
  for (let i = 0; i < guests; i++) {
    db.db.prepare("INSERT INTO event_attendees (event_id, conversation_id, via, token, joined_at, updated_at) VALUES (?, ?, 'text', ?, ?, ?)").run(id, `dm:fake:+1555000${i}${id}`, `t${Math.random()}`, at, at);
  }
  return { id, pid };
}

// ---------------------------------------------------------------- S-B

test("S-B: nothing made yet — the empty page, Saved the current tab, no theme switch", async () => {
  const b = browser(OWNER_C);
  const out = await call({ b });
  assert.equal(out.status, 200);
  assert.match(out.body, /Nothing saved<br>yet\./);
  assert.match(out.body, /anything i make for you,<br>a list, a call, a receipt, lands here\./);
  assert.match(out.body, /<a href="\/web\/saved" aria-current="page">Saved<\/a><\/nav>/);
  assert.match(out.body, /<a href="\/web\?thread">Chat<\/a><a href="\/web\?tab=ongoing">Ongoing<\/a>/);
  assert.doesNotMatch(out.body, /class="themes"/, "the theme switch lives in Settings only");
  // Somebody else's things never fill it.
  page(KOFI_C, "Kofi's list");
  assert.match((await call({ b })).body, /Nothing saved<br>yet\./);
});

// ---------------------------------------------------------------- the index

test("the index is what Reason made for them: pages, calls to others, placed purchases, events, albums", () => {
  const pid = page(OWNER_C, "Dinner, Friday, three that fit");
  db.db.prepare("INSERT INTO page_choices (page_id, conversation_id, block_key, picked, at) VALUES (?, ?, 'c1', 'Peaches', ?)").run(pid, OWNER_C, Date.now());
  placedCall(OWNER_C, { label: "Dr. Patel's office" });
  placedCall(OWNER_C, { isOwner: true, goal: "Omari called Reason" });
  placedCall(OWNER_C, { state: "failed", kind: "failed", goal: "Call Foster" });
  purchase(OWNER_C);
  purchase(OWNER_C, { status: "cart_shown", merchant: "Target" });
  purchase(OWNER_C, { status: "awaiting_approval", merchant: "Walmart" });
  purchase(OWNER_C, { status: "cancelled", merchant: "Best Buy", cents: 1999 });
  const ev = event(OWNER_C);
  db.db.prepare("INSERT INTO event_albums (event_id, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(ev.id, OWNER_C, Date.now(), Date.now());
  page(KOFI_C, "Kofi's page");
  event(KOFI_C, { name: "Kofi's party" });

  const items = saved.savedItems(OWNER_C);
  const by = Object.fromEntries(items.map(i => [i.title, i]));
  assert.deepEqual(items.map(i => i.kind).sort(), ["album", "call", "event", "page", "receipt", "receipt"]);
  assert.equal(by["Dinner, Friday, three that fit"].meta, "PAGE · YOU PICKED PEACHES");
  assert.equal(by["Dr. Patel's office"].meta, `CALL · 1:42 · ${by["Dr. Patel's office"].day}`);
  assert.deepEqual(by["Dr. Patel's office"].stamp, { text: "BOOKED", tone: "pen" });
  assert.equal(by["Con Ed, $87.40"].meta, `RECEIPT · ${by["Con Ed, $87.40"].day}`);
  assert.deepEqual(by["Con Ed, $87.40"].stamp, { text: "PAID", tone: "pen" });
  assert.deepEqual(by["Best Buy, $19.99"].stamp, { text: "CANCELED", tone: "muted" });
  assert.equal(by["A weekend upstate"].meta, "EVENT · SHARED WITH 3");
  assert.equal(by["Photos from A weekend upstate"].meta, "ALBUM · 0 PHOTOS");
  assert.ok(!items.some(i => /Kofi|Target|Walmart|Foster|called Reason/.test(i.title)));
});

test("a call nothing titled yet reads its goal, cleaned; an unconfirmed one has no stamp", () => {
  placedCall(OWNER_C, { goal: "Ask Foster how his shift is going", kind: "answered" });
  const [c] = saved.savedItems(OWNER_C);
  assert.equal(c.title, "Ask Foster how his shift is", "six words at most until its own title is written");
  assert.equal(c.stamp, null);
});

test("time headings: THIS WEEK (the last seven days), EARLIER IN <this month>, then IN <month>", () => {
  const tz = "America/New_York";
  const now = Date.parse("2026-10-27T16:00:00Z");
  assert.deepEqual(saved.groupOf(Date.parse("2026-10-21T16:00:00Z"), now, tz).title, "THIS WEEK");
  assert.equal(saved.groupOf(Date.parse("2026-10-20T16:00:00Z"), now, tz).title, "EARLIER IN OCTOBER");
  assert.equal(saved.groupOf(Date.parse("2026-09-12T16:00:00Z"), now, tz).title, "IN SEPTEMBER");
  assert.equal(saved.groupOf(Date.parse("2025-12-12T16:00:00Z"), now, tz).title, "IN DECEMBER 2025");
  assert.equal(saved.dayWord(Date.parse("2026-10-26T16:00:00Z"), now, tz), "MON");
  assert.equal(saved.dayWord(Date.parse("2026-10-12T16:00:00Z"), now, tz), "OCT 12");
});

test("S-A list: THIS WEEK rows with meta + stamps, older groups folded to one row and '+ N more', ?all opens them", async () => {
  const b = browser(OWNER_C);
  page(OWNER_C, "Today, in five things", { at: ago(60_000) });
  placedCall(OWNER_C, { label: "Dr. Patel's office", at: ago(DAY) });
  purchase(OWNER_C, { at: ago(DAY) });
  const old = [];
  for (let i = 0; i < 4; i++) old.push(page(OWNER_C, `Old page ${i}`, { at: ago(40 * DAY + i * 60_000) }));
  const out = await call({ b });
  assert.match(out.body, /<h2 id="sv-g1" class="sv-h">THIS WEEK<\/h2>/);
  assert.match(out.body, /<span class="sv-t">Today, in five things<\/span><span class="sv-d">[A-Z]{3}<\/span><span class="sv-m">PAGE<\/span>/);
  assert.match(out.body, /<span class="sv-t">Dr\. Patel&#39;s office<\/span><span class="sv-st sv-st-pen"[^>]*>BOOKED<\/span><span class="sv-m">CALL · 1:42 · [A-Z]{3}<\/span>/);
  assert.match(out.body, />PAID<\/span><span class="sv-m">RECEIPT · [A-Z]{3}<\/span>/);
  assert.match(out.body, /<span class="ph">\+ 3 more<\/span>/);
  assert.equal((out.body.match(/Old page \d/g) ?? []).length, 1, "only the newest older row shows");
  const all = await call({ b, query: { all: "1" } });
  assert.equal((all.body.match(/class="sv-t">Old page \d/g) ?? []).length, 4);
  assert.doesNotMatch(all.body, /\+ \d+ more/);
});

test("kinds: ALL with its count, the current kind with its own, every word a link; FIND SOMETHING reads the page too", async () => {
  const b = browser(OWNER_C);
  page(OWNER_C, "Saturday dinner", { text: "Pick: I Sodi, for the lasagna." });
  page(OWNER_C, "A nice CD player");
  placedCall(OWNER_C, { label: "Dr. Patel's office" });
  const out = await call({ b });
  assert.match(out.body, /<nav class="sv-kinds" aria-label="Kinds"><a href="\/web\/saved" aria-current="true">ALL 3<\/a><a href="\/web\/saved\?kind=pages">PAGES<\/a><a href="\/web\/saved\?kind=calls">CALLS<\/a><a href="\/web\/saved\?kind=receipts">RECEIPTS<\/a><a href="\/web\/saved\?kind=events">EVENTS<\/a><\/nav>/);
  const pages = await call({ b, query: { kind: "pages" } });
  assert.match(pages.body, /aria-current="true">PAGES 2<\/a>/);
  assert.doesNotMatch(pages.body, /class="sv-t">Dr\. Patel/);
  const found = await call({ b, query: { q: "lasagna" } });
  assert.match(found.body, /class="sv-t">Saturday dinner/);
  assert.doesNotMatch(found.body, /class="sv-t">A nice CD player/);
  assert.match(found.body, /value="lasagna"/);
  const none = await call({ b, query: { q: "zebra" } });
  assert.match(none.body, /nothing saved matches that\. try fewer words\./);
  const receipts = await call({ b, query: { kind: "receipts" } });
  assert.match(receipts.body, /no receipts saved yet\./);
});

// ---------------------------------------------------------------- marks

test("pin: the PINNED card (date block, meta, serif title), out of the time groups; unpin puts it back", async () => {
  const b = browser(OWNER_C);
  const ev = event(OWNER_C);
  page(OWNER_C, "Dinner list");
  const key = `event-${ev.id}`;
  const out = await call({ sub: "saved/pin", method: "POST", b, body: form({ c: b.csrf, k: key, on: "1", back: `/web/saved/event/${ev.id}` }) });
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, `/web/saved/event/${ev.id}`);
  const list = await call({ b });
  assert.match(list.body, /<h2 id="sv-pinned" class="sv-h pen">PINNED<\/h2>/);
  assert.match(list.body, /<span class="sv-date" aria-hidden="true"><span>NOV<\/span><span>14<\/span><\/span><span class="sv-pt"><span class="sv-pm">EVENT · SHARED WITH 3<\/span><span class="sv-ptt">A weekend upstate<\/span>/);
  assert.doesNotMatch(list.body, /class="sv-t">A weekend upstate/, "a pinned item is not repeated in its time group");
  const opened = await call({ sub: `saved/event/${ev.id}`, b });
  assert.match(opened.body, /aria-pressed="true">UNPIN<\/button>/);
  await call({ sub: "saved/pin", method: "POST", b, body: form({ c: b.csrf, k: key, on: "0" }) });
  assert.doesNotMatch((await call({ b })).body, /PINNED/);
});

test("remove from Saved hides it and nothing else; PUT IT BACK restores it", async () => {
  const b = browser(OWNER_C);
  const pid = page(OWNER_C, "What you're paying for");
  const out = await call({ sub: "saved/remove", method: "POST", b, body: form({ c: b.csrf, k: `page-${pid}` }) });
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, `/web/saved?removed=page-${pid}`);
  assert.ok(db.getPage(pid), "the page itself is untouched");
  const after = await call({ b, query: { removed: `page-${pid}` } });
  assert.match(after.body, /taken out of saved\. the page itself is still there\./);
  assert.match(after.body, /role="status"/);
  assert.match(after.body, /action="\/web\/saved\/restore".*name="k" value="page-[^"]+".*PUT IT BACK/s);
  assert.equal(saved.savedItems(OWNER_C).length, 0);
  assert.equal((await call({ sub: `saved/page/${pid}`, b })).status, 404, "a removed item has no Saved page");
  const back = await call({ sub: "saved/restore", method: "POST", b, body: form({ c: b.csrf, k: `page-${pid}` }) });
  assert.equal(back.headers.Location, `/web/saved/page/${pid}`);
  assert.equal(saved.savedItems(OWNER_C).length, 1);
});

test("marks are refused cross-site, without the secret, signed out, or on another person's item", async () => {
  const b = browser(OWNER_C);
  const kofi = page(KOFI_C, "Kofi's");
  const mine = page(OWNER_C, "Mine");
  assert.equal((await call({ sub: "saved/pin", method: "POST", b, body: form({ c: "nope", k: `page-${mine}`, on: "1" }) })).status, 403);
  assert.equal((await call({ sub: "saved/pin", method: "POST", b, body: form({ c: b.csrf, k: `page-${mine}`, on: "1" }), headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await call({ sub: "saved/remove", method: "POST", b, body: form({ c: b.csrf, k: `page-${kofi}` }) })).status, 404);
  assert.equal((await call({ sub: `saved/page/${kofi}`, b })).status, 404);
  assert.equal((await call({ sub: `saved/page/${kofi}/frame`, b })).status, 404);
  const out = await call({ sub: "saved" });
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, "/web");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM saved_marks").get().n, 0);
});

// ---------------------------------------------------------------- the opened item

test("the opened page: typed line, PIN · OPEN THE PAGE ↗ · FIND IT IN THE CHAT →, the page itself framed, REMOVE FROM SAVED", async () => {
  const b = browser(OWNER_C);
  const pid = page(OWNER_C, "Dinner, Friday, three that fit", { text: "Peaches is closest to everyone." });
  db.db.prepare("INSERT INTO page_choices (page_id, conversation_id, block_key, picked, at) VALUES (?, ?, 'c1', 'Peaches', ?)").run(pid, OWNER_C, Date.now());
  const out = await call({ sub: `saved/page/${pid}`, b });
  assert.equal(out.status, 200);
  assert.match(out.headers["Content-Security-Policy"], /frame-src 'self'; frame-ancestors 'none'/);
  assert.match(out.body, /<main class="sv-wrap sv-has-open">/);
  assert.match(out.body, /<span class="op-what">PAGE · MADE [A-Z]{3} \d{1,2}:\d\d [AP]M · YOU PICKED PEACHES<\/span>/);
  assert.match(out.body, />PIN<\/button>/);
  assert.match(out.body, new RegExp(`<a class="op-a" href="https://files\\.heyreason\\.test/${pid}" target="_blank" rel="noopener">OPEN THE PAGE ↗</a>`));
  assert.doesNotMatch(out.body, /FIND IT IN THE CHAT/, "no chat line carries it yet, so there is nowhere to point");
  assert.match(out.body, new RegExp(`<iframe class="op-frame" src="/web/saved/page/${pid}/frame"`));
  assert.match(out.body, /want this again next time\? just ask me for it in the chat\./);
  assert.match(out.body, /<button class="op-rm" type="submit">REMOVE FROM SAVED<\/button>/);
  assert.match(out.body, /aria-current="true"><span class="sv-t">Dinner, Friday/, "its row is marked in the list");
  assert.match(out.body, /<a class="act2 sv-back" href="\/web\/saved">← SAVED<\/a>/);

  db.writeMessage({ conversationId: OWNER_C, role: "user", channel: "fake", text: "find me dinner" });
  const msg = db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "fake", text: `Three that fit: https://files.heyreason.test/${pid}?k=x` });
  const id = typeof msg === "object" ? msg.id : msg;
  const again = await call({ sub: `saved/page/${pid}`, b });
  assert.match(again.body, new RegExp(`<a class="op-a" href="/web\\?thread&amp;at=${id}#m-${id}">FIND IT IN THE CHAT →</a>`));

  const frame = await call({ sub: `saved/page/${pid}/frame`, b });
  assert.equal(frame.status, 200);
  assert.equal(frame.headers["Content-Security-Policy"], "frame-ancestors 'self'");
  assert.equal(frame.headers["X-Frame-Options"], "SAMEORIGIN");
  assert.match(frame.body, /<base target="_top">/);
  assert.match(frame.body, /Peaches is closest to everyone\./);
});

test("FIND IT IN THE CHAT opens the thread at that message; another person's message id is ignored", async () => {
  const b = browser(OWNER_C);
  db.markWebNoticeSeen(OWNER_C);
  for (let i = 0; i < 60; i++) db.writeMessage({ conversationId: OWNER_C, role: i % 2 ? "assistant" : "user", channel: "fake", text: `line ${i}`, at: ago((60 - i) * 60_000) });
  const target = db.db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND text = 'line 5'").get(OWNER_C).id;
  const out = await call({ sub: null, b, query: { thread: "", at: String(target) } });
  assert.match(out.body, new RegExp(`<li class="msg [a-z]+" id="m-${target}"`));
  assert.match(out.body, new RegExp(`getElementById\\('m-${target}'\\)`));
  assert.doesNotMatch(out.body, /line 59/, "the newest lines come in after it, not instead of it");
  db.writeMessage({ conversationId: KOFI_C, role: "user", channel: "fake", text: "kofi secret" });
  const kofi = db.db.prepare("SELECT id FROM messages WHERE conversation_id = ?").get(KOFI_C).id;
  const other = await call({ sub: null, b, query: { thread: "", at: String(kofi) } });
  assert.doesNotMatch(other.body, /kofi secret/);
  assert.match(other.body, /line 59/);
});

test("the opened call, receipt and event draw what their rows hold; desktop opens the pinned or newest by itself", async () => {
  const b = browser(OWNER_C);
  const cid = placedCall(OWNER_C, { label: "Dr. Patel's office", summary: "They booked a cleaning for Tuesday at 10." });
  const call_ = await call({ sub: `saved/call/${cid}`, b });
  assert.match(call_.body, /<h2 class="op-h">Dr\. Patel&#39;s office<\/h2><span class="stamp stamp-pen">BOOKED<\/span>/);
  assert.match(call_.body, /1 MIN 42 SEC/);
  assert.match(call_.body, /WHAT HAPPENED.*They booked a cleaning for Tuesday at 10\./s);
  assert.doesNotMatch(call_.body, /OPEN THE PAGE/, "a call has no page of its own");
  const rid = purchase(OWNER_C);
  const rec = await call({ sub: `saved/receipt/${rid}`, b });
  assert.match(rec.body, /<span class="stamp stamp-pen">PAID<\/span>/);
  assert.match(rec.body, /TOTAL<\/span><span class="op-v">\$87\.40/);
  const ev = event(OWNER_C, { name: "Game Night" });
  const evp = await call({ sub: `saved/event/${ev.id}`, b });
  assert.match(evp.body, new RegExp(`href="https://events\\.heyreason\\.test/e/${ev.pid}"[^>]*>OPEN THE PAGE ↗`));
  assert.match(evp.body, /GUESTS<\/span><span class="op-v">3/);
  const list = await call({ b });
  assert.match(list.body, /<section class="sv-open auto" aria-label="Opened">/, "the list opens the newest for a desktop, hidden on a phone");
  assert.match(list.body, /<main class="sv-wrap">/);
});

// ---------------------------------------------------------------- the rest of Web

test("the tab bar is Chat · Ongoing · Saved on the chat and Ongoing; desktop top links name SAVED", async () => {
  const b = browser(OWNER_C);
  db.markWebNoticeSeen(OWNER_C);
  const chat = await call({ sub: null, b, query: { thread: "" } });
  assert.match(chat.body, /<nav class="tabs" aria-label="Sections"><a href="\/web\?thread" aria-current="page">Chat<\/a><a href="\/web\?tab=ongoing">Ongoing<\/a><a href="\/web\/saved">Saved<\/a><\/nav>/);
  assert.match(chat.body, /<nav aria-label="Account"><a class="act2" href="\/web\/saved">SAVED<\/a><a class="act2" href="\/web\/memory">MEMORY<\/a>/);
  const og = await call({ sub: null, b, query: { tab: "ongoing" } });
  assert.match(og.body, /<a href="\/web\?tab=ongoing" aria-current="page">Ongoing<\/a><a href="\/web\/saved">Saved<\/a>/);
  page(OWNER_C, "One");
  const sv = await call({ b });
  assert.match(sv.body, /<nav aria-label="Account"><a href="\/web\?thread">CHAT<\/a><a href="\/web\/saved" aria-current="page">SAVED<\/a><a href="\/web\/memory">MEMORY<\/a><a href="\/web\/settings">SETTINGS<\/a><\/nav>/);
});

test("Saved rows and actions meet the 44px floor and the kit's focus ring; reduced motion is the kit's", () => {
  const css = ws.renderSaved({ account: { conversation_id: OWNER_C, name: "Omari" }, csrf: "x" });
  assert.match(css, /\.op-a\{min-height:44px/);
  assert.match(css, /\.op-rm\{align-self:flex-start;min-height:44px/);
  assert.match(css, /\.sv-find input\{height:44px/);
  assert.match(css, /\.tabs a\{min-width:96px;min-height:48px/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});
