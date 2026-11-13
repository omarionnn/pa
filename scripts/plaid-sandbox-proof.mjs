#!/usr/bin/env node
// The gated real-Sandbox proof for the bank connection (src/plaid.js). Run BY HAND, never on a
// schedule, never in CI. It talks to Plaid's real Sandbox (sandbox.plaid.com, test banks, no real
// money and no real person) THROUGH THE INTEGRATION'S OWN FUNCTIONS, against a throwaway local
// database, for a made-up person, and writes what really came back.
//
//   REASON_PLAID_SANDBOX=1 node scripts/plaid-sandbox-proof.mjs [--env-file PATH] [--out DIR] [--save DIR]
//
// Keys: PLAID_CLIENT_ID and PLAID_SECRET_SANDBOX from the environment, or just those two lines (and
// REASON_PUBLIC_URL) read out of --env-file. They are never printed and never written anywhere.
//
// It refuses anything but Sandbox: every request passes through a `fetch` that throws unless the
// host is sandbox.plaid.com, PLAID_ENV is forced off production, and only the Sandbox secret is in
// the process. Every Item it makes is removed at Plaid before it exits.
//
// --out DIR   where the run's record goes (default: a new directory under the system temp dir):
//               report.json   what each step proved, with the numbers
//               calls.jsonl   every Plaid request and response, with every token, item id, account
//                             id, transaction id, request id and link token replaced by a placeholder
// --save DIR  also writes one trimmed, placeholder-only response per endpoint and outcome: this is
//             where test/fixtures/plaid/ comes from.
//
// Stdout is one short line per step. Nothing bulky and no identifier is ever printed.
//
// Sandbox-only endpoints (/sandbox/public_token/create, /sandbox/transactions/create,
// /sandbox/item/reset_login, /sandbox/item/fire_webhook, /item/webhook/update) are the scaffolding:
// they stand in for the person at the bank. Everything the product does (link, exchange, accounts,
// sync, balance, recurring, update mode, key lookup, remove) is src/plaid.js doing it.
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";

if (process.env.REASON_PLAID_SANDBOX !== "1") {
  console.error("Real calls to Plaid's Sandbox: set REASON_PLAID_SANDBOX=1 to run this on purpose.");
  process.exit(2);
}
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : null; };

// ---------------------------------------------------------------- keys and a throwaway install
function linesOf(file, names) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && names.includes(m[1])) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
const fromFile = opt("--env-file") ? linesOf(opt("--env-file"), ["PLAID_CLIENT_ID", "PLAID_SECRET_SANDBOX", "REASON_PUBLIC_URL"]) : {};
const CLIENT_ID = String(process.env.PLAID_CLIENT_ID || fromFile.PLAID_CLIENT_ID || "").trim();
const SECRET = String(process.env.PLAID_SECRET_SANDBOX || fromFile.PLAID_SECRET_SANDBOX || "").trim();
const PUBLIC_URL = String(opt("--public-url") || process.env.REASON_PUBLIC_URL || fromFile.REASON_PUBLIC_URL || "").replace(/\/+$/, "");
if (!CLIENT_ID || !SECRET) { console.error("PLAID_CLIENT_ID and PLAID_SECRET_SANDBOX are needed (environment, or --env-file PATH)."); process.exit(2); }

const dir = mkdtempSync(path.join(tmpdir(), "reason-plaid-sandbox-"));
const outDir = opt("--out") ?? mkdtempSync(path.join(tmpdir(), "plaid-sandbox-proof-"));
mkdirSync(outDir, { recursive: true });
for (const k of Object.keys(process.env)) if (/^(PLAID_|REASON_|ANTHROPIC_)/.test(k) && k !== "REASON_PLAID_SANDBOX") delete process.env[k];
Object.assign(process.env, {
  REASON_DB_PATH: path.join(dir, "reason.db"), REASON_DATA_DIR: dir, REASON_TZ: "America/New_York", REASON_OWNER_NAME: "Sandbox",
  REASON_CONVERSATION: "dm:owner",
  // Encryption at rest on and strict, as the offline suite runs it: a plaintext write to a sealed column fails the run.
  REASON_ENCRYPT_REST: "on", REASON_ENCRYPT_REST2: "on", REASON_ENCRYPT_STRICT: "1", REASON_REST_KEK_SOURCE: "local",
  REASON_REST_KEK: randomBytes(32).toString("hex"), REASON_TOKEN_KEY: randomBytes(32).toString("hex"),
  REASON_PLAID: "on", PLAID_CLIENT_ID: CLIENT_ID, PLAID_SECRET_SANDBOX: SECRET,
  ...(PUBLIC_URL ? { REASON_PUBLIC_URL: PUBLIC_URL } : {}),
});

const d = await import("../src/db.js");
const plaid = await import("../src/plaid.js");
const http = await import("../src/http.js");
const { clock } = await import("../src/config.js");
if (plaid.plaidEnv() !== "sandbox" || !plaid.configured()) { console.error("not Sandbox, or not configured: stopping."); process.exit(2); }

// ---------------------------------------------------------------- the recorder
// Real identifiers never leave this process: each becomes a placeholder the moment it is seen.
const ph = new Map(); // real -> placeholder
const kindOf = new Map(); // real -> kind
const counts = {};
function place(kind, real) {
  if (typeof real !== "string" || !real || placeholders.has(real)) return real; // a placeholder met again (the report quotes recorded calls) stays itself
  if (ph.has(real)) return ph.get(real);
  counts[kind] = (counts[kind] ?? 0) + 1;
  const n = counts[kind];
  const made = {
    access_token: `access-sandbox-PLACEHOLDER-${n}`, public_token: `public-sandbox-PLACEHOLDER-${n}`, link_token: `link-sandbox-PLACEHOLDER-${n}`,
    item_id: `ITEM_ID_${n}`, account_id: `ACCOUNT_ID_${n}`, transaction_id: `TRANSACTION_ID_${n}`, request_id: "REQUEST_ID",
    hosted_link_url: `https://secure.plaid.com/hl/PLACEHOLDER${n}`, link_session_id: `LINK_SESSION_ID_${n}`, cursor: `CURSOR_${n}`,
    stream_id: `STREAM_ID_${n}`, persistent_account_id: `PERSISTENT_ACCOUNT_ID_${n}`, client_user_id: "CLIENT_USER_ID", key_id: `KEY_ID_${n}`,
    state: "STATE",
  }[kind] ?? `${kind.toUpperCase()}_${n}`;
  ph.set(real, made); kindOf.set(real, kind); placeholders.add(made);
  if (kind === "hosted_link_url" || kind === "item_id" || kind === "account_id" || kind === "client_user_id") embedded.add(real);
  return made;
}
const placeholders = new Set();
const embedded = new Set(); // real values that can turn up INSIDE a longer string (a text carries the link; an error message can name an Item)
const KEY_KIND = {
  access_token: "access_token", public_token: "public_token", public_tokens: "public_token", link_token: "link_token", item_id: "item_id",
  account_id: "account_id", account_ids: "account_id", transaction_id: "transaction_id", transaction_ids: "transaction_id", pending_transaction_id: "transaction_id",
  request_id: "request_id", hosted_link_url: "hosted_link_url", link_session_id: "link_session_id", next_cursor: "cursor", cursor: "cursor",
  stream_id: "stream_id", persistent_account_id: "persistent_account_id", client_user_id: "client_user_id", key_id: "key_id", kid: "key_id",
  processor_token: "access_token", account_owner: null,
};
const TOKEN_RE = /\b(access|public|link)-sandbox-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
function scrubString(s) {
  let out = s.replace(TOKEN_RE, (m, k) => place(`${k}_token`, m));
  if (PUBLIC_URL && out.includes(PUBLIC_URL)) out = out.split(PUBLIC_URL).join("https://reason.test");
  for (const real of embedded) if (out.includes(real)) out = out.split(real).join(ph.get(real));
  out = out.replace(/([?&]s=)([A-Za-z0-9_-]{16,})/g, (m, a, b) => a + place("state", b));
  return out.split(CLIENT_ID).join("CLIENT_ID").split(SECRET).join("SECRET");
}
function scrub(v, key = "") {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(x => scrub(x, key));
  if (typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) { if (k === "client_id" || k === "secret") continue; o[k] = scrub(x, k); } return o; }
  if (typeof v !== "string") return v;
  const kind = KEY_KIND[key];
  if (kind && v) return place(kind, v);
  return ph.get(v) ?? scrubString(v);
}

