// The brain test line (docs/calls-brain-first.md "Test line"): a second process, apart from the live service,
// that a Cartesia Line agent asks for every sentence on a test number's calls. It reads the owner's memory
// READ-ONLY (REASON_DB_READONLY=1: src/db.js, src/restcrypt.js), acts on nothing, sends nothing, and talks
// only to the owner's own registered number with the carrier's top attestation. Every other caller hears one
// fixed line and is hung up on, and nothing about anyone is loaded for that call.
//
// Routes (all POST, all behind `Authorization: Bearer <secret>`; anything else is 404):
//   /brain-test/start    { call_id, from, attest?, metadata? } -> { ok, greeting } | { ok: false, say, end: true }
//   /brain-test/turn     { call_id, history: [{ role, content }] } -> NDJSON events (say / end_call / done)
//   /brain-test/end      { call_id, agent_call_id? } -> { ok }; the call's audio and transcript at Cartesia are deleted
//   /brain-test/selftest {} -> NDJSON of a stand-in turn: no model, no memory read
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
import { config } from "../config.js";
import * as accounts from "../accounts.js";
import { attestOf } from "./calltrust.js";
import * as bf from "./brainfirst.js";
import * as op from "./brainopener.js";
import { classify } from "./brainopener.js";

export const PRIVATE_LINE = "This is a private test line.";
export const GREETING = "Hey, it's Reason, on the test line. What's up?";
/** What the test line says when the turn needs the full brain: it cannot do, look up or check things. */
export const CANNOT = {
  act: "This test line can't do things yet. I've noted it, so ask me by text and I'll take care of it there.",
  done: "I can't check what's been done from this test line. Ask me by text and I'll look.",
  lookup: "I can't look that up on this test line yet. Ask me by text and I'll find it.",
};

/** The variants (state/variant.json `{ "variant": "ii" }`, read at each call's start; no restart). */
export const VARIANTS = {
  i: { model: "claude-haiku-5-5", openers: false, label: "fast model, no opener" },
  ii: { model: "claude-haiku-5-5", openers: true, label: "fast model + opener bank" },
  iii: { model: "claude-opus-5-5", openers: true, label: "sharper model + opener bank" },
};
export const DEFAULT_VARIANT = "ii";
export function variantNow(path = process.env.BRAIN_TEST_VARIANT_FILE) {
  try {
    const v = String(JSON.parse(readFileSync(path, "utf8"))?.variant ?? "").trim().toLowerCase();
    if (VARIANTS[v]) return { id: v, ...VARIANTS[v] };
  } catch { /* the default */ }
  return { id: DEFAULT_VARIANT, ...VARIANTS[DEFAULT_VARIANT] };
}

/** The gate mode: "attested" (the owner's number AND attestation A) or "number" (the owner's number only). */
export const gateMode = (path = process.env.BRAIN_TEST_VARIANT_FILE) => {
  try { return JSON.parse(readFileSync(path, "utf8"))?.gate === "number" ? "number" : "attested"; } catch { return "attested"; }
};

/** The attestation a call came with: an explicit field, else a STIR/SHAKEN-looking value in its metadata. */
export function attestationOf(body = {}) {
  if (body.attest) return String(body.attest);
  for (const [k, v] of Object.entries(body.metadata ?? {})) if (/verstat|attest|stir|shaken/i.test(k)) return String(v ?? "");
  return "";
}

/**
 * Who may use the line: the owner's registered number (the operator numbers) with attestation A. In "number"
 * mode, the number alone (a decision for the owner: Cartesia numbers may not pass attestation on).
 */
export function gate(body = {}, { mode = gateMode(), isOwner = (n) => accounts.isOperatorAddress(n) } = {}) {
  const from = String(body.from ?? "").replace(/[^\d+]/g, "");
  if (!/^\+\d{8,15}$/.test(from) || !isOwner(from)) return { ok: false, why: "not_owner" };
  const att = attestOf(attestationOf(body));
  if (mode === "attested" && att !== "a") return { ok: false, why: `attestation_${att}` };
  if (att === "other") return { ok: false, why: "attestation_other" };
  return { ok: true };
}

/** The honest line for a turn that would need the full brain, and a note of the ask (local file, mode 600). */
export function cannotFor(messages = [], { notes = process.env.BRAIN_TEST_NOTES_FILE, callId = "" } = {}) {
  const ask = String([...messages].reverse().find(m => m.role === "user")?.content ?? "").replace(/^\(|\)$/g, "");
  const kind = bf.asksIfDone(ask) ? "done" : ["request"].includes(classify(ask)) || bf.needsFullBrain(ask) ? "act" : "lookup";
  if (notes && kind === "act") { try { appendFileSync(notes, JSON.stringify({ at: new Date().toISOString(), call: callId, ask: ask.slice(0, 300) }) + "\n", { mode: 0o600 }); } catch { /* the line is still honest */ } }
  return { text: CANNOT[kind], kind };
}

