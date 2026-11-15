// The call's record of what Reason looked up, carried from one turn of a call to the next.
//
// The platform sends each turn back as spoken words only; the tool calls and their results are gone by
// the next turn (call 41, 2026-10-23: a real Kitco price disowned one turn later). So every lookup is
// kept on the call row and shown in front of the newest thing they said (`withCallRecord`).
//
// Until 2026-11-15 a lookup was kept as the first 600 characters of its JSON. On call 119 the nearest
// store of a brand came back from Google with an unrelated, similarly named business first: its week of
// opening hours, full address, website and maps link filled all 600 characters. Reason said the second
// result (right: it matched the brand's own store page), and on the next turn, seeing no such result in
// its record, said it had got the address wrong and texted a different store. 44 seconds after the
// call a second text corrected the correction.
//
// Now each lookup is kept as a compact summary of EVERY result, with the fields a later turn needs
// (places: name, address, distance, open now / today's hours, phone, maps link; weather: the place,
// the temperature with its unit, the sky), and shown next to what Reason said after it. A budget trims
// whole low-value fields first, then whole trailing results it did not speak — never a result it spoke.
import { stamp, clock, config } from "../config.js";

/** What one lookup may take in the call row (whole results past it are dropped at write). */
export const STORE_BUDGET = 3_000;
/** What one lookup may take in front of a turn (results it did not speak, trailing first, go past it). */
export const SHOW_BUDGET = 1_500;
/** What the whole record may take in front of a turn: a phone turn pays for every token before the first word. */
export const TOTAL_BUDGET = 8_000;
/** The quote of what Reason said after a lookup. */
const SAID_MAX = 280;

