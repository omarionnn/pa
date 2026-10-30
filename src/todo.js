// The to-do list (owner, 2026-10-30). Somebody texts a photo of their list, or types it, and Reason:
//
//   1. reads it and answers with ONE plan in three groups — what Reason will handle, the one thing it
//      needs from them per item, and what only they can do (with how Reason still helps). The plan
//      names every business it would call and says which items involve money. The model reads the
//      list and sorts it (todo_plan); the message itself is composed HERE from what it stored, so a
//      business or a money flag cannot be left out of what they are asked to approve.
//   2. waits for one approval of the whole plan. That is an ordinary yes through the confirm gate
//      (confirm_request → their reply → confirm_record → todo_approve), pinned to a fingerprint of the
//      plan, so a plan changed after the ask needs a fresh yes.
//   3. works the items through the jobs it already has — tasks, calls, research, timers — each item
//      linked to the task working it (todo_item_update).
//   4. keeps a checklist page (an ordinary Reason page, same link and key as every other) that is
//      redrawn whenever one of those tasks changes: db.taskBus tells this file, nothing polls.
//   5. sends ONE wrap-up text, written by code, once every item is done, waiting on somebody else, or
//      theirs ("7 of 9 done; plumber calls back thu, i'll chase it; gym is yours"). Claimed on the row
//      before it goes, so it goes once.
//   6. leaves the waiting ones to the task wakes they already have (waiting_on_other, next_wake_at).
//
// The approval rule (owner decision, 2026-10-30), enforced here in code and not in a prompt: once the
// plan is approved, a call to a BUSINESS the plan named goes through without asking again. Still asked,
// through the normal confirm gate: a call to somebody they know (their people list, their memory, any
// Reason account), anything that could spend money, and any business the plan did not name. The grant
// is the set of businesses copied onto the list at the moment of approval, and the check against it is
// an exact comparison of phone numbers — no reading of anybody's words. Which items are businesses,
// which are people and which involve money is the model's reading of the list, shown to them in the
// plan they approve; whether a number belongs to somebody they know is the lookups' answer
// (db.knownPersonByNumber / knownPersonByName), and it overrides the model.
//
// Nothing else about a call changes: the AI disclosure, the recording notice, the undo hold, the harm
// gate and the call caps all run exactly as before, because the grant only answers the one question
// the confirm gate asks.
//
// Behind REASON_TODO (off | owner | on), off by default (src/dailyflag.js). Off: the tools are not shown
// to anybody's model and are refused if named, the grant covers nothing, no page is drawn and the sweep
// sends nothing.
import { createHash } from "node:crypto";
import { z } from "zod";
import { config, clock, normalizeNumber, stamp } from "./config.js";
import * as db from "./db.js";
import { todoAllowedFor, todoMode } from "./dailyflag.js";
import * as offers from "./offers.js";
import { checkContent } from "./pages/content.js";
import { ownerUrl } from "./pages/access.js";
import { verifyPage } from "./verify.js";

/** How long an approved plan's grant lasts. A list two weeks old is a different week's list. */
export const GRANT_TTL_MS = 14 * 24 * 60 * 60_000;
/** How long a list sits still before the wrap-up goes, so it never races the turn that settled the last item. */
export const WRAP_QUIET_MS = 2 * 60_000;
export const MAX_ITEMS = 30;

export const TODO_TOOLS = new Set(["todo_plan", "todo_approve", "todo_item_update", "todo_list_get"]);

export function todoToolVisible(name, conversationId) {
  if (!TODO_TOOLS.has(name)) return true;
  return todoAllowedFor(conversationId);
}

// ---------- the tools ----------

const GROUP_WORDS = "'mine' — you can do it yourself with what you have: calls to businesses, bookings, research, emails, reminders;"
  + " 'ask' — you could do it but need ONE thing from them first (put the one short question in `question`);"
  + " 'theirs' — only they can do it (the gym, picking up a kid, signing something in person); put how you still help in `how` (a reminder, directions, a checklist).";

