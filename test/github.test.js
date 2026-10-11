// GitHub, against a fake GitHub that answers the routes their docs document.
//
// What these tests are for:
//   1. One person's token is never usable by another.
//   2. The connect flow produces a working token and a connected_accounts row.
//   3. The disconnect flow clears everything.
//   4. Each tool calls the right API route and shapes the result properly.
//   5. With no credentials, everything says not_connected honestly.
//
// No key, no network: the base URLs point at the fixture.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGitHub } from "./fixture-github.js";

const dir = mkdtempSync(join(tmpdir(), "reason-github-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool } = await import("../src/tools.js");
const github = await import("../src/github.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";

let fake;
const call = (name, input, conversationId = OMARI) => runTool(name, input, { conversationId, messages: [] });

before(async () => {
  fake = await startGitHub();
  config.githubClientId = "gh-client-abc";
  config.githubClientSecret = "gh-secret-xyz";
  config.githubApiBase = fake.url;
  config.githubBase = fake.url;
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
  fake.state.issuesCreated.length = 0;
  fake.state.commentsPosted.length = 0;
  fake.state.prsMerged.length = 0;
  fake.state.authHeaders.length = 0;
  fake.state.tokenCalls.length = 0;
  fake.state.liveTokens.clear();
});

async function connect(conversationId = OMARI, { code = "good-code" } = {}) {
  const link = await call("github_connect", {}, conversationId);
  assert.equal(link.ok, true, JSON.stringify(link));
  const state = new URL(link.url).searchParams.get("state");
  const done = await github.completeConnect({ code, state });
  assert.equal(done.ok, true, JSON.stringify(done));
  return { link, done, state };
}

// ---------- connecting ----------

test("with no client id, everything says not_connected and nothing is invented", async () => {
  const id = config.githubClientId;
  config.githubClientId = "";
  try {
    for (const [tool, input] of [["github_connect", {}], ["github_repos", {}], ["github_issues", { repo: "omari/reason" }]]) {
      const out = await call(tool, input);
      assert.equal(out.ok, false, tool);
      assert.equal(out.status, "not_connected", tool);
      assert.ok(out.missing.includes("GITHUB_OAUTH_CLIENT_ID"), tool);
    }
  } finally {
    config.githubClientId = id;
  }
});

test("connect flow produces a link, code exchange gives a token, and the account row exists", async () => {
  const { link, done } = await connect();
  assert.ok(link.url.includes("/login/oauth/authorize"), "should point at GitHub's authorize");
  assert.ok(link.url.includes("client_id=gh-client-abc"), "should carry the client id");
  assert.equal(done.username, "omari");
  const row = db.getOauthTokens(OMARI, "github");
  assert.ok(row, "token row should exist");
  assert.ok(row.access_token.startsWith("ghp_"), "token should be a GitHub token");
  const acct = db.liveAccount(OMARI, "github");
  assert.ok(acct, "connected_accounts row should exist");
});

test("a replayed callback connects nothing", async () => {
  const link = await call("github_connect", {});
  const state = new URL(link.url).searchParams.get("state");
  await github.completeConnect({ code: "good-code", state });
  const second = await github.completeConnect({ code: "good-code", state });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "bad_state");
});

test("bad code returns token_exchange_failed", async () => {
  const link = await call("github_connect", {});
  const state = new URL(link.url).searchParams.get("state");
  const out = await github.completeConnect({ code: "bad-code", state });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "token_exchange_failed");
});

test("disconnect clears the token and the account row", async () => {
  await connect();
  assert.ok(db.getOauthTokens(OMARI, "github"));
  const out = await call("github_disconnect", {});
  assert.equal(out.ok, true);
  assert.equal(out.status, "revoked");
  assert.equal(db.getOauthTokens(OMARI, "github"), null);
  assert.ok(!db.liveAccount(OMARI, "github"), "connected_accounts row should be gone");
});

// ---------- repos ----------

test("github_repos lists repos", async () => {
  await connect();
  const out = await call("github_repos", {});
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  assert.equal(out.repos[0].name, "omari/reason");
  assert.equal(out.repos[1].name, "omari/website");
});

test("github_repos without connection says not_connected", async () => {
  const out = await call("github_repos", {});
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_connected");
});

// ---------- issues ----------

test("github_issues lists issues on a repo", async () => {
  await connect();
  const out = await call("github_issues", { repo: "omari/reason" });
  assert.equal(out.ok, true);
  assert.ok(out.count >= 2, "should have at least 2 open issues");
  assert.equal(out.issues[0].title, "Fix login bug");
});

test("github_issue_create creates an issue", async () => {
  await connect();
  const out = await call("github_issue_create", { repo: "omari/reason", title: "New feature", body: "Please add this", labels: ["enhancement"] });
  assert.equal(out.ok, true);
  assert.ok(out.number >= 100);
  assert.equal(out.title, "New feature");
  assert.ok(out.url.includes("omari/reason/issues/"));
  assert.equal(fake.state.issuesCreated.length, 1);
  assert.equal(fake.state.issuesCreated[0].title, "New feature");
});

test("github_issue_comment posts a comment", async () => {
  await connect();
  const out = await call("github_issue_comment", { repo: "omari/reason", issue_number: 1, body: "Looks good to me" });
  assert.equal(out.ok, true);
  assert.ok(out.url.includes("issuecomment"));
  assert.equal(fake.state.commentsPosted.length, 1);
  assert.equal(fake.state.commentsPosted[0].body, "Looks good to me");
});

// ---------- pulls ----------

test("github_pulls lists pull requests", async () => {
  await connect();
  const out = await call("github_pulls", { repo: "omari/reason" });
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  assert.equal(out.pulls[0].title, "Add GitHub integration");
  assert.equal(out.pulls[0].draft, false);
  assert.equal(out.pulls[1].draft, true);
});

test("github_pr_merge is gated behind confirmation", async () => {
  await connect();
  const out = await call("github_pr_merge", { repo: "omari/reason", pull_number: 10 });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(fake.state.prsMerged.length, 0, "nothing should have been merged");
});

test("github_pr_merge actually merges once it reaches the API", async () => {
  await connect();
  const tok = github.accessTokenFor(OMARI);
  assert.equal(tok.ok, true);
  const res = await github.api(tok.token, "PUT", "/repos/omari/reason/pulls/10/merge", {
    body: { merge_method: "squash" },
  });
  assert.equal(res.ok, true);
  assert.equal(res.body.merged, true);
  assert.ok(res.body.sha);
  assert.equal(fake.state.prsMerged.length, 1);
  assert.equal(fake.state.prsMerged[0].method, "squash");
});

// ---------- code search ----------

test("github_code_search searches code", async () => {
  await connect();
  const out = await call("github_code_search", { query: "console.log" });
  assert.equal(out.ok, true);
  assert.ok(out.count >= 1);
  assert.equal(out.results[0].path, "src/index.js");
});

// ---------- file read ----------

test("github_file_read reads a file", async () => {
  await connect();
  const out = await call("github_file_read", { repo: "omari/reason", path: "src/index.js" });
  assert.equal(out.ok, true);
  assert.ok(out.content.includes("hello reason"));
  assert.equal(out.sha, "abc123");
});

test("github_file_read on a missing file returns an error", async () => {
  await connect();
  const out = await call("github_file_read", { repo: "omari/reason", path: "does/not/exist.js" });
  assert.equal(out.ok, false);
});

// ---------- activity ----------

test("github_activity lists unread notifications", async () => {
  await connect();
  const out = await call("github_activity", {});
  assert.equal(out.ok, true);
  assert.equal(out.count, 2, "should only return unread notifications by default");
  assert.equal(out.notifications[0].title, "Add GitHub integration");
  assert.equal(out.notifications[0].reason, "review_requested");
});

test("github_activity with include_read lists all notifications", async () => {
  await connect();
  const out = await call("github_activity", { include_read: true });
  assert.equal(out.ok, true);
  assert.equal(out.count, 3, "should include read notifications");
});

// ---------- isolation ----------

test("one person's token is not usable by another person's conversation", async () => {
  await connect(OMARI);
  // Ama has not connected — her conversation should get not_connected
  const out = await call("github_repos", {}, AMA);
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_connected");
});
