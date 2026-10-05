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
import { webSearch, searchCapability, searchStatus } from "./search.js";
import { startRun as researchStart, step as researchStep, view as researchView } from "./research.js";
import { videoUnderstand, videoCapability } from "./video.js";
import { LIVE_STATES, SPOKE_TO_SOMETHING, announcementFor, callRulesFor } from "./calls/provider.js";
import { checkCallForPaymentDetails } from "./calls/payments.js";
import * as accounts from "./accounts.js";
import * as access from "./access.js";
import { deleteData as dataDelete } from "./data.js";
import { checkContent } from "./pages/content.js";
import { pageUrl, linksAreReachable } from "./pages/access.js";
import { storeRecording } from "./calls/recordings.js";

// Tools that touch something outside this machine. Every call, success or not, leaves a ledger row.
// Clicks and typing inside an already-open page are steps, not outcomes; the step that has a real
// consequence is browser_submit, which is gated and always recorded.
const OUTSIDE_WORLD = new Set(["account_connect", "account_revoke", "browser_open", "browser_submit", "web_lookup", "video_understand", "message_send", "call_place",
  // Searching and researching both leave the machine and both spend a metered allowance, so
  // "what did you do today" has to be able to answer "you ran four searches and read six pages",
  // and the research receipt names the sites — an answer's sources are checkable weeks later.
  "web_search", "research",
  // A page is a thing the owner can open from a link, and sharing one makes it public. "What
  // did you do today" has to be able to answer "you made this page, and you shared it".
  "page_create", "page_update", "page_share", "page_unshare", "page_delete",
  // The master's own acts on other people. "What did you do today" has to be able to answer
  // "you let Kofi in", "you blocked that number", "you deleted their Reason".
  "admin_pause", "admin_resume", "admin_remove", "admin_block", "admin_delete"]);
// Tools that spend money or act on a third party. They will not run without a spent confirmation.
// admin_delete destroys somebody's entire Reason and cannot be undone, so it is gated like any
// other irreversible act: the master has to be shown whose, and say yes to that.
const ALWAYS_NEEDS_CONFIRMATION = new Set(["account_connect", "browser_submit", "admin_delete"]);

/**
 * Does this call need an explicit yes? Mostly a fixed list, but two tools depend on who they are
 * pointed at: texting or calling the owner is Reason talking to the person it works for, while
 * texting or calling anyone else acts on a third party and goes through the gate with the exact
 * number on the record. The destination is read here, in code, not taken on the model's word.
 */
function needsConfirmation(name, input, conversationId) {
  if (ALWAYS_NEEDS_CONFIRMATION.has(name)) return true;
  if (name === "message_send" || name === "call_place") return !addressedToOwner(conversationId, input.to);
  return false;
}

// These only mean anything inside somebody's own Reason. A conversation with no account behind it
// has nobody to authorize anything, so a yes typed there is a yes from nobody.
const GATED_ANYWHERE = new Set(["confirm_request", "confirm_record", "account_connect", "account_revoke", "browser_submit", "message_send", "call_place"]);

/**
 * Is this address the person whose Reason this is?
 *
 * "owner" used to mean one number in config. Now every person has their own Reason, so it means
 * *this conversation's* person — and texting or ringing anybody else is still acting on a third
 * party and still goes through the gate. The scope is what makes that safe: the address is read
 * off this conversation's account, never off the message.
 */
function addressedToOwner(conversationId, to) {
  const t = String(to ?? "").trim();
  if (t.toLowerCase() === "owner") return true;
  const mine = accounts.ownerOf(conversationId).address;
  const n = normalizeNumber(t);
  return !!n && !!mine && normalizeNumber(mine) === n;
}

// Browser snapshots stack up in the conversation history, so they stay small by default.
// The model asks for more with max_chars when a page really needs it.
const SNAPSHOT_CHARS = Number(process.env.REASON_SNAPSHOT_CHARS || 3000);

// Does pressing this commit the owner to something?
//
// The rule used to include the model's own `expect` text, which meant the model's wording decided
// whether the owner got asked. It also meant a time slot linked as /reserve?… was treated as a
// booking, so a yes was spent navigating to a form and there was none left for the booking. Only
// the click that really commits needs a yes; picking a slot or opening a form commits nothing.
//
// So the decision is made from what the element IS:
//
//   - an anchor with an href navigates. A GET to another page does not book, buy or send
//     anything, so it is not a commit — whatever its label says. This is what lets Reason pick a
//     time and open a booking form without spending the owner's yes.
//   - everything else — a submit control, a button, anything scripted — is judged by the page's
//     own label for it. The page saying "Confirm reservation" is the page telling us what that
//     button does, which is a very different thing from the model saying so.
//   - a label we cannot read at all is a commit. Unclear fails closed.
//
// The one exception to the navigation rule is money. A link that charges a card on tap is the
// thing you cannot take back, and "it was only a GET" is no comfort afterwards, so a link labelled
// pay/buy/checkout/order still goes through the gate.
const COMMIT_WORDS = /\b(submit|confirm|book|booking|reserve|reservation|complete|checkout|check ?out|place (the )?order|order now|pay|payment|purchase|buy|charge|subscribe|send|apply|finish|agree|accept)\b/i;
const MONEY_WORDS = /\b(pay|payment|purchase|buy|checkout|check ?out|place (the )?order|order now|charge|subscribe|donate|tip)\b/i;

/**
 * @param {{tag: string, type: string, name: string, href: string, inForm: boolean, isSubmit: boolean}|null} el
 * @returns {{commits: boolean, why: string}}
 */
export function clickCommits(el) {
  if (!el) return { commits: true, why: "the element could not be inspected" };
  const label = String(el.name ?? "").trim();

  if (el.tag === "a" && String(el.href ?? "").trim()) {
    if (MONEY_WORDS.test(label)) {
      return { commits: true, why: `it is a link labelled '${label}', and a link that takes money on tap cannot be undone` };
    }
    return { commits: false, why: "it is a link: following it opens a page, which commits nothing" };
  }
  if (!label) {
    return { commits: true, why: `this ${el.tag}${el.type ? ` (${el.type})` : ""} has no readable label, so what it does is unknown` };
  }
  if (COMMIT_WORDS.test(label)) {
    return { commits: true, why: `the page labels it '${label}'` };
  }
  return { commits: false, why: `the page labels it '${label}', which does not commit anything` };
}

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
  // Both rewritten by capabilitiesNow() from whether a search key is really on the machine. With
  // no key there is no searching, and saying otherwise is the one thing this tool exists to prevent.
  { name: "web_search", status: "live", what: "search the web" },
  { name: "research", status: "live", what: "answer a question from several sources" },
  // Rewritten every time by capabilitiesNow() from what is actually on the machine: yt-dlp for the
  // metadata, captions and audio, and a video model for taking the video. Either can be absent.
  { name: "video", status: "live", what: "find out what is in a video" },
  { name: "browser", status: "live", what: "a real Chromium Reason drives itself: open a site, read it, click, fill forms, screenshot. One profile per conversation, so logins stick. The final commit click always needs an explicit yes" },
  { name: "venue_search", status: "not connected", what: "no venue database. Reason can only read a page you point it at, or drive a site in the browser. It cannot invent restaurants, showtimes or prices." },
  { name: "payments", status: "not connected", what: "send a pay link, split a bill, refund. Needs a payments provider key that is not set up." },
  { name: "email", status: "not connected", what: "read and send email. Needs Google OAuth credentials that are not set up." },
  { name: "calendar", status: "not connected", what: "read and write calendar events. Needs Google OAuth credentials that are not set up." },
  { name: "phone_calls", status: "not connected", what: "call a place or a person, report back, and send the recording. Needs a telephony key and a number that are not set up." },
  { name: "pages", status: "live", what: "turn an answer into a small web page the owner opens from a link — a shortlist with pictures and prices, an itinerary, a plan, a guide. Private by default: the link alone will not open it. The same page can be updated later at the same link, the owner can tap answers on it, and it can be made shareable when they ask" },
  { name: "long_tasks", status: "live", what: "work that outlives a message: an errand, a wait for someone to come back, a multi-step job. It is a real row that survives a restart, wakes on a schedule, and only speaks up when something actually changed. 'What are you working on' is read from it" },
  { name: "message_people", status: "not connected", what: "text the crew directly to collect answers. Not connected yet; only this DM exists." },
];

