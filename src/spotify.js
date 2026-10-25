// Spotify, the documented way.
//
// Everything here was written from Spotify's current docs and their own OpenAPI schema, both read
// 2026-10-05; nothing is from memory and nothing is invented. The pieces that matter:
//
//   **Authorization code flow** (developer.spotify.com/documentation/web-api/tutorials/code-flow).
//   GET accounts.spotify.com/authorize with client_id, response_type=code, redirect_uri, state and
//   a space-separated scope. Spotify redirects back with ?code&state, or ?error&state. The code is
//   exchanged at POST accounts.spotify.com/api/token, form-encoded, grant_type=authorization_code,
//   with `Authorization: Basic base64(client_id:client_secret)`.
//
//   **Refreshing** (…/tutorials/refreshing-tokens). Access tokens last an hour. POST the same token
//   endpoint with grant_type=refresh_token. A refresh response does not always carry a new refresh
//   token, and their docs say to keep using the old one when it does not — so the store does, which
//   is why `saveOauthTokens` will not overwrite a refresh token with an empty string. `invalid_grant`
//   means the refresh token is dead (they last six months): discard it and send the person through
//   authorize again rather than retrying, which is exactly what their docs say to do.
//
//   **Redirect URI** (…/concepts/redirect_uri). Must match what is registered on the app exactly.
//   HTTPS unless it is a loopback literal, and `localhost` is forbidden by name — see
//   `callbackUrl()` in src/config.js.
//
//   **Premium, and a device.** The player endpoints that change anything — play, pause, next,
//   previous, add to queue — say in Spotify's own description that they "only work for users who
//   have Spotify Premium". Their documented error object carries only `status` and `message`, with
//   no machine-readable reason, so this does NOT invent an `error.reason` to switch on. What it
//   does instead is check the documented devices endpoint first and report what came back: no
//   device is a fact that endpoint can answer, and anything else is reported with Spotify's own
//   message attached rather than guessed at.
//
// Nothing in this file has ever been sent to Spotify: there was no SPOTIFY_CLIENT_ID on the
// machine it was written on. It has only answered a fake server standing in for Spotify, whose
// routes are the ones above. docs/unverified.md says so test by test.
import { config, clock, callbackUrl, stamp } from "./config.js";
import { renderConnected, backToReason, dark, THEME, iconLinks } from "./pages/render.js";
import { wordmark, WORDMARK_CSS } from "./pages/wordmark.js";
import { BRAND_ORANGE, BRAND_ORANGE_DARK, PAPER, PAPER_GRAIN } from "./pages/brand.js";
import * as db from "./db.js";

export const REDIRECT_PATH = "/spotify/callback";
export const JOIN_PATH = "/spotify/join";

/**
 * What Reason asks for, and why each one.
 *
 * Only scopes something below actually uses. A scope Reason does not need is a line on somebody's
 * consent screen that buys nothing, and scope lists are how an integration quietly becomes more
 * powerful than what it was agreed to do.
 */
export const SCOPES = {
  "user-read-playback-state": "see what is playing and which speakers are around",
  "user-read-currently-playing": "see the current track",
  "user-modify-playback-state": "play, pause, skip and queue",
  "playlist-modify-private": "make a private playlist and put tracks in it",
  "playlist-modify-public": "make a public playlist and put tracks in it",
  "user-read-recently-played": "what was played lately, for recommending something",
  "user-top-read": "top artists and tracks, for recommending something",
};
export const SCOPE_LIST = Object.keys(SCOPES);

/** Which scope each tool needs, so a missing one is named rather than discovered as a 403. */
export const TOOL_SCOPES = {
  spotify_search: [],
  spotify_now_playing: ["user-read-playback-state"],
  spotify_devices: ["user-read-playback-state"],
  spotify_play: ["user-modify-playback-state"],
  spotify_pause: ["user-modify-playback-state"],
  spotify_skip: ["user-modify-playback-state"],
  spotify_queue: ["user-modify-playback-state"],
  spotify_playlist_create: ["playlist-modify-private", "playlist-modify-public"],
  spotify_playlist_add: ["playlist-modify-private", "playlist-modify-public"],
  spotify_history: ["user-read-recently-played"],
  spotify_top: ["user-top-read"],
};

