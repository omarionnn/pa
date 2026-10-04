// One Reason instance: per-conversation turn queue, plus the three things that make it proactive
// without making it a nuisance — timers that fire, watches that re-check, and dropped threads
// it raises again. Each pass is separately callable so its logic can be tested without a model.
import { EventEmitter } from "node:events";
import { runTurn as realRunTurn } from "./agent.js";
import * as db from "./db.js";
import { clock, config, stamp } from "./config.js";
import { closeAllBrowsers } from "./browser.js";
import { webLookup } from "./weblookup.js";
import { checkWatch as realCheckWatch } from "./watch.js";

const MIN = 60_000;

/** What a task wake looks like to the model: the job, where it got to, and what it may claim. */
function taskEventText(t) {
  const log = t.log.map(l => `  - ${stamp(l.at)} [${l.kind}] ${l.note}`).join("\n");
  return `you are working on task #${t.id}: "${t.title}".` +
    ` the goal, in your own earlier words: ${t.goal}.` +
    ` it is ${t.state}, started ${stamp(t.created_at)}, and you have come back to it ${t.wakes} time(s) before.` +
    `\nthe progress log so far:\n${log || "  (nothing yet)"}` +
    `\nTake the next step on it now with your tools. Then: task_update with what actually happened` +
    ` and when to come back, or task_finish when it is done or genuinely dead.` +
    ` Say something to ${config.ownerName} ONLY if there is real news — something finished, something failed,` +
    ` or you need an answer only they can give. A step that moved nothing is not news: reply NO_REPLY.` +
    ` Nothing you write here reaches them unless the task itself actually changed.`;
}

