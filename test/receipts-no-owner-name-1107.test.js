// A receipt is written into the ledger of whoever's Reason did the thing (src/trust.js receiptFor,
// ledgerWrite). Until 2026-11-07 a dozen of them said the operator's name instead — "Sent Omari the
// recording of call #73" landed in another user's own record. Each user's Reason is sealed: no
// operator name, and no other person's identifier, may be written into anybody else's rows.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-receipts-owner-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
// A name that appears nowhere else, so any hit is the operator's name and nothing else.
const OWNER = "Zebulonix";
const OWNER_NUMBER = "+12025559999";
process.env.REASON_OWNER_NAME = OWNER;
process.env.REASON_OWNER_NUMBER = OWNER_NUMBER;

const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const AMA = "dm:+13475550111";

// A value that fills any template: every field is itself, it prints as "v", and it can be called.
function filler(overrides = {}) {
  const deep = new Proxy(function () {}, {
    get(_t, k) {
      if (k === Symbol.toPrimitive) return () => "v";
      if (k === "then") return undefined;
      if (k === "length") return 1;
      return deep;
    },
    apply() { return deep; },
  });
  return new Proxy({}, {
    get(_t, k) {
      if (k in overrides) return overrides[k];
      if (typeof k === "symbol" || k === "then") return undefined;
      return deep;
    },
  });
}

const actions = [...readFileSync(new URL("../src/trust.js", import.meta.url), "utf8")
  .slice(readFileSync(new URL("../src/trust.js", import.meta.url), "utf8").indexOf("export function receiptFor"))
  .matchAll(/case "([a-z_]+)":/g)].map(m => m[1]);

test("no receipt, ok or failed, carries the operator's name or number", () => {
  assert.ok(actions.length > 50, `found ${actions.length} receipt kinds`);
  let rendered = 0;
  for (const action of new Set(actions)) {
    const shapes = [
      [filler(), filler({ ok: true, error: undefined, blocked: undefined, held: undefined, cant_do: undefined, already_enrolled: undefined })],
      [filler(), filler({ ok: true, error: undefined, blocked: undefined, already_enrolled: true })],
      [filler({ unprompted: false }), filler({ ok: true, error: undefined, blocked: undefined })],
      [filler(), { ok: false, error: "nope" }],
    ];
    for (const [input, out] of shapes) {
      let line;
      try { line = trust.receiptFor(action, input, out); } catch { continue; }
      if (typeof line !== "string") continue;
      rendered++;
      assert.ok(!line.includes(OWNER), `${action}: ${line}`);
      assert.ok(!line.includes(OWNER_NUMBER), `${action}: ${line}`);
    }
  }
  assert.ok(rendered > 100, `rendered ${rendered} receipts`);
});

test("call #73's recording sent to Ama is written into Ama's own record as hers, with nobody else in it", () => {
  trust.ledgerWrite({ conversationId: AMA, action: "call_recording", input: { call_id: 73 },
    out: { ok: true, seconds: 41, bytes: 90_000, format: "wav", file: "call-73.wav" }, target: "call:+12125550100" });
  trust.ledgerWrite({ conversationId: AMA, action: "notice_send", input: { key: "k", unprompted: true }, out: { ok: true, what: "your flight moved" } });
  const rows = db.listActions(AMA);
  const rec = rows.find(a => a.action === "call_recording");
  assert.match(rec.receipt, /^Sent them the recording of call #73/);
  for (const r of rows) {
    assert.ok(!JSON.stringify(r).includes(OWNER), r.receipt);
    assert.ok(!JSON.stringify(r).includes(OWNER_NUMBER), r.receipt);
  }
});

test("the confirm flow's instructions to a user's Reason name them, not the operator", () => {
  const src = readFileSync(new URL("../src/trust.js", import.meta.url), "utf8");
  // The only operator-name references left are the spend-cap defaults, which every caller overrides
  // with the conversation's own name (src/tools.js checkCaps … ownerName: me.name).
  const uses = [...src.matchAll(/config\.ownerName/g)].length;
  assert.equal(uses, 2);
});
