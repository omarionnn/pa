// The first conversation somebody new has with Reason. Owner spec 2026-10-30, cut down 2026-11-06:
// a 7-day review found new people left during a 3–5 question interview, so the first chat is now
// a few beats and nothing else — who Reason is and their name, what their name means, what they
// want to call Reason, the contact card under THAT name for them to save, and one thing to try.
//
//   not_started         their first text → the opener: who Reason is, and their name (a question
//                       first gets a one-line answer, then the opener; a name already in it skips the ask)
//   awaiting_name       name → saved; what it means and one warm word about it (the model's own
//                       knowledge, never invented), then "what do you want to call me?"
//   awaiting_card_name  the name they pick → the contact card under it, inviting them to save it,
//                       then the Amazon offer (below), or straight to ONE nudge: a call Reason can
//                       make for them, or an event; done. Skipped, "whatever", "you pick" → the card
//                       as Reason.
//   awaiting_amazon     OPTIONAL, REASON_INTRO_AMAZON=on only (off by default): one Amazon connect
//                       offer after the card (src/amazonconnect.js owns the step; this is only the
//                       hook — remove the AMAZON HOOK lines to take it out). Yes → the link, then the
//                       try line; anything else → the try line. Asked once, never nudged. The web
//                       setup's hand-off (webHandoff) lands here too, unless Amazon was connected on
//                       the page (per connection: skipped or failed there → offered here, the same way).
//   awaiting_first      REASON_WELCOME_CARDS=on, web setup only: the hand-off was the welcome (a line
//                       picking up from the page, the seven cards, "what would you like help with
//                       first?"). Their first reply goes to the normal turn; after its answer, the card
//                       under the page's name, then the Amazon offer or done (webCardAfter).
//   complete            done; nobody ever goes back in
//
// The welcome cards (src/welcome.js), REASON_WELCOME_CARDS=on only: for somebody who texted first,
// they go right after who Reason is (INTRO, or BY_THE_WAY after a first request) and before the name
// question; the try line at the end becomes "what would you like help with first?". Once per person
// (accounts.welcome_cards); event joiners keep their own start.
//
// Reason never says it saves itself in their phone or is in their contacts: it cannot touch their
// phone. The card is sent; saving it is theirs.
//
// Rules that are code's, not the model's:
//   - Who is in it. Only a person whose account their own first text just made (auto-admit, or a
//     pre-approved number), or whose account an event join just made (src/channels/router.js
//     #claimEvent — this replaces the event's old card + question follow-up), or whose account an
//     invite claim just made (after the inviter's welcome line). Everybody who
//     existed when the column landed is 'complete' (src/db.js), and every account made since starts
//     NULL, which is exempt: an existing account never sees this. The owner's number never does.
//   - The fixed bubbles below, one message each, a beat apart, and the card on its own line's message.
//   - A detour gets its one-line answer and ONE steer back to the step still pending; a second one
//     moves on rather than pushing. A declined name is never asked again (the prompt is told, too).
//   - A real request is never kept waiting: the normal turn does it first, and the pending step's
//     question follows that reply (afterTask) — the same one-steer limit applies.
//   - At most one nudge, ever, on the timer system, for somebody who went quiet mid-flow.
//   - Reason's own name does not change: the name they pick is the card's, and the thread's note.
//
// What their text MEANS (a name? a question? a real ask? a no?) is the model's read, never a regex
// (owner rule): one structured side call (src/backends/side.js askStructured): the subscription on
// claude-cli, the API key on api. If that read fails — or the harm screen, run beside it, says
// anything but clear — the flow ends there and the message gets the normal, screened turn (with the
// prompt told this is a first chat, so the model never starts an interview of its own).
//
// A step is one transaction: its bubbles queued in the outbox as one ordered chain (the card on the
// same message as its line) AND the new state, together. A restart between the two cannot leave a
// step recorded that nobody was sent, or bubbles sent for a step not recorded; the outbox finishes
// the chain in order after a retry or a restart.
import { makerName } from "./maker.js";
import { reconnectLine } from "./strangercalls.js";
import * as db from "./db.js";
import * as outbox from "./outbox.js";
import { config, clock, normalizeNumber, normalizeHandle, stamp } from "./config.js";
import { askStructured, sideAskAllowed } from "./backends/side.js";
import { rulesNote } from "./rules.js";
import { contactCardUrl, lineNumber, RETRY_AFTER_MS, cardName, nameCase, DEFAULT_CARD_NAME } from "./contact.js";
import { zoneFor } from "./zone.js";
import * as amazon from "./amazonconnect.js"; // AMAZON HOOK
import * as shop from "./shopconnect.js"; // AMAZON HOOK: connected on the web setup → no offer
import * as setups from "./websetupstore.js";
import * as welcome from "./welcome.js";
import { inviterName } from "./invites.js";

export const STATES = ["not_started", "awaiting_first", "awaiting_name", "awaiting_card_name", "awaiting_amazon", "complete"];
const ACTIVE = new Set(["not_started", "awaiting_first", "awaiting_name", "awaiting_card_name", "awaiting_amazon"]);

