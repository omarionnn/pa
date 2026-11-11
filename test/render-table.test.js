// Table pictures (src/tableimage.js): a set of options compared on the same facts, drawn as a picture.
//
// Nothing here opens a browser or reaches a network: the renderer is injected, the picture store is the
// real one (on a temp dir), and the "router" is a list that remembers what it was handed, in order.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-table-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_WEB = "on";
process.env.REASON_TABLE_GAP_MS = "0";

const t = await import("../src/tableimage.js");
const cc = await import("../src/choicecards.js");
const db = await import("../src/db.js");
const uploads = await import("../src/webuploads.js");
const { webMediaRoute } = await import("../src/webmedia.js");
const { toolsFor } = await import("../src/tools.js");
const { systemFor } = await import("../src/agent.js");
const { clock } = await import("../src/config.js");

const C = "dm:owner";
const OTHER = "dm:sendblue:+13035550000";
// A PNG header followed by filler, so the uploads store classifies it as an image.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const shoot = async () => Buffer.from(PNG);
const input = () => ({
  title: "Pizza Near You",
  columns: ["Place", "Price (slice)", "Walk", "Rating"],
  rows: [["Joe's Pizza", "$3.50", "4 min", "4.6"], ["Prince Street Pizza", "$5", "9 min", "4.5"], ["Lucali", "$28", "25 min", "4.7"]],
  comment: "Joe's for a slice right now.",
});
const ctx = (extra = {}) => ({ conversationId: C, shoot, log: () => {}, ...extra });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  process.env.REASON_TABLE_IMAGES = "on";
  db.db.exec("DELETE FROM choice_sets; DELETE FROM accounts;");
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13035550000", name: "Kofi", isOperator: false });
  t.takeQueued(C);
});

function fakeRouter({ failAt = null, byUrl = true } = {}) {
  const sent = [];
  const texts = [];
  return {
    sent, texts,
    get: () => (byUrl ? { sendMediaUrl() {} } : {}),
    async sendMedia(m) {
      if (failAt === sent.length + 1) return { ok: false, error: "provider said no" };
      sent.push(m);
      return { ok: true, delivered: { message_id: `H-${sent.length}` } };
    },
    async send(m) { texts.push(m); return { ok: true }; },
  };
}

// ---------- the switch ----------

test("off by default: the tool is not offered, the dispatch refuses, the prompt carries no table rules", async () => {
  delete process.env.REASON_TABLE_IMAGES;
  assert.ok(!toolsFor(C).some(x => x.name === "render_table"));
  const r = await t.runTableTool("render_table", input(), ctx());
  assert.equal(r.ok, false);
  assert.ok(!systemFor({ conversationId: C, isOperator: true }).includes("Pick the shape the ask earns"));
  process.env.REASON_TABLE_IMAGES = "on";
  assert.ok(toolsFor(C).some(x => x.name === "render_table"));
  assert.ok(systemFor({ conversationId: C, isOperator: true }).includes("Pick the shape the ask earns"));
});

test("owner: only the operator's conversation sees the tool and reads the rules", () => {
  process.env.REASON_TABLE_IMAGES = "owner";
  assert.ok(toolsFor(C).some(x => x.name === "render_table"));
  assert.ok(!toolsFor(OTHER).some(x => x.name === "render_table"));
  assert.ok(t.tableRules({ conversationId: C, isOperator: true }).includes("render_table"));
  assert.equal(t.tableRules({ conversationId: OTHER, isOperator: false }), "");
});

// ---------- the input ----------

test("validation: a title, 2+ columns, 2+ rows, a cell per column, a name in every first cell, no two rows alike", () => {
  assert.equal(t.validateTable({ ...input(), title: " " }).ok, false);
  assert.match(t.validateTable({ ...input(), columns: ["Place"], rows: [["a"], ["b"]] }).error, /at least 2 columns/);
  assert.match(t.validateTable({ ...input(), rows: [["Joe's", "$3", "4 min", "4.6"]] }).error, /2 or more options/);
  assert.match(t.validateTable({ ...input(), rows: [["Joe's", "$3"], ["Lucali", "$28", "25 min", "4.7"]] }).error, /one cell per column/);
  assert.match(t.validateTable({ ...input(), rows: [["", "$3", "4 min", "4.6"], ["Lucali", "$28", "25 min", "4.7"]] }).error, /name the option/);
  assert.match(t.validateTable({ ...input(), rows: [["Lucali", "$3", "4 min", "4.6"], ["lucali", "$28", "25 min", "4.7"]] }).error, /same name/);
  const ok = t.validateTable(input());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.dropped, []);
  assert.deepEqual(ok.table.columns, ["Place", "Price (slice)", "Walk", "Rating"]);
});

