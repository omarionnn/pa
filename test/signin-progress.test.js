// The store sign-in page is never dead (owner 2026-10-31, 14:10 ET: after Sign in at Walmart the page
// sat still for ~100 s, while Reason texted that Walmart was checking it). What holds:
//   1. Waiting on the store, the page carries a live block: a sweeping line, a status line that moves by
//      elapsed time, a clock; prefers-reduced-motion drops the sweep and keeps the words.
//   2. The status ladder is by elapsed seconds, from the record's answered_at, so a reopened page says
//      the right thing at once; /state carries `waited` for the open page to resync.
//   3. Every end is drawn: the run dying while the link still said open is "didn't go through" with
//      the reason and the next step, never "checking" for good; an old link says it expired, ask for a new one.
//   4. The Face ID "paying" step and the card "saving" step carry the same live block.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-signin-progress-"));
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

const shop = await import("../src/shopconnect.js");
const cx = await import("../src/pages/webconnect.js");
const ap = await import("../src/pages/webapprove.js");
const kit = await import("../src/pages/paperkit.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const EMAIL = "omari.secret.mailbox@example.com";
let calls, runs, profiles, nextRun;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  const h = init.headers ?? {};
  calls.push({ method: init.method ?? "GET", path: u.pathname, body });
  const who = h["x-crossmint-user-id"];
  const p = u.pathname;
  if (p === "/api/unstable/agent-checkouts/browser-profiles" && init.method === "POST") { profiles[who] = { id: "bp_1" }; return reply(201, profiles[who]); }
  if (p === "/api/unstable/agent-checkouts/browser-profiles") return reply(200, profiles[who] ? [profiles[who]] : []);
  if (p === "/api/unstable/agent-checkouts" && init.method === "POST") { const runId = `run_${nextRun++}`; runs[runId] = { status: "running", requiredAction: null }; return reply(201, { runId }); }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)(\/messages)?$/.exec(p);
  if (m && m[2]) return reply(202, { ok: true });
  if (m) return reply(200, { runId: m[1], ...runs[m[1]] });
  return reply(404, { message: "no route" });
}
const SIGNIN = (requestId) => ({
  type: "input_response", requestId, request: {
    question: "Enter your Walmart email and password.",
    interaction: { kind: "form", fields: [
      { key: "email", label: "Email", required: true, handling: "standard", input: { kind: "text", autoComplete: "email" } },
      { key: "password", label: "Password", required: true, handling: "protected", input: { kind: "text", display: "masked", autoComplete: "current-password" } },
    ] },
  },
});
const said = [];
const q = (sql) => db.db.prepare(sql);
before(() => { shop._setFetch(fakeFetch); shop.attach({ say: (c, t) => said.push({ c, t }), base: "https://heyreason.test/web/connect" }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; runs = {}; profiles = {}; nextRun = 1; said.length = 0;
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks"]) q(`DELETE FROM ${t}`).run();
});
const visible = (html) => html.replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<style\b[\s\S]*?<\/style>/g, "").replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const styles = (html) => (html.match(/<style\b[\s\S]*?<\/style>/g) ?? []).join("\n");
const scripts = (html) => (html.match(/<script\b[\s\S]*?<\/script>/g) ?? []).join("\n");

async function walmartLink() {
  const out = await shop.startCheckout({ conversationId: OMARI, store: "walmart", startUrl: "https://www.walmart.com/ip/1", what: "One CeraVe cleanser.", item: "CeraVe Hydrating Facial Cleanser", maxUsd: 20, signIn: true });
  runs[out.runId].status = "awaiting_input";
  runs[out.runId].requiredAction = SIGNIN("req_1");
  await shop.step(out.runId);
  return { runId: out.runId, token: said.at(-1).t.split("/").pop() };
}
const answer = (token) => shop.answerLink(token, { requestId: "req_1", answers: { email: EMAIL, password: { protectedInputId: "pi_1" } } });
const withClock = async (ahead, fn) => { const real = clock.now; clock.now = () => real() + ahead; try { return await fn(); } finally { clock.now = real; } };

