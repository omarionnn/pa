// The logo on Reason Web always goes Home (owner, 10-27): the greeting and composer, what's in hand
// and "pick up from iMessage". Plain /web follows the 30-minute rule and sends a recent sender to the
// thread, so the wordmark links /web?home, the same arrival sign-in lands on (#203). The Chat tab and
// "the thread" links still go to the thread.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-logo-home-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const convo = await import("../src/pages/webconvo.js");
const saved = await import("../src/pages/websaved.js");
const memory = await import("../src/pages/webmemory.js");
const settings = await import("../src/pages/websettings.js");
const edge = await import("../src/pages/webedge.js");
const kit = await import("../src/pages/webkit.js");

const account = { id: 1, name: "Kofi", conversation_id: "dm:owner", conversationId: "dm:owner" };
const VIEWS = {
  thread: () => convo.renderConversation({ account, csrf: "c", lines: [], more: false, sendId: "s" }),
  "thread, deferred": () => convo.renderConversation({ account, csrf: "c", lines: [], more: false, sendId: "s", deferred: true }),
  home: () => convo.renderHome({ account, csrf: "c", sendId: "s" }),
  ongoing: () => convo.renderOngoing({ csrf: "c" }),
  "first visit": () => convo.renderFirstVisit({ account }),
  error: () => convo.renderError(),
  saved: () => saved.renderSaved({ account, csrf: "c" }),
  memory: () => memory.renderMemory({ account, csrf: "c" }),
  settings: () => settings.renderSettings({ csrf: "c" }),
  "not found": () => edge.renderWebNotFound({ signedIn: true }),
};

test("the wordmark links /web?home on every Web view", () => {
  for (const [name, draw] of Object.entries(VIEWS)) {
    const html = draw();
    const marks = [...html.matchAll(/<a class="wm" href="([^"]*)"/g)].map(m => m[1]);
    assert.ok(marks.length >= 1, `${name}: a linked wordmark`);
    for (const href of marks) assert.equal(href, "/web?home", name);
  }
});

test("the thread's Chat tab still goes to the thread", () => {
  assert.match(convo.tabBar("ongoing", 0), /href="\/web\?thread"/);
});

test("no Web page source links the mark anywhere but /web?home", () => {
  const src = new URL("../src/pages/", import.meta.url);
  for (const f of readdirSync(src).filter(f => /^web.*\.js$/.test(f))) {
    for (const m of readFileSync(new URL(f, src), "utf8").matchAll(/wordmark\(\{ href: ("[^"]*")/g)) assert.equal(m[1], '"/web?home"', f);
  }
  assert.match(kit.wordmark({ href: "/web?home" }), /href="\/web\?home" aria-label="Reason, home"/);
});
