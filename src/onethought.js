// One thought, one answer: what happens to a text that lands while a request is being worked on.
//
// The incident (2026-10-24, dm:owner, UTC): "No I want to watch when I leave work so somewhere
// around work" at 19:05:57 and "And I'd watch it on Tuesday" at 19:06:09 — one thought, two bubbles,
// 12 seconds apart. The burst window (2.5s then) had long closed, so the first text's turn was
// already running when the second landed. The router held it (`joined_burst`), but the drain had
// already taken the first text's rows: the second sat in the table until that turn ended, then got
// a whole turn of its own (`drained_again`). Two turns, two research passes, two answers — 11:15am
// "a maybe" and "want me to open the site?" in the first, 11:00am from the site in the second, with
// a different "closest" theater in each. Nothing folded the second text into the work already in
// flight, and nothing checked the first reply against it before it went.
//
// So a text that lands mid-turn is READ first — by meaning, one small side call, never by keywords:
//
//   continuation  adds to, narrows or corrects the active request ("on Tuesday", "around work").
//                 Folded in: it is taken off the pile so it never gets a turn of its own, and the
//                 running turn is handed it on its next tool result (NEW_FROM_THEM, see
//                 src/tools.js runTool). A reply drafted before the turn saw it is not sent: the
//                 runtime discards it and recomposes once with everything (Runtime._turn).
//   new           an unrelated ask. Left held, and answered by its own turn the moment this one
//                 ends, under its own text (the existing burst/thread-reply path).
//   chat          thanks, a reaction, an aside. Left held for a light turn of its own.
//   unclear       folded in, with a line telling the turn to ask one short question rather than
//                 split the answer if it cannot tell either.
//
// Anything the reader cannot answer — no key, an error, a timeout — is a continuation. A second
// parallel reply is never the default (the repo rule: when unsure, fold it in).
//
// The state is in memory and per conversation, because a turn is: turns for one conversation run
// one at a time (Runtime.enqueue). A folded text's row is deleted when it is taken, the same bargain
// takePendingInbound makes, and a turn that is interrupted hands it back with its own (Router).
import Anthropic from "@anthropic-ai/sdk";
import { callApi, cachedSystem, apiSkipWhy } from "./spend.js";
import { askStructuredViaCli } from "./backends/cli.js";
import { config, clock, stamp } from "./config.js";

/** How many times a turn may discard its draft for texts that landed after it was written. */
export const MAX_RECOMPOSE = 2;

/** Ends a line code puts in a turn's mouth, so it can be taken back off the thread after. */
export const CODE_LINE = "\u2063(code re-ask)";

/** conversationId → the user turn running for it. */
const active = new Map();
let seq = 0;

/**
 * A user turn starts. `requests` are the request rows its drain opened; `answering` is the
 * router's note of which text it answers. Returns the token the turn's tools carry.
 */
export function begin(conversationId, { text = "", requests = null, answering = null } = {}) {
  const turn = {
    token: `fold-${++seq}`, conversationId, startedAt: clock.now(), text: String(text ?? ""),
    requests: Array.isArray(requests) ? requests : [], answering,
    added: [], classifying: new Set(), ended: false,
  };
  active.set(conversationId, turn);
  return turn;
}

/** The turn is over: from here a text that lands takes the ordinary path. */
export function end(turn) {
  if (!turn) return;
  turn.ended = true;
  if (active.get(turn.conversationId) === turn) active.delete(turn.conversationId);
}

/** The user turn running for this conversation, or null. */
export function activeFor(conversationId) {
  const t = active.get(conversationId);
  return t && !t.ended ? t : null;
}

const byToken = (token) => {
  for (const t of active.values()) if (t.token === token && !t.ended) return t;
  return null;
};

/** The request a continuation is folded into: the last one the drain opened. */
export const activeRequestId = (turn) => turn?.requests?.at(-1)?.id ?? null;

/** Hand the running turn a text it now owns. `row` is the pending_inbound row it was taken from. */
export function fold(turn, { handle, text, unclear = false, row = null }) {
  if (!turn || turn.ended || turn.closing) return false;
  const at = row?.arrived_at ?? clock.now();
  // In the order they were SENT: two reads in flight at once can finish the other way round.
  turn.added.push({ handle, text: String(text ?? ""), unclear, row, seen: false, at });
  // Two texts can land in the same millisecond (the test suite under load does it every few runs),
  // so a tie falls back to the pending_inbound row id, which is the order they were taken in.
  turn.added.sort((a, b) => (a.at - b.at) || ((a.row?.id ?? 0) - (b.row?.id ?? 0)));
  // The reply now answers the newest text of the request, so it is threaded against that one.
  if (turn.answering) turn.answering = { ...turn.answering, handle: turn.added.at(-1).handle };
  return true;
}

