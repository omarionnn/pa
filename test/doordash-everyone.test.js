// DoorDash for everyone the hosted browser covers (2026-11-17): Face ID for paying, a stale yes voided,
// sign-in with DoorDash's own relayed code, Browserbase's own minutes and the owner's alert, the side-of-
// Reason lines, routing and the invite wording. A FIXTURE DoorDash on loopback (as www.doordash.com) in a
// real local Chromium over CDP, a FAKE Browserbase (sessions, contexts, usage), a software Face ID. No
// internet, no real account, no real order, no paid API.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-dd-everyone-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:dd-owner";
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1";
process.env.REASON_SITE_URL = "https://heyreason.com";
const ENV = ["REASON_REMOTE_BROWSER", "REASON_REMOTE_BROWSER_SITES", "REASON_REMOTE_BROWSER_MONTH_MINUTES", "REASON_REMOTE_BROWSER_SESSION_MINUTES",
  "REASON_REMOTE_BROWSER_START_MS", "REASON_REMOTE_BROWSER_IDLE_MS", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "BROWSERBASE_API_URL",
  "REASON_DOORDASH_PAY", "REASON_DOORDASH_ORDER_MINUTES", "REASON_FOOD", "REASON_SAVED_LOGINS",
  "REASON_REMOTE_BROWSER_ALERT_MINUTES", "REASON_REMOTE_BROWSER_BUSY_WAIT_MS", "REASON_PASSKEY_PAY", "REASON_DOORDASH_TEST_SIGNIN_URL", "REASON_SHOP_CONNECT"];
for (const k of ENV) delete process.env[k];

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }
const skip = { skip: chromium ? false : "playwright/chromium not installed" };

const db = await import("../src/db.js");
const remote = await import("../src/remotebrowser.js");
const dd = await import("../src/doordash.js");
const food = await import("../src/food.js");
const browser = await import("../src/browser.js");
const refusing = await import("../src/refusing.js");
const opsdigest = await import("../src/opsdigest.js");
const trust = await import("../src/trust.js");
const { runTool, toolsFor, capabilitiesNow } = await import("../src/tools.js");
const { SYSTEM } = await import("../src/agent.js");

const OWNER = "dm:dd-owner";
const OTHER = "dm:dd-other";
db.upsertAccount({ conversationId: OWNER, channel: "test", address: "+12025550181", name: "Owner", isOperator: true });
db.upsertAccount({ conversationId: OTHER, channel: "test", address: "+12025550182", name: "Sam", isOperator: false });
db.setSpendCaps(OWNER, { perPurchaseCents: 20_000, monthlyCents: 100_000, said: "two hundred a thing" });
remote.setRemoteSink(() => {});
food._setShoot(async () => Buffer.from("jpg"));
food._attach({});

// ---------------------------------------------------------------- the fake Browserbase
const bb = { calls: [], connectUrl: "", n: 0, usage: 0, usageStatus: 0, busy: 0 };
const bbServer = createServer(async (req, res) => {
  let body = ""; for await (const ch of req) body += ch;
  bb.calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
  const route = `${req.method} ${req.url.replace(/\/[a-z]+_\d+$/, "/:id")}`;
  const json = (st, o) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.method === "GET" && /^\/v1\/projects\/[^/]+\/usage$/.test(req.url)) return bb.usageStatus ? json(bb.usageStatus, { message: "nope" }) : json(200, { browserMinutes: bb.usage, proxyBytes: 0 });
  if (route === "POST /v1/sessions" && bb.busy > 0) { bb.busy -= 1; return json(429, { message: "too many concurrent sessions" }); }
  if (route === "POST /v1/contexts") { bb.n += 1; return json(201, { id: `ctx_${bb.n}` }); }
  if (route === "DELETE /v1/contexts/:id") { res.writeHead(204); return res.end(); }
  if (route === "POST /v1/sessions") { bb.n += 1; return json(201, { id: `sess_${bb.n}`, connectUrl: bb.connectUrl, signingKey: "x", seleniumRemoteUrl: "http://x" }); }
  if (route === "POST /v1/sessions/:id") return json(200, {});
  res.writeHead(404); res.end();
});
const sessionsMade = () => bb.calls.filter(c => c.method === "POST" && c.path === "/v1/sessions").length;

