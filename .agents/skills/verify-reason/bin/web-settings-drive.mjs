#!/usr/bin/env node
// Drive Reason Web Settings end to end over REAL HTTP: src/http.js createServer on a loopback port,
// the real Router, Runtime, outbox, WebChannel and a FakeChannel for the phone line. Every request is
// one a browser makes WITHOUT script (forms post, 303 back), and every text is one a phone would
// receive, captured by the fake. Run under the cage's env so it gets its own database and every
// texting credential blanked:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/settings.db node .agents/skills/verify-reason/bin/web-settings-drive.mjs
//
// Prints one line per step, `ok` or `FAIL`, and exits non-zero on any FAIL.
process.env.REASON_WEB = "on";
process.env.REASON_PAGES_URL = process.env.REASON_PAGES_URL || "https://files.example.test";
process.env.REASON_SITE_URL = "http://127.0.0.1";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_CUES = "owner"; // live is owner: THINKING AHEAD for the operator only
process.env.REASON_TOKEN_KEY ||= "44".repeat(32);
delete process.env.REASON_SITE_PROXY_SECRET;
delete process.env.REASON_INVITES_OPEN;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/settings.db");
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
const st = await imp("src/pages/websettings.js");
const db = await imp("src/db.js");

const OWNER = "+12025551234", KOFI = "+14155559876", LINE = "+16562167455";
const OWNER_C = "dm:owner", KOFI_C = `dm:fake:${KOFI}`;
for (const [c, a, n, op] of [[OWNER_C, OWNER, "Omari", true], [KOFI_C, KOFI, "Kofi", false]]) {
  db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
  db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
}
db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");

const router = new Router({});
const consoleChannel = new ConsoleChannel({ write: () => {} });
const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
const runtime = new Runtime({ channels: router, deliver, runTurn: async () => "ok" });
router.runtime = runtime;
router.register(consoleChannel);
const phone = router.register(new FakeChannel({ number: LINE }));
router.register(new WebChannel());
const server = createServer({ router, runtime, log: (e) => { if (e.threw) console.log("THREW", e.threw); } });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!(await pred()) && Date.now() < end) await new Promise(r => setTimeout(r, 15)); return pred(); };
const UA = { mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36", phone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Version/18.1 Mobile/15E148 Safari/604.1" };
const signIn = (conv, ua) => { const t = `drive-${Math.random().toString(36).slice(2)}`; db.startPageSession(`wsign:${conv}`, t, { conversationId: conv }); return { cookie: `reason_page=${t}`, token: t, ua, csrf: db.pageSessionCsrf(t) }; };
const H = (b, extra = {}) => ({ cookie: b.cookie, "user-agent": b.ua, origin: BASE, "sec-fetch-site": "same-origin", ...extra });
const get = async (b, path = "/web/settings") => { const r = await fetch(`${BASE}${path}`, { headers: H(b), redirect: "manual" }); return { status: r.status, body: await r.text(), location: r.headers.get("location") }; };
const form = async (b, fields, extra = {}) => { const r = await fetch(`${BASE}/web/settings`, { method: "POST", redirect: "manual", headers: H(b, { "content-type": "application/x-www-form-urlencoded", ...extra }), body: new URLSearchParams({ c: b.csrf, ...fields }) }); return { status: r.status, location: r.headers.get("location") }; };

