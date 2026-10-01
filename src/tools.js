// Every tool: a JSON schema the model sees, a zod check on what it sends, and a run() that touches the DB.
// Guards live here, never in routing. The result is the only thing the model may treat as true.
import { z } from "zod";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as db from "./db.js";
import { clock, stamp, config, weekdayMismatch } from "./config.js";
import * as trust from "./trust.js";
import * as browser from "./browser.js";
import { webLookup } from "./weblookup.js";

// Tools that touch something outside this machine. Every call, success or not, leaves a ledger row.
// Clicks and typing inside an already-open page are steps, not outcomes; the step that has a real
// consequence is browser_submit, which is gated and always recorded.
const OUTSIDE_WORLD = new Set(["account_connect", "account_revoke", "browser_open", "browser_submit", "web_lookup"]);
// Tools that spend money or act on a third party. They will not run without a spent confirmation.
const NEEDS_CONFIRMATION = new Set(["account_connect", "browser_submit"]);

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
  { name: "memory", status: "live", what: "remember facts about people and preferences for later" },
  { name: "action_ledger", status: "live", what: "a receipt for every action that touched the outside world. 'what did you do today' is read from it, never from memory" },
  { name: "confirm_gate", status: "live", what: "anything that spends money or acts on someone else stops until the owner types a yes. The guard reads their real words; it cannot be talked into it" },
  { name: "connected_accounts", status: "live", what: "see what Reason can reach and revoke it. Connecting still needs the provider's credentials" },
  { name: "web_lookup", status: "live", what: "fetch one page and read its text. No JavaScript, no clicking, no logins" },
  { name: "browser", status: "live", what: "a real Chromium Reason drives itself: open a site, read it, click, fill forms, screenshot. One profile per conversation, so logins stick. The final commit click always needs an explicit yes" },
  { name: "venue_search", status: "not connected", what: "no venue database. Reason can only read a page you point it at, or drive a site in the browser. It cannot invent restaurants, showtimes or prices." },
  { name: "payments", status: "not connected", what: "send a pay link, split a bill, refund. Needs a payments provider key that is not set up." },
  { name: "email", status: "not connected", what: "read and send email. Needs Google OAuth credentials that are not set up." },
  { name: "calendar", status: "not connected", what: "read and write calendar events. Needs Google OAuth credentials that are not set up." },
  { name: "phone_calls", status: "not connected", what: "call a place or a person and report back. Needs a telephony key and a number that are not set up." },
  { name: "message_people", status: "not connected", what: "text the crew directly to collect answers. Not connected yet; only this DM exists." },
];

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
    name: "remember",
    description: "Save a durable fact for later (a preference, a usual spot, who someone is). Not for plan details; those go in the plan.",
    input_schema: {
      type: "object",
      properties: { about: { type: "string", description: "Who or what this is about, e.g. 'Kofi', 'owner', 'sushi'" }, fact: { type: "string" } },
      required: ["about", "fact"],
    },
  },
  {
    name: "recall",
    description: "Look up saved facts. Filter by who/what, or leave empty for recent facts.",
    input_schema: { type: "object", properties: { about: { type: "string" } } },
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
    description: "Step 2 of the confirm gate. Call this after the owner replies to the question you asked. The guard reads their actual last message itself and decides: granted, refused, or still waiting. You cannot grant it for them.",
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
  remember: z.object({ about: z.string().min(1).max(100), fact: z.string().min(1).max(500) }),
  recall: z.object({ about: z.string().max(100).optional() }),
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

/** What outside thing this call touched, for the ledger's target column. */
function targetOf(name, input) {
  switch (name) {
    case "account_connect": case "account_revoke": return `account:${input.name}`;
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

  let confirmationId = null;
  let spend = null;
  if (NEEDS_CONFIRMATION.has(name)) {
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
    case "remember": return { ok: true, memory: db.remember(c, input.about, input.fact) };
    case "recall": return { memories: db.recall(c, input.about ?? "").map(m => ({ about: m.about, fact: m.fact, saved: stamp(m.created_at) })) };
    case "capabilities": return { capabilities: CAPABILITIES, owner: config.ownerName, city: config.ownerCity };

    case "confirm_request":
      return trust.requestConfirmation({
        conversationId: c, messages: ctx.messages ?? [],
        action: input.action, summary: input.summary, stakes: input.stakes ?? "",
      });
    case "confirm_record":
      return trust.recordConfirmation({ conversationId: c, messages: ctx.messages ?? [], confirmationId: input.confirmation_id });

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
