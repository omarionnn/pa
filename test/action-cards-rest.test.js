// Action Cards under encryption at rest, phase 2 (src/restcrypt.js SENSITIVE2): a card's title, margin
// note and prefill, and a struck-out title, are sealed per person on disk and read back plain; the
// strict triggers accept every write path; a dismissed title is found through its blind index.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-action-cards-rest-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_REST2 = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "33".repeat(32);
process.env.REASON_TOKEN_KEY ||= "44".repeat(32);
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.REASON_ACTION_CARDS = "on";
process.env.SENDBLUE_FROM_NUMBER = "+14155550199";

const d = await import("../src/db.js");
const cards = await import("../src/actioncards.js");
const page = await import("../src/pages/actioncards.js");
const { SAMPLE_CARDS } = await import("../scripts/action-cards-seed.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const C = "dm:sendblue:+15550003333";

test("sealed on disk, plain when read, every write path passes strict mode, the struck title is found by its index", async () => {
  const dg = cards.createDigest(C, SAMPLE_CARDS);
  for (const col of ["title", "why_now", "prefill"]) {
    const raw = d.rawPrepare(`SELECT ${col} AS v FROM action_cards WHERE digest_id = ?`).all(dg.id).map(r => r.v);
    for (const v of raw) assert.match(v, /^enc:u1:/, `${col} is sealed`);
  }
  const back = cards.digestById(dg.id);
  assert.deepEqual(back.cards.map(c => c.title), SAMPLE_CARDS.map(c => c.title));
  assert.deepEqual(back.cards.map(c => c.prefill), SAMPLE_CARDS.map(c => c.prefill));
  // The page and the match read the plain words.
  const res = await page.actionCardsRequest({ method: "GET", path: `/a/${dg.token}` });
  assert.equal(res.status, 200);
  assert.match(res.body, /Replace your Anthropic key/);
  assert.equal(cards.matchInbound(C, [SAMPLE_CARDS[2].prefill]).card.id, dg.cards[2].id);
  assert.deepEqual(cards.openCards(C).map(c => c.prefill), SAMPLE_CARDS.map(c => c.prefill));
  // Dismiss: the remembered title is sealed, its key a blind index, and still found.
  cards.dismiss(dg.id, dg.cards[1].code);
  const row = d.rawPrepare("SELECT title_key, title FROM action_card_dismissed WHERE conversation_id = ?").get(C);
  assert.match(row.title, /^enc:u1:/);
  assert.match(row.title_key, /^bi1:/);
  assert.equal(cards.wasDismissed(C, "Plan your birthday dinner for Tue, Nov 24"), true);
  assert.equal(cards.wasDismissed("dm:sendblue:+15550004444", "Plan your birthday dinner for Tue, Nov 24"), false);
  assert.deepEqual(cards.dismissedTitles(C), ["Plan your birthday dinner for Tue, Nov 24"]);
  cards.markDone(dg.cards[0].id, C);
  assert.deepEqual(cards.digestById(dg.id).cards.map(c => c.status), ["done", "dismissed", "open"]);
  // Nothing plain is left in either table.
  const plain = (t, c) => d.rawPrepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} <> '' AND substr(${c}, 1, 7) <> 'enc:u1:'`).get().n;
  for (const c of ["title", "why_now", "prefill"]) assert.equal(plain("action_cards", c), 0, c);
  assert.equal(plain("action_card_dismissed", "title"), 0);
});
