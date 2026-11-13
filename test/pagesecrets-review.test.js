// Review of the typed-secrets fix (#531): what an errand needs from a page still comes through, and
// reading a long page costs what it did before.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pagesecrets-review-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_TZ = "America/New_York";

const browser = await import("../src/browser.js");
const { chromium } = await import("playwright");

let b, page;
before(async () => { b = await chromium.launch(); page = await b.newPage(); });
after(async () => { await b?.close(); rmSync(dir, { recursive: true, force: true }); });

test("a long page is read with one pass over its labels, not one walk of the page per box", async () => {
  let html = "<!doctype html><html><body><form>";
  for (let i = 0; i < 600; i++) html += `<input type="hidden" id="h${i}" name="h${i}" value="v${i}">`;
  for (let i = 0; i < 200; i++) html += `<div><label for="q${i}">Quantity ${i}</label><input type="number" id="q${i}" name="qty${i}" value="1"></div>`;
  html += `<label for="pw">Password</label><input type="password" id="pw" value="Review-Secret-71"></form>`;
  for (let i = 0; i < 2000; i++) html += `<div>Item ${i} $${i}.99</div>`;
  await page.setContent(html + "</body></html>");
  await page.evaluate(() => {
    const qsa = Document.prototype.querySelectorAll;
    window.__qsa = 0;
    Document.prototype.querySelectorAll = function (...a) { window.__qsa++; return qsa.apply(this, a); };
  });
  const snap = await browser.snapshot(page);
  const walks = await page.evaluate(() => window.__qsa);
  assert.ok(walks <= 10, `document.querySelectorAll ran ${walks} times for one reading`);
  assert.equal(JSON.stringify(snap).includes("Review-Secret-71"), false);
  assert.equal(snap.elements.find(e => e.name === "Quantity 0")?.value, "1", "an ordinary box keeps its value");
});

test("a three-digit card code does not take a whole-dollar total out of the page; a bare copy of it still goes", async () => {
  await page.setContent(`<!doctype html><html><body><form>
    <label for="cvv">CVV</label><input id="cvv" name="cvv" value="123">
    <label for="zip">ZIP code</label><input id="zip" name="zip" value="10001"></form>
    <p>Order total: $123</p><p>Total 123 €</p><p>You typed 123 here</p></body></html>`);
  const snap = await browser.snapshot(page);
  assert.ok(snap.text.includes("$123"), "the total stays in the reading");
  assert.ok(snap.text.includes("123 €"), "a total written after its number stays too");
  assert.ok(snap.text.includes("You typed [hidden] here"), "a bare copy of the card code is cut");
  assert.ok((await browser.pageText(page)).includes("$123"), "and in the text the spend guard reads");
  assert.equal(snap.elements.find(e => e.name === "CVV")?.secret, true);
  assert.equal(snap.elements.find(e => e.name === "ZIP code")?.value, "10001");
});

test("the boxes errands fill are read back as they are: codes, numbers, addresses, answers", async () => {
  const boxes = [
    ["Promo code", "SAVE20"], ["Coupon", "TAKE10"], ["Gift code", "GIFT22"], ["Reservation number", "R12345678"],
    ["Confirmation number", "CNF55443"], ["Confirmation code", "ABC123"], ["Booking reference", "XYZ789"],
    ["ZIP code", "10001"], ["Postal code", "SW1A 1AA"], ["Pincode", "560001"], ["Phone number", "2025550123"],
    ["Mobile number (we'll text you a code)", "2025550124"], ["Address line 1", "123 Main St"], ["Apartment, suite, etc.", "Apt 4B"],
    ["Quantity", "2"], ["Flight number", "UA123"], ["Answer to your security question", "Fluffy"], ["Gate code", "1234"],
    ["Access code", "778899"], ["Member ID", "M998877"], ["Order number", "112-3344556-7788990"], ["Name on card", "Ada Lovelace"],
    ["Party size", "2"], ["Pickup code", "PK9988"], ["Delivery instructions", "Leave at door"], ["Date of birth", "01/02/1990"],
  ];
  let html = "<!doctype html><html><body><h1>Checkout</h1><p>We'll text you when your order is on its way.</p><form>";
  boxes.forEach(([label, v], i) => { html += `<label for="b${i}">${label}</label><input id="b${i}" name="f${i}" value="${v}"><br>`; });
  await page.setContent(html + "</form></body></html>");
  const snap = await browser.snapshot(page);
  for (const [label, v] of boxes) {
    const el = snap.elements.find(e => e.name === label);
    assert.ok(el, `${label} is in the reading`);
    assert.equal(el.secret, undefined, `${label} is not called a secret box`);
    assert.equal(el.value, v, `${label} keeps its value`);
  }
});
