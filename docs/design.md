# Kwaku — design

_Started 2026-09-23. Fresh codebase, private repo, own Linq number._

## Why this exists

A 250-line Claude-with-tools bot handled "change the name on my order" on the first try, unprompted, because the model had an update tool and was allowed to pick it. A planning product with thousands of lines of regex routing, flows, flags and guards could not, because there the model only phrases what code already decided.

Kwaku inverts that: the model understands and acts; code keeps truth and money safe.

## What Kwaku can do

- Plan anything: movies, dinner, beach day, birthday, trip rental. Read, ask what is missing, propose, lock, pay, remind.
- Errands in the chat: split a bill, remind the group, order for pickup, look something up, book a table, draft a text, collect RSVPs.
- Understand every message. If it cannot do the thing, say so and offer the nearest thing it can (it knows its own capability list).
- Own its own questions. "No", "the second one", "never mind" always land on the question they answer.
- Change any detail at any time, from planner or crew, without a flow anticipating it.
- Live in groups and DMs at once. Speak when addressed, DM people to collect answers, report back, thread mixed bursts.
- Remember people: preferences, usual spots, past plans.
- Proactive on real timers: nudges, day-of reminders, morning-after check-in. Timers are tools the model sets and cancels.
- Voice notes in and out.
- Sound like a person: short, slangy, funny when it fits, owns its mix-ups out loud.

## What stays in code, deliberately

- Money: pay links, refunds, charges are tools with hard checks and an explicit yes. Only a tool result may say "paid".
- Truth of state: plans, votes, rooms, timers live in a database behind tools. The model may only claim what a tool returned this turn.
- Send before claim, idempotency, rate limits, allow lists, who may move someone else's plan.

## Architecture (first cut)

- One agent loop per conversation (each DM, each group), same brain, same tools.
- Tools: plan.create/get/update/lock/cancel, people.ask, group.post, poll.create, money.pay_link/refund, venue.search, timer.set/cancel, memory.remember/recall, capabilities.list.
- Plan = typed object whose open questions are fields. Open means ask or wait; never invent.
- Cross-conversation events (a DM answer, a timer, a payment webhook) are appended to the relevant conversation as timestamped event messages. Stale replies and "who answered what" become things the model reads.
- Channel adapter: Linq (own number). WhatsApp adapter possible later.
- Evals from day one: score against real DM and group message sets before any real traffic.

## Milestones

1. DM only: one person plans with Kwaku end to end (propose, lock, pay link, reminder, morning-after).
2. Groups: shared plan object, DM fan-out for answers, report back to the group.
3. Errands beyond planning.

## Non-goals for now

- Copying any existing planning codebase. Lessons yes, code no.
- Multi-server deploys. One instance until it earns two.
