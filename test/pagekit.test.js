// The page kit: steps, rows, a callout, a subtitle and a closing line.
//
// These came from putting a Reason page next to an Instinct "Files" page with the same content.
// Theirs read like a printed guide; ours read like an app screen, and a numbered list collapsed
// into one paragraph because there was no block for it. What is pinned here:
//
//   - each new block is checked like the old ones: a fixable error, never "invalid content".
//   - each draws what it says it draws, and everything in it is escaped.
//   - the subtitle and the closing line are the page's own fields, bounded, optional, and a page
//     from before they existed still renders.
//   - the chrome is calmer: no sticky bar, no bar before every heading, the top line says whose
//     page it is and when.
//
// No API key, no network, no browser.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pagekit-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
// The number the Back to Reason button texts. Read off config at import, so it goes in first.
process.env.SENDBLUE_FROM_NUMBER = "+1 (415) 555-0199";

const { runTool } = await import("../src/tools.js");
const { pageRequest } = await import("../src/http.js");
const { checkContent, BLOCK_TYPES, CALLOUT_TONES, LINE_LIMIT } = await import("../src/pages/content.js");
const { renderPage, closingLine, backToReason, renderConnected } = await import("../src/pages/render.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = config.ownerConversation;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM pages; DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts; DELETE FROM page_choices; DELETE FROM seen_urls; DELETE FROM action_ledger; DELETE FROM conversations;");
});

/** Move the test clock to a fixed moment, so a date on a page is a known date. */
const at = (ms) => { clock.reset(); clock.skip(ms - Date.now()); };

const { issueCode } = await import("../src/pages/access.js");

/** Open the owner's own link on a browser already proved: type a code once, then tap with the cookie. */
const TAP = async (link) => {
  const u = new URL(link);
  const id = u.pathname.split("/")[2];
  const opened = await pageRequest({
    id, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    readBody: async () => `code=${issueCode(id).code}`,
  });
  const cookie = `reason_page=${/reason_page=([^;]+)/.exec(opened.headers["Set-Cookie"])[1]}`;
  return pageRequest({ id, key: u.searchParams.get("k"), method: "GET", headers: { cookie }, readBody: async () => "" });
};

async function made(input) {
  const out = await runTool("page_create", { title: "Build bigger shoulders", ...input }, { conversationId: C });
  assert.equal(out.ok, true, out.error);
  return out;
}

const PLAN = [
  { type: "text", text: "Shoulders grow like any other muscle: enough hard sets, done with good form, twice a week." },
  { type: "section", title: "The short version" },
  { type: "steps", items: ["Train shoulders directly 2 days a week.", "Start with 11 direct sets a week.", "Add reps first, then weight."] },
  { type: "section", title: "Weekly plan" },
  { type: "rows", title: "Day A", numbered: true, items: [
    { name: "Seated dumbbell overhead press", detail: "2 sets of 6 to 10 reps", value: "2–3 min" },
    { name: "Dumbbell lateral raise", detail: "2 sets of 10 to 15 reps" },
  ] },
  { type: "callout", tone: "warning", title: "Safety", text: "You told me you have no pain at the gym. Sharp or lingering joint pain is not normal: stop that exercise." },
  { type: "callout", tone: "note", text: "The split and rep ranges are programming choices built on the research, not results from one study." },
  { type: "callout", text: "Sleep 7 or more hours when you can." },
];

// ---------- the checker ----------

test("the three new blocks are blocks, and the old ones are untouched", () => {
  for (const t of ["steps", "rows", "callout"]) assert.ok(BLOCK_TYPES.includes(t), t);
  for (const t of ["section", "text", "image", "table", "links", "cards", "choice", "status", "timeline", "details", "copy"]) assert.ok(BLOCK_TYPES.includes(t), t);
  assert.deepEqual(CALLOUT_TONES, ["plain", "note", "warning"]);
});