// ---------------------------------------------------------------- 2. the ladder by elapsed time
test("the status line is by elapsed time: sent → checking → still checking → longer than usual → still here", () => {
  const L = cx.checkingLines("Walmart");
  assert.equal(kit.liveLine(L, 0), "Sent to Walmart, sealed.");
  assert.equal(kit.liveLine(L, 7_999), "Sent to Walmart, sealed.");
  assert.equal(kit.liveLine(L, 8_000), "Walmart is checking it.");
  assert.equal(kit.liveLine(L, 29_000), "Walmart is checking it.");
  assert.equal(kit.liveLine(L, 30_000), "Still checking. This can take a minute.");
  assert.equal(kit.liveLine(L, 75_000), "Taking longer than usual. Still on it.");
  assert.equal(kit.liveLine(L, 100_000), "Taking longer than usual. Still on it.", "the owner's 100 s wait would have read this");
  assert.match(kit.liveLine(L, 180_000), /Walmart hasn't answered yet.*I'll text you either way/);
  assert.match(kit.liveLine(L, 3_600_000), /I'll text you either way/, "the last line holds");
  const times = L.map(([s]) => s);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "in order");
  for (const lines of [cx.sendingLines("Walmart"), cx.savingLines(), ap.payingLines("Walmart", "$18.47")]) {
    assert.ok(lines.length >= 3 && lines[0][0] === 0, "every ladder starts at once and has steps");
    assert.ok(lines.every(([, t]) => t && !/crossmint/i.test(t)), "never names Crossmint");
  }
});

test("waited comes from the record: answered_at is set by the answer, the view and /state carry it, a reopened page is right at once", async () => {
  const { token } = await walmartLink();
  const before = shop.linkView(shop.linkFor(token));
  assert.equal(before.state, "signin");
  assert.equal((await answer(token)).ok, true);
  const link = shop.linkFor(token);
  assert.ok(Number.isInteger(link.answered_at) && link.answered_at <= clock.now(), "answered_at written");
  const view = shop.linkView(link);
  assert.equal(view.state, "checking");
  assert.equal(view.answered, true);
  assert.ok(view.waited >= 0 && view.waited < 2_000);
  assert.equal(view.stage, "in_progress", "the run moved on from needs_input");
  await withClock(95_000, async () => {
    const v = shop.linkView(shop.linkFor(token));
    assert.ok(v.waited >= 95_000 && v.waited < 97_000, `waited follows the clock: ${v.waited}`);
    const st = await cx.connectRequest({ sub: `${token}/state`, method: "GET" });
    const body = JSON.parse(st.body);
    assert.equal(body.state, "checking");
    assert.ok(body.waited >= 95_000, "/state carries waited");
    assert.equal(body.stage, "in_progress");
    const page = await cx.connectRequest({ sub: token, method: "GET" });
    assert.match(scripts(page.body), /"waited":9[5-6]\d{3}/, "the page boots with the record's waited, not zero");
  });
  const open = JSON.parse((await cx.connectRequest({ sub: token, method: "GET" })).body.match(/var B=(\{.*?\});/)[1]);
  assert.equal(open.watch, true);
});

