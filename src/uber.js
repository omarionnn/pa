// Uber, the documented way — the route that cannot be bot-checked.
//
// Everything here was written from Uber's current docs, read 2026-10-15; nothing is from memory and
// nothing is invented. Where a page Uber used to publish is gone, this file says so rather than
// filling the gap in — see "What Uber does not document any more" at the bottom of this comment.
//
// **Why this exists at all.** Reason already had a way into Uber: the person signs in on
// auth.uber.com inside Reason's own headless browser (src/signin.js, src/signin-remote.js). From
// the Hetzner server that route is dead — Cloudflare answers auth.uber.com with a bot check
// ("Performing security verification", HTTP 403), verified 2026-10-15. A person watching a spinner
// is what that looks like from the outside. The route below is the one a bot wall is not for: the
// person signs in on THEIR OWN phone browser, on Uber's own page, and Reason holds the tokens
// server-side and talks to the REST API server-to-server. The same server reaches
// auth.uber.com/oauth/v2/token and api.uber.com/v1.2/* over plain HTTPS and gets JSON back.
//
//   **OAuth 2.0, authorization code** (developer.uber.com/docs/riders/guides/authentication/user-access-token).
//   GET auth.uber.com/oauth/v2/authorize with client_id, response_type=code, redirect_uri, a
//   SPACE-delimited scope and state. Uber redirects back with ?code&state. The code is single use
//   and expires in 10 minutes. It is exchanged at POST auth.uber.com/oauth/v2/token, form-encoded,
//   with client_id and client_secret as FORM FIELDS — not a Basic header, which is where Spotify
//   differs. The response is { access_token, token_type: "Bearer", expires_in: 2592000 (30 days),
//   refresh_token, scope }.
//
//   **Refreshing** (same page). POST the same endpoint with grant_type=refresh_token, the refresh
//   token, and the same client_id and client_secret. The refresh token comes back only when
//   `offline_access` was granted, lasts a year, and is invalidated after a year of inactivity.
//   Uber's page shows no example refresh RESPONSE, so this does not assume one carries a new
//   refresh token: an empty incoming value never erases the stored one (`saveOauthTokens` enforces
//   that in SQL). `invalid_grant` means the grant is dead — discard it and send them through
//   authorize again rather than retrying.
//
//   **Scopes** (developer.uber.com/docs/riders/guides/scopes). `profile`, `places`,
//   `offline_access` and `history` are general. `request`, `request_receipt` and `all_trips` are
//   **privileged**, and this is the fact that decides what Reason may honestly promise: by default
//   a privileged scope is Limited Access — it works for the app owner's own Uber account and for
//   the developer accounts listed in the app's dashboard, and nobody else. Uber's page does NOT
//   state a maximum number of those accounts, so this file does not either. Full Access needs a
//   complete app and a published public privacy policy, requested under the dashboard's Auth tab.
//   So an Uber connection comes in two honest flavours and they are not the same thing: identity
//   (`profile`), and ride access (`request`). See `stateOf`.
//
//   **The ride flow** (developer.uber.com/docs/riders/ride-requests/tutorials/api/best-practices,
//   and the curl tutorial at .../tutorials/api/curl). GET /v1.2/products for the products at a
//   pickup; POST /v1.2/requests/estimate with a product_id for a `fare_id`; POST /v1.2/requests
//   with that fare_id. **The fare_id expires after two minutes** — Uber's own sentence — and that
//   single fact shapes `uber_request` more than anything else here: a text conversation with a
//   confirm gate in it does not finish inside two minutes, so the quote the person said yes to is
//   almost always dead by the time they answer. See REQUOTING below.
//
//   **Status and cancelling** (best practices). GET /v1.2/requests/{request_id}, polled every 3-5
//   seconds, or GET /v1.2/requests/current. DELETE /v1.2/requests/{request_id} cancels, and Uber
//   says an app that can request a ride must be able to cancel one.
//
//   **The sandbox** (developer.uber.com/docs/riders/guides/sandbox). sandbox-api.uber.com takes the
//   SAME tokens and POST /requests there creates no real trip (202, status "processing"). PUT
//   /sandbox/products/{id} sets surge_multiplier and drivers_available; PUT /sandbox/requests/{id}
//   sets status (processing, accepted, arriving, in_progress, driver_canceled, completed).
//   REASON_UBER_SANDBOX=1 is the switch — see src/config.js.
//
//   **Errors** (developer.uber.com/docs/riders/guides/errors, plus the code table on
//   developer.uber.com/docs/riders/references/api/v1.2/requests-post). The body is `{ code,
//   message }`. 401 is `unauthorized`. The POST /requests table is reproduced in CODE_LINES below
//   and is the only place this file decides what a refusal means.
//
// **What Uber does not document any more**, checked page by page on 2026-10-15. Their current v1.2
// reference sidebar has six endpoints only: GET /me, GET /payment-methods, GET /products, GET
// /estimates/price, GET /estimates/time, POST /requests. These are used here and are NOT in it:
//
//   - POST /v1.2/requests/estimate — the v1.2 reference page is a 404. The v1 page
//     (.../api/v1/requests-estimate-post) still documents the shape and says it was retired in
//     December 2022 in favour of the v1.2 page that is now missing, while the curl tutorial, the
//     best-practices page and the changelog all use /v1.2/requests/estimate. The v1.2 path is the
//     one used here, because it is the one POST /v1.2/requests takes a fare_id from. Both response
//     shapes the docs show are handled: `fare` (an upfront fare, with a fare_id) and `price` (an
//     estimate, which is where surge appears).
//   - GET /v1.2/requests/{id}, GET /v1.2/requests/current, DELETE /v1.2/requests/{id} — in the
//     best-practices page and the curl tutorial, not in the reference sidebar.
//   - GET /v1.2/requests/{id}/receipt — not documented anywhere current; both the v1.2 and the old
//     v1 pages are 404s. The `request_receipt` scope is still documented. So `receipt()` asks, and
//     an answer Uber will not give is reported as Uber emailing the receipt instead, which is what
//     their best-practices page says happens. docs/unverified.md says so.
//
// **REQUOTING, and why the gate works the way it does.** A fare_id lives two minutes. The confirm
// gate takes as long as a person takes to read a text and reply. So the yes is pinned to the thing
// that does not expire — the route, the product and the TOTAL, read off the quote row rather than
// retyped — and `uber_request` fetches a fresh fare_id for that same route immediately before it
// books. If the fresh total is not the total they agreed to, nothing is booked and they are asked
// again about the new number. That is the same rule AgentCard's `cart_changed` enforces, for the
// same reason: a yes only ever covers what was described.
//
// Nothing in this file has ever been sent to Uber: there is no UBER_CLIENT_ID on the machine it was
// written on. It has only answered a fake Uber standing in for these routes (test/fixture-uber.js).
import { config, clock, callbackUrl, stamp } from "./config.js";
import { renderConnected } from "./pages/render.js";
import * as db from "./db.js";
import { startLink } from "./connectgate.js";

