// One Reason instance: per-conversation turn queue, plus the three things that make it proactive
// without making it a nuisance — timers that fire, watches that re-check, and dropped threads
// it raises again. Each pass is separately callable so its logic can be tested without a model.
import { EventEmitter } from "node:events";
import { runTurn as realRunTurn } from "./agent.js";
import * as db from "./db.js";
import { clock, config, stamp } from "./config.js";
import { closeAllBrowsers } from "./browser.js";
import { webLookup } from "./weblookup.js";
import { parallelClient } from "./parallel.js";
import { checkWatch as realCheckWatch } from "./watch.js";
import { runTurnViaCli as cliRunTurn } from "./backends/claude-cli.js";
import { mimeFor } from "./calls/recordings.js";
import { findConverter, runConverter, VOICE_AFCONVERT_ARGS, VOICE_FFMPEG_ARGS, effectAllowed } from "./expressive.js";
import * as accounts from "./accounts.js";
import * as outboxLib from "./outbox.js";
import * as brief from "./brief.js";
import * as undoLib from "./undo.js";
import { runReleasedAction, settleLostCalls } from "./tools.js";
import * as replies from "./replies.js";
import { ledgerWrite } from "./trust.js";
import { sendTapback } from "./tapbacks.js";
import { sweepRetention } from "./privacy.js";
import * as remote from "./remote.js";
import * as notice from "./notice.js";
import * as rhythmsLib from "./rhythms.js";
import * as series from "./series.js";
import * as commitment from "./commitment.js";
import * as goals from "./goals.js";
import { ownerUrl } from "./pages/access.js";
import { sheetView, tasteView, whyView } from "./sheet.js";
import * as harm from "./harm.js";
import { isPaused } from "./pause.js";
import * as landed from "./landed.js";
import * as subs from "./subscriptions.js";
import { readOutage, OutageError, MAX_REHOLDS } from "./down.js";

const MIN = 60_000;

/** What a task wake looks like to the model: the job, where it got to, and what it may claim. */
function taskEventText(t) {
  const log = t.log.map(l => `  - ${stamp(l.at)} [${l.kind}] ${l.note}`).join("\n");
  // The whole sheet, every single wake. This is what makes "including fees" hold for the rest of
  // the job rather than for the next reply: the correction is a row, and the row is in front of the
  // model again four hours later when its own context no longer has the message in it.
  // Their taste travels with the sheet: what they have turned down before, on this job or on any
  // other, so the next pick is made knowing it rather than re-learning it. So does WHY they are
  // doing it, which is the part that decides the order the options come back in.
  const sheet = sheetView(t.sheet, {
    stamp,
    tastes: tasteView(db.listPreferences(t.conversation_id, { limit: 12 }), { stamp }),
    whys: whyView(db.listWhys(t.conversation_id, { limit: 12 }), { stamp }),
  });
  return `you are working on task #${t.id}: "${t.title}".` +
    ` the goal, in your own earlier words: ${t.goal}.` +
    ` it is ${t.state}, started ${stamp(t.created_at)}, and you have come back to it ${t.wakes} time(s) before.` +
    `\nthe sheet — everything this job is carrying, which is as true now as when it was written:\n${JSON.stringify(sheet)}` +
    `\nWork within it. Anything in constraints with from 'they said it' is theirs and not yours to change:` +
    ` if it genuinely cannot be met, that is a waiting_on_you question with the tradeoff in it, not a quiet substitution.` +
    ` Never put a rejected option in front of them again.` +
    `\nthe progress log so far:\n${log || "  (nothing yet)"}` +
    landed.landedNote(t, { since: t.last_woken_at ?? t.created_at }) +
    `\nTake the next step on it now with your tools. Then: task_update with what actually happened` +
    ` and when to come back, or task_finish when it is done or genuinely dead.` +
    ` Say something to ${config.ownerName} ONLY if there is real news — something finished, something failed,` +
    ` or you need an answer only they can give. A step that moved nothing is not news: reply NO_REPLY.` +
    ` Nothing you write here reaches them unless the task itself actually changed.` +
    `\nBefore you speak, read your own previous messages in the conversation above.` +
    ` If you already delivered this result — the same pick, price, recommendation, or answer — say NO_REPLY.` +
    ` Never re-send information that is already visible in the thread, even summarized.` +
    `\nIf you do speak, your message may land well after unrelated conversation.` +
    ` Open with a few words of orientation ("back on the airbnb thing:") so it reads right out of order, and if what they have said` +
    ` since makes this stale or unwanted, say that instead of delivering it as though nothing changed.`;
}

/**
 * A task wake inside their night waits for their morning, unless they are plainly up — a text from
 * them, or the job itself started, in the last two hours: a thing they asked for at 11pm is a thing
 * they are waiting on at 11pm. What this holds back is the job that has outlived the conversation —
 * a wait on somebody else, a search that comes round daily — whose news keeps until a time when
 * hearing it is welcome. The step keeps with it. Null when the wake may run now.
 */
function sleepsUntil(t, now = clock.now()) {
  if (!notice.inTheirNight(t.conversation_id, now)) return null;
  if (now - t.created_at < 2 * 60 * MIN) return null;
  const theirs = db.recentMessages(t.conversation_id, { limit: 20 }).find(m => m.from === "them");
  if (theirs && now - theirs.at < 2 * 60 * MIN) return null;
  const s = notice.settingsFor(t.conversation_id, { now });
  return notice.quietEndsAt(now, s.timeZone, { start: s.quietStart, end: s.quietEnd });
}

/**
 * The one line a person gets when their turn died — the model call failed, the CLI hit its ceiling,
 * a tool threw past every catch. Code's words, because the model is what just broke, and honest
 * about the one thing code can check: whether anything left this turn before it did.
 */
export function stallLine({ sentAny }) {
  return sentAny
    ? "ugh — that one broke on my end partway through. what i already sent you stands; the rest didn't finish. want me to take another run at it?"
    : "ugh — that one broke on my end partway through, and nothing went out from it. say it again and i'll pick it back up?";
}

/**
 * The outbox key for the message one timer's firing produces. One key per timer, because a timer
 * fires once: however many times its turn is run, they are all the same reminder.
 */
const timerKey = (id) => `timer:${id}:fire`;

/** How long after the nth failed try before the next: none, then a step, then two. */
const timerRetryGap = (n) => Math.max(0, n - 1) * config.timerRetryBackoffMs;

/**
 * What they are told when a reminder could not be got out at all.
 *
 * Code's words, for the same reason the task-failure line is: the model is the thing that broke.
 * The note is quoted because it is the only record of what the reminder was FOR, and it is called
 * what it is — a note Reason left itself — because that is why it does not read like a text.
 */
function missedTimerLine(t) {
  return `heads up — i missed a reminder i owed u. it was set for ${stamp(t.fire_at)}, and the note i left myself for it was: "${t.note}".`
    + ` something on my end broke each of the ${t.attempts} times i tried to send it, so i've stopped trying and i'm telling u instead of going quiet.`;
}

