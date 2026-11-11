// The tool diet: which of Reason's ~310 tools a reply call carries whole, and which wait to be found.
//
// Spend audit 2026-11-05: every API reply call sent every tool, ~130k tokens of schema in a
// ~175–216k-token prompt. The cache lives five minutes and people text in bursts, so most messages
// were cold: ~$1.00 a message instead of ~$0.12, and slower to the first word. The CLI backend
// already deferred all but a dozen tools behind Claude Code's ToolSearch (src/backends/mcp-core.js).
//
// What a call carries now, on both backends:
//   1. CORE — the same for everybody, always loaded: talking to them, reminders, memory, search,
//      calls, shopping, the confirm gate. The tools that made ~83% of real calls (10-28 counts).
//   2. The LIKELY set — per person, read off structured state, never off message text: an open
//      checkout brings the shopping tools, an event they run brings the organizer's, a ride the
//      ride tools, a saved flight the flight tools, the tools they themselves used lately, and every
//      tool already called in the thread the model is about to read.
//   3. Everything else is still declared and found by search when it is needed: the API's own tool
//      search (`defer_loading`, server side, inside the same response) or the CLI's ToolSearch.
//
// The one rule that keeps this fast: the loaded set NEVER changes while the person's prompt cache
// is warm. The cache is a prefix, tools first, so swapping tools mid-burst would turn every warm
// call cold. The set is recomputed only when the cache has already gone (no model call for them in
// WARM_MS) — at that moment a new set costs nothing, because the next call writes the cache anyway.
// It is kept in the database, so a restart in the middle of a burst does not change it either.
import { db } from "./db.js";
import * as dbm from "./db.js";
import { clock, config } from "./config.js";
import { socialAllowedFor } from "./socialsignin.js";

const OFF = ["0", "off", "false", "no"];
/** off (the default) | owner | on. Off: every tool loaded, exactly as before. Unset is off, so a deploy
 * that forgets the line never puts everybody on it. */
export function dietMode() {
  const v = String(process.env.REASON_TOOL_DIET ?? "off").trim().toLowerCase();
  if (OFF.includes(v)) return "off";
  if (v === "owner") return "owner";
  return v === "on" ? "on" : "off";
}
export function dietOn(conversationId) {
  const m = dietMode();
  if (m === "off") return false;
  if (m === "owner") return conversationId === config.ownerConversation;
  return true;
}

// The cache's life (5 min) plus a margin. A set is only ever replaced after this long with no call.
export const WARM_MS = Number(process.env.REASON_TOOLSET_WARM_MS || 6 * 60_000);

/**
 * Always loaded, for everybody (each still subject to toolsFor's visibility). The first fifteen are
 * the CLI's old always-load list (live journal counts, 10-25 → 27: ~190 of ~230 real calls); the rest
 * are what the owner named as core — reminders, memory, shopping, calls, messaging — plus the two
 * reads behind "near me" and "what can you do", which must never cost a search.
 */
export const CORE = [
  "web_search", "web_lookup", "gmail_search", "task_update", "timer_set", "spotify_now_playing",
  "remember", "browser_read", "recall", "call_place", "confirm_record", "browser_open",
  "message_send", "task_start", "show_choices", "render_table",
  "timer_list", "timer_cancel", "forget", "call_status", "confirm_request", "react",
  "store_checkout", "shop_status", "weather", "nearby_places", "get_location", "capabilities",
  // Each cost a search round on every use (drive 11-09); together ~3.4k chars of schema (~900 tokens).
  "event_create", "spend_limit_set",
];
export const CORE_SET = new Set(CORE);

/**
 * Tools that come together. A pack is loaded when the state behind it is there (see statePacks) or
 * when they used any tool in it lately. Listed by hand, not by name pattern, so a new tool joins a
 * pack only when somebody decides it belongs.
 */
