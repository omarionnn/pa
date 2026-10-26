// The owner's domain rule (2026-10-26): heyreason.com = the website and Reason Web at /web (Netlify
// proxies /web/* here, signed); files.heyreason.com = pages Reason makes; events.heyreason.com = event
// links. Pinned here:
//
//   - the website's signature (x-nf-sign, HS256) is checked: right secret, unexpired, iss netlify, our site
//   - two visitors through the proxy get two sign-in rate-limit buckets; a direct hit with a forged
//     Netlify address header (no signature, or a bad one) cannot borrow another address
//   - /web on the pages host answers 301 to heyreason.com/web, same path and query; the website's own
//     signed request on that host is served; heyreason.com itself is served
//   - Web posts arriving via heyreason.com pass the Origin check; the session cookie is shared on
//     Domain=heyreason.com (decision 3), HttpOnly, Secure, SameSite=Lax; the Funnel's stays host-only
//   - a browser holding a stale host-only cookie and a live shared one is still signed in
//   - every event address is built on REASON_EVENTS_URL; old files-domain links are still ours
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-domains-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_EVENTS_URL = "https://events.heyreason.test/";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_SITE_PROXY_SECRET = "test-proxy-secret-0123456789abcdef";
process.env.REASON_SITE_PROXY_ID = "site-1";
process.env.REASON_WEB = "on";
process.env.REASON_EVENTS = "on";
process.env.REASON_EVENT_ALBUMS = "on";
delete process.env.REASON_AUTO_ADMIT;

