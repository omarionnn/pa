// Thirty seconds between a yes and the thing actually happening.
//
// Omari's line, 2026-10-06: "hold anything it sends for 30 seconds with an 'undo' text, which takes
// care of the scary emailed-without-asking stories without slowing it down much."
//
// The failure it is for is not a model going rogue — the confirm gate already stops that. It is the
// ordinary one: a yes given in a second and regretted in five, aimed at the wrong person, with the
// wrong date in it, or about a thing they changed their mind on while Reason was already typing. By
// the time the regret arrives the email has landed. Nothing takes that back, so the only place to
// put the out is *before* the send, and thirty seconds is the whole design — long enough to catch
// "wait, wrong Marta", short enough that nobody notices it on the ones they meant.
//
// Three rules hold the shape of it:
//
//   1. **Only things that reach somebody else.** A reply to the person Reason works for goes out at
//      once, at every setting, because the conversation must not get slower. What waits is what
//      lands on a third party: a text to somebody else, an email, an invite other people see, a
//      call. See HOLDS.
//   2. **The window is an out, never a question.** It does not grant anything and it replaces
//      nothing: the confirm gate runs first and unchanged, and the hold starts only once the thing
//      was already allowed to happen. Setting a window to zero therefore loosens nothing — it
//      removes a safety net they were given, not a check they have to pass.
//   3. **One held thing happens at most once.** The hold is a row with a due time, so a restart
//      eleven seconds in neither loses it nor sends it twice; the state machine is in src/db.js and
//      the key it carries goes into the outbox, which has owned "never twice" since the beginning.
//
// Nothing here reads anybody's words. "undo", "stop", "wait, no" and every other way of saying it
// are read by the model, which calls `undo_send` — this file only owns what is held, for how long,
// what Reason says about it, and what happens when the window runs out.
import * as db from "./db.js";
import { clock, config } from "./config.js";
import { UNDO, UNDO_SAYS } from "./verify.js";

const SEC = 1000;

/**
 * What waits, and which window it waits on.
 *
 * Every one of these reaches somebody who is not the person Reason works for, or puts something
 * where other people see it. The kind is what a setting can name: "give me a minute on emails".
 *
 * What is deliberately NOT here, and why, because a list like this is only honest if its holes are
 * stated:
 *
 *   - **Anything addressed to the owner.** Decided per call, not per tool: `message_send` to them
 *     is a reply and goes now; the same tool to Kofi waits. A calendar event with nobody on it but
 *     them is the same thing and is not held either. See `holdFor` in src/tools.js.
 *   - **browser_submit and subscription_cancel_commit.** These press a button on a page that is
 *     open right now, inside a session with a cart, a held seat or a timed checkout in it. Pausing
 *     thirty seconds there is not free — it can lose the thing it was about to buy — and Omari's own
 *     framing was "where the service lets it be deferred". These do not. They keep the gate, which
 *     is the ask BEFORE the click, and they are shown as un-undoable in the answer the gate gives.
 *   - **gmail_archive, gmail_label, gmail_mark and the rest.** They touch the person's own mailbox
 *     and nobody else's, and nothing they do is hard to put back.
 *   - **gmail_trash**, which is the interesting exemption — and the one `drive_trash` below knowingly
 *     breaks from. Gmail's own Trash is a better undo than thirty seconds, and that is still true, so
 *     a binned email is not held. A binned Drive file is, and the difference is what is in the bin:
 *     an email is usually a copy of something somebody else also has, and the thing people keep in
 *     Drive is often the only copy of work they did once. Both have the gate in front of them and
 *     Google's 30-day bin behind them; the thirty seconds in the middle costs nothing here, because
 *     neither tool is ever the reply to a message.
 *   - **admin_delete and remote_approve.** The master's own machine, with somebody on the other end
 *     waiting on the answer.
 */
export const HOLDS = {
  message_send: "text",
  voice_note_send: "text",
  // A document going to somebody who is not the owner is a file leaving with their name on it, and
  // it is the hardest thing on this list to take back once it has landed — so it waits exactly as a
  // text does. A document into the owner's own thread is never held, for the same reason a reply is
  // not: that thread must not go quiet for thirty seconds.
  document_send: "text",
  gmail_send: "email",
  calendar_create: "calendar",
  calendar_change: "calendar",
  calendar_delete: "calendar",
  call_place: "call",
  // Their Drive, added 2026-10-07 with the organising tools. Both are decided per call in
  // src/tools.js rather than per tool: a `drive_share` that hands the OWNER a link they already have
  // reaches nobody and is not held. Neither is a rename or a move — visible, cheap, and undone by
  // saying so. What waits is the two that are not: a file going in the bin, and another person being
  // given access to somebody's document, which Google emails them about.
  drive_trash: "drive",
  drive_share: "drive",
};