export const PACKS = {
  shopping: ["shop_answer", "shop_pay", "shop_card", "shop_decline", "shop_handoff", "purchase", "purchase_confirm", "purchase_track", "purchases_recent", "spend_today", "spend_limit_set", "spend_limit_confirm", "offer_check", "deal_watch_set"],
  events_host: ["event_list", "event_info", "event_guests", "event_blast", "event_update", "event_settings", "event_schedule", "event_scheduled", "event_cancel", "event_guest_remove", "event_release", "event_cover", "event_password_rotate", "event_rides_setting"],
  events_guest: ["event_list", "event_info", "event_leave", "event_mute", "event_ride", "event_lookup", "event_join"],
  rides: ["uber_options", "uber_request", "uber_ride", "uber_cancel", "uber_link", "uber_receipt", "directions", "transit_status"],
  flights: ["flight_list", "flight_search", "flight_dates", "flight_verify", "flight_save", "flight_checkin_start", "flight_checkin_commit", "boarding_pass", "flight_forget"],
  calendar: ["calendar_events", "calendar_event", "calendar_create", "calendar_change", "calendar_delete", "conflict_check", "meeting_brief"],
  gmail: ["gmail_read", "gmail_draft", "gmail_send", "gmail_archive", "gmail_mark", "gmail_attachment"],
  apple_calendar: ["apple_calendar_events", "apple_calendar_event", "apple_calendar_create", "apple_calendar_change"],
  spotify: ["spotify_control", "spotify_search", "spotify_queue", "spotify_listening", "spotify_playlist_add", "spotify_playlist_create", "spotify_send_link"],
  tasks: ["task_list", "task_finish"],
  goals: ["goal_list", "goal_state", "goal_note", "goal_found", "goal_offer", "goal_criteria", "goal_delivery"],
  series: ["series_list", "series_pause", "series_resume", "series_end"],
  todo: ["todo_list_get", "todo_item_update", "todo_plan", "todo_approve"],
  watches: ["watch_list", "watch_cancel", "watch_set"],
  errands: ["call_errand_start", "call_errand_status"],
  commitments: ["commitment_list", "commitment_log", "commitment_set", "commitment_end"],
  drive: ["drive_search", "drive_read", "drive_send", "drive_create", "drive_upload", "drive_move", "drive_share", "drive_folders"],
  github: ["github_repos", "github_issues", "github_pulls", "github_issue_create", "github_issue_comment", "github_activity"],
  x: ["x_timeline", "x_mentions", "x_post", "x_reply", "x_search", "x_dm", "x_dm_list"],
  pages: ["page_create", "page_update", "page_list"],
  meals: ["meal_estimate", "meal_query", "meal_correct"],
  subscriptions: ["subscription_list", "subscription_record", "subscription_update", "subscription_cancel_start", "subscription_cancel_commit"],
  // The secure sign-in link and the provider tool, loaded whole wherever the Google/Apple/Facebook/
  // Microsoft rules are in the prompt (src/socialsignin.js): those rules name them, and on 2026-11-10
  // the owner's Notion task never reached signin_link — Reason said it could not get in instead.
  signin: ["signin_link", "signin_status", "signin_provider"],
};
const PACK_OF = new Map();
for (const [k, names] of Object.entries(PACKS)) for (const n of names) if (!PACK_OF.has(n)) PACK_OF.set(n, k);
/** The pack a tool belongs to (its first), or null. */
export const packOf = (name) => PACK_OF.get(String(name)) ?? null;

// The likely set is capped so a heavy user never drifts back toward "everything": ~70k chars of
// schema (~20k tokens). Core is ~50k chars. Past the cap, packs are taken in priority order.
const LIKELY_CHAR_CAP = Number(process.env.REASON_LIKELY_CHAR_CAP || 70_000);
const RECENT_DAYS = 14;