export class Runtime extends EventEmitter {
  /**
   * `runTurn`, `lookup` and `checkWatch` are injectable so the proactive passes can be driven
   * deterministically in tests: the schedule, the rate limit and the single-fire rules are code's
   * to guarantee, and none of them should need a model call to prove.
   */
  constructor({ log, runTurn, lookup = webLookup, checkWatch = realCheckWatch, parallel = null, channels = null, calls = null, deliver = null, screen = null, screenReply = null } = {}) {
    super();
    this.log = log ?? (() => {});
    // Parallel's monitors, for a watch on the world rather than a page (src/parallel.js). Injectable
    // so the tests can say what the monitor found; production reads the key off config.
    this.parallel = parallel ?? parallelClient();
    // The API path is the default and is not conditional on anything. REASON_BACKEND=claude-cli
    // swaps in the subscription backend for the owner's own local testing; see the README.
    this.runTurn = runTurn ?? (process.env.REASON_BACKEND === "claude-cli" ? cliRunTurn : realRunTurn);
    // The harm screen in front of every message a person sends, and the one behind a borderline
    // reply. Injectable for the same reason runTurn is: what happens on each verdict — no turn,
    // tools refused, the strike, the pause, the crisis line — is code's to guarantee and is proved
    // with the verdict stated. test/flow-harm.test.js is where a real model reads real sentences.
    this.screen = screen ?? harm.screen;
    this.screenReply = screenReply ?? harm.screenReply;
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
    // Timers whose turn is running right now. Sweeps overlap — the interval does not wait for a
    // turn to finish — and a timer is no longer marked fired before its turn, so this is what
    // stops the next sweep starting the same one again. In memory on purpose: a process that dies
    // mid-turn should find the timer still due when it comes back, which is the whole point.
    this.firing = new Set();
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
    let media = waiting
      ? {
        call_id: waiting.id,
        file: waiting.recording_file,
        mimeType: mimeFor(waiting.recording_format),
        filename: `call-${waiting.id}-${waiting.to_number.replace(/\D/g, "")}.${waiting.recording_format}`,
        seconds: waiting.recording_seconds ?? null,
        bytes: waiting.recording_bytes ?? null,
      }
      : null;

    if (media && waiting.recording_format !== "caf") {
      const converter = findConverter();
      if (converter) {
        const { resolve: resolvePath, dirname } = await import("node:path");
        const cafFile = resolvePath(dirname(media.file), `call-${waiting.id}.caf`);
        const args = converter.kind === "afconvert"
          ? VOICE_AFCONVERT_ARGS(media.file, cafFile)
          : ["-y", ...VOICE_FFMPEG_ARGS(media.file, cafFile)];
        const r = await runConverter(args, { bin: converter.bin });
        if (r.ok) {
          media = { ...media, file: cafFile, mimeType: "audio/x-caf", filename: `call-${waiting.id}-${waiting.to_number.replace(/\D/g, "")}.caf` };
        } else {
          this.log({ call_audio_convert_failed: waiting.id, error: r.error });
        }
      }
    }

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

  /**
   * Send the tapback a turn parked, now that the turn is over and it is known whether words went.
   *
   * Taken from the row either way, so a parked reaction can never fire on a later turn — a ❤️
   * landing on a question an hour after it was asked is the thing this whole path exists to avoid.
   * `withWords` false means it is dropped: a tapback was not allowed to be the whole answer, and
   * nothing else was said, so nothing goes.
   *
   * Never allowed to cost anybody a reply. The words have already gone by the time this runs, and a
   * failure here is a missing tapback and a log line, not an error anybody hears about.
   */
  async _fireHeldReaction(conversationId, withWords) {
    const held = db.takeHeldReaction(conversationId);
    if (!held) return null;
    if (!withWords) {
      this.log({ tapback_dropped: held, conversation: conversationId, why: "they had asked something and the turn sent no words" });
      return null;
    }
    let out;
    try {
      out = await sendTapback({ conversationId, channels: this.turnExtras?.channels ?? null, reaction: held });
    } catch (e) {
      out = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
    }
    // On the record like any other tapback, with the input the model actually gave, so the ledger
    // reads the same whether a reaction went out straight away or rode out behind the words.
    ledgerWrite({
      conversationId, action: "react",
      input: { reaction: held, they_asked: true },
      out, target: `tapback:${held}`,
    });
    if (!out.ok) this.log({ tapback_failed: held, conversation: conversationId, why: out.error });
    return out;
  }

  /**
   * The catch a turn claimed, settled now that it is known whether words really went.
   *
   * Three facts, in this order, and none of them is the model's to assert. It was told only if
   * something was sent. It costs them a day's allowance only if it was told. And a catch that rode
   * out on a reply THEY started costs nothing at all, because interrupting somebody is what the
   * budget is counting and that interrupted nobody.
   *
   * A sent catch leaves a receipt, so "what have you been up to" includes the things Reason went and
   * found rather than only the things it was asked for.
   */
  _settleNotice(conversationId, kind, sent) {
    if (!db.pendingNotice(conversationId)) return null;
    if (!sent) {
      const held = db.dropNoticeClaim(conversationId);
      if (held) this.log({ notice_held: held.key, conversation: conversationId, why: "the turn sent nothing" });
      return held;
    }
    const pending = db.pendingNotice(conversationId);
    const free = kind === "user" || pending?.kind === "opt_in";
    // A nudge about a schedule THEY set is unprompted and is not counted — the same split
    // `notice.send` makes, kept here because this is where the day is actually spent. It is still a
    // receipt, and the receipt says which it was. See THEIR_OWN_SCHEDULE in src/notice.js.
    const theirs = notice.THEIR_OWN_SCHEDULE.has(pending?.kind ?? "");
    const counted = !free && !theirs;
    const tz = notice.settingsFor(conversationId).timeZone;
    const row = db.markNoticeSaid(conversationId, { day: notice.localDay(clock.now(), tz), free: !counted });
    if (!row) return null;
    ledgerWrite({
      conversationId, action: "notice_send",
      input: { key: row.key, kind: row.kind, urgent: !!row.urgent, why_now: row.why_now, unprompted: !free },
      out: { ok: true, what: row.what, counted_against_today: counted, ...(theirs ? { their_own_schedule: true } : {}) },
      target: `notice:${row.kind}`,
    });
    this.log({ notice_told: row.key, conversation: conversationId, counted, urgent: !!row.urgent });
    return row;
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
  _turn({ conversationId, text, kind = "user", meta = {}, shouldSend = null, attachments = [], ctx = {}, onSend = null, keep = null }) {
    return this.enqueue(conversationId, async () => {
      // A pointer left by a turn that never used it must not pin THIS turn's reply somewhere.
      db.setReplyTarget(conversationId, null);
      // Same for a "what's new" claim: a turn that said it would mention something and then sent
      // nothing leaves a claim behind, and this turn's reply is not the one it was made about.
      db.dropWhatsNewClaim(conversationId);
      // `answering` is the router's note of which text this turn is for. It decides the pin below,
      // and it reaches the tools so a task started this turn can keep the handle it was asked under.
      // `pinTo` is a caller's note of where a late reply belongs when the turn does not say — a
      // task's wake hands in the text that started the job.
      const { answering = null, requests: inboundRequests = null, pinTo = null, ...rest } = meta;
      meta = rest;
      const mark = db.outboxMark();
      // `ctx` is extra context for the TOOLS of this turn, not for the model: runTurn spreads its
      // leftovers into every tool call's ctx. One caller uses it — the digest pass, which has to
      // tell `notice_send` that this turn IS the batched line rather than an interruption.
      //
      // `taskId` is which job this turn is for, when it is a task's own wake. Code knows it, so the
      // model is not relied on to say it: it is what lets the checks on an ask — the fees, the
      // recipient — read the right sheet without the model having to name the task it was just
      // woken for. It goes in first so an explicit caller can still say otherwise.
      //
      // `keep` is the short line the thread keeps for an event whose full text is only for this
      // turn's decision — a sweep's bundle of unread mail. See userMessageFor in src/agent.js.
      // The hard line, before the model sees a word of it. A message somebody sent is screened
      // (src/harm.js); an event turn is Reason talking to itself and is not. On 'harm' there is no
      // turn: the model never reads it, no tool can run, and the line back is code's.
      const screened = await this._screen({ conversationId, text, kind, meta });
      if (screened.refused) return screened.reply;
      // A standing check-in asked them something, and this is the next thing they said: it is the
      // answer to it. Code's, not the model's, because it has to hold over weeks — the turn that
      // asked is forty trimmed messages back by the time this one runs — and it is read at the next
      // firing so the check-in picks up where the last one left off. See src/series.js.
      if (kind === "user") {
        const reported = series.noteReport({ conversationId, text });
        if (reported) this.log({ series_report: reported.series, conversation: conversationId });
      }
      const reply = await this._afterScreen(screened, await this.runTurn({
        conversationId, text, kind, attachments, events: this, log: this.log,
        taskId: meta.fromTask ?? null,
        ...(answering ? { answering } : {}),
        ...(inboundRequests ? { requests: inboundRequests } : {}),
        ...(keep != null ? { keep } : {}), ...this.turnExtras, ...ctx,
        // Every tool of this turn is told the verdict. Anything but 'clear' and the tools that
        // reach out of the machine refuse (see runTool) — a borderline message, a person in
        // crisis or a screen that could not run all get a Reason with its hands tied.
        ...(screened.verdict !== "clear" ? { harm: screened } : {}),
      }), { conversationId, text, meta });
      // Event log: assistant reply + enqueue extraction.
      if (reply) {
        try {
          const aEvId = db.writeEvent({
            conversationId, channel: meta.channel ?? "", role: "assistant", content: reply,
          });
          db.enqueueExtraction(conversationId, aEvId);
        } catch { /* best-effort */ }
      }
      // The message the turn asked for its reply to be pinned under (the reply_to tool), if it is
      // still unused. Taken whether or not anything is sent, so it never outlives the turn.
      // Failing that, the text it is answering, when that is no longer the last thing in the
      // thread — read now, at the moment of sending, because they may have texted again meanwhile.
      const replyTo = db.takeReplyTarget(conversationId)
        ?? replies.answerTarget(conversationId, answering, mark)
        ?? replies.latePin(conversationId, pinTo);
      // The screen effect the turn marked this reply with (the mark_moment tool). Taken whether or
      // not anything is sent, for the same reason the pin is: an effect armed by a turn that said
      // nothing must not land on whatever the next reply happens to be.
      // Checked again here and not only in the tool: the turn may have sent a message of its own
      // with an effect on it since the mark, and "one an hour" has to hold across everything a
      // single turn does rather than per call site.
      const marked = db.takePendingStyle(conversationId);
      const sendStyle = marked && effectAllowed({ lastAt: db.lastEffectAt(conversationId), now: clock.now() }).ok ? marked : null;
      if (marked && !sendStyle) this.log({ effect_dropped: marked, conversation: conversationId, why: "this conversation already had one in the last hour" });
      if (reply && (!shouldSend || shouldSend(reply))) {
        const out = await this._emit({
          conversationId, text: reply,
          meta: { ...meta, ...(replyTo ? { replyTo } : {}), ...(sendStyle ? { sendStyle } : {}) },
        });
        // For a caller that has to know what became of the send and not only what was written —
        // a timer is finished with once its message is handed over, not once the model has spoken.
        onSend?.(out);
        // Anything new the model said it mentioned is written down HERE, after the send, and only
        // if the send worked. A queued message counts, because that is what `ok` means to
        // src/deliver.js — it is either going to arrive or be reported as lost, and the cost of
        // treating it as sent is silence rather than telling somebody the same thing twice.
        const told = out?.ok === false
          ? db.dropWhatsNewClaim(conversationId)
          : db.markWhatsNewTold(conversationId);
        if (told) this.log({ whats_new: told, conversation: conversationId, heard: out?.ok !== false });
        // A catch the turn claimed through `notice_send` becomes told HERE, for the same reason and
        // with one more on top: this is where it starts costing them their one text a day. A send
        // that failed spends nothing and leaves the thing held, so it will be raised again.
        this._settleNotice(conversationId, kind, out?.ok !== false);
        // The tapback the react tool held back because they had asked something. Words won, so now
        // it rides alongside them — and only now, and only if the words really went out.
        await this._fireHeldReaction(conversationId, out?.ok !== false);
        // A question sent back to a message that asked nothing is written down (src/brief.js), so
        // "how often does it ask instead of act" is a count in the ledger and not a feeling. Only
        // for something a person said, and only once the question really went out.
        if (kind === "user" && out?.ok !== false) {
          const asked = brief.askedBack({ text, reply });
          if (asked) {
            db.recordAction({
              conversationId, action: "asked_back", target: String(text ?? "").slice(0, 160),
              attempted: { they_said: String(text ?? "").slice(0, 400) }, outcome: "asked",
              result: { question: asked.question }, receipt: `asked back: ${asked.question}`,
            });
            this.log({ asked_back: asked.question, conversation: conversationId });
          }
        }
      } else {
        if (reply) this.log({ held_back: meta, said: reply.slice(0, 120) });
        // Nothing left, so nothing was heard: it is offered again on a later reply.
        db.dropWhatsNewClaim(conversationId);
        this._settleNotice(conversationId, kind, false);
        // A turn that asked for a tapback on a question and then said nothing is exactly what the
        // hold is for. Dropped rather than sent: silence is bad, and silence with a ❤️ on the
        // question is worse. Taken rather than left, so it cannot fire on a later turn.
        await this._fireHeldReaction(conversationId, false);
      }
      db.dropStaleRequests(conversationId);
      return reply;
    });
  }

  /**
   * The harm screen on one inbound message, and everything code does with the verdict.
   *
   * 'harm': no model turn. The thread keeps their line and the refusal, the refusal is sent, a
   * ledger row and a strike are written, and enough strikes pause that person's Reason and tell
   * the master — the count and the kind, never the words. The master is refused and never paused.
   *
   * 'crisis', 'borderline' and 'unscreened' all run the turn, with the verdict handed to every tool
   * so the outward ones refuse. What differs is afterwards (see _afterScreen).
   */
  async _screen({ conversationId, text, kind, meta }) {
    if (kind !== "user" || !String(text ?? "").trim()) return { verdict: "clear" };
    const me = accounts.ownerOf(conversationId);
    const who = me.name === "the person I work for" ? "them" : me.name;
    let read;
    try {
      read = await this.screen({ text, messages: db.loadConversation(conversationId), who });
    } catch (e) {
      read = { verdict: "unscreened", error: (e?.message ?? String(e)).split("\n")[0] };
    }
    const verdict = harm.VERDICTS.includes(read?.verdict) ? read.verdict : "unscreened";
    const out = { verdict, category: read?.category ?? "", note: read?.note ?? "", error: read?.error };
    if (verdict !== "clear") this.log({ harm_screen: verdict, category: out.category, conversation: conversationId, ...(out.error ? { why: out.error } : {}) });
    if (read?.skipped) this.log({ harm_screen_skipped: read.skipped, conversation: conversationId });

    if (verdict === "crisis") {
      // Written down so "has this come up before" is answerable, but never a strike: this person
      // is the one at risk, and pausing them would be the one wrong thing to do.
      db.recordHarmEvent({ conversationId, verdict, category: out.category || "self_harm", note: out.note });
      return out;
    }
    if (verdict !== "harm") return out;

    // Their words and the answer go into the thread, so the next turn knows this happened and does
    // not pick up a conversation the model never had.
    db.saveConversation(conversationId, [...db.loadConversation(conversationId), ...harm.historyLines({ who, text })]);
    const strike = harm.recordStrike(conversationId, { category: out.category, note: out.note });
    ledgerWrite({
      conversationId, action: "harm_refuse",
      input: { category: out.category || "other", strike: strike.count },
      out: { ok: false, blocked: "harm", strikes: strike.count, limit: strike.limit },
      target: `harm:${out.category || "other"}`,
    });
    await this._emit({ conversationId, text: harm.REFUSAL_LINE, meta });

    if (strike.reached && !me.isOperator) {
      db.setAccountState(conversationId, "paused");
      const strikes = harm.strikesFor(conversationId);
      ledgerWrite({
        conversationId, action: "harm_pause",
        input: { strikes: strikes.count, window_hours: strikes.windowHours, kinds: strikes.kinds },
        out: { ok: true, state: "paused" },
        target: me.address || conversationId,
      });
      this.log({ harm_paused: conversationId, strikes: strikes.count, kinds: strikes.kinds });
      const line = harm.pausedLine({ address: me.address, strikes });
      const router = this.turnExtras?.channels;
      if (router?.tellMaster) {
        const r = await router.tellMaster(line, meta?.channel ?? null).catch(e => ({ ok: false, error: e?.message }));
        if (!r?.ok) this.log({ could_not_tell_master: r?.error ?? "no route", about: "harm_pause" });
      } else {
        this.emit("outbound", { conversationId: config.ownerConversation, text: line, toMaster: true });
      }
    }
    return { ...out, refused: true, reply: harm.REFUSAL_LINE, strike };
  }

  /**
   * What code guarantees on the way out of a turn that was not clear.
   *
   * 'crisis': whatever the model said, a real way to reach help is on the end of it; a silent turn
   * sends the line alone. 'borderline': the reply is screened again, and anything but a clean
   * 'clear' replaces it — in the thread as well, so the next turn reads what was really sent.
   */
  async _afterScreen(screened, reply, { conversationId, text }) {
    if (screened.verdict === "crisis") {
      if (reply && reply.trim() !== "NO_REPLY" && harm.carriesCrisisHelp(reply)) return reply;
      const out = reply && reply.trim() !== "NO_REPLY" ? `${reply.trim()}\n\n${harm.CRISIS_LINE}` : harm.CRISIS_LINE;
      db.replaceLastAssistant(conversationId, out);
      this.log({ crisis_line_added: conversationId });
      return out;
    }
    if (screened.verdict === "borderline" && reply && reply.trim() !== "NO_REPLY") {
      let read;
      try { read = await this.screenReply({ text: reply, asked: text }); }
      catch (e) { read = { verdict: "unscreened", error: (e?.message ?? String(e)).split("\n")[0] }; }
      if (read?.verdict === "clear") return reply;
      db.recordHarmEvent({ conversationId, verdict: "withheld", category: read?.category ?? "", note: read?.note ?? read?.error ?? "" });
      ledgerWrite({
        conversationId, action: "harm_withheld",
        input: { category: read?.category || "other", screen: read?.verdict ?? "unscreened" },
        out: { ok: false, blocked: "harm_reply", ...(read?.error ? { error: read.error } : {}) },
        target: `harm:${read?.category || "other"}`,
      });
      db.replaceLastAssistant(conversationId, harm.WITHHELD_LINE);
      this.log({ harm_reply_withheld: conversationId, screen: read?.verdict ?? "unscreened" });
      return harm.WITHHELD_LINE;
    }
    return reply;
  }

  /**
   * Inbound text from a person, with anything they attached to it. Resolves to Reason's reply (or
   * null for silence).
   *
   * `meta.attachments` is lifted out and handed to the turn rather than only being carried for the
   * reply, because a picture is part of what they said: the model has to see it to answer.
   */
  async inbound(conversationId, text, meta = {}) {
    const mark = db.outboxMark();
    try {
      return await this._turn({ conversationId, text, kind: "user", meta, attachments: meta.attachments ?? [] });
    } catch (e) {
      // A turn that died used to die in silence: the webhook got an error and the person got a
      // typing bubble that simply stopped. They are told, in one line, and told the truth about
      // whether anything had already gone out — a stall they can see is a stall they can act on.
      const why = (e?.message ?? String(e)).split("\n")[0];
      this.log({ turn_failed: conversationId, why });
      // The model being down is not a stall: the texts are kept and run when it is back
      // (src/down.js, Router.drain). Only up to a point — a text re-held past MAX_REHOLDS gets
      // the stall line after all, so a reset that never comes cannot hold a message forever.
      const outage = readOutage(e);
      if (outage && (meta.downTries ?? 0) < MAX_REHOLDS && db.sentSince(conversationId, mark) === 0) {
        this.log({ backend_down: conversationId, until: outage.until, known: outage.known, why: outage.why });
        throw new OutageError({ ...outage, since: clock.now() });
      }
      const line = stallLine({ sentAny: db.sentSince(conversationId, mark) > 0 });
      this.say(conversationId, line);
      return line;
    }
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

  /**
   * Send any unsent call recording on this conversation now, with an optional caption.
   * Used after a post-call event whose model reply was NO_REPLY: the recording is owed
   * but the model (rightly) had nothing to say, so it would otherwise ride on the next
   * unrelated message.
   */
  async flushRecording(conversationId, caption = "") {
    const waiting = db.callsWithUnsentRecording(conversationId)[0];
    if (!waiting) return null;
    return this._emit({ conversationId, text: caption, meta: {} });
  }

  /** A line Reason sends because code decided to, not because the model wrote it. */
  say(conversationId, text, meta = {}) {
    this.emit("outbound", { conversationId, text, ...meta });
    return text;
  }

  /**
   * `say`, for a line whose handoff has to be waited for: resolves to what became of the send.
   *
   * `say` emits and returns, which is right for a line nothing depends on. This is for the one
   * that something does — the caller writes down that it told somebody only after this comes back,
   * and hands in an `idempotencyKey` so that coming back to do it again cannot send it twice.
   */
  async _tell(conversationId, text, meta = {}) {
    if (!this.deliver) {
      this.emit("outbound", { conversationId, text, ...meta });
      return { ok: true };
    }
    try {
      return (await this.deliver({ conversationId, text, media: null, ...meta })) ?? { ok: true };
    } catch (e) {
      return { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
    }
  }

  /**
   * Fire every due timer as an event turn. Returns how many were finished with on this pass.
   *
   * A timer is fired once its message has been handed to the outbox, and not a moment before.
   * It used to be marked fired first, "so a crash mid-turn can't double-fire", and on 2026-10-06
   * that cost a reminder: the 10:00 one came due late because the Mac was asleep, the Mac slept
   * again a minute and a half into the turn, the CLI was killed for overrunning its clock on
   * waking, and the timer had already been spent. Not sent, not retried, nobody told.
   *
   * So now, in this order, and each one is code's to guarantee rather than the model's:
   *
   *  - **Send, then claim.** The turn runs, its reply goes to the outbox, and only then is the
   *    timer fired. A turn that throws or times out leaves it due.
   *  - **Never twice.** The reply goes out under a key that belongs to this timer, so the outbox
   *    holds one message per firing however many times the turn is run. A timer whose message is
   *    already there — the process died between the handoff and the mark — is simply fired, with
   *    no second turn. `this.firing` keeps an overlapping sweep off a timer whose turn is running.
   *  - **Bounded.** A try is counted before the turn, so even a turn that takes the process down
   *    with it has spent one. After `timerMaxAttempts` it stops.
   *  - **Gives up out loud.** One line, written by code because the model is what just broke,
   *    saying a reminder was missed and what it was. Sent under its own key, then the timer is
   *    marked given up — the same send-then-claim, so they are told exactly once.
   *
   * About the clock that killed that turn: the CLI's timeout is wall time, and time asleep counts.
   * That is left alone on purpose. A turn the machine slept through is talking to a connection
   * that has been dead for as long as the lid was shut, so being killed the moment the machine
   * wakes and started again from clean on the next sweep is the quickest honest way to get the
   * reminder out. Not judging it by time asleep would mean waiting on that process instead.
   */
  async tick() {
    let done = 0;
    for (const due of db.dueTimers()) {
      if (this.firing.has(due.id)) continue; // a slower sweep is still on this one
      this.firing.add(due.id);
      try {
        if (await this._fireTimer(due)) done++;
      } finally {
        this.firing.delete(due.id);
      }
    }
    return done;
  }

  /** One timer, one try. True when the timer is finished with, false when it stays due. */
  async _fireTimer(due) {
    // Read again: the list this came from may be minutes old by the time a turn ahead of it in
    // the same pass has finished, and another sweep may have dealt with this one since.
    const t = db.getTimer(due.conversation_id, due.id);
    if (!t || t.fired_at || t.cancelled_at) return false;

    if (!this.mayInterrupt(t.conversation_id)) { db.markTimerFired(t.id); return true; }
    // Global pause: the timer stays due but does not fire. Unlike mayInterrupt it is NOT marked
    // fired — the reminder is held until resume, and resume picks up future timers normally.
    if (isPaused(t.conversation_id)) { this.log({ timer_held: t.id, conversation: t.conversation_id, why: "paused" }); return false; }
    // Its message is already in the outbox: an earlier try got that far and the process stopped
    // before the timer was marked. The outbox owns it from there, so this is only the bookkeeping.
    if (db.outboundUnder(timerKey(t.id)).length) { db.markTimerFired(t.id); this._noteSeriesFired(t); return true; }
    // Out of tries before this one starts, which is what a turn that killed the process leaves.
    if (t.attempts >= config.timerMaxAttempts) {
      return await this._giveUpOnTimer(t, t.last_error ?? "the process stopped in the middle of the turn");
    }

    const mine = db.claimTimerAttempt(t.id, { nextTryAt: clock.now() + timerRetryGap(t.attempts + 1) });
    if (!mine) return false; // fired or cancelled in the instant between the read and the claim
    let sent = null;
    try {
      sent = await this._runTimer(mine);
    } catch (e) {
      const why = (e?.message ?? String(e)).split("\n")[0];
      const last = mine.attempts >= config.timerMaxAttempts;
      this.log({ timer: t.id, failed: why, attempt: mine.attempts, of: config.timerMaxAttempts });
      // On stderr too when somebody is listening for it, because a server run without --log has
      // no other trace of this, and that line is how the lost reminder was found in the first place.
      if (this.listenerCount("error")) {
        this.emit("error", new Error(`timer #${t.id}: ${why} (try ${mine.attempts} of ${config.timerMaxAttempts}, ${last ? "giving up" : "it stays due"})`));
      }
      if (last) return await this._giveUpOnTimer(mine, why);
      db.markTimerAttemptFailed(t.id, { error: why, nextTryAt: clock.now() + timerRetryGap(mine.attempts) });
      return false;
    }
    db.markTimerFired(t.id);
    if (sent && sent.ok !== false) this._noteSeriesFired(t);
    return true;
  }

  /**
   * A standing check-in that really went out: counted, and now waiting on an answer.
   *
   * Only when something reached the outbox. A firing the model answered with NO_REPLY has asked
   * nothing, and treating it as a question would make the next thing they said — about anything at
   * all — the report on a check-in they never saw. Nothing here for an ordinary timer.
   */
  _noteSeriesFired(t) {
    if (!t?.series_id) return;
    const s = db.noteSeriesFired(t.series_id);
    this.log({ series: t.series_id, checked_in: s?.fired_count ?? null, timer: t.id });
  }

  /**
   * The turn a timer is for. Returns what became of the send — null when there was nothing to say —
   * and throws when the timer should be tried again.
   */
  async _runTimer(t) {
    const key = timerKey(t.id);
    let sent = null;
    const turn = async (args) => {
      await this._turn({
        conversationId: t.conversation_id, kind: "event", ...args,
        meta: { ...args.meta, idempotencyKey: key },
        onSend: (out) => { sent = out; },
      });
      // Written, and it went nowhere: no row, so nothing will retry it and nothing will report it.
      // A message that failed INSIDE the outbox is different — that has a row, and the outbox
      // tells them at the top of their next turn — so only this case comes back for another try.
      if (sent?.ok === false && !db.outboundUnder(key).length) {
        throw new Error(`the reminder was written and could not be handed over: ${sent.error ?? "no reason given"}`);
      }
    };

    // A timer a watchful catch was parked on, rather than one anybody asked for. The moment it
    // was waiting for has come, so the same rules apply as on the sweep that found it: it goes
    // through `notice_send` and nothing is sent unless that claimed something.
    const owned = db.noticeByTimer(t.id);
    if (owned && !owned.said_at && !owned.resolved_at) {
      // Checked again, here, hours after the sweep that found it. This is where "already handled"
      // earns its keep: the whole point of parking a catch is that time passes before it is said,
      // and the most likely thing to happen in that time is that they dealt with it themselves.
      const sifted = await notice.siftHandled({
        conversationId: t.conversation_id, candidates: [{ ...owned, id: owned.id }], now: clock.now(), log: this.log,
      });
      if (!sifted.keep.length) return null;
      try {
        await turn({
          text: notice.momentFrame({ conversationId: t.conversation_id, row: db.noticeById(owned.id) ?? owned }),
          meta: { fromTimer: t.id, fromNotice: owned.key },
          shouldSend: () => !!db.pendingNotice(t.conversation_id),
        });
      } catch (e) {
        // A turn that broke after `notice_send` claimed the catch has left the claim open, and the
        // next reply in this conversation — whoever starts it — would settle it as told. Nothing
        // was sent, so it goes back; the retry claims it again through the same gate.
        if (!sent) db.dropNoticeClaim(t.conversation_id);
        throw e;
      }
      return sent;
    }
    const plan = t.plan_id ? db.getPlan(t.conversation_id, t.plan_id) : null;
    // A standing check-in rather than a one-off: the subject and what they said last time, read off
    // the series row HERE rather than copied into the note when this occurrence was scheduled. The
    // report usually arrives after the scheduling, and a note written last Monday would have Reason
    // asking about the week before last. See frameFor in src/series.js.
    const standing = t.series_id ? db.seriesById(t.series_id) : null;
    // A standing check-in that belongs to a GOAL is a search rather than a question: the firing
    // hands over the criteria they confirmed and everything already sent, and what goes back is
    // only what they have never seen. Read off the rows here, at fire time, because the criteria
    // may have changed since this occurrence was scheduled. See src/goals.js.
    const forGoal = standing ? db.goalBySeries(standing.id) : null;
    const text = `timer #${t.id} fired (set for ${stamp(t.fire_at)}). your note: "${t.note}".` +
      (plan ? ` plan #${plan.id} is now: ${JSON.stringify({ title: plan.title, status: plan.status, when: plan.when, where: plan.where, who: plan.who, open_questions: plan.open_questions })}.` : "") +
      (standing ? series.frameFor(standing) : "") +
      (forGoal ? goals.checkFrame(forGoal) : "") +
      // The earlier try may have left its own event line in the conversation, and without this the
      // second one reads as a second reminder rather than the first one arriving late.
      (t.attempts > 1 ? ` This is try ${t.attempts} at the same timer: an earlier try broke before anything reached them, so they have not had this yet. It is one reminder, late — not a second one.` : "") +
      (standing ? "" : ` Decide whether to say something. If nothing is worth sending, reply NO_REPLY.`);
    await turn({
      text,
      // The thread keeps one line for a search rather than the criteria and the whole sent list:
      // the frame is for one decision, and a copy of it in the history would be re-read on every
      // later turn describing criteria they may since have changed. Same choice as the sweep's.
      ...(forGoal ? { keep: goals.checkKept(forGoal) } : {}),
      meta: { fromTimer: t.id, ...(standing ? { fromSeries: standing.id } : {}), ...(forGoal ? { fromGoal: forGoal.id } : {}) },
    });
    return sent;
  }

  /**
   * A timer that is out of tries. Always finishes it — true — and says so when it was theirs.
   *
   * The line goes out first and the timer is marked second, under a key of its own, so a process
   * that stops between the two sends nothing new when it comes back: the outbox already has the
   * row. If the line cannot be sent either, that is logged and the timer is still finished; the
   * alternative is a timer that comes round for ever to announce that it has given up.
   *
   * A catch Reason parked for itself is not a reminder anybody is owed. It goes back to being
   * held, where it folds into a later reply like any other, and nothing is said about the timer.
   */
  async _giveUpOnTimer(t, why) {
    const owned = db.noticeByTimer(t.id);
    this.log({ timer: t.id, gave_up: why, attempts: t.attempts, ...(owned ? { notice: owned.key } : {}) });
    if (owned && !owned.said_at && !owned.resolved_at) {
      db.unparkNotice(owned.id);
      db.markTimerGaveUp(t.id, { error: why });
      return true;
    }
    const out = await this._tell(t.conversation_id, missedTimerLine(t), { fromTimer: t.id, idempotencyKey: `timer:${t.id}:missed` });
    if (out?.ok === false) this.log({ timer: t.id, could_not_say_it_was_missed: out.error ?? "no reason given" });
    db.markTimerGaveUp(t.id, { error: why });
    return true;
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
      // A watch with no page: Parallel's monitor is doing the watching, and this is Reason asking it
      // what it has seen. A webhook makes the watch due now (src/http.js); otherwise the schedule
      // does. Fires once, on the newest event not yet told, and the monitor is cancelled with it.
      if (w.monitor_id) {
        const got = await this.parallel.monitorEvents(w.monitor_id);
        db.recordWatchCheck(w.id, { seen: w.last_seen });
        const fresh = got.ok ? got.events.filter(e => e.id !== w.last_event_id) : [];
        this.log({ watch: w.id, monitor: w.monitor_id, events: fresh.length, ...(got.ok ? {} : { error: got.error }) });
        if (!fresh.length) {
          const checks = (db.getWatch(w.conversation_id, w.id)?.checks ?? 0);
          if (checks >= config.watchMaxChecks) {
            db.markWatchGaveUp(w.id);
            out.gave_up++;
            await this.parallel.monitorCancel(w.monitor_id);
            await this.event(w.conversation_id,
              `watch #${w.id} for "${w.query}" has been checked ${checks} times without "${w.looking_for}" ever happening, so it has stopped.` +
              ` Tell them plainly that you stopped watching and offer to start again. Do not pretend it is still running.`,
              { fromWatch: w.id });
          }
          continue;
        }
        const newest = fresh[0];
        db.noteWatchEvent(w.id, newest.id);
        db.markWatchMet(w.id, newest.text.slice(0, 300));
        db.rememberSeenUrls(w.conversation_id, newest.sources.map(s => s.url));
        out.met++;
        await this.parallel.monitorCancel(w.monitor_id);
        const cited = newest.sources.slice(0, 4).map(s => `${s.title || s.url} <${s.url}>${s.said ? `: ${s.said.slice(0, 300)}` : ""}`).join("\n");
        await this.event(w.conversation_id,
          `watch #${w.id} for "${w.query}" says the thing happened. you were watching for: "${w.looking_for}".` +
          (w.note ? ` your note: "${w.note}".` : "") +
          ` Parallel's monitor reported${newest.date ? ` (dated ${newest.date})` : ""}: "${newest.text.slice(0, 1500)}".` +
          (cited ? ` Its sources:\n${cited}` : " It cited no sources.") +
          ` Tell them what it reported and where it came from. Do not add anything it does not say; you have not read these pages yourself. If it turns out not to be what they wanted, say that instead.`,
          { fromWatch: w.id });
        continue;
      }
      let page;
      try {
        // `fresh`: a watcher exists to notice a change, so it may not be handed a cached copy of
        // the page — an indexed one cannot have changed since the last look. An ordinary read is
        // left on the default, where cached is fine and faster.
        page = await this.lookup(w.url, { maxChars: 6000, fresh: true });
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
    const out = { woke: 0, reported: 0, held: 0, retried: 0, failed: 0, reminded: 0, resting: 0, peeked: 0 };
    for (const t of db.dueTasks()) {
      // A wait on somebody else, due at the floor rather than at the model's own time: a peek, not
      // a wake. Code looks at what landed since the job last really looked (src/landed.js) and only
      // pays for a turn when something did, or when the model's time has come. Nothing is counted.
      if (t.state === "waiting_on_other" && t.wanted_wake_at && t.wanted_wake_at > clock.now()) {
        const since = t.last_woken_at ?? t.created_at;
        if (!landed.landedSince(t, since).length) {
          const next = Math.min(t.wanted_wake_at, clock.now() + config.taskWaitingFloorMin * MIN);
          db.scheduleTask(t.id, next);
          out.peeked++;
          this.log({ task: t.id, peeked: true, nothing_since: since, next, wanted: t.wanted_wake_at });
          continue;
        }
      }
      // Their night. The step keeps until their morning; nothing is claimed and the wake is not
      // counted, so a job that fell due at 3am is exactly the job it was at 8.
      const morning = sleepsUntil(t);
      if (morning) {
        db.scheduleTask(t.id, morning);
        out.resting++;
        this.log({ task: t.id, rests_until: morning, conversation: t.conversation_id });
        continue;
      }
      if (isPaused(t.conversation_id)) {
        out.resting++;
        this.log({ task: t.id, held: true, conversation: t.conversation_id, why: "paused" });
        continue;
      }
      out.woke++;
      const before = db.taskSignature(t.id);
      db.markTaskWoken(t.id);
      // Where a line about this job lands: under the text that asked for it, once the thread has
      // moved on. Read at the moment of speaking, for the same reason the turn's own pin is.
      const pin = () => { const h = replies.latePin(t.conversation_id, t.origin_handle); return h ? { replyTo: h } : {}; };

      // A task waiting on THEM is not a task to take a step on: there is nothing to do until they
      // answer, and waking the model to discover that costs a call and risks a second ask. So it
      // rests, and exactly once — after the gap — the one thing it needs is said again, in words
      // code wrote. Never a third time. See claimNeedsReminder.
      if (t.state === "waiting_on_you") {
        // The cap is checked BEFORE the claim, and the order is the whole correctness of this.
        // `claimNeedsReminder` stamps the row and the stamp is permanent — it is what makes "never a
        // third time" true. Claiming first and then finding the day's proactive budget spent would
        // burn the one nudge this question is ever owed without sending it, and the task would go
        // back to resting forever having said nothing. "At most one" would quietly have become
        // "none", on the most ordinary day there is: a busy one. Capped, nothing is claimed, the
        // task rests and the same nudge is owed again after the next gap.
        const owed = this.mayInterrupt(t.conversation_id)
          ? db.claimNeedsReminder(t.id, { gapMs: config.needsReminderMin * MIN })
          : null;
        if (owed) {
          out.reminded++;
          this.say(t.conversation_id,
            `still need one thing on "${t.title}" whenever u get a sec — ${owed.question} (${owed.tradeoff}). no rush, just didn't want it to go quiet.`,
            { fromTask: t.id, ...pin() });
        } else {
          out.resting++;
        }
        db.scheduleTask(t.id, clock.now() + config.needsReminderMin * MIN);
        continue;
      }

      if (t.wakes + 1 > config.taskMaxWakes) {
        db.finishTask(t.conversation_id, t.id, {
          state: "failed",
          outcome: `gave up after ${t.wakes + 1} attempts at it without finishing`,
        });
        out.failed++;
        this.say(t.conversation_id,
          `ok i have to be honest — i've come back to "${t.title}" ${t.wakes + 1} times and gotten nowhere, so i've stopped. want me to try a different angle?`,
          { fromTask: t.id, ...pin() });
        continue;
      }

      let reply;
      try {
        reply = await this._turn({
          conversationId: t.conversation_id,
          text: taskEventText(t),
          kind: "event",
          meta: { fromTask: t.id, pinTo: t.origin_handle ?? null },
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
        + ` It answers THAT question and nothing else: a tap is not a yes for anything that needs the gate, so a purchase, a text to`
        + ` somebody else or a booking still stops and asks in words.`
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
   * Undo windows that have run out: the thing happens, for real, exactly once (src/undo.js).
   *
   * No model call anywhere in here, and that is the whole reliability story. A person said yes,
   * was told it was going in thirty seconds, and did not stop it — what happens next must not
   * depend on there being credit, a key or a working backend, because "it said it sent the email"
   * followed by nothing is the one outcome this feature cannot have.
   *
   * The owner half mirrors the outbox's. A held thing that failed on release never reached
   * anybody, and nobody is sitting in a turn waiting to be told, so they are told in words code
   * wrote. A row whose outcome is genuinely unknown — the process stopped mid-release — is said
   * as that and is NOT done again.
   */
  async undo({ router = this.turnExtras.channels } = {}) {
    const out = { due: 0, sent: 0, failed: 0, owner_told: 0 };
    Object.assign(out, await undoLib.pass({
      log: this.log,
      run: (row) => runReleasedAction(row, { ...this.turnExtras, events: this, log: this.log }),
    }));

    for (const row of db.untoldHoldFailures()) {
      // Claimed before the send, so a crash here means they are not told twice.
      if (!db.markHoldTold(row.id)) continue;
      const line = undoLib.failureLine(row);
      // To the person whose thing it was, in their own thread — never to the master, who in a
      // multi-person install is somebody else entirely. Durable, like the outbox's version: if
      // the line itself cannot be delivered it lands at the top of their next turn as a lost reply.
      const thread = db.getThread(row.conversation_id);
      const r = router && thread?.channel && thread.channel !== "console" && thread.address
        ? await router.send({
          channel: thread.channel, to: thread.address, chatId: thread.chat_id ?? null,
          text: line, conversationId: row.conversation_id, toOwner: true,
        })
        : { ok: false, error: "there is no thread to reach them on" };
      if (r?.ok) out.owner_told++;
      else this.log({ held: row.id, could_not_tell_owner: r?.error ?? "no reason given" });
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

  /**
   * What is past its keep-by date, gone (src/privacy.js).
   *
   * On the sweep rather than on a schedule of its own, because the sweep is the one thing a
   * running Reason is guaranteed to do: a retention promise that needed its own cron job would be
   * a promise that quietly stopped being kept. Every statement is bounded by a timestamp, so the
   * run that finds nothing old costs nothing, which is almost all of them.
   */
  retention() { return sweepRetention({ now: clock.now(), log: this.log }); }

  async extract() {
    try {
      const { processQueue } = await import("./extract.js");
      return await processQueue({ limit: 5, log: this.log });
    } catch (e) {
      this.log({ extraction_error: (e?.message ?? String(e)).split("\n")[0] });
      return 0;
    }
  }

  /**
   * The reflection pass: once a day, while they are asleep, what shape have the last three weeks had?
   *
   * The same shape as the sweep above and the digest beside it, and the same priority of refusals:
   * everything code can settle is settled before a model is paid for a turn. Did they say no (then
   * delete what is there and stop); has it run today already; is there even enough evidence to be
   * worth looking at. Almost every person on almost every night costs two queries and no model call.
   *
   * Two things make it safe to leave running. It SENDS NOTHING — `shouldSend` is false outright for
   * the reflection turn, so whatever the model writes is held back by code rather than trusted — and
   * it writes nothing at all unless they have said yes, which they are asked about exactly once, in
   * the one branch below that is allowed to speak.
   *
   * `gatherWith` is injectable for the tests, like the sweep's: the schedule, the gate and the
   * expiry are code's to guarantee and none of them should need three weeks of real messages.
   */
  async rhythms({ gatherWith = rhythmsLib.evidenceFor, now = clock.now() } = {}) {
    const out = { people: 0, looked: 0, turns: 0, asked: 0, expired: 0, deleted: 0, skipped: [] };
    for (const acct of db.listAccountsOfPeople()) {
      if ((acct.state ?? "active") !== "active") continue;
      const c = acct.conversation_id;
      out.people++;
      const s = notice.settingsFor(c, { now });

      if (s.patterns === "off") {
        const gone = db.dropPatterns(c);
        if (gone.length) { out.deleted += gone.length; this.log({ rhythms: c, deleted: gone.length, why: "they said no" }); }
        out.skipped.push({ conversation: c, why: "patterns_off" });
        continue;
      }
      if (isPaused(c)) { out.skipped.push({ conversation: c, why: "paused" }); continue; }

      const night = notice.inTheirNight(c, now);
      const asking = s.patterns === "not_asked";
      if (asking === night) {
        out.skipped.push({ conversation: c, why: night ? "the question waits for their morning" : "not their night" });
        continue;
      }
      const today = notice.localDay(now, s.timeZone);
      const sweep = db.noticeSweep(c);
      if (sweep?.last_rhythm_day === today) { out.skipped.push({ conversation: c, why: "already today" }); continue; }

      const stale = rhythmsLib.expire({ conversationId: c, now });
      if (stale.length) { out.expired += stale.length; this.log({ rhythms: c, expired: stale.map(r => r.id) }); }

      if (asking) {
        if (s.patternsAskedAt) { out.skipped.push({ conversation: c, why: "asked once, never answered" }); continue; }
        if (s.windowAskedAt === null) { out.skipped.push({ conversation: c, why: "their hours have not even been asked yet" }); continue; }
        if (!notice.MODES[s.mode].unprompted) { out.skipped.push({ conversation: c, why: `initiative is ${s.mode}` }); continue; }
      }

      const evidence = gatherWith({ conversationId: c, now, timeZone: s.timeZone });
      const enough = rhythmsLib.enoughToLookAt(evidence);
      db.markRhythmDay(c, today);
      if (!enough.ok) { out.skipped.push({ conversation: c, why: enough.why }); continue; }
      out.looked++;

      if (asking) {
        if (!this.mayInterrupt(c)) { out.skipped.push({ conversation: c, why: "daily_proactive_cap" }); continue; }
        out.turns++;
        await this._turn({
          conversationId: c, kind: "event",
          text: rhythmsLib.askFrame({ conversationId: c, evidence, now }),
          keep: `[patterns] you asked ${acct.name || config.ownerName} the one question about whether you may keep noticing`
            + ` patterns about them. Whatever they say next about it is the answer.`,
          meta: { fromRhythms: "ask" },
          ctx: { rhythmEvidence: evidence },
          shouldSend: () => !!db.pendingNotice(c),
        });
        const row = db.getNotice(c, notice.PATTERNS_ASK_KEY, "patterns_ask");
        if (row?.said_at) {
          db.setPatterns(c, { askedAt: now });
          accounts.countUse(c, "proactive");
          out.asked++;
          this.log({ rhythms: c, asked: true });
        } else {
          db.takePatternAsk(c);
          if (row) db.forgetNotice(row.id);
          out.skipped.push({ conversation: c, why: "it had nothing worth asking about" });
        }
        continue;
      }

      const rows = db.listPatterns(c, { limit: 10 });
      out.turns++;
      await this._turn({
        conversationId: c, kind: "event",
        text: rhythmsLib.reflectFrame({ conversationId: c, evidence, rows, now }),
        keep: rhythmsLib.reflectKept({ conversationId: c, evidence }),
        meta: { fromRhythms: true },
        ctx: { rhythmEvidence: evidence },
        shouldSend: () => false,
      });
    }
    return out;
  }

  /**
   * What the builders on this machine have written down, taken in, and the master told about it.
   *
   * Two halves, and the split is the point. The first — `remote.collect` — reads every running
   * job's file, settles the ones whose turn is over and rebuilds their pages, and makes no model
   * call at all: the states and the pages have to be right when there is no key, no credit and no
   * working backend, because "is it finished" is exactly the question somebody asks when things
   * are broken. The second half is a turn, and only happens when there is news that earns one.
   *
   * The news is claimed BEFORE the turn runs, so two overlapping sweeps cannot both report the
   * same thing. A turn that throws puts the claim back: being told once and losing it is
   * recoverable by asking, and being told four times is not.
   *
   * A capped master is the one case where the claim is deliberately NOT taken. A timer that cannot
   * be delivered is spent anyway because the moment it was for has passed, but a builder waiting on
   * a yes does not stop waiting, so the news stays unclaimed and goes out when the cap resets.
   */
  async builders() {
    const out = { read: 0, settled: 0, events: 0, told: 0, held: 0, capped: 0 };
    if (!config.remoteBuild) return out;
    Object.assign(out, remote.collect({ log: this.log }));

    for (const job of db.remoteJobsWithNews()) {
      const news = db.remoteNews(job.id, job.sent_through);
      const due = remote.noticeDue(job, news);
      if (!due.send) { out.held++; continue; }
      if (!this.mayInterrupt(job.conversation_id)) { out.capped++; continue; }

      // Taken after the news is read, so anything written between the two is next time's news
      // rather than being marked as told and never mentioned.
      const through = news.at(-1).id;
      const was = db.claimRemoteNews(job.id, through);
      if (was === null) continue; // another sweep got there first

      const page = job.page_id ? db.getPage(job.page_id) : null;
      const text = remote.noticeText(job, news, { link: page ? ownerUrl(page) : "" });
      try {
        const said = await this.event(job.conversation_id, text, { fromRemoteJob: job.id, ...(job.page_id ? { pageId: job.page_id } : {}) });
        if (said) out.told++;
        this.log({ remote_job: job.id, told: !!said, why: due.why, state: job.state });
      } catch (e) {
        db.releaseRemoteNews(job.id, was);
        this.log({ remote_job: job.id, could_not_tell: (e?.message ?? String(e)).split("\n")[0] });
      }
    }
    return out;
  }

  /**
   * Somebody asked for a Reason while the master could not be asked — one was already in front of
   * them, or the hour's or the day's ceiling was reached. Without this they would wait until the
   * master next happened to answer a different request, which may be never. No model call.
   */
  async accessQueue({ router = this.turnExtras.channels } = {}) {
    if (!router?.askNextWaiting) return { asked: false };
    return await router.askNextWaiting();
  }

  /**
   * The watchful sweep: go and look, for everybody who has a mailbox and a calendar connected.
   *
   * This is the only pass in here that nobody pointed at anything. Everything code can decide is
   * decided before a model is paid for a turn, in this order, because each one makes the next
   * cheaper: is anybody connected, is their cadence up, is there anything new, is their day already
   * spent. A person with nothing new on their calendar and no mail waiting costs two API reads and
   * no model call, which is almost every sweep.
   *
   * `gatherWith` is injectable for the tests: the schedule, the high-water mark and the budget are
   * code's to guarantee and none of them should need a real Google to prove.
   */
  async notice({ gatherWith = notice.gather, readWith = null, now = clock.now() } = {}) {
    const out = { people: 0, looked: 0, candidates: 0, turns: 0, told: 0, held: 0, skipped: [], not_connected: 0, handled: 0, asked: 0, bridged: 0 };
    for (const acct of db.listAccountsOfPeople()) {
      if ((acct.state ?? "active") !== "active") continue;
      const c = acct.conversation_id;
      out.people++;
      const settings = notice.settingsFor(c, { now });
      // "Only answer when asked" means the LOOKING stops too, not just the texting. Reading
      // somebody's mail every two hours to say nothing about it is not what they agreed to, and a
      // snooze is read the same way for the day it lasts.
      if (!notice.MODES[settings.mode].sweeps) {
        out.skipped.push({ conversation: c, why: settings.snoozed ? "snoozed" : "initiative_off" });
        continue;
      }
      const sweep = db.noticeSweep(c);
      // Their cadence, or their own "check more often". Nothing is read before it is due: a look is
      // two API calls per account and the thing being looked for does not change by the minute.
      if (sweep?.last_at && now - sweep.last_at < settings.everyMs) { out.skipped.push({ conversation: c, why: "not due" }); continue; }

      let bundle;
      try {
        bundle = await gatherWith({ conversationId: c, now, since: sweep?.last_at ?? null, log: this.log });
      } catch (e) {
        this.log({ notice: c, could_not_look: (e?.message ?? String(e)).split("\n")[0] });
        continue;
      }
      if (!bundle?.ok) {
        // Nothing connected, or a grant that has died. Either way there is nothing to watch and
        // nothing to say about it unprompted — `notice_status` is where that answer lives, for when
        // they ask. The mark still moves so a disconnected person is not re-probed every sweep.
        out.not_connected++;
        db.markNoticeSwept(c, { at: now });
        continue;
      }
      out.looked++;
      db.markNoticeSwept(c, { at: now, timeZone: bundle.time_zone || null });

      // The one question before any of this starts: their zone and their hours. Asked here rather
      // than at connect time because here is where it is about to matter, and asked INSTEAD of a
      // catch on this sweep — two unprompted texts to open with is the noise this feature is against.
      // Until they answer, the default runs, so the question being ignored costs nothing.
      if (settings.windowAskedAt === null) {
        const row = db.recordNotice(c, {
          kind: "opt_in", key: notice.OPT_IN_KEY, momentAt: now, at: now,
          what: `nobody has asked them what zone they are in or what hours they are happy being texted in`,
        });
        if (row.fresh || !row.said_at) {
          db.setNoticeWindow(c, { askedAt: now });
          out.asked++;
          out.turns++;
          await this._turn({
            conversationId: c, kind: "event",
            text: notice.optInFrame({
              conversationId: c, timeZone: bundle.time_zone || settings.timeZone,
              guessedFrom: bundle.time_zone ? "their calendar" : "",
            }),
            meta: { fromNotice: "opt_in" },
            shouldSend: () => !!db.pendingNotice(c),
          });
          continue;
        }
      }

      // Their own zone if they gave one, their calendar's if they did not. Never this machine's.
      const tz = settings.toldUsTheirZone ? settings.timeZone : (bundle.time_zone || settings.timeZone);
      const rhythmRows = settings.patterns === "on" ? db.listPatterns(c, { limit: 10 }) : [];
      const quietOpts = { timeZone: tz, quietStart: settings.quietStart, quietEnd: settings.quietEnd, rhythms: rhythmRows };

      // Written down before anything is said, so a crash between here and the turn loses the news
      // once rather than raising it forever. Anything already seen in this exact state is dropped
      // by the UNIQUE on the table rather than by a rule anybody has to remember.
      let fresh = [];
      for (const cand of bundle.candidates) {
        const moment = notice.momentWithReason(cand, now, quietOpts);
        const row = db.recordNotice(c, {
          kind: cand.kind, key: cand.key, what: cand.what, detail: cand.detail ?? "",
          momentAt: moment.at, momentWhy: moment.why, at: now,
          thing: cand.thing ?? "", account: cand.account ?? "",
          threadId: cand.thread_id ?? "", eventId: cand.event_id ?? "", state: cand.state ?? "",
          source: cand.source ?? "",
        });
        if (row.fresh) fresh.push({ ...cand, id: row.id, moment_at: row.moment_at });
      }
      // Something true that could not be said last time goes back in front of the model first.
      let held = db.heldNotices(c, { limit: 3 })
        .map(r => ({ id: r.id, kind: r.kind, key: r.key, what: r.what, detail: r.detail, source: r.source || "", held: true, holds: r.holds, moment_at: r.moment_at, unclear: r.unclear || "", event_id: r.event_id, thread_id: r.thread_id }));
      out.candidates += fresh.length;

      // Anything an open job was waiting for goes to the job, now, before any of the rules below
      // can hold it: the job is woken and the candidate is its to say. The sweep's own frame does
      // not see it again. This is the bridge that was missing on 2026-10-12 (src/landed.js).
      const bridged = landed.bridge(c, [...held, ...fresh], { now, log: this.log });
      if (bridged.length) {
        out.bridged += bridged.length;
        const taken = new Set(bridged.map(b => b.key));
        fresh = fresh.filter(x => !taken.has(x.key));
        held = held.filter(x => !taken.has(x.key));
      }

      // Did they already handle it? Asked of the live mailbox and the live calendar BEFORE a model
      // is paid for a turn, because a reply they already sent and a bill they already opened are
      // the two most likely things in any bundle, and neither of them is news.
      const sifted = await notice.siftHandled({
        conversationId: c, candidates: [...held, ...fresh], read: readWith, now, log: this.log,
      });
      out.handled += sifted.handled.length;
      const inFront = sifted.keep;
      if (!inFront.some(x => notice.KINDS[x.kind]?.speakable !== false)) continue;

      // They asked for one batched line instead. Everything is written down and held, and the
      // digest pass is what speaks — so a 'digest' sweep costs no model turn at all.
      if (settings.mode === "digest") {
        for (const x of inFront) if (x.id) db.holdNotice(x.id, now);
        out.held += inFront.length;
        out.skipped.push({ conversation: c, why: "held_for_digest" });
        continue;
      }

      const budget = notice.budgetFor(c, { now, timeZone: tz });
      const quiet = notice.inQuietHours(now, tz, { start: settings.quietStart, end: settings.quietEnd });
      // Everything that cannot possibly be sent, settled without paying for a turn. Quiet hours and
      // a spent day both still allow one thing through — something starting inside the next few
      // hours, which is the case those two rules would otherwise make useless.
      const timeCritical = inFront.some(x => notice.KINDS[x.kind]?.speakable !== false && (x.moment_at ?? now) <= now && /^calendar_/.test(x.kind));
      const blocked = budget.capped
        ? "hard_cap"
        : settings.perDay === 0 ? "they_asked_for_none"
          : (budget.spent && !timeCritical) ? "budget_spent"
            : (quiet && !timeCritical) ? "quiet_hours" : null;
      if (blocked) {
        for (const x of inFront) if (x.id) db.holdNotice(x.id, now);
        out.held += inFront.length;
        out.skipped.push({ conversation: c, why: blocked });
        this.log({ notice: c, held: inFront.length, why: blocked });
        continue;
      }
      if (!this.mayInterrupt(c)) { for (const x of inFront) if (x.id) db.holdNotice(x.id, now); out.skipped.push({ conversation: c, why: "daily_proactive_cap" }); continue; }

      out.turns++;
      await this._turn({
        conversationId: c, kind: "event",
        text: notice.sweepFrame({ conversationId: c, candidates: inFront, context: bundle.context, budget, timeZone: tz, quiet, accounts: bundle.accounts }),
        keep: notice.sweepKept({ conversationId: c, candidates: inFront }),
        meta: { fromNotice: true },
        // The sweep cannot text. Whatever the model wrote, it only leaves if `notice_send` claimed
        // something — so a line that skipped the gate is held back by code rather than trusted.
        shouldSend: () => !!db.pendingNotice(c),
      });
      // Read off the rows rather than off what the turn returned. A turn hands its words back even
      // when `shouldSend` refused them, so "it said something" and "they were told something" are
      // two different facts and only the second one is in the table.
      let told = 0;
      for (const x of inFront) {
        if (!x.id) continue;
        const row = db.noticeById(x.id);
        if (row?.said_at) { told++; continue; }
        if (row?.timer_id) continue;          // parked for its own moment, which is not being held
        db.holdNotice(x.id, now);
        out.held++;
      }
      if (told) { out.told += told; accounts.countUse(c, "proactive"); }
    }
    return out;
  }

  /**
   * The digest: one batched line, for somebody who asked for that instead.
   *
   * Everything the sweep found while they were on `digest` is sitting held, so this pass is cheap
   * and needs no Google at all — it reads the rows and runs one turn at the hour they chose. The
   * hour is matched rather than scheduled: a pass that misses its hour because the process was down
   * would otherwise skip the day entirely, and `last_digest_day` is what stops it going twice.
   *
   * The budget still applies. One text, which is what makes it a digest and not a report.
   */
  async digest({ now = clock.now(), readWith = null } = {}) {
    const out = { people: 0, due: 0, turns: 0, sent: 0, handled: 0, skipped: [] };
    for (const acct of db.listAccountsOfPeople()) {
      if ((acct.state ?? "active") !== "active") continue;
      const c = acct.conversation_id;
      const s = notice.settingsFor(c, { now });
      if (s.mode !== "digest") continue;
      out.people++;
      const today = notice.localDay(now, s.timeZone);
      const sweep = db.noticeSweep(c);
      if (sweep?.last_digest_day === today) { out.skipped.push({ conversation: c, why: "already today" }); continue; }
      if (notice.localHour(now, s.timeZone) < s.digestHour) { out.skipped.push({ conversation: c, why: "not their hour yet" }); continue; }

      const held = db.heldNotices(c, { limit: 8 })
        .map(r => ({ id: r.id, kind: r.kind, key: r.key, what: r.what, detail: r.detail, source: r.source || "", holds: r.holds, unclear: r.unclear || "" }));
      // The mark moves whether or not there was anything, so an empty day costs one query and no
      // turn, and tomorrow's digest is not yesterday's plus today's.
      db.markDigestDay(c, today);
      if (!held.length) { out.skipped.push({ conversation: c, why: "nothing held" }); continue; }
      out.due++;

      // Checked again here. A digest is by definition late, so "already handled" is MORE likely in
      // one of these than on the sweep that found it.
      const sifted = await notice.siftHandled({ conversationId: c, candidates: held, read: readWith, now, log: this.log });
      out.handled += sifted.handled.length;
      if (!sifted.keep.length) { out.skipped.push({ conversation: c, why: "all of it had been handled" }); continue; }
      if (!this.mayInterrupt(c)) { out.skipped.push({ conversation: c, why: "daily_proactive_cap" }); continue; }

      const budget = notice.budgetFor(c, { now, timeZone: s.timeZone });
      out.turns++;
      await this._turn({
        conversationId: c, kind: "event",
        text: notice.digestFrame({ conversationId: c, candidates: sifted.keep, budget, timeZone: s.timeZone, hour: s.digestHour }),
        keep: notice.digestKept({ conversationId: c, candidates: sifted.keep }),
        meta: { fromNotice: "digest" },
        // The one caller of `ctx`: this turn IS the batched line they asked for, so `notice_send`
        // must not hold it back for a digest that is already happening.
        ctx: { noticeTurn: "digest" },
        shouldSend: () => !!db.pendingNotice(c),
      });
      for (const x of sifted.keep) {
        if (!x.id) continue;
        const row = db.noticeById(x.id);
        if (row?.said_at) { out.sent++; continue; }
        db.holdNotice(x.id, now);
      }
      if (out.sent) accounts.countUse(c, "proactive");
    }
    return out;
  }

  /**
   * It notices when you skip: the time they named went past with nothing from them.
   *
   * The only pass in here whose event is an ABSENCE. Everything else wakes because something
   * happened — a timer came due, a page changed, a task is owed a step. This one reads their
   * commitments and the clock and looks for the occurrence that has no log on it, which is why
   * there is no timer behind a commitment and why that is the right shape: a timer firing at 7:00
   * would be an alarm, and they already have one of those.
   *
   * Everything decidable is decided before a model is paid, in this order: is anything standing,
   * has the grace window closed, has the whole window closed (past which it is better lost than
   * late), is it their night. A person with a leg day on Tuesday costs one query on a Wednesday.
   *
   * Nothing from this pass is ever HELD. A missed-7am nudge arriving on the back of tonight's reply
   * would be a reproach rather than help, so a nudge that could not go out when it mattered is
   * dropped and that occurrence is simply never mentioned. The one thing in Reason that is better
   * lost than late.
   */
  async commitments({ now = clock.now() } = {}) {
    const out = { people: 0, standing: 0, due: 0, turns: 0, nudged: 0, asked: 0, skipped: [] };
    for (const acct of db.listAccountsOfPeople()) {
      if ((acct.state ?? "active") !== "active") continue;
      const c = acct.conversation_id;
      const mine = db.listCommitments(c, { state: "active" });
      if (!mine.length) continue;
      out.people++;
      out.standing += mine.length;

      const { nudges, asks } = commitment.skipsNow({ conversationId: c, now });
      // One at a time. Two commitments missed on one morning is still one text: picking the first
      // and letting the other go is the whole argument of src/notice.js applied to this.
      const row = nudges[0] ?? asks[0];
      if (!row) continue;
      const ask = !nudges[0];
      out.due++;

      // Their own settings, honoured before anything is written down. 'off' and a snooze stop this
      // like they stop everything unprompted — a stop an exception can argue past is not a stop —
      // and their waking window is checked here so a 5am commitment costs no turn at 5am.
      const s = notice.settingsFor(c, { now });
      if (s.mode === "off") { out.skipped.push({ conversation: c, why: s.snoozed ? "snoozed" : "initiative_off" }); continue; }
      const allowed = commitment.mayNudgeNow({ conversationId: c, occurrence: row.occurrence, now });
      if (!allowed.ok) { out.skipped.push({ conversation: c, why: allowed.why }); continue; }
      if (!this.mayInterrupt(c)) { out.skipped.push({ conversation: c, why: "daily_proactive_cap" }); continue; }

      const key = ask
        ? commitment.wrongScheduleKey(row.commitment, row.occurrence.day)
        : commitment.skipKey(row.commitment, row.occurrence.day);
      const written = db.recordNotice(c, {
        kind: ask ? "commitment_schedule" : "commitment_skipped", key,
        // The THING is this occurrence and not the commitment, so the UNIQUE on the table is what
        // makes it one nudge per morning rather than a rule anybody has to remember — and next
        // Tuesday is a different thing rather than a second nudge about this one.
        thing: key,
        what: ask
          ? `${row.commitment.what} has been missed ${row.run.missed + 1} times in a row — the schedule is probably wrong`
          : `${row.commitment.what} was on at ${commitment.clockFace(row.occurrence.atMin)} and the time went past with nothing from them`,
        momentAt: now, at: now,
      });
      if (!written.fresh) { out.skipped.push({ conversation: c, why: "already raised this one" }); continue; }

      out.turns++;
      await this._turn({
        conversationId: c, kind: "event",
        text: ask
          ? commitment.wrongScheduleFrame({ conversationId: c, row })
          : commitment.skipFrame({ conversationId: c, row, now }),
        keep: ask ? undefined : commitment.skipKept({ conversationId: c, row }),
        meta: { fromCommitment: row.commitment.id, occurrence: row.occurrence.day, ...(ask ? { asking: "schedule" } : {}) },
        // Same gate as anything unprompted: a line that skipped `notice_send` is held back by code.
        shouldSend: () => !!db.pendingNotice(c),
      });

      // Read off the row rather than off what the turn returned, and drop it either way. A nudge
      // that did not go out now is not news later.
      const after = db.noticeById(written.id);
      if (after?.said_at) {
        if (ask) out.asked++; else out.nudged++;
        accounts.countUse(c, "proactive");
      } else {
        db.dropNotice(written.id, now);
        this.log({ commitment: row.commitment.id, dropped: key, why: "the turn sent nothing, and a late nudge is worse than none" });
      }
    }
    return out;
  }

  /**
   * "What does this set in motion?" — one turn after something really finished.
   *
   * A flight needs a ride to the airport. The pass is on the sweep rather than hooked into the
   * tools, so a task that finished while the process was down still gets its turn when it comes
   * back up, and nothing in the tool path has to remember to call anything.
   *
   * The offer is held to the same budget and the same gate as a catch: it is a text nobody asked
   * for, and the fact that it follows something good is not a reason to be allowed two.
   */
  async followOn({ now = clock.now() } = {}) {
    const out = { things: 0, turns: 0, offered: 0, skipped: [] };
    for (const acct of db.listAccountsOfPeople()) {
      if ((acct.state ?? "active") !== "active") continue;
      const c = acct.conversation_id;
      const sweep = db.noticeSweep(c);
      const since = sweep?.last_follow_on_at ?? null;
      // First ever run records the mark and raises nothing: everything that ever finished would
      // otherwise arrive at once, which is the opposite of noticing one thing.
      if (since === null) { db.markFollowOnSwept(c, now); continue; }

      const things = [
        ...db.tasksFinishedSince(c, since)
          .filter(t => t.state === "done")
          .map(t => ({ key: `after:task:${t.id}`, what: `"${t.title}" finished: ${t.outcome}` })),
        ...db.plansLockedSince(c, since)
          .map(p => ({ key: `after:plan:${p.id}`, what: `plan #${p.id} "${p.title}" is locked in — ${JSON.stringify({ when: p.when, where: p.where, who: p.who })}` })),
      ];
      db.markFollowOnSwept(c, now);
      if (!things.length) continue;

      // One, not one each. Two offers off the back of one afternoon is the generic-catch failure
      // with better manners, so the newest thing wins and the rest are never raised.
      const thing = things.at(-1);
      out.things++;
      const row = db.recordNotice(c, { kind: "follow_on", key: thing.key, what: thing.what, momentAt: now, at: now });
      if (!row.fresh) continue;

      const s = notice.settingsFor(c, { now });
      const budget = notice.budgetFor(c, { now, timeZone: s.timeZone });
      // An offer is still an unprompted text, so how much initiative they asked for applies to it
      // exactly as it does to a catch. Held rather than dropped: on `digest` it goes in the batch.
      if (!s.mode || !notice.MODES[s.mode].unprompted || budget.spent || !this.mayInterrupt(c)) {
        db.holdNotice(row.id, now);
        out.skipped.push({
          conversation: c,
          why: !notice.MODES[s.mode].unprompted ? (s.mode === "digest" ? "held_for_digest" : s.snoozed ? "snoozed" : "initiative_off")
            : budget.spent ? "budget_spent" : "daily_proactive_cap",
        });
        continue;
      }
      out.turns++;
      await this._turn({
        conversationId: c, kind: "event",
        text: notice.followOnFrame({ conversationId: c, thing: thing.what, key: thing.key, budget }),
        meta: { fromFollowOn: thing.key },
        shouldSend: () => !!db.pendingNotice(c),
      });
      const after = db.noticeById(row.id);
      if (after?.said_at) { out.offered++; accounts.countUse(c, "proactive"); }
      else if (!after?.timer_id) db.holdNotice(row.id, now);
    }
    return out;
  }

  /**
   * Standing check-ins, brought up to date: every active series ends this pass with exactly one
   * firing made and not yet spent.
   *
   * No model and no network — all it does is make timer rows, which the timer pass right after it
   * then fires. Occurrences missed while the process was down collapse to the newest one here, so
   * three shut-laptop Mondays produce one check-in rather than three. See src/series.js.
   */
  series() {
    const made = series.schedule();
    for (const m of made) this.log({ series_scheduled: m.series, timer: m.timer, for: m.at, ...(m.missed ? { missed_while_down: m.missed } : {}) });
    return made;
  }

  async subscriptionWatch({ now = clock.now() } = {}) {
    const DAY = 24 * 60 * 60_000;
    const out = { people: 0, checked: 0, backfilled: 0, renewals: 0, stale: 0, turns: 0, sent: 0, skipped: [] };
    for (const acct of db.listAccountsOfPeople()) {
      if ((acct.state ?? "active") !== "active") continue;
      const c = acct.conversation_id;
      const state = db.subscriptionSweepState(c);
      if (state.lastCheckAt && (now - state.lastCheckAt) < config.subscriptionCheckEveryMs) continue;
      out.people++;

      const filled = subs.backfillRenewalDates(c);
      out.backfilled += filled;

      // Advance past renewals so the next one is always in the future.
      const active = db.listSubscriptions(c, { includeClosed: false });
      for (const row of active) {
        if (!row.next_renewal_at || row.next_renewal_at > now) continue;
        let next = row.next_renewal_at;
        while (next && next <= now) next = subs.advanceRenewal(next, row.cadence);
        if (next) db.setRenewalAt(c, row.id, next);
      }

      db.markSubscriptionChecked(c, now);
      out.checked++;

      // Renewals approaching within the lead window.
      const horizon = now + config.subscriptionRenewalLeadDays * DAY;
      const upcoming = db.renewingSoon(c, horizon);
      if (upcoming.length) {
        out.renewals += upcoming.length;
        const key = `sub_renewal:${c}:${Math.floor(now / DAY)}`;
        const written = db.recordNotice(c, {
          kind: "subscription_renewal", key,
          what: `${upcoming.length} subscription${upcoming.length > 1 ? "s" : ""} renewing soon`,
          momentAt: now, at: now,
        });
        if (written.fresh) {
          const s = notice.settingsFor(c, { now });
          if (s.mode === "off") { out.skipped.push({ conversation: c, why: s.snoozed ? "snoozed" : "initiative_off" }); db.dropNotice(written.id, now); }
          else if (!this.mayInterrupt(c)) { out.skipped.push({ conversation: c, why: "daily_proactive_cap" }); db.holdNotice(written.id, now); }
          else {
            const budget = notice.budgetFor(c, { now, timeZone: s.timeZone });
            out.turns++;
            await this._turn({
              conversationId: c, kind: "event",
              text: notice.subscriptionRenewalFrame({ conversationId: c, renewals: upcoming, key, budget }),
              shouldSend: () => !!db.pendingNotice(c),
            });
            const after = db.noticeById(written.id);
            if (after?.said_at) { out.sent++; accounts.countUse(c, "proactive"); }
            else { db.dropNotice(written.id, now); }
          }
        }
      }

      // Stale scan suggestion.
      const daysSinceLastScan = state.lastScanAt ? Math.floor((now - state.lastScanAt) / DAY) : null;
      if (daysSinceLastScan === null || daysSinceLastScan >= config.subscriptionScanStaleDays) {
        out.stale++;
        const staleKey = `sub_stale:${c}:${Math.floor(now / DAY)}`;
        const written = db.recordNotice(c, {
          kind: "subscription_scan_due", key: staleKey,
          what: daysSinceLastScan != null ? `subscription scan is ${daysSinceLastScan} days old` : "subscriptions have never been scanned",
          momentAt: now, at: now,
        });
        if (written.fresh && !upcoming.length) {
          const s = notice.settingsFor(c, { now });
          if (s.mode === "off") { db.dropNotice(written.id, now); }
          else if (!this.mayInterrupt(c)) { db.holdNotice(written.id, now); }
          else {
            const budget = notice.budgetFor(c, { now, timeZone: s.timeZone });
            out.turns++;
            await this._turn({
              conversationId: c, kind: "event",
              text: notice.subscriptionStaleFrame({ conversationId: c, daysSinceLastScan, key: staleKey, budget }),
              shouldSend: () => !!db.pendingNotice(c),
            });
            const after = db.noticeById(written.id);
            if (after?.said_at) { out.sent++; accounts.countUse(c, "proactive"); }
            else { db.dropNotice(written.id, now); }
          }
        }
      }
    }
    return out;
  }

  /**
   * Calls whose rows still claim to be in progress, settled against the provider.
   *
   * Here rather than in the tool layer because nobody asks for it: the two existing paths both need
   * a trigger (a webhook arriving, or `call_status` being called), and a call that got neither used
   * to stay `in_progress` for ever. The provider the runtime already holds is the one asked.
   */
  async lostCalls({ now = clock.now() } = {}) {
    return settleLostCalls({ now, calls: this.turnExtras?.calls ?? null, log: this.log });
  }

  /** Everything proactive, in one pass: delivery first, then timers, tasks, pages, watches, threads. */
  async sweep() {
    // Stamped before the pass, so the status page reads "is the sweep running" off a clock rather
    // than off whether the interval exists — an interval whose pass is stuck in an await looks
    // exactly like a healthy one otherwise.
    this.lastSweepAt = clock.now();
    // First of all: windows that have run out. A held thing is the only work in here with a
    // promise attached to a stopwatch — they were told "in 30s" — and anything it produces is a
    // message the outbox pass below should carry in the same sweep rather than fifteen seconds
    // later.
    const undone = await this.undo();
    // Before anything that might say something: finish saying the things already owed.
    const outbox = await this.outbox();
    // Then anybody who is actually waiting on an answer right now.
    const held = await this.held();
    // Before the timers fire, so an occurrence that is already due goes out on this pass rather than
    // on the next one fifteen seconds later. It only writes rows; it never says anything.
    const standing = this.series();
    const timers = await this.tick();
    // And again, for anything that just fired. A series must never sit with nothing pending: the
    // kept note on every turn lists the reminders Reason has set, and a gap here would have it
    // telling somebody nothing was coming about a check-in that is still running. Idempotent — a
    // series that already has one armed is skipped — so calling it twice costs one query each.
    standing.push(...this.series());
    const tasks = await this.runTasks();
    const pages = await this.pageAnswers();
    const watches = await this.checkWatches();
    // Calls that still say they are going and are not. It says nothing to anybody — it only stops
    // rows lying about the present — so its place in the order does not matter, but it is before
    // the passes that read state so a call settled now is settled for them.
    const lost_calls = await this.lostCalls();
    // Before the idle-thread pass: a builder that just finished is real news, and raising a dropped
    // thread first would mean asking "still there?" in the same minute something he is waiting on
    // landed. Its own reading half runs whether or not anything earns a text.
    const builds = await this.builders();
    // What finishing something sets in motion, before the watchful sweep: a task that just landed is
    // the freshest thing there is, and offering the ride to the airport matters more than a bill due
    // on Friday. Both spend from the same one-a-day, so the order is the priority.
    // Before both of those: a commitment's window is minutes wide where a bill's is days, and it is
    // the only thing in this sweep that is better dropped than said late. So it gets first refusal.
    const commitments = await this.commitments();
    const subscription_watch = await this.subscriptionWatch();
    const sets_in_motion = await this.followOn();
    const noticed = await this.notice();
    // And the batched line, for anybody who asked for one of those instead. After the sweep, so the
    // things this evening's digest mentions include the ones found a minute ago.
    const digested = await this.digest();
    const follow = await this.followUp();
    const access = await this.accessQueue();
    // Async extraction: pull queued event_log rows, extract facts, embed, rebuild profiles.
    const extracted = await this.extract();
    // What shape the last three weeks had. After everything that might say something, because it
    // says nothing itself and because the one thing it can send — the consent question, once ever —
    // is the least urgent thing in this sweep and should lose to a bill due on Friday.
    const shapes = await this.rhythms();
    // Last, after everything that might still want to read what it is about to drop.
    const retention = this.retention();
    return { undone, outbox, held, standing, timers, tasks, pages, watches, lost_calls, builds, commitments, subscription_watch, sets_in_motion, noticed, digested, follow, access, extracted, shapes, retention };
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
    // And an undo window that was being released when the last process stopped. Same choice, for
    // the same reason: the email may have reached Google with the answer lost on the way back, so
    // it is NOT done again and the person is told in those words.
    undoLib.recoverStranded({ log: this.log });
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
