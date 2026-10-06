// Telling somebody about something new, in passing.
//
// When a feature lands, the people already texting Reason have no way to know. The answer is not a
// changelog and not a broadcast text: it is one short line on the end of a reply Reason was already
// sending — "oh btw you can connect your gmail now". Casual, once per person, and never its own
// out-of-the-blue message.
//
// Two things make that safe, and both are code's job rather than the model's:
//
//   1. **Nothing is announced until somebody watched it work end to end on the live Reason.** An
//      entry with no `verified` record is invisible to the model, for everybody. That is the point
//      of this file: an announcement is a promise, and a promise about a feature nobody has
//      actually used is the exact thing docs/unverified.md exists to stop Reason making in prose.
//   2. **The capability has to be live FOR THIS PERSON, right now** — read from the same
//      `capabilitiesNow()` the model is handed. Telling somebody they can connect their Gmail and
//      then having the tool answer "not connected" when they try it is worse than saying nothing.
//
// The model decides whether the moment suits, because it is the only thing here that can tell an
// upset message from an idle one. Code decides what is eligible and records what was really said.
//
// ---------- how to mark an entry verified ----------
//
// Marking is done BY A PERSON, after they have used the thing themselves on the running Reason. A
// passing test suite cannot do it, a code review cannot do it, and it does not belong in the same
// commit as the feature.
//
//   1. Use the feature end to end on the live Reason, as somebody texting it — not in a test, not
//      against a fixture, not with a stubbed provider. For Gmail that means a real inbox really
//      connected and a real email really read or sent.
//   2. Read docs/unverified.md. If that feature, its provider or its adapter is still listed there
//      as never having run against the real service, it is NOT verified, whatever the suite says.
//      That file is the record of what has only ever been proved against a stub, and an entry here
//      must never outrun it.
//   3. Add the record to the entry below:
//
//        verified: {
//          on: "2026-10-12",
//          evidence: "connected my own gmail from my phone, asked for the last 3 subjects and got"
//            + " them back; docs/unverified.md no longer lists gmail as unproven",
//        },
//
//      `on` is the day it was seen working, YYYY-MM-DD. It also decides who counts as new: somebody
//      whose account is older than that day hears about it, and somebody who arrived after had it
//      from the start, so it is not news to them. `evidence` is one sentence naming what was
//      actually done and seen. Both are required — `test/whatsnew.test.js` fails on an entry with
//      either one empty, so a half-filled record cannot ship.
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { clock } from "./config.js";

/**
 * The announceable list. One entry per thing worth mentioning, newest last.
 *
 * `capability` is a name from `CAPABILITIES` / `capabilitiesNow()` in src/tools.js, and it is what
 * decides whether this is live for the person being talked to. `what` is a plain fact for the model
 * to phrase in its own words — never a sentence to repeat, because a canned line sent to everybody
 * is a broadcast wearing a reply's clothes.
 */
export const ANNOUNCEABLE = [
  {
    id: "gmail",
    capability: "email",
    what: "they can connect their gmail now, and then have their email read and sent from here",
    // No `verified` record, deliberately — and worth saying why it is still missing now that the
    // plumbing exists. Gmail was built on 2026-10-05 (src/google.js), so `capabilities` reports
    // `email` as connectable, and live for somebody who has connected. But every test of it answers a
    // fake Google: nothing has been sent to the real service, and docs/unverified.md says so test by
    // test. That is this gate working rather than a gap in it — "built" and "seen to work" are
    // different claims and only the second is worth telling somebody about. So the entry is still
    // invisible to everybody, and it stays that way until Omari has connected a real inbox, read a
    // real email through it, and filled the record in by hand.
  },
  {
    id: "several_google_accounts",
    capability: "email",
    what: "they can connect more than one google account — a personal gmail and a work one — and have"
      + " both at once: asking about mail or what's on a day looks in all of them, while sending and"
      + " binning happen on one account they name",
    // No `verified` record, for the same reason as the entry above and one more on top.
    //
    // The same reason: every test of this answers the fake Google in test/fixture-google.js. Not one
    // request has gone to accounts.google.com, and docs/unverified.md lists what that leaves unproven
    // test by test.
    //
    // The one on top: this is the entry most worth being strict about, because what it claims is a
    // thing only Google can do. Whether `prompt=select_account consent` really shows the account
    // chooser AND still returns a refresh token, and whether revoking one account's token leaves the
    // other account's grant alive, are both read off Google's documentation and have never been
    // watched happen. If either is wrong, somebody told "you can have both" either cannot add the
    // second account or loses the first when they drop it — so this stays invisible until Omari has
    // connected two real accounts, read mail out of both, and disconnected one with the other still
    // working. Then the record goes in by hand.
  },
];

