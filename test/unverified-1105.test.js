// "(unverified)" noise, 2026-11-05 (review finding 6): 618 tags in 93 messages in a week, on the
// person's own numbers — Agu's "$100" budget echoed back, Omari's own "$19.99", balances read off
// their screenshots — about 15 per market brief, plus footnotes glued under replies. The check only
// counted this turn's tool reads as sources (src/offers.js guardReply).
//
// Now: anything THEY said or sent, and what Reason remembers about them, is known and never hedged.
// A figure nothing backs sends the draft back once (Runtime._turn) to check it or say once, in its
// own words, that it hasn't; code never writes a tag or a footnote. An invented coupon is still
// stopped. Every case runs through the real Runtime on BOTH backends (the CLI path is the live one),
// with the model scripted: what it is handed on the rewrite is asserted, not assumed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-unverified-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const offers = await import("../src/offers.js");
const agent = await import("../src/agent.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");
const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");

const C = "dm:owner";
const DAY = 86_400_000;
const realCreate = agent.model.create;
after(() => { agent.model.create = realCreate; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM conversations; DELETE FROM outbox; DELETE FROM event_log; DELETE FROM media_items; DELETE FROM person_facts; DELETE FROM people;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
});

/** Any way of saying a figure is not confirmed; "(unverified)" is the tag that must never appear. */
const HEDGE = /haven'?t confirmed|not confirmed|unconfirmed|couldn'?t confirm|can'?t confirm|unverified/gi;
const hedges = (s) => (String(s).match(HEDGE) ?? []).length;

/**
 * One exchange through the real Runtime and the real backend, the model scripted. `drafts[i]` is
 * what the model writes on its i-th run; a function gets the run's prompt and may read sources the
 * way a tool would (offers.noteSource). Returns what was sent and every prompt the model was handed.
 */
async function exchange(backend, { text, kind = "user", drafts }) {
  const prompts = [];
  let i = 0;
  const next = (prompt) => {
    prompts.push(prompt);
    const d = drafts[Math.min(i++, drafts.length - 1)];
    return typeof d === "function" ? d(prompt) : d;
  };
  const turn = backend === "cli"
    ? (args) => runTurnViaCli({
      ...args,
      run: async (a) => ({ ok: true, envelope: { result: next(a.prompt) } }),
      startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
      images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }),
      capture: async () => null, recall: async () => [],
    })
    : (args) => {
      agent.model.create = async (req) => {
        const last = req.messages.at(-1);
        const said = typeof last.content === "string" ? last.content : last.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        return { id: "m", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: next(said) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      };
      return agent.runTurn({ ...args, images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }), capture: async () => ({ ok: false }) });
    };
  const sent = [];
  const rt = new Runtime({ screen: async () => ({ verdict: "clear" }), runTurn: turn, log: () => {} });
  rt.on("outbound", (m) => sent.push(m.text));
  if (kind === "event") await rt.event(C, text);
  else await rt.inbound(C, text);
  agent.model.create = realCreate;
  return { sent: sent.join("\n"), prompts, runs: i };
}

const theySaid = (content, ago) => db.writeEvent({ conversationId: C, role: "user", content, at: clock.now() - ago });