export const PROVIDER = "uber";
export const REDIRECT_PATH = "/uber/callback";

/**
 * What Reason asks for, and why each one.
 *
 * Only scopes something below actually uses. `history`, `history_lite` and `all_trips` are
 * deliberately absent: nothing here reads past trips or other people's rides, and a scope Reason
 * does not need is a line on somebody's consent screen that buys nothing.
 */
export const SCOPES = {
  // General.
  profile: "see which Uber account this is — their first name and email — so a connection names them",
  places: "use the home and work they already saved in Uber as a pickup or a destination (start_place_id / end_place_id)",
  offline_access: "keep the connection alive without sending them a new link every 30 days (this is what returns a refresh token)",
  // Privileged. Limited Access until Uber grants Full Access: these work for the app owner's own
  // Uber account and the developer accounts listed in the app dashboard, and for nobody else.
  request: "ask Uber for the one ride they said yes to, and cancel it",
  request_receipt: "read the receipt for a ride Reason asked for",
};
export const SCOPE_LIST = Object.keys(SCOPES);

/** The privileged ones, by Uber's own classification. A 403 on one of these means Limited Access. */
export const PRIVILEGED = new Set(["request", "request_receipt"]);

/**
 * Which scope each tool needs, so a missing one is named rather than discovered as a 403.
 *
 * `uber_options` needs `request` even though it only quotes. A fare_id exists for exactly one
 * purpose — booking the ride it was minted for — so a price list Reason could never act on is the
 * overclaim this codebase is built to avoid. Without `request` the honest answer is uber_link.
 */
export const TOOL_SCOPES = {
  uber_connect: [],
  uber_options: ["request"],
  uber_request: ["request"],
  uber_ride: ["request"],
  uber_cancel: ["request"],
  uber_receipt: ["request_receipt"],
};

export function uberStatus({ clientId = config.uberClientId, clientSecret = config.uberClientSecret } = {}) {
  const missing = [];
  if (!clientId) missing.push("UBER_CLIENT_ID");
  if (!clientSecret) missing.push("UBER_CLIENT_SECRET");
  return {
    connected: missing.length === 0,
    missing,
    redirect_uri: callbackUrl(REDIRECT_PATH),
    sandbox: config.uberSandbox,
    what: "quote a real Uber with its upfront fare, request the one ride they said yes to, follow the driver, and cancel it",
  };
}

/**
 * Exactly what the owner has to register, in the words he would need at the dashboard.
 *
 * One string, used by the provider registry, by `notConnected` and by the connect tool, so the
 * three cannot drift apart and nobody ever gets a shorter version of it.
 */
