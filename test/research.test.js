// Research, without the model. The provider is a fake and the sources are a fixture server, so what
// is tested here is the part code owns and the model does not get a say in: that an answer's sources
// are real, that the caps hold and are reported, that a site which forbids being read is skipped and
// said out loud, that no key is an honest fallback rather than a guess, and that a deep run survives
// a restart and reports once.
//
// No API key needed. Nothing live is ever touched.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSourceSite } from "./fixture-sources.js";

const dir = mkdtempSync(join(tmpdir(), "reason-research-"));
// This suite's fixtures live on 127.0.0.1; outside a test, nothing may fetch there (src/netguard.js).
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1";
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_TASK_MAX_ATTEMPTS = "3";
process.env.REASON_TASK_WAKE_MIN = "15";
// A key must NOT be in the environment for the not-connected tests to mean anything.
delete process.env.TAVILY_API_KEY;

const { Runtime } = await import("../src/runtime.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { fakeProvider, tavilyProvider, parallelProvider, webSearch, searchStatus, searchCapability } = await import("../src/search.js");
const { parseRobots, rulesVerdict, robotsAllows, clearRobotsCache } = await import("../src/robots.js");
const { pickSources, siteOf } = await import("../src/research.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = "dm:research";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

let site;
let forbidden;

before(async () => {
  site = await startSourceSite();
  // A second host whose robots.txt disallows everything — Reddit's real policy, read 2026-10-05.
  forbidden = await startSourceSite({ robots: "User-agent: *\nDisallow: /\n" });
});
after(async () => {
  await site.close();
  await forbidden.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clock.reset();
  clearRobotsCache();
  db.db.exec("DELETE FROM research; DELETE FROM research_sources; DELETE FROM research_queries;"
    + " DELETE FROM tasks; DELETE FROM task_log; DELETE FROM action_ledger; DELETE FROM seen_urls;");
});

/** Results that point at the fixture server, so "read the best sources" reads real pages. */
const results = (paths, { host = () => site.url } = {}) => paths.map(([path, title, date]) => ({
  title, url: `${host()}${path}`, snippet: `${title} — snippet text`, date: date ?? null,
}));

const provider = (answers) => fakeProvider({ answers });

/** No robots.txt check against the fixture host unless a test asks for one. */
const openRobots = async () => ({ allowed: true, checked: false, why: "fixture", rule: null });

const call = (name, input, ctx = {}) => runTool(name, input, { conversationId: C, ...ctx });

// ---------------------------------------------------------------------------
// the provider interface
// ---------------------------------------------------------------------------

test("with no key, search is not_connected and says what to do instead", async () => {
  const st = searchStatus({ provider: tavilyProvider({ key: "" }) });
  assert.equal(st.connected, false);
  assert.deepEqual(st.missing, ["TAVILY_API_KEY"]);
  assert.match(st.error, /not connected/i);
  assert.match(st.error, /web_lookup/, "it points at the thing that still works");

  const out = await webSearch("iphone 17 price", { provider: tavilyProvider({ key: "" }) });
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_connected");
  assert.deepEqual(out.missing, ["TAVILY_API_KEY"]);
  assert.ok(!out.results, "no results are invented");
});

test("the capabilities tool says search is not connected, and that research needs it", async () => {
  const caps = capabilitiesNow({ conversationId: C, ownerName: "Omari" });
  const search = caps.find(c => c.name === "web_search");
  const research = caps.find(c => c.name === "research");
  assert.equal(search.status, "not connected");
  assert.match(search.what, /CONTEXT_DEV_API_KEY|TAVILY_API_KEY/);
  assert.equal(research.status, "not connected");
  assert.match(research.what, /one page is not research/i);
});

test("the capability line for a connected provider promises research, and is honest about reddit", () => {
  const cap = searchCapability({ status: searchStatus({ provider: fakeProvider({}) }) });
  assert.equal(cap.status, "live");
  assert.match(cap.what, /reddit/i);
  assert.match(cap.what, /forbids/i);
});

test("the Tavily provider sends what Tavily's docs say, and normalizes what comes back", async () => {
  let seen = null;
  const p = tavilyProvider({
    key: "tvly-test", base: "https://api.tavily.com", depth: "basic",
    fetchImpl: async (url, opts) => {
      seen = { url, headers: opts.headers, body: JSON.parse(opts.body) };
      return {
        ok: true, status: 200,
        json: async () => ({
          query: "x",
          results: [
            { title: "A", url: "https://a.example/one", content: "snippet a", score: 0.9, published_date: "Tue, 11 Mar 2025 17:00:00 GMT" },
            { title: "B", url: "https://b.example/two", content: "snippet b", score: 0.5 },
            { nourl: true },
          ],
        }),
      };
    },
  });

  const out = await p.search("best pixel", { maxResults: 5, sites: ["reddit.com"], recent: "month" });
  assert.equal(seen.url, "https://api.tavily.com/search");
  assert.equal(seen.headers.authorization, "Bearer tvly-test");
  assert.equal(seen.body.query, "best pixel");
  assert.equal(seen.body.search_depth, "basic");
  assert.equal(seen.body.max_results, 5);
  assert.equal(seen.body.include_published_date, true, "a review with no date is worth less than a recent one");
  assert.deepEqual(seen.body.include_domains, ["reddit.com"]);
  assert.equal(seen.body.time_range, "month");

  assert.equal(out.ok, true);
  assert.equal(out.results.length, 2, "a result with no url is dropped, not guessed at");
  assert.deepEqual(out.results[0], { title: "A", url: "https://a.example/one", snippet: "snippet a", date: "Tue, 11 Mar 2025 17:00:00 GMT", score: 0.9 });
  assert.equal(out.results[1].date, null);
});

test("a rejected key and a used-up allowance are different sentences", async () => {
  const make = (status) => tavilyProvider({
    key: "tvly-test",
    fetchImpl: async () => ({ ok: false, status, text: async () => "nope" }),
  });
  assert.match((await make(401).search("x")).error, /key was rejected/i);
  assert.match((await make(429).search("x")).error, /allowance/i);
  assert.match((await make(500).search("x")).error, /answered 500/);
});

test("the Parallel provider sends what Parallel's docs say, and normalizes what comes back", async () => {
  let seen = null;
  const p = parallelProvider({
    key: "par-test", base: "https://api.parallel.ai", mode: "fast", maxChars: 8000,
    today: () => new Date("2026-10-17T12:00:00Z"),
    fetchImpl: async (url, opts) => {
      seen = { url, headers: opts.headers, body: JSON.parse(opts.body) };
      return {
        ok: true, status: 200,
        json: async () => ({
          search_id: "search_1",
          results: [
            { title: "A", url: "https://a.example/one", publish_date: "2026-10-02", excerpts: ["first passage", "second passage"] },
            { title: "B", url: "https://b.example/two", publish_date: null, excerpts: [] },
            { title: "no url", excerpts: ["x"] },
          ],
        }),
      };
    },
  });

  const out = await p.search("best pixel", { maxResults: 5, sites: ["reddit.com"], recent: "month" });
  assert.equal(seen.url, "https://api.parallel.ai/v1/search");
  assert.equal(seen.headers["x-api-key"], "par-test");
  assert.equal(seen.body.objective, "best pixel");
  assert.deepEqual(seen.body.search_queries, ["best pixel"]);
  assert.equal(seen.body.mode, "fast");
  assert.equal(seen.body.max_chars_total, 8000, "excerpts are capped so a tool result stays readable");
  assert.equal(seen.body.advanced_settings.max_results, 5);
  assert.deepEqual(seen.body.advanced_settings.source_policy.include_domains, ["reddit.com"]);
  assert.equal(seen.body.advanced_settings.source_policy.after_date, "2026-09-17", "'month' is a published-on-or-after date, 30 days back");

  assert.equal(out.ok, true);
  assert.equal(out.provider, "parallel");
  assert.equal(out.results.length, 2, "a result with no url is dropped, not guessed at");
  assert.deepEqual(out.results[0], { title: "A", url: "https://a.example/one", snippet: "first passage\nsecond passage", date: "2026-10-02" });
  assert.deepEqual(out.results[1], { title: "B", url: "https://b.example/two", snippet: "", date: null });

  // No sites and no recency: no source policy is sent at all, so nothing narrows the search.
  await p.search("anything");
  assert.equal(seen.body.advanced_settings.source_policy, undefined);
  assert.equal(seen.body.advanced_settings.max_results, config.searchMaxResults);
});

test("Parallel: a rejected key, used-up credit and a rate limit are different sentences", async () => {
  const make = (status) => parallelProvider({
    key: "par-test",
    fetchImpl: async () => ({ ok: false, status, text: async () => "nope" }),
  });
  assert.match((await make(401).search("x")).error, /key was rejected/i);
  assert.match((await make(402).search("x")).error, /credit is used up/i);
  assert.match((await make(429).search("x")).error, /rate limit/i);
  assert.match((await make(500).search("x")).error, /answered 500/);

  const st = searchStatus({ provider: parallelProvider({ key: "" }) });
  assert.equal(st.connected, false);
  assert.deepEqual(st.missing, ["PARALLEL_API_KEY"]);
});

// ---------------------------------------------------------------------------
// robots.txt: the guard that keeps Reason out of a site that said no
// ---------------------------------------------------------------------------

test("a blanket disallow is a refusal, and it is phrased to be said out loud", async () => {
  const may = await robotsAllows(`${forbidden.url}/forum`, { allowLocal: false });
  assert.equal(may.allowed, false);
  assert.equal(may.rule, "Disallow: /");
  assert.match(may.why, /does not allow/i);
  assert.match(may.why, /do not pretend you read it/i);
});

test("a site that allows the path is read, and a missing robots.txt is not a refusal", async () => {
  const yes = await robotsAllows(`${site.url}/review-a`, { allowLocal: false });
  assert.equal(yes.allowed, true);
  assert.equal(yes.checked, true);

  const none = await robotsAllows("https://nowhere.invalid/thing", {
    allowLocal: false,
    fetchImpl: async () => { throw new Error("unreachable"); },
  });
  assert.equal(none.allowed, true);
  assert.equal(none.checked, false, "allowed, but nobody answered — and the caller can tell");
});

test("robots.txt parsing: groups, longest match, Allow beating Disallow, empty Disallow", () => {
  const groups = parseRobots(`
    # comment
    User-agent: *
    Disallow: /private
    Allow: /private/public
    User-agent: reason
    User-agent: otherbot
    Disallow:
  `);
  const star = groups.get("*");
  assert.equal(rulesVerdict(star, "/private/thing").allowed, false);
  assert.equal(rulesVerdict(star, "/private/public/thing").allowed, true, "longest match wins");
  assert.equal(rulesVerdict(star, "/elsewhere").allowed, true);
  // Consecutive User-agent lines share one group, and `Disallow:` with no value forbids nothing.
  assert.equal(rulesVerdict(groups.get("reason"), "/anything").allowed, true);
  assert.equal(rulesVerdict(groups.get("otherbot"), "/anything").allowed, true);
});

// ---------------------------------------------------------------------------
// the flow
// ---------------------------------------------------------------------------

test("a multi-source answer cites only sources that were really fetched", async () => {
  const p = provider({
    "pixel 11 price": results([["/maker", "Pixel 11 official"]]),
    // Two hostnames, so this is three pages across two sites rather than three off one.
    "pixel 11 review": [
      ...results([["/review-a", "Tested Weekly review", "2026-09-01"]]),
      ...results([["/review-b", "Gear Bench comparison"]], { host: () => site.altUrl }),
    ],
  });
  const out = await call("research", {
    question: "pixel 11 or pixel 10?",
    queries: ["pixel 11 price", "pixel 11 review"],
  }, { searchProvider: p, robots: openRobots });

  assert.equal(out.ok, true);
  assert.equal(out.searches_used, 2);
  assert.equal(out.pages_read, 3);

  const sites = [...new Set(out.sources.map(s => s.site))].sort();
  assert.deepEqual(sites, ["127.0.0.1", "localhost"]);
  // The text in the log is text the fixture really served, not the snippet and not a summary.
  const maker = out.sources.find(s => s.url.endsWith("/maker"));
  assert.match(maker.said, /\$899/);
  assert.match(maker.title, /official page/);
  const reviewA = out.sources.find(s => s.url.endsWith("/review-a"));
  assert.match(reviewA.said, /9 hours 40 minutes/);
  assert.equal(reviewA.date, "2026-09-01", "the provider's date is kept against the source");

  // Nothing is in the log that no search returned and no fetch read.
  for (const s of out.sources) {
    assert.ok(s.url.startsWith(site.url) || s.url.startsWith(site.altUrl), `${s.url} came from nowhere`);
  }
  assert.match(out.note, /3 page\(s\) across 2 sites were read/);
  assert.match(out.note, /has to appear in a source above/i);
});

test("one source is not research, and the note says so", async () => {
  const p = provider({ "pixel 11": results([["/maker", "Pixel 11 official"]]) });
  const out = await call("research", { question: "is the pixel 11 good?", queries: ["pixel 11"] },
    { searchProvider: p, robots: openRobots });

  assert.equal(out.pages_read, 1);
  assert.match(out.note, /not research/i);
});

test("a source that will not load is skipped, named, and the rest of the run carries on", async () => {
  const p = provider({
    "pixel 11": results([["/broken", "Consumer Tests"], ["/review-a", "Tested Weekly"], ["/maker", "Official"]]),
  });
  const out = await call("research", { question: "pixel 11?", queries: ["pixel 11"] },
    { searchProvider: p, robots: openRobots });

  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].what_happened, "it would not load");
  assert.match(out.skipped[0].why, /500/);
  assert.ok(out.skipped[0].url.endsWith("/broken"));
  assert.equal(out.pages_read, 2, "the other two were still read");
  assert.match(out.note, /would not load/i);
  assert.ok(!out.sources.some(s => s.url.endsWith("/broken")), "a page that failed is never a source");
});

