// The first conversation somebody new has with Reason (owner spec, 2026-10-30). They arrive from a
// button that opens Messages with "hey" in it; what comes back should feel like a friend picking up,
// never a form.
//
//   not_started          their first text → one opener asking their name (a question first gets a
//                        one-line answer, then the opener)
//   awaiting_name        name → saved; "nice to meet you", what Reason is, the contact card, what do you do
//   awaiting_occupation  their work → saved; 2–3 ways Reason helps with THAT work, then CLOSING
//   awaiting_todo        a picture of their to-do list → the real turn does what it can now and sets
//                        reminders for the rest, and says which is which
//   complete             done; nobody ever goes back in
//
// Rules that are code's, not the model's:
//   - Who is in it. Only a person whose account their own first text just made (auto-admit, or a
//     pre-approved number), on REASON_ONBOARDING. Everybody who existed when the column landed is
//     'complete' (src/db.js), every other way in (invites, events, the master's yes, Web) is exempt.
//   - The fixed bubbles below, one message each, a beat apart, and the card right after its line.
//   - A detour gets its one-line answer and ONE steer back to the step still pending; a second one
//     moves on rather than pushing. A declined name is never asked again (the prompt is told, too).
//   - Something real — a task, a lookup, a photo before the to-do step — ends the flow and gets the
//     normal turn, so the thing they asked for is done first.
//   - At most one nudge, ever, on the timer system, for somebody who went quiet mid-flow.
//
// What their text MEANS (a name? a question? a real ask? a no?) is the model's read, never a regex
// (owner rule): one structured side call on the subscription (askStructuredViaCli), never the API.
// If that read fails, the message gets the normal turn and the step is left where it was.
import * as db from "./db.js";
import { config, clock, normalizeNumber, stamp } from "./config.js";
import { askStructuredViaCli } from "./backends/cli.js";
import { offerContactCard, contactCardUrl, lineNumber } from "./contact.js";

export const STATES = ["not_started", "awaiting_name", "awaiting_occupation", "awaiting_todo", "complete"];
const ACTIVE = new Set(["not_started", "awaiting_name", "awaiting_occupation", "awaiting_todo"]);

/** The opener, one picked at random. One list; add a line here and it is in the rotation. */
export const OPENERS = [
  "oh I know that's right, what's up! I'm Reason, what's your name?",
  "ayy I know that's right. what's good, I'm Reason. who's this?",
  "okay I see you, what's up! I'm Reason, what do I call you?",
  "ooh I know that's right. hey, I'm Reason, what's your name?",
  "look at you texting me first. what's up, I'm Reason, what's your name?",
];
export const MET = (name) => name ? `nice to meet you, ${name}` : "all good, nice to meet you anyway";
export const WHAT_I_AM = "i'm basically a friend who handles stuff over text: reminders, plans, research, calls, directions, and remembering what matters to you";
export const CARD_ASK = "quick thing before we keep going: save my contact card so my links open properly";
export const OCCUPATION_ASK = "so what do you do? student, engineer, something else?";
/** The last line of step 3, word for word, every time. */
export const CLOSING = "or better yet, send me a picture of your to-do list and I'll knock them out right now.";
/** The one steer back to whatever is still pending, after a detour's answer. */
export const STEERS = {
  awaiting_name: "but wait, I didn't get your name",
  awaiting_occupation: "anyway, what do you do?",
  awaiting_todo: "anyway, whenever you're ready, send me that to-do list and I'll knock out what I can",
};
/** The one nudge, ever, for somebody who went quiet on that step. */
export const NUDGES = {
  awaiting_name: "hey, still here whenever. what should I call you?",
  awaiting_occupation: "no rush, but I'm still curious what you do. helps me know what'd actually be useful",
  awaiting_todo: "whenever you get a sec, send me a picture of your to-do list and I'll take what I can off it",
};
/** Said when they pass on the to-do list, or after the one steer has been used. */
export const LATER = "all good. whenever something comes up, just text me";
/** If the model gave no ideas for their work, these: true for anybody, and only what Reason does. */
export const GENERAL_IDEAS = [
  "I can keep track of deadlines and remind you at the right time, not just the day of",
  "I can look stuff up and come back with an actual pick, or make a call for you so you don't have to",
];

