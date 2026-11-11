// Table images: a set of options compared on the same facts, drawn as ONE picture (owner, 2026-11-10).
//
// "Pick the shape the ask earns." A fact, a yes/no, one pick or an explanation is plain text. A set the
// person compares on the same facts — three pizza places, four flights, apps, apartments — is a table,
// and a table typed into a text arrives as its own punctuation (the prompt forbids it). So the model
// calls render_table and the table is drawn here, server-side, and sent as a picture after its line.
//
// The flow:
//   1. the model calls render_table with title, columns (3–5), rows (one per option) and a one-sentence
//      comment (the pick and why). Code checks it: no blank cells (a column a row cannot fill is dropped
//      rather than drawn with an "N/A"), the first column names each row, cells are a few words.
//   2. the table is laid out in HTML and shot by the same Chromium path every drawn card uses
//      (src/pages/card.js shootWithChromium), 1080 px wide at 2× device scale, as tall as its content.
//      Longer than TABLE_ROWS_PER_IMAGE rows and it is split: each picture repeats the title, the
//      header row and the logo; the comment sits on the last one.
//   3. each PNG goes into the Web uploads store (src/webuploads.js: 128-bit random id, pruned after
//      KEEP_MS = 30 days) and is served from its upload address with no sign-in — the id is the secret
//      (src/webmedia.js). Sendblue fetches it from there (media_url) in one message per picture, in
//      order, after the reply's line (sendQueued, from the runtime, the way choice cards go).
//   4. the rows are kept as a choice set (db.choice_sets, kind "table") so "2", "the second one" or a
//      name in their next message resolves against the rows they saw (src/choicecards.js
//      inboundChoiceLine reads them back; pickFromTable names the row when the words are unambiguous).
//
// Anything that fails — the render, the store, a channel that cannot carry a picture — becomes the same
// data as short plain text, one option per line. Never a broken image.
//
// Behind REASON_TABLE_IMAGES (off | owner | on), off by default.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { clock } from "./config.js";
import { Channel } from "./channels/channel.js";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import * as uploads from "./webuploads.js";
import { esc } from "./pages/render.js";
import { wordmark, WORDMARK_CSS } from "./pages/wordmark.js";
import { RENDER_TIMEOUT_MS, shootWithChromium } from "./pages/card.js";

export const TABLE_TOOLS = new Set(["render_table"]);
/** How long the rows are still the thing their next message may be answering (as choice cards). */
export const TABLE_TTL_MS = 12 * 3_600_000;

/** Bump when the drawing changes. */
export const TABLE_IMAGE_VERSION = 1;
/** The picture's layout width in CSS px; drawn at TABLE_SCALE so the file is 2160 px wide. */
export const TABLE_W = 1080;
export const TABLE_SCALE = 2;
/** More rows than this and the table is split across pictures, each with the title and header again. */
export const TABLE_ROWS_PER_IMAGE = 8;
/** A picture above this is drawn again smaller: a phone fetches it over the air. */
export const MAX_IMAGE_BYTES = 1024 * 1024;
/** What a render should take, logged against (owner: "target < 1.5 s"). */
export const RENDER_TARGET_MS = 1500;
/** Between one picture and the next, so the provider's queue cannot hand them over out of order. */
const GAP_MS = Number(process.env.REASON_TABLE_GAP_MS ?? 900);
/** Body text never below this; smaller than this the cell is cut with an ellipsis instead. */
export const CELL_FONT_PX = 32;
export const CELL_FONT_MIN_PX = 26;
/** A cell this short (a time, a price, "Nonstop") is kept on one line rather than wrapped. */
export const SHORT_CELL = 9;