/** Who Reason is, in the owner's words (2026-11-06). */
export const INTRO = "hey, i'm Reason. i will help you with errands and complete your to do list for you";
/** The name question: alone in its own bubble, right after who Reason is (owner, 2026-11-07). */
export const NAME_Q = "what's your name?";
/** The opener: who Reason is, then their name, as two bubbles in that order. One question. */
export const OPENER = [INTRO, NAME_Q];
/** Who Reason is when it is not their first hello (after a request was handled), and the name ask then (two bubbles). */
export const BY_THE_WAY = "by the way, i'm Reason. i will help you with errands and complete your to do list for you";
export const NAME_ASK = [BY_THE_WAY, NAME_Q];
/**
 * Their name, met. The real line is the model's (`name_line`: what a given name means and one warm
 * word about it, or for a nickname just a warm word about loving it); this is only what is said
 * when that line could not be had, or they passed.
 */
export const MET = (name) => name ? `nice to meet you, ${nameCase(name)}` : "all good, nice to meet you anyway";
/** The ask for the name on the card: exactly this, nothing else in the bubble (owner wording). */
export const CARD_NAME_ASK = "what do you want to call me?";
/** The line on the card's own message: the card is theirs to save. Never a claim it is saved. */
export const CARD_SENT = (name, picked) => `${picked ? `${name} it is.` : `${DEFAULT_CARD_NAME} it is.`} here's my card, save it so you can always find me`;
/** The one thing to try, right after the card (or after their name, when no card can go): a call, or an event. */
export const TRY_LINE = "something to try: i can make a call for you, like booking a restaurant, checking a store, setting up an appointment or sorting something out while you get on with your day. or i can help you set up and run an event. want to try one?";
/**
 * The welcome gallery (src/welcome.js, REASON_WELCOME_CARDS=on): the seven cards right after who
 * Reason is, before its question. Who got them is kept on the account (welcome_cards: 'direct' or
 * 'web'), so the flow's last line fits: after the cards, "what would you like help with first?"
 * stands in for the try line (they have seen what to try); somebody from the web setup was already
 * asked it before their card, so nothing more is asked.
 */
const withCards = (router, route, intro, conversationId) =>
  welcome.forEveryone() && route && !db.getAccount(conversationId)?.welcome_cards ? [intro, ...welcome.bubbles(router, route.channel)] : [intro];
const cardsIn = (bubbles) => bubbles.some(b => b?.welcome);
export function tryLine(conversationId) {
  const w = db.getAccount(conversationId)?.welcome_cards ?? null;
  return w === "web" ? null : w === "direct" ? welcome.HELP_FIRST : TRY_LINE;
}
const tail = (conversationId) => { const t = tryLine(conversationId); return t ? [t] : []; };

/** The one steer back to whatever is still pending, after a detour's answer. */
export const STEERS = {
  awaiting_name: "but wait, i didn't get your name",
  awaiting_card_name: "anyway, what do you want to call me?",
};
/** The one nudge, ever, for somebody who went quiet on that step. */
export const NUDGES = {
  awaiting_name: "hey, still here whenever. what's your name?",
  awaiting_card_name: "still here whenever. what do you want to call me?",
};

/** A flow nobody has answered for this long is over: a late "ok" is not an answer to a step. */
export const IDLE_MS = () => config.onboardingIdleDays * 24 * 3_600_000;
/** Attachments that are words by the time the flow reads them (heard, read, or a link). */
const WORDS = new Set(["voice", "contact", "link"]);

// ---------- who is in it ----------

/** Does REASON_ONBOARDING cover this number? `test` = only REASON_ONBOARDING_NUMBERS. */
export function coversAddress(address) {
  if (config.onboarding === "on") return true;
  if (config.onboarding !== "test") return false;
  const a = normalizeHandle(address) || String(address ?? "").trim();
  return !!a && config.onboardingNumbers.some(n => (normalizeHandle(n) || n) === a);
}

/** Start it for a person whose account was just made (their first text, or an event join). Never the operator. */
export function begin(conversationId) {
  const row = db.getAccount(conversationId);
  if (!row || row.is_operator || row.onboarding != null) return false;
  if (!coversAddress(row.address)) return false;
  db.setOnboarding(conversationId, { state: "not_started" });
  return true;
}

/**
 * Is this person mid-flow, with the switch still covering them? A flow idle past IDLE_MS is ended
 * here (state 'complete'), so nothing after a week of silence is read as an answer to a step. A
 * state from the longer flow before 2026-11-06 is not this flow's, and ends too.
 */
export function active(conversationId, now = clock.now()) {
  const row = db.getAccount(conversationId);
  if (!row || row.is_operator || row.onboarding == null || row.onboarding === "complete") return false;
  if (!ACTIVE.has(row.onboarding)) { finish(conversationId); return false; }
  if (!coversAddress(row.address)) return false;
  if (row.onboarding_at && now - row.onboarding_at > IDLE_MS()) {
    finish(conversationId);
    return false;
  }
  return true;
}

export function finish(conversationId) {
  db.cancelOnboardingNudges(conversationId);
  return db.setOnboarding(conversationId, { state: "complete" });
}

// ---------- the read ----------

const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["greeting", "answer", "question", "decline", "task", "other"] },
    name: { type: "string" },
    card_name: { type: "string" },
    reply: { type: "string" },
    name_line: { type: "string" },
    amazon: { type: "string", enum: ["yes", "no", ""] },
  },
  required: ["kind", "name", "card_name", "reply", "name_line", "amazon"],
};