const realFetch = globalThis.fetch;
const calls = [];          // placeholder-only: { n, path, ms, status, by, req, res }
const rawLast = new Map(); // path -> the last real response body (memory only, for the scaffolding)
const acctType = new Map(); // account id -> depository | credit | loan | investment, as Plaid sent it
const ledgers = new Map(); // access token -> Map(transaction_id -> the transaction as Plaid sent it): Plaid's own truth, to check answers against
let by = "integration";
async function recordingFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.host !== "sandbox.plaid.com") throw new Error(`refused: ${url.host} is not Plaid's Sandbox`);
  const reqBody = JSON.parse(typeof init.body === "string" && init.body ? init.body : "{}");
  const t0 = Date.now();
  const res = await realFetch(input, init);
  const text = await res.clone().text();
  let body; try { body = JSON.parse(text); } catch { body = { _unparsed: text.slice(0, 200) }; }
  rawLast.set(url.pathname, body);
  for (const a of Array.isArray(body.accounts) ? body.accounts : []) acctType.set(a.account_id, a.type);
  if (url.pathname === "/transactions/sync" && res.status === 200) {
    if (!ledgers.has(reqBody.access_token)) ledgers.set(reqBody.access_token, new Map());
    const L = ledgers.get(reqBody.access_token);
    for (const t of [...(body.added ?? []), ...(body.modified ?? [])]) L.set(t.transaction_id, t);
    for (const r of body.removed ?? []) L.delete(r.transaction_id);
  }
  calls.push({ n: calls.length + 1, path: url.pathname, ms: Date.now() - t0, status: res.status, by, req: scrub(reqBody), res: scrub(body) });
  return res;
}
plaid._setFetch(recordingFetch);
const callsTo = (p) => calls.filter(c => c.path === p);
const lastCall = (p) => callsTo(p).pop() ?? null;

// The scaffolding client: the same SDK, the same recorder, used only for Sandbox's stand-ins for a person.
const { PlaidClient, PlaidEnvironment } = await import("plaid");
const scaffold = new PlaidClient({ environment: PlaidEnvironment.Sandbox, clientId: CLIENT_ID, secret: SECRET, timeoutInSeconds: 30, maxRetries: 1, logging: { silent: true }, fetch: recordingFetch });
/** A scaffolding call that never throws: { ok, body } or { ok: false, code, type, message }. */
async function sb(fn) {
  by = "scaffold";
  try { return { ok: true, body: await fn(scaffold) }; }
  catch (e) { const b = e?.body && typeof e.body === "object" ? e.body : {}; return { ok: false, code: String(b.error_code ?? e?.name ?? "UNKNOWN"), type: String(b.error_type ?? ""), message: scrubString(String(b.error_message ?? e?.message ?? "")).slice(0, 300) }; }
  finally { by = "integration"; }
}