/**
 * Things Reason will not do, as distinct from things it cannot do yet.
 *
 * The list above is about plumbing: connect a key and "not connected" becomes "live". This list
 * never becomes live. It is separate because "I can't do that yet" and "I don't do that" are
 * different answers, and the second one should not sound like an apology or an invitation to ask
 * again next week. A model that cannot tell them apart will offer a workaround for both.
 */
export const WONT_DO = [
  {
    name: "pay_by_phone",
    what: "give payment details out loud on a phone call — card number, expiry, security code, bank details, a PIN — for any reason, including to hold a booking."
      + " Every call carries that rule, and a call that would have carried payment details is refused before it is dialled."
      + " If something needs paying: ask them for a payment link or another way to pay, and bring it back to the owner.",
  },
  {
    name: "coding_workspace",
    what: "write, run or ship code: no scripts, no repositories, no pull requests, no deploys, no build commands."
      + " This is outside what Reason is for. Say so plainly and do not offer a workaround — it is not a missing integration and it is not coming later.",
  },
];

/**
 * Capabilities as they really are this second. The static list above is the floor; texting and
 * phone calls are rewritten from the adapters that are actually running, because the whole point
 * of this tool is that it cannot be out of date about what Reason can do.
 */
export function capabilitiesNow({ channels = null, calls = null, conversationId = config.ownerConversation, ownerName = null } = {}) {
  const who = ownerName ?? accounts.ownerOf(conversationId).name;
  const out = CAPABILITIES.map(c => ({ ...c }));
  const texting = out.find(c => c.name === "message_people");
  const live = channels?.statuses?.().filter(s => s.status === "live" && s.name !== "console") ?? [];
  if (live.length) {
    texting.status = "live";
    texting.what = `text a real phone number over ${live.map(s => s.name).join(", ")}${live[0].number ? ` from ${live[0].number}` : ""}. Texting anyone but ${who} needs an explicit yes first, with the number and the words shown`;
  } else {
    const missing = (channels?.statuses?.() ?? []).flatMap(s => s.missing ?? []);
    texting.status = "not connected";
    texting.what = `no texting channel is connected${missing.length ? `: this machine has no ${[...new Set(missing)].join(", ")}` : " on this machine"}. Only this conversation exists. Do not offer to text anyone`;
  }

  // The providers the accounts registry already knows about. Reading them here keeps the two
  // from contradicting each other — a capability list that says "payments: not connected" while
  // account_list says "connectable" teaches the model to distrust both.
  for (const [cap, provider] of [["payments", "payments"], ["email", "gmail"], ["calendar", "google_calendar"]]) {
    const entry = out.find(c => c.name === cap);
    const st = trust.accountStatus(conversationId, provider);
    if (st.status === "connected") {
      entry.status = "live";
      entry.what = `${st.what} — connected (${st.scopes.join(", ")})`;
    } else if (st.status === "connectable") {
      entry.status = "connectable";
      entry.what = `${st.what}. The credentials are on this machine but the account is not connected yet; connecting it needs ${who}'s explicit yes`;
    } else {
      entry.status = "not connected";
      entry.what = `${st.what}. Needs ${st.missing.join(", ")}, which this machine does not have. Do not offer it`;
    }
  }

  // Video, from what is actually on the machine: yt-dlp for the metadata, the captions and the audio
  // track, and a video model for taking the video itself. The wording in src/video.js is careful
  // about which of the three it is offering, because only one of them sees a picture.
  const video = out.find(c => c.name === "video");
  if (video) Object.assign(video, videoCapability());

  // Search, and research on top of it. Research cannot be live without search: reading pages you
  // already knew the address of is not research, and the capability list says which one is on offer.
  const search = searchStatus();
  const searchCap = searchCapability({ status: search });
  const searchEntry = out.find(c => c.name === "web_search");
  if (searchEntry) Object.assign(searchEntry, searchCap);
  const researchEntry = out.find(c => c.name === "research");
  if (researchEntry) {
    researchEntry.status = search.connected ? "live" : "not connected";
    researchEntry.what = search.connected
      ? `answer a question properly: several different searches, the best sources read in full, a source log kept of what each one said and when, then a real pick.`
        + ` Capped at ${config.researchMaxSearches} searches, ${config.researchMaxPages} pages and ${config.researchMaxSeconds}s per go, and it says when a cap cut it short.`
        + ` A big question can run as a durable task that survives a restart. Nothing it says can come from outside that source log`
      : `no real research: it needs web search, and ${search.missing?.length ? `this machine has no ${search.missing.join(", ")}` : "no search provider is built here"}.`
        + ` Reason can read a page whose address it can name itself and say honestly that is all it did — one page is not research and it must not be called that`;
  }

  // Pages always work; whether their links work from a phone is a different question, and one the
  // owner has to be told the real answer to rather than finding out by tapping one.
  const pages = out.find(c => c.name === "pages");
  if (pages && !linksAreReachable()) {
    pages.what += `. REASON_PUBLIC_URL is not set on this machine, so a page link only opens here — say that rather than sending ${who} a link that will not work on their phone`;
  }

  const phone = out.find(c => c.name === "phone_calls");
  const provider = calls?.status?.();
  if (provider?.status === "live" && provider.records !== false) {
    phone.status = "live";
    phone.what = `call a number with a goal, hold, and report back what was said (${provider.name}).`
      + ` Calling anyone but ${who} needs an explicit yes first, with the exact number and goal shown.`
      + ` Every call opens by saying it is an AI assistant for ${who} and that it is recorded,`
      + ` and ${who} gets the audio along with the summary`;
  } else if (provider?.status === "live") {
    // Connected but cannot record. Every call is recorded, so this is not a usable phone provider.
    phone.status = "not connected";
    phone.what = `the phone provider that is set up (${provider.name}) cannot record calls, and every call Reason places is recorded. So Reason cannot call anyone. Do not offer to`;
  } else {
    phone.status = "not connected";
    phone.what = `no phone provider is wired up${provider?.missing?.length ? `: this machine has no ${provider.missing.join(", ")}` : ""}. Reason cannot call anyone. Do not offer to`;
  }
  return out;
}

