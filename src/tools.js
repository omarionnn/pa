// Every tool: a JSON schema the model sees, a zod check on what it sends, and a run() that touches the DB.
// Guards live here, never in routing. The result is the only thing the model may treat as true.
import { z } from "zod";
import * as db from "./db.js";
import { clock, stamp, config, weekdayMismatch } from "./config.js";

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
  { name: "venue_search", status: "not connected", what: "look up real restaurants, showtimes, places. Not connected yet: PA has no live venue data." },
  { name: "payments", status: "not connected", what: "send a pay link, split a bill, refund. Not connected yet." },
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
    description: "Schedule PA to come back to this conversation at a real time with a note to itself (e.g. 'day-of reminder for plan 3', 'ask how dinner was'). When it fires you get an event message and decide what to say. Returns the timer id and the resolved time.",
    input_schema: {
      type: "object",
      properties: {
        fire_at: { type: "string", description: "ISO 8601 datetime with offset, e.g. 2026-09-26T18:00:00-04:00" },
        note: { type: "string", description: "What future-PA should do when this fires" },
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
    description: "What PA can and cannot do right now. Call this before promising anything outside planning, timers and memory, so you offer only real things.",
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
};

function timerView(t) {
  return t && { id: t.id, fires_at: stamp(t.fire_at), fire_at_iso: new Date(t.fire_at).toISOString(), note: t.note, plan_id: t.plan_id };
}

export async function runTool(name, rawInput, ctx) {
  const schema = S[name];
  if (!schema) return { error: `Unknown tool ${name}` };
  const parsed = schema.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false, error: "Bad input: " + parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const input = parsed.data;
  const c = ctx.conversationId;

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
    default: return { error: `Unknown tool ${name}` };
  }
}
