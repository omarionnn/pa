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
process.env.REASON_ACCOUNT_JOBS = "owner";

const { chromium } = await import("playwright");
const proof = await import("../src/proofshot.js");
const db = await import("../src/db.js");
const data = await import("../src/data.js");
const browser = await import("../src/browser.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { isSealedFile } = await import("../src/restfiles.js");

const OMARI = "dm:owner";
const AMA = "dm:sendblue:+13475550000";
// Modelled on a real billing page: Plan / Payment / Invoices / Cancellation, one section each.
const SECTION = "padding:16px;margin:32px 24px;width:620px;border:1px solid #ccc";
const NOTICE = "Your subscription is set to cancel on Nov 27, 2026";
const BILLING = `<!doctype html><html><head><title>Billing</title></head><body style="margin:0;font:16px sans-serif">
  <header style="height:120px;background:#eee">Cardboard</header>
  <main>
  <section id="plan" style="${SECTION}"><h3>Plan</h3><p>Cardboard Starter</p><p>$12.00 per month</p></section>
  <section id="payment" style="${SECTION}"><h3>Payment</h3><p>Visa ending in 1929</p><p>Expires 08/28</p></section>
  <section id="invoices" style="${SECTION}"><h3>Invoices</h3><table><tr><td>Oct 27, 2026</td><td>$12.00</td><td>Paid</td></tr></table></section>
  <section id="cancellation" style="${SECTION}"><h3>Cancellation</h3><p>${NOTICE}</p><p>You keep access until then.</p></section>
  </main><footer style="height:900px;background:#ddd">Help</footer></body></html>`;
const RECEIPT_LINE = "Confirmation number: CE-88123";
const RECEIPT = `<!doctype html><html><head><title>Payment complete</title></head><body style="margin:0;font:16px sans-serif"><main>
  <section id="method" style="${SECTION}"><h3>Paid with</h3><p>Visa ending in 1929</p></section>
  <section id="receipt" style="${SECTION}"><h3>Payment received</h3><p>Amount paid: $82.10</p><p>${RECEIPT_LINE}</p><p>Account 44-1234-5678-9</p></section>
  </main></body></html>`;
// What the picture holds: every leaf element whose box meets the crop, and the crop against a section's box.
const inCrop = (p, c) => p.evaluate((c) => [...document.querySelectorAll("body *")].filter((e) => !e.children.length).filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.left < c.x + c.width && b.right > c.x && b.top < c.y + c.height && b.bottom > c.y; }).map((e) => e.innerText).join(" | "), c);
const meets = (p, sel, c) => p.evaluate(([s, c]) => { const b = document.querySelector(s).getBoundingClientRect(); return b.left < c.x + c.width && b.right > c.x && b.top < c.y + c.height && b.bottom > c.y; }, [sel, c]);
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

test("the billing page: the picture is the Cancellation notice block only; Payment, Invoices and Plan are outside it", async () => {
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING);
  const out = await proof.captureProof(OMARI, page, { proves: "cancellation", focus: NOTICE, what: "Cardboard Starter set to cancel" });
  assert.equal(out.ok, true, JSON.stringify(out));
  for (const sel of ["#payment", "#invoices", "#plan", "header"]) assert.equal(await meets(page, sel, out.clip), false, `${sel} is outside the crop`);
  assert.equal(await meets(page, "#cancellation", out.clip), true);
  const words = await inCrop(page, out.clip);
  assert.match(words, /Cancellation \| Your subscription is set to cancel on Nov 27, 2026 \| You keep access until then\./);
  assert.ok(!/1929|Visa|Invoices|\$12\.00|Oct 27/.test(words), words);
  const raw = readFileSync(out.file);
  assert.ok(isSealedFile(raw), "sealed on disk");
  const plain = proof.proofBytes(OMARI, out.id);
  assert.equal(plain[0], 0xff, "a jpeg");
  const size = jpegSize(plain);
  assert.ok(size.width <= 700 && size.height <= 200, `the notice block, not the page: ${JSON.stringify(size)}`);
  assert.ok(plain.length <= proof.MAX_BYTES);
  assert.equal(proof.proofRow(OMARI, out.id).host, "billing.cardboard.test");
  assert.ok(db.db.prepare("SELECT 1 FROM conversation_files WHERE conversation_id = ? AND path = ?").get(OMARI, out.file), "theirs on the file record");
  // Another person can never find or open it.
  assert.equal(proof.proofRow(AMA, out.id), null);
  assert.equal(proof.proofBytes(AMA, out.id), null);
  assert.equal(proof.proofsFor(AMA).length, 0);
});

