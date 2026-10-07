// Blocks in, a real Word document out.
//
// This is the .docx half of "Reason produces documents". It is the same job src/pages/render.js
// does for HTML — one place where checked blocks become one format — and it has the same rule:
// every string the model wrote is DATA. A .docx is a zip of XML, and the `docx` package writes that
// XML from objects rather than from strings, so there is no path by which a title or a table cell
// becomes markup. Nothing here fetches anything: no image, no font, no network.
//
// The look is deliberately plain, and plain is not the same as unstyled. It is a document somebody
// might print or send on: one serif-free family the way the pages do, a title, an optional subtitle,
// headings that are obviously headings, numbered steps that Word itself numbers, and tables with
// hairlines rather than boxes. Nothing in a colour except the one warning callout, because a
// document full of accent colours reads as a template and this is meant to read as writing.
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ExternalHyperlink, ShadingType,
} from "docx";

/** Everything measured the way Word measures it: half-points for type, twips for space. */
const FONT = "Helvetica Neue";
const MONO = "Menlo";
const INK = "16130F";
const GREY = "6F675D";
const RULE = "E7E0D6";
const WARN = "B3261E";
const CARD = "FAF7F2";

const SPACE = { before: 120, after: 120 };

function text(content, opts = {}) {
  return new TextRun({ font: FONT, color: INK, size: 22, ...opts, text: String(content ?? "") });
}

/** One paragraph of the model's text, keeping its blank lines as separate paragraphs. */
function paragraphs(body, opts = {}) {
  return String(body ?? "").split(/\n{2,}/).map(part => new Paragraph({
    spacing: { before: 100, after: 160 },
    ...opts,
    // A single newline inside a paragraph is a line break, exactly as the page renderer treats it.
    children: part.split(/\n/).flatMap((line, i) => (i ? [text(line, { break: 1 })] : [text(line)])),
  }));
}

function heading(title) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 420, after: 140 },
    children: [text(title, { size: 30, bold: true })],
  });
}

function bullet(runs, level = 0) {
  return new Paragraph({ bullet: { level }, spacing: SPACE, children: runs });
}

function cell(children, { header = false, width = null } = {}) {
  return new TableCell({
    children,
    ...(width ? { width: { size: width, type: WidthType.PERCENTAGE } } : {}),
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    ...(header ? { shading: { type: ShadingType.CLEAR, fill: CARD } } : {}),
  });
}

const HAIRLINE = { style: BorderStyle.SINGLE, size: 2, color: RULE };
const TABLE_BORDERS = { top: HAIRLINE, bottom: HAIRLINE, left: HAIRLINE, right: HAIRLINE, insideHorizontal: HAIRLINE, insideVertical: HAIRLINE };

function table(block) {
  const width = Math.floor(100 / block.columns.length);
  const rows = [
    new TableRow({
      tableHeaderRow: true,
      children: block.columns.map(c => cell([new Paragraph({ children: [text(c, { bold: true, size: 20 })] })], { header: true, width })),
    }),
    ...block.rows.map(r => new TableRow({
      children: r.map(c => cell([new Paragraph({ children: [text(c, { size: 20 })] })], { width })),
    })),
  ];
  return [
    ...(block.title ? [new Paragraph({ spacing: { before: 280, after: 100 }, children: [text(block.title, { bold: true })] })] : []),
    new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: TABLE_BORDERS }),
    new Paragraph({ spacing: { after: 200 }, children: [] }),
  ];
}

/**
 * One block as Word paragraphs. Unknown types cannot reach here — the content check refuses
 * anything that is not in the fixed set — so there is no fallback branch pretending otherwise.
 */
