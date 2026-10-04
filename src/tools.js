// Every tool: a JSON schema the model sees, a zod check on what it sends, and a run() that touches the DB.
// Guards live here, never in routing. The result is the only thing the model may treat as true.
import { z } from "zod";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as db from "./db.js";
import { clock, stamp, config, weekdayMismatch, normalizeNumber, isOwnerNumber } from "./config.js";
import * as trust from "./trust.js";
import * as browser from "./browser.js";
import { webLookup } from "./weblookup.js";

// Tools that touch something outside this machine. Every call, success or not, leaves a ledger row.
// Clicks and typing inside an already-open page are steps, not outcomes; the step that has a real
// consequence is browser_submit, which is gated and always recorded.
const OUTSIDE_WORLD = new Set(["account_connect", "account_revoke", "browser_open", "browser_submit", "web_lookup", "message_send", "call_place"]);
// Tools that spend money or act on a third party. They will not run without a spent confirmation.
const ALWAYS_NEEDS_CONFIRMATION = new Set(["account_connect", "browser_submit"]);

/**
 * Does this call need an explicit yes? Mostly a fixed list, but two tools depend on who they are
 * pointed at: texting or calling the owner is Reason talking to the person it works for, while
 * texting or calling anyone else acts on a third party and goes through the gate with the exact
 * number on the record. The destination is read here, in code, not taken on the model's word.
 */
function needsConfirmation(name, input) {
  if (ALWAYS_NEEDS_CONFIRMATION.has(name)) return true;
  if (name === "message_send" || name === "call_place") return !addressedToOwner(input.to);
  return false;
}

// The gate itself is off-limits outside the owner's thread. Recording a confirmation there would
// mean a stranger's "yeah go on" became a row that looks exactly like the owner's.
const GATED_ANYWHERE = new Set(["confirm_request", "confirm_record", "account_connect", "account_revoke", "browser_submit", "message_send", "call_place"]);

/** "owner", or a number on the owner list in config. Anything else is a third party. */
function addressedToOwner(to) {
  const t = String(to ?? "").trim();
  return t.toLowerCase() === "owner" || isOwnerNumber(t);
}

// Browser snapshots stack up in the conversation history, so they stay small by default.
// The model asks for more with max_chars when a page really needs it.
const SNAPSHOT_CHARS = Number(process.env.REASON_SNAPSHOT_CHARS || 3000);

// A button whose name reads like this commits something on someone else's system.
// browser_click refuses it and sends the model through the gate instead, so the gate
// cannot be walked around by calling the un-gated tool. It fails closed: a false positive
// costs one trip through the gate, which is the safe direction to be wrong in.
const COMMIT_WORDS =/\b(submit|confirm|book|booking|reserve|reservation|complete|checkout|check ?out|place (the )?order|order now|pay|payment|purchase|buy|charge|subscribe|send|apply|finish|agree|accept)\b/i;

const Who = z.array(z.string()).max(50);
const PlanFields = {
  title: z.string().max(200).optional(),
  kind: z.string().max(40).optional(),
  when: z.string().max(200).optional(),
  where: z.string().max(200).optional(),
  who: Who.optional(),
  details: z.record(z.any()).optional(),
  open_questions: z.array(z.string().max(200)).max(20).optional(),
};
const planFieldsSchema = {
  title: { type: "string", description: "Short human title, e.g. 'Dinner at Carbone', 'Beach day'" },
  kind: { type: "string", description: "movie | dinner | drinks | trip | party | errand | other" },
  when: { type: "string", description: "Exactly what the person said, resolved to a real day/time when possible, e.g. 'Fri Sep 26, 8:00 PM'. Empty if not known yet." },
  where: { type: "string", description: "Place or area. Empty if not known yet." },
  who: { type: "array", items: { type: "string" }, description: "Names of people in the plan besides the owner." },
  details: { type: "object", description: "Anything else that matters: budget, vibe, dietary notes, seats, film title..." },
  open_questions: { type: "array", items: { type: "string" }, description: "What is still unknown and blocks the plan. Empty means nothing is open. A plan cannot lock while this is non-empty." },
};

export const CAPABILITIES = [
  { name: "plan", status: "live", what: "make a plan of any kind, track what is still open, change any detail, lock, cancel" },
  { name: "timers", status: "live", what: "remind or nudge at a real time (day-of reminders, morning-after check-ins, follow-ups)" },
  { name: "watchers", status: "live", what: "watch a page and come back when something changes on it: a table opening up, a price dropping, a status flipping. Needs a URL it can read; it cannot watch something it has no way to see" },
  { name: "dropped_threads", status: "live", what: "when a plan with open questions goes quiet for hours, Reason picks the thread back up on its own, at most once per plan per day and twice per conversation" },
  { name: "memory", status: "live", what: "remember facts about people and preferences for later, read back everything known about someone, and forget a person outright when asked" },
  { name: "action_ledger", status: "live", what: "a receipt for every action that touched the outside world. 'what did you do today' is read from it, never from memory" },
  { name: "confirm_gate", status: "live", what: "anything that spends money or acts on someone else stops until the owner says go. The guard reads their real reply itself and cannot be talked into it. A yes covers only the details they were shown: approve but change the time and nothing goes through until they are asked again" },
  { name: "connected_accounts", status: "live", what: "see what Reason can reach and revoke it. Connecting still needs the provider's credentials" },
  { name: "web_lookup", status: "live", what: "fetch one page and read its text. No JavaScript, no clicking, no logins" },
  { name: "browser", status: "live", what: "a real Chromium Reason drives itself: open a site, read it, click, fill forms, screenshot. One profile per conversation, so logins stick. The final commit click always needs an explicit yes" },
  { name: "venue_search", status: "not connected", what: "no venue database. Reason can only read a page you point it at, or drive a site in the browser. It cannot invent restaurants, showtimes or prices." },
  { name: "payments", status: "not connected", what: "send a pay link, split a bill, refund. Needs a payments provider key that is not set up." },
  { name: "email", status: "not connected", what: "read and send email. Needs Google OAuth credentials that are not set up." },
  { name: "calendar", status: "not connected", what: "read and write calendar events. Needs Google OAuth credentials that are not set up." },
  { name: "phone_calls", status: "not connected", what: "call a place or a person and report back. Needs a telephony key and a number that are not set up." },
  { name: "long_tasks", status: "live", what: "work that outlives a message: an errand, a wait for someone to come back, a multi-step job. It is a real row that survives a restart, wakes on a schedule, and only speaks up when something actually changed. 'What are you working on' is read from it" },
  { name: "message_people", status: "not connected", what: "text the crew directly to collect answers. Not connected yet; only this DM exists." },
];

