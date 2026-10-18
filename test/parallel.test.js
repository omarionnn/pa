// Parallel beyond search (src/parallel.js), without Parallel. The wire shapes are proved against a
// fake fetch that answers what docs.parallel.ai says the endpoints answer, and each seam in Reason
// is driven with a fake client that answers from a table: Extract behind web_lookup, a deep run's
// report landing in the source log, a quick cited answer closing a fact run, a watch on the world
// through a monitor, pictures with the page they came from, a verified list, and the webhook that
// makes all of the later ones "now".
//
// No API key is needed and nothing live is touched.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSourceSite } from "./fixture-sources.js";

const dir = mkdtempSync(join(tmpdir(), "reason-parallel-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_TASK_MAX_ATTEMPTS = "3";
process.env.REASON_TASK_WAKE_MIN = "15";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_LOOKUP_PROVIDER = "parallel";
process.env.REASON_RESEARCH_DEEP_PROVIDER = "parallel";
process.env.REASON_RESEARCH_ANSWER_PROVIDER = "parallel";
// A real key must NOT be in the environment: the real client is only ever built with a fake fetch.
delete process.env.PARALLEL_API_KEY;
delete process.env.CONTEXT_DEV_API_KEY;
delete process.env.TAVILY_API_KEY;
process.env.PARALLEL_WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { parallelClient, basisSources, markdownImages, verifyWebhook, signWebhook, monitorFrequency, webhookUrl } = await import("../src/parallel.js");
const { webLookup } = await import("../src/weblookup.js");
const { fakeProvider } = await import("../src/search.js");
const { createServer, parallelWebhookRequest } = await import("../src/http.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = "dm:parallel";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
const MIN = 60_000;

let site;
before(async () => { site = await startSourceSite(); });
after(async () => { await site.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM research; DELETE FROM research_sources; DELETE FROM research_queries; DELETE FROM parallel_runs;"
    + " DELETE FROM watches; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM action_ledger; DELETE FROM seen_urls;");
});

const call = (name, input, ctx = {}) => runTool(name, input, { conversationId: C, ...ctx });
const openRobots = async () => ({ allowed: true, checked: false, why: "fixture", rule: null });
const results = (paths) => paths.map(([path, title]) => ({ title, url: `${site.url}${path}`, snippet: `${title} — snippet text`, date: null }));

/** A fetch that answers from a table keyed by method+path, and remembers what it was sent. */
function fakeFetch(table) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    calls.push({ key, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null, url: u });
    const hit = table[key];
    if (!hit) return { ok: false, status: 404, text: async () => `no ${key}` };
    const res = typeof hit === "function" ? hit(calls.at(-1)) : hit;
    if (res.status && res.status >= 400) return { ok: false, status: res.status, text: async () => res.text ?? "" };
    return { ok: true, status: 200, json: async () => res };
  };
  fn.calls = calls;
  return fn;
}

/**
 * A client shaped like src/parallel.js's, answering from what the test says. `calls` is the record.
 * Only the methods a test names do anything; the rest say "not connected" so a seam that reaches
 * for one the test did not expect is visible.
 */
function fakeParallel(answers = {}, { connected = true } = {}) {
  const calls = [];
  const method = (name, fallback) => async (...args) => {
    calls.push({ name, args });
    const a = answers[name];
    if (typeof a === "function") return a(...args);
    return a ?? fallback;
  };
  return {
    name: "parallel", calls,
    status: () => connected ? { connected: true, missing: [], what: "Parallel" } : { connected: false, missing: ["PARALLEL_API_KEY"], what: "Parallel" },
    extract: method("extract", { ok: false, error: "no extract answer in the test" }),
    imageSearch: method("imageSearch", { ok: true, results: [] }),
    answer: method("answer", { ok: false, error: "no answer in the test" }),
    taskStart: method("taskStart", { ok: true, run_id: "trun_1", status: "queued" }),
    taskStatus: method("taskStatus", { ok: true, status: "running", active: true, error: "" }),
    taskResult: method("taskResult", { ok: false, error: "not done" }),
    monitorCreate: method("monitorCreate", { ok: true, monitor_id: "monitor_1", status: "active" }),
    monitorCancel: method("monitorCancel", { ok: true }),
    monitorEvents: method("monitorEvents", { ok: true, events: [] }),
    entitySearch: method("entitySearch", { ok: true, entities: [] }),
    findAllIngest: method("findAllIngest", { ok: true, objective: "x", entity_type: "companies", match_conditions: [{ name: "a", description: "must be a roofer" }] }),
    findAllStart: method("findAllStart", { ok: true, run_id: "findall_1", status: "queued" }),
    findAllStatus: method("findAllStatus", { ok: true, status: "running", active: true, matched: 0, generated: 0 }),
    findAllResult: method("findAllResult", { ok: false, error: "not done" }),
  };
}

// ---------------------------------------------------------------------------
// the client: what goes on the wire, what comes back
// ---------------------------------------------------------------------------

test("with no key every call is a sentence, and status says what is missing", async () => {
  const p = parallelClient({ key: "", fetchImpl: fakeFetch({}) });
  assert.deepEqual(p.status(), { connected: false, missing: ["PARALLEL_API_KEY"], what: "Parallel" });
  const out = await p.extract(["https://x.test/"]);
  assert.equal(out.ok, false);
  assert.match(out.error, /PARALLEL_API_KEY/);
});

