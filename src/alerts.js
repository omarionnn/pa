// The four catches that are about something being WRONG, rather than about something being new.
//
// src/notice.js already goes and looks: it diffs their calendar, it pulls the unread mail a person
// sent, and it hands the model at most one thing with a budget and a gate around it. None of that
// changes here. What this file adds is four candidates that the diff cannot produce, because each
// one is a disagreement between two sources rather than a change in one:
//
//   calendar_stale   The use-case card, word for word: "the meeting moved to 3. your calendar still
//                    says 2. want me to update it?" A diff of the calendar against itself can never
//                    find this — the calendar is the thing that is wrong. What code can find is the
//                    DISAGREEMENT: somebody on the meeting wrote after the invite was last touched,
//                    and the invite has not moved since. Whether that mail really names a new time
//                    is the model's to read, out of the thread, and it is told to read it.
//   awaiting_reply   A reply THEY are waiting on. The existing mail catch is the other direction —
//                    unread mail somebody sent them — and the two are not the same worry at all.
//                    This one is: you asked, nobody answered, and it has been two days.
//   deadline_near    An all-day thing on their calendar coming up: rent, taxes, a renewal, a
//                    deadline. Never NEW, so the diff never raises it, and the day before is
//                    exactly when it is worth a line.
//   meeting_prep     A meeting in the next day with people on it, and the brief offered before it
//                    rather than after. `meeting_new_person` already covers somebody they have
//                    never written to; this is the other case, where there IS history and the
//                    useful thing is two lines on what was said last time.
//
// Three rules hold across all four, and they are the reason this is a separate file rather than
// four more branches in `gather`:
//
//   1. **Every one is grounded in a source.** `source` on the candidate names the thread or the
//      event it came off, and the frame tells the model to read it before saying a time, a date or
//      an amount. Nothing in here parses a time out of anybody's mail: code finds the disagreement,
//      the model reads the words.
//   2. **Every one is checked again before it is spoken.** `recheck` is the same contract
//      src/notice.js uses — `handled`, `unclear`, or neither — and these four are the kinds most
//      likely to have been dealt with in between, because all four are about something the person
//      is already in the middle of.
//   3. **Every one is an OFFER.** "Want me to update it?" is the whole catch. Nothing here moves an
//      event, sends a chase or writes a brief on its own; the gate and the confirmation path are
//      exactly what they were.
//
// There is no regex over anything the person said anywhere in here. The Gmail queries are Gmail's
// own search operators, and the only reading of their own mail is `in:sent` as a list of threads —
// which is finding out whether anybody replied, not reading intent.
import * as google from "./google.js";
import { clock, config, stamp } from "./config.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * The four kinds, in the shape src/notice.js's KINDS takes, merged into it there.
 *
 * All four are speakable: each one is a thing worth one line and an offer, and none of them has
 * another pass that would report it better.
 */
export const KINDS = {
  calendar_stale: { what: "somebody on a meeting wrote after the invite was last touched — the calendar may be out of date", speakable: true },
  awaiting_reply: { what: "they asked somebody something and nobody has replied", speakable: true },
  deadline_near: { what: "a dated thing on their calendar is coming up", speakable: true },
  meeting_prep: { what: "a meeting soon with people they have history with — the brief goes before it", speakable: true },
};

/**
 * What the model is told about these four, on top of the ordinary sweep rules.
 *
 * Phrased as refusals, because every one of them is a way the catch could be worse than silence: a
 * time said without reading the thread, a calendar changed without asking, a chase written as
 * though it were them, a brief recited at somebody walking into a meeting.
 */
