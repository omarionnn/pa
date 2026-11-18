#!/usr/bin/env node
// Drive the to-do list (REASON_TODO, src/todo.js) end to end on the REAL model, in process: src/http.js
// createServer on a loopback port, the real Router, Runtime, outbox and SendblueChannel (its fetch
// injected, so every text lands in this script's capture and nothing reaches Sendblue), the fake call
// provider switched ON (dials nothing, records what it was asked to say), and real claude-cli turns.
// Each inbound is a signed Sendblue webhook POSTed over HTTP, exactly what Sendblue sends.
//
// The road: a typed list → ONE plan text + a todo_approve ask → "yes" → the plan approved, a call to
// the business the plan named placed with NO second ask (the fake provider) → the checklist page
// redrawn → ONE wrap-up text, sent by the sweep's own to-do pass. 2–3 claude-cli turns: it spends the
// subscription live Reason replies on, so run it once per change, never in a loop.
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_BACKEND=claude-cli REASON_TEST_NUMBERS=+12025551234 REASON_MASTER_NUMBER=+12025551234 \
//        REASON_DB_PATH=$(mktemp -d)/todo.db node .agents/skills/verify-reason/bin/todo-drive.mjs [outdir]
//
// One line per step, `ok` or `FAIL`; exits non-zero on any FAIL. With an outdir it writes the texts
// Reason sent (texts.json), the checklist page's HTML at each stage (checklist-*.html) and the rows.
process.env.REASON_TODO = "owner";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER ||= process.env.REASON_MASTER_NUMBER || "+12025551234";
process.env.REASON_MASTER_NUMBER ||= process.env.REASON_OWNER_NUMBER;
process.env.REASON_OWNER_NAME ||= "Omari";
process.env.REASON_TZ ||= "America/New_York";
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";
// Sendblue reads `live` with these, and the injected fetch below is the only thing it ever calls.
process.env.SENDBLUE_API_KEY_ID = "drive-fake";
process.env.SENDBLUE_API_SECRET_KEY = "drive-fake";
process.env.SENDBLUE_FROM_NUMBER = "+12025550101";
process.env.SENDBLUE_WEBHOOK_SECRET = "drive-secret";
process.env.SENDBLUE_API_BASE = "http://127.0.0.1:9";
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/todo.db");
    process.exit(2);
  }
  process.env.REASON_DATA_DIR ||= dirname(db) + "/data";
  process.env.REASON_RECORDING_ROOT ||= dirname(db) + "/recordings";
}
for (const k of ["ANTHROPIC_API_KEY", "LINQ_API_KEY", "TWILIO_AUTH_TOKEN", "BLAND_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
if (process.env.REASON_BACKEND !== "claude-cli" || !process.env.REASON_TEST_NUMBERS) {
  console.error("refusing: this drive is the real model on the subscription — set REASON_BACKEND=claude-cli and REASON_TEST_NUMBERS");
  process.exit(2);
}

const { mkdirSync, writeFileSync } = await import("node:fs");
const out = process.argv[2] || null;
if (out) mkdirSync(out, { recursive: true });

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Router } = await imp("src/channels/router.js");
const { SendblueChannel } = await imp("src/channels/sendblue.js");
const { ConsoleChannel } = await imp("src/channels/console.js");
const { Runtime } = await imp("src/runtime.js");
const { FakeCallProvider } = await imp("src/calls/fake.js");
const { makeDeliver } = await imp("src/deliver.js");
const { createServer } = await imp("src/http.js");
const { renderPage } = await imp("src/pages/render.js");
const todo = await imp("src/todo.js");
const notice = await imp("src/notice.js");
const { isPaused } = await imp("src/pause.js");
const db = await imp("src/db.js");
const { clock } = await imp("src/config.js");

const OWNER = process.env.REASON_OWNER_NUMBER;
const CONV = "dm:owner";
const PLUMBER = "+12125550100";
let failed = 0;
const step = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`); };

// Every text Reason sends, as Sendblue would have received it.
const texts = [];
let handles = 0;
const fetchImpl = async (url, init = {}) => {
  const u = String(url);
  if ((init.method ?? "GET") === "POST" && /send-message|send-group-message/.test(u)) {
    let body = {};
    try { body = JSON.parse(init.body); } catch {}
    texts.push({ at: clock.now(), to: body.number, content: body.content ?? "", media: body.media_url ?? null });
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `drive-out-${++handles}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (/upload-file/.test(u)) {
    return new Response(JSON.stringify({ status: "OK", media_url: `https://cdn.example.test/drive-${++handles}.wav` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ data: [], messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
};

const logs = [];
const log = (e) => logs.push(e);
const calls = new FakeCallProvider();
const router = new Router({ log });
const consoleChannel = new ConsoleChannel({ write: () => {} });
const deliver = makeDeliver({ router, consoleChannel, log, warn: () => {} });
const runtime = new Runtime({ log, channels: router, calls, deliver });
router.runtime = runtime;
router.register(consoleChannel);
router.register(new SendblueChannel({ fetchImpl }));
runtime.on("outbound", async (e) => { await deliver({ ...e, media: null }); });
const server = createServer({ router, runtime, log });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

/** POST one signed Sendblue webhook, then wait for the turn it starts to end. */
async function inbound(content) {
  const mark = logs.length;
  const handle = `drive-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const res = await fetch(`http://127.0.0.1:${port}/channels/sendblue/webhook`, {
    method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": "drive-secret" },
    body: JSON.stringify({ content, number: OWNER, from_number: OWNER, is_outbound: false, status: "RECEIVED", message_type: "message", message_handle: handle, date_sent: new Date().toISOString() }),
  });
  const body = await res.json().catch(() => ({}));
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    if (logs.slice(mark).some(e => e?.cli?.stop || e?.turn_failed)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 1500));
  await runtime.outbox();
  const tools = logs.slice(mark).filter(e => e?.tool).map(e => e.tool);
  return { status: res.status, body, tools };
}

const listNow = () => db.listTodoLists(CONV, { includeClosed: true })[0] ?? null;
const pageOf = (l) => (l?.page_id ? db.getPageIn(CONV, l.page_id) : null);
const save = (name, page) => { if (out && page) writeFileSync(`${out}/${name}`, renderPage(page, { interactive: false, forName: "" })); };

// 1. The list, typed.
// The rent reminder is always the coming Friday, so the date the drive types never falls in the past.
const FRI = (() => { const d = new Date(); d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7)); return "friday " + d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase(); })();
const LIST = `here's my to-do list for tomorrow:\n- call Joe's Plumbing (212) 555-0100 and ask if they can come look at the kitchen leak this week\n- gym\n- remind me to pay rent ${FRI} at 9am`;
const t1 = await inbound(LIST);
step("webhook accepted the list", t1.status === 200, JSON.stringify(t1.body));
let list = listNow();
step("the model made the plan with todo_plan", t1.tools.includes("todo_plan") && list?.state === "planning", t1.tools.join(","));
const items1 = list ? db.todoItems(list.id) : [];
step("every line of the list is an item", items1.length === 3, items1.map(i => `${i.n}:${i.grp}:${i.short}`).join(" | "));
const plumber = items1.find(i => i.businesses.some(b => b.phone === PLUMBER));
step("Joe's Plumbing is on the plan as a business with its number", !!plumber, JSON.stringify(items1.map(i => i.businesses)));
const ask = db.pendingConfirmations(CONV).find(c => c.action === "todo_approve" && !c.granted_at);
step("one approval ask, pinned to the plan", !!ask && ask.target === todo.approvalTarget(CONV, list?.id), ask?.target);
const planText = texts.map(t => t.content).find(t => /here's the plan/.test(t)) ?? "";
step("ONE plan text went out, naming the business", texts.length >= 1 && /Joe's Plumbing/.test(planText) && texts.filter(t => /here's the plan/.test(t.content)).length === 1, planText.split("\n")[0]);
step("nothing was called before the yes", calls.placed.length === 0);
const page0 = pageOf(list);
step("the checklist page exists, waiting on the go-ahead", page0?.blocks?.[0]?.headline === "Waiting for your go-ahead");
save("checklist-1-planning.html", page0);
if (out) writeFileSync(`${out}/plan.txt`, planText);

