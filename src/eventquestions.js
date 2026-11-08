// Guest questions (owner request 2026-11-08, events next-round #4): the organizer adds a few short
// questions guests answer when they join — "any dietary needs?", "your plus-one's name" — and reads
// the answers on their own /e/{id} page or by asking Reason.
//
// The rules, all here:
//   - At most 3 questions per event. Each is free text (an answer up to 200 characters) or one pick
//     from 2–6 short choices.
//   - Every question is optional for guests. Nothing about joining waits on an answer: the join page
//     shows them under the name with nothing required, and a text join asks them one at a time after
//     "you're in", where a pass is fine (owner rule: onboarding is not an interview).
//   - A question can be reworded only while nobody has answered it, so an answer always answers the
//     words it sits under (join stats, next round, reads these as they are). Once answered, the
//     organizer removes it (its answers go with it, after they are told how many) and adds a new one.
//   - Adding one never texts anybody. Guests already in see it on their own event page and can answer
//     there or by telling Reason; the organizer can ask them with a message to guests if they want.
//   - A guest changes or clears their own answers any time, on their page or by text.
//   - Answers are private to the organizer and the guest who gave them: never on the who's-going
//     list, never shown to another guest, never in a public view. Only joined guests' answers are read
//     back to the organizer.
//
// src/db.js holds the tables (event_questions, event_answers, event_claims.answers); this file is the
// only place that decides what a question or an answer may be.
import { createHash } from "node:crypto";
import * as db from "./db.js";

export const LIMITS = { questions: 3, prompt: 120, choicesMin: 2, choicesMax: 6, choice: 40, answer: 200 };

/** One line of plain text: control characters and runs of space folded to one space, trimmed. */
const line = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
const parseChoices = (q) => { try { const c = JSON.parse(q.choices ?? "[]"); return Array.isArray(c) ? c : []; } catch { return []; } };

/** A question as tools and pages read it. */
export function shape(q) {
  return { question_id: q.id, kind: q.kind, prompt: q.prompt, ...(q.kind === "choice" ? { choices: parseChoices(q) } : {}), version: q.version };
}
export function questionsOf(ev) {
  return db.eventQuestions(ev.id).map(shape);
}
/** Every answer a question holds, a guest who has since left included: what removing it deletes. */
export const answerCount = (questionId) => db.questionAnswerCount(questionId);
export function hasQuestions(ev) {
  return !!ev && db.eventQuestions(ev.id).length > 0;
}

/** What an organizer's question can't be, in words for them (and for the model to relay). */
export const WHY = {
  no_prompt: "Write the question first.",
  prompt_too_long: `A question can be up to ${LIMITS.prompt} characters.`,
  bad_kind: "A question is either free text or a pick from a few choices.",
  too_few_choices: `A pick-one question needs at least ${LIMITS.choicesMin} choices.`,
  too_many_choices: `A pick-one question can have up to ${LIMITS.choicesMax} choices.`,
  choice_too_long: `Each choice can be up to ${LIMITS.choice} characters.`,
  same_choice: "Two of the choices are the same.",
  too_many: `An event can have up to ${LIMITS.questions} questions. Remove one to add another.`,
  same_question: "The event already asks that.",
  not_found: "That question isn't on this event.",
  answered: "Guests have already answered that one, so it can't be reworded: their answers were to the old words. Remove it (its answers go with it) and add the new one.",
};

/** An organizer's question, checked: `{ ok, kind, prompt, choices }` or `{ ok: false, problem }`. */
export function readQuestion({ kind, prompt, choices = null } = {}) {
  const k = kind ?? "text";
  if (k !== "text" && k !== "choice") return { ok: false, problem: "bad_kind" };
  const p = line(prompt);
  if (!p) return { ok: false, problem: "no_prompt" };
  if (p.length > LIMITS.prompt) return { ok: false, problem: "prompt_too_long" };
  if (k === "text") return { ok: true, kind: k, prompt: p, choices: null };
  const list = (Array.isArray(choices) ? choices : String(choices ?? "").split(/\r?\n/)).map(line).filter(Boolean);
  if (list.length < LIMITS.choicesMin) return { ok: false, problem: "too_few_choices" };
  if (list.length > LIMITS.choicesMax) return { ok: false, problem: "too_many_choices" };
  if (list.some(c => c.length > LIMITS.choice)) return { ok: false, problem: "choice_too_long" };
  if (new Set(list.map(c => c.toLowerCase())).size !== list.length) return { ok: false, problem: "same_choice" };
  return { ok: true, kind: k, prompt: p, choices: list };
}

const sameWords = (a, b) => line(a).toLowerCase() === line(b).toLowerCase();

/**
 * Would this add or reword go through? The checks a yes must never be asked for when they fail:
 * `{ ok, question }` (the checked question) or `{ ok: false, problem }`.
 */
