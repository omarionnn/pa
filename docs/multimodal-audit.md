# Multimodal audit: what Reason actually does today

Against Omari's spec "Build a context-aware multimodal assistant for iMessage" (received 2026-10-05).
Written before anything was built, so the gaps are the ones the code really has rather than the ones
left over after a fix. Every row names a file and a line. A comment claiming a behaviour is not
evidence of it; where the only thing holding a requirement up is a sentence in the system prompt,
the row says so and does not call it a pass.

Verdicts:

- **passes (has a test)** — the code does it and `npm run test:offline` would catch it breaking.
- **passes (no test)** — the code does it; nothing would notice if it stopped.
- **partly** — some of it, or only in the prompt with no guard, or only on one backend.
- **fails** — it does not happen.
- **cannot be known offline** — needs a real iPhone or the real provider.

Baseline at the time of writing: 954 tests, 923 pass, 0 fail, 31 skipped (the skipped ones are the
live-model tests, which need a key).

## Two facts that sit over the whole of section 1

They are here rather than in a row because they decide the outcome of most of the photo
requirements before any of them get a chance to apply.

1. **An iPhone photo cannot be looked at at all.** `src/media.js:48-54` lists `.heic`/`.heif` as
   known-unreadable and `src/media.js:66-74` turns them into a refusal, because Claude's vision
   endpoint takes JPEG, PNG, GIF and WebP only (`src/media.js:9-13`). HEIC is what an iPhone shoots
   by default. So the spec's whole first section — a car photo, a screenshot of a listing — lands on
   "that came through as a heic" for the person this is being built for, unless they have turned
   "Most Compatible" on in Settings. This is honest, and it is also the single biggest gap in the
   spec.
2. **On the backend the live Reason runs, no photo reached the model at all — fixed 2026-10-05,
   after it failed on a real phone.** `REASON_BACKEND=claude-cli` routes turns through
   `src/backends/claude-cli.js`, which used to replace every image with one sentence saying it could
   not be looked at. So the HEIC conversion, the photo-in-context rules and the record were all
   correct on the API path and did nothing for the Reason anybody actually texts: a photo from an
   iPhone got "i can't open photos on this setup". The belief behind it — "the CLI takes its prompt
   as a string" — was wrong: `--input-format stream-json` takes a user message with a base64 image
   block, with `Read` still denied (`cliInvocation` in `src/backends/cli.js`). Now both backends call
   the same `imagesFor`. **Proved once with the real model on the subscription**, on the same JPEG
   that had failed (`IMG_4278.JPG`, 974 KB, one turn, no tool denials). **Not yet seen on a phone**,
   and a HEIC straight off an iPhone camera has not come through at all: Sendblue delivered that
   photo as a JPEG. Where a row below says "on the API backend", it now holds on both.

## The 12 acceptance tests