export const ALERT_RULES =
  `Four of the things above are about something being WRONG rather than something being new, and each one has to be`
  + ` grounded in the source named on it before you say a word of it:`
  + `\n  - A meeting whose invite may be out of date: READ THE THREAD FIRST (gmail_read with the thread on the`
  + ` candidate). Code noticed that somebody on the meeting wrote after the invite was last touched and nothing more`
  + ` than that — it does NOT know the time changed. If the thread really names a new time, the line is the card:`
  + ` "the meeting moved to 3, your calendar still says 2 — want me to update it?" — the old time, the new time, and`
  + ` the offer. Then it is calendar_change on their yes and never without one. If the thread is about something else`
  + ` entirely, that is the common case: say nothing at all.`
  + `\n  - A reply they are waiting on: say who and how long, and offer the one thing that helps ("kofi never came back`
  + ` on the lease — want me to chase him?"). A chase is an email to somebody else, so it goes through the gate with`
  + ` the whole body said back first, and it is written as their assistant and never as them.`
  + `\n  - A dated thing coming up: the date is on the candidate, off their own calendar. Say the thing and the day and`
  + ` offer the next step. Never invent an amount, a late fee or a consequence — none of that is on a calendar entry.`
  + `\n  - A meeting soon: the catch is the OFFER of a brief in one line, never the brief. A brief is a paragraph and`
  + ` belongs on a turn they started. meeting_brief writes it, and only if they say yes.`;

// ---------- 1. the calendar that may be out of date ----------

/**
 * Upcoming events whose invite was last touched BEFORE somebody on them wrote.
 *
 * Pure, and deliberately: this is the one catch in the feature that could go badly wrong by
 * claiming a time, so the whole of what code decides about it is checkable without a calendar or a
 * mailbox in sight.
 *
 * `events` is the live calendar read, `mail` is the unread mail src/notice.js already has in hand
 * for this sweep — so this costs no API call at all. `moved` is the ids the calendar diff is
 * already raising this sweep: an event that really did move is `calendar_moved`'s to report, and
 * raising both would be telling somebody the same thing twice in two different words.
 */
export function staleCandidates({ events = [], mail = [], mine = new Set(), moved = new Set(), now = clock.now(), horizonMs = config.alertStaleHours * HOUR }) {
  const out = [];
  for (const e of events) {
    const startsAt = Date.parse(e.start || "");
    if (!Number.isFinite(startsAt) || startsAt <= now || startsAt - now > horizonMs) continue;
    if (/^cancelled$/i.test(e.status ?? "")) continue;
    if (moved.has(`${e.account}:${e.id}`)) continue;
    const touched = Date.parse(e.updated || "");
    // An event with no `updated` on it cannot be compared against anything, and guessing would mean
    // raising every meeting anybody emailed about. Nothing is raised rather than something unfounded.
    if (!Number.isFinite(touched)) continue;
    const who = new Set((e.attendees ?? []).map(a => String(a.email ?? "").toLowerCase()).filter(x => x && !mine.has(x)));
    if (!who.size) continue;

    for (const m of mail) {
      if (m.account !== e.account) continue;
      const from = String(m.from ?? "").toLowerCase();
      if (!who.has(from)) continue;
      const wrote = Date.parse(m.date || "");
      if (!Number.isFinite(wrote) || wrote <= touched) continue;
      out.push({
        kind: "calendar_stale",
        // The state is the pair: this invite as it stands now, and this message. The invite moving
        // makes a new key (so the stale version is finished with) and so does a newer message.
        key: `stale:${e.account}:${e.id}@${e.updated}:${m.thread_id}`,
        thing: `cal:${e.account}:${e.id}`,
        what: `"${e.summary || "(no title)"}" is on their calendar at ${e.start}, and ${m.from_name || from} wrote`
          + ` "${m.subject || "(no subject)"}" after the invite was last touched (${stamp(wrote)} vs ${stamp(touched)})`,
        detail: `read thread ${m.thread_id} in ${e.account} (gmail_read) before you say anything: code does NOT know the`
          + ` time changed, only that the mail is newer than the invite. If it really names a new time, say the old one,`
          + ` the new one and offer to update it (calendar_change on their yes). If it is about something else, say nothing.`,
        source: `calendar event ${e.id} in ${e.account} (last touched ${stamp(touched)}) against gmail thread ${m.thread_id}`,
        account: e.account, event_id: e.id, thread_id: m.thread_id,
        // No `starts`: a calendar that is wrong is worth knowing NOW, not two hours before the
        // meeting it is wrong about. See momentFor in src/notice.js.
        state: `${e.start}|${m.thread_id}`,
        calendar_says: e.start, invite_touched: stamp(touched), wrote_at: stamp(wrote), who: from,
      });
      break;   // One per event. Three colleagues on one thread is one thing to look at.
    }
  }
  return out;
}

