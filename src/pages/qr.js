// A QR code, as SVG, with nothing imported.
//
// The Reason Web join page shows a phone-less visitor the `sms:` link to Reason's texting line as a
// code their phone's camera reads (owner decision 2, 2026-10-26: "a QR code of the sms: link and the
// number to text"). The content is a short URL, so this encoder is deliberately small: byte mode,
// error-correction level M, versions 1–10 (up to 213 bytes), mask chosen by the standard's own
// penalty score. ISO/IEC 18004; no dependency, because a QR library is more code than the code.
//
// `qrSvg(text)` returns the SVG markup; `qrMatrix(text)` the boolean grid, for tests and for a
// decoder to check against.

// ---------- GF(256) for Reed–Solomon, primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 ----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x; LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** The generator polynomial for `n` error-correction codewords: Π (x − α^i), i = 0..n−1. */
function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** The `n` error-correction codewords for one block of data codewords. */
function ecFor(data, n) {
  const g = generator(n);
  const rem = new Array(n).fill(0);
  for (const d of data) {
    const factor = d ^ rem.shift();
    rem.push(0);
    if (factor) for (let j = 0; j < n; j++) rem[j] ^= mul(g[j + 1], factor);
  }
  return rem;
}

// ---------- the tables for level M, versions 1–10 ----------
// [total codewords, ec codewords per block, blocks in group 1, data codewords each, blocks in group 2, data codewords each]
const M = [
  null,
  [26, 10, 1, 16, 0, 0],
  [44, 16, 1, 28, 0, 0],
  [70, 26, 1, 44, 0, 0],
  [100, 18, 2, 32, 0, 0],
  [134, 24, 2, 43, 0, 0],
  [172, 16, 4, 27, 0, 0],
  [196, 18, 4, 31, 0, 0],
  [242, 22, 2, 38, 2, 39],
  [292, 22, 3, 36, 2, 37],
  [346, 26, 4, 43, 1, 44],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const REMAINDER_BITS = [null, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
const dataCapacity = (v) => M[v][2] * M[v][3] + M[v][4] * M[v][5];

/** The smallest version whose data codewords hold `bytes` in byte mode. */
function versionFor(bytes) {
  for (let v = 1; v <= 10; v++) {
    const header = 4 + (v < 10 ? 8 : 16);
    if (header + bytes * 8 <= dataCapacity(v) * 8) return v;
  }
  throw new Error(`QR: ${bytes} bytes is more than version 10-M holds`);
}

/** Byte-mode data codewords: mode, count, the bytes, terminator, then the alternating pad bytes. */
function dataCodewords(bytes, v) {
  const bits = [];
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const cap = dataCapacity(v) * 8;
  push(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let i = 0; out.length < dataCapacity(v); i++) out.push(i % 2 ? 0x11 : 0xec);
  return out;
}

/** Split into blocks, add error correction, interleave both the standard way. */
function finalCodewords(data, v) {
  const [, ec, n1, k1, n2, k2] = M[v];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < n1; i++) { blocks.push(data.slice(at, at + k1)); at += k1; }
  for (let i = 0; i < n2; i++) { blocks.push(data.slice(at, at + k2)); at += k2; }
  const ecs = blocks.map(b => ecFor(b, ec));
  const out = [];
  const longest = Math.max(k1, k2 || 0);
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

// ---------- the matrix ----------
/** BCH remainder of `value << shift` by `poly` (the format and version information codes). */
function bch(value, poly) {
  // Plain long division: shift value left by the generator's degree, reduce, append the remainder.
  const degree = poly.toString(2).length - 1;
  let r = value << degree;
  for (let i = r.toString(2).length - 1; i >= degree; i--) if ((r >> i) & 1) r ^= poly << (i - degree);
  return (value << degree) | r;
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  const v = versionFor(bytes.length);
  const size = 17 + 4 * v;
  const grid = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, on) => { grid[r][c] = !!on; fixed[r][c] = true; };

  // Finder patterns with their separators.
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const edge = r === -1 || r === 7 || c === -1 || c === 7;
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(rr, cc, !edge && (ring || core));
    }
  }
  // Timing patterns.
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // Alignment patterns, except where a finder sits.
  const al = ALIGN[v];
  for (const r0 of al) for (const c0 of al) {
    if ((r0 === 6 && c0 === 6) || (r0 === 6 && c0 === al.at(-1)) || (r0 === al.at(-1) && c0 === 6)) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
      set(r0 + r, c0 + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
    }
  }
  // The dark module, and the format-information areas (filled in after masking).
  set(size - 8, 8, true);
  for (let i = 0; i < 8; i++) { fixed[8][i] = true; fixed[i][8] = true; fixed[8][size - 1 - i] = true; fixed[size - 1 - i][8] = true; }
  fixed[8][8] = true;
  // Version information (versions 7+): two 6×3 blocks.
  if (v >= 7) {
    const info = bch(v, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1;
      const a = Math.floor(i / 3), b = i % 3;
      set(size - 11 + b, a, bit);
      set(a, size - 11 + b, bit);
    }
  }

  // Data, zigzagging up and down in two-module columns from the right, skipping the timing column.
  const codewords = finalCodewords(dataCodewords(bytes, v), v);
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[v]; i++) bits.push(0);
  let k = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (fixed[r][c]) continue;
        grid[r][c] = !!(bits[k++] ?? 0);
      }
    }
    upward = !upward;
  }

  // Masks: score each, keep the lowest penalty.
  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  let best = null;
  for (let m = 0; m < 8; m++) {
    const g = grid.map((row, r) => row.map((on, c) => (fixed[r][c] ? on : on !== MASKS[m](r, c))));
    writeFormat(g, size, m);
    const score = penalty(g, size);
    if (!best || score < best.score) best = { score, g };
  }
  return best.g;
}

