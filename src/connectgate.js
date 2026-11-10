// Who may finish an OAuth connect link (security lead 1, 2026-11-07).
//
// A connect link's `state` is bound to the conversation that asked for it. Until now that was the
// whole binding: the callback saved whatever account the provider handed back under that
// conversation, whoever's browser came back with it. So anyone could ask Reason for a GitHub /
// Google / Spotify / X / Uber link in their own thread, forward it, and the person who agreed on the
// provider's page attached THEIR account to the sender's Reason — repo access, a mailbox, a calendar.
//
// Now the browser that finishes has to be the asker's, proved the same way a private page is proved
// (src/pages/access.js): the `reason_page` session cookie, earned once with a six-digit code texted
// to that person's own thread. Two places check it:
//
//   - the link Reason texts is its own start page, not the provider's. A browser already signed in
//     as the asker is sent straight on to the provider (nothing changes for them); any other browser
//     gets the code gate first, and the code goes to the thread that asked for the link — which a
//     person who was forwarded the link does not have.
//   - every provider callback refuses unless the browser coming back is signed in as the state's
//     conversation, so the provider's raw address, lifted off the start page's redirect and
//     forwarded, connects nothing either.
//
// The start page and the callbacks share a host (the start link is built on the redirect address's
// origin), so the cookie the gate sets is the cookie the callback reads.
import { createHash } from "node:crypto";
import * as db from "./db.js";
import { readCookie, readCookies, cookieHeader, trySubmittedCode, issueCode, codeHost, boundTo, SESSION_TTL_MS, ATTEMPT_WINDOW_MS, MAX_CODES_SENT, MAX_FAILED_ATTEMPTS, CODE_TTL_MS } from "./pages/access.js";
import { renderConnectGate, renderConnected } from "./pages/render.js";
import { securedCardTags, providerKind } from "./pages/securedcard.js";

export const START_PATH = "/connect/start";

const NAMES = { github: "GitHub", spotify: "Spotify", x: "X", uber: "Uber", google: "Google" };
const nameOf = (provider) => NAMES[provider] ?? "your account";

/**
 * The link to text: Reason's start page for this state, on the same origin as the redirect address.
 * The provider's own address is kept on the state row and only ever handed to a proved browser.
 */
export function startLink(state, providerUrl, redirectUri) {
  db.setOauthStateAuthorizeUrl(state, providerUrl);
  let origin;
  try { origin = new URL(redirectUri).origin; } catch { origin = ""; }
  return `${origin}${START_PATH}?state=${encodeURIComponent(state)}`;
}

// The sign-ins a connect trusts: Reason Web's (`wsign:`, a same-origin form with a form token) and
// this gate's own (`connect:`, same-origin only). Every other gate that leaves a `reason_page`
// session (events, albums, directions, private pages, /ops) is not counted: a callback that took any
// session would be only as safe as the weakest of them, and one of those planted in a victim's
// browser by a cross-site post would carry the asker's identity to the provider's callback.
const TRUSTED_SIGNIN = /^(wsign|connect):/;

/**
 * The conversation this browser is signed in as through a trusted sign-in, or null. Also what a
 * remote sign-in link (src/signin-remote.js, lead 6) asks before Start: one browser, proved once,
 * is remembered for both.
 */
export function browserConversation(headers) {
  for (const token of new Set([readCookie(headers?.cookie), ...readCookies(headers?.cookie)].filter(Boolean))) {
    if (!TRUSTED_SIGNIN.test(db.pageSessionSource(token) ?? "")) continue;
    const owner = db.pageSessionOwner(token, SESSION_TTL_MS);
    if (owner) return owner;
  }
  return null;
}

/**
 * The provider's callback, before anything is exchanged or saved: null to go on, or the refusal.
 *
 * Goes on (null) when the state is not a live one of this provider's — the provider module gives
 * its own "used, expired or not ours" answer and saves nothing — and when the provider sent back an
 * error (they said no; nothing is saved either). Otherwise the browser must be signed in as the
 * state's conversation. A refused state is spent, so the same callback cannot be tried again
 * somewhere else.
 */
export function refuseForeignBrowser({ provider, state, error = "", headers }) {
  const row = db.peekOauthState(state);
  if (!row || row.provider !== provider || error) return null;
  if (browserConversation(headers) === row.conversation_id) return null;
  db.spendOauthState(state);
  return {
    ok: false,
    reason: "foreign_browser",
    conversationId: row.conversation_id,
    error: `Nothing was connected. This link only finishes in the browser of the person whose Reason thread it came from. If that is you, ask Reason for a new ${nameOf(provider)} link and open it in this browser.`,
  };
}

/**
 * The pseudo page a conversation's browser-proving codes are counted and rate limited under, and the
 * source of the `connect:` session a right code leaves. Shared with remote sign-in links, so a
 * browser proved on either is the person's own for both, and the limits are one per person.
 */
export function proofPage(conversationId, title) {
  const id = `connect:${createHash("sha256").update(String(conversationId)).digest("hex").slice(0, 24)}`;
  return { id, conversation_id: conversationId, title };
}
const gatePage = (row) => proofPage(row.conversation_id, `Connect ${nameOf(row.provider)}`);

