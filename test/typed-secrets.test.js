// Nothing typed into a secret box reaches the model, the log, the ledger, the thread, the memory
// extractor's input or the data export (src/pagesecrets.js; PR 1 of docs/account-access-design.md).
// A fixture page holds a filled password box, a one-time-code box, a card-number box and a box a
// "show password" toggle turned from password to text; ordinary boxes keep their values.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-typed-secrets-"));
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1";
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const browser = await import("../src/browser.js");
const trust = await import("../src/trust.js");
const privacy = await import("../src/privacy.js");
const { exportData } = await import("../src/data.js");
const { scrubPageSecrets, keepableMessages, withoutQueries, HIDDEN } = await import("../src/pagesecrets.js");

const C = "dm:typed-secrets";
const C2 = "dm:typed-secrets-thread";
for (const [id, addr] of [[C, "+12025550181"], [C2, "+12025550182"]]) db.upsertAccount({ conversationId: id, channel: "test", address: addr, name: "Omari", isOperator: true });

// Made-up values: none of these is anybody's.
const PW = "PwSecret-91xq";
const OTP = "482913";
const CARD = "4111 1111 1111 1111";
const TOGGLED = "ToggledSecret-77zz";
const TYPED = "TypedPw-Secret-55";
const PLANTED = "PlantedSecret-123";
const GET_SENT = "GetSentPw-0042";
const APP_PW = "abcd-efgh-ijkl-mnop";
const SECRETS = [GET_SENT, PW, OTP, CARD, CARD.replace(/ /g, ""), TOGGLED, TYPED, PLANTED, APP_PW, APP_PW.replace(/-/g, "")];
const ORDINARY = ["ada@example.com", "Ada Lovelace", "blue shoes"];

const PAGE = `<!doctype html><html><head><title>Sign in</title></head><body>
<form>
<label for="email">Email</label><input type="email" id="email" name="email" value="ada@example.com">
<label for="fullname">Full name</label><input id="fullname" name="fullname" value="Ada Lovelace">
<label for="q">Search</label><input type="search" id="q" name="q" value="blue shoes">
<label for="pw">Password</label><input type="password" id="pw" name="password" value="${PW}">
<label for="otp">Verification code</label><input id="otp" name="otp" autocomplete="one-time-code" inputmode="numeric" value="${OTP}">
<label for="cc">Card number</label><input id="cc" name="cardnumber" autocomplete="cc-number" value="${CARD}">
<label for="k">Key</label><input type="password" id="k" name="k" value="${TOGGLED}">
<script>document.getElementById("k").type = "text";</script>
<button type="button" id="show">Show</button>
</form>
<p>Your code is ${OTP}.</p>
</body></html>`;

let server, url;
const messages = [{ role: "user", content: "[Wed, Sep 30, 2026, 3:00 PM] Omari: sign me in" }];
const call = (name, input) => runTool(name, input, { conversationId: C, messages, judge: async () => ({ verdict: "yes" }) });
const leaks = (value) => { const s = JSON.stringify(value); return SECRETS.filter(x => s.includes(x)).length; };
const byName = (out, re) => (out.elements ?? []).find(e => re.test(e.name ?? ""));

