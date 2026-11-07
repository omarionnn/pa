#!/usr/bin/env node
// Drive the call payment-details guard in process: the real call_place path, the fake call provider
// (dials nothing, records what it was asked to carry), a throwaway database. No model, no phone.
// Every field the call is handed — goal, facts, ask, requirements (keys and values), approved_terms —
// must refuse a card number before anything dials (audit lead 31). Run under the cage's env:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/call-pay.db node .agents/skills/verify-reason/bin/call-payments-drive.mjs
//
// The refusal is explained calmly (lead 31 follow-up): every refusal's note, the rules the placed call
// carries, the GPT-Live line voice prompt and Reason's real third-party call-turn context all carry the
// "say why, in your own words" instruction, and none of them is a script. `--transcript` prints what the
// model sees and what a STUB model following that instruction would say — the stub echoes the
// instruction's own reason; it is not real model speech (no model is run here, paid or otherwise).
//
// One line per step, `ok` or `FAIL`; exits non-zero on any FAIL.
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER ||= "+12025550100";
process.env.REASON_MASTER_NUMBER ||= process.env.REASON_OWNER_NUMBER;
process.env.REASON_OWNER_NAME ||= "Omari";
process.env.REASON_TZ ||= "America/New_York";
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_UNDO_SECONDS = "0";
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/call-pay.db");
    process.exit(2);
  }
  process.env.REASON_DATA_DIR ||= dirname(db) + "/data";
  process.env.REASON_RECORDING_ROOT ||= dirname(db) + "/recordings";
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "TWILIO_AUTH_TOKEN", "BLAND_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { FakeCallProvider } = await imp("src/calls/fake.js");
const { runTool } = await imp("src/tools.js");
const db = await imp("src/db.js");

const OWNER = process.env.REASON_OWNER_NUMBER;
const SHOP = "+12125550123";
const CONV = "dm:owner";
const CARD = "4242 4242 4242 4242";
let failed = 0;
const step = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
db.markToldCallsRecorded(CONV);

