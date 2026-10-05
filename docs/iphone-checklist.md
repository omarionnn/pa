# The iPhone checklist

Everything the multimodal work cannot prove on this machine, as a list to run on a real thread.

Written 2026-10-05, after the photo, link, record, voice and privacy steps. Each item says what to
do, what should happen, and what it means if it does not — including which file to open. Nothing
here is an opinion poll; every line has a right answer the code is claiming.

Run it against `npm run serve` with Sendblue live, from a real iPhone, as a person Reason has let
in. **Check the ops log with `--log`** while doing it: half of these are only visible there.

---

## Before you start

- [ ] `npm run serve` prints the retention line (`keeping: …`) and `sweeping every …s (… retention)`.
      If not, you are on an older build.
- [ ] Settings → Camera → Formats on the phone is on **High Efficiency**, not "Most Compatible".
      That is what makes items 1 and 2 real; on "Most Compatible" the phone sends JPEG and the HEIC
      path never runs.

## 1. A photo from the camera roll actually arrives

- [ ] Take a photo on the phone and send it with no caption.
- [ ] **Expected:** Reason answers about what is in the picture, in one or two lines, and asks what
      it is looking at rather than inventing a story.
- [ ] In the log: one `media` line with a byte count, and `converted` if it came through as HEIC.
- **If it says "that came through as a heic":** the conversion did not run. `src/pictures.js`
  `findSips()` could not find `/usr/bin/sips`, or the sniff did not recognise the bytes. The log
  line names which.
- **Open question this settles:** whether Sendblue delivers an iPhone photo as HEIC at all. In the
  one live run it delivered JPEG, which means the whole conversion path has only ever run against
  fixtures. **This is the single most valuable item on the list.** Note in `docs/unverified.md`
  which format actually arrived.

## 2. A screenshot, which is PNG

- [ ] Screenshot something with text in it — a listing, an error, a menu — and send it.
- [ ] **Expected:** Reason answers from what the screen says.

## 3. A photo against something said earlier

- [ ] Say "i'm thinking about buying a car" and send nothing else.
- [ ] A few messages later, send a photo of a car with no caption.
- [ ] **Expected:** something like "is this one you're looking at? want me to dig into it?"
- [ ] **Must NOT happen:** "congrats on the new car", a model name, a year, a price, or anything
      about who owns it.
- **If it congratulates you:** the prompt rule is being ignored, not missing — it is in `systemFor`
  and `test/photos-in-context.test.js` proves it is there. That is a live-behaviour finding and goes
  in `docs/unverified.md` as one.

## 4. The correction

- [ ] After item 3, reply "no that's my friend's car".
- [ ] **Expected:** it accepts it in one line and does not argue.
- [ ] Later in the same thread, ask "what do you know about my car".
- [ ] **Must NOT happen:** anything implying you own it. A reading off a photo is never saved as a
      fact — `remember` refuses a fact sourced to a picture — so if it claims one, check the log for
      a `remember` call whose `source` was `they_said` when it was not.

## 5. A photo and a link in the same message

- [ ] Send one message with both a photo and a URL in it.
- [ ] **Expected, and known to be imperfect:** the photo is dropped as a link-card thumbnail,
      because Sendblue's payload has no field that tells a thumbnail from a photo
      (`src/parts.js`). Reason answers about the link.
- [ ] Ask "what did i send you" → `media_reviewed` should list the photo as **dropped**, with the
      reason, rather than not listing it at all.
- **This is a deliberate trade and the real traffic is what settles it.** If you find yourself
  sending photos with links often, the rule should change; the drop rows are the evidence for that
  argument, so count them rather than guessing.

## 6. A link Reason sends

- [ ] Ask for something that comes back with a link ("find me the trailer for X", or ask for a page).
- [ ] **Expected:** two bubbles. The bare URL first, then the words about it.
- [ ] **Open question:** does iMessage draw a preview card on the bare URL? Sendblue documents no
      parameter for it, and their only mention of link previews says it depends on the recipient
      having the sender saved as a contact. So:
  - [ ] with Reason's number **not** in your contacts — card or no card?
  - [ ] then save the number as a contact and try again — card or no card?