export const TODO_TOOL_DEFS = [
  {
    name: "todo_plan",
    description: "They sent a to-do list — a photo of one, or typed out — and want help with it. Read every item (from the photo if there is one) and sort each into one of three groups: "
      + GROUP_WORDS
      + " For every business you would ring, name it in `businesses` with its phone number when a tool gave you one (look it up first — the plan must name every business you would call, and a call to a business with no number on the plan still has to be asked about)."
      + " Never put a person they know in `businesses` — a friend, family, their landlord by name: those go in 'ask' and get asked about like any call. Set `money` on anything that could cost money."
      + " Returns `plan_text`: send it as your whole reply, word for word, and ask nothing else — and BEFORE you send it call confirm_request with action 'todo_approve', target set to `approval_target` exactly, and a one-line summary."
      + " Nothing on the list is started until they say yes to the plan. If they want changes, call this again with list_id and the whole corrected list, then ask again.",
    input_schema: {
      type: "object",
      properties: {
        list_id: { type: "integer", description: "Only when revising a plan they have not approved yet." },
        title: { type: "string", description: "A short name for the list: 'saturday errands', 'this week'. Optional." },
        source: { type: "string", enum: ["photo", "text"], description: "Whether they sent a picture of it or typed it." },
        items: {
          type: "array",
          description: "Every item on the list, in their order, none left out.",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The item as they wrote it." },
              short: { type: "string", description: "Two or three words for it, how you would say it in a text: 'plumber', 'gym', 'mom's birthday gift'." },
              group: { type: "string", enum: ["mine", "ask", "theirs"] },
              how: { type: "string", description: "One short line: what you will do ('call Joe's Plumbing for the earliest slot'), or for 'theirs' how you still help ('a reminder at 6pm')." },
              question: { type: "string", description: "For 'ask': the ONE short question." },
              money: { type: "boolean", description: "Could this cost them money?" },
              money_note: { type: "string", description: "When money: what costs what, if known ('about $90 a visit')." },
              businesses: {
                type: "array",
                items: { type: "object", properties: { name: { type: "string" }, phone: { type: "string", description: "E.164, from a tool result." } }, required: ["name"] },
                description: "Every business you would call for this item. Businesses only.",
              },
            },
            required: ["text", "short", "group"],
          },
        },
      },
      required: ["source", "items"],
    },
  },
  {
    name: "todo_approve",
    description: "They said yes to the whole plan. Pass the list_id and the confirmation_id from confirm_record. From then on you may call any business the plan named without asking again; a person they know, anything that costs money, or a business the plan did not name still goes through confirm_request as usual."
      + " Returns the checklist link — send it in one short line that says you are starting — and what to start.",
    input_schema: {
      type: "object",
      properties: { list_id: { type: "integer" }, confirmation_id: { type: "integer" } },
      required: ["list_id", "confirmation_id"],
    },
  },
  {
    name: "todo_item_update",
    description: "Keep one item on an approved list current. Link it to the task working it (task_id) as soon as you start one — the checklist then follows that task by itself, so you never update it again for task changes."
      + " Use status only for items with no task: 'done' (a reminder set, an email sent, they said they did it), 'waiting' (with a note of what you are waiting for), 'dropped' (they said never mind)."
      + " When they answer an 'ask' item's question, set group to 'mine' (or 'theirs') and carry on. `note` is one short line shown on the checklist and used in the wrap-up for waiting items: 'plumber calls back thu'."
      + " Never write your own wrap-up of the list: one is sent by itself when every item is done, waiting or theirs.",
    input_schema: {
      type: "object",
      properties: {
        list_id: { type: "integer" },
        item: { type: "integer", description: "The item's number on the list (1 = the first)." },
        task_id: { type: "integer" },
        status: { type: "string", enum: ["done", "waiting", "dropped", "todo"] },
        group: { type: "string", enum: ["mine", "ask", "theirs"] },
        note: { type: "string" },
        business: {
          type: "object",
          properties: { name: { type: "string" }, phone: { type: "string" } },
          required: ["name", "phone"],
          description: "The number of a business the approved plan already NAMED, found since (a lookup this turn). A business the plan did not name can be added, but its calls are asked about as usual.",
        },
      },
      required: ["list_id", "item"],
    },
  },
  {
    name: "todo_list_get",
    description: "Their to-do list as it stands: every item, its group, its status and the checklist link. With no list_id, the open ones.",
    input_schema: { type: "object", properties: { list_id: { type: "integer" } } },
  },
];

