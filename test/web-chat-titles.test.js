// Reason Web, each earlier Web-only chat's short title, written once (owner 10-27 01:58), for Chat history.
// Web-only chats were retired (owner 10-27 07:08): GET /web/chats/recent is gone. One test per rule:
//
//   1. GET /web/chats/recent no longer answers with a list of chats
//   6. the title comes from the claude-cli summarise once, when the first reply lands; a second reply never retitles
//   7. fallback title: the first words of their first message (no CLI, or the summarise failed)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-titles-"));
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
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234", KOFI = "+14155559876";
const OWNER_C = "dm:owner", KOFI_C = `dm:fake:${KOFI}`;
const id = (c) => c.repeat(22);
// Message times, well after the real clock.
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

test("1. GET /web/chats/recent is gone: no list of chats, signed in or not", async () => {
  const omari = browser(OWNER_C);
  seed(OWNER_C, id("A"), [["user", "hello"]], 1_000);
  for (const [who, b] of [["signed in", omari], ["signed out", null]]) {
    const r = await recent(b);
    assert.notEqual(r.status, 200, `${who}: ${r.status}`);
    assert.ok(!r.json?.chats, `${who}: no chats list`);
    assert.ok(!String(r.headers?.["Content-Type"] ?? "").includes("application/json"), `${who}: not JSON`);
  }
  // It falls through like any unknown /web path: back to /web.
  const r = await recent(omari);
  assert.ok([302, 303].includes(r.status), String(r.status));
  assert.equal(r.headers.Location, "/web");
  assert.equal(chats.recentChats, undefined, "recentChats is gone from src/webchats.js");
});

test("6. the title comes from the summarise once, when the first reply lands; a second reply never retitles", async () => {
  const asks = [];
  chats.setTitleAsk(async (args) => { asks.push(args); return { value: { title: asks.length === 1 ? "Saturday plans" : "Something else" } }; });
  const chat = id("A");
  seed(OWNER_C, chat, [["user", "plan my saturday please, somewhere outdoors"]], 1_000);
  await settle();
  assert.equal(asks.length, 0, "no reply yet: nothing asked");
  assert.equal(db.db.prepare("SELECT title FROM web_chats WHERE id = ?").get(chat).title ?? null, null, "until then, untitled (Chat history shows the first words)");
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
  assert.equal(db.db.prepare("SELECT title FROM web_chats WHERE id = ?").get(chat).title, "Saturday plans");
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
  // A first message naming them: the fallback never carries their name either.
  chats.setTitleAsk(async () => ({ value: { title: "" } }));
  seed(OWNER_C, id("D"), [["user", "Omari here, plan my week"], ["assistant", "On it."]], 5_000);
  await settle();
  assert.equal(db.db.prepare("SELECT title FROM web_chats WHERE id = ?").get(id("D")).title, chats.UNTITLED);
});