export function tableImagesOn(conversationId) {
  const v = String(process.env.REASON_TABLE_IMAGES ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  return v === "owner" && accounts.featureOwner(conversationId);
}
export function tableToolVisible(name, conversationId) {
  if (!TABLE_TOOLS.has(name)) return true;
  return tableImagesOn(conversationId);
}

// ---------- the rules the model reads ----------

/** The "pick the shape the ask earns" rules, in the system prompt while the switch is on for this person. */
export const TABLE_RULES = `
- Pick the shape the ask earns. A fact, a yes or no, one pick, an explanation: plain text, one or two short messages, never a list. A set they will compare on the same facts — three or more restaurants, flights, apps, apartments, products — is a TABLE, drawn as a picture by render_table. One option, or two mentioned in a sentence: text, never a table. Something long they will read later (a plan, an itinerary, a checklist): short messages or a page.
- When it is a table, never write it in the message. Call render_table with: title (a few words: "Pizza Near You"); columns (3 to 5 headers, the first names each row, each column ONE fact on the same basis for every row — every price with the same fees in it — and one of them the fact they rank by); rows (one per option, each cell a few words, never a sentence, never blank and never "N/A" — a column a row cannot fill is left out); comment (one sentence: the pick and why). Three rows by default; more only when they asked for more or to see everything.
- One short text before the picture only if it says something the table cannot (the price range, a condition). Never describe the picture and never say "here's a table".
- They pick by position ("2", "the second one", "the last one") or by name, counting from the top row of the first picture. The rows are kept, so read a reply like that against them.`;
export const tableRules = (me) => (tableImagesOn(typeof me === "object" ? me?.conversationId : "") ? TABLE_RULES : "");

// ---------- the tool ----------

export const TABLE_TOOL_DEFS = [
  {
    name: "render_table",
    description: "Draw a comparison table as a picture and send it after your reply — for a set of 3 or more options they compare on the same facts (restaurants, flights, apps, apartments, products)."
      + " Never for a fact, a yes/no, one pick or two options named in a sentence: those are text. Never type a table into a text."
      + " title: a few words (\"Pizza Near You\"). columns: 3–5 short headers; the first names each row; each column is ONE fact on the same basis for every row (every price with the same fees), and one of them is what they rank by."
      + " rows: one per option, in the order to show them, each cell a few words — never a sentence, never blank, never \"N/A\" (a column a row cannot fill is dropped from the whole table, so leave it out yourself)."
      + " comment: one sentence, the pick and why. Three rows unless they asked for more; past 8 rows it is split across pictures."
      + " After it returns ok, your reply is at most one short line that says something the table cannot (a range, a condition) — or nothing. Never describe the picture or say \"here's a table\"."
      + " If it returns fallback: \"text\", write the options as short lines instead, one per option, in the same order."
      + " They answer with a position (\"2\", \"the second one\", \"the last one\") or a name; the rows are kept so you can read that back.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A few words. \"Pizza Near You\", \"Flights to Boston Friday\"." },
        columns: { type: "array", minItems: 2, maxItems: 5, items: { type: "string" }, description: "3–5 headers. The first names each row (\"Place\", \"Flight\"). Each column one fact on the same basis for every row." },
        rows: { type: "array", minItems: 2, maxItems: 40, items: { type: "array", items: { type: "string" } }, description: "One array per option, a cell per column, a few words each. No blanks, no \"N/A\"." },
        comment: { type: "string", description: "One sentence: the pick and why. \"Joe's for the slice; Lucali if they'll wait.\"" },
        theme: { type: "string", enum: ["light", "dark"], description: "Optional. Leave out: it follows their Web theme, light when unknown." },
      },
      required: ["title", "columns", "rows", "comment"],
    },
  },
];

export const TABLE_SCHEMAS = {
  render_table: z.object({
    title: z.string().max(80),
    columns: z.array(z.string().max(40)).min(2).max(5),
    rows: z.array(z.array(z.string().max(120)).max(5)).min(2).max(40),
    comment: z.string().max(240),
    theme: z.enum(["light", "dark"]).optional(),
  }),
};

// ---------- checking the input ----------

const BLANK = /^\s*(?:|-|–|—|n\/?a|none|null|tbd|\?|unknown)\s*$/i;
/** A cell that says nothing: empty, a dash, "N/A", "tbd". */
export const isBlank = (s) => BLANK.test(String(s ?? ""));

