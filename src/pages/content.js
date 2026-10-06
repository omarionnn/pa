// What a page is allowed to contain, and the check that keeps it to that.
//
// The model supplies *data*, never markup. It picks from a fixed set of blocks — a heading, some
// text, a picture, a comparison table, some links, a row of cards, a question with options, where
// something has got to, the steps it went through, the technical detail folded away, a piece of
// text to copy or download — and our template turns that into HTML. There is no block that takes HTML, no block that takes a
// script, and no way to smuggle either: every string is escaped at render time, and a page that
// arrives with something unrecognised in it is refused here rather than rendered and hoped about.
//
// The one rule that is not about markup: **a picture has to come from somewhere real.** The model
// cannot type an image URL from memory, because it will produce plausible, dead, or wrong ones.
// Every image URL is checked against the URLs this conversation has actually seen in a tool result
// (see `db.rememberSeenUrls`), so a picture on a page is a picture something really served.

export const BLOCK_TYPES = ["section", "text", "image", "table", "links", "cards", "choice", "status", "timeline", "details", "copy"];

/**
 * The states a `status` block may be in. A fixed list rather than free text, because this block is
 * the one thing on a page meant to be read in a glance, and a glance takes in the colour and the
 * shape before it takes in the word. Free text would let every page invent its own vocabulary —
 * "in progress", "underway", "wip" — and none of them would look like each other.
 */
export const STATUS_STATES = ["working", "waiting", "done", "failed", "stopped", "queued"];

/** What a step on a `timeline` may say about itself. Same reasoning as STATUS_STATES. */
export const STEP_STATES = ["done", "now", "waiting", "failed", "plain"];

const LIMITS = {
  blocks: 60,
  title: 120,
  text: 4000,
  label: 200,
  columns: 6,
  rows: 40,
  items: 24,
  options: 8,
  steps: 40,
  detail: 8000,
  copyLabel: 40,
  copyText: 20000,
  filename: 80,
};

/**
 * A filename safe to offer as a download: letters, digits, dot, dash and underscore, nothing
 * else, always ending in .txt. Anything a path could be smuggled through — slashes, dots at the
 * front, control characters — is replaced rather than refused, because the model should not have
 * to care about the rules of three operating systems to name a file. Returns null only when
 * nothing usable is left.
 */
export function safeFilename(v, fallback) {
  const raw = typeof v === "string" && v.trim() ? v : fallback;
  let name = String(raw ?? "").trim().replace(/\.txt$/i, "");
  name = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.\-_]+|[.\-_]+$/g, "").replace(/\.{2,}/g, ".");
  if (!name) return null;
  if (name.length > LIMITS.filename) name = name.slice(0, LIMITS.filename).replace(/[.\-_]+$/g, "");
  return name ? `${name}.txt` : null;
}

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
      // Where something has got to, as a badge and one line. At most one per page: two status
      // blocks is two answers to "what is the state of this", and a reader has to pick. The second
      // one is refused rather than rendered, because a page that contradicts itself about its own
      // state is worse than a page with no badge at all.
      case "status": {
        if (out.some(b => b.type === "status")) {
          return { ok: false, error: `${at} (status) is the second status block on this page. A page has one state, so it gets one badge — fold the rest into the headline or a timeline.` };
        }
        if (!STATUS_STATES.includes(raw.state)) {
          return { ok: false, error: `${at} (status) has state '${raw.state}', which is not one of: ${STATUS_STATES.join(", ")}.` };
        }
        const headline = str(raw.headline, LIMITS.title);
        if (!headline) return { ok: false, error: `${at} (status) needs a short "headline" saying where it has got to, under ${LIMITS.title} characters. Plain words, no jargon — this is the first thing anybody reads.` };
        const detail = raw.detail === undefined || raw.detail === null || raw.detail === "" ? null : str(raw.detail, LIMITS.text);
        if (raw.detail && !detail) return { ok: false, error: `${at} (status) has a detail that is empty or too long.` };
        out.push({ type, state: raw.state, headline, detail });
        break;
      }

      // The steps something went through, in order, each one saying whether it is done, happening,
      // waiting or broken.
      case "timeline": {
        if (!Array.isArray(raw.items) || !raw.items.length) return { ok: false, error: `${at} (timeline) needs at least one step.` };
        if (raw.items.length > LIMITS.steps) return { ok: false, error: `${at} (timeline) has ${raw.items.length} steps; the most is ${LIMITS.steps}.` };
        const items = [];
        for (const [j, it] of raw.items.entries()) {
          const label = str(it?.label, LIMITS.label);
          if (!label) return { ok: false, error: `${at} (timeline) step ${j + 1} needs a label.` };
          const state = it?.state === undefined || it.state === null || it.state === "" ? "plain" : it.state;
          if (!STEP_STATES.includes(state)) {
            return { ok: false, error: `${at} (timeline) step ${j + 1} has state '${it.state}', which is not one of: ${STEP_STATES.join(", ")}.` };
          }
          items.push({ label, state, note: str(it?.note, LIMITS.text), at: str(it?.at, LIMITS.label) });
        }
        out.push({ type, title: raw.title === undefined ? null : str(raw.title, LIMITS.title), items });
        break;
      }

      // The part nobody has to read. Folded shut, so the detail can be complete without the detail
      // being the page: whoever wants the commit hashes taps once and whoever does not never sees them.
      case "details": {
        const title = str(raw.title, LIMITS.title);
        if (!title) return { ok: false, error: `${at} (details) needs a title — it is the line somebody taps to open it.` };
        const text = str(raw.text, LIMITS.detail);
        if (!text) return { ok: false, error: `${at} (details) needs text, under ${LIMITS.detail} characters.` };
        out.push({ type, title, text });
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
      case "copy": {
        const label = str(raw.label, LIMITS.copyLabel);
        if (!label) {
          return { ok: false, error: `${at} (copy) needs a short "label" naming what it is — "prompt", "cover letter", "bio" — under ${LIMITS.copyLabel} characters. It appears on the button as "Copy full {label}".` };
        }
        if (typeof raw.text !== "string" || !raw.text.trim()) {
          return { ok: false, error: `${at} (copy) needs "text": the full content the owner will copy or download.` };
        }
        if (raw.text.length > LIMITS.copyText) {
          return { ok: false, error: `${at} (copy) has ${raw.text.length} characters of text; the most is ${LIMITS.copyText}. Split it into two copy blocks or cut it down.` };
        }
        // Keep the content as written, bar the outer whitespace: a prompt is pasted verbatim, so
        // its inner line breaks and indentation are the point.
        const text = raw.text.replace(/\r\n?/g, "\n").trim();
        if (raw.filename !== undefined && raw.filename !== null && typeof raw.filename !== "string") {
          return { ok: false, error: `${at} (copy) has a filename that is not a string. Leave it out to use "${safeFilename(label)}".` };
        }
        const filename = safeFilename(raw.filename, label) ?? safeFilename(label) ?? "copy.txt";
        out.push({ type, label, filename, text });
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