test("a bill paid: the receipt block is the picture, amount and confirmation number in, the card row out", async () => {
  await serve(page, "https://pay.coned.test/receipt", RECEIPT);
  const out = await proof.captureProof(OMARI, page, { proves: "payment", focus: RECEIPT_LINE });
  assert.equal(out.ok, true, JSON.stringify(out));
  const words = await inCrop(page, out.clip);
  assert.match(words, /Amount paid: \$82\.10/);
  assert.match(words, /CE-88123/);
  assert.ok(!/1929|Visa/.test(words), words);
  assert.equal(await meets(page, "#method", out.clip), false);
  // The same block for a cancellation claim: the amount is not its claim, so only the line itself would do,
  // and it is cropped tight to that line.
  const tight = await proof.captureProof(OMARI, page, { proves: "confirmation_number", focus: RECEIPT_LINE });
  assert.equal(tight.ok, true);
  assert.equal(await inCrop(page, tight.clip), RECEIPT_LINE);
});

test("text is enough: a routine success, or anything not in the table, takes no picture", async () => {
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING);
  const n = proof.proofsFor(OMARI).length;
  for (const proves of ["signed_in", "loading", "status", "other", "", "anything"]) {
    assert.deepEqual(await proof.captureProof(OMARI, page, { proves, focus: NOTICE }), { ok: false, refused: "text_only" }, proves);
  }
  assert.equal(proof.proofsFor(OMARI).length, n);
  assert.deepEqual(Object.keys(proof.PICTURE_FOR), ["cancellation", "payment", "plan_change", "confirmation_number", "site_error"]);
  assert.equal(proof.pictureForJob({ kind: "cancel", outcome: "already_done" }), "cancellation");
  assert.equal(proof.pictureForJob({ kind: "bill", outcome: "done" }), "payment");
  assert.equal(proof.pictureForJob({ kind: "cancel", outcome: "site_error" }), "site_error");
  for (const outcome of ["not_found", "stopped", "declined", "no_signin", "nothing_paid", "service_failed", ""]) assert.equal(proof.pictureForJob({ kind: "cancel", outcome }), null, outcome);
});

test("the proving line can't be found, or can't be cut clear of the payment rows: no picture, never the page or the screen", async () => {
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING);
  const n = proof.proofsFor(OMARI).length;
  assert.deepEqual(await proof.captureProof(OMARI, page, { proves: "cancellation", focus: "Your plan renews on Dec 1" }), { ok: false, refused: "not_located" });
  assert.deepEqual(await proof.captureProof(OMARI, page, { proves: "cancellation", focus: "" }), { ok: false, refused: "no_line" });
  // The notice in the same line as the card: nothing clean to cut.
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING.replace(`<p>${NOTICE}</p>`, `<p>${NOTICE}. Visa ending in 1929 will not be charged.</p>`));
  assert.deepEqual(await proof.captureProof(OMARI, page, { proves: "cancellation", focus: NOTICE }), { ok: false, refused: "kept_out" });
  // An email address in the notice block itself.
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING.replace("You keep access until then.", "We emailed someone@example.com"));
  const e = await proof.captureProof(OMARI, page, { proves: "cancellation", focus: NOTICE });
  assert.equal(e.ok, true, "shrunk to the line, without the email row");
  assert.ok(!/@/.test(await inCrop(page, e.clip)));
  assert.equal(proof.proofsFor(OMARI).length, n + 1);
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
    const out = await proof.captureProof(OMARI, page, { proves: "cancellation", focus: "Welcome back" });
    assert.deepEqual(out, { ok: false, refused: why }, `${url} ${html}`);
  }
  assert.equal(proof.proofsFor(OMARI).length, before, "nothing kept for a refused page");
  // Last 4 as the page prints it, an invoice number and a utility account number are fine.
  assert.equal(proof.wordsRefused("Visa ending in 4242 · Invoice 2026-1027-0042 · Account 44-1234-5678-9"), "");
  assert.equal(proof.hasCardNumber("4111 1111 1111 1111"), true);
  assert.equal(proof.hasCardNumber("Order 1234 5678 9012 3456"), false, "not Luhn");
});