test("extract sends the v1 shape and reads excerpts, full content and images back", async () => {
  const fetchImpl = fakeFetch({
    "POST /v1/extract": {
      extract_id: "extract_1",
      results: [{ url: "https://x.test/p", title: "P", publish_date: "2026-01-02", excerpts: ["Para one ![a](https://img.test/a.jpg)", "Para two"] }],
      errors: [{ url: "https://x.test/q", message: "timed out" }],
    },
  });
  const p = parallelClient({ key: "k", fetchImpl });
  const out = await p.extract(["https://x.test/p", "https://x.test/q"], { objective: "the price", maxChars: 500 });
  assert.equal(out.ok, true);
  const sent = fetchImpl.calls[0];
  assert.equal(sent.headers["x-api-key"], "k");
  assert.deepEqual(sent.body, { urls: ["https://x.test/p", "https://x.test/q"], objective: "the price", advanced_settings: { excerpt_settings: { max_chars_per_result: 500 } } },
    "with an objective, excerpts; fetch_policy and friends live under advanced_settings on /v1");
  assert.equal(out.results[0].text, "Para one ![a](https://img.test/a.jpg)\n\nPara two");
  assert.deepEqual(out.results[0].images, ["https://img.test/a.jpg"]);
  assert.deepEqual(out.errors, [{ url: "https://x.test/q", error: "timed out" }]);

  await p.extract("https://x.test/p", { maxChars: 900 });
  assert.deepEqual(fetchImpl.calls[1].body.advanced_settings, { full_content: { max_chars_per_result: 900 } }, "no objective: the whole page");
});

test("a rejected key, used-up credit and a rate limit are different sentences", async () => {
  for (const [status, re] of [[401, /rejected/], [402, /used up/], [429, /rate limit/], [500, /answered 500/]]) {
    const p = parallelClient({ key: "k", fetchImpl: fakeFetch({ "POST /v1/extract": { status, text: "nope" } }) });
    const out = await p.extract(["https://x.test/"]);
    assert.equal(out.ok, false);
    assert.match(out.error, re);
  }
});

test("image search returns https images with the page each sits on", async () => {
  const fetchImpl = fakeFetch({
    "POST /v1/images/search": { results: [
      { image_url: "https://img.test/1.jpg", source_page_url: "https://x.test/1", title: "One", width: 800, height: 600 },
      { image_url: "http://insecure.test/2.jpg", source_page_url: "https://x.test/2", title: "Two" },
    ] },
  });
  const p = parallelClient({ key: "k", fetchImpl });
  const out = await p.imageSearch({ queries: ["via carota interior"], objective: "the dining room", maxResults: 3 });
  assert.equal(out.ok, true);
  assert.deepEqual(fetchImpl.calls[0].body, { objective: "the dining room", search_queries: ["via carota interior"], mode: config.parallelImageMode, max_results: 3 });
  assert.deepEqual(out.results, [{ image_url: "https://img.test/1.jpg", page_url: "https://x.test/1", title: "One", width: 800, height: 600 }], "http-only images are dropped");
});

test("answer uses the OpenAI-compatible shape and reads url_citation annotations into sources", async () => {
  const fetchImpl = fakeFetch({
    "POST /v1/responses": {
      id: "resp_1",
      output: [
        { type: "web_search_call" }, { type: "web_search_call" },
        { type: "message", content: [{ type: "output_text", text: "Jensen Huang has been CEO since 1993.", annotations: [
          { type: "url_citation", url: "https://nvidia.test/bio", title: "Bio", start_index: 0, end_index: 38 },
          { type: "url_citation", url: "https://nvidia.test/bio", title: "Bio again", start_index: 0, end_index: 38 },
        ] }] },
      ],
    },
  });
  const p = parallelClient({ key: "k", fetchImpl });
  const out = await p.answer("who is nvidia's ceo", { effort: "low" });
  assert.equal(out.ok, true);
  const sent = fetchImpl.calls[0];
  assert.equal(sent.headers.authorization, "Bearer k", "the Responses endpoint takes a Bearer token");
  assert.deepEqual(sent.body, { model: "parallel", input: "who is nvidia's ceo", reasoning: { effort: "low" } });
  assert.equal(out.text, "Jensen Huang has been CEO since 1993.");
  assert.equal(out.searches, 2);
  assert.deepEqual(out.sources, [{ url: "https://nvidia.test/bio", title: "Bio", said: "Jensen Huang has been CEO since 1993." }], "one row per url, with the span it supports");
});

