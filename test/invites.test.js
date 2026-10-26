// Invite-only growth (src/invites.js): every person has a lifetime allowance, each invite is its own
// single-use link, and an invite is spent only when somebody actually joins with it.
//
// The live line cannot text a stranger first (Sendblue inbound-only), so the phone is proved the
// other way round: the invite page prefills a text TO Reason with the invite's claim code, and that
// inbound text is the verification and the claim at once. These tests drive the real router, the
// real database and the real tool dispatch; only the model turn is stated.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-invites-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
// Auto-admit off: an invite is the thing that lets a stranger in here, so a code-less text from a
// stranger must NOT be admitted by anything else in these tests.
delete process.env.REASON_AUTO_ADMIT;
// These tests are the feature switched on for everybody; test/invites-dark.test.js is it switched off.
process.env.REASON_INVITES_OPEN = "1";

const invites = await import("../src/invites.js");
const { runTool } = await import("../src/tools.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { inviteRequestFor, createServer } = await import("../src/http.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const KOFI = "+14155559876"; // an existing user, with a name
const AMA = "+13475550000"; // an existing user with no name yet
const NEW1 = "+16465550101";
const NEW2 = "+16465550102";
const KOFI_C = `dm:fake:${KOFI}`;
const AMA_C = `dm:fake:${AMA}`;
const LINE = "+16562167455";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM accounts; DELETE FROM invites; DELETE FROM invite_allowances; DELETE FROM invite_requests;
    DELETE FROM access_requests; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox;
    DELETE FROM usage; DELETE FROM confirmations; DELETE FROM turned_away;`);
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi" });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: AMA, name: "" });
  db.backfillInviteAllowances();
});

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

let seq = 0;
const texts = (from, body) => ({ channel: "fake", externalId: `m${++seq}`, from, text: body, at: clock.now() });
const sentTo = (channel, to) => channel.sent.filter(m => m.to === to).map(m => m.text);
const ctxFor = (conversationId, events = null) => ({ conversationId, messages: [], ...(events ? { events } : {}) });
const tool = (name, input, conversationId, events) => runTool(name, input, ctxFor(conversationId, events));
const allowance = (c) => db.inviteAllowance(c);
const mint = (c) => {
  const out = invites.makeLink(c);
  assert.equal(out.ok, true, JSON.stringify(out));
  return db.getInvite(c, out.number);
};
const snapshot = () => JSON.stringify({
  invites: db.db.prepare("SELECT * FROM invites ORDER BY id").all(),
  allowances: db.db.prepare("SELECT * FROM invite_allowances ORDER BY conversation_id").all(),
  accounts: db.db.prepare("SELECT conversation_id, invited_by FROM accounts ORDER BY conversation_id").all(),
});

// ---------- tokens ----------

test("every link is its own random token and its own claim code", () => {
  db.db.prepare("UPDATE invite_allowances SET remaining = 500 WHERE conversation_id = ?").run(KOFI_C);
  const tokens = new Set();
  const codes = new Set();
  for (let i = 0; i < 300; i++) {
    const inv = mint(KOFI_C);
    assert.match(inv.token, /^[A-Za-z0-9_-]{32}$/, "24 random bytes, base64url");
    assert.match(inv.claim_code, /^[2-9A-HJKMNP-Z]{8}$/, "8 characters nobody misreads");
    tokens.add(inv.token);
    codes.add(inv.claim_code);
  }
  assert.equal(tokens.size, 300, "no token repeats");
  assert.equal(codes.size, 300, "no claim code repeats");
  // Random, not sequential: the characters of the tokens are spread over the alphabet.
  const chars = new Set([...tokens].join(""));
  assert.ok(chars.size > 55, `token characters cover the base64url alphabet (${chars.size})`);
});

// ---------- allowance ----------

test("backfill: everybody already here starts with 2, invitees with 0, and re-running refills nobody", () => {
  assert.equal(allowance(config.ownerConversation), 2, "the owner too");
  assert.equal(allowance(KOFI_C), 2);
  db.db.prepare("UPDATE invite_allowances SET remaining = 1 WHERE conversation_id = ?").run(KOFI_C);
  db.backfillInviteAllowances();
  assert.equal(allowance(KOFI_C), 1, "lifetime, not refilling");
  db.db.prepare("INSERT INTO accounts (conversation_id, channel, address, created_at, invited_by) VALUES ('dm:fake:+1999', 'fake', '+1999', 0, ?)").run(KOFI_C);
  db.backfillInviteAllowances();
  assert.equal(allowance("dm:fake:+1999"), 0, "somebody who came in on an invite gets none");
});

test("cancel and replace never drop the allowance; minting is capped by it; only a join spends it", async () => {
  const a = mint(KOFI_C);
  mint(KOFI_C);
  assert.equal(invites.makeLink(KOFI_C).none_left, true, "two invites, two links, no third");
  assert.equal(allowance(KOFI_C), 2, "making links spends nothing");

  const c = invites.cancelLink(KOFI_C, a.id);
  assert.equal(c.ok, true);
  assert.ok(c.replacement?.link, "a fresh link straight away");
  assert.equal(allowance(KOFI_C), 2, "canceling and replacing spend nothing");
  assert.equal(invites.makeLink(KOFI_C).none_left, true, "and the replacement holds the freed slot");

  const h = harness();
  const live = db.listInvites(KOFI_C).find(i => i.state === "unused");
  await h.router.deliver(texts(NEW1, invites.joinText(live.claim_code)));
  assert.equal(allowance(KOFI_C), 1, "a join is the only thing that spends one");
  assert.equal(allowance(`dm:fake:${NEW1}`), 0, "and the invitee starts with 0, stored as a row");
  assert.equal(db.db.prepare("SELECT remaining FROM invite_allowances WHERE conversation_id = ?").get(`dm:fake:${NEW1}`).remaining, 0);
});

// ---------- the page ----------

test("a GET of the invite page renders who invited them and changes nothing — nor does a preview, HEAD or a hundred opens", () => {
  const inv = mint(KOFI_C);
  const h = harness();
  const before = snapshot();
  let out;
  for (let i = 0; i < 100; i++) out = inviteRequestFor({ token: inv.token, router: h.router });
  assert.equal(snapshot(), before, "no row changed");
  assert.equal(out.status, 200);
  assert.equal(out.headers["Cache-Control"], "no-store");
  assert.match(out.body, /Kofi invited you to Reason/);
  assert.match(out.body, /<meta property="og:title" content="Kofi invited you to Reason">/);
  assert.match(out.body, /<meta property="og:image" content="https:\/\/reason\.example\.test\/og\.png">/);
  assert.match(out.body, /You(?:'|&#39;)re early because Kofi brought you in, so Reason is free for you for good: no card, no subscription, ever\./, "what it costs: early means free for good, by the inviter's name");
  assert.match(out.body, /\(call this restaurant and book a table for 4,/, "calling leads the examples");
  assert.match(out.body, /family=Instrument\+Serif:ital@1/, "heading loads the homepage headline face");
  assert.match(out.body, /\.hero h1\{font-family:"Instrument Serif"[^}]*font-style:italic;font-weight:400/, "heading is the homepage's italic serif");
  assert.match(out.body, /Reason is your personal concierge/, "what Reason does");
  assert.match(out.body, /og:description" content="Your personal concierge\./, "link preview line");
  assert.doesNotMatch(out.body, /lives in your texts/i);
  const code = invites.formatCode(inv.claim_code);
  const href = /href="(sms:[^"]*)"/.exec(out.body)?.[1]?.replaceAll("&amp;", "&").replaceAll("&#39;", "'");
  assert.equal(href, `sms:${LINE}?&body=${encodeURIComponent(invites.joinText(inv.claim_code))}`, "the sms link to Reason with the code prefilled");
  assert.ok(out.body.includes(`text ${code} to +1 (656) 216-7455`), "and the code typed out for a desktop");
  assert.equal(db.getInvite(KOFI_C, inv.id).state, "unused");
});

test("over the wire: GET, HEAD and the files-domain path read the page; POST is refused; none of it changes a row", async () => {
  const inv = mint(KOFI_C);
  const h = harness();
  const server = createServer({ router: h.router, runtime: h.runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = snapshot();
    // What an iMessage / Slack / WhatsApp preview fetcher does: a plain GET with its own agent.
    const preview = await fetch(`${base}/i/${inv.token}`, { headers: { "user-agent": "facebookexternalhit/1.1 Facebot Twitterbot/1.0" } });
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /og:title/);
    const viaFiles = await fetch(`${base}/p/i/${inv.token}`);
    assert.equal(viaFiles.status, 200, "the files domain rewrites /i/x to /p/i/x");
    await viaFiles.text();
    const head = await fetch(`${base}/i/${inv.token}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    const post = await fetch(`${base}/i/${inv.token}`, { method: "POST", body: "code=x" });
    assert.equal(post.status, 405);
    await post.text();
    assert.equal(snapshot(), before, "no request changed anything");
  } finally {
    await new Promise(r => server.close(r));
  }
});

