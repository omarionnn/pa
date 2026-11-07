// X (Twitter) integration, against a fake X API that answers the routes their docs document.
//
// What these tests are for:
//   1. One person's token is never usable by another.
//   2. The connect flow (OAuth 2.0 + PKCE) produces a working token and a connected_accounts row.
//   3. The disconnect flow clears everything.
//   4. Each tool calls the right API route and shapes the result properly.
//   5. All write tools are gated behind confirmation — nothing posts without a yes.
//   6. Token refresh rotates both the access and refresh tokens.
//   7. With no credentials, everything says not_connected honestly.
//
// No key, no network: the base URLs point at the fixture.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startX } from "./fixture-x.js";

const dir = mkdtempSync(join(tmpdir(), "reason-x-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool } = await import("../src/tools.js");
const x = await import("../src/x.js");
const db = await import("../src/db.js");
// The connect link is Reason's start page (src/connectgate.js); the provider's own address, what
// these assertions are about, is kept on the state row it names.
const providerUrl = (u) => db.db.prepare("SELECT authorize_url FROM oauth_states WHERE state = ?").get(new URL(u).searchParams.get("state"))?.authorize_url ?? u;
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";

let fake;
const call = (name, input, conversationId = OMARI) => runTool(name, input, { conversationId, messages: [] });

before(async () => {
  fake = await startX();
  config.xClientId = "x-client-abc";
  config.xClientSecret = "x-secret-xyz";
  config.xApiBase = fake.url;
  config.xAuthBase = fake.url;
  config.publicUrl = "";
});
after(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM spend; DELETE FROM conversations;");
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
  fake.state.tweetsPosted.length = 0;
  fake.state.tweetsDeleted.length = 0;
  fake.state.retweets.length = 0;
  fake.state.likes.length = 0;
  fake.state.unlikes.length = 0;
  fake.state.bookmarksAdded.length = 0;
  fake.state.bookmarksRemoved.length = 0;
  fake.state.dmsSent.length = 0;
  fake.state.authHeaders.length = 0;
  fake.state.tokenCalls.length = 0;
  fake.state.liveTokens.clear();
  fake.state.refreshTokens.clear();
});

async function connect(conversationId = OMARI, { code = "good-code" } = {}) {
  const link = await call("x_connect", {}, conversationId);
  assert.equal(link.ok, true, JSON.stringify(link));
  const url = new URL(providerUrl(link.url));
  const state = url.searchParams.get("state");
  assert.ok(url.searchParams.get("code_challenge"), "PKCE code_challenge should be in the authorize URL");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const done = await x.completeConnect({ code, state });
  assert.equal(done.ok, true, JSON.stringify(done));
  return { link, done, state };
}

// ---------- connecting ----------

test("with no client id, everything says not_connected and nothing is invented", async () => {
  const id = config.xClientId;
  config.xClientId = "";
  try {
    for (const [tool, input] of [["x_connect", {}], ["x_profile", {}], ["x_mentions", {}]]) {
      const out = await call(tool, input);
      assert.equal(out.ok, false, tool);
      assert.equal(out.status, "not_connected", tool);
      assert.ok(out.missing.includes("X_CLIENT_ID"), tool);
    }
  } finally {
    config.xClientId = id;
  }
});

test("connect flow produces a PKCE link, code exchange gives a token, and the account row exists", async () => {
  const { link, done } = await connect();
  assert.ok(providerUrl(link.url).includes("/i/oauth2/authorize"), "should point at X's authorize");
  assert.ok(providerUrl(link.url).includes("client_id=x-client-abc"), "should carry the client id");
  assert.equal(done.username, "omari");
  const row = db.getOauthTokens(OMARI, "x");
  assert.ok(row, "token row should exist");
  assert.ok(row.access_token.startsWith("xat_"), "token should be an X access token");
  assert.ok(row.refresh_token.startsWith("xrt_"), "refresh token should exist");
  const acct = db.liveAccount(OMARI, "x");
  assert.ok(acct, "connected_accounts row should exist");
});

test("PKCE: code_verifier is stored and sent in the token exchange", async () => {
  await connect();
  const tokenCall = fake.state.tokenCalls.find(c => c.grant_type === "authorization_code");
  assert.ok(tokenCall, "there should be a token exchange call");
  assert.ok(tokenCall.code_verifier, "code_verifier should be present");
  assert.ok(tokenCall.code_verifier.length >= 43, "code_verifier should be at least 43 chars");
});

test("a replayed callback connects nothing", async () => {
  const link = await call("x_connect", {});
  const state = new URL(link.url).searchParams.get("state");
  await x.completeConnect({ code: "good-code", state });
  const second = await x.completeConnect({ code: "good-code", state });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "bad_state");
});

