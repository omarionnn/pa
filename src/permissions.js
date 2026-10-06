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
//   - Two actions can never be covered by a standing permission at all, whatever anybody says:
//     deleting somebody's whole Reason, and approving a risky thing a builder asked to do. Both are
//     one-off, irreversible and about somebody other than the person granting it.
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
};

/** Never pre-authorizable. Both are irreversible and both are about somebody else. */
export const NEVER_STANDING = new Set(["admin_delete", "remote_approve"]);

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
