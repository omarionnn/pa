// One stable, honest browser per person, and one browser per profile at a time (vault PR 2).
//
// The launch setting is behind REASON_STABLE_BROWSER (off | owner | on, default off): off, every
// flow launches exactly as before; on for a person, every launch of their profile has one window
// size, one language, their time zone and one build. The lock is not switched: while a sign-in holds
// a person's profile, the errand browser opens and reads nothing and every browser tool says so in a
// fixed line. Fixtures on 127.0.0.1 only; nothing here reaches the internet.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-launch-"));
// This file's fixture page lives on 127.0.0.1; outside a test, nothing may load there (src/netguard.js).
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1";
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_TZ = "America/New_York";
delete process.env.REASON_STABLE_BROWSER;

const browser = await import("../src/browser.js");
const remote = await import("../src/signin-remote.js");
const win = await import("../src/signin-window.js");
const db = await import("../src/db.js");
const { runTool } = await import("../src/tools.js");
const { config } = await import("../src/config.js");

const OWNER = "dm:launch-owner";
const STRANGER = "dm:launch-stranger";
db.upsertAccount({ conversationId: OWNER, channel: "test", address: "+12025550111", name: "Omari", isOperator: true });
db.upsertAccount({ conversationId: STRANGER, channel: "test", address: "+12025550122", name: "Sam", isOperator: false });

/** Each flow's own launch, exactly as main had it before this change. */
const TODAY = {
  errand: () => ({ headless: !config.browserHeaded, viewport: { width: 1280, height: 900 }, serviceWorkers: "block" }),
  signin_link: () => ({ headless: true, viewport: remote.VIEW, deviceScaleFactor: 2, args: ["--disable-smooth-scrolling"] }),
  signin_window: () => ({ headless: false, viewport: null }),
  signin_check: () => ({ headless: true, viewport: { width: 1280, height: 900 }, args: undefined }),
};

const withSwitch = async (value, fn) => {
  const old = process.env.REASON_STABLE_BROWSER;
  if (value === undefined) delete process.env.REASON_STABLE_BROWSER; else process.env.REASON_STABLE_BROWSER = value;
  try { return await fn(); } finally {
    if (old === undefined) delete process.env.REASON_STABLE_BROWSER; else process.env.REASON_STABLE_BROWSER = old;
  }
};

const lines = [];
browser.setBusySink((l) => lines.push(l));
/** The fixture page on 127.0.0.1, started by the first real-browser test and closed after all of them. */
let site = null;

beforeEach(async () => {
  lines.length = 0;
  for (const c of [OWNER, STRANGER]) {
    const h = browser.profileHolder(c);
    if (h !== null) browser.releaseProfile(c, h);
  }
  await browser.closeAllBrowsers();
});
after(async () => {
  await browser.closeAllBrowsers();
  await site?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the switch: off unless set, owner and on, read at call time", async () => {
  await withSwitch(undefined, () => {
    assert.equal(browser.stableBrowserMode(), "off");
    assert.equal(browser.stableBrowserAllowedFor(OWNER), false);
  });
  await withSwitch("nonsense", () => assert.equal(browser.stableBrowserMode(), "off"));
  await withSwitch(" Owner ", () => {
    assert.equal(browser.stableBrowserMode(), "owner");
    assert.equal(browser.stableBrowserAllowedFor(OWNER), true);
    assert.equal(browser.stableBrowserAllowedFor(STRANGER), false);
    assert.equal(browser.stableBrowserAllowedFor(""), false);
  });
  await withSwitch("on", () => {
    assert.equal(browser.stableBrowserMode(), "on");
    assert.equal(browser.stableBrowserAllowedFor(STRANGER), true);
  });
  // No restart between: the very next call reads the environment again.
  await withSwitch("1", () => assert.equal(browser.stableBrowserMode(), "on"));
});

