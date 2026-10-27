/**
 * A Web reply that appears as it is written (REASON_WEB_DRAFTS).
 *
 * On the claude-cli backend a Web turn used to reach the open tab all at once, ~10–16 s after the
 * message. With the switch on for a conversation, the CLI prints the reply's words as it writes them
 * (src/backends/cli.js `onEvent`) and this file decides which of them the tab may see early. It sees
 * nothing the finished reply would not have shown, by putting every early piece through the same
 * floor the finished reply goes through, in the same order, before it leaves:
 *
 *   - only whole sentences, cut where the model ended one, never mid-word or mid-figure;
 *   - only the words of a message that has called no tool. A message that goes on to call one was
 *     the model talking to itself on the way to the answer; the reply is the LAST message. A piece
 *     already shown from a message that then calls a tool is taken back;
 *   - the self-note first line (src/plain.js withoutSelfNote): held until that line is finished and
 *     can be judged, then dropped exactly as the reply would drop it;
 *   - NO_REPLY anywhere: nothing is shown until the turn ends;
 *   - the figures check (src/offers.js guardReply): a piece it would change is not shown, and nothing
 *     more is this turn;
 *   - the said check (src/said.js checkDraft), the pre-send check that rejects a draft which quietly
 *     changes what it told them or re-asks a settled question: each piece is checked BEFORE it is
 *     shown, so a draft the check blocks never reaches the tab. A piece it rejects stops the stream
 *     and takes back what was shown; the rewritten reply then arrives whole.
 *
 * The page draws a piece as an ordinary Reason line (src/pages/webconvo.js). The finished reply,
 * saved and sent as always, replaces it; the turn's end always takes back whatever is left, so a
 * turn that fails or goes quiet leaves nothing behind. iMessage and every other channel never see
 * any of this: only a user turn from Web, cleared by the harm screen, on the CLI backend.
 */
import { EventEmitter } from "node:events";
import { withoutSelfNote, readSilence } from "./plain.js";
import { guardReply } from "./offers.js";
import { purchaseRecordSource } from "./purchasesnote.js";
import { checkDraft } from "./said.js";

/** `draft` events: `{ conversationId, text }` for what the tab may show now, `text: null` to take it back. */
export const draftEvents = new EventEmitter();
draftEvents.setMaxListeners(0);

/**
 * Is streaming on for this conversation? REASON_WEB_DRAFTS: unset/"0"/"off" → never (prod today);
 * "1"/"on"/"all" → every conversation; anything else → a comma-separated list of conversation ids.
 */
export function streamOn(conversationId, env = process.env.REASON_WEB_DRAFTS) {
  const v = String(env ?? "").trim();
  if (!v || v === "0" || v.toLowerCase() === "off") return false;
  if (["1", "on", "all"].includes(v.toLowerCase())) return true;
  return v.split(",").map(x => x.trim()).filter(Boolean).includes(String(conversationId));
}

/** The end of the last whole sentence (or line) in `text`, as an index; 0 when there is none yet. */
export function sentenceEnd(text) {
  let at = 0;
  const re = /[.!?…]+["'”’)\]*_]*(?=\s)|\n/g;
  let m;
  while ((m = re.exec(text))) {
    // "1." starting a list item, or "e.g." mid-sentence, is not the end of anything.
    const head = text.slice(0, m.index);
    const before = head.split(/\s/).pop();
    if (m[0] !== "\n" && (/(^|\n)\s*\d+$/.test(head) || /^(e\.g|i\.e|vs|mr|mrs|ms|dr|st)$/i.test(before))) continue;
    at = m.index + m[0].length;
  }
  return at;
}

const NOT_A_NOTE = /\b(you|u|ur|your)\b/i;

/**
 * What of `raw` (a message's words so far, cut at a sentence end) the tab may see, before the said
 * check: `{ text }`, `{ hold: true }` (wait for more) or `{ stop: true }` (show nothing more this
 * turn). `complete` is true once the message has ended.
 */
export function shapeDraft(conversationId, raw, { complete = false } = {}) {
  const s = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!s) return { hold: true };
  // The marker for "say nothing", or the start of it: nothing until the turn has decided.
  if (!complete && /NO_|NO$/.test(s)) return { hold: true };
  let text = s;
  const cut = s.indexOf("\n");
  if (cut < 0) {
    // One line so far. It is a self-note only if it is the whole first line and more follows, so
    // it can be shown once it is long, speaks to them, or announces a move with a colon.
    const first = s;
    if (!complete && !(first.length > 110 || NOT_A_NOTE.test(first) || first.includes(":"))) return { hold: true };
  } else {
    // The first line is finished: the same call the reply goes through decides it.
    if (!complete && !s.slice(cut).trim()) return { hold: true };
    text = withoutSelfNote(s).text;
  }
  // A marker on its own last line comes off, as it does from the reply.
  const q = readSilence(text);
  if (q.silent) return complete ? { stop: true } : { hold: true };
  text = q.text;
  if (/NO_REPLY/.test(text)) return { stop: true };
  const g = guardReply(conversationId, text, { extraSources: [purchaseRecordSource(conversationId)] });
  if (g.changed) return { stop: true };
  return { text };
}

