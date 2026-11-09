// Writing to Reason from the app. A message goes in by the same door as Reason Web's (Router.deliver on the
// `web` channel), so it is the same turn as a text: admission, the paywall, confirmations, Face ID and the spend
// limit are all decided further down and nothing here can skip them. The reply lands in the per-message history,
// which the live stream reads. The conversation is always the token's; a client can't name one.
import * as db from "../db.js";
import { clock } from "../config.js";
import { WEB } from "../web.js";
import { MAX_TEXT, ACK_WAIT_MS, underLimit } from "../pages/webconvo.js";

export const MAX_PAGE = 100;

/** One history row as the app gets it: named fields only. */
export function messageOut(row, conv) {
  const ext = String(row.external_id ?? "");
  const prefix = `${conv}:`;
  const media = Array.isArray(row.media) ? row.media : [];
  return {
    id: row.id, role: row.role === "user" ? "user" : "reason", text: String(row.text ?? ""), at: row.at,
    via: row.channel === WEB ? "app_or_web" : "text",
    client_id: row.role === "user" && row.channel === WEB && ext.startsWith(prefix) ? ext.slice(prefix.length) : null,
    attachments: media.map(m => ({ name: m?.filename ?? null })),
  };
}

const pageSize = (v) => Math.min(MAX_PAGE, Math.max(1, /^\d{1,4}$/.test(String(v ?? "")) ? Number(v) : 50));
const idOf = (v) => (/^\d{1,15}$/.test(String(v ?? "")) ? Number(v) : null);

/** `after`: what came since, oldest first (catching up). Otherwise the newest page, or the page before `before`. */
export function listMessages(conv, query = {}) {
  const limit = pageSize(query.limit), after = idOf(query.after);
  const rows = after != null ? db.messagesFor(conv, { after, limit }) : db.latestMessagesFor(conv, { before: idOf(query.before) ?? undefined, limit });
  return { messages: rows.map(r => messageOut(r, conv)) };
}

/** POST /messages. Answers as soon as the message is taken; the turn runs on and its reply arrives over /live. */
export async function sendMessage({ account, body, router, log = () => {}, ackWaitMs = ACK_WAIT_MS }) {
  const id = String(body?.id ?? "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return { status: 400, error: "bad_id" };
  const text = String(body?.text ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!text.trim()) return { status: 400, error: "empty" };
  if (text.length > MAX_TEXT) return { status: 413, error: "too_long" };
  if (!router) return { status: 503, error: "unavailable" };
  const conv = account.conversation_id;
  if (!underLimit(conv)) { log({ ios_send_refused: "rate_limited" }); return { status: 429, error: "slow_down" }; }
  const delivering = Promise.resolve()
    .then(() => router.deliver({ channel: WEB, externalId: id, conversationId: conv, text, at: clock.now() }))
    .catch((e) => { log({ ios_send_failed: (e?.message ?? String(e)).split("\n")[0] }); return { ok: false, error: "failed" }; });
  const quick = await Promise.race([delivering, new Promise(r => { const t = setTimeout(() => r(null), ackWaitMs); t.unref?.(); })]);
  log({ ios_send: quick ? (quick.duplicate ? "duplicate" : quick.refused ?? (quick.ok === false ? "failed" : "done")) : "accepted" });
  if (quick?.refused) return { status: 403, error: "refused" };
  if (quick?.ok === false) return { status: 500, error: "failed" };
  return { status: 200, id, duplicate: !!quick?.duplicate };
}