const business = z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().max(40).optional() });
export const TODO_SCHEMAS = {
  todo_plan: z.object({
    list_id: z.number().int().optional(),
    title: z.string().max(80).optional(),
    source: z.enum(["photo", "text"]),
    items: z.array(z.object({
      text: z.string().trim().min(1).max(300),
      short: z.string().trim().min(1).max(60),
      group: z.enum(["mine", "ask", "theirs"]),
      how: z.string().max(240).optional(),
      question: z.string().max(240).optional(),
      money: z.boolean().optional(),
      money_note: z.string().max(160).optional(),
      businesses: z.array(business).max(6).optional(),
    })).min(1).max(MAX_ITEMS),
  }),
  todo_approve: z.object({ list_id: z.number().int(), confirmation_id: z.number().int() }),
  todo_item_update: z.object({
    list_id: z.number().int(),
    item: z.number().int().min(1),
    task_id: z.number().int().optional(),
    status: z.enum(["done", "waiting", "dropped", "todo"]).optional(),
    group: z.enum(["mine", "ask", "theirs"]).optional(),
    note: z.string().max(160).optional(),
    business: z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().min(7).max(40) }).optional(),
  }),
  todo_list_get: z.object({ list_id: z.number().int().optional() }),
};

// ---------- numbers and names ----------

/** Two spellings of one phone number: the last ten digits, at least seven of them. */
export function sameNumber(a, b) {
  const x = String(a ?? "").replace(/\D/g, "");
  const y = String(b ?? "").replace(/\D/g, "");
  return x.length >= 7 && y.length >= 7 && x.slice(-10) === y.slice(-10);
}
const nameKey = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Did a tool hand this number back this turn (or did they type it)? offers.js keeps the turn's sources. */
function numberSeenThisTurn(conversationId, phone) {
  for (const src of offers.turnState(conversationId).sources ?? []) {
    for (const run of String(src).match(/\+?\d[\d\s().-]{5,}\d/g) ?? []) if (sameNumber(run, phone)) return true;
  }
  return false;
}

/** A business as stored: who the lookups say it is overrides what the plan called it. */
function settleBusiness(conversationId, b) {
  const phone = b.phone ? normalizeNumber(b.phone) : "";
  const known = (phone && db.knownPersonByNumber(conversationId, phone)) || db.knownPersonByName(conversationId, b.name);
  return { name: b.name.trim(), phone, ...(known ? { person: known.who } : {}) };
}

// ---------- the plan ----------

/** What a yes to this plan is pinned to: every item, its group, its money flag and its businesses. */
export function planFingerprint(items) {
  const shape = items.map(i => [i.n, i.text, i.grp, i.money ? 1 : 0, (i.businesses ?? []).map(b => `${b.name}|${b.phone ?? ""}|${b.person ?? ""}`)]);
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 10);
}

/** The confirm gate's target for todo_approve, read off the stored list — never retyped by the model. */
export function approvalTarget(conversationId, listId) {
  const list = db.getTodoList(conversationId, listId);
  if (!list) return `unknown to-do list ${listId}`;
  return `to-do list #${list.id} [${list.plan_fp}]`;
}

const pretty = (phone) => {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return phone;
};

/**
 * The plan, in the one message they are asked to approve. Code's words around the model's reading, so
 * every business and every money item is in it whatever the model would have written.
 */
export function planText(list, items) {
  const lines = [];
  const mine = items.filter(i => i.grp === "mine");
  const ask = items.filter(i => i.grp === "ask");
  const theirs = items.filter(i => i.grp === "theirs");
  const moneyNote = (i) => i.money ? ` · may cost money${i.money_note ? ` (${i.money_note})` : ""}, so i'll ask before agreeing to anything` : "";
  const calls = (i) => {
    const biz = (i.businesses ?? []).filter(b => !b.person);
    const ppl = (i.businesses ?? []).filter(b => b.person);
    const parts = [];
    if (biz.length) parts.push(`calling ${biz.map(b => b.phone ? `${b.name} ${pretty(b.phone)}` : b.name).join(", ")}`);
    if (ppl.length) parts.push(`${ppl.map(b => b.name).join(", ")} is someone you know, so i'll ask before calling`);
    return parts.length ? ` · ${parts.join("; ")}` : "";
  };
  lines.push(`here's the plan for your list (${items.length} thing${items.length === 1 ? "" : "s"}):`);
  if (mine.length) {
    lines.push("", "i'll handle these:");
    for (const i of mine) lines.push(`${i.n}. ${i.short}${i.how ? ` — ${i.how}` : ""}${calls(i)}${moneyNote(i)}`);
  }
  if (ask.length) {
    lines.push("", "i need one thing from you:");
    for (const i of ask) lines.push(`${i.n}. ${i.short} — ${i.question || "one quick question first"}${calls(i)}${moneyNote(i)}`);
  }
  if (theirs.length) {
    lines.push("", "only you can do these:");
    for (const i of theirs) lines.push(`${i.n}. ${i.short}${i.how ? ` — ${i.how}` : ""}${moneyNote(i)}`);
  }
  const biz = [...new Map(items.flatMap(i => (i.businesses ?? []).filter(b => !b.person)).map(b => [nameKey(b.name), b.name])).values()];
  lines.push("");
  lines.push(biz.length
    ? `once you say yes i'll call ${biz.join(", ")} without checking again. anyone you know, or anything that costs money, i'll still ask first.`
    : "nothing here needs a call to a business. anything that costs money, i'll still ask first.");
  lines.push("good to go?");
  return lines.join("\n");
}