db.exec(`
  CREATE TABLE IF NOT EXISTS tool_recent (
    conversation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    last_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, name)
  );
  CREATE TABLE IF NOT EXISTS tool_sets (
    conversation_id TEXT PRIMARY KEY,
    names TEXT NOT NULL,
    packs TEXT NOT NULL DEFAULT '[]',
    why TEXT NOT NULL DEFAULT '',
    computed_at INTEGER NOT NULL
  );
`);

/** A tool call that ran, counted for the likely set. Never throws: a count must not fail a tool. */
export function recordToolUse(conversationId, name) {
  // Only for people on the diet: with REASON_TOOL_DIET=owner nobody else's use is kept.
  if (!conversationId || !name || !dietOn(conversationId)) return;
  try {
    db.prepare(`INSERT INTO tool_recent (conversation_id, name, n, last_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(conversation_id, name) DO UPDATE SET n = n + 1, last_at = excluded.last_at`).run(conversationId, String(name), clock.now());
  } catch {}
}
export function recentToolUse(conversationId, { days = RECENT_DAYS, now = clock.now() } = {}) {
  try {
    return db.prepare("SELECT name, n, last_at FROM tool_recent WHERE conversation_id = ? AND last_at >= ? ORDER BY n DESC, last_at DESC")
      .all(conversationId, now - days * 86_400_000);
  } catch { return []; }
}

const safe = (f) => { try { return !!f(); } catch { return false; } };
const DAY = 86_400_000;
const CLOSED_GOALS = new Set(["done", "dropped", "declined", "closed", "met", "expired", "cancelled"]);
/**
 * Which packs this person's state calls for, from the rows themselves. Each check is one indexed
 * query; a table an older install lacks reads as "no".
 */
export function statePacks(conversationId, { now = clock.now() } = {}) {
  const c = conversationId;
  const out = [];
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  // First, so a heavy user's other packs never push it past the cap: the rules in their prompt name these.
  if (safe(() => socialAllowedFor(c))) out.push("signin");
  if (safe(() => one("SELECT 1 FROM shop_runs WHERE conversation_id = ? AND updated_at >= ? LIMIT 1", c, now - 7 * DAY))
    || safe(() => one("SELECT 1 FROM agentcard_purchases WHERE conversation_id = ? AND created_at >= ? LIMIT 1", c, now - 7 * DAY))) out.push("shopping");
  if (safe(() => dbm.eventsOrganizedBy(c).some(e => e.status !== "cancelled"))) out.push("events_host");
  if (safe(() => dbm.eventsAttendedBy(c).some(e => e.status !== "cancelled"))) out.push("events_guest");
  if (safe(() => one("SELECT 1 FROM uber_rides WHERE conversation_id = ? AND created_at >= ? LIMIT 1", c, now - 7 * DAY))) out.push("rides");
  if (safe(() => dbm.listFlights(c).length)) out.push("flights");
  if (safe(() => dbm.listOauthTokens(c, "google").length)) out.push("calendar", "gmail");
  // A pack, not core: 0 tokens for anyone without it, where core would charge everybody (count_tokens 11-09).
  if (safe(() => dbm.listOauthTokens(c, "apple_calendar").length)) out.push("apple_calendar");
  if (safe(() => dbm.listTasks(c).length)) out.push("tasks");
  if (safe(() => dbm.listGoals(c).some(g => !CLOSED_GOALS.has(g.state)))) out.push("goals");
  if (safe(() => dbm.listSeries(c).length)) out.push("series");
  if (safe(() => dbm.listTodoLists(c).length)) out.push("todo");
  if (safe(() => dbm.listWatches(c).length)) out.push("watches");
  if (safe(() => one("SELECT 1 FROM call_errands WHERE conversation_id = ? AND state = 'open' LIMIT 1", c))) out.push("errands");
  if (safe(() => dbm.listCommitments(c).length)) out.push("commitments");
  return [...new Set(out)];
}

