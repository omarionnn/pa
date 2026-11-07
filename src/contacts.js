// Reading a contact card somebody shared over iMessage.
//
// A vCard (.vcf) is plain text — BEGIN:VCARD, properties, END:VCARD — and needs no library, model
// call or system tool. The fields that matter on a shared contact are name, phone, email, org and
// birthday; anything exotic is included raw rather than dropped. Parsing is here, not in a
// dependency, because the format is simple enough that a dependency would be more code than the
// parser and would need vetting.
//
// The pattern mirrors src/voice.js: the adapter puts a placeholder line saying the card could not
// be read, and readContactsInto() replaces it with what the card actually says — during the drain,
// with the bubble already up. If the download fails, the placeholder stays and the model says so.
import { guardedFetch } from "./netguard.js";
import { checkUrl } from "./pictures.js";
import { cannotReadContactLine } from "./channels/sendblue.js";
import { config } from "./config.js";

const MAX_CONTACT_BYTES = 1_024 * 1_024; // 1 MB — a contact card with a photo can be large
const DOWNLOAD_TIMEOUT_MS = 15_000;

export const isContact = (a) => a?.kind === "contact";

/**
 * Unfold RFC 2425 §5.8.1 continuation lines: a line that begins with a single space or tab is a
 * continuation of the previous line. vCard 3.0 folds at 75 octets; 4.0 does the same.
 */
function unfold(raw) {
  return raw.replace(/\r?\n[ \t]/g, "");
}

/**
 * Unescape a vCard property value (RFC 6350 §3.4): \\, \n, \,, \;.
 */