// ---------- the checklist ----------

const STATUS_WORD = { todo: "to do", doing: "on it", needs_you: "need you", waiting: "waiting", done: "done", failed: "couldn't", stuck: "stuck", dropped: "dropped", theirs: "yours" };
const STEP_STATE = { todo: "plain", doing: "now", needs_you: "waiting", waiting: "waiting", done: "done", failed: "failed", stuck: "failed", dropped: "plain", theirs: "plain" };

const cut = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The page's blocks, from the rows. Nothing the model wrote reaches it except the items' own words. */
export function checklistBlocks(list, items) {
  const counted = items.filter(i => i.status !== "dropped");
  const done = counted.filter(i => i.status === "done").length;
  // The badge's words are the page kit's: "waiting" reads "waiting on you", which is only true before the yes.
  const state = list.state === "planning" ? "waiting" : done === counted.length ? "done" : "working";
  const blocks = [{
    type: "status", state,
    headline: list.state === "planning" ? "Waiting for your go-ahead" : `${done} of ${counted.length} done`,
    detail: `Updated ${stamp(clock.now())}. This page follows along by itself.`,
  }];
  const group = (title, rows) => {
    if (!rows.length) return;
    blocks.push({
      type: "timeline", title,
      items: rows.map(i => ({
        label: cut(`${i.n}. ${i.short}`, 190),
        state: STEP_STATE[i.status] ?? "plain",
        at: STATUS_WORD[i.status] ?? i.status,
        ...(i.note || i.how ? { note: cut(i.note || i.how, 380) } : {}),
      })),
    });
  };
  group("I'm handling", items.filter(i => i.grp === "mine"));
  group("Need one thing from you", items.filter(i => i.grp === "ask"));
  group("Yours", items.filter(i => i.grp === "theirs"));
  return blocks;
}

/**
 * Draw (or redraw) the list's checklist page. The same page row every time, so the link they have
 * keeps working; its revision moves on every redraw. Returns the page, or null when it could not be drawn.
 */
export function rebuildChecklist(conversationId, listId) {
  const list = db.getTodoList(conversationId, listId);
  if (!list) return null;
  const items = db.todoItems(list.id);
  const checked = checkContent(checklistBlocks(list, items), {});
  if (!checked.ok) return null;
  const title = list.title ? cut(`Your list: ${list.title}`, 110) : "Your list";
  let page = list.page_id ? db.getPageIn(conversationId, list.page_id) : null;
  if (page) page = db.updatePage(conversationId, page.id, { title, blocks: checked.blocks });
  else {
    page = db.createPage(conversationId, { title, blocks: checked.blocks, subtitle: "Ticks itself off as things get done." });
    db.setTodoListPage(list.id, page.id);
  }
  return verifyPage(page).ok ? page : null;
}

const linkOf = (conversationId, list) => {
  const page = list?.page_id ? db.getPageIn(conversationId, list.page_id) : null;
  return page ? ownerUrl(page) : null;
};

// ---------- following the jobs ----------

