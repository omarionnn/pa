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
  assert.deepEqual(first.asks, { guests_see: '"T-shirt size?" (pick one: S / M / L)', required: false, optional: true, guests_already_in: 2 });
  assert.equal(db.eventQuestions(ev.id).length, 0, "nothing saved before the yes");
  // Other words are another target: a yes to one wording never saves another.
  assert.notEqual(tools.questionsTarget(OWNER_C, { ...input, choices: ["S", "M", "XL"] }), first.use_target);
  const done = await yes("event_questions", input, OWNER_C, h.runtime);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(done.note, /Nobody was texted/);
  assert.match(done.note, /2 guests are already in: offer, in one short line, to have Reason text them/);
  assert.equal(done.can_ask_guests, 2);
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
  // Saved — and, with guests already in, the offer to text them comes next (its own confirm step; "Don't ask" texts nobody).
  assert.equal(added.status, 200);
  assert.match(unesc(added.body), /Ask the 2 guests already in\?/);
  const [q] = questions.questionsOf(ev);
  const skip = await post(h, ev, { action: "question_ask", step: "edit", qid: String(q.question_id) });
  assert.equal(skip.status, 303);
  assert.match(skip.headers.Location, /done=question_not_asked&g=2#questions$/);
  assert.equal(db.questionAskRows(q.question_id).length, 0, "declining owes nobody a text");
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
  assert.ok(data.COVERAGE.deleted.includes("event_question_asks"), "and the text owed or sent to them about a question");
  assert.ok("event_questions" in data.COVERAGE.kept);
});

// ---------- required questions (owner decision 2026-11-11) ----------

