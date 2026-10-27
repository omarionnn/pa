// Reason Web, the daily edition Home (handoff 2026-10-27 §1, reference/home.html), behind REASON_WEB_DAILY.
// One test per rule:
//
//   1. the flag: off = today's Home exactly; owner = the operator only; on = everybody
//   2. first day: NO. 1, the first-edition greeting, "Nothing yet. Text me something to start.", no composer
//   3. masthead: NO. n · THE {WEEKDAY} EDITION, the full date, the greeting, the double rule; sign-off
//   4. overnight: decision (two replies posted to /web/send with the form secret), update (into the thread at
//      that message), done (DONE + one line); answers to their own lines are not news; newest first; ≤5 + "N more"
//   5. quiet night; missed days ("welcome back. here's what happened since <day>." and the whole gap)
//   6. lines out: watches, reminders, series; pen when within a day; hidden when none
//   7. one question: an open guess; answering saves it to Memory (source noted) and lands back Home;
//      at most one a day; "Ask me later" not again for 7 days; refused cross-origin / without the secret
//   8. pick up: the thread's last two lines; "pick up where you left off" when the last was on Web
//   9. the overnight write: claude-cli greeting stub, idempotent, issue counts editions, fixed moments keep
//      fixed words, a bad model line keeps the plain one, the real CLI is never called under test
//  10. the sweep: nothing before the hour, then once per person per day, only for whom the flag allows
//  11. a fresh Web chat stays reachable: NEW WEB CHAT → on the thread page; /web?newchat → /web?chat=<id>
//  12. a decision tap is one message into the thread, as if typed (the router gets the reply)
//  13. new in your book: hidden without a stamp; drawn from src/stamps.js when one is given
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-daily-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";
process.env.REASON_WEB_DAILY = "owner";

