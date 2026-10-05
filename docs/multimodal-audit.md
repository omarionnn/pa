# Multimodal audit: what Reason actually does today

Against Omari's spec "Build a context-aware multimodal assistant for iMessage" (received 2026-10-05).
First written before anything was built, so the gaps were the ones the code really had rather than
the ones left over after a fix. **Verdicts updated 2026-10-05, after all seven steps.** The original
wording of every row is in the first version of this file (`git log -p docs/multimodal-audit.md`)
rather than rewritten out of history, because what was wrong is the useful part.

A comment claiming a behaviour is not evidence of it. Where the only thing holding a requirement up
is a sentence in the system prompt, the row says so and does not call it a pass — which is why much
of section 1 still reads **partly** although the work is done: the rule is there, there is a test
that it is there, and the model obeying it is a live run.

Verdicts:

- **passes (has a test)** — the code does it and `npm run test:offline` would catch it breaking.
- **passes (no test)** — the code does it; nothing would notice if it stopped.
- **partly** — some of it, or only in the prompt with no guard, or only on one backend.
- **fails** — it does not happen.
- **cannot be known offline** — needs a real iPhone or the real provider.

Baseline when this was written: 954 tests, 923 pass, 0 fail, 31 skipped. **Now: 1,077 tests, 1,046
pass, 0 fail, 31 skipped** — the 31 skipped are the live-model tests, which need a key. The new ones
for this work are in `test/pictures.test.js`, `test/media.test.js`, `test/cli-photos.test.js`,
`test/links.test.js`, `test/reviewed.test.js`, `test/photos-in-context.test.js`,
`test/voice-states.test.js` and `test/privacy.test.js`.

## Two facts that sit over the whole of section 1

They are here rather than in a row because they decide the outcome of most of the photo
requirements before any of them get a chance to apply.