/** Texts folded in that the turn has not been shown yet. */
export const unseen = (turn) => (turn?.added ?? []).filter(a => !a.seen);

/** Take the unseen texts (marking them seen) — for the recompose, or a tool result. */
export function takeUnseen(turn) {
  const out = unseen(turn);
  for (const a of out) a.seen = true;
  return out;
}

/** Every row the turn took in, for a hand-back when it is interrupted. */
export const foldedRows = (turn) => (turn?.added ?? []).map(a => a.row).filter(Boolean);

/**
 * The words a tool result carries to the model, or "" when nothing new is waiting. Taking them marks
 * them seen: from here the turn has them, and the runtime only puts their lines into the thread.
 */
export function noteFor(token) {
  const turn = byToken(token);
  const items = takeUnseen(turn);
  if (!items.length) return "";
  return addedLine(items, { midTool: true });
}

/** Whether something is waiting for this turn's tools (without taking it). */
export const hasUnseen = (token) => unseen(byToken(token)).length > 0;

function addedLine(items, { midTool = false } = {}) {
  const quoted = items.map(a => `"${a.text.replace(/\s+/g, " ").trim()}"`).join(" then ");
  const unclear = items.some(a => a.unclear);
  return `They just texted ${quoted} while you were working. `
    + (unclear
      ? "It may add to what you are working on or may be something new: if you cannot tell either, ask one short question in your reply rather than guessing and splitting the answer."
      : "It adds to the request you are working on: fold it in now — redo whatever part it changes — and send ONE answer that uses it.")
    + (midTool ? " Never answer the old version." : "");
}

/**
 * What the recompose turn is handed: their new words, the draft that was not sent, and what to do.
 * `keep` is what the thread keeps — their words only, the same as any text of theirs.
 */
export function recomposeText(items, draft) {
  const words = items.map(a => a.text).join("\n");
  const unclear = items.some(a => a.unclear);
  const note = draft
    ? `[Before your reply went out they sent the line above. Your draft, which was NOT sent:\n"""${String(draft).slice(0, 3_000)}"""\n`
      + (unclear
        ? "If the new line adds to that request, write the one reply that answers all of it; if it is plainly something new, answer the request first and then the new thing; if you cannot tell, answer the request and ask one short question about the new line. "
        : "It adds to the same request. Write the one reply that answers the whole request with everything they said — if it needs a lookup you have not done (a different day, a different place), do it now. ")
      + "Do not mention the draft, and do not repeat anything you already sent.]"
    : "[They sent this while you were still working on their last text, and it adds to it. Answer the whole request in one reply.]";
  return { text: `${words}\n${note}`, keep: words };
}

/** A line for the thread, in the shape both backends write their lines in. */
export const historyLine = (who, a) => `[${stamp(a.at)}] ${who}: ${a.text}`;

/** A classification in flight for this turn. The send waits for it (settled) before deciding. */
export function track(turn, promise) {
  if (!turn) return promise;
  const p = Promise.resolve(promise).catch(() => {});
  turn.classifying.add(p);
  p.finally(() => turn.classifying.delete(p));
  return promise;
}

/**
 * The most a mid-turn read may take, all in (Router.#readMidTurn): the API ask, the CLI ask after
 * it, and a little over. A read past it leaves the text held for a turn of its own.
 */
export const READ_BUDGET_MS = config.midTurnTimeoutMs + config.midTurnCliTimeoutMs + 1_000;

/**
 * Wait for every read still in flight for this turn. Longer than any read can take (above), so a
 * read never lands after the send has stopped waiting for it.
 */
