# Reason iPhone app API, v1

The contract for the Swift client. The app holds no logic: every state, word and rule below comes from the server.

- Base: `https://<reason host>/ios/v1`. Behind `REASON_IOS_API` (`off` by default, `owner`, `on`). Off, every path is the server's flat 404.
- JSON, UTF-8, `snake_case`. Times are Unix milliseconds. Money is integer cents with a `currency`.
- Successful answers carry `"ok": true`. Failures carry `"ok": false` and an `error` code.
- Every response is `Cache-Control: no-store`. Anything marked `"private": true` is the app's to frost until Face ID.
- A breaking change gets `/ios/v2`. New fields may appear in v1 at any time, so ignore fields you don't know.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `bad_request`, `confirm_required`, `empty` | Malformed, or the required confirmation is missing |
| 401 | `signed_out` | No valid session on this device. Clear the token and show sign-in |
| 401 | `wrong_code` | The code didn't open anything. Same for every kind of miss |
| 404 | `not_found` | Not there, or not yours. The two are deliberately identical |
| 405 | `method_not_allowed` | |
| 409 | `same_as_another`, `not_corrected` | A correction that couldn't be applied |
| 413 | `too_long` | Over 500 characters |
| 429 | `rate_limited` | This device is asking too often |
| 500 | `server_error` | |

## Signing in

Sign-in is by phone number, against the Reason account that number already has. Numbers with no Reason get the same answers as numbers with one; the app sends new people to text Reason first.

**`POST /auth/code`** `{ "phone": "+15551234567", "challenge": "<32–128 url-safe chars>" }` → `202 { "ok": true, "code_ttl_s": 900 }`

Generate `challenge` randomly per attempt, keep it in memory, and send the same value to `/auth/verify`.

**`POST /auth/verify`** `{ "phone", "challenge", "code": "123456", "device_name": "Ama's iPhone" }` → `200 { "ok": true, "token": "…", "expires_in_s": 7776000, "idle_expires_in_s": 2592000, "first_name": "Ama" }`

Store `token` in the Keychain. Send it as `Authorization: Bearer <token>` on every other route; it is never accepted in a URL. A session ends 90 days after sign-in or after 30 days unused, the same limits as Reason Web, and then every route answers `401 signed_out`.

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

Every `Item` has `id` (`"task-12"`), `kind` (`task`, `timer`, `series`, `approval`, `call`, `purchase`, `checkout`), `state`, `title`, `at`, `started_at` and `private`. By `state`:

| `state` | Section | Extra fields |
|---|---|---|
| `working` | in_progress | `summary`, `steps[{text,state,at}]`, `steps_recorded`, `calling` |
| `waiting` | in_progress | `summary`, `waiting_on`, `next_check_at` |
| `stuck` | in_progress | `summary` |
| `scheduled` | in_progress | `summary`, `next_at`, `every`, `call` |
| `ready` | done | `finished_at`, `result{headline,facts[],note}` |
| `failed` | failed | `finished_at`, `failure{why,did_next}`, `nothing_charged` |
| `needs_you` | open_offers | `ask{summary,detail,total,rows[[label,value]],money,asked_at}` |

Step `state` is `todo`, `doing` or `done`. `steps_recorded` is false when the steps were rebuilt from Reason's log rather than kept as a checklist.

`failure.did_next` is what Reason recorded it did or will do next. It is `null` when nothing was recorded, which is true today for failed standalone calls, purchases and checkouts. Show that honestly; don't write a next step on the client.

`open_offers` holds approvals Reason asked for in the last 24 hours and tasks waiting on one answer. Silence is a no: an approval leaves this list on its own after 24 hours.

## A receipt

**`GET /items/{id}`** → `{ "ok": true, "item": Receipt }`

A `Receipt` is the `Item` plus:

```json
{ "as_of": 0, "steps": [{ "text": "", "state": "done", "at": 0 }],
  "log": [{ "text": "", "at": 0 }],
  "cost": { "charged_cents": 1200, "charged_known": true, "currency": "usd",
            "lines": [{ "label": "Walmart", "amount_cents": 1200, "charged": true, "status": "placed" }] },
  "artifacts": [ Artifact ] }
```