test("steps are checked: at least two, each a plain string, a typed number taken off", () => {
  const cases = [
    [[{ type: "steps", items: ["only one"] }], /at least two items/],
    [[{ type: "steps", items: ["a", 7] }], /item 2 needs to be a plain string/],
    [[{ type: "steps", items: ["a", "x".repeat(401)] }], /item 2 needs to be a plain string under 400/],
    [[{ type: "steps", items: Array.from({ length: 25 }, (_, i) => `step ${i}`) }], /25 items; the most is 24/],
  ];
  for (const [blocks, re] of cases) {
    const out = checkContent(blocks);
    assert.equal(out.ok, false, JSON.stringify(blocks).slice(0, 60));
    assert.match(out.error, re);
  }
  const ok = checkContent([{ type: "steps", title: "Do this", items: ["1. First thing", "2) Second thing", "  Third thing  "] }]);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.blocks[0], { type: "steps", title: "Do this", items: ["First thing", "Second thing", "Third thing"] });
});

test("rows are checked: a name each, short values, an optional number slot", () => {
  const cases = [
    [[{ type: "rows", items: [] }], /at least one item/],
    [[{ type: "rows", items: [{ detail: "no name" }] }], /item 1 needs a "name"/],
    [[{ type: "rows", items: [{ name: "x", n: "a-very-long-label" }] }], /"n" longer than 8/],
  ];
  for (const [blocks, re] of cases) {
    const out = checkContent(blocks);
    assert.equal(out.ok, false);
    assert.match(out.error, re);
  }
  const ok = checkContent([{ type: "rows", numbered: true, items: [
    { name: " Face pull ", detail: "2 sets of 12 to 20", value: "1 min", n: 3 },
    { name: "Rest", value: "x".repeat(61) },
  ] }]);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.blocks[0].items[0], { name: "Face pull", detail: "2 sets of 12 to 20", value: "1 min", n: "3" });
  assert.equal(ok.blocks[0].items[1].value, null, "an over-long value is dropped rather than drawn wide");
  assert.equal(ok.blocks[0].numbered, true);
});

test("a callout needs text and a tone from the list; no tone means plain", () => {
  assert.match(checkContent([{ type: "callout" }]).error, /needs text/);
  assert.match(checkContent([{ type: "callout", text: "x", tone: "danger" }]).error, /tone 'danger', which is not one of: plain, note, warning/);
  const ok = checkContent([{ type: "callout", text: "Careful." }, { type: "callout", title: "Safety", text: "Stop.", tone: "warning" }]);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.blocks[0].tone, "plain");
  assert.equal(ok.blocks[1].tone, "warning");
  assert.equal(ok.blocks[1].title, "Safety");
});

// ---------- what gets drawn ----------

test("steps draw one numbered row each; rows draw name, detail and value; callouts carry their tone", async () => {
  const out = await made({ blocks: PLAN });
  const body = (await TAP(out.link)).body;

  assert.match(body, /<ol class="steps"><li><span class="n">1\.<\/span><span class="sb">Train shoulders directly 2 days a week\.<\/span><\/li><li><span class="n">2\.<\/span>/);
  assert.equal((body.match(/<li><span class="n">\d\.<\/span><span class="sb">/g) ?? []).length, 3, "three steps, three rows");

  assert.match(body, /<h3>Day A<\/h3><ul class="rows">/);
  assert.match(body, /<li class="row"><span class="n">1\.<\/span><span class="rm"><span class="rn">Seated dumbbell overhead press<\/span><span class="rd">2 sets of 6 to 10 reps<\/span><\/span><span class="rv">2–3 min<\/span><\/li>/);
  assert.match(body, /<span class="n">2\.<\/span><span class="rm"><span class="rn">Dumbbell lateral raise<\/span><span class="rd">2 sets of 10 to 15 reps<\/span><\/span><\/li>/, "no value, no value span");

  assert.match(body, /<aside class="co co-warning"><div class="cot">Safety<\/div><div class="t"><p>You told me/);
  assert.match(body, /<aside class="co co-note"><div class="t"><p>The split/);
  assert.match(body, /<aside class="co co-plain"><div class="t"><p>Sleep 7/);
});

