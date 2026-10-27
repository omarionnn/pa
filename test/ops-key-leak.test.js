// The status page's key and the owner's operator notices stay off Reason Web (owner 10-27).
//
// Home's Overnight showed "Reason check — 1 thing needs you…" and a bare heyreason.com/ops?k=… link, the
// key in plain text. One test per rule:
//
//   1. the status check's text and an alert are tagged `ops` by their sender's outbox key; Overnight never lists them
//   2. a message carrying the status page's link is never news, tagged or not (a row from before the tag)
//   3. a message split round a link is one item, headlined by its words; a link alone is named by what
//      it links to (a page Reason made) or not listed — never a bare URL
//   4. nothing the server writes carries the key — Home, the thread, history JSON — and the status page still opens
//   5. stripOpsKeys: the link keeps its address and focus, loses k=; the key itself is taken out anywhere
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-ops-key-"));
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
process.env.REASON_OPS_URL = "https://heyreason.test/ops";
process.env.REASON_WEB = "on";
process.env.REASON_WEB_DAILY = "owner";

const { createServer } = await import("../src/http.js");
const daily = await import("../src/daily.js");
const db = await import("../src/db.js");
const ops = await import("../src/ops.js");
const { stripOpsKeys, hasOpsKeyLink } = await import("../src/opsredact.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234", OWNER_C = "dm:owner";
const H = 3_600_000, D = 24 * H;
const TUE_9AM = Date.UTC(2026, 9, 27, 13, 0, 0);
const at = (ms) => { clock.reset(); clock.skip(ms - Date.now()); };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  daily.resetDaily();
  db.db.exec(`DELETE FROM accounts; DELETE FROM threads; DELETE FROM messages; DELETE FROM outbox; DELETE FROM page_sessions; DELETE FROM tasks; DELETE FROM pages;
    DELETE FROM daily_editions; DELETE FROM daily_looks; DELETE FROM daily_questions;`);
  at(TUE_9AM - 30 * D);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: OWNER, name: "Omari Nyarko", isOperator: true });
  db.upsertThread({ conversationId: OWNER_C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
  db.markWebNoticeSeen(OWNER_C);
  at(TUE_9AM - 15 * H);
  db.writeMessage({ conversationId: OWNER_C, role: "user", channel: "fake", text: "night", at: clock.now() });
});

function harness() {
  const runtime = new Runtime({ log: () => {}, runTurn: async () => "ok" });
  const router = new Router({ runtime, log: () => {} });
  router.runtime = runtime;
  router.register(new FakeChannel({ number: "+16562167455" }));
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router };
}
/** Hand a line to the owner's thread the way a sender does, and let the outbox mark it sent. */
async function send(h, text, idempotencyKey = null, when) {
  at(when);
  await h.runtime.deliver({ conversationId: OWNER_C, text, media: null, fromOwner: true, ...(idempotencyKey ? { idempotencyKey } : {}) });
  for (let i = 0; i < 20 && db.db.prepare("SELECT COUNT(*) n FROM outbox WHERE state <> 'sent'").get().n; i++) await new Promise(r => setTimeout(r, 10));
}
const headlines = () => daily.overnightFor(OWNER_C, TUE_9AM - 15 * H + 1, TUE_9AM).map(x => x.headline);

test("1. the status check's text and an alert are tagged ops; Overnight lists only what Reason did for them", async () => {
  const h = harness();
  const link = ops.opsUrl("sweep");
  await send(h, `Reason check — 1 thing needs you:\n- Sweep: not running\nStatus page: ${link}`, "ops:check:1:ab", TUE_9AM - 8 * H);
  await send(h, "Calls are failing: the provider said 500.", "incident:calls:1", TUE_9AM - 7 * H);
  await send(h, "The farmhouse inn wrote back. The room with the wood stove is open the 14th.", null, TUE_9AM - 6 * H);
  at(TUE_9AM);
  const tagged = db.db.prepare("SELECT source, COUNT(*) n FROM messages WHERE role = 'assistant' GROUP BY source").all();
  assert.deepEqual(Object.fromEntries(tagged.map(r => [r.source ?? "none", r.n])), { ops: 3, none: 1 }, "the check (two bubbles) and the alert are ops; the news is not");
  assert.deepEqual(headlines(), ["The farmhouse inn wrote back."]);
  assert.ok(db.messagesFor(OWNER_C).some(m => m.source === "ops"), "the notices stay in the thread");
});

test("2. a row carrying the status page's link is never news, even untagged (from before the tag)", () => {
  db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "fake", text: `Status page: ${ops.opsUrl()}`, at: TUE_9AM - 5 * H });
  db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "fake", text: "Your flight to Accra moved to 9:40 PM.", at: TUE_9AM - 4 * H });
  at(TUE_9AM);
  assert.deepEqual(headlines(), ["Your flight to Accra moved to 9:40 PM."]);
});

