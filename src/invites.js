// Invite-only growth: somebody who has a Reason hands a friend a link, and the friend gets their own.
//
// The rules were decided before this was written and are kept exactly:
//
//   - **Two invites each, for life.** Everybody who was here before invites existed, and everybody
//     who came in some other way, starts with DEFAULT_INVITES (src/db.js). People who joined through
//     an invite start with 0, stored as a row so it can change later without a schema change. Not
//     refilling: more arrive only when the master approves a request.
//   - **One link per invite, single use, never expiring, tied to no number.** A link is a random
//     token. Whoever proves a phone first claims it.
//   - **Opening a link spends nothing.** The page is a read. Link previews, forwards and a hundred
//     opens leave the row exactly as it was. The invite is spent only in `db.redeemInvite`, in the
//     same transaction that creates the account — so two people racing for one link get exactly one
//     winner, and the other is told it has already been claimed.
//   - **Cancelling or replacing a link never costs the inviter anything.** The allowance drops only
//     on a successful join.
//
// How the phone is proved. The spec asks for Reason to text the invitee a code. It cannot: the live
// line is on Sendblue's inbound-only plan, so it may only text numbers that have texted it first,
// and a brand-new invitee by definition has not. So the proof runs the other way round. The page
// opens a text TO Reason with the invite's claim code already written in, the invitee presses send,
// and that inbound text — which can only come from the phone that holds the number — is the
// verification and the claim at once (src/channels/router.js `#claimInvite`). The account is then
// made through the ordinary admission path, so the harm screen and onboarding run as for anybody.
import * as db from "./db.js";
import { config, normalizeNumber, stamp } from "./config.js";
import { shell, esc, renderNotFound, foot } from "./pages/render.js";
import { inviteCardKey } from "./invitecard.js";
import { CONFETTI_JS, CONFETTI_CSS } from "./pages/confetti.js";

/** The path an invite link lives at. On the files domain Caddy rewrites `/i/x` to `/p/i/x`. */
export const INVITE_PATH = "/i";

/** Where a link points: the files domain when there is one, otherwise this server's own address. */
export function inviteUrl(token) {
  if (config.pagesUrl) return `${config.pagesUrl}${INVITE_PATH}/${token}`;
  const base = (config.publicUrl || `http://${config.host}:${config.port}`).replace(/\/+$/, "");
  return `${base}${INVITE_PATH}/${token}`;
}

