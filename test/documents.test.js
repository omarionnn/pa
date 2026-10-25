// Documents: a real file Reason wrote, and handed over.
//
// The competitor's capability list said "drafts, guides, documents and presentations"; Reason could
// not produce a Word document, a deck or a PDF at all. The things worth pinning are the ones a file
// gets wrong quietly, because nobody sees a file until they open it:
//
//   - **the file is real.** A .docx and a .pptx are read back out of the zip and the title is in the
//     XML; the PDF starts with %PDF-. A row claiming a document that is not on disk is the failure.
//   - **it is only "sent" when a channel took it.** Every other state — a thread that cannot carry
//     an attachment, a failed upload, a queued retry — comes back sent:false with the honest
//     sentence, and `sent` in the list stays false. Reason sends first and claims second.
//   - **the attachment really is the attachment.** The fake channel gets one message carrying the
//     text AND the file, with the right mime type and filename, not two things near each other.
//   - **a document to somebody else goes through the gate**, exactly like a text to that person,
//     and nothing leaves while it is refused.
//   - **the blocks are the page's blocks.** One answer becomes a page or a document. A tappable
//     question is refused by name, and so is a picture in a .docx — a file with a hole in it is
//     worse than a refusal.
//   - **export carries the bytes and delete unlinks them.** A document left in data/documents/
//     after a delete is the half-kept promise src/data.js exists to prevent.
//
// No API key, no network, no browser: the PDF path is proved by injecting a renderer, and the one
// real print is in test/flow-documents.test.js and on the page-picture path that already has
// Chromium. The .docx and .pptx here are the real packages writing real files.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "reason-documents-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DOCUMENT_ROOT = join(dir, "documents");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.ts.net";
// Not an undo-window test: a document to a third party is held for 30 seconds like a text, which
// would make every send in here come back 'held'. Off by default; the one test that is about the
// window turns it back on.
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_BURST_QUIET_MS = "0";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { documentRequest } = await import("../src/http.js");
const { checkDocument, DOCUMENT_KINDS } = await import("../src/documents/content.js");
const { renderDocx } = await import("../src/documents/docx.js");
const { renderPptx, MAX_LINES } = await import("../src/documents/pptx.js");
const { printableHtml } = await import("../src/documents/print.js");
const { documentFilename, mimeForKind } = await import("../src/documents/store.js");
const { exportData, deleteData } = await import("../src/data.js");
const { sweepRetention } = await import("../src/privacy.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = config.ownerConversation;
const OWNER = "+12025551234";
const FRIEND = "+14155559876";

const BLOCKS = [
  { type: "section", title: "The short version" },
  { type: "steps", items: ["Two sessions a week", "One for width, one for thickness"] },
  { type: "text", text: "Stay at a weight until you hit the top of the range.\n\nThen add the smallest jump you can." },
  { type: "rows", title: "The plan", items: [{ name: "Day one", detail: "Pull-ups, rows", value: "4 sets" }] },
  { type: "table", title: "Where to eat", columns: ["Place", "Cost"], rows: [["Time Out", "$25"]] },
  { type: "links", title: "Sources", items: [{ label: "Stronger by Science", url: "https://strongerbyscience.com" }] },
  { type: "callout", title: "Heads up", text: "You said your knee is fine.", tone: "note" },
];

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.undoWindowSeconds = 0;
  db.db.exec("DELETE FROM documents; DELETE FROM pages; DELETE FROM seen_urls; DELETE FROM action_ledger; DELETE FROM confirmations;"
    + " DELETE FROM conversations; DELETE FROM threads; DELETE FROM accounts; DELETE FROM important_people; DELETE FROM held_actions; DELETE FROM outbox;");
  rmSync(join(dir, "documents"), { recursive: true, force: true });
});

/** A router with one fake channel, and the thread a reply would go back into. */
function harness({ media = true, mediaFailWith = null, console: useConsole = false } = {}) {
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime });
  const fake = useConsole
    ? router.register(new ConsoleChannel({ write: () => {} }))
    : router.register(new FakeChannel({ media, mediaFailWith }));
  db.upsertThread({ conversationId: C, channel: fake.name, address: OWNER, chatId: "chat-1", service: "iMessage" });
  return { runtime, router, fake };
}

const ctx = (router, extra = {}) => ({ conversationId: C, channels: router, ...extra });

