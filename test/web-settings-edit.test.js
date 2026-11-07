// Reason Web Settings, v2 edit states (handoff v2 §4c items 5, reference sheet-settings-edit 5A–5D)
// and §4d L8, plus the switch living in Settings only (staging review 6):
//
//   - 5A: a dashed phrase opens the radio list of four, each with its line; Save → / CANCEL
//   - 5B: each value saves and shows its sentence and Caveat line
//   - the four values are honoured by delivery (src/deliver.js keptOnWeb); the two stored before v2
//     keep their meaning, so nobody's delivery changed; codes, operator lines, keyed system messages,
//     replies and recordings are texted under every setting
//   - 5C: Sign out everywhere asks first with the real count
//   - 5D: a new invite link to copy/share, the count dropped; canceling an unused invite gives it back
//   - L8: busy words, muted, never twice
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-settings-edit-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";
delete process.env.REASON_INVITES_OPEN;
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key

const { webRequestFor } = await import("../src/http.js");
const st = await import("../src/pages/websettings.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver, keptOnWeb } = await import("../src/deliver.js");
const invites = await import("../src/invites.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const KOFI = "+14155559876";
const OWNER_C = "dm:owner";
const KOFI_C = `dm:fake:${KOFI}`;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const WIN_FF = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  config.invitesOpen = false;
  db.db.exec(`DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM messages;
    DELETE FROM page_sessions; DELETE FROM oauth_tokens; DELETE FROM agentcard_users; DELETE FROM invites; DELETE FROM invite_allowances;
    DELETE FROM tasks; DELETE FROM inbound_messages; DELETE FROM event_log;`);
  for (const [c, a, n, op] of [[OWNER_C, OWNER, "Omari", true], [KOFI_C, KOFI, "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");
});

function harness({ turn = async () => "ok" } = {}) {
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), channels: router, deliver, runTurn: async (args) => turn(args) });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+16562167455" }));
  const web = router.register(new WebChannel());
  // As src/serve.js wires it: `say` lines carry toMaster through.
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo, toMaster }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo, toMaster: !!toMaster });
  });
  return { router, runtime, deliver, fake, web, logs };
}

let n = 0;
/** A signed-in browser for this conversation, as W1's code step leaves it, used from `ua`. */
function browser(conversationId, ua = MAC_CHROME) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { token, conv: conversationId, ua, cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token) };
}
const headersFor = (b, extra = {}) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie, "user-agent": b.ua } : {}), ...extra });
async function call(h, { sub = "settings", method = "GET", b = null, query = {}, body = null, headers = {} } = {}) {
  return await webRequestFor({ sub, method, query, headers: headersFor(b, headers), remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router, log: (e) => h.logs.push(e) });
}
const post = (h, b, fields, { csrf = b.csrf, headers = {} } = {}) => call(h, { method: "POST", b, body: new URLSearchParams({ c: csrf, ...fields }).toString(), headers });
const page = async (h, b) => { const out = await call(h, { b }); assert.equal(out.status, 200); return out.body; };
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); return pred(); };
const opens = async (h, b) => (await call(h, { sub: null, b })).body.includes("st-h1") || (await call(h, { b })).status === 200;


// ---------- 5A / 5B: How Reason reaches you, four ways ----------

