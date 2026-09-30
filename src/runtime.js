// One Reason instance: per-conversation turn queue + the timer loop that turns due timers into event turns.
import { EventEmitter } from "node:events";
import { runTurn } from "./agent.js";
import { dueTimers, markTimerFired, getPlan } from "./db.js";
import { clock, stamp } from "./config.js";

export class Runtime extends EventEmitter {
  constructor({ log } = {}) {
    super();
    this.log = log ?? (() => {});
    this.queues = new Map();
    this.interval = null;
  }

  // Turns for one conversation run one at a time, in order. Different conversations run in parallel.
  enqueue(conversationId, fn) {
    const prev = this.queues.get(conversationId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(conversationId, next.catch(() => {}));
    return next;
  }

  /** Inbound text from the owner. Resolves to Reason's reply (or null for silence). */
  inbound(conversationId, text) {
    return this.enqueue(conversationId, async () => {
      const reply = await runTurn({ conversationId, text, events: this, log: this.log });
      if (reply) this.emit("outbound", { conversationId, text: reply });
      return reply;
    });
  }

  /** Fire every due timer as an event turn. Returns how many fired. */
  async tick() {
    const due = dueTimers();
    for (const t of due) {
      markTimerFired(t.id); // before the turn, so a crash mid-turn can't double-fire
      const plan = t.plan_id ? getPlan(t.conversation_id, t.plan_id) : null;
      const text = `timer #${t.id} fired (set for ${stamp(t.fire_at)}). your note: "${t.note}".` +
        (plan ? ` plan #${plan.id} is now: ${JSON.stringify({ title: plan.title, status: plan.status, when: plan.when, where: plan.where, who: plan.who, open_questions: plan.open_questions })}.` : "") +
        ` Decide whether to say something. If nothing is worth sending, reply NO_REPLY.`;
      await this.enqueue(t.conversation_id, async () => {
        const reply = await runTurn({ conversationId: t.conversation_id, text, kind: "event", events: this, log: this.log });
        if (reply) this.emit("outbound", { conversationId: t.conversation_id, text: reply, fromTimer: t.id });
      });
    }
    return due.length;
  }

  start(everyMs = 15_000) {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick().catch(e => this.emit("error", e)), everyMs);
    this.interval.unref?.();
  }
  stop() { clearInterval(this.interval); this.interval = null; }

  /** Drain all in-flight turns. */
  async idle() { await Promise.all([...this.queues.values()]); }

  static now() { return clock.now(); }
}