test("everything in the new blocks is escaped, so nothing the model writes becomes a tag", async () => {
  const nasty = `<script>alert('x')</script><img src=x onerror=alert(1)>`;
  const out = await made({ subtitle: nasty, closing: nasty, blocks: [
    { type: "steps", title: nasty, items: [nasty, nasty] },
    { type: "rows", title: nasty, items: [{ name: nasty, detail: nasty, value: "<b>", n: "<i>" }] },
    { type: "callout", title: nasty, text: nasty, tone: "note" },
  ] });
  const body = (await TAP(out.link)).body;
  assert.doesNotMatch(body, /<script>alert/);
  assert.doesNotMatch(body, /<img src=x/);
  assert.doesNotMatch(body, /<b>|<i>/);
  const tags = (body.match(/<[^>]*>/g) ?? []).map(t => t.replace(/"[^"]*"/g, '""'));
  for (const t of tags) assert.doesNotMatch(t, /\son[a-z]+\s*=/i, `tag carries an event handler: ${t}`);
  assert.ok(body.includes("&lt;script&gt;"), "present, as text");
  assert.equal((body.match(/<script/g) ?? []).length, 2, "a page with no choice and no copy block has only the opening moment's script");
  assert.doesNotMatch(body, /execCommand/, "no copy-block clipboard fallback");
});

test("a number slot the model supplied is drawn as given; auto-numbering only when asked", () => {
  const page = { title: "t", revision: 1, shared: false, created_at: 0, updated_at: 0, blocks: [
    { type: "rows", title: null, numbered: false, items: [{ name: "a", detail: null, value: null, n: "A" }, { name: "b", detail: null, value: null, n: null }] },
  ] };
  const html = renderPage(page);
  assert.match(html, /<span class="n">A<\/span><span class="rm"><span class="rn">a<\/span>/);
  assert.match(html, /<li class="row"><span class="rm"><span class="rn">b<\/span>/, "no slot when there is nothing to put in it");
});

// ---------- the page's own two lines ----------

test("a subtitle sits under the title and a closing line sits at the end, after the date", async () => {
  at(Date.UTC(2026, 9, 5, 16, 0, 0)); // Oct 5 2026, noon New York
  const out = await made({ subtitle: "Gym plan, no pain, adjustable to your level", closing: "Start easy for the first two weeks.", blocks: PLAN });
  assert.equal(out.subtitle, "Gym plan, no pain, adjustable to your level");
  assert.equal(out.closing, "Start easy for the first two weeks.");
  const body = (await TAP(out.link)).body;
  assert.match(body, /<h1>Build bigger shoulders<\/h1><p class="sub">Gym plan, no pain, adjustable to your level<\/p>/);
  assert.match(body, /<p class="closing">Written Oct 5, 2026\. Start easy for the first two weeks\.<\/p>/);
  assert.match(body, /Made for Omari · Oct 5<\/span>/, "the top line: whose page, and when");
  assert.doesNotMatch(body, /Put together for/);
  assert.doesNotMatch(body, /position:sticky/, "the top line scrolls away with the page");
});

test("without them the page still has a date line and nothing else, and an old row renders", async () => {
  at(Date.UTC(2026, 9, 5, 16, 0, 0));
  const out = await made({ blocks: PLAN });
  assert.equal(out.subtitle, undefined);
  assert.equal(out.closing, undefined);
  let body = (await TAP(out.link)).body;
  assert.doesNotMatch(body, /class="sub"/);
  assert.match(body, /<p class="closing">Written Oct 5, 2026\.<\/p>/);

  // A page written before the columns existed: no subtitle, no closing, and an update keeps it so.
  db.db.prepare("UPDATE pages SET subtitle = NULL, closing = NULL WHERE id = ?").run(out.page_id);
  clock.skip(26 * 60 * 60 * 1000);
  const changed = await runTool("page_update", { page_id: out.page_id, title: "Shoulders, week two" }, { conversationId: C });
  assert.equal(changed.ok, true, changed.error);
  body = (await TAP(out.link)).body;
  assert.match(body, /<p class="closing">Updated Oct 6, 2026\.<\/p>/, "a changed page says when it changed");
  assert.doesNotMatch(body, /class="sub"/);
});

test("the two lines are bounded, can be changed on their own, and an empty string clears one", async () => {
  const long = "x".repeat(LINE_LIMIT + 1);
  const tooLong = await runTool("page_create", { title: "t", subtitle: long, blocks: PLAN }, { conversationId: C });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /160|at most/i);

  const out = await made({ subtitle: "one line", blocks: PLAN });
  const sub = await runTool("page_update", { page_id: out.page_id, closing: "Go easy." }, { conversationId: C });
  assert.equal(sub.ok, true, sub.error);
  assert.equal(sub.subtitle, "one line", "untouched");
  assert.equal(sub.closing, "Go easy.");
  assert.equal(sub.link, out.link, "the link does not change");

  const cleared = await runTool("page_update", { page_id: out.page_id, subtitle: "" }, { conversationId: C });
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal(cleared.subtitle, undefined, "an empty string removes it");
  assert.equal(cleared.closing, "Go easy.", "the other one stays");

  assert.equal(closingLine({ revision: 3, updated_at: Date.UTC(2026, 9, 6, 16), created_at: 0, closing: "Go easy." }), "Updated Oct 6, 2026. Go easy.");
});

