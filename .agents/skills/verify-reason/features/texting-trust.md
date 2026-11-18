# Texting trust (REASON_TAPBACK_ACK, REASON_DELIVERY_GATED, REASON_QUICK_CORRECTION, 2026-11-11)

Owner spec: three behaviours that make a text from Reason believable, each behind its own switch,
each `off | owner | on` (default off; `owner` = the operator's thread only). Read on every call
(`src/trustflags.js`), so a flip needs only a restart.

Source: `src/trustflags.js` (the three switches), `src/tapbackack.js` (A), `src/outbox.js`
`noteDelivery` + `undeliveredLine`, `src/channels/sendblue.js` `receive` (outbound status → `delivery`),
`src/channels/router.js` `webhook`, `src/db.js` `outboundByMessageId` / `markOutboundDelivery` /
`ownUndeliveredUntold`, `src/tools.js` `deliveryNote` (B), `src/verifications.js` + `runtime.verifications()`
on the sweep (C). Already there before it, not rebuilt: `src/expressive.js` + `src/tapbacks.js`
(the model's own tapbacks), `src/onethought.js`, `REASON_THREADING`, `src/background.js`,
`REASON_NOTICE_QUIET_*`, read receipts, `undeliveredNotice` / `ownerFailureLine` in the outbox.
Tests: `test/tapback-ack.test.js` (14), `test/delivery-gated.test.js` (9),
`test/quick-correction.test.js` (9) — all offline, no model.
**Live (2026-11-14): all three `on` for everyone** (`REASON_TAPBACK_ACK`, `REASON_DELIVERY_GATED`,
`REASON_QUICK_CORRECTION` in the live switch list); `REASON_TAPBACK_TOPIC` `on` too (2026-11-18 list).

## Sub-features

- **A — fixed tapback vocabulary** (`REASON_TAPBACK_ACK`). One frozen map in `src/tapbackack.js`:
  👀 seen / on it (put on their text the moment its turn runs its FIRST tool; a turn that answers
  from what it knows uses no tool and gets no tapback at all — owner, 11-11), 🔍 looking it up (a lookup tool ran),
  ⏰ reminder set (timer_set worked), ✅ done (an action of this turn worked with no job left running,
  or the background job their text started finished). A swap is `-old` then `new` on the SAME
  message, serialised per thread. The target is the thread's base handle, so a three-part text gets
  one tapback on the message (never a 422 on `_2`). A reply that is only "on it" / "got it" after
  👀 went is dropped (`isBareAck`): a tapback and a text never say the same thing. Web and event
  turns never get one.
- **A1 — the first tapback says what the text is about** (`REASON_TAPBACK_TOPIC`, #601, 2026-11-15;
  only with `REASON_TAPBACK_ACK`; off by default, **live `on`**). The first reaction is chosen by code,
  no model call, from the first tool and its input plus a keyword pass over their words (`topicFor`,
  table `TOPICS` in `src/acktopic.js`): 💻 tech problem (a device AND something wrong with it),
  🛍️ shopping, 🍽️ food, ✈️ travel, 🚕 ride, 🗺️ directions, 💳 money, 📅 calendar, ✉️ email, 📞 call,
  📝 writing, 🔍 research, ⏰ reminder, 💪 fitness, 🎵 music, 🎬 video, 🔑 sign-in. The tool's topic stands
  only when their words agree or say nothing; two topics are a tie → 👀; anything sensitive (health,
  money trouble, intimate, legal, grief) or not cleared by the harm screen → 👀 (a lookup with no sure
  topic → 🔍). A topic emoji is never swapped to 🔍; ⏰ and ✅ keep their meaning. A text a food order
  belongs to carries the order's own status tapback instead (⏳ ❓ ✅ ❌ 👍, `src/food.js`). Log
  `{"tapback_topic":…,"why":…}`. Offline: `test/ack-topic.test.js`.
- **B — "sent" only once the carrier says so** (`REASON_DELIVERY_GATED`). Sendblue answers
  200 QUEUED and later posts SENT / DELIVERED / ERROR for the same handle; that callback was dropped
  as an outbound echo. Now it rides back as `delivery`, the outbox stamps DELIVERED and turns an
  ERROR into a `failed` row (`DELIVERY_ERROR`, never retried). A failed text of their own is told
  once on the next sweep ("quick correction: my last text didn't get through…"); a failed text to
  somebody else reaches the owner through `ownerFailureLine`. Tools that put something in a thread
  (`message_send`, voice notes, documents, generated pictures) say "on its way / sending" and
  `delivery: "pending"` on a channel that `reportsDelivery`; the console and Linq keep the old
  wording because accepted is all they can ever say.
- **B1 — a picture from an address is only "sent" once it arrived** (#583, 2026-11-14; no switch).
  `send_picture` (`src/pictureout.js`): the address is fetched here first through `guardedFetch`
  (https, public addresses only, size cap, real JPEG/PNG/GIF/WebP bytes; SVG/HTML refused), kept on
  Reason's own host (`webuploads`, `public: "picture"`, random address, gone after 30 days and with a
  data delete), sent through the outbox, and watched (`WATCH_MS` 75 s): DELIVERED (SENT counts only
  for SMS) → nothing more; anything else → ONE code line with the link. A fetch that fails sends the
  link as text with "I couldn't send that picture here, so here's the link:" (`FETCH_FAILED_LINE`),
  `picture_sent: false`. The tool always answers `delivery: "pending"` + `ON_ITS_WAY_NOTE`. At most
  `PICTURES_PER_DAY` (40) kept per person a day, none for the owner or anyone free for good (#593).
  Offline: `test/pictureout.test.js`.
- **C — "quick correction:" self-verification** (`REASON_QUICK_CORRECTION`). An email sent through
  Gmail, a calendar event created, or a text to somebody else leaves a `verifications` row. The sweep
  checks it when due (email: the thread for a bounce from mailer-daemon/postmaster after 3 min;
  calendar: the event by id after 2 min; text: the outbox row after 2 min), retries when it cannot
  tell, and if it did not hold sends ONE line starting `quick correction:` with the next step. Quiet
  hours defer it to their morning; the daily proactive cap defers it an hour; it counts as a
  proactive text. Off: nothing is scheduled and a leftover row is dropped unsaid.

## Prove

- Offline: `node --test test/tapback-ack.test.js test/delivery-gated.test.js test/quick-correction.test.js`
  → 35/35 (plus `test/ack-topic.test.js`, `test/pictureout.test.js` for A1 and B1). Flag off: no channel call for A, old tool wording for B, nothing scheduled for C.
- Live (owner): `grep REASON_TAPBACK_ACK /opt/reason/.env`; text "find me a table for 2 tonight" →
  👀 on your text as the first tool runs, 🔍 while it looks, and a reply with no bare "on it".
  Text "thanks" (no tool) → no tapback, just the reply.
  `journalctl -u reason --since '10 min ago' | grep -c tapback_ack` counts them.
- Live (B): `journalctl -u reason --since '10 min ago' | grep '"delivery"'` after an owner text;
  `sqlite3 /opt/reason/data/reason.db "select id,state,delivery_status from outbox order by id desc limit 5"`.
- Live (C): send an email to a bad address through Reason; within ~5 min a text starting
  `quick correction:` arrives; `select * from verifications order by id desc limit 3` shows `told`.
