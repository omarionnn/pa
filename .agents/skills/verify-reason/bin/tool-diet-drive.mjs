#!/usr/bin/env node
// Before/after drive for the tool diet (src/tooldiet.js) on Reason's REAL claude-cli turn: the real
// runTurnViaCli, the real MCP tools/list and tools, a throwaway database, no API key, nothing sent.
// Each case runs four times, interleaved so the clock and the CLI's mood hit both arms alike:
//   main-cold, main-warm  (REASON_TOOL_DIET=off: the tool list exactly as main sends it)
//   diet-cold, diet-warm  (the diet on)
// "Cold" puts a fresh marker into the first line of the system prompt (the owner's city), so nothing
// after the tools can come from the cache (see --idle-cold for tools too); "warm" repeats the same
// case straight after, same marker.
//
//   D=$(mktemp -d) && env -i PATH=$PATH HOME=$HOME USER=$USER LOGNAME=$USER REASON_DB_PATH=$D/td.db \
//     node .agents/skills/verify-reason/bin/tool-diet-drive.mjs [--only c1,r3] [--out file.jsonl]
//
// Prints one line per run: case, arm, the tools Reason called, whether the expected one was among
// them, ToolSearch rounds, first-word and total seconds, prompt tokens (fresh / cache read / cache
// write), and the reply. Spends the subscription's 5-hour limit: ~4 turns per case.
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER ||= "+12025550100";
process.env.REASON_MASTER_NUMBER ||= process.env.REASON_OWNER_NUMBER;
process.env.REASON_OWNER_NAME ||= "Omari";
process.env.REASON_TZ ||= "America/New_York";
process.env.REASON_BACKEND = "claude-cli";
process.env.REASON_TEST_NUMBERS = process.env.REASON_OWNER_NUMBER;
process.env.REASON_CLAIM_CHECK = "0";
// The features live has on, or their tools are hidden and "I can't" is simply true (first run, 11-09).
process.env.REASON_EVENTS = "on";
process.env.REASON_SHOP_CONNECT = "on";
process.env.CROSSMINT_SERVER_KEY = "sk_drive_fake";
process.env.CROSSMINT_CLIENT_KEY = "ck_drive_fake";
process.env.CROSSMINT_API_BASE = "https://crossmint.drive.invalid";
const args = process.argv.slice(2);
const ONLY = (args[args.indexOf("--only") + 1] && args.includes("--only")) ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
// The marker only makes everything AFTER the tools cold (the CLI's cache still holds the tool schemas).
// --idle-cold N waits N minutes before each cold run, past the cache's life, for a truly cold call.
const SAMPLES = args.includes("--samples") ? Number(args[args.indexOf("--samples") + 1]) : 1;
const IDLE_MIN = args.includes("--idle-cold") ? Number(args[args.indexOf("--idle-cold") + 1]) : 0;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some((r) => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/td.db");
    process.exit(2);
  }
  process.env.REASON_DATA_DIR ||= dirname(db) + "/data";
  const { generateKeyPairSync } = await import("node:crypto");
  process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
}
for (const k of ["ANTHROPIC_API_KEY", "SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "TWILIO_AUTH_TOKEN", "AGENTCARD_CLIENT_SECRET", "UBER_CLIENT_SECRET", "SERPAPI_API_KEY", "DUFFEL_ACCESS_TOKEN"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under env -i`); process.exit(2); }
}

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { runTurnViaCli } = await imp("src/backends/claude-cli.js");
const db = await imp("src/db.js");
const { config, clock } = await imp("src/config.js");
const diet = await imp("src/tooldiet.js");
const { appendFileSync } = await import("node:fs");
const { tools: allTools } = await imp("src/tools.js");
const descOf = new Map(allTools.map((t) => [t.name, t.description]));

const C = "dm:owner";
db.upsertAccount({ conversationId: C, channel: "fake", address: process.env.REASON_OWNER_NUMBER, name: "Omari", isOperator: true });
db.upsertThread({ conversationId: C, channel: "fake", address: process.env.REASON_OWNER_NUMBER, isOwner: true, service: "iMessage" });
const CITY = config.ownerCity;

// kind: common = core on the diet (deferred on main unless main's 15 had it); rare = deferred on both;
// likely = deferred on main, loaded on the diet because of their state (seeded before the case).
const CASES = [
  { id: "c1", kind: "common", text: "what's the weather like tomorrow?", expect: ["weather"] },
  { id: "c2", kind: "common", text: "what reminders do i have coming up?", expect: ["timer_list"] },
  { id: "c3", kind: "common", text: "find me a good coffee shop near union square", expect: ["nearby_places", "web_search"] },
  { id: "c4", kind: "common", text: "remind me to call my mom tomorrow at 6pm", expect: ["timer_set"] },
  { id: "c5", kind: "common", text: "who won the knicks game last night?", expect: ["web_search", "web_lookup"] },
  { id: "r1", kind: "rare", text: "make an event called omari's birthday dinner this saturday 8pm at carbone, 10 people max, guest password is dinner2026, show guests the time and place as soon as they join", expect: ["event_create"] },
  // r1 as written leaves event_create's required questions open, so both arms stop to ask them. This one answers them all.
  { id: "r1f", kind: "rare", text: "make an event called omari's birthday dinner this saturday 8pm at carbone, 10 people max, guest password is dinner2026, show guests the time and place as soon as they join, guests can see who else is going, description is birthday dinner, no welcome message, no questions for guests. that's everything, go ahead and create it", expect: ["event_create"] },
  { id: "r2", kind: "rare", text: "set my daily spending limit to $50", expect: ["spend_limit_set", "spend_limit_confirm", "caps_set"] },
  { id: "r3", kind: "rare", text: "find me flights from JFK to LAX on december 12", expect: ["flight_search", "flight_dates"] },
  { id: "r4", kind: "rare", text: "how much would an uber from times square to jfk be right now?", expect: ["uber_options", "uber_link", "uber_connect"] },
  { id: "r5", kind: "rare", text: "stop texting me first unless it's really urgent", expect: ["notice_mode", "notice_settings", "notice_window", "pause_everything"] },
  { id: "r6", kind: "rare", text: "what subscriptions am i paying for?", expect: ["subscription_list", "subscriptions_scan"] },
  { id: "l1", kind: "likely", text: "what events do i have going on?", expect: ["event_list", "event_info"], seed: "event" },
];

function seed(kind) {
  if (kind === "event") {
    const have = db.eventsOrganizedBy(C);
    if (!have.length) db.insertEvent({ organizer: C, name: "Omari's housewarming", nameKey: "omaris housewarming", description: "drinks and food", startsAt: clock.now() + 5 * 86_400_000, tz: "America/New_York", location: "Brooklyn", welcome: "", passwordHash: "x", organizerName: "Omari" });
  }
}

async function runOnce(c, arm, temp, marker) {
  process.env.REASON_TOOL_DIET = arm === "main" ? "off" : "on";
  config.ownerCity = `${CITY} (drive ${marker})`;
  db.saveConversation(C, []);
  // What the last run left behind ("you already asked me for this one" is not a tool call).
  db.db.exec("DELETE FROM timers");
  try { db.db.exec("DELETE FROM spend_caps"); } catch {}
  db.db.exec("DELETE FROM events WHERE name NOT LIKE '%housewarming%'");
  const logs = [];
  let first = null, toolSearch = 0;
  const t0 = Date.now();
  const draft = { feed(e) {
    if (e?.type === "stream_event" && e.event?.delta?.type === "text_delta" && first == null) first = Date.now() - t0;
    if (e?.type === "assistant") for (const b of e.message?.content ?? []) if (b.type === "tool_use" && b.name === "ToolSearch") toolSearch++;
  } };
  let reply = null, err = null;
  try { reply = await runTurnViaCli({ conversationId: C, text: c.text, kind: "user", log: (l) => logs.push(l), draft }); } catch (e) { err = String(e?.message ?? e).slice(0, 200); }
  const total = Date.now() - t0;
  const cli = logs.find((l) => l.cli)?.cli ?? {};
  const used = logs.filter((l) => l.tool && "out" in l).map((l) => l.tool);
  const set = logs.find((l) => l.toolset);
  const hit = used.some((u) => c.expect.includes(u)) || (used.includes("confirm_request") && c.expect.some((e) => JSON.stringify(logs.filter((l) => l.tool === "confirm_request")).includes(e)));
  const row = { case: c.id, kind: c.kind, arm, temp, text: c.text, used, hit, toolSearch, turns: cli.turns ?? null,
    firstWordS: first == null ? null : +(first / 1000).toFixed(2), totalS: +(total / 1000).toFixed(2),
    tokens: cli.tokens ?? null, loaded: set?.loaded ?? null, reply: reply ?? err };
  console.log(`${c.id} ${arm}-${temp}  hit=${hit ? "yes" : "NO"}  tools=[${used.join(",")}]  ToolSearch=${toolSearch} turns=${row.turns}  first=${row.firstWordS}s total=${row.totalS}s  tok=${JSON.stringify(row.tokens)}\n    → ${String(row.reply).replace(/\s+/g, " ").slice(0, 220)}`);
  if (OUT) appendFileSync(OUT, JSON.stringify(row) + "\n");
  return row;
}

setInterval(() => {}, 1000);
let n = 0;
for (const c of CASES) {
  if (ONLY && !ONLY.has(c.id)) continue;
  if (c.seed) seed(c.seed);
  // Alternate which arm goes first, so neither always meets a CLI that just woke up.
  const arms = n++ % 2 ? ["diet", "main"] : ["main", "diet"];
  for (let sample = 1; sample <= SAMPLES; sample++) for (const arm of sample % 2 ? arms : [...arms].reverse()) {
    diet._resetDiet();
    const marker = `${c.id}-${arm}-${sample}-${Date.now().toString(36)}`;
    if (IDLE_MIN) await new Promise((r) => setTimeout(r, IDLE_MIN * 60_000));
    // The marker on every tool too: tools come first in the prefix, so without this a "cold" run still
    // read the tool schemas from the cache of the arm's previous sample. Same few characters on both arms.
    for (const t of allTools) t.description = `${descOf.get(t.name)} [${marker}]`;
    const cold = await runOnce(c, arm, IDLE_MIN ? "truecold" : "cold", marker);
    const warm = await runOnce(c, arm, "warm", marker);
    if (OUT) appendFileSync(OUT, JSON.stringify({ sampleOf: c.id, sample, arm, coldTotal: cold.totalS, warmTotal: warm.totalS }) + "\n");
  }
}
process.exit(0);
