// What Reason remembers about you, on one page, and every line of it yours to change.
//
// "What do you remember about me" was answerable before this file, badly: `recall` gives back the
// facts saved against a subject and nothing else. Which left three things somebody cannot see and
// therefore cannot correct — what Reason is *guessing*, what it has worked out about their taste, and
// what they have told it to do without asking. All of those shape what Reason says next, so all of
// them belong in one place with a number on every row.
//
// The sections, and why each is its own section rather than one list:
//
//   1. **Facts they told Reason.** Close to verbatim, with when. These are the only thing `remember`
//      has ever been willing to save, and they are stated back as fact because somebody said them.
//   2. **Things Reason is guessing.** Its own readings — off a photo, or worked out. Kept, labelled,
//      and NEVER stated back as fact. Separate from 1 because the difference between them is the
//      whole point: a guess in the facts list is how "that's my friend's car" becomes permanent.
//   3. **Preferences**, including the taste learned from what they turned down (src/sheet.js's
//      categories, their words verbatim). Not facts about them: readings of a no.
//   4. **Why they are doing things** (2026-10-06), from the `whys` table: the goals they have stated
//      out loud, with the sentence each one came from. Its own section rather than a fact, because a
//      reason is not a thing that stays true about somebody — it is what they are trying to achieve,
//      and it is the row that decides what order the options come back in. "Move to save money" and
//      "move for a shorter commute" are two different jobs, and this is where the difference lives.
//   5. **Standing permissions**, from the `permissions` table, with the grant sentence verbatim —
//      because the thing a person most needs to be able to check is what Reason may do unasked.
//
// Plus their initiative settings, which are not memory but are the other half of "what do you know
// about me and what are you doing with it": the mode, their hours, their zone, and whether those are
// theirs or still a guess.
//
// **Every row is correctable and deletable by text, by id.** The model reads the correction; code
// changes exactly the named row and nothing else. Two things make that mean something:
//
//   - A correction replaces the old reading EVERYWHERE, not just in the row. The wrong wording is also
//     sitting in the saved thread — in a `recall` result, in whatever Reason said off the back of it —
//     and the next turn reads those. So a fix runs `scrubToolResults` and `redactFromReplies` with the
//     old words, exactly as `forget` does. A correction that only fixed the row would leave Reason
//     repeating the thing it had just been corrected on.
//   - A permission is NOT corrected here. Taking one back goes through `permission_revoke`, which is
//     the one path that writes `revoked_at` and the one the gate reads. A second way to revoke a
//     permission is a second way to get it wrong.
//
// Nothing in this file reads intent out of anything the person wrote. The model decides what they
// meant and names a row and an id; every function here takes a number and an enum.
import * as db from "./db.js";
import * as permissions from "./permissions.js";
import * as notice from "./notice.js";
import * as commitment from "./commitment.js";
import { clock, config, stamp } from "./config.js";

/**
 * The rows a correction may name, and the one word it names each by.
 *
 * Not every section of the page: what they do on a schedule also shows there, and it is NOT in here
 * on purpose. A schedule is changed by saying the new time (commitment_set, which keeps every
 * session logged against it) and stopped by saying stop (commitment_end), so a `memory_fix` path to
 * it would be a second way to edit the same row that silently did less.
 */
export const ROWS = ["fact", "guess", "pattern", "preference", "why", "permission"];

/** How a guess was arrived at, in words a person reads rather than an enum. */
const HOW = {
  i_worked_it_out: "I worked this out — nobody told me",
  i_saw_it_in_a_photo: "I read this off a picture — nobody told me",
  i_noticed_a_pattern: "I noticed this across a few weeks — nobody told me",
};

/**
 * What a permission's scope means, in words somebody reads.
 *
 * The scope is a category name or a tool name (src/permissions.js), both of which are Reason's own
 * vocabulary. Their own sentence is on the row and comes first; this is the second line, so the page
 * never makes somebody work out what "subscription_cancel_commit" was about.
 */
const COVERS = {
  purchases: "buying things",
  email: "sending email as you",
  mail_tidying: "tidying your mail — archiving, labelling, marking read",
  texts: "texting people",
  calls: "ringing people",
  calendar_invites: "putting things on your calendar",
  accounts: "connecting accounts",
  subscriptions: "finishing a cancellation",
  browser_submit: "buying things",
  gmail_send: "sending email as you",
  message_send: "texting people",
  voice_note_send: "sending voice notes",
  call_place: "ringing people",
  calendar_create: "putting things on your calendar",
  subscription_cancel_commit: "finishing a cancellation",
};

