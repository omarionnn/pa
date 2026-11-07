#!/usr/bin/env node
// Drive the flight search with NO flight source on the REAL model over the subscription (claude-cli),
// in process — the week-of-11-02 incident, where a refused search was retried by a task through the
// night and texted "still trying" six times without a price. Nothing is texted (outbound is
// recorded, there is no channel), no flight API is called, and the database is a throwaway.
//
//   1. they ask for a flight: the reply says prices aren't available and hands over Google Flights;
//   2. a background task on that ask wakes six times, 90 minutes apart (one is started for it if the
//      model didn't start its own): every wake stays silent;
//   3. exactly ONE message reaches them in total.
//
// With FLIGHT_DRIVE_FAKE_BLOCKED=1 the source is a fake that throws Fli's "blocked" — what live
// answered every search the week of 11-02 — so the same drive on main shows the old behaviour.
//
//   cd <repo> && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/flights.db REASON_BACKEND=claude-cli \
//        node .agents/skills/verify-reason/bin/flights-unavailable-drive.mjs
//
// Prints the transcript, then one line per check, `ok` or `FAIL`; exits non-zero on any FAIL.
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
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/flights.db");
    process.exit(2);
  }
  process.env.REASON_DATA_DIR ||= dirname(db) + "/data";
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "BLAND_API_KEY", "AGENTCARD_CLIENT_SECRET", "SERPAPI_API_KEY", "DUFFEL_ACCESS_TOKEN"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
if (process.env.REASON_BACKEND !== "claude-cli") { console.error("refusing: REASON_BACKEND=claude-cli (the subscription), never the API"); process.exit(2); }

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const db = await imp("src/db.js");
const { runTool } = await imp("src/tools.js");
const offers = await imp("src/offers.js");
const { FliError } = await imp("src/fli.js");
const { clock } = await imp("src/config.js");

const CONV = "dm:owner";
const MIN = 60_000;
let failed = 0;
const step = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
db.upsertAccount({ conversationId: CONV, channel: "fake", address: "+12025550100", name: "Omari", isOperator: true });
// 11am in New York tomorrow, so no wake is held for the night.
const t0 = new Date(clock.now());
t0.setUTCDate(t0.getUTCDate() + 1);
t0.setUTCHours(16, 0, 0, 0);
clock.skip(t0.getTime() - clock.now());

const rt = new Runtime({ log: () => {} });
const searches = [];
if (process.env.FLIGHT_DRIVE_FAKE_BLOCKED === "1") {
  const blocked = async (p) => { searches.push(p); throw new FliError("blocked", "Google returned an RPC error [13] with no data"); };
  rt.turnExtras.fli = { searchFlights: blocked, searchDates: blocked };
}
const sent = [];
const at = () => new Date(clock.now()).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
rt.on("outbound", (m) => sent.push({ at: at(), text: String(m.text ?? m.body ?? "") }));

const ask = "can you find me flights from boston to chicago on dec 3? one way";
console.log(`\n[${at()}] Omari: ${ask}`);
await rt.inbound(CONV, ask);
await rt.idle();
for (const m of sent) console.log(`[${m.at}] Reason: ${m.text}`);

let tasks = db.listTasks(CONV).map(t => ({ id: t.id, title: t.title }));
if (!tasks.length) {
  // The model didn't start one this time; start one the way it did in the incident.
  offers.beginTurn(CONV, ask, "user");
  const t = await runTool("task_start", { title: "find BOS → ORD flights for Dec 3", goal: "a real price for a one-way BOS → ORD on Dec 3", wake_in_minutes: 60 }, { conversationId: CONV });
  tasks = [{ id: t.task?.id, title: t.task?.title, started: "by the drive" }];
}
console.log(`\n(task: ${tasks.map(t => `#${t.id} "${t.title}"${t.started ? " — started by the drive" : " — started by the model"}`).join(", ")})`);

const before = sent.length;
for (let i = 0; i < 6; i++) {
  clock.skip(90 * MIN);
  for (const t of tasks) if (t.id) db.scheduleTask(t.id, clock.now() - 1000);
  const n = sent.length;
  await rt.runTasks();
  await rt.idle();
  const said = sent.slice(n);
  console.log(`[${at()}] (task wake ${i + 1})${said.length ? "" : " — nothing sent"}`);
  for (const m of said) console.log(`[${m.at}] Reason: ${m.text}`);
}

console.log("");
const first = sent.slice(0, before).map(m => m.text).join("\n");
step("the first reply says prices aren't available (or couldn't check), never 'no flights'", /not available|aren'?t available|couldn'?t (check|pull|get)|can'?t (check|pull|get)/i.test(first) && !/\bno flights\b(?! exist)/i.test(first.replace(/(doesn'?t|does not|not) mean (that )?there (are|were) no flights/gi, "")), first.slice(0, 160));
step("the first reply hands over Google Flights", /google\.com\/travel\/flights/.test(first));
step("no price is made up", !/\$\d/.test(sent.map(m => m.text).join("\n")));
step("no 'still trying' anywhere", !/still (trying|working|on it|checking)|keep (trying|checking)/i.test(sent.map(m => m.text).join("\n")));
step("exactly one message in total", sent.length === 1, `${sent.length} sent`);
if (searches.length) console.log(`(fake source asked ${searches.length} time(s))`);
const rows = db.db.prepare("SELECT outcome, COUNT(*) AS n FROM flight_searches GROUP BY outcome").all();
console.log(`(flight_searches: ${rows.map(r => `${r.outcome} ×${r.n}`).join(", ") || "none"})`);
await rt.shutdown?.();
process.exit(failed ? 1 : 0);