test("a site that forbids fetching is never fetched, and only its snippet survives", async () => {
  const p = provider({
    "pixel 11 reddit": [
      { title: "Anyone regret upgrading?", url: `${forbidden.url}/forum`, snippet: "battery is genuinely better but charging annoys me", date: "2026-08-02" },
      ...results([["/review-a", "Tested Weekly"]]),
    ],
  });
  const before = forbidden.hits.length;
  const out = await call("research", { question: "pixel 11?", queries: ["pixel 11 reddit"] },
    { searchProvider: p, robots: (u) => robotsAllows(u, { allowLocal: false }) });

  const pageHits = forbidden.hits.slice(before).filter(h => h !== "/robots.txt");
  assert.deepEqual(pageHits, [], "the forbidden page was never requested");

  const skip = out.skipped.find(s => s.url.endsWith("/forum"));
  assert.equal(skip.what_happened, "the site forbids fetching");
  assert.ok(!out.sources.some(s => s.url.endsWith("/forum")), "it is not a read source");

  // The snippet is still there, labelled as a snippet, so an opinion can be quoted honestly.
  const snip = out.snippets_only.find(s => s.url.endsWith("/forum"));
  assert.match(snip.said, /battery is genuinely better/);
  assert.match(snip.via, /not read/i);
  assert.equal(snip.date, "2026-08-02");
  assert.match(out.note, /forbid fetching/i);
  assert.match(out.note, /ONLY the search snippet/);
});

