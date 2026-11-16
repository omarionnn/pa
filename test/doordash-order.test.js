// A DoorDash order on the person's own account in the hosted browser (src/doordash.js), driven end to end
// through the real browser tools on a FIXTURE DoorDash (served on loopback as www.doordash.com) inside a
// real local Chromium reached over CDP, with a FAKE Browserbase API. Nothing reaches the internet, no
// real account, no real order, no paid API. The fixture models DoorDash's flow (address, search, store,
// item options, cart, checkout breakdown, tip, Place order, confirmation) closely enough to drive every
// step and every stop; the real pages will differ (see the PR for what is unproven).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-doordash-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:dd-owner";
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1";
const ENV = ["REASON_REMOTE_BROWSER", "REASON_REMOTE_BROWSER_SITES", "REASON_REMOTE_BROWSER_MONTH_MINUTES", "REASON_REMOTE_BROWSER_SESSION_MINUTES",
  "REASON_REMOTE_BROWSER_START_MS", "REASON_REMOTE_BROWSER_IDLE_MS", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "BROWSERBASE_API_URL",
  "REASON_DOORDASH_PAY", "REASON_DOORDASH_ORDER_MINUTES", "REASON_FOOD", "REASON_SAVED_LOGINS"];
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
const bb = { calls: [], connectUrl: "", n: 0 };
const bbServer = createServer(async (req, res) => {
  let body = ""; for await (const ch of req) body += ch;
  bb.calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
  const route = `${req.method} ${req.url.replace(/\/[a-z]+_\d+$/, "/:id")}`;
  const json = (st, o) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
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
  address: "3247 Bruner Ave, Apt 1, Bronx, NY", cart: [], tip: 300, mode: "normal", placed: 0, placeAttempts: 0, raise: 0, pastOrder: true,
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
  const send = (html, st = 200) => { res.writeHead(st, { "content-type": "text/html" }); res.end(html); };
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
const msg = (t) => ({ role: "user", content: `[Mon, Nov 16, 2026, 7:00 PM] Owner: ${t}` });
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
  const st = await d.call("doordash_order", { action: "start", restaurant: "Thai Palace", ...(tip ? { tip } : {}) });
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

// ---------------------------------------------------------------- pure readings
test("the checkout reading: breakdown and total on one line or two, discounts negative, the estimate, and each stop", () => {
  const r = dd.readCheckout("Checkout\nDelivery time\nStandard 25–35 min\nSubtotal $21.90\nDelivery Fee\n$2.99\nService Fee: $3.29\nDashPass savings\n-$2.99\nEstimated Tax\n$1.94\nDasher Tip\n$5.00\nTotal\n$32.13\nPlace Order");
  assert.equal(r.total, 3213); assert.equal(r.tip, 500); assert.equal(r.subtotal, 2190); assert.equal(r.eta, "25–35 min"); assert.equal(r.stop, "");
  assert.equal(r.lines.find(l => l.kind === "discount").cents, -299);
  assert.equal(r.adds_up, true);
  assert.equal(dd.readCheckout("Total $10.00\nEnter your card's security code (CVV)").stop, "card");
  assert.equal(dd.readCheckout("Total $10.00\nVerify your phone number").stop, "identity");
  assert.equal(dd.readCheckout("Total $10.00\nYour account is on hold").stop, "account");
  assert.equal(dd.readCheckout("Total $10.00\nA valid ID will be checked at delivery (21+)").stop, "age");
  assert.equal(dd.readCheckout("Total $10.00\nPad Thai is currently unavailable").stop, "unavailable");
  assert.deepEqual(dd.tipSaid("tip 18%"), { pct: 18 }); assert.deepEqual(dd.tipSaid("give them $5"), { cents: 500 }); assert.equal(dd.tipSaid("whatever"), null);
  assert.ok(dd.sameAddress("3247 Bruner Avenue, Apt 1", "3247 bruner ave")); assert.ok(!dd.sameAddress("3274 Bruner Ave", "3247 Bruner Ave"));
  assert.ok(dd.pageShowsAddress("Delivery address\n3247 Bruner Ave, Apt 1", "3247 Bruner Avenue")); assert.ok(!dd.pageShowsAddress("Delivery address\n12 Main St", "3247 Bruner Ave"));
});

// ---------------------------------------------------------------- routing and identity
test("switch off, food off, or a person it does not cover: no DoorDash tool, and the prompt, tools and capabilities hash as before", () => {
  const hash = (c) => createHash("sha256").update(JSON.stringify(toolsFor(c))).update(JSON.stringify(capabilitiesNow({ conversationId: c }))).update(SYSTEM).digest("hex");
  set({ REASON_FOOD: "owner" });
  const offOwner = hash(OWNER); const offOther = hash(OTHER);
  set({ REASON_FOOD: "owner", REASON_DOORDASH_PAY: "site_card" });
  assert.equal(hash(OWNER), offOwner, "the pay setting alone changes nothing");
  set(ON());
  assert.equal(hash(OTHER), offOther, "owner mode: somebody else is unchanged");
  const tools = toolsFor(OWNER).map(t => t.name);
  assert.ok(tools.includes("doordash_order")); assert.ok(!tools.includes("doordash_place"), "handoff: no tool that places");
  assert.match(toolsFor(OWNER).find(t => t.name === "food_order").description, /through doordash_order/);
  set(ON({ REASON_DOORDASH_PAY: "site_card" }));
  assert.ok(toolsFor(OWNER).some(t => t.name === "doordash_place"));
  set(ON({ REASON_FOOD: "off" }));
  assert.ok(!toolsFor(OWNER).some(t => dd.DOORDASH_TOOLS.has(t.name)), "food off: no DoorDash order tools");
});

test("Crossmint's checkout never runs DoorDash for a covered person: doordash_order instead", async () => {
  set(ON({ REASON_SHOP_CONNECT: "on" }));
  const { runShopTool } = await import("../src/shoptools.js");
  const shop = await import("../src/shopconnect.js");
  if (!shop.connectAllowedFor(OWNER)) return; // checkout agent off here: nothing to route
  const out = await runShopTool("store_checkout", { store: "doordash", start_url: "https://www.doordash.com/store/x", item: "pad thai", what: "pad thai" }, { conversationId: OWNER });
  assert.equal(out.use_instead, "doordash_order");
});

// ---------------------------------------------------------------- B7: minutes before starting
test("an order that would not fit the month's remaining minutes is not started, and says so first", async () => {
  set(ON({ REASON_REMOTE_BROWSER_MONTH_MINUTES: "12" }));
  consent();
  const month = new Date().toISOString().slice(0, 7);
  db.db.prepare("INSERT INTO remote_browser_month (month, seconds) VALUES (?, ?)").run(month, 5 * 60);
  const out = await runTool("doordash_order", { action: "start", restaurant: "Thai Palace" }, { conversationId: OWNER, kind: "user", messages: [msg("get me pad thai")] });
  assert.equal(out.budget, true);
  assert.match(out.say_exactly, /about 7 minutes of hosted-browser time left this month and a DoorDash order takes about 10/);
  assert.equal(sessionsMade(), 0);
});

// ---------------------------------------------------------------- B2/B4 handoff, end to end
test("handoff (default): the cart is built, the exact breakdown read, the tip said as DoorDash's default, and Place order is never pressed", skip, async () => {
  set(ON());
  consent();
  const d = driver(OWNER, "get me pad thai medium and spring rolls from thai palace to 3247 Bruner Ave");
  await buildCart(d);
  const out = await d.call("doordash_order", { action: "checkout", items: ITEMS });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400));
  assert.equal(out.handed_off, true);
  const t = totals();
  assert.equal(out.total, money(t.total));
  assert.match(out.say_exactly, new RegExp(`${money(t.total).replace("$", "\\$")} all in \\(Subtotal \\$21\\.90, Delivery Fee \\$2\\.99, Service Fee \\$3\\.29, Estimated Tax \\$1\\.94, Dasher Tip \\$3\\.00, Total`));
  assert.match(out.say_exactly, /DoorDash's default tip of \$3\.00/);
  assert.match(out.say_exactly, /to 3247 Bruner Ave, about 25–35 min/);
  assert.match(out.say_exactly, /I didn't place it/);
  assert.match(out.say_exactly, /DoorDash doesn't say whether a cart made on the web shows up in the app/);
  assert.doesNotMatch(out.say_exactly, /\b(say|text|reply|type|send)\s+["“]/i, "no phrase to type");
  assert.equal(S.placeAttempts, 0);
  assert.equal(remote.remoteSessionsOpen(), 0, "the hosted session is closed once handed off");
  const o = food.ownOrder(OWNER, dd.orderRow(OWNER).order_id);
  assert.equal(o.cart_total, money(t.total)); assert.equal(o.platform, "doordash");
});

test("handoff: no path presses Place order: doordash_place, browser_submit with a yes, browser_click, Enter on the checkout", skip, async () => {
  set(ON());
  consent();
  const d = driver(OWNER, "get me pad thai medium and spring rolls from thai palace to 3247 Bruner Ave");
  await buildCart(d);
  await d.call("doordash_order", { action: "checkout", items: ITEMS });
  // The tool is not even shown; called anyway, it refuses.
  const placed = await d.call("doordash_place", {});
  assert.notEqual(placed.ok, true);
  // On the checkout page itself, every generic way in.
  await d.open("/consumer/checkout/");
  const placeRef = d.ref(/Place Order/);
  assert.equal((await d.call("browser_click", { ref: placeRef })).ok, false);
  const req = await d.call("confirm_request", { action: "browser_submit", summary: "Place the Thai Palace order for $38.11?", stakes: "money", target: "Place the Thai Palace order for $38.11" });
  d.say("yes place it");
  await d.call("confirm_record", { confirmation_id: req.confirmation_id });
  const sub = await d.call("browser_submit", { ref: placeRef, what: "Place the Thai Palace order for $38.11", confirmation_id: req.confirmation_id });
  assert.equal(sub.blocked, "doordash_place_only", JSON.stringify(sub).slice(0, 200));
  await d.read();
  const enter = await d.call("browser_type", { ref: d.ref(/Other tip amount/), text: "4", press_enter: true });
  assert.equal(enter.blocked, "doordash_place_only");
  assert.equal(S.placeAttempts, 0, "DoorDash never received a place");
});

test("the tip they said is set on the page before the checkout is accepted, and said as theirs", skip, async () => {
  set(ON());
  consent();
  const d = driver(OWNER, "pad thai and spring rolls from thai palace to 3247 Bruner Ave, tip $5");
  await buildCart(d, { tip: "$5" });
  const first = await d.call("doordash_order", { action: "checkout", items: ITEMS });
  assert.equal(first.ok, false);
  assert.match(first.error, /Set the Dasher tip to \$5\.00/);
  await d.read();
  await d.click(/^\$5\.00$/);
  const out = await d.call("doordash_order", { action: "checkout", items: ITEMS });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.match(out.say_exactly, /your \$5\.00 tip/);
});

test("\"my usual\": the past order's Reorder builds the cart", skip, async () => {
  set(ON());
  consent();
  const d = driver(OWNER, "order my usual from thai palace to 3247 Bruner Ave");
  assert.equal((await d.call("doordash_order", { action: "start", restaurant: "Thai Palace", usual: true })).ok, true);
  await d.open("/");
  assert.equal((await d.call("doordash_order", { action: "address", address: "3247 Bruner Ave" })).ok, true);
  await d.click(/^Orders$/);
  assert.equal((await d.click(/^Reorder$/)).ok, true);
  const out = await d.call("doordash_order", { action: "checkout", items: ITEMS });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(S.placeAttempts, 0);
});

// ---------------------------------------------------------------- the address
test("the address: never one they didn't give; a saved one DoorDash doesn't show is asked; the checkout must show theirs", skip, async () => {
  set(ON());
  consent();
  const d = driver(OWNER, "get me pad thai from thai palace to my place");
  await d.call("doordash_order", { action: "start", restaurant: "Thai Palace" });
  await d.open("/");
  const guess = await d.call("doordash_order", { action: "address", address: "88 Grand St" });
  assert.equal(guess.ask, true, "not in their words, not saved: asked");
  db.savePlace(OWNER, { name: "Home", address: "52 Elm St, Brooklyn, NY", lat: 40.7, lng: -73.9 });
  const saved = await d.call("doordash_order", { action: "address", address: "52 Elm St" });
  assert.equal(saved.differs, true, JSON.stringify(saved).slice(0, 300));
  assert.match(saved.say_exactly, /DoorDash is set to a different address than Home \(52 Elm St\)/);
  // Their own words name it: DoorDash is changed to it, and the checkout must show it.
  const d2 = driver(OWNER, "pad thai and spring rolls from thai palace to 3247 Bruner Ave");
  await buildCart(d2);
  S.address = "12 Main St, Bronx, NY"; // DoorDash moved it under us
  const out = await d2.call("doordash_order", { action: "checkout", items: ITEMS });
  assert.equal(out.address_differs, true);
  assert.equal(S.placeAttempts, 0);
});

// ---------------------------------------------------------------- B6 stops
test("stops: unavailable (asked, no swap), alcohol, verify identity, account problem, card re-verification; each one plain line, session closed, nothing placed", skip, async () => {
  const cases = [
    { mode: "unavailable", key: "ask", re: /The Pad Thai isn't available at Thai Palace right now\. Want me to leave it out, or swap it for something\?/ },
    { mode: "verify", key: "stopped", re: /verify your identity or phone/ },
    { mode: "account", key: "stopped", re: /problem with your account or payment/ },
    { mode: "card", key: "stopped", re: /re-enter or verify your card, which I never do/ },
    { mode: "alcohol", key: "stopped", re: /age-restricted item/ },
  ];
  for (const k of cases) {
    await browser.closeAllBrowsers().catch(() => {}); resetSite(); dd._resetDoordash(); db.db.exec("DELETE FROM food_orders");
    set(ON()); consent();
    const d = driver(OWNER, "pad thai and spring rolls from thai palace to 3247 Bruner Ave");
    await buildCart(d, k.mode === "alcohol" ? { extraItem: /^Singha Beer/ } : {});
    if (k.mode !== "alcohol") S.mode = k.mode;
    const out = await d.call("doordash_order", { action: "checkout", items: ITEMS });
    assert.equal(out.ok, false, k.mode);
    assert.ok(out[k.key], `${k.mode}: ${JSON.stringify(out).slice(0, 200)}`);
    assert.match(out.say_exactly, k.re, k.mode);
    assert.equal(remote.remoteSessionsOpen(), 0, `${k.mode}: session closed`);
    assert.equal(S.placeAttempts, 0, k.mode);
  }
});

test("a challenge at checkout ends the job once, marked for the hosted browser, never retried", skip, async () => {
  set(ON());
  consent();
  const d = driver(OWNER, "pad thai and spring rolls from thai palace to 3247 Bruner Ave");
  await buildCart(d);
  const pg = browser.openPage(OWNER);
  await pg.evaluate(() => { document.body.innerHTML = "<h1>Verify you are human</h1><p>Press and hold the button.</p>"; });
  const out = await d.call("doordash_order", { action: "checkout", items: ITEMS });
  assert.equal(out.hosted_browser, "challenge");
  assert.ok(refusing.refusingSite("doordash.com", undefined, { browser: "remote" }));
  assert.equal(remote.remoteSessionsOpen(), 0);
});

// ---------------------------------------------------------------- B3/B4/B5 site_card
async function readyToPlace(extraEnv = {}) {
  set(ON({ REASON_DOORDASH_PAY: "site_card", ...extraEnv }));
  consent();
  const d = driver(OWNER, "pad thai and spring rolls from thai palace to 3247 Bruner Ave");
  await buildCart(d);
  const read = await d.call("doordash_order", { action: "checkout", items: ITEMS });
  assert.equal(read.ok, true, JSON.stringify(read).slice(0, 300));
  return { d, read };
}
async function yes(d, target, words = "yes place it") {
  const req = await d.call("confirm_request", { action: "doordash_place", summary: "Place it?", stakes: "money", target });
  d.say(words);
  const rec = await d.call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal(rec.state, "granted", JSON.stringify(rec).slice(0, 200));
  return req.confirmation_id;
}

test("site_card: the ask carries the exact total, breakdown, restaurant, address and estimate; no yes, nothing pressed; the yes places it and the confirmation is read once", skip, async () => {
  const { d, read } = await readyToPlace();
  const t = totals();
  assert.match(read.say_exactly, new RegExp(`^${money(t.total).replace("$", "\\$")} from Thai Palace to 3247 Bruner Ave, about 25–35 min, on the card already on your DoorDash account \\(Subtotal`));
  assert.match(read.say_exactly, /Place it\?$/);
  assert.equal(read.use_target, `doordash order #${dd.orderRow(OWNER).order_id} r${dd.orderRow(OWNER).revision}: ${money(t.total)} from Thai Palace to 3247 Bruner Ave`);
  const no = await d.call("doordash_place", {});
  assert.equal(no.ok, false); assert.ok(no.use_target ?? no.error);
  assert.equal(S.placeAttempts, 0, "no yes, no press");
  const id = await yes(d, read.use_target);
  const out = await d.call("doordash_place", { confirmation_id: id });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(S.placed, 1);
  assert.equal(out.order_number, "DD48213");
  assert.match(out.say_exactly, /^Placed: Thai Palace, Pad Thai, Spring Rolls\. \$\d+\.\d\d charged, here by .+\. Going to 3247 Bruner Ave\. If you want, I can check on it once later\.$/);
  assert.equal(remote.remoteSessionsOpen(), 0);
  assert.equal(food.ownOrder(OWNER, out.order_id).status, "placed");
  // The yes is spent: a second press is refused by the gate.
  const again = await d.call("doordash_place", { confirmation_id: id });
  assert.notEqual(again.ok, true);
  assert.equal(S.placeAttempts, 1);
  // One status check, only when they ask.
  const st = await d.call("doordash_order", { action: "status" });
  assert.equal(st.status, "on the way");
  const ev = await runTool("doordash_order", { action: "status" }, { conversationId: OWNER, kind: "event", messages: [] });
  assert.equal(ev.ok, false, "never a check Reason starts by itself");
});

test("site_card: a total that changes after the yes is not placed; it is asked again and the old yes cannot pay the new total", skip, async () => {
  const { d, read } = await readyToPlace();
  const id = await yes(d, read.use_target);
  S.raise = 150; // DoorDash's total moves by $1.50 between the yes and the press
  const out = await d.call("doordash_place", { confirmation_id: id });
  assert.equal(out.total_changed, true, JSON.stringify(out).slice(0, 300));
  assert.match(out.say_exactly, /changed from \$\d+\.\d\d to \$\d+\.\d\d since you said yes, so I didn't place it/);
  assert.equal(S.placeAttempts, 0);
  // The old yes against the new target: refused by the gate, nothing pressed.
  const old = await d.call("doordash_place", { confirmation_id: id });
  assert.notEqual(old.ok, true);
  assert.equal(S.placeAttempts, 0);
  const id2 = await yes(d, out.use_target, "ok yes");
  assert.equal((await d.call("doordash_place", { confirmation_id: id2 })).ok, true);
  assert.equal(S.placed, 1);
});

test("site_card: DoorDash asking for the card's CVV after the press stops it; nothing placed and never retried", skip, async () => {
  const { d, read } = await readyToPlace();
  S.mode = "cvv_after_press";
  const id = await yes(d, read.use_target);
  const out = await d.call("doordash_place", { confirmation_id: id });
  assert.equal(out.stopped, "card", JSON.stringify(out).slice(0, 300));
  assert.match(out.say_exactly, /never do/);
  assert.equal(S.placed, 0);
  assert.equal(remote.remoteSessionsOpen(), 0);
});

test("site_card: their own spending limit applies unchanged", skip, async () => {
  db.setSpendCaps(OWNER, { perPurchaseCents: 2_000, monthlyCents: 100_000, said: "twenty a thing" });
  try {
    const { d, read } = await readyToPlace();
    const id = await yes(d, read.use_target);
    const out = await d.call("doordash_place", { confirmation_id: id });
    assert.notEqual(out.ok, true);
    assert.equal(S.placeAttempts, 0);
  } finally { db.setSpendCaps(OWNER, { perPurchaseCents: 20_000, monthlyCents: 100_000, said: "two hundred a thing" }); }
});

// ---------------------------------------------------------------- housekeeping (A2-A5)
test("A3: the session length never exceeds 900 s, and a higher setting is said in the digest", skip, async () => {
  set(ON({ REASON_REMOTE_BROWSER_SESSION_MINUTES: "30" }));
  consent();
  assert.equal(remote.sessionCapMinutes(), 15);
  await runTool("browser_open", { url: DD("/") }, { conversationId: OWNER, kind: "user", messages: [msg("open doordash")] });
  const sent = bb.calls.find(c => c.method === "POST" && c.path === "/v1/sessions");
  assert.equal(sent.body.timeout, 900);
  assert.ok(opsdigest.pending().some(r => /SESSION_MINUTES is 30, above the 15-minute ceiling/.test(r.text)));
  await browser.closeBrowser(OWNER);
});

test("A4: an unconfirmed delete is retried once a day on the digest pass, with no timer of its own", async () => {
  set(ON());
  db.db.prepare("INSERT OR IGNORE INTO remote_browser_orphans (context_id, at) VALUES ('ctx_old', ?)").run(Date.now());
  db.opsSet("remote_browser:retry_day", "");
  const noon = new Date(); noon.setHours(13, 0, 0, 0);
  assert.equal(await remote.dailyRetry({ now: noon.getTime() }), 1);
  assert.ok(bb.calls.some(c => c.method === "DELETE" && c.path === "/v1/contexts/ctx_old"));
  db.db.prepare("INSERT OR IGNORE INTO remote_browser_orphans (context_id, at) VALUES ('ctx_new', ?)").run(Date.now());
  assert.equal(await remote.dailyRetry({ now: noon.getTime() + 60_000 }), 0, "once a day");
  const src = (await import("node:fs")).readFileSync(new URL("../src/ops.js", import.meta.url), "utf8");
  assert.match(src, /rb\.dailyRetry\(\)/, "hung on the existing ops pass");
});

test("A5: a hosted email sign-in waiting for their texted-back code waits 5 minutes at most, and its ask says so", skip, async () => {
  set(ON());
  consent();
  const sie = await import("../src/signinemail.js");
  const told = [];
  const entry = remote.tagEntry(OWNER, { site: "doordash", label: "DoorDash", signin_url: DD("/consumer/login") });
  // Long waits are run short here (the code under test sets them; the test only does not sit through them).
  const realSet = globalThis.setTimeout; const asked = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { if (ms >= 60_000) { asked.push(ms); return realSet(fn, 20, ...rest); } return realSet(fn, ms, ...rest); };
  try {
    const out = sie.startEmailSignin({
      conversationId: OWNER, entry, email: "someone@example.com", log: () => {}, note: (c, t) => told.push(t), replyWaitMs: 20 * 60_000,
      launch: async ({ site }) => { const ctx = await remote.openRemote((await import("playwright")).chromium, OWNER, site); const pg = ctx.pages()[0] ?? await ctx.newPage(); await pg.goto(DD("/consumer/login")); return { page: pg, close: () => ctx.close() }; },
      gmail: async () => ({ connected: false }),
      check: async () => ({ ok: true, state: "unknown" }),
    });
    await out.run;
  } finally { globalThis.setTimeout = realSet; sie._resetJobs(); }
  assert.ok(asked.includes(5 * 60_000), `the wait asked for: ${asked.join(",")}`);
  assert.ok(!asked.includes(20 * 60_000));
  assert.ok(told.some((t) => t.includes("I can wait 5 minutes for it.")), told.join(" | ").slice(0, 400));
  assert.ok(told.some((t) => /waited 5 minutes for the code/.test(t)));
  assert.equal(remote.remoteSessionsOpen(), 0, "the session is closed when the wait ends");
});
