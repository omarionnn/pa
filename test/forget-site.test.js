// Forgetting a site clears its IndexedDB too (2026-10-23). Before, forgetSite cleared cookies and
// localStorage only, so a single-page app that kept its sign-in token in IndexedDB stayed signed in
// after Reason said it had been forgotten. Pinned two ways: the in-page clearer against a real
// Chromium origin holding a real IndexedDB database, and forgetSite's report wiring with a stand-in
// browser context (forgetSite opens https origins, which no test reaches).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-forget-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");

const signin = await import("../src/signin.js");
const db = await import("../src/db.js");
after(() => rmSync(dir, { recursive: true, force: true }));

test("clearOriginInPage deletes a real IndexedDB database, localStorage and Cache Storage", async () => {
  const { chromium } = await import("playwright");
  const server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end("<p>ok</p>"); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port + "/");
    await page.evaluate(async () => {
      localStorage.setItem("token", "abc");
      await new Promise((ok, bad) => {
        const req = indexedDB.open("auth-store", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => { const tx = req.result.transaction("kv", "readwrite"); tx.objectStore("kv").put("bearer", "token"); tx.oncomplete = () => { req.result.close(); ok(); }; };
        req.onerror = () => bad(req.error);
      });
      if (typeof caches !== "undefined") await (await caches.open("c1")).put("/x", new Response("x"));
    });
    const before = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name));
    assert.deepEqual(before, ["auth-store"]);

    const out = await page.evaluate(signin.clearOriginInPage);
    assert.deepEqual(out.deleted, ["auth-store"]);
    assert.deepEqual(out.failed, []);
    const afterState = await page.evaluate(async () => ({
      dbs: (await indexedDB.databases()).map(d => d.name),
      ls: localStorage.length,
      caches: typeof caches === "undefined" ? [] : await caches.keys(),
    }));
    assert.deepEqual(afterState, { dbs: [], ls: 0, caches: [] });
  } finally {
    await browser.close();
    server.close();
  }
});

test("forgetSite reports IndexedDB databases cleared and a held-open one as a problem", async () => {
  const site = signin.signinNames()[0];
  db.upsertAccount({ conversationId: "dm:forget", channel: "test", address: "+12025550111", name: "T", isOperator: true });
  const evaluated = [];
  const page = {
    goto: async () => {},
    evaluate: async (fn) => { evaluated.push(fn); return { deleted: ["auth-store"], failed: ["IndexedDB 'busy' was held open by the page"] }; },
    close: async () => {},
  };
  const context = { clearCookies: async () => {}, newPage: async () => page };
  const out = await signin.forgetSite(context, "dm:forget", site);
  assert.equal(out.ok, true);
  assert.ok(evaluated.length >= 1 && evaluated.every(f => f === signin.clearOriginInPage), "the page runs clearOriginInPage");
  assert.ok(out.cleared_indexeddb.length >= 1 && out.cleared_indexeddb.every(s => s.endsWith("→ auth-store")));
  assert.ok(out.problems.some(p => /held open/.test(p.error)));
  assert.match(out.also_check, /IndexedDB/);
  assert.doesNotMatch(out.also_check, /not cleared/);
});
