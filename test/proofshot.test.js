// Proof pictures (src/proofshot.js, browser_proof): one picture of the page a job finished on, in
// Reason's OWN browser, sent to the person's own thread and kept sealed on their record. A real
// Chromium on pages served by page.route (no network); a fake texting channel; no API key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-proofshot-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_REST2 = "on";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "35".repeat(32);
process.env.REASON_TOKEN_KEY ||= "45".repeat(32);
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { chromium } = await import("playwright");
const proof = await import("../src/proofshot.js");
const db = await import("../src/db.js");
const data = await import("../src/data.js");
const browser = await import("../src/browser.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { isSealedFile } = await import("../src/restfiles.js");

const OMARI = "dm:owner";
const AMA = "dm:sendblue:+13475550000";
const BILLING = `<!doctype html><html><head><title>Billing</title></head><body style="margin:0;font:16px sans-serif">
  <header style="height:300px;background:#eee">Cardboard</header>
  <section id="plan" style="padding:24px;width:600px"><h2>Cardboard Starter</h2><p>$12.00 per month</p>
    <p>Your subscription is set to cancel on Nov 27, 2026</p><p>Last invoice: Oct 27, 2026, $12.00, Visa ending in 4242</p></section>
  <footer style="height:900px;background:#ddd">Help</footer></body></html>`;
let b, page;
const serve = async (p, url, html) => { await p.route(url, (r) => r.fulfill({ status: 200, contentType: "text/html", body: html })); await p.goto(url); };
const jpegSize = (buf) => { // the SOF0/SOF2 frame's height and width
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xc0 || m === 0xc2) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
};

before(async () => {
  b = await chromium.launch();
  page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "test", address: "+13475550000", name: "Ama" });
});
after(async () => { await b?.close(); await browser.closeAllBrowsers(); rmSync(dir, { recursive: true, force: true }); });

test("the billing page: one picture, cropped to the section holding the page's line, capped, sealed and on their record only", async () => {
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING);
  const out = await proof.captureProof(OMARI, page, { focus: "Your subscription is set to cancel on Nov 27, 2026", what: "Cardboard Starter set to cancel" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.cropped, true);
  const raw = readFileSync(out.file);
  assert.ok(isSealedFile(raw), "sealed on disk");
  const plain = proof.proofBytes(OMARI, out.id);
  assert.equal(plain[0], 0xff, "a jpeg");
  const size = jpegSize(plain);
  assert.ok(size.width <= 700 && size.height < 400, `cropped to the plan section, not the page: ${JSON.stringify(size)}`);
  assert.ok(plain.length <= proof.MAX_BYTES);
  assert.equal(proof.proofRow(OMARI, out.id).host, "billing.cardboard.test");
  assert.ok(db.db.prepare("SELECT 1 FROM conversation_files WHERE conversation_id = ? AND path = ?").get(OMARI, out.file), "theirs on the file record");
  // Another person can never find or open it.
  assert.equal(proof.proofRow(AMA, out.id), null);
  assert.equal(proof.proofBytes(AMA, out.id), null);
  assert.equal(proof.proofsFor(AMA).length, 0);
});

test("no line to crop to: the viewport only, never the whole scrolled page", async () => {
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING);
  const out = await proof.captureProof(OMARI, page, {});
  assert.equal(out.ok, true);
  assert.equal(out.cropped, false);
  const size = jpegSize(proof.proofBytes(OMARI, out.id));
  assert.ok(size.height <= 900 && size.width <= 1280, JSON.stringify(size));
});

