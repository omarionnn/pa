#!/usr/bin/env node
// Drive the machine rules of an outbound call on the REAL model, on claude-cli (the subscription —
// never the API; a phone call itself stays on the API, this only proves the prompt and the code):
// the real third-party prompt, the real voiceTurn, a throwaway database, and the words the Strand's
// line really said on live call 45 (test/fixture-call45.js). No phone, no provider, nothing leaves.
//
//   cd ~/Desktop/pa && REASON_DB_PATH=$(mktemp -d)/machines.db \
//     env -i PATH=$PATH HOME=$HOME USER=$USER LOGNAME=$USER REASON_DB_PATH=$REASON_DB_PATH \
//     node .agents/skills/verify-reason/bin/call-machines-drive.mjs
//
// USER/LOGNAME are what lets the CLI find its keychain login under `env -i`. One line per case, `ok`
// or `FAIL`, with what would have been said and which tool went to the platform; exits non-zero on
// any FAIL. Model judgement varies run to run, so a FAIL here is read before it is believed.
const { resolve, dirname } = await import("node:path");
const { existsSync, realpathSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const dbPath = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
const parent = dbPath && existsSync(dirname(dbPath)) ? realpathSync(dirname(dbPath)) + "/" : "";
const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
if (!dbPath || existsSync(dbPath) || !parent || !roots.some(r => parent.startsWith(r))) {
  console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/machines.db");
  process.exit(2);
}
Object.assign(process.env, {
  REASON_DATA_DIR: dirname(dbPath) + "/data", REASON_RECORDING_ROOT: dirname(dbPath) + "/recordings",
  REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner",
  REASON_OWNER_NUMBER: "+12025550100", ANTHROPIC_API_KEY: "",
});
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "../../../..");
const voice = await import(`${REPO}/src/calls/voice.js`);
const db = await import(`${REPO}/src/db.js`);
const brief = await import(`${REPO}/src/calls/brief.js`);
const { announcementFor } = await import(`${REPO}/src/calls/provider.js`);
const { config } = await import(`${REPO}/src/config.js`);
const fx = await import(`${REPO}/test/fixture-call45.js`);
await voice.prime();
const C = config.ownerConversation;
const ANN = announcementFor({ ownerName: "Omari" });
const gen = voice.generatorFor("claude-cli");

// [name, what their side said each turn, check(last turn, row)]
const cases = [
  ["call 45: the Strand's recording (no phone inquiries)", [fx.STRAND_RECORDING],
    (t, r) => t.said === "" && t.tools[0]?.startsWith("end_call") && r.outcome_kind === "machine_dead_end" && /strandbooks/i.test(r.machine_heard ?? "")],
  ["a person picks up", ["Strand Books, this is Maya, how can I help you?"],
    (t, r) => t.said.startsWith(ANN) && /Thank God for Cats/i.test(t.said) && r.parties_told === "[1]"],
  ["a menu with a fitting option", ["Thank you for calling the Strand. For store hours and directions, press 1. To check whether we have a book in stock, press 2. For all other inquiries, press 0."],
    (t, r) => t.said === "" && /play_keypad_touch_tone .*"2"/.test(t.tools[0] ?? "") && r.outcome_kind === "machine_menu"],
  ["a voicemail greeting", ["Hi, you've reached the rare books room at the Strand. We can't come to the phone right now. Please leave your name, number and a short message after the tone."],
    (t, r) => t.said === "" && t.tools[0]?.startsWith("end_call") && ["voicemail_left", "voicemail_no_message"].includes(r.outcome_kind)],
  ["a hold queue", ["Thank you for holding. All of our booksellers are currently helping other customers. Your call will be answered in the order it was received."],
    (t, r) => t.said === "" && t.tools[0]?.startsWith("skip_turn") && r.outcome_kind === "machine_recording"],
];

let failed = 0;
for (const [name, theirs, check] of cases) {
  const row = db.createCall(C, { provider: "elevenlabs", toNumber: fx.STRAND, isOwner: false, goal: fx.STRAND_GOAL, facts: [], announcement: ANN, externalId: `conv_drive_${Date.now()}` });
  db.updateCall(C, row.id, { brief: JSON.stringify(brief.buildBrief({ goal: fx.STRAND_GOAL })), opening_waits: 1, state: "in_progress" });
  let last = null;
  for (let i = 0; i < theirs.length; i++) {
    const call = db.getCall(C, row.id);
    const context = voice.contextFor({ call, kind: "third_party", callMessages: theirs.slice(0, i + 1).map(content => ({ role: "user", content })) });
    last = { said: "", tools: [] };
    for await (const s of voice.voiceTurn({ context, call, generate: gen })) {
      if (!s.startsWith("data: ") || s.includes("[DONE]")) continue;
      const d = JSON.parse(s.slice(6)).choices[0].delta;
      if (d.content) last.said += d.content;
      for (const t of d.tool_calls ?? []) last.tools.push(`${t.function.name} ${t.function.arguments}`);
    }
  }
  const r = db.getCall(C, row.id);
  const ok = check(last, r);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}\n     said=${JSON.stringify(last.said.slice(0, 200))} tools=${JSON.stringify(last.tools).slice(0, 200)} row=${r.outcome_kind || "-"} heard=${JSON.stringify((r.machine_heard ?? "").slice(0, 120))}`);
}
process.exit(failed ? 1 : 0);
