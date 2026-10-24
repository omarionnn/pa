// The card connection has to last (2026-10-24): the owner reconnected his card after 10-12, 10-17
// and 10-24, because AgentCard's access token lives an hour and every refresh rotates — spends — the
// refresh token it is given.
//
// What has to stay true, one pinned test each:
//   - a refresh that answers with no user id is KEPT, against the user already on the row;
//   - two refreshes at the same moment are ONE refresh — the second caller never presents a token
//     the first already spent;
//   - a network failure is not a dead connection: nothing is marked, nobody is told to reconnect,
//     and no new link replaces the working one;
//   - only AgentCard refusing the refresh token marks it dead, and a dead one is not retried;
//   - the sweep rotates a token shortly before it ends, so a purchase never needs the refresh;
//   - the status page says ok / expiring / dead per person, texts only about the owner's.
//
// No key, no network: the API base points at the fixture.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgentCard } from "./fixture-agentcard.js";

const dir = mkdtempSync(join(tmpdir(), "reason-agentcard-conn-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "22".repeat(32);
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const tools = await import("../src/tools.js");
const { runTool } = tools;
const agentcard = await import("../src/agentcard.js");
const db = await import("../src/db.js");
const ops = await import("../src/ops.js");
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
let fake;

const call = (name, input, conversationId = OMARI) => runTool(name, input, { conversationId, messages: [] });

before(async () => {
  fake = await startAgentCard();
  config.agentcardClientId = "ac-client-abc";
  config.agentcardClientSecret = "ac-secret-xyz";
  config.agentcardApiBase = fake.url;
  config.publicUrl = "";
});
after(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  agentcard.forgetAccessToken();
  db.db.exec("DELETE FROM agentcard_users; DELETE FROM accounts; DELETE FROM ops_checks; DELETE FROM ops_state;");
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
  fake.set({ sessionStatus: "pending", sessionUser: "usr_8f3k2m", knownUsers: ["usr_8f3k2m", "usr_ama"], cardsByUser: null, exchange: "ok", refresh: "ok", refreshDelayMs: 0 });
  for (const k of ["refreshes", "exchanges", "vaultSessions", "cardReads", "tokenCalls"]) fake.state[k].length = 0;
  fake.state.exchanged.clear();
  fake.state.liveRefresh.clear();
  fake.state.tokenUser.clear();
});

/** Connected through the real path: a link minted, finished at AgentCard, exchanged here. */
async function connect(conversationId = OMARI, user = "usr_8f3k2m") {
  await call("vault_enroll", {}, conversationId);
  fake.set({ sessionStatus: "linked", sessionUser: user });
  const out = await call("vault_enroll", {}, conversationId);
  assert.equal(out.already_enrolled, true, JSON.stringify(out));
  const row = db.getAgentcardUser(conversationId);
  assert.ok(row.access_token && row.refresh_token);
  return row;
}
const age = (conversationId, at) => db.db.prepare("UPDATE agentcard_users SET token_expires_at = ? WHERE conversation_id = ?").run(at, conversationId);

test("pinned: a rotation with no user id in the answer keeps the new pair against the row's user", async () => {
  const before = await connect();
  age(OMARI, clock.now() - 1);
  const r = await tools.refreshAgentcardOnce(OMARI);
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = db.getAgentcardUser(OMARI);
  assert.equal(after.user_id, before.user_id);
  assert.notEqual(after.access_token, before.access_token);
  assert.notEqual(after.refresh_token, before.refresh_token, "the rotated refresh token is the one stored");
  assert.ok(fake.state.liveRefresh.has(after.refresh_token), "and it is the one AgentCard holds live");
  assert.ok(after.token_expires_at > clock.now() + 50 * 60_000, "an hour's token, less the slack");
  assert.ok(after.refreshed_at);
  assert.equal(after.connection_dead_at, null);
});

test("pinned: two refreshes at the same moment are one refresh, and neither spends a dead token", async () => {
  await connect();
  age(OMARI, clock.now() - 1);
  fake.set({ refreshDelayMs: 40 });
  // A purchase turn and the sweep reaching for the same connection at once.
  const [a, b, sweep] = await Promise.all([
    call("vault_enroll", {}),
    call("vault_enroll", {}),
    tools.refreshAgentcardConnections({ now: clock.now() }),
  ]);
  assert.equal(fake.state.refreshes.length, 1, `one refresh went out, not ${fake.state.refreshes.length}`);
  assert.equal(a.already_enrolled, true, JSON.stringify(a));
  assert.equal(b.already_enrolled, true, JSON.stringify(b));
  assert.equal(sweep.refreshed, 1);
  const row = db.getAgentcardUser(OMARI);
  assert.equal(row.connection_dead_at, null, "nobody presented the spent token and got it killed");
  assert.ok(fake.state.liveRefresh.has(row.refresh_token));
});

for (const mode of ["down", "drop"]) {
  test(`pinned: a refresh that cannot reach AgentCard (${mode}) does not kill the connection`, async () => {
    const before = await connect();
    age(OMARI, clock.now() - 1);
    fake.set({ refresh: mode });
    const lines = [];
    const out = await call("purchase", { ask: "coffee", address_street: "1 A St", address_city: "New York", address_state: "NY", address_zip: "10012" });
    assert.equal(out.ok, false);
    assert.equal(out.blocked, "agentcard_unreachable", JSON.stringify(out));
    assert.doesNotMatch(out.error, /vault_enroll|reconnect their/i);
    // Nor does asking for the link hand out a new one over a working connection.
    const minted = fake.state.vaultSessions.length;
    const link = await call("vault_enroll", {});
    assert.equal(link.blocked, "agentcard_unreachable");
    assert.equal(fake.state.vaultSessions.length, minted, "no new link was minted");

    const row = db.getAgentcardUser(OMARI);
    assert.equal(row.connection_dead_at, null, "not marked dead");
    assert.equal(row.refresh_token, before.refresh_token, "the refresh token is kept for the next try");
    assert.ok(row.refresh_failed_at);
    assert.equal(ops.cardConnectionState(row).state, "expiring");

    // AgentCard is back: the very same refresh token works, and the next try is clean.
    fake.set({ refresh: "ok" });
    const sweep = await tools.refreshAgentcardConnections({ now: clock.now() + tools.AGENTCARD_REFRESH_RETRY_MS + 1, log: l => lines.push(l) });
    assert.equal(sweep.refreshed, 1);
    const healed = db.getAgentcardUser(OMARI);
    assert.equal(healed.refresh_failed_at, null);
    assert.equal(ops.cardConnectionState(healed).state, "ok");
    assert.deepEqual(lines.map(l => l.agentcard_refresh), ["ok"]);
  });
}

test("a refresh AgentCard refuses marks the connection dead, once, and the sweep leaves it alone", async () => {
  await connect();
  age(OMARI, clock.now() - 1);
  fake.state.liveRefresh.clear(); // the refresh token was spent elsewhere — the 2026-10-24 probe
  const lines = [];
  const first = await tools.refreshAgentcardConnections({ now: clock.now(), log: l => lines.push(l) });
  assert.deepEqual(first, { refreshed: 0, failed: 1 });
  const row = db.getAgentcardUser(OMARI);
  assert.ok(row.connection_dead_at, "dead");
  assert.match(row.refresh_error, /not valid/);
  assert.equal(ops.cardConnectionState(row).state, "dead");
  assert.equal(lines[0].agentcard_refresh, "failed");
  assert.equal(lines[0].dead, true);
  // No token value in the log line, ever.
  const logged = JSON.stringify(lines);
  for (const v of [row.access_token, row.refresh_token]) assert.ok(!logged.includes(v), "no token in the log");

  // Later passes do not knock on a door that said no.
  await tools.refreshAgentcardConnections({ now: clock.now() + 3_600_000 });
  assert.equal(fake.state.refreshes.length, 1, "not retried");
  // And the person is told to reconnect, which a new link fixes.
  const out = await call("purchase", { ask: "coffee", address_street: "1 A St", address_city: "New York", address_state: "NY", address_zip: "10012" });
  assert.equal(out.blocked, "connection_expired", JSON.stringify(out));
  assert.match(out.error, /vault_enroll/);

  // A new link, finished: the exchange clears the dead mark and the connection is whole again.
  fake.set({ sessionStatus: "pending" });
  const link = await call("vault_enroll", {});
  assert.ok(link.url, JSON.stringify(link));
  fake.set({ sessionStatus: "linked" });
  const back = await call("vault_enroll", {});
  assert.equal(back.already_enrolled, true, JSON.stringify(back));
  const fresh = db.getAgentcardUser(OMARI);
  assert.equal(fresh.connection_dead_at, null);
  assert.equal(ops.cardConnectionState(fresh).state, "ok");
});

test("pinned: the sweep rotates a token shortly before it ends, and only rows that can be rotated", async () => {
  await connect(OMARI);
  await connect(AMA, "usr_ama");
  const now = clock.now();
  // Omari's token ends in five minutes; Ama's has most of its hour left.
  age(OMARI, now + 5 * 60_000);
  age(AMA, now + 45 * 60_000);
  // Somebody connected once and holding no refresh token is never sent to AgentCard.
  db.db.prepare("INSERT INTO agentcard_users (conversation_id, user_id, created_at, updated_at, token_expires_at) VALUES ('dm:old', 'usr_old', ?, ?, ?)").run(now, now, now - 1);
  const omariBefore = db.getAgentcardUser(OMARI);
  const amaBefore = db.getAgentcardUser(AMA);
  const lines = [];
  const out = await tools.refreshAgentcardConnections({ now, log: l => lines.push(l) });
  assert.deepEqual(out, { refreshed: 1, failed: 0 });
  assert.deepEqual(fake.state.refreshes, [omariBefore.refresh_token]);
  assert.notEqual(db.getAgentcardUser(OMARI).access_token, omariBefore.access_token, "rotated ahead of time");
  assert.equal(db.getAgentcardUser(AMA).access_token, amaBefore.access_token, "a token with time left is left alone");
  assert.deepEqual(lines.map(l => [l.agentcard_refresh, l.conversation, l.why]), [["ok", OMARI, "sweep"]]);
  // Then a purchase-time read finds a live token and never needs the refresh.
  await call("vault_enroll", {});
  assert.equal(fake.state.refreshes.length, 1);

  // The runtime's sweep is where it runs.
  const { Runtime } = await import("../src/runtime.js");
  assert.equal(typeof Runtime.prototype.cardConnections, "function");
});

test("expires_in is read as seconds, string or number; expires_at is accepted; a short token is not written already expired", () => {
  const now = 1_800_000_000_000;
  assert.equal(agentcard.expiryFrom({ expires_in: 3600 }, now), now + 3_600_000 - 60_000);
  assert.equal(agentcard.expiryFrom({ expires_in: "3600" }, now), now + 3_600_000 - 60_000);
  assert.equal(agentcard.expiryFrom({}, now), now + 3_600_000 - 60_000, "nothing said: an hour");
  assert.equal(agentcard.expiryFrom({ expires_in: 0 }, now), now + 3_600_000 - 60_000);
  assert.equal(agentcard.expiryFrom({ expires_at: new Date(now + 1_800_000).toISOString() }, now), now + 1_800_000 - 60_000);
  assert.equal(agentcard.expiryFrom({ expires_at: Math.floor((now + 1_800_000) / 1000) }, now), now + 1_800_000 - 60_000);
  assert.ok(agentcard.expiryFrom({ expires_in: 30 }, now) > now, "a 30-second token is still in the future");
});

test("refused vs unreachable: only AgentCard saying no to the token itself is a refusal", () => {
  assert.equal(agentcard.refreshRefused({ httpStatus: 401, code: "invalid_grant", error: "That refresh token is not valid." }), true);
  assert.equal(agentcard.refreshRefused({ httpStatus: 400, code: "invalid_request" }), true);
  assert.equal(agentcard.refreshRefused({ httpStatus: 503 }), false);
  assert.equal(agentcard.refreshRefused({ httpStatus: 429 }), false);
  assert.equal(agentcard.refreshRefused({ httpStatus: 408 }), false);
  assert.equal(agentcard.refreshRefused({ timedOut: true }), false);
  assert.equal(agentcard.refreshRefused({ unreachable: true }), false);
  assert.equal(agentcard.refreshRefused({ httpStatus: 401, code: "invalid_token", error: "An organization token is required." }), false);
});

test("a 200 that rotated the refresh token but carried no access token still keeps the new refresh token", async () => {
  const fetchImpl = async (url) => new URL(url).pathname === "/api/v2/oauth/token"
    ? new Response(JSON.stringify({ access_token: "org", expires_in: 3600 }), { status: 200 })
    : new Response(JSON.stringify({ object: "connection", refresh_token: "acrt_only" }), { status: 200 });
  const r = await agentcard.refreshConnection("acrt_x", { userId: "usr_8f3k2m", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.refreshToken, "acrt_only", "handed back, so the caller can keep it");
});

// ---------- the status page ----------

test("pinned: /ops shows each person's card connection — ok, expiring, dead — and texts only about the owner's", async () => {
  await connect(OMARI);
  await connect(AMA, "usr_ama");
  const sent = [];
  const runtime = { say: (c, text) => { sent.push({ c, text }); return text; } };
  const rows = () => Object.fromEntries(ops.cardConnectionChecks({ now: clock.now() }).map(c => [c.id, c]));

  let r = rows();
  assert.equal(r.card_connection.state, "ok");
  assert.equal(r.card_connection.label, "Card connection — Omari");
  assert.match(r.card_connection.detail, /^connected · token good for/);
  assert.equal(r[`card_connection:${AMA}`].state, "ok");

  // Expiring: the token ran out and the refresh could not reach AgentCard.
  age(OMARI, clock.now() - 60_000);
  db.noteAgentcardRefreshFailed(OMARI, { dead: false, error: "Could not reach AgentCard: fetch failed" });
  r = rows();
  assert.equal(r.card_connection.state, "warn");
  assert.match(r.card_connection.detail, /refresh could not reach AgentCard .* retrying/);

  // Dead, for both. The owner's is red; Ama's is shown, quiet.
  db.noteAgentcardRefreshFailed(OMARI, { dead: true, error: "That refresh token is not valid." });
  age(AMA, clock.now() - 60_000);
  db.noteAgentcardRefreshFailed(AMA, { dead: true, error: "That refresh token is not valid." });
  r = rows();
  assert.equal(r.card_connection.state, "bad");
  assert.match(r.card_connection.detail, /^dead — Omari needs to reconnect their card/);
  assert.equal(r[`card_connection:${AMA}`].state, "warn");
  assert.equal(r[`card_connection:${AMA}`].quiet, true);

  // Through the sustained-alert path: nothing on the first pass, one text to the owner once it stays.
  const report = (at) => ({ at, checks: ops.cardConnectionChecks({ now: at }), verdict: "bad" });
  const t0 = clock.now();
  ops.settle({ report: report(t0), runtime });
  assert.equal(sent.length, 0, "a first sighting is not texted");
  ops.settle({ report: report(t0 + ops.ALERT_AFTER_MS + 1), runtime });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].c, OMARI, "only ever the owner");
  assert.match(sent[0].text, /Card connection — Omari: dead — Omari needs to reconnect/);
  assert.doesNotMatch(sent[0].text, /Ama/, "somebody else's lapsed link is not texted");
  ops.settle({ report: report(t0 + 2 * ops.ALERT_AFTER_MS), runtime });
  assert.equal(sent.length, 1, "told once");
  assert.ok(sent.every(s => s.c === OMARI));
});