| # | Acceptance test | What happens today | Verdict |
|---|---|---|---|
| 1 | Earlier car-buying interest + uncaptioned car photo gives a contextual question, not a purchase assumption | On the API backend the image block goes in ahead of the text (`src/media.js:161-180`, `src/agent.js:126-135`) and the thread history is loaded (`agent.js:148`), so the model has both. Nothing anywhere tells it to join them, and nothing forbids "congrats". The only photo instructions in either prompt are `agent.js:67` ("you can look at pictures") and `agent.js:68` (what to say when one could not be read) | **fails** |
| 2 | The same photo with no relevant context gives a neutral question; with an explicit question, it answers that question | No instruction for either half. `agent.js:44` says "One question at a time" and `agent.js:47` says "Read the whole message"; neither is this | **fails** |
| 3 | "No, that's my friend's car" corrects future replies without retaining ownership as fact | Nothing tells the model a correction replaces an earlier reading. Worse, `remember` (`src/tools.js:768-777`, handler `tools.js:2209`) will store any string it is handed as a durable fact about a person, with no distinction between "they told me this" and "I guessed this from a picture" | **fails** |
| 4 | A delayed voice transcript is interpreted in context and produces only one substantive response, including after duplicate notifications | Duplicates: `src/router.js:141` claims the provider's `message_handle` in `inbound_messages` (UNIQUE, `src/db.js:151-158`) before anything runs — tested as "a retried delivery does not answer twice". Delay: there is no delayed path. `router.js:267` transcribes inline inside the turn (`src/voice.js:264-279`), so the transcript is never late relative to the reply. A second webhook carrying audio under a *different* handle would be a second turn | **partly** |
| 5 | Unclear speech and audio without speech produce honest, distinct responses rather than invented words | No speech: `voice.js:228` returns `silent: true` and `heardLine` (`voice.js:248`) says "nothing was said" — tested. Unclear: the transcriber is told to write `[inaudible]` (`voice.js:212`) and `heardLine` warns a transcript can mishear, but there is no distinct state for it, no instruction to ask about the unclear words specifically, and no test | **partly** |
| 6 | A video with captions produces a caption-based summary that does not claim visual review; audio-only and partial processing disclose their coverage | `src/video.js:581-620` returns a `how` field per tier, and `video.js:384` (`BLIND`) forbids visual claims on a words-only tier. `agent.js:89` repeats the rule and says the tier is not the model's to choose. Trimming and the length cap report themselves (`video.js:444`, `598`, `620`). Tested throughout `test/video.test.js` | **passes (has a test)** |
| 7 | An inaccessible video or webpage produces a limitation, not a fabricated summary | Video: `video.js` returns the real reason, tested ("private, age-gated, members-only and region-blocked each come back as the reason"). Webpage: `src/weblookup.js:83-86` returns `ok: false` with the status, and `agent.js:92` forbids answering as if it had read it — but that is prompt-only and no test covers the claim | **partly** |
| 8 | A link and summary arrive as two separate ordered messages; test native preview rendering on an iPhone | Nothing splits them. `src/deliver.js:46-86` sends whatever single string the model wrote, and `agent.js:65` actively asks for "the link with one line about what is on it", i.e. one bubble. The preview card itself is **cannot be known offline** | **fails** |
| 9 | Multiple attachments and links remain correctly associated through slow processing, retries and follow-up questions | No per-item record of any kind exists. `inbound_parts` (`db.js:166-176`) keeps each part's attachments as JSON for the preview rule and nothing reads it afterwards. There is no way for the model to refer to "the second photo". And `src/parts.js:82-96` silently drops an image part whose message text contains a URL — a photo sent in the same breath as a link is eaten, which its own comment admits (`parts.js:25-30`) | **fails** |
| 10 | Context from one user cannot appear in another user's replies | Every table is keyed by `conversation_id`, admission happens before the queue (`router.js:93-111`), and a conversation id is derived from the address (`src/accounts.js`). Tested in several files — "nothing one person has is reachable from another's Reason", "one person's memory is not another conversation's" | **passes (has a test)** |
| 11 | Instructions embedded in media cannot trigger unrelated actions or data disclosure | The structural guard holds: the confirm gate reads the owner's own messages out of their own conversation (`src/trust.js:42-48`, `requestConfirmation` at `:53`), so no string inside a photo or a page can produce a yes, and that is tested. But nothing *marks* media content untrusted. `google.untrusted()` (`src/google.js:523-533`) wraps mail and calendar only; a web page (`tools.js:3573`), a video account (`tools.js:3649`) and a voice transcript (`voice.js:246-250`) all go to the model unwrapped. No test uses media as the injection source | **partly** |
| 12 | A car photo never triggers a purchase or seller contact | Same gate, same `OUTSIDE_WORLD` set (`tools.js:37`), tested — but never with a photo as the trigger | **partly** |

## Section 1 — conversation-aware photos

Requirements numbered by sentence; the spec does not number them itself.