test("a task run is started with a webhook and its result is flattened into report + sources", async () => {
  const fetchImpl = fakeFetch({
    "POST /v1/tasks/runs": { run_id: "trun_9", status: "queued" },
    "GET /v1/tasks/runs/trun_9": { run_id: "trun_9", status: "completed", is_active: false },
    "GET /v1/tasks/runs/trun_9/result": {
      run: { status: "completed" },
      output: { type: "text", content: "Buy the Pixel 10.", basis: [
        { field: "output", confidence: "medium", reasoning: "two reviews agree", citations: [
          { url: "https://gear.test/a", title: "Gear", excerpts: ["$649 now"] },
          { url: "https://gear.test/a", title: "Gear", excerpts: ["90% of the camera"] },
          { url: "https://maker.test/", title: "Maker", excerpts: [] },
        ] },
      ] },
    },
  });
  const p = parallelClient({ key: "k", fetchImpl });
  const started = await p.taskStart("pixel 11 or 10?", { processor: "pro", webhookUrl: "https://r.test/parallel/webhook", metadata: { reason_research_id: "3" } });
  assert.deepEqual(started, { ok: true, run_id: "trun_9", status: "queued" });
  assert.deepEqual(fetchImpl.calls[0].body, {
    input: "pixel 11 or 10?", processor: "pro", task_spec: { output_schema: { type: "text" } },
    metadata: { reason_research_id: "3" }, webhook: { url: "https://r.test/parallel/webhook", event_types: ["task_run.status"] },
  });
  assert.equal((await p.taskStatus("trun_9")).status, "completed");
  const res = await p.taskResult("trun_9");
  assert.equal(res.text, "Buy the Pixel 10.");
  assert.equal(res.confidence, "medium");
  assert.deepEqual(res.sources, [
    { url: "https://gear.test/a", title: "Gear", said: "$649 now\n90% of the camera", reasoning: "two reviews agree" },
    { url: "https://maker.test/", title: "Maker", said: "", reasoning: "two reviews agree" },
  ]);
});

test("basisSources merges one url cited under several fields, and the lowest confidence wins", () => {
  assert.deepEqual(basisSources([
    { field: "price", confidence: "high", reasoning: "r1", citations: [{ url: "https://a.test", title: "A", excerpts: ["x"] }] },
    { field: "date", confidence: "low", reasoning: "r2", citations: [{ url: "https://a.test", excerpts: ["y"] }, { url: "https://b.test", excerpts: [] }] },
  ]), [
    { url: "https://a.test", title: "A", said: "x\ny", reasoning: "r1" },
    { url: "https://b.test", title: "", said: "", reasoning: "r2" },
  ]);
  assert.deepEqual(markdownImages("![a](https://i.test/a.png) and ![b](http://i.test/b.png) and ![a](https://i.test/a.png)"), ["https://i.test/a.png"]);
});

test("a monitor is created with the frequency Monitor offers, and its events come back with sources", async () => {
  const fetchImpl = fakeFetch({
    "POST /v1/monitors": { monitor_id: "monitor_7", status: "active" },
    "GET /v1/monitors/monitor_7/events": { events: [
      { event_id: "mevt_2", event_group_id: "g2", event_date: "2026-10-18", event_type: "event_stream", output: { type: "text", content: "Dates announced.", basis: [{ field: "output", citations: [{ url: "https://news.test/1", title: "News" }], reasoning: "", confidence: "high" }] } },
      { event_id: "c1", event_type: "completion" },
    ] },
    "POST /v1/monitors/monitor_7/cancel": { ok: true },
  });
  const p = parallelClient({ key: "k", fetchImpl });
  const made = await p.monitorCreate({ query: "Drake Boston tour date", frequency: "1d", webhookUrl: "https://r.test/parallel/webhook", metadata: { reason_conversation: C } });
  assert.deepEqual(made, { ok: true, monitor_id: "monitor_7", status: "active" });
  assert.deepEqual(fetchImpl.calls[0].body, {
    type: "event_stream", frequency: "1d", processor: config.parallelMonitorProcessor, settings: { query: "Drake Boston tour date" },
    webhook: { url: "https://r.test/parallel/webhook", event_types: ["monitor.event.detected"] }, metadata: { reason_conversation: C },
  });
  const ev = await p.monitorEvents("monitor_7");
  assert.deepEqual(ev.events, [{ id: "mevt_2", group: "g2", date: "2026-10-18", text: "Dates announced.", sources: [{ url: "https://news.test/1", title: "News", said: "", reasoning: "" }] }], "completions are not events");
  assert.equal((await p.monitorCancel("monitor_7")).ok, true);
  assert.equal(monitorFrequency(30), "1h");
  assert.equal(monitorFrequency(60 * 24), "1d");
  assert.equal(monitorFrequency(60 * 24 * 7), "1w");
});

