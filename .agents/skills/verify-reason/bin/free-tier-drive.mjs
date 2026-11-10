#!/usr/bin/env node
// The monthly free tier (src/plan.js, REASON_FREE_TIER=monthly, owner 2026-11-09), driven down the REAL
// router and the REAL inbound-call TwiML on a fresh database: a walk-in's 20 conversations answered,
// the 21st's first text answered by code with one line + the pay link (no model turn), a 2nd text in it
// left; two calls through, the 3rd hears one line + hangs up and the link is texted; a 6-minute end on a
// free call; a trial user offered no invites; the 31st sign-up in an hour sent to the access list.
// No model (a stub turn), no phone, nothing leaves the machine. Prints the texts and "all ok" / "FAILED".
//
//   REASON_DB_PATH=$(mktemp -d)/ft.db node .agents/skills/verify-reason/bin/free-tier-drive.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-freetier-drive-"));
process.env.REASON_DB_PATH ||= join(dir, "ft.db");
process.env.REASON_DATA_DIR ||= dir;
Object.assign(process.env, {
  REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner",
  REASON_OWNER_NUMBER: "+12025551234", REASON_MASTER_NUMBER: "+12025551234", REASON_TEST_NUMBERS: "",
  REASON_PUBLIC_URL: "https://reason.example.test", REASON_TOKEN_KEY: process.env.REASON_TOKEN_KEY || "55".repeat(32),
  REASON_BURST_QUIET_MS: "0", REASON_UNDO_SECONDS: "0", REASON_RECORDING_ROOT: join(dir, "rec"),
  REASON_PAYWALL: "on", REASON_FREE_TIER: "monthly", REASON_PAYWALL_SHIP_TS: "2026-10-31T00:00:00Z",
  STRIPE_SECRET_KEY: "sk_test_drive", STRIPE_PRICE_ID: "price_drive", STRIPE_PAYMENT_LINK_URL: "https://buy.stripe.test/reason",
  SENDBLUE_API_KEY: "", SENDBLUE_API_SECRET: "", ANTHROPIC_API_KEY: "",
});

const plan = await import("../../../../src/plan.js");
const access = await import("../../../../src/access.js");
const { invitesOpenFor } = await import("../../../../src/tools.js");
const { Runtime } = await import("../../../../src/runtime.js");
const { Router } = await import("../../../../src/channels/router.js");
const { FakeChannel } = await import("../../../../src/channels/fake.js");
const gl = await import("../../../../src/calls/gptlive.js");
const db = await import("../../../../src/db.js");
const { clock, config } = await import("../../../../src/config.js");

// plan.js spaces bubbles with unref'd timers (the live server's sockets keep it alive); so does this.
const keepAlive = setInterval(() => {}, 1000);
let failed = 0;
const step = (name, ok, detail = "") => { console.log(`${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; };
const MIN = 60_000;
db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });

// ---- texts: 20 conversations, then the 21st (a walk-in: auto-admit on, as on live)
config.autoAdmit = true; config.signupsPerHour = 30;
const num = "+13475550101", c = `dm:fake:${num}`;
const turns = [];
const runtime = new Runtime({ runTurn: async ({ text }) => { turns.push(text); return "on it"; } });
const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
const channel = router.register(new FakeChannel({ number: "+16562167455" }));
runtime.turnExtras.channels = router;
const text = (body) => router.deliver({ channel: "fake", externalId: `m${Math.random()}`, from: num, text: body, at: clock.now() });
await text("hey");
for (let i = 1; i < 20; i++) { clock.skip(31 * MIN); await text(`msg ${i}`); }
step("20 conversations answered by the model", turns.length === 20 && plan.status(c).status === "trial", plan.opsLabel(c));
const before = channel.sent.length;
clock.skip(31 * MIN); await text("can you find me a dentist");
const over = channel.sent.slice(before).filter(m => m.to === num).map(m => m.text);
console.log(`     them: can you find me a dentist\n${over.map(t => `     reason: ${t}`).join("\n")}`);
step("21st: no model turn, one line + the link", turns.length === 20 && over.length === 2 && /20 free conversations/.test(over[0]) && /^https:\/\/buy\.stripe\.test/.test(over[1]));
clock.skip(2 * MIN); await text("hello??");
step("a 2nd text in that conversation: nothing", channel.sent.slice(before).filter(m => m.to === num).length === 2 && turns.length === 20);

// ---- calls: 2 through, the 3rd one line + texted link
const caller = "+13475550102", cc = `dm:fake:${caller}`;
db.upsertAccount({ conversationId: cc, channel: "fake", address: caller, name: "Kofi", isOperator: false });
Object.assign(config, { callVoice: "gptlive", twilioSid: "AC_drive", twilioToken: "twilio-drive", twilioFrom: "+16465550000", openaiKey: "sk-drive" });
const via = { sent: [], get: (n) => (n === "fake" ? { status: () => ({ status: "live" }) } : null), statuses: () => [{ name: "fake", status: "live" }], send: async (m) => { via.sent.push(m); return { ok: true }; } };
let sid = 0;
const ring = () => {
  const params = { CallSid: `CA${++sid}`, From: caller, To: "+16465550000" };
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  return gl.inboundTwiml({ rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) }, router: via });
};
const okCalls = [ring(), ring()].every(o => /<Stream/.test(o.body));
const third = ring();
for (let t = 0; t < 150 && via.sent.length < 2; t++) await new Promise(r => setTimeout(r, 20));
const said = third.body.match(/<Say[^>]*>([^<]*)<\/Say>/)?.[1] ?? "";
console.log(`     (3rd call) reason says: ${said} [hangs up]\n${via.sent.map(m => `     reason texts: ${m.text}`).join("\n")}`);
step("2 calls through; the 3rd: one line, hang up, link texted", okCalls && !/<Stream/.test(third.body) && /<Hangup\/>/.test(third.body) && via.sent.length === 2 && /^https:/.test(via.sent[1].text));
db.upsertAccount({ conversationId: "dm:fake:+13475550103", channel: "fake", address: "+13475550103", name: "Esi", isOperator: false });
step("5:00 wrap-up, 6:00 close", plan.callLimitSeconds("dm:fake:+13475550103") === 300 && plan.FREE_CALL_GRACE_SECONDS === 60);

// ---- invites
step("a trial user is offered no invites", invitesOpenFor(c) === false && invitesOpenFor("dm:owner") === true);

// ---- sign-ups: 30 an hour, the 31st to the access list
config.autoAdmit = true; config.signupsPerHour = 30;
clock.skip(2 * 60 * MIN);
let admitted = 0, last = null;
for (let i = 0; i < 31; i++) {
  last = access.handleUnknown({ channel: "fake", address: `+1347666${String(1000 + i)}`, text: "hey" });
  if (last.action === "auto_admitted") admitted++;
}
console.log(`     (31st sign-up) reason: ${last.toThem}`);
step("30 admitted, the 31st queued with the access-list text", admitted === 30 && last.action === "ask_master" && /heyreason\.com\/access/.test(last.toThem));

clearInterval(keepAlive);
console.log(failed ? `FAILED (${failed})` : "all ok");
process.exit(failed ? 1 : 0);