export async function settled(turn, { timeoutMs = READ_BUDGET_MS + 1_000 } = {}) {
  if (!turn?.classifying?.size) return;
  let timer;
  await Promise.race([
    Promise.allSettled([...turn.classifying]),
    new Promise(r => { timer = setTimeout(r, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

// ---------- the reader ----------

export const KINDS = ["continuation", "new", "chat", "unclear"];

export const MIDTURN_INSTRUCTIONS = `You sort ONE text somebody just sent their personal assistant while the assistant was still working on their previous request. Decide what the new text is, by what it means:
- continuation: it adds to, narrows, corrects or changes the request being worked on — a day, a time, a place, a person, a number, "actually", "no I meant", "and", a detail that only makes sense as part of that request.
- new: a separate, unrelated ask that needs its own answer.
- chat: thanks, a reaction, an aside, small talk — nothing to do.
- unclear: it could genuinely be either continuation or new and you cannot tell.
Judge what the text means in context, not which words it uses.`;

export function midTurnPrompt({ request, text, previous = "" }) {
  return `The request being worked on (their words, oldest first):\n${String(request ?? "").slice(0, 1_500)}\n\n`
    + (previous ? `The assistant's last message before that, for context:\n${String(previous).slice(0, 400)}\n\n` : "")
    + `The new text, verbatim:\n${String(text ?? "").slice(0, 800)}`;
}

const SCHEMA = {
  type: "object",
  properties: { kind: { type: "string", enum: KINDS } },
  required: ["kind"],
  additionalProperties: false,
};

let client = null;
const anthropic = () => (client ??= new Anthropic());

/**
 * One structured answer from the small model: over the API when there is a key, and on the
 * claude-cli backend through the CLI when the API ask fails or there is no key. Throws when neither
 * gave an answer. Shared with src/said.js. `cli: false` keeps a caller to the API only; `api: false`
 * keeps it to the CLI only (work that runs after the reply, where a cold start costs nobody a wait).
 * `feature` names the call in the usage count (src/spend.js).
 */
export async function askJson({ system, prompt, schema, name = "answer", feature = "onethought", model = config.midTurnModel, timeoutMs = config.midTurnTimeoutMs, api = true, cli = true, cliModel = config.midTurnCliModel, cliTimeoutMs = config.midTurnCliTimeoutMs, maxTokens = 200, client: sdk = null }) {
  let apiError = null;
  if (!api) apiError = "kept to the subscription";
  else if (!sdk && (apiError = apiSkipWhy(feature))) { /* skipped: straight to the CLI */ }
  else if (process.env.ANTHROPIC_API_KEY) {
    try {
      const res = await callApi({
        feature, client: sdk ?? anthropic(),
        params: {
          model, max_tokens: maxTokens,
          // Cached: the same instructions and tool on every call (src/spend.js cachedSystem).
          system: cachedSystem(system),
          tools: [{ name, description: "Record the answer.", input_schema: schema }],
          tool_choice: { type: "tool", name },
          messages: [{ role: "user", content: prompt }],
        },
        options: { timeout: timeoutMs, maxRetries: 0 },
      });
      const use = (res.content ?? []).find(b => b.type === "tool_use");
      // A forced tool call cut off by max_tokens hands back partial (often empty) input, which
      // would read as a real answer of nothing: said so, rather than taken.
      if (res.stop_reason === "max_tokens") apiError = `the answer was cut off at ${maxTokens} tokens`;
      else if (use?.input && typeof use.input === "object") return { value: use.input, via: "api" };
      else apiError = "the API gave no answer";
    } catch (e) {
      apiError = (e?.message ?? String(e)).split("\n")[0].slice(0, 160);
    }
  } else apiError = "no API key";
  if (!cli || process.env.REASON_BACKEND !== "claude-cli") throw new Error(apiError);
  const r = await askStructuredViaCli({ prompt, system, schema, model: cliModel, timeoutMs: cliTimeoutMs, feature });
  if (r.error || !r.value) throw new Error(`${apiError}; cli: ${r.error ?? "no answer"}`);
  return { value: r.value, via: "cli", apiError };
}

/**
 * Room for the forced tool call {"kind": "..."}. It is ~20 output tokens, and 50 left no margin for
 * the call's own framing; the same flaw that made #95's yes/no come back empty (max_tokens 3).
 */
export const MIDTURN_MAX_TOKENS = 128;

/** For tests: what reads a mid-turn text. `null` puts the real one back. */
let reader = null;
export function setMidTurnReader(f) { reader = f; }

/**
 * Read one mid-turn text. Never throws: anything but a clean answer is a continuation, folded into
 * the request — `via: "fallback"` says so in the log.
 */
export async function classify({ request, text, previous = "" }) {
  const started = Date.now();
  try {
    const r = reader
      ? { value: await reader({ request, text, previous }), via: "stub" }
      : await askJson({ system: MIDTURN_INSTRUCTIONS, prompt: midTurnPrompt({ request, text, previous }), schema: SCHEMA, name: "sort", maxTokens: MIDTURN_MAX_TOKENS });
    const kind = typeof r.value === "string" ? r.value : r.value?.kind;
    if (!KINDS.includes(kind)) throw new Error(`the reader answered ${JSON.stringify(kind ?? null)}`);
    return { kind, via: r.via, ms: Date.now() - started };
  } catch (e) {
    return { kind: "continuation", via: "fallback", why: (e?.message ?? String(e)).split("\n")[0].slice(0, 200), ms: Date.now() - started };
  }
}

/** The request as the reader is shown it: what the turn was asked, plus anything already folded. */
export const requestText = (turn) => [turn?.text ?? "", ...(turn?.added ?? []).map(a => a.text)]
  .join("\n").replace(/^\[they sent the following as \d+ separate texts[^\]\n]*\]\n/, "");
