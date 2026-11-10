// The iPhone app's API (src/ios/, docs/ios-api.md). One pinned test per promise:
//   - flag off: every /ios/v1 path is the flat 404, byte for byte
//   - sign in by phone, one answer for every number, codes bound to the asking device, revocable device sessions
//   - the Page from real rows only, an honest empty, failures with what Reason did next
//   - receipts: steps, cost, artifacts
//   - live: a state change arrives inside a second
//   - memories: source labels, correct, forget for good, forget everything
//   - sealed: nothing of one person's is reachable with another's token
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-ios-api-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
delete process.env.REASON_IOS_API;
delete process.env.REASON_BACKEND;

const { createServer } = await import("../src/http.js");
const { iosApiRequest } = await import("../src/ios/api.js");
const { liveRequest } = await import("../src/ios/live.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver } = await import("../src/deliver.js");
const { setSpanReader } = await import("../src/ios/memory.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const A = { c: "dm:owner", phone: "+12025551234", name: "Omari Test" };
const B = { c: "dm:fake:+14155559876", phone: "+14155559876", name: "Kofi" };
const challenge = (s = "a") => s.repeat(40);

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  config.iosApi = true;
  setSpanReader(null);
  db.db.exec(`DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts; DELETE FROM event_join_attempts;
    DELETE FROM people; DELETE FROM person_facts; DELETE FROM guesses; DELETE FROM whys; DELETE FROM treat_rules; DELETE FROM profile_blocks; DELETE FROM fact_embeddings; DELETE FROM messages; DELETE FROM event_log;
    DELETE FROM tasks; DELETE FROM task_log; DELETE FROM timers; DELETE FROM series; DELETE FROM confirmations; DELETE FROM calls; DELETE FROM agentcard_purchases; DELETE FROM inbound_parts; DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM outbox; DELETE FROM graph_mentions; DELETE FROM graph_edges; DELETE FROM graph_entities; DELETE FROM recall_reindex;`);
  for (const p of [A, B]) {
    db.upsertAccount({ conversationId: p.c, channel: "fake", address: p.phone, name: p.name, isOperator: p === A });
    db.upsertThread({ conversationId: p.c, channel: "fake", address: p.phone, isOwner: true, service: "iMessage" });
  }
});

async function api(path, { method = "GET", token = null, body = undefined, runtime = null, router = null, query = {}, headers = {}, log } = {}) {
  const out = await iosApiRequest({
    path, method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, remoteAddress: "10.0.0.1",
    readBody: async () => (body === undefined ? "" : JSON.stringify(body)), runtime, router, query, log,
  });
  let parsed = null;
  try { parsed = typeof out.body === "string" && out.body ? JSON.parse(out.body) : null; } catch { /* binary */ }
  return { ...out, json: parsed };
}