export const KINDS = ["text", "email", "calendar", "call", "drive"];

/** Plain words for a kind, for the line that says a setting back to them. */
const KIND_WORDS = { text: "texts", email: "emails", calendar: "calendar changes", call: "calls", drive: "drive changes" };

/**
 * How long this conversation holds a thing of this kind, in milliseconds.
 *
 * Their per-kind answer, then their overall one, then the install's thirty seconds. Clamped to
 * 0–300s here rather than at the setter as well, so a row written by an older build or edited by
 * hand cannot produce a five-hour hold.
 */
export function windowMsFor(conversationId, kind) {
  const prefs = db.undoPrefs(conversationId);
  const chosen = prefs.byKind?.[kind] ?? prefs.seconds ?? config.undoWindowSeconds;
  return clampSeconds(chosen) * SEC;
}

export function clampSeconds(n) {
  const s = Number(n);
  if (!Number.isFinite(s)) return config.undoWindowSeconds;
  return Math.max(0, Math.min(config.undoWindowMaxSeconds, Math.round(s)));
}

/**
 * Their setting, said back in the words they would use.
 *
 * `set` is false when nobody has ever changed it, which is a different sentence from somebody
 * having chosen thirty.
 */
export function windowSettings(conversationId) {
  const prefs = db.undoPrefs(conversationId);
  const overall = clampSeconds(prefs.seconds ?? config.undoWindowSeconds);
  const byKind = Object.fromEntries(KINDS
    .filter(k => prefs.byKind?.[k] !== undefined && prefs.byKind?.[k] !== null)
    .map(k => [k, clampSeconds(prefs.byKind[k])]));
  return { seconds: overall, by_kind: byKind, set: prefs.seconds !== null || !!Object.keys(byKind).length, default_seconds: config.undoWindowSeconds };
}

/** One line saying what the window is now. Code's words, so a setting cannot be reported wrong. */
export function settingLine({ seconds, kind = null }) {
  const what = kind ? KIND_WORDS[kind] ?? kind : "anything i send for you";
  if (seconds === 0) return kind ? `no undo window on ${what} any more — they go the second you say go` : `no undo window — things go the second you say go`;
  const unit = seconds === 60 ? "a minute" : seconds % 60 === 0 && seconds > 60 ? `${seconds / 60} minutes` : `${seconds}s`;
  return kind ? `${unit} to undo on ${what} now` : `${unit} to undo on ${what} now`;
}

/**
 * Who a thing is going to, in a word somebody would recognise.
 *
 * An address or a number IS the exact recipient and is never wrong, so it is the fallback. A name
 * is only used when this person has actually written that contact down against a name, which is
 * the one case where Reason knows it rather than guesses it — the whole value of the line is that
 * they can check it at a glance, and a name attached to the wrong number would be the one way this
 * feature could make things worse.
 */
export function nameFor(conversationId, address) {
  const a = String(address ?? "").trim();
  if (!a) return "";
  for (const p of db.listImportantPeople(conversationId)) {
    if ((p.contacts ?? []).some(c => String(c).trim().toLowerCase() === a.toLowerCase())) return p.who;
  }
  return a;
}

