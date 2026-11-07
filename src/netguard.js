// Fetching a URL somebody else chose, from this server, without reaching this server's own network.
//
// A link the model passes (web_lookup, offer_check, a watch, a research source) or a media_url a
// provider hands over (a PDF, a video, a voice memo, a contact card) is a name somebody else picked,
// and this process sits next to things that answer an unauthenticated GET: Reason's own port, the
// cloud metadata service at 169.254.169.254, the Tailscale and Caddy admin APIs. So, for every hop
// (security audit 2026-11-06, leads 19 and 22):
//
//   - http or https only (https only where the caller says), no user:password@ in the URL;
//   - the name is resolved and refused unless EVERY address is public (pictures.js isPrivateHost);
//   - the connection goes to THOSE addresses (a pinned lookup), never to whatever the name answers a
//     moment later, so DNS rebinding cannot swap a private address in after the check;
//   - redirects are never followed by fetch: each Location is a new hop and goes through all of it.
//
// The same rule shopconnect.js's icon fetch has had since 2026-10-31, as one module.
//
// Under test, a fetch that has been handed in (or a globalThis.fetch a test replaced) is used as is,
// with the name checks and the hop-by-hop redirects but no DNS: tests never touch the real network.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { isPrivateHost } from "./pictures.js";

const NATIVE_FETCH = globalThis.fetch;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The test-only way past all of it, for a suite whose fixture lives on 127.0.0.1. Never in production. */
export const allowPrivate = () => !!process.env.NODE_TEST_CONTEXT && process.env.REASON_TEST_ALLOW_PRIVATE_FETCH === "1";

/** dns.lookup's callback shape, answering from the addresses already checked. */
export function pinnedLookup(addresses) {
  const list = addresses.map((a) => ({ address: a.address, family: Number(a.family) || isIP(a.address) || 4 }));
  return (hostname, options, cb) => {
    if (typeof options === "function") { cb = options; options = {}; }
    if (options?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  };
}

/** Every address of `hostname`, or null when there are none or any of them is not public. */
export async function publicAddresses(hostname, { lookup = (h) => dnsLookup(h, { all: true, verbatim: true }) } = {}) {
  const h = String(hostname).replace(/^\[|\]$/g, "");
  if (isPrivateHost(h)) return null;
  if (isIP(h)) return [{ address: h, family: isIP(h) }];
  let addrs;
  try { addrs = await lookup(h); } catch { return null; }
  if (!(Array.isArray(addrs) && addrs.length && addrs.every((a) => isIP(a?.address) && !isPrivateHost(a.address)))) return null;
  return addrs.map((a) => ({ address: a.address, family: a.family || isIP(a.address) }));
}

/**
 * May this URL be handed to something that fetches it itself (yt-dlp, the browser)? `{ ok: true }` or
 * `{ ok: false, why }`. The name is resolved and every address must be public; under node --test
 * only the name is looked at. That tool follows its own redirects, so this is the first hop only:
 * the browser adds its own per-request check (src/browser.js), yt-dlp has none.
 */
export async function publicUrl(url, { httpsOnly = false, lookup = null } = {}) {
  let u;
  try { u = new URL(String(url ?? "")); } catch { return { ok: false, why: "the link is not a real address" }; }
  if (!(u.protocol === "https:" || (!httpsOnly && u.protocol === "http:"))) return { ok: false, why: `the link is ${u.protocol.replace(":", "")}, and only http and https links are opened` };
  if (u.username || u.password) return { ok: false, why: "the link carries a user name or password" };
  if (allowPrivate()) return { ok: true };
  if (isPrivateHost(u.hostname)) return { ok: false, why: "the link points at this machine's own network rather than at the internet" };
  if (process.env.NODE_TEST_CONTEXT && !lookup) return { ok: true };
  return (await publicAddresses(u.hostname, lookup ? { lookup } : {})) ? { ok: true } : { ok: false, why: "the link's name does not lead to a public address on the internet" };
}

/** One GET to a pinned address; redirects are the caller's. A WHATWG Response. */
function pinnedGet(u, { headers = {}, signal, addresses }) {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
      method: "GET", headers, signal, lookup: pinnedLookup(addresses), ...(u.protocol === "https:" ? { servername: u.hostname } : {}),
    }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) { if (v != null) h.set(k, Array.isArray(v) ? v.join(", ") : String(v)); }
      const bodiless = [204, 205, 304].includes(res.statusCode) || REDIRECTS.has(res.statusCode);
      if (bodiless) res.resume();
      try { resolve(new Response(bodiless ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage ?? "", headers: h })); }
      catch (e) { res.destroy(); reject(e); }
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET `url` under the rule above. `{ ok: true, res, url }` (url = the last hop) or
 * `{ ok: false, refused: true, why }` for a link the rule refuses; a network error throws as fetch's
 * would (AbortError included), so callers keep their own error lines.
 */
export async function guardedFetch(url, { headers = {}, signal, fetchImpl = null, lookup = null, httpsOnly = false, maxHops = 5 } = {}) {
  // Under node --test the real network is never used: whatever fetch the test has in place answers.
  // A caller passing the platform's own fetch (the usual default) is not handing in a fake.
  // (ops.js's watcher only counts calls and passes them on: it is the real fetch too.)
  const fake = (f) => typeof f === "function" && f !== NATIVE_FETCH && !f.passesThrough;
  const given = fake(fetchImpl) ? fetchImpl : null;
  const injected = given ?? (process.env.NODE_TEST_CONTEXT || fake(globalThis.fetch) ? globalThis.fetch : null);
  let target = String(url ?? "");
  for (let hop = 0; ; hop++) {
    let u;
    try { u = new URL(target); } catch { return { ok: false, refused: true, why: "the link is not a real address" }; }
    if (!(u.protocol === "https:" || (!httpsOnly && u.protocol === "http:"))) return { ok: false, refused: true, why: `the link is ${u.protocol.replace(":", "")}, and only ${httpsOnly ? "https" : "http and https"} links are fetched` };
    if (u.username || u.password) return { ok: false, refused: true, why: "the link carries a user name or password" };
    let res;
    if (allowPrivate()) {
      res = await (injected ?? NATIVE_FETCH)(u.href, { headers, signal, redirect: "manual" });
    } else if (isPrivateHost(u.hostname)) {
      return { ok: false, refused: true, why: "the link points at this machine's own network rather than at the internet" };
    } else if (injected) {
      if (lookup && !(await publicAddresses(u.hostname, { lookup }))) return { ok: false, refused: true, why: "the link's name points at this machine's own network rather than at the internet" };
      res = await injected(u.href, { headers, signal, redirect: "manual" });
    } else {
      const addresses = await publicAddresses(u.hostname, lookup ? { lookup } : {});
      if (!addresses) return { ok: false, refused: true, why: "the link's name does not lead to a public address on the internet" };
      res = await pinnedGet(u, { headers, signal, addresses });
    }
    const next = REDIRECTS.has(res.status) ? res.headers?.get?.("location") : null;
    if (!next) return { ok: true, res, url: u.href };
    if (hop >= maxHops) return { ok: false, refused: true, why: `the link kept redirecting, more than ${maxHops} hops` };
    try { target = new URL(next, u).href; } catch { return { ok: false, refused: true, why: "it redirected somewhere that is not a real address" }; }
  }
}
