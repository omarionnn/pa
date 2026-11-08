// G.711 μ-law, the 8 kHz phone audio Twilio streams both ways. No imports: ./hearing.js and the level
// tools under .agents read it without loading anything else of Reason.

/** One G.711 μ-law byte as a 16-bit sample. */
export function ulawToPcm(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  let s = ((mant << 3) + 0x84) << exp;
  s -= 0x84;
  return sign ? -s : s;
}

/** A 16-bit sample as one G.711 μ-law byte. */
export function pcmToUlaw(sample) {
  const BIAS = 0x84;
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > 32635) s = 32635;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}