for (const backend of ["cli", "api"]) {
  test(`[${backend}] their own budget, said two days ago, is echoed plainly — no tag, no rewrite`, async () => {
    theySaid("need a bluetooth speaker, keep it under 100", 2 * DAY);
    const reply = "found two under your $100: the JBL Flip 6 at $89.99 and the Anker Motion 300 at $79.99. the jbl's louder.";
    const out = await exchange(backend, {
      text: "any luck with the speaker?",
      drafts: [() => { offers.noteSource(C, { results: [{ name: "JBL Flip 6", price: "$89.99" }, { name: "Anker Motion 300", price: "$79.99" }] }); return reply; }],
    });
    assert.equal(out.sent, reply);
    assert.equal(out.runs, 1, "no rewrite");
    assert.equal(hedges(out.sent), 0);
  });

  test(`[${backend}] a balance off the screenshot they sent is theirs — no tag, no rewrite`, async () => {
    db.db.prepare(`INSERT INTO media_items (conversation_id, channel, external_id, ordinal, kind, coverage, description, at)
      VALUES (?, 'test', 'img-1', 0, 'image', 'looked', ?, ?)`).run(C, "A Chase app screenshot. Words in it, verbatim:\nTotal Checking ...4417\nAvailable balance\n$2,341.17", clock.now() - 3 * 60_000);
    const reply = "you've got $2,341.17 available, so the $1,850 rent clears with about $491 to spare.";
    const out = await exchange(backend, { text: "can i cover rent on the 1st? rent is 1850", drafts: [reply] });
    assert.equal(out.sent, reply);
    assert.equal(out.runs, 1);
    assert.equal(hedges(out.sent), 0);
  });

  test(`[${backend}] a fact Reason remembers about them is known; a remembered price weeks old is said with its date`, async () => {
    db.remember(C, "Omari", "charges $19.99 a month for Reason");
    const fresh = await exchange(backend, { text: "what do i charge again", drafts: ["$19.99 a month."] });
    assert.equal(fresh.sent, "$19.99 a month.");
    assert.equal(fresh.runs, 1);
    // The same kind of fact, saved six weeks ago: one rewrite, asking for the date, never a tag.
    db.db.exec("DELETE FROM person_facts");
    db.remember(C, "Omari", "pays $1,850 rent");
    db.db.prepare("UPDATE person_facts SET created_at = ?").run(clock.now() - 40 * DAY);
    const asOf = new Date(clock.now() - 40 * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const old = await exchange(backend, { text: "how much is my rent", drafts: ["it's $1,850.", `it was $1,850 as of ${asOf}, when you told me.`] });
    assert.equal(old.runs, 2);
    assert.match(old.prompts[1], new RegExp(`as of ${asOf}`));
    assert.equal(old.sent, `it was $1,850 as of ${asOf}, when you told me.`);
  });

  test(`[${backend}] a price nothing backs goes back once, and goes out with ONE plain hedge in Reason's words`, async () => {
    const draft = "the ferry's $4.50 each way and the bus is $2.90, so the ferry's worth it for the view.";
    const fixed = "the ferry's $4.50 each way and the bus is $2.90 — haven't confirmed those fares yet, but the ferry's worth it for the view.";
    const out = await exchange(backend, { text: "ferry or bus to red hook?", drafts: [draft, fixed] });
    assert.equal(out.runs, 2, "one rewrite");
    assert.match(out.prompts[1], /Your draft reply was NOT sent/);
    assert.match(out.prompts[1], /\$4\.50, \$2\.90/);
    assert.match(out.prompts[1], /say ONCE, in your own words/);
    assert.equal(out.sent, fixed);
    assert.equal(hedges(out.sent), 1);
    assert.doesNotMatch(out.sent, /\(unverified\)/);
  });

  test(`[${backend}] the rewrite may check instead: a figure read on the rewrite goes out plain`, async () => {
    const out = await exchange(backend, {
      text: "ferry or bus to red hook?",
      drafts: ["the ferry's $4.50.", () => { offers.noteSource(C, { fare: "NYC Ferry one-way $4.00" }); return "the ferry's $4.00 one way (just checked)."; }],
    });
    assert.equal(out.runs, 2);
    assert.equal(out.sent, "the ferry's $4.00 one way (just checked).");
    assert.equal(hedges(out.sent), 0);
  });

  test(`[${backend}] an invented coupon is still stopped: sent back, and out of the text if the rewrite keeps it`, async () => {
    const out = await exchange(backend, {
      text: "is there a code for the cerave?",
      drafts: ["use code SAVE20 for 20% off at checkout. the 16 oz is the better buy."],
    });
    assert.equal(out.runs, 2);
    assert.match(out.prompts[1], /coupon, discount or sale/);
    assert.equal(out.sent, "the 16 oz is the better buy.");
    assert.doesNotMatch(out.sent, /SAVE20|20% off|coupon/i);
  });

  test(`[${backend}] a gold brief: read figures and their rounding go plain; one unchecked target means one rewrite and at most one hedge`, async () => {
    const quote = { symbol: "XAUUSD", last: 4012.35, previous_close: 3987.1, day_high: 4031.8, silver: { last: 48.213 } };
    const draft = "gold's at $4,012 this morning, up from $3,987 at yesterday's close. it touched $4,031 overnight and is sitting just over $4k. silver's $48.21. analysts are calling for $4,250 by year end.";
    const fixed = "gold's at $4,012 this morning, up from $3,987 at yesterday's close. it touched $4,031 overnight and is sitting just over $4k. silver's $48.21. some analysts are calling for $4,250 by year end — that one i haven't confirmed.";
    const out = await exchange(backend, {
      kind: "event", text: "morning brief: gold and silver for Omari",
      drafts: [() => { offers.noteSource(C, quote); return draft; }, fixed],
    });
    assert.equal(out.runs, 2);
    assert.match(out.prompts[1], /\$4,250/);
    assert.doesNotMatch(out.prompts[1].split("The draft:")[0], /\$4,012|\$3,987|\$4,031|\$4k|\$48\.21/, "read figures and their rounding are not sent back");
    assert.equal(out.sent, fixed);
    assert.ok(hedges(out.sent) <= 1, out.sent);
  });
}

test("message_send: an unchecked deal is refused every time; an unchecked figure once", async () => {
  const sent = [];
  const channels = { list: () => [{ name: "test" }], send: async (m) => { sent.push(m); return { ok: true, delivered: true }; } };
  const call = (input) => runTool("message_send", input, { conversationId: C, messages: [], channels });
  offers.beginTurn(C, "find me a deal on the cerave");
  const coupon = "there's a 20% off coupon at checkout";
  for (let n = 0; n < 2; n++) {
    const out = await call({ to: "owner", text: coupon });
    assert.equal(out.blocked, "unchecked_figures", JSON.stringify(out));
  }
  const fare = await call({ to: "owner", text: "the ferry's $4.50" });
  assert.equal(fare.blocked, "unchecked_figures");
  const again = await call({ to: "owner", text: "the ferry's $4.50, haven't confirmed it" });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(sent.map(m => m.text), ["the ferry's $4.50, haven't confirmed it"]);
});

test("a photo looked at this turn whose words are not in hand yet: its figures are not sent back", () => {
  offers.beginTurn(C, "what's my balance");
  assert.equal(offers.guardReply(C, "you've got $812.40", { unread: true, turnReply: true }).recompose, null);
  assert.equal(offers.takeRecompose(C), null);
  offers.beginTurn(C, "what's my balance");
  assert.equal(offers.guardReply(C, "you've got $812.40", { extraSources: ["Bank app. Words in it, verbatim:\nBalance $812.40"] }).recompose, null);
});
