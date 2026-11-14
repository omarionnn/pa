// Which way a plain "sign in to X" goes (owner decision 2026-11-13), decided in code inside signin_status:
//   1. the vault is on for them and a saved login exists for that site (a saved Google login counts for a
//      site whose stored route is Continue with Google) → account_signin, and the link is not offered first;
//   2. otherwise → the link, as today;
//   3. the offer to save a login comes only after a link sign-in that ended signed in, once per site;
//   4. a site marked as refusing software-driven browsers keeps its up-front answer, over 1 and 2;
//   5. account_signin ending in a step only a person can do → the link for that one attempt, in fixed words;
//   6. people without the vault: exactly today's signin_status results.
// Stand-in KMS, a fake browser for the link, no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "signin-route-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Owner";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
for (const k of ["REASON_ENCRYPT_REST", "REASON_ENCRYPT_REST2", "REASON_ENCRYPT_REST3"]) process.env[k] = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "5e".repeat(32);
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);
process.env.REASON_SITE_URL = "https://heyreason.com";
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.REASON_VAULT_KMS;
for (const k of ["REASON_VAULT_KMS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "REASON_REST_KMS_HOST"]) delete process.env[k];
process.env.REASON_SAVED_LOGINS = "on";
after(() => rmSync(dir, { recursive: true, force: true }));

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
mkdirSync(join(dir, "keys"));
const g = await standInGcp({ dir: join(dir, "keys") });
after(() => g.close());
useStandIn(g);

const sl = await import("../src/savedlogins.js");
const li = await import("../src/loginintake.js");
const refusing = await import("../src/refusing.js");
const remote = await import("../src/signin-remote.js");
const sites = await import("../src/sites.js");
const { Secret } = await import("../src/secret.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const ME = "dm:owner";
const S = (s) => new Secret(Buffer.from(s, "utf8"));
const on = () => { process.env.REASON_SAVED_LOGINS = "on"; };
const off = () => { process.env.REASON_SAVED_LOGINS = "off"; };

beforeEach(() => {
  on();
  clock.reset();
  remote.forgetAllRemoteSignins();
  sl.deleteAllFor(ME);
  refusing._resetRefusals();
  db.db.exec("DELETE FROM timers; DELETE FROM accounts; DELETE FROM threads; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: ME, channel: "fake", address: "+12025551234", name: "Owner", isOperator: true });
  config.publicUrl = "https://reason.example";
  config.remoteSigninSettleMs = 0;
});

function save(site, origin, label = site) {
  return sl.saveLogin(ME, {
    site, label, signinOrigin: origin, signinPath: "/signin", permission: "each_time",
    consentVersion: "saved-login-v1", consentAt: Date.now(), consentCredential: "standin-passkey-credential-1",
  }, { username: S("route-tester@example.test"), password: S("Stand-in-route-9Qz!"), totp: null });
}
const turn = (words) => ({ conversationId: ME, kind: "user", messages: [{ role: "user", content: words }] });
const status = (site) => runTool("signin_status", site ? { site } : {}, turn(site ? `sign in to ${site}` : "what am i signed in to"));

// ---------------------------------------------------------------- rule 1
test("rule 1: a saved login for the site → signin_status answers account_signin, and no link is offered first", async () => {
  await save("amazon.com", "https://www.amazon.com", "Amazon");
  for (const asked of ["amazon", "amazon.com"]) {
    const r = await status(asked);
    assert.match(r.sign_in_with, /^account_signin with site 'amazon\.com'\. They saved a login for it, so you sign in yourself, with their Face ID when the site is set to ask for it\. Do not send a sign-in link first/);
    assert.equal(r.saved_login, "amazon.com");
    assert.ok(!("by_link" in r) && !("remote" in r), "the link route is not on the answer");
    if (asked === "amazon") {
      assert.equal(r.sites.length, 1);
      assert.equal(r.sites[0].saved_login, "amazon.com");
      assert.match(r.sites[0].how_to_sign_in, /^account_signin with site 'amazon\.com'/);
    } else assert.match(r.how_to_sign_in, /^account_signin with site 'amazon\.com'/);
    assert.ok(!/Call signin_link/.test(JSON.stringify(r)), "nothing says to call signin_link");
    if (asked === "amazon") assert.match(r.saved_logins, /account_signin/);
  }
  // The whole list: the row for the saved site says account_signin; another site keeps the link.
  const all = await status("");
  const amazon = all.sites.find(s => s.site === "amazon");
  const delta = all.sites.find(s => s.site === "delta");
  assert.match(amazon.how_to_sign_in, /^account_signin with site 'amazon\.com'/);
  assert.ok(!("saved_login" in delta) && !("sign_in_with" in delta));
  assert.ok("by_link" in all, "a list keeps the general route");
  // A site known only by its domain (no listed site): the saved login answers; without one, as before.
  await save("xfinity.com", "https://login.xfinity.com", "Xfinity");
  const x = await status("xfinity.com");
  assert.match(x.sign_in_with, /^account_signin with site 'xfinity\.com'/);
  sl.deleteAllFor(ME);
  const none = await status("xfinity.com");
  off();
  assert.deepEqual(none, await status("xfinity.com"));
  on();
});

test("rule 1, Google route: a site whose stored route is Continue with Google counts once their Google login is saved", async () => {
  sl.setSigninRoute(ME, "united.com", "google");
  const before = await status("united");
  assert.ok(!("sign_in_with" in before), "no Google login saved yet: the link, as for any site");
  assert.ok("by_link" in before);
  await save("google.com", "https://accounts.google.com", "Google");
  const r = await status("united");
  assert.match(r.sign_in_with, /^account_signin with site 'united\.com'\. They saved a login for it \(it signs in through Continue with Google, with their saved Google login\)/);
  assert.equal(r.saved_login_via, "google");
  assert.ok(!("by_link" in r));
  // The Google login itself is never a route to Google's own sites.
  assert.deepEqual(li.domainsOf(null, "gmail.com"), []);
  assert.equal(li.savedLoginRoute(ME, { signin_url: "https://accounts.google.com/" }), null);
});

test("rule 1, recheck: a signed-out reading answers account_signin for a saved site", async () => {
  await save("amazon.com", "https://www.amazon.com", "Amazon");
  const ctx = { ...turn("sign in to amazon"), pageFor: async () => ({}), checkAndRecord: async () => ({ ok: true, state: "signed_out", why: "the sign-in page showed", checked_url: "https://www.amazon.com/gp/css/order-history", landed: "https://www.amazon.com/ap/signin" }) };
  const r = await runTool("signin_status", { site: "amazon", recheck: true }, ctx);
  assert.equal(r.state, "signed_out");
  assert.match(r.how_to_sign_in, /^account_signin with site 'amazon\.com'/);
  assert.ok(!("remote" in r));
  off();
  const plain = await runTool("signin_status", { site: "amazon", recheck: true }, ctx);
  assert.ok(!("sign_in_with" in plain) && !("saved_login" in plain) && "remote" in plain, "vault off: today's recheck answer");
});

// ---------------------------------------------------------------- rule 2 and rule 6
test("rule 2: the vault on but no saved login for the site → exactly the vault-off answer (the link)", async () => {
  await save("amazon.com", "https://www.amazon.com", "Amazon");
  const withVault = await status("delta");
  off();
  const without = await status("delta");
  assert.deepEqual(withVault, without);
  assert.ok("by_link" in without);
});

test("rule 6: people without the vault get today's signin_status results, byte for byte, saved login or not", async () => {
  await save("amazon.com", "https://www.amazon.com", "Amazon");
  refusing.markRefusing("delta.com", "generic_error_twice");
  off();
  const named = JSON.stringify(await status("amazon"));
  const list = JSON.stringify(await status(""));
  const refused = JSON.stringify(await status("delta"));
  on();
  sl.deleteAllFor(ME);
  refusing._resetRefusals();
  off();
  assert.equal(named, JSON.stringify(await status("amazon")));
  assert.equal(list, JSON.stringify(await status("")));
  assert.equal(refused, JSON.stringify(await status("delta")));
  assert.ok(!/sign_in_with|saved_login|refuses_software|account_signin/.test(named + list + refused));
  // Owner mode: somebody who is not the owner is a person without the vault.
  process.env.REASON_SAVED_LOGINS = "owner";
  assert.equal(li.savedLoginRoute("dm:someone-else", { signin_url: "https://www.amazon.com/" }), null);
});

// ---------------------------------------------------------------- rule 4
test("rule 4: a site marked as refusing software keeps its up-front answer, saved login or not", async () => {
  await save("amazon.com", "https://www.amazon.com", "Amazon");
  refusing.markRefusing("amazon.com", "generic_error_twice");
  const r = await status("amazon");
  assert.equal(r.refuses_software, true);
  assert.match(r.say_exactly, /^amazon\.com turns away browsers run by software, including mine, so I can't sign in there\. It isn't about your login\./);
  assert.ok(!("sign_in_with" in r) && !("by_link" in r));
  assert.equal(r.sites[0].refuses_software, true);
  assert.equal(r.sites[0].how_to_sign_in, undefined);
  // No saved login: the refusal still wins over the link.
  refusing.markRefusing("delta.com", "generic_error_twice");
  const d = await status("delta");
  assert.equal(d.refuses_software, true);
  assert.ok(!("by_link" in d));
});

test("a site whose sign-in page is walled on record keeps that answer even with a saved login: no account_signin into a wall", async () => {
  await save("opentable.com", "https://www.opentable.com", "OpenTable");
  const r = await status("opentable");
  assert.ok(!("sign_in_with" in r) && !("saved_login" in r.sites[0]));
  assert.equal(r.sites[0].signin_here, "blocked");
});

// ---------------------------------------------------------------- rule 5
function linkSeam() {
  const made = [];
  return { made, createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/once", good_for_minutes: 10, reachable_from_a_phone: true }; } };
}
const filler = (out) => async () => out;

test("rule 5: a step only a person can do → the link for that one attempt, in fixed words, no question", async () => {
  const words = {
    blocked: "amazon.com showed a check that only a person can do (like a picture puzzle or a \"confirm it's you\" step) when I used your saved login.",
    needs_approval: "amazon.com wants you to approve this sign-in yourself.",
    needs_authenticator: "amazon.com wants a code from your authenticator app, which I can't get.",
    code_not_found: "amazon.com sent a code that didn't reach me in time.",
  };
  for (const [result, line] of Object.entries(words)) {
    remote.forgetAllRemoteSignins();
    const seam = linkSeam();
    const r = await runTool("account_signin", { site: "amazon.com" }, { ...turn("sign in to amazon"), ...seam, signIn: filler({ ok: false, result, say_exactly: "the filler's own words" }) });
    assert.equal(seam.made.length, 1, `${result}: one link made`);
    assert.equal(seam.made[0].entry.site, "amazon");
    assert.equal(r.say_exactly, `${line} Here's a link to sign in to amazon.com yourself this once:\nhttps://reason.example/s/once`);
    assert.ok(!/want me|shall i|should i|\?$/i.test(r.say_exactly), "said, not asked");
    assert.equal(r.person_step, true);
    assert.match(r.note, /Do not ask whether they want it/);
  }
});

test("rule 5: a wall before the form, a texted code, a sign-in, a Face ID ask → no link", async () => {
  for (const out of [
    { ok: false, result: "blocked", walled: true, say_exactly: "amazon.com turned my browser away before its sign-in form showed" },
    { ok: false, result: "needs_code_sms", say_exactly: "amazon.com texted a code" },
    { ok: false, result: "needs_face_id", say_exactly: "approve here" },
    { ok: true, result: "signed_in", say_exactly: "Signed you in to amazon.com." },
  ]) {
    const seam = linkSeam();
    const r = await runTool("account_signin", { site: "amazon.com" }, { ...turn("sign in to amazon"), ...seam, signIn: filler(out) });
    assert.equal(seam.made.length, 0, `${out.result}: no link`);
    assert.equal(r.say_exactly, out.say_exactly);
    assert.ok(!("person_step" in r));
  }
});

// ---------------------------------------------------------------- rule 3
const AMAZON_EMAIL_STEP = {
  url: "https://www.amazon.com/ap/signin?openid.mode=checkid_setup",
  text: "Sign in or create account\nEnter mobile number or email\nContinue",
  fields: [{ x: 0.12, y: 0.3, w: 0.76, h: 0.06, tag: "input", type: "email", ac: "", name: "email", id: "ap_email_login", label: "Enter mobile number or email", im: "", ml: 0, len: 0, focused: false }],
};
function fakeLaunch() {
  const page = {
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x2a]),
    evaluate: async () => AMAZON_EMAIL_STEP,
    mouse: { click: async () => {}, wheel: async () => {} },
    keyboard: { type: async () => {}, press: async () => {} },
    goBack: async () => {},
  };
  return async () => ({ page, close: async () => {} });
}
function provedCookie(conversationId) {
  const t = `sess-${conversationId}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, t, { conversationId });
  return `reason_page=${t}`;
}
const req = (token, action, { method = "GET", cookie = "" } = {}) =>
  remote.remoteRequest({ token, action, method, headers: cookie ? { cookie } : {}, query: {}, readBody: async () => "" });
/** One link sign-in to Amazon that ends signed in; → the note Reason is woken with. */
async function linkSignin(state = "signed_in", { provider = "" } = {}) {
  remote.forgetAllRemoteSignins();
  db.db.exec("DELETE FROM timers");
  const timers = { set: () => ({}), clear: () => {} };
  const out = remote.createRemoteSignin({
    conversationId: ME, entry: sites.site("amazon"), launch: fakeLaunch(), timers, provider,
    check: async () => ({ ok: true, state, why: "the order history page loaded" }),
  });
  const token = out.url.split("/").pop();
  const r = await req(token, "start", { method: "POST", cookie: provedCookie(ME) });
  const cookie = String(r.headers["Set-Cookie"] ?? "").split(";")[0];
  await req(token, "done", { method: "POST", cookie });
  return db.db.prepare("SELECT note FROM timers WHERE conversation_id = ? ORDER BY id").all(ME).map(x => x.note).join("\n");
}
const OFFER = "Want me to save this login, so next time I can sign in to Amazon for you myself?";

test("rule 3: the save offer comes once, only after a link sign-in that ended signed in", async () => {
  const signedOut = await linkSignin("signed_out");
  assert.ok(!signedOut.includes(OFFER), "not after a link that did not sign in");
  const first = await linkSignin("signed_in");
  assert.match(first, /Amazon says they ARE signed in now/);
  assert.ok(first.includes(`add this one line, word for word: "${OFFER}" If they say yes, call saved_login_offer with site 'amazon.com'. If they say no or don't answer, drop it: it is never asked again.`));
  const second = await linkSignin("signed_in");
  assert.match(second, /Amazon says they ARE signed in now/);
  assert.ok(!second.includes(OFFER), "never repeated, whatever they answered");
});

test("rule 3: no offer for a site with a saved login, through a provider button, a refusing site, or without the vault", async () => {
  await save("amazon.com", "https://www.amazon.com", "Amazon");
  assert.ok(!(await linkSignin("signed_in")).includes(OFFER), "a saved login already");
  sl.deleteAllFor(ME);
  assert.equal(li.saveOfferFor(ME, sites.site("amazon"), { provider: "apple" }), null, "a sign-in through a provider button");
  refusing.markRefusing("amazon.com", "generic_error_twice");
  assert.ok(!(await linkSignin("signed_in")).includes(OFFER), "a refusing site");
  refusing._resetRefusals();
  off();
  const plain = await linkSignin("signed_in");
  assert.ok(!plain.includes(OFFER) && !/saved_login_offer/.test(plain), "no vault: today's note");
  on();
  // Never-list sites are never offered.
  assert.equal(li.saveOfferFor(ME, { label: "Chase", signin_url: "https://secure.chase.com/" }), null);
  // And the offer is still owed for Amazon: nothing above spent it.
  assert.ok((await linkSignin("signed_in")).includes(OFFER));
});

// ---------------------------------------------------------------- the words the model reads
test("tool words: the link is the default only where there is no saved login; save is offered only after a sign-in or when asked", () => {
  const tools = toolsFor(ME);
  const d = (n) => tools.find(t => t.name === n)?.description ?? "";
  assert.match(d("signin_link"), /the default when someone asks to sign in to a site, except where signin_status answers `sign_in_with` account_signin/);
  assert.match(d("signin_status"), /When it answers `sign_in_with`, they saved a login for that site: sign in with account_signin, not a link\./);
  assert.match(d("saved_login_offer"), /Call it only when they ask to save a login, or say yes to the one-line offer to save it that comes after a sign-in through a link\. Never before their first sign-in to a site/);
  assert.ok(!/a job they just asked for needs them signed in to a password site/.test(d("saved_login_offer")));
  assert.match(d("account_signin"), /when they ask to sign in to a site they saved a login for \(signin_status answers `sign_in_with`\)/);
});
