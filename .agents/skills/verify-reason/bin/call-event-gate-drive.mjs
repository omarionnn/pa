// Drive: an organizer's event tools on an INCOMING owner call wait for the second check
// (src/calls/verify.js isConsequential, audit run 2 lead R2-G). Run against the CAGE database only:
//
//   eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
//   REASON_EVENTS=on node --env-file-if-exists=.env .agents/skills/verify-reason/bin/call-event-gate-drive.mjs
//
// A scripted model (no model key spent) asks for event_cancel on an unverified incoming call: the
// tool must be refused with `needs_verification` and the event stays live. The same ask on the same
// call once it is verified runs the real tool (the verified path is unchanged). Nothing can reach a
// phone: the cage has no texting channel and no phone line.
if (!process.env.REASON_DB_PATH?.includes("rv-") && !process.env.REASON_DB_PATH?.includes("reason-verify")) {
  console.error("refusing: REASON_DB_PATH is not a cage database"); process.exit(2);
}
const db = await import("../../../../src/db.js");
const events = await import("../../../../src/events.js");
const voice = await import("../../../../src/calls/voice.js");
const { EXTRA_BODY_KEYS } = voice;
const { clock } = await import("../../../../src/config.js");

const C = process.env.REASON_CONVERSATION || "dm:owner";
const owner = process.env.REASON_VERIFY_OWNER || "+12025551234";
await voice.prime();
const made = events.create(C, {
  name: `Gate drive ${Date.now()}`, description: "d", starts_at: "2026-12-20T21:00", location: "12 Elm St",
  password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true,
});
if (!made.ok) { console.error("event_create failed", made); process.exit(1); }
const ev = made.event;
const call = db.createCall(C, {
  provider: "gptlive", toNumber: owner, isOwner: true, goal: "caller-ID owner call", facts: [],
  direction: "in", externalId: `gate-drive-${ev.id}`, state: "in_progress",
});
const turn = async (c) => {
  let i = 0;
  const generate = async function* () {
    if (i++ === 0) yield { type: "tool_use", name: "event_cancel", id: `tu_${i}`, input: { event_id: ev.id, message: "party's off" } };
    else yield { type: "text", text: "Okay." };
  };
  const logs = [];
  const out = await voice.llmRequest({
    rawBody: JSON.stringify({ model: "reason", stream: true, messages: [{ role: "user", content: "cancel my party" }],
      extra_body: { [EXTRA_BODY_KEYS.callId]: c.id, [EXTRA_BODY_KEYS.conversationId]: C } }),
    headers: {}, generate, log: (l) => logs.push(l),
  });
  for await (const _ of out.stream) void _;
  return logs;
};
const before = await turn(call);
const afterUnverified = db.getEventRow(ev.id).status;
console.log(JSON.stringify({ unverified: { gate_log: before.find(l => l.call_tool_needs_verification) ?? null, event_status: afterUnverified } }));
db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });
await turn(db.getCall(C, call.id));
console.log(JSON.stringify({ verified: { event_status: db.getEventRow(ev.id).status } }));