- [ ] **Expected either way:** Reason never mentions a card, a title or a picture of the page.
- [ ] **Order:** the link should arrive before the words. The order they are *sent* in is
      guaranteed (one row each, chained on `after_id`); what iMessage does with two messages to the
      same thread in the same second is what this checks. If they land out of order, say so — the
      fix is a delay between the two, not a reorder.

## 7. Several links in one reply

- [ ] Ask something that comes back with two or three links.
- [ ] **Expected:** each link's line sits with its own link. No mixing.

## 8. A voice note

**The ordinary case is already confirmed** — voice notes from Omari's iPhone were reported working
on 2026-10-05. What is left here is the detail-check, and items 9 to 11, which that run did not
cover.

- [ ] Send a voice note saying something with a detail in it — a time, a name, an address.
- [ ] **Expected:** Reason answers the content, does not make a thing of it having been a voice
      note, and says the detail back to check it if anything hangs on it.
- [ ] In the log: `heard` with a character count, `seconds`, and no transcript text.

## 9. A voice note with something unclear in it

- [ ] Send one where part is mumbled, or talk over music for a few words.
- [ ] **Expected if the transcriber marks a gap:** Reason asks about **that bit specifically**
      ("couldn't catch what came after the address, say that part again?"), and never invents a
      word that would fit.
- [ ] In the log: `unclear: 1` (or more).
- **If no gap is ever marked**, the transcriber is guessing rather than writing `[inaudible]`. That
  is a model-behaviour finding about Gemini, not a bug here; note it.

## 10. A silent voice note

- [ ] Record one and say nothing. Send it.
- [ ] **Expected:** a line of its own — that one came through silent — and **not** "couldn't hear
      it", which is a different problem.

## 11. A long voice note

- [ ] Send one over 30 seconds with two or three separate points in it.
- [ ] **Expected:** it answers all of them.
- [ ] Then ask "what did i say in that voice note" → Reason should read it back from the record
      (`media_reviewed` with that item's id), with timestamps in it, rather than from its memory of
      the conversation.

## 12. The same note twice

- [ ] Hard to force by hand; if Sendblue ever redelivers, the mark is **one** answer and **one**
      item in `media_reviewed`. Watch for it rather than trying to make it happen.

## 13. What it says it did

- [ ] Ask "what have i sent you today" and "did you actually read that link".
- [ ] **Expected:** answered from the record, naming what was got out of each thing — looked at,
      transcribed, read, watched, could not. Never "I think so".

## 14. Retention, which needs patience or a clock

- [ ] Ask "how long do you keep my voice notes" → it should answer with the real numbers (30 days
      for content, a year for the records), because they are in `capabilities`.
- [ ] Ask "delete everything you have on me" → it should tell you how, not pretend it can run a
      shell command.
- [ ] To see a drop without waiting a month: `REASON_KEEP_CONTENT_DAYS=1` and a note from
      yesterday. (0 does not mean "immediately" — it means keep forever.)
- [ ] After a content window passes, ask what you said in that old note → **expected:** "I had the
      words and they were deleted on «date»", never a reconstruction and never "you never sent one".

## 15. The things that are not multimodal but ride on the same send path

- [ ] A tapback still works on the last message.
- [ ] An inline reply still pins under the right message.
- [ ] A screen effect still fires on a real moment (and only one).
- [ ] A call recording still arrives as audio you can play.

---

## Where findings go

- A behaviour the model got wrong → `docs/unverified.md`, as its own line, saying what was sent and
  what came back.
- A fact about the provider or the device (what format arrived, whether a card drew) → the relevant
  section of `docs/multimodal-audit.md`, because those are the rows that say "cannot be known
  offline" and this is how they stop saying it.
- Anything that looks like a bug → a failing test first, then the fix. Every incident this repo has
  had is a pinned test; that is the rule and it has not been broken yet.
