// Sample daily editions (src/daily.js Edition shape) for staging and previews: made-up data only, one
// fictional person (Ama). Never read from a database; never a real person's lines.
const H = 3_600_000, D = 24 * H;

/** Editions for Tuesday 27 October 2026 in New York, by state: full, first, quiet, missed. */
export function dailySamples(now = Date.UTC(2026, 9, 27, 13, 0)) {
  const tz = "America/New_York";
  const base = { date: "2026-10-27", tz, written: true, first: false, away: false, linesOut: [], overnight: [] };
  const pickup = { lastAt: now - 20 * H + 22 * 60_000, surface: "imessage", where: "iMessage", lines: [
    { role: "user", text: "Under 3 hours. Keep it under $600." },
    { role: "reason", text: "Got it. I'll pull a short list and keep it here for when you're ready." },
  ] };
  const full = {
    ...base, issueNumber: 41, greeting: "morning, Ama. two things moved while you slept.",
    overnight: [
      { id: "approval:1", at: now - 3 * H - 20 * 60_000, kind: "decision", headline: "The Woodstock hotel dropped to $550 for the 14th.", detail: "$40 under yesterday. Still has the fireplace lounge you wanted.",
        actions: [{ label: "Yes, go ahead", reply: "Yes, go ahead.", primary: true }, { label: "Not now", reply: "Not now.", primary: false }] },
      { id: "message:2", at: now - 5 * H - 48 * 60_000, kind: "update", headline: "The farmhouse inn near Hudson wrote back.", detail: "The room with the wood stove is open the 14th to the 16th.", threadMessageId: 2 },
      { id: "task:3", at: now - 8 * H - 55 * 60_000, kind: "done", headline: "Dentist confirmed for Thursday, 10:30. It's on your calendar." },
    ],
    linesOut: [
      { id: "timer:1", name: "Phoebe Bridgers tickets go on sale", status: "THU 10:00 AM", urgent: true, detail: "I'll be in the queue at 9:58." },
      { id: "watch:2", name: "Flights to Lisbon under $300", status: "NOW $342", urgent: false, detail: "Waiting for $300 or less." },
      { id: "watch:3", name: "The green Arc'teryx shell back in medium", status: "NO CHANGE", urgent: false, detail: "Last looked 2 hours ago." },
    ],
    question: { id: "guess:7", guessId: 7, text: "Do you usually take the window seat?", why: "That's my guess from what you've told me. Say if it's right and I'll stop guessing.", options: ["Yes, that's right", "No"] },
    newestStamp: { id: "st1", type: "long_hold", name: "The long hold", detail: "52 MIN", story: "I sat on hold with Delta for 52 minutes so you didn't have to.", earnedAt: now - D, shape: "round", ink: "pen", rotation: -8, ariaLabel: "Stamp: The long hold, 52 minutes" },
    pickup,
  };
  const first = { ...base, issueNumber: 1, first: true, greeting: "first edition. it'll fill up as I do things for you.", pickup: null };
  const quiet = { ...base, issueNumber: 12, greeting: "quiet night. nothing needed you.", linesOut: full.linesOut.slice(1), pickup };
  const missed = {
    ...base, issueNumber: 44, away: true, greeting: "welcome back. here's what happened since Friday.",
    overnight: [
      { id: "message:9", at: now - D + 2 * H, kind: "update", headline: "The restaurant moved your table to 8pm on Friday.", detail: "Same table by the window.", threadMessageId: 9 },
      { id: "task:8", at: now - 2 * D - 3 * H, kind: "done", headline: "Your passport renewal was approved. It ships this week." },
    ],
    linesOut: full.linesOut.slice(0, 2), pickup,
  };
  return { full, first, quiet, missed };
}

/** A stand-in for src/stamps.js stampMarkup in staging: the reference's round stamp, drawn the same way. */
export function sampleStampMarkup(s, { size = 96 } = {}) {
  const [eyebrow, ...rest] = s.name.toUpperCase().split(" ");
  return `<span role="img" aria-label="${s.ariaLabel}" style="width:${size}px;height:${size}px;flex-shrink:0;border-radius:50%;border:3px double var(--pen);color:var(--pen);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;transform:rotate(${s.rotation}deg);font-family:var(--mono);font-weight:700;text-align:center">`
    + `<span style="font-size:10px;letter-spacing:.12em">${eyebrow}</span><span style="font-size:13px;letter-spacing:.06em">${rest.join(" ")}</span><span style="font-size:9px;letter-spacing:.12em">${s.detail}</span></span>`;
}