test("an unknown token is a flat not-found; a spent or canceled one says so on the page", () => {
  const h = harness();
  assert.equal(inviteRequestFor({ token: "x".repeat(32), router: h.router }).status, 404);
  const a = mint(KOFI_C);
  db.cancelInvite(KOFI_C, a.id);
  assert.match(inviteRequestFor({ token: a.token, router: h.router }).body, /canceled this invite/);
  const b = mint(KOFI_C);
  db.redeemInvite({ claimCode: b.claim_code, channel: "fake", address: NEW1 });
  const page = inviteRequestFor({ token: b.token, router: h.router }).body;
  assert.match(page, /already been claimed/);
  assert.doesNotMatch(page, /sms:/, "no join button on a spent link");
});

// ---------- claiming ----------

test("texting the code joins: one transaction spends it, makes dm:<channel>:<phone>, records the inviter; welcome first, then a normal turn", async () => {
  const inv = mint(KOFI_C);
  const h = harness();
  const out = await h.router.deliver(texts(NEW1, invites.joinText(inv.claim_code)));
  assert.equal(out.ok, true);
  const acct = db.getAccount(`dm:fake:${NEW1}`);
  assert.ok(acct, "the account exists under dm:<channel>:<phone>");
  assert.equal(acct.invited_by, KOFI_C, "who invited them");
  const row = db.getInvite(KOFI_C, inv.id);
  assert.equal(row.state, "redeemed");
  assert.equal(row.redeemed_by, `dm:fake:${NEW1}`);
  assert.ok(row.redeemed_at);
  assert.deepEqual(sentTo(h.channel, NEW1)[0], "You're in, invited by Kofi.");
  assert.equal(h.turns.length, 1, "their message runs as a normal turn — onboarding, harm screen and all");
  assert.equal(h.turns[0].conversationId, `dm:fake:${NEW1}`);
});

