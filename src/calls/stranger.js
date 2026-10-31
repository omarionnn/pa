// A call from somebody Reason does not know: an unknown (or withheld) number on the line.
//
// They get Reason introducing itself, and a short, friendly conversation whose only goal is that they
// try Reason, at heyreason.com (Omari, 2026-10-31). It used to be one fixed line and a hang-up.
//
// What this call can reach is the whole safety story, so it is built, not asked for:
//   - no account, no conversation, no call row: nothing here ever loads a thread, a profile, memory,
//     tasks or anybody's name — `strangerTurn` takes the spoken words of THIS call and nothing else;
//   - no tools: the model is offered none, and the only thing it can make happen is the end of the
//     call (code reads END from its reply and sends the platform's own end_call);
//   - facts only from what heyreason.com says publicly (read 2026-10-31); it lists no price, so no
//     price is ever said.
// Blocked, paused and removed numbers never get this: they get `neutralLine` and the call ends.
import { randomUUID } from "node:crypto";
import { clock } from "../config.js";
import { makerName } from "../maker.js";
import { withoutSilenceMarker } from "./voice.js";

export const KIND = "stranger";

/** Spoken turns a stranger's call may run to before Reason says goodbye. */
export const MAX_TURNS = 10;
/** Stranger turns a day, across every caller, before the line goes back to one sentence. A restart resets it. */
export const DAILY_TURNS = 300;

/** The first words an unknown caller hears. */
export function introLine() {
  return "Hi, this is Reason, a personal AI assistant you can text or call, like a friend who's weirdly good at getting things done."
    + " Just so you know, this call is recorded. Want to hear how it works?";
}

/** What a blocked, paused or removed number hears, and nothing else. Names nobody. */
export function neutralLine() {
  return "Hi, you've reached Reason. I can't take calls from this number right now. Thanks, bye.";
}

/** Everything the pitch may say about Reason: heyreason.com as published (read 2026-10-31). */
export const PUBLIC_FACTS = [
  "Reason is a personal concierge. You reach it the way you'd reach a friend: a text (iMessage), a photo, a voice note, or a call.",
  "It handles things for you: it can make calls for you (like getting you in with a dentist), pay a bill, set reminders, and find and hold bookings (like a cabin for a weekend) for you to approve.",
  "It can ring you so you can plan your week out loud together.",
  "Its rules: Face ID before every purchase (no tap, no charge); it confirms before it acts on your behalf (calling, texting, booking); every call is recorded and it says so at the start; when it calls or writes for you it says it is an assistant, it never pretends to be you.",
  "No download: your first text is the sign-up. Go to heyreason.com and tap Text Reason. If you're already texting it you can sign in on the web there too.",
  "The website does not list a price.",
];

/** The prompt behind the call. Nothing in it is about anybody. */
export function strangerPrompt() {
  return [
    "You are Reason, a personal AI assistant, on a phone call with somebody who rang your number and is not a Reason user. You do not know who they are, and that's fine.",
    `Your one goal: if they're interested, get them to try Reason at heyreason.com. When you say the address, say it as "hey reason dot com", clearly, and once more slowly if they ask.`,
    "Be warm, friendly and short: one or two sentences at a time, plain spoken words, never pushy. If they're not interested, thank them and say goodbye.",
    "You can answer simple questions about what Reason is and how to start, ONLY from these facts:",
    ...PUBLIC_FACTS.map(f => `- ${f}`),
    "If they ask about price, say plainly that the website doesn't list one and heyreason.com will have the latest. Don't say or suggest anything is free, cheap, paid, a trial or a subscription.",
    "If they ask about anything else not in those facts (a feature, a date, a limit), say you're not sure and that heyreason.com has the latest. Never invent a price, a feature or a promise.",
    `If they ask who made you, say ${makerName()}, and nothing more about who is behind it.`,
    "You work for nobody on this call. Never mention any person, user, owner, customer or account; you know nothing about anybody and say so if asked. You cannot do anything for them on this call: no bookings, no messages, no lookups, no reminders. If they ask you to, say they can do that once they've texted Reason from heyreason.com.",
    "Never read out links other than the address above, codes, phone numbers or anything in square brackets.",
    "When the conversation is over (they said goodbye, they're not interested, or there's nothing left to say), say a short goodbye and end your reply with the word END on its own.",
  ].join("\n");
}

