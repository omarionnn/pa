// A deal or where-to-buy answer that names several shops carries a link for each one it names,
// when the tool result has one, and never an invented URL. The reply check must not strip them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-deal-links-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { SYSTEM } = await import("../src/agent.js");
const offers = await import("../src/offers.js");

after(() => rmSync(dir, { recursive: true, force: true }));

test("the prompt asks for a link per option in a deal answer, and forbids inventing one", () => {
  assert.match(SYSTEM, /a deal or buy answer links each option it names when a tool result has one, never an invented URL/);
  assert.match(SYSTEM, /Never invent venues, showtimes, prices or links/);
});

test("the sensible-guess rule is still there", () => {
  assert.match(SYSTEM, /otherwise start, and say the assumption/);
});

test("the reply check keeps a link per shop in a deal answer", () => {
  const links = ["https://shop-one.test/p/1", "https://shop-two.test/item/2", "https://shop-three.test/x/3"];
  const reply = `found it at three shops.\nshop one has it in stock\n${links[0]}\nshop two ships tomorrow\n${links[1]}\nshop three has it for pickup\n${links[2]}`;
  const g = offers.guardReply("dm:owner", reply, { turnReply: true });
  for (const l of links) assert.ok(g.text.includes(l), `kept ${l}`);
});