1. **An iPhone photo could not be looked at at all — fixed 2026-10-05.** HEIC is what an iPhone
   shoots by default and Claude's vision endpoint does not take it, so the spec's whole first
   section used to land on "that came through as a heic" for the person this is being built for.
   It is now converted before anything looks at it: `src/pictures.js` sniffs the real bytes rather
   than trusting the filename, and `sips -s format jpeg` (present on this machine, checked
   2026-10-05) turns HEIC, BMP and TIFF into JPEG on the way past. The address it downloads from is
   checked and re-checked at every redirect, so a CDN link that redirects to `127.0.0.1` does not
   walk past the first check. **Not yet proved end to end from a real iPhone camera**: in the one
   live test Sendblue delivered the photo as a JPEG, so the conversion path has only ever run
   against fixtures. See `docs/iphone-checklist.md`.
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
| 1 | Earlier car-buying interest + uncaptioned car photo gives a contextual question, not a purchase assumption | The plumbing was already there — image blocks ahead of the text, the thread's history loaded — and now both backends do it (`imagesFor`, called from `src/agent.js` and `src/backends/cli.js`). What was missing was any instruction to join the two, and that is now four rules in `systemFor`, which the CLI gets as well: what is in the picture, what they told you and what you are guessing are three different things; a photo arriving is not news about their life; "congrats on the new car" is named and forbidden. `test/photos-in-context.test.js` asserts every rule is in the prompt on both backends. **Whether the model obeys them is the model's**, and that needs a live run | **partly** |
| 2 | The same photo with no relevant context gives a neutral question; with an explicit question, it answers that question | Both halves are now rules: a question sent with a picture is answered first, a picture with nothing around it gets one short question rather than a story, and a thin connection is called a guess or asked about. Prompt, with a test that the prompt says it | **partly** |
| 3 | "No, that's my friend's car" corrects future replies without retaining ownership as fact | Two parts, and the second one is code's. The prompt says a correction replaces the reading from that moment and is not argued with. Behind it, `remember` now takes a `source` and refuses anything but `they_said` — a fact read off a picture or worked out is rejected and nothing is written (`src/tools.js`, tested). There is no code path from looking at a picture to a memory row at all. What the refusal rests on is the model naming its source honestly, which is a live-run question | **partly** |
| 4 | A delayed voice transcript is interpreted in context and produces only one substantive response, including after duplicate notifications | Duplicates are claimed on the provider's handle before anything runs, and `test/voice-states.test.js` drives the same note twice and a note arriving as a later part of a message it already answered: one turn, one item, both times. There is still no two-stage notify-then-audio path, because Sendblue puts `media_url` on the same event — so "delayed" here means a part arriving after the text it belongs to, which is tested, rather than audio arriving minutes later, which this provider does not do | **passes (has a test)** |
| 5 | Unclear speech and audio without speech produce honest, distinct responses rather than invented words | Both now distinct, both tested. Silence gets its own line ("that one came through silent") and its own state; `[inaudible]` stretches are counted off the marker the transcriber was asked for, and the turn is told to ask about that bit and only that bit and never to fill it in. `test/voice-states.test.js` covers the states, the lines and the counting | **passes (has a test)** |
| 6 | A video with captions produces a caption-based summary that does not claim visual review; audio-only and partial processing disclose their coverage | Unchanged and still good: a `how` per tier, `BLIND` on every words-only tier, trimming and the length cap reporting themselves, the tier not the model's to choose. Tested throughout `test/video.test.js` | **passes (has a test)** |
| 7 | An inaccessible video or webpage produces a limitation, not a fabricated summary | Video: the real reason comes back, tested. Webpage: the failure comes back with its status, and the record now says so too — a link that would not load is `failed` with the reason on the item, which `media_reviewed` reads back, so "did you read it" is answered from a row rather than from memory (`test/reviewed.test.js`). The model not claiming to have read it anyway is still prompt-only | **partly** |
| 8 | A link and summary arrive as two separate ordered messages; test native preview rendering on an iPhone | Done and tested: `src/links.js` splits a reply into the bare URL and then the words, one outbox row each, chained on `after_id` so the summary is not even due until the link is `sent` — proved across a 429 and a permanent failure in `test/links.test.js`. Each link keeps its own words. The preview card itself is Apple's, on the recipient's device, and Sendblue documents no parameter for it; nothing claims one | **passes (has a test)**, except the card: **cannot be known offline** |
| 9 | Multiple attachments and links remain correctly associated through slow processing, retries and follow-up questions | `media_items` is one row per photo, voice note, file and link, carrying which message it came on and which it was on that message, what coverage was got out of it and why — and `media_reviewed` is how the model resolves "the second photo" instead of guessing. Tested in `test/reviewed.test.js` and `test/voice-states.test.js`. One thing did NOT change: a picture on a message whose text contains a link is still dropped as a link-card thumbnail (`src/parts.js`), because Sendblue's payload has no field that tells a thumbnail from a photo. It is no longer silent — the drop is a row with its reason, so the record shows that a photo was eaten rather than it never having existed — but a photo sent in the same message as a link is still lost, and only real traffic settles whether that trade is right | **partly** |
| 10 | Context from one user cannot appear in another user's replies | Every table keyed by `conversation_id`, admission before the queue, and the new surfaces hold the line: a transcript is readable only by id and only inside its own conversation, and a scoped delete leaves another conversation's media alone (`test/privacy.test.js`) | **passes (has a test)** |
| 11 | Instructions embedded in media cannot trigger unrelated actions or data disclosure | The structural guard was always the point and it holds: the confirm gate reads the owner's own words out of their own conversation, so no string inside a photo or a page can produce a yes, and that is tested. The marking that was missing is there now — a fetched page and a video come back under `untrusted_content`, with a prompt rule saying what that means (`test/privacy.test.js`). A voice note deliberately is not marked: that is the person's own message | **passes (has a test)** |
| 12 | A car photo never triggers a purchase or seller contact | Same gate, same `OUTSIDE_WORLD` set, plus the prompt rule that nothing a photograph does not contain may be stated off one — no model, year, price, owner, or that anybody bought it. Still no test that drives a photo at the gate specifically; the gate itself is tested hard | **partly** |

## Section 1 — conversation-aware photos

Requirements numbered by sentence; the spec does not number them itself.