test("off: every flow's own launch is handed back untouched, the same object", async () => {
  await withSwitch(undefined, () => {
    for (const [flow, make] of Object.entries(TODAY)) {
      for (const c of [OWNER, STRANGER]) {
        const today = make();
        assert.equal(browser.launchOptions(c, today), today, `${flow} for ${c}`);
        assert.deepEqual(browser.launchOptions(c, make()), make(), flow);
      }
    }
  });
  // Owner mode is off for everyone else, the same way.
  await withSwitch("owner", () => {
    const today = TODAY.signin_link();
    assert.equal(browser.launchOptions(STRANGER, today), today);
  });
});

test("owner: every launch of the operator's profile has the same window, language, zone and build", async () => {
  await withSwitch("owner", () => {
    const seen = Object.entries(TODAY).map(([flow, make]) => ({ flow, today: make(), got: browser.launchOptions(OWNER, make()) }));
    const { headless: _h, ...first } = seen[0].got;
    for (const { flow, today, got } of seen) {
      const { headless, ...rest } = got;
      assert.deepEqual(rest, first, flow);
      // Whether a window shows stays the flow's own: the window on the Mac is still a window.
      assert.equal(headless, today.headless !== false, flow);
    }
    assert.deepEqual(first.viewport, { width: 1280, height: 900 });
    assert.equal(first.deviceScaleFactor, 1);
    assert.equal(first.locale, "en-US");
    assert.equal(first.timezoneId, "America/New_York");
    assert.equal(first.channel, "chromium");
    assert.equal(first.serviceWorkers, "block");
    // Honest: no flag that hides automation, no user agent of its own.
    assert.deepEqual(first.args, ["--disable-smooth-scrolling"]);
    assert.equal("userAgent" in first, false);
    assert.equal(first.args.some((a) => /AutomationControlled|user-agent/i.test(a)), false);
  });
});

