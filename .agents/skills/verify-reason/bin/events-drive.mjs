#!/usr/bin/env node
// Drive the events feature end to end, in process, through the real Runtime, Router, outbox and a
// FakeChannel — the real delivery path with no way off this machine. Run under the cage's env so it
// gets its own database and every texting credential blanked:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env)" \
//     && REASON_DB_PATH=$(mktemp -d)/events.db node .agents/skills/verify-reason/bin/events-drive.mjs
//
// Prints one line per step, `ok` or `FAIL`, and exits non-zero on any FAIL. No model is called: every
// step is a tool call or a request a person's phone or browser would make.
process.env.REASON_EVENTS = process.env.REASON_EVENTS || "owner";
process.env.REASON_PAGES_URL = process.env.REASON_PAGES_URL || "https://files.example.test";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
// A throwaway database only: a new file in a temp directory. Never a real one.
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/events.db");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { FakeChannel } = await imp("src/channels/fake.js");
const { ConsoleChannel } = await imp("src/channels/console.js");
const { makeDeliver } = await imp("src/deliver.js");
const { runTool } = await imp("src/tools.js");
const events = await imp("src/events.js");
const db = await imp("src/db.js");
const { config } = await imp("src/config.js");

const OWNER = process.env.REASON_MASTER_NUMBER || "+12025551234";
const KOFI = "+14155550001", AMA = "+14155550002", YAW = "+14155550003";
const C = { owner: config.ownerConversation, kofi: `dm:fake:${KOFI}`, ama: `dm:fake:${AMA}`, yaw: `dm:fake:${YAW}` };

let failed = 0;
const step = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

const runtime = new Runtime({ runTurn: async () => "ok" });
const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
router.runtime = runtime;
const fake = router.register(new FakeChannel({ number: "+16562167455", failFor: YAW, failWith: "unreachable" }));
runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
for (const [c, addr, name, op] of [[C.owner, OWNER, "Omari", true], [C.kofi, KOFI, "Kofi"], [C.ama, AMA, "Ama"], [C.yaw, YAW, "Yaw"]]) {
  db.upsertAccount({ conversationId: c, channel: "fake", address: addr, name, isOperator: !!op });
  db.upsertThread({ conversationId: c, channel: "fake", address: addr, isOwner: true });
}
const tool = (name, input, c) => runTool(name, input, { conversationId: c, messages: [], events: runtime });
const toNum = (n) => fake.sent.filter(m => m.to === n).map(m => m.text);

// ---- creation (flag at owner: only the owner creates) ----
const kofiTry = await tool("event_create", { name: "x", description: "x", starts_at: "2026-10-31T21:00", location: "x", password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }, C.kofi);
step("REASON_EVENTS=owner: Kofi cannot create", kofiTry.blocked === "not_available");
const made = await tool("event_create", { name: "Halloween Party", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St", welcome_message: "so glad you're coming!", password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true }, C.owner);
step("owner creates with per-detail release", made.ok && made.event.time_shown_to_guests === true && made.event.location_shown_to_guests === false, made.share?.link);
const ev = db.getEventRow(made.event.event_id);
step("password stored only as scrypt", /^scrypt\$/.test(ev.password_hash) && !JSON.stringify(ev).includes("pumpkin"));

// ---- joining by text (existing users) ----
const bad = await tool("event_join", { name: "halloween party", password: "nope" }, C.ama);
step("Ama wrong password refused", bad.reason === "no_match");
const ama = await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, C.ama);
step("Ama joins by text; welcome sent through the outbox", ama.ok && ama.welcome_text === "sent" && toNum(AMA).some(t => /so glad you're coming/.test(t)));
step("Ama's welcome has the time, not the hidden address", toNum(AMA).some(t => /Oct 31/.test(t)) && !toNum(AMA).some(t => /Elm/.test(t)));
const link = events.eventUrl(ev);
const look = await tool("event_lookup", { link }, C.yaw);
step("pasted link shows name + description only", look.ok && Object.keys(look.event).sort().join() === "description,link,name,status");
const yaw = await tool("event_join", { link, password: "pumpkin" }, C.yaw);
step("Yaw joins by link (his line is set to fail)", yaw.ok && yaw.welcome_text === "failed");

// ---- organizer actions and delivery tracking ----
const blast = await tool("event_blast", { event_id: ev.id, message: "bring snacks" }, C.owner);
step("blast tracked per guest: 1 sent, 1 failed", blast.sent?.sent === 1 && blast.sent?.failed === 1, JSON.stringify(blast.sent));
const before = fake.sent.length;
await tool("event_blast", { event_id: ev.id, message: "bring snacks" }, C.owner);
step("the same blast again sends nothing new", fake.sent.length === before);
const rel = await tool("event_release", { event_id: ev.id, detail: "location" }, C.owner);
step("release texts the address", rel.ok && toNum(AMA).some(t => /where: 12 Elm St/.test(t)));
const iso = await tool("event_blast", { event_id: ev.id, message: "hijack" }, C.ama);
step("a guest cannot blast the organizer's event", iso.ok === false && !toNum(AMA).some(t => /hijack/.test(t)));
fake.failFor = "+10000000000"; // Yaw's line comes back
const retried = await events.retryFailed({ runtime, ev });
step("retry reaches Yaw once per failed message", retried.retried >= 2 && toNum(YAW).filter(t => /bring snacks/.test(t)).length === 1, JSON.stringify(retried));
const again = await events.retryFailed({ runtime, ev });
step("a second retry finds nothing failed", again.retried === 0);
const rot = await tool("event_password_rotate", { event_id: ev.id, new_password: "ghosts" }, C.owner);
step("rotation: old password dead", rot.ok && (await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, C.kofi)).ok === false);
const cancel = await tool("event_cancel", { event_id: ev.id }, C.owner);
step("cancellation reaches every guest", cancel.ok && toNum(AMA).some(t => /is cancelled/.test(t)) && toNum(YAW).some(t => /is cancelled/.test(t)));

await runtime.shutdown?.();
console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