const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * The table as it will be drawn, or why it cannot be. Columns a row cannot fill are dropped (and named
 * in `dropped`, so the model's note can say so); the first column must name every row. Returns
 * { ok: true, table: { title, columns, rows, comment }, dropped } or { ok: false, error }.
 */
export function validateTable(input) {
  const title = tidy(input?.title);
  const comment = tidy(input?.comment);
  let columns = (input?.columns ?? []).map(tidy);
  let rows = (input?.rows ?? []).map(r => (Array.isArray(r) ? r : []).map(tidy));
  if (!title) return { ok: false, error: "A table needs a title of a few words." };
  if (columns.length < 2) return { ok: false, error: "A table needs at least 2 columns: the first names each row, the rest are the facts they compare." };
  if (columns.some(c => !c)) return { ok: false, error: "Every column needs a header." };
  if (rows.length < 2) return { ok: false, error: "A table is for 2 or more options. With one, just answer in words." };
  if (rows.some(r => r.length !== columns.length)) {
    return { ok: false, error: `Every row needs exactly one cell per column (${columns.length} here: ${columns.join(", ")}). A fact a row does not have: leave the whole column out.` };
  }
  if (rows.some(r => isBlank(r[0]))) return { ok: false, error: "The first cell of every row has to name the option." };
  const names = rows.map(r => r[0].toLowerCase());
  if (new Set(names).size !== names.length) return { ok: false, error: "Two rows have the same name; make each one tell them apart." };

  // A column any row cannot fill goes, whole: an "N/A" in a comparison is a row that cannot be compared.
  const dropped = [];
  const keep = columns.map((_, i) => i === 0 || !rows.some(r => isBlank(r[i])));
  columns = columns.filter((_, i) => { if (!keep[i]) dropped.push(columns[i]); return keep[i]; });
  rows = rows.map(r => r.filter((_, i) => keep[i]));
  if (columns.length < 2) return { ok: false, error: `Nothing is left to compare: every fact column had a blank (${dropped.join(", ")}). Fill them, or leave those columns out and give the facts every row has.` };
  return { ok: true, table: { title, columns, rows, comment }, dropped };
}

/** Rows in pictures of at most `per` each; the title and header are drawn on every one. */
export function splitRows(rows, per = TABLE_ROWS_PER_IMAGE) {
  const out = [];
  for (let i = 0; i < rows.length; i += per) out.push(rows.slice(i, i + per));
  return out;
}

/** "$12", "€1,200/mo", "from $89", "4.6", "12 min", "2.3 mi" — a figure, so the column sits right-aligned. */
export const priceLike = (s) => /^(?:from |about |~|≈)?[-+]?(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:[$€£¥]|%|k|m|min|mins|hr|hrs|h|mi|km|ft|m|lb|oz|★|⭐|stars?|\/mo|\/yr|\/night|\/hr|\/mo\.)?)(?:\s?(?:\/|per\s)\s?(?:mo|month|yr|year|night|hr|hour|person|day|week|wk))?$/i.test(String(s ?? "").trim());

/** Which columns are figures: every cell in the column price-like (never the first, the names). */
export function alignedRight(columns, rows) {
  return columns.map((_, i) => i > 0 && rows.length > 0 && rows.every(r => priceLike(r[i])));
}

// ---------- the drawing ----------

const font = (f) => `data:font/woff2;base64,${readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64")}`;
let FONTS = null;
const fonts = () => (FONTS ??= { serif: font("instrument-serif-italic-latin.woff2"), sans: font("inter-web.woff2") });

/** White paper with near-black ink, or #111 with near-white; the muted tone passes AA on each. */
export const PALETTE = {
  light: { bg: "#ffffff", ink: "#1a1714", muted: "#625c56", hair: "#e4dfd8", zebra: "#faf8f5" },
  dark: { bg: "#111111", ink: "#f3efe8", muted: "#a8a19a", hair: "#2a2a2a", zebra: "#171717" },
};