export function spotifyStatus({ clientId = config.spotifyClientId, clientSecret = config.spotifyClientSecret } = {}) {
  const missing = [];
  if (!clientId) missing.push("SPOTIFY_CLIENT_ID");
  if (!clientSecret) missing.push("SPOTIFY_CLIENT_SECRET");
  return {
    connected: missing.length === 0,
    missing,
    redirect_uri: callbackUrl(REDIRECT_PATH),
    what: "search Spotify, see and control what is playing, make playlists, and read listening history",
  };
}

/** The honest result when there is no developer app. Returned, never improvised by the model. */
export function notConnected(extra = {}) {
  const st = spotifyStatus();
  return {
    ok: false,
    status: "not_connected",
    missing: st.missing,
    error: `Spotify is not connected: this machine has no ${st.missing.join(" or ")}.`
      + ` ${config.ownerName} has to make a Spotify developer app at developer.spotify.com/dashboard,`
      + ` add ${st.redirect_uri} to its Redirect URIs exactly as written, and put the client id and secret in .env.`
      + ` Say that plainly and do not claim anything about their music.`,
    ...extra,
  };
}

// ---------- connecting ----------

/**
 * Step one: the link the person taps. Nothing is connected by calling this — Spotify's own consent
 * screen is what connects it, which is also why this does not go through the confirm gate. A URL
 * is not an action; the action is the person reading what they are granting and agreeing to it on
 * Spotify's page.
 */
export function authorizeUrl(conversationId, { scopes = SCOPE_LIST, showDialog = false } = {}) {
  const st = spotifyStatus();
  if (!st.connected) return notConnected();
  const want = scopes.filter(s => SCOPE_LIST.includes(s));
  if (!want.length) return { ok: false, error: `No known scopes asked for. Known: ${SCOPE_LIST.join(", ")}.` };
  const redirectUri = st.redirect_uri;
  // One handshake at a time per person: an old pending state is of no use once a new link is sent,
  // and leaving it live leaves a second usable callback lying around.
  db.clearOauthStates(conversationId, "spotify");
  const state = db.newOauthState({ conversationId, provider: "spotify", scope: want.join(" "), redirectUri });
  const q = new URLSearchParams({
    client_id: config.spotifyClientId,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    scope: want.join(" "),
    ...(showDialog ? { show_dialog: "true" } : {}),
  });
  return {
    ok: true,
    url: `${config.spotifyAccountsBase}/authorize?${q}`,
    scopes: want.map(s => ({ scope: s, so_that: SCOPES[s] })),
    redirect_uri: redirectUri,
    reachable: config.publicUrl
      ? null
      : `This redirects to ${redirectUri}, which only opens on the Mac Reason runs on. Tapping the link from a phone will get as far as Spotify and then fail to come back. Set REASON_PUBLIC_URL for that to work from anywhere.`,
    note: "Nothing is connected until they open this and agree on Spotify's own page. The link works once.",
  };
}

function basicAuth() {
  return "Basic " + Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString("base64");
}

