// Phone numbers never reach the server log in full (src/logmask.js, audit 11-09 step 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REASON_TOKEN_KEY ||= "0".repeat(64);
const { maskPhone, maskPhones, installConsoleMask } = await import("../src/logmask.js");

const NUM = "+12025551234";

test("a conversation id keeps its shape but loses the number", () => {
  const out = maskPhones(JSON.stringify({ agentcard_refresh: "ok", conversation: `dm:sendblue:${NUM}`, to: NUM }));
  assert.ok(!out.includes("2025551234"), out);
  assert.match(out, /dm:sendblue:\+…1234~[0-9a-f]{6}/);
  assert.equal(JSON.parse(out).to, maskPhone(NUM));
});

test("same number, same mask; different numbers differ", () => {
  assert.equal(maskPhone(NUM), maskPhone(NUM));
  assert.notEqual(maskPhone(NUM), maskPhone("+12025559999"));
  assert.notEqual(maskPhone(NUM), maskPhone("+13035551234")); // same last four
});

test("timestamps, ids, prices and short numbers are left alone", () => {
  const s = `at 1762737600000 id 7744123399345 $1499.00 code +1234 ext 5551234`;
  assert.equal(maskPhones(s), s);
});

test("the start-up list of test numbers is masked", () => {
  const out = maskPhones(`ONLY these numbers get answers: ${NUM}, +447700900123`);
  assert.ok(!/\d{7}/.test(out), out);
});

test("console wrapper masks strings, errors and objects", () => {
  const seen = [];
  const fake = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) fake[k] = (...a) => seen.push(a);
  installConsoleMask(fake);
  fake.log("   ·", JSON.stringify({ started_message: `dm:sendblue:${NUM}`, to: NUM }));
  fake.error(new Error(`send to ${NUM} failed`));
  fake.warn({ read_receipt: NUM });
  fake.info({ plain: "nothing here" }, 42);
  const flat = seen.flat().map(x => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join("\n");
  assert.ok(!flat.includes("2025551234"), flat);
  assert.deepEqual(seen[3], [{ plain: "nothing here" }, 42]); // untouched when there is no number
});

test("serve.js installs the mask before anything else is imported", () => {
  const src = readFileSync(new URL("../src/serve.js", import.meta.url), "utf8");
  const first = src.split("\n").find(l => l.startsWith("import "));
  assert.match(first, /logmask-install\.js/);
});