/**
 * Capabilities as they really are this second. The static list above is the floor; texting and
 * phone calls are rewritten from the adapters that are actually running, because the whole point
 * of this tool is that it cannot be out of date about what Reason can do.
 */
export function capabilitiesNow({ channels = null, calls = null } = {}) {
  const out = CAPABILITIES.map(c => ({ ...c }));
  const texting = out.find(c => c.name === "message_people");
  const live = channels?.statuses?.().filter(s => s.status === "live" && s.name !== "console") ?? [];
  if (live.length) {
    texting.status = "live";
    texting.what = `text a real phone number over ${live.map(s => s.name).join(", ")}${live[0].number ? ` from ${live[0].number}` : ""}. Texting anyone but ${config.ownerName} needs an explicit yes first, with the number and the words shown`;
  } else {
    const missing = (channels?.statuses?.() ?? []).flatMap(s => s.missing ?? []);
    texting.status = "not connected";
    texting.what = `no texting channel is connected${missing.length ? `: this machine has no ${[...new Set(missing)].join(", ")}` : " on this machine"}. Only this conversation exists. Do not offer to text anyone`;
  }

  const phone = out.find(c => c.name === "phone_calls");
  const provider = calls?.status?.();
  if (provider?.status === "live") {
    phone.status = "live";
    phone.what = `call a number with a goal, hold, and report back what was said (${provider.name}). Calling anyone but ${config.ownerName} needs an explicit yes first, with the exact number and goal shown`;
  } else {
    phone.status = "not connected";
    phone.what = `no phone provider is wired up${provider?.missing?.length ? `: this machine has no ${provider.missing.join(", ")}` : ""}. Reason cannot call anyone. Do not offer to`;
  }
  return out;
}

