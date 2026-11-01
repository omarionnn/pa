// The pictures on a page: putting them on, what may go where, and keeping a copy.
//
// Four rules, and code owns all four so the page is right whatever the model remembered:
//
//   0. A page that should have pictures gets them, without anybody asking. Nobody texting Reason
//      should have to say "with pictures", and a note back asking the model to go and search is a
//      nudge it is free to ignore — so code does the looking itself (`sourcePictures`). A
//      shortlist gets a real photo of every option; a comparison of named things gets a photo of
//      each of them; a page about one named thing gets one photo at the top. The model may still
//      pass its own pictures, and when it has, code leaves them alone.
//
//   1. A generated picture is an illustration, never a stand-in. In a `cards` block — a shortlist,
//      options, real things to choose between — a generated image is refused outright. In an
//      `image` block it is allowed and LABELLED: the caption gets "Illustration" in front of it,
//      written here, so a page can never show a made-up hotel lobby as the hotel lobby.
//   2. A real picture says where it is from. Every image and card photo that came off a page or an
//      image search gets a `source`: the page it sits on when that is known, otherwise the site
//      the picture itself is on. The renderer draws it as "via host". The model may pass one; code
//      fills it in when it did not, and never lets it be a page that was never seen.
//   3. A real picture is copied into Reason's own store. A page points at an address on somebody
//      else's server, and those move, die, and see every reader's visit. So the bytes are fetched
//      once (through the same guarded fetch that reads a photo somebody texted), written under
//      the image directory as m-<hash>.jpg|png, and the page points there. When the copy cannot
//      be made the page keeps the original address and says so in the note, because a picture
//      that still works beats a hole.
//
// The one thing code will not do is invent a subject. Every picture it goes looking for is a thing
// the page itself names — a card's title, a column of a comparison whose name is also in the
// page's words, the proper name in the title — so a page about an idea stays text.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import * as db from "../db.js";
import { fetchImage } from "../media.js";

const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

/**
 * What Reason tells a site when it copies a picture off it: who is asking, what it can read, and
 * the page the picture was found on. No credential and nothing about the person — but half the web
 * answers 403 to a client that will not say what it is, and a CDN that checks the referrer wants
 * the page, which here is the truth anyway.
 */
function copyHeaders(from) {
  return {
    "user-agent": "Mozilla/5.0 (compatible; Reason/1.0; +https://heyreason.com)",
    accept: "image/avif,image/webp,image/jpeg,image/png,image/gif;q=0.8,*/*;q=0.5",
    ...(from ? { referer: from } : {}),
  };
}

/**
 * Why a copy did not happen, in the page's own voice. `fetchImage`'s own sentence is written for a
 * photo somebody texted ("they sent a photo… ask what is in it"), which is the wrong voice and the
 * wrong subject for a picture code went and found.
 */
function whyNotCopied(got) {
  if (got.ok) return `Reason does not keep ${got.mediaType} pictures`;
  const why = String(got.why ?? "");
  const status = /HTTP (\d{3})/.exec(why);
  if (status) return `the site answered ${status[1]}`;
  if (/is not a picture/.test(why)) return "what downloaded is not a picture";
  if (/MB, over the/.test(why)) return "it is too big to keep";
  if (/came back empty/.test(why)) return "the download came back empty";
  if (/redirect/.test(why)) return "the link kept redirecting";
  return "the download failed";
}

