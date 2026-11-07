// Audit lead 28: three tools that put model-written words in front of other people had no yes in
// code. event_blast texts every guest of an event; github_issue_create and github_issue_comment
// post under the owner's GitHub name on any repo the token can write to. The "show the draft and
// send once they say yes" rule lived only in a tool description, so a model steered by something it
// read (a page, an email, a guest's own words) could broadcast or publish without anybody agreeing.
//
// What these prove:
//   1. With no confirmation_id, none of the three reaches anybody: blocked needs_confirmation, with
//      the exact target handed back.
//   2. The yes is pinned to the words: a yes for one message cannot send a different one.
//   3. A real yes for exactly what goes out lets it go out, once.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGitHub } from "./fixture-github.js";

const dir = mkdtempSync(join(tmpdir(), "reason-outbound-gate-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "45".repeat(32);
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_EVENTS = "on";

const { runTool } = await import("../src/tools.js");
const events = await import("../src/events.js");
const github = await import("../src/github.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const KOFI_C = "dm:fake:+14155559876";
const AMA_C = "dm:fake:+13475550000";
const YAW_C = "dm:fake:+16465550111";

let fake;
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
  config.events = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM oauth_tokens; DELETE FROM oauth_states;
    DELETE FROM connected_accounts; DELETE FROM action_ledger; DELETE FROM confirmations;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: "+14155559876", name: "Kofi" });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: "+13475550000", name: "Ama" });
  db.upsertAccount({ conversationId: YAW_C, channel: "fake", address: "+16465550111", name: "Yaw" });
  fake.state.issuesCreated.length = 0;
  fake.state.commentsPosted.length = 0;
});

