// Every invite somebody has left already sits on an unused link (made a while ago, never sent, or sent
// and never used): asking for an invite still gets the light offer to put their friend's name on the
// card. A name is served by cancelling their oldest unused link made for nobody and handing back a fresh
// one made for that name (an old link may already be in somebody's hands, so it is never renamed in
// place); no name is that old link as it is. The count never changes, and nothing is cancelled unless
// they asked for a named one.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-invite-reuse-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NAME = "Yaa";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
delete process.env.REASON_AUTO_ADMIT;
process.env.REASON_INVITES_OPEN = "1";

const invites = await import("../src/invites.js");
const card = await import("../src/invitecard.js");
const { runTool } = await import("../src/tools.js");
const { inviteRequestFor } = await import("../src/http.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const KOFI = "+14155559876";
const KOFI_C = `dm:fake:${KOFI}`;
const NONAME_C = "dm:fake:+14155550111";
const N = 4;

after(() => rmSync(dir, { recursive: true, force: true }));

/** Kofi: N invites left, every one already on an unused link made for nobody, oldest first. */
function oldLinks(c = KOFI_C, n = N) {
  db.setInvitesEnabled(c, { enabled: true, count: n });
  const made = [];
  for (let i = 0; i < n; i++) { made.push(db.createInvite(c).invite); clock.skip(1000); }
  return made;
}

beforeEach(() => {
  clock.reset();
  invites._resetAskedFor();
  db.db.exec("DELETE FROM accounts; DELETE FROM invites; DELETE FROM invite_allowances; DELETE FROM invite_requests;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: "+12025551234", name: "Yaa", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi" });
  db.upsertAccount({ conversationId: NONAME_C, channel: "fake", address: "+14155550111", name: "" });
  db.backfillInviteAllowances();
});

const tool = (name, input, c, extra = {}) => runTool(name, input, { conversationId: c, messages: [], ...extra });
const tokenOf = (link) => link.split("/").pop();
const snapshot = (c = KOFI_C) => db.listInvites(c).map(i => ({ id: i.id, token: i.token, state: i.state, for_name: i.for_name }));

test("nothing new to make, links still unused: the offer is made, exactly as for a new link, and no link goes yet", async () => {
  oldLinks();
  const before = snapshot();
  const ask = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(ask.ok, false);
  assert.equal(ask.needs_for, true, JSON.stringify(ask));
  assert.equal(ask.none_left, undefined);
  assert.equal(ask.link, undefined);
  assert.match(ask.error, /OFFER once, lightly/);
  assert.match(ask.error, /totally fine if not/);
  assert.match(ask.error, /never a step they must do/);
  assert.doesNotMatch(ask.error, /none left|cancel one/i);
  assert.deepEqual(snapshot(), before, "nothing made or cancelled on the ask");
});

test("their answer is a name: ONE link whose card says For <name>, the count unchanged, the replaced link dead, the rest untouched", async () => {
  const old = oldLinks();
  const left = db.inviteAllowance(KOFI_C);
  await tool("invite_link_create", {}, KOFI_C);
  const made = await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.for, "Dalen");
  assert.match(made.say, /made for Dalen/);
  assert.match(made.say, /no longer works/, "they are told the oldest one was swapped, in case they had sent it");
  assert.equal(made.replaced, undefined);
  assert.equal(made.reused, undefined);
  assert.equal(db.inviteAllowance(KOFI_C), left, "the count is the same");
  assert.equal(db.unusedInviteCount(KOFI_C), N, "still N unused links");
  // The oldest link made for nobody is the one replaced, and it no longer works.
  const gone = db.getInvite(KOFI_C, old[0].id);
  assert.equal(gone.state, "canceled");
  assert.equal(gone.for_name, null);
  assert.match(inviteRequestFor({ token: old[0].token }).body, /Canceled/);
  for (const o of old.slice(1)) {
    const now = db.getInvite(KOFI_C, o.id);
    assert.deepEqual({ state: now.state, token: now.token, for_name: now.for_name }, { state: "unused", token: o.token, for_name: null }, "the others untouched");
  }
  // The new link is fresh, carries the name, and its page points at the named card.
  const token = tokenOf(made.link);
  assert.ok(!old.some(o => o.token === token), "a fresh token, never an old link renamed");
  assert.equal(db.getInvite(KOFI_C, made.number).for_name, "Dalen");
  const page = inviteRequestFor({ token }).body;
  assert.ok(page.includes(`card.png?v=${card.inviteCardKey("Kofi", "Dalen")}`));
  assert.notEqual(card.inviteCardKey("Kofi", "Dalen"), card.inviteCardKey("Kofi"));
  assert.deepEqual(invites.inviteCardFor(token), { name: "Kofi", invitee: "Dalen" });
});