/** Every tool named in a tool_use block of `messages` (the thread the model is about to read). */
export function toolsInThread(messages) {
  const out = new Set();
  for (const m of messages ?? []) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === "tool_use" && b.name) out.add(b.name);
  }
  return out;
}

const sizeOf = (t) => JSON.stringify({ d: t.description, s: t.input_schema ?? t.inputSchema }).length;

/**
 * Compute the loaded set from scratch: core, then the thread's own tools, then state packs, then the
 * packs and tools they used lately, inside the cap. `visible` is toolsFor's list for them.
 */
export function computeLoaded(conversationId, visible, { messages = [], now = clock.now() } = {}) {
  const byName = new Map(visible.map(t => [t.name, t]));
  const names = new Set(CORE.filter(n => byName.has(n)));
  const why = [];
  let budget = LIKELY_CHAR_CAP;
  const take = (n) => {
    if (names.has(n) || !byName.has(n)) return;
    const s = sizeOf(byName.get(n));
    if (s > budget) return;
    budget -= s; names.add(n);
  };
  // A tool the thread already called stays loaded, so a history the model reads never names a
  // tool the request does not carry whole (and "same again" never costs a search).
  // Outside the cap for that reason: past it, a thread could name a tool it does not carry.
  for (const n of toolsInThread(messages)) {
    if (names.has(n) || !byName.has(n)) continue;
    names.add(n); budget -= sizeOf(byName.get(n));
  }
  const packs = statePacks(conversationId, { now });
  const recent = recentToolUse(conversationId, { now });
  for (const r of recent) { const p = packOf(r.name); if (p && !packs.includes(p)) packs.push(p); }
  for (const p of packs) for (const n of PACKS[p] ?? []) take(n);
  for (const r of recent) take(r.name);
  if (packs.length) why.push(`packs: ${packs.join(",")}`);
  if (recent.length) why.push(`recent: ${recent.length}`);
  return { names, packs, why: why.join("; ") };
}

const lastCall = new Map();
/** A model call for this person is going out now: their cache is warm from here for WARM_MS. */
export function noteModelCall(conversationId, now = clock.now()) { if (conversationId) lastCall.set(conversationId, now); }
export const _resetDiet = () => { lastCall.clear(); try { db.exec("DELETE FROM tool_sets; DELETE FROM tool_recent;"); } catch {} };

/**
 * The names loaded whole for this person on this call. Stored; replaced only when their cache is cold
 * (no model call for them in WARM_MS, or none since this process started — a restart does not keep the
 * server's cache from being warm, so the stored set is reused when nothing about it has changed).
 */
export function loadedFor(conversationId, visible, { messages = [], now = clock.now(), log = () => {} } = {}) {
  const visibleNames = new Set(visible.map(t => t.name));
  let row = null;
  try { row = db.prepare("SELECT names, packs, computed_at FROM tool_sets WHERE conversation_id = ?").get(conversationId); } catch {}
  const last = lastCall.get(conversationId);
  const warm = last != null && now - last < WARM_MS;
  let stored = null;
  try { stored = row ? new Set(JSON.parse(row.names)) : null; } catch {}
  // Warm: the set stands, whatever changed. Only a tool that has stopped being visible to them comes
  // out (toolsFor decides that, and a request may never carry a tool they cannot see).
  if (stored && warm) return new Set([...stored].filter(n => visibleNames.has(n)));
  const fresh = computeLoaded(conversationId, visible, { messages, now });
  const same = stored && stored.size === fresh.names.size && [...fresh.names].every(n => stored.has(n));
  if (!same) {
    try {
      db.prepare(`INSERT INTO tool_sets (conversation_id, names, packs, why, computed_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET names = excluded.names, packs = excluded.packs, why = excluded.why, computed_at = excluded.computed_at`)
        .run(conversationId, JSON.stringify([...fresh.names].sort()), JSON.stringify(fresh.packs), fresh.why, now);
    } catch {}
    log({ toolset: conversationId, loaded: fresh.names.size, of: visible.length, packs: fresh.packs, was: stored?.size ?? null });
  }
  return fresh.names;
}

