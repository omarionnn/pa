// Reason Web, each earlier Web-only chat's short title, for Chat history (src/pages/webhistory.js).
// Web-only chats were retired by the owner 10-27 07:08 (one shared thread only), so nothing starts a new
// one and GET /web/chats/recent is gone; the ones already made stay readable, titled as below.
//
// The title is written ONCE, when the chat's first reply lands: one cheap summarise on the claude-cli
// subscription path (never the billed API), or the first words of their first message when the CLI is
// not the backend or the summarise fails. A later reply never retitles it.
import * as db from "./db.js";
import { askStructured, sideAskAllowed } from "./backends/side.js";
import { normTitle } from "./itemtitle.js";

const FALLBACK_WORDS = 6, FALLBACK_CHARS = 48;
export const UNTITLED = "A Web chat";

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** The fallback title: the first few words of their first message, or UNTITLED when it had none (a photo). */
export function fallbackTitle(first) {
  const t = oneLine(first);
  if (!t) return UNTITLED;
  return cut(t.split(" ").slice(0, FALLBACK_WORDS).join(" "), FALLBACK_CHARS);
}

// ---------------------------------------------------------------- the title, once

const SYSTEM = `You name one chat in a person's chat list. You are given how the chat opened: their first message and the assistant's first reply.
Reply with a title for the person to read in their own list: 2 to 5 words, plain, the thing itself, the way they would name it.
Examples: "Saturday plans", "Lease questions", "Gift for Ama", "Flights to Accra".
Never use their name. No quotes, no dates, no punctuation at the end.`;
const SCHEMA = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };

let testAsk = null;
/** For tests: the stand-in for the model summarise (null puts the real path back). */
export function setTitleAsk(f) { testAsk = f; }

/** One title from the model (src/backends/side.js), or null (no model, under the test runner, or anything went wrong). */
async function modelTitle({ first, reply, name }) {
  const ask = testAsk ?? askStructured;
  if (ask === askStructured && (!sideAskAllowed() || process.env.REASON_WEB_CHAT_TITLES === "0")) return null;
  const { value, error } = await ask({
    prompt: `Their first name, which must NOT appear: ${String(name ?? "").trim().split(/\s+/)[0] || "(unknown)"}\n\nTheir first message:\n${String(first ?? "").slice(0, 600)}\n\nThe first reply:\n${String(reply ?? "").slice(0, 600)}`,
    system: SYSTEM,
    schema: SCHEMA,
    model: process.env.REASON_TITLE_CLI_MODEL || "sonnet",
    timeoutMs: 45_000,
    feature: "chat_title",
  });
  return error ? null : normTitle(value?.title, { name });
}

const titling = new Set();
let chain = Promise.resolve();

/**
 * Title chat `chat` of `conversationId` if nothing has yet. Never throws, never blocks the caller;
 * one summarise at a time. Returns the promise of it, or null when there is nothing to do.
 */
export function titleWebChat(conversationId, chat) {
  const row = db.db.prepare("SELECT conversation_id, title FROM web_chats WHERE id = ?").get(String(chat ?? ""));
  if (!row || row.conversation_id !== conversationId || row.title || titling.has(chat)) return null;
  titling.add(chat);
  chain = chain.then(async () => {
    try {
      const line = (role) => db.db.prepare(`SELECT text FROM messages WHERE conversation_id = ? AND chat_id = ? AND role = ? AND deleted_at IS NULL
        ORDER BY at, id LIMIT 1`).get(conversationId, chat, role)?.text ?? "";
      const first = line("user");
      const name = db.getAccount(conversationId)?.name ?? "";
      let title = null;
      try { title = await modelTitle({ first, reply: line("assistant"), name }); } catch { /* the fallback below */ }
      // The fallback keeps the same rule as the model's: never their own name.
      const fallback = fallbackTitle(first);
      title ||= fallback === UNTITLED ? UNTITLED : normTitle(fallback, { name }) ? fallback : UNTITLED;
      db.db.prepare("UPDATE web_chats SET title = ? WHERE id = ? AND conversation_id = ? AND title IS NULL").run(title, chat, conversationId);
    } catch { /* a title is never worth an error */ } finally { titling.delete(chat); }
  });
  return chain;
}

/** For tests: the queue, emptied. */
export function resetChatTitles() { titling.clear(); chain = Promise.resolve(); testAsk = null; }

// A reply landing in a Web chat (its history row, src/db.js writeMessage) is what titles it.
db.setWebChatReplyHook((conversationId, chat) => titleWebChat(conversationId, chat));
