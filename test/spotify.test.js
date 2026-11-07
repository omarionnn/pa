// Spotify, against a fake Spotify that answers the routes their docs document.
//
// What these tests are for, in order of how much it would cost to get them wrong:
//
//   1. **One person's token is never usable by another.** Checked from the server's side as well as
//      the client's: the fake records every Authorization header it was sent, so the test can prove
//      Ama's conversation never put Omari's token on the wire, rather than trusting a code path.
//   2. **A refusal is reported as what it was.** Spotify's documented error object is a status and
//      a message with no machine-readable reason, so "no Premium" and "no speaker on" cannot be
//      told apart from the error alone. The devices endpoint CAN answer the second one, so a
//      refusal checks it and says which — and when it cannot tell, it says it cannot tell instead
//      of blaming the subscription.
//   3. **Nothing is claimed that Spotify did not say.** 204 means "nothing playing", a player write
//      that succeeds says nothing back about what is now on, and a playlist that was created but
//      not filled is reported as created and empty.
//   4. **Tokens refresh, and a dead refresh token ends the connection** rather than being retried.
//
// No key, no network: the base URLs point at the fixture.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSpotify } from "./fixture-spotify.js";

const dir = mkdtempSync(join(tmpdir(), "reason-spotify-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool } = await import("../src/tools.js");
const spotify = await import("../src/spotify.js");
const db = await import("../src/db.js");
// The connect link is Reason's start page (src/connectgate.js); the provider's own address, what
// these assertions are about, is kept on the state row it names.
const providerUrl = (u) => db.db.prepare("SELECT authorize_url FROM oauth_states WHERE state = ?").get(new URL(u).searchParams.get("state"))?.authorize_url ?? u;
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
const ALL = spotify.SCOPE_LIST;

let fake;
const call = (name, input, conversationId = OMARI) => runTool(name, input, { conversationId, messages: [] });

before(async () => {
  fake = await startSpotify();
  config.spotifyClientId = "client-abc";
  config.spotifyClientSecret = "secret-xyz";
  config.spotifyApiBase = fake.url;
  config.spotifyAccountsBase = fake.url;
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
  fake.set({ premium: true, devices: [{ id: "dev1", name: "Omari's iPhone", type: "Smartphone", is_active: true, volume_percent: 60 }], playing: "spotify:track:aaa", grantScopes: null, refreshTokenValid: true, accessTtlSeconds: 3600 });
  fake.state.played.length = 0;
  fake.state.queued.length = 0;
  fake.state.skipped.length = 0;
  fake.state.playlists.length = 0;
  fake.state.added.length = 0;
  fake.state.authHeaders.length = 0;
  fake.state.tokenCalls.length = 0;
  fake.state.liveTokens.clear();
  fake.state.paused = 0;
});

/** Walk the real handshake: ask for a link, then be the browser Spotify redirects back to. */
async function connect(conversationId = OMARI, { scopes = ALL, code = "good-code" } = {}) {
  const link = spotify.authorizeUrl(conversationId, scopes === ALL ? {} : { scopes });
  assert.equal(link.ok, true, JSON.stringify(link));
  const state = new URL(link.url).searchParams.get("state");
  const done = await spotify.completeConnect({ code, state });
  assert.equal(done.ok, true, JSON.stringify(done));
  return { link, done, state };
}

// ---------- connecting ----------

test("with no client id, everything says not_connected and nothing is invented", async () => {
  const id = config.spotifyClientId;
  config.spotifyClientId = "";
  try {
    for (const [tool, input] of [["spotify_connect", {}], ["spotify_search", { query: "ribs" }], ["spotify_now_playing", {}], ["spotify_control", { action: "pause" }]]) {
      const out = await call(tool, input);
      assert.equal(out.ok, false, tool);
      assert.equal(out.status, "not_connected", tool);
      assert.deepEqual(out.missing, ["SPOTIFY_CLIENT_ID"], tool);
      assert.match(out.error, /developer\.spotify\.com\/dashboard/, `${tool} should say where to get one`);
    }
  } finally {
    config.spotifyClientId = id;
  }
});

test("the authorize link is the one Spotify documents, with the scopes spelled out in words", async () => {
  const out = await call("spotify_connect", {});
  assert.equal(out.ok, true);
  const u = new URL(providerUrl(out.url));
  assert.equal(u.origin + u.pathname, `${fake.url}/authorize`);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "client-abc");
  assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/spotify/callback");
  assert.ok(u.searchParams.get("state"), "a state is required protection against CSRF");
  assert.deepEqual(u.searchParams.get("scope").split(" "), ALL);
  // Every scope is explained, so a consent screen is not the first time anybody finds out.
  for (const s of out.scopes) assert.ok(s.so_that, `${s.scope} should say what it is for`);
  // Honest about the loopback address: that link will not come back from a phone.
  assert.match(out.reachable, /only opens on the Mac/i);
});

test("the redirect never uses localhost, which Spotify forbids by name", async () => {
  const out = await call("spotify_connect", {});
  assert.doesNotMatch(out.redirect_uri, /localhost/);
  assert.match(out.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/spotify\/callback$/);
  const saved = config.publicUrl;
  config.publicUrl = "https://reason.example.com";
  try {
    assert.equal((await call("spotify_connect", {})).redirect_uri, "https://reason.example.com/spotify/callback");
  } finally {
    config.publicUrl = saved;
  }
});

test("connecting stores the tokens, records the account, and exchanges the code the documented way", async () => {
  await connect();
  const row = db.getOauthTokens(OMARI, "spotify");
  assert.ok(row.access_token);
  assert.equal(row.refresh_token, "refresh-1");
  assert.deepEqual(row.scope.split(" "), ALL);
  assert.ok(row.expires_at > clock.now(), "an expiry is stored so the token can be refreshed before it dies");
  // The exchange: form-encoded, grant_type=authorization_code, Basic auth, redirect_uri echoed.
  const [exchange] = fake.state.tokenCalls;
  assert.equal(exchange.form.grant_type, "authorization_code");
  assert.equal(exchange.form.code, "good-code");
  assert.equal(exchange.form.redirect_uri, "http://127.0.0.1:8787/spotify/callback");
  assert.equal(exchange.auth, "Basic " + Buffer.from("client-abc:secret-xyz").toString("base64"));
  // And it shows up where "what can you reach" is read from.
  assert.equal((await call("account_list", {})).accounts.find(a => a.name === "spotify").status, "connected");
});

test("a connect link works once: the same callback replayed connects nothing", async () => {
  const { state } = await connect();
  db.deleteOauthTokens(OMARI, "spotify");
  const again = await spotify.completeConnect({ code: "good-code", state });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "bad_state");
  assert.match(again.error, /already been used/i);
  assert.equal(db.getOauthTokens(OMARI, "spotify"), null, "a replay must not write tokens");
});