// 2. Yes — and answer the one question if the plan asked one.
const t2 = await inbound(`yes go ahead. ${FRI} at 9am is right for rent`);
list = listNow();
step("the yes was recorded and the plan approved", list?.state === "approved" && t2.tools.includes("todo_approve"), `${list?.state} · ${t2.tools.join(",")}`);
step("the yes is their own words on the list", !!list?.approved_quote, list?.approved_quote);
const page1 = pageOf(list);
step("the checklist page was redrawn", (page1?.revision ?? 0) > (page0?.revision ?? 0), `rev ${page0?.revision} → ${page1?.revision}`);
save("checklist-2-working.html", page1);

// 3. Anything the turn left running gets one task wake (the sweep's own pass), then the wrap-up.
for (let i = 0; i < 3; i++) {
  const items = db.todoItems(list.id);
  if (items.every(x => x.grp === "theirs" || ["done", "waiting", "failed", "stuck", "dropped"].includes(x.status))) break;
  // Time moves to the job's own wake (the model may well have said "i'll call them tomorrow at 10" on
  // a Friday evening — calling hours are its call to make), so the wake is the one it asked for.
  const due = db.db.prepare("SELECT MIN(next_wake_at) AS at FROM tasks WHERE conversation_id = ? AND next_wake_at IS NOT NULL AND state IN ('running','waiting_on_other','waiting')").get(CONV)?.at;
  if (due && due > clock.now()) clock.skip(due - clock.now() + 1000);
  const mark = logs.length;
  await runtime.runTasks();
  await runtime.outbox();
  step(`task wake pass ${i + 1}`, true, logs.slice(mark).filter(e => e?.tool).map(e => e.tool).join(",") || "nothing to do");
}
// The call: in the yes turn, or on the job's own wake if the model chose a time (both are fine).
const placed = calls.placed.find(p => p.to === PLUMBER);
step("Joe's Plumbing was called with no second ask", !!placed && !db.pendingConfirmations(CONV).some(c => c.action === "call_place"), calls.placed.map(p => p.to).join(","));
step("the call still opened with the AI disclosure and the recording notice", !!placed && /AI/.test(placed.announcement) && /record/i.test(placed.announcement), placed?.announcement);
const ledger = db.listActions(CONV).find(a => a.action === "call_place" && a.outcome === "ok");
step("its receipt says no yes was asked, and why", !!ledger && /No yes was asked for/.test(ledger.receipt), ledger?.receipt);
const settledItems = db.todoItems(list.id);
step("every item is done, waiting or theirs", settledItems.every(x => x.grp === "theirs" || ["done", "waiting", "failed", "stuck", "dropped"].includes(x.status)),
  settledItems.map(i => `${i.n}:${i.grp}:${i.status}`).join(" | "));
