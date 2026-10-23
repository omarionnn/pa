// Pages: an answer turned into something you can open, keep, and come back to.
//
// The things worth pinning are the ones a page gets wrong quietly:
//
//   - **the link does not change.** Update is the whole point; a second page about the same thing
//     with a new link is the failure.
//   - **the owner's link just opens.** Tapping the link Reason texted shows the page, first time,
//     with nothing to type — a code step nobody could finish was worse than no page.
//   - **private means private to everyone else.** The bare link, without the owner's key, does not
//     open a page — there is no sharing (removed 2026-10-23) — and guessing at the code is rate
//     limited from a table rather than from memory.
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
const { issueCode, MAX_FAILED_ATTEMPTS, attemptState, pageUrl, ownerUrl } = await import("../src/pages/access.js");
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

test("a link made before links were shortened still opens", async () => {
  const made = await makePage();
  const oldId = "AV0Vkvgy_JH33PfKMKQakvw_U-I";
  const oldKey = "q3_Zr8-LwX0aB7cD9eF1gH2iJ4kL6mN8";
  db.db.prepare("UPDATE pages SET id = ?, owner_key = ? WHERE id = ?").run(oldId, oldKey, made.page_id);
  const res = await pageRequest({ id: oldId, key: oldKey, method: "GET", headers: {}, readBody: async () => "" });
  assert.equal(res.status, 401, "a new browser is asked for the code first");
  assert.match(res.body, /name="send"/, "a link already sitting in a text thread must not go dead: the code is on offer");
  assert.doesNotMatch((await GET(oldId)).body, /name="send"/, "and its bare form offers nothing");
});

test("a page is made, gets a link, and is private to start with", async () => {
  const out = await makePage();
  assert.match(out.page_id, /^[A-Za-z0-9]{10}$/, "the id has to be unguessable, and short enough to text");
  assert.match(out.link, /\/p\/[A-Za-z0-9]{10}\?k=[A-Za-z0-9]{12}$/, "letters and digits only, so nothing is lost at the end of a link");
  assert.equal(out.link, ownerUrl(db.getPage(out.page_id)), "the link handed out is the owner's own, key and all");
  assert.ok(out.link.startsWith(pageUrl(out.page_id) + "?k="), "same page, plus the key");
  assert.equal(out.share_link, undefined, "no link for other people, ever");
  assert.equal(out.shared, undefined, "there is no sharing to report");
  assert.equal(out.revision, 1);
  assert.match(out.note, /opens when they tap it/);
  assert.match(out.note, /do not mention a code/, "Reason must not tell them to expect a code");
  assert.match(out.note, /texted a six-character code once/, "but it knows what the text was, for when they ask");
});

// ---------- the owner's link opens on a tap ----------

/** Fetch a link the way a phone does when it is tapped: the whole address, and no cookie yet. */
const TAP = (link, headers = {}) => {
  const u = new URL(link);
  return pageRequest({
    id: u.pathname.split("/")[2], key: u.searchParams.get("k"),
    method: "GET", headers, readBody: async () => "",
  });
};

/** What Reason texted while a test ran. The gate hands its line to runtime.say, like any line code decides to send. */
const said = [];
const runtime = { say: (conversationId, text) => said.push({ conversationId, text }) };

/** Press "Text me the code" on a link, the way the gate's form does. */
const SEND = (link, headers = {}) => {
  const u = new URL(link);
  return pageRequest({
    id: u.pathname.split("/")[2], key: u.searchParams.get("k"), method: "POST", runtime,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, readBody: async () => "send=1",
  });
};
const codeIn = (text) => /: ([A-Z2-9]{6})\./.exec(text)[1];

/** Open a page the way the owner does on a browser already proved: their link, with the cookie. */
const OPEN = async (page) => TAP(ownerUrl(page), { cookie: (await signIn(page.id)).cookie });

