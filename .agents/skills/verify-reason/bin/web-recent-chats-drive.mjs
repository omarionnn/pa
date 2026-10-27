#!/usr/bin/env node
// Drive GET /web/chats/recent (owner 10-27 01:58: recent Web chats for Home's composer) and each chat's
// title over REAL HTTP: src/http.js createServer on a loopback port, the real Router, Runtime, outbox
// and WebChannel, a scripted model (no model is called; with no claude-cli backend the title is the
// fallback — the first words of the chat's first message). Run under the cage's env:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/web.db node .agents/skills/verify-reason/bin/web-recent-chats-drive.mjs
//
// Prints one line per step, `ok` or `FAIL`, and exits non-zero on any FAIL.
process.env.REASON_WEB = "on";
process.env.REASON_PAGES_URL = process.env.REASON_PAGES_URL || "https://files.example.test";
process.env.REASON_SITE_URL = "http://127.0.0.1";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_UNDO_SECONDS = "0";
delete process.env.REASON_SITE_PROXY_SECRET;
delete process.env.REASON_AUTO_ADMIT;
delete process.env.REASON_BACKEND; // never the CLI here: the fallback title is what is proved
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/web.db");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { FakeChannel } = await imp("src/channels/fake.js");
const { ConsoleChannel } = await imp("src/channels/console.js");
const { WebChannel } = await imp("src/channels/web.js");
const { makeDeliver } = await imp("src/deliver.js");
const { createServer } = await imp("src/http.js");
const db = await imp("src/db.js");

const KOFI = "+14155559876", AMA = "+13475550000";
const KOFI_C = `dm:fake:${KOFI}`, AMA_C = `dm:fake:${AMA}`;
for (const [c, a, n] of [[KOFI_C, KOFI, "Kofi"], [AMA_C, AMA, "Ama"]]) {
  db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
  db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
}
db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");

const router = new Router({});
const consoleChannel = new ConsoleChannel({ write: () => {} });
const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
const runtime = new Runtime({ channels: router, deliver, runTurn: async ({ text }) => `re: ${String(text).split("\n").at(-1).replace(/^.*?: /, "")}` });
router.runtime = runtime;
router.register(consoleChannel);
const phone = router.register(new FakeChannel({ number: "+16562167455" }));
router.register(new WebChannel());
runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
  await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
});
const server = createServer({ router, runtime });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!(await pred()) && Date.now() < end) await new Promise(r => setTimeout(r, 15)); return pred(); };
const signIn = (conv) => { const t = `drive-${conv.length}-${Math.random().toString(36).slice(2)}`; db.startPageSession(`wsign:${conv}`, t, { conversationId: conv }); return { cookie: `reason_page=${t}`, csrf: db.pageSessionCsrf(t) }; };
const H = (b, extra = {}) => ({ ...(b ? { cookie: b.cookie } : {}), origin: BASE, "sec-fetch-site": "same-origin", ...extra });
const send = async (b, chat, id, text) => (await fetch(`${BASE}/web/send`, { method: "POST", headers: H(b, { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-reason-csrf": b.csrf }), body: new URLSearchParams({ id, text, c: b.csrf, chat }) })).status;
const recent = async (b, headers = {}) => { const r = await fetch(`${BASE}/web/chats/recent`, { headers: H(b, { accept: "application/json", ...(b ? { "x-reason-csrf": b.csrf } : {}), ...headers }) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const chatId = (c) => c.repeat(22);

const kofi = signIn(KOFI_C), ama = signIn(AMA_C);
const sent = phone.sent.length;
// Seven chats for Kofi, one for Ama; a reply lands in each.
for (let i = 0; i < 7; i++) {
  const c = chatId("ABCDEFG"[i]);
  step(`POST /web/send into chat ${"ABCDEFG"[i]}`, (await send(kofi, c, `rc-${i}-aaaa`, `Chat number ${i} about planning the weekend trip upstate in detail`)) === 200);
  await until(() => db.messagesFor(KOFI_C, { chat: c }).length === 2);
  await new Promise(r => setTimeout(r, 5));
}
await send(ama, chatId("Z"), "rc-ama-aaaa", "ama's private chat");
await until(() => db.messagesFor(AMA_C, { chat: chatId("Z") }).length === 2);
await until(() => db.db.prepare("SELECT COUNT(*) n FROM web_chats WHERE title IS NULL").get().n === 0);

const r = await recent(kofi);
const ids = r.json?.chats?.map(c => c.id) ?? [];
step("GET /web/chats/recent: 200, five chats, newest first", r.status === 200 && ids.join(",") === ["G", "F", "E", "D", "C"].map(chatId).join(","), ids.map(x => x[0]).join(""));
step("each row is { id, title, preview, updatedAt, needsYou, working }", r.json?.chats?.every(c => Object.keys(c).sort().join() === "id,needsYou,preview,title,updatedAt,working"));
const g = r.json?.chats?.[0] ?? {};
step("title = the first words of the first message (no CLI backend here)", g.title === "Chat number 6 about planning the", g.title);
step("preview = the last message (the reply), ≤80 chars", g.preview?.startsWith("re: Chat number 6") && g.preview.length <= 80, g.preview);
step("not Ama's chat", !ids.includes(chatId("Z")));
step("Ama sees only hers", (await recent(ama)).json?.chats?.map(c => c.id).join() === chatId("Z"));
// A second reply never retitles, and moves the chat to the top.
await send(kofi, chatId("A"), "rc-again-aaaa", "something completely different now");
await until(() => db.messagesFor(KOFI_C, { chat: chatId("A") }).length === 4);
const r2 = await recent(kofi);
step("a second exchange moves A to the top and keeps its title", r2.json?.chats?.[0]?.id === chatId("A") && r2.json.chats[0].title === "Chat number 0 about planning the", r2.json?.chats?.[0]?.title);
step("signed out: 401", (await recent(null)).status === 401);
step("no x-reason-csrf: 403", (await recent({ cookie: kofi.cookie, csrf: "" })).status === 403);
step("another site: 403", (await recent(kofi, { "sec-fetch-site": "cross-site" })).status === 403);
step("nothing went to a phone", phone.sent.length === sent);

server.close();
process.exit(fails ? 1 : 0);