/** The address pictures Reason stores are served from — the same base image_generate uses. */
export function imageBase() {
  // The files domain first (files.heyreason.com/img/* goes straight to this server, 2026-11-01).
  return `${config.pagesUrl || config.publicUrl || `http://127.0.0.1:${config.port}`}/img/`;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** How many pictures code will go and find for one page. A shortlist of twelve gifts is a page. */
const BUDGET = 8;

/**
 * Everything the page says in words, lowercased. A name read off a comparison table only counts as
 * a real thing when the page talks about it somewhere else too — that is what tells "I Sodi" from
 * "Known for". Table cells are left out on purpose: a name cannot vouch for itself.
 */
function pageWords(blocks, title, subtitle) {
  const parts = [title ?? "", subtitle ?? ""];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text ?? "");
    else if (b.type === "section") parts.push(b.title ?? "");
    else if (b.type === "callout") parts.push(b.title ?? "", b.text ?? "");
    else if (b.type === "details") parts.push(b.title ?? "", b.text ?? "");
    else if (b.type === "links") parts.push(...(b.items ?? []).map(i => `${i.label ?? ""} ${i.note ?? ""}`));
    else if (b.type === "rows") parts.push(...(b.items ?? []).map(i => `${i.name ?? ""} ${i.detail ?? ""}`));
    else if (b.type === "cards") parts.push(...(b.items ?? []).map(i => `${i.title ?? ""} ${i.note ?? ""}`));
    else if (b.type === "steps") parts.push(...(b.items ?? []));
    else if (b.type === "timeline") parts.push(...(b.items ?? []).map(i => `${i.label ?? ""} ${i.detail ?? ""}`));
    else if (b.type === "table") parts.push(b.title ?? "");
  }
  return parts.join(" \n ").toLowerCase();
}

/** A cell that reads like the name of a real thing rather than the name of a property of one. */
function namedThing(v, words) {
  const t = String(v ?? "").trim();
  if (t.length < 2 || t.length > 60) return null;
  if (!/^[A-Z0-9]/.test(t)) return null;
  if (!words.includes(t.toLowerCase())) return null;
  return t;
}

/**
 * The things a comparison table compares, when it compares named things. Both orientations happen:
 * the options across the top with their properties down the side ("What | I Sodi | Via Carota"),
 * or one row per option. Returns [] for a table of plain data, which is most of them.
 */
function tableOptions(b, words) {
  const cols = b.columns ?? [];
  const rows = b.rows ?? [];
  const across = cols.slice(1).map(c => namedThing(c, words)).filter(Boolean);
  if (cols.length >= 3 && across.length >= 2) return across;
  const down = rows.map(r => namedThing(r?.[0], words)).filter(Boolean);
  if (down.length >= 2) return [...new Set(down)];
  return [];
}

/**
 * The proper name in a page's title, which is what a page about one thing is about: "Packing for a
 * weekend in Lisbon" → "Lisbon". The first word is skipped because every title starts capitalised.
 * Null when the title names nothing — a page about an idea gets no photo at the top.
 */
