#!/usr/bin/env node
// A fresh Plaid SANDBOX Hosted Link, on demand, for a person to open in their own browser and connect
// Plaid's test bank themselves. Made by the integration's own code (src/plaid.js createLink), against
// sandbox.plaid.com only, for a made-up person, in a scratch database of its own (data/plaid-sandbox/,
// not the real one). No real bank, no real money, no text to anybody.
//
//   node scripts/plaid-sandbox-link.mjs [--env-file PATH]
//       prints two lines and nothing else: the link, and when it expires (30 minutes).
//   node scripts/plaid-sandbox-link.mjs --serve [--env-file PATH]
//       the same two lines, then stays up on this Mac only (127.0.0.1) so that Plaid's last step lands
//       on Reason's real "You're connected" page; it exits when they finish or the link expires.
//   node scripts/plaid-sandbox-link.mjs --check [--env-file PATH]
//       was the last link finished? If so it is connected through the integration (exchange, accounts,
//       sync, a fresh balance) and a few plain lines say what came in. Works for six hours after they
//       finish (that is how long Plaid keeps the session), whichever device they used.
//   node scripts/plaid-sandbox-link.mjs --disconnect [--env-file PATH]
//       lets go of the test bank at Plaid and deletes the scratch database.
//
// What to do on Plaid's page: pick "First Platypus Bank" (a Sandbox test bank that signs in with a
// username and password; do not pick "Platypus OAuth Bank"), username user_good, password pass_good.
// If it asks for a code: 1234. For a busier account with a credit card, six months of history and
// subscriptions, use username user_transactions_dynamic with any password at the same bank.
//
// Keys: PLAID_CLIENT_ID and PLAID_SECRET_SANDBOX from the environment, or just those two lines read out
// of --env-file. Never printed, never written anywhere. The scratch database's own encryption keys
// are derived from the Sandbox secret, so nothing new is kept on disk in the clear.
//
// Without --serve nothing is listening when Plaid sends the browser to its last stop
// (http://127.0.0.1:8799/bank/done), so the browser says it cannot connect. That is expected: the
// connection is already made at Plaid by then, and --check picks it up.
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : null; };
const has = (name) => args.includes(name);
function linesOf(file, names) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && names.includes(m[1])) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
const fromFile = opt("--env-file") ? linesOf(opt("--env-file"), ["PLAID_CLIENT_ID", "PLAID_SECRET_SANDBOX"]) : {};
const CLIENT_ID = String(process.env.PLAID_CLIENT_ID || fromFile.PLAID_CLIENT_ID || "").trim();
const SECRET = String(process.env.PLAID_SECRET_SANDBOX || fromFile.PLAID_SECRET_SANDBOX || "").trim();
if (!CLIENT_ID || !SECRET) { console.error("PLAID_CLIENT_ID and PLAID_SECRET_SANDBOX are needed (environment, or --env-file PATH)."); process.exit(2); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "data", "plaid-sandbox");
const PORT = 8799;
const derived = (label) => createHash("sha256").update(`reason-plaid-sandbox-link:${label}:${SECRET}`).digest("hex");
// Only this script's own settings reach the code: no production secret, no public address, no other feature's keys.
for (const k of Object.keys(process.env)) if (/^(PLAID_|REASON_|ANTHROPIC_)/.test(k)) delete process.env[k];
mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  REASON_DB_PATH: path.join(dir, "reason.db"), REASON_DATA_DIR: dir, REASON_TZ: "America/New_York", REASON_OWNER_NAME: "Sandbox", REASON_CONVERSATION: "dm:owner",
  REASON_ENCRYPT_REST: "on", REASON_ENCRYPT_REST2: "on", REASON_ENCRYPT_STRICT: "1", REASON_REST_KEK_SOURCE: "local", REASON_REST_KEK: derived("kek"), REASON_TOKEN_KEY: derived("token"),
  REASON_PLAID: "on", PLAID_CLIENT_ID: CLIENT_ID, PLAID_SECRET_SANDBOX: SECRET, REASON_PORT: String(PORT),
});

const d = await import("../src/db.js");
const plaid = await import("../src/plaid.js");
const { clock } = await import("../src/config.js");
if (plaid.plaidEnv() !== "sandbox" || !plaid.configured()) { console.error("not Sandbox, or not configured: stopping."); process.exit(2); }
const realFetch = globalThis.fetch;
plaid._setFetch(async (input, init) => {
  const host = new URL(typeof input === "string" ? input : input.url).host;
  if (host !== "sandbox.plaid.com") throw new Error(`refused: ${host} is not Plaid's Sandbox`);
  return realFetch(input, init);
});
plaid.attach({ say: () => {}, log: () => {} }); // nobody is texted