test("the page cap holds, and the result says which cap stopped it", async () => {
  const p = provider({
    "a": results([["/maker", "Official"], ["/review-a", "A"], ["/review-b", "B"], ["/forum", "Forum"]]),
  });
  const out = await call("research", { question: "pixel?", queries: ["a"] },
    { searchProvider: p, robots: openRobots, researchCaps: { maxPages: 2 } });

  assert.equal(out.pages_read, 2);
  assert.equal(out.cut_short, "pages");
  assert.match(out.note, /page cap/i);
});

test("the search cap holds: the queries past it never run", async () => {
  const p = provider({ "*": results([["/maker", "Official"]]) });
  const out = await call("research", {
    question: "pixel?", queries: ["one", "two", "three", "four"],
  }, { searchProvider: p, robots: openRobots, researchCaps: { maxSearches: 2 } });

  assert.equal(out.searches_used, 2);
  assert.deepEqual(p.calls.map(c => c.query), ["one", "two"]);
  assert.equal(out.cut_short, "searches");
  assert.deepEqual(out.queries_left, ["three", "four"]);
  assert.match(out.note, /search cap/i);
  assert.match(out.note, /partial/i);
});

test("the time cap holds and is reported", async () => {
  const p = provider({ "*": results([["/maker", "Official"]]) });
  let t = 0;
  const out = await call("research", { question: "pixel?", queries: ["one", "two", "three"] }, {
    searchProvider: p, robots: openRobots,
    // The clock jumps two minutes per look, so the budget is gone after the first query.
    researchCaps: { maxSeconds: 60, now: () => (t += 120_000) },
  });
  assert.equal(out.cut_short, "time");
  assert.match(out.note, /ran out of time/i);
  assert.ok(out.queries_left.length >= 1);
});

