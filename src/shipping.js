// The shipping and contact profile behind a checkout (2026-10-31). At 12:16 ET the Ulta checkout for
// the owner's CeraVe reached the shipping form and Reason texted him "Send me your last name, street
// address, city and zip in the next 10 min, or it times out", when his address was already in the
// Walmart run's instruction (shop_run_asks.what), in his facts and in his account. His rule: if Reason
// already knows it, it at most asks to confirm; the person does as little as possible. So:
//
//   - one canonical record per person (shop_shipping): name, street, apt, city, state, zip, phone,
//     email, filled once from what is already stored (prior checkout instructions, facts, the account,
//     the connected Gmail) and from anything they type in a form answer, which wins over a guess;
//   - a store's form is matched field by field (key, label, autoComplete) and answered from the record
//     by code; a dropdown (Ulta's `state` is 61 options whose values are "option-N") is answered with
//     the option's value, never the text — the text is what Crossmint refused twice at 12:17;
//   - what the record lacks is the only thing asked for.
//
// Values are personal: nothing here is logged (src/privacy.js seals shop_answer's input) and the
// record is read only to answer a checkout of the same person.
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { clock } from "./config.js";

db.db.exec(`
  CREATE TABLE IF NOT EXISTS shop_shipping (
    conversation_id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    address1 TEXT NOT NULL DEFAULT '',
    address2 TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    zip TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
const q = (sql) => db.db.prepare(sql);

export const FIELDS = ["first_name", "last_name", "address1", "address2", "city", "state", "zip", "phone", "email"];
/** What a shipping form needs before it can be answered without asking: everything but the apartment line. */
export const NEEDED = FIELDS.filter((f) => f !== "address2");

// ---------------------------------------------------------------- states and ZIPs
export const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
};
const STATE_BY_NAME = Object.fromEntries(Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]));
// First three digits of a ZIP → state (USPS prefix ranges). A typed "Bronx 10469" needs no state said.
const ZIP_PREFIX = [[5, 5, "NY"], [6, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"], [50, 59, "VT"], [60, 69, "CT"],
  [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"], [200, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"],
  [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"], [320, 349, "FL"], [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"],
  [400, 427, "KY"], [430, 459, "OH"], [460, 479, "IN"], [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [569, 569, "DC"],
  [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"], [700, 714, "LA"],
  [716, 729, "AR"], [730, 749, "OK"], [750, 799, "TX"], [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"], [850, 865, "AZ"],
  [870, 884, "NM"], [885, 885, "TX"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"], [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"]];
export function stateOfZip(zip) {
  const n = Number(String(zip ?? "").slice(0, 3));
  if (!Number.isFinite(n)) return "";
  return ZIP_PREFIX.find(([a, b]) => n >= a && n <= b)?.[2] ?? "";
}
/** "NY" from "ny", "New York" or "NY - New York"; "" when it is not a state. */
export function stateCode(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^[A-Za-z]{2}$/.test(s) && STATES[s.toUpperCase()]) return s.toUpperCase();
  const name = STATE_BY_NAME[s.toLowerCase()];
  if (name) return name;
  const m = /^([A-Za-z]{2})\s*[-–:]/.exec(s);
  if (m && STATES[m[1].toUpperCase()]) return m[1].toUpperCase();
  return "";
}

// ---------------------------------------------------------------- normalizing
const WORD_NUMBERS = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
export function normalize(field, v) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  switch (field) {
    case "zip": { const m = /^(\d{5})(?:-\d{4})?$/.exec(s); return m ? m[1] : ""; }
    case "phone": { let d = s.replace(/\D/g, ""); if (d.length === 11 && d.startsWith("1")) d = d.slice(1); return d.length === 10 ? d : ""; }
    case "state": return stateCode(s);
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : "";
    case "address2": {
      const m = /^(?:(apt|apartment|unit|suite|ste|fl|floor)\.?\s*#?\s*|#\s*)?([A-Za-z0-9-]+)$/i.exec(s);
      if (!m) return s.slice(0, 60);
      const num = WORD_NUMBERS[m[2].toLowerCase()] ?? m[2];
      const kind = (m[1] ?? "apt").toLowerCase();
      return `${kind.startsWith("ap") ? "Apt" : kind.startsWith("s") ? "Suite" : kind.startsWith("f") ? "Floor" : "Unit"} ${num}`;
    }
    case "first_name": case "last_name": case "city": return /^[a-z]/.test(s) ? titleCase(s) : s.slice(0, 60);
    default: return s.slice(0, 120);
  }
}

// ---------------------------------------------------------------- reading an address out of text
const STREET_WORDS = "Avenue|Ave|Street|St|Road|Rd|Boulevard|Blvd|Drive|Dr|Place|Pl|Court|Ct|Lane|Ln|Way|Parkway|Pkwy|Terrace|Ter|Highway|Hwy|Circle|Cir|Square|Sq|Trail|Trl|Broadway|Concourse|Plaza|Loop|Row|Walk";
const STREET = new RegExp(`\\b(\\d{1,6}[A-Za-z]?(?:\\s+(?:[NSEW]|North|South|East|West))?(?:\\s+[A-Za-z0-9'.-]+){1,4}?\\s+(?:${STREET_WORDS})\\b\\.?)`, "i");
const APT = /\b(?:(apt|apartment|unit|suite|ste|fl|floor)\.?\s*#?\s*|#\s*)([A-Za-z]?\d+[A-Za-z]?|[A-Za-z]|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;
const APT_GLUED = /\b(apt|unit|ste)(\d+[A-Za-z]?)\b/i;
const ZIP = /\b(\d{5})(?:-\d{4})?\b/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;
/**
 * One US address out of a line of text ("Omari Nyarko, 3247 Bruner Ave, Apt 1, Bronx, NY 10469", or his
 * typed "Nyarko, 3247 Bruner Ave, Bronx 10469 apt1"). Needs a street and a ZIP: an address without a ZIP
 * ("3247 Brauna Avenue", a voice-note mishearing on record) is not trusted. Returns the fields found, with
 * `span` [start, end] of the address in the text, or null.
 */
export function parseAddress(text) {
  const s = String(text ?? "").replace(/\s+/g, " ");
  const st = STREET.exec(s);
  if (!st) return null;
  const start = st.index;
  let tail = s.slice(start + st[0].length);
  // The address ends at the ZIP (or the apartment after it); the rest of the sentence is not ours.
  const zipAt = ZIP.exec(tail);
  // The ZIP belongs to the address only close behind the street (", Apt 1, Bronx, NY 10469"): a number
  // six words on ("order 25416 units") is not it.
  if (!zipAt || zipAt.index > 60 || tail.slice(0, zipAt.index).trim().split(/\s+/).filter(Boolean).length > 7) return null;
  let end = start + st[0].length + zipAt.index + zipAt[0].length;
  let region = tail.slice(0, zipAt.index);
  const afterZip = tail.slice(zipAt.index + zipAt[0].length);
  const aptAfter = /^[\s,]*((?:apt|apartment|unit|suite|ste|#)\.?\s*#?\s*(?:[A-Za-z]?\d+[A-Za-z]?|one|two|three|four|five|six|seven|eight|nine|ten)|apt\d+[A-Za-z]?)\b/i.exec(afterZip);
  if (aptAfter) { end += aptAfter.index + aptAfter[0].length; }
  const out = { address1: st[1].replace(/\.$/, "").replace(/\s+/g, " ").trim(), zip: zipAt[1] };
  const apt = APT.exec(region) ?? APT_GLUED.exec(region) ?? (aptAfter ? (APT.exec(aptAfter[1]) ?? APT_GLUED.exec(aptAfter[1])) : null);
  if (apt) {
    const raw = apt[0];
    out.address2 = normalize("address2", raw);
    region = region.replace(raw, " ");
  }
  // What is left before the ZIP: ", Bronx, NY" / " Bronx" / ", Bronx, New York".
  const words = region.replace(/[,]+/g, " , ").replace(/\s+/g, " ").trim().split(" ").filter((w) => w !== ",");
  // Between the street and the ZIP only place words stand (a city, a state): "order 25416 units" is not an address.
  if (words.some((w) => !/^[A-Z][A-Za-z.'-]*$/.test(w))) return null;
  let state = "";
  const last = words[words.length - 1] ?? "";
  const lastTwo = words.slice(-2).join(" ");
  if (stateCode(lastTwo) && /^[A-Z]/.test(lastTwo)) { state = stateCode(lastTwo); words.splice(-2); }
  else if (last && stateCode(last) && (last.length === 2 ? /^[A-Z]{2}$/.test(last) : true)) { state = stateCode(last); words.pop(); }
  const city = words.filter((w) => /^[A-Za-z][A-Za-z.'-]*$/.test(w)).slice(-3).join(" ").trim();
  if (city) out.city = normalize("city", city);
  out.state = state || stateOfZip(out.zip);
  // A name right before the address, only where it is clearly one: after "to"/"for" ("shipped to Omari
  // Nyarko, 3247 …"), or a lone word opening the text ("Nyarko, 3247 …", his typed reply). Not two product
  // words that happen to be capitalized ("Facial Cleanser, 3247 …").
  const before = s.slice(0, start).replace(/[\s,]+$/, "");
  const LEAD = /^\b(?:to|for)\s+(?:(?:my|his|her|their|our)\s+(?:[a-z]+\s+)?)?/;
  const nm = /\b(?:to|for)\s+(?:(?:my|his|her|their|our)\s+(?:[a-z]+\s+)?)?([A-Z][a-z'-]+)(?:\s+([A-Z][a-z'-]+))?$/.exec(before) ?? /^\s*([A-Z][a-z'-]+)$/.exec(before);
  if (nm && !/^(?:Ave|St|Apt|Ship|Shipped|Deliver|Delivered|To|For|The|Address|Home|My|Their|His|Her|Mom|Dad|Mum)$/i.test(nm[1]) && !(nm[2] && /^(?:Ave|St|Apt|Address|Home)$/i.test(nm[2]))) {
    if (nm[2]) { out.first_name = nm[1]; out.last_name = nm[2]; } else out.name_word = nm[1];
    const lead = (LEAD.exec(nm[0]) ?? /^\s*/.exec(nm[0]))[0].length;
    out.name_span = [before.length - nm[0].length + lead, before.length];
  }
  out.span = [start, end];
  return out;
}
export function emailsIn(text) { return [...new Set((String(text ?? "").match(EMAIL) ?? []).map((e) => e.toLowerCase()))]; }
export function phoneIn(text) {
  const m = PHONE.exec(String(text ?? ""));
  return m ? normalize("phone", `${m[1]}${m[2]}${m[3]}`) : "";
}

// ---------------------------------------------------------------- the record
export const profileRow = (conversationId) => q("SELECT * FROM shop_shipping WHERE conversation_id = ?").get(conversationId) ?? null;
export const missingOf = (row) => NEEDED.filter((f) => !row?.[f]);
export const complete = (row) => !!row && missingOf(row).length === 0;
/**
 * Keeps what is given: every non-empty field, normalized, over what is there — unless `onlyMissing`, which
 * fills blanks only (a guess from the record never overwrites what they typed). `name_word` (one word
 * before an address) is the first name when it is the first name already known, else the last name.
 */
export function learn(conversationId, fields, { source = "", onlyMissing = false } = {}) {
  if (!conversationId || !fields) return profileRow(conversationId);
  const have = profileRow(conversationId);
  const next = {};
  for (const f of FIELDS) {
    const v = normalize(f, fields[f]);
    if (!v) continue;
    if (onlyMissing && have?.[f]) continue;
    next[f] = v;
  }
  if (fields.name_word && !next.first_name && !next.last_name) {
    const w = normalize("first_name", fields.name_word);
    const first = next.first_name || have?.first_name || "";
    if (first && first.toLowerCase() === w.toLowerCase()) { /* already their first name */ }
    else if (!(onlyMissing && have?.last_name)) next.last_name = w;
  }
  if (!Object.keys(next).length) return have;
  const now = clock.now();
  if (!have) {
    q(`INSERT INTO shop_shipping (conversation_id, ${FIELDS.join(", ")}, source, created_at, updated_at) VALUES (?, ${FIELDS.map(() => "?").join(", ")}, ?, ?, ?)`)
      .run(conversationId, ...FIELDS.map((f) => next[f] ?? ""), source, now, now);
  } else {
    const sources = [...new Set(String(have.source ?? "").split(",").filter(Boolean).concat(source ? [source] : []))].join(",");
    q(`UPDATE shop_shipping SET ${Object.keys(next).map((f) => `${f} = ?`).join(", ")}, source = ?, updated_at = ? WHERE conversation_id = ?`)
      .run(...Object.values(next), sources, now, conversationId);
  }
  return profileRow(conversationId);
}
export function markUsed(conversationId) { q("UPDATE shop_shipping SET used = used + 1 WHERE conversation_id = ?").run(conversationId); }
export function forget(conversationId) { q("DELETE FROM shop_shipping WHERE conversation_id = ?").run(conversationId); }

/**
 * Fills blanks from what is already stored about this person, newest and most deliberate first:
 * the instructions of their earlier checkouts, their facts about shipping or delivery, the account they
 * text from, the Gmail they connected. Nothing they typed into a form is overwritten.
 */
export function gather(conversationId) {
  const found = {};
  const take = (fields) => { for (const [k, v] of Object.entries(fields ?? {})) if (v && !found[k] && (FIELDS.includes(k) || k === "name_word")) found[k] = v; };
  try {
    const asks = q("SELECT a.what FROM shop_run_asks a JOIN shop_runs r ON r.run_id = a.run_id WHERE r.conversation_id = ? ORDER BY r.created_at DESC LIMIT 20").all(conversationId);
    for (const a of asks) { const p = parseAddress(a.what); if (p) take(p); take({ phone: phoneIn(a.what) }); const em = emailsIn(a.what); if (em.length === 1) take({ email: em[0] }); }
  } catch { /* no runs yet */ }
  try {
    // Their own facts only: the self subjects, and the person named as the account is (a contact's
    // "ship to …" is the contact's address, not theirs).
    let own = "";
    try { own = String(accounts.ownerOf(conversationId)?.name ?? "").trim().toLowerCase(); } catch { own = ""; }
    const keys = ["user", "the user", "me", "myself", "i", "the person", "this person", "owner", "the owner", ...(own && !/^the person\b/.test(own) ? [own, own.split(/\s+/)[0]] : [])];
    const facts = q(`SELECT f.fact FROM person_facts f JOIN people p ON p.id = f.person_id WHERE p.conversation_id = ? AND lower(p.key) IN (${keys.map(() => "?").join(", ")}) ORDER BY f.created_at DESC LIMIT 400`).all(conversationId, ...keys).map((r) => r.fact);
    const about = /\b(ship(?:ped|ping)?\s+to|deliver(?:y|ed)?\s+(?:to|address|phone|number)|home address|my address|their address|shipping address|billing address|mailing address)\b/i;
    for (const f of facts) if (about.test(f)) { const p = parseAddress(f); if (p) take(p); }
    for (const f of facts) if (/\b(delivery|shipping|contact|their|my|his|her)\s+(phone|number|cell|mobile)\b/i.test(f)) take({ phone: phoneIn(f) });
    for (const f of facts) if (/\be-?mail\b/i.test(f)) { const em = emailsIn(f); if (em.length === 1) take({ email: em[0] }); }
  } catch { /* no facts */ }
  try {
    const owner = accounts.ownerOf(conversationId);
    const name = String(owner?.name ?? "").trim();
    if (name && !/^the person\b/i.test(name)) {
      const [first, ...rest] = name.split(/\s+/);
      take({ first_name: first, ...(rest.length ? { last_name: rest.join(" ") } : {}) });
    }
    take({ phone: phoneIn(owner?.address ?? "") });
  } catch { /* no account */ }
  try {
    const mails = db.listOauthTokens(conversationId, "google").map((t) => String(t.account_label ?? "")).filter((l) => l.includes("@"));
    const pick = db.listOauthTokens(conversationId, "google").find((t) => t.is_default && String(t.account_label ?? "").includes("@"))?.account_label ?? (mails.length === 1 ? mails[0] : "");
    if (pick) take({ email: pick });
  } catch { /* no mail */ }
  return learn(conversationId, found, { source: "record", onlyMissing: true });
}
/**
 * Every email known for this person, most deliberate first and without repeats: the one on their
 * record, the Gmail accounts they connected (the default first), the ones in their own facts and in
 * their earlier checkout instructions. The card's receipts need one; with two or more it is their
 * choice (2026-10-31, the owner's rule: name what is on record, ask only for the decision).
 */
export function knownEmails(conversationId) {
  const out = [];
  const add = (e) => { const v = normalize("email", e); if (v && !out.includes(v)) out.push(v); };
  add(profileRow(conversationId)?.email);
  try {
    const tokens = db.listOauthTokens(conversationId, "google").filter((t) => String(t.account_label ?? "").includes("@"));
    for (const t of [...tokens.filter((t) => t.is_default), ...tokens]) add(t.account_label);
  } catch { /* no mail */ }
  try {
    let own = "";
    try { own = String(accounts.ownerOf(conversationId)?.name ?? "").trim().toLowerCase(); } catch { own = ""; }
    const keys = ["user", "the user", "me", "myself", "i", "the person", "this person", "owner", "the owner", ...(own && !/^the person\b/.test(own) ? [own, own.split(/\s+/)[0]] : [])];
    const facts = q(`SELECT f.fact FROM person_facts f JOIN people p ON p.id = f.person_id WHERE p.conversation_id = ? AND lower(p.key) IN (${keys.map(() => "?").join(", ")}) ORDER BY f.created_at DESC LIMIT 400`).all(conversationId, ...keys).map((r) => r.fact);
    // Their own email: "my email", "his email is", "email: x" — never a second person's ("my accountant's
    // email", "Ama's email", "ship to Ama at …").
    const theirs = /\b(?:my|his|her|their|user'?s?|owner'?s?)\s+(?:(?:work|personal|other|second|school|main)\s+)?e-?mail\b|\be-?mail(?:\s+address)?\s*(?:is|:)/i;
    const someoneElse = /\b[A-Z][a-z]+'s\s+(?:\w+\s+)?e-?mail\b|\b(?:accountant|assistant|wife|husband|partner|mom|dad|mother|father|sister|brother|friend|boss|colleague)'?s?\s+(?:\w+\s+)?e-?mail\b/i;
    for (const f of facts) if (theirs.test(f) && !someoneElse.test(f)) for (const e of emailsIn(f)) add(e);
  } catch { /* no facts */ }
  // Earlier checkout instructions are not read here: "ship to Ama at ama@…" names a contact, not them.
  return out;
}
/** True when the record's email is one they gave (typed in a form, said, or corrected), not one gathered. */
export const emailDecided = (row) => !!row?.email && /\b(said|answer|correction|typed)\b/.test(String(row.source ?? ""));
/** The record, gathered first when it is missing or short. */
export function profileFor(conversationId) {
  const have = profileRow(conversationId);
  return complete(have) ? have : gather(conversationId) ?? have;
}

// ---------------------------------------------------------------- answering a form from it
/** Which of ours a store's field is, from its autoComplete, key and label; null when it is not ours (a size, a note). */
export function roleOf(f) {
  const ac = String(f?.input?.autoComplete ?? "").toLowerCase();
  const byAc = { "given-name": "first_name", "family-name": "last_name", name: "full_name", "address-line1": "address1", "address-line2": "address2",
    "address-level2": "city", "address-level1": "state", "postal-code": "zip", tel: "phone", "tel-national": "phone", email: "email", country: "country", "country-name": "country" };
  if (byAc[ac]) return byAc[ac];
  const k = `${f?.key ?? ""} ${f?.label ?? ""}`.toLowerCase();
  if (/first.?name|given/.test(k)) return "first_name";
  if (/last.?name|surname|family/.test(k)) return "last_name";
  if (/^(full.?)?name\b|recipient|ship.?to.?name|your name/.test(k)) return "full_name";
  if (/address.?(line.?)?2|apt|apartment|suite|unit\b/.test(k)) return "address2";
  if (/address.?(line.?)?1|\baddress1?\b|street|\baddr\b/.test(k)) return "address1";
  if (/\bcity\b|\btown\b/.test(k)) return "city";
  if (/\bstate\b|province|region/.test(k)) return "state";
  if (/\bzip\b|postal/.test(k)) return "zip";
  if (/phone|mobile|\btel\b/.test(k)) return "phone";
  if (/e-?mail/.test(k)) return "email";
  if (/country/.test(k)) return "country";
  return null;
}
/**
 * The option a choice field means by `value`: by value, by label, by a state's code or name ("NY" →
 * "NY - New York" → "option-33"). Placeholders ("Select state") and disabled options never match.
 */
export function matchOption(options, value) {
  const opts = (Array.isArray(options) ? options : []).filter((o) => o && !o.disabled && !o.placeholder && o.value !== undefined && o.value !== null);
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const v = norm(value);
  if (!v) return null;
  const labelOf = (o) => norm(typeof o === "string" ? o : o.label ?? o.value);
  const valueOf = (o) => (typeof o === "string" ? o : o.value);
  let hit = opts.find((o) => norm(valueOf(o)) === v) ?? opts.find((o) => labelOf(o) === v);
  if (hit) return valueOf(hit);
  const code = stateCode(value);
  if (code) {
    const name = STATES[code].toLowerCase();
    hit = opts.find((o) => labelOf(o) === name) ?? opts.find((o) => new RegExp(`^${code.toLowerCase()}\\b`).test(labelOf(o)))
      ?? opts.filter((o) => new RegExp(`\\b${name}\\b`).test(labelOf(o))).sort((a, b) => labelOf(a).length - labelOf(b).length)[0];
    if (hit) return valueOf(hit);
  }
  if (/^(us|usa|united states( of america)?)$/.test(v)) {
    hit = opts.find((o) => /^(us|usa|united states( of america)?)$/.test(labelOf(o)) || /^(us|usa)$/.test(norm(valueOf(o))));
    if (hit) return valueOf(hit);
  }
  // Last: the one option whose label starts a word with it ("Large" for "large"); a tie or a mid-word hit
  // ("L" inside "Small") is no match, and the words given are sent as they are.
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const starts = opts.filter((o) => new RegExp(`(^|\\W)${esc}`).test(labelOf(o)));
  return starts.length === 1 ? valueOf(starts[0]) : null;
}
/** The record's value for a store's field, shaped for that field (a choice gets the option's value); "" when unknown. */
export function valueFor(f, row) {
  const role = roleOf(f);
  if (!role) return "";
  let v = role === "full_name" ? [row?.first_name, row?.last_name].filter(Boolean).join(" ")
    : role === "country" ? "US" : String(row?.[role] ?? "");
  if (!v) return "";
  if (role === "phone" && f?.input?.kind !== "integer" && f?.input?.kind !== "number") v = `${v.slice(0, 3)}-${v.slice(3, 6)}-${v.slice(6)}`;
  if (f?.input?.kind === "choice") {
    const m = matchOption(f.input.options, v) ?? (role === "state" ? matchOption(f.input.options, STATES[v] ?? v) : null);
    return m === null ? "" : m;
  }
  return v;
}
/**
 * The whole form against the record: `answers` for every field the record covers, `filled` (their keys),
 * `missing` (required fields it does not cover, with the label to ask by, and `ours` false when the field
 * is not a shipping or contact detail at all — a size, a gift note). `covered` when nothing required is missing
 * and at least one field was ours: that form is answered without asking.
 */
export function fill(interaction, row) {
  const fields = Array.isArray(interaction?.fields) ? interaction.fields : [];
  const answers = {}; const filled = []; const missing = [];
  for (const f of fields) {
    if (!f?.key || f.handling === "protected") { if (f?.required) missing.push({ key: f?.key ?? "", label: f?.label ?? f?.key ?? "", ours: false }); continue; }
    const v = valueFor(f, row);
    if (v) { answers[f.key] = v; filled.push(f.key); }
    else if (f.required) missing.push({ key: f.key, label: f.label || f.key, ours: !!roleOf(f) });
  }
  return { answers, filled, missing, covered: missing.length === 0 && filled.length > 0 };
}
/** What they typed into a form, kept: each field that is ours, by its role. A full name splits once. */
export function learnFromAnswers(conversationId, interaction, answers, { source = "answer" } = {}) {
  const fields = new Map((interaction?.fields ?? []).map((f) => [f.key, f]));
  const out = {};
  for (const [k, v] of Object.entries(answers ?? {})) {
    const f = fields.get(k);
    if (!f || f.handling === "protected" || typeof v !== "string" || f.input?.kind === "choice") continue;
    const role = roleOf(f);
    if (!role || role === "country") continue;
    if (role === "full_name") { const [first, ...rest] = v.trim().split(/\s+/); out.first_name = first; if (rest.length) out.last_name = rest.join(" "); }
    else out[role] = v;
  }
  // A choice (Ulta's state dropdown) is kept as the state it names, when the label says one.
  for (const [k, v] of Object.entries(answers ?? {})) {
    const f = fields.get(k);
    if (!f || f.input?.kind !== "choice" || roleOf(f) !== "state") continue;
    const opt = (f.input.options ?? []).find((o) => (typeof o === "string" ? o : o.value) === v);
    const code = stateCode(typeof opt === "string" ? opt : opt?.label ?? "") || stateCode(v);
    if (code) out.state = code;
  }
  return Object.keys(out).length ? learn(conversationId, out, { source }) : profileRow(conversationId);
}

// ---------------------------------------------------------------- in words
/** "3247 Bruner Ave Apt 1, Bronx": the one line a person recognizes their own address by. */
export function shortAddress(row) {
  if (!row?.address1) return "";
  return `${row.address1}${row.address2 ? ` ${row.address2}` : ""}${row.city ? `, ${row.city}` : ""}`;
}
/** "Omari Nyarko, 3247 Bruner Ave, Apt 1, Bronx, NY 10469": the address as a checkout instruction says it. */
export function fullAddress(row) {
  if (!row?.address1) return "";
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ");
  const place = [row.address1, row.address2, row.city, [row.state, row.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return name ? `${name}, ${place}` : place;
}
/** The labels of what is filled, for the person: "your name, street, apt, city, state, zip and phone". */
export function filledWords(interaction, filled) {
  const words = [];
  const seen = new Set();
  for (const f of interaction?.fields ?? []) {
    if (!filled.includes(f.key)) continue;
    const role = roleOf(f);
    const w = { first_name: "first name", last_name: "last name", full_name: "name", address1: "street", address2: "apt", city: "city", state: "state", zip: "zip", phone: "phone", email: "email", country: "country" }[role] ?? f.label ?? f.key;
    if (!seen.has(w)) { seen.add(w); words.push(w); }
  }
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0] ?? "";
}
/**
 * The address a checkout instruction names itself, when it names one that is not the record's (a gift:
 * "shipped to Ama Nyarko, 12 Other St, Newark, NJ 07102"). Null when it names none, or the record's own.
 */
export function addressInInstruction(what, row) {
  const p = parseAddress(what);
  if (!p) return null;
  // The same ZIP is their own address, as the record now has it (a corrected street number is the usual
  // reason the two differ); another ZIP is somebody else's.
  if (row?.zip && p.zip === row.zip) return null;
  return p;
}
/**
 * `what` for a checkout with the record's address written in: the record's own address, when the text
 * has it (the same ZIP and street), is written whole (apt and all, as corrected); an address it does not
 * have is added where it says to ship. An address that is somebody else's (a gift) is left exactly as written.
 */
export function withAddress(what, row) {
  // Offsets from parseAddress are into the whitespace-collapsed text, so that is what is sliced.
  const text = String(what ?? "").replace(/\s+/g, " ").trim();
  if (!complete(row)) return text;
  const p = parseAddress(text);
  if (p) {
    if (addressInInstruction(text, row)) return text;
    return replaceAddress(text, p, row);
  }
  if (/\b(ship|deliver|address on file|home address|to home|my address|their address)\b/i.test(text)) return `${text.replace(/\.?$/, ".")} Ship to ${fullAddress(row)}.`;
  return text;
}
/** `text` with the parsed address `p` (and the name before it) replaced by the record's, whatever ZIP it had. */
export function replaceAddress(text, p, row) {
  const [a, b] = p.span;
  const start = p.name_span && (p.first_name || p.name_word) ? p.name_span[0] : a;
  return `${text.slice(0, start)}${fullAddress(row)}${text.slice(b)}`.replace(/\s+/g, " ").replace(/\s+([,.])/g, "$1").trim();
}
/**
 * The record a run's form is answered from: the person's own, unless the run's instruction ships
 * somewhere else — then that address (and the name it gives, if any) over the record's contact details.
 */
export function recordForRun(row, what) {
  const other = addressInInstruction(what, row);
  if (!other) return { row, own: true };
  const merged = { ...(row ?? {}), address1: other.address1, address2: other.address2 ?? "", city: other.city ?? "", state: other.state ?? "", zip: other.zip };
  if (other.first_name) { merged.first_name = other.first_name; merged.last_name = other.last_name ?? ""; }
  return { row: merged, own: false };
}
