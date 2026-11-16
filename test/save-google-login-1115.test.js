// "Save my Google login", 2026-11-15: the owner (saved logins and social sign-in both on for him)
// was told "I can't save your Google login. Google blocks my browser from signing in to any of its
// pages, and I don't keep passwords anyway." The model had searched for and loaded saved_login_offer,
// then called nothing: every line of its prompt said the opposite. The social sign-in rules opened
// "NO GOOGLE, EVER … Google refuses Reason's browser … never say 'your Google login'" (written before
// the owner decision of 2026-11-13 that keeps the Google login for Continue with Google), the standing
// rules said "you never take / never keep a password", and nothing said the vault was on for him.
//
// Now, only where saved logins are on for the person: a SAVED LOGINS block says Reason keeps logins on
// its own page, "save my X login" is saved_login_offer every time, the Google login is site google.com
// for Continue with Google only and never Google itself (both halves said when the thread is about a
// Google page), and no site is said to block Reason without a tool saying so. The two Google lines of
// the social block are swapped for them, and the saved-login tools are loaded whole. Everybody else's
// prompt and tools are byte for byte what they were.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "save-google-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
for (const k of ["REASON_ENCRYPT_REST", "REASON_ENCRYPT_REST2", "REASON_ENCRYPT_REST3"]) process.env[k] = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "5d".repeat(32);
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NAME = "Omari";
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.REASON_VAULT_KMS;
for (const k of ["REASON_VAULT_KMS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "REASON_REST_KMS_HOST"]) delete process.env[k];
// As live on 2026-11-15.
process.env.REASON_SAVED_LOGINS = "owner";
process.env.REASON_SOCIAL_SIGNIN = "owner";
process.env.REASON_TOOL_DIET = "on";

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
mkdirSync(join(dir, "keys"));
const g = await standInGcp({ dir: join(dir, "keys") });
after(() => { g.close(); rmSync(dir, { recursive: true, force: true }); });
useStandIn(g);

const { systemFor } = await import("../src/agent.js");
const social = await import("../src/socialsignin.js");
const intake = await import("../src/loginintake.js");
const sl = await import("../src/savedlogins.js");
const { toolsFor } = await import("../src/tools.js");
const { mcpToolsFor } = await import("../src/backends/mcp-core.js");
const diet = await import("../src/tooldiet.js");
const refusing = await import("../src/refusing.js");
const { runTool } = await import("../src/tools.js");

const OWNER = { name: "Omari", isOperator: true, conversationId: "dm:owner" };
const OTHER = { name: "Sam", isOperator: false, conversationId: "dm:someone-else" };
const NO_GOOGLE = "NO GOOGLE, EVER";
const GOOGLE_REFUSES = "Google refuses Reason's browser";

test("the owner, as live: saved logins are on for him and the prompt now says so, with no blanket 'no Google'", () => {
  assert.equal(sl.savedLoginsAllowedFor(OWNER.conversationId), true, "fixture: the vault is on for the owner");
  const p = systemFor(OWNER);
  assert.ok(p.includes(intake.SAVED_LOGIN_RULES), "the SAVED LOGINS block is in his prompt");
  assert.ok(p.includes(social.RULES_WITH_VAULT), "the social block, with its Google lines for the vault");
  assert.ok(!p.includes(social.RULES), "not the old social block");
  assert.ok(!p.includes(NO_GOOGLE), "no 'NO GOOGLE, EVER'");
  assert.ok(!p.includes(GOOGLE_REFUSES), "never told Google refuses its browser, with no refusal on record");
  assert.ok(!p.includes("cannot be signed in to here: say that plainly, and never say you will press or use their Google login"));
  // What the reply got wrong, line by line, is now said the other way round.
  assert.match(intake.SAVED_LOGIN_RULES, /you DO keep their logins/);
  assert.match(intake.SAVED_LOGIN_RULES, /Never tell them you don't keep passwords or can't save a login/);
  assert.match(intake.SAVED_LOGIN_RULES, /"save my Google login" is saved_login_offer with site google\.com/);
  assert.match(intake.SAVED_LOGIN_RULES, /admin\.google\.com/);
  assert.match(intake.SAVED_LOGIN_RULES, /say both in your reply: yes, you can keep it for Continue with Google .*and no, you won't sign in to that Google page/);
  assert.match(intake.SAVED_LOGIN_RULES, /Never say Google or any other site blocks you on your own/);
  assert.match(intake.SAVED_LOGIN_RULES, /whatever the thread was about/);
  // No promise that Continue with Google works, and no "Google refuses" without a record.
  assert.match(intake.SAVED_LOGIN_RULES, /Never promise Continue with Google will work/);
  assert.match(social.RULES_WITH_VAULT, /Never promise that works: Google can turn your browser away, and account_signin says when it has/);
  // The chat rule still stands: a password typed into the chat is refused.
  assert.match(p, /You never take a password\./);
  assert.match(intake.SAVED_LOGIN_RULES, /a password typed into the chat is still refused/);
});

test("the owner's tools: saved_login_offer is loaded whole (no search round), and its description covers the Google login", () => {
  diet._resetDiet();
  const listed = mcpToolsFor(OWNER.conversationId);
  const offer = listed.find(t => t.name === "saved_login_offer");
  assert.ok(offer, "visible to him");
  assert.equal(offer._meta?.["anthropic/alwaysLoad"], true, "loaded, not deferred behind ToolSearch");
  for (const n of ["account_signin", "saved_login_forget"]) assert.equal(listed.find(t => t.name === n)?._meta?.["anthropic/alwaysLoad"], true, n);
  assert.ok(diet.statePacks(OWNER.conversationId).includes("saved_logins"));
  assert.match(offer.description, /"save my Google login" is site google\.com/);
  assert.match(offer.description, /even when the thread is about a Google page/);
});

test("'save my Google login' through the tool reaches the save page on accounts.google.com, never google.com itself", async () => {
  // The visit is a stand-in: no browser, no network.
  const at = async (entry) => ({ found: true, url: `${entry.signin_url.replace(/\/$/, "")}/signin`, form: "email_first", followed: false, ms: 1 });
  const out = await intake.offerSaveLink(OWNER.conversationId, "google.com", "Save my Google login", { locate: at });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.careful, true, "the stronger warning");
  // Gmail and the rest are still refused, in code's words.
  const gmail = await intake.offerSaveLink(OWNER.conversationId, "gmail.com", "save my gmail login", { locate: at });
  assert.equal(gmail.ok, false);
  assert.equal(gmail.error, "never_site");
});

test("someone the switches don't cover: today's prompt and tools, byte for byte", () => {
  assert.equal(sl.savedLoginsAllowedFor(OTHER.conversationId), false);
  assert.equal(intake.savedLoginRulesFor(OTHER.conversationId), "");
  const asLive = systemFor(OTHER);
  assert.ok(!asLive.includes("SAVED LOGINS"));
  // The vault switch off everywhere gives them the same bytes as the switch at owner.
  process.env.REASON_SAVED_LOGINS = "off";
  try { assert.equal(systemFor(OTHER), asLive); } finally { process.env.REASON_SAVED_LOGINS = "owner"; }
  // With social sign-in on for everybody but no vault for them, they get the old social block exactly,
  // "NO GOOGLE, EVER" and all.
  process.env.REASON_SOCIAL_SIGNIN = "on";
  try {
    const p = systemFor(OTHER);
    assert.ok(p.includes(social.RULES), "the social block unchanged");
    assert.ok(p.includes(NO_GOOGLE));
    assert.ok(!p.includes(intake.SAVED_LOGIN_RULES));
    assert.equal(social.rulesFor(OTHER.conversationId), social.RULES);
  } finally { process.env.REASON_SOCIAL_SIGNIN = "owner"; }
  // No saved-login tool is shown to them, and no saved_logins pack.
  assert.equal(toolsFor(OTHER.conversationId).some(t => t.name.startsWith("saved_login") || t.name === "account_signin"), false);
  assert.ok(!diet.statePacks(OTHER.conversationId).includes("saved_logins"));
});

test("the vault-variant social block differs from the old one only in its two Google lines", () => {
  const a = social.RULES.split("\n"), b = social.RULES_WITH_VAULT.split("\n");
  assert.equal(a.length, b.length);
  const changed = a.map((l, i) => (l === b[i] ? null : i)).filter(i => i !== null);
  assert.deepEqual(changed, [0, a.findIndex(l => l.startsWith("- BLOCKED SITES"))]);
  assert.ok(!social.RULES_WITH_VAULT.includes(GOOGLE_REFUSES));
  // Owner mode with the vault on for the owner, social on for him: he gets the vault variant.
  assert.equal(social.rulesFor(OWNER.conversationId, { vault: true }), social.RULES_WITH_VAULT);
  assert.equal(social.rulesFor(OWNER.conversationId), social.RULES, "callers that don't say vault get the old block");
});

// The ask before a Google login is saved, read off the site-level refusal record (src/refusing.js).
const at = async (entry) => ({ found: true, url: `${entry.signin_url.replace(/\/$/, "")}/signin`, form: "email_first", followed: false, ms: 1 });
const ask = (input, content = "Save my Google login") => runTool("saved_login_offer", input, {
  conversationId: OWNER.conversationId, messages: [{ role: "user", content }], locateSigninPage: at, kind: "user",
});

test("save my Google login, nothing on record: no claim either way, the save page", async () => {
  refusing._resetRefusals();
  assert.equal(intake.googleSaveWarning(), null);
  const r = await ask({ site: "google.com" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.say_exactly.startsWith(intake.OFFER_SENTENCE));
  assert.doesNotMatch(r.say_exactly, /turn|block|refus|haven't been able/i);
});

test("save my Google login, one refusal on record: the neutral line, as one question, then the page on their yes", async () => {
  refusing._resetRefusals();
  refusing.markRefusing("google.com", "browser_refused");
  const r = await ask({ site: "google.com" });
  assert.equal(r.ok, false);
  assert.equal(r.result, "ask_first");
  assert.equal(r.say_exactly, "I can keep your Google login, but I haven't been able to use it with Google yet, so Continue with Google may not work for you. Still want to save it?");
  assert.equal((r.say_exactly.match(/\?/g) ?? []).length, 1, "one question");
  assert.match(r.note, /still_save true/);
  const yes = await ask({ site: "google.com", still_save: true }, "yes save it");
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.ok(yes.say_exactly.startsWith(intake.OFFER_SENTENCE));
  refusing._resetRefusals();
});

test("save my Google login, Google marked as turning the browser away: said with the day, still theirs to choose", async () => {
  refusing._resetRefusals();
  const now = Date.now();
  refusing.markRefusing("google.com", "browser_refused", now - 12 * 60_000);
  refusing.markRefusing("google.com", "browser_refused", now);
  const seen = refusing.refusingSite("google.com").seen;
  const day = new Date(`${seen}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const r = await ask({ site: "google.com" });
  assert.equal(r.result, "ask_first");
  assert.equal(r.say_exactly, `I can keep your Google login, but Google has been turning my browser away (last on ${day}), so Continue with Google may not work for you yet. Still want to save it?`);
  // On their yes the page is made: not the Netflix-style refusal a marked site gets.
  const yes = await ask({ site: "google.com", still_save: true }, "yes");
  assert.equal(yes.ok, true, JSON.stringify(yes));
  // Another site marked the same way is still refused up front, as before.
  refusing.markRefusing("example-walled.test", "wall", now - 12 * 60_000);
  refusing.markRefusing("example-walled.test", "wall", now);
  const other = await ask({ site: "example-walled.test" }, "save my login for example-walled.test");
  assert.equal(other.result, "refuses_software");
  // admin.google.com is not the Google login: no Google question, refused in code's words.
  const admin = await ask({ site: "admin.google.com" }, "save my login for admin.google.com");
  assert.equal(admin.ok, false);
  assert.equal(admin.refused, true, JSON.stringify(admin));
  assert.notEqual(admin.result, "ask_first");
  assert.match(admin.say_exactly, /Continue with Google/);
  refusing._resetRefusals();
});