test("research retries automatically when the time cap cuts a step short", async () => {
  const p = provider({ "*": results([["/maker", "Official"]]) });
  let callCount = 0;
  let t = 0;
  const said = [];
  const out = await call("research", { question: "iphone deals?", queries: ["deals", "refurb", "trade in"] }, {
    searchProvider: p, robots: openRobots,
    // First call: clock jumps so it times out after one query. Second/third: clock is normal.
    researchCaps: { maxSeconds: 60, now: () => { callCount++; return callCount <= 2 ? (t += 120_000) : (t += 1000); } },
    events: { say: (_c, text) => said.push(text) },
  });
  assert.ok(said.length > 0, "a progress message was sent during retry");
  assert.match(said[0], /timed out/i);
  assert.ok(out.ok);
});

test("research stops retrying after the configured max retries", async () => {
  const p = provider({ "*": results([["/maker", "Official"]]) });
  let t = 0;
  const said = [];
  const saved = config.researchMaxRetries;
  config.researchMaxRetries = 1;
  try {
    const out = await call("research", { question: "iphone deals?", queries: ["deals", "refurb", "trade in"] }, {
      searchProvider: p, robots: openRobots,
      // Clock always jumps past the budget.
      researchCaps: { maxSeconds: 60, now: () => (t += 120_000) },
      events: { say: (_c, text) => said.push(text) },
    });
    assert.equal(said.length, 1, "only retried once");
    assert.equal(out.cut_short, "time");
    assert.ok(out.ok);
  } finally {
    config.researchMaxRetries = saved;
  }
});

test("with no search provider, research refuses honestly instead of guessing", async () => {
  const out = await call("research", { question: "pixel 11 or 10?", queries: ["pixel 11"] },
    { searchProvider: tavilyProvider({ key: "" }) });

  assert.equal(out.ok, true, "it is a smaller answer, not a crash");
  assert.equal(out.status, "not_connected");
  assert.deepEqual(out.sources, []);
  assert.match(out.note, /no web search/i);
  assert.match(out.note, /Do not present this as research/i);
  assert.match(out.note, /web_lookup/);
});

test("research refuses to plan for the model: no queries, no run", async () => {
  const out = await call("research", { question: "pixel 11?" }, { searchProvider: provider({}) });
  assert.equal(out.ok, false);
  assert.match(out.error, /queries/);
  assert.equal(db.listResearch(C, { includeClosed: true }).length, 0, "nothing was started");
});

test("the same page found twice is one source, and reading it replaces its snippet", async () => {
  const p = provider({
    "one": results([["/maker", "Official"]]),
    "two": results([["/maker", "Official again"]]),
  });
  const out = await call("research", { question: "pixel?", queries: ["one", "two"] },
    { searchProvider: p, robots: openRobots });

  assert.equal(out.sources.filter(s => s.url.endsWith("/maker")).length, 1);
  assert.equal(out.snippets_only.filter(s => s.url.endsWith("/maker")).length, 0,
    "once a page is read it is a read source, not also a snippet");
});

test("sources are spread across sites before any site gets a second page", () => {
  const picked = pickSources([
    { url: "https://a.example/1" }, { url: "https://a.example/2" },
    { url: "https://b.example/1" }, { url: "https://c.example/1" },
  ], { max: 3, already: [] });
  assert.deepEqual(picked.map(r => siteOf(r.url)), ["a.example", "b.example", "c.example"]);
});

// ---------------------------------------------------------------------------
// the ledger
// ---------------------------------------------------------------------------

test("the ledger receipt lists the sources, by name", async () => {
  const p = provider({
    "pixel 11 review": [
      ...results([["/review-a", "Tested Weekly"], ["/broken", "Consumer Tests"]]),
      { title: "reddit thread", url: `${forbidden.url}/forum`, snippet: "owners say the battery is better" },
    ],
  });
  await call("research", { question: "pixel 11?", queries: ["pixel 11 review"] },
    { searchProvider: p, robots: (u) => robotsAllows(u, { allowLocal: false }) });

  const led = db.listActions(C);
  const row = led.find(a => a.action === "research");
  assert.ok(row, "research leaves a receipt");
  assert.match(row.receipt, /Researched "pixel 11\?"/);
  assert.match(row.receipt, /1 search\(es\), 1 page\(s\) read/);
  assert.match(row.receipt, /read: 127\.0\.0\.1/);
  assert.match(row.receipt, /could not read: 127\.0\.0\.1/);
  assert.equal(row.outcome, "ok");
});

test("a search leaves its own receipt, naming the sites it found", async () => {
  const p = provider({ "pixel 11": results([["/maker", "Official"], ["/review-a", "A"]]) });
  const out = await call("web_search", { query: "pixel 11", sites: ["127.0.0.1"] }, { searchProvider: p });
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);

  const row = db.listActions(C).find(a => a.action === "web_search");
  assert.match(row.receipt, /Searched fake for "pixel 11"/);
  assert.match(row.receipt, /2 result\(s\)/);
  // And the urls are remembered, so a picture off one of these pages may reach a page later.
  assert.equal(db.hasSeenUrl(C, `${site.url}/maker`), true);
});

