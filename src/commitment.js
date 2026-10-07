// It notices when you skip.
//
// The use-case card this is built from, word for word, because it is the spec and not an
// illustration:
//
//   "It notices when you skip"
//   "It won't shame you. It will make going very easy."
//     Reason: "leg day. you said 7am and it's 7:10 👀"
//     Omari:  "omw"
//     Reason: "squats 4x8, rdl 3x10, lunges 3x12."
//     Reason: "you hit 185 last week. go 190."
//
// Four behaviours, and the second half is the one that is actually hard. Knowing a commitment
// existed and noticing the time went past are arithmetic. **Removing the next decision** — handing
// over the session itself so there is nothing left to work out — and **remembering last week's
// number** are what make the difference between a friend and an alarm clock. An alarm clock is what
// they already have and ignore.
//
// What this file is and is not:
//
//   It is NOT a repeating-schedule engine. Firing things on a cadence is what timers are for, and
//   recurring check-ins are their own feature. A commitment is a different shape: the point is not
//   that something happens at 7am, it is that NOTHING happening by 7:10 is the news. So there is no
//   timer behind one — the sweep reads the rows and the clock, and the absence of a log is the
//   event. See `skipsNow`.
//
//   It is NOT the thing that decides to speak. Every line goes out through src/notice.js, which owns
//   their waking window, the record of what was already said, and the one-nudge-per-thing rule.
//   What this file adds there is one exemption, argued for in `THEIR_OWN_SCHEDULE` over in that
//   file: a schedule THEY set is not a catch and does not spend the day's one unprompted text.
//
//   It does NOT read intent. "omw", "cant today", "already went", "my knee hurts", "move it to 8"
//   are all read by the model, through the tools. There is no pattern matching on anything anybody
//   said in this file or anywhere near it.
//
// And the two refusals that matter more than any of it, because this is health and a wrong tone
// here costs more than a wrong answer anywhere else:
//
//   1. **Never a number nobody logged.** The progression line is composed from rows in
//      commitment_logs and there is no other source. With no history, `lastNumbers` comes back
//      empty and the frame's instruction is to say so — "dunno what you did last time" — rather
//      than to guess at a weight. A made-up 185 is worse than no line at all: it is Reason
//      inventing their own body back at them.
//   2. **Never a push past a no.** A missed one that they have accounted for is settled and never
//      raised again. Something that hurts suppresses the plan outright — no lifts, no numbers, no
//      advice, no diagnosis, no asking about the injury. Nothing in here looks at whether a message
//      sounds like an injury or an eating disorder: the harm screen (src/harm.js) runs before every
//      turn and the health framing in src/notice.js carries into every frame, and those two decide
//      it. Code that tried to spot it would be a third opinion nobody asked for, and a worse one.
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { clock, config, stamp } from "./config.js";
import { HEALTH_RULE, NO_PERMISSION_RULE, SILENCE_RULE, localDay, settingsFor } from "./notice.js";
// The same two-pass offset lookup the calendar uses, for the same reason: "7:00 on 9 October in
// America/New_York" is a different instant in June and in December, and one pass is wrong either
// side of a daylight-saving change. One source for that, in src/google.js.
import { rfc3339 } from "./google.js";

const MIN = 60_000;

/** Sunday first, the way Date.getDay() and every Intl weekday numbering here do. */
export const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** How a session was accounted for. Only `went` is showing up; the rest are honest and final. */
export const LOG_KINDS = ["went", "missed", "hurt", "moved"];

/** The key the one-nudge-per-occurrence rule hangs on. Carries the day, so Friday is not Tuesday. */
export const skipKey = (commitment, day) => `habit:${commitment.id}:${day}`;
/** And the key for the one time it asks whether the schedule itself is wrong. */
export const wrongScheduleKey = (commitment, day) => `habit:${commitment.id}:schedule:${day}`;

// ---------- the clock ----------

/** The weekday where THEY are, 0-6 with Sunday 0. Never this machine's. */
export function weekdayIn(at, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(at));
  return SHORT.indexOf(name.toLowerCase());
}