/** The note the real turn gets with their to-do list. Code's line, so the history keeps it as such. */
export const TODO_FRAME = "[First chat: this is the to-do list they were asked for (a picture or typed). Read every item on it. Do now what you really can with your tools — reminders, lookups, drafts, plans, messages with their ok. For anything you cannot do yourself (laundry, chores, anything physical), set a reminder for it at a sensible time instead. Then reply in short plain lines: first what you handled, then what you only set reminders for, so the two are clearly separate. Never say something is done unless a tool did it this turn. No markdown, no bullets.]";

// ---------- who is in it ----------

/** Does REASON_ONBOARDING cover this number? `test` = only REASON_ONBOARDING_NUMBERS. */
export function coversAddress(address) {
  if (config.onboarding === "on") return true;
  if (config.onboarding !== "test") return false;
  const a = normalizeNumber(address) || String(address ?? "").trim();
  return !!a && config.onboardingNumbers.some(n => (normalizeNumber(n) || n) === a);
}

/** Start it for a person whose account their first text just made. Never the operator. */
export function begin(conversationId) {
  const row = db.getAccount(conversationId);
  if (!row || row.is_operator || row.onboarding != null) return false;
  if (!coversAddress(row.address)) return false;
  db.setOnboarding(conversationId, { state: "not_started" });
  return true;
}

/** Is this person mid-flow, with the switch still covering them? */
export function active(conversationId) {
  const row = db.getAccount(conversationId);
  return !!row && !row.is_operator && ACTIVE.has(row.onboarding) && coversAddress(row.address);
}

export function finish(conversationId) {
  db.cancelOnboardingNudges(conversationId);
  return db.setOnboarding(conversationId, { state: "complete" });
}

// ---------- the read ----------

const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["greeting", "answer", "question", "decline", "task", "todo_list", "other"] },
    name: { type: "string" },
    occupation: { type: "string" },
    reply: { type: "string" },
    ideas: { type: "array", items: { type: "string" } },
  },
  required: ["kind", "name", "occupation", "reply", "ideas"],
};

const PENDING = {
  not_started: "Nothing yet — this is the very first text they have ever sent Reason. They came from a button that opens Messages with \"hey\" already typed.",
  awaiting_name: "Reason asked their name.",
  awaiting_occupation: "Reason asked what they do (student, engineer, something else).",
  awaiting_todo: "Reason suggested they send a picture of their to-do list so it can knock items out.",
};

/** What Reason really does, for the ideas. Nothing outside this list may be offered. */
const CAN = "set reminders and follow-ups at real times; keep track of deadlines and open to-dos; look things up and come back with an actual pick (restaurants, products, flights, places); research a question and write it up as a page; make phone calls for them (book, ask, sort something out); text people for them, with their ok; plan things with friends; walking directions; remember what matters about people and dates; draft messages and emails; read photos and documents they send";

