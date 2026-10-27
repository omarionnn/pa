// Reason Web, "Talk about it in the chat →" carries the row (owner, 10-27 01:15). One pinned test per rule:
//
//   1. every detail's chat link names its own row; NEEDS YOU opens the plain thread (their answer is theirs)
//   2. the thread opens with a draft about that row in the composer — never sent — fitting its state
//   3. the draft the title summarise wrote wins; it comes from the SAME call as the label (no call of its own)
//   4. a draft never carries their name, tool names or Reason's notes; a bad one falls back to the plain one
//   5. somebody else's row (or a made-up id) puts nothing in the line
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-talkdraft-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_WEB = "on";
delete process.env.REASON_BACKEND;

const db = await import("../src/db.js");
const og = await import("../src/ongoing.js");
const page = await import("../src/pages/webongoing.js");
const wc = await import("../src/pages/webconvo.js");
const it = await import("../src/itemtitle.js");
const { seedOngoing } = await import("./fixture-ongoing.js");
const { clock, config } = await import("../src/config.js");

const C = "dm:owner";
const K = "dm:fake:+14155559876";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  it.resetTitleQueue();
  db.db.exec(`DELETE FROM tasks; DELETE FROM task_log; DELETE FROM timers; DELETE FROM series; DELETE FROM confirmations; DELETE FROM agentcard_purchases;
    DELETE FROM accounts; DELETE FROM threads; DELETE FROM page_sessions;`);
  for (const [c, a, n, op] of [[C, "+12025551234", "Omari", true], [K, "+14155559876", "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
    db.markWebNoticeSeen(c);
  }
});