/** A renderer that needs nothing on the machine, for the paths that are not about the bytes. */
const fakeRender = async ({ kind, title }) => Buffer.from(kind === "pdf" ? `%PDF-1.4 ${title}` : `PK\u0003\u0004 ${title}`);

async function make(router, input = {}, extra = {}) {
  return await runTool("document_create", {
    kind: "docx", title: "Back and shoulders", subtitle: "Two sessions a week", closing: "Start easy.",
    blocks: BLOCKS, say: "made u the doc", ...input,
  }, ctx(router, { renderDocument: fakeRender, ...extra }));
}

// ---------- what a document may contain ----------

test("a document takes the same blocks a page takes", () => {
  const checked = checkDocument(BLOCKS, { kind: "docx" });
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.blocks.length, BLOCKS.length, "every block survives");
  // And the same normalising: a '1.' the model typed in front of a step is taken off once.
  const steps = checkDocument([{ type: "steps", items: ["1. first", "2. second"] }], { kind: "pdf" });
  assert.deepEqual(steps.blocks[0].items, ["first", "second"]);
});

test("a tappable question is refused by name — there is nothing to tap in a file", () => {
  const out = checkDocument([
    { type: "text", text: "two options" },
    { type: "choice", key: "when", question: "Which day?", options: ["Fri", "Sat"] },
  ], { kind: "docx" });
  assert.equal(out.ok, false);
  assert.match(out.error, /block 2/);
  assert.match(out.error, /choice/);
  assert.match(out.error, /page_create/, "it says where that block does belong");
});

test("a picture is refused in a .docx and a .pptx, and allowed in the pdf", () => {
  const url = "https://pics.example.com/rack.jpg";
  const seenUrl = (u) => u === url;
  const blocks = [{ type: "image", url, caption: "the rack" }];
  for (const kind of ["docx", "pptx"]) {
    const out = checkDocument(blocks, { kind, seenUrl });
    assert.equal(out.ok, false, `${kind} must refuse a picture`);
    assert.match(out.error, /carries no pictures/);
    assert.match(out.error, /pdf/, "it names the kind that can");
  }
  assert.equal(checkDocument(blocks, { kind: "pdf", seenUrl }).ok, true, "the pdf is the page printed, so it carries it");
  // The real-picture rule is the page's, unchanged: an address the model typed is still refused.
  const invented = checkDocument(blocks, { kind: "pdf", seenUrl: () => false });
  assert.equal(invented.ok, false);
  assert.match(invented.error, /has not come back from any tool/);
});

test("a kind Reason does not write is refused, and the three it does are the three it says", () => {
  assert.deepEqual(DOCUMENT_KINDS, ["docx", "pptx", "pdf"]);
  assert.equal(checkDocument(BLOCKS, { kind: "rtf" }).ok, false);
});

// ---------- the files themselves ----------

test("the .docx is a real Word file with the title and the content in it", async () => {
  const bytes = await renderDocx({ title: "Back and shoulders", subtitle: "Two sessions a week", closing: "Start easy.", blocks: BLOCKS, forName: "Omari", when: "Oct 7" });
  const file = join(dir, "probe.docx");
  rmSync(file, { force: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, bytes);
  assert.equal(bytes.toString("latin1", 0, 2), "PK", "a .docx is a zip");
  // Read back out of the zip, not trusted: the only proof a document has its content in it.
  const xml = execFileSync("unzip", ["-p", file, "word/document.xml"], { encoding: "utf8", maxBuffer: 4e6 });
  assert.match(xml, /Back and shoulders/);
  assert.match(xml, /Two sessions a week/);
  assert.match(xml, /Time Out/, "the table cells are in it");
  assert.match(xml, /Start easy\./);
  // A real hyperlink rather than the text of one.
  const rels = execFileSync("unzip", ["-p", file, "word/_rels/document.xml.rels"], { encoding: "utf8", maxBuffer: 4e6 });
  assert.match(rels, /strongerbyscience\.com/);
});

test("the .pptx is a real deck, a slide per section, and long lists continue rather than run off", async () => {
  const many = Array.from({ length: MAX_LINES + 3 }, (_, i) => ({ name: `Day ${i + 1}`, value: "4 sets" }));
  const bytes = await renderPptx({
    title: "Back and shoulders", subtitle: "Two sessions a week", blocks: [
      { type: "section", title: "The short version" },
      { type: "steps", items: ["Width", "Thickness"] },
      { type: "section", title: "The plan" },
      { type: "rows", title: null, numbered: true, items: many },
    ],
    forName: "Omari", when: "Oct 7",
  });
  const file = join(dir, "probe.pptx");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, bytes);
  assert.equal(bytes.toString("latin1", 0, 2), "PK");
  const listing = execFileSync("unzip", ["-l", file], { encoding: "utf8", maxBuffer: 4e6 });
  const slides = [...listing.matchAll(/ppt\/slides\/slide(\d+)\.xml\b/g)].map(m => Number(m[1]));
  // Title, "The short version", "The plan", and at least one continuation for the overflow.
  assert.ok(Math.max(...slides) >= 4, `expected 4 or more slides, got ${Math.max(...slides)}`);
  const text = (n) => execFileSync("unzip", ["-p", file, `ppt/slides/slide${n}.xml`], { encoding: "utf8", maxBuffer: 4e6 });
  assert.match(text(1), /Back and shoulders/, "the first slide is the title");
  assert.match(text(2), /The short version/, "a section starts a slide");
  assert.match(text(4), /cont\./, "the overflow says it is a continuation rather than vanishing");
  assert.match(text(4), new RegExp(`Day ${MAX_LINES + 1}`), "and it carries the rows that did not fit");
});