const { webRequestFor, createServer } = await import("../src/http.js");
const proxy = await import("../src/pages/siteproxy.js");
const { eventActor } = await import("../src/pages/event.js");
const { cookieHeader, clearCookieHeader, readCookie } = await import("../src/pages/access.js");
const ws = await import("../src/pages/websignin.js");
const events = await import("../src/events.js");
const albums = await import("../src/albums.js");
const { coverUrl } = await import("../src/eventcover.js");
const { isOwnEventLink } = await import("../src/eventtools.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const SECRET = process.env.REASON_SITE_PROXY_SECRET;
const OWNER_C = config.ownerConversation;
const NETLIFY = "34.205.162.186"; // the address Caddy sees for every proxied request

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  config.events = true;
  config.siteProxySecret = SECRET;
  config.eventsUrl = "https://events.heyreason.test";
  db.db.exec(`DELETE FROM accounts; DELETE FROM outbox; DELETE FROM page_sessions; DELETE FROM page_codes;
    DELETE FROM page_attempts; DELETE FROM event_join_attempts;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", isOwner: true });
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** What Netlify puts in x-nf-sign (shape probed live 10-26). */
function sign({ secret = SECRET, exp = Math.floor(clock.now() / 1000) + 60, iss = "netlify", id = "site-1", alg = "HS256" } = {}) {
  const h = b64({ alg, typ: "JWT" });
  const p = b64({ deploy_context: "production", exp, iss, netlify_id: id, site_url: "https://heyreason.test" });
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}
/** A request as Caddy hands it on from Netlify: socket 127.0.0.1, XFF = Netlify's egress, marked by Caddy. */
const viaNetlify = (visitor, extra = {}) => ({ host: "files.heyreason.test", "x-files-domain": "true", "x-forwarded-for": NETLIFY, "x-nf-sign": sign(), "x-nf-client-connection-ip": visitor, ...extra });
/** A browser hitting files.heyreason.test directly (Caddy's XFF = its real address), forging Netlify's header. */
const direct = (real, forged, extra = {}) => ({ host: "files.heyreason.test", "x-files-domain": "true", "x-forwarded-for": real, "x-nf-client-connection-ip": forged, ...extra });

// ---------- the signature ----------

test("the website's signature: only our secret, unexpired, from netlify, for our site", () => {
  assert.equal(proxy.viaSite({ "x-nf-sign": sign() }), true);
  assert.equal(proxy.viaSite({}), false, "no signature");
  assert.equal(proxy.viaSite({ "x-nf-sign": "forged" }), false);
  assert.equal(proxy.viaSite({ "x-nf-sign": sign({ secret: "someone-elses" }) }), false, "another secret");
  assert.equal(proxy.viaSite({ "x-nf-sign": sign({ exp: Math.floor(clock.now() / 1000) - 120 }) }), false, "expired");
  assert.equal(proxy.viaSite({ "x-nf-sign": sign({ exp: Math.floor(clock.now() / 1000) - 5 }) }), true, "a minute's grace for clock skew");
  assert.equal(proxy.viaSite({ "x-nf-sign": sign({ iss: "me" }) }), false, "not netlify");
  assert.equal(proxy.viaSite({ "x-nf-sign": sign({ id: "site-2" }) }), false, "another Netlify site");
  assert.equal(proxy.viaSite({ "x-nf-sign": sign({ alg: "none" }) }), false, "alg is pinned");
  const [h, p] = sign().split(".");
  assert.equal(proxy.viaSite({ "x-nf-sign": `${h}.${p}.` }), false, "no signature part");
  config.siteProxySecret = "";
  assert.equal(proxy.viaSite({ "x-nf-sign": sign() }), false, "no secret configured: nothing is believed");
});

// ---------- the client address ----------

test("two visitors through the proxy are two addresses; a forged Netlify header borrows nothing", () => {
  const a = eventActor(viaNetlify("198.51.100.1"), "127.0.0.1");
  const b = eventActor(viaNetlify("2001:db8::7"), "127.0.0.1");
  assert.equal(a, "ip:198.51.100.1");
  assert.equal(b, "ip:2001:db8::7");
  // Direct, no signature: Caddy's real address, never the forged one.
  assert.equal(eventActor(direct("203.0.113.66", "198.51.100.1"), "127.0.0.1"), "ip:203.0.113.66");
  // Direct, a signature made with a guessed secret: the same.
  assert.equal(eventActor(direct("203.0.113.66", "198.51.100.1", { "x-nf-sign": sign({ secret: "guess" }) }), "127.0.0.1"), "ip:203.0.113.66");
  // Not through Caddy at all (a raw socket): the socket, whatever the headers say.
  assert.equal(eventActor({ "x-nf-client-connection-ip": "198.51.100.1", "x-forwarded-for": "1.1.1.1" }, "203.0.113.5"), "ip:203.0.113.5");
  // A signed request whose address is not an address: the signature alone names nobody, back to Caddy's.
  assert.equal(eventActor(viaNetlify("not an ip <x>"), "127.0.0.1"), `ip:${NETLIFY}`);
});

function harness() {
  const runtime = new Runtime({ log: () => {}, runTurn: async () => "ok" });
  const router = new Router({ runtime, log: () => {} });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: "+16562167455" }));
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await runtime.deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  return { runtime, router, channel };
}
const form = (o) => new URLSearchParams(o).toString();
const setCookies = (out) => [].concat(out.headers["Set-Cookie"] ?? []);
const cookieValue = (out, name) => setCookies(out).map(c => new RegExp(`^${name}=([^;]*)`).exec(c)?.[1]).find(Boolean) ?? null;
async function web(h, headers, { sub = null, method = "GET", body = null, cookie = "" } = {}) {
  return await webRequestFor({ sub, method, query: {}, headers: { origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...headers, cookie },
    remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router, log: () => {} });
}
/** Ask for a code n times as one browser; the statuses. */
async function asks(h, headers, n) {
  const first = await web(h, headers);
  const f = cookieValue(first, ws.FORM_COOKIE);
  const out = [];
  for (let i = 0; i < n; i++) out.push((await web(h, headers, { sub: "signin", method: "POST", body: form({ number: "+15555550123", f }), cookie: `${ws.FORM_COOKIE}=${f}` })).status);
  return out;
}

test("rate limits through heyreason.com/web: one bucket per visitor, and a forger stays in their own", async () => {
  const h = harness();
  const cap = events.SIGNIN_PER_BROWSER_HOUR;
  const a = await asks(h, viaNetlify("198.51.100.1"), cap + 1);
  assert.deepEqual(a.slice(0, cap), Array(cap).fill(200), "a visitor's own allowance, all through the proxy");
  assert.equal(a[cap], 429, "then their own limit");
  // Another visitor through the same proxy (same Netlify address at Caddy) is not held by the first.
  assert.equal((await asks(h, viaNetlify("198.51.100.2"), 1))[0], 200);
  // A browser direct to the files host fills its bucket while naming a fresh Netlify address each time…
  const forger = [];
  for (let i = 0; i < cap + 1; i++) forger.push((await asks(h, direct("203.0.113.66", `198.51.100.${100 + i}`), 1))[0]);
  assert.equal(forger.at(-1), 429, "…and is still one browser: the forged header bought nothing");
  // …and cannot use the first visitor's address to lock them out either: visitor 2 still has room.
  assert.equal((await asks(h, viaNetlify("198.51.100.2"), 1))[0], 200);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM outbox WHERE idem_key LIKE 'wsign:%'").get().n, 0, "a 555 number nobody holds: no text");
});

// ---------- where /web lives ----------

test("/web on the pages host → 301 heyreason.com/web, same path and query; the website's own request is served", async () => {
  const h = harness();
  const server = createServer({ router: h.router, runtime: h.runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // node:http, not fetch: fetch will not send a Host of our choosing.
    const get = (path, headers = {}, method = "GET") => new Promise((resolve, reject) => {
      const r = request(`${base}${path}`, { method, headers: { host: "files.heyreason.test", ...headers } }, (res) => {
        let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k] }, text: async () => body }));
      });
      r.on("error", reject); r.end(method === "POST" ? "number=1" : undefined);
    });
    for (const path of ["/web", "/web?from=text&x=1", "/web/signin", "/web/fonts/serif.woff2"]) {
      const r = await get(path);
      assert.equal(r.status, 301, path);
      assert.equal(r.headers.get("location"), `https://heyreason.test${path}`, path);
    }
    const posted = await get("/web/code", { "content-type": "application/x-www-form-urlencoded" }, "POST");
    assert.equal(posted.status, 301);
    assert.equal(posted.headers.get("location"), "https://heyreason.test/web/code");
    // A forged or bad signature is a direct visit.
    assert.equal((await get("/web", { "x-nf-sign": sign({ secret: "guess" }) })).status, 301);
    // The website's rewrite lands on this same host, signed: served, not sent round again.
    const proxied = await get("/web", { "x-nf-sign": sign() });
    assert.equal(proxied.status, 200);
    assert.match(await proxied.text(), /<form/);
    assert.equal((await get("/web/fonts/serif.woff2", { "x-nf-sign": sign() })).status, 200);
    // heyreason.com itself, the Funnel, a dev machine: served where they are.
    assert.equal((await get("/web", { host: "heyreason.test" })).status, 200);
    assert.equal((await get("/web", { host: "reason.example.test" })).status, 200);
    // Pages on the files host are untouched: a page path is still the page route's answer.
    assert.notEqual((await get("/p/aaaaaaaaaaaaaaaaaaaaaa")).status, 301);
    // No secret configured: nothing can tell the website's request from a direct one, so nothing moves.
    config.siteProxySecret = "";
    assert.equal((await get("/web")).status, 200);
    config.siteProxySecret = SECRET;
    // Web off: the flat 404, never a redirect that says Web exists.
    config.web = false;
    assert.equal((await get("/web")).status, 404);
  } finally { server.close(); }
});