const words = (h) => h.replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const footHref = (html) => /<div class="ogd-foot"><a class="act[^"]*" href="([^"]+)"/.exec(html)?.[1];
const thread = (conv, about) => wc.conversationPage({ account: { conversation_id: conv, name: conv === C ? "Omari" : "Kofi" }, headers: {}, sendId: "s", query: { about } });
const composerText = (html) => {
  const m = /<textarea id="c-input"[^>]*>([^<]*)<\/textarea>/.exec(typeof html === "string" ? html : html.body);
  return m ? words(m[1]) : null;
};
const pageOf = (r) => (typeof r === "string" ? r : r.body);

test("1. every detail's chat link names its own row; NEEDS YOU opens the plain thread", () => {
  const ids = seedOngoing(C);
  for (const [kind, id] of [["task", ids.working], ["task", ids.waiting], ["task", ids.ready], ["task", ids.failed], ["series", ids.series], ["timer", ids.timer], ["approval", ids.approval]]) {
    const href = words(footHref(page.renderDetail(og.findItem(C, kind, id))));
    assert.equal(href, `/web?thread&about=${encodeURIComponent(`${kind}:${id}`)}`, `${kind} ${id}`);
  }
  const t = db.createTask(C, { title: "t", goal: "g", maxAttempts: 3, label: "Pick a venue" });
  db.db.prepare("UPDATE tasks SET state = 'waiting_on_you' WHERE id = ?").run(t.id);
  assert.equal(footHref(page.renderDetail(og.findItem(C, "task", t.id))), "/web?thread");
});

test("2. the thread opens with a draft about that row, fitting its state; never sent for them", () => {
  const ids = seedOngoing(C);
  const draft = (kind, id) => composerText(pageOf(thread(C, `${kind}:${id}`)));
  assert.equal(draft("task", ids.waiting), "Any word back from the store yet?", "waiting: asks for news, from who it's waiting on");
  assert.match(draft("task", ids.working), /^How's .+ going\?$/, "working: how it's going");
  assert.match(draft("series", ids.series), /^Can we change .+\?$/, "scheduled: offers to change it");
  assert.match(draft("timer", ids.timer), /^Can we change .+\?$/);
  assert.match(draft("task", ids.ready), /^Can I see .+\?$/, "ready: asks to see it");
  assert.match(draft("task", ids.failed), /^What's next for .+\?$/, "didn't work: what's next");
  assert.equal(draft("approval", ids.approval), "Can I see the details of the Target order?", "approval: asks for the details");
  // A label-only waiting row with nobody named: the plain per-state line from the label.
  const w = db.createTask(C, { title: "t", goal: "g", maxAttempts: 3, label: "Speedrun reply" });
  db.db.prepare("UPDATE tasks SET state = 'waiting_on_other' WHERE id = ?").run(w.id);
  assert.equal(draft("task", w.id), "Any news on Speedrun reply?");
  // In the composer only: the form still needs their tap, nothing is posted, and the outbox is untouched.
  const html = pageOf(thread(C, `task:${ids.waiting}`));
  assert.match(html, /<textarea id="c-input"[^>]*required data-draft>/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM outbox").get().n, 0);
  // The link drops ?about once drawn, so a refresh is the plain thread.
  assert.match(html, /q\.delete\('about'\)/);
  // The plain thread has an empty composer.
  assert.equal(composerText(pageOf(wc.conversationPage({ account: { conversation_id: C }, headers: {}, sendId: "s", query: { thread: "" } }))), "");
});

test("3. the summarise that writes the label writes the drafts too: one call, stored with the label, used first", async () => {
  const t = db.createTask(C, { title: "get speedrun to reply", goal: "a reply from Speedrun", maxAttempts: 3 });
  db.db.prepare("UPDATE tasks SET state = 'waiting_on_other' WHERE id = ?").run(t.id);
  let calls = 0, schema = null;
  const ask = async (q) => { calls++; schema = q.schema; return { value: { title: "Speedrun reply", drafts: { waiting: "Any word back from Speedrun yet?", working: "How's the Speedrun thing going?", stuck: "What's holding up Speedrun?", ready: "Can I see what Speedrun said?", failed: "What now with Speedrun?" } } }; };
  await it.queueTitle("task", C, t.id, t.title, { name: "Omari", ask });
  assert.equal(calls, 1, "no call of its own");
  assert.deepEqual(schema.required, ["title", "drafts"]);
  assert.deepEqual(schema.properties.drafts.required, ["waiting", "working", "stuck", "ready", "failed"]);
  const row = db.getTask(C, t.id);
  assert.equal(row.label, "Speedrun reply");
  assert.equal(JSON.parse(row.drafts).waiting, "Any word back from Speedrun yet?");
  assert.equal(composerText(pageOf(thread(C, `task:${t.id}`))), "Any word back from Speedrun yet?");
  // A timer is only ever scheduled: one draft asked for.
  const tm = db.createTimer(C, { fireAt: clock.now() + 3_600_000, note: "standing: twi practice" });
  await it.queueTitle("timer", C, tm.id, tm.note, { name: "Omari", ask: async (q) => { schema = q.schema; return { value: { title: "Twi practice", drafts: { scheduled: "Can we move my Twi practice?" } } }; } });
  assert.deepEqual(schema.properties.drafts.required, ["scheduled"]);
  assert.equal(composerText(pageOf(thread(C, `timer:${tm.id}`))), "Can we move my Twi practice?");
});

test("4. a draft never carries their name, tool names or Reason's notes; a bad one falls back to the plain line", async () => {
  assert.equal(it.normDraft("Did Omari hear back?", { name: "Omari" }), null);
  assert.equal(it.normDraft("Run timer_set again?", { name: "Omari" }), null);
  assert.equal(it.normDraft("He asked about the store, any news?", { name: "Omari" }), null);
  assert.equal(it.normDraft("The user wants an update", { name: "Omari" }), null);
  assert.equal(it.normDraft("  “any news on the refund?”  ", { name: "Omari" }), "Any news on the refund?");
  const t = db.createTask(C, { title: "t", goal: "g", maxAttempts: 3 });
  await it.queueTitle("task", C, t.id, "x", { name: "Omari", ask: async () => ({ value: { title: "Refund chase", drafts: { waiting: "Has Omari's refund landed?", working: "x_y", stuck: "", ready: "", failed: "" } } }) });
  assert.equal(db.getTask(C, t.id).drafts, null, "nothing usable: nothing stored");
  db.db.prepare("UPDATE tasks SET state = 'waiting_on_other' WHERE id = ?").run(t.id);
  assert.equal(composerText(pageOf(thread(C, `task:${t.id}`))), "Any news on Refund chase?");
  // The fallback is built from the label, never the note Reason wrote to itself.
  const n = db.createTask(C, { title: "Omari asked (Mon 4:38pm) to chase the refund via message_send", goal: "g", maxAttempts: 3, label: "Refund" });
  db.db.prepare("UPDATE tasks SET state = 'waiting_on_other' WHERE id = ?").run(n.id);
  const d = composerText(pageOf(thread(C, `task:${n.id}`)));
  assert.equal(d, "Any news on Refund?");
  assert.ok(!/Omari|asked|message_send/.test(d));
});

test("5. somebody else's row, a made-up id or a bad value puts nothing in the line", () => {
  const ids = seedOngoing(C);
  assert.equal(composerText(pageOf(thread(K, `task:${ids.waiting}`))), "", "Kofi's thread, Omari's row: nothing");
  assert.equal(composerText(pageOf(thread(C, "task:99999"))), "");
  assert.equal(composerText(pageOf(thread(C, "task:1 OR 1=1"))), "");
  assert.equal(composerText(pageOf(thread(C, `note:${ids.waiting}`))), "");
  // A draft is escaped like any other text on the page.
  const t = db.createTask(C, { title: "t", goal: "g", maxAttempts: 3, label: "</textarea><script>x</script>" });
  db.db.prepare("UPDATE tasks SET state = 'waiting_on_other' WHERE id = ?").run(t.id);
  const html = pageOf(thread(C, `task:${t.id}`));
  assert.ok(!/<script>x<\/script>/.test(html));
});
