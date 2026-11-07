// X (Twitter), the documented way.
//
// Everything here was written from X's current docs (docs.x.com), nothing is from memory and
// nothing is invented. The pieces that matter:
//
//   **OAuth 2.0 Authorization Code Flow with PKCE** (docs.x.com/fundamentals/authentication/
//   oauth-2-0/authorization-code). GET x.com/i/oauth2/authorize with client_id, redirect_uri,
//   response_type=code, state, scope (space-separated), code_challenge, and
//   code_challenge_method=S256. X redirects back with ?code&state. The code is exchanged at
//   POST api.x.com/2/oauth2/token with client_id, code_verifier, grant_type=authorization_code,
//   and redirect_uri. Confidential clients send client_id:client_secret as Basic auth.
//
//   **Access tokens expire in two hours.** A refresh token comes back ONLY if `offline.access` is
//   in the scope. The refresh endpoint is the same token URL with grant_type=refresh_token. A
//   refresh also returns a NEW refresh token — the old one is dead once used.
//
//   **PKCE is required.** Generate a random code_verifier (43–128 chars, unreserved URI chars),
//   hash it with SHA-256, base64url-encode the hash, and send the result as code_challenge with
//   code_challenge_method=S256. The code_verifier goes in the token exchange, not in the
//   authorize URL — which is why it has to be stored alongside the state.
//
//   **Scopes** (docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code#scopes).
//   Fine-grained: tweet.read, tweet.write, users.read, like.read, like.write, bookmark.read,
//   bookmark.write, dm.read, dm.write, follows.read, offline.access, etc.
//
//   **Pay-per-usage pricing.** No fixed tiers. Post read $0.005, post create $0.015, DM read
//   $0.010, etc. Deduplication within 24h UTC. Own reads at $0.001.
//
//   **Rate limits.** Per-app and per-user. 900 req/15min for tweet lookup and user lookup with
//   OAuth 2.0. Tweet creation is 200/15min per user, 300/3h per app.
import { config, clock, callbackUrl, stamp } from "./config.js";
import { renderConnected } from "./pages/render.js";
import * as db from "./db.js";
import { startLink } from "./connectgate.js";
import { createHash, randomBytes } from "node:crypto";

export const PROVIDER = "x";
export const REDIRECT_PATH = "/x/callback";

export const SCOPES = {
  "tweet.read": "see tweets, including from protected accounts you follow",
  "tweet.write": "post and reply for you",
  "users.read": "see account info",
  "like.read": "see tweets you have liked",
  "like.write": "like and unlike tweets for you",
  "bookmark.read": "see your bookmarks",
  "bookmark.write": "bookmark and unbookmark tweets for you",
  "dm.read": "read your direct messages",
  "dm.write": "send direct messages for you",
  "follows.read": "see who you follow and who follows you",
  "offline.access": "stay connected until you revoke access",
};
export const SCOPE_LIST = Object.keys(SCOPES);

export const TOOL_SCOPES = {
  x_profile: ["users.read"],
  x_mentions: ["tweet.read", "users.read"],
  x_timeline: ["tweet.read", "users.read"],
  x_search: ["tweet.read"],
  x_post: ["tweet.read", "tweet.write", "users.read"],
  x_reply: ["tweet.read", "tweet.write", "users.read"],
  x_retweet: ["tweet.read", "tweet.write"],
  x_like: ["like.write"],
  x_unlike: ["like.write"],
  x_bookmark: ["bookmark.write"],
  x_bookmark_remove: ["bookmark.write"],
  x_bookmarks: ["bookmark.read", "users.read"],
  x_dm: ["dm.write"],
  x_dm_list: ["dm.read"],
  x_delete: ["tweet.write"],
};

export function xStatus({ clientId = config.xClientId, clientSecret = config.xClientSecret } = {}) {
  const missing = [];
  if (!clientId) missing.push("X_CLIENT_ID");
  if (!clientSecret) missing.push("X_CLIENT_SECRET");
  return {
    connected: missing.length === 0,
    missing,
    redirect_uri: callbackUrl(REDIRECT_PATH),
    what: "read and post on X, see and send DMs, like and bookmark tweets",
  };
}

export function notConnected(extra = {}) {
  const st = xStatus();
  return {
    ok: false,
    status: "not_connected",
    missing: st.missing,
    error: `X is not connected: this machine has no ${st.missing.join(" or ")}.`
      + ` ${config.ownerName} has to make an X developer app at developer.x.com, enable OAuth 2.0,`
      + ` set the type to "Web App" (confidential client), add ${st.redirect_uri} to its Redirect URIs exactly as written,`
      + ` and put the client id and secret in .env.`
      + ` Say that plainly and do not claim anything about their X account.`,
    ...extra,
  };
}

// ---------- PKCE ----------

function generateCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

function codeChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ---------- connecting ----------

