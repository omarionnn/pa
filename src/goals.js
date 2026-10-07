// "I'm job searching." — and then an offer to keep looking.
//
// The use-case card this is built from, word for word, because it is the spec and not an
// illustration:
//
//   "It offers to keep helping"
//     Omari:  "i'm job searching"
//     Reason: "what kinds of jobs? i can set up a daily or weekly search for u"
//     Omari:  "product roles, nyc or remote, mid-level"
//     Reason: "got it. daily at 9, only ones that actually match. sound right?"
//     Omari:  "yeah"
//     Reason: "done. every morning 9am."
//
// Four things make that exchange different from an assistant that answers once and forgets:
//
//   IT NOTICES.      A goal is mentioned in passing, inside a message about something else, and it
//                    is a goal rather than a task: it lasts weeks and nothing finishes it. The
//                    noticing is the MODEL's — there is no pattern matching over anything anybody
//                    said in this file or anywhere near it — and `goal_note` is where its read gets
//                    written down.
//   IT ASKS ONCE.    Criteria are merged, never replaced, and `missing()` is read off what is
//                    already there. Somebody who said "product roles in nyc" is asked about the
//                    level and nothing else, and never asked about the city again.
//   IT CONFIRMS.     Nothing starts until the criteria, the cadence and the delivery have all been
//                    said back and agreed. That is three facts on a row and `start()` refuses
//                    without them, because a standing search nobody confirmed is a thing that
//                    starts texting somebody listings they never asked for.
//   IT TAKES A NO.   An offer turned down is never pitched again. Not on a later sweep, not when
//                    they mention the same thing in passing a fortnight later, not reworded. That
//                    is `offer()`'s first refusal and the single most important line in the file:
//                    the difference between an assistant and a salesman is whether no means no.
//
// What this file is and is not:
//
//   It is NOT a scheduler. The looking is a SERIES (src/series.js): one goal, one series, and every
//   firing is an ordinary timer. So the fire path, the three tries, the collapse of three shut-laptop
//   Mondays into one, pause, resume and stop all work on a goal's search without knowing this file
//   exists. A second scheduler here would be a second set of bugs about daylight saving.
//
//   It is NOT the thing that decides to speak. An offer goes out on a turn THEY started — it rides
//   along on a reply they are already reading, so it interrupts nobody and costs nothing. Anything
//   unprompted still goes through src/notice.js and its budget, untouched.
//
//   It does NOT invent matches. `filterMatches` writes down what the model found with a real source
//   against each one, and hands back only the ones never seen before. Which listings are any good
//   is the model's to judge; that the same flat is never shown twice is code's.
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import * as series from "./series.js";
import { clock, config, stamp } from "./config.js";

/**
 * Where a goal can be.
 *
 * `noticed` is written down and nothing offered. `offered` is pitched and waiting. `declined` is
 * the end of the pitching and not the end of the goal — they may still talk about it, and Reason
 * still helps when asked; it just never offers the standing version again. `running` has a series
 * behind it. `done` is them getting the thing, which is the outcome, and `dropped` is them letting
 * it go, which is also fine.
 */
export const STATES = ["noticed", "offered", "declined", "running", "paused", "done", "dropped"];

/** The states where there is still something standing to pause, change or stop. */
export const LIVE = new Set(["running", "paused"]);

/**
 * The three things a standing search needs before it may start, as questions rather than fields.
 *
 * Not a form. The point of naming them is the opposite: each one is a thing they may ALREADY have
 * said, and `missing()` is what stops them being asked for something they just gave. A goal where
 * all three are known gets one confirm line and nothing else.
 */
export const NEEDED = {
  criteria: "what counts as a match — the kinds of jobs, the area, the budget, in their words",
  cadence: "how often: daily, weekly, every couple of days",
  delivery: "what arrives: every match, only the good ones, a page once a week",
};

/** How many goals one person may have a live search on at once. */
const liveCap = () => Number(config.maxGoals ?? 5);

// ---------- what is written down ----------

