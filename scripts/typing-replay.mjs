// Replay real arrival timelines through reply-hold policies (REASON_TYPING_AWARE, docs/typing-aware.md).
//
//   ssh <live> 'python3 -' < scripts/typing-replay-extract.py > /tmp/timelines.json   (read-only; timing only)
//   node scripts/typing-replay.mjs /tmp/timelines.json [--real-hold=1000]
//
// The input holds no words and no addresses: per conversation (a salted hash), when each text
// arrived and when each outbound message was created and sent, in ms from that conversation's
// first text. Typing signals are not in it (none were ever received), so they are SIMULATED from
// the arrivals: before a follow-up text the person is typing from `onset` after the previous text
// (or only for the last 6 s, "late") until the follow-up, and the event reaches us `delay` later.
//
// A loose follow-up (below) gets no simulated typing: see signalFor.
//
// What is counted, per policy:
//   follow-ups   a text within 60 s of the one before it. "strict": Reason had sent nothing in
//                between (it cannot be an answer to a reply); "loose": something had been sent.
//                Words are not read, so every one is counted as if it continued or corrected the
//                text before it. That is the worst case for a faster policy.
//   held         joined before the turn started.  folded: landed while the turn ran (the mid-turn
//                read folds it into the same reply).  split: the reply had already been SENT.
//   lone wait    for a text with no neighbour within 60 s: how long before its turn starts, plus
//                any wait at the send.
//   caps         turns that waited out the 15 s / 30 s cap for a text that did not come in time.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SIGNAL_ALLOW_MS = 3_000;
export const FOLLOW_MS = 60_000, CAP_MS = 15_000, TOTAL_CAP_MS = 30_000, TTL_MS = 30_000, BURST_MAX_MS = 10_000;
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** Timelines → texts with a turn length and a label each. `realHoldMs` is the pause that was in force. */
export function prepare(data, { realHoldMs = 1_000, channel = "sendblue" } = {}) {
  const convs = [];
  const known = [];
  for (const c of data.conversations) {
    const ins = c.in.filter(x => x[1] === channel).map(x => x[0]).sort((a, b) => a - b);
    // [created, sent]. A reply to a text was CREATED after it: a later bubble of an earlier reply,
    // still going out when the next text lands, is not an answer to that text.
    const outs = c.out.filter(x => x[2] === channel).map(x => [x[0], x[1]]).sort((a, b) => a[1] - b[1]);
    if (!ins.length) continue;
    const firstSentAfter = (t) => outs.find(o => o[0] > t)?.[1] ?? null;
    const texts = ins.map((t, i) => {
      const r = firstSentAfter(t);
      const work = r != null && r - t < 10 * 60_000 ? Math.max(800, r - t - realHoldMs) : null;
      if (work != null) known.push(work);
      const gap = i ? t - ins[i - 1] : Infinity;
      const next = i + 1 < ins.length ? ins[i + 1] - t : Infinity;
      const between = i ? outs.some(o => o[0] > ins[i - 1] && o[1] <= t) : false;
      return { t, work, gap, follow: gap <= FOLLOW_MS ? (between ? "loose" : "strict") : null, lone: gap > FOLLOW_MS && next > FOLLOW_MS };
    });
    convs.push({ texts });
  }
  const typical = q(known, 0.5) ?? 10_000;
  for (const c of convs) for (const x of c.texts) if (x.work == null) x.work = typical;
  return { convs, medianWorkMs: typical };
}

/** The simulated typing-on event for text i: when it reaches us, or null. Its source time is after text i-1. */
function signalFor(texts, i, sig) {
  if (!sig) return null;
  const x = texts[i];
  let began;
  // Only before a STRICT follow-up is the person taken to be typing since the text before it. A
  // loose one was written after reading a reply, so under any policy that changes when the reply
  // goes its timing would change too: it is replayed as it happened and kept out of the verdict.
  if (x.follow === "strict") {
    const prev = texts[i - 1].t;
    began = prev + Math.min(sig.onsetMs, x.gap / 2);
    if (sig.late) began = Math.max(began, x.t - 6_000);
  } else began = x.t - 4_000;
  return began + sig.delayMs;
}

