// Reason Web, recent Web chats (owner 10-27 01:58): GET /web/chats/recent for Home's composer (the hover
// panel is the UI agent's, SCOPE-v2 Q-v2-51), and each chat's short title, written once. One test per rule:
//
//   1. signed out → 401; another origin or a wrong/missing x-reason-csrf → 403; only GET
//   2. only the session's own chats: another person's never appear
//   3. at most 5, most recently updated first
//   4. preview: the last message, one line, ≤80 characters
//   5. needsYou: an open approval asked in that chat; working: a turn running for that chat
//   6. the title comes from the claude-cli summarise once, when the first reply lands; a second reply never retitles
//   7. fallback title: the first words of their first message (no CLI, or the summarise failed)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-recent-"));
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

const { webRequestFor } = await import("../src/http.js");
const chats = await import("../src/webchats.js");
const onethought = await import("../src/onethought.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234", KOFI = "+14155559876";
const OWNER_C = "dm:owner", KOFI_C = `dm:fake:${KOFI}`;
const id = (c) => c.repeat(22);
// Message times, well after the real clock: a chat's updatedAt is the later of its row's time and now.
const T = Date.now() + 365 * 24 * 60 * 60_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  chats.resetChatTitles();
  db.db.exec("DELETE FROM accounts; DELETE FROM threads; DELETE FROM messages; DELETE FROM page_sessions; DELETE FROM web_chats; DELETE FROM confirmations; DELETE FROM pending_inbound;");
  for (const [c, a, n, op] of [[OWNER_C, OWNER, "Omari", true], [KOFI_C, KOFI, "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
});

let n = 0;
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token) };
}
async function recent(b, { method = "GET", headers = {}, csrf = b?.csrf } = {}) {
  const h = { host: "heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}), ...(csrf ? { "x-reason-csrf": csrf } : {}), ...headers };
  const out = await webRequestFor({ sub: "chats/recent", method, query: {}, headers: h, remoteAddress: "127.0.0.1", readBody: async () => "" });
  return { status: out.status, headers: out.headers, json: (() => { try { return JSON.parse(out.body); } catch { return null; } })() };
}
/** A chat with these lines, `at` apart from `start`. Writes no title (the titler is asked for nothing). */
function seed(conv, chat, lines, start) {
  db.claimWebChat(conv, chat);
  lines.forEach(([role, text], i) => db.writeMessage({ conversationId: conv, role, channel: "web", text, at: T + start + i * 1000, chatId: db.webChatRoute(chat) }));
}
const settle = () => new Promise(r => setTimeout(r, 20));

test("1. signed out is 401, another origin or a wrong secret is 403, only GET", async () => {
  const omari = browser(OWNER_C);
  seed(OWNER_C, id("A"), [["user", "hello"]], 1_000);
  assert.equal((await recent(null)).status, 401);
  assert.equal((await recent({ cookie: "reason_page=nope", csrf: "x" })).status, 401, "an unknown session is nobody");
  assert.equal((await recent(omari, { csrf: null })).status, 403, "no secret");
  assert.equal((await recent(omari, { csrf: browser(OWNER_C).csrf })).status, 403, "another session's secret");
  assert.equal((await recent(omari, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await recent(omari, { headers: { origin: "https://evil.test" } })).status, 403);
  const post = await recent(omari, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, "GET, HEAD");
  const ok = await recent(omari);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["Cache-Control"], "no-store");
  assert.deepEqual(ok.json.chats.map(c => c.id), [id("A")]);
});

test("2. only the session's own chats: another person's never appear", async () => {
  seed(OWNER_C, id("A"), [["user", "omari's chat"]], 1_000);
  seed(KOFI_C, id("K"), [["user", "kofi's chat"], ["assistant", "sure"]], 9_000);
  // A forged row naming Omari's chat from Kofi's conversation lands in neither.
  db.writeMessage({ conversationId: KOFI_C, role: "user", channel: "web", text: "forged", at: T + 20_000, chatId: db.webChatRoute(id("A")) });
  const mine = (await recent(browser(OWNER_C))).json.chats;
  assert.deepEqual(mine.map(c => c.id), [id("A")]);
  assert.equal(mine[0].preview, "omari's chat");
  assert.deepEqual((await recent(browser(KOFI_C))).json.chats.map(c => c.id), [id("K")]);
  assert.deepEqual(chats.recentChats(null), []);
});

test("3. at most 5, most recently updated first; an empty chat isn't listed", async () => {
  const ids = ["A", "B", "C", "D", "E", "F", "G"].map(id);
  // Created in order, then B and A used again later: updatedAt (last_at) is what orders them, not creation.
  ids.forEach((c, i) => seed(OWNER_C, c, [["user", `chat ${i}`]], 10_000 + i * 10_000));
  db.writeMessage({ conversationId: OWNER_C, role: "user", channel: "web", text: "B again", at: T + 200_000, chatId: db.webChatRoute(id("B")) });
  db.writeMessage({ conversationId: OWNER_C, role: "user", channel: "web", text: "A again", at: T + 300_000, chatId: db.webChatRoute(id("A")) });
  db.claimWebChat(OWNER_C, id("Z")); // claimed, nothing sent
  const got = (await recent(browser(OWNER_C))).json.chats;
  assert.equal(got.length, 5);
  assert.deepEqual(got.map(c => c.id), [id("A"), id("B"), id("G"), id("F"), id("E")]);
  const at = got.map(c => c.updatedAt);
  assert.deepEqual([...at].sort((a, b) => b - a), at, "updatedAt descending");
  assert.ok(!got.some(c => c.id === id("Z")));
  assert.deepEqual(Object.keys(got[0]).sort(), ["id", "needsYou", "preview", "title", "updatedAt", "working"]);
});

test("4. the preview is the last message's text, one line, at most 80 characters", async () => {
  const long = `${"word ".repeat(40)}end`;
  seed(OWNER_C, id("A"), [["user", "first"], ["assistant", `line one\n\n  ${long}`]], 1_000);
  seed(OWNER_C, id("B"), [["user", "short and sweet"]], 500);
  const [a, b] = (await recent(browser(OWNER_C))).json.chats;
  assert.ok(a.preview.length <= 80 && a.preview.length > 70, `${a.preview.length}`);
  assert.ok(a.preview.endsWith("…"));
  assert.ok(a.preview.startsWith("line one word word"), "whitespace folded to one line");
  assert.ok(!/\n/.test(a.preview));
  assert.equal(b.preview, "short and sweet");
  assert.equal(chats.previewOf("x".repeat(80)), "x".repeat(80), "exactly 80 stays whole");
  // A photo with no words after the last text: the preview is still the last words.
  db.writeMessage({ conversationId: OWNER_C, role: "user", channel: "web", text: "", media: [{ kind: "image" }], at: T + 9_000, chatId: db.webChatRoute(id("B")) });
  assert.equal(chats.recentChats(OWNER_C).find(c => c.id === id("B")).preview, "short and sweet");
});

test("5. needsYou is an open approval asked in that chat; working is a turn running for that chat", async () => {
  seed(OWNER_C, id("A"), [["user", "buy the headphones"]], 1_000);
  seed(OWNER_C, id("B"), [["user", "other"]], 2_000);
  const ask = (key) => db.askConfirmation({ conversationId: OWNER_C, action: "purchase_confirm", summary: "Buy the headphones", stakes: "money", askedAfterMsgs: 0, threadKey: key });
  ask(OWNER_C); // asked in the shared thread: no chat needs them for it
  let got = chats.recentChats(OWNER_C);
  assert.ok(got.every(c => !c.needsYou && !c.working));
  const c = ask(db.historyKeyFor(OWNER_C, db.webChatRoute(id("A"))));
  got = chats.recentChats(OWNER_C);
  assert.deepEqual(got.map(x => [x.id, x.needsYou]), [[id("B"), false], [id("A"), true]]);
  db.grantConfirmation(c.id, "yes");
  assert.ok(chats.recentChats(OWNER_C).every(x => !x.needsYou), "answered: nothing needs them");
  const turn = onethought.begin(OWNER_C, { text: "other" });
  turn.webChat = id("B");
  got = chats.recentChats(OWNER_C);
  assert.deepEqual(got.map(x => [x.id, x.working]), [[id("B"), true], [id("A"), false]]);
  onethought.end(turn);
  assert.ok(chats.recentChats(OWNER_C).every(x => !x.working));
  // A message still held to be taken for chat A is work in flight too.
  db.db.prepare(`INSERT INTO pending_inbound (conversation_id, channel, address, chat_id, external_id, text, attachments, service, is_operator, arrived_at, ready_at, deadline_at)
    VALUES (?, 'web', ?, ?, 'p1', 'more', '[]', NULL, 0, 1, 1, 1)`).run(OWNER_C, OWNER, db.webChatRoute(id("A")));
  assert.deepEqual(chats.recentChats(OWNER_C).map(x => [x.id, x.working]), [[id("B"), false], [id("A"), true]]);
});

test("6. the title comes from the summarise once, when the first reply lands; a second reply never retitles", async () => {
  const asks = [];
  chats.setTitleAsk(async (args) => { asks.push(args); return { value: { title: asks.length === 1 ? "Saturday plans" : "Something else" } }; });
  const chat = id("A");
  seed(OWNER_C, chat, [["user", "plan my saturday please, somewhere outdoors"]], 1_000);
  await settle();
  assert.equal(asks.length, 0, "no reply yet: nothing asked");
  assert.equal(chats.recentChats(OWNER_C)[0].title, "plan my saturday please, somewhere outdoors", "until then, the first words");
  db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "web", text: "Try the High Line.", at: T + 2_000, chatId: db.webChatRoute(chat) });
  await settle();
  assert.equal(asks.length, 1);
  assert.equal(asks[0].feature, "chat_title");
  assert.match(asks[0].prompt, /plan my saturday/);
  assert.match(asks[0].prompt, /Try the High Line/);
  assert.equal(db.db.prepare("SELECT title FROM web_chats WHERE id = ?").get(chat).title, "Saturday plans");
  // The second reply, and a later one: no new ask, the title stays.
  db.writeMessage({ conversationId: OWNER_C, role: "user", channel: "web", text: "and sunday?", at: T + 3_000, chatId: db.webChatRoute(chat) });
  db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "web", text: "Sunday: the park.", at: T + 4_000, chatId: db.webChatRoute(chat) });
  await settle();
  assert.equal(asks.length, 1, "asked once");
  const got = (await recent(browser(OWNER_C))).json.chats[0];
  assert.equal(got.title, "Saturday plans");
  assert.equal(got.preview, "Sunday: the park.");
  // Chat history uses it too.
  const page = await webRequestFor({ sub: "memory/history", method: "GET", query: {}, headers: { host: "heyreason.test", cookie: browser(OWNER_C).cookie }, remoteAddress: "127.0.0.1", readBody: async () => "" });
  assert.match(page.body, /<span class="dy-d">Saturday plans<\/span>/);
  // Somebody else's chat id is never titled for them, and the model's name for them is never kept.
  assert.equal(chats.titleWebChat(KOFI_C, chat), null);
  chats.setTitleAsk(async () => ({ value: { title: "Omari's weekend" } }));
  seed(OWNER_C, id("B"), [["user", "weekend ideas"], ["assistant", "ok"]], 5_000);
  await settle();
  assert.equal(db.db.prepare("SELECT title FROM web_chats WHERE id = ?").get(id("B")).title, "weekend ideas", "a title with their name falls back");
});