export function criteriaOf(goal) {
  try {
    const got = JSON.parse(goal?.criteria || "{}");
    return got && typeof got === "object" && !Array.isArray(got) ? got : {};
  } catch { return {}; }
}

/**
 * What is still unknown about a goal, as the names of the three things above.
 *
 * Read off the row, never off the conversation, which is the whole reason it is here: by the time
 * somebody answers the third question the turn that asked the first one is forty trimmed messages
 * back, and a model working from the thread would ask about the city again.
 */
export function missing(goal) {
  const out = [];
  if (!Object.keys(criteriaOf(goal)).length) out.push("criteria");
  if (!String(goal?.cadence ?? "").trim()) out.push("cadence");
  if (!String(goal?.delivery ?? "").trim()) out.push("delivery");
  return out;
}

/** One goal as the model and the ledger see it. Their words and real times, never row internals. */
export function view(goal) {
  if (!goal) return null;
  const standing = goal.series_id ? db.seriesById(goal.series_id) : null;
  const counts = db.countGoalMatches(goal.id);
  const gaps = missing(goal);
  return {
    goal_id: goal.id,
    what: goal.what,
    their_words: goal.said || null,
    state: goal.state,
    standing_help: goal.help || null,
    criteria: criteriaOf(goal),
    criteria_confirmed: !!goal.criteria_confirmed_at,
    cadence: goal.cadence || null,
    delivery: goal.delivery || null,
    still_missing: gaps.length ? gaps.map(k => ({ what: k, ask: NEEDED[k] })) : [],
    ...(standing ? { series_id: standing.id, schedule: series.view(standing).schedule, next: series.view(standing).next } : {}),
    found_so_far: counts.found,
    told_them_about: counts.sent,
    offers_made: goal.offers,
    ...(goal.offer_said ? { last_offer: goal.offer_said } : {}),
    ...(goal.declined_at ? { declined: stamp(goal.declined_at), their_no: goal.declined_said || null } : {}),
    ...(goal.ended_at ? { ended: stamp(goal.ended_at), ended_why: goal.ended_why || null } : {}),
    noticed: stamp(goal.created_at),
  };
}

// ---------- noticing one ----------

/**
 * Write a goal down, and say whether the standing help may be offered right now.
 *
 * The verbatim sentence is required, for the same reason it is required everywhere else in Reason
 * that a row has to hold for weeks: it is the only thing that can later show this was their goal
 * and not Reason's idea of one. `may_offer` is code's answer and not a suggestion — `offer()`
 * enforces it — so the model is told now rather than being refused in a second round trip.
 */
export function note({ conversationId, what, said, help = "", now = clock.now() }) {
  const subject = String(what ?? "").trim();
  if (!subject) {
    return { ok: false, error: `Say what the goal is in \`what\`, short and in their terms: "job searching", "finding a 1-bed in brooklyn".` };
  }
  const verbatim = String(said ?? "").trim();
  if (!verbatim) {
    return {
      ok: false, error: `\`said\` is required and must be their own words, word for word. A goal is only ever something`
        + ` THEY said they are doing — never one you worked out from their calendar, their mail or what you think they`
        + ` would want — and that sentence is what the row rests on.`,
    };
  }
  const before = db.goalByKey(conversationId, subject);
  const goal = db.saveGoal(conversationId, { what: subject, said: verbatim, help, at: now });
  const can = mayOffer({ conversationId, goal, now });
  return {
    ok: true,
    goal: view(goal),
    already_knew: !!before,
    may_offer: can.ok,
    ...(can.ok ? {} : { why_not: can.why }),
    say: can.ok
      ? `Offer the standing help in ONE line they can answer in a word, and ask only for what is in still_missing —`
        + ` ${missing(goal).map(k => NEEDED[k]).join("; ") || "nothing, so just say the shape back and ask if it is right"}.`
        + ` "what kinds of jobs? i can set up a daily or weekly search for u" is the shape: the offer and the one`
        + ` question in the same breath. Then call goal_offer with the line you sent.`
      : `Do NOT offer anything. ${can.why} Answer what they actually said and leave the goal alone.`,
    note: `Written down, so it survives this conversation. Nothing is running until goal_start, and nothing starts`
      + ` until they have confirmed all three of criteria, cadence and delivery.`,
  };
}

