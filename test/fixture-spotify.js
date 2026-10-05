// A fake Spotify, served from the test.
//
// Every route is one Spotify really documents, with the method, the path, the parameters and the
// status codes their OpenAPI schema gives (read 2026-10-05) — including the awkward ones that are
// the whole reason this exists:
//
//   - `GET /v1/me/player` answers **204 with no body** when nothing is playing. That is a normal
//     state, not an error, and a client that treats it as one tells people their music is broken.
//   - the player writes answer **204** on success and say nothing back, so "it worked" and "what is
//     playing now" are two different questions.
//   - a player write on a free account answers **403**, and Spotify's documented error object
//     carries only a status and a message — no machine-readable reason. `premium: false` below
//     reproduces exactly that, which is what forces the client to say "probably Premium" rather
//     than asserting it.
//   - the token endpoint answers **400 with `error: "invalid_grant"`** for a dead refresh token,
//     which their docs say to treat as "send them through authorize again", not as a retry.
//
// `state` is the ground truth the tests assert on: what was played, queued, created, and every
// Authorization header that arrived — so "one person's token is never usable by another" is a thing
// a test can check from the server's side rather than taking the client's word for.
import { createServer } from "node:http";

const TRACKS = {
  "spotify:track:aaa": { id: "aaa", name: "Teenage Birdsong", artists: [{ name: "Four Tet" }], album: { name: "Sixteen Oceans" }, duration_ms: 324000 },
  "spotify:track:bbb": { id: "bbb", name: "Ribs", artists: [{ name: "Lorde" }], album: { name: "Pure Heroine" }, duration_ms: 258000 },
  "spotify:track:ccc": { id: "ccc", name: "Nights", artists: [{ name: "Frank Ocean" }], album: { name: "Blonde" }, duration_ms: 307000 },
};

// Everything Reason asks for, which is what somebody who taps Accept grants.
const ALL_SCOPES = [
  "user-read-playback-state", "user-read-currently-playing", "user-modify-playback-state",
  "playlist-modify-private", "playlist-modify-public", "user-read-recently-played", "user-top-read",
];

const withUris = (t) => ({
  ...t, type: "track", uri: `spotify:track:${t.id}`,
  external_urls: { spotify: `https://open.spotify.com/track/${t.id}` },
});