test("a column any row cannot fill is dropped whole — never an N/A in the picture", () => {
  const v = t.validateTable({ ...input(), rows: [["Joe's Pizza", "$3.50", "4 min", "N/A"], ["Prince Street Pizza", "$5", "—", "4.5"], ["Lucali", "$28", "25 min", "4.7"]] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.dropped, ["Walk", "Rating"]);
  assert.deepEqual(v.table.columns, ["Place", "Price (slice)"]);
  assert.deepEqual(v.table.rows, [["Joe's Pizza", "$3.50"], ["Prince Street Pizza", "$5"], ["Lucali", "$28"]]);
  // Every fact column blank somewhere: nothing left to compare, and the error says which.
  const none = t.validateTable({ ...input(), columns: ["Place", "Price"], rows: [["A", ""], ["B", "$5"]] });
  assert.equal(none.ok, false);
  assert.match(none.error, /Nothing is left to compare.*Price/);
  for (const b of ["", "  ", "-", "—", "n/a", "N/A", "none", "tbd", "?"]) assert.equal(t.isBlank(b), true, JSON.stringify(b));
  assert.equal(t.isBlank("4 min"), false);
});

test("the schema the model is held to: 2–5 columns, 2–40 rows, a theme only light or dark", () => {
  const s = t.TABLE_SCHEMAS.render_table;
  assert.equal(s.safeParse(input()).success, true);
  assert.equal(s.safeParse({ ...input(), columns: ["a", "b", "c", "d", "e", "f"] }).success, false);
  assert.equal(s.safeParse({ ...input(), theme: "sepia" }).success, false);
  assert.equal(s.safeParse({ ...input(), rows: [] }).success, false);
});

// ---------- the shape ----------

test("rows split at 8 per picture, in order, and the last picture carries the comment", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => [`Place ${i + 1}`, `$${i + 1}`, `${i + 1} min`, "4.5"]);
  assert.deepEqual(t.splitRows(rows).map(p => p.length), [8, 2]);
  assert.deepEqual(t.splitRows(rows.slice(0, 8)).map(p => p.length), [8]);
  assert.deepEqual(t.splitRows(rows.slice(0, 3)).map(p => p.length), [3]);
  assert.deepEqual(t.splitRows(Array.from({ length: 17 }, (_, i) => [`P${i}`])).map(p => p.length), [8, 8, 1]);
  const htmls = [];
  const drawn = await t.renderTable({ ...input(), rows }, { theme: "light", shoot: async (html) => { htmls.push(html); return Buffer.from(PNG); } });
  assert.equal(drawn.length, 2);
  assert.ok(htmls[0].includes("Place 1") && htmls[0].includes("Place 8") && !htmls[0].includes("Place 9"));
  assert.ok(htmls[1].includes("Place 9") && htmls[1].includes("Place 10"));
  // Title and header on both; the comment and "2 of 2" only where they belong.
  assert.ok(htmls.every(h => h.includes("Pizza Near You") && h.includes("<th") && h.includes("Price (slice)") && h.includes("wordmark")));
  assert.ok(!htmls[0].includes("for a slice right now") && htmls[1].includes("for a slice right now"));
  assert.ok(htmls[0].includes("1 of 2") && htmls[1].includes("2 of 2"));
});

test("the drawing: first column bold, figures right-aligned, no row numbers, the logo contrasts with the ground", () => {
  const h = t.tableHtml({ ...input(), theme: "light" });
  assert.ok(h.includes('class="n"') && h.includes("td.n .c{font-weight:700}"));
  // Price and Rating are figures in every row; Walk ("4 min") is too; the names never are.
  assert.deepEqual(t.alignedRight(input().columns, input().rows), [false, true, true, true]);
  assert.ok(!/<td[^>]*>\s*<div class="c">1<\/div>/.test(h));
  assert.ok(h.includes("background:#ffffff") && h.includes("stroke:#9c3b2e"));
  const d = t.tableHtml({ ...input(), theme: "dark" });
  assert.ok(d.includes("background:#111111") && d.includes("stroke:#d46a5c") && d.includes('data-theme="dark"'));
  // Cell text is escaped: a name with markup in it is drawn as its characters.
  const x = t.tableHtml({ ...input(), rows: [["<b>Joe's</b>", "$3", "4 min", "4.6"], ["Lucali", "$28", "25 min", "4.7"]] });
  assert.ok(x.includes("&lt;b&gt;Joe") && !x.includes("<b>Joe"));
});

