// Reason Web: the switch, and the two rules every other file asks it about.
//
// Web is a ROUTE to a person's existing conversation, never a conversation of its own. Phase W0
// (docs/plans/reason-web-phase1.md §6) lays the foundations and nothing a person can see: the flag,
// the `web` channel adapter, the per-message history every channel now writes into, and the guard
// that stops a web message from stealing where Reason's own texts go. There are no routes yet.
//
// Who may be reached over web is REASON_WEB (off | owner | on), like REASON_EVENTS. `owner` is
// "only the owner's conversation", because the first person to use Web is the owner, alone, for a
// soak (§7 decision 10).
import * as accounts from "./accounts.js";
import { config } from "./config.js";
import { liveLineNumber } from "./contact.js";

/** The channel name a web message arrives on and leaves by. One spelling, everywhere. */
export const WEB = "web";

/** Web exists at all. Off: no adapter is registered, nothing is written, nothing routes. */
export function webOn() {
  return config.web === "owner" || config.web === true;
}

/**
 * May THIS conversation be reached over web? `owner`: the operator's own conversation only. On:
 * anybody with a Reason. Off: nobody. Asked with the conversation the SESSION resolved to, never
 * one the client named.
 */
export function webAllowedFor(conversationId) {
  if (!conversationId) return false;
  if (config.web === "owner") return accounts.featureOwner(conversationId);
  return config.web === true;
}

/**
 * Should a message be written into the per-message history (db.writeMessage)? Only while web is
 * not off: with the flag off the table stays exactly as empty as it was, which is the "zero
 * behaviour change" the rollout rests on. Written for EVERY conversation once the flag is `owner`
 * or `on`, so the owner's soak builds everybody's history from that day and turning it `on` later
 * does not start them from nothing.
 */
export function historyOn() {
  return webOn();
}

/**
 * The number the Web join surface (W1: "New to Reason? A text from your phone finishes joining",
 * the sms: link, the QR, the "not on your phone?" line) tells a person to text. Read off the LIVE
 * channel at request time, exactly as pages/event.js and invites.js do: never hardcoded, never
 * from the linq adapter, which on the live install is registered but not connected. Null means
 * "no texting line is live", and the surface must say it cannot finish joining right now rather
 * than show a number. Owner rule, 2026-10-26: Reason is Sendblue only; nobody is ever shown a
 * Linq number.
 */
export function joinNumber(router) {
  return liveLineNumber(router);
}

const originOf = (u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.origin : null; } catch { return null; } };
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };

/**
 * The origin a Web page opens its live stream on, or null for its own (/web/stream, then the poll).
 * The website's proxy (Netlify, heyreason.com/web) buffers a stream until it ends — proven live
 * 10-26: first byte after ~16 s, all at once — so by default the page listens at the pages host
 * (files.heyreason.com/web/live), which Caddy hands straight to Reason. Only an https origin under
 * the website's own domain qualifies: the `reason_page` cookie is `Domain=<that domain>`, so it is
 * sent there, and nothing outside it may ever receive it. REASON_WEB_STREAM=off turns this off.
 */
export function webStreamOrigin() {
  const want = config.webStream;
  if (/^(off|0|false|no)$/i.test(want)) return null;
  const site = hostOf(config.siteUrl);
  const cand = want ? originOf(want) : originOf(config.pagesUrl);
  if (!site || !cand) return null;
  const host = hostOf(cand);
  if (host === site || !host.endsWith(`.${site}`)) return null;
  return cand;
}

/** The website's own origin (https://heyreason.com): the only page that may read the stream across hosts. */
export function siteOrigin() {
  return originOf(config.siteUrl);
}
