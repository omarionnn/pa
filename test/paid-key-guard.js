// No test spends Reason's paid API key. Loaded before every test file (`--import` in package.json)
// and by test/live.js, so it holds however a test is started.
//
// The incident (2026-10-24/25): $10 put on the key at 21:08 UTC was gone by 04:00, almost all of it
// builders' real-model lanes and evals on claude-opus-5-5 with the full prompt, because `npm test`
// loads .env and .env has the key. So the key is taken out of every test process, and a lane that
// would have run on it runs on the claude-cli subscription instead. REASON_TEST_ALLOW_API=1 is the
// only way to put it back — for the one lane that genuinely tests the API path, on purpose.
export const apiAllowed = process.env.REASON_TEST_ALLOW_API === "1";
export const hadKey = !!process.env.ANTHROPIC_API_KEY;

if (!apiAllowed && hadKey) {
  delete process.env.ANTHROPIC_API_KEY;
  // A run that came with a key meant to be live: it still is, on the subscription.
  if (!process.env.REASON_BACKEND) process.env.REASON_BACKEND = "claude-cli";
}

// The same for the flight sources (src/flightproviders.js): SerpApi's free month is 250 searches,
// and a suite run on a machine whose .env has the key must never spend them.
delete process.env.SERPAPI_API_KEY;
delete process.env.DUFFEL_ACCESS_TOKEN;