test("the owner's link on a browser that has never opened one of their pages: the gate, with the code on offer and nothing sent yet", async () => {
  said.length = 0;
  const made = await makePage();
  const res = await TAP(made.link);
  assert.equal(res.status, 401);
  assert.match(res.body, /<h1>Private page<\/h1>/, "the locked screen");
  assert.doesNotMatch(res.body, />Three that fit/, "and none of the page's words on it (the preview tag is the one place the opening line rides)");
  assert.match(res.body, /name="send"[^>]*>Text me the code/, "the button that texts the owner");
  assert.match(res.body, /name="code"/, "and the box for what it texts");
  assert.equal(res.headers["Set-Cookie"], undefined, "the key alone signs nobody in");
  assert.equal(said.length, 0, "a tap texts nothing: a link preview taps too");
  assert.match(res.body, /<meta property="og:title" content="Gift ideas">/, "the card under the owner's own text is still the page's");
});

test("pressing the button texts the owner a code; typing it signs that browser in to every page of theirs", async () => {
  said.length = 0;
  const made = await makePage([{ type: "choice", key: "pick", question: "Which?", options: [{ label: "A" }, { label: "B" }] }]);
  const asked = await SEND(made.link);
  assert.equal(asked.status, 401, "still locked until the code is typed");
  assert.match(asked.body, /Reason texted Omari a six-character code/);
  assert.match(asked.body, /Text it again/);
  assert.equal(said.length, 1, "one text");
  assert.equal(said[0].conversationId, C, "to the owner's own conversation, whoever is holding the link");
  assert.match(said[0].text, /Code to open "Gift ideas" on that browser: [A-Z2-9]{6}\. Good for 15 minutes\. If that wasn't you, ignore this/);

  const opened = await POST_CODE(made.page_id, codeIn(said[0].text));
  assert.equal(opened.status, 200);
  assert.match(opened.body, /Which\?/, "the page itself");
  const cookie = `reason_page=${/reason_page=([^;]+)/.exec(opened.headers["Set-Cookie"])[1]}`;

  assert.equal((await PICK(made.page_id, { cookie }, { key: "pick", label: "A" })).status, 200, "the taps on the page are theirs");
  assert.equal((await GET(made.page_id, { cookie })).status, 200, "coming back without the key, same browser");

  const another = await makePage(SIMPLE, "Another of theirs");
  assert.equal((await GET(another.page_id, { cookie })).status, 200, "a browser proved once is familiar on every page of theirs");
  const tapped = await TAP(another.link, { cookie });
  assert.equal(tapped.status, 200);
  assert.equal(tapped.headers["Set-Cookie"], undefined, "and is not signed in again");
  assert.equal(said.length, 1, "no second text");

  const theirs = await runTool("page_create", { title: "Somebody else's", blocks: SIMPLE }, { conversationId: "dm:someone-else" });
  assert.equal((await GET(theirs.page_id, { cookie })).status, 401, "familiar to one person is a stranger to another");
});

test("opening the owner's link again and again is harmless, as a link preview does", async () => {
  said.length = 0;
  const made = await makePage();
  const key = new URL(made.link).searchParams.get("k");
  await TAP(made.link);
  await TAP(made.link);
  const head = await pageRequest({ id: made.page_id, key, method: "HEAD", headers: {}, readBody: async () => "" });
  assert.equal(head.status, 401);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions").get().n, 0, "nothing signed in");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_codes").get().n, 0, "no code minted");
  assert.equal(said.length, 0, "nothing texted");
});

