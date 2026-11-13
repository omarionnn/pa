// The load-only probe of sign-in pages under honest browser setups (vault PR 2, src/probesetups.js,
// `npm run probe:sites -- --setup`). Stub browsers and one page on 127.0.0.1: nothing here reaches a
// real site, and nothing here can type.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "reason-probesetups-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
after(() => rmSync(dir, { recursive: true, force: true }));

const probe = await import("../src/probesetups.js");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const refusedJson = JSON.parse(readFileSync(join(ROOT, "docs/site-probe-2026-11-12-signin.json"), "utf8"));
const SETTING = { channel: "chromium", viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "America/New_York", serviceWorkers: "block", args: ["--disable-smooth-scrolling"] };
const ok = async () => ({ ok: true });

/**
 * A stub browser. Each address answers what `answers` says; the page throws if anything that could
 * type or press is ever touched, and every goto is written down.
 */
function stubLauncher(answers = {}, { failLaunch = false } = {}) {
  const gotos = [];
  const launches = [];
  const touched = [];
  const launcher = {
    async launchPersistentContext(profile, options) {
      launches.push({ profile, options, existed: existsSync(profile) });
      if (failLaunch) throw new Error("no browser here");
      let current = "about:blank";
      const ctx = {
        async newPage() {
          const page = {
            async goto(url) {
              gotos.push(url);
              const a = answers[url] ?? { status: 200, kind: "signin_form" };
              if (a.throws) throw new Error(a.throws);
              current = a.landed ?? url;
              page._answer = a;
              return { status: () => a.status, allHeaders: async () => ({ "content-type": "text/html", ...(a.headers ?? {}) }) };
            },
            url: () => current,
            async title() { return page._answer?.title ?? "Sign in"; },
            async close() {},
          };
          for (const m of ["fill", "type", "press", "click", "keyboard", "mouse", "locator", "check", "tap"]) {
            Object.defineProperty(page, m, { get() { touched.push(m); throw new Error(`stub page: ${m} touched`); } });
          }
          return page;
        },
        async cookies() { return (answers[current]?.cookies ?? []).map((name) => ({ name, value: "never-read" })); },
        async close() {},
      };
      return ctx;
    },
  };
  return { launcher, gotos, launches, touched };
}
/** The stub page's kind, handed back the way src/signinpage.js readPage does. */
const stubRead = async (page) => ({ kind: page._answer?.kind ?? "loading" });

const run = (over = {}) => probe.runSetups({
  setup: "A0", sites: [], launcher: stubLauncher().launcher, setting: SETTING, publicUrl: ok,
  platform: "linux", scratchDir: dir, formWaitMs: 50, pollMs: 1, readPage: stubRead, ...over,
});

test("the probe and the launch code import nothing that holds a login", () => {
  // The whole static import graph of the probe script, the probe and every launch of a profile.
  const start = ["scripts/probe-sites.js", "src/probesetups.js", "src/browser.js", "src/signin-remote.js", "src/signin-cli.js", "src/signin-window.js"];
  const seen = new Set();
  const queue = start.map((f) => join(ROOT, f));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:import\s[^"'`]*?from\s*|import\s*\(\s*|^import\s*)["']([^"']+)["']/gm)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (existsSync(target)) queue.push(target);
    }
  }
  assert.ok(seen.size > 10, `read ${seen.size} files`);
  const vault = [...seen].filter((f) => /vault/i.test(f.slice(ROOT.length)));
  assert.deepEqual(vault, []);
});

