// Trust primitives. These are guards, and they live here so tools can call them.
// Nothing in this file asks the model to be honest; it checks the record instead.
//
// The gate in one line: a tool that spends money or acts on a third party will not run
// until the owner typed a yes, in their own words, after Reason described the action.
import * as db from "./db.js";
import { clock, config, stamp } from "./config.js";
import { judgeReply } from "./judge.js";
import * as sites from "./sites.js";
import { spotifyStatus } from "./spotify.js";
import { googleStatus } from "./google.js";

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

// What a phone number can be made of and nothing else: digits, and the punctuation people write
// them with. The test is on the WHOLE string, which is the point — see normalizeTarget.
const PHONE_ONLY = /^[+()\-.\s\d]+$/;

/**
 * A phone number is compared as digits; anything else is compared as its own trimmed text.
 * This is the one place a target is made comparable, so the gate and the tool cannot disagree
 * about whether "+1 (212) 555-9999" and "+12125559999" are the same place.
 *
 * "Is this a phone number" is asked of the whole string rather than of how many digits are in it
 * somewhere. It used to be "seven digits anywhere", which quietly wrecked every target that was not
 * a number: a booking target of "Carbone, Fri Sep 26 2026, 8pm, party of 4, $240" became
 * "+262026800 4240" — every word thrown away — and an email target became its own punctuation
 * removed. Two genuinely different actions could then normalise to the same string and a yes for one
 * would authorize the other, which is the exact failure the target exists to prevent.
 */
