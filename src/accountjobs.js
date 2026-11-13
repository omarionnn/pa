// Finishing a job inside someone's own account: cancelling a subscription, paying a bill.
// Behind REASON_ACCOUNT_JOBS (off | owner | on), off by default; `owner` is the owner's conversation only.
//
// Why (owner, 2026-11-12): when Reason offers something and the person says yes, Reason has to drive it
// to the end itself. That night "cancel Cardboard Starter" went to Reason's own server browser, failed
// at the sign-in, and he was shown a streamed picture of a marketing page. His rule since: a human
// step is EITHER the real site in their own browser OR something native to Reason, never Reason's
// browser shown as a picture. So nothing here opens Reason's browser and nothing here can make that
// sign-in link: the work runs in Crossmint's Agent Checkouts (the shopping path, src/shopconnect.js),
// whose browser gets past walls Reason's cannot, in the person's own Crossmint browser profile.
//
// What Crossmint documents (read 2026-11-12; pages and limits in docs/account-jobs.md):
//   - "Manage subscriptions: subscribe, change a plan, or cancel in the user's account": the change is
//     written in the task, the user's browser profile is attached, and "a very low cap makes sure that
//     the checkout cannot buy anything". The create schema REJECTS a cap of zero (the amount must be
//     positive), so a cancellation's cap is the smallest amount it accepts, CANCEL_CAP.
//   - A cancellation that worked ends `succeeded` with `purchase.kind: "nothing_placed"` and a
//     free-text `result.summary`. There is no "cancelled" field, so the task asks for a fixed last
//     line (RESULT: CANCELLED / RESULT: NOT CANCELLED) and the merchant's own mail is the second proof.
//   - A question is a form of typed fields. A field marked `handling: "protected"` (a password, and in
//     the runs seen so far a one-time code) can only be answered with a reference minted by Crossmint's
//     own input on a page, typed by the person; nothing on a server can mint one. A standard field can
//     be answered by the app.
//   - A browser profile keeps the merchant's session for as long as the merchant keeps it. No call
//     says whether a profile is signed in anywhere: a run that asks no sign-in question was.
//
// The two jobs:
//   cancel — one run, cap CANCEL_CAP, told to stop at the last step and ask. That question is put to
//            the person as one plain line, and only their yes through the confirm gate
//            (account_cancel_confirm, pinned to this job, run and question) answers it. A payment
//            question on this run is declined and the run ended; its run can never hold a payment row
//            (src/shopconnect.js recordPayment / payRow), so nothing can approve one.
//   bill   — one run on the biller's own page (guest pay where it exists). Its card payment is the
//            shopping pay path untouched: Crossmint's exact total, the confirm gate, the daily cap,
//            Face ID. Everything else about the run (sign-in, waits, the ending) is this file's.
//
// Sign-in inside both, in this order (signInStep): a saved signed-in profile (no question comes); a
// code or link the site emailed, read from their Gmail by code; a code they are asked for once in the
// thread; ONE Reason page carrying Crossmint's protected input; otherwise one line and stop.
//
// DONE is two things seen, said by name: the run's result AND, where their mail is connected, the
// merchant's own mail (sender checked the way a sign-in code's is). Anything less is said as not done.
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { clock } from "./config.js";
import * as shop from "./shopconnect.js";
import { codeFromGmail, senderMatches, registrableOf, fromDomain } from "./signinemail.js";

