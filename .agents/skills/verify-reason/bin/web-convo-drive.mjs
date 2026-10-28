#!/usr/bin/env node
// Drive Reason Web's conversation (W2) end to end over REAL HTTP: src/http.js createServer on a
// loopback port, the real Router, Runtime, outbox, WebChannel and a FakeChannel for the phone line,
// a scripted model (no model is called). Every request is one a browser makes — the page, the
// stream (read as a real text/event-stream), /web/send, /web/history — and every text is one a phone
// would receive, captured by the fake. Run under the cage's env so it gets its own database and
// every texting credential blanked:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/web.db node .agents/skills/verify-reason/bin/web-convo-drive.mjs
//
// Prints one line per step, `ok` or `FAIL`, and exits non-zero on any FAIL. Signing in is W1's drive
// (bin/web-drive.mjs); here a browser starts already signed in (a page_sessions row, as the code step leaves it).
process.env.REASON_WEB = "on";
process.env.REASON_PAGES_URL = process.env.REASON_PAGES_URL || "https://files.example.test";
process.env.REASON_SITE_URL = "http://127.0.0.1";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_UNDO_SECONDS = "0";
delete process.env.REASON_SITE_PROXY_SECRET;
delete process.env.REASON_AUTO_ADMIT;
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
const { makeDeliver, WEB_HINT } = await imp("src/deliver.js");
const { createServer } = await imp("src/http.js");
const db = await imp("src/db.js");

const KOFI = "+14155559876", AMA = "+13475550000", LINE = "+16562167455";
const KOFI_C = `dm:fake:${KOFI}`, AMA_C = `dm:fake:${AMA}`;
for (const [c, a, n] of [[KOFI_C, KOFI, "Kofi"], [AMA_C, AMA, "Ama"]]) {
  db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
  db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
}
db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");

