// Everything Reason is working on, on one page.
//
// Four open jobs answered in a text is a wall of bubbles nobody reads to the end of, and the part
// that matters — the one question that is actually on them — is on line nine of it. So past two
// jobs the answer is a page, and the chat keeps the headline.
//
// Every block here is built from the task rows, in code. The model does not write this page: it
// asks for it. That is the whole reason it can be trusted as an answer to "what's still open" —
// a page the model composed could say a job is running when the row says it finished, and the
// person reading it has no way to tell. The only thing the model contributes is when to make it.
//
// It reads rows and nothing else: no words of theirs are interpreted here.
import { stamp } from "./config.js";
import { latestFurthest } from "./sheet.js";

/** How long a finished job stays on the page. Long enough to answer "did that ever happen?". */
export const RECENTLY_MS = 48 * 60 * 60 * 1000;

const STATE_WORDS = {
  running: "working on it",
  waiting: "waiting",
  waiting_on_you: "waiting on you",
  waiting_on_other: "waiting on someone else",
  blocked: "stuck",
};

const CLOSED_WORDS = { done: "done", failed: "couldn't do it", cancelled: "called off" };

/** The one line at the top: what is true right now, in the order it matters. */
export function headlineFor({ open, onThem, stuck }) {
  if (!open) return "Nothing open";
  const jobs = `${open} ${open === 1 ? "job" : "jobs"} open`;
  const bits = [];
  if (onThem) bits.push(`${onThem} waiting on you`);
  if (stuck) bits.push(`${stuck} stuck`);
  return bits.length ? `${jobs} · ${bits.join(" · ")}` : jobs;
}

/**
 * The page's blocks, from the rows.
 *
 * Order is the argument. What is on **them** goes first, because it is the only part of the page
 * they can act on and burying it under a progress report is how a page becomes something nobody
 * opens twice. Then a job each, in the order they were started. Then what finished recently, which
 * is what makes the page answerable for "did that ever happen" rather than only "what now".
 */
