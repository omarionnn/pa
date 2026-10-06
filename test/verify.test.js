// Reason checking its own work, so nobody else has to.
//
// Omari's line is "I shouldn't be quality control", and the four failures that make somebody into
// quality control are all silent: a link that does not open, a total that quietly dropped the fees
// they asked to have included, a message aimed at somebody from a different errand, and a page that
// was made but renders to nothing. Each one is a refusal before anything goes out, never an apology
// after it.
//
// And the one that matters most: "done" is refused on a job whose gated step was asked about and
// never executed. "Done" cannot mean "started" — that is the lie they cannot catch without doing
// the work themselves. `failed` and `cancelled` are never checked, so an honest close is always
// available.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-verify-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { verifyLink, verifyFeesShown, verifyRecipient, verifyPage, linksIn, checkFinish } = await import("../src/verify.js");

const C = "dm:verify";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM confirmations; DELETE FROM pages;");
});

const call = (name, input = {}, ctx = {}) => runTool(name, input, { conversationId: C, ...ctx });

/** A task whose sheet says fees are in the number and names one person. */
const withFeesAndKofi = () => call("task_start", {
  title: "find a place", goal: "a place under 2k all in, by nov 1",
  sheet: {
    constraints: {
      budget: { value: "under $2000 a month", source: "them", said: "under $2k a month" },
      fees_included: { value: "yes — the number has to be what I actually pay", source: "them", said: "including fees" },
      agent: { value: "Kofi (+13475550222)", source: "them", said: "the guy is Kofi, 347 555 0222" },
    },
  },
});

// ---------- the link ----------

