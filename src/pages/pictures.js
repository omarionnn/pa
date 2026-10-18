// The pictures on a page: what may go where, and keeping a copy.
//
// Three rules, and code owns all three so the page is right whatever the model remembered:
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
// What this file does NOT decide is whether a page should have a picture at all. That is the
// model's call with the prompt's guidance; the one nudge here is a note back when a shortlist of
// several options has no pictures, because that is the page where a real photo earns its place.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import * as db from "../db.js";
import { fetchImage } from "../media.js";

const EXT = { "image/jpeg": ".jpg", "image/png": ".png" };

/** The address pictures Reason stores are served from — the same base image_generate uses. */
export function imageBase() {
  return `${config.publicUrl || `http://127.0.0.1:${config.port}`}/img/`;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
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
} = {}) {
  const out = [];
  const notes = [];
  let plainShortlist = false;

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
    const got = await fetchPicture({ url, filename: "picture.jpg" });
    const ext = got.ok ? EXT[got.mediaType] : null;
    if (!got.ok || !ext) {
      notes.push(`${at}: the picture at ${hostOf(url)} could not be copied (${got.ok ? `it is ${got.mediaType}` : got.why}), so the page points at the original, which may stop working one day.`);
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
      if (b.items.length >= 2 && !b.items.some(it => it.image)) plainShortlist = true;
      out.push({ ...b, items });
      continue;
    }
    out.push(b);
  }

  if (plainShortlist) {
    notes.push("A shortlist with no pictures: if these are real places, products or things to choose between, a real photo of each makes the page — image_search each one (or use a photo off its own page) and page_update. If pictures would not help here, leave it.");
  }
  return { ok: true, blocks: out, notes };
}