// ---------- 2. a reply they are waiting on ----------

/**
 * Mail they sent and nobody answered, as the Gmail query.
 *
 * Their own sent mail, which is the one place in the whole watchful sweep that reads something they
 * wrote — and it reads it as a LIST of threads to check for an answer, never for what it says. The
 * window is bounded both ways: older than the wait so nothing is chased the same afternoon, newer
 * than a fortnight so a thread from March is not raised as though it were live.
 */
export const sentQuery = ({ waitHours = config.alertAwaitingHours, days = config.alertAwaitingDays } = {}) =>
  `in:sent -in:chats newer_than:${days}d older_than:${Math.max(1, Math.round(waitHours / 24))}d`;

/**
 * Threads where the newest message is still theirs.
 *
 * One list read per account and then one thread read per candidate, bounded hard — an unbounded
 * version of this would be a mailbox probe per sent message, which is both slow and a far more
 * invasive read than the catch is worth. Past the bound nothing is raised rather than guessed.
 */
export async function awaitingCandidates({ live = [], api, mine = new Set(), now = clock.now(), probes = 0, failed = [], log = () => {} }) {
  const out = [];
  let used = probes;
  const cap = Number(config.alertAwaitingProbes ?? 4);
  for (const a of live) {
    if (used >= cap) break;
    const list = await api(a, "GET", "/gmail/v1/users/me/messages", { query: { q: sentQuery(), maxResults: 10 } });
    if (!list.ok) { failed.push({ account: a.account, what: "sent_mail", error: list.error }); continue; }
    const seenThread = new Set();
    for (const m of list.body?.messages ?? []) {
      if (used >= cap) break;
      const one = await api(a, "GET", `/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`, {
        query: { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] },
      });
      if (!one.ok) continue;
      const view = google.messageBrief(one.body);
      if (!view?.thread_id || seenThread.has(view.thread_id)) continue;
      seenThread.add(view.thread_id);
      const to = String(view.to ?? "");
      const first = addressesOf(to).find(x => x && !mine.has(x));
      // No recipient outside their own accounts: a note to themselves is not a reply they are owed.
      if (!first) continue;
      if (google.isNoReply(first)) continue;

      used++;
      const thread = await api(a, "GET", `/gmail/v1/users/me/threads/${encodeURIComponent(view.thread_id)}`, {
        query: { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] },
      });
      // A probe that failed is not evidence nobody replied, so nothing is raised off it.
      if (!thread.ok) { failed.push({ account: a.account, what: "thread", error: thread.error }); continue; }
      const msgs = (thread.body?.messages ?? []).map(x => google.messageBrief(x)).filter(Boolean);
      const last = msgs.at(-1);
      const lastFrom = addressOf(last?.from ?? "");
      // Somebody answered. Nothing to raise, and this is the common case.
      if (!lastFrom || !mine.has(lastFrom)) continue;
      const sentAt = Date.parse(last?.date || view.date || "");
      if (!Number.isFinite(sentAt)) continue;
      const waited = now - sentAt;
      if (waited < config.alertAwaitingHours * HOUR) continue;
      const days = Math.floor(waited / (24 * HOUR));
      const age = days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : `${Math.round(waited / HOUR)}h`;
      out.push({
        kind: "awaiting_reply",
        // The state is how long it has been waiting, in whole days, so another day with no answer is
        // a new candidate — and the `thing` is the thread, so one nudge per thread still holds.
        key: `awaiting:${a.account}:${view.thread_id}@${days}d`,
        thing: `awaiting:${a.account}:${view.thread_id}`,
        what: `they emailed ${first} "${view.subject || "(no subject)"}" ${age} ago and nobody has replied`,
        detail: `thread ${view.thread_id} in ${a.account}: read it (gmail_read) before you say what they asked for.`
          + ` Offer the one thing that helps — chasing it — and a chase is an email to somebody else, so it needs their`
          + ` yes and goes out as their assistant, never as them.`,
        source: `gmail thread ${view.thread_id} in ${a.account}, their own message of ${stamp(sentAt)}`,
        account: a.account, thread_id: view.thread_id, who: first, state: String(days),
      });
    }
  }
  if (out.length) log({ alerts: "awaiting_reply", found: out.length });
  return { candidates: out, probes: used };
}