/** Bearer check, constant time; a secret shorter than 32 characters never matches. */
export function bearerOk(header, secret) {
  const want = String(secret ?? "");
  const got = String(header ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(want);
  return want.length >= 32 && a.length === b.length && timingSafeEqual(a, b);
}

/** The calls on the line now: call_id -> { row, variant, session }. Nothing is kept after /end. */
const calls = new Map();
export const liveCalls = () => calls.size;

/** A call row for the brain: the owner's conversation, never written anywhere (the database is read-only). */
function rowFor(callId) {
  return { id: -Math.abs(Date.now() % 1e9), external: callId, conversation_id: config.ownerConversation, is_owner: 1, direction: "in", provider: "brain-test", created_at: Date.now(), facts: [] };
}

/**
 * One request. `deps` are injectable for tests: the brain (open/turn), the deleter, the clock.
 * Returns { status, headers, body } or { status, headers, stream }.
 */
export async function handle({ method, path, headers = {}, rawBody = "", secret, deps = {} }) {
  const { open = bf.openBrain, turn = bf.brainTurn, deleteCall = deleteCartesiaCall, log = () => {}, gateOpts = {} } = deps;
  if (method !== "POST" || !String(path).startsWith("/brain-test/")) return { status: 404, body: "not found" };
  if (!bearerOk(headers.authorization, secret)) return { status: 401, body: "unauthorized" };
  let body;
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { return { status: 400, body: "bad json" }; }
  const json = (o, status = 200) => ({ status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
  const ndjson = (gen) => ({ status: 200, headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" }, stream: (async function* () { for await (const ev of gen) yield JSON.stringify(ev) + "\n"; })() });
  const callId = String(body.call_id ?? "");

  if (path === "/brain-test/start") {
    const g = gate(body, gateOpts);
    // Refused: nothing about anyone is loaded, and the call is not kept.
    // Key names only (never values or the number), so one refused call shows whether Cartesia passes attestation on.
    if (!g.ok) { log({ brain_test_refused: g.why, metadata_keys: Object.keys(body.metadata ?? {}).slice(0, 20) }); return json({ ok: false, say: PRIVATE_LINE, end: true }); }
    if (!callId) return json({ ok: false, say: PRIVATE_LINE, end: true });
    const variant = variantNow();
    const row = rowFor(callId);
    calls.set(callId, { row, variant, session: open(row, { log, model: variant.model }), recent: [] });
    log({ brain_test_start: true, variant: variant.id });
    return json({ ok: true, greeting: GREETING, variant: variant.id });
  }
  if (path === "/brain-test/turn") {
    const c = calls.get(callId);
    if (!c) return json({ ok: false, error: "no such call" }, 404);
    const session = await c.session;
    const history = Array.isArray(body.history) ? body.history.slice(-40).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") })) : [];
    return ndjson(turn({ call: c.row, history, session, model: c.variant.model, openers: c.variant.openers, recent: c.recent, full: async (messages) => ({ text: cannotFor(messages, { callId }).text }), log }));
  }
  if (path === "/brain-test/end") {
    const c = calls.get(callId);
    calls.delete(callId);
    if (c) bf.closeBrain(c.row.id);
    // The call's audio and transcript at Cartesia: deleted once the call is over, as on the live path.
    const agentCallId = String(body.agent_call_id ?? "").trim();
    if (agentCallId) void Promise.resolve(deleteCall(agentCallId)).then(r => log({ brain_test_recording_deleted: !!r?.deleted }), () => log({ brain_test_recording_deleted: false }));
    return json({ ok: true });
  }
  if (path === "/brain-test/selftest" && body.context === true) {
    // The owner's call context, built for real from the read-only database (no model, no preload, no warm-up):
    // only its size comes back, never its words.
    const row = rowFor(`selftest-${randomUUID()}`);
    const t0 = Date.now();
    const s = await open(row, { log, preload: async () => [], warm: false });
    bf.closeBrain(row.id);
    return json({ ok: !!s?.system, system_chars: s?.system?.length ?? 0, ms: Date.now() - t0 });
  }
  if (path === "/brain-test/selftest") {
    // A stand-in turn through the real turn code: no model, no memory read, no call kept.
    const stand = async function* () {
      yield { type: "message_start", message: { usage: {} } };
      for (const t of ["This is a stand-in turn. ", "Nothing was read."]) yield { type: "content_block_delta", delta: { type: "text_delta", text: t } };
    };
    const row = rowFor(`selftest-${randomUUID()}`);
    return ndjson(turn({ call: row, history: [{ role: "user", content: "what do you think?" }], session: { system: "stand-in", preloaded: [] }, openers: false, stream: stand, full: async () => ({ text: "stand-in" }), log }));
  }
  return { status: 404, body: "not found" };
}

/** DELETE /agents/calls/{id} at Cartesia once the call is over; tried a few times; true when it went. */
export async function deleteCartesiaCall(id, { key = process.env.CARTESIA_API_KEY, fetchImpl = globalThis.fetch, tries = 6, waitMs = 5000, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!key || !id) return { deleted: false };
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(waitMs);
    try {
      const r = await fetchImpl(`https://api.cartesia.ai/agents/calls/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-API-Key": key, "Cartesia-Version": "2026-08-14" } });
      if (r.ok || r.status === 404) return { deleted: true, status: r.status };
    } catch { /* tried again */ }
  }
  return { deleted: false };
}

export { op };
