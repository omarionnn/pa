// Guest questions (owner request 2026-11-08, events next-round #4). Pinned:
//
//   - the organizer adds up to 3 questions, free text or pick one of 2–6 choices; by text, adding or
//     rewording takes their yes to exactly those words (refused BEFORE any yes when it can't be saved);
//     listing and removing need none; adding texts nobody;
//   - a question can be reworded only while nobody has answered it; removing one with answers says how
//     many go with it first, then deletes them;
//   - every question is optional: a join with nothing answered goes through on every route; the page
//     shows them under the name, a page claim carries them to the finishing text (and drops an answer
//     whose question was reworded meanwhile), a text join hands the model the questions to ask one at a
//     time;
//   - a guest changes or clears their own answer, by text (event_answer, choices by number) or on their
//     own event page (POST /e/<id>/answers, same-origin, guests only);
//   - answers are the organizer's alone: on the manage page (count per choice, each answer by name) and
//     in event_guests / event_questions — never on the who's-going page, never another guest's page,
//     never the public join page, never to another guest's model.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { withYes } from "./fixture-yes.js";

const dir = mkdtempSync(pathJoin(tmpdir(), "reason-event-questions-"));
process.env.REASON_DB_PATH = pathJoin(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_CADDY_SECRET = "caddy-test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_EVENTS = "on";
process.env.REASON_PAGES_V2 = "1";
delete process.env.REASON_AUTO_ADMIT;

const events = await import("../src/events.js");
const tools = await import("../src/eventtools.js");
const questions = await import("../src/eventquestions.js");
const { runTool, toolsFor, CONDITIONALLY_GATED } = await import("../src/tools.js");
const { eventRequestFor } = await import("../src/http.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const verify = await import("../src/calls/verify.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234", AMA = "+13475550000", KOFI = "+13475550001", ESI = "+13475550003", NEW1 = "+16465550101";
const OWNER_C = config.ownerConversation;
const C = { ama: `dm:fake:${AMA}`, kofi: `dm:fake:${KOFI}`, esi: `dm:fake:${ESI}` };
const LINE = "+16562167455";
const COOKIE = { owner: "reason_page=tok-owner-gq-0000001", ama: "reason_page=tok-ama-gq-00000001", kofi: "reason_page=tok-kofi-gq-0000001" };
const TZ = "America/New_York";
const HOUR = 60 * 60_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  const d = new Date(); d.setUTCHours(17, 0, 0, 0);
  clock.skip(d.getTime() + 24 * HOUR - Date.now());
  config.events = true;
  config.pagesV2 = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations;
    DELETE FROM inbound_messages; DELETE FROM page_sessions; DELETE FROM event_questions; DELETE FROM event_answers; DELETE FROM invite_allowances;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  for (const [c, a, n] of [[C.ama, AMA, "Ama"], [C.kofi, KOFI, "Kofi"], [C.esi, ESI, "Esi"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
    db.db.prepare("UPDATE accounts SET contact_card_sent_at = 1 WHERE conversation_id = ?").run(c);
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: false });
  }
  db.startPageSession("p-owner", "tok-owner-gq-0000001", { conversationId: OWNER_C });
  db.startPageSession("p-ama", "tok-ama-gq-00000001", { conversationId: C.ama });
  db.startPageSession("p-kofi", "tok-kofi-gq-0000001", { conversationId: C.kofi });
});