test("the inviter is told by name and nothing else; no word crosses in either direction", async () => {
  const inv = mint(KOFI_C);
  db.saveConversation(KOFI_C, [{ role: "user", content: "kofi's secret plans for saturday" }]);
  const h = harness();
  await h.router.deliver({ ...texts(NEW1, `${invites.joinText(inv.claim_code)} — also my bank pin is 4321`), displayName: "Esi" });
  const toKofi = h.said.filter(e => e.conversationId === KOFI_C).map(e => e.text);
  assert.deepEqual(toKofi, ["Esi joined from your invite."]);
  assert.ok(!toKofi.join(" ").includes("4321"), "nothing of what the invitee said");
  const toEsi = sentTo(h.channel, NEW1).join(" ");
  assert.ok(!toEsi.includes("saturday"), "nothing of the inviter's conversation");
  assert.ok(!h.said.filter(e => e.conversationId === `dm:fake:${NEW1}`).some(e => /saturday/.test(e.text)));

  // Without a name for them, the end of their number — still nothing from either thread.
  const inv2 = mint(KOFI_C);
  await h.router.deliver(texts(NEW2, invites.joinText(inv2.claim_code)));
  assert.equal(h.said.filter(e => e.conversationId === KOFI_C).at(-1).text, "someone with a number ending 0102 joined from your invite.");
});

test("two people claiming one link at once: exactly one wins, the other is told it has already been claimed", async () => {
  const inv = mint(KOFI_C);
  const h = harness();
  const text = invites.joinText(inv.claim_code);
  const [a, b] = await Promise.all([h.router.deliver(texts(NEW1, text)), h.router.deliver(texts(NEW2, text))]);
  const accounts = [NEW1, NEW2].filter(n => db.getAccount(`dm:fake:${n}`));
  assert.equal(accounts.length, 1, "one account made");
  const loser = accounts[0] === NEW1 ? NEW2 : NEW1;
  assert.deepEqual(sentTo(h.channel, loser), [invites.ALREADY_CLAIMED]);
  assert.match(invites.ALREADY_CLAIMED, /this invite has already been claimed/);
  assert.equal([a, b].filter(r => r.invite === "redeemed").length, 1);
  assert.equal(h.turns.length, 1, "and only the winner gets a turn");
  assert.equal(allowance(KOFI_C), 1, "spent once");

  // And the transaction itself: a second redeem of the same code cannot succeed.
  const again = db.redeemInvite({ claimCode: inv.claim_code, channel: "fake", address: "+16465550199" });
  assert.deepEqual([again.ok, again.reason], [false, "redeemed"]);
});