test("a secret box that is not shown is still covered in the picture", async () => {
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING.replace("You keep access until then.</p>", 'You keep access until then.</p><input type=password style="display:none" value="hunter2">'));
  const out = await proof.captureProof(OMARI, page, { proves: "cancellation", focus: NOTICE });
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
  const ctx = { conversationId: OMARI, channels: router, messages: [] };
  // A routine success: text only, nothing sent.
  const routine = await runTool("browser_proof", { proves: "signed_in", say: "You're signed in.", page_line: NOTICE }, ctx);
  assert.equal(routine.ok, false);
  assert.equal(routine.text_only, true);
  // A sign-in page: refused, nothing sent.
  await serve(p, "https://cardboard.test/signin", "<!doctype html><p>Your subscription is set to cancel</p>");
  const no = await runTool("browser_proof", { proves: "cancellation", say, page_line: "Your subscription is set to cancel" }, ctx);
  assert.equal(no.refused, "sign_in_page");
  assert.equal(sent.length, 0);
  await serve(p, "https://billing.cardboard.test/settings/billing", BILLING);
  const out = await runTool("browser_proof", { proves: "cancellation", say: `${say} https://evil.test/x`, page_line: NOTICE }, ctx);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(sent.length, 1, "one picture");
  assert.equal(sent[0].to, "+12025551234", "their own thread's address, never one the model typed");
  assert.equal(sent[0].text, say, "the line, with no link");
  assert.equal(sent[0].mimeType, "image/jpeg");
  assert.equal(proof.proofRow(OMARI, out.proof_id).sent, 1);
  assert.ok(!/Visa|1929|Invoices|Cardboard Starter/.test(JSON.stringify(out)), "no page words back to the model");
  // One picture per result.
  const again = await runTool("browser_proof", { proves: "cancellation", say, page_line: NOTICE }, ctx);
  assert.equal(again.text_only, true);
  assert.equal(sent.length, 1);
});

test("export carries their pictures; a delete unlinks them and takes the rows; another person's stay", async () => {
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING);
  const theirs = await proof.captureProof(AMA, page, { proves: "cancellation", focus: NOTICE });
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

test("retention: a picture older than the content window goes, file and row, like a document", async () => {
  const { config, clock } = await import("../src/config.js");
  const { sweepRetention } = await import("../src/privacy.js");
  await serve(page, "https://billing.cardboard.test/settings/billing", BILLING);
  const out = await proof.captureProof(OMARI, page, { proves: "cancellation", focus: NOTICE });
  const was = config.keepContentDays;
  config.keepContentDays = 30;
  try {
    assert.equal(sweepRetention({ now: clock.now() + 29 * 86_400_000 }).deleted.proof_pictures, undefined, "inside the window: kept");
    // Theirs (this one) and the other person's left from the delete test: both past the window.
    assert.equal(sweepRetention({ now: clock.now() + 31 * 86_400_000 }).deleted.proof_pictures, 2);
  } finally { config.keepContentDays = was; }
  assert.equal(existsSync(out.file), false);
  assert.equal(proof.proofRow(OMARI, out.id), null);
});

test("another person's data: a crop naming someone they have on record is no picture; a name nobody has on record stays", async () => {
  const FAMILY = `<!doctype html><html><head><title>Members</title></head><body style="margin:0;font:16px sans-serif"><main>
  <section id="members" style="${SECTION}"><h3>Plan members</h3><p>Kwabena Asante — Premium, cancelled</p><p>${NOTICE}</p></section>
  </main></body></html>`;
  db.db.prepare("INSERT INTO people (conversation_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(OMARI, "Kwabena Asante", "kwabena-asante", Date.now(), Date.now());
  assert.ok(proof.otherNames(OMARI).includes("kwabena"));
  assert.equal(proof.otherNames(AMA).includes("kwabena"), false, "only their own record");
  await serve(page, "https://family.cardboard.test/members", FAMILY);
  const out = await proof.captureProof(OMARI, page, { proves: "cancellation", focus: NOTICE });
  assert.deepEqual(out, { ok: false, refused: "other_person" });
  assert.match(proof.refusedLine("other_person"), /someone else's details/);
  // Ama has no such person on record: the same page is her own picture to take.
  const hers = await proof.captureProof(AMA, page, { proves: "cancellation", focus: NOTICE });
  assert.equal(hers.ok, true, JSON.stringify(hers));
  assert.equal(proof.namesOther("Kwabenaville plan", ["kwabena"]), false, "a whole name, not part of a word");
});

test("never by voice: account jobs and the proof picture are refused on a call, before anything runs", async () => {
  const tools = await import("../src/tools.js");
  for (const name of ["account_bill_pay", "account_cancel", "account_signin", "account_job_answer", "browser_proof"]) {
    const out = await runTool(name, {}, { conversationId: OMARI, kind: "user", messages: [], onCall: 7 });
    assert.equal(out.blocked, "never_by_voice", name);
    assert.match(out.error, /by text right after/);
  }
  assert.ok(tools.NEVER_BY_VOICE.has("account_bill_pay"));
});

test("the proof picture follows the account-jobs switch: owner-only as set, nobody with it off", async () => {
  const tools = await import("../src/tools.js");
  assert.equal(tools.proofAllowedFor(OMARI), true);
  assert.equal(tools.proofAllowedFor(AMA), false);
  const theirs = await runTool("browser_proof", { proves: "cancellation", say: "Set to cancel.", page_line: NOTICE }, { conversationId: AMA, messages: [] });
  assert.equal(theirs.blocked, "not_enabled");
  process.env.REASON_ACCOUNT_JOBS = "off";
  try { assert.equal(tools.proofAllowedFor(OMARI), false); } finally { process.env.REASON_ACCOUNT_JOBS = "owner"; }
});
