// Connect the rest, once, after it has paid off (owner 11-11, REASON_CONNECT_AFTER = owner | on | off).
//
// Nothing is connected up front any more: no connect screen on heyreason.com/start, no Amazon offer in
// the first chat. A service is connected the moment a task needs it, with that service's own link
// (google_connect, signin_link, shop_card; src/agent.js says so). Then, after the FIRST task that
// needed a new connection has actually worked (the connection took AND the task did what it was for:
// mail read, order placed), Reason sends one short line and a link to a page where the rest can be
// connected, "so you don't have to be repeatedly asked".
//
//   once per person, ever (connect_after.sent_at, claimed before the send);
//   never when everything offered is already connected (recorded, so never later either);
//   never on a failed turn, never while a checkout of theirs is still running (mid-task);
//   never for what was connected before this shipped: the first turn this sees takes a baseline,
//   and only a service connected after it counts.
//
// "Worked" is read off the record, never off the model's words:
//   email  a gmail_/calendar_/drive_ tool that came back ok, after the Google grant
//   amazon a checkout on Amazon that reached `placed`, after the store sign-in (a page merely opened on
//          amazon is not an order)
//   card   a checkout that reached `placed`, after the card was saved
//
// The page (GET /web/connect-all/{token}): each service with ✓ or a button. The button POSTs to
// …/go/{service}, which makes that service's own link for this person right then and sends the
// browser to it: Google's start page (src/connectgate.js, proved by the code gate), the card page
// (src/pages/webconnect.js), Amazon's sign-in in Reason's browser (src/amazonconnect.js).
import { createHash, randomBytes } from "node:crypto";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import * as shop from "./shopconnect.js";
import * as amazon from "./amazonconnect.js";
import { googleStatus, authorizeUrl as googleAuthorizeUrl } from "./google.js";
import { clock } from "./config.js";

export const LINE = "nice, that worked. so i don't have to keep asking you one thing at a time, you can connect the rest here whenever";
export const LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// A task that worked longer ago than this is not "just now": the line would land out of the blue.
export const FRESH_MS = 6 * 60 * 60 * 1000;
export const SERVICES = ["email", "amazon", "card"];
export const LABELS = { email: "Email", amazon: "Amazon", card: "Card" };
const WHAT = {
  email: "your gmail and calendar, so i can read what matters and keep an eye on it",
  amazon: "your amazon, so i can track orders and reorder things",
  card: "a card for checkouts. nothing is ever bought without your yes",
};

export function mode() {
  const v = String(process.env.REASON_CONNECT_AFTER ?? "").trim().toLowerCase();
  return v === "owner" ? "owner" : ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}
export function allowedFor(conversationId) {
  if (!conversationId || String(conversationId).startsWith("websetup:")) return false;
  const m = mode();
  if (m === "owner") return accounts.featureOwner(conversationId);
  return m === "on";
}

