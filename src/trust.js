// Trust primitives. These are guards, and they live here so tools can call them.
// Nothing in this file asks the model to be honest; it checks the record instead.
//
// The gate in one line: a tool that spends money or acts on a third party will not run
// until the owner typed a yes, in their own words, after Reason described the action.
import * as db from "./db.js";
import { clock, config, stamp } from "./config.js";
import { judgeReply } from "./judge.js";

// ---------- what an explicit yes looks like ----------
// Not a word list. Which words appear in a reply says nothing about what it authorizes:
// "no problem, book it" contains "no", "don't wait, do it now" contains "don't", and
// "ok but make it 9 instead" contains "ok" while rejecting the time on record. Meaning is read
// by the judge (src/judge.js); the facts below are what code guarantees on its own.
//
// The single exception: a message that is nothing but a refusal. This is whole-message equality
// against a tiny set, never a substring search, so "no problem, book it" can never land in it.
// It is here so a flat no is honoured even when the judge is unreachable.
const BARE_REFUSALS = new Set(["no", "nope", "nah", "naw", "cancel", "stop", "don't", "dont"]);

/**
 * The tool's own name, whatever dressing the model saw it under. A model reaching these tools
 * over MCP sees them as `mcp__reason__browser_submit`, and will sometimes write that into
 * confirm_request's `action`. Left alone, the gate would then compare that string against
 * `browser_submit`, decide the yes was for a different action, and refuse a booking the owner
 * had actually approved — a guard failing closed for a reason that has nothing to do with
 * safety. One name, normalised in the one place both sides read it.
 */
export function toolName(action) {
  return String(action ?? "").replace(/^mcp__[a-z0-9_-]+__/i, "");
}

/** True only when the owner's whole message is a flat refusal and nothing else. */
export function isBareRefusal(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/[.!?…]+$/, "").trim();
  return BARE_REFUSALS.has(t);
}

