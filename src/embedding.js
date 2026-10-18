import { config, clock } from "./config.js";
import { db } from "./db.js";

const MODEL = "text-embedding-3-small";
const DIMS = 1536;

export async function embed(texts, {
  apiKey = config.openaiKey,
  base = config.openaiBase,
  timeoutMs = 15_000,
} = {}) {
  if (!apiKey) throw new Error("No OPENAI_API_KEY configured.");
  const input = Array.isArray(texts) ? texts : [texts];
  if (!input.length) return [];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      signal: ac.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, input }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 300)}`);
    const json = JSON.parse(body);
    return json.data
      .sort((a, b) => a.index - b.index)
      .map(d => new Float32Array(d.embedding));
  } finally {
    clearTimeout(timer);
  }
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function float32ToBlob(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function blobToFloat32(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * `vector` lets a caller that has already embedded this text hand the vector over instead of
 * paying for the same call twice. Deciding whether a fact is worth storing and then storing it are
 * two reads of one sentence, not two sentences.
 */
export async function embedAndStore(conversationId, factId, text, { sourceTable = "person_facts", vector } = {}) {
  const [vec] = vector ? [vector] : await embed(text);
  if (!vec) return;
  db.prepare(
    `INSERT INTO fact_embeddings (conversation_id, fact_id, source_table, embedding, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(fact_id, source_table) DO UPDATE SET embedding = excluded.embedding, created_at = excluded.created_at`
  ).run(conversationId, factId, sourceTable, float32ToBlob(vec), MODEL, clock.now());
}

export function removeEmbedding(factId, sourceTable = "person_facts") {
  db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ? AND source_table = ?").run(factId, sourceTable);
}

/** Whether this fact has an embedding at all. A fact without one is invisible to `search`. */
export function hasEmbedding(factId, sourceTable = "person_facts") {
  return !!db.prepare("SELECT 1 FROM fact_embeddings WHERE fact_id = ? AND source_table = ?").get(factId, sourceTable);
}

export async function search(conversationId, queryText, { limit = 5, minScore = 0.3, sourceTable = "person_facts", vector } = {}) {
  const [qVec] = vector ? [vector] : await embed(queryText);
  if (!qVec) return [];

  const rows = db.prepare(
    "SELECT fact_id, embedding FROM fact_embeddings WHERE conversation_id = ? AND source_table = ?"
  ).all(conversationId, sourceTable);

  const scored = [];
  for (const r of rows) {
    const vec = blobToFloat32(r.embedding);
    const score = cosine(qVec, vec);
    if (score >= minScore) scored.push({ factId: r.fact_id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
