// Standing permissions: the things Reason may do without stopping to ask, because the person
// already said so once.
//
// The confirm gate (src/trust.js) is a question per action. That is right for a first time and
// wrong for the twentieth: somebody who has said "you can reorder groceries without asking" has
// answered the question, and asking again every Sunday is not caution, it is not listening. So this
// is the second half of the gate — consulted BEFORE it stops, and only ever able to let through
// something whose shape was written down in advance.
//
// What is enforced in code here, and what is not:
//
//   - A permission is their SENTENCE, kept verbatim (`said`), plus the model's reading of it in a
//     fixed shape. The gate compares against the shape; the sentence is what goes on the receipt
//     and what gets read back. Reading the sentence is the model's job — there is no regex over
//     anybody's words deciding what they meant.
//   - The shape is a bound, never a hint. An action gets through only when the saved action covers
//     exactly this action, the saved target covers exactly this target, and the saved amount covers
//     exactly this amount. Anything wider is refused as it was before, and the refusal names the
//     permission that nearly covered it and why it did not. Nothing is stretched to fit.
//   - A few actions can never be covered by a standing permission at all, whatever anybody says:
//     deleting somebody's whole Reason, approving a risky thing a builder asked to do, and pressing
//     the button that checks somebody in. See `NEVER_STANDING`, which carries the reason for each.
import * as db from "./db.js";
import { clock, stamp } from "./config.js";
import { normalizeTarget, toolName, money } from "./trust.js";

/**
 * Every action the gate stops. A permission may only name one of these, or a category below.
 *
 * Kept here rather than read out of the gate's own two lists because it is a different question:
 * `ALWAYS_NEEDS_CONFIRMATION` and `needsConfirmation` in src/tools.js decide when to stop, and this
 * decides what a person is allowed to pre-authorize. `test/trustline.test.js` asserts every name
 * here is a real tool and that nothing the gate stops is missing from it, so the two cannot drift.
 */