/** A real sign-in: the code is read from what would have been texted. */
async function signIn(p, { ch = challenge(), name = "iPhone" } = {}) {
  const told = [];
  const runtime = { _tell: async (c, line) => { told.push({ c, line }); return { ok: true }; } };
  const asked = await api("/auth/code", { method: "POST", body: { phone: p.phone, challenge: ch }, runtime });
  assert.equal(asked.status, 202);
  assert.equal(told[0].c, p.c);
  const code = /code is (\d{6})/.exec(told[0].line)[1];
  const r = await api("/auth/verify", { method: "POST", body: { phone: p.phone, challenge: ch, code, device_name: name } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.token;
}
function failedTask(c, title = "Book the table") {
  const t = db.createTask(c, { title, goal: title, maxAttempts: 3 });
  db.finishTask(c, t.id, { state: "failed", outcome: "no tables", result: { why: "They were fully booked", next: "I'm trying the place next door" } });
  return t.id;
}
function call(c, fields = {}) {
  const row = db.createCall(c, { provider: "fake", toNumber: "+14155550000", isOwner: false, goal: "Call the salon", ...fields });
  return row.id ?? row;
}

// ---------------------------------------------------------------- the flag
async function viaServer(fn) {
  const server = createServer({ router: { get: () => null, all: () => [], channels: () => [] }, runtime: {}, log: () => {} });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
}
test("flag off (the default): /ios/v1 answers exactly what a path nobody issued answers", async () => {
  config.iosApi = false;
  assert.equal((await import("../src/config.js")).config.iosApi, false);
  await viaServer(async (base) => {
    const miss = await fetch(`${base}/no/such/address`);
    const missBody = await miss.text();
    for (const [p, m] of [["/ios/v1/page", "GET"], ["/ios/v1/auth/code", "POST"], ["/ios/v1/live", "GET"], ["/ios/v1/memories", "GET"]]) {
      const r = await fetch(base + p, { method: m });
      assert.equal(r.status, miss.status, p);
      assert.equal(await r.text(), missBody, p);
    }
  });
});
test("flag on: routed through the real server; owner mode opens only the owner's conversation", async () => {
  await viaServer(async (base) => {
    const r = await fetch(`${base}/ios/v1/page`);
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { ok: false, error: "signed_out" });
  });
  const b = await signIn(B);
  const a = await signIn(A);
  config.iosApi = "owner";
  assert.equal(await iosApiRequest({ path: "/page", method: "GET", headers: { authorization: `Bearer ${b}` } }), null);
  assert.equal((await api("/page", { token: a })).status, 200);
});

// ---------------------------------------------------------------- sign in
test("every number gets the same answer, and only a real account gets a text", async () => {
  const told = [];
  const runtime = { _tell: async (...x) => { told.push(x); return { ok: true }; } };
  const real = await api("/auth/code", { method: "POST", body: { phone: A.phone, challenge: challenge() }, runtime });
  const fake = await api("/auth/code", { method: "POST", body: { phone: "+16465550101", challenge: challenge() }, runtime });
  assert.equal(real.status, fake.status);
  assert.equal(real.body, fake.body);
  assert.equal(told.length, 1);
});
test("a wrong code and a stranger's number fail identically; a malformed challenge is refused", async () => {
  const told = [];
  const runtime = { _tell: async (_c, line) => { told.push(line); return { ok: true }; } };
  await api("/auth/code", { method: "POST", body: { phone: A.phone, challenge: challenge("a") }, runtime });
  const code = /code is (\d{6})/.exec(told[0])[1];
  const wrong = await api("/auth/verify", { method: "POST", body: { phone: A.phone, challenge: challenge("a"), code: code === "000000" ? "000001" : "000000" } });
  const stranger = await api("/auth/verify", { method: "POST", body: { phone: "+16465550101", challenge: challenge("a"), code } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, stranger.json);
  const bad = await api("/auth/code", { method: "POST", body: { phone: A.phone, challenge: "short" } });
  assert.equal(bad.status, 400);
});
test("verified: the token opens the API, and a browser's Web session does not", async () => {
  const token = await signIn(A);
  assert.equal((await api("/page", { token })).status, 200);
  const webToken = "w".repeat(43);
  db.startPageSession(`wsign:${A.c}`, webToken, { conversationId: A.c });
  assert.equal((await api("/page", { token: webToken })).status, 401);
  assert.equal((await api("/page")).status, 401);
});
test("device sessions: listed, one revoked ends it, signing out ends this one; token never in the list", async () => {
  const t1 = await signIn(A, { name: "Phone One" });
  const t2 = await signIn(A, { name: "Phone Two", ch: challenge("b") });
  const list = (await api("/auth/sessions", { token: t1 })).json.sessions;
  assert.equal(list.length, 2);
  assert.ok(!JSON.stringify(list).includes(t1) && !JSON.stringify(list).includes(t2));
  assert.deepEqual(list.map(s => s.name).sort(), ["Phone One", "Phone Two"]);
  const other = list.find(s => !s.current);
  assert.equal((await api(`/auth/sessions/${other.id}`, { method: "DELETE", token: t1 })).status, 200);
  assert.equal((await api("/page", { token: other.name === "Phone Two" ? t2 : t1 })).status, 401);
  const stay = other.name === "Phone Two" ? t1 : t2;
  assert.equal((await api("/auth/session", { method: "DELETE", token: stay })).status, 200);
  assert.equal((await api("/page", { token: stay })).status, 401);
});

// ---------------------------------------------------------------- the Page
test("nothing real: an honest empty, no filler", async () => {
  const token = await signIn(A);
  const { json } = await api("/page", { token });
  assert.equal(json.empty, true);
  assert.deepEqual(json.sections, { in_progress: [], done: [], failed: [], open_offers: [] });
});
test("in progress, done, failed with what Reason did next, open offers: real rows, internals never out", async () => {
  const token = await signIn(A);
  const run = db.createTask(A.c, { title: "Find a dentist", goal: "SECRET-GOAL-TEXT", maxAttempts: 3 });
  const done = db.createTask(A.c, { title: "Order the pads", goal: "x", maxAttempts: 3 });
  db.finishTask(A.c, done.id, { state: "done", outcome: "ok", result: { headline: "Ordered", facts: ["$12"] } });
  failedTask(A.c);
  const ask = db.askConfirmation({ conversationId: A.c, action: "message_send", summary: "Text Kofi the address", stakes: "low", target: "Kofi", askedAfterMsgs: 0 });
  const { json } = await api("/page", { token });
  assert.equal(json.empty, false);
  assert.deepEqual(json.sections.in_progress.map(i => i.id), [`task-${run.id}`]);
  assert.equal(json.sections.done[0].result.headline, "Ordered");
  assert.deepEqual(json.sections.failed[0].failure, { why: "They were fully booked", did_next: "I'm trying the place next door" });
  assert.equal(json.sections.open_offers[0].id, `approval-${ask.id ?? ask}`);
  assert.ok(!JSON.stringify(json).includes("SECRET-GOAL-TEXT"), "the raw task record stays on the server");
});
test("a failure with no recorded next step says null, it does not invent one", async () => {
  const token = await signIn(A);
  const t = db.createTask(A.c, { title: "Book it", goal: "x", maxAttempts: 3 });
  db.finishTask(A.c, t.id, { state: "failed", outcome: "gave up" });
  const f = (await api("/page", { token })).json.sections.failed[0];
  assert.equal(f.failure.why, "gave up");
  assert.equal(f.failure.did_next, null);
});

// ---------------------------------------------------------------- receipts
test("a task's receipt: steps, the money actually charged, recording, transcript and the approval", async () => {
  const token = await signIn(A);
  const t = db.createTask(A.c, { title: "Book the salon", goal: "x", maxAttempts: 3 });
  db.updateTask(A.c, t.id, { progress: "Found the number" });
  const ask = db.askConfirmation({ conversationId: A.c, action: "purchase_confirm", summary: "Buy it, $12", stakes: "money", target: "x", askedAfterMsgs: 0, taskId: t.id });
  const askId = ask.id ?? ask;
  db.db.prepare("UPDATE confirmations SET granted_at = ?, granted_quote = 'yes do it' WHERE id = ?").run(clock.now(), askId);
  const pid = db.recordAgentcardPurchase({ conversationId: A.c, buyConversationId: "b1", status: "placed", amountCents: 1200, merchant: "Walmart", what: "Pads" });
  db.db.prepare("UPDATE agentcard_purchases SET confirmation_id = ?, order_id = 'ORD1' WHERE conversation_id = ?").run(askId, A.c);
  const cid = call(A.c, { taskId: t.id });
  mkdirSync(config.recordingRoot, { recursive: true });
  writeFileSync(join(config.recordingRoot, "call-a.mp3"), Buffer.from("ID3 fake audio bytes"));
  db.db.prepare("UPDATE calls SET task_id = ?, state = 'completed', transcript = 'Hello there', recording_state = 'stored', recording_file = ?, recording_format = 'mp3' WHERE id = ?").run(t.id, join(config.recordingRoot, "call-a.mp3"), cid);
  const { json } = await api(`/items/task-${t.id}`, { token });
  assert.ok(json.item.steps.some(s => s.text.includes("Found the number")));
  assert.equal(json.item.cost.charged_cents, 1200);
  assert.deepEqual(json.item.cost.lines.map(l => [l.label, l.charged]), [["Walmart", true]]);
  const kinds = json.item.artifacts.map(a => a.type).sort();
  assert.deepEqual(kinds, ["approval", "confirmation", "recording", "transcript"]);
  assert.equal(json.item.artifacts.find(a => a.type === "approval").you_said, "yes do it");
  const audio = await api(`/calls/${cid}/recording`, { token });
  assert.equal(audio.status, 200);
  assert.equal(Buffer.from(audio.body).toString(), "ID3 fake audio bytes");
  assert.equal(pid != null, true);
});
test("a purchase whose outcome nobody knows does not claim a number", async () => {
  const token = await signIn(A);
  db.recordAgentcardPurchase({ conversationId: A.c, buyConversationId: "b2", status: "outcome_unknown", amountCents: 900, merchant: "Target", what: "x" });
  const id = db.db.prepare("SELECT id FROM agentcard_purchases").get().id;
  const { cost } = (await api(`/items/purchase-${id}`, { token })).json.item;
  assert.equal(cost.charged_cents, null);
  assert.equal(cost.charged_known, false);
});

// ---------------------------------------------------------------- live
function sink() {
  const chunks = []; const res = new EventEmitter();
  res.write = (s) => { chunks.push({ s, at: Date.now() }); return true; };
  res.end = () => { res.ended = true; };
  return { res, chunks };
}
test("a state change arrives within a second; only ever their own", async () => {
  const token = await signIn(A);
  const account = db.getAccount(A.c);
  const { res, chunks } = sink();
  const out = liveRequest({ account, token, headers: { authorization: `Bearer ${token}` } });
  out.stream(res, new EventEmitter());
  try {
    assert.match(chunks.map(c => c.s).join(""), /event: page/);
    const seen = chunks.length;
    // Somebody else's change makes no event at all.
    db.createTask(B.c, { title: "NOT-YOURS", goal: "x", maxAttempts: 3 });
    await new Promise(r => setTimeout(r, 700));
    assert.equal(chunks.length, seen);
    const t0 = Date.now();
    db.createTask(A.c, { title: "Mine now", goal: "x", maxAttempts: 3 });
    while (chunks.length === seen && Date.now() - t0 < 1000) await new Promise(r => setTimeout(r, 20));
    const got = chunks.slice(seen).map(c => c.s).join("");
    assert.match(got, /event: page/);
    assert.ok(got.includes("Mine now") && !got.includes("NOT-YOURS"));
    assert.ok(chunks[seen].at - t0 < 1000, `took ${chunks[seen].at - t0} ms`);
  } finally { res.emit("close"); }
});
test("a device revoked elsewhere is told, and the stream ends", async () => {
  const token = await signIn(A);
  const { res, chunks } = sink();
  liveRequest({ account: db.getAccount(A.c), token, headers: { authorization: `Bearer ${token}` } }).stream(res, new EventEmitter());
  db.endPageSessionOf(A.c, token);
  const t0 = Date.now();
  while (!res.ended && Date.now() - t0 < 1000) await new Promise(r => setTimeout(r, 20));
  assert.equal(res.ended, true);
  assert.match(chunks.map(c => c.s).join(""), /event: signedout/);
});
test("the live route is a real stream over HTTP", async () => {
  const token = await signIn(A);
  await viaServer(async (base) => {
    const ac = new AbortController();
    const r = await fetch(`${base}/ios/v1/live`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/event-stream/);
    const { value } = await r.body.getReader().read();
    assert.match(Buffer.from(value).toString(), /retry: 1500|event: page/);
    ac.abort();
  });
});

// ---------------------------------------------------------------- memories
const dbBytes = () => [config.dbPath, `${config.dbPath}-wal`].filter(existsSync).map(p => readFileSync(p).toString("latin1")).join("");

test("memories carry a source label and the words that gave rise to them; correct replaces the row", async () => {
  const token = await signIn(A);
  const ev = db.db.prepare("INSERT INTO event_log (conversation_id, role, content, at) VALUES (?, 'user', 'i am allergic to shellfish', ?)").run(A.c, clock.now());
  db.remember(A.c, A.name, "Allergic to shellfish", { source: "inferred", sourceMessageIds: [Number(ev.lastInsertRowid)] });
  db.remember(A.c, "Kofi", "Is a nurse", { source: "user_stated" });
  const { json } = await api("/memories", { token });
  const rows = json.groups.flatMap(g => g.memories);
  const allergy = rows.find(r => r.text.includes("shellfish"));
  assert.equal(allergy.source.label, "I picked this up from what you said");
  assert.equal(allergy.source.quote, "i am allergic to shellfish");
  assert.equal(rows.find(r => r.text.includes("nurse")).source.label, "You told me");
  const fixed = await api(`/memories/${allergy.id}/correct`, { method: "POST", token, body: { text: "Allergic to crab only" } });
  assert.equal(fixed.status, 200);
  const after = (await api("/memories", { token })).json.groups.flatMap(g => g.memories);
  assert.ok(after.some(r => r.text === "Allergic to crab only") && !after.some(r => r.text.includes("shellfish")));
});
test("forget one: gone from recall, its words off the disk, and the extractor can't learn it back", async () => {
  const token = await signIn(A);
  const words = "Sees a therapist named Dr Zzyzx";
  const f = db.remember(A.c, A.name, words, { source: "inferred" });
  db.db.prepare("INSERT INTO fact_embeddings (conversation_id, fact_id, source_table, embedding, created_at) VALUES (?, ?, 'person_facts', x'00', ?)").run(A.c, f.factId, clock.now());
  db.db.prepare("INSERT INTO event_log (conversation_id, role, content, at) VALUES (?, 'assistant', ?, ?)").run(A.c, `Noted: ${words}.`, clock.now());
  db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, 'assistant', 'fake', ?, ?)").run(A.c, `Noted: ${words}.`, clock.now());
  const own = db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, 'user', 'fake', 'my own words about Dr Qqqxx', ?)").run(A.c, clock.now()).lastInsertRowid;
  assert.equal((await api(`/memories/fact-${f.factId}`, { method: "DELETE", token })).status, 200);
  assert.ok(!(await api("/memories", { token })).json.groups.flatMap(g => g.memories).some(m => m.text.includes("Zzyzx")));
  assert.ok(!dbBytes().includes("Dr Zzyzx"), "the sentence is not in the database file or its write-ahead log");
  assert.ok(dbBytes().includes("Qqqxx") && db.db.prepare("SELECT 1 AS x FROM messages WHERE id = ?").get(own), "their own messages are left alone");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM fact_embeddings WHERE fact_id = ?").get(f.factId).n, 0);
  const again = db.remember(A.c, A.name, words, { source: "inferred" });
  assert.equal(again.factId, null);
  assert.equal(again.refused, "taken_back");
  const said = db.remember(A.c, A.name, words, { source: "user_stated" });
  assert.ok(said.factId, "their own word brings it back");
  assert.ok(db.memoryFacts(A.c).some(x => x.fact === words));
});
test("forget one also takes the older wording a correction left behind, a rule's words, and a why", async () => {
  const token = await signIn(A);
  const f = db.remember(A.c, A.name, "Lives at Ninety Qwerty Lane", {});
  const c = await api(`/memories/fact-${f.factId}/correct`, { method: "POST", token, body: { text: "Lives at Ninety Asdfg Lane" } });
  assert.equal((await api(`/memories/${c.json.id}`, { method: "DELETE", token })).status, 200);
  const rule = db.addRule(A.c, { rule: "Never mention Blorpian topics", why: "they asked", source: "they_said" });
  assert.equal((await api(`/memories/rule-${rule.rule.id}`, { method: "DELETE", token })).status, 200);
  const bytes = dbBytes();
  for (const w of ["Qwerty", "Asdfg", "Blorpian"]) assert.ok(!bytes.includes(w), w);
});
test("forget everything: asked plainly, removes what Reason knows; receipts and promises stay", async () => {
  const token = await signIn(A);
  const other = db.remember(B.c, B.name, "Kofi's own secret fact", {});
  db.remember(A.c, A.name, "Likes Frobnitz coffee", {});
  db.db.prepare("INSERT INTO event_log (conversation_id, role, content, at) VALUES (?, 'user', 'Frobnitz please', ?)").run(A.c, clock.now());
  db.saveConversation(A.c, [{ role: "user", content: "Frobnitz please" }]);
  const t = db.createTask(A.c, { title: "Still running", goal: "x", maxAttempts: 3 });
  assert.equal((await api("/memories/forget-everything", { method: "POST", token, body: {} })).status, 400, "needs the explicit confirmation");
  assert.ok(db.memoryFacts(A.c).length);
  const r = await api("/memories/forget-everything", { method: "POST", token, body: { confirm: "FORGET EVERYTHING" } });
  assert.equal(r.status, 200);
  assert.equal((await api("/memories", { token })).json.empty, true);
  assert.deepEqual(db.loadConversation(A.c), []);
  assert.ok(!dbBytes().includes("Frobnitz"));
  assert.ok(db.getTask(A.c, t.id), "the job they asked for keeps running");
  assert.equal((await api("/page", { token })).status, 200, "still signed in");
  assert.ok(db.memoryFacts(B.c).some(f => f.id === other.factId), "another person's memory is untouched");
});