function blockToDocx(b) {
  switch (b.type) {
    case "section": return [heading(b.title)];
    case "text": return paragraphs(b.text);
    case "steps": return [
      ...(b.title ? [new Paragraph({ spacing: { before: 280, after: 100 }, children: [text(b.title, { bold: true })] })] : []),
      // Word's own numbering, so the numbers stay right if somebody edits the list.
      ...b.items.map(s => new Paragraph({ numbering: { reference: "reason-steps", level: 0 }, spacing: SPACE, children: [text(s)] })),
    ];
    case "rows": return [
      ...(b.title ? [new Paragraph({ spacing: { before: 280, after: 100 }, children: [text(b.title, { bold: true })] })] : []),
      ...b.items.map((it, i) => bullet([
        text(b.numbered ? `${i + 1}. ${it.name}` : it.name, { bold: true }),
        ...(it.value ? [text(` — ${it.value}`)] : []),
        ...(it.n ? [text(` (${it.n})`)] : []),
        ...(it.detail ? [text(it.detail, { break: 1, color: GREY, size: 20 })] : []),
      ])),
    ];
    case "timeline": return [
      ...(b.title ? [new Paragraph({ spacing: { before: 280, after: 100 }, children: [text(b.title, { bold: true })] })] : []),
      ...b.items.map(it => bullet([
        text(it.label, { bold: true }),
        ...(it.state && it.state !== "plain" ? [text(` — ${it.state}`, { color: GREY })] : []),
        ...(it.at ? [text(` · ${it.at}`, { color: GREY, size: 20 })] : []),
        ...(it.note ? [text(it.note, { break: 1, color: GREY, size: 20 })] : []),
      ])),
    ];
    case "status": return [new Paragraph({
      spacing: { before: 200, after: 200 },
      children: [
        text(`${b.state.toUpperCase()} · `, { bold: true, color: GREY, size: 20 }),
        text(b.headline, { bold: true }),
        ...(b.detail ? [text(b.detail, { break: 1, color: GREY, size: 20 })] : []),
      ],
    })];
    case "links": return [
      ...(b.title ? [new Paragraph({ spacing: { before: 280, after: 100 }, children: [text(b.title, { bold: true })] })] : []),
      ...b.items.map(it => bullet([
        // A real hyperlink, so a link in a document somebody was sent is a link they can follow.
        new ExternalHyperlink({ link: it.url, children: [text(it.label, { style: "Hyperlink" })] }),
        ...(it.note ? [text(` — ${it.note}`, { color: GREY, size: 20 })] : []),
      ])),
    ];
    case "cards": return [
      ...(b.title ? [new Paragraph({ spacing: { before: 280, after: 100 }, children: [text(b.title, { bold: true })] })] : []),
      ...b.items.map(it => bullet([
        text(it.title, { bold: true }),
        ...(it.price ? [text(` — ${it.price}`)] : []),
        ...(it.note ? [text(it.note, { break: 1, color: GREY, size: 20 })] : []),
        ...(it.url ? [new ExternalHyperlink({ link: it.url, children: [text(it.url, { break: 1, style: "Hyperlink", size: 20 })] })] : []),
      ])),
    ];
    case "table": return table(b);
    case "callout": return [new Paragraph({
      spacing: { before: 260, after: 260 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: b.tone === "warning" ? WARN : RULE, space: 12 } },
      shading: b.tone === "plain" ? undefined : { type: ShadingType.CLEAR, fill: CARD },
      children: [
        ...(b.title ? [text(b.title, { bold: true, ...(b.tone === "warning" ? { color: WARN } : {}) }), text("", { break: 1 })] : []),
        text(b.text),
      ],
    })];
    case "details": return [
      // Nothing folds in a Word document, so the part a page hides behind a tap is simply a titled
      // section here. It is the honest translation: the detail is complete either way.
      new Paragraph({ spacing: { before: 320, after: 100 }, children: [text(b.title, { bold: true })] }),
      ...paragraphs(b.text, { spacing: { before: 60, after: 120 } }),
    ];
    case "copy": return [
      new Paragraph({ spacing: { before: 320, after: 100 }, children: [text(b.label, { bold: true })] }),
      // The thing itself, verbatim, in a monospaced family so its own line breaks and indentation
      // survive being read in Word. Every line is its own break, not a reflowed paragraph.
      new Paragraph({
        spacing: { before: 60, after: 240 },
        shading: { type: ShadingType.CLEAR, fill: CARD },
        children: b.text.split("\n").flatMap((line, i) => (i ? [text(line, { font: MONO, size: 19, break: 1 })] : [text(line, { font: MONO, size: 19 })])),
      }),
    ];
    // An image never reaches here: checkDocument refuses one for a .docx, by name, rather than
    // letting a document go out with a picture quietly missing from it.
    default: return [];
  }
}

/**
 * One document, as bytes.
 *
 * @param {{title: string, subtitle?: string|null, closing?: string|null, blocks: Array<object>, forName?: string, when?: string}} doc
 * @returns {Promise<Buffer>}
 */
export async function renderDocx({ title, subtitle = null, closing = null, blocks = [], forName = "", when = "" }) {
  const top = [forName ? `For ${forName}` : "", when].filter(Boolean).join(" · ");
  const body = [
    ...(top ? [new Paragraph({ spacing: { after: 160 }, children: [text(top, { color: GREY, size: 19 })] })] : []),
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { after: subtitle ? 80 : 280 },
      children: [text(title, { size: 44, bold: true })],
    }),
    ...(subtitle ? [new Paragraph({ spacing: { after: 320 }, children: [text(subtitle, { color: GREY, size: 24 })] })] : []),
    ...blocks.flatMap(blockToDocx),
    ...(closing ? [new Paragraph({ spacing: { before: 400 }, children: [text(closing, { color: GREY, size: 20 })] })] : []),
    new Paragraph({
      spacing: { before: closing ? 120 : 400 },
      alignment: AlignmentType.LEFT,
      children: [text("Written by Reason.", { color: GREY, size: 18 })],
    }),
  ];

  const file = new Document({
    title,
    description: subtitle ?? "",
    creator: "Reason",
    numbering: {
      config: [{
        reference: "reason-steps",
        levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }],
      }],
    },
    styles: { default: { document: { run: { font: FONT, size: 22, color: INK } } } },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children: body }],
  });
  return await Packer.toBuffer(file);
}
