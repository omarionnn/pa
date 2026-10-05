// The home page and the privacy policy, over a real socket.
//
// Google will not publish a consent screen without both of these at addresses anybody can open, so
// what is under test is narrow and worth being exact about:
//
//   1. **They answer 200 to a stranger**, with no link, no code and no cookie.
//   2. **They have not shadowed anything.** Two exact paths were added to a server whose other routes
//      are prefixes and regexes, and a `/` that swallowed `/p/{id}` or a webhook would break Reason
//      quietly. Every existing route is checked to still answer as it did.
//   3. **The privacy page says the things that are true and easy to leave out.** Mail text being in
//      the transcript, and the conversation going to Anthropic, are the two facts somebody would
//      assume are not true — and the Limited Use sentence is what Google's policy asks for.
//   4. **Nothing of anybody's is on either page.** They are the same for every reader.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-site-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SITE_URL = "https://site.example.test/";

const { createServer } = await import("../src/http.js");
const { Router } = await import("../src/channels/router.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

const C = config.ownerConversation;
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

let server;
let base;
before(async () => {
  server = createServer({ router: new Router({ log: () => {} }), runtime: null, log: () => {} });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text(), headers: res.headers };
};

// ---------- they answer ----------

test("a stranger with no link and no code gets the home page", async () => {
  const out = await get("/");
  assert.equal(out.status, 200);
  assert.match(out.type, /text\/html/);
  assert.match(out.body, /Reason/);
  assert.match(out.body, /lives in your texts/i);
  // The two promises the home page is for: nobody hands over a password, and nothing reaches
  // somebody else without being asked.
  assert.match(out.body, /never asks for a password/i);
  assert.match(out.body, /stops and asks/i);
  assert.match(out.body, /\/privacy/, "and it points at the policy, which Google needs linked");
});

test("the privacy page answers too, and is a real page rather than a stub", async () => {
  const out = await get("/privacy");
  assert.equal(out.status, 200);
  assert.match(out.type, /text\/html/);
  assert.ok(out.body.length > 4000, "a privacy policy that fits in a tweet is not one");
  assert.match(out.body, /Privacy/);
});

test("both are public and say they may be indexed, unlike everything made for one person", async () => {
  for (const p of ["/", "/privacy"]) {
    const out = await get(p);
    assert.match(out.body, /<meta name="robots" content="index,follow">/, p);
    assert.match(out.headers.get("cache-control") ?? "", /public/, p);
  }
  // A page made for somebody is still kept out of search engines.
  const { renderPage } = await import("../src/pages/render.js");
  const made = renderPage({ title: "Gift ideas", blocks: [], revision: 1, created_at: Date.now(), shared: false }, {});
  assert.match(made, /noindex/);
});

test("HEAD works, which is what a reviewer's checker may send", async () => {
  for (const p of ["/", "/privacy"]) {
    const res = await fetch(`${base}${p}`, { method: "HEAD" });
    assert.equal(res.status, 200, p);
  }
});

// ---------- the policy is true to the code ----------

test("the policy names what is really stored, from the tables that really exist", async () => {
  const { body } = await get("/privacy");
  for (const [what, pattern] of [
    ["the transcript", /transcript/i],
    ["the 60-message window", /60 messages/],
    ["plans and reminders", /Plans, reminders/i],
    ["the action ledger", /receipt for every action/i],
    ["connected accounts and their tokens", /tokens that make them work/i],
    ["call recordings on disk", /recordings as files/i],
  ]) {
    assert.match(body, pattern, what);
  }
  // And the window it names is the window the code uses.
  const agent = await import("node:fs").then(fs => fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8"));
  assert.match(agent, /const MAX_HISTORY = 60;/, "if this changes, the number on the privacy page has to change with it");
});

test("the policy admits the two things somebody would assume were not true", async () => {
  const { body } = await get("/privacy");
  // Mail text is in the transcript, because tool results are saved with it.
  assert.match(body, /the text of that email or event is in the transcript/i);
  // And the conversation goes to the model provider, because that is how it is read at all.
  assert.match(body, /sends your conversation to Anthropic/i);
  assert.match(body, /There is no model on the machine/i);
});

test("the policy carries the Limited Use statement Google's policy asks for", async () => {
  const { body } = await get("/privacy");
  assert.match(body, /adheres to the Google API Services User Data Policy, including the Limited Use requirements/);
  // And the four things that commitment actually means, in words somebody can check.
  assert.match(body, /not sold/i);
  assert.match(body, /advertising/i);
  assert.match(body, /never used to train/i);
  assert.match(body, /no human reads it/i);
});

test("the policy says what Reason asks Google for, and what it cannot do", async () => {
  const { body } = await get("/privacy");
  assert.match(body, /exactly two permissions/i);
  assert.match(body, /cannot delete your mail permanently/i);
  assert.match(body, /Attachments are never downloaded/i);
  assert.match(body, /No access token or refresh token ever leaves the machine/i);
  assert.match(body, /never as an instruction/i);
});

test("the policy says how to disconnect and how to get or delete everything", async () => {
  const { body } = await get("/privacy");
  assert.match(body, /ask it to disconnect/i);
  assert.match(body, /google\.com\/permissions/, "and that they can take it away from their own side");
  assert.match(body, /data:export/);
  assert.match(body, /data:delete/);
  assert.match(body, /no backups/i);
});

test("neither page has anybody's data on it", async () => {
  db.upsertAccount({ conversationId: "dm:fake:+13475550000", channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
  for (const p of ["/", "/privacy"]) {
    const { body } = await get(p);
    assert.ok(!body.includes("3475550000"), p);
    assert.ok(!body.includes("Ama"), p);
    assert.ok(!body.includes("2025551234"), p);
  }
});

// ---------- nothing was shadowed ----------

test("the routes that existed before still answer exactly as they did", async () => {
  // /health is still JSON, not a page.
  const h = await get("/health");
  assert.equal(h.status, 200);
  assert.match(h.type, /application\/json/);
  assert.equal(JSON.parse(h.body).ok, true);

  // A page id is still a page id, and an unknown one is still the same dull 404.
  const page = await get("/p/abcdefgh12345678");
  assert.equal(page.status, 404);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /Not found/);

  // A sign-in link that is not real is still 404 JSON, not the home page.
  const signin = await get("/s/short");
  assert.equal(signin.status, 404);
  assert.match(signin.type, /application\/json/);

  // Webhooks are untouched: a GET on one is still not found rather than a page.
  const hook = await get("/channels/sendblue/webhook");
  assert.equal(hook.status, 404);
  assert.match(hook.type, /application\/json/);

  // And anything else is still a JSON 404 rather than being swept up by the home page.
  for (const p of ["/privacy/", "/privacyy", "/nope", "/p", "/index.html", "/favicon.ico"]) {
    const out = await get(p);
    assert.equal(out.status, 404, p);
    assert.match(out.type, /application\/json/, p);
  }
});

test("the public pages answer only GET and HEAD", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    for (const p of ["/", "/privacy"]) {
      const res = await fetch(`${base}${p}`, { method });
      assert.equal(res.status, 404, `${method} ${p}`);
    }
  }
});

test("the pages name the address this install is really reachable at", async () => {
  const was = config.publicUrl;
  config.publicUrl = "https://reason.example.ts.net";
  try {
    const { body } = await get("/privacy");
    assert.match(body, /reason\.example\.ts\.net/);
  } finally {
    config.publicUrl = was;
  }
});

test("the home page links to the privacy policy and to the fuller website, and only to real addresses", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<a href="\/privacy">Privacy policy<\/a>/);
  assert.match(html, /<a href="https:\/\/site\.example\.test\/" rel="noopener">See the good-looking version<\/a>/);
  // The privacy page has nowhere to send anybody, so it has no list of links at all.
  assert.doesNotMatch(await (await fetch(`${base}/privacy`)).text(), /<ul class="links">/);

  const { renderNotice } = await import("../src/pages/render.js");
  const odd = renderNotice({ title: "x", links: [
    { label: "script", href: "javascript:alert(1)" },
    { label: "bare", href: "example.com" },
    { label: "elsewhere", href: "//evil.example" },
    { label: "", href: "/privacy" },
  ] });
  assert.doesNotMatch(odd, /<ul class="links">/, "nothing that is not a path or a web address becomes a link");
  assert.doesNotMatch(odd, /javascript:/);
});
