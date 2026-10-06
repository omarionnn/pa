// What a piece of handed-over work looks like when he opens the link on his phone.
//
// Built by code rather than by the model, on purpose. A status page's value is that it is the same
// page every time: the state is always in the same place, the thing waiting on him is always above
// the thing that does not need him, and the commit hashes are always folded away. A layout
// re-decided by a model on each update is a layout that drifts, and the one update where it decides
// to lead with the test counts is the update he needed to read in ten seconds.
//
// The order is the whole design, and it is an order of consequence, not of chronology:
//
//   1. where it is          one badge, one line, no jargon
//   2. what you have to do  only if something is actually waiting on him
//   3. what you asked for   his own words back, so he can tell whether he was understood
//   4. what this changes    in words about him, not about the repository
//   5. how it went          the steps, newest last, so the shape of it is visible
//   6. the detail           folded shut: commits, tests, files, session keys
//
// Nothing below writes markup. Every block is data that src/pages/content.js checks and
// src/pages/render.js escapes, which is what makes it safe to put text an assistant session wrote
// onto a page at all.
import { stamp, clock } from "./config.js";

export const OVERVIEW_TITLE = "What I've got building";

/** The badge state for a job state. Two vocabularies, one map, so neither drifts. */
const BADGE = {
  working: "working",
  needs_you: "waiting",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

export function jobTitle(job) {
  return String(job.title || "Something I'm building").slice(0, 120);
}

/** "4 minutes ago", for somebody reading a phone. Absolute times go in the technical section. */
export function ago(ms, now = clock.now()) {
  const mins = Math.max(0, Math.round((now - ms) / 60_000));
  if (mins < 1) return "just now";
  if (mins === 1) return "a minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  if (h === 1) return "an hour ago";
  if (h < 24) return `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/**
 * The blocks for one job's page.
 *
 * `options` are the taps to offer when the thing waiting on him is a plain question. A risky action
 * deliberately gets NO taps: that yes goes through the confirm gate, which reads his own words in
 * his own thread, and a button on a web page is not his words. The page says so rather than
 * offering a button that would not count.
 */
export function jobBlocks(job, events = [], { options = [] } = {}) {
  const blocks = [];
  const badge = BADGE[job.state] ?? "queued";

  // ---- 1. where it is ----
  blocks.push({
    type: "status",
    state: badge,
    headline: job.headline || defaultHeadline(job),
    detail: stateDetail(job),
  });

  // ---- 2. what has to come from him ----
  if (job.state === "needs_you") {
    blocks.push({ type: "section", title: job.risky_action ? "It needs your yes" : "It needs an answer" });
    if (job.risky_action) {
      blocks.push({
        type: "text",
        text: `It wants to do this, and it has not done it:\n\n${job.risky_action}`
          + (job.question && job.question !== job.risky_action ? `\n\nWhy: ${job.question}` : ""),
      });
      blocks.push({
        type: "text",
        text: `Answer in your messages, not here. I'll have texted you the same words — reply yes or no to that text`
          + ` and nothing happens until you do. A button on a web page isn't your answer, so there isn't one.`,
      });
    } else {
      blocks.push({ type: "text", text: job.question || "It asked something and didn't say what. Text me and I'll chase it." });
      if (options.length >= 2) {
        blocks.push({ type: "choice", key: `job${job.id}`, question: job.question || "Which way?", options });
      } else {
        blocks.push({ type: "text", text: `Reply to my text with your answer and I'll carry it straight back to it.` });
      }
    }
  }

  // ---- 3. his own words ----
  blocks.push({ type: "section", title: "What you asked for" });
  blocks.push({ type: "text", text: quoteOf(job.asked) });

  // ---- 4. what it means for him ----
  //
  // Skipped when it would only say the headline again. A short "done" note becomes the headline
  // verbatim, and a phone screen carrying the same sentence twice under two different titles reads
  // as padding — it makes the reader wonder which one they are meant to act on. The section earns
  // its place when the outcome is longer than the badge had room for, or when the job is still
  // going and the last few steps are worth more than one line.
  const outcome = events.filter(e => ["done", "failed"].includes(e.kind)).at(-1);
  const progress = events.filter(e => e.kind === "progress");
  const body = outcome ? outcome.note : progress.slice(-3).map(p => p.note).join("\n\n");
  if (body && body.trim() !== String(job.headline ?? "").trim()) {
    blocks.push({ type: "section", title: job.finished ? "What this changes" : "Where it's got to" });
    blocks.push({ type: "text", text: body });
  }

  // ---- 4b. what it was told about him ----
  //
  // Shown on the page, not folded into the technical section, and on purpose. He said to share what
  // Reason knows; the deal that makes that fair is that he sees exactly what went, in the same place
  // he reads everything else about the job. Folding it away would technically be "shown" and would
  // mean he found out by going looking, which is the opposite of the point.
  if (job.about_him) {
    blocks.push({ type: "section", title: "What I told them about you" });
    blocks.push({ type: "text", text: job.about_him });
    blocks.push({
      type: "text",
      text: `That's all of it — nothing about you went over that isn't written here. If any of it`
        + ` shouldn't have, tell me and I'll keep it back next time.`,
    });
  }

  // ---- 5. how it went ----
  const steps = timelineFrom(job, events);
  if (steps.length > 1) {
    blocks.push({ type: "section", title: "How it went" });
    blocks.push({ type: "timeline", items: steps });
  }

  // ---- 6. the part nobody has to read ----
  blocks.push({ type: "details", title: "Technical detail", text: technical(job, events) });
  return blocks;
}