function harness() {
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "ok"; } });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router, channel, turns };
}
let seq = 0;
const texts = (from, body) => ({ channel: "fake", externalId: `gq${++seq}`, from, text: body, at: clock.now() });
const settle = () => new Promise(r => setTimeout(r, 40));
const tool = (name, input, c, rt) => runTool(name, input, { conversationId: c, messages: [], events: rt });
const yes = (name, input, c, rt) => withYes(runTool, name, input, { conversationId: c, messages: [], events: rt });
const form = (o) => new URLSearchParams(o).toString();
async function req(h, ev, { sub = null, method = "GET", body = null, query = {}, cookie = "", origin = null } = {}) {
  const headers = { cookie, "x-forwarded-for": "203.0.113.9", "x-files-domain": "true", "x-reason-caddy": "caddy-test", host: "files.example.test", ...(origin ? { origin } : {}) };
  return await eventRequestFor({ publicId: ev.public_id, sub, method, query, headers, remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router });
}
const post = (h, ev, fields, cookie = COOKIE.owner) => req(h, ev, { sub: "manage", method: "POST", body: form(fields), cookie });
const codeOf = (html) => /with code ([2-9A-HJKMNP-Z]{4})-([2-9A-HJKMNP-Z]{4})/.exec(decodeURIComponent(/href="sms:[^"]*body=([^"]+)"/.exec(html)[1].replace(/&amp;/g, "&")));
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** A party with Ama and Kofi in (by text), and the two questions most organizers ask. */
async function party(h, { asks = true } = {}) {
  const out = events.create(OWNER_C, {
    name: "Rooftop Night", description: "drinks", starts_at: "2027-06-05T20:00", timezone: TZ, location: "9 Pine St",
    welcome_message: "", password: "skyline", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true,
  });
  assert.equal(out.ok, true);
  const ev = out.event;
  const add = (c, name) => db.addAttendee({ eventId: ev.id, conversationId: c, displayName: name, inDirectory: true, via: "text" }).attendee;
  const g = { ama: add(C.ama, "Ama"), kofi: add(C.kofi, "Kofi") };
  let q = {};
  if (asks) {
    q.food = questions.addQuestion(ev, { kind: "choice", prompt: "Any dietary needs?", choices: ["Vegetarian", "Vegan", "No restrictions"] }).question;
    q.plus = questions.addQuestion(ev, { kind: "text", prompt: "Your plus-one's name" }).question;
  }
  await settle();
  h.channel.sent.length = 0;
  return { ev: db.getEventRow(ev.id), g, q };
}

// ---------- the organizer's questions ----------

test("by text, adding a question takes the organizer's yes to exactly those words; it texts nobody", async () => {
  const h = harness();
  const { ev } = await party(h, { asks: false });
  assert.ok(CONDITIONALLY_GATED.has("event_questions"));
  const input = { event_id: ev.id, action: "add", kind: "choice", prompt: "  T-shirt   size? ", choices: ["S", "M", "L"] };
  const first = await tool("event_questions", input, OWNER_C, h.runtime);
  assert.equal(first.blocked, "needs_confirmation");
  assert.match(first.use_target, /^add a question for guests of Rooftop Night \(event #\d+\): "T-shirt size\?" \(pick one: S \/ M \/ L\) \{[0-9a-f]{12}\}$/);
  assert.deepEqual(first.asks, { guests_see: '"T-shirt size?" (pick one: S / M / L)', optional: true, guests_already_in: 2 });
  assert.equal(db.eventQuestions(ev.id).length, 0, "nothing saved before the yes");
  // Other words are another target: a yes to one wording never saves another.
  assert.notEqual(tools.questionsTarget(OWNER_C, { ...input, choices: ["S", "M", "XL"] }), first.use_target);
  const done = await yes("event_questions", input, OWNER_C, h.runtime);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(done.note, /Nobody was texted/);
  assert.match(done.note, /2 guests already in can answer on their event page/);
  assert.deepEqual(questions.questionsOf(ev).map(q => [q.kind, q.prompt, q.choices]), [["choice", "T-shirt size?", ["S", "M", "L"]]]);
  await settle();
  assert.equal(h.channel.sent.length, 0, "adding a question texts nobody");
});

test("what can't be saved is refused before any yes: a fourth, no words, too few or too many choices, a repeat", async () => {
  const h = harness();
  const { ev } = await party(h);
  const ask = (more) => tool("event_questions", { event_id: ev.id, action: "add", ...more }, OWNER_C, h.runtime);
  for (const [more, problem] of [
    [{ kind: "text", prompt: "   " }, "no_prompt"],
    [{ kind: "choice", prompt: "Pick", choices: ["only one"] }, "too_few_choices"],
    [{ kind: "choice", prompt: "Pick", choices: ["a", "b", "c", "d", "e", "f", "g"] }, "too_many_choices"],
    [{ kind: "choice", prompt: "Pick", choices: ["Yes", "yes"] }, "same_choice"],
    [{ kind: "text", prompt: "x".repeat(121) }, "prompt_too_long"],
    [{ kind: "text", prompt: "any dietary NEEDS?" }, "same_question"],
  ]) {
    const out = await ask(more);
    assert.equal(out.blocked, undefined, `refused, not gated: ${problem}`);
    assert.equal(out.problem, problem);
  }
  questions.addQuestion(ev, { kind: "text", prompt: "Arriving when?" });
  const fourth = await ask({ kind: "text", prompt: "Anything else?" });
  assert.equal(fourth.problem, "too_many");
  assert.match(fourth.error, /up to 3 questions/);
  // A guest, and a stranger, get the usual organizer answers — nothing about the event's questions.
  const guest = await tool("event_questions", { event_id: ev.id, action: "list" }, C.ama, h.runtime);
  assert.equal(guest.ok, false);
  assert.ok(!JSON.stringify(guest).includes("dietary"));
  const stranger = await tool("event_questions", { event_id: ev.id, action: "list" }, C.esi, h.runtime);
  assert.equal(stranger.ok, false);
  assert.ok(!JSON.stringify(stranger).includes("dietary"));
});

test("a question is reworded only while nobody has answered it; removing an answered one says how many answers go first", async () => {
  const h = harness();
  const { ev, g, q } = await party(h);
  const reword = { event_id: ev.id, action: "change", question_id: q.plus.question_id, kind: "text", prompt: "Who are you bringing?" };
  const ok = await yes("event_questions", reword, OWNER_C, h.runtime);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(db.eventQuestion(ev.id, q.plus.question_id).version, 2, "a rewording moves the version");
  questions.answerQuestion(ev, g.ama, q.plus.question_id, { text: "Yaw" });
  const again = await tool("event_questions", { ...reword, prompt: "Bringing anyone?" }, OWNER_C, h.runtime);
  assert.equal(again.problem, "answered", "refused before a yes is asked");
  assert.match(again.error, /can't be reworded/);
  // Listing and removing ask for no yes.
  const first = await tool("event_questions", { event_id: ev.id, action: "remove", question_id: q.plus.question_id }, OWNER_C, h.runtime);
  assert.equal(first.problem, "has_answers");
  assert.equal(first.answers, 1);
  assert.equal(db.eventQuestions(ev.id).length, 2, "nothing removed yet");
  const gone = await tool("event_questions", { event_id: ev.id, action: "remove", question_id: q.plus.question_id, delete_answers: true }, OWNER_C, h.runtime);
  assert.equal(gone.ok, true);
  assert.equal(gone.answers_deleted, 1);
  assert.equal(db.answersOf(ev.id, g.ama.id).length, 0, "its answers went with it");
  assert.equal(db.eventQuestions(ev.id).length, 1);
});

// ---------- answering ----------

test("a text join hands the model the questions to ask one at a time, all optional; event_answer saves by choice number and by text", async () => {
  const h = harness();
  const { ev, q } = await party(h);
  assert.ok(!toolsFor(C.esi).some(t => t.name === "event_answer"), "event_answer only for a guest of an event that asks something");
  const joined = await tool("event_join", { name: "Rooftop Night", password: "skyline" }, C.esi, h.runtime);
  assert.equal(joined.ok, true, JSON.stringify(joined));
  const asked = joined.questions ?? joined.content?.questions ?? JSON.parse(JSON.stringify(joined)).questions;
  assert.deepEqual(asked.map(x => x.question), ["Any dietary needs?", "Your plus-one's name"]);
  assert.deepEqual(asked[0].choices, ["1. Vegetarian", "2. Vegan", "3. No restrictions"]);
  assert.match(joined.say, /every one optional/);
  assert.match(joined.say, /ask only the first/);
  assert.match(joined.say, /say they can skip it/);
  assert.ok(toolsFor(C.esi).some(t => t.name === "event_answer"));
  // Joining never waited on an answer.
  assert.equal(db.attendeeRow(ev.id, C.esi).state, "joined");

  const att = db.attendeeRow(ev.id, C.esi);
  const pick = await tool("event_answer", { event_id: ev.id, question_id: q.food.question_id, choice: 2 }, C.esi, h.runtime);
  assert.equal(pick.ok, true, JSON.stringify(pick));
  assert.equal(pick.saved, "Vegan");
  assert.deepEqual(db.answersOf(ev.id, att.id).map(a => [a.choice, a.answer, a.via]), [[1, "Vegan", "text"]]);
  const bad = await tool("event_answer", { event_id: ev.id, question_id: q.food.question_id, choice: 9 }, C.esi, h.runtime);
  assert.equal(bad.ok, false);
  assert.equal(bad.problem, "bad_choice");
  // Changed, then taken back.
  await tool("event_answer", { event_id: ev.id, question_id: q.food.question_id, choice: 1 }, C.esi, h.runtime);
  assert.equal(db.answersOf(ev.id, att.id)[0].answer, "Vegetarian");
  const typed = await tool("event_answer", { event_id: ev.id, question_id: q.plus.question_id, text: "Kwame" }, C.esi, h.runtime);
  assert.equal(typed.saved, "Kwame");
  const cleared = await tool("event_answer", { event_id: ev.id, question_id: q.plus.question_id, clear: true }, C.esi, h.runtime);
  assert.equal(cleared.cleared, true);
  assert.deepEqual(db.answersOf(ev.id, att.id).map(a => a.answer), ["Vegetarian"]);
  // Their own answers, in event_info, and nobody else's.
  questions.answerQuestion(ev, db.attendeeRow(ev.id, C.ama), q.plus.question_id, { text: "Ama's secret date" });
  const info = await tool("event_info", { event_id: ev.id }, C.esi, h.runtime);
  assert.deepEqual(info.questions.map(x => x.your_answer), ["Vegetarian", null]);
  assert.ok(!JSON.stringify(info).includes("secret date"), "another guest's answer never reaches a guest");
  // The organizer can't answer as a guest; a stranger can't at all.
  assert.equal((await tool("event_answer", { event_id: ev.id, question_id: q.plus.question_id, text: "x" }, OWNER_C, h.runtime)).ok, false);
  assert.equal(verify.isConsequential("event_answer", { event_id: ev.id, question_id: 1, text: "x" }), true, "a spoofed voice can't answer as them");
  assert.equal(verify.isConsequential("event_questions", { event_id: ev.id, action: "list" }), false);
  assert.equal(verify.isConsequential("event_questions", { event_id: ev.id, action: "add" }), true);
});

test("the join page shows the questions under the name, every one skippable; a signed-in join files the answers", async () => {
  const h = harness();
  const { ev, q } = await party(h);
  db.startPageSession("p-esi", "tok-esi-gq-00000001", { conversationId: C.esi });
  const open = await req(h, ev);
  assert.match(open.body, /THE HOST ASKS · ALL OPTIONAL/);
  assert.match(open.body, /Any dietary needs\?/);
  assert.match(open.body, /name="q_\d+" value="0"/);
  assert.match(open.body, /Only the host sees your answers/);
  assert.ok(!/name="q_\d+"[^>]*required/.test(open.body), "nothing about the questions is required");
  // A choice that isn't one is sent back with what they typed kept; the join didn't happen.
  const wrong = await req(h, ev, { sub: "join", method: "POST", cookie: "reason_page=tok-esi-gq-00000001", body: form({ password: "skyline", [`q_${q.food.question_id}`]: "7", [`q_${q.plus.question_id}`]: "Kwame" }) });
  assert.match(unesc(wrong.body), /Any dietary needs\?: That isn't one of the choices/);
  assert.match(wrong.body, /value="Kwame"/);
  assert.equal(db.attendeeRow(ev.id, C.esi), null);
  const ok = await req(h, ev, { sub: "join", method: "POST", cookie: "reason_page=tok-esi-gq-00000001", body: form({ password: "skyline", [`q_${q.food.question_id}`]: "0", [`qv_${q.food.question_id}`]: "1", [`q_${q.plus.question_id}`]: "" }) });
  assert.equal(ok.status, 200);
  const att = db.attendeeRow(ev.id, C.esi);
  assert.equal(att.state, "joined");
  assert.deepEqual(db.answersOf(ev.id, att.id).map(a => [a.answer, a.via]), [["Vegetarian", "join"]], "a blank is a skip");
});

test("a page claim carries the answers to the finishing text; one reworded meanwhile is dropped; nothing answered still joins", async () => {
  const h = harness();
  const { ev, q } = await party(h);
  const page = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "skyline", display_name: "Nana", [`q_${q.food.question_id}`]: "2", [`qv_${q.food.question_id}`]: "1", [`q_${q.plus.question_id}`]: "Akos", [`qv_${q.plus.question_id}`]: "1" }) });
  assert.match(page.body, /Last step/);
  const code = codeOf(page.body);
  // The organizer rewords the free-text one before the text arrives (nobody had answered it yet).
  assert.ok(questions.rewordQuestion(ev, { questionId: q.plus.question_id, kind: "text", prompt: "Who's your plus-one?" }).ok);
  const r = await h.router.deliver(texts(NEW1, `Hi Reason, I'm joining Rooftop Night with code ${code[1]}-${code[2]}`));
  assert.equal(r.event, "joined");
  const att = db.attendeeRow(ev.id, db.accountByAddress("fake", NEW1).conversation_id);
  assert.deepEqual(db.answersOf(ev.id, att.id).map(a => [a.answer, a.via]), [["No restrictions", "join"]], "only the answer to words still as they read them");
  // And a claim with nothing answered.
  const bare = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "skyline", display_name: "Yaa" }) });
  const c2 = codeOf(bare.body);
  const r2 = await h.router.deliver(texts("+16465550102", `Hi Reason, I'm joining Rooftop Night with code ${c2[1]}-${c2[2]}`));
  assert.equal(r2.event, "joined");
});