const { webRequestFor } = await import("../src/http.js");
const daily = await import("../src/daily.js");
const db = await import("../src/db.js");
const background = await import("../src/background.js");
const { renderDaily } = await import("../src/pages/webdaily.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234", KOFI = "+14155559876";
const OWNER_C = "dm:owner", KOFI_C = `dm:fake:${KOFI}`;
const H = 3_600_000, D = 24 * H;
// Tuesday 27 October 2026, 9:00 AM in New York (EDT, UTC−4).
const TUE_9AM = Date.UTC(2026, 9, 27, 13, 0, 0);
const at = (ms) => { clock.reset(); clock.skip(ms - Date.now()); };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  process.env.REASON_WEB_DAILY = "owner";
  daily.resetDaily();
  db.db.exec(`DELETE FROM accounts; DELETE FROM threads; DELETE FROM messages; DELETE FROM page_sessions; DELETE FROM web_chats; DELETE FROM confirmations;
    DELETE FROM tasks; DELETE FROM timers; DELETE FROM series; DELETE FROM watches; DELETE FROM guesses; DELETE FROM person_facts; DELETE FROM people; DELETE FROM memories; DELETE FROM pending_inbound;
    DELETE FROM daily_editions; DELETE FROM daily_looks; DELETE FROM daily_questions;`);
  at(TUE_9AM - 30 * D);
  for (const [c, a, n, op] of [[OWNER_C, OWNER, "Omari Nyarko", true], [KOFI_C, KOFI, "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
    db.markWebNoticeSeen(c); // 5C is spent: the arrival is what's drawn
  }
  at(TUE_9AM);
});

let n = 0;
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token) };
}
const hdr = (b, extra = {}) => ({ host: "heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}), ...extra });
async function get(b, query = { home: "" }) {
  return await webRequestFor({ sub: null, method: "GET", query, headers: hdr(b), remoteAddress: "127.0.0.1", readBody: async () => "" });
}
async function post(b, sub, fields, { headers = {}, router = null } = {}) {
  const body = new URLSearchParams(fields).toString();
  return await webRequestFor({ sub, method: "POST", query: {}, headers: hdr(b, headers), remoteAddress: "127.0.0.1", readBody: async () => body, router });
}
const say = (conv, role, text, when, channel = "fake") => db.writeMessage({ conversationId: conv, role, channel, text, at: when });
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

test("1. the flag: off is today's Home exactly; owner is the operator only; on is everybody", async () => {
  process.env.REASON_WEB_DAILY = "";
  const off = (await get(browser(OWNER_C))).body;
  assert.match(off, /class="composer"|name="text"/, "today's Home keeps its composer");
  assert.doesNotMatch(off, /EDITION/);
  process.env.REASON_WEB_DAILY = "owner";
  const mine = (await get(browser(OWNER_C))).body;
  assert.match(mine, /THE TUESDAY EDITION/);
  const kofi = (await get(browser(KOFI_C))).body;
  assert.doesNotMatch(kofi, /EDITION/, "owner mode: nobody else");
  process.env.REASON_WEB_DAILY = "on";
  assert.match((await get(browser(KOFI_C))).body, /THE TUESDAY EDITION/);
  // ?thread is still the thread
  assert.doesNotMatch((await get(browser(OWNER_C), { thread: "" })).body, /EDITION/);
});

test("2. first day: NO. 1, the first-edition greeting, the one Overnight line, no composer", async () => {
  const html = (await get(browser(OWNER_C))).body;
  assert.match(html, /NO\. 1 · THE TUESDAY EDITION/);
  assert.match(html, />first edition\. it&#39;ll fill up as I do things for you\.</);
  assert.match(text(html), /OVERNIGHT Nothing yet\. Text me something to start\./);
  assert.doesNotMatch(html, /name="text" (?:id|class|rows|placeholder)|<textarea/, "no composer");
  assert.doesNotMatch(html, /LINES OUT/, "no lines out: hidden");
  assert.doesNotMatch(html, /ONE QUESTION TODAY/);
  assert.doesNotMatch(html, /NEW IN YOUR BOOK/);
  assert.doesNotMatch(html, /pick up from/, "nothing to pick up yet");
  assert.match(html, /aria-current="page">HOME</);
  assert.match(html, /href="\/web\?thread">THE THREAD</);
});

test("3. masthead and sign-off", async () => {
  say(OWNER_C, "user", "Find me a hotel in Woodstock", TUE_9AM - 20 * H);
  const html = (await get(browser(OWNER_C))).body;
  assert.match(html, /<h1 class="dd-date">Tuesday, October 27\.<\/h1>/);
  assert.match(html, /class="dd-greet">quiet night\. nothing needed you\.</);
  assert.match(html, /class="dd-rule" aria-hidden="true"><span><\/span><span><\/span>/);
  assert.match(html, />see you tomorrow\. or don&#39;t, I&#39;ll keep the page\.</);
  assert.match(html, /<meta name="robots" content="noindex/);
});

test("4. overnight: decision, update, done; answers are not news; newest first; ≤5 then N more", async () => {
  const b = browser(OWNER_C);
  say(OWNER_C, "user", "Watch the Woodstock hotel for me", TUE_9AM - 15 * H);           // last look: 6pm Monday
  say(OWNER_C, "assistant", "On it. I'll keep an eye on it.", TUE_9AM - 15 * H + 30_000); // an answer, not news
  at(TUE_9AM - 9 * H);                                                                   // 12:00 AM
  const t = db.createTask(OWNER_C, { title: "Book the dentist", goal: "book", maxAttempts: 3 });
  db.finishTask(OWNER_C, t.id, { state: "done", outcome: "booked", result: { headline: "Dentist confirmed for Thursday, 10:30. It's on your calendar." } });
  say(OWNER_C, "assistant", "The farmhouse inn near Hudson wrote back. The room with the wood stove is open the 14th to the 16th.", TUE_9AM - 6 * H); // 3:00 AM
  at(TUE_9AM - 3 * H - 20 * 60_000);                                                    // 5:40 AM
  db.askConfirmation({ conversationId: OWNER_C, action: "browser_submit", summary: "Hold the Woodstock hotel at $550 for the 14th", stakes: "money", askedAfterMsgs: 1, amount: 550 });
  at(TUE_9AM);
  const html = (await get(b)).body;
  const order = ["Hold the Woodstock hotel", "The farmhouse inn near Hudson wrote back.", "Dentist confirmed"].map(s => html.indexOf(s));
  assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], `newest first: ${order}`);
  assert.match(html, />5:40 AM</);
  const overnight = /<section class="dd-on"[\s\S]*?<\/section>/.exec(html)[0];
  assert.doesNotMatch(overnight, /On it\. I&#39;ll keep an eye on it\./, "a reply to their own line is not overnight news");
  // decision: one real form to /web/send, the form secret, two replies as the submit's value
  const form = /<form class="dd-acts" method="POST" action="\/web\/send">([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
  assert.match(form, new RegExp(`name="c" value="${b.csrf}"`));
  assert.match(form, /name="id" value="[0-9a-f-]{36}"/);
  assert.match(form, /class="dd-p" type="submit" name="text" value="Yes, go ahead\.">Yes, go ahead</);
  assert.match(form, /class="dd-s" type="submit" name="text" value="Not now\.">Not now</);
  // update: into the thread at that message
  const msg = db.db.prepare("SELECT id FROM messages WHERE text LIKE 'The farmhouse%'").get().id;
  assert.match(html, new RegExp(`<h2 class="dd-h">The farmhouse inn near Hudson wrote back\\.</h2><p class="dd-d">The room with the wood stove is open the 14th to the 16th\\.</p><a class="dd-l" href="/web\\?at=${msg}">Read it in the thread</a>`));
  // done: the stamp and one line
  assert.match(html, /<span class="dd-stamp">DONE<\/span><p>Dentist confirmed for Thursday, 10:30\. It&#39;s on your calendar\.<\/p>/);
  assert.match(html, />morning, Omari\. three things moved while you slept, and one needs you\.</);
  // ≤5 then "N more in the thread"
  for (let i = 0; i < 4; i++) say(OWNER_C, "assistant", `Update number ${i + 1} came in overnight for you.`, TUE_9AM - 2 * H + i * 60_000);
  const many = (await get(b)).body;
  assert.equal((many.match(/<article class="dd-i/g) ?? []).length, 5);
  assert.match(many, /<a class="dd-l dd-more" href="\/web\?thread">2 more in the thread<\/a>/);
});

test("5. quiet night, and missed days", async () => {
  say(OWNER_C, "user", "thanks", TUE_9AM - 12 * H);
  assert.match((await get(browser(OWNER_C))).body, /quiet night\. nothing needed you\./);
  db.db.exec("DELETE FROM messages; DELETE FROM daily_looks;");
  // Last there Friday evening; things happened Saturday and Monday.
  say(OWNER_C, "user", "talk Monday", TUE_9AM - 3 * D - 14 * H);
  say(OWNER_C, "assistant", "Your passport renewal was approved by the office. It ships this week.", TUE_9AM - 3 * D + 2 * H);
  say(OWNER_C, "assistant", "The restaurant moved your table to 8pm on Friday.", TUE_9AM - D + 3 * H);
  const html = (await get(browser(OWNER_C))).body;
  assert.match(html, />welcome back\. here&#39;s what happened since Friday\.</);
  assert.match(html, /Your passport renewal was approved/, "Overnight covers the whole gap");
  assert.match(html, /SAT \d/, "older lines carry their day");
  // A look on an earlier day counts as looking: Monday's look makes Tuesday an ordinary morning.
  db.db.exec("DELETE FROM daily_looks;");
  at(TUE_9AM - D + 4 * H);
  daily.noteLook(OWNER_C);
  at(TUE_9AM);
  assert.match((await get(browser(OWNER_C))).body, /quiet night\. nothing needed you\./);
});

test("6. lines out: watches, reminders and series; pen within a day; hidden when none", async () => {
  say(OWNER_C, "user", "ok", TUE_9AM - 10 * H);
  db.createWatch(OWNER_C, { url: "https://example.test/tix", lookingFor: "tickets on sale", note: "Show tickets go on sale", everyMs: 3 * H });
  db.createTimer(OWNER_C, { fireAt: TUE_9AM + 5 * H, note: "Call the landlord about the lease" });
  db.createTimer(OWNER_C, { fireAt: TUE_9AM + 3 * D, note: "Renew the parking permit" });
  const html = (await get(browser(OWNER_C))).body;
  assert.match(html, /<section class="dd-lo" aria-label="Still watching"><div class="dd-loh"><p class="dd-lbl">LINES OUT<\/p><span class="dd-hand">I check these every few hours<\/span>/);
  assert.match(html, /Show tickets go on sale<\/span><span class="dd-ls">WATCHING<\/span>/);
  assert.match(html, /<span class="dd-ls urgent">TODAY 2:00 PM<\/span>/, "within a day: pen");
  assert.match(html, /<span class="dd-ls">FRI 9:00 AM<\/span>/);
  const order = ["Call the landlord", "Renew the parking", "Show tickets"].map(s => html.indexOf(s));
  assert.ok(order[0] < order[1] && order[1] < order[2], "pressing, then soonest");
});

test("7. one question: an open guess, answered to Memory, one a day, later not again for 7 days", async () => {
  say(OWNER_C, "user", "ok", TUE_9AM - 10 * H);
  const g1 = db.noteGuess(OWNER_C, { about: "Omari Nyarko", guess: "Prefers a window seat on long flights" });
  const g2 = db.noteGuess(OWNER_C, { about: "Omari Nyarko", guess: "Drinks oat milk" });
  const kofiG = db.noteGuess(KOFI_C, { about: "Kofi", guess: "Likes jazz" });
  const b = browser(OWNER_C);
  let html = (await get(b)).body;
  assert.match(html, /<section class="dd-card dd-q" aria-label="One question today"><p class="dd-lbl sm">ONE QUESTION TODAY<\/p><h2 class="dd-qh">Drinks oat milk\.<\/h2>/);
  assert.match(html, /<form class="dd-qa" method="POST" action="\/web\/daily\/answer">/);
  assert.match(html, /<button class="dd-later" type="submit" formaction="\/web\/daily\/later">Ask me later<\/button>/);
  assert.match(html, /<a class="dd-mem" href="\/web\/memory">YOUR ANSWER GOES TO MEMORY →<\/a>/);
  // refused: another origin, no secret, somebody else's guess
  assert.equal((await post(b, "daily/answer", { q: `guess:${g2.id}`, answer: "yes" })).status, 403);
  assert.equal((await post(b, "daily/answer", { c: b.csrf, q: `guess:${g2.id}`, answer: "yes" }, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const theirs = await post(b, "daily/answer", { c: b.csrf, q: `guess:${kofiG.id}`, answer: "yes" }, { headers: { accept: "application/json" } });
  assert.equal(theirs.status, 404);
  assert.equal(db.getGuess(KOFI_C, kofiG.id).confirmed_at, null);
  // answered yes: a fact in their name, the guess confirmed with where it was said, back to Home
  const out = await post(b, "daily/answer", { c: b.csrf, q: `guess:${g2.id}`, answer: "yes" });
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, "/web?home");
  assert.ok(db.memoryFacts(OWNER_C).some(f => /oat milk/i.test(f.fact)), "saved to Memory");
  assert.equal(db.getGuess(OWNER_C, g2.id).confirmed_said, "Yes, that's right (Reason Web daily edition)");
  html = (await get(b)).body;
  assert.doesNotMatch(html, /ONE QUESTION TODAY/, "at most one a day");
  // tomorrow: the next guess; put off → not tomorrow+1 … +7, back on day 8
  at(TUE_9AM + D);
  html = (await get(b)).body;
  assert.match(html, /<h2 class="dd-qh">Prefers a window seat on long flights\.<\/h2>/);
  const later = await post(b, "daily/later", { c: b.csrf, q: `guess:${g1.id}` });
  assert.equal(later.headers.Location, "/web?home");
  assert.equal(db.getGuess(OWNER_C, g1.id).dismissed_at, null, "putting off is not a no");
  assert.doesNotMatch((await get(b)).body, /ONE QUESTION TODAY/);
  at(TUE_9AM + 5 * D);
  assert.doesNotMatch((await get(b)).body, /ONE QUESTION TODAY/, "not repeated within 7 days");
  at(TUE_9AM + 9 * D);
  assert.match((await get(b)).body, /Prefers a window seat/);
  // "no" dismisses it
  await post(b, "daily/answer", { c: b.csrf, q: `guess:${g1.id}`, answer: "no" });
  assert.ok(db.getGuess(OWNER_C, g1.id).dismissed_at);
});

test("8. pick up: the last two lines; Web says pick up where you left off", async () => {
  say(OWNER_C, "user", "Under 3 hours. Keep it under $600.", TUE_9AM - 20 * H);
  say(OWNER_C, "assistant", "Got it. I'll pull a short list and keep it here for when you're ready.", TUE_9AM - 20 * H + 60_000);
  let html = (await get(browser(OWNER_C))).body;
  assert.match(html, /<a class="dd-pk" href="\/web\?thread" aria-label="Pick up from iMessage: continue the thread">/);
  assert.match(html, /<span class="dd-hand lg">pick up from iMessage<\/span>/);
  assert.match(html, /LAST TEXT · <time[^>]*>1:01 PM<\/time>/);
  assert.match(html, /<span class="dd-you">Under 3 hours\. Keep it under \$600\.<\/span><span class="dd-re">Got it\./);
  assert.match(html, /<span class="dd-go">Continue the thread →<\/span>/);
  say(OWNER_C, "user", "and something cheaper?", TUE_9AM - H, "web");
  html = (await get(browser(OWNER_C))).body;
  assert.match(html, /pick up where you left off/);
  assert.match(html, /LAST MESSAGE · /);
});

test("9. the overnight write: the claude-cli greeting, once; issue counts editions; fixed moments; bad lines", async () => {
  say(OWNER_C, "user", "watch it", TUE_9AM - 15 * H);
  say(OWNER_C, "assistant", "The hotel dropped its price overnight. It's $40 under yesterday.", TUE_9AM - 4 * H);
  const asked = [];
  daily.setGreetingAsk(async (args) => { asked.push(args); return { value: { greeting: "Morning, Omari. One thing moved while you slept.", question: "" } }; });
  at(TUE_9AM - 4 * H + 60_000);
  const w = await daily.writeEdition(OWNER_C);
  assert.equal(w.greeting_by, "claude-cli");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].feature, "daily_edition");
  assert.ok(!/\$40|hotel/i.test(asked[0].prompt), "the model is told kinds, never the details");
  assert.equal((await daily.writeEdition(OWNER_C)).already, true, "once a day");
  at(TUE_9AM);
  const html = (await get(browser(OWNER_C))).body;
  assert.match(html, />morning, Omari\. one thing moved while you slept\.</, "kept lowercase, the name as written");
  assert.match(html, /NO\. 1 · THE TUESDAY EDITION/);
  // Wednesday: a quiet night keeps its fixed words even with a model on hand; the issue is 2
  at(TUE_9AM + D - 4 * H);
  daily.noteLook(OWNER_C);
  at(TUE_9AM + D - 3 * H);
  const quiet = await daily.writeEdition(OWNER_C);
  assert.equal(quiet.greeting_by, "fixed");
  assert.equal(quiet.issue, 2);
  // Thursday's is written whether or not they open it; Friday is issue 4 (nothing counts visits)
  at(TUE_9AM + 2 * D - 3 * H); await daily.writeEdition(OWNER_C);
  at(TUE_9AM + 2 * D + H); daily.noteLook(OWNER_C);
  say(OWNER_C, "assistant", "The package arrived at your door this morning.", TUE_9AM + 3 * D - 5 * H);
  daily.setGreetingAsk(async () => ({ value: { greeting: "Morning!!! 🔥 you're on a 3 day streak", question: "" } }));
  at(TUE_9AM + 3 * D - 3 * H);
  const bad = await daily.writeEdition(OWNER_C);
  assert.equal(bad.issue, 4);
  assert.equal(bad.greeting_by, "plain", "a line out of voice keeps the plain one");
  // under the test runner, with no stand-in, the real CLI is never run
  daily.setGreetingAsk(null);
  db.db.exec("DELETE FROM daily_editions");
  const real = await daily.writeEdition(OWNER_C);
  assert.notEqual(real.greeting_by, "claude-cli");
});

test("10. the sweep: nothing before the hour, then once per person per day, only where the flag allows", async () => {
  process.env.REASON_WEB_DAILY = "on";
  background.resetLane({ gapMs: 0 });
  const asked = [];
  daily.setGreetingAsk(async (a) => { asked.push(a); return { value: { greeting: "morning.", question: "" } }; });
  at(Date.UTC(2026, 9, 27, 7, 30)); // 3:30 AM New York
  assert.equal(daily.sweepDaily().queued, 0);
  at(Date.UTC(2026, 9, 27, 8, 5)); // 4:05 AM
  assert.equal(daily.sweepDaily().queued, 2);
  assert.equal(daily.sweepDaily().queued, 0, "already queued");
  for (let i = 0; i < 50 && daily.editionCount(KOFI_C) + daily.editionCount(OWNER_C) < 2; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(daily.editionCount(OWNER_C), 1);
  assert.equal(daily.editionCount(KOFI_C), 1);
  assert.equal(daily.sweepDaily().queued, 0, "written: not again today");
  process.env.REASON_WEB_DAILY = "owner";
  at(Date.UTC(2026, 9, 28, 8, 5));
  assert.equal(daily.sweepDaily().queued, 1, "owner mode: the operator only");
  process.env.REASON_WEB_DAILY = "";
  at(Date.UTC(2026, 9, 29, 8, 5));
  assert.equal(daily.sweepDaily().queued, 0, "off: nothing");
});

test("11. a fresh Web chat stays reachable from the thread page", async () => {
  const b = browser(OWNER_C);
  const thread = (await get(b, { thread: "" })).body;
  assert.match(thread, /href="\/web\?newchat"[^>]*>NEW WEB CHAT →</);
  const go = await get(b, { newchat: "" });
  assert.equal(go.status, 303);
  assert.match(go.headers.Location, /^\/web\?chat=[A-Za-z0-9_-]{22}$/);
  const chat = await get(b, { chat: go.headers.Location.split("=")[1] });
  assert.equal(chat.status, 200);
  assert.match(chat.body, /name="chat" value="[A-Za-z0-9_-]{22}"/, "its composer starts that chat");
  process.env.REASON_WEB_DAILY = "";
  assert.doesNotMatch((await get(b, { thread: "" })).body, /NEW WEB CHAT/, "off: the thread page is unchanged");
});

test("12. a decision tap is one message into the thread, as if typed", async () => {
  const b = browser(OWNER_C);
  const sent = [];
  const router = { deliver: async (m) => { sent.push(m); return { ok: true }; } };
  const out = await post(b, "send", { c: b.csrf, id: "11111111-2222-3333-4444-555555555555", text: "Yes, go ahead." }, { router });
  assert.equal(out.status, 303);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "Yes, go ahead.");
  assert.equal(sent[0].channel, "web");
  assert.equal(sent[0].conversationId, OWNER_C);
});

test("13. new in your book: hidden without a stamp; drawn by src/stamps.js when there is one", () => {
  const base = daily.editionFor(OWNER_C);
  assert.doesNotMatch(renderDaily({ edition: base, csrf: "x" }), /NEW IN YOUR BOOK/);
  const stamp = { id: "s1", type: "long_hold", name: "The long hold", detail: "52 MIN", story: "I sat on hold for 52 minutes so you didn't have to.", earnedAt: TUE_9AM - D, shape: "round", ink: "pen", rotation: -8, ariaLabel: "Stamp: The long hold, 52 minutes" };
  const html = renderDaily({ edition: { ...base, newestStamp: stamp }, csrf: "x", stamps: true, stampMarkup: (s, { size }) => `<span role="img" aria-label="${s.ariaLabel}" data-size="${size}"></span>` });
  assert.match(html, /<a class="dd-nb" href="\/web\/stamps"><span class="dd-nbs"><span role="img" aria-label="Stamp: The long hold, 52 minutes" data-size="96"><\/span><\/span><span class="dd-nbt"><span class="dd-lbl sm">NEW IN YOUR BOOK<\/span><span class="dd-nbl">I sat on hold for 52 minutes so you didn&#39;t have to\.<\/span>/);
  assert.match(html, /href="\/web\/stamps">STAMPS</);
});