async function postToken(body, { fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.spotifyTimeoutMs);
  try {
    const res = await fetchImpl(`${config.spotifyAccountsBase}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
      body: new URLSearchParams(body).toString(),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* Spotify answers JSON; a non-JSON body is the error */ }
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, error: json?.error_description || json?.error || text.slice(0, 200) || `HTTP ${res.status}`, code: json?.error ?? "" };
    }
    return { ok: true, body: json ?? {} };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: `Spotify did not answer within ${config.spotifyTimeoutMs / 1000}s.` };
    return { ok: false, error: `Could not reach Spotify: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Step two, run by the HTTP route when Spotify redirects back. The `state` is what ties the
 * callback to a conversation, and it is spent on the way through: a replayed callback writes
 * nothing.
 */
export async function completeConnect({ code, state, error = "", fetchImpl = fetch } = {}) {
  const row = db.spendOauthState(state);
  if (!row) return { ok: false, reason: "bad_state", error: "That link has already been used, or it is not one of ours. Ask Reason for a new one." };
  if (row.provider !== "spotify") return { ok: false, reason: "bad_state", error: "That link is not a Spotify one." };
  if (error) {
    const friendly = error === "access_denied"
      ? "Your Spotify account is not on the allowlist yet. Text Reason your Spotify email and it will sort it out."
      : `Spotify said: ${error}`;
    return { ok: false, reason: "declined", conversationId: row.conversation_id, error: friendly };
  }
  if (!code) return { ok: false, reason: "no_code", conversationId: row.conversation_id, error: "Spotify came back without a code." };

  const got = await postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: row.redirect_uri,
  }, { fetchImpl });
  if (!got.ok) return { ok: false, reason: "token_exchange_failed", conversationId: row.conversation_id, error: got.error };

  const b = got.body;
  if (!b.access_token) return { ok: false, reason: "token_exchange_failed", conversationId: row.conversation_id, error: "Spotify returned no access token." };
  const granted = String(b.scope ?? "").split(/\s+/).filter(Boolean);

  db.saveOauthTokens(row.conversation_id, "spotify", {
    accessToken: b.access_token,
    refreshToken: b.refresh_token ?? "",
    // What Spotify actually granted, not what was asked for. The person can untick things on the
    // consent screen, and a tool that needs a scope they withheld has to say which one.
    scope: granted.join(" "),
    expiresAt: b.expires_in ? clock.now() + Number(b.expires_in) * 1000 : null,
  });
  db.connectAccount(row.conversation_id, "spotify", granted);
  return { ok: true, conversationId: row.conversation_id, scopes: granted };
}

/** Cut it off: the tokens go, and so does the connected-accounts row. */
export function disconnect(conversationId) {
  const tokens = db.deleteOauthTokens(conversationId, "spotify");
  db.clearOauthStates(conversationId, "spotify");
  const row = db.revokeAccount(conversationId, "spotify");
  return {
    ok: true,
    status: "revoked",
    tokens_deleted: tokens,
    was_connected: !!row || tokens > 0,
    note: "The tokens are gone from this machine. Spotify also keeps a record of the app on their side:"
      + " spotify.com/account/apps is where it is taken away there too, and only they can do that.",
  };
}

// ---------- using it ----------

/**
 * A live access token for this person, refreshed if it has expired.
 *
 * Scoped by conversation and there is no other way in: `db.getOauthTokens` takes the conversation
 * id, so one person's token is not reachable from another person's thread by any argument the
 * model could pass. That is the isolation, and it is a property of the query rather than a check
 * somebody remembered to write.
 */
export async function accessTokenFor(conversationId, { fetchImpl = fetch } = {}) {
  const st = spotifyStatus();
  if (!st.connected) return notConnected();
  const row = db.getOauthTokens(conversationId, "spotify");
  if (!row) {
    return {
      ok: false, status: "not_connected",
      error: `${accountName(conversationId)} has not connected Spotify yet. Call spotify_connect and send them the link; nothing about their music is knowable until they agree on Spotify's own page.`,
    };
  }
  // A minute of slack: a token that expires while the request is in flight is a confusing 401.
  const fresh = row.expires_at === null || row.expires_at - 60_000 > clock.now();
  if (fresh) return { ok: true, token: row.access_token, scopes: scopesOf(row), refreshed: false };

  if (!row.refresh_token) {
    return { ok: false, status: "needs_reconnect", error: "That Spotify token expired and there is no refresh token to renew it with. Call spotify_connect for a fresh link." };
  }
  const got = await postToken({ grant_type: "refresh_token", refresh_token: row.refresh_token }, { fetchImpl });
  if (!got.ok) {
    // Their docs are explicit: invalid_grant means expired, revoked or otherwise dead — discard it
    // and send the person through authorize again rather than retrying the refresh.
    if (got.code === "invalid_grant") {
      db.deleteOauthTokens(conversationId, "spotify");
      db.revokeAccount(conversationId, "spotify");
      return {
        ok: false, status: "needs_reconnect",
        error: "Spotify will not renew that connection any more (refresh tokens last six months, or it was revoked). It has been dropped from this machine. Call spotify_connect for a new link.",
      };
    }
    return { ok: false, status: "refresh_failed", error: `Could not renew the Spotify token: ${got.error}` };
  }
  const b = got.body;
  const saved = db.saveOauthTokens(conversationId, "spotify", {
    accessToken: b.access_token,
    refreshToken: b.refresh_token ?? "",
    scope: String(b.scope ?? row.scope ?? ""),
    expiresAt: b.expires_in ? clock.now() + Number(b.expires_in) * 1000 : null,
  });
  return { ok: true, token: saved.access_token, scopes: scopesOf(saved), refreshed: true };
}

function scopesOf(row) {
  return String(row?.scope ?? "").split(/\s+/).filter(Boolean);
}

function accountName(conversationId) {
  return conversationId === config.ownerConversation ? config.ownerName : "they";
}

/** Which scope is missing for this tool, if any. One of the alternatives is enough. */
export function missingScopeFor(tool, scopes) {
  const need = TOOL_SCOPES[tool] ?? [];
  if (!need.length) return null;
  return need.some(s => scopes.includes(s)) ? null : need;
}

/**
 * One Web API request. Returns `{ ok, status, body }` or `{ ok: false, error }` — and never
 * interprets a failure beyond what Spotify said, because their documented error object is just a
 * status and a message.
 */
export async function api(token, method, path, { query = null, body = null, fetchImpl = fetch } = {}) {
  const url = new URL(`${config.spotifyApiBase}/v1${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.spotifyTimeoutMs);
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
    // 204 is a real answer on this API and means different things per endpoint: "nothing is
    // playing" on GET /me/player, "command sent" on the player writes.
    if (res.status === 204) return { ok: true, status: 204, body: null };
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* fall through to the raw text */ }
    if (!res.ok) {
      return {
        ok: false, status: res.status,
        error: json?.error?.message || json?.error_description || text.slice(0, 200) || `HTTP ${res.status}`,
        retry_after_s: res.status === 429 ? Number(res.headers.get("retry-after") || 0) || null : null,
      };
    }
    return { ok: true, status: res.status, body: json };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: `Spotify did not answer within ${config.spotifyTimeoutMs / 1000}s.` };
    return { ok: false, error: `Could not reach Spotify: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- shaping what comes back ----------
// A Spotify track object is ~40 fields and three of them matter in a text message. These keep the
// conversation small, and they drop nothing a person would be told.

const artistsOf = (t) => (t?.artists ?? []).map(a => a.name).filter(Boolean).join(", ");

export function trackView(t) {
  if (!t) return null;
  return {
    name: t.name,
    by: artistsOf(t),
    album: t.album?.name ?? "",
    uri: t.uri,
    minutes: t.duration_ms ? Math.round(t.duration_ms / 1000 / 60 * 10) / 10 : null,
    link: t.external_urls?.spotify ?? "",
  };
}

export function playlistView(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    tracks: p.tracks?.total ?? 0,
    public: p.public ?? null,
    link: p.external_urls?.spotify ?? "",
    uri: p.uri,
  };
}

export function deviceView(d) {
  return { id: d.id, name: d.name, type: d.type, active: !!d.is_active, volume: d.volume_percent ?? null };
}

/**
 * What the player state means, said in words rather than left as a status code.
 *
 * A 204 from GET /me/player is documented as "Playback not available or active", which is the same
 * answer as "Spotify is closed everywhere" — so that is what it is reported as, and not as an error.
 */
export function playbackView(body) {
  if (!body) {
    return { playing: false, what: "Nothing is playing. Spotify says there is no active playback on any of their devices right now." };
  }
  const item = body.item;
  return {
    playing: !!body.is_playing,
    track: trackView(item),
    on_device: body.device ? deviceView(body.device) : null,
    progress_minutes: body.progress_ms != null ? Math.round(body.progress_ms / 1000 / 60 * 10) / 10 : null,
    shuffle: body.shuffle_state ?? null,
    repeat: body.repeat_state ?? null,
    what: body.is_playing && item
      ? `${item.name} by ${artistsOf(item)}${body.device ? ` on ${body.device.name}` : ""}`
      : item
        ? `paused on ${item.name} by ${artistsOf(item)}`
        : "Spotify has a session but is not on a track.",
  };
}

/**
 * The line a player write gets when Spotify refuses it.
 *
 * The two usual causes are no Premium and no device with Spotify open, and Spotify's documented
 * error object says which only in prose. So both are named as possibilities, Spotify's own message
 * is quoted, and the device list — which IS answerable — is used to settle it where it can.
 */
export function playerRefusal({ status, error, devices = null, action = "that" }) {
  const none = Array.isArray(devices) && devices.length === 0;
  if (none) {
    return {
      ok: false, status: "no_active_device",
      spotify_said: error,
      error: `Spotify has nowhere to ${action}: no device of theirs has Spotify open right now (their devices endpoint came back empty). Tell them to open Spotify on their phone, laptop or speaker and then ask again — nothing was changed.`,
    };
  }
  if (status === 403) {
    return {
      ok: false, status: "forbidden",
      spotify_said: error,
      error: `Spotify refused it. Their docs say play, pause, skip and queue only work on a Spotify Premium account, so that is the likely reason — but their error does not say which, and it would be wrong to tell them it is definitely the subscription. What Spotify said: "${error}". Nothing was changed.`,
    };
  }
  if (status === 404) {
    return {
      ok: false, status: "not_found",
      spotify_said: error,
      error: `Spotify could not find what to ${action} on — usually no active device, sometimes a track or playlist that is not there. What Spotify said: "${error}". Nothing was changed.`,
    };
  }
  return { ok: false, status: status ? `http_${status}` : "unreachable", spotify_said: error, error: `Spotify would not ${action}: ${error}. Nothing was changed.` };
}

/** The URL non-owner users are sent to, so they can submit their Spotify email for whitelisting. */
export function joinUrl(conversationId) {
  const st = spotifyStatus();
  if (!st.connected) return null;
  const state = db.newOauthState({ conversationId, provider: "spotify_join", scope: "", redirectUri: "" });
  return `${callbackUrl(JOIN_PATH)}?t=${state}`;
}

/** The form page where a non-owner enters their Spotify email. */
export function joinPage({ ownerName = config.ownerName, token = "", error = "", done = false } = {}) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const title = done ? "Got it" : "Connect Spotify";
  // The done state is the end of a flow Reason sent them into, so it ends with the way back rather
  // than a sentence telling them to go and find the thread themselves.
  const body = done
    ? `<p>${esc(ownerName)} has been notified. Once you are added you can text Reason to connect your Spotify.</p>`
      + backToReason({ text: "sent my spotify email, keep going" })
    : `<p>Spotify needs ${esc(ownerName)} to add your account before you can connect it.</p>`
      + `<p>Enter the email you use to log in to Spotify:</p>`
      + (error ? `<p style="color:var(--mark)">${esc(error)}</p>` : "")
      + `<form method="POST" action="${JOIN_PATH}">`
      + `<input type="hidden" name="t" value="${esc(token)}">`
      + `<input type="email" name="email" required placeholder="you@example.com" style="width:100%;padding:.6rem .8rem;font-size:1rem;border:1px solid var(--edge);border-radius:.5rem;background:var(--bg);color:var(--fg);margin-bottom:.75rem">`
      + `<button type="submit" style="padding:.6rem 1.5rem;font-size:1rem;border:none;border-radius:.5rem;background:var(--fg);color:var(--bg);cursor:pointer">Submit</button>`
      + `</form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${iconLinks()}
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<script>${THEME.head}</script>
<style>
:root{color-scheme:light dark;--ground:${PAPER.ground};--bg:${PAPER.bg};--fg:${PAPER.ink};--mute:${PAPER.dim};--grain:${PAPER_GRAIN};--line:${PAPER.line};--edge:rgba(22,19,15,.19);--mark:${BRAND_ORANGE}}
${dark([["", `--grain:none;--ground:#0b0a09;--bg:#12110f;--fg:#f3efe8;--mute:#a39c91;--line:#2c2924;--edge:rgba(255,255,255,.17);--mark:${BRAND_ORANGE_DARK}`]])}
*{box-sizing:border-box}body{margin:0;font:17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;background:var(--grain) var(--ground);color:var(--fg)}
.bar{display:flex;align-items:center;gap:.45rem;padding:14px 16px 10px;font:500 1rem/1.2 ui-serif,"New York","Iowan Old Style",Georgia,serif}
${WORDMARK_CSS}
${THEME.css}
.sheet{background:var(--grain) var(--bg);border-radius:1.5rem 1.5rem 0 0;min-height:100dvh}
main{max-width:32rem;margin:0 auto;padding:2rem 1.5rem}
h1{font-size:1.3rem;margin:0 0 .5rem}.lead{color:var(--mute);margin:0 0 .5rem;font-size:.9rem}
</style></head><body>
<div class="bar">${wordmark()}</div>
<div class="sheet"><main>
<h1>${esc(title)}</h1>
${body}
<p class="lead">${stamp()}</p>
${THEME.markup}
</main></div><script>${THEME.js}</script></body></html>`;
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
    title: ok ? "Spotify connected" : "Spotify not connected",
    lines: [message],
    meta: stamp(),
    back: { text: ok ? "connected spotify, keep going" : "spotify didn't connect" },
  });
}
