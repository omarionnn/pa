// Six-digit codes, bound to the host they are typed on (2026-10-25, Omari).
//
// A code Reason texts so a new browser can open a page — a private page, the status page, an event
// page — is six digits, leading zeros kept, and the text ends in Apple's domain-bound line
// (`@host #code` after a blank line) naming the host the box actually lives on, so an iPhone offers
// it above the keyboard there and nowhere else. The box is one field that takes it typed, pasted or
// autofilled. Expiry, once-only, wrong-code and resend limits are the ones the gate already had.
//
// No API key, no network, no browser.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-codes-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_OPS_URL = "https://site.example.test/ops";

const access = await import("../src/pages/access.js");
const events = await import("../src/events.js");
const ops = await import("../src/ops.js");
const { renderCodeGate, codeInputAttrs } = await import("../src/pages/render.js");
const { renderGate, renderSignin } = await import("../src/pages/event.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

after(() => rmSync(dir, { recursive: true, force: true }));

test("a code is six digits drawn uniformly, and a leading zero stays part of it", () => {
  const seen = new Set();
  let leadingZero = 0;
  for (let i = 0; i < 5000; i++) {
    const c = access.newCode();
    assert.match(c, /^[0-9]{6}$/);
    if (c[0] === "0") leadingZero++;
    seen.add(c);
  }
  assert.ok(leadingZero > 250, `about one in ten starts with 0 (${leadingZero}/5000)`);
  assert.ok(seen.size > 4900, "and they are not repeating");
});

test("what was typed, pasted or autofilled is read as the code", () => {
  assert.equal(access.typedCode("012345"), "012345");
  assert.equal(access.typedCode(" 012 345 "), "012345");
  assert.equal(access.typedCode("012-345"), "012345");
  assert.equal(access.typedCode(`Your Reason code is 012345, to open "x" on that browser.\n\n@files.example.test #012345`), "012345", "a whole pasted text");
  assert.equal(access.typedCode("ab3d9k"), "AB3D9K", "a letter code from before the switch, for its last fifteen minutes");
  assert.equal(access.typedCode("1234567"), "1234567", "seven digits are not a six-digit code");
});

test("the page code text: readable first line, blank line, then @host #code for the pages host", () => {
  const line = access.codeLine({ id: "abc", title: "Gift ideas" }, "012345");
  const [first, blank, last, ...rest] = line.split("\n");
  assert.match(first, /^Your Reason code is 012345, to open "Gift ideas" on that browser\. Good for 15 minutes\. If that wasn't you, ignore this/);
  assert.equal(blank, "");
  assert.equal(last, "@files.example.test #012345", "host only: no scheme, no path, no port");
  assert.equal(rest.length, 0, "and it is the last line");
});

test("the status page's code is bound to the host the status page is opened on", () => {
  const line = access.codeLine({ id: "ops", title: "Reason status" }, "000042", { host: access.codeHost(ops.opsUrl()) });
  assert.ok(line.endsWith("\n\n@site.example.test #000042"), line);
});

test("an event sign-in code is bound to the event page's host", () => {
  const line = events.signinCodeLine({ name: "Rooftop" }, "903117", { what: "open" });
  assert.match(line, /^Your Reason code is 903117, to open "Rooftop" on that browser\./);
  assert.ok(line.endsWith("\n\n@files.example.test #903117"), line);
});

test("no host, no bound line — the code still goes", () => {
  assert.equal(access.boundTo("", "123456"), "");
  assert.equal(access.codeHost("not a url"), "");
});

test("a pasted whole text opens the page once; a second try with the same code does not", () => {
  const page = { id: "p-paste" };
  const { code } = access.issueCode(page.id);
  const pasted = `Your Reason code is ${code}, to open "x" on that browser.\n\n@files.example.test #${code}`;
  assert.equal(access.trySubmittedCode({ page, code: pasted }).ok, true);
  assert.equal(access.trySubmittedCode({ page, code }).ok, false, "single use");
});

test("expired codes fail, and five wrong codes lock the page whatever is typed after", () => {
  const page = { id: "p-limits" };
  const { code } = access.issueCode(page.id);
  const real = clock.now;
  try {
    clock.now = () => real() + access.CODE_TTL_MS + 1000;
    assert.equal(access.trySubmittedCode({ page, code }).ok, false, "past fifteen minutes");
  } finally { clock.now = real; }
  const fresh = access.issueCode(page.id).code;
  const wrong = fresh === "000000" ? "000001" : "000000";
  for (let i = 0; i < access.MAX_FAILED_ATTEMPTS - 1; i++) access.trySubmittedCode({ page, code: wrong });
  const locked = access.trySubmittedCode({ page, code: fresh });
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, "rate_limited");
});

test("resends are capped at three in the window", () => {
  const page = { id: "p-resend", title: "x" };
  for (let i = 0; i < access.MAX_CODES_SENT; i++) assert.equal(access.requestCode(page).ok, true);
  assert.equal(access.requestCode(page).reason, "too_many_sent");
});

test("the code is stored hashed, never as the digits", () => {
  const { id, code } = access.issueCode("p-hashed");
  const row = db.db.prepare("SELECT code FROM page_codes WHERE id = ?").get(id);
  assert.notEqual(row.code, code);
  assert.match(row.code, /^sha256:/);
});

test("every box a code goes in is one numeric one-time-code field of six", () => {
  const attrs = codeInputAttrs();
  for (const want of [/autocomplete="one-time-code"/, /inputmode="numeric"/, /pattern="\[0-9\]\*"/, /maxlength="6"/, /name="code"/, /onpaste=/]) assert.match(attrs, want);
  const boxes = [
    renderCodeGate({ canSend: true, sent: true }),
    renderCodeGate({}),
    renderGate({ ev: { public_id: "e1", name: "Rooftop" }, token: "t", sent: true }),
    renderSignin({ ev: { public_id: "e1", name: "Rooftop", description: "" }, number: "+12025550123", sent: true }),
  ];
  for (const html of boxes) {
    const inputs = html.match(/<input[^>]*name="code"[^>]*>/g) ?? [];
    assert.equal(inputs.length, 1, "exactly one code box");
    assert.match(inputs[0], /autocomplete="one-time-code"[^>]*inputmode="numeric"/);
    assert.doesNotMatch(html, /six-character/);
  }
});

test("the box's paste handler, run: a whole text or a spaced code lands as the six digits", () => {
  const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(codeInputAttrs())[1];
  const onpaste = new Function("event", attr("onpaste"));
  const oninput = new Function(attr("oninput"));
  const paste = (text) => {
    const box = { value: "" };
    let prevented = false;
    onpaste.call(box, { clipboardData: { getData: () => text }, preventDefault: () => { prevented = true; } });
    assert.ok(prevented, "the browser's own paste, which maxlength would cut, does not happen");
    return box.value;
  };
  assert.equal(paste(`Your Reason code is 012345, to open "x".\n\n@files.example.test #012345`), "012345");
  assert.equal(paste("012 345"), "012345");
  assert.equal(paste("  098765  "), "098765");
  const typed = { value: "01a2 3-45" };
  oninput.call(typed);
  assert.equal(typed.value, "012345");
});

test("a letter code minted before the switch still opens, for the minutes it has left", () => {
  const now = clock.now();
  db.db.prepare("INSERT INTO page_codes (page_id, code, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run("p-legacy", db.pageCodeHash("AB3D9K"), now, now + 60_000);
  assert.equal(access.trySubmittedCode({ page: { id: "p-legacy" }, code: " ab3d9k " }).ok, true);
});

/** 40 wrong event sign-in tries for one person, spread over the day, never 20 in 15 minutes, from many browsers. */
function strangersGuess(conversationId) {
  const real = clock.now;
  try {
    for (let i = 0; i < events.SIGNIN_WRONG.perPersonDay; i++) {
      const at = real() - (events.SIGNIN_WRONG.dayMs - 60_000) + i * 30 * 60_000;
      clock.now = () => at;
      events.trySigninCode({ conversationId, code: "000000", actor: `b${i}` });
    }
  } finally { clock.now = real; }
}

test("event sign-in: past 40 strangers' wrong codes in a day, the person's own fresh code still opens on the browser that asked (lead 25)", () => {
  const conversationId = "dm:fake:+12025550188";
  strangersGuess(conversationId);
  const { code } = access.requestCode({ id: events.signinKey(conversationId), title: "x" }, { host: "", bound: events.signinBinding?.("mine") });
  assert.equal(events.trySigninCode({ conversationId, code, actor: "mine" }).ok, true);
});

test("event sign-in past the ceiling: the code works only from the browser that asked, and one wrong try there ends it", () => {
  const conversationId = "dm:fake:+12025550189";
  strangersGuess(conversationId);
  const key = events.signinKey(conversationId);
  const { code } = access.requestCode({ id: key, title: "x" }, { host: "", bound: events.signinBinding?.("mine") });
  assert.equal(events.trySigninCode({ conversationId, code, actor: "elsewhere" }).ok, false, "not from another browser");
  assert.equal(events.trySigninCode({ conversationId, code: code === "000000" ? "000001" : "000000", actor: "mine" }).ok, false);
  assert.equal(events.trySigninCode({ conversationId, code, actor: "mine" }).ok, false, "one wrong try past the ceiling ends the code");
});
