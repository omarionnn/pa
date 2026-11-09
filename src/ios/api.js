// The iPhone app's API: versioned JSON (docs/ios-api.md). Every private answer is decided here, per request, by
// the bearer token alone: no route takes a person, a conversation or a phone number that opens anything. An id
// from somebody else's list answers exactly like an id that never existed.
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import * as db from "../db.js";
import { config, clock } from "../config.js";
import { askForCode, verifyCode, iosAccount, devicesOf, validChallenge, SESSION_TTL_MS, SESSION_IDLE_MS, CODE_TTL_MS } from "./session.js";
import { pageFeed, receipt } from "./feed.js";
import { liveRequest } from "./live.js";
import { memoriesOf, forgetForever, forgetEverything, correctRow, answerGuess } from "./memory.js";
import { bytesOut } from "../webmedia.js";
import { playable } from "../webaudio.js";
import { mimeFor } from "../calls/recordings.js";

const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (status, obj) => { const body = JSON.stringify(obj); return { status, headers: { ...HEADERS, "Content-Length": Buffer.byteLength(body) }, body }; };
const ok = (obj = {}) => json(200, { ok: true, ...obj });
const fail = (status, error, extra = {}) => json(status, { ok: false, error, ...extra });
const notFound = () => fail(404, "not_found");
const notAllowed = () => fail(405, "method_not_allowed");

export const FORGET_EVERYTHING_CONFIRM = "FORGET EVERYTHING";
const MEMORY_KEY = "(fact|why|rule)-\\d{1,12}";

async function bodyOf(readBody) {
  const raw = await readBody();
  if (raw == null) return null;
  try { const v = JSON.parse(raw || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

async function callRecording(account, id, { headers, method }) {
  const c = /^\d{1,15}$/.test(id) ? db.getCall(account.conversation_id, Number(id)) : null;
  if (!c || c.recording_state !== "stored" || !c.recording_file) return notFound();
  let path;
  try { path = realpathSync(c.recording_file); } catch { return notFound(); }
  const root = realpathSync(config.recordingRoot);
  if (!path.startsWith(root + sep)) return notFound();
  return bytesOut({ ...(await playable({ path, root, mime: mimeFor(c.recording_format) ?? "audio/mpeg" })), name: `call-${c.id}`, headers, method });
}

export async function iosApiRequest({ path, method, headers = {}, remoteAddress = "", readBody, runtime = null, log = () => {} }) {
  // ---- signing in: the only routes that take no token ----
  if (path === "/auth/code" || path === "/auth/verify") {
    if (method !== "POST") return notAllowed();
    const b = await bodyOf(readBody);
    if (!b || !validChallenge(b.challenge) || !String(b.phone ?? "").trim()) return fail(400, "bad_request");
    if (path === "/auth/code") {
      const r = askForCode({ phone: b.phone, challenge: b.challenge, headers, remoteAddress, runtime, log });
      if (!r.ok) return fail(429, "rate_limited");
      return json(202, { ok: true, code_ttl_s: Math.round(CODE_TTL_MS / 1000) });
    }
    const r = verifyCode({ phone: b.phone, challenge: b.challenge, code: b.code, deviceName: b.device_name, headers, remoteAddress, log });
    if (!r.ok) return r.reason === "rate_limited" ? fail(429, "rate_limited") : fail(401, "wrong_code");
    return ok({ token: r.token, expires_in_s: Math.round(SESSION_TTL_MS / 1000), idle_expires_in_s: Math.round(SESSION_IDLE_MS / 1000), first_name: String(r.account.name ?? "").trim().split(/\s+/)[0] || null });
  }

  const auth = iosAccount(headers);
  if (!auth) return fail(401, "signed_out");
  const { account, token } = auth;
  const conv = account.conversation_id;

  // ---- this person's devices ----
  if (path === "/auth/sessions") return method === "GET" ? ok({ sessions: devicesOf(conv, token) }) : notAllowed();
  if (path === "/auth/session") {
    if (method !== "DELETE") return notAllowed();
    db.endPageSessionOf(conv, token);
    log({ ios_signout: true });
    return ok();
  }
  let m = /^\/auth\/sessions\/([0-9a-f]{64})$/.exec(path);
  if (m) {
    if (method !== "DELETE") return notAllowed();
    if (db.pageSessionClientByKey(m[1]) !== "ios" || !db.endPageSessionKeyOf(conv, m[1])) return notFound();
    log({ ios_session_revoked: true });
    return ok();
  }

  // ---- the Page ----
  if (path === "/page") return method === "GET" ? ok(pageFeed(conv, clock.now())) : notAllowed();
  m = /^\/items\/([A-Za-z0-9_-]{1,80})$/.exec(path);
  if (m) {
    if (method !== "GET") return notAllowed();
    const r = receipt(conv, m[1], clock.now());
    return r ? ok({ item: r }) : notFound();
  }
  m = /^\/calls\/([^/]{1,20})\/recording$/.exec(path);
  if (m) return method === "GET" || method === "HEAD" ? await callRecording(account, m[1], { headers, method }) : notAllowed();
  if (path === "/live") return method === "GET" ? liveRequest({ account, token, headers, log }) : notAllowed();

  // ---- what Reason knows ----
  if (path === "/memories") return method === "GET" ? ok(memoriesOf(account)) : notAllowed();
  if (path === "/memories/forget-everything") {
    if (method !== "POST") return notAllowed();
    const b = await bodyOf(readBody);
    if (b?.confirm !== FORGET_EVERYTHING_CONFIRM) return fail(400, "confirm_required");
    return ok(forgetEverything(account, { log }));
  }
  m = new RegExp(`^/memories/(${MEMORY_KEY})(/correct)?$`).exec(path);
  if (m) {
    const key = m[1];
    if (m[3]) {
      if (method !== "POST") return notAllowed();
      const b = await bodyOf(readBody);
      if (!b) return fail(400, "bad_request");
      const out = await correctRow(conv, key, b.text, { log });
      return out.ok ? ok({ id: out.key }) : fail(out.status ?? 400, out.error);
    }
    if (method !== "DELETE") return notAllowed();
    const out = await forgetForever(conv, key, { log });
    return out.ok ? ok() : fail(out.status ?? 400, out.error);
  }
  m = /^\/memories\/guess-(\d{1,12})$/.exec(path);
  if (m) {
    if (method !== "POST") return notAllowed();
    const b = await bodyOf(readBody);
    if (!b || !["yes", "no"].includes(b.answer)) return fail(400, "bad_request");
    const out = await answerGuess(conv, m[1], b.answer, { log, said: "Yes, that's right (Reason app)" });
    return out.ok ? ok({ id: out.factKey ?? null }) : fail(out.status ?? 400, out.error);
  }
  return notFound();
}