/** Format information: level M (00) + mask, BCH(15,5), XOR 0x5412, written in both places. */
function writeFormat(g, size, mask) {
  const info = bch((0b00 << 3) | mask, 0x537) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const bit = !!((info >> i) & 1);
    // Around the top-left finder: up the column beside it (skipping the timing row), then along the row.
    if (i <= 5) g[i][8] = bit;
    else if (i === 6) g[7][8] = bit;
    else if (i === 7) g[8][8] = bit;
    else if (i === 8) g[8][7] = bit;
    else g[8][14 - i] = bit;
    // The copy split between the other two finders.
    if (i <= 7) g[8][size - 1 - i] = bit;
    else g[size - 15 + i][8] = bit;
  }
  g[size - 8][8] = true;
}

/** The standard's four penalty rules, so the picked mask leaves the fewest shapes a camera mistakes. */
function penalty(g, size) {
  let score = 0;
  const run = (line) => {
    let s = 0;
    for (let i = 0, n = 1; i < line.length; i++) {
      if (i + 1 < line.length && line[i + 1] === line[i]) { n++; continue; }
      if (n >= 5) s += 3 + (n - 5);
      n = 1;
    }
    return s;
  };
  const finderLike = (line) => {
    let s = 0;
    const a = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], b = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let i = 0; i + 11 <= line.length; i++) {
      const seg = line.slice(i, i + 11).map(Number);
      if (seg.every((x, j) => x === a[j]) || seg.every((x, j) => x === b[j])) s += 40;
    }
    return s;
  };
  for (let i = 0; i < size; i++) {
    const row = g[i], col = g.map(r => r[i]);
    score += run(row) + run(col) + finderLike(row) + finderLike(col);
  }
  for (let r = 0; r + 1 < size; r++) for (let c = 0; c + 1 < size; c++) {
    const a = g[r][c];
    if (g[r][c + 1] === a && g[r + 1][c] === a && g[r + 1][c + 1] === a) score += 3;
  }
  let dark = 0;
  for (const row of g) for (const on of row) if (on) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.min(Math.abs(Math.floor(pct / 5) * 5 - 50), Math.abs(Math.ceil(pct / 5) * 5 - 50)) / 5 * 10;
  return score;
}

/**
 * The code as inline SVG: one path, a four-module quiet zone, `currentColor` on a white tile so it
 * reads on the dark theme too. `label` becomes the accessible name.
 */
export function qrSvg(text, { label = "QR code", size = 180 } = {}) {
  const m = qrMatrix(text);
  const n = m.length, q = 4, total = n + 2 * q;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