// ---------- the cookie ----------

test("sign-in via heyreason.com/web: Origin heyreason.com passes; the session cookie is shared on Domain=heyreason.com", async () => {
  const h = harness();
  const hdrs = viaNetlify("198.51.100.1");
  const first = await web(h, hdrs);
  const f = cookieValue(first, ws.FORM_COOKIE);
  const jar = `${ws.FORM_COOKIE}=${f}`;
  const asked = await web(h, hdrs, { sub: "signin", method: "POST", body: form({ number: "+12025551234", f }), cookie: jar });
  assert.equal(asked.status, 200, "Origin https://heyreason.test is ours");
  let code = null;
  for (let i = 0; i < 100 && !code; i++) {
    await new Promise(r => setTimeout(r, 10));
    code = /\b(\d{6})\b/.exec(h.channel.sent.at(-1)?.text ?? "")?.[1];
  }
  assert.ok(code, "the owner's code went");
  assert.match(h.channel.sent.at(-1).text, /@heyreason\.test #\d{6}$/, "bound to the website's host");
  const done = await web(h, hdrs, { sub: "code", method: "POST", body: form({ number: "+12025551234", code, f }), cookie: jar });
  assert.equal(done.status, 303);
  const session = setCookies(done).find(c => c.startsWith("reason_page="));
  for (const part of ["Path=/", "Domain=heyreason.test", "HttpOnly", "SameSite=Lax", "Secure"]) assert.ok(session.split("; ").includes(part), `${part} in ${session}`);
  // A post naming another site is still refused.
  const evil = await web(h, { ...hdrs, origin: "https://evil.test", "sec-fetch-site": "cross-site" }, { sub: "signin", method: "POST", body: form({ number: "+12025551234", f }), cookie: jar });
  assert.equal(evil.status, 403);
});

test("the cookie: shared under heyreason.com, host-only elsewhere; sign-out clears both copies; a stale copy does not shadow a live one", () => {
  for (const host of ["heyreason.test", "files.heyreason.test", "events.heyreason.test"]) {
    assert.match(cookieHeader("t", { path: "/", headers: { host } }), /; Domain=heyreason\.test;/, host);
  }
  assert.match(cookieHeader("t", { path: "/", headers: { host: "reason.example.test", "x-nf-sign": sign() } }), /; Domain=heyreason\.test;/, "the website's proxied request");
  assert.doesNotMatch(cookieHeader("t", { path: "/", headers: { host: "reason.example.test" } }), /Domain=/, "the Funnel: host-only");
  assert.doesNotMatch(cookieHeader("t", { path: "/", headers: { host: "evilheyreason.test" } }), /Domain=/, "a lookalike is not under it");
  assert.doesNotMatch(cookieHeader("t", { path: "/", headers: { host: "mail.heyreason.test" } }), /Domain=/, "only Reason's own three hosts set it");
  assert.doesNotMatch(cookieHeader("t"), /Domain=/, "no request: as before");
  const cleared = clearCookieHeader({ path: "/", headers: { host: "files.heyreason.test" } });
  assert.equal(cleared.length, 2);
  assert.ok(cleared.every(c => /Max-Age=0/.test(c)));
  assert.ok(cleared.some(c => !/Domain=/.test(c)) && cleared.some(c => /Domain=heyreason\.test/.test(c)));
  db.startPageSession("web", "live-token", { conversationId: OWNER_C });
  assert.equal(readCookie("reason_page=stale-token; reason_page=live-token"), "live-token");
  assert.equal(readCookie("reason_page=live-token; reason_page=stale-token"), "live-token");
  assert.equal(readCookie("reason_page=only"), "only");
  // A session planted from a sibling host (cookie tossing) beside the visitor's own: never swapped in.
  db.startPageSession("web", "someone-else", { conversationId: "dm:fake:+14155559876" });
  assert.equal(readCookie("reason_page=someone-else; reason_page=live-token"), null, "two people's sessions: neither");
  db.startPageSession("web", "live-token-2", { conversationId: OWNER_C });
  assert.equal(readCookie("reason_page=live-token-2; reason_page=live-token"), "live-token-2", "two of the same person's: the first");
  assert.equal(readCookie(""), null);
});

// ---------- event links ----------

test("every event address is built on REASON_EVENTS_URL; old files-domain links are still Reason's own", () => {
  const ev = events.create(OWNER_C, { name: "Rooftop", description: "d", starts_at: "2026-11-20T21:00", location: "12 Elm St", password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true }).event;
  const att = { token: "tok123" };
  assert.equal(events.eventUrl(ev), `https://events.heyreason.test/e/${ev.public_id}`);
  assert.equal(ev.public_id.length, 16);
  assert.ok(events.directoryUrl(ev, att).startsWith(`https://events.heyreason.test/e/${ev.public_id}/who?t=`));
  assert.ok(events.organizerPageUrl(ev).startsWith("https://events.heyreason.test/e/"));
  assert.ok(albums.albumUrl(ev, att).startsWith(`https://events.heyreason.test/e/${ev.public_id}/album?t=`));
  assert.ok(albums.manageUrl(ev).startsWith(`https://events.heyreason.test/e/${ev.public_id}/album/manage?t=`));
  assert.ok(coverUrl(ev).startsWith(`https://events.heyreason.test/e/${ev.public_id}/cover.jpg?v=`));
  assert.equal(isOwnEventLink(`https://events.heyreason.test/e/${ev.public_id}`), true);
  assert.equal(isOwnEventLink(`https://files.heyreason.test/e/${ev.public_id}`), true, "a link sent before the move");
  assert.equal(isOwnEventLink(`https://elsewhere.test/e/${ev.public_id}`), false);
  // Unset: the pages domain, exactly as before the move.
  config.eventsUrl = "";
  assert.equal(events.eventUrl(ev), `https://files.heyreason.test/e/${ev.public_id}`);
});

test("Web sign-out with two copies of the cookie ends both sessions and clears both copies", async () => {
  const h = harness();
  db.startPageSession("wsign:dm:owner", "old-host-only", { conversationId: OWNER_C });
  db.startPageSession("wsign:dm:owner", "shared-one", { conversationId: OWNER_C });
  const jar = "reason_page=old-host-only; reason_page=shared-one";
  const landing = await web(h, viaNetlify("198.51.100.1"), { cookie: jar });
  assert.equal(landing.status, 200);
  const c = /name="c" value="([^"]+)"/.exec(landing.body)?.[1];
  assert.ok(c, "the signed-in landing carries the sign-out secret");
  const out = await web(h, viaNetlify("198.51.100.1"), { sub: "signout", method: "POST", body: form({ c }), cookie: jar });
  assert.equal(out.status, 303);
  assert.equal(db.pageSessionExists("old-host-only"), false);
  assert.equal(db.pageSessionExists("shared-one"), false);
  const cleared = setCookies(out).filter(x => x.startsWith("reason_page=;"));
  assert.equal(cleared.length, 2, "host-only and Domain=heyreason.test copies");
});
