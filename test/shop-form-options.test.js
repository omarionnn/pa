// A store's form asks a choice (Chipotle, 11-10 17:50–18:00: drop-off and tip). The words they gave
// ("leave at door", "$2 tip") must go to the store as the exact option it offered; Crossmint refuses
// anything else ("400 Answer does not match the requested form") and the order restarted after ~7 tries.
// An answer that matches no option is never sent: the model gets the options back to re-ask with.
// No network: Crossmint is a stand-in.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-shop-form-options-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "owner";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const shipping = await import("../src/shipping.js");
const shop = await import("../src/shopconnect.js");
const offers = await import("../src/offers.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const ULTA = "https://www.ulta.com/p/foaming-facial-cleanser-xlsImpprod5140065?sku=2541605";

// ---------------------------------------------------------------- a fake Crossmint
let calls, runs, nextRun, refuseAnswer;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? "GET", path: u.pathname, body });
  const p = u.pathname;
  if (p === "/api/unstable/agent-checkouts" && init.method === "POST") {
    const runId = `run_${nextRun++}`;
    runs[runId] = { status: "running", requiredAction: null, revision: 1, task: body.request.task };
    return reply(201, { runId });
  }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)(\/messages|\/cancel)?$/.exec(p);
  if (m && m[2]) {
    if (refuseAnswer && body?.parts?.[0]?.action === "submit") return reply(400, { error: true, message: refuseAnswer });
    return reply(202, { ok: true });
  }
  if (m) return runs[m[1]] ? reply(200, { runId: m[1], ...runs[m[1]] }) : reply(404, { error: true, message: `Checkout '${m[1]}' not found` });
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}`, status: "active" });
  // The rails read after the intent is made (2026-11-08): a card rail that is ready.
  if (/^\/api\/unstable\/order-intents\/[^/]+$/.test(p)) return reply(200, { orderIntentId: decodeURIComponent(p.split("/").pop()), status: "active", rails: [{ rail: "encrypted-card", status: "active", credentialFormats: ["card"] }] });
  return reply(404, { message: "no route" });
}
const said = [];
const woke = [];
const q = (sql) => db.db.prepare(sql);
const FULL = { first_name: "Omari", last_name: "Nyarko", address1: "3247 Bruner Ave", address2: "Apt 1", city: "Bronx", state: "NY", zip: "10469", phone: "7183062726", email: "omari@example.com" };
before(() => {
  shop._setFetch(fakeFetch);
  shop.attach({ say: (c, t) => said.push({ c, t }), wake: (c, t, { key }) => woke.push({ c, t, key }), base: "https://heyreason.test/web/connect" });
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; runs = {}; nextRun = 1; refuseAnswer = null; said.length = 0; woke.length = 0; clock.reset(); shop._setMail(null);
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping", "person_facts", "people", "oauth_tokens"]) db.db.exec(`DELETE FROM ${t}`);
});
const start = (what = "One CeraVe Foaming Facial Cleanser, 16 oz, shipped to the address on file.") => shop.startCheckout({ conversationId: OMARI, store: "ulta", startUrl: ULTA, what, item: "CeraVe Foaming Facial Cleanser 16 oz", maxUsd: 40 });
const row = (runId) => q("SELECT * FROM shop_runs WHERE run_id = ?").get(runId);
const posted = (runId) => calls.filter((c) => c.path === `/api/unstable/agent-checkouts/${runId}/messages` && c.body?.parts?.[0]?.action === "submit").map((c) => c.body.parts[0]);


const OPTS_DROPOFF = [{ value: "option-1", label: "Hand it to me" }, { value: "option-2", label: "Leave it at my door" }, { value: "option-3", label: "Meet outside" }];
const OPTS_TIP = [{ value: "tip-0", label: "No tip" }, { value: "tip-1", label: "$1.00" }, { value: "tip-2", label: "$2.00" }, { value: "tip-3", label: "$3.00" }, { value: "tip-15", label: "15%" }];
const CHIPOTLE_FORM = (requestId, dropoff = OPTS_DROPOFF) => ({ requestId, request: { question: "How should the courier drop it off, and how much tip?", expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
  interaction: { kind: "form", fields: [
    { key: "dropoff", label: "Drop-off", handling: "standard", input: { kind: "choice", selection: { kind: "one" }, options: dropoff }, required: true },
    { key: "tip", label: "Tip", handling: "standard", input: { kind: "choice", selection: { kind: "one" }, options: OPTS_TIP }, required: true },
  ] } } });
const atForm = async (form) => {
  const out = await start("A burrito bowl from Chipotle, delivered.");
  assert.ok(out.ok);
  runs[out.runId].requiredAction = form; runs[out.runId].revision = 2;
  await shop.step(out.runId);
  assert.equal(row(out.runId).stage, "needs_input");
  return out.runId;
};

test("free words map to the exact option values: 'leave at door' and '$2 tip'", async () => {
  const runId = await atForm(CHIPOTLE_FORM("req_chip"));
  const r = await shop.answerRun(runId, { conversationId: OMARI, answers: { dropoff: "leave at door", tip: "$2 tip" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = posted(runId);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].response.answers, { dropoff: "option-2", tip: "tip-2" });

  const fields = CHIPOTLE_FORM("r").request.interaction;
  assert.deepEqual(shop.shapeAnswers(fields, { dropoff: "Leave it at my door", tip: "2" }), { dropoff: "option-2", tip: "tip-2" });
  assert.deepEqual(shop.shapeAnswers(fields, { dropoff: "hand it to me", tip: "$2.00" }), { dropoff: "option-1", tip: "tip-2" });
  // The live label "Leave at door" too.
  const live = CHIPOTLE_FORM("r", [{ value: "HAND_TO_ME", label: "Hand to me" }, { value: "LEAVE_AT_DOOR", label: "Leave at door" }]).request.interaction;
  assert.deepEqual(shop.shapeAnswers(live, { dropoff: "leave it at the door", tip: "2 dollars" }), { dropoff: "LEAVE_AT_DOOR", tip: "tip-2" });
});

test("an answer matching no option is not sent: a re-ask listing the options comes back", async () => {
  const runId = await atForm(CHIPOTLE_FORM("req_chip2"));
  const r = await shop.answerRun(runId, { conversationId: OMARI, answers: { dropoff: "put it in the mailbox", tip: "$2" } });
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_matching_option");
  assert.equal(posted(runId).length, 0, "nothing the store would refuse is sent");
  assert.deepEqual(r.options, { dropoff: ["Hand it to me", "Leave it at my door", "Meet outside"] });
  assert.match(r.say, /Hand it to me[^]*Leave it at my door[^]*Meet outside/);
  assert.equal(row(runId).stage, "needs_input", "the checkout is still waiting, not restarted");
});
