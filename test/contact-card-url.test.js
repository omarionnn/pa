// Pinned (10-25): Sendblue/iMessage can reuse a copy of a card URL they already fetched, so a
// card whose photo changed at the same address could arrive with the old photo. The address is
// the card's own hash: change the photo, change the URL.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "reason-card-url-"));
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
after(() => rmSync(dir, { recursive: true, force: true }));

const router = { get: () => ({ status: () => ({ number: "+16562167455" }) }) };

// A copy of src/ + assets/ with a different photo, so the module reads the changed bytes fresh.
async function urlWithPhoto(bytes) {
  const root = mkdtempSync(join(dir, "copy-"));
  const { cpSync } = await import("node:fs");
  cpSync(new URL("../src", import.meta.url), join(root, "src"), { recursive: true });
  cpSync(new URL("../assets", import.meta.url), join(root, "assets"), { recursive: true });
  cpSync(new URL("../package.json", import.meta.url), join(root, "package.json"));
  if (bytes) writeFileSync(join(root, "assets", "reason-contact.jpg"), bytes);
  const m = await import(pathToFileURL(join(root, "src", "contact.js")).href);
  return m.contactCardUrl({ router, channel: "sendblue" });
}

test("changing the photo changes the card's URL", async () => {
  const photo = readFileSync(new URL("../assets/reason-contact.jpg", import.meta.url));
  const same = await urlWithPhoto(null);
  const changed = await urlWithPhoto(Buffer.concat([photo, Buffer.from([0])]));
  assert.match(same, /^https:\/\/reason\.example\.test\/reason-[0-9a-f]{8}\.vcf$/);
  assert.match(changed, /^https:\/\/reason\.example\.test\/reason-[0-9a-f]{8}\.vcf$/);
  assert.notEqual(changed, same, "a new photo must be a new address");
  assert.equal(await urlWithPhoto(null), same, "the same card is the same address");
});