test("price-like cells: currency, figures with a unit, ratings — not words, not times", () => {
  for (const s of ["$3.50", "€1,200/mo", "from $89", "4.6", "12 min", "2.3 mi", "15%", "$28", "4.5 ★", "$1,299"]) assert.equal(t.priceLike(s), true, s);
  for (const s of ["Nonstop", "4 AM", "$28 (pie)", "Joe's", "1 stop (DCA)", "open late"]) assert.equal(t.priceLike(s), false, s);
});

test("both palettes pass WCAG AA for the ink and the muted tone on the ground and the zebra band", () => {
  assert.ok(t.contrastRatio("#000000", "#ffffff") > 20.9);
  assert.ok(Math.abs(t.contrastRatio("#777777", "#ffffff") - 4.48) < 0.02);
  assert.equal(t.contrastOk("light"), true);
  assert.equal(t.contrastOk("dark"), true);
  for (const th of ["light", "dark"]) {
    const p = t.PALETTE[th];
    assert.ok(t.contrastRatio(p.ink, p.bg) >= 4.5 && t.contrastRatio(p.muted, p.bg) >= 4.5, th);
  }
});

test("the theme follows their Web choice: Night → dark, Paper or nothing → light; the model may still name one", () => {
  assert.equal(t.themeFor(C), "light");
  db.setWebTheme(C, "night");
  assert.equal(t.themeFor(C), "dark");
  db.setWebTheme(C, "auto");
  assert.equal(t.themeFor(C), "light");
});

// ---------- the tool ----------

test("render_table draws, keeps each picture 30 days at an unguessable address, remembers the rows, and sends after the words", async () => {
  const log = [];
  const r = await t.runTableTool("render_table", input(), ctx({ log: (l) => log.push(l) }));
  assert.equal(r.ok, true);
  assert.equal(r.pictures, 1);
  assert.equal(r.rows, 3);
  assert.match(r.note, /at most one short line/);
  assert.ok(log.some(l => l.table_rendered && typeof l.ms === "number"));
  // The rows are kept as a set, in order, so a reply can be read against them.
  const set = db.openChoiceFor(C) ?? db.db.prepare("SELECT * FROM choice_sets WHERE id = ?").get(r.set_id);
  assert.equal(set.kind, "table");
  assert.equal(set.state, "queued");
  assert.deepEqual(JSON.parse(set.options).map(o => o.name), ["Joe's Pizza", "Prince Street Pizza", "Lucali"]);
  assert.equal(JSON.parse(set.options)[0].price, "$3.50");

  const router = fakeRouter();
  const out = await t.sendQueued(C, { router, withWords: true, route: { channel: "sendblue", to: "+12025551234" } });
  assert.equal(out.sent, 1);
  const m = router.sent[0];
  assert.equal(m.text, "");
  assert.equal(m.mimeType, "image/png");
  assert.equal(m.idempotencyKey, `table:${r.set_id}:1`);
  assert.equal(m.toOwner, true);
  assert.match(m.mediaUrl, /^https:\/\/[^/]+\/web\/media\/u\/[A-Za-z0-9_-]{22}\/reason-table-1\.png$/);
  assert.equal(m.file, undefined);
  // The address resolves to a real upload of this conversation's, kept KEEP_MS (30 days).
  const id = uploads.uploadIdOf(m.mediaUrl);
  const rec = uploads.meta(id);
  assert.equal(rec.conversationId, C);
  assert.equal(rec.public, "table");
  assert.ok(existsSync(uploads.filePath(rec)));
  assert.equal(uploads.KEEP_MS, 30 * 24 * 60 * 60_000);
  assert.equal(db.openChoiceFor(C).state, "shown");
  assert.deepEqual(db.openChoiceFor(C).handles, ["H-1"]);
});

test("a channel that only takes files (Web) gets the file, not the address", async () => {
  const r = await t.runTableTool("render_table", input(), ctx());
  const router = fakeRouter({ byUrl: false });
  await t.sendQueued(C, { router, withWords: true, route: { channel: "web", to: C } });
  assert.equal(router.sent[0].mediaUrl, undefined);
  assert.ok(existsSync(router.sent[0].file));
  assert.equal(router.sent[0].idempotencyKey, `table:${r.set_id}:1`);
});

