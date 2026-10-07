// What a document is allowed to contain — which is, deliberately, almost exactly what a page is.
//
// The model supplies DATA and never markup, the same rule and the same fixed block set as
// src/pages/content.js: a heading, some text, numbered steps, plan rows, a table, links, a callout,
// a piece of text to copy. That is the whole point of reusing it. One answer the model has already
// shaped into blocks can become a page the owner opens from a link OR a .docx, a .pptx and a .pdf
// of the same thing, without the model writing it a second time and without a second vocabulary to
// keep true. `checkContent` does all of the work; everything here is the short list of ways a
// document differs from a page.
//
// Two differences, and both are refusals rather than quiet drops:
//
//   - **a choice has nothing to tap.** A question with options is a page block: the owner presses
//     an answer and it comes back as a turn. In a Word document it is a list of options that does
//     nothing, so it is refused by name and the model is told to make a page instead.
//   - **a picture only survives the PDF.** The PDF is the page itself printed by Chromium, so an
//     image on it is the real image. The .docx and .pptx writers here embed no bytes — nothing in
//     them fetches a URL — so a picture in one would be a picture silently missing. Refused, with
//     the kind named, rather than handed over as a document that lost something.
//
// The real-picture rule is unchanged and is not re-implemented: an image URL still has to have come
// back from a tool in this conversation, which `checkContent` checks through `seenUrl`.
import { checkContent, BLOCK_TYPES } from "../pages/content.js";

/** The kinds of document Reason writes. */
export const DOCUMENT_KINDS = ["docx", "pptx", "pdf"];

/** Blocks that are a page's and not a document's, and why. */
const NOT_IN_A_DOCUMENT = {
  choice: "a question the owner taps an answer to only works on a page — in a file it is a list that does nothing."
    + " Put the question on a page (page_create), or write the options into a steps or rows block as information.",
};

/** The kinds that cannot carry a picture, because nothing in them downloads one. */
const NO_PICTURES = ["docx", "pptx"];

/**
 * Check and normalise one document's content.
 *
 * Returns `{ ok: true, blocks }` — the same normalised blocks a page gets — or
 * `{ ok: false, error }` naming the block and what is wrong with it, in words the model can act on
 * next turn.
 *
 * @param {unknown} blocks
 * @param {{kind?: string, seenUrl?: (url: string) => boolean}} opts
 */
export function checkDocument(blocks, { kind = "pdf", seenUrl = () => false } = {}) {
  if (!DOCUMENT_KINDS.includes(kind)) {
    return { ok: false, error: `'${kind}' is not a kind of document Reason writes. Use one of: ${DOCUMENT_KINDS.join(", ")}.` };
  }
  const checked = checkContent(blocks, { seenUrl });
  if (!checked.ok) return checked;

  for (const [i, b] of checked.blocks.entries()) {
    const at = `block ${i + 1}`;
    if (NOT_IN_A_DOCUMENT[b.type]) {
      return { ok: false, error: `${at} is a ${b.type} block, and ${NOT_IN_A_DOCUMENT[b.type]}` };
    }
    if (!NO_PICTURES.includes(kind)) continue;
    if (b.type === "image") {
      return {
        ok: false,
        error: `${at} is a picture, and a .${kind} Reason writes carries no pictures — it would arrive with the picture missing.`
          + ` Take the image block out, or ask for the pdf, which is the page itself printed and does carry it.`,
      };
    }
    if (b.type === "cards" && b.items.some(it => it.image)) {
      return {
        ok: false,
        error: `${at} is a cards block with a picture on it, and a .${kind} Reason writes carries no pictures.`
          + ` Leave the images off the cards, or ask for the pdf.`,
      };
    }
  }
  return { ok: true, blocks: checked.blocks };
}

/** The block types a document really accepts, for the tool description and the tests. */
export const DOCUMENT_BLOCK_TYPES = BLOCK_TYPES.filter(t => !NOT_IN_A_DOCUMENT[t]);
