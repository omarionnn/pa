// Drive: an organizer's event tools on an INCOMING owner call wait for the second check
// (src/calls/verify.js isConsequential, audit run 2 lead R2-G). Run against the CAGE database only:
//
//   eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
//   REASON_EVENTS=on node --env-file-if-exists=.env .agents/skills/verify-reason/bin/call-event-gate-drive.mjs
//
// A scripted model (no model key spent) asks for event_cancel, then event_directory (a new name on
// their who's-going entry, the R2-G leftover), on an unverified incoming call: each must be refused
// with `needs_verification`, the event stays live and the name is unchanged. The same asks on the same
// call once it is verified run the real tools (the verified path is unchanged). Nothing can reach a
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
const turn = async (c, name, input) => {
  let i = 0;
  const generate = async function* () {
    if (i++ === 0) yield { type: "tool_use", name, id: `tu_${i}`, input };
    else yield { type: "text", text: "Okay." };
  };
  const logs = [];
  const out = await voice.llmRequest({
    rawBody: JSON.stringify({ model: "reason", stream: true, messages: [{ role: "user", content: `please do ${name}` }],
      extra_body: { [EXTRA_BODY_KEYS.callId]: c.id, [EXTRA_BODY_KEYS.conversationId]: C } }),
    headers: {}, generate, log: (l) => logs.push(l),
  });
  for await (const _ of out.stream) void _;
  return logs;
};
const listedName = () => db.attendeeRow(ev.id, C)?.display_name ?? null; // their own entry
const cancel = [call, "event_cancel", { event_id: ev.id, message: "party's off" }];
const rename = ["event_directory", { event_id: ev.id, display_name: "Spoofed Name" }];
const nameBefore = listedName();
const gate = (logs) => logs.find(l => l.call_tool_needs_verification) ?? null;
const before = await turn(...cancel);
const renameLogs = await turn(call, ...rename);
console.log(JSON.stringify({ unverified: {
  cancel_gate_log: gate(before), event_status: db.getEventRow(ev.id).status,
  directory_gate_log: gate(renameLogs), listed_name_before: nameBefore, listed_name_after: listedName(),
} }));
db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });
const verified = db.getCall(C, call.id);
await turn(verified, ...rename);
const nameVerified = listedName();
await turn(verified, "event_cancel", cancel[2]);
console.log(JSON.stringify({ verified: { listed_name: nameVerified, event_status: db.getEventRow(ev.id).status } }));
