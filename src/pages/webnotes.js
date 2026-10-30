// Reason Web: the notes Reason's pipeline writes into a person's stored message, drawn for people.
//
// What arrives over iMessage is stored with lines that are for the MODEL, not the page:
//   [they shared their location: Lefcourt …, 164, West 26th Street, Chelsea District, … (40.74…, -73.99…,
//    accuracy ~19m) (sharing: endOfDay) — use this as their current position … Use nearby_places …]
//   [they sent this as an inline reply in the thread under your message: "…" — so it is about that …]
//   [they shared a contact card (x.vcf) — here is what it says:\nname: …\nphone (cell): …]
//   [they sent that with the 'slam' screen effect on it — …]
// (src/channels/sendblue.js describe, src/replies.js, src/contacts.js, src/voice.js, src/channels/linq.js).
// The model keeps reading every word of them; only what a page shows changes. 2026-10-30: a location
// shared from iMessage showed on Web as the whole bracket, coordinates and tool instructions included,
// under a "?" — the share's own body is U+FFFD, a character with nothing to draw.
//
// Only lines that START with one of these notes are read as one, so the words a person typed are
// never taken for a note unless they typed one exactly. Coordinates and instructions never reach a page.

import { esc } from "./render.js";

/** The pipeline's notes, by how they open. `multi`: may run over several lines, up to one ending in "]". */
const KINDS = [
  { kind: "location", open: /^\[they shared their location:/i },
  { kind: "appcard", open: /^\[they sent an iMessage app card\b/i },
  { kind: "reply", open: /^\[they sent this as an inline reply\b/i },
  { kind: "burst", open: /^\[they sent the following as \d+ separate texts\b/i },
  { kind: "effect", open: /^\[they sent that with the '[^'\n]*' screen effect\b/i },
  { kind: "contact", open: /^\[they shared a contact card\b/i, multi: true },
  { kind: "voice", open: /^\[they sent (?:a voice note|an audio file)\b/i, multi: true },
  { kind: "file", open: /^\[they sent a file, which you cannot open:/i },
  { kind: "file", open: /^\[they sent [^\]\n]*, which you cannot open\]$/i },
  { kind: "down", open: /^\[reason was down from /i },
  // Any other whole-line note about what came with a message: not drawn, never shown as words.
  { kind: "other", open: /^\[they (?:sent|shared) [^\n]*\]$/i },
];
/** Characters a share's body can carry with nothing to draw (the "?" box): object replacement, replacement. */
const NOTHING = /[￼�]/g;

const DURATIONS = { endofday: "until end of day", onehour: "for an hour", indefinitely: "until they stop", forever: "until they stop" };
const ROAD = [[/\bStreet\b/g, "St"], [/\bAvenue\b/g, "Ave"], [/\bBoulevard\b/g, "Blvd"], [/\bRoad\b/g, "Rd"], [/\bPlace\b/g, "Pl"], [/\bDrive\b/g, "Dr"], [/\bLane\b/g, "Ln"], [/\bParkway\b/g, "Pkwy"]];
const JUNK = /community board|county\b|^\d{4,6}(?:-\d{4})?$|^united states$|^usa$|^(?:new york|california|texas|florida|illinois|new jersey|massachusetts|georgia|washington|pennsylvania)$/i;

const shortRoad = (r) => ROAD.reduce((s, [a, b]) => s.replace(a, b), r.replace(/^(North|South|East|West)\s+/i, (m, d) => `${d[0].toUpperCase()} `));
const area = (p) => p.replace(/\s+(?:Historic\s+)?District$/i, "").trim();

/** "Lefcourt …, 164, West 26th Street, Chelsea District, …, United States" → "164 W 26th St, Chelsea". */
export function shortPlace(displayName) {
  const parts = String(displayName ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  // A house number is a number with a road after it; a postcode has "United States" after it.
  const n = parts.findIndex((p, i) => /^\d+[a-z]?(?:[-–]\d+[a-z]?)?$/i.test(p) && parts[i + 1] && !JUNK.test(parts[i + 1]));
  let head, rest;
  if (n >= 0) { head = `${parts[n]} ${shortRoad(parts[n + 1])}`; rest = parts.slice(n + 2); }
  else { head = parts[0]; rest = parts.slice(1); }
  const next = rest.map(area).find(p => p && !JUNK.test(p) && p !== head);
  return next ? `${head}, ${next}` : head;
}

const until = (d) => {
  const k = String(d ?? "").trim();
  if (!k) return "";
  return DURATIONS[k.toLowerCase()] ?? k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
};
const cutTo = (s, max) => (s.length > max ? `${s.slice(0, max - 1).replace(/[\s,;:.]+$/, "")}…` : s);
/** A stored file's name without the store's 8-character prefix ("rytCHiLR_Stella_Rosa.vcf"). */
const bareName = (f) => String(f ?? "").trim().replace(/^[A-Za-z0-9]{8}_/, "");

/** One note's facts for a page — never its coordinates, never its instructions. Null: nothing to show. */
function readNote(kind, body) {
  if (kind === "burst" || kind === "down" || kind === "other") return null;
  if (kind === "location") {
    const inner = body.replace(/^\[they shared their location:\s*/i, "");
    const sharing = inner.match(/\(sharing:\s*([^)]+)\)/i)?.[1] ?? "";
    // The address is everything before the coordinates' "(", when there is an address at all.
    const lead = inner.split(/\s\(\s*-?\d/)[0].trim();
    const place = /^-?\d+(?:\.\d+)?\s*,\s*-?\d/.test(lead) ? "" : shortPlace(lead);
    return { kind, title: "Shared location", place, until: until(sharing) };
  }
  if (kind === "appcard") return { kind, title: "iMessage app card" };
  if (kind === "reply") {
    const q = body.match(/"([^"\n]*)"/)?.[1] ?? "";
    // The stored snippet is already cut with one "…" (src/replies.js); it keeps exactly one.
    const cut = q.endsWith("…");
    const bare = q.replace(/[….\s]+$/, "").trim();
    const short = cutTo(bare, 80);
    return { kind, title: "Reply", quote: !bare ? "" : short.endsWith("…") || !cut ? short : `${short}…` };
  }
  if (kind === "effect") {
    const style = body.match(/'([^'\n]*)'/)?.[1] ?? "";
    return { kind, title: `Sent with ${style.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() || "an effect"}` };
  }
  if (kind === "contact") {
    const name = body.match(/^name:\s*(.+)$/im)?.[1]?.trim() ?? "";
    return { kind, title: "Contact card", place: name || bareName(body.match(/\(([^)\n]+)\)/)?.[1]).replace(/\.vcf$/i, "").replace(/_/g, " ") };
  }
  if (kind === "voice") {
    const said = body.match(/"([\s\S]*)"\]\s*$/)?.[1]?.trim() ?? "";
    return { kind, title: "Voice note", said };
  }
  if (kind === "file") {
    const name = body.match(/cannot open:\s*([^\]\n]+)\]/i)?.[1] ?? body.match(/^\[they sent ([^\]\n]*?), which you cannot open\]$/i)?.[1] ?? "";
    // An iMessage link preview's own file is nothing a person sent on purpose (src/linkpreview.js).
    if (/\.pluginPayloadAttachment$/i.test(name)) return null;
    return { kind, title: "File", place: bareName(name) };
  }
  return null;
}

/**
 * A stored line split into the person's own words and the notes about it, read for a page.
 * `{ words, notes }`; `notes` hold only what is shown (see readNote).
 */
export function readLine(text) {
  const lines = String(text ?? "").replace(NOTHING, "").split("\n");
  const words = [], notes = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const k = t.startsWith("[") ? KINDS.find(x => x.open.test(t)) : null;
    if (!k) { words.push(lines[i]); continue; }
    let end = i;
    if (k.multi && !t.endsWith("]")) {
      // Runs to the first line that closes it; one that never closes is only its own first line.
      let j = i + 1;
      while (j < lines.length && !lines[j].trimEnd().endsWith("]")) j++;
      if (j < lines.length) end = j;
    }
    const note = readNote(k.kind, lines.slice(i, end + 1).join("\n").trim());
    if (note) notes.push(note);
    i = end;
  }
  return { words: words.join("\n").replace(/\n{3,}/g, "\n\n").trim(), notes };
}

/** One note as plain words: the daily edition's pickup, search, a chat's name. */
export const noteText = (n) => [n.title, n.place, n.until, n.quote ? `“${n.quote}”` : ""].filter(Boolean).join(" · ");

/** What a stored message reads as anywhere a person sees it in words: theirs, then the notes plainly. */
export function displayText(text) {
  const { words, notes } = readLine(text);
  const said = notes.filter(n => n.kind === "voice" && n.said).map(n => n.said);
  return [words, ...said, ...notes.filter(n => n.kind !== "voice" || !n.said).map(noteText)].filter(Boolean).join("\n");
}

const PIN_SVG = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.4"/></svg>`;
const REPLY_SVG = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v4"/></svg>`;

/**
 * The notes on a person's line, drawn. `media` is what the line already draws (photos, slips, ▶):
 * a file, contact card or voice note it draws is not drawn twice.
 */
export function notesHtml(notes, media = []) {
  const drawn = media.length > 0;
  return notes.filter(n => !(drawn && (n.kind === "file" || n.kind === "contact" || n.kind === "voice"))).map(n => {
    if (n.kind === "location") {
      const eyebrow = ["SHARED LOCATION", n.until ? n.until.toUpperCase() : ""].filter(Boolean).join(" · ");
      return `<div class="wnote wloc" role="note" aria-label="${esc(noteText(n))}"><span class="wn-e">${PIN_SVG}${esc(eyebrow)}</span>${n.place ? `<span class="wn-v">${esc(n.place)}</span>` : ""}</div>`;
    }
    if (n.kind === "reply") return `<div class="wnote wrep" role="note"><span class="wn-e">${REPLY_SVG}IN REPLY TO</span>${n.quote ? `<span class="wn-v">“${esc(n.quote)}”</span>` : ""}</div>`;
    if (n.kind === "voice") return `<div class="wnote" role="note"><span class="wn-e">VOICE NOTE</span>${n.said ? `<span class="wn-v">${esc(n.said)}</span>` : ""}</div>`;
    return `<div class="wnote" role="note"><span class="wn-e">${esc(n.title.toUpperCase())}</span>${n.place ? `<span class="wn-v">${esc(n.place)}</span>` : ""}</div>`;
  }).join("");
}

/** The notes' look: a paper tag on the person's side, mono eyebrow, the place in the serif. */
export const NOTES_CSS = `
.wnote{display:flex;flex-direction:column;align-items:flex-end;gap:3px;margin:2px 0 6px auto;max-width:min(100%,420px);padding:8px 12px;border:1px solid var(--hair);border-radius:4px;background:var(--lifted);text-align:right}
.wnote .wn-e{display:block;font:400 10px/1.5 var(--mono);letter-spacing:.14em;color:var(--muted)}
.wnote .wn-e svg{color:var(--pen);vertical-align:-3px;margin-right:6px}
.wnote .wn-v{font:italic 400 19px/1.25 var(--serif);color:var(--ink);overflow-wrap:anywhere}
.wrep{border:0;border-right:2px solid var(--pen);border-radius:0;background:transparent;padding:2px 10px 2px 0}
.wrep .wn-v{font-size:16px;color:var(--muted)}
`;