/** Minutes after midnight as "07:00", for building a wall-clock time. */
export function clockFace(atMin) {
  const m = ((Math.round(atMin) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** The real instant a wall-clock time on a local day is, in the commitment's own stamped zone. */
export function instantOf(day, atMin, timeZone) {
  const ms = Date.parse(rfc3339(`${day}T${clockFace(atMin)}:00`, timeZone));
  return Number.isFinite(ms) ? ms : NaN;
}

/** The days of the week it falls on, as numbers, however they were stored. */
export function daysOf(commitment) {
  try {
    const got = JSON.parse(commitment?.days ?? "[]");
    return Array.isArray(got) ? got.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : [];
  } catch { return []; }
}

/** The days in their own words, for a line that says them back ("tuesdays and fridays"). */
export function daysInWords(commitment) {
  const days = daysOf(commitment);
  if (!days.length) return "";
  if (days.length === 7) return "every day";
  const names = days.map(d => `${DAY_NAMES[d]}s`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Today's occurrence, if today is one of its days.
 *
 * `dueAt` is the time they named, `graceEndsAt` is when not having shown up becomes a fact, and
 * `windowEndsAt` is when there is no longer any point saying anything at all. A log on this day
 * that moved it moves all three: "move it to 8" at ten past seven restarts the clock from eight,
 * which is the difference between answering them and nagging them ten minutes later.
 */
export function occurrenceOn(commitment, { now = clock.now(), day = null } = {}) {
  const tz = commitment.time_zone || config.tz;
  const on = day ?? localDay(now, tz);
  const weekday = weekdayIn(instantOf(on, 12 * 60, tz), tz);
  if (!daysOf(commitment).includes(weekday)) return null;
  const log = db.sessionOn(commitment.id, on);
  const atMin = log?.kind === "moved" && log.at_min !== null ? log.at_min : commitment.at_min;
  const dueAt = instantOf(on, atMin, tz);
  if (!Number.isFinite(dueAt)) return null;
  const grace = Number(commitment.grace_min ?? config.habitGraceMin);
  return {
    day: on, weekday, atMin, dueAt,
    graceEndsAt: dueAt + grace * MIN,
    windowEndsAt: dueAt + grace * MIN + config.habitWindowMin * MIN,
    moved: log?.kind === "moved",
    log: log && log.kind !== "moved" ? log : null,
  };
}

/**
 * The occurrences that have already come round, newest first.
 *
 * Walks back by local day rather than by adding weeks, because adding 7 × 24h across a
 * daylight-saving boundary lands an hour out and then on the wrong side of a 7am.
 */
export function pastOccurrences(commitment, { now = clock.now(), weeks = 8 } = {}) {
  const tz = commitment.time_zone || config.tz;
  const out = [];
  // Never before they set it. A commitment made this morning has no history of being missed, and
  // counting the Tuesdays that went by before it existed would have greeted somebody's first ever
  // leg day with "this is the third one you've missed".
  const from = Number(commitment.created_at ?? 0);
  for (let back = 0; back < weeks * 7; back++) {
    const day = localDay(now - back * 24 * 60 * MIN, tz);
    const occ = occurrenceOn(commitment, { now, day });
    if (occ && occ.dueAt <= now && occ.dueAt >= from) out.push(occ);
  }
  return out;
}

// ---------- what actually happened ----------

/** The items on a log row, which are the only numbers anything here may say. */
export function itemsOf(log) {
  try {
    const got = JSON.parse(log?.items ?? "[]");
    return Array.isArray(got) ? got.filter(x => x && typeof x === "object") : [];
  } catch { return []; }
}

/**
 * The session to hand over, and where it came from.
 *
 * The obvious source, and the one the card implies: what they did last time. A plan Reason made up
 * would be a workout written by something that has never trained them, so there is only ever one
 * answer here and it is their own last session. With no logged session there is no plan, and
 * `from` is null — which the frame turns into asking what today is rather than inventing four
 * exercises.
 */
export function sessionPlan(commitment, { logs = null } = {}) {
  const rows = logs ?? db.sessionLogs(commitment.id, { limit: 20 });
  for (const row of rows) {
    if (row.kind !== "went") continue;
    const items = itemsOf(row);
    if (items.length) return { from: row.day, items };
  }
  return { from: null, items: [] };
}

/**
 * Last week's numbers, as rows. Never a suggestion, and never arithmetic on a weight.
 *
 * What comes back is what they logged: the exercise, the weight, the sets, the reps and the day.
 * "Go 190" is the model's line to write off a real 185; what code guarantees is that there is a
 * real 185 behind it, because this is the only place a number can come from and it reads a table.
 */
export function lastNumbers(commitment, { logs = null, limit = 6 } = {}) {
  const rows = logs ?? db.sessionLogs(commitment.id, { limit: 20 });
  const seen = new Map();
  for (const row of rows) {
    if (row.kind !== "went") continue;
    for (const item of itemsOf(row)) {
      const what = String(item.what ?? "").trim();
      if (!what || seen.has(what.toLowerCase())) continue;
      if (item.weight === undefined || item.weight === null || item.weight === "") continue;
      seen.set(what.toLowerCase(), {
        what, weight: item.weight,
        ...(item.sets === undefined ? {} : { sets: item.sets }),
        ...(item.reps === undefined ? {} : { reps: item.reps }),
        on: row.day,
      });
    }
    if (seen.size >= limit) break;
  }
  return [...seen.values()].slice(0, limit);
}

/**
 * How many of its occurrences in a row they have not been to, and whether any were accounted for.
 *
 * A run of skips is the one thing that changes what Reason says rather than how loudly: three in a
 * row means the schedule is probably wrong, and asking that is a kinder and more useful thing than
 * a fourth identical nudge. `accounted` is how many of them they actually answered about, which the
 * frame needs — somebody who said "cant today" three times has told Reason something, and somebody
 * who went silent three times has told it something else.
 */
export function runOfSkips(commitment, { now = clock.now() } = {}) {
  const occs = pastOccurrences(commitment, { now });
  let missed = 0;
  let accounted = 0;
  for (const occ of occs) {
    // Today's is still in flight — they may yet go — so it is neither a miss nor a reason to stop
    // counting the ones behind it. Skipped, not broken on: breaking here would make every run read
    // as zero for as long as the current one is open, which is exactly when the count is wanted.
    if (now < occ.windowEndsAt && !occ.log) continue;
    if (occ.log?.kind === "went") break;
    missed++;
    if (occ.log) accounted++;
  }
  return { missed, accounted, of: occs.length };
}

// ---------- the pass ----------

/**
 * Every commitment with a missed occurrence worth one line right now.
 *
 * Six reasons there is nothing here, and all six are code's rather than the model's: today is not
 * one of its days; the grace window has not closed, so they are not late yet; the window HAS closed
 * for good, so the morning has gone and saying anything now is a verdict rather than a nudge; they
 * already told Reason something about this one; they moved it, and the new time has not come; or
 * they have paused it.
 *
 * `asks` is the other outcome: a run of skips, which gets the schedule question instead of a nudge.
 */
export function skipsNow({ conversationId, now = clock.now() } = {}) {
  const out = { nudges: [], asks: [], quiet: [] };
  for (const commitment of db.listCommitments(conversationId, { state: "active" })) {
    const occ = occurrenceOn(commitment, { now });
    if (!occ) { out.quiet.push({ id: commitment.id, why: "not one of its days" }); continue; }
    if (occ.log) { out.quiet.push({ id: commitment.id, why: `already settled: ${occ.log.kind}` }); continue; }
    if (now < occ.graceEndsAt) { out.quiet.push({ id: commitment.id, why: "not late yet" }); continue; }
    if (now > occ.windowEndsAt) { out.quiet.push({ id: commitment.id, why: "the window has gone" }); continue; }

    const run = runOfSkips(commitment, { now });
    const logs = db.sessionLogs(commitment.id, { limit: 20 });
    const row = {
      commitment, occurrence: occ, run,
      plan: sessionPlan(commitment, { logs }),
      numbers: lastNumbers(commitment, { logs }),
      hurtLast: logs.find(l => l.kind !== "moved")?.kind === "hurt",
    };
    // The run counts the ones already closed out, so this one makes it one more.
    if (run.missed + 1 >= config.habitRunOfSkips) out.asks.push(row);
    else out.nudges.push(row);
  }
  return out;
}

// ---------- the frames ----------

/** One logged number as a line. Facts off a row; no suggestion of what to do with it. */
function numberLine(n) {
  const reps = n.sets && n.reps ? ` ${n.sets}x${n.reps}` : n.reps ? ` x${n.reps}` : "";
  return `- ${n.what}: ${n.weight}${reps}, on ${n.on}`;
}

function planLine(item) {
  const reps = item.sets && item.reps ? ` ${item.sets}x${item.reps}` : item.reps ? ` x${item.reps}` : "";
  const weight = item.weight === undefined || item.weight === null || item.weight === "" ? "" : ` @ ${item.weight}`;
  return `- ${item.what}${reps}${weight}`;
}

/**
 * The nudge, and the two messages after it.
 *
 * Written as three things to send in one turn rather than as a question, because that is the whole
 * point of the card: the nudge on its own leaves them a decision to make, and removing the decision
 * is the help. So the frame hands over the session and the number up front and asks for all of it.
 *
 * The tone rules are stated as refusals rather than as style notes. "Never shame" is easy to agree
 * with and easy to drift from — "that's 3 this week" and "you said you'd go" are both the kind of
 * line a model writes while believing it is being encouraging.
 */
export function skipFrame({ conversationId, row, now = clock.now() }) {
  const who = accounts.ownerOf(conversationId).name;
  const { commitment, occurrence, plan, numbers, hurtLast } = row;
  const late = Math.max(1, Math.round((now - occurrence.dueAt) / MIN));
  const said = clockFace(occurrence.atMin);
  return `[they said they would, and they have not] ${who} told you: "${commitment.said || commitment.what}".`
    + ` So ${commitment.what} is on for ${daysInWords(commitment)} at ${said} their time, and it is now`
    + ` ${stamp()} — ${late} minute${late === 1 ? "" : "s"} past, with nothing from them and nothing logged.`
    + `\n\nThis is one text and then, if they are in, the session. The shape, and it is the card this`
    + ` was built from word for word:`
    + `\n  you: "${commitment.what}. you said ${said} and it's ${clockFace(occurrence.atMin + late)} 👀"`
    + `\n  them: "omw"`
    + `\n  you: the session itself — the exercises, the sets, the reps`
    // The card's fourth line is two real figures, and the shape says so — but ONLY where there are
    // figures. With nothing logged, a sample "you hit 185" sitting in the frame is a weight to copy,
    // and a model handing somebody a number nobody ever told it is the worst thing in here.
    + (numbers.length
      ? `\n  you: last week's figure and a higher one, as figures: "you hit 185 last week. go 190."`
      : `\n  you: nothing, because you have no number of theirs — see below`)
    + `\n\nWhat you may hand them, read off what they actually logged:`
    + (plan.items.length
      ? `\n\nTheir last session (${plan.from}), which IS the plan unless they say otherwise:\n${plan.items.map(planLine).join("\n")}`
      : `\n\nThere is no logged session for this yet, so you have NO plan to hand over. Do not invent one — do not name`
        + ` exercises, sets or reps you have never been told. The honest version is the nudge and then asking what`
        + ` today is, and offering to keep it so you have it next time.`)
    + (numbers.length
      ? `\n\nThe numbers they really hit. These are the only figures you may say THEY did:\n${numbers.map(numberLine).join("\n")}`
        + `\n\nThe last line is one of those and a figure above it. The card, word for word, is "you hit 185 last week.`
        + ` go 190." — so with their real figure, that is "you hit ${numbers[0].weight} last week. go …" and you finish it`
        + ` with a number. Two numbers, and the second one is yours to name — the next real step up on that lift, in`
        + ` whatever that number is counted in. "put more on the bar", "go a bit heavier", "beat it" and`
        + ` "see how it feels" are all the same failure: they hand the decision straight back, and taking the decision off`
        + ` them is the whole of what this feature is. Pick ONE exercise — the one worth beating — and say the figure.`
        + `\n\nThe figure you ask for is the only number in the text that did not come off that list, and it is clearly a`
        + ` thing to go for rather than a thing they did. Never report a weight as theirs that is not on the list, never a`
        + ` total, never a percentage, and never any number at all for an exercise with none against it — "dunno what you`
        + ` did on those" is a fine thing to say and inventing what they lifted is not.`
      : `\n\nYou have NO logged numbers for this. So there is no "you hit it last week, go a bit more" line to write, and`
        + ` you do not write one. Say plainly that you have not got last time's numbers and ask them to tell you today's,`
        + ` so you have them next week.`)
    + (hurtLast
      ? `\n\nLast time they told you something hurt. So the first thing is how that is, in one line, and nothing else:`
        + ` no plan, no number, no "ease back in". If they say they are good, then the session. If they do not, leave it.`
      : "")
    + `\n\nThe tone, and these are refusals rather than preferences:`
    + `\n  - Never shame them. Not "you said you would", not "that's twice this week", not a count of anything, not a`
      + ` streak, not disappointment, not "no excuses". They know they are late; that is why this is one line and not two.`
    + `\n  - Never ask why. "what happened?" is an interrogation at ten past seven. If they want to say, they will.`
    + `\n  - Make going EASY, which is the entire point. They should be able to read your messages and start, with`
      + ` nothing left to decide and nothing to look up.`
    + `\n  - If they say they cannot, that is the end of it: one warm line, no guilt, no re-ask, no "tomorrow then?",`
      + ` and log it. They do not owe you a session.`
    + `\n\nWhichever way it goes, log it with commitment_log so next week has something to read: went with their`
    + ` numbers if they give any, missed if they say they are not going, hurt if something hurts.`
    + `\n\nTo send this you MUST call notice_send with key "${skipKey(commitment, occurrence.day)}" first. This one is`
    + ` their own schedule rather than something you went and found, so it does not spend their day's unprompted text —`
    + ` but it is still one nudge and only one. There is no second one for this ${commitment.what}, whatever happens, so`
    + ` if you say nothing now you say nothing at all today.`
    + `\n\n${NO_PERMISSION_RULE}`
    + `\n\n${HEALTH_RULE}`
    + `\n\nAnd the one hard limit on this subject: nothing about calories, weight loss, what they eat, what they weigh or`
    + ` what their body should look like, asked for or not. No diagnosis and no advice about pain or an injury, ever —`
    + ` not a stretch, not a rest day, not "that's probably just". This is showing up for a thing they said they would`
    + ` do, and that is the whole of it.`
    + `\n\nIf this is not a moment to say anything, reply with exactly NO_REPLY. ${SILENCE_RULE}`;
}

/**
 * A run of them, which gets a question instead of a nudge.
 *
 * The honest reading of three missed Tuesdays is that 7am on a Tuesday is wrong, not that they need
 * telling a fourth time. This frame exists so that nudging harder is not even on the table: it is a
 * different question with a different tool behind it, and asking it is what stops the feature
 * turning into the thing everybody mutes.
 */
export function wrongScheduleFrame({ conversationId, row }) {
  const who = accounts.ownerOf(conversationId).name;
  const { commitment, occurrence, run } = row;
  const missed = run.missed + 1;
  return `[the schedule is probably wrong] ${who} said: "${commitment.said || commitment.what}" — ${commitment.what} on`
    + ` ${daysInWords(commitment)} at ${clockFace(commitment.at_min)}. That is now ${missed} in a row nobody went to`
    + `${run.accounted ? `, and they told you about ${run.accounted} of them` : `, with nothing said about any of them`}.`
    + `\n\nSo do NOT nudge. A fourth identical text is how something becomes the thing people mute, and ${missed} missed`
    + ` in a row is information: the time is wrong, the day is wrong, or they are done with it. Ask THAT, once, in one`
    + ` line they can answer in a few words — "${clockFace(commitment.at_min)} on ${DAY_NAMES[occurrence.weekday]}s`
    + ` isn't landing, want to move it or drop it?" is the shape.`
    + `\n\nNot a word about the ones they missed beyond that there were a few. No count at them, no streak, no "you`
    + ` haven't been since", no disappointment, and nothing about what it is doing to their progress. The question is`
    + ` about the schedule and not about them.`
    + `\n\nWhen they answer: a new day or time is commitment_set with their words; "drop it", "stop", "forget it" is`
    + ` commitment_end, which takes it off you immediately and says so once. Either answer is a good one and neither`
    + ` gets talked out of.`
    + `\n\nCall notice_send with key "${wrongScheduleKey(commitment, occurrence.day)}" first. Asked once — code will`
    + ` not ask it again for this one — so if you reply NO_REPLY it is simply not asked.`
    + `\n\n${HEALTH_RULE}`
    + `\n\nNothing about calories, weight, their body, or advice about pain. If nothing here is worth a text, reply with`
    + ` exactly NO_REPLY. ${SILENCE_RULE}`;
}

/** The one line the thread keeps for a nudge turn, in place of the frame. */
export function skipKept({ conversationId, row }) {
  const who = accounts.ownerOf(conversationId).name;
  return `[${row.commitment.what}] ${who} said ${clockFace(row.occurrence.atMin)} and it went past with nothing from them,`
    + ` so you had one nudge and their last session to hand over. What you sent, if anything, is your next line.`;
}

/**
 * What they have standing, on every turn they start.
 *
 * Here for the same reason src/kept.js exists: the thread is trimmed, and "already went, squats
 * 185x8" three weeks after they set the thing up reaches a model that cannot see there is a leg day
 * to log it against. So the commitments ride along — what they are, when they are, where today's
 * one stands, and last session's numbers — and which of them the moment touches is the model's call.
 *
 * Turn-only, like the kept note: it is true of now, and a copy of it in the history would go on
 * describing a schedule they have since changed.
 */
export function commitmentNote(conversationId, { now = clock.now(), limit = 6 } = {}) {
  const rows = db.listCommitments(conversationId, { state: "active" }).slice(0, limit);
  if (!rows.length) return "";
  const view = rows.map(c => {
    const occ = occurrenceOn(c, { now });
    const plan = sessionPlan(c);
    const numbers = lastNumbers(c, { limit: 4 });
    return {
      commitment_id: c.id, what: c.what, days: daysInWords(c), at: clockFace(c.at_min), their_zone: c.time_zone,
      today: !occ ? "not one of its days"
        : occ.log ? `already settled today: ${occ.log.kind}`
          : now < occ.dueAt ? `due today at ${clockFace(occ.atMin)}`
            : now < occ.graceEndsAt ? "due now"
              : "the time went past with nothing logged",
      ...(plan.from ? { last_session: { on: plan.from, items: plan.items } } : { last_session: null }),
      ...(numbers.length ? { their_numbers: numbers } : {}),
    };
  });
  return `things ${accounts.ownerOf(conversationId).name} has told you they do on a schedule: ${JSON.stringify(view)}.`
    + ` Part of the moment, not a list to read out. When what they just said touches one — they are heading out to`
    + ` train, they say they went, they give you a weight, they say they cannot today, they want the time moved —`
    + ` use it, and log it with commitment_log against that commitment_id.`
    + `\n\nWhen they say they are on their way or heading there ("omw", "heading out", "on it"), the reply is the WHOLE`
    + ` of last_session — every exercise on it with its sets and reps, as one short line like "squats 4x8, rdl 3x10,`
    + ` lunges 3x12." — and then last week's figure with a higher one to go for. Not the first exercise. Not a sample`
    + ` of it. Not a question. The point is that they can read it and start with nothing left to work out, and handing`
    + ` over one lift out of three leaves them exactly the decision you were supposed to remove. If last_session is null`
    + ` there is no session to hand over and you ask what today is instead, rather than inventing one.`
    + `\n\nThat last line is two figures, which is the card: "you hit 185 last week. go 190." The first comes out of`
    + ` their_numbers; the second is a figure YOU name, one real step up on that lift. "the number to beat", "beat it",`
    + ` "put more on the bar" and "see how it feels" are not that line — they give them the old number back and leave`
    + ` them to work out the new one, which is the decision this is supposed to take off them. Pick one lift and say`
    + ` the figure.`
    + `\n\nAny number you say about what they LIFTED has to be one in their_numbers; there is no other source for those`
    + ` and you never estimate, average or round one into existence. The figure you ask them for is the one number that`
    + ` is not off that list, and it is plainly a thing to go for rather than a thing they did. If nothing here touches`
    + ` what they said, ignore this note and never recite it.`;
}

/** What `commitment_list` answers with, read off the rows. */
export function listView(conversationId, { now = clock.now() } = {}) {
  const rows = db.listCommitments(conversationId, { state: null });
  return rows.map(c => {
    const occ = occurrenceOn(c, { now });
    const run = c.state === "active" ? runOfSkips(c, { now }) : null;
    const plan = sessionPlan(c);
    return {
      commitment_id: c.id, what: c.what, days: daysInWords(c), day_numbers: daysOf(c),
      at: clockFace(c.at_min), their_zone: c.time_zone, state: c.state,
      their_words: c.said, set_on: stamp(c.created_at),
      ...(c.ended_at ? { stopped: stamp(c.ended_at), why: c.ended_why } : {}),
      today: occ ? { day: occ.day, due: stamp(occ.dueAt), settled: occ.log?.kind ?? null } : null,
      ...(run && run.missed ? { missed_in_a_row: run.missed } : {}),
      last_session: plan.from ? { on: plan.from, items: plan.items } : null,
      their_numbers: lastNumbers(c, { limit: 6 }),
      recent: db.sessionLogs(c.id, { limit: 6 })
        .map(l => ({ on: l.day, kind: l.kind, ...(itemsOf(l).length ? { items: itemsOf(l) } : {}), their_words: l.said })),
    };
  });
}

// ---------- their hours, and the one hour they named themselves ----------

/** Is this instant inside the hours they said nothing unprompted may land in? */
function inTheirQuiet(at, { quietStart, quietEnd, timeZone }) {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(new Date(at)));
  return quietStart === quietEnd ? false
    : quietStart < quietEnd ? h >= quietStart && h < quietEnd
      : h >= quietStart || h < quietEnd;
}

/**
 * May a nudge about this occurrence go out right now?
 *
 * The one rule in this file that needed arguing out rather than writing down, because the card and
 * the waking window disagree. The card's own example is a 7am leg day, and the window everybody
 * starts on is 08:00-22:00 — so read strictly, the feature's acceptance spec could never fire for
 * the one person it was written for, and every 6am runner would set a commitment and silently never
 * hear from it.
 *
 * The resolution is that these two settings are answers to two different questions. "The hours I am
 * happy being texted in" is about things Reason went and FOUND — a bill, a moved meeting, something
 * it thought was worth raising. "Leg day at 7am" is them naming an hour. Somebody who says that has
 * said 7:10 is a fine time to hear about leg day, and nothing else.
 *
 * So the hour they named carries its own permission, and it is bounded hard so that it widens
 * nothing: from the time they said until an hour past the grace window, and for this commitment
 * only. Past that the ordinary window is back in force — which is what stops a 10pm commitment's
 * three-hour window turning into a text at one in the morning. And their general waking hours still
 * govern every other unprompted thing Reason has, untouched.
 *
 * `off` and a snooze are checked by the caller and are not negotiable here: a stop is a stop.
 */
export function mayNudgeNow({ conversationId, occurrence, now = clock.now(), timeZone = "" }) {
  const s = settingsFor(conversationId, { now });
  const zone = timeZone || s.timeZone;
  const hours = { quietStart: s.quietStart, quietEnd: s.quietEnd, timeZone: zone };
  if (!inTheirQuiet(now, hours)) return { ok: true, why: "inside their waking hours" };
  // Their night. The only thing that gets through is the hour they named themselves, and only for
  // as long as it is really that hour.
  const theirOwnHour = now >= occurrence.dueAt && now <= occurrence.graceEndsAt + 60 * MIN;
  if (theirOwnHour && inTheirQuiet(occurrence.dueAt, hours)) {
    return { ok: true, why: "they named this hour themselves when they set it" };
  }
  return {
    ok: false,
    why: theirOwnHour
      ? "it is their night"
      : `it is their night and ${clockFace(occurrence.atMin)} is not — the hour they named has passed`,
  };
}

/**
 * Checking a commitment against their own waking window at save time.
 *
 * Not a refusal and not a warning that nothing will happen — `mayNudgeNow` above means a 5am
 * commitment really does get its 5:10 nudge. It is the honest line about what that DOES mean: they
 * have made one exception for one thing, and everything else Reason might say still waits for
 * morning. Worth a sentence precisely because it is easy to assume otherwise either way.
 */
export function windowClash(conversationId, { atMin, graceMin = config.habitGraceMin, now = clock.now() }) {
  const s = settingsFor(conversationId, { now });
  const hour = Math.floor((((atMin % 1440) + 1440) % 1440) / 60);
  const quiet = s.quietStart === s.quietEnd ? false
    : s.quietStart < s.quietEnd ? hour >= s.quietStart && hour < s.quietEnd
      : hour >= s.quietStart || hour < s.quietEnd;
  if (!quiet) return null;
  void graceMin;
  return {
    awake: `${s.quietEnd}:00-${s.quietStart}:00`,
    their_own: s.toldUsTheirZone,
    note: `${clockFace(atMin)} is outside the hours they gave for everything else`
      + ` (${s.quietEnd}:00-${s.quietStart}:00${s.toldUsTheirZone ? ", their own" : ", the default until they say otherwise"}).`
      + ` That is fine and the nudge WILL go out at ${clockFace(atMin)} — naming the hour is them saying it is alright for`
      + ` this. Say that in ONE line so it is not a surprise either way: you will poke them about this at`
      + ` ${clockFace(atMin)}, and nothing else that early.`,
  };
}
