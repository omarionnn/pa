// Golden for the first-text PR: with REASON_WEB_SETUP off, the same inputs give the same outputs on main and on
// this branch. Run from a checkout root: node scripts/first-text-golden.mjs (prints a sha256 over everything seen).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "golden-ft-"));
Object.assign(process.env, { REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: dir, REASON_PROFILE_ROOT: join(dir, "p"), REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York",
  REASON_CONVERSATION: "dm:owner", REASON_BURST_QUIET_MS: "0", REASON_MASTER_NUMBER: "+12025551234", REASON_PUBLIC_URL: "https://reason.example.test", REASON_TOKEN_KEY: "44".repeat(32),
  REASON_INVITE_START: "on", REASON_TEXT_ME_FIRST: "on" });
delete process.env.REASON_WEB_SETUP;
const imp = (p) => import(join(root, p));
const ws = await imp("src/websetup.js");
const db = await imp("src/db.js");
const ops = await imp("src/ops.js");
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { FakeChannel } = await imp("src/channels/fake.js");
const { ConsoleChannel } = await imp("src/channels/console.js");
const { makeDeliver } = await imp("src/deliver.js");
const { clock, config } = await imp("src/config.js");
config.autoAdmit = false; config.onboarding = "on"; config.onboardingCardGapMs = 0;
db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
db.backfillInviteAllowances();
const seen = [];
const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { seen.push(["turn", conversationId, text]); return "on it"; } });
const realSay = runtime.say.bind(runtime);
runtime.say = (c, t, m) => { seen.push(["say", c, t]); return realSay(c, t, m); };
const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask: async () => ({ error: "x" }), sleep: async () => {}, amazonLink: async () => "https://x.test" } });
const ch = router.register(new FakeChannel({ number: "+16562167455" }));
runtime.turnExtras.channels = router;
runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
const inv = db.createInvite(config.ownerConversation).invite;
let k = 0;
const say = async (from, text) => seen.push(["deliver", from, JSON.stringify(await router.deliver({ channel: "fake", externalId: `g${k++}`, from, text, at: clock.now() }))]);
await say("+14155550101", "hey jarvis, it's kofi · r7k2");
await say("+14155550102", "hi");
await say("+14155550101", "hello again");
await say("+14155550103", `join ${inv.claim_code}`);
await say("+12025551234", "what's up");
for (const [m, p] of [["GET", "/api/capabilities"], ["POST", "/api/new"], ["GET", "/api/AAAAAAAAAAAAAAAA/status"], ["POST", "/api/AAAAAAAAAAAAAAAA/tapped"], ["POST", "/api/AAAAAAAAAAAAAAAA/text-me"]]) {
  const r = await ws.request({ method: m, path: p, headers: { host: "reason.example.test" }, router });
  seen.push(["http", m, p, r.status, r.body]);
}
seen.push(["claim", JSON.stringify(ws.claimFromText({ conversationId: "dm:fake:+14155550109", text: "hi", address: "+14155550109" }))]);
seen.push(["nudges", typeof ws.nudgeInviters === "function" ? ws.nudgeInviters({ say: () => { throw new Error("must not say"); } }) : 0]);
const report = await ops.runChecks({ probe: async () => ({ ok: true }), usageFetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
seen.push(["checks", report.checks.map(c => c.id).filter(id => !/^provider:|^sub|^plan/.test(id)).join(",")]);
seen.push(["sent", ...ch.sent.map(s => `${s.to}|${s.text ?? ""}|${s.media?.filename ?? ""}`)]);
for (const t of ["accounts", "access_requests", "invites", "outbox"]) {
  const cols = { accounts: "conversation_id, name, invited_by", access_requests: "address, state", invites: "state, redeemed_by", outbox: "conversation_id, state" }[t];
  seen.push([t, JSON.stringify(db.db.prepare(`SELECT ${cols} FROM ${t} ORDER BY 1`).all())]);
}
const norm = JSON.stringify(seen).split(inv.claim_code).join("CODE").replace(/"id":"[A-Za-z0-9_-]{16}"/g, '"id":"X"').replace(/"code":"[a-z0-9]{4}"/g, '"code":"X"').replace(/"expiresAt":\d+/g, '"expiresAt":0').replace(/rs_setup=[^;"]+/g, "rs_setup=X");
if (process.env.GOLDEN_DUMP) (await import("node:fs")).writeFileSync(process.env.GOLDEN_DUMP, norm.replace(/\],\[/g, "],\n["));
console.log(createHash("sha256").update(norm).digest("hex"), seen.length);
process.exit(0);
