// Every link a person sees or lands on is on heyreason.com (or its files./events. subdomains), never
// the server's own REASON_PUBLIC_URL (owner rule, 2026-11-01). Machine webhooks keep REASON_PUBLIC_URL.
//
// Pinned: Stripe's success/cancel addresses, the remote sign-in link, the contact card, a document's
// link, generated pictures, the privacy link. Each fails on 1bde8bc, where publicUrl came first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-site-links-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_TOKEN_KEY = "55".repeat(32);
process.env.REASON_PUBLIC_URL = "https://reason.tail.example.test";
process.env.REASON_SITE_URL = "https://heyreason.example.test";
process.env.REASON_PAGES_URL = "https://files.heyreason.example.test";
process.env.REASON_EVENTS_URL = "https://events.heyreason.example.test";
process.env.REASON_PAYWALL = "on";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_PRICE_ID = "price_test_2499";
process.env.STRIPE_PAYMENT_LINK_URL = "";

const { config } = await import("../src/config.js");
const plan = await import("../src/plan.js");
const remote = await import("../src/signin-remote.js");
const { contactCardUrl } = await import("../src/contact.js");
const { documentUrl } = await import("../src/documents/store.js");
const { imageBase } = await import("../src/pages/pictures.js");
const { privacyUrl } = await import("../src/google.js");
const { eventUrl } = await import("../src/events.js");

const SERVER = "reason.tail.example.test";

test("Stripe sends a person back to the website, never the server", async () => {
  let form = null;
  const fetchImpl = async (url, init) => {
    assert.match(String(url), /\/v1\/checkout\/sessions$/);
    form = Object.fromEntries(new URLSearchParams(init.body));
    return { ok: true, status: 200, json: async () => ({ id: "cs_test_links", url: "https://checkout.stripe.test/c/pay/cs_test_links#x" }) };
  };
  const link = await plan.payLink("dm:+14155550100", { fetchImpl });
  assert.match(link, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(form.success_url, "https://heyreason.example.test/pay/done");
  assert.equal(form.cancel_url, "https://heyreason.example.test/pay/back");
});

test("the remote sign-in link is on the website", () => {
  const out = remote.createRemoteSignin({ conversationId: "dm:+14155550100", entry: { site: "amazon", url: "https://amazon.example.test/signin" }, launch: async () => { throw new Error("not launched"); } });
  assert.equal(out.ok, true);
  assert.match(out.url, /^https:\/\/heyreason\.example\.test\/s\/[A-Za-z0-9_-]+$/);
  assert.equal(out.reachable_from_a_phone, true);
  remote.forgetAllRemoteSignins();
});

test("the contact card, a document, a picture and the privacy link all live on heyreason.com", () => {
  assert.match(contactCardUrl(), /^https:\/\/files\.heyreason\.example\.test\/reason-[0-9a-f]{8}\.vcf$/);
  assert.equal(documentUrl({ id: "doc_12345678", owner_key: "k1" }), "https://files.heyreason.example.test/f/doc_12345678?k=k1");
  assert.equal(imageBase(), "https://files.heyreason.example.test/img/");
  assert.equal(privacyUrl(), "https://heyreason.example.test/privacy");
  assert.equal(eventUrl({ public_id: "evt12345678" }), "https://events.heyreason.example.test/e/evt12345678");
});

test("without a website or files domain the server's own address still works", () => {
  const was = { site: config.siteUrl, pages: config.pagesUrl };
  config.siteUrl = ""; config.pagesUrl = "";
  try {
    assert.equal(documentUrl({ id: "doc_12345678", owner_key: "k1" }), `https://${SERVER}/f/doc_12345678?k=k1`);
    assert.equal(imageBase(), `https://${SERVER}/img/`);
    assert.match(contactCardUrl(), new RegExp(`^https://${SERVER.replace(/\./g, "\\.")}/reason-`));
    assert.equal(privacyUrl(), `https://${SERVER}/privacy`);
    config.publicUrl = "";
    assert.equal(contactCardUrl(), null);
  } finally {
    config.siteUrl = was.site; config.pagesUrl = was.pages; config.publicUrl = `https://${SERVER}`;
  }
});