const one = (v, n) => { const t = String(v ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const isScalar = (v) => v == null || ["string", "number", "boolean"].includes(typeof v);

/** Today's line of a week of opening hours ("Monday: 9 AM – 9 PM; Tuesday: …"), or the whole, short. */
function todaysHours(hours, at) {
  const h = String(hours ?? "");
  if (!h) return "";
  let day = "";
  try { day = new Date(at).toLocaleDateString("en-US", { weekday: "long", timeZone: config.installTz }); } catch { day = new Date(at).toLocaleDateString("en-US", { weekday: "long" }); }
  const parts = h.split(/;\s*/);
  const today = parts.find(p => p.toLowerCase().startsWith(day.toLowerCase()));
  return today ? `today ${today.slice(today.indexOf(":") + 1).trim()}` : one(h, 90);
}

function distance(m) {
  const d = Number(m);
  if (!Number.isFinite(d)) return "";
  return d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km (${(d / 1609.34).toFixed(1)} mi)`;
}

/** One place as the record keeps it: the fields in order of what a later turn needs, low-value last. */
function placeFields(r, at) {
  const open = r.open_now === true ? "open now" : r.open_now === false ? "closed now" : "";
  return [
    ["name", one(r.name, 80)],
    ["address", one(r.full_address || [r.address, r.city].filter(Boolean).join(", "), 120)],
    ["distance", distance(r.distance_m)],
    ["open", [open, r.temporarily_closed ? "temporarily closed" : "", todaysHours(r.opening_hours, at)].filter(Boolean).join(", ")],
    ["phone", one(r.phone, 24)],
    ["maps", one(r.google_maps_url, 120)],
    // Low value: dropped first when the lookup is over its budget.
    ["type", one(r.type || r.cuisine, 40), "low"],
    ["rating", r.rating != null ? `${r.rating}★${r.rating_count ? ` (${r.rating_count})` : ""}` : "", "low"],
    ["website", one(r.website, 80), "low"],
  ].filter(([, v]) => v);
}

const TEMP = (n, u) => (Number.isFinite(Number(n)) ? `${Math.round(Number(n))}°${u}` : "");

/** The weather as the record keeps it: the place, the temperature in THEIR unit, named, and the sky. */
function weatherLine(out) {
  const u = out.temperature_unit === "C" ? "C" : "F";
  const k = u === "C" ? "_c" : "_f";
  const now = out.now ?? {}, today = out.today ?? {};
  const feels = u === "C" ? (now.feels_like_c ?? (Number.isFinite(now.feels_like_f) ? Math.round((now.feels_like_f - 32) * 5 / 9) : null)) : now.feels_like_f;
  return [
    out.place ? `at ${one(out.place, 100)}` : "",
    `now ${TEMP(now[`temp${k}`], u)} (degrees ${u === "C" ? "Celsius" : "Fahrenheit"})`,
    feels != null ? `feels like ${TEMP(feels, u)}` : "",
    now.conditions ? one(now.conditions, 40) : "",
    now.wind_mph != null ? `wind ${now.wind_mph} mph` : "",
    `today high ${TEMP(today[`high${k}`], u)}, low ${TEMP(today[`low${k}`], u)}${today.rain_chance_pct != null ? `, rain ${today.rain_chance_pct}%` : ""}${today.conditions ? `, ${one(today.conditions, 40)}` : ""}`,
    out.reading_minutes_old != null ? `reading ${out.reading_minutes_old} min old` : "",
  ].filter(Boolean).join(" · ");
}

/** A compact line of an object's own scalar fields, `k: v`, each short; nested objects and arrays named only by size. */
function scalars(o, max = 120) {
  return Object.entries(o ?? {}).filter(([k, v]) => isScalar(v) && v !== "" && v != null && k !== "note" && k !== "ok")
    .map(([k, v]) => `${k}: ${one(v, max)}`).join(", ");
}

/**
 * What a tool run is kept as: `{ head, items }` — `head` the short line that is always kept (failed,
 * the error, the tool's note), `items` one compact string per result in the order the tool gave them,
 * each `{ text, key }` (`key`: what Reason would say of it — a name, an address — to find it again).
 */
export function summarize(name, out, { at = clock.now() } = {}) {
  if (out == null || typeof out !== "object") return { head: one(JSON.stringify(out ?? null), 300), items: [] };
  const note = out.note ? `note: ${one(out.note, 240)}` : "";
  if (out.ok === false) return { head: [`error: ${one(out.error ?? out.why ?? "failed", 200)}`, note].filter(Boolean).join(" · "), items: [] };
  if (Array.isArray(out.results) && out.results.some(r => r && typeof r === "object" && (r.name || r.address))) {
    const items = out.results.filter(r => r && typeof r === "object").map((r, i) => {
      const fields = placeFields(r, at);
      return { fields, key: [r.name, r.address].filter(Boolean).map(String), text: `${i + 1}. ${fields.map(([, v]) => v).join(" | ")}` };
    });
    return { head: [`${items.length} result${items.length === 1 ? "" : "s"}${out.attribution ? ` (${out.attribution})` : ""}`, note].filter(Boolean).join(" · "), items };
  }
  if (out.now && (out.now.temp_f != null || out.now.temp_c != null)) return { head: weatherLine(out), items: [] };
  // Anything else: its own short fields, then each element of its first list, then the note.
  const list = Object.entries(out).find(([, v]) => Array.isArray(v) && v.length);
  const items = list ? list[1].map((x, i) => {
    const text = isScalar(x) ? one(x, 200) : one(scalars(x, 80), 220);
    return { text: `${i + 1}. ${text}`, key: isScalar(x) ? [String(x)] : [x?.name, x?.title, x?.address].filter(Boolean).map(String) };
  }) : [];
  const nested = Object.entries(out).filter(([k, v]) => v && typeof v === "object" && !Array.isArray(v) && k !== "now").map(([k, v]) => `${k}: {${one(scalars(v, 60), 200)}}`);
  const head = [one(scalars(out), 500), ...nested.map(n => one(n, 220)), list ? `${list[0]}: ${list[1].length}` : "", note].filter(Boolean).join(" · ");
  return { head: one(head, 900), items };
}

/** Within `budget`: the head, then whole items in order; the low-value fields of a place go before any item. */
function fit({ head, items }, budget, keep = new Set()) {
  let size = head.length;
  const total = () => size + items.reduce((n, it) => n + it.text.length + 1, 0);
  if (total() <= budget) return { head, items, dropped: 0 };
  // 1. Low-value fields off every place.
  const slim = items.map((it, i) => it.fields ? { ...it, text: `${i + 1}. ${it.fields.filter(f => f[2] !== "low").map(([, v]) => v).join(" | ")}` } : it);
  const kept = [];
  let dropped = 0;
  for (const [i, it] of slim.entries()) {
    // 2. Whole results, in order, while they fit; a result Reason spoke is always kept.
    if (keep.has(i) || size + it.text.length + 1 <= budget) { kept.push(it); size += it.text.length + 1; } else dropped++;
  }
  return { head, items: kept, dropped };
}

/**
 * One tool run, as the call's record keeps it. `turn`: how many answers Reason had already given on
 * this call when it ran, so the answer it gave from it can be found on the next turn (`withCallRecord`).
 */
export function lookupEntry({ name, input = {}, out, at = clock.now(), turn = null }) {
  const s = summarize(name, out, { at });
  const f = fit(s, STORE_BUDGET);
  return {
    at,
    name,
    input: JSON.stringify(input ?? {}).slice(0, 200),
    ok: out?.ok !== false,
    head: f.head,
    items: f.items.map(it => ({ text: it.text, key: it.key, ...(it.fields ? { low: it.fields.filter(x => x[2] === "low").map(([, v]) => v) } : {}) })),
    ...(f.dropped ? { more: f.dropped } : {}),
    ...(Number.isInteger(turn) ? { turn } : {}),
  };
}

const textOf = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map(p => p?.text ?? "").join(" ") : "");
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

/** Reason's answers on this call, from the platform's messages, oldest first. */
export function answersIn(callMessages = []) {
  return (Array.isArray(callMessages) ? callMessages : []).filter(m => m?.role === "assistant").map(textOf).filter(t => t.trim());
}

/** Which results of a lookup Reason spoke: an address it said, else a name. */
function spokenItems(entry, said) {
  const words = norm(said);
  if (!words) return new Set();
  const hit = (k) => { const n = norm(k); return n.length >= 3 && words.includes(n); };
  const byAddress = new Set(), byName = new Set();
  (entry.items ?? []).forEach((it, i) => {
    const [nm, addr] = it.key ?? [];
    if (addr && hit(String(addr).split(",")[0])) byAddress.add(i);
    if (nm && hit(nm)) byName.add(i);
  });
  return byAddress.size ? byAddress : byName;
}

/** An entry written before 2026-11-15 (`got`: the head of the JSON) or now (`head` + `items`), as lines. */
export function recordLines(entry, { said = "", budget = SHOW_BUDGET, when = true } = {}) {
  const top = `${when ? `- ${stamp(entry.at)} ` : ""}${entry.name} ${entry.input}${entry.ok ? "" : " (failed)"}`;
  if (entry.got != null && entry.items == null) return [`${top} → ${entry.got}`];
  const spoken = spokenItems(entry, said);
  const items = (entry.items ?? []).map(it => ({ ...it, fields: null }));
  let f = fit({ head: entry.head ?? "", items }, budget, spoken);
  // Over budget with the low fields still on: drop them (they are kept apart on the entry).
  if (f.dropped) {
    const slim = (entry.items ?? []).map(it => ({ ...it, text: it.low?.length ? it.low.reduce((t, l) => t.replace(` | ${l}`, ""), it.text) : it.text }));
    f = fit({ head: entry.head ?? "", items: slim }, budget, spoken);
  }
  const keptIdx = (entry.items ?? []).map((it, i) => i).filter(i => f.items.some(k => k.key === entry.items[i].key));
  const lines = [`${top} → ${f.head}`];
  f.items.forEach((it, j) => lines.push(`    ${it.text}${spoken.has(keptIdx[j]) ? "  ← the one you said" : ""}`));
  const more = (entry.more ?? 0) + f.dropped;
  if (more) lines.push(`    (+${more} more result${more === 1 ? "" : "s"} not shown; run the lookup again if you need them)`);
  if (said) lines.push(`    what you said from it: "${one(said, SAID_MAX)}"`);
  return lines;
}

/** The rule that rides with the record: what was said from a lookup stands unless a result in hand says otherwise. */
export const RECORD_RULE = `What you said from a lookup on this call stands: it came from the result shown under it.`
  + ` Never say you got it wrong, or give a different answer, unless a tool result you have in hand right now contradicts it.`
  + ` If a result is not shown or you are unsure, run the lookup again rather than guess.`;

/**
 * The call's record of what Reason looked up, in front of the newest thing they said, each lookup with
 * what Reason said from it (`callMessages`: the platform's messages for this call).
 */
export function withCallRecord(messages = [], lookups = [], { callMessages = [] } = {}) {
  if (!lookups.length || !messages.length || messages.at(-1)?.role !== "user") return messages;
  const answers = answersIn(callMessages);
  // Newest first within TOTAL_BUDGET; an older lookup past it shows its head and the results it spoke only.
  let used = 0;
  const shown = [...lookups].reverse().map(l => {
    const said = Number.isInteger(l.turn) ? answers[l.turn] ?? "" : "";
    let ls = recordLines(l, { said });
    if (used + ls.join("\n").length > TOTAL_BUDGET) ls = recordLines(l, { said, budget: 0 });
    used += ls.join("\n").length;
    return ls;
  }).reverse();
  const lines = shown.flat();
  const record = `[Your own record of this call, kept by code — not something they said, and not something to mention.`
    + ` Every lookup you have really run on this call, with what came back and what you said from it:\n${lines.join("\n")}\n${RECORD_RULE}]`;
  const last = messages.at(-1);
  const theirs = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  return [...messages.slice(0, -1), { role: "user", content: [{ type: "text", text: record }, ...theirs] }];
}

/** The record as the thread keeps it after the call: each lookup's line and results, no quotes, within `budget`. */
export function afterCallLines(lookups = [], { budget = 2_000 } = {}) {
  const out = [];
  let size = 0;
  for (const l of lookups) {
    const ls = recordLines(l, { budget: 600, when: false }).map(s => s.trim());
    const t = ls.join(" ");
    if (size + t.length > budget) { out.push(`${l.name} ${l.input}`); size += l.name.length + l.input.length + 1; continue; }
    out.push(t); size += t.length;
  }
  return out;
}

/**
 * The line in the brain's own call frame (./voice.js ownerContext), in every call mode, classic
 * included: it is what the brain is told, never the voice's words.
 */
export const CALL_RECORD_FRAME = `Never take back or "correct" something you said earlier in this call unless a tool result you have in hand right now`
  + ` contradicts it. Your record of the call's lookups (in front of their newest words) shows every result and what you said from each:`
  + ` read it before you doubt yourself. When you are unsure, run the lookup again rather than guess, and if the new result really differs, say plainly what changed.`
  + ` A text you send after the call follows the same rule.`;