/** What each category of a turned-down option is about, for the page. */
const CATEGORY = {
  price: "price",
  vibe: "the vibe of it",
  timing: "timing",
  location: "where it is",
  other: "something else",
};

/**
 * Every section plus their initiative settings, as data.
 *
 * One read, used by three things that must never disagree: the page, the text answer, and the
 * refusal a correction gives when it cannot find the row somebody named.
 */
export function remembered({ conversationId, now = clock.now() } = {}) {
  const facts = db.listFacts(conversationId).map(f => ({
    id: f.id, about: f.about, fact: f.fact, since: stamp(f.created_at),
    ...(f.source && f.source !== "user_stated" ? { source: f.source } : {}),
    ...(f.confidence != null && f.confidence < 1.0 ? { confidence: f.confidence } : {}),
  }));
  const guesses = db.listGuesses(conversationId).map(g => ({
    id: g.id, about: g.about, guess: g.guess, how: HOW[g.how] ?? HOW.i_worked_it_out,
    noted: stamp(g.noted_at),
    ...(g.corrected_at ? { corrected: stamp(g.corrected_at) } : {}),
  }));
  const patterns = db.listPatterns(conversationId).map(p => ({
    id: p.id, about: p.about, i_think: p.guess, so_i: p.use,
    off: p.evidence.length,
    hours: notice.rhythmHours(p) ? `${notice.rhythmHours(p).from}:00-${notice.rhythmHours(p).to}:00` : "",
    noticed: stamp(p.noted_at),
    last_borne_out: stamp(p.last_supported_at ?? p.noted_at),
    ...(p.corrected_at ? { corrected: stamp(p.corrected_at) } : {}),
  }));
  const prefs = db.listPreferences(conversationId).map(p => ({
    id: p.id, category: p.category, about_the: CATEGORY[p.category] ?? p.category,
    they_said: p.words,
    ...(p.turned_down ? { turned_down: p.turned_down } : {}),
    ...(p.note ? { means: p.note } : {}),
    learned: stamp(p.learned_at),
    ...(p.corrected_at ? { corrected: stamp(p.corrected_at) } : {}),
  }));
  // The reasons still standing. Superseded ones are deliberately not here: a page is for what Reason
  // is working from now, and a reason they have already put right is history rather than a live row
  // they would have to correct twice. The superseded rows stay on disk and go out in an export.
  const whys = db.listWhys(conversationId).map(w => ({
    id: w.id, about: w.about, why: w.why, they_said: w.said,
    since: stamp(w.stated_at),
    ...(w.task_id ? { first_said_on_task: w.task_id } : {}),
  }));
  const perms = db.listPermissions(conversationId).map(r => {
    const v = permissions.view(r);
    return {
      id: r.id, they_said: r.said, what_it_covers: COVERS[v.covers] ?? v.covers,
      ...(r.target ? { only_for: r.target } : {}),
      ...(v.up_to ? { up_to: v.up_to } : {}),
      ...(v.until ? { until: v.until } : {}),
      granted: v.granted,
    };
  });
  // What they said they DO, and the numbers they logged against it. Here rather than only in
  // commitment_list because this page is the answer to "what do you know about me", and a schedule
  // they set plus last week's weights is some of the most particular of it — a feature that nudges
  // somebody about a 7am they can only change by remembering a tool exists is a feature that owns
  // their morning. Live rows, read every time: an ended one is not something Reason knows any more.
  const commitments = commitment.listView(conversationId, { now })
    .filter(v => v.state === "active")
    .map(v => ({
      id: v.commitment_id, what: v.what, they_said: v.their_words,
      on: v.days, at: v.at, their_zone: v.their_zone,
      ...(v.last_session ? { last_session: v.last_session } : {}),
      ...(v.their_numbers.length ? { their_numbers: v.their_numbers } : {}),
      set_on: v.set_on,
    }));
  return {
    facts, guesses, patterns, preferences: prefs, whys, permissions: perms, commitments,
    initiative: initiativeNow({ conversationId, now }),
    counts: {
      facts: facts.length, guesses: guesses.length, patterns: patterns.length, preferences: prefs.length,
      whys: whys.length, permissions: perms.length,
      commitments: commitments.length,
    },
  };
}

/** Is any of it filled in? One place, so the page, the text answer and the tests agree. */
const nothingYet = (got) => !got.counts.facts && !got.counts.guesses && !got.counts.patterns
  && !got.counts.preferences && !got.counts.whys && !got.counts.permissions && !got.counts.commitments;