// The list the rest of the module reads. `ANNOUNCEABLE` is the real one; a test swaps this out
// through withFeatures() rather than editing it, because a verified record is a claim a person
// made after watching something work, and a test must not be able to manufacture one.
let active = ANNOUNCEABLE;

/**
 * Test seam. Returns a restore function.
 *
 *   const restore = withFeatures([{ id: "x", capability: "plan", what: "...", verified: {...} }]);
 *   try { ... } finally { restore(); }
 */
export function withFeatures(list) {
  const was = active;
  active = list;
  return () => { active = was; };
}

/** What is being offered from right now — the real list, or whatever a test put in its place. */
export const features = () => active;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this entry allowed anywhere near the model?
 *
 * A `verified` record with a missing or malformed day, or with no evidence in it, counts as not
 * verified at all. There is no half-verified: the record is somebody's statement that they saw the
 * thing work, and a blank one is not that statement.
 */
export function isVerified(entry) {
  const v = entry?.verified;
  if (!v) return false;
  return DAY.test(String(v.on ?? "")) && String(v.evidence ?? "").trim().length > 0;
}

/**
 * Everything wrong with the list, in words. Empty means it is fit to ship.
 *
 * This is the lint the test asserts on. It catches the half-filled record — the one somebody meant
 * to come back to — because that is the failure that would quietly start announcing something
 * nobody checked.
 */
export function verifiedProblems(list = ANNOUNCEABLE) {
  const problems = [];
  const seen = new Set();
  for (const e of list) {
    const id = e?.id ?? "(no id)";
    if (!e?.id) problems.push("an entry has no id");
    else if (seen.has(e.id)) problems.push(`${id}: there are two entries with this id`);
    seen.add(e?.id);
    if (!String(e?.capability ?? "").trim()) problems.push(`${id}: no capability named, so nothing can check it is live`);
    if (!String(e?.what ?? "").trim()) problems.push(`${id}: no description of what the person can now do`);
    if (!("verified" in (e ?? {}))) continue; // unverified is the normal state, not a problem
    const v = e.verified;
    if (!DAY.test(String(v?.on ?? ""))) problems.push(`${id}: verified.on is '${v?.on ?? ""}', which is not a YYYY-MM-DD date`);
    if (!String(v?.evidence ?? "").trim()) problems.push(`${id}: verified has no evidence on it — say what was actually done and seen`);
  }
  return problems;
}

/** Is the capability behind this entry live for the person this conversation belongs to? */
function liveHere(capabilities, entry) {
  const cap = (capabilities ?? []).find(c => c.name === entry.capability);
  // "live" and nothing else. `partly live`, `connectable` and `off` all mean somebody could try the
  // thing and be told no, which is the one outcome announcing it is supposed to rule out.
  return cap?.status === "live";
}

/**
 * Did this person arrive after the feature did?
 *
 * Day strings compare correctly as text, and a day is all the precision a verified record has, so
 * somebody who arrived ON the verified day counts as having arrived with the feature. That errs
 * towards not announcing, which is the right direction: a line about something they never knew
 * missing reads like a stranger talking about itself.
 */
function arrivedAfter(conversationId, on) {
  const row = db.getAccount(conversationId);
  if (!row?.created_at) return false; // no account row: the console on a fresh install, which predates everything
  return accounts.today(row.created_at) > on;
}

/**
 * `capabilities` may be the list or a function returning it. A turn calls this on every message and
 * most of the time there is nothing to say, so the expensive read — what is really plumbed in on
 * this machine for this person — is only taken once something has got past the cheap checks.
 */
const resolve = (capabilities) => (typeof capabilities === "function" ? capabilities() : (capabilities ?? []));

/**
 * Entries this person could still be told about: verified, live for them, not already heard, and
 * from before they arrived. In list order, so the oldest unheard thing goes first.
 *
 * This is the half that is about the person rather than the moment, which is why `claimSaid` checks
 * it too: by the time the model says it did say the line, the only thing worth re-checking is
 * whether it was ever theirs to hear.
 */