`cost` is money charged to the person, not what the work cost Reason to run. `charged_cents` is `null` and `charged_known` is `false` when an outcome is unknown; never show a number then. `log` is on tasks only.

| `Artifact.type` | Fields |
|---|---|
| `recording` | `url`, `seconds`, and on a task `call_id`, `call_title` |
| `transcript` | `text`, and on a task `call_id`, `call_title` |
| `confirmation` | `order_id`, `delivery_window` |
| `approval` | `summary`, `approved_at`, `you_said` |

**`GET /calls/{id}/recording`** returns audio bytes playable on iPhone, with `Range` support, under the same bearer token.

## Live updates

**`GET /live`** with `Accept: text/event-stream` and the bearer header.

| Event | Data |
|---|---|
| `page` | The full `/page` body. Always sent first, then on every change |
| `ping` | `{}` every 15 s. A connection silent for 40 s is dead: reconnect |
| `signedout` | `{}`. This device was revoked. The stream ends; clear the token |

A change reaches the stream within 1 second. The stream closes every 30 minutes; reconnect after the `retry:` hint (1.5 s). There is no resume token because each connection starts with the whole Page. Each person gets 3 streams at once, and a fourth closes the oldest.

**Why SSE, not WebSocket.** Updates only flow server to app, and the app's actions are ordinary requests. SSE runs over the HTTP path already in place, carries the same bearer header, and works directly with `URLSession.bytes`. A WebSocket would add an upgrade path, a framing layer and a second auth check to get a return channel nothing would use.

**How the 1 second holds.** State reaches the database from many places, most with no event to hook. Each open stream polls a small per-person fingerprint every 400 ms and only rebuilds the Page when it moves.

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
- **`DELETE /memories/{id}`** forgets one memory for good.
- **`POST /memories/guess-{n}`** `{ "answer": "yes" | "no" }`. Yes saves it as a fact (`id` returned); no dismisses it for good.
- **`POST /memories/forget-everything`** `{ "confirm": "FORGET EVERYTHING" }` → `{ "ok": true, "removed": { "person_facts": 12, … } }`

Face ID for this screen is the app's to enforce. The server can't observe it, so these routes rely on the device session and, for forget-everything, the confirmation string.

### What forgetting does, honestly

**Forgetting one memory**
- The memory's words are removed from the database, including any older wording a correction replaced. A fact keeps a one-way fingerprint so Reason can't re-learn the sentence from messages it re-reads. If the person says it again themselves, it comes back.
- It leaves their saved profile, search vectors and memory tool results. Wherever Reason wrote the exact wording in its own replies, that is replaced. The messages it was learned from can no longer be found by recall.
- **Their own messages stay in their chat history**, the same as Reason Web today, and a reply that said the same thing in other words is not changed. So the idea may still be in the recent thread Reason reads until that trims.

**Forgetting everything**
- Removes all facts, people, reasons, rules, guesses, preferences, search vectors, the profile, the knowledge graph, memory review records, the chat history and the thread Reason reads.
- Keeps the account, orders, spend records, reminders, open tasks and call records including recordings and transcripts. Receipts stay and promises keep running, but Reason can no longer search those records.
- A reply being written at that instant can save its own turn afterward. Avoid offering this while a turn is running.

**On the live database**, both run with SQLite `secure_delete` and then truncate the write-ahead log, so the freed bytes are overwritten rather than just unlinked. A test reads the raw database files to confirm the words are gone.

**In backups**, forgetting does not reach into a copy that already exists:
- The on-server rolling backup is replaced twice a day, so it holds the old words for at most about 12 hours.
- The encrypted off-site backup keeps 7 daily snapshots, so the old words can remain there for up to about 8 days, then age out when that snapshot is pruned. Nothing edits a snapshot in place.
- A restore from a backup would bring forgotten data back. After any restore, forgets made since that backup would have to be re-applied; nothing does that automatically yet.
- Any one-off database copy left on the server is outside this. Those must be removed before this promise is made to people.

**Outside Reason's own storage**: texts remain on the person's phone and with the texting and call providers, and the model provider keeps whatever its own retention terms allow. Forgetting here does not reach them.

## Not in this API yet

Reason doing work from the app (tap to write, margin notes, shopping and Face ID pay), push and Live Activity delivery, and everything else outside the routes above.
