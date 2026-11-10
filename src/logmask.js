// Phone numbers stay out of the server log (data-isolation audit 11-09, step 5).
//
// Conversation ids carry the person's number (`dm:sendblue:+12025551234`), and so do `to`, read
// receipts and the start-up list of test numbers. journald kept ~150 of those a day, readable by
// anyone who can read the box's journal. Every line Reason prints goes through console.*, so the
// serve process wraps those once: a number in E.164 form (a `+` and 10–15 digits, which is how every
// address is stored) becomes `+…1234~a1b2c3` — the last four digits so a person can still be told
// apart when reading a log, and a short keyed hash so one number's lines can be followed across a
// day without the number itself. Millisecond timestamps, ids and prices have no `+` and are left alone.
import { createHmac, randomBytes } from "node:crypto";
import { inspect } from "node:util";

const PHONE = /\+\d{10,15}(?!\d)/g;
// Keyed so the short hash cannot be reversed by trying every number; the token key when there is
// one (stable across restarts), else a per-process key (lines still follow within one run).
const KEY = process.env.REASON_TOKEN_KEY || randomBytes(32).toString("hex");

/** `+12025551234` → `+…1234~1f2e3d`. */
export function maskPhone(number) {
  const h = createHmac("sha256", KEY).update(number).digest("hex").slice(0, 6);
  return `+…${number.slice(-4)}~${h}`;
}

/** The text with every E.164 number masked. */
export function maskPhones(text) {
  return String(text).replace(PHONE, maskPhone);
}

const mask = (a) => {
  if (typeof a === "string") return maskPhones(a);
  if (a instanceof Error) {
    const e = new Error(maskPhones(a.message));
    e.stack = a.stack ? maskPhones(a.stack) : e.stack;
    return e;
  }
  if (a && typeof a === "object") {
    // Objects print the way console would, then masked — only when a number is in there.
    const s = inspect(a, { depth: 4 });
    PHONE.lastIndex = 0;
    return PHONE.test(s) ? maskPhones(s) : a;
  }
  return a;
};

let installed = false;
/** Wrap console.log/info/warn/error/debug so every printed string is masked. Idempotent. */
export function installConsoleMask(target = console) {
  if (installed && target === console) return;
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    const orig = target[k].bind(target);
    target[k] = (...args) => orig(...args.map(mask));
  }
  if (target === console) installed = true;
}