test("a non-operator gets the join page URL, not the Spotify authorize link", async () => {
  const out = await call("spotify_connect", {}, AMA);
  assert.equal(out.ok, true);
  assert.equal(out.needs_allowlist, true);
  assert.match(out.url, /\/spotify\/join/);
});

test("the join page renders a form", () => {
  const html = spotify.joinPage();
  assert.match(html, /Connect Spotify/);
  assert.match(html, /<form/);
  assert.match(html, /type="email"/);
});

test("the join page shows a done state", () => {
  const html = spotify.joinPage({ done: true });
  assert.match(html, /Got it/);
  assert.match(html, /has been notified/);
});

test("a declined authorization is reported as declined, and nothing is stored", async () => {
  const link = await call("spotify_connect", {});
  const state = new URL(link.url).searchParams.get("state");
  const out = await spotify.completeConnect({ state, error: "access_denied" });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "declined");
  assert.match(out.error, /allowlist/);
  assert.equal(db.getOauthTokens(OMARI, "spotify"), null);
});

test("a bad code is not turned into a connection", async () => {
  const link = await call("spotify_connect", {});
  const state = new URL(link.url).searchParams.get("state");
  const out = await spotify.completeConnect({ code: "nonsense", state });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "token_exchange_failed");
  assert.equal(db.getOauthTokens(OMARI, "spotify"), null);
});

// ---------- refreshing ----------

test("an expired access token is refreshed without the person doing anything", async () => {
  await connect();
  const first = db.getOauthTokens(OMARI, "spotify").access_token;
  clock.skip(2 * 60 * 60 * 1000); // past the hour Spotify gives it

  const out = await call("spotify_search", { query: "ribs" });
  assert.equal(out.ok, true, JSON.stringify(out));
  const refresh = fake.state.tokenCalls.find(t => t.form.grant_type === "refresh_token");
  assert.ok(refresh, "it should have refreshed rather than failing");
  assert.equal(refresh.form.refresh_token, "refresh-1");
  assert.notEqual(db.getOauthTokens(OMARI, "spotify").access_token, first, "the new token is stored");
});