export const GATED_ACTIONS = new Set([
  "account_connect", "browser_submit", "admin_delete", "gmail_send", "gmail_trash", "remote_approve",
  "message_send", "voice_note_send", "call_place",
  "gmail_archive", "gmail_mark", "gmail_label", "calendar_create",
  // Ending a subscription. Pre-authorizable, and the reasoning is worth writing down because the
  // first instinct is that it should not be: a cancellation is irreversible in one direction — a
  // promotional rate, a grandfathered price or a year of unused credits can all go and not come
  // back. What makes it a fair thing to grant anyway is that it is about the person granting it and
  // nobody else, which is the line `NEVER_STANDING` is actually drawn on. "Just cancel the gym, stop
  // asking me about it" is somebody answering the question, not somebody being careless.
  //
  // The bound does real work here. The target a cancellation carries is the merchant followed by the
  // details off the final screen, so a permission that names a merchant covers that merchant and
  // nothing else — "you can cancel Hulu" can never let a Netflix cancellation through. A permission
  // naming no target at all covers any cancellation, which is exactly as wide as the sentence was.
  "subscription_cancel_commit",
  // Their Drive, 2026-10-07. The same reasoning that makes `gmail_trash` grantable: it is their own
  // Drive, Google keeps a binned file for 30 days, and the permission still carries a real bound —
  // the target a bin carries is the account and the file ids, so a permission naming one file covers
  // that file and nothing else. "Just tidy my drive up, stop asking me" is somebody answering the
  // question rather than somebody being careless.
  "drive_trash",
  // Moving more than one file at once, which is the only shape of move that is gated at all. "Sort
  // my drive however you like" is the sentence this is for. The 50-file ceiling is NOT a permission
  // and cannot be granted away — it is checked in the tool, after any permission has been found.
  "drive_move",
  // Sharing, on the same footing as `gmail_send`: it reaches a person, so by default it asks, and
  // "you can send drive stuff to my accountant without checking" is a sentence somebody is entitled
  // to say. The target carries the file AND the address, so a permission about one person can never
  // let a share with somebody else through.
  "drive_share",
  // Pressing the button that checks somebody in, 2026-10-07. Here because the gate stops it and
  // this list must name everything the gate stops — and in `NEVER_STANDING` below, because no
  // sentence can pre-authorize it. The reasoning is on NEVER_STANDING.
  "flight_checkin_commit",
  // Buying something through AgentCard. Here because the gate stops it and this list must name
  // everything the gate stops — and in `NEVER_STANDING` below, because no sentence can
  // pre-authorize it. The reasoning is on NEVER_STANDING.
  "purchase_confirm",
  // A Crossmint checkout's payment (src/shoptools.js); never standing, see WHY_NEVER_STANDING.
  "shop_pay",
  // A cancellation's last step inside their own account (src/accountjobtools.js); never standing either.
  "account_cancel_confirm",
  // Merging somebody else's (or their own) pull request. Irreversible: the commit is on the default
  // branch, CI runs, and undoing it means a revert PR. On the same footing as flight_checkin_commit:
  // in GATED_ACTIONS because the gate stops it, and in NEVER_STANDING because no sentence should
  // pre-authorize it — "just merge whatever looks good" is the gate switched off.
  "github_pr_merge",
  // X (Twitter) writes. Each one reaches the public or a real person, so it is gated on the same
  // footing as gmail_send and message_send: by default it asks, and a sentence like "you can tweet
  // about the project without asking" is a real bound because the target carries what it is about.
  "x_post", "x_reply", "x_retweet", "x_like", "x_unlike", "x_bookmark", "x_bookmark_remove", "x_dm",
  // Deleting a tweet is irreversible: the tweet, its replies tree and its engagement are gone. In
  // NEVER_STANDING below.
  "x_delete",
  // An Uber. Requesting a ride spends their money and sends a car, so the gate stops it the same
  // way it stops a purchase. In NEVER_STANDING below: "just book me an Uber whenever" is the gate
  // switched off, and the $14 UberX somebody said yes to must not become a $31 Black on the next ask.
  "uber_request",
  // The one yes to a to-do list's whole plan (src/todo.js). In NEVER_STANDING below: the yes is to
  // a plan they read, and "approve all my lists" would be a yes to plans nobody has written yet.
  "todo_approve",
  // Model-written words in front of other people (audit lead 28): a blast to every guest of an
  // event, and an issue or a comment under their GitHub name. Grantable — "you can comment on my
  // own repos without asking" is a real bound, because the target names the repo.
  "event_blast", "github_issue_create", "github_issue_comment",
  // A blast at a later time (src/eventschedule.js), on the same footing: the target names the event.
  "event_schedule",
  // Money back to one guest of a paid event (src/eventpay.js): the target pins the guest, the amount
  // and the event. Never standing: each refund is its own yes.
  "event_refund",
  // A guest's own refund (src/eventpay.js guestRefund): money back to them, and off the event.
  "event_ticket_refund",
  // A buyer's ticket for a friend (src/eventpay.js seats): giving one back, or Reason texting its
  // link to a friend's number. The target pins the seat (and the number). Never standing.
  "event_seats",
]);

/**
 * Words for groups of actions, because people do not grant permission one tool at a time. "Reply to
 * scheduling emails yourself" is about `gmail_send`; "you can tidy my inbox" is about four different
 * tools and nobody says it four times.
 *
 * A category is still a bound: it names an exact set, and an action outside that set is not covered
 * by it. There is no catch-all category on purpose — "you can do anything without asking" is not a
 * thing this can express, and a person who says it gets asked which things.
 */
export const CATEGORIES = {
  purchases: ["browser_submit"],
  email: ["gmail_send"],
  mail_tidying: ["gmail_archive", "gmail_mark", "gmail_label", "gmail_trash"],
  texts: ["message_send", "voice_note_send"],
  calls: ["call_place"],
  calendar_invites: ["calendar_create"],
  accounts: ["account_connect"],
  // "you can cancel the stuff I've told you to cancel" is one sentence about one action, and this is
  // the word for it. Only the press that really ends a subscription: finding them, listing them and
  // walking to the cancel page were never gated and there is nothing here to pre-authorize about them.
  subscriptions: ["subscription_cancel_commit"],
  // "You can tidy my drive up." Binning and batch-moving, which are the two gated halves of
  // organising; renaming, making folders and single moves were never gated and there is nothing to
  // pre-authorize about them. Sharing is deliberately NOT in here: it reaches another person, and a
  // sentence about tidying is not a sentence about giving somebody access to a document.
  drive_tidying: ["drive_trash", "drive_move"],
  tweets: ["x_post", "x_reply", "x_retweet", "x_like", "x_unlike"],
  x_bookmarks: ["x_bookmark", "x_bookmark_remove"],
  x_dms: ["x_dm"],
};