test("a guest changes their own answers on their event page; same-origin, guests only", async () => {
  const h = harness();
  const { ev, g, q } = await party(h);
  questions.answerQuestion(ev, g.ama, q.food.question_id, { choice: 0 });
  questions.answerQuestion(ev, g.kofi, q.plus.question_id, { text: "Kofi's cousin Adjoa" });
  const mine = await req(h, ev, { cookie: COOKIE.ama });
  assert.match(mine.body, /YOUR ANSWERS FOR THE HOST/);
  assert.match(mine.body, new RegExp(`name="q_${q.food.question_id}" value="0" checked`), "their own answer, picked");
  assert.ok(!mine.body.includes("Adjoa"), "never another guest's answer");
  const fields = { [`q_${q.food.question_id}`]: "1", [`qv_${q.food.question_id}`]: "1", [`q_${q.plus.question_id}`]: "Kojo", [`qv_${q.plus.question_id}`]: "1" };
  const evil = await req(h, ev, { sub: "answers", method: "POST", cookie: COOKIE.ama, origin: "https://evil.example", body: form(fields) });
  assert.equal(evil.status, 403);
  const stranger = await req(h, ev, { sub: "answers", method: "POST", body: form(fields) });
  assert.equal(stranger.status, 404);
  const host = await req(h, ev, { sub: "answers", method: "POST", cookie: COOKIE.owner, body: form(fields) });
  assert.equal(host.status, 404, "the organizer has no answers form");
  const saved = await req(h, ev, { sub: "answers", method: "POST", cookie: COOKIE.ama, body: form(fields) });
  assert.equal(saved.status, 303);
  assert.match(saved.headers.Location, /saved=answers#answers$/);
  assert.deepEqual(db.answersOf(ev.id, g.ama.id).map(a => a.answer), ["Vegan", "Kojo"]);
  // Blank clears what the page showed; "No answer" takes a pick back.
  const shownNow = { [`qo_${q.food.question_id}`]: "1", [`qo_${q.plus.question_id}`]: "Kojo" };
  await req(h, ev, { sub: "answers", method: "POST", cookie: COOKIE.ama, body: form({ ...shownNow, [`q_${q.food.question_id}`]: "1", [`q_${q.plus.question_id}`]: "" }) });
  assert.deepEqual(db.answersOf(ev.id, g.ama.id).map(a => a.answer), ["Vegan"]);
  assert.match((await req(h, ev, { cookie: COOKIE.ama })).body, /value="" ?> <span>No answer<\/span>/);
  await req(h, ev, { sub: "answers", method: "POST", cookie: COOKIE.ama, body: form({ [`qo_${q.food.question_id}`]: "1", [`q_${q.food.question_id}`]: "", [`qo_${q.plus.question_id}`]: "", [`q_${q.plus.question_id}`]: "" }) });
  assert.deepEqual(db.answersOf(ev.id, g.ama.id).map(a => a.answer), []);
  // A page opened before an answer given by text: saving it untouched neither wipes nor overwrites that answer.
  const stale = { [`qo_${q.food.question_id}`]: "", [`q_${q.food.question_id}`]: "", [`qo_${q.plus.question_id}`]: "", [`q_${q.plus.question_id}`]: "" };
  questions.answerQuestion(ev, g.ama, q.plus.question_id, { text: "Said by text" });
  questions.answerQuestion(ev, g.ama, q.food.question_id, { choice: 2 });
  await req(h, ev, { sub: "answers", method: "POST", cookie: COOKIE.ama, body: form(stale) });
  assert.deepEqual(db.answersOf(ev.id, g.ama.id).map(a => a.answer), ["No restrictions", "Said by text"]);
  // A question reworded since the page opened: nothing at all is saved.
  questions.addQuestion(ev, { kind: "text", prompt: "Arriving when?" });
  const late = questions.questionsOf(ev)[2];
  questions.rewordQuestion(ev, { questionId: late.question_id, kind: "text", prompt: "Arriving around when?" });
  const half = await req(h, ev, { sub: "answers", method: "POST", cookie: COOKIE.ama, body: form({ [`q_${q.plus.question_id}`]: "New name", [`qo_${q.plus.question_id}`]: "Said by text", [`qv_${q.plus.question_id}`]: "1", [`q_${late.question_id}`]: "9pm", [`qv_${late.question_id}`]: "1" }) });
  assert.match(unesc(half.body), /The host changed a question since you opened this page/);
  assert.deepEqual(db.answersOf(ev.id, g.ama.id).map(a => a.answer), ["No restrictions", "Said by text"], "nothing half-saved");
  const back = await req(h, ev, { cookie: COOKIE.ama, query: { saved: "answers" } });
  assert.match(back.body, /Saved\./);
});

// ---------- the organizer reads them; nobody else does ----------

test("answers are the organizer's alone: manage page and event_guests yes; who's-going, public page, other guests never", async () => {
  const h = harness();
  const { ev, g, q } = await party(h);
  questions.answerQuestion(ev, g.ama, q.food.question_id, { choice: 0 });
  questions.answerQuestion(ev, g.kofi, q.food.question_id, { choice: 0 });
  questions.answerQuestion(ev, g.ama, q.plus.question_id, { text: "Yaw Mensah" });
  const manage = unesc((await req(h, ev, { cookie: COOKIE.owner })).body);
  assert.match(manage, /06<\/span> · GUEST QUESTIONS/);
  assert.match(manage, /ANSWERED · 2 OF 2/);
  assert.match(manage, /Vegetarian<\/span><span class="mg-meta">2<\/span>/);
  assert.match(manage, /<small>Ama and Kofi<\/small>/);
  assert.match(manage, /<b>Ama<\/b><span>Yaw Mensah<\/span>/);
  assert.match(manage, /Not answered yet: Kofi\./);
  assert.ok(!/REWORD IT/.test(manage), "both are answered, so neither can be reworded");
  const guests = await tool("event_guests", { event_id: ev.id }, OWNER_C, h.runtime);
  assert.deepEqual(guests.guests.find(x => x.display_name === "Ama").answers, [{ question: "Any dietary needs?", answer: "Vegetarian" }, { question: "Your plus-one's name", answer: "Yaw Mensah" }]);
  assert.match(guests.note, /never tell one guest what another answered/);
  const list = await tool("event_questions", { event_id: ev.id, action: "list" }, OWNER_C, h.runtime);
  const flat = JSON.stringify(list);
  assert.ok(flat.includes("Yaw Mensah") && flat.includes('"count":2'));

  // Nobody else, anywhere.
  for (const html of [
    (await req(h, ev, { cookie: COOKIE.kofi })).body,
    (await req(h, ev, { sub: "who", cookie: COOKIE.kofi })).body,
    (await req(h, ev)).body,
  ]) assert.ok(!html.includes("Yaw Mensah"), "another guest's answer is on no page but the organizer's");
  assert.ok(!JSON.stringify(events.directoryEntries(ev)).includes("Yaw"));
  assert.ok(!JSON.stringify(await tool("event_info", { event_id: ev.id }, C.kofi, h.runtime)).includes("Yaw Mensah"));
  // A guest who left is not read back.
  db.leaveAttendee(g.ama.id);
  const after = questions.organizerSummary(ev);
  assert.ok(!JSON.stringify(after).includes("Yaw Mensah"));
});

test("the manage page adds, rewords and removes through a confirm step; a removal re-checks the count", async () => {
  const h = harness();
  const { ev, g } = await party(h, { asks: false });
  const empty = unesc((await req(h, ev, { cookie: COOKIE.owner })).body);
  assert.match(empty, /Ask guests something/);
  assert.match(empty, /Up to 3 short questions/);
  const review = await post(h, ev, { action: "question", step: "review", prompt: "Any dietary needs?", kind: "choice", choices: "Vegetarian\nVegan\n\nNo restrictions" });
  const shown = unesc(review.body);
  assert.match(shown, /Ask guests this\?/);
  assert.match(shown, /GUESTS SEE · OPTIONAL/);
  assert.match(shown, /The 2 guests already in aren't texted/);
  assert.equal(db.eventQuestions(ev.id).length, 0, "nothing saved by the review");
  const added = await post(h, ev, { action: "question", step: "do", prompt: "Any dietary needs?", kind: "choice", choices: "Vegetarian\nVegan\nNo restrictions" });
  assert.equal(added.status, 303);
  assert.match(added.headers.Location, /done=question_added&g=2#questions$/);
  const [q] = questions.questionsOf(ev);
  assert.deepEqual(q.choices, ["Vegetarian", "Vegan", "No restrictions"]);
  assert.match(unesc((await req(h, ev, { cookie: COOKIE.owner, query: { done: "question_added", g: "2" } })).body), /Added\. New guests see it when they join, and nobody was texted\. The 2 guests already in/);
  // Reworded while unanswered.
  assert.match(unesc((await req(h, ev, { cookie: COOKIE.owner })).body), /REWORD IT/);
  const rw = await post(h, ev, { action: "question", step: "do", qid: String(q.question_id), prompt: "Food needs?", kind: "choice", choices: "Vegetarian\nVegan\nNone" });
  assert.match(rw.headers.Location, /done=question_reworded/);
  const bad = await post(h, ev, { action: "question", step: "review", prompt: "Pick", kind: "choice", choices: "one" });
  assert.match(unesc(bad.body), /needs at least 2 choices/);
  // Removal with an answer: a confirm with the count, re-checked on the send.
  questions.answerQuestion(ev, g.ama, q.question_id, { choice: 2 });
  const rm = unesc((await post(h, ev, { action: "question_remove", step: "review", qid: String(q.question_id) })).body);
  assert.match(rm, /1 guest answered it\. Removing it deletes that answer for good/);
  questions.answerQuestion(ev, g.kofi, q.question_id, { choice: 0 });
  const stale = unesc((await post(h, ev, { action: "question_remove", step: "do", qid: String(q.question_id), n: "1" })).body);
  assert.match(stale, /More guests answered since you looked/);
  assert.equal(db.eventQuestions(ev.id).length, 1);
  const gone = await post(h, ev, { action: "question_remove", step: "do", qid: String(q.question_id), n: "2" });
  assert.match(gone.headers.Location, /done=question_removed&n=2/);
  assert.equal(db.eventQuestions(ev.id).length, 0);
  await settle();
  assert.equal(h.channel.sent.length, 0, "none of it texted anybody");
  // A guest's browser can't post to the organizer's page.
  const guestPost = await post(h, ev, { action: "question", step: "do", prompt: "x?", kind: "text" }, COOKIE.ama);
  assert.equal(guestPost.status, 404);
});

test("answers go when a guest leaves or is taken off; a rejoin starts empty; a spent claim keeps no copy", async () => {
  const h = harness();
  const { ev, g, q } = await party(h);
  questions.answerQuestion(ev, g.ama, q.food.question_id, { choice: 0 });
  questions.answerQuestion(ev, g.kofi, q.food.question_id, { choice: 1 });
  db.leaveAttendee(g.ama.id);
  assert.equal(db.answersOf(ev.id, g.ama.id).length, 0, "left: answers gone");
  await tool("event_guest_remove", { event_id: ev.id, guest_id: g.kofi.id }, OWNER_C, h.runtime);
  assert.equal(db.answersOf(ev.id, g.kofi.id).length, 0, "taken off: answers gone");
  // Nobody's answers left, so the question can be reworded again, and the page and the lock agree.
  assert.equal(questions.answerCount(q.food.question_id), 0);
  assert.equal(questions.planQuestion(ev, { questionId: q.food.question_id, kind: "text", prompt: "Food?" }).ok, true);
  await tool("event_join", { name: "Rooftop Night", password: "skyline" }, C.ama, h.runtime);
  assert.equal(db.answersOf(ev.id, db.attendeeRow(ev.id, C.ama).id).length, 0, "rejoin starts empty");
  const page = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "skyline", display_name: "Nana", [`q_${q.plus.question_id}`]: "Akos" }) });
  const code = codeOf(page.body);
  await h.router.deliver(texts(NEW1, `Hi Reason, I'm joining Rooftop Night with code ${code[1]}-${code[2]}`));
  assert.equal(db.eventClaimByCode(`${code[1]}${code[2]}`).answers, null, "the spent claim keeps no copy");
});

test("answers are filed cleanly for join stats: one row per guest per question, first answer time kept, theirs in a delete", async () => {
  const h = harness();
  const { ev, g, q } = await party(h);
  questions.answerQuestion(ev, g.ama, q.food.question_id, { choice: 0 });
  const first = db.answersOf(ev.id, g.ama.id)[0];
  clock.skip(HOUR);
  questions.answerQuestion(ev, g.ama, q.food.question_id, { choice: "vegan" });
  const now = db.answersOf(ev.id, g.ama.id);
  assert.equal(now.length, 1);
  assert.equal(now[0].answered_at, first.answered_at, "first answer's time kept");
  assert.ok(now[0].updated_at > first.updated_at);
  assert.deepEqual([now[0].choice, now[0].answer, now[0].conversation_id, now[0].event_id], [1, "Vegan", C.ama, ev.id]);
  const data = await import("../src/data.js");
  assert.ok(data.COVERAGE.deleted.includes("event_answers"), "a guest's delete takes their answers");
  assert.ok("event_questions" in data.COVERAGE.kept);
});
