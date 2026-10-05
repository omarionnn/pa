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
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_TASK_MAX_ATTEMPTS = "3";
process.env.REASON_TASK_WAKE_MIN = "15";
// A key must NOT be in the environment for the not-connected tests to mean anything.
delete process.env.TAVILY_API_KEY;

const { Runtime } = await import("../src/runtime.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { fakeProvider, tavilyProvider, webSearch, searchStatus, searchCapability } = await import("../src/search.js");
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
  assert.match(search.what, /TAVILY_API_KEY/);
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