const quote = (s, n = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * What a held thing is, in the words the line to them uses.
 *
 * `doing` is the whole clause — "sending the email 'Lease renewal' to marta@…" — because the
 * preposition differs per action and "to" in front of a calendar is wrong. `toWhom` is kept
 * separately for the line that says it was stopped.
 */
export function describe({ action, input, conversationId, to = null }) {
  const kind = HOLDS[action];
  switch (action) {
    case "message_send": {
      const who = nameFor(conversationId, to ?? input.to);
      return { kind, toWhom: who, what: `"${quote(input.text)}"`, doing: `sending "${quote(input.text)}" to ${who}` };
    }
    case "voice_note_send": {
      const who = nameFor(conversationId, to ?? input.to);
      return { kind, toWhom: who, what: "the voice note", doing: `sending the voice note to ${who}` };
    }
    case "document_send": {
      const who = nameFor(conversationId, to ?? input.to);
      // The document's own title, read off the row rather than off the tool call: what the owner is
      // told is about to leave has to be the file that is really about to leave.
      const doc = db.getDocumentIn(conversationId, input.document_id);
      const what = doc ? `"${quote(doc.title)}"` : "that document";
      return { kind, toWhom: who, what, doing: `sending ${what} to ${who}` };
    }
    case "gmail_send": {
      const who = [].concat(input.to ?? []).join(", ");
      const subject = input.subject ? `"${quote(input.subject)}"` : "the email";
      return { kind, toWhom: who, what: `the email ${subject}`, doing: `sending the email ${subject} to ${who}` };
    }
    case "calendar_create": {
      const who = [].concat(input.attendees ?? []).join(", ");
      const title = input.summary ? `"${quote(input.summary)}"` : "that event";
      return { kind, toWhom: who, what: title, doing: `putting ${title} on the calendar${who ? ` with ${who}` : ""}` };
    }
    case "calendar_change": {
      const who = [].concat(input.attendees ?? []).join(", ");
      const title = input.summary ? `"${quote(input.summary)}"` : "that event";
      return { kind, toWhom: who, what: title, doing: `changing ${title}${who ? `, which ${who} will see` : ""}` };
    }
    case "calendar_delete": {
      const title = input.summary ? `"${quote(input.summary)}"` : "that event";
      return { kind, toWhom: "", what: title, doing: `deleting ${title} off the calendar` };
    }
    case "call_place": {
      const who = nameFor(conversationId, to ?? input.to);
      return { kind, toWhom: who, what: "that call", doing: `calling ${who}` };
    }
    // Their Drive. The NAME of the file and not its id, because the whole point of the line is that
    // they can check it at a glance — and "putting 1BxiMV… in the bin" is unreadable. The name comes
    // off the handler, which read it from Google a moment earlier, not from anything the model typed.
    case "drive_trash": {
      const what = input.what || "that file";
      return { kind, toWhom: "", what, doing: `putting ${what} in your drive bin` };
    }
    case "drive_share": {
      const who = String(input.with_email ?? "").trim();
      const what = input.what || "that file";
      const how = input.role === "writer" ? "edit" : "view";
      return { kind, toWhom: who, what, doing: `giving ${who} ${how} access to ${what}` };
    }
    default:
      return { kind: kind ?? "text", toWhom: String(to ?? ""), what: action, doing: `doing ${action}` };
  }
}

/**
 * The line that starts the window. One sentence, their voice, the real recipient in it.
 *
 *   sending the lease email to Marta in 30s — text "undo" to stop it
 *
 * Written here rather than left to the model for the same reason the delivery-failure line is: it
 * is a statement about Reason's own plumbing, it has to be identical every time so the word "undo"
 * is learnable, and a model improvising it is a model that will one day write "sending a message".
 */
export function holdLine({ doing, seconds }) {
  return `${doing} in ${seconds}s — text "undo" to stop it`;
}

/** The line back when they catch it in time. */
export function stoppedLine({ toWhom, what }) {
  return toWhom ? `stopped, nothing went to ${toWhom}` : `stopped, ${what} didn't happen`;
}

/**
 * The honest line when the window has already run out.
 *
 * It already went, and the only useful thing left to say is whether there is a real way back —
 * which is `UNDO` in src/verify.js, the same table the confirm gate quotes, so the two can never
 * say different things about the same action.
 */
export function tooLateLine(row) {
  const undo = UNDO[row.action] ?? "hard";
  const went = row.to_whom ? `that already went to ${row.to_whom}` : `${row.what} already happened`;
  if (undo === "no") return `${went} — ${UNDO_SAYS.no}. want me to send a follow-up?`;
  if (undo === "hard") return `${went} — ${UNDO_SAYS.hard}. want me to start that?`;
  return `${went}, but ${UNDO_SAYS.easy} — want me to put it back?`;
}

/** Seconds left on a window, never below zero. */
export function secondsLeft(row, now = clock.now()) {
  return Math.max(0, Math.ceil((row.due_at - now) / SEC));
}

/**
 * What is held right now, for the turn the model is about to take.
 *
 * Turn-only, like the open-work note: it is a fact about this second, and a copy of it sitting in
 * the thread's history would go on describing something that went out five minutes ago. It is the
 * only reason the model can act on "undo" at all — reading the word is its job, knowing there is
 * something to undo is this.
 */
export function heldNote(conversationId, { now = clock.now() } = {}) {
  const live = db.liveHolds(conversationId);
  if (!live.length) return "";
  const rows = live.map(r => ({ held_id: r.id, going_out_in: `${secondsLeft(r, now)}s`, what: r.doing ?? r.what, to: r.to_whom || undefined, action: r.action }));
  return `held, not yet gone: ${JSON.stringify(rows)}.`
    + ` If anything they just said means stop — "undo", "no", "wait", "don't", "cancel that", or the same thing in their own words —`
    + ` call undo_send NOW, before you write anything. The newest one is what a bare "undo" means; if they named which, pass that held_id.`
    + ` "undo the email, keep the text" is two things: stop the one they named and leave the other alone.`
    + ` Do not mention the window again on your own — they have already been told once.`;
}

/**
 * Holds that died on release, as a fact at the top of the next turn.
 *
 * Same bargain as a lost reply: Reason must not carry on as though the email went. Code's words,
 * because what broke is the model's plumbing.
 */
export function failedNote(rows) {
  if (!rows.length) return "";
  const lines = rows.map(r => `  - ${r.doing ?? r.what}${r.to_whom ? ` (to ${r.to_whom})` : ""} — ${r.last_error}`);
  return `[held action failed] the undo window ran out and ${rows.length === 1 ? "this did not go" : "these did not go"}:\n${lines.join("\n")}\n`
    + `Nobody got it. Say so in one short line and say what you are doing instead; do not talk as though it landed.`;
}

/** The line the owner gets about a held thing that never happened, when no turn is coming. */
export function failureLine(row) {
  const unknown = row.state === "unknown";
  return unknown
    ? `heads up — i stopped mid-way through ${row.doing ?? row.what}, so i genuinely don't know whether it went. i'm NOT doing it again in case it did. worth a check.`
    : `heads up — ${row.doing ?? row.what} didn't actually go. ${row.last_error} nothing more is going to it from me. want me to try again?`;
}

/**
 * Windows that have run out, carried out.
 *
 * `run` is injected rather than imported so this file never reaches into the tool dispatch, which
 * is what imports this one. It is handed the claimed row and returns the tool's own result.
 *
 * Claim first, then do, always. A row is 'going' before anything leaves, so an undo arriving in the
 * same millisecond loses cleanly and is told the truth rather than being told "stopped" about
 * something already in flight.
 */
export async function pass({ run, now = clock.now(), log = () => {} } = {}) {
  const out = { due: 0, sent: 0, failed: 0 };
  if (typeof run !== "function") return out;
  for (const row of db.dueHolds(now)) {
    const claimed = db.claimHold(row.id);
    // Somebody stopped it, or another sweep has it. Either way it is not ours.
    if (!claimed) continue;
    out.due++;
    let result;
    try { result = await run(claimed); }
    catch (e) { result = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }

    // `queued` is the outbox still trying, which is neither done nor dead — the row is 'sent' here
    // because the hold's job is over: the thing was handed on, and the outbox tells somebody if it
    // never arrives. Re-releasing it would be the one way to send it twice.
    if (result?.ok || result?.queued) {
      db.markHoldSent(row.id, result);
      out.sent++;
      log({ held: row.id, went: row.action, to: row.to_whom, after_ms: row.hold_ms });
    } else {
      db.markHoldFailed(row.id, { error: result?.error ?? "it did not go, and nothing said why", result });
      out.failed++;
      log({ held: row.id, failed: row.action, why: result?.error ?? "no reason given" });
    }
  }
  return out;
}

/**
 * Rows that were mid-release when the last process stopped.
 *
 * Nothing is re-run. A 'going' row may have reached Gmail or Sendblue with the answer lost on the
 * way back, and this is the same choice the outbox makes in the same situation: losing one thing
 * loudly beats doing it twice quietly. The row goes to 'unknown' and the owner is told in those
 * words.
 */
export function recoverStranded({ log = () => {} } = {}) {
  const rows = db.strandedHolds();
  for (const row of rows) {
    db.markHoldUnknown(row.id, {
      error: "the process stopped while this was being carried out, so whether it happened is not known — it was NOT done again",
    });
  }
  if (rows.length) log({ held_stranded: rows.map(r => r.id), note: "not retried: nobody can say whether they went" });
  return rows.map(r => r.id);
}