test("every launch of a saved profile goes through launchOptions", () => {
  // The launch sites, by file: the errand browser, the phone link and emailed-code sign-in, and the
  // operator's window, check and forget. A new launch that skipped the setting would fail here.
  // The vault filler too. Each goes through launchProfile (src/browser.js), the one place a profile
  // is launched: today's directory with launchOptions, or the real browser's own directory with
  // realLaunchOptions, which is launchOptions with the real build in a window.
  const want = { "src/browser.js": 1, "src/signin-remote.js": 1, "src/signin-cli.js": 3, "src/filler.js": 1 };
  for (const [file, n] of Object.entries(want)) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const calls = [...src.matchAll(/await launchProfile\(\w+, conversationId, /g)];
    assert.equal(calls.length, n, `${file}: ${calls.length} launches`);
    if (file !== "src/browser.js") assert.equal([...src.matchAll(/launchPersistentContext\(/g)].length, 0, `${file} launches a profile itself`);
  }
  const b = readFileSync(new URL("../src/browser.js", import.meta.url), "utf8");
  const direct = [...b.matchAll(/launcher\.launchPersistentContext\(([^,]+),\s*([^\n]*)/g)].map((m) => [m[1].trim(), m[2].trim()]);
  assert.deepEqual(direct.map(([d, o]) => [d.split("(")[0], o.split("(")[0]]), [["realProfileDirFor", "realLaunchOptions"], ["profileDirFor", "launchOptions"]]);
  assert.match(b, /const opts = \{ \.\.\.launchOptions\(conversationId, today\), headless: false, channel: "chrome" \};/);
});

test("the lock: one holder at a time, only the holder gives it back, a throw inside still gives it back", async () => {
  const a = Symbol("a"), b = Symbol("b");
  assert.equal(browser.profileHolder(OWNER), null);
  assert.equal(browser.holdProfile(OWNER, a), true);
  assert.equal(browser.holdProfile(OWNER, a), true, "the same holder again is a yes");
  assert.equal(browser.holdProfile(OWNER, b), false);
  assert.equal(browser.profileHolder(OWNER), a);
  assert.equal(browser.profileHolder(STRANGER), null, "one person's lock is not another's");
  browser.releaseProfile(OWNER, b);
  assert.equal(browser.profileHolder(OWNER), a, "a late release from another run frees nothing");
  browser.releaseProfile(OWNER, a);
  assert.equal(browser.profileHolder(OWNER), null);

  await assert.rejects(browser.withProfile(OWNER, a, async () => {
    assert.equal(browser.profileHolder(OWNER), a);
    throw new Error("the sign-in crashed");
  }), /crashed/);
  assert.equal(browser.profileHolder(OWNER), null, "a crash inside the holder still releases");

  browser.holdProfile(OWNER, b);
  await assert.rejects(browser.withProfile(OWNER, a, async () => "never"), browser.ProfileBusy);
  assert.equal(browser.profileHolder(OWNER), b);
  browser.releaseProfile(OWNER, b);
});

test("while a sign-in holds the profile, pageFor opens and reads nothing and the line names no one", async () => {
  const holder = Symbol("signin");
  browser.holdProfile(STRANGER, holder);
  await assert.rejects(browser.pageFor(STRANGER), (e) => e instanceof browser.ProfileBusy && e.answer === browser.BUSY);
  assert.equal(existsSync(browser.profilePath(STRANGER)), false, "no browser was launched: its profile was never even made");
  assert.equal(browser.openPage(STRANGER), null, "nothing to look at, so nothing is pictured");
  assert.deepEqual(browser.profileBusy(STRANGER), { ok: false, busy: "signing_in" });
  assert.equal(browser.profileBusy(OWNER), null);
  assert.deepEqual(lines, ["browser busy: signing_in"]);
  assert.equal(lines.some((l) => l.includes(STRANGER)), false);
  browser.releaseProfile(STRANGER, holder);
  assert.equal(browser.profileBusy(STRANGER), null);
});

test("a browser tool answers the fixed busy line while the profile is held", async () => {
  const holder = Symbol("signin");
  browser.holdProfile(OWNER, holder);
  try {
    const out = await runTool("browser_open", { url: "http://127.0.0.1:9/" }, { conversationId: OWNER, messages: [{ role: "user", content: "open it" }] });
    assert.deepEqual(out, { ok: false, busy: "signing_in" });
    const read = await runTool("browser_read", {}, { conversationId: OWNER, messages: [{ role: "user", content: "read it" }] });
    assert.deepEqual(read, { ok: false, busy: "signing_in" });
    const offer = await runTool("offer_check", { from_browser: true }, { conversationId: OWNER, messages: [{ role: "user", content: "check it" }] });
    assert.deepEqual(offer, { ok: false, busy: "signing_in" });
  } finally {
    browser.releaseProfile(OWNER, holder);
  }
});

/** A window process that is "open" until the test ends it. */
function fakeWindow() {
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 4343;
    child.kill = () => { setImmediate(() => child.emit("exit", null)); return true; };
    children.push(child);
    return child;
  };
  const timers = { set: () => ({}), clear: () => {} };
  return { children, spawnImpl, timers };
}

test("the window on the Mac holds the profile until its process has gone, and waits its turn", async () => {
  const entry = { site: "amazon", label: "Amazon", signin_url: "https://www.amazon.com/" };
  const w = fakeWindow();
  const closed = [];
  const out = await win.openSigninWindow({ conversationId: STRANGER, entry, spawnImpl: w.spawnImpl, timers: w.timers, closeBrowser: async (c) => { closed.push(c); } });
  assert.equal(out.ok, true);
  assert.deepEqual(closed, [STRANGER], "the errand browser was closed first");
  assert.notEqual(browser.profileHolder(STRANGER), null);
  await assert.rejects(browser.pageFor(STRANGER), browser.ProfileBusy);
  // It crashed: still released.
  w.children[0].emit("exit", 1);
  assert.equal(browser.profileHolder(STRANGER), null);

  // A sign-in link already has it: the window does not open, and nothing is spawned.
  const holder = Symbol("signin_link");
  browser.holdProfile(STRANGER, holder);
  const w2 = fakeWindow();
  const refused = await win.openSigninWindow({ conversationId: STRANGER, entry, spawnImpl: w2.spawnImpl, timers: w2.timers });
  assert.equal(refused.ok, false);
  assert.equal(refused.busy, "signing_in");
  assert.equal(w2.children.length, 0);
  assert.equal(browser.profileHolder(STRANGER), holder);
  browser.releaseProfile(STRANGER, holder);

  // A window that never started gives it back too.
  const broken = await win.openSigninWindow({ conversationId: STRANGER, entry, spawnImpl: () => { throw new Error("no node"); }, timers: w.timers });
  assert.equal(broken.ok, false);
  assert.equal(browser.profileHolder(STRANGER), null);
});

// ---------- real Chromium, on a page on 127.0.0.1 ----------

async function fixture() {
  if (site) return site;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>fixture</title><p>a page</p>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  site = { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
  return site;
}
/** What a site can read off the browser. Read once the page has settled: a first load can still be moving. */
async function seen(page) {
  for (let i = 0; ; i++) {
    try {
      await page.waitForLoadState("load");
      return await page.evaluate(() => ({
        w: innerWidth, h: innerHeight, dpr: devicePixelRatio, lang: navigator.language,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }));
    } catch (e) {
      if (i >= 3 || !/context was destroyed|navigation/i.test(e.message)) throw e;
    }
  }
}
async function canLaunch() {
  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch({ headless: true, channel: "chromium" });
    await b.close();
    return true;
  } catch { return false; }
}

test("real Chromium, owner on: the errand browser and the sign-in browser are the same browser to a site", async (t) => {
  if (!(await canLaunch())) return t.skip("Playwright's Chromium is not downloaded here");
  const { url } = await fixture();
  await withSwitch("owner", async () => {
    const page = await browser.pageFor(OWNER);
    await page.goto(url);
    const errand = await seen(page);
    await browser.closeBrowser(OWNER);

    const signin = await remote.launchProfileBrowser({ conversationId: OWNER, url });
    try {
      assert.deepEqual(signin.view, { width: 1280, height: 900 }, "the picture's size is the browser's");
      assert.notEqual(browser.profileHolder(OWNER), null);
      await assert.rejects(browser.pageFor(OWNER), browser.ProfileBusy, "two flows cannot open one profile");
      const s = await seen(signin.page);
      assert.deepEqual(s, errand);
      assert.deepEqual(s, { w: 1280, h: 900, dpr: 1, lang: "en-US", tz: "America/New_York" });
    } finally {
      await signin.close();
    }
    assert.equal(browser.profileHolder(OWNER), null, "closing the sign-in browser gives the profile back");
    const again = await browser.pageFor(OWNER);
    assert.equal(again.isClosed(), false, "and then the errand browser opens");
    await browser.closeBrowser(OWNER);
  });
});

test("real Chromium, off: the sign-in browser opens exactly as before and the errand browser waits for it", async (t) => {
  if (!(await canLaunch())) return t.skip("Playwright's Chromium is not downloaded here");
  const { url } = await fixture();
  await withSwitch(undefined, async () => {
    const signin = await remote.launchProfileBrowser({ conversationId: STRANGER, url });
    try {
      assert.equal(signin.view, remote.VIEW);
      const s = await seen(signin.page);
      assert.equal(s.w, 430);
      assert.equal(s.h, 700);
      assert.equal(s.dpr, 2);
      await assert.rejects(browser.pageFor(STRANGER), browser.ProfileBusy);
      // A second sign-in on the same profile is refused before it launches anything.
      await assert.rejects(remote.launchProfileBrowser({ conversationId: STRANGER, url }), /already open/);
    } finally {
      await signin.close();
    }
    assert.equal(browser.profileHolder(STRANGER), null);
    const page = await browser.pageFor(STRANGER);
    await page.goto(url);
    const e = await seen(page);
    assert.equal(e.w, 1280);
    assert.equal(e.h, 900);
    await browser.closeBrowser(STRANGER);
  });
});
