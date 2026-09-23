# PA

A general-purpose agent that lives in your texts. It plans things with you and your friends, runs errands in the chat, and talks like a person.

Private. Owned by omarionnn. Not affiliated with any other product or organization.

## The one idea

The model is the controller. It reads every message, decides what to do, calls a tool, sees the real result, and writes from that. There is no regex router and no state machine deciding intent before the model sees the turn. Guards live inside tools, never in routing.

## Docs

- `docs/design.md` — what PA can do, what stays in code, architecture, first milestone.

## Status

Day 0. Design only. See `docs/design.md`.