test("3. a split message is one item headlined by its words; a link alone is named or not listed", async () => {
  const h = harness();
  db.db.prepare("INSERT INTO pages (id, conversation_id, title, content, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, ?)")
    .run("pgAbc123", OWNER_C, "Woodstock weekend plan", TUE_9AM - 10 * H, TUE_9AM - 10 * H);
  await send(h, "Here's the menu: https://example.test/menu", null, TUE_9AM - 6 * H);
  await send(h, "https://files.heyreason.test/pgAbc123", null, TUE_9AM - 5 * H);
  await send(h, "https://example.test/some/thing", null, TUE_9AM - 4 * H);
  at(TUE_9AM);
  const items = headlines();
  assert.deepEqual(items, ["Woodstock weekend plan", "Here's the menu"].map(x => items.find(i => i.startsWith(x))), JSON.stringify(items));
  assert.equal(items.length, 2, "the unnamed bare link is not an item");
  assert.ok(items.every(i => !/https?:\/\//.test(i)), "never a bare URL");
});

test("4. nothing the server writes carries the key; the status page still opens", async () => {
  const h = harness();
  const key = ops.opsKey();
  await send(h, `Reason check — 1 thing needs you:\nStatus page: ${ops.opsUrl("sweep")}`, "ops:check:2:cd", TUE_9AM - 8 * H);
  // A reply the model wrote with the link in it (the status_page tool): untagged, still scrubbed.
  db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "fake", text: `Here: ${ops.opsUrl()} (key ${key})`, at: TUE_9AM - 7 * H });
  at(TUE_9AM);
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${OWNER_C}`, token, { conversationId: OWNER_C });
  const server = createServer({ router: h.router, runtime: h.runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const get = (path) => new Promise((resolve, reject) => {
    const r = request(`http://127.0.0.1:${server.address().port}${path}`, { headers: { host: "heyreason.test", cookie: `reason_page=${token}`, "sec-fetch-site": "same-origin" } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); r.end();
  });
  try {
    for (const path of ["/web", "/web?home", "/web?thread", "/web/history?after=0", "/web/memory/history?q=Status", "/web/signal"]) {
      const r = await get(path);
      assert.ok(!r.body.includes(key), `${path} (${r.status}) carries no key`);
      assert.doesNotMatch(r.body, /\/ops\?(?:[^"'\s<]*&(?:amp;)?)?k=/, `${path}: no keyed status link`);
    }
    const thread = await get("/web?thread");
    assert.equal(thread.status, 200);
    assert.match(thread.body, /heyreason\.test\/ops\?focus=sweep/, "the thread still shows the link, without the key");
    assert.doesNotMatch((await get("/web?home")).body, /Reason check/, "Home's Overnight has no ops notice");
    assert.equal((await get(`/ops?k=${key}`)).status, 200, "the status page still opens with its link");
  } finally {
    await new Promise(r => server.close(r));
  }
});

test("5. stripOpsKeys", () => {
  const key = ops.opsKey();
  assert.equal(stripOpsKeys(`see https://heyreason.test/ops?k=${key}&focus=sweep.`), "see https://heyreason.test/ops?focus=sweep.");
  assert.equal(stripOpsKeys(`<a href="/ops?k=abcDEF_-12&amp;focus=web">`), `<a href="/ops?focus=web">`);
  assert.equal(stripOpsKeys(`"url":"https://reason.example.test/ops?k=abc"`), `"url":"https://reason.example.test/ops"`);
  assert.equal(stripOpsKeys(`raw ${key} here`), "raw  here");
  assert.equal(stripOpsKeys("/ops/usage and /opsy?k=1 stay"), "/ops/usage and /opsy?k=1 stay");
  assert.equal(stripOpsKeys("https://other.example/ops?k=abc"), "https://other.example/ops?k=abc", "somebody else's site is left alone");
  assert.ok(!hasOpsKeyLink("https://other.example/ops?k=abc"));
  assert.ok(hasOpsKeyLink(`x /ops?focus=a&k=zz`));
  assert.ok(!hasOpsKeyLink("x /ops?focus=a"));
});

test("6. owner notices that are not questions go under an ops: key (harm pause, unreachable, first text)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(src("runtime.js"), /tellMaster\(line, meta\?\.channel \?\? null, \{ idempotencyKey: `ops:harm-pause:/);
  assert.match(src("runtime.js"), /tellMaster\(line, null, \{ idempotencyKey: `ops:unreachable:/);
  assert.match(src("channels/router.js"), /idempotencyKey: `ops:new-contact:/);
  for (const k of ["ops:harm-pause:x:1", "incident:calls:1", "event-created:e1", "ops:check:1:ab#2"]) assert.equal(db.opsSourceOf(k), "ops", k);
  for (const k of ["auto:fake:x:1", "timer:3", null]) assert.equal(db.opsSourceOf(k), null, String(k));
});

test("7. pick up quotes the conversation, never an operator notice", async () => {
  const h = harness();
  db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "fake", text: "Booked the 7:30 table at Lilia.", at: TUE_9AM - 2 * H });
  await send(h, "Reason check — 1 thing needs you:\n- Sweep: not running", "ops:check:3:ef", TUE_9AM - H);
  at(TUE_9AM);
  const lines = daily.pickupFor(OWNER_C).lines.map(l => l.text);
  assert.deepEqual(lines, ["night", "Booked the 7:30 table at Lilia."]);
});