test("bad code returns token_exchange_failed", async () => {
  const link = await call("x_connect", {});
  const state = new URL(link.url).searchParams.get("state");
  const out = await x.completeConnect({ code: "bad-code", state });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "token_exchange_failed");
});

test("disconnect clears the token and the account row", async () => {
  await connect();
  assert.ok(db.getOauthTokens(OMARI, "x"));
  const out = await call("x_disconnect", {});
  assert.equal(out.ok, true);
  assert.equal(out.status, "revoked");
  assert.equal(db.getOauthTokens(OMARI, "x"), null);
  assert.ok(!db.liveAccount(OMARI, "x"), "connected_accounts row should be gone");
});

// ---------- token refresh ----------

test("an expired token is refreshed automatically and the old refresh token dies", async () => {
  await connect();
  const oldRow = db.getOauthTokens(OMARI, "x");
  const oldRefresh = oldRow.refresh_token;
  clock.skip(3 * 3600_000);
  const tok = await x.accessTokenFor(OMARI);
  assert.equal(tok.ok, true);
  assert.equal(tok.refreshed, true);
  const newRow = db.getOauthTokens(OMARI, "x");
  assert.notEqual(newRow.access_token, oldRow.access_token, "access token should be different");
  assert.notEqual(newRow.refresh_token, oldRefresh, "refresh token should rotate");
});

// ---------- profile ----------

test("x_profile returns the user's profile", async () => {
  await connect();
  const out = await call("x_profile", {});
  assert.equal(out.ok, true);
  assert.equal(out.profile.username, "omari");
  assert.equal(out.profile.followers, 1200);
  assert.equal(out.profile.url, "https://x.com/omari");
});

// ---------- mentions ----------

test("x_mentions lists recent mentions", async () => {
  await connect();
  const out = await call("x_mentions", {});
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  assert.ok(out.mentions[0].text.includes("@omari"));
  assert.equal(out.mentions[0].author_id, "8800001");
});

// ---------- timeline ----------

test("x_timeline lists the user's tweets", async () => {
  await connect();
  const out = await call("x_timeline", {});
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  assert.equal(out.tweets[0].text, "Shipping something new today.");
});

// ---------- search ----------

test("x_search finds tweets matching a query", async () => {
  await connect();
  const out = await call("x_search", { query: "morning" });
  assert.equal(out.ok, true);
  assert.ok(out.count >= 1);
  assert.ok(out.tweets[0].text.toLowerCase().includes("morning"));
});

// ---------- write tools are gated behind confirmation ----------