test("a canceled link refuses a claim and admits nobody; so does a redeemed one", async () => {
  const h = harness();
  const a = mint(KOFI_C);
  invites.cancelLink(KOFI_C, a.id, { replace: false });
  const out = await h.router.deliver(texts(NEW1, invites.joinText(a.claim_code)));
  assert.equal(out.admitted, false);
  assert.equal(db.getAccount(`dm:fake:${NEW1}`), null);
  assert.deepEqual(sentTo(h.channel, NEW1), [invites.CANCELED]);
  assert.equal(h.turns.length, 0);

  const b = mint(KOFI_C);
  await h.router.deliver(texts(NEW1, invites.joinText(b.claim_code)));
  await h.router.deliver(texts(NEW2, invites.joinText(b.claim_code)));
  assert.equal(db.getAccount(`dm:fake:${NEW2}`), null);
  assert.deepEqual(sentTo(h.channel, NEW2), [invites.ALREADY_CLAIMED]);
});

test("a stranger with no code is not let in by the invite path; an existing member's code is not spent on them", async () => {
  const h = harness();
  const inv = mint(KOFI_C);
  await h.router.deliver(texts(NEW1, "hello, who is this"));
  assert.equal(db.getAccount(`dm:fake:${NEW1}`), null, "no code, no invite");
  assert.equal(db.getInvite(KOFI_C, inv.id).state, "unused");

  await h.router.deliver(texts(AMA, invites.joinText(inv.claim_code)));
  assert.equal(db.getInvite(KOFI_C, inv.id).state, "unused", "not spent on somebody who already has one");
  assert.match(sentTo(h.channel, AMA).at(-1), /already got your own Reason/);
});

// ---------- the tools ----------

test("my invites covers every state, how many are left, and the pending request", async () => {
  const a = mint(KOFI_C);
  const b = mint(KOFI_C);
  invites.cancelLink(KOFI_C, a.id); // b unused, a canceled, replacement unused
  const h = harness();
  await h.router.deliver(texts(NEW1, invites.joinText(b.claim_code))); // b redeemed
  await tool("invite_request_more", { count: 5, explanation: "my study group" }, KOFI_C);
  const out = await tool("invites_list", {}, KOFI_C);
  assert.deepEqual(out.links.map(l => l.state).sort(), ["canceled", "redeemed", "unused"]);
  assert.ok(out.links.find(l => l.state === "unused").link.startsWith("https://files.example.test/i/"));
  assert.ok(!out.links.find(l => l.state !== "unused").link, "no URL for a link that can't be used");
  assert.equal(out.invites_left, 1);
  assert.equal(out.pending_request.count, 5);
  assert.equal(out.pending_request.explanation, "my study group");
  assert.ok(!JSON.stringify(out).includes(NEW1), "who claimed a link is not listed");
});

test("a link needs a name to show: none on the account means ask once, then mint", async () => {
  const out = await tool("invite_link_create", {}, AMA_C);
  assert.equal(out.needs_name, true);
  assert.equal(db.listInvites(AMA_C).length, 0);
  await tool("my_name", { name: "Ama" }, AMA_C);
  const made = await tool("invite_link_create", {}, AMA_C);
  assert.equal(made.ok, true);
  assert.equal(made.shown_as, "Ama");
});

test("a request needs a count and a reason; a second pending one updates the first; the master gets it by number", async () => {
  const said = [];
  const events = { say: (c, t) => said.push({ c, t }) };
  const first = await tool("invite_request_more", { count: 3, explanation: "my sisters" }, KOFI_C, events);
  assert.equal(first.ok, true);
  const second = await tool("invite_request_more", { count: 10, explanation: "my whole team at work" }, KOFI_C, events);
  assert.equal(second.updated, true);
  assert.equal(second.request_number, first.request_number, "the same request, updated");
  const rows = db.db.prepare("SELECT * FROM invite_requests WHERE conversation_id = ?").all(KOFI_C);
  assert.equal(rows.length, 1, "never two pending");
  assert.deepEqual([rows[0].requested_count, rows[0].explanation], [10, "my whole team at work"]);
  const toMaster = said.filter(s => s.c === config.ownerConversation).map(s => s.t);
  assert.equal(toMaster.length, 2);
  assert.match(toMaster[1], new RegExp(`invite request #${first.request_number} \\(updated\\): Kofi, \\${KOFI} is asking for 10 more invites`));
  assert.match(toMaster[1], /"my whole team at work"/);
  assert.match(toMaster[1], new RegExp(`approve ${first.request_number}`));
  // The model can't file a request with no reason: the schema refuses it.
  const bare = await tool("invite_request_more", { count: 2 }, AMA_C, events);
  assert.notEqual(bare.ok, true);
});