/**
 * One turn's drafter. `feed` takes each CLI event; `taken()` takes back anything shown (the said
 * check rejected the finished reply); `end()` takes back what is left once the reply has gone, and
 * stops. `check(text)` is the said check for the finished reply, shared with the piece that matches it.
 */
export function startDraft({ conversationId, log = () => {}, check = checkDraft, emit = (e) => draftEvents.emit("draft", e) }) {
  let msg = null, seq = 0, shownFrom = -1, shown = "", busy = false, again = false, stopped = false;
  // One said check per exact text, shared: the finished reply's own check reuses a piece's, in flight or done.
  const checks = new Map();
  const checkOnce = (text) => {
    if (!checks.has(text)) checks.set(text, Promise.resolve().then(() => check({ conversationId, draft: text, log })).catch(() => ({ ok: true })));
    return checks.get(text);
  };
  const show = (text) => { shown = text ?? ""; emit({ conversationId, text }); };
  const takeBack = () => { if (shown) show(null); shownFrom = -1; };
  const stop = (why) => { if (stopped) return; stopped = true; takeBack(); log({ web_draft_stopped: why, conversation: conversationId }); };

  function pump() {
    if (busy) { again = true; return; }
    return pumping();
  }
  async function pumping() {
    busy = true;
    try {
      do {
        again = false;
        if (stopped || !msg || msg.tool) break;
        const m = msg;
        const upto = m.done ? m.text.length : sentenceEnd(m.text);
        if (upto <= m.tried) break;
        m.tried = upto;
        const shaped = shapeDraft(conversationId, m.text.slice(0, upto), { complete: m.done });
        if (shaped.stop) { stop("floor"); break; }
        if (shaped.hold || shaped.text === shown) continue;
        const v = await checkOnce(shaped.text);
        if (stopped) break;
        if (!v.ok) { stop("said_check"); break; }
        // Still the same message, and still one that has called no tool: only then is it the reply.
        if (msg !== m || m.tool) continue;
        shownFrom = m.n;
        show(shaped.text);
      } while (again || (msg && !msg.tool && (msg.done ? msg.text.length : sentenceEnd(msg.text)) > msg.tried));
    } catch (e) {
      stop(`failed: ${(e?.message ?? String(e)).split("\n")[0].slice(0, 120)}`);
    } finally { busy = false; }
  }

  function feed(e) {
    if (stopped || e?.type !== "stream_event") return;
    const ev = e.event ?? {};
    if (ev.type === "message_start") { msg = { n: ++seq, text: "", tool: false, done: false, tried: 0 }; return; }
    if (!msg) return;
    if (ev.type === "content_block_start" && ev.content_block?.type && ev.content_block.type !== "text" && ev.content_block.type !== "thinking") {
      msg.tool = true;
      if (shownFrom === msg.n) takeBack();
      return;
    }
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { msg.text += ev.delta.text ?? ""; void pump(); return; }
    if (ev.type === "message_delta" && ev.delta?.stop_reason) {
      if (ev.delta.stop_reason === "end_turn") { msg.done = true; void pump(); }
      else { msg.tool = true; if (shownFrom === msg.n) takeBack(); }
    }
  }

  return {
    feed,
    /** The said check for `text` — the very same one a piece of it already started, when there was one. */
    check: (text) => checkOnce(String(text ?? "")),
    taken: () => stop("rewritten"),
    end: () => { stopped = true; takeBack(); },
  };
}
