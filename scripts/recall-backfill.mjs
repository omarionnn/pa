// One-time backfill of the recall index (src/recallindex.js): every past call, ledger action,
// one-off reminder and thread exchange that has no embedding yet, so "do you remember the spa
// place?" can find what happened before this shipped. New rows are indexed by the runtime sweep on
// their own; this only catches up history. Safe to re-run: what is indexed already is skipped.
//
// Cost: OpenAI text-embedding-3-small, $0.02 per 1M tokens. The live DB on 11-05 was ~6,000 rows /
// ~1.2M chars (~0.3M tokens) — under one cent. The dry run prints the real figure first.
//
//   dry run (no API call):  sudo -u reason node --env-file=.env scripts/recall-backfill.mjs
//   on a copy first:        sudo -u reason node --env-file=.env scripts/recall-backfill.mjs --write --db=/tmp/recall-copy.db
//   live:                   sudo -u reason node --env-file=.env scripts/recall-backfill.mjs --write
// Needs OPENAI_API_KEY (already in the server's .env). Touches only fact_embeddings.
const args = process.argv.slice(2);
const write = args.includes("--write");
const dbArg = args.find(a => a.startsWith("--db="));
if (dbArg) process.env.REASON_DB_PATH = dbArg.slice(5);

const { indexPending, resetBackoff } = await import("../src/recallindex.js");
const { config } = await import("../src/config.js");
const log = (l) => console.log(JSON.stringify(l));

if (!write) {
  // Collect what would be embedded, store nothing.
  let items = 0, chars = 0;
  await indexPending({ limit: 1_000_000, log, embedFn: async (texts) => { items += texts.length; chars += texts.reduce((n, t) => n + t.length, 0); return []; } });
  const tokens = Math.round(chars / 4);
  console.log(`dry run: ${items} rows to embed, ${chars} chars (~${tokens} tokens, ~$${(tokens / 1e6 * 0.02).toFixed(4)}). Nothing written. Add --write to do it.`);
  process.exit(0);
}

if (!config.openaiKey) {
  console.error("No OPENAI_API_KEY: nothing can be embedded. Nothing done.");
  process.exit(1);
}
let total = 0;
for (;;) {
  resetBackoff();
  const n = await indexPending({ limit: 500, log });
  total += n;
  if (!n) break;
}
console.log(`indexed ${total} row(s).`);