// ---------------------------------------------------------------- the made-up person, and what they were shown
const C = "dm:sendblue:+15555550142";
const NOW = Date.now();
const TZ = "America/New_York";
const ymd = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const addDays = (day, n) => { const x = new Date(`${day}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const TODAY = ymd(NOW);
const said = [], logged = [], shown = [];
plaid.attach({ say: (c, text) => said.push({ c, text }), log: (e) => logged.push(e) });
const bank = async (input) => { const out = await plaid.runPlaidTool("bank", input, { conversationId: C, now: NOW }); shown.push({ input, out }); return out; };
const sql = (q, ...a) => d.rawPrepare(q).all(...a);
const one = (q, ...a) => Number(Object.values(sql(q, ...a)[0] ?? { n: 0 })[0] ?? 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const usd = (s) => Number(String(s ?? "").replace(/[$,+]/g, ""));
const near = (a, b) => Math.abs(a - b) < 0.005;
const round2 = (n) => Math.round(n * 100) / 100;

const R = { ran_at: new Date(NOW).toISOString(), today: TODAY, plaid_host: "sandbox.plaid.com", sdk: "plaid " + JSON.parse(readFileSync(new URL("../node_modules/plaid/package.json", import.meta.url), "utf8")).version, steps: {} };
const flush = () => {
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(scrub(R), null, 2));
  writeFileSync(path.join(outDir, "calls.jsonl"), calls.map(c => JSON.stringify(c)).join("\n") + "\n");
};
async function step(id, title, fn) {
  const t0 = Date.now();
  const s = { title, pass: false, facts: {} };
  R.steps[id] = s;
  try { s.pass = !!(await fn(s.facts)); }
  catch (e) { s.pass = false; s.error = scrubString(String(e?.stack ?? e?.message ?? e)).split("\n").slice(0, 4).join(" | ").slice(0, 600); }
  s.seconds = round2((Date.now() - t0) / 1000);
  flush();
  console.log(`${s.pass ? "PASS" : "FAIL"} ${id} ${title} (${s.seconds}s)${s.error ? " :: " + s.error.slice(0, 200) : ""}${s.facts.line ? " :: " + s.facts.line : ""}`);
  return s;
}
const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o).sort() : []);

// ---------------------------------------------------------------- Plaid's truth, worked out apart from the integration
const NOT_SPENT = new Set(["INCOME", "TRANSFER_IN", "TRANSFER_OUT", "LOAN_DISBURSEMENTS"]);
const liveLedger = () => [...ledgers.entries()].filter(([tok]) => !gone.has(tok)).flatMap(([, L]) => [...L.values()]);
const gone = new Set();
const injectedMoves = new Set(); // "account|amount" of the transfers and card payments this run put there: never spending
const isInjectedMove = (t) => injectedMoves.has(`${t.account_id}|${Number(t.amount).toFixed(2)}`);
/** The plain rule, applied to what Plaid sent: money out of an account that is not a loan, not a transfer / income / card payment Plaid labelled, not one of this run's own moves. */
function expectSpend(from, to, pred = () => true) {
  const rows = liveLedger().filter(t => t.date >= from && t.date <= to && t.amount > 0 && acctType.get(t.account_id) !== "loan" && !NOT_SPENT.has(t.personal_finance_category?.primary) && t.personal_finance_category?.detailed !== "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" && !isInjectedMove(t) && pred(t));
  return { total: round2(rows.reduce((s, t) => s + t.amount, 0)), count: rows.length };
}
const tokenOfItem = new Map(); // item_id -> access token (memory only; the integration keeps its own copy sealed)
const item = (i) => plaid.itemsOf(C)[i];

/** Connect a bank the way it really happens, minus the person: the tool makes the Hosted Link, Sandbox mints the public token a finished session would carry, and the SESSION_FINISHED event is handed to the integration's webhook handler. */
async function connect({ institution_id, username = null, facts }) {
  const link = await bank({ action: "connect" });
  if (!link.ok) throw new Error(`connect link failed: ${link.error}`);
  const linkToken = rawLast.get("/link/token/create")?.link_token;
  const opts = { transactions: { days_requested: 180 }, ...(username ? { override_username: username, override_password: "any-non-blank" } : {}) };
  const pt = await sb(api => api.sandbox.createPublicToken({ institution_id, initial_products: ["transactions"], options: opts }));
  if (!pt.ok) throw new Error(`sandbox public token: ${pt.code} ${pt.message}`);
  const before = new Set(plaid.itemsOf(C).map(i => i.itemId));
  const t0 = Date.now();
  const fin = await plaid.handleWebhook({ webhook_type: "LINK", webhook_code: "SESSION_FINISHED", status: "success", link_session_id: randomUUID(), link_token: linkToken, public_tokens: [pt.body.public_token], environment: "sandbox" });
  const ex = rawLast.get("/item/public_token/exchange") ?? {};
  if (ex.access_token && ex.item_id) tokenOfItem.set(ex.item_id, ex.access_token);
  const mine = plaid.itemsOf(C).find(i => !before.has(i.itemId));
  Object.assign(facts, { webhook_handler: { handled: fin.handled, ok: fin.ok, outcome: fin.outcome, banks: fin.banks }, connect_seconds: round2((Date.now() - t0) / 1000) });
  if (!mine) throw new Error(`no Item saved: ${JSON.stringify(fin)}`);
  return mine;
}
/** What the SYNC_UPDATES_AVAILABLE webhook would do, asked for by hand every 2 seconds until Plaid says the history is in (and `want` holds). */
async function settle(itemId, { want = () => true, maxMs = 120_000 } = {}) {
  const t0 = Date.now(), timeline = [];
  for (;;) {
    const r = await plaid.handleWebhook({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: itemId, initial_update_complete: true, historical_update_complete: true, environment: "sandbox" });
    timeline.push({ at_s: round2((Date.now() - t0) / 1000), ok: r.ok, added: r.added ?? 0, modified: r.modified ?? 0, removed: r.removed ?? 0, history: r.history ?? r.error ?? "" });
    if ((r.ok && r.history === "HISTORICAL_UPDATE_COMPLETE" && want()) || Date.now() - t0 > maxMs || (!r.ok && r.error)) break;
    await sleep(2000);
  }
  return { seconds: round2((Date.now() - t0) / 1000), polls: timeline.length, timeline: timeline.slice(0, 40), done: timeline.at(-1)?.history === "HISTORICAL_UPDATE_COMPLETE" && want(), stored: storedCount(itemId) };
}
const storedCount = (itemId) => one("SELECT COUNT(*) AS n FROM plaid_transactions WHERE conversation_id = ? AND item_id = ?", C, itemId);
const ledgerHas = (itemId, accountId, amount) => [...(ledgers.get(tokenOfItem.get(itemId))?.values() ?? [])].some(t => t.account_id === accountId && near(t.amount, amount));

let state1 = "";
try {
  // ============================================================ a. Hosted Link
  await step("a", "Hosted Link: a link token with hosted_link, made the way the code makes it", async (f) => {
    const out = await bank({ action: "connect" });
    const call = lastCall("/link/token/create"), real = rawLast.get("/link/token/create") ?? {};
    f.sent = call?.req ?? null;
    f.status = call?.status; f.ms = call?.ms;
    f.response_keys = keysOf(real);
    if (!out.ok) { f.error = out.error; f.plaid_said = { error_type: real.error_type, error_code: real.error_code, error_message: scrubString(String(real.error_message ?? "")) }; }
    else {
      const u = new URL(real.hosted_link_url);
      f.hosted_link_url_shape = `${u.origin}${u.pathname.replace(/[A-Za-z0-9]{12,}/, m => `<${m.length} chars>`)}`;
      f.expiration = real.expiration;
      f.expires_in_minutes = round2((Date.parse(real.expiration) - Date.now()) / 60000);
      f.tool_said_minutes = out.minutes;
      // Is the page really there? One plain GET, no sign-in, nothing sent.
      try { const page = await realFetch(real.hosted_link_url, { redirect: "follow" }); const html = await page.text(); f.page = { status: page.status, final_host: new URL(page.url).host, title: (/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "").slice(0, 80), bytes: html.length }; } catch (e) { f.page = { error: String(e?.message ?? e).slice(0, 120) }; }
      state1 = sql("SELECT id FROM plaid_links WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1", C)[0]?.id ?? "";
      // The done page's fallback on a link nobody has opened yet: /link/token/get, read by the integration.
      const fin = await plaid.finishLink({ state: state1 });
      const got = rawLast.get("/link/token/get") ?? {};
      f.unopened_link = { integration_says: fin, link_token_get_keys: keysOf(got), link_sessions: Array.isArray(got.link_sessions) ? got.link_sessions.length : null, metadata_keys: keysOf(got.metadata), page_outcome: plaid.linkOutcome(state1) };
    }
    // What else Plaid accepts or refuses, asked directly (scaffolding): each is one more link token nobody opens.
    const base = { client_name: "Reason", language: "en", country_codes: ["US"], user: { client_user_id: plaid.clientUserId(C) }, products: ["transactions"], transactions: { days_requested: 180 } };
    const probe = async (hosted_link, extra = {}) => { const r = await sb(api => api.link.createToken({ ...base, ...extra, hosted_link })); return r.ok ? { accepted: true, expires_in_minutes: round2((Date.parse(r.body.expiration) - Date.now()) / 60000), has_hosted_link_url: !!r.body.hosted_link_url } : { accepted: false, code: r.code, type: r.type, message: r.message }; };
    f.probes = {
      empty_hosted_link_object: await probe({}),
      redirect_to_a_host_never_registered: await probe({ completion_redirect_uri: "https://never-registered.example/bank/done?s=abc", url_lifetime_seconds: 1800, is_mobile_app: false }),
      redirect_to_loopback_http: await probe({ completion_redirect_uri: "http://127.0.0.1:8787/bank/done?s=abc", url_lifetime_seconds: 1800, is_mobile_app: false }),
      lifetime_one_day: await probe({ url_lifetime_seconds: 86400 }),
      no_webhook_url: await probe({ completion_redirect_uri: "https://never-registered.example/bank/done", url_lifetime_seconds: 1800 }),
      with_webhook_url: await probe({ url_lifetime_seconds: 1800 }, { webhook: "https://never-registered.example/plaid/webhook" }),
    };
    f.line = out.ok ? `url ${f.hosted_link_url_shape}, expires in ${f.expires_in_minutes} min, page ${f.page?.status ?? f.page?.error}` : `refused: ${f.error}`;
    return out.ok && !!real.hosted_link_url && f.unopened_link?.integration_says?.pending === true;
  });

  // ============================================================ b. connect without a person
  let item1 = null;
  await step("b", "Connect with no person: Sandbox public token, exchange, first sync, fresh balance, recurring", async (f) => {
    const it = await connect({ institution_id: "ins_109508", facts: f });
    item1 = it.itemId;
    f.institution_saved = it.institution;
    const acc = rawLast.get("/accounts/get") ?? {};
    f.accounts_get = { keys: keysOf(acc), item_keys: keysOf(acc.item), institution_name_present: typeof acc.item?.institution_name === "string" && !!acc.item.institution_name, account_keys: keysOf(acc.accounts?.[0]), accounts: (acc.accounts ?? []).length };
    const first = callsTo("/transactions/sync").find(c => c.by === "integration");
    f.first_sync = { status: first?.status, keys: keysOf(first?.res), added: first?.res?.added?.length ?? 0, transactions_update_status: first?.res?.transactions_update_status, next_cursor_empty: first?.res?.next_cursor === "", has_more: first?.res?.has_more, stored_right_after: storedCount(item1) };
    // What Plaid's recurring list says when asked this early (asked directly: the integration does not ask yet).
    const early = await sb(api => api.transactions.getRecurring({ access_token: tokenOfItem.get(item1) }));
    f.recurring_asked_at_once = early.ok ? { status: 200, outflow_streams: early.body.outflow_streams?.length ?? 0, inflow_streams: early.body.inflow_streams?.length ?? 0 } : { code: early.code, type: early.type };
    // The person asks at once, and keeps asking. No webhook is delivered to anything: each question syncs first.
    const tq = Date.now(), asked = [];
    for (;;) {
      const r = await bank({ action: "spending", period: "last_30_days" });
      asked.push({ at_s: round2((Date.now() - tq) / 1000), ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.ok ? { total: r.total, count: r.count } : {}), ...(r.still_loading ? { still_loading: r.still_loading } : {}), ...(r.history_still_arriving ? { history_still_arriving: r.history_still_arriving } : {}), has_a_number: "total" in r });
      if ((r.ok && !r.still_loading) || Date.now() - tq > 90_000) break;
      await sleep(1500);
    }
    f.asked_with_no_webhook = { questions: asked.length, answered_after_seconds: asked.at(-1).at_s, timeline: asked.slice(0, 40), never_gave_a_number_before_the_data: asked.every(a => (a.ok ? a.count > 0 : !a.has_a_number)), first: asked[0], last: asked.at(-1) };
    f.stored_after_questions = storedCount(item1);
    f.settle = await settle(item1);
    f.stored_after_settle = storedCount(item1);
    f.sync_calls = callsTo("/transactions/sync").map(c => ({ status: c.status, ms: c.ms, added: c.res?.added?.length ?? null, has_more: c.res?.has_more ?? null, update_status: c.res?.transactions_update_status ?? c.res?.error_code, cursor_sent: !!c.req?.cursor, next_cursor_empty: c.res?.next_cursor === "" }));
    f.said = said.map(s => s.text.slice(0, 60));
    // Fresh balance.
    const t1 = Date.now();
    const bal = await bank({ action: "balance" });
    const rawBal = rawLast.get("/accounts/balance/get") ?? {};
    const rawChecking = (rawBal.accounts ?? []).find(a => a.subtype === "checking");
    f.balance = { ok: bal.ok, seconds: round2((Date.now() - t1) / 1000), accounts: bal.accounts?.length ?? 0, sample: bal.accounts?.slice(0, 4), fresh: bal.fresh, keys: keysOf(rawBal), balances_keys: keysOf(rawChecking?.balances),
      checking_matches_plaid: !!rawChecking && (bal.accounts ?? []).some(a => / Checking ••\d{4}$/.test(a.account) && near(usd(a.available), rawChecking.balances.available)) };
    // Recurring: what really happens on this account.
    const subs = await bank({ action: "subscriptions" });
    const rc = lastCall("/transactions/recurring/get"), rawRec = rawLast.get("/transactions/recurring/get") ?? {};
    f.recurring = { status: rc?.status, source: subs.source, count: subs.count, per_month: subs.per_month, keys: keysOf(rawRec),
      ...(rc?.status === 200 ? { outflow_streams: rawRec.outflow_streams?.length ?? 0, inflow_streams: rawRec.inflow_streams?.length ?? 0, stream_keys: keysOf(rawRec.outflow_streams?.[0]), frequencies: [...new Set((rawRec.outflow_streams ?? []).map(s => s.frequency))], statuses: [...new Set((rawRec.outflow_streams ?? []).map(s => s.status))] }
        : { error_type: rawRec.error_type, error_code: rawRec.error_code, error_message: scrubString(String(rawRec.error_message ?? "")).slice(0, 200) }),
      fallback_logged: logged.filter(l => l.plaid_recurring_fallback).map(l => l.plaid_recurring_fallback), list: subs.subscriptions?.slice(0, 12) };
    f.line = `${f.institution_saved}: ${f.accounts_get.accounts} accounts, first sync ${f.first_sync.added} tx (${f.first_sync.transactions_update_status}); asked at once: ${asked[0].error ?? asked[0].total}, answered ${asked.at(-1).total} after ${asked.at(-1).at_s}s and ${asked.length} questions, no webhook; history in ${f.settle.seconds}s, ${f.stored_after_settle} stored; balance ${f.balance.seconds}s; recurring ${f.recurring.status} ${f.recurring.error_code ?? `${f.recurring.outflow_streams} out`} (${f.recurring.source})`;
    return f.webhook_handler.ok === true && !!f.institution_saved && f.institution_saved !== "your bank" && f.first_sync.transactions_update_status === "NOT_READY" && f.asked_with_no_webhook.never_gave_a_number_before_the_data && asked.at(-1).ok === true && asked.at(-1).count > 0 && f.settle.done && f.stored_after_settle > 0 && bal.ok === true && f.balance.checking_matches_plaid && subs.ok === true;
  });

  // ============================================================ c. a second bank, with a card
  let item2 = null, A = {};
  await step("c", "Two banks together: combined totals, own transfer not spending, card payment not twice, accounts by name and last four", async (f) => {
    const it = await connect({ institution_id: "ins_109511", username: "user_transactions_dynamic", facts: f });
    item2 = it.itemId;
    f.settle = await settle(item2);
    f.banks = plaid.itemsOf(C).map(i => i.institution);
    const accts = plaid.accountsOf(C);
    const pick = (itemId, type, subtype) => accts.find(a => a.item_id === itemId && a.type === type && (!subtype || a.subtype === subtype));
    A = { checking1: pick(item1, "depository", "checking"), savings1: pick(item1, "depository", "savings"), card1: pick(item1, "credit"), checking2: pick(item2, "depository", "checking"), card2: pick(item2, "credit") };
    f.accounts = Object.fromEntries(Object.entries(A).map(([k, a]) => [k, a ? plaid.accountLabel(a, plaid.itemsOf(C).find(i => i.itemId === a.item_id)?.institution ?? "") : null]));
    f.item2_account_kinds = accts.filter(a => a.item_id === item2).map(a => `${a.type}/${a.subtype}`);
    const card = A.card2 ?? A.card1;
    if (!A.checking1 || !A.savings1 || !A.checking2 || !card) throw new Error(`accounts missing: ${JSON.stringify(f.accounts)}`);
    const month = () => bank({ action: "spending", period: "last_30_days" });
    const s0 = await month();
    // Put real transactions at the test banks (the person spending and moving money): Sandbox's /sandbox/transactions/create.
    const add = async (itemId, rows) => { const r = await sb(api => api.sandbox.createTransactions({ access_token: tokenOfItem.get(itemId), transactions: rows.map(([account, amount, description]) => ({ account_id: account.account_id, amount, description, date_transacted: TODAY, date_posted: TODAY, iso_currency_code: "USD" })) })); if (!r.ok) throw new Error(`sandbox transactions create: ${r.code} ${r.message}`); return r.body; };
    // 1) a control purchase on the card: the total must move by exactly this.
    const BUY = 12.34;
    f.create_response_keys = keysOf(await add(card.item_id, [[card, BUY, "SWEETGREEN NEW YORK NY"]]));
    f.settle_purchase = await settle(card.item_id, { want: () => ledgerHas(card.item_id, card.account_id, BUY) });
    const s1 = await month();
    // 2) the moves: checking -> savings at the same bank, checking -> checking across banks, checking -> card.
    const T1 = 317.41, T2 = 141.59, PAY = 251.07;
    const cardIsAt = card.item_id;
    const perItem = new Map();
    const push = (acct, amt, desc) => { if (!perItem.has(acct.item_id)) perItem.set(acct.item_id, []); perItem.get(acct.item_id).push([acct, amt, desc]); injectedMoves.add(`${acct.account_id}|${amt.toFixed(2)}`); };
    push(A.checking1, T1, "Online Transfer to Savings xxxx1111"); push(A.savings1, -T1, "Online Transfer from Checking xxxx0000");
    push(A.checking1, T2, "External Transfer to Tartan Bank Checking"); push(A.checking2, -T2, "External Transfer from First Platypus Bank Checking");
    push(A.checking1, PAY, "TARTAN BANK CREDIT CARD AUTOPAY PAYMENT"); push(card, -PAY, "PAYMENT THANK YOU - WEB");
    for (const [itemId, rows] of perItem) await add(itemId, rows);
    f.settle_moves = {};
    for (const [itemId, rows] of perItem) f.settle_moves[itemId === item1 ? "bank1" : "bank2"] = await settle(itemId, { want: () => rows.every(([a, amt]) => ledgerHas(itemId, a.account_id, amt)) });
    const s2 = await month();
    // How Plaid really labelled what was put there.
    const lab = (acct, amt) => { const t = [...(ledgers.get(tokenOfItem.get(acct.item_id))?.values() ?? [])].find(x => x.account_id === acct.account_id && near(x.amount, amt)); return t ? { name: t.name, merchant_name: t.merchant_name ?? null, primary: t.personal_finance_category?.primary, detailed: t.personal_finance_category?.detailed, confidence: t.personal_finance_category?.confidence_level, pending: t.pending, date: t.date } : null; };
    f.plaid_labelled = { purchase_on_card: lab(card, BUY), transfer_out_checking: lab(A.checking1, T1), transfer_in_savings: lab(A.savings1, -T1), cross_bank_out: lab(A.checking1, T2), cross_bank_in: lab(A.checking2, -T2), card_payment_from_checking: lab(A.checking1, PAY), card_payment_on_card: lab(card, -PAY) };
    f.totals = { before: s0.total, after_purchase: s1.total, after_moves: s2.total, purchase: BUY, moved: round2(T1 + T2 + PAY) };
    f.purchase_counted_once = near(usd(s1.total) - usd(s0.total), BUY);
    f.moves_not_counted = near(usd(s2.total), usd(s1.total));
    f.not_counted_note = s2.not_counted ?? null;
    // Combined: the integration's total against Plaid's own rows for BOTH banks, added up apart from it.
    const from = addDays(TODAY, -29);
    const want = expectSpend(from, TODAY);
    f.combined = { integration_total: s2.total, integration_count: s2.count, plaid_rows_total: want.total, plaid_rows_count: want.count, match: near(usd(s2.total), want.total), by_account: s2.by_account ?? null,
      per_bank_from_plaid_rows: Object.fromEntries([[item1, "bank1"], [item2, "bank2"]].map(([id, name]) => { const ids = new Set(accts.filter(a => a.item_id === id).map(a => a.account_id)); return [name, expectSpend(from, TODAY, t => ids.has(t.account_id)).total]; })) };
    f.both_banks_in_answer = (s2.by_account ?? []).some(x => x.account.startsWith(f.banks[0])) && (s2.by_account ?? []).some(x => x.account.startsWith(f.banks[1]));
    // Loan accounts: Plaid sends their own lines (interest charged, payments arriving). None of it is spending.
    const loanIds = new Set(accts.filter(a => a.type === "loan").map(a => a.account_id));
    const loanLabels = accts.filter(a => a.type === "loan").map(a => plaid.accountLabel(a, plaid.itemsOf(C).find(i => i.itemId === a.item_id)?.institution ?? ""));
    const loanOut = liveLedger().filter(t => loanIds.has(t.account_id) && t.amount > 0 && t.date >= from && t.date <= TODAY);
    f.loan_accounts = { accounts: loanLabels.length, money_out_lines_in_30_days: loanOut.length, their_sum: round2(loanOut.reduce((a, t) => a + t.amount, 0)), what_plaid_calls_them: [...new Set(loanOut.map(t => `${t.name} / ${t.personal_finance_category?.detailed}`))].slice(0, 4), counted_as_spending: (s2.by_account ?? []).filter(x => loanLabels.includes(x.account)) };
    // Names: where Plaid had no merchant, the bank's own line had long runs of digits. None is kept.
    const keptNames = d.db.prepare("SELECT data FROM plaid_transactions WHERE conversation_id = ?").all(C).map(r => { try { return JSON.parse(r.data).name; } catch { return ""; } });
    f.names = { plaid_lines_with_5_or_more_digits_in_a_row: liveLedger().filter(t => !t.merchant_name && /\d{5,}/.test(t.name ?? "")).length, kept_names_with_5_or_more_digits_in_a_row: keptNames.filter(n => /\d{5,}/.test(n)).length, kept: keptNames.length, examples_kept: [...new Set(keptNames.filter(n => /PURCHASE|WITHDRAWAL|CARD/i.test(n)))].slice(0, 3) };
    // Names: bank, the account's name, the last four. Nothing longer, no id.
    const st = await bank({ action: "status" });
    const labels = st.banks.flatMap(b => b.accounts);
    const tx = await bank({ action: "transactions", period: "today" });
    f.status = st.banks.map(b => ({ bank: b.bank, status: b.status, accounts: b.accounts }));
    f.labels_all_name_and_last_four = labels.length > 0 && labels.every(l => /^[A-Za-z0-9 &'().-]+ ••\d{4}$/.test(l) && !/\d{5,}/.test(l));
    f.todays_transactions = tx.transactions?.slice(0, 8);
    f.transaction_accounts_named = (tx.transactions ?? []).length > 0 && (tx.transactions ?? []).every(t => /••\d{4}$/.test(t.account ?? ""));
    f.line = `${f.banks.join(" + ")}: total ${s0.total} -> +purchase ${s1.total} -> +moves ${s2.total}; matches Plaid rows: ${f.combined.match} (${want.total}); labels ok: ${f.labels_all_name_and_last_four}; loan lines left out: ${f.loan_accounts.money_out_lines_in_30_days} ($${f.loan_accounts.their_sum}); long numbers in names: ${f.names.plaid_lines_with_5_or_more_digits_in_a_row} sent, ${f.names.kept_names_with_5_or_more_digits_in_a_row} kept`;
    return f.purchase_counted_once && f.moves_not_counted && f.combined.match && f.both_banks_in_answer && f.labels_all_name_and_last_four && f.transaction_accounts_named && f.loan_accounts.money_out_lines_in_30_days > 0 && f.loan_accounts.counted_as_spending.length === 0 && f.names.plaid_lines_with_5_or_more_digits_in_a_row > 0 && f.names.kept_names_with_5_or_more_digits_in_a_row === 0;
  });

  // ============================================================ d. the questions
  await step("d", "The questions a person asks, answered from the real data", async (f) => {
    const dow = (new Date(`${TODAY}T12:00:00Z`).getUTCDay() + 6) % 7;
    const weekFrom = addDays(TODAY, -dow), monthFrom = `${TODAY.slice(0, 8)}01`;
    const wk = await bank({ action: "spending", period: "this_week" });
    const wantWk = expectSpend(weekFrom, TODAY);
    f.this_week = { asked: "how much did i spend this week", from: wk.from, to: wk.to, total: wk.total, count: wk.count, by_category: wk.by_category, top_merchants: wk.top_merchants, plaid_rows_total: wantWk.total, match: wk.ok && near(usd(wk.total), wantWk.total) && wk.from === weekFrom };
    const food = await bank({ action: "spending", period: "this_month", category: "food" });
    const wantFood = expectSpend(monthFrom, TODAY, t => t.personal_finance_category?.primary === "FOOD_AND_DRINK" || /food/i.test(`${t.personal_finance_category?.detailed ?? ""} ${t.merchant_name || t.name || ""}`.replace(/_/g, " ")));
    f.food_this_month = { asked: "how much on food this month", from: food.from, to: food.to, total: food.total, count: food.count, top_merchants: food.top_merchants, plaid_rows_total: wantFood.total, match: food.ok && near(usd(food.total), wantFood.total) && food.count > 0 };
    const subs = await bank({ action: "subscriptions" });
    const monthlySum = round2((subs.subscriptions ?? []).filter(x => x.every === "monthly").reduce((a, x) => a + usd(x.amount), 0));
    f.subscriptions = { asked: "what are my subscriptions", ok: subs.ok, source: subs.source, count: subs.count, per_month: subs.per_month, all_monthly: (subs.subscriptions ?? []).every(x => x.every === "monthly"), listed_amounts_add_up_to: monthlySum, per_month_is_their_sum: (subs.subscriptions ?? []).every(x => x.every === "monthly") ? near(usd(subs.per_month), monthlySum) : null, list: subs.subscriptions?.slice(0, 15), yearly_named: (subs.subscriptions ?? []).filter(s => /annual|year/i.test(s.every)).length, say: subs.say };
    // A pay step that is too large, and one that is not: the balance is fetched fresh each time.
    const before = callsTo("/accounts/balance/get").length;
    const big = await plaid.balanceCheck(C, 9_999_999);
    const small = await plaid.balanceCheck(C, 1);
    f.pay_step = { too_large: big, small, fresh_balance_calls: callsTo("/accounts/balance/get").length - before, banks: plaid.itemsOf(C).length };
    // Older than the 60 days kept.
    const oldFrom = addDays(TODAY, -120), oldTo = addDays(TODAY, -91);
    const old = await bank({ action: "spending", from: oldFrom, to: oldTo });
    const partly = await bank({ action: "spending", from: addDays(TODAY, -100), to: TODAY });
    f.older_than_60_days = { asked: `spending ${oldFrom}..${oldTo}`, answer: { ok: old.ok, error: old.error, has_total: "total" in old }, partly_older: { from: partly.from, only_last_60_days: partly.only_last_60_days === true, cutoff: plaid.cutoffDay(NOW) } };
    f.line = `week ${wk.total} (Plaid rows ${wantWk.total}); food ${food.total} (${wantFood.total}); subs ${subs.count} via ${subs.source}; too-large short=${big.short} of ${big.available ?? "?"}; old period -> ${old.error}`;
    return f.this_week.match && f.food_this_month.match && subs.ok === true && f.subscriptions.per_month_is_their_sum !== false && big.checked === true && big.short === true && small.checked === true && small.short === false && f.pay_step.fresh_balance_calls === 2 * f.pay_step.banks
      && old.ok === false && old.error === "beyond_60_days" && !("total" in old) && f.older_than_60_days.partly_older.only_last_60_days && partly.from === plaid.cutoffDay(NOW);
  });

  // ============================================================ e. 60 days
  await step("e", "The 60-day rule on real data: nothing older stored, and the purge removes what ages out", async (f) => {
    const cutoff = plaid.cutoffDay();
    const rows = liveLedger();
    const older = rows.filter(t => t.date < cutoff).length, kept = rows.filter(t => t.date >= cutoff).length;
    const stored = one("SELECT COUNT(*) AS n FROM plaid_transactions WHERE conversation_id = ?", C);
    const oldest = sql("SELECT MIN(date) AS m FROM plaid_transactions WHERE conversation_id = ?", C)[0]?.m ?? "";
    const plaidOldest = rows.map(t => t.date).sort()[0] ?? "";
    f.first_sync = { cutoff, plaid_sent: rows.length, plaid_sent_older_than_cutoff: older, plaid_oldest: plaidOldest, stored, stored_oldest: oldest, stored_older_than_cutoff: one("SELECT COUNT(*) AS n FROM plaid_transactions WHERE conversation_id = ? AND date < ?", C, cutoff) };
    const SKIP_DAYS = 25;
    const later = plaid.cutoffDay(clock.now() + SKIP_DAYS * 86400_000);
    const willAge = one("SELECT COUNT(*) AS n FROM plaid_transactions WHERE conversation_id = ? AND date < ?", C, later);
    clock.skip(SKIP_DAYS * 86400_000);
    let deleted = -1;
    try { deleted = plaid.purgeOld(); } finally { clock.skip(-SKIP_DAYS * 86400_000); }
    f.purge = { clock_advanced_days: SKIP_DAYS, new_cutoff: later, aged_out_before: willAge, deleted, left_older_than_new_cutoff: one("SELECT COUNT(*) AS n FROM plaid_transactions WHERE conversation_id = ? AND date < ?", C, later), stored_after: one("SELECT COUNT(*) AS n FROM plaid_transactions WHERE conversation_id = ?", C), stored_oldest_after: sql("SELECT MIN(date) AS m FROM plaid_transactions WHERE conversation_id = ?", C)[0]?.m ?? "" };
    f.line = `Plaid sent ${rows.length} (oldest ${plaidOldest}, ${older} older than ${cutoff}); stored ${stored}, oldest ${oldest}; +${SKIP_DAYS}d purge deleted ${deleted} of ${willAge}`;
    return older > 0 && stored === kept && oldest >= cutoff && f.first_sync.stored_older_than_cutoff === 0 && willAge > 0 && deleted === willAge && f.purge.left_older_than_new_cutoff === 0;
  });

  // ============================================================ f. expired login
  await step("f", "Expired login: /sandbox/item/reset_login, then the integration notices and makes an update-mode link", async (f) => {
    const tok = tokenOfItem.get(item2);
    const name2 = plaid.itemsOf(C).find(i => i.itemId === item2)?.institution;
    const linksBefore = callsTo("/link/token/create").length, saidBefore = said.length;
    const reset = await sb(api => api.sandbox.resetItemLogin({ access_token: tok }));
    f.reset_login = reset.ok ? reset.body : reset;
    const s = await plaid.sync(C, item2);
    const syncCall = lastCall("/transactions/sync");
    f.sync = { integration_says: s, plaid_status: syncCall?.status, error_type: syncCall?.res?.error_type, error_code: syncCall?.res?.error_code, error_keys: keysOf(syncCall?.res) };
    const made = callsTo("/link/token/create").slice(linksBefore).filter(c => c.by === "integration");
    const upd = made[0];
    f.update_link = { made: made.length, status: upd?.status, sent_keys: keysOf(upd?.req), has_access_token: !!upd?.req?.access_token, names_products: "products" in (upd?.req ?? {}), hosted_link_sent: upd?.req?.hosted_link ?? null, response_keys: keysOf(upd?.res), expires_in_minutes: upd?.res?.expiration ? round2((Date.parse(upd.res.expiration) - Date.now()) / 60000) : null, has_hosted_link_url: !!upd?.res?.hosted_link_url,
      ...(upd && upd.status !== 200 ? { error_code: upd.res?.error_code, error_message: upd.res?.error_message } : {}) };
    const texts = said.slice(saidBefore);
    f.texted = { count: texts.length, starts: texts[0]?.text.slice(0, 70) ?? null, ends_with_hosted_link: /\nhttps:\/\/[a-z.]*plaid\.com\/\S+$/.test(texts[0]?.text ?? "") };
    f.item_status = plaid.itemsOf(C).find(i => i.itemId === item2)?.status;
    const bal = await bank({ action: "balance" });
    const balCall = callsTo("/accounts/balance/get").filter(c => c.status !== 200).pop();
    const direct = await sb(api => api.accounts.getBalance({ access_token: tok }));
    f.balance = { ok: bal.ok, accounts: bal.accounts?.length ?? 0, problems: bal.problems, plaid_error_code: balCall?.res?.error_code ?? null, balance_endpoint_asked_directly: direct.ok ? "STILL ANSWERS" : { code: direct.code, type: direct.type } };
    const st = await bank({ action: "status" });
    f.status_says = st.banks?.map(b => `${b.bank}: ${b.status}`);
    f.no_second_text = said.length === saidBefore + 1;
    const again = await bank({ action: "connect", bank: name2 });
    f.reconnect_tool = { ok: again.ok, reconnecting: again.reconnecting, has_url: /^https:\/\//.test(again.url ?? "") };
    const updState = sql("SELECT id FROM plaid_links WHERE conversation_id = ? AND item_id = ? ORDER BY created_at DESC LIMIT 1", C, item2)[0]?.id ?? "";
    const fin = await plaid.finishLink({ state: updState });
    const got = rawLast.get("/link/token/get") ?? {};
    f.unfinished_update_link = { integration_says: fin, link_sessions: got.link_sessions?.length ?? null };
    // Spending still answers from what is stored, and says which bank is behind.
    const sp = await bank({ action: "spending", period: "this_week" });
    f.spending_still_answers = { ok: sp.ok, needs_reconnect: sp.needs_reconnect };
    f.line = `sync -> ${s.error} (Plaid ${f.sync.plaid_status} ${f.sync.error_code}); update link ${f.update_link.status}, access_token sent: ${f.update_link.has_access_token}, products named: ${f.update_link.names_products}, expires ${f.update_link.expires_in_minutes} min; texted ${f.texted.count}`;
    return reset.ok && s.ok === false && s.error === "login_required" && f.sync.error_code === "ITEM_LOGIN_REQUIRED" && f.update_link.made === 1 && f.update_link.status === 200 && f.update_link.has_access_token && !f.update_link.names_products && f.update_link.has_hosted_link_url
      && f.texted.count === 1 && f.texted.ends_with_hosted_link && f.item_status === "login_required" && f.no_second_text && again.ok === true && again.reconnecting === name2 && fin.ok === false && fin.pending === true;
  });

  // ============================================================ g. webhooks
  await step("g", "Webhooks: what /sandbox/item/fire_webhook answers, and the verification path as far as it goes without a delivery", async (f) => {
    const tok = tokenOfItem.get(item1);
    const fire = async (webhook_code, webhook_type) => { const r = await sb(api => api.sandbox.fireItemWebhook({ access_token: tok, webhook_code, ...(webhook_type ? { webhook_type } : {}) })); return r.ok ? r.body : r; };
    f.item_webhook_at_start = (await sb(api => api.item.get({ access_token: tok }))).body?.item?.webhook ?? null;
    f.fired_with_no_webhook_url = await fire("SYNC_UPDATES_AVAILABLE");
    // A URL that resolves nowhere (.invalid, RFC 2606): Plaid has an address on file, and nothing is delivered to anybody.
    const set = await sb(api => api.item.updateWebhook({ access_token: tok, webhook: "https://plaid-sandbox-proof.invalid/plaid/webhook" }));
    f.set_webhook_url = set.ok ? { ok: true, keys: keysOf(set.body) } : set;
    f.fired = { SYNC_UPDATES_AVAILABLE: await fire("SYNC_UPDATES_AVAILABLE"), DEFAULT_UPDATE: await fire("DEFAULT_UPDATE", "TRANSACTIONS"), RECURRING_TRANSACTIONS_UPDATE: await fire("RECURRING_TRANSACTIONS_UPDATE"), LOGIN_REPAIRED: await fire("LOGIN_REPAIRED"), PENDING_DISCONNECT: await fire("PENDING_DISCONNECT") };
    // The verification path, with a signature Plaid did not make: the key is asked for by its id from real Plaid.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const forged = (kid) => { const rawBody = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: item1, environment: "sandbox" }, null, 2); const head = b64({ alg: "ES256", kid, typ: "JWT" }); const claims = b64({ iat: Math.floor(Date.now() / 1000), request_body_sha256: createHash("sha256").update(rawBody).digest("hex") }); const sig = createSign("SHA256").update(`${head}.${claims}`).sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"); return { rawBody, headers: { "plaid-verification": `${head}.${claims}.${sig}` } }; };
    const tryKid = async (kid) => { const before = callsTo("/webhook_verification_key/get").length; const cursorBefore = plaid.itemsOf(C).find(i => i.itemId === item1)?.cursor; const res = await http.plaidWebhookRequest({ ...forged(kid), log: (e) => logged.push(e) }); const call = callsTo("/webhook_verification_key/get").slice(before).pop(); return { http_status: res.status, asked_plaid_for_key: !!call, plaid_status: call?.status ?? null, plaid_error_type: call?.res?.error_type ?? null, plaid_error_code: call?.res?.error_code ?? null, key_keys: keysOf(call?.res?.key), nothing_acted_on: plaid.itemsOf(C).find(i => i.itemId === item1)?.cursor === cursorBefore }; };
    f.forged_signature_unknown_key_id = await tryKid(randomUUID());
    f.forged_signature_docs_example_key_id = await tryKid("bfbd5111-8e33-4643-8ced-b2e642a72f3c");
    f.unsigned = { http_status: (await http.plaidWebhookRequest({ rawBody: "{}", headers: {}, log: (e) => logged.push(e) })).status };
    f.rejections_logged = logged.filter(l => l.plaid_webhook_rejected).map(l => l.plaid_webhook_rejected);
    f.real_delivery = "NOT PROVEN: no webhook was received. Plaid had no reachable address for this machine, so no real Plaid-Verification signature has been checked by this code.";
    f.line = `no url: ${f.fired_with_no_webhook_url.code ?? JSON.stringify(f.fired_with_no_webhook_url)}; with url: ${Object.entries(f.fired).map(([k, v]) => `${k}=${v.webhook_fired ?? v.code}`).join(", ")}; forged -> ${f.forged_signature_unknown_key_id.http_status} (${f.forged_signature_unknown_key_id.plaid_error_code})`;
    return f.forged_signature_unknown_key_id.http_status === 401 && f.forged_signature_unknown_key_id.asked_plaid_for_key && f.forged_signature_unknown_key_id.nothing_acted_on && f.forged_signature_docs_example_key_id.http_status === 401 && f.unsigned.http_status === 401 && f.fired.SYNC_UPDATES_AVAILABLE?.webhook_fired === true;
  });

  // ============================================================ h. disconnect
  await step("h", "Disconnect: one of two, then all; really gone at Plaid, and the token and that bank's rows gone here", async (f) => {
    const [n1, n2] = [item1, item2].map(id => plaid.itemsOf(C).find(i => i.itemId === id)?.institution);
    const tok1 = tokenOfItem.get(item1), tok2 = tokenOfItem.get(item2);
    const ask = await bank({ action: "disconnect" });
    f.none_named = { ok: ask.ok, error: ask.error, connections: ask.connections, items_still: plaid.itemsOf(C).length };
    // By last four when a last four belongs to one bank only; a last four both banks have must ask again.
    const masks = (id) => plaid.accountsOf(C, id).map(a => String(a.mask));
    const shared = masks(item2).find(m => masks(item1).includes(m)), only2 = masks(item2).find(m => !masks(item1).includes(m));
    if (shared) { const amb = await bank({ action: "disconnect", bank: shared }); f.last_four_both_banks_have = { asked_again: amb.ok === false && amb.error === "which_bank", items_still: plaid.itemsOf(C).length }; }
    const rows = (id) => ({ items: one("SELECT COUNT(*) AS n FROM plaid_items WHERE item_id = ?", id), accounts: one("SELECT COUNT(*) AS n FROM plaid_accounts WHERE item_id = ?", id), transactions: one("SELECT COUNT(*) AS n FROM plaid_transactions WHERE item_id = ?", id), links: one("SELECT COUNT(*) AS n FROM plaid_links WHERE item_id = ?", id) });
    const before2 = rows(item2), before1 = rows(item1);
    const removes = callsTo("/item/remove").length;
    const first = await bank({ action: "disconnect", bank: only2 ?? n2 });
    const rm = callsTo("/item/remove").slice(removes).pop();
    if (rm?.status === 200) gone.add(tok2);
    const after = await sb(api => api.accounts.get({ access_token: tok2 }));
    f.one = { named_by: only2 ? "last four" : "bank name", ok: first.ok, removed: first.removed, plaid_removal_pending: first.plaid_removal_pending ?? null, item_remove_status: rm?.status, item_remove_keys: keysOf(rm?.res), a_later_call_with_that_token: after.ok ? "STILL WORKS" : { code: after.code, type: after.type }, rows_before: before2, rows_after: rows(item2), other_bank_rows_before: before1, other_bank_rows_after: rows(item1), still_connected: plaid.itemsOf(C).map(i => i.institution) };
    const all = await bank({ action: "disconnect", all: true });
    const rm1 = callsTo("/item/remove").pop();
    if (rm1?.status === 200) gone.add(tok1);
    const after1 = await sb(api => api.accounts.get({ access_token: tok1 }));
    const left = Object.fromEntries(["plaid_items", "plaid_accounts", "plaid_transactions", "plaid_links", "plaid_pay_checks"].map(t => [t, one(`SELECT COUNT(*) AS n FROM ${t} WHERE conversation_id = ?`, C)]));
    f.all = { ok: all.ok, removed: all.removed, item_remove_status: rm1?.status, a_later_call_with_that_token: after1.ok ? "STILL WORKS" : { code: after1.code, type: after1.type }, rows_left_for_this_person: left };
    const nothing = await bank({ action: "spending", period: "this_week" });
    f.asked_after = { ok: nothing.ok, error: nothing.error };
    f.line = `one (${f.one.named_by}): remove ${f.one.item_remove_status}, later call -> ${after.code ?? "works"}, rows ${JSON.stringify(f.one.rows_after)}; all: remove ${f.all.item_remove_status}, later -> ${after1.code ?? "works"}, left ${Object.values(left).reduce((a, b) => a + b, 0)}`;
    const zero = (r) => Object.values(r).every(n => n === 0);
    return ask.ok === false && ask.error === "which_bank" && f.none_named.items_still === 2 && (!shared || f.last_four_both_banks_have.asked_again) && first.ok === true && rm?.status === 200 && !after.ok && ["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"].includes(after.code) && zero(f.one.rows_after) && before2.transactions > 0 && f.one.other_bank_rows_after.items === 1 && f.one.other_bank_rows_after.accounts === before1.accounts
      && all.ok === true && rm1?.status === 200 && !after1.ok && zero(left) && nothing.error === "no_bank_connected";
  });

  // ============================================================ nothing it should not have shown
  await step("leaks", "Nothing a person, the model or a log was given holds a token, an id, or more than four digits of an account", async (f) => {
    const everything = JSON.stringify([shown, said, logged]);
    const forbidden = [...ph.keys()].filter(real => !["hosted_link_url", "state", "client_user_id", "request_id", "key_id"].includes(kindOf.get(real)) && real.length >= 8);
    const hits = forbidden.filter(real => everything.includes(real));
    f.checked_identifiers = forbidden.length; f.tool_answers = shown.length; f.texts = said.length; f.log_lines = logged.length;
    f.leaked_kinds = [...new Set(hits.map(h => kindOf.get(h)))];
    f.keys_leaked = everything.includes(CLIENT_ID) || everything.includes(SECRET);
    f.log_kinds = [...new Set(logged.flatMap(l => Object.keys(l)))];
    f.line = `${forbidden.length} real identifiers checked against ${shown.length} answers, ${said.length} texts, ${logged.length} log lines: ${hits.length} found`;
    return hits.length === 0 && !f.keys_leaked;
  });
} finally {
  // Every Item this run made is let go of at Plaid, whatever happened above.
  let cleaned = 0;
  for (const tok of tokenOfItem.values()) { if (gone.has(tok)) continue; const r = await sb(api => api.item.remove({ access_token: tok })); if (r.ok) cleaned++; }
  R.cleanup = { items_removed_at_exit: cleaned };
  R.calls = { total: calls.length, by_path: Object.fromEntries([...new Set(calls.map(c => c.path))].sort().map(p => [p, callsTo(p).length])), non_sandbox_hosts: 0 };
  flush();
  // The record itself must hold no real identifier.
  const written = readFileSync(path.join(outDir, "report.json"), "utf8") + readFileSync(path.join(outDir, "calls.jsonl"), "utf8");
  const real = [...ph.keys()].filter(k => k.length >= 8 && written.includes(k));
  if (real.length || written.includes(CLIENT_ID) || written.includes(SECRET)) {
    // Where (the path, never the value), so the scrubber can be taught; then the record goes.
    const where = new Set();
    const walk = (v, at) => { if (typeof v === "string") { if (real.some(k => v.includes(k))) where.add(at.replace(/\d+/g, "#")); } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`); };
    walk(scrub(R), "report"); for (const c of calls) walk(c, `call${c.path}`);
    rmSync(path.join(outDir, "report.json"), { force: true }); rmSync(path.join(outDir, "calls.jsonl"), { force: true });
    console.error(`RECORD WITHDRAWN: ${real.length} real identifiers were still in it (${[...new Set(real.map(k => kindOf.get(k)))].join(", ")}) at ${[...where].slice(0, 12).join(" ; ")}`); process.exitCode = 1;
  }
  else if (opt("--save")) saveFixtures(opt("--save"));
  rmSync(dir, { recursive: true, force: true });
  const passed = Object.values(R.steps).filter(s => s.pass).length, total = Object.keys(R.steps).length;
  console.log(`${passed}/${total} steps passed; ${calls.length} Plaid calls, all to sandbox.plaid.com; record in ${outDir}`);
  if (passed !== total) process.exitCode = 1;
  setTimeout(() => process.exit(process.exitCode ?? 0), 200); // src/http.js keeps timers; the run is over
}