export class Runtime extends EventEmitter {
  /**
   * `runTurn`, `lookup` and `checkWatch` are injectable so the proactive passes can be driven
   * deterministically in tests: the schedule, the rate limit and the single-fire rules are code's
   * to guarantee, and none of them should need a model call to prove.
   */
  constructor({ log, runTurn = realRunTurn, lookup = webLookup, checkWatch = realCheckWatch, channels = null, calls = null } = {}) {
    super();
    this.log = log ?? (() => {});
    this.runTurn = runTurn;
    this.lookup = lookup;
    this.checkWatch = checkWatch;
    // Handed to every turn, and from there into the tools, so `message_send` and `call_place`
    // reach the real adapters when serve.js wired them and nothing at all when it did not.
    this.turnExtras = { channels, calls };
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

  /**
   * One turn, queued behind this conversation's others. `shouldSend` is checked after the turn
   * and before anything leaves, so code rather than the model's own judgement decides whether a
   * reply earns an interruption. Returns what Reason said, even when it was held back.
   */
  _turn({ conversationId, text, kind = "user", meta = {}, shouldSend = null }) {
    return this.enqueue(conversationId, async () => {
      const reply = await this.runTurn({ conversationId, text, kind, events: this, log: this.log, ...this.turnExtras });
      if (reply && (!shouldSend || shouldSend(reply))) {
        this.emit("outbound", { conversationId, text: reply, ...meta });
      } else if (reply) {
        this.log({ held_back: meta, said: reply.slice(0, 120) });
      }
      return reply;
    });
  }

  /** Inbound text from a person. Resolves to Reason's reply (or null for silence). */
  inbound(conversationId, text, meta = {}) {
    return this._turn({ conversationId, text, kind: "user", meta });
  }

  /** An event turn: Reason is told something happened and decides whether to say anything. */
  event(conversationId, text, meta = {}) {
    return this._turn({ conversationId, text, kind: "event", meta });
  }

  /** A line Reason sends because code decided to, not because the model wrote it. */
  say(conversationId, text, meta = {}) {
    this.emit("outbound", { conversationId, text, ...meta });
    return text;
  }

  /** Fire every due timer as an event turn. Returns how many fired. */
  async tick() {
    const due = db.dueTimers();
    for (const t of due) {
      db.markTimerFired(t.id); // before the turn, so a crash mid-turn can't double-fire
      const plan = t.plan_id ? db.getPlan(t.conversation_id, t.plan_id) : null;
      const text = `timer #${t.id} fired (set for ${stamp(t.fire_at)}). your note: "${t.note}".` +
        (plan ? ` plan #${plan.id} is now: ${JSON.stringify({ title: plan.title, status: plan.status, when: plan.when, where: plan.where, who: plan.who, open_questions: plan.open_questions })}.` : "") +
        ` Decide whether to say something. If nothing is worth sending, reply NO_REPLY.`;
      await this.event(t.conversation_id, text, { fromTimer: t.id });
    }
    return due.length;
  }

  /**
   * Re-check every watch that is due. A watch fires once: the moment its condition is met it is
   * marked met and never checked again. Anything that cannot be read is simply not met.
   * Returns a small record of what happened, which is what the tests assert on.
   */
  async checkWatches() {
    const out = { checked: 0, met: 0, gave_up: 0 };
    for (const w of db.dueWatches()) {
      out.checked++;
      let page;
      try {
        page = await this.lookup(w.url, { maxChars: 6000 });
      } catch (e) {
        page = { ok: false, error: e?.message ?? String(e) };
      }
      const verdict = page?.ok
        ? await this.checkWatch({ lookingFor: w.looking_for, text: page.text, previousText: w.last_seen })
        : { met: false, why: `the page could not be read: ${page?.error ?? "unknown error"}` };

      db.recordWatchCheck(w.id, { seen: page?.ok ? String(page.text ?? "").slice(0, 4000) : w.last_seen });
      this.log({ watch: w.id, url: w.url, met: !!verdict.met, why: verdict.why });

      if (verdict.met) {
        db.markWatchMet(w.id, verdict.why);
        out.met++;
        const text = `watch #${w.id} on ${w.url} says the thing happened. you were watching for: "${w.looking_for}".` +
          (w.note ? ` your note: "${w.note}".` : "") +
          ` what decided it: "${verdict.why}". The page said: ${String(page.text ?? "").slice(0, 1500)}` +
          ` Tell them what the page actually says. Do not add anything it does not say. If it turns out not to be what they wanted, say that instead.`;
        await this.event(w.conversation_id, text, { fromWatch: w.id });
        continue;
      }
      // Not met. Give up only after a hard ceiling, so a watch cannot run forever unnoticed.
      const checks = (db.getWatch(w.conversation_id, w.id)?.checks ?? 0);
      if (checks >= config.watchMaxChecks) {
        db.markWatchGaveUp(w.id);
        out.gave_up++;
        await this.event(w.conversation_id,
          `watch #${w.id} on ${w.url} has been checked ${checks} times without "${w.looking_for}" ever happening, so it has stopped.` +
          ` Tell them plainly that you stopped watching and offer to start again. Do not pretend it is still running.`,
          { fromWatch: w.id });
      }
    }
    return out;
  }

  /**
   * Raise threads that got dropped: something still open, nothing said for hours. The rate limit
   * is checked before the turn, so a capped conversation never costs a model call, and the nudge
   * is marked sent only when a message actually goes out — silence does not spend the daily cap.
   */
  async followUp({ idleMs = config.followUpIdleMin * MIN } = {}) {
    const out = { candidates: 0, skipped: [], asked: 0, sent: 0 };
    for (const plan of db.droppedPlans({ idleMs })) {
      out.candidates++;
      const gate = db.nudgeAllowed({
        conversationId: plan.conversation_id, planId: plan.id,
        gapMs: config.nudgeGapMin * MIN, maxPerDay: config.nudgeMaxPerDay,
      });
      if (!gate.ok) {
        out.skipped.push({ plan_id: plan.id, reason: gate.reason });
        this.log({ followUp: plan.id, skipped: gate.reason });
        continue;
      }
      // Written before the turn: a crash mid-nudge still counts against the gap, which is the
      // safe direction to fail in. Reason going quiet is better than Reason repeating itself.
      const nudgeId = db.considerNudge({ conversationId: plan.conversation_id, planId: plan.id, kind: "dropped_thread" });
      out.asked++;
      const hours = Math.round(plan.idle_ms / 3_600_000);
      const text = `nothing has happened on plan #${plan.id} for about ${hours} hour(s) and it still has open questions.` +
        ` the plan is: ${JSON.stringify({ title: plan.title, kind: plan.kind, when: plan.when, where: plan.where, who: plan.who, open_questions: plan.open_questions })}.` +
        ` Decide whether it is worth one short message picking the thread back up — ask about ONE open thing, in your own voice, pointing at the real plan.` +
        ` If it is stale, trivial, or they have clearly moved on, reply NO_REPLY and say nothing.`;
      const reply = await this.event(plan.conversation_id, text, { fromFollowUp: plan.id });
      if (reply) { db.markNudgeSent(nudgeId); out.sent++; }
    }
    return out;
  }

  /**
   * Work every task whose wake has come. Three things are code's job here, not the model's:
   *
   *  - **Fires once.** The wake is cleared before the turn, so a second pass in the same second
   *    finds nothing due and a crash mid-step leaves the task asleep rather than spinning.
   *  - **Reports only on a change.** The task's signature is taken before the turn and again
   *    after. If the state, the outcome and the progress log are all exactly as they were, the
   *    task did nothing worth an interruption and whatever the model wrote is not sent.
   *  - **Gives up out loud.** A step that throws is retried a bounded number of times, backing
   *    off each time. Past the budget — or past the wake ceiling — the task is marked failed and
   *    the owner is told in plain words, written by code, because the model is what just broke.
   */
  async runTasks() {
    const out = { woke: 0, reported: 0, held: 0, retried: 0, failed: 0 };
    for (const t of db.dueTasks()) {
      out.woke++;
      const before = db.taskSignature(t.id);
      db.markTaskWoken(t.id);

      if (t.wakes + 1 > config.taskMaxWakes) {
        db.finishTask(t.conversation_id, t.id, {
          state: "failed",
          outcome: `gave up after ${t.wakes + 1} attempts at it without finishing`,
        });
        out.failed++;
        this.say(t.conversation_id,
          `ok i have to be honest — i've come back to "${t.title}" ${t.wakes + 1} times and gotten nowhere, so i've stopped. want me to try a different angle?`,
          { fromTask: t.id });
        continue;
      }

      let reply;
      try {
        reply = await this._turn({
          conversationId: t.conversation_id,
          text: taskEventText(t),
          kind: "event",
          meta: { fromTask: t.id },
          shouldSend: () => db.taskSignature(t.id) !== before,
        });
      } catch (e) {
        const why = (e?.message ?? String(e)).split("\n")[0];
        db.logTask(t.id, "error", why);
        const n = db.bumpTaskAttempt(t.id, { wakeAt: clock.now() + (t.attempts + 1) * config.taskRetryBackoffMin * MIN });
        this.log({ task: t.id, crashed: why, attempt: n.attempts, of: n.max_attempts });
        if (n.attempts >= n.max_attempts) {
          db.finishTask(t.conversation_id, t.id, { state: "failed", outcome: `kept failing: ${why}` });
          out.failed++;
          this.say(t.conversation_id,
            `heads up — "${t.title}" keeps breaking on me (${why}). i tried ${n.attempts} times and i'm stopping there rather than pretending. want me to take another run at it?`,
            { fromTask: t.id });
        } else {
          out.retried++;
        }
        continue;
      }

      const changed = db.taskSignature(t.id) !== before;
      if (reply && changed) out.reported++;
      else if (reply) out.held++;

      // Still open and nobody said when to come back: schedule it rather than lose it.
      const now = db.getTaskAnywhere(t.id);
      if (now?.open && now.next_wake_at === null) {
        db.scheduleTask(t.id, clock.now() + config.taskDefaultWakeMin * MIN);
      }
    }
    return out;
  }

  /** Everything proactive, in one pass: timers, then tasks, then watches, then dropped threads. */
  async sweep() {
    const timers = await this.tick();
    const tasks = await this.runTasks();
    const watches = await this.checkWatches();
    const follow = await this.followUp();
    return { timers, tasks, watches, follow };
  }

  start(everyMs = 15_000) {
    if (this.interval) return;
    this.interval = setInterval(() => this.sweep().catch(e => this.emit("error", e)), everyMs);
    this.interval.unref?.();
  }
  stop() { clearInterval(this.interval); this.interval = null; }

  /** Stop ticking and shut every Chromium down. Profiles stay on disk. */
  async shutdown() { this.stop(); await closeAllBrowsers(); }

  /** Drain all in-flight turns. */
  async idle() { await Promise.all([...this.queues.values()]); }

  static now() { return clock.now(); }
}
