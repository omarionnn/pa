# Reason iPhone app API, v1

The contract for the Swift client. The app holds no logic: every state, word and rule below comes from the server.

- Base: `https://app.heyreason.com/ios/v1`. Behind `REASON_IOS_API` (`off` by default, `owner`, `on`). Off, every path is the server's flat 404, `{"error":"not found"}`.
- **Owner mode** (what is live now): everyone but the signed-in owner gets that flat 404 on every route. That includes `POST /auth/code` even when a code was sent, so the answer never says which number is the owner's. While in this mode the app goes to the code screen whatever that call answers, and treats a flat 404 from any later route (no `"ok"` field) as signed out or a wrong code.
- JSON, UTF-8, `snake_case`. Times are Unix milliseconds. Money is integer cents with a `currency`.
- Successful answers carry `"ok": true`. Failures carry `"ok": false` and an `error` code.
- Every response is `Cache-Control: no-store`. Anything marked `"private": true` is the app's to frost until Face ID.
- A breaking change gets `/ios/v2`. New fields may appear in v1 at any time, so ignore fields you don't know.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `bad_request`, `bad_id`, `confirm_required`, `empty` | Malformed, or the required confirmation is missing. `bad_id` is a `POST /messages` id outside 8–64 of `A-Z a-z 0-9 -` |
| 403 | `refused` | `POST /messages`: this account can't be served |
| 401 | `signed_out` | No valid session on this device. Clear the token and show sign-in |
| 401 | `wrong_code` | The code didn't open anything. Same for every kind of miss |
| 404 | `not_found` | Not there, or not yours. The two are deliberately identical |
| 405 | `method_not_allowed` | |
| 409 | `same_as_another`, `not_corrected` | A correction that couldn't be applied |
| 413 | `too_long` | Over 500 characters for a memory correction, 4,000 for a message |
| 429 | `rate_limited`, `slow_down` | This device is asking too often (`slow_down`: sending messages too fast) |
| 500 | `server_error`, `failed` | `failed`: a message couldn't be handed to Reason |
| 503 | `try_again`, `unavailable` | `try_again`: a forget couldn't be worked out yet; nothing changed, offer it again. `unavailable`: the service isn't ready to take messages |

## Signing in

Sign-in is by phone number, against the Reason account that number already has. Numbers with no Reason get the same answers as numbers with one; the app sends new people to text Reason first.

**`POST /auth/code`** `{ "phone": "+15551234567", "challenge": "<32–128 url-safe chars>" }` → `202 { "ok": true, "code_ttl_s": 900 }`

Generate `challenge` randomly per attempt, keep it in memory, and send the same value to `/auth/verify`.

**`POST /auth/verify`** `{ "phone", "challenge", "code": "123456", "device_name": "Ama's iPhone" }` → `200 { "ok": true, "token": "…", "expires_in_s": 7776000, "first_name": "Ama" }`

Store `token` in the Keychain. Send it as `Authorization: Bearer <token>` on every other route; it is never accepted in a URL. A session lasts a flat 90 days from sign-in, however long it goes unused, and can be revoked at any time. After that every route answers `401 signed_out`.

**`GET /auth/sessions`** → `{ "sessions": [{ "id", "name", "created_at", "last_seen_at", "current": true }] }`. Only app sessions. `id` is a server-side hash and opens nothing.

**`DELETE /auth/sessions/{id}`** revokes one device. **`DELETE /auth/session`** signs this device out.

App sessions also appear under "signed-in browsers" in Reason Web Settings and can be signed out there. A Web browser's session is not accepted by this API.

## The Page

**`GET /page`**

```json
{ "ok": true, "as_of": 1762668000000, "empty": false,
  "sections": { "in_progress": [Item], "done": [Item], "failed": [Item], "open_offers": [Item] } }
```

`empty: true` means there is nothing real to show. Draw the quiet page; never fill it in. `done` and `failed` hold the last 72 hours, newest first.