/**
 * May the standing help be pitched for this goal, right now?
 *
 * Four noes, and each one is a thing a model cannot be trusted to remember over weeks because the
 * evidence for it is no longer in the thread:
 *
 *   1. They said no. Forever, and this is the one that matters.
 *   2. It has already been pitched and they have not said anything since. Asking again is asking
 *      twice, and the second ask is the one that makes somebody stop reading.
 *   3. It is already running or paused — there is nothing to offer, it exists.
 *   4. They got the thing, or let it go.
 */
export function mayOffer({ conversationId, goal, now = clock.now() }) {
  if (!goal) return { ok: false, why: "There is no such goal." };
  if (goal.state === "declined") {
    return {
      ok: false, declined: true,
      why: `They already turned this offer down${goal.declined_said ? ` ("${goal.declined_said}")` : ""}`
        + ` on ${stamp(goal.declined_at)}. That answer stands: never pitch it again, not reworded and not later.`
        + ` If THEY bring the standing version up themselves, goal_reopen is how it comes back — their words, not yours.`,
    };
  }
  if (LIVE.has(goal.state)) {
    return { ok: false, why: `There is already a standing search for this one (${goal.state}). Nothing to offer — it exists.` };
  }
  if (goal.state === "done" || goal.state === "dropped") {
    return { ok: false, why: `That goal is ${goal.state}${goal.ended_why ? ` (${goal.ended_why})` : ""}, so there is nothing to offer for it.` };
  }
  if (goal.offers > 0) {
    const since = db.lastInboundAt(conversationId);
    if (since <= Number(goal.offered_at ?? 0)) {
      return {
        ok: false, why: `You already offered this on ${stamp(goal.offered_at)} ("${goal.offer_said}") and they have not said`
          + ` anything since. One offer, then it waits for them — a second one is asking twice.`,
      };
    }
  }
  void now;
  return { ok: true };
}

/**
 * Record that the offer went out, with the line that went.
 *
 * It does not SEND anything: an offer rides along on the reply being written this turn, which is
 * why there is no budget here and no gate. What this does is spend the one pitch, so that the next
 * turn — and the sweep three days from now — both know it has been asked.
 */
export function offer({ conversationId, goalId, line, now = clock.now() }) {
  const goal = db.goalById(conversationId, goalId);
  if (!goal) return { ok: false, error: `There is no goal #${goalId} in this conversation.` };
  const said = String(line ?? "").trim();
  if (!said) return { ok: false, error: `Pass the line you are sending in \`line\`, as you are sending it. It goes on the record.` };
  const can = mayOffer({ conversationId, goal, now });
  if (!can.ok) return { ok: false, status: can.declined ? "declined" : "not_now", error: can.why };

  const after = db.markGoalOffered(conversationId, goalId, { said, at: now });
  const gaps = missing(after);
  return {
    ok: true, goal: view(after), still_missing: gaps,
    note: `Offered once. If they say no, goal_declined — and then it is never offered again.`
      + (gaps.length
        ? ` When they answer with any of ${gaps.join(", ")}, write it down with goal_criteria so they are never asked twice.`
        : ` Everything is known, so their yes is all that is left: confirm it in one line and then goal_start.`),
  };
}

/**
 * Their no, and it is final.
 *
 * Kept with their words rather than as a flag, because in two months the only honest answer to
 * "why aren't you doing the job thing" is the sentence they said. Nothing about the goal itself is
 * thrown away: they may still ask for help with it any time, and Reason still gives it.
 */