/** Every address on a header, lowercased. A To line is often several people. */
export function addressesOf(header) {
  return String(header ?? "").split(",").map(part => addressOf(part)).filter(Boolean);
}

/** One address, out of "Name <a@b.c>" or a bare address. Same rule as src/notice.js. */
export function addressOf(header) {
  const s = String(header ?? "").trim();
  const inAngles = s.slice(s.indexOf("<") + 1, s.indexOf(">"));
  const picked = s.includes("<") && s.includes(">") ? inAngles : s;
  return picked.trim().toLowerCase();
}

// ---------- 3. a dated thing coming up ----------

/**
 * All-day entries on their calendar inside the deadline window.
 *
 * Pure, and no API call: the events are already in hand. An all-day entry is the shape a deadline
 * takes on a calendar — rent, a renewal, taxes, a filing — and because it is not NEW the ordinary
 * diff never raises it, which is exactly the gap. Nothing here reads the title for what KIND of
 * thing it is: a dated thing a day out is worth one line whatever it is called.
 *
 * No `starts` on the candidate, deliberately. "Two hours before" an all-day entry is the middle of
 * the night before it, and a deadline is useful with a day's notice rather than at one in the
 * morning. So the moment is now, and the window is what decides whether now is the right time.
 */
export function deadlineCandidates({ events = [], now = clock.now(), raised = new Set(), horizonMs = config.alertDeadlineHours * HOUR }) {
  const out = [];
  for (const e of events) {
    if (!e.all_day) continue;
    if (/^cancelled$/i.test(e.status ?? "")) continue;
    if (raised.has(`${e.account}:${e.id}`)) continue;
    const startsAt = Date.parse(e.start || "");
    if (!Number.isFinite(startsAt)) continue;
    // Already begun, or too far off to be useful.
    if (startsAt <= now - 24 * HOUR || startsAt - now > horizonMs) continue;
    const hours = Math.round((startsAt - now) / HOUR);
    const when = hours <= 0 ? "today" : hours < 36 ? "tomorrow" : `in ${Math.round(hours / 24)} days`;
    out.push({
      kind: "deadline_near",
      key: `deadline:${e.account}:${e.id}@${e.start}`,
      thing: `deadline:${e.account}:${e.id}`,
      what: `"${e.summary || "(no title)"}" is on their calendar for ${e.start} — ${when}`,
      detail: `it is an all-day entry on their own calendar, so the DATE is a fact and nothing else is: never say an`
        + ` amount, a fee or what happens if it is missed unless you have read that somewhere this turn.`
        + ` Offer the next step in one line.`,
      source: `calendar event ${e.id} in ${e.account} (all-day, ${e.start})`,
      account: e.account, event_id: e.id, state: String(e.start),
    });
  }
  return out;
}

// ---------- 4. the brief, before the meeting ----------