Every `Item` has `id`, `kind` (`task`, `timer`, `series`, `approval`, `call`, `purchase`, `checkout`), `state`, `title`, `at`, `started_at` and `private`. `id` is the kind and the record's id (`"task-12"`, `"call-7"`), except a checkout's, which is `run-` and the checkout run's own id (`"run-r_8f2a"`), not a number. Treat ids as opaque strings. By `state`:

| `state` | Section | Extra fields |
|---|---|---|
| `working` | in_progress | `summary`, `steps[{text,state,at}]`, `steps_recorded`, `calling` |
| `waiting` | in_progress | `summary`, `waiting_on`, `next_check_at` |
| `stuck` | in_progress | `summary` |
| `scheduled` | in_progress | `summary`, `next_at`, `every`, `call` |
| `ready` | done | `finished_at`, `result{headline,facts[],note}` |
| `failed` | failed | `finished_at`, `failure{why,did_next}`, `nothing_charged` |
| `needs_you` | open_offers | `ask{summary,detail,total,rows[[label,value]],money,asked_at}` |

The extra fields above are a task's. A call, purchase or checkout with no task behind it carries fewer:

- **Call:** `working` has `summary: null` and `calling: true`, no steps. `ready` has `result` with `headline: null`, `facts: []` and the call's summary as `note`. `failed` has `nothing_charged: true`.
- **Purchase:** `ready` and `waiting` also carry `amount_cents` and `currency`. A purchase waiting on approval is `waiting` with `summary`.
- **Checkout:** `working` has `summary: null` only. `ready` has an empty `result`.

Step `state` is `todo`, `doing` or `done`. `steps_recorded` is false when the steps were rebuilt from Reason's log rather than kept as a checklist.

`failure.did_next` is what Reason recorded it did or will do next. It is `null` when nothing was recorded, which is true today for failed standalone calls, purchases and checkouts. Show that honestly; don't write a next step on the client.

`open_offers` holds approvals Reason asked for in the last 24 hours and tasks waiting on one answer. Silence is a no: an approval leaves this list on its own after 24 hours.

## A receipt

**`GET /items/{id}`** → `{ "ok": true, "item": Receipt }`

For a task, timer, series or approval, a `Receipt` is the `Item` plus:

```json
{ "as_of": 0, "steps": [{ "text": "", "state": "done", "at": 0 }],
  "log": [{ "text": "", "at": 0 }],
  "cost": { "charged_cents": 1200, "charged_known": true, "currency": "usd",
            "lines": [{ "label": "Walmart", "amount_cents": 1200, "charged": true, "status": "placed" }] },
  "artifacts": [ Artifact ] }
```

A call, purchase or checkout receipt is its own shape, not the Page's `Item`: `id`, `kind`, `state` (`working`, `ready` or `failed` only), `title`, `private`, `at`, `started_at`, `finished_at`, `summary`, plus `as_of`, `steps` (always `[]`), `cost` and `artifacts`. A call adds `duration_s`; a purchase adds `items: [{ "name", "qty" }]`. They don't carry the Page's state extras (`result`, `failure`, `nothing_charged`, `calling`, `amount_cents`). A purchase waiting on approval is `waiting` on the Page and `working` here. `at` is the same moment the Page item shows: when a live call started, else when the call, purchase or checkout last changed.

`cost` is money charged to the person, not what the work cost Reason to run. `charged_cents` is `null` and `charged_known` is `false` when an outcome is unknown; never show a number then. `log` is on tasks only.

| `Artifact.type` | Fields |
|---|---|
| `recording` | `url`, `seconds`, and on a task `call_id`, `call_title` |
| `transcript` | `text`, and on a task `call_id`, `call_title` |
| `confirmation` | `order_id`, `delivery_window` |
| `approval` | `summary`, `approved_at`, `you_said` |

**`GET /calls/{id}/recording`** (or `HEAD`) returns audio bytes playable on iPhone, with `Range` support, under the same bearer token.

## Live updates

**`GET /live`** with `Accept: text/event-stream` and the bearer header.

