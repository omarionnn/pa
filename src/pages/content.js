// What a page is allowed to contain, and the check that keeps it to that.
//
// The model supplies *data*, never markup. It picks from a fixed set of blocks — a heading, some
// text, a picture, a comparison table, some links, a row of cards, a question with options — and
// our template turns that into HTML. There is no block that takes HTML, no block that takes a
// script, and no way to smuggle either: every string is escaped at render time, and a page that
// arrives with something unrecognised in it is refused here rather than rendered and hoped about.
//
// The one rule that is not about markup: **a picture has to come from somewhere real.** The model
// cannot type an image URL from memory, because it will produce plausible, dead, or wrong ones.
// Every image URL is checked against the URLs this conversation has actually seen in a tool result
// (see `db.rememberSeenUrls`), so a picture on a page is a picture something really served.

export const BLOCK_TYPES = ["section", "text", "image", "table", "links", "cards", "choice"];

const LIMITS = {
  blocks: 60,
  title: 120,
  text: 4000,
  label: 200,
  columns: 6,
  rows: 40,
  items: 24,
  options: 8,
};

function str(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

function httpsUrl(v) {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}

function webUrl(v) {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) return null;
  try {
    const u = new URL(t);
    return ["https:", "http:"].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

/**
 * Check and normalise one page's content.
 *
 * Returns `{ ok: true, blocks }` with every string trimmed and every URL parsed, or
 * `{ ok: false, error }` naming the block and what is wrong with it — the model has to be able to
 * fix it on the next turn, so "invalid content" is not an acceptable answer.
 *
 * @param {unknown} blocks
 * @param {{seenUrl?: (url: string) => boolean}} opts  how to tell whether an image URL is real
 */
export function checkContent(blocks, { seenUrl = () => false } = {}) {
  if (!Array.isArray(blocks) || !blocks.length) {
    return { ok: false, error: "A page needs at least one block of content." };
  }
  if (blocks.length > LIMITS.blocks) {
    return { ok: false, error: `That is ${blocks.length} blocks; a page holds at most ${LIMITS.blocks}. Split it or cut it down.` };
  }

  const out = [];
  const keys = new Set();

  for (const [i, raw] of blocks.entries()) {
    const at = `block ${i + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `${at} is not a block. Each one is an object with a "type".` };
    }
    const type = raw.type;
    if (!BLOCK_TYPES.includes(type)) {
      return { ok: false, error: `${at} has type '${type}', which is not a block. Use one of: ${BLOCK_TYPES.join(", ")}.` };
    }

    switch (type) {
      case "section": {
        const title = str(raw.title, LIMITS.title);
        if (!title) return { ok: false, error: `${at} (section) needs a title, under ${LIMITS.title} characters.` };
        out.push({ type, title });
        break;
      }
      case "text": {
        const text = str(raw.text, LIMITS.text);
        if (!text) return { ok: false, error: `${at} (text) needs text, under ${LIMITS.text} characters.` };
        out.push({ type, text });
        break;
      }
      case "image": {
        const url = httpsUrl(raw.url);
        if (!url) return { ok: false, error: `${at} (image) needs an https url.` };
        if (!seenUrl(url)) {
          return {
            ok: false,
            error: `${at} (image) points at ${url}, which has not come back from any tool in this conversation.`
              + ` You cannot put a picture on a page unless something real served it — a page you actually read, for instance.`
              + ` Do not type image addresses from memory: leave the picture out and say so.`,
          };
        }
        const caption = raw.caption === undefined ? null : str(raw.caption, LIMITS.label);
        if (raw.caption !== undefined && !caption) return { ok: false, error: `${at} (image) has a caption that is empty or too long.` };
        out.push({ type, url, caption });
        break;
      }
      case "table": {
        const columns = Array.isArray(raw.columns) ? raw.columns.map(c => str(c, LIMITS.label)) : null;
        if (!columns || !columns.length || columns.some(c => !c)) {
          return { ok: false, error: `${at} (table) needs a non-empty "columns" array of short strings.` };
        }
        if (columns.length > LIMITS.columns) return { ok: false, error: `${at} (table) has ${columns.length} columns; the most is ${LIMITS.columns}.` };
        if (!Array.isArray(raw.rows) || !raw.rows.length) return { ok: false, error: `${at} (table) needs at least one row.` };
        if (raw.rows.length > LIMITS.rows) return { ok: false, error: `${at} (table) has ${raw.rows.length} rows; the most is ${LIMITS.rows}.` };
        const rows = [];
        for (const [j, r] of raw.rows.entries()) {
          if (!Array.isArray(r) || r.length !== columns.length) {
            return { ok: false, error: `${at} (table) row ${j + 1} has ${Array.isArray(r) ? r.length : "no"} cells; every row needs ${columns.length}, one per column.` };
          }
          rows.push(r.map(c => (c === null || c === undefined ? "" : String(c)).slice(0, LIMITS.label)));
        }
        const title = raw.title === undefined ? null : str(raw.title, LIMITS.title);
        out.push({ type, title, columns, rows });
        break;
      }
      case "links": {
        if (!Array.isArray(raw.items) || !raw.items.length) return { ok: false, error: `${at} (links) needs at least one item.` };
        if (raw.items.length > LIMITS.items) return { ok: false, error: `${at} (links) has too many items; the most is ${LIMITS.items}.` };
        const items = [];
        for (const [j, it] of raw.items.entries()) {
          const label = str(it?.label, LIMITS.label);
          const url = webUrl(it?.url);
          if (!label || !url) return { ok: false, error: `${at} (links) item ${j + 1} needs a label and an http(s) url.` };
          items.push({ label, url, note: str(it?.note, LIMITS.label) });
        }
        out.push({ type, title: raw.title === undefined ? null : str(raw.title, LIMITS.title), items });
        break;
      }
      case "cards": {
        if (!Array.isArray(raw.items) || !raw.items.length) return { ok: false, error: `${at} (cards) needs at least one item.` };
        if (raw.items.length > LIMITS.items) return { ok: false, error: `${at} (cards) has too many items; the most is ${LIMITS.items}.` };
        const items = [];
        for (const [j, it] of raw.items.entries()) {
          const title = str(it?.title, LIMITS.title);
          if (!title) return { ok: false, error: `${at} (cards) item ${j + 1} needs a title.` };
          let image = null;
          if (it?.image !== undefined && it.image !== null && it.image !== "") {
            image = httpsUrl(it.image);
            if (!image) return { ok: false, error: `${at} (cards) item ${j + 1} has an image that is not an https url.` };
            if (!seenUrl(image)) {
              return {
                ok: false,
                error: `${at} (cards) item ${j + 1} points at the image ${image}, which has not come back from any tool in this conversation.`
                  + ` Leave the picture out rather than guessing an address.`,
              };
            }
          }
          let url = null;
          if (it?.url !== undefined && it.url !== null && it.url !== "") {
            url = webUrl(it.url);
            if (!url) return { ok: false, error: `${at} (cards) item ${j + 1} has a url that is not http(s).` };
          }
          items.push({ title, image, url, price: str(it?.price, LIMITS.label), note: str(it?.note, LIMITS.text) });
        }
        out.push({ type, title: raw.title === undefined ? null : str(raw.title, LIMITS.title), items });
        break;
      }
      case "choice": {
        const key = str(raw.key, 60);
        if (!key || !/^[a-z0-9_-]+$/i.test(key)) {
          return { ok: false, error: `${at} (choice) needs a short "key" of letters, numbers, - or _. It is how the answer comes back to you.` };
        }
        if (keys.has(key)) return { ok: false, error: `${at} (choice) reuses the key '${key}'. Each choice on a page needs its own.` };
        keys.add(key);
        const question = str(raw.question, LIMITS.title);
        if (!question) return { ok: false, error: `${at} (choice) needs a question.` };
        if (!Array.isArray(raw.options) || raw.options.length < 2) {
          return { ok: false, error: `${at} (choice) needs at least two options.` };
        }
        if (raw.options.length > LIMITS.options) return { ok: false, error: `${at} (choice) has too many options; the most is ${LIMITS.options}.` };
        const options = [];
        for (const [j, o] of raw.options.entries()) {
          const label = str(typeof o === "string" ? o : o?.label, LIMITS.label);
          if (!label) return { ok: false, error: `${at} (choice) option ${j + 1} needs a label.` };
          if (options.some(x => x.label === label)) return { ok: false, error: `${at} (choice) has two options labelled '${label}'.` };
          options.push({ label, note: typeof o === "string" ? null : str(o?.note, LIMITS.label) });
        }
        out.push({ type, key, question, options });
        break;
      }
    }
  }
  return { ok: true, blocks: out };
}

/** The choice keys on a page, for checking a submitted pick against what is actually on it. */
export function choiceKeys(blocks) {
  return (Array.isArray(blocks) ? blocks : []).filter(b => b?.type === "choice").map(b => b.key);
}

/** One choice block by key, or null. */
export function choiceBlock(blocks, key) {
  return (Array.isArray(blocks) ? blocks : []).find(b => b?.type === "choice" && b.key === key) ?? null;
}
