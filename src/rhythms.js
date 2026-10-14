// What Reason has worked out about how somebody lives — kept as a guess, with its receipts.
//
// Everything else in Reason's memory is a single thing: a fact somebody said, a reading of one
// photo, a reason they stated once. An INFERENCE is a different animal. It is a pattern across
// evidence — "you deal with work stuff after nine", "saturdays are gone" — and three things follow
// from that which no other row has to deal with:
//
//   1. **It rests on rows, so it can be shown.** Every pattern carries the message ids and the times
//      it was read out of. "Why do you think that" is answerable with a list rather than with the
//      model remembering why it said something three weeks ago. A pattern nobody can audit is a
//      thing Reason has decided about somebody, which is the whole failure mode here.
//   2. **It expires.** A fact they told you stays true until they say otherwise. A pattern is a
//      claim about how they live NOW, and somebody who changes jobs has not corrected anything —
//      the claim just stopped being true. So every pass re-checks the rows against fresh evidence,
//      and one nothing has borne out for three weeks is deleted rather than left to quietly shape
//      when their texts arrive.
//   3. **It is not kept at all until they say yes.** This is the only kind of memory in Reason with
//      a consent gate in front of it, and the gate is there because of what an inference IS: not
//      something they told Reason, not a reading of something they handed it, but Reason watching
//      somebody for three weeks and forming a view. That is worth asking about, ONCE, at the first
//      moment it would actually change something, with the real example in the question.
//
// The split between code and the model is the house one and it is unusually clean here, because the
// two halves are so obviously different jobs:
//
//   CODE gathers. Message times by local hour and weekday, the gaps before they come back, the days
//   nothing arrived — three weeks of it, as numbers, with no message bodies anywhere near the model.
//   What somebody SAID is not what a rhythm is about, and handing a model three weeks of somebody's
//   texts to find a shape in would be a different and much worse feature.
//
//   CODE also refuses. At least three evidence points, spanning at least two weeks, every point a
//   row that really exists, and a `use` that is not empty. None of those is a judgement: they are
//   the arithmetic that separates a rhythm from a coincidence, and they are checked after the model
//   has spoken, so a model that proposes "you text on tuesdays" off one tuesday is refused by code.
//
//   THE MODEL reads. Whether a shape in the numbers is a real rhythm or noise, what it means in
//   plain words, and — the part only a reader can do — what it should CHANGE. An inference that
//   changes nothing is not stored, because a theory about somebody that does no work for them is
//   just Reason having opinions about a person.
//
// Nothing in here is said out loud. A rhythm shapes WHEN a non-urgent nudge lands (see rhythmMoment
// in src/notice.js) and shows on their memory page as something Reason thinks. It is never stated
// back as a fact, and the pass itself sends nothing at all.
import * as db from "./db.js";
import * as notice from "./notice.js";
import { clock, config, stamp } from "./config.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How far back a pass looks. Three weeks: long enough for "every saturday" to have happened three times. */
export const WINDOW_DAYS = 21;

/**
 * The bar, as three numbers, in the one place all of them are read from.
 *
 * `MIN_POINTS` 3 and `MIN_SPAN_DAYS` 14 are the difference between a rhythm and a run of days. Two
 * late evenings in one week is a busy week; three across a fortnight is how somebody lives. And
 * `EXPIRE_DAYS` is the same number as the window on purpose — a pattern has to survive a full look
 * without being borne out before it is dropped, so one quiet fortnight does not delete everything.
 */
export const MIN_POINTS = 3;
export const MIN_SPAN_DAYS = 14;
export const EXPIRE_DAYS = 21;

/** The kinds of rhythm this pass is for. Named, because the frame has to say what it is looking for. */
export const ABOUT = {
  hours: "which hours of the day they are actually reachable in, or deal with a kind of thing in",
  weekdays: "which days of the week are different from the others",
  pace: "how fast they come back, and when they do not",
  gaps: "the days they go quiet",
};

// ---------- what code gathers ----------