export function declined({ conversationId, goalId, said, now = clock.now() }) {
  const goal = db.goalById(conversationId, goalId);
  if (!goal) return { ok: false, error: `There is no goal #${goalId} in this conversation.` };
  const verbatim = String(said ?? "").trim();
  if (!verbatim) return { ok: false, error: `\`said\` is required: their own words turning it down, word for word.` };
  const stopped = goal.series_id ? series.end({ conversationId, seriesId: goal.series_id, why: "they turned the standing help down" }) : null;
  const after = db.markGoalDeclined(conversationId, goalId, { said: verbatim, at: now });
  return {
    ok: true, goal: view(after), their_words: verbatim,
    ...(stopped?.ok ? { stopped_the_search: true } : {}),
    say: `One short line that takes it well and moves on. No "are you sure", no "just so you know I could", no second`
      + ` version of the same offer. Then answer whatever else they said.`,
    note: `This is permanent as far as you are concerned: the standing help for this goal is never offered again, by you,`
      + ` on any later turn or sweep. They can still ask for it, and if they do, goal_reopen.`,
  };
}

/**
 * They changed their mind, in their own words.
 *
 * The only way out of `declined`, and it needs their sentence, because the single thing this
 * feature must never do is talk itself back into an offer somebody refused. A model that could
 * reopen a goal on its own judgement would make the no meaningless.
 */
export function reopen({ conversationId, goalId, said, now = clock.now() }) {
  const goal = db.goalById(conversationId, goalId);
  if (!goal) return { ok: false, error: `There is no goal #${goalId} in this conversation.` };
  const verbatim = String(said ?? "").trim();
  if (!verbatim) {
    return {
      ok: false, error: `\`said\` is required: the words THEY used asking for it. A goal they turned down comes back only`
        + ` because they brought it up — never because you decided enough time had passed.`,
    };
  }
  if (goal.state !== "declined") {
    return { ok: false, error: `Goal #${goalId} is '${goal.state}', not declined, so there is nothing to reopen.` };
  }
  const r = db.setGoalState(conversationId, goalId, "noticed", { at: now });
  if (!r.ok) return r;
  db.saveGoal(conversationId, { what: goal.what, said: verbatim, at: now });
  return {
    ok: true, goal: view(db.goalById(conversationId, goalId)), their_words: verbatim,
    note: `Back open because they asked. The offers count stays as it is, so this is not a fresh start for the pitching:`
      + ` ask what is still missing and get on with it.`,
  };
}

// ---------- the criteria ----------

/**
 * What counts as a match, merged into what is already known.
 *
 * Merged and not replaced, which is the mechanism behind "ask only what is missing": every answer
 * adds, nothing is lost, and a criterion they change is changed rather than re-asked. A change also
 * CLEARS the confirmation — a yes to "product roles in nyc" was not a yes to "product roles
 * anywhere" — so a changed criterion gets one short confirm line before the search goes on.
 */
export function setCriteria({ conversationId, goalId, criteria, confirmed = false, now = clock.now() }) {
  const goal = db.goalById(conversationId, goalId);
  if (!goal) return { ok: false, error: `There is no goal #${goalId} in this conversation.` };
  const given = criteria && typeof criteria === "object" && !Array.isArray(criteria) ? criteria : null;
  if (!given || !Object.keys(given).length) {
    return {
      ok: false, error: `Pass \`criteria\` as an object of what they said, in their own terms —`
        + ` { role: "product", where: "nyc or remote", level: "mid" }. Keys are yours to pick; use theirs.`,
    };
  }
  const was = criteriaOf(goal);
  const changing = Object.entries(given).some(([k, v]) => k in was && String(was[k]) !== String(v));
  const after = db.setGoalCriteria(conversationId, goalId, given, {
    // Confirmed only when they really said yes to this wording. A change unconfirms, deliberately.
    confirmed: confirmed ? now : (changing ? null : undefined),
    at: now,
  });
  const gaps = missing(after);
  return {
    ok: true, goal: view(after), changed: changing, still_missing: gaps,
    say: gaps.length
      ? `Ask for ONE of what is left — ${gaps.map(k => NEEDED[k]).join("; ")} — in one short line. Never a list of`
        + ` questions, and never anything they have already told you.`
      : changing && !confirmed
        ? `Everything is known and they have just changed something, so say the new shape back in ONE line and ask if`
          + ` that is right. Their old yes does not cover the new wording.`
        : confirmed
          ? `Confirmed. If there is no search yet, goal_start now; if there is one, say in one line what changed and leave it running.`
          : `Everything is known. Say the whole shape back in ONE line and ask if it is right, then goal_start on their yes.`,
    note: changing
      ? `That changed something they had already given, so the confirmation is cleared and a new one is needed.`
        + ` Anything already found stays found: they are never shown the same thing twice.`
      : `Merged into what was already there, so they are never asked for any of it again.`,
  };
}

