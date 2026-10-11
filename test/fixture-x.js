// A fake X (Twitter) API, served from the test.
//
// Every route matches what X documents at developer.x.com/en/docs/x-api.
//
//   - Token exchange at POST /2/oauth2/token with Basic auth (confidential client).
//   - PKCE: code_verifier is required on the authorization_code grant; code_challenge is
//     validated by X (here we just check it is present and non-empty).
//   - Access tokens expire in 7200s; refresh returns a NEW refresh token (old one dies).
//   - API requests use Bearer auth.
//   - Pay-per-usage: no rate limits in this fixture.
//
// `state` is the ground truth the tests assert on.
import { createServer } from "node:http";

const USER = {
  id: "9900001",
  name: "Omari",
  username: "omari",
  description: "Builder.",
  verified: false,
  created_at: "2020-01-15T00:00:00.000Z",
  public_metrics: { followers_count: 1200, following_count: 350, tweet_count: 4200, listed_count: 18 },
};

const TWEETS = [
  { id: "t1001", text: "Shipping something new today.", author_id: "9900001", created_at: "2026-10-10T14:00:00.000Z", conversation_id: "t1001", public_metrics: { like_count: 42, retweet_count: 5, reply_count: 3, quote_count: 1, impression_count: 1200 } },
  { id: "t1002", text: "Good morning world.", author_id: "9900001", created_at: "2026-10-10T08:00:00.000Z", conversation_id: "t1002", public_metrics: { like_count: 10, retweet_count: 0, reply_count: 1, quote_count: 0, impression_count: 400 } },
];

const MENTIONS = [
  { id: "t2001", text: "@omari this is amazing", author_id: "8800001", created_at: "2026-10-10T16:00:00.000Z", conversation_id: "t2001", in_reply_to_user_id: "9900001", public_metrics: { like_count: 3, retweet_count: 0, reply_count: 0, quote_count: 0, impression_count: 80 } },
  { id: "t2002", text: "@omari what stack are you using?", author_id: "8800002", created_at: "2026-10-10T15:30:00.000Z", conversation_id: "t2002", in_reply_to_user_id: "9900001", public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0, impression_count: 40 } },
];

const BOOKMARKS = [
  { id: "t3001", text: "Great thread on system design.", author_id: "7700001", created_at: "2026-10-09T12:00:00.000Z", public_metrics: { like_count: 500, retweet_count: 120, reply_count: 30, quote_count: 15, impression_count: 50000 } },
];

const DM_EVENTS = [
  { id: "dm1001", text: "Hey, are you free tomorrow?", sender_id: "8800001", event_type: "MessageCreate", created_at: "2026-10-10T18:00:00.000Z", dm_conversation_id: "dmconv001" },
  { id: "dm1002", text: "Sounds good, see you then", sender_id: "9900001", event_type: "MessageCreate", created_at: "2026-10-10T17:30:00.000Z", dm_conversation_id: "dmconv001" },
];

