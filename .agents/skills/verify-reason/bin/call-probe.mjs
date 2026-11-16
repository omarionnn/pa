// No-model call probe (cartesia-calls.md, call-trust.md, gptlive-calls.md, todo-list.md): Cartesia routing, the done-claim check, call trust levels + passphrase by text,
// call_recording_delete, the to-do plan. In process, throwaway DB, fake keys (never used on the wire).
// Usage: node .agents/skills/verify-reason/bin/call-probe.mjs <cartesia|trust|recordings|todo> [cagePort]
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const R = new URL("../../../../src", import.meta.url).pathname.replace(/\/$/, "");
const which = process.argv[2];
const port = process.argv[3];
const dir = mkdtempSync(join(tmpdir(), "g3-probe-"));
// trust over HTTP: logins.db sits beside REASON_DB_PATH, so keep the cage's own database (caged.sh env).
if (!(which === "trust" && port && process.env.REASON_VERIFY_RUN && process.env.REASON_DB_PATH?.startsWith(process.env.REASON_VERIFY_RUN))) process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Ola";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";
if (port) process.env.REASON_PUBLIC_URL = `http://127.0.0.1:${port}`;
let fails = 0;
const ok = (cond, what, extra = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${what}${extra ? " — " + extra : ""}`); if (!cond) fails++; };

const db = await import(`${R}/db.js`);
const { config } = await import(`${R}/config.js`);
const A = config.ownerConversation;
const B = "sendblue:+13105550000";
const C = "sendblue:+13105550001";
db.saveConversation(A, []); db.saveConversation(B, []); db.saveConversation(C, []);
db.upsertAccount({ conversationId: A, channel: "sendblue", address: "+12025551234", name: "Ola", isOperator: true });
db.upsertAccount({ conversationId: B, channel: "sendblue", address: "+13105550000", name: "Bea", isOperator: false });
db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+13105550001", name: "Cy", isOperator: false });
const owner = (t) => ({ role: "user", content: `[Sat, Nov 14, 2026, 3:00 PM] Ola: ${t}` });

if (which === "cartesia") {
  const trial = await import(`${R}/calls/calltrial.js`);
  const plan = await import(`${R}/plan.js`);
  const cart = await import(`${R}/calls/cartesia.js`);
  const own = (conv) => ({ id: 1, conversation_id: conv, is_owner: 1, direction: "in" });
  const errand = (conv) => ({ id: 2, conversation_id: conv, is_owner: 0, direction: "out" });
  Object.assign(config, { callCartesia: "on", cartesiaKey: "", cartesiaAgentId: "" });
  ok(trial.cartesiaTrialFor(own(A)) === false, "on, no Cartesia key/agent: GPT-Live");
  Object.assign(config, { cartesiaKey: "cage-fake", cartesiaAgentId: "cage-agent" });
  ok(trial.cartesiaTrialFor(own(A)) === true, "on: operator's own call → Cartesia");
  ok(trial.cartesiaTrialFor(own(B)) === true, "on: another account's own call → Cartesia (free tier off)");
  ok(trial.cartesiaTrialFor(errand(A)) === false, "on: a call to a business/person → never Cartesia");
  Object.assign(process.env, { REASON_PAYWALL: "on", REASON_FREE_TIER: "monthly" });
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(plan.shipTs() + 1000, B);
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(plan.shipTs() + 1000, C);
  db.db.prepare("INSERT INTO plan (conversation_id, status, first_seen_at, updated_at) VALUES (?, 'free', ?, ?)").run(C, Date.now() - 86_400_000, Date.now());
  ok(plan.callLimitSeconds(B) === plan.FREE_CALL_SECONDS, `monthly free tier: B's call limit ${plan.callLimitSeconds(B)} s`);
  ok(trial.cartesiaTrialFor(own(B)) === !plan.FREE_CALL_SECONDS, plan.FREE_CALL_SECONDS ? "free tier caller with a cut → GPT-Live" : "free tier caller, no cut → Cartesia");
  ok(trial.cartesiaTrialFor(own(C)) === true, "free-for-good caller → Cartesia");
  ok(trial.cartesiaTrialFor(own(A)) === true, "operator under the free tier → Cartesia");
  Object.assign(config, { callCartesia: "off" });
  ok(trial.cartesiaTrialFor(own(A)) === false, "off: never");
  ok(cart.saysDone("Yeah, it's done.") === true, "done claim: \"Yeah, it's done.\" flagged");
  ok(cart.saysDone("Okay, submitted.") === true, "done claim: \"Okay, submitted.\" flagged");
  ok(cart.saysDone("Is it booked?") === false, "a question is not a claim");
  ok(cart.saysDone("No worries, I'll look now.") === false, "\"no worries\" is not a claim");
  ok(cart.confirmsDone("Did it go through?", "Yes.") === true, "\"Did it go through?\" → \"Yes.\" counts as a claim");
  const lm = await import(`${R}/calls/lookupmusic.js`);
  ok(lm.lookupMusicMode !== undefined, `lookup music mode (unset env) = ${JSON.stringify(lm.lookupMusicMode())}`);
  ok(lm.MUSIC_DELAY_MS === 700, `music only after ${lm.MUSIC_DELAY_MS} ms of lookup`);
}

