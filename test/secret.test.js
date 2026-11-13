// src/secret.js: a Secret never prints, and use() zero-fills what it lent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect, format } from "node:util";
import { Secret, wipeAll } from "../src/secret.js";

const PLAIN = "hunter2-correct-horse";
const mk = () => new Secret(Buffer.from(PLAIN, "utf8"));

test("every way of printing a Secret shows [secret]", () => {
  const s = mk();
  const shown = [
    String(s), `${s}`, s + "", s.toString(), JSON.stringify(s), JSON.stringify({ password: s, list: [s] }),
    inspect(s), inspect({ nested: { s } }, { depth: 10 }), inspect(s, { customInspect: false, showHidden: true }),
    format("%s %o %O %j", s, s, s, s), format(s), String([s]), Object.prototype.toString.call(s),
    Buffer.from(s).toString("utf8"),
  ];
  for (const t of shown) assert.ok(!t.includes(PLAIN), `leaked through: ${t}`);
  assert.equal(String(s), "[secret]");
  assert.equal(JSON.stringify({ p: s }), '{"p":"[secret]"}');
  assert.equal(inspect(s), "[secret]");
  assert.deepEqual(Object.keys(s), []);
  assert.deepEqual({ ...s }, {});
  assert.ok(!inspect(structuredClone(s), { showHidden: true }).includes(PLAIN));
  assert.ok(s.live, "printing does not spend it");
});

test("an error built from a Secret carries [secret], also as a cause", () => {
  const s = mk();
  const e = new Error(`could not type ${s} into the box`, { cause: s });
  assert.equal(e.message, "could not type [secret] into the box");
  assert.ok(!e.stack.includes(PLAIN));
  assert.ok(!inspect(e).includes(PLAIN));
  assert.ok(inspect(e).includes("[secret]"));
});

test("use() lends the bytes once and zero-fills them after", () => {
  const s = mk();
  let lent;
  const out = s.use(b => { lent = b; return b.toString("utf8") === PLAIN; });
  assert.equal(out, true);
  assert.ok(lent.every(x => x === 0), "zero-filled after use");
  assert.equal(s.live, false);
  assert.throws(() => s.use(() => {}), /already used/);
});

test("use() zero-fills when fn throws, and after an async fn settles", async () => {
  const a = mk();
  let lentA;
  assert.throws(() => a.use(b => { lentA = b; throw new Error("boom"); }), /boom/);
  assert.ok(lentA.every(x => x === 0));

  const b = mk();
  let lentB, seenInside;
  const r = await b.use(async buf => { lentB = buf; await new Promise(res => setTimeout(res, 5)); seenInside = buf.toString("utf8"); return 7; });
  assert.equal(r, 7);
  assert.equal(seenInside, PLAIN, "the bytes stay whole until the async fn finishes");
  assert.ok(lentB.every(x => x === 0));

  const c = mk();
  let lentC;
  await assert.rejects(c.use(async buf => { lentC = buf; throw new Error("late"); }), /late/);
  assert.ok(lentC.every(x => x === 0));
});

test("wipe() and wipeAll() zero-fill an unused Secret; only Buffers are taken", () => {
  const buf = Buffer.from(PLAIN, "utf8");
  const s = new Secret(buf);
  wipeAll(s, null, undefined);
  assert.ok(buf.every(x => x === 0));
  assert.equal(s.live, false);
  s.wipe(); // twice is fine
  assert.throws(() => new Secret(PLAIN), /needs a Buffer/);
});
