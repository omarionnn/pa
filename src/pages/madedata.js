// Real rows in, view models out, for the pages in src/pages/made.js (Pages Reason makes, v2).
//
// Each designed page is drawn from what Reason really has: a shortlist from the page's own cards and
// choice, the day from its day block, a call from the calls row (its length, its recording, what it
// said it was, its transcript), a receipt from the AgentCard purchase it is about (who was paid, the
// card, when the owner said yes, the confirmation). Nothing here makes a fact up: a line Reason has
// no data for is left off, never filled with a stand-in.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.js";
import { config } from "../config.js";
import { webAllowedFor } from "../web.js";
import * as made from "./made.js";
import { pageUrl } from "./access.js";

const TZ = () => config.tz || "America/New_York";
const fmt = (ms, opts) => new Date(ms).toLocaleString("en-US", { timeZone: TZ(), ...opts });
/** "MON 4:16 PM" */
export const dayTime = (ms) => `${fmt(ms, { weekday: "short" })} ${fmt(ms, { hour: "numeric", minute: "2-digit" })}`.toUpperCase();
/** "MON · OCT 26 · 9:30 PM" */
export const dayDateTime = (ms) => `${fmt(ms, { weekday: "short" })} · ${fmt(ms, { month: "short", day: "numeric" })} · ${fmt(ms, { hour: "numeric", minute: "2-digit" })}`.toUpperCase();
const money = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;

/** Where the owner's Web lives, when Web is open to them; "" when it is not (no link to nowhere). */
export function webHref(conversationId, path = "") {
  if (!config.siteUrl || !webAllowedFor(conversationId)) return "";
  return `${config.siteUrl.replace(/\/+$/, "")}/web${path}`;
}

// ---------------------------------------------------------------- which page is this
/**
 * Which designed page this is, or null for an ordinary page (drawn by render.js as before). Null
 * whenever REASON_PAGES_V2 is off.
 */
export function madeKind(page) {
  if (!config.pagesV2 || !page?.blocks?.length) return null;
  const b = page.blocks;
  if (b.length === 1 && ["day", "call", "receipt"].includes(b[0].type)) return b[0].type;
  // A shortlist: one cards block of two or three, and the choice whose options are those cards.
  if (b.length === 2) {
    const cards = b.find(x => x.type === "cards");
    const choice = b.find(x => x.type === "choice");
    if (cards && choice && cards.items.length >= 2 && cards.items.length <= 3) {
      const names = cards.items.map(i => i.title);
      const labels = choice.options.map(o => o.label);
      if (names.length === labels.length && names.every(n => labels.includes(n))) return "shortlist";
    }
  }
  return null;
}

// ---------------------------------------------------------------- the four page kinds
function shortlistVM(page, { picked = {}, interactive = false }) {
  const cards = page.blocks.find(x => x.type === "cards");
  const choice = page.blocks.find(x => x.type === "choice");
  const items = [...cards.items];
  const at = items.findIndex(i => i.pick);
  if (at > 0) items.unshift(...items.splice(at, 1));
  const pick = items[0]?.pick ? items[0] : null;
  return {
    kicker: `MADE FOR YOU · ${dayTime(page.created_at)}`,
    title: page.title,
    meta: page.subtitle || "",
    options: items.map((it, i) => ({
      n: String(i + 1).padStart(2, "0"),
      name: it.title,
      image: it.image || "",
      facts: (it.facts?.length ? it.facts.map(f => [f.label, f.value]) : (it.price ? [["Price", it.price]] : [])),
      note: it.note || "",
      at: it.at || "",
      pick: !!it.pick,
    })),
    opinion: pick?.opinion || "",
    choice: interactive ? { action: `${page.id}/choice`, key: choice.key } : null,
    picked: picked?.[choice.key] ?? null,
  };
}