export function instructions(state) {
  return `You read one text from a person in their first ever chat with Reason, an assistant that lives in their iMessage. What Reason last asked: ${PENDING[state] ?? PENDING.not_started}

Decide what the text is, by its meaning:
- "greeting": just a hello, nothing else in it.
- "answer": it answers what Reason asked. For their name, put the name they want to be called in "name" — only if they really told you one; a greeting word, slang or "me" is not a name. For what they do, put it in "occupation" in a few words (their words, e.g. "nursing student").
- "question": a question or remark Reason can answer in one short line from what it knows (about Reason itself, small talk, general knowledge). Nothing that needs looking up, checking or doing.
- "decline": they would rather not answer what was asked, or pass on it.
- "task": they want something real done or looked up now (a reminder, a search, a plan, a call, the weather, anything needing a tool), or the message needs care (someone upset, in crisis, anything harmful or sensitive). When in doubt between question and task, it is a task.
- "todo_list": a list of things they need to do, typed out.
- "other": anything else (an emoji, "lol", "ok").
A text can answer AND ask: then kind is "question" with the answer's field filled too, unless the ask is a task.

"reply": for "question" and "other", one short line that answers or responds naturally (under 160 characters). Empty for every other kind. Friendly, a bit playful, lowercase is fine. No markdown, no emoji spam, never corporate. Never quote words for them to say or type; say what you mean instead. Never claim to have done anything. The reply only answers: never ask them anything, never bring up their name, their job, a to-do list or saving a contact — Reason adds the way back to its question itself, right after your line. If they ask what Reason is: a friend who handles stuff over text (reminders, plans, research, calls, directions, remembering what matters). If they ask who built it: Omarion Nyarko.

"ideas": only when Reason asked what they do and you can tell something about their work or life from the text (including a decline — then ideas for anybody): 2 or 3 short lines, each one concrete way Reason could help with THAT work, each under 140 characters, each starting with "I can" or similar. Only from what Reason really does: ${CAN}. Never anything else, never flattering or patronizing (no "that's amazing", no "must be tough"), no markdown, no bullets, no emoji, no quoting words for them to type. Otherwise an empty list.

Fields you have nothing for are "" (or [] for ideas).`;
}

const clean = (s, max) => String(s ?? "").replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

/** One read of their text for this step, or null when the read could not be had. */
export async function readText({ state, text, ask = askStructuredViaCli }) {
  if (ask === askStructuredViaCli && (process.env.REASON_BACKEND !== "claude-cli" || process.env.NODE_TEST_CONTEXT)) return null;
  const r = await ask({
    prompt: `Their text, verbatim:\n${String(text ?? "").slice(0, 2_000)}`,
    system: instructions(state),
    schema: SCHEMA,
    model: process.env.REASON_ONBOARDING_CLI_MODEL || "haiku",
    timeoutMs: Number(process.env.REASON_ONBOARDING_CLI_TIMEOUT_MS || 25_000),
    feature: "onboarding",
  });
  const v = r?.value;
  if (!v || !SCHEMA.properties.kind.enum.includes(v.kind)) return null;
  return {
    kind: v.kind,
    name: clean(v.name, 40),
    occupation: clean(v.occupation, 120),
    reply: clean(v.reply, 220),
    ideas: (Array.isArray(v.ideas) ? v.ideas : []).map(i => clean(String(i).replace(/^\s*(?:[-•]|\d+[.)])\s*/, ""), 180)).filter(Boolean).slice(0, 3),
  };
}

// ---------- sending ----------

const pause = () => config.onboardingGapMs + Math.floor(Math.random() * 600);
const realSleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.());

/** Can the card go right now? Only then is its line said: a line about a card that never comes is a lie. */
function cardReady(router, account) {
  if (!account || account.contact_card_sent_at) return false;
  if (!account.channel || account.channel === "console") return false;
  if (!contactCardUrl({ router, channel: account.channel })) return false;
  return !!lineNumber(router, account.channel);
}

/**
 * The bubbles, one message each, a beat apart, in order. `{ card: true }` in the list is Reason's
 * contact card, sent the moment its line has gone. Returns what was said, for the model's history.
 */
async function sendBubbles({ router, conversationId, route, bubbles, key, sleep, log }) {
  const said = [];
  let first = true;
  for (const [i, b] of bubbles.entries()) {
    if (!first) await sleep(pause());
    first = false;
    if (b?.card) {
      const card = await offerContactCard({ router, account: db.getAccount(conversationId), log, line: "" });
      if (card.outcome === "sent") said.push("[sent them Reason's contact card]");
      else log({ onboarding_card: card.outcome, why: card.why ?? null, conversation: conversationId });
      continue;
    }
    const r = await router.send({
      channel: route.channel, to: route.to, chatId: route.chatId ?? null, text: b,
      conversationId, toOwner: true, idempotencyKey: `${key}#${i + 1}`,
    }).catch(e => ({ ok: false, error: e?.message }));
    if (!r?.ok && !r?.queued) log({ onboarding_send_failed: conversationId, n: i + 1, why: r?.error ?? "unknown" });
    said.push(b);
  }
  return said;
}