export async function startSpotify({
  premium = true,
  devices = [{ id: "dev1", name: "Omari's iPhone", type: "Smartphone", is_active: true, volume_percent: 60 }],
  playing = "spotify:track:aaa",
  // What the person ticked on the consent screen, which is what the token response reports back.
  //
  // Not derived from the exchange request, because Spotify's authorization_code exchange carries no
  // scope parameter — the scope was in the /authorize redirect the person's own browser followed,
  // which never touches this server. So the grant is stated here, and a test that wants somebody who
  // unticked half of it passes a shorter list.
  grantScopes = null,
  accessTtlSeconds = 3600,
  refreshTokenValid = true,
  // A refresh that does not hand back a new refresh token — Spotify's docs say this happens and
  // that the old one must keep being used.
  refreshReturnsNewRefreshToken = false,
} = {}) {
  const state = {
    tokenCalls: [],
    authHeaders: [],
    played: [],
    queued: [],
    paused: 0,
    skipped: [],
    playlists: [],
    added: [],
    // Which bearer tokens this server considers real. The test hands one person's token to
    // another person's conversation and checks the server rejects it.
    liveTokens: new Set(),
    accessCounter: 0,
  };
  const cfg = { premium, devices, playing, grantScopes, accessTtlSeconds, refreshTokenValid, refreshReturnsNewRefreshToken };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, body) => {
      const payload = body === null ? "" : JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload);
    };
    const err = (status, message) => json(status, { error: { status, message } });
    const noContent = () => { res.writeHead(204); res.end(); };

    const auth = req.headers.authorization ?? "";
    if (url.pathname.startsWith("/v1/")) state.authHeaders.push({ path: url.pathname, auth });

    // ---------- accounts.spotify.com ----------
    if (url.pathname === "/api/token" && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        const form = Object.fromEntries(new URLSearchParams(body));
        state.tokenCalls.push({ form, auth });
        // Spotify requires the client id and secret as a Basic header on this flow.
        if (!auth.startsWith("Basic ")) return json(401, { error: "invalid_client", error_description: "no Basic auth" });

        if (form.grant_type === "authorization_code") {
          if (form.code !== "good-code") return json(400, { error: "invalid_grant", error_description: "Invalid authorization code" });
          const token = `access-${++state.accessCounter}`;
          state.liveTokens.add(token);
          return json(200, {
            access_token: token, token_type: "Bearer",
            expires_in: cfg.accessTtlSeconds,
            refresh_token: "refresh-1",
            scope: (cfg.grantScopes ?? ALL_SCOPES).join(" "),
          });
        }
        if (form.grant_type === "refresh_token") {
          if (!cfg.refreshTokenValid || form.refresh_token !== "refresh-1") {
            // Exactly what their docs say a dead refresh token looks like.
            return json(400, { error: "invalid_grant", error_description: "Refresh token revoked" });
          }
          const token = `access-${++state.accessCounter}`;
          state.liveTokens.add(token);
          return json(200, {
            access_token: token, token_type: "Bearer", expires_in: cfg.accessTtlSeconds,
            ...(cfg.refreshReturnsNewRefreshToken ? { refresh_token: "refresh-2" } : {}),
            scope: (cfg.grantScopes ?? ALL_SCOPES).join(" "),
          });
        }
        return json(400, { error: "unsupported_grant_type" });
      });
      return;
    }

    // ---------- api.spotify.com ----------
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (url.pathname.startsWith("/v1/")) {
      if (!bearer) return err(401, "No token provided");
      if (!state.liveTokens.has(bearer)) return err(401, "Invalid access token");
    }

    if (url.pathname === "/v1/me" && req.method === "GET") {
      return json(200, { id: "omari", display_name: "Omari", product: cfg.premium ? "premium" : "free" });
    }

    if (url.pathname === "/v1/search" && req.method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const type = url.searchParams.get("type") ?? "track";
      const limit = Number(url.searchParams.get("limit") ?? 20);
      if (!q) return err(400, "No search query");
      const hits = Object.values(TRACKS)
        .filter(t => t.name.toLowerCase().includes(q) || t.artists[0].name.toLowerCase().includes(q))
        .slice(0, limit)
        .map(withUris);
      if (type === "track") return json(200, { tracks: { items: hits, total: hits.length } });
      if (type === "artist") {
        return json(200, { artists: { items: hits.map(t => ({ name: t.artists[0].name, uri: `spotify:artist:${t.id}`, genres: ["electronic"], external_urls: { spotify: "https://open.spotify.com/artist/x" } })) } });
      }
      return json(200, { [`${type}s`]: { items: [] } });
    }

    if (url.pathname === "/v1/me/player" && req.method === "GET") {
      // 204 and no body: Spotify's documented "playback not available or active".
      if (!cfg.playing) return noContent();
      return json(200, {
        is_playing: true, progress_ms: 61000,
        device: cfg.devices[0] ?? null,
        shuffle_state: false, repeat_state: "off",
        item: withUris(TRACKS[cfg.playing]),
      });
    }

    if (url.pathname === "/v1/me/player/devices" && req.method === "GET") {
      return json(200, { devices: cfg.devices });
    }

    const playerWrite = (what) => {
      if (!cfg.premium) {
        // Their error object has no `reason`. A client that switches on one is reading a field
        // Spotify does not document, so this does not provide one.
        return err(403, "Player command failed: Premium required");
      }
      if (!cfg.devices.length) return err(404, "Player command failed: No active device found");
      what();
      return noContent();
    };

    if (url.pathname === "/v1/me/player/play" && req.method === "PUT") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
        playerWrite(() => state.played.push({ body: parsed, device_id: url.searchParams.get("device_id") }));
      });
      return;
    }
    if (url.pathname === "/v1/me/player/pause" && req.method === "PUT") {
      return playerWrite(() => { state.paused++; });
    }
    if ((url.pathname === "/v1/me/player/next" || url.pathname === "/v1/me/player/previous") && req.method === "POST") {
      return playerWrite(() => state.skipped.push(url.pathname.endsWith("next") ? "next" : "previous"));
    }
    if (url.pathname === "/v1/me/player/queue" && req.method === "POST") {
      const uri = url.searchParams.get("uri");
      if (!uri) return err(400, "Required field 'uri' missing");
      return playerWrite(() => state.queued.push(uri));
    }

    if (url.pathname === "/v1/me/playlists" && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let p = null;
        try { p = JSON.parse(body); } catch { p = null; }
        if (!p?.name) return err(400, "Missing required field: name");
        const id = `pl${state.playlists.length + 1}`;
        const made = {
          id, name: p.name, description: p.description ?? "", public: p.public ?? true,
          uri: `spotify:playlist:${id}`, tracks: { total: 0 },
          external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
        };
        state.playlists.push(made);
        return json(201, made);
      });
      return;
    }

    const items = /^\/v1\/playlists\/([^/]+)\/items$/.exec(url.pathname);
    if (items && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let p = null;
        try { p = JSON.parse(body); } catch { p = null; }
        const uris = p?.uris ?? [];
        if (!uris.length) return err(400, "No uris provided");
        if (uris.length > 100) return err(400, "You can add a maximum of 100 tracks per request");
        if (!state.playlists.some(x => x.id === items[1])) return err(404, "Invalid playlist Id");
        state.added.push({ playlist: items[1], uris });
        return json(201, { snapshot_id: `snap-${state.added.length}` });
      });
      return;
    }

    if (url.pathname === "/v1/me/player/recently-played" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      return json(200, {
        items: Object.values(TRACKS).slice(0, limit).map((t, i) => ({
          track: withUris(t), played_at: `2026-10-0${i + 1}T20:00:00.000Z`,
        })),
      });
    }

    const top = /^\/v1\/me\/top\/(artists|tracks)$/.exec(url.pathname);
    if (top && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      if (top[1] === "tracks") return json(200, { items: Object.values(TRACKS).slice(0, limit).map(withUris) });
      return json(200, {
        items: [{ name: "Four Tet", uri: "spotify:artist:ft", genres: ["electronic", "idm"], external_urls: { spotify: "https://open.spotify.com/artist/ft" } }].slice(0, limit),
      });
    }

    return err(404, `No such route: ${req.method} ${url.pathname}`);
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    /** Change what Spotify is like mid-test: lose Premium, lose every device, kill the refresh. */
    set(patch) { Object.assign(cfg, patch); },
    close: () => new Promise(r => server.close(r)),
  };
}
