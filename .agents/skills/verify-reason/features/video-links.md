# Video links (video_understand; intake REASON_VIDEO_INTAKE, #599, #602)

Somebody texts a video link (YouTube or another site), with or without a question. Reason finds out
what is in it and answers, and always says in a few words how it knows: from its captions, by listening
to the audio, or by watching it.

**Live: `REASON_VIDEO_INTAKE=owner`** (read 2026-11-18): the operator gets intake (`videoIntakeFor`,
`src/tools.js:673-676`, `featureOwner`); everybody else gets `video_understand` exactly as before.

Source: `src/video.js` (`videoUnderstand`, the tiers: captions/metadata via yt-dlp, then audio, then the
video model; `videoIntake` at `src/video.js:1116`: a transcript cache keyed by the video, `find`, `pdf`,
a heads-up for a long fetch, a five-minute ceiling `REASON_VIDEO_INTAKE_DEADLINE_MS`, a two-hour limit
`REASON_VIDEO_INTAKE_MAX_SECONDS`, one plain line for live/private/age-gated/too long), `src/tools.js`
(`video_understand` at about `:7185`; intake adds `find` and `pdf` and the bare-link rule), `src/db.js`
(`video_cache`, `video_cache_lines`), `src/spend.js` (the paid tier's money limit).

## What a person sees

- **A bare link, nothing asked** (intake): 3 to 5 short lines on what it is, and an offer of the full
  transcript as a PDF, the key quotes, or a question. A second question, `find` or the PDF is served from
  the cache, instant and free.
- **Hardening (both paths, #602):** yt-dlp reads no config, cookies or browser profile; `--` before the
  link; the generic extractor is off; its own process group, killed at the deadline; lower CPU priority
  than live calls; a size watchdog on the scratch directory.
- **A bot check on the server's address** is said as that, and the next tier is tried (a YouTube link
  goes to the video model, which does not fetch from the server).

## Drive

- Offline: `test/video-intake.test.js`, `test/video-intake-review.test.js`, `test/video-old-path-harden.test.js`,
  `test/video.test.js` → 91/91 at 18b47891 (needs `yt-dlp` on `PATH`; `env -i PATH=$PATH`).
- In process on this Mac, no model, no paid tier (2026-11-18, evidence `*-callrec-video`, `GEMINI_API_KEY=`
  `OPENAI_API_KEY=`, `REASON_VIDEO_INTAKE=owner`): `video_understand` on a public 19-second YouTube video →
  `tier` captions, `how` "read the captions", the transcript; `find` on the same video served from
  `video_cache` in 2 ms; another person's tool has no `find`/`pdf`. 9/9 ok. This Mac's yt-dlp is 2026.08.19.
- **Live captions tier (2026-11-18, read-only probe as `reason`):** the server's `/usr/bin/yt-dlp` is the
  Ubuntu package 2024.04.09 and YouTube answers it "Precondition check failed" (HTTP 400): no captions.
  Live then depends on the paid video-model tier for YouTube. The one live run since 11-16 (before #599)
  ended `ok:false`, `tier:none`; `video_cache` on live has 0 rows. Re-run the probe after any yt-dlp
  upgrade on the server:
  `sudo -u reason timeout 90 /usr/bin/yt-dlp --ignore-config --no-cache-dir --skip-download --write-auto-subs --sub-langs "en.*" -o "$T/v.%(ext)s" -- <public video>`
  in a `mktemp -d` → an `.en.vtt` file.