if (which === "trust") {
  process.env.REASON_CALL_TRUST = "owner";
  const callpass = await import(`${R}/callpass.js`);
  const ct = await import(`${R}/calls/calltrust.js`);
  ok(callpass.callTrustFor(A) === true, "owner mode: on for the operator");
  ok(callpass.callTrustFor(B) === false, "owner mode: off for anyone else");
  ok(callpass.fromText({ conversationId: B, text: "set my call passphrase" }) === null, "another account's 'set my call passphrase' → no code answer (normal turn)");
  const lvl = (n, i) => ct.levelOf(n, i, {});
  console.log("     levels:", JSON.stringify({ calendar_create: lvl("calendar_create", { title: "x" }), message_send: lvl("message_send", { to: "+12125550100", text: "hi" }),
    call_recording_delete: lvl("call_recording_delete", { all: true }), purchase_confirm: lvl("purchase_confirm", {}), weather: lvl("weather", {}), bank: lvl("bank", { action: "balances" }) }));
  ok(lvl("message_send", { to: "+12125550100", text: "hi" }) === "passphrase", "a text to someone else → passphrase");
  ok(lvl("purchase_confirm", {}) === "text", "money → text only");
  ok(lvl("call_recording_delete", { all: true }) === "passphrase", "call_recording_delete → passphrase");
  const none = callpass.fromText({ conversationId: A, text: "remove my call passphrase" });
  ok(none?.kind === "none_set", "remove with none set → " + none?.kind);
  const set = callpass.fromText({ conversationId: A, text: "set my call passphrase" });
  ok(set?.kind === "set_link" && /\/web\/call-passphrase\//.test(set.link ?? ""), "set by text → a link to Reason's own page", set?.reply);
  if (port && set?.link) {
    const url = new URL(set.link);
    const g = await fetch(url, { redirect: "manual" });
    const html = await g.text();
    ok(g.status === 200 && /<form/i.test(html), `GET the link on the cage → ${g.status}, a form`);
    const save = `${url.origin}${url.pathname}/save`;
    const bad = await fetch(save, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" }, body: "phrase=blue+heron+river+stone" });
    ok(bad.status === 403 && !callpass.hasPassphrase(A), `POST save from a cross-site Origin → ${bad.status}, nothing set`);
    const good = await fetch(save, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: url.origin }, body: "phrase=blue+heron+river+stone" });
    const gt = await good.text();
    ok(good.status < 400, `POST save same-origin → ${good.status}`, gt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120));
    ok(callpass.hasPassphrase(A) === true, "the passphrase is active at once (set on the page)");
    const reuse = await fetch(save, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: url.origin }, body: "phrase=other+words+here+now" });
    ok(reuse.status === 404, `the link is one-use: a second save → ${reuse.status}`);
    ok(callpass.check(A, "blue heron river stone")?.ok !== false, "check: the same words match → " + JSON.stringify(callpass.check(A, "blue heron river stone")));
    ok(callpass.check(A, "red heron river stone")?.ok !== true, "check: a wrong word (4 words) misses → " + JSON.stringify(callpass.check(A, "red heron river stone")));
    const exp = JSON.stringify(callpass.exportFor(A));
    ok(!/heron/.test(exp), "export says it is set, never a word", exp.slice(0, 160));
    const again = callpass.fromText({ conversationId: A, text: "set my call passphrase" });
    ok(again?.kind === "change_link", "set again with one active → the change link");
  }
}