/**
 * Their initiative settings in plain words, for the page.
 *
 * Read off `notice.settingsFor` rather than restated, so this and `notice_status` cannot disagree
 * about what somebody asked for. `hours_are` is the honest one: the difference between hours they
 * chose and a default nobody has confirmed with them is exactly what a person wants to see here.
 */
export function initiativeNow({ conversationId, now = clock.now() } = {}) {
  const s = notice.settingsFor(conversationId, { now });
  return {
    mode: s.mode,
    set_to: s.setMode,
    means: notice.MODES[s.mode].what,
    is_the_default: s.setMode === notice.DEFAULT_MODE && !s.ownSetting,
    ...(s.snoozed ? { snoozed_until: stamp(s.snoozeUntil) } : {}),
    ...(s.setMode === "digest" ? { digest_at: `${s.digestHour}:00` } : {}),
    at_most_a_day: s.perDay,
    hard_cap_a_day: s.hardCap,
    awake_hours: `${s.quietEnd}:00-${s.quietStart}:00`,
    time_zone: s.timeZone,
    hours_are: s.windowAnsweredAt ? "what they told you" : "a default nobody has confirmed with them yet",
    zone_from: s.toldUsTheirZone ? "they told you" : "their calendar, or the install default",
    patterns: s.patterns === "on" ? "on" : s.patterns === "off" ? "off" : "not asked yet",
    ...(s.patternsSaid ? { patterns_they_said: s.patternsSaid } : {}),
  };
}

/**
 * One line for the initiative section, in words a person reads.
 *
 * Second person throughout, which `remembered`'s own fields are not: those are written for the model
 * ("what they told you"), and a page that says "nobody has confirmed with them" to the person it is
 * addressed to reads like being talked about rather than talked to.
 */
function initiativeLine(i) {
  const mode = i.snoozed_until
    ? `snoozed until ${i.snoozed_until}`
    : `${i.set_to}${i.is_the_default ? " (the default — you have not changed it)" : ""}`;
  return `How much I speak up on my own: **${mode}** — ${i.means}.`
    + ` At most ${i.at_most_a_day === 0 ? "nothing" : `${i.at_most_a_day} a day`} unprompted, and never more than`
    + ` ${i.hard_cap_a_day} whatever happens.`
    + ` I take ${i.awake_hours} ${i.time_zone} as your waking hours`
    + (i.hours_are === "what they told you" ? `, which is what you told me.` : `, which is a guess until you tell me otherwise.`)
    + (i.zone_from === "they told you" ? "" : ` Your clock I read off your calendar rather than from you.`);
}

/** The one line for the patterns setting, addressed to them like the rest of the page. */
function patternsLine(i) {
  if (i.patterns === "on") {
    return `Noticing patterns: **on**${i.patterns_they_said ? ` — you said "${i.patterns_they_said}"` : ""}.`
      + ` So I pick up rhythms like the ones above and use them to decide when something that is not urgent reaches you.`
      + ` Every one of them is a guess, every one is on this page, and "stop doing that" turns it off and deletes them.`;
  }
  if (i.patterns === "off") {
    return `Noticing patterns: **off**${i.patterns_they_said ? ` — you said "${i.patterns_they_said}"` : ""}.`
      + ` I do not look for rhythms about you and I keep none. Anything I had is deleted.`;
  }
  return `Noticing patterns: **I have not asked you yet**, so I am not keeping any. If something ever turns up that`
    + ` would change when I text you, I will ask you once, show you the example, and it is yours to say no to.`;
}

/**
 * The page, as blocks for `page_create`.
 *
 * `rows` blocks throughout rather than tables, because every row here is three short facts and a
 * number, which is what `rows` is for on a phone. The number is in the row's `n` on purpose: it is
 * the handle somebody texts back to change that line, and a page that showed the lines without the
 * numbers would be a page you can read and not a page you can correct.
 */