/** An item's status and note, read off the task working it. */
export function fromTask(task) {
  if (!task) return null;
  const s = task.sheet ?? {};
  switch (task.state) {
    case "running": return { status: "doing" };
    case "waiting_on_you": return { status: "needs_you", note: s.needs?.question ?? "" };
    case "waiting": case "waiting_on_other": {
      const w = (s.waiting ?? [])[0];
      return { status: "waiting", note: w ? `${w.on}: ${w.for}` : "" };
    }
    case "blocked": return { status: "stuck", note: typeof s.blocked === "object" ? (s.blocked?.what ?? "") : String(s.blocked ?? "") };
    case "done": return { status: "done", note: task.outcome ?? "" };
    case "failed": return { status: "failed", note: task.outcome ?? "" };
    case "cancelled": return { status: "dropped", note: "" };
    default: return null;
  }
}

/** A task changed: every list item it works is brought in line and its checklist redrawn. */
export function onTaskChanged({ id } = {}) {
  if (todoMode() === "off" || !id) return;
  const items = db.todoItemsForTask(id);
  if (!items.length) return;
  const task = db.getTaskAnywhere(id);
  const lists = new Set();
  for (const it of items) {
    if (!todoAllowedFor(it.conversation_id)) continue;
    const next = fromTask(task);
    if (!next) continue;
    // A note the task has nothing to say about keeps the one already there.
    db.updateTodoItem(it.id, { status: next.status, ...(next.note ? { note: cut(next.note, 160) } : {}) });
    lists.add(`${it.conversation_id}\u0000${it.list_id}`);
  }
  for (const key of lists) {
    const [c, listId] = key.split("\u0000");
    rebuildChecklist(c, Number(listId));
  }
}
db.taskBus.on("changed", (e) => { try { onTaskChanged(e); } catch { /* a redraw never costs the write */ } });

// ---------- the grant ----------

/**
 * Does an approved list's plan cover this action without asking? Only ever a call, only to a number
 * the plan named for a business, never to somebody they know, never a call that could agree to spend.
 *
 * Returns `{ ok: true, permission }` in the shape the gate carries a standing permission in (its
 * `said` is their own words of approval, which is what the receipt quotes), or `{ ok: false, why? }`.
 * A `why` is said only when there IS an approved list, so the model can tell them which part needed asking.
 */
export function grantCovering({ conversationId: c, action, input = {}, target = "", now = clock.now() }) {
  if (action !== "call_place" || !todoAllowedFor(c)) return { ok: false };
  const lists = db.approvedTodoLists(c).filter(l => l.approved_at && now - l.approved_at <= GRANT_TTL_MS);
  if (!lists.length) return { ok: false };
  const number = normalizeNumber(target || input.to);
  if (!number) return { ok: false };
  let hit = null;
  for (const list of lists) {
    const g = list.grant.find(x => x.phone && sameNumber(x.phone, number));
    if (g) { hit = { list, g }; break; }
  }
  if (!hit) {
    return { ok: false, why: `The approved to-do list does not name a business at ${number}, so its approval does not reach this call: ask about it the usual way.` };
  }
  // Who the number belongs to is asked again now, not only at approval: somebody they know is
  // somebody they know however the plan filed them.
  const person = db.knownPersonByNumber(c, number);
  if (person) {
    return { ok: false, why: `${number} is how they reach ${person.who}, somebody they know. The to-do list's approval covers businesses only, so ask about this call.` };
  }
  const item = db.todoItems(hit.list.id).find(i => i.id === hit.g.item_id);
  if (!item || item.status === "dropped") {
    return { ok: false, why: `The item ${hit.g.name} was on is no longer on the list, so the approval does not cover calling them. Ask about it.` };
  }
  const agrees = !!input.may_book || (input.max_price_cents ?? 0) > 0 || (input.approved_terms?.length ?? 0) > 0;
  if (agrees && (item.money || (input.max_price_cents ?? 0) > 0 || (input.approved_terms?.length ?? 0) > 0)) {
    return { ok: false, why: `This call could agree to spend money (${item.short}${item.money_note ? `: ${item.money_note}` : ""}), and the to-do list's approval never covers money. Ask about it.` };
  }
  return {
    ok: true,
    permission: {
      permission_id: null, todo_list_id: hit.list.id, business: hit.g.name,
      said: hit.list.approved_quote || `yes to the to-do list plan #${hit.list.id}`,
    },
  };
}

// ---------- the wrap-up ----------

const SETTLED = new Set(["done", "waiting", "failed", "stuck", "dropped"]);

