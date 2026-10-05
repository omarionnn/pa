// "Read", on the message somebody just sent.
//
// A text that has been picked up and is being worked on looks exactly like a text that fell into a
// hole. The read receipt is the cheapest possible fix for that: it costs one request, it needs no
// model, and it goes out before a single token has been spent.
//
// It is sent when Reason has really taken the message — after the sender is admitted and after the
// event id is claimed, so a provider retrying a delivery does not mark the same thing read twice
// and a message that was never going to be answered is never marked read at all. Marking something
// read that Reason then ignores would be worse than silence.
//
// Three things make this different from the typing bubble:
//
//   - **Not iMessage-only.** "The request marks the conversation as read on your line whether it is
//     iMessage, RCS, or SMS" (api-v2/read-receipts). Only the visible result differs, because SMS
//     has no read status to show, so nothing here gates on which rail a thread is on.
//   - **Two of its failures are permanent facts.** A line that answers 422 unsupported_on_this_line
//     will answer it for every contact forever, and only Sendblue's support can change that; a 403
//     on the free plan is about one contact. Both are remembered, so the second inbound message
//     does not ask again — otherwise this becomes one wasted request and one log line per message
//     about something nobody can fix from here.
//   - **Nobody is ever told.** A read receipt that could not be sent is a detail about Reason's
//     plumbing, not news for the person texting. It goes in the log once and nowhere else.
import * as db from "./db.js";
import { config } from "./config.js";

const FEATURE = "read_receipt";

/**
 * Mark one conversation read. Returns what happened, for the tests and the log; never throws.
 *
 * `line` is the Sendblue number the message arrived on, which is the scope a 422 belongs to. It
 * comes off the channel's own status rather than being passed in, so there is one source for it.
 */
export async function markRead({ channel, to, log = () => {} }) {
  if (!config.readReceipts) return { skipped: "off" };
  if (!channel || typeof channel.markRead !== "function") return { skipped: "unsupported" };
  const st = channel.status?.();
  if (st?.status !== "live") return { skipped: "not_connected" };

  const line = st.number ?? null;
  // Already refused, permanently. Not asked again, and not logged again either.
  const known = db.blockedFeature({ channel: channel.name, feature: FEATURE, line, contact: to });
  if (known) return { skipped: "known_refusal", why: known.why };

  let r;
  try {
    r = await channel.markRead({ to });
  } catch (e) {
    // Best-effort means best-effort. A broken endpoint cannot be allowed to stop a turn.
    log({ read_receipt: to, threw: (e?.message ?? String(e)).split("\n")[0] });
    return { ok: false, threw: true };
  }
  if (r?.ok) return { ok: true };

  // A permanent refusal is written down and said once. The scope the channel reports is trusted
  // rather than guessed at here, because only the adapter has read which code means which.
  if (r?.remember) {
    const scope = r.remember.scope === "line" ? `line:${line}` : `contact:${to}`;
    db.recordChannelLimit({ channel: channel.name, feature: FEATURE, scope, why: r.remember.why, code: r.http_status ?? null });
    log({ read_receipt: "off_for_good", scope, why: r.remember.why });
    return { ok: false, remembered: scope };
  }
  // Transient: nothing remembered, so the next message tries again. Logged, because a line that is
  // permanently flapping should be visible somewhere.
  log({ read_receipt: to, not_now: r?.error ?? "no reason given", status: r?.http_status ?? null });
  return { ok: false, transient: true };
}