/** A headline for a job that has not been given one. Never optimistic. */
function defaultHeadline(job) {
  switch (job.state) {
    case "working": return "handed over, nothing back yet";
    case "needs_you": return "waiting on you";
    case "done": return "finished";
    case "failed": return "it broke";
    default: return "stopped";
  }
}

/** The second line under the badge: when, and the one thing the badge does not say. */
function stateDetail(job) {
  const started = `Handed over ${ago(job.created_at)}.`;
  switch (job.state) {
    case "working":
      return `${started} It's on turn ${job.turns}. I'll text you when something changes — you don't have to watch this.`;
    case "needs_you":
      return `${started} Nothing is moving until you answer.`;
    case "done":
      return `${started} Finished ${job.finished_at ? ago(job.finished_at) : "just now"}. This is what it said it did, which is not the same as me having checked it myself.`;
    case "failed":
      return `${started} It stopped ${job.finished_at ? ago(job.finished_at) : "just now"} without finishing.`;
    default:
      return `${started} You stopped this one.`;
  }
}

/** His words, indented as a quote, with nothing added and nothing tidied. */
function quoteOf(asked) {
  const t = String(asked ?? "").trim();
  return t ? t.split("\n").map(l => `“${l}”`).join("\n") : "(nothing written down — ask me and I'll say where this came from)";
}

/**
 * The steps, as a timeline. Only the kinds a person would call a step: what was handed over, what
 * moved, what it is waiting on, how it ended. `detail` lines and the assistant's own closing words
 * are not steps — those are in the technical section and in the state line respectively.
 */
function timelineFrom(job, events) {
  const items = [{ label: "You asked for it", state: "done", at: ago(job.created_at) }];
  for (const e of events) {
    if (e.kind === "detail" || e.kind === "said") continue;
    const state = e.kind === "failed" ? "failed"
      : e.kind === "question" || e.kind === "risky" ? "waiting"
        : e.kind === "done" ? "done"
          : "done";
    const label = e.kind === "handover" ? "Handed to the assistant on this machine"
      : e.kind === "question" ? "Asked you something"
        : e.kind === "risky" ? "Asked for your yes"
          : e.kind === "answer" ? "You answered"
            : e.kind === "done" ? "It said it was finished"
              : e.kind === "failed" ? "It stopped" : e.note.slice(0, 90);
    // A step's note is dropped when the section above already carries that sentence word for word.
    // How it ended is said once, at the top, where somebody reading a phone looks first; repeating
    // it as the last line of the timeline is the third time on one screen.
    const note = ["progress"].includes(e.kind) ? null : e.note.slice(0, 500);
    const saidAbove = note && (note.trim() === String(job.headline ?? "").trim()
      // How it ended is already the headline above, in full. A step that restates its own label
      // ("Handed to the assistant on this machine" / "Handed over to the assistant on this
      // machine") is a line that costs a reader a line and tells them nothing.
      || ["done", "failed", "handover"].includes(e.kind));
    items.push({ label, state, at: ago(e.at), note: saidAbove ? null : note });
  }
  if (job.state === "working") {
    items.push({ label: "Still going", state: "now", at: null, note: "I'll text you the moment this changes." });
  }
  return items.slice(-24);
}