// What a page may contain, in the words the model reads. The authoritative version is the
// checker in src/pages/content.js — this is that list said once, where the model will see it.
const BLOCKS_DESC = [
  'An array of blocks, in order. Each is an object with a "type":',
  "{type:'section',title} a heading that starts a new part;",
  "{type:'text',text} a paragraph or several, blank line between them;",
  "{type:'image',url,caption?} an https picture — ONLY a url that came back from a tool in this conversation, never one you typed from memory;",
  "{type:'table',columns:[..],rows:[[..]],title?} a comparison; every row the same length as columns;",
  "{type:'links',items:[{label,url,note?}],title?} things to open;",
  "{type:'cards',items:[{title,image?,price?,note?,url?}],title?} a shortlist — the right block for gifts, places or options with prices;",
  "{type:'choice',key,question,options:[{label,note?}]} a question the owner taps an answer to, which comes back to you as an event turn.",
  "No HTML, no markdown, no scripts: you give the data and Reason's own template draws the page.",
].join(" ");

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
    name: "my_name",
    description: "Save what the person you work for wants to be called. Call it as soon as they tell you their name, or correct it. It is THEIR name only, never anyone else's, and never a guess: only what they said. It goes on their account, so pages and greetings use it.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "The name exactly as they gave it, e.g. 'Kofi'." } },
      required: ["name"],
    },
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
    name: "call_place",
    description: "Ring a real phone with a goal, and get back what was actually said. Use it when text cannot do the job — a restaurant with no booking page, a handyman who never replies, a shop you need an answer from today. 'owner' calls the person you work for; any other number acts on a third party and needs the confirm gate first, with the exact number and the exact goal shown to the owner before they say yes. Every call opens by announcing that it is an AI assistant calling for the owner, and that it is recorded — that line is written by code, you do not control it and do not need to mention writing it. The recording is sent to the owner with your summary automatically. Every call also carries a standing rule that no payment details are ever given out by phone: if they ask for payment, the call declines and asks for a pay link or another way, and you tell the owner. Never put payment details in the goal or the facts — the call is refused before it is dialled.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "'owner', or a phone number in E.164 like +12125551234" },
        goal: { type: "string", description: "What you are ringing to achieve, specific enough that the result settles it: 'ask if they have a table for 4 at 8pm Saturday, and if not the nearest time'." },
        facts: { type: "array", items: { type: "string" }, description: "The ONLY things this call may tell them. Name, party size, a phone number to hold it under — whatever the job needs and nothing more. Everything you leave out stays private. NEVER payment details: no card number, no expiry, no security code, no bank details, no PIN, for any reason, not even to hold a booking. A call carrying them is refused before it is dialled." },
        max_minutes: { type: "integer", description: "Hang up after this long. Default from config." },
        confirmation_id: { type: "integer", description: "From confirm_record, granted, in the last few minutes. Required for anyone but the owner." },
      },
      required: ["to", "goal"],
    },
  },
  {
    name: "call_status",
    description: "How a call went: whether it connected, what was said, how long it took, and whether there is a recording. Call this after call_place rather than guessing — a call that is still ringing has no result yet, and you may not claim one. The audio, when there is any, rides out with your next message automatically; when there is none the result says so and you must say so too instead of implying one exists. With no id, the recent calls on this conversation.",
    input_schema: { type: "object", properties: { call_id: { type: "integer", description: "The id call_place returned. Omit for the recent ones." } } },
  },
  {
    name: "page_create",
    description: "Turn an answer into a small web page the owner opens from a link. Use it when a text would be too long to read on a phone, or when pictures, a comparison or sections make it genuinely easier to use — a gift shortlist with prices, an itinerary, a plan, a guide. Offer it when an answer is getting long, and make one straight away when they ask for something they can come back to. Private by default: the link alone will not open it, so the owner gets a one-time code the first time on a new browser. You give structured blocks, never HTML.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, how you would say it: 'Gift ideas for your mum', 'Lisbon, 3 days'" },
        blocks: { type: "array", description: BLOCKS_DESC, items: { type: "object" } },
      },
      required: ["title", "blocks"],
    },
  },
  {
    name: "page_update",
    description: "Change a page you already made, keeping the same link. The owner's bookmark and anything you already texted them still work, so prefer this over making a second page about the same thing. Send the full blocks you want the page to have now, not a patch.",
    input_schema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The id page_create returned." },
        title: { type: "string", description: "A new title. Leave it out to keep the current one." },
        blocks: { type: "array", description: BLOCKS_DESC, items: { type: "object" } },
      },
      required: ["page_id"],
    },
  },
  {
    name: "page_share",
    description: "Make a page readable by anyone who has the link, with no code. ONLY when the owner asks for something they can send to somebody — never on your own initiative, because it turns their private page into a public one. Choices on a shared page become read-only, so nobody else can answer for them.",
    input_schema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
  },
  {
    name: "page_unshare",
    description: "Make a shared page private again. Takes effect immediately: the next person to open that link gets the code prompt instead of the page.",
    input_schema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
  },
  {
    name: "page_list",
    description: "The pages on this conversation: title, link, whether it is shared, when it changed, and any answers the owner has tapped. Read this rather than guessing whether you already made a page about something.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "page_delete",
    description: "Delete a page and everything with it — the link stops working, the signed-in browsers are cut off, and the owner's answers on it are gone. Only when they ask.",
    input_schema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
  },
  {
    name: "admin_requests",
    description: "Master only. Who has texted asking for their own Reason and is still waiting, with the exact words of their first message. This is the ONLY thing of theirs you ever see before they are let in. You cannot approve anyone with this or any other tool — the master says yes or no in their own words and the guard reads it.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "admin_usage",
    description: "Master only. Who has a Reason, whether it is answering, and how much each of them has used it — counts only, never a word of what anybody said. The master pays the bill, so this is how they see it; it is NOT a way to read other people's conversations, and there is no tool that is.",
    input_schema: { type: "object", properties: { days: { type: "integer", description: "How many days back. Default 7." } } },
  },
  {
    name: "admin_pause",
    description: "Master only. Stop Reason answering someone, keeping everything of theirs. Use when the master wants a break rather than an ending — admin_resume puts it back. Nothing is deleted.",
    input_schema: { type: "object", properties: { number: { type: "string" } }, required: ["number"] },
  },
  {
    name: "admin_resume",
    description: "Master only. Start answering someone again after a pause.",
    input_schema: { type: "object", properties: { number: { type: "string" } }, required: ["number"] },
  },
  {
    name: "admin_remove",
    description: "Master only. Their Reason stops answering. Their data is KEPT — say so, because 'remove' sounds like deletion and is not. Deleting it is a separate thing the master has to ask for.",
    input_schema: { type: "object", properties: { number: { type: "string" } }, required: ["number"] },
  },
  {
    name: "admin_block",
    description: "Master only. Shut a number out for good: it gets no reply at all and the master is never asked about it again. For a nuisance, not for someone the master simply does not want to set up — that is admin_remove or saying no.",
    input_schema: {
      type: "object",
      properties: { number: { type: "string" }, note: { type: "string", description: "Why, for the master's own records." } },
      required: ["number"],
    },
  },
  {
    name: "admin_delete",
    description: "Master only, and only when they clearly ask for it. Delete everything of somebody's: their plans, memory, receipts, pages, recordings, account, the lot. It cannot be undone, so say back exactly whose it is and what goes, and only call this when they have said yes to that.",
    input_schema: {
      type: "object",
      properties: { number: { type: "string" }, confirmation_id: { type: "integer", description: "From confirm_record, granted, for this exact person." } },
      required: ["number"],
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
        target: { type: "string", description: "What this yes is tied to, and it is checked. For a text or a call: the exact phone number, E.164 — the yes then works for that number and nobody else. For browser_submit: the same one-line 'what' you will pass to it, word for word, so a yes cannot be carried over to a booking with a different time, place or price. It must match what you say to the owner too." },
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
    name: "confirm_pending",
    description: "Questions you have already put to the owner that are still waiting on an answer, with the id and exactly what you said you'd do. Check this before asking again — if there is already an open one for what they just answered, confirm_record THAT id. Asking twice for the same thing makes their yes land on nothing.",
    input_schema: { type: "object", properties: {} },
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
    description: "What Reason can reach on the owner's behalf, and what it cannot. Shows each provider's status: connected, connectable, or not_connected with the exact credentials missing, plus `wont_do` — the things Reason does not do at all, like giving payment details out on a phone call or writing and running code. Call this before promising email, calendar, phone calls or payments, and before telling someone a thing is impossible.",
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
    name: "web_search",
    description: "Search the web and get back ranked results: title, link, a snippet pulled from the page, and a date when the provider has one. Use it when you do not already know which page has the answer — which is most of the time. A snippet is quotable AS A SNIPPET, but it is not the page: to say what a source really claims, read it with web_lookup. One search is not research; for 'which should I buy', 'is X any good', 'what do people say about Y', use the research tool instead, which searches several ways and reads the best sources. If this comes back not_connected there is no search on this machine: say so plainly and read a page you can name yourself instead.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, as you would type it into a search box." },
        max_results: { type: "integer", description: "How many results. Default 8." },
        sites: { type: "array", items: { type: "string" }, description: "Only these domains, e.g. ['reddit.com'] for what people are saying, or ['rtings.com','consumerreports.org'] for tested reviews." },
        recent: { type: "string", description: "day | week | month | year. Use it when the answer goes stale: prices, 'is it out yet', anything current." },
      },
      required: ["query"],
    },
  },
  {
    name: "research",
    description: "Answer a question properly: several different searches, the best sources actually read, and a source log you then answer from. This is the tool for 'iphone 17 or 18', 'is this worth it', 'what do people say about X', 'which of these should i get' — anything where one page is not an answer. Plan the queries yourself and pass them in `queries`: make them genuinely different angles, not the same words reordered (the thing itself, the thing vs the alternative, what owners say — put 'reddit' in one of them — and tested reviews). It comes back with `sources` (pages really read, with the text that came back), `snippets_only` (search results nobody read — Reddit is always one of these, because Reddit forbids fetching), and `skipped` (what would not load, and why). Everything you say has to be in there: a price, a spec, a date or a quote that is not in a source is one you do not have, and you say you could not find it. If a cap cut it short, the result says which, and you say the look was partial. Pass `deep: true` for a big question and it becomes a real task that survives a restart and works through the rest of the queries when it wakes — use that rather than making them wait. Pass `research_id` to carry on a run you already started.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "What they actually want decided, in their words. Required for a new run." },
        queries: { type: "array", items: { type: "string" }, description: "Your plan: a few genuinely different searches. Put 'reddit' in one of them when opinions matter." },
        research_id: { type: "integer", description: "Carry on a run that already exists instead of starting a new one." },
        deep: { type: "boolean", description: "Make it a durable task: it survives a restart, works through the queries when it wakes, and only comes back when there is something to say." },
      },
    },
  },
  {
    name: "video_understand",
    description: "Go to a video and find out what is in it — YouTube and many other video sites. Use this for any video link somebody sends you, and for a video you found yourself. It comes back with the title, the channel, the length, the description, the chapters, and what is in it as timestamped lines you can quote with a real time against them. THREE things can produce those lines and the result ALWAYS says which, because what you may then claim differs: tier 'captions' = it read the captions the video already had, words only; tier 'watch' = a video model was handed the YouTube link and genuinely watched it, picture and sound, so you MAY say you watched it and may describe what was on screen; tier 'listen' = the site was not YouTube so only the audio could be taken and transcribed, words only. Tier 'metadata' = none of it worked and all you have is what the page claims about itself. Read the result's `how` line and talk exactly that way. Off 'captions' or 'listen' you may never describe anything visual — not what was on screen, not what someone looked like, not what a chart or a demo showed. A long result comes back cut short and says so: call this again with from and to rather than guessing. The model tiers cost real money per minute, so they only run when there are no captions or you ask; the same video is never paid for twice. An age gate, a login, a members-only video or a region block comes back as the reason, and that is the answer — Reason does not get round any of them.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The video's URL, as they sent it" },
        question: { type: "string", description: "What they actually want to know, in their words. The video model is asked this directly, so pass it when there is one." },
        from: { type: "string", description: "Start of the stretch you want, as M:SS, H:MM:SS or seconds. Use this to read past where a long transcript was cut off, or to ask about one part of a long video." },
        to: { type: "string", description: "End of that stretch, same formats." },
        watch: { type: "boolean", description: "True when the captions will not do: when the question is about something you can only see (what was on screen, what it looked like, what the demo did), when they ask you to actually watch or listen to it, or when the captions are garbled. Hands the video to a video model, which costs money per minute, so leave it off when the captions answer the question. If no video model is connected the result says so and you say so too." },
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
    description: "The only tool that commits something on a website: the final confirm, book, pay or order click. Picking a time, opening a form and filling it in are ordinary clicks and need no yes — this is the one that does. Needs the confirm gate: confirm_request with the exact details AND target set to the same one-line 'what' you will pass here, wait for a real yes, confirm_record, then this with the confirmation_id. The gate checks that 'what' against the yes, so if any detail has changed since they agreed, ask again. Always writes a receipt to the ledger, whether it worked or not.",
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
  my_name: z.object({ name: z.string().min(1).max(80) }),
  remember: z.object({ about: z.string().min(1).max(100), fact: z.string().min(1).max(500) }),
  recall: z.object({ about: z.string().max(100).optional() }),
  forget: z.object({ about: z.string().min(1).max(100) }),
  message_send: z.object({ to: z.string().min(1).max(40), text: z.string().min(1).max(1500), confirmation_id: z.number().int().optional() }),
  call_place: z.object({
    to: z.string().min(1).max(40), goal: z.string().min(1).max(600),
    facts: z.array(z.string().max(200)).max(20).optional(),
    max_minutes: z.number().int().min(1).max(60).optional(),
    confirmation_id: z.number().int().optional(),
  }),
  call_status: z.object({ call_id: z.number().int().optional() }),
  page_create: z.object({ title: z.string().min(1).max(120), blocks: z.array(z.any()).min(1).max(60) }),
  page_update: z.object({ page_id: z.string().min(1).max(64), title: z.string().min(1).max(120).optional(), blocks: z.array(z.any()).min(1).max(60).optional() }),
  page_share: z.object({ page_id: z.string().min(1).max(64) }),
  page_unshare: z.object({ page_id: z.string().min(1).max(64) }),
  page_list: z.object({}),
  page_delete: z.object({ page_id: z.string().min(1).max(64) }),
  admin_requests: z.object({}),
  admin_usage: z.object({ days: z.number().int().min(1).max(90).optional() }),
  admin_pause: z.object({ number: z.string().min(3).max(40) }),
  admin_resume: z.object({ number: z.string().min(3).max(40) }),
  admin_remove: z.object({ number: z.string().min(3).max(40) }),
  admin_block: z.object({ number: z.string().min(3).max(40), note: z.string().max(200).optional() }),
  admin_delete: z.object({ number: z.string().min(3).max(40), confirmation_id: z.number().int().optional() }),
  capabilities: z.object({}),
  confirm_request: z.object({ action: z.string().min(1).max(60), summary: z.string().min(1).max(600), stakes: z.string().max(40).optional(), target: z.string().max(60).optional() }),
  confirm_record: z.object({ confirmation_id: z.number().int() }),
  confirm_pending: z.object({}),
  ledger_list: z.object({ since: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
  account_list: z.object({}),
  account_connect: z.object({ name: z.string().min(1).max(40), scopes: z.array(z.string().max(40)).max(20).optional(), confirmation_id: z.number().int().optional() }),
  account_revoke: z.object({ name: z.string().min(1).max(40) }),
  web_lookup: z.object({ url: z.string().min(1).max(2000), max_chars: z.number().int().min(200).max(20_000).optional() }),
  web_search: z.object({
    query: z.string().min(1).max(400),
    max_results: z.number().int().min(1).max(20).optional(),
    sites: z.array(z.string().min(1).max(100)).max(10).optional(),
    recent: z.enum(["day", "week", "month", "year"]).optional(),
  }),
  research: z.object({
    question: z.string().min(1).max(400).optional(),
    queries: z.array(z.string().min(1).max(400)).max(10).optional(),
    research_id: z.number().int().optional(),
    deep: z.boolean().optional(),
  }),
  video_understand: z.object({
    url: z.string().min(1).max(2000),
    question: z.string().max(600).optional(),
    from: z.string().max(20).optional(),
    to: z.string().max(20).optional(),
    watch: z.boolean().optional(),
  }),
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

/**
 * A finished call's audio, brought onto this machine and written down — or written down as
 * missing, which is a fault rather than a shrug.
 *
 * Every call is recorded, so for a call that was actually answered there is no benign reason to
 * have no audio. A missing recording therefore: marks the row `missing` with the reason, writes an
 * **error** row to the ledger, and leaves `call_status` shouting about it so the owner is told in
 * plain words. A call nobody picked up is different — there was nothing to record — and is marked
 * `not_applicable` so the real fault stays visible instead of being lost in noise.
 */
async function fileRecording(conversationId, row, live, ctx = {}) {
  const spokeToSomething = SPOKE_TO_SOMETHING.includes(live.state);

  const absent = (why) => {
    const updated = db.updateCall(conversationId, row.id, {
      recording_state: spokeToSomething ? "missing" : "not_applicable",
      recording_why: why,
    });
    if (spokeToSomething) {
      // On the record as a failure, not just in the conversation. "Every call is recorded" is a
      // promise, and a promise that quietly breaks is worse than one that was never made.
      trust.ledgerWrite({
        conversationId, action: "call_recording",
        input: { call_id: row.id },
        out: { ok: false, error: why },
        target: `call:${row.to_number}`,
      });
    }
    return updated;
  };

  if (!live.recording) {
    return absent(live.recordingWhy || "the provider did not return any audio for this call");
  }
  const saved = await storeRecording(row.id, live.recording, ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {});
  if (!saved.ok) return absent(saved.error);

  return db.updateCall(conversationId, row.id, {
    recording_state: "stored",
    recording_file: saved.file,
    recording_format: saved.format,
    recording_seconds: saved.seconds ?? live.durationS ?? null,
    recording_bytes: saved.bytes,
    recording_sha256: saved.sha256,
    recording_why: "",
  });
}

/** One page as the model sees it: the link, not the row. */
function pageView(p) {
  if (!p) return null;
  return {
    page_id: p.id,
    title: p.title,
    link: pageUrl(p.id),
    shared: p.shared,
    revision: p.revision,
    blocks: p.blocks.length,
    updated: stamp(p.updated_at),
  };
}

/** What the model has to know about a page it just made, including how to get the owner in. */
function pageNote(p, who) {
  return `The page is made and the link is above.`
    + ` It is PRIVATE: the link alone will not open it. The first time ${who} opens it on a new browser they are asked for a six-character code, and Reason shows them that code on the spot — so send them the link and tell them you will give them the code when they tap it.`
    + ` After that, that browser stays in.`
    + (linksAreReachable() ? "" : ` REASON_PUBLIC_URL is not set, so this link only opens on this machine — say that rather than letting them tap it on their phone and find nothing.`);
}

function callView(r, who) {
  if (!r) return null;
  const going = LIVE_STATES.includes(r.state);
  const stored = r.recording_state === "stored" && r.recording_file;
  return {
    call_id: r.id, to: r.to_number, goal: r.goal, state: r.state, still_going: going,
    placed: stamp(r.created_at),
    shared: r.facts,
    announced: r.announcement || null,
    outcome: going ? null : (r.outcome || null),
    what_was_said: going ? null : (r.summary || null),
    transcript: going ? null : (r.transcript || null),
    seconds: r.duration_s ?? null,
    cost: r.cost_cents === null || r.cost_cents === undefined ? null : `$${(r.cost_cents / 100).toFixed(2)}`,
    // Every call is recorded, so audio was always meant to exist; what varies is whether there
    // was anybody on the line to record. Kept as its own fact so "the provider lost it" and
    // "nobody picked up" are not the same sentence.
    recording_expected: r.recording_state !== "not_applicable",
    recording: stored
      ? {
        saved: true,
        seconds: r.recording_seconds ?? null,
        size: r.recording_bytes ? `${Math.max(1, Math.round(r.recording_bytes / 1024))} KB` : null,
        format: r.recording_format,
        already_sent: !!r.recording_sent_at,
      }
      : null,
    // The bare reason, for the warning the tool raises when a recording that should exist does not.
    recording_missing_why: r.recording_state === "missing" ? (r.recording_why || "the provider returned none") : undefined,
    recording_note: stored
      ? (r.recording_sent_at
        ? `The audio has already been sent to ${who}.`
        : `The audio is saved and goes out with your next message to ${who} automatically. Do not attach it and do not send it twice.`)
      : going
        ? "The call has not finished, so there is no recording yet."
        : r.recording_state === "missing"
          ? `SOMETHING WENT WRONG: every call is recorded, this one was answered, and the recording is not there — ${r.recording_why || "the provider returned none"}. Tell ${who} that the recording is missing. Do not imply one exists or is on the way.`
          : `Nobody was on this call to record: ${r.recording_why || "it never connected"}. There is no audio, and that is not a fault.`,
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
    case "web_lookup": case "browser_open": case "video_understand": return input.url ?? "";
    case "web_search": return `search:${input.query ?? ""}`;
    case "research": return input.question ? `research:${input.question}` : `research:#${input.research_id ?? "?"}`;
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
  // Whose Reason this is. Everything below that says "the owner" means this person, and every
  // table this touches is already keyed by `c` — which is what keeps one person's Reason out of
  // another's rather than any check added later.
  const me = accounts.ownerOf(c);

  // Fail closed on a conversation that is nobody's: with no account there is nobody to authorize
  // anything, so a yes typed there authorizes nothing. In practice an unadmitted number never
  // gets this far — it never gets a turn at all — but the guard does not depend on that.
  if (!me.known && c !== config.ownerConversation && (GATED_ANYWHERE.has(name) || needsConfirmation(name, input, c))) {
    const refusal = {
      ok: false, blocked: "no_account",
      error: `This conversation does not belong to anybody Reason works for, so nothing here can spend money, connect an account, or act on anyone else, and a yes typed here authorizes nothing. Say plainly that you can't do that here.`,
    };
    if (OUTSIDE_WORLD.has(name)) trust.ledgerWrite({ conversationId: c, action: name, input, out: refusal, target: targetOf(name, input) });
    return refusal;
  }

  let confirmationId = null;
  let spend = null;
  if (needsConfirmation(name, input, c)) {
    // Tools that reach a person carry who they are reaching into the gate, so the yes is checked
    // against that person and not only against the tool's name. browser_submit carries what it is
    // about to commit for the same reason: a yes is for the details the owner was shown, so a
    // submit whose details have moved since the ask has to ask again rather than ride the old yes.
    const target = (name === "message_send" || name === "call_place")
      ? (normalizeNumber(input.to) || input.to)
      : name === "browser_submit" ? input.what
        : name === "admin_delete" ? input.number
          : null;
    const gate = trust.authorizeConfirmation({ conversationId: c, action: name, confirmationId: input.confirmation_id, target });
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

  const out = await dispatch(name, input, { ...ctx, spend, confirmationId }, c, me);
  // Anything that ran to a result has acted, whether or not it announced itself first.
  if (confirmationId && out?.ok !== false) spend();

  if (OUTSIDE_WORLD.has(name)) {
    trust.ledgerWrite({ conversationId: c, action: name, input, out, target: targetOf(name, input), confirmationId });
  }
  return out;
}

async function dispatch(name, input, ctx, c, me = accounts.ownerOf(c)) {
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

    case "my_name": {
      const name = String(input.name ?? "").trim();
      if (!name) return { ok: false, error: "No name given. Ask them what they want to be called." };
      const row = db.setAccountName(c, name);
      // No account row (the console on a fresh install): keep it as a fact so it is not lost.
      if (!row) db.remember(c, name, "this is the person I work for");
      return { ok: true, name, note: "Saved. Use it from now on." };
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
      const toOwner = addressedToOwner(c, input.to);
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

    case "call_place": {
      const provider = ctx.calls;
      const st = provider?.status?.();
      if (!provider || st?.status !== "live") {
        return {
          ok: false, status: "not_connected",
          error: `No phone provider is wired up${st?.missing?.length ? `: this machine has no ${st.missing.join(", ")}` : ""}. Reason cannot call anyone. Say that plainly and offer what you can actually do.`,
        };
      }
      const toOwner = addressedToOwner(c, input.to);
      const to = toOwner ? (me.address || "") : normalizeNumber(input.to);
      if (!to) {
        return { ok: false, error: toOwner
          ? `There is no number on file for ${me.name} (REASON_OWNER_NUMBER is empty), so there is nobody to ring.`
          : `'${input.to}' is not a phone number. Use E.164, e.g. +12125551234.` };
      }
      // Every call is recorded, so a provider that cannot record is a provider Reason cannot call
      // through. Refused here rather than quietly placing a call with no audio to show for it.
      if (st.records === false) {
        return {
          ok: false, status: "cannot_record",
          error: `${st.name} cannot record calls, and every call Reason places is recorded. It will not place this call. Say that plainly: the phone provider that is set up cannot record, so you are not calling anyone.`,
        };
      }

      // Reason never gives payment details by phone. Checked here, on everything the call is
      // allowed to say, before anything is dialled or written down — a card number read onto a
      // recording cannot be taken back, so this fails closed and errs towards refusing.
      const pay = checkCallForPaymentDetails({ goal: input.goal, facts: input.facts ?? [] });
      if (!pay.ok) {
        return { ok: false, status: "payment_details_refused", found: pay.found, error: pay.error };
      }

      const maxSeconds = (input.max_minutes ?? config.callMaxMinutes) * 60;

      // What the call opens with — and what it will not do, whatever it is asked — is not the
      // model's to write, and not the model's to forget. Recording somebody without telling them
      // is illegal in several of the states Reason will be calling into, and paying by phone is
      // never allowed, so both are built here, handed to the provider as their own arguments, and
      // the provider refuses a call that arrives without either.
      const announcement = announcementFor({ ownerName: me.name });
      const rules = callRulesFor({ ownerName: me.name });

      // The row exists before the dial, so a call that is placed and then crashes is still on
      // the record. A call nobody can account for is the thing worth preventing.
      const row = db.createCall(c, {
        provider: st.name, toNumber: to, isOwner: toOwner,
        goal: input.goal, facts: input.facts ?? [], confirmationId: ctx.confirmationId ?? null,
        announcement,
      });
      ctx.spend?.(); // past this line a phone may already be ringing

      let placed;
      try {
        placed = await provider.place({ to, goal: input.goal, facts: input.facts ?? [], maxSeconds, announcement, rules, onBehalfOf: me.name });
      } catch (e) {
        placed = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
      }
      if (!placed.ok) {
        db.updateCall(c, row.id, {
          state: "failed", outcome: `could not be placed: ${placed.error}`,
          // Nobody's phone rang, so there was never anything to record. Not an error about audio.
          recording_state: "not_applicable", recording_why: "the call never happened",
        });
        return { ok: false, call_id: row.id, error: `The call did not go through: ${placed.error}. Nobody's phone rang. Say exactly that.` };
      }
      db.updateCall(c, row.id, { external_id: placed.externalId, state: placed.state ?? "placing" });
      return {
        ok: true, call_id: row.id, to, goal: input.goal, state: placed.state ?? "placing",
        shared: input.facts ?? [],
        announced: announcement,
        recorded: true,
        rules,
        note: "The call is placed, NOT finished. You do not know what was said yet. Use call_status before claiming any outcome; until then the honest line is that you are ringing them."
          + ` It opened by saying it is an AI assistant for ${me.name} and that the call is recorded. The audio goes to ${me.name} with your summary automatically — you do not attach it yourself, and you must not claim it exists until call_status says it is saved.`
          + ` The call carries a standing rule never to give out payment details; if they ask for payment it will decline, ask for a pay link or another way, and that comes back to you to tell ${me.name} about.`,
      };
    }

    case "call_status": {
      const rows = input.call_id ? [db.getCall(c, input.call_id)] : db.listCalls(c, { limit: 5 });
      if (input.call_id && !rows[0]) return { ok: false, error: `No call #${input.call_id} on this conversation.` };
      const provider = ctx.calls;
      const out = [];
      for (const row of rows.filter(Boolean)) {
        let r = row;
        // Only a live call is re-checked; a finished one is read off the record it already has.
        if (provider && row.external_id && LIVE_STATES.includes(row.state)) {
          let live;
          try { live = await provider.check(row.external_id); }
          catch (e) { live = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
          if (live?.ok) {
            r = db.updateCall(c, row.id, {
              state: live.state, outcome: live.outcome ?? "", summary: live.summary ?? "",
              transcript: live.transcript ?? "", duration_s: live.durationS ?? null, cost_cents: live.costCents ?? null,
            });
            // The call has finished, so whether there is audio is now a settled fact. Save it
            // once, here, and write down which it is — a file, or a reason there is not one.
            if (!LIVE_STATES.includes(live.state) && r.recording_state === "pending") {
              r = await fileRecording(c, r, live, ctx);
            }
          }
        }
        out.push(callView(r, me.name));
      }
      const missingAudio = out.filter(cv => cv && cv.recording_missing_why);
      return {
        calls: out, count: out.length,
        note: out.some(cv => cv.still_going)
          ? "At least one of these has not finished. You do not know how it went; do not say you do."
          : out.length ? "This is what really happened on the phone. Quote it; do not embellish it." : "No calls on this conversation.",
        ...(missingAudio.length
          ? {
            audio_warning: `RECORDING MISSING — this is a fault, not a detail. Every call Reason places is recorded,`
              + ` and the recording is not there for ${missingAudio.map(cv => `call #${cv.call_id} (${cv.recording_missing_why})`).join(", ")}.`
              + ` Tell ${me.name} the recording is missing, in plain words, in this message. Do not say you are sending the audio,`
              + ` do not say it is on the way, and do not imply one exists. It is on the ledger as an error.`,
          }
          : {}),
      };
    }

    // ---------- pages ----------
    case "page_create": {
      const checked = checkContent(input.blocks, { seenUrl: (u) => db.hasSeenUrl(c, u) });
      if (!checked.ok) return { ok: false, error: `That page was not made: ${checked.error}` };
      const page = db.createPage(c, { title: input.title, blocks: checked.blocks });
      return { ok: true, ...pageView(page), note: pageNote(page, me.name) };
    }

    case "page_update": {
      const existing = db.getPageIn(c, input.page_id);
      if (!existing) return { ok: false, error: `No page ${input.page_id} on this conversation. page_list shows the ones there are.` };
      if (input.blocks === undefined && input.title === undefined) {
        return { ok: false, error: "Nothing to change: send blocks, a title, or both." };
      }
      let blocks;
      if (input.blocks !== undefined) {
        const checked = checkContent(input.blocks, { seenUrl: (u) => db.hasSeenUrl(c, u) });
        if (!checked.ok) return { ok: false, error: `That page was not changed: ${checked.error}` };
        blocks = checked.blocks;
      }
      const page = db.updatePage(c, input.page_id, { title: input.title, blocks });
      return {
        ok: true, ...pageView(page),
        note: `Changed, at the same link — anything you already sent them still works. This is revision ${page.revision}.`,
      };
    }

    case "page_share": {
      const page = db.setPageShared(c, input.page_id, true);
      if (!page) return { ok: false, error: `No page ${input.page_id} on this conversation.` };
      return {
        ok: true, ...pageView(page),
        note: "Anyone with this link can now read it, with no code. Choices on it are read-only, so nobody can answer for them."
          + " Say plainly that it is now shareable, and give them the link to forward.",
      };
    }

    case "page_unshare": {
      const page = db.setPageShared(c, input.page_id, false);
      if (!page) return { ok: false, error: `No page ${input.page_id} on this conversation.` };
      return {
        ok: true, ...pageView(page),
        note: `Private again, straight away: the next person to open that link gets the code prompt. Anyone already reading it is shut out on their next tap. ${me.name}'s own browser still works.`,
      };
    }

    case "page_list": {
      const pages = db.listPages(c).map(p => ({ ...pageView(p), answers: db.pageChoicesFor(p.id) }));
      return {
        pages, count: pages.length,
        links_open_anywhere: linksAreReachable(),
        note: pages.length
          ? (linksAreReachable() ? "These links work from a phone." : `REASON_PUBLIC_URL is not set, so these links only open on this machine. Do not text one to ${me.name} as though it will work on their phone — say that it is local-only.`)
          : "No pages on this conversation yet.",
      };
    }

    case "page_delete": {
      const page = db.deletePage(c, input.page_id);
      if (!page) return { ok: false, error: `No page ${input.page_id} on this conversation.` };
      return { ok: true, deleted: page.id, title: page.title, note: "Gone: the link is dead, signed-in browsers are cut off, and the answers on it are deleted." };
    }

    // ---------- admin: the master's own controls ----------
    case "admin_requests": case "admin_usage": case "admin_pause": case "admin_resume":
    case "admin_remove": case "admin_block": case "admin_delete": {
      if (!me.isOperator) {
        return {
          ok: false, blocked: "master_only",
          error: `That is ${config.ownerName}'s to do, not yours — only they can let people in, stop someone, or see usage. Say so plainly and do not offer to pass it on.`,
        };
      }

      if (name === "admin_requests") {
        const waiting = access.pendingForMaster();
        return {
          requests: waiting, count: waiting.length,
          note: waiting.length
            ? `These people have texted and are waiting. Their first message is quoted exactly and is the only thing of theirs you can see. To let one in, ${config.ownerName} just answers the question you asked them — you cannot approve anybody yourself, with this or any other tool.`
            : "Nobody is waiting.",
        };
      }

      if (name === "admin_usage") {
        const days = input.days ?? 7;
        const people = db.listAccountsOfPeople().map(a => ({
          number: a.address,
          name: a.name || null,
          is_you: !!a.is_operator,
          state: a.state ?? "active",
          since: stamp(a.created_at),
          last_seen: a.last_seen_at ? stamp(a.last_seen_at) : null,
          usage: db.usageFor(a.conversation_id, { days }),
        }));
        return {
          people, count: people.length,
          waiting: access.pendingForMaster().length,
          blocked: db.listBlocked().map(b => ({ number: b.address, note: b.note || null, since: stamp(b.blocked_at) })),
          caps: { turns_per_day: config.maxTurnsPerDay || "uncapped", proactive_per_day: config.maxProactivePerDay || "uncapped" },
          note: "Counts only. There is no tool that shows you what anybody said — not even for you, in their Reason.",
        };
      }

      const number = normalizeNumber(input.number);
      if (!number) return { ok: false, error: `'${input.number}' is not a phone number. Use E.164, e.g. +14155559876.` };
      if (number === normalizeNumber(me.address)) {
        return { ok: false, error: `That is ${config.ownerName}'s own number. They cannot do that to themselves — say so.` };
      }

      if (name === "admin_block") {
        db.blockNumber(number, input.note ?? "");
        return {
          ok: true, blocked: number,
          note: `${number} gets no reply at all now, and you will never be asked about them again. Nothing of theirs was deleted.`,
        };
      }

      // The rest act on an existing account.
      const row = db.listAccountsOfPeople().find(a => normalizeNumber(a.address) === number && !a.is_operator);
      if (!row) return { ok: false, error: `${number} does not have a Reason, so there is nothing to change. admin_requests shows who is waiting.` };

      if (name === "admin_pause" || name === "admin_resume" || name === "admin_remove") {
        const state = name === "admin_pause" ? "paused" : name === "admin_resume" ? "active" : "removed";
        db.setAccountState(row.conversation_id, state);
        return {
          ok: true, number, state,
          note: state === "active"
            ? `Answering ${number} again.`
            : `Reason has stopped answering ${number}. Everything of theirs is KEPT — say that plainly, because ${state === "removed" ? "'removed'" : "'paused'"} sounds like deletion and is not. ${config.ownerName} has to ask separately to delete it.`,
        };
      }

      // admin_delete: irreversible, so it goes through the gate like anything else that cannot be
      // taken back, and the yes has to name this person.
      const out = dataDelete({ conversation: row.conversation_id });
      return {
        ok: true, deleted: number, rows: out.rows, recordings: out.recordings,
        note: `Everything of ${number}'s is gone: plans, memory, receipts, pages, recordings, their account. This cannot be undone.`,
      };
    }

    case "capabilities": return {
      capabilities: capabilitiesNow({ ...ctx, conversationId: c, ownerName: me.name }),
      // Kept separate from the list above on purpose: these are not waiting on a key.
      wont_do: WONT_DO,
      owner: me.name, city: config.ownerCity,
      note: "`capabilities` is what is plumbed in and can change. `wont_do` is what Reason does not do at all — say so plainly, do not apologise for it, and do not offer a workaround or imply it is coming.",
    };

    case "confirm_request":
      return trust.requestConfirmation({
        conversationId: c, messages: ctx.messages ?? [],
        action: input.action, summary: input.summary, stakes: input.stakes ?? "", target: input.target ?? "",
      });
    case "confirm_record":
      // ctx.judge lets tests state what a reply means; in production it is the real judge call.
      return await trust.recordConfirmation({
        conversationId: c, messages: ctx.messages ?? [],
        confirmationId: input.confirmation_id, judge: ctx.judge,
      });

    case "confirm_pending": {
      const open = db.pendingConfirmations(c)
        .filter(x => !x.granted_at)
        .map(x => ({ confirmation_id: x.id, action: x.action, asked: stamp(x.asked_at), you_said_youd: x.summary, target: x.target || undefined }));
      return {
        waiting_on_an_answer: open, count: open.length,
        note: open.length
          ? "You already asked these. If what they just said answers one of them, confirm_record that id — do not ask again."
          : "Nothing is waiting on an answer from them.",
      };
    }

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

    case "account_list": return trust.listAccounts(c);
    case "account_connect": {
      const provider = trust.PROVIDERS[input.name];
      if (!provider) return { ok: false, error: `No provider called '${input.name}'. Known: ${Object.keys(trust.PROVIDERS).join(", ")}.` };
      // Chosen, listed, and not written yet. Connecting it would record access to something that
      // cannot be used, and the next turn would act as though it worked.
      if (provider.built === false) {
        return {
          ok: false, status: "not_built", name: input.name,
          error: `${input.name} cannot be connected: nothing is built for it yet. ${me.name} has picked it and it is on the list, but there is no code behind it, so connecting it would be pretending. Say that plainly${provider.supply ? ` — it needs ${provider.supply}` : ""}.`,
        };
      }
      const missing = trust.missingCredentials(input.name);
      if (missing.length) {
        return {
          ok: false, status: "not_connected", name: input.name, missing,
          error: `${input.name} is not connected and cannot be: this machine has no ${missing.join(", ")}. Tell ${me.name} plainly that it needs those set up first. Do not claim it works.`,
        };
      }
      const bad = (input.scopes ?? []).filter(s => !provider.scopes.includes(s));
      if (bad.length) return { ok: false, error: `${input.name} has no scope(s) ${bad.join(", ")}. It offers: ${provider.scopes.join(", ")}.` };
      const row = db.connectAccount(c, input.name, input.scopes ?? provider.scopes);
      return { ok: true, status: "connected", account: { name: row.name, scopes: JSON.parse(row.scopes), connected_at: stamp(row.connected_at) } };
    }
    case "account_revoke": {
      if (!trust.PROVIDERS[input.name]) return { ok: false, error: `No provider called '${input.name}'.` };
      const row = db.revokeAccount(c, input.name);
      if (!row) return { ok: false, error: `${input.name} was not connected, so there is nothing to revoke.` };
      return { ok: true, status: "revoked", account: { name: row.name, revoked_at: stamp(row.revoked_at) } };
    }

    case "web_lookup": {
      const out = await webLookup(input.url, { maxChars: input.max_chars ?? 6000 });
      // Write down where it really went and what it really served. This is what later lets a
      // picture onto a page: an image url is only allowed if it came back from a lookup like this
      // one, so the model cannot type one from memory.
      if (out.ok) db.rememberSeenUrls(c, [out.url, ...(out.images ?? [])]);
      return out;
    }

    case "web_search": {
      // `ctx.searchProvider` is how the tests state what the web says; production passes nothing and
      // gets whatever REASON_SEARCH_PROVIDER names, or an honest not_connected.
      const out = await webSearch(input.query, {
        ...(ctx.searchProvider ? { provider: ctx.searchProvider } : {}),
        maxResults: input.max_results, sites: input.sites ?? [], recent: input.recent ?? null,
      });
      if (out.ok) db.rememberSeenUrls(c, out.results.map(r => r.url));
      return out;
    }

    case "research": {
      const deps = {
        ...(ctx.searchProvider ? { provider: ctx.searchProvider } : {}),
        ...(ctx.lookup ? { lookup: ctx.lookup } : {}),
        ...(ctx.robots ? { robots: ctx.robots } : {}),
        ...(ctx.researchCaps ?? {}),
      };

      // Carrying on a run that already exists — the deep path, and what a task wake calls.
      if (input.research_id) {
        const existing = db.getResearch(c, input.research_id);
        if (!existing) return { ok: false, error: `There is no research #${input.research_id} here.` };
        if (existing.state !== "open") {
          return {
            ok: false, error: `Research #${input.research_id} is finished.`,
            ...researchView(existing),
            note: "It is done. Answer from the sources it already has, or start a new run for a different question.",
          };
        }
        return await researchStep(c, input.research_id, deps);
      }

      if (!input.question) return { ok: false, error: "A new research run needs a question. Pass research_id to carry on an existing one." };
      const queries = (input.queries ?? []).map(q => q.trim()).filter(Boolean);
      if (!queries.length) {
        return {
          ok: false, error: "Pass the queries you want run in `queries`. Planning them is your job, not the tool's — a few genuinely different angles, and one with 'reddit' in it when what people think matters.",
        };
      }

      // A deep run is a task, using the same machinery as every other long job: a row that survives a
      // restart, a wake time, and a report only when something really changed. The first slice runs
      // now so the owner is not told "working on it" before anything has happened.
      let task = null;
      if (input.deep) {
        task = db.createTask(c, {
          title: `research: ${input.question}`.slice(0, 120),
          goal: `Answer "${input.question}" from sources actually read, then say the pick and what would change it.`,
          wakeAt: clock.now() + config.taskDefaultWakeMin * 60_000,
          maxAttempts: config.taskMaxAttempts,
        });
      }
      const run = researchStart(c, { question: input.question, queries, taskId: task?.id ?? null });
      const out = await researchStep(c, run.id, deps);
      if (!out.ok) return out;
      return {
        ...out,
        ...(task ? {
          task_id: task.id,
          deep_note: `This is a real task (#${task.id}) as well as a research run, so it survives a restart. You will be woken at ${stamp(task.next_wake_at)} to carry on: call research with research_id ${run.id}, then task_update with what it found, or task_finish when the question is answered. Do not tell them it is finished until it is.`,
        } : {}),
      };
    }

    case "video_understand": {
      const out = await videoUnderstand(input.url, {
        question: input.question,
        from: input.from, to: input.to, watch: !!input.watch,
        // The tests drive the real parsing, trimming, caching and audio handling against fixture
        // files and a fake video model; production never passes these, so the defaults in
        // src/video.js are what runs.
        ...(ctx.videoRun ? { run: ctx.videoRun } : {}),
        ...(ctx.videoModel !== undefined ? { model: ctx.videoModel } : {}),
        ...(ctx.videoModelStatus ? { modelStatus: ctx.videoModelStatus } : {}),
        ...(ctx.videoTranscriber !== undefined ? { transcriber: ctx.videoTranscriber } : {}),
        ...(ctx.videoMaxMinutes ? { maxMinutes: ctx.videoMaxMinutes } : {}),
      });
      // Same rule as web_lookup: a picture may only go on a Reason page if its address came back
      // from a tool in this conversation. A video's thumbnail did.
      if (out.ok && out.images?.length) db.rememberSeenUrls(c, [out.url, ...out.images]);
      return out;
    }

    case "browser_open": {
      const page = await browser.pageFor(c);
      let url;
      try { url = new URL(input.url); } catch { return { ok: false, error: `'${input.url}' is not a URL.` }; }
      if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: `Only http and https.` };
      try {
        const res = await page.goto(url.href, { waitUntil: "domcontentloaded" });
        const snap = await browser.snapshot(page, SNAPSHOT_CHARS);
        db.rememberSeenUrls(c, [page.url(), url.href]);
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
      const el = await browser.describeRef(page, input.ref);
      if (el === null) return { ok: false, error: `No element ${input.ref} on this page. Call browser_read for fresh refs.` };
      const label = el.name;
      // The guard, decided from what the element is — never from what the model expects it to do.
      // `expect` is still recorded on the receipt; it just does not get a vote.
      const verdict = clickCommits(el);
      if (verdict.commits) {
        const blocked = {
          ok: false, blocked: "commit_needs_gate", element: label || `<${el.tag}>`, why: verdict.why,
          error: `Not pressing that: ${verdict.why}. A click that commits something goes through the gate — confirm_request with the exact details, wait for ${me.name} to answer, confirm_record, then browser_submit with that confirmation_id.`,
        };
        trust.ledgerWrite({ conversationId: c, action: "browser_click", input, out: blocked, target: `${page.url()} → ${label || el.tag}` });
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
        return { ok: false, error: `No element ${input.ref} on this page. Nothing was submitted and ${me.name}'s yes still stands — call browser_read for fresh refs and submit again with the same confirmation_id.` };
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
