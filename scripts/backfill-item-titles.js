// One-time backfill of the short Web titles (src/itemtitle.js) for rows made before they existed:
// open tasks, pending timers and active series with no `label` yet. Each title is one summarise on
// the claude-cli subscription (REASON_BACKEND=claude-cli), never the billed API; a row the model
// cannot title keeps none and Web shows the cleaned note. Only empty labels are written.
//
//   on a copy first: sudo -u reason REASON_DB_PATH=/tmp/titles-copy.db node --env-file=.env scripts/backfill-item-titles.js --write
//   live:            sudo -u reason node --env-file=.env scripts/backfill-item-titles.js --write
//   without --write it prints what it would write and changes nothing.
const args = process.argv.slice(2);
const write = args.includes("--write");
const dbArg = args.find(a => a.startsWith("--db="));
if (dbArg) process.env.REASON_DB_PATH = dbArg.slice(5);

const db = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { summariseItem } = await import("../src/itemtitle.js");

if (process.env.REASON_BACKEND !== "claude-cli") {
  console.error("REASON_BACKEND is not claude-cli: titles come only from the subscription CLI. Nothing done.");
  process.exit(1);
}

const nameOf = (c) => db.getAccount(c)?.name || config.ownerName;
const rows = [
  // Series first: a series' title also goes onto its pending firing, so those need no call of their own.
  ...db.db.prepare("SELECT id, conversation_id AS c, what AS text FROM series WHERE state = 'active' AND (label IS NULL OR label = '')").all().map(r => ({ ...r, kind: "series" })),
  ...db.db.prepare("SELECT id, conversation_id AS c, title AS text FROM tasks WHERE state IN ('running','waiting','waiting_on_other','waiting_on_you','blocked') AND (label IS NULL OR label = '')").all().map(r => ({ ...r, kind: "task" })),
  ...db.db.prepare("SELECT id, conversation_id AS c, note AS text FROM timers WHERE fired_at IS NULL AND cancelled_at IS NULL AND (label IS NULL OR label = '')").all().map(r => ({ ...r, kind: "timer" })),
];

let wrote = 0, skipped = 0;
for (const r of rows) {
  if (r.kind === "timer" && write) {
    const now = db.db.prepare("SELECT label FROM timers WHERE id = ?").get(r.id);
    if (now?.label) { skipped++; continue; }
  }
  // The same one summarise writes the row's chat drafts too (src/itemtitle.js DRAFT_STATES).
  const got = await summariseItem(r.text, { kind: r.kind, name: nameOf(r.c) });
  const title = got?.title ?? null;
  console.log(`${r.kind} #${r.id} [${r.c}] → ${title ?? "(none)"}${got?.drafts ? ` + ${Object.keys(got.drafts).length} drafts` : ""}`);
  if (!title) continue;
  if (write && db.setItemLabel(r.kind, r.c, r.id, title, got.drafts)) wrote++;
}
console.log(`${rows.length} rows without a title; ${write ? `${wrote} written, ${skipped} already titled by their series` : "dry run, nothing written"}.`);