const PENDING = {
  not_started: "Nothing yet — this is the very first text they have ever sent Reason.",
  awaiting_name: "Reason introduced itself and asked their name.",
  awaiting_card_name: "Reason asked what they want to call it — the name its contact card will carry (Reason, or anything they like).",
  awaiting_amazon: "Reason sent its contact card (their name and the name they chose for Reason are already settled, whether in this chat or on Reason's website setup), then offered (optional) to connect their Amazon account so it can keep an eye on their orders and help them reorder, and asked if they want the link.",
};

/** How the model meets a name: shared by the read and the stand-alone line (nameLine). */
const NAME_RULE = `first judge, by its meaning, whether what they gave is their given name or a nickname they go by (a pet name like Bubba or Boo, initials like JJ, a Lil or Big name like Lil Mike or Big T, a gamer tag or handle). A short form of a given name (Mike, Liz) counts as a given name: the full name's meaning only if you are sure, else just warm. A nickname gets no meaning and no origin at all: just a few warm words about loving the name, using it, varied and natural (e.g. "love that name, bubba", "big t, i like that", "jj, great name"). A given name gets what the name means or where it comes from, then one quality from that meaning as a short, warm compliment to them (e.g. for Omar: it means long-lived or flourishing, it's Arabic, and it's tied to leadership — "suits someone who leads"). One or two short sentences, under 160 characters, all lowercase like a text from a friend (their name too), use their name, at most one exclamation mark. Only a meaning you really know: if you are not sure, or the meaning is awkward or negative, leave the meaning out and just say nice to meet you with their name, plus at most a few warm words about the name itself. Never invent a meaning, and never guess a language or origin. A name tied to a painful history gets nothing about the name at all, just nice to meet you with their name. No filler about the chat or their day (nothing like glad we're connecting, hope this is the start of something, hope your day is going well, looking forward to getting to know you). No question in it, no mention of Reason, the contact card or their phone.`;

export function instructions(state) {
  return `You read one text from a person in their first ever chat with Reason, an assistant that lives in their iMessage. What Reason last asked: ${PENDING[state] ?? PENDING.not_started}

Decide what the text is, by its meaning:
- "greeting": just a hello, nothing else in it.
- "answer": it answers what Reason asked. For their name, put the name they want to be called in "name", as they wrote it — only if they really told you one; a nickname, initials or a handle they go by is a name, but a greeting word, slang or "me" is not. For the contact's name, put the name they chose for Reason in "card_name", as they wrote it (e.g. "Jarvis", "my assistant", "Reason"). If they leave it to Reason ("whatever", "you pick", "idk", "doesn't matter"), kind is "decline" and "card_name" is "".
- "question": a question or remark Reason can answer in one short line from what it knows (about Reason itself, small talk, general knowledge). Nothing that needs looking up, checking or doing.
- "decline": they would rather not answer what was asked, or pass on it, or leave the choice to Reason.
- "task": they want something real done or looked up now (a reminder, a search, a plan, a call, the weather, a to-do list, anything needing a tool), or the message needs care (someone upset, in crisis, anything harmful or sensitive). When in doubt between question and task, it is a task.
- "other": anything else (an emoji, "lol", "ok").
A text can answer AND ask: then kind is "question" with the answer's field filled too, unless the ask is a task.

"amazon": only when Reason last offered the Amazon link. "yes" when they want it, however they say it (sure, ok, go ahead, send it, a thumbs up); kind is then "answer". "no" when they would rather not, don't use Amazon, or not now; kind is then "decline". "" when it is neither (a question about it, something else, unsure). Every other step: "".

"name_line": only when "name" is filled: ${NAME_RULE}

"reply": for "question" and "other", one short line that answers or responds naturally (under 160 characters). Empty for every other kind. Friendly, a bit playful, lowercase is fine. No markdown, no emoji spam, never corporate. Never quote words for them to say or type; say what you mean instead. Never claim to have done anything. Never say Reason saves itself in their phone, is in their contacts, or can touch their phone in any way: it cannot. The reply only answers: never ask them anything, never bring up their name or the contact card — Reason adds the way back to its question itself, right after your line. If they ask what Reason is: it helps with errands and gets their to do list done for them, over text (it can make calls for them, help set up and run an event, reminders, plans, research). If they ask who built it: ${makerName()}.

Fields you have nothing for are "".`;
}

/**
 * The model's line meeting a name it did not read itself (the name typed on an event page, or one
 * given inside a request): what the name means and one warm word. Null when it cannot be had; the
 * caller then says MET(name).
 */
export async function nameLine({ name, ask = askStructured, web = false }) {
  if (!name) return null;
  if (ask === askStructured && !sideAskAllowed()) return null;
  const r = await ask({
    prompt: `Their name: ${String(name).slice(0, 40)}`,
    system: `Reason, an assistant that lives in someone's texts, is meeting a new person for the first time. Write one line meeting their name: ${NAME_RULE} A nickname or handle they go by is a name. If what they gave is not really a name (a joke, slang, "idk"), leave it out and just say nice to meet you.${web ? WEB_LINE_RULE : ""}`,
    schema: { type: "object", properties: { line: { type: "string" } }, required: ["line"] },
    model: process.env.REASON_ONBOARDING_CLI_MODEL || "haiku",
    timeoutMs: Number(process.env.REASON_ONBOARDING_CLI_TIMEOUT_MS || 25_000),
    feature: "onboarding",
  }).catch(() => null);
  return clean(r?.value?.line, 240) || null;
}

