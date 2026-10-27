// Pages print beautifully (handoff v4 §4h item 8, sheet-small-details "8 · PAGES PRINT BEAUTIFULLY").
// One @media print stylesheet (src/pages/print.js) on every page kind Reason makes, in both frames:
//
//   - every designed page (shortlist, the day, call, event, album, receipt), the edge screens, the
//     ordinary page (render.js shell) and the older event/album pages carry PRINT_CSS, last in <style>
//   - on paper: white, Paper ink, pen #9c3b2e for stamps, Night tokens can't reach it (!important)
//   - no header/wordmark bar, theme switch, actions, forms, Back to Reason; no shadows; no grain
//   - cards don't split across sheets
//   - the page's canonical address in small type at the foot: keyless, schemeless, hidden on screen
//   - Reason Web pages print Paper on white with no grain
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-print-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025550142";
process.env.REASON_OWNER_NUMBER = "+12025550142";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_EVENTS_URL = "https://events.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "owner";
process.env.REASON_EVENTS = "on";
delete process.env.REASON_BACKEND;

const db = await import("../src/db.js");
const events = await import("../src/events.js");
const { config } = await import("../src/config.js");
const { pageRequest, eventRequestFor } = await import("../src/http.js");
const made = await import("../src/pages/made.js");
const { renderPage, renderNotice } = await import("../src/pages/render.js");
const { webPage } = await import("../src/pages/webkit.js");
const { PRINT_CSS, WEB_PRINT_CSS, printableUrl } = await import("../src/pages/print.js");

const OWNER = "dm:owner";
after(() => rmSync(dir, { recursive: true, force: true }));
before(() => {
  db.upsertAccount({ conversationId: OWNER, channel: "fake", address: "+12025550142", name: "Omari", isOperator: true });
});

const printBlock = (html) => {
  const css = (String(html).match(/<style>([\s\S]*?)<\/style>/) ?? [])[1] ?? "";
  return css;
};
function printsWell(html, url, what) {
  const css = printBlock(html);
  assert.ok(css.endsWith(PRINT_CSS), `${what}: the print sheet is last in <style>, so it wins`);
  if (url) assert.match(html, new RegExp(`<p class="print-url">${url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}</p>`), `${what}: the address at the foot`);
}

const URL_P = "https://files.heyreason.test/abc123";
const VMS = {
  shortlist: () => made.renderShortlist({ kicker: "MADE FOR YOU", title: "Dinner, three places", meta: "", url: URL_P,
    options: [{ n: "01", name: "Peaches", facts: [["Open", "7:30"]], pick: true }, { n: "02", name: "Lilia", facts: [] }],
    opinion: "closest.", choice: { action: "abc123/choice", key: "k" }, picked: null }),
  day: () => made.renderDay({ kicker: "THE DAY", title: "Today, in five things.", note: "nothing open.", url: URL_P,
    items: [{ at: "5:30", title: "Con Ed paid", stamp: "paid" }], tomorrow: "" }),
  call: () => made.renderCall({ kicker: "CALL", title: "Called the inn", stamp: "DONE", meta: "", url: URL_P,
    audio: { href: "/rec.mp3", seconds: 90 }, points: ["Booked."], worth: "", transcript: [{ who: "Reason", text: "Hi" }] }),
  event: () => made.renderEvent({ title: "A weekend upstate", host: "", facts: [["When", "4 PM"]], rsvp: { joined: true }, coming: ["Kofi"],
    calendarHref: "/e/x/calendar.ics", url: "https://events.heyreason.test/e/x" }),
  album: () => made.renderAlbum({ title: "Hudson", kicker: "2 PHOTOS", photos: [{ src: "/a.jpg", href: "/a.jpg", alt: "a" }], total: 1,
    downloadHref: "/d", url: "https://events.heyreason.test/e/x/album" }),
  receipt: () => made.renderReceipt({ kicker: "RECEIPT · CON ED", title: "Con Ed, paid.", rows: [["Card", "•• 4242"]], total: "$87.40", stamp: "PAID",
    note: "due friday, paid tuesday.", pdf: true, chatHref: "https://heyreason.test/web", url: URL_P }),
};

test("every designed page kind carries the print sheet last and its address at the foot", () => {
  for (const [kind, draw] of Object.entries(VMS)) {
    const html = draw();
    const url = kind === "event" ? "events.heyreason.test/e/x" : kind === "album" ? "events.heyreason.test/e/x/album" : "files.heyreason.test/abc123";
    printsWell(html, url, kind);
    assert.ok(html.indexOf('<p class="print-url">') > html.indexOf('<p class="foot">'), `${kind}: the address is the last thing on the page`);
  }
  // The edge screens (turned off, not yours, archived) print the same way, with no address to give.
  for (const html of [made.renderTurnedOff({}), made.renderNotYours({ masked: "••• 0142" }), made.renderArchived({ pageTitle: "x" })]) {
    printsWell(html, "", "edge");
    assert.doesNotMatch(html, /class="print-url"/);
  }
});