function titleSubject(title) {
  const t = String(title ?? "").trim();
  if (!t) return null;
  const words = t.split(/\s+/);
  const phrases = [];
  let run = [];
  for (const [i, w] of words.entries()) {
    const bare = w.replace(/^[^\w'’]+|[^\w'’]+$/g, "");
    if (i > 0 && /^[A-Z][\w'’&-]*$/.test(bare) && bare.length > 1) run.push(bare);
    else { if (run.length) phrases.push(run.join(" ")); run = []; }
  }
  if (run.length) phrases.push(run.join(" "));
  return phrases.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * Code's own pass: find the pictures this page should have and put them on it.
 *
 * `search` is the image search (the same one behind the image_search tool) or null when there is
 * none on this machine, in which case the page is left as the model built it. Nothing here can
 * fail the page: a search that errors, times out or comes back empty leaves that picture out and
 * says so in the notes, because a page is worth more than a picture.
 */
async function sourcePictures(blocks, { search, title, subtitle, remember, notes }) {
  const has = (b) => (b.type === "image" && b.url) || (b.type === "cards" && (b.items ?? []).some(i => i.image));
  if (!search) {
    if (blocks.some(b => b.type === "cards" && (b.items ?? []).length >= 2) && !blocks.some(has)) {
      notes.push("There is no picture search on this machine, so the options on this page have no photos.");
    }
    return blocks;
  }
  const words = pageWords(blocks, title, subtitle);
  const about = [title, subtitle].filter(Boolean).join(" — ");

  // What to look for, decided before anything is fetched so the budget is spent on the page's own
  // subjects in order: the options on a shortlist, then the things a comparison compares, then —
  // only if the page would otherwise have no picture at all — one photo at the top.
  const plan = [];
  for (const [i, b] of blocks.entries()) {
    if (b.type !== "cards" || (b.items ?? []).length < 2) continue;
    for (const [j, it] of b.items.entries()) {
      if (!it.image && it.title) plan.push({ kind: "card", at: i, item: j, name: it.title });
    }
  }
  if (!plan.length && !blocks.some(has)) {
    for (const [i, b] of blocks.entries()) {
      if (b.type !== "table") continue;
      const options = tableOptions(b, words);
      if (options.length >= 2) { plan.push(...options.slice(0, BUDGET).map(name => ({ kind: "strip", at: i, name }))); break; }
    }
  }
  const working = blocks.some(b => b.type === "status" || b.type === "choice");
  if (!plan.length && !blocks.some(has) && blocks.length >= 3 && !working) {
    const subject = titleSubject(title);
    if (subject) plan.push({ kind: "hero", name: subject });
  }
  if (!plan.length) return blocks;

  const taken = new Set();
  const found = await Promise.all(plan.slice(0, BUDGET).map(async (p) => {
    let r = null;
    try {
      r = await search({
        queries: [p.name],
        objective: p.kind === "hero"
          ? `one photograph to put at the top of a page about ${about || p.name}: a real photo of ${p.name}`
          : `a real photograph of ${p.name}, shown next to the other options on a page about ${about || p.name}, so somebody can see what it looks like`,
        maxResults: 6,
      });
    } catch { r = null; }
    const results = (r?.ok ? r.results : null) ?? [];
    const usable = results.filter(x => typeof x?.image_url === "string" && !taken.has(x.image_url));
    const pick = usable.find(x => (x.width ?? 600) >= 320 && (x.height ?? 600) >= 240) ?? usable[0] ?? null;
    if (!pick) return { ...p, miss: true };
    taken.add(pick.image_url);
    // The same bookkeeping the image_search tool does: a picture and the page it sits on have both
    // now been seen on this conversation, which is what lets them go on a page (and on the next one).
    if (pick.page_url) remember([pick.page_url], { kind: "page" });
    remember([pick.image_url], { kind: "search", from: pick.page_url || "" });
    return { ...p, url: pick.image_url };
  }));

  const got = found.filter(f => f.url);
  const missed = found.filter(f => f.miss).map(f => f.name);
  const out = blocks.map(b => (b.type === "cards" ? { ...b, items: b.items.map(it => ({ ...it })) } : b));
  for (const f of got.filter(f => f.kind === "card")) out[f.at].items[f.item].image = f.url;
  const strip = got.filter(f => f.kind === "strip");
  if (strip.length) {
    // The comparison stays exactly as it was; the photos go in under it as their own row, because a
    // table cannot hold a picture and the point is to see the things being compared.
    out.splice(strip[0].at + 1, 0, {
      type: "cards", title: null,
      items: strip.map(f => ({ title: f.name, image: f.url, url: null, price: null, note: null, source: null })),
    });
  }
  const hero = got.find(f => f.kind === "hero");
  if (hero) out.unshift({ type: "image", url: hero.url, caption: null, source: null });
  if (missed.length) {
    notes.push(`No picture came back for ${missed.join(", ")}, so ${missed.length === 1 ? "that one has" : "those have"} none. Do not say the page has a picture of ${missed.length === 1 ? "it" : "them"}.`);
  }
  if (got.length) {
    notes.push(`Reason put a real photo on this page itself: ${got.map(f => f.name).join(", ")}, each saying where it came from. You did not have to search for them, and you do not need to mention how they got there.`);
  }
  return out;
}

/**
 * Walk the blocks and settle every picture. Returns { ok, blocks, notes } — or { ok: false, error }
 * for the one refusal, a generated picture inside a shortlist. `info` answers how a url was seen,
 * `fetchPicture` gets the bytes, `remember` marks the copy as seen; all injectable for the tests.
 */
export async function preparePictures(conversationId, blocks, {
  info = (u) => db.seenUrlInfo(conversationId, u),
  remember = (urls, opts) => db.rememberSeenUrls(conversationId, urls, opts),
  fetchPicture = fetchImage,
  dir = config.imagenOutputDir,
  base = imageBase(),
  mirror = true,
  search = null,
  title = "",
  subtitle = "",
} = {}) {
  const out = [];
  const notes = [];
  // Code's own pass first, so a picture it found is mirrored, sourced and checked by exactly the
  // same path as one the model passed. Nothing below can tell them apart, which is the point.
  blocks = await sourcePictures(blocks, { search, title, subtitle, remember, notes });

  const settle = async (url, { at, inCards }) => {
    const seen = info(url) ?? { kind: "", from: "" };
    const ours = url.startsWith(base);
    const generated = seen.kind === "generated" || (ours && seen.kind !== "mirror" && !/\/img\/m-/.test(url));
    if (generated) {
      if (inCards) {
        return { error: `${at} puts a generated picture on an option. A generated image may illustrate a guide; it may not stand in for a real place, product or thing somebody is choosing between. Use a real photo of that option (image_search, or one off its own page) or leave the picture out.` };
      }
      return { url, source: null, illustration: true };
    }
    const source = seen.from && seen.from !== url ? seen.from : null;
    if (ours || seen.kind === "mirror" || !mirror) return { url, source, illustration: false };

    // Keep a copy. The guarded fetch is the one that reads a texted photo: the same host check,
    // the same size ceiling, the same sniff of what the bytes really are.
    const got = await fetchPicture({ url, filename: "picture.jpg", headers: copyHeaders(source) });
    const ext = got.ok ? EXT[got.mediaType] : null;
    if (!got.ok || !ext) {
      notes.push(`${at}: the picture at ${hostOf(url)} could not be copied (${whyNotCopied(got)}), so the page points at the original, which may stop working one day.`);
      return { url, source: source ?? (`https://${hostOf(url)}/`), illustration: false };
    }
    const name = `m-${createHash("sha1").update(url).digest("hex").slice(0, 32)}${ext}`;
    const path = join(dir, name);
    try {
      mkdirSync(dir, { recursive: true });
      if (!existsSync(path)) writeFileSync(path, Buffer.from(got.base64, "base64"));
    } catch (e) {
      notes.push(`${at}: the copy of the picture could not be written (${(e?.message ?? String(e)).split("\n")[0]}), so the page points at the original.`);
      return { url, source: source ?? (`https://${hostOf(url)}/`), illustration: false };
    }
    const copy = `${base}${name}`;
    remember([copy], { kind: "mirror", from: source ?? url });
    return { url: copy, source: source ?? (`https://${hostOf(url)}/`), illustration: false };
  };

  for (const [i, b] of blocks.entries()) {
    const at = `block ${i + 1}`;
    if (b.type === "image") {
      const s = await settle(b.url, { at: `${at} (image)`, inCards: false });
      if (s.error) return { ok: false, error: s.error };
      out.push({ ...b, url: s.url, source: b.source ?? s.source, illustration: s.illustration });
      continue;
    }
    if (b.type === "cards") {
      const items = [];
      for (const [j, it] of b.items.entries()) {
        if (!it.image) { items.push({ ...it, source: it.source ?? null }); continue; }
        const s = await settle(it.image, { at: `${at} (cards) item ${j + 1}`, inCards: true });
        if (s.error) return { ok: false, error: s.error };
        items.push({ ...it, image: s.url, source: it.source ?? s.source });
      }
      out.push({ ...b, items });
      continue;
    }
    out.push(b);
  }

  return { ok: true, blocks: out, notes };
}