/** How often and in what shape. Both plain words, because both get said back to them. */
export function setDelivery({ conversationId, goalId, cadence = undefined, delivery = undefined, now = clock.now() }) {
  const goal = db.goalById(conversationId, goalId);
  if (!goal) return { ok: false, error: `There is no goal #${goalId} in this conversation.` };
  if (cadence === undefined && delivery === undefined) {
    return { ok: false, error: `Nothing to set. Pass cadence, delivery, or both.` };
  }
  const after = db.setGoalDelivery(conversationId, goalId, { cadence, delivery, at: now });
  return { ok: true, goal: view(after), still_missing: missing(after) };
}

// ---------- starting it ----------

/**
 * Turn the standing help on, which means making the series that does the looking.
 *
 * The three refusals here are the feature's whole safety: nothing starts without confirmed
 * criteria, without a cadence, and without them knowing what will arrive. A standing search that
 * began on an inference is an assistant that starts texting somebody job listings on Tuesday
 * because of something they said on Friday.
 */
export function start({ conversationId, goalId, repeat, now = clock.now() }) {
  const goal = db.goalById(conversationId, goalId);
  if (!goal) return { ok: false, error: `There is no goal #${goalId} in this conversation.` };
  if (goal.state === "declined") {
    return {
      ok: false, status: "declined",
      error: `They turned this offer down${goal.declined_said ? ` ("${goal.declined_said}")` : ""}. Nothing starts on a no.`,
    };
  }
  if (goal.state === "running") {
    return { ok: false, status: "already_running", goal: view(goal), error: `There is already a search running for this one.` };
  }
  const gaps = missing(goal);
  // The cadence is about to be set from `repeat`, so it is not missing if one was passed.
  const unresolved = gaps.filter(k => !(k === "cadence" && repeat));
  if (unresolved.length) {
    return {
      ok: false, status: "not_confirmed", still_missing: unresolved,
      error: `Nothing starts until all three are settled and this one is still short of ${unresolved.join(" and ")}.`
        + ` Ask for ${unresolved.map(k => NEEDED[k]).join("; ")} — one short line, one question — and write the answer`
        + ` down (goal_criteria for the criteria, goal_delivery for the rest).`,
    };
  }
  if (!goal.criteria_confirmed_at) {
    return {
      ok: false, status: "not_confirmed",
      error: `The criteria have not been confirmed with them. Say the whole shape back in ONE line — what counts as a`
        + ` match, how often, and what will arrive — and start it on their yes (goal_criteria with confirmed true).`
        + ` A standing search nobody agreed to is the thing this refusal exists to stop.`,
    };
  }
  const running = db.listGoals(conversationId, { states: ["running"] }).length;
  if (liveCap() > 0 && running >= liveCap()) {
    return {
      ok: false, status: "too_many",
      error: `They already have ${running} standing search${running === 1 ? "" : "es"} running, which is the limit (REASON_MAX_GOALS=${liveCap()}).`
        + ` Do not start another quietly: show them what is running (goal_list) and ask which to stop.`,
    };
  }

  const made = series.start({
    conversationId,
    what: `${goal.what} — the standing search${goal.delivery ? ` (${goal.delivery})` : ""}`,
    repeat, now,
  });
  if (!made.ok) return made;

  db.attachGoalSeries(conversationId, goalId, made.series.series_id, { at: now });
  db.setGoalDelivery(conversationId, goalId, { cadence: made.series.schedule, at: now });
  db.setGoalState(conversationId, goalId, "running", { at: now });
  const after = db.goalById(conversationId, goalId);
  return {
    ok: true, goal: view(after), schedule: made.series.schedule, first: made.first,
    say: `ONE line, with the schedule in their words and what it is about: "done — ${made.series.schedule}, only the ones`
      + ` that actually match". Not the rule, not how it works, not a list of the criteria back at them.`,
    note: `It is a standing check-in now, so pausing, changing and stopping all work on it. Every firing hands you the`
      + ` criteria and everything already sent, and goal_found is the only way a match goes over — it refuses anything`
      + ` they have already been shown.`,
  };
}

