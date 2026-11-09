// The Page and its receipts, as JSON for the iPhone app (docs/ios-api.md). Every line comes from the rows that
// ARE the work, via the same reads Reason Web's Ongoing and Saved use, scoped to one conversation. Nothing
// here writes a summary or fills a gap: a thing the record doesn't say is null, and no work is an honest empty.
import * as db from "../db.js";
import { clock, config } from "../config.js";
import { BACK_WINDOW_MS, ongoing, findItem, stepsOf } from "../ongoing.js";
import { cleanTitle } from "../itemtitle.js";

const parseJson = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const ALL = (sql, ...a) => db.db.prepare(sql).all(...a);
const ONE = (sql, ...a) => db.db.prepare(sql).get(...a);
const present = (t) => !!ONE("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t);

const CALL_LIVE = new Set(["placing", "dialing", "ringing", "in_progress"]);
const CALL_DONE = new Set(["completed", "voicemail"]);
const CALL_SKIP = new Set(["cancelled", "canceled"]);
const BUY_DONE = new Set(["placed", "partially_placed"]);
const BUY_FAILED = new Set(["failed", "declined", "payment_details_refused", "outcome_unknown"]);
const RUN_DONE = new Set(["completed", "done", "succeeded"]);
const PAID = new Set(["paid", "succeeded"]);
const CURRENCY = "usd";

function callTitle(c, name) {
  return String(c.label ?? "").trim() || cleanTitle(c.goal, { name }) || "A call";
}
const taskIdOfConfirmation = (conv, id) => (id == null ? null : ONE("SELECT task_id FROM confirmations WHERE id = ? AND conversation_id = ?", id, conv)?.task_id ?? null);

function failure(why, didNext) {
  return { why: why || null, did_next: didNext || null };
}

/** A row out of src/ongoing.js as the app gets it: named fields only, never the raw task record. */
function fromOngoing(x, now) {
  const base = { id: `${x.kind}-${x.id}`, kind: x.kind, state: x.state, title: x.title, at: x.due ?? x.started ?? now, started_at: x.started ?? null, private: x.kind === "approval" || x.money === true };
  if (x.kind === "approval") return { ...base, state: "needs_you", ask: { summary: x.title, detail: x.detail ?? null, total: x.total ?? null, rows: x.rows ?? [], money: !!x.money, asked_at: x.at } };
  if (x.state === "needs") return { ...base, state: "needs_you", ask: { summary: x.question ?? x.title, detail: x.tradeoff ?? null, total: null, rows: [], money: false, asked_at: x.asked ?? null } };
  if (x.state === "working") return { ...base, summary: x.detail ?? null, steps: (x.steps ?? []).map(s => ({ text: s.text, state: s.state, at: s.at ?? null })), steps_recorded: !!x.realSteps, calling: !!x.calling };
  if (x.state === "waiting") return { ...base, summary: x.detail ?? null, waiting_on: x.waitingOn ?? null, next_check_at: x.check ?? null };
  if (x.state === "stuck") return { ...base, summary: x.detail ?? null };
  if (x.state === "scheduled") return { ...base, summary: x.description ?? null, next_at: x.next ?? null, every: x.everyLong ?? null, call: !!x.call };
  if (x.state === "ready") return { ...base, finished_at: x.due ?? null, result: { headline: x.result?.headline ?? null, facts: x.result?.facts ?? [], note: x.result?.note ?? null } };
  if (x.state === "failed") return { ...base, finished_at: x.due ?? null, failure: failure(x.why, x.next), nothing_charged: !!x.nothingCharged };
  return base;
}

function loneCalls(conv, name, now) {
  const out = [];
  for (const c of ALL("SELECT * FROM calls WHERE conversation_id = ? AND is_owner = 0 AND task_id IS NULL AND (updated_at >= ? OR state IN ('placing','dialing','ringing','in_progress')) ORDER BY id DESC LIMIT 60", conv, now - BACK_WINDOW_MS)) {
    if (CALL_SKIP.has(c.state)) continue;
    const base = { id: `call-${c.id}`, kind: "call", title: callTitle(c, name), started_at: c.created_at, private: true };
    if (CALL_LIVE.has(c.state)) {
      if (now - c.created_at <= 2 * 60 * 60_000) out.push({ ...base, section: "in_progress", state: "working", at: c.created_at, summary: null, calling: true });
    } else if (CALL_DONE.has(c.state)) {
      out.push({ ...base, section: "done", state: "ready", at: c.ended_at ?? c.updated_at, finished_at: c.ended_at ?? c.updated_at, result: { headline: null, facts: [], note: String(c.summary ?? "").trim() || null } });
    } else {
      out.push({ ...base, section: "failed", state: "failed", at: c.ended_at ?? c.updated_at, finished_at: c.ended_at ?? c.updated_at, failure: failure(String(c.outcome ?? "").trim() || "The call didn't go through.", null), nothing_charged: true });
    }
  }
  return out;
}

function lonePurchases(conv, now) {
  const out = [];
  for (const p of ALL("SELECT * FROM agentcard_purchases WHERE conversation_id = ? AND updated_at >= ? ORDER BY id DESC LIMIT 60", conv, now - BACK_WINDOW_MS)) {
    if (taskIdOfConfirmation(conv, p.confirmation_id) != null) continue;
    const base = { id: `purchase-${p.id}`, kind: "purchase", title: p.merchant || p.what || "A purchase", started_at: p.created_at, private: true };
    if (BUY_DONE.has(p.status)) {
      out.push({ ...base, section: "done", state: "ready", at: p.updated_at, finished_at: p.updated_at, result: { headline: p.what || null, facts: [], note: null }, amount_cents: p.amount_cents, currency: CURRENCY });
    } else if (BUY_FAILED.has(p.status)) {
      const why = p.status === "outcome_unknown" ? "Reason couldn't confirm whether this went through." : p.status === "declined" ? "The card was declined." : "The purchase didn't go through.";
      out.push({ ...base, section: "failed", state: "failed", at: p.updated_at, finished_at: p.updated_at, failure: failure(why, null), nothing_charged: p.status !== "outcome_unknown" && !String(p.order_id ?? "") && !String(p.authorization_id ?? "") });
    } else if (p.status === "awaiting_approval") {
      out.push({ ...base, section: "in_progress", state: "waiting", at: p.updated_at, summary: "Waiting for your approval.", amount_cents: p.amount_cents, currency: CURRENCY });
    }
  }
  return out;
}

function loneRuns(conv, now) {
  if (!present("shop_runs")) return [];
  const out = [];
  for (const r of ALL("SELECT * FROM shop_runs WHERE conversation_id = ? AND (updated_at >= ? OR status = 'running') ORDER BY created_at DESC LIMIT 40", conv, now - BACK_WINDOW_MS)) {
    if (r.status === "cancelled") continue;
    const base = { id: `run-${r.run_id}`, kind: "checkout", title: [r.item, r.store].filter(Boolean).join(" · ") || "A checkout", started_at: r.created_at, private: true };
    if (r.status === "running") out.push({ ...base, section: "in_progress", state: "working", at: r.updated_at, summary: null });
    else if (RUN_DONE.has(r.status)) out.push({ ...base, section: "done", state: "ready", at: r.updated_at, finished_at: r.updated_at, result: { headline: null, facts: [], note: null } });
    else if (r.status === "failed") out.push({ ...base, section: "failed", state: "failed", at: r.updated_at, finished_at: r.updated_at, failure: failure("The checkout stopped before it finished.", null), nothing_charged: !paymentsOf(conv, r.run_id).some(x => PAID.has(x.status)) });
  }
  return out;
}

const paymentsOf = (conv, runId) => (present("shop_payments") ? ALL("SELECT * FROM shop_payments WHERE conversation_id = ? AND run_id = ? ORDER BY id", conv, runId) : []);

const byNewest = (a, b) => (b.at ?? 0) - (a.at ?? 0);

/** The whole Page for one person. All four lists empty means nothing real to show, and `empty` says so. */
export function pageFeed(conversationId, now = clock.now()) {
  const name = db.getAccount(conversationId)?.name || config.ownerName;
  const o = ongoing(conversationId, now);
  const sections = { in_progress: [], done: [], failed: [], open_offers: [] };
  for (const a of o.approvals) sections.open_offers.push(fromOngoing(a, now));
  for (const x of o.items) (x.needs ? sections.open_offers : sections.in_progress).push(fromOngoing(x, now));
  for (const x of o.back) (x.state === "failed" ? sections.failed : sections.done).push(fromOngoing(x, now));
  for (const { section, ...x } of [...loneCalls(conversationId, name, now), ...lonePurchases(conversationId, now), ...loneRuns(conversationId, now)]) sections[section].push(x);
  sections.done.sort(byNewest);
  sections.failed.sort(byNewest);
  return { as_of: now, empty: Object.values(sections).every(l => l.length === 0), sections };
}

// ---------------------------------------------------------------- receipts

function callArtifacts(c) {
  const out = [];
  if (c.recording_state === "stored" && c.recording_file) out.push({ type: "recording", url: `/ios/v1/calls/${c.id}/recording`, seconds: c.recording_seconds ?? null });
  if (String(c.transcript ?? "").trim()) out.push({ type: "transcript", text: c.transcript });
  return out;
}
function confirmationArtifact(conv, id) {
  const c = id == null ? null : db.getConfirmation(conv, id);
  return c?.granted_at ? { type: "approval", summary: c.summary, approved_at: c.granted_at, you_said: c.granted_quote ?? null } : null;
}
function callReceipt(c, name, now) {
  return {
    id: `call-${c.id}`, kind: "call", state: CALL_LIVE.has(c.state) ? "working" : CALL_DONE.has(c.state) ? "ready" : "failed", title: callTitle(c, name), private: true,
    started_at: c.created_at, finished_at: c.ended_at ?? null, summary: String(c.summary ?? "").trim() || null, duration_s: c.duration_s ?? null, as_of: now,
    steps: [], cost: { charged_cents: 0, charged_known: true, currency: CURRENCY, lines: [] }, artifacts: [...callArtifacts(c), confirmationArtifact(c.conversation_id, c.confirmation_id)].filter(Boolean),
  };
}
function purchaseLine(p) {
  return { label: p.merchant || p.what || "Purchase", amount_cents: p.amount_cents, charged: BUY_DONE.has(p.status), status: p.status };
}
function purchaseReceipt(p, conv, now) {
  const cart = parseJson(p.cart_json, {}) ?? {};
  const unknown = p.status === "outcome_unknown";
  const artifacts = [p.order_id || p.retailer_order_id ? { type: "confirmation", order_id: p.retailer_order_id || p.order_id, delivery_window: p.delivery_window || null } : null, confirmationArtifact(conv, p.confirmation_id)].filter(Boolean);
  return {
    id: `purchase-${p.id}`, kind: "purchase", state: BUY_DONE.has(p.status) ? "ready" : BUY_FAILED.has(p.status) ? "failed" : "working", title: p.merchant || p.what || "A purchase", private: true,
    started_at: p.created_at, finished_at: BUY_DONE.has(p.status) || BUY_FAILED.has(p.status) ? p.updated_at : null, summary: p.what || null, as_of: now,
    items: Array.isArray(cart.items) ? cart.items.map(i => ({ name: i.name ?? null, qty: i.qty ?? 1 })) : [],
    steps: [], cost: { charged_cents: BUY_DONE.has(p.status) ? p.amount_cents : unknown ? null : 0, charged_known: !unknown, currency: CURRENCY, lines: [purchaseLine(p)] }, artifacts,
  };
}
function runReceipt(r, conv, now) {
  const pays = paymentsOf(conv, r.run_id);
  const cents = (a) => { const n = Number(a); return Number.isFinite(n) ? Math.round(n * 100) : null; };
  const lines = pays.map(p => ({ label: p.merchant_name || r.store, amount_cents: cents(p.amount), charged: PAID.has(p.status), status: p.status }));
  const unknown = pays.some(p => p.status === "unknown" || p.status === "paying");
  const paid = lines.filter(l => l.charged);
  return {
    id: `run-${r.run_id}`, kind: "checkout", state: r.status === "running" ? "working" : RUN_DONE.has(r.status) ? "ready" : "failed", title: [r.item, r.store].filter(Boolean).join(" · ") || "A checkout", private: true,
    started_at: r.created_at, finished_at: r.status === "running" ? null : r.updated_at, summary: null, as_of: now,
    steps: [], cost: { charged_cents: unknown ? null : paid.reduce((n, l) => n + (l.amount_cents ?? 0), 0), charged_known: !unknown, currency: CURRENCY, lines },
    artifacts: pays.flatMap(p => [p.order_intent_id ? { type: "confirmation", order_id: p.order_intent_id, delivery_window: null } : null, confirmationArtifact(conv, p.confirmation_id)]).filter(Boolean),
  };
}
function taskReceipt(conv, x, name, now) {
  const t = x.task;
  const { steps } = stepsOf(t);
  const calls = ALL("SELECT * FROM calls WHERE conversation_id = ? AND task_id = ? ORDER BY id", conv, t.id);
  const confs = ALL("SELECT id FROM confirmations WHERE conversation_id = ? AND task_id = ? ORDER BY id", conv, t.id).map(r => r.id);
  const buys = confs.flatMap(id => ALL("SELECT * FROM agentcard_purchases WHERE conversation_id = ? AND confirmation_id = ?", conv, id));
  const unknown = buys.some(p => p.status === "outcome_unknown");
  const out = fromOngoing(x, now);
  return {
    ...out, private: out.private || calls.length > 0 || buys.length > 0, as_of: now, steps: steps.map(s => ({ text: s.text, state: s.state, at: s.at ?? null })),
    log: db.taskLog(t.id, 40).filter(l => l.kind === "progress").map(l => ({ text: l.note, at: l.at })),
    cost: { charged_cents: unknown ? null : buys.filter(p => BUY_DONE.has(p.status)).reduce((n, p) => n + p.amount_cents, 0), charged_known: !unknown, currency: CURRENCY, lines: buys.map(purchaseLine) },
    artifacts: [
      ...calls.flatMap(c => callArtifacts(c).map(a => ({ ...a, call_id: `call-${c.id}`, call_title: callTitle(c, name) }))),
      ...confs.map(id => confirmationArtifact(conv, id)).filter(Boolean),
      ...buys.filter(p => p.order_id || p.retailer_order_id).map(p => ({ type: "confirmation", order_id: p.retailer_order_id || p.order_id, delivery_window: p.delivery_window || null })),
    ],
  };
}

/** One item's receipt, in this conversation only. Null when it isn't theirs or isn't there. */
export function receipt(conversationId, id, now = clock.now()) {
  const m = /^(task|timer|series|approval|call|purchase|run)-([A-Za-z0-9_-]{1,64})$/.exec(String(id ?? ""));
  if (!m) return null;
  const [, kind, raw] = m;
  const name = db.getAccount(conversationId)?.name || config.ownerName;
  if (kind === "run") {
    const r = present("shop_runs") ? ONE("SELECT * FROM shop_runs WHERE run_id = ? AND conversation_id = ?", raw, conversationId) : null;
    return r ? runReceipt(r, conversationId, now) : null;
  }
  if (!/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  if (kind === "call") { const c = db.getCall(conversationId, n); return c ? callReceipt(c, name, now) : null; }
  if (kind === "purchase") { const p = ONE("SELECT * FROM agentcard_purchases WHERE id = ? AND conversation_id = ?", n, conversationId); return p ? purchaseReceipt(p, conversationId, now) : null; }
  const x = findItem(conversationId, kind, n, now);
  if (!x) return null;
  if (kind === "task") return taskReceipt(conversationId, x, name, now);
  return { ...fromOngoing(x, now), as_of: now, steps: [], cost: { charged_cents: 0, charged_known: true, currency: CURRENCY, lines: [] }, artifacts: [] };
}

/** A cheap fingerprint of everything the Page is drawn from. Different means: draw it again. */
export function fingerprint(conv) {
  const q = (sql) => JSON.stringify(ONE(sql, conv));
  const parts = [
    q("SELECT COUNT(*) n, MAX(updated_at) m, SUM(updated_at) s FROM tasks WHERE conversation_id = ?"),
    q("SELECT COUNT(*) n FROM task_log l JOIN tasks t ON t.id = l.task_id WHERE t.conversation_id = ?"),
    q("SELECT COUNT(*) n, SUM(COALESCE(granted_at,0)+COALESCE(refused_at,0)+COALESCE(consumed_at,0)) s FROM confirmations WHERE conversation_id = ?"),
    q("SELECT COUNT(*) n, SUM(fire_at+COALESCE(fired_at,0)+COALESCE(cancelled_at,0)) s FROM timers WHERE conversation_id = ?"),
    q("SELECT COUNT(*) n, SUM(COALESCE(next_at,0)), SUM(state = 'active') a FROM series WHERE conversation_id = ?"),
    q("SELECT COUNT(*) n, MAX(updated_at) m, SUM(updated_at) s FROM calls WHERE conversation_id = ?"),
    q("SELECT COUNT(*) n, MAX(updated_at) m, SUM(updated_at) s FROM agentcard_purchases WHERE conversation_id = ?"),
  ];
  if (present("shop_runs")) parts.push(q("SELECT COUNT(*) n, MAX(updated_at) m, SUM(updated_at) s FROM shop_runs WHERE conversation_id = ?"));
  return parts.join("|");
}
