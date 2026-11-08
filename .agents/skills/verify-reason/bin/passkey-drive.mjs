#!/usr/bin/env node
// Drive purchase approval by passkey (src/passkey.js, src/pages/webapprove.js, src/shopconnect.js,
// src/shoptools.js) over REAL HTTP: src/http.js createServer on a loopback port, opened in Chromium
// (node_modules/playwright) as http://localhost:<port>, so the WebAuthn RP ID is `localhost`. The
// passkey is a Chrome DevTools virtual authenticator (ctap2, internal, user verification on), made and
// used through the page's own buttons: navigator.credentials.create/get are the browser's, the
// signatures are real P-256, and @simplewebauthn/server verifies them exactly as live does.
// Crossmint is a stand-in inside this process (as test/passkey-pay.test.js does it, shop._setFetch);
// texts land in an array (shop.attach say). No model is called, nothing is texted, nothing is charged,
// and every other fetch out of the process is refused.
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && D=$(mktemp -d) && REASON_DATA_DIR=$D REASON_DB_PATH=$D/pk.db node .agents/skills/verify-reason/bin/passkey-drive.mjs [--shots=DIR] [--headed] [--non-owner]
//
// --shots=DIR saves the setup, approve, paid and declined screens. Prints one line per step, `ok` or
// `FAIL`, and exits non-zero on any FAIL.
process.env.REASON_WEB = "on";
process.env.REASON_SITE_URL = "http://localhost";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ ||= "America/New_York";
// --non-owner: the flags as live has them since 2026-10-31 (`on`), and a non-operator account pays.
const NON_OWNER = process.argv.includes("--non-owner");
process.env.REASON_SHOP_CONNECT = NON_OWNER ? "on" : "owner";
process.env.REASON_PASSKEY_PAY = NON_OWNER ? "on" : "owner";
delete process.env.REASON_SITE_PROXY_SECRET;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dbp = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = dbp && existsSync(dirname(dbp)) ? realpathSync(dirname(dbp)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  const data = process.env.REASON_DATA_DIR && existsSync(process.env.REASON_DATA_DIR) ? realpathSync(process.env.REASON_DATA_DIR) + "/" : "";
  if (!dbp || existsSync(dbp) || !parent || !roots.some(r => parent.startsWith(r)) || !data || !roots.some(r => data.startsWith(r))) {
    console.error("refusing: set REASON_DATA_DIR to a temp directory and REASON_DB_PATH to a new file in it");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET", "TWILIO_AUTH_TOKEN"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
// Crossmint: throwaway keys and an address that resolves nowhere; the fetch below answers for it.
const { generateKeyPairSync } = await import("node:crypto");
process.env.CROSSMINT_SERVER_KEY = "sk_drive_fake";
process.env.CROSSMINT_CLIENT_KEY = "ck_drive_fake";
process.env.CROSSMINT_API_BASE = "https://cm.drive.invalid";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";
const shots = process.argv.find(a => a.startsWith("--shots="))?.slice(8) || "";
const headed = process.argv.includes("--headed");

const { mkdirSync } = await import("node:fs");
const { join } = await import("node:path");
const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { createServer } = await imp("src/http.js");
const { clock } = await imp("src/config.js");
const db = await imp("src/db.js");
const shop = await imp("src/shopconnect.js");
const passkey = await imp("src/passkey.js");
const { runTool } = await imp("src/tools.js");
const q = (sql) => db.db.prepare(sql);

// Nothing leaves this process: loopback only. Crossmint is answered by shop._setFetch below.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const h = new URL(String(url)).hostname;
  if (h === "127.0.0.1" || h === "localhost") return realFetch(url, opts);
  throw new Error(`drive: refused a call out to ${h}`);
};
let calls = [];
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
shop._setFetch(async (url, init = {}) => {
  const p = new URL(url).pathname;
  calls.push({ method: init.method ?? "GET", path: p, body: init.body ? JSON.parse(init.body) : undefined });
  if (p === "/api/unstable/order-intents") { const no = refuseIntents.shift(); return no ? reply(no.status, no.body) : reply(201, { orderIntentId: `oi_${calls.length}` }); }
  // The rails read after the intent is made (2026-11-08): a card rail that is ready, or (scenario k) the
  // live 11-08 shape: the card's CVC lapsed until Crossmint's field stores it (cvcDone).
  if (/^\/api\/unstable\/order-intents\/[^/]+$/.test(p)) return reply(200, { orderIntentId: decodeURIComponent(p.split("/").pop()), status: "active", paymentMethodId: "pm_drive_secret", expiresAt: new Date(clock.now() + 15 * 60_000).toISOString(),
    amount: { total: "14.83", spent: "0.00", reserved: "0.00", available: "14.83", currency: "USD" },
    rails: cvcLapsed ? [{ rail: "agentic-token", status: "pending_verification" }, { rail: "spt", status: "active" }, { rail: "encrypted-card", status: cvcDone ? "active" : "pending_cvc_recollection" }] : [{ rail: "encrypted-card", status: "active", credentialFormats: ["card"] }] });
  if (/^\/api\/unstable\/agent-checkouts\/[^/]+\/messages$/.test(p)) return reply(202, { ok: true });
  return reply(404, {});
});
/** Refusals queued for the next order-intent calls ({ status, body }); empty means 201 (scenario j). */
let refuseIntents = [];
/** Scenario k: the card's CVC lapsed at Crossmint; cvcDone once Crossmint's field "stored" it. */
let cvcLapsed = false, cvcDone = false;
const said = [];
shop.attach({ say: (c, t) => said.push({ c, t }) });
const orderIntents = () => calls.filter(c => c.path === "/api/unstable/order-intents");
const answers = () => calls.filter(c => c.path.endsWith("/messages"));

// ---------------------------------------------------------------- people
// --non-owner (2026-10-31, shopping for everyone): the person paying is Ama, an account that is not the
// operator, under the flags `on`; "the other person" for the negatives is a third account. OWNER below
// then means "the person this drive pays for", as every step reads it.
const OWNER = NON_OWNER ? "dm:fake:+13475550000" : "dm:owner", AMA = NON_OWNER ? "dm:fake:+13475550001" : "dm:fake:+13475550000";
db.upsertAccount({ conversationId: "dm:owner", channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
db.upsertThread({ conversationId: "dm:owner", channel: "sendblue", address: "+12025551234", isOwner: true, service: "iMessage" });
if (NON_OWNER) {
  db.upsertAccount({ conversationId: OWNER, channel: "fake", address: "+13475550000", name: "Ama" });
  db.upsertThread({ conversationId: OWNER, channel: "fake", address: "+13475550000", isOwner: true, service: "iMessage" });
}
db.upsertAccount({ conversationId: AMA, channel: "fake", address: AMA.split(":").pop(), name: NON_OWNER ? "Kofi" : "Ama" });
db.upsertThread({ conversationId: AMA, channel: "fake", address: AMA.split(":").pop(), isOwner: true, service: "iMessage" });
db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");
q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_drive_secret', 'visa', '4242', 0, 1)").run(OWNER);
q("INSERT OR IGNORE INTO shop_runs (run_id, conversation_id, store, mode, item, status, created_at, updated_at) VALUES ('run_drive', ?, 'bestbuy', 'guest', 'USB-C cable', 'awaiting_input', 0, 0)").run(OWNER);
let nextReq = 1;
/** An asked payment at Best Buy, recorded as the checkout follower records Crossmint's request. */
const asked = (value) => shop.recordPayment({ conversationId: OWNER, runId: "run_drive", item: "USB-C cable", request: {
  requestId: `req_drive_${nextReq++}`, request: { question: `Approve $${value}`, expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
    interaction: { kind: "payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { name: "Best Buy", url: "https://www.bestbuy.com", countryCode: "US" } } },
} });
/** The link the way Reason gets it: the shop_pay tool, once a passkey exists. */
async function linkFor(row) {
  const out = await runTool("shop_pay", { payment_id: row.id }, { conversationId: OWNER });
  return out.approve_with_face_id ? out.url.split("/web/approve/")[1] : null;
}
const status = (row) => shop.paymentRow(row.id).status;

// ---------------------------------------------------------------- the server
const router = new Router({});
const runtime = new Runtime({ channels: router, deliver: async () => {}, runTurn: async () => "ok" });
router.runtime = runtime;
const server = createServer({ router, runtime });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;
process.env.REASON_PASSKEY_ORIGIN = BASE; // RP ID = localhost
process.env.REASON_SITE_URL = BASE;       // where shop.approvalUrl points

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const signIn = (c) => { const t = `drive-${Math.random().toString(36).slice(2)}`; db.startPageSession(`wsign:${c}`, t, { conversationId: c }); return { cookie: `reason_page=${t}`, token: t }; };
const owner = signIn(OWNER), ama = signIn(AMA);
// Node's fetch keeps Host = 127.0.0.1:<port>, so its Origin names that same host (src/pages/websignin.js sameOrigin).
const http = async (who, path, { method = "GET", body } = {}) => {
  const r = await realFetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin", ...(who ? { cookie: who.cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, text: await r.text() };
};
const bootOf = (html) => { try { return JSON.parse(/var B=(\{.*?\});\n/s.exec(html)[1]); } catch { return null; } };
const rejected = () => passkey.approvalLog(OWNER).filter(l => l.event === "rejected").map(l => l.detail);

const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: !headed, args: [`--host-resolver-rules=MAP localhost 127.0.0.1`] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: "reason_page", value: owner.token, domain: "localhost", path: "/" }]);
const pg = await ctx.newPage();
const cdp = await ctx.newCDPSession(pg);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
  protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
} });
// Every assertion the page posts, kept so a replay can be tried after.
const posted = [];
pg.on("request", r => { if (r.method() === "POST" && /\/web\/approve\/[^/]+\/verify$/.test(r.url())) posted.push({ url: new URL(r.url()).pathname, body: r.postDataJSON() }); });
const shown = () => pg.evaluate(() => document.querySelector(".pf-step:not(.pf-off)")?.getAttribute("data-step") ?? (document.querySelector("h1")?.textContent ?? ""));
const waitStep = (n) => pg.waitForFunction((n) => document.querySelector(`.pf-step[data-step="${n}"]:not(.pf-off)`), n, { timeout: 15000 }).then(() => true, () => false);
const errText = () => pg.evaluate(() => { const e = document.getElementById("pk-err"); return e && !e.hidden ? e.textContent : ""; });
const shot = async (name) => { if (shots) await pg.screenshot({ path: join(shots, `passkey-${name}.png`), fullPage: true }); };
if (shots) mkdirSync(shots, { recursive: true });