test("a full fixture run touches nothing that types, loads each site once and types nothing", async () => {
  const sites = probe.signin1112List({ refusedJson, entryFor: () => null });
  const stub = stubLauncher();
  const out = await run({ sites, launcher: stub.launcher });
  assert.deepEqual(stub.touched, []);
  assert.equal(out.typed_characters, 0);
  assert.equal(out.refused_calls, 0);
  assert.equal(out.loads.length, 24, "15 refused sites and 9 controls");
  assert.equal(new Set(stub.gotos).size, stub.gotos.length, "no site loaded twice");
  assert.equal(stub.launches.length, 1, "one browser for the run");
  assert.deepEqual(stub.launches[0].options, { headless: true, viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  for (const l of out.loads) assert.equal(l.page_kind, "signin_form");
  // The sites are named from now on, the ones it would not load included.
  assert.equal(out.sites_named.length, 29);
});

test("the probe page itself refuses anything that types or presses", () => {
  const counter = { typed_characters: 0, refused_calls: 0 };
  const page = probe.readOnlyPage({ url: () => "https://example.test/", fill() {}, click() {}, keyboard: {} }, counter);
  assert.equal(page.url(), "https://example.test/");
  for (const m of ["fill", "click", "keyboard", "type", "press", "mouse", "locator"]) assert.throws(() => page[m], /never uses/);
  assert.equal(counter.refused_calls, 7);
  assert.equal(counter.typed_characters, 0);
});

test("the never list: uber.com and x.com are skipped with their row, and never loaded", async () => {
  const sites = probe.parseList("uber.com,x.com,https://auth.uber.com/login,medium.com", { refusedJson });
  const stub = stubLauncher();
  const out = await run({ sites, launcher: stub.launcher });
  assert.deepEqual(out.skipped, [
    { site: "uber.com", reason: "never list: sites whose terms forbid giving an agent the login" },
    { site: "x.com", reason: "never list: social networks" },
    { site: "https://auth.uber.com/login", reason: "never list: sites whose terms forbid giving an agent the login" },
  ]);
  assert.deepEqual(stub.gotos, ["https://medium.com/"]);
  assert.equal(probe.neverRow("ticketmaster.com"), "ticket buying");
  assert.equal(probe.neverRow("www.reddit.com"), "social networks");
  assert.equal(probe.neverRow("medium.com"), "");
  assert.equal(probe.neverRow("boxer.com"), "", "x.com is not every name ending in x.com");
});

test("one refusal stops: a wall is recorded once, by its names only, with no second load", async () => {
  const url = "https://walled.example/login";
  const stub = stubLauncher({ [url]: { status: 403, kind: "challenge", title: "Attention Required!", headers: { "cf-mitigated": "challenge", "cf-ray": "abc" }, cookies: ["__cf_bm"] } });
  const sites = [{ site: "walled", group: "refused", url, never: "" }, { site: "walled", group: "refused", url, never: "" }];
  const out = await run({ sites, launcher: stub.launcher });
  assert.deepEqual(stub.gotos, [url], "one load, no retry, no other address");
  assert.equal(out.loads.length, 1);
  const [l] = out.loads;
  assert.equal(l.status, 403);
  assert.equal(l.walled, true);
  assert.deepEqual(l.wall_vendor, ["cloudflare"]);
  assert.equal(l.page_kind, "challenge");
  assert.equal(l.ms_to_form, null);
  assert.equal(JSON.stringify(out).includes("abc"), false, "no header value is kept");
  assert.equal(JSON.stringify(out).includes("never-read"), false, "no cookie value is kept");
});

test("wall vendors are read off names", () => {
  assert.deepEqual(probe.wallVendors(["_abck", "ak_bmsc", "datadome", "_pxhd", "x-kpsdk-ct", "incap_ses_123", "reese84", "cf-ray"]), ["akamai", "cloudflare", "datadome", "imperva", "kasada", "perimeterx"]);
  assert.deepEqual(probe.wallVendors(["session", "content-type"]), []);
});

test("the scratch profile is gone after the run, and after a browser that would not start", async () => {
  const stub = stubLauncher();
  const out = await run({ sites: [{ site: "a", group: "control", url: "https://a.example/", never: "" }], launcher: stub.launcher });
  assert.equal(stub.launches[0].existed, true, "a fresh profile was made for the run");
  assert.equal(existsSync(stub.launches[0].profile), false);
  assert.equal(out.scratch_profile_deleted, true);
  const broken = stubLauncher({}, { failLaunch: true });
  await assert.rejects(run({ sites: [], launcher: broken.launcher }), /no browser here/);
  assert.equal(existsSync(broken.launches[0].profile), false);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("probe-setup-")), []);
});

test("setups: A3 checks each address itself, A4 only on the Mac, A0-A3 only on the server, nothing past A4", async () => {
  const stub = stubLauncher();
  let guarded = 0;
  const out = await run({
    setup: "A3", launcher: stub.launcher, guard: async () => { guarded += 1; },
    sites: [{ site: "inside", group: "named", url: "http://10.0.0.5/", never: "" }, { site: "outside", group: "named", url: "https://ok.example/", never: "" }],
    publicUrl: async (u) => (u.includes("10.0.0.5") ? { ok: false, why: "the link points at this machine's own network rather than at the internet" } : { ok: true }),
  });
  assert.equal(guarded, 0, "A3 runs without the in-page guard");
  assert.equal(out.guard, "probe_precheck");
  assert.deepEqual(out.skipped, [{ site: "inside", reason: "refused by probe: the link points at this machine's own network rather than at the internet" }]);
  assert.deepEqual(stub.gotos, ["https://ok.example/"]);
  assert.equal(stub.launches[0].options.channel, "chrome");
  assert.equal(stub.launches[0].options.headless, false);

  const a1 = stubLauncher();
  await run({ setup: "A1", launcher: a1.launcher, guard: async () => { guarded += 1; } });
  assert.equal(guarded, 1);
  assert.deepEqual(a1.launches[0].options, { ...SETTING, headless: false });

  await assert.rejects(run({ setup: "A4", platform: "linux" }), /run it on the Mac/);
  await assert.rejects(run({ setup: "A0", platform: "darwin" }), /run it on the server/);
  await assert.rejects(run({ setup: "A5" }), /no setup called 'A5'/);
  await assert.rejects(run({ setup: "B1" }), /no setup called 'B1'/);
  const a4 = stubLauncher();
  const home = await run({ setup: "A4", platform: "darwin", launcher: a4.launcher });
  assert.equal(home.where, "home");
});