/**
 * One message, as a point: its row id, when it landed, and where that falls on their own clock.
 *
 * `ref` is the handle the model has to name to use it as evidence, and it is checked against this
 * list afterwards — so a proposal cannot rest on a message that does not exist. `at` is kept because
 * the span check is arithmetic over real timestamps, and `hour` because the timing in
 * src/notice.js computes a rhythm's window off the rows rather than off its wording.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Which day of the week it was WHERE THEY ARE, which is not the same as where this machine is. */
export function localWeekday(at, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(at));
  const i = WEEKDAYS.indexOf(name);
  return i === -1 ? 0 : i;
}

function point(row, timeZone) {
  const at = Number(row.at);
  return {
    ref: `m${row.id}`,
    at,
    hour: notice.localHour(at, timeZone),
    weekday: localWeekday(at, timeZone),
    day: notice.localDay(at, timeZone),
  };
}

/**
 * Three weeks of when, with no what.
 *
 * Returns the points, the counts a reader needs to see a shape, and `span_days` — which is the thing
 * the gate is actually about. A hundred messages in one afternoon is not a rhythm, and the only way
 * to know the difference is the distance between the first and the last.
 */
export function evidenceFor({ conversationId, now = clock.now(), timeZone = config.tz, days = WINDOW_DAYS } = {}) {
  const since = now - days * DAY;
  const theirs = db.inboundTimes(conversationId, { since, until: now }).map(r => point(r, timeZone));
  const ours = db.outboundTimes(conversationId, { since, until: now }).map(r => ({ at: Number(r.at) }));

  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const byWeekday = WEEKDAYS.map((name, weekday) => ({ weekday, name, count: 0 }));
  const seenDays = new Set();
  for (const p of theirs) {
    byHour[p.hour].count++;
    byWeekday[p.weekday].count++;
    seenDays.add(p.day);
  }

  // The days in the window that had nothing from them at all, by their own calendar. Walked from the
  // window's start so a day they were simply asleep through reads as a day with nothing in it.
  const quietDays = [];
  for (let t = since; t <= now; t += DAY) {
    const day = notice.localDay(t, timeZone);
    if (!seenDays.has(day) && !quietDays.includes(day)) quietDays.push(day);
  }

  // How long they take to come back: for each thing Reason sent, the first thing they sent after it.
  // Only gaps under a day, because a gap of three days is them being away rather than them being
  // slow, and mixing the two makes the median meaningless.
  const gaps = [];
  for (const sent of ours) {
    const back = theirs.find(p => p.at > sent.at);
    if (!back) continue;
    const gap = back.at - sent.at;
    if (gap <= DAY) gaps.push(Math.round(gap / MIN));
  }
  gaps.sort((a, b) => a - b);

  const span = theirs.length ? theirs.at(-1).at - theirs[0].at : 0;
  return {
    window: { from: stamp(since), to: stamp(now), days, time_zone: timeZone },
    points: theirs,
    count: theirs.length,
    span_days: Math.floor(span / DAY),
    by_hour: byHour.filter(h => h.count > 0),
    by_weekday: byWeekday,
    days_with_nothing: quietDays,
    reply_gap_minutes: gaps.length
      ? { fastest: gaps[0], median: gaps[Math.floor(gaps.length / 2)], slowest: gaps.at(-1), of: gaps.length }
      : null,
  };
}

/**
 * Is there enough here to be worth a turn at all?
 *
 * Asked before the model is paid for anything, and it is the same bar `keep` applies afterwards —
 * once as a reason not to look, once as a reason not to store. Most people on most days fail this
 * and the pass costs two queries.
 */
export function enoughToLookAt(evidence) {
  if (!evidence || evidence.count < MIN_POINTS) {
    return { ok: false, why: `only ${evidence?.count ?? 0} message(s) in the window; ${MIN_POINTS} is the floor` };
  }
  if (evidence.span_days < MIN_SPAN_DAYS) {
    return { ok: false, why: `all of it inside ${evidence.span_days} day(s); a rhythm has to span ${MIN_SPAN_DAYS}` };
  }
  return { ok: true };
}