/**
 * Never pre-authorizable, whatever anybody says.
 *
 * Deleting a whole Reason and approving a risky thing a builder asked to do are both irreversible
 * and both about somebody other than the person granting it.
 *
 * Checking somebody in is here for a third reason, and it is worth writing down because the first
 * instinct — it is their own flight, so why not — is the same instinct that makes
 * `subscription_cancel_commit` grantable, and that instinct is right there and wrong here. A
 * permission is a BOUND, and a bound has to be something a person could have meant precisely. The
 * details a check-in's yes covers only exist on the last screen: the seat the airline is offering,
 * the name it has on the booking, whatever it says costs money. Nobody granting "just check me in,
 * stop asking" has seen any of that, so the permission would have to cover every one of them —
 * which is not a bound, it is the gate switched off. And the promise on Reason's own site for this
 * feature is four words long: *asks before it touches anything*.
 *
 * The thing somebody actually wants when they say that sentence is not fewer questions, it is less
 * waiting — and that is what the offer arriving by itself the moment check-in opens already does.
 */
export const NEVER_STANDING = new Set(["admin_delete", "remote_approve", "flight_checkin_commit", "github_pr_merge", "x_delete", "purchase_confirm", "uber_request", "shop_pay", "account_cancel_confirm", "todo_approve", "event_refund", "event_ticket_refund", "event_seats"]);

/**
 * Why each one cannot be granted, in the words to say it in.
 *
 * Returned by the tool rather than left for the model, because "it always needs a yes" on its own
 * sounds like a limitation somebody should push back on, and each of these has a real reason that
 * answers the push-back. They are not the same reason, which is why this is a map and not a
 * sentence.
 */
export const WHY_NEVER_STANDING = {
  admin_delete: "wiping a Reason is irreversible and it is about whoever's Reason it is, not whoever is asking",
  remote_approve: "saying yes on a builder's behalf is a decision about work somebody else is doing",
  flight_checkin_commit: "the yes for a check-in covers what the airline's last screen says — the seat it is offering,"
    + " the name on it, anything it costs — and none of that exists yet when a permission is granted."
    + " So there would be nothing for the permission to be a bound on. The waiting is what gets fixed instead:"
    + " the offer arrives by itself the moment check-in opens, and the answer is one word",
  github_pr_merge: "merging a pull request is irreversible — the commit lands on the default branch and CI runs."
    + " A revert is possible but it is a new PR, not an undo",
  x_delete: "deleting a tweet is irreversible — the tweet, its replies and its engagement are gone",
  // A cart does not have a bound at the moment somebody grants a standing permission: the shop
  // AgentCard picked, what it put in there instead of what was asked for, the service fees and
  // the real total only exist once the cart comes back, and "just buy it" would have to cover every
  // one of them. That is not a bound, it is the gate switched off.
  todo_approve: "the yes to a to-do list covers the plan they were shown — the businesses it names, what it says costs money — and the next list's plan does not exist yet",
  account_cancel_confirm: "the yes for a cancellation covers what the site's own last step says, which plan it is, what it costs and the date access ends, and none of that exists until the run reaches that step — so it is always asked, with those words in it",
  shop_pay: "the yes for a store checkout covers the exact total Crossmint asks for at that store, and that total does not exist until the checkout reaches payment — so it is always asked, by text, with the number in it",
  purchase_confirm: "the yes for a purchase covers the cart AgentCard came back with — which shop it picked,"
    + " what it actually put in the basket, the fees and the real total — and none of that exists yet when a"
    + " permission is granted, so there would be nothing for the permission to be a bound on",
};

/** The honest refusal for a list of actions nobody may pre-authorize. */
export function whyNeverStanding(actions = []) {
  return actions.map(a => `${a} — ${WHY_NEVER_STANDING[a] ?? "it always needs a yes of its own"}`).join("; ");
}

/** The action names one scope covers, or null when the scope names something the gate does not know. */
export function actionsFor(scopeAction) {
  const want = toolName(scopeAction).trim();
  if (CATEGORIES[want]) return CATEGORIES[want];
  if (GATED_ACTIONS.has(want)) return [want];
  return null;
}

/** Everything a permission may name, for a refusal that tells the model what it could have said. */
export function knownScopeActions() {
  return [...Object.keys(CATEGORIES), ...[...GATED_ACTIONS].filter(a => !NEVER_STANDING.has(a))];
}