export async function startX({
  grantScopes = "tweet.read tweet.write users.read dm.read dm.write like.read like.write bookmark.read bookmark.write offline.access",
} = {}) {
  const state = {
    tokenCalls: [],
    authHeaders: [],
    tweetsPosted: [],
    tweetsDeleted: [],
    retweets: [],
    likes: [],
    unlikes: [],
    bookmarksAdded: [],
    bookmarksRemoved: [],
    dmsSent: [],
    liveTokens: new Set(),
    refreshTokens: new Map(),
    accessCounter: 0,
    refreshCounter: 0,
  };
  const cfg = { grantScopes };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const err = (status, detail) => json(status, { detail, title: "Error", type: "about:blank", status });

    const auth = req.headers.authorization ?? "";

    // ---------- POST /2/oauth2/token (token exchange + refresh) ----------
    if (url.pathname === "/2/oauth2/token" && req.method === "POST") {
      if (!auth.startsWith("Basic ")) return json(401, { error: "invalid_client", error_description: "Missing Basic auth." });
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        const params = Object.fromEntries(new URLSearchParams(body));
        state.tokenCalls.push(params);

        if (params.grant_type === "authorization_code") {
          if (params.code !== "good-code") return json(400, { error: "invalid_grant", error_description: "The code passed is incorrect or expired." });
          if (!params.code_verifier) return json(400, { error: "invalid_request", error_description: "code_verifier is required." });
          const n = ++state.accessCounter;
          const token = `xat_access${n}`;
          const refresh = `xrt_refresh${n}`;
          state.liveTokens.add(token);
          state.refreshTokens.set(refresh, true);
          return json(200, {
            access_token: token,
            token_type: "bearer",
            expires_in: 7200,
            scope: cfg.grantScopes,
            refresh_token: refresh,
          });
        }

        if (params.grant_type === "refresh_token") {
          if (!state.refreshTokens.has(params.refresh_token)) {
            return json(400, { error: "invalid_grant", error_description: "The refresh token is invalid or expired." });
          }
          state.refreshTokens.delete(params.refresh_token);
          const n = ++state.accessCounter;
          const token = `xat_access${n}`;
          const refresh = `xrt_refresh${++state.refreshCounter}`;
          state.liveTokens.add(token);
          state.refreshTokens.set(refresh, true);
          return json(200, {
            access_token: token,
            token_type: "bearer",
            expires_in: 7200,
            scope: cfg.grantScopes,
            refresh_token: refresh,
          });
        }

        return json(400, { error: "unsupported_grant_type", error_description: `Unknown grant_type: ${params.grant_type}` });
      });
      return;
    }

    // ---------- API routes (Bearer auth) ----------
    state.authHeaders.push({ path: url.pathname, auth });
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!bearer) return err(401, "Requires authentication");
    if (!state.liveTokens.has(bearer)) return err(401, "Bad credentials");

    // GET /2/users/me
    if (url.pathname === "/2/users/me" && req.method === "GET") {
      return json(200, { data: USER });
    }

    // GET /2/users/:id/mentions
    const mentionsMatch = /^\/2\/users\/([^/]+)\/mentions$/.exec(url.pathname);
    if (mentionsMatch && req.method === "GET") {
      const limit = Number(url.searchParams.get("max_results") ?? 10);
      const items = MENTIONS.slice(0, limit);
      return json(200, { data: items, meta: { result_count: items.length } });
    }

    // GET /2/users/:id/tweets
    const tweetsMatch = /^\/2\/users\/([^/]+)\/tweets$/.exec(url.pathname);
    if (tweetsMatch && req.method === "GET") {
      const limit = Number(url.searchParams.get("max_results") ?? 10);
      const items = TWEETS.slice(0, limit);
      return json(200, { data: items, meta: { result_count: items.length } });
    }

    // GET /2/tweets/search/recent
    if (url.pathname === "/2/tweets/search/recent" && req.method === "GET") {
      const q = url.searchParams.get("query") ?? "";
      const limit = Number(url.searchParams.get("max_results") ?? 10);
      const items = [...TWEETS, ...MENTIONS].filter(t => t.text.toLowerCase().includes(q.toLowerCase())).slice(0, limit);
      return json(200, { data: items, meta: { result_count: items.length } });
    }

    // POST /2/tweets
    if (url.pathname === "/2/tweets" && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        if (!parsed.text) return err(422, "text is required");
        const id = `t${5000 + state.tweetsPosted.length}`;
        state.tweetsPosted.push({ id, ...parsed });
        return json(201, { data: { id, text: parsed.text } });
      });
      return;
    }

    // DELETE /2/tweets/:id
    const deleteMatch = /^\/2\/tweets\/([^/]+)$/.exec(url.pathname);
    if (deleteMatch && req.method === "DELETE") {
      state.tweetsDeleted.push(deleteMatch[1]);
      return json(200, { data: { deleted: true } });
    }

    // POST /2/users/:id/retweets
    const retweetMatch = /^\/2\/users\/([^/]+)\/retweets$/.exec(url.pathname);
    if (retweetMatch && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        state.retweets.push({ user_id: retweetMatch[1], tweet_id: parsed.tweet_id });
        return json(200, { data: { retweeted: true } });
      });
      return;
    }

    // POST /2/users/:id/likes
    const likeMatch = /^\/2\/users\/([^/]+)\/likes$/.exec(url.pathname);
    if (likeMatch && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        state.likes.push({ user_id: likeMatch[1], tweet_id: parsed.tweet_id });
        return json(200, { data: { liked: true } });
      });
      return;
    }

    // DELETE /2/users/:id/likes/:tweet_id
    const unlikeMatch = /^\/2\/users\/([^/]+)\/likes\/([^/]+)$/.exec(url.pathname);
    if (unlikeMatch && req.method === "DELETE") {
      state.unlikes.push({ user_id: unlikeMatch[1], tweet_id: unlikeMatch[2] });
      return json(200, { data: { liked: false } });
    }

    // GET /2/users/:id/bookmarks
    const bookmarksListMatch = /^\/2\/users\/([^/]+)\/bookmarks$/.exec(url.pathname);
    if (bookmarksListMatch && req.method === "GET") {
      const limit = Number(url.searchParams.get("max_results") ?? 10);
      const items = BOOKMARKS.slice(0, limit);
      return json(200, { data: items, meta: { result_count: items.length } });
    }

    // POST /2/users/:id/bookmarks
    if (bookmarksListMatch && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        state.bookmarksAdded.push({ user_id: bookmarksListMatch[1], tweet_id: parsed.tweet_id });
        return json(200, { data: { bookmarked: true } });
      });
      return;
    }

    // DELETE /2/users/:id/bookmarks/:tweet_id
    const bookmarkRemoveMatch = /^\/2\/users\/([^/]+)\/bookmarks\/([^/]+)$/.exec(url.pathname);
    if (bookmarkRemoveMatch && req.method === "DELETE") {
      state.bookmarksRemoved.push({ user_id: bookmarkRemoveMatch[1], tweet_id: bookmarkRemoveMatch[2] });
      return json(200, { data: { bookmarked: false } });
    }

    // GET /2/dm_events
    if (url.pathname === "/2/dm_events" && req.method === "GET") {
      const limit = Number(url.searchParams.get("max_results") ?? 10);
      const items = DM_EVENTS.slice(0, limit);
      return json(200, { data: items, meta: { result_count: items.length } });
    }

    // POST /2/dm_conversations/with/:id/messages
    const dmSendMatch = /^\/2\/dm_conversations\/with\/([^/]+)\/messages$/.exec(url.pathname);
    if (dmSendMatch && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        if (!parsed.text) return err(422, "text is required");
        const id = `dm${2000 + state.dmsSent.length}`;
        state.dmsSent.push({ id, participant_id: dmSendMatch[1], ...parsed });
        return json(201, { data: { dm_event_id: id, dm_conversation_id: `dmconv_${dmSendMatch[1]}` } });
      });
      return;
    }

    return err(404, `No such route: ${req.method} ${url.pathname}`);
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    set(patch) { Object.assign(cfg, patch); },
    close: () => new Promise(r => server.close(r)),
  };
}