test("the ordinary page and a notice go through shell() with the same sheet; the page gets its keyless address", () => {
  const html = renderPage({ id: "abc123", title: "Coffee, a guide", blocks: [{ type: "text", text: "Beans." }], created_at: Date.now(), updated_at: Date.now(), revision: 1, owner_key: "SECRETKEY" },
    { interactive: true });
  printsWell(html, "files.heyreason.test/abc123", "page");
  assert.doesNotMatch(html.match(/<p class="print-url">[^<]*<\/p>/)[0], /SECRETKEY|\?/, "never the owner's key on paper");
  printsWell(renderPage({ id: "abc123", title: "x", blocks: [], created_at: 0, updated_at: 0, revision: 1 }, { printing: true }), "files.heyreason.test/abc123", "printed PDF");
  printsWell(renderNotice({ title: "Connected" }), "", "notice");
});

test("what the sheet does on paper: white, ink, pen stamps, Night can't reach it, chrome and shadows gone, cards whole", () => {
  assert.match(PRINT_CSS, /^\.print-url\{display:none\}/, "hidden on screen");
  const p = PRINT_CSS.slice(PRINT_CSS.indexOf("@media print{"));
  assert.match(p, /--g:#ffffff!important/);
  assert.match(p, /--bg:#ffffff!important/);
  assert.match(p, /--ink:#2a2520!important/);
  assert.match(p, /--pen:#9c3b2e!important/);
  assert.match(p, /--accent:#9c3b2e!important/);
  assert.doesNotMatch(p, /#d46a5c|#1c1814|#efe6d6/i, "no Night value on paper");
  assert.match(p, /color-scheme:light!important/);
  assert.match(p, /\.stamp,\.paid,[^{]*\{color:#9c3b2e!important\}/);
  assert.match(p, /box-shadow:none!important/);
  assert.match(p, /background-image:none!important/, "no grain");
  assert.match(p, /--grain:none!important/);
  const hidden = p.match(/\n(\.bar,[^{]*)\{display:none!important\}/)[1].split(",");
  for (const sel of [".bar", "header.top", ".theme", ".acts", ".typed", ".b2r", "form", ".player", ".tabs", ".composer", ".rel"]) {
    assert.ok(hidden.includes(sel), `hidden on paper: ${sel}`);
  }
  assert.match(p, /\.rcpt,[^{]*\.day li,[^{]*\.card,[^{]*\{break-inside:avoid/);
  assert.match(p, /\.print-url\{display:block!important;[^}]*font:400 9\.5px/);
});

test("the printed address: no scheme, no key, no fragment", () => {
  assert.equal(printableUrl("https://files.heyreason.com/abc?k=SECRET#x"), "files.heyreason.com/abc");
  assert.equal(printableUrl(""), "");
});

test("Reason Web pages print Paper on white with no grain", () => {
  const html = webPage({ title: "x", body: "<main>x</main>" });
  assert.ok(printBlock(html).includes(WEB_PRINT_CSS));
  assert.match(WEB_PRINT_CSS, /--ink:#2a2520!important/);
  assert.match(WEB_PRINT_CSS, /background-image:none!important/);
});

test("live routes: the owner's designed page and the event page print their canonical, keyless address", async () => {
  config.pagesV2 = true;
  config.events = true;
  try {
    const p = db.createPage(OWNER, { title: "Today, in five things.", blocks: [{ type: "day", items: [{ at: "5:30", title: "Con Ed paid", stamp: "paid" }] }] });
    db.startPageSession(p.id, "tokprint1", { conversationId: OWNER });
    const res = await pageRequest({ id: p.id, sub: null, key: null, method: "GET", headers: { cookie: "reason_page=tokprint1" }, readBody: async () => "" });
    assert.equal(res.status, 200);
    printsWell(res.body, `files.heyreason.test/${p.id}`, "owner day page");

    const ev0 = events.create(OWNER, { name: "Print party", description: "x", starts_at: "2026-11-14T16:00", location: "Hudson",
      password: "woodstove9", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true, timezone: "America/New_York" });
    const ev = db.getEventRow(ev0.event.id);
    const r = await eventRequestFor({ publicId: ev.public_id, sub: null, method: "GET", query: {}, headers: { cookie: "" }, remoteAddress: "127.0.0.1", readBody: async () => "" });
    assert.equal(r.status, 200);
    printsWell(r.body, printableUrl(events.eventUrl(ev)), "event page");
  } finally {
    config.pagesV2 = false;
  }
});