/** Commits, tests, paths, the session it is in. Folded shut, and complete rather than tidy. */
function technical(job, events) {
  const details = events.filter(e => e.kind === "detail");
  const said = events.filter(e => e.kind === "said").at(-1);
  const lines = [
    `job #${job.id} · ${job.state} · turn ${job.turns}`,
    `session ${job.session_key}`,
    `started ${stamp(job.created_at)}`,
    job.finished_at ? `ended ${stamp(job.finished_at)}` : `last change ${stamp(job.updated_at)}`,
    ``,
    `what it was handed:`,
    job.brief || "(nothing)",
  ];
  if (details.length) {
    lines.push(``, `what it recorded:`);
    for (const d of details) lines.push(`${stamp(d.at)} — ${d.note}${d.detail ? `\n${d.detail}` : ""}`);
  }
  if (said) lines.push(``, `the last thing it said:`, said.note);
  const errors = events.filter(e => e.kind === "failed" && e.detail);
  for (const e of errors) lines.push(``, `error:`, e.detail);
  return lines.join("\n").slice(0, 7900);
}

// ---------- the one page that lists everything ----------

/**
 * Everything in flight, in one place, with a link into each.
 *
 * Ordered by whether he has to do something, not by when it started: the whole reason he opens this
 * page is to find out whether anything is waiting on him, so that is the first row and the headline
 * answers it before he reads anything else.
 *
 * One list, not a list and a table. The first draft had both — a three-column table and the links
 * underneath — and at phone width the table broke the title one word per line ("Say / pong / in a
 * file") while repeating the state and the time the links already carried. So the links are the
 * list: they say the same three things, they do not wrap, and each row is a tap target the width of
 * the screen rather than the width of a word. The table is kept only for the case the links cannot
 * cover — no reachable address for a page — where a row of text still beats nothing.
 */
export function overviewBlocks(jobs, { urlFor = null } = {}) {
  const rank = { needs_you: 0, working: 1, failed: 2, done: 3, stopped: 4 };
  const sorted = [...jobs].sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || b.updated_at - a.updated_at);
  const waiting = sorted.filter(j => j.state === "needs_you");
  const live = sorted.filter(j => j.state === "working");

  // The badge answers "is anything waiting on me" before anything is read. Note the last case:
  // with nothing handed over at all the badge is grey, not green. A green DONE over "nothing
  // building right now" reads as something having just succeeded, and the one thing this page must
  // never do is look like news when there is none.
  const blocks = [{
    type: "status",
    state: waiting.length ? "waiting" : live.length ? "working" : sorted.length ? "done" : "queued",
    headline: waiting.length
      ? `${waiting.length} ${waiting.length === 1 ? "thing needs" : "things need"} your answer`
      : live.length
        ? `${live.length} ${live.length === 1 ? "thing is" : "things are"} building`
        : sorted.length
          ? `all caught up — nothing building`
          : "nothing building right now",
    detail: sorted.length
      ? `${sorted.length} ${sorted.length === 1 ? "piece" : "pieces"} of work in total. Updated ${ago(clock.now())}.`
      : `Text me what to build and it'll show up here.`,
  }];

  if (!sorted.length) return blocks;

  const where = (j) => (BADGE[j.state] === "waiting" ? "needs you" : BADGE[j.state] ?? j.state);

  // One row per job, in order, built from the page id by whoever called this — only they know what
  // a reachable address looks like here. The note is where it is and when it last moved, which is
  // everything the table said.
  const items = sorted
    .map(j => {
      const url = urlFor ? urlFor(j) : null;
      return url ? { label: jobTitle(j), url, note: `${where(j)} · ${ago(j.updated_at)}${j.headline ? ` · ${j.headline}` : ""}` } : null;
    })
    .filter(Boolean);

  if (items.length) {
    blocks.push({ type: "links", title: sorted.length === 1 ? "Open it" : "Open one", items });
  } else {
    // No reachable address for any of them. A table is worse than a tappable list and better than
    // being told nothing, so he at least gets to see what is going on and can ask for the one he
    // wants. Two columns, not three: the third wrapped the title at phone width.
    blocks.push({
      type: "table",
      title: "Everything",
      columns: ["What", "Where it is"],
      rows: sorted.map(j => [jobTitle(j), `${where(j)} · ${ago(j.updated_at)}`]),
    });
    blocks.push({
      type: "text",
      text: `Each of these has its own page with the detail on it — ask me for the one you want and I'll send the link.`,
    });
  }

  blocks.push({
    type: "details",
    title: "Technical detail",
    text: sorted.map(j => `#${j.id} ${j.state} · turn ${j.turns} · ${j.session_key} · page ${j.page_id ?? "(none)"} · ${stamp(j.updated_at)}`).join("\n").slice(0, 7900),
  });
  return blocks;
}