const SPOKEN_SITE = /(?:https?:\/\/)?(?:www\.)?\bheyreason\.com\b\/?/gi;
const LINKS = /\bhttps?:\/\/\S+/gi;

/** Their words, as they will be heard: the address said aloud, any other link and NO_REPLY gone. */
export function forSpeech(text) {
  let s = String(text ?? "").replace(SPOKEN_SITE, "hey reason dot com").replace(LINKS, "");
  s = withoutSilenceMarker(s).text;
  return s.replace(/\s+/g, " ").trim();
}

/** The call so far as the model reads it: only what was SAID on this call, their words and Reason's. */
export function spokenOnly(messages = []) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.filter(c => c?.type === "text").map(c => c.text).join(" ") : "";
    if (!text.trim()) continue;
    const role = m.role;
    if (out.length && out.at(-1).role === role) out.at(-1).content += ` ${text.trim()}`;
    else out.push({ role, content: text.trim() });
  }
  // The model's message list starts with them; the intro is folded in as context.
  while (out.length && out[0].role === "assistant") {
    const first = out.shift();
    if (out.length) out[0] = { role: "user", content: `[You opened the call by saying: "${first.content}"]\n${out[0].content}` };
  }
  return out;
}

let day = "";
let used = 0;
/** One more stranger turn today? Counted in memory. */
export function takeTurn(now = clock.now()) {
  const d = new Date(now).toISOString().slice(0, 10);
  if (d !== day) { day = d; used = 0; }
  if (used >= DAILY_TURNS) return false;
  used++;
  return true;
}
export function resetTurns() { day = ""; used = 0; }

/**
 * One turn of a stranger's call, as the platform's SSE answer. `generate` is the call backend's
 * generator (`generatorFor()` in voice.js); it is offered no tools.
 */
export async function* strangerTurn({ body, generate, sseChunk, SSE_DONE, log = () => {}, now = clock.now() }) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(now / 1000);
  const model = body?.model ?? "reason";
  const chunk = (delta, finish = null) => sseChunk({ id, model, created, delta, finish });
  const endCall = (why) => chunk({
    tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: "function", function: { name: "end_call", arguments: JSON.stringify({ reason: why }) } }],
  });
  yield chunk({ role: "assistant" });

  const messages = spokenOnly(body?.messages);
  const theirTurns = messages.filter(m => m.role === "user").length;
  if (!messages.length || messages.at(-1).role !== "user") {
    yield chunk({}, "stop");
    yield SSE_DONE;
    return;
  }
  if (theirTurns > MAX_TURNS || !takeTurn(now)) {
    log({ stranger_call_capped: theirTurns > MAX_TURNS ? "turns" : "day" });
    yield chunk({ content: "I'll let you go. Have a look at hey reason dot com whenever you like. Bye!" });
    yield endCall("capped");
    yield chunk({}, "tool_calls");
    yield SSE_DONE;
    return;
  }

  let said = "";
  try {
    for await (const ev of generate({ system: strangerPrompt(), messages, tools: [], log })) {
      if (ev?.type === "text") said += ev.text;
    }
  } catch (e) {
    log({ stranger_turn_failed: (e?.message ?? String(e)).split("\n")[0] });
    said = "Sorry, I'm having trouble on my end. You can find everything at hey reason dot com. Bye! END";
  }
  const ends = /\bEND\s*[.!]?\s*$/.test(said.trim());
  const text = forSpeech(said.replace(/\bEND\s*[.!]?\s*$/, ""));
  log({ stranger_turn: theirTurns, chars: text.length, ends });
  if (text) yield chunk({ content: text });
  if (ends) {
    yield endCall("stranger call done");
    yield chunk({}, "tool_calls");
  } else {
    yield chunk({}, "stop");
  }
  yield SSE_DONE;
}