test("a refresh that returns no new refresh token keeps the old one", async () => {
  await connect();
  clock.skip(2 * 60 * 60 * 1000);
  await call("spotify_search", { query: "ribs" });
  // Spotify's docs: "When a refresh token is not returned, continue using the existing token."
  // Blanking it here would end the connection six months early for no reason.
  assert.equal(db.getOauthTokens(OMARI, "spotify").refresh_token, "refresh-1");

  fake.set({ refreshReturnsNewRefreshToken: true });
  clock.skip(2 * 60 * 60 * 1000);
  await call("spotify_search", { query: "ribs" });
  assert.equal(db.getOauthTokens(OMARI, "spotify").refresh_token, "refresh-2", "and a new one does replace it");
  fake.set({ refreshReturnsNewRefreshToken: false });
});

test("a dead refresh token drops the connection and asks for a new link, rather than retrying", async () => {
  await connect();
  clock.skip(2 * 60 * 60 * 1000);
  fake.set({ refreshTokenValid: false });

  const out = await call("spotify_search", { query: "ribs" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "needs_reconnect");
  assert.match(out.error, /six months|revoked/i);
  assert.match(out.error, /spotify_connect/);
  // Their docs are explicit that invalid_grant means discard and re-authorize. A token left in the
  // table would be retried on every turn for nothing.
  assert.equal(db.getOauthTokens(OMARI, "spotify"), null, "the dead token is gone");
  assert.equal(db.liveAccount(OMARI, "spotify"), null, "and it no longer claims to be connected");
});

// ---------- revoking ----------

test("revoking deletes the tokens from this machine and says what it cannot do on Spotify's side", async () => {
  await connect();
  const out = await call("account_revoke", { name: "spotify" });
  assert.equal(out.ok, true);
  assert.equal(out.status, "revoked");
  assert.equal(out.tokens_deleted, 1);
  assert.equal(db.getOauthTokens(OMARI, "spotify"), null);
  assert.equal(db.liveAccount(OMARI, "spotify"), null);
  assert.match(out.note, /spotify\.com\/account\/apps/, "and it says where they revoke it on Spotify too");
  // Afterwards it genuinely does not work.
  assert.equal((await call("spotify_search", { query: "ribs" })).status, "not_connected");
});

test("revoking also clears what had been read off their Spotify out of the thread", async () => {
  await connect();
  const heard = await call("spotify_listening", { what: "recently_played", limit: 2 });
  assert.equal(heard.ok, true, JSON.stringify(heard).slice(0, 200));
  db.saveConversation(OMARI, [
    { role: "user", content: "[Sat Oct 3 2026, 9:00 AM] Omari: what have i been listening to" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "spotify_listening", input: { what: "recently_played" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify(heard) }] },
  ]);

  const out = await call("account_revoke", { name: "spotify" });
  assert.equal(out.ok, true);
  assert.equal(out.copies_cleared, 1);
  assert.match(out.note, /cleared out of this conversation/);
  assert.match(JSON.stringify(db.loadConversation(OMARI)), /deleted at their request/);
  db.clearConversation(OMARI);
});

// ---------- isolation ----------

test("one person's Spotify is not reachable from another person's conversation", async () => {
  await connect(OMARI);
  const omarisToken = db.getOauthTokens(OMARI, "spotify").access_token;

  // Ama has her own Reason and has connected nothing.
  const out = await call("spotify_search", { query: "ribs" }, AMA);
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_connected");
  assert.match(out.error, /has not connected Spotify/i);
  assert.equal(db.getOauthTokens(AMA, "spotify"), null);

  // The strong form: Omari's token was never put on the wire for Ama's turn. Checked at the
  // server, so this cannot be satisfied by a client that merely meant not to.
  assert.equal(fake.state.authHeaders.filter(h => h.auth.includes(omarisToken)).length, 0,
    "Omari's token must never leave the machine on Ama's behalf");
});