/** "ABCD-EFGH": how a claim code is shown and prefilled. */
export function formatCode(code) {
  const c = String(code ?? "").toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** "+1 (656) 216-7455" for a North American number, the number as it is otherwise. */
export function prettyNumber(n) {
  const x = normalizeNumber(n);
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(x);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : x;
}

/** The text the page prefills. Reads as somebody saying hello, because that is what it is. */
export function joinText(code) {
  return `Hi Reason, I'm joining with invite code ${formatCode(code)}`;
}

/**
 * The name an invitee sees for the person who invited them, or null when Reason has none.
 *
 * The name already on the account — the one they told Reason with my_name — and for the master,
 * the configured owner name. Nothing else: a name Reason guessed is not one to put on a page a
 * stranger opens.
 */
export function inviterName(conversationId) {
  const acct = db.getAccount(conversationId);
  if (acct?.name) return acct.name;
  if (acct?.is_operator || conversationId === config.ownerConversation) return config.ownerName;
  return null;
}

/** One link as the person who owns it sees it. The URL only while it can still be used. */
function linkView(inv) {
  return {
    number: inv.id,
    state: inv.state,
    ...(inv.state === "unused" ? { link: inviteUrl(inv.token) } : {}),
    made: stamp(inv.created_at),
    ...(inv.state === "redeemed" ? { claimed: stamp(inv.redeemed_at) } : {}),
    ...(inv.state === "canceled" ? { canceled: stamp(inv.canceled_at) } : {}),
  };
}

function requestView(r) {
  return r ? { request_number: r.id, count: r.requested_count, explanation: r.explanation, state: r.state, filed: stamp(r.created_at), last_changed: stamp(r.updated_at) } : null;
}

/**
 * "my invites": every link and its state, how many are left, and any request for more.
 *
 * Who claimed a link is deliberately not here. The inviter was told once, by name, when it
 * happened; a standing list of who joined is a list of other people's accounts.
 */
export function myInvites(conversationId) {
  const remaining = db.inviteAllowance(conversationId);
  const links = db.listInvites(conversationId).map(linkView);
  const unused = links.filter(l => l.state === "unused").length;
  return {
    ok: true,
    invites_left: remaining,
    links_you_can_still_make: Math.max(0, remaining - unused),
    links,
    pending_request: requestView(db.pendingInviteRequest(conversationId)),
  };
}

/**
 * Mint one link. Refuses without a display name, because the page a friend opens says who
 * invited them and Reason will not put a guess there.
 */
export function makeLink(conversationId) {
  const name = inviterName(conversationId);
  if (!name) return { ok: false, needs_name: true };
  const out = db.createInvite(conversationId);
  if (!out.ok) return { ok: false, none_left: true, invites_left: out.remaining, unused_links: out.unused };
  return { ok: true, link: inviteUrl(out.invite.token), number: out.invite.id, shown_as: name, invites_left: db.inviteAllowance(conversationId) };
}

/**
 * Cancel one unused link, and by default hand back a fresh one in its place. The invite itself is
 * not lost either way: the allowance is untouched, and the slot the old link held is free again.
 */
export function cancelLink(conversationId, number, { replace = true } = {}) {
  const inv = db.getInvite(conversationId, number);
  if (!inv) return { ok: false, reason: "not_yours" };
  if (inv.state !== "unused") return { ok: false, reason: inv.state };
  if (!db.cancelInvite(conversationId, number)) return { ok: false, reason: "changed" };
  const out = { ok: true, canceled: number, invites_left: db.inviteAllowance(conversationId) };
  if (!replace) return out;
  const fresh = makeLink(conversationId);
  return fresh.ok ? { ...out, replacement: { number: fresh.number, link: fresh.link } } : { ...out, replacement: null, why_no_replacement: fresh };
}

/** The line the master gets about one request, naming it by its real number. */
export function requestLineForMaster(request, { updated = false } = {}) {
  const acct = db.getAccount(request.conversation_id);
  const who = [acct?.name || null, acct?.address || null].filter(Boolean).join(", ") || request.conversation_id;
  const n = request.requested_count;
  return [
    `invite request #${request.id}${updated ? " (updated)" : ""}: ${who} is asking for ${n} more invite${n === 1 ? "" : "s"}.`,
    `why: "${request.explanation}"`,
    `want to give them more? just let me know either way.`,
  ].join("\n");
}

/**
 * File a request for more invites, or update the one already pending. Both a count and an
 * explanation are required; there is no cap on the count.
 */
export function requestMore(conversationId, { count, explanation }) {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n < 1) return { ok: false, missing: "count" };
  const why = String(explanation ?? "").trim();
  if (!why) return { ok: false, missing: "explanation" };
  const { request, updated } = db.upsertInviteRequest(conversationId, { count: n, explanation: why.slice(0, 1000) });
  // The master gets this one in full, then every other request still waiting, each by its number,
  // so one text is the whole list he can approve or decline from.
  const rest = db.pendingInviteRequests().filter(r => r.id !== request.id)
    .map(r => `#${r.id}: ${db.getAccount(r.conversation_id)?.name || "someone"}, ${r.requested_count} more`);
  const toMaster = requestLineForMaster(request, { updated }) + (rest.length ? `\nalso waiting:\n${rest.join("\n")}` : "");
  return { ok: true, updated, request, toMaster };
}

/** Every pending request, as the master reads them. */
export function pendingForMaster() {
  return db.pendingInviteRequests().map(r => {
    const acct = db.getAccount(r.conversation_id);
    return { request_number: r.id, from: acct?.name || null, number: acct?.address || null, count: r.requested_count, explanation: r.explanation, filed: stamp(r.created_at) };
  });
}

/**
 * The master approves or declines one request by its number. Returns what to tell the requester.
 * The master-only check is the caller's (src/tools.js), next to the other admin tools.
 */
export function decide(requestId, { approve, count = null }) {
  const before = db.getInviteRequest(requestId);
  if (!before) return { ok: false, reason: "no_such_request" };
  if (before.state !== "pending") return { ok: false, reason: before.state };
  const after = db.decideInviteRequest(requestId, { approve, count });
  if (!after) return { ok: false, reason: "changed" };
  const n = after.approved_count;
  const toRequester = approve
    ? `good news — you've got ${n} more invite${n === 1 ? "" : "s"}. just ask whenever you want a link.`
    : `your request for more invites wasn't approved this time.`;
  return { ok: true, request: after, requester: after.conversation_id, invites_left: db.inviteAllowance(after.conversation_id), toRequester };
}