/**
 * Does this permission's target cover the target of the action in front of us?
 *
 * Three rules, in this order, and the middle one is the one worth being careful about:
 *
 *   - A permission that names no target covers the action whatever it is pointed at. "You can
 *     reorder groceries without asking" with no target is a permission about an action, not a place.
 *   - A phone number is compared as a number and NOTHING else. `normalizeTarget` renders one as
 *     `+1…`, so a permission for one number can never cover another by happening to be a substring
 *     of it — which, for a tool that rings people, is the single most important thing here.
 *   - Anything else: the permission's words have to actually appear in what is about to be done.
 *     A permission for "groceries" covers "reorder the usual groceries from Amazon Fresh"; it does
 *     not cover "a 65 inch TV", and it does not cover a booking whose details say nothing at all.
 */
export function targetCovers(permTarget, actionTarget) {
  const p = normalizeTarget(permTarget ?? "");
  if (!p) return { ok: true };
  const a = normalizeTarget(actionTarget ?? "");
  if (!a) return { ok: false, why: `it only covers '${permTarget}', and this action does not say who or what it is for` };
  if (p === a) return { ok: true };
  if (p.startsWith("+") || a.startsWith("+")) {
    return { ok: false, why: `it covers ${permTarget}, and this is ${actionTarget} — a different number` };
  }
  if (a.includes(p)) return { ok: true };
  return { ok: false, why: `it covers '${permTarget}', and this is '${actionTarget}'` };
}

/**
 * Does this one permission cover this one action? Returns `{ ok: true }` or `{ ok: false, why }`,
 * and the `why` is written to be said to the person, because the model is told to say it.
 */
export function covers(row, { action, target = "", amountCents = null, now = clock.now() } = {}) {
  if (row.revoked_at) return { ok: false, why: `it was taken back on ${stamp(row.revoked_at)}` };
  if (row.until_at && now > row.until_at) return { ok: false, why: `it ran out on ${stamp(row.until_at)}` };

  const want = toolName(action);
  const covered = actionsFor(row.action);
  if (!covered) return { ok: false, why: `it names '${row.action}', which is not an action the gate knows` };
  if (!covered.includes(want)) {
    return { ok: false, why: `it covers ${covered.join(", ")}, and this is ${want}` };
  }
  if (NEVER_STANDING.has(want)) return { ok: false, why: `${want} always needs a yes of its own` };

  const t = targetCovers(row.target, target);
  if (!t.ok) return t;

  if (amountCents) {
    if (!row.max_cents) {
      return { ok: false, why: `it sets no amount, and this one costs ${money(amountCents)} — a permission with no limit on it cannot authorize spending` };
    }
    if (amountCents > row.max_cents) {
      return { ok: false, why: `it tops out at ${money(row.max_cents)} and this is ${money(amountCents)}` };
    }
  }
  return { ok: true };
}

/**
 * The permission that lets this action through, or the near misses and why each one failed.
 *
 * Called by the gate before it stops. A hit means the action proceeds with no yes and leaves a
 * receipt naming the sentence that allowed it; a miss means the action is refused exactly as it was
 * before, with the closest permission quoted so the model can say "you told me X, and this isn't X"
 * rather than either asking blankly or talking itself into stretching one.
 */
export function covering({ conversationId, action, target = "", amountCents = null, now = clock.now() }) {
  const rows = db.listPermissions(conversationId);
  const near = [];
  for (const row of rows) {
    const verdict = covers(row, { action, target, amountCents, now });
    if (verdict.ok) return { ok: true, permission: view(row) };
    // Only the ones that are about this action at all. A permission about groceries is not a near
    // miss for a phone call, and listing it would be noise in a refusal that has to be read.
    const covered = actionsFor(row.action);
    if (covered?.includes(toolName(action))) near.push({ ...view(row), does_not_cover_this_because: verdict.why });
  }
  return { ok: false, near };
}

/** One row as the model and the person see it. `said` first, because that is the permission. */
export function view(row) {
  return {
    permission_id: row.id,
    said: row.said,
    covers: row.action,
    ...(row.target ? { target: row.target } : {}),
    // Both, and they are for different readers: `up_to` is the line a person reads, `max_cents` is
    // what the second check inside browser_submit compares the page's real total against.
    ...(row.max_cents ? { up_to: money(row.max_cents), max_cents: row.max_cents } : {}),
    ...(row.until_at ? { until: stamp(row.until_at) } : {}),
    granted: stamp(row.granted_at),
    ...(row.revoked_at ? { taken_back: stamp(row.revoked_at) } : {}),
  };
}