export function authorizeUrl(conversationId, { scopes = SCOPE_LIST } = {}) {
  const st = xStatus();
  if (!st.connected) return notConnected();
  const want = scopes.filter(s => SCOPE_LIST.includes(s));
  if (!want.length) return { ok: false, error: `No known scopes asked for. Known: ${SCOPE_LIST.join(", ")}.` };
  if (!want.includes("offline.access")) want.push("offline.access");
  const redirectUri = st.redirect_uri;
  db.clearOauthStates(conversationId, PROVIDER);
  const verifier = generateCodeVerifier();
  const state = db.newOauthState({ conversationId, provider: PROVIDER, scope: want.join(" "), redirectUri, codeVerifier: verifier });
  const q = new URLSearchParams({
    response_type: "code",
    client_id: config.xClientId,
    redirect_uri: redirectUri,
    state,
    scope: want.join(" "),
    code_challenge: codeChallenge(verifier),
    code_challenge_method: "S256",
  });
  return {
    ok: true,
    // What is texted is Reason's start page: it only sends the asker's own browser on to this
    // address (src/connectgate.js).
    url: startLink(state, `${config.xAuthBase}/i/oauth2/authorize?${q}`, redirectUri),
    scopes: want.map(s => ({ scope: s, so_that: SCOPES[s] ?? s })),
    redirect_uri: redirectUri,
    reachable: config.publicUrl
      ? null
      : `This redirects to ${redirectUri}, which only opens on the Mac Reason runs on. Tapping the link from a phone will get as far as X and then fail to come back. Set REASON_PUBLIC_URL for that to work from anywhere.`,
    note: "Nothing is connected until they open this and agree on X's own page. The link works once.",
  };
}

function basicAuth() {
  return "Basic " + Buffer.from(`${config.xClientId}:${config.xClientSecret}`).toString("base64");
}

async function postToken(body, { fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.xTimeoutMs);
  try {
    const res = await fetchImpl(`${config.xApiBase}/2/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
      body: new URLSearchParams(body).toString(),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* fall through */ }
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, error: json?.error_description || json?.error || text.slice(0, 200) || `HTTP ${res.status}`, code: json?.error ?? "" };
    }
    return { ok: true, body: json ?? {} };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: `X did not answer within ${config.xTimeoutMs / 1000}s.` };
    return { ok: false, error: `Could not reach X: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function completeConnect({ code, state, error = "", fetchImpl = fetch } = {}) {
  const row = db.spendOauthState(state, { maxAgeMs: config.xStateTtlMs });
  if (!row) return { ok: false, reason: "bad_state", error: "That link has already been used, expired, or is not one of ours. Ask Reason for a new one." };
  if (row.provider !== PROVIDER) return { ok: false, reason: "bad_state", error: "That link is not an X one." };
  if (error) return { ok: false, reason: "declined", conversationId: row.conversation_id, error: `X said: ${error}` };
  if (!code) return { ok: false, reason: "no_code", conversationId: row.conversation_id, error: "X came back without a code." };

  const verifier = row.code_verifier;
  if (!verifier) return { ok: false, reason: "no_verifier", conversationId: row.conversation_id, error: "The PKCE verifier for this state is missing. Ask Reason for a new link." };

  const got = await postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: row.redirect_uri,
    client_id: config.xClientId,
    code_verifier: verifier,
  }, { fetchImpl });
  if (!got.ok) return { ok: false, reason: "token_exchange_failed", conversationId: row.conversation_id, error: got.error };

  const b = got.body;
  if (!b.access_token) return { ok: false, reason: "token_exchange_failed", conversationId: row.conversation_id, error: "X returned no access token." };
  const granted = String(b.scope ?? "").split(/\s+/).filter(Boolean);

  let username = "";
  let userId = "";
  try {
    const userRes = await api(b.access_token, "GET", "/2/users/me", { fetchImpl });
    if (userRes.ok) {
      username = userRes.body?.data?.username ?? "";
      userId = userRes.body?.data?.id ?? "";
    }
  } catch { /* the token works, the profile call did not — connect anyway */ }

  db.saveOauthTokens(row.conversation_id, PROVIDER, {
    accessToken: b.access_token,
    refreshToken: b.refresh_token ?? "",
    scope: granted.join(" "),
    expiresAt: b.expires_in ? clock.now() + Number(b.expires_in) * 1000 : null,
    account: username,
  });
  db.connectAccount(row.conversation_id, "x", granted, { account: username });
  return { ok: true, conversationId: row.conversation_id, scopes: granted, username, userId };
}

export function disconnect(conversationId) {
  const tokens = db.deleteOauthTokens(conversationId, PROVIDER);
  db.clearOauthStates(conversationId, PROVIDER);
  const row = db.revokeAccount(conversationId, "x");
  return {
    ok: true,
    status: "revoked",
    tokens_deleted: tokens,
    was_connected: !!row || tokens > 0,
    note: "The tokens are gone from this machine. X also keeps a record of the app on their side:"
      + " x.com/settings/connected_apps is where it is taken away there too, and only they can do that.",
  };
}

// ---------- using it ----------

export async function accessTokenFor(conversationId, { fetchImpl = fetch } = {}) {
  const st = xStatus();
  if (!st.connected) return notConnected();
  const row = db.getOauthTokens(conversationId, PROVIDER);
  if (!row) {
    return {
      ok: false, status: "not_connected",
      error: `This person has not connected X yet. Call x_connect and send them the link; nothing about their X account is knowable until they agree on X's own page.`,
    };
  }
  const fresh = row.expires_at === null || row.expires_at - 60_000 > clock.now();
  if (fresh) return { ok: true, token: row.access_token, scopes: scopesOf(row), refreshed: false, account: row.account_label };

  if (!row.refresh_token) {
    return { ok: false, status: "needs_reconnect", error: "That X token expired and there is no refresh token. Call x_connect for a fresh link." };
  }
  const got = await postToken({ grant_type: "refresh_token", refresh_token: row.refresh_token, client_id: config.xClientId }, { fetchImpl });
  if (!got.ok) {
    if (got.code === "invalid_grant" || got.code === "invalid_request") {
      db.deleteOauthTokens(conversationId, PROVIDER);
      db.revokeAccount(conversationId, "x");
      return {
        ok: false, status: "needs_reconnect",
        error: "X will not renew that connection any more (the refresh token was revoked or expired). It has been dropped from this machine. Call x_connect for a new link.",
      };
    }
    return { ok: false, status: "refresh_failed", error: `Could not renew the X token: ${got.error}` };
  }
  const b = got.body;
  const saved = db.saveOauthTokens(conversationId, PROVIDER, {
    accessToken: b.access_token,
    refreshToken: b.refresh_token ?? "",
    scope: String(b.scope ?? row.scope ?? ""),
    expiresAt: b.expires_in ? clock.now() + Number(b.expires_in) * 1000 : null,
  });
  return { ok: true, token: saved.access_token, scopes: scopesOf(saved), refreshed: true, account: row.account_label };
}

function scopesOf(row) {
  return String(row?.scope ?? "").split(/\s+/).filter(Boolean);
}

function accountName(conversationId) {
  return conversationId === config.ownerConversation ? config.ownerName : "they";
}

export function missingScopeFor(tool, scopes) {
  const need = TOOL_SCOPES[tool] ?? [];
  if (!need.length) return null;
  return need.some(s => scopes.includes(s)) ? null : need;
}

export async function userIdFor(conversationId, { fetchImpl = fetch } = {}) {
  const tok = await accessTokenFor(conversationId, { fetchImpl });
  if (!tok.ok) return { ok: false, error: tok.error };
  const res = await api(tok.token, "GET", "/2/users/me", { fetchImpl });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, id: res.body?.data?.id ?? "", username: res.body?.data?.username ?? "" };
}