const C = "dm:plaid-sandbox-helper";
const bank = (input) => plaid.runPlaidTool("bank", input, { conversationId: C });
const when = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
const newest = () => d.rawPrepare("SELECT id, expires_at, finished_at, outcome FROM plaid_links WHERE conversation_id = ? AND item_id = '' ORDER BY created_at DESC LIMIT 1").get(C) ?? null;
const done = (code = 0) => setTimeout(() => process.exit(code), 100);

if (has("--disconnect")) {
  const out = plaid.hasBank(C) ? await bank({ action: "disconnect", all: true }) : { ok: true, removed: [] };
  if (out.plaid_removal_pending?.length) { console.log(`Plaid could not be reached to remove ${out.plaid_removal_pending.join(" and ")}: the scratch data is kept so this can be run again.`); done(1); }
  else { rmSync(dir, { recursive: true, force: true }); console.log(out.removed?.length ? `disconnected ${out.removed.join(" and ")}: removed at Plaid, scratch data deleted` : "nothing was connected; scratch data deleted"); done(); }
} else if (has("--check")) {
  const row = newest();
  if (!row) { console.log("no link has been made yet"); done(); }
  else {
    const fin = row.finished_at ? { outcome: row.outcome } : await plaid.finishLink({ state: row.id });
    if (!plaid.hasBank(C)) console.log(fin.pending ? `not finished yet: the link is still open until ${when(row.expires_at)}` : clock.now() > row.expires_at ? "that link expired with nothing connected: make a fresh one" : `not connected (${fin.outcome ?? fin.error ?? "unknown"})`);
    else {
      const st = await bank({ action: "status" });
      for (const b of st.banks ?? []) console.log(`connected: ${b.bank} (${b.accounts.length} accounts: ${b.accounts.slice(0, 4).join(", ")}${b.accounts.length > 4 ? ", ..." : ""})`);
      const sp = await bank({ action: "spending", period: "last_30_days" });
      console.log(sp.ok ? `transactions are in: spent in the last 30 days ${sp.total} over ${sp.count} charges${sp.history_still_arriving ? " (older weeks still arriving)" : ""}` : sp.error === "still_loading" ? "transactions are still coming in from the bank: run --check again in a few seconds" : `transactions: ${sp.error}`);
      const bal = await bank({ action: "balance" });
      const first = bal.accounts?.[0];
      console.log(first ? `balance fetched fresh: ${first.account} ${first.available ?? first.current}${first.available ? " available" : ""}` : `balance: ${bal.error ?? "none"}`);
      console.log("run with --disconnect when finished, to remove the test bank at Plaid");
    }
    done();
  }
} else {
  // With --serve the page is up before the link is printed: Plaid's last stop, on this Mac only, is
  // Reason's real done page, which finishes the connection.
  let server = null, row = null;
  if (has("--serve")) {
    const { bankDonePage } = await import("../src/http.js");
    server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (req.method !== "GET" || url.pathname !== "/bank/done") { res.writeHead(404); return res.end(); }
      const page = await bankDonePage(url.searchParams.get("s") ?? "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${page.title}</title><body style="font: 17px/1.5 -apple-system, system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1.25rem">${page.body}</body>`);
      if (row && ["connected", "expired", "failed"].includes(plaid.linkOutcome(row.id))) server.close(() => done());
    });
    try { await new Promise((ok, no) => { server.once("error", no); server.listen(PORT, "127.0.0.1", ok); }); }
    catch (e) { console.error(`could not listen on 127.0.0.1:${PORT} (${e.code ?? e.message}); run without --serve, or free the port`); process.exit(1); }
  }
  const link = await plaid.createLink(C);
  if (!link.ok) { console.error(`Plaid would not make the link: ${link.error}`); server?.close(); done(1); }
  else {
    row = newest();
    console.log(link.url);
    console.log(`expires ${when(row.expires_at)} (${link.minutes} minutes)`);
    if (!server) done();
    else setTimeout(() => server.close(() => done()), Math.max(1000, row.expires_at - clock.now() + 60_000));
  }
}
