// A call's opening line, written ahead by a model and picked at pickup (src/calls/greetings.js, 2026-11-15):
// the guard, never one of the last three, each caller's own first name and time zone, an unknown name, the
// plain fall-back, "again" within half an hour, a call Reason places, and no awaited model on the pickup path.
// Fixture people only.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-greetings-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Sam";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";

const g = await import("../src/calls/greetings.js");
const inbound = await import("../src/calls/inbound.js");
const carry = await import("../src/calls/carryover.js");
const identity = await import("../src/identity.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

// Three fixture accounts, as test/call-classic-everyone.test.js: each with its own name and clock.
const P = { A: "sendblue:+12025550111", B: "sendblue:+447700900222", C: "sendblue:+13105550333" };
const NAME = { A: "Ana Lima", B: "Bo", C: "" };
const ZONE = { A: "America/New_York", B: "Europe/London", C: "America/Los_Angeles" };
const at = (iso) => Date.parse(iso);

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  g.resetGreetings();
  db.db.exec("DELETE FROM accounts; DELETE FROM calls;");
  for (const k of Object.keys(P)) {
    db.upsertAccount({ conversationId: P[k], channel: "sendblue", address: P[k].split(":")[1], name: NAME[k], isOperator: k === "A" });
    db.setZoneFields(P[k], { confirmed: ZONE[k], confirmedAt: clock.now() });
  }
});

const written = (first, extra = {}) => ({
  for: first,
  morning: [`Morning, ${first}! How's it going?`, `Good morning, ${first}, nice to hear you.`],
  afternoon: [`Hey ${first}, good to hear from you!`, `Hi ${first}, how's your afternoon?`],
  evening: [`Evening, ${first}! How are you doing?`, `Hey ${first}, lovely to hear from you.`],
  night: [`Hey ${first}, you're up late!`, `Hi ${first}, good to hear you.`],
  again: [`Hey again, ${first}!`, `Oh hi again, ${first}.`],
  salute: [`Morning, ${first}`, `Hey ${first}`],
  ...extra,
});

test("guard: short, friendly lines pass; numbers, times, prices, places, claims, 'what did we miss', other names and long lines do not", () => {
  const ok = (l, o = {}) => g.greetingOk(l, { first: "Ana", ...o });
  assert.equal(ok("Hey Ana, good to hear from you!").ok, true);
  assert.equal(ok("Morning, Ana! How's it going?").ok, true);
  for (const [line, why] of [
    ["Hey Ana, what did we miss?", "what was missed"], ["yo, hey Ana, what'd we miss", "what was missed"],
    ["Hey Ana, it's 7 already!", "a number"], ["Hey Ana, see you at noon", "a time"], ["Hey Ana, that was ten bucks", "a number"],
    ["Hey Ana, the price dropped!", "a price"], ["Hey Ana, back at work?", "a place"], ["Hey Ana, I've booked it!", "a claim"],
    ["Hey Ana, Marco says hi", "a name that is not theirs"],
    ["Hey Ana, it is so very lovely to hear from you again today, really", "too long"],
  ]) assert.equal(ok(line).why, why, line);
  assert.equal(g.greetingOk("Hey Nimbus!", { first: "Ana", nicknames: ["Nimbus"] }).why, "their name for the assistant");
  assert.equal(g.greetingOk("Hey Ana, good to see you", { first: "", nicknames: [] }).ok, false, "a name, with none on file");
  assert.equal(g.greetingOk("Hey Ana!", { first: "Ana", recent: ["hey ana"] }).why, "said in the last three calls");
  assert.equal(g.greetingOk("Hey Ana, how are you?", { first: "Ana", salute: true }).ok, false, "a salute asks nothing");
});

test("pickup: a written line for their time of day in THEIR zone, never one of the last three; the plain line when none fits", () => {
  db.setCallGreetings(P.A, written("Ana"));
  clock.skip(at("2026-11-16T14:00:00Z") - clock.now()); // 9am New York, 2pm London
  const first = g.pickGreeting({ conversationId: P.A, name: NAME.A, refill: () => {} });
  assert.equal(first.from, "written");
  assert.equal(first.band, "morning");
  assert.match(first.line, /^(?:Morning|Good morning), Ana/);
  const seen = [first.line];
  for (let i = 0; i < 2; i++) seen.push(g.pickGreeting({ conversationId: P.A, name: NAME.A, refill: () => {} }).line);
  assert.equal(new Set(seen).size, 3, "no repeat across three calls");
  assert.equal(seen.at(-1), "Hey Ana.", "the morning lines used up: plain, never a repeat");
  assert.deepEqual(db.callGreetings(P.A).recent, [...seen].reverse());
  // A stock line equal to one of the last three is skipped.
  db.setCallGreetings(P.A, { ...written("Ana"), recent: ["Morning, Ana! How's it going?"] });
  assert.equal(g.pickGreeting({ conversationId: P.A, name: NAME.A, refill: () => {} }).line, "Good morning, Ana, nice to hear you.");
});

