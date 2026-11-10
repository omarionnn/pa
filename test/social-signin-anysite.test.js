// Social sign-in on ANY site, by its web address (src/signin.js genericEntry, src/tools.js signinSite).
//
// 2026-11-10: the owner texted a real Notion task. Reason said it could not get into his Notion and
// never offered a sign-in: signin_link resolved registry names only (Notion is not one), the signin
// playbook said a link "only works for the sites listed", and capabilities showed no route. What has
// to hold now:
//   1. Where REASON_SOCIAL_SIGNIN reaches the person, signin_link / signin_open / signin_status /
//      signin_provider infer take a site's web address and make the same secure link, with the
//      provider button carried through — Notion, Airbnb, anything with an https address.
//   2. A registry site named by its URL keeps its own entry (Amazon stays Amazon).
//   3. Nobody else gets the generic door: a friend's link to notion.so is refused as before.
//   4. Never this machine's own network: an address that resolves privately is refused, nothing made.
//   5. A bare word, an IP, http, a port or credentials in the URL is not a site.
//   6. The model is told: the rules say any site by its address, never "can't get in"; the playbook
//      and capabilities say so where the flag reaches them, and not otherwise.
//   7. The probe after the link resolves the domain the same way; revoking clears it by domain.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-social-anysite-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.SENDBLUE_FROM_NUMBER = "+1 (415) 555-0199";
delete process.env.REASON_SOCIAL_SIGNIN;