/**
 * One conversation under one policy.
 *   { kind: "fixed", holdMs }
 *   { kind: "typing", fallbackMs, graceMs, sendGate, signals: null | { onsetMs, delayMs, late } }
 * `fallbackMs` is the pause when no typing event was heard from them in the last 30 s (0 = start at once).
 */
export function simulate(texts, policy) {
  const out = { held: { strict: 0, loose: 0 }, folded: { strict: 0, loose: 0 }, split: { strict: 0, loose: 0 }, loneWait: [], caps: 0, capWait: [], turns: 0 };
  const sig = policy.kind === "typing" ? policy.signals : null;
  const arrivals = texts.map((_, i) => signalFor(texts, i, sig));
  const flowing = (now) => arrivals.some(a => a != null && a <= now && now - a < TTL_MS);
  const mark = (j, how) => { const f = texts[j].follow; if (f) out[how][f]++; };
  let i = 0;
  while (i < texts.length) {
    const first = i;
    let m = i;                       // newest text the turn holds
    let start, capped = false;
    const joinUntil = (when) => { let joined = false; while (m + 1 < texts.length && texts[m + 1].t <= when) { m++; mark(m, "held"); joined = true; } return joined; };
    if (policy.kind === "fixed") {
      for (;;) { start = Math.min(texts[m].t + policy.holdMs, texts[first].t + BURST_MAX_MS); if (!joinUntil(start)) break; }
    } else {
      for (;;) {
        const now = texts[m].t;
        if (!flowing(now)) {       // nothing heard: the fixed pause (or none), exactly as a fixed policy
          start = Math.min(now + policy.fallbackMs, texts[first].t + BURST_MAX_MS);
          if (joinUntil(start)) continue;
          if (!flowing(start)) break;
        }
        // Heard typing lately: is a "typing" for the NEXT text here within the short window?
        const a = m + 1 < texts.length ? arrivals[m + 1] : null;
        const window = Math.max(start ?? now, now + policy.graceMs);
        const typingNext = a != null && texts[m + 1].follow === "strict" && a <= window;
        if (!typingNext) { start = window; if (joinUntil(start)) { start = undefined; continue; } break; }
        const cap = Math.min(now + CAP_MS, texts[first].t + TOTAL_CAP_MS, a + TTL_MS);
        if (texts[m + 1].t <= cap) { m++; mark(m, "held"); start = undefined; continue; }
        start = cap; out.caps++; out.capWait.push(cap - now); capped = true;
        break;
      }
    }
    let end = start + texts[first].work;
    let gateSpent = 0;
    // The send floor: a turn that started early (events flowing) and is ready before a "typing"
    // has had time to arrive sends no sooner than the fixed pause would have, up to SIGNAL_ALLOW.
    if (policy.kind === "typing" && policy.sendGate && policy.floor !== false) {
      const early = policy.fallbackMs - (start - texts[m].t);
      if (early > 0) end = Math.max(end, Math.min(end + early, texts[m].t + SIGNAL_ALLOW_MS));
    }
    for (;;) {
      while (m + 1 < texts.length && texts[m + 1].t <= end) { m++; mark(m, "folded"); }
      if (!(policy.kind === "typing" && policy.sendGate) || capped) break;
      const a = m + 1 < texts.length ? arrivals[m + 1] : null;
      if (!(a != null && texts[m + 1].follow === "strict" && a <= end && end - a < TTL_MS)) break;
      const cap = Math.min(end + Math.min(CAP_MS, TOTAL_CAP_MS - gateSpent), a + TTL_MS);
      if (texts[m + 1].t <= cap) {
        gateSpent += texts[m + 1].t - end;
        m++; mark(m, "folded");
        end = texts[m].t + 3_000;    // the one recompose with their new words
        if (gateSpent >= TOTAL_CAP_MS) break;
        continue;
      }
      out.caps++; out.capWait.push(cap - end); gateSpent += cap - end; end = cap;
      break;
    }
    out.turns++;
    if (m === first && texts[first].lone) out.loneWait.push(end - texts[first].t - texts[first].work);
    i = m + 1;
    if (i < texts.length) mark(i, "split");
  }
  return out;
}