// ---------------------------------------------------------------------------
// a deep run: durable, and it reports once
// ---------------------------------------------------------------------------

test("a deep research run is a task, and survives a brand new Runtime", async () => {
  const p = provider({ "*": results([["/maker", "Official"]]) });
  const started = await call("research", {
    question: "pixel 11 or pixel 10?", queries: ["one", "two", "three"], deep: true,
  }, { searchProvider: p, robots: openRobots, researchCaps: { maxSearches: 1 } });

  assert.equal(started.ok, true);
  assert.ok(started.task_id, "a deep run is a real task");
  assert.match(started.deep_note, /survives a restart/i);
  assert.equal(started.searches_used, 1, "the first slice ran now, not later");
  assert.deepEqual(started.queries_left, ["two", "three"]);

  const researchId = started.research_id;
  const taskId = started.task_id;

  // The process dies here. The row is everything a fresh runtime gets.
  const sent = [];
  const rt = new Runtime({
    runTurn: async ({ text }) => {
      assert.match(text, /research: pixel 11 or pixel 10\?/, "the new runtime hands it its own job back");
      // What the model would do on the wake: carry the run on, write down what happened.
      const more = await runTool("research", { research_id: researchId },
        { conversationId: C, searchProvider: p, robots: openRobots, researchCaps: { maxSearches: 3 } });
      assert.equal(more.ok, true);
      assert.equal(more.research_id, researchId, "the same run, not a new one");
      assert.ok(more.pages_read >= 1, "the source log it already had is still there");
      await runTool("task_update", { task_id: taskId, progress: `read ${more.pages_read} sources`, wake_in_minutes: 30 },
        { conversationId: C });
      return "pixel 10 — same camera, $250 less";
    },
  });
  rt.on("outbound", (m) => sent.push(m));

  clock.skip((config.taskDefaultWakeMin + 1) * 60_000);
  const out = await rt.runTasks();
  assert.equal(out.woke, 1);
  assert.equal(out.reported, 1);
  assert.equal(sent.length, 1, "it reports once");
  assert.equal(sent[0].text, "pixel 10 — same camera, $250 less");
  assert.equal(sent[0].fromTask, taskId);

  // The budget is cumulative across the restart: it did not get a fresh five searches.
  const run = db.getResearch(C, researchId);
  assert.equal(run.searches, 3);
  assert.equal(run.state, "done");
  assert.deepEqual(run.queries, []);

  // And a finished run cannot be carried on by accident.
  const again = await call("research", { research_id: researchId }, { searchProvider: p, robots: openRobots });
  assert.equal(again.ok, false);
  assert.match(again.error, /finished/i);
  assert.ok(again.sources.length, "but its sources are still readable");
});

test("a deep run's wake that moved nothing never interrupts anyone", async () => {
  const p = provider({ "*": results([["/maker", "Official"]]) });
  const started = await call("research", { question: "pixel?", queries: ["one", "two"], deep: true },
    { searchProvider: p, robots: openRobots, researchCaps: { maxSearches: 1 } });

  const sent = [];
  // The model talks but touches nothing: no task_update, no progress.
  const rt = new Runtime({ runTurn: async () => "still digging!" });
  rt.on("outbound", (m) => sent.push(m));

  clock.skip((config.taskDefaultWakeMin + 1) * 60_000);
  const out = await rt.runTasks();
  assert.equal(out.held, 1);
  assert.deepEqual(sent, [], "a wake that changed nothing is not news, whatever the model wrote");
  void started;
});

test("one conversation's research is not another's", async () => {
  const p = provider({ "*": results([["/maker", "Official"]]) });
  const mine = await call("research", { question: "pixel?", queries: ["one"] }, { searchProvider: p, robots: openRobots });
  const theirs = await runTool("research", { research_id: mine.research_id },
    { conversationId: "dm:somebody-else", searchProvider: p, robots: openRobots });
  assert.equal(theirs.ok, false);
  assert.match(theirs.error, /no research/i);
});


// ---------------------------------------------------------------------------
// a choice is answered on a page
// ---------------------------------------------------------------------------
//
// The first real comparison ("help me compare iphone 17 pro and 18 pro") came back as one long
// text: research ran, eight pages were read, and no page was made or offered, because the rule
// was a "when it is long" in the prompt. What kind of question it is stays the model's read; what
// a choice gets is said in the result, where it is read right before the answer is written.

const choiceProvider = () => provider({
  "pixel 11 price": results([["/maker", "Pixel 11 official"]]),
  "pixel 11 review": results([["/review-a", "Tested Weekly review", "2026-09-01"]]),
});

test("research on a choice comes back saying the answer goes on a page, as a must", async () => {
  const out = await call("research", {
    question: "pixel 11 or pixel 10?", kind: "choice",
    queries: ["pixel 11 price", "pixel 11 review"],
  }, { searchProvider: choiceProvider(), robots: openRobots });

  assert.equal(out.ok, true);
  assert.equal(out.answer_on_a_page, true);
  assert.match(out.next_step, /page_create/);
  assert.match(out.next_step, /must/);
  assert.match(out.next_step, /SHORT text/);
  assert.match(out.next_step, /If page_create fails/, "the honest way out is spelled out");
});