function dayVM(page) {
  const b = page.blocks[0];
  return {
    kicker: dayDateTime(page.created_at),
    title: page.title,
    note: b.note || "",
    items: b.items.map(it => ({
      at: it.at || "", title: it.title, detail: it.detail || "",
      link: it.link ? { label: it.link.label, href: it.link.url } : null,
      stamp: it.stamp ? it.stamp.toUpperCase() : "",
    })),
    tomorrow: b.tomorrow || "",
  };
}

/** The transcript as lines, "Them:" / "Reason:" as the calls code writes it. */
export function transcriptLines(text) {
  return String(text ?? "").split("\n").map(line => {
    const m = /^(Them|Reason)\s*:\s*(.+)$/.exec(line.trim());
    return m ? { who: m[1] === "Them" ? "them" : "reason", text: m[2].trim() } : null;
  }).filter(Boolean);
}

/** "1 MIN 42 SEC" */
const minSec = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0)); const m = Math.floor(n / 60); const r = n % 60;
  return [m ? `${m} MIN` : "", `${r} SEC`].filter(Boolean).join(" ");
};

/** The call's recording, when it is really on disk. */
export function callAudio(call) {
  if (!call || call.recording_state !== "stored" || !call.recording_file) return null;
  if (!existsSync(call.recording_file)) return null;
  const fmtName = String(call.recording_format || "").toLowerCase();
  const mime = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", webm: "audio/webm" }[fmtName] || "application/octet-stream";
  return { file: call.recording_file, mime, seconds: call.recording_seconds ?? call.duration_s ?? 0 };
}

function callVM(page) {
  const b = page.blocks[0];
  const call = db.getCall(page.conversation_id, b.call_id);
  if (!call) return null;
  const audio = callAudio(call);
  const told = String(call.announcement || "");
  const saidAssistant = /assistant|\bAI\b/i.test(told);
  const saidRecorded = /record/i.test(told);
  const seconds = call.duration_s ?? call.recording_seconds ?? null;
  const meta = [seconds != null ? minSec(seconds) : "", audio ? (saidRecorded ? "RECORDED, AND THEY KNEW" : "RECORDED") : ""].filter(Boolean).join(" · ");
  // The first point is always what it said it was (handoff §4 P3) — read off the opening it really
  // used, kept verbatim on the row; never claimed when the row has no record of it.
  const first = saidAssistant
    ? (saidRecorded ? "Said I was an assistant calling for you, and that the call was recorded." : "Said I was an assistant calling for you.")
    : "";
  const rest = b.points?.length ? b.points
    : String(call.summary || "").split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean).slice(0, 3);
  return {
    kicker: `CALL · ${dayTime(call.created_at)}`,
    title: page.title,
    stamp: call.outcome_kind === "confirmed" ? "BOOKED" : "",
    meta,
    audio: audio ? { href: `${page.id}/audio`, seconds: audio.seconds } : null,
    points: [first, ...rest].filter(Boolean).slice(0, 4),
    worth: b.worth_knowing || "",
    transcript: transcriptLines(call.transcript),
  };
}

function receiptVM(page) {
  const b = page.blocks[0];
  const row = db.agentcardPurchaseById(page.conversation_id, b.purchase_id);
  // Only ever a purchase that went through: one refunded or cancelled since draws as an ordinary page.
  if (!row || row.status !== "placed") return null;
  const card = db.getAgentcardUser(page.conversation_id);
  const conf = row.confirmation_id ? db.getConfirmation(page.conversation_id, row.confirmation_id) : null;
  return {
    kicker: `RECEIPT · ${dayTime(row.updated_at)}`,
    title: page.title,
    rows: [
      ["To", row.merchant],
      ["For", row.what],
      ["Card", card?.card_last4 ? `•••• ${card.card_last4}` : ""],
      ["Approved", conf?.granted_at ? dayTime(conf.granted_at) : ""],
      ["Confirmation", row.retailer_order_id || row.order_id],
    ],
    total: money(row.amount_cents),
    stamp: row.status === "placed" ? "PAID" : "",
    note: b.note || "",
    pdf: true,
    chatHref: webHref(page.conversation_id),
  };
}

