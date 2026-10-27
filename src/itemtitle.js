// The short plain title an Ongoing row shows on Web ("Speedrun reply", "Daily Twi check-in").
//
// A reminder's note and a task's title are Reason's notes to itself: "Omari asked (Mon 4:38pm) to
// be reminded to…", "standing check-in: daily gua sha…". They are right for the model and wrong
// for the person's own list. So each row carries a `label`, written once when it is made: by the
// model that makes it (timer_set / task_start take `title`), or, when nothing wrote one, by one
// cheap summarise on the claude-cli subscription path — never the billed API. What the title SAYS
// is the model's call; the only code that reads the words is the last-resort cleanup below, which
// strips Reason's own note prefixes so a row with no title yet is still readable.
import { config } from "./config.js";
import * as db from "./db.js";
import { askStructuredViaCli } from "./backends/cli.js";

export const TITLE_HINT = "A short plain title for their Ongoing list on Reason Web: 2-5 words, the thing itself, the way they would name it ('Speedrun reply', 'Daily Twi check-in', 'Prep for Wednesday'). Never their name, never 'remind', no times or dates.";

const MAX_WORDS = 6, MAX_CHARS = 48;

const firstName = (name = config.ownerName) => String(name ?? "").trim().split(/\s+/)[0] ?? "";
const nameRe = (name) => new RegExp(`\\b${firstName(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

/** A title as written, made safe to show: one line, short, no quotes, never the person's name. Null when unusable. */
export function normTitle(raw, { name } = {}) {
  let t = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^["'“‘]+|["'”’.!,]+$/g, "").trim();
  if (!t) return null;
  if (firstName(name) && nameRe(name).test(t)) return null;
  const words = t.split(" ");
  if (words.length > MAX_WORDS) t = words.slice(0, MAX_WORDS).join(" ");
  if (t.length > MAX_CHARS) t = `${t.slice(0, MAX_CHARS - 1).trimEnd()}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * The fallback, for a row nothing has titled yet: Reason's own prefixes off ("Omari asked (…) to",
 * "standing check-in:", "remind Omari to"), the first clause, a few words. Formatting, not meaning.
 */
export function cleanTitle(text, { name } = {}) {
  const n = firstName(name);
  const who = n ? n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "\\S+";
  let t = String(text ?? "").replace(/\s+/g, " ").trim()
    .replace(/^standing (check-in|call):\s*/i, "")
    .replace(/^(daily|weekly) challenge:\s*/i, "")
    .replace(new RegExp(`^${who} asked(\\s*\\([^)]*\\))?(,[^,]*,)?\\s+(to\\s+)?(be reminded\\s+(to|about|that)\\s+)?`, "i"), "")
    .replace(new RegExp(`^(remind|nudge|ask|tell|text)\\s+${who}\\s+(to|about|that|if|whether)\\s+`, "i"), "");
  t = t.split(/\s*(?:[;(—]|:\s|,\s|\s-\s|\.\s)/)[0];
  if (n) t = t.replace(new RegExp(`\\b${who}'s\\b`, "gi"), "your").replace(new RegExp(`\\b${who}\\b`, "gi"), "you");
  return normTitle(t, { name: "" }) ?? "";
}

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

const SYSTEM = `You name one item on a person's to-do list. You are given an assistant's private note about a reminder or a job it is holding for them.
Reply with a title for the person to read on their own list: 2 to 5 words, plain, the thing itself, the way they would say it.
Examples: "Speedrun reply", "Daily Twi check-in", "Prep for Wednesday", "Cancel Claude Pro", "Work commute check".
Never use their name or talk about them in the third person. No times, dates, "remind", quotes or punctuation at the end.`;

/** One title from the claude-cli subscription. Null when the CLI is not the backend or anything goes wrong. */
export async function summariseTitle(text, { name = config.ownerName, ask = askStructuredViaCli } = {}) {
  if (process.env.REASON_BACKEND !== "claude-cli" && ask === askStructuredViaCli) return null;
  const { value, error } = await ask({
    prompt: `Their first name, which must NOT appear: ${firstName(name) || "(unknown)"}\n\nThe note:\n${String(text ?? "").slice(0, 600)}`,
    system: SYSTEM,
    schema: SCHEMA,
    model: process.env.REASON_TITLE_CLI_MODEL || "sonnet",
    timeoutMs: 45_000,
    feature: "title",
  });
  if (error) return null;
  return normTitle(value?.title, { name });
}

// One summarise at a time, each row asked for once per process: a page view never fans out.
const asked = new Set();
let chain = Promise.resolve();

/**
 * Title a row nothing titled yet, in the background. `kind` is task | timer | series. Never throws,
 * never blocks the caller; a series' title also goes onto its pending firing.
 */
export function queueTitle(kind, conversationId, id, text, { name, ask } = {}) {
  if (!ask && process.env.REASON_BACKEND !== "claude-cli") return null;
  if (process.env.REASON_ITEM_TITLES === "0") return null;
  const key = `${kind}:${id}`;
  if (asked.has(key)) return null;
  asked.add(key);
  chain = chain.then(async () => {
    try {
      const title = await summariseTitle(text, { name: name ?? db.getAccount(conversationId)?.name ?? config.ownerName, ...(ask ? { ask } : {}) });
      if (title) db.setItemLabel(kind, conversationId, id, title);
    } catch { /* a title is never worth an error */ }
  });
  return chain;
}

export function resetTitleQueue() { asked.clear(); chain = Promise.resolve(); }