// ---------------------------------------------------------------- forget, from the message it came from
const AT = () => clock.now();
function sourceMessage(p, text, { role = "user", at = AT(), ext = "ext-1" } = {}) {
  const ev = Number(db.db.prepare("INSERT INTO event_log (conversation_id, role, content, message_id, at) VALUES (?, ?, ?, ?, ?)").run(p.c, role, text, ext, at).lastInsertRowid);
  db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, ?, 'fake', ?, ?)").run(p.c, role, text, at);
  db.db.prepare("INSERT INTO inbound_parts (channel, base_handle, part_index, conversation_id, text, at) VALUES ('fake', ?, 0, ?, ?, ?)").run(`${ext}-${p.c}`, p.c, text, at);
  db.saveConversation(p.c, [...db.loadConversation(p.c), { role, content: text }, { role: "assistant", content: "ok" }]);
  return ev;
}
const cutWords = (span) => async (_w, rows) => rows.map(r => ({ id: r.id, remove: r.content.includes(span) ? [span] : [] }));

test("forgetting takes the fact out of the message it came from, everywhere, and keeps what's unrelated", async () => {
  const token = await signIn(A);
  const span = "my doctor is Dr Wugwug";
  const ev = sourceMessage(A, `Dinner at 7 works. ${span}.`);
  const f = db.remember(A.c, A.name, "Doctor is Dr Wugwug", { source: "inferred", sourceMessageIds: [ev] });
  db.db.prepare("INSERT INTO fact_embeddings (conversation_id, fact_id, source_table, embedding, created_at, span_from) VALUES (?, ?, 'event_log', x'00', ?, ?)").run(A.c, ev, AT(), ev);
  const ent = Number(db.db.prepare("INSERT INTO graph_entities (conversation_id, type, canonical_name, key, created_at, updated_at) VALUES (?, 'person', 'Dr Wugwug', 'dr wugwug', ?, ?)").run(A.c, AT(), AT()).lastInsertRowid);
  db.db.prepare("INSERT INTO graph_mentions (conversation_id, event_log_id, entity_id, created_at) VALUES (?, ?, ?, ?)").run(A.c, ev, ent, AT());
  db.db.prepare("INSERT INTO graph_edges (conversation_id, src_entity, relation, dst_entity, valid_from, source_message_ids, created_at) VALUES (?, ?, 'treats', ?, ?, ?, ?)").run(A.c, ent, ent, AT(), JSON.stringify([ev]), AT());
  db.db.prepare("INSERT OR REPLACE INTO profile_blocks (conversation_id, block, fact_ids, built_at) VALUES (?, 'sees Dr Wugwug', '[]', ?)").run(A.c, AT());
  const asked = [];
  setSpanReader(async (w, rows) => { asked.push({ w, ids: rows.map(r => r.id) }); return cutWords(span)(w, rows); });
  assert.equal((await api(`/memories/fact-${f.factId}`, { method: "DELETE", token })).status, 200);
  assert.deepEqual(asked[0].ids, [ev]);
  assert.ok(!dbBytes().includes("Wugwug"), "not in any stored copy or derivative");
  assert.equal(db.db.prepare("SELECT content FROM event_log WHERE id = ?").get(ev).content, "Dinner at 7 works.");
  assert.equal(db.db.prepare("SELECT text FROM messages WHERE conversation_id = ?").get(A.c).text, "Dinner at 7 works.");
  assert.equal(db.db.prepare("SELECT text FROM inbound_parts WHERE conversation_id = ?").get(A.c).text, "Dinner at 7 works.");
  assert.equal(db.loadConversation(A.c)[0].content, "Dinner at 7 works.");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM fact_embeddings WHERE source_table = 'event_log' AND fact_id = ?").get(ev).n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM recall_reindex WHERE conversation_id = ?").get(A.c).n, 1, "what's left is indexed again");
  for (const t of ["graph_mentions", "graph_edges", "graph_entities", "profile_blocks"]) assert.equal(db.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE conversation_id = ?`).get(A.c).n, 0, t);
});
test("nothing else in the message: the message is gone", async () => {
  const token = await signIn(A);
  const span = "My blood type is O-Zorp";
  const ev = sourceMessage(A, span);
  const f = db.remember(A.c, A.name, "Blood type O-Zorp", { source: "inferred", sourceMessageIds: [ev] });
  setSpanReader(cutWords(span));
  assert.equal((await api(`/memories/fact-${f.factId}`, { method: "DELETE", token })).status, 200);
  assert.equal(db.db.prepare("SELECT 1 AS x FROM event_log WHERE id = ?").get(ev), undefined);
  const m = db.db.prepare("SELECT text, deleted_at FROM messages WHERE conversation_id = ?").get(A.c);
  assert.equal(m.text, ""); assert.ok(m.deleted_at);
  assert.equal(db.loadConversation(A.c)[0].content, "[deleted at their request]");
  assert.ok(!dbBytes().includes("O-Zorp"));
});
test("a source message that doesn't state it is left exactly as it was", async () => {
  const token = await signIn(A);
  const ev = sourceMessage(A, "Totally unrelated Plimsoll chatter");
  const f = db.remember(A.c, A.name, "Likes Vexillology", { source: "inferred", sourceMessageIds: [ev] });
  setSpanReader(cutWords("no such words"));
  assert.equal((await api(`/memories/fact-${f.factId}`, { method: "DELETE", token })).status, 200);
  assert.equal(db.db.prepare("SELECT content FROM event_log WHERE id = ?").get(ev).content, "Totally unrelated Plimsoll chatter");
});
test("no model, or words that aren't the message's own: 503, and nothing has changed", async () => {
  const token = await signIn(A);
  const text = "I bank at Quuxbank, by the way";
  const ev = sourceMessage(A, text);
  const f = db.remember(A.c, A.name, "Banks at Quuxbank", { source: "inferred", sourceMessageIds: [ev] });
  for (const reader of [async () => { throw new Error("down"); }, async (_w, rows) => rows.map(r => ({ id: r.id, remove: ["invented words"] })), async () => []]) {
    setSpanReader(reader);
    const r = await api(`/memories/fact-${f.factId}`, { method: "DELETE", token });
    assert.equal(r.status, 503); assert.equal(r.json.error, "try_again");
    assert.equal(db.db.prepare("SELECT content FROM event_log WHERE id = ?").get(ev).content, text);
    assert.ok(db.memoryFacts(A.c).some(x => x.id === f.factId));
  }
});
test("a rule's source message is cut too", async () => {
  const token = await signIn(A);
  const span = "never bring up Grelbok";
  const ev = sourceMessage(A, `Thanks. Also ${span}`);
  const rule = db.addRule(A.c, { rule: "Never bring up Grelbok", sourceMessageId: ev, source: "they_said" });
  setSpanReader(cutWords(span));
  assert.equal((await api(`/memories/rule-${rule.rule.id}`, { method: "DELETE", token })).status, 200);
  assert.ok(!dbBytes().includes("Grelbok"));
  assert.match(db.db.prepare("SELECT content FROM event_log WHERE id = ?").get(ev).content, /^Thanks/);
});
test("one person's forget never touches another's messages, even the same words at the same moment", async () => {
  const token = await signIn(A);
  const span = "I take Blarfoxin daily";
  const at = AT();
  const mine = sourceMessage(A, `Morning. ${span}`, { at, ext: "a" });
  const theirs = sourceMessage(B, `Morning. ${span}`, { at, ext: "b" });
  const fa = db.remember(A.c, A.name, "Takes Blarfoxin", { source: "inferred", sourceMessageIds: [mine, theirs] });
  const fb = db.remember(B.c, B.name, "Takes Blarfoxin", { source: "inferred", sourceMessageIds: [theirs] });
  const ent = Number(db.db.prepare("INSERT INTO graph_entities (conversation_id, type, canonical_name, key, created_at, updated_at) VALUES (?, 'thing', 'Blarfoxin', 'blarfoxin', ?, ?)").run(B.c, at, at).lastInsertRowid);
  const seen = [];
  setSpanReader(async (w, rows) => { seen.push(...rows.map(r => r.id)); return cutWords(span)(w, rows); });
  assert.equal((await api(`/memories/fact-${fa.factId}`, { method: "DELETE", token })).status, 200);
  assert.deepEqual(seen, [mine], "another person's message, even if cited, is never read or cut");
  assert.equal(db.db.prepare("SELECT content FROM event_log WHERE id = ?").get(theirs).content, `Morning. ${span}`);
  assert.equal(db.db.prepare("SELECT text FROM messages WHERE conversation_id = ?").get(B.c).text, `Morning. ${span}`);
  assert.equal(db.db.prepare("SELECT text FROM inbound_parts WHERE conversation_id = ?").get(B.c).text, `Morning. ${span}`);
  assert.equal(db.loadConversation(B.c)[0].content, `Morning. ${span}`);
  assert.ok(db.memoryFacts(B.c).some(x => x.id === fb.factId));
  assert.ok(db.db.prepare("SELECT 1 AS x FROM graph_entities WHERE id = ?").get(ent));
});

test("app sign-in is a flat 90 days: 60 idle days still open it and it stays revocable; day 91 doesn't; Web keeps its idle limit", async () => {
  const token = await signIn(A);
  const DAY = 86_400_000;
  db.db.exec(`UPDATE page_sessions SET created_at = ${AT() - 60 * DAY}, last_seen_at = ${AT() - 60 * DAY}`);
  assert.equal((await api("/page", { token })).status, 200);
  db.db.exec(`UPDATE page_sessions SET last_seen_at = ${AT() - 60 * DAY}`);
  assert.equal(db.pageSessionsFor(A.c, { maxAgeMs: 90 * DAY, idleMs: 30 * DAY }).length, 1, "still listed where Web Settings looks");
  const web = "z".repeat(43);
  db.startPageSession(`wsign:${A.c}`, web, { conversationId: A.c });
  db.db.prepare("UPDATE page_sessions SET last_seen_at = ? WHERE client IS NULL").run(AT() - 31 * DAY);
  assert.equal(db.pageSessionsFor(A.c, { maxAgeMs: 90 * DAY, idleMs: 30 * DAY }).length, 1, "a browser idle past 30 days is not");
  const { sessionAccount } = await import("../src/pages/websignin.js");
  config.web = true;
  assert.equal(sessionAccount({ cookie: `reason_page=${web}` }), null, "Web unchanged");
  config.web = false;
  const list = (await api("/auth/sessions", { token })).json.sessions;
  assert.equal(list.length, 1);
  db.db.exec(`UPDATE page_sessions SET created_at = ${AT() - 91 * DAY}`);
  assert.equal((await api("/page", { token })).status, 401);
});

test("forgetting: wordings that collapse to one mark don't jam it, and an already-forgotten wording coming back can be forgotten again", async () => {
  const token = await signIn(A);
  setSpanReader(async (_w, rows) => rows.map(r => ({ id: r.id, remove: [] })));
  const f = db.remember(A.c, A.name, "I like Zelkova tea", {});
  const c = await api(`/memories/fact-${f.factId}/correct`, { method: "POST", token, body: { text: "i like zelkova tea." } });
  assert.equal(c.status, 200, c.body);
  assert.equal((await api(`/memories/${c.json.id}`, { method: "DELETE", token })).status, 200);
  assert.ok(!dbBytes().toLowerCase().includes("zelkova"));
  const said = db.remember(A.c, A.name, "Drinks Wisteria", { source: "user_stated" });
  const other = db.remember(A.c, A.name, "Eats Kumquat", { source: "user_stated" });
  assert.equal((await api(`/memories/fact-${said.factId}`, { method: "DELETE", token })).status, 200);
  const fixed = await api(`/memories/fact-${other.factId}/correct`, { method: "POST", token, body: { text: "Drinks Wisteria" } });
  assert.equal((await api(`/memories/${fixed.json.id}`, { method: "DELETE", token })).status, 200);
  assert.ok(!dbBytes().includes("Wisteria"));
});
test("a failure midway leaves the memory and its message as they were", async () => {
  const token = await signIn(A);
  const ev = sourceMessage(A, "keep this. I fly Snarfwing");
  const f = db.remember(A.c, A.name, "Flies Snarfwing", { source: "inferred", sourceMessageIds: [ev] });
  setSpanReader(cutWords("I fly Snarfwing"));
  db.db.exec("CREATE TRIGGER boom BEFORE UPDATE ON person_facts WHEN pt(NEW.fact) LIKE 'forgotten:%' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  try { await assert.rejects(api(`/memories/fact-${f.factId}`, { method: "DELETE", token })); } finally { db.db.exec("DROP TRIGGER boom"); }
  assert.equal(db.db.prepare("SELECT content FROM event_log WHERE id = ?").get(ev).content, "keep this. I fly Snarfwing");
  assert.ok(db.memoryFacts(A.c).some(x => x.id === f.factId));
  assert.equal((await api(`/memories/fact-${f.factId}`, { method: "DELETE", token })).status, 200, "and it can be tried again");
});
test("the cut only reaches copies of that message: the same word in a different message nearby stays", async () => {
  const token = await signIn(A);
  const ev = sourceMessage(A, "Allergic to Peanuts, sadly", { ext: "p1" });
  db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, 'user', 'fake', 'Bought Peanuts for the party', ?)").run(A.c, clock.now());
  const f = db.remember(A.c, A.name, "Allergic to Peanuts", { source: "inferred", sourceMessageIds: [ev] });
  setSpanReader(cutWords("Peanuts"));
  assert.equal((await api(`/memories/fact-${f.factId}`, { method: "DELETE", token })).status, 200);
  assert.ok(db.db.prepare("SELECT 1 AS x FROM messages WHERE text = 'Bought Peanuts for the party'").get());
});
test("forget everything also empties stored inbound and sent copies; someone else's stay", async () => {
  const token = await signIn(A);
  for (const p of [A, B]) {
    sourceMessage(p, "Inbound Ploughshare words", { ext: `i-${p.phone}` });
    db.db.prepare("INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, created_at, updated_at) VALUES (?, ?, 'fake', ?, 'Sent Ploughshare words', 'sent', ?, ?)").run(`k-${p.phone}`, p.c, p.phone, clock.now(), clock.now());
  }
  assert.equal((await api("/memories/forget-everything", { method: "POST", token, body: { confirm: "FORGET EVERYTHING" } })).status, 200);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM inbound_parts WHERE conversation_id = ?").get(A.c).n, 0);
  assert.equal(db.db.prepare("SELECT body FROM outbox WHERE conversation_id = ?").get(A.c).body, "");
  assert.equal(db.db.prepare("SELECT body FROM outbox WHERE conversation_id = ?").get(B.c).body, "Sent Ploughshare words");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM inbound_parts WHERE conversation_id = ?").get(B.c).n, 1);
});

// ---------------------------------------------------------------- owner mode
test("owner mode: everyone but the signed-in owner gets exactly what the API being off answers, even a real code request", async () => {
  const told = [];
  const a = await signIn(A);
  const b = await signIn(B, { ch: challenge("b") });
  config.iosApi = "owner";
  const server = createServer({ router: { get: () => null, all: () => [], channels: () => [] }, runtime: { _tell: async (c, l) => { told.push({ c, l }); return { ok: true }; } }, log: () => {} });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const miss = await fetch(`${base}/no/such/address`, { method: "GET" }), missBody = await miss.text();
    const post = (p, body, token) => fetch(base + p, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
    const get = (p, token) => fetch(base + p, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const same = async (r, why) => { assert.equal(r.status, 404, why); assert.equal(await r.text(), missBody, why); };
    await same(await get("/ios/v1/page", b), "non-owner's token");
    await same(await get("/ios/v1/live", b), "non-owner's live");
    await same(await post("/ios/v1/messages", { id: "abcdefgh", text: "hi" }, b), "non-owner's message");
    await same(await get("/ios/v1/page"), "no token");
    await same(await get("/ios/v1/page", "n".repeat(43)), "bad token");
    await same(await post("/ios/v1/auth/code", { phone: B.phone, challenge: challenge("c") }), "non-owner asks");
    await same(await post("/ios/v1/auth/code", { phone: "+16465550101", challenge: challenge("c") }), "stranger asks");
    await same(await post("/ios/v1/auth/code", { phone: "x" }), "malformed");
    await same(await fetch(`${base}/ios/v1/auth/code`, { method: "POST", body: "x".repeat(3_000_000) }), "oversized body");
    assert.equal(told.length, 0, "nobody but the owner is texted");
    await same(await post("/ios/v1/auth/code", { phone: A.phone, challenge: challenge("o") }), "the owner's own request answers the same");
    assert.equal(told.length, 1); assert.equal(told[0].c, A.c);
    const code = /code is (\d{6})/.exec(told[0].l)[1];
    await same(await post("/ios/v1/auth/verify", { phone: B.phone, challenge: challenge("o"), code }), "someone else using the code");
    await same(await post("/ios/v1/auth/verify", { phone: A.phone, challenge: challenge("o"), code: code === "000000" ? "000001" : "000000" }), "wrong code");
    const ok = await post("/ios/v1/auth/verify", { phone: A.phone, challenge: challenge("o"), code });
    assert.equal(ok.status, 200);
    const fresh = (await ok.json()).token;
    assert.equal((await get("/ios/v1/page", fresh)).status, 200);
    assert.equal((await get("/ios/v1/page", a)).status, 200);
    const inner = await get("/ios/v1/items/task-999999", a);
    assert.equal(inner.status, 404); assert.equal((await inner.json()).ok, false, "the owner's own miss is told apart from the API not existing");
  } finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
});

// ---------------------------------------------------------------- talking to Reason
function realPipeline(reply = "done, on it") {
  config.web = true;
  const turns = [];
  const runtime = new Runtime({ log: () => {}, runTurn: async (a) => { turns.push(a); return reply; } });
  const router = new Router({ runtime, log: () => {} });
  router.runtime = runtime;
  router.register(new FakeChannel({ number: "+16562167455" }));
  const web = router.register(new WebChannel());
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  runtime.on("outbound", async ({ conversationId, text, channel, to, chatId, fromOwner, replyTo }) => { await runtime.deliver({ conversationId, text, media: null, channel, to, chatId, fromOwner, replyTo }); });
  return { router, runtime, turns, web };
}
const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } return f(); };

test("a message runs the same turn as a text, on the token's own conversation; the reply comes over the live stream", async () => {
  const token = await signIn(A);
  const h = realPipeline("Reminder set for 9");
  const { res, chunks } = sink();
  try {
    liveRequest({ account: db.getAccount(A.c), token, headers: { authorization: `Bearer ${token}` }, router: h.router }).stream(res, new EventEmitter());
    const r = await api("/messages", { method: "POST", token, router: h.router, body: { id: "aaaaaaaa-1", text: "remind me at 9", conversation_id: B.c } });
    assert.equal(r.status, 200, r.body);
    assert.ok(await until(() => chunks.map(c => c.s).join("").includes("Reminder set for 9")), "reply on the stream");
    assert.equal(h.turns.length, 1);
    const events = chunks.map(c => c.s).filter(s => s.includes("event: message")).map(s => JSON.parse(/data: (.*)/.exec(s)[1]));
    assert.deepEqual(events.map(e => [e.role, e.text]), [["user", "remind me at 9"], ["reason", "Reminder set for 9"]]);
    assert.equal(events[0].client_id, "aaaaaaaa-1");
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?").get(B.c).n, 0, "a body naming someone else changes nothing");
    const again = await api("/messages", { method: "POST", token, router: h.router, body: { id: "aaaaaaaa-1", text: "remind me at 9" } });
    assert.equal(again.json.duplicate, true);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(h.turns.length, 1, "a retry doesn't run twice");
    const list = await api("/messages", { token, query: {} });
    assert.deepEqual(list.json.messages.map(m => m.role), ["user", "reason"]);
    const page = await api("/messages", { token, query: { after: String(list.json.messages[0].id) } });
    assert.deepEqual(page.json.messages.map(m => m.role), ["reason"]);
  } finally { res.emit("close"); config.web = false; }
});
test("messages are sealed and validated: another's history is never listed or streamed", async () => {
  const a = await signIn(A), b = await signIn(B, { ch: challenge("b") });
  db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, 'user', 'fake', 'Omari only words', ?)").run(A.c, clock.now());
  assert.ok(!(await api("/messages", { token: b, query: { after: "0" } })).body.includes("Omari only"));
  const { res, chunks } = sink();
  liveRequest({ account: db.getAccount(B.c), token: b, headers: { authorization: `Bearer ${b}` }, query: { after: "0" } }).stream(res, new EventEmitter());
  db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, 'user', 'fake', 'Omari later words', ?)").run(A.c, clock.now());
  await new Promise(r => setTimeout(r, 600));
  res.emit("close");
  assert.ok(!chunks.map(c => c.s).join("").includes("Omari"));
  for (const [body, want] of [[{ id: "x", text: "hi" }, 400], [{ id: "abcdefgh", text: "   " }, 400], [{ id: "abcdefgh", text: "y".repeat(4001) }, 413]]) assert.equal((await api("/messages", { method: "POST", token: a, body, router: {} })).status, want);
  assert.equal((await api("/messages", { method: "POST", token: a, body: { id: "abcdefgh", text: "hi" } })).status, 503);
  const refused = await api("/messages", { method: "POST", token: a, body: { id: "abcdefgh2", text: "hi" }, router: { deliver: async () => ({ ok: false, refused: "web_off" }) } });
  assert.equal(refused.status, 403);
});

// ---------------------------------------------------------------- sealed
test("sealed: every route, with Kofi's token and Omari's ids, answers exactly what an id that never existed answers", async () => {
  const a = await signIn(A);
  const b = await signIn(B, { ch: challenge("b") });
  const t = db.createTask(A.c, { title: "Omari private task", goal: "x", maxAttempts: 3 });
  db.finishTask(A.c, t.id, { state: "done", outcome: "ok", result: { headline: "Omari private headline" } });
  const cid = call(A.c);
  mkdirSync(config.recordingRoot, { recursive: true });
  writeFileSync(join(config.recordingRoot, "call-omari.mp3"), Buffer.from("OMARI AUDIO"));
  db.db.prepare("UPDATE calls SET state = 'completed', summary = 'Omari call', transcript = 'Omari transcript', recording_state = 'stored', recording_file = ?, recording_format = 'mp3' WHERE id = ?").run(join(config.recordingRoot, "call-omari.mp3"), cid);
  db.recordAgentcardPurchase({ conversationId: A.c, buyConversationId: "b9", status: "placed", amountCents: 500, merchant: "OmariShop", what: "x" });
  const pid = db.db.prepare("SELECT id FROM agentcard_purchases WHERE conversation_id = ?").get(A.c).id;
  const ask = db.askConfirmation({ conversationId: A.c, action: "message_send", summary: "Omari ask", stakes: "low", target: "x", askedAfterMsgs: 0 });
  const askId = ask.id ?? ask;
  const fact = db.remember(A.c, A.name, "Omari private fact", {}).factId;
  const rule = db.addRule(A.c, { rule: "Omari private rule", source: "they_said" }).rule.id;
  db.noteGuess(A.c, { about: A.name, guess: "Omari private guess" });
  const guess = db.db.prepare("SELECT id FROM guesses WHERE conversation_id = ?").get(A.c)?.id;
  const omariSessions = (await api("/auth/sessions", { token: a })).json.sessions;

  // Reachable with Omari's own token, or these prove nothing.
  for (const p of [`/items/task-${t.id}`, `/items/call-${cid}`, `/items/purchase-${pid}`, `/items/approval-${askId}`]) assert.equal((await api(p, { token: a })).status, 200, p);
  assert.equal((await api(`/calls/${cid}/recording`, { token: a })).status, 200);

  const nothing = await api("/items/task-999999", { token: b });
  for (const p of [`/items/task-${t.id}`, `/items/call-${cid}`, `/items/purchase-${pid}`, `/items/approval-${askId}`]) {
    const r = await api(p, { token: b });
    assert.equal(r.status, nothing.status, p);
    assert.equal(r.body, nothing.body, p);
  }
  assert.equal((await api(`/calls/${cid}/recording`, { token: b })).status, 404);
  assert.equal((await api(`/memories/fact-${fact}`, { method: "DELETE", token: b })).status, 404);
  assert.equal((await api(`/memories/rule-${rule}`, { method: "DELETE", token: b })).status, 404);
  assert.equal((await api(`/memories/fact-${fact}/correct`, { method: "POST", token: b, body: { text: "hijacked" } })).status, 404);
  assert.ok(guess);
  assert.equal((await api(`/memories/guess-${guess}`, { method: "POST", token: b, body: { answer: "yes" } })).status, 404);
  assert.equal((await api(`/auth/sessions/${omariSessions[0].id}`, { method: "DELETE", token: b })).status, 404);
  assert.equal((await api("/page", { token: a })).status, 200, "Omari is still signed in");
  assert.ok(db.memoryFacts(A.c).some(f => f.id === fact), "Omari's fact is untouched");

  // Nothing of Omari's in anything Kofi can list, nor does forget-everything cross over.
  for (const p of ["/page", "/memories", "/auth/sessions"]) assert.ok(!(await api(p, { token: b })).body.includes("Omari"), p);
  await api("/memories/forget-everything", { method: "POST", token: b, body: { confirm: "FORGET EVERYTHING" } });
  assert.ok(db.memoryFacts(A.c).some(f => f.id === fact), "Kofi's forget-everything reached only Kofi");
});
test("no route takes a person: a client naming someone else's conversation changes nothing", async () => {
  const b = await signIn(B);
  db.remember(A.c, A.name, "Omari secret line", {});
  const r = await api("/memories", { token: b, headers: { "x-conversation-id": A.c, cookie: `reason_page=${"x".repeat(43)}` } });
  assert.ok(!r.body.includes("Omari secret line"));
});

// ---------------------------------------------------------------- which message a reply answers (2026-11-09)
const turnlink = await import("../src/turnlink.js");
const sse = (chunks) => chunks.map(c => c.s).join("").split("\n\n").filter(Boolean).map(block => ({
  event: /^event: (.*)$/m.exec(block)?.[1] ?? null, data: (() => { const d = /^data: (.*)$/m.exec(block)?.[1]; return d ? JSON.parse(d) : null; })(),
}));

test("reply labels end to end: the stream's reply names the message it answers, then `done`; GET /messages says the same", async () => {
  const token = await signIn(A);
  const h = realPipeline("Reminder set for 9");
  const { res, chunks } = sink();
  try {
    liveRequest({ account: db.getAccount(A.c), token, headers: { authorization: `Bearer ${token}` }, router: h.router }).stream(res, new EventEmitter());
    assert.equal((await api("/messages", { method: "POST", token, router: h.router, body: { id: "bbbbbbbb-1", text: "remind me at 9" } })).status, 200);
    assert.ok(await until(() => sse(chunks).some(e => e.event === "done")), "a done event");
    const evs = sse(chunks).filter(e => e.event === "message" || e.event === "done");
    assert.deepEqual(evs.map(e => e.event), ["message", "message", "done"], "done comes after the reply it names");
    const [mine, reply, done] = evs.map(e => e.data);
    assert.equal(mine.client_id, "bbbbbbbb-1");
    assert.equal(mine.reply_to, null);
    assert.equal(mine.turn_done_at, null, "while the turn ran");
    assert.equal(reply.reply_to, mine.id, "the reply names the person's message by its id");
    assert.equal(reply.turn_done, false, "live, the turn hadn't ended yet");
    assert.deepEqual(done, { reply_to: mine.id, answers: [mine.id], last_reply: reply.id, at: done.at });
    assert.equal(typeof done.at, "number");
    // Old fields and names unchanged.
    for (const k of ["id", "role", "text", "at", "via", "client_id", "attachments"]) assert.ok(k in reply, k);

    const list = (await api("/messages", { token })).json.messages;
    const u = list.find(m => m.id === mine.id), r = list.find(m => m.id === reply.id);
    assert.equal(u.turn_done_at, done.at);
    assert.equal(r.reply_to, mine.id);
    assert.equal(r.turn_done, true, "the last reply of a finished turn");
    assert.equal(r.turn_done_at, null);
  } finally { res.emit("close"); config.web = false; }
});

test("reply labels: every reply in the turn names its message, only the last is turn_done; nothing outside the turn answers anybody", async () => {
  config.web = true;
  try {
    const token = await signIn(A);
    const u1 = db.writeMessage({ conversationId: A.c, role: "user", channel: "fake", externalId: "in-1", text: "find me a table" });
    const u2 = db.writeMessage({ conversationId: A.c, role: "user", channel: "fake", externalId: "in-2", text: "for four" });
    let n = 0;
    const say = (address, text) => { const { row } = db.enqueueOutbound({ idemKey: `t:${++n}`, conversationId: A.c, channel: "fake", address, body: text, toOwner: address === A.phone }); db.markOutboundSent(row.id); return row; };
    say(A.phone, "Morning, a reminder"); // before any turn: unprompted
    let late;
    const { turn, result } = turnlink.run({ conversationId: A.c, to: A.phone, held: [{ external_id: "in-1" }] }, async (t) => {
      say(A.phone, "On it");
      say("+14155550000", "Hi, a table for four?"); // somebody else: answers nothing of theirs
      t.fold = { added: [{ handle: "in-2" }] }; // "for four" folded in mid-turn
      say(A.phone, "Booked for four at 8");
      late = () => say(A.phone, "Left running after the turn");
    });
    await result;
    turnlink.close(turn);
    late(); // still inside the turn's async scope, but the turn is over
    const done = db.finishTurn(A.c, turnlink.handlesOf(turn));
    say(A.phone, "Your call went through"); // after: unprompted

    const list = (await api("/messages", { token })).json.messages;
    const by = Object.fromEntries(list.map(m => [m.text, m]));
    assert.equal(by["Morning, a reminder"].reply_to, null);
    assert.equal(by["On it"].reply_to, u1);
    assert.equal(by["Hi, a table for four?"]?.reply_to ?? null, null);
    assert.equal(db.db.prepare("SELECT answers_handle FROM outbox WHERE body = 'Hi, a table for four?'").get().answers_handle, null, "a text to somebody else answers nothing");
    assert.equal(db.db.prepare("SELECT answers_handle FROM outbox WHERE body = 'On it'").get().answers_handle, "in-1");
    assert.equal(by["Booked for four at 8"].reply_to, u2, "after a fold, the reply answers the newest message");
    assert.equal(by["Left running after the turn"].reply_to, null);
    assert.equal(by["Your call went through"].reply_to, null);
    assert.deepEqual(list.filter(m => m.turn_done).map(m => m.text), ["Booked for four at 8"]);
    assert.ok(by["find me a table"].turn_done_at && by["for four"].turn_done_at);
    assert.deepEqual({ ...done, at: 0 }, { conversationId: A.c, ids: [u1, u2], replyTo: u2, lastReply: by["Booked for four at 8"].id, at: 0 });
    // Another person's rows are never stamped by this turn.
    assert.equal(db.finishTurn(B.c, ["in-1"]), null);
  } finally { config.web = false; }
});

test("reply labels: a turn that sends nothing still ends, over the stream and in history", async () => {
  config.web = true;
  try {
    const token = await signIn(A);
    const u = db.writeMessage({ conversationId: A.c, role: "user", channel: "fake", externalId: "in-quiet", text: "thanks!" });
    const { res, chunks } = sink();
    liveRequest({ account: db.getAccount(A.c), token, headers: { authorization: `Bearer ${token}` } }).stream(res, new EventEmitter());
    try {
      db.finishTurn(B.c, ["nothing"]); // somebody else's turn: no event here
      db.finishTurn(A.c, ["in-quiet"]);
      const done = sse(chunks).filter(e => e.event === "done").map(e => e.data);
      assert.equal(done.length, 1);
      assert.deepEqual({ ...done[0], at: 0 }, { reply_to: u, answers: [u], last_reply: null, at: 0 });
      assert.equal((await api("/messages", { token })).json.messages.find(m => m.id === u).turn_done_at, done[0].at);
    } finally { res.emit("close"); }
  } finally { config.web = false; }
});

test("receipts: a call, a purchase and a checkout carry `at`, the same moment their Page line shows", async () => {
  const token = await signIn(A);
  db.db.exec(`CREATE TABLE IF NOT EXISTS shop_runs (run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, store TEXT NOT NULL, item TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL,
    status TEXT NOT NULL, last_request_id TEXT NOT NULL DEFAULT '', signed_in INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.db.exec("DELETE FROM shop_runs");
  const now = clock.now();
  const done = call(A.c);
  db.db.prepare("UPDATE calls SET state = 'completed', ended_at = ?, updated_at = ? WHERE id = ?").run(now - 5000, now - 1000, done);
  const live = call(A.c, { goal: "Call the dentist" });
  db.db.prepare("UPDATE calls SET state = 'in_progress', created_at = ? WHERE id = ?").run(now - 60_000, live);
  db.recordAgentcardPurchase({ conversationId: A.c, buyConversationId: "b-at", status: "placed", amountCents: 700, merchant: "Target", what: "Tape" });
  const pid = db.db.prepare("SELECT id FROM agentcard_purchases WHERE conversation_id = ?").get(A.c).id;
  db.db.prepare("UPDATE agentcard_purchases SET updated_at = ? WHERE id = ?").run(now - 3000, pid);
  db.db.prepare("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at) VALUES ('r_at1', ?, 'Ulta', 'Shampoo', 'buy', 'completed', ?, ?)").run(A.c, now - 9000, now - 2000);

  const page = (await api("/page", { token })).json.sections;
  const onPage = Object.fromEntries(Object.values(page).flat().map(i => [i.id, i.at]));
  const want = { [`call-${done}`]: now - 5000, [`call-${live}`]: now - 60_000, [`purchase-${pid}`]: now - 3000, "run-r_at1": now - 2000 };
  for (const [id, at] of Object.entries(want)) {
    const item = (await api(`/items/${id}`, { token })).json.item;
    assert.equal(item.at, at, id);
    assert.equal(onPage[id], at, `${id} on the Page`);
    assert.equal(item.at_iso, new Date(at).toISOString(), `${id} at_iso, ISO 8601 UTC`);
    assert.match(item.at_iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
});

// ---------------------------------------------------------------- progress lines (2026-11-09)
const progress = await import("../src/progress.js");
const { runTool } = await import("../src/tools.js");
const { AsyncResource } = await import("node:async_hooks");
// Made here, outside any turn: running inside it is how a CLI tool call arrives (its own HTTP request).
const outsideAnyTurn = new AsyncResource("cli-tool-call");

test("progress: the line is built from the real tool and its arguments, never a filler", () => {
  const mon = Date.parse("2026-11-09T15:00:00Z"); // a Monday in New York
  const o = { now: mon, tz: "America/New_York" };
  assert.equal(progress.phraseFor("web_search", { query: "CeraVe", sites: ["ulta.com", "https://www.target.com/s"] }), "Checking Ulta and Target for CeraVe");
  assert.equal(progress.phraseFor("web_search", { query: "best running shoes for flat feet" }), "Searching for best running shoes for flat feet");
  assert.equal(progress.phraseFor("calendar_events", { from: "2026-11-12T00:00:00-05:00", to: "2026-11-13T00:00:00-05:00" }, o), "Looking at Thursday's calendar");
  assert.equal(progress.phraseFor("calendar_events", { from: "2026-11-09" }, o), "Looking at today's calendar");
  assert.equal(progress.phraseFor("store_checkout", { store: "Ulta", item: "CeraVe cleanser" }), "Checking out CeraVe cleanser at Ulta");
  assert.equal(progress.phraseFor("flight_search", { origin: "JFK", destination: "LAX", depart_date: "2026-11-10" }, o), "Searching flights from JFK to LAX for tomorrow");
  assert.equal(progress.phraseFor("offer_check", { url: "https://www.sephora.com/product/x" }), "Checking the price on Sephora");
  assert.equal(progress.phraseFor("weather", { place: "Accra" }), "Checking the weather in Accra");
  // Nothing honest to say: nothing at all, not "Reading that…" or "Still working through it."
  for (const [name, input] of [["task_update", { note: "x" }], ["remember", { fact: "x" }], ["confirm_request", {}], ["message_send", { to: "owner", text: "hi" }], ["no_such_tool", {}]]) {
    assert.equal(progress.phraseFor(name, input), null, name);
  }
  for (const t of ["web_search", "research", "calendar_events", "gmail_search", "call_place", "nothing"]) {
    assert.doesNotMatch(String(progress.phraseFor(t, {}) ?? ""), /reading that|still working|one moment|thinking/i, t);
  }
  assert.ok(progress.phraseFor("research", { question: "x".repeat(400) }).length <= 60, "short");
});

test("progress privacy: anything that can name or reach someone else gets a neutral line, never its arguments", () => {
  const secret = /kofi|elm|555|@|maame|dentist|lunch/i;
  const cases = [
    ["message_send", { to: "+14155550000", text: "Kofi, your address is 12 Elm St" }, "Writing the message"],
    ["message_send", { to: "Kofi", text: "hi" }, "Writing the message"],
    ["voice_note_send", { to: "Maame", text: "hi" }, "Sending the voice note"],
    ["call_place", { to: "+14155550000", goal: "Ask Dr Kofi the dentist about Maame's results" }, "Getting the call ready"],
    ["gmail_search", { query: "from:kofi@example.com lunch" }, "Going through your email"],
    ["gmail_send", { to: "kofi@example.com", subject: "Lunch", body: "x" }, "Sending the email"],
    ["calendar_create", { summary: "Lunch with Kofi", attendees: ["kofi@example.com"], start: "2026-11-12T12:00:00Z" }, "Adding it to your calendar"],
    ["memory_search", { query: "Kofi's address" }, "Checking what I know"],
    ["graph_lookup", { entity: "Maame" }, "Checking what I know"],
    ["get_location", { action: "get" }, "Checking where you are"],
    ["directions", { to: "12 Elm St", place_name: "Kofi's house" }, "Working out the route"],
    ["event_guests", { event_named: "Maame's birthday" }, "Checking the guest list"],
    ["drive_search", { query: "Kofi lease" }, "Looking through your Drive"],
    ["timer_set", { note: "call Kofi at 555-0101" }, "Setting the reminder"],
  ];
  for (const [name, input, want] of cases) {
    const got = progress.phraseFor(name, input);
    assert.equal(got, want, name);
    assert.doesNotMatch(got, secret, name);
  }
  // Free text that does go in loses phone numbers, emails and web addresses.
  const q = progress.phraseFor("web_search", { query: "CeraVe +1 (415) 555-0000 kofi@example.com https://evil.example/x" });
  assert.equal(q, "Searching for CeraVe");
  assert.equal(progress.clean("+233 24 123 4567"), "");
});

test("progress: said only inside an open turn of theirs, once per line in a row", async () => {
  const heard = [];
  const on = (e) => heard.push(e);
  progress.progressEvents.on("say", on);
  try {
    assert.equal(progress.say(null, "web_search", { query: "x" }), null, "outside a turn (a reminder, a sweep): nothing");
    const { turn, result } = turnlink.run({ conversationId: A.c, to: A.phone, held: [{ external_id: "in-p1" }] }, async () => {});
    await result;
    progress.say(turn, "web_search", { query: "CeraVe" }, { answering: "in-p1" });
    progress.say(turn, "web_search", { query: "CeraVe" }, { answering: "in-p1" }); // the same line again: once
    progress.say(turn, "task_update", {}, { answering: "in-p1" }); // nothing to say
    turnlink.close(turn);
    progress.say(turn, "weather", { place: "Accra" }); // turn over: nothing
    assert.deepEqual(heard.map(e => [e.conversationId, e.handle, e.text]), [[A.c, "in-p1", "Searching for CeraVe"]]);
  } finally { progress.progressEvents.off("say", on); }
});

test("progress end to end: a CLI-style tool call outside the turn's scope says its line on the stream, naming the message; nobody else's stream hears it", async () => {
  const token = await signIn(A);
  const tokenB = await signIn(B);
  let foundTurn = null;
  const h = realPipeline("Here are your flights");
  h.runtime.runTurn = async (a) => {
    // The CLI backend's tool calls arrive as their own requests, outside the turn's async scope; they carry the fold token.
    await outsideAnyTurn.runInAsyncScope(async () => {
      foundTurn = turnlink.ofCall(A.c, a.foldToken);
      assert.equal(turnlink.ofCall(A.c, "fold-nope"), null, "a token that isn't this turn's finds nothing");
      assert.equal(turnlink.ofCall(B.c, a.foldToken), null, "another conversation's call finds nothing");
      await runTool("flight_list", {}, { conversationId: A.c, foldToken: a.foldToken, log: () => {} });
      await runTool("flight_list", {}, { conversationId: B.c, foldToken: a.foldToken, log: () => {} }); // someone else's: no line
    });
    return "Here are your flights";
  };
  const a = sink(), b = sink();
  try {
    liveRequest({ account: db.getAccount(A.c), token, headers: { authorization: `Bearer ${token}` }, router: h.router }).stream(a.res, new EventEmitter());
    liveRequest({ account: db.getAccount(B.c), token: tokenB, headers: { authorization: `Bearer ${tokenB}` }, router: h.router }).stream(b.res, new EventEmitter());
    assert.equal((await api("/messages", { method: "POST", token, router: h.router, body: { id: "pppppppp-1", text: "what flights do I have" } })).status, 200);
    assert.ok(await until(() => sse(a.chunks).some(e => e.event === "done")), "a done event");
    assert.ok(foundTurn, "the out-of-scope call found its turn by the fold token");
    assert.equal(foundTurn.open, false, "and the turn is closed once it ends");
    const evs = sse(a.chunks).filter(e => ["message", "progress", "done"].includes(e.event));
    assert.deepEqual(evs.map(e => e.event), ["message", "progress", "message", "done"]);
    const [mine, prog, reply] = evs.map(e => e.data);
    assert.deepEqual({ ...prog, at: 0 }, { reply_to: mine.id, text: "Checking your flights", tool: "flight_list", at: 0 });
    assert.equal(typeof prog.at, "number");
    assert.equal(reply.reply_to, mine.id);
    assert.ok(!sse(b.chunks).some(e => e.event === "progress"), "B's stream hears nothing of A's turn");
  } finally { a.res.emit("close"); b.res.emit("close"); config.web = false; }
});

test("reply labels: a text a CLI tool call queues from outside the turn's scope is still a reply", async () => {
  const { turn, result } = turnlink.run({ conversationId: A.c, to: A.phone, held: [{ external_id: "in-cli" }] }, async (t) => { t.fold = { token: "fold-cli-1", added: [] }; });
  await result;
  const row = await outsideAnyTurn.runInAsyncScope(() => turnlink.enter(turnlink.ofCall(A.c, "fold-cli-1"),
    () => db.enqueueOutbound({ idemKey: "cli:1", conversationId: A.c, channel: "fake", address: A.phone, body: "Found it", toOwner: true }).row));
  turnlink.close(turn);
  assert.equal(db.db.prepare("SELECT answers_handle FROM outbox WHERE id = ?").get(row.id).answers_handle, "in-cli");
  const after = await outsideAnyTurn.runInAsyncScope(() => turnlink.enter(turnlink.ofCall(A.c, "fold-cli-1"),
    () => db.enqueueOutbound({ idemKey: "cli:2", conversationId: A.c, channel: "fake", address: A.phone, body: "Later", toOwner: true }).row));
  assert.equal(db.db.prepare("SELECT answers_handle FROM outbox WHERE id = ?").get(after.id).answers_handle, null, "after the turn: answers nobody");
});