export function normalizeTarget(t) {
  const s = String(t ?? "").trim();
  if (!s) return "";
  if (!PHONE_ONLY.test(s)) return s.toLowerCase();
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
  // Gmail and Calendar, built now from Google's current docs. Both want the same two credentials and
  // neither wants a refresh token in the environment, which is the change worth being exact about:
  // these entries used to need one GOOGLE_OAUTH_REFRESH_TOKEN for the owner, from before every
  // person had their own Reason. One refresh token in .env would mean every person who texted
  // reached the SAME inbox — not a configuration problem but the wrong inbox. So the client id and
  // secret are the machine's, and the refresh token is per conversation in `oauth_tokens`: the
  // person's own half, given on Google's own consent screen. See src/google.js.
  //
  // `oauth: "google"` is what tells accountStatus to read the tokens table for this conversation
  // rather than stopping at "the credentials exist". One grant covers both of these, so they connect
  // together — and a consent screen with one box unticked leaves the other honestly not connected.
  gmail: {
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    built: true,
    via: "api",
    oauth: "google",
    scopes: ["read_mail", "send_mail", "label_mail"],
    what: "read, search and send this person's email, draft and reply inside a thread, label, archive and bin it",
    supply: "a Web application OAuth client from the Google Cloud console with Reason's callback address in its redirect URIs, and then this person tapping the connect link once",
  },
  google_calendar: {
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    built: true,
    via: "api",
    oauth: "google",
    scopes: ["read_events", "write_events"],
    what: "read this person's calendar and put events on it",
    supply: "a Web application OAuth client from the Google Cloud console with Reason's callback address in its redirect URIs, and then this person tapping the connect link once",
  },
  // Still nothing written for Drive. It would share the Google client, but asking for a Drive scope
  // would put a line on somebody's consent screen that buys nothing, so it is not requested and this
  // stays `built: false`. `needs` names only what it would really take.
  google_drive: {
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    built: false,
    via: "api",
    scopes: ["read_files", "write_files"],
    what: "the owner's documents, spreadsheets and slides: read them, make them, change them",
    supply: "a Google OAuth client, a Drive scope added to what Reason asks for on the consent screen, and code written for it",
  },
  // Built now, from Spotify's current docs. The credentials are a developer app's client id and
  // secret; the *person's* half is an authorization they give on Spotify's own page, which is why
  // being `connectable` here is not being connected — see src/spotify.js.
  spotify: {
    needs: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
    built: true,
    via: "api",
    scopes: ["search", "read_playback", "control_playback", "make_playlists", "read_history"],
    what: "search Spotify, see and control what is playing, make playlists, and read listening history",
    supply: "a Spotify developer app from developer.spotify.com/dashboard, with Reason's callback address added to its Redirect URIs, and then the owner tapping the authorize link once",
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
  //
  // These are built now — saved sign-ins exist (src/signin.js) and each site has a playbook
  // (src/sites.js). What `built: true` means here is narrow and worth being exact about: the
  // plumbing is written and tested. It does NOT mean the site cooperates. Most of these refuse an
  // automated browser outright, and `siteNotes` below carries that per site so a status nobody can
  // use never reads as a status that works.
  //
  // `needs: []` because the credential is not an environment variable. It is a browser profile
  // with the site's own cookies in it, which only exists after the person signs in themselves, so
  // whether this is connected is read off the last sign-in probe rather than off process.env.
  ...Object.fromEntries(sites.SITES.map(s => [s.site, {
    needs: [],
    built: true,
    via: "browser",
    scopes: ["browse", "fill_forms", "keep_logins"],
    what: s.what,
    supply: `the owner signing in once themselves in Reason's own browser: npm run signin -- ${s.site}`,
  }])),
};

/**
 * Whether a site will even talk to this browser, from the probe run in `docs/site-probe-*.json`.
 *
 * Kept next to the registry rather than inside it because it is a finding with a date on it, not a
 * property of the site: a site that refuses today may not next month, and whoever re-runs
 * `npm run probe:sites` should be changing one list and not hunting through two.
 */
export const SITE_REACHABLE = {
  opentable: { loads: false, why: "drops the connection on an automated browser (ERR_HTTP2_PROTOCOL_ERROR), and answers plain curl with 403" },
  uber: { loads: true, why: "m.uber.com loads; the ride form is visible signed out, prices and cars are not" },
  lyft: { loads: true, why: "lyft.com loads, but ride.lyft.com redirects to a page whose only action is texting you an app download link" },
  doordash: { loads: false, why: "answers 403 on every page" },
  uber_eats: { loads: false, why: "answers 403 on every page" },
  amazon: { loads: true, why: "loads, and the order-history page redirects to Amazon's sign-in exactly as the probe expects" },
  delta: { loads: false, why: "answers Access Denied (HTTP 444) on every page" },
  united: { loads: false, why: "drops the connection on an automated browser and on plain curl too" },
  ticketmaster: { loads: false, why: "answers 403 on every page" },
  fandango: { loads: true, why: "loads, and the account page redirects to Fandango's sign-in exactly as the probe expects" },
};

export function missingCredentials(name) {
  const p = PROVIDERS[name];
  if (!p) return null;
  // Spotify is asked rather than inferred from process.env. Its module reads the two values
  // through `config`, which is also where a test or a deployment can set them, so reading the
  // environment directly here would let this registry say "not connected" about an integration
  // that works — the exact kind of quiet disagreement between two sources this file exists to stop.
  if (name === "spotify") return spotifyStatus().missing;
  // Gmail and Calendar, for the same reason: src/google.js reads the client id and secret through
  // `config`, so asking the environment here would let this registry call an integration that works
  // "not connected". Drive is deliberately not in here — nothing is built for it, and `needs` is the
  // honest answer about an entry whose status comes off `built: false` anyway.
  if (p.oauth === "google") return googleStatus().missing;
  return p.needs.filter(k => !process.env[k]);
}

export function accountStatus(conversationId, name) {
  const p = PROVIDERS[name];
  if (!p) return { name, status: "unknown_provider" };
  const missing = missingCredentials(name);
  const row = db.liveAccount(conversationId, name);

  // A site reached through the browser is a different question from a site reached with a key.
  // There is no credential in the environment to check: it is connected when the SITE last agreed
  // it was signed in, and not when anybody wanted it to be. So this branch reads the last probe,
  // reports when that was, and carries whether the site even answers an automated browser — a
  // "connected" that cannot load a page is a status that would get somebody promised an errand
  // nothing can do.
  if (p.via === "browser" && sites.site(name)) {
    const last = db.lastSigninCheck(conversationId, name);
    const reach = SITE_REACHABLE[name] ?? null;
    const entry = sites.site(name);
    const common = {
      name, what: p.what, via: "browser", scopes_available: p.scopes,
      needs_signin: entry.needs_signin,
      site_loads_for_reason: reach?.loads ?? null,
      ...(reach ? { site_note: reach.why } : {}),
      ...(last?.checked_at ? { last_checked: stamp(last.checked_at) } : {}),
      ...(last?.evidence ? { evidence: last.evidence } : {}),
    };
    if (row && row.state === "signed_in") {
      return { ...common, status: "connected", scopes: JSON.parse(row.scopes), connected_at: stamp(row.connected_at), revoked_at: null };
    }
    return {
      ...common,
      status: "not_connected",
      why: last
        ? `the last check said ${last.state}`
        : "nobody has signed in to this site in Reason's browser on this machine",
      owner_must_supply: p.supply,
    };
  }

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

  // An OAuth provider where the person's own half is a grant they gave on the provider's page. The
  // credentials being present says only that a link can be sent, so "connected" is read off the
  // token row for THIS conversation and nowhere else. The third state matters as much as the other
  // two: a grant the provider has stopped renewing is not the same as never having connected, and
  // the person gets told a different thing about each.
  if (p.oauth) {
    const dead = db.accountNeedsReconnect(conversationId, name);
    const tokens = db.getOauthTokens(conversationId, p.oauth);
    const common = { name, what: p.what, via: p.via, scopes_available: p.scopes };
    if (row && tokens) {
      // Every account this person has, not just the one a single-row lookup happens to land on.
      // "What's connected?" has to name all of them, and a provider where one account is live and
      // another has died has to say both halves — a status that reported only the live one would
      // leave somebody waiting on mail from a mailbox nothing can read any more.
      const live = db.liveAccounts(conversationId, name).map(r => r.account_label).filter(Boolean);
      const broken = db.accountsNeedingReconnect(conversationId, name).map(r => r.account_label).filter(Boolean);
      const defaultRow = db.listOauthTokens(conversationId, p.oauth).find(r => r.is_default);
      return {
        ...common, status: "connected",
        scopes: JSON.parse(row.scopes),
        ...(tokens.account_label ? { account: tokens.account_label } : {}),
        ...(live.length ? { accounts: live } : {}),
        ...(live.length > 1 && defaultRow?.account_label ? { default_account: defaultRow.account_label } : {}),
        ...(broken.length ? { needs_reconnect: broken } : {}),
        connected_at: stamp(row.connected_at), revoked_at: null,
      };
    }
    if (dead) {
      return {
        ...common, status: "needs_reconnect",
        ...(dead.account_label ? { account: dead.account_label } : {}),
        why: dead.evidence || `${p.oauth} will not renew the connection any more`,
        since: dead.checked_at ? stamp(dead.checked_at) : null,
      };
    }
    return { ...common, status: "connectable" };
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

// ---------- the spending cap ----------
//
// A confirm gate stops one thing at a time. It cannot stop twenty approved things in an afternoon,
// and "they said yes to each of them" is true and no comfort when the total is four figures. So
// there is a second limit, counted per person per day in the database (`spend`), and checked before
// a commit goes through rather than noticed afterwards.
//
// **Where the number comes from, and what that costs in honesty.** The amount is read out of the
// details the owner actually approved — the one-line `what` the gate already holds, which is the
// same string they were shown. That is the only number in the system that somebody has agreed to.
// It has two consequences worth being plain about rather than hiding:
//
//   - A commit whose approved details name no amount counts as nothing, so the cap cannot see it.
//     That is why `browser_submit` separately refuses to commit on one of these sites when the page
//     shows a price and the approval does not (`src/tools.js`) — the two guards together are what
//     make "nothing big slips past the cap" true, and neither does it alone.
//   - A number that is named but is not a charge — "$25 per person cancellation hold" — counts
//     anyway. Over-counting a hold is the safe direction to be wrong in, and `spend_list` shows
//     every line so an over-count can be seen for what it is.

const MONEY = /(?:(?:US)?\$|USD\s*)\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s?(?:dollars|usd)\b/gi;

/**
 * Every money amount in a line, in cents. Dollars only, because that is what the sites in the
 * registry quote and guessing at a currency from a bare number is how $40 becomes ¥40.
 */
export function amountsIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(MONEY)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/,/g, "");
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) out.push(Math.round(n * 100));
  }
  return out;
}

