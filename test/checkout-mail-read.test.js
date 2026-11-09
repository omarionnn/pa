// Review 11-08 (merge gate on #412): the end-of-checkout look in their mail, against the real Gmail reader.
// A Gmail error came back as "searched, nothing there", so the end text said "nothing from Ulta since the
// payment yet" when nothing had been searched; and two looks in flight at once must wake the model once.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-checkout-mail-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_TOKEN_KEY = "22".repeat(32);
process.env.GOOGLE_OAUTH_CLIENT_ID = "cid_test";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret_test";
process.env.GOOGLE_GMAIL_BASE = "https://gm.test";

const shop = await import("../src/shopconnect.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const q = (sql) => db.db.prepare(sql);
const woke = [];
let gmail = null;
const realFetch = globalThis.fetch;

before(() => {
  shop.attach({ say: () => {}, wake: (conv, t) => { woke.push({ conv, t }); } });
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.host !== "gm.test") throw new Error(`unexpected fetch ${u.host}`);
    return gmail(u, init);
  };
});
after(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  woke.length = 0;
  shop._setMail(null);
  db.db.exec("DELETE FROM shop_runs");
  db.saveOauthTokens(OMARI, "google", { accessToken: "at_1", scope: "https://www.googleapis.com/auth/gmail.modify", expiresAt: clock.now() + 3600_000, accountLabel: "omari@gmail.com" });
});
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const run = (id) => {
  const now = clock.now();
  q("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at) VALUES (?, ?, 'ulta', 'CeraVe', 'guest', 'running', ?, ?)").run(id, OMARI, now, now);
  q("UPDATE shop_runs SET paid_at = ?, mail_until = ? WHERE run_id = ?").run(now, now + shop.MAIL_WATCH_MS, id);
  return id;
};

test("a Gmail error is 'couldn't look', never 'nothing there'", async () => {
  const id = run("run_err");
  gmail = async () => json(500, { error: { message: "backend error" } });
  const out = await shop.checkMail(id, { ending: true });
  assert.equal(out.looked, false, JSON.stringify(out));
  assert.equal(out.done, false, "the watch goes on: the next tick tries again");
  // The same mailbox answering: a real look, nothing there.
  gmail = async (u) => (u.pathname.endsWith("/messages") ? json(200, { messages: [] }) : json(404, {}));
  const ok = await shop.checkMail(id, { ending: true });
  assert.equal(ok.looked, true);
  assert.equal(ok.hits, 0);
});

test("two looks in flight at once wake the model once for the same mail", async () => {
  const id = run("run_race");
  gmail = async (u) => {
    await new Promise((r) => setTimeout(r, 5));
    if (u.pathname.endsWith("/messages")) return json(200, { messages: [{ id: "m_conf" }] });
    return json(200, { id: "m_conf", threadId: "t_c", payload: { headers: [{ name: "From", value: "Ulta <orders@ulta.com>" }, { name: "Subject", value: "Your Ulta order is confirmed" }, { name: "Date", value: "Sun, 8 Nov 2026 16:10:00 -0500" }] } });
  };
  const [a, b] = await Promise.all([shop.checkMail(id), shop.checkMail(id, { ending: true })]);
  assert.equal(woke.length, 1, "one wake for one message");
  assert.equal([a, b].filter((o) => o.hits > 0).length, 1, "only one of them counts it as new");
  const other = a.hits > 0 ? b : a;
  assert.deepEqual(other.already.map((h) => h.message_id), ["m_conf"], "the other one reports it as already found");
});