// ---------- pause, change, stop ----------

/**
 * Hold it, start it again, or stop it — and all three have to be cheap.
 *
 * "Pause the job thing", "stop sending me flats", "i got the job" are not the same sentence and
 * code does not try to tell them apart: the model reads which one they mean and this does exactly
 * that. What code guarantees is that the series really stops rather than the row merely saying so.
 */
export function setState({ conversationId, goalId, state, why = "", now = clock.now() }) {
  const goal = db.goalById(conversationId, goalId);
  if (!goal) return { ok: false, error: `There is no goal #${goalId} in this conversation.` };
  if (!["running", "paused", "done", "dropped"].includes(state)) {
    return { ok: false, error: `'${state}' is not one of running, paused, done, dropped.` };
  }
  let standing = null;
  if (goal.series_id) {
    if (state === "paused") standing = series.pause({ conversationId, seriesId: goal.series_id });
    else if (state === "running") standing = series.resume({ conversationId, seriesId: goal.series_id, now });
    else standing = series.end({ conversationId, seriesId: goal.series_id, why: why || `the goal is ${state}` });
  }
  if (state === "running" && !goal.series_id) {
    return { ok: false, error: `There is no search to start again for #${goalId} — it has never been started. goal_start does that.` };
  }
  const r = db.setGoalState(conversationId, goalId, state, { why, at: now });
  if (!r.ok) return r;
  // Stopped for good: the series is finished, so the row must not keep pointing at it as though
  // resuming were on the table.
  if (state === "done" || state === "dropped") db.attachGoalSeries(conversationId, goalId, null, { at: now });
  const after = db.goalById(conversationId, goalId);
  const counts = db.countGoalMatches(goalId);
  return {
    ok: true, goal: view(after),
    ...(standing ? { search: standing.ok ? "stopped" : standing.error } : {}),
    say: state === "paused"
      ? `One short line: it is on hold and nothing comes until they say. No "are you sure".`
      : state === "running"
        ? `One short line that it is back on, with the schedule.`
        : state === "done"
          ? `One short line, warm, about them getting the thing${counts.sent ? "" : ""} — and that you have stopped looking. No post-mortem.`
          : `One short line that you have stopped looking, no argument and no "are you sure".`,
    note: state === "done" || state === "dropped"
      ? `The search is ended, not paused: nothing comes round again. What was already found stays written down, so`
        + ` "what did you send me" is still answerable.`
      : `Nothing is deleted. Everything already found stays found, so when it comes back they are not shown it again.`,
  };
}

// ---------- what it found ----------

/**
 * The matches the model found this firing, filtered down to the ones never seen before.
 *
 * This is the deduplication, and it is here rather than in the prompt for the reason every other
 * durable fact in Reason is in a table: a weekly search runs for two months, and by the eighth
 * firing the first seven are gone from the conversation entirely. A model asked to remember what it
 * sent would start sending the same flat again, and the person would stop reading.
 *
 * Each match needs a `key` that is the identity of the THING — a listing id, a posting URL — and a
 * `source` saying where it came from, because a match with no source is a match nobody can check.
 */