test("each caller gets their own first name and clock; an unknown name gets no name; nothing of anyone else's", () => {
  db.setCallGreetings(P.B, written("Bo"));
  clock.skip(at("2026-11-16T19:30:00Z") - clock.now()); // 7:30pm London, 2:30pm New York, 11:30am LA
  const b = g.pickGreeting({ conversationId: P.B, name: NAME.B, refill: () => {} });
  assert.equal(b.band, "evening", "London's evening, not the install's afternoon");
  assert.match(b.line, /Bo/);
  assert.doesNotMatch(b.line, /Ana|Sam/);
  const c = g.pickGreeting({ conversationId: P.C, name: NAME.C, refill: () => {} });
  assert.equal(c.line, "Hey.");
  // A stock written for another first name (they changed it) is not used.
  db.setCallGreetings(P.A, written("Bo"));
  assert.equal(g.pickGreeting({ conversationId: P.A, name: NAME.A, refill: () => {} }).line, "Hey Ana.");
});

test("no awaited model on the pickup path: the line comes back synchronously and the writer runs only afterwards", async () => {
  let asked = 0;
  const slowModel = () => { asked++; return new Promise(() => {}); }; // never answers
  const t0 = performance.now();
  const out = g.pickGreeting({ conversationId: P.A, name: NAME.A, refill: (c, o) => g.refillSoon(c, { ...o, ask: slowModel }) });
  const ms = performance.now() - t0;
  assert.equal(typeof out.line, "string", "not a promise");
  assert.equal(out.line, "Hey Ana.");
  assert.equal(asked, 0, "the model is not even asked before the line is returned");
  assert.ok(ms < 50, `pickup took ${ms.toFixed(1)} ms`);
  const line = inbound.openingLineFor({ person: { name: NAME.A }, conversationId: P.A, classic: true });
  assert.equal(typeof line, "string");
  await new Promise(r => setImmediate(r));
  assert.equal(asked, 1, "written in the background, once");
});

test("the writer keeps only lines that pass the guard, per band, for their first name", async () => {
  const ask = async () => ({ value: {
    morning: ["Morning, Ana! How's it going?", "Hey Ana, what did we miss?", "Good morning, Ana, it's 8 already"],
    afternoon: ["Hey Ana, good to hear from you!"], evening: ["Evening, Ana!", "Hey Ana, I booked dinner"],
    night: ["Hey Ana, you're up late!"], again: ["Hey again, Ana!"], salute: ["Hey Ana", "Morning Ana, how are you?"],
  } });
  const r = await g.writeGreetings(P.A, { name: NAME.A, ask });
  assert.equal(r.ok, true);
  const s = db.callGreetings(P.A);
  assert.deepEqual(s.morning, ["Morning, Ana! How's it going?"]);
  assert.deepEqual(s.evening, ["Evening, Ana!"]);
  assert.deepEqual(s.salute, ["Hey Ana"]);
  assert.equal(s.for, "Ana");
});

test("within half an hour of their last call: an 'again' line (no recital of what was left open), in classic", () => {
  db.setCallGreetings(P.A, written("Ana"));
  const row = db.createCall(P.A, { provider: "cartesia", toNumber: "+12025550111", isOwner: true, goal: "x", facts: [], direction: "in", externalId: "e1", state: "completed" });
  clock.skip(15 * 60_000);
  db.updateCall(P.A, row.id, { ended_at: clock.now() - 10 * 60_000, transcript: "Them: hi\nReason: hey", summary: "open: the trip plan" });
  const line = inbound.openingLineFor({ person: { name: NAME.A }, conversationId: P.A, classic: true });
  assert.match(line, /again, Ana/);
  assert.doesNotMatch(line, /picking up|trip/);
});

test("a call Reason places: a written salute, then why it rang; with nothing to say, '<salute>, what's up?'", () => {
  db.setCallGreetings(P.A, written("Ana"));
  const out = carry.greetingFor({ conversationId: P.A, name: NAME.A, direction: "out" });
  assert.match(out, /^(?:Morning, Ana|Hey Ana), what's up\?$/);
  const a = g.pickGreeting({ conversationId: P.A, name: NAME.A, kind: "salute", refill: () => {} });
  assert.ok(["Morning, Ana", "Hey Ana"].includes(a.line));
  assert.equal(g.pickGreeting({ conversationId: P.C, name: "", kind: "salute", refill: () => {} }).line, "hey");
});

test("the nickname they gave the assistant is never how a written line addresses them", () => {
  config.oneIdentity = "on";
  identity.setGivenName(P.A, "Nimbus");
  db.setCallGreetings(P.A, { ...written("Ana"), afternoon: ["Hey Nimbus, good to hear from you!", "Hi Ana, lovely to hear you!"], morning: ["Hey Nimbus!"], evening: ["Hey Nimbus!"], night: ["Hey Nimbus!"] });
  clock.skip(at("2026-11-16T19:00:00Z") - clock.now());
  const line = g.pickGreeting({ conversationId: P.A, name: NAME.A, refill: () => {} }).line;
  assert.doesNotMatch(line, /Nimbus/);
  config.oneIdentity = "off";
});
