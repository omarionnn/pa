// POST /web/daily/answer and /web/daily/later: the daily edition's One question today (src/pages/webdaily.js).
//
// Signed in, same origin, the session's own form secret — like every Web post. The question is one of
// the SESSION's own open guesses (`guess:<id>`); anybody else's id finds nothing. An answer goes to
// Memory through the same path /web/memory's guess card uses (webmemory answerGuess: "yes" saves the
// fact in their name and confirms the guess, its source noted as the daily edition; "no" dismisses it).
// "Ask me later" puts it off for SKIP_DAYS. Either way nothing more is asked today. A plain form lands
// back on Home; the page's script may ask for JSON.
import { timingSafeEqual } from "node:crypto";
import * as db from "../db.js";
import { readCookie } from "./access.js";
import { renderNotFound } from "./render.js";
import { SECURITY_HEADERS, sameOrigin } from "./websignin.js";
import { dailyAllowedFor } from "../dailyflag.js";
import { putOff, noteAnswered } from "../daily.js";

export const ANSWER_SAID = "Yes, that's right (Reason Web daily edition)";
const KEY = /^guess:(\d{1,12})$/;

const same = (a, b) => {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};
const json = (status, obj) => {
  const body = JSON.stringify(obj);
  return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body };
};
const html = (status, body) => ({ status, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body });
const home = () => ({ status: 303, headers: { ...SECURITY_HEADERS, Location: "/web?home", "Content-Length": 0 }, body: "" });

export async function dailyRequest({ account, action, method, headers = {}, readBody, log = () => {} }) {
  const conv = account.conversation_id;
  const wantsJson = String(headers.accept ?? "").includes("application/json");
  if (!dailyAllowedFor(conv)) return wantsJson ? json(404, { ok: false, error: "not_found" }) : html(404, renderNotFound());
  if (method !== "POST") return html(405, renderNotFound());
  const form = new URLSearchParams((await readBody()) ?? "");
  if (!sameOrigin(headers) || !same(headers["x-reason-csrf"] || form.get("c"), db.pageSessionCsrf(readCookie(headers.cookie)))) {
    log({ web_daily_refused: "origin_or_token" });
    return wantsJson ? json(403, { ok: false, error: "not_from_this_page" }) : html(403, renderNotFound());
  }
  const key = String(form.get("q") ?? "");
  const m = KEY.exec(key);
  const g = m ? db.getGuess(conv, Number(m[1])) : null;
  if (!g || g.confirmed_at || g.dismissed_at) return wantsJson ? json(404, { ok: false, error: "not_found" }) : home();
  if (action === "later") {
    putOff(conv, key);
    log({ web_daily: "question_later" });
    return wantsJson ? json(200, { ok: true }) : home();
  }
  const answer = String(form.get("answer") ?? "");
  const { answerGuess } = await import("./webmemory.js");
  const out = await answerGuess(conv, m[1], answer, { log, said: ANSWER_SAID });
  if (!out.ok) return wantsJson ? json(out.status ?? 400, { ok: false, error: out.error }) : home();
  noteAnswered(conv, key);
  log({ web_daily: "question_answered", answer });
  return wantsJson ? json(200, { ok: true, key: out.factKey ?? null }) : home();
}