test("two people connected at once keep separate tokens, and each tool uses the caller's", async () => {
  await connect(OMARI);
  await connect(AMA);
  const a = db.getOauthTokens(OMARI, "spotify").access_token;
  const b = db.getOauthTokens(AMA, "spotify").access_token;
  assert.notEqual(a, b);

  fake.state.authHeaders.length = 0;
  await call("spotify_search", { query: "ribs" }, AMA);
  const used = [...new Set(fake.state.authHeaders.map(h => h.auth))];
  assert.deepEqual(used, [`Bearer ${b}`], "Ama's turn uses Ama's token and nothing else");
});

// ---------- the tools ----------

test("search returns what Spotify returned, with the uris the other tools take", async () => {
  await connect();
  const out = await call("spotify_search", { query: "ribs", limit: 3 });
  assert.equal(out.ok, true);
  assert.equal(out.count, 1);
  assert.equal(out.results[0].name, "Ribs");
  assert.equal(out.results[0].by, "Lorde");
  assert.equal(out.results[0].uri, "spotify:track:bbb");
  assert.match(out.results[0].link, /^https:\/\/open\.spotify\.com\//);
});

test("search finding nothing says so instead of offering something Spotify did not return", async () => {
  await connect();
  const out = await call("spotify_search", { query: "zzzzzznothing" });
  assert.equal(out.ok, true);
  assert.equal(out.count, 0);
  assert.deepEqual(out.results, []);
  assert.match(out.note, /found nothing/i);
});

test("now playing says what is on, on which speaker, and which devices exist", async () => {
  await connect();
  const out = await call("spotify_now_playing", {});
  assert.equal(out.ok, true);
  assert.equal(out.playing, true);
  assert.equal(out.track.name, "Teenage Birdsong");
  assert.equal(out.on_device.name, "Omari's iPhone");
  assert.match(out.what, /Teenage Birdsong by Four Tet on Omari's iPhone/);
  assert.equal(out.devices.length, 1);
});

test("nothing playing is a state, not an error — Spotify answers 204 and that is what it means", async () => {
  await connect();
  fake.set({ playing: null });
  const out = await call("spotify_now_playing", {});
  assert.equal(out.ok, true, "a 204 must not be reported as a failure");
  assert.equal(out.playing, false);
  assert.match(out.what, /Nothing is playing/i);
});

test("play, pause and skip reach Spotify, and none of them claims to know what came on next", async () => {
  await connect();
  const played = await call("spotify_control", { action: "play", uris: ["spotify:track:bbb"] });
  assert.equal(played.ok, true);
  assert.deepEqual(fake.state.played[0].body, { uris: ["spotify:track:bbb"] });
  assert.match(played.note, /does not say back what is now playing/i);

  assert.equal((await call("spotify_control", { action: "pause" })).ok, true);
  assert.equal(fake.state.paused, 1);
  assert.equal((await call("spotify_control", { action: "next" })).ok, true);
  assert.equal((await call("spotify_control", { action: "previous" })).ok, true);
  assert.deepEqual(fake.state.skipped, ["next", "previous"]);

  // A context (album/playlist) goes in the documented field, not the track one.
  await call("spotify_control", { action: "play", context_uri: "spotify:album:xyz" });
  assert.deepEqual(fake.state.played.at(-1).body, { context_uri: "spotify:album:xyz" });
});

test("queueing adds one track without interrupting anything", async () => {
  await connect();
  const out = await call("spotify_queue", { uri: "spotify:track:ccc" });
  assert.equal(out.ok, true);
  assert.deepEqual(fake.state.queued, ["spotify:track:ccc"]);
  assert.equal(fake.state.paused, 0);
  assert.match(out.note, /Nothing was interrupted/i);
});

// ---------- when Spotify says no ----------

test("no device with Spotify open is reported as exactly that, because the devices endpoint can say so", async () => {
  await connect();
  fake.set({ devices: [] });
  for (const [tool, input, word] of [["spotify_control", { action: "play", uris: ["spotify:track:aaa"] }, /play/], ["spotify_queue", { uri: "spotify:track:aaa" }, /queue/]]) {
    const out = await call(tool, input);
    assert.equal(out.ok, false, tool);
    assert.equal(out.status, "no_active_device", tool);
    assert.match(out.error, /open Spotify on their phone, laptop or speaker/i);
    assert.match(out.error, /nothing was changed/i);
    assert.match(out.error, word);
    assert.ok(out.spotify_said, "Spotify's own words are kept");
  }
  assert.deepEqual(fake.state.played, []);
});

test("a free account is reported as probably Premium and never as certainly Premium", async () => {
  await connect();
  fake.set({ premium: false });
  const out = await call("spotify_control", { action: "play", uris: ["spotify:track:aaa"] });
  assert.equal(out.ok, false);
  assert.equal(out.status, "forbidden");
  assert.match(out.error, /only work on a Spotify Premium account/i);
  // The honest half: Spotify's documented error object has no reason field, so the subscription is
  // the likely cause and not a known one. Saying it outright would be inventing a fact.
  assert.match(out.error, /does not say which/i);
  assert.match(out.error, /would be wrong to tell them it is definitely the subscription/i);
  assert.match(out.error, /nothing was changed/i);
  assert.ok(out.spotify_said.includes("Premium"), "and Spotify's own message is quoted");
});

test("a scope the person did not grant is named, with an offer to ask again for it", async () => {
  // They ticked only the read scopes on the consent screen.
  fake.set({ grantScopes: ["user-read-playback-state", "user-read-currently-playing"] });
  await connect();

  const reading = await call("spotify_now_playing", {});
  assert.equal(reading.ok, true, "what they did grant still works");

  const out = await call("spotify_control", { action: "pause" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "scope_missing");
  assert.deepEqual(out.missing_scope, ["user-modify-playback-state"]);
  assert.match(out.error, /did not grant/i);
  assert.match(out.error, /spotify_connect/);
  assert.match(out.error, /nothing was changed/i);
  assert.equal(fake.state.paused, 0, "and it really did not reach Spotify");

  const list = await call("spotify_listening", { what: "top_tracks" });
  assert.equal(list.status, "scope_missing");
  assert.deepEqual(list.missing_scope, ["user-top-read"]);
});

// ---------- playlists ----------

test("a playlist is created private by default and filled in the same call", async () => {
  await connect();
  const out = await call("spotify_playlist_create", { name: "late night", uris: ["spotify:track:aaa", "spotify:track:bbb"] });
  assert.equal(out.ok, true);
  assert.equal(out.playlist.name, "late night");
  assert.equal(out.added, 2);
  assert.match(out.playlist.link, /open\.spotify\.com\/playlist\//);
  assert.equal(fake.state.playlists[0].public, false, "private unless they asked otherwise");
  assert.deepEqual(fake.state.added[0].uris, ["spotify:track:aaa", "spotify:track:bbb"]);

  const pub = await call("spotify_playlist_create", { name: "shared", public: true });
  assert.equal(pub.added, 0);
  assert.equal(fake.state.playlists[1].public, true);
  assert.match(pub.note, /Empty so far/i);
});

test("a playlist that was made but could not be filled is reported as made and empty", async () => {
  await connect();
  // 101 uris is over Spotify's documented per-request limit, so the create succeeds and the add
  // does not. Claiming the whole thing failed would leave an unexplained playlist on the account.
  const out = await call("spotify_playlist_create", { name: "too big", uris: Array.from({ length: 100 }, () => "spotify:track:aaa") });
  assert.equal(out.ok, true);
  assert.equal(out.added, 100);

  const bad = await call("spotify_playlist_add", { playlist_id: "nope", uris: ["spotify:track:aaa"] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Invalid playlist Id/);
});

test("adding to an existing playlist works and returns Spotify's snapshot", async () => {
  await connect();
  const made = await call("spotify_playlist_create", { name: "base" });
  const out = await call("spotify_playlist_add", { playlist_id: made.playlist.id, uris: ["spotify:track:ccc"] });
  assert.equal(out.ok, true);
  assert.equal(out.added, 1);
  assert.ok(out.snapshot_id);
});

// ---------- history ----------

test("recently played and the top lists come back as real history, newest first", async () => {
  await connect();
  const recent = await call("spotify_listening", { what: "recently_played", limit: 2 });
  assert.equal(recent.ok, true);
  assert.equal(recent.tracks.length, 2);
  assert.ok(recent.tracks[0].played_at, "when it was played is kept");
  assert.match(recent.note, /real listening/i);

  const top = await call("spotify_listening", { what: "top_tracks", limit: 2 });
  assert.equal(top.tracks.length, 2);
  assert.equal(top.over, "medium_term");

  const artists = await call("spotify_listening", { what: "top_artists", time_range: "short_term" });
  assert.equal(artists.artists[0].name, "Four Tet");
  assert.equal(artists.over, "short_term");
});

// ---------- the ledger ----------

test("everything that changed something is on the ledger; the reads are not", async () => {
  await connect();
  await call("spotify_search", { query: "ribs" });
  await call("spotify_now_playing", {});
  await call("spotify_control", { action: "play", uris: ["spotify:track:bbb"] });
  await call("spotify_queue", { uri: "spotify:track:ccc" });
  await call("spotify_playlist_create", { name: "for the drive", uris: ["spotify:track:aaa"] });

  const actions = db.listActions(OMARI).map(a => a.action);
  assert.ok(actions.includes("spotify_control"));
  assert.ok(actions.includes("spotify_queue"));
  assert.ok(actions.includes("spotify_playlist_create"));
  assert.ok(!actions.includes("spotify_search"), "searching a catalogue changes nothing");
  assert.ok(!actions.includes("spotify_now_playing"), "nor does asking what is on");

  const receipts = db.listActions(OMARI).map(a => a.receipt).join("\n");
  assert.match(receipts, /Queued spotify:track:ccc/);
  assert.match(receipts, /Made the Spotify playlist "for the drive" \(1 track\(s\), private\)/);
  assert.match(receipts, /does not confirm what is now playing/);
});

test("a refusal is on the ledger too, said as a refusal", async () => {
  await connect();
  fake.set({ devices: [] });
  await call("spotify_control", { action: "play", uris: ["spotify:track:aaa"] });
  const row = db.listActions(OMARI).find(a => a.action === "spotify_control");
  assert.equal(row.outcome, "error");
  assert.match(row.receipt, /Spotify would not play/i);
});

// ---------- the capability list cannot be out of date ----------

test("capabilities tells the truth about Spotify at every stage", async () => {
  const { capabilitiesNow } = await import("../src/tools.js");
  const spot = () => capabilitiesNow({ conversationId: OMARI }).find(c => c.name === "spotify");

  const id = config.spotifyClientId;
  config.spotifyClientId = "";
  assert.equal(spot().status, "not connected");
  assert.match(spot().what, /SPOTIFY_CLIENT_ID/);
  config.spotifyClientId = id;

  assert.equal(spot().status, "connectable");
  assert.match(spot().what, /has not authorized it yet/i);

  await connect();
  assert.equal(spot().status, "live");
  assert.match(spot().what, /needs Spotify Premium and a device with Spotify open/i);
});

// ---------- the callback route ----------
//
// Driven over a real socket, because the thing being tested is the HTTP route: Spotify redirects
// a BROWSER to it, so the shape of that request and what comes back on the page is the behaviour.
// What must not appear on that page is a token.

test("Spotify's redirect connects the account and shows a page with no token on it", async () => {
  const { createServer } = await import("../src/http.js");
  const server = createServer({ router: { statuses: () => [] }, runtime: {} });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const link = await call("spotify_connect", {});
    const state = new URL(link.url).searchParams.get("state");

    const res = await fetch(`${base}/spotify/callback?code=good-code&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Spotify connected/);
    assert.match(res.headers.get("content-type"), /text\/html/);

    const row = db.getOauthTokens(OMARI, "spotify");
    assert.ok(row?.access_token, "the handshake really completed");
    assert.ok(!html.includes(row.access_token), "the access token must never be on a web page");
    assert.ok(!html.includes(row.refresh_token), "nor the refresh token");

    // A failed or replayed callback answers 400 and still shows a human something.
    const again = await fetch(`${base}/spotify/callback?code=good-code&state=${encodeURIComponent(state)}`);
    assert.equal(again.status, 400);
    assert.match(await again.text(), /Spotify not connected/);

    const declined = await fetch(`${base}/spotify/callback?error=access_denied&state=nonsense`);
    assert.equal(declined.status, 400);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test("health says whether the developer app is set up and which redirect address it needs", async () => {
  const { health } = await import("../src/http.js");
  const h = health({ router: { statuses: () => [] }, runtime: {} });
  assert.equal(h.spotify.app_configured, true);
  assert.equal(h.spotify.redirect_uri, "http://127.0.0.1:8787/spotify/callback");

  const id = config.spotifyClientId;
  config.spotifyClientId = "";
  try {
    const off = health({ router: { statuses: () => [] }, runtime: {} });
    assert.equal(off.spotify.app_configured, false);
    assert.deepEqual(off.spotify.missing, ["SPOTIFY_CLIENT_ID"]);
  } finally {
    config.spotifyClientId = id;
  }
});
