// How they want Reason to treat them — the one place every model that speaks for a person reads it.
//
// Their rules (`treat_rules`: the remember tool's how_to_treat_me on their own word, and the nightly
// review in src/dream.js) are corrections of how Reason behaves with them. Until 2026-11-08 only a text
// turn they started was shown them (src/memorynote.js): Claude's turn on a phone call, the GPT-Live voice,
// a reminder or check-in Reason wrote on its own (an event turn) and the Web daily greeting never were.
// Call 80 saved "on a call, just say the answer out loud…" and the next call would not have known it.
//
// Read fresh from the database on every call of `rulesNote` — at a turn's start, or a call's start —
// so a rule saved mid-call or right after one reaches the next turn and the next call. Only this
// conversation's own rules: nothing of one person's ever reaches another's prompt.
//
// Every prompt builder that speaks for a person is listed in `RULE_READERS`; test/rules-everywhere.test.js
// fails if one of them stops calling `rulesNote`, or if a new builder of a person's prompt appears
// without being listed (or listed as exempt, with why).
import * as db from "./db.js";
import { identityNote } from "./identity.js";

/** The heading the rules ride under, the same words everywhere. */
export const RULES_HEADING = "HOW THEY WANT YOU TO TREAT THEM (their own corrections of how you behave — follow these; a newer one wins):";

/** Their active rules, newest first, as plain strings (at most db.RULES_CAP). Never throws. */
export function rulesFor(conversationId, { limit = db.RULES_CAP } = {}) {
  if (!conversationId) return [];
  try {
    return db.activeRules(conversationId, { limit }).map(r => String(r.rule ?? "").replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The rules block for a prompt, or "" when they have none. The name they gave their Reason
 * (src/identity.js, REASON_ONE_IDENTITY) rides at its head: this is the one block every surface
 * reads — texts, Web, reminders, Claude's turn on a call, the live voice's brief — so the name is
 * the same on all of them, and a builder that carries their rules carries who Reason is to them.
 */
export function rulesNote(conversationId, opts = {}) {
  const rules = rulesFor(conversationId, opts);
  let who = "";
  try { who = identityNote(conversationId); } catch { who = ""; }
  return [who, rules.length ? `${RULES_HEADING}\n${rules.map(r => `- ${r}`).join("\n")}` : ""].filter(Boolean).join("\n");
}

/**
 * Every place a model is prompted for a person, and whether it carries their rules. `file` and `fn`
 * name the builder; the contract test reads that function's source for a `rulesNote(` call.
 * `exempt` says why one does not, and a builder may only be exempt for a reason of that kind.
 */
export const RULE_READERS = Object.freeze([
  { path: "text turn, API backend (their messages and Reason's own event turns, Web included)", file: "src/memorynote.js", fn: "memoryNotes" },
  { path: "text turn, API backend: event turns (reminders, check-ins, after-call notes)", file: "src/agent.js", fn: "runTurnOnTheirClock" },
  { path: "text turn, claude-cli backend (their messages, Web, and event turns)", file: "src/backends/claude-cli.js", fn: "runTurnOnCli" },
  { path: "Claude's turn on their own phone call", file: "src/calls/voice.js", fn: "ownerContext" },
  { path: "the GPT-Live voice on their own phone call", file: "src/calls/gptlive.js", fn: "briefSections" },
  { path: "the per-call notes a session opened before the call loads (rules + where they usually are)", file: "src/calls/callmemory.js", fn: "callNotes" },
  { path: "the Web daily edition's greeting", file: "src/daily.js", fn: "written" },
  { path: "the nightly memory review (reads and rewrites the rules themselves)", file: "src/dream.js", exempt: "it reviews the rules as its subject: they are its input, read with db.activeRules" },
  { path: "a call Reason makes to a business or another person", file: "src/calls/voice.js", fn: "thirdPartyContext", exempt: "sealed by design: the other side's call carries the goal and approved facts only, nothing of the person's memory" },
  { path: "somebody with no account ringing Reason's number", file: "src/calls/stranger.js", exempt: "no account, so nobody's rules" },
  { path: "onboarding's read of a new person's first texts (its one-line answers are said to them)", file: "src/onboarding.js", fn: "readText" },
  { path: "the Action Cards engine's one morning read (what to offer them, and the words on the card and in the text)", file: "src/actionengine.js", fn: "stage2" },
]);