test("a link that does not open is reported as dead, with the status, and not sent", async () => {
  const r = await verifyLink("https://example.com/gone", { lookup: async () => ({ ok: false, status: 404, error: "not found" }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.match(r.error, /does not open/i);
  assert.match(r.error, /Do NOT send it/);
});

test("a link that opens comes back ok, and a page that answered but is not readable text still counts as opening", async () => {
  const good = await verifyLink("https://example.com/listing", { lookup: async () => ({ ok: true, status: 200, title: "A flat" }) });
  assert.equal(good.ok, true);
  assert.equal(good.title, "A flat");
  // A PDF answers 200 and is not text. The question here is whether the link works, not whether
  // Reason can read what is behind it.
  const pdf = await verifyLink("https://example.com/lease.pdf", { lookup: async () => ({ ok: false, status: 200, error: "not readable text" }) });
  assert.equal(pdf.ok, true);
  assert.equal(pdf.not_readable, "not readable text");
});

test("something that is not a link, and something that is not http, are both refused without a fetch", async () => {
  let fetched = 0;
  const lookup = async () => { fetched++; return { ok: true }; };
  assert.equal((await verifyLink("ask kofi", { lookup })).ok, false);
  assert.equal((await verifyLink("file:///etc/passwd", { lookup })).ok, false);
  assert.equal(fetched, 0);
});

test("a lookup that throws is a dead link, not a crash", async () => {
  const r = await verifyLink("https://example.com", { lookup: async () => { throw new Error("getaddrinfo ENOTFOUND\nstack"); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOTFOUND/);
});

// ---------- the fees ----------

test("they asked for fees in the number, so a total with no fee line in it is refused", () => {
  const sheet = { constraints: { fees_included: { value: "yes", source: "them", said: "including fees" } } };
  const bad = verifyFeesShown({ sheet, total: "book the one at $1,850 a month" });
  assert.equal(bad.ok, false);
  assert.equal(bad.blocked, "fees_not_shown");
  assert.match(bad.error, /including fees/);
  const good = verifyFeesShown({ sheet, total: "$1,850 plus $120 in fees, $1,970 all in" });
  assert.equal(good.ok, true);
  assert.equal(good.checked, true);
});

test("no fees constraint, an explicit no, and a line with no money in it are all left alone", () => {
  assert.equal(verifyFeesShown({ sheet: {}, total: "book the $1,850 one" }).checked, false);
  const no = { constraints: { fees_included: { value: "no, quote me the base rent", source: "them" } } };
  assert.equal(verifyFeesShown({ sheet: no, total: "book the $1,850 one" }).ok, true);
  const yes = { constraints: { fees_included: { value: "yes", source: "them" } } };
  assert.equal(verifyFeesShown({ sheet: yes, total: "told the agent you are coming saturday" }).checked, false);
});

// ---------- the recipient ----------

test("a number that is not on the job is refused, and the sheet's own people are named back", () => {
  const sheet = { constraints: { agent: { value: "Kofi (+13475550222)", source: "them" } } };
  const wrong = verifyRecipient({ sheet, to: "+19175550000", task: 4 });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.blocked, "wrong_recipient");
  assert.match(wrong.error, /Kofi/);
  assert.match(wrong.error, /Nothing was sent/);
  // The same number, written the way a person writes it, is the same person.
  assert.equal(verifyRecipient({ sheet, to: "+1 347 555 0222", task: 4 }).ok, true);
});

test("a job that names nobody may reach nobody, and the owner is never checked against the sheet", () => {
  const nobody = verifyRecipient({ sheet: {}, to: "+19175550000", task: 4 });
  assert.equal(nobody.ok, false);
  assert.equal(nobody.blocked, "not_on_the_sheet");
  assert.equal(verifyRecipient({ sheet: {}, to: "owner" }).ok, true);
});

test("somebody the job is waiting on is somebody the job may reach", () => {
  const sheet = { waiting: [{ on: "the landlord at 441 graham", for: "whether saturday works" }] };
  assert.equal(verifyRecipient({ sheet, to: "the landlord at 441 graham" }).ok, true);
});

// ---------- the page ----------

test("a page that renders is ok; one with nothing on it is refused with the words to use instead", () => {
  const good = verifyPage({ id: "p1", title: "Three places", blocks: [{ type: "text", text: "the first one is closest" }], created_at: Date.now() });
  assert.equal(good.ok, true);
  assert.equal(good.blocks, 1);
  const empty = verifyPage({ id: "p2", title: "Three places", blocks: [], created_at: Date.now() });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /as text instead/);
  assert.equal(verifyPage(null).ok, false);
});

test("a page whose blocks do not render is taken away again rather than left with a link on it", async () => {
  const made = await call("page_create", { title: "Three places", blocks: [{ type: "text", text: "the first one is closest" }] });
  assert.equal(made.ok, true);
  assert.ok(db.getPageIn(C, made.page_id));
  // A block shape the renderer cannot handle: content checking lets the model's own data through,
  // and this is the read-back that catches what the shape check could not.
  const before = db.listPages(C).length;
  const broken = await call("page_create", { title: "Broken", blocks: [{ type: "nonsense", text: "x" }] });
  assert.equal(broken.ok, false);
  assert.equal(db.listPages(C).length, before, "nothing was left behind");
});

// ---------- done cannot mean started ----------

test("done is refused while a step it asked about has never gone through, and the ask is named", async () => {
  const t = await call("task_start", {
    title: "book the viewing", goal: "a viewing booked for saturday",
    sheet: { constraints: { agent: { value: "Kofi (+13475550222)", source: "them", said: "Kofi, 347 555 0222" } } },
  });
  const ask = await call("confirm_request", {
    action: "message_send", summary: "text Kofi that saturday 2pm works", target: "+13475550222", task_id: t.task.id,
  });
  assert.equal(ask.ok, true);
  const done = await call("task_finish", { task_id: t.task.id, state: "done", outcome: "viewing booked for saturday" });
  assert.equal(done.ok, false);
  assert.equal(done.blocked, "asked_but_never_done");
  assert.match(done.error, /saturday 2pm works/);
  assert.match(done.error, /cannot mean/i);
  assert.equal(db.getTask(C, t.task.id).state, "running", "nothing was written");
});

test("the same job closes as failed with the gate still open: an honest close is never blocked", async () => {
  const t = await call("task_start", {
    title: "book the viewing", goal: "a viewing booked for saturday",
    sheet: { constraints: { agent: { value: "Kofi (+13475550222)", source: "them", said: "Kofi, 347 555 0222" } } },
  });
  await call("confirm_request", { action: "message_send", summary: "text Kofi about saturday", target: "+13475550222", task_id: t.task.id });
  const failed = await call("task_finish", { task_id: t.task.id, state: "failed", outcome: "never heard back from Kofi" });
  assert.equal(failed.ok, true);
  assert.equal(db.getTask(C, t.task.id).state, "failed");
});

test("a refused ask does not hold a job open: a no is a real answer", async () => {
  const t = await call("task_start", {
    title: "book the viewing", goal: "a viewing booked",
    sheet: { constraints: { agent: { value: "Kofi (+13475550222)", source: "them", said: "Kofi, 347 555 0222" } } },
  });
  const ask = await call("confirm_request", { action: "message_send", summary: "text Kofi about saturday", target: "+13475550222", task_id: t.task.id });
  db.refuseConfirmation(ask.confirmation_id);
  const done = await call("task_finish", { task_id: t.task.id, state: "done", outcome: "went in person instead, viewing is saturday" });
  assert.equal(done.ok, true);
});

test("done is refused on a dead link in the outcome, and goes through on one that opens", async () => {
  const t = await call("task_start", { title: "find the lease", goal: "the lease pdf" });
  const dead = await call("task_finish", {
    task_id: t.task.id, state: "done", outcome: "here it is: https://example.com/lease.pdf",
  }, { lookup: async () => ({ ok: false, status: 404, error: "not found" }) });
  assert.equal(dead.ok, false);
  assert.equal(dead.blocked, "link_is_dead");
  assert.equal(db.getTask(C, t.task.id).state, "running");

  const live = await call("task_finish", {
    task_id: t.task.id, state: "done", outcome: "here it is: https://example.com/lease.pdf",
  }, { lookup: async () => ({ ok: true, status: 200, title: "Lease" }) });
  assert.equal(live.ok, true);
});

test("done is refused when the closing line quotes a total without the fees they asked for", async () => {
  const t = await withFeesAndKofi();
  const r = await call("task_finish", { task_id: t.task.id, state: "done", outcome: "took the one at $1,850 a month" });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, "fees_not_shown");
  assert.match(r.error, /they will believe/);
  const ok = await call("task_finish", { task_id: t.task.id, state: "done", outcome: "took the one at $1,850 plus $120 fees, $1,970 all in" });
  assert.equal(ok.ok, true);
});

test("checkFinish puts the gate first: a job with an open ask is not told about its dead link instead", async () => {
  const r = await checkFinish({
    sheet: {}, outcome: "done: https://example.com/gone",
    gates: [{ id: 3, action: "message_send", summary: "text Kofi" }],
    lookup: async () => { throw new Error("should not be fetched"); },
  });
  assert.equal(r.blocked, "asked_but_never_done");
});

test("linksIn finds each link once and drops the full stop at the end of a sentence", () => {
  assert.deepEqual(
    linksIn("two: https://a.example/x and https://a.example/x, then https://b.example/y."),
    ["https://a.example/x", "https://b.example/y"],
  );
});

// ---------- the ask itself ----------

test("the fee check runs before they are shown anything, and nothing is recorded when it refuses", async () => {
  const t = await withFeesAndKofi();
  const before = db.db.prepare("SELECT COUNT(*) n FROM confirmations").get().n;
  const r = await call("confirm_request", {
    action: "browser_submit", summary: "take the flat at $1,850 a month", target: "take the flat at $1,850 a month", task_id: t.task.id,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, "fees_not_shown");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM confirmations").get().n, before, "nothing was asked");
});

test("an ask aimed at somebody from a different errand is refused before it is asked", async () => {
  const t = await withFeesAndKofi();
  const r = await call("confirm_request", {
    action: "message_send", summary: "text them that saturday works, all in $1,970 including fees", target: "+19175550000", task_id: t.task.id,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, "wrong_recipient");
  const right = await call("confirm_request", {
    action: "message_send", summary: "text Kofi that saturday works, $1,970 all in including fees", target: "+13475550222", task_id: t.task.id,
  });
  assert.equal(right.ok, true);
});

test("an ask that reaches nobody — a browser click — is not checked against the people on the sheet", async () => {
  const t = await call("task_start", { title: "book it", goal: "a table saturday" });
  const r = await call("confirm_request", { action: "browser_submit", summary: "book the 8pm table", target: "book the 8pm table", task_id: t.task.id });
  assert.equal(r.ok, true);
});

test("an ask pinned to a task that is not this conversation's is refused, and nothing is recorded", async () => {
  const before = db.db.prepare("SELECT COUNT(*) n FROM confirmations").get().n;
  const r = await call("confirm_request", { action: "message_send", summary: "text somebody", target: "+13475550222", task_id: 9999 });
  assert.equal(r.ok, false);
  assert.match(r.error, /No task #9999/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM confirmations").get().n, before);
});

test("the task a turn was woken for is known without the model naming it", async () => {
  const t = await withFeesAndKofi();
  const r = await call("confirm_request", {
    action: "browser_submit", summary: "take the flat at $1,850 a month", target: "take the flat at $1,850 a month",
  }, { taskId: t.task.id });
  assert.equal(r.ok, false, "the sheet was found from the wake, not from the model");
  assert.equal(r.blocked, "fees_not_shown");
});

test("an ask with no task on it still holds that task's done back: forgetting to name one is not an escape", async () => {
  const t = await call("task_start", { title: "book the viewing", goal: "a viewing booked" });
  await call("confirm_request", { action: "message_send", summary: "text Kofi about saturday", target: "+13475550222" });
  const done = await call("task_finish", { task_id: t.task.id, state: "done", outcome: "booked" });
  assert.equal(done.ok, false);
  assert.equal(done.blocked, "asked_but_never_done");
});

test("an ask older than the task does not hold it back", async () => {
  await call("confirm_request", { action: "message_send", summary: "something from before", target: "+13475550222" });
  clock.skip(60_000);
  const t = await call("task_start", { title: "a new job", goal: "something else" });
  const done = await call("task_finish", { task_id: t.task.id, state: "done", outcome: "that one is done" });
  assert.equal(done.ok, true);
});

// ---------- an ask that says what is being approved ----------
//
// "Shall I proceed?" — and the person says yes, to what? A confirmation is worth exactly what the
// question said, so what makes a yes mean something is that the thing it authorizes was pinned
// down. That cannot be left to how the summary happens to be worded, or a model that writes a vague
// sentence collects a wide yes. So the structured fields are checked and the wording never is.

test("an ask for something the gate never stops is refused: a yes is not a thing to spend on nothing", async () => {
  const before = db.db.prepare("SELECT COUNT(*) n FROM confirmations").get().n;
  const r = await call("confirm_request", { action: "proceed", summary: "shall I go ahead?" });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, "not_a_gated_action");
  assert.match(r.error, /say yes without reading/, "the refusal says why asking anyway is not harmless");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM confirmations").get().n, before, "nothing was asked and nothing recorded");

  const real = await call("confirm_request", { action: "task_list", summary: "shall I check what's open?" });
  assert.equal(real.blocked, "not_a_gated_action", "a real tool that needs no yes is the same mistake");
});

test("an ask that reaches somebody has to say who, and one that commits has to say what", async () => {
  const noWho = await call("confirm_request", { action: "message_send", summary: "text them about friday" });
  assert.equal(noWho.ok, false);
  assert.equal(noWho.blocked, "ask_says_nothing");
  assert.ok(noWho.missing.some(m => /target/.test(m)));

  const noWhat = await call("confirm_request", { action: "browser_submit", summary: "book it" });
  assert.equal(noWhat.blocked, "ask_says_nothing", "a commit with nothing pinned to it is the same hole");

  const fine = await call("confirm_request", { action: "message_send", summary: "text Kofi about saturday", target: "+13475550222" });
  assert.equal(fine.ok, true);
});

test("an ask that says money is involved has to say how much", async () => {
  const vague = await call("confirm_request", {
    action: "browser_submit", summary: "book the table", stakes: "both", target: "Carbone, Fri, party of 4",
  });
  assert.equal(vague.ok, false);
  assert.equal(vague.blocked, "ask_says_nothing");
  assert.ok(vague.missing.some(m => /amount/.test(m)));
  assert.match(vague.error, /yes to an amount nobody ever stated/);

  const named = await call("confirm_request", {
    action: "browser_submit", summary: "book the table, $240", stakes: "both", target: "Carbone, Fri, party of 4, $240",
  });
  assert.equal(named.ok, true, "a figure anywhere in what they would be shown is what the check is for");

  const explicit = await call("confirm_request", {
    action: "browser_submit", summary: "book the table", stakes: "both", target: "Carbone, Sat, party of 4", amount: 240,
  });
  assert.equal(explicit.ok, true, "or stated outright as a number");
});

test("the amount is only demanded of the one tool that can actually spend", async () => {
  // Plenty of asks say "both" out of caution about something that spends nothing. Refusing those
  // would teach the model to stop being cautious, which is the opposite of what the field is for.
  const text = await call("confirm_request", { action: "message_send", summary: "text Kofi about saturday", stakes: "both", target: "+13475550222" });
  assert.equal(text.ok, true, "a text cannot spend money, whatever the ask called it");
});

test("how hard it is to take back comes from code, not from what the model claimed", async () => {
  const text = await call("confirm_request", { action: "message_send", summary: "text Kofi about saturday", target: "+13475550222" });
  assert.equal(text.undo, "no", "a text that has landed cannot be unsent");
  assert.match(text.say_this_too, /nothing takes this back/);

  const book = await call("confirm_request", { action: "browser_submit", summary: "book Carbone, $240", stakes: "both", target: "Carbone, Fri, $240" });
  assert.equal(book.undo, "hard");

  const connect = await call("confirm_request", { action: "account_connect", summary: "connect the google account", target: "me@example.com" });
  assert.equal(connect.undo, "easy");
  assert.match(connect.say_this_too, /do not make it sound heavier/);
});