test("never a sign-in page, never a page with a secret box, never a full card or bank number", async () => {
  const cases = [
    ["https://cardboard.test/login", "<p>Welcome back</p>", "sign_in_page"],
    ["https://cardboard.test/account", "<title>Sign in to Cardboard</title><p>hi</p>", "sign_in_page"],
    ["https://cardboard.test/account", "<p>Confirm</p><input type=password id=p>", "secret_box"],
    ["https://cardboard.test/account", '<label for=c>Verification code</label><input id=c autocomplete="one-time-code">', "secret_box"],
    ["https://cardboard.test/billing", '<label for=n>Card number</label><input id=n autocomplete="cc-number">', "secret_box"],
    ["https://cardboard.test/billing", "<p>Card on file: 4242 4242 4242 4242</p>", "card_number"],
    ["https://cardboard.test/billing", "<p>Card ending in 4242. CVC 123</p>", "card_code"],
    ["https://cardboard.test/billing", "<p>Paying from routing number 021000021</p>", "bank_number"],
  ];
  const before = proof.proofsFor(OMARI).length;
  for (const [url, html, why] of cases) {
    await serve(page, url, `<!doctype html><html><body>${html}</body></html>`);
    const out = await proof.captureProof(OMARI, page, {});
    assert.deepEqual(out, { ok: false, refused: why }, `${url} ${html}`);
  }
  assert.equal(proof.proofsFor(OMARI).length, before, "nothing kept for a refused page");
  // Last 4 as the page prints it, an invoice number and a utility account number are fine.
  assert.equal(proof.wordsRefused("Visa ending in 4242 · Invoice 2026-1027-0042 · Account 44-1234-5678-9"), "");
  assert.equal(proof.hasCardNumber("4111 1111 1111 1111"), true);
  assert.equal(proof.hasCardNumber("Order 1234 5678 9012 3456"), false, "not Luhn");
});

test("a secret box that is not shown is still covered in the picture", async () => {
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING.replace("</section>", '<input type=password style="display:none" value="hunter2"></section>'));
  const out = await proof.captureProof(OMARI, page, { focus: "Your subscription is set to cancel on Nov 27, 2026" });
  assert.equal(out.ok, true);
  assert.equal(await page.locator("[data-reason-secret]").count(), 1, "marked, so the screenshot masks it");
});

test("browser_proof: the picture and the result line go to their own thread as one message; nothing of the page comes back to the model", async () => {
  assert.ok(toolsFor(OMARI).some((t) => t.name === "browser_proof"));
  db.upsertThread({ conversationId: OMARI, channel: "test", address: "+12025551234", isOwner: true });
  const p = await browser.pageFor(OMARI);
  await serve(p, "https://billing.cardboard.test/settings/billing", BILLING);
  const sent = [];
  const router = { get: () => ({ carriesFiles: true }), list: () => [{ name: "test" }], async sendMedia(m) { sent.push(m); return { ok: true, delivered: { message_id: "m1" } }; } };
  const say = "Cardboard Starter was already set to cancel on Nov 27, so I didn't change anything; you keep access until then.";
  const out = await runTool("browser_proof", { say: `${say} https://evil.test/x`, page_line: "Your subscription is set to cancel on Nov 27, 2026" }, { conversationId: OMARI, channels: router, messages: [] });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(sent.length, 1, "one picture");
  assert.equal(sent[0].to, "+12025551234", "their own thread's address, never one the model typed");
  assert.equal(sent[0].text, say, "the line, with no link");
  assert.equal(sent[0].mimeType, "image/jpeg");
  assert.equal(proof.proofRow(OMARI, out.proof_id).sent, 1);
  assert.ok(!/subscription is set|Cardboard Starter|Visa/.test(JSON.stringify(out)), "no page words back to the model");
  // A sign-in page: refused, nothing sent.
  await serve(p, "https://cardboard.test/signin", "<!doctype html><p>hi</p>");
  const no = await runTool("browser_proof", { say }, { conversationId: OMARI, channels: router, messages: [] });
  assert.equal(no.ok, false);
  assert.equal(no.refused, "sign_in_page");
  assert.equal(sent.length, 1);
});

test("export carries their pictures; a delete unlinks them and takes the rows; another person's stay", async () => {
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING);
  const theirs = await proof.captureProof(AMA, page, { focus: "Your subscription is set to cancel on Nov 27, 2026" });
  const mine = proof.proofsFor(OMARI);
  assert.ok(mine.length >= 2);
  const ex = data.exportData({ conversation: OMARI });
  assert.equal(ex.proof_pictures.length, mine.length);
  assert.ok(ex.proof_pictures.every((x) => x.file_base64 && Buffer.from(x.file_base64, "base64")[0] === 0xff), "plain jpeg bytes in the export");
  assert.ok(ex.tables.proof_pictures.length === mine.length);
  const gone = await data.deleteData({ conversation: OMARI });
  assert.equal(gone.proof_pictures.files_deleted, mine.length);
  for (const r of mine) assert.equal(existsSync(r.file), false);
  assert.equal(proof.proofsFor(OMARI).length, 0);
  assert.ok(existsSync(theirs.file), "somebody else's picture is left alone");
  assert.equal(proof.proofsFor(AMA).length, 1);
});