export function activityBlocks({ tasks, finished = [], holds = [], now = Date.now() }) {
  const open = tasks.filter(t => t.open);
  const onThem = open.filter(t => t.sheet.needs);
  const stuck = open.filter(t => t.state === "blocked");
  const going = holds.filter(h => h.state === "held");
  const headline = headlineFor({ open: open.length, onThem: onThem.length, stuck: stuck.length });
  // A stuck job that got somewhere is not a dead end on this page: it is one action away from done.
  // Counted here so the line at the top can say that rather than "nothing here needs anything from
  // you" over a filled checkout waiting for a tap.
  const handBacks = stuck.filter(t => latestFurthest(t.sheet)).length;

  const blocks = [{
    type: "status",
    state: open.length === 0 ? "done" : onThem.length ? "waiting" : stuck.length ? "failed" : "working",
    headline,
    detail: onThem.length
      ? "The ones marked waiting on you are the only ones that need anything from you. Everything else is mine."
        + (handBacks ? ` ${handBacks} of the stuck ones got as far as it could and is one step from done — that step is yours.` : "")
      : handBacks
        ? `${handBacks === 1 ? "One job" : `${handBacks} jobs`} got as far as ${handBacks === 1 ? "it" : "they"} could without you. Each one says what is already done and the one step left.`
        : open.length
          ? "Nothing here needs anything from you — this is just where each one has got to."
          : null,
  }];

  // Above everything, including what is waiting on them, because it is the only thing on this page
  // measured in seconds. By the time somebody has opened the page a thirty-second window is mostly
  // gone, so the seconds are a true reading of the moment it was built and the instruction next to
  // them — text "undo" — is the part that still works.
  if (going.length) {
    blocks.push({
      type: "rows",
      title: going.length === 1 ? "Going out in a moment" : `Going out in a moment (${going.length})`,
      items: going.map(h => ({
        name: h.doing || h.what,
        detail: 'text "undo" to stop it',
        value: `going out in ${Math.max(0, Math.ceil((h.due_at - now) / 1000))}s`,
      })),
    });
  }

  // And the ones they stopped, which is the other half of being able to trust the first block: a
  // page that only ever showed things going out could not answer "did that undo actually work?".
  const stopped = holds.filter(h => h.state === "stopped");
  if (stopped.length) {
    blocks.push({
      type: "rows",
      title: "Stopped before it went",
      items: stopped.slice(0, 12).map(h => ({
        name: h.doing || h.what,
        detail: h.to_whom ? `nothing went to ${h.to_whom}` : "it never happened",
        value: "stopped",
      })),
    });
  }

  if (onThem.length) {
    blocks.push({
      type: "rows",
      title: onThem.length === 1 ? "What I need from you" : `What I need from you (${onThem.length})`,
      items: onThem.map(t => ({
        name: t.sheet.needs.question,
        detail: `${t.sheet.needs.tradeoff} — for "${t.title}"`,
        value: t.sheet.needs.asked_at ? sinceWords(t.sheet.needs.asked_at, now) : null,
      })),
    });
  }

  for (const t of open) {
    const items = [];
    for (const l of t.log.filter(x => x.kind !== "state")) {
      items.push({ label: l.note, state: "done", at: stamp(l.at) });
    }
    // Where it is right now, said as its own step rather than as a label on the last thing that
    // happened — "waiting on the agent since tuesday" is the step, and it has not finished.
    if (t.state === "waiting_on_you" && t.sheet.needs) {
      items.push({ label: t.sheet.needs.question, state: "waiting", note: t.sheet.needs.tradeoff });
    }
    for (const w of t.sheet.waiting) {
      items.push({ label: `${w.on} — ${w.for}`, state: "waiting", note: w.next_check ? `checking again ${stamp(w.next_check)}` : "checking without being asked" });
    }
    if (t.sheet.blocked) {
      items.push({ label: t.sheet.blocked.what, state: "failed", note: `would need: ${t.sheet.blocked.unblock}` });
    }
    // And how far it got before it stopped, which on a stuck job is the only part they can do
    // anything with. Under the thing that stopped it, because "here is the filled form" only makes
    // sense once they know why it is still a form — and above everything else, because the one
    // action on it is the single actionable line on a stuck job.
    const point = t.state === "blocked" ? latestFurthest(t.sheet) : null;
    if (point) {
      items.push({
        label: point.what, state: "waiting",
        note: `one thing left: ${point.one_action}${point.filled.length ? ` · already filled: ${point.filled.map(f => f.field).join(", ")}` : ""}`,
      });
    }
    for (const left of t.sheet.left) items.push({ label: left, state: "plain" });
    // A job that has done nothing yet says so, rather than appearing as a title with no body. An
    // empty timeline is also refused by the content checker, so this is both honest and necessary.
    if (!items.length) items.push({ label: "nothing has happened on this one yet", state: "plain" });

    blocks.push({ type: "timeline", title: `${t.title} — ${STATE_WORDS[t.state] ?? t.state}`, items });

    // The link, as a link. A stuck job whose furthest point is a filled checkout is one tap from
    // done, and a URL written into a note is not a tap — so it gets its own block, right under the
    // timeline that says what it is. Only where there is one: a hand-back with nothing to open says
    // so in the step above instead of pointing at a page that does not exist.
    if (point?.where) {
      blocks.push({
        type: "links",
        title: `How far I got on "${t.title}"`,
        items: [{ label: point.one_action, url: point.where, note: point.filled.length ? `${point.filled.length} field(s) already filled in` : null }],
      });
    }

    // What they turned down, folded shut. It is the part of a long search nobody wants on the page
    // and everybody wants when they ask "did you already look at that one".
    const rejected = t.sheet.options.filter(o => o.status === "rejected");
    if (rejected.length) {
      blocks.push({
        type: "details",
        title: `${rejected.length} you've already ruled out on "${t.title}"`,
        text: rejected.map(o => `${o.label || o.id}${o.rejected_because?.words ? ` — you said "${o.rejected_because.words}"` : ""}`).join("\n"),
      });
    }
  }

  if (finished.length) {
    blocks.push({
      type: "rows",
      title: "Finished in the last couple of days",
      items: finished.slice(-12).map(t => ({
        name: t.title,
        detail: t.outcome || "",
        value: CLOSED_WORDS[t.state] ?? t.state,
      })),
    });
  }

  if (!open.length && !finished.length && !holds.length) {
    blocks.push({ type: "text", text: "Nothing is running. If I told you I was on something, I never actually started it." });
  }

  return {
    blocks, headline,
    counts: { open: open.length, on_them: onThem.length, stuck: stuck.length, finished: finished.length, going_out: going.length, stopped: stopped.length },
  };
}

/** "since tuesday", "since this morning" — a value small enough for the right-hand column. */
function sinceWords(at, now) {
  const mins = Math.max(0, Math.round((now - at) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