| # | Requirement | Today | Verdict |
|---|---|---|---|
| 1.1 | Analyze the image and combine what is visible with relevant earlier messages from the same conversation | Plumbing is there and tested: images as blocks before the text (`media.js:161-180`, `agent.js:126-135`, test "the model gets the picture before the text; the history gets a line instead"), history loaded and trimmed (`agent.js:137-141,148`). No instruction to combine them | **partly** |
| 1.2 | Keep explicit user statements separate from guesses | Nothing. The history records "they sent a photo; you looked at it when it arrived" (`media.js:172`) and the reading itself survives only as whatever the model wrote | **fails** |
| 1.3 | Do not invent an exact model, price, ownership or purchase from a photo | `agent.js:101` forbids a price or spec that did not come from a source this turn, which half-covers price. Nothing covers a model name, ownership or a purchase having happened | **partly** |
| 1.4 | Uncaptioned photo after "thinking about buying a car" gets a question, never "congrats" | Nothing | **fails** |
| 1.5 | Weak connection to earlier context → short clarifying question rather than forcing it | Nothing | **fails** |
| 1.6 | An explicit question with the image is answered first | Nothing | **fails** |
| 1.7 | Several photos on one message are considered together | `router.js:282` flattens every held message's attachments into one turn and `media.js:161-180` emits a block per readable image, in order. Tested: "a burst's pictures all reach the one turn, in the order they arrived". Caveat: `parts.js:82-96` can drop them first (see acceptance test 9) | **passes (has a test)** |

## Section 2 — voice and audio

> **Seen on a phone, 2026-10-05.** The owner sent voice notes to the live Reason from his iPhone and
> reported that they "work perfectly". That is the whole of what is known: which cases he tried was
> not said, so it settles the ordinary case — a spoken note heard and answered — and nothing else.
> Unclear words, a note with no speech, a late or duplicated delivery and a failed transcription
> are still proved by tests only.

| # | Requirement | Today | Verdict |
|---|---|---|---|
| 2.1 | Transcribe incoming voice messages when speech is available | `voice.js:161-230` fetches, converts Apple's `.caf` to WAV via afconvert/ffmpeg (`src/expressive.js`), and transcribes with Gemini. Called from `router.js:267`. Tested: "hear downloads the note, turns Apple's format into WAV, and returns the words" | **passes (has a test)** |
| 2.2 | Interpret the transcript in the ongoing conversation, like text | `heardLine` (`voice.js:246-250`) says "treat it as their message"; `agent.js:74` tells the model not to make a thing of it. Tested: "a voice note they send reaches the turn as the words in it" | **passes (has a test)** |
| 2.3 | Audio arriving after its first notification is answered once, including on duplicate webhooks | Duplicates are claimed on the handle (`router.js:141`) and tested. There is no two-stage notification/audio path at all: Sendblue puts `media_url` on the same `receive` event (`src/channels/sendblue.js:868`), and listening is inline (`router.js:267`), so "late audio" has no representation. A later part under a `_N` handle would be a separate claim and a separate turn | **partly** |
| 2.4 | Distinguish waiting, processing, ready, failed and no-speech | Three of five are distinct and tested: ready (`voice.js:229`), no-speech (`:228`, `heardLine:248`), failed (`couldNotHearLine:252-255`) — plus a fourth, "nothing on this machine can listen", which `hearingStatus` (`voice.js:50-53`) returns as `unavailable` and `hearInto:272` skips, tested as "what cannot be listened to at all is 'unavailable', which is different from 'failed'". Waiting and processing do not exist, because the transcription happens inside the turn | **partly** |
| 2.5 | Unclear words that affect the answer get asked about | `voice.js:212` asks the transcriber for `[inaudible]` rather than a guess, and `heardLine:249` tells the model to check a name or number something hangs on. Nothing points at the `[inaudible]` stretch specifically; no test | **partly** |
| 2.6 | Never fill gaps with made-up speech | `voice.js:212` (transcriber instruction) and `couldNotHearLine:254` ("do not guess at what it said"), with `agent.js:74` repeating it. Tested: "a note that could not be heard says exactly why, and tells the model not to guess" | **passes (has a test)** |
| 2.7 | Preserve timing or transcript references for checking specific claims | Actively thrown away: `voice.js:212` instructs "no timestamps, no speaker labels". Nothing is kept but the words | **fails** |