/** Every conversation under one policy, summed. */
export function run(prepared, policy) {
  const sum = { held: { strict: 0, loose: 0 }, folded: { strict: 0, loose: 0 }, split: { strict: 0, loose: 0 }, loneWait: [], caps: 0, capWait: [], turns: 0 };
  for (const c of prepared.convs) {
    const r = simulate(c.texts, policy);
    for (const k of ["held", "folded", "split"]) for (const f of ["strict", "loose"]) sum[k][f] += r[k][f];
    sum.loneWait.push(...r.loneWait); sum.capWait.push(...r.capWait); sum.caps += r.caps; sum.turns += r.turns;
  }
  return { ...sum, loneMedian: q(sum.loneWait, 0.5), loneP90: q(sum.loneWait, 0.9), lones: sum.loneWait.length };
}

const typing = (name, o) => ({ name, kind: "typing", fallbackMs: 1_000, graceMs: 300, sendGate: true, signals: null, ...o });
const S = (delayMs, late = false) => ({ onsetMs: 1_000, delayMs, late });
export const POLICIES = [
  { name: "today: fixed 1.0 s", kind: "fixed", holdMs: 1_000 },
  { name: "fixed 0.3 s (other open change)", kind: "fixed", holdMs: 300 },
  typing("typing-aware AS FIRST PUSHED, signals missing", { fallbackMs: 0, sendGate: false }),
  typing("  \" signals 0.3 s late", { fallbackMs: 0, sendGate: false, signals: S(300) }),
  typing("  \" signals 1 s late", { fallbackMs: 0, sendGate: false, signals: S(1_000) }),
  typing("  \" signals 2 s late", { fallbackMs: 0, sendGate: false, signals: S(2_000) }),
  typing("typing-aware NOW, signals missing"),
  typing("  \" signals 0.3 s late, 300 ms window", { signals: S(300) }),
  typing("  \" signals 1 s late, 300 ms window", { signals: S(1_000) }),
  typing("  \" signals 2 s late, 300 ms window", { signals: S(2_000) }),
  typing("  \" signals 0.3 s late, no window", { graceMs: 0, signals: S(300) }),
  typing("  \" signals 1 s late, no window", { graceMs: 0, signals: S(1_000) }),
  typing("  \" signals 2 s late, no window", { graceMs: 0, signals: S(2_000) }),
  typing("  \" signals 1 s late, 1000 ms window", { graceMs: 1_000, signals: S(1_000) }),
  typing("  \" typing only in the last 6 s, 1 s late, 300 ms window", { signals: S(1_000, true) }),
];

/** Against today, on replies sent on the first half: better / same / worse. */
export function verdict(r, today) {
  const a = r.split.strict, b = today.split.strict;
  return a < b ? `better (${b - a} fewer split)` : a === b ? "same" : `WORSE (+${a - b} split)`;
}

export function table(prepared) {
  const rows = POLICIES.map(p => ({ p, r: run(prepared, p) }));
  const today = rows[0].r;
  const n = (r, f) => r.held[f] + r.folded[f] + r.split[f];
  const lines = [
    `Texts: ${prepared.convs.reduce((a, c) => a + c.texts.length, 0)} in ${prepared.convs.length} conversations. Bursts (a follow-up within 60 s with nothing sent in between): ${n(today, "strict")}. Follow-ups after a reply (not counted): ${n(today, "loose")}. Lone texts: ${today.lones}. Median turn: ${prepared.medianWorkMs} ms.`,
    "",
    "| policy | bursts: held / folded / SPLIT | answered as one reply | lone text wait, median / p90 | waited to the cap | quality vs today |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const { p, r } of rows) {
    const all = n(r, "strict"), one = all - r.split.strict;
    lines.push(`| ${p.name} | ${r.held.strict} / ${r.folded.strict} / **${r.split.strict}** | ${one}/${all} (${all ? Math.round(1000 * one / all) / 10 : 0}%) | ${r.loneMedian} / ${r.loneP90} ms | ${r.caps}${r.caps ? ` (${q(r.capWait, 0.5)} ms)` : ""} | ${p === POLICIES[0] ? "—" : verdict(r, today)} |`);
  }
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node scripts/typing-replay.mjs <timelines.json> [--real-hold=1000]"); process.exit(2); }
  const realHoldMs = Number((process.argv.find(a => a.startsWith("--real-hold=")) ?? "=1000").split("=")[1]);
  console.log(table(prepare(JSON.parse(readFileSync(file, "utf8")), { realHoldMs })));
}