test("a required question: the yes names it, the join page won't go through without it, and a text join isn't finished until it's answered", async () => {
  const h = harness();
  const { ev } = await party(h, { asks: false });
  const input = { event_id: ev.id, action: "add", kind: "choice", prompt: "Will you bring a plus-one?", choices: ["Yes", "No"], required: true };
  const first = await tool("event_questions", input, OWNER_C, h.runtime);
  assert.equal(first.blocked, "needs_confirmation");
  assert.match(first.use_target, /"Will you bring a plus-one\?" \(pick one: Yes \/ No, required\) \{[0-9a-f]{12}\}$/);
  assert.deepEqual(first.asks, { guests_see: '"Will you bring a plus-one?" (pick one: Yes / No, required)', required: true, optional: false, guests_already_in: 2 });
  // Required and optional are different targets: a yes to one never saves the other.
  assert.notEqual(tools.questionsTarget(OWNER_C, { ...input, required: false }), first.use_target);
  const done = await yes("event_questions", input, OWNER_C, h.runtime);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.question.required, true);
  assert.match(done.note, /have to answer it to join; by text, Reason asks it before they're in/);
  assert.match(done.note, /won't be held to it/);
  const plus = questions.questionsOf(ev)[0];
  const opt = questions.addQuestion(ev, { kind: "text", prompt: "Song request?" }).question;
  await settle();
  assert.equal(h.channel.sent.length, 0, "adding texts nobody");

  // The join page: marked, required in the browser, and refused when blank anyway.
  db.startPageSession("p-esi", "tok-esi-gq-00000001", { conversationId: C.esi });
  const open = await req(h, ev);
  assert.match(open.body, /THE HOST ASKS<\/p>/);
  assert.match(open.body, /Will you bring a plus-one\?<small class="qt">REQUIRED<\/small>/);
  assert.match(open.body, /Song request\?<small class="qt">OPTIONAL<\/small>/);
  assert.match(open.body, new RegExp(`name="q_${plus.question_id}" value="0" required`));
  assert.ok(!new RegExp(`name="q_${opt.question_id}"[^>]*required`).test(open.body), "the optional one stays optional");
  const blank = await req(h, ev, { sub: "join", method: "POST", cookie: "reason_page=tok-esi-gq-00000001", body: form({ password: "skyline", [`q_${opt.question_id}`]: "Shaboozey" }) });
  assert.match(unesc(blank.body), /Will you bring a plus-one\?: the host asks everyone this one before they're in/);
  assert.equal(db.attendeeRow(ev.id, C.esi), null, "not in without it");
  // A crafted "left as the page showed it" field doesn't skip the check on a join form (review, 2026-11-11).
  const crafted = await req(h, ev, { sub: "join", method: "POST", cookie: "reason_page=tok-esi-gq-00000001", body: form({ password: "skyline", [`q_${plus.question_id}`]: "", [`qo_${plus.question_id}`]: "" }) });
  assert.match(unesc(crafted.body), /the host asks everyone this one/);
  assert.equal(db.attendeeRow(ev.id, C.esi), null, "a qo_ field is not a join form's to send");
  const craftedClaim = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "skyline", display_name: "Nana", [`q_${plus.question_id}`]: "", [`qo_${plus.question_id}`]: "" }) });
  assert.ok(!/Last step/.test(craftedClaim.body), "no claim without the required answer");
  const ok = await req(h, ev, { sub: "join", method: "POST", cookie: "reason_page=tok-esi-gq-00000001", body: form({ password: "skyline", [`q_${plus.question_id}`]: "1", [`qv_${plus.question_id}`]: "1" }) });
  assert.equal(ok.status, 200);
  assert.equal(db.attendeeRow(ev.id, C.esi).state, "joined");
  assert.deepEqual(db.answersOf(ev.id, db.attendeeRow(ev.id, C.esi).id).map(a => a.answer), ["No"]);

  // By text: the password is right, but they're not in until they answer; a pass isn't possible.
  db.upsertAccount({ conversationId: "dm:fake:+13475550009", channel: "fake", address: "+13475550009", name: "Yaw" });
  db.upsertThread({ conversationId: "dm:fake:+13475550009", channel: "fake", address: "+13475550009", isOwner: false });
  h.channel.sent.length = 0;
  const held = await tool("event_join", { name: "Rooftop Night", password: "skyline" }, "dm:fake:+13475550009", h.runtime);
  assert.equal(held.ok, false);
  assert.equal(held.reason, "needs_answers");
  assert.deepEqual(held.questions.map(x => [x.question, x.required, x.choices]), [["Will you bring a plus-one?", true, ["1. Yes", "2. No"]]]);
  assert.match(held.error, /not in yet/);
  assert.match(held.error, /can't be skipped/);
  assert.match(held.error, /without the password/);
  assert.equal(db.attendeeRow(ev.id, "dm:fake:+13475550009"), null, "not in");
  await settle();
  assert.equal(h.channel.sent.length, 0, "no welcome yet");
  // A wrong answer is still missing; the right one, without the password, finishes the join and files it.
  const still = await tool("event_join", { name: "Rooftop Night", answers: [{ question_id: plus.question_id, choice: 7 }] }, "dm:fake:+13475550009", h.runtime);
  assert.equal(still.reason, "needs_answers");
  const inNow = await tool("event_join", { name: "Rooftop Night", answers: [{ question_id: plus.question_id, choice: 1 }] }, "dm:fake:+13475550009", h.runtime);
  assert.equal(inNow.ok, true, JSON.stringify(inNow));
  assert.equal(inNow.joined, true);
  const yaw = db.attendeeRow(ev.id, "dm:fake:+13475550009");
  assert.equal(yaw.state, "joined");
  assert.deepEqual(db.answersOf(ev.id, yaw.id).map(a => [a.answer, a.via]), [["Yes", "text"]]);
  // Only the optional one is left to ask after "you're in".
  assert.deepEqual(inNow.questions.map(x => x.question), ["Song request?"]);
  assert.match(inNow.say, /also asks guests one short question, every one optional/);
  await settle();
  assert.ok(h.channel.sent.length >= 1, "the welcome went once they were in");
  // A required answer can be changed, never taken back.
  const clear = await tool("event_answer", { event_id: ev.id, question_id: plus.question_id, clear: true }, "dm:fake:+13475550009", h.runtime);
  assert.equal(clear.ok, false);
  assert.equal(clear.problem, "required");
  assert.equal((await tool("event_answer", { event_id: ev.id, question_id: plus.question_id, choice: 2 }, "dm:fake:+13475550009", h.runtime)).saved, "No");
  // Their own answers form offers no "No answer" for it, and a blank there is refused.
  db.startPageSession("p-yaw", "tok-yaw-gq-00000001", { conversationId: "dm:fake:+13475550009" });
  const own = await req(h, ev, { cookie: "reason_page=tok-yaw-gq-00000001" });
  assert.ok(!new RegExp(`name="q_${plus.question_id}" value=""`).test(own.body), "no way to take a required answer back");
  const wipe = await req(h, ev, { sub: "answers", method: "POST", cookie: "reason_page=tok-yaw-gq-00000001", origin: "https://files.example.test", body: form({ [`q_${plus.question_id}`]: "", [`qo_${plus.question_id}`]: "1", [`qv_${plus.question_id}`]: "1" }) });
  assert.match(unesc(wipe.body), /can be changed but not taken back/);
  assert.deepEqual(db.answersOf(ev.id, yaw.id).map(a => a.answer), ["No"]);
});