function vUnescape(v) {
  return String(v ?? "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/**
 * Parse one vCard from text into a flat object of the fields the model should see.
 * Returns null if the text is not a recognisable vCard.
 */
export function parseVCard(text) {
  const unfolded = unfold(text);
  const lines = unfolded.split(/\r?\n/);

  let inside = false;
  const props = [];
  for (const line of lines) {
    if (/^BEGIN:VCARD$/i.test(line.trim())) { inside = true; continue; }
    if (/^END:VCARD$/i.test(line.trim())) { inside = false; continue; }
    if (!inside) continue;
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const parts = left.split(";");
    const name = parts[0].toUpperCase();
    const params = parts.slice(1).map(p => p.toUpperCase());
    props.push({ name, params, value });
  }

  if (!props.length) return null;

  const get = (n) => props.find(p => p.name === n)?.value ?? "";
  const getAll = (n) => props.filter(p => p.name === n);

  const fn = vUnescape(get("FN")).trim();
  const n = get("N");
  const nParts = n ? n.split(";").map(s => vUnescape(s).trim()) : [];
  const structuredName = nParts.filter(Boolean).length
    ? { last: nParts[0] || "", first: nParts[1] || "", middle: nParts[2] || "" }
    : null;
  const displayName = fn || (structuredName ? [structuredName.first, structuredName.middle, structuredName.last].filter(Boolean).join(" ") : "");

  const phones = getAll("TEL").map(p => {
    const type = p.params.find(s => /TYPE=/.test(s))?.replace(/TYPE=/i, "") || "";
    return { number: vUnescape(p.value).trim(), type: type.toLowerCase() };
  });

  const emails = getAll("EMAIL").map(p => vUnescape(p.value).trim()).filter(Boolean);
  const org = vUnescape(get("ORG")).replace(/;+$/, "").trim();
  const title = vUnescape(get("TITLE")).trim();
  const bday = vUnescape(get("BDAY")).trim();
  const urls = getAll("URL").map(p => vUnescape(p.value).trim()).filter(Boolean);
  const note = vUnescape(get("NOTE")).trim();
  const addresses = getAll("ADR").map(p => {
    const parts = p.value.split(";").map(s => vUnescape(s).trim());
    return [parts[2], parts[3], parts[4], parts[5], parts[6]].filter(Boolean).join(", ");
  }).filter(Boolean);

  return { displayName, structuredName, phones, emails, org, title, bday, urls, note, addresses };
}

/**
 * A human-readable description of a parsed contact, for the model to read.
 */
export function describeContact(card) {
  const lines = [];
  if (card.displayName) lines.push(`name: ${card.displayName}`);
  if (card.org) lines.push(`org: ${card.org}`);
  if (card.title) lines.push(`title: ${card.title}`);
  for (const p of card.phones) {
    lines.push(`phone${p.type ? ` (${p.type})` : ""}: ${p.number}`);
  }
  for (const e of card.emails) lines.push(`email: ${e}`);
  for (const u of card.urls) lines.push(`url: ${u}`);
  for (const a of card.addresses) lines.push(`address: ${a}`);
  if (card.bday) lines.push(`birthday: ${card.bday}`);
  if (card.note) lines.push(`note: ${card.note}`);
  return lines.join("\n");
}

/**
 * Download a vCard from a CDN URL and parse it.
 * Returns { ok, card, description } or { ok: false, error }.
 */
export async function readContact({ url, filename = "", fetchImpl = globalThis.fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  if (!url) return { ok: false, error: "it arrived with no link to the file" };
  const where = checkUrl(url);
  if (!where.ok) return { ok: false, error: `the contact card could not be downloaded: ${where.why}` };

  let text;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    t?.unref?.();
    try {
      // Every hop checked, never this machine's own network (src/netguard.js).
      const got = await guardedFetch(url, { fetchImpl, signal: ac.signal, httpsOnly: true });
      if (!got.ok) return { ok: false, error: `the contact card could not be downloaded: ${got.why}` };
      const res = got.res;
      if (!res.ok) return { ok: false, error: `the contact card could not be downloaded (HTTP ${res.status})` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { ok: false, error: "the contact card file was empty" };
      if (buf.length > MAX_CONTACT_BYTES) return { ok: false, error: "the contact card is too large to read" };
      text = buf.toString("utf-8");
    } finally { clearTimeout(t); }
  } catch (e) {
    return { ok: false, error: `the contact card could not be downloaded: ${e?.name === "AbortError" ? "it timed out" : (e?.message ?? String(e)).split("\n")[0]}` };
  }

  const card = parseVCard(text);
  if (!card) return { ok: false, error: "the file did not contain a readable contact card" };
  const description = describeContact(card);
  if (!description) return { ok: false, error: "the contact card was empty" };
  return { ok: true, card, description };
}

export function readContactLine(a, r) {
  return `[they shared a contact card (${a.filename}) — here is what it says:\n${r.description}]`;
}

export function couldNotReadContactLine(a, why) {
  return `[they shared a contact card (${a.filename}) and it could not be read: ${why}. say so in one short line]`;
}

/**
 * One held message's text, with every contact card in it read.
 * Mirrors hearInto() in src/voice.js: swaps the adapter's placeholder for the card's content.
 */
export async function readContactsInto(text, attachments = [], { log = () => {}, read = readContact, cover = () => {} } = {}) {
  const cards = attachments.filter(isContact);
  if (!cards.length) return text;
  let out = String(text ?? "");
  for (const a of cards) {
    cover(a.media_id, { coverage: "processing" });
    let r;
    try { r = await read({ url: a.url, filename: a.filename }); }
    catch (e) { r = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
    const line = r.ok ? readContactLine(a, r) : couldNotReadContactLine(a, r.error);
    const was = cannotReadContactLine(a);
    out = out.includes(was) ? out.replace(was, line) : [out, line].filter(Boolean).join("\n");
    cover(a.media_id, r.ok
      ? { coverage: "read", detail: r.card?.displayName || "" }
      : { coverage: "failed", detail: r.error });
    log(r.ok ? { contact_read: a.filename, name: r.card?.displayName } : { contact_failed: a.filename, why: r.error });
  }
  return out;
}