test("the pdf is the page itself: the same renderer, printing, with no animation and no link tags", () => {
  const html = printableHtml({ title: "Back and shoulders", subtitle: "Two a week", closing: "Start easy.", blocks: BLOCKS, forName: "Omari", at: clock.now() });
  assert.match(html, /Back and shoulders/);
  assert.match(html, /The short version/);
  assert.ok(!html.includes("<script"), "no script: the opening animation would print a blank sheet");
  assert.ok(!html.includes("og:image"), "no preview tags: a PDF has no link to preview");
  assert.ok(!/data-intro/.test(html), "the sheet is not pushed off the page");
  assert.match(html, /<p class="foot"><span>Written by<\/span><span class="wordmark" role="img" aria-label="Reason">/);
  assert.ok(!html.includes("only this browser, after the code"), "it does not describe who can open a link");
});

// ---------- making one, and handing it over ----------

test("document_create writes the file, sends it as an attachment, and says so", async () => {
  const { router, fake } = harness();
  const out = await make(router);

  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.sent, true);
  assert.equal(out.kind, "docx");
  assert.equal(out.filename, "back-and-shoulders.docx");
  assert.ok(out.document_id, "it gives back the row id");

  // The row, and the file it points at.
  const row = db.getDocumentIn(C, out.document_id);
  assert.ok(row, "there is a row on this conversation");
  assert.equal(row.conversation_id, C);
  assert.equal(row.kind, "docx");
  assert.equal(row.title, "Back and shoulders");
  assert.ok(existsSync(row.path), "the file is really on disk");
  assert.equal(statSync(row.path).size, row.bytes, "the size on the row is the size on disk");
  assert.equal(createHash("sha256").update(readFileSync(row.path)).digest("hex"), row.sha256, "and so is the checksum");
  assert.ok(row.sent_at, "sent_at is written because the channel took it");

  // ONE message, carrying the words and the file together.
  assert.equal(fake.sent.length, 1, "one message, not a line of text and then a mystery file");
  const sent = fake.sent[0];
  assert.equal(sent.text, "made u the doc");
  assert.equal(sent.to, OWNER);
  assert.equal(sent.chatId, "chat-1", "into the thread this conversation lives in");
  assert.equal(sent.media.file, row.path);
  assert.equal(sent.media.filename, "back-and-shoulders.docx");
  assert.equal(sent.media.mimeType, mimeForKind("docx"));
  assert.equal(sent.media.bytes, row.bytes);
  assert.match(out.note, /in the thread/i);
});

test("all three kinds really come out, through the tool, as files on disk", async () => {
  for (const kind of DOCUMENT_KINDS) {
    const { router, fake } = harness();
    const out = await make(router, { kind, title: `A ${kind} of it` });
    assert.equal(out.ok, true, `${kind}: ${out.error}`);
    assert.equal(out.sent, true, `${kind} was not sent`);
    assert.equal(out.filename, `a-${kind}-of-it.${kind}`);
    assert.equal(fake.sent[0].media.mimeType, mimeForKind(kind));
    assert.ok(statSync(db.getDocumentIn(C, out.document_id).path).size > 0);
  }
});