step("at least one item is done", settledItems.some(i => i.status === "done"));

clock.skip(todo.WRAP_QUIET_MS + 1000);
const before = texts.length;
const wrapped = todo.wrapUps({ say: (c, text, meta) => runtime.say(c, text, meta), inTheirNight: (c, now) => notice.inTheirNight(c, now), isPaused, log });
await new Promise(r => setTimeout(r, 500));
await runtime.outbox();
const wrapText = texts.slice(before).map(t => t.content).join("\n");
// The link may go as its own bubble (the adapter's link handling); the summary is one text.
step("ONE wrap-up text, written by code", wrapped.wrapped === 1 && texts.slice(before).filter(t => /\d+ of 3 done/.test(t.content)).length === 1, wrapText);
step("it carries the checklist link", wrapText.includes("/p/") || wrapText.includes(process.env.REASON_PUBLIC_URL));
const again = todo.wrapUps({ say: (c, text, meta) => runtime.say(c, text, meta) });
step("and never a second", again.wrapped === 0);
const page2 = pageOf(db.getTodoList(CONV, list.id));
save("checklist-3-wrapped.html", page2);
if (out) {
  writeFileSync(`${out}/texts.json`, JSON.stringify(texts, null, 2));
  writeFileSync(`${out}/rows.json`, JSON.stringify({ list: db.getTodoList(CONV, list.id), items: db.todoItems(list.id), calls: calls.placed, ledger: db.listActions(CONV),
    thread: db.recentMessages(CONV, { limit: 60 }), outbox: db.db.prepare("SELECT id, state, last_error, substr(body, 1, 300) AS body FROM outbox ORDER BY id").all() }, null, 2));
}

server.closeAllConnections?.();
server.close();
console.log(failed ? `\n${failed} FAIL` : "\nall ok");
process.exit(failed ? 1 : 0);