/** Is every item done, waiting on somebody else, or theirs — and has the list been still long enough? */
export function readyToWrap(list, items, now = clock.now()) {
  if (list.state !== "approved" || list.wrapped_at) return false;
  if (!items.some(i => i.grp !== "theirs")) return false;
  const settled = items.every(i => i.grp === "theirs" ? i.status !== "needs_you" : SETTLED.has(i.status));
  if (!settled) return false;
  const last = Math.max(list.approved_at ?? 0, ...items.map(i => i.updated_at ?? 0));
  return now - last >= WRAP_QUIET_MS;
}

const andList = (xs) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** The one wrap-up text, from the rows. */
export function wrapLine(list, items, link = null) {
  const counted = items.filter(i => i.status !== "dropped");
  const done = counted.filter(i => i.status === "done");
  const parts = [`${done.length} of ${counted.length} done`];
  for (const i of counted.filter(x => x.status === "waiting")) parts.push(`${i.note || `${i.short} is waiting on a reply`}, i'll chase it`);
  for (const i of counted.filter(x => x.status === "failed" || x.status === "stuck")) parts.push(`couldn't get ${i.short} done${i.note ? ` (${cut(i.note, 80)})` : ""}`);
  const yours = counted.filter(x => x.grp === "theirs" && x.status !== "done").map(i => i.short);
  if (yours.length) parts.push(`${andList(yours)} ${yours.length === 1 ? "is" : "are"} yours`);
  return `${parts.join("; ")}${link ? `\n${link}` : ""}`;
}

/**
 * The sweep's pass (src/runtime.js): every approved list that has just settled gets its one wrap-up.
 * `say(conversationId, text, meta)` sends it. Never in their night: it keeps until the next pass after.
 */
export function wrapUps({ say, inTheirNight = () => false, isPaused = () => false, now = clock.now(), log = () => {} } = {}) {
  const out = { wrapped: 0 };
  if (todoMode() === "off") return out;
  for (const list of db.todoListsAwaitingWrap()) {
    const c = list.conversation_id;
    if (!todoAllowedFor(c) || isPaused(c) || inTheirNight(c, now)) continue;
    const items = db.todoItems(list.id);
    if (!readyToWrap(list, items, now)) continue;
    const page = rebuildChecklist(c, list.id);
    const text = wrapLine(list, items, page ? ownerUrl(page) : linkOf(c, list));
    if (!db.claimTodoWrap(list.id, text)) continue;
    // Nothing left open on it: the list is finished, and its grant with it.
    if (!items.some(i => i.status === "waiting")) db.closeTodoList(c, list.id, "closed");
    say?.(c, text, { idempotencyKey: `todo-wrap:${list.id}` });
    log({ todo_wrapped: list.id, conversation: c });
    out.wrapped++;
  }
  return out;
}

/** A list whose last waiting item settled after the wrap-up: closed, so its grant ends. */
function closeIfFinished(c, list) {
  if (list.state !== "approved" || !list.wrapped_at) return;
  const items = db.todoItems(list.id);
  if (items.every(i => i.grp === "theirs" || ["done", "failed", "stuck", "dropped"].includes(i.status))) db.closeTodoList(c, list.id, "closed");
}

// ---------- keeping the list linked ----------

/** The tools whose result may be the work on a list item: a job, a call, a reminder, a mail, a look-up. */
const NUDGE_AFTER = new Set(["task_start", "task_update", "task_finish", "timer_set", "call_place", "call_status", "call_errand_start",
  "research", "gmail_send", "gmail_draft", "calendar_create", "page_create"]);
export const nudgeAfter = (name) => NUDGE_AFTER.has(name);

/**
 * The items on an approved list that nothing is working yet, said on the result of anything that might
 * be one of them (src/tools.js). Seen 2026-10-30 on the real model: the approval turn set the rent
 * reminder and started the plumber's job and linked neither, so the checklist never moved. Null when
 * there is nothing unlinked, or REASON_TODO does not reach this conversation.
 */
