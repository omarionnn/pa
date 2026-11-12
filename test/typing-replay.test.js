// The replay harness (scripts/typing-replay.mjs) that REASON_TYPING_AWARE is judged with before it
// is switched on: real arrival timelines through each hold policy. These pin what it counts, on
// timelines small enough to check by hand. No real data is in the repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, simulate, run, verdict, POLICIES } from "../scripts/typing-replay.mjs";

const S = "sendblue";
/** texts at `ins` (ms), each reply created and sent `work` after its turn would have started at a 1.0 s pause. */
const conv = (ins, outs) => ({ c: "x", in: ins.map(t => [t, S]), out: outs.map(([created, sent]) => [created, sent, S]) });
const fixed = (holdMs) => ({ kind: "fixed", holdMs });
const typing = (o) => ({ kind: "typing", fallbackMs: 1_000, graceMs: 300, sendGate: true, signals: null, ...o });
const sig = (delayMs) => ({ onsetMs: 1_000, delayMs, late: false });

test("a follow-up is a burst only when nothing was sent in between; a text with no neighbour within 60 s is lone", () => {
  const p = prepare({ conversations: [conv([0, 5_000, 200_000, 230_000], [[11_000, 11_000], [215_000, 215_000], [245_000, 245_000]])] });
  const t = p.convs[0].texts;
  assert.deepEqual(t.map(x => x.follow), [null, "strict", null, "loose"]);
  assert.deepEqual(t.map(x => x.lone), [false, false, false, false]);
  assert.equal(t[0].work, 10_000, "sent at 11 s, less the 1 s pause in force");
  const lone = prepare({ conversations: [conv([0, 300_000], [[9_000, 9_000], [309_000, 309_000]])] });
  assert.deepEqual(lone.convs[0].texts.map(x => x.lone), [true, true]);
});

test("a later bubble of an earlier reply, still going out, is not the answer to the next text", () => {
  const p = prepare({ conversations: [conv([0, 200_000], [[10_000, 10_000], [10_000, 200_500], [220_000, 220_000]])] });
  assert.equal(p.convs[0].texts[1].work, 19_000, "measured to the reply created after it");
});

test("held, folded, split: a second text inside the pause, during the turn, and after the reply", () => {
  const texts = (gap) => prepare({ conversations: [conv([0, gap], [[11_000 + gap, 11_000 + gap]])] }).convs[0].texts.map(x => ({ ...x, work: 10_000 }));
  assert.equal(simulate(texts(600), fixed(1_000)).held.strict, 1);
  assert.equal(simulate(texts(600), fixed(300)).folded.strict, 1, "0.3 s: no longer held, folded mid-turn");
  assert.equal(simulate(texts(5_000), fixed(1_000)).folded.strict, 1);
  // 10.6 s after the first text: today's reply goes at 11.0 s, the 0.3 s one went at 10.3 s.
  assert.equal(simulate(texts(10_600), fixed(1_000)).folded.strict, 1);
  assert.equal(simulate(texts(10_600), fixed(300)).split.strict, 1, "the burst the shorter pause loses");
});

test("typing-aware with no signals is the fixed pause exactly", () => {
  const data = { conversations: [conv([0, 600, 9_000, 100_000, 110_600, 300_000], [[12_000, 12_000], [111_000, 111_000], [320_000, 320_000]])] };
  const p = prepare(data);
  const a = run(p, fixed(1_000)), b = run(p, typing({}));
  for (const k of ["held", "folded", "split"]) assert.deepEqual(b[k], a[k]);
  assert.deepEqual(b.loneWait, a.loneWait);
  assert.equal(verdict(b, a), "same");
});

test("typing-aware with signals: the turn starts early, and the send is held for a burst the 0.3 s pause loses", () => {
  const texts = prepare({ conversations: [conv([0, 10_600], [[21_600, 21_600]])] }).convs[0].texts.map(x => ({ ...x, work: 10_000 }));
  for (const d of [300, 1_000, 2_000]) {
    const r = simulate(texts, typing({ signals: sig(d) }));
    assert.equal(r.folded.strict, 1, `signal ${d} ms late: held at the send, folded`);
    assert.equal(r.split.strict, 0);
  }
  assert.equal(simulate(texts, typing({ fallbackMs: 0, sendGate: false, signals: sig(1_000) })).split.strict, 1, "as first pushed: lost");
  // A lone text: 300 ms instead of 1000.
  const lone = prepare({ conversations: [conv([0], [[11_000, 11_000]])] });
  assert.deepEqual(run(lone, typing({ signals: sig(1_000) })).loneWait, [300]);
  assert.deepEqual(run(lone, fixed(1_000)).loneWait, [1_000]);
});

test("a turn quicker than a signal can arrive gives its head start back at the send", () => {
  // The reply is ready 0.8 s after the turn starts; the next text lands 1.5 s after the first.
  const texts = prepare({ conversations: [conv([0, 1_500], [[3_000, 3_000]])] }).convs[0].texts.map(x => ({ ...x, work: 800 }));
  assert.equal(simulate(texts, fixed(1_000)).folded.strict, 1, "today: sent at 1.8 s, so the 1.5 s text is folded");
  assert.equal(simulate(texts, fixed(300)).split.strict, 1, "0.3 s: sent at 1.1 s");
  assert.equal(simulate(texts, typing({ signals: sig(2_000) })).split.strict, 0, "typing-aware: sent no sooner than today");
  assert.equal(simulate(texts, typing({ signals: sig(2_000), floor: false })).split.strict, 1, "without the floor it would be");
});

test("a text that never comes: the wait ends at the cap and is counted", () => {
  // Typing from 1 s after the first text; the next text arrives 40 s later, long after the cap.
  const texts = prepare({ conversations: [conv([0, 40_000], [[60_000, 60_000]])] }).convs[0].texts.map(x => ({ ...x, work: 5_000 }));
  const r = simulate(texts, typing({ signals: sig(300) }));
  assert.equal(r.caps, 1);
  assert.ok(r.capWait[0] <= 15_000);
});

test("the policy list has today first, the 0.3 s pause, and typing-aware at every signal delay and with signals missing", () => {
  assert.deepEqual(POLICIES[0], { name: "today: fixed 1.0 s", kind: "fixed", holdMs: 1_000 });
  assert.equal(POLICIES[1].holdMs, 300);
  const now = POLICIES.filter(p => p.kind === "typing" && p.sendGate);
  assert.ok(now.some(p => p.signals === null));
  for (const d of [300, 1_000, 2_000]) for (const g of [0, 300]) assert.ok(now.some(p => p.signals?.delayMs === d && p.graceMs === g));
});