## Section 3 — video and YouTube links

| # | Requirement | Today | Verdict |
|---|---|---|---|
| 3.1 | Try accessible captions or a transcript first | Captions tier via yt-dlp, preferred when present. Tested: "captions are preferred when they are there, so nothing is spent" | **passes (has a test)** |
| 3.2 | Then authorized access to audio and speech-to-text where permitted | `video.js:428` picks `watch` for YouTube (the link goes to Gemini) and `listen` for anything else (audio track only, uploaded, transcribed). Tested: "listening downloads the AUDIO ONLY, hands over a real file, and deletes it" | **passes (has a test)** |
| 3.3 | Do not bypass sign-in, paywalls or access restrictions | No cookie, no login, no age-gate flag anywhere in `video.js`; each refusal comes back as the reason. Tested | **passes (has a test)** |
| 3.4 | Neither route works → explain the limitation and ask for an upload or a transcript | The limitation is explained and tested. Nothing asks for an upload or a transcript, and an uploaded video could not be used if offered: `sendblue.js:960-968` classifies an `.mp4` as `kind: "file"` and `describe()` at `:1000` says "they sent a file, which you cannot open" | **partly** |
| 3.5 | Say what was actually reviewed; "I reviewed the captions" ≠ seeing the video | `video.js:581-620` `how`, plus `agent.js:89` spelling out captions/watch/listen/metadata and saying the tier is not the model's to choose. Tested per tier | **passes (has a test)** |
| 3.6 | Do not claim visual details from audio alone | `video.js:384` `BLIND` is appended to every words-only tier, and `agent.js:89` repeats it. Tested | **passes (has a test)** |
| 3.7 | If frames are supported, say whether selected frames or the full sequence; sampled frames are partial | Reason samples no frames. A YouTube link is handed whole to a video model (`video.js:415-428`) and nothing else is ever looked at, so there is no partial-visual claim to qualify. Nothing to test and nothing claimed | **passes (no test)** |
| 3.8 | Report missing sections, unreliable captions or partial transcription when they matter | Trim notes (`video.js:598`, `620`) and the length cap (`video.js:444`) both report themselves, auto captions are labelled auto, and the rolling duplicates are stripped. Tested: "three hours comes back trimmed, says exactly what is missing, and names the follow-up" | **passes (has a test)** |
| 3.9 | Keep timestamped evidence; separate source statements from interpretation | Caption lines keep their real timestamps and the tests assert them. The separation is structural — the account sits under `heard`/`watched` with `saw` saying what was looked at (`video.js:590-593`) — but nothing is wrapped as untrusted (see 5.11) | **passes (has a test)** |

## Section 4 — links and separate iMessage bubbles

**What Sendblue's docs actually say about link previews**, read 2026-10-05:

- `POST /api/send-message`'s full parameter table (getting-started/sending-messages) is `number`,
  `from_number`, `content`, `media_url`, `app_card`, `send_style`, `status_callback`, `seat_id`,
  `reply_to`, `pre_reply_override`. **There is no rich-link or link-preview parameter.**
- The only mention of link previews anywhere in the docs is in guides/contact-card, about the
  recipient adding the sender to their contacts: "it allows any links you send to expand on the end
  users phone". So whether a bare URL becomes a card is Apple's doing, on the recipient's device,
  and is conditioned on something Reason does not control.
- `app_card` (api-v2/app-cards) is **not** a link preview. It requires `extensionBundleId`, a
  10-character Apple `teamId` and a Messages extension the recipient has installed. Reason has no
  iOS app and no Apple Team ID, so this path is closed, not merely unused.

