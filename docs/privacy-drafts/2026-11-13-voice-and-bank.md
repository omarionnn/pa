<!--
DRAFT for the public privacy page. Not published; the live site is not edited by this file.
Publish (a) before REASON_CALL_CARTESIA=on is set (docs/calls-cartesia.md section 5, "Before `on` is set").
Publish (b) before REASON_PLAID=on.

Each claim, checked against the code on 2026-11-13:

(a) The call voice
- "may be handled by Cartesia": with REASON_CALL_CARTESIA=on every own call goes to Cartesia first (no
  per-person choice; =owner is the operator alone). "May", because a call Cartesia is not ready for
  within 1.5 s, refuses (plan limit, credit run out) or drops carries on with Reason's usual voice
  (GPT-Live). src/config.js `callCartesia`; src/calls/calltrial.js `cartesiaTrialFor`;
  src/calls/cartesia.js `READY_MS`, `fallBack`.
- "voice in and out": the caller's audio is sent to Cartesia's agent (`audio_input`) and the agent's
  speech comes back (`audio_output`). src/calls/cartesia.js `fromTwilio`, `audioOut`.
- "keeps a recording during the call": Cartesia's Managed Agents save every call's transcript and
  recording, with no setting to stop it below Enterprise (docs.cartesia.ai/agents/transcripts-and-recordings).
- "deletes when the call ends": at every end, and for a session that came up after a fall-back,
  `DELETE /agents/calls/{id}` (transcript, recording and logs), checked for `redacted_at`.
  src/calls/cartesia.js `deleteAgentCall`, `end`, `deleteAndCheck`, `fromAgent` (late session_ready).
  Caveat: it is tried up to 4 times and the result logged (`cartesia_recording_deleted`); if Cartesia
  cannot be reached the copy stays on their side until removed by hand. The wording says "has Cartesia
  delete", not "is deleted", for that reason.
- "the words of the call are kept in your Reason as for any call": the call's own record and recording
  on our side are the same as on every call (src/calls/cartesia.js `end`: CallTape, writeSealed, the same
  settle as GPT-Live, src/calls/gptlive.js `settleGptLive`). That is already covered by the existing call
  wording on the privacy page, so it is not repeated here.
- "calls Reason makes to other people or businesses for you do not use it": `is_owner` must be 1 in
  every mode. src/calls/calltrial.js `cartesiaTrialFor`; test/call-cartesia-everyone.test.js and
  test/call-cartesia.test.js pin it for both accounts, both directions, every mode.
- NOT claimed: that Cartesia does not train on calls. Their terms allow it by default (terms §5.3(c));
  the opt-out must be filed first, and only then may a sentence about it be added.

(b) The bank
- "through Plaid, read-only (balances and transactions)": the link asks for the Transactions product;
  balances are read live from /accounts/balance/get and never stored; no endpoint that moves money or
  returns account or routing numbers is called. src/plaid.js header, the link token body (`products`),
  `balances`.
- "kept 60 days": Reason stores transactions dated within the last 60 days and deletes older ones at
  start and hourly. src/plaid.js `KEEP_DAYS`, `cutoffDay`, the retention sweep, and the per-sync
  delete in the sync. Note: Plaid is asked for 180 days of history on its side (`days_requested: 180`,
  for its recurring-charge detection); "kept" is about what Reason keeps.
- "removable any time": the `bank` tool's disconnect calls Plaid's /item/remove and deletes the
  account's synced transactions, accounts and links at once (retried hourly if Plaid cannot be reached);
  deleting all of a person's data does the same first. src/plaid.js `disconnect`, `wipeLocal`,
  `retryRemovals`; src/data.js (`removeAllAtPlaid`). Revoking access at the bank does the same
  (src/plaid.js, the USER_PERMISSION_REVOKED webhook).
-->

**Calls with your Reason.** When you talk with your own Reason on the phone, the call may be handled by Cartesia, a voice company: your voice goes to Cartesia so it can hear you, and Reason's voice comes back from it. Cartesia keeps a recording of the call while it is happening, and when the call ends Reason has Cartesia delete it. Calls Reason makes to other people or businesses for you never use Cartesia.

**Your bank.** If you connect a bank, the connection goes through Plaid and is read-only: Reason can see your balances and transactions, and cannot move money. Reason keeps the last 60 days of transactions and deletes anything older. You can disconnect your bank at any time by asking Reason, and what it had from that bank is deleted.
