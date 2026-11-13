// A value that must never be printed: a saved login's username, password or authenticator key, or the
// data key that seals them (vault, design B3 and F "Logs and crash dumps").
//
// The bytes live in a module-private WeakMap, not on the object, so nothing that walks the object
// (util.inspect with customInspect off, structuredClone, spread, Object.keys) can reach them. Every
// way of turning it into text gives "[secret]": String(), template strings, `+ ""`, JSON.stringify,
// util.inspect / console.log (%s %o %j included), and an error message built from it.
//
// `use(fn)` is the only way to the bytes: it lends the Buffer to fn once and zero-fills it after,
// whether fn returns, throws or returns a promise. A Secret is single-use; `wipe()` zero-fills one
// that was never used. Nothing here can make a Secret from a JS string: strings cannot be wiped.
import { inspect } from "node:util";

const SHOWN = "[secret]";
const bytes = new WeakMap(); // Secret -> Buffer (null once used or wiped)

export class Secret {
  /** Takes ownership of `buf`: the caller must not keep or reuse it; it is zero-filled after use. */
  constructor(buf) {
    if (!Buffer.isBuffer(buf)) throw new TypeError("Secret needs a Buffer.");
    bytes.set(this, buf);
  }

  /** Lend the bytes to fn once, then zero-fill them (also when fn throws or its promise rejects). */
  use(fn) {
    const b = bytes.get(this);
    if (!b) throw new Error("This secret was already used or wiped.");
    let out;
    try { out = fn(b); }
    catch (e) { this.wipe(); throw e; }
    if (out && typeof out.then === "function") return Promise.resolve(out).finally(() => this.wipe());
    this.wipe();
    return out;
  }

  /** Zero-fill now. Safe to call more than once. */
  wipe() {
    const b = bytes.get(this);
    if (b) b.fill(0);
    bytes.set(this, null);
  }

  /** True until use() or wipe(). */
  get live() { return !!bytes.get(this); }

  toString() { return SHOWN; }
  toJSON() { return SHOWN; }
  valueOf() { return SHOWN; }
  [Symbol.toPrimitive]() { return SHOWN; }
  [inspect.custom]() { return SHOWN; }
}

/** Zero-fill every Secret given (nulls skipped). For `finally` blocks. */
export function wipeAll(...secrets) {
  for (const s of secrets) if (s instanceof Secret) s.wipe();
}
