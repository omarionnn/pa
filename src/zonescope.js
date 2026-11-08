// Whose clock a piece of work runs on. One person's turn, one person's Web page: inside it, every
// `config.tz` read is THEIR zone once they have confirmed one (src/zone.js), so a reminder parsed,
// a stamp shown or a day boundary drawn is theirs without each of the ~80 readers being told. Outside
// any scope — a sweep, a boot line, a test — it is the install's zone, exactly as before.
//
// No imports on purpose: config.js and db.js both read this, and zone.js (which reads db) registers
// the resolver, so nothing here can make a cycle.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage();
let resolver = () => "";

/** zone.js tells this how to read a conversation's confirmed zone. */
export function setResolver(fn) { resolver = typeof fn === "function" ? fn : () => ""; }

/** The zone of the work running now, or "" outside any person's scope. */
export function current() { return enabled() ? scope.getStore()?.tz || "" : ""; }

let enabled = () => true;
/** config.js says whether per-person clocks are on at all; off, every read is the install's zone. */
export function setEnabled(fn) { enabled = typeof fn === "function" ? fn : () => true; }

/** Whose work is running now (their conversation id), or "" outside any person's scope. */
export function conversation() { return scope.getStore()?.conv || ""; }

/** Run `fn` with no person's clock: for loops shared by everyone that one person's work started. */
export function outside(fn) { return scope.exit(fn); }

/** Run `fn` on this conversation's clock. */
export function runFor(conversationId, fn) {
  // Already on this person's clock (a tool call inside their turn): the same scope, so a zone they
  // confirm mid-turn holds for the rest of the turn.
  const s = scope.getStore();
  if (s && conversationId && s.conv === conversationId) return fn();
  let tz = "";
  try { tz = conversationId ? resolver(conversationId) || "" : ""; } catch { tz = ""; }
  return scope.run({ tz, conv: conversationId || "" }, fn);
}

/** An open scope whose person is not known yet (an HTTP request before its cookie is read). */
export function runOpen(fn) { return scope.run({ tz: "" }, fn); }

/** The request's person is known now: put their zone on the open scope, if there is one. */
export function enter(conversationId) {
  const s = scope.getStore();
  if (!s || s.tz || !conversationId) return;
  s.conv = conversationId;
  try { s.tz = resolver(conversationId) || ""; } catch {}
}

/** Their zone just changed mid-turn (they answered the question): the rest of the turn runs on it. */
export function setCurrent(tz) {
  const s = scope.getStore();
  if (s && tz) s.tz = tz;
}