test("approve raises the allowance by the approved count and tells them; decline tells them; a non-master can do neither", async () => {
  const said = [];
  const events = { say: (c, t) => said.push({ c, t }) };
  const r = await tool("invite_request_more", { count: 4, explanation: "cousins" }, KOFI_C, events);
  const refused = await tool("invite_request_decide", { request_number: r.request_number, decision: "approve" }, AMA_C, events);
  assert.equal(refused.blocked, "master_only");
  const peek = await tool("invite_requests_pending", {}, KOFI_C, events);
  assert.equal(peek.blocked, "master_only");
  assert.equal(allowance(KOFI_C), 2);

  const listed = await tool("invite_requests_pending", {}, config.ownerConversation, events);
  assert.deepEqual(listed.requests.map(x => [x.request_number, x.from, x.count, x.explanation]), [[r.request_number, "Kofi", 4, "cousins"]]);

  const ok = await tool("invite_request_decide", { request_number: r.request_number, decision: "approve" }, config.ownerConversation, events);
  assert.equal(ok.decision, "approved");
  assert.equal(allowance(KOFI_C), 6);
  assert.match(said.filter(s => s.c === KOFI_C).at(-1).t, /4 more invites/);
  const twice = await tool("invite_request_decide", { request_number: r.request_number, decision: "approve" }, config.ownerConversation, events);
  assert.notEqual(twice.ok, true, "no longer pending");
  assert.equal(allowance(KOFI_C), 6);

  // A different count than asked for.
  const r2 = await tool("invite_request_more", { count: 50, explanation: "a club" }, AMA_C, events);
  await tool("invite_request_decide", { request_number: r2.request_number, decision: "approve", count: 3 }, config.ownerConversation, events);
  assert.equal(allowance(AMA_C), 5);

  const r3 = await tool("invite_request_more", { count: 2, explanation: "again" }, KOFI_C, events);
  const no = await tool("invite_request_decide", { request_number: r3.request_number, decision: "decline" }, config.ownerConversation, events);
  assert.equal(no.decision, "declined");
  assert.equal(allowance(KOFI_C), 6, "decline changes nothing");
  assert.match(said.filter(s => s.c === KOFI_C).at(-1).t, /wasn't approved/);
  assert.equal(db.pendingInviteRequest(KOFI_C), null, "either way it stops being pending");
});

test("cancel by tool hands back a replacement and says the invite was not lost", async () => {
  const made = await tool("invite_link_create", {}, KOFI_C);
  const out = await tool("invite_link_cancel", { number: made.number }, KOFI_C);
  assert.equal(out.ok, true);
  assert.ok(out.replacement.link);
  assert.notEqual(out.replacement.link, made.link);
  assert.equal(out.invites_left, 2);
  const notMine = await tool("invite_link_cancel", { number: out.replacement.number }, AMA_C);
  assert.notEqual(notMine.ok, true, "nobody cancels anybody else's link");
});

test("an older install's invites-by-number table is moved aside, rows kept, and the new one works", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(dir, "legacy.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE invites (address TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', invited_at INTEGER NOT NULL, invited_by TEXT NOT NULL DEFAULT ''); INSERT INTO invites VALUES ('+15550001111', 'old', 1, 'dm:owner');");
  old.close();
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const db = await import(${JSON.stringify(new URL("../src/db.js", import.meta.url).href)});
    db.upsertAccount({ conversationId: "dm:fake:+1", channel: "fake", address: "+1", name: "X" });
    const made = db.createInvite("dm:fake:+1");
    console.log(JSON.stringify({ m: db.legacyInvitesMigration, ok: made.ok,
      legacy: db.db.prepare("SELECT COUNT(*) AS n FROM invites_by_number_legacy").get().n }));
  `], { env: { ...process.env, REASON_DB_PATH: path }, encoding: "utf8" });
  const r = JSON.parse(out.trim().split("\n").at(-1));
  assert.deepEqual(r, { m: { moved: true, to: "invites_by_number_legacy", rows: 1 }, ok: true, legacy: 1 });
});