test("a bare link cannot ask for a code, so a stranger cannot make the owner's phone buzz", async () => {
  said.length = 0;
  const made = await makePage();
  const bare = await pageRequest({
    id: made.page_id, method: "POST", runtime,
    headers: { "content-type": "application/x-www-form-urlencoded" }, readBody: async () => "send=1",
  });
  assert.equal(bare.status, 401);
  assert.doesNotMatch(bare.body, /name="send"|Reason texted Omari/, "the plain gate: no button, no claim");
  const ghost = await SEND(`${pageUrl("ThisIsNotARealPageId123")}?k=${new URL(made.link).searchParams.get("k")}`);
  assert.equal(ghost.status, 401);
  assert.equal(ghost.body, bare.body, "an imaginary id with a key answers exactly as a real id without one");
  assert.equal(said.length, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_codes").get().n, 0);
});

test("a held link can have a code texted three times in the window, then has to wait", async () => {
  said.length = 0;
  const made = await makePage();
  for (let i = 0; i < 3; i++) assert.match((await SEND(made.link)).body, /Reason texted Omari/);
  assert.equal(said.length, 3);
  const fourth = await SEND(made.link);
  assert.match(fourth.body, /already texted Omari a code/);
  assert.equal(said.length, 3, "the fourth press sends nothing");
  assert.equal((await POST_CODE(made.page_id, codeIn(said[2].text))).status, 200, "the last code sent is the live one");
  clock.skip(16 * 60 * 1000);
  await SEND(made.link);
  assert.equal(said.length, 4, "the window passes and a code can be sent again");
});

test("a wrong key opens nothing, and neither does one page's key on another", async () => {
  const one = await makePage();
  const two = await makePage(SIMPLE, "Another");
  const wrong = await pageRequest({ id: one.page_id, key: "not-the-key", method: "GET", headers: {}, readBody: async () => "" });
  assert.equal(wrong.status, 401);
  assert.doesNotMatch(wrong.body, /Three that fit/);

  const crossed = await pageRequest({ id: one.page_id, key: new URL(two.link).searchParams.get("k"), method: "GET", headers: {}, readBody: async () => "" });
  assert.equal(crossed.status, 401, "a key is for one page");
  assert.doesNotMatch(crossed.body, /Three that fit/);
});

test("a page from before keys existed gets one, so its link offers the code too", async () => {
  const made = await makePage();
  db.db.prepare("UPDATE pages SET owner_key = NULL WHERE id = ?").run(made.page_id);
  const listed = await runTool("page_list", {}, { conversationId: C });
  const link = listed.pages[0].link;
  assert.match(link, /\?k=[A-Za-z0-9]{12}$/);
  assert.match((await TAP(link)).body, /name="send"/);
});

test("the locked screen does not claim a code was texted, because nothing texts one", async () => {
  const made = await makePage();
  const res = await GET(made.page_id);
  assert.equal(res.status, 401);
  assert.doesNotMatch(res.body, /has texted/);
  assert.match(res.body, /link Reason texted/);
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
  for (const tool of ["page_update", "page_delete"]) {
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

test("an expired code is refused, and refused the same way a wrong one is", async () => {
  const made = await makePage();
  const { code } = issueCode(made.page_id);
  clock.skip(16 * 60 * 1000);
  const res = await POST_CODE(made.page_id, code);
  assert.equal(res.status, 401);
  // It does NOT say "expired". A page with no live code and a page whose code was mistyped have to
  // answer identically, or the answer itself tells a guesser that the id is real and idle. The gate
  // already says where a code comes from, which is what the owner actually needs here.
  assert.doesNotMatch(res.body, /expired/i);
  // Against a first wrong attempt on a different page, so the "tries left" count is the same one:
  // the attempt counter is per id, and comparing a first try to a second would only measure that.
  const other = await makePage();
  assert.equal(res.body, (await POST_CODE(other.page_id, "AAAAAA")).body);
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
  const real = await GET(made.page_id);                     // a real private page, no key
  const fake = await GET("ThisIsNotARealPageId123");        // an id with nothing behind it

  // The id space must not be probeable. An id IS the authentication here — whoever holds the
  // owner's link can open the page — so "this one is real" is the one thing a guesser must not be
  // able to learn. Both answers are the code gate, byte for byte.
  assert.equal(real.status, 401);
  assert.equal(fake.status, 401);
  assert.equal(real.body, fake.body, "a real private page and an imaginary one are indistinguishable");
  assert.match(fake.body, /Private page/);
});

test("a wrong code says the same thing whether the page is real, private or imaginary", async () => {
  const made = await makePage();
  await issueCode(made.page_id);                            // a live code outstanding on a real page
  const other = await makePage();                           // a real page with no code outstanding

  const onLive = await POST_CODE(made.page_id, "AAAAAA");
  const onBare = await POST_CODE(other.page_id, "AAAAAA");
  const onFake = await POST_CODE("ThisIsNotARealPageId123", "AAAAAA");

  // "That code has expired" used to mean "no code outstanding", which told a guesser the id was
  // real and idle. One answer now, for all three.
  assert.equal(onLive.status, 401);
  assert.equal(onBare.status, 401);
  assert.equal(onFake.status, 401);
  assert.equal(onLive.body, onBare.body);
  assert.equal(onLive.body, onFake.body);
  assert.doesNotMatch(onFake.body, /expired/i);
});

test("guessing at an id that does not exist is rate limited exactly like a real page", async () => {
  const fake = "ThisIsNotARealPageId123";
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
    assert.equal((await POST_CODE(fake, "AAAAAA")).status, 401);
  }
  // Counted in the table, against the id that was guessed — so a guesser cannot tell a real page
  // (which locks) from an imaginary one (which used to never lock) by hammering it.
  const locked = await POST_CODE(fake, "AAAAAA");
  assert.equal(locked.status, 429);
  assert.match(locked.body, /Too many wrong codes/);
  assert.equal((await GET(fake)).status, 429, "and the plain link is locked too, as on a real page");
});

// ---------- the card a phone may draw for the link ----------

/** Every og: / twitter: tag in a response, as "name = content". */
const previewTags = (html) =>
  Object.fromEntries([...html.matchAll(/<meta (?:property|name)="((?:og|twitter):[^"]+)" content="([^"]*)"/g)]
    .map(m => [m[1], m[2]]));

test("the owner's own link carries what a preview card is built from", async () => {
  const made = await makePage([
    { type: "text", text: "Train back twice a week: one width day, one thickness day.\n\nTake your sets close to failure." },
    { type: "section", title: "Width day" },
  ], "Build a bigger back");
  const res = await pageRequest({
    id: made.page_id, key: new URL(made.link).searchParams.get("k"),
    method: "GET", headers: {}, readBody: async () => "",
  });
  // The fetcher drawing the card has no cookie, so it is reading the gate — which, for a request
  // carrying the owner's key, carries the page's tags. The card under the owner's own text stays.
  assert.equal(res.status, 401);

  const tags = previewTags(res.body);
  assert.equal(tags["og:title"], "Build a bigger back");
  assert.equal(tags["og:site_name"], "Reason");
  // Large, because since 2026-10-06 there is a picture to show (test/contact.test.js has the picture).
  assert.equal(tags["twitter:card"], "summary_large_image");
  assert.match(tags["og:image"], new RegExp(`/p/${made.page_id}/card\\.png\\?`));
  // The description is the page's own opening words, flattened to one line.
  assert.match(tags["og:description"], /^Train back twice a week/);
  assert.ok(!tags["og:description"].includes("\n"), "one line, not the paragraph breaks");
  assert.ok(tags["og:description"].length <= 160, `${tags["og:description"].length} chars is too long for a card`);
  // No og:url: writing one means either baking the key into a meta tag or publishing a keyless
  // address whose card leads to the gate.
  assert.equal(tags["og:url"], undefined);
});

test("a long opening paragraph is cut on a word and says it was cut", async () => {
  const long = `${"Grind your beans fresh every single morning without fail. ".repeat(6)}`;
  const made = await makePage([{ type: "text", text: long }], "Coffee");
  const res = await pageRequest({
    id: made.page_id, key: new URL(made.link).searchParams.get("k"),
    method: "GET", headers: {}, readBody: async () => "",
  });
  const d = previewTags(res.body)["og:description"];
  assert.ok(d.length <= 160, `${d.length} chars`);
  assert.match(d, /…$/, "a cut description should say so");
  assert.doesNotMatch(d, /\s…$/, "cut on the word, with no stranded space");
});

test("the gate and the not-found page give a preview away no more than they give a code away", async () => {
  // This is the one that matters. A tag on either would turn a link preview into a way to ask
  // "is this id real?" and read the answer off the title.
  const made = await makePage([{ type: "text", text: "Secret present ideas for Kofi." }], "Kofi's present");
  const gate = await GET(made.page_id);
  assert.equal(gate.status, 401);
  assert.deepEqual(previewTags(gate.body), {}, "the gate must build no card");
  assert.doesNotMatch(gate.body, /Kofi/, "and must not leak the title or the content either");

  const missing = await GET("ThisIsNotARealPageId123");
  assert.deepEqual(previewTags(missing.body), {}, "and neither does a page that does not exist");
});

test("a title with HTML in it is escaped inside a meta tag, not just in the body", async () => {
  const made = await makePage([{ type: "text", text: `He said "hi" & left <b>fast</b>.` }], `Kofi's "big" <plan> & more`);
  const res = await pageRequest({
    id: made.page_id, key: new URL(made.link).searchParams.get("k"),
    method: "GET", headers: {}, readBody: async () => "",
  });
  // A raw quote here would end the content attribute and put page text into the markup.
  assert.match(res.body, /<meta property="og:title" content="[^"]*&quot;big&quot;[^"]*"/);
  assert.doesNotMatch(res.body, /content="[^"]*<b>/);
  const tags = previewTags(res.body);
  assert.ok(!/<b>/.test(tags["og:description"] ?? ""), "no raw tags in the description");
});

// ---------- sharing ----------

test("the owner's own browser still works after unsharing", async () => {
  const made = await makePage();
  const { cookie } = await signIn(made.page_id);
  await runTool("page_share", { page_id: made.page_id }, { conversationId: C });
  await runTool("page_unshare", { page_id: made.page_id }, { conversationId: C });
  assert.equal((await GET(made.page_id, { cookie })).status, 200);
});

// ---------- pages that link to each other ----------
// A page they keep is a page they come back to, and until this every one of them was a dead end:
// the only route from one to another was scrolling a text thread for the older link. The foot of a
// page now carries the few other pages of theirs it is really about.
//
// Three things worth pinning, in this order:
//
//   - **only ever their own pages.** The list is scoped to the page's own conversation, and the
//     links carry owner keys, so the section is drawn on the owner's own view and on no other.
//   - **only when there is really a match.** Everything linking to everything is a footer, not a
//     way through: an unrelated page gets no section at all.
//   - **the link opens on a tap**, the same owner link Reason texts, because a keyless link to a
//     private page lands on the code gate.

/** A page straight into the table, so a test can give one a conversation and a time of its own. */
function pageFor(conversationId, title, { skipMs = 0 } = {}) {
  if (skipMs) clock.skip(skipMs);
  return db.createPage(conversationId, { title, blocks: SIMPLE });
}

/** The titles the Related section at the foot of this HTML links to, in the order they are drawn. */
function relatedTitles(html) {
  const tail = /<nav class="rel"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
  if (!tail) return [];
  return [...tail[1].matchAll(/<li><a href="[^"]*">([^<]*)<\/a>/g)].map(m => m[1]);
}

test("a page links to the other pages of theirs it is about, by the link that just opens", async () => {
  const coffee = pageFor(C, "Coffee at home");
  const grinder = pageFor(C, "Coffee grinder picks", { skipMs: 1000 });

  const res = await OPEN(coffee);
  assert.equal(res.status, 200);
  assert.deepEqual(relatedTitles(res.body), ["Coffee grinder picks"], "the other page about coffee");
  assert.ok(res.body.includes(`href="${ownerUrl(db.getPage(grinder.id))}"`),
    "the owner's own link, key and all — a keyless one would land them on the code gate");
  assert.match(res.body, /Other pages of yours on this/, "said in words, not just drawn");
  assert.doesNotMatch(/<nav class="rel"[^>]*>[\s\S]*?<\/nav>/.exec(res.body)[0], /target="_blank"/,
    "their own page opens in the same tab, so back means back");
});

test("a page with nothing in common is not linked, and draws no Related at all", async () => {
  const coffee = pageFor(C, "Coffee at home");
  pageFor(C, "Somewhere to eat in Accra", { skipMs: 1000 });

  const res = await OPEN(coffee);
  assert.deepEqual(relatedTitles(res.body), [], "two unrelated pages are two unrelated pages");
  assert.doesNotMatch(res.body, /class="rel"/, "no heading, no rule, nothing — not an empty section");
});

test("one vague word in common is not a link; a real one is", () => {
  const ideas = pageFor(C, "Gift ideas");
  pageFor(C, "Weekend ideas", { skipMs: 1000 });
  assert.deepEqual(db.relatedPages(C, ideas.id), [],
    "two lists that happen to both be lists are not two pages about one thing");

  pageFor(C, "Gift ideas for Mum", { skipMs: 1000 });
  assert.deepEqual(db.relatedPages(C, ideas.id).map(p => p.title), ["Gift ideas for Mum"],
    "\"gift\" is what they are both about");
});

test("the closest page comes first, and the list is capped", () => {
  const home = pageFor(C, "Coffee at home");
  pageFor(C, "Coffee grinder", { skipMs: 1000 });
  pageFor(C, "Coffee beans", { skipMs: 1000 });
  pageFor(C, "Coffee water ratio", { skipMs: 1000 });
  const both = pageFor(C, "Coffee at home, the short version", { skipMs: 1000 });

  const got = db.relatedPages(C, home.id);
  assert.equal(got.length, db.RELATED_MAX, "three is a way through; a dozen is a sitemap");
  assert.equal(got[0].id, both.id, "two words in common beats one");
  assert.equal(got[1].title, "Coffee water ratio", "then the one touched most recently");
});

test("another person's page is never related, however alike the titles are", async () => {
  const mine = pageFor(C, "Coffee at home");
  const theirs = pageFor("dm:someone-else", "Coffee at home");

  assert.deepEqual(db.relatedPages(C, mine.id), [], "same words, somebody else's conversation");
  assert.deepEqual(db.relatedPages("dm:someone-else", mine.id), [],
    "and asking for it under their conversation does not build the list either");

  const res = await OPEN(mine);
  assert.ok(!res.body.includes(theirs.id), "their page's id is not in the HTML");
  assert.ok(!res.body.includes(db.getPage(theirs.id).owner_key), "and neither is their key");
});

test("a printed document carries no links to other pages", () => {
  pageFor(C, "Coffee grinder picks");
  const coffee = pageFor(C, "Coffee at home", { skipMs: 1000 });
  const printed = renderPage(db.getPage(coffee.id), {
    interactive: true, related: db.relatedPages(C, coffee.id), printing: true,
  });
  assert.doesNotMatch(printed, /class="rel"/, "on paper there is nothing to tap");
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
    { type: "copy", label: nasty.slice(0, 40), filename: nasty, text: nasty },
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
  // The page's own stylesheet and its own scripts are still there — the opening moment's two and
  // the choice handler folded into the second — and nothing else is.
  assert.equal((body.match(/<script/g) ?? []).length, 2, "exactly two scripts: ours");
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

// ---------- something to take away: the copy block ----------

test("a copy block is checked: a label, the text, a sane size, a sanitised filename", async () => {
  const { safeFilename } = await import("../src/pages/content.js");
  const cases = [
    [[{ type: "copy", text: "x" }], /needs a short "label"/],
    [[{ type: "copy", label: "prompt" }], /needs "text"/],
    [[{ type: "copy", label: "prompt", text: "   " }], /needs "text"/],
    [[{ type: "copy", label: "prompt", text: "x".repeat(20001) }], /20001 characters.*most is 20000/],
    [[{ type: "copy", label: "p".repeat(41), text: "x" }], /under 40 characters/],
    [[{ type: "copy", label: "prompt", text: "x", filename: 7 }], /filename that is not a string/],
  ];
  for (const [blocks, re] of cases) {
    const out = checkContent(blocks);
    assert.equal(out.ok, false, `should refuse ${JSON.stringify(blocks).slice(0, 80)}`);
    assert.match(out.error, re);
  }

  const ok = checkContent([
    { type: "copy", label: "prompt", text: "line one\r\nline two\n" },
    { type: "copy", label: "cover letter", text: "x" },
    { type: "copy", label: "bio", filename: "My Bio v2.txt", text: "y" },
    { type: "copy", label: "p", filename: "../../etc/passwd", text: "z" },
    { type: "copy", label: "p", filename: "....", text: "z" },
  ]);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.blocks.map(b => b.filename), ["prompt.txt", "cover-letter.txt", "My-Bio-v2.txt", "etc-passwd.txt", "p.txt"]);
  assert.equal(ok.blocks[0].text, "line one\nline two", "line endings normalised, inner breaks kept, outer whitespace dropped");
  assert.equal(safeFilename("", "prompt"), "prompt.txt");
  assert.equal(safeFilename("a".repeat(200), "x").length, 84, "cut to the limit, plus .txt");
  assert.equal(safeFilename("///", "///"), null);
});

test("a copy block draws the two buttons, the text, and an empty status line", async () => {
  const text = `Plan a <3-day> trip.\n  - keep it "cheap" & fun`;
  const made = await makePage([{ type: "copy", label: "prompt", text }]);
  const { cookie } = await signIn(made.page_id);
  const body = (await GET(made.page_id, { cookie })).body;

  assert.match(body, /<button type="button" class="cp" data-done="Prompt copied\.">Copy full prompt<\/button>/);
  assert.match(body, /<a class="dl" href="data:text\/plain;charset=utf-8,[^"]+" download="prompt\.txt">Download \.txt<\/a>/);
  assert.match(body, /<pre>Plan a &lt;3-day&gt; trip\.\n  - keep it &quot;cheap&quot; &amp; fun<\/pre>/, "escaped, whitespace intact");
  assert.match(body, /<div class="copied" aria-live="polite"><\/div>/);
  // The download link carries the exact text, percent-encoded, with no markup in it.
  const href = /href="(data:[^"]+)"/.exec(body)[1];
  assert.equal(decodeURIComponent(href.replace(/^data:text\/plain;charset=utf-8,/, "")), text);
  assert.doesNotMatch(href, /[<>]/);
  // And it brings its own script and styles: the opening moment's two script tags and no third,
  // the copy handler riding in the second.
  assert.equal((body.match(/<script/g) ?? []).length, 2);
  assert.match(body, /navigator\.clipboard/);
  assert.match(body, /execCommand\('copy'\)/, "the fallback for older iOS Safari");
  assert.match(body, /\.cp,\.dl\{/, "the copy styles are on the page");
});

test("a page with no copy block is drawn with none of the copy block's script or styles", async () => {
  const made = await makePage();
  const { cookie } = await signIn(made.page_id);
  const body = (await GET(made.page_id, { cookie })).body;
  assert.equal((body.match(/<script/g) ?? []).length, 2, "the opening moment's two tags and nothing else");
  // The share toggle uses fetch and clipboard on the owner's interactive view, but the copy block's
  // own scripts (execCommand fallback, markOverflow) should not be present without a copy block.
  assert.doesNotMatch(body, /execCommand/, "no copy-block clipboard fallback");
  assert.doesNotMatch(body, /\.cp,\.dl/, "no copy styles");
  assert.doesNotMatch(body, /class="copy"/);
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

  // The bare link opens nothing for a stranger, so there is nothing for them to press either.
  assert.equal((await GET(made.page_id)).status, 401);

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

test("making and changing a page both leave a receipt; there is no tool to share one", async () => {
  const made = await makePage();
  await runTool("page_update", { page_id: made.page_id, blocks: SIMPLE }, { conversationId: C });

  const receipts = db.listActions(C).map(a => a.receipt).reverse();
  assert.match(receipts[0], /Made the page "Gift ideas"/);
  assert.match(receipts[1], /Changed the page .*revision 2/);
  const tried = await runTool("page_share", { page_id: made.page_id }, { conversationId: C });
  assert.notEqual(tried.ok, true, "sharing was removed: there is no such tool");
  assert.ok(!db.getPage(made.page_id).shared, "and the page is still only theirs");
});

test("delete kills the link, the signed-in browsers and the answers", async () => {
  const made = await makePage([{ type: "choice", key: "pick", question: "Which?", options: [{ label: "A" }, { label: "B" }] }]);
  const { cookie } = await signIn(made.page_id);
  await PICK(made.page_id, { cookie }, { key: "pick", label: "A" });

  const gone = await runTool("page_delete", { page_id: made.page_id }, { conversationId: C });
  assert.equal(gone.ok, true);
  // Dead even for the owner, and dead in the way a page that never existed is dead: the code gate,
  // not "Not found". The cookie that used to open it is gone with the row, and a deleted id has to
  // be indistinguishable from an imaginary one — saying "this one is deleted" would say "this one
  // was real". The cost is that the owner's own stale link shows a code prompt rather than telling
  // them it is gone; Reason saying so in the thread is the right place for that.
  const after = await GET(made.page_id, { cookie });
  assert.equal(after.status, 401, "the link is dead even for the owner");
  assert.equal(after.body, (await GET("ThisIsNotARealPageId123")).body, "and dead like an id that never was");
  assert.equal(db.getPage(made.page_id), null);
  assert.equal(db.undeliveredPageChoices().length, 0, "and the answers went with it");
  // The browser was proved to the person, not to the page, so it is still signed in to the rest.
  const other = await makePage();
  assert.equal((await GET(other.page_id, { cookie })).status, 200, "deleting one page does not sign the browser out of their others");
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

  await deleteData();
  const after = exportData({ audio: false });
  for (const t of ["pages", "page_choices", "page_sessions", "page_codes", "page_attempts", "seen_urls"]) {
    assert.deepEqual(after.tables[t], [], `${t} should be empty`);
  }
});

test("capabilities offers pages, and is honest about the link only working here", () => {
  const pages = capabilitiesNow({}).find(c => c.name === "pages");
  assert.equal(pages.status, "live");
  assert.match(pages.what, /web page/);
  assert.match(pages.what, /opens it on a tap/);
  assert.match(pages.what, /a new browser is texted a six-character code once/, "the one time a code is part of the story");
  assert.match(pages.what, /only opens here/, "with no public url it must say so");
});

// ---------- whose page it is ----------

test("the top line says who the page was made for, and 'you' only when no name is known", async () => {
  const { madeFor, renderPage } = await import("../src/pages/render.js");
  assert.equal(madeFor("Kofi Mensah"), "Made for Kofi", "first name only");
  assert.equal(madeFor(""), "Made for you");
  assert.equal(madeFor("the person I work for"), "Made for you", "the placeholder is not a name");
  const page = { title: "t", blocks: [], revision: 1, shared: false, created_at: Date.now(), updated_at: Date.now() };
  assert.match(renderPage(page, { forName: "Ama" }), /Made for Ama · /);
  assert.match(renderPage(page, {}), /Made for you · /);
  assert.match(renderPage(page, { forName: "<b>x</b>" }), /Made for &lt;b&gt;x&lt;\/b&gt; · /, "a name is escaped like everything else");
  assert.doesNotMatch(renderPage(page, {}), /Put together/, "the old kicker is gone");
  assert.doesNotMatch(renderPage(page, { forName: "Ama" }), /class="say"/, "no language, no hover: just the words");
});

// Omari, 2026-10-06: the top line in the reader's own language, "Omari dea", with the English a
// hover or a tap away.
test("with a language the top line is written in it, and the English sits behind a hover or a tap", async () => {
  const { topLine, renderPage } = await import("../src/pages/render.js");
  assert.deepEqual(topLine("Omari Nyarko", "twi"), { text: "Omari dea", english: "Made for Omari", language: "Twi" }, "first name, then the Twi 'own'");
  assert.deepEqual(topLine("", "twi"), { text: "Wo dea", english: "Made for you", language: "Twi" }, "no name: 'yours'");
  assert.equal(topLine("Omari", ""), null, "no language: English, nothing to reveal");
  assert.equal(topLine("Omari", "klingon"), null, "a language nobody has written the words for is not guessed at");
  assert.equal(topLine("Omari", "TWI")?.text, "Omari dea", "however it was spelled");

  const page = { title: "t", blocks: [], revision: 1, shared: false, created_at: Date.now(), updated_at: Date.now() };
  const html = renderPage(page, { forName: "Omari", language: "twi" });
  assert.match(html, /<button class="say" type="button" aria-label="Omari dea — Twi for Made for Omari"><span class="s1">Omari dea<\/span><span class="s2" aria-hidden="true">Made for Omari<\/span><\/button> · /,
    "the Twi is what is shown; the English is in the same place, hidden until asked for");
  assert.match(html, /\.say\.on \.s2\{opacity:1\}/, "the reveal is a style the script flips");
  assert.match(html, /pointerenter/, "a pointer resting on it reveals the English");
  assert.match(html, /addEventListener\('click'/, "and so does a tap, where there is no pointer");
  assert.doesNotMatch(html, /title="Made for/, "no native tooltip doubling the fade on a laptop");

  const plain = renderPage(page, { forName: "Omari", language: "klingon" });
  assert.match(plain, /Made for Omari · /);
  assert.doesNotMatch(plain, /class="say"|pointerenter/, "an unknown language draws the page exactly as before");

  const unsafe = renderPage(page, { forName: "<b>x</b>", language: "twi" });
  assert.match(unsafe, /&lt;b&gt;x&lt;\/b&gt; dea/, "a name is escaped in the Twi line too");
});