// ---------------------------------------------------------------- the fixture DoorDash
// One account's state. `mode` turns on one stop at a time.
const S = {};
const resetSite = () => Object.assign(S, {
  address: "3247 Bruner Ave, Apt 1, Bronx, NY", cart: [], tip: 300, mode: "normal", placed: 0, placeAttempts: 0, raise: 0, pastOrder: true, login: "code", signedIn: false, codesTried: [],
});
const MENU = { "pad-thai": { name: "Pad Thai", price: 1495, options: ["Mild", "Medium", "Hot"] }, "spring-rolls": { name: "Spring Rolls", price: 695, options: [] }, "mango-sticky-rice": { name: "Mango Sticky Rice", price: 795, options: [], soldOut: true }, "thai-iced-tea": { name: "Thai Iced Tea", price: 495, options: [] }, "singha-beer": { name: "Singha Beer 6-pack", price: 1299, options: [], alcohol: true } };
const money = (n) => `$${(n / 100).toFixed(2)}`;
function totals() {
  const subtotal = S.cart.reduce((n, it) => n + it.price, 0);
  const fees = [["Delivery Fee", 299], ["Service Fee", Math.round(subtotal * 0.15)], ["Estimated Tax", Math.round(subtotal * 0.08875)]];
  const total = subtotal + fees.reduce((n, [, v]) => n + v, 0) + S.tip + S.raise;
  return { subtotal, fees, total };
}
const page = (title, html) => `<!doctype html><html><head><title>${title}</title></head><body><header><a href="/">DOORDASH</a> <button id="addr">${S.address}</button> <a href="/orders">Orders</a></header>${html}</body></html>`;
const siteServer = createServer(async (req, res) => {
  let body = ""; for await (const ch of req) body += ch;
  const u = new URL(req.url, "http://x");
  const send = (html, st = 200) => { res.writeHead(st, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  const go = (to) => { res.writeHead(303, { location: to }); res.end(); };
  const form = new URLSearchParams(body);
  if (req.method === "POST" && u.pathname === "/address") { S.address = form.get("address") || S.address; return go("/"); }
  if (u.pathname === "/") return send(page("DoorDash", `<h1>Restaurants near you</h1><form action="/search"><label for=q>Search DoorDash</label><input id=q name=q type=search></form><dialog open><form method=post action="/address"><label for=a>New address</label><input id=a name=address><button>Save address</button></form></dialog>`));
  if (u.pathname === "/search") return send(page("Search", `<h1>Results for ${u.searchParams.get("q") ?? ""}</h1><a href="/store/thai-palace-123/">Thai Palace</a><a href="/store/thai-garden-9/">Thai Garden Express</a>`));
  if (u.pathname === "/store/thai-palace-123/") {
    const rows = Object.entries(MENU).map(([k, m]) => m.soldOut ? `<p>${m.name} ${money(m.price)} Sold out</p>` : `<a href="/store/thai-palace-123/item/${k}">${m.name} ${money(m.price)}</a>`).join("");
    return send(page("Thai Palace", `<h1>Thai Palace</h1>${rows}<a href="/cart">Cart (${S.cart.length})</a>`));
  }
  const item = /^\/store\/thai-palace-123\/item\/([a-z-]+)$/.exec(u.pathname);
  if (item && MENU[item[1]]) {
    const m = MENU[item[1]];
    const opts = m.options.map((o, i) => `<label><input type=radio name=spice value="${o}" ${i === 0 ? "checked" : ""}> ${o}</label>`).join("");
    return send(page(m.name, `<h1>${m.name}</h1><form method=post action="/cart/add"><input type=hidden name=item value="${item[1]}">${opts ? `<fieldset><legend>Spice level</legend>${opts}</fieldset>` : ""}<button type=submit>Add to cart</button></form>`));
  }
  if (req.method === "POST" && u.pathname === "/cart/add") { const k = form.get("item"); S.cart.push({ key: k, name: MENU[k].name, price: MENU[k].price, spice: form.get("spice") || "", alcohol: !!MENU[k].alcohol }); return go("/store/thai-palace-123/"); }
  if (u.pathname === "/cart") return send(page("Cart", `<h1>Your cart</h1>${S.cart.map(it => `<p>1× ${it.name} ${money(it.price)}</p>`).join("")}<button onclick="location.href='/consumer/checkout/'">Checkout</button>`));
  if (req.method === "POST" && u.pathname === "/tip") { S.tip = Math.round(Number(form.get("tip")) * 100); return go("/consumer/checkout/"); }
  if (u.pathname === "/consumer/checkout/") {
    const t = totals();
    const extra = { verify: "<p>Verify your phone number to continue</p>", account: "<p>Your payment method failed. Update your payment to continue.</p>", card: "<p>Re-enter your card's security code (CVV) to continue</p>" }[S.mode] ?? "";
    const alcohol = S.cart.some(it => it.alcohol) ? "<p>This order contains alcohol. A valid ID will be checked at delivery (21+).</p>" : "";
    const unavailable = S.mode === "unavailable" ? `<p>${S.cart[0]?.name ?? "An item"} is currently unavailable</p>` : "";
    return send(page("Checkout", `<h1>Checkout</h1><h2>Delivery address</h2><p>${S.address}</p><h2>Delivery time</h2><p>Standard 25–35 min</p>${extra}${alcohol}${unavailable}
      <h2>Your items</h2>${S.cart.map(it => `<div><p>1× ${it.name}</p>${it.spice ? `<p>Spice level: ${it.spice}</p>` : ""}<p>${money(it.price)}</p></div>`).join("")}
      <h2>Dasher tip</h2><form method=post action="/tip"><button name=tip value="3">$3.00</button><button name=tip value="5">$5.00</button><label for=other>Other tip amount</label><input id=other name=tip></form>
      <h2>Order summary</h2><div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>${t.fees.map(([l, v]) => `<div><p>${l}</p><p>${money(v)}</p></div>`).join("")}<div><p>Dasher Tip</p><p>${money(S.tip)}</p></div><div><p>Total</p><p>${money(t.total)}</p></div>
      <form method=post action="/place"><button type=submit>Place Order</button></form>`));
  }
  if (req.method === "POST" && u.pathname === "/place") {
    S.placeAttempts += 1;
    if (S.mode === "cvv_after_press") return send(page("Verify", "<h1>Confirm your card</h1><p>Enter your card's security code (CVV)</p>"));
    S.placed += 1;
    return send(page("Order placed", `<h1>Order placed!</h1><p>Order #DD48213</p><p>Arrives by 8:15 PM</p>`));
  }
  if (u.pathname === "/consumer/login") return send(page("Sign in", `<h1>Sign in or sign up</h1><form method=post action="/consumer/login/code"><label for=e>Email</label><input id=e type=email name=email><button type=submit>Continue</button></form>`));
  if (u.pathname === "/consumer/login/code") return send(page("Code", `<h1>Enter the code we sent to your email</h1><form><label for=c>6-digit code</label><input id=c name=code inputmode=numeric autocomplete=one-time-code></form>`));
  if (u.pathname === "/dd-login") return send(page("Sign in", `<h1>Sign in or sign up</h1><form method=post action="/dd-login/next"><label for=e>Email</label><input id=e type=email name=email><button type=submit>Continue</button></form>`));
  if (u.pathname === "/dd-login/next") return send(S.login === "password"
    ? page("Password", `<h1>Enter your password</h1><form><label for=p>Password</label><input id=p type=password name=password><button type=submit>Sign In</button></form>`)
    : page("Code", `<h1>Enter the code we sent to your email</h1><form action="/dd-login/done"><label for=c>6-digit code</label><input id=c name=code inputmode=numeric autocomplete=one-time-code><button type=submit>Continue</button></form>`));
  if (u.pathname === "/dd-login/done") { S.codesTried.push(u.searchParams.get("code")); if (u.searchParams.get("code") === "481516") { S.signedIn = true; return send(page("Home", "<h1>Welcome back</h1><p>Restaurants near you</p>")); } return send(page("Code", "<h1>That code didn't work</h1>")); }
  if (u.pathname === "/orders") return send(page("Orders", S.placed ? `<h1>Orders</h1><p>Thai Palace</p><p>Your order is on the way. Arriving by 8:15 PM</p>` : `<h1>Orders</h1>${S.pastOrder ? `<p>Thai Palace · Pad Thai, Spring Rolls · ${money(3500)}</p><form method=post action="/reorder"><button>Reorder</button></form>` : "<p>No orders yet</p>"}`));
  if (req.method === "POST" && u.pathname === "/reorder") { S.cart = [{ key: "pad-thai", name: "Pad Thai", price: 1495, spice: "Medium" }, { key: "spring-rolls", name: "Spring Rolls", price: 695, spice: "" }]; return go("/cart"); }
  res.writeHead(404); res.end();
});

let cdp = null; let WS = ""; let SITE_PORT = 0;
const DD = (p) => `http://www.doordash.com:${SITE_PORT}${p}`;
before(async () => {
  await new Promise(r => bbServer.listen(0, "127.0.0.1", r));
  await new Promise(r => siteServer.listen(0, "127.0.0.1", r));
  SITE_PORT = siteServer.address().port;
  if (!chromium) return;
  cdp = spawn(chromium.executablePath(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(dir, "cdp")}`, "--host-resolver-rules=MAP * 127.0.0.1", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  WS = await new Promise((ok, no) => {
    let err = ""; const t = setTimeout(() => no(new Error("chromium did not open its CDP port")), 30_000);
    cdp.stderr.on("data", (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); ok(m[1]); } });
  });
});
after(async () => {
  await remote.closeAllRemote(); await browser.closeAllBrowsers().catch(() => {});
  if (cdp && cdp.exitCode == null) await new Promise(r => { cdp.once("exit", r); cdp.kill("SIGKILL"); });
  await new Promise(r => bbServer.close(r)); await new Promise(r => siteServer.close(r));
  for (const k of ENV) delete process.env[k];
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const set = (env) => { for (const k of ENV) delete process.env[k]; Object.assign(process.env, env); };
const ON = (extra = {}) => ({ REASON_REMOTE_BROWSER: "owner", REASON_FOOD: "owner", BROWSERBASE_API_KEY: "bb_test_fake", BROWSERBASE_PROJECT_ID: "proj_test", BROWSERBASE_API_URL: `http://127.0.0.1:${bbServer.address().port}`, ...extra });
const consent = (c = OWNER) => db.db.prepare("INSERT INTO remote_browser_consent (conversation_id, site, asked_at, consented_at) VALUES (?, 'doordash.com', ?, ?) ON CONFLICT(conversation_id, site) DO UPDATE SET consented_at = excluded.consented_at").run(c, Date.now(), Date.now());
const msg = (t) => ({ role: "user", content: `[Tue, Nov 17, 2026, 7:00 PM] ${t}` });
beforeEach(async () => {
  await browser.closeAllBrowsers().catch(() => {});
  set({}); resetSite();
  bb.calls.length = 0; bb.connectUrl = WS; bb.n = 0;
  remote._resetRemote(); refusing._resetRefusals(); dd._resetDoordash();
  db.db.exec("DELETE FROM ops_digest; DELETE FROM food_orders");
  try { db.db.exec("DELETE FROM spend_log"); } catch { /* table name differs: caps are per-test fresh anyway */ }
});

/** The model's side, done by hand: the browser tools on the hosted page, by what elements say. */
function driver(c, words) {
  const messages = [msg(words)];
  const ctx = (extra = {}) => ({ conversationId: c, kind: "user", messages, judge: async () => ({ verdict: "yes" }), ...extra });
  const call = (name, input, extra) => runTool(name, input, ctx(extra));
  let last = null;
  const read = async () => (last = await call("browser_read", {}));
  const ref = (re) => { const e = (last?.elements ?? []).find(x => re.test(x.name)); if (!e) throw new Error(`no element ${re} on ${last?.url}: ${(last?.elements ?? []).map(x => x.name).join(" | ").slice(0, 300)}`); return e.ref; };
  const click = async (re) => { const out = await call("browser_click", { ref: ref(re) }); last = out.ok ? out : last; return out; };
  const open = async (p) => (last = await call("browser_open", { url: DD(p) }));
  return { messages, call, read, click, open, ref, get last() { return last; }, say: (t) => messages.push(msg(t)) };
}
/** Start → address → search → store → Pad Thai (Medium) + Spring Rolls → cart. */
async function buildCart(d, { tip = undefined, extraItem = null } = {}) {
  // They asked for DoorDash by name (the route's reason); the line is taken off again so the address step reads their request.
  d.say("on doordash please");
  const st = await d.call("doordash_order", { action: "start", restaurant: "Thai Palace", why: "asked_by_name", ...(tip ? { tip } : {}) });
  d.messages.pop();
  assert.equal(st.ok, true, JSON.stringify(st).slice(0, 300));
  assert.equal((await d.open("/")).ok, true);
  const addr = await d.call("doordash_order", { action: "address", address: "3247 Bruner Ave" });
  assert.equal(addr.ok, true, JSON.stringify(addr).slice(0, 300));
  const typed = await d.call("browser_type", { ref: d.ref(/Search DoorDash/), text: "Thai Palace", press_enter: true });
  assert.equal(typed.ok, true, JSON.stringify(typed).slice(0, 200));
  await d.read();
  await d.click(/^Thai Palace$/);
  await d.click(/^Pad Thai/);
  await d.click(/Medium/);
  assert.equal((await d.click(/Add to cart/)).ok, true);
  await d.click(/^Spring Rolls/);
  await d.click(/Add to cart/);
  if (extraItem) { await d.click(extraItem); await d.click(/Add to cart/); }
  await d.click(/^Cart/);
  return st;
}
const ITEMS = [{ name: "Pad Thai", qty: 1, modifiers: ["Medium"], price: "14.95" }, { name: "Spring Rolls", qty: 1, price: "6.95" }];

// ---------------------------------------------------------------- this file's own setup
const passkey = await import("../src/passkey.js");
const shop = await import("../src/shopconnect.js");
const signinEmail = await import("../src/signinemail.js");
const { approveRequest } = await import("../src/pages/webapprove.js");
const { clock } = await import("../src/config.js");
await shop.ddReady;
db.setSpendCaps(OTHER, { perPurchaseCents: 20_000, monthlyCents: 100_000, said: "two hundred a thing" });
const said = [];
shop.attach({ say: (c, t) => said.push({ c, t }) });
const THIRD = "dm:dd-third";
db.upsertAccount({ conversationId: THIRD, channel: "test", address: "+12025550183", name: "Ana", isOperator: false });
const GROUP = "group:dd-friends";
const EVERYONE = (extra = {}) => ON({ REASON_REMOTE_BROWSER: "on", REASON_FOOD: "on", REASON_PASSKEY_PAY: "on", ...extra });
const sha = (b) => createHash("sha256").update(b).digest();

/** A software authenticator (as in test/passkey-pay.test.js): Face ID, done in code. */
class Authenticator {
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.key = privateKey; this.rawId = randomBytes(16); this.id = this.rawId.toString("base64url");
    this.cose = Buffer.from(encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]])));
    this.counter = 0;
  }
  authData({ attested = false } = {}) {
    const c = Buffer.alloc(4); c.writeUInt32BE(++this.counter);
    const parts = [sha("heyreason.com"), Buffer.from([0x01 | 0x04 | (attested ? 0x40 : 0)]), c];
    if (attested) { const len = Buffer.alloc(2); len.writeUInt16BE(this.rawId.length); parts.push(Buffer.alloc(16), len, this.rawId, this.cose); }
    return Buffer.concat(parts);
  }
  create(options) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: "https://heyreason.com", crossOrigin: false }));
    const attestationObject = Buffer.from(encodeCBOR(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData({ attested: true })]])));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] }, clientExtensionResults: {} };
  }
  get(challenge) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: "https://heyreason.com", crossOrigin: false }));
    const authenticatorData = this.authData();
    const sig = createSign("SHA256").update(Buffer.concat([authenticatorData, sha(clientDataJSON)])).sign(this.key);
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"), signature: sig.toString("base64url") }, clientExtensionResults: {} };
  }
}
const auths = new Map();
async function faceIdFor(c) {
  if (auths.has(c)) return auths.get(c);
  const a = new Authenticator();
  const o = await passkey.registrationOptions(c);
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal((await passkey.register(c, a.create(o.options))).ok, true);
  auths.set(c, a);
  return a;
}
const tokenOf = (url) => String(url).split("/web/approve/")[1];
const SAME = { origin: "https://heyreason.com", "sec-fetch-site": "same-origin" };
const pageGet = (token) => approveRequest({ sub: token, method: "GET", headers: SAME, readBody: async () => "" });
/** Tap Approve on the page: the bound challenge, signed by their authenticator. */
async function tap(token, a) {
  const v = shop.approvalView(token);
  const out = await approveRequest({ sub: `${token}/verify`, method: "POST", headers: SAME, readBody: async () => JSON.stringify(a.get(v.a.challenge)) });
  return JSON.parse(out.body);
}
const order = (c) => dd.orderRow(c);
const ask = async (c, words) => runTool("doordash_order", { action: "start", restaurant: "Thai Palace", why: "asked_by_name" }, { conversationId: c, kind: "user", messages: [msg(`${words} on doordash`)] });

