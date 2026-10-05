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
import { runTurnViaCli as cliRunTurn } from "./backends/claude-cli.js";
import { mimeFor } from "./calls/recordings.js";
import * as accounts from "./accounts.js";
import * as outboxLib from "./outbox.js";
import * as replies from "./replies.js";
import { ledgerWrite } from "./trust.js";

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
  constructor({ log, runTurn, lookup = webLookup, checkWatch = realCheckWatch, channels = null, calls = null, deliver = null } = {}) {
    super();
    this.log = log ?? (() => {});
    // The API path is the default and is not conditional on anything. REASON_BACKEND=claude-cli
    // swaps in the subscription backend for the owner's own local testing; see the README.
    this.runTurn = runTurn ?? (process.env.REASON_BACKEND === "claude-cli" ? cliRunTurn : realRunTurn);
    this.lookup = lookup;
    this.checkWatch = checkWatch;
    // Handed to every turn, and from there into the tools, so `message_send` and `call_place`
    // reach the real adapters when serve.js wired them and nothing at all when it did not.
    this.turnExtras = { channels, calls };
    // How a message actually leaves. `deliver` is for a caller that can report back whether an
    // attachment really went — serve.js passes one; without it the "outbound" event is emitted and
    // the send is taken at face value, which is what the console and the tests want.
    this.deliver = deliver;
    this.queues = new Map();
    this.interval = null;
  }

  /**
   * Put one message out, with any call recording that is waiting on this conversation.
   *
   * This is where "the owner gets the summary AND the audio in one message" is decided, and it is
   * decided here rather than in the model's hands on purpose. The model writes what happened on
   * the phone; code looks up whether there is a file for a call on this conversation that has not
   * been sent, attaches it to that same message, and marks it sent only once it has gone. So the
   * model cannot forget the audio, cannot send it twice, and cannot attach audio that does not
   * exist — the queue is read off the calls table, not from anything it wrote.
   *
   * The query is scoped to the conversation, which is what keeps a recording in the thread that
   * placed the call: nobody else can place one, and nobody else's message can pick one up.
   */
  async _emit({ conversationId, text, meta = {} }) {
    const waiting = db.callsWithUnsentRecording(conversationId)[0] ?? null;
    const media = waiting
      ? {
        call_id: waiting.id,
        file: waiting.recording_file,
        mimeType: mimeFor(waiting.recording_format),
        filename: `call-${waiting.id}-${waiting.to_number.replace(/\D/g, "")}.${waiting.recording_format}`,
        seconds: waiting.recording_seconds ?? null,
        bytes: waiting.recording_bytes ?? null,
      }
      : null;

    let result = { ok: true, mediaOk: !!media };
    if (this.deliver) {
      try {
        result = (await this.deliver({ conversationId, text, media, ...meta })) ?? result;
      } catch (e) {
        result = { ok: false, mediaOk: false, error: (e?.message ?? String(e)).split("\n")[0] };
      }
    } else {
      this.emit("outbound", { conversationId, text, media, ...meta });
    }

    if (media) {
      if (result.mediaOk === false) {
        // The audio did not go. It stays queued for the next message rather than being quietly
        // marked delivered, and it is logged, because "I sent you the recording" has to be true.
        this.log({ call_audio_held: media.call_id, why: result.error ?? "the channel could not send it" });
      } else {
        db.markRecordingSent(media.call_id);
        ledgerWrite({
          conversationId, action: "call_recording",
          input: { call_id: media.call_id },
          out: { ok: true, file: media.file, bytes: media.bytes, seconds: media.seconds, format: waiting.recording_format },
          target: `call:${waiting.to_number}`,
        });
      }
    }
    return result;
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
  _turn({ conversationId, text, kind = "user", meta = {}, shouldSend = null, attachments = [] }) {
    return this.enqueue(conversationId, async () => {
      // A pointer left by a turn that never used it must not pin THIS turn's reply somewhere.
      db.setReplyTarget(conversationId, null);
      // Same for a "what's new" claim: a turn that said it would mention something and then sent
      // nothing leaves a claim behind, and this turn's reply is not the one it was made about.
      db.dropWhatsNewClaim(conversationId);
      // `answering` is the router's note of which text this turn is for. It is used here and goes
      // no further: nothing downstream needs it.
      const { answering = null, ...rest } = meta;
      meta = rest;
      const mark = db.outboxMark();
      const reply = await this.runTurn({ conversationId, text, kind, attachments, events: this, log: this.log, ...this.turnExtras });
      // The message the turn asked for its reply to be pinned under (the reply_to tool), if it is
      // still unused. Taken whether or not anything is sent, so it never outlives the turn.
      // Failing that, the text it is answering, when that is no longer the last thing in the
      // thread — read now, at the moment of sending, because they may have texted again meanwhile.
      const replyTo = db.takeReplyTarget(conversationId) ?? replies.answerTarget(conversationId, answering, mark);
      if (reply && (!shouldSend || shouldSend(reply))) {
        const out = await this._emit({ conversationId, text: reply, meta: replyTo ? { ...meta, replyTo } : meta });
        // Anything new the model said it mentioned is written down HERE, after the send, and only
        // if the send worked. A queued message counts, because that is what `ok` means to
        // src/deliver.js — it is either going to arrive or be reported as lost, and the cost of
        // treating it as sent is silence rather than telling somebody the same thing twice.
        const told = out?.ok === false
          ? db.dropWhatsNewClaim(conversationId)
          : db.markWhatsNewTold(conversationId);
        if (told) this.log({ whats_new: told, conversation: conversationId, heard: out?.ok !== false });
      } else {
        if (reply) this.log({ held_back: meta, said: reply.slice(0, 120) });
        // Nothing left, so nothing was heard: it is offered again on a later reply.
        db.dropWhatsNewClaim(conversationId);
      }
      return reply;
    });
  }

  /**
   * Inbound text from a person, with anything they attached to it. Resolves to Reason's reply (or
   * null for silence).
   *
   * `meta.attachments` is lifted out and handed to the turn rather than only being carried for the
   * reply, because a picture is part of what they said: the model has to see it to answer.
   */
  inbound(conversationId, text, meta = {}) {
    return this._turn({ conversationId, text, kind: "user", meta, attachments: meta.attachments ?? [] });
  }

  /** An event turn: Reason is told something happened and decides whether to say anything. */
  event(conversationId, text, meta = {}) {
    return this._turn({ conversationId, text, kind: "event", meta });
  }

  /**
   * Is Reason allowed to interrupt this person again today?
   *
   * Separate from their own turn cap on purpose: being chatty is their business, Reason starting
   * conversations on the operator's bill is Reason's. Checked before the model call, so a capped
   * person costs nothing.
   */
  mayInterrupt(conversationId) {
    const cap = accounts.withinCap(conversationId, "proactive");
    if (!cap.ok) this.log({ proactive_capped: conversationId, used: cap.used, limit: cap.limit });
    return cap.ok;
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
      if (!this.mayInterrupt(t.conversation_id)) { db.markTimerFired(t.id); continue; }
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
      if (!this.mayInterrupt(plan.conversation_id)) { out.skipped.push({ plan_id: plan.id, reason: "daily_proactive_cap" }); continue; }
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
      if (reply) { db.markNudgeSent(nudgeId); accounts.countUse(plan.conversation_id, "proactive"); out.sent++; }
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

  /**
   * Answers the owner tapped on one of their own pages, delivered as event turns.
   *
   * A page is not a conversation, so a pick has to come back into one. It arrives like a timer
   * does: code tells Reason what happened and Reason decides whether to say anything. Delivered
   * exactly once — the row is claimed before the turn runs, so two overlapping sweeps cannot both
   * take it and a crash mid-turn does not re-fire it. A pick that happened while the process was
   * down is still waiting in the table when it comes back up.
   */
  async pageAnswers() {
    const out = { picked: 0, delivered: 0 };
    for (const ch of db.undeliveredPageChoices()) {
      out.picked++;
      if (!db.markPageChoiceDelivered(ch.id)) continue; // somebody else got there first
      out.delivered++;
      const page = db.getPage(ch.page_id);
      const text = `${config.ownerName} tapped an answer on the page you made${page ? ` ("${page.title}")` : ""}.`
        + ` the question was: "${ch.question || ch.block_key}". they picked: "${ch.picked}".`
        + ` That is their real answer — they chose it themselves, so you do not need to confirm it back with them.`
        + ` Act on it: take the next step it implies, and say one short line about what you are doing.`
        + ` If it changes a plan, change the plan. If there is genuinely nothing to do or say, reply NO_REPLY.`;
      await this.event(ch.conversation_id, text, { fromPageChoice: ch.id, pageId: ch.page_id });
    }
    return out;
  }

  /**
   * Work the outbox: retry what is due, resolve what was interrupted, and tell the owner about
   * anything that is never going to arrive.
   *
   * The owner half is the part that is easy to leave out. A failed message to the owner themselves
   * is told to them at the top of their next turn, where it belongs — but a failed message to
   * somebody ELSE has no turn to open, because that person is not who Reason reports to. Reason
   * said it would text Kofi, so the owner has to hear that Kofi never got it, and they hear it in
   * words code wrote rather than the model's, because what just broke is the model's plumbing.
   *
   * No model call anywhere in here. That is deliberate: a delivery failure must still be reported
   * when there is no credit, no key and no working backend.
   */
  async outbox({ router = this.turnExtras.channels } = {}) {
    const out = { tried: 0, sent: 0, requeued: 0, failed: 0, resolved: 0, owner_told: 0 };
    if (!router) return out;

    Object.assign(out, await outboxLib.pass({ router, log: this.log }));

    for (const row of db.ownerUntoldFailures()) {
      // Claimed before the send, so a crash here means the owner is not told twice. Being told once
      // and losing it is the safe direction; being told four times is not.
      //
      // And the notice itself is a durable message, which matters when the line to the owner is the
      // thing that is down: it retries like anything else, and if it never arrives it lands at the
      // top of the owner's next turn as a lost reply. There is no step here that can drop it.
      if (!db.markOwnerTold(row.id)) continue;
      const line = outboxLib.ownerFailureLine(row);
      const r = await router.tellMaster(line, row.channel);
      if (r?.ok) out.owner_told++;
      else this.log({ outbox: row.id, could_not_tell_owner: r?.error ?? "no reason given" });
    }
    return out;
  }

  /**
   * Messages that are held and due, answered.
   *
   * The request that took a message normally waits out its own quiet window and runs the turn
   * itself. This is the other path: a message held when the last process stopped has nobody
   * waiting on it, and without this it would sit in the table while somebody wondered why Reason
   * went quiet. No model call unless there is really something held.
   */
  async held({ router = this.turnExtras.channels } = {}) {
    if (!router || typeof router.drainDue !== "function") return { conversations: 0, turns: 0 };
    return await router.drainDue();
  }

  /** Everything proactive, in one pass: delivery first, then timers, tasks, pages, watches, threads. */
  async sweep() {
    // Before anything that might say something: finish saying the things already owed.
    const outbox = await this.outbox();
    // Then anybody who is actually waiting on an answer right now.
    const held = await this.held();
    const timers = await this.tick();
    const tasks = await this.runTasks();
    const pages = await this.pageAnswers();
    const watches = await this.checkWatches();
    const follow = await this.followUp();
    return { outbox, held, timers, tasks, pages, watches, follow };
  }

  start(everyMs = 15_000) {
    if (this.interval) return;
    // Anything that was mid-step when the last process stopped. A task with no wake time is a
    // task nobody will ever come back to, so the first thing a new process does is give them one.
    const rescued = db.rescueOrphanedTasks(clock.now() + 1000);
    if (rescued.length) this.log({ rescued_tasks: rescued.map(t => t.id), note: "the last stop was not clean" });
    // A message that was mid-send when the last process stopped. NOT resent here: nobody knows yet
    // whether it arrived, and the first sweep asks the channel before anything goes out again.
    outboxLib.recoverStranded({ log: this.log });
    this.interval = setInterval(() => this.sweep().catch(e => this.emit("error", e)), everyMs);
    this.interval.unref?.();
  }
  stop() { clearInterval(this.interval); this.interval = null; }

  /**
   * Stop cleanly: no new sweeps, finish what is in flight, then make sure nothing is stranded.
   *
   * The order matters. Stopping the interval first means no new work starts; draining second lets
   * the turn that is running finish; rescuing third catches anything that did not, so a task is
   * never left open with no wake time. Chromium is closed last and its profiles stay on disk, so a
   * login survives a restart.
   */
  async shutdown() {
    this.stop();
    await this.idle().catch(() => {});
    const rescued = db.rescueOrphanedTasks(clock.now() + 1000);
    if (rescued.length) this.log({ rescued_on_shutdown: rescued.map(t => t.id) });
    await closeAllBrowsers();
    return { rescued: rescued.length };
  }

  /** Drain all in-flight turns. */
  async idle() { await Promise.all([...this.queues.values()]); }

  static now() { return clock.now(); }
}