test("the public route serves a table picture with no session and nothing else without one", async () => {
  await t.runTableTool("render_table", input(), ctx());
  const router = fakeRouter();
  await t.sendQueued(C, { router, withWords: true, route: { channel: "sendblue", to: "+12025551234" } });
  const path = new URL(router.sent[0].mediaUrl).pathname;
  const res = await webMediaRoute({ path, method: "GET", headers: {}, readBody: async () => null });
  assert.equal(res.status, 200);
  assert.match(String(res.headers["Content-Type"] ?? res.headers["content-type"]), /image\/png/);
  // An ordinary upload (a photo they sent in) is still theirs alone.
  const theirs = uploads.store({ conversationId: C, bytes: PNG, name: "me.png" });
  const no = await webMediaRoute({ path: uploads.uploadPath(theirs.id, theirs.name), method: "GET", headers: {}, readBody: async () => null });
  assert.equal(no.status, 404);
  const nope = await webMediaRoute({ path: "/web/media/u/AAAAAAAAAAAAAAAAAAAAAA/x.png", method: "GET", headers: {}, readBody: async () => null });
  assert.equal(nope.status, 404);
});

test("10 rows → 2 pictures, sent together in order with the same set", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => [`Place ${i + 1}`, `$${i + 1}`, `${i + 1} min`, "4.5"]);
  const r = await t.runTableTool("render_table", { ...input(), rows }, ctx());
  assert.equal(r.pictures, 2);
  assert.match(r.note, /2 pictures/);
  const router = fakeRouter();
  const out = await t.sendQueued(C, { router, withWords: true, route: { channel: "sendblue", to: "+12025551234" } });
  assert.equal(out.sent, 2);
  assert.deepEqual(router.sent.map(m => m.idempotencyKey), [`table:${r.set_id}:1`, `table:${r.set_id}:2`]);
  assert.deepEqual(router.sent.map(m => m.filename), ["reason-table-1.png", "reason-table-2.png"]);
});

test("the dropped column is named in the note so the line never mentions it", async () => {
  const r = await t.runTableTool("render_table", { ...input(), rows: [["Joe's Pizza", "$3.50", "4 min", "N/A"], ["Prince Street Pizza", "$5", "9 min", "4.5"], ["Lucali", "$28", "25 min", "4.7"]] }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.note, /Left out.*Rating/);
});