/** The biggest amount named, which on a checkout page is the total rather than a line item. */
export function largestAmount(text) {
  const all = amountsIn(text);
  return all.length ? Math.max(...all) : null;
}

export const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/** The day a cap is counted against, in the install's timezone rather than UTC. */
export function spendDay(nowMs = clock.now()) {
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone: config.tz });
}

/**
 * Would committing this amount take them over the day? Returns `{ ok: true, … }` or a refusal the
 * tool must hand back as it is.
 */
export function checkSpendCap(conversationId, cents, { day = spendDay() } = {}) {
  const capCents = Math.round((config.maxSpendPerDay || 0) * 100);
  const used = db.spentToday(conversationId, day);
  if (!capCents) return { ok: true, capped: false, spent_today: used.cents, cap: 0 };
  if (!cents) return { ok: true, capped: true, spent_today: used.cents, cap: capCents, amount: 0 };
  if (used.cents + cents > capCents) {
    return {
      ok: false, blocked: "over_daily_cap",
      cap: capCents, spent_today: used.cents, amount: cents, left: Math.max(0, capCents - used.cents),
      error: `That is ${money(cents)} and the day's limit is ${money(capCents)}, of which ${money(used.cents)} is already committed`
        + ` across ${used.count} thing(s) — so there is ${money(Math.max(0, capCents - used.cents))} left and this does not fit.`
        + ` Nothing was committed. Say exactly that: the limit, what is already spent, and that it needs to wait for tomorrow`
        + ` or for ${config.ownerName} to raise REASON_MAX_SPEND_PER_DAY. Do not retry.`,
    };
  }
  return { ok: true, capped: true, spent_today: used.cents, cap: capCents, amount: cents, left: capCents - used.cents - cents };
}

