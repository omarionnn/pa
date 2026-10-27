// Reason Web: the logo always goes Home (owner, 10-27). Every Web view's wordmark links to /web?home,
// the arrival (greeting, composer, already in hand, pick up from iMessage), never plain /web, which
// opens the thread for anyone who sent something on Web in the last half hour. The Chat tab and
// "THE THREAD →" keep pointing at the thread.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-logo-"));
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
delete process.env.REASON_BACKEND;

const { webRequestFor } = await import("../src/http.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

const OWNER_C = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  config.web = true;
  db.db.exec("DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM page_sessions; DELETE FROM messages;");
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", isOwner: true, service: "iMessage" });
});

let n = 0;
function browser() {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${OWNER_C}`, token, { conversationId: OWNER_C });
  return { cookie: `reason_page=${token}` };
}
const call = (b, sub = null, query = {}) => webRequestFor({
  sub, method: "GET", query, remoteAddress: "127.0.0.1", readBody: async () => null, runtime: null, router: null, log: () => {},
  headers: { host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}) },
});
const logos = (html) => [...html.matchAll(/<a class="wm" href="([^"]*)"/g)].map(m => m[1].replace(/&amp;/g, "&"));

test("the logo is /web?home on every Web view, signed in or out", async () => {
  const b = browser();
  const first = await call(b);
  assert.match(first.body, /fv-h/, "the first view is 5C");
  const views = {
    "5C first visit": first,
    "plain /web": await call(b),
    "home": await call(b, null, { home: "" }),
    "thread": await call(b, null, { thread: "" }),
    "ongoing": await call(b, null, { tab: "ongoing" }),
    "saved": await call(b, "saved"),
    "memory": await call(b, "memory"),
    "settings": await call(b, "settings"),
    "signed out": await call(null),
  };
  for (const [name, r] of Object.entries(views)) {
    assert.equal(r.status, 200, name);
    const hrefs = logos(r.body);
    assert.ok(hrefs.length >= 1, `${name}: a linked wordmark`);
    for (const h of hrefs) assert.equal(h, "/web?home", `${name}: logo goes Home`);
    // The in-page loader redraws the wordmark too: its copy goes Home as well.
    assert.doesNotMatch(r.body, /class=\\"wm\\" href=\\"\/web\\"/, `${name}: loader logo`);
  }
  // The thread is still the thread: the Chat tab and THE THREAD → keep pointing at it.
  assert.match(views.home.body, /href="\/web\?thread"/);
  assert.match(views.saved.body, /href="\/web\?thread"/);
});