/** The web setup's page shows the line after "kofi — " (src/websetup.js webLine), so it never opens with the name. */
const WEB_LINE_RULE = ` This line is shown on a web page right after their name and a dash (like "kofi — born on a friday. good start."), so do not start with their name or with nice to meet you: start with the meaning, then a short warm word. For a nickname or a name you have no sure meaning for, give only a few warm words about the name.`;

// Markdown marks out; an underscore inside a word stays (a handle like Xx_Slayer_xX is their name).
// A field the model filled with only quote marks or punctuation (the sealed CLI's haiku sent back the
// two-character text `""` for "no name" on 2026-11-10) is empty. A name in quotes loses the quotes;
// a line keeps its own.
const clean = (s, max, { name = false } = {}) => {
  let v = String(s ?? "").replace(/[*`#]|(?<!\w)_|_(?!\w)/g, "").replace(/\s+/g, " ").trim();
  if (name) v = v.replace(/^["'“”‘’]+([^"“”]*?)["'“”‘’]+$/u, "$1").trim();
  return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(v) ? v.slice(0, max) : "";
};

/** One read of their text for this step, or null when the read could not be had. */
export async function readText({ state, text, ask = askStructured, conversationId = null }) {
  if (ask === askStructured && !sideAskAllowed()) return null;
  // Its one-line answer to a question is Reason speaking to them, so their rules ride too (src/rules.js).
  const rules = rulesNote(conversationId);
  const r = await ask({
    prompt: `Their text, verbatim:\n${String(text ?? "").slice(0, 2_000)}${rules ? `\n\n${rules}` : ""}`,
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
    // Their name is kept with a capital on each word (Omari, 2026-11-09); the card's name gets it in cardName.
    name: nameCase(clean(v.name, 40, { name: true })),
    cardName: clean(v.card_name, 40, { name: true }),
    reply: clean(v.reply, 220),
    nameLine: clean(v.name_line, 240),
    amazon: v.amazon === "yes" || v.amazon === "no" ? v.amazon : "",
  };
}

// ---------- sending ----------

const pause = () => config.onboardingGapMs + Math.floor(Math.random() * 600);
const realSleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.());

/**
 * Can a card go to this account at all right now? Not when it was already sent, not when a try
 * failed inside the retry window (contact.js RETRY_AFTER_MS), not without a public address or a
 * line number. When it cannot, its name is not asked either: there would be nothing to name.
 */
export function cardCanGo(router, account, now = clock.now()) {
  if (!account || account.contact_card_sent_at) return false;
  if (account.contact_card_tried_at && now - account.contact_card_tried_at < RETRY_AFTER_MS) return false;
  if (!account.channel || account.channel === "console") return false;
  if (!lineNumber(router, account.channel)) return false;
  return !!contactCardUrl({ router, channel: account.channel });
}

/** The card's address under the name they picked (a token is made for it), or null when none can go. */
export function cardUrl(router, account, name = DEFAULT_CARD_NAME, now = clock.now()) {
  if (!cardCanGo(router, account, now)) return null;
  const { token } = db.setContactCardName(account.conversation_id, cardName(name));
  return contactCardUrl({ router, channel: account.channel, name: cardName(name), token });
}

const live = (router, channel) => router?.get?.(channel)?.status?.().status === "live";

/**
 * One step, committed: the bubbles queued as one ordered outbox chain (each row after the one
 * before), the step's state, and the model's history, in ONE transaction. Then each row is tried
 * in turn, a beat apart; the first that does not go stops the loop, and the sweep sends the rest in
 * order once it does (outbox `after_id`). Returns what was said.
 */
async function commitStep({ router, conversationId, route, bubbles, key, write, historyLines, sleep, log }) {
  const rows = [];
  const canSend = live(router, route.channel);
  // Nothing can go: the step stays where it is, and nothing is written as said that was not.
  if (!canSend) { log({ onboarding_not_sent: conversationId, why: `${route.channel} is not connected` }); return []; }
  const said = bubbles.map(b => typeof b === "string" ? b : (b.text || (b.media?.fallbackText ? `[picture card] ${b.media.fallbackText}` : b.media?.historyText ?? "")));
  // An earlier step still being sent (a card held on a retry): this one queues behind it and the
  // outbox sends it in order, so a quick reply's answer never lands in the middle of the gallery.
  const behind = db.pendingOnboardingTail(conversationId);
  db.atomically(() => {
    let previous = behind;
    if (canSend) {
      for (const [i, b] of bubbles.entries()) {
        const { row } = db.enqueueOutbound({
          idemKey: `${key}#${i + 1}`, conversationId, channel: route.channel, address: route.to, chatId: route.chatId ?? null,
          body: typeof b === "string" ? b : b.text, media: b?.media ?? (b?.mediaUrl ? { mediaUrl: b.mediaUrl } : null),
          afterId: previous, toOwner: true, maxAttempts: config.outboxMaxAttempts,
        });
        rows.push({ row, card: !!b?.mediaUrl });
        // The card is a branch off the chain, not a link in it: a card that dies for good
        // (markOutboundFailed fails everything chained behind a dead row) takes nothing with it.
        if (!b?.mediaUrl) previous = row.id;
      }
      if (rows.some(r => r.card)) db.markContactCardTried(conversationId);
    }
    write();
    const messages = db.loadConversation(conversationId);
    messages.push(...historyLines(said));
    db.saveConversation(conversationId, messages);
  });
  if (behind) { log({ onboarding_send_held: conversationId, why: "an earlier step is still going out", after: behind }); return said; }
  for (const [i, { row, card }] of rows.entries()) {
    // The welcome cards go back to back, so iMessage stacks them; every other bubble a beat apart.
    if (i) await sleep(bubbles[i]?.welcome && bubbles[i - 1]?.welcome ? config.onboardingCardGapMs : pause());
    const r = await outbox.attempt({ id: row.id, router, log });
    if (!r.ok) {
      log({ onboarding_send_held: conversationId, n: i + 1, why: r.error ?? "unknown", queued: !!r.queued, card });
      if (!card) break;
    }
  }
  // The card is theirs once it has gone, or is owed by the outbox (which reports it if it dies).
  const card = rows.find(r => r.card);
  if (card && ["sent", "queued", "sending", "unknown"].includes(db.getOutbound(card.row.id)?.state)) db.markContactCardSent(conversationId);
  return said;
}

