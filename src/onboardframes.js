// The code notes the first-chat onboarding (src/onboarding.js) puts in front of a to-do list for the
// real turn. No imports on purpose: src/harm.js reads them too, to keep them out of the screen.
/** The note the real turn gets with their to-do list. Code's line, so the history keeps it as such. */
export const TODO_FRAME = "[First chat: this is the to-do list they were asked for (a picture or typed). Read every item on it. Do now what you really can with your tools — reminders, lookups, drafts, plans, messages with their ok. For anything you cannot do yourself (laundry, chores, anything physical), set a reminder for it at a sensible time instead. Then reply in short plain lines: first what you handled, then what you only set reminders for, so the two are clearly separate. Never say something is done unless a tool did it this turn. No markdown, no bullets.]";
/** The same, for a list nobody asked for yet (it came before the to-do step). */
export const TODO_FRAME_UNASKED = TODO_FRAME.replace("this is the to-do list they were asked for (a picture or typed)", "they sent a to-do list (a picture or typed)");
