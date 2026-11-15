// How a person's own call opens (2026-11-15).
//
// The opening line is said before any turn runs: the Cartesia agent speaks it as its first message
// (`initial_message: "{{greeting}}"`, scripts/cartesia-agent-setup.mjs) and GPT-Live is told "greet them
// with this line". Until now code picked it from fixed lists (./carryover.js GREETINGS, CLASSIC_AGAIN)
// with a random lead-in ("yo,", "oh,"), and three calls in a row opened almost the same way, one of them
// "yo, hey <name>, what did we miss?". The owner: be dynamic, a friendly welcome.
//
// So the lines are written by a model, AHEAD of the call: after each of their calls (and whenever the
// stock runs low) the side model writes a few per time of day for this person, from their first name
// only. Pickup takes one off the account row — a synchronous read, no model call and no wait, so the
// first word is as quick as before — and checks it (`greetingOk`); anything off, or none written yet,
// is a plain "Hey <first name>." Letting the voice agent's own model write the opening instead was
// weighed and not taken: the agent's first line is a fixed string by design (its saved initial_message),
// and an opening its model writes would put a model turn in front of the first word and change the
// agent's saved settings.
import * as db from "../db.js";
import { clock } from "../config.js";
import { zoneFor } from "../zone.js";
import { assistantNicknames } from "../identity.js";
import { askStructured, sideAskAllowed } from "../backends/side.js";
import { wasTheirCall, endOf } from "./carryover.js";

/** The times of day a line is written for, and "again": they spoke within AGAIN_WITHIN_MS. */
export const BANDS = ["morning", "afternoon", "evening", "night", "again"];
export const AGAIN_WITHIN_MS = 30 * 60_000;
/** How many lines the stock keeps per band, and below which it is written again (in the background). */
const STOCK = 3;
const LOW = 2;
/** The last openers said to them: never said again while they are in here. */
const RECENT = 3;
/** At most one background write per person per this long (a failing model is not asked on every call). */
const REFILL_GAP_MS = 10 * 60_000;

