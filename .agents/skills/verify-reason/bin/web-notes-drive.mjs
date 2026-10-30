#!/usr/bin/env node
// Drive Reason Web's notes and file chips (src/pages/webnotes.js, src/sentfiles.js, src/webmedia.js)
// over REAL HTTP: src/http.js createServer on a loopback port, history rows stored the way live
// stores them (a shared location, an inline reply, a contact card, a .docx Reason texted), read back
// through /web?thread, /web/history and the chip's /web/media/m/<row>/<i> link. No model is called,
// nothing is texted, no sound. Run under the cage's env:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && D=$(mktemp -d) && REASON_DATA_DIR=$D REASON_DB_PATH=$D/web.db node .agents/skills/verify-reason/bin/web-notes-drive.mjs
//
// Prints one line per step, `ok` or `FAIL`, and exits non-zero on any FAIL.
process.env.REASON_WEB = "on";
process.env.REASON_SITE_URL = "http://127.0.0.1";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_TZ ||= "America/New_York";
delete process.env.REASON_SITE_PROXY_SECRET;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dbp = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = dbp && existsSync(dirname(dbp)) ? realpathSync(dirname(dbp)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  const data = process.env.REASON_DATA_DIR && existsSync(process.env.REASON_DATA_DIR) ? realpathSync(process.env.REASON_DATA_DIR) + "/" : "";
  if (!dbp || existsSync(dbp) || !parent || !roots.some(r => parent.startsWith(r)) || !data || !roots.some(r => data.startsWith(r))) {
    console.error("refusing: set REASON_DATA_DIR to a temp directory and REASON_DB_PATH to a new file in it");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";

const { mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
const { join } = await import("node:path");
const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { createServer } = await imp("src/http.js");
const { config } = await imp("src/config.js");
const db = await imp("src/db.js");

const KOFI_C = "dm:fake:+14155559876", AMA_C = "dm:fake:+13475550000";
for (const [c, a, n] of [[KOFI_C, "+14155559876", "Kofi"], [AMA_C, "+13475550000", "Ama"]]) {
  db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
  db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
}
db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");

const router = new Router({});
const runtime = new Runtime({ channels: router, deliver: async () => {}, runTurn: async () => "ok" });
router.runtime = runtime;
const server = createServer({ router, runtime });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0, seq = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const signIn = (conv) => { const t = `drive-${Math.random().toString(36).slice(2)}`; db.startPageSession(`wsign:${conv}`, t, { conversationId: conv }); return { cookie: `reason_page=${t}` }; };
const get = async (b, path, extra = {}) => {
  const r = await fetch(`${BASE}${path}`, { headers: { origin: BASE, "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}), ...extra } });
  return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
};
const said = (conv, role, text, media = [], outboxId = null) => db.writeMessage({ conversationId: conv, role, channel: "sendblue", externalId: role === "user" ? `e${++seq}` : null, outboxId, text, media, at: Date.now() - 60_000 + ++seq });

// The rows, as live stores them.
const LOCATION = "�\n[they shared their location: Lefcourt Clothing Center Building, 164, West 26th Street, Chelsea District, Manhattan Community Board 4, Manhattan, New York County, New York, 10001, United States (40.7458123, -73.9940456, accuracy ~19m) (sharing: endOfDay) — this is their current position. Use nearby_places with these coordinates for anything near them.]";
said(KOFI_C, "user", LOCATION);
said(KOFI_C, "user", '[they sent this as an inline reply in the thread under your message: "want me to book it for 7?" — so it is about that]\nyes please');
said(KOFI_C, "user", "[they shared a contact card (Ama.vcf) — here is what it says:\nname: Ama Mensah\nphone (cell): +13475550000]");
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(12511, 7)]);
mkdirSync(config.documentRoot, { recursive: true });
const docPath = join(config.documentRoot, "dSuQmP5wnG-reason-onboarding-build-prompt.docx");
writeFileSync(docPath, DOCX);
const ob = (conv, file, filename, mime = DOCX_MIME) => db.enqueueOutbound({ idemKey: `k${++seq}`, conversationId: conv, channel: "fake", address: "+1", body: "here's the doc", media: { file, mimeType: mime, filename } }).row.id;
said(KOFI_C, "assistant", "here's the onboarding prompt as a doc", [{ kind: "file", mimeType: DOCX_MIME, filename: "reason-onboarding-build-prompt.docx" }], ob(KOFI_C, docPath, "reason-onboarding-build-prompt.docx"));
const docRow = db.db.prepare("SELECT id FROM messages ORDER BY id DESC LIMIT 1").get().id;
// A symlink inside the documents root pointing out of it, on a row of its own.
const outside = join(process.env.REASON_DATA_DIR, "secret.txt"); writeFileSync(outside, "nope");
const link = join(config.documentRoot, "x-link.docx"); symlinkSync(outside, link);
said(KOFI_C, "assistant", "a link", [{ kind: "file", mimeType: DOCX_MIME, filename: "x-link.docx" }], ob(KOFI_C, link, "x-link.docx"));
const linkRow = db.db.prepare("SELECT id FROM messages ORDER BY id DESC LIMIT 1").get().id;

const kofi = signIn(KOFI_C), ama = signIn(AMA_C);
const page = await get(kofi, "/web?thread");
const html = page.bytes.toString();
const RAW = /nearby_places|40\.745|-73\.99|accuracy ~|\[they |\[replying to|current position|�|Community Board/;
step("GET /web?thread: 200", page.status === 200);
step("the shared location is a tag: SHARED LOCATION · UNTIL END OF DAY, 164 W 26th St, Chelsea", /class="wnote wloc"/.test(html) && /SHARED LOCATION · UNTIL END OF DAY/.test(html) && /164 W 26th St, Chelsea/.test(html));
step("no raw note anywhere on the page: no coordinates, no tool instructions, no '?'", !RAW.test(html), RAW.exec(html)?.[0] ?? "");
step("the reply and the contact card are tags too", /IN REPLY TO/i.test(html) && /Ama Mensah/.test(html));
step("the .docx is a chip that links to its file, under its real name", new RegExp(`href="/web/media/m/${docRow}/0"[^>]* download="reason-onboarding-build-prompt\\.docx"`).test(html) && /DOCX · 12 KB · DOWNLOAD/.test(html));
step("the symlink that leaves the root has no link", !html.includes(`/web/media/m/${linkRow}/0`));

const f = await get(kofi, `/web/media/m/${docRow}/0`);
step("the chip's link: 200, the same bytes, the .docx type, attachment under its name, nosniff", f.status === 200 && Buffer.compare(f.bytes, DOCX) === 0 && f.headers.get("content-type") === DOCX_MIME && /^attachment; filename="reason-onboarding-build-prompt\.docx"/.test(f.headers.get("content-disposition") ?? "") && f.headers.get("x-content-type-options") === "nosniff");
step("Ama (signed in, another person) gets 404", (await get(ama, `/web/media/m/${docRow}/0`)).status === 404);
step("signed out gets 404", (await get(null, `/web/media/m/${docRow}/0`)).status === 404);
step("the symlink row gets 404", (await get(kofi, `/web/media/m/${linkRow}/0`)).status === 404);
const odd = await Promise.all([`/web/media/m/${docRow}/1`, `/web/media/m/..%2f..%2fetc/0`, `/web/media/m/${docRow}%00/0`, `/web/media/m/-${docRow}/0`].map(p => get(kofi, p)));
step("other indexes and traversal-shaped paths get 404", odd.every(r => r.status === 404), odd.map(r => r.status).join(","));

const hist = await (await fetch(`${BASE}/web/memory/history?q=Chelsea`, { headers: { cookie: kofi.cookie, origin: BASE, "sec-fetch-site": "same-origin", accept: "application/json" } })).text();
step("history search finds the place by its short name, with no raw note", /Chelsea/.test(hist) && !/nearby_places|40\.745/.test(hist));

server.close();
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