test("entity search and FindAll use the v1beta paths and only matched candidates come back", async () => {
  const fetchImpl = fakeFetch({
    "POST /v1beta/findall/entity-search": { entity_set_id: "es", entities: [{ name: "Figure AI", url: "https://figure.test", description: "robots" }] },
    "POST /v1beta/findall/ingest": { objective: "roofers in Charlotte", entity_type: "companies", match_conditions: [{ name: "c", description: "must be in Charlotte" }] },
    "POST /v1beta/findall/runs": { findall_id: "findall_3", status: { status: "queued" } },
    "GET /v1beta/findall/runs/findall_3": { status: { status: "running", is_active: true, metrics: { generated_candidates_count: 4, matched_candidates_count: 1 } } },
    "GET /v1beta/findall/runs/findall_3/result": { run: { status: { status: "completed" } }, candidates: [
      { name: "A Roofing", url: "https://a.test", description: "roofs", match_status: "matched", output: { c: { value: "Charlotte, NC", type: "match_condition", is_matched: true } }, basis: [{ field: "c", citations: [{ url: "https://a.test/about", title: "About", excerpts: ["Charlotte"] }], reasoning: "", confidence: "high" }] },
      { name: "B Roofing", url: "https://b.test", match_status: "unmatched", output: {}, basis: [] },
    ] },
  });
  const p = parallelClient({ key: "k", fetchImpl });
  const es = await p.entitySearch({ objective: "humanoid robot companies", limit: 5 });
  assert.deepEqual(es.entities, [{ name: "Figure AI", url: "https://figure.test", description: "robots" }]);
  assert.deepEqual(fetchImpl.calls[0].body, { entity_type: "companies", objective: "humanoid robot companies", match_limit: 5 });

  const ing = await p.findAllIngest("roofers in Charlotte");
  assert.equal(ing.match_conditions.length, 1);
  const st = await p.findAllStart({ objective: ing.objective, entityType: ing.entity_type, matchConditions: ing.match_conditions, matchLimit: 20, webhookUrl: "https://r.test/parallel/webhook" });
  assert.equal(st.run_id, "findall_3");
  assert.deepEqual(fetchImpl.calls[2].body.webhook, { url: "https://r.test/parallel/webhook", event_types: ["findall.run.completed", "findall.run.cancelled", "findall.run.failed"] });
  assert.deepEqual(await p.findAllStatus("findall_3"), { ok: true, status: "running", active: true, matched: 1, generated: 4 });
  const res = await p.findAllResult("findall_3");
  assert.equal(res.candidates, 2);
  assert.deepEqual(res.matches, [{ name: "A Roofing", url: "https://a.test", description: "roofs", why: "Charlotte, NC", sources: [{ url: "https://a.test/about", title: "About", said: "Charlotte", reasoning: "" }] }]);
});

test("webhook verification is Standard Webhooks: id.timestamp.body, base64 key, v1 prefix, 5-minute window", () => {
  const secret = process.env.PARALLEL_WEBHOOK_SECRET;
  const rawBody = JSON.stringify({ type: "task_run.status", data: { run_id: "trun_1", status: "completed" } });
  const headers = signWebhook({ rawBody, secret, id: "whevent_1" });
  assert.equal(verifyWebhook({ rawBody, headers }).ok, true);
  assert.equal(verifyWebhook({ rawBody, headers: { ...headers, "webhook-signature": `v1,AAAA ${headers["webhook-signature"]}` } }).ok, true, "a rotated secret means two signatures; any one matching is enough");
  assert.match(verifyWebhook({ rawBody: rawBody + " ", headers }).why, /did not match/);
  assert.match(verifyWebhook({ rawBody, headers: { ...headers, "webhook-timestamp": String(Math.floor(clock.now() / 1000) - 600) } }).why, /out of date/);
  assert.match(verifyWebhook({ rawBody, headers: {} }).why, /missing/);
  assert.match(verifyWebhook({ rawBody, headers, secret: "" }).why, /PARALLEL_WEBHOOK_SECRET/);
  assert.equal(webhookUrl(), "https://reason.example.test/parallel/webhook");
});

// ---------------------------------------------------------------------------
// Extract behind web_lookup
// ---------------------------------------------------------------------------

test("web_lookup reads through Extract first, passes the objective, and falls through when it cannot", async () => {
  const p = fakeParallel({
    extract: async (urls, { objective }) => urls[0].endsWith("/maker")
      ? { ok: true, results: [{ url: urls[0], title: "Pixel 11 (extracted)", date: "", text: `about ${objective}: From $899. ![shot](https://img.test/pixel.jpg)`, images: ["https://img.test/pixel.jpg"] }], errors: [] }
      : { ok: true, results: [], errors: [{ url: urls[0], error: "could not fetch" }] },
  });
  const got = await webLookup(`${site.url}/maker`, { objective: "the price", parallel: p });
  assert.equal(got.ok, true);
  assert.equal(got.provider, "parallel");
  assert.equal(got.focused_on, "the price");
  assert.match(got.text, /\$899/);
  assert.deepEqual(got.images, ["https://img.test/pixel.jpg"]);
  assert.deepEqual(p.calls[0].args[1].objective, "the price");

  // A page Extract could not read is still read: plain fetch is the floor.
  const fallback = await webLookup(`${site.url}/review-a`, { parallel: p });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.provider, undefined, "plain fetch has no provider");
  assert.match(fallback.text, /9 hours 40 minutes/);

  // No key: Extract is skipped without a call.
  const off = fakeParallel({}, { connected: false });
  const plain = await webLookup(`${site.url}/maker`, { parallel: off });
  assert.equal(plain.ok, true);
  assert.equal(off.calls.length, 0);
});

test("a research run hands its question to the reader as the objective", async () => {
  const seen = [];
  const lookup = async (url, opts) => { seen.push(opts.objective); return { ok: true, url, title: "T", text: "From $899." }; };
  const out = await call("research", { question: "pixel 11 price?", queries: ["pixel 11 price"], kind: "choice" },
    { searchProvider: fakeProvider({ answers: { "*": results([["/maker", "Official"]]) } }), robots: openRobots, lookup, parallel: fakeParallel({}, { connected: false }) });
  assert.equal(out.ok, true);
  assert.deepEqual(seen, ["pixel 11 price?"]);
});

// ---------------------------------------------------------------------------
// deep research through the Task API
// ---------------------------------------------------------------------------