/** Their first name, or "" (never the stand-in an unnamed account reads as). */
export function firstName(name) {
  const n = String(name ?? "").trim();
  if (!n || n === "the person I work for") return "";
  return n.split(/\s+/)[0].replace(/[^\p{L}'’-]/gu, "");
}

/** The plain line when nothing written fits. */
export const plainGreeting = (first) => (first ? `Hey ${first}.` : "Hey.");

export function bandFor(ms, tz) {
  let h = 12;
  try { h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(ms))) % 24; } catch { /* the install's noon */ }
  return h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "night";
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
const NUMBERISH = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|half|quarter|dozen)\b/i;
const TIMEISH = /\b(?:o'?clock|a\.?m\.?|p\.?m\.?|noon|midnight|minutes?|hours?|tomorrow|yesterday|tonight's|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const MONEYISH = /[$£€]|\b(?:dollars?|bucks|price|cost|paid|pay)\b/i;
const PLACEISH = /\b(?:home|work|office|gym|school|store|shop|street|avenue|road|downtown|city|airport|station)\b/i;
const CLAIMISH = /\b(?:done|booked|sent|ordered|scheduled|confirmed|found|finished|ready|already|reminder|news|update|i'?ve|i have|i got|i'?ll|i will|we'?ll|promise|checked|looked)\b/i;
const MISSED = /\bmiss(?:ed|ing)?\b|what did we|what'd we|catch me up|fill me in/i;

/**
 * May this line open their call? ≤ 12 words (≤ 5 for a salute); no number, time, price, place or claim
 * word; nothing about something missed; no name but their first name (so never the assistant's own
 * nickname for them); not one of the last three openers said. Returns { ok, why }.
 */
export function greetingOk(line, { first = "", nicknames = [], recent = [], salute = false } = {}) {
  const t = String(line ?? "").trim();
  if (!t) return { ok: false, why: "empty" };
  const words = t.split(/\s+/);
  if (words.length > (salute ? 5 : 12)) return { ok: false, why: "too long" };
  if (/[\n"“”<>{}[\]]/.test(t)) return { ok: false, why: "markup" };
  for (const [re, why] of [[NUMBERISH, "a number"], [TIMEISH, "a time"], [MONEYISH, "a price"], [PLACEISH, "a place"], [CLAIMISH, "a claim"], [MISSED, "what was missed"]]) if (re.test(t)) return { ok: false, why };
  if (salute && /\?/.test(t)) return { ok: false, why: "a salute asks nothing" };
  for (const n of nicknames) if (n && new RegExp(`(?<![\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").test(t)) return { ok: false, why: "their name for the assistant" };
  // Any capitalised word after the first is their first name (or "I"): nobody else's name is said.
  for (const [i, w] of words.entries()) {
    // The first word, and the first word of a new sentence, may be capitalised.
    if (i === 0 || /[.!?]$/.test(words[i - 1])) continue;
    const bare = w.replace(/^[^\p{L}]+|[^\p{L}'’]+$/gu, "").replace(/['’]s$/, "");
    if (/^\p{Lu}/u.test(bare) && bare !== "I" && bare.toLowerCase() !== first.toLowerCase()) return { ok: false, why: "a name that is not theirs" };
  }
  if (!first && /\b(?:hey|hi|hello|morning|evening|afternoon)\s+\p{Lu}/u.test(t)) return { ok: false, why: "a name with none on file" };
  const n = norm(t);
  if (recent.some(r => norm(r) === n)) return { ok: false, why: "said in the last three calls" };
  return { ok: true, why: "" };
}

// ---------- pickup: synchronous, no model ----------

function talkedRecently(conversationId, now) {
  try {
    // A call of theirs that really reached them and ended within the half hour (the call being greeted has no words yet).
    return db.listCalls(conversationId, { limit: 4 }).some(r => Number(r.created_at) < now && wasTheirCall(r) && now - endOf(r) < AGAIN_WITHIN_MS);
  } catch { return false; }
}

/**
 * The opening line for their call, now. `kind`: "greet" (they rang, or Reason rang with nothing of its
 * own to say) or "salute" (two to five words that go in front of why Reason rang). Takes the line off
 * the stock and remembers it as said; never waits on anything (a low stock is written again in the
 * background). Returns { line, band, from: "written" | "plain" }.
 */
export function pickGreeting({ conversationId, name = "", kind = "greet", now = clock.now(), refill = refillSoon, log = () => {} } = {}) {
  const first = firstName(name);
  // A salute with nothing written is "hey <name>": a call Reason places opens exactly as it did before (provider.js announcementFor).
  const plain = { line: kind === "salute" ? (first ? `hey ${first}` : "hey") : plainGreeting(first), from: "plain" };
  if (!conversationId) return { ...plain, band: "" };
  let tz = "";
  try { tz = zoneFor(conversationId); } catch { tz = ""; }
  const band = kind === "greet" && talkedRecently(conversationId, now) ? "again" : bandFor(now, tz);
  let stock = {};
  let nicknames = [];
  try { stock = db.callGreetings(conversationId); } catch { stock = {}; }
  try { nicknames = assistantNicknames(conversationId); } catch { nicknames = []; }
  const recent = Array.isArray(stock.recent) ? stock.recent : [];
  const key = kind === "salute" ? "salute" : band;
  const lines = Array.isArray(stock[key]) ? stock[key] : [];
  // Written for a different first name (they changed it): none of it is used.
  const sameName = String(stock.for ?? "") === first;
  const at = sameName ? lines.findIndex(l => greetingOk(l, { first, nicknames, recent, salute: kind === "salute" }).ok) : -1;
  const chosen = at >= 0 ? { line: lines[at], from: "written" } : plain;
  try {
    const left = at >= 0 ? lines.filter((_, i) => i !== at) : lines;
    db.setCallGreetings(conversationId, { ...stock, [key]: left, recent: [chosen.line, ...recent].slice(0, RECENT) });
    if (!sameName || left.length < LOW) refill(conversationId, { name, log });
  } catch { /* the stock is a help; the plain line still goes */ }
  log({ call_greeting: conversationId, band, kind, from: chosen.from });
  return { ...chosen, band };
}

// ---------- written ahead, off the call's path ----------

const SYSTEM = `You write the first words a friendly personal assistant says when it picks up (or places) a phone call with someone it knows well.`
  + ` It opens the call: a hello, never a goodbye or a goodnight wish. Warm and natural, like a friend glad to hear from them, in plain everyday spoken English, not poetic. Each line is ONE short sentence of at most 12 words, ending in a full stop, an exclamation mark or one easy open question ("how's it going?").`
  + ` Use their first name in most lines (or none, if none is given), and never any other name or nickname.`
  + ` Never a fact, a number, a time, a price, a place, a claim that something was done, a promise, or anything about news.`
  + ` Never ask what you missed or ask them to catch you up. Every line different in wording from the others and from the recent ones given.`;

const SCHEMA = {
  type: "object",
  properties: {
    ...Object.fromEntries(BANDS.map(b => [b, { type: "array", items: { type: "string" }, description: b === "again" ? "for when they spoke a few minutes ago: a light 'hey again' kind of line, nothing about what was said" : `fits the ${b} in their day` }])),
    salute: { type: "array", items: { type: "string" }, description: "two to five words, no question, said right before the assistant says why it is calling (\"Morning, Sam\", \"Hey Sam\")" },
  },
  required: [...BANDS, "salute"],
};

const pending = new Map();

/** Write the stock again for this person, in the background, at most once per REFILL_GAP_MS. Never throws, never awaited at pickup. */
export function refillSoon(conversationId, { name = "", log = () => {}, ask = askStructured } = {}) {
  if (!conversationId || pending.has(conversationId)) return;
  const last = pending.get(`at:${conversationId}`) ?? 0;
  if (clock.now() - last < REFILL_GAP_MS) return;
  pending.set(`at:${conversationId}`, clock.now());
  const job = new Promise(r => setImmediate(r)).then(() => writeGreetings(conversationId, { name, log, ask }))
    .catch(e => log({ call_greetings_write_failed: conversationId, why: String(e?.message ?? e).split("\n")[0] }))
    .finally(() => pending.delete(conversationId));
  pending.set(conversationId, job);
}

/** The side model writes STOCK lines per band (and salutes) for this person; only lines that pass the guard are kept. */
export async function writeGreetings(conversationId, { name = "", log = () => {}, ask = askStructured } = {}) {
  if (ask === askStructured && !sideAskAllowed()) return { ok: false, why: "no side model" };
  let acct = null;
  try { acct = db.getAccount(conversationId); } catch { acct = null; }
  const first = firstName(name || acct?.name);
  const stock = db.callGreetings(conversationId);
  const recent = Array.isArray(stock.recent) ? stock.recent : [];
  const nicknames = (() => { try { return assistantNicknames(conversationId); } catch { return []; } })();
  const prompt = `Their first name: ${first || "(none on file: use no name)"}.\nRecent openers to them (do not reuse their wording):\n${recent.map(r => `- ${r}`).join("\n") || "- (none)"}\n`
    + `Write ${STOCK + 1} lines for each of: ${BANDS.join(", ")}; and ${STOCK + 1} salutes.`;
  const r = await ask({ prompt, system: SYSTEM, schema: SCHEMA, model: "haiku", timeoutMs: 30_000, feature: "call_greetings", maxTokens: 1200 });
  if (!r?.value) { log({ call_greetings_not_written: conversationId, why: r?.error ?? "no answer" }); return { ok: false, why: r?.error ?? "no answer" }; }
  const keep = (list, salute) => [...new Set((Array.isArray(list) ? list : []).map(s => String(s ?? "").replace(/\s+/g, " ").trim()))]
    .filter(l => greetingOk(l, { first, nicknames, recent, salute }).ok).slice(0, STOCK);
  const fresh = db.callGreetings(conversationId);
  const next = { ...fresh, for: first, written_at: clock.now() };
  for (const b of BANDS) next[b] = keep(r.value[b], false);
  next.salute = keep(r.value.salute, true);
  db.setCallGreetings(conversationId, next);
  log({ call_greetings_written: conversationId, kept: BANDS.map(b => next[b].length).concat(next.salute.length).join("/") });
  return { ok: true, stock: next };
}

/** For tests: forget the background writes in flight. */
export function resetGreetings() { pending.clear(); }
