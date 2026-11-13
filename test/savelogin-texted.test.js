// A password sent by text while a save link is open (vault PR 5): never used. The stored copy is a
// placeholder before the message is claimed, no turn runs on it, and code answers with fixed words and
// a fresh link to the page. Narrow: ordinary replies to a link ("perfect!", "thanks") are untouched.
// Made-up messages only; the router runs with a recorded runtime and a fake channel.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "savelogin-texted-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
for (const k of ["REASON_ENCRYPT_REST", "REASON_ENCRYPT_REST2", "REASON_ENCRYPT_REST3"]) process.env[k] = "on";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "48".repeat(32);
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025550142";
process.env.REASON_BURST_QUIET_MS = "0";
delete process.env.REASON_PASSKEY_ORIGIN;
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.REASON_VAULT_KMS;
for (const k of ["REASON_VAULT_KMS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "REASON_REST_KMS_HOST"]) delete process.env[k];
process.env.REASON_SAVED_LOGINS = "owner";
after(() => rmSync(dir, { recursive: true, force: true }));

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
mkdirSync(join(dir, "keys"));
const g = await standInGcp({ dir: join(dir, "keys") });
after(() => g.close());
useStandIn(g);

const intake = await import("../src/loginintake.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025550142";
const C = config.ownerConversation;
db.upsertAccount({ conversationId: C, channel: "fake", address: MASTER, name: "Owner", isOperator: true });

const turns = [];
const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "ok"; } });
const router = new Router({ runtime, judge: async () => ({ verdict: "yes" }) });
const channel = router.register(new FakeChannel({}));
let n = 0;
const say = (body) => router.deliver({ channel: "fake", externalId: `m${++n}`, from: MASTER, text: body, at: clock.now() });
const openLink = () => intake.offerSaveLink(C, "example.test", "pay my example bill", { locate: async () => ({ found: true, url: "https://login.example.test/signin", form: "password" }) });

const PASSWORDS = ["Hunter22!", "xK9#mQ2vLp", "correcthorse42battery", "my password is Tr0ub4dor&3", "password: Sw0rdfish.", "the password is qwerty123"];
const ORDINARY = ["ok", "thanks!!", "perfect", "Perfect!!!", "done", "got it, thanks", "will do", "on it 👍", "what is this link?", "is this safe?",
  "123456", "me@example.test", "https://heyreason.com/web/save-login/abc", "my password is long", "password is wrong", "Wednesday", "2pm?", "B4 dinner"];

test("with no open save link, nothing is taken for a password", async () => {
  for (const t of PASSWORDS) assert.equal(intake.looksLikeTextedPassword(C, t), false, t);
});

test("with a link open: passwords are caught, ordinary replies are not", async () => {
  assert.equal((await openLink()).ok, true);
  for (const t of PASSWORDS) assert.equal(intake.looksLikeTextedPassword(C, t), true, t);
  for (const t of ORDINARY) assert.equal(intake.looksLikeTextedPassword(C, t), false, t);
  // Only what they typed: a note riding in the text is never their password, and never hides one.
  const EFFECT = "[they sent that with the 'slam' screen effect on it — that is them being emphatic, so read it that way]";
  assert.equal(intake.looksLikeTextedPassword(C, "[they sent a file, which you cannot open: password is abc123.pdf]"), false, "a file's name is not their password");
  assert.equal(intake.looksLikeTextedPassword(C, `ok\n${EFFECT}`), false, "an ordinary reply with a note under it");
  for (const t of ["Hunter22!", "the password is qwerty123"]) assert.equal(intake.looksLikeTextedPassword(C, `${t}\n${EFFECT}`), true, `${t} + a note`);
  process.env.REASON_SAVED_LOGINS = "off";
  assert.equal(intake.looksLikeTextedPassword(C, PASSWORDS[0]), false, "switch off: nothing changes");
  process.env.REASON_SAVED_LOGINS = "owner";
});

test("a texted password: fixed words and a fresh link, no turn, and the stored copy is the placeholder", async () => {
  const first = await openLink();
  const oldToken = first.link.split("/").pop();
  turns.length = 0;
  const before = channel.sent.length;
  const out = await say("Hunter22!");
  assert.equal(out.textedPassword, true);
  assert.equal(turns.length, 0, "no model turn runs on it");
  const sent = channel.sent.slice(before).map(m => m.text).join("\n");
  assert.ok(sent.startsWith(intake.TEXTED_PASSWORD_WORDS), sent);
  // The words say plainly it was not read or used, and how to send it if it was not a password (L3).
  assert.match(sent, /didn't read it or use it/i, "it says the message was not read or used");
  assert.match(sent, /looked like a password/i, "it says why");
  assert.match(sent, /wasn't a password, send it again in a sentence/i, "it says how to send it if it wasn't one");
  const link = /https:\/\/heyreason\.com\/web\/save-login\/([A-Za-z0-9_-]{32})/.exec(sent);
  assert.ok(link, sent);
  assert.notEqual(link[1], oldToken);
  assert.equal(await intake.viewFor(oldToken), null, "the old link no longer opens");
  assert.equal((await intake.viewFor(link[1])).state, "open", "the fresh one does, for the same site");
  const { openAny } = await import("../src/restcrypt.js");
  const stored = db.db.prepare("SELECT text FROM inbound_messages WHERE conversation_id = ?").all(C).map(r => openAny(r.text));
  assert.ok(stored.includes(intake.PASSWORD_PLACEHOLDER), "the stored copy is the placeholder");
  const kept = JSON.stringify(stored) + JSON.stringify(db.loadConversation(C));
  assert.equal(kept.includes("Hunter22"), false, "the password is kept nowhere");

  turns.length = 0;
  await say("perfect, thanks");
  assert.equal(turns.length, 1, "an ordinary reply runs a turn as always");
  assert.equal(turns[0].text.includes("perfect"), true);
});
