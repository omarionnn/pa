import { config, clock } from "./config.js";
import { db, seal2 } from "./db.js";

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
  if (a.length !== b.length) return 0; // a vector whose key was destroyed opens empty
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

/** A vector as stored: sealed for its owner with REASON_ENCRYPT_REST2=on (src/restcrypt.js), else the bytes. */
export function vectorCell(conversationId, arr) {
  return seal2(conversationId, float32ToBlob(arr));
}

/** Bytes, or the base64 a sealed vector opens to (and "" for a person whose key was destroyed). */
export function blobToFloat32(blob) {
  const buf = typeof blob === "string" ? Buffer.from(blob, "base64") : Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.byteLength % 4) return new Float32Array(0);
  // Buffer.from(base64) may sit at any offset in Node's shared pool; a Float32Array needs 4-byte alignment.
  if (buf.byteOffset % 4) return new Float32Array(Uint8Array.prototype.slice.call(buf).buffer);
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
  ).run(conversationId, factId, sourceTable, vectorCell(conversationId, vec), MODEL, clock.now());
}

export function removeEmbedding(factId, sourceTable = "person_facts") {
  db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ? AND source_table = ?").run(factId, sourceTable);
}

/** The stored vectors for these facts, by fact id. Facts with none are simply absent. */
export function vectorsFor(conversationId, factIds, sourceTable = "person_facts") {
  const out = new Map();
  if (!factIds.length) return out;
  const rows = db.prepare(
    `SELECT fact_id, embedding FROM fact_embeddings WHERE conversation_id = ? AND source_table = ? AND fact_id IN (${factIds.map(() => "?").join(",")})`
  ).all(conversationId, sourceTable, ...factIds);
  for (const r of rows) out.set(r.fact_id, blobToFloat32(r.embedding));
  return out;
}

/** Whether this fact has an embedding at all. A fact without one is invisible to `search`. */
export function hasEmbedding(factId, sourceTable = "person_facts") {
  return !!db.prepare("SELECT 1 FROM fact_embeddings WHERE fact_id = ? AND source_table = ?").get(factId, sourceTable);
}

export async function search(conversationId, queryText, { limit = 5, minScore = 0.3, sourceTable = "person_facts", vector, timeoutMs } = {}) {
  const [qVec] = vector ? [vector] : await embed(queryText, timeoutMs ? { timeoutMs } : {});
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
