// The named-site rule for account_signin (vault review 2026-11-13, M3). A saved login is used only
// for a site the person named themselves. Code reads the stored thread; the model never decides it.
//
// "Named" means one of these, from the saved row (never from anything the model passes):
//   - its domain ("coned.com", or a subdomain of it written as a word: "www.coned.com"), or
//   - its label or its site name with spaces and punctuation taken out ("Con Edison" -> conedison;
//     "con ed" -> coned, the domain's own name), matched against 1 to 4 consecutive words of theirs,
//     the whole word, case-insensitive. A name shorter than 3 letters never counts on its own.
// Where: only the person's OWN messages (trust.ownerTexts: never a tool result, an event, an email,
// a page, a call matched by caller ID alone, or Reason's words) and only what they typed (typedOnly:
// not the bracketed notes Reason keeps under a message, such as a PDF's text). The window is their
// newest message (this turn's) and the two before it: enough for "pay my con ed bill" -> a question
// back -> "the usual card", too few for a site named days ago to still count.
// The one other way: their newest message is a bare yes ("yes", "ok", "go ahead") and Reason's message
// straight before it, in reply to their previous own message with no event in between, names exactly
// one of their saved sites, and it is this one. A yes to a message naming two sites, or none, is not
// a yes to either.
import { ownerTexts } from "./trust.js";

export const NAMED_WINDOW = 3;
const MIN_NAME = 3;

const norm = (t) => String(t ?? "").toLowerCase().normalize("NFKC").replace(/[‘’]/g, "'");
const compact = (t) => norm(t).replace(/[^\p{L}\p{N}]/gu, "");
/** Words as written, dots and hyphens kept inside a word so a domain stays one word. */
const words = (t) => norm(t).split(/[^\p{L}\p{N}.'-]+/u)
  .map(w => w.replace(/'s$/, "").replace(/^[.'-]+|[.'-]+$/g, "")).filter(Boolean);

// A two-part ending such as .co.uk: the name is the label before it.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "ne", "or"]);
function siteName(site) {
  const labels = String(site ?? "").toLowerCase().split(".").filter(Boolean);
  labels.pop();
  if (labels.length > 1 && SECOND_LEVEL.has(labels.at(-1))) labels.pop();
  return labels.at(-1) ?? "";
}

/** The names a saved login answers to: its domain, and the compact forms of its label and site name. */
export function namesOf(login) {
  const site = String(login?.site ?? "").toLowerCase();
  const names = new Set([compact(login?.label), compact(siteName(site))].filter(n => n.length >= MIN_NAME));
  return { site, names };
}

/** Does this text name this saved login? */
export function names(text, login) {
  const { site, names: n } = namesOf(login);
  const w = words(text);
  if (site && w.some(x => x === site || x.endsWith(`.${site}`))) return true;
  const flat = w.map(compact);
  for (let i = 0; i < flat.length; i++) {
    let joined = "";
    for (let k = i; k < Math.min(flat.length, i + 4); k++) {
      joined += flat[k];
      if (n.has(joined)) return true;
    }
  }
  return false;
}

const AFFIRM = new Set(["yes", "yeah", "yep", "yup", "ya", "yea", "y", "sure", "ok", "okay", "k", "kk", "go ahead",
  "do it", "yes do it", "please do", "yes please do", "go for it", "sounds good", "correct", "right", "that one", "yes that one"]);
/** Is their whole message a bare yes ("Yes!", "ok please", "go ahead, thanks")? */
export function isBareYes(text) {
  const t = norm(text).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()
    .replace(/\s*\b(please|thanks|thank you|ty)$/, "").trim();
  return AFFIRM.has(t);
}

const own = (m) => ownerTexts([m]).length === 1;
// What they typed in one of their own messages, exactly as trust.ownerTexts reads it: the time stamp
// and their name label off the first line, then only the typed lines (the bracketed notes under it
// never count). Their name label is not their words: a display name such as "Chase" never names a
// site, and "Omari: yes" is a bare yes. Only the label is cut, so "Con Ed: pay the bill" still names it.
const typedBy = (m) => ownerTexts([m])[0] ?? "";
const reasonText = (m) => typeof m.content === "string" ? m.content
  : Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => String(b.text ?? "")).join("\n") : "";

/**
 * May this saved login be used, by the person's own words? `messages` is the stored thread as the
 * tools get it (ctx.messages), `login` the saved row, `logins` all of their saved rows (for the yes
 * case's "exactly one"). → { ok, how: "named" | "yes" } or { ok: false }.
 */
export function namedByThem(messages = [], login, logins = []) {
  const list = Array.isArray(messages) ? messages : [];
  const theirs = list.filter(own).slice(-NAMED_WINDOW).map(typedBy).filter(Boolean);
  if (theirs.some(t => names(t, login))) return { ok: true, how: "named" };

  // The yes case, from the thread's order. Their newest own message, the user-side message before it
  // (it must be their own, so the reply in between answered them, not an email or a timer), and
  // Reason's words in between.
  let last = -1;
  for (let i = list.length - 1; i >= 0; i--) if (own(list[i])) { last = i; break; }
  if (last < 0 || !isBareYes(typedBy(list[last]))) return { ok: false };
  let prev = -1;
  for (let i = last - 1; i >= 0; i--) if (list[i]?.role === "user" && typeof list[i].content === "string") { prev = i; break; }
  if (prev < 0 || !own(list[prev])) return { ok: false };
  const said = list.slice(prev + 1, last).filter(m => m?.role === "assistant").map(reasonText).join("\n");
  if (!said.trim()) return { ok: false };
  const hit = (logins.length ? logins : [login]).filter(l => names(said, l));
  const sites = new Set(hit.map(l => String(l.site ?? "").toLowerCase()));
  return sites.size === 1 && sites.has(String(login?.site ?? "").toLowerCase()) ? { ok: true, how: "yes" } : { ok: false };
}
