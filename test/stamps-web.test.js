// Stamps on the web (src/pages/webstamps.js, reference/stamps.html) and shared stamps (/s/<shareId>).
// One pinned test per rule:
//
//   - REASON_WEB_DAILY off (or owner, for anybody but the operator): /web/stamps is E1's 404, the API
//     answers 404 — exactly what those addresses answered before
//   - the book: PAGE N · count · SINCE MONTH, "Your stamp book.", HOME · THE THREAD · STAMPS with STAMPS
//     current, 8 spots a page, NEW in pen on the newest, a 44px share link "Share {name}" per stamp,
//     blank dashed spots with at most 2 hints a page; states empty / first stamp / many pages; ?stamp=
//     selects without script
//   - sharing: POST /web/api/stamps/<id>/share needs sign-in, same origin and the session secret; the
//     url is heyreason.com/s/<12 base62>, never the stamp id; the same link again; somebody else's stamp
//     is refused; Stop sharing turns it off; no-script form posts come back to the page
//   - /s/<shareId>: no sign-in, noindex (meta + X-Robots-Tag), the large stamp, its line, the CTA with
//     ?ref=s_<id>, og:image + summary_large_image; revoked: E2 "turned off", 410, og → the generic card
//   - /s/ collision: a sign-in link token (32+ base64url) still reaches the ride-along handler; a
//     12-character path with no share falls through to it unchanged
//   - REDACTION: merchant, company, city, price and person never appear in any public output
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-stamps-web-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";
delete process.env.REASON_WEB_DAILY;
delete process.env.REASON_BACKEND;