/**
 * Meetings inside the brief window with somebody on them.
 *
 * The counterpart to `meeting_new_person` and deliberately the other half of it: that one is for
 * somebody they have never written to, and this is for the meeting where there IS history and the
 * useful thing is what was said last time. `skip` is the ids that pass is already raising, so one
 * meeting never produces two candidates.
 *
 * `starts` IS on this one — a brief is worth having before the meeting and useless after it, so the
 * moment code picks (two hours before) is exactly right, and the sweep that finds it stays quiet.
 */
export function prepCandidates({ events = [], mine = new Set(), now = clock.now(), skip = new Set(), horizonMs = config.alertBriefHours * HOUR }) {
  const out = [];
  for (const e of events) {
    if (e.all_day) continue;
    if (/^cancelled$/i.test(e.status ?? "")) continue;
    if (skip.has(`${e.account}:${e.id}`)) continue;
    const startsAt = Date.parse(e.start || "");
    if (!Number.isFinite(startsAt) || startsAt <= now || startsAt - now > horizonMs) continue;
    const others = (e.attendees ?? []).map(a => String(a.email ?? "").toLowerCase()).filter(x => x && !mine.has(x));
    if (!others.length) continue;
    out.push({
      kind: "meeting_prep",
      key: `prep:${e.account}:${e.id}@${e.start}`,
      thing: `prep:${e.account}:${e.id}`,
      what: `"${e.summary || "(no title)"}" is at ${e.start} with ${others.slice(0, 3).join(", ")}`
        + `${others.length > 3 ? ` and ${others.length - 3} more` : ""}`,
      detail: `offer a brief in ONE line and nothing more — "want two lines on where you left it with ${others[0]}`
        + ` before the ${e.summary ? `${e.summary} ` : ""}meeting?". meeting_brief writes it, and only on their yes.`
        + ` Never the brief itself unprompted: a paragraph belongs on a turn they started.`,
      source: `calendar event ${e.id} in ${e.account} (${e.start})`,
      starts: e.start, account: e.account, event_id: e.id, who: others[0], state: String(e.start),
    });
  }
  return out;
}

// ---------- all four, for one person ----------

/**
 * The four candidates, gathered on top of what src/notice.js already has in hand.
 *
 * Everything except `awaiting_reply` is computed from the events and the mail the sweep has already
 * read, so three of the four cost nothing. The fourth is bounded by `alertAwaitingProbes`.
 */
export async function gather({ live = [], api, events = [], mail = [], mine = new Set(), moved = new Set(), briefed = new Set(), now = clock.now(), probes = 0, log = () => {} }) {
  const failed = [];
  const candidates = [];

  candidates.push(...staleCandidates({ events, mail, mine, moved, now }));
  candidates.push(...deadlineCandidates({ events, now, raised: moved }));
  // Two exclusions and they are different facts. `moved` is what the calendar diff is already
  // reporting, so the meeting is already being talked about. `briefed` is the meetings whose brief
  // src/notice.js is already offering, because somebody on them is new — offering a second brief
  // for the same meeting would be two lines about one thing.
  candidates.push(...prepCandidates({ events, mine, now, skip: new Set([...moved, ...briefed]) }));

  const awaiting = await awaitingCandidates({ live, api, mine, now, probes, failed, log });
  candidates.push(...awaiting.candidates);

  return { candidates, failed, probes: awaiting.probes };
}

// ---------- have they already handled it? ----------

/** Which kinds this file answers for. src/notice.js delegates on these and nothing else. */
export const MINE = new Set(Object.keys(KINDS));

/**
 * The same contract src/notice.js's `recheck` has: `handled`, `unclear`, or neither.
 *
 * All four of these are about something the person is in the middle of, so "they dealt with it" is
 * the likeliest outcome of any of them — which makes this the half of the feature that decides
 * whether it feels like being watched over or being nagged.
 */
