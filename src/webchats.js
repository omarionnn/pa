// Reason Web, recent Web-only chats (owner 10-27 01:58): what Home's composer will offer on hover/focus
// (the panel itself is the UI agent's, SCOPE-v2 Q-v2-51), and each chat's short title.
//
//   GET /web/chats/recent  → { chats: [{ id, title, preview, updatedAt, needsYou, working }] }
//
// The session's own conversation only, newest first, at most RECENT_LIMIT. `needsYou`: an approval
// asked in that chat (confirmations.thread_key) is still open. `working`: a turn for that chat is
// running (src/onethought.js) or its message is still held to be taken (pending_inbound).
//
// The title is written ONCE, when the chat's first reply lands: one cheap summarise on the claude-cli
// subscription path (never the billed API), or the first words of their first message when the CLI is
// not the backend or the summarise fails. A later reply never retitles it.
import * as db from "./db.js";
import { config, clock } from "./config.js";
import { askStructuredViaCli } from "./backends/cli.js";
import { normTitle } from "./itemtitle.js";
import * as onethought from "./onethought.js";
import { APPROVAL_WINDOW_MS } from "./ongoing.js";

export const RECENT_LIMIT = 5;
export const PREVIEW_MAX = 80;
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

/** A message as the preview line: one line, at most PREVIEW_MAX characters. */
export const previewOf = (text) => cut(oneLine(text), PREVIEW_MAX);

/** This conversation's latest Web chats, most recently used first. Never anybody else's. */
export function recentChats(conversationId, { now = clock.now(), limit = RECENT_LIMIT } = {}) {
  if (!conversationId) return [];
  const rows = db.db.prepare(`SELECT c.id, c.title, c.last_at,
      (SELECT text FROM messages f WHERE f.conversation_id = c.conversation_id AND f.chat_id = c.id AND f.deleted_at IS NULL AND f.role = 'user' ORDER BY f.at, f.id LIMIT 1) AS first,
      (SELECT text FROM messages l WHERE l.conversation_id = c.conversation_id AND l.chat_id = c.id AND l.deleted_at IS NULL AND TRIM(l.text) <> '' ORDER BY l.at DESC, l.id DESC LIMIT 1) AS last
    FROM web_chats c
    WHERE c.conversation_id = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.conversation_id AND m.chat_id = c.id AND m.deleted_at IS NULL)
    ORDER BY c.last_at DESC, c.created_at DESC, c.id LIMIT ?`).all(conversationId, limit);
  const turn = onethought.activeFor(conversationId);
  const asking = db.db.prepare(`SELECT 1 FROM confirmations WHERE conversation_id = ? AND thread_key = ?
    AND granted_at IS NULL AND refused_at IS NULL AND consumed_at IS NULL AND asked_at > ? AND TRIM(COALESCE(summary, '')) <> '' LIMIT 1`);
  const held = db.db.prepare("SELECT 1 FROM pending_inbound WHERE conversation_id = ? AND channel = 'web' AND chat_id = ? LIMIT 1");
  return rows.map(r => ({
    id: r.id,
    title: r.title || fallbackTitle(r.first),
    preview: previewOf(r.last),
    updatedAt: r.last_at,
    needsYou: !!asking.get(conversationId, `${conversationId}#web:${r.id}`, now - APPROVAL_WINDOW_MS),
    working: (turn?.webChat ?? null) === r.id || !!held.get(conversationId, db.webChatRoute(r.id)),
  }));
}

// ---------------------------------------------------------------- the title, once

const SYSTEM = `You name one chat in a person's chat list. You are given how the chat opened: their first message and the assistant's first reply.
Reply with a title for the person to read in their own list: 2 to 5 words, plain, the thing itself, the way they would name it.
Examples: "Saturday plans", "Lease questions", "Gift for Ama", "Flights to Accra".
Never use their name. No quotes, no dates, no punctuation at the end.`;
const SCHEMA = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };

let testAsk = null;
/** For tests: the stand-in for the claude-cli summarise (null puts the real path back). */
export function setTitleAsk(f) { testAsk = f; }

/** One title from the claude-cli subscription, or null (not the backend, under the test runner, or anything went wrong). */
async function modelTitle({ first, reply, name }) {
  const ask = testAsk ?? askStructuredViaCli;
  if (ask === askStructuredViaCli && (process.env.REASON_BACKEND !== "claude-cli" || process.env.NODE_TEST_CONTEXT || process.env.REASON_WEB_CHAT_TITLES === "0")) return null;
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
      let title = null;
      try { title = await modelTitle({ first, reply: line("assistant"), name: db.getAccount(conversationId)?.name ?? config.ownerName }); } catch { /* the fallback below */ }
      db.db.prepare("UPDATE web_chats SET title = ? WHERE id = ? AND conversation_id = ? AND title IS NULL").run(title || fallbackTitle(first), chat, conversationId);
    } catch { /* a title is never worth an error */ } finally { titling.delete(chat); }
  });
  return chain;
}

/** For tests: the queue, emptied. */
export function resetChatTitles() { titling.clear(); chain = Promise.resolve(); testAsk = null; }

// A reply landing in a Web chat (its history row, src/db.js writeMessage) is what titles it.
db.setWebChatReplyHook((conversationId, chat) => titleWebChat(conversationId, chat));