if (which === "recordings") {
  const { runTool } = await import(`${R}/tools.js`);
  mkdirSync(config.recordingRoot, { recursive: true });
  const mk = (conv, state = "completed") => {
    const c = db.createCall(conv, { provider: "fake", toNumber: "+17185550188", isOwner: true, goal: "check in" });
    const file = join(config.recordingRoot, `call-${c.id}.mp3`);
    writeFileSync(file, Buffer.from("fake mp3 bytes"));
    db.db.prepare(`UPDATE calls SET state = ?, transcript = 'Reason: Hi.', summary = 'Fixture summary.', recording_state = 'stored', recording_file = ?,
      recording_format = 'mp3', recording_bytes = 14, recording_sha256 = 'abc', ended_at = ? WHERE id = ?`).run(state, file, Date.now(), c.id);
    return { id: c.id, file };
  };
  const ctx = (conv, t = "delete the recording of my last call") => ({ conversationId: conv, messages: [owner(t)] });
  const one = mk(A);
  const r1 = await runTool("call_recording_delete", { call_id: one.id }, ctx(A));
  const row = db.db.prepare("SELECT recording_state, recording_file, summary, transcript FROM calls WHERE id = ?").get(one.id);
  ok(r1.ok && r1.result === "deleted" && !existsSync(one.file), `one call → ${r1.result}, file gone=${!existsSync(one.file)}`);
  ok(row.recording_state === "deleted" && row.recording_file === null && row.summary && row.transcript, "row: state deleted, pointer cleared, summary + transcript kept");
  console.log("     note:", String(r1.note ?? "").slice(0, 220));
  const r2 = await runTool("call_recording_delete", { call_id: one.id }, ctx(A));
  ok(r2.result === "already_deleted" || /already/.test(JSON.stringify(r2)), "twice → already deleted", r2.result);
  const other = mk(B);
  const r3 = await runTool("call_recording_delete", { call_id: other.id }, ctx(A));
  ok(existsSync(other.file) && r3.result !== "deleted", "another account's call id → not touched", JSON.stringify(r3).slice(0, 120));
  const live = mk(A, "in_progress");
  const r4 = await runTool("call_recording_delete", { call_id: live.id }, ctx(A));
  ok(existsSync(live.file) && r4.result !== "deleted", "a call still going → refused", JSON.stringify(r4).slice(0, 140));
  mk(A); mk(A);
  const r5 = await runTool("call_recording_delete", { all: true }, ctx(A, "delete all my call recordings"));
  ok(r5.ok !== true || r5.result !== "deleted", "all without a yes → gated", JSON.stringify(r5).slice(0, 160));
}

if (which === "todo") {
  process.env.REASON_TODO = "on";
  const { runTool, toolsFor } = await import(`${R}/tools.js`);
  const LIST = { source: "text", title: "saturday", items: [
    { text: "Call plumber re: kitchen leak", short: "plumber", group: "mine", how: "call for the earliest slot", businesses: [{ name: "Joe's Plumbing", phone: "+12125550100" }] },
    { text: "haircut", short: "haircut", group: "mine", how: "book a cut", money: true, money_note: "about $40", businesses: [{ name: "Fade Masters", phone: "+12125550111" }] },
    { text: "gym", short: "gym", group: "theirs", how: "a reminder at 6pm" } ] };
  const names = (conv) => { try { return toolsFor(conv).map(t => t.name); } catch (e) { return String(e.message); } };
  ok(Array.isArray(names(B)) && names(B).includes("todo_plan"), "REASON_TODO=on: a non-operator account has todo_plan");
  const plan = await runTool("todo_plan", LIST, { conversationId: B, messages: [{ role: "user", content: "[Sat, Nov 14, 2026, 3:00 PM] Bea: here's my list" }] });
  ok(plan.ok === true, "todo_plan → ok, list " + plan.list_id, plan.error ?? "");
  const text = String(plan.say_exactly ?? plan.plan_text ?? plan.text ?? JSON.stringify(plan));
  ok(/Joe's Plumbing/i.test(text) && /Fade Masters/i.test(text) && /\$40/.test(text), "the plan names every business and the money");
  console.log("     plan:", text.replace(/\n/g, " | ").slice(0, 300));
  const ok2 = await runTool("todo_approve", { list_id: plan.list_id, confirmation_id: 999 }, { conversationId: B, messages: [] });
  ok(ok2.ok !== true, "todo_approve with no yes → refused", JSON.stringify(ok2).slice(0, 140));
}
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