Conclusion: send the bare URL as its own message and say nothing about a card. Whether iMessage
renders one is unproved and only a real iPhone can settle it.

| # | Requirement | Today | Verdict |
|---|---|---|---|
| 4.1 | The URL goes as its own message with no surrounding summary | Nothing splits a reply. `deliver.js:46-86` sends one string; `outbox.sendDurable` (`src/outbox.js:61`) makes one row per logical message | **fails** |
| 4.2 | Any summary goes in a separate text message | Same | **fails** |
| 4.3 | Do not bury the link inside a long paragraph | The prompt asks for the opposite: `agent.js:65` says send "the link with one line about what is on it" | **fails** |
| 4.4 | Keep each link-summary pair in order; never mix summaries between links | No pairing exists to keep in order | **fails** |
| 4.5 | Use documented rich-link support if the provider has it; otherwise a standalone URL, documented as "the client may render a preview", never promised or faked | None of it. Nothing claims a card either, so nothing is currently a lie — but nothing is built | **fails** |
| 4.6 | Verify the actual result on an iPhone | — | **cannot be known offline** |
| 4.7 | Fetch readable page content when a summary is appropriate | `weblookup.js:46-104` and the research tool; tested in `test/site.test.js`, `test/research.test.js` | **passes (has a test)** |
| 4.8 | Do not summarize a page you could not access as though you read it | `weblookup.js:83-86` returns the real failure, and `agent.js:92` forbids the claim — prompt-only, no guard, no test of the claim | **partly** |
| 4.9 | When only a title or snippet is available, identify that limited coverage | `weblookup.js:59-61` sets `text_truncated`, and `agent.js:102` forbids a snippet standing in for a page. Prompt-only for the claim | **partly** |
| 4.10 | A pasted link alone does not authorize enrollment, purchase or another action | The gate and `OUTSIDE_WORLD` (`tools.js:37`, `trust.js`) hold and are tested in general; no test drives a pasted link at them | **partly** |

## Section 5 — context, reliability and privacy

