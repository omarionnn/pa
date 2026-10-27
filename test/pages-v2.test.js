// Pages Reason makes, v2 (handoff 2026-10-27 §4; reference sheet-pages, sheet-pages-desk, sheet-edge,
// preview-private, preview-event). HELD behind REASON_PAGES_V2. One pinned test per rule:
//
//   - off: the new blocks are refused, nothing draws differently, the gate keeps the page's own card
//   - P1 shortlist from cards + their choice: pick first, facts as leaders, the Caveat opinion, the
//     desk margin note; a pick posts with no script and comes back "SENT TO REASON"
//   - P2 the day: a fixed stamp list; links; TOMORROW
//   - P3 a call: only this conversation's calls; length + "RECORDED, AND THEY KNEW" and the first
//     point (it said it was an assistant) read off the row; the recording only to its owner
//   - P6 a receipt: only a purchase that went through; card, approval time, confirmation; PAID
//   - E3: a browser signed in as somebody else sees only its own masked number — the same for a real
//     page and an id that never existed; the owner's key still gets the gate; sign out clears it
//   - E4: the owner of an archived page is pointed to Saved; anybody else sees the gate as before
//   - LP2: every private page previews as the one generic card and title, never its own
//   - E2: a cancelled event's link is turned off; P4 shows only what the organizer made public
//   - LP3: the event's own card carries only public facts
//   - K1/K2: no command phrase, no "private by default" line
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pages-v2-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025550142";
process.env.REASON_OWNER_NUMBER = "+12025550142";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "owner";
process.env.REASON_EVENTS = "on";
process.env.REASON_RECORDING_ROOT = join(dir, "rec");
delete process.env.REASON_PAGES_V2;
delete process.env.REASON_BACKEND;

const db = await import("../src/db.js");
const events = await import("../src/events.js");
const { config } = await import("../src/config.js");
const { pageRequest, eventRequestFor, privateOgRequest } = await import("../src/http.js");
const { checkContent } = await import("../src/pages/content.js");
const { madeKind } = await import("../src/pages/madedata.js");
const { v2Card } = await import("../src/eventcover.js");
const { runTool } = await import("../src/tools.js");

const OWNER = "dm:owner";
const KOFI = "dm:fake:+14155559876";
after(() => rmSync(dir, { recursive: true, force: true }));
before(() => {
  db.upsertAccount({ conversationId: OWNER, channel: "fake", address: "+12025550142", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI, channel: "fake", address: "+14155559876", name: "Kofi" });
});
const on = () => { config.pagesV2 = true; };
const off = () => { config.pagesV2 = false; };

