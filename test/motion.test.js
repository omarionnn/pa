// Reason Web's spring (src/pages/motion.js, apple-motion skill): it settles on its target, a new
// target mid-flight keeps the speed it had (so a second tap turns it round rather than restarting),
// reduced motion jumps straight to the end, and the page's copy is the same function.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { createSpring, SPRING_JS } from "../src/pages/motion.js";

// A stand-in clock: frames run only when the test asks, 1/60 s apart.
let queue = [], now = 0, reduce = false;
beforeEach(() => {
  queue = []; now = 0; reduce = false;
  globalThis.requestAnimationFrame = (f) => { queue.push(f); return queue.length; };
  globalThis.cancelAnimationFrame = () => { queue = []; };
  globalThis.performance = { now: () => now };
  globalThis.matchMedia = (q) => ({ matches: reduce && q.includes("reduce") });
});
const frames = (n) => { for (let i = 0; i < n && queue.length; i++) { now += 1000 / 60; const q = queue; queue = []; q.forEach(f => f(now)); } };

test("it settles exactly on its target, without overshoot at damping ratio 1, and says so once", () => {
  const seen = []; let rests = 0;
  const s = createSpring(0, v => seen.push(v), { onRest: () => rests++ });
  s.to(100);
  frames(120);
  assert.equal(s.value, 100);
  assert.equal(s.velocity, 0);
  assert.equal(queue.length, 0, "no frame left running");
  assert.equal(rests, 1);
  assert.ok(Math.max(...seen) <= 100, "critically damped: never passes the target");
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], "moves one way only");
  assert.ok(seen.length > 10 && seen.length < 60, `about half a second (${seen.length} frames)`);
});

test("retargeted mid-flight it keeps its speed and turns round from where it is", () => {
  const s = createSpring(0, () => {});
  s.to(100);
  frames(6);
  const at = s.value, speed = s.velocity;
  assert.ok(at > 0 && at < 100 && speed > 0);
  s.to(0); // a second tap
  assert.equal(s.value, at, "no jump");
  assert.equal(s.velocity, speed, "speed carried over, not reset to rest");
  frames(1);
  assert.ok(s.value > at, "still carried forward for a moment, like something held in the hand");
  frames(200);
  assert.equal(s.value, 0);
});

test("reduced motion jumps straight to the end, no frames", () => {
  reduce = true;
  const seen = []; let rests = 0;
  const s = createSpring(0, v => seen.push(v), { onRest: () => rests++ });
  s.to(1);
  assert.deepEqual(seen, [1]);
  assert.equal(queue.length, 0);
  assert.equal(rests, 1);
});

test("set() jumps with no motion and stops a spring in flight", () => {
  const seen = [];
  const s = createSpring(0, v => seen.push(v));
  s.to(50); frames(3);
  s.set(10);
  assert.equal(s.value, 10); assert.equal(s.target, 10); assert.equal(s.velocity, 0);
  assert.equal(queue.length, 0);
  assert.equal(seen.at(-1), 10);
});

test("a 0–1 value settles to its precision, not the pixel default", () => {
  const s = createSpring(0, () => {}, { precision: 0.001 });
  s.to(1); frames(3);
  assert.ok(s.value < 0.9, "still moving after three frames");
  frames(200);
  assert.equal(s.value, 1);
});

test("a first frame stamped before to() was called doesn't run it backwards", () => {
  const s = createSpring(0, () => {});
  now = 1000; s.to(100);
  const q = queue; queue = []; q.forEach(f => f(990)); // rAF's time is the frame's start, which can precede to()
  assert.ok(s.value >= 0);
});

test("a stalled tab doesn't fling it: one long frame counts as 1/30 s", () => {
  const s = createSpring(0, () => {});
  s.to(100);
  now += 5000; // the tab slept
  const q = queue; queue = []; q.forEach(f => f(now));
  assert.ok(s.value > 0 && s.value < 100);
});

test("the page gets the same function as window.reasonSpring, defined once", () => {
  const win = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, performance: globalThis.performance, matchMedia: globalThis.matchMedia, Math };
  win.window = win;
  runInNewContext(SPRING_JS, win);
  assert.equal(typeof win.reasonSpring, "function");
  const first = win.reasonSpring;
  runInNewContext(SPRING_JS, win);
  assert.equal(win.reasonSpring, first, "a second Web page swapped in keeps the first copy");
  let v = 0; const s = win.reasonSpring(0, x => { v = x; });
  s.to(5); frames(120);
  assert.equal(v, 5);
});
