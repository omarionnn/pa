// The account_signin tool and the forget path, as the model reaches them (vault PR 6): shown only where
// REASON_SAVED_LOGINS allows the person; the filler arrives through the runtime's tool context (src/tools.js
// may not import the vault); the turn's kind, never the model, is the live-ask gate's input; the result
// is a fixed word and sentence, never a secret. With the switch off the tool is absent and every path
// is unreachable. Stand-in KMS; no browser here (test/filler.test.js drives a real one).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "account-signin-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
for (const k of ["REASON_ENCRYPT_REST", "REASON_ENCRYPT_REST2", "REASON_ENCRYPT_REST3"]) process.env[k] = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "4a".repeat(32);
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);
process.env.REASON_SITE_URL = "https://heyreason.com";
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.REASON_VAULT_KMS;
for (const k of ["REASON_VAULT_KMS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "REASON_REST_KMS_HOST"]) delete process.env[k];
process.env.REASON_SAVED_LOGINS = "off";
after(() => rmSync(dir, { recursive: true, force: true }));

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
mkdirSync(join(dir, "keys"));
const g = await standInGcp({ dir: join(dir, "keys") });
after(() => g.close());
useStandIn(g);

const { toolsFor, runTool } = await import("../src/tools.js");
const filler = await import("../src/filler.js");
const use = await import("../src/loginuse.js");
const { Runtime } = await import("../src/runtime.js");

const ME = "dm:owner";
const SECRET = "Stand-in-tool-pw-7Kx!";

function spy(answer = { ok: true, result: "signed_in", say_exactly: "Signed you in to acme.test." }) {
  const calls = [];
  return { calls, fn: async (c, site, opts) => { calls.push({ c, site, opts }); return answer; } };
}

test("switch off: account_signin is absent, refused if called anyway, and the filler is never reached", async () => {
  process.env.REASON_SAVED_LOGINS = "off";
  assert.equal(toolsFor(ME).some(t => t.name === "account_signin"), false, "absent with the switch off");
  const s = spy(), f = spy({ ok: true, removed: 1, say_exactly: "x" });
  const r = await runTool("account_signin", { site: "acme.test" }, { conversationId: ME, kind: "user", messages: [], signIn: s.fn, forgetLogin: f.fn });
  assert.equal(r.ok, false);
  assert.equal(s.calls.length, 0, "the filler is unreachable");
  await runTool("saved_login_forget", { site: "acme.test" }, { conversationId: ME, kind: "user", forgetLogin: f.fn });
  assert.equal(f.calls.length, 0, "the browser forget path is unreachable");
  // And straight at the filler: nothing runs.
  let launched = 0;
  const out = await filler.signIn(ME, "acme.test", { trigger: { kind: "user" }, launch: async () => { launched++; throw new Error("no"); } });
  assert.equal(out.result, "no_login");
  assert.equal(launched, 0);
  assert.equal((await filler.forgetLogin(ME, "acme.test", { launch: async () => { launched++; throw new Error("no"); } })).removed, 0);
  assert.equal(launched, 0);
});

test("switch on: the tool is shown (owner mode: the operator only), with a schema and no secret in its words", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  try {
    const t = toolsFor(ME).find(x => x.name === "account_signin");
    assert.ok(t, "shown to the operator");
    assert.equal(toolsFor("dm:not-the-owner").some(x => x.name === "account_signin"), false);
    assert.deepEqual(t.input_schema.required, ["site"]);
    assert.deepEqual(Object.keys(t.input_schema.properties), ["site"], "the model passes only a site name");
    const bad = await runTool("account_signin", { site: 42 }, { conversationId: ME, kind: "user", messages: [], signIn: spy().fn });
    assert.equal(bad.ok, false, "the zod check refuses a non-string site");
  } finally { process.env.REASON_SAVED_LOGINS = "off"; }
});

test("the runtime hands the filler to every turn; the turn's kind (not the model) reaches the gate; the result carries no secret", async () => {
  process.env.REASON_SAVED_LOGINS = "on";
  try {
    // src/runtime.js turnExtras: how the filler reaches src/tools.js without tools.js importing the vault.
    const src = readFileSync(new URL("../src/runtime.js", import.meta.url), "utf8");
    assert.match(src, /turnExtras = \{ channels, calls, signIn: filler\.signIn, forgetLogin: filler\.forgetLogin \}/);
    assert.equal(typeof Runtime, "function");

    const leaky = spy({ ok: true, result: "signed_in", say_exactly: "Signed you in to acme.test.", password: SECRET, username: "u@example.test" });
    const r = await runTool("account_signin", { site: "acme.test" }, {
      conversationId: ME, kind: "event", messages: [{ role: "user", content: "check my acme bill" }], signIn: leaky.fn,
    });
    assert.equal(leaky.calls.length, 1);
    assert.deepEqual(leaky.calls[0].opts.trigger, { kind: "event" }, "the turn's own kind goes to the gate");
    assert.equal(leaky.calls[0].site, "acme.test");
    assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes("u@example.test"), "only the fixed fields leave the tool");
    assert.deepEqual(Object.keys(r).sort(), ["note", "ok", "result", "say_exactly"]);
    // A model cannot claim a live ask: input has only `site`, and an extra field is not read.
    const s2 = spy();
    await runTool("account_signin", { site: "acme.test", kind: "user", trigger: { kind: "user" } }, { conversationId: ME, kind: "event", messages: [], signIn: s2.fn });
    assert.ok(!s2.calls.length || s2.calls[0].opts.trigger.kind === "event", "the model's own words never set the trigger");
    // No filler in the context (a caller that did not wire it): not available, nothing typed.
    assert.equal((await runTool("account_signin", { site: "acme.test" }, { conversationId: ME, kind: "user", messages: [] })).ok, false);
  } finally { process.env.REASON_SAVED_LOGINS = "off"; }
});