test("required is an organizer edit: on only while unanswered, off any time with answers standing; guests already in are never held to it", async () => {
  const h = harness();
  const { ev, g, q } = await party(h);
  questions.answerQuestion(ev, g.ama, q.food.question_id, { choice: 0 });
  // Answered: can't be made required (their answer was to an optional question); the words are untouched either way.
  const no = await tool("event_questions", { event_id: ev.id, action: "change", question_id: q.food.question_id, required: true }, OWNER_C, h.runtime);
  assert.equal(no.problem, "answered_required");
  assert.ok(!no.blocked, "refused before any yes");
  // Unanswered: a yes to exactly that, the words left out, and the version stays (no reword happened).
  const ask = await tool("event_questions", { event_id: ev.id, action: "change", question_id: q.plus.question_id, required: true }, OWNER_C, h.runtime);
  assert.equal(ask.blocked, "needs_confirmation");
  assert.match(ask.use_target, /^change question #\d+ on Rooftop Night \(event #\d+\): "Your plus-one's name" \(free text, required\) \{[0-9a-f]{12}\}$/);
  const on = await yes("event_questions", { event_id: ev.id, action: "change", question_id: q.plus.question_id, required: true }, OWNER_C, h.runtime);
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.match(on.note, /Everyone joining has to answer it now\. Guests already in aren't held to it/);
  assert.equal(db.eventQuestion(ev.id, q.plus.question_id).required, 1);
  assert.equal(db.eventQuestion(ev.id, q.plus.question_id).version, 1, "not a reword");
  // Ama and Kofi are in with no answer to it, and stay in; their own page saves the rest without it.
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "joined");
  const saved = await req(h, ev, { sub: "answers", method: "POST", cookie: COOKIE.ama, origin: "https://files.example.test", body: form({ [`q_${q.food.question_id}`]: "2", [`qo_${q.food.question_id}`]: "0", [`qv_${q.food.question_id}`]: "1", [`q_${q.plus.question_id}`]: "", [`qo_${q.plus.question_id}`]: "", [`qv_${q.plus.question_id}`]: "1" }) });
  assert.equal(saved.status, 303, saved.body?.slice(0, 200));
  assert.deepEqual(db.answersOf(ev.id, g.ama.id).map(a => a.answer), ["No restrictions"]);
  // Now answered and required: off again goes without a yes being refused, and the answer stands.
  questions.answerQuestion(ev, g.kofi, q.plus.question_id, { text: "Adjoa" });
  const off = await yes("event_questions", { event_id: ev.id, action: "change", question_id: q.plus.question_id, required: false }, OWNER_C, h.runtime);
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.match(off.note, /optional now\. Answers already given stand/);
  assert.equal(db.eventQuestion(ev.id, q.plus.question_id).required, 0);
  assert.deepEqual(db.answersOf(ev.id, g.kofi.id).map(a => a.answer), ["Adjoa"]);
  // The manage page: the box on the form, the confirm step names it, "Make it optional" on an answered required one.
  const review = unesc((await post(h, ev, { action: "question", step: "review", prompt: "T-shirt size?", kind: "choice", choices: "S\nM\nL", required: "1" })).body);
  assert.match(review, /Ask guests this\?/);
  assert.match(review, /GUESTS SEE · REQUIRED/);
  assert.match(review, /won't go through without it/);
  const added = await post(h, ev, { action: "question", step: "do", prompt: "T-shirt size?", kind: "choice", choices: "S\nM\nL", required: "1" });
  assert.equal(added.status, 200, "the offer to text the guests already in");
  const tee = questions.questionsOf(ev).find(x => x.prompt === "T-shirt size?");
  assert.equal(tee.required, true);
  questions.answerQuestion(ev, g.ama, tee.question_id, { choice: 1 });
  const pageNow = unesc((await req(h, ev, { cookie: COOKIE.owner })).body);
  assert.match(pageNow, /Make it optional/);
  const rev = unesc((await post(h, ev, { action: "question", step: "review", qid: String(tee.question_id), prompt: "T-shirt size?", kind: "choice", choices: "S\nM\nL" })).body);
  assert.match(rev, /Make it optional\?/);
  assert.match(rev, /Answers already given stand/);
  const did = await post(h, ev, { action: "question", step: "do", qid: String(tee.question_id), prompt: "T-shirt size?", kind: "choice", choices: "S\nM\nL" });
  assert.match(did.headers.Location, /done=question_optional/);
  assert.equal(db.eventQuestion(ev.id, tee.question_id).required, 0);
  assert.equal(db.questionAnswerCount(tee.question_id), 1);
  await settle();
  assert.equal(h.channel.sent.length, 0, "none of it texted anybody");
});

// ---------- asking the guests already in (owner decision 2026-11-11) ----------

test("after adding, the organizer can have Reason text the guests already in: one yes pinned to the words and the guests, sent by the sweep's rules, never twice", async () => {
  const h = harness();
  const { ev, g } = await party(h, { asks: false });
  db.updateAttendeeRow(g.kofi.id, { muted: 1 });
  const esi = db.addAttendee({ eventId: ev.id, conversationId: C.esi, displayName: "Esi", inDirectory: true, via: "text" }).attendee;
  const added = await yes("event_questions", { event_id: ev.id, action: "add", kind: "choice", prompt: "Any dietary needs?", choices: ["Vegetarian", "Vegan", "No restrictions"] }, OWNER_C, h.runtime);
  assert.equal(added.can_ask_guests, 2, "Ama and Esi; Kofi muted the event");
  const qid = added.question.question_id;
  const q = db.eventQuestion(ev.id, qid);
  // Esi answers on her own before the organizer decides: she is not asked.
  questions.answerQuestion(ev, esi, qid, { choice: 1 });
  const first = await tool("event_questions", { event_id: ev.id, action: "ask_guests", question_id: qid }, OWNER_C, h.runtime);
  assert.equal(first.blocked, "needs_confirmation");
  assert.match(first.use_target, /^ask 1 guest already in Rooftop Night \(event #\d+\) to answer "Any dietary needs\?" \(pick one: Vegetarian \/ Vegan \/ No restrictions\): Ama \{[0-9a-f]{12}\}$/);
  assert.equal(first.asks.guests, 1);
  assert.deepEqual(first.asks.names, ["Ama"]);
  assert.equal(first.asks.muted_not_asked, 1);
  assert.match(first.asks.text_they_get, /^Omari added a question for everyone going to Rooftop Night: "Any dietary needs\?" — Vegetarian, Vegan, No restrictions\. totally optional — if you'd like to answer, just text me/);
  assert.equal(db.questionAskRows(qid).length, 0, "nothing owed before the yes");
  // Somebody joining changes who it reaches: a different target.
  const target0 = first.use_target;
  const yaw = db.addAttendee({ eventId: ev.id, conversationId: "dm:fake:+13475550009", displayName: "Yaw", inDirectory: true, via: "text" }).attendee;
  assert.notEqual(tools.questionsTarget(OWNER_C, { event_id: ev.id, action: "ask_guests", question_id: qid }), target0);
  db.upsertAccount({ conversationId: "dm:fake:+13475550009", channel: "fake", address: "+13475550009", name: "Yaw" });
  db.upsertThread({ conversationId: "dm:fake:+13475550009", channel: "fake", address: "+13475550009", isOwner: false });
  const done = await yes("event_questions", { event_id: ev.id, action: "ask_guests", question_id: qid }, OWNER_C, h.runtime);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.asked, 2);
  assert.deepEqual(done.names, ["Ama", "Yaw"]);
  assert.match(done.note, /not at night for them, and never twice/);
  assert.equal(db.questionAskRows(qid).filter(r => r.state === "owed").length, 2);
  // Not sent in the turn: owed to the sweep, which is quiet at night in the event's zone.
  await settle();
  assert.equal(h.channel.sent.length, 0);
  clock.skip(10 * 60_000);
  const night = new Date(clock.now()); // 17:00 UTC + 24h set by beforeEach = 13:00 New York: daytime
  void night;
  // The runtime's pass runs both sweeps (Runtime.eventListNotes); here the asks' own.
  const sweep = await events.sweepQuestionAsks({ runtime: h.runtime });
  assert.equal(sweep.queued + sweep.sent, 2, JSON.stringify(sweep));
  assert.ok("asks" in (await h.runtime.eventListNotes()), "the runtime's event sweep carries the asks too");
  await settle();
  assert.equal(h.channel.sent.length, 2, "Ama and Yaw; Esi answered, Kofi muted");
  assert.match(h.channel.sent[0].text, /Omari added a question for everyone going to Rooftop Night/);
  assert.ok(h.channel.sent.every(m => [AMA, "+13475550009"].includes(m.to)), JSON.stringify(h.channel.sent.map(m => m.to)));
  assert.deepEqual(db.questionAskRows(qid).map(r => r.state).sort(), ["sent", "sent"]);
  // In their thread as Reason's own words, so the answer is read off it.
  assert.ok(db.loadConversation(C.ama).some(m => m.role === "assistant" && /added a question/.test(m.content)));
  // Never twice: nobody is left to ask, so it is refused before any yes.
  const again = await tool("event_questions", { event_id: ev.id, action: "ask_guests", question_id: qid }, OWNER_C, h.runtime);
  assert.equal(again.problem, "nobody_to_ask");
  assert.ok(!again.blocked);
  // A guest's leave drops a still-owed ask; a reword drops one too (the words they agreed to send are gone).
  const second = questions.addQuestion(ev, { kind: "text", prompt: "Song request?" }).question;
  const owed = events.oweQuestionAsks(ev, db.eventQuestion(ev.id, second.question_id));
  assert.equal(owed.asked, 3, "Ama, Esi, Yaw");
  db.leaveAttendee(db.attendeeRow(ev.id, C.esi).id);
  assert.ok(questions.rewordQuestion(ev, { questionId: second.question_id, prompt: "Any song requests?" }).ok);
  clock.skip(10 * 60_000);
  h.channel.sent.length = 0;
  const s2 = await events.sweepQuestionAsks({ runtime: h.runtime });
  await settle();
  assert.equal(h.channel.sent.length, 0, "the reworded question's asks are dropped, not sent");
  assert.deepEqual(db.questionAskRows(second.question_id).map(r => r.state), ["dropped", "dropped", "dropped"]);
  void s2;
  // Night holds it: owed at 22:00 in New York, sent after the morning.
  const third = questions.addQuestion(ev, { kind: "text", prompt: "Parking or transit?" }).question;
  events.oweQuestionAsks(ev, db.eventQuestion(ev.id, third.question_id));
  const base = clock.now();
  const hourNY = (t) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date(t)));
  while (hourNY(clock.now()) !== 22) clock.skip(HOUR);
  const late = await events.sweepQuestionAsks({ runtime: h.runtime });
  assert.equal(late.later, late.later && db.questionAskRows(third.question_id).filter(r => r.state === "owed").length, "held for the morning");
  assert.ok(late.later >= 1, JSON.stringify(late));
  while (hourNY(clock.now()) !== 10) clock.skip(HOUR);
  await events.sweepQuestionAsks({ runtime: h.runtime });
  await settle();
  assert.ok(h.channel.sent.length >= 1, "sent in the morning");
  assert.ok(h.channel.sent.every(m => /Parking or transit\?/.test(m.text)));
  void base;
  // The event's share text and creation reply tell the organizer they can ask questions.
  const made = await tool("event_create", { name: "Brunch", description: "eggs", starts_at: "2027-07-01T11:00", location: "Home", password: "mimosa", show_time_on_join: true, show_location_on_join: true, guest_list_visible: false }, C.ama, h.runtime);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.match(made.say, /ask people a few short questions when they join/);
  assert.match(made.say, /up to 3/);
  assert.ok(!/event_questions.*phrase/.test(made.say));
  const def = tools.EVENT_TOOL_DEFS.find(d => d.name === "event_create").description;
  assert.match(def, /Offer that, in one plain line, when the event sounds like one where it fits/);
});