// ---------------------------------------------------------------- 1. the live block
test("the checking page is alive: sweep, status line, clock, reduced-motion fallback, poll that wakes on return", async () => {
  const { token } = await walmartLink();
  await answer(token);
  const page = (await cx.connectRequest({ sub: token, method: "GET" })).body;
  const seen = visible(page);
  assert.match(seen, /Signing in to Walmart\./);
  assert.match(seen, /Hang tight\./);
  assert.doesNotMatch(seen, /A few seconds/, "no promise of seconds");
  assert.match(seen, /However it goes, I'll text you too\./);
  assert.match(page, /<div class="pf-live" id="cx-live" data-lines="/);
  assert.match(page, /<div class="pf-pulse" aria-hidden="true"><\/div>/, "the sweeping line");
  assert.match(page, /<p class="pf-live-t" role="status" aria-live="polite">Sent to Walmart, sealed\.<\/p>/, "the first line is drawn, before any script");
  assert.match(page, /class="pf-live-e">0:00<\/span> ELAPSED/, "the clock");
  const css = styles(page);
  assert.match(css, /@keyframes pf-sweep/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.pf-pulse\{display:none\}\.pf-live-still\{display:inline\}\}/, "reduced motion: no sweep, the words stay");
  assert.match(page, /<span class="pf-live-still">STILL WORKING · <\/span>/);
  const js = scripts(page);
  assert.match(js, /window\.pfLive=function/);
  assert.match(js, /window\.pfWake=function/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /addEventListener\('pageshow'/);
  assert.match(js, /pfWake\(poll\)/, "the poll runs at once when the page comes back");
  assert.match(js, /liv\.sync\(o\.waited\)/, "each poll resyncs the clock to the record");
  assert.match(js, /if\(o\.state!==B\.state\)return location\.reload\(\)/, "a new state redraws");
  assert.match(js, /cache:'no-store'/);
});

test("the sign-in form itself shows a live 'sending' line while the tap is in flight; so does the card form", async () => {
  const { token } = await walmartLink();
  const page = (await cx.connectRequest({ sub: token, method: "GET" })).body;
  assert.match(page, /<div class="pf-live" id="cx-wait" data-lines="[^"]*Sending to Walmart, sealed[^"]*" hidden>/, "hidden until the tap");
  assert.match(scripts(page), /if\(on&&!wl\)wl=pfLive\(wt,\{\}\)/, "busy() starts it");
  const card = cx.renderCard({}).html;
  assert.match(card, /id="cx-wait" data-lines="[^"]*Saving it securely[^"]*" hidden>/);
  assert.match(card, /id="cx-save-live" data-lines="[^"]*Checking the card with your bank/, "the saving step has one too");
  assert.doesNotMatch(visible(card), /on it\.\s*<\/p>/, "no static 'on it.'");
});

// ---------------------------------------------------------------- 3. every end is drawn
test("the run dies while the link still says open: the page says it didn't go through, why, and the next step; never 'checking' for good", async () => {
  const { runId, token } = await walmartLink();
  await answer(token);
  assert.equal(shop.linkView(shop.linkFor(token)).state, "checking");
  // Crossmint ended it while Reason was down (2026-10-31 18:06 UTC: a deploy's restart mid sign-in).
  q("UPDATE shop_runs SET status = 'failed', result = 'input_expired', stage = 'failed' WHERE run_id = ?").run(runId);
  const view = shop.linkView(shop.linkFor(token));
  assert.equal(view.state, "failed");
  assert.equal(view.reason, "timeout");
  const st = JSON.parse((await cx.connectRequest({ sub: `${token}/state`, method: "GET" })).body);
  assert.equal(st.state, "failed", "the open page's poll sees the end and redraws");
  const page = await cx.connectRequest({ sub: token, method: "GET" });
  assert.equal(page.status, 200, "the end of a real sign-in is a page, not a 410");
  const seen = visible(page.body);
  assert.match(seen, /That sign-in didn't go through\./);
  assert.match(seen, /Nothing was charged\./);
  assert.match(seen, /Walmart was waiting too long and gave up on this sign-in/);
  assert.match(seen, /Text me and I'll send a fresh one/);
  assert.match(seen, /CHECK YOUR WALMART ACCOUNT/);
  assert.match(seen, /Ask me in the chat for a new link/);
  assert.doesNotMatch(seen, /checking it/i);

  q("UPDATE shop_runs SET result = 'lost: Crossmint stopped answering about this run' WHERE run_id = ?").run(runId);
  assert.equal(shop.linkView(shop.linkFor(token)).reason, "lost");
  assert.match(visible((await cx.connectRequest({ sub: token, method: "GET" })).body), /I lost track of this sign-in: the checkout service stopped answering/);
  q("UPDATE shop_runs SET result = 'merchant.blocked' WHERE run_id = ?").run(runId);
  assert.equal(shop.linkView(shop.linkFor(token)).reason, "stopped");
  assert.match(visible((await cx.connectRequest({ sub: token, method: "GET" })).body), /Walmart stopped it before it finished/);
  // Started over by Reason (a corrected address): the old link was replaced, and the store isn't blamed.
  q("UPDATE shop_runs SET status = 'cancelled', result = 'superseded' WHERE run_id = ?").run(runId);
  assert.equal(shop.linkView(shop.linkFor(token)).reason, "replaced");
  const replaced = visible((await cx.connectRequest({ sub: token, method: "GET" })).body);
  assert.match(replaced, /This link was replaced\./);
  assert.match(replaced, /The newest link I texted you is the one to use\./);
  assert.doesNotMatch(replaced, /Walmart stopped it/);
  // Succeeded with the link still open reads as connected, never as a failure.
  q("UPDATE shop_runs SET status = 'succeeded', result = '' WHERE run_id = ?").run(runId);
  assert.equal(shop.linkView(shop.linkFor(token)).state, "connected");
});

test("the end the server records (step) reads the same on the page and in the chat", async () => {
  const { runId, token } = await walmartLink();
  await answer(token);
  runs[runId] = { status: "failed", requiredAction: null, result: { code: "input_expired", summary: "Request expired while waiting for input" } };
  await shop.step(runId);
  const view = shop.linkView(shop.linkFor(token));
  assert.equal(view.state, "failed");
  assert.equal(view.reason, "timeout");
  assert.match(said.at(-1).t, /Walmart was waiting for .* and didn't get it in time, so it expired\. Nothing was charged\./);
  assert.match(visible((await cx.connectRequest({ sub: token, method: "GET" })).body), /gave up on this sign-in.*Nothing was charged|Nothing was charged/s);
});

test("an old link says it expired and to ask for a new one, with a 410, for a store link and a card link alike", async () => {
  const { token } = await walmartLink();
  await withClock(shop.LINK_TTL_MS + 1000, async () => {
    const page = await cx.connectRequest({ sub: token, method: "GET" });
    assert.equal(page.status, 410);
    const seen = visible(page.body);
    assert.match(seen, /This link has expired\./);
    assert.match(seen, /Ask me for a new one\./);
    assert.match(seen, /Nothing was signed in\. Text me and I'll send a fresh Walmart link\./);
    assert.doesNotMatch(seen, /<form/, "no dead form");
    assert.doesNotMatch(page.body, /class="pf-live"/, "nothing waits on a dead link");
  });
  const cardToken = shop.cardLink(OMARI);
  await withClock(shop.LINK_TTL_MS + 1000, async () => {
    const page = await cx.connectRequest({ sub: cardToken, method: "GET" });
    assert.equal(page.status, 410);
    assert.match(visible(page.body), /This link has expired\..*Ask me for a new one\..*Nothing was saved/s);
  });
  const none = await cx.connectRequest({ sub: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", method: "GET" });
  assert.equal(none.status, 410);
  assert.match(visible(none.body), /This link has expired\./);
});

// ---------------------------------------------------------------- 4. the other waits
test("the Face ID approve page's paying step is alive, and its script starts the clock on show('paying')", () => {
  const v = { state: "open", store: "Walmart", amount: "$18.47", item: "CeraVe Hydrating Facial Cleanser", expiresAt: Date.now() + 5 * 60_000, a: {} };
  const html = ap.renderApprove({ v, boot: { base: "/web/approve/t", options: { challenge: "AA", rpId: "heyreason.com", timeout: 60000 } } }).html;
  assert.match(html, /data-step="paying"[\s\S]*?<div class="pf-live" id="pk-live" data-lines="[^"]*Paying \$18\.47 at Walmart\.[^"]*"/);
  assert.match(visible(html), /Keep this open until it's through\. However it goes, I'll text you too\./);
  assert.match(styles(html), /@keyframes pf-sweep/);
  const js = scripts(html);
  assert.match(js, /window\.pfLive=function/);
  assert.match(js, /if\(n==='paying'&&lv&&window\.pfLive&&!liv\)liv=pfLive\(lv,\{\}\)/, "starts when paying shows");
  assert.match(js, /else if\(n!=='paying'&&liv\)\{liv\.stop\(\);liv=null\}/, "stops on any other screen");
  const L = ap.payingLines("Walmart", "$18.47");
  assert.equal(kit.liveLine(L, 0), "Paying $18.47 at Walmart.");
  assert.match(kit.liveLine(L, 80_000), /never pay twice/);
});

test("live() draws safely: the store's name and the lines are escaped, and the clock is not read aloud", () => {
  const html = kit.live({ id: "x", lines: [[0, `Sent to <b>"Store"</b>, sealed.`], [8, "Next"]] });
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /data-lines="\[\[0,&quot;Sent to &lt;b&gt;/);
  assert.match(html, /<p class="pf-live-s" aria-hidden="true">/);
  assert.match(html, /role="status" aria-live="polite">Sent to &lt;b&gt;/);
  assert.equal(kit.liveLine([], 5_000), "", "no lines, no text, no throw");
});