/** Their text and what Reason said, on the model's thread, so the next real turn knows. */
function remember(conversationId, name, text, said) {
  const messages = db.loadConversation(conversationId);
  messages.push({ role: "user", content: `[${stamp()}] ${name || "them"}: ${text}` });
  if (said.length) messages.push({ role: "assistant", content: said.join("\n\n") });
  db.saveConversation(conversationId, messages);
}

/** The one nudge, on the timer system, at a waking hour; only ever if none has gone. */
export function scheduleNudge(conversationId, now = clock.now()) {
  db.cancelOnboardingNudges(conversationId);
  const row = db.getAccount(conversationId);
  if (!row || row.onboarding_nudged_at || !ACTIVE.has(row.onboarding) || row.onboarding === "not_started") return null;
  if (!(config.onboardingNudgeMin > 0)) return null;
  const fireAt = wakingHour(now + config.onboardingNudgeMin * 60_000);
  return db.createTimer(conversationId, { fireAt, note: "first-chat nudge", label: db.ONBOARDING_NUDGE_LABEL });
}

/** The same moment, or 10am the next morning when it would land between 9pm and 10am. */
export function wakingHour(at, tz = config.tz) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit" }).format(at));
  if (hour >= 10 && hour < 21) return at;
  const ahead = hour >= 21 ? 24 - hour + 10 : 10 - hour;
  return at + ahead * 3_600_000 - (at % 3_600_000);
}

/**
 * The nudge timer firing (Runtime._runTimer). Says the pending step's nudge once, ever, if they are
 * still on that step; otherwise nothing. Returns the send's result, or null when nothing was owed.
 */
export async function fireNudge({ timer, router, key, log = () => {} }) {
  const row = db.getAccount(timer.conversation_id);
  if (!row || row.onboarding_nudged_at || !NUDGES[row.onboarding] || !coversAddress(row.address) || !router) return null;
  db.setOnboarding(row.conversation_id, { nudged: true });
  const thread = db.getThread?.(row.conversation_id) ?? null;
  const text = NUDGES[row.onboarding];
  const r = await router.send({
    channel: row.channel, to: row.address, chatId: thread?.chat_id ?? null, text,
    conversationId: row.conversation_id, toOwner: true, idempotencyKey: key,
  }).catch(e => ({ ok: false, error: e?.message }));
  const messages = db.loadConversation(row.conversation_id);
  messages.push({ role: "assistant", content: text });
  db.saveConversation(row.conversation_id, messages);
  log({ onboarding_nudge: row.conversation_id, step: row.onboarding, ok: r?.ok !== false });
  return r;
}

// ---------- one message, at whatever step they are on ----------

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * One drained message (or burst) from somebody mid-flow. Returns `{ handled: true, step }` when the
 * flow answered it with its own bubbles, or `{ handled: false, frame? }` when the normal turn should
 * answer it (with `frame` put in front of their text for the to-do list).
 */