// ---------- what code refuses ----------

/**
 * One proposal, held up against the rows it claims to rest on.
 *
 * Every refusal here is a fact, not an opinion about whether the reading is any good — that part was
 * never code's to have a view on. What code can check: that the words are there, that something
 * would change, that the evidence is real rows and not a list the model wrote, that there are enough
 * of them, and that they are far enough apart to be a rhythm rather than a week.
 */
export function check(proposal, evidence) {
  const about = String(proposal?.about ?? "").trim();
  const inference = String(proposal?.inference ?? "").trim();
  const use = String(proposal?.use ?? "").trim();
  if (!about || !inference) return { ok: false, why: "a pattern needs both what it is about and what you think" };
  if (!use) {
    return {
      ok: false,
      why: `nothing is stored without 'use' — what this CHANGES, in plain words. An inference that changes nothing is`
        + ` a thing you have decided about somebody for no reason, so there is nowhere for it to go`,
    };
  }
  const known = new Map((evidence?.points ?? []).map(p => [p.ref, p]));
  const asked = [...new Set((Array.isArray(proposal?.evidence) ? proposal.evidence : []).map(r => String(r).trim()))];
  const unknown = asked.filter(r => !known.has(r));
  if (unknown.length) {
    return {
      ok: false,
      why: `${unknown.slice(0, 4).join(", ")} ${unknown.length === 1 ? "is not a row" : "are not rows"} that was in front of`
        + ` you. Evidence is the refs from the list you were given and nothing else — a pattern resting on something you`
        + ` wrote down yourself is not resting on anything`,
    };
  }
  const points = asked.map(r => known.get(r)).sort((a, b) => a.at - b.at);
  if (points.length < MIN_POINTS) {
    return { ok: false, why: `${points.length} evidence point(s); ${MIN_POINTS} is the floor, and that is what makes it a pattern rather than a thing that happened` };
  }
  const span = points.at(-1).at - points[0].at;
  if (span < MIN_SPAN_DAYS * DAY) {
    return {
      ok: false,
      why: `all of that evidence is inside ${Math.floor(span / DAY)} day(s). A rhythm has to hold across at least`
        + ` ${MIN_SPAN_DAYS}, or it is one busy fortnight being read as how somebody lives`,
    };
  }
  return { ok: true, about, inference, use, points, span_days: Math.floor(span / DAY) };
}

/**
 * A checked proposal, stored — or handed back as the one already there.
 *
 * Dedupe is `noteGuess`'s, which matches on the subject and the wording: two passes that read the
 * same rhythm out of the same evenings write one row. The second one comes back saying
 * `already_guessed`, and its evidence is refreshed rather than appended to, because what the row
 * should carry is the rows that bear it out NOW.
 */
export function keep({ conversationId, proposal, evidence, now = clock.now() }) {
  const vetted = check(proposal, evidence);
  if (!vetted.ok) return vetted;
  const noted = db.noteGuess(conversationId, {
    about: vetted.about, guess: vetted.inference, how: db.PATTERN_SOURCE,
    evidence: vetted.points, use: vetted.use,
  });
  if (!noted) return { ok: false, why: "that would not store" };
  if (noted.already_guessed) {
    db.supportPattern(conversationId, noted.id, now, { evidence: vetted.points });
    return { ok: true, id: noted.id, already_noticed: true, about: vetted.about, inference: vetted.inference, use: vetted.use };
  }
  return {
    ok: true, id: noted.id, already_noticed: false,
    about: vetted.about, inference: vetted.inference, use: vetted.use,
    off: vetted.points.length, span_days: vetted.span_days,
  };
}

/**
 * The rows nothing has borne out for three weeks, deleted.
 *
 * Code's half of expiry: the model says each pass which rows the fresh evidence still supports and
 * code stamps those, so all this has to do is arithmetic against a cutoff. Run BEFORE the turn as
 * well as after it, so a pass that never gets as far as a model call still expires what is stale —
 * somebody who stops talking to Reason for a month should not come back to a page of three-week-old
 * theories about them.
 */
