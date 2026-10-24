// No browser launcher hides automation from the site (2026-10-23). The flag
// --disable-blink-features=AutomationControlled was passed by every launcher; a site that blocks an
// automated browser now gets a stop and a hand-back, never a workaround. Pinned by reading the source
// of everything that launches Chromium, so a new launcher that adds the flag back fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
function files(d) {
  return readdirSync(d).flatMap(n => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? files(p) : /\.(m?js|cjs)$/.test(n) ? [p] : [];
  });
}

test("no launcher passes a flag that hides automation", () => {
  const bad = /disable-blink-features\s*=\s*AutomationControlled|excludeSwitches|enable-automation|playwright-extra|puppeteer-extra/i;
  const offenders = [...files(join(root, "src")), ...files(join(root, "scripts"))]
    .filter(p => readFileSync(p, "utf8").split("\n").some(l => bad.test(l) && !/^\s*(\/\/|\*)/.test(l)));
  assert.deepEqual(offenders, []);
});