// ---------- API ----------

export async function api(token, method, path, { query = null, body = null, fetchImpl = fetch } = {}) {
  const url = new URL(`${config.xApiBase}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.xTimeoutMs);
  try {
    const res = await fetchImpl(url.href, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    });
    if (res.status === 204) return { ok: true, status: 204, body: null };
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* fall through */ }
    if (!res.ok) {
      return {
        ok: false, status: res.status,
        error: json?.detail || json?.title || json?.error_description || text.slice(0, 200) || `HTTP ${res.status}`,
        retry_after_s: res.status === 429 ? Number(res.headers.get("retry-after") || 0) || null : null,
      };
    }
    return { ok: true, status: res.status, body: json };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: `X did not answer within ${config.xTimeoutMs / 1000}s.` };
    return { ok: false, error: `Could not reach X: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- shaping what comes back ----------

export function tweetView(t) {
  if (!t) return null;
  return {
    id: t.id,
    text: t.text ?? "",
    author_id: t.author_id ?? "",
    created_at: t.created_at ?? "",
    conversation_id: t.conversation_id ?? "",
    in_reply_to: t.in_reply_to_user_id ?? null,
    metrics: t.public_metrics ?? null,
    url: t.author_id ? `https://x.com/i/status/${t.id}` : "",
  };
}

export function userView(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name ?? "",
    username: u.username ?? "",
    bio: u.description ?? "",
    followers: u.public_metrics?.followers_count ?? 0,
    following: u.public_metrics?.following_count ?? 0,
    tweets: u.public_metrics?.tweet_count ?? 0,
    verified: u.verified ?? false,
    url: u.username ? `https://x.com/${u.username}` : "",
  };
}

export function dmView(ev) {
  if (!ev) return null;
  return {
    id: ev.id,
    text: ev.text ?? "",
    sender_id: ev.sender_id ?? "",
    created_at: ev.created_at ?? "",
    event_type: ev.event_type ?? "",
    dm_conversation_id: ev.dm_conversation_id ?? "",
  };
}

/**
 * The page the person's browser lands on after they agree, and the way back to the thread.
 *
 * No tokens on it, ever. `renderConnected` is the page kit's end-of-flow template: it carries the
 * one Reason look and the Back to Reason button, so this says what happened and nothing else.
 */
export function callbackPage({ ok, message }) {
  return renderConnected({
    ok,
    title: ok ? "X connected" : "X not connected",
    lines: [message],
    meta: stamp(),
    back: { text: ok ? "connected x, keep going" : "x didn't connect" },
  });
}
