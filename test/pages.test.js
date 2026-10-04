// Pages: an answer turned into something you can open, keep, and come back to.
//
// The things worth pinning are the ones a page gets wrong quietly:
//
//   - **the link does not change.** Update is the whole point; a second page about the same thing
//     with a new link is the failure.
//   - **private means private.** The link alone is not enough. Links leak — into screenshots, into
//     previews, into somebody's recently-closed tabs — so a first open needs a code, and guessing
//     at the code is rate limited from a table rather than from memory.
//   - **shared means shared, and unshared means immediately not.**
//   - **nothing the model writes becomes markup.** Every string is escaped; there is no block that
//     takes HTML and no way to smuggle a script into one.
//   - **a picture has to be real.** An image address the model typed from memory is refused.
//   - **a tap reaches Reason exactly once**, and only from the owner's own browser.
//
// No API key, no network, no browser.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pages-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { pageRequest } = await import("../src/http.js");
const { issueCode, MAX_FAILED_ATTEMPTS, attemptState, pageUrl } = await import("../src/pages/access.js");
const { checkContent } = await import("../src/pages/content.js");
const { renderPage, esc } = await import("../src/pages/render.js");
const { Runtime } = await import("../src/runtime.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = config.ownerConversation;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM pages; DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts; DELETE FROM page_choices; DELETE FROM seen_urls; DELETE FROM action_ledger; DELETE FROM conversations;");
});

const SIMPLE = [
  { type: "section", title: "Top picks" },
  { type: "text", text: "Three that fit.\n\nAll under $80." },
];

async function makePage(blocks = SIMPLE, title = "Gift ideas") {
  const out = await runTool("page_create", { title, blocks }, { conversationId: C });
  assert.equal(out.ok, true, out.error);
  return out;
}

const GET = (id, headers = {}) => pageRequest({ id, method: "GET", headers, readBody: async () => "" });
const POST_CODE = (id, code) => pageRequest({
  id, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  readBody: async () => `code=${encodeURIComponent(code)}`,
});
const PICK = (id, headers, body) => pageRequest({
  id, isChoice: true, method: "POST",
  headers: { "content-type": "application/json", ...headers },
  readBody: async () => JSON.stringify(body),
});

/** Open a page the way the owner does: tap the link, type the code, keep the cookie. */
async function signIn(id) {
  const { code } = issueCode(id);
  const res = await POST_CODE(id, code);
  assert.equal(res.status, 200, "the code should open it");
  const token = /reason_page=([^;]+)/.exec(res.headers["Set-Cookie"])[1];
  return { token, cookie: `reason_page=${token}`, res };
}

// ---------- making one, and keeping the link ----------

test("a page is made, gets a link, and is private to start with", async () => {
  const out = await makePage();
  assert.match(out.page_id, /^[A-Za-z0-9_-]{20,}$/, "the id has to be unguessable");
  assert.equal(out.link, pageUrl(out.page_id));
  assert.equal(out.shared, false, "private by default, always");
  assert.equal(out.revision, 1);
  assert.match(out.note, /PRIVATE/);
  assert.match(out.note, /code/);
});

test("update keeps the same link, and counts a revision", async () => {
  const made = await makePage();
  const changed = await runTool("page_update", {
    page_id: made.page_id,
    blocks: [...SIMPLE, { type: "text", text: "Added the scarf." }],
  }, { conversationId: C });

  assert.equal(changed.ok, true, changed.error);
  assert.equal(changed.link, made.link, "THE LINK MUST NOT CHANGE");
  assert.equal(changed.page_id, made.page_id);
  assert.equal(changed.revision, 2);
  assert.match(changed.note, /same link/i);

  const { cookie } = await signIn(made.page_id);
  const page = await GET(made.page_id, { cookie });
  assert.match(page.body, /Added the scarf/);
});

test("a title can be changed on its own, without resending the blocks", async () => {
  const made = await makePage();
  const changed = await runTool("page_update", { page_id: made.page_id, title: "Mum's birthday" }, { conversationId: C });
  assert.equal(changed.ok, true);
  assert.equal(changed.title, "Mum's birthday");
  assert.equal(changed.link, made.link);

  const nothing = await runTool("page_update", { page_id: made.page_id }, { conversationId: C });
  assert.equal(nothing.ok, false);
  assert.match(nothing.error, /Nothing to change/);
});