export async function recheck({ row, acct, api, mine = new Set(), now = clock.now() }) {
  const kind = row?.kind ?? "";

  if (kind === "calendar_stale") {
    if (!row.event_id) return { ok: true };
    const got = await api(acct, "GET", `/calendar/v3/calendars/primary/events/${encodeURIComponent(row.event_id)}`, {});
    if (!got.ok) {
      return got.status === 404
        ? { handled: "that event is no longer on their calendar" }
        : { unclear: `their calendar would not answer about that event (${got.error ?? got.status})` };
    }
    const live = google.eventView(got.body, { timeZone: acct?.timeZone ?? "" });
    if (/^cancelled$/i.test(live.status ?? "")) return { handled: "that meeting has since been cancelled" };
    const [wasStart] = String(row.state ?? "").split("|");
    // They fixed it themselves. The whole catch was that the calendar disagreed with the mail, and
    // a calendar that has since been changed is the disagreement being over.
    if (wasStart && String(live.start) !== wasStart) {
      return { handled: `their calendar has been updated since (it now says ${live.start})` };
    }
    // And if they have replied in the thread, they have read it and dealt with it their own way.
    if (row.thread_id) {
      const thread = await api(acct, "GET", `/gmail/v1/users/me/threads/${encodeURIComponent(row.thread_id)}`, {
        query: { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] },
      });
      if (thread.ok) {
        const msgs = (thread.body?.messages ?? []).map(m => google.messageBrief(m)).filter(Boolean);
        const last = addressOf(msgs.at(-1)?.from ?? "");
        if (last && mine.has(last)) return { handled: "they have already replied in that thread" };
      } else if (thread.status === 404) {
        return { handled: "that thread is no longer in their mailbox" };
      } else {
        return { unclear: `their mailbox would not answer about that thread (${thread.error ?? thread.status})` };
      }
    }
    return { ok: true };
  }

  if (kind === "awaiting_reply") {
    if (!row.thread_id) return { ok: true };
    const got = await api(acct, "GET", `/gmail/v1/users/me/threads/${encodeURIComponent(row.thread_id)}`, {
      query: { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] },
    });
    if (!got.ok) {
      return got.status === 404
        ? { handled: "that thread is no longer in their mailbox" }
        : { unclear: `their mailbox would not answer about that thread (${got.error ?? got.status})` };
    }
    const msgs = (got.body?.messages ?? []).map(m => google.messageBrief(m)).filter(Boolean);
    const last = addressOf(msgs.at(-1)?.from ?? "");
    // Somebody answered. That is the whole thing resolved, and saying it now would be telling them
    // nobody has replied to a mail that is sitting answered in their inbox.
    if (last && !mine.has(last)) return { handled: "somebody has replied in that thread since" };
    return { ok: true };
  }

  if (kind === "deadline_near" || kind === "meeting_prep") {
    if (!row.event_id) return { ok: true };
    const got = await api(acct, "GET", `/calendar/v3/calendars/primary/events/${encodeURIComponent(row.event_id)}`, {});
    if (!got.ok) {
      return got.status === 404
        ? { handled: "that is no longer on their calendar" }
        : { unclear: `their calendar would not answer about that one (${got.error ?? got.status})` };
    }
    const live = google.eventView(got.body, { timeZone: acct?.timeZone ?? "" });
    if (/^cancelled$/i.test(live.status ?? "")) return { handled: "it has since been cancelled" };
    if (row.state && String(live.start) !== String(row.state)) {
      return { handled: `it has moved since (it now says ${live.start}) — the next look raises that as its own thing` };
    }
    // A meeting that has already started needs no brief, and a deadline a day past is not news.
    const startsAt = Date.parse(live.start || "");
    if (kind === "meeting_prep" && Number.isFinite(startsAt) && startsAt <= now) {
      return { handled: "that meeting has already started" };
    }
    return { ok: true };
  }

  return { ok: true };
}