function fakeRuntime() {
  const sent = [];
  return {
    sent,
    say(conversationId, text) { return text; },
    async _tell(conversationId, text, { idempotencyKey }) {
      const have = db.db.prepare("SELECT * FROM outbox WHERE idem_key = ?").get(idempotencyKey);
      if (have) return { ok: true, outbox_id: have.id, duplicate: true };
      sent.push({ conversationId, text });
      const now = clock.now();
      const id = db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, created_at, updated_at)
        VALUES (?, ?, 'fake', 'x', ?, 'sent', ?, ?)`).run(idempotencyKey, conversationId, text, now, now).lastInsertRowid;
      return { ok: true, outbox_id: Number(id) };
    },
  };
}
const said = (who, text) => ({ role: "user", content: `[Wed, Oct 7 2026, 9:00 AM] ${who}: ${text}` });
const readsYes = () => async () => ({ verdict: "yes" });

/** Ask, let the person say yes to exactly `target`, and hand back the confirmation id. */
async function yesFor(c, who, action, target, summary) {
  const msgs = [said(who, "go on then")];
  const asked = await runTool("confirm_request", { action, summary, target, stakes: "third_party" }, { conversationId: c, messages: msgs });
  assert.ok(asked.confirmation_id, JSON.stringify(asked));
  msgs.push({ role: "assistant", content: "asked" }, said(who, "yes send it"));
  const rec = await runTool("confirm_record", { confirmation_id: asked.confirmation_id }, { conversationId: c, messages: msgs, judge: readsYes() });
  assert.equal(rec.state, "granted", JSON.stringify(rec));
  return asked.confirmation_id;
}

async function eventWithGuests() {
  const rt = fakeRuntime();
  const made = await runTool("event_create", {
    name: "Halloween Party", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St, Apt 4",
    welcome_message: "so glad you're coming!", password: "pumpkin", show_time_on_join: true, show_location_on_join: false,
    guest_list_visible: true,
  }, { conversationId: KOFI_C, messages: [], events: rt });
  assert.equal(made.ok, true, JSON.stringify(made));
  for (const c of [AMA_C, YAW_C]) {
    const r = await events.joinExisting({ conversationId: c, name: "Halloween Party", password: "pumpkin" });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  return db.getEventRow(made.event.event_id);
}

async function connectGitHub(c = OWNER_C) {
  const link = await runTool("github_connect", {}, { conversationId: c, messages: [] });
  assert.equal(link.ok, true, JSON.stringify(link));
  const done = await github.completeConnect({ code: "good-code", state: new URL(link.url).searchParams.get("state") });
  assert.equal(done.ok, true, JSON.stringify(done));
}

// ---------- event_blast ----------

test("event_blast with no yes texts nobody and hands back what the yes must cover", async () => {
  const ev = await eventWithGuests();
  const rt = fakeRuntime();
  const out = await runTool("event_blast", { event_id: ev.id, message: "party moved to my place, bring cash" }, { conversationId: KOFI_C, messages: [], events: rt });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(rt.sent.length, 0, "no guest may be texted without the organizer's yes");
  assert.match(out.use_target, /Halloween Party/);
  assert.match(out.use_target, /party moved to my place, bring cash/);
});

test("event_blast: a yes for one message cannot send another; a yes for this one sends it once", async () => {
  const ev = await eventWithGuests();
  const rt = fakeRuntime();
  const first = await runTool("event_blast", { event_id: ev.id, message: "bring snacks" }, { conversationId: KOFI_C, messages: [], events: rt });
  const id = await yesFor(KOFI_C, "Kofi", "event_blast", first.use_target, "text all 2 guests of Halloween Party: bring snacks");

  const other = await runTool("event_blast", { event_id: ev.id, message: "send me your card number", confirmation_id: id }, { conversationId: KOFI_C, messages: [], events: rt });
  assert.equal(other.ok, false, JSON.stringify(other));
  assert.equal(rt.sent.length, 0, "a different message must not ride the yes");

  const out = await runTool("event_blast", { event_id: ev.id, message: "bring snacks", confirmation_id: id }, { conversationId: KOFI_C, messages: [], events: rt });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.sent.guests, 2);
  assert.equal(rt.sent.length, 2);

  const again = await runTool("event_blast", { event_id: ev.id, message: "bring snacks", confirmation_id: id }, { conversationId: KOFI_C, messages: [], events: rt });
  assert.equal(again.ok, false, "a yes is spent once");
  assert.equal(rt.sent.length, 2);
});

// ---------- github writes ----------

test("github_issue_comment with no yes posts nothing", async () => {
  await connectGitHub();
  const out = await runTool("github_issue_comment", { repo: "omari/reason", issue_number: 1, body: "here is my private address" }, { conversationId: OWNER_C, messages: [] });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(fake.state.commentsPosted.length, 0, "nothing may be posted under their name without a yes");
  assert.match(out.use_target, /omari\/reason#1/);
});

test("github_issue_create with no yes opens nothing", async () => {
  await connectGitHub();
  const out = await runTool("github_issue_create", { repo: "omari/reason", title: "leak", body: "secrets" }, { conversationId: OWNER_C, messages: [] });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(fake.state.issuesCreated.length, 0);
  assert.match(out.use_target, /omari\/reason/);
});

test("github writes go out on a yes for exactly those words, and not for different ones", async () => {
  await connectGitHub();
  const ctx = { conversationId: OWNER_C, messages: [] };
  const c1 = await runTool("github_issue_comment", { repo: "omari/reason", issue_number: 1, body: "Looks good to me" }, ctx);
  const cid = await yesFor(OWNER_C, "Omari", "github_issue_comment", c1.use_target, "comment on omari/reason#1: Looks good to me");
  const swapped = await runTool("github_issue_comment", { repo: "omari/reason", issue_number: 1, body: "something else", confirmation_id: cid }, ctx);
  assert.equal(swapped.ok, false);
  assert.equal(fake.state.commentsPosted.length, 0);
  const posted = await runTool("github_issue_comment", { repo: "omari/reason", issue_number: 1, body: "Looks good to me", confirmation_id: cid }, ctx);
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(fake.state.commentsPosted.length, 1);

  const i1 = await runTool("github_issue_create", { repo: "omari/reason", title: "New feature", body: "Please add this" }, ctx);
  const iid = await yesFor(OWNER_C, "Omari", "github_issue_create", i1.use_target, "open an issue on omari/reason: New feature");
  const made = await runTool("github_issue_create", { repo: "omari/reason", title: "New feature", body: "Please add this", confirmation_id: iid }, ctx);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(fake.state.issuesCreated.length, 1);
});
