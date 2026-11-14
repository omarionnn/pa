// A call's instructions as ranked sections, fitted inside a size limit by priority, never by a blind cut.
//
// Call 115 (2026-11-14): the Cartesia agent's per-call instructions came to about 18k characters and
// were cut at the end to fit 12k (./cartesia.js `VARIABLE_MAX`). The cut fell before the pre-call brief
// began, so the voice had no note of the call six minutes earlier and told him it only knew this call.
//
// Each section has a rank: 0 is never cut (the honesty rules, who it is, the passphrase rules), then the
// earlier-calls notes, then what was sent since, then everything else. When the whole is too long, the
// least important sections are trimmed a line at a time (from the end, or from the start for a section
// that runs oldest first) or dropped; the text keeps its own order. Pure: no I/O.

/**
 * One section: `{ name, rank, lines, head?, keep?, from? }`.
 *   lines  the section's lines, in the order they are shown
 *   head   how many leading lines are its heading (gone only with the whole section)
 *   keep   how many lines after the heading may never be trimmed (the section is then never dropped)
 *   from   "end" (default) or "start": which end loses lines first
 */
export function section(name, rank, lines, opts = {}) {
  return { name, rank, lines: (Array.isArray(lines) ? lines : [lines]).map(l => String(l ?? "")).filter(l => l.trim()), ...opts };
}

const sizeOf = (secs) => {
  let n = 0, any = false;
  for (const s of secs) for (const l of s.lines) { n += l.length + (any ? 1 : 0); any = true; }
  return n;
};

/**
 * Fit sections inside `max` characters (joined by "\n"). Returns `{ text, size, kept, trimmed, dropped }`:
 * kept as `name:chars`, trimmed as `name:-lines`, dropped as names. Rank 0 is never touched, even past `max`.
 */
export function fitSections(sections, max) {
  const secs = (sections ?? []).filter(s => s && s.lines?.length).map(s => ({ ...s, lines: [...s.lines], cut: 0 }));
  const order = secs.map((s, i) => [s, i]).filter(([s]) => Number(s.rank) > 0).sort((a, b) => b[0].rank - a[0].rank || b[1] - a[1]);
  for (const [s] of order) {
    if (sizeOf(secs) <= max) break;
    const head = Math.min(s.head ?? 0, s.lines.length);
    const keep = s.keep ?? 0;
    while (sizeOf(secs) > max && s.lines.length - head > keep) {
      if (s.from === "start") s.lines.splice(head, 1); else s.lines.pop();
      s.cut += 1;
    }
    // Still too long with nothing left it must keep, or nothing left under its heading: the whole section goes.
    if ((sizeOf(secs) > max && keep === 0) || (s.cut && s.lines.length === head)) { s.cut += s.lines.length; s.lines = []; }
  }
  const live = secs.filter(s => s.lines.length);
  return {
    text: live.map(s => s.lines.join("\n")).join("\n"),
    size: sizeOf(live),
    kept: live.map(s => `${s.name}:${s.lines.join("\n").length}`),
    trimmed: secs.filter(s => s.cut && s.lines.length).map(s => `${s.name}:-${s.cut}`),
    dropped: secs.filter(s => !s.lines.length).map(s => s.name),
  };
}

/** Every section's text joined, in order, uncut (GPT-Live: no limit is applied there). */
export function joinSections(sections) {
  return (sections ?? []).filter(s => s?.lines?.length).map(s => s.lines.join("\n")).join("\n");
}