// ---------------------------------------------------------------- the switch
export function jobsMode() {
  const v = String(process.env.REASON_ACCOUNT_JOBS ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}
/** On for this person: the switch, and the checkout service it runs on (keys and REASON_SHOP_CONNECT). */
export function jobsAllowedFor(conversationId) {
  if (!conversationId) return false;
  const mode = jobsMode();
  if (mode === "off") return false;
  if (mode === "owner" && !accounts.featureOwner(conversationId)) return false;
  return !!process.env.CROSSMINT_SERVER_KEY && shop.connectAllowedFor(conversationId);
}

// ---------------------------------------------------------------- the record
db.db.exec(`CREATE TABLE IF NOT EXISTS account_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  host TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  what TEXT NOT NULL DEFAULT '',
  amount TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  due TEXT NOT NULL DEFAULT '',
  mail_domains TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  request_json TEXT NOT NULL DEFAULT '',
  ask_kind TEXT NOT NULL DEFAULT '',
  confirmed_at INTEGER,
  paid_at INTEGER,
  ends TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  receipt TEXT NOT NULL DEFAULT '',
  seen_result INTEGER NOT NULL DEFAULT 0,
  seen_mail INTEGER NOT NULL DEFAULT 0,
  mail_subject TEXT NOT NULL DEFAULT '',
  mail_until INTEGER,
  told TEXT NOT NULL DEFAULT '',
  logged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS account_jobs_by_conv ON account_jobs (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS account_jobs_by_run ON account_jobs (conversation_id, run_id);`);
const q = (sql) => db.db.prepare(sql);
export const OPEN_STATES = ["running", "needs_page", "needs_code", "needs_answer", "needs_confirm", "confirming", "needs_approval", "paid"];
const isOpen = (job) => OPEN_STATES.includes(job?.state);
export const jobRow = (conversationId, id) => q("SELECT * FROM account_jobs WHERE conversation_id = ? AND id = ?").get(String(conversationId), Number(id)) ?? null;
const jobOfRun = (run) => q("SELECT * FROM account_jobs WHERE conversation_id = ? AND run_id = ?").get(run.conversation_id, run.run_id) ?? null;
const set = (job, fields) => {
  const keys = Object.keys(fields);
  if (!keys.length) return jobRow(job.conversation_id, job.id);
  q(`UPDATE account_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE conversation_id = ? AND id = ?`).run(...keys.map((k) => fields[k]), job.conversation_id, job.id);
  return jobRow(job.conversation_id, job.id);
};
/** Claims something as said for this job. False when it already was: each line goes once, across restarts too. */
function once(job, what) {
  const row = jobRow(job.conversation_id, job.id);
  const told = new Set(String(row?.told ?? "").split(",").filter(Boolean));
  if (told.has(what)) return false;
  told.add(what);
  q("UPDATE account_jobs SET told = ? WHERE conversation_id = ? AND id = ?").run([...told].join(","), job.conversation_id, job.id);
  return true;
}
const short = (s, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ---------------------------------------------------------------- one attempt record per run
// What a line holds and nothing else: the site's host, the job kind, how it got in, the outcome word,
// how long it took. Never a plan name, an amount, a reference, an email, a code or a conversation id:
// the fields are built here from fixed lists, so a caller cannot put one in by accident.
export const ROUTES = ["saved_profile", "emailed_code", "emailed_link", "texted_code", "sign_in_page", "none"];
export const OUTCOMES = [
  "done", "done_result_only", "waiting_mail", "unconfirmed", "unexpected_purchase", "paid_unapproved",
  "refused_by_cap", "payment_asked", "blocked_browser", "human_check", "site_error", "no_safe_path", "payment_declined",
  "not_found", "not_cancelled", "nothing_paid", "no_answer", "no_signin", "no_signin_route", "declined", "stopped", "service_failed", "start_failed",
];
const kept = [];
let sink = (line) => { if (!process.env.NODE_TEST_CONTEXT) console.log("   ·", line); };
export function setSink(fn) { const old = sink; sink = fn; return old; }
export function recentAttempts() { return kept.slice(); }
export function _resetAttempts() { kept.length = 0; }
function logAttempt(job) {
  if (q("UPDATE account_jobs SET logged = 1 WHERE conversation_id = ? AND id = ? AND logged = 0").run(job.conversation_id, job.id).changes !== 1) return null;
  const now = clock.now();
  const line = {
    account_job: /^[a-z0-9.-]{1,253}$/.test(job.host) ? job.host : "unknown",
    kind: job.kind === "bill" ? "bill" : "cancel",
    route: ROUTES.includes(job.route) ? job.route : "none",
    outcome: OUTCOMES.includes(job.outcome) ? job.outcome : "service_failed",
    ms: Math.max(0, Math.round(now - Number(job.created_at))),
    at: new Date(now).toISOString(),
  };
  kept.push(line);
  if (kept.length > 100) kept.shift();
  try { sink(JSON.stringify(line)); } catch { /* a log that cannot be written never breaks a job */ }
  return line;
}

// ---------------------------------------------------------------- wiring (src/serve.js)
let sayFn = null, wakeFn = null, logFn = () => {};
export function attach({ say, wake, log } = {}) { sayFn = say ?? null; wakeFn = wake ?? null; logFn = log ?? (() => {}); }
const notify = async (c, text) => { try { if (sayFn) await sayFn(c, text); } catch { /* the record holds either way */ } };
const rouse = async (c, text, key) => { try { if (wakeFn) await wakeFn(c, text, { key }); return true; } catch { return false; } };
let mailCode = codeFromGmail;
let mailLook = null;
let mailWhich = null;
/** Tests hand in the mailbox: `code(conversationId, entry, opts)` like codeFromGmail, `look(conversationId, { domains, since })` → { ok, connected, hits }. */
export function _setMail({ code, look, which } = {}) { mailCode = code ?? codeFromGmail; mailLook = look ?? null; mailWhich = which ?? null; }

// ---------------------------------------------------------------- the site
const hostOf = (s) => {
  const t = String(s ?? "").trim().toLowerCase();
  let host = t;
  try { if (/^https?:\/\//.test(t)) host = new URL(t).hostname; } catch { return ""; }
  host = host.replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && /[a-z]/.test(host.split(".").pop()) ? host : "";
};
const PRIVATE = /(^|\.)(localhost|local|internal|lan|home|arpa|ts\.net|test|invalid|example)$/;
/** Where a job starts: an https page on a public site, nothing carried in the address. */
export function startUrlFor(site, page = "") {
  const host = hostOf(site);
  if (!host || PRIVATE.test(host)) return null;
  let url = null;
  if (page) {
    try { url = new URL(String(page)); } catch { url = null; }
    // The page they named counts only on the same site (a cancel on evil.example is not a cancel at the merchant).
    if (url && (url.protocol !== "https:" || url.username || url.password || registrableOf(url.hostname.toLowerCase()) !== registrableOf(host))) url = null;
  }
  return { host: url ? url.hostname.toLowerCase() : host, url: (url ?? new URL(`https://${host}/`)).toString() };
}
const mailDomains = (job) => [...new Set([registrableOf(job.host), ...String(job.mail_domains ?? "").split(",")].map((d) => d.trim().toLowerCase()).filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)))];

// ---------------------------------------------------------------- the two tasks
/**
 * The smallest cap the create schema takes (its amount pattern refuses 0 and 0.00): a millionth of a
 * dollar. Any real charge is more, so a run under it that meets a price ends blocked
 * (policy.max_cost_exceeded) before it pays.
 */
export const CANCEL_CAP = "0.000001";
export const RESULT_YES = "RESULT: CANCELLED";
export const RESULT_NO = "RESULT: NOT CANCELLED";
export const CONFIRM_MARK = "CONFIRM CANCELLATION";
export function cancelTask({ name, plan }) {
  return `Cancel one subscription in my ${name} account: "${plan}". Nothing else.`
    + ` I should already be signed in. If ${name} asks me to sign in, ask me for what it needs (my email, then a one-time code or my password) and nothing more.`
    + ` Open the subscription or billing settings and find "${plan}". If there is no such subscription on this account, stop and say so; never cancel a different one.`
    + ` Go through the cancellation steps. Decline every offer to stay, pause, downgrade or take a discount. If a reason is required, choose "Other".`
    + ` STOP at the last step, before the click that makes the cancellation final, and ask me ONE question that begins with the words "${CONFIRM_MARK}:" and states the plan's name, its price, and the date my access ends. Only finish after I answer yes to that question.`
    + ` This must cost nothing. Never pay, never buy, never agree to a fee, never add or change a payment method. If cancelling needs a payment, stop and say so.`
    + ` When you are done, end your final summary with one line, exactly "${RESULT_YES}" if ${name} now shows the subscription cancelled or set to end and not renew (and give the date access ends), or "${RESULT_NO}" followed by why.`;
}
/** A bill's ceiling: the amount on the notice plus room for a card fee. Never a price anyone agreed to: the yes is for the exact total. */
export function billCap(amount) {
  const n = Number(amount);
  return (Math.ceil((n * 1.04 + 6) * 100) / 100).toFixed(2);
}
export function billTask({ name, amount, reference, due }) {
  return `Pay one bill on ${name}'s own payment page. The bill: reference (account or invoice number) ${reference}; amount due ${amount} USD${due ? `; due ${due}` : ""}.`
    + ` Use ${name}'s guest or one-time payment page if it has one (no sign-in). Only if there is none, use my signed-in account; if ${name} asks me to sign in, ask me for what it needs.`
    + ` Pay exactly the amount due on that bill, once, as a one-time card payment. Do not turn on autopay, do not save the card, do not set up a recurring payment, do not add a tip, donation or anything else.`
    + ` If the page shows a different amount due than ${amount} USD, or adds a fee, say so in the payment request so I see the page's own total.`
    + ` Pay by card through Crossmint: when you reach payment, request payment approval from me and wait. Do not type any card number into the site yourself, never use a card saved at the site, and never submit the payment without my approval.`
    + ` After paying, capture the confirmation or receipt number.`;
}

// ---------------------------------------------------------------- what a question is
const auto = (f) => String(f?.input?.autoComplete ?? "").toLowerCase();
const label = (f) => `${f?.key ?? ""} ${f?.label ?? ""}`.replace(/[_-]+/g, " ").toLowerCase();
const isIdentity = (f) => ["email", "username", "tel"].includes(auto(f)) || /\b(e ?mail|user ?name|user ?id|login id|phone|mobile)\b/.test(label(f));
const isSecretWord = (f) => auto(f) === "current-password" || /\bpass ?word\b/.test(label(f));
const isCodeLike = (f) => auto(f) === "one-time-code"
  || (/\b(code|otp|passcode|verification|magic link|sign ?in link|login link)\b/.test(label(f)) && !/\b(zip|postal|promo|coupon|discount|country|area|gift|referral|billing)\b/.test(label(f)));
const CANCEL_Q = /\bcancel|terminat|unsubscrib|\bend(ing)? (my |your |the |this )?(plan|subscription|membership|service)|\bstop (my |your |the |this )?(plan|subscription|membership|renewal|service)|turn(ing)? off auto-?renew/i;
const CONFIRM_Q = /\b(confirm|are you sure|final|proceed|go ahead|continue|finish|ready|yes)\b/i;
const SIGNIN_Q = /sign ?in|log ?in|password|verification code/i;
// An earlier step of a cancellation, which the model answers itself: a reason, which plan, an offer to stay.
const PRE_STEP = /\b(why|reason|feedback|survey|tell us|which|select|choose|pick|offer|discount|pause|downgrade|switch (plan|to)|stay|instead)\b/i;
// A field that asks for money details: a card or a bank account. Never answered from anywhere here.
const isPayField = (f) => /^cc-/.test(auto(f))
  || /\b(card ?number|credit card|debit card|card details|cvv|cvc|card security code|name on (the )?card|expir(y|ation) (date|month|year)|mm ?\/ ?yy|bank account|routing number|iban)\b/.test(label(f));
// On a cancellation, being asked how to pay at all is a payment question too.
const isPayChoice = (f) => /\bpayment (method|details|card|option)s?\b|\bhow (would|do) you (like|want) to pay\b|\bpay with\b/.test(label(f));
// Words that say cancelling itself costs money (a fee, a penalty), unless the same breath says there is none.
const FEE_WORDS = /\b(?:cancell?ation|termination|early[- ]termination|early[- ]exit|exit|break(?:age)?)\s+(?:fee|charge|penalty)\b|\bpenalty\b|\bfee of\b|\bearly termination\b/gi;
const NEGATED = /\b(no|not|never|without|won'?t|isn'?t|aren'?t|waived?|free of|zero)\b[^.;:!?]{0,24}$/i;
// Softer money words on a last step (a final bill, a balance): never a stop, always said in the line they are asked.
const MONEY_WORDS = /\b(?:will|would|may|must)\s+(?:still\s+)?(?:be\s+)?(?:charged|billed)\b|\bbalance (?:due|owed|remaining)\b|\bremaining (?:balance|payments?)\b|\bfinal (?:bill|charge|payment|invoice)\b|\bowe\b|\bno refunds?\b|\bnon-?refundable\b/i;
/** The sentence around a place in a text (a full stop inside a number, $12.00, does not end one). */
const sentenceAt = (text, i) => {
  let s = 0;
  for (const m of text.slice(0, i).matchAll(/[.!?:]\s+/g)) s = m.index + m[0].length;
  const e = text.slice(i).search(/[.!?](\s|$)/);
  return text.slice(s, e < 0 ? text.length : i + e + 1).trim();
};
/** The words in a question that say cancelling costs money, or "" when it says no such thing. */
export function feeStated(text) {
  const t = String(text ?? "");
  for (const m of t.matchAll(FEE_WORDS)) {
    if (NEGATED.test(t.slice(Math.max(0, m.index - 40), m.index))) continue;
    return short(sentenceAt(t, m.index), 140);
  }
  return "";
}
/** Softer money words on a question (a final bill, no refund), for the line they are asked: "" when none. */
export function moneyStated(text) {
  const t = String(text ?? "");
  const m = MONEY_WORDS.exec(t);
  return m ? short(sentenceAt(t, m.index), 140) : "";
}
/**
 * What an open form is, from its fields and its words:
 *   pay      — it asks for card or bank details, or (a cancellation) says cancelling costs a fee: never answered
 *   page     — a protected field (a password; a code Crossmint sealed): only the Reason page can answer
 *   secret   — a password-like field that is NOT protected: never answered from anywhere (no route)
 *   code     — a one-time code or sign-in link in a standard field (identity fields may ride along)
 *   identity — only their email / username / phone
 *   confirm  — a cancellation's last step: the task's marker, a cancel-and-confirm question, and, before
 *              their yes, ANY go-ahead question that is not plainly an earlier step (asking once too
 *              often costs a line; answering the last step without them costs a subscription)
 *   plain    — anything else
 */
export function classify(job, rq) {
  const fields = rq?.fields ?? [];
  if (fields.some(isPayField)) return "pay";
  if (job.kind === "cancel" && (fields.some(isPayChoice) || feeStated(rq?.question))) return "pay";
  if (fields.some((f) => f?.handling === "protected")) return "page";
  if (fields.some(isSecretWord)) return "secret";
  if (fields.some(isCodeLike)) return "code";
  if (fields.length && fields.every(isIdentity)) return "identity";
  const words = String(rq?.question ?? "");
  if (job.kind === "cancel") {
    if (words.toUpperCase().includes(CONFIRM_MARK)) return "confirm";
    if (!SIGNIN_Q.test(words)) {
      if (CANCEL_Q.test(words) && CONFIRM_Q.test(words)) return "confirm";
      if (!job.confirmed_at && !PRE_STEP.test(words) && (CANCEL_Q.test(words) || CONFIRM_Q.test(words))) return "confirm";
    }
  }
  return "plain";
}
/** Where the site says it sent a code: "email", "text" or "" (it did not say). */
export function codeChannel(rq) {
  const w = `${rq?.question ?? ""} ${(rq?.fields ?? []).map((f) => f?.label ?? "").join(" ")}`.toLowerCase();
  if (/\b(e-?mail(ed)?|inbox)\b/.test(w) || /@/.test(w)) return "email";
  if (/\b(text(ed)?|sms|phone|mobile|authenticator)\b/.test(w)) return "text";
  return "";
}
const fieldLine = (f) => {
  const opts = f?.input?.kind === "choice" ? ` (one of: ${(f.input.options ?? []).map((o) => (typeof o === "string" ? o : o?.label ?? o?.value)).filter(Boolean).slice(0, 8).join(" / ")})` : "";
  return `${f.key}${f.required ? "*" : ""}: ${short(f.label || f.key, 80)}${opts}`;
};
/** The email Reason knows them by: their connected Google account's address, else none. */
function knownEmail(conversationId) {
  try {
    const rows = db.listOauthTokens(conversationId, "google") ?? [];
    // The account they act from by default first, then any other they connected.
    const e = [...rows].sort((x, y) => Number(y.is_default ?? 0) - Number(x.is_default ?? 0)).map((r) => String(r.account_label ?? "")).find((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
    return e || "";
  } catch { return ""; }
}
const mailOn = (conversationId) => { try { return (db.listOauthTokens(conversationId, "google") ?? []).length > 0; } catch { return false; } };
/** Which of their connected mailboxes holds mail from these senders: its address, or "" (one list call per mailbox, nothing opened). */
async function gmailWhich(conversationId, domains) {
  const google = await import("./google.js");
  const tokens = await google.allAccessTokens(conversationId, { scope: google.TOOL_SCOPES.gmail_search });
  if (!tokens.ok) return "";
  for (const a of tokens.accounts ?? []) {
    const list = await google.api(a.token, "GET", "/gmail/v1/users/me/messages", { query: { q: `from:(${domains.join(" OR ")})`, maxResults: 1 } });
    if (list.ok && (list.body?.messages ?? []).length && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(a.account ?? ""))) return String(a.account);
  }
  return "";
}
/**
 * The email they are known by AT THIS SITE. Someone with several mailboxes connected is known to a site by
 * the one its mail goes to (their receipt from it), not always by their default; one mailbox, or no such
 * mail anywhere: the default.
 */
async function emailAt(job) {
  const fallback = knownEmail(job.conversation_id);
  try {
    if ((db.listOauthTokens(job.conversation_id, "google") ?? []).length < 2) return fallback;
    const which = mailWhich ?? (process.env.NODE_TEST_CONTEXT ? null : gmailWhich);
    const domains = mailDomains(job);
    return (which && domains.length ? await which(job.conversation_id, domains) : "") || fallback;
  } catch { return fallback; }
}

// ---------------------------------------------------------------- words: every ending
const dollars = (a) => `$${a}`;
const whatOf = (job) => (job.kind === "cancel" ? `${job.what} at ${job.name}` : `the ${job.name} bill${job.amount ? ` (${dollars(job.amount)})` : ""}`);
const SIGNED_IN_BY = {
  emailed_code: (n) => ` I signed in with the code ${n} emailed you.`,
  emailed_link: (n) => ` I signed in with the link ${n} emailed you.`,
  texted_code: (n) => ` I signed in with the code you sent me.`,
  sign_in_page: (n) => ` You signed in once on the page, and ${n} stays signed in for next time.`,
};
const routeLine = (job) => SIGNED_IN_BY[job.route]?.(job.name) ?? "";
/** Is the name they know this by the site's own? "Cardboard" on cardboard.app is; on link.com (a billing service) it is not. */
const nameFitsHost = (name, host) => sameName(name, registrableOf(host).split(".")[0]);
// How a sign-in line names the place: the merchant where the site is its own; the site's address beside it where a billing service runs the account.
/** Their mail was read for a sign-in code or link: the line that says so, once per job ("" when it was said, or was not so). */
const mailRouteOnce = (job) => (["emailed_code", "emailed_link"].includes(job.route) && once(job, "routeline") ? routeLine(job) : "");
const siteWords = (j) => (nameFitsHost(j.name, j.host) ? j.name : `${j.name}'s account page (${registrableOf(j.host)})`);
const whereWords = (j) => (nameFitsHost(j.name, j.host) ? j.name : registrableOf(j.host));
/**
 * Why a job is not done, in one plain line. Every reason a run can end on has its own; none claims a
 * change that was not seen, and each says what is true about money.
 */
export function notDoneLine(job, reason, { detail = "", amount = "" } = {}) {
  const n = job.name, cancel = job.kind === "cancel";
  const same = cancel ? `${job.what} is unchanged.` : "Nothing was paid.";
  const d = detail ? ` (${short(detail, 140)})` : "";
  switch (reason) {
    case "refused_by_cap": return cancel
      ? `Not done: cancelling ${job.what} at ${n} would have cost money, and a cancellation through me can never pay. Nothing was charged. ${same}`
      : `Not done: ${n}'s page came to more than the bill plus a fee allowance, so it stopped before paying. Nothing was paid.`;
    case "payment_asked": return detail
      ? `Not done: ${n}'s page says cancelling ${job.what} comes with money to pay${d}. A cancellation through me can never pay, so I refused it and stopped. Nothing was charged. ${same}`
      : `Not done: ${n}'s page asked for a payment${amount ? ` (${amount})` : ""} before it would cancel ${job.what}. I refused it and stopped. Nothing was charged. ${same}`;
    case "unexpected_purchase": return `Check this: ${n}'s page reports a purchase${d} on a run that was only meant to cancel ${job.what}. I approved no payment and my limit for it was a millionth of a dollar. Look at your ${n} account and your card.`;
    case "paid_unapproved": return `Check this: ${n}'s page says a payment went through${d}, but not through the approval I ask you for, so it likely used a card saved at ${n}. I did not approve it. Look at your ${n} account before paying anything again.`;
    case "blocked_browser": return `Not done: ${n} refused the browser I use for this, so I never got to ${cancel ? "your subscription" : "the payment page"}. ${same}`;
    case "human_check": return `Not done: ${n} put up a human check that I can't pass. ${same}`;
    case "site_error": return `Not done: ${n}'s site kept showing an error${d}. ${same}`;
    case "no_safe_path": return `Not done: I found no safe way to ${cancel ? `cancel ${job.what}` : "pay this bill"} on ${n}'s site${d}. ${same}`;
    case "payment_declined": return `Not done: ${n} declined the card. Nothing was paid.`;
    case "not_found": return `Not done: I got into the ${n} account, but there is no "${job.what}" subscription on it${d}. It may be under another login or billed somewhere else.`;
    case "not_cancelled": return `Not done: ${n}'s page did not confirm the cancellation${d}. Treat ${job.what} as still active.`;
    case "nothing_paid": return `Not done: the run ended without paying anything${d}. Nothing was paid.`;
    case "no_answer": return cancel
      ? `Not done: ${n}'s page stopped waiting for your yes (it holds that last step about ten minutes). ${same} Tell me to cancel it again and I'll go straight back.`
      : `Not done: ${n}'s page stopped waiting for an answer. Nothing was paid.`;
    case "approval_timeout": return `Not done: ${n}'s page stopped waiting for your approval. Nothing was paid. Tell me to pay it again and I'll bring the total back.`;
    case "no_signin": return `Not done: the sign-in wasn't finished in time, so ${n} let it go. ${same}`;
    case "no_signin_route": return `Not done: ${n} needs a sign-in I have no way to do from here${d}. ${same}`;
    case "declined": return cancel ? `Left as it is: ${job.what} at ${n} is not cancelled.` : `Left unpaid: the ${n} bill was not paid.`;
    case "stopped": return `Stopped. ${same}`;
    case "start_failed": return `Not done: I couldn't start${d}. ${same}`;
    case "unconfirmed": return cancel
      ? `Not confirmed: your yes went to ${n}, then the run broke off before it showed me the result${d}. ${job.what} may or may not be cancelled.`
      : `Not confirmed: your approval went out, then the run ended without a receipt${d}. Don't pay it again yet.`;
    default: return `Not done: the service I use for this broke off partway${d}. ${cancel ? `Treat ${job.what} as still active.` : "Nothing was paid that I can see."}`;
  }
}
const endsWords = (job) => (job.ends ? `; access ends ${job.ends}` : "");
const receiptWords = (r) => (r?.total ? `${dollars(r.total)}${r.order ? `, confirmation ${r.order}` : ""}` : r?.order ? `confirmation ${r.order}` : "");
/** The ending when the run's result says it worked: which of the two proofs was seen, by name. */
export function resultLine(job, mail) {
  const n = job.name;
  const receipt = job.receipt ? JSON.parse(job.receipt) : null;
  const did = job.kind === "cancel"
    ? `${job.what} at ${n} is cancelled${endsWords(job)}`
    : `${dollars(receipt?.total || job.amount)} went to ${n}${job.reference ? ` for ${job.reference}` : ""}`;
  const page = job.kind === "cancel" ? `${n}'s page said so` : (receipt?.kind === "receipt_captured" ? `the payment page's receipt (${receiptWords(receipt) || "captured"})` : `${n}'s page confirmed it, with no receipt`);
  const theirMail = job.kind === "cancel" ? "cancellation email" : "confirmation email";
  if (mail.state === "seen") return `Done. ${did}. Seen: ${page}, and their ${theirMail} arrived ("${short(mail.subject, 80)}").`;
  if (mail.state === "not_connected") {
    // A bill with no receipt and no mail to look in is one weak proof: said as not confirmed.
    if (job.kind === "bill" && receipt?.kind !== "receipt_captured") return `Not confirmed: ${n}'s page said the payment went through but gave no receipt, and I can't see your email to look for theirs. Check ${n} before paying again.`;
    return `Done as far as I can see: ${did}. Seen: ${page}. I can't see your email, so I couldn't look for their ${theirMail}.`;
  }
  const claim = job.kind === "cancel" ? `${n}'s page says ${job.what} is cancelled${endsWords(job)}`
    : receipt?.kind === "receipt_captured" ? `the payment page's receipt shows ${receiptWords(receipt) || "it"} paid to ${n}` : `${n}'s page says the payment went through, with no receipt`;
  if (mail.state === "unread") return `Not done yet: ${claim}, but I couldn't get into your email just now to look for their ${theirMail}. I'll keep trying and tell you either way.`;
  return `Not done yet: ${claim}, but their ${theirMail} hasn't arrived. I'm watching your email and will tell you when it lands, or tomorrow if it never does.`;
}
export const mailLandedLine = (job, subject) => `Done. ${job.name}'s ${job.kind === "cancel" ? "cancellation" : "confirmation"} email arrived ("${short(subject, 80)}"). ${job.kind === "cancel" ? `${job.what} is cancelled${endsWords(job)}` : `The ${job.name} bill is paid`}. Seen: their page and their email.`;
export const mailNeverLine = (job) => (job.kind === "cancel"
  ? `Still no cancellation email from ${job.name} a day later. Their page said ${job.what} was cancelled${endsWords(job)}; I can't confirm it beyond that, so check your next statement.`
  : `Still no confirmation email from ${job.name} a day later. The payment page said it was paid; I can't confirm it beyond that, so check your account there.`);

// ---------------------------------------------------------------- the merchant's own mail
// What counts as the merchant saying it happened, and what never does: mail that asks for a click to
// finish, says it failed, or is about an order or a booking is not proof (a wrong "done" is the worst line here).
const CANCEL_MAIL = /\b(has been|have been|is|is now|was|are|successfully|you(['’]ve| have)?) cancel+ed\b|\bcancel+ed your\b|(^|[:–—-]\s*)cancel+ed\b|\bcancel+ation (is |has been |was )?(confirm(ed|ation)|complete[d]?|processed|successful)\b|\b(subscription|plan|membership|renewal|auto-?renew(al)?) (has been |is |was )?(cancel+ed|ended|turned off)\b|\b(subscription|membership|plan) has ended\b|sorry to see you go|\bwill not renew\b|\bwon['’]?t (be )?renew/i;
const NOT_CANCEL_MAIL = /\b(not|unable to|could ?n.t|failed to|did ?n.t) (be(en)? )?(cancel|process)|\bconfirm your cancel|\bto (complete|finish|confirm) (your |the )?cancel|\bcancel\w* (request )?(is |was )?(pending|failed|unsuccessful|declined)|\b(order|appointment|booking|reservation|delivery|shipment|payment|transaction|meeting|event|flight|trip|ticket|class|session)\b[^.]{0,30}\bcancel+ed\b/i;
const PAID_MAIL = /\bpayment (was |has been |is )?(received|confirm(ed|ation)|successful|processed|posted|complete[d]?)\b|\breceipt\b|\bthank(s| you) for (your|the) payment\b|\bwe(['’]ve| have)? received your payment\b|\b(has been|have been|was|is|successfully|you(['’]ve| have)?) paid\b|\bpaid in full\b/i;
const NOT_PAID_MAIL = /\b(unpaid|not (been |yet )?(paid|processed|received)|past due|overdue|unsuccessful|refund(ed)?)\b|\b(payment|charge|transaction|card)\b[^.]{0,30}\b(declined|fail(ed|ure|s)?)\b|\b(fail(ed|ure)|declined)\b[^.]{0,30}\b(payment|charge|transaction|card)\b|\b(could ?n.t|unable to) (process|charge|complete)|\bproblem (with|processing)\b|\baction (needed|required)\b|\bupdate your (payment|card|billing)/i;
async function gmailLook(conversationId, { domains, since }) {
  const google = await import("./google.js");
  const tokens = await google.allAccessTokens(conversationId, { scope: google.TOOL_SCOPES.gmail_search });
  if (!tokens.ok) return ["not_connected", "scope_missing"].includes(tokens.status) || (tokens.accounts_failed ?? []).every((f) => f.status === "scope_missing") ? { ok: true, connected: false, hits: [] } : { ok: false, connected: true, hits: [] };
  const hits = [];
  let errors = (tokens.accounts_failed ?? []).filter((f) => f.status !== "scope_missing").length;
  for (const a of tokens.accounts ?? []) {
    const list = await google.api(a.token, "GET", "/gmail/v1/users/me/messages", { query: { q: `from:(${domains.join(" OR ")}) after:${Math.floor(since / 1000)}`, maxResults: 8 } });
    if (!list.ok) { errors++; continue; }
    for (const m of list.body?.messages ?? []) {
      const one = await google.api(a.token, "GET", `/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`, { query: { format: "metadata", metadataHeaders: ["From", "Subject", "Date", "Authentication-Results"] } });
      if (!one.ok) { errors++; continue; }
      const headers = one.body?.payload?.headers ?? [];
      const h = (name) => headers.filter((x) => String(x?.name ?? "").toLowerCase() === name).map((x) => String(x?.value ?? ""));
      hits.push({ from: h("from")[0] ?? "", subject: h("subject")[0] ?? "", auth: h("authentication-results"), snippet: String(one.body?.snippet ?? ""), at: Number(one.body?.internalDate) || 0 });
    }
  }
  if (errors && !hits.length) return { ok: false, connected: true, hits: [] };
  return { ok: true, connected: true, hits };
}
/**
 * One look for the merchant's own mail about this job since it acted: really from them (the From
 * domain and Gmail's own DKIM verdict, src/signinemail.js senderMatches), about the right thing (a
 * cancellation, or a payment), and — when the sender is not the site itself (a billing service) —
 * naming the plan or the merchant.  → { state: "seen", subject } | "none" | "not_connected" | "unread"
 */
export async function lookForMail(job) {
  const domains = mailDomains(job);
  if (!domains.length) return { state: "none" };
  const since = Number(job.confirmed_at ?? job.paid_at ?? job.created_at) - 60_000;
  let r;
  try { r = await (mailLook ?? gmailLook)(job.conversation_id, { domains, since }); } catch { return { state: "unread" }; }
  if (!r?.ok) return { state: "unread" };
  if (!r.connected) return { state: "not_connected" };
  const about = job.kind === "cancel" ? CANCEL_MAIL : PAID_MAIL;
  const never = job.kind === "cancel" ? NOT_CANCEL_MAIL : NOT_PAID_MAIL;
  const own = registrableOf(job.host);
  // What ties a mail to THIS job when the sender alone does not (a billing service's mail, or a site that
  // is not the merchant's own): the plan or the merchant by name; for a bill, the merchant or the amount paid.
  const paidAmount = job.kind === "bill" ? String((job.receipt ? JSON.parse(job.receipt).total : "") || job.amount || "") : "";
  const names = (job.kind === "cancel" ? [job.what, job.name] : [job.name, paidAmount]).map((s) => String(s ?? "").toLowerCase().trim()).filter((s) => s.length >= 3);
  const siteIsTheirs = nameFitsHost(job.name, job.host);
  for (const h of r.hits ?? []) {
    if (h.at && h.at < since) continue;
    if (!senderMatches({ from: h.from, auth: h.auth }, domains)) continue;
    const text = `${h.subject} ${h.snippet}`;
    if (!about.test(text) || never.test(text)) continue;
    const sender = registrableOf(fromDomain(h.from));
    const plainlyTheirs = (sender === own && siteIsTheirs) || nameFitsHost(job.name, sender);
    if (!plainlyTheirs && !names.some((s) => text.toLowerCase().includes(s))) continue;
    return { state: "seen", subject: h.subject };
  }
  return { state: "none" };
}
export const MAIL_WATCH_MS = 24 * 3600_000;
export const MAIL_EVERY_MS = 10 * 60_000;
/** One tick of a job's mail watch: the merchant's mail lands (said once), or the day runs out (said once). */
export async function checkMail(conversationId, id) {
  const job = jobRow(conversationId, id);
  if (!job || !job.mail_until || job.seen_mail) return { done: true };
  const mail = await lookForMail(job);
  if (mail.state === "seen") {
    const now = set(job, { seen_mail: 1, mail_subject: short(mail.subject, 160), mail_until: null, state: "done", outcome: "done" });
    if (once(job, "mail")) await notify(job.conversation_id, mailLandedLine(now, mail.subject));
    return { done: true, seen: true };
  }
  if (mail.state === "not_connected") { set(job, { mail_until: null }); return { done: true, connected: false }; }
  if (clock.now() > job.mail_until) {
    set(job, { mail_until: null });
    if (once(job, "mail")) await notify(job.conversation_id, mailNeverLine(job));
    return { done: true, expired: true };
  }
  return { done: false };
}
export function watchMail(conversationId, id, { everyMs = MAIL_EVERY_MS } = {}) {
  const tick = async () => {
    let out = { done: false };
    try { out = await checkMail(conversationId, id); } catch { /* next tick */ }
    if (!out.done) setTimeout(tick, everyMs).unref?.();
  };
  setTimeout(tick, everyMs).unref?.();
}
/** After a restart: every open mail watch goes on (the runs themselves are followed by shop.resumeFollowing). */
export function resume() {
  const open = q("SELECT id, conversation_id FROM account_jobs WHERE mail_until IS NOT NULL AND seen_mail = 0").all();
  for (const j of open) watchMail(j.conversation_id, j.id);
  return open.length;
}

// ---------------------------------------------------------------- starting a job
export const STARTS_PER_DAY = 3;
/** Every site together, per person and day: a model that keeps trying other addresses for the same thing stops here. */
export const STARTS_PER_DAY_ALL = 8;
const startsToday = (c, kind, host) => q("SELECT COUNT(*) AS n FROM account_jobs WHERE conversation_id = ? AND kind = ? AND host = ? AND created_at > ?").get(c, kind, host, clock.now() - 24 * 3600_000).n;
const startsTodayAll = (c) => q("SELECT COUNT(*) AS n FROM account_jobs WHERE conversation_id = ? AND created_at > ?").get(c, clock.now() - 24 * 3600_000).n;
const openJob = (c, kind, host) => q(`SELECT * FROM account_jobs WHERE conversation_id = ? AND kind = ? AND host = ? AND state IN (${OPEN_STATES.map(() => "?").join(", ")}) ORDER BY id DESC`).get(c, kind, host, ...OPEN_STATES) ?? null;
const cleanName = (s, host) => short(String(s ?? "").replace(/["`\n\r]/g, " "), 60) || shop.storeName(shop.storeKey(host)) || host;
const cleanDomains = (s) => String(s ?? "").split(/[\s,;]+/).map((d) => registrableOf((d.includes("@") ? d.split("@").pop() : d).replace(/[<>]/g, "").toLowerCase())).filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)).slice(0, 3).join(",");

async function begin({ conversationId, kind, at, name, what, amount = "", reference = "", due = "", sender = "", task, cap, item }) {
  const store = shop.storeKey(at.host) ?? "";
  // One job at a time for the same thing: a second ask answers with the one running, never a second run.
  const running = openJob(conversationId, kind, at.host);
  if (running) return { ok: true, already_running: true, job_id: running.id, state: running.state, say: `That is already under way (job ${running.id}, ${running.state.replace(/_/g, " ")}). Nothing new was started; account_job_status says where it is.` };
  if (startsToday(conversationId, kind, at.host) >= STARTS_PER_DAY) {
    return { ok: false, blocked: "tried_enough", say: `This was tried ${STARTS_PER_DAY} times at ${name} in the last day and did not finish. Nothing new was started: say plainly that it is not working there and what the last attempt ended on (account_job_status), and do not offer to try again today.` };
  }
  if (startsTodayAll(conversationId) >= STARTS_PER_DAY_ALL) {
    return { ok: false, blocked: "tried_enough", say: `${STARTS_PER_DAY_ALL} of these were started for them in the last day, which is the limit. Nothing new was started: say so plainly, and what the last ones ended on (account_job_status).` };
  }
  const id = Number(q(`INSERT INTO account_jobs (conversation_id, kind, host, name, what, amount, reference, due, mail_domains, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
    .run(conversationId, kind, at.host, name, what, amount, reference, due, cleanDomains(sender), clock.now()).lastInsertRowid);
  let job = jobRow(conversationId, id);
  // The page's name for the site, kept for everyone: only a name that is the site's own (never a merchant's name on a billing service's address).
  if (store) { try { shop.noteStore({ store, name: nameFitsHost(name, at.host) ? name : "", url: at.url }); } catch { /* a name for the page, no more */ } }
  let out;
  try { out = await shop.startJobRun({ conversationId, store, startUrl: at.url, task, item, cap, kind }); }
  catch (e) { out = { ok: false, error: String(e?.message ?? e).split("\n")[0] }; }
  if (!out.ok) {
    job = set(job, { state: "not_done", outcome: "start_failed", ended_at: clock.now() });
    logAttempt(job);
    logFn({ account_job_start_failed: kind, status: out.status ?? null });
    return { ok: false, job_id: id, error: "start_failed", say: `${notDoneLine(job, "start_failed", { detail: out.status ? `the service answered ${out.status}` : "" })} Say that in one line.` };
  }
  job = set(job, { run_id: out.runId });
  shop.follow(out.runId);
  logFn({ account_job_started: kind, job_id: id });
  return { ok: true, job_id: id, run_id: out.runId, job };
}

/** Starts a cancellation. Nothing is cancelled by this: the run stops at the last step and asks. */
export async function startCancel({ conversationId, site, plan, page = "", name = "", sender = "" }) {
  if (!jobsAllowedFor(conversationId)) return { ok: false, blocked: "not_available" };
  const at = startUrlFor(site, page);
  const what = short(String(plan ?? "").replace(/["`\n\r]/g, " "), 80);
  if (!at || !what) return { ok: false, error: "needs_site_and_plan", say: "Nothing was started: this needs the site the subscription is managed on (its address) and the plan's name, both from them or from the notice. Ask for what is missing in one line." };
  const n = cleanName(name, at.host);
  const out = await begin({ conversationId, kind: "cancel", at, name: n, what, sender, task: cancelTask({ name: n, plan: what }), cap: CANCEL_CAP, item: `cancelling ${what}` });
  if (!out.job) return out;
  return { ok: true, job_id: out.job_id, run_id: out.run_id,
    say: `Started (job ${out.job_id}): I'm in ${n} finding ${what}. NOTHING IS CANCELLED YET. It stops at the last step and you will be told what it found; then you ask them one plain line and their yes goes through account_cancel_confirm. Tell them in one short line that you're on it and will come back with exactly what gets cancelled and when it ends. Never offer signin_link for this: sign-in is handled inside the job.` };
}

/** Starts a bill payment. Nothing is paid by this: the run stops at payment and the exact total is texted for approval. */
export async function startBill({ conversationId, site, biller, amount, reference, due = "", page = "", sender = "" }) {
  if (!jobsAllowedFor(conversationId)) return { ok: false, blocked: "not_available" };
  const at = startUrlFor(site, page);
  const amt = String(amount ?? "").replace(/[$,\s]/g, "");
  // The notice's own pay link names the bill by itself (a hosted invoice page): a reference where no number is printed.
  const linked = !!(at && page && at.url !== `https://${at.host}/`);
  const ref = short(String(reference ?? "").replace(/["`\n\r]/g, " "), 60) || (linked ? "the invoice the notice links to" : "");
  const missing = [!at && "the biller's site", !/^\d+(\.\d{1,2})?$/.test(amt) || !(Number(amt) > 0) ? "the amount due" : "", !ref && "the account or invoice number (or the notice's own pay link)"].filter(Boolean);
  if (missing.length) return { ok: false, error: "missing_reference", missing, say: `Nothing was started: paying a bill needs ${missing.join(", ")} from the notice itself. Ask for what is missing in one line; never guess a number.` };
  const n = cleanName(biller, at.host);
  const fixed = Number(amt).toFixed(2);
  if (!shop.cardOf(conversationId)) return { ok: false, blocked: "no_card", say: "Nothing was started: they have no card saved to pay with. shop_card gives the link to add one; say that in one line, then start this again once it is saved." };
  // The day's limit, asked before anything runs: a bill that cannot be approved today is not started.
  const trust = await import("./trust.js");
  const cents = Math.round(Number(fixed) * 100);
  const cap = trust.checkSpendCap(conversationId, cents);
  if (!cap.ok) return { ok: false, blocked: "over_daily_cap", cap: cap.cap, spent_today: cap.spent_today, left: cap.left, amount: cap.amount, say: `Nothing was started and nothing was paid: ${cap.say} Say it once, in their terms.`, note: cap.error };
  const out = await begin({ conversationId, kind: "bill", at, name: n, what: "bill", amount: fixed, reference: ref, due: short(due, 40), sender, task: billTask({ name: n, amount: fixed, reference: ref, due: short(due, 40) }), cap: billCap(fixed), item: `your ${n} bill (${ref})` });
  if (!out.job) return out;
  return { ok: true, job_id: out.job_id, run_id: out.run_id,
    say: `Started (job ${out.job_id}): I'm on ${n}'s payment page with the bill's details. NOTHING IS PAID YET. When it reaches payment they get ${n}'s exact total to approve, and only that approval pays. Tell them in one short line that you're on it and the total comes next. Never offer signin_link for this: sign-in is handled inside the job.` };
}

// ---------------------------------------------------------------- one look at a job's run (src/shopconnect.js step)
export const WAIT_MS = 4 * 60_000;
const TERMINAL = new Set(["succeeded", "failed", "blocked", "cancelled", "expired"]);
const eventHead = (job) => `[account job] #${job.id} ${job.kind === "cancel" ? `cancel "${job.what}" at ${job.name}` : `pay the ${job.name} bill (${dollars(job.amount)}, ${job.reference})`}`;

/**
 * Called by shop.step for a run marked as a job. Returns what step returns ({ done, status, … }), or
 * null to let the pay path go on (only ever for a bill's card payment and its wait for approval).
 */
export async function onRun(run, cur, kit) {
  const job = jobOfRun(run);
  // A marked run with no job row cannot be judged: ended, never treated as shopping.
  if (!job) { await kit.cancelAtCrossmint(run); kit.endRow(run, "cancelled", { code: "account job: no record" }); return { done: true, status: "cancelled" }; }
  const status = String(cur.status ?? "");
  if (TERMINAL.has(status)) return await onEnd(job, run, cur, kit);
  const ra = cur.requiredAction;
  const requestId = ra?.requestId ?? "";
  if (requestId && requestId !== run.last_request_id) {
    const rq = { requestId, request: ra.request };
    const it = ra.request?.interaction ?? {};
    const pub = kit.publicRequest(rq);
    const now = clock.now();
    // Claimed in one statement: two looks at once (the follower's and a resumed one) handle a question once.
    if (q("UPDATE shop_runs SET last_request_id = ?, question = ?, request_json = ?, progress_at = ?, updated_at = ? WHERE run_id = ? AND conversation_id = ? AND last_request_id <> ?")
      .run(requestId, short(pub.question, 600), JSON.stringify(pub), now, now, run.run_id, run.conversation_id, requestId).changes !== 1) return { done: false, status };
    if (it.kind === "payment") return await onPayment(job, run, rq, it, kit);
    return await onQuestion(job, run, rq, pub, kit);
  }
  // The same question, and the model was never reached for it (the wake failed): raised again, twice at most.
  if (requestId && requestId === job.request_id && ["needs_answer", "needs_code", "needs_confirm"].includes(job.state)) {
    const told = new Set(String(job.told ?? "").split(","));
    if (!told.has(`woke:${requestId}`) && (once(job, `again1:${requestId}`) || once(job, `again2:${requestId}`))) {
      return await onQuestion(job, run, { requestId, request: ra.request }, kit.publicRequest({ requestId, request: ra.request }), kit);
    }
  }
  // A bill waiting on their approval is the pay path's (its one reminder, its expiry).
  if (job.kind === "bill" && ["needs_approval", "approved", "paid"].includes(run.stage)) {
    if (run.stage === "paid" && job.state !== "paid") set(job, { state: "paid", paid_at: run.paid_at ?? clock.now() });
    return null;
  }
  if (!requestId && (run.stage === "started" || !run.stage)) kit.setStage(run.run_id, "in_progress");
  // One line if it is slow, once per job: never a stream of "still working".
  if (job.state === "running" && clock.now() - job.created_at >= WAIT_MS && once(job, "wait")) {
    await kit.say(`Still working inside ${job.name} on ${job.kind === "cancel" ? `cancelling ${job.what}` : "that bill"}. Not stuck; ${job.kind === "cancel" ? "nothing is cancelled yet" : "nothing is paid yet"}.`);
  }
  return { done: false, status };
}

/** A payment question. A cancellation never pays: declined, the run ended, said. A bill's goes to the pay path. */
/** A cancellation met money (a payment request, card fields, a stated fee): the question is declined, the run ended, said once. */
async function refuseToPay(job, run, requestId, kit, { amount = "", detail = "" } = {}) {
  await kit.sendPart(run, { type: "input_response", requestId, action: "decline" });
  await kit.cancelAtCrossmint(run);
  kit.endRow(run, "cancelled", { code: "account job: a cancellation never pays" });
  const link = kit.openSigninLink(run.run_id);
  if (link) kit.finishSignin(run, link);
  const done = set(job, { state: "not_done", outcome: "payment_asked", request_id: "", request_json: "", ask_kind: "", ended_at: clock.now(), route: job.route || "saved_profile" });
  logAttempt(done);
  if (once(job, "end")) await kit.say(`${notDoneLine(done, "payment_asked", { amount, detail })}${mailRouteOnce(done)}`);
  return { done: true, status: "cancelled" };
}
const plainName = (s) => String(s ?? "").toLowerCase().replace(/&/g, "and").replace(/\b(inc|llc|ltd|pbc|corp|co|company|the)\b/g, "").replace(/[^a-z0-9]/g, "");
/** Do two names mean the same payee? One inside the other, once the legal endings and spaces are gone. */
export function sameName(a, b) {
  const x = plainName(a), y = plainName(b);
  return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x));
}
async function onPayment(job, run, rq, it, kit) {
  const amount = it.amount?.value ? `${it.amount.currency === "USD" || !it.amount.currency ? "$" : ""}${it.amount.value}${it.amount.currency && it.amount.currency !== "USD" ? ` ${it.amount.currency}` : ""}` : "";
  if (job.kind === "cancel") return await refuseToPay(job, run, rq.requestId, kit, { amount });
  // Who the page says is being paid, when that is not who the notice named: said before the ask, in the page's word.
  const payee = short(it.merchant?.name ?? "", 60);
  if (payee && !sameName(payee, job.name) && !sameName(payee, registrableOf(job.host).split(".")[0]) && once(job, "payee")) {
    await kit.say(`Look before you approve: the payment page names who gets paid as "${payee}", not ${job.name}. The approval below pays ${payee}.`);
  }
  // Reached payment with no sign-in question on the way: the saved profile (or the guest page) was enough.
  const next = set(job, { state: "needs_approval", route: job.route || "saved_profile", request_id: "", request_json: "", ask_kind: "" });
  // How it got in, said once and by code before the total is asked.
  if (routeLine(next) && once(job, "routeline")) await kit.say(routeLine(next).trim());
  // The page's own total against the notice, said before the ask when they differ: the yes is for the page's number.
  const exact = String(it.amount?.kind ?? "exact") === "exact" && /^\d+(\.\d{1,4})?$/.test(String(it.amount?.value ?? ""));
  if (exact && Number(it.amount.value).toFixed(2) !== Number(next.amount).toFixed(2) && once(job, "differs")) {
    const diff = Number(it.amount.value) - Number(next.amount);
    await kit.say(`${next.name}'s page total is ${amount}; the notice said ${dollars(next.amount)} (${diff > 0 ? `${dollars(diff.toFixed(2))} more, likely a card fee` : `${dollars(Math.abs(diff).toFixed(2))} less`}). The approval below is for the page's total.`);
  }
  return null;
}

/** A form question: the sign-in ladder, a cancellation's last step, or a plain question for the model. */
async function onQuestion(job, run, rq, pub, kit) {
  const kind = classify(job, pub);
  kit.setStage(run.run_id, "needs_input");
  let j = set(job, { request_id: rq.requestId, request_json: JSON.stringify(pub), ask_kind: kind });
  const status = "awaiting_input";
  const noRoute = async (detail) => {
    await kit.sendPart(run, { type: "input_response", requestId: rq.requestId, action: "decline" });
    await kit.cancelAtCrossmint(run);
    kit.endRow(run, "cancelled", { code: "account job: no sign-in route" });
    const done = set(j, { state: "not_done", outcome: "no_signin_route", route: j.route || "none", request_id: "", request_json: "", ask_kind: "", ended_at: clock.now() });
    logAttempt(done);
    if (once(job, "end")) await kit.say(`${notDoneLine(done, "no_signin_route", { detail })}${mailRouteOnce(done)}`);
    return { done: true, status: "cancelled" };
  };

  if (kind === "pay") {
    // Money asked for in a form. A cancellation never pays: declined and ended. A bill's card goes only
    // through the payment approval (never typed into a form by anyone): declined and ended too.
    const fee = feeStated(pub.question);
    if (j.kind === "cancel") return await refuseToPay(j, run, rq.requestId, kit, { detail: fee || "it asked for payment details" });
    await kit.sendPart(run, { type: "input_response", requestId: rq.requestId, action: "decline" });
    await kit.cancelAtCrossmint(run);
    kit.endRow(run, "cancelled", { code: "account job: card details asked for in a form" });
    const done = set(j, { state: "not_done", outcome: "no_safe_path", route: j.route || "none", request_id: "", request_json: "", ask_kind: "", ended_at: clock.now() });
    logAttempt(done);
    if (once(job, "end")) await kit.say(`${notDoneLine(done, "no_safe_path", { detail: "its page wanted card details typed in, which I never do" })}${mailRouteOnce(done)}`);
    return { done: true, status: "cancelled" };
  }

  if (kind === "page") {
    // The one Reason page for this site, carrying Crossmint's protected input (src/pages/webconnect.js).
    // Texted once per run: a later protected question (a code after the password) lands on the same page.
    if (!process.env.CROSSMINT_CLIENT_KEY) return await noRoute("the sign-in page is not set up");
    const link = kit.openSigninLink(run.run_id);
    j = set(j, { state: "needs_page", route: j.route || "sign_in_page" });
    if (link) { q("UPDATE shop_links SET request_id = ?, request_json = ? WHERE id = ? AND conversation_id = ?").run(rq.requestId, JSON.stringify(pub), link.id, run.conversation_id); return { done: false, status }; }
    const token = kit.createLink({ conversationId: run.conversation_id, kind: "signin", store: run.store, runId: run.run_id, request: rq });
    await kit.say(`${siteWords(j)} wants you signed in before I can ${j.kind === "cancel" ? `cancel ${j.what}` : "pay this"}. Sign in once here and it stays signed in for next time. What you type goes straight to ${whereWords(j)}, not to me.\n${kit.linkUrl(token)}`);
    return { done: false, status };
  }
  if (kind === "secret") return await noRoute("it asked for a password in a way I won't pass on");

  const fields = pub.fields ?? [];
  const email = fields.some(isIdentity) ? await emailAt(j) : "";
  const answers = {};
  for (const f of fields.filter(isIdentity)) if (auto(f) !== "tel" && !/\b(phone|mobile)\b/.test(label(f)) && email) answers[f.key] = email;
  const post = (a) => kit.sendPart(run, { type: "input_response", requestId: rq.requestId, action: "submit", response: { kind: "form", answers: a } });
  const asModel = async (text) => { if (await kit.wake(run.conversation_id, text, `acct:${job.id}:${rq.requestId}`)) once(job, `woke:${rq.requestId}`); return { done: false, status, woke: rq.requestId }; };
  const fieldList = fields.map(fieldLine).join("; ");

  if (kind === "identity") {
    const need = fields.filter((f) => f.required && !(f.key in answers));
    if (!need.length && Object.keys(answers).length) {
      const r = await post(answers);
      if (r.ok) { set(j, { state: "running", request_id: "", request_json: "", ask_kind: "" }); kit.setStage(run.run_id, "in_progress"); return { done: false, status, answered: rq.requestId }; }
    }
    j = set(j, { state: "needs_answer" });
    return await asModel(`${eventHead(j)}: ${j.name} asks who they are: "${short(pub.question, 300)}". Fields: ${fieldList}. Answer with account_job_answer (job_id ${j.id}) from what you know about them; if you don't know, ask them in one line. Never a password here.`);
  }

  if (kind === "code") {
    const codeField = fields.find(isCodeLike);
    const where = codeChannel(pub);
    // The code or link the site emailed, read from their own mail by code: nobody is asked.
    if (where !== "text" && mailOn(run.conversation_id)) {
      let got = null;
      try { got = await mailCode(run.conversation_id, { signin_url: `https://${j.host}/` }, { since: run.created_at }); } catch { got = null; }
      if (got?.found && got.kind === "code") {
        const r = await post({ ...answers, [codeField.key]: got.code });
        if (r.ok) { set(j, { state: "running", route: "emailed_code", request_id: "", request_json: "", ask_kind: "" }); kit.setStage(run.run_id, "in_progress"); return { done: false, status, answered: rq.requestId }; }
      } else if (got?.found && got.kind === "link") {
        const r = await kit.sendPart(run, { type: "input_response", requestId: rq.requestId, action: "alternative", text: `Open this sign-in link ${j.name} just emailed me, in this same browser, then carry on: ${got.url}` });
        if (r.ok) { set(j, { state: "running", route: "emailed_link", request_id: "", request_json: "", ask_kind: "" }); kit.setStage(run.run_id, "in_progress"); return { done: false, status, answered: rq.requestId }; }
      }
    }
    // Asked once, in the thread; their reply is passed on with account_job_answer.
    j = set(j, { state: "needs_code", route: j.route || "texted_code" });
    const sent = where === "email" ? "emailed them a code" : where === "text" ? "texted a code to their phone" : "sent them a code";
    return await asModel(`${eventHead(j)}: ${j.name} ${sent}${where === "email" ? (mailOn(run.conversation_id) ? ", and it has not shown up in their mail yet" : ", and their mail is not connected so you cannot read it") : ""}. Ask them ONCE, in one line, to send the code here. When they do, pass it on with account_job_answer (job_id ${j.id}, answers { "${codeField.key}": the code${Object.keys(answers).length ? "" : fields.filter(isIdentity).map((f) => `, "${f.key}": …`).join("")} }). Never repeat the code back, and never ask twice.`);
  }

  if (kind === "confirm") {
    j = set(j, { state: "needs_confirm", route: j.route || "saved_profile" });
    const until = pub.expiresAt ? ` ${j.name}'s page holds this step until ${new Date(Date.parse(pub.expiresAt)).toISOString().slice(11, 16)} UTC (about ten minutes).` : "";
    // The line they are asked, built from the page's own words: the plan, its price where the page gave one, the date access ends.
    const ends = endsFrom(pub.question);
    const price = (String(pub.question ?? "").match(/\$\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:\/|per|a|each)\s?(?:mo(?:nth)?|yr|year|week|wk))?/i) ?? [""])[0];
    const line = `Cancel ${j.what} at ${j.name}${price ? ` (${price})` : ""}? ${ends ? `Access ends ${ends}.` : `${j.name}'s page gave no end date.`}`;
    const money = moneyStated(pub.question);
    // How it got in, said once and by code before the question (never left to the model, never twice).
    if (routeLine(j) && once(job, "routeline")) await kit.say(routeLine(j).trim());
    return await asModel(`${eventHead(j)}: ${j.name} is at the LAST step and asks: "${short(pub.question, 500)}". Fields: ${fieldList}. NOTHING IS CANCELLED YET. Ask them ONE plain line naming exactly what is cancelled and when it ends, as ${j.name} states it, and whether to go ahead. From the page's words that line is: "${line}" (where the page says it differently, a different plan or an end at once, say what the page says).${money ? ` The page also says this about money: "${money}". Put that in the line in its own words.` : ""} Use the same line as confirm_request's summary. Their yes goes through the gate: account_cancel_confirm with job_id ${j.id} and no confirmation_id first (it hands back use_target), then confirm_request, their answer, confirm_record, then account_cancel_confirm again with the confirmation_id. A no: account_job_stop.${until}`);
  }

  // A plain question (which account, a ZIP to find the bill, a reason): the model answers it, or asks them.
  j = set(j, { state: "needs_answer" });
  return await asModel(`${eventHead(j)}: ${j.name} asks: "${short(pub.question, 400)}". Fields: ${fieldList}. Answer with account_job_answer (job_id ${j.id}) from what they told you or the notice; if you don't know, ask them in one line.${j.kind === "cancel" ? (j.confirmed_at ? " They already said yes to this cancellation: answer so it goes through, and decline any offer to stay." : " This is NOT the last step: decline any offer to stay; never agree to anything that costs money.") : " Nothing is paid by answering: the total comes for approval."}`);
}

const BLOCKED = {
  "policy.max_cost_exceeded": "refused_by_cap",
  "merchant.access_blocked": "blocked_browser",
  "merchant.human_verification_required": "human_check",
  "merchant.checkout_error": "site_error",
  "merchant.no_safe_path": "no_safe_path",
  "merchant.payment_declined": "payment_declined",
  "merchant.fulfillment_unavailable": "no_safe_path",
  "product.item_unavailable": "not_found",
  "product.requested_option_unavailable": "not_found",
};
/** Does a result's summary say the subscription is cancelled? The task's own last line first; a plain reading only without it. */
export function saysCancelled(summary) {
  const s = String(summary ?? "");
  if (/RESULT:\s*NOT\s+CANCEL+ED/i.test(s)) return false;
  if (/RESULT:\s*CANCEL+ED/i.test(s)) return true;
  if (/\b(not|n't|unable to|could ?n.t|failed to|did ?n.t|no longer able to)\s+(be(en)?\s+)?cancel/i.test(s) || /\bstill active\b/i.test(s)) return false;
  return /\b(has been|was|is|is now|successfully)\s+cancel+ed\b|\bcancel+ation (is |was )?(confirmed|complete|successful)\b|\bwill not renew\b|\bset to (end|expire)\b/i.test(s);
}
const NOT_FOUND = /\b(no (such |active )?(subscription|plan|membership)|could ?n.t find|not find|does ?n.t exist|no subscriptions?)\b/i;
/** The date access ends, as the site's words gave it: a short phrase lifted from the summary, or "". */
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";
const DATE = `(?:${MONTH} \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?|\\d{1,2}(?:st|nd|rd|th)? ${MONTH}(?:,? \\d{4})?|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4})`;
const ENDS = new RegExp(`\\b(?:access (?:ends|until|through|continues until|runs (?:to|until|through))|ends? on|ends|until|through|expires? on|expires|end date(?: is)?:?)\\s+(?:on\\s+)?(${DATE})`, "i");
export function endsFrom(summary) {
  const m = String(summary ?? "").match(ENDS);
  return m ? m[1].replace(/\.$/, "") : "";
}

/** The run is over: what it proved, said once, with the mail looked at; the attempt logged once. */
async function onEnd(job, run, cur, kit) {
  const status = String(cur.status ?? "");
  // One ending per job, whoever looks first.
  if (!once(job, "ending")) return { done: true, status };
  const result = cur.result ?? (cur.reason ? { code: String(cur.reason) } : null);
  const code = String(result?.code ?? cur.reason ?? "").toLowerCase();
  const summary = String(result?.summary ?? "");
  const paid = q("SELECT * FROM shop_payments WHERE run_id = ? AND conversation_id = ? AND status IN ('paid', 'unknown') ORDER BY id DESC").get(run.run_id, run.conversation_id) ?? null;
  const before = run.stage;
  kit.endRow(run, status, result);
  const link = kit.openSigninLink(run.run_id);
  if (link) { if (status === "succeeded") kit.finishSignin(run, link); else q("UPDATE shop_links SET state = 'failed' WHERE id = ? AND conversation_id = ?").run(link.id, run.conversation_id); }
  const base = { request_id: "", request_json: "", ask_kind: "", summary: short(summary.replace(/RESULT:\s*(NOT\s+)?CANCEL+ED/gi, "").trim(), 300), ended_at: clock.now(), route: job.route || (status === "succeeded" ? "saved_profile" : "none") };
  const finish = async (fields, line) => {
    const done = set(job, { ...base, ...fields });
    logAttempt(done);
    // Their mail was read for a code or a link on the way in: said even when the job did not finish.
    if (once(job, "end")) await kit.say(`${typeof line === "function" ? line(done) : line}${mailRouteOnce(done)}`);
    return { done: true, status };
  };
  const notDone = (reason, extra = {}) => finish({ state: "not_done", outcome: OUTCOMES.includes(reason) ? reason : "service_failed" }, (j) => notDoneLine(j, reason, { detail: summary || code, ...extra }));
  // The result says it worked: the merchant's mail is looked for now, and watched for when it is not there yet.
  const worked = async (fields) => {
    let j = set(job, { ...base, ...fields, seen_result: 1 });
    const mail = await lookForMail(j);
    if (mail.state === "seen") j = set(j, { seen_mail: 1, mail_subject: short(mail.subject, 160), state: "done", outcome: "done" });
    else if (mail.state === "not_connected") j = set(j, j.kind === "bill" && JSON.parse(j.receipt || "{}").kind !== "receipt_captured" ? { state: "not_done", outcome: "unconfirmed" } : { state: "done", outcome: "done_result_only" });
    else { j = set(j, { state: "not_done", outcome: "waiting_mail", mail_until: clock.now() + MAIL_WATCH_MS }); watchMail(j.conversation_id, j.id); }
    logAttempt(j);
    // How it got in is said once: with the last step's question, or here when no question came.
    const by = routeLine(j) && once(job, "routeline") ? routeLine(j) : "";
    // A cancellation that went through without stopping for their yes is said as that, never passed over.
    const unasked = j.kind === "cancel" && !j.confirmed_at ? ` It went through without stopping for your yes at the last step, which I had asked ${j.name}'s page to do.` : "";
    if (once(job, "end")) await kit.say(`${resultLine(j, mail)}${unasked}${by}`);
    return { done: true, status };
  };
  const bought = ["receipt_captured", "confirmed_without_receipt"].includes(String(result?.purchase?.kind ?? ""));

  if (job.kind === "cancel") {
    // A purchase on a run that only cancels: never "done", said at once with what the page reported.
    if (status === "succeeded" && bought) {
      const total = result.purchase?.receipt?.total?.amount ? `$${Number(result.purchase.receipt.total.amount).toFixed(2)}` : "";
      return await finish({ state: "not_done", outcome: "unexpected_purchase" }, (j) => notDoneLine(j, "unexpected_purchase", { detail: total }));
    }
    if (status === "succeeded") {
      if (saysCancelled(summary)) return await worked({ ends: endsFrom(summary) });
      return await notDone(NOT_FOUND.test(summary) ? "not_found" : "not_cancelled");
    }
    // Their yes went to the site and the run broke before the result: unknown, and their mail is watched.
    if (job.confirmed_at && status !== "cancelled" && !BLOCKED[code]) {
      const j = set(job, { ...base, state: "not_done", outcome: "unconfirmed", mail_until: clock.now() + MAIL_WATCH_MS });
      watchMail(j.conversation_id, j.id);
      logAttempt(j);
      if (once(job, "end")) await kit.say(`${notDoneLine(j, "unconfirmed", { detail: code })}${mailOn(j.conversation_id) ? ` I'm watching your email for ${j.name}'s cancellation notice and will tell you if it lands.` : ` Check ${j.name} to be sure.`}`);
      return { done: true, status };
    }
    if (status === "blocked") return await notDone(BLOCKED[code] ?? "no_safe_path");
    if (status === "cancelled") return await notDone(job.outcome === "declined" ? "declined" : "stopped");
    if (code === "input_expired") return await notDone(job.state === "needs_confirm" ? "no_answer" : ["needs_page", "needs_code"].includes(job.state) ? "no_signin" : "no_answer");
    return await notDone("service_failed");
  }

  // ---- a bill
  if (status === "succeeded") {
    const p = result?.purchase ?? {};
    if (p.kind === "receipt_captured" || p.kind === "confirmed_without_receipt") {
      const receipt = { kind: p.kind, total: p.receipt?.total?.amount ? Number(p.receipt.total.amount).toFixed(2) : "", order: short(p.receipt?.merchantOrderId ?? "", 40) };
      // Paid, but not through the approval they give (a card saved at the biller): never "done", said as what it is.
      const approved = paid ?? q("SELECT id FROM shop_payments WHERE run_id = ? AND conversation_id = ? AND status = 'paying'").get(run.run_id, run.conversation_id) ?? null;
      if (!approved) return await finish({ state: "not_done", outcome: "paid_unapproved", receipt: JSON.stringify(receipt), paid_at: clock.now() }, (j) => notDoneLine(j, "paid_unapproved", { detail: receiptWords(receipt) }));
      return await worked({ receipt: JSON.stringify(receipt), paid_at: job.paid_at ?? run.paid_at ?? clock.now() });
    }
    return await notDone("nothing_paid");
  }
  // An approved payment went out and the run ended without a result: never "nothing was paid".
  if (paid) {
    const j = set(job, { ...base, state: "not_done", outcome: "unconfirmed", paid_at: job.paid_at ?? run.paid_at ?? clock.now(), mail_until: clock.now() + MAIL_WATCH_MS });
    watchMail(j.conversation_id, j.id);
    logAttempt(j);
    if (once(job, "end")) await kit.say(`${notDoneLine(j, "unconfirmed", { detail: code })}${mailOn(j.conversation_id) ? ` I'm watching your email for ${j.name}'s confirmation and will tell you if it lands.` : ` Check your ${j.name} account before paying again.`}`);
    return { done: true, status };
  }
  if (status === "blocked") return await notDone(BLOCKED[code] ?? "no_safe_path");
  if (status === "cancelled") return await notDone(job.outcome === "declined" ? "declined" : "stopped");
  if (before === "needs_approval") return await notDone("approval_timeout");
  if (code === "input_expired") return await notDone(["needs_page", "needs_code"].includes(job.state) ? "no_signin" : "no_answer");
  return await notDone("service_failed");
}

// ---------------------------------------------------------------- the model's side (src/accountjobtools.js)
const openRequest = (job) => { try { return job.request_json ? JSON.parse(job.request_json) : null; } catch { return null; } };
/** The job's run, and only when it is the same person's. */
const runOf = (job) => { const r = job.run_id ? shop.runRow(job.run_id) : null; return r && r.conversation_id === job.conversation_id ? r : null; };
/** What the confirm gate pins a cancellation's yes to: this job, this plan and site, this run and this very question. */
export function cancelTarget(conversationId, jobId) {
  const job = jobRow(conversationId, jobId);
  if (!job || job.kind !== "cancel") return `unknown account job #${jobId}`;
  return `acct:cancel #${job.id} "${job.what}" at ${job.host} [${job.run_id}/${job.request_id || "no open question"}]`;
}
const YES_OPTION = /\b(yes|confirm|cancel (my |the |this )?(plan|subscription|membership|it)|proceed|continue|finish|end (my |the )?(plan|subscription))\b/i;
const NO_OPTION = /\b(no\b|keep|stay|go back|never ?mind|don'?t cancel|do not cancel|not now)/i;
/** The yes, in the shape the last step's form takes: true for a tick box, the "yes, cancel" option of a choice, "Yes" for words. null when it cannot be told. */
export function confirmAnswers(rq) {
  const out = {};
  for (const f of rq?.fields ?? []) {
    const k = f?.input?.kind;
    if (k === "boolean") out[f.key] = true;
    else if (k === "choice") {
      const opts = (f.input.options ?? []).filter((o) => o && !o.disabled && !o.placeholder);
      const lab = (o) => String(typeof o === "string" ? o : o?.label ?? o?.value ?? "");
      const yes = opts.filter((o) => YES_OPTION.test(lab(o)) && !NO_OPTION.test(lab(o)));
      if (yes.length !== 1) { if (f.required) return null; continue; }
      const v = typeof yes[0] === "string" ? yes[0] : yes[0].value ?? yes[0].label;
      out[f.key] = f.input.selection?.kind === "many" ? [v] : v;
    } else if (k === "text" || k === "multiline" || !k) { if (f.required) out[f.key] = "Yes, cancel it."; }
    else if (f.required) return null;
  }
  return Object.keys(out).length ? out : null;
}
/** Only keys the open question asked for, plain values only, every required one present. */
function checkPlain(rq, answers) {
  const fields = new Map((rq?.fields ?? []).map((f) => [f.key, f]));
  const out = {};
  for (const [k, v] of Object.entries(answers ?? {})) {
    const f = fields.get(k);
    if (!f) return { ok: false, error: "unknown_field", fields: [...fields.keys()] };
    if (f.handling === "protected") return { ok: false, error: "protected_field" };
    const okType = ["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === "string"));
    if (!okType || String(v).length > 500) return { ok: false, error: "bad_value" };
    out[k] = v;
  }
  for (const f of rq?.fields ?? []) if (f.required && !(f.key in out)) return { ok: false, error: "missing_field", fields: [...fields.keys()] };
  return { ok: true, answers: out };
}
const send = (run, requestId, answers) => shop.sendPart(run, { type: "input_response", requestId, action: "submit", response: { kind: "form", answers } });

/**
 * The cancellation's last step, answered yes. Only ever called by account_cancel_confirm AFTER the gate
 * (src/trust.js) found a granted yes whose target is cancelTarget for this job's open question.
 */
export async function confirmCancel({ conversationId, jobId, answers = null }) {
  const job = jobRow(conversationId, jobId);
  if (!job || job.kind !== "cancel") return { ok: false, error: "no_such_job" };
  const rq = openRequest(job);
  const run = runOf(job);
  if (job.state !== "needs_confirm" || !rq || !run || run.status !== "running") {
    return { ok: false, error: "nothing_to_confirm", state: job.state, say: `Nothing was sent: job ${job.id} is not waiting at its last step (${job.state.replace(/_/g, " ")}). account_job_status says where it is. Nothing was cancelled by this call.` };
  }
  if (rq.expiresAt && !(Date.parse(rq.expiresAt) >= clock.now())) return { ok: false, error: "step_expired", say: `Nothing was sent: ${job.name}'s page stopped holding that last step. ${job.what} is unchanged. Say so, and start the cancellation again only if they ask.` };
  const shaped = answers && Object.keys(answers).length ? checkPlain(rq, answers) : { ok: !!confirmAnswers(rq), answers: confirmAnswers(rq) };
  if (!shaped.ok || !shaped.answers) return { ok: false, error: shaped.error ?? "cannot_shape_yes", fields: (rq.fields ?? []).map(fieldLine), say: "Nothing was sent: the page's last step could not be answered by code. Call this again with `answers` giving each field its exact option for going ahead with the cancellation." };
  // Claimed before the call, so two confirms at once cannot both answer.
  if (q("UPDATE account_jobs SET state = 'confirming', confirmed_at = ? WHERE conversation_id = ? AND id = ? AND state = 'needs_confirm'").run(clock.now(), conversationId, job.id).changes !== 1) return { ok: false, error: "already_confirming" };
  const r = await send(run, rq.requestId, shaped.answers);
  if (!r.ok) {
    q("UPDATE account_jobs SET state = 'needs_confirm', confirmed_at = NULL WHERE conversation_id = ? AND id = ? AND state = 'confirming'").run(conversationId, job.id);
    return { ok: false, error: "service_refused", status: r.status, say: `Nothing was sent: the service refused the answer (${r.status ?? "no answer"}). ${job.what} is unchanged so far. Say so plainly.` };
  }
  q("UPDATE account_jobs SET request_id = '', request_json = '', ask_kind = '' WHERE conversation_id = ? AND id = ?").run(conversationId, job.id);
  return { ok: true, job_id: job.id, say: `Their yes is with ${job.name} now. It is NOT done yet: I text them the result myself when ${job.name}'s page shows it and their cancellation email is checked. Say only that it's going through; never say it is cancelled.` };
}

/** A plain answer to a job's open question (their email, a ZIP, a code they sent in the thread). Never a cancellation's last step, never a password. */
export async function answerJob({ conversationId, jobId, answers }) {
  const job = jobRow(conversationId, jobId);
  if (!job) return { ok: false, error: "no_such_job" };
  const rq = openRequest(job);
  const run = runOf(job);
  if (!rq || !run || run.status !== "running" || !["needs_answer", "needs_code"].includes(job.state)) {
    if (job.state === "needs_confirm") return { ok: false, error: "needs_the_gate", say: "That question is the cancellation's last step: only account_cancel_confirm answers it, after their yes through the gate." };
    if (job.state === "needs_page") return { ok: false, error: "needs_the_page", say: "That question has a password or a sealed code in it: it is answered on the sign-in page they were texted, never through you." };
    return { ok: false, error: "nothing_asked", state: job.state };
  }
  // Money details are never passed on, whoever typed them: a card or bank field, or (a cancellation) any way to pay.
  if (classify(job, rq) === "pay") return { ok: false, error: "never_payment_details", say: "Nothing was sent: that question asks for payment details, and those never go through here. Do not ask them for a card number." };
  // A cancellation's go-ahead never rides in on a plain answer: only account_cancel_confirm, after their yes through the gate.
  if (job.kind === "cancel" && classify(job, rq) === "confirm") return { ok: false, error: "needs_the_gate", say: "That question is the cancellation's last step: only account_cancel_confirm answers it, after their yes through the gate." };
  const checked = checkPlain(rq, answers);
  if (!checked.ok) return { ...checked, say: "Nothing was sent: give every required field, with the keys exactly as the event listed them." };
  const r = await send(run, rq.requestId, checked.answers);
  if (!r.ok) return { ok: false, error: "service_refused", status: r.status };
  set(job, { state: "running", request_id: "", request_json: "", ask_kind: "" });
  q("UPDATE shop_runs SET stage = 'in_progress', stage_at = ?, progress_at = ?, updated_at = ? WHERE run_id = ? AND conversation_id = ?").run(clock.now(), clock.now(), clock.now(), run.run_id, conversationId);
  return { ok: true, job_id: job.id, answered: Object.keys(checked.answers), say: `Passed on. ${job.kind === "cancel" ? "Nothing is cancelled yet" : "Nothing is paid yet"}; say nothing more unless they are waiting on a word.` };
}

/** They said no, or changed their mind: the open question is declined and the run ended. */
export async function stopJob({ conversationId, jobId, by = "them" }) {
  const job = jobRow(conversationId, jobId);
  if (!job) return { ok: false, error: "no_such_job" };
  if (!isOpen(job)) return { ok: false, error: "already_over", state: job.state, say: `Job ${job.id} is already over (${job.outcome || job.state}).` };
  // A cancellation whose yes already went in cannot be called back from here; a bill already approved neither.
  if (job.state === "confirming" || job.state === "paid") return { ok: false, error: "too_late", say: job.kind === "cancel" ? `Their yes already went to ${job.name}; this can't call it back. Say so plainly.` : `The payment was already approved; this can't call it back. Say so plainly.` };
  const run = runOf(job);
  set(job, { outcome: by === "them" ? "declined" : "stopped" });
  if (run && run.status === "running") {
    if (job.request_id) await shop.sendPart(run, { type: "input_response", requestId: job.request_id, action: "decline" });
    const open = shop.openPayment(conversationId);
    if (open && open.run_id === run.run_id) { try { await shop.declinePayment({ conversationId, paymentId: open.id, by: by === "them" ? "them" : "reason" }); } catch { /* it expires on its own */ } }
    await shop.cancelAtCrossmint(run);
  }
  return { ok: true, job_id: job.id, say: `${notDoneLine(job, by === "them" ? "declined" : "stopped")} Say that in one line.` };
}

/** What a job's sign-in page says it is for (src/shopconnect.js linkView → src/pages/webconnect.js): the kind, the plan or the biller. */
export function linkWords(run) {
  const job = jobOfRun(run);
  return job ? { kind: job.kind === "bill" ? "bill" : "cancel", what: job.what, name: job.name } : null;
}
/** Any job of theirs still open: while one is, no sign-in link is made for any site (the job signs in itself). */
export function openJobFor(conversationId) {
  return q(`SELECT * FROM account_jobs WHERE conversation_id = ? AND state IN (${OPEN_STATES.map(() => "?").join(", ")}) ORDER BY id DESC`).get(String(conversationId), ...OPEN_STATES) ?? null;
}
/** The job working on a site (open, or started in the last day): what refuses a sign-in link for that site. */
export function jobForSite(conversationId, site) {
  const raw = String(site ?? "").trim().toLowerCase();
  const host = hostOf(raw) || hostOf(raw.replace(/^https?:\/\//, "").split("/")[0]);
  if (!host) return null;
  const base = registrableOf(host);
  const rows = q(`SELECT * FROM account_jobs WHERE conversation_id = ? AND (created_at > ? OR state IN (${OPEN_STATES.map(() => "?").join(", ")})) ORDER BY id DESC LIMIT 20`).all(String(conversationId), clock.now() - 24 * 3600_000, ...OPEN_STATES);
  return rows.find((j) => registrableOf(j.host) === base) ?? null;
}

const STATE_WORDS = {
  running: "working inside the account", needs_page: "waiting on their sign-in on the page they were texted", needs_code: "waiting on the code they were asked for",
  needs_answer: "waiting on an answer", needs_confirm: "at the last step, waiting on their yes", confirming: "their yes is in; waiting on the site's result",
  needs_approval: "waiting on their approval of the exact total", paid: "approved; waiting on the biller's receipt",
};
/** Where their account jobs stand, from the record: what the model answers "did it cancel?" from. */
export function statusView(conversationId, { sinceMs = 48 * 3600_000 } = {}) {
  const rows = q(`SELECT * FROM account_jobs WHERE conversation_id = ? AND (created_at > ? OR state IN (${OPEN_STATES.map(() => "?").join(", ")})) ORDER BY id DESC LIMIT 8`).all(conversationId, clock.now() - sinceMs, ...OPEN_STATES);
  return rows.map((j) => ({
    job_id: j.id, kind: j.kind, what: whatOf(j), state: j.state,
    line: isOpen(j) ? STATE_WORDS[j.state] ?? j.state
      : j.state === "done" ? `done (${j.seen_mail ? "their page and their email both seen" : "their page seen; email not checked"})`
        : j.outcome === "waiting_mail" ? "their page said it worked; their email has not arrived yet, so not called done"
          : `not done: ${j.outcome.replace(/_/g, " ")}`,
    ...(j.ends ? { ends: j.ends } : {}),
    ...(j.summary ? { site_said: j.summary } : {}),
  }));
}

/** The record in front of the model on their turns (src/shopconnect.js checkoutNote): "" when there is nothing, or the switch is off for them. */
export function noteFor(conversationId) {
  if (!jobsAllowedFor(conversationId)) return "";
  const list = statusView(conversationId, { sinceMs: 24 * 3600_000 });
  if (!list.length) return "";
  return `Account jobs (code's own record; it overrides anything the chat says about them):\n${list.map((j) => `- #${j.job_id} ${j.kind === "cancel" ? "cancel" : "pay"} ${j.what}: ${j.line}.`).join("\n")}\n`
    + "Answer anything about a cancellation or a bill from this (account_job_status has the same). Never say one is cancelled or paid unless it reads done here; a result is texted to them by code the moment it is known.";
}

// ---------------------------------------------------------------- can a job be finished? (the daily note's test)
/**
 * Is there a complete route for this job, for this person, right now? What a daily-note card that
 * offers it has to pass: the switch on for them AND the job has what it needs —
 *   a saved signed-in profile for the site (they signed in there through a checkout or a job), or
 *   a site that already let them in by an emailed code or link, with their mail still connected, or
 *   (a bill) every reference present, for the biller's guest page.
 */
export function canFinish(conversationId, { kind, site, amount = "", reference = "" } = {}) {
  if (!jobsAllowedFor(conversationId)) return { ok: false, why: "switch_off" };
  const at = startUrlFor(site);
  if (!at) return { ok: false, why: "no_site" };
  if (kind === "bill") {
    const amt = String(amount ?? "").replace(/[$,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(amt) || !(Number(amt) > 0) || !String(reference ?? "").trim()) return { ok: false, why: "missing_reference" };
    if (!shop.cardOf(conversationId)) return { ok: false, why: "no_card" };
    return { ok: true, route: "guest_pay_or_account" };
  }
  if (kind !== "cancel") return { ok: false, why: "unknown_kind" };
  const store = shop.storeKey(at.host);
  if (store && shop.isConnected(conversationId, store)) return { ok: true, route: "saved_profile" };
  const before = q("SELECT route FROM account_jobs WHERE conversation_id = ? AND host = ? AND route IN ('emailed_code', 'emailed_link') AND seen_result = 1 ORDER BY id DESC").get(conversationId, at.host);
  if (before && mailOn(conversationId)) return { ok: true, route: before.route };
  return { ok: false, why: "no_signed_in_route" };
}
