// One of every Ongoing state, written through Reason's own functions (the rows the agent's tools
// write), for test/web-ongoing.test.js and the preview renders. The caller has set the env and owns the DB.
import * as db from "../src/db.js";
import * as series from "../src/series.js";
import { clock } from "../src/config.js";

const H = 60 * 60_000;

/** Every group and state on one conversation. Returns the ids by state. */
export function seedOngoing(C, { now = clock.now(), withApproval = true } = {}) {
  const ids = {};
  if (withApproval) {
    const c = db.askConfirmation({ conversationId: C, action: "purchase_confirm", summary: "Buy the CeraVe PM lotion from Target", stakes: "money", target: "cerave [hash-1] in buy-1", askedAfterMsgs: 0, amount: 16.78 });
    db.recordAgentcardPurchase({ conversationId: C, buyConversationId: "buy-1", status: "cart_shown", cartHash: "hash-1", amountCents: 1678, merchant: "Target", what: "CeraVe PM Moisturizing Face Lotion 3 fl oz" });
    db.db.prepare("UPDATE agentcard_purchases SET cart_json = ?, address_json = ? WHERE buy_conversation_id = 'buy-1'")
      .run(JSON.stringify({ items: [{ name: "CeraVe PM Moisturizing Face Lotion 3 fl oz", qty: 1 }], ceiling_cents: 2614 }), JSON.stringify({ name: "Omari", street: "1 Main St", city: "Bronx", state: "NY", zip: "10467" }));
    ids.approval = c.id;
  }
  // Working, with real steps on its sheet: one done, one in hand with live words, one not started.
  const w = db.createTask(C, { title: "check nov 14-16 at all three", goal: "Omari knows which of the three has Nov 14-16 open.", maxAttempts: 3, label: "Nov 14–16 at all three", wakeAt: now + 2 * H });
  db.updateTask(C, w.id, { sheet: { steps: [{ text: "Hudson inn: open, $540", state: "done" }, { text: "Waramaug cabin", state: "doing", live: "on the phone now" }, { text: "Woodstock hotel", state: "todo" }] } });
  ids.working = w.id;
  // Waiting on somebody else.
  const wt = db.createTask(C, { title: "refund for the boots", goal: "the refund lands", maxAttempts: 3, label: "Refund for the boots", wakeAt: now + 30 * H });
  db.updateTask(C, wt.id, { state: "waiting_on_other", sheet: { waiting: [{ on: "the store", for: "a reply about the refund", next_check: new Date(now + 48 * H).toISOString() }] } });
  ids.waiting = wt.id;
  // Standing: every Monday 9am.
  const s = series.start({ conversationId: C, what: "call the gym about the 6 PM class, then text Omari what they say", repeat: { kind: "weekly", weekdays: ["monday"], hour: 9 }, label: "Check in on the gym class" });
  ids.series = s.series.series_id;
  // A one-off reminder.
  const t = db.createTimer(C, { fireAt: now + 50 * H, note: "Omari asked to be reminded to call the landlord", label: "Call the landlord" });
  ids.timer = t.id;
  // Back to you: done with its result card, and failed with why and what next.
  const d = db.createTask(C, { title: "table for four saturday", goal: "a table", maxAttempts: 3, label: "Table for four, Saturday" });
  db.finishTask(C, d.id, { state: "done", outcome: "Booked Via Carota, Sat 7:30pm, 4 people", result: { headline: "Via Carota", facts: ["SAT · 7:30 PM", "4 PEOPLE · UNDER OMARI"], note: "They'll hold the table 15 minutes." } });
  ids.ready = d.id;
  const f = db.createTask(C, { title: "two tickets friday", goal: "two tickets", maxAttempts: 3, label: "Two tickets for Friday" });
  db.finishTask(C, f.id, { state: "failed", outcome: "sold out", result: { why: "sold out before i got in. sorry.", next: "I'm watching resale until Thursday night. If a pair turns up under your limit, I'll text you before buying." } });
  ids.failed = f.id;
  return ids;
}