export function filterMatches({ conversationId, goalId, matches, now = clock.now() }) {
  const goal = db.goalById(conversationId, goalId);
  if (!goal) return { ok: false, error: `There is no goal #${goalId} in this conversation.` };
  if (!LIVE.has(goal.state)) {
    return { ok: false, error: `Goal #${goalId} is '${goal.state}', so nothing is being looked for and nothing goes over.` };
  }
  const given = Array.isArray(matches) ? matches : [];
  if (!given.length) {
    return {
      ok: true, fresh: [], already_sent: 0, nothing_new: true,
      say: `Nothing new. On a standing search that is the ordinary answer and it is not a failure — reply with exactly`
        + ` NO_REPLY rather than texting them to say you looked. A line whose only content is that you checked is the`
        + ` thing that makes somebody turn this off.`,
    };
  }

  const fresh = [];
  const seen = [];
  for (const m of given) {
    const key = String(m?.key ?? m?.url ?? "").trim();
    if (!key) continue;
    const source = String(m?.source ?? "").trim();
    if (!source) {
      return {
        ok: false, error: `Every match needs a \`source\` — the site or the page it came off. A listing with no source is`
          + ` one nobody can check, and it is how a search starts reporting things that were never there.`,
      };
    }
    const row = db.recordGoalMatch(conversationId, goalId, {
      matchKey: key, title: m?.title ?? "", url: m?.url ?? "", detail: m?.detail ?? "", source, at: now,
    });
    if (row.fresh) fresh.push({ id: row.id, key: row.match_key, title: row.title, url: row.url, detail: row.detail, source: row.source });
    else seen.push(row.match_key);
  }

  if (!fresh.length) {
    return {
      ok: true, fresh: [], already_sent: seen.length, nothing_new: true,
      say: `Every one of those has been shown to them before, so there is nothing new. Reply with exactly NO_REPLY —`
        + ` never send the same listing twice, and never send a line saying you found nothing.`,
    };
  }
  db.markGoalMatchesSent(goalId, fresh.map(f => f.id), { at: now });
  return {
    ok: true, fresh, already_sent: seen.length,
    ...(seen.length ? { skipped_as_seen: seen.slice(0, 10) } : {}),
    say: `${fresh.length} new one${fresh.length === 1 ? "" : "s"}. Say them in the shape they asked for (${goal.delivery || "short, in the thread"}):`
      + ` the pick first with why it fits what they said, then the rest briefly. More than three, or anything with a`
      + ` comparison in it, goes on a page with the headline in the text.`
      + ` Only what is in \`fresh\` goes over — the rest they have already seen.`,
    note: `Written down as sent, so they are never shown any of these again. If you reply NO_REPLY now they are still`
      + ` marked seen, so say the line.`,
  };
}

// ---------- the turn a firing runs ----------

/**
 * The extra lines a goal's standing search carries when its series fires.
 *
 * Read off the row at fire time, like the series' own frame and for the same reason: the criteria
 * may have changed since this occurrence was scheduled, and a note written last Monday would have
 * Reason searching for last Monday's brief.
 */
export function checkFrame(goal, { now = clock.now() } = {}) {
  if (!goal) return "";
  const criteria = criteriaOf(goal);
  const counts = db.countGoalMatches(goal.id);
  const recent = db.goalMatches(goal.id, { limit: 8, sentOnly: true });
  void now;
  return `\n\nThis firing is the standing search for a goal of theirs: ${goal.what}.`
    + ` They said: "${goal.said}".`
    + `\n\nWhat counts as a match, in their own words and confirmed by them: ${JSON.stringify(criteria)}.`
    + ` What they asked to receive: ${goal.delivery || "not stated"}.`
    + `\n\nSo go and LOOK — this is a real search, not a line about having looked. Use research or web_lookup against the`
    + ` criteria above, and judge each thing you find against them honestly: something that misses one of their`
    + ` constraints is not a match, and sending it anyway is how a standing search becomes noise.`
    + (counts.sent
      ? `\n\nThey have already been sent ${counts.sent} of these. The most recent:\n`
        + recent.map(r => `- ${r.title || r.match_key}${r.url ? ` (${r.url})` : ""}`).join("\n")
        + `\nNever any of those again, and nothing like a repeat of them.`
      : `\n\nNothing has been sent for this one yet, so this is the first lot.`)
    + `\n\nEverything you find goes through goal_found, which hands back only the ones they have never seen — the`
    + ` deduplication is code's and not yours to keep track of. Say ONLY what it returns as fresh.`
    + `\n\nAnd if there is nothing new, say nothing: reply with exactly NO_REPLY. A standing search that texts "nothing`
    + ` today" every morning is the thing people mute. Silence is the ordinary answer and it is not a failure.`;
}