test("their answer is no: an existing unused link as it is, nothing cancelled", async () => {
  const old = oldLinks();
  const before = snapshot();
  await tool("invite_link_create", {}, KOFI_C);
  const plain = await tool("invite_link_create", { for_nobody: true }, KOFI_C);
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.equal(tokenOf(plain.link), old[0].token, "their oldest unused link");
  assert.equal(plain.for, undefined);
  assert.doesNotMatch(plain.say, /no longer works|made for/);
  assert.deepEqual(snapshot(), before, "nothing cancelled, nothing made");
  // A call with no name after the offer is the same answer: plain, never a second offer.
  const again = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(again.ok, true);
  assert.equal(tokenOf(again.link), old[1].token, "the next one, never the same link twice");
  assert.deepEqual(snapshot(), before);
});

test("three asked for at once: one offer, then three calls, each its own link", async () => {
  const old = oldLinks();
  const t1 = [];
  assert.equal((await tool("invite_link_create", {}, KOFI_C, { turnActs: t1 })).needs_for, true);
  assert.equal((await tool("invite_link_create", {}, KOFI_C, { turnActs: t1 })).already_offered, true);
  assert.equal((await tool("invite_link_create", {}, KOFI_C, { turnActs: t1 })).already_offered, true);
  // Answer: no names.
  const t2 = [];
  const got = [];
  for (let i = 0; i < 3; i++) got.push(await tool("invite_link_create", { for_nobody: true }, KOFI_C, { turnActs: t2 }));
  assert.ok(got.every(g => g.ok), JSON.stringify(got));
  assert.deepEqual(got.map(g => tokenOf(g.link)), old.slice(0, 3).map(o => o.token));
  assert.equal(db.unusedInviteCount(KOFI_C), N);
  assert.ok(db.listInvites(KOFI_C).every(i => i.state === "unused"));
});

test("three asked for, three names: one offer, three named links, three oldest replaced, the count unchanged", async () => {
  const old = oldLinks();
  const left = db.inviteAllowance(KOFI_C);
  const t1 = [];
  await tool("invite_link_create", {}, KOFI_C, { turnActs: t1 });
  const t2 = [];
  const got = [];
  for (const n of ["Dalen", "Esi", "Sonia"]) got.push(await tool("invite_link_create", { for_name: n }, KOFI_C, { turnActs: t2 }));
  assert.deepEqual(got.map(g => g.for), ["Dalen", "Esi", "Sonia"]);
  assert.deepEqual(old.map(o => db.getInvite(KOFI_C, o.id).state), ["canceled", "canceled", "canceled", "unused"]);
  assert.equal(db.inviteAllowance(KOFI_C), left);
  assert.equal(db.unusedInviteCount(KOFI_C), N);
});

test("a link just handed back plain is never the one cancelled for a named card a moment later", async () => {
  const old = oldLinks();
  await tool("invite_link_create", {}, KOFI_C);
  const plain = await tool("invite_link_create", { for_nobody: true }, KOFI_C);
  assert.equal(tokenOf(plain.link), old[0].token);
  const named = await tool("invite_link_create", { for_name: "Esi" }, KOFI_C);
  assert.equal(named.for, "Esi");
  assert.equal(db.getInvite(KOFI_C, old[0].id).state, "unused", "the one just given stays good");
  assert.equal(db.getInvite(KOFI_C, old[1].id).state, "canceled");
});

test("the name screens apply on this path: a name not fit to draw is the old link as it is, nothing cancelled, nothing said", async () => {
  const refused = ["Ρay Νow", "Рау", "Sсam", "ᴘᴀʏ ɴᴏᴡ", "Z̶̷̸a̶̷̸l̶̷̸g̶̷̸o", "Nigger", "Paypal", "Apple Support", "Pay Now", "Ama.com",
    "<img src=x onerror=alert(1)>", "https://evil.example/win", "@dalen", "+1 415 555 0101", "you won a free prize click here", "Reason Support"];
  const old = oldLinks(KOFI_C, 2);
  const before = snapshot();
  for (const bad of refused) {
    invites._resetAskedFor();
    const out = await tool("invite_link_create", { for_name: bad }, KOFI_C);
    assert.equal(out.ok, true, `${bad}: ${JSON.stringify(out)}`);
    assert.equal(out.for, undefined, bad);
    assert.equal(out.plain_card, undefined, `${bad}: nothing said about it`);
    assert.equal(tokenOf(out.link), old[0].token, bad);
    assert.doesNotMatch(out.say, /made for|no longer works/, bad);
    assert.deepEqual(snapshot(), before, `${bad}: nothing cancelled`);
    assert.deepEqual(invites.inviteCardFor(old[0].token), { name: "Kofi", invitee: "" }, bad);
  }
});