| Event | Data |
|---|---|
| `page` | The full `/page` body. Always sent first, then on every change |
| `ping` | `{}` every 15 s. A connection silent for 40 s is dead: reconnect |
| `message` | A `Message`, as it's written, with an SSE `id` (the message id) |
| `done` | `{ "reply_to": 41, "answers": [40, 41], "last_reply": 43, "at": 0 }`. A turn ended. Sent after the `message` events for its replies |
| `typing` | `{ "on": true, "until": 0 }` while Reason works on a message from the app |
| `signedout` | `{}`. This device was revoked. The stream ends; clear the token |

A change reaches the stream within 1 second. The stream closes every 30 minutes; reconnect after the `retry:` hint (1.5 s). The Page needs no resume because each connection starts with the whole Page. Messages resume from `Last-Event-ID` (or `?after={id}`); a fresh connection starts from now, so load history with `GET /messages`. Each person gets 3 streams at once, and a fourth closes the oldest.

**Why SSE, not WebSocket.** Updates only flow server to app, and the app's actions are ordinary requests. SSE runs over the HTTP path already in place, carries the same bearer header, and works directly with `URLSession.bytes`. A WebSocket would add an upgrade path, a framing layer and a second auth check to get a return channel nothing would use.

**How the 1 second holds.** State reaches the database from many places, most with no event to hook. Each open stream polls a small per-person fingerprint every 400 ms and only rebuilds the Page when it moves.

## Talking to Reason

A message from the app is the same as a text. It runs the same turn, so reminders, calls, messages to other people and purchases are real, and every confirmation, Face ID step and spend limit applies unchanged. Face ID for a purchase comes as a link in Reason's reply.

**`POST /messages`** `{ "id": "<8–64 chars, A-Z a-z 0-9 ->", "text": "…" }` → `{ "ok": true, "id": "…", "duplicate": false }`

Make `id` a fresh UUID per message and reuse it on a retry: a repeated `id` is not run twice (`duplicate: true`). `200` means Reason took it, not that it has answered. Up to 4,000 characters. `429 slow_down` when sending too fast, `403 refused` when this account can't be served, `503 unavailable` when the service isn't ready.

**`GET /messages`** newest 50, oldest of them first. `?before={id}` pages back, `?after={id}` catches up, `?limit=` up to 100.

`Message` is `{ "id", "role": "user|reason", "text", "at", "via": "app_or_web|text", "client_id", "attachments": [{ "name" }], "reply_to", "turn_done", "turn_done_at" }`. `client_id` is your `id`, so an optimistic line can be matched. Texts appear too, since it's one conversation. Attachment bytes aren't served by this API yet.

### Which message a reply answers

One message (or several sent close together) gets one turn, and a turn can send several replies.

- **`reply_to`**, on Reason's messages: the `id` of the person's message it answers. Every reply the turn sends to this person carries it. Several messages answered by one turn: it names the newest of them at the moment that reply was sent. `null` when the message answers nobody: a reminder going off, a call's outcome, anything Reason says unprompted, and anything Reason wrote before this field existed (2026-11-10).
- **`turn_done`**, on Reason's messages: `true` on the last reply of a turn that has ended. While the turn runs every reply is `false`, so a live `message` event always says `false`; the `done` event says which one was last.
- **`turn_done_at`**, on the person's messages: when the turn answering it ended, `null` while it runs. A turn that ends with no reply at all still sets it. `null` too on messages from before this field existed, and while the message is waiting for Reason to be back after an outage.
- **`done`** on `/live`: `reply_to` is the message the turn last answered, `answers` every message it answered (its `turn_done_at` is now set), `last_reply` the `id` of its last reply or `null` when it sent none.

So the app shows Reason as working on a message from the moment it's sent until `done` names it (or `turn_done_at` is set), with no quiet timer. A `done` missed while disconnected isn't replayed: after a reconnect, read `turn_done_at` on the pending message from `GET /messages`.

A reply sent after its turn ended (a retry of a text that failed to go out) still carries `reply_to`, but the `done` has already gone and names an earlier reply as last.

## What Reason knows

**`GET /memories`**