const q = (sql) => db.db.prepare(sql);
db.db.exec(`
  CREATE TABLE IF NOT EXISTS connect_after (
    conversation_id TEXT PRIMARY KEY,
    baseline TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    outcome TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS connect_after_uses (
    conversation_id TEXT NOT NULL,
    service TEXT NOT NULL,
    ok_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, service)
  );
  CREATE TABLE IF NOT EXISTS connect_after_links (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// ---------------------------------------------------------------- what is connected, and offered
const crossmintOn = () => !!process.env.CROSSMINT_CLIENT_KEY && !!process.env.CROSSMINT_SERVER_KEY;

/** Each service's connected-at for this person (ms), or null when it is not connected. */
export function connectedAt(conversationId) {
  const google = db.listOauthTokens(conversationId, "google");
  const store = shop.connectedStores(conversationId).find((s) => s.store === "amazon");
  let ownBrowser = null;
  if (amazon.connected(conversationId)) {
    const row = db.lastSigninCheck(conversationId, "amazon");
    ownBrowser = row?.connected_at ?? row?.checked_at ?? 0;
  }
  const card = shop.cardOf(conversationId);
  const min = (...xs) => { const v = xs.filter((x) => x != null); return v.length ? Math.min(...v) : null; };
  return {
    email: google.length ? min(...google.map((r) => r.connected_at ?? 0)) : null,
    amazon: min(store?.connectedAt ?? null, ownBrowser),
    card: card ? (card.savedAt ?? 0) : null,
  };
}

/** The services this person could connect at all, right now (no Google app, no Crossmint, no Amazon → not offered). */
export function offered(conversationId) {
  const now = connectedAt(conversationId);
  const out = [];
  if (googleStatus().connected || now.email != null) out.push("email");
  if (now.amazon != null || amazon.available(conversationId) || (shop.connectAllowedFor(conversationId) && crossmintOn())) out.push("amazon");
  if (now.card != null || (shop.connectAllowedFor(conversationId) && crossmintOn())) out.push("card");
  return out;
}

const connectedSet = (conversationId) => Object.entries(connectedAt(conversationId)).filter(([, v]) => v != null).map(([k]) => k);

// ---------------------------------------------------------------- the record
const rowOf = (c) => q("SELECT * FROM connect_after WHERE conversation_id = ?").get(c) ?? null;

/** Before a turn: the first time this person is seen, what they already have is the baseline. */
export function beforeTurn(conversationId) {
  if (!allowedFor(conversationId)) return;
  try {
    q("INSERT OR IGNORE INTO connect_after (conversation_id, baseline, created_at) VALUES (?, ?, ?)")
      .run(conversationId, connectedSet(conversationId).join(","), clock.now());
  } catch { /* never in the way of a turn */ }
}

/** A use of a service that worked. Cheap, and recorded for everyone the flag reaches. */
export function noteUse(conversationId, service, at = clock.now()) {
  if (!conversationId || !SERVICES.includes(service) || !allowedFor(conversationId)) return;
  try {
    q(`INSERT INTO connect_after_uses (conversation_id, service, ok_at) VALUES (?, ?, ?)
       ON CONFLICT(conversation_id, service) DO UPDATE SET ok_at = excluded.ok_at`).run(conversationId, service, at);
  } catch { /* best effort */ }
}

const okResult = (out) => !!out && typeof out === "object" && !Array.isArray(out) && out.ok !== false && !out.error && !out.blocked;

/** Every tool result passes here (src/tools.js): the ones that prove a connection did its job. */
export function noteTool(conversationId, name, input, out) {
  if (!conversationId || !okResult(out)) return;
  const n = String(name);
  if (/^(gmail_|calendar_|drive_)/.test(n)) return noteUse(conversationId, "email");
}

/** A checkout reached `placed` (src/shopconnect.js setStage): the store and the card both did their job. */
export function notePlaced(run) {
  if (!run?.conversation_id || !allowedFor(run.conversation_id)) return;
  if (run.store === "amazon") noteUse(run.conversation_id, "amazon");
  noteUse(run.conversation_id, "card");
  // An order is usually placed in the background, after the turn that started it. Check again once the
  // checkout's own "it's placed" text has gone, rather than on whatever they text next, days later.
  if (lastRouter) {
    const t = setTimeout(() => { afterTurn({ conversationId: run.conversation_id, router: lastRouter, log: lastLog }).catch(() => {}); }, PLACED_DELAY_MS);
    t.unref?.();
  }
}
export const PLACED_DELAY_MS = 20_000;
let lastRouter = null;
let lastLog = () => {};
shop.onPlaced(notePlaced);

/**
 * What to do after this turn, as data (tests read it): "send", or why not. A service counts when it
 * was connected after the baseline and a use of it worked at or after it was connected.
 */
export function decide(conversationId, { failed = false } = {}) {
  if (!allowedFor(conversationId)) return { act: "none", why: "off" };
  const row = rowOf(conversationId);
  if (!row) return { act: "none", why: "no_baseline" };
  if (row.sent_at) return { act: "none", why: "already" };
  const base = new Set(String(row.baseline).split(",").filter(Boolean));
  const at = connectedAt(conversationId);
  const uses = Object.fromEntries(q("SELECT service, ok_at FROM connect_after_uses WHERE conversation_id = ?").all(conversationId).map((r) => [r.service, r.ok_at]));
  const now = clock.now();
  const won = SERVICES.find((s) => !base.has(s) && at[s] != null && uses[s] != null && uses[s] >= at[s] && now - uses[s] <= FRESH_MS);
  if (!won) return { act: "none", why: "no_task_yet" };
  if (failed) return { act: "none", why: "turn_failed" };
  if (q("SELECT 1 AS x FROM shop_runs WHERE conversation_id = ? AND status = 'running' LIMIT 1").get(conversationId)) return { act: "none", why: "mid_task" };
  const missing = offered(conversationId).filter((s) => at[s] == null);
  if (!missing.length) return { act: "close", why: "all_connected", service: won };
  return { act: "send", service: won, missing };
}

// ---------------------------------------------------------------- the link
const hash = (t) => createHash("sha256").update(String(t)).digest("base64url");
const siteBase = () => (process.env.REASON_SITE_URL || process.env.REASON_PUBLIC_URL || "https://heyreason.com").replace(/\/+$/, "");
export function createLink(conversationId, { now = clock.now() } = {}) {
  const token = randomBytes(24).toString("base64url");
  q("INSERT INTO connect_after_links (id, conversation_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hash(token), conversationId, now, now + LINK_TTL_MS);
  return { token, url: `${siteBase()}/web/connect-all/${token}` };
}
export function linkFor(token, { now = clock.now() } = {}) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token ?? ""))) return null;
  const r = q("SELECT * FROM connect_after_links WHERE id = ?").get(hash(token));
  return r && r.expires_at > now ? r : null;
}

// ---------------------------------------------------------------- after the turn
/**
 * From the router, after a turn that replied (never mid-turn). Claims the row before sending, so two
 * drains at once cannot say it twice; one bubble, then the link on its own.
 */
export async function afterTurn({ conversationId, router = null, failed = false, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (router) { lastRouter = router; lastLog = log; }
  const d = decide(conversationId, { failed });
  if (d.act === "close") {
    q("UPDATE connect_after SET sent_at = ?, outcome = 'all_connected' WHERE conversation_id = ? AND sent_at IS NULL").run(clock.now(), conversationId);
    log({ connect_after: conversationId, outcome: "all_connected", after: d.service });
    return d;
  }
  if (d.act !== "send") return d;
  const claimed = q("UPDATE connect_after SET sent_at = ?, outcome = 'sending' WHERE conversation_id = ? AND sent_at IS NULL").run(clock.now(), conversationId).changes;
  if (!claimed) return { act: "none", why: "already" };
  const { url } = createLink(conversationId);
  const account = db.getAccount(conversationId);
  const thread = db.getThread?.(conversationId) ?? null;
  const bubbles = [LINE, url];
  let sent = 0;
  if (router?.send && account?.channel && account.channel !== "console") {
    for (const [i, text] of bubbles.entries()) {
      if (i) await sleep(900);
      const r = await router.send({
        channel: account.channel, to: account.address, chatId: thread?.chat_id ?? null, text,
        conversationId, toOwner: true, idempotencyKey: `connectafter:${conversationId}#${i + 1}`,
      }).catch((e) => ({ ok: false, error: e?.message }));
      if (r?.ok === false) break;
      sent++;
    }
  }
  if (!sent) {
    // Nothing went (the channel refused, no channel): let a later turn try again, and say nothing in history.
    q("UPDATE connect_after SET sent_at = NULL, outcome = 'held' WHERE conversation_id = ?").run(conversationId);
    log({ connect_after: conversationId, outcome: "held", after: d.service });
    return { ...d, act: "held", sent };
  }
  q("UPDATE connect_after SET outcome = ? WHERE conversation_id = ?").run(sent === bubbles.length ? `sent:${d.service}` : `partial:${sent}`, conversationId);
  try {
    const messages = db.loadConversation(conversationId);
    messages.push({ role: "assistant", content: bubbles.slice(0, sent).join("\n\n") });
    db.saveConversation(conversationId, messages);
  } catch { /* the history is best effort */ }
  log({ connect_after: conversationId, outcome: "sent", after: d.service, missing: d.missing.join(","), bubbles: sent });
  return { ...d, sent, url };
}