test("a plain fact is not pushed onto a page", async () => {
  const fact = await call("research", {
    question: "how much is the pixel 11?", kind: "fact", queries: ["pixel 11 price"],
  }, { searchProvider: choiceProvider(), robots: openRobots });
  assert.equal(fact.ok, true);
  assert.equal(fact.answer_on_a_page, undefined);
  assert.equal(fact.next_step, undefined);

  const unsaid = await call("research", {
    question: "how much is the pixel 11?", queries: ["pixel 11 price"],
  }, { searchProvider: choiceProvider(), robots: openRobots });
  assert.equal(unsaid.next_step, undefined, "no kind, no forced page");
});

test("the whole way: a choice is researched, put on a page, and the link in hand opens it", async () => {
  const { pageRequest } = await import("../src/http.js");
  const found = await call("research", {
    question: "pixel 11 or pixel 10?", kind: "choice",
    queries: ["pixel 11 price", "pixel 11 review"],
  }, { searchProvider: choiceProvider(), robots: openRobots });
  assert.match(found.next_step, /page_create/);

  // What the next step asks for: the comparison and the sources, on a page.
  const made = await call("page_create", {
    title: "Pixel 11 or Pixel 10",
    blocks: [
      { type: "text", text: "Get the 11 if you are buying new." },
      { type: "table", columns: ["What", "Pixel 11", "Pixel 10"], rows: [["Price", "$799", "$699"]] },
      { type: "links", items: found.sources.map(s => ({ label: s.site ?? s.title ?? s.url, url: s.url })) },
    ],
  });
  assert.equal(made.ok, true, made.error);
  assert.match(made.note, /Send .* that exact link/);

  // The link Reason is told to send, tapped cold on a browser never proved: the gate, with the code
  // on offer and the page's own card behind the link. Then the code, and the page.
  const { issueCode } = await import("../src/pages/access.js");
  const u = new URL(made.link);
  const id = u.pathname.split("/")[2];
  const cold = await pageRequest({ id, key: u.searchParams.get("k"), method: "GET", headers: {}, readBody: async () => "" });
  assert.equal(cold.status, 401);
  assert.match(cold.body, /name="send"/);
  assert.match(cold.body, /<meta property="og:title" content="Pixel 11 or Pixel 10">/);
  assert.doesNotMatch(cold.body, /\$799/);

  const res = await pageRequest({
    id, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    readBody: async () => `code=${issueCode(id).code}`,
  });
  assert.equal(res.status, 200);
  assert.match(res.body, /Pixel 11 or Pixel 10/);
  assert.match(res.body, /\$799/);
  assert.doesNotMatch(res.body, /name="code"/);
});

test("with no public address the next step says the link only opens on this machine", async () => {
  const { config } = await import("../src/config.js");
  const was = config.publicUrl;
  try {
    config.publicUrl = "";
    const here = await call("research", { question: "a or b?", kind: "choice", queries: ["pixel 11 price"] },
      { searchProvider: choiceProvider(), robots: openRobots });
    assert.match(here.next_step, /only opens on this machine/);
    config.publicUrl = "https://reason.example";
    const out = await call("research", { question: "a or b?", kind: "choice", queries: ["pixel 11 price"] },
      { searchProvider: choiceProvider(), robots: openRobots });
    assert.doesNotMatch(out.next_step, /only opens on this machine/);
  } finally { config.publicUrl = was; }
});


// ---------------------------------------------------------------------------
// knowing when to stop
// ---------------------------------------------------------------------------
//
// The caps are code saying stop: forty searches is forty searches whatever anybody thinks. They are
// not the same thing as having an answer, and they cannot be — code can count pages, it cannot tell
// when a question has been answered. That judgement is the model's and nothing else can make it.
//
// What code owns is making the judgement STICK. Without a row, "I have enough" lasts exactly as long
// as the context it was thought in, and the failure is the specific one a deep run produces: it
// wakes four hours later, has been trimmed to sixty messages, does not remember being satisfied, and
// searches the same question again. So `enough` is a stamp, and from there nothing will run another
// query on that question — it hands back what it had instead.

test("the model can say it has enough, and that is a row rather than a mood", async () => {
  const p = provider({ "*": results([["/maker", "Official"], ["/review", "Tested"]]) });
  const run = await call("research", { question: "iphone 17 or 18?", queries: ["one", "two"] }, { searchProvider: p, robots: openRobots });
  assert.equal(run.ok, true);

  const stopped = await call("research", { research_id: run.research_id, enough: true }, { searchProvider: p, robots: openRobots });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.enough, true);
  assert.ok(stopped.sources.length, "and it says back what it had");
  assert.match(stopped.note, /no more queries will run/);

  const row = db.getResearch(C, run.research_id);
  assert.ok(row.enough_at, "stamped, so it survives a restart and a trimmed context");
  assert.deepEqual(row.queries, [], "and the queries that would have been picked up later are gone");
});

test("once it has had enough, carrying on is refused and what it had comes back instead", async () => {
  const p = provider({ "*": results([["/maker", "Official"], ["/review", "Tested"]]) });
  let searches = 0;
  const counting = { ...p, search: (...a) => { searches++; return p.search(...a); } };

  const run = await call("research", { question: "which coffee grinder?", queries: ["one", "two", "three"] }, { searchProvider: p, robots: openRobots });
  await call("research", { research_id: run.research_id, enough: true }, { searchProvider: p, robots: openRobots });
  const was = db.getResearch(C, run.research_id).searches;

  const again = await call("research", { research_id: run.research_id, queries: ["four"] }, { searchProvider: counting, robots: openRobots });
  assert.equal(again.ok, false);
  assert.equal(again.blocked, "already_enough");
  assert.ok(again.sources.length, "it hands back the log rather than an error on its own");
  assert.match(again.error, /what you could not find out is an answer too/);
  assert.equal(searches, 0, "and nothing was searched");
  assert.equal(db.getResearch(C, run.research_id).searches, was, "the row is untouched");
});

