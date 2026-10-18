// Reading one page: which provider does it, in what order, and what comes back.
//
// Pinned after 2026-10-18: search had moved to Parallel, but every page read (web_lookup, the watch
// loop, research sources) still went to Context.dev first, and a 15-minute price watch spent the
// month's Context.dev credits by itself. Page reads go to Parallel first now.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { webLookup, markdownImageUrls } from "../src/weblookup.js";

const realFetch = globalThis.fetch;
const kept = { parallelKey: config.parallelKey, contextDevKey: config.contextDevKey };
let calls = [];
let answer = {};

function respond(status, body, headers = { "content-type": "application/json" }) {
  return {
    ok: status >= 200 && status < 300, status, statusText: String(status), url: "",
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
}

before(() => {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    const pick = Object.entries(answer).find(([prefix]) => u.startsWith(prefix));
    if (!pick) throw new Error(`no stub for ${u}`);
    const r = pick[1];
    return typeof r === "function" ? r(u, init) : r;
  };
});
after(() => {
  globalThis.fetch = realFetch;
  config.parallelKey = kept.parallelKey;
  config.contextDevKey = kept.contextDevKey;
});
beforeEach(() => { calls = []; answer = {}; });

const PAGE = "https://shop.example/boots";
const PARALLEL = "https://api.parallel.ai/v1/extract";
const CONTEXT = "https://api.context.dev/v1/web/scrape";

test("with a Parallel key, a page is read through Parallel Extract and nothing else is called", async () => {
  config.parallelKey = "p-key";
  config.contextDevKey = "c-key";
  answer[PARALLEL] = respond(200, {
    results: [{
      url: PAGE, title: "Adrian Bex Boot",
      excerpts: ["short"],
      full_content: "# Adrian Bex\n\n![boot](https://img.example/boot.jpg) $179.99 ![icon](/badge.svg) ![http](http://img.example/no.jpg)",
    }],
    errors: [],
  });

  const out = await webLookup(PAGE);

  assert.equal(out.ok, true);
  assert.equal(out.provider, "parallel");
  assert.equal(out.title, "Adrian Bex Boot");
  assert.match(out.text, /\$179\.99/);
  assert.deepEqual(out.images, ["https://img.example/boot.jpg"], "https only, no svg, no http");
  assert.match(out.images_note, /real image addresses/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PARALLEL);
  assert.equal(calls[0].init.headers["x-api-key"], "p-key");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.urls, [PAGE]);
  assert.equal(body.advanced_settings.full_content.max_chars_per_result, 6000);
  assert.equal(body.advanced_settings.fetch_policy.max_age_seconds, undefined, "a one-off read takes the cached copy");
});

test("a watch asks Parallel for a fresh read, so a cached price cannot blind it", async () => {
  config.parallelKey = "p-key";
  answer[PARALLEL] = respond(200, { results: [{ url: PAGE, full_content: "price 101000" }], errors: [] });

  const out = await webLookup(PAGE, { fresh: true });

  assert.equal(out.provider, "parallel");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.advanced_settings.fetch_policy.max_age_seconds, 600);
});

test("full content is cut at max_chars and says so; excerpts stand in when full content is missing", async () => {
  config.parallelKey = "p-key";
  answer[PARALLEL] = respond(200, { results: [{ url: PAGE, full_content: "x".repeat(50) }] });
  const cut = await webLookup(PAGE, { maxChars: 20 });
  assert.equal(cut.text.length, 20);
  assert.equal(cut.text_truncated, true);

  calls = [];
  answer[PARALLEL] = respond(200, { results: [{ url: PAGE, excerpts: ["first bit", "second bit"] }] });
  const ex = await webLookup(PAGE);
  assert.equal(ex.provider, "parallel");
  assert.equal(ex.text, "first bit\n\nsecond bit");
});

test("when Parallel fails, Context.dev is the fallback, and plain fetch after that", async () => {
  config.parallelKey = "p-key";
  config.contextDevKey = "c-key";
  answer[PARALLEL] = respond(500, { error: "down" });
  answer[CONTEXT] = respond(200, { markdown: { success: true, data: "from context" }, metadata: { title: "C", finalUrl: PAGE } });

  const viaContext = await webLookup(PAGE);
  assert.equal(viaContext.provider, "contextdev");
  assert.equal(viaContext.text, "from context");
  assert.deepEqual(calls.map(c => c.url), [PARALLEL, CONTEXT]);

  calls = [];
  answer[CONTEXT] = respond(402, { error: "out of credits" });
  answer[PAGE] = { ...respond(200, "<html><title>Plain</title><body><p>plain page</p></body></html>", { "content-type": "text/html" }), url: PAGE };

  const plain = await webLookup(PAGE);
  assert.equal(plain.ok, true);
  assert.equal(plain.provider, undefined);
  assert.equal(plain.title, "Plain");
  assert.match(plain.text, /plain page/);
  assert.deepEqual(calls.map(c => c.url), [PARALLEL, CONTEXT, PAGE]);
});

test("with no Parallel key, Parallel is never called", async () => {
  config.parallelKey = "";
  config.contextDevKey = "c-key";
  answer[CONTEXT] = respond(200, { markdown: { success: true, data: "ctx" } });

  const out = await webLookup(PAGE);

  assert.equal(out.provider, "contextdev");
  assert.deepEqual(calls.map(c => c.url), [CONTEXT]);
});

test("with no keys at all, a page is a plain fetch — including a JSON endpoint", async () => {
  config.parallelKey = "";
  config.contextDevKey = "";
  const api = "https://api.exchange.example/products/BTC-USD/ticker";
  answer[api] = { ...respond(200, { price: "101000.00" }), url: api };

  const out = await webLookup(api);

  assert.equal(out.ok, true);
  assert.equal(out.provider, undefined);
  assert.match(out.text, /101000\.00/);
  assert.deepEqual(calls.map(c => c.url), [api]);
});

test("markdownImageUrls keeps the same rule as the HTML reader: https, resolved, no svg, de-duplicated", () => {
  const md = "![a](/pics/one.jpg) ![b](https://cdn.example/two.png \"title\") ![c](<https://cdn.example/two.png>) ![d](http://cdn.example/three.jpg) ![e](/logo.svg)";
  assert.deepEqual(markdownImageUrls(md, "https://shop.example/x"), [
    "https://shop.example/pics/one.jpg",
    "https://cdn.example/two.png",
  ]);
});