export function planQuestion(ev, { questionId = null, kind, prompt, choices } = {}) {
  const list = db.eventQuestions(ev.id);
  if (questionId != null) {
    const cur = list.find(q => q.id === Number(questionId));
    if (!cur) return { ok: false, problem: "not_found" };
    if (db.questionAnswerCount(cur.id) > 0) return { ok: false, problem: "answered" };
  } else if (list.length >= LIMITS.questions) return { ok: false, problem: "too_many" };
  const q = readQuestion({ kind, prompt, choices });
  if (!q.ok) return q;
  if (list.some(o => o.id !== Number(questionId) && sameWords(o.prompt, q.prompt))) return { ok: false, problem: "same_question" };
  return { ok: true, question: q };
}

/** The question in one line, as a confirmation names it: the words, and the choices when there are any. */
export function questionLine(q) {
  return `"${q.prompt}"${q.kind === "choice" ? ` (pick one: ${q.choices.join(" / ")})` : " (free text)"}`;
}

/**
 * What an organizer's yes to adding or rewording covers: this event and exactly these words and
 * choices, pinned by a hash, so a yes to one wording never saves another.
 */
export function questionTarget(ev, { questionId = null, question }) {
  const what = questionLine(question);
  const hash = createHash("sha256").update(JSON.stringify([question.kind, question.prompt, question.choices ?? []])).digest("hex").slice(0, 12);
  const verb = questionId != null ? `reword question #${Number(questionId)} on` : "add a question for guests of";
  return `${verb} ${String(ev.name).slice(0, 120)} (event #${ev.id}): ${what.slice(0, 400)} {${hash}}`;
}

/** Guests already in when a question is added: they are not texted, and see it on their own page. */
export function alreadyIn(ev) {
  return db.joinedCount(ev.id);
}

export function addQuestion(ev, input) {
  const plan = planQuestion(ev, input);
  if (!plan.ok) return plan;
  const row = db.insertEventQuestion({ eventId: ev.id, kind: plan.question.kind, prompt: plan.question.prompt, choices: plan.question.choices });
  return { ok: true, question: shape(row), already_in: alreadyIn(ev) };
}

export function rewordQuestion(ev, input) {
  const plan = planQuestion(ev, input);
  if (!plan.ok) return plan;
  const row = db.rewordEventQuestion({ eventId: ev.id, id: input.questionId, kind: plan.question.kind, prompt: plan.question.prompt, choices: plan.question.choices });
  // Somebody answered between the check and the change: the old words stay.
  return row ? { ok: true, question: shape(row) } : { ok: false, problem: "answered" };
}

/** Remove a question. With answers on it, only once the organizer knows how many go with it (`deleteAnswers`). */
export function removeQuestion(ev, questionId, { deleteAnswers = false } = {}) {
  const q = db.eventQuestion(ev.id, questionId);
  if (!q) return { ok: false, problem: "not_found" };
  const n = db.questionAnswerCount(q.id);
  if (n > 0 && !deleteAnswers) return { ok: false, problem: "has_answers", answers: n, question: shape(q) };
  const out = db.deleteEventQuestion(ev.id, q.id);
  return out.ok ? { ok: true, removed: shape(q), answers_deleted: out.answers } : { ok: false, problem: "not_found" };
}

// ---------------------------------------------------------------- answers

export const ANSWER_WHY = {
  empty: "There's nothing in that answer.",
  too_long: `An answer can be up to ${LIMITS.answer} characters.`,
  bad_choice: "That isn't one of the choices.",
  not_found: "That question isn't on this event any more.",
  not_guest: "Only a guest on the event can answer its questions.",
};

/**
 * One answer read against its question: `{ ok, choice, answer }` or `{ ok: false, problem }`. A choice
 * is its 0-based index or its exact label (case aside); free text is one line, up to 200 characters.
 */
export function readAnswer(q, { choice = null, text = null } = {}) {
  if (q.kind === "choice") {
    const labels = parseChoices(q);
    let i = Number.isInteger(choice) ? choice : -1;
    if (i < 0 && typeof choice === "string") i = labels.findIndex(l => sameWords(l, choice));
    if (i < 0 && text != null) i = labels.findIndex(l => sameWords(l, text));
    if (!(i >= 0 && i < labels.length)) return { ok: false, problem: "bad_choice" };
    return { ok: true, choice: i, answer: labels[i] };
  }
  const t = line(text);
  if (!t) return { ok: false, problem: "empty" };
  if (t.length > LIMITS.answer) return { ok: false, problem: "too_long" };
  return { ok: true, choice: null, answer: t };
}