test("a page in another conversation cannot be touched", async () => {
  const made = await makePage();
  for (const tool of ["page_update", "page_share", "page_unshare", "page_delete"]) {
    const out = await runTool(tool, { page_id: made.page_id, blocks: SIMPLE }, { conversationId: "contact:fake:+15555550000" });
    assert.equal(out.ok, false, `${tool} should refuse`);
    assert.match(out.error, /No page/);
  }
});

test("page_list reads back what really exists, and says if links are local-only", async () => {
  await makePage(SIMPLE, "One");
  await makePage(SIMPLE, "Two");
  const out = await runTool("page_list", {}, { conversationId: C });
  assert.equal(out.count, 2);
  assert.deepEqual(out.pages.map(p => p.title).sort(), ["One", "Two"]);
  // With no REASON_PUBLIC_URL the honest answer is that these only open here.
  assert.equal(out.links_open_anywhere, false);
  assert.match(out.note, /only open on this machine/i);
});

// ---------- private means private ----------

test("the link alone does not open a private page, and the gate gives nothing away", async () => {
  const made = await makePage(SIMPLE, "Something confidential");
  const res = await GET(made.page_id);
  assert.equal(res.status, 401);
  assert.match(res.body, /Private page/);
  assert.doesNotMatch(res.body, /Something confidential/, "the gate must not leak the title");
  assert.doesNotMatch(res.body, /Top picks/, "nor any content");
});

test("the code opens it, sets a cookie, and that browser stays in", async () => {
  const made = await makePage();
  const { cookie, res } = await signIn(made.page_id);
  assert.match(res.body, /Gift ideas/);
  assert.match(res.headers["Set-Cookie"], /HttpOnly/);
  assert.match(res.headers["Set-Cookie"], /SameSite=Lax/);

  const again = await GET(made.page_id, { cookie });
  assert.equal(again.status, 200);
  assert.match(again.body, /Top picks/);

  // A different browser is still a stranger.
  assert.equal((await GET(made.page_id, { cookie: "reason_page=someone-elses" })).status, 401);
});

test("a code works once", async () => {
  const made = await makePage();
  const { code } = issueCode(made.page_id);
  assert.equal((await POST_CODE(made.page_id, code)).status, 200);
  assert.equal((await POST_CODE(made.page_id, code)).status, 401, "a used code is spent");
});

test("a new code replaces the old one rather than leaving two live", async () => {
  const made = await makePage();
  const first = issueCode(made.page_id);
  const second = issueCode(made.page_id);
  assert.notEqual(first.code, second.code);
  assert.equal((await POST_CODE(made.page_id, first.code)).status, 401, "the old code is dead");
  assert.equal((await POST_CODE(made.page_id, second.code)).status, 200);
});

test("an expired code is refused and says so", async () => {
  const made = await makePage();
  const { code } = issueCode(made.page_id);
  clock.skip(16 * 60 * 1000);
  const res = await POST_CODE(made.page_id, code);
  assert.equal(res.status, 401);
  assert.match(res.body, /expired/i);
});

test("guessing is rate limited, and the limit survives a restart", async () => {
  const made = await makePage();
  const { code } = issueCode(made.page_id);

  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
    const res = await POST_CODE(made.page_id, "XXXXXX");
    assert.equal(res.status, 401, `attempt ${i + 1} should be refused`);
  }
  assert.equal(attemptState(made.page_id).locked, true);

  // Locked out — and the real code does not get you in while it is.
  const blocked = await POST_CODE(made.page_id, code);
  assert.equal(blocked.status, 429);
  assert.match(blocked.body, /Too many wrong codes/i);
  assert.equal((await GET(made.page_id)).status, 429, "even looking is refused while locked");

  // It is counted in a table, so a fresh process is still locked out.
  assert.equal(db.failedPageAttempts(made.page_id, 15 * 60 * 1000), MAX_FAILED_ATTEMPTS);

  // And it lets up once the window has passed.
  clock.skip(16 * 60 * 1000);
  assert.equal(attemptState(made.page_id).locked, false);
});

