// "Secured by Reason" link cards (src/pages/securedcard.js, owner ask 2026-11-10): every link Reason
// texts that connects an account, saves a card, signs in or approves a payment unfurls as one card
// with the action under it. What these hold:
//   1. every kind has its tags (og:title/og:image 1200×630/twitter:card) and a real 1200×630 PNG
//      served at the address the tags name, cached; anything else under that path is not served;
//   2. the tags name the action only (no og:url, so no token), and escape what they print;
//   3. the pages a cookieless preview fetcher reads carry the right card: the OAuth start gate per
//      provider, its "link expired" page, Spotify's join page, a remote sign-in page, the card link,
//      an unknown connect link. (Approve and store sign-in: test/passkey-pay.test.js, shopconnect.test.js.)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-secured-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.REASON_SHOP_CONNECT = "owner";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const sc = await import("../src/pages/securedcard.js");
const db = await import("../src/db.js");
const { connectStartRequest } = await import("../src/connectgate.js");
const spotify = await import("../src/spotify.js");
const remote = await import("../src/signin-remote.js");
const shop = await import("../src/shopconnect.js");
const { connectRequest } = await import("../src/pages/webconnect.js");

after(() => rmSync(dir, { recursive: true, force: true }));

const headOf = (html) => String(html).slice(0, String(html).indexOf("<title>"));
const tag = (html, prop) => new RegExp(`<meta (?:property|name)="${prop.replace(/[.:]/g, "\\$&")}" content="([^"]*)">`).exec(html)?.[1];

test("every kind: full tags, and a 1200×630 PNG at the address they name", () => {
  for (const kind of Object.keys(sc.SECURED_CARDS)) {
    const t = sc.securedCardTags(kind);
    assert.equal(tag(t, "og:title"), sc.SECURED_CARDS[kind].title, kind);
    assert.equal(tag(t, "og:site_name"), "Reason");
    assert.equal(tag(t, "og:image:width"), "1200");
    assert.equal(tag(t, "og:image:height"), "630");
    assert.equal(tag(t, "twitter:card"), "summary_large_image");
    assert.match(tag(t, "og:image:alt"), /^Secured by Reason\./);
    const img = new URL(tag(t, "og:image"));
    assert.equal(img.origin, "https://heyreason.com");
    assert.equal(img.searchParams.get("v"), String(sc.SECURED_CARD_VERSION), "cache-busted");
    const res = sc.securedImageRequest(img.pathname);
    assert.equal(res?.status, 200, `${kind} picture is served`);
    assert.equal(res.headers["Content-Type"], "image/png");
    assert.match(res.headers["Cache-Control"], /max-age=\d+/);
    assert.equal(res.body.subarray(1, 4).toString(), "PNG");
    assert.equal(res.body.readUInt32BE(16), 1200, `${kind} width`);
    assert.equal(res.body.readUInt32BE(20), 630, `${kind} height`);
  }
});

test("the tags name the action only: no og:url, no token; anything else at the path is not served", () => {
  for (const kind of Object.keys(sc.SECURED_CARDS)) assert.doesNotMatch(sc.securedCardTags(kind), /og:url/);
  assert.equal(tag(sc.securedCardTags("nonsense"), "og:title"), "Connect your account", "an unknown kind gets the plain card");
  for (const p of ["/web/og/secured/nope.png", "/web/og/secured/../x.png", "/web/og/secured/approve.jpg", "/web/og/secured/APPROVE.png", "/og.png"]) {
    assert.equal(sc.securedImageRequest(p), null, p);
  }
  assert.equal(sc.providerKind("google"), "google");
  assert.equal(sc.providerKind("approve"), "connect", "only providers map to provider cards");
});

test("the OAuth start gate a preview fetcher reads shows the provider's card; an expired link the plain one", async () => {
  for (const [provider, title] of [["google", "Connect Google"], ["github", "Connect GitHub"], ["spotify", "Connect Spotify"], ["x", "Connect X"], ["uber", "Connect Uber"]]) {
    const state = db.newOauthState({ conversationId: "dm:fake:+13475550001", provider });
    db.setOauthStateAuthorizeUrl(state, `https://${provider}.example/authorize?state=${state}`);
    const out = await connectStartRequest({ state, method: "GET", headers: {} });
    assert.equal(out.status, 401, "still the code gate; a GET texts nothing");
    const head = headOf(out.body);
    assert.equal(tag(head, "og:title"), title);
    assert.match(tag(head, "og:image"), new RegExp(`/web/og/secured/${provider}\\.png\\?v=`));
    assert.ok(!head.includes(state), "the state never lands in the card");
  }
  const gone = await connectStartRequest({ state: "never-made", method: "GET", headers: {} });
  assert.equal(gone.status, 400);
  assert.equal(tag(headOf(gone.body), "og:title"), "Connect your account");
});

test("Spotify's join page and a remote sign-in page carry their cards, naming nobody", () => {
  const join = spotify.joinPage({ token: "tok123", ownerName: "Omari" });
  assert.equal(tag(headOf(join), "og:title"), "Connect Spotify");
  assert.doesNotMatch(headOf(join), /Omari|tok123/);
  const page = remote.shell("Sign in to Amazon", "<p>hi</p>");
  assert.equal(tag(headOf(page), "og:title"), "Sign in securely");
  assert.doesNotMatch(headOf(page), /Amazon/);
});

test("the card link and an unknown connect link carry their cards", async () => {
  const token = shop.cardLink("dm:owner");
  const out = await connectRequest({ sub: token, method: "GET" });
  assert.equal(out.status, 200);
  assert.equal(tag(headOf(out.body), "og:title"), "Save your card");
  assert.ok(!headOf(out.body).includes(token));
  const unknown = await connectRequest({ sub: "x".repeat(40), method: "GET" });
  assert.equal(tag(headOf(unknown.body), "og:title"), "Connect your account");
});