export function unheardFor({ conversationId, capabilities = [] }) {
  const heard = new Set(db.whatsNewHeard(conversationId));
  const theirs = active.filter(e =>
    isVerified(e)
    && !heard.has(e.id)
    && !arrivedAfter(conversationId, e.verified.on));
  if (!theirs.length) return [];
  const caps = resolve(capabilities);
  return theirs.filter(e => liveHere(caps, e));
}

/** Has this person already been told something today? One a day, counted from the table. */
function toldToday(conversationId, now) {
  const last = db.lastWhatsNewTold(conversationId);
  return !!last && accounts.today(last) === accounts.today(now);
}

/**
 * The one entry to offer on THIS turn, or null. Every hold that is code's to keep is here.
 *
 *   - only on a turn somebody started. A timer firing, a watcher, a dropped thread, a task waking
 *     or a page tap all arrive as `kind: "event"`, and a line about a new feature on the back of a
 *     message Reason started is an unprompted announcement however casually it is phrased.
 *   - never while a confirm is open. Reason is waiting on a yes about something that matters;
 *     putting a second subject in that reply is how an answer lands on the wrong question. A
 *     confirmation that is never answered leaves this quiet for good, which is the safe direction.
 *   - one a day per person, and one per reply.
 */
export function offerFor({ conversationId, kind = "user", capabilities = [], now = clock.now() }) {
  if (kind !== "user") return null;
  // Nothing anybody could be told about. Checked first because it is free and, until something is
  // marked verified by hand, it is the answer on every turn.
  if (!active.some(isVerified)) return null;
  if (db.pendingConfirmations(conversationId).length) return null;
  if (toldToday(conversationId, now)) return null;
  return unheardFor({ conversationId, capabilities })[0] ?? null;
}

/**
 * What the turn tells the model, or "". Written as an instruction about the moment rather than a
 * line to send: the fact is here, the judgement is the model's, and the wording is its own.
 */
export function noteFor({ conversationId, kind = "user", capabilities = [], now = clock.now() }) {
  const entry = offerFor({ conversationId, kind, capabilities, now });
  if (!entry) return "";
  return `there is one new thing this person has not heard about yet, and it is live for them right now: ${entry.what}.`
    + ` If this moment suits, mention it in passing at the very end of your reply — one short line, your own words,`
    + ` the same lowercase texting voice as everything else you say. Never a list, never a pitch, never the point of the reply.`
    + ` Skip it entirely if the moment is wrong: they are upset, in a hurry, mid-errand, waiting on an answer from you,`
    + ` or this reply is bad news. If you do say it, call whats_new_said with id "${entry.id}" in the same turn.`
    + ` If you leave it out, do not call that tool and do not mention any of this — it will be offered to you again another time.`;
}

/**
 * Everything verified and live for this person, heard or not. What "what's new?" is answered from,
 * through the `capabilities` tool.
 */
export function liveFor({ conversationId, capabilities = [] }) {
  const heard = new Set(db.whatsNewHeard(conversationId));
  return active
    .filter(e => isVerified(e) && liveHere(capabilities, e))
    .map(e => ({ id: e.id, what: e.what, since: e.verified.on, already_told_them: heard.has(e.id) }));
}

/**
 * The model says its reply really does mention this one. Claimed here, written down by the runtime
 * once the reply has actually gone out — see `_turn` in src/runtime.js. A claim nothing was sent on
 * is dropped, so a turn that ended in silence or a failed send leaves the entry unheard.
 *
 * The id is checked against what this person is really eligible for rather than taken on trust, so
 * an id the model invented, one belonging to an unverified entry, one whose capability is not live
 * here, or one they have already heard records nothing.
 */
export function claimSaid({ conversationId, id, capabilities = [], now = clock.now() }) {
  const entry = active.find(e => e.id === id);
  if (!entry) return { ok: false, error: `There is nothing new called '${id}'. Say nothing about it.` };
  if (toldToday(conversationId, now)) {
    return { ok: false, error: `They have already been told about something new today, so this one is not yours to mention. Leave it out.` };
  }
  if (!unheardFor({ conversationId, capabilities }).some(e => e.id === id)) {
    return { ok: false, error: `'${id}' is not something to tell this person about right now. Leave it out of your reply.` };
  }
  const claimed = db.claimWhatsNew({ conversationId, entryId: id });
  if (!claimed) return { ok: false, error: `'${id}' was already recorded as told. Do not mention it again.` };
  return {
    ok: true,
    recorded: id,
    note: "Noted — once this reply actually goes out, they are down as having heard it and will never be told again."
      + " If your reply does not really say it, they will be told twice, so only call this when the line is in what you send.",
  };
}