test("5A: tapping a phrase opens the radio list of four, current one checked, each with its line; Save → / CANCEL", async () => {
  const h = harness();
  const me = browser(OWNER_C);
  db.setWebReach(OWNER_C, "web");
  const out = await call(h, { b: me, query: { edit: "reach" } });
  assert.equal(out.status, 200);
  const body = out.body;
  assert.match(body, /<a class="act2" href="\/web\/settings#reach">← SETTINGS<\/a>/);
  assert.match(body, /<h1 class="sub-l" id="re-h">HOW REASON REACHES YOU<\/h1>/);
  assert.match(body, /<p class="re-p" aria-hidden="true">Text me for <em class="re-pick">timely decisions<\/em>\.<\/p>/);
  assert.match(body, /<div class="ro-g" role="radiogroup" aria-label="Text me for">/);
  const opts = [...body.matchAll(/<label class="ro"><input type="radio" name="reach" value="(\w+)" data-name="([^"]+)"( checked)?><span class="ro-d" aria-hidden="true"><\/span><span class="ro-t"><span class="ro-n">([^<]+)<\/span><span class="ro-l">([^<]+)<\/span><\/span><\/label>/g)]
    .map(m => [m[1], m[4], m[5], !!m[3]]);
  assert.deepEqual(opts, [
    ["web", "timely decisions", "Approvals and anything with a deadline today.", true],
    ["text", "everything", "Every update, as it happens.", false],
    ["yes", "only what needs a yes", "Approvals only. Everything else waits here.", false],
    ["none", "nothing", "Keep it all on the web.", false],
  ]);
  assert.match(body, /<button class="sub-go" type="submit" data-busy="Saving…">Save <span aria-hidden="true">→<\/span><\/button><a class="act2 sub-c" href="\/web\/settings#reach">CANCEL<\/a>/);
  assert.match(body, new RegExp(`<input type="hidden" name="c" value="${me.csrf}"><input type="hidden" name="do" value="reach">`), "a real form, no script needed");
  // The radio's own focus ring and 52px rows (§5).
  assert.match(body, /\.ro\{position:relative;min-height:52px/);
  assert.match(body, /\.ro:focus-within\{outline:2px solid var\(--ink\)/);
  // The sentence follows the choice when script runs.
  assert.match(body, /pick\.textContent=i\.dataset\.name/);
});

test("5B: each of the four saves, and shows its sentence and Caveat line", async () => {
  const h = harness();
  const me = browser(OWNER_C);
  const want = {
    yes: ["only what needs a yes", "everything else", "got it. i&#39;ll only text when i need a yes."],
    none: ["nothing", "it all", "got it. i&#39;ll keep it all here."],
    web: ["timely decisions", "routine results", "got it. i&#39;ll text when something can&#39;t wait."],
    text: ["everything", "a copy", "got it. i&#39;ll text you everything, and keep a copy here."],
  };
  for (const [v, [a, b, said]] of Object.entries(want)) {
    const out = await post(h, me, { do: "reach", reach: v });
    assert.equal(out.headers.Location, "/web/settings?saved=reach");
    assert.equal(db.webReach(OWNER_C), v);
    const body = (await call(h, { b: me, query: { saved: "reach" } })).body;
    assert.match(body, new RegExp(`<p class="re-p">Text me for <a class="ph" href="/web/settings\\?edit=reach">${a}</a>\\. Keep <a class="ph" href="/web/settings\\?edit=reach">${b}</a> here\\.</p><p class="hand tilt" role="status">${said}</p>`), v);
    assert.match(body, /← SETTINGS/);
  }
  assert.equal(db.webReach(KOFI_C), "text", "only this person's");
  // JSON for a script.
  const js = await post(h, me, { do: "reach", reach: "yes" }, { headers: { accept: "application/json" } });
  assert.deepEqual(JSON.parse(js.body), { ok: true, reach: "yes" });
  db.setWebReach(OWNER_C, "text");
});

test("the four values: the two stored before v2 keep their meaning; anything unknown reads as everything", () => {
  assert.deepEqual(db.WEB_REACH_VALUES, ["web", "text", "yes", "none"]);
  for (const v of ["yes", "none", "web", "text"]) { db.setWebReach(OWNER_C, v); assert.equal(db.webReach(OWNER_C), v); }
  db.db.prepare("UPDATE accounts SET web_reach = NULL WHERE conversation_id = ?").run(OWNER_C);
  assert.equal(db.webReach(OWNER_C), "text", "never chosen: texted, as ever");
  db.db.prepare("UPDATE accounts SET web_reach = 'loud' WHERE conversation_id = ?").run(OWNER_C);
  assert.equal(db.webReach(OWNER_C), "text");
  assert.throws(() => db.setWebReach(OWNER_C, "loud"));
});

function doneTask(conv, title = "find a dentist") {
  const t = db.createTask(conv, { title, goal: title, maxAttempts: 5 });
  db.finishTask(conv, t.id, { state: "done", outcome: "found one" });
  return t.id;
}
const route = (o = {}) => ({ channel: "fake", to: OWNER, started: true, ...o });

test("delivery honours all four: what is kept on Web under each, and what is always texted", async () => {
  const h = harness();
  const done = doneTask(OWNER_C);
  const waiting = db.createTask(OWNER_C, { title: "book flights", goal: "book flights", maxAttempts: 5 });
  assert.equal(db.updateTask(OWNER_C, waiting.id, { state: "waiting_on_you", sheet: { needs: { question: "Tue or Wed?", tradeoff: "Tue is sooner" } } }).ok, true);
  const kept = (o = {}) => keptOnWeb({ router: h.router, conversationId: OWNER_C, route: route(o.route), fromTask: o.fromTask ?? null, media: o.media ?? null, idempotencyKey: o.key ?? null, toMaster: !!o.toMaster });
  // everything: nothing kept.
  db.setWebReach(OWNER_C, "text");
  assert.equal(kept({ fromTask: done }), false);
  assert.equal(kept(), false);
  // timely decisions: exactly as before — only a finished job's result.
  db.setWebReach(OWNER_C, "web");
  assert.equal(kept({ fromTask: done }), true);
  assert.equal(kept({ fromTask: waiting.id }), false, "a question for them");
  assert.equal(kept(), false, "a reminder");
  // only what needs a yes: everything kept but a message asking for a yes.
  db.setWebReach(OWNER_C, "yes");
  assert.equal(kept({ fromTask: done }), true);
  assert.equal(kept({ fromTask: waiting.id }), true, "a question waits here");
  assert.equal(kept({ key: "timer:7:fire" }), true, "a reminder waits here");
  db.askConfirmation({ conversationId: OWNER_C, action: "purchase_confirm", summary: "Buy the lamp, $40", stakes: "money", askedAfterMsgs: 0 });
  assert.equal(kept({ key: "timer:7:fire" }), false, "asking for a yes: texted");
  clock.skip(20 * MIN);
  assert.equal(kept(), true, "an ask from earlier doesn't make this one an ask");
  // nothing: everything Reason starts is kept, the ask too.
  db.askConfirmation({ conversationId: OWNER_C, action: "purchase_confirm", summary: "Buy the rug, $90", stakes: "money", askedAfterMsgs: 0 });
  db.setWebReach(OWNER_C, "none");
  assert.equal(kept(), true);
  // Under every setting: a reply, a recording, a code, an operator line, a keyed system message.
  for (const v of ["text", "web", "yes", "none"]) {
    db.setWebReach(OWNER_C, v);
    assert.equal(kept({ route: { started: false }, fromTask: done }), false, `${v}: a reply goes back the way it came`);
    assert.equal(kept({ fromTask: done, media: { file: "x" } }), false, `${v}: a recording`);
    for (const key of ["wsign:dm:owner:1", "pcode:9:1", "esign:dm:owner:2", "incident:x@1:open", "event-created:3", "line-change:dm:owner"]) {
      assert.equal(kept({ fromTask: done, key }), false, `${v}: ${key}`);
    }
    assert.equal(kept({ fromTask: done, toMaster: true }), false, `${v}: a line for the operator about somebody else`);
  }
  // Somebody Web doesn't reach: texted whatever they chose.
  config.web = "owner";
  db.setWebReach(KOFI_C, "none");
  assert.equal(keptOnWeb({ router: h.router, conversationId: KOFI_C, route: route({ to: KOFI }) }), false);
  db.setWebReach(OWNER_C, "text");
});

test("delivery under 'nothing', end to end: a reminder lands on Web and is not texted; a sign-in code is still texted", async () => {
  const h = harness();
  db.setWebReach(OWNER_C, "none");
  const r = await h.deliver({ conversationId: OWNER_C, text: "Reminder: call the landlord.", idempotencyKey: "timer:41:fire" });
  assert.equal(r.ok, true);
  assert.ok(await until(() => db.messagesFor(OWNER_C).some(m => m.channel === "web" && m.text.includes("landlord"))), "on Web");
  assert.equal(h.fake.sent.filter(m => m.text.includes("landlord")).length, 0, "not texted");
  assert.ok(h.logs.some(l => l.kept_on_web === OWNER_C && l.reach === "none"));
  await h.deliver({ conversationId: OWNER_C, text: "Your Reason code is 123456", idempotencyKey: "wsign:dm:owner:9" });
  assert.ok(await until(() => h.fake.sent.some(m => m.text.includes("123456"))), "the code is texted");
  // A line Reason says itself for the operator (src/tools.js access requests) carries toMaster through `say`.
  h.runtime.say(OWNER_C, "Kofi wants in.", { toMaster: true });
  assert.ok(await until(() => h.fake.sent.some(m => m.text.includes("Kofi wants in"))), "an operator line is texted under 'nothing'");
  db.setWebReach(OWNER_C, "text");
});

test("delivery under 'only what needs a yes', end to end: the turn that asks is texted, the result after it is not", async () => {
  let ask = true;
  const h = harness({ turn: async () => {
    if (ask) { db.askConfirmation({ conversationId: OWNER_C, action: "browser_submit", summary: "Book the Hudson Inn", stakes: "money", askedAfterMsgs: 0 }); return "The Hudson Inn has the room. Want me to book it?"; }
    return "All three quotes are in.";
  } });
  db.setWebReach(OWNER_C, "yes");
  const t = db.createTask(OWNER_C, { title: "hotel", goal: "book a hotel", maxAttempts: 5 });
  await h.runtime._turn({ conversationId: OWNER_C, text: "working", kind: "event", meta: { fromTask: t.id } });
  assert.ok(await until(() => h.fake.sent.some(m => m.text.includes("Hudson Inn"))), "the ask is texted");
  db.db.prepare("UPDATE confirmations SET granted_at = ? WHERE conversation_id = ?").run(clock.now(), OWNER_C);
  ask = false;
  await h.runtime._turn({ conversationId: OWNER_C, text: "working", kind: "event", meta: { fromTask: t.id } });
  assert.ok(await until(() => db.messagesFor(OWNER_C).some(m => m.channel === "web" && m.text.includes("three quotes"))), "the update waits on Web");
  assert.equal(h.fake.sent.filter(m => m.text.includes("three quotes")).length, 0);
  db.setWebReach(OWNER_C, "text");
});

test("operator lines Reason says with no key (status-page alerts, a Spotify join, an invite request) are marked toMaster, so they are always texted", async () => {
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(src("ops.js"), /runtime\.say\(config\.ownerConversation, digest\.scrub\(text\), \{ toMaster: true, idempotencyKey: `ops:/);
  assert.match(src("http.js"), /then tell me and I will send them the link\.`, \{ toMaster: true \}\)/);
  assert.match(src("tools.js"), /ctx\.events\?\.say\(config\.ownerConversation, out\.toMaster, \{ toMaster: true \}\)/);
  assert.match(src("serve.js"), /toMaster: !!toMaster/);
});

// ---------- 5C: Sign out everywhere? ----------

test("5C: Sign out everywhere asks first, with the real count; KEEP ME IN goes back; the confirm signs every one out", async () => {
  const h = harness();
  const phone = browser(OWNER_C, IPHONE), laptop = browser(OWNER_C, WIN_FF), kofi = browser(KOFI_C);
  const me = browser(OWNER_C);
  const body = (await call(h, { b: me, query: { confirm: "everywhere" } })).body;
  assert.match(body, /<main class="sub mid"><div class="card so-card" role="group" aria-labelledby="so-h"><h1 class="sub-l" id="so-h">SIGN OUT EVERYWHERE\?<\/h1><p class="so-n">3 browsers, including this one\.<\/p><p class="so-p">You'll need a new code to sign back in\. Reason keeps working, and your texts aren't affected\.<\/p>/);
  assert.match(body, /<button class="sub-go" type="submit" data-busy="Signing out everywhere…">Sign out everywhere<\/button><\/form><a class="act2 sub-c" href="\/web\/settings#browsers">KEEP ME IN<\/a>/);
  assert.equal(db.pageSessionsFor(OWNER_C).length, 3, "asking signs nobody out");
  assert.equal(st.browsersLine(1), "1 browser: this one.");
  const out = await post(h, me, { do: "everywhere" });
  assert.equal(out.headers.Location, "/web?out=1");
  for (const b of [phone, laptop, me]) assert.equal((await call(h, { b })).status, 303);
  assert.equal((await call(h, { b: kofi })).status, 200, "Kofi untouched");
});

// ---------- 5D: an invite just made, and canceling one ----------

test("5D: Make an invite link shows the link to copy or share, the count dropped, and the cancel line", async () => {
  const h = harness();
  config.invitesOpen = true;
  const me = browser(OWNER_C);
  const out = await post(h, me, { do: "invite" });
  const [made] = db.listInvites(OWNER_C);
  assert.equal(out.headers.Location, `/web/settings?invite=${made.id}`);
  const body = (await call(h, { b: me, query: { invite: String(made.id) } })).body;
  const url = invites.inviteUrl(made.token);
  assert.match(url, /^https:\/\/files\.heyreason\.test\/i\/[A-Za-z0-9_-]{32}$/, "K3: the link stays files.<host>/i/<token>");
  assert.match(body, /<h1 class="sub-l">INVITES<\/h1><p class="iv-n">1 left<\/p>/);
  assert.ok(body.includes(`<div class="card iv-card"><span class="lbl">NEW LINK · UNUSED</span><a class="iv-link" href="${url}">files.heyreason.test/i/${made.token.slice(0, 4)}…</a>`));
  assert.match(body, /<button class="sub-go iv-copy" type="button" hidden>Copy it <span aria-hidden="true">→<\/span><\/button><button class="act2 sub-c iv-share" type="button" hidden>SHARE<\/button>/, "drawn only where script can do them");
  assert.match(body, /<p class="hand tilt iv-said" role="status" hidden data-ok="copied\. send it to someone you like\."/);
  assert.match(body, /<p class="iv-note">It works once\. If they never use it, you can cancel it and get the invite back\.<\/p>/);
  assert.match(body, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(body, /navigator\.share\(\{url:url\}\)/);
  // Somebody else's invite number, a used one, or nonsense: the list, never their link.
  const kofiMe = browser(KOFI_C);
  assert.equal((await call(h, { b: kofiMe, query: { invite: String(made.id) } })).headers.Location, "/web/settings#invites");
  assert.equal((await call(h, { b: me, query: { invite: "abc" } })).status, 303);
  config.invitesOpen = false;
});

test("cancel an unused invite from Web: only theirs, only unused, the invite comes back", async () => {
  const h = harness();
  config.invitesOpen = true;
  const me = browser(OWNER_C), kofi = browser(KOFI_C);
  await post(h, me, { do: "invite" });
  const [made] = db.listInvites(OWNER_C);
  let body = await page(h, me);
  assert.match(body, /<p class="inv-n">1 left<\/p>/);
  assert.match(body, new RegExp(`<input type="hidden" name="do" value="cancel-invite"><input type="hidden" name="i" value="${made.id}"><button class="act2 inv-x" type="submit" data-busy="CANCELING…" aria-label="Cancel the invite link files\\.heyreason\\.test/i/[^"]+">CANCEL</button>`));
  // From Kofi's page: not his, nothing changes.
  await post(h, kofi, { do: "cancel-invite", i: String(made.id) });
  assert.equal(db.getInvite(OWNER_C, made.id).state, "unused");
  const out = await post(h, me, { do: "cancel-invite", i: String(made.id) });
  assert.equal(out.headers.Location, "/web/settings?done=invite-canceled#invites");
  assert.equal(db.getInvite(OWNER_C, made.id).state, "canceled");
  body = (await call(h, { b: me, query: { done: "invite-canceled" } })).body;
  assert.match(body, /<p class="inv-n">2 left<\/p>/, "the invite is back");
  assert.match(body, /<p class="hand" role="status">canceled\. that invite is yours again\.<\/p>/);
  assert.match(body, /<span class="stamp stamp-muted">CANCELED<\/span><\/li>/, "no cancel on a canceled one");
  assert.equal((await post(h, me, { do: "cancel-invite", i: String(made.id) })).headers.Location, "/web/settings#invites", "twice: nothing");
  config.invitesOpen = false;
});

// ---------- L8: the action's words go present tense, muted, and can't be pressed twice ----------

test("L8: Saving… / Signing out everywhere… / Making a link…, muted, and a second press does nothing", async () => {
  const h = harness();
  config.invitesOpen = true;
  const me = browser(OWNER_C);
  const bodies = [await page(h, me), (await call(h, { b: me, query: { edit: "reach" } })).body, (await call(h, { b: me, query: { confirm: "everywhere" } })).body];
  const all = bodies.join("");
  for (const w of ["Saving…", "Signing out everywhere…", "Making a link…"]) assert.ok(all.includes(`data-busy="${w}"`), w);
  assert.match(all, /if\(f\.dataset\.sent\)\{e\.preventDefault\(\);return\}f\.dataset\.sent='1'/, "a second submit is dropped");
  assert.match(all, /b\.textContent=b\.dataset\.busy;b\.setAttribute\('aria-disabled','true'\);b\.classList\.add\('busy'\)/);
  assert.match(all, /\.busy,\.busy:hover\{color:var\(--muted\);cursor:default;pointer-events:none\}/);
  assert.match(all, /addEventListener\('pageshow'/, "coming back to the page undoes it");
  config.invitesOpen = false;
});

// ---------- the theme switch is in Settings only ----------

test("the theme switch is in Settings only: no footer switch and none in the menu on any other /web page", async () => {
  const h = harness();
  const me = browser(OWNER_C);
  for (const query of [{}, { thread: "" }, { tab: "ongoing" }]) {
    const html = (await call(h, { sub: null, b: me, query })).body;
    assert.doesNotMatch(html, /class="themes"|<footer class="foot">|name="theme-(?!color)/, JSON.stringify(query));
  }
  const memory = (await call(h, { sub: "memory", b: me })).body;
  assert.doesNotMatch(memory, /class="themes"|<footer class="foot">/);
  const signin = (await call(h, { sub: null })).body;
  assert.doesNotMatch(signin, /class="themes"|<footer class="foot">/);
  assert.match(await page(h, me), /<div class="th-g" role="radiogroup" aria-labelledby="th-h">/, "Settings keeps it");
});