test("7. fallback title: the first words of their first message when there is no CLI or it fails", async () => {
  // No stand-in: under the test runner the real CLI is never reached, so the fallback is written.
  seed(OWNER_C, id("A"), [["user", "Can you find me a cheap flight to Accra in December for two"], ["assistant", "Looking."]], 1_000);
  await settle();
  assert.equal(db.db.prepare("SELECT title FROM web_chats WHERE id = ?").get(id("A")).title, "Can you find me a cheap");
  // The summarise erroring: the same fallback.
  chats.setTitleAsk(async () => ({ error: "timeout" }));
  seed(OWNER_C, id("B"), [["user", "lease\nquestions"], ["assistant", "Sure."]], 2_000);
  await settle();
  assert.equal(db.db.prepare("SELECT title FROM web_chats WHERE id = ?").get(id("B")).title, "lease questions");
  // A first message with no words (a photo): "A Web chat".
  chats.setTitleAsk(async () => { throw new Error("boom"); });
  db.claimWebChat(OWNER_C, id("C"));
  db.writeMessage({ conversationId: OWNER_C, role: "user", channel: "web", text: "", media: [{ kind: "image" }], at: T + 3_000, chatId: db.webChatRoute(id("C")) });
  db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "web", text: "Nice photo.", at: T + 4_000, chatId: db.webChatRoute(id("C")) });
  await settle();
  assert.equal(db.db.prepare("SELECT title FROM web_chats WHERE id = ?").get(id("C")).title, chats.UNTITLED);
  assert.equal(chats.fallbackTitle("x".repeat(60)), `${"x".repeat(47)}…`);
});