/** The one line the thread keeps for a firing, in place of the frame. */
export function checkKept(goal) {
  if (!goal) return "";
  return `[standing search] the search for ${goal.what} came round and you went and looked. What you sent, if anything,`
    + ` is your next line.`;
}

// ---------- what rides along on every turn they start ----------

/**
 * Their goals, on every turn they start, so a goal can be used without being announced.
 *
 * Here for the same reason src/commitment.js has its note: the thread is trimmed, and "any luck
 * with the flats?" three weeks after they mentioned moving reaches a model that cannot see there is
 * an apartment hunt to answer about. Which of them the moment touches is the model's call.
 *
 * The declined ones are in here ON PURPOSE, and they are the most important rows in the note: the
 * only way "never pitch a declined offer again" can hold in three weeks is if the no is in front of
 * the model at the moment it would otherwise be tempted.
 *
 * Turn-only, like the commitment note: it is true of now, and a copy of it in the history would go
 * on describing criteria they have since changed.
 */
export function goalNote(conversationId, { now = clock.now(), limit = 6 } = {}) {
  const rows = db.listGoals(conversationId, { states: ["noticed", "offered", "declined", "running", "paused"] }).slice(0, limit);
  if (!rows.length) return "";
  const who = accounts.ownerOf(conversationId).name;
  const live = rows.filter(g => g.state !== "declined").map(g => {
    const standing = g.series_id ? db.seriesById(g.series_id) : null;
    const counts = db.countGoalMatches(g.id);
    return {
      goal_id: g.id, what: g.what, their_words: g.said, state: g.state,
      criteria: criteriaOf(g), criteria_confirmed: !!g.criteria_confirmed_at,
      cadence: g.cadence || null, delivery: g.delivery || null,
      still_missing: missing(g),
      ...(standing ? { schedule: series.view(standing).schedule, next: series.view(standing).next } : {}),
      sent_so_far: counts.sent,
      offers_made: g.offers,
      ...(g.offers ? { last_offer: g.offer_said } : {}),
    };
  });
  const no = rows.filter(g => g.state === "declined")
    .map(g => ({ goal_id: g.id, what: g.what, their_no: g.declined_said, when: stamp(g.declined_at) }));
  void now;
  return `things ${who} is trying to do, and where the standing help for each stands: ${JSON.stringify(live)}.`
    + ` Part of the moment, not a list to read out. When what they just said touches one — they mention the search, they`
    + ` answer one of your questions about it, they tell you something that narrows it, they want it paused or`
    + ` stopped — use it, against that goal_id.`
    + `\n\nAnything in still_missing is the ONLY thing to ask about, one question at a time, and anything already in`
    + ` criteria is never asked for again. A goal with nothing missing and criteria_confirmed false needs one confirm`
    + ` line and then goal_start; with it true and no schedule, goal_start now.`
    + (no.length
      ? `\n\nAnd these they turned DOWN: ${JSON.stringify(no)}. Never offer the standing version of any of those again —`
        + ` not reworded, not because time has passed, not because this moment seems like a good one. Help with the thing`
        + ` whenever they ask; never pitch the repeat. If THEY ask for it, goal_reopen with their words.`
      : "");
}

/** What `goal_list` answers with, read off the rows. */
export function listView(conversationId, { includeFinished = false } = {}) {
  const states = includeFinished ? null : ["noticed", "offered", "declined", "running", "paused"];
  return db.listGoals(conversationId, { states }).map(view);
}
