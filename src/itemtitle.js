// The short plain title an Ongoing row shows on Web ("Speedrun reply", "Daily Twi check-in").
//
// A reminder's note and a task's title are Reason's notes to itself: "Omari asked (Mon 4:38pm) to
// be reminded to…", "standing check-in: daily gua sha…". They are right for the model and wrong
// for the person's own list. So each row carries a `label`, written once when it is made: by the
// model that makes it (timer_set / task_start take `title`), or, when nothing wrote one, by one
// cheap summarise on the claude-cli subscription path — never the billed API. That same summarise
// also writes the row's chat drafts (DRAFT_STATES below), so they cost no call of their own. What the title SAYS
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

// The states a row of each kind can be in on Web's Ongoing, and what "Talk about it in the chat →"
// drafts for each (owner 10-27): waiting asks for news, working how it's going, scheduled offers to
// change it, ready asks to see it, didn't-work asks what's next, stuck what would get it going.
export const DRAFT_STATES = { task: ["waiting", "working", "stuck", "ready", "failed"], timer: ["scheduled"], series: ["scheduled"] };
const DRAFT_ASK = {
  waiting: "asking whether there is any news (e.g. 'Any word back from Speedrun yet?')",
  working: "asking how it is going (e.g. 'How's the table hunt going?')",
  stuck: "asking what would get it moving again",
  ready: "asking to see it (e.g. 'Can I see what you found?')",
  failed: "asking what happens next now that it did not work",
  scheduled: "offering to change it (e.g. 'Can we move my Twi check-in?')",
};

const schemaFor = (kind) => {
  const states = DRAFT_STATES[kind] ?? [];
  const props = { title: { type: "string" } };
  if (states.length) props.drafts = { type: "object", properties: Object.fromEntries(states.map(k => [k, { type: "string" }])), required: states, additionalProperties: false };
  return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false };
};

const SYSTEM = `You name one item on a person's to-do list. You are given an assistant's private note about a reminder or a job it is holding for them.
Reply with a title for the person to read on their own list: 2 to 5 words, plain, the thing itself, the way they would say it.
Examples: "Speedrun reply", "Daily Twi check-in", "Prep for Wednesday", "Cancel Claude Pro", "Work commute check".
Never use their name or talk about them in the third person. No times, dates, "remind", quotes or punctuation at the end.
When asked for drafts: for each state, one short message the PERSON could send their assistant about this item, in their own casual first-person voice, a natural question that moves it along. Under 12 words. Never their name, never the assistant's private notes, tool names or "they asked".`;

const MAX_DRAFT = 120;
/** One draft as written, made safe to put in their composer: one line, short, first person, never their name or a tool-ish word. Null when unusable. */
export function normDraft(raw, { name } = {}) {
  let t = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  if (!t || t.length > MAX_DRAFT) return null;
  if (firstName(name) && nameRe(name).test(t)) return null;
  // Reason's own machinery never reaches their line: snake_case tool names, "the user", "<x> asked".
  if (/\b[a-z]+_[a-z_]+\b|\bthe user\b|\b(he|she|they) asked\b|\breason asked\b/i.test(t)) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The title and the per-state drafts from one claude-cli summarise. Null when the CLI is not the backend or anything goes wrong. */
export async function summariseItem(text, { kind = "task", name = config.ownerName, ask = askStructuredViaCli } = {}) {
  if (ask === askStructuredViaCli && (process.env.REASON_BACKEND !== "claude-cli" || process.env.NODE_TEST_CONTEXT)) return null;
  const states = DRAFT_STATES[kind] ?? [];
  const wantDrafts = states.length ? `\n\nAlso write drafts, one per state: ${states.map(k => `${k}: ${DRAFT_ASK[k]}`).join("; ")}.` : "";
  const { value, error } = await ask({
    prompt: `Their first name, which must NOT appear: ${firstName(name) || "(unknown)"}\n\nThe note:\n${String(text ?? "").slice(0, 600)}${wantDrafts}`,
    system: SYSTEM,
    schema: schemaFor(kind),
    model: process.env.REASON_TITLE_CLI_MODEL || "sonnet",
    timeoutMs: 45_000,
    feature: "title",
  });
  if (error) return null;
  const title = normTitle(value?.title, { name });
  const drafts = {};
  for (const k of states) { const d = normDraft(value?.drafts?.[k], { name }); if (d) drafts[k] = d; }
  return { title, drafts: Object.keys(drafts).length ? drafts : null };
}

/** One title from the claude-cli subscription. Null when the CLI is not the backend or anything goes wrong. */
export async function summariseTitle(text, opts = {}) {
  return (await summariseItem(text, opts))?.title ?? null;
}

// One summarise at a time, each row asked for once per process: a page view never fans out.
const asked = new Set();
let chain = Promise.resolve();

/**
 * Title a row nothing titled yet, in the background. `kind` is task | timer | series | call. Never throws,
 * never blocks the caller; a series' title also goes onto its pending firing.
 */
export function queueTitle(kind, conversationId, id, text, { name, ask } = {}) {
  if (!ask && process.env.REASON_BACKEND !== "claude-cli") return null;
  // Under the test runner nothing reaches the real CLI: only a test's own `ask` is ever called.
  if (!ask && process.env.NODE_TEST_CONTEXT) return null;
  if (process.env.REASON_ITEM_TITLES === "0") return null;
  const key = `${kind}:${id}`;
  if (asked.has(key)) return null;
  asked.add(key);
  chain = chain.then(async () => {
    try {
      const got = await summariseItem(text, { kind, name: name ?? db.getAccount(conversationId)?.name ?? config.ownerName, ...(ask ? { ask } : {}) });
      if (got?.title) db.setItemLabel(kind, conversationId, id, got.title, got.drafts);
    } catch { /* a title is never worth an error */ }
  });
  return chain;
}

export function resetTitleQueue() { asked.clear(); chain = Promise.resolve(); }