/** Light unless they chose Night on Web ("auto" follows a phone we cannot see, so light). */
export function themeFor(conversationId) {
  try { return db.webTheme(conversationId) === "night" ? "dark" : "light"; } catch { return "light"; }
}

// Runs in the page before the shot: a cell wraps at word boundaries up to 2 lines; a column with a cell
// past that shrinks a step at a time down to CELL_FONT_MIN_PX; still too long and the cell is cut with
// an ellipsis. Sets window.__fitted when done, which the shot waits for.
const FIT_SCRIPT = `
(function(){
  function fit(){
    var cols = document.querySelectorAll('col').length;
    var table = document.querySelector('table');
    var all = Array.prototype.slice.call(document.querySelectorAll('td .c'));
    // Short cells (a time, a price, "Nonstop") stay on one line; if that makes the table wider than the
    // page, every cell shrinks a step at a time, and past the floor the short cells may wrap too.
    var size = ${CELL_FONT_PX};
    var wide = function(){ return table.scrollWidth > table.clientWidth + 1 || table.getBoundingClientRect().width > document.body.clientWidth - 112 + 1; };
    while (wide() && size > ${CELL_FONT_MIN_PX}) { size -= 1; all.forEach(function(el){ el.style.fontSize = size + 'px'; }); }
    if (wide()) all.forEach(function(el){ el.classList.remove('s'); });
    for (var c = 1; c < cols; c++) {
      var cells = Array.prototype.slice.call(document.querySelectorAll('td[data-c="' + c + '"] .c'));
      var over = function(){ return cells.some(function(el){ var lh = parseFloat(getComputedStyle(el).lineHeight); return el.scrollHeight > lh * 2 + 2 || el.scrollWidth > el.clientWidth + 1; }); };
      var colSize = size;
      while (over() && colSize > ${CELL_FONT_MIN_PX}) { colSize -= 1; cells.forEach(function(el){ el.style.fontSize = colSize + 'px'; }); }
      if (over()) cells.forEach(function(el){ el.classList.add('cut'); });
    }
    window.__fitted = true;
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit, fit); else fit();
})();`;

/**
 * One picture's HTML: title, the table (header row in small caps, first column bold, figures right-
 * aligned, thin dividers), the comment in italics, and a footer that holds the logo bottom-right with
 * its own room. `part` is { i, n } when the table is split.
 */