test("signin-1112: the 20 refused and 9 controls are named, and 15 refused are left to load", () => {
  const entryFor = (n) => (n === "claude.ai" ? { signin_url: "https://claude.ai/login" } : null);
  const list = probe.signin1112List({ refusedJson, entryFor });
  assert.equal(list.filter((s) => s.group === "refused").length, 20);
  assert.equal(list.filter((s) => s.group === "control").length, 9);
  const never = list.filter((s) => s.never).map((s) => s.site).sort();
  assert.deepEqual(never, ["LinkedIn", "Reddit", "Ticketmaster", "Uber / Uber Eats", "X"]);
  assert.equal(list.filter((s) => s.group === "refused" && !s.never).length, 15);
  assert.equal(list.find((s) => s.site === "claude.ai").url, "https://claude.ai/login");
  assert.equal(list.find((s) => s.site === "Medium").url, "https://medium.com/");
  assert.deepEqual(probe.parseList("signin-1112", { refusedJson, entryFor }), list);
});

test("merging setups names the least disguised setup that reached a form", () => {
  const named = [{ site: "a", group: "refused", url: "https://a.example/", never: null }, { site: "b", group: "refused", url: "https://b.example/", never: null }];
  const load = (site, setup, page_kind) => ({ site, group: "refused", url: `https://${site}.example/`, setup, status: page_kind === "challenge" ? 403 : 200, final_host: `${site}.example`, page_kind, ms_to_form: page_kind === "signin_form" ? 900 : null, wall_vendor: [], walled: page_kind === "challenge" });
  const results = [
    { setup: "A2", sites_named: named, loads: [load("a", "A2", "signin_form"), load("b", "A2", "challenge")], typed_characters: 0 },
    { setup: "A0", sites_named: named, loads: [load("a", "A0", "challenge"), load("b", "A0", "challenge")], typed_characters: 0 },
    { setup: "A1", sites_named: named, loads: [load("a", "A1", "signin_form"), load("b", "A1", "challenge")], typed_characters: 0 },
  ];
  const m = probe.mergeSetups(results);
  assert.equal(m.typed_characters, 0);
  assert.deepEqual(m.setups.map((s) => s.setup), ["A0", "A1", "A2"]);
  assert.equal(m.sites.find((s) => s.site === "a").first_form_setup, "A1");
  assert.equal(m.sites.find((s) => s.site === "b").first_form_setup, null);
});

// ---------- one real Chromium, on pages on 127.0.0.1 ----------

test("real Chromium, A0 on 127.0.0.1: a form is a sign-in form with its time, a 403 wall is Cloudflare's", async (t) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
    const b = await chromium.launch({ headless: true });
    await b.close();
  } catch { return t.skip("Playwright's Chromium is not downloaded here"); }
  const server = createServer((req, res) => {
    if (req.url.startsWith("/wall")) {
      res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
      return res.end("<!doctype html><title>Just a moment...</title><p>Checking your browser before accessing. Verify you are human.</p>");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Sign in</title><h1>Sign in to your account</h1>
      <form><label>Email <input type="email" name="email" autocomplete="username"></label>
      <label>Password <input type="password" name="password" autocomplete="current-password"></label>
      <button type="submit">Sign in</button></form>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const out = await probe.runSetups({
      setup: "A0", platform: "linux", launcher: chromium, setting: SETTING, scratchDir: dir, publicUrl: ok,
      // The real guard refuses 127.0.0.1, which is the point of it; this run's pages are on 127.0.0.1.
      guard: async () => {},
      formWaitMs: 8000, pollMs: 200,
      sites: [{ site: "form", group: "control", url: `${base}/login`, never: "" }, { site: "wall", group: "refused", url: `${base}/wall`, never: "" }],
    });
    const form = out.loads.find((l) => l.site === "form");
    const wall = out.loads.find((l) => l.site === "wall");
    assert.equal(form.page_kind, "signin_form");
    assert.equal(typeof form.ms_to_form, "number");
    assert.equal(form.status, 200);
    assert.equal(form.final_host, "127.0.0.1");
    assert.equal(form.title, "Sign in");
    assert.equal(wall.status, 403);
    assert.equal(wall.walled, true);
    assert.deepEqual(wall.wall_vendor, ["cloudflare"]);
    assert.equal(out.typed_characters, 0);
    assert.equal(out.scratch_profile_deleted, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