export const tools = [
  {
    name: "plan_create",
    description: "Start a new plan the owner wants. Use what they said; leave unknown fields empty and list what is still needed in open_questions. Returns the plan with its id.",
    input_schema: { type: "object", properties: planFieldsSchema, required: ["title"] },
  },
  {
    name: "plan_list",
    description: "List the owner's plans. By default only live ones (planning or locked). Use this before assuming which plan someone means.",
    input_schema: { type: "object", properties: { include_closed: { type: "boolean", description: "Also return cancelled/done plans" } } },
  },
  {
    name: "plan_get",
    description: "Full current state of one plan by id.",
    input_schema: { type: "object", properties: { plan_id: { type: "integer" } }, required: ["plan_id"] },
  },
  {
    name: "plan_update",
    description: "Change any detail of a live plan. Send only the fields that change. Arrays (who, open_questions) replace the whole list, so send the complete new list. Remove a question from open_questions once it is answered.",
    input_schema: { type: "object", properties: { plan_id: { type: "integer" }, ...planFieldsSchema }, required: ["plan_id"] },
  },
  {
    name: "plan_lock",
    description: "Mark a plan as set: everyone knows when and where. Fails while open_questions is non-empty.",
    input_schema: { type: "object", properties: { plan_id: { type: "integer" } }, required: ["plan_id"] },
  },
  {
    name: "plan_cancel",
    description: "Cancel a plan. Only when the owner clearly wants it gone (not paused, not changed).",
    input_schema: { type: "object", properties: { plan_id: { type: "integer" } }, required: ["plan_id"] },
  },
  {
    name: "plan_done",
    description: "Mark a locked plan as happened (after the time has passed).",
    input_schema: { type: "object", properties: { plan_id: { type: "integer" } }, required: ["plan_id"] },
  },
  {
    name: "timer_set",
    description: "Schedule Reason to come back to this conversation at a real time with a note to itself (e.g. 'day-of reminder for plan 3', 'ask how dinner was'). When it fires you get an event message and decide what to say. Returns the timer id and the resolved time.",
    input_schema: {
      type: "object",
      properties: {
        fire_at: { type: "string", description: "ISO 8601 datetime with offset, e.g. 2026-09-26T18:00:00-04:00" },
        note: { type: "string", description: "What future-Reason should do when this fires" },
        plan_id: { type: "integer", description: "Plan this timer belongs to, if any" },
      },
      required: ["fire_at", "note"],
    },
  },
  {
    name: "timer_list",
    description: "Pending timers for this conversation.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "timer_cancel",
    description: "Cancel a pending timer by id.",
    input_schema: { type: "object", properties: { timer_id: { type: "integer" } }, required: ["timer_id"] },
  },
  {
    name: "watch_set",
    description: "Watch a page and come back when something changes on it: a table opening up, a price dropping, tickets going on sale, a status flipping. Reason re-reads the page on a schedule and tells them when it sees the thing. Use this instead of promising to 'keep an eye out' — a promise is not a watcher. Only works on a page you have a URL for; it cannot watch something Reason cannot read.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page to re-read. http or https." },
        looking_for: { type: "string", description: "Exactly what counts as the thing happening, specific enough that reading the page settles it, e.g. 'any table for 2 on Fri Oct 9 between 7 and 9pm' or 'the price drops below $180'." },
        every_minutes: { type: "integer", description: `How often to re-read it. Minimum ${config.watchMinEveryMin}. Pick something sane for how fast it could change.` },
        note: { type: "string", description: "Why they want it, in a line, so the message you send later makes sense." },
        plan_id: { type: "integer", description: "The plan this is for, if any." },
      },
      required: ["url", "looking_for"],
    },
  },
  {
    name: "watch_list",
    description: "What Reason is currently watching for this person. Use it before promising a new watcher, and when they ask what you're keeping an eye on.",
    input_schema: { type: "object", properties: { include_closed: { type: "boolean", description: "Also show watches that fired, were called off, or gave up." } } },
  },
  {
    name: "watch_cancel",
    description: "Stop watching. Use it when they say never mind, or when the plan it was for is cancelled.",
    input_schema: { type: "object", properties: { watch_id: { type: "integer" } }, required: ["watch_id"] },
  },
  {
    name: "task_start",
    description: "Start a job that outlives this message: an errand you have to work at, a wait for someone to come back to you, anything with more than one step. It becomes a real row that survives a restart, and you get woken up at the time you name to take the next step. Use it instead of saying 'I'll get on that' — a sentence is not a task. For a plain reminder at a time, use timer_set instead; this is for work you will actually do.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human name for it, how you would say it: 'get the handyman to call back', 'find a table for 4 saturday'" },
        goal: { type: "string", description: "What done looks like, specific enough that future-you can tell whether it happened." },
        wake_in_minutes: { type: "integer", description: "How long until you take the first step. Omit to start right away on the next pass." },
        wake_at: { type: "string", description: "ISO 8601 datetime with offset, if a specific time matters more than a delay." },
      },
      required: ["title", "goal"],
    },
  },
  {
    name: "task_update",
    description: "Write down what actually happened on a task and when to come back to it. One short line per step, in plain words — this log is the only thing you may quote later about what you did. Logging progress also resets the task's crash budget.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        progress: { type: "string", description: "What really happened this step. Not what you intend to do." },
        wake_in_minutes: { type: "integer", description: "Come back in this many minutes." },
        wake_at: { type: "string", description: "ISO 8601 datetime with offset. Use instead of wake_in_minutes." },
        state: { type: "string", description: "running (you are working it) or waiting (it is on someone else now)." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_finish",
    description: "Close a task: 'done' when the goal was actually met, 'failed' when it cannot be, 'cancelled' when they called it off. Say honestly which. A task you could not finish is 'failed', not 'done'.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        state: { type: "string", description: "done | failed | cancelled" },
        outcome: { type: "string", description: "One line: what actually came of it." },
      },
      required: ["task_id", "state", "outcome"],
    },
  },
  {
    name: "task_list",
    description: "Everything you are actually working on, with where each one got to. This answers 'what are you working on', 'any luck with that', 'what's still going'. Never answer those from memory — if it is not in here, you are not working on it.",
    input_schema: { type: "object", properties: { include_closed: { type: "boolean", description: "Also show tasks that finished, failed or were called off." } } },
  },
  {
    name: "remember",
    description: "Save a durable fact about a person or a thing: a preference, an allergy, a usual spot, who someone is, how they like things. Facts pile up under the same subject, so use the person's name as they say it and one fact per call. Not for plan details — those belong in the plan, which changes; this is for what stays true.",
    input_schema: {
      type: "object",
      properties: {
        about: { type: "string", description: "Who or what this is about, as they say it, e.g. 'Kofi', 'Omari', 'sushi spots'. Spelling and case do not create a second subject." },
        fact: { type: "string", description: "One thing, in a short line, in their terms. 'allergic to shellfish', not 'user mentioned a shellfish allergy'." },
      },
      required: ["about", "fact"],
    },
  },
  {
    name: "recall",
    description: "What you actually know. Pass a name or topic for that subject and everything saved about them; leave it empty for everyone you know about. Use it before asking something they have already told you, and before claiming you remember anything.",
    input_schema: { type: "object", properties: { about: { type: "string", description: "A person or topic. Omit for everything." } } },
  },
  {
    name: "forget",
    description: "Drop everything saved about one person or topic. Use it when they ask you to forget someone, or when you saved something wrong. Irreversible.",
    input_schema: { type: "object", properties: { about: { type: "string" } }, required: ["about"] },
  },
  {
    name: "message_send",
    description: "Text someone. 'owner' reaches the person you work for; a phone number in E.164 reaches anyone else — and texting anyone else needs the confirm gate first, with the exact number and the exact words shown to the owner. Fails honestly when no texting channel is connected; check capabilities before you promise to text anybody.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "'owner', or a phone number in E.164 like +14155559876" },
        text: { type: "string", description: "Exactly what to send. Plain text, in your own voice, short." },
        confirmation_id: { type: "integer", description: "From confirm_record, granted, in the last few minutes. Required for anyone but the owner." },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "capabilities",
    description: "What Reason can and cannot do right now. Call this before promising anything outside planning, timers and memory, so you offer only real things.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "confirm_request",
    description: "Step 1 of the confirm gate, for anything that spends money or acts on someone else. Write down exactly what you are about to do, then say it back to the owner in your own words and WAIT for their reply. Returns a confirmation_id.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "The exact name of the tool you intend to call once they say yes" },
        summary: { type: "string", description: "Plainly what will happen, including any amount, place, name or time. This is what the receipt will quote, so be specific." },
        stakes: { type: "string", description: "money | third_party | both" },
      },
      required: ["action", "summary"],
    },
  },
  {
    name: "confirm_record",
    description: "Step 2 of the confirm gate. Call this after the owner replies to the question you asked. The guard reads their actual last message itself and decides. States: 'granted' (go), 'refused' (drop it), 'waiting_for_yes' (ask once more, plainly), or 'changed' — they want it but with a detail different from what you recorded, so nothing is authorized: fix the details, call confirm_request again with the new summary, and ask again. You cannot grant it for them.",
    input_schema: { type: "object", properties: { confirmation_id: { type: "integer" } }, required: ["confirmation_id"] },
  },
  {
    name: "ledger_list",
    description: "Every action Reason actually took that touched the outside world, newest first, with what came back. Use this for 'what did you do today', 'did you actually book it', 'what happened with that'. Never answer those from memory.",
    input_schema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO 8601 datetime. Only actions at or after this. Omit for the most recent regardless of date." },
        limit: { type: "integer", description: "How many, newest first. Default 20, max 100." },
      },
    },
  },
  {
    name: "account_list",
    description: "What Reason can reach on the owner's behalf, and what it cannot. Shows each provider's status: connected, connectable, or not_connected with the exact credentials missing. Call this before promising email, calendar, phone calls or payments.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "account_connect",
    description: "Connect one provider so Reason can act on it. Needs the confirm gate first: call confirm_request, wait for a real yes, confirm_record, then this with the confirmation_id. Fails honestly with not_connected when the provider's credentials are not set up on this machine.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "gmail | google_calendar | phone_out | payments" },
        scopes: { type: "array", items: { type: "string" }, description: "Which of the provider's scopes to grant. Omit for all of them." },
        confirmation_id: { type: "integer", description: "From confirm_record, granted, in the last few minutes" },
      },
      required: ["name"],
    },
  },
  {
    name: "account_revoke",
    description: "Cut off a connected provider immediately. No confirmation needed; taking access away is always allowed.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "web_lookup",
    description: "Fetch one page and read its text. Fast, no JavaScript, no clicking, no logins. Use this to read something; use the browser when you have to interact. You still cannot invent what a page says: only what this returns is real.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full http(s) URL" },
        max_chars: { type: "integer", description: "How much text to return. Default 6000." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_open",
    description: "Open a URL in Reason's own Chromium for this conversation and return a snapshot of the page. The browser stays open between turns and keeps its cookies, so a login persists. Always read the snapshot before clicking anything.",
    input_schema: { type: "object", properties: { url: { type: "string", description: "Full http(s) URL" } }, required: ["url"] },
  },
  {
    name: "browser_read",
    description: "Re-snapshot the page that is currently open: its visible text plus every clickable and fillable element with a ref like e7. Refs change on every snapshot, so read again after anything that changes the page.",
    input_schema: { type: "object", properties: { max_chars: { type: "integer", description: "How much page text to return. Default 6000." } } },
  },
  {
    name: "browser_click",
    description: "Click one element by the ref from the latest snapshot. For moving through a site: links, tabs, a time slot, 'next'. It REFUSES buttons that commit something (confirm, book, pay, submit, order) — those go through browser_submit and the confirm gate.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "A ref from the latest snapshot, e.g. e7" },
        expect: { type: "string", description: "In a few words, what you expect this click to do. Recorded if it commits something." },
      },
      required: ["ref"],
    },
  },
  {
    name: "browser_type",
    description: "Fill one input, textarea or select by ref. Replaces whatever is in it. Read the snapshot again afterwards if the page reacts to typing.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "A ref from the latest snapshot" },
        text: { type: "string", description: "What to put in it. For a select, one of its option values." },
        press_enter: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_submit",
    description: "The only tool that commits something on a website: the final confirm, book, pay or order click. Needs the confirm gate: confirm_request with the exact details, wait for a real yes, confirm_record, then this with the confirmation_id. Always writes a receipt to the ledger, whether it worked or not.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The ref of the commit button from the latest snapshot" },
        what: { type: "string", description: "Exactly what this commits, in one line: place, date, time, party size, price. Goes on the receipt." },
        confirmation_id: { type: "integer", description: "From confirm_record, granted, in the last few minutes" },
      },
      required: ["ref", "what"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Save a PNG of the page as it looks right now, and return the file path. Useful proof for a receipt.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Where to save it. Omit for an auto-named file under the shots folder." },
        full_page: { type: "boolean", description: "Capture the whole scrollable page instead of the viewport" },
      },
    },
  },
  {
    name: "browser_close",
    description: "Close this conversation's browser. The profile and its logins stay on disk for next time.",
    input_schema: { type: "object", properties: {} },
  },
];