| # | Requirement | Today | Verdict |
|---|---|---|---|
| 1.1 | Analyze the image and combine what is visible with relevant earlier messages from the same conversation | Plumbing tested on both backends now (`test/media.test.js`, `test/cli-photos.test.js`): the picture goes in ahead of the text, the history is loaded and trimmed. The instruction to combine them is in the prompt and tested as being there | **partly** (the joining is the model's) |
| 1.2 | Keep explicit user statements separate from guesses | The rule is explicit — what is in it, what they told you, what you are guessing, never blurred; a guess said out loud as one. And the guard under it is real: `remember` refuses a fact sourced to a picture or a deduction, so a guess cannot become something Reason knows | **partly** |
| 1.3 | Do not invent an exact model, price, ownership or purchase from a photo | All four named in the prompt: not a model, a year, a price, who owns it, or that anybody bought it. "If it matters, ask" | **partly** |
| 1.4 | Uncaptioned photo after "thinking about buying a car" gets a question, never "congrats" | Named, with the words, as the worked example | **partly** |
| 1.5 | Weak connection to earlier context → short clarifying question rather than forcing it | Named | **partly** |
| 1.6 | An explicit question with the image is answered first | Named | **partly** |
| 1.7 | Several photos on one message are considered together | A burst's pictures all reach the one turn, in order — tested. The caveat is now narrower and recorded: the only picture still dropped is one on a message that also contains a link | **passes (has a test)** |

Everything in this section that says **partly** says it for the same reason: it is a rule in the
prompt with a test that the rule is in the prompt, on both backends. That is as far as offline
testing goes on a judgement call. What settles it is a live run, and `docs/unverified.md` lists
each one as its own line rather than letting the prompt stand in for the behaviour.

## Section 2 — voice and audio

> **Seen on a phone, 2026-10-05.** The owner sent voice notes to the live Reason from his iPhone and
> reported that they "work perfectly". That is the whole of what is known: which cases he tried was
> not said, so it settles the ordinary case — a spoken note heard and answered — and nothing else.
> Unclear words, a note with no speech, a late or duplicated delivery and a failed transcription
> are still proved by tests only.

| # | Requirement | Today | Verdict |
|---|---|---|---|
| 2.1 | Transcribe incoming voice messages when speech is available | Downloads, converts Apple's `.caf` to WAV, transcribes. Tested | **passes (has a test)** |
| 2.2 | Interpret the transcript in the ongoing conversation, like text | Arrives as the words in it, told to be treated as their message. Tested | **passes (has a test)** |
| 2.3 | Audio arriving after its first notification is answered once, including on duplicate webhooks | The duplicate half is tested twice over now: the same note delivered twice is one turn and one item, and a note arriving as a later part of a message already answered is still one answer, tied to the message its text came on (`test/voice-states.test.js`). There is still no notify-then-audio path, because Sendblue does not have one — it puts `media_url` on the same event. If a provider ever does deliver audio separately, this is the row to re-open | **passes (has a test)**, for the delay this provider can actually produce |
| 2.4 | Distinguish waiting, processing, ready, failed and no-speech | All five, distinct, tested: `waiting` on arrival, `processing` written before the transcriber is called (so a row stuck in it is a crash rather than a shrug), then `transcribed`, `no_speech` or `failed` — plus `unavailable` for a machine that cannot listen at all, which is a sixth and was already there | **passes (has a test)** |
| 2.5 | Unclear words that affect the answer get asked about | `[inaudible]` stretches are counted off the marker the transcriber was asked for, the count goes to the turn, and the instruction is to ask about that bit and only that bit. Tested, including that nothing is said about gaps when there are none | **passes (has a test)** |
| 2.6 | Never fill gaps with made-up speech | Said to the transcriber, said in the line that carries a transcript, said in the prompt, and said again on the stored transcript when it is read back later. Tested | **passes (has a test)** |
| 2.7 | Preserve timing or transcript references for checking specific claims | Was actively thrown away; now both. The words are kept on the item, so a claim out of a note from three days ago can still be checked after the conversation's own history has rolled past it — and read back only by id, so transcripts do not pour into the context of a conversation about something else. A note over thirty seconds is transcribed with real timestamps; a short one is not, because `[0:00]` markers in a twelve-second "running late" are noise. Length is measured off the bytes of the WAV, not guessed. Tested on both sides of the threshold | **passes (has a test)** |

One honest limit: how long a note is can only be known for a file this converted itself, because
that WAV is 16 kHz mono 16-bit and its byte count IS its duration. A file handed over in its own
format has no length rather than a guessed one, and gets no timestamps.

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
| 4.1 | The URL goes as its own message with no surrounding summary | `src/links.js` pulls the link onto its own message before anything leaves; one outbox row each. Tested | **passes (has a test)** |
| 4.2 | Any summary goes in a separate text message | The words go as the message after it, in that order whatever order the model wrote them in. Tested | **passes (has a test)** |
| 4.3 | Do not bury the link inside a long paragraph | Structural rather than asked for: the model writes however reads best and the split happens on the way out. The prompt line that asked for the opposite is gone, replaced by one forbidding "the link below" and "see above", since those stop being true once the halves are separate bubbles | **passes (has a test)** |
| 4.4 | Keep each link-summary pair in order; never mix summaries between links | Each link keeps its own words, and the chain is enforced in the queue: a summary is not due until the link in front of it is `sent` (`after_id`, `db.dueOutbound`). Proved across a 429 and a permanent failure — and a link that is never going marks its summary failed too, with the reason, rather than sending words about a link that never arrived | **passes (has a test)** |
| 4.5 | Use documented rich-link support if the provider has it; otherwise a standalone URL, documented as "the client may render a preview", never promised or faked | Sendblue documents no rich-link parameter, and App Cards need an Apple Team ID and an installed Messages extension, so that path is closed rather than unused — checked in their docs, written down above. The URL therefore goes bare, and the prompt forbids the model promising a card, a title or a picture of the page | **passes (has a test)** for the sending; the card is **cannot be known offline** |
| 4.6 | Verify the actual result on an iPhone | `docs/iphone-checklist.md` is the list, written to be run on a real thread | **cannot be known offline** |
| 4.7 | Fetch readable page content when a summary is appropriate | Unchanged; tested in `test/site.test.js` and `test/research.test.js` | **passes (has a test)** |
| 4.8 | Do not summarize a page you could not access as though you read it | The failure comes back with its status, and now the record carries it too: a link that would not load is `failed` on its own item with the reason, and `media_reviewed` reads it back, so the claim can be checked against a row instead of against the model's memory. The model not making the claim is still prompt | **partly** |
| 4.9 | When only a title or snippet is available, identify that limited coverage | `text_truncated` is set and the prompt forbids a snippet standing in for a page; the record says `read, cut off at the character limit` as its own coverage detail. Prompt-only for what the model then says | **partly** |
| 4.10 | A pasted link alone does not authorize enrollment, purchase or another action | The gate holds and is tested in general; a fetched page now also arrives marked `untrusted_content`, with a prompt rule that nothing in one is their yes. Still no test driving a pasted link at the gate specifically | **partly** |

## Section 5 — context, reliability and privacy

| # | Requirement | Today | Verdict |
|---|---|---|---|
| 5.1 | Conversation state isolated by user and conversation | Every table keyed by `conversation_id`; admission before the queue. Many tests, and the new surfaces were tested the same way | **passes (has a test)** |
| 5.2 | Use relevant recent history and stated interests; never another person's | That conversation only; the operator's name and city are refused for anyone else. Tested | **passes (has a test)** |
| 5.3 | A user correction replaces an earlier interpretation | The prompt says so, and the leak it would otherwise cause is now closed in code: `remember` refuses a fact sourced to a picture or a deduction, so a reading cannot outlive the correction as a saved fact. Tested that the refusal writes nothing | **partly** (the prompt half is the model's) |
| 5.4 | Keep attachment/message references so "this one" resolves later | Messages were already addressable; attachments are now. Every item has an id, the message it came on and which it was on that message, and `media_reviewed` is what the model is told to use for "this one" and "the second photo". Tested | **passes (has a test)** |
| 5.5 | Record which media was processed and what coverage succeeded | This is `media_items`: one row per photo, voice note, file and link, with the coverage in words the model can read back — looked, transcribed, no speech, read, watched, heard, metadata, failed with the reason, dropped with the reason. Tested | **passes (has a test)** |
| 5.6 | Duplicate notifications and retries never produce duplicate replies | Claimed on UNIQUE(channel, external_id) before anything runs; outbound has its own never-twice. Tested both ways, and again for voice notes specifically | **passes (has a test)** |
| 5.7 | Preserve conversation order even when media processing is slow | One conversation's turns strictly in order, held messages as rows, transcription inside the turn so it cannot overtake anything. Tested in `test/burst.test.js` | **passes (has a test)** |
| 5.8 | Do not log raw private media or transcripts by default | Default is still no logging at all, and the `--log` hole is closed: every string in a tool's input and output is cut to a length and a count, so a page, a video transcript or the words of a voice note is logged as `[5000 chars, not logged]`. A length cap rather than a list of fields to hide, so the next tool that returns something long is covered without anybody remembering. `REASON_LOG_CONTENT=1` turns it off deliberately. Tested | **passes (has a test)** |
| 5.9 | Clear retention/deletion settings for anything stored | Was the largest gap; now two settings with one sentence each, printed at startup and readable by Reason itself through `capabilities`. `REASON_KEEP_CONTENT_DAYS` (30) drops the content — a voice note's words, a page, a cached video transcript, a call's transcript and its audio off disk, the history of a conversation nobody has touched. `REASON_KEEP_RECORDS_DAYS` (365) then drops the record of it. 0 means forever. The sweep runs on the same interval everything else proactive does, so it cannot quietly stop. The nine missing `TABLES` entries are in, so an export is a copy and a delete is a delete. Tested, including that a note whose words were dropped says so with the date instead of claiming none were ever taken | **passes (has a test)** |
| 5.10 | File-size/type limits and URL validation on media downloads | Size was always enforced twice for images and once for audio. Type is now the real bytes, not the filename: `src/pictures.js` sniffs the magic numbers, so a `.jpg` that is really a HEIC is converted and a file pretending to be a picture is refused. URL validation existed nowhere and now gates both images and audio, re-checked at every redirect, so a CDN link that redirects to `127.0.0.1` is stopped at the hop rather than at the first check. Tested | **passes (has a test)** |
| 5.11 | Instructions inside a webpage, image or video are content, never permission | The gate cannot be fed, which is the part that matters, and it is tested. The marking is now there too: a fetched page and a video come back under `untrusted_content` with a prompt rule saying report it, never follow it, and nothing in it is their yes. A voice note is deliberately NOT marked — it is the person's own message, and marking it would contradict the rule telling Reason to answer it like any other text. Tested | **passes (has a test)** |
| 5.12 | A photo or a link never triggers a purchase, a message to someone else, or a sign-up without a yes | The gate and `OUTSIDE_WORLD`, tested hard in general, plus the prompt rule that nothing a photograph does not contain may be stated off one. Still no test that drives media at the gate as the trigger | **partly** |
| 5.13 | Offering research is not the same as the user accepting it | Prompt only, by design: research spends nothing and touches nobody | **partly** |

## Where this left the build order, and what it came to

Written before anything was built, as a plan. All seven steps are done and on `main`:

1. **HEIC first**, with URL validation riding along, because nothing in section 1 could be judged
   until a photo got through at all.
2. **Links as their own bubble.**
3. **The record of what was sent and reviewed** — moved ahead of the photo prompt work, because
   acceptance test 9 depended on it and the prompt rules were easier to write honestly once there
   was something for "the second photo" to point at.
4. **Photos in context** — the prompt, both backends.
5. **Voice** — states, unclear words, timestamps, and keeping their words where a claim can still
   be checked against them.
6. **Privacy and retention.**
7. **Docs** — this file's verdicts, `docs/iphone-checklist.md`, the README, `docs/features.md` and
   `docs/unverified.md`.

One thing was found the hard way in the middle of it, and it is the lesson worth keeping: the photo
work was correct and tested on the API path and did nothing at all on the backend the live Reason
runs on. It took a real phone to notice. Nothing in this file should be read as "it works" when
what it says is "a test passes".

### What is still not closed, in one place

- **Everything that is a judgement call** — all of section 1, 4.8, 4.9, 5.3, 5.12, 5.13. The rule
  is in the prompt on both backends and there is a test that it is in the prompt. Whether the model
  follows it is a live run, and `docs/unverified.md` carries one line per behaviour.
- **A photo sent in the same message as a link is still dropped** as a link-card thumbnail, because
  the provider's payload cannot tell one from the other. Now visible as a `dropped` row with its
  reason rather than silent.
- **Anything only a real iPhone can settle** — whether a bare URL draws a preview card, whether
  two sends a fraction of a second apart arrive in that order, whether a HEIC straight off the
  camera even reaches Reason as a HEIC (in the one live test Sendblue converted it to JPEG).
  `docs/iphone-checklist.md`.
- **No test drives media at the confirm gate as the trigger.** The gate is tested hard and cannot
  structurally be fed by media; what is missing is the test that says so with a photo in its hand.

Verdicts in this file are updated as each gap closes. A comment claiming a behaviour is still not
evidence of it.