/** One trimmed, placeholder-only response per endpoint and outcome. */
function saveFixtures(to) {
  mkdirSync(to, { recursive: true });
  const seen = new Map();
  const variety = (list, n, key) => { const out = [], had = new Set(); for (const x of list) { const k = key(x); if (!had.has(k)) { had.add(k); out.push(x); } if (out.length >= n) break; } return out; };
  for (const c of calls) {
    const outcome = c.status === 200 ? (c.path === "/link/token/create" ? (c.req.access_token ? "update-mode" : "new") : c.path === "/transactions/sync" ? (c.res.added?.length ? "page" : "nothing-yet") : "ok") : String(c.res?.error_code ?? c.status).toLowerCase();
    const name = `${c.path.replace(/^\//, "").replace(/\//g, "-")}.${outcome}.json`;
    const better = c.path === "/transactions/sync" && c.status === 200 && (c.res.added?.length ?? 0) > (seen.get(name)?.res.added?.length ?? -1);
    if (!seen.has(name) || better) seen.set(name, c);
  }
  for (const [name, c] of seen) {
    const res = structuredClone(c.res);
    for (const k of ["added", "modified"]) if (Array.isArray(res[k]) && res[k].length > 8) { res[`_${k}_total`] = res[k].length; res[k] = variety(res[k], 8, t => `${t.account_id}|${t.personal_finance_category?.primary}|${t.pending}`); }
    for (const k of ["outflow_streams", "inflow_streams"]) if (Array.isArray(res[k]) && res[k].length > 5) { res[`_${k}_total`] = res[k].length; res[k] = variety(res[k], 5, s => `${s.frequency}|${s.status}`); }
    writeFileSync(path.join(to, name), JSON.stringify({ _from: `Plaid Sandbox, ${R.ran_at.slice(0, 10)}, ${R.sdk}; identifiers replaced by placeholders`, path: c.path, status: c.status, request: c.req, response: res }, null, 2) + "\n");
  }
  console.log(`${seen.size} response shapes saved to ${to}`);
}