test("a deep run also starts a Parallel task, and the wake imports its report as pages Parallel read", async () => {
  let taskDone = false;
  const p = fakeParallel({
    taskStart: async (input, opts) => {
      assert.match(input, /pixel 11 or pixel 10/);
      assert.equal(opts.webhookUrl, "https://reason.example.test/parallel/webhook");
      assert.equal(opts.processor, config.parallelDeepProcessor);
      return { ok: true, run_id: "trun_deep", status: "queued" };
    },
    taskStatus: async () => ({ ok: true, status: taskDone ? "completed" : "running", active: !taskDone, error: "" }),
    taskResult: async () => ({ ok: true, text: "Get the Pixel 10: same camera, $250 less.", confidence: "high", status: "completed", sources: [
      { url: "https://gear.test/vs", title: "Gear Bench", said: "The Pixel 10 is now $649", reasoning: "the comparison settles it" },
    ] }),
  });
  const provider = fakeProvider({ answers: { "*": results([["/maker", "Official"]]) } });
  const started = await call("research", { question: "pixel 11 or pixel 10?", queries: ["one", "two"], deep: true, kind: "choice" },
    { searchProvider: provider, robots: openRobots, parallel: p, researchCaps: { maxSearches: 1 } });
  assert.equal(started.ok, true);
  assert.ok(started.task_id);
  assert.match(started.deep_note, /deep-research agent is ALSO on this question/);
  assert.equal(started.parallel_pending, true);
  assert.equal(started.pages_read, 1, "Reason's own slice still ran");
  const row = db.parallelRunForResearch(started.research_id);
  assert.equal(row.remote_id, "trun_deep");
  assert.equal(row.task_id, started.task_id);
  assert.equal(row.research_id, started.research_id);

  // A wake while Parallel is still going: the run stays open and the model is told to come back.
  const waiting = await call("research", { research_id: started.research_id }, { searchProvider: provider, robots: openRobots, parallel: p, researchCaps: { maxSearches: 5 } });
  assert.equal(waiting.ok, true);
  assert.equal(waiting.parallel_pending, true);
  assert.match(waiting.deep_note, /still going/);
  assert.equal(db.getResearch(C, started.research_id).state, "open", "all queries ran, but the report is still owed");
  assert.equal(waiting.sources.every(s => !/Parallel/.test(s.via)), true);

  // The webhook says it finished: the task is due now, and the next wake brings the report in.
  taskDone = true;
  const rawBody = JSON.stringify({ type: "task_run.status", data: { run_id: "trun_deep", status: "completed" } });
  const hook = await parallelWebhookRequest({ rawBody, headers: signWebhook({ rawBody, secret: process.env.PARALLEL_WEBHOOK_SECRET }) });
  assert.equal(hook.status, 200);
  assert.ok(db.getTask(C, started.task_id).next_wake_at <= clock.now(), "the research task wakes now, not at its own time");

  const landed = await call("research", { research_id: started.research_id }, { searchProvider: provider, robots: openRobots, parallel: p });
  assert.equal(landed.ok, true);
  assert.equal(landed.report.text, "Get the Pixel 10: same camera, $250 less.");
  assert.equal(landed.report.confidence, "high");
  assert.equal(landed.report.by, "Parallel's research agent");
  const theirs = landed.sources.find(s => s.url === "https://gear.test/vs");
  assert.ok(theirs, "the report's citation is in the source log");
  assert.match(theirs.via, /read by Parallel's research agent, not by you/);
  assert.match(theirs.said, /\$649/);
  assert.match(theirs.said, /its reasoning: the comparison settles it/);
  assert.match(landed.note, /the research says/);
  assert.equal(landed.parallel_pending, undefined);
  assert.equal(db.getResearch(C, started.research_id).state, "done");
  assert.equal(db.hasSeenUrl(C, "https://gear.test/vs"), true, "a cited page may go on a page");

  // Collected once: another wake finds the run finished and the report still there, with no refetch.
  const fetches = p.calls.filter(c => c.name === "taskResult").length;
  const again = await call("research", { research_id: started.research_id }, { searchProvider: provider, robots: openRobots, parallel: p });
  assert.equal(again.ok, true);
  assert.equal(again.report.text, landed.report.text);
  assert.equal(p.calls.filter(c => c.name === "taskResult").length, fetches);
});

test("a deep run that Parallel fails is said as the ordinary look, and a run with no key is the old path", async () => {
  const p = fakeParallel({ taskStatus: async () => ({ ok: true, status: "failed", active: false, error: "processor error" }) });
  const provider = fakeProvider({ answers: { "*": results([["/maker", "Official"]]) } });
  const started = await call("research", { question: "pixel?", queries: ["one"], deep: true }, { searchProvider: provider, robots: openRobots, parallel: p });
  const more = await call("research", { research_id: started.research_id }, { searchProvider: provider, robots: openRobots, parallel: p });
  assert.equal(more.ok, true);
  assert.match(more.deep_note, /failed/);
  assert.equal(db.parallelRunForResearch(started.research_id).status, "failed");

  const off = fakeParallel({}, { connected: false });
  const plain = await call("research", { question: "pixel?", queries: ["one"], deep: true }, { searchProvider: provider, robots: openRobots, parallel: off });
  assert.equal(plain.ok, true);
  assert.equal(db.parallelRunForResearch(plain.research_id), null);
  assert.equal(off.calls.length, 0);
  assert.doesNotMatch(plain.deep_note, /ALSO/);
});

// ---------------------------------------------------------------------------
// a fact: the quick cited answer
// ---------------------------------------------------------------------------

test("a fact question comes back with a cited answer and no searches of Reason's own", async () => {
  const p = fakeParallel({
    answer: async (q) => ({ ok: true, text: "The fed funds rate is 4.25–4.50%.", searches: 3, sources: [{ url: "https://fed.test/rate", title: "Fed", said: "4.25–4.50%" }] }),
  });
  const provider = fakeProvider({ answers: { "*": results([["/maker", "Official"]]) } });
  const out = await call("research", { question: "what's the fed funds rate", queries: ["fed funds rate today"], kind: "fact" }, { searchProvider: provider, robots: openRobots, parallel: p });
  assert.equal(out.ok, true);
  assert.equal(out.answer.text, "The fed funds rate is 4.25–4.50%.");
  assert.equal(out.answer.by, "Parallel's quick-answer agent");
  assert.equal(out.searches_used, 0, "no search of Reason's own ran");
  assert.equal(provider.calls.length, 0);
  assert.equal(out.snippets_only[0].url, "https://fed.test/rate");
  assert.match(out.snippets_only[0].via, /cited by Parallel's quick answer/);
  assert.match(out.note, /what the research says/);
  assert.equal(db.getResearch(C, out.research_id).state, "done");
  assert.deepEqual(db.getResearch(C, out.research_id).queries, []);

  // Nothing cited: the ordinary searches run as if the answer was never asked for.
  const thin = fakeParallel({ answer: async () => ({ ok: true, text: "maybe", searches: 0, sources: [] }) });
  const fell = await call("research", { question: "what's the fed funds rate", queries: ["fed funds rate today"], kind: "fact" }, { searchProvider: provider, robots: openRobots, parallel: thin });
  assert.equal(fell.answer, undefined);
  assert.equal(fell.searches_used, 1);

  // A choice never takes the shortcut.
  const choice = await call("research", { question: "pixel 11 or 10", queries: ["pixel"], kind: "choice" }, { searchProvider: provider, robots: openRobots, parallel: p });
  assert.equal(choice.answer, undefined);
  assert.equal(p.calls.filter(c => c.name === "answer").length, 1);
});

// ---------------------------------------------------------------------------
// the niche detour: an entity search for "which companies"
// ---------------------------------------------------------------------------

test("a trades question gets one entity search, logged as leads, and never twice", async () => {
  const p = fakeParallel({
    entitySearch: async ({ objective, entityType }) => {
      assert.equal(entityType, "companies");
      assert.doesNotMatch(objective, /202-555/, "their number never leaves the machine");
      return { ok: true, entities: [{ name: "Ace Plumbing", url: "https://ace.test", description: "licensed, Brooklyn" }, { name: "no url", url: "", description: "" }] };
    },
  });
  const provider = fakeProvider({ answers: { "*": results([["/maker", "Official"]]) } });
  const out = await call("research", { question: "a plumber in brooklyn, my number's 202-555-1234", queries: ["brooklyn plumber"], niche: "trades" },
    { searchProvider: provider, robots: openRobots, parallel: p, researchCaps: { maxNicheSearches: 0 } });
  assert.equal(out.ok, true);
  const lead = out.niche.leads.find(l => l.url === "https://ace.test");
  assert.ok(lead, "an entity is a lead, not a find");
  assert.equal(out.snippets_only.find(s => s.url === "https://ace.test").via.startsWith("found by Parallel's entity search"), true);
  assert.equal(out.sources.some(s => s.url === "https://ace.test"), false, "nobody read it, so it is not a source");
  assert.equal(p.calls.filter(c => c.name === "entitySearch").length, 1);

  await call("research", { research_id: out.research_id }, { searchProvider: provider, robots: openRobots, parallel: p });
  assert.equal(p.calls.filter(c => c.name === "entitySearch").length, 1, "a wake does not ask again");

  const gear = await call("research", { question: "which headphones", queries: ["headphones"], niche: "gear" }, { searchProvider: provider, robots: openRobots, parallel: p });
  assert.equal(gear.ok, true);
  assert.equal(p.calls.filter(c => c.name === "entitySearch").length, 1, "a kind that is not a list of companies does not ask");
});

// ---------------------------------------------------------------------------
// watching the world
// ---------------------------------------------------------------------------

function harness({ parallel, lookup = async () => ({ ok: true, text: "nothing" }) }) {
  const turns = [];
  const rt = new Runtime({ runTurn: async (t) => { turns.push(t); return "ok"; }, lookup, parallel, checkWatch: async () => ({ met: false, why: "no" }) });
  const sent = [];
  rt.on("outbound", (m) => sent.push(m));
  return { rt, turns, sent };
}

test("watch_set with a query makes a monitor; the sweep tells them once what it found and cancels it", async () => {
  let events = [];
  const p = fakeParallel({
    monitorCreate: async ({ query, frequency, webhookUrl: hook }) => {
      assert.equal(query, "iPhone 18 release date announcement");
      assert.equal(frequency, "1d");
      assert.equal(hook, "https://reason.example.test/parallel/webhook");
      return { ok: true, monitor_id: "monitor_ip18", status: "active" };
    },
    monitorEvents: async () => ({ ok: true, events }),
  });
  const { rt, turns } = harness({ parallel: p });
  const out = await call("watch_set", { query: "iPhone 18 release date announcement", looking_for: "Apple names the day the iPhone 18 goes on sale", every_minutes: 60 * 24, note: "wants to preorder" }, { parallel: p });
  assert.equal(out.ok, true);
  assert.equal(out.frequency, "1d");
  assert.equal(out.watch.query, "iPhone 18 release date announcement");
  assert.equal(out.watch.url, undefined);
  assert.match(out.reminder, /Nothing is being claimed/);
  const id = out.watch.id;
  assert.equal(db.getWatch(C, id).monitor_id, "monitor_ip18");
  assert.equal(db.listWatches(C).length, 1);

  assert.deepEqual(await rt.checkWatches(), { checked: 1, met: 0, gave_up: 0 }, "a first look right away, nothing yet");
  assert.equal(turns.length, 0, "nothing found is nothing said");
  assert.deepEqual(await rt.checkWatches(), { checked: 0, met: 0, gave_up: 0 });

  events = [{ id: "mevt_1", group: "g1", date: "2026-10-20", text: "Apple set the iPhone 18 release for November 7.", sources: [{ url: "https://apple.test/newsroom", title: "Newsroom", said: "available November 7", reasoning: "" }] }];
  clock.skip(25 * 60 * MIN);
  assert.deepEqual(await rt.checkWatches(), { checked: 1, met: 1, gave_up: 0 });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].kind, "event");
  assert.match(turns[0].text, /watch #\d+ for "iPhone 18 release date announcement" says the thing happened/);
  assert.match(turns[0].text, /November 7/);
  assert.match(turns[0].text, /apple\.test\/newsroom/);
  assert.match(turns[0].text, /you have not read these pages yourself/);
  const w = db.getWatch(C, id);
  assert.ok(w.met_at);
  assert.equal(w.last_event_id, "mevt_1");
  assert.ok(p.calls.some(c => c.name === "monitorCancel" && c.args[0] === "monitor_ip18"), "a fired watch stops paying");
  assert.equal(db.hasSeenUrl(C, "https://apple.test/newsroom"), true);
  assert.deepEqual(await rt.checkWatches(), { checked: 0, met: 0, gave_up: 0 }, "fires once");
});

test("a monitor webhook makes the watch due now, and calling it off cancels the monitor", async () => {
  const p = fakeParallel({ monitorEvents: async () => ({ ok: true, events: [] }) });
  const { rt } = harness({ parallel: p });
  const out = await call("watch_set", { query: "Drake adds a Boston date", looking_for: "a Boston show announced", every_minutes: 60 }, { parallel: p });
  assert.equal(out.frequency, "1h");
  await rt.checkWatches();
  assert.deepEqual(await rt.checkWatches(), { checked: 0, met: 0, gave_up: 0 }, "not due");

  const rawBody = JSON.stringify({ type: "monitor.event.detected", data: { monitor_id: "monitor_1", event: { event_group_id: "g9" } } });
  let kicked = 0;
  const hook = await parallelWebhookRequest({ rawBody, headers: signWebhook({ rawBody, secret: process.env.PARALLEL_WEBHOOK_SECRET }), runtime: { checkWatches: async () => { kicked++; } } });
  assert.equal(hook.status, 200);
  assert.equal(kicked, 1, "the sweep is kicked straight away");
  assert.equal((await rt.checkWatches()).checked, 1, "and the watch is due regardless");

  const off = await call("watch_cancel", { watch_id: out.watch.id }, { parallel: p });
  assert.equal(off.ok, true);
  assert.ok(p.calls.some(c => c.name === "monitorCancel" && c.args[0] === "monitor_1"));
});

test("watch_set refuses both and neither, and a query with no key is an honest no", async () => {
  assert.match((await call("watch_set", { looking_for: "x" })).error, /either a `url`/);
  assert.match((await call("watch_set", { url: "https://x.test", query: "y", looking_for: "x" })).error, /One or the other/);
  const off = await call("watch_set", { query: "y", looking_for: "x" }, { parallel: fakeParallel({}, { connected: false }) });
  assert.equal(off.ok, false);
  assert.equal(off.status, "not_connected");
  assert.match(off.error, /A page with a URL can still be watched/);
  assert.equal(db.listWatches(C).length, 0);
  // The page kind is exactly what it was.
  const page = await call("watch_set", { url: "http://127.0.0.1:9/x", looking_for: "a table", every_minutes: 1 });
  assert.equal(page.ok, true);
  assert.equal(page.watch.url, "http://127.0.0.1:9/x");
  assert.equal(page.watch.every_minutes, config.watchMinEveryMin);
});

// ---------------------------------------------------------------------------
// pictures, lists, and the capability list
// ---------------------------------------------------------------------------

test("image_search hands back real pictures and makes them, and their pages, usable", async () => {
  const p = fakeParallel({
    imageSearch: async ({ queries, objective }) => {
      assert.deepEqual(queries, ["via carota interior"]);
      assert.equal(objective, "the dining room");
      return { ok: true, results: [{ image_url: "https://img.test/vc.jpg", page_url: "https://viacarota.test/", title: "Via Carota", width: 1200, height: 800 }] };
    },
  });
  const out = await call("image_search", { queries: ["via carota interior"], objective: "the dining room" }, { parallel: p });
  assert.equal(out.ok, true);
  assert.equal(out.count, 1);
  assert.equal(db.hasSeenUrl(C, "https://img.test/vc.jpg"), true, "the picture may go on a page");
  assert.equal(db.hasSeenUrl(C, "https://viacarota.test/"), true, "and so may its page");
  assert.ok(out.untrusted_content ?? out.note, "marked as outside words");
  const off = await call("image_search", { queries: ["x"] }, { parallel: fakeParallel({}, { connected: false }) });
  assert.equal(off.status, "not_connected");
});

test("find_all is a job: started with conditions shown, collected on the wake, done once", async () => {
  let done = false;
  const p = fakeParallel({
    findAllIngest: async (objective) => ({ ok: true, objective, entity_type: "companies", match_conditions: [{ name: "city", description: "Must be in Charlotte, NC." }, { name: "licence", description: "Must hold a current NC licence." }] }),
    findAllStart: async ({ matchLimit, webhookUrl: hook, matchConditions }) => { assert.equal(matchLimit, 10); assert.equal(hook, "https://reason.example.test/parallel/webhook"); assert.equal(matchConditions.length, 2); return { ok: true, run_id: "findall_r", status: "queued" }; },
    findAllStatus: async () => ({ ok: true, status: done ? "completed" : "running", active: !done, matched: 1, generated: 3 }),
    findAllResult: async () => ({ ok: true, status: "completed", candidates: 3, matches: [{ name: "A Roofing", url: "https://a.test", description: "roofs", why: "Charlotte, NC; licence 12345 current", sources: [{ url: "https://a.test/about", title: "About", said: "Charlotte", reasoning: "" }] }] }),
  });
  const started = await call("find_all", { objective: "residential roofers in Charlotte with a current NC licence", limit: 10 }, { parallel: p });
  assert.equal(started.ok, true);
  assert.ok(started.run_id);
  assert.ok(started.task_id, "a list is a job");
  assert.deepEqual(started.conditions, ["Must be in Charlotte, NC.", "Must hold a current NC licence."]);
  assert.match(started.note, /correct a condition now/);
  assert.equal(db.getTask(C, started.task_id).state, "running");
  assert.equal(db.getParallelRun(started.run_id).remote_id, "findall_r");

  const waiting = await call("find_all", { run_id: started.run_id }, { parallel: p });
  assert.equal(waiting.pending, true);
  assert.equal(waiting.matched_so_far, 1);
  assert.match(waiting.note, /do not tell them it is done/);

  // The webhook wakes the job; the wake collects.
  done = true;
  const rawBody = JSON.stringify({ type: "findall.run.completed", data: { findall_id: "findall_r" } });
  const hook = await parallelWebhookRequest({ rawBody, headers: signWebhook({ rawBody, secret: process.env.PARALLEL_WEBHOOK_SECRET }) });
  assert.equal(hook.status, 200);
  assert.ok(db.getTask(C, started.task_id).next_wake_at <= clock.now());

  const got = await call("find_all", { run_id: started.run_id }, { parallel: p });
  assert.equal(got.ok, true);
  assert.equal(got.status, "completed");
  assert.equal(got.count, 1);
  assert.equal(got.matches[0].why, "Charlotte, NC; licence 12345 current");
  assert.match(got.note, /You verified none of them yourself/);
  assert.equal(db.hasSeenUrl(C, "https://a.test"), true);
  const fetches = p.calls.filter(c => c.name === "findAllResult").length;
  const again = await call("find_all", { run_id: started.run_id }, { parallel: p });
  assert.equal(again.count, 1);
  assert.equal(p.calls.filter(c => c.name === "findAllResult").length, fetches, "kept on the row, fetched once");

  assert.match((await call("find_all", {}, { parallel: p })).error, /needs an `objective`/);
  assert.match((await call("find_all", { run_id: 999 }, { parallel: p })).error, /no list run/);
});

test("the webhook refuses what it cannot verify and shrugs at what it does not know", async () => {
  const rawBody = JSON.stringify({ type: "task_run.status", data: { run_id: "trun_nobody", status: "completed" } });
  assert.equal((await parallelWebhookRequest({ rawBody, headers: {} })).status, 401);
  const ok = await parallelWebhookRequest({ rawBody, headers: signWebhook({ rawBody, secret: process.env.PARALLEL_WEBHOOK_SECRET }) });
  assert.deepEqual(ok, { status: 200, body: { ok: true, unknown: true } });
  const bad = await parallelWebhookRequest({ rawBody: "{", headers: signWebhook({ rawBody: "{", secret: process.env.PARALLEL_WEBHOOK_SECRET }) });
  assert.equal(bad.status, 400);

  // And the route is wired: an unsigned POST at the listener is a 401, not a 404.
  const rt = new Runtime({ runTurn: async () => "ok" });
  const server = createServer({ router: new Router({ runtime: rt }), runtime: rt });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/parallel/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: rawBody });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test("the capability list is honest about the key", () => {
  const names = (list) => Object.fromEntries(list.map(c => [c.name, c]));
  const caps = names(capabilitiesNow({ conversationId: C }));
  assert.equal(caps.image_search.status, "not connected", "no key in this process");
  assert.equal(caps.find_all.status, "not connected");
  assert.doesNotMatch(caps.watchers.what, /watch the WORLD/);
});
