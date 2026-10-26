// The forwarded invite link's card (owner, 2026-10-25): "<Name> thinks you should join reason" in the
// homepage's italic serif, "Free for you, for good." in the site's orange handwriting, on the site's
// paper. One picture per inviter name, drawn once and kept; the fonts ride inline.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-invite-card-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
const card = await import("../src/invitecard.js");
const { PAPER, BRAND_ORANGE } = await import("../src/pages/brand.js");
const { config } = await import("../src/config.js");
after(() => rmSync(dir, { recursive: true, force: true }));

test("the card says who, in the headline face, with the handwritten line in brand orange on the site's paper", () => {
  const html = card.inviteCardHtml("Kofi");
  assert.match(html, /<h1>Kofi thinks you should join <span class="wordmark"/, "the inviter's name, then the wordmark");
  assert.match(html, /<p class="hand">Free for you, for good\.<\/p>/);
  assert.match(html, /@font-face\{font-family:"Card Serif";font-style:italic;font-weight:400;src:url\(data:font\/woff2;base64,/, "Instrument Serif italic inline, no network");
  assert.match(html, /@font-face\{font-family:"Card Hand";font-weight:400;src:url\(data:font\/woff2;base64,/, "Caveat inline");
  assert.ok(html.includes(`color:${BRAND_ORANGE}`), "handwriting in brand orange");
  assert.ok(html.includes(PAPER.bg), "the site's paper");
  assert.doesNotMatch(html, /fonts\.googleapis/);
});

test("a name is escaped, never markup", () => {
  assert.match(card.inviteCardHtml("<b>Ama</b>"), /<h1>&lt;b&gt;Ama&lt;\/b&gt; thinks/);
});

test("drawn once per name and kept; a new name is a new card; the key moves with the design version", async () => {
  let shots = 0;
  const shoot = async () => { shots++; return Buffer.from("png"); };
  assert.equal(String(await card.inviteCard("Kofi", { shoot })), "png");
  await card.inviteCard("Kofi", { shoot });
  assert.equal(shots, 1, "second ask reads the kept file");
  await card.inviteCard("Ama", { shoot });
  assert.equal(shots, 2);
  assert.equal(readdirSync(join(config.dataDir, "invite-cards")).length, 2);
  assert.notEqual(card.inviteCardKey("Kofi"), card.inviteCardKey("Ama"));
  assert.match(card.inviteCardKey("Kofi"), /^[0-9a-f]{16}$/);
});

test("preview bots asking at once for a new name share one drawing", async () => {
  let shots = 0;
  const shoot = async () => { shots++; await new Promise(r => setTimeout(r, 20)); return Buffer.from("png"); };
  const all = await Promise.all([1, 2, 3, 4].map(() => card.inviteCard("Esi", { shoot })));
  assert.equal(shots, 1);
  assert.ok(all.every(b => String(b) === "png"));
});
