# iPhone app API (`/ios/v1`)

Flag `REASON_IOS_API` off | owner | on (src/config.js). Contract: docs/ios-api.md. Code: src/ios/, routed in src/http.js.

- Offline: `node --test test/ios-api.test.js`.
- Flat 404 check: with `owner`, compare `/ios/v1/page`, a bad-code `/auth/verify` and `/auth/code` against an unissued path; bodies must be byte-identical. Probing live is safe: a made-up number texts nobody, and only the owner's number sends a code, so never POST the owner's number to `/auth/code` as a probe.
- Messages: `POST /messages` is a real turn on live. Drive only on the cage.
- Forget marking: the real model can't be reached from a Mac cage (sealed config has no login); drive `setSpanReader` with `claude -p` on a throwaway DB. Never forget against live data as a test.
