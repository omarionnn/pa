#!/usr/bin/env node
// Drive research room + the one background follow-up on the REAL model over the subscription
// (claude-cli), in process, with a fake search provider and fake page reads — no search spend, no
// API key, nothing texted (outbound is recorded, there is no channel). A throwaway database.
//
//   1. the run-#78 question: the model plans its queries; every one it planned is searched;
//   2. a second question with the search cap forced to 1: a follow-up task is scheduled, once;
//   3. the task's wake (clock moved on): the model carries the SAME run on and exactly one text goes out;
//      a second sweep later wakes nothing.
//
// Three model turns on the subscription. Run under the cage's env:
//
//   cd <repo> && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/research-room.db REASON_BACKEND=claude-cli \
//        node .agents/skills/verify-reason/bin/research-room-drive.mjs
//
// One line per step, `ok` or `FAIL`; exits non-zero on any FAIL.
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NAME ||= "Omari";
process.env.REASON_TZ ||= "America/New_York";
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/research-room.db");
    process.exit(2);
  }
  process.env.REASON_DATA_DIR ||= dirname(db) + "/data";
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "BLAND_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
if (process.env.REASON_BACKEND !== "claude-cli") { console.error("refusing: REASON_BACKEND=claude-cli (the subscription), never the API"); process.exit(2); }

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const db = await imp("src/db.js");
const { clock, config } = await import(new URL("src/config.js", root));

const CONV = "dm:owner";
const MIN = 60_000;
let failed = 0;
const step = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
db.upsertAccount({ conversationId: CONV, channel: "fake", address: "+12025550100", name: "Omari", isOperator: true });
// Noon in New York, so the wake is never held for the night.
clock.skip(Date.parse("2026-10-30T16:00:00Z") - clock.now());

// Every query gets eight results on eight sites of its own, so one query alone could fill the page cap.
const searched = [];
const provider = {
  name: "fake",
  status: () => ({ connected: true, missing: [], what: "the drive's fake search provider" }),
  async search(query) {
    searched.push(query);
    const tag = `q${searched.length}`;
    return { ok: true, provider: "fake", results: Array.from({ length: 8 }, (_, i) => ({
      title: `${query.slice(0, 40)} — result ${i}`, url: `https://${tag}-${i}.example/page`,
      snippet: `Fixture result ${i} for "${query.slice(0, 60)}".`, date: null,
    })) };
  },
};
// A page says something about the query that found it, so the model has something on-topic to weigh.
const lookup = async (url) => {
  const n = Number(/q(\d+)-/.exec(url)?.[1] ?? 1);
  const q = searched[n - 1] ?? "";
  return { ok: true, url, title: `page at ${url}`, text: `A fixture page found by the search "${q}". Its maker says it covers what that search asked about; no prices or specs are listed here.`, images: [] };
};
const robots = async () => ({ allowed: true, checked: false, why: "drive", rule: null });

const sent = [];
const rt = new Runtime({ log: () => {} });
rt.on("outbound", (m) => sent.push(m));
rt.turnExtras = { ...rt.turnExtras, searchProvider: provider, lookup, robots };
const runQueries = (id) => db.listResearchQueries(id).map(q => q.query);

// 1. Run #78's question, words close to the owner's.
const Q1 = "which service can vault each of our users' cards and do a passkey per agent purchase? compare visa intelligent commerce / mastercard agent pay, stripe, agentcard, basis theory, skyfire, payman";
console.log(`> ${Q1}`);
const r1 = await rt.inbound(CONV, Q1);
console.log(`< ${String(r1 ?? "").slice(0, 400)}`);
const runs1 = db.listResearch(CONV, { includeClosed: true });
const run1 = runs1[runs1.length - 1];
const planned1 = run1 ? runQueries(run1.id) : [];
step("turn 1 called research", !!run1, run1 ? `#${run1.id} big=${run1.big} kind-driven caps` : "no run");
if (run1) {
  step("every planned query was searched", run1.queries.length === 0 && planned1.length >= 2, `${planned1.length} searched, ${run1.queries.length} left: ${JSON.stringify(planned1).slice(0, 300)}`);
  step("pages spread across queries", new Set(db.listResearchSources(run1.id).filter(s => s.state === "read").map(s => s.url.split("-")[0])).size >= Math.min(planned1.length, 2),
    `${db.countResearchSources(run1.id, { state: "read" })} pages read`);
}

// 2. A different question with the search cap forced to one: the rest has to go to the follow-up.
rt.turnExtras.researchCaps = { maxSearches: 1 };
const Q2 = "different question: which e-bike under $2k is best for a 10 mile hilly commute? compare a few";
console.log(`> ${Q2}`);
const sentBefore = sent.length;
const r2 = await rt.inbound(CONV, Q2);
console.log(`< ${String(r2 ?? "").slice(0, 400)}`);
const run2 = db.listResearch(CONV, { includeClosed: true }).find(r => r.id !== run1?.id && r.continue_task_id);
step("cut short with queries left → one follow-up task", !!run2, run2 ? `research #${run2.id}, task #${run2.continue_task_id}, ${run2.queries.length} left` : JSON.stringify(db.listResearch(CONV, { includeClosed: true }).map(r => ({ id: r.id, q: r.queries.length, cut: r.cut_short }))));
// The model may start tasks of its own (it did on the first drive: "read each company's docs").
// What is asserted is the follow-up machinery's: one "research, the rest" task, no more.
const followUps = () => db.db.prepare("SELECT id, state FROM tasks WHERE conversation_id = ? AND title LIKE 'research, the rest:%'").all(CONV);
const otherTasks = db.db.prepare("SELECT id, title FROM tasks WHERE conversation_id = ? AND title NOT LIKE 'research, the rest:%'").all(CONV);
step("exactly one follow-up task", followUps().length === 1, JSON.stringify(followUps()) + (otherTasks.length ? ` (the model's own: ${JSON.stringify(otherTasks).slice(0, 200)})` : ""));

// 3. The wake.
if (run2) {
  const replyCount = sent.length;
  clock.skip((config.researchContinueWakeMin + 1) * MIN);
  const woke = await rt.runTasks();
  const follow = sent.slice(replyCount).filter(m => m.fromTask === run2.continue_task_id);
  console.log(`< (wake) ${follow.map(m => m.text).join(" | ").slice(0, 500)}`);
  const after = db.getResearch(CONV, run2.id);
  step("the wake carried the same run on", after.searches > 1 && after.state === "done", `searches ${after.searches}, state ${after.state}`);
  step("one follow-up text", woke.woke === 1 && follow.length === 1, `woke ${woke.woke}, sent ${follow.length}`);
  step("its task is closed", db.getTask(CONV, run2.continue_task_id)?.state === "done");
  clock.skip(60 * MIN);
  await rt.runTasks();
  step("nothing more for that run, however long", sent.filter(m => m.fromTask === run2.continue_task_id).length === 1);
  step("no second follow-up task", followUps().length === 1);
}
void sentBefore;
console.log(failed ? `${failed} FAIL` : "all ok");
process.exit(failed ? 1 : 0);
