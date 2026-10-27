// One-time backfill of the one-line descriptions a scheduled row's detail shows on Web (src/itemtitle.js
// `blurb`), for timers and series made before they existed. One summarise per row on the claude-cli
// subscription (REASON_BACKEND=claude-cli; the key is dropped from the environment first), never the billed
// API. It writes ONLY the `blurb` column, and only where it is empty; titles, notes and everything else
// are untouched. A row the model can't describe keeps none, and Web shows the cleaned-up note instead.
//
//   on a copy first: sudo -u reason env -u ANTHROPIC_API_KEY REASON_DB_PATH=/tmp/blurbs-copy.db node --env-file=.env scripts/backfill-blurbs.js --write
//   live:            sudo -u reason env -u ANTHROPIC_API_KEY node --env-file=.env scripts/backfill-blurbs.js --write
//   without --write it prints what it would write and changes nothing.
const args = process.argv.slice(2);
const write = args.includes("--write");
const dbArg = args.find(a => a.startsWith("--db="));
if (dbArg) process.env.REASON_DB_PATH = dbArg.slice(5);

if (process.env.REASON_BACKEND !== "claude-cli") {
  console.error("REASON_BACKEND is not claude-cli: descriptions come only from the subscription CLI. Nothing done.");
  process.exit(1);
}
// Belt and braces: the CLI child never gets the key anyway (src/backends/cli.js), and this process has no use for it.
delete process.env.ANTHROPIC_API_KEY;

const { backfillBlurbs } = await import("../src/itemtitle.js");
const { rows, wrote } = await backfillBlurbs({ write });
console.log(`${rows} scheduled rows without a description; ${write ? `${wrote} written` : "dry run, nothing written"}.`);
