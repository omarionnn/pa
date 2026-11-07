#!/usr/bin/env node
// Drive the claim check (src/said.js, REASON_CLAIM_CHECK) through Reason's REAL claude-cli turn: the
// real Runtime, the real runTurnViaCli and MCP tools, the real harm screen, the real check on the
// subscription (warm CLI, haiku) and the real rewrite (the continued CLI session). A throwaway
// database, a fake Crossmint that refuses to start anything, the fake texting channel. No API key.
//
//   D=$(mktemp -d) && env -i PATH=$PATH HOME=$HOME USER=$USER LOGNAME=$USER REASON_DB_PATH=$D/nfd.db \
//     node .agents/skills/verify-reason/bin/no-false-done-drive.mjs <ulta|directions> [--inject] [--off]
//
//   ulta        "yes get the cerave from ulta": store_checkout runs and Crossmint refuses it.
//   directions  "walk me from washington square park to joe's pizza on carmine st": the real tool,
//               real geocoding (Nominatim) and routing (OSM), a real private link.
//   chat        a plain question no tool acts on: the claim check must not run (the gate, "acting").
//   --inject    the turn's own draft is replaced with the incident's words (10-31 "I've started the
//               Ulta checkout…", 11-03 "I made you walking directions…" with no link), so the REAL check
//               and the REAL rewrite are shown the exact line that went out then.
//   --off       REASON_CLAIM_CHECK=0: what main does (the before).
// Prints the transcript: what they said, every tool and whether it worked, the check's verdict, what was sent.
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER ||= "+12025550100";
process.env.REASON_MASTER_NUMBER ||= process.env.REASON_OWNER_NUMBER;
process.env.REASON_OWNER_NAME ||= "Omari";
process.env.REASON_TZ ||= "America/New_York";
process.env.REASON_BACKEND = "claude-cli";
process.env.REASON_TEST_NUMBERS = process.env.REASON_OWNER_NUMBER;
process.env.REASON_SHOP_CONNECT = "owner";
process.env.REASON_DIRECTIONS = "owner";
process.env.CROSSMINT_SERVER_KEY = "sk_drive_fake";
process.env.CROSSMINT_CLIENT_KEY = "ck_drive_fake";
process.env.CROSSMINT_API_BASE = "https://crossmint.drive.invalid";
const args = process.argv.slice(2);
const CASE = args.find((a) => !a.startsWith("--"));
const INJECT = args.includes("--inject");
if (args.includes("--off")) process.env.REASON_CLAIM_CHECK = "0";
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { generateKeyPairSync } = await import("node:crypto");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some((r) => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/nfd.db");
    process.exit(2);
  }
  if (!["ulta", "directions", "chat"].includes(CASE)) { console.error("usage: no-false-done-drive.mjs <ulta|directions|chat> [--inject] [--off]"); process.exit(2); }
  process.env.REASON_DATA_DIR ||= dirname(db) + "/data";
  process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
}
for (const k of ["ANTHROPIC_API_KEY", "SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ELEVENLABS_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under env -i`); process.exit(2); }
}

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Router } = await imp("src/channels/router.js");
const { Runtime } = await imp("src/runtime.js");
const { FakeChannel } = await imp("src/channels/fake.js");
const { runTurnViaCli } = await imp("src/backends/claude-cli.js");
const db = await imp("src/db.js");
const shop = await imp("src/shopconnect.js");
const { config } = await imp("src/config.js");

const OWNER = process.env.REASON_OWNER_NUMBER;
const CONV = "dm:owner";
db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
// Crossmint, refusing every checkout (the 10-31 shape that matters: nothing is running).
shop._setFetch(async () => ({ status: 500, ok: false, text: async () => JSON.stringify({ message: "Internal error starting agent checkout" }) }));

const TEXT = CASE === "chat" ? "what's a good name for a sourdough starter?" : CASE === "ulta"
  ? "yes get the cerave foaming cleanser 16oz from ulta, this one: https://www.ulta.com/p/foaming-facial-cleanser-xlsImpprod5140065?sku=2541605 — under $35, ship to home"
  : "walk me from washington square park to joe's pizza on carmine st";
const INCIDENT = CASE === "ulta"
  ? "I've started the Ulta checkout for the CeraVe 16 oz. Nothing gets charged until you approve the total; I'll text you when it's there."
  : "I made you walking directions to Joe's Pizza, about a 6 minute walk.";

const logs = [];
let turnNo = 0;
const runtime = new Runtime({
  log: (l) => { logs.push(l); if (process.env.DRIVE_DEBUG) console.error(JSON.stringify(l).slice(0, 300)); },
  runTurn: async (a) => {
    const n = ++turnNo;
    const real = await runTurnViaCli(a);
    if (!INJECT || n !== 1 || !real) return real;
    // The incident's words in place of the model's own first draft, in the thread too.
    const conv = db.loadConversation(a.conversationId);
    const last = conv.findLastIndex((m) => m.role === "assistant");
    if (last >= 0) { conv[last] = { ...conv[last], content: INCIDENT }; db.saveConversation(a.conversationId, conv); }
    logs.push({ drive_injected: true, model_draft_was: real });
    return INCIDENT;
  },
});
const router = new Router({ runtime, log: (l) => { if (process.env.DRIVE_DEBUG) console.error("router", JSON.stringify(l).slice(0, 300)); } });
const fake = router.register(new FakeChannel({ number: "+15122164639" }));
runtime.turnExtras.channels = router;
runtime.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
  await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
});

setInterval(() => {}, 1000); // the burst and sweep timers are unref()d: keep the process up for the turn
const t0 = Date.now();
await router.deliver({ channel: "fake", externalId: "NFD-1", from: OWNER, text: TEXT, chatId: null, service: "iMessage" });
while (!fake.sent.length && Date.now() - t0 < 240_000) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 1500));

const bad = (o) => !o || (typeof o === "object" && (o.ok === false || !!o.error || !!o.blocked));
const tools = logs.filter((l) => l.tool && "out" in l).map((l) => `${l.tool}${bad(l.out) ? ` (did not work: ${String(l.out?.error ?? "").slice(0, 80)})` : ""}`);
console.log(`case: ${CASE}${INJECT ? " (incident words injected as the first draft)" : ""} · claim check ${config.claimCheck ? "ON" : "OFF"} · backend claude-cli`);
console.log(`Omari: ${TEXT}`);
const inj = logs.find((l) => l.drive_injected);
if (inj) console.log(`  [model's own first draft, replaced: ${JSON.stringify(inj.model_draft_was)}]`);
console.log(`  [tools: ${tools.length ? tools.join(", ") : "none"}]`);
if (!logs.some((l) => l.said_check)) console.log("  [check: did not run]");
for (const l of logs.filter((l) => l.said_check)) console.log(`  [check: ${JSON.stringify({ unbacked: l.unbacked, acts: l.acts, changed: l.changed, reasked: l.reasked, ms: l.ms })}]`);
for (const l of logs.filter((l) => l.said_check_failed)) console.log(`  [check failed: ${l.said_check_failed}]`);
for (const l of logs.filter((l) => l.draft_rewritten)) console.log(`  [rewritten: ${l.why}]`);
for (const m of fake.sent) console.log(`Reason: ${m.text}`);
console.log(`(${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(0);