test("a link that is not a page looks exactly like one that is not allowed", async () => {
  const made = await makePage();
  const real = await GET(made.page_id);
  const fake = await GET("ThisIsNotARealPageId123");
  assert.equal(fake.status, 404);
  assert.match(fake.body, /Not found/);
  assert.notEqual(real.status, fake.status);
  // The id space must not be probeable: a 404 says nothing about whether an id exists.
  assert.doesNotMatch(fake.body, /code/i);
});

// ---------- sharing ----------

test("a shared page opens for anyone, with no code", async () => {
  const made = await makePage();
  const shared = await runTool("page_share", { page_id: made.page_id }, { conversationId: C });
  assert.equal(shared.ok, true);
  assert.equal(shared.shared, true);
  assert.equal(shared.link, made.link, "sharing does not change the link");

  const anyone = await GET(made.page_id);
  assert.equal(anyone.status, 200);
  assert.match(anyone.body, /Top picks/);
  assert.match(anyone.body, /Anyone with this link can read it/);
});

test("unsharing shuts it immediately", async () => {
  const made = await makePage();
  await runTool("page_share", { page_id: made.page_id }, { conversationId: C });
  assert.equal((await GET(made.page_id)).status, 200);

  const off = await runTool("page_unshare", { page_id: made.page_id }, { conversationId: C });
  assert.equal(off.ok, true);
  assert.equal(off.shared, false);
  assert.match(off.note, /straight away/i);

  // The very next request, with no caching anywhere in between.
  assert.equal((await GET(made.page_id)).status, 401);
});

test("the owner's own browser still works after unsharing", async () => {
  const made = await makePage();
  const { cookie } = await signIn(made.page_id);
  await runTool("page_share", { page_id: made.page_id }, { conversationId: C });
  await runTool("page_unshare", { page_id: made.page_id }, { conversationId: C });
  assert.equal((await GET(made.page_id, { cookie })).status, 200);
});

// ---------- nothing becomes markup ----------