const CARDS = [
  { type: "cards", items: [
    { title: "Peaches", facts: [{ label: "Open", value: "7:30 PM" }, { label: "Per person", value: "$$" }], pick: true, opinion: "closest to everyone.", at: "7:30 PM" },
    { title: "Olmsted", note: "Quieter, a longer ride for two of you.", at: "8:15 PM" },
    { title: "Lilia", note: "Best food, latest table.", at: "9:00 PM" },
  ] },
  { type: "choice", key: "dinner", question: "Which one?", options: [{ label: "Peaches" }, { label: "Olmsted" }, { label: "Lilia" }] },
];
let tokens = 0;
const sessionFor = (c, pageId) => { const t = `tok${++tokens}`; db.startPageSession(pageId, t, { conversationId: c }); return t; };
const get = (id, { cookie = "", key = null, sub = null } = {}) => pageRequest({ id, sub, key, method: "GET", headers: { cookie: cookie ? `reason_page=${cookie}` : "" }, readBody: async () => "" });
const words = (html) => String(html).replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<script>[\s\S]*?<\/script>/g, "");
const NO_COMMANDS = (html) => {
  assert.doesNotMatch(html, /reply\s*["“]/i, "never a phrase to type");
  assert.doesNotMatch(html, /private by default|sensitive details stay behind/i, "K2");
};

test("off: the designed blocks are refused, a shortlist draws as before, the gate keeps the page's own card", async () => {
  off();
  assert.equal(checkContent([{ type: "day", items: [{ title: "x" }] }]).ok, false);
  const p = db.createPage(OWNER, { title: "Dinner, Friday, three that fit.", blocks: checkContent(CARDS).blocks });
  assert.equal(madeKind(p), null);
  const t = sessionFor(OWNER, p.id);
  const out = await get(p.id, { cookie: t });
  assert.equal(out.status, 200);
  assert.doesNotMatch(out.body, /Pick this one/);
  const gate = await get(p.id, { key: p.owner_key });
  assert.match(gate.body, /og:title" content="Dinner, Friday, three that fit\."/);
});

test("P1: a shortlist draws as the design, with the pick first and Reason's line beside it", async () => {
  on();
  const checked = checkContent([{ ...CARDS[0], items: [CARDS[0].items[1], CARDS[0].items[0], CARDS[0].items[2]] }, CARDS[1]]);
  assert.equal(checked.ok, true, checked.error);
  const p = db.createPage(OWNER, { title: "Dinner, Friday, three that fit.", blocks: checked.blocks, subtitle: "Brooklyn · 4 people · Fri 7–9 pm" });
  assert.equal(madeKind(p), "shortlist");
  const t = sessionFor(OWNER, p.id);
  const out = await get(p.id, { cookie: t });
  const html = words(out.body);
  assert.equal(out.status, 200);
  assert.match(html, /MADE FOR YOU · [A-Z]{3} \d{1,2}:\d{2} [AP]M/);
  assert.match(html, /Dinner, Friday,<br class="m"> <em>three that fit\.<\/em>/);
  assert.match(html, /BROOKLYN · 4 PEOPLE · FRI 7–9 PM/);
  assert.match(html, /<span class="num">01<\/span><h2>Peaches<\/h2>/, "the pick is 01");
  assert.match(html, /<dt>OPEN<\/dt><span class="dots" aria-hidden="true"><\/span><dd>7:30 PM<\/dd>/);
  assert.match(html, /closest to everyone\. my pick\./);
  assert.match(html, /01 is my pick\. closest to everyone\./);
  assert.match(html, /Picking one sends that reply to Reason\. Nothing is booked until you say so\./);
  assert.match(html, /NOTHING BOOKED YET/);
  assert.match(html, /Only you can see this page\. Reply to Reason to change anything\./);
  assert.match(html, /<form class="inline" method="POST" action="[^"]+\/choice"/);
  NO_COMMANDS(html);

  // No script: the form posts and the page comes back with the pick.
  const pick = await pageRequest({ id: p.id, sub: "choice", method: "POST", headers: { cookie: `reason_page=${t}`, "content-type": "application/x-www-form-urlencoded" }, readBody: async () => "key=dinner&label=Olmsted" });
  assert.equal(pick.status, 303);
  assert.equal(pick.headers.Location, `../${p.id}`);
  assert.equal(db.pageChoicesFor(p.id).dinner, "Olmsted");
  assert.match((await get(p.id, { cookie: t })).body, /SENT TO REASON/);
  // A stranger's form post is refused like a stranger's JSON one.
  const stranger = await pageRequest({ id: p.id, sub: "choice", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, readBody: async () => "key=dinner&label=Lilia" });
  assert.equal(stranger.status, 403);
});

test("cards: one pick only; facts are short label/value pairs", () => {
  on();
  assert.equal(checkContent([{ type: "cards", items: [{ title: "a", pick: true }, { title: "b", pick: true }] }]).ok, false);
  assert.equal(checkContent([{ type: "cards", items: [{ title: "a", facts: [{ label: "x" }] }] }]).ok, false);
});

test("P2: the day — a fixed stamp list, a link per line, TOMORROW", async () => {
  on();
  assert.equal(checkContent([{ type: "day", items: [{ title: "x", stamp: "great" }] }]).ok, false);
  assert.equal(checkContent([{ type: "day", items: [{ title: "x" }] }, { type: "text", text: "y" }]).ok, false, "the day is the whole page");
  const checked = checkContent([{ type: "day", note: "a good one.", tomorrow: "Nothing open. I'll check your flight at 6.", items: [
    { at: "7:00", title: "Flight moved, car pushed", detail: "8:40 from gate B12, pickup 6:30", stamp: "done" },
    { at: "5:30", title: "Con Ed paid, $87.40", stamp: "paid", link: { label: "Receipt", url: "https://files.heyreason.test/abc" } },
  ] }]);
  assert.equal(checked.ok, true, checked.error);
  const p = db.createPage(OWNER, { title: "Today, in five things.", blocks: checked.blocks });
  const html = words((await get(p.id, { cookie: sessionFor(OWNER, p.id) })).body);
  assert.match(html, /<span class="tm">7:00<\/span>/);
  assert.match(html, />DONE<\/span>/);
  assert.match(html, />PAID<\/span>/);
  assert.match(html, /<a class="wd" href="https:\/\/files\.heyreason\.test\/abc">Receipt →<\/a>/);
  assert.match(html, /TOMORROW/);
  assert.match(html, /a good one\./);
});

test("P3: a call page — only this conversation's calls, facts off the row, the recording only to its owner", async () => {
  on();
  const call = db.createCall(OWNER, { provider: "fake", toNumber: "+17185550188", isOwner: false, goal: "dentist", announcement: "Hi, I'm an AI assistant calling for Omari. This call is recorded." });
  mkdirSync(join(dir, "rec"), { recursive: true });
  const wav = join(dir, "rec", "c.wav");
  writeFileSync(wav, Buffer.from("RIFF0000WAVEfmt "));
  db.db.prepare(`UPDATE calls SET outcome_kind = 'confirmed', duration_s = 102, recording_state = 'stored', recording_file = ?, recording_format = 'wav', recording_seconds = 102,
    transcript = 'Reason: Hi.\nThem: Dr. Patel''s office.' WHERE id = ?`).run(wav, call.id);
  const kofis = db.createCall(KOFI, { provider: "fake", toNumber: "+17185550100", isOwner: false, goal: "x" });

  const ownerTool = await runTool("page_create", { title: "Kofi's call", blocks: [{ type: "call", call_id: kofis.id }] }, { conversationId: OWNER, messages: [] });
  assert.equal(ownerTool.ok, false, "never somebody else's call");

  const made = await runTool("page_create", { title: "Dr. Patel's office", blocks: [{ type: "call", call_id: call.id, worth_knowing: "bring your new insurance card." }] }, { conversationId: OWNER, messages: [] });
  assert.equal(made.ok, true, made.error);
  const p = db.getPage(made.page_id ?? made.id);
  const t = sessionFor(OWNER, p.id);
  const html = words((await get(p.id, { cookie: t })).body);
  assert.match(html, /CALL · [A-Z]{3} /);
  assert.match(html, />BOOKED</);
  assert.match(html, /1 MIN 42 SEC · RECORDED, AND THEY KNEW/);
  assert.match(html, /<span class="num">01<\/span><span>Said I was an assistant calling for you, and that the call was recorded\.<\/span>/);
  assert.match(html, /WORTH KNOWING/);
  assert.match(html, /READ THE TRANSCRIPT ↓/);
  assert.match(html, /aria-label="Play the call, 1 minute 42 seconds"/);

  const audio = await get(p.id, { cookie: t, sub: "audio" });
  assert.equal(audio.status, 200);
  assert.equal(audio.headers["Content-Type"], "audio/wav");
  const part = await pageRequest({ id: p.id, sub: "audio", method: "GET", headers: { cookie: `reason_page=${t}`, range: "bytes=0-3" }, readBody: async () => "" });
  assert.equal(part.status, 206);
  assert.equal(String(part.body), "RIFF");
  assert.equal((await get(p.id, { sub: "audio" })).status, 404, "a stranger gets nothing");
  assert.equal((await get(p.id, { cookie: sessionFor(KOFI, "zzzzzzzz"), sub: "audio" })).status, 404);
});

test("P6: a receipt only for a purchase that went through, with the card, the yes and the confirmation", async () => {
  on();
  const conf = db.askConfirmation({ conversationId: OWNER, action: "agentcard_buy", summary: "Pay Con Ed", stakes: "money", askedAfterMsgs: 0 });
  db.grantConfirmation(conf.id, "yes");
  db.recordAgentcardPurchase({ conversationId: OWNER, buyConversationId: "b1", status: "placed", amountCents: 8740, merchant: "Con Edison", what: "October bill" });
  db.markAgentcardPurchase("b1", { retailerOrderId: "CE-48213907", confirmationId: conf.id });
  db.recordAgentcardPurchase({ conversationId: OWNER, buyConversationId: "b2", status: "declined", amountCents: 100, merchant: "X", what: "y" });
  db.db.prepare("INSERT INTO agentcard_users (conversation_id, user_id, card_last4, created_at, updated_at) VALUES (?, 'u1', '4417', 0, 0)").run(OWNER);
  const placed = db.getAgentcardPurchase("b1");
  const declined = db.getAgentcardPurchase("b2");

  assert.equal((await runTool("page_create", { title: "x", blocks: [{ type: "receipt", purchase_id: declined.id }] }, { conversationId: OWNER, messages: [] })).ok, false);
  assert.equal((await runTool("page_create", { title: "x", blocks: [{ type: "receipt", purchase_id: placed.id }] }, { conversationId: KOFI, messages: [] })).ok, false);
  const made = await runTool("page_create", { title: "Con Ed, paid.", blocks: [{ type: "receipt", purchase_id: placed.id, note: "due friday, paid tuesday. you're good." }] }, { conversationId: OWNER, messages: [] });
  assert.equal(made.ok, true, made.error);
  const p = db.getPage(made.page_id ?? made.id);
  const html = words((await get(p.id, { cookie: sessionFor(OWNER, p.id) })).body);
  assert.match(html, /<dt>TO<\/dt>.*?<dd>CON EDISON<\/dd>/);
  assert.match(html, /<dd>•••• 4417<\/dd>/);
  assert.match(html, /<dt>APPROVED<\/dt><span class="dots" aria-hidden="true"><\/span><dd>[A-Z]{3} \d{1,2}:\d{2} [AP]M<\/dd>/);
  assert.match(html, /<dd>CE-48213907<\/dd>/);
  assert.match(html, /\$87\.40/);
  assert.match(html, /class="paid">PAID</);
  assert.match(html, /SAVE AS PDF/);
  assert.match(html, /href="https:\/\/heyreason\.test\/web">SEE IT IN THE CHAT →/, "the owner has Web");
  assert.doesNotMatch(html, /FACE ID/, "never claims how the yes was given");
  db.markAgentcardPurchase("b1", { status: "cancelled" });
  assert.doesNotMatch((await get(p.id, { cookie: sessionFor(OWNER, p.id) })).body, /class="paid"/, "a purchase undone since is no receipt");
});

test("E3: signed in as somebody else — only your own masked number, the same for a ghost id; sign out clears it", async () => {
  on();
  const p = db.createPage(OWNER, { title: "Secret plans", blocks: checkContent(CARDS).blocks });
  const kofiPage = db.createPage(KOFI, { title: "Kofi's", blocks: [{ type: "text", text: "k" }] });
  const kt = sessionFor(KOFI, kofiPage.id);
  const real = await get(p.id, { cookie: kt });
  const ghost = await get("doesnotexist12", { cookie: kt });
  assert.equal(real.status, 403);
  assert.equal(ghost.status, 403);
  assert.equal(words(real.body).replace(/[A-Za-z0-9_-]+\/signout/, "X"), words(ghost.body).replace(/[A-Za-z0-9_-]+\/signout/, "X"));
  assert.match(real.body, /This page is <em>for someone else\.<\/em>/);
  assert.match(real.body, /You’re signed in as ••• ••• 9876\./);
  assert.doesNotMatch(real.body, /Secret plans|Omari|0142/);
  assert.doesNotMatch(real.body, /Back to my thread/, "Kofi has no Web yet: no link to nowhere");
  // The owner's own link on that browser: the gate, as ever.
  assert.equal((await get(p.id, { cookie: kt, key: p.owner_key })).status, 401);
  const out = await pageRequest({ id: p.id, sub: "signout", method: "POST", headers: { cookie: `reason_page=${kt}` }, readBody: async () => "" });
  assert.equal(out.status, 303);
  const cleared = [].concat(out.headers["Set-Cookie"]).join("\n");
  assert.match(cleared, /Path=\/p\//);
  assert.match(cleared, /Path=\/;|Path=\/$/m);
  assert.equal(db.pageSessionOwner(kt, 1e12), null);
});

test("E4: an archived page tells its owner where it went; a stranger sees exactly the gate", async () => {
  on();
  const p = db.createPage(OWNER, { title: "Dinner, Friday, three that fit.", blocks: checkContent(CARDS).blocks });
  const t = sessionFor(OWNER, p.id);
  assert.equal(db.archivePage(OWNER, p.id), true);
  assert.equal(db.archivePage(KOFI, p.id), false, "only its owner's");
  const mine = await get(p.id, { cookie: t });
  assert.equal(mine.status, 200);
  assert.match(mine.body, /This one’s <em>been put away\.<\/em>/);
  assert.match(mine.body, /This link was for “Dinner, Friday, three that fit\.”/);
  assert.match(mine.body, /href="https:\/\/heyreason\.test\/web\/saved">Find it in Saved →/);
  const stranger = await get(p.id);
  const ghost = await get("nosuchpage123");
  assert.equal(stranger.status, 401);
  assert.equal(stranger.body, ghost.body);
  db.restorePage(OWNER, p.id);
  assert.match((await get(p.id, { cookie: t })).body, /Pick this one/);
});

test("LP2: every private page previews as the one generic card, never its own title", async () => {
  on();
  const p = db.createPage(OWNER, { title: "Your custody schedule", blocks: [{ type: "text", text: "x" }] });
  const gate = await get(p.id, { key: p.owner_key });
  assert.match(gate.body, /og:title" content="A page Reason made for you"/);
  assert.match(gate.body, /og:image" content="https:\/\/files\.heyreason\.test\/og\/private\.png\?v=1"/);
  assert.doesNotMatch(gate.body, /custody/i);
  const open = await get(p.id, { cookie: sessionFor(OWNER, p.id) });
  assert.match(open.body, /og:title" content="A page Reason made for you"/);
  const og = await privateOgRequest({ shoot: async (html) => { assert.match(html, /Open it to see\./); assert.doesNotMatch(html, /custody/); return Buffer.from("PNG"); } });
  assert.equal(og.status, 200);
  assert.equal(og.headers["Content-Type"], "image/png");
});

test("E2 + P4 + LP3: a cancelled event is turned off; the page and its card show only what is public", async () => {
  on();
  config.events = true;
  const made = events.create(OWNER, { name: "A weekend upstate", description: "Two nights.", starts_at: "2026-11-14T16:00", location: "Farmhouse Inn, Hudson",
    password: "woodstove", show_time_on_join: false, show_location_on_join: false, guest_list_visible: true, timezone: "America/New_York" });
  assert.equal(made.ok, true, JSON.stringify(made));
  const ev = db.getEventRow(made.event.id);
  const req = (sub = null, cookie = "") => eventRequestFor({ publicId: ev.public_id, sub, method: "GET", query: {}, headers: { cookie: cookie ? `reason_page=${cookie}` : "" }, remoteAddress: "127.0.0.1", readBody: async () => "" });
  const pub = await req();
  assert.equal(pub.status, 200);
  assert.match(pub.body, /ARE YOU IN\?/);
  assert.match(pub.body, /I'm in →/);
  assert.doesNotMatch(pub.body, /Farmhouse|NOV|4:00/, "nothing the organizer kept back");
  assert.doesNotMatch(pub.body, /Omari|Hosted by/, "never anybody's name before joining");
  assert.match(pub.body, /Anyone with this link can see it\. Made with Reason\./);
  const card = v2Card(ev);
  assert.doesNotMatch(card.key, /Farmhouse|"NOV"/);
  db.db.prepare("UPDATE events SET time_public = 1, location_public = 1, time_released = 1, location_released = 1 WHERE id = ?").run(ev.id);
  const pub2 = db.getEventRow(ev.id);
  assert.match(v2Card(pub2).key, /Farmhouse/);
  assert.match(v2Card(pub2).html(), /NOV/);
  // A guest: who's coming and the calendar file; a stranger gets no calendar.
  const j = await events.joinExisting({ conversationId: KOFI, name: "A weekend upstate", password: "woodstove", displayName: "Kofi" });
  assert.equal(j.ok, true, JSON.stringify(j));
  const kt = sessionFor(KOFI, "kofipagex1");
  const guest = await req(null, kt);
  assert.match(guest.body, /You're in\./);
  assert.match(guest.body, /COMING/);
  const ics = await req("calendar.ics", kt);
  assert.equal(ics.status, 200);
  assert.match(ics.body, /BEGIN:VEVENT[\s\S]*SUMMARY:A weekend upstate/);
  assert.equal((await req("calendar.ics")).status, 404);
  off();
  assert.equal((await req("calendar.ics", kt)).status, 404, "flag off: no calendar route");
  on();
  db.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(ev.id);
  const offPage = await req();
  assert.equal(offPage.status, 410);
  assert.match(offPage.body, /This link’s been <em>turned off\.<\/em>/);
  assert.match(offPage.body, /nothing on your side went wrong\./);
  assert.doesNotMatch(offPage.body, /weekend upstate/);
  NO_COMMANDS(offPage.body);
});

test("P5 + E2: the album as the design for a checked-in guest; a closed album's link is turned off", async () => {
  on();
  config.events = true;
  config.eventAlbums = true;
  const albums = await import("../src/albums.js");
  const made = events.create(OWNER, { name: "Hudson, November", description: "x", starts_at: "2026-11-14T16:00", location: "Hudson",
    password: "woodstove2", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true, timezone: "America/New_York" });
  const ev = db.getEventRow(made.event.id);
  const j = await events.joinExisting({ conversationId: KOFI, name: "Hudson, November", password: "woodstove2", displayName: "Kofi" });
  assert.equal(j.ok, true, JSON.stringify(j));
  const album = db.ensureAlbum(ev.id, OWNER);
  for (let i = 0; i < 6; i++) db.insertPhoto({ albumId: album.id, eventId: ev.id, conversationId: i < 3 ? KOFI : OWNER, file: `p${i}.jpg`, mediaType: "image/jpeg", bytes: 10, sha256: `s${i}` });
  db.releaseAlbum(album.id, { releasedAt: Date.now(), expiresAt: Date.now() + 86400_000 });
  await albums.checkIn({ runtime: { async _tell() { return { ok: true }; } }, ev, conversationId: OWNER, guestId: db.attendeeRow(ev.id, KOFI).id, present: true });
  const kt = sessionFor(KOFI, "kofipagex2");
  const req = (query = {}) => eventRequestFor({ publicId: ev.public_id, sub: "album", method: "GET", query, headers: { cookie: `reason_page=${kt}` }, remoteAddress: "127.0.0.1", readBody: async () => "" });
  const html = words((await req()).body);
  assert.match(html, /6 PHOTOS · 2 OF YOU/);
  assert.match(html, /6 PHOTOS · FROM 2 OF YOU/);
  assert.match(html, /SENT IN BY 2 PEOPLE/);
  assert.match(html, /See all 6 →/);
  assert.match(html, /DOWNLOAD ALL/);
  assert.match(html, /Text Reason a photo to add it\./);
  assert.match(html, /<figcaption>yours<\/figcaption>/);
  assert.match(html, /<figcaption>from Omari’s phone<\/figcaption>|<figcaption>from [^<]+’s phone<\/figcaption>/);
  assert.match(html, /Shared with the 1 person at this event\. Made with Reason\./);
  const all = words((await req({ all: "1" })).body);
  assert.equal((all.match(/<figure/g) ?? []).length, 6);
  assert.equal((all.match(/>REMOVE</g) ?? []).length, 3, "only your own photos can be taken out");
  db.db.prepare("UPDATE event_albums SET closed_at = ? WHERE id = ?").run(Date.now(), album.id);
  assert.match((await req()).body, /This link’s been <em>turned off\.<\/em>/);
});

test("pages v2 wordmark: a hidden o where the bubble stands for it, so the text reads reason", async () => {
  const { wordmark } = await import("../src/pages/made.js");
  const html = wordmark();
  const text = html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "");
  assert.equal(text, "reason");
  assert.match(html, /clip-path:inset\(50%\)[^>]*>o<\/span>n<\/span>$/);
});

test("LP2 private card: a burst of previews draws it once, and a failed draw rests before trying again", async () => {
  const { privateOgPng } = await import("../src/pages/madedata.js");
  const { readdirSync, rmSync, existsSync } = await import("node:fs");
  const cards = join(process.env.REASON_DATA_DIR, "cards");
  if (existsSync(cards)) for (const f of readdirSync(cards)) if (f.startsWith("private-og-")) rmSync(join(cards, f));
  let shots = 0;
  const slowFail = () => new Promise(r => setTimeout(() => { shots++; r(null); }, 20));
  const out = await Promise.all([1, 2, 3, 4, 5].map(() => privateOgPng({ shoot: slowFail })));
  assert.deepEqual(out, [null, null, null, null, null]);
  assert.equal(shots, 1);
  assert.equal(await privateOgPng({ shoot: () => { shots++; return Buffer.from("x"); } }), null);
  assert.equal(shots, 1);
});
