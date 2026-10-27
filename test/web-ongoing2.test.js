// Reason Web, Ongoing tidy (owner, 10-26). One pinned test per approved change:
//
//   1. top 3 rows only — needs-you first, then soonest due — and "See all N →" opens the rest in place
//   2. "HIDE →" beside the Ongoing heading; "ONGOING N" in the top bar brings it back; kept per device
//   3. the top bar stays pinned while the thread scrolls; "Show earlier messages" stays in the thread
//   4. each row shows a short plain title written once when it is made (the model's, or one
//      claude-cli summarise), never the person's name; the cleaned note only until it has one
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "reason-ongoing2-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_WEB = "on";
delete process.env.REASON_BACKEND;

const wc = await import("../src/pages/webconvo.js");
const kit = await import("../src/pages/webkit.js");
const it = await import("../src/itemtitle.js");
const db = await import("../src/db.js");
const series = await import("../src/series.js");
const { clock } = await import("../src/config.js");

const C = "dm:owner";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  it.resetTitleQueue();
  db.db.exec("DELETE FROM tasks; DELETE FROM timers; DELETE FROM series; DELETE FROM confirmations;");
});

const H = 60 * 60_000;
const page = (opts = {}) => wc.renderConversation({ account: { conversation_id: C, name: "Omari" }, csrf: "c", lines: [], more: false, sendId: "s", items: wc.inHand(C), approvals: [], ...opts });

test("1. three rows show: needs-you first, then soonest due; See all N → opens the rest, Show fewer folds them", () => {
  const now = clock.now();
  db.createTimer(C, { fireAt: now + 9 * H, note: "n", label: "Late one" });
  db.createTimer(C, { fireAt: now + 1 * H, note: "n", label: "Soonest" });
  db.createTimer(C, { fireAt: now + 3 * H, note: "n", label: "Second" });
  db.createTimer(C, { fireAt: now + 5 * H, note: "n", label: "Third" });
  const t = db.createTask(C, { title: "t", goal: "g", maxAttempts: 3, label: "Speedrun reply", wakeAt: now + 20 * H });
  db.db.prepare("UPDATE tasks SET state = 'waiting_on_you' WHERE id = ?").run(t.id);
  assert.deepEqual(wc.inHand(C).map(x => x.title), ["Speedrun reply", "Soonest", "Second", "Third", "Late one"]);

  const s = page();
  const shown = [...s.matchAll(/<div class="og-row( og-x)?"><b>([^<]+)<\/b>/g)].map(m => [m[2], !m[1]]);
  assert.deepEqual(shown, [["Speedrun reply", true], ["Soonest", true], ["Second", true], ["Third", false], ["Late one", false]]);
  assert.match(s, /<a class="og-all" href="\/web\?thread&amp;all=1" aria-controls="og" aria-expanded="false" data-n="5">See all 5 <span aria-hidden="true">→<\/span><\/a><\/aside>/);
  assert.match(s, /\.og \.og-x\{display:none\}\n\.og\.all \.og-x\{display:flex\}/);
  assert.ok(!/class="card[^"]*og-all|og-all[^{]*\{[^}]*border:1px/.test(s), "a quiet text action, no box");
  // In place, by script; and the same list drawn open without it.
  assert.match(s, /var open=og\.classList\.toggle\('all'\)/);
  const open = page({ all: true });
  assert.match(open, /<aside class="og all" id="og" aria-label="Ongoing">/);
  assert.match(open, /aria-expanded="true" data-n="5">Show fewer<\/a>/);
  // Three or fewer: no See all at all.
  db.db.exec("DELETE FROM timers");
  assert.ok(!page().includes("og-all\""));
  // The mobile tab: the same three and See all, under its own heading, Chat/Ongoing tabs kept.
  for (let i = 0; i < 4; i++) db.createTimer(C, { fireAt: now + (i + 1) * H, note: "n", label: `R${i}` });
  const tab = wc.renderOngoing({ csrf: "c", items: wc.inHand(C), approvals: [] });
  assert.match(tab, /<aside class="og og-tab" id="og" aria-label="Ongoing"><section class="og-sec">/);
  assert.match(tab, /href="\/web\?tab=ongoing&amp;all=1"[^>]*>See all 5 /);
  assert.match(tab, /<nav class="tabs" aria-label="Sections">/);
});