test("render fails → fallback to the same data as short text, one option per line, rows still kept", async () => {
  const r = await t.runTableTool("render_table", input(), ctx({ shoot: async () => { throw new Error("no chromium here"); } }));
  assert.equal(r.ok, true);
  assert.equal(r.fallback, "text");
  assert.match(r.note, /no chromium here/);
  assert.match(r.note, /Joe's Pizza — Price \(slice\) \$3\.50, Walk 4 min, Rating 4\.6/);
  assert.match(r.note, /Lucali — /);
  assert.equal(db.openChoiceFor(C).state, "text");
  assert.equal(t.takeQueued(C), null);
  // An empty picture is the same failure.
  const e = await t.runTableTool("render_table", input(), ctx({ shoot: async () => Buffer.alloc(0) }));
  assert.equal(e.fallback, "text");
});

test("the store failing is the same fallback, never a broken address", async () => {
  const r = await t.runTableTool("render_table", input(), ctx({ store: () => ({ error: "too_big" }) }));
  assert.equal(r.fallback, "text");
  assert.match(r.note, /keeping the picture failed/);
});

test("a picture that fails to send → the whole table as plain text instead", async () => {
  const r = await t.runTableTool("render_table", { ...input(), rows: Array.from({ length: 10 }, (_, i) => [`Place ${i + 1}`, `$${i + 1}`, `${i + 1} min`, "4.5"]) }, ctx());
  const router = fakeRouter({ failAt: 2 });
  const out = await t.sendQueued(C, { router, withWords: true, route: { channel: "sendblue", to: "+12025551234" } });
  assert.equal(out.sent, 1);
  assert.equal(out.text, true);
  assert.equal(router.texts.length, 1);
  assert.match(router.texts[0].text, /^Pizza Near You\nPlace 1 — /);
  assert.equal(router.texts[0].idempotencyKey, `table:${r.set_id}:text`);
  assert.equal(db.openChoiceFor(C).state, "text");
});

test("a turn that said nothing sends no picture; the set is dropped", async () => {
  const r = await t.runTableTool("render_table", input(), ctx());
  const router = fakeRouter();
  const out = await t.sendQueued(C, { router, withWords: false, route: { channel: "sendblue", to: "+12025551234" } });
  assert.equal(out.sent, 0);
  assert.equal(router.sent.length, 0);
  assert.equal(db.db.prepare("SELECT state FROM choice_sets WHERE id = ?").get(r.set_id).state, "dropped");
  assert.equal(db.openChoiceFor(C), null);
});

test("a picture over 1 MB is drawn again at 1×, then as a JPEG", async () => {
  const calls = [];
  const big = Buffer.alloc(t.MAX_IMAGE_BYTES + 1, 1);
  const drawn = await t.renderTable(input(), { shoot: async (_, o) => { calls.push([o.scale, o.type]); return o.type === "jpeg" ? Buffer.from(PNG) : big; } });
  assert.deepEqual(calls, [[2, "png"], [1, "png"], [1, "jpeg"]]);
  assert.equal(drawn[0].mime, "image/jpeg");
  const fine = [];
  await t.renderTable(input(), { shoot: async (_, o) => { fine.push(o.scale); return Buffer.from(PNG); } });
  assert.deepEqual(fine, [2]);
});

// ---------- reading what came back ----------

test("a pick by position or by name resolves against the rows, counting from the top", () => {
  const names = ["Joe's Pizza", "Prince Street Pizza", "Lucali"];
  for (const [said, want] of [
    ["2", 1], ["#2", 1], ["2.", 1], ["the second one", 1], ["second", 1], ["2nd one", 1], ["number 3", 2], ["option 1", 0],
    ["the last one", 2], ["last", 2], ["the first one", 0], ["the top one", 0], ["three", 2],
    ["lucali", 2], ["let's do Lucali", 2], ["prince street", 1], ["joe's", 0], ["the prince one", 1],
  ]) assert.equal(t.pickFromTable(names, said), want, said);
  for (const said of ["", "pizza", "7", "the one with the best rating", "what time do they close", "two of us at 8pm", "0"]) {
    assert.equal(t.pickFromTable(names, said), null, said);
  }
  assert.equal(t.pickFromTable(["Delta 2111", "JetBlue 817", "American 4521"], "jetblue"), 1);
  assert.equal(t.pickFromTable(["Delta 2111", "Delta 2255"], "delta"), null);
});

test("the next message is read with the rows in front of the model, and a clear pick is named", async () => {
  const r = await t.runTableTool("render_table", input(), ctx());
  const router = fakeRouter();
  await t.sendQueued(C, { router, withWords: true, route: { channel: "sendblue", to: "+12025551234" } });
  const line = cc.inboundChoiceLine(C, { text: "the second one" });
  assert.match(line, /3 options as a table picture \(rows numbered from the top\)/);
  assert.match(line, /1 = Joe's Pizza, \$3\.50, 4 min · 4\.6; 2 = Prince Street Pizza/);
  assert.match(line, /row 2 \(Prince Street Pizza\)/);
  assert.match(cc.inboundChoiceLine(C, { text: "what time does joe's close" }), /row 1 \(Joe's Pizza\)/);
  assert.match(cc.inboundChoiceLine(C, { text: "ok" }), /If this message picks one/);
  // An inline reply on the picture says so.
  db.db.exec("UPDATE choice_sets SET reads = 0");
  assert.match(cc.inboundChoiceLine(C, { text: "this one", replyTo: "H-1" }), /inline reply on the table picture/);
  void r;
});

test("in text fallback the line says so, and a set expires like any other", async () => {
  await t.runTableTool("render_table", input(), ctx({ shoot: async () => { throw new Error("x"); } }));
  assert.match(cc.inboundChoiceLine(C, { text: "2" }), /as short lines.*row 2/);
  clock.skip(t.TABLE_TTL_MS + 1);
  assert.equal(cc.inboundChoiceLine(C, { text: "2" }), "");
});

test("a Web-only chat gets no picture; the tool says to write lines", async () => {
  const r = await t.runTableTool("render_table", input(), ctx({ historyId: "web:abc" }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Web-only/);
});

// ---------- review of PR #463 ----------

test("review: the real Web/Linq channel inherits the base stub sendMediaUrl — it still gets the file, never the address", async () => {
  const { Channel } = await import("../src/channels/channel.js");
  const { WebChannel } = await import("../src/channels/web.js");
  const r = await t.runTableTool("render_table", input(), ctx());
  const router = fakeRouter();
  // A channel whose sendMediaUrl is the base class's refusal, exactly as Web and Linq have it.
  const web = Object.create(WebChannel.prototype);
  assert.equal(web.sendMediaUrl, Channel.prototype.sendMediaUrl);
  router.get = () => web;
  await t.sendQueued(C, { router, withWords: true, route: { channel: "web", to: C } });
  assert.equal(router.sent[0].mediaUrl, undefined);
  assert.ok(existsSync(router.sent[0].file));
  assert.equal(router.sent[0].table, undefined);
  assert.equal(router.sent[0].idempotencyKey, `table:${r.set_id}:1`);
  // Sendblue overrides it: that one goes by address, marked as a table.
  const { SendblueChannel } = await import("../src/channels/sendblue.js");
  const sb = Object.create(SendblueChannel.prototype);
  assert.notEqual(sb.sendMediaUrl, Channel.prototype.sendMediaUrl);
  await t.runTableTool("render_table", input(), ctx());
  const r2 = fakeRouter(); r2.get = () => sb;
  await t.sendQueued(C, { router: r2, withWords: true, route: { channel: "sendblue", to: "+12025551234" } });
  assert.match(r2.sent[0].mediaUrl, /\/web\/media\/u\//);
  assert.equal(r2.sent[0].table, true);
});

test("review: history draws a table sent by address, but a contact card's .vcf by address stays a file", async () => {
  const { config } = await import("../src/config.js");
  const was = config.web;
  config.web = true;
  try {
    db.db.exec("DELETE FROM messages; DELETE FROM outbox;");
    const put = (idemKey, media) => {
      const { row } = db.enqueueOutbound({ idemKey, conversationId: C, channel: "sendblue", address: "+12025551234", body: "", media, toOwner: true });
      db.claimOutbound(row.id);
      return db.markOutboundSent(row.id, { messageId: `M-${idemKey}` });
    };
    put("table:1:1", { mediaUrl: "https://heyreason.com/web/media/u/abc123.png", mimeType: "image/png", filename: "reason-table-1.png", table: true });
    put("onboard:card:1", { mediaUrl: "https://heyreason.com/contact/reason.vcf", mimeType: "text/vcard", filename: "Reason.vcf" });
    put("x:unmarked", { mediaUrl: "https://heyreason.com/web/media/u/def456.png", mimeType: "image/png", filename: "p.png" });
    const rows = db.messagesFor(C);
    const by = Object.fromEntries(rows.map(r => [r.outbox_id ? db.getOutbound(r.outbox_id).idem_key : r.id, r]));
    assert.deepEqual(by["table:1:1"].media[0], { kind: "image", mimeType: "image/png", filename: "reason-table-1.png", url: "https://heyreason.com/web/media/u/abc123.png", table: true });
    assert.equal(by["onboard:card:1"].media[0].kind, "file");
    assert.equal(by["onboard:card:1"].media[0].url, undefined);
    assert.equal(by["x:unmarked"].media[0].kind, "file", "an address nobody marked as a table is not drawn");
  } finally { config.web = was; }
});

test("review: a fresh table set never makes a reply promise a total — only shopping sets do", async () => {
  await t.runTableTool("render_table", input(), ctx());
  const set = db.db.prepare("SELECT kind FROM choice_sets WHERE conversation_id = ? ORDER BY id DESC LIMIT 1").get(C);
  assert.equal(set.kind, "table");
  const w = cc.choiceWording(C, "Joe's is open until 2am and the quietest of the three.");
  assert.equal(w.flag, null);
  assert.ok(!w.text.includes(cc.TOTAL_FIRST_LINE));
});

test("review: an ordinal inside a question is not a pick, and a short name is not matched inside a longer word", () => {
  const names = ["Ace Hotel", "The Standard", "Joe's Pizza"];
  assert.equal(t.pickFromTable(names, "First, is the 2nd one open late?"), null);
  assert.equal(t.pickFromTable(names, "the 2nd one"), 1);
  assert.equal(t.pickFromTable(names, "second, please"), 1);
  assert.equal(t.pickFromTable(["Ace", "Bar", "Cue"], "which place has parking"), null);
  assert.equal(t.pickFromTable(["Ace", "Bar", "Cue"], "ace"), 0);
});