export function expire({ conversationId, now = clock.now() }) {
  const stale = db.patternsUnsupportedSince(conversationId, now - EXPIRE_DAYS * DAY);
  for (const row of stale) db.dropGuess(conversationId, row.id);
  return stale.map(r => ({ id: r.id, about: r.about, was: r.guess }));
}

// ---------- the frames ----------

/** The evidence, as lines. No message bodies, because the pass is about when and not about what. */
function evidenceLines(evidence) {
  const hours = evidence.by_hour.map(h => `${String(h.hour).padStart(2, "0")}:00 ×${h.count}`).join("  ");
  const days = evidence.by_weekday.map(d => `${d.name} ×${d.count}`).join("  ");
  return [
    `Their clock: ${evidence.window.time_zone}. The window: ${evidence.window.from} to ${evidence.window.to}`
      + ` (${evidence.window.days} days, ${evidence.count} messages from them, spanning ${evidence.span_days} days).`,
    `By hour of their day:  ${hours || "(nothing)"}`,
    `By day of the week:    ${days}`,
    evidence.reply_gap_minutes
      ? `How long they take to come back after you: fastest ${evidence.reply_gap_minutes.fastest}m,`
        + ` middle ${evidence.reply_gap_minutes.median}m, slowest ${evidence.reply_gap_minutes.slowest}m`
        + ` (over ${evidence.reply_gap_minutes.of} of them, gaps over a day left out).`
      : `No reply gaps in the window.`,
    evidence.days_with_nothing.length
      ? `Days with nothing from them at all: ${evidence.days_with_nothing.join(", ")}`
      : `Nothing from them on no day in the window.`,
    ``,
    `The rows themselves, which are the only things you may name as evidence:`,
    ...evidence.points.map(p => `  ${p.ref}  ${WEEKDAYS[p.weekday]} ${stamp(p.at)} (${String(p.hour).padStart(2, "0")}:00 their time)`),
  ].join("\n");
}

/** What a rhythm has to clear, in the words the model reads. Code checks every one of these too. */
const BAR = `Three bars, and code checks all three after you, so do not argue with them:`
  + `\n  1. At least ${MIN_POINTS} of the refs above, and they have to span at least ${MIN_SPAN_DAYS} days. Three late`
  + ` nights in one week is a busy week; three across a fortnight is how somebody lives.`
  + `\n  2. 'use' cannot be empty: what this CHANGES about what you do. "hold non-urgent things till the evening",`
  + ` "do not expect an answer on a saturday". An inference that changes nothing is a thing you have decided about`
  + ` somebody for no reason and it will be refused.`
  + `\n  3. Evidence is the refs from the list and nothing else. Never a ref you made up, and never "I remember".`;

const VOICE = `Write the inference the way you would say it to them, lowercase, short, and as a THING YOU THINK rather than`
  + ` a fact: "deals with work stuff after 9pm" not "works nights". You will never say one of these out loud unprompted,`
  + ` and when they ask, it goes back as "i think" with the receipts.`;

/**
 * The reflection turn, for somebody who has said yes.
 *
 * Written as a bar to clear rather than a job to do, like the sweep's frame, because the common and
 * correct outcome is nothing. Most weeks hold no rhythm anybody did not already know, and a model
 * that feels it has to produce one produces exactly the sort of thing this feature must not keep.
 */