test("every document leaves a receipt, like a page does", async () => {
  const { router } = harness();
  const out = await make(router, { title: "The deck", kind: "pptx" });
  await runTool("document_delete", { document_id: out.document_id }, ctx(router));

  const rows = db.listActions(C, { limit: 20 });
  const actions = rows.map(r => r.action);
  assert.ok(actions.includes("document_create"), `no receipt for making it: ${actions.join(", ")}`);
  assert.ok(actions.includes("document_delete"), "no receipt for deleting it");
  const made = rows.find(r => r.action === "document_create");
  assert.match(made.target, /document:pptx:The deck/, "the receipt says which document, by title and kind");
});

test("a document is scoped to its own conversation", async () => {
  const { router } = harness();
  const out = await make(router);
  // Somebody else with their own Reason on this install, so what is being tested is the scope and
  // not the separate refusal a conversation belonging to nobody gets.
  const theirs = "dm:fake:+13105550000";
  db.upsertAccount({ conversationId: theirs, channel: "fake", address: "+13105550000", name: "Kofi", isOperator: false });

  assert.equal(db.getDocumentIn(theirs, out.document_id), null, "another conversation cannot see it");
  const reached = await runTool("document_send", { document_id: out.document_id, to: "owner" },
    { conversationId: theirs, channels: router });
  assert.equal(reached.ok, false);
  assert.match(reached.error, /No document/);
});

// ---------- never claiming a send that did not happen ----------

test("when the upload fails the document is still made, and nothing says it was sent", async () => {
  const { router, fake } = harness({ mediaFailWith: "Sendblue would not take the file (HTTP 413)" });
  const out = await make(router);

  assert.equal(out.ok, false);
  assert.equal(out.sent, false);
  assert.ok(out.document_id, "the document exists: it is the send that failed");
  assert.match(out.error ?? "", /413/, "it says what the channel said");
  assert.match(out.note ?? out.error, /Nothing was sent/i);
  assert.equal(fake.sent.length, 0);
  assert.equal(db.getDocumentIn(C, out.document_id).sent_at, null, "sent_at is not written");

  const listed = await runTool("document_list", {}, ctx(router));
  assert.equal(listed.documents[0].sent, false, "the list does not claim it either");
});

test("a channel that cannot carry a file says so and gives the owner their own link", async () => {
  const { router, fake } = harness({ media: false });
  const out = await make(router);

  assert.equal(out.ok, false);
  assert.equal(out.sent, false);
  assert.equal(out.supported, false);
  assert.match(out.error, /cannot carry an attachment/);
  assert.match(out.error, /IS made/, "it does not throw the document away");
  assert.match(out.error, new RegExp(`${config.publicUrl}/f/${out.document_id}\\?k=`), "the owner's own keyed link");
  assert.equal(fake.sent.length, 0);
});

test("with no channel at all nothing pretends: the file is written and the refusal says so", async () => {
  const out = await runTool("document_create", { kind: "docx", title: "Notes", blocks: BLOCKS },
    { conversationId: C, renderDocument: fakeRender });
  assert.equal(out.ok, false);
  assert.equal(out.sent, false);
  assert.equal(out.status, "not_connected");
  assert.match(out.error, /no texting channel/i);
  assert.ok(existsSync(db.getDocumentIn(C, out.document_id).path));
});

test("a document whose file has been deleted cannot be sent, and says that instead of failing oddly", async () => {
  const { router, fake } = harness();
  const out = await make(router);
  rmSync(db.getDocumentIn(C, out.document_id).path, { force: true });
  fake.sent.length = 0;

  const again = await runTool("document_send", { document_id: out.document_id, to: "owner" }, ctx(router));
  assert.equal(again.ok, false);
  assert.match(again.error, /not on this machine any more/);
  assert.match(again.error, /do not say you sent it/i);
  assert.equal(fake.sent.length, 0);
});

test("a renderer that falls over makes no row and no file", async () => {
  const { router } = harness();
  const out = await runTool("document_create", { kind: "pptx", title: "Broken", blocks: BLOCKS },
    ctx(router, { renderDocument: async () => { throw new Error("pptxgenjs fell over"); } }));
  assert.equal(out.ok, false);
  assert.match(out.error, /was not made/);
  assert.match(out.error, /fell over/);
  assert.equal(db.listDocuments(C).length, 0, "no row for a document that does not exist");
});