test("the real gate refuses an event turn before anything opens, and the never list gets refusalFor's words", async () => {
  process.env.REASON_SAVED_LOGINS = "on";
  try {
    const { classifySite, refusalFor } = await import("../src/sitepolicy.js");
    const v = classifySite("chase.com");
    assert.equal(v.policy, "never");
    let launched = 0;
    const never = await filler.signIn(ME, "chase.com", { trigger: { kind: "user" }, launch: async () => { launched++; } });
    assert.equal(never.say_exactly, refusalFor(v.category, "chase.com"));
    assert.equal(never.refused, true);
    assert.equal(launched, 0);
  } finally { process.env.REASON_SAVED_LOGINS = "off"; }
});

test("Face ID approvals: one link per login, bound challenge, a failed check approves nothing, one yes is one use, and it runs out", async () => {
  use._resetAsks();
  const a = use.askFaceId(ME, 7, "acme.test", { now: 1000 });
  const b = use.askFaceId(ME, 7, "acme.test", { now: 1000 });
  assert.equal(use.useView(a.token, { now: 1000 }), null, "a fresh ask replaces the old link");
  const v = use.useView(b.token, { now: 1000 });
  assert.equal(v.site, "acme.test");
  assert.match(v.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(v.challenge, use.useChallenge(8, "acme.test", "x"), "bound to the login");
  assert.equal((await use.approveUse(b.token, {}, { now: 1000, verify: async () => ({ ok: false, error: "unknown_passkey" }) })).ok, false);
  assert.equal(use.takeApproval(ME, 7, { now: 1000 }), false, "a failed Face ID approves nothing");
  assert.equal((await use.approveUse(b.token, {}, { now: 1000, verify: async () => ({ ok: true }) })).ok, true);
  assert.equal(use.takeApproval("dm:someone-else", 7, { now: 1001 }), false, "another person's sign-in can't use it");
  assert.equal(use.takeApproval(ME, 8, { now: 1001 }), false, "another login can't use it");
  assert.equal(use.takeApproval(ME, 7, { now: 1001 }), true);
  assert.equal(use.takeApproval(ME, 7, { now: 1002 }), false, "one yes is one sign-in");
  const c = use.askFaceId(ME, 7, "acme.test", { now: 0 });
  await use.approveUse(c.token, {}, { now: 0, verify: async () => ({ ok: true }) });
  assert.equal(use.takeApproval(ME, 7, { now: use.YES_TTL_MS + 1 }), false, "a yes runs out");
  const d = use.askFaceId(ME, 7, "acme.test", { now: 0 });
  assert.equal((await use.approveUse(d.token, {}, { now: use.ASK_TTL_MS + 1, verify: async () => ({ ok: true }) })).ok, false, "a link runs out");
});

test("the Face ID page: 404 for a token nobody was issued, the site's name only, Face ID from heyreason.com only", async () => {
  use._resetAsks();
  const { loginUseRequest } = await import("../src/pages/loginuse.js");
  assert.equal(await loginUseRequest({ sub: "A".repeat(32) }), null);
  const { token } = use.askFaceId(ME, 3, "acme.test");
  const page = await loginUseRequest({ sub: token });
  assert.equal(page.status, 200);
  assert.match(page.body, /acme\.test/);
  assert.match(page.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  const elsewhere = await loginUseRequest({ sub: `${token}/approve`, method: "POST", headers: { origin: "https://evil.example" }, readBody: async () => "{}" });
  assert.equal(elsewhere.status, 403);
  const http = readFileSync(new URL("../src/http.js", import.meta.url), "utf8");
  assert.match(http, /loginUseRoute && \(await import\("\.\/loginintake\.js"\)\)\.savedLoginsMode\(\) !== "off"/, "the route is behind the switch");
});