/** The owner's own messages in this conversation, oldest first, with the timestamp prefix stripped. */
export function ownerTexts(messages = []) {
  return messages
    .filter(m => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[event "))
    .map(m => m.content.replace(/^\[[^\]]*\]\s*/, "").replace(/^[^:]{0,40}:\s*/, "").trim());
}

/**
 * Step 1 of the gate. Records what Reason is about to do, in words, before asking.
 * Returns the confirmation id the model must carry into the committing tool.
 */
export function requestConfirmation({ conversationId, messages, action, summary, stakes, target = "" }) {
  const c = db.askConfirmation({
    conversationId, action: toolName(action), summary, stakes, target: normalizeTarget(target),
    askedAfterMsgs: ownerTexts(messages).length,
  });
  return {
    ok: true,
    confirmation_id: c.id,
    state: "waiting_for_yes",
    recorded: summary,
    ...(c.target ? { target: c.target } : {}),
    next: `Now say that back to ${config.ownerName} in your own words and wait. When they reply, call confirm_record with confirmation_id ${c.id}. Do not call ${action} until confirm_record returns state 'granted'.`,
  };
}

/**
 * A phone number is compared as digits; anything else is compared as its own trimmed text.
 * This is the one place a target is made comparable, so the gate and the tool cannot disagree
 * about whether "+1 (212) 555-9999" and "+12125559999" are the same place.
 */
export function normalizeTarget(t) {
  const s = String(t ?? "").trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 ? `+${digits}` : s.toLowerCase();
}

/**
 * Step 2 of the gate. The guard, not the model, decides. Code checks the facts: the reply must be
 * a real NEW owner message that arrived after the ask, and the confirmation must still be open.
 * The judge then reads what that reply means against the summary that was recorded.
 *
 * `judge` is injectable so tests can state what a reply means and exercise the bookkeeping.
 */
export async function recordConfirmation({ conversationId, messages, confirmationId, judge = judgeReply }) {
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

  // A flat no needs no reading, and is honoured even if the judge is down.
  if (isBareRefusal(latest)) {
    db.refuseConfirmation(c.id);
    return { ok: false, state: "refused", quote: latest, error: `That reads as a no. ${c.action} is off. Say so and move on.` };
  }

  const { verdict, note, error } = await judge({ summary: c.summary, reply: latest });

  if (verdict === "no") {
    db.refuseConfirmation(c.id);
    return { ok: false, state: "refused", quote: latest, error: `That reads as a no. ${c.action} is off. Say so and move on.` };
  }
  // They want it, but not as described. Nothing is authorized and nothing is refused: the details
  // on record are not the details they agreed to, and a yes only ever covers what was described.
  if (verdict === "change") {
    return {
      ok: false, state: "changed", quote: latest, wants: note ?? "",
      error: `They said yes to something different${note ? `: ${note}` : ""}. Nothing is authorized, because what is on record is not what they want. Change the details first, then call confirm_request again with the new summary and ask once more.`,
    };
  }
  if (verdict !== "yes") {
    return {
      ok: false, state: "waiting_for_yes", quote: latest,
      error: error
        ? `Their reply could not be read (${error}), so nothing is authorized. Ask once, plainly, for a yes.`
        : `Their reply does not read as a clear yes or no, so nothing is authorized. Ask once, plainly, for a yes.`,
    };
  }
  db.grantConfirmation(c.id, latest);
  return { ok: true, state: "granted", confirmation_id: c.id, action: c.action, quote: latest };
}

/**
 * The guard a committing tool passes through. Returns { ok: true, confirmation } or a refusal
 * the tool must return verbatim. It does NOT spend the yes — see spendConfirmation.
 *
 * Checking and spending are separate on purpose. A yes buys exactly one real action, but a tool
 * that fails before touching anything (a stale element ref, an unreachable page) has used nothing
 * up, and burning the yes there would leave the owner having said go with nothing done and no way
 * to retry but to be asked again. So the yes is spent at the moment the action is really attempted.
 */
export function authorizeConfirmation({ conversationId, action, confirmationId, target = null }) {
  if (!confirmationId) {
    return { ok: false, blocked: "needs_confirmation", error: `${action} spends money or acts on someone else, so it needs an explicit yes first. Call confirm_request, tell ${config.ownerName} exactly what you are about to do, wait for their answer, then confirm_record, then call ${action} again with that confirmation_id.` };
  }
  const c = db.getConfirmation(conversationId, confirmationId);
  if (!c) return { ok: false, blocked: "no_such_confirmation", error: `No confirmation #${confirmationId} in this conversation.` };
  const want = toolName(action);
  if (toolName(c.action) !== want) return { ok: false, blocked: "wrong_action", error: `Confirmation #${confirmationId} was for ${c.action}, not ${want}. A yes covers one action only.` };
  if (c.consumed_at) return { ok: false, blocked: "already_spent", error: `Confirmation #${confirmationId} was already used. Ask again before doing this twice.` };
  if (c.refused_at) return { ok: false, blocked: "refused", error: `Confirmation #${confirmationId} was refused.` };
  if (!c.granted_at) return { ok: false, blocked: "not_granted", error: `Confirmation #${confirmationId} has no yes on it yet. Wait for their reply and call confirm_record.` };
  // For anything aimed at a person — a text, a call — the yes covers that person and nobody
  // else. The owner agreed to a number they were shown; dialling a different one on the same
  // yes is the mistake worth being unable to make, so it is checked here rather than trusted.
  if (target !== null) {
    const want = normalizeTarget(target);
    if (!c.target) {
      // The wording depends on what the yes was meant to cover: a person for a text or a call,
      // the exact details for a submit. A message about phone numbers is no help to a booking.
      const what = action === "browser_submit"
        ? `does not say what ${action} was for, so it cannot authorize committing anything. Call confirm_request again with target set to the same one-line details you will submit, show ${config.ownerName} those details, and ask again.`
        : `does not say who ${action} was for, so it cannot authorize reaching anyone. Call confirm_request again with target set to the exact number, show ${config.ownerName} that number, and ask again.`;
      return { ok: false, blocked: "no_target_on_record", error: `Confirmation #${confirmationId} ${what}` };
    }
    if (c.target !== want) {
      const what = action === "browser_submit"
        ? `A yes covers the exact details ${config.ownerName} was shown, and these are not them. Say what has changed, then confirm_request again with the new details and ask.`
        : `A yes covers the one person ${config.ownerName} was shown. Ask again for this one.`;
      return { ok: false, blocked: "wrong_target", error: `Confirmation #${confirmationId} was for '${c.target}', not '${want}'. ${what}` };
    }
  }
  const ageMin = (clock.now() - c.granted_at) / 60_000;
  if (ageMin > config.confirmWindowMin) {
    return { ok: false, blocked: "stale", error: `That yes was ${Math.round(ageMin)} minutes ago and only counts for ${config.confirmWindowMin}. Ask again before doing it.` };
  }
  return { ok: true, confirmation: { id: c.id, quote: c.granted_quote, granted: stamp(c.granted_at), summary: c.summary } };
}

/**
 * Spends the yes: from here on it authorizes nothing else. Called once the action is actually
 * being attempted, never before. Idempotent, so a caller cannot double-spend by asking twice.
 */
export function spendConfirmation(conversationId, confirmationId) {
  const c = db.getConfirmation(conversationId, confirmationId);
  if (!c || c.consumed_at) return false;
  db.consumeConfirmation(c.id);
  return true;
}

// ---------- connected accounts ----------
// Each provider says what credentials it needs. Nothing here fakes a connection:
// if the credentials are absent the status is not_connected and stays that way.
/**
 * Everything Reason could be given access to, and whether it has been.
 *
 * Two fields decide what a provider reports, and they are different questions:
 *
 *   `needs`  — the credentials this machine must have, by name. Missing any ⇒ not_connected.
 *   `built`  — whether Reason has any code for it at all. `false` ⇒ not_connected whatever the
 *              environment holds, because credentials for an integration nobody wrote do not make
 *              it work. These exist in the registry so `capabilities` and `account_list` can
 *              answer honestly today about apps Omari has chosen but nothing has been built for.
 *
 * `via` says how it would be reached: an official API, or the browser signed in as the owner would
 * sign in. The browser ones all wait on saved logins, which is itself not built.
 *
 * Nothing unbuilt names an environment variable it has not got. Inventing `SPOTIFY_CLIENT_ID`
 * here would be making up an integration's shape before anyone has read its docs, and the
 * capabilities tool would then repeat that invention as fact.
 */
export const PROVIDERS = {
  browser: {
    needs: [],
    built: true,
    via: "browser",
    scopes: ["browse", "fill_forms", "keep_logins"],
    what: "a real Chromium Reason drives itself, one profile per conversation, logins kept between turns",
  },
  gmail: {
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"],
    built: true,
    via: "api",
    scopes: ["read_mail", "send_mail"],
    what: "read and send email as the owner",
    supply: "a Google OAuth client and a refresh token for the owner's account",
  },
  google_calendar: {
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"],
    built: true,
    via: "api",
    scopes: ["read_events", "write_events"],
    what: "read the owner's calendar and put events on it",
    supply: "a Google OAuth client and a refresh token for the owner's account",
  },
  google_drive: {
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"],
    built: false,
    via: "api",
    scopes: ["read_files", "write_files"],
    what: "the owner's documents, spreadsheets and slides: read them, make them, change them",
    supply: "a Google OAuth client and a refresh token for the owner's account",
  },
  spotify: {
    needs: [],
    built: false,
    via: "api",
    scopes: ["read_library", "control_playback"],
    what: "what the owner listens to, and playing something",
    // No variable names here on purpose: nothing has been built, and nobody has read the docs.
    supply: "a Spotify developer app and the owner's authorisation (the exact credentials are not decided yet)",
  },
  phone_out: {
    needs: ["REASON_TELEPHONY_KEY", "REASON_PHONE_NUMBER"],
    built: true,
    via: "api",
    scopes: ["call_places", "call_owner"],
    what: "place a phone call, hold, and report back, with the recording",
    supply: "an account with a call provider that records every call (see docs/call-providers.md), and a number",
  },
  payments: {
    needs: ["REASON_PAYMENTS_KEY"],
    built: true,
    via: "api",
    scopes: ["pay_link", "refund"],
    what: "send a pay link, split a bill, refund",
    supply: "an account with a payments provider",
  },
  // Sites Omari chose, reached the way he would reach them: in a browser, signed in as himself.
  // None of this is built, and all of it waits on saved logins, which is also not built.
  ...Object.fromEntries([
    ["opentable", "book, change and cancel restaurant tables"],
    ["uber", "book a ride"],
    ["lyft", "book a ride"],
    ["doordash", "order food for delivery"],
    ["uber_eats", "order food for delivery"],
    ["amazon", "find something and order it"],
    ["airlines", "look up and book flights on an airline's own site"],
    ["ticketmaster", "find and buy event tickets"],
    ["fandango", "find showtimes and buy cinema tickets"],
  ].map(([name, what]) => [name, {
    needs: [],
    built: false,
    via: "browser",
    scopes: ["browse", "fill_forms", "keep_logins"],
    what,
    supply: "the owner signing in once in Reason's own browser, which needs saved logins — not built yet",
  }])),
};

export function missingCredentials(name) {
  const p = PROVIDERS[name];
  if (!p) return null;
  return p.needs.filter(k => !process.env[k]);
}

export function accountStatus(conversationId, name) {
  const p = PROVIDERS[name];
  if (!p) return { name, status: "unknown_provider" };
  const missing = missingCredentials(name);
  const row = db.liveAccount(conversationId, name);

  // Nothing written for it yet. This comes first: credentials for an integration that does not
  // exist still do not make it work, and saying "connectable" here would be the exact kind of
  // quiet overclaim this registry exists to prevent.
  if (p.built === false) {
    return {
      name, status: "not_connected", what: p.what, via: p.via,
      why: `nothing is built for ${name} yet`,
      needs: p.needs, missing, scopes_available: p.scopes,
      owner_must_supply: p.supply,
    };
  }
  if (missing.length) {
    return { name, status: "not_connected", what: p.what, via: p.via, needs: p.needs, missing, scopes_available: p.scopes, owner_must_supply: p.supply };
  }
  if (!row) return { name, status: "connectable", what: p.what, via: p.via, scopes_available: p.scopes };
  return {
    name, status: "connected", what: p.what,
    scopes: JSON.parse(row.scopes), connected_at: stamp(row.connected_at), revoked_at: null,
  };
}

export function listAccounts(conversationId) {
  const known = Object.keys(PROVIDERS).map(n => accountStatus(conversationId, n));
  const revoked = db.accountHistory(conversationId)
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
    case "web_lookup":
      return ok ? `Read ${out.url} ("${out.title || "untitled"}").` : `Tried to read ${input.url}${tail}`;
    case "browser_open":
      return ok ? `Opened ${out.url} in the browser ("${out.title || "untitled"}").` : `Tried to open ${input.url}${tail}`;
    // Which tier answered goes on the receipt, because "did you actually watch that video" is a
    // question the ledger has to be able to answer honestly weeks later — and the answer is always
    // no. It also records whether listening cost anything, since that is billed per minute.
    case "video_understand": {
      if (!ok) return `Tried to get at the video ${input.url}${tail}`;
      const what = `"${out.title || out.url}"`;
      if (out.tier === "watch") {
        return out.watched?.cached
          ? `Used the account of ${what} that ${out.watched.by ?? "a video model"} made when it watched this before — nothing was spent this time.`
          : `WATCHED ${what} — handed the link to ${out.watched?.by ?? "a video model"}, which saw the picture and heard the sound. Nothing was downloaded.`;
      }
      if (out.tier === "listen") {
        return out.heard?.cached
          ? `Used the transcript of ${what} that ${out.heard.by ?? "a video model"} made before — nothing was spent this time. Audio only; the picture was never seen.`
          : `Downloaded the AUDIO ONLY of ${what} and had it transcribed by ${out.heard?.by ?? "a video model"}. The audio was deleted. The picture was never seen.`;
      }
      if (out.tier === "captions") {
        const span = `${out.covers ?? "whole thing"}${out.trimmed ? `; ${out.trimmed.missing} not read` : ""}`;
        return `Read the ${out.captions?.source === "creator" ? "creator's" : "auto-generated"} captions of ${what} (${span}). Words only; nothing watched it.`;
      }
      return `Could only read what the page says about the video ${what} — nothing was read, watched or listened to.`;
    }
    case "browser_click":
      return `Stopped short of pressing '${out.element ?? input.ref}' — that commits something and needs a yes first.`;
    case "browser_submit":
      return ok
        ? `Submitted on ${out.landed_on ?? out.from_url}: ${input.what}. Pressed '${out.pressed}'.`
        : `Tried to submit: ${input.what}${tail}`;
    case "message_send":
      return ok
        ? `Texted ${out.sent_to}: "${input.text}".`
        : `Did not text ${input.to}${tail}`;
    case "call_place":
      return ok
        ? `Rang ${out.to} to: ${input.goal}. Shared: ${(input.facts ?? []).join("; ") || "nothing"}.`
          + ` Opened with: "${out.announced}". ${out.recorded ? "Recorded" : "Not recorded"}.`
          + ` (call #${out.call_id}; the outcome is on the call record, not here.)`
        : `Did not ring ${input.to}${tail}`;
    // Not a tool the model can call. The ledger is append-only, so the audio that turns up after
    // a call cannot be written back onto the call's own row; it gets this row instead, carrying
    // the same target, so "what did you do" and "where is that recording" have one answer.
    case "access_grant":
      return ok
        ? `Let ${out.number} in — they have their own Reason now. ${config.ownerName} said: "${out.quote}".`
        : `Did not let ${input.number} in${tail}`;
    case "access_decline":
      return ok
        ? `Said no to ${out.number}. ${config.ownerName} said: "${out.quote}". Not asking again for a while.`
        : `Could not answer ${input.number}'s request${tail}`;
    case "admin_pause":
      return ok ? `Paused ${out.number} — stopped answering them, kept everything of theirs.` : `Could not pause ${input.number}${tail}`;
    case "admin_resume":
      return ok ? `Answering ${out.number} again.` : `Could not resume ${input.number}${tail}`;
    case "admin_remove":
      return ok ? `Removed ${out.number} — stopped answering them. Their data is kept.` : `Could not remove ${input.number}${tail}`;
    case "admin_block":
      return ok ? `Blocked ${out.blocked} for good: no replies, and never asked about again.` : `Could not block ${input.number}${tail}`;
    case "admin_delete":
      return ok ? `DELETED everything of ${out.deleted}'s. This cannot be undone.` : `Did not delete ${input.number}'s data${tail}`;
    case "page_create":
      return ok ? `Made the page "${input.title}": ${out.link}` : `Could not make the page "${input.title}"${tail}`;
    case "page_update":
      return ok ? `Changed the page "${out.title}" (revision ${out.revision}), same link: ${out.link}` : `Could not change page ${input.page_id}${tail}`;
    case "page_share":
      return ok ? `SHARED the page "${out.title}" — anyone with the link can now read it: ${out.link}` : `Could not share page ${input.page_id}${tail}`;
    case "page_unshare":
      return ok ? `Made the page "${out.title}" private again: ${out.link}` : `Could not unshare page ${input.page_id}${tail}`;
    case "page_delete":
      return ok ? `Deleted the page "${out.title}" and everything on it.` : `Could not delete page ${input.page_id}${tail}`;
    case "call_recording":
      return ok
        ? `Sent ${config.ownerName} the recording of call #${input.call_id}`
          + ` (${out.seconds ?? "?"}s, ${out.bytes ? Math.round(out.bytes / 1024) : "?"} KB ${out.format ?? ""}): ${out.file}`
        // Every call is recorded, so this is a broken promise and the receipt says so in those
        // words. "What went wrong today" has to be answerable from this table.
        : `RECORDING MISSING for call #${input.call_id} — the call was answered and there is no audio${tail}`;
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