/** The one nudge, on the timer system, at a waking hour in THEIR zone; only ever if none has gone. */
export function scheduleNudge(conversationId, now = clock.now()) {
  db.cancelOnboardingNudges(conversationId);
  const row = db.getAccount(conversationId);
  if (!row || row.onboarding_nudged_at || !NUDGES[row.onboarding]) return null;
  if (!(config.onboardingNudgeMin > 0)) return null;
  const fireAt = wakingHour(now + config.onboardingNudgeMin * 60_000, zoneFor(conversationId));
  return db.createTimer(conversationId, { fireAt, note: "first-chat nudge", label: db.ONBOARDING_NUDGE_LABEL });
}

/** The same moment, or 10am the next morning when it would land between 9pm and 10am in `tz`. */
export function wakingHour(at, tz = config.installTz) {
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
  if (!row || row.onboarding_nudged_at || !NUDGES[row.onboarding] || !router || !active(row.conversation_id)) return null;
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

// ---------- the steps ----------

/**
 * Their name is known (or passed on): the line meeting it (the model's `line`, else MET), then what
 * they want to call Reason — or, when no card can go, nothing to name, so the one thing to try
 * instead, and the flow is done. `intro` goes first when Reason has not said who it is yet. `met`
 * false with no name leaves out "nice to meet you anyway" (after a request, where it would read oddly).
 */
function afterName(router, conversationId, who, { line = null, intro = null, met = true, route = null } = {}) {
  const can = cardCanGo(router, db.getAccount(conversationId));
  const meet = line || (who || met ? MET(who) : null);
  const lead = intro ? (route ? withCards(router, route, intro, conversationId) : [intro]) : [];
  const last = can ? CARD_NAME_ASK : cardsIn(lead) ? welcome.HELP_FIRST : tryLine(conversationId);
  return {
    bubbles: [...lead, ...(meet ? [meet] : []), ...(last ? [last] : [])],
    next: can ? "awaiting_card_name" : "complete",
  };
}

/**
 * The card under the name they picked (or Reason when they passed), on its line's message, then the
 * Amazon offer when its link can go, else the one thing to try and done.
 */
function theCard(router, conversationId, picked) {
  const chose = !!String(picked ?? "").trim();
  const name = cardName(picked);
  const url = cardUrl(router, db.getAccount(conversationId), name);
  if (!url) return { bubbles: tail(conversationId), next: "complete", name: null };
  const card = { text: CARD_SENT(name, chose), mediaUrl: url };
  if (amazonCanOffer(conversationId)) return { bubbles: [card, amazon.OFFER], next: "awaiting_amazon", name }; // AMAZON HOOK
  return { bubbles: [card, ...tail(conversationId)], next: "complete", name };
}

// AMAZON HOOK: the optional offer after the card (src/amazonconnect.js), REASON_INTRO_AMAZON=on only.
export const amazonOfferOn = () => ["1", "true", "on", "yes"].includes(String(process.env.REASON_INTRO_AMAZON ?? "").trim().toLowerCase());
// Per connection, not per person (owner 11-10): somebody who connected Amazon on the web setup (the store
// sign-in through Crossmint, src/websetup.js; it moves to the account on the claim) is not offered it
// again; somebody who skipped or failed it there is, like anyone else. `amazon.available` still says no
// to anyone already signed in through Reason's own browser, blocked, or the operator.
export const amazonCanOffer = (conversationId) => amazonOfferOn() && amazon.available(conversationId) && !shop.isConnected(conversationId, "amazon");
const realAmazonLink = (conversationId, { log } = {}) => { const r = amazon.connectLink(conversationId, { via: "first_chat", log }); return r.ok ? r.url : null; };

// ---------- the web setup's hand-off ----------

/** Did this person do the setup on heyreason.com/start (src/websetup.js)? Read off the claim, REASON_WEB_SETUP only. */
export const handledOnWeb = (conversationId) => /^(1|true|on|yes)$/i.test(String(process.env.REASON_WEB_SETUP ?? "").trim()) && !!setups.claimedBy(conversationId);

/** The hello after a web setup: their name back to them, nothing asked (and who invited them, when somebody did). */
export const WEB_HELLO = (user, invitedBy = null) => `${user ? `hey ${String(user).toLowerCase()}, good to meet you` : "hey, good to meet you"}${invitedBy ? `. you're in, invited by ${invitedBy}` : ""}`;

/**
 * The setup was started from an invite link (REASON_INVITE_START) and that invite is how this account
 * was made: the inviter's name for the first line, else null. Read off the claimed setup and the
 * account (db.redeemInvite set invited_by), so nothing the page sent decides it.
 */
export function webInvitedBy(setup, account) {
  if (!setup?.invite_id || !account?.invited_by) return null;
  const inv = db.db.prepare("SELECT conversation_id, redeemed_by FROM invites WHERE id = ?").get(setup.invite_id);
  if (!inv || inv.conversation_id !== account.invited_by || inv.redeemed_by !== account.conversation_id) return null;
  return inviterName(inv.conversation_id) || "a friend";
}
export const WEB_CARD = "here's my card, save it so you can always find me";

/**
 * Their first text came from the web setup, and the setup is claimed (router): their name and the
 * name they gave Reason are already on the account, so the hello, the card under that name, then
 * the Amazon offer when it can go (not when they connected Amazon on the page: amazonCanOffer reads
 * the store sign-in the claim moved; AMAZON HOOK, the awaiting_amazon step reads their yes or no),
 * else the one thing to try; done. Never the name question or the call-me question: nothing the page
 * already answered is asked again on the phone.
 */
function webHandoff(router, conversationId) {
  const setup = setups.claimedBy(conversationId);
  const account = db.getAccount(conversationId);
  const name = account.contact_card_name || cardName(setup?.reason_name);
  const url = cardUrl(router, account, name);
  const hello = WEB_HELLO(setup?.user_name || account.name, webInvitedBy(setup, account));
  if (!url) return { bubbles: [hello, TRY_LINE], next: "complete", name: null };
  const card = { text: WEB_CARD, mediaUrl: url };
  if (amazonCanOffer(conversationId)) return { bubbles: [hello, card, amazon.OFFER], next: "awaiting_amazon", name }; // AMAZON HOOK
  return { bubbles: [hello, card, TRY_LINE], next: "complete", name };
}

/**
 * REASON_WELCOME_CARDS=on: the web setup's hand-off is the welcome instead. One line picking up from
 * the page (their name, the name they gave Reason), the seven cards, then "what would you like help
 * with first?"; nothing else yet. Their first reply is answered by the normal turn, and only then
 * their card (and the Amazon offer when it can go): webCardAfter, from afterTask.
 */
function webWelcome(router, conversationId, route) {
  const setup = setups.claimedBy(conversationId);
  const account = db.getAccount(conversationId);
  const reasonName = account.contact_card_name || cardName(setup?.reason_name);
  const intro = welcome.WEB_INTRO({ user: setup?.user_name || account.name, reasonName, invitedBy: webInvitedBy(setup, account) });
  return { bubbles: [...withCards(router, route, intro, conversationId), welcome.HELP_FIRST], next: "awaiting_first", name: null };
}

/** After their first reply to the web welcome: the card under the name from the page, then the Amazon offer or nothing more. */
function webCardAfter(router, conversationId) {
  const setup = setups.claimedBy(conversationId);
  const account = db.getAccount(conversationId);
  const name = account.contact_card_name || cardName(setup?.reason_name);
  const url = cardUrl(router, account, name);
  if (!url) return { bubbles: [], next: "complete", name: null };
  const card = { text: WEB_CARD, mediaUrl: url };
  if (amazonCanOffer(conversationId)) return { bubbles: [card, amazon.OFFER], next: "awaiting_amazon", name }; // AMAZON HOOK
  return { bubbles: [card], next: "complete", name };
}

const cardNote = (name) => `[sent them Reason's contact card under the name they chose for it: ${name}. Saving it is up to them; Reason cannot touch their phone. You are still Reason]`;

/** Commit a step: its bubbles, its state, and the history, keyed so the same step twice queues nothing twice. */
async function runStep({ router, conversationId, route, row, bubbles, next, cardNamed = null, userLine = null, keyPart = "", welcomeKind = "direct", sleep, log }) {
  const state = row.onboarding;
  const steered = row.onboarding_steers ?? 0;
  const key = `onboard:${conversationId}:${state}:${steered}:${row.onboarding_at ?? 0}${keyPart}`;
  const write = () => {
    // Once per person: who got the cards, and from where (the flow's last line reads it, src/welcome.js).
    if (cardsIn(bubbles)) db.setWelcomeCards(conversationId, welcomeKind);
    if (next === "complete") finish(conversationId);
    else if (next !== state) db.setOnboarding(conversationId, { state: next, nameAsked: next === "awaiting_name" || state === "awaiting_name" });
    else db.setOnboarding(conversationId, { steers: steered + 1 });
  };
  const cardAt = bubbles.findIndex(b => b?.mediaUrl);
  const historyLines = (said) => [
    ...(userLine ? [{ role: "user", content: userLine }] : []),
    ...(said.length ? [{ role: "assistant", content: said.map((t, i) => cardNamed && i === cardAt ? `${t}\n${cardNote(cardNamed)}` : t).join("\n\n") }] : []),
  ];
  log({ onboarding: conversationId, from: state, to: next, bubbles: bubbles.length });
  const said = await commitStep({ router, conversationId, route, bubbles, key, write, historyLines, sleep, log });
  if (next !== "complete") scheduleNudge(conversationId);
  return said;
}

/**
 * An event join just made their account (router #claimEvent), right after the organizer's welcome:
 * the same flow from there, in place of the old card + question follow-up. The name they typed on
 * the event page is their name (Reason still says who it is, then meets the name); without one, the
 * opener asks it. Returns what was said, or null when the flow does not cover them (the caller then
 * sends what it always did).
 */
export async function startAfterEvent({ router, conversationId, route, ask = askStructured, sleep = realSleep, log = () => {} }) {
  if (!begin(conversationId)) return null;
  const row = db.getAccount(conversationId);
  const step = row.name
    ? afterName(router, conversationId, row.name, { intro: INTRO, line: await nameLine({ name: row.name, ask }) })
    : { bubbles: [...OPENER], next: "awaiting_name" };
  const said = await runStep({ router, conversationId, route, row, ...step, keyPart: ":event", sleep, log });
  return { step: step.next, said };
}

/**
 * The normal turn just answered a real request they made mid-flow (handle returned `after`): now the
 * step still pending, so the request never waited on the welcome. One steer per step, as with a
 * detour; past it the flow moves on (a name passed on, the card as Reason).
 */
export async function afterTask({ router, conversationId, route, ask = askStructured, sleep = realSleep, log = () => {} }) {
  if (!active(conversationId)) return null;
  const row = db.getAccount(conversationId);
  const steered = row.onboarding_steers ?? 0;
  let step;
  if (row.onboarding === "awaiting_first") {
    // Their first reply to the web welcome has its answer: now the card.
    step = webCardAfter(router, conversationId);
  } else if (row.onboarding === "not_started" || (row.onboarding === "awaiting_name" && row.name)) {
    step = row.name
      ? afterName(router, conversationId, row.name, { intro: row.onboarding === "not_started" ? BY_THE_WAY : null, line: await nameLine({ name: row.name, ask }), route })
      : { bubbles: [...withCards(router, route, BY_THE_WAY, conversationId), NAME_Q], next: "awaiting_name" };
  } else if (row.onboarding === "awaiting_name") {
    step = !steered ? { bubbles: [STEERS.awaiting_name], next: "awaiting_name" } : afterName(router, conversationId, "", { met: false });
  } else if (row.onboarding === "awaiting_card_name") {
    step = !steered ? { bubbles: [STEERS.awaiting_card_name], next: "awaiting_card_name" } : theCard(router, conversationId, "");
  } else if (row.onboarding === "awaiting_amazon") {
    // They moved on to something real: the offer is let go, never asked again.
    finish(conversationId);
    log({ onboarding: conversationId, from: "awaiting_amazon", to: "complete", why: "task" });
    return { step: "complete", said: [] };
  } else return null;
  const said = await runStep({ router, conversationId, route, row, bubbles: step.bubbles, next: step.next, cardNamed: step.name ?? null, keyPart: ":after", sleep, log });
  return { step: step.next, said };
}

// ---------- one message, at whatever step they are on ----------

/**
 * One drained message (or burst) from somebody mid-flow. Returns `{ handled: true, step }` when the
 * flow answered it with its own bubbles, or `{ handled: false, after? }` when the normal turn should
 * answer it — `after: true` means it was a real request, and the caller runs afterTask once the
 * turn's reply is out.
 *
 * `screen` is the harm screen (Runtime.screen), run beside the read: anything it does not call
 * clear ends the flow and goes to the normal turn, which screens it again and does what that
 * verdict needs.
 */
export async function handle({ router, conversationId, route, texts = [], attachments = [], ask = askStructured, screen = null, sleep = realSleep, amazonLink = realAmazonLink, log = () => {} }) {
  if (!active(conversationId)) return { handled: false };
  const row = db.getAccount(conversationId);
  const state = row.onboarding;
  db.cancelOnboardingNudges(conversationId);
  const text = texts.filter(Boolean).join("\n").trim();

  // The web setup already asked everything this flow would (src/websetup.js): its hand-off, no read.
  if (state === "not_started" && handledOnWeb(conversationId)) {
    const step = welcome.forEveryone() ? webWelcome(router, conversationId, route) : webHandoff(router, conversationId);
    log({ onboarding: conversationId, from: state, to: step.next, why: "web_setup" });
    const said = await runStep({ router, conversationId, route, row, bubbles: step.bubbles, next: step.next, cardNamed: step.name, userLine: `[${stamp()}] ${row.name || "them"}: ${text}`, keyPart: ":web", welcomeKind: "web", sleep, log });
    return { handled: true, step: step.next, said };
  }

  // Their first reply after the web welcome: whatever it is, the normal turn answers it (screened
  // there), and their card follows that answer (afterTask). Nothing is read here.
  if (state === "awaiting_first") {
    log({ onboarding: conversationId, from: state, to: state, why: "first_reply", after: true });
    return { handled: false, after: true };
  }

  // A voice note, a contact card or a link is words by now (heard / read upstream), so it is read
  // like text. A picture or a document is something real: the normal turn does it first.
  const real = attachments.filter(a => !WORDS.has(a?.kind));
  if (real.length) {
    log({ onboarding: conversationId, from: state, to: state, why: "attachment", after: true });
    return { handled: false, after: true };
  }

  const [read, screened] = await Promise.all([
    readText({ state, text, ask, conversationId }).catch(() => null),
    screen ? Promise.resolve().then(() => screen({ text })).catch(e => ({ verdict: "unscreened", error: e?.message })) : { verdict: "clear" },
  ]);
  let verdict = screened?.verdict ?? "clear";
  let screenError = screened?.error ?? null;
  // A screen that could not run (a cold or busy CLI) is asked once more, as the turn's own screen
  // does (Runtime._screen) — a timeout on "hey" must not cost somebody the whole first chat.
  if (verdict === "unscreened" && screen) {
    const again = await Promise.resolve().then(() => screen({ text })).catch(e => ({ verdict: "unscreened", error: e?.message }));
    verdict = again?.verdict ?? "clear";
    screenError = again?.error ?? screenError;
  }
  if (verdict !== "clear") {
    finish(conversationId);
    log({ onboarding: conversationId, from: state, to: "complete", why: `screen_${verdict}`, ...(screenError ? { error: String(screenError).slice(0, 160) } : {}) });
    return { handled: false };
  }
  // No read: the flow ends rather than leaving a step for anything else to run again.
  if (!read) {
    finish(conversationId);
    log({ onboarding_read_failed: conversationId, step: state, to: "complete" });
    return { handled: false };
  }
  log({ onboarding_read: conversationId, step: state, kind: read.kind });

  let name = row.name || "";
  if (read.name && (state === "not_started" || state === "awaiting_name")) {
    db.setAccountName(conversationId, read.name);
    name = read.name;
  }

  // Something real: the normal turn does it now, and the pending step follows its reply.
  if (read.kind === "task") {
    log({ onboarding: conversationId, from: state, to: state, why: "task", after: true });
    return { handled: false, after: true };
  }

  const detour = read.kind === "question" || read.kind === "other" || (read.kind === "greeting" && state !== "not_started");
  const replyLine = detour && read.reply ? [read.reply] : [];
  const steered = row.onboarding_steers ?? 0;
  let step = { bubbles: [], next: state };

  if (state === "not_started") {
    const lead = read.kind === "question" ? replyLine : [];
    // Their name already in the first text ("hey it's kofi"): never asked for again — who Reason
    // is, then their name met.
    if (read.name) { const s = afterName(router, conversationId, read.name, { intro: INTRO, line: read.nameLine, route }); step = { bubbles: [...lead, ...s.bubbles], next: s.next }; }
    else step = { bubbles: [...lead, ...withCards(router, route, INTRO, conversationId), NAME_Q], next: "awaiting_name" };
    // They rang Reason's number before signing up (src/strangercalls.js): said first, once.
    const back = reconnectLine(conversationId);
    if (back) step.bubbles = [back, ...step.bubbles];
  } else if (state === "awaiting_name") {
    // A name already on the account (the channel's display name, an event page) is not asked again.
    const who = read.name || (read.kind === "decline" ? "" : row.name || null);
    if (who !== null) { const s = afterName(router, conversationId, who, { line: read.name ? read.nameLine : null }); step = { bubbles: [...replyLine, ...s.bubbles], next: s.next }; }
    else if (!steered) step = { bubbles: [...replyLine, STEERS.awaiting_name], next: state };
    else { const s = afterName(router, conversationId, ""); step = { bubbles: [...replyLine, ...s.bubbles], next: s.next }; }
  } else if (state === "awaiting_card_name") {
    if (read.cardName || read.kind === "answer" || read.kind === "decline") {
      const c = theCard(router, conversationId, read.kind === "decline" ? "" : read.cardName);
      step = { ...c, bubbles: [...replyLine, ...c.bubbles] };
    }
    else if (!steered) step = { bubbles: [...replyLine, STEERS.awaiting_card_name], next: state };
    else { const c = theCard(router, conversationId, ""); step = { ...c, bubbles: [...replyLine, ...c.bubbles] }; }
  } else if (state === "awaiting_amazon") {
    if (read.amazon === "yes") {
      const url = await Promise.resolve().then(() => amazonLink(conversationId, { log })).catch(e => { log({ onboarding_amazon_link_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] }); return null; });
      // The link alone in its own bubble, so it unfurls as its card. No link: said plainly, then on.
      step = url
        ? { bubbles: [amazon.LINK_LINE, url, ...tail(conversationId)], next: "complete" }
        : { bubbles: [amazon.FAILED_LINE, ...tail(conversationId)], next: "complete" };
    } else if (read.amazon === "no" || read.kind === "decline") { const t = tryLine(conversationId); step = { bubbles: [t ? `${amazon.NO_LINE}. ${t}` : amazon.NO_LINE], next: "complete" }; }
    // A question about it gets its answer and the offer stays open, never asked again; a second detour lets it go.
    else if (read.kind === "question" && !steered && replyLine.length) step = { bubbles: replyLine, next: state };
    else step = { bubbles: [...replyLine, ...tail(conversationId)], next: "complete" };
  }

  const said = await runStep({
    router, conversationId, route, row, bubbles: step.bubbles, next: step.next, cardNamed: step.name ?? null,
    userLine: `[${stamp()}] ${name || "them"}: ${text}`, sleep, log,
  });
  return { handled: true, step: step.next, said };
}
