// Sites that turn away browsers run by software (src/refusing.js, owner decision 2026-11-13): Netflix
// answered "Something went wrong" to a plain, honest browser from the server and from a home
// connection. Reason says so up front, before any save link, Face ID ask or page; hands the site's own
// page for what they asked; and answers from the site's emails. Nothing here reaches the internet.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "signin-refusing-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
for (const k of ["REASON_ENCRYPT_REST", "REASON_ENCRYPT_REST2", "REASON_ENCRYPT_REST3"]) process.env[k] = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "5c".repeat(32);
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.REASON_VAULT_KMS;
for (const k of ["REASON_VAULT_KMS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "REASON_REST_KMS_HOST"]) delete process.env[k];
process.env.REASON_SAVED_LOGINS = "on";

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
mkdirSync(join(dir, "keys"));
const g = await standInGcp({ dir: join(dir, "keys") });
useStandIn(g);
after(async () => { await g.close(); rmSync(dir, { recursive: true, force: true }); });

const refusing = await import("../src/refusing.js");
const sl = await import("../src/savedlogins.js");
const filler = await import("../src/filler.js");
const rdb = await import("../src/db.js");
const { Secret } = await import("../src/secret.js");
const { runTool } = await import("../src/tools.js");

const ME = "dm:owner";
const DAY = 86_400_000;
const ON = Date.parse("2026-11-13T20:00:00Z");
const S = (s) => new Secret(Buffer.from(s, "utf8"));
const ASK = (words) => ({ kind: "user", messages: [{ role: "user", content: `[Fri 3:55pm] ${words}` }] });
const NO_QUESTION = /\?\s*$|try (it )?anyway|want me to|shall I|should I/im;

function saveNetflix(over = {}) {
  for (const r of sl.listLogins(ME)) sl.removeLogin(ME, r.id);
  return sl.saveLogin(ME, {
    site: "netflix.com", label: "netflix.com", signinOrigin: "https://www.netflix.com", signinPath: "/login", permission: "each_time",
    consentVersion: "saved-login-v1", consentAt: Date.now(), consentCredential: "standin-passkey-credential-1", ...over,
  }, { username: S("refusing-tester@example.test"), password: S("Stand-in-refusing-4Kp!"), totp: null });
}

// ---------------------------------------------------------------- 1. the list: seeded, marked, dated, expiring
test("netflix.com is seeded as refusing (2026-11-13), by any of its hosts; it expires after 30 days; other sites are not on it", () => {
  refusing._resetRefusals();
  for (const s of ["netflix.com", "www.netflix.com", "https://www.netflix.com/login"]) {
    const r = refusing.refusingSite(s, ON);
    assert.equal(r?.site, "netflix.com", s);
    assert.equal(r.label, "Netflix");
    assert.equal(r.seen, "2026-11-13");
    assert.equal(r.evidence, "seed_generic_error_two_networks");
  }
  assert.ok(refusing.refusingSite("netflix.com", ON + 29 * DAY));
  assert.equal(refusing.refusingSite("netflix.com", Date.parse("2026-11-13T12:00:00Z") + 30 * DAY), null, "re-tried after 30 days");
  assert.equal(refusing.refusingSite("hulu.com", ON), null);
  assert.equal(refusing.refusingSite("", ON), null);
});

test("a site marked by the service is believed 30 days, per site (no person), with a fixed evidence word only", () => {
  refusing._resetRefusals();
  assert.equal(refusing.markRefusing("www.acme-stream.test", "a page said so"), null, "only the fixed evidence words");
  const r = refusing.markRefusing("www.acme-stream.test", "generic_error_twice", ON);
  assert.equal(r.site, "acme-stream.test");
  assert.equal(r.source, "live");
  assert.ok(refusing.refusingSite("acme-stream.test", ON + 29 * DAY));
  assert.equal(refusing.refusingSite("acme-stream.test", ON + 30 * DAY), null);
  const cols = rdb.db.prepare("PRAGMA table_info(site_refusals)").all().map((c) => c.name).sort();
  assert.deepEqual(cols, ["evidence", "seen_at", "site"], "nothing personal can be stored");
  // A newer live mark wins over the seed (and restarts its 30 days).
  refusing.markRefusing("netflix.com", "challenge", ON + 20 * DAY);
  assert.equal(refusing.refusingSite("netflix.com", ON + 40 * DAY)?.evidence, "challenge");
  refusing._resetRefusals();
});

// ---------------------------------------------------------------- 3. the exact page, per task
test("deep links: the Netflix page for what they asked, else its account page; a site without a map gets none", () => {
  const cases = [
    ["cancel my netflix", "https://www.netflix.com/cancelplan"],
    ["can you cancel my Netflix membership", "https://www.netflix.com/cancelplan"],
    ["sign out of netflix on all devices", "https://www.netflix.com/manageaccountaccess"],
    ["kick people off my netflix", "https://www.netflix.com/manageaccountaccess"],
    ["when was my last netflix charge", "https://www.netflix.com/BillingActivity"],
    ["update the card on netflix", "https://www.netflix.com/BillingActivity"],
    ["add a kids profile on netflix", "https://www.netflix.com/account/profiles"],
    ["what plan am I on with netflix", "https://www.netflix.com/account/membership"],
    ["downgrade netflix to the ads plan", "https://www.netflix.com/account/membership"],
    ["check my netflix", "https://www.netflix.com/account"],
  ];
  for (const [w, url] of cases) assert.equal(refusing.deepLinkFor("netflix.com", w)?.url, url, w);
  assert.equal(refusing.deepLinkFor("acme-stream.test", "cancel it"), null);
});

// ---------------------------------------------------------------- 2 and 4. the up-front answer
test("the answer: fixed honest words, the page for the task, no question; with mail, the note says answer from their emails now", () => {
  const r = refusing.refusingSite("netflix.com", ON);
  const a = refusing.refusalAnswer(r, { words: "cancel my netflix", mail: true });
  assert.equal(a.result, "refuses_software");
  assert.equal(a.ok, false);
  const lines = a.say_exactly.split("\n");
  assert.equal(lines[0], "Netflix turns away browsers run by software, including mine, so I can't sign in there. It isn't about your login.");
  assert.ok(lines.includes("https://www.netflix.com/cancelplan"));
  assert.match(a.say_exactly, /finish in the Netflix app or your own browser/);
  assert.match(a.say_exactly, /I'm also checking your Netflix emails/);
  assert.doesNotMatch(a.say_exactly, NO_QUESTION);
  assert.doesNotMatch(a.say_exactly, /sav(e|ing) (it )?again|password/i);
  assert.match(a.note, /without asking/);
  assert.match(a.note, /gmail_search/);
  assert.match(a.note, /do not offer to try anyway/);
  const b = refusing.refusalAnswer(r, { words: "cancel my netflix", mail: false });
  assert.doesNotMatch(b.say_exactly, /emails/);
  assert.doesNotMatch(b.note, /gmail_search/);
});

test("account_signin for netflix.com: the up-front answer; no page opened, no Face ID ask, the saved login left as it is", async () => {
  refusing._resetRefusals();
  const { id } = await saveNetflix();
  const rowBefore = sl.listLogins(ME).find((r) => r.id === id);
  let signIns = 0;
  const out = await runTool("account_signin", { site: "netflix.com" }, {
    conversationId: ME, ...ASK("cancel my netflix please"), signIn: async () => { signIns++; return { ok: true, result: "signed_in" }; },
  });
  assert.equal(out.result, "refuses_software", JSON.stringify(out));
  assert.equal(signIns, 0, "the filler never ran");
  assert.match(out.say_exactly, /^Netflix turns away browsers run by software/);
  assert.match(out.say_exactly, /https:\/\/www\.netflix\.com\/cancelplan/);
  assert.doesNotMatch(out.say_exactly, /heyreason|save-login|login-use|Face ID/i);
  assert.doesNotMatch(out.say_exactly, NO_QUESTION);
  const rowAfter = sl.listLogins(ME).find((r) => r.id === id);
  assert.deepEqual([rowAfter.state, rowAfter.next_try_at ?? null, rowAfter.fail_count ?? 0], [rowBefore.state, rowBefore.next_try_at ?? null, rowBefore.fail_count ?? 0]);
});

test("the filler itself answers up front for a refusing site: nothing launched, even for an each-time login", async () => {
  refusing._resetRefusals();
  await saveNetflix();
  let launches = 0;
  const out = await filler.signIn(ME, "netflix.com", { trigger: ASK("what plan am I on with netflix"), purpose: "what plan am I on with netflix", launch: async () => { launches++; throw new Error("no"); } });
  assert.equal(out.result, "refuses_software");
  assert.equal(launches, 0);
  assert.match(out.say_exactly, /account\/membership/);
});

test("saved_login_offer for netflix.com: the up-front answer and no save link made", async () => {
  refusing._resetRefusals();
  const n0 = rdb.rawPrepare("SELECT COUNT(*) AS n FROM login_intake").get().n;
  const out = await runTool("saved_login_offer", { site: "netflix.com" }, { conversationId: ME, ...ASK("sign in to netflix and check my billing") });
  assert.equal(out.result, "refuses_software", JSON.stringify(out));
  assert.match(out.say_exactly, /BillingActivity/);
  assert.doesNotMatch(out.say_exactly, /save-login|heyreason/);
  assert.equal(rdb.rawPrepare("SELECT COUNT(*) AS n FROM login_intake").get().n, n0, "no link row");
});

test("a site not on the list is unchanged: saved_login_offer goes on to its own checks", async () => {
  refusing._resetRefusals();
  const out = await runTool("saved_login_offer", { site: "chase.com" }, { conversationId: ME, ...ASK("pay my chase bill") });
  assert.notEqual(out.result, "refuses_software");
});