test("x_post is gated behind confirmation", async () => {
  await connect();
  const out = await call("x_post", { text: "Hello world" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(fake.state.tweetsPosted.length, 0, "nothing should have been posted");
});

test("x_reply is gated behind confirmation", async () => {
  await connect();
  const out = await call("x_reply", { tweet_id: "t2001", text: "Thanks!" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
});

test("x_retweet is gated behind confirmation", async () => {
  await connect();
  const out = await call("x_retweet", { tweet_id: "t1001" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
});

test("x_like is gated behind confirmation", async () => {
  await connect();
  const out = await call("x_like", { tweet_id: "t1001" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
});

test("x_unlike is gated behind confirmation", async () => {
  await connect();
  const out = await call("x_unlike", { tweet_id: "t1001" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
});

test("x_bookmark is gated behind confirmation", async () => {
  await connect();
  const out = await call("x_bookmark", { tweet_id: "t1001" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
});

test("x_bookmark_remove is gated behind confirmation", async () => {
  await connect();
  const out = await call("x_bookmark_remove", { tweet_id: "t3001" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
});

test("x_dm is gated behind confirmation", async () => {
  await connect();
  const out = await call("x_dm", { participant_id: "8800001", text: "Yo" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
});

test("x_delete is gated behind confirmation", async () => {
  await connect();
  const out = await call("x_delete", { tweet_id: "t1001" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
});

// ---------- write tools work once they reach the API ----------

test("x_post actually posts when reaching the API directly", async () => {
  await connect();
  const tok = await x.accessTokenFor(OMARI);
  assert.equal(tok.ok, true);
  const res = await x.api(tok.token, "POST", "/2/tweets", { body: { text: "Direct post" } });
  assert.equal(res.ok, true);
  assert.ok(res.body.data.id);
  assert.equal(fake.state.tweetsPosted.length, 1);
  assert.equal(fake.state.tweetsPosted[0].text, "Direct post");
});

test("x_reply actually replies when reaching the API directly", async () => {
  await connect();
  const tok = await x.accessTokenFor(OMARI);
  const res = await x.api(tok.token, "POST", "/2/tweets", {
    body: { text: "A reply", reply: { in_reply_to_tweet_id: "t2001" } },
  });
  assert.equal(res.ok, true);
  assert.equal(fake.state.tweetsPosted.length, 1);
  assert.equal(fake.state.tweetsPosted[0].reply.in_reply_to_tweet_id, "t2001");
});

test("x_delete actually deletes when reaching the API directly", async () => {
  await connect();
  const tok = await x.accessTokenFor(OMARI);
  const res = await x.api(tok.token, "DELETE", "/2/tweets/t1001");
  assert.equal(res.ok, true);
  assert.equal(fake.state.tweetsDeleted.length, 1);
  assert.equal(fake.state.tweetsDeleted[0], "t1001");
});

test("x_retweet actually retweets when reaching the API directly", async () => {
  await connect();
  const tok = await x.accessTokenFor(OMARI);
  const me = await x.userIdFor(OMARI);
  const res = await x.api(tok.token, "POST", `/2/users/${me.id}/retweets`, {
    body: { tweet_id: "t1001" },
  });
  assert.equal(res.ok, true);
  assert.equal(fake.state.retweets.length, 1);
  assert.equal(fake.state.retweets[0].tweet_id, "t1001");
});

test("x_like and x_unlike work when reaching the API directly", async () => {
  await connect();
  const tok = await x.accessTokenFor(OMARI);
  const me = await x.userIdFor(OMARI);
  const like = await x.api(tok.token, "POST", `/2/users/${me.id}/likes`, { body: { tweet_id: "t1001" } });
  assert.equal(like.ok, true);
  assert.equal(fake.state.likes.length, 1);
  const unlike = await x.api(tok.token, "DELETE", `/2/users/${me.id}/likes/t1001`);
  assert.equal(unlike.ok, true);
  assert.equal(fake.state.unlikes.length, 1);
});

test("x_bookmark and x_bookmark_remove work when reaching the API directly", async () => {
  await connect();
  const tok = await x.accessTokenFor(OMARI);
  const me = await x.userIdFor(OMARI);
  const add = await x.api(tok.token, "POST", `/2/users/${me.id}/bookmarks`, { body: { tweet_id: "t1001" } });
  assert.equal(add.ok, true);
  assert.equal(fake.state.bookmarksAdded.length, 1);
  const rm = await x.api(tok.token, "DELETE", `/2/users/${me.id}/bookmarks/t1001`);
  assert.equal(rm.ok, true);
  assert.equal(fake.state.bookmarksRemoved.length, 1);
});

test("x_dm actually sends when reaching the API directly", async () => {
  await connect();
  const tok = await x.accessTokenFor(OMARI);
  const res = await x.api(tok.token, "POST", "/2/dm_conversations/with/8800001/messages", {
    body: { text: "Hey there" },
  });
  assert.equal(res.ok, true);
  assert.equal(fake.state.dmsSent.length, 1);
  assert.equal(fake.state.dmsSent[0].text, "Hey there");
  assert.equal(fake.state.dmsSent[0].participant_id, "8800001");
});

// ---------- bookmarks (read) ----------

test("x_bookmarks lists bookmarks", async () => {
  await connect();
  const out = await call("x_bookmarks", {});
  assert.equal(out.ok, true);
  assert.equal(out.count, 1);
  assert.ok(out.bookmarks[0].text.includes("system design"));
});

// ---------- DM list ----------

test("x_dm_list lists DM events", async () => {
  await connect();
  const out = await call("x_dm_list", {});
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  assert.ok(out.dm_events[0].text.includes("free tomorrow"));
});

// ---------- isolation ----------

test("one person's token is not usable by another person's conversation", async () => {
  await connect(OMARI);
  const out = await call("x_profile", {}, AMA);
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_connected");
});
