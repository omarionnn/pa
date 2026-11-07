// Audit lead 23, follow-up (2026-11-07): an owner with no key in the URL and no saved session could
// still be kept out of the /ops password by a stranger. Wrong passwords without the key were capped
// at 30 per 15 minutes from everyone together ("ops:pw"), because the per-address count trusted an
// address header anybody can write. Thirty junk guesses from anywhere answered 429 to the owner too.
//
// The website's /ops rewrite can sign its requests (netlify.toml `signed`), as /web's does; then
// Netlify's x-nf-client-connection-ip is the visitor's real address (src/pages/siteproxy.js). What
// has to stay true:
//
//   - **a signed request is counted against its own address**: five wrong there locks that address,
//     and nobody else's guesses (forged, unsigned, or from another address) lock it;
//   - **a much higher ceiling still binds everyone together**, so guessing spread over many
//     addresses is bounded; an IPv6 /64 is one address for this;
//   - **an unsigned request is answered exactly as before**: per claimed address and the shared 30;
//   - nothing a browser sees changes: the same messages, the same counts, the same host-only cookie;
//   - simultaneous guesses cannot slip past the caps (each try is written down before it is checked).
//
// The hash and the proxy secret here are throwaways made in this file.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, scryptSync, createHmac } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-opspersource-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SEARCH_PROVIDER = "parallel";
process.env.PARALLEL_API_KEY = "test-parallel";
process.env.OPENAI_API_KEY = "test-openai";
process.env.REASON_CALL_PROVIDER = "fake";
delete process.env.REASON_OPS_URL;
delete process.env.REASON_OPS_PASSWORD_HASH;

import os from "node:os";
os.loadavg = () => [0.5, 0.5, 0.5];
const db = await import("../src/db.js");
const opspw = await import("../src/opspassword.js");
const { opsRequest } = await import("../src/http.js");
const { clock, config } = await import("../src/config.js");

const PASSWORD = "right-pw for the per-source test";
const salt = randomBytes(16);
const HASH = `scrypt:${salt.toString("hex")}:${scryptSync(PASSWORD, salt, 64).toString("hex")}`;
const SECRET = "test-site-proxy-secret";
// The ceiling on everyone together once requests are signed. Read from the module when it has one;
// on a build without it, the number this test expects.
const CEILING = opspw.MAX_VERIFIED_TOTAL ?? 300;

const runtime = { say: () => "", interval: {}, lastSweepAt: clock.now(), on() {} };
const log = () => {};

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.opsPasswordHash = HASH;
  config.siteProxySecret = SECRET;
  config.siteProxyId = "";
  config.siteUrl = "https://heyreason.test";
  config.pagesUrl = "https://files.heyreason.test";
  config.eventsUrl = "https://events.heyreason.test";
  db.db.exec(`DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts;`);
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** What Netlify puts in x-nf-sign (shape probed live 10-26). */
function sign({ secret = SECRET } = {}) {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ deploy_context: "production", exp: Math.floor(clock.now() / 1000) + 60, iss: "netlify", netlify_id: "site-1", site_url: "https://heyreason.test" });
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}
// The website's rewrite lands on the Funnel: Host is the Funnel's, the socket is the local tailscaled.
const FUNNEL = "reason.example.test";
/** Through heyreason.com/ops, signed: Netlify's own address in x-nf-client-connection-ip. */
const signed = (visitor) => ({ host: FUNNEL, "x-nf-sign": sign(), "x-nf-client-connection-ip": visitor, "x-forwarded-for": `${visitor}, 34.205.162.186` });
/** Anybody hitting the Funnel directly, writing whatever address headers they like. */
const forged = (addr, extra = {}) => ({ host: FUNNEL, "x-nf-client-connection-ip": addr, "x-forwarded-for": addr, ...extra });

const POST = (body, { headers = {}, key = null } = {}) =>
  opsRequest({ key, method: "POST", headers, remoteAddress: "127.0.0.1", readBody: async () => body, runtime, log });
const pw = (p) => `username=Reason+status&password=${encodeURIComponent(p)}`;

test("a stranger's thirty forged wrong passwords cannot lock out the owner's signed browser", async () => {
  for (let i = 0; i < opspw.MAX_TOTAL; i++) await POST(pw("nope"), { headers: forged(`9.9.${Math.floor(i / 4)}.${i}`) });
  const owner = await POST(pw(PASSWORD), { headers: signed("203.0.113.7") });
  assert.equal(owner.status, 303, "the owner's right password, through the website, still opens the page");
  assert.match(owner.headers["Set-Cookie"], /^reason_page=/);
});