/** Written the moment a commit really goes through, so the cap counts what happened. */
export function noteSpend({ conversationId, cents, what = "", site = "", confirmationId = null }) {
  if (!cents) return null;
  return db.recordSpend({ conversationId, day: spendDay(), cents, what, site, confirmationId });
}

export function spendToday(conversationId) {
  const day = spendDay();
  const { cents, count } = db.spentToday(conversationId, day);
  const capCents = Math.round((config.maxSpendPerDay || 0) * 100);
  return {
    day, spent: money(cents), spent_cents: cents, commits: count,
    cap: capCents ? money(capCents) : "no cap set",
    left: capCents ? money(Math.max(0, capCents - cents)) : null,
    lines: db.listSpend(conversationId, day).map(r => ({ at: stamp(r.at), amount: money(r.cents), what: r.what, site: r.site })),
    counted_from: "the amounts named in what was approved, biggest per commit. A commit whose approved details named no amount is not in this total.",
  };
}

// ---------- receipts ----------
/** Host, the way a receipt should read it: "rtings.com", not "https://www.rtings.com/reviews/...". */
function siteName(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return String(url ?? "").slice(0, 60); }
}

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
    // Saved sign-ins and Spotify. Each line says what really came back, because "is it signed in"
    // and "did that actually play" are both questions the ledger has to be able to answer weeks
    // later without taking anybody's word for it.
    case "signin_status":
      return ok
        ? `Asked ${input.site} whether ${config.ownerName} is signed in — ${out.state}: ${out.why}.`
        : `Could not check the ${input.site} sign-in${tail}`;
    case "spotify_control":
      return ok
        ? `Spotify: ${out.did}${out.started ? ` (${out.started})` : ""}. Spotify accepted it; it does not confirm what is now playing.`
        : `Spotify would not ${input.action}${tail}`;
    case "spotify_queue":
      return ok ? `Queued ${out.queued} on Spotify.` : `Did not queue ${input.uri}${tail}`;
    case "spotify_playlist_create":
      return ok
        ? `Made the Spotify playlist "${out.playlist?.name}" (${out.added} track(s)${out.playlist?.public ? ", public" : ", private"}): ${out.playlist?.link || "no link returned"}`
          + `${out.partial ? ` — ${out.partial}` : ""}`
        : `Could not make the Spotify playlist "${input.name}"${tail}`;
    case "spotify_playlist_add":
      return ok
        ? `Added ${out.added} track(s) to Spotify playlist ${input.playlist_id}.`
        : `Could not add to Spotify playlist ${input.playlist_id}${tail}`;
    case "web_lookup":
      return ok ? `Read ${out.url} ("${out.title || "untitled"}").` : `Tried to read ${input.url}${tail}`;
    case "web_search":
      if (!ok) return `Tried to search for "${input.query}"${tail}`;
      return `Searched ${out.provider} for "${input.query}"${input.sites?.length ? ` (only ${input.sites.join(", ")})` : ""}`
        + ` — ${out.count} result(s)${out.count ? `: ${out.results.slice(0, 5).map(r => siteName(r.url)).join(", ")}` : ""}.`;
    // The receipt names every source, because the point of research is that the answer is checkable.
    // "Where did the £799 come from" has to be answerable from the ledger months later, so the sites
    // that were read, the ones that were only snippets and the ones that failed are all on the line.
    case "research": {
      if (!ok) return `Tried to research "${input.question ?? `#${input.research_id}`}"${tail}`;
      const read = (out.sources ?? []).map(s => s.site);
      const snip = [...new Set((out.snippets_only ?? []).map(s => s.site))];
      const miss = (out.skipped ?? []).map(s => s.site);
      const bits = [
        `Researched "${out.question}" — ${out.searches_used} search(es), ${out.pages_read} page(s) read`,
        read.length ? `read: ${[...new Set(read)].join(", ")}` : "read nothing",
        snip.length ? `snippets only: ${snip.slice(0, 8).join(", ")}` : null,
        miss.length ? `could not read: ${[...new Set(miss)].join(", ")}` : null,
        out.cut_short ? `stopped by the ${out.cut_short} cap` : null,
      ].filter(Boolean);
      return bits.join("; ") + ".";
    }
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
    // The effect goes on the line because it is a thing the person actually saw happen on their
    // screen, and because "one an hour" has to be auditable: a ledger that only records the words
    // cannot answer "how often does it do the confetti". A dropped one says so, and why.
    case "message_send":
      return ok
        ? `Texted ${out.sent_to}: "${input.text}".${out.style ? ` Sent with the '${out.style}' screen effect.` : ""}`
          + `${out.style_dropped ? ` No effect: ${out.style_dropped}` : ""}`
        : `Did not text ${input.to}${tail}`;
    // What the model thought the moment was, in its own words, next to which effect it picked.
    // Written when the effect is marked rather than when the message lands, which is what the line
    // says: the reply goes out on the ordinary path straight after this.
    case "mark_moment":
      return ok
        ? `Marked the reply as a moment — ${input.moment} — so it went out with the '${input.effect}' screen effect.`
        : `No '${input.effect}' effect on the reply${tail}`;
    // A tapback leaves no bubble behind, so this row is the only record that anything was answered
    // at all. "Held" is its own outcome and reads as one: nothing was put on their message, and the
    // reaction is waiting on words. See src/tapbacks.js.
    case "react": {
      if (out?.held) return `Held a '${out.reaction}' tapback back — they had asked something, so it waits for the reply in words.`;
      if (!ok) return `Did not put a '${input.reaction}' tapback on their message${tail}`;
      return out.removed
        ? `Took the '${String(out.reaction).replace(/^-/, "")}' tapback back off their message (${out.reacted_to}).`
        : `Put a '${out.reaction}' tapback on their message (${out.reacted_to}) — no text was sent.`;
    }
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