export function nudge(conversationId) {
  if (!todoAllowedFor(conversationId)) return null;
  for (const list of db.approvedTodoLists(conversationId)) {
    const open = db.todoItems(list.id).filter(i => i.grp === "mine" && !i.task_id && i.status === "todo");
    if (!open.length) continue;
    return {
      list_id: list.id,
      not_started: open.map(i => ({ item: i.n, short: i.short })),
      note: `Their to-do list #${list.id} still shows ${open.map(i => `${i.n} (${i.short})`).join(", ")} as not started.`
        + ` If what you just did works one of them, call todo_item_update now: task_id for a job (the checklist then follows it by itself),`
        + ` or status 'done' when that item is finished — a reminder set is a reminder item done.`,
    };
  }
  return null;
}

// ---------- the dispatch ----------

const itemView = (i) => ({
  item: i.n, text: i.text, short: i.short, group: i.grp, status: i.status,
  ...(i.how ? { how: i.how } : {}), ...(i.question ? { question: i.question } : {}),
  ...(i.money ? { money: true, ...(i.money_note ? { money_note: i.money_note } : {}) } : {}),
  ...(i.businesses?.length ? { businesses: i.businesses } : {}),
  ...(i.task_id ? { task_id: i.task_id } : {}), ...(i.note ? { note: i.note } : {}),
});
const listView = (c, l) => ({
  list_id: l.id, state: l.state, title: l.title || undefined, link: linkOf(c, l),
  items: db.todoItems(l.id).map(itemView),
  ...(l.state === "approved" ? { calls_covered: l.grant.filter(g => g.phone).map(g => `${g.name} ${g.phone}`) } : {}),
});

