#!/usr/bin/env node
// Drive Reason Web's Saved screen end to end over REAL HTTP: src/http.js createServer on a loopback
// port, the store in a throwaway database. Every request is one a browser makes — the list, a kind,
// a search, an opened item, the framed page, the PIN / REMOVE / PUT IT BACK form posts, FIND IT IN
// THE CHAT's thread — and every claim is checked against the store. No model is called. Run under the cage:
//
//   cd <checkout> && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/saved.db node .agents/skills/verify-reason/bin/web-saved-drive.mjs
//
// One line per step, `ok` or `FAIL`; exits non-zero on any FAIL.
process.env.REASON_WEB = "on";
process.env.REASON_PAGES_URL = process.env.REASON_PAGES_URL || "https://files.example.test";
process.env.REASON_SITE_URL = "http://127.0.0.1";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NAME = "Omari";
delete process.env.REASON_SITE_PROXY_SECRET;
delete process.env.REASON_BACKEND;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/saved.db");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { createServer } = await imp("src/http.js");
const db = await imp("src/db.js");
const saved = await imp("src/saved.js");

const OWNER_C = "dm:fake:+13475550000", KOFI_C = "dm:fake:+14155559876";
db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+13475550000", name: "Omari" });
db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: "+14155559876", name: "Kofi" });
db.markWebNoticeSeen(OWNER_C);

const server = createServer({ router: null, runtime: null, log: (e) => { if (e?.threw) console.error("THREW", e.threw); } });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const token = "drive-token-saved";
db.startPageSession(`wsign:${OWNER_C}`, token, { conversationId: OWNER_C });
const csrf = db.pageSessionCsrf(token);
const H = { cookie: `reason_page=${token}`, origin: BASE, "sec-fetch-site": "same-origin" };
const get = (p) => fetch(BASE + p, { headers: H, redirect: "manual" });
const post = (p, o, extra = {}) => fetch(BASE + p, { method: "POST", headers: { ...H, "content-type": "application/x-www-form-urlencoded", ...extra }, body: new URLSearchParams(o), redirect: "manual" });

let fails = 0;
const step = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) fails++; };

step("empty: Nothing saved yet + Caveat", /Nothing saved<br>yet\./.test(await (await get("/web/saved")).text()));

const p = db.createPage(OWNER_C, { title: "Dinner, Friday, three that fit", blocks: [{ type: "text", text: "Peaches is closest to everyone." }] });
const kofiPage = db.createPage(KOFI_C, { title: "Kofi's list", blocks: [{ type: "text", text: "x" }] });
const c = db.createCall(OWNER_C, { provider: "fake", toNumber: "+12125550000", isOwner: false, goal: "Book a cleaning at Dr. Patel's office", facts: [] });
db.db.prepare("UPDATE calls SET state='completed', outcome_kind='confirmed', summary='Booked Tuesday at 10.', duration_s=102, label='Dr. Patel''s office', ended_at=? WHERE id=?").run(Date.now(), c.id);
db.db.prepare("INSERT INTO agentcard_purchases (conversation_id, buy_conversation_id, status, amount_cents, merchant, created_at, updated_at) VALUES (?, 'd1', 'placed', 8740, 'Con Ed', ?, ?)").run(OWNER_C, Date.now(), Date.now());
db.db.prepare("INSERT INTO agentcard_purchases (conversation_id, buy_conversation_id, status, amount_cents, merchant, created_at, updated_at) VALUES (?, 'd2', 'cart_shown', 100, 'Target', ?, ?)").run(OWNER_C, Date.now(), Date.now());

let list = await (await get("/web/saved")).text();
step("list: ALL 3 (a shown cart is not a receipt)", /aria-current="true">ALL 3</.test(list) && !/(?<!Event)Target/.test(list));  // not EventTarget in the loading kit's script
step("list: BOOKED + CALL · 1:42 meta", />BOOKED<\/span><span class="sv-m">CALL · 1:42 · /.test(list));
step("list: PAID receipt", />PAID<\/span><span class="sv-m">RECEIPT · /.test(list));
step("list: nothing of Kofi's", !/Kofi/.test(list));
step("kind: CALLS 1", /aria-current="true">CALLS 1</.test(await (await get("/web/saved?kind=calls")).text()));
step("search reads the page's words", /Dinner, Friday/.test(await (await get("/web/saved?q=peaches")).text()));

const opened = await get(`/web/saved/page/${p.id}`);
const ot = await opened.text();
step("opened: CSP allows its own frame only", /frame-src 'self'/.test(opened.headers.get("content-security-policy") ?? ""));
step("opened: PIN · OPEN THE PAGE ↗ · REMOVE FROM SAVED", />PIN</.test(ot) && /OPEN THE PAGE ↗/.test(ot) && /REMOVE FROM SAVED/.test(ot));
const fr = await get(`/web/saved/page/${p.id}/frame`);
step("frame: the page itself, framed by this origin only", fr.status === 200 && fr.headers.get("x-frame-options") === "SAMEORIGIN" && /Peaches is closest/.test(await fr.text()));
step("frame: another person's page is 404", (await get(`/web/saved/page/${kofiPage.id}/frame`)).status === 404);

const m = db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "fake", text: `Three that fit: ${process.env.REASON_PAGES_URL}/${p.id}` });
const mid = typeof m === "object" ? m.id : m;
step("FIND IT IN THE CHAT once the chat carries it", new RegExp(`at=${mid}#m-${mid}`).test(await (await get(`/web/saved/page/${p.id}`)).text()));
step("the thread opens at that message", new RegExp(`id="m-${mid}"`).test(await (await get(`/web?thread&at=${mid}`)).text()));

step("pin refused without the secret", (await post("/web/saved/pin", { c: "x", k: `page-${p.id}`, on: "1" })).status === 403);
step("pin: 303 back", (await post("/web/saved/pin", { c: csrf, k: `page-${p.id}`, on: "1" })).status === 303);
step("pin: PINNED shows", /PINNED/.test(await (await get("/web/saved")).text()));
step("remove: 303 to the notice", (await post("/web/saved/remove", { c: csrf, k: `page-${p.id}` })).headers.get("location") === `/web/saved?removed=page-${p.id}`);
step("remove: hidden, page untouched", !saved.savedItems(OWNER_C).some(i => i.id === p.id) && !!db.getPage(p.id));
step("remove: PUT IT BACK offered", /PUT IT BACK/.test(await (await get(`/web/saved?removed=page-${p.id}`)).text()));
await post("/web/saved/restore", { c: csrf, k: `page-${p.id}` });
step("restore: back, unpinned", saved.savedItems(OWNER_C).some(i => i.id === p.id && !i.pinnedAt));
step("another person's key is 404", (await post("/web/saved/remove", { c: csrf, k: `page-${kofiPage.id}` })).status === 404);

server.close();
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