// "The same question" is the id, never the wording — and this is the test that holds that line.
//
// The tempting version of this feature compares the new question's text against questions already
// settled, and it is wrong twice. It reads meaning out of a string, which is not code's job here.
// And it fails in the direction that costs most: it refuses a real question because it reads like
// one answered in August, when prices have moved and a new model has shipped since. So the stop is
// keyed on the research id Reason was handed, and a fresh run is never held up — not even one asked
// in the very same words.
test("the stop is keyed on the run's id, not on how the question was worded", async () => {
  const p = provider({ "*": results([["/maker", "Official"], ["/review", "Tested"]]) });
  const run = await call("research", { question: "is the mini worth it?", queries: ["one"] }, { searchProvider: p, robots: openRobots });
  await call("research", { research_id: run.research_id, enough: true, enough_why: "two tested reviews agree" },
    { searchProvider: p, robots: openRobots });

  // That id is shut: carrying it on is refused, and the why it wrote down comes back with the log.
  const carried = await call("research", { research_id: run.research_id, queries: ["more"] }, { searchProvider: p, robots: openRobots });
  assert.equal(carried.ok, false);
  assert.equal(carried.blocked, "already_enough");
  assert.match(carried.error, /two tested reviews agree/, "the line it wrote for a later self comes back");

  // The same words, asked fresh, are a NEW question with a new id — and they search normally. A
  // month later this is the honest answer: the mini on sale today is not the mini it priced before.
  let searched = 0;
  const counting = { ...p, search: (...a) => { searched++; return p.search(...a); } };
  const same = await call("research", { question: "is the mini worth it?", queries: ["a", "b"] }, { searchProvider: counting, robots: openRobots });
  assert.equal(same.ok, true, "a genuinely new run is never blocked by wording");
  assert.notEqual(same.research_id, run.research_id);
  assert.ok(searched > 0, "and it really searched");
  assert.equal(db.getResearch(C, same.research_id).enough_at, null, "the new run starts open, with nobody's verdict on it");
});

test("enough is the model's call and a cap is code's, and they are different things", async () => {
  const p = provider({ "*": results([["/maker", "Official"]]) });
  const run = await call("research", { question: "capped one?", queries: ["one", "two", "three"] },
    { searchProvider: p, robots: openRobots, researchCaps: { maxSearches: 1 } });

  assert.equal(run.cut_short, "searches", "a cap stopped this one");
  assert.equal(db.getResearch(C, run.research_id).enough_at, null, "which is not the same as having enough");
  // So carrying on is still allowed: the model was never asked, and a cap is not an answer.
  const more = await call("research", { research_id: run.research_id },
    { searchProvider: p, robots: openRobots, researchCaps: { maxSearches: 3 } });
  assert.equal(more.ok, true);
});

// ---------------------------------------------------------------------------
// One question, one run. 2026-10-17, on phone call #30: the owner asked once how a Ghana-first
// investing app could launch, and Reason started eleven research runs in eight minutes — eight in 81
// seconds, each the same question reworded, each paying for its own searches, most left open for
// good, one SEC filing fetched fourteen times. Every call turn starts from what was said on the line,
// which never holds a tool result, so no turn knew a run was already going.
// ---------------------------------------------------------------------------

/** A page reader that counts what it fetched, and can be held until the test lets it go. */
function countingLookup({ hold = null } = {}) {
  const fetched = [];
  const lookup = async (url) => {
    fetched.push(url);
    if (hold) await hold;
    return { ok: true, url, title: `page at ${url}`, text: `what ${url} really says`, images: [] };
  };
  return { lookup, fetched };
}

test("the 10-17 call: the same question asked over and over in a minute is one run, not eleven", async () => {
  const p = provider({ "*": [
    { title: "SEC filing", url: "https://www.sec.gov/files/africa-exchange.pdf", snippet: "an S-1" },
    { title: "GSE rules", url: "https://gse.com.gh/listing-rules", snippet: "listing rules" },
  ] });
  let release;
  const hold = new Promise(r => (release = r));
  const { lookup, fetched } = countingLookup({ hold });
  const ctx = { searchProvider: p, robots: openRobots, lookup };

  // The first ask starts a run, and the line stops waiting for it: the run is still working.
  const first = call("research", {
    question: "how could a Ghana-first retail investing app launch?",
    queries: ["ghana retail investing app launch", "ghana sec licence broker dealer"],
  }, ctx);

  // Then the same thing, reworded, turn after turn — what call #30 sent.
  const rewordings = [
    "how would a Ghanaian stock investing app for regular people get started",
    "launching an African exchange retail app from Ghana",
    "what it takes to launch a Ghana-first investing app",
    "Ghana retail investing app — licensing and launch path",
    "how do you launch a retail brokerage app in Ghana",
    "first steps for a Ghana investing app",
    "a Ghana-first app for buying African stocks: how to launch",
  ];
  for (const question of rewordings) {
    const again = await call("research", { question, queries: [question, `${question} reddit`] }, ctx);
    assert.equal(again.ok, false);
    assert.equal(again.blocked, "research_open", "a re-ask is shown the open run, not handed a new one");
    assert.equal(again.open.length, 1);
    assert.equal(again.open[0].still_working, true);
    assert.match(again.open[0].question, /Ghana-first retail investing app/);
    assert.match(again.note, /research_id/);
  }

  // The model reads the open run as the same subject and carries it on: it waits on that work.
  const runId = db.listResearch(C)[0].id;
  const joined = call("research", { research_id: runId }, ctx);
  release();
  const [a, b] = await Promise.all([first, joined]);

  assert.equal(a.ok, true);
  assert.equal(b.joined, true, "carrying on a run that is working waits for it");
  assert.equal(b.research_id, a.research_id);
  assert.equal(db.listResearch(C, { includeClosed: true }).length, 1, "one run, not eleven");
  assert.equal(p.calls.length, 2, "only the first run's two searches were ever paid for");
  assert.equal(fetched.filter(u => u.includes("sec.gov")).length, 1, "the filing was fetched once");
  assert.equal(db.getResearch(C, runId).state, "done", "and it finished");
});

