# Reason — feature list (draft, 2026-09-30)

_Written after looking at Instinct (Spear Street Technology). Companion to design.md. Nothing here is built yet unless marked._

## What Instinct gets right (say it plainly)

1. **It has a body.** A persistent cloud computer with a browser and cached logins. That is why it can book, order, check in, and negotiate. Everything else is decoration without this.
2. **No interface.** Text or call. Thirty seconds to start. We already agree with this.
3. **It works between messages.** A task can span hours without the user babysitting it.
4. **It follows up on its own.** Dropped threads, unanswered asks, things it promised.
5. **It can make phone calls.** To places and to the user. Text is not enough for a restaurant with no booking page.
6. **It is tuned for small life stuff.** Not "write me an essay", but "the handyman never replied".

## Where Reason is different, and better

- **Group-native.** Instinct is one person and their assistant. Reason is the assistant in the group chat too: shared plan, DM fan-out, report back, split the bill.
- **Trust you can see.** Instinct's main criticism is silent, always-logged-in credentials. Reason confirms before it spends or sends on someone's behalf, keeps a receipt for every action, and lets you revoke a connected account in one tap.
- **Open source, self-hosted.** Your machine or your account, your keys. Instinct cannot be self-hosted.
- **iMessage-native UI.** Polls, tappable cards, tapbacks, effects, voice notes, real link cards. Instinct is plain text.
- **Honest about limits.** Reason has a capabilities tool and says what it cannot do. Instinct's marketing says "everything".

## Feature list

### A. Doing things (the body)

- **Browser tool.** A real browser Reason drives itself (Playwright) in a per-user sandbox. First errands: book a table, order for pickup, buy tickets, check in to a flight.
- **Connected accounts.** Email (read and send), calendar, the browser's saved logins. Each one is opt-in and revocable.
- **Phone calls out.** Reason calls a place or a person, holds, reports back. Also calls the user when text is not enough.
- **Lookups.** Web search, venues, movies and showtimes, weather, directions.
- **Money.** Pay links, split a bill, refunds. Only a tool result may say "paid". Spending cap per person, explicit yes before any charge.
- **Errand ledger.** Every action Reason took, with what it saw and what it got back. "What did you do today?" reads from this.
- **Long tasks.** A task keeps running between messages. Reason reports progress only when something changed.

### B. Proactive

- **Dropped threads.** Reason notices an ask nobody answered and follows up, or asks "want me to nudge em?".
- **Watchers.** Flight status, delivery, price drop, a reply landing. Timers already exist; watchers are timers with a condition.
- **Day-of and morning-after.** Reminders before, one "how was it?" after.
- **Rate-limited.** Proactive messages are capped so it never feels like spam.

### C. Group-native

- **Shared plan object** the whole group can change. Anyone can move a detail; Reason applies it and tells the group.
- **DM fan-out.** Reason asks people privately, collects answers, reports back once.
- **Speaks only when addressed** in groups. Summon word or mention.
- **Group decisions as polls,** not text votes.
- **Split payments** with per-person links and a live "who paid" card.

### D. iMessage-native UI (the Apple things)

- **Polls** for every choice with more than two options.
- **Tappable cards** (Linq iMessage app cards) for confirm, pick a seat, pick a time.
- **Tapbacks** as acknowledgments instead of "got it" texts.
- **Effects** for moments: confetti when a plan locks, fireworks when the group is all paid. On-device test first; effects play on open, not on arrival.
- **Real link cards.** Pay and plan links show the real date, time, place, and price in the preview. Never a placeholder image.
- **Voice notes** in and out.
- **Location** in, so "near me" works without asking.
- **Typing indicator** while a long task runs, so silence is not confusion.

### E. Trust and control

- **Confirm before commit.** Anything that spends money or messages a third party gets an explicit yes.
- **Receipts.** Every action leaves one. Undo where the service allows it.
- **Connected-accounts page.** See what Reason can reach, revoke in one tap.
- **Your data.** Memory is local to your install. Export and delete are one command.
- **Allow lists.** Who may move someone else's plan, who may spend.

### F. Memory and personality

- **People.** Preferences, usual spots, past plans, who is flaky.
- **Voice.** Short, slangy, funny when it fits. Owns its mix-ups out loud.
- **Context first.** Reads the thread, never phrase-matches.

### G. Open source

- **License:** MIT. _Decided 2026-09-30. `LICENSE`, Copyright 2026 Omari Nyarko._
- **One-command self-host.** Bring your own Anthropic key and a channel (Linq or WhatsApp adapter).
- **Public evals.** The real-message eval sets ship with the repo so contributors can prove a change helps.
- **Scrub before publishing.** The repo has notes that mention Sidekick lessons. Lessons stay, names go.
- **Name.** **Reason** — antonym of Instinct. _Decided 2026-09-30. Renamed throughout: code, docs, package name, console prompt._

## Proposed build order

1. **Body v0.** Browser tool plus one errand end to end in DM (book a table), with confirm-before-commit and a receipt. This is the thing Instinct has that we do not.
2. **Dropped-thread follow-up.** The first proactive behavior that is not a timer.
3. **Linq channel plus the iMessage UI.** Polls, cards, tapbacks, effects. This is when Reason leaves the console.
4. **Groups.** Shared plan, fan-out, report back.
5. **Open-source prep.** License, README, scrub, rename, one-command install.

## Decided (2026-09-30)

- **Name:** Reason. **License:** MIT.
- **Build order for this round:** rename + MIT → trust primitives (E) → body v0 (A) → proactive (B) → memory and voice (F) → open-source prep (G). Channel adapter comes after; console stays the surface until then.
- Repo stays private until Omari flips visibility himself.

## Still needs Omari's word

- Whether the public repo stays under the personal account.
- Credentials for phone calls out and Gmail/calendar OAuth. Until then those live in the connected-accounts registry as `not_connected` and the capabilities tool says so.