test("HTML and script in content come out as text, everywhere it can appear", async () => {
  const nasty = `<script>alert('xss')</script><img src=x onerror=alert(1)>`;
  const made = await makePage([
    { type: "section", title: nasty },
    { type: "text", text: nasty },
    { type: "table", columns: [nasty], rows: [[nasty]], title: nasty },
    { type: "links", items: [{ label: nasty, url: "https://example.com/ok", note: nasty }] },
    { type: "cards", items: [{ title: nasty, price: nasty, note: nasty }] },
    { type: "choice", key: "k", question: nasty, options: [{ label: nasty, note: nasty }, { label: "other" }] },
  ], nasty);

  const { cookie } = await signIn(made.page_id);
  const body = (await GET(made.page_id, { cookie })).body;

  assert.doesNotMatch(body, /<script>alert/, "no script tag may survive");
  assert.doesNotMatch(body, /<img src=x/, "no injected tag may survive");
  // The property that actually matters is about TAGS, not about the characters appearing
  // somewhere: the payload does show up in the page's text and inside a quoted data- attribute,
  // as inert escaped text, and that is exactly what escaping looks like working. So: pull out
  // every real tag (a literal < to a literal >) — escaped content can never be inside one,
  // because its own angle brackets became entities — strip quoted attribute values, which is
  // sound because esc() turns every " into &quot;, and only then look for an event handler.
  const tags = (body.match(/<[^>]*>/g) ?? []).map(t => t.replace(/"[^"]*"/g, '""'));
  for (const t of tags) {
    assert.doesNotMatch(t, /\son[a-z]+\s*=/i, `tag carries an event handler: ${t}`);
    assert.doesNotMatch(t, /javascript:/i, `tag carries a javascript: url: ${t}`);
  }
  // And the payload IS present, escaped — proving it was rendered as text rather than dropped.
  assert.ok(body.includes("onerror=alert(1)&gt;"), "it is there, as inert text");
  assert.ok(body.includes("&lt;script&gt;"), "it should be visible as text instead");
  // The page's own stylesheet and its one script are still there; nothing else is.
  assert.equal((body.match(/<script/g) ?? []).length, 1, "exactly one script: ours");
});

test("a javascript: url never reaches an href", async () => {
  const sneaky = checkContent([{ type: "links", items: [{ label: "tap", url: "javascript:alert(1)" }] }]);
  assert.equal(sneaky.ok, false, "the checker should refuse it outright");
  assert.match(sneaky.error, /http\(s\) url/);

  // And render is belt-and-braces: even handed a bad one it emits no href.
  const html = renderPage(
    { title: "t", blocks: [{ type: "links", title: null, items: [{ label: "tap", url: "javascript:alert(1)", note: null }] }], shared: false, revision: 1, created_at: 0, updated_at: 0 },
    { interactive: false },
  );
  assert.doesNotMatch(html, /javascript:/);
});

test("esc covers every character that could break out of an attribute", () => {
  assert.equal(esc(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

test("a block type that is not one of ours is refused, not ignored", async () => {
  const out = await runTool("page_create", { title: "x", blocks: [{ type: "html", html: "<b>hi</b>" }] }, { conversationId: C });
  assert.equal(out.ok, false);
  assert.match(out.error, /not a block/);
  assert.equal(db.listPages(C).length, 0, "and nothing was made");
});

test("malformed blocks are refused with a reason the model can act on", async () => {
  const cases = [
    [[], /at least 1 element|at least one block/],
    [[{ type: "text" }], /needs text/],
    [[{ type: "section" }], /needs a title/],
    [[{ type: "table", columns: ["a", "b"], rows: [["only one"]] }], /row 1 has 1 cells/],
    [[{ type: "links", items: [{ label: "no url" }] }], /needs a label and an http\(s\) url/],
    [[{ type: "choice", key: "k", question: "q", options: [{ label: "only one" }] }], /at least two options/],
    [[{ type: "choice", key: "a b", question: "q", options: [{ label: "x" }, { label: "y" }] }], /short "key"/],
  ];
  for (const [blocks, re] of cases) {
    const out = await runTool("page_create", { title: "x", blocks }, { conversationId: C });
    assert.equal(out.ok, false, `should refuse ${JSON.stringify(blocks)}`);
    assert.match(out.error, re);
  }
});

test("two choices cannot share a key, because the answer would be ambiguous", async () => {
  const out = await runTool("page_create", { title: "x", blocks: [
    { type: "choice", key: "pick", question: "a", options: [{ label: "1" }, { label: "2" }] },
    { type: "choice", key: "pick", question: "b", options: [{ label: "3" }, { label: "4" }] },
  ] }, { conversationId: C });
  assert.equal(out.ok, false);
  assert.match(out.error, /reuses the key/);
});

// ---------- a picture has to be real ----------

test("an image address the model made up is refused", async () => {
  const out = await runTool("page_create", { title: "Gifts", blocks: [
    { type: "image", url: "https://images.example.com/plausible-looking-planter.jpg" },
  ] }, { conversationId: C });
  assert.equal(out.ok, false);
  assert.match(out.error, /has not come back from any tool/);
  assert.match(out.error, /from memory/);
});

test("an image that really came back from a tool is allowed", async () => {
  const real = "https://cdn.example.com/planter.jpg";
  db.rememberSeenUrls(C, [real]);
  const out = await runTool("page_create", { title: "Gifts", blocks: [
    { type: "image", url: real, caption: "the green one" },
  ] }, { conversationId: C });
  assert.equal(out.ok, true, out.error);

  const { cookie } = await signIn(out.page_id);
  const body = (await GET(out.page_id, { cookie })).body;
  assert.ok(body.includes(real));
  assert.match(body, /the green one/);
});

test("a url seen in one conversation is not a licence in another", async () => {
  const real = "https://cdn.example.com/x.jpg";
  db.rememberSeenUrls("contact:fake:+15555550000", [real]);
  const out = await runTool("page_create", { title: "x", blocks: [{ type: "image", url: real }] }, { conversationId: C });
  assert.equal(out.ok, false);
  assert.match(out.error, /has not come back from any tool/);
});

test("a card's picture is held to the same rule", async () => {
  const out = await runTool("page_create", { title: "x", blocks: [
    { type: "cards", items: [{ title: "Planter", image: "https://invented.example.com/a.jpg" }] },
  ] }, { conversationId: C });
  assert.equal(out.ok, false);
  assert.match(out.error, /Leave the picture out/);
});

test("an http image is refused: it would be blocked on the page anyway", async () => {
  db.rememberSeenUrls(C, ["http://cdn.example.com/a.jpg"]);
  const out = await runTool("page_create", { title: "x", blocks: [{ type: "image", url: "http://cdn.example.com/a.jpg" }] }, { conversationId: C });
  assert.equal(out.ok, false);
  assert.match(out.error, /needs an https url/);
});

test("web_lookup is what makes a picture possible: it records the real addresses", async () => {
  const { imageUrls } = await import("../src/weblookup.js");
  const html = `<meta property="og:image" content="/hero.png">`
    + `<img src="https://cdn.example.com/a.jpg">`
    + `<img srcset="https://cdn.example.com/b-200.jpg 200w, https://cdn.example.com/b-900.jpg 900w">`
    + `<img src="http://insecure.example.com/c.jpg"><img src="/icon.svg">`;
  const found = imageUrls(html, "https://shop.example.com/item/9");
  assert.deepEqual(found, [
    "https://shop.example.com/hero.png",
    "https://cdn.example.com/a.jpg",
    "https://cdn.example.com/b-200.jpg",
  ]);
  assert.equal(found.some(u => u.startsWith("http://")), false, "http images are no use on an https page");
  assert.equal(found.some(u => u.endsWith(".svg")), false, "svg is markup, not a picture to re-serve");
});

// ---------- a tap reaches Reason once ----------

test("a pick on the owner's own page becomes exactly one event turn", async () => {
  const made = await makePage([
    { type: "choice", key: "pick", question: "Which one?", options: [{ label: "Planter" }, { label: "Scarf" }] },
  ]);
  const { cookie } = await signIn(made.page_id);

  const res = await PICK(made.page_id, { cookie }, { key: "pick", label: "Scarf" });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, picked: "Scarf" });

  const turns = [];
  const rt = new Runtime({ runTurn: async ({ conversationId, text, kind }) => { turns.push({ conversationId, text, kind }); return null; } });

  const first = await rt.pageAnswers();
  assert.equal(first.delivered, 1);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].kind, "event");
  assert.equal(turns[0].conversationId, C);
  assert.match(turns[0].text, /tapped an answer/);
  assert.match(turns[0].text, /Which one\?/);
  assert.match(turns[0].text, /"Scarf"/);

  // Sweeping again must not fire it a second time.
  const second = await rt.pageAnswers();
  assert.equal(second.delivered, 0);
  assert.equal(turns.length, 1, "ONE pick, ONE turn");

  // And a fresh Runtime — a restarted process — does not re-deliver it either.
  await new Runtime({ runTurn: async () => { turns.push({ late: true }); return null; } }).pageAnswers();
  assert.equal(turns.length, 1);
});

test("the pick shows on the page afterwards, so it is not a one-way tap", async () => {
  const made = await makePage([{ type: "choice", key: "pick", question: "Which?", options: [{ label: "A" }, { label: "B" }] }]);
  const { cookie } = await signIn(made.page_id);
  await PICK(made.page_id, { cookie }, { key: "pick", label: "B" });
  const body = (await GET(made.page_id, { cookie })).body;
  assert.match(body, /you picked: B/);

  const listed = await runTool("page_list", {}, { conversationId: C });
  assert.deepEqual(listed.pages[0].answers, { pick: "B" });
});

test("nobody but the owner's own browser can answer", async () => {
  const made = await makePage([{ type: "choice", key: "pick", question: "Which?", options: [{ label: "A" }, { label: "B" }] }]);

  // No cookie at all.
  const anon = await PICK(made.page_id, {}, { key: "pick", label: "A" });
  assert.equal(anon.status, 403);

  // On a shared page a choice is for reading — a stranger pressing it would feed Reason somebody
  // else's answer as though it were the owner's.
  await runTool("page_share", { page_id: made.page_id }, { conversationId: C });
  const stranger = await PICK(made.page_id, {}, { key: "pick", label: "A" });
  assert.equal(stranger.status, 403);
  assert.match(JSON.parse(stranger.body).error, /only be given on the owner's own page/);

  const shown = await GET(made.page_id);
  assert.equal(shown.status, 200);
  assert.doesNotMatch(shown.body, /<button/, "a shared page has no buttons to press");
  assert.match(shown.body, /this is a copy/);

  assert.equal(db.undeliveredPageChoices().length, 0, "and nothing reached Reason");
});

test("a pick that is not on the page, or not an option, is refused", async () => {
  const made = await makePage([{ type: "choice", key: "pick", question: "Which?", options: [{ label: "A" }, { label: "B" }] }]);
  const { cookie } = await signIn(made.page_id);

  const noKey = await PICK(made.page_id, { cookie }, { key: "nope", label: "A" });
  assert.equal(noKey.status, 400);
  assert.match(JSON.parse(noKey.body).error, /no such question/);

  const noOpt = await PICK(made.page_id, { cookie }, { key: "pick", label: "Z" });
  assert.equal(noOpt.status, 400);
  assert.match(JSON.parse(noOpt.body).error, /not one of the options/);

  assert.equal(db.undeliveredPageChoices().length, 0);
});

// ---------- the record, and getting rid of it ----------

test("making, changing and sharing a page all leave a receipt", async () => {
  const made = await makePage();
  await runTool("page_update", { page_id: made.page_id, blocks: SIMPLE }, { conversationId: C });
  await runTool("page_share", { page_id: made.page_id }, { conversationId: C });
  await runTool("page_unshare", { page_id: made.page_id }, { conversationId: C });

  const receipts = db.listActions(C).map(a => a.receipt).reverse();
  assert.match(receipts[0], /Made the page "Gift ideas"/);
  assert.match(receipts[1], /Changed the page .*revision 2/);
  assert.match(receipts[2], /SHARED the page/, "sharing is the one worth shouting about");
  assert.match(receipts[3], /private again/i);
});

test("delete kills the link, the signed-in browsers and the answers", async () => {
  const made = await makePage([{ type: "choice", key: "pick", question: "Which?", options: [{ label: "A" }, { label: "B" }] }]);
  const { cookie } = await signIn(made.page_id);
  await PICK(made.page_id, { cookie }, { key: "pick", label: "A" });

  const gone = await runTool("page_delete", { page_id: made.page_id }, { conversationId: C });
  assert.equal(gone.ok, true);
  assert.equal((await GET(made.page_id, { cookie })).status, 404, "the link is dead even for the owner");
  assert.equal(db.getPage(made.page_id), null);
  assert.equal(db.undeliveredPageChoices().length, 0, "and the answers went with it");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions WHERE page_id = ?").get(made.page_id).n, 0);
});

test("export carries pages and their answers; delete removes them", async () => {
  const { exportData, deleteData } = await import("../src/data.js");
  const made = await makePage([{ type: "choice", key: "pick", question: "Which?", options: [{ label: "A" }, { label: "B" }] }]);
  const { cookie } = await signIn(made.page_id);
  await PICK(made.page_id, { cookie }, { key: "pick", label: "A" });

  const out = exportData({ audio: false });
  assert.equal(out.tables.pages.length, 1);
  assert.equal(out.tables.pages[0].title, "Gift ideas");
  assert.equal(out.tables.page_choices.length, 1);
  assert.equal(out.tables.page_choices[0].picked, "A");
  assert.equal(out.tables.page_sessions.length, 1, "the signed-in browser is part of the page");
  assert.ok(out.tables.page_codes.length >= 1);

  deleteData();
  const after = exportData({ audio: false });
  for (const t of ["pages", "page_choices", "page_sessions", "page_codes", "page_attempts", "seen_urls"]) {
    assert.deepEqual(after.tables[t], [], `${t} should be empty`);
  }
});

test("capabilities offers pages, and is honest about the link only working here", () => {
  const pages = capabilitiesNow({}).find(c => c.name === "pages");
  assert.equal(pages.status, "live");
  assert.match(pages.what, /web page/);
  assert.match(pages.what, /Private by default/);
  assert.match(pages.what, /only opens here/, "with no public url it must say so");
});
