import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-embed-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const { cosine, float32ToBlob, blobToFloat32 } = await import("../src/embedding.js");

test("cosine of identical vectors is 1", () => {
  const a = new Float32Array([1, 2, 3]);
  assert.ok(Math.abs(cosine(a, a) - 1.0) < 1e-6);
});

test("cosine of orthogonal vectors is 0", () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  assert.ok(Math.abs(cosine(a, b)) < 1e-6);
});

test("cosine of opposite vectors is -1", () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([-1, 0, 0]);
  assert.ok(Math.abs(cosine(a, b) + 1.0) < 1e-6);
});

test("BLOB round-trip preserves float32 values", () => {
  const original = new Float32Array([0.1, 0.2, -0.3, 999.5]);
  const blob = float32ToBlob(original);
  const restored = blobToFloat32(blob);
  assert.equal(restored.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(restored[i] - original[i]) < 1e-6, `index ${i}: ${restored[i]} vs ${original[i]}`);
  }
});

test("BLOB round-trip works with 1536 dimensions", () => {
  const dims = 1536;
  const original = new Float32Array(dims);
  for (let i = 0; i < dims; i++) original[i] = Math.random() * 2 - 1;
  const blob = float32ToBlob(original);
  const restored = blobToFloat32(blob);
  assert.equal(restored.length, dims);
  assert.ok(Math.abs(cosine(original, restored) - 1.0) < 1e-6);
});
