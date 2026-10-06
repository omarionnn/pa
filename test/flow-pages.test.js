// The copy block chosen by the model itself, through whatever backend is live — on the owner's
// machine that is the claude-cli path, the one Reason actually runs on here. Asserts on what
// landed in the database, never on wording: the owner asked for something to paste elsewhere,
// so the page that comes back has a copy block whose text is the thing to paste.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-test-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";

const { Runtime } = await import("../src/runtime.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const C = "dm:test";
const rt = new Runtime();

before(() => { clock.reset(); });
after(() => { rt.stop(); rmSync(dir, { recursive: true, force: true }); });

test(`asked for a prompt to paste into another AI, Reason makes a page with a copy block (${label})`, { skip }, async () => {
  const reply = await rt.inbound(C,
    "write me a detailed prompt i can paste into chatgpt to plan a 3 day lisbon trip for me and my partner, we like food and small museums. put it on a page so i can copy it");
  assert.ok(typeof reply === "string" && reply.length > 0, "it said something back");

  const pages = db.listPages(C);
  assert.equal(pages.length, 1, `exactly one page, got ${pages.length}`);
  const copies = pages[0].blocks.filter(b => b.type === "copy");
  assert.ok(copies.length >= 1, `the page needs a copy block; it has: ${pages[0].blocks.map(b => b.type).join(", ")}`);
  const c = copies[0];
  assert.match(c.text.toLowerCase(), /lisbon/, "the copy text is the prompt itself");
  assert.ok(c.text.length > 100, "a detailed prompt, not a one-liner");
  assert.match(c.filename, /\.txt$/);
  assert.ok(c.label.length <= 40);
});