try {
  // (a) the setup page's options
  const setup = await http(owner, "/web/connect/passkey");
  const so = bootOf(setup.text)?.options;
  step("(a) signed-in owner GET /web/connect/passkey → 200, UV required, rp.id localhost", setup.status === 200 && so?.authenticatorSelection?.userVerification === "required" && so?.rp?.id === "localhost",
    `${setup.status} uv=${so?.authenticatorSelection?.userVerification} rp=${so?.rp?.id}`);

  // (b) a real ceremony through the page's button
  await pg.goto(`${BASE}/web/connect/passkey`, { waitUntil: "load" });
  await pg.click("#pk-add");
  const setDone = await waitStep("done");
  const creds = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
  const saved = q("SELECT id, counter FROM pay_passkeys WHERE conversation_id = ?").all(OWNER);
  step("(b) Set up Face ID → browser passkey made, verified and saved for the owner", setDone && creds.length === 1 && saved.length === 1 && creds[0].rpId === "localhost" && passkey.requiredFor(OWNER),
    `done=${setDone} authn=${creds.length} saved=${saved.length} rpId=${creds[0]?.rpId}`);
  step("(b) …the owner is texted that Face ID now approves purchases", /Face ID now approves your purchases/.test(said.at(-1)?.t ?? ""));
  await shot("setup-done");

  // (h) with a passkey, a texted yes doesn't pay
  const rowH = asked("4.99");
  const viaYes = await runTool("shop_pay", { payment_id: rowH.id, confirmation_id: 1 }, { conversationId: OWNER });
  const direct = await shop.payApproved({ conversationId: OWNER, paymentId: rowH.id, confirmationId: 1 });
  step("(h) shop_pay with a granted yes → Face ID link, not paid; payApproved → approve_with_passkey; no order intent",
    viaYes.ok === false && viaYes.approve_with_face_id === true && viaYes.url.startsWith(`${BASE}/web/approve/`) && direct.error === "approve_with_passkey" && orderIntents().length === 0 && status(rowH) === "asked",
    `face_id=${viaYes.approve_with_face_id} direct=${direct.error} oi=${orderIntents().length} ${status(rowH)}`);
  await shop.declinePayment({ conversationId: OWNER, paymentId: rowH.id }); calls = [];

  // (c) approve with Face ID on the page
  const rowC = asked("12.49");
  const tokC = await linkFor(rowC);
  const pageC = await http(null, `/web/approve/${tokC}`);
  const oc = bootOf(pageC.text)?.options;
  step("(c) GET /web/approve/{token} → 200, $12.49 at Best Buy, UV required, rpId localhost, only the owner's passkey",
    pageC.status === 200 && /Pay \$12\.49 at Best Buy\?/.test(pageC.text) && /USB-C cable/.test(pageC.text) && oc?.userVerification === "required" && oc?.rpId === "localhost"
      && oc?.allowCredentials?.length === 1 && oc.allowCredentials[0].id === saved[0].id, `${pageC.status} uv=${oc?.userVerification} rpId=${oc?.rpId} creds=${oc?.allowCredentials?.length}`);
  await pg.goto(`${BASE}/web/approve/${tokC}`, { waitUntil: "load" });
  await shot("approve");
  await pg.click("#pk-go");
  const paid = await waitStep("paid");
  const oi = orderIntents();
  step("(c) Approve with Face ID → paid: one order intent for 12.49 USD at Best Buy, request answered, row paid",
    paid && oi.length === 1 && oi[0].body.amount.value === "12.49" && oi[0].body.amount.currency === "USD" && oi[0].body.merchant.name === "Best Buy"
      && answers()[0]?.body.parts[0].requestId === rowC.request_id && status(rowC) === "paid", `page=${await shown()} oi=${oi.length} ${status(rowC)}`);
  step("(c) …texted Approved with Face ID. Paid $12.49 at Best Buy", /Approved with Face ID\. Paid \$12\.49 at Best Buy/.test(said.at(-1)?.t ?? ""));
  await shot("paid");
  const replay = await http(null, posted.at(-1).url, { method: "POST", body: posted.at(-1).body });
  const reopened = await http(null, `/web/approve/${tokC}`);
  step("(c) link reuse: the same assertion again → 400 refused, page says Already approved, still one order intent",
    replay.status === 400 && /link_used/.test(replay.text) && /Already approved/.test(reopened.text) && orderIntents().length === 1, `${replay.status} ${replay.text} oi=${orderIntents().length}`);

  // (j) the payment does not start (2026-10-31 at CVS): Crossmint refuses the order intent after Face ID
  // passed. The link must survive, the page must say so plainly, and the next tap must pay.
  calls = [];
  const rowJ = asked("26.65");
  q("UPDATE shop_runs SET stage = 'needs_approval', stage_at = ?, created_at = ?, updated_at = ? WHERE run_id = 'run_drive'").run(clock.now(), clock.now(), clock.now());
  const tokJ = await linkFor(rowJ);
  const bootJ1 = bootOf((await http(null, `/web/approve/${tokJ}`)).text);
  refuseIntents.push({ status: 400, body: { error: { code: "payment_method_declined", message: "declined" } } });
  await pg.goto(`${BASE}/web/approve/${tokJ}`, { waitUntil: "load" });
  await pg.click("#pk-go");
  const failedShown = await waitStep("failed");
  const h1J = await pg.evaluate(() => document.querySelector('.pf-step[data-step="failed"] h1')?.textContent ?? "");
  const logJ = passkey.approvalLog(OWNER);
  step("(j) Face ID passed, Crossmint refused the order intent → page says Face ID worked, the payment didn't start, nothing charged; row still asked; link reopened",
    failedShown && /Face ID worked\. The payment didn't start\./.test(h1J) && status(rowJ) === "asked" && orderIntents().length === 1 && answers().length === 0
      && logJ.some(l => l.event === "pay_failed" && /order_intent_failed 400 payment_method_declined/.test(l.detail)) && logJ.some(l => l.event === "link_reopened"),
    `page=${await shown()} h1=${JSON.stringify(h1J)} ${status(rowJ)} oi=${orderIntents().length} log=${logJ.slice(-3).map(l => `${l.event}:${l.detail}`).join(" ")}`);
  await shot("payment-did-not-start");
  const stJ = shop.statusView(OWNER).runs.find(r => r.run_id === "run_drive");
  step("(j) shop_status while the reopened link is open: names it, no new link made", /still works for \d+ more minutes/.test(stJ?.approval ?? "") && !stJ?.approve_url, JSON.stringify(stJ?.approval));
  // Try again: the page reloads and carries a fresh challenge; the first assertion is dead.
  const firstPost = posted.at(-1);
  await pg.click("#pk-retry");
  await pg.waitForLoadState("load");
  const bootJ2 = bootOf(await pg.content());
  const replayJ = await http(null, firstPost.url, { method: "POST", body: firstPost.body });
  step("(j) Try again → the same link opens again (not Already approved) under a fresh challenge; the first assertion replayed → refused, nothing paid",
    !!bootJ2?.options && bootJ2.options.challenge !== bootJ1.options.challenge && replayJ.status === 400 && /not_verified/.test(replayJ.text) && orderIntents().length === 1 && status(rowJ) === "asked",
    `challenge changed=${bootJ2?.options?.challenge !== bootJ1?.options?.challenge} replay=${replayJ.status} ${replayJ.text}`);
  await pg.click("#pk-go");
  const paidJ = await waitStep("paid");
  const runJ = q("SELECT stage, paid_at FROM shop_runs WHERE run_id = 'run_drive'").get();
  step("(j) second tap → paid: one more order intent for 26.65, request answered, row paid, the run advanced to stage paid, texted Paid $26.65",
    paidJ && orderIntents().length === 2 && orderIntents()[1].body.amount.value === "26.65" && answers().length === 1 && status(rowJ) === "paid" && runJ?.stage === "paid" && !!runJ?.paid_at
      && /Approved with Face ID\. Paid \$26\.65 at Best Buy/.test(said.at(-1)?.t ?? ""),
    `page=${await shown()} oi=${orderIntents().length} ${status(rowJ)} run=${runJ?.stage} said=${JSON.stringify(said.at(-1)?.t ?? "")}`);
  await shot("paid-after-retry");
  const usedJ = await http(null, `/web/approve/${tokJ}`);
  step("(j) …and now the link is used up: Already approved", /Already approved/.test(usedJ.text), `${usedJ.status}`);
  q("UPDATE shop_runs SET stage = '' WHERE run_id = 'run_drive'").run();

  // (k) the card's CVC lapsed (2026-11-08, Amazon run 650f8c4c): Face ID, then the page asks for the
  // 3-digit code in Crossmint's field, and only then pays. Crossmint's island is stood in for at the
  // network layer (same URL, so the page's CSP still decides whether it may load): it records what the
  // page handed it and answers submit() with "complete", as Crossmint's own field does.
  calls = []; cvcLapsed = true; cvcDone = false;
  const rowK = asked("14.83");
  q("UPDATE shop_runs SET stage = 'needs_approval' WHERE run_id = 'run_drive'").run();
  const tokK = await linkFor(rowK);
  await pg.route("**/web/connect/island.js", (r) => r.fulfill({ contentType: "text/javascript; charset=utf-8", body:
    "window.ReasonCrossmint={cvcField:function(el,o){window.__cvc={apiKey:!!o.apiKey,jwt:/^[^.]+\\.[^.]+\\.[^.]+$/.test(o.jwt||''),pm:o.paymentMethodId,look:!!o.appearance};var i=document.createElement('input');i.id='stand-in-cvc';i.placeholder='CVC';el.appendChild(i);return{submit:function(){window.__cvcSubmits=(window.__cvcSubmits||0)+1;return Promise.resolve({status:'complete'})}}}};" }));
  await pg.goto(`${BASE}/web/approve/${tokK}`, { waitUntil: "load" });
  await pg.click("#pk-go");
  const cvcShown = await waitStep("cvc");
  await pg.waitForFunction(() => !!window.__cvc, null, { timeout: 5000 }).catch(() => {});
  const handed = await pg.evaluate(() => window.__cvc ?? null);
  const h1K = await pg.evaluate(() => document.querySelector('.pf-step[data-step="cvc"]')?.innerText ?? "");
  step("(k) Face ID on a lapsed CVC → the page asks 'Enter your card's 3-digit code to finish'; nothing handed to the checkout, nothing counted, row asked",
    cvcShown && /Enter your card.s 3-digit code to finish\./.test(h1K) && answers().length === 0 && orderIntents().length === 1 && status(rowK) === "asked",
    `page=${await shown()} oi=${orderIntents().length} answers=${answers().length} ${status(rowK)}`);
  step("(k) …Crossmint's field got the client key, a JWT and the card's id, with our look; the island loaded under the page's CSP",
    handed?.apiKey === true && handed?.jwt === true && handed?.pm === "pm_drive_secret" && handed?.look === true, JSON.stringify(handed));
  await shot("cvc");
  cvcDone = true; // Crossmint stored the code the person typed
  await pg.click("#pk-cvc-go");
  const paidK = await waitStep("paid");
  step("(k) Finish paying → the SAME intent handed to the checkout once, row paid, texted Paid $14.83",
    paidK && orderIntents().length === 1 && answers().length === 1 && answers()[0].body.parts[0].response.orderIntentId === shop.paymentRow(rowK.id).order_intent_id
      && status(rowK) === "paid" && /Paid \$14\.83 at Best Buy/.test(said.at(-1)?.t ?? ""),
    `page=${await shown()} oi=${orderIntents().length} answers=${answers().length} ${status(rowK)} submits=${await pg.evaluate(() => window.__cvcSubmits ?? 0)}`);
  await shot("paid-after-cvc");
  const logK = passkey.approvalLog(OWNER).slice(-4).map(l => l.event).join(",");
  step("(k) the log reads needs_cvc → cvc_entered → paid, with no card id or JWT", /needs_cvc.*cvc_entered,paid/.test(logK) && !/pm_drive|eyJ/.test(JSON.stringify(passkey.approvalLog(OWNER))), logK);
  await pg.unroute("**/web/connect/island.js");
  cvcLapsed = false; cvcDone = false;
  q("UPDATE shop_runs SET stage = '' WHERE run_id = 'run_drive'").run();

  // (d) decline from the page
  calls = [];
  const rowD = asked("7.25");
  const tokD = await linkFor(rowD);
  await pg.goto(`${BASE}/web/approve/${tokD}`, { waitUntil: "load" });
  await pg.click("#pk-no");
  const declined = await waitStep("declined");
  step("(d) Decline → Crossmint told decline, row declined, nothing charged",
    declined && answers().length === 1 && answers()[0].body.parts[0].action === "decline" && orderIntents().length === 0 && status(rowD) === "declined",
    `page=${await shown()} answers=${answers().map(a => a.body.parts[0].action)} oi=${orderIntents().length} ${status(rowD)}`);
  await shot("declined");

  // (e) an expired link
  calls = [];
  const rowE = asked("3.10");
  const tokE = await linkFor(rowE);
  await pg.goto(`${BASE}/web/approve/${tokE}`, { waitUntil: "load" });
  clock.skip(passkey.APPROVAL_TTL_MS + 1000);
  await pg.click("#pk-go");
  await pg.waitForLoadState("load");
  await pg.waitForFunction(() => /run out/i.test(document.querySelector("h1")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {});
  const gotE = await http(null, `/web/approve/${tokE}`);
  step("(e) thirty minutes on (APPROVAL_TTL_MS): Approve → refused link_expired, page shows run out, GET → 410, nothing paid",
    rejected().includes("link_expired") && /run out/i.test(await pg.textContent("h1")) && gotE.status === 410 && orderIntents().length === 0 && status(rowE) === "asked",
    `log=${rejected().join(",")} h1=${(await pg.textContent("h1")).trim()} get=${gotE.status} oi=${orderIntents().length}`);
  clock.reset();

  // (f) the payment row changed after the link was made
  const rowF = asked("9.79");
  const tokF = await linkFor(rowF);
  await pg.goto(`${BASE}/web/approve/${tokF}`, { waitUntil: "load" });
  q("UPDATE shop_payments SET amount = '99.79' WHERE id = ?").run(rowF.id);
  await pg.click("#pk-go");
  await pg.waitForFunction(() => { const e = document.getElementById("pk-err"); return e && !e.hidden; }, null, { timeout: 15000 }).catch(() => {});
  step("(f) row amount changed to 99.79 after the link → refused details_changed, page says nothing charged, nothing paid",
    rejected().at(-1) === "details_changed" && /Nothing was charged/.test(await errText()) && orderIntents().length === 0 && status(rowF) === "asked",
    `log=${rejected().at(-1)} err=${await errText()} oi=${orderIntents().length}`);
  q("UPDATE shop_payments SET amount = '9.79' WHERE id = ?").run(rowF.id);

  // (i) the authenticator can't verify the user (presence only)
  const rowI = asked("5.55");
  const tokI = await linkFor(rowI);
  await pg.goto(`${BASE}/web/approve/${tokI}`, { waitUntil: "load" });
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  const before = posted.length;
  await pg.click("#pk-go");
  await pg.waitForFunction(() => { const e = document.getElementById("pk-err"); return e && !e.hidden; }, null, { timeout: 15000 }).catch(() => {});
  const sentI = posted.slice(before);
  step("(i) isUserVerified false → refused (browser or server), page says nothing charged, nothing paid",
    /Nothing was charged/.test(await errText()) && orderIntents().length === 0 && status(rowI) === "asked",
    `${sentI.length ? `server refused ${rejected().at(-1)}` : "browser refused before posting (UV required)"} oi=${orderIntents().length}`);
  // Server side too: a presence-only assertion posted straight at the route (UV flag cleared).
  if (!sentI.length) {
    const a = posted.find(p => p.url.includes(tokC));
    const ad = Buffer.from(a.body.response.authenticatorData, "base64url"); ad[32] &= ~0x04;
    const noUv = await http(null, `/web/approve/${tokI}/verify`, { method: "POST", body: { ...a.body, response: { ...a.body.response, authenticatorData: ad.toString("base64url") } } });
    step("(i) …a UV-less assertion posted directly → 400, nothing paid", noUv.status === 400 && orderIntents().length === 0 && status(rowI) === "asked", noUv.text);
  }
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });

  // (g) strangers
  const outSetup = await http(null, "/web/connect/passkey");
  const amaSetup = await http(ama, "/web/connect/passkey");
  const amaSetupPost = await http(ama, "/web/connect/passkey/verify", { method: "POST", body: {} });
  const outSetupPost = await http(null, "/web/connect/passkey/verify", { method: "POST", body: {} });
  const flat = (r) => r.status === 404 && !bootOf(r.text);
  // Under the flag `owner` another account gets a flat 404; with it `on` (--non-owner) the setup page is
  // theirs too — their own, drawn for their own account, and a bad POST is a 400, not a 404.
  step(NON_OWNER ? "(g) setup: signed out GET + POST → 404, no options; another account GET → its own page, bad POST → 400"
    : "(g) setup: signed out GET + POST → 404, no options; Ama (not owner) GET + POST → 404",
    flat(outSetup) && flat(outSetupPost) && (NON_OWNER ? amaSetup.status === 200 && amaSetupPost.status === 400 : flat(amaSetup) && amaSetupPost.status === 404),
    `${outSetup.status} ${outSetupPost.status} ${amaSetup.status} ${amaSetupPost.status}`);
  const made = await http(null, `/web/approve/${"x".repeat(32)}`);
  const madeV = await http(ama, `/web/approve/${"y".repeat(32)}/verify`, { method: "POST", body: {} });
  const madeD = await http(null, `/web/approve/${"z".repeat(32)}/decline`, { method: "POST", body: {} });
  step("(g) approve: a made-up token → GET, verify, decline all 404, no options", flat(made) && flat(madeV) && flat(madeD), `${made.status} ${madeV.status} ${madeD.status}`);
  const rowG = asked("2.00");
  const tokG = await linkFor(rowG);
  const amaPage = await http(ama, `/web/approve/${tokG}`);
  const forged = await http(ama, `/web/approve/${tokG}/verify`, { method: "POST", body: { ...posted.at(-1).body, id: "AAAAAAAAAAAAAAAAAAAAAA", rawId: "AAAAAAAAAAAAAAAAAAAAAA" } });
  step("(g) approve: anyone holding the real link sees it (bearer link, by design) but a passkey not the owner's → unknown_passkey, nothing paid",
    amaPage.status === 200 && /unknown_passkey/.test(forged.text) && orderIntents().length === 0 && status(rowG) === "asked", `${amaPage.status} ${forged.text}`);
  process.env.REASON_PASSKEY_PAY = "off";
  const offA = await http(owner, `/web/approve/${tokG}`), offS = await http(owner, "/web/connect/passkey");
  process.env.REASON_PASSKEY_PAY = "owner";
  step("(g) flag off → approve 404; setup 404", offA.status === 404 && flat(offS), `${offA.status} ${offS.status}`);

  const log = JSON.stringify(passkey.approvalLog(OWNER));
  step("the approval log has paid/declined/rejected and no card detail", /"paid"/.test(log) && /"declined"/.test(log) && /"rejected"/.test(log) && !/pm_drive|4242|visa/i.test(log));
  if (shots) console.log(`shots in ${shots}`);
} catch (e) {
  step("drive threw", false, e?.stack ?? String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