// ---------- calmer chrome ----------

test("the chrome is calmer: no bar before headings, no shadows, hairlines on tables and links", async () => {
  const out = await made({ blocks: [...PLAN, { type: "links", title: "Sources", items: [{ label: "Schoenfeld 2017", url: "https://pubmed.ncbi.nlm.nih.gov/27433992/" }] }] });
  const body = (await TAP(out.link)).body;
  assert.doesNotMatch(body, /h2::before/, "no accent bar before every section heading");
  assert.doesNotMatch(body, /backdrop-filter/, "no blurred sticky bar");
  assert.match(body, /h1\{font:400 /, "the title is set at weight 400, not bold");
  assert.match(body, /h2\{font:400 /);
  assert.match(body, /h2\{[^}]*margin:3rem 0 1rem/, "48px above a section heading");
  assert.match(body, /\.links\{border-top:1px solid var\(--line\)\}/, "sources are hairline rows, not a card");
  assert.match(body, /--shadow:none/);
  // The one accent that stays is the dot in the wordmark; the kicker rule exists but nothing uses it on a page.
  assert.doesNotMatch(body, /class="kicker"/);
});

test("the tool tells the model about the new blocks and the writing order", async () => {
  const { tools } = await import("../src/tools.js");
  const create = tools.find(t => t.name === "page_create");
  const desc = create.input_schema.properties.blocks.description;
  for (const word of ["type:'steps'", "type:'rows'", "type:'callout'", "The short version", "what is research and what is your judgment", "closing line"]) {
    assert.ok(desc.includes(word), `blocks description should mention ${word}`);
  }
  assert.ok(create.input_schema.properties.subtitle, "subtitle is a page field");
  assert.ok(create.input_schema.properties.closing, "closing is a page field");
  const update = tools.find(t => t.name === "page_update");
  assert.ok(update.input_schema.properties.subtitle && update.input_schema.properties.closing);
});

// ---------- the way back ----------
//
// Omari, 2026-10-17: a page at the end of a flow said "connected" and left them there. What is
// pinned here: the button exists, it opens Messages at Reason's own number with the reply already
// typed, the number comes from config, and every end-of-flow page in the repo has it — including
// the ones a future connector will copy.

test("the button opens Messages at Reason's number with the reply pre-filled", () => {
  const html = backToReason({ text: "connected spotify, keep going" });
  // iOS reads `sms:NUMBER&body=...` — an ampersand, not a question mark.
  assert.match(html, /href="sms:\+14155550199&amp;body=connected%20spotify%2C%20keep%20going"/);
  assert.match(html, />Back to Reason</, "the label says where it goes");
  assert.match(html, /opens Messages with your reply typed — just hit send\./);
});

test("the pre-filled text is escaped and encoded, and nothing can break out of the href", () => {
  const html = backToReason({ text: 'connected "x" & <y>, keep going' });
  assert.match(html, /body=connected%20%22x%22%20%26%20%3Cy%3E%2C%20keep%20going"/);
  assert.doesNotMatch(html, /<y>/, "no raw angle brackets reach the page");
  // One attribute, closed where it should be: the href holds no bare quote.
  const href = html.match(/href="([^"]*)"/)[1];
  assert.ok(href.startsWith("sms:+1"), href);
});

test("the default text says something a later turn can act on, not just 'done'", () => {
  assert.match(backToReason(), /body=done%2C%20keep%20going"/);
});

test("no number configured means no button, rather than one that opens Messages at nobody", async () => {
  const { config } = await import("../src/config.js");
  const from = config.sendblueFrom, linq = config.linqFrom;
  config.sendblueFrom = ""; config.linqFrom = "";
  try {
    assert.equal(backToReason({ text: "connected spotify, keep going" }), "");
  } finally {
    config.sendblueFrom = from; config.linqFrom = linq;
  }
});

test("the end-of-flow template always carries the button — a new connector gets it for free", () => {
  const html = renderConnected({ title: "Acme connected", lines: ["Done."], back: { text: "connected acme, keep going" } });
  assert.match(html, /sms:\+14155550199&amp;body=connected%20acme%2C%20keep%20going/);
  assert.match(html, /Acme connected/);
  // Still a Reason page: same chrome as every other notice.
  assert.match(html, /class="sheet"/);
});

test("a plain notice that is not the end of a flow stays as it was", async () => {
  const { renderNotice } = await import("../src/pages/render.js");
  assert.doesNotMatch(renderNotice({ title: "Privacy", lines: ["x"] }), /sms:/);
});

/** The href as a browser reads it: entities decoded, so a test reads like the link does. */
function href(html) {
  const m = html.match(/href="(sms:[^"]*)"/);
  return m && m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

test("every page at the end of a flow we sent them to has the way back", async () => {
  const spotify = await import("../src/spotify.js");
  const uber = await import("../src/uber.js");
  const github = await import("../src/github.js");
  const x = await import("../src/x.js");
  const { googleCallbackRequest } = await import("../src/http.js");

  const N = "sms:+14155550199&body=";
  const pages = [
    ["spotify", spotify.callbackPage({ ok: true, message: "Spotify is connected." }), "connected%20spotify%2C%20keep%20going"],
    ["spotify failed", spotify.callbackPage({ ok: false, message: "No." }), "spotify%20didn't%20connect"],
    ["spotify join done", spotify.joinPage({ done: true }), "sent%20my%20spotify%20email%2C%20keep%20going"],
    ["uber", uber.callbackPage({ ok: true, message: "Uber is connected." }), "connected%20uber%2C%20keep%20going"],
    ["uber failed", uber.callbackPage({ ok: false, message: "No." }), "uber%20didn't%20connect"],
    ["github", github.callbackPage({ ok: true, message: "GitHub is connected." }), "connected%20github%2C%20keep%20going"],
    ["github failed", github.callbackPage({ ok: false, message: "No." }), "github%20didn't%20connect"],
    ["x", x.callbackPage({ ok: true, message: "X is connected." }), "connected%20x%2C%20keep%20going"],
    ["x failed", x.callbackPage({ ok: false, message: "No." }), "x%20didn't%20connect"],
  ];
  for (const [name, html, body] of pages) {
    assert.match(html, />Back to Reason</, `${name} has the button`);
    assert.equal(href(html), N + body, `${name} names itself in the reply`);
    assert.doesNotMatch(html, /You can close this/, `${name} no longer dead-ends`);
  }

  // Google's callback is the one that also texts the thread; its page still ends with the button.
  const bad = await googleCallbackRequest({ code: "", state: "", error: "access_denied" });
  assert.equal(href(bad.body), `${N}google%20didn't%20connect`);
  assert.match(bad.body, />Back to Reason</);
});