export function supplyText({ ownerName = config.ownerName } = {}) {
  const st = uberStatus();
  return `an Uber app from developer.uber.com/dashboard/create, with ${st.redirect_uri} added as a Redirect URI exactly as written,`
    + ` and these five scopes ticked on its Auth tab: ${SCOPE_LIST.join(", ")}.`
    + ` UBER_CLIENT_ID and UBER_CLIENT_SECRET then go in the server's .env.`
    + ` Two of those scopes — request and request_receipt — are privileged, which under Uber's default Limited Access means`
    + ` they work for ${ownerName}'s own Uber account and for the developer accounts listed in that dashboard, and for nobody else.`
    + ` Everyone else needs Uber to grant Full Access, which they only review for a complete app with a published public privacy policy.`;
}

/** The honest result when there is no developer app. Returned, never improvised by the model. */
export function notConnected(extra = {}) {
  const st = uberStatus();
  return {
    ok: false,
    status: "not_connected",
    missing: st.missing,
    error: `Uber is not connected: this machine has no ${st.missing.join(" or ")}.`
      + ` ${config.ownerName} has to set up ${supplyText()}`
      + ` Say that plainly, do not claim anything about a ride, and offer uber_link — a link they tap and request the ride themselves — instead.`,
    use_instead: "uber_link",
    ...extra,
  };
}

// ---------- is Uber's app ready to take a connect? ----------

/**
 * Whether Uber's own authorize page accepts this server's redirect address, read from Uber itself.
 *
 * The keys can be on the machine while the developer app still lists an old Redirect URI (11-10: it
 * listed the dead Tailscale Funnel, the server sends app.heyreason.com). Then every link reaches
 * Uber and stops on Uber's "not a valid redirect uri" page. Uber answers the authorize address with a
 * 302 either way: to its sign-in for a good one, to /oauth/errors for a bad one. No state is made
 * and nothing is signed in. Cached for ten minutes, so a page load never asks Uber twice.
 * { ready, why } — why: "no_keys" | "redirect_uri_not_registered" | "uber_unreachable" | "".
 */
const READY_TTL_MS = 10 * 60_000;
let readyCache = null;
export function _resetReady() { readyCache = null; }
export async function connectReady({ fetchImpl = fetch } = {}) {
  const st = uberStatus();
  if (!st.connected) return { ready: false, why: "no_keys", missing: st.missing };
  if (readyCache && clock.now() - readyCache.at < READY_TTL_MS && readyCache.redirect === st.redirect_uri) return readyCache.out;
  const q = new URLSearchParams({ client_id: config.uberClientId, response_type: "code", redirect_uri: st.redirect_uri, scope: "profile", state: "readiness" });
  let out;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.uberTimeoutMs);
  try {
    const res = await fetchImpl(`${config.uberAuthBase}/oauth/v2/authorize?${q}`, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (Reason connect check)" } });
    const to = String(res.headers?.get?.("location") ?? "");
    if (/\/oauth\/errors/.test(to) || /redirect_uri/.test(to)) out = { ready: false, why: "redirect_uri_not_registered", redirect_uri: st.redirect_uri };
    else if (res.status >= 300 && res.status < 400 && to) out = { ready: true, why: "" };
    else out = { ready: false, why: "uber_unreachable", status: res.status };
  } catch {
    out = { ready: false, why: "uber_unreachable" };
  } finally { clearTimeout(timer); }
  // An unreachable Uber is asked again next time; a definite answer is kept.
  if (out.why !== "uber_unreachable") readyCache = { at: clock.now(), redirect: st.redirect_uri, out };
  return out;
}

// ---------- connecting ----------

/**
 * Step one: the link the person taps. Nothing is connected by calling this — Uber's own sign-in and
 * consent screen are what connect it, on their own phone, which is the whole point of this route.
 * A URL is not an action, so it does not go through the confirm gate.
 */
export function authorizeUrl(conversationId, { scopes = SCOPE_LIST } = {}) {
  const st = uberStatus();
  if (!st.connected) return notConnected();
  const want = scopes.filter(s => SCOPE_LIST.includes(s));
  if (!want.length) return { ok: false, error: `No known scopes asked for. Known: ${SCOPE_LIST.join(", ")}.` };
  const redirectUri = st.redirect_uri;
  // One handshake at a time per person: an old pending state is of no use once a new link is sent,
  // and leaving it live leaves a second usable callback lying around.
  db.clearOauthStates(conversationId, PROVIDER);
  const state = db.newOauthState({ conversationId, provider: PROVIDER, scope: want.join(" "), redirectUri });
  const q = new URLSearchParams({
    client_id: config.uberClientId,
    response_type: "code",
    redirect_uri: redirectUri,
    // Space-delimited, per their docs. URLSearchParams encodes the spaces; Uber's own examples do
    // the same, and a comma-delimited list is a different (and wrong) request.
    scope: want.join(" "),
    state,
  });
  return {
    ok: true,
    // What is texted is Reason's start page: it only sends the asker's own browser on to this
    // address (src/connectgate.js).
    url: startLink(state, `${config.uberAuthBase}/oauth/v2/authorize?${q}`, redirectUri),
    scopes: want.map(s => ({ scope: s, so_that: SCOPES[s], privileged: PRIVILEGED.has(s) })),
    redirect_uri: redirectUri,
    reachable: config.publicUrl
      ? null
      : `This redirects to ${redirectUri}, which only opens on the machine Reason runs on. Tapping the link from a phone will get as far as Uber and then fail to come back. Set REASON_PUBLIC_URL for that to work from anywhere.`,
    note: "Nothing is connected until they open this and sign in on Uber's own page. Reason never sees their password or their code. The link works once, and Uber's code expires 10 minutes after they finish.",
    limited_access: `If this Uber account is not ${config.ownerName}'s own and is not listed as a developer account in the app's dashboard, Uber will refuse the ride scope with a 403 — the sign-in will work and booking will not. That is Uber's Limited Access rule, not a fault here.`,
  };
}