// ---------- claiming ----------

/**
 * Claim codes written in a text. A code is a lookup key, like a one-time code, not something said:
 * this reads its shape and nothing about what the message means.
 */
export function codesIn(text) {
  const out = [];
  for (const m of String(text ?? "").toUpperCase().matchAll(/\b([2-9A-Z]{4})-?([2-9A-Z]{4})\b/g)) {
    out.push(m[1] + m[2]);
  }
  return [...new Set(out)];
}

/** The first invite a text names, or null. */
export function inviteInText(text) {
  for (const code of codesIn(text)) {
    const inv = db.inviteByClaimCode(code);
    if (inv) return inv;
  }
  return null;
}

/** What somebody whose claim did not go through is told. */
export const ALREADY_CLAIMED = "this invite has already been claimed. ask whoever sent it for a new one.";
export const CANCELED = "this invite was canceled by the person who sent it. ask them for a new one.";

/**
 * A text from a number with no account. If it carries a live invite's code, spend the invite and
 * make the account; if it carries a spent one, say so. Null when it carries no code at all, so the
 * caller carries on as it always did.
 */
export function claimByText({ channel, address, text, name = "" }) {
  const inv = inviteInText(text);
  if (!inv) return null;
  const addr = normalizeNumber(address) || String(address ?? "").trim();
  const out = db.redeemInvite({ claimCode: inv.claim_code, channel, address: addr, name });
  if (!out.ok) {
    if (out.reason === "canceled") return { joined: false, reason: "canceled", toThem: CANCELED };
    if (out.reason === "already_member") return { joined: false, reason: "already_member", toThem: null };
    return { joined: false, reason: out.reason, toThem: ALREADY_CLAIMED };
  }
  const inviter = inv.conversation_id;
  const inviterShown = inviterName(inviter) || "a friend";
  const joiner = out.account.name || `Someone with a number ending ${addr.slice(-4)}`;
  return {
    joined: true,
    conversationId: out.account.conversation_id,
    inviteId: inv.id,
    inviter,
    welcome: `You're in, invited by ${inviterShown}.`,
    // Their name or the end of their number, and nothing else. No word of either conversation
    // crosses in either direction.
    toInviter: `${joiner} just joined with your invite 🎉`,
  };
}

/** An existing member texting a live invite's code: it is not spent on them. */
export function memberLine(inv, conversationId) {
  if (inv.state !== "unused") return null;
  return inv.conversation_id === conversationId
    ? "that's one of your own invite codes — it's for someone new, so i haven't used it. it's still there for them."
    : "you've already got your own Reason, so that invite wasn't used — it's still there for someone new.";
}

// ---------- the page ----------

/** The inviter name a link's card shows, or null for a token that is not a link. A read. */
export function inviteCardName(token) {
  const inv = /^[A-Za-z0-9_-]{32}$/.test(String(token ?? "")) ? db.inviteByToken(token) : null;
  return inv ? (inviterName(inv.conversation_id) || "A friend") : null;
}

/**
 * GET /i/{token}: who invited them, what Reason is, what it costs, and the button that joins.
 *
 * A read and nothing else — no row is written, whatever the link's state, so a link preview, a
 * forward or a hundred opens leave the invite exactly as it was. An unknown token is the same flat
 * not-found every other guessed link gets.
 */
export function inviteRequest({ token, lineNumber = null }) {
  const html = (status, body) => ({
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) },
    body,
  });
  const inv = /^[A-Za-z0-9_-]{32}$/.test(String(token ?? "")) ? db.inviteByToken(token) : null;
  if (!inv) return html(404, renderNotFound());
  const name = inviterName(inv.conversation_id) || "A friend";
  return html(200, renderInvite({ invite: inv, name, lineNumber }));
}

// What it costs (owner, 2026-10-25): people who come in now are early, and early people never pay.
// The inviter's name carries it, because they're the reason this person is early.
const costLine = (who) => `Nothing. ${who[0].toUpperCase() + who.slice(1)} got you in early, and early people never pay for Reason. No card, no subscription, ever. It's our thanks for being here first.`;