```json
{ "ok": true, "empty": false,
  "groups": [{ "key": "preferences", "title": "PREFERENCES", "memories": [Memory] }],
  "guesses": [{ "id": "guess-3", "text": "", "about": null, "source": Source, "private": true }] }
```

`Memory` is `{ "id": "fact-12", "kind": "fact|rule|why", "group", "text", "about", "source": Source, "private": true }`.

`Source` is `{ "kind", "label", "at", "quote" }`. `label` is the line to show ("You told me"). `quote` is their own words that it came from, when Reason still has them.

- **`POST /memories/{id}/correct`** `{ "text": "…" }` → `{ "ok": true, "id": "fact-13" }`. Correcting issues a new `id`.
- **`DELETE /memories/{id}`** forgets one memory for good, including from the message it came from. May answer `503 try_again`.
- **`POST /memories/guess-{n}`** `{ "answer": "yes" | "no" }`. Yes saves it as a fact (`id` returned); no dismisses it for good.
- **`POST /memories/forget-everything`** `{ "confirm": "FORGET EVERYTHING" }` → `{ "ok": true, "removed": { "person_facts": 12, … } }`

Face ID for this screen is the app's to enforce. The server can't observe it, so these routes rely on the device session and, for forget-everything, the confirmation string.

### What forgetting does, honestly

**Forgetting one memory**
- The memory's words are removed from the database, including any older wording a correction replaced. A fact keeps a one-way fingerprint so Reason can't re-learn the sentence from messages it re-reads. If the person says it again themselves, it comes back.
- **It comes out of the message it was learned from.** A model marks the exact words that state it and code cuts only those, so everything unrelated stays word for word. If nothing else remains and the message carried no file, the message is gone.
- That applies to every stored copy of that message: chat history, the thread Reason reads, inbound records and sent records. In the thread Reason reads, an emptied turn keeps a `[deleted at their request]` marker so the thread stays valid.
- What was derived from that message goes too: its search vectors (the run is indexed again from what is left), knowledge-graph mentions and relationships cited to it, names left with nothing behind them, and the saved profile, which is rebuilt.
- It also leaves memory tool results, and Reason's own replies wherever they used the exact wording.
- If the model can't mark the words, the answer is `503 try_again` and nothing has changed. A forget is never reported done with the source message still holding it.
- **What it can't reach:** a different message that said the same thing but isn't recorded as the source, and a file or photo attached to the source message. Other memories learned from that same message stay, each forgettable on its own.

**Forgetting everything**
- Removes all facts, people, reasons, rules, guesses, preferences, search vectors, the profile, the knowledge graph, memory review records, the chat history and the thread Reason reads.
- Also empties stored copies of what was said: inbound records, sent-message text, messages waiting to be read, and what was read from files. A text still queued to go out is left to send.
- Keeps the account, orders, spend records, reminders, open tasks, pages and documents Reason made, and call records including recordings and transcripts. Receipts stay and promises keep running, but Reason can no longer search those records.
- A reply being written at that instant can save its own turn afterward. Avoid offering this while a turn is running.

**On the live database**, both run with SQLite `secure_delete` and then truncate the write-ahead log, so the freed bytes are overwritten rather than just unlinked. A test reads the raw database files to confirm the words are gone.

**In backups**, forgetting does not reach into a copy that already exists:
- The on-server rolling backup is replaced twice a day, so it holds the old words, including the original message, for at most about 12 hours.
- The encrypted off-site backup keeps 7 daily snapshots, so the memory and the original message can remain there for up to about 8 days, then age out when that snapshot is pruned. Nothing edits a snapshot in place.
- A restore from a backup would bring forgotten data back. After any restore, forgets made since that backup would have to be re-applied; nothing does that automatically yet.
- Any one-off database copy left on the server is outside this. Those must be removed before this promise is made to people.

**Outside Reason's own storage**: texts remain on the person's phone and with the texting and call providers, and the model provider keeps whatever its own retention terms allow. Forgetting here does not reach them.

## Not in this API yet

Native shopping and native Face ID pay, attachments, push and Live Activity delivery, and everything else outside the routes above.
