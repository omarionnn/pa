// Which sites run in the hosted browser (src/remotebrowser.js), and their names, with no imports that
// touch the database: the privacy page (src/pages/site.js) names the same list it is built from, so
// the page stays true when the list grows (test/site.test.js guards it).
import { registrableOf } from "./sitepolicy.js";

export const DEFAULT_SITES = Object.freeze(["doordash.com"]);
const LABELS = { "doordash.com": "DoorDash" };
/** A site's display name ("DoorDash"), or its domain when it has none. */
export const labelOf = (site) => LABELS[site] ?? site;
/** A URL, host or site name to its registrable domain ("" when it is not one). */
export const keyOf = (s) => {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t) return "";
  let host = t;
  try { host = /^[a-z][a-z0-9+.-]*:\/\//.test(t) ? new URL(t).hostname : t.split("/")[0].split(":")[0]; } catch { return ""; }
  host = host.replace(/^www\./, "");
  return /^[a-z0-9.-]{3,253}$/.test(host) ? registrableOf(host) : "";
};
/** The sites a covered person's jobs run in the hosted browser, by registrable domain (REASON_REMOTE_BROWSER_SITES). */
export function remoteSites() {
  const raw = String(process.env.REASON_REMOTE_BROWSER_SITES ?? "").trim();
  if (!raw) return [...DEFAULT_SITES];
  return [...new Set(raw.split(",").map((s) => keyOf(s)).filter(Boolean))];
}
