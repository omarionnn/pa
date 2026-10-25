// Guards for every verification code Reason texts (2026-10-25, Omari): the text ends in Apple's
// domain-bound `@<production host> #<code>` line, and every box a code is typed into is a
// one-time-code field. Written against live's own addresses, and against the source, so a new
// code flow that skips either fails here.
//
// No API key, no network, no browser.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-code-guards-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_CONVERSATION = "dm:owner";
// Live's addresses (/opt/reason/.env): pages and events on the files host; /ops on the website,
// from opsUrl()'s default because live sets no REASON_OPS_URL.
process.env.REASON_PAGES_URL = "https://files.reason.omarinyarko.com";
process.env.REASON_PUBLIC_URL = "https://reason.tail3753c7.ts.net";
delete process.env.REASON_OPS_URL;

const access = await import("../src/pages/access.js");
const events = await import("../src/events.js");
const ops = await import("../src/ops.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const endsBound = (line, host, code) => {
  const parts = line.split("\n");
  assert.match(parts[0], new RegExp(`^Your Reason code is ${code}\\b`), "readable first line with the code");
  assert.equal(parts.at(-2), "", "a blank line before the last");
  assert.equal(parts.at(-1), `@${host} #${code}`, "Apple's domain-bound last line");
};

test("a page's code text ends in @files.reason.omarinyarko.com #code", () => {
  endsBound(access.codeLine({ id: "abc", title: "Gift ideas" }, "012345"), "files.reason.omarinyarko.com", "012345");
});

test("the status page's code text ends in @reason.omarinyarko.com #code", () => {
  endsBound(access.codeLine({ id: "ops", title: "Reason status" }, "004213", { host: access.codeHost(ops.opsUrl()) }), "reason.omarinyarko.com", "004213");
});

test("an event's sign-in code text ends in @files.reason.omarinyarko.com #code", () => {
  for (const what of ["sign in to", "open"]) endsBound(events.signinCodeLine({ name: "Rooftop" }, "903117", { what }), "files.reason.omarinyarko.com", "903117");
});

const srcFiles = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? srcFiles(join(d, e.name)) : e.name.endsWith(".js") ? [join(d, e.name)] : []);
const SRC = srcFiles(new URL("../src", import.meta.url).pathname);

test("every code text in the source carries the bound line", () => {
  let n = 0;
  for (const f of SRC) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!/`Your Reason code is /.test(line)) continue;
      n++;
      assert.match(line, /boundTo\(/, `${f}: a code text without boundTo(): ${line.trim().slice(0, 80)}`);
    }
  }
  assert.ok(n >= 2, "the page and event code texts are both found");
});

test("every code box in the source is the one-time-code box", () => {
  let boxes = 0;
  for (const f of SRC) {
    if (f.endsWith("signin-remote.js")) continue; // mirrors a third-party site's own fields
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/<input\b[^>]*>/g)) {
      const tag = m[0];
      const isCode = /name=\\?"code\\?"|id=\\?"code\\?"|codeInputAttrs/.test(tag);
      if (!isCode) continue;
      boxes++;
      assert.match(tag, /codeInputAttrs\(|autocomplete="one-time-code"/, `${f}: a code box that is not one-time-code: ${tag.slice(0, 100)}`);
    }
    assert.doesNotMatch(src, /name="code"(?![^`]*one-time-code)[^>]*>/, `${f}: name="code" outside codeInputAttrs`);
  }
  assert.ok(boxes >= 3, `the page gate and both event boxes are found (${boxes})`);
});
