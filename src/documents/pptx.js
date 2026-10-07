// Blocks in, a real slide deck out.
//
// The hard part of a deck is not the XML, it is deciding where the slides end. A page scrolls, so
// the page renderer never has to answer that; a deck does. The rule here is the one a person uses:
//
//   a `section` block starts a new slide, and everything until the next section is on it.
//
// That is why the block set is shared. A model that has already written an answer as a heading and
// then the things under it has already decided what the slides are, without being asked a second
// question. Blocks that arrive before any section go on an opening slide after the title.
//
// Two things are enforced rather than hoped for. A slide holds at most MAX_LINES bullets, and the
// overflow goes to a continuation slide with the same title and "(cont.)" on it — a deck that
// quietly ran its last four bullets off the bottom of the slide is the failure this prevents, and
// nothing here can see a rendered slide to notice. And a table gets a slide to itself, because a
// table under three bullets is a table nobody can read.
//
// Nothing fetches anything: no image (checkDocument refuses one for a .pptx by name), no font
// beyond what is on the machine, nothing on the network. Every string is passed as data to
// pptxgenjs, never as markup.
import PptxGenJS from "pptxgenjs";

const FONT = "Helvetica Neue";
const MONO = "Menlo";
const INK = "16130F";
const GREY = "6F675D";
const WARN = "B3261E";
const CARD = "FAF7F2";
const RULE = "E7E0D6";

/** 13.3 × 7.5 inches: the 16:9 layout every projector and every laptop agrees on. */
const W = 13.333;
const H = 7.5;
const MARGIN = 0.8;
const BODY_TOP = 1.9;
const BODY_H = H - BODY_TOP - 0.7;

/** How many bullets fit on one slide before the rest go on a continuation. Counted, not eyeballed. */
export const MAX_LINES = 8;

/** A bullet line: the text, plus an optional grey second line under it. */
function line(label, { detail = "", bold = false, indent = 0 } = {}) {
  return { label: String(label ?? ""), detail: String(detail ?? ""), bold, indent };
}

/**
 * One block as bullet lines, or as its own slide.
 *
 * Returns `{ lines }` for anything that joins the current slide, or `{ own }` for a block that is a
 * slide in itself — a table, and a copy block, which is a wall of verbatim text nobody can read
 * squeezed under bullets.
 */
function blockToLines(b) {
  switch (b.type) {
    case "text":
      // One bullet per paragraph: a paragraph break the model wrote is a break on the slide too.
      return { lines: String(b.text).split(/\n{2,}/).map(p => line(p.replace(/\n/g, " "))) };
    case "steps":
      return { lines: b.items.map((s, i) => line(`${i + 1}. ${s}`)) };
    case "rows":
      return {
        lines: b.items.map((it, i) => line(
          [b.numbered ? `${i + 1}. ${it.name}` : it.name, it.value ? `— ${it.value}` : "", it.n ? `(${it.n})` : ""].filter(Boolean).join(" "),
          { detail: it.detail ?? "", bold: true },
        )),
      };
    case "timeline":
      return {
        lines: b.items.map(it => line(
          [it.label, it.state && it.state !== "plain" ? `— ${it.state}` : "", it.at ? `· ${it.at}` : ""].filter(Boolean).join(" "),
          { detail: it.note ?? "", bold: true },
        )),
      };
    case "status":
      return { lines: [line(`${b.state.toUpperCase()} · ${b.headline}`, { detail: b.detail ?? "", bold: true })] };
    case "links":
      return { lines: b.items.map(it => line(it.label, { detail: [it.url, it.note].filter(Boolean).join(" — ") })) };
    case "cards":
      return { lines: b.items.map(it => line([it.title, it.price ? `— ${it.price}` : ""].filter(Boolean).join(" "), { detail: it.note ?? "", bold: true })) };
    case "callout":
      return { lines: [line(b.title ? `${b.title}: ${b.text}` : b.text, { bold: b.tone === "warning" })] };
    case "details":
      return { lines: [line(b.title, { detail: String(b.text).replace(/\n+/g, " "), bold: true })] };
    case "table": return { own: b };
    case "copy": return { own: b };
    default: return { lines: [] };
  }
}

/** The title and subtitle, on their own slide, like the top of a page. */
function titleSlide(deck, { title, subtitle, top }) {
  const s = deck.addSlide();
  if (top) s.addText(top, { x: MARGIN, y: 0.6, w: W - MARGIN * 2, h: 0.4, fontFace: FONT, fontSize: 13, color: GREY });
  s.addShape(deck.ShapeType.rect, { x: MARGIN, y: 1.1, w: W - MARGIN * 2, h: 0.01, fill: { color: RULE } });
  s.addText(title, {
    x: MARGIN, y: 1.6, w: W - MARGIN * 2, h: 2.2,
    fontFace: FONT, fontSize: title.length > 60 ? 34 : 44, bold: true, color: INK, valign: "top",
  });
  if (subtitle) {
    s.addText(subtitle, { x: MARGIN, y: 3.9, w: W - MARGIN * 2, h: 1, fontFace: FONT, fontSize: 18, color: GREY, valign: "top" });
  }
  s.addText("Written by Reason.", { x: MARGIN, y: H - 0.85, w: W - MARGIN * 2, h: 0.3, fontFace: FONT, fontSize: 11, color: GREY });
  return s;
}