// The model: answers at once, except a message with "slow" in it, which waits to be let go.
let release = null;
const gate = new Promise(r => { release = r; });
const turns = [];
const router = new Router({});
const consoleChannel = new ConsoleChannel({ write: () => {} });
const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
const runtime = new Runtime({ channels: router, deliver, runTurn: async ({ text }) => { turns.push(text); if (/slow/.test(text)) await gate; return `re: ${String(text).split("\n").at(-1).replace(/^.*?: /, "")}`; } });
router.runtime = runtime;
router.register(consoleChannel);
const phone = router.register(new FakeChannel({ number: LINE }));
const web = router.register(new WebChannel());
runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
  await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
});
const server = createServer({ router, runtime });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!(await pred()) && Date.now() < end) await new Promise(r => setTimeout(r, 15)); return pred(); };
const signIn = (conv) => { const t = `drive-${conv.length}-${Math.random().toString(36).slice(2)}`; db.startPageSession(`wsign:${conv}`, t, { conversationId: conv }); return { cookie: `reason_page=${t}`, token: t }; };
const H = (b, extra = {}) => ({ cookie: b.cookie, origin: BASE, "sec-fetch-site": "same-origin", ...extra });
const page = async (b, q = "") => { const r = await fetch(`${BASE}/web${q}`, { headers: H(b) }); return { status: r.status, body: await r.text(), headers: r.headers }; };
const csrfOf = (body) => /name="c" value="([^"]+)"/.exec(body)?.[1];
const post = async (b, csrf, id, text, extra = {}) => {
  const r = await fetch(`${BASE}/web/send`, { method: "POST", headers: H(b, { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-reason-csrf": csrf, ...extra }), body: new URLSearchParams({ id, text, c: csrf }) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const hist = async (b, q) => (await (await fetch(`${BASE}/web/history?${q}`, { headers: H(b, { accept: "application/json" }) })).json());
/** A real EventSource-shaped reader over fetch: collects `event:` blocks until closed. */
function listen(b, after = 0) {
  const ctl = new AbortController(), events = [];
  const done = fetch(`${BASE}/web/stream?after=${after}`, { headers: H(b, { accept: "text/event-stream" }), signal: ctl.signal }).then(async (r) => {
    events.status = r.status; events.type = r.headers.get("content-type");
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
      }
    }
  }).catch(() => {});
  return { events, close: () => ctl.abort(), done };
}

// 1. A text first, so there is history from the phone.
await router.deliver({ channel: "fake", externalId: "k-t1", from: KOFI, text: "weekend away in november?", chatId: null, at: Date.now() });
step("a text from Kofi's phone is answered by text and is history", phone.sent.at(-1)?.text === "re: weekend away in november?" && db.messagesFor(KOFI_C).length === 2);

// 2. The page: Kofi's conversation, labelled, with the first-visit boundary note and the composer.
const kofi = signIn(KOFI_C);
const p0 = await page(kofi);
step("GET /web, first visit: 200, the 5C note (once)", p0.status === 200 && /One Reason\.<br><em>Pick up anywhere\.<\/em>/.test(p0.body));
const home = await page(kofi);
step("GET /web next: the arrival — greeting, composer, 'pick up from iMessage' with his last text; no 5C again", /What(&#39;|')s good, Kofi\?/.test(home.body) && /pick up from iMessage/.test(home.body) && /weekend away in november\?/.test(home.body) && !/Pick up anywhere/.test(home.body));
const p1 = await page(kofi, "?thread");
const csrf = csrfOf(p1.body);
step("GET /web?thread: the conversation, IMESSAGE labels, composer", p1.status === 200 && /weekend away in november\?/.test(p1.body) && /YOU · IMESSAGE · /.test(p1.body) && /placeholder="Tell Reason what you need"/.test(p1.body) && !!csrf);
step("CSP: connect-src is this host (and only the pages host when it qualifies)", /connect-src 'self'( https:\/\/files\.[^ ;]+)?;/.test(p1.headers.get("content-security-policy") ?? ""));

// 3. A Web message with the stream open: it and its reply arrive live, nothing is texted.
const s = listen(kofi, db.messagesFor(KOFI_C).at(-1).id);
await until(() => s.events.status === 200);
const sentBefore = phone.sent.length;
const w1 = await post(kofi, csrf, "drive-w-0001", "under $600, fireplace a bonus");
await until(() => s.events.filter(e => e.event === "message").length >= 2);
const live = s.events.filter(e => e.event === "message").map(e => `${e.data.role}:${e.data.source}:${e.data.text}`);
step("POST /web/send: 200 ok", w1.status === 200 && w1.json?.ok === true);
step("the stream (text/event-stream) carried Kofi's line and Reason's reply, both labelled Web", s.events.type?.startsWith("text/event-stream") && live.includes("user:Web:under $600, fireplace a bonus") && live.includes("assistant:Web:re: under $600, fireplace a bonus"), live.join(" | "));
step("the stream showed Reason working on it (typing)", s.events.some(e => e.event === "typing" && e.data.on));
step("nothing went to the phone for the Web message", phone.sent.length === sentBefore);

// 4. Refresh / second tab / retry: the same id is one turn.
const tab2 = signIn(KOFI_C);
const csrf2 = csrfOf((await page(tab2)).body);
const turnsBefore = turns.length;
const r1 = await post(kofi, csrf, "drive-w-0001", "under $600, fireplace a bonus");
const r2 = await post(tab2, csrf2, "drive-w-0001", "under $600, fireplace a bonus");
await new Promise(r => setTimeout(r, 100));
step("the same id again from this tab and a second tab: duplicate, no new turn, one history row", r1.json?.duplicate === true && r2.json?.duplicate === true && turns.length === turnsBefore && db.messagesFor(KOFI_C).filter(m => m.text === "under $600, fireplace a bonus").length === 1);

// 5. Ama: never sees Kofi; her stream hears nothing of his.
const ama = signIn(AMA_C);
const amaPage = await page(ama);
const as = listen(ama);
await until(() => as.events.status === 200);
await post(kofi, csrf, "drive-w-0002", "kofi only");
await until(() => db.messagesFor(KOFI_C).some(m => m.text === "re: kofi only"));
await new Promise(r => setTimeout(r, 100));
step("Ama's page, history and stream hold nothing of Kofi's", !/fireplace|november|kofi/i.test(amaPage.body) && (await hist(ama, "after=0")).messages.length === 0 && as.events.filter(e => e.event === "message").length === 0);
const forged = await hist(ama, `before=${db.messagesFor(KOFI_C).at(-1).id}&conversationId=${encodeURIComponent(KOFI_C)}`);
step("an id from Kofi's history, and his conversation named in the query, find nothing for Ama", forged.messages.length === 0);
as.close();

// 6. Close the tab mid-work: the answer is waiting when Kofi comes back.
s.close();
const slow = await post(kofi, csrf, "drive-w-0003", "slow: compare three inns");
const noAnswerYet = !db.messagesFor(KOFI_C).some(m => m.text === "re: slow: compare three inns");
release();
const landed = await until(() => db.messagesFor(KOFI_C).some(m => m.role === "assistant" && /compare three inns/.test(m.text)));
step("a slow turn: acknowledged at once, tab closed, answer lands anyway", slow.status === 200 && noAnswerYet && landed);
// The thread page opens with L1 (OPENING YOUR THREAD…) and fetches its newest page, as here.
const back = await page(kofi, "?thread");
step("back on the page, the answer is there", back.status === 200 && /OPENING YOUR THREAD/.test(back.body) && (await hist(kofi, "")).messages?.some(m => /compare three inns/.test(m.text)));

// 7. Decision 9: back on the phone, the next text carries the Web line once.
await router.deliver({ channel: "fake", externalId: "k-t2", from: KOFI, text: "on my phone now", chatId: null, at: Date.now() });
await router.deliver({ channel: "fake", externalId: "k-t3", from: KOFI, text: "and again", chatId: null, at: Date.now() });
const texts = phone.sent.slice(-2).map(m => m.text);
step("decision 9: the first text after Web carries the line, the next does not", texts[0] === `re: on my phone now\n\n${WEB_HINT}` && texts[1] === "re: and again", JSON.stringify(texts));
// Owner 10-27 "should say it only once": a second switch from Web never earns it again.
await post(kofi, csrf, "drive-w-0004", "back on web");
await until(() => db.messagesFor(KOFI_C).some(m => m.text === "re: back on web"));
await router.deliver({ channel: "fake", externalId: "k-t4", from: KOFI, text: "phone again", chatId: null, at: Date.now() });
await until(() => phone.sent.some(m => m.text.startsWith("re: phone again")));
const again = phone.sent.at(-1).text;
step("decision 9: once per person: a second switch from Web does not repeat the line", again === "re: phone again" && phone.sent.filter(m => m.text.includes(WEB_HINT)).length === 1 && !!db.getThread(KOFI_C).web_hint_told_at, JSON.stringify(again));

// 8. Refusals over the wire.
const anon = await fetch(`${BASE}/web/history?after=0`);
const xsite = await post(kofi, csrf, "drive-x-0001", "hi", { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
const nosecret = await post(kofi, "nope", "drive-x-0002", "hi");
step("signed out 401; cross-site 403; wrong secret 403", anon.status === 401 && xsite.status === 403 && nosecret.status === 403);
const ls = listen(kofi, 1e9);
await until(() => ls.events.status === 200);
db.endPageSession(kofi.token);
const endedBySignout = await until(() => ls.events.some(e => e.event === "signedout"), 15_000);
step("signing out elsewhere ends the open stream", endedBySignout);
ls.close();

server.close();
process.exit(fails ? 1 : 0);