test("a stranger's own signed guesses lock only the stranger's address", async () => {
  for (let i = 0; i < opspw.MAX_PER_IP; i++) await POST(pw("nope"), { headers: signed("198.51.100.9") });
  const stranger = await POST(pw(PASSWORD), { headers: signed("198.51.100.9") });
  assert.equal(stranger.status, 429);
  assert.equal(stranger.headers["Set-Cookie"], undefined);
  // Writing a fresh address header does not get a signed stranger anything: Netlify replaces it.
  assert.equal((await POST(pw(PASSWORD), { headers: signed("203.0.113.7") })).status, 303);
});

test("guesses spread over many addresses still meet a ceiling, which the window frees", async () => {
  // Each address up to its own five, the addresses side by side (scrypt runs on the thread pool).
  const addresses = Math.ceil(CEILING / opspw.MAX_PER_IP);
  await Promise.all(Array.from({ length: addresses }, async (_, a) => {
    for (let i = 0; i < opspw.MAX_PER_IP; i++) await POST(pw("nope"), { headers: signed(`198.51.${Math.floor(a / 200)}.${a % 200}`) });
  }));
  const owner = await POST(pw(PASSWORD), { headers: signed("203.0.113.7") });
  assert.equal(owner.status, 429, "past the ceiling nobody may try");
  assert.match(owner.body, /Too many wrong passwords/);
  clock.skip(opspw.WINDOW_MS + 1000);
  assert.equal((await POST(pw(PASSWORD), { headers: signed("203.0.113.7") })).status, 303);
});

test("an IPv6 /64 is one address: rotating inside it does not buy more guesses", async () => {
  for (let i = 0; i < opspw.MAX_PER_IP; i++) await POST(pw("nope"), { headers: signed(`2001:db8:1:2::${(i + 1).toString(16)}`) });
  assert.equal((await POST(pw(PASSWORD), { headers: signed("2001:db8:1:2:abcd::99") })).status, 429);
  assert.equal((await POST(pw(PASSWORD), { headers: signed("2001:db8:1:3::1") })).status, 303, "the next /64 is somebody else");
});

test("a forged signature, or the Caddy marker on the Funnel, is not a verified address", async () => {
  for (let i = 0; i < opspw.MAX_TOTAL; i++) await POST(pw("nope"), { headers: forged(`9.7.0.${i}`) });
  const badSig = await POST(pw(PASSWORD), { headers: { ...signed("203.0.113.7"), "x-nf-sign": sign({ secret: "someone-elses" }) } });
  assert.equal(badSig.status, 429);
  const marker = await POST(pw(PASSWORD), { headers: forged("203.0.113.8", { "x-files-domain": "true" }) });
  assert.equal(marker.status, 429);
});

test("unsigned requests are answered exactly as before", async () => {
  const first = await POST(pw("nope"), { headers: forged("8.8.4.4") });
  assert.equal(first.status, 401);
  assert.match(first.body, /That password is not right\. 4 tries left\./);
  for (let i = 0; i < opspw.MAX_PER_IP - 1; i++) await POST(pw("nope"), { headers: forged("8.8.4.4") });
  const locked = await POST(pw(PASSWORD), { headers: forged("8.8.4.4") });
  assert.equal(locked.status, 429);
  assert.match(locked.body, /Too many wrong passwords\. Try again in about 15 minutes\./);
  for (let i = 0; i < opspw.MAX_TOTAL; i++) await POST(pw("nope"), { headers: forged(`9.6.0.${i}`) });
  assert.equal((await POST(pw(PASSWORD), { headers: forged("8.8.8.1") })).status, 429, "the shared 30 still binds unsigned requests");
  assert.equal((await POST(pw(PASSWORD), { headers: {} })).status, 429);
});

test("a signed browser sees the same words and counts", async () => {
  const first = await POST(pw("nope"), { headers: signed("203.0.113.7") });
  assert.equal(first.status, 401);
  assert.match(first.body, /That password is not right\. 4 tries left\./);
});

test("the cookie a signed sign-in sets is host-only, as /ops's has always been", async () => {
  const owner = await POST(pw(PASSWORD), { headers: signed("203.0.113.7") });
  assert.equal(owner.status, 303);
  assert.doesNotMatch(owner.headers["Set-Cookie"], /Domain=/i);
});

test("simultaneous wrong guesses cannot run past the caps", async () => {
  await Promise.all(Array.from({ length: 120 }, (_, i) => POST(pw("nope"), { headers: forged(`9.5.${Math.floor(i / 4)}.${i}`) })));
  assert.ok(db.failedPageAttempts("ops:pw", opspw.WINDOW_MS) <= opspw.MAX_TOTAL, "the shared unsigned total stays at its cap");
  const owner = await POST(pw(PASSWORD), { headers: signed("203.0.113.7") });
  assert.equal(owner.status, 303, "and the owner's signed browser is not locked out by them");
});