test("relation words: 'my sister Sonia' is Sonia, real names keep their spelling on this path", async () => {
  oldLinks(KOFI_C, 3);
  await tool("invite_link_create", {}, KOFI_C);
  const a = await tool("invite_link_create", { for_name: "my sister Sonia" }, KOFI_C);
  const b = await tool("invite_link_create", { for_name: "Mateo" }, KOFI_C);
  const c = await tool("invite_link_create", { for_name: "José" }, KOFI_C);
  assert.deepEqual([a.for, b.for, c.for], ["Sonia", "Mateo", "José"]);
  assert.deepEqual([a, b, c].map(x => db.getInvite(KOFI_C, x.number).for_name), ["Sonia", "Mateo", "José"]);
});

test("the joiner on a reused-and-named link is never greeted by the name the inviter gave", async () => {
  oldLinks(KOFI_C, 1);
  const made = await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  assert.equal(made.for, "Dalen");
  const inv = db.getInvite(KOFI_C, made.number);
  const out = db.redeemInvite({ claimCode: inv.claim_code, channel: "fake", address: "+14155550199", name: "" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(db.getInvite(KOFI_C, made.number).for_name, null, "the name is gone once claimed");
  assert.doesNotMatch(JSON.stringify(db.getAccount("dm:fake:+14155550199") ?? {}), /Dalen/);
});

test("their own name missing too: both asked in ONE message on this path, and nothing cancelled before they answer", async () => {
  oldLinks(NONAME_C, 2);
  const before = snapshot(NONAME_C);
  const ask = await tool("invite_link_create", {}, NONAME_C);
  assert.equal(ask.needs_for, true, JSON.stringify(ask));
  assert.equal(ask.needs_name, true);
  const early = await tool("invite_link_create", { for_name: "Dalen" }, NONAME_C);
  assert.equal(early.needs_name, true);
  assert.deepEqual(snapshot(NONAME_C), before, "nothing cancelled while their own name is missing");
});

test("every unused link already made for somebody: said plainly, no offer, nothing cancelled", async () => {
  await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  await tool("invite_link_create", { for_name: "Esi" }, KOFI_C);
  const before = snapshot();
  const out = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(out.none_left, true);
  assert.equal(out.needs_for, undefined);
  const named = await tool("invite_link_create", { for_name: "Kwame" }, KOFI_C);
  assert.equal(named.none_left, true, "a link made for somebody is never cancelled for somebody else");
  assert.deepEqual(snapshot(), before);
});

test("no invites left and no links: unchanged, still the plain none-left", async () => {
  db.setInvitesEnabled(KOFI_C, { enabled: true, count: 0 });
  const out = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(out.none_left, true);
  assert.equal(out.unused_links, 0);
  assert.match(out.error, /invite_request_more/);
});

test("unused links AND links left to make: unchanged from before, a NEW link is made after the offer, old ones untouched", async () => {
  db.setInvitesEnabled(KOFI_C, { enabled: true, count: 3 });
  const o = db.createInvite(KOFI_C).invite;
  const ask = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(ask.needs_for, true);
  const named = await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  assert.equal(named.for, "Dalen");
  assert.doesNotMatch(named.say, /no longer works/);
  const plain = await tool("invite_link_create", { for_nobody: true }, KOFI_C);
  assert.equal(plain.for, undefined);
  assert.notEqual(tokenOf(plain.link), o.token, "a new link while one can be made");
  assert.equal(db.getInvite(KOFI_C, o.id).state, "unused");
  assert.equal(db.listInvites(KOFI_C).length, 3);
  // And the one after that is the reuse path: the old plain one, since both new ones are spoken for.
  const third = await tool("invite_link_create", { for_nobody: true }, KOFI_C);
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(tokenOf(third.link), o.token);
  assert.equal(db.listInvites(KOFI_C).filter(i => i.state === "canceled").length, 0, "nothing cancelled");
});