const S = {
  plan_create: z.object({ ...PlanFields, title: z.string().min(1).max(200) }),
  plan_list: z.object({ include_closed: z.boolean().optional() }),
  plan_get: z.object({ plan_id: z.number().int() }),
  plan_update: z.object({ plan_id: z.number().int(), ...PlanFields }),
  plan_lock: z.object({ plan_id: z.number().int() }),
  plan_cancel: z.object({ plan_id: z.number().int() }),
  plan_done: z.object({ plan_id: z.number().int() }),
  timer_set: z.object({ fire_at: z.string(), note: z.string().min(1).max(500), plan_id: z.number().int().optional() }),
  timer_list: z.object({}),
  timer_cancel: z.object({ timer_id: z.number().int() }),
  watch_set: z.object({
    url: z.string().min(1).max(2000),
    looking_for: z.string().min(1).max(400),
    every_minutes: z.number().int().min(1).max(60 * 24 * 7).optional(),
    note: z.string().max(300).optional(),
    plan_id: z.number().int().optional(),
  }),
  watch_list: z.object({ include_closed: z.boolean().optional() }),
  watch_cancel: z.object({ watch_id: z.number().int() }),
  task_start: z.object({
    title: z.string().min(1).max(120), goal: z.string().min(1).max(600),
    wake_in_minutes: z.number().int().min(0).max(60 * 24 * 365).optional(),
    wake_at: z.string().max(60).optional(),
  }),
  task_update: z.object({
    task_id: z.number().int(), progress: z.string().max(600).optional(),
    wake_in_minutes: z.number().int().min(0).max(60 * 24 * 365).optional(),
    wake_at: z.string().max(60).optional(),
    state: z.string().max(20).optional(),
  }),
  task_finish: z.object({ task_id: z.number().int(), state: z.enum(["done", "failed", "cancelled"]), outcome: z.string().min(1).max(600) }),
  task_list: z.object({ include_closed: z.boolean().optional() }),
  remember: z.object({ about: z.string().min(1).max(100), fact: z.string().min(1).max(500) }),
  recall: z.object({ about: z.string().max(100).optional() }),
  forget: z.object({ about: z.string().min(1).max(100) }),
  message_send: z.object({ to: z.string().min(1).max(40), text: z.string().min(1).max(1500), confirmation_id: z.number().int().optional() }),
  capabilities: z.object({}),
  confirm_request: z.object({ action: z.string().min(1).max(60), summary: z.string().min(1).max(600), stakes: z.string().max(40).optional() }),
  confirm_record: z.object({ confirmation_id: z.number().int() }),
  ledger_list: z.object({ since: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
  account_list: z.object({}),
  account_connect: z.object({ name: z.string().min(1).max(40), scopes: z.array(z.string().max(40)).max(20).optional(), confirmation_id: z.number().int().optional() }),
  account_revoke: z.object({ name: z.string().min(1).max(40) }),
  web_lookup: z.object({ url: z.string().min(1).max(2000), max_chars: z.number().int().min(200).max(20_000).optional() }),
  browser_open: z.object({ url: z.string().min(1).max(2000) }),
  browser_read: z.object({ max_chars: z.number().int().min(200).max(20_000).optional() }),
  browser_click: z.object({ ref: z.string().min(1).max(20), expect: z.string().max(200).optional() }),
  browser_type: z.object({ ref: z.string().min(1).max(20), text: z.string().max(2000), press_enter: z.boolean().optional() }),
  browser_submit: z.object({ ref: z.string().min(1).max(20), what: z.string().min(1).max(400), confirmation_id: z.number().int().optional() }),
  browser_screenshot: z.object({ path: z.string().max(400).optional(), full_page: z.boolean().optional() }),
  browser_close: z.object({}),
};

function timerView(t) {
  return t && { id: t.id, fires_at: stamp(t.fire_at), fire_at_iso: new Date(t.fire_at).toISOString(), note: t.note, plan_id: t.plan_id };
}

function watchView(w) {
  if (!w) return null;
  const status = w.met_at ? "found_it" : w.cancelled_at ? "called_off" : w.gave_up_at ? "gave_up" : "watching";
  return {
    id: w.id, status, url: w.url, looking_for: w.looking_for, note: w.note || undefined,
    every_minutes: Math.round(w.every_ms / 60_000), plan_id: w.plan_id, checks: w.checks,
    last_checked: w.last_checked_at ? stamp(w.last_checked_at) : null,
    found_at: w.met_at ? stamp(w.met_at) : null, why: w.met_why || undefined,
  };
}

function taskView(t) {
  if (!t) return null;
  return {
    id: t.id, title: t.title, goal: t.goal, state: t.state,
    started: stamp(t.created_at),
    next_wake: t.next_wake_at ? stamp(t.next_wake_at) : null,
    woken_times: t.wakes,
    outcome: t.outcome || undefined,
    finished: t.finished_at ? stamp(t.finished_at) : undefined,
    progress: t.log.filter(l => l.kind !== "state").map(l => `${stamp(l.at)}: ${l.note}`),
  };
}

/** Turn whichever of wake_at / wake_in_minutes the model sent into one timestamp, or an error. */
function wakeFrom(input) {
  if (input.wake_at !== undefined) {
    const at = Date.parse(input.wake_at);
    if (Number.isNaN(at)) return { error: `Could not parse wake_at '${input.wake_at}'. Use ISO 8601 with an offset.` };
    return { at };
  }
  if (input.wake_in_minutes !== undefined) return { at: clock.now() + input.wake_in_minutes * 60_000 };
  return {};
}

/** What outside thing this call touched, for the ledger's target column. */
function targetOf(name, input) {
  switch (name) {
    case "account_connect": case "account_revoke": return `account:${input.name}`;
    case "message_send": return `text:${input.to}`;
    case "call_place": return `call:${input.to}`;
    case "web_lookup": case "browser_open": return input.url ?? "";
    case "browser_submit": case "browser_click": return input.what ?? input.expect ?? `ref:${input.ref}`;
    default: return "";
  }
}

/**
 * The only way state changes. Three things happen around every call, in this order:
 *   1. zod checks what the model sent
 *   2. the confirm gate blocks money / third-party actions without a spent yes
 *   3. anything that touched the outside world leaves a ledger row, success or not
 */
export async function runTool(name, rawInput, ctx) {
  const schema = S[name];
  if (!schema) return { error: `Unknown tool ${name}` };
  const parsed = schema.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false, error: "Bad input: " + parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const input = parsed.data;
  const c = ctx.conversationId;

  // The thread check, before anything else. A conversation that belongs to a number which is not
  // the owner's cannot open the gate, cannot spend, and cannot act on anyone — however politely
  // the text in it asks, and whoever it claims to be. Owner identity is config; this is the line
  // where that fact is enforced rather than trusted.
  if (!db.isOwnerThread(c) && (GATED_ANYWHERE.has(name) || needsConfirmation(name, input))) {
    const refusal = {
      ok: false, blocked: "not_the_owners_thread",
      error: `This conversation is not ${config.ownerName}'s. Nothing here can spend money, connect an account, or act on anyone else, and a yes typed here authorizes nothing. If this needs doing, it has to be ${config.ownerName} who asks, in their own thread. Tell them plainly that you can't do that for them here.`,
    };
    if (OUTSIDE_WORLD.has(name)) trust.ledgerWrite({ conversationId: c, action: name, input, out: refusal, target: targetOf(name, input) });
    return refusal;
  }

  let confirmationId = null;
  let spend = null;
  if (needsConfirmation(name, input)) {
    const gate = trust.authorizeConfirmation({ conversationId: c, action: name, confirmationId: input.confirmation_id });
    if (!gate.ok) {
      trust.ledgerWrite({ conversationId: c, action: name, input, out: gate, target: targetOf(name, input) });
      return gate;
    }
    confirmationId = gate.confirmation.id;
    // The yes is spent the instant the action is really attempted. A tool that calls this and then
    // fails has still spent it, because something may have happened on the other end; a tool that
    // refuses before touching anything never calls it, and the yes survives for one honest retry.
    spend = () => trust.spendConfirmation(c, confirmationId);
  }

  const out = await dispatch(name, input, { ...ctx, spend }, c);
  // Anything that ran to a result has acted, whether or not it announced itself first.
  if (confirmationId && out?.ok !== false) spend();

  if (OUTSIDE_WORLD.has(name)) {
    trust.ledgerWrite({ conversationId: c, action: name, input, out, target: targetOf(name, input), confirmationId });
  }
  return out;
}

async function dispatch(name, input, ctx, c) {
  switch (name) {
    case "plan_create": {
      const plan = db.createPlan(c, input);
      ctx.events?.emit("plan_created", plan);
      const warning = weekdayMismatch(input.when);
      return warning ? { ok: true, plan, warning } : { ok: true, plan };
    }
    case "plan_list": return { plans: db.listPlans(c, { includeClosed: !!input.include_closed }) };
    case "plan_get": {
      const plan = db.getPlan(c, input.plan_id);
      return plan ? { plan } : { ok: false, error: `No plan #${input.plan_id}` };
    }
    case "plan_update": {
      const { plan_id, ...changes } = input;
      if (!Object.keys(changes).length) return { ok: false, error: "Nothing to change" };
      const r = db.updatePlan(c, plan_id, changes);
      const warning = r.ok ? weekdayMismatch(changes.when) : null;
      return warning ? { ...r, warning } : r;
    }
    case "plan_lock": return db.setPlanStatus(c, input.plan_id, "locked");
    case "plan_cancel": {
      const r = db.setPlanStatus(c, input.plan_id, "cancelled");
      if (r.ok) for (const t of db.listTimers(c)) if (t.plan_id === input.plan_id) db.cancelTimer(c, t.id);
      return r;
    }
    case "plan_done": return db.setPlanStatus(c, input.plan_id, "done");
    case "timer_set": {
      const fireAt = Date.parse(input.fire_at);
      if (Number.isNaN(fireAt)) return { ok: false, error: `Could not parse fire_at '${input.fire_at}'. Use ISO 8601 with an offset.` };
      if (fireAt <= clock.now()) return { ok: false, error: `That time (${stamp(fireAt)}) is already in the past. Now is ${stamp()}.` };
      if (input.plan_id && !db.getPlan(c, input.plan_id)) return { ok: false, error: `No plan #${input.plan_id}` };
      return { ok: true, timer: timerView(db.createTimer(c, { fireAt, note: input.note, planId: input.plan_id ?? null })) };
    }
    case "timer_list": return { timers: db.listTimers(c).map(timerView) };
    case "timer_cancel": {
      const r = db.cancelTimer(c, input.timer_id);
      return r.ok ? { ok: true, timer: timerView(r.timer) } : r;
    }
    case "watch_set": {
      let url;
      try { url = new URL(input.url); } catch { return { ok: false, error: `'${input.url}' is not a URL. A watcher needs a page it can actually read.` }; }
      if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: `Only http and https can be watched.` };
      if (input.plan_id && !db.getPlan(c, input.plan_id)) return { ok: false, error: `No plan #${input.plan_id}` };
      // A floor on the interval, so a watcher cannot be set to hammer a page every few seconds.
      const asked = input.every_minutes ?? config.watchMinEveryMin;
      const everyMin = Math.max(asked, config.watchMinEveryMin);
      const watch = db.createWatch(c, {
        url: url.href, lookingFor: input.looking_for, note: input.note ?? "",
        everyMs: everyMin * 60_000, planId: input.plan_id ?? null,
      });
      return {
        ok: true, watch: watchView(watch),
        ...(everyMin !== asked ? { note: `Asked for every ${asked} min; the floor is ${config.watchMinEveryMin}, so it checks every ${everyMin}.` } : {}),
        reminder: "Nothing is being claimed yet. Tell them you are watching and what would make you come back, not that you found anything.",
      };
    }
    case "watch_list": {
      const watches = db.listWatches(c, { includeClosed: !!input.include_closed }).map(watchView);
      return {
        watches, count: watches.length,
        note: watches.length ? "These are real, running watchers." : "Nothing is being watched. If you told them you would keep an eye on something, you did not actually set it up.",
      };
    }
    case "watch_cancel": {
      const r = db.cancelWatch(c, input.watch_id);
      return r.ok ? { ok: true, watch: watchView(r.watch) } : r;
    }

    case "task_start": {
      const wake = wakeFrom(input);
      if (wake.error) return { ok: false, error: wake.error };
      const task = db.createTask(c, {
        title: input.title, goal: input.goal,
        wakeAt: wake.at ?? clock.now(),
        maxAttempts: config.taskMaxAttempts,
      });
      return {
        ok: true, task: taskView(task),
        note: `This is real and it survives a restart. You will be woken at ${stamp(task.next_wake_at)} to take the next step. Nothing has been done on it yet — do not tell them it is underway as if something happened.`,
      };
    }
    case "task_update": {
      const wake = wakeFrom(input);
      if (wake.error) return { ok: false, error: wake.error };
      if (!input.progress && wake.at === undefined && !input.state) return { ok: false, error: "Nothing to update: send progress, a wake time, or a state." };
      const r = db.updateTask(c, input.task_id, { progress: input.progress ?? null, ...(wake.at !== undefined ? { wakeAt: wake.at } : {}), state: input.state });
      return r.ok ? { ok: true, task: taskView(r.task) } : r;
    }
    case "task_finish": {
      const r = db.finishTask(c, input.task_id, { state: input.state, outcome: input.outcome });
      return r.ok ? { ok: true, task: taskView(r.task) } : r;
    }
    case "task_list": {
      const tasks = db.listTasks(c, { includeClosed: !!input.include_closed }).map(taskView);
      const open = tasks.filter(t => ["running", "waiting"].includes(t.state));
      return {
        tasks, count: tasks.length, open: open.length,
        note: open.length
          ? "These are the jobs really running. Describe them from their progress lines, not from memory."
          : "You are not working on anything. If you told them you were on something, you never actually started it — say so.",
      };
    }

    case "remember": {
      const saved = db.remember(c, input.about, input.fact);
      return {
        ok: true, about: saved.about, fact: saved.fact, already_knew: saved.already_knew,
        knows_about_them: saved.knows,
        note: saved.already_knew ? "You already knew that one; nothing new was saved." : undefined,
      };
    }
    case "recall": {
      const people = db.recall(c, input.about ?? "").map(p => ({
        about: p.about,
        facts: p.facts.map(f => ({ fact: f.fact, saved: stamp(f.saved_at) })),
      }));
      return {
        people, count: people.length,
        note: people.length
          ? "This is everything you actually know. Anything not in here, you do not remember."
          : input.about
            ? `Nothing is saved about '${input.about}'. Do not pretend otherwise — ask them.`
            : "You do not know anything about anyone yet.",
      };
    }
    case "forget": return db.forgetPerson(c, input.about);
    case "message_send": {
      const router = ctx.channels;
      if (!router) {
        return { ok: false, status: "not_connected", error: `There is no texting channel running, so nothing can be sent anywhere. Say that plainly; do not say you sent it.` };
      }
      const toOwner = addressedToOwner(input.to);
      // Where it goes is settled here, from the thread and from config — never from the model's
      // idea of who "owner" is. A reply to a stranger goes back to the thread it came from.
      const thread = db.getThread(c);
      const channelName = thread?.channel ?? router.list()[0]?.name;
      const to = toOwner
        ? (config.ownerNumbers[0] ?? thread?.address ?? "owner")
        : normalizeNumber(input.to);
      if (!toOwner && !to) return { ok: false, error: `'${input.to}' is not a phone number. Use E.164, e.g. +14155559876, or 'owner'.` };

      const chatId = toOwner || normalizeNumber(thread?.address) === to ? (thread?.chat_id ?? null) : null;
      const r = await router.send({ channel: channelName, to, text: input.text, chatId, idempotencyKey: `reason-${c}-${clock.now()}` });
      if (!r.ok) return { ...r, note: "Nothing was sent. Tell them exactly that, and what it said." };
      return { ok: true, sent_to: to, text: input.text, delivered: r.delivered, note: "This actually went out. You may say you sent it." };
    }

    case "capabilities": return { capabilities: capabilitiesNow(ctx), owner: config.ownerName, city: config.ownerCity };

    case "confirm_request":
      return trust.requestConfirmation({
        conversationId: c, messages: ctx.messages ?? [],
        action: input.action, summary: input.summary, stakes: input.stakes ?? "",
      });
    case "confirm_record":
      // ctx.judge lets tests state what a reply means; in production it is the real judge call.
      return await trust.recordConfirmation({
        conversationId: c, messages: ctx.messages ?? [],
        confirmationId: input.confirmation_id, judge: ctx.judge,
      });

    case "ledger_list": {
      let since = null;
      if (input.since) {
        since = Date.parse(input.since);
        if (Number.isNaN(since)) return { ok: false, error: `Could not parse since '${input.since}'. Use ISO 8601.` };
      }
      const actions = db.listActions(c, { since, limit: input.limit ?? 20 });
      return {
        actions: actions.map(a => ({
          id: a.id, action: a.action, target: a.target, outcome: a.outcome,
          receipt: a.receipt, at: stamp(a.at), confirmed_by: a.confirmation_id,
        })),
        count: actions.length,
        note: actions.length ? "This is the whole truth of what Reason did. Nothing outside this list happened." : "Nothing in the ledger. Reason has not touched anything outside this machine here.",
      };
    }

    case "account_list": return trust.listAccounts();
    case "account_connect": {
      const provider = trust.PROVIDERS[input.name];
      if (!provider) return { ok: false, error: `No provider called '${input.name}'. Known: ${Object.keys(trust.PROVIDERS).join(", ")}.` };
      const missing = trust.missingCredentials(input.name);
      if (missing.length) {
        return {
          ok: false, status: "not_connected", name: input.name, missing,
          error: `${input.name} is not connected and cannot be: this machine has no ${missing.join(", ")}. Tell ${config.ownerName} plainly that it needs those set up first. Do not claim it works.`,
        };
      }
      const bad = (input.scopes ?? []).filter(s => !provider.scopes.includes(s));
      if (bad.length) return { ok: false, error: `${input.name} has no scope(s) ${bad.join(", ")}. It offers: ${provider.scopes.join(", ")}.` };
      const row = db.connectAccount(input.name, input.scopes ?? provider.scopes);
      return { ok: true, status: "connected", account: { name: row.name, scopes: JSON.parse(row.scopes), connected_at: stamp(row.connected_at) } };
    }
    case "account_revoke": {
      if (!trust.PROVIDERS[input.name]) return { ok: false, error: `No provider called '${input.name}'.` };
      const row = db.revokeAccount(input.name);
      if (!row) return { ok: false, error: `${input.name} was not connected, so there is nothing to revoke.` };
      return { ok: true, status: "revoked", account: { name: row.name, revoked_at: stamp(row.revoked_at) } };
    }

    case "web_lookup": return await webLookup(input.url, { maxChars: input.max_chars ?? 6000 });

    case "browser_open": {
      const page = await browser.pageFor(c);
      let url;
      try { url = new URL(input.url); } catch { return { ok: false, error: `'${input.url}' is not a URL.` }; }
      if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: `Only http and https.` };
      try {
        const res = await page.goto(url.href, { waitUntil: "domcontentloaded" });
        const snap = await browser.snapshot(page, SNAPSHOT_CHARS);
        return { ok: true, status: res?.status() ?? null, ...snap };
      } catch (e) {
        return { ok: false, error: `Could not open ${url.href}: ${e.message.split("\n")[0]}` };
      }
    }
    case "browser_read": {
      const page = await browser.pageFor(c);
      if (page.url() === "about:blank") return { ok: false, error: "No page open yet. Use browser_open first." };
      return { ok: true, ...(await browser.snapshot(page, input.max_chars ?? SNAPSHOT_CHARS)) };
    }
    case "browser_click": {
      const page = await browser.pageFor(c);
      const label = await browser.refName(page, input.ref);
      if (label === null) return { ok: false, error: `No element ${input.ref} on this page. Call browser_read for fresh refs.` };
      // The guard: a click that commits does not happen here, no matter what the model intends.
      if (COMMIT_WORDS.test(label) || COMMIT_WORDS.test(input.expect ?? "")) {
        const blocked = {
          ok: false, blocked: "commit_needs_gate", element: label,
          error: `'${label}' looks like it commits something. browser_click will not press it. Go through the gate: confirm_request with the exact details, wait for ${config.ownerName} to answer, confirm_record, then browser_submit with that confirmation_id.`,
        };
        trust.ledgerWrite({ conversationId: c, action: "browser_click", input, out: blocked, target: `${page.url()} → ${label}` });
        return blocked;
      }
      try {
        await browser.locate(page, input.ref).click();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        return { ok: true, clicked: label, ...(await browser.snapshot(page, SNAPSHOT_CHARS)) };
      } catch (e) {
        return { ok: false, error: `Could not click ${input.ref} ('${label}'): ${e.message.split("\n")[0]}` };
      }
    }
    case "browser_type": {
      const page = await browser.pageFor(c);
      const label = await browser.refName(page, input.ref);
      if (label === null) return { ok: false, error: `No element ${input.ref} on this page. Call browser_read for fresh refs.` };
      const el = browser.locate(page, input.ref);
      try {
        const tag = await el.evaluate(n => n.tagName.toLowerCase());
        if (tag === "select") await el.selectOption(input.text);
        else await el.fill(input.text);
        if (input.press_enter) {
          await el.press("Enter");
          await page.waitForLoadState("domcontentloaded").catch(() => {});
        }
        return { ok: true, filled: label || input.ref, value: input.text, ...(await browser.snapshot(page, SNAPSHOT_CHARS)) };
      } catch (e) {
        return { ok: false, error: `Could not fill ${input.ref} ('${label}'): ${e.message.split("\n")[0]}` };
      }
    }
    case "browser_submit": {
      const page = await browser.pageFor(c);
      const label = await browser.refName(page, input.ref);
      if (label === null) {
        // Nothing was pressed, so the yes is still good: read the page again and come back with a
        // real ref. It does not have to be re-asked for something that never happened.
        return { ok: false, error: `No element ${input.ref} on this page. Nothing was submitted and ${config.ownerName}'s yes still stands — call browser_read for fresh refs and submit again with the same confirmation_id.` };
      }
      const before = page.url();
      ctx.spend?.(); // past this line the site may already have been told something
      try {
        await browser.locate(page, input.ref).click();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(300);
        const snap = await browser.snapshot(page, SNAPSHOT_CHARS);
        return {
          ok: true, committed: input.what, pressed: label,
          from_url: before, landed_on: snap.url, page_title: snap.title, page_text: snap.text,
          note: "This actually happened. Read page_text and tell them what the site said back, including any confirmation number. Do not add anything the page did not say.",
        };
      } catch (e) {
        return { ok: false, error: `Pressed nothing: ${e.message.split("\n")[0]}`, attempted: input.what };
      }
    }
    case "browser_screenshot": {
      const page = await browser.pageFor(c);
      if (page.url() === "about:blank") return { ok: false, error: "No page open yet." };
      const safeConv = c.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
      const path = input.path ?? join(config.shotRoot, `${safeConv}-${Date.now()}.png`);
      mkdirSync(dirname(resolve(path)), { recursive: true });
      await page.screenshot({ path: resolve(path), fullPage: !!input.full_page });
      return { ok: true, path: resolve(path), url: page.url() };
    }
    case "browser_close": {
      const open = browser.openConversations().includes(c);
      await browser.closeBrowser(c);
      return { ok: true, closed: open, note: open ? "Browser closed. The profile and its logins are still on disk." : "No browser was open." };
    }

    default: return { error: `Unknown tool ${name}` };
  }
}