const calls = new FakeCallProvider();
const ctx = { conversationId: CONV, calls };
const GOAL = "ask whether they have a table for 2 at 8pm tonight";
// A third-party call needs the owner's yes; the yes is recorded with a stand-in judge (no model).
const said = (t) => ({ role: "user", content: `[Sat, Nov 7, 2026, 12:00 PM] Omari: ${t}` });
// The yes is pinned to exactly what the call carries: call_place with no confirmation_id dials nothing
// and refuses with the `use_target` string, which is what confirm_request is asked with. A call that
// carries a card is refused by the payment guard before it ever gets that far, which is the point.
async function yes(input) {
  const first = await runTool("call_place", input, ctx);
  if (first.status === "payment_details_refused") return { refusedFirst: first };
  const target = first.use_target ?? SHOP;
  const asked = await runTool("confirm_request", { action: "call_place", summary: `ring ${SHOP} about a table`, target },
    { conversationId: CONV, messages: [said("call them")] });
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: CONV, messages: [said("call them"), said("yeah go")], judge: async () => ({ verdict: "yes" }) });
  return { confirmation_id: asked.confirmation_id };
}
const TRANSCRIPT = process.argv.includes("--transcript");
// The calm-why instruction, present (not its exact wording) — and no quoted line to read out.
const CALM = [/card or account details/i, /money safe/i, /own words/i, /blame/i, /same way twice/i];
const calm = (t) => CALM.every(re => re.test(String(t ?? ""))) && !/"[^"]{25,}"/.test(String(t ?? ""));
// In a whole prompt, the line that carries it (the rest of a prompt has quoted examples of its own).
const ruleOf = (prompt) => String(prompt ?? "").split("\n").find(l => /money safe/.test(l)) ?? "";
// A STUB model: it follows the instruction by saying back the reason the instruction gives, plus the
// offer. Stands in for the model so the transcript shows the shape; never the paid API.
const stubSays = (instruction) => {
  const why = /Reason doesn't share or ask for card or account details on calls, to keep [^.]+ money safe\./.exec(instruction)?.[0] ?? "";
  return why.replace(/^Reason doesn't/, "I don't").replace(/^/, "Ah, ") + " Could you send a payment link instead, and I'll pass it on?";
};
let firstNote = "";
const refused = async (name, extra) => {
  const input = { to: SHOP, goal: GOAL, ...extra };
  const y = await yes(input);
  const out = y.refusedFirst ?? await runTool("call_place", { ...input, confirmation_id: y.confirmation_id }, ctx);
  step(name, out.status === "payment_details_refused" && !/4242|cvv 123/i.test(JSON.stringify(out)), `${out.status} ${String(out.error ?? "").slice(0, 80)}`);
  step(`  …and the note says why, calmly, in the model's own words (no script, no say field)`, calm(out.error) && out.say === undefined && /instead/i.test(out.error));
  firstNote ||= out.error;
};

await refused("card in a requirements value → refused, not echoed", { requirements: { name: "Omari", "card to hold it": `${CARD} exp 12/28 cvv 123` } });
await refused("card in a requirements key → refused", { requirements: { [`card ${CARD}`]: "yes" } });
await refused("cvv in ask → refused", { ask: ["is cvv 123 ok to hold it?"] });
await refused("card number in approved_terms → refused", { approved_terms: [`a deposit on card number ${CARD}`] });
await refused("card in facts → refused (unchanged)", { facts: [`card ${CARD}`] });
step("nothing dialled, no call row", calls.placed.length === 0 && db.listCalls(CONV).length === 0, `${calls.placed.length} placed`);

const plain = { to: SHOP, goal: GOAL, requirements: { name: "Omari", people: "2" }, ask: ["do they take card or is it cash only?"] };
const ok = await runTool("call_place", { ...plain, confirmation_id: (await yes(plain)).confirmation_id }, ctx);
step("an ordinary ask-only business call still goes", ok.ok === true && calls.placed.length === 1, `${ok.status ?? ""} ${String(ok.error ?? "").slice(0, 120)}`);
step("and it carries the requirements and the question", JSON.stringify(calls.placed[0]?.brief ?? {}).includes("cash only"));


// The callee side: what the call itself carries when THEY ask for a card.
const rules = calls.placed[0]?.rules ?? [];
step("placed call's rules carry the calm-why instruction (the business asks for a card)", calm(rules.join(" ")) && /Omari's money safe/.test(rules.join(" ")));
const { lineTalkInstructions } = await imp("src/calls/gptlive.js");
const voice = lineTalkInstructions({ name: "Omari", goal: GOAL });
step("GPT-Live line voice prompt carries it", calm(ruleOf(voice)));
const { thirdPartyContext } = await imp("src/calls/voice.js");
const row = db.listCalls(CONV)[0];
const asked = "Sure, we can hold it — I just need a card number to secure the table.";
const turn = row ? thirdPartyContext({ call: row, callMessages: [{ role: "user", content: asked }] }) : null;
step("Reason's real third-party call-turn context carries it", calm(ruleOf(turn?.system)), row ? `call ${row.id}, ${turn.system.length} chars` : "no call row");
step("no reasonTools on that turn (unchanged isolation)", Array.isArray(turn?.reasonTools) && turn.reasonTools.length === 0);

if (TRANSCRIPT) {
  const ruleLine = ruleOf(turn?.system);
  console.log("\n--- transcript (STUB model: echoes the instruction; not real model speech) ---");
  console.log("[owner, by text] call them and hold it with my card 4242 4242 4242 4242");
  console.log(`[call_place → model sees] ${firstNote}`);
  console.log(`[stub Reason → owner] ${stubSays(firstNote).replace("their money", "your money").replace("Could you send a payment link instead, and I'll pass it on?", "I can still ring them without it and ask for a pay link.")}`);
  console.log("");
  console.log(`[business, on the call] ${asked}`);
  console.log(`[call-turn prompt rule] ${ruleLine}`);
  console.log(`[stub Reason → business] ${stubSays(ruleLine)}`);
}

console.log(failed ? `${failed} FAIL` : "all ok");
process.exit(failed ? 1 : 0);