/** The furniture every content slide has: the heading and the hairline under it. */
function contentSlide(deck, heading) {
  const s = deck.addSlide();
  s.addText(heading, { x: MARGIN, y: 0.7, w: W - MARGIN * 2, h: 0.8, fontFace: FONT, fontSize: 26, bold: true, color: INK, valign: "top" });
  s.addShape(deck.ShapeType.rect, { x: MARGIN, y: BODY_TOP - 0.35, w: W - MARGIN * 2, h: 0.01, fill: { color: RULE } });
  return s;
}

function addLines(deck, heading, lines) {
  const slides = [];
  const chunks = [];
  for (let i = 0; i < lines.length; i += MAX_LINES) chunks.push(lines.slice(i, i + MAX_LINES));
  for (const [i, chunk] of chunks.entries()) {
    const s = contentSlide(deck, i ? `${heading} (cont.)` : heading);
    const runs = chunk.flatMap(l => [
      { text: l.label, options: { bullet: true, bold: l.bold, fontSize: 16, color: INK, breakLine: true } },
      ...(l.detail ? [{ text: l.detail, options: { indentLevel: 1, fontSize: 13, color: GREY, breakLine: true } }] : []),
    ]);
    s.addText(runs, { x: MARGIN, y: BODY_TOP, w: W - MARGIN * 2, h: BODY_H, fontFace: FONT, valign: "top" });
    slides.push(s);
  }
  return slides;
}

function addTable(deck, heading, b) {
  const s = contentSlide(deck, b.title ? `${heading} — ${b.title}` : heading);
  const head = b.columns.map(c => ({ text: c, options: { bold: true, fill: { color: CARD } } }));
  const rows = b.rows.map(r => r.map(c => ({ text: String(c ?? "") })));
  s.addTable([head, ...rows], {
    x: MARGIN, y: BODY_TOP, w: W - MARGIN * 2,
    fontFace: FONT, fontSize: 13, color: INK, border: { type: "solid", pt: 0.5, color: RULE },
    autoPage: true, autoPageRepeatHeader: true, autoPageSlideStartY: BODY_TOP,
  });
  return s;
}

function addCopy(deck, heading, b) {
  const s = contentSlide(deck, `${heading} — ${b.label}`);
  s.addText(b.text, {
    x: MARGIN, y: BODY_TOP, w: W - MARGIN * 2, h: BODY_H,
    fontFace: MONO, fontSize: 11, color: INK, valign: "top", fill: { color: CARD }, margin: 10,
  });
  return s;
}

/**
 * One deck, as bytes.
 *
 * @param {{title: string, subtitle?: string|null, closing?: string|null, blocks: Array<object>, forName?: string, when?: string}} doc
 * @returns {Promise<Buffer>}
 */
export async function renderPptx({ title, subtitle = null, closing = null, blocks = [], forName = "", when = "" }) {
  const deck = new PptxGenJS();
  deck.defineLayout({ name: "REASON", width: W, height: H });
  deck.layout = "REASON";
  deck.title = title;
  deck.subject = subtitle ?? "";
  deck.author = "Reason";
  deck.company = "Reason";

  titleSlide(deck, { title, subtitle, top: [forName ? `For ${forName}` : "", when].filter(Boolean).join(" · ") });

  // Walk the blocks, cutting a new slide at every section heading. Pending lines are flushed
  // before any block that takes a slide of its own, so a table never swallows the bullets above it.
  let heading = title;
  let pending = [];
  const flush = () => {
    if (pending.length) addLines(deck, heading, pending);
    pending = [];
  };
  for (const b of blocks) {
    if (b.type === "section") {
      flush();
      heading = b.title;
      continue;
    }
    const out = blockToLines(b);
    if (out.own) {
      flush();
      if (out.own.type === "table") addTable(deck, heading, out.own);
      else addCopy(deck, heading, out.own);
      continue;
    }
    pending.push(...out.lines);
    while (pending.length >= MAX_LINES) {
      addLines(deck, heading, pending.slice(0, MAX_LINES));
      pending = pending.slice(MAX_LINES);
      heading = `${String(heading).replace(/ \(cont\.\)$/, "")} (cont.)`;
    }
  }
  flush();

  if (closing) {
    const s = deck.addSlide();
    s.addText(closing, { x: MARGIN, y: H / 2 - 0.8, w: W - MARGIN * 2, h: 1.6, fontFace: FONT, fontSize: 22, color: INK, valign: "middle" });
    s.addText("Written by Reason.", { x: MARGIN, y: H - 0.85, w: W - MARGIN * 2, h: 0.3, fontFace: FONT, fontSize: 11, color: GREY });
  }

  // `write` with nodebuffer rather than `writeFile`: the bytes are hashed and written once, by the
  // one place that owns the documents directory (src/documents/store.js), so nothing else here
  // decides where a file goes.
  const out = await deck.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
