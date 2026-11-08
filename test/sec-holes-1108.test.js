// The 2026-11-08 security round, end to end without a socket.
//
//   - **a sign-in is stored only as a hash**: the row holds sha256(token), never the token, so a copy
//     of the database opens nobody's browser; the browser's own cookie still opens it.
//   - **/ops has its own cookie**: host-only, SameSite=Strict, `reason_ops`. A Web sign-in (the shared
//     heyreason.com cookie, which files. and events. also receive) does not open it. A status-page
//     sign-in from before keeps working and is moved to the new cookie.
//   - **/ops refuses a post that is not its own**: another site, a page on files./events. (same
//     site, so SameSite alone would let it through), or a browser that says cross-site.
//   - **a link from another site is asked again once**, so the Strict cookie comes along.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-sec1108-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_CALL_PROVIDER = "fake";
delete process.env.REASON_OPS_URL;
delete process.env.REASON_OPS_PASSWORD_HASH;

import os from "node:os";
os.loadavg = () => [0.5, 0.5, 0.5];
const ops = await import("../src/ops.js");
const db = await import("../src/db.js");
const { opsRequest, opsSameOrigin } = await import("../src/http.js");
const { clock, config } = await import("../src/config.js");

const PASSWORD = "sec-1108 test password";
const salt = randomBytes(16);
const HASH = `scrypt:${salt.toString("hex")}:${scryptSync(PASSWORD, salt, 64).toString("hex")}`;
const runtime = { say: () => "", interval: {}, lastSweepAt: clock.now(), on() {} };
const logs = [];
const log = (x) => logs.push(x);

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  logs.length = 0;
  config.opsPasswordHash = HASH;
  config.siteUrl = "https://heyreason.test";
  config.pagesUrl = "https://files.heyreason.test";
  config.eventsUrl = "https://events.heyreason.test";
  config.opsUrl = "https://heyreason.test/ops";
  db.db.exec("DELETE FROM accounts; DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts;");
  db.db.prepare("INSERT INTO accounts (conversation_id, channel, address, name, is_operator, created_at) VALUES ('dm:owner', 'sendblue', '+12025550000', 'Omari', 1, 1)").run();
  runtime.lastSweepAt = clock.now();
});

const GET = (headers = {}, { json = false, bounced = false } = {}) => opsRequest({ json, bounced, method: "GET", headers, readBody: async () => "", runtime, log });
const POST = (body, headers = {}) => opsRequest({ method: "POST", headers, remoteAddress: "127.0.0.1", readBody: async () => body, runtime, log });
const pw = (p) => `password=${encodeURIComponent(p)}`;

test("a session is stored as sha256 of its token, never the token; the cookie still opens it", () => {
  db.startPageSession("wsign:dm:owner", "raw-token-abc", { conversationId: "dm:owner" });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions WHERE token = 'raw-token-abc'").get().n, 0);
  assert.equal(db.db.prepare("SELECT token FROM page_sessions").get().token, db.sessionKey("raw-token-abc"));
  assert.match(db.sessionKey("raw-token-abc"), /^[0-9a-f]{64}$/);
  assert.equal(db.pageSessionOwner("raw-token-abc", 86_400_000), "dm:owner");
  assert.equal(db.pageSessionOwner(db.sessionKey("raw-token-abc"), 86_400_000), null, "the stored hash is not itself a cookie");
});

test("the password signs in with the status page's own cookie: host-only, Strict, and it opens /ops", async () => {
  const out = await POST(pw(PASSWORD), { origin: "https://heyreason.test", "sec-fetch-site": "same-origin" });
  assert.equal(out.status, 303);
  const c = out.headers["Set-Cookie"];
  assert.match(c, /^reason_ops=[A-Za-z0-9_-]{40,}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict; Secure$/);
  assert.doesNotMatch(c, /Domain=/i, "never the shared heyreason.com cookie");
  assert.equal((await GET({ cookie: c.split(";")[0] })).status, 200);
});

