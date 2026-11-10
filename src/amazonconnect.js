// Connect Amazon: one self-contained step any first-run surface can call (the text intro's optional
// offer after the contact card, or a web onboarding). Owner, 2026-11-10: offer Amazon, never email.
//
// Why this rail and not Crossmint's store sign-in (src/shopconnect.js): that sign-in only exists
// inside a purchase run (a checkout that hits Amazon's sign-in wall), there is no standalone "connect
// a store" call, and a Crossmint browser profile gives Reason nothing it can read. The rail that
// connects Amazon on its own is the phone sign-in link (src/signin-remote.js, the same one the
// signin_link tool makes): Amazon's own sign-in page, inside Reason's browser, in the person's own
// saved profile, behind the connect gate's texted code unless their browser is already signed in to
// Reason. Their password is relayed to Amazon and never kept or shown to the model.
//
// After Amazon says they are signed in, the wake (afterSignedIn) has the model open their order
// history in that same browser and text one or two real things from it. It never buys or carts.
//
// The link's preview card is "Connect Amazon" (src/pages/securedcard.js, kind "amazon").
//
// Not the same as being able to BUY from Amazon: a purchase still goes through Crossmint, whose own
// profile may ask them to sign in to Amazon once more at checkout.
import * as db from "./db.js";
import { config } from "./config.js";
import * as signin from "./signin.js";
import * as remote from "./signin-remote.js";
import { closeBrowser } from "./browser.js";
import { ledgerWrite } from "./trust.js";

const SITE = "amazon";

/** The texts, in Reason's voice. One question in the offer, no words for them to type. */
export const OFFER = "also, totally optional: if you shop on amazon, i can connect to your account so i can keep an eye on your orders and help you reorder the stuff you run out of. want the link?";
/** Sent with the link by text: what it is, the code first, Amazon's own page, Reason comes back. The link follows alone. */
export const LINK_LINE = "here you go. i'll text you a quick code to open it, then you sign in on amazon's own page. i never keep or see your password. once you're in, i'll be back shortly with a few ideas";
export const NO_LINE = "no worries";
export const FAILED_LINE = "hmm, i couldn't make the amazon link just now. ask me for it anytime";

const entry = () => signin.entryFor(SITE);

/**
 * Can an Amazon link really reach this person now? A public address (without one the link only opens
 * on the machine Reason runs on), Amazon in the sign-in registry and not blocked, and an account of
 * theirs (the saved profile is theirs). Never the operator, who signs in on the Mac.
 */
export function available(conversationId) {
  if (!config.publicUrl || !conversationId) return false;
  if (connected(conversationId)) return false;
  const row = db.getAccount(conversationId);
  if (!row || row.is_operator) return false;
  const e = entry();
  return !!e && !e.signin_blocked;
}

/** Already signed in to Amazon in Reason's browser, as last checked? Then there is nothing to offer. */
export function connected(conversationId) {
  const row = db.lastSigninCheck(conversationId, SITE);
  return !!row && !row.revoked_at && row.state === "signed_in";
}

/** The wake after Amazon says they are signed in: read what is really there, bring back one or two things. */
export function followUpNote(e = entry()) {
  const page = e?.signed_in?.url || e?.signin_url || "https://www.amazon.com/gp/css/order-history";
  return `They connected Amazon when you offered it, and you said you'd be back shortly with a few ideas, so nothing else is waiting on it. Open ${page} with browser_open (your browser is signed in to their account now) and read their recent orders. Then text them in two or three short lines, lowercase like a friend: that it worked, and one or two genuinely useful things from what is actually there, like something on its way and when it arrives, or something they buy again and again that you could reorder for them when they want. Name only orders you read on the page, never invent one, never list everything, and never buy or add anything to a cart. If the page will not read or shows no orders, just say it worked and that you can track or reorder anything from Amazon whenever they like. No question at the end.`;
}

/**
 * Make their Connect Amazon link. `via` says which surface asked (for the ledger: "first_chat",
 * "web_onboarding", ...). Returns `{ ok: true, url, goodForMinutes }` or `{ ok: false, why }`.
 * Nothing launches until they tap Start on the page; a new link replaces their old one.
 */
/**
 * The web setup's Amazon (src/websetup.js): the same sign-in in Reason's browser, for a setup's
 * stand-in conversation, which has no account and no thread. Its browser proof is the setup cookie
 * (src/connectgate.js), the profile it signs in is a new empty one that moves to them when their first
 * text claims the setup, and how it ended is written on the setup rather than woken into a thread
 * (the follow-up runs at the claim instead).
 */
export function setupAvailable() {
  const e = entry();
  return !!config.publicUrl && !!e && !e.signin_blocked;
}

export function setupConnectLink(setupConversationId, { via = "web_setup", log = () => {}, create = remote.createRemoteSignin, onEnd = null, back = "" } = {}) {
  if (!setupAvailable() || !String(setupConversationId ?? "").startsWith("websetup:")) return { ok: false, why: "unavailable" };
  const e = entry();
  const id = String(setupConversationId).slice("websetup:".length);
  const ended = onEnd ?? ((ended) => import("./websetupstore.js").then(st => st.setConnectState(id, "amazon", ended?.state === "signed_in" ? "connected" : "failed")).catch(() => {}));
  // back: the setup's connect screen. Its pages are the paper store sign-in, and end there (src/pages/setupsignin.js).
  const out = create({ conversationId: setupConversationId, entry: e, closeBrowser, onEnd: ended, log, setupBack: back || "/start/connect?back=amazon" });
  ledgerWrite({ conversationId: setupConversationId, action: "signin_link", input: { site: SITE, via }, out: { ok: out.ok, site: e.site, reachable_from_a_phone: out.reachable_from_a_phone }, target: `site:${e.site}` });
  if (!out.ok || !out.reachable_from_a_phone) return { ok: false, why: out.why || "not_reachable" };
  return { ok: true, url: out.url, goodForMinutes: out.good_for_minutes };
}

export function connectLink(conversationId, { via = "", log = () => {}, create = remote.createRemoteSignin } = {}) {
  if (!available(conversationId)) return { ok: false, why: "unavailable" };
  const e = entry();
  const out = create({ conversationId, entry: e, closeBrowser, afterSignedIn: followUpNote(e), log });
  ledgerWrite({ conversationId, action: "signin_link", input: { site: SITE, via }, out: { ok: out.ok, site: e.site, reachable_from_a_phone: out.reachable_from_a_phone }, target: `site:${e.site}` });
  if (!out.ok || !out.reachable_from_a_phone) return { ok: false, why: out.why || "not_reachable" };
  return { ok: true, url: out.url, goodForMinutes: out.good_for_minutes };
}
