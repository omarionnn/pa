/**
 * Does a call to this number have to say it is recorded? (2026-10-31, after call 59.)
 *
 * Reason records every call. Most US states let one party to a call record it (federal law,
 * 18 U.S.C. § 2511(2)(d), is one-party too), so a call there does not open by announcing it — a
 * normal caller doesn't. The states below require EVERY party's consent, so a call to a number there
 * says it, briefly and naturally, in Reason's first reply ("just so you know, this call's recorded").
 *
 * The state is read from the area code, the only thing a number tells us (a mobile can be anywhere,
 * which is why the list errs toward saying it). Anything that is not a US/Canada geographic number —
 * toll-free, abroad, unreadable — says it too: the safe default. Canada is one-party (Criminal Code
 * s. 184(2)(a)) and is not listed.
 *
 * Notes on the list (checked 2026-10-31; not legal advice — the cautious reading is used throughout):
 *   - CA Penal Code 632/632.7; CT Gen. Stat. 52-570d (civil, phone calls); DE 11 Del. C. 2402 vs 1335
 *     conflict, so listed; FL 934.03; IL 720 ILCS 5/14-2; MD Cts & Jud Proc 10-402; MA ch. 272 § 99;
 *     MI 750.539c (courts split on a participant recording; listed); MT 45-8-213; NV NRS 200.620 (Lane
 *     v. Allstate: phone calls all-party); NH RSA 570-A:2; PA 18 Pa.C.S. 5704; WA RCW 9.73.030.
 *   - OR: ORS 165.540 is one-party for phone calls and all-party only in person. Kept on the list
 *     anyway, because it was asked for and one short sentence costs nothing.
 * Change the list here; `recordingNoticeFor` is the only reader.
 */
export const ALL_PARTY_STATES = {
  CA: [209, 213, 279, 310, 323, 341, 350, 357, 369, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 738, 747, 760, 805, 818, 820, 831, 837, 840, 858, 909, 916, 925, 949, 951],
  CT: [203, 475, 860, 959],
  DE: [302],
  FL: [239, 305, 321, 324, 352, 386, 407, 448, 561, 645, 656, 689, 727, 728, 754, 772, 786, 813, 850, 863, 904, 941, 954],
  IL: [217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730, 773, 779, 815, 847, 861, 872],
  MD: [227, 240, 301, 410, 443, 667],
  MA: [339, 351, 413, 508, 617, 774, 781, 857, 978],
  MI: [231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 906, 947, 989],
  MT: [406],
  NV: [702, 725, 775],
  NH: [603],
  OR: [458, 503, 541, 971],
  PA: [215, 223, 267, 272, 412, 445, 484, 570, 582, 610, 717, 724, 814, 835, 878],
  WA: [206, 253, 360, 425, 509, 564],
};

const STATE_OF = new Map(Object.entries(ALL_PARTY_STATES).flatMap(([st, codes]) => codes.map(c => [String(c), st])));
const TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/** { notice, state, why } for a phone number: notice = say "this call's recorded" on this call. */
export function recordingNoticeFor(number) {
  const digits = String(number ?? "").replace(/[^\d+]/g, "");
  const m = /^\+?1?(\d{3})(\d{7})$/.exec(digits.startsWith("+") && !digits.startsWith("+1") ? "" : digits);
  if (!m) return { notice: true, state: "", why: "not a US/Canada number" };
  const area = m[1];
  if (TOLL_FREE.has(area)) return { notice: true, state: "", why: "toll-free, state unknown" };
  const state = STATE_OF.get(area);
  return state ? { notice: true, state, why: "all-party-consent state" } : { notice: false, state: "", why: "one-party-consent" };
}