/**
 * The owner's designed page, or null when it is not one (or its row is gone: a call or purchase that
 * no longer exists draws as the ordinary page rather than as a page of blanks).
 */
export function renderMadePage(page, { picked = {}, interactive = false, head = "" } = {}) {
  const kind = madeKind(page);
  if (!kind) return null;
  const vm = kind === "shortlist" ? shortlistVM(page, { picked, interactive })
    : kind === "day" ? dayVM(page)
      : kind === "call" ? callVM(page)
        : receiptVM(page);
  if (!vm) return null;
  vm.head = head;
  vm.url = pageUrl(page.id);
  return kind === "shortlist" ? made.renderShortlist(vm)
    : kind === "day" ? made.renderDay(vm)
      : kind === "call" ? made.renderCall(vm)
        : made.renderReceipt(vm);
}

// ---------------------------------------------------------------- E3 / E4
/** "••• ••• 0142", as the Web sign-in shows a number (src/pages/websignin.js maskedNumber). */
export function maskedNumber(number) {
  const d = String(number ?? "").replace(/\D/g, "");
  return d.length >= 4 ? `••• ••• ${d.slice(-4)}` : "your number";
}

/**
 * E3 for a browser signed in as somebody else. Drawn from the SESSION's own person only — it names
 * the browser's number, masked, never the page's owner or anything on the page.
 */
export function notYoursFor(sessionConversationId, pageId) {
  const acct = db.getAccount(sessionConversationId);
  const address = acct?.address ?? "";
  return made.renderNotYours({
    masked: maskedNumber(address),
    threadHref: webHref(sessionConversationId),
    signInHref: `${pageId}/signout`,
  });
}

export function archivedFor(page) {
  return made.renderArchived({ pageTitle: page.title, savedHref: webHref(page.conversation_id, "/saved") });
}

// ---------------------------------------------------------------- LP2: the private card
/** og tags for every private page: one generic title and one generic picture (LP2). */
export function privateHead(imageUrl) {
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Reason">`,
    `<meta property="og:title" content="${made.esc(made.PRIVATE_OG_TITLE)}">`,
    `<meta property="og:description" content="${made.esc(made.PRIVATE_OG_DESCRIPTION)}">`,
    `<meta property="og:image" content="${made.esc(imageUrl)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${made.esc(made.PRIVATE_OG_TITLE)}">`,
    `<meta name="twitter:image" content="${made.esc(imageUrl)}">`,
  ].join("\n");
}

/** Bump when the private card's drawing changes; it is part of the file name and the address. */
export const PRIVATE_OG_VERSION = 1;

/** The private card's PNG, drawn once and kept. `shoot(html)` is card.js's headless browser. */
// One drawing at a time, and after a failed one a minute's rest: the card is fetched without
// sign-in, so a burst of previews (or a broken Chromium) must never launch a browser per request.
let ogDrawing = null;
let ogFailedAt = 0;
const OG_RETRY_MS = 60_000;
export async function privateOgPng({ shoot }) {
  const dir = join(config.dataDir, "cards");
  const file = join(dir, `private-og-v${PRIVATE_OG_VERSION}.png`);
  if (existsSync(file)) return readFileSync(file);
  if (ogDrawing) return ogDrawing;
  if (Date.now() - ogFailedAt < OG_RETRY_MS) return null;
  ogDrawing = (async () => {
    try {
      const png = await shoot(made.privateOgHtml({ fontCss: made.ogFontCss() }));
      if (!png?.length) { ogFailedAt = Date.now(); return null; }
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, png);
      return png;
    } catch (e) { ogFailedAt = Date.now(); throw e; }
    finally { ogDrawing = null; }
  })();
  return ogDrawing;
}
