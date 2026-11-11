// Invite links into the web setup (REASON_INVITE_START, src/invites.js + src/websetup.js), through the
// real router, outbox and database:
//
//   the invite page's button → heyreason.com/start/?invite=<token>; opening it, and starting a setup
//     from it, spends nothing
//   the setup's first text → the invite spent and the account made in one go → the web welcome (the
//     line picking up from the setup with "invited by Omari" in it, the seven cards, "what would you
//     like help with first?"), never a separate "You're in" line; their first reply → the turn → the card
//   spent exactly once: two setups from one link, two phones → one account, the other told it was claimed
//   the invitee is free (plan.grandfathered, the paywall and the monthly tier never reach them)
//   the old texted claim code still works with the switch on; the switch off → nothing changes
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-invite-start-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_TOKEN_KEY = "44".repeat(32);
delete process.env.REASON_ONBOARDING;
delete process.env.REASON_TEST_NUMBERS;

const ob = await import("../src/onboarding.js");
const welcome = await import("../src/welcome.js");
const ws = await import("../src/websetup.js");
const invites = await import("../src/invites.js");
const plan = await import("../src/plan.js");
const amazon = await import("../src/amazonconnect.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const remote = await import("../src/signin-remote.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const LINE = "+16562167455";
let n = 0;
const newNumber = () => `+1415559${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;
const ENV = ["REASON_INVITE_START", "REASON_INVITE_START_URL", "REASON_WEB_SETUP", "REASON_WELCOME_CARDS", "REASON_INTRO_AMAZON", "REASON_PAYWALL", "REASON_FREE_TIER"];

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  remote.forgetAllRemoteSignins();
  ws.resetLimits();
  ws.forgetNameLines();
  for (const k of ENV) delete process.env[k];
  process.env.REASON_INVITE_START = "on";
  process.env.REASON_INVITE_START_URL = "https://start--textreason.netlify.app";
  process.env.REASON_WEB_SETUP = "on";
  process.env.REASON_WELCOME_CARDS = "on";
  process.env.REASON_INTRO_AMAZON = "on";
  config.autoAdmit = true;
  config.testNumbers = [];
  config.onboarding = "on";
  config.onboardingNumbers = [];
  config.onboardingNudgeMin = 240;
  config.onboardingCardGapMs = 0;
  config.publicUrl = "https://reason.example.test";
  db.db.exec(`DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages;
    DELETE FROM outbox; DELETE FROM timers; DELETE FROM web_setups; DELETE FROM invites; DELETE FROM invite_allowances; DELETE FROM plan;`);
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.backfillInviteAllowances();
});
after(() => { for (const k of ENV) delete process.env[k]; });

function harness(reads = {}) {
  const turns = [], toInviter = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "on it"; } });
  const realSay = runtime.say.bind(runtime);
  runtime.say = (c, t, m) => { toInviter.push({ c, t }); return realSay(c, t, m); };
  const ask = async ({ prompt }) => {
    const said = prompt.replace(/^Their text, verbatim:\n/, "");
    const r = reads[said];
    if (!r) return { error: "no stated read" };
    return { value: { name: "", card_name: "", reply: "", name_line: "", amazon: "", ...r } };
  };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async () => {}, amazonLink: async () => "https://x.test/s/link" } });
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { router, channel, turns, toInviter };
}
const text = (from, body) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now() });
const to = (h, num) => h.channel.sent.filter(m => m.to === num);
const show = (m) => m.carousel ? `[carousel ${m.carousel.length}]` : m.media?.file ? `[picture ${m.media.filename}]` : m.media?.url ? `${m.text} [card]` : m.text;
const PICS = welcome.CARDS.map(c => `[picture ${c.key}.jpg]`);

async function api(method, path, { cookie = "", body = null } = {}) {
  const res = await ws.request({ method, path, query: {}, headers: { cookie: cookie ? `rs_setup=${cookie}` : "", host: "reason.example.test" }, remoteAddress: "1.2.3.4", readBody: async () => body ? JSON.stringify(body) : "" });
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}
async function newSetup({ invite = null, user = "kofi", reasonName = "jarvis" } = {}) {
  const made = await api("POST", "/api/new", { body: invite ? { invite } : null });
  const cookie = /rs_setup=([^;]+)/.exec(String(made.headers["Set-Cookie"] ?? ""))?.[1];
  await api("POST", `/api/${made.json.id}`, { cookie, body: { user, reasonName } });
  return { ...made.json, cookie };
}
const ownerLink = () => {
  const out = db.createInvite(config.ownerConversation);
  assert.ok(out.ok, "owner can make a link");
  return out.invite;
};
const inviteRow = (id) => db.db.prepare("SELECT * FROM invites WHERE id = ?").get(id);
const ownerLeft = () => db.inviteAllowance(config.ownerConversation);
const INVITED_INTRO = "hey kofi, Jarvis here. you're in, invited by Omari. picking up from your setup, here's what i can do for you";

// ---------- the link ----------

test("invite page: the button leads into /start with the token; the texted code stays as the second way; opening spends nothing", () => {
  const inv = ownerLink();
  const before = JSON.stringify(inviteRow(inv.id));
  const page = invites.inviteRequest({ token: inv.token, lineNumber: LINE });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(`href="https://start--textreason.netlify.app/start/?invite=${inv.token}"`), "button → /start with the token");
  assert.match(page.body, /Set up your Reason/);
  assert.ok(page.body.includes(invites.formatCode(inv.claim_code)), "the texted code is still shown");
  assert.equal(JSON.stringify(inviteRow(inv.id)), before, "opening the page wrote nothing");
});

test("invite page with the switch off: the sms button with the code prefilled, exactly as before", () => {
  delete process.env.REASON_INVITE_START;
  const inv = ownerLink();
  const page = invites.inviteRequest({ token: inv.token, lineNumber: LINE });
  assert.ok(!page.body.includes("/start/?invite="));
  assert.ok(page.body.includes(`sms:${LINE}?&amp;body=`) || page.body.includes(`sms:${LINE}?&body=`));
  assert.match(page.body, /Text Reason to join/);
});

test("a setup started from the link carries the invite and spends nothing; the page is told who invited them, never a price", async () => {
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  assert.deepEqual(s.invite, { from: "Omari", state: "unused" });
  assert.equal(db.db.prepare("SELECT invite_id FROM web_setups WHERE id = ?").get(s.id).invite_id, inv.id);
  assert.equal(inviteRow(inv.id).state, "unused", "nothing spent on open");
  assert.equal(ownerLeft(), 2, "allowance untouched");
  const view = await api("GET", `/api/${s.id}`, { cookie: s.cookie });
  assert.deepEqual(view.json.invite, { from: "Omari", state: "unused" });
  assert.ok(!/\$|price|plan|trial|month/i.test(JSON.stringify({ made: s, view: view.json })), "no price or plan in anything the page reads");
  // A token that is not a link, or a spent invite: the setup goes on as anybody's.
  const junk = await newSetup({ invite: "x".repeat(32) });
  assert.equal(junk.invite, undefined);
  db.db.prepare("UPDATE invites SET state = 'canceled' WHERE id = ?").run(inv.id);
  const late = await newSetup({ invite: inv.token });
  assert.deepEqual(late.invite, { from: "Omari", state: "canceled" });
  assert.equal(db.db.prepare("SELECT invite_id FROM web_setups WHERE id = ?").get(late.id).invite_id, null);
});

// ---------- the path: invite → /start → web welcome ----------

test("invite → /start → first text: invite spent with the account, the web welcome with 'invited by' in its first line, no extra line, inviter told", async () => {
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  const num = newNumber();
  const out = await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.equal(out.onboarding, "awaiting_first");
  assert.deepEqual(to(h, num).map(show), [INVITED_INTRO, ...PICS, welcome.HELP_FIRST]);
  assert.ok(!to(h, num).some(m => /^You're in/.test(m.text ?? "")), "no separate You're in line");
  const acct = db.getAccount(conv(num));
  assert.equal(acct.invited_by, config.ownerConversation);
  assert.equal(acct.name, "Kofi");
  assert.equal(acct.contact_card_name, "Jarvis");
  assert.equal(acct.welcome_cards, "web");
  assert.equal(inviteRow(inv.id).state, "redeemed");
  assert.equal(inviteRow(inv.id).redeemed_by, conv(num));
  assert.equal(ownerLeft(), 1, "one invite spent");
  assert.equal(db.inviteAllowance(conv(num)), 0, "joiners start with none");
  assert.deepEqual(h.toInviter.map(x => [x.c, x.t]), [[config.ownerConversation, "Kofi just joined with your invite 🎉"]]);
  assert.equal(h.turns.length, 0);
  // Their first reply: the turn answers it, then the contact card under the page's name, then the Amazon offer.
  const before = to(h, num).length;
  await h.router.deliver(text(num, "book a table for two friday at 8"));
  assert.equal(h.turns.length, 1);
  assert.deepEqual(to(h, num).slice(before).map(show), ["on it", `${ob.WEB_CARD} [card]`, amazon.OFFER]);
});

test("invite setup gets in even with auto-admit off: no access queue, like a texted invite code", async () => {
  config.autoAdmit = false;
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  const num = newNumber();
  await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.ok(db.getAccount(conv(num)), "account made");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM access_requests").get().n, 0);
  assert.equal(to(h, num)[0].text, INVITED_INTRO);
});

test("onboarding not covering them: the invite's own 'You're in, invited by Omari.' line goes instead, once", async () => {
  config.onboarding = "off";
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  const num = newNumber();
  await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.equal(to(h, num).filter(m => m.text === "You're in, invited by Omari.").length, 1);
  assert.equal(inviteRow(inv.id).state, "redeemed");
});

// ---------- spent exactly once ----------

test("one link, two setups, two phones: one account, the other told it was already claimed and not let in", async () => {
  const h = harness();
  const inv = ownerLink();
  const a = await newSetup({ invite: inv.token });
  const b = await newSetup({ invite: inv.token, user: "ama", reasonName: "friday" });
  const p1 = newNumber(), p2 = newNumber();
  await h.router.deliver(text(p1, ws.firstText({ user: "kofi", reasonName: "jarvis", code: a.code })));
  const lost = await h.router.deliver(text(p2, ws.firstText({ user: "ama", reasonName: "friday", code: b.code })));
  assert.equal(lost.admitted, false);
  assert.equal(db.getAccount(conv(p2)), null, "the loser has no account");
  assert.deepEqual(to(h, p2).map(m => m.text), [invites.ALREADY_CLAIMED]);
  assert.equal(inviteRow(inv.id).redeemed_by, conv(p1));
  assert.equal(ownerLeft(), 1, "spent once");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE invited_by = ?").get(config.ownerConversation).n, 1);
  // The same first text delivered twice (a provider retry) spends nothing more and sends nothing twice.
  const sentBefore = to(h, p1).length;
  await h.router.deliver(text(p1, ws.firstText({ user: "kofi", reasonName: "jarvis", code: a.code })));
  assert.equal(ownerLeft(), 1);
  assert.ok(!to(h, p1).slice(sentBefore).some(m => m.text === INVITED_INTRO));
});

test("the texted code and a setup racing for one link: whoever is first wins, the other is told", async () => {
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  const p1 = newNumber(), p2 = newNumber();
  await h.router.deliver(text(p1, invites.joinText(inv.claim_code)));
  assert.equal(inviteRow(inv.id).redeemed_by, conv(p1));
  await h.router.deliver(text(p2, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.equal(db.getAccount(conv(p2)), null);
  assert.deepEqual(to(h, p2).map(m => m.text), [invites.ALREADY_CLAIMED]);
});

test("a canceled invite between setup and text: told it was canceled, nothing admitted", async () => {
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  db.cancelInvite(config.ownerConversation, inv.id);
  const num = newNumber();
  await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.equal(db.getAccount(conv(num)), null);
  assert.deepEqual(to(h, num).map(m => m.text), [invites.CANCELED]);
});

test("a setup code without the setup's names spends nothing (falls to the normal way in)", async () => {
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  const num = newNumber();
  await h.router.deliver(text(num, `hey there · ${s.code}`));
  assert.equal(inviteRow(inv.id).state, "unused");
  assert.equal(db.getAccount(conv(num))?.invited_by ?? null, null);
});

// ---------- free ----------

test("the invitee is never charged: grandfathered (free for good) under the paywall, the old trial and the monthly tier", async () => {
  // The paywall flipped on long before either of them arrived: only the invite can make one free.
  process.env.REASON_PAYWALL = "on";
  db.opsSet("paywall_on_since", 1);
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  const num = newNumber();
  await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.equal(plan.grandfathered(conv(num)), true);
  assert.equal(plan.status(conv(num)).status, "free");
  process.env.REASON_FREE_TIER = "monthly";
  assert.equal(plan.status(conv(num)).status, "free");
  // Somebody who walked in on their own from a plain setup is not.
  const other = await newSetup({ user: "ama", reasonName: "friday" });
  const p2 = newNumber();
  await h.router.deliver(text(p2, ws.firstText({ user: "ama", reasonName: "friday", code: other.code })));
  assert.notEqual(plan.status(conv(p2)).status, "free");
});

// ---------- old links, and the switch ----------

test("old links still work with the switch on: the texted claim code joins with the old welcome", async () => {
  const h = harness();
  const inv = ownerLink();
  const num = newNumber();
  await h.router.deliver(text(num, invites.joinText(inv.claim_code)));
  assert.equal(to(h, num)[0].text, "You're in, invited by Omari.");
  assert.equal(db.getAccount(conv(num)).invited_by, config.ownerConversation);
  assert.equal(inviteRow(inv.id).state, "redeemed");
});

test("switch off: the setup API ignores the invite, the setup's first text is a plain web welcome, the invite untouched", async () => {
  delete process.env.REASON_INVITE_START;
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  assert.equal(s.invite, undefined);
  const num = newNumber();
  await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.equal(to(h, num)[0].text, "hey kofi, Jarvis here. picking up from your setup, here's what i can do for you");
  assert.equal(inviteRow(inv.id).state, "unused");
});

test("welcome cards off: the hello names the inviter instead", async () => {
  process.env.REASON_WELCOME_CARDS = "off";
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  const num = newNumber();
  await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.equal(to(h, num)[0].text, "hey kofi, good to meet you. you're in, invited by Omari");
});