test("a Web sign-in (the shared cookie) does not open /ops; a status-page one from before does, and moves to the new cookie", async () => {
  db.startPageSession("wsign:dm:owner", "web-tok", { conversationId: "dm:owner" });
  assert.equal((await GET({ cookie: "reason_page=web-tok" })).status, 401);
  assert.equal((await GET({ cookie: "reason_ops=web-tok" })).status, 401, "nor the same token in the ops cookie's name");
  db.startPageSession("ops", "old-ops-tok", { conversationId: "dm:owner" });
  const legacy = await GET({ cookie: "reason_page=old-ops-tok" });
  assert.equal(legacy.status, 200, "signed in before: still signed in");
  const set = [].concat(legacy.headers["Set-Cookie"]);
  assert.match(set[0], /^reason_ops=old-ops-tok; .*SameSite=Strict/);
  assert.match(set[1], /^reason_page=; Path=\/; Max-Age=0/, "the old host-only copy is cleared");
  assert.doesNotMatch(set[1], /Domain=/i, "never the shared Web cookie");
  const moved = await GET({ cookie: "reason_ops=old-ops-tok" });
  assert.equal(moved.status, 200);
  assert.equal(moved.headers["Set-Cookie"], undefined);
});

test("a post from anywhere but the status page is refused before anything is read", async () => {
  db.startPageSession("ops", "ops-tok", { conversationId: "dm:owner" });
  const cookie = "reason_ops=ops-tok";
  for (const h of [
    { origin: "https://evil.example" },
    { origin: "https://files.heyreason.test", "sec-fetch-site": "same-site" },
    { origin: "https://events.heyreason.test" },
    { referer: "https://files.heyreason.test/p/abc" },
    { "sec-fetch-site": "cross-site" },
    { origin: "null", "sec-fetch-site": "same-site" },
  ]) {
    const out = await POST("action=check", { cookie, ...h });
    assert.equal(out.status, 403, JSON.stringify(h));
    const login = await POST(pw(PASSWORD), h);
    assert.equal(login.status, 403, `login too: ${JSON.stringify(h)}`);
    assert.equal(login.headers["Set-Cookie"], undefined);
  }
  assert.ok(logs.some(l => l.ops_post_refused === "origin"));
  assert.equal(db.failedPageAttempts("ops:pw:every", 60 * 60_000), 0, "a refused post is not even a guess");
  assert.equal(opsSameOrigin({ origin: "https://heyreason.test", "sec-fetch-site": "same-origin" }), true);
  assert.equal(opsSameOrigin({ origin: "https://reason.example.test" }), true, "the Funnel's own address");
  assert.equal(opsSameOrigin({ origin: "null", "sec-fetch-site": "same-origin" }), true);
  assert.equal(opsSameOrigin({}), true, "no browser vouching either way is not a browser");
  assert.equal(opsSameOrigin({ "sec-fetch-site": "none" }), true, "a reload or resubmit is the browser's own");
  assert.equal(opsSameOrigin({ origin: "https://other.example", host: "other.example" }), false, "the Host a request names is not trusted");
});

test("/ops, /ops.json and the full /health never answer on the pages or events host", async () => {
  db.startPageSession("ops", "ops-tok3", { conversationId: "dm:owner" });
  for (const host of ["files.heyreason.test", "events.heyreason.test"]) {
    assert.equal((await GET({ host, cookie: "reason_ops=ops-tok3" })).status, 404, host);
    assert.equal((await GET({ host, cookie: "reason_ops=ops-tok3" }, { json: true })).status, 404, host);
    assert.equal((await POST(pw(PASSWORD), { host })).status, 404, host);
  }
  assert.equal((await GET({ host: "reason.example.test", cookie: "reason_ops=ops-tok3" })).status, 200);
});

test("a link tapped on another site is asked again once, so the Strict cookie comes; never a loop, never for JSON", async () => {
  const first = await GET({ "sec-fetch-site": "cross-site" });
  assert.equal(first.status, 200);
  assert.match(first.body, /<meta http-equiv="refresh" content="0;url=\/ops\?r=1">/);
  assert.equal((await GET({ "sec-fetch-site": "cross-site" }, { bounced: true })).status, 401, "the second ask gets the gate");
  assert.equal((await GET({ "sec-fetch-site": "cross-site" }, { json: true })).status, 401);
  db.startPageSession("ops", "ops-tok2", { conversationId: "dm:owner" });
  assert.equal((await GET({ cookie: "reason_ops=ops-tok2", "sec-fetch-site": "cross-site" })).status, 200, "signed in: no detour");
});