export async function handle({ router, conversationId, route, texts = [], attachments = [], ask = askStructuredViaCli, sleep = realSleep, log = () => {} }) {
  const row = db.getAccount(conversationId);
  const state = row?.onboarding;
  if (!row || !ACTIVE.has(state)) return { handled: false };
  db.cancelOnboardingNudges(conversationId);
  const text = texts.filter(Boolean).join("\n").trim();

  // A picture is something real: the to-do list on its step, before that whatever they sent it for.
  if (attachments.length) {
    finish(conversationId);
    const todo = state === "awaiting_todo" && attachments.some(a => a?.kind === "image");
    log({ onboarding: conversationId, from: state, to: "complete", why: todo ? "todo_photo" : "attachment" });
    return { handled: false, ...(todo ? { frame: TODO_FRAME } : {}) };
  }

  const read = await readText({ state, text, ask });
  if (!read) {
    log({ onboarding_read_failed: conversationId, step: state });
    return { handled: false };
  }
  log({ onboarding_read: conversationId, step: state, kind: read.kind });

  let name = row.name || "";
  if (read.name && (state === "not_started" || state === "awaiting_name")) {
    db.setAccountName(conversationId, read.name);
    name = read.name;
  }
  if (read.occupation && state === "awaiting_occupation" && name) db.remember(conversationId, name, `works as / does: ${read.occupation}`, { source: "user_stated" });
  else if (read.occupation && state === "awaiting_occupation") db.remember(conversationId, "me", `works as / does: ${read.occupation}`, { source: "user_stated" });

  // Something real ends it, and the normal turn does the thing first.
  if (read.kind === "task" || (read.kind === "todo_list")) {
    finish(conversationId);
    log({ onboarding: conversationId, from: state, to: "complete", why: read.kind });
    return { handled: false, ...(read.kind === "todo_list" ? { frame: TODO_FRAME } : {}) };
  }

  const detour = read.kind === "question" || read.kind === "other" || (read.kind === "greeting" && state !== "not_started");
  const replyLine = detour && read.reply ? [read.reply] : [];
  const steered = row.onboarding_steers ?? 0;
  let bubbles = [];
  let next = state;

  const step2 = (who) => {
    const card = cardReady(router, db.getAccount(conversationId));
    return [MET(who), WHAT_I_AM, ...(card ? [CARD_ASK, { card: true }] : []), OCCUPATION_ASK];
  };
  const step3 = (ideas) => [...(ideas.length >= 2 ? ideas : GENERAL_IDEAS), CLOSING];

  if (state === "not_started") {
    // Their name already in the first text ("hey it's kofi"): never asked for again.
    if (read.name) { bubbles = [...(read.kind === "question" ? replyLine : []), ...step2(read.name)]; next = "awaiting_occupation"; }
    else { bubbles = [...(read.kind === "question" ? replyLine : []), pick(OPENERS)]; next = "awaiting_name"; }
  } else if (state === "awaiting_name") {
    if (read.kind === "answer" && read.name) { bubbles = [...replyLine, ...step2(read.name)]; next = "awaiting_occupation"; }
    else if (read.kind === "decline") { bubbles = step2(""); next = "awaiting_occupation"; }
    else if (read.name) { bubbles = [...replyLine, ...step2(read.name)]; next = "awaiting_occupation"; }
    else if (!steered) { bubbles = [...replyLine, STEERS.awaiting_name]; }
    else { bubbles = [...replyLine, ...step2("")]; next = "awaiting_occupation"; }
  } else if (state === "awaiting_occupation") {
    if (read.kind === "answer" || read.kind === "decline" || read.occupation) { bubbles = [...replyLine, ...step3(read.ideas)]; next = "awaiting_todo"; }
    else if (!steered) { bubbles = [...replyLine, STEERS.awaiting_occupation]; }
    else { bubbles = [...replyLine, ...step3(read.ideas)]; next = "awaiting_todo"; }
  } else if (state === "awaiting_todo") {
    if (read.kind === "decline" || read.kind === "answer") { bubbles = [LATER]; next = "complete"; }
    else if (!steered) { bubbles = [...replyLine, STEERS.awaiting_todo]; }
    else { bubbles = replyLine.length ? replyLine : [LATER]; next = "complete"; }
  }

  // Written before the sends, so a second text racing these bubbles reads the step they are on.
  if (next === "complete") finish(conversationId);
  else if (next !== state) db.setOnboarding(conversationId, { state: next, nameAsked: next === "awaiting_name" || state === "awaiting_name" });
  else db.setOnboarding(conversationId, { steers: steered + 1 });
  log({ onboarding: conversationId, from: state, to: next, bubbles: bubbles.length });

  const said = await sendBubbles({ router, conversationId, route, bubbles, key: `onboard:${conversationId}:${state}:${clock.now()}`, sleep, log });
  remember(conversationId, name, text, said);
  if (next !== "complete") scheduleNudge(conversationId);
  return { handled: true, step: next, said };
}