before(async () => {
  server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(PAGE); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/signin?email=ada%40example.com&password=${GET_SENT}`;
});
after(async () => {
  await browser.closeAllBrowsers();
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

test("the page reading says a secret box is filled, never what it holds; ordinary boxes keep their values", async () => {
  const out = await call("browser_open", { url });
  assert.equal(out.ok, true, out.error);
  assert.equal(leaks(out), 0, "no secret value in the browser_open result");
  for (const v of ORDINARY) assert.ok(JSON.stringify(out).includes(v), "an ordinary box keeps its value");
  for (const re of [/^Password/, /^Verification code/, /^Card number/, /^Key/]) {
    const el = byName(out, re);
    assert.ok(el, `the box ${re} is in the reading`);
    assert.equal(el.secret, true);
    assert.equal(el.filled, true);
    assert.equal("value" in el, false);
  }
  const read = await call("browser_read", {});
  assert.equal(leaks(read), 0, "no secret value in the browser_read result");
  assert.ok(JSON.stringify(read).includes("blue shoes"));
});

test("browser_type into a secret box repeats nothing back, and its log line holds nothing; an ordinary box echoes", async () => {
  const read = await call("browser_read", {});
  const pw = byName(read, /^Password/);
  const out = await call("browser_type", { ref: pw.ref, text: TYPED });
  assert.equal(out.secret_box, true);
  assert.equal(leaks(out), 0);
  const line = privacy.forLog(privacy.sealCall("browser_type", { ref: pw.ref, text: TYPED }, out));
  assert.equal(leaks(line), 0, "the tool log line");
  const q = byName(await call("browser_read", {}), /^Search/);
  const ordinary = await call("browser_type", { ref: q.ref, text: "red boots" });
  assert.equal(ordinary.value, "red boots");
  assert.notEqual(ordinary.secret_box, true);
});

test("a picture of the page covers every secret box, the toggled one included", async () => {
  const page = browser.openPage(C);
  const [mask] = await browser.secretBoxesToMask(page);
  assert.equal(await mask.count(), 4);
  const shot = await call("browser_screenshot", {});
  assert.equal(shot.ok, true, shot.error);
  assert.equal(leaks(shot), 0, "a password sent in the address is not repeated");
  assert.ok(String(shot.url).includes("email="), "an ordinary parameter stays");
});

test("the scrubber: a reading that slipped through is cut in the log line, the ledger row, the thread and the export", () => {
  const planted = { ok: true, elements: [
    { ref: "e1", tag: "input", type: "password", name: "Password", value: PLANTED },
    { ref: "e2", tag: "input", type: "search", name: "Search", value: "blue shoes" },
  ] };
  const scrubbed = scrubPageSecrets(planted);
  assert.equal(leaks(scrubbed), 0);
  assert.ok(JSON.stringify(scrubbed).includes("blue shoes"));
  assert.equal(leaks(privacy.forLog(privacy.sealCall("browser_read", {}, planted))), 0, "the tool log line");

  trust.ledgerWrite({ conversationId: C2, action: "browser_submit", input: { ref: "e9", what: "sign in" }, out: planted, target: "fixture" });
  const rows = db.db.prepare("SELECT * FROM action_ledger WHERE conversation_id = ?").all(C2);
  assert.ok(rows.length >= 1, "the ledger row was written");
  assert.equal(leaks(rows), 0, "the ledger row");

  db.saveConversation(C2, [
    { role: "user", content: "connect my apple calendar" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "apple_calendar_connect", input: { email: "ada@example.com", password: APP_PW } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify(planted) }] },
  ]);
  const kept = db.loadConversation(C2);
  assert.equal(leaks(kept), 0, "the saved thread");
  assert.ok(JSON.stringify(kept).includes("blue shoes"), "the ordinary box survives in the thread");
  assert.equal(keepableMessages(kept), kept, "a clean thread is returned as it is");

  const exported = exportData({ conversation: C2, audio: false, files: false });
  assert.equal(leaks(exported), 0, "the data export");
});

test("the Apple app password is sealed in every record of the call and cut from the conversation's kept text", () => {
  assert.ok(privacy.SECRET_TOOLS.has("apple_calendar_connect"));
  const sealedCall = privacy.sealCall("apple_calendar_connect", { email: "ada@example.com", password: APP_PW }, { ok: false, error: "Apple said no" });
  assert.equal(leaks(sealedCall), 0);
  db.writeEvent({ conversationId: C2, role: "user", content: `my app password is ${APP_PW}` });
  privacy.scrubTypedSecret(C2, APP_PW);
  const events = db.recentEvents(C2, { limit: 20 });
  assert.ok(events.length >= 1);
  assert.equal(leaks(events), 0, "the memory extractor reads event_log: the password is gone from it");
});

test("sign-in evidence and page addresses carry no query string", () => {
  assert.equal(withoutQueries("it bounced to https://x.example/login?email=a%40b.c&code=99, which is the sign-in page"), "it bounced to https://x.example/login, which is the sign-in page");
  assert.equal(HIDDEN, "[hidden]");
});

test("the hosted sign-in types only through typeUnseen, and its failure carries no typed text", () => {
  const src = readFileSync(new URL("../src/signin-remote.js", import.meta.url), "utf8");
  assert.equal((src.match(/keyboard\.type\(/g) ?? []).length, 1, "one keystroke path");
  assert.match(src, /async function typeUnseen\(page, text\) \{\s*try \{ await page\.keyboard\.type\(text\); \}\s*catch \{ throw new Error\("typing_failed"\); \}/);
});