const phoneB = signIn(OWNER_C, UA.phone);
await get(phoneB, "/web?thread");
const me = signIn(OWNER_C, UA.mac);
const kofi = signIn(KOFI_C, UA.phone);
const p = await get(me);
step("GET /web/settings: 200, Settings, every section", p.status === 200 && /class="st-h1">Settings</.test(p.body) && ["HOW REASON REACHES YOU", "SIGNED-IN BROWSERS", "BROWSER NOTIFICATIONS", "CONNECTED", "INVITES", "THEME"].every(t => p.body.includes(`${t}</h2>`)));
step("browsers: this one 'you're here' (Chrome on Mac), the phone with SIGN OUT, nobody else's", /Chrome on Mac.*you're here/.test(p.body) && /Safari on iPhone.*SIGN OUT/.test(p.body) && (p.body.match(/class="br-row/g) ?? []).length === 2);
step("signed out: 303 to /web", (await get({ cookie: "", ua: "" })).location === "/web");
step("a post from another site or with another's secret: 403", (await form(me, { do: "reach", reach: "web" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status === 403 && (await form({ ...me, csrf: kofi.csrf }, { do: "reach", reach: "web" })).status === 403);

// Reach: a finished job's result, texted by default, kept on Web once chosen.
const t1 = db.createTask(OWNER_C, { title: "dentist", goal: "dentist", maxAttempts: 3 }); db.finishTask(OWNER_C, t1.id, { state: "done", outcome: "ok" });
await deliver({ conversationId: OWNER_C, text: "Found a dentist for Tuesday.", fromTask: t1.id });
step("reach default ('everything'): a finished job's result is texted", await until(() => phone.sent.some(m => m.text.includes("dentist for Tuesday"))) && /Text me for <a class="ph" href="\/web\/settings\?edit=reach"[^>]*>everything<\/a>/.test(p.body));
const edit = await get(me, "/web/settings?edit=reach");
step("5A: the radio list of four, 'everything' checked, Save → / CANCEL", (edit.body.match(/<label class="ro">/g) ?? []).length === 4 && /value="text" data-name="everything" checked/.test(edit.body) && /Save <span aria-hidden="true">→<\/span>/.test(edit.body) && />CANCEL</.test(edit.body));
const r1 = await form(me, { do: "reach", reach: "web" });
step("Save 'timely decisions' (no script): 303 to 5B, saved", r1.status === 303 && r1.location === "/web/settings?saved=reach" && db.webReach(OWNER_C) === "web");
step("5B: 'timely decisions' / 'routine results' + the Caveat line", /timely decisions<\/a>\. Keep <a[^>]*>routine results<\/a> here\.<\/p><p class="hand tilt" role="status">got it\./.test((await get(me, "/web/settings?saved=reach")).body));
const sent = phone.sent.length;
await deliver({ conversationId: OWNER_C, text: "Your passport form is filled in.", fromTask: t1.id });
step("kept here: the result is on Web, nothing texted", await until(() => db.messagesFor(OWNER_C).some(m => m.channel === "web" && m.text.includes("passport"))) && phone.sent.length === sent);
await deliver({ conversationId: OWNER_C, text: "Reminder: call mum at 6." });
step("a reminder is still texted", await until(() => phone.sent.some(m => m.text.includes("call mum"))));
await form(me, { do: "reach", reach: "yes" });
await deliver({ conversationId: OWNER_C, text: "Reminder: water the plants.", idempotencyKey: "timer:900:fire" });
step("'only what needs a yes': a reminder waits on Web, not texted", await until(() => db.messagesFor(OWNER_C).some(m => m.channel === "web" && m.text.includes("water the plants"))) && !phone.sent.some(m => m.text.includes("water the plants")));
db.askConfirmation({ conversationId: OWNER_C, action: "purchase_confirm", summary: "Buy the lamp, $40", stakes: "money", askedAfterMsgs: 0 });
await deliver({ conversationId: OWNER_C, text: "The lamp is $40 all in. Want it?" });
step("'only what needs a yes': the message asking for a yes is texted", await until(() => phone.sent.some(m => m.text.includes("lamp is $40"))));
await form(me, { do: "reach", reach: "none" });
await deliver({ conversationId: OWNER_C, text: "Your Reason code is 445566", idempotencyKey: "wsign:dm:owner:77" });
step("'nothing': a sign-in code is still texted", await until(() => phone.sent.some(m => m.text.includes("445566"))));
await form(me, { do: "reach", reach: "text" });
step("Save 'everything': back to texting everything", db.webReach(OWNER_C) === "text");

// Notifications (8A–8C): the signal, this browser's setting, the icons.
const sig = await fetch(`${BASE}/web/signal`, { headers: H(me) });
const sj = await sig.json();
step("GET /web/signal: this person's needs (the lamp), notify off", sig.status === 200 && sj.needs.some(n => n.approval) && sj.notify === false);
step("GET /web/signal signed out: 401", (await fetch(`${BASE}/web/signal`)).status === 401);
const on = await fetch(`${BASE}/web/settings`, { method: "POST", headers: H(me, { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }), body: new URLSearchParams({ c: me.csrf, do: "notify", on: "1" }) });
step("8C: on for this browser only", on.status === 200 && db.pageSessionNotify(me.token) && !db.pageSessionNotify(phoneB.token) && /On in this browser\./.test((await get(me)).body));
await form(me, { do: "notify", on: "0" });
step("8C: turned off by a plain form", !db.pageSessionNotify(me.token));
const ic = await fetch(`${BASE}/web/icons/favicon-needs-you.svg`);
step("I1: /web/icons serves the filled mark; pages link it", ic.status === 200 && /favicon-needs-you\.svg\?v=/.test(p.body));
step("theme switch only in Settings: none on the chat", !/class="themes"/.test((await get(me, "/web?thread")).body));

// Theme.
const th = await form(me, { do: "theme", theme: "night" });
const other = await get(phoneB, "/web?thread");
step("theme Night saved; another browser's page opens Night (server-drawn)", th.status === 303 && /<html lang="en" data-account-theme="night" data-c="[^"]+" data-theme="dark"/.test(other.body));
await form(me, { do: "theme", theme: "auto" });

// Thinking ahead (src/cues.js, REASON_CUES=owner here as on live): the owner's own switch; Kofi has none.
const cues = await imp("src/cues.js");
const ah0 = await get(me);
step("THINKING AHEAD: the owner sees the section (On.) and its index entry; Kofi does not", /<section class="st-sec" id="ahead"[^>]*><h2 id="ah-h">THINKING AHEAD<\/h2><p class="nt-p">On\.<\/p>/.test(ah0.body) && ah0.body.includes('href="#ahead"') && !(await get(kofi)).body.includes('id="ahead"'));
const ahOff = await form(me, { do: "ahead", on: "0" });
step("TURN OFF: 303 to ?done=ahead#ahead, opted out, the page reads Off.", ahOff.location === "/web/settings?done=ahead#ahead" && cues.optedOut(OWNER_C) && /id="ah-h">THINKING AHEAD<\/h2><p class="nt-p">Off\.<\/p>/.test((await get(me)).body));
const ahOn = await form(me, { do: "ahead", on: "1" });
const kofiAh = await form(kofi, { do: "ahead", on: "0" });
step("TURN ON puts it back; Kofi's post changes nothing (back to #reach)", ahOn.location === "/web/settings?done=ahead#ahead" && !cues.optedOut(OWNER_C) && kofiAh.location === "/web/settings#reach");

// Invites: make one, then cancel it (no invite is spent).
const before = db.listInvites(OWNER_C).length;
const inv = await form(me, { do: "invite" });
const made = db.listInvites(OWNER_C).at(-1);
step("Make an invite link: 303 to 5D, an UNUSED link on the page", inv.location === `/web/settings?invite=${made.id}` && db.listInvites(OWNER_C).length === before + 1 && (await get(me)).body.includes(">UNUSED<"));
const fiveD = await get(me, inv.location);
step("5D: the link card, NEW LINK · UNUSED, '1 left'", /NEW LINK · UNUSED<\/span><a class="iv-link" href="[^"]+\/i\/[A-Za-z0-9_-]{32}">/.test(fiveD.body) && /<p class="iv-n">1 left<\/p>/.test(fiveD.body));
const cx = await form(me, { do: "cancel-invite", i: String(made.id) });
step("CANCEL from Web: canceled, stamped CANCELED, the slot is back", cx.location === "/web/settings?done=invite-canceled#invites" && (await get(me)).body.includes(">CANCELED<") && /<p class="inv-n">2 left<\/p>/.test((await get(me)).body));
step("Kofi (invites dark): no invites section", !(await get(kofi)).body.includes('id="invites"'));

// Browsers.
const out1 = await form(me, { do: "browser", b: st.sessionHandle(db.sessionKey(phoneB.token)) });
step("SIGN OUT the phone: its session opens nothing; this one stays", out1.location === "/web/settings?done=browsers#browsers" && (await get(phoneB)).location === "/web" && (await get(me)).status === 200);
await form(me, { do: "browser", b: st.sessionHandle(db.sessionKey(kofi.token)) });
step("a handle from Kofi's list ends nothing", (await get(kofi)).status === 200);
const five = await get(me, "/web/settings?confirm=everywhere");
step("5C: asks first with the real count; nobody signed out yet", /<p class="so-n">1 browser: this one\.<\/p>/.test(five.body) && />KEEP ME IN</.test(five.body) && (await get(me)).status === 200);
const all = await form(me, { do: "everywhere" });
step("Sign out everywhere: this browser out too, Kofi untouched", all.location === "/web?out=1" && (await get(me)).location === "/web" && (await get(kofi)).status === 200);

server.close();
process.exit(fails ? 1 : 0);