// The invite heading wears the marketing homepage's headline face ("You already know how to use it."):
// Instrument Serif italic 400 from Google Fonts, loaded the way reason-site-new/public/index.html loads it.
const HEADING_FONT = `\n<link rel="preconnect" href="https://fonts.googleapis.com">`
  + `\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`
  + `\n<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@1&display=swap" rel="stylesheet">`;
const HEADING_CSS = `.hero h1{font-family:"Instrument Serif","Iowan Old Style",Georgia,serif;font-style:italic;font-weight:400;font-size:clamp(2.4rem,9vw,3.2rem);line-height:1.08;letter-spacing:-.02em}`;

export function renderInvite({ invite, name, lineNumber }) {
  const title = `${name} invited you to Reason`;
  // The forwarded link's card (owner, 2026-10-26): the inviter's own picture carries their name;
  // the title row says what Reason is, and the description what it costs them. src/invitecard.js draws the picture once per name.
  const cardTitle = `${name} thinks you should join Reason`;
  const image = `${inviteUrl(invite.token)}/card.png?v=${inviteCardKey(name)}`;
  const head = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Reason">`,
    `<meta property="og:title" content="Reason — your personal concierge">`,
    `<meta property="og:description" content="Free for you, for good.">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc(cardTitle)}. Free for you, for good.">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="Reason — your personal concierge">`,
  ].filter(Boolean).map(t => `\n${t}`).join("") + HEADING_FONT;

  const p = (s) => `<p>${esc(s)}</p>`;
  let action;
  if (invite.state === "redeemed") {
    action = `<h2>Already claimed</h2><div class="t">${p("This invite has already been claimed. Each invite works once — ask " + name + " for a new one.")}</div>`;
  } else if (invite.state === "canceled") {
    action = `<h2>Canceled</h2><div class="t">${p(name + " canceled this invite. Ask them for a new one.")}</div>`;
  } else if (!lineNumber) {
    action = `<h2>How to join</h2><div class="t">${p("Reason's texting line isn't connected right now, so this invite can't be claimed at the moment. It hasn't been used — try again later.")}</div>`;
  } else {
    const code = formatCode(invite.claim_code);
    const href = `sms:${normalizeNumber(lineNumber)}?&body=${encodeURIComponent(joinText(invite.claim_code))}`;
    action = `<h2>How to join</h2><div class="t">`
      + p("Tap the button. It opens a text to Reason with your invite code already written in, so all you do is press send. That text is how Reason knows the number is really yours, and it's what claims the invite.")
      + `</div>`
      + `<a class="join" href="${esc(href)}" style="display:block;text-align:center;margin:.8rem 0 1rem;padding:.95rem;font-weight:600;border-radius:.6rem;background:var(--ink);color:var(--bg);text-decoration:none">Text Reason to join</a>`
      + `<div class="t">`
      + p(`Not on your phone? From your phone, text ${code} to ${prettyNumber(lineNumber)}.`)
      + p("This invite works once. Opening this page doesn't use it up: it's claimed by whoever sends the code first.")
      + `</div>`;
  }

  const body = `<div class="hero"><p class="kicker">An invite</p><h1>${esc(title)}</h1></div>`
    + `<div class="t">`
    + p("Reason is your personal concierge. You text it like a friend (call this restaurant and book a table for 4, find me a flight home Friday, what's on Thursday) and it does it, keeps track of what's still open, and comes back when there's something real to say.")
    + p(`It's your own. Your own memory and your own history, and nothing you say is shared with ${name} or anyone else.`)
    + `</div>`
    + `<h2>What it costs</h2><div class="t">${p(costLine(name))}</div>`
    + action
    + foot();
  // The pill is a button: a tap on it pops confetti (owner, 2026-10-26; src/pages/confetti.js).
  return shell({ title, body, pill: "Invite", pillButton: "Celebrate your invite", head, css: HEADING_CSS + CONFETTI_CSS, script: CONFETTI_JS });
}

/** Startup: everybody with an account has an allowance row. Idempotent; see db.backfillInviteAllowances. */
export function allowanceCounts() {
  const rows = db.db.prepare("SELECT remaining, COUNT(*) AS n FROM invite_allowances GROUP BY remaining ORDER BY remaining").all();
  return Object.fromEntries(rows.map(r => [String(r.remaining), Number(r.n)]));
}