// The API's own tool search. BM25 takes plain words ("book a ride", "spending limit"), which is how
// the model thinks about what it needs; regex would make it guess tool names.
export const SEARCH_TOOL = { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" };

/**
 * The `tools` array for one API call, plus the system note that names what is deferred. Loaded tools
 * first (by name, so the prefix is byte-stable), the search tool, then every deferred one.
 */
export function apiTools(conversationId, visible, opts = {}) {
  if (!dietOn(conversationId)) return { tools: visible, note: "" };
  const loaded = loadedFor(conversationId, visible, opts);
  const on = visible.filter(t => loaded.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  const off = visible.filter(t => !loaded.has(t.name));
  if (!off.length) return { tools: visible, note: "" };
  return {
    tools: [...on, SEARCH_TOOL, ...off.map(t => ({ ...t, defer_loading: true }))],
    note: deferredNote(off.map(t => t.name)),
  };
}

/**
 * What the model is told about the tools it does not hold yet. Without the names it cannot know
 * Reason books rides or caps spending, and would say it can't. Names only: ~1.5k tokens for ~280.
 */
export function deferredNote(names) {
  return `More of your tools, not loaded yet: ${names.join(", ")}.`
    + ` Any of them is yours to use: load it with tool_search_tool_bm25 (search in plain words for what you need, or its name) and then call it.`
    + ` Never tell them you can't do something until a search for it has come back empty.`;
}

/**
 * The thread as one request may send it. A search result in the history names tools by reference, and
 * the API refuses a reference to a tool the request does not declare; a tool can stop being visible
 * to someone (a switch, a lapsed plan). That search and its result leave the request only, never
 * the saved thread, and an untouched message stays the same object, so the prefix does not move.
 */
export function withoutStaleSearches(messages, visible, { searchDeclared = true } = {}) {
  const known = new Set(visible.map(t => t.name));
  // A search call with no result anywhere after it (a turn that stopped mid-search) never goes back.
  const answered = new Set();
  for (const m of messages) if (Array.isArray(m?.content)) for (const b of m.content) if (b?.type === "tool_search_tool_result") answered.add(b.tool_use_id);
  const last = messages.length - 1;
  messages = messages.map((m, i) => {
    if (i === last || m?.role !== "assistant" || !Array.isArray(m.content)) return m;
    if (!m.content.some(b => b?.type === "server_tool_use" && !answered.has(b.id))) return m;
    const content = m.content.filter(b => !(b?.type === "server_tool_use" && !answered.has(b.id)));
    return { ...m, content: content.length ? content : [{ type: "text", text: "(looked something up)" }] };
  });
  // No search tool in this request (the diet off, or refused this turn): every search block leaves it.
  if (!searchDeclared) {
    return messages.map((m) => {
      if (m?.role !== "assistant" || !Array.isArray(m.content)) return m;
      if (!m.content.some(b => b?.type === "server_tool_use" || b?.type === "tool_search_tool_result")) return m;
      const content = m.content.filter(b => b?.type !== "server_tool_use" && b?.type !== "tool_search_tool_result");
      return { ...m, content: content.length ? content : [{ type: "text", text: "(looked something up)" }] };
    });
  }
  return messages.map((m) => {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return m;
    const stale = new Set(m.content
      .filter(b => b?.type === "tool_search_tool_result" && (b.content?.tool_references ?? []).some(r => !known.has(r.tool_name)))
      .map(b => b.tool_use_id));
    if (!stale.size) return m;
    const content = m.content.filter(b => !((b?.type === "tool_search_tool_result" && stale.has(b.tool_use_id)) || (b?.type === "server_tool_use" && stale.has(b.id))));
    return { ...m, content: content.length ? content : [{ type: "text", text: "(looked something up)" }] };
  });
}