export async function runTodoTool(name, input, ctx) {
  const c = ctx.conversationId;
  if (!TODO_TOOLS.has(name) || !todoAllowedFor(c)) {
    return { ok: false, blocked: "not_available", error: "That isn't something Reason does here. Help with their list in ordinary messages, and do not mention it." };
  }
  switch (name) {
    case "todo_plan": {
      if (input.list_id) {
        const was = db.getTodoList(c, input.list_id);
        if (!was) return { ok: false, error: `No to-do list #${input.list_id} here.` };
        if (was.state !== "planning") return { ok: false, error: `List #${was.id} is already ${was.state}; its plan cannot be rewritten. Start a new one for new items.` };
      }
      const items = input.items.map((it, i) => ({
        n: i + 1, text: it.text, short: it.short, grp: it.group, how: it.how ?? "", question: it.question ?? "",
        money: !!it.money, money_note: it.money_note ?? "",
        businesses: (it.businesses ?? []).map(b => settleBusiness(c, b)),
        status: it.group === "theirs" ? "theirs" : "todo",
      }));
      const fp = planFingerprint(items);
      const list = db.saveTodoList(c, { listId: input.list_id ?? null, title: input.title ?? "", source: input.source, items, planFp: fp });
      rebuildChecklist(c, list.id);
      const stored = db.todoItems(list.id);
      const people = stored.flatMap(i => i.businesses.filter(b => b.person).map(b => `${b.name} (${b.person})`));
      return {
        ok: true, list_id: list.id,
        plan_text: planText(list, stored),
        approval_target: approvalTarget(c, list.id),
        ...(people.length ? { treated_as_people: people, people_note: `These are people they know by Reason's own records, not businesses, so the plan says you will ask before calling them: ${people.join(", ")}.` } : {}),
        note: `Now: confirm_request with action "todo_approve", target "${approvalTarget(c, list.id)}", and a one-line summary of the plan. Then send plan_text, word for word, as your whole reply.`
          + " Nothing on the list starts until they say yes. If their answer changes the plan, call todo_plan again with list_id and ask again.",
      };
    }
    case "todo_approve": {
      const list = db.getTodoList(c, input.list_id);
      if (!list) return { ok: false, error: `No to-do list #${input.list_id} here.` };
      if (list.state !== "planning") return { ok: false, error: `List #${list.id} is already ${list.state}.` };
      const yes = db.getConfirmation(c, input.confirmation_id);
      const items = db.todoItems(list.id);
      // The grant: every business the plan named that is not somebody they know, as the plan named it.
      const grant = items.flatMap(i => (i.grp === "theirs" ? [] : i.businesses)
        .filter(b => !b.person)
        .map(b => ({ name: b.name, phone: b.phone || "", item_id: i.id, n: i.n })));
      if (!db.approveTodoList(c, list.id, { confirmationId: input.confirmation_id, quote: yes?.granted_quote ?? "", grant })) {
        return { ok: false, error: `List #${list.id} could not be approved; it may have just changed. todo_list_get shows where it is.` };
      }
      for (const i of items) if (i.grp === "ask") db.updateTodoItem(i.id, { status: "needs_you" });
      const page = rebuildChecklist(c, list.id);
      const fresh = db.getTodoList(c, list.id);
      return {
        ok: true, list_id: list.id, link: page ? ownerUrl(page) : null,
        calls_covered: fresh.grant.filter(g => g.phone).map(g => `${g.name} ${g.phone}`),
        still_asked: "A call to anybody they know, anything that could spend money, and any business not on the plan still go through confirm_request.",
        note: `Approved. Send ONE short line that you are on it, with the checklist link. Then start: a task (task_start) for each 'i'll handle' item that takes more than one step, a call, research or a timer for the rest,`
          + ` and link each item to its task with todo_item_update as you go. Items with no task: mark them with todo_item_update when they are done.`
          + ` The 'ask' questions were in the plan; when they answer one, update the item and carry on. Do not write a summary at the end — one is sent by itself.`,
      };
    }
    case "todo_item_update": {
      const list = db.getTodoList(c, input.list_id);
      if (!list) return { ok: false, error: `No to-do list #${input.list_id} here.` };
      if (list.state === "planning") return { ok: false, error: `List #${list.id} has not been approved yet. Nothing on it is started until they say yes to the plan.` };
      const item = db.todoItems(list.id).find(i => i.n === input.item);
      if (!item) return { ok: false, error: `List #${list.id} has no item ${input.item}.` };
      const fields = {};
      const notes = [];
      if (input.task_id !== undefined) {
        const task = db.getTask(c, input.task_id);
        if (!task) return { ok: false, error: `No task #${input.task_id} on this conversation.` };
        fields.task_id = task.id;
        const next = fromTask(task);
        if (next) { fields.status = next.status; if (next.note) fields.note = cut(next.note, 160); }
      }
      if (input.status) fields.status = input.status;
      if (input.group) {
        fields.grp = input.group;
        if (input.group === "theirs" && !input.status) fields.status = "theirs";
        if (input.group !== "theirs" && item.status === "needs_you" && !fields.status) fields.status = "todo";
      }
      if (input.note !== undefined) fields.note = input.note;
      if (input.business) {
        const b = settleBusiness(c, input.business);
        const named = list.grant.find(g => nameKey(g.name) === nameKey(b.name) && g.item_id === item.id);
        fields.businesses = [...item.businesses.filter(x => nameKey(x.name) !== nameKey(b.name)), b];
        if (b.person) {
          notes.push(`${b.name} is ${b.person}, somebody they know: calls to them are asked about as usual.`);
        } else if (!named) {
          notes.push(`${b.name} was not named in the plan they approved, so a call there is asked about as usual.`);
        } else if (named.phone && !sameNumber(named.phone, b.phone)) {
          notes.push(`The plan they approved had ${named.name} at ${named.phone}; a different number is asked about as usual.`);
        } else if (!named.phone) {
          // A number found after the yes reaches the grant only when it came back from a lookup this
          // turn (or they typed it): a number typed from memory could be anybody's.
          if (numberSeenThisTurn(c, b.phone)) {
            db.setTodoGrant(list.id, list.grant.map(g => g === named ? { ...g, phone: b.phone } : g));
            notes.push(`${named.name}'s number is now on the approved plan: calling it needs no new yes.`);
          } else {
            notes.push(`That number did not come from a lookup this turn, so it is not added to what the plan covers: look it up, then set it again.`);
          }
        }
      }
      db.updateTodoItem(item.id, fields);
      const page = rebuildChecklist(c, list.id);
      closeIfFinished(c, db.getTodoList(c, list.id));
      return { ok: true, list_id: list.id, item: itemView(db.todoItems(list.id).find(i => i.id === item.id)), link: page ? ownerUrl(page) : null, ...(notes.length ? { note: notes.join(" ") } : {}) };
    }
    case "todo_list_get": {
      if (input.list_id) {
        const list = db.getTodoList(c, input.list_id);
        return list ? { ok: true, ...listView(c, list) } : { ok: false, error: `No to-do list #${input.list_id} here.` };
      }
      return { ok: true, lists: db.listTodoLists(c).map(l => listView(c, l)) };
    }
  }
  return { ok: false, error: `Unknown tool ${name}` };
}