export function pageBlocks(got, { ownerName = config.ownerName } = {}) {
  const blocks = [];
  const empty = nothingYet(got);

  if (empty) {
    blocks.push({
      type: "text",
      text: `Nothing yet. I only write something down when you tell me it, so this page fills up as we go —`
        + ` and everything on it will be yours to change or delete by text.`,
    });
  }

  if (got.counts.facts) {
    blocks.push({ type: "section", title: "What you told me" });
    blocks.push({
      type: "rows",
      items: got.facts.map(f => ({ name: f.fact, detail: `about ${f.about} · since ${f.since}`, n: `#${f.id}` })),
    });
  }

  if (got.counts.guesses) {
    blocks.push({ type: "section", title: "What I'm guessing" });
    blocks.push({
      type: "callout",
      tone: "warning",
      title: "Guesses, not facts",
      text: `Nobody told me any of these — I worked them out or read them off something. I will not say them back to you`
        + ` as though they were true, and one only becomes a fact if you tell me it is. If any of them is wrong, say so and`
        + ` it goes.`,
    });
    blocks.push({
      type: "rows",
      items: got.guesses.map(g => ({ name: g.guess, detail: `about ${g.about} · ${g.how} · ${g.noted}`, n: `#${g.id}` })),
    });
  }

  if (got.counts.patterns) {
    blocks.push({ type: "section", title: "What I've noticed about your rhythms" });
    blocks.push({
      type: "callout",
      tone: "warning",
      title: "Guesses across a few weeks, not facts",
      text: `Nobody told me any of these either — I noticed them across a few weeks, and each one says what I've been`
        + ` doing differently because of it. I never say one back to you as though it were true, and I never bring one`
        + ` up on my own. Ask me why I think one and I'll show you what it's off. If one's wrong, say so and it goes —`
        + ` and if you'd rather I stopped noticing altogether, say that and they all go.`,
    });
    blocks.push({
      type: "rows",
      items: got.patterns.map(p => ({
        name: p.i_think,
        detail: [`so I ${p.so_i}`, `about ${p.about}`, `off ${p.off} thing${p.off === 1 ? "" : "s"}`,
          p.hours ? `around ${p.hours}` : null, `noticed ${p.noticed}`].filter(Boolean).join(" · "),
        n: `#${p.id}`,
      })),
    });
    blocks.push({
      type: "text",
      text: `These expire on their own. If one of them stops being how your weeks look, it drops off without you having`
        + ` to do anything — unlike something you told me, which stays until you say otherwise.`,
    });
  }

  if (got.counts.preferences) {
    blocks.push({ type: "section", title: "What you've turned down" });
    blocks.push({
      type: "rows",
      items: got.preferences.map(p => ({
        name: `"${p.they_said}"`,
        detail: [p.turned_down ? `about ${p.turned_down}` : null, p.about_the, p.means, p.learned]
          .filter(Boolean).join(" · "),
        n: `#${p.id}`,
      })),
    });
    blocks.push({
      type: "text",
      text: `I use these when I pick what to put in front of you. They are not rules — if the best thing breaks one, I'll`
        + ` still show you and say so.`,
    });
  }

  if (got.counts.whys) {
    blocks.push({ type: "section", title: "Why you're doing things" });
    blocks.push({
      type: "rows",
      items: got.whys.map(w => ({
        name: w.why,
        detail: [`about ${w.about}`, `you said "${w.they_said}"`, w.since].filter(Boolean).join(" · "),
        n: `#${w.id}`,
      })),
    });
    blocks.push({
      type: "text",
      text: `These are the goals you actually told me, and they change what I put first — "cheaper" means something`
        + ` different when the point is saving money than when the point is a shorter commute. I never make one up: if`
        + ` a reason is not on this list, nobody told me it. Say one is wrong and the new one takes its place.`,
    });
  }

  // Before the permissions, after the taste: a schedule is something they told me, so it belongs
  // with the things they said rather than with the things I may do.
  if (got.counts.commitments) {
    blocks.push({ type: "section", title: "What you do on a schedule" });
    blocks.push({
      type: "rows",
      items: got.commitments.map(c => ({
        name: c.what,
        detail: [`${c.on} at ${c.at}`, c.their_zone, c.they_said ? `"${c.they_said}"` : null, `since ${c.set_on}`]
          .filter(Boolean).join(" · "),
        n: `#${c.id}`,
      })),
    });
    // The numbers, as their own rows, because this is the half the card is actually about and a
    // weight buried in a detail line is not something anybody checks. Only what they logged: a
    // commitment with nothing against it shows no numbers rather than a zero.
    const withNumbers = got.commitments.filter(c => c.their_numbers?.length);
    if (withNumbers.length) {
      blocks.push({
        type: "rows",
        items: withNumbers.flatMap(c => c.their_numbers.map(n => ({
          name: `${n.what} — ${n.weight}${n.sets && n.reps ? ` ${n.sets}x${n.reps}` : n.reps ? ` x${n.reps}` : ""}`,
          detail: `${c.what} · you told me this on ${n.on}`,
        }))),
      });
    }
    blocks.push({
      type: "text",
      text: `These are the only numbers I have, and they are the only ones I will ever say back to you — I do not`
        + ` estimate one and I do not work one out. If a time does not suit any more, just say the new one`
        + ` ("make leg day 8") and I change it and keep everything above. "Drop leg day" and I stop, and I will not`
        + ` bring it up again. If a number is wrong, tell me what it really was.`,
    });
  }

  blocks.push({ type: "section", title: "What I can do without asking" });
  if (got.counts.permissions) {
    blocks.push({
      type: "rows",
      items: got.permissions.map(p => ({
        name: `"${p.they_said}"`,
        detail: [p.what_it_covers, p.only_for ? `only ${p.only_for}` : null, p.up_to ? `up to ${p.up_to}` : null,
          p.until ? `until ${p.until}` : null, `since ${p.granted}`].filter(Boolean).join(" · "),
        n: `#${p.id}`,
      })),
    });
    blocks.push({
      type: "callout",
      tone: "note",
      title: "Everything else still asks",
      text: `Those are the only things. Anything that spends your money or reaches another person and is not on this list`
        + ` stops and asks you first. Tell me to take one back and it needs a yes again from that moment.`,
    });
  } else {
    blocks.push({
      type: "text",
      text: `Nothing. Every single thing that spends your money or reaches another person stops and asks you first.`,
    });
  }

  blocks.push({ type: "section", title: "How much I speak up on my own" });
  blocks.push({ type: "text", text: initiativeLine(got.initiative) });
  blocks.push({ type: "text", text: patternsLine(got.initiative) });
  blocks.push({
    type: "text",
    text: `You can change that any time — "stop texting me unless I ask", "once in the evening", "back to normal", or`
      + ` "not today" for a day off. None of it lets me spend anything or send anything on my own.`,
  });

  blocks.push({
    type: "callout",
    tone: "note",
    title: "All of it is yours",
    text: `Every line above has a number on it, ${ownerName}. Text me "#12 is wrong, it's actually…" and I change that one`
      + ` line and nothing else — and I stop saying the old version anywhere, including in anything I already said.`
      + ` "Forget #12" deletes it. Taking back something I may do without asking needs nothing more than you saying so.`,
  });

  return blocks;
}

