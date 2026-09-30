// Trust primitives. These are guards, and they live here so tools can call them.
// Nothing in this file asks the model to be honest; it checks the record instead.
//
// The gate in one line: a tool that spends money or acts on a third party will not run
// until the owner typed a yes, in their own words, after Reason described the action.
import * as db from "./db.js";
import { clock, config, stamp } from "./config.js";

// ---------- what an explicit yes looks like ----------
// Read by the guard, not by routing. The model never gets to assert consent;
// the guard reads the owner's actual last message and decides.
const NEGATIVE = /\b(no|nah|nope|naw|don'?t|do not|dont|stop|wait|hold on|hold up|cancel|never ?mind|nevermind|not yet|forget it|scratch that)\b/i;
const AFFIRMATIVE = /(^|\b)(y|ya|yah|yeah|yea|yep|yup|yes|yessir|sure|ok|okay|kk|word|bet|fine|please|pls|plz|go|send it|book it|do it|do that|confirm|confirmed|approve|approved|authoriz\w*|absolutely|definitely|lfg|let'?s go|lets go|100%|👍|✅)(\b|$)/i;

/** The owner's own messages in this conversation, oldest first, with the timestamp prefix stripped. */
export function ownerTexts(messages = []) {
  return messages
    .filter(m => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[event "))
    .map(m => m.content.replace(/^\[[^\]]*\]\s*/, "").replace(/^[^:]{0,40}:\s*/, "").trim());
}

/** Classify one owner message. Negatives win: "yeah no" is a no. */
export function readsAsYes(text) {
  if (!text) return "unclear";
  if (NEGATIVE.test(text)) return "no";
  if (AFFIRMATIVE.test(text)) return "yes";
  return "unclear";
}

/**
 * Step 1 of the gate. Records what Reason is about to do, in words, before asking.
 * Returns the confirmation id the model must carry into the committing tool.
 */
export function requestConfirmation({ conversationId, messages, action, summary, stakes }) {
  const c = db.askConfirmation({
    conversationId, action, summary, stakes,
    askedAfterMsgs: ownerTexts(messages).length,
  });
  return {
    ok: true,
    confirmation_id: c.id,
    state: "waiting_for_yes",
    recorded: summary,
    next: `Now say that back to ${config.ownerName} in your own words and wait. When they reply, call confirm_record with confirmation_id ${c.id}. Do not call ${action} until confirm_record returns state 'granted'.`,
  };
}

/**
 * Step 2 of the gate. The guard itself reads the owner's latest message.
 * It must be a NEW message (arrived after the ask) and it must read as a yes.
 */
export function recordConfirmation({ conversationId, messages, confirmationId }) {
  const c = db.getConfirmation(conversationId, confirmationId);
  if (!c) return { ok: false, error: `No confirmation #${confirmationId} in this conversation.` };
  if (c.consumed_at) return { ok: false, state: "spent", error: `Confirmation #${confirmationId} was already used for ${c.action}. Ask again.` };
  if (c.refused_at) return { ok: false, state: "refused", error: `Confirmation #${confirmationId} was refused. Do not retry unless they bring it up.` };
  if (c.granted_at) return { ok: true, state: "granted", confirmation_id: c.id, action: c.action, quote: c.granted_quote };

  const texts = ownerTexts(messages);
  if (texts.length <= c.asked_after_msgs) {
    return {
      ok: false, state: "waiting_for_yes",
      error: `${config.ownerName} has not answered yet. You asked and they have not replied since. Wait for their next message; do not confirm on their behalf.`,
    };
  }
  const latest = texts.at(-1);
  const verdict = readsAsYes(latest);
  if (verdict === "no") {
    db.refuseConfirmation(c.id);
    return { ok: false, state: "refused", quote: latest, error: `That reads as a no. ${c.action} is off. Say so and move on.` };
  }
  if (verdict === "unclear") {
    return {
      ok: false, state: "waiting_for_yes", quote: latest,
      error: `Their reply does not read as a clear yes or no, so nothing is authorized. Ask once, plainly, for a yes.`,
    };
  }
  db.grantConfirmation(c.id, latest);
  return { ok: true, state: "granted", confirmation_id: c.id, action: c.action, quote: latest };
}

/**
 * The guard a committing tool calls. Returns { ok: true, confirmation } or a refusal
 * the tool must return verbatim. Spends the confirmation on success: single use.
 */
export function spendConfirmation({ conversationId, action, confirmationId }) {
  if (!confirmationId) {
    return { ok: false, blocked: "needs_confirmation", error: `${action} spends money or acts on someone else, so it needs an explicit yes first. Call confirm_request, tell ${config.ownerName} exactly what you are about to do, wait for their answer, then confirm_record, then call ${action} again with that confirmation_id.` };
  }
  const c = db.getConfirmation(conversationId, confirmationId);
  if (!c) return { ok: false, blocked: "no_such_confirmation", error: `No confirmation #${confirmationId} in this conversation.` };
  if (c.action !== action) return { ok: false, blocked: "wrong_action", error: `Confirmation #${confirmationId} was for ${c.action}, not ${action}. A yes covers one action only.` };
  if (c.consumed_at) return { ok: false, blocked: "already_spent", error: `Confirmation #${confirmationId} was already used. Ask again before doing this twice.` };
  if (c.refused_at) return { ok: false, blocked: "refused", error: `Confirmation #${confirmationId} was refused.` };
  if (!c.granted_at) return { ok: false, blocked: "not_granted", error: `Confirmation #${confirmationId} has no yes on it yet. Wait for their reply and call confirm_record.` };
  const ageMin = (clock.now() - c.granted_at) / 60_000;
  if (ageMin > config.confirmWindowMin) {
    return { ok: false, blocked: "stale", error: `That yes was ${Math.round(ageMin)} minutes ago and only counts for ${config.confirmWindowMin}. Ask again before doing it.` };
  }
  db.consumeConfirmation(c.id);
  return { ok: true, confirmation: { id: c.id, quote: c.granted_quote, granted: stamp(c.granted_at), summary: c.summary } };
}

// ---------- connected accounts ----------
// Each provider says what credentials it needs. Nothing here fakes a connection:
// if the credentials are absent the status is not_connected and stays that way.
export const PROVIDERS = {
  gmail: {
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"],
    scopes: ["read_mail", "send_mail"],
    what: "read and send email as the owner",
  },
  google_calendar: {
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"],
    scopes: ["read_events", "write_events"],
    what: "read the owner's calendar and put events on it",
  },
  phone_out: {
    needs: ["REASON_TELEPHONY_KEY", "REASON_PHONE_NUMBER"],
    scopes: ["call_places", "call_owner"],
    what: "place a phone call, hold, and report back",
  },
  payments: {
    needs: ["REASON_PAYMENTS_KEY"],
    scopes: ["pay_link", "refund"],
    what: "send a pay link, split a bill, refund",
  },
};

export function missingCredentials(name) {
  const p = PROVIDERS[name];
  if (!p) return null;
  return p.needs.filter(k => !process.env[k]);
}

export function accountStatus(name) {
  const p = PROVIDERS[name];
  if (!p) return { name, status: "unknown_provider" };
  const missing = missingCredentials(name);
  const row = db.liveAccount(name);
  if (missing.length) {
    return { name, status: "not_connected", what: p.what, needs: p.needs, missing, scopes_available: p.scopes };
  }
  if (!row) return { name, status: "connectable", what: p.what, scopes_available: p.scopes };
  return {
    name, status: "connected", what: p.what,
    scopes: JSON.parse(row.scopes), connected_at: stamp(row.connected_at), revoked_at: null,
  };
}

export function listAccounts() {
  const known = Object.keys(PROVIDERS).map(accountStatus);
  const revoked = db.accountHistory()
    .filter(r => r.revoked_at)
    .map(r => ({ name: r.name, status: "revoked", scopes: JSON.parse(r.scopes), connected_at: stamp(r.connected_at), revoked_at: stamp(r.revoked_at) }));
  return { accounts: known, revoked_history: revoked };
}

// ---------- receipts ----------
/** One plain line per action, written from the tool's real result. This is what ledger_list reads back. */
export function receiptFor(action, input, out) {
  const ok = out?.ok !== false && !out?.error;
  const tail = ok ? "" : ` — failed: ${out?.error ?? out?.blocked ?? "unknown error"}`;
  switch (action) {
    case "account_connect":
      return ok
        ? `Connected the ${input.name} account (${(out.account?.scopes ?? []).join(", ") || "no scopes"}).`
        : `Tried to connect the ${input.name} account${tail}`;
    case "account_revoke":
      return ok ? `Revoked the ${input.name} account.` : `Tried to revoke the ${input.name} account${tail}`;
    default:
      return ok ? `${action} ran.` : `${action} did not run${tail}`;
  }
}

/** Writes the ledger row for one outside-world tool call and returns the row id. */
export function ledgerWrite({ conversationId, action, input, out, target = "", confirmationId = null }) {
  const outcome = out?.blocked ? "blocked" : (out?.ok === false || out?.error) ? "error" : "ok";
  return db.recordAction({
    conversationId, action, target, attempted: input, outcome, result: out,
    receipt: receiptFor(action, input, out),
    confirmationId: confirmationId ?? out?.confirmation?.id ?? null,
  });
}