/** A guest sets, changes or clears their own answer. Only a joined guest of this event. */
export function answerQuestion(ev, att, questionId, { choice = null, text = null, clear = false } = {}, via = "text") {
  if (!att || att.role === "organizer" || att.state !== "joined" || att.event_id !== ev.id) return { ok: false, problem: "not_guest" };
  const q = db.eventQuestion(ev.id, questionId);
  if (!q) return { ok: false, problem: "not_found" };
  if (clear) return { ok: true, cleared: db.clearEventAnswer(q.id, att.id), question: shape(q) };
  const a = readAnswer(q, { choice, text });
  if (!a.ok) return { ...a, question: shape(q) };
  db.setEventAnswer({ eventId: ev.id, questionId: q.id, attendeeId: att.id, conversationId: att.conversation_id, choice: a.choice, answer: a.answer, via });
  return { ok: true, question: shape(q), answer: a.answer };
}

/**
 * A join (or answers) form, read: `q_<id>` carries the typed words or the picked index, `qv_<id>` the
 * version the guest read, and — on a joined guest's own answers form only — `qo_<id>` the value the
 * page showed. A blank is a skip. A field left as the page showed it is not touched (an answer given
 * by text since the page opened is not overwritten or wiped), and a blank is a clear only where the
 * page showed an answer. `{ answers: [{ q, v, choice, answer }], problems, cleared: [{ id, was }] }` —
 * answers in the shape a join claim keeps (db.fileClaimAnswers), problems for the page to say.
 */
export function readForm(ev, get) {
  const answers = [], problems = [], cleared = [];
  for (const q of db.eventQuestions(ev.id)) {
    const raw = get(`q_${q.id}`);
    const was = get(`qo_${q.id}`);
    const v = Number(get(`qv_${q.id}`) ?? q.version);
    const val = raw == null ? "" : String(raw).trim();
    if (was != null && val === String(was)) continue;
    if (!val) { if (was) cleared.push({ id: q.id, was: String(was) }); continue; }
    const a = q.kind === "choice" ? readAnswer(q, { choice: /^\d+$/.test(String(raw)) ? Number(raw) : -1 }) : readAnswer(q, { text: raw });
    if (!a.ok) { problems.push({ question_id: q.id, prompt: q.prompt, problem: a.problem }); continue; }
    answers.push({ q: q.id, v, choice: a.choice, answer: a.answer });
  }
  return { answers, problems, cleared };
}

/** Put a form's answers on a guest who is in now; returns how many were filed. */
export function saveAnswers(ev, att, answers, via) {
  return answers?.length ? db.fileClaimAnswers(ev.id, att, answers, via) : 0;
}

/** The questions, each with this guest's own answer: theirs to see and change, nobody else's. */
export function guestQuestions(ev, att) {
  const mine = new Map((att ? db.answersOf(ev.id, att.id) : []).map(a => [a.question_id, a]));
  return db.eventQuestions(ev.id).map(q => {
    const a = mine.get(q.id);
    return { ...shape(q), your_answer: a ? a.answer : null, ...(a && q.kind === "choice" ? { your_choice: a.choice } : {}) };
  });
}

/**
 * The organizer's read: per question, how many of the guests in answered, the count per choice, and
 * each answer with whose it is. Joined guests only — somebody who left or was taken off is not read
 * back. Never for anyone but the organizer (callers go through events.managed).
 */
export function organizerSummary(ev) {
  const joined = db.attendeesOf(ev.id);
  const inNow = new Map(joined.map(a => [a.id, a]));
  const all = db.eventAnswers(ev.id).filter(a => inNow.has(a.attendee_id));
  return db.eventQuestions(ev.id).map(q => {
    const mine = all.filter(a => a.question_id === q.id);
    const answeredIds = new Set(mine.map(a => a.attendee_id));
    const out = {
      ...shape(q),
      answered: mine.length, guests: joined.length,
      answers: mine.map(a => ({ guest_id: a.attendee_id, name: a.display_name || "A guest", answer: a.answer })),
      not_answered: joined.filter(a => !answeredIds.has(a.id)).map(a => a.display_name || "A guest"),
    };
    if (q.kind === "choice") out.tally = parseChoices(q).map((label, i) => ({ choice: label, count: mine.filter(a => a.choice === i).length }));
    return out;
  });
}

/** Each joined guest's answers, by guest_id: what event_guests adds to every guest for the organizer. */
export function answersByGuest(ev) {
  const qs = new Map(db.eventQuestions(ev.id).map(q => [q.id, q]));
  const by = new Map();
  for (const a of db.eventAnswers(ev.id)) {
    if (a.state !== "joined" || !qs.has(a.question_id)) continue;
    if (!by.has(a.attendee_id)) by.set(a.attendee_id, []);
    by.get(a.attendee_id).push({ question: qs.get(a.question_id).prompt, answer: a.answer });
  }
  return by;
}
