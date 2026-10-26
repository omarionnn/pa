// Requests the website proxies here (2026-10-26). Reason Web lives at heyreason.com/web, which
// Netlify rewrites to this server. Netlify's own request comes from Netlify's addresses, so without
// help every visitor would look like one browser to the sign-in limits. Netlify signs each proxied
// request (`signed = "REASON_SITE_PROXY_SECRET"` in the site's netlify.toml): an HS256 JWS in
// `x-nf-sign`, made with a secret only the site and this server hold, expiring within minutes. It
// also sets `x-nf-client-connection-ip` to the visitor's address and replaces any a browser sent
// (probed 10-26). So the visitor's address is believed only alongside a valid signature. A browser
// hitting this server directly can write both headers but cannot sign, and gets its socket's
// address (or Caddy's X-Forwarded-For) as before.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, clock } from "../config.js";

const b64 = (s) => Buffer.from(String(s), "base64url");

/** Did this request come through the website's proxy? Only a signature made with our secret says so. */
export function viaSite(headers = {}) {
  const secret = config.siteProxySecret;
  if (!secret) return false;
  const parts = String(headers["x-nf-sign"] ?? "").split(".");
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts;
  const want = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const got = b64(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  let head, claims;
  try { head = JSON.parse(b64(h).toString("utf8")); claims = JSON.parse(b64(p).toString("utf8")); } catch { return false; }
  if (head?.alg !== "HS256" || claims?.iss !== "netlify") return false;
  // A minute's grace for the two clocks: an expiry missed by seconds would 301 the website's own request.
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 + 60_000 <= clock.now()) return false;
  if (config.siteProxyId && claims.netlify_id !== config.siteProxyId) return false;
  return true;
}

/** The visitor's address as the website saw it, or "" when the request is not signed by it. */
export function siteClientIp(headers = {}) {
  if (!viaSite(headers)) return "";
  const ip = String(headers["x-nf-client-connection-ip"] ?? "").trim();
  return /^[0-9A-Fa-f:.]{2,45}$/.test(ip) ? ip : "";
}

const hostname = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const requestHost = (headers) => String(headers.host ?? "").toLowerCase().replace(/:\d+$/, "");

/**
 * Where a Web address on the pages host now lives: `{REASON_SITE_URL}{path}` (301), or null to serve
 * it. Only once the website signs its requests, because the website's own rewrite lands on this same
 * host and must be served, not sent round again.
 */
export function webMovedTo(headers = {}, pathAndQuery = "/web") {
  if (!config.siteUrl || !config.siteProxySecret) return null;
  const pages = hostname(config.pagesUrl);
  if (!pages || requestHost(headers) !== pages || viaSite(headers)) return null;
  return `${config.siteUrl.replace(/\/+$/, "")}${pathAndQuery}`;
}

/**
 * The domain the `reason_page` cookie is shared across, or "" for host-only. Owner decision 3: one
 * sign-in serves Web, pages, events and /ops, and those now sit on heyreason.com, files. and events.,
 * so the cookie names the website's domain — set only when the request is to one of those three
 * hosts (or came through the website, signed). A browser then sends it to every heyreason.com host,
 * which is why nothing but Reason's own may ever be added under that domain. Anywhere else (the
 * Funnel, a dev machine) a Domain the browser would refuse is left off.
 */
export function cookieDomain(headers = {}) {
  const site = hostname(config.siteUrl);
  if (!site || !site.includes(".") || /^[0-9.]+$/.test(site)) return "";
  const ours = [site, hostname(config.pagesUrl), hostname(config.eventsUrl)].filter(h => h === site || h.endsWith(`.${site}`));
  return ours.includes(requestHost(headers)) || viaSite(headers) ? site : "";
}
