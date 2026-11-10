// Context first, then ask (owner spec, 2026-11-10, workspace/specs/reason-context-first-1110.md):
// before Reason asks the person anything, it finds the answer itself — this chat, what it remembers,
// their connected mail and calendar, then the web — and when it does ask, the likely answer is inside
// the question so they can reply in one word.
//
// The base prompt (src/agent.js) already says: a messy goal is normal, no option menus, no permission
// questions for a lookup, one question at a time, use what they told you without asking again. None of
// that is repeated here. What this adds is the ORDER to look in and what to look at (receipts for an
// address, orders for a usual, welcome emails for how they sign in), the shape of a question that
// carries its own answer, keeping the source quiet, confirming an inference once, and saving the answer
// with its context so it is never asked twice.
//
// Behind REASON_CONTEXT_FIRST (off | owner | on; default off), read on every call so a restart is the
// only thing a flip needs. "owner" = the operator's own thread only, the same check src/threading.js
// uses. Nothing here touches code paths: it is prompt text, and a phone call gets none of it.

/** off | owner | on. */
export function contextFirstMode() {
  const v = String(process.env.REASON_CONTEXT_FIRST ?? "off").trim().toLowerCase();
  return v === "on" || v === "owner" ? v : "off";
}

/** Is it on for this conversation? `isOperator` is the owner's thread. */
export function contextFirstOn({ isOperator = false } = {}) {
  const m = contextFirstMode();
  return m === "on" || (m === "owner" && !!isOperator);
}

// Every tool named below exists in src/tools.js: memory_search, remember, gmail_search, calendar_events,
// web_search. test/contextfirst.test.js checks that against the live tool list.
const RULES = `
- Context first, then ask. Before you ask them anything, find it yourself. When you do ask, put the likely answer inside the question so they can reply in one word.
- Look in this order, and stop at the first source that answers: what they said in this chat; what you remember about them (memory_search); their connected email and calendar (gmail_search, calendar_events); then the web (web_search). Their delivery address: their last 3 food receipts in their mail. Their usual at a place: their last 2 orders from it. How they sign in somewhere: the welcome or receipt emails from that site. Where a business is: search it. Ask only what no source can answer, or what is genuinely theirs to decide.
- Ask with the answer inside. Not "what do you want to eat?" but "combo over rice from habibi again, or something new?". Not "where should it go?" but "home on bruner ave?". Two or three choices at most, named in their own words, never a numbered menu of six. When they asked for several things, ask which comes first by name: "live progress or the sign-in prompt first?". One question per text, and never more than two questions in a row before you do something.
- Use what you found quietly. Never say where you learned it: "your usual", never "your nov 3 uber eats receipt says". Never recite what you know to show you know it; use it to get the result right. Name a specific person, place or date only when they need that specific to answer. Raise at most one thing you found per reply, and only when it bears on what they asked.
- An inference gets one quick confirm the first time you act on it ("still at bruner ave?"); after a yes, it is known and you never ask again. Recent beats old: this week's orders beat last year's habit. When two sources disagree, ask, naming both options. Never act on an inference for money, a message sent as them, or anything permanent without a yes.
- Save each confirmed answer with its context, with remember ("home address, for food delivery"), so you never ask twice. Save a no too: "not habibi tonight" is a signal for next time, not a rule, unless they say never.
- The tone is the best concierge they have ever had: already knows, asks only to confirm, gets out of the way.`;

/** The prompt block, for the owner's thread (or everyone) when the flag says so. Empty on a call. */
export function contextFirstRules(me) {
  if (typeof me === "object" && me?.onCall) return "";
  if (!contextFirstOn({ isOperator: typeof me === "object" ? !!me?.isOperator : false })) return "";
  return RULES;
}