export function reflectFrame({ conversationId, evidence, rows = [], now = clock.now() }) {
  const who = db.getAccount(conversationId)?.name || config.ownerName;
  return `[what you have noticed about how they live] Nobody asked you to do this. Once a day, while ${who} is asleep,`
    + ` you look at the SHAPE of three weeks — not at anything they said, which is not in front of you and is not what`
    + ` this is about.`
    + `\n\n${evidenceLines(evidence)}`
    + (rows.length
      ? `\n\nWhat you already think, which is the first job. For each one: does the evidence above still bear it out?`
        + `\n${rows.map(r => `  #${r.id} about ${r.about}: "${r.guess}" — so you ${r.use} (${r.evidence.length} point(s), last borne out ${stamp(r.last_supported_at ?? r.noted_at)})`).join("\n")}`
        + `\nCall pattern_still with the ids that still hold. Say nothing about the ones that do not: a pattern nothing`
        + ` has borne out for ${EXPIRE_DAYS} days is deleted by code, which is right — somebody whose life changed has`
        + ` not corrected anything, the thing just stopped being true.`
      : ``)
    + `\n\nThen, and only if there is really one there: ONE new rhythm, with pattern_note. ${Object.values(ABOUT).map(w => `\n  - ${w}`).join("")}`
    + `\n\n${BAR}`
    + `\n\n${VOICE}`
    + `\n\nThe common answer is nothing, and nothing is not a failure. A shape you would find in anybody's three weeks`
    + ` — "texts more on weekdays", "quiet at 4am" — is not a rhythm about ${who}, it is a fact about people, and`
    + ` keeping one would fill their page with things that tell them nothing about themselves. ${notice.SILENCE_RULE}`
    + `\n\nThis turn sends NOTHING. Whatever you write is not delivered: reply with exactly NO_REPLY when you are done,`
    + ` whether you stored anything or not. You never bring one of these up on your own — it changes when things land,`
    + ` it shows on their memory page as something you think, and that is all it does.`;
}

/**
 * The consent turn: the first time an inference would change something, ask.
 *
 * One frame, asked once in a lifetime, and the hardest wording in the feature to get right. It has
 * to carry a real example — a question about "patterns" in the abstract is a privacy policy and
 * nobody can answer it — and it has to be a question rather than an announcement, because the whole
 * point is that it is theirs to say no to. The example is HELD rather than stored while it is being
 * asked about: see pattern_asks in src/db.js.
 */
export function askFrame({ conversationId, evidence, now = clock.now() }) {
  const who = db.getAccount(conversationId)?.name || config.ownerName;
  return `[the one question about noticing patterns] You have never asked ${who} whether you may notice PATTERNS about`
    + ` them — not facts they tell you, which you already keep, but shapes across weeks: the hours they deal with things`
    + ` in, the days they go quiet. Nothing of that kind is written down about them and nothing will be unless they say`
    + ` yes. This is the one time you ask, and you only ask at all because something real has turned up.`
    + `\n\n${evidenceLines(evidence)}`
    + `\n\nFirst, find at most ONE rhythm in that — the strongest one, and only if it would really change something you`
    + ` do. Call patterns_ask with it. ${BAR}`
    + `\n\nIf nothing in there is strong enough, or nothing it says would change anything, then there is nothing to ask`
    + ` about: reply with exactly NO_REPLY and it will come round again another night. Asking with a weak example is`
    + ` worse than not asking — this question gets asked once, ever, and a vague one gets a no.`
    + `\n\nWhen you have called it, write ONE short message in your own voice: what you noticed, what you have been`
    + ` doing with it, and whether they want you to keep picking things like that up — plus that they can see and`
    + ` delete any of them whenever they like. The shape, and not the words:`
    + `\n  "btw i've noticed you deal with work stuff after 9pm, so i've been holding non-urgent things till then.`
    + ` want me to keep picking up patterns like that? you can see and delete any of them anytime"`
    + `\n\nOne message. Lowercase, the way you always talk. Never a paragraph about privacy, never a list of what you`
    + ` might notice, never "I've been analysing". They can answer it in a word, and whichever way they answer, that is`
    + ` the answer: patterns_set with their own sentence. A no is a perfectly good outcome and you do not argue with it`
    + ` or ask again.`
    + `\n\n${notice.NO_PERMISSION_RULE}`;
}

/** The line the thread keeps for a reflection turn, which is otherwise several kilobytes of timestamps. */
export function reflectKept({ conversationId, evidence }) {
  const who = db.getAccount(conversationId)?.name || config.ownerName;
  return `[rhythms] you looked at the shape of ${who}'s last ${evidence.window.days} days on your own`
    + ` (${evidence.count} messages, no bodies) and decided whether there was a real pattern in it. Nothing was sent.`;
}