test("2. HIDE → beside the heading; the thread takes the width; ONGOING N in the top bar; remembered per device", () => {
  db.createTimer(C, { fireAt: clock.now() + H, note: "n", label: "One" });
  const s = page();
  assert.match(s, /<div class="og-h"><h2>Ongoing<\/h2><button class="act2 og-hide" type="button" aria-controls="og" aria-expanded="true">HIDE <span aria-hidden="true">→<\/span><\/button><\/div>/);
  assert.match(s, /<nav aria-label="Account"><a class="act2 og-back" href="#og" aria-controls="og">ONGOING 1<\/a>/);
  assert.match(s, /\.og-back\{display:none\}/);
  assert.match(s, /html\.og-off \.wrapc>\.og\{display:none\}/);
  assert.match(s, /html\.og-off \.og-back\{display:inline-flex\}/);
  assert.match(s, /\.og\.going\{transform:translateX\(48px\);opacity:0\}/, "slides away");
  assert.match(s, /\.convo\{flex:999 1 540px/, "the thread grows into the room");
  // Applied before first paint, so a hidden panel never flashes in.
  assert.equal(kit.OG_KEY, "reason-web-og");
  assert.match(s, /<script>\(function\(\)\{try\{[^<]*if\(localStorage\.getItem\('reason-web-og'\)==='off'\)h\.classList\.add\('og-off'\)/);
  assert.match(s, /localStorage\.setItem\('reason-web-og','off'\)/);
  assert.match(s, /localStorage\.removeItem\('reason-web-og'\)/);
  // The mobile tab has no Hide: it is a tab.
  assert.ok(!wc.renderOngoing({ csrf: "c", items: wc.inHand(C) }).includes('class="act2 og-hide"'));
});

test("3. the top bar stays pinned with a dashed rule once scrolled; Show earlier messages stays in the thread", () => {
  const s = page({ lines: [{ id: 1, at: clock.now(), role: "user", html: "x", web: true }], more: true });
  assert.match(s, /\.top\{position:sticky;top:0;z-index:20;background:var\(--ground\);[^}]*border-bottom:1px dashed transparent/);
  assert.match(s, /\.top\.stuck\{border-bottom-color:var\(--hair\)\}/);
  assert.match(s, /bar\.classList\.toggle\('stuck',window\.scrollY>4\)/);
  assert.match(s, /<header class="top"><a class="wm"[^]*<\/header>/);
  const header = s.slice(s.indexOf('<header class="top">'), s.indexOf("</header>"));
  assert.ok(!header.includes("EARLIER"), "not in the sticky bar");
  assert.match(s, /<section class="convo"[^>]*><h1[^>]*>[^<]*<\/h1><div class="start"><button class="act2" type="button">↑ SHOW EARLIER MESSAGES<\/button><\/div>/);
  assert.match(s, /\.og\{[^}]*position:sticky;top:104px/, "the margin sits under the bar, not behind it");
});

test("4a. the row's own title is shown; until then the note, cleaned of Reason's prefixes and the name", () => {
  const now = clock.now();
  db.createTimer(C, { fireAt: now + H, note: "Omari asked (Mon 4:38pm) to be reminded to update his Speedrun SR008 application", label: "Speedrun update" });
  db.createTimer(C, { fireAt: now + 2 * H, note: "standing check-in: daily gua sha reminder at 10:30pm, when Omari actually does it" });
  db.createTask(C, { title: "text omari when speedrun replies", goal: "g", maxAttempts: 3, wakeAt: now + 3 * H });
  const titles = wc.inHand(C).map(x => x.title);
  assert.equal(titles[0], "Speedrun update");
  for (const t of titles) assert.ok(!/omari/i.test(t), `no third-person name: ${t}`);
  for (const t of titles) assert.ok(!/asked \(|standing check-in/i.test(t), t);
  assert.equal(it.cleanTitle("Omari asked (Mon 4:38pm) to be reminded to increase his Reason invite count so he has invites", { name: "Omari" }), "Increase his Reason invite count so");
  assert.equal(it.cleanTitle("standing check-in: daily gua sha reminder at 10:30pm, when Omari actually does it", { name: "Omari" }), "Daily gua sha reminder at 10:30pm");
  assert.equal(it.cleanTitle("daily challenge: remind Omari to work out today (oct workout + gua sha challenge)", { name: "Omari" }), "Work out today");
  assert.equal(it.cleanTitle("text omari when speedrun replies", { name: "Omari Inyarko" }), "Text you when speedrun replies");
});

test("4b. a title is the model's: normTitle keeps it short and never lets the person's name through", () => {
  assert.equal(it.normTitle("  daily Twi check-in. ", { name: "Omari" }), "Daily Twi check-in");
  assert.equal(it.normTitle("Remind Omari about Speedrun", { name: "Omari" }), null);
  assert.equal(it.normTitle("one two three four five six seven eight"), "One two three four five six");
  assert.equal(it.normTitle(""), null);
  assert.match(it.TITLE_HINT, /2-5 words/);
  assert.match(it.TITLE_HINT, /Never their name/);
});

test("4c. timer_set and task_start take the model's title; series firings carry their series' title", async () => {
  const tools = await import("../src/tools.js");
  const find = (n) => tools.tools.find(d => d.name === n);
  assert.equal(find("timer_set").input_schema.properties.title.description, it.TITLE_HINT);
  assert.equal(find("task_start").input_schema.properties.short_title.description, it.TITLE_HINT);
  const started = series.start({ conversationId: C, what: "how the Twi practice is going", repeat: { kind: "daily", hour: 9 }, label: "Daily Twi check-in" });
  assert.equal(started.ok, true);
  assert.equal(db.listTimers(C)[0].label, "Daily Twi check-in");
  assert.equal(wc.inHand(C)[0].title, "Daily Twi check-in");
});

test("4d. no title yet: ONE background summarise per row, written once, never over the model's; never the API", async () => {
  const t = db.createTimer(C, { fireAt: clock.now() + H, note: "Omari asked to spend Tue prepping for Wed: Product Hunt launch" });
  let calls = 0;
  const ask = async ({ prompt, feature }) => { calls++; assert.equal(feature, "title"); assert.match(prompt, /must NOT appear: Omari/); return { value: { title: "Prep for Wednesday" } }; };
  await it.queueTitle("timer", C, t.id, t.note, { name: "Omari", ask });
  assert.equal(it.queueTitle("timer", C, t.id, t.note, { name: "Omari", ask }), null, "asked once per row");
  assert.equal(calls, 1);
  assert.equal(db.getTimer(C, t.id).label, "Prep for Wednesday");
  assert.equal(db.setItemLabel("timer", C, t.id, "Something else"), false, "written once");
  assert.equal(db.getTimer(C, t.id).label, "Prep for Wednesday");
  // A title that names them is dropped; the row keeps the cleaned note.
  const u = db.createTimer(C, { fireAt: clock.now() + 2 * H, note: "remind Omari to stretch" });
  await it.queueTitle("timer", C, u.id, u.note, { name: "Omari", ask: async () => ({ value: { title: "Omari's stretch" } }) });
  assert.equal(db.getTimer(C, u.id).label, null);
  // Without the claude-cli backend nothing is asked at all: there is no API path for titles.
  assert.equal(process.env.REASON_BACKEND, undefined);
  assert.equal(await it.summariseTitle("anything"), null);
  assert.equal(it.queueTitle("timer", C, 999, "x"), null);
  process.env.REASON_BACKEND = "claude-cli";
  try {
    assert.equal(await it.summariseTitle("anything"), null, "never the real CLI under the test runner");
    assert.equal(it.queueTitle("timer", C, 998, "x"), null);
  } finally { delete process.env.REASON_BACKEND; }
  // A series' title reaches its pending firing.
  const s = series.start({ conversationId: C, what: "gua sha", repeat: { kind: "daily", hour: 22 } });
  db.setItemLabel("series", C, s.series.series_id, "Daily gua sha");
  assert.equal(db.getTimer(C, s.timer_id).label, "Daily gua sha");
});

test("4e. the backfill refuses without the claude-cli backend and changes nothing", () => {
  const copy = join(dir, "copy.db");
  db.createTimer(C, { fireAt: clock.now() + H, note: "standing check-in: x" });
  db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(process.env.REASON_DB_PATH, copy);
  let code = 0, out = "";
  try { execFileSync(process.execPath, ["scripts/backfill-item-titles.js", `--db=${copy}`, "--write"], { env: { PATH: process.env.PATH, REASON_DATA_DIR: dir }, stdio: "pipe" }); }
  catch (e) { code = e.status; out = String(e.stderr); }
  assert.equal(code, 1);
  assert.match(out, /not claude-cli/);
});