export function tableHtml({ title, columns, rows, comment = "", theme = "light", part = null }) {
  const p = PALETTE[theme === "dark" ? "dark" : "light"];
  const f = fonts();
  const right = alignedRight(columns, rows);
  const head = columns.map((c, i) => `<th class="${right[i] ? "r" : ""}">${esc(c)}</th>`).join("");
  const body = rows.map(r => `<tr>${r.map((cell, i) => `<td data-c="${i}" class="${i === 0 ? "n" : ""}${right[i] ? " r" : ""}"><div class="c${i > 0 && cell.length <= SHORT_CELL ? " s" : ""}">${esc(cell)}</div></td>`).join("")}</tr>`).join("");
  const cols = columns.map(() => "<col>").join("");
  const partLine = part && part.n > 1 ? `<p class="part">${part.i} of ${part.n}</p>` : "";
  return `<!doctype html><html data-theme="${theme === "dark" ? "dark" : "light"}"><head><meta charset="utf-8"><style>
@font-face{font-family:"Table Serif";font-style:italic;font-weight:400;src:url(${f.serif}) format("woff2")}
@font-face{font-family:"Table Sans";font-weight:100 900;src:url(${f.sans}) format("woff2")}
${WORDMARK_CSS}
*{margin:0;box-sizing:border-box}
html,body{width:${TABLE_W}px;background:${p.bg}}
body{color:${p.ink};padding:56px 56px 0;-webkit-font-smoothing:antialiased;font-family:"Table Sans",Inter,system-ui,sans-serif}
h1{font:italic 400 48px/1.1 "Table Serif",Georgia,serif;letter-spacing:-.015em;margin-bottom:36px;overflow-wrap:normal;word-break:normal}
table{width:100%;border-collapse:collapse;table-layout:auto}
th{font:600 26px/1.2 "Table Sans",sans-serif;font-variant-caps:all-small-caps;letter-spacing:.08em;color:${p.muted};text-align:left;padding:0 20px 16px 0;border-bottom:2px solid ${p.hair};white-space:nowrap}
th:last-child,td:last-child{padding-right:0}
td{padding:22px 20px 22px 0;border-bottom:1.5px solid ${p.hair};vertical-align:top;font-size:${CELL_FONT_PX}px;line-height:1.3}
tr:nth-child(even) td{background:${p.zebra}}
td.n .c{font-weight:700}
th.r,td.r{text-align:right}
td.r .c{font-variant-numeric:tabular-nums}
.c{overflow-wrap:normal;word-break:normal;hyphens:none;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.c.cut{text-overflow:ellipsis}
.c.s{white-space:nowrap}
.cm{margin-top:36px;font:italic 400 30px/1.3 "Table Serif",Georgia,serif;color:${p.muted}}
.ft{position:relative;height:${48 + 32 + 32}px}
.ft .wm{position:absolute;right:-24px;bottom:32px;height:48px;display:flex;align-items:center}
.ft .wm .wordmark{font-size:50px;line-height:1;color:${p.ink}}
.ft .wm .wm-bubble path{stroke:${theme === "dark" ? "#d46a5c" : "#9c3b2e"}}
.part{position:absolute;left:0;bottom:36px;font:500 24px/1 "Table Sans",sans-serif;color:${p.muted};letter-spacing:.04em}
</style></head><body>
<h1>${esc(title)}</h1>
<table><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
${comment ? `<p class="cm">${esc(comment)}</p>` : ""}
<div class="ft">${partLine}<div class="wm">${wordmark()}</div></div>
<script>${FIT_SCRIPT}</script>
</body></html>`;
}

// ---------- contrast (WCAG) ----------

