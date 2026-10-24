// Invites as a dark launch (REASON_INVITES_OPEN, src/config.js). Off by default, and off on live:
// the master alone is given the invite tools so he can try it with a real friend, nobody else's
// model is ever told invites exist, and the links he mints still open, claim and tell him who joined.
// Switching it on hands the same tools to everybody with no code change. Both states are pinned here;
// test/invites.test.js covers the feature itself with the switch on.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-invites-dark-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
delete process.env.REASON_AUTO_ADMIT;
// The default: nothing set.
delete process.env.REASON_INVITES_OPEN;

const invites = await import("../src/invites.js");
const { runTool, toolsFor, capabilitiesNow, INVITE_TOOLS, INVITE_MASTER_TOOLS } = await import("../src/tools.js");
const { mcpToolsFor } = await import("../src/backends/mcp-core.js");
const { systemFor } = await import("../src/agent.js");
const { ANNOUNCEABLE } = await import("../src/whatsnew.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { inviteRequestFor } = await import("../src/http.js");
const accounts = await import("../src/accounts.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const OWNER_C = config.ownerConversation;
const KOFI = "+14155559876";
const KOFI_C = `dm:fake:${KOFI}`;
const NEW1 = "+16465550101";
const LINE = "+16562167455";
const ALL = [...INVITE_TOOLS];

after(() => { config.invitesOpen = false; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  config.invitesOpen = false;
  db.db.exec(`DELETE FROM accounts; DELETE FROM invites; DELETE FROM invite_allowances; DELETE FROM invite_requests;
    DELETE FROM access_requests; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox;
    DELETE FROM usage; DELETE FROM confirmations; DELETE FROM turned_away;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi" });
  db.backfillInviteAllowances();
});

const names = (list) => list.map(t => t.name);
const ctxFor = (conversationId, events = null) => ({ conversationId, messages: [], ...(events ? { events } : {}) });
const tool = (name, input, conversationId, events) => runTool(name, input, ctxFor(conversationId, events));
let seq = 0;
const texts = (from, body) => ({ channel: "fake", externalId: `d${++seq}`, from, text: body, at: clock.now() });

function harness() {
  const turns = [];
  const said = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "ok"; } });
  runtime.on("outbound", (e) => said.push(e));
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  return { runtime, router, channel, turns, said };
}

// ---------- off (the default, and live) ----------

test("off by default: REASON_INVITES_OPEN unset reads as off", () => {
  assert.equal(config.invitesOpen, false);
});

test("off: a non-owner's tool list has no invite tool, on either backend; the master's has all six", () => {
  for (const list of [names(toolsFor(KOFI_C)), names(mcpToolsFor(KOFI_C))]) {
    assert.deepEqual(list.filter(n => INVITE_TOOLS.has(n)), [], "nobody else is told invites exist");
    assert.ok(!list.some(n => /invite/.test(n)), "no tool by any invite name");
  }
  // A stranger's thread that has no account yet reads the same.
  assert.deepEqual(names(toolsFor("dm:fake:+15550009999")).filter(n => INVITE_TOOLS.has(n)), []);
  for (const list of [names(toolsFor(OWNER_C)), names(mcpToolsFor(OWNER_C))]) {
    assert.deepEqual(ALL.filter(n => !list.includes(n)), [], "the master has every invite tool");
  }
});

test("off: a non-owner calling an invite tool anyway is refused and nothing is written", async () => {
  const before = JSON.stringify(db.db.prepare("SELECT * FROM invites").all()) + JSON.stringify(db.db.prepare("SELECT * FROM invite_requests").all());
  const said = [];
  const events = { say: (c, t) => said.push({ c, t }) };
  for (const [name, input] of [
    ["invites_list", {}], ["invite_link_create", {}], ["invite_link_cancel", { number: 1 }],
    ["invite_request_more", { count: 3, explanation: "my roommates" }],
    ["invite_requests_pending", {}], ["invite_request_decide", { request_number: 1, decision: "approve" }],
  ]) {
    const out = await tool(name, input, KOFI_C, events);
    assert.equal(out.ok, false, name);
    assert.equal(out.blocked, "not_available", name);
    assert.ok(!/invite/i.test(out.error), `the refusal does not describe invites (${name})`);
  }
  const after = JSON.stringify(db.db.prepare("SELECT * FROM invites").all()) + JSON.stringify(db.db.prepare("SELECT * FROM invite_requests").all());
  assert.equal(after, before);
  assert.deepEqual(said, [], "nobody was texted about it, the master included");
});

// The growth feature's own words. Calendar invites are a different thing and Reason has always
// talked about those, so this is the vocabulary of invite links, allowances and joining.
const GROWTH = /invite link|invites?_(list|link|request)|my invites|invites? left|more invites|invited you to Reason|from your invite|invite-only growth/i;

test("off: nothing a non-owner's model reads mentions invites — no prompt, capability, what's-new or playbook", () => {
  const me = accounts.ownerOf(KOFI_C);
  assert.ok(!GROWTH.test(systemFor(me)), "the system prompt says nothing of invites");
  assert.ok(!GROWTH.test(JSON.stringify(capabilitiesNow({ conversationId: KOFI_C }))), "the capability list says nothing of invites");
  assert.ok(!ANNOUNCEABLE.some(e => /invite/i.test(JSON.stringify(e))), "no what's-new entry: the announcement is the owner's to ask for later");
  // Tool descriptions are where the playbook nudges live; with the tools off the list there are none.
  assert.ok(!GROWTH.test(toolsFor(KOFI_C).map(t => t.description).join("\n")), "no tool description points at invites");
  // The guard is real: the same check finds them in the master's list.
  assert.ok(GROWTH.test(toolsFor(OWNER_C).map(t => t.description).join("\n")));
});

test("off: the backfill still gives everybody 2, invisibly", () => {
  assert.equal(db.inviteAllowance(KOFI_C), 2);
  assert.equal(db.inviteAllowance(OWNER_C), 2);
  assert.deepEqual(invites.allowanceCounts(), { 2: 2 });
});

test("off: the master mints, the page opens, a friend texts the code in, they join and he is told", async () => {
  const made = await tool("invite_link_create", {}, OWNER_C);
  assert.equal(made.ok, true, JSON.stringify(made));
  const inv = db.getInvite(OWNER_C, made.number);
  assert.match(made.link, /^https:\/\/files\.example\.test\/i\/[A-Za-z0-9_-]{32}$/);

  const h = harness();
  const page = inviteRequestFor({ token: inv.token, router: h.router });
  assert.equal(page.status, 200);
  assert.match(page.body, /Omari invited you to Reason/);
  assert.equal(db.getInvite(OWNER_C, inv.id).state, "unused", "opening it spent nothing");

  const listed = await tool("invites_list", {}, OWNER_C);
  assert.equal(listed.links[0].state, "unused");

  await h.router.deliver({ ...texts(NEW1, invites.joinText(inv.claim_code)), displayName: "Esi" });
  const acct = db.getAccount(`dm:fake:${NEW1}`);
  assert.ok(acct, "the friend has an account");
  assert.equal(acct.invited_by, OWNER_C);
  assert.equal(db.getInvite(OWNER_C, inv.id).state, "redeemed");
  assert.equal(h.channel.sent.filter(m => m.to === NEW1)[0]?.text, "You're in, invited by Omari.");
  assert.deepEqual(h.said.filter(e => e.conversationId === OWNER_C).map(e => e.text), ["Esi joined from your invite."]);
  assert.equal(db.inviteAllowance(OWNER_C), 1);
  // And the friend, a non-owner, is not then told about invites either.
  assert.deepEqual(names(toolsFor(`dm:fake:${NEW1}`)).filter(n => INVITE_TOOLS.has(n)), []);
});

// ---------- on ----------

test("on: everybody gets the invite tools with no code change; deciding stays the master's", async () => {
  config.invitesOpen = true;
  const kofi = names(toolsFor(KOFI_C));
  for (const n of ALL) {
    assert.equal(kofi.includes(n), !INVITE_MASTER_TOOLS.has(n), n);
  }
  assert.deepEqual(names(mcpToolsFor(KOFI_C)).filter(n => INVITE_TOOLS.has(n)).sort(), ALL.filter(n => !INVITE_MASTER_TOOLS.has(n)).sort());
  assert.deepEqual(ALL.filter(n => !names(toolsFor(OWNER_C)).includes(n)), []);

  const made = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(made.ok, true, JSON.stringify(made));
  const listed = await tool("invites_list", {}, KOFI_C);
  assert.equal(listed.links.length, 1);
  const said = [];
  const filed = await tool("invite_request_more", { count: 3, explanation: "my roommates" }, KOFI_C, { say: (c, t) => said.push({ c, t }) });
  assert.equal(filed.ok, true);
  assert.match(said.find(s => s.c === OWNER_C)?.t ?? "", /invite request #\d+/);
  const decided = await tool("invite_request_decide", { request_number: filed.request_number, decision: "approve" }, KOFI_C);
  assert.equal(decided.blocked, "master_only", "still the master's to decide");
});
