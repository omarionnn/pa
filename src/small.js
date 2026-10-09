// Start small: a big vague ask gets ONE useful first move, not a wall of plan.
//
// "I need to find a job" is the shape of ask that gets the worst answer. It is enormous, it is vague,
// and the obliging thing to do with it is produce a twelve-step career plan — which is impressive,
// takes a minute to read, and moves nothing. The useful answer is five roles that actually match,
// today, with the rest of it written down for later. Somebody who gets that can say "yes, more like
// the second one" and be somewhere; somebody who gets the plan has to read it first.
//
// So the rule is about SIZE and never about permission. Nothing here gates anything, nothing here
// asks for a yes, and holding the rest of the work on the sheet is not the same as not doing it —
// `first_move` names the step being taken and `left` holds the later ones, both of which come back on
// every wake. "Where were we" and the open page read the first move the same way they read anything
// else on the sheet.
//
// Default ON for everyone, and that is a decision rather than an accident: the cost of starting small
// on a job that wanted the whole plan is one extra message, and the cost of a wall of plan on a job
// that wanted one move is the person not using it. They can turn it off in plain words at any time
// ("just give me the whole plan", "stop drip-feeding me") and that is kept on their account with the
// sentence they said it in — the same place and shape as `notice_mode`, so there is one way to read
// "what are my settings" and one way to change them.
//
// This file reads a column and writes a sentence. It does not read their words to decide what they
// meant: the model does that and calls `start_small`.
import * as db from "./db.js";

/** On unless they said otherwise. Named so the default is one value in one place. */
export const DEFAULT_ON = true;

/**
 * Their setting, with the two things a person asking about it wants to know: whether it is on, and
 * whether that is their choice or a default nobody has confirmed with them.
 */
export function startSmallFor(conversationId) {
  const p = db.startSmallPrefs(conversationId);
  const theirs = p.on !== null;
  return {
    on: theirs ? !!p.on : DEFAULT_ON,
    theirs,
    isTheDefault: !theirs,
    said: p.said,
    at: p.at,
  };
}

/**
 * One line for the turn, saying which way this person has it.
 *
 * Turn-only, like the open-work and kept notes: it is a fact about the state of a setting right now,
 * and a copy of it in the thread's history would go on describing a setting they have since changed.
 * Read in BOTH backends (src/agent.js and src/backends/claude-cli.js) — the live Reason runs on the
 * CLI one, so a note only the API path carried would be a note nobody ever got.
 *
 * The behaviour itself is in the system prompt, which both backends share. This note carries only the
 * part that is per person, which is the part a static prompt cannot know.
 */
export function smallNote(conversationId) {
  const s = startSmallFor(conversationId);
  if (!s.on) {
    return `start small is OFF for them — they asked for that${s.said ? `: "${s.said}"` : ""}.`
      + ` So a big ask gets the whole thing: lay out the full plan rather than holding it back to one step,`
      + ` and do not offer to start small. That is their call and it stands until they say otherwise.`;
  }
  return `start small is ON for them${s.isTheDefault ? " (the default — they have not changed it)" : " — they asked for it back on"}.`
    + ` If what they just asked for is big and vague — "find me a job", "help me move", "sort my finances" —`
    + ` do ONE useful first move now (or offer that one move, if it needs them), put it on the job's sheet as`
    + ` first_move, and keep the rest in sheet.left as later steps. Not a plan of twelve things, not a menu.`
    + ` If their ask is already small and specific, this changes nothing: just do it.`;
}
