// Browser tracing, video recording and HAR capture stay off everywhere a browser is launched or a
// context is created: a trace, a video or a HAR file would keep every keystroke, every page and
// every request, password boxes included (PR 1 of docs/account-access-design.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) { if (n !== "node_modules") walk(f); }
    else if (/\.(m?js|cjs)$/.test(n)) files.push(f);
  }
})(SRC);

const LAUNCH = /\b(?:launch|launchProfile|launchPersistentContext|newContext|connectOverCDP|launchServer)\s*\(/;
const RECORDING = /\brecordVideo\b|\brecordHar\b|videosPath|videoSize|tracesDir|routeFromHAR|\btracing\s*\.\s*start(?:Chunk)?\s*\(|--enable-logging|--log-net-log|--remote-debugging-port/;

test("no source file records video, HAR or a trace", () => {
  const found = files.filter(f => RECORDING.test(readFileSync(f, "utf8"))).map(f => f.slice(SRC.length));
  assert.deepEqual(found, []);
});

test("the scan sees the places a browser is launched or a context is made", () => {
  const sites = files.filter(f => LAUNCH.test(readFileSync(f, "utf8")) && /playwright|chromium|launcher/.test(readFileSync(f, "utf8"))).map(f => f.slice(SRC.length));
  for (const f of ["browser.js", "signin-remote.js", "signin-cli.js"]) assert.ok(sites.includes(f), `${f} is scanned`);
  assert.ok(sites.length >= 5, `only ${sites.length} launch sites found`);
});
