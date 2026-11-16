// Reason reads the emailed sign-in code itself: the switch, the audit line and the words
// (REASON_SIGNIN_CODE_READ = off | owner | on, default off; owner decision 2026-11-15). The reader
// itself is src/signinemail.js codeFromMail; the sign-in that uses it is src/filler.js, and the
// signin_email route (src/tools.js hands it strictGmail).
//
// Kept apart from src/signinemail.js on purpose: this file reaches the vault (src/savedlogins.js, for
// who the switch covers and their login_log), and the sign-in probe and the launch code import
// signinemail.js without ever reaching anything that holds a login (test/probe-setups.test.js).
import { config } from "./config.js";
import * as accounts from "./accounts.js";
import { logMailCode } from "./signinlog.js";
import { savedLoginsAllowedFor, recordLoginEvent, mailCodeUsedBefore } from "./savedlogins.js";
import { codeFromMail } from "./signinemail.js";

export function codeReadMode() {
  const v = String(process.env.REASON_SIGNIN_CODE_READ ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}
/**
 * REASON_SIGNIN_CODE_LINKS = off | on (default off): may the automatic reader (src/filler.js) open a
 * sign-in LINK from the site's mail? Off: it only ever uses a code; a mail that carries only a link is
 * "no usable code" and they are asked. A link can approve whichever browser asked for it, including
 * somebody else's at the same moment (review 2026-11-15), so it waits for the owner's decision.
 * The older signin_email route keeps what it does on main.
 */
export function codeLinksOn() {
  return ["1", "true", "on", "yes"].includes(String(process.env.REASON_SIGNIN_CODE_LINKS ?? "").trim().toLowerCase());
}

/**
 * Is reading the code on for this person? The switch, and the saved-login switch already covering
 * them: it never reaches anybody saved logins and sign-in jobs do not.
 */
export function codeReadAllowedFor(conversationId) {
  const c = String(conversationId ?? "");
  if (!c) return false;
  const mode = codeReadMode();
  if (mode === "off") return false;
  if (mode === "owner" && !(c === config.ownerConversation || accounts.featureOwner(c))) return false;
  try { return savedLoginsAllowedFor(c); } catch { return false; }
}

/**
 * The audit line for one code taken from mail: the sign-in log (src/signinlog.js) and the person's
 * login_log row. Site, time, sender domain and a hash of the message id; never the code, subject or body.
 * → whether this was the first time for them (the caller says the longer sentence once).
 */
export function auditMailCode(conversationId, site, { sender = "", hash = "" } = {}) {
  const c = String(conversationId ?? "");
  let first = false;
  try { first = !mailCodeUsedBefore(c); } catch { first = false; }
  try { logMailCode({ signin_url: `https://${site}/` }, { sender, hash }); } catch { /* a log never breaks a sign-in */ }
  try { recordLoginEvent(c, { site, event: "code_from_mail", outcome: "ok", purpose: `from ${String(sender).replace(/[^a-z0-9.-]/g, "")}, mail ${String(hash).replace(/[^a-f0-9]/g, "")}` }); } catch { /* best effort */ }
  return first;
}

/** What they are told, in the result message: the whole of it the first time, then a few words. */
export function mailCodeNotice(site, first) {
  return first
    ? `I took the code from the email ${site} just sent you. I only look at that one email (mail from ${site} that arrived in the last few minutes), nothing else in your inbox. If you'd rather I didn't, tell me and I'll ask you for codes instead.`
    : `Got the code from ${site}'s email.`;
}

/**
 * codeFromMail in the shape startEmailSignin's `gmail` takes (the signin_email route, when
 * REASON_SIGNIN_CODE_READ covers them): one reader for every sign-in that reads a code from mail.
 * The code leaves its Secret only here, for that route's own typing; it is never returned to a tool.
 */
export async function strictGmail(conversationId, entry, { since, waitMs, ...rest } = {}) {
  const got = await codeFromMail(conversationId, entry, { since, ...(waitMs != null ? { waitMs } : {}), ...rest }).catch(() => ({ status: "error" }));
  if (got.status === "code" || got.status === "link") {
    const notice = mailCodeNotice(entry?.label ?? entry?.site ?? "the site", auditMailCode(conversationId, entry?.site ?? "", { sender: got.sender, hash: got.hash }));
    if (got.status === "link") return { connected: true, found: true, kind: "link", url: got.url, notice };
    return { connected: true, found: true, kind: "code", code: got.secret.use((b) => b.toString("utf8")), notice };
  }
  if (got.status === "alert" || got.status === "not_signin") return { connected: true, found: false, stop: got.status === "alert" ? "mail_alert" : "mail_not_signin" };
  if (got.status === "two") return { connected: false, ask: "two" };
  if (got.status === "not_found") return { connected: true, found: false };
  if (got.status === "opted_out") return { connected: false, ask: "opted_out" };
  return { connected: false };
}