function codeLine(provider, code, host) {
  const mins = Math.round(CODE_TTL_MS / 60000);
  return `Your Reason code is ${code}, to connect ${nameOf(provider)} on that browser. Good for ${mins} minutes. If that wasn't you, ignore this — nothing was connected.${boundTo(host, code)}`;
}

const HTML = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };

/**
 * One request to the start page. Pulled out of the server so a test can drive it without a socket.
 *
 * A GET never texts anything (a link preview fetches it too); only the button does. A state that was
 * used, replaced by a newer link, or never existed answers the same plain "ask for a new one" page
 * and offers nothing to send.
 */
export async function connectStartRequest({ state, method, headers, readBody, runtime, log = () => {} }) {
  const row = db.peekOauthState(state);
  if (!row || !row.authorize_url || !NAMES[row.provider]) {
    return {
      status: 400, headers: HTML,
      body: renderConnected({ ok: false, title: "Link expired", lines: ["This link has already been used, or a newer one replaced it. Ask Reason for a new one."], head: `\n${securedCardTags("connect")}` }),
    };
  }
  const provider = nameOf(row.provider);
  const onward = (extra = {}) => ({ status: 302, headers: { ...HTML, Location: row.authorize_url, ...extra }, body: "" });
  const gate = ({ status = 401, sent = false, error = "" } = {}) => ({ status, headers: HTML, body: renderConnectGate({ provider, sent, error, head: securedCardTags(providerKind(row.provider)) }) });

  // The asker's own browser: straight on, nothing to type.
  if (browserConversation(headers) === row.conversation_id) return onward();

  const page = gatePage(row);
  const locked = db.failedPageAttempts(page.id, ATTEMPT_WINDOW_MS) >= MAX_FAILED_ATTEMPTS;
  const lockedWords = `Too many wrong codes. Try again in about ${Math.ceil(ATTEMPT_WINDOW_MS / 60000)} minutes.`;

  if (method === "POST") {
    // Only from this page itself. Without it, a page anywhere could post the asker's own code from
    // a victim's browser (login CSRF): the victim's browser would be signed in as the asker and
    // sent on to the provider, and its callback would pass, without the victim typing anything.
    // Loaded here, not at the top: websignin's own imports reach back to modules that load this one
    // (notice.js ← alerts.js), and a static import put KINDS in its temporal dead zone.
    const { sameOrigin } = await import("./pages/websignin.js");
    if (!sameOrigin(headers)) {
      log({ connect_cross_site_post: row.provider });
      return gate({ status: 403, error: "This page has to be used directly. Open the link Reason texted again." });
    }
    const form = new URLSearchParams(String((await readBody?.()) ?? ""));
    if (form.has("send")) {
      if (locked) return gate({ status: 429, error: lockedWords });
      if (db.pageCodesIssued(page.id, ATTEMPT_WINDOW_MS) >= MAX_CODES_SENT) {
        log({ connect_code_refused: row.provider, conversation: row.conversation_id });
        return gate({ sent: true, error: `Reason has already texted a code. Use that one, or try again in about ${Math.ceil(ATTEMPT_WINDOW_MS / 60000)} minutes.` });
      }
      const { id, code } = issueCode(page.id);
      const line = codeLine(row.provider, code, codeHost(`http://${String(headers?.host ?? "")}`));
      // `pcode:` keeps the code out of the conversation's history (db.js HISTORY_EXCLUDED_KEYS) and
      // stops a retried send texting it twice.
      try {
        // _tell answers a refused send rather than throwing it; either way it is logged.
        const told = runtime?._tell
          ? await runtime._tell(row.conversation_id, line, { idempotencyKey: `pcode:${page.id}:${id}` })
          : runtime?.say?.(row.conversation_id, line);
        if (told && told.ok === false) log({ connect_code_text_failed: row.provider, why: String(told.error ?? told.reason ?? "refused").split("\n")[0] });
      } catch (e) {
        log({ connect_code_text_failed: row.provider, why: (e?.message ?? String(e)).split("\n")[0] });
      }
      log({ connect_code_sent: row.provider, conversation: row.conversation_id });
      return gate({ status: 200, sent: true });
    }
    const tried = trySubmittedCode({ page, code: form.get("code") ?? "" });
    if (tried.ok) {
      log({ connect_browser_proved: row.provider, conversation: row.conversation_id });
      // 303 so the provider's page is a GET. Path "/" so the cookie comes back on the callback.
      return { status: 303, headers: { ...HTML, Location: row.authorize_url, "Set-Cookie": cookieHeader(tried.token, { path: "/", headers }) }, body: "" };
    }
    if (tried.reason === "rate_limited") return gate({ status: 429, error: lockedWords });
    return gate({ error: `That code is not right.${tried.tries_left ? ` ${tried.tries_left} ${tried.tries_left === 1 ? "try" : "tries"} left.` : ""}` });
  }
  if (method !== "GET" && method !== "HEAD") return { status: 405, headers: HTML, body: "" };
  if (locked) return gate({ status: 429, error: lockedWords });
  return gate();
}