/** The covered person's whole walk up to the ask: start, address, store, Pad Thai (Medium) + Spring Rolls, checkout. */
async function readyAsk(c, words = "pad thai and spring rolls from thai palace to 3247 Bruner Ave") {
  const d = driver(c, words);
  await buildCart(d);
  const read = await d.call("doordash_order", { action: "checkout", items: ITEMS });
  assert.equal(read.ok, true, JSON.stringify(read).slice(0, 300));
  return { d, read };
}
beforeEach(() => {
  said.length = 0; bb.usage = 0; bb.usageStatus = 0; bb.busy = 0;
  clock.reset();
  db.db.exec("DELETE FROM pay_approvals; DELETE FROM timers");
  for (const k of ["remote_browser:usage"]) db.opsDelete(k);
  db.db.prepare("DELETE FROM ops_state WHERE k LIKE 'remote_browser:alert:%'").run();
  signinEmail._resetJobs();
});

// ---------------------------------------------------------------- 1. Face ID for DoorDash paying
test("1. Face ID on file: the ask is a link bound to this order; a chat yes never places it; the tap places it once", skip, async () => {
  set(EVERYONE({ REASON_DOORDASH_PAY: "site_card" }));
  consent(OWNER);
  const a = await faceIdFor(OWNER);
  const { d, read } = await readyAsk(OWNER);
  assert.equal(read.approve_with_face_id, true, JSON.stringify(read).slice(0, 300));
  assert.match(read.say_exactly, /on the card already on your DoorDash account .*Approve it with Face ID here:\nhttps:\/\/heyreason\.com\/web\/approve\//s);
  assert.ok(read.picture, "the food approval card goes with it");
  assert.equal(read.use_target, undefined, "no chat-yes target is offered");
  // A yes in the chat, with a granted confirmation for the exact target: refused, nothing pressed.
  const target = dd.placeTarget(OWNER);
  const req = await d.call("confirm_request", { action: "doordash_place", summary: "Place it?", stakes: "money", target });
  d.say("yes place it");
  await d.call("confirm_record", { confirmation_id: req.confirmation_id });
  const chat = await d.call("doordash_place", { confirmation_id: req.confirmation_id });
  assert.equal(chat.approve_with_face_id, true, JSON.stringify(chat).slice(0, 200));
  assert.equal(S.placeAttempts, 0);
  // The page shows the order: DoorDash's own total, the restaurant, the address.
  const token = tokenOf(read.url);
  const html = (await pageGet(token)).body;
  assert.match(html, new RegExp(`Place ${read.total.replace("$", "\\$")} from Thai Palace on DoorDash\\?`));
  assert.match(html, /3247 Bruner Ave/);
  // The tap: one press, the confirmation texted to them.
  const out = await tap(token, a);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(S.placed, 1); assert.equal(S.placeAttempts, 1);
  assert.ok(said.some((x) => x.c === OWNER && /^Approved with Face ID\. Placed: Thai Palace/.test(x.t)), JSON.stringify(said).slice(0, 300));
  // Used: a second tap places nothing.
  const again = await tap(token, a).catch(() => ({ ok: false }));
  assert.notEqual(again.ok, true);
  assert.equal(S.placeAttempts, 1);
  assert.equal(remote.remoteSessionsOpen(), 0);
});

test("1. the approval is bound: a link for cart A cannot place cart B; an expired link places nothing", skip, async () => {
  set(EVERYONE({ REASON_DOORDASH_PAY: "site_card" }));
  consent(OWNER);
  const a = await faceIdFor(OWNER);
  const first = await readyAsk(OWNER);
  const tokenA = tokenOf(first.read.url);
  // The cart changes (another item) and is read again: a new revision, a new link.
  const d = first.d;
  await d.open("/store/thai-palace-123/");
  await d.click(/^Thai Iced Tea/); await d.click(/Add to cart/); await d.click(/^Cart/);
  const second = await d.call("doordash_order", { action: "checkout", items: [...ITEMS, { name: "Thai Iced Tea", qty: 1, price: "4.95" }] });
  assert.equal(second.ok, true, JSON.stringify(second).slice(0, 300));
  assert.notEqual(second.url, first.read.url);
  // The old link (cart A) cannot place cart B.
  const old = await tap(tokenA, a).catch((e) => ({ ok: false, error: String(e) }));
  assert.notEqual(old.ok, true, JSON.stringify(old));
  assert.equal(S.placeAttempts, 0);
  // The new one, once it has run out, places nothing either.
  clock.skip(31 * 60_000);
  const late = await tap(tokenOf(second.url), a).catch(() => ({ ok: false }));
  assert.notEqual(late.ok, true);
  assert.equal(S.placeAttempts, 0);
});

test("1. the binding itself: an open link signed for cart A is refused once the order stands for cart B (revision, total)", skip, async () => {
  set(EVERYONE({ REASON_DOORDASH_PAY: "site_card" }));
  consent(OWNER);
  const a = await faceIdFor(OWNER);
  const { read } = await readyAsk(OWNER);
  const token = tokenOf(read.url);
  // DoorDash's cart becomes cart B and the order's record follows it (both revisions together), but
  // the link signed for cart A is still open: only the binding stands between it and a press.
  S.cart.push({ key: "thai-iced-tea", name: "Thai Iced Tea", price: 495, spice: "" });
  const t = totals();
  const r = dd.orderRow(OWNER);
  db.db.prepare("UPDATE food_orders SET revision = revision + 1 WHERE id = ?").run(r.order_id);
  db.db.prepare("UPDATE doordash_orders SET revision = revision + 1, total_cents = ? WHERE order_id = ?").run(t.total, r.order_id);
  assert.equal(shop.approvalView(token).state, "open");
  const out = await tap(token, a).catch((e) => ({ ok: false, error: String(e) }));
  assert.notEqual(out.ok, true, JSON.stringify(out));
  assert.equal(out.error, "details_changed");
  assert.equal(S.placeAttempts, 0);
});

test("1. a total that moves between the approval and the press: nothing placed, the approval void, a fresh link asked", skip, async () => {
  set(EVERYONE({ REASON_DOORDASH_PAY: "site_card" }));
  consent(OWNER);
  const a = await faceIdFor(OWNER);
  const { read } = await readyAsk(OWNER);
  S.raise = 150;
  const out = await tap(tokenOf(read.url), a);
  assert.notEqual(out.ok, true);
  assert.equal(out.error, "total_changed");
  assert.equal(S.placeAttempts, 0);
  const line = said.find((x) => x.c === OWNER && /changed from/.test(x.t));
  assert.ok(line, JSON.stringify(said).slice(0, 300));
  assert.match(line.t, /Approve the new total with Face ID here:\nhttps:\/\/heyreason\.com\/web\/approve\//);
  const fresh = tokenOf(line.t.split("\n").pop());
  assert.equal((await tap(fresh, a)).ok, true);
  assert.equal(S.placed, 1);
});

test("1. no passkey: the same chat-yes gate as shop_pay (confirm_request on the exact target), never weaker", skip, async () => {
  set(EVERYONE({ REASON_DOORDASH_PAY: "site_card" }));
  consent(THIRD);
  db.setSpendCaps(THIRD, { perPurchaseCents: 20_000, monthlyCents: 100_000, said: "ok" });
  const { d, read } = await readyAsk(THIRD);
  assert.ok(read.use_target, JSON.stringify(read).slice(0, 200));
  assert.equal(read.approve_with_face_id, undefined);
  assert.notEqual((await d.call("doordash_place", {})).ok, true, "no yes, no press");
  const req = await d.call("confirm_request", { action: "doordash_place", summary: read.say_exactly, stakes: "money", target: read.use_target });
  d.say("yes");
  await d.call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal((await d.call("doordash_place", { confirmation_id: req.confirmation_id })).ok, true);
  assert.equal(S.placed, 1);
});

// ---------------------------------------------------------------- 2. a stale yes
test("2. a new food request drops the waiting DoorDash order with the #604 line; its old yes and its link place nothing", skip, async () => {
  set(EVERYONE({ REASON_DOORDASH_PAY: "site_card" }));
  consent(THIRD);
  db.setSpendCaps(THIRD, { perPurchaseCents: 20_000, monthlyCents: 100_000, said: "ok" });
  const { d, read } = await readyAsk(THIRD);
  const req = await d.call("confirm_request", { action: "doordash_place", summary: read.say_exactly, stakes: "money", target: read.use_target });
  // They move on: a new food request.
  const told = [];
  food._attach({ say: (c, t) => told.push({ c, t }) });
  await food.startOrder(THIRD);
  assert.ok(told.some((x) => /I dropped the waiting Thai Palace order; nothing was charged\./.test(x.t)), JSON.stringify(told));
  d.say("yes");
  await d.call("confirm_record", { confirmation_id: req.confirmation_id });
  const late = await d.call("doordash_place", { confirmation_id: req.confirmation_id, order_id: read.order_id });
  assert.notEqual(late.ok, true, JSON.stringify(late).slice(0, 200));
  assert.equal(S.placeAttempts, 0);
  // With Face ID: the new request closes the link.
  dd._resetDoordash(); db.db.exec("DELETE FROM food_orders"); resetSite();
  consent(OWNER);
  const a = await faceIdFor(OWNER);
  const fid = await readyAsk(OWNER);
  await food.startOrder(OWNER);
  const tapped = await tap(tokenOf(fid.read.url), a).catch(() => ({ ok: false }));
  assert.notEqual(tapped.ok, true);
  assert.equal(S.placeAttempts, 0);
  food._attach({});
});

test("2. a cart changed under the yes (its food revision moved) is not placed on the old yes", skip, async () => {
  set(EVERYONE({ REASON_DOORDASH_PAY: "site_card" }));
  consent(THIRD);
  db.setSpendCaps(THIRD, { perPurchaseCents: 20_000, monthlyCents: 100_000, said: "ok" });
  const { d, read } = await readyAsk(THIRD);
  const req = await d.call("confirm_request", { action: "doordash_place", summary: read.say_exactly, stakes: "money", target: read.use_target });
  d.say("yes");
  await d.call("confirm_record", { confirmation_id: req.confirmation_id });
  db.db.prepare("UPDATE food_orders SET revision = revision + 1 WHERE id = ?").run(read.order_id);
  const out = await d.call("doordash_place", { confirmation_id: req.confirmation_id });
  assert.notEqual(out.ok, true);
  assert.equal(S.placeAttempts, 0);
});

// ---------------------------------------------------------------- 3. signing in, for everyone
/** Wait until their sign-in job has ended (emailSigninFor is null once it is done). */
async function doneSigningIn(c) { for (let i = 0; i < 400 && signinEmail.emailSigninFor(c); i++) await new Promise((r) => setTimeout(r, 50)); }
async function signInByCode(c, { code = "481516" } = {}) {
  const ctx = { conversationId: c, kind: "user", messages: [msg("sign me into doordash, it's me@example.com")], signinCheck: async () => ({ ok: true, state: "signed_in", why: "account page" }),
    log: (o) => (globalThis.__ddlog ??= []).push(JSON.stringify(o).slice(0, 200)) };
  const out = await runTool("doordash_order", { action: "signin", email: "me@example.com" }, ctx);
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  // The live job's state is read again each time (emailSigninFor hands back a copy).
  let st = null;
  for (let i = 0; i < 300; i++) { st = signinEmail.emailSigninFor(c); if (!st || st.state === "waiting_reply") break; await new Promise((r) => setTimeout(r, 50)); }
  return { st, code };
}

test("3. a NON-owner, end to end in site_card: consent, DoorDash's own texted/emailed code relayed once, cart, Face ID, one press, confirmation", skip, async () => {
  set(EVERYONE({ REASON_DOORDASH_PAY: "site_card", REASON_DOORDASH_TEST_SIGNIN_URL: DD("/dd-login") }));
  // Consent first: one sentence, nothing opened.
  const first = await ask(OTHER, "get me pad thai from thai palace");
  assert.equal(first.hosted_browser, "consent_needed");
  const ok = await runTool("hosted_browser_ok", { site: "doordash.com", their_words: "yes go ahead" }, { conversationId: OTHER, kind: "user", messages: [msg("yes go ahead")] });
  assert.equal(ok.ok, true, JSON.stringify(ok).slice(0, 300));
  // Sign in with DoorDash's own code: asked once, typed only into DoorDash's code box.
  const { st, code } = await signInByCode(OTHER);
  assert.equal(st?.state, "waiting_reply", JSON.stringify({ st, log: globalThis.__ddlog }));
  assert.ok(signinEmail.takeCodeReply(OTHER, code), "their reply is taken as the code");
  await doneSigningIn(OTHER);
  assert.equal(S.signedIn, true);
  assert.deepEqual(S.codesTried, ["481516"], "typed once");
  assert.equal(remote.remoteSessionsOpen(), 0);
  // The order, approved with Face ID.
  const a = await faceIdFor(OTHER);
  const { read } = await readyAsk(OTHER);
  assert.equal(read.approve_with_face_id, true);
  assert.equal((await tap(tokenOf(read.url), a)).ok, true);
  assert.equal(S.placed, 1);
  assert.ok(said.some((x) => x.c === OTHER && /Placed: Thai Palace/.test(x.t)));
});

test("3. a non-owner in handoff: the cart is built on their account and handed to them; nothing is pressed", skip, async () => {
  set(EVERYONE());
  consent(OTHER);
  const d = driver(OTHER, "pad thai and spring rolls from thai palace to 3247 Bruner Ave");
  await buildCart(d);
  const out = await d.call("doordash_order", { action: "checkout", items: ITEMS });
  assert.equal(out.handed_off, true, JSON.stringify(out).slice(0, 300));
  assert.equal(S.placeAttempts, 0);
});

test("3. an account that wants a password: one plain line with what can be done instead; nobody is asked for a password", skip, async () => {
  set(EVERYONE({ REASON_DOORDASH_TEST_SIGNIN_URL: DD("/dd-login") }));
  consent(OTHER);
  S.login = "password";
  const told = [];
  const ctx = { conversationId: OTHER, kind: "user", messages: [msg("sign me in, me@example.com")], startEmailSignin: (args) => signinEmail.startEmailSignin({ ...args, note: (c, t) => told.push(t) }),
 };
  const out = await runTool("doordash_order", { action: "signin", email: "me@example.com" }, ctx);
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 200));
  await doneSigningIn(OTHER);
  const line = told.join(" | ");
  assert.match(line, /DoorDash wants your password for this account, and I only sign in to DoorDash with the code it sends you, so I stopped\. I can order it from the restaurant's own site, or set it up for pickup, instead\./);
  assert.match(line, /Never ask them for a password/);
  assert.doesNotMatch(line, /\b(text|send) me (your|the) password/i);
  assert.equal(remote.remoteSessionsOpen(), 0);
});

test("3. the code route never opens the other doors: no mailbox read, no social sign-in, no saved logins for a non-owner", () => {
  set(EVERYONE({ REASON_SOCIAL_SIGNIN: "owner", REASON_SAVED_LOGINS: "owner" }));
  const names = toolsFor(OTHER).map((t) => t.name);
  for (const t of ["signin_email", "signin_provider", "saved_login_offer", "account_signin"]) assert.ok(!names.includes(t), `${t} stays the owner's`);
  assert.ok(names.includes("doordash_order"));
});

test("3. two people at once: each their own consent, their own kept sign-in (Context), their own session", skip, async () => {
  set(EVERYONE());
  consent(OWNER);
  assert.equal((await ask(OTHER, "get me pad thai")).hosted_browser, "consent_needed", "the owner's yes is not theirs");
  consent(OTHER);
  // One after the other, both left open together (the fixture's one local Chromium has one tab for
  // every "session"; real Browserbase sessions are separate browsers).
  for (const who of [OWNER, OTHER]) assert.equal((await ask(who, "get me pad thai")).ok, true);
  const x = await runTool("browser_open", { url: DD("/") }, { conversationId: OWNER, kind: "user", messages: [msg("open doordash")] });
  const y = await runTool("browser_open", { url: DD("/") }, { conversationId: OTHER, kind: "user", messages: [msg("open doordash")] });
  assert.equal(x.ok, true); assert.equal(y.ok, true);
  const made = bb.calls.filter((c) => c.method === "POST" && c.path === "/v1/sessions").map((c) => c.body.browserSettings.context.id);
  assert.equal(new Set(made).size, 2, "two Contexts, one each");
  assert.equal(remote.remoteSessionsOpen(), 2);
  assert.notEqual(remote.hasContext(OWNER, "doordash.com"), false); assert.notEqual(remote.hasContext(OTHER, "doordash.com"), false);
  await browser.closeAllBrowsers();
});

test("3. a group thread: nobody can consent, sign in or order there", async () => {
  set(EVERYONE({ REASON_DOORDASH_PAY: "site_card" }));
  assert.equal(remote.remoteFor(GROUP, "doordash.com"), "");
  assert.equal(remote.gate(GROUP, "doordash.com"), null);
  const names = toolsFor(GROUP).map((t) => t.name);
  for (const t of ["doordash_order", "doordash_place", "hosted_browser_ok"]) assert.ok(!names.includes(t), t);
  const ctx = { conversationId: GROUP, kind: "user", isGroup: true, messages: [msg("yes go ahead")] };
  assert.notEqual((await runTool("hosted_browser_ok", { site: "doordash.com", their_words: "yes go ahead" }, ctx)).ok, true);
  assert.notEqual((await runTool("doordash_order", { action: "start", restaurant: "Thai Palace", why: "asked_by_name" }, ctx)).ok, true);
  assert.notEqual((await runTool("doordash_order", { action: "signin", email: "me@example.com" }, ctx)).ok, true);
  assert.equal(bb.calls.length, 0);
});

// ---------------------------------------------------------------- 4. minutes, truthfully
test("4. the budget goes by Browserbase's own figure plus sessions under way; a failed read falls back to Reason's count and says so", async () => {
  set(EVERYONE());
  consent(OTHER);
  bb.usage = 13;
  await remote.refreshUsage({ force: true });
  assert.equal(remote.usageSource().source, "browserbase");
  assert.equal(remote.minutesLeft(), 47, "60 - 13 (Reason's own count is 0)");
  bb.usage = 55;
  await remote.refreshUsage({ force: true });
  const out = await ask(OTHER, "get me pad thai");
  assert.equal(out.budget, true, JSON.stringify(out).slice(0, 200));
  assert.doesNotMatch(out.say_exactly, /\bplan\b|minutes|DoorDash app/);
  assert.equal(bb.calls.filter((c) => c.path === "/v1/sessions").length, 0, "nothing opened");
  // At most hourly: a read an hour old is read again; a newer one is not.
  const reads = () => bb.calls.filter((c) => /\/usage$/.test(c.path)).length;
  const n = reads();
  await remote.refreshUsage();
  assert.equal(reads(), n, "not again within the hour");
  clock.skip(61 * 60_000);
  await remote.refreshUsage();
  assert.equal(reads(), n + 1);
  // A failed read: the last good figure kept, the digest says the read failed.
  bb.usageStatus = 500;
  db.db.exec("DELETE FROM ops_digest");
  await remote.refreshUsage({ force: true });
  assert.equal(remote.lastUsage().minutes, 55);
  assert.ok(opsdigest.pending().some((r) => /latest read failed/.test(r.text)), JSON.stringify(opsdigest.pending()).slice(0, 300));
  // No good reading this month at all: Reason's own count, said so.
  db.opsDelete("remote_browser:usage");
  await remote.refreshUsage({ force: true });
  assert.equal(remote.usageSource().source, "own");
  assert.ok(opsdigest.pending().some((r) => /Reason's own count: Browserbase's usage could not be read/.test(r.text)));
  const row = remote.opsRow();
  assert.match(row.detail, /0\.0 of 60 min used · 60 min left · Reason's own count/);
});

test("4. the owner's alert: one text a month below the threshold, a second at zero, never repeated", async () => {
  set(EVERYONE());
  const sent = [];
  const send = (t, idem) => { sent.push({ t, idem }); return true; };
  bb.usage = 45; await remote.refreshUsage({ force: true });
  assert.equal(await remote.minutesAlert({ send }), null, "15 left: no text");
  bb.usage = 52; await remote.refreshUsage({ force: true });
  const low = await remote.minutesAlert({ send });
  assert.equal(low, "Browserbase: 8 of 60 hosted-browser minutes left this month, about 0 DoorDash orders. At zero DoorDash stops for everyone until the plan is upgraded.");
  assert.equal(await remote.minutesAlert({ send }), null, "once a month");
  bb.usage = 57; await remote.refreshUsage({ force: true });
  assert.equal(await remote.minutesAlert({ send }), null, "still low: no second low text");
  bb.usage = 60; await remote.refreshUsage({ force: true });
  assert.match(await remote.minutesAlert({ send }), /are used up, so DoorDash has stopped for everyone until the plan is upgraded/);
  assert.equal(await remote.minutesAlert({ send }), null);
  assert.equal(sent.length, 2);
  // Nobody to tell yet (startup): not marked, so the next pass sends it.
  db.db.prepare("DELETE FROM ops_state WHERE k LIKE 'remote_browser:alert:%'").run();
  assert.equal(await remote.minutesAlert({ send: () => false }), null);
  assert.ok(await remote.minutesAlert({ send }));
  assert.match(remote.opsRow().detail, /zero text sent/);
  assert.equal(remote.opsRow().state, "bad");
});

// ---------------------------------------------------------------- 5. out of minutes, too busy
test("5. too many sessions at once: one quiet retry; busy twice is said once, on Reason's side, with a wake to try again", skip, async () => {
  set(EVERYONE({ REASON_REMOTE_BROWSER_BUSY_WAIT_MS: "50" }));
  consent(OTHER);
  assert.equal((await ask(OTHER, "get me pad thai")).ok, true);
  bb.busy = 1;
  const once = await runTool("browser_open", { url: DD("/") }, { conversationId: OTHER, kind: "user", messages: [msg("open doordash")] });
  assert.equal(once.ok, true, "the retry got a session");
  await browser.closeAllBrowsers();
  bb.busy = 2;
  const twice = await runTool("browser_open", { url: DD("/") }, { conversationId: OTHER, kind: "user", messages: [msg("open doordash")] });
  assert.equal(twice.hosted_browser, "busy");
  assert.match(twice.say_exactly, /busy on my side right now.*That's not a limit on you\. I'll try again in a few minutes, or I can order it from the restaurant's own site, or set it up for pickup, right now\./);
  assert.doesNotMatch(twice.say_exactly, /\bplan\b|DoorDash app/);
  const wake = db.db.prepare("SELECT note, fire_at FROM timers WHERE conversation_id = ?").all(OTHER);
  assert.equal(wake.length, 1, "one wake to try again");
});

// ---------------------------------------------------------------- 6. routing
test("6. routing words: own ordering first, then DoorDash, then phone pickup; the hand-off line offers DoorDash done for them", async () => {
  set(EVERYONE());
  const foodTool = toolsFor(OTHER).find((t) => t.name === "food_order");
  assert.match(foodTool.description, /the restaurant's own online ordering first \(delivery or pickup, as for anyone\), then DoorDash, then a phone order for pickup/);
  assert.match(foodTool.description, /Never open DoorDash to browse or compare prices/);
  assert.match(toolsFor(OTHER).find((t) => t.name === "doordash_order").description, /Not the first route/);
  // #604's hand-off: a covered person is offered DoorDash done for them, never the sign-in link.
  const told = [];
  food._attach({ say: (c, t) => told.push({ c, t }) });
  const id = Number(db.db.prepare("INSERT INTO food_orders (conversation_id, status, route, via, restaurant, store_url, run_id, fulfillment, created_at, updated_at) VALUES (?, 'asked', 'direct', 'own_site', 'Wing Spot', 'https://wingspot.example/order', 'run_ho', 'delivery', ?, ?)").run(OTHER, Date.now(), Date.now()).lastInsertRowid);
  await food.handOff({ run_id: "run_ho", conversation_id: OTHER }, "doordash");
  const line = told.find((x) => x.c === OTHER)?.t ?? "";
  assert.match(line, /order it on DoorDash for you instead/, line);
  assert.doesNotMatch(line, /sign-in link/);
  // Somebody the hosted browser does not cover keeps #604's own words.
  set(ON());
  told.length = 0;
  db.db.prepare("UPDATE food_orders SET status = 'asked', run_id = 'run_ho2', conversation_id = ? WHERE id = ?").run(THIRD, id);
  await food.handOff({ run_id: "run_ho2", conversation_id: THIRD }, "doordash");
  assert.match(told.find((x) => x.c === THIRD)?.t ?? "", /DoorDash sign-in link/);
  food._attach({});
});

// ---------------------------------------------------------------- 6b. routing, corrected: the restaurant's own ordering first
const startFor = (c, input, words) => runTool("doordash_order", { action: "start", restaurant: "Thai Palace", ...input }, { conversationId: c, kind: "user", messages: words.map((w) => msg(w)) });
const sessions = () => bb.calls.filter((x) => x.method === "POST" && x.path === "/v1/sessions").length;

test("6b. a plain request for a place with its own ordering never opens DoorDash: no start, no hosted session, nothing asked of Browserbase", skip, async () => {
  set(EVERYONE());
  consent(OTHER);
  food.notePlace(OTHER, { restaurant: "Thai Palace", url: "https://order.thaipalace.example/menu" });
  const plain = ["get me pad thai from thai palace to my place"];
  for (const why of [undefined, "asked_by_name", "no_own_ordering", "own_site_hands_off", "own_site_failed", "usual_from_doordash"]) {
    const out = await startFor(OTHER, why ? { why } : {}, plain);
    assert.equal(out.not_doordash, true, `${why}: ${JSON.stringify(out).slice(0, 160)}`);
    assert.match(out.error, /restaurant's own online ordering comes first/);
  }
  // Browsing DoorDash anyway (to compare prices): the hosted browser refuses before anything is asked.
  const browse = await runTool("browser_open", { url: DD("/") }, { conversationId: OTHER, kind: "user", messages: [msg("what does it cost on doordash")] });
  assert.equal(browse.hosted_browser, "no_reason", JSON.stringify(browse).slice(0, 200));
  assert.equal(browse.say_exactly, "");
  assert.equal(sessions(), 0, "zero sessions created");
  assert.equal(bb.calls.filter((x) => x.path === "/v1/contexts").length, 0);
});

test("6b. (a) asked for DoorDash by name, or a usual that came from DoorDash: it goes to DoorDash", async () => {
  set(EVERYONE());
  consent(OTHER);
  assert.equal((await startFor(OTHER, { why: "asked_by_name" }, ["reorder my last doordash from thai palace"])).ok, true);
  // "my usual" with no site named: their history decides.
  dd._resetDoordash(); db.db.exec("DELETE FROM food_orders");
  assert.equal((await startFor(OTHER, { why: "usual_from_doordash", usual: true }, ["my usual from thai palace"])).not_doordash, true, "no history: own site");
  const placed = (platform) => db.db.prepare("INSERT INTO food_orders (conversation_id, status, route, platform, restaurant, store_url, created_at, updated_at, placed_at) VALUES (?, 'placed', ?, ?, 'Thai Palace', ?, ?, ?, ?)")
    .run(OTHER, platform ? "platform" : "direct", platform, platform ? "https://www.doordash.com/store/x" : "https://order.thaipalace.example/menu", Date.now(), Date.now(), Date.now());
  placed("");
  assert.equal(dd.usualFromDoordash(OTHER, "Thai Palace"), false);
  assert.equal((await startFor(OTHER, { why: "usual_from_doordash", usual: true }, ["my usual from thai palace"])).not_doordash, true, "usual was the own site");
  placed("doordash");
  assert.equal(dd.usualFromDoordash(OTHER, "Thai Palace"), true);
  assert.equal((await startFor(OTHER, { why: "usual_from_doordash", usual: true }, ["my usual from thai palace"])).ok, true);
});

test("6b. (b) no online ordering of its own, or an own site that hands delivery to DoorDash and their yes: DoorDash", async () => {
  set(EVERYONE());
  consent(OTHER);
  food.notePlace(OTHER, { restaurant: "Thai Palace", noDirect: true });
  assert.equal((await startFor(OTHER, { why: "no_own_ordering" }, ["get me pad thai from thai palace"])).ok, true);
  dd._resetDoordash(); db.db.exec("DELETE FROM food_orders; DELETE FROM food_places");
  food.notePlace(OTHER, { restaurant: "Thai Palace", url: "https://order.thaipalace.example/menu" });
  db.db.prepare("INSERT OR REPLACE INTO food_told (conversation_id, what, at) VALUES (?, ?, ?)").run(OTHER, `handoff:${food.orderingPlaceKey("https://order.thaipalace.example/menu")}=doordash`, Date.now());
  assert.equal((await startFor(OTHER, { why: "own_site_hands_off" }, ["get me pad thai from thai palace", "hmm let me think"])).not_doordash, true, "no yes yet");
  assert.equal((await startFor(OTHER, { why: "own_site_hands_off" }, ["get me pad thai from thai palace", "yes do it"])).ok, true);
});

test("6b. (c) its own checkout failed and they said yes to DoorDash: DoorDash; the failure wake offers it", async () => {
  set(EVERYONE());
  consent(OTHER);
  const id = Number(db.db.prepare("INSERT INTO food_orders (conversation_id, status, route, via, restaurant, store_url, run_id, failures, created_at, updated_at) VALUES (?, 'asked', 'direct', 'own_site', 'Thai Palace', 'https://order.thaipalace.example/menu', 'run_fail', 0, ?, ?)").run(OTHER, Date.now(), Date.now()).lastInsertRowid);
  const woke = [];
  food._attach({ wake: (c, t) => woke.push(t) });
  await food.ended({ run_id: "run_fail", result: "store refused" }, "failed");
  assert.ok(woke.some((t) => /Or the same order on DoorDash, if they say yes to that \(doordash_order start with why own_site_failed\)/.test(t)), woke.join(" | ").slice(0, 300));
  assert.equal((await startFor(OTHER, { why: "own_site_failed" }, ["the checkout broke", "no"])).not_doordash, true, "a no is not a yes");
  assert.equal((await startFor(OTHER, { why: "own_site_failed" }, ["yes try doordash"])).ok, true);
  void id;
  food._attach({});
});

// ---------------------------------------------------------------- 7. the invite wording
test("7. invite_link_create reads an invite or invitation to Reason, with no event named", () => {
  const t = toolsFor(OWNER).find((x) => x.name === "invite_link_create") ?? (toolsFor(OTHER).find((x) => x.name === "invite_link_create"));
  assert.ok(t, "shown");
  assert.ok(t.description.includes("Use when they want to invite someone or ask for an invite or invitation to Reason (no event named)."));
  assert.ok(!t.description.includes("or ask for a link."));
});