const signin = await import("../src/signin.js");
const remote = await import("../src/signin-remote.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { systemFor } = await import("../src/agent.js");
const social = await import("../src/socialsignin.js");
const playbooks = await import("../src/playbooks.js");
const db = await import("../src/db.js");
const accounts = await import("../src/accounts.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const CONV = "dm:owner";
const THEIRS = `dm:fake:${FRIEND}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  remote.forgetAllRemoteSignins();
  db.db.exec("DELETE FROM accounts; DELETE FROM connected_accounts; DELETE FROM action_ledger; DELETE FROM social_declines; DELETE FROM social_refusals;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  config.publicUrl = "https://reason.example";
  process.env.REASON_SOCIAL_SIGNIN = "owner";
});

const pub = async (url) => ({ ok: true, url });
const call = (name, input, conversationId = CONV, ctx = {}) => runTool(name, input, { conversationId, messages: [], publicUrl: pub, ...ctx });
const linkSeam = (made) => ({ createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/x", good_for_minutes: 10, reachable_from_a_phone: true }; } });

test("genericEntry: a domain or https URL is a site, keyed by its domain; the sign-in page is kept", () => {
  const n = signin.genericEntry("https://www.notion.so/login");
  assert.equal(n.site, "notion.so");
  assert.equal(n.label, "Notion");
  assert.equal(n.signin_url, "https://www.notion.so/login");
  assert.equal(n.signed_in.url, "https://notion.so/");
  assert.equal(n.generic, true);
  assert.deepEqual(n.hosts, ["notion.so"]);
  const bare = signin.genericEntry("airbnb.com");
  assert.equal(bare.site, "airbnb.com");
  assert.equal(bare.label, "Airbnb");
  assert.equal(bare.signin_url, "https://airbnb.com/");
  assert.equal(signin.genericEntry("www.bbc.co.uk").label, "Bbc");
  const figma = signin.genericEntry("app.figma.com/login?email=a@b.c&token=x");
  assert.equal(figma.site, "figma.com", "keyed by the registrable domain");
  assert.deepEqual(figma.hosts, ["figma.com", "app.figma.com"]);
  assert.equal(figma.signin_url, "https://app.figma.com/login", "no query string kept");
  assert.equal(signin.genericEntry("www.bbc.co.uk").site, "bbc.co.uk");
  for (const no of ["co.uk", "notion", "", "http://notion.so", "https://127.0.0.1/login", "https://user:pw@notion.so", "https://notion.so:8443/", "ftp://notion.so", "not a site.com", "https://localhost/"]) {
    assert.equal(signin.genericEntry(no), null, no);
  }
});

test("anyEntryFor: a registry name or a URL on a registry site keeps the registry entry", () => {
  assert.equal(signin.anyEntryFor("amazon").site, "amazon");
  const a = signin.anyEntryFor("https://www.amazon.com/ap/signin");
  assert.equal(a.site, "amazon");
  assert.ok(!a.generic);
  assert.equal(signin.anyEntryFor("notion.so").site, "notion.so");
  assert.equal(signin.anyEntryFor("notion"), null);
  // A cancel-route service's own host keeps its registry entry rather than a second, weaker row.
  const nf = signin.anyEntryFor("https://www.netflix.com/login");
  assert.ok(nf && !nf.generic, "netflix.com resolves to the cancel-route entry");
});

test("owner: signin_link to Notion by its address makes the secure link with the Google button", async () => {
  const made = [];
  const out = await call("signin_link", { site: "https://www.notion.so/login", provider: "google" }, CONV, linkSeam(made));
  assert.equal(out.ok, true);
  assert.equal(out.site, "notion.so");
  assert.equal(out.provider, "google");
  assert.match(out.say, /Notion's own sign-in page/);
  assert.match(out.say, /Google button pressed/);
  assert.equal(made[0].entry.signin_url, "https://www.notion.so/login");
  assert.equal(made[0].provider, "google");
  const ledger = db.db.prepare("SELECT target FROM action_ledger WHERE action = 'signin_link' ORDER BY id DESC LIMIT 1").get();
  assert.match(ledger.target, /notion/);
});

test("owner: a bare name not on the list is told to pass the address, not that it cannot be done", async () => {
  const out = await call("signin_link", { site: "notion", provider: "google" }, CONV, linkSeam([]));
  assert.equal(out.ok, false);
  assert.match(out.error, /web address/);
  assert.match(out.error, /https:\/\/www\.notion\.so\/login/);
});

test("a friend the flag does not reach gets no generic door", async () => {
  const made = [];
  const out = await call("signin_link", { site: "notion.so" }, THEIRS, linkSeam(made));
  assert.equal(out.ok, false);
  assert.match(out.error, /No site called 'notion\.so'/);
  assert.equal(made.length, 0);
  process.env.REASON_SOCIAL_SIGNIN = "";
  const off = await call("signin_link", { site: "notion.so" }, CONV, linkSeam(made));
  assert.equal(off.ok, false);
  assert.equal(made.length, 0);
});

test("an address that resolves to this machine's own network is refused and nothing is made", async () => {
  const made = [];
  const out = await call("signin_link", { site: "intranet.example.com" }, CONV, { ...linkSeam(made), publicUrl: async () => ({ ok: false, why: "it points at this machine's own network" }) });
  assert.equal(out.ok, false);
  assert.equal(out.refused, true);
  assert.equal(made.length, 0);
  const opened = [];
  const w = await call("signin_open", { site: "intranet.example.com" }, CONV, { openSigninWindow: async (a) => { opened.push(a); return { ok: true }; }, publicUrl: async () => ({ ok: false, why: "private" }) });
  assert.equal(w.ok, false);
  assert.equal(opened.length, 0);
});

test("signin_open, infer and signin_status take the address the same way", async () => {
  const opened = [];
  const w = await call("signin_open", { site: "airbnb.com", provider: "apple" }, CONV, { openSigninWindow: async (a) => { opened.push(a); return { ok: true, site: a.entry.site, opened_at: 1 }; } });
  assert.equal(opened[0].entry.site, "airbnb.com");
  assert.equal(opened[0].provider, "apple");
  assert.match(w.say, /Apple button pressed/);

  const inf = await call("signin_provider", { action: "infer", site: "https://www.notion.so/login" }, CONV, { readSigninPage: async (e) => { assert.equal(e.signin_url, "https://www.notion.so/login"); return "Log in\nContinue with Google\nContinue with Apple\nEmail"; } });
  assert.deepEqual(inf.providers_offered, ["google", "apple"]);
  assert.equal(inf.site, "notion.so");

  db.recordSiteSignin(CONV, "notion.so", { state: "signed_in", evidence: "t", provider: "google" });
  const st = await call("signin_status", { site: "notion.so" });
  assert.equal(st.ok, true);
  const row = (st.sites ?? st.signins ?? [st]).flat().find(r => r?.site === "notion.so") ?? st;
  assert.match(JSON.stringify(row), /signed_in/);
});

test("the probe after a link resolves the domain as the link did", async () => {
  const page = {
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
    url: () => "https://www.notion.so/omari-workspace",
    evaluate: async () => "Omari's Notion\nSearch\nUpdates\nSettings & members\nPrivate\nTeamspaces\nGetting started",
  };
  const out = await signin.checkAndRecord(page, CONV, "notion.so", { provider: "google" });
  assert.equal(out.ok, true);
  assert.equal(out.state, "signed_in");
  assert.equal(social.providerOf(CONV, "notion.so"), "google");
  const outPage = { ...page, url: () => "https://www.notion.so/login", evaluate: async () => "Log in\nContinue with Google" };
  assert.equal((await signin.checkAndRecord(outPage, CONV, "notion.so")).state, "signed_out");
});

test("revoking a site signed in to by its address clears it by its domain", async () => {
  const cleared = [];
  const context = { clearCookies: async ({ domain }) => { cleared.push(domain); }, newPage: async () => null };
  const out = await call("account_revoke", { name: "notion.so" }, CONV, { pageFor: async () => ({ context: () => context }) });
  assert.equal(out.ok, true);
  assert.equal(out.status, "revoked");
  assert.ok(cleared.includes(".notion.so") && cleared.includes("www.notion.so"));
  const friend = await call("account_revoke", { name: "notion.so" }, THEIRS);
  assert.equal(friend.ok, false);
  // A URL on a registry site is that site: never a loose generic revoke that leaves its row signed in.
  const amz = [];
  await call("account_revoke", { name: "amazon.com" }, CONV, { pageFor: async () => ({ context: () => ({ clearCookies: async (o) => { amz.push(o); }, newPage: async () => null }) }) });
  assert.equal(amz.length, 0);
});

test("a site signed in to by its address is listed with the rest, by its key", async () => {
  db.recordSiteSignin(CONV, "notion.so", { state: "signed_in", evidence: "t", provider: "google" });
  const all = await call("signin_status", {});
  const n = all.sites.find(r => r.site === "notion.so");
  assert.equal(n.state, "signed_in");
  assert.equal(n.provider, "google");
  assert.ok(n.by_address);
  const one = await call("signin_status", { site: "https://www.notion.so/login" });
  assert.equal(one.sites.length, 1);
  assert.equal(one.sites[0].site, "notion.so");
  assert.match(capabilitiesNow({ conversationId: CONV }).find(c => c.name === "saved_signins").what, /Signed in right now: notion\.so/);
  const theirs = await call("signin_status", {}, THEIRS);
  assert.ok(!theirs.sites.some(r => r.site === "notion.so"));
});

test("the model is told: any site by its address, never 'can't get in' — only where the flag reaches", () => {
  assert.match(social.RULES, /ANY SITE/);
  assert.match(social.RULES, /https:\/\/www\.notion\.so\/login/);
  assert.match(social.RULES, /never "I can't get into it"/);
  assert.match(systemFor(accounts.ownerOf(CONV)), /ANY SITE/);
  assert.doesNotMatch(systemFor(accounts.ownerOf(THEIRS)), /ANY SITE/);
  const pb = playbooks.PLAYBOOKS.find(p => p.name === "signin");
  assert.match(pb.text, /any other site by its web address/);
  const saved = capabilitiesNow({ conversationId: CONV }).find(c => c.name === "saved_signins");
  assert.match(saved.what, /ANY site/);
  assert.match(saved.what, /Notion/);
  assert.doesNotMatch(saved.what, /cannot be done from here/);
  const theirs = capabilitiesNow({ conversationId: THEIRS }).find(c => c.name === "saved_signins");
  assert.doesNotMatch(theirs.what, /ANY site/);
});

test("tool diet: the sign-in tools are loaded whole wherever the rules are in the prompt, first", async () => {
  const diet = await import("../src/tooldiet.js");
  assert.equal(diet.statePacks(CONV)[0], "signin");
  assert.deepEqual(diet.PACKS.signin, ["signin_link", "signin_status", "signin_provider"]);
  assert.ok(!diet.statePacks(THEIRS).includes("signin"));
  process.env.REASON_SOCIAL_SIGNIN = "";
  assert.ok(!diet.statePacks(CONV).includes("signin"));
});

test("the live read of a sign-in page never follows a redirect into this machine's network", async () => {
  social._resetWalls();
  const seen = [];
  // Behaves like the platform's fetch: with redirect "follow" it goes on to the Location itself.
  const fetchImpl = async (url, opts = {}) => {
    seen.push(url);
    if (url.includes("169.254")) return { status: 200, headers: { get: () => null }, text: async () => "Continue with Google" };
    const loc = "http://169.254.169.254/latest/meta-data/";
    if (opts.redirect === "follow") return fetchImpl(loc, opts);
    return { status: 302, headers: { get: (h) => (h === "location" ? loc : null) }, text: async () => "" };
  };
  const out = await social.signinWall(signin.genericEntry("https://evil-redirect.example.com/login"), { fetchImpl });
  assert.equal(out.in, false);
  assert.deepEqual(out.providers_offered, []);
  assert.equal(seen.length, 1, "the private hop is never fetched");
  const ok = await social.signinWall(signin.genericEntry("https://www.notion.so/login"), { fetchImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => "<button>Continue with Google</button><button>Continue with Apple</button> Log in with email" }) });
  assert.deepEqual(ok.providers_offered, ["google", "apple"]);
});

test("buttons drawn by JavaScript: an empty plain read is followed by the rendered page, and the link offers what it shows", async () => {
  const made = [];
  const out = await call("signin_link", { site: "https://www.airbnb.com/login" }, CONV, {
    ...linkSeam(made),
    signinWall: async () => ({ in: true, status: 200, providers_offered: [] }),
    // What the real reader returns: the page's button labels (Notion-style bare names included).
    readSigninPage: async (e) => { assert.equal(e.site, "airbnb.com"); return ["Skip to content", "Continue with Google", "Apple", "Continue with email", "Continue with Facebook", "Get it on Google Play"]; },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(made[0].offered, ["google", "apple", "facebook"]);
  // A wall that said no is not rendered past.
  const made2 = [];
  let rendered = 0;
  await call("signin_link", { site: "https://www.notion.so/login" }, CONV, { ...linkSeam(made2), signinWall: async () => ({ in: false, status: 0, providers_offered: [] }), readSigninPage: async () => { rendered++; return "Continue with Google"; } });
  assert.equal(rendered, 0);
});

test("a bare domain whose front page hides the buttons: its /login is tried, and the link opens there when it has them", async () => {
  const made = [];
  const asked = [];
  const out = await call("signin_link", { site: "airbnb.com" }, CONV, {
    ...linkSeam(made),
    signinWall: async () => ({ in: true, status: 200, providers_offered: [] }),
    readSigninPage: async (e) => { asked.push(e.signin_url); return e.signin_url.endsWith("/login") ? ["Continue", "Continue with Google", "Continue with Apple"] : ["Where to?", "Log in", "Sign up"]; },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(asked, ["https://airbnb.com/", "https://airbnb.com/login"]);
  assert.equal(made[0].entry.signin_url, "https://airbnb.com/login");
  assert.equal(made[0].entry.site, "airbnb.com");
  assert.deepEqual(made[0].offered, ["google", "apple"]);
  // No buttons there either: the front page stays the link's page.
  const made2 = [];
  await call("signin_link", { site: "example-shop.com" }, CONV, { ...linkSeam(made2), signinWall: async () => ({ in: true, status: 200, providers_offered: [] }), readSigninPage: async () => "Email\nPassword" });
  assert.equal(made2[0].entry.signin_url, "https://example-shop.com/");
  assert.deepEqual(made2[0].offered, []);
});

test("the rendered page is read by its buttons' labels: Notion's bare 'Google', Airbnb's aria-only buttons", () => {
  assert.deepEqual(social.providersOnPage(["Skip to content", "Continue", "Google", "ChatGPT", "Apple", "Microsoft", "Passkey", "SSO", "Sign up"]), ["google", "apple", "microsoft"]);
  assert.deepEqual(social.providersOnPage(["Privacy Policy", "Continue", "Continue with Google", "Continue with Apple", "Log in"]), ["google", "apple"]);
  assert.deepEqual(social.providersOnPage(["Get it on Google Play", "Download on the Apple App Store", "Log in"]), [], "app-store badges are not sign-in buttons");
  assert.deepEqual(social.providersOnPage("Continue with Google"), ["google"]);
});

test("the rendered read never runs without the flag, nor for a registry site", async () => {
  let rendered = 0;
  const reader = async () => { rendered++; return ["Continue with Google"]; };
  const wall = async () => ({ in: true, status: 200, providers_offered: [] });
  const made = [];
  await call("signin_link", { site: "amazon" }, CONV, { ...linkSeam(made), signinWall: wall, readSigninPage: reader });
  assert.equal(rendered, 0, "registry site: its static read stands");
  assert.deepEqual(made[0].offered, []);
  process.env.REASON_SOCIAL_SIGNIN = "";
  await call("signin_link", { site: "amazon" }, CONV, { ...linkSeam(made), signinWall: wall, readSigninPage: reader });
  const off = await call("signin_link", { site: "notion.so" }, CONV, { ...linkSeam(made), signinWall: wall, readSigninPage: reader });
  assert.equal(off.ok, false);
  assert.equal(rendered, 0, "flag off: nothing rendered");
});