// ---------- sending one on ----------

test("document_send to the owner needs no yes and really goes", async () => {
  const { router, fake } = harness();
  const made = await make(router);
  fake.sent.length = 0;

  const again = await runTool("document_send", { document_id: made.document_id, say: "here it is again" }, ctx(router));
  assert.equal(again.ok, true);
  assert.equal(again.sent, true);
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].text, "here it is again");
  assert.equal(fake.sent[0].media.filename, "back-and-shoulders.docx");
});

test("asked for the same document twice in the same instant, it really goes twice", async () => {
  // The bug this pins: the key the outbox dedupes on was the document and the millisecond, so
  // making a document and being asked for it again in the same tick produced the same key, the
  // outbox found the first row, and the second send was reported as done without happening.
  const { router, fake } = harness();
  const made = await make(router);
  assert.equal(fake.sent.length, 1);
  const again = await runTool("document_send", { document_id: made.document_id, say: "again" }, ctx(router));
  assert.equal(again.sent, true, JSON.stringify(again));
  assert.equal(fake.sent.length, 2, "the second send really went out rather than being deduped away");
  assert.equal(fake.sent[1].text, "again");
  // Two outbox rows under two different keys, which is where the dedupe lives.
  const keys = db.db.prepare("SELECT DISTINCT idem_key FROM outbox WHERE conversation_id = ?").all(C).map(r => r.idem_key);
  assert.equal(keys.length, 2, `two sends, two keys; got ${keys.length}`);
});

test("sending a document to anybody else is refused without a yes, and nothing leaves", async () => {
  const { router, fake } = harness();
  const made = await make(router);
  fake.sent.length = 0;

  const out = await runTool("document_send",
    { document_id: made.document_id, to: FRIEND, say: "Omari asked me to send this over. Omari's assistant, Reason" },
    ctx(router));
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(fake.sent.length, 0, "nothing was sent while it was refused");
  // The yes is pinned to this document AND this person, so it cannot be spent on another file.
  assert.match(out.use_target, new RegExp(`\\+14155559876: ${made.document_id}`));
});

test("with a yes it goes, and that yes is not spendable on a different document", async () => {
  const { router, fake } = harness();
  const one = await make(router, { title: "The deck", kind: "pptx" });
  const two = await make(router, { title: "Their lease", kind: "pdf" });
  fake.sent.length = 0;

  const say = "Omari asked me to send this over. Omari's assistant, Reason";
  const blocked = await runTool("document_send", { document_id: one.document_id, to: FRIEND, say }, ctx(router));
  const msgs = [{ role: "user", content: "send kofi the deck" }];
  const req = await runTool("confirm_request", { action: "document_send", summary: "send Kofi the deck", target: blocked.use_target },
    { conversationId: C, messages: msgs });
  msgs.push({ role: "user", content: "yes go" });
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id },
    { conversationId: C, messages: msgs, judge: async () => ({ verdict: "yes" }) });
  assert.equal(rec.state, "granted", JSON.stringify(rec));

  // The same yes, pointed at the other document: refused.
  const swapped = await runTool("document_send",
    { document_id: two.document_id, to: FRIEND, say, confirmation_id: req.confirmation_id }, ctx(router));
  assert.equal(swapped.ok, false, "a yes for the deck must not send their lease");
  assert.equal(fake.sent.length, 0);

  const went = await runTool("document_send",
    { document_id: one.document_id, to: FRIEND, say, confirmation_id: req.confirmation_id }, ctx(router));
  assert.equal(went.ok, true, JSON.stringify(went));
  assert.equal(went.sent, true);
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].to, FRIEND);
  assert.equal(fake.sent[0].media.filename, "the-deck.pptx");
});

test("a document to somebody else waits out the undo window, like a text", async () => {
  const { router, fake } = harness();
  config.undoWindowSeconds = 30;
  const made = await make(router, { title: "The deck", kind: "pptx" });
  fake.sent.length = 0;

  const say = "Omari asked me to send this over. Omari's assistant, Reason";
  const blocked = await runTool("document_send", { document_id: made.document_id, to: FRIEND, say }, ctx(router));
  const msgs = [{ role: "user", content: "send it to kofi" }];
  const req = await runTool("confirm_request", { action: "document_send", summary: "send Kofi the deck", target: blocked.use_target },
    { conversationId: C, messages: msgs });
  msgs.push({ role: "user", content: "yes" });
  await runTool("confirm_record", { confirmation_id: req.confirmation_id },
    { conversationId: C, messages: msgs, judge: async () => ({ verdict: "yes" }) });

  const held = await runTool("document_send",
    { document_id: made.document_id, to: FRIEND, say, confirmation_id: req.confirmation_id }, ctx(router));
  assert.equal(held.undo_held, true, JSON.stringify(held));
  assert.equal(fake.sent.length, 0, "nothing has gone yet");
  assert.match(held.say_exactly, /The deck/, "the line names the document that is about to leave");
  assert.match(held.say_exactly, /undo/);
});