/**
 * The instruction the text answer is written from.
 *
 * Deliberately not a sentence for the model to send: the voice is the model's, and a canned paragraph
 * read back verbatim is the thing Reason is not supposed to be. What code owns here is the ORDER (what
 * they said, then what is guessed, then taste, then permissions) and the two rules that are not
 * negotiable — a guess is never stated as a fact, and the numbers go out so a correction is possible.
 */
export function answerNote(got, { hasPage = false } = {}) {
  const bits = [];
  if (nothingYet(got)) {
    return `You do not know anything about them yet. Say exactly that in one short line, and that you only write down what`
      + ` they tell you. Do not pad it out, do not list what you COULD remember, and never invent a single row.`;
  }
  bits.push(`Answer from this and nothing else. Anything not in here, you do not remember.`);
  const hasInferred = got.facts.some(f => f.source === "inferred");
  if (hasInferred) {
    bits.push(`Some facts are marked (inferred) — these came from context rather than something they directly told you. Treat them with less certainty and be ready to be corrected.`);
  }
  bits.push(`In this order: what they TOLD you, then what you are GUESSING, then what they have turned down, then why they`
    + ` said they are doing things, then what they said you may do without asking. Short, in your own voice.`);
  if (got.counts.guesses) {
    bits.push(`The guesses are the part that matters. Say them AS guesses — "i think", "i've got you down as" — never as`
      + ` facts, and never fold one in with the things they really said. That is the whole reason they are a separate list.`);
  }
  if (got.counts.whys) {
    bits.push(`The reasons are what you RANK by, so say them as the goals they are and not as facts about them —`
      + ` "you said the move is about saving money" rather than "you want to save money". Never add one that is not`
      + ` in the list.`);
  }
  if (got.counts.permissions) {
    bits.push(`Quote a permission in THEIR words, not your reading of it.`);
  }
  if (got.counts.commitments) {
    bits.push(`What they do on a schedule goes in with the things they told you, and so do the numbers under it — those`
      + ` are off real logs and are the only ones you may say. Never add one up, average one or round one, and never`
      + ` count their missed ones back at them. A schedule is changed by them just saying the new time and stopped by`
      + ` them saying stop; say that once rather than naming a tool.`);
  }
  bits.push(`Put the numbers in, because they are how they fix something: "#4 your sister's name is Ama" reads as a line`
    + ` they can correct, and "i know about your sister" does not.`);
  bits.push(hasPage
    ? `There is a page for the full list: send the link with two or three lines of the most interesting of it, not all of it.`
    : `If it runs long, offer it as a page rather than sending a wall of it.`);
  bits.push(`End by saying, once and briefly, that they can change or delete any line of it.`);
  return bits.join(" ");
}
