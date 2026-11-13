// The real browser (REASON_BROWSER_CHANNEL=chrome): real Google Chrome in a window, its own profile
// directory, for the people REASON_STABLE_BROWSER allows; everyone else, and every launch with the
// switch off, launches exactly as today. Fake launchers only: nothing here starts a browser.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-realbrowser-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_TZ = "America/New_York";
const ENV_KEYS = ["REASON_STABLE_BROWSER", "REASON_BROWSER_CHANNEL", "REASON_BROWSER_DISPLAY", "REASON_CHROME_PATH", "REASON_X11_DIR", "REASON_REAL_BROWSER_MAX", "DISPLAY"];
for (const k of ENV_KEYS) delete process.env[k];

const browser = await import("../src/browser.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

const OWNER = "dm:real-owner";
const STRANGER = "dm:real-stranger";
db.upsertAccount({ conversationId: OWNER, channel: "test", address: "+12025550131", name: "Owner", isOperator: true });
db.upsertAccount({ conversationId: STRANGER, channel: "test", address: "+12025550142", name: "Sam", isOperator: false });

const chromeFile = join(dir, "google-chrome");
writeFileSync(chromeFile, "");
const x11 = join(dir, "x11");
mkdirSync(x11);
writeFileSync(join(x11, "X99"), "");

const lines = [];
browser.setRealBrowserSink((l) => lines.push(l));

/** A launcher that records each launch and hands back a context that can be closed. */
function fakeLauncher({ fail = () => false } = {}) {
  const calls = [];
  return {
    calls,
    async launchPersistentContext(d, opts) {
      calls.push({ dir: d, opts });
      if (fail(opts)) throw new Error("Chrome failed to start");
      const ctx = new EventEmitter();
      ctx.close = async () => { ctx.emit("close"); };
      return ctx;
    },
  };
}

const TODAY = () => ({ headless: true, viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
const set = (env) => { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, env); };
const READY = { REASON_BROWSER_CHANNEL: "chrome", REASON_BROWSER_DISPLAY: ":99", REASON_CHROME_PATH: chromeFile, REASON_X11_DIR: x11 };

beforeEach(() => { lines.length = 0; set({}); });
after(() => { for (const k of ENV_KEYS) delete process.env[k]; rmSync(dir, { recursive: true, force: true }); });

test("switch off: the channel setting alone changes nothing, for the owner or anyone", async () => {
  set({ ...READY });
  for (const who of [OWNER, STRANGER]) {
    const l = fakeLauncher();
    const today = TODAY();
    await browser.launchProfile(l, who, today, { platform: "linux" });
    assert.equal(l.calls.length, 1);
    assert.equal(l.calls[0].dir, browser.profilePath(who));
    assert.equal(l.calls[0].opts, today, "today's launch object, untouched");
  }
  assert.deepEqual(lines, []);
});

test("owner mode: the owner gets real Chrome, headed, on the display, in its own profile; a stranger gets today", async () => {
  set({ ...READY, REASON_STABLE_BROWSER: "owner" });
  const l = fakeLauncher();
  const ctx = await browser.launchProfile(l, OWNER, TODAY(), { platform: "linux" });
  const { dir: d, opts } = l.calls[0];
  assert.equal(d, browser.realProfilePath(OWNER));
  assert.notEqual(d, browser.profilePath(OWNER));
  assert.ok(d.startsWith(join(config.profileRoot, ".real-chrome") + "/"));
  assert.equal(opts.channel, "chrome");
  assert.equal(opts.headless, false);
  assert.equal(opts.env.DISPLAY, ":99");
  assert.equal(opts.timezoneId, "America/New_York");
  assert.equal(opts.locale, "en-US");
  // Honest: no user agent of our own, no flag that hides automation.
  assert.equal(opts.userAgent, undefined);
  assert.equal(opts.ignoreDefaultArgs, undefined);
  assert.ok(!(opts.args ?? []).some((a) => /AutomationControlled|user-agent/i.test(a)));
  assert.ok(browser.isRealBrowser(ctx));
  assert.equal(browser.realBrowsersOpen(), 1);
  await ctx.close();
  assert.equal(browser.realBrowsersOpen(), 0);

  const s = fakeLauncher();
  const today = TODAY();
  await browser.launchProfile(s, STRANGER, today, { platform: "linux" });
  assert.equal(s.calls[0].dir, browser.profilePath(STRANGER));
  assert.equal(s.calls[0].opts, today);
  assert.deepEqual(lines, []);
});

test("stable on without the channel line: the stable setting as before, today's profile directory", async () => {
  set({ REASON_STABLE_BROWSER: "owner" });
  const l = fakeLauncher();
  await browser.launchProfile(l, OWNER, TODAY(), { platform: "linux" });
  assert.equal(l.calls[0].dir, browser.profilePath(OWNER));
  assert.equal(l.calls[0].opts.channel, "chromium");
  assert.equal(l.calls[0].opts.headless, true);
});

test("Chrome missing: that launch is today's browser in today's profile, one numbers-only line", async () => {
  set({ ...READY, REASON_STABLE_BROWSER: "owner", REASON_CHROME_PATH: join(dir, "no-chrome-here") });
  const l = fakeLauncher();
  await browser.launchProfile(l, OWNER, TODAY(), { platform: "linux" });
  assert.equal(l.calls.length, 1);
  assert.equal(l.calls[0].dir, browser.profilePath(OWNER));
  assert.equal(l.calls[0].opts.channel, "chromium");
  assert.deepEqual(lines, ["real-browser fallback code=1 open=0 cap=2"]);
});

test("display missing or unset: fall back (code 2); the Mac needs no display", async () => {
  set({ ...READY, REASON_STABLE_BROWSER: "owner", REASON_BROWSER_DISPLAY: ":42" });
  let l = fakeLauncher();
  await browser.launchProfile(l, OWNER, TODAY(), { platform: "linux" });
  assert.equal(l.calls[0].dir, browser.profilePath(OWNER));
  set({ ...READY, REASON_STABLE_BROWSER: "owner", REASON_BROWSER_DISPLAY: "" });
  l = fakeLauncher();
  await browser.launchProfile(l, OWNER, TODAY(), { platform: "linux" });
  assert.equal(l.calls[0].dir, browser.profilePath(OWNER));
  assert.deepEqual(lines, ["real-browser fallback code=2 open=0 cap=2", "real-browser fallback code=2 open=0 cap=2"]);
  l = fakeLauncher();
  const ctx = await browser.launchProfile(l, OWNER, TODAY(), { platform: "darwin" });
  assert.equal(l.calls[0].opts.channel, "chrome");
  assert.equal(l.calls[0].opts.env, undefined);
  await ctx.close();
});

test("Chrome fails to start: today's browser for that launch (code 4); the turn goes on", async () => {
  set({ ...READY, REASON_STABLE_BROWSER: "owner" });
  const l = fakeLauncher({ fail: (o) => o.channel === "chrome" });
  const ctx = await browser.launchProfile(l, OWNER, TODAY(), { platform: "linux" });
  assert.equal(l.calls.length, 2);
  assert.equal(l.calls[1].dir, browser.profilePath(OWNER));
  assert.ok(!browser.isRealBrowser(ctx));
  assert.equal(browser.realBrowsersOpen(), 0);
  assert.deepEqual(lines, ["real-browser fallback code=4 open=0 cap=2"]);
});

test("the cap: no more than REASON_REAL_BROWSER_MAX real browsers at once; a closed one frees its place", async () => {
  set({ ...READY, REASON_STABLE_BROWSER: "on", REASON_REAL_BROWSER_MAX: "1" });
  const l = fakeLauncher();
  const a = await browser.launchProfile(l, OWNER, TODAY(), { platform: "linux" });
  const b = await browser.launchProfile(l, STRANGER, TODAY(), { platform: "linux" });
  assert.ok(browser.isRealBrowser(a));
  assert.ok(!browser.isRealBrowser(b));
  assert.equal(l.calls[1].dir, browser.profilePath(STRANGER));
  assert.deepEqual(lines, ["real-browser fallback code=3 open=1 cap=1"]);
  await a.close();
  const c = await browser.launchProfile(l, STRANGER, TODAY(), { platform: "linux" });
  assert.ok(browser.isRealBrowser(c));
  assert.equal(l.calls[2].dir, browser.realProfilePath(STRANGER));
  await c.close();
  await b.close();
  assert.equal(browser.realBrowsersOpen(), 0);
});

test("orphans: only top-level Chrome processes on a real-browser profile are killed", () => {
  const proc = join(dir, "proc");
  const root = join(config.profileRoot, ".real-chrome");
  const mk = (pid, args) => { mkdirSync(join(proc, String(pid)), { recursive: true }); writeFileSync(join(proc, String(pid), "cmdline"), args.join("\0")); };
  mk(101, ["/opt/google/chrome/chrome", `--user-data-dir=${join(root, "dm_real-owner")}`]);
  mk(102, ["/opt/google/chrome/chrome", "--type=renderer", `--user-data-dir=${join(root, "dm_real-owner")}`]);
  mk(103, ["/opt/google/chrome/chrome", `--user-data-dir=${join(config.profileRoot, "dm_real-owner")}`]);
  mk(104, ["/usr/bin/node", "src/serve.js"]);
  const killed = [];
  const n = browser.killRealOrphans({ procDir: proc, kill: (p) => killed.push(p), root });
  assert.equal(n, 1);
  assert.deepEqual(killed, [101]);
});

test("the real profile is per person and never the old directory", () => {
  assert.notEqual(browser.realProfilePath(OWNER), browser.realProfilePath(STRANGER));
  assert.notEqual(browser.realProfilePath(OWNER), browser.profilePath(OWNER));
  assert.ok(!browser.profilePath(OWNER).includes(".real-chrome"));
});