test("a person Reason may write to but never send to gets a draft, not a file", async () => {
  const { router, fake } = harness();
  db.addImportantPerson(C, { name: "Mum", number: "+13105550000", why: "family", draftOnly: true });
  const made = await make(router);
  fake.sent.length = 0;

  const out = await runTool("document_send",
    { document_id: made.document_id, to: "+13105550000", say: "Omari asked me to send this. Omari's assistant, Reason" },
    ctx(router));
  assert.equal(out.ok, false);
  assert.equal(fake.sent.length, 0, "a file to somebody on that list never goes");
});

test("the words that go to a third party are held to the same rules as a text", async () => {
  const { router, fake } = harness();
  const made = await make(router);
  fake.sent.length = 0;
  const out = await runTool("document_send", { document_id: made.document_id, to: FRIEND, say: "here u go 🔥" }, ctx(router));
  assert.equal(out.ok, false);
  // Either refusal is correct here; what must never happen is the file going with that line on it.
  assert.equal(fake.sent.length, 0);
});

// ---------- listing, deleting, and what is honest about both ----------

test("document_list is what was really made, newest first, with whether it went", async () => {
  const { router } = harness();
  await make(router, { title: "One", kind: "docx" });
  clock.advance?.(1000);
  const two = await make(router, { title: "Two", kind: "pdf" });

  const out = await runTool("document_list", {}, ctx(router));
  assert.equal(out.count, 2);
  assert.equal(out.documents[0].document_id, two.document_id, "newest first");
  assert.equal(out.documents[0].what, "a PDF");
  assert.ok(out.documents.every(d => d.sent === true));
  assert.match(out.note, /actually reached/);
});

test("document_delete takes the row and the file, and is honest about the copy on their phone", async () => {
  const { router } = harness();
  const made = await make(router);
  const path = db.getDocumentIn(C, made.document_id).path;

  const gone = await runTool("document_delete", { document_id: made.document_id }, ctx(router));
  assert.equal(gone.ok, true);
  assert.equal(gone.file_deleted, true);
  assert.equal(existsSync(path), false, "the bytes are off this disk");
  assert.equal(db.getDocumentIn(C, made.document_id), null);
  assert.match(gone.note, /already on their phone/, "it does not imply it is gone everywhere");

  const again = await runTool("document_delete", { document_id: made.document_id }, ctx(router));
  assert.equal(again.ok, false);
  assert.match(again.error, /No document/);
});

// ---------- the owner's own link ----------

test("the download link opens with the owner's key and 404s without it", async () => {
  const { router } = harness();
  const made = await make(router);
  const doc = db.getDocumentIn(C, made.document_id);

  const ok = documentRequest({ id: doc.id, key: doc.owner_key });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["Content-Type"], mimeForKind("docx"));
  assert.match(ok.headers["Content-Disposition"], /attachment; filename="back-and-shoulders\.docx"/);
  assert.equal(ok.body.length, doc.bytes);

  for (const key of [null, "", "wrong-key-123", doc.owner_key.slice(0, -1)]) {
    assert.equal(documentRequest({ id: doc.id, key }).status, 404, `key ${JSON.stringify(key)} must not open it`);
  }
  assert.equal(documentRequest({ id: "nosuchdoc1", key: doc.owner_key }).status, 404);
  // A row whose file has gone answers exactly the same way as one that never existed.
  rmSync(doc.path, { force: true });
  assert.equal(documentRequest({ id: doc.id, key: doc.owner_key }).status, 404);
});

// ---------- the capability is only as true as the channel ----------

