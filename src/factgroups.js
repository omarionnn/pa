// Which of the memory page's five headings a saved fact goes under (Reason Web, handoff §5:
// PREFERENCES, PEOPLE, PLACES, ROUTINES, WHY).
//
// That is a reading of what the fact means, so a model makes it, never a word list (owner rule).
// The extractor files what it writes as it writes it (src/extract.js, the `group` field). This files
// everything else — facts the `remember` tool saved, a guess they confirmed, and, once, every fact
// saved before the page existed — in small batches on the background lane, on Reason's own
// subscription (claude-cli). Never on the paid API: on the API backend nothing is filed here and
// the page reads the extractor's category instead until something is (src/pages/webmemory.js).
//
// One conversation per batch, so one person's facts are never read beside another's.
import * as db from "./db.js";
import { config } from "./config.js";
import { runClaudeCli } from "./backends/cli.js";
import { onSubscription } from "./extract.js";

export const GROUPS = db.MEMORY_GROUPS;
const BATCH = 60;
/** A fact the model passed over this many times is left for a later restart rather than asked about forever. */
const MAX_TRIES = 3;
const tries = new Map();

const SCHEMA = {
  type: "object",
  properties: {
    filed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          group: { type: "string", enum: GROUPS },
        },
        required: ["id", "group"],
      },
    },
  },
  required: ["filed"],
};

const SYSTEM = `You file saved facts about a person under the headings of their memory page. Every fact gets exactly one heading:
- people: about another person or a pet, or who someone is to them
- places: where they live, work, go or want to go; neighbourhoods, venues, cities
- routines: what they do regularly; schedules, habits, recurring payments and subscriptions
- why: their goals, plans, reasons and beliefs; why they do or want things
- preferences: what they like and want, and how they like things done; anything else about them
Answer with every id and its heading, nothing else.`;

/** The batch as the model reads it: `#id [subject] fact`, with the account holder named as such. */
export function filingPrompt(rows, ownKey) {
  return rows.map(r => `#${r.id} [${r.about_key === ownKey ? `${r.about} (the account holder)` : r.about}] ${r.fact}`).join("\n");
}

async function readViaCli(rows, ownKey) {
  const r = await runClaudeCli({ prompt: filingPrompt(rows, ownKey), system: SYSTEM, jsonSchema: SCHEMA, model: config.extractionCliModel, timeoutMs: config.extractionCliTimeoutMs, feature: "fact_groups" });
  if (!r.ok) throw new Error(r.error ?? "the CLI reported an error");
  const v = r.envelope?.structured_output && typeof r.envelope.structured_output === "object" ? r.envelope.structured_output : JSON.parse(String(r.envelope?.result ?? ""));
  return Array.isArray(v?.filed) ? v.filed : [];
}

/** For tests: what reads a batch, `(rows, ownKey) => [{ id, group }]`. `null` puts the real one back. */
let reader = null;
export function setFilingReader(f) { reader = f; }

/**
 * One batch: the oldest unfiled facts of one conversation, read once, each filed under the heading
 * the model chose. Returns how many were filed. Nothing to read with (API backend, no test reader): 0.
 */
export async function fileFacts({ limit = BATCH, log = () => {} } = {}) {
  const read = reader ?? (onSubscription() ? readViaCli : null);
  if (!read) return 0;
  const rows = db.unfiledFacts({ limit, skip: [...tries].filter(([, n]) => n >= MAX_TRIES).map(([id]) => id) });
  if (!rows.length) return 0;
  const ownKey = db.personKey(db.getAccount(rows[0].conversation_id)?.name ?? "");
  const picks = await read(rows, ownKey);
  const asked = new Set(rows.map(r => r.id));
  let filed = 0;
  for (const p of picks) {
    if (!asked.has(Number(p?.id)) || !GROUPS.includes(p?.group)) continue;
    if (db.fileFact(Number(p.id), p.group)) { filed++; asked.delete(Number(p.id)); }
  }
  for (const id of asked) tries.set(id, (tries.get(id) ?? 0) + 1);
  log({ facts_filed: filed, passed_over: asked.size, conversation: rows[0].conversation_id });
  return filed;
}

/** Is there anything for `fileFacts` to do? Cheap; the sweep asks every pass. */
export function anyUnfiled() {
  return db.unfiledCount() > [...tries.values()].filter(n => n >= MAX_TRIES).length;
}

/** For tests. */
export function resetFiling() { tries.clear(); }