test("a genuinely different subject still gets its own run, by the model saying so", async () => {
  const p = provider({ "*": results([["/maker", "Official"]]) });
  const { lookup } = countingLookup();
  // A deep run leaves the first one open, with a task that will wake for it.
  await call("research", { question: "ghana investing app launch?", queries: ["one", "two"], deep: true },
    { searchProvider: p, robots: openRobots, lookup, researchCaps: { maxSearches: 1 } });

  const blocked = await call("research", { question: "where should we eat tonight?", queries: ["dinner near me"] },
    { searchProvider: p, robots: openRobots, lookup });
  assert.equal(blocked.blocked, "research_open");

  const dinner = await call("research", { question: "where should we eat tonight?", queries: ["dinner near me"], new_subject: true },
    { searchProvider: p, robots: openRobots, lookup });
  assert.equal(dinner.ok, true);
  assert.notEqual(dinner.research_id, blocked.open[0].research_id);
  assert.equal(db.listResearch(C, { includeClosed: true }).length, 2);
});

test("a page another run here already read is used from the log, not fetched again", async () => {
  const p = provider({ "*": results([["/maker", "Official"], ["/review-a", "Review"]]) });
  const { lookup, fetched } = countingLookup();
  const ctx = { searchProvider: p, robots: openRobots, lookup };

  const one = await call("research", { question: "pixel 11 worth it?", queries: ["pixel 11"] }, ctx);
  assert.equal(one.pages_read, 2);
  const two = await call("research", { question: "pixel 11 battery life?", queries: ["pixel 11 battery"], new_subject: true }, ctx);

  assert.equal(two.pages_read, 2, "the second run still has both pages as read sources");
  assert.equal(fetched.length, 2, "each page was fetched once across both runs");
  const maker = two.sources.find(s => s.url.endsWith("/maker"));
  assert.match(maker.said, /what .*\/maker really says/, "with the text that really came back");
  const row = db.listResearchSources(two.research_id).find(s => s.url.endsWith("/maker"));
  assert.match(row.why, new RegExp(`read for research #${one.research_id}`), "and the row says where it came from");

  // Past the window it is fetched fresh: a page's price can move.
  clock.skip((config.researchReuseSourcesMin + 1) * 60_000);
  await call("research", { question: "pixel 11 deals?", queries: ["pixel 11 deal"], new_subject: true }, ctx);
  assert.equal(fetched.length, 4);
});

test("a run left open with nobody coming back is closed by the sweep, and its log still comes back", async () => {
  const { settleAbandonedResearch } = await import("../src/tools.js");
  const p = provider({ "*": results([["/maker", "Official"]]) });
  const { lookup } = countingLookup();
  // Cut by a cap with queries left, on no task: nothing will ever wake for this one. (The day's
  // background follow-ups are set to none, or the cut would be given one — test/research-room.test.js.)
  // The owner has no daily count (owner 2026-11-15), so this run is made on a non-owner's day with none left.
  const perDay = config.researchContinuePerDay;
  config.researchContinuePerDay = 0;
  db.db.prepare("UPDATE accounts SET is_operator = 0 WHERE conversation_id = ?").run(C);
  let cut;
  try {
    cut = await call("research", { question: "pixel?", queries: ["one", "two", "three"] }, {
      searchProvider: p, robots: openRobots, lookup, researchCaps: { maxSearches: 1 },
    });
  } finally { config.researchContinuePerDay = perDay; db.db.prepare("UPDATE accounts SET is_operator = 1 WHERE conversation_id = ?").run(C); }
  assert.equal(cut.follow_up?.scheduled, false);
  assert.equal(db.getResearch(C, cut.research_id).state, "open");
  // A deep run has a task that will wake for it, and is left alone.
  const deep = await call("research", { question: "a big one", queries: ["a", "b"], deep: true, new_subject: true },
    { searchProvider: p, robots: openRobots, lookup, researchCaps: { maxSearches: 1 } });

  assert.equal(settleAbandonedResearch().closed, 0, "not inside the window");
  clock.skip((config.researchJoinWindowMin + 1) * 60_000);
  assert.equal(settleAbandonedResearch().closed, 1);

  const closed = db.getResearch(C, cut.research_id);
  assert.equal(closed.state, "done");
  assert.equal(closed.cut_short, "abandoned");
  assert.equal(db.getResearch(C, deep.research_id).state, "open", "the deep run's task still owns it");

  const back = await call("research", { research_id: cut.research_id }, { searchProvider: p, robots: openRobots, lookup });
  assert.match(back.error, /finished/);
  assert.equal(back.research_id, cut.research_id);
  assert.ok(back.sources.length, "what it read is still there to answer from");
});