// ---------------------------------------------------------------- one service's own link
const AMAZON_NOTE = "They connected Amazon from the connect-the-rest page you sent; nothing is waiting on it. Say in one short line that amazon is connected now, nothing more.";

/** Make that service's own link for this person, now. { ok, url } or { ok: false, why }. */
export function serviceLink(conversationId, service) {
  const at = connectedAt(conversationId);
  if (!offered(conversationId).includes(service)) return { ok: false, why: "unavailable" };
  if (at[service] != null) return { ok: false, why: "connected" };
  if (service === "email") { const o = googleAuthorizeUrl(conversationId); return o.ok ? { ok: true, url: o.url } : { ok: false, why: "unavailable" }; }
  if (service === "card") return { ok: true, url: shop.cardLinkUrl(conversationId) };
  if (service === "amazon") {
    const o = amazon.connectLink(conversationId, { via: "connect_after", afterSignedIn: AMAZON_NOTE });
    return o.ok ? { ok: true, url: o.url } : { ok: false, why: o.why || "unavailable" };
  }
  return { ok: false, why: "unknown" };
}

export const pageView = (conversationId) => {
  const at = connectedAt(conversationId);
  return offered(conversationId).map((s) => ({ service: s, label: LABELS[s], what: WHAT[s], connected: at[s] != null }));
};