| # | Requirement | Today | Verdict |
|---|---|---|---|
| 5.1 | Conversation state isolated by user and conversation | Every table keyed by `conversation_id`; admission before the queue (`router.js:93-111`). Many tests | **passes (has a test)** |
| 5.2 | Use relevant recent history and stated interests; never another person's | `agent.js:148` loads that conversation only; `whoLine` (`agent.js:24-30`) refuses to use the operator's name or city for anyone else. Tested | **passes (has a test)** |
| 5.3 | A user correction replaces an earlier interpretation | Nothing. And `remember` (`tools.js:768-777`, `2209`) cannot tell a guess from something they said, so a reading taken off a photo can be saved as a durable fact about them and will outlive the correction | **fails** |
| 5.4 | Keep attachment/message references so "this one" resolves later | Messages are addressable: handles and their text are stored (`router.js:141`), `replies.findByQuote` (`src/replies.js:46-57`) resolves a quote to a handle, and an inbound inline reply is explained to the turn (`replies.js:109-119`). Attachments are not: the model is given no identity for any individual photo, and the only row that holds them (`inbound_parts`, `db.js:166-176`) exists for the preview rule and is read by nothing else | **partly** |
| 5.5 | Record which media was processed and what coverage succeeded | No such record. Images: a log line with a byte count (`media.js:173`) and then gone. Voice: a log line with a character count (`voice.js:276`). Video: `video_accounts` (`db.js:495`) caches a transcript per video and tier, keyed by the video, not by the conversation or the message | **fails** |
| 5.6 | Duplicate notifications and retries never produce duplicate replies | `db.claimInbound` on UNIQUE(channel, external_id) before anything else (`router.js:141`, `db.js:151-158`); outbound has its own "never twice" in `outbox.js:69-75`. Tested both ways | **passes (has a test)** |
| 5.7 | Preserve conversation order even when media processing is slow | `Runtime.enqueue` (`src/runtime.js:115-120`) runs one conversation's turns strictly in order while different conversations run in parallel, and held messages are rows (`db.js:191-205`) so a slow or dead process loses nothing. Transcription happens inside the turn, so it cannot overtake anything. Tested in `test/burst.test.js` | **passes (has a test)** |
| 5.8 | Do not log raw private media or transcripts by default | Default is no logging at all (`src/serve.js:23-24` — `--log` is opt-in), and the media paths log counts rather than content (`media.js:173-176`, `voice.js:276`). But with `--log` on, `agent.js:225` writes every tool call's full input and output, which includes fetched page text and whole video transcripts | **partly** |
| 5.9 | Clear retention/deletion settings for anything stored | No retention setting exists and no sweep deletes anything. Transcripts live in `conversations` and `video_accounts` forever. Export and delete exist (`src/data.js:119`, `:201`) but `TABLES` (`data.js:23-35`) omits `inbound_messages`, `inbound_parts`, `pending_inbound`, `outbox`, `task_log`, `video_accounts` and the `research*` tables, so none of those are exported or deleted today | **fails** |
| 5.10 | File-size/type limits and URL validation on media downloads | Size: enforced twice for images, on the header and the real bytes (`media.js:132-149`), and once for audio (`voice.js:190`). Type: extension only — `media.js:60-64` and `sendblue.js:952-968` read the filename, never the bytes. URL validation: **none**. `media.js:102` and `voice.js:182` pass the provider's string straight to `fetch`, so any scheme, any host, including `http://` and `127.0.0.1`. `weblookup.js:71-73` checks the scheme only, allows `http:`, does not check the host, and `res.text()` at `:87` has no byte cap | **partly** |
| 5.11 | Instructions inside a webpage, image or video are content, never permission | The gate cannot be fed (`trust.js:42-48`), which is the part that matters, and it is tested. But the marking is missing: `google.untrusted()` (`google.js:523-533`) is used for mail and calendar only, while `web_lookup` (`tools.js:3573`), `video_understand` (`tools.js:3649`) and the voice transcript (`voice.js:246-250`) hand their content over unwrapped | **partly** |
| 5.12 | A photo or a link never triggers a purchase, a message to someone else, or a sign-up without a yes | `OUTSIDE_WORLD` (`tools.js:37`) plus the gate; `message_send`'s target check (`agent.js:84`). Tested in `test/trust.test.js` and `test/flow-gate.test.js`, never with media as the trigger | **partly** |
| 5.13 | Offering research is not the same as the user accepting it | Prompt only (`agent.js:90-91`); research spends no money and touches nobody, so there is no gate on it by design | **partly** |

## Where this leaves the build order

The order in the brief holds, with one change and one addition, both because of what is above.

1. **HEIC first.** Nothing in section 1 can be judged on a real iPhone until a photo gets through at
   all, and `/usr/bin/sips` is present on this machine (checked 2026-10-05). URL validation rides
   along with it, because it is the same function.
2. **Links as their own bubble.** Unchanged — it is a clean **fails** at the delivery layer.
3. **The record of what was sent and reviewed.** Moved ahead of the photo prompt work, because
   acceptance test 9 depends on it, 5.4 and 5.5 are both it, and the prompt rules in step 4 are
   easier to write honestly once there is something for "the second photo" to point at. It also has
   to carry a fix for `parts.js:82-96` eating a photo attached to a message with a link in it, or
   the record will faithfully report that nothing arrived.
4. **Photos in context** — the prompt, both backends.
5. **Voice** — mostly confirming; the real gaps are 2.4 (states), 2.5 (unclear words) and 2.7
   (timestamps, which means changing the transcriber instruction that currently forbids them).
6. **Privacy and retention** — 5.9 is the largest single gap, and the missing `TABLES` entries are
   part of it.
7. **Docs.**

Verdicts in this file are updated as each gap closes.