const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const n = parseInt(hex.replace("#", ""), 16); return 0.2126 * chan(n >> 16 & 255) + 0.7152 * chan(n >> 8 & 255) + 0.0722 * chan(n & 255); };
/** WCAG 2 contrast ratio of two hex colours, 1–21. */
export function contrastRatio(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
/** Body ink ≥ 4.5 on the ground, the muted header and comment ≥ 4.5 too (the header is small). */
export function contrastOk(theme) {
  const p = PALETTE[theme === "dark" ? "dark" : "light"];
  return contrastRatio(p.ink, p.bg) >= 4.5 && contrastRatio(p.muted, p.bg) >= 4.5 && contrastRatio(p.ink, p.zebra) >= 4.5 && contrastRatio(p.muted, p.zebra) >= 4.5;
}

// ---------- rendering ----------

function withDeadline(promise, ms, what) {
  let t;
  const clock_ = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took too long`)), ms); });
  return Promise.race([promise, clock_]).finally(() => clearTimeout(t));
}

/**
 * Every picture of one table: [{ png, mime, bytes, ms, rows }]. A picture over MAX_IMAGE_BYTES is drawn
 * again at 1× and then, if still over, as a JPEG. `shoot` is injectable (tests never open a browser).
 */
export async function renderTable(table, { theme = "light", shoot = shootWithChromium, log = () => {} } = {}) {
  if (!contrastOk(theme)) throw new Error(`the ${theme} palette does not pass AA contrast`);
  const parts = splitRows(table.rows);
  const out = [];
  for (const [i, rows] of parts.entries()) {
    const last = i === parts.length - 1;
    const html = tableHtml({ ...table, rows, comment: last ? table.comment : "", theme, part: { i: i + 1, n: parts.length } });
    const t0 = clock.now();
    const opts = { width: TABLE_W, fullPage: true, ready: "window.__fitted === true" };
    let png = await withDeadline(shoot(html, { ...opts, scale: TABLE_SCALE, type: "png" }), RENDER_TIMEOUT_MS, "drawing the table");
    let mime = "image/png";
    if (!png?.length) throw new Error("the renderer gave back an empty picture");
    if (png.length > MAX_IMAGE_BYTES) {
      png = await withDeadline(shoot(html, { ...opts, scale: 1, type: "png" }), RENDER_TIMEOUT_MS, "drawing the table");
      if (png.length > MAX_IMAGE_BYTES) { png = await withDeadline(shoot(html, { ...opts, scale: 1, type: "jpeg" }), RENDER_TIMEOUT_MS, "drawing the table"); mime = "image/jpeg"; }
    }
    const ms = clock.now() - t0;
    log({ table_rendered: table.title, part: i + 1, of: parts.length, rows: rows.length, bytes: png.length, ms, slow: ms > RENDER_TARGET_MS });
    out.push({ png, mime, bytes: png.length, ms, rows: rows.length });
  }
  return out;
}

/** The same table as text: one option per line, its facts after it. What goes when no picture can. */
export function textFallback(table) {
  const { columns, rows, comment } = table;
  const lines = rows.map(r => `${r[0]} — ${r.slice(1).map((c, i) => `${columns[i + 1]} ${c}`).join(", ")}`);
  return [table.title, ...lines, comment].filter(Boolean).join("\n");
}

// ---------- the tool, run ----------

/** A set this turn drew and has not sent yet, per conversation (sent after the reply's words). */
const queued = new Map();
export function takeQueued(conversationId) {
  const q = queued.get(conversationId) ?? null;
  queued.delete(conversationId);
  return q;
}

const rowOption = (columns) => (r, i) => {
  const priceAt = columns.findIndex((_, k) => k > 0 && priceLike(r[k]));
  return { n: i + 1, name: r[0], price: priceAt > 0 ? r[priceAt] : "", detail: r.slice(1).filter((_, k) => k + 1 !== priceAt).join(" · "), cells: r };
};

export async function runTableTool(name, input, ctx) {
  const c = ctx.conversationId;
  if (name !== "render_table" || !tableImagesOn(c)) return { ok: false, error: "Table pictures are not available here. Write the options as short lines, one per option." };
  if (ctx.historyId && ctx.historyId !== c) return { ok: false, error: "This is a Web-only chat. Write the options as short lines, one per option." };
  const log = ctx.log ?? (() => {});
  const v = validateTable(input);
  if (!v.ok) return { ok: false, error: v.error };
  const { table, dropped } = v;
  const theme = input.theme === "dark" || input.theme === "light" ? input.theme : themeFor(c);
  const droppedNote = dropped.length ? ` Left out, because a row had no value for it: ${dropped.join(", ")}.` : "";

  let pictures = null;
  let why = null;
  try {
    const drawn = await renderTable(table, { theme, shoot: ctx.shoot ?? shootWithChromium, log });
    pictures = drawn.map((d, i) => {
      const ext = d.mime === "image/jpeg" ? "jpg" : "png";
      const m = (ctx.store ?? uploads.store)({ conversationId: c, bytes: d.png, name: `reason-table-${i + 1}.${ext}`, extra: { public: "table", table: true } });
      if (!m || m.error) throw new Error(`keeping the picture failed (${m?.error ?? "no record"})`);
      return { id: m.id, url: uploads.uploadUrl(m.id, m.name), file: uploads.filePath(m), mime: d.mime, filename: m.name, bytes: d.bytes, ms: d.ms };
    });
  } catch (e) {
    pictures = null;
    why = (e?.message ?? String(e)).split("\n")[0];
  }

  const set = db.openChoiceSet({
    conversationId: c, kind: "table",
    options: table.rows.map(rowOption(table.columns)),
    state: pictures ? "queued" : "text", expiresAt: clock.now() + TABLE_TTL_MS,
  });
  if (!pictures) {
    log({ table_text: c, set: set.id, why });
    return {
      ok: true, fallback: "text", set_id: set.id,
      note: `No picture this time (${why}). Write the options as short lines in your reply, one per option, in this order — the order is kept, so "the second one" picks row 2:\n${textFallback(table)}${droppedNote}`,
    };
  }
  queued.set(c, { setId: set.id, pictures, text: textFallback(table) });
  log({ table_drawn: c, set: set.id, pictures: pictures.length, rows: table.rows.length, theme, ms: pictures.reduce((a, p) => a + p.ms, 0) });
  const split = pictures.length > 1 ? ` It is ${pictures.length} pictures (${TABLE_ROWS_PER_IMAGE} rows each), sent together in order.` : "";
  return {
    ok: true, set_id: set.id, pictures: pictures.length, rows: table.rows.length, theme,
    note: `The table is drawn and goes out right after your reply.${split} Your reply is at most one short line that says something the table cannot — or nothing at all. Do not list the rows, do not describe the picture, do not say "here's a table".${droppedNote}`,
  };
}

/**
 * After the reply line went out: each picture, in order, by address when the channel fetches files
 * by address (Sendblue media_url), by file otherwise. A turn whose words did not go sends nothing
 * and the set is dropped. A picture that fails to send → the whole table as plain text instead,
 * never a broken image. Never throws.
 */
export async function sendQueued(conversationId, { router, route, withWords, log = () => {}, sleep = (ms) => new Promise(r => setTimeout(r, ms)) }) {
  const q = takeQueued(conversationId);
  if (!q) return null;
  if (!withWords || !router || !route?.channel || route.channel === "console") {
    db.setChoiceState(q.setId, "dropped");
    log({ table_dropped: conversationId, set: q.setId, why: withWords ? "no channel to send pictures on" : "the turn sent no words" });
    return { sent: 0 };
  }
  // By address only on a channel that really fetches one (Sendblue). The base Channel class carries a
  // stub `sendMediaUrl` that refuses, and Web and Linq inherit it: hand those the file instead.
  const ch = router.get?.(route.channel);
  const byUrl = typeof ch?.sendMediaUrl === "function" && ch.sendMediaUrl !== Channel.prototype.sendMediaUrl;
  const handles = [];
  let sent = 0;
  let failed = null;
  for (const [i, p] of q.pictures.entries()) {
    if (i) await sleep(GAP_MS);
    let r;
    try {
      r = await router.sendMedia({
        channel: route.channel, to: route.to, chatId: route.chatId ?? null, text: "",
        ...(byUrl ? { mediaUrl: p.url, table: true } : { file: p.file }), mimeType: p.mime, filename: p.filename,
        conversationId, toOwner: true, idempotencyKey: `table:${q.setId}:${i + 1}`,
      });
    } catch (e) {
      r = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
    }
    if (!r?.ok) { failed = r?.error ?? "unknown"; break; }
    handles[i] = r.delivered?.message_id ?? null;
    sent++;
  }
  if (failed !== null) {
    log({ table_picture_failed: conversationId, set: q.setId, n: sent + 1, why: failed });
    // The same rows as words, so they are never left looking at a picture that did not arrive.
    let t;
    try {
      t = await router.send({ channel: route.channel, to: route.to, chatId: route.chatId ?? null, text: q.text, conversationId, toOwner: true, idempotencyKey: `table:${q.setId}:text` });
    } catch (e) { t = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
    db.setChoiceShown(q.setId, { handles, state: t?.ok ? "text" : sent ? "partial" : "dropped" });
    log({ table_text_sent: conversationId, set: q.setId, ok: !!t?.ok });
    return { sent, text: !!t?.ok };
  }
  db.setChoiceShown(q.setId, { handles, state: "shown" });
  log({ table_sent: conversationId, set: q.setId, sent, of: q.pictures.length });
  return { sent };
}

// ---------- reading what came back ----------

const ORDINALS = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, sixth: 6, "6th": 6, seventh: 7, "7th": 7, eighth: 8, "8th": 8, ninth: 9, "9th": 9, tenth: 10, "10th": 10 };
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/**
 * Which row their words pick, counting from the top of the first picture: "2", "#2", "the second one",
 * "the last one", "number three", or a row's name (or a word of it that only one row has). The row's
 * index (0-based) or null when the words do not clearly pick one.
 */
export function pickFromTable(names, text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t || !names?.length) return null;
  const n = names.length;
  const at = (k) => (k >= 1 && k <= n ? k - 1 : null);
  let m;
  if ((m = /^(?:#|no\.?\s*|number\s+|option\s+|row\s+)?(\d{1,2})\s*[.)!]?$/.exec(t))) return at(Number(m[1]));
  if ((m = /^(?:the\s+)?(?:#|no\.?\s*|number\s+|option\s+|row\s+)(\d{1,2})\b/.exec(t))) return at(Number(m[1]));
  // An ordinal only as the whole message (plus a tail word and a mark): "First, is the 2nd one open late?"
  // is a question with an ordinal in it, not a pick (review 2026-11-10).
  if ((m = /^(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th))(?:\s+(?:one|row|option|pick))?\s*(?:,?\s*please)?\s*[.!]?$/.exec(t))) return at(ORDINALS[m[1]] ?? parseInt(m[1], 10));
  if (/^(?:the\s+)?last(?:\s+(?:one|row|option))?\s*[.!]?$/.test(t)) return n - 1;
  if (/^(?:the\s+)?(?:top|first)(?:\s+(?:one|row|option))?\s*[.!]?$/.test(t)) return 0;
  // A number as a word only when it is the whole message ("three", "the two"): "the one with the best
  // rating" and "two of us at 8" are sentences, not picks.
  if ((m = /^(?:the\s+)?(one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+(?:one|row|option))?\s*[.!]?$/.exec(t))) return at(WORDS[m[1]]);
  // By name: the whole name in their words, or a distinctive word of the name only one row has.
  const low = names.map(x => String(x).toLowerCase());
  // Whole name on word edges: "Ace" is not inside "place".
  const edge = (x) => new RegExp(`(?:^|[^a-z0-9])${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`);
  const whole = low.map((x, i) => (edge(x).test(t) ? i : -1)).filter(i => i >= 0);
  if (whole.length === 1) return whole[0];
  if (whole.length > 1) return null;
  const words = new Set(t.split(/[^a-z0-9'&]+/).filter(w => w.length >= 4));
  const hits = low.map((x, i) => (x.split(/[^a-z0-9'&]+/).some(w => w.length >= 4 && words.has(w) && low.filter(y => y.split(/[^a-z0-9'&]+/).includes(w)).length === 1) ? i : -1)).filter(i => i >= 0);
  return hits.length === 1 ? hits[0] : null;
}

/** The read-along line for a table set (src/choicecards.js inboundChoiceLine hands kind "table" here). */
export function tableInboundLine(set, { text = "", replyTo = null, now = clock.now() } = {}) {
  const ago = (ms) => { const m = Math.round(ms / 60_000); return m < 60 ? `${Math.max(1, m)} min` : `${Math.round(m / 60)} h`; };
  const list = set.options.map(o => `${o.n} = ${[o.name, o.price, o.detail].filter(Boolean).join(", ")}`).join("; ");
  const shown = set.state === "text" ? "as short lines" : `as a table picture (rows numbered from the top${set.handles.filter(Boolean).length > 1 ? " of the first picture" : ""})`;
  let line = `[${ago(now - (set.shown_at ?? set.created_at))} ago you showed them ${set.options.length} options ${shown}: ${list}.`;
  const onPicture = replyTo ? set.handles.some(h => h && String(h).split("_")[0] === String(replyTo).split("_")[0]) : false;
  if (onPicture) line += " This is an inline reply on the table picture — read it as about one of its rows.";
  const pick = pickFromTable(set.options.map(o => o.name), text);
  if (pick != null) line += ` Their words read as row ${pick + 1} (${set.options[pick].name}); go ahead with that one unless the rest of the message says otherwise.`;
  else line += " If this message picks one — by position or by name — go ahead with that one. If it is about something else, leave the options be.";
  return `${line}]`;
}