test("'documents' is live only where a file can actually be carried", async () => {
  const withFiles = harness();
  const live = capabilitiesNow({ channels: withFiles.router, conversationId: C }).find(c => c.name === "documents");
  assert.equal(live.status, "live");
  assert.match(live.what, /\.docx/);
  assert.match(live.what, /\.pptx/);
  assert.match(live.what, /PDF/);

  db.db.exec("DELETE FROM threads;");
  const noFiles = harness({ media: false });
  const off = capabilitiesNow({ channels: noFiles.router, conversationId: C }).find(c => c.name === "documents");
  assert.equal(off.status, "not connected");
  assert.match(off.what, /cannot carry an attachment|no texting channel/);
  assert.match(off.what, /[Dd]o not offer/);

  const none = capabilitiesNow({ channels: null, conversationId: C }).find(c => c.name === "documents");
  assert.equal(none.status, "not connected");
});

test("in a terminal the document is written and the path is what is handed over", async () => {
  // The console is a real channel with a real sendMedia: it prints where the file is, which is the
  // only honest delivery a terminal has. So `documents` is live there, and what the person gets is
  // a path rather than an attachment. The channel that genuinely cannot carry one is covered above.
  const lines = [];
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime });
  const term = router.register(new ConsoleChannel({ write: (s) => lines.push(s) }));
  db.upsertThread({ conversationId: C, channel: term.name, address: OWNER, chatId: null, service: "iMessage" });

  const out = await make(router);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.sent, true);
  const printed = lines.join("");
  assert.match(printed, /back-and-shoulders\.docx/, "the terminal says where the file is");
  assert.match(printed, /made u the doc/);
});

// ---------- your data ----------

test("an export carries the document's bytes, and --no-files keeps the list without them", async () => {
  const { router } = harness();
  const made = await make(router);
  const doc = db.getDocumentIn(C, made.document_id);

  const full = exportData({ conversation: C });
  assert.equal(full.tables.documents.length, 1, "the row is in the export");
  assert.equal(full.documents.length, 1);
  assert.equal(full.documents[0].sha256, doc.sha256);
  assert.equal(full.documents[0].mime, mimeForKind("docx"));
  assert.equal(full.documents[0].missing, false);
  assert.equal(Buffer.from(full.documents[0].file_base64, "base64").length, doc.bytes, "the whole file is inside the export");

  const light = exportData({ conversation: C, files: false });
  assert.equal(light.documents.length, 1);
  assert.equal(light.documents[0].file_base64, undefined);

  // A file the database claims and the disk does not have is reported, never implied.
  rmSync(doc.path, { force: true });
  assert.equal(exportData({ conversation: C }).documents[0].missing, true);
});

test("a delete takes the file as well as the row", async () => {
  const { router } = harness();
  const made = await make(router);
  const path = db.getDocumentIn(C, made.document_id).path;
  assert.ok(existsSync(path));

  const out = await deleteData({ conversation: C, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }) });
  assert.equal(out.documents.listed, 1);
  assert.equal(out.documents.files_deleted, 1);
  assert.deepEqual(out.documents.failed, []);
  assert.equal(existsSync(path), false, "a document left on disk after a delete is not a delete");
  assert.equal(db.listDocuments(C).length, 0);
});

test("the retention window takes old documents off the disk, file and row together", async () => {
  const { router } = harness();
  const made = await make(router);
  const path = db.getDocumentIn(C, made.document_id).path;
  const days = config.keepContentDays;
  config.keepContentDays = 7;
  try {
    // Older than the window: the sweep is the one that deletes it, with nobody asking.
    db.db.prepare("UPDATE documents SET created_at = ? WHERE id = ?").run(clock.now() - 30 * 86400_000, made.document_id);
    const out = sweepRetention({ now: clock.now() });
    assert.equal(out.deleted.documents, 1, JSON.stringify(out.deleted));
    assert.equal(existsSync(path), false);
    assert.equal(db.listDocuments(C).length, 0);
  } finally {
    config.keepContentDays = days;
  }
});

test("a filename is the title and nothing a path could hide in", () => {
  assert.equal(documentFilename("Back and shoulders", "docx"), "back-and-shoulders.docx");
  assert.equal(documentFilename("../../etc/passwd", "pdf"), "etc-passwd.pdf");
  assert.equal(documentFilename("  ", "pptx"), "document.pptx");
  assert.equal(documentFilename("Résumé — Omari 2026", "docx"), "r-sum-omari-2026.docx");
  assert.ok(!documentFilename("a/b\\c", "pdf").includes("/"));
});