const { webRequestFor, createServer } = await import("../src/http.js");
const db = await import("../src/db.js");
const stamps = await import("../src/stamps.js");
const ws = await import("../src/pages/webstamps.js");
const remote = await import("../src/signin-remote.js");
const sites = await import("../src/sites.js");
const { config, clock } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const KOFI_C = "dm:fake:+14155559876";
const drawn = [];

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  process.env.REASON_WEB_DAILY = "owner";
  drawn.length = 0;
  rmSync(join(dir, "cards"), { recursive: true, force: true });
  ws.setStampShooter(async (html) => { drawn.push(html); return Buffer.from(`PNG:${drawn.length}:${html.length}`); });
  db.db.exec(`DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM page_sessions; DELETE FROM stamps; DELETE FROM stamp_shares; DELETE FROM messages;`);
  for (const [c, a, n, op] of [[OWNER_C, "+12025551234", "Omari Nyarko", true], [KOFI_C, "+14155559876", "Kofi", false]]) {
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
async function call({ sub = "stamps", method = "GET", b = null, query = {}, body = null, headers = {} } = {}) {
  return await webRequestFor({ sub, method, query, headers: headersFor(b, headers), remoteAddress: "127.0.0.1", readBody: async () => body, runtime: null, router: null, log: () => {} });
}
const T0 = Date.parse("2026-08-14T16:00:00Z");
/** A stamp straight into the book, as a completion would have written it (the detail carries private things). */
function seed(conv, type, { at = T0, detail = {}, ref = null } = {}) {
  const r = db.db.prepare(`INSERT INTO stamps (conversation_id, type, ref, earned_at, detail_json, rotation, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'live', ?)`)
    .run(conv, type, ref ?? `t:${Math.random()}`, at, JSON.stringify(detail), stamps.rotationFor(conv, type, String(at)), at);
  return Number(r.lastInsertRowid);
}
async function share(b, id, showName = true) {
  const out = await call({ sub: `api/stamps/${id}/share`, method: "POST", b, body: JSON.stringify({ showName }), headers: { "content-type": "application/json", accept: "application/json", "x-reason-csrf": b.csrf } });
  return { out, json: out.status === 200 ? JSON.parse(out.body) : null };
}
async function server(fn) {
  const s = createServer({ router: { statuses: () => [] }, runtime: null });
  await new Promise(r => s.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${s.address().port}`); } finally { await new Promise(r => s.close(r)); }
}

test("flag off: /web/stamps is the same E1 404 as before, and the API is a 404", async () => {
  process.env.REASON_WEB_DAILY = "";
  const b = browser(OWNER_C);
  const id = seed(OWNER_C, "first");
  const page = await call({ b });
  assert.equal(page.status, 404);
  assert.match(page.body, /This page isn’t here/);
  assert.equal((await share(b, id)).out.status, 404);
  // owner mode, somebody else's browser: the same.
  process.env.REASON_WEB_DAILY = "owner";
  const k = browser(KOFI_C);
  assert.equal((await call({ b: k })).status, 404);
  assert.equal((await call({})).status, 404, "signed out");
});

test("empty: PAGE 1 · NO STAMPS YET, the header with STAMPS current, eight blank spots, two hints, the keep line", async () => {
  const out = await call({ b: browser(OWNER_C) });
  assert.equal(out.status, 200);
  const h = out.body;
  assert.match(h, /PAGE 1 · NO STAMPS YET/);
  assert.match(h, /<h1 class="sb-h1">Your stamp book\.<\/h1>/);
  assert.match(h, /<nav aria-label="Reason"><a href="\/web\?home">HOME<\/a><a href="\/web\?thread">THE THREAD<\/a><a href="\/web\/stamps" aria-current="page">STAMPS<\/a><\/nav>/);
  assert.equal((h.match(/aria-label="Blank spot, not earned yet"/g) ?? []).length, 8);
  assert.equal((h.match(/<p class="hint">/g) ?? []).length, 2);
  assert.match(h, /the first thing I finish for you/);
  assert.match(h, /Stamps land when I do something worth remembering\. There&#39;s nothing to keep up and nothing to lose\./);
  assert.doesNotMatch(h, /SHARE THIS STAMP/, "nothing to share yet");
  assert.doesNotMatch(h, /streak|points|level|don’t break|don't break/i);
});

test("first stamp: 1 STAMP SINCE AUGUST, NEW in pen, the share link, the aside with story, keep line, thread link and share panel", async () => {
  const id = seed(OWNER_C, "first");
  const h = (await call({ b: browser(OWNER_C) })).body;
  assert.match(h, /PAGE 1 · 1 STAMP SINCE AUGUST/);
  assert.match(h, /<span class="spot-d new">AUG 14 · NEW<\/span>/);
  assert.match(h, new RegExp(`<a class="sh-b" href="/web/stamps\\?page=1&amp;stamp=${id}#share" aria-label="Share First errand"`));
  assert.match(h, /role="img" aria-label="Stamp: First errand"/);
  assert.match(h, /THE NEWEST/);
  assert.match(h, /<h2 id="sel-h">First errand\.<\/h2>/);
  assert.match(h, /This is where the book starts\./);
  assert.match(h, /<a class="in-thread" href="\/web\?thread">See it in the thread<\/a>/);
  assert.match(h, /SHARE THIS STAMP/);
  assert.match(h, /Show my first name/);
  assert.match(h, /Reason ran a first errand so Omari didn&#39;t have to\./);
  assert.match(h, /data-without="Reason ran a first errand so I didn&#39;t have to\."/);
  assert.match(h, />Copy link<\/button>/);
  assert.match(h, /data-sms hidden>Send in iMessage<\/a>/, "hidden until the page knows it's an Apple device");
  assert.match(h, /href="\/web\/api\/stamps\/\d+\/image\.png\?name=1" download="reason-stamp-first\.png"[^>]*>Save image</);
  assert.match(h, /Never who, where, or what it cost\./);
  assert.match(h, /class="stop-f" hidden/, "Stop sharing only once a link exists");
  assert.match(h, /seven blank spots left on this page\./);
  assert.equal((h.match(/<p class="hint">/g) ?? []).length, 2);
});

test("many pages: 8 a page in the order earned, newest page by default, a page switcher, ?stamp= selects (and its page) without script", async () => {
  const ids = [];
  for (let i = 0; i < 19; i++) ids.push(seed(OWNER_C, i % 2 ? "night_shift" : "long_hold", { at: T0 + i * 86_400_000, detail: { minutes: 30 + i, time: T0 } }));
  const b = browser(OWNER_C);
  let h = (await call({ b })).body;
  assert.match(h, /PAGE 3 · 19 STAMPS SINCE AUGUST/);
  assert.match(h, /<nav class="pages" aria-label="Pages of the book"><a href="\/web\/stamps\?page=1">1<\/a><a href="\/web\/stamps\?page=2">2<\/a><a href="\/web\/stamps\?page=3" aria-current="page">3<\/a><\/nav>/);
  assert.equal((h.match(/class="sh-b"/g) ?? []).length, 3);
  assert.equal((h.match(/Blank spot/g) ?? []).length, 5);
  assert.ok((h.match(/<p class="hint">/g) ?? []).length <= 2);
  h = (await call({ b, query: { page: "2" } })).body;
  assert.equal((h.match(/class="sh-b"/g) ?? []).length, 8);
  assert.equal((h.match(/Blank spot/g) ?? []).length, 0, "blank spots only on the last page");
  assert.doesNotMatch(h, / · NEW</, "NEW is the newest only");
  h = (await call({ b, query: { stamp: String(ids[2]) } })).body;
  assert.match(h, /PAGE 1 · 19/);
  assert.match(h, /<h2 id="sel-h">The long hold\.<\/h2>/);
  assert.match(h, /I sat on hold for 32 minutes/);
  // Somebody else's id selects nothing of theirs.
  const theirs = seed(KOFI_C, "first");
  h = (await call({ b, query: { stamp: String(theirs) } })).body;
  assert.match(h, /THE NEWEST/);
});

test("share: signed in + same origin + the session secret; 12 base62 at heyreason /s/, never the stamp id; same link again; Stop sharing", async () => {
  const id = seed(OWNER_C, "long_hold", { detail: { minutes: 52 } });
  const b = browser(OWNER_C);
  const { out, json } = await share(b, id);
  assert.equal(out.status, 200);
  const m = /^https:\/\/heyreason\.test\/s\/([0-9A-Za-z]{12})$/.exec(json.url);
  assert.ok(m, json.url);
  assert.notEqual(m[1], String(id));
  const row = db.db.prepare("SELECT * FROM stamp_shares WHERE share_id = ?").get(m[1]);
  assert.deepEqual([row.stamp_id, row.conversation_id, row.show_name, row.revoked_at, row.opens, row.signups], [id, OWNER_C, 1, null, 0, 0]);
  assert.equal((await share(b, id, false)).json.url, json.url, "one live link per stamp; the name choice follows");
  assert.equal(db.db.prepare("SELECT show_name FROM stamp_shares WHERE share_id = ?").get(m[1]).show_name, 0);
  // Refusals.
  assert.equal((await call({ sub: `api/stamps/${id}/share`, method: "POST", b, body: "{}", headers: { "content-type": "application/json", accept: "application/json" } })).status, 403, "no secret");
  assert.equal((await call({ sub: `api/stamps/${id}/share`, method: "POST", b, body: "{}", headers: { "content-type": "application/json", accept: "application/json", "x-reason-csrf": b.csrf, origin: "https://evil.test", "sec-fetch-site": "cross-site" } })).status, 403, "cross-site");
  assert.equal((await share(browser(KOFI_C), id)).out.status, 404, "not in owner mode for Kofi");
  process.env.REASON_WEB_DAILY = "on";
  assert.equal((await share(browser(KOFI_C), id)).out.status, 404, "and never somebody else's stamp");
  assert.equal((await call({ sub: `api/stamps/${id}/share`, method: "POST", body: "{}" })).status, 401, "signed out");
  // The page shows the link and Stop sharing; no-script revoke comes back to the page.
  let h = (await call({ b, query: { stamp: String(id) } })).body;
  assert.match(h, new RegExp(`Link: https://heyreason.test/s/${m[1]}`));
  assert.match(h, /class="stop-f">/);
  const stop = await call({ sub: `api/stamps/${id}/share/revoke`, method: "POST", b, body: `c=${encodeURIComponent(b.csrf)}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(stop.status, 303);
  assert.equal(stop.headers.Location, `/web/stamps?stamp=${id}#share`);
  assert.ok(db.db.prepare("SELECT revoked_at FROM stamp_shares WHERE share_id = ?").get(m[1]).revoked_at);
  // No-script share: a form post, back to the page; a new id (the old one stays off).
  const again = await call({ sub: `api/stamps/${id}/share`, method: "POST", b, body: `c=${encodeURIComponent(b.csrf)}&showName=1`, headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(again.status, 303);
  const live = stamps.activeShare(id);
  assert.notEqual(live.share_id, m[1]);
  assert.equal(live.show_name, 1);
});

test("Save image: the share card as a PNG download for the owner, drawn once and kept", async () => {
  const id = seed(OWNER_C, "long_hold", { detail: { minutes: 52 } });
  const b = browser(OWNER_C);
  const a = await call({ sub: `api/stamps/${id}/image.png`, b, query: { name: "1" } });
  assert.equal(a.status, 200);
  assert.equal(a.headers["Content-Type"], "image/png");
  assert.match(a.headers["Content-Disposition"], /attachment; filename="reason-stamp-long-hold\.png"/);
  assert.match(drawn[0], /Reason sat on hold for 52 minutes so Omari didn&#39;t have to\./);
  await call({ sub: `api/stamps/${id}/image.png`, b, query: { name: "1" } });
  assert.equal(drawn.length, 1, "cached");
  await call({ sub: `api/stamps/${id}/image.png`, b, query: { name: "0" } });
  assert.match(drawn[1], /so I didn&#39;t have to\./);
  assert.equal((await call({ sub: `api/stamps/${id}/image.png`, b: browser(KOFI_C) })).status, 404);
});

test("/s/<shareId>: public, noindex, the large stamp and its line, CTA with ref, og tags; opened is counted; og.png drawn", async () => {
  const id = seed(OWNER_C, "long_hold", { detail: { minutes: 52 } });
  const { json } = await share(browser(OWNER_C), id);
  const sid = json.url.split("/").pop();
  await server(async (base) => {
    const r = await fetch(`${base}/s/${sid}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    const h = await r.text();
    assert.match(h, /<meta name="robots" content="noindex/);
    assert.match(h, /role="img" aria-label="Stamp: The long hold, 52 minutes"/);
    assert.match(h, /<p class="pub-l">Reason sat on hold for 52 minutes so Omari didn&#39;t have to\.<\/p>/);
    assert.match(h, /HEYREASON\.COM/);
    assert.match(h, new RegExp(`href="https://heyreason.test/\\?ref=s_${sid}">Get your own Reason`));
    assert.match(h, new RegExp(`<meta property="og:image" content="https://heyreason.test/s/${sid}/og.png\\?v=1">`));
    assert.match(h, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(h, /<meta property="og:image:alt" content="Stamp: The long hold, 52 minutes\. Reason sat on hold/);
    const og = await fetch(`${base}/s/${sid}/og.png`);
    assert.equal(og.status, 200);
    assert.equal(og.headers.get("content-type"), "image/png");
    assert.match(Buffer.from(await og.arrayBuffer()).toString(), /^PNG:/);
    assert.match(drawn.at(-1), /width:1200px;height:630px/);
  });
  assert.equal(db.db.prepare("SELECT opens FROM stamp_shares WHERE share_id = ?").get(sid).opens, 1);
});

test("revoked: the existing turned-off screen at 410, and the og falls back to the generic card", async () => {
  const id = seed(OWNER_C, "first");
  const b = browser(OWNER_C);
  const sid = (await share(b, id)).json.url.split("/").pop();
  stamps.revokeShares(OWNER_C, id);
  await server(async (base) => {
    const r = await fetch(`${base}/s/${sid}`);
    assert.equal(r.status, 410);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    const h = await r.text();
    assert.match(h, /This link’s been <em>turned off\.<\/em>/);
    assert.match(h, /HEYREASON\.COM/);
    assert.doesNotMatch(h, /First errand|first errand/i);
    assert.doesNotMatch(h, /url\(\/fonts\//, "faces from Web's own path, which every host serves");
    const og = Buffer.from(await (await fetch(`${base}/s/${sid}/og.png`)).arrayBuffer());
    assert.ok(og.equals(readFileSync(new URL("../assets/og.png", import.meta.url))), "the generic card");
  });
});

test("collision: a ride-along sign-in token under /s/ still reaches its own handler; a 12-character id with no share falls through", async () => {
  process.env.REASON_WEB_DAILY = "on";
  config.publicUrl = "https://reason.example";
  const frame = { url: "https://www.amazon.com/ap/signin", text: "Sign in or create account", fields: [] };
  const page = { screenshot: async () => Buffer.from([0xff, 0xd8]), evaluate: async () => frame, mouse: { click: async () => {}, wheel: async () => {} }, keyboard: { type: async () => {}, press: async () => {} }, goBack: async () => {} };
  const out = remote.createRemoteSignin({ conversationId: OWNER_C, entry: sites.site("amazon"), launch: async () => ({ page, close: async () => {} }), check: async () => ({ ok: false }), closeBrowser: async () => {} });
  const token = out.url.split("/").pop();
  assert.ok(token.length >= 32 && !stamps.SHARE_ID.test(token), "the two shapes can never meet");
  const id = seed(OWNER_C, "first");
  const sid = (await share(browser(OWNER_C), id)).json.url.split("/").pop();
  try {
    await server(async (base) => {
      const signin = await fetch(`${base}/s/${token}`);
      assert.equal(signin.status, 200);
      assert.match(await signin.text(), /Sign in to Amazon/);
      const mine = await fetch(`${base}/s/${sid}`);
      assert.equal(mine.status, 200);
      assert.match(await mine.text(), /A STAMP FROM REASON/);
      const none = await fetch(`${base}/s/AAAAAAAAAAAA`);
      assert.equal(none.status, 404);
      assert.deepEqual(await none.json(), { error: "not found" }, "the sign-in route's own 404, as before");
    });
  } finally { remote.forgetAllRemoteSignins(); }
});

test("REDACTION: merchant, company, city, price and person never reach the share page, its tags, headers, card or alt text", async () => {
  process.env.REASON_WEB_DAILY = "on";
  const SECRETS = ["Comcast", "Xfinity", "Walgreens", "Lisbon", "Portugal", "$40", "SAVED", "40 dollars", "Kofi", "Mensah", "Nyarko", "replacement lamp"];
  const detail = { place: "Comcast Xfinity (Dr. Kofi Mensah)", merchant: "Walgreens", savedCents: 4000, city: "Lisbon, Portugal", what: "replacement lamp", minutes: 52, days: 9, count: 3, presses: 3 };
  const b = browser(OWNER_C);
  for (const type of stamps.TYPES) {
    const id = seed(OWNER_C, type, { detail, at: T0 + stamps.TYPES.indexOf(type) * 1000 });
    const { json } = await share(b, id);
    const sid = json.url.split("/").pop();
    const row = db.db.prepare("SELECT * FROM stamps WHERE id = ?").get(id);
    const face = stamps.publicFace(row), line = stamps.publicLine(row, "Omari");
    const outputs = [stamps.stampMarkup(face), line, ws.stampOgHtml({ face, line }), ws.ogAlt(face, line), ws.ogTitle(face)];
    await server(async (base) => {
      const r = await fetch(`${base}/s/${sid}`);
      outputs.push(await r.text(), JSON.stringify([...r.headers]));
      await fetch(`${base}/s/${sid}/og.png`);
      outputs.push(drawn.at(-1));
    });
    const all = outputs.join("\n");
    for (const s of SECRETS) assert.ok(!all.includes(s), `${type}: "${s}" leaked`);
    assert.ok(all.includes(stamps.CATALOG[type].name.replace(/'/g, "&#39;")), `${type}: the name is there`);
  }
  // The generic words stand in: A HUMAN for the company, ABROAD for the city, no amount for a price drop.
  const face = (type) => stamps.publicFace({ type, detail_json: JSON.stringify(detail), rotation: 0 });
  assert.deepEqual([face("human").main, face("human").detail], ["A HUMAN", ""]);
  assert.deepEqual([face("abroad").main, face("abroad").detail], ["ABROAD", ""]);
  assert.deepEqual([face("price_drop").main, face("price_drop").detail], ["PRICE DROP", ""]);
  assert.equal(face("long_hold").detail, "52 MIN", "a duration may be shown");
  assert.equal(face("early").detail, "9 DAYS AHEAD", "a count may be shown");
  // The owner's own book keeps them (private), which is why the public side never reads it.
  const own = stamps.summarize({ id: 1, conversation_id: OWNER_C, type: "price_drop", earned_at: T0, detail_json: JSON.stringify(detail), rotation: 0, message_id: 0 });
  assert.equal(own.detail, "SAVED $40");
});

test("first name: only when left on, only a plain first word; off reads “…so I didn't have to.”", async () => {
  assert.equal(stamps.firstNameOf("Omari Nyarko"), "Omari");
  assert.equal(stamps.firstNameOf("<script>"), "");
  assert.equal(stamps.firstNameOf("+14155550000"), "");
  const row = { type: "human", detail_json: "{}" };
  assert.equal(stamps.publicLine(row, "Omari"), "Reason got through to a human so Omari didn't have to.");
  assert.equal(stamps.publicLine(row, ""), "Reason got through to a human so I didn't have to.");
  const id = seed(OWNER_C, "human", { detail: { place: "Comcast" } });
  const sid = (await share(browser(OWNER_C), id, false)).json.url.split("/").pop();
  await server(async (base) => {
    const h = await (await fetch(`${base}/s/${sid}`)).text();
    assert.match(h, /so I didn&#39;t have to\./);
    assert.doesNotMatch(h, /Omari/);
  });
});

test("signup attribution: ref=s_<shareId> counts against that share; anything else is ignored", () => {
  const id = seed(OWNER_C, "first");
  const s = stamps.shareStamp(OWNER_C, id);
  const logs = [];
  assert.equal(stamps.noteShareSignup(`s_${s.shareId}`, { log: (e) => logs.push(e) }), true);
  assert.equal(stamps.noteShareSignup("s_nope", {}), false);
  assert.equal(stamps.noteShareSignup(`x_${s.shareId}`, {}), false);
  assert.equal(db.db.prepare("SELECT signups FROM stamp_shares WHERE share_id = ?").get(s.shareId).signups, 1);
  assert.deepEqual(logs, [{ stamp_share_signup: true }]);
});