async function postToken(body, { fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.uberTimeoutMs);
  try {
    const res = await fetchImpl(`${config.uberAuthBase}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      // Form fields, including the client id and secret. Uber's page lists them in the body; it
      // documents no Basic header on this flow.
      body: new URLSearchParams({
        client_id: config.uberClientId,
        client_secret: config.uberClientSecret,
        ...body,
      }).toString(),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* Uber answers JSON; a non-JSON body IS the error */ }
    if (!res.ok || json?.error) {
      return {
        ok: false,
        httpStatus: res.status,
        code: json?.error ?? json?.code ?? "",
        error: json?.error_description || json?.error || json?.message || text.slice(0, 200) || `HTTP ${res.status}`,
      };
    }
    return { ok: true, body: json ?? {} };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, timedOut: true, error: `Uber did not answer within ${config.uberTimeoutMs / 1000}s.` };
    return { ok: false, unreachable: true, error: `Could not reach Uber: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Step two, run by the HTTP route when Uber redirects back. The `state` is what ties the callback
 * to a conversation, and it is spent on the way through: a replayed callback writes nothing. It
 * also expires, because Uber's own code does — a connect link still sitting in somebody's messages
 * next week must not be able to attach an account.
 */
export async function completeConnect({ code, state, error = "", fetchImpl = fetch } = {}) {
  const row = db.spendOauthState(state, { maxAgeMs: config.uberStateTtlMs });
  if (!row) return { ok: false, reason: "bad_state", error: "That link has already been used, or it has expired, or it is not one of ours. Ask Reason for a new one." };
  if (row.provider !== PROVIDER) return { ok: false, reason: "bad_state", error: "That link is not an Uber one." };
  if (error) {
    return {
      ok: false, reason: "declined", conversationId: row.conversation_id,
      error: `Uber said: ${error}. Nothing is connected — most likely they tapped cancel on Uber's page, which is theirs to do.`,
    };
  }
  if (!code) return { ok: false, reason: "no_code", conversationId: row.conversation_id, error: "Uber came back without a code." };

  const got = await postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: row.redirect_uri,
  }, { fetchImpl });
  if (!got.ok) return { ok: false, reason: "token_exchange_failed", conversationId: row.conversation_id, error: got.error };

  const b = got.body;
  if (!b.access_token) return { ok: false, reason: "token_exchange_failed", conversationId: row.conversation_id, error: "Uber returned no access token." };
  // What Uber actually granted, not what was asked for. A privileged scope Uber withheld is the
  // whole difference between identity and ride access, and it is read from here and nowhere else.
  const granted = String(b.scope ?? "").split(/\s+/).filter(Boolean);

  // Who this is, so the connection names them. `profile` is what makes it answerable; without it
  // the connection is still real and simply has no name on it.
  let label = "";
  if (granted.includes("profile")) {
    const who = await api(b.access_token, "GET", "/me", { fetchImpl });
    if (who.ok) label = String(who.body?.first_name ?? who.body?.email ?? "").trim();
  }

  db.saveOauthTokens(row.conversation_id, PROVIDER, {
    accessToken: b.access_token,
    refreshToken: b.refresh_token ?? "",
    scope: granted.join(" "),
    expiresAt: b.expires_in ? clock.now() + Number(b.expires_in) * 1000 : null,
    accountLabel: label,
  });
  db.clearAccountNeedsReconnect(row.conversation_id, PROVIDER);
  db.connectAccount(row.conversation_id, PROVIDER, granted, { account: label });
  return {
    ok: true,
    conversationId: row.conversation_id,
    scopes: granted,
    account: label,
    can_book: granted.includes("request"),
    missing_privileged: [...PRIVILEGED].filter(s => !granted.includes(s)),
  };
}

/** Cut it off: the tokens go, and so does the connected-accounts row. */
export function disconnect(conversationId) {
  const tokens = db.deleteOauthTokens(conversationId, PROVIDER);
  db.clearOauthStates(conversationId, PROVIDER);
  db.clearAccountNeedsReconnect(conversationId, PROVIDER);
  const row = db.revokeAccount(conversationId, PROVIDER);
  return {
    ok: true,
    status: "revoked",
    tokens_deleted: tokens,
    was_connected: !!row || tokens > 0,
    // Uber documents no revoke endpoint — their authentication pages describe getting and
    // refreshing a token and nothing that hands one back. So this says what it really did, and
    // where the person can finish the job on Uber's side themselves.
    note: "The tokens are gone from this machine, so nothing here can ask Uber for a ride on their behalf any more."
      + " Uber documents no way for an app to revoke its own token, so Reason cannot tell Uber to forget it:"
      + " they remove the app themselves in their Uber account's privacy and app settings, and only they can do that.",
  };
}

// ---------- which of the five states this is ----------

/**
 * Not connected / connected (identity) / ride access ready / reconnect needed / blocked.
 *
 * Read off the stored grant, so it costs no network and cannot be wrong about what Uber said. The
 * distinction that matters most: a token WITHOUT `request` is a real connection that cannot book,
 * and it must never be reported as one that can.
 */
export function stateOf(conversationId) {
  const st = uberStatus();
  if (!st.connected) return { state: "not_connected", missing: st.missing };
  const row = db.getOauthTokens(conversationId, PROVIDER);
  if (!row) {
    const dead = db.accountNeedsReconnect(conversationId, PROVIDER);
    if (dead) return { state: "needs_reconnect", why: dead.evidence || "Uber will not renew that connection any more", since: dead.checked_at ? stamp(dead.checked_at) : null };
    return { state: "not_connected", missing: [] };
  }
  const scopes = scopesOf(row);
  return {
    state: scopes.includes("request") ? "ride_access" : "connected",
    scopes,
    account: row.account_label || "",
    can_book: scopes.includes("request"),
    ...(scopes.includes("request") ? {} : {
      why: `That Uber connection proves who they are and nothing more: Uber granted ${scopes.join(", ") || "nothing"} and not \`request\`,`
        + ` which is the privileged scope a ride needs. Under Uber's Limited Access that scope is only given to ${config.ownerName}'s own Uber account`
        + ` and to the developer accounts listed in the app's dashboard. Do not say Reason can book them a ride — hand over uber_link instead.`,
    }),
  };
}

function scopesOf(row) {
  return String(row?.scope ?? "").split(/\s+/).filter(Boolean);
}

/** Which scope is missing for this tool, if any. */
export function missingScopeFor(tool, scopes) {
  const need = TOOL_SCOPES[tool] ?? [];
  if (!need.length) return null;
  const absent = need.filter(s => !scopes.includes(s));
  return absent.length ? absent : null;
}

/**
 * The refusal for a tool whose scope Uber did not grant. Named rather than discovered as a 403, and
 * it says which of the two reasons it is: not asked for, or asked for and refused.
 */
export function scopeRefusal(tool, scopes, { ownerName = config.ownerName } = {}) {
  const need = missingScopeFor(tool, scopes);
  if (!need) return null;
  const privileged = need.filter(s => PRIVILEGED.has(s));
  return {
    ok: false,
    status: privileged.length ? "blocked" : "needs_reconnect",
    needs_scopes: need,
    has_scopes: scopes,
    error: `${tool} needs Uber's \`${need.join("` and `")}\` scope and this connection does not have it — Uber granted ${scopes.join(", ") || "nothing"}.`
      + (privileged.length
        ? ` ${privileged.join(" and ")} ${privileged.length > 1 ? "are" : "is"} privileged: under Uber's default Limited Access, Uber only grants ${privileged.length > 1 ? "them" : "it"} to ${ownerName}'s own Uber account and to the developer accounts listed in the app's dashboard at developer.uber.com/dashboard.`
          + ` So this is not something to retry or work around. Either ${ownerName} adds this person as a developer account in that dashboard, or the app is submitted for Full Access (a complete app plus a published public privacy policy).`
          + ` Say that plainly and use uber_link, which needs no account at all.`
        : ` Call uber_connect and send them a fresh link that asks for it.`),
    use_instead: "uber_link",
  };
}

// ---------- the token, live ----------

/**
 * A live access token for this person, refreshed if it has expired.
 *
 * Scoped by conversation and there is no other way in: `db.getOauthTokens` takes the conversation
 * id, so one person's token is not reachable from another person's thread by any argument the model
 * could pass. That is the isolation, and it is a property of the query rather than a check somebody
 * remembered to write.
 */
export async function accessTokenFor(conversationId, { fetchImpl = fetch } = {}) {
  const st = uberStatus();
  if (!st.connected) return notConnected();
  const row = db.getOauthTokens(conversationId, PROVIDER);
  if (!row) {
    const dead = db.accountNeedsReconnect(conversationId, PROVIDER);
    if (dead) {
      return {
        ok: false, status: "needs_reconnect",
        error: `That Uber connection has stopped working (${dead.evidence || "Uber will not renew it"}). Call uber_connect and send them a fresh link.`,
      };
    }
    return {
      ok: false, status: "not_connected",
      error: `This person has not connected Uber yet. Call uber_connect and send them the link — they sign in on Uber's own page, on their own phone, and Reason never sees a password. Nothing about a ride is possible until then.`,
      use_instead: "uber_link",
    };
  }
  // A minute of slack: a token that expires while the request is in flight is a confusing 401.
  const fresh = row.expires_at === null || row.expires_at - 60_000 > clock.now();
  if (fresh) return { ok: true, token: row.access_token, scopes: scopesOf(row), account: row.account_label || "", refreshed: false };

  if (!row.refresh_token) {
    return {
      ok: false, status: "needs_reconnect",
      error: `That Uber token has expired and there is no refresh token to renew it with — Uber only returns one when \`offline_access\` was granted. Call uber_connect for a fresh link.`,
    };
  }
  const got = await postToken({ grant_type: "refresh_token", refresh_token: row.refresh_token }, { fetchImpl });
  if (!got.ok) {
    // invalid_grant is the dead-grant answer: discard it and send them through authorize again
    // rather than retrying, which is what Uber's own token page says to do.
    if (got.code === "invalid_grant") {
      const why = "Uber will not renew that connection any more (a refresh token lasts a year, or it was revoked in their Uber settings).";
      db.deleteOauthTokens(conversationId, PROVIDER);
      db.markAccountNeedsReconnect(conversationId, PROVIDER, why, { account: row.account_label || "" });
      return { ok: false, status: "needs_reconnect", error: `${why} It has been dropped from this machine. Call uber_connect for a new link.` };
    }
    return { ok: false, status: "refresh_failed", error: `Could not renew the Uber token: ${got.error}` };
  }
  const b = got.body;
  const saved = db.saveOauthTokens(conversationId, PROVIDER, {
    accessToken: b.access_token,
    // Uber's docs show no example refresh response, so this does not assume one comes back. An
    // empty value never erases the stored token — see saveOauthTokens.
    refreshToken: b.refresh_token ?? "",
    scope: String(b.scope ?? row.scope ?? ""),
    expiresAt: b.expires_in ? clock.now() + Number(b.expires_in) * 1000 : null,
  });
  return { ok: true, token: saved.access_token, scopes: scopesOf(saved), account: saved.account_label || "", refreshed: true };
}

// ---------- one API request ----------

/**
 * What each documented refusal means, in words, from the code table on
 * developer.uber.com/docs/riders/references/api/v1.2/requests-post (read 2026-10-15).
 *
 * This is the only place a status code is turned into a sentence. A code that is not in here is
 * reported with Uber's own message attached and nothing added to it — guessing at an undocumented
 * code is how a rider with an unpaid balance gets told the app is broken.
 */
export const CODE_LINES = {
  // 403 — Uber refusing this rider or this product, each of which is a different thing to say.
  unverified: "Uber says that account is not verified yet. They finish that in the Uber app.",
  verification_required: "Uber wants them to verify something on their account first. They do that in the Uber app.",
  product_not_allowed: "Uber will not let that product be requested for this account.",
  pay_balance: "Uber says there is an unpaid balance on that account. They settle it in the Uber app.",
  user_not_allowed: "Uber will not let that account request a ride right now.",
  too_many_cancellations: "Uber has blocked requests on that account for too many cancellations. It clears on Uber's side, not here.",
  missing_national_id: "Uber needs a national ID on that account before it can request a ride.",
  out_of_company_policy: "Uber says the ride is outside the company policy on that account.",
  // 409 — the state of the world, not the request.
  missing_payment_method: "There is no payment method on that Uber account, so Uber will not take the request. They add a card in the Uber app.",
  current_trip_exists: "They are already on an Uber. Uber will not take a second request until that one ends.",
  retry_request: "Uber asked for the request to be made again. Nothing was created.",
  fare_expired: "The upfront fare had already expired when Uber got the request, so nothing was created.",
  // 422 — the request itself.
  invalid_fare_id: "The upfront fare was no longer valid (Uber's fares last two minutes), so nothing was created.",
  destination_required: "That Uber product needs a destination and none was set.",
  distance_exceeded: "Uber says that trip is further than 100 miles, which is their limit for this.",
  same_pickup_dropoff: "The pickup and the destination are the same place.",
  invalid_seat_count: "Uber would not accept that number of seats (their maximum for a shared ride is 2).",
  outside_service_area: "Uber does not serve that route.",
  validation_failed: "Uber rejected one of the values in the request.",
  no_product_found: "Uber has no product for that pickup — there is nothing to ride there.",
  not_found: "Uber does not know that product.",
  no_drivers_available: "Uber has no driver available for that right now. Nothing was created.",
  // 400 — their money.
  invalid_payment: "Uber says the payment method on that account will not work.",
  invalid_payment_method: "Uber says that payment method will not work.",
  insufficient_balance: "Uber says there is not enough balance on the payment method on that account.",
  outstanding_balance_update_billing: "Uber says there is an outstanding balance and the billing needs updating in the Uber app.",
  card_assoc_outstanding_balance: "Uber says the card on that account has an outstanding balance.",
  payment_method_not_allowed: "Uber will not allow that payment method for this.",
  error_promotions_revoked: "Uber revoked a promotion on that account and will not take the request as it stands.",
  unconfirmed_email: "Uber wants the email on that account confirmed first.",
  error_processing_request: "Uber could not process the request. Nothing was created.",
  invalid_mobile_phone_number: "Uber says the mobile number on that account is not valid.",
  unauthorized: "Uber did not accept the token.",
  forbidden: "Uber refused the call outright.",
};

/**
 * One Riders API request. Returns `{ ok, status, body }` or a refusal carrying Uber's own `code`
 * and `message`, plus the two interpretations that are the same on every endpoint:
 *
 *   401 ⇒ the grant is dead on Uber's side. The row is marked needing reconnect, because a 401 is
 *         Uber's answer and not a guess, and the next status should say "reconnect" rather than
 *         "never connected".
 *   403 on a privileged scope ⇒ this account is not one Limited Access covers. Named exactly, with
 *         the fix, because it is the single most likely thing to go wrong for anybody who is not
 *         the app's owner.
 */
export async function api(token, method, path, { query = null, body = null, fetchImpl = fetch, conversationId = null, scopes = [] } = {}) {
  const url = new URL(`${config.uberApiBase}/v1.2${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.uberTimeoutMs);
  try {
    const res = await fetchImpl(url.href, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    });
    // 204 is the documented answer to DELETE /requests/{id}: the ride is cancelled and there is
    // nothing to say back about it.
    if (res.status === 204) return { ok: true, status: 204, body: null };
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* fall through to the raw text */ }
    if (!res.ok) {
      const code = String(json?.code ?? json?.errors?.[0]?.code ?? "");
      const message = json?.message || json?.errors?.[0]?.title || text.slice(0, 200) || `HTTP ${res.status}`;
      if (res.status === 401 && conversationId) {
        const why = `Uber answered 401 ${code || "unauthorized"} — the token is no longer good.`;
        db.deleteOauthTokens(conversationId, PROVIDER);
        db.markAccountNeedsReconnect(conversationId, PROVIDER, why);
        return {
          ok: false, status: 401, code: code || "unauthorized", uber_said: message, state: "needs_reconnect",
          error: `${why} It has been dropped from this machine. Call uber_connect and send them a fresh link; nothing was done.`,
        };
      }
      if (res.status === 403) {
        const privileged = [...PRIVILEGED].filter(s => scopes.includes(s));
        return {
          ok: false, status: 403, code: code || "forbidden", uber_said: message, state: "blocked",
          error: `Uber refused it with a 403${code ? ` (${code})` : ""}: "${message}".`
            + (CODE_LINES[code] ? ` ${CODE_LINES[code]}` : "")
            + (privileged.length
              ? ` If that is not something about their own Uber account, this is Uber's Limited Access rule: ${privileged.join(" and ")} ${privileged.length > 1 ? "are" : "is"} a privileged scope,`
                + ` and Uber only honours it for ${config.ownerName}'s own Uber account and for the developer accounts listed in the app's dashboard at developer.uber.com/dashboard.`
                + ` The fix is one of exactly two things: ${config.ownerName} adds this person as a developer account there, or the app is submitted for Full Access (a complete app and a published public privacy policy).`
                + ` Say which it is honestly, do not retry, and offer uber_link.`
              : ""),
          use_instead: "uber_link",
        };
      }
      return {
        ok: false, status: res.status, code, uber_said: message,
        ...(json?.meta ? { meta: json.meta } : {}),
        error: `Uber said no (${res.status}${code ? ` ${code}` : ""}): "${message}".${CODE_LINES[code] ? ` ${CODE_LINES[code]}` : ""}`,
      };
    }
    return { ok: true, status: res.status, body: json };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, timedOut: true, error: `Uber did not answer within ${config.uberTimeoutMs / 1000}s.` };
    return { ok: false, unreachable: true, error: `Could not reach Uber: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- shaping what comes back ----------
// An Uber product is ~15 fields and four of them matter in a text message.

export function productView(p) {
  return {
    product_id: p.product_id,
    name: p.display_name,
    seats: p.capacity ?? null,
    shared: !!p.shared,
    upfront_fare: !!p.upfront_fare_enabled,
    ...(p.short_description ? { short: p.short_description } : {}),
    // Documented on GET /products, and the only place a cancellation fee is a FACT rather than a
    // warning: uber_cancel reads it from here rather than implying a number.
    ...(p.price_details?.cancellation_fee != null
      ? { cancellation_fee: p.price_details.cancellation_fee, currency: p.price_details.currency_code ?? "" }
      : {}),
  };
}

/**
 * An estimate response, whichever of the two documented shapes Uber answered with.
 *
 *   `fare`  — an upfront fare. It carries the fare_id a ride is actually booked at, so this is the
 *             only shape `uber_request` can work from.
 *   `price`  — an estimate, which is where surge lives: `surge_multiplier` above 1 with a
 *             `surge_confirmation_id` and the href the PERSON has to open themselves.
 *
 * `null` for a body with neither, which is reported as "Uber quoted nothing" rather than as a
 * fare of zero.
 */
export function quoteView(body) {
  if (!body || typeof body !== "object") return null;
  const trip = body.trip ?? null;
  const common = {
    pickup_eta_minutes: body.pickup_estimate ?? null,
    ...(trip ? {
      distance: trip.distance_estimate ?? null,
      distance_unit: trip.distance_unit ?? "",
      // Uber's own field. The curl tutorial's example is 600 for a 2.39-mile trip, which is
      // seconds; the v1 reference's example is 1 for a 1.0-mile trip, which is minutes. Their docs
      // disagree, so this hands the number back under Uber's own name and does not convert it into
      // a promise about how long the ride takes.
      duration_estimate: trip.duration_estimate ?? null,
    } : {}),
  };
  if (body.fare?.fare_id) {
    const f = body.fare;
    return {
      ...common,
      kind: "upfront_fare",
      fare_id: f.fare_id,
      display: f.display ?? "",
      value: typeof f.value === "number" ? f.value : null,
      currency: f.currency_code ?? "",
      // Uber sends this as unix seconds.
      expires_at: f.expires_at ? Number(f.expires_at) * 1000 : null,
      surge_multiplier: 1,
    };
  }
  if (body.price) {
    const p = body.price;
    const surge = Number(p.surge_multiplier ?? 1);
    return {
      ...common,
      kind: p.fare_id ? "upfront_fare" : "estimate",
      ...(p.fare_id ? { fare_id: p.fare_id } : {}),
      display: p.display ?? "",
      value: typeof p.low_estimate === "number" && p.low_estimate === p.high_estimate ? p.low_estimate : null,
      low: p.low_estimate ?? null,
      high: p.high_estimate ?? null,
      currency: p.currency_code ?? "",
      expires_at: p.expires_at ? Number(p.expires_at) * 1000 : null,
      surge_multiplier: Number.isFinite(surge) ? surge : 1,
      ...(p.surge_confirmation_id ? { surge_confirmation_id: p.surge_confirmation_id } : {}),
      ...(p.surge_confirmation_href ? { surge_confirmation_href: p.surge_confirmation_href } : {}),
    };
  }
  return null;
}

/** A ride, as a person reading a text wants it: who is coming, in what, and when. */
export function rideView(body) {
  if (!body) return null;
  const d = body.driver ?? null;
  const v = body.vehicle ?? null;
  return {
    request_id: body.request_id ?? "",
    status: body.status ?? "",
    what_that_means: STATUS_LINES[body.status] ?? "",
    eta_minutes: body.eta ?? null,
    surge_multiplier: body.surge_multiplier ?? null,
    driver: d ? { name: d.name ?? "", rating: d.rating ?? null, phone: d.phone_number ?? "" } : null,
    car: v ? [v.make, v.model].filter(Boolean).join(" ") : "",
    plate: v?.license_plate ?? "",
    ...(v?.picture_url ? { car_picture: v.picture_url } : {}),
    ...(body.location ? { driver_at: { latitude: body.location.latitude, longitude: body.location.longitude, bearing: body.location.bearing ?? null } } : {}),
    ...(body.destination ? { destination: body.destination } : {}),
    ...(body.pickup ? { pickup: body.pickup } : {}),
  };
}

/**
 * Uber's status words, said in English. The six are the ones their sandbox guide lists as the
 * settable values, which is the only place their docs enumerate them.
 */
export const STATUS_LINES = {
  processing: "Uber is still looking for a driver.",
  accepted: "A driver has accepted and is on the way.",
  arriving: "The driver is arriving now.",
  in_progress: "The ride is under way.",
  driver_canceled: "The driver cancelled.",
  rider_canceled: "The ride was cancelled on the rider's side.",
  completed: "The ride is finished.",
  no_drivers_available: "Uber found no driver and the request is over.",
};

/**
 * The page the person's browser lands on after they agree, and the way back to the thread.
 *
 * No tokens on it, ever. `renderConnected` is the page kit's end-of-flow template: it carries the
 * one Reason look and the Back to Reason button, so this says what happened and nothing else.
 */
export function callbackPage({ ok, message }) {
  return renderConnected({
    ok,
    title: ok ? "Uber connected" : "Uber not connected",
    lines: [message],
    meta: stamp(),
    back: { text: ok ? "connected uber, keep going" : "uber didn't connect" },
  });
}
