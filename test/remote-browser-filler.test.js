// The saved-login filler on a site the hosted browser covers (src/filler.js + src/remotebrowser.js), with
// the stand-in Google KMS holding the vault key and a made-up login. No browser starts: the hosted launch
// is handed in and fails the way Browserbase can, after the start checks (consent, key, minutes) passed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hosted-filler-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
for (const k of ["REASON_ENCRYPT_REST", "REASON_ENCRYPT_REST2", "REASON_ENCRYPT_REST3"]) process.env[k] = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "4a".repeat(32);
process.env.REASON_TOKEN_KEY ||= "23".repeat(32);
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.REASON_VAULT_KMS;
for (const k of ["REASON_VAULT_KMS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "REASON_REST_KMS_HOST"]) delete process.env[k];
process.env.REASON_SAVED_LOGINS = "on";
process.env.REASON_REMOTE_BROWSER = "owner";
process.env.BROWSERBASE_API_KEY = "bb_test_fake";
process.env.BROWSERBASE_PROJECT_ID = "proj_test";

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
mkdirSync(join(dir, "keys"));
const g = await standInGcp({ dir: join(dir, "keys") });
useStandIn(g);

const sl = await import("../src/savedlogins.js");
const { Secret } = await import("../src/secret.js");
const filler = await import("../src/filler.js");
const remote = await import("../src/remotebrowser.js");
const db = await import("../src/db.js");

const ME = "dm:owner";
db.upsertAccount({ conversationId: ME, channel: "test", address: "+12025550191", name: "Owner", isOperator: true });
const TRIGGER = { kind: "user", messages: [{ role: "user", content: "[Mon 7:02pm] sign in to doordash.com and order my usual" }] };
const S = (s) => new Secret(Buffer.from(s, "utf8"));
after(async () => { await g.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

test("A2: the hosted browser failing after the start checks: the hosted-browser line, never 'not a sign-in page', the login not rested", async () => {
  db.db.prepare("INSERT INTO remote_browser_consent (conversation_id, site, asked_at, consented_at) VALUES (?, 'doordash.com', ?, ?)").run(ME, Date.now(), Date.now());
  const { id } = await sl.saveLogin(ME, {
    site: "doordash.com", label: "DoorDash", signinOrigin: "https://identity.doordash.com", signinPath: "/auth", permission: "standing",
    consentVersion: "saved-login-v1", consentAt: Date.now(), consentCredential: "standin-passkey-credential-1",
  }, { username: S("dd-tester@example.test"), password: S("Stand-in-dd-7Qx!"), totp: null });
  const launches = [];
  for (const code of ["unreachable", "start_timeout", "out_of_minutes"]) {
    const out = await filler.signIn(ME, "doordash.com", {
      trigger: TRIGGER, purpose: "order my usual",
      launch: async (args) => { launches.push(args); throw new remote.RemoteBrowserError(code, "doordash.com"); },
    });
    assert.equal(out.ok, false, code);
    assert.equal(out.hosted_browser, code, JSON.stringify(out).slice(0, 300));
    assert.equal(out.result, `hosted_${code}`);
    assert.equal(out.say_exactly, new remote.RemoteBrowserError(code, "doordash.com").answer.say_exactly);
    assert.doesNotMatch(out.say_exactly, /sign-in page|sign-in form/);
    const row = sl.listLogins(ME).find((r) => r.id === id);
    assert.ok(!row.next_try_at, `${code}: the login is not rested for a failure that was the hosted browser's`);
    assert.notEqual(row.state, "refused");
  }
  // The launch was asked for the hosted browser, by the site.
  assert.ok(launches.every((a) => a.site === "doordash.com" && a.conversationId === ME));
  assert.equal(g.count("decrypt"), 0, "nothing was unwrapped: the login was never typed");
});
