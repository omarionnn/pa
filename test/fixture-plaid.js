// A fake Plaid for the offline suite: a `fetch` handed to the real `plaid` SDK (v51). No network, no keys.
//
// Its shapes and its behaviour are Plaid's real Sandbox as recorded 2026-11-13 by
// scripts/plaid-sandbox-proof.mjs (test/fixtures/plaid/*.json, identifiers replaced by placeholders;
// test/plaid.test.js holds this file to those recordings key for key). What the real thing did that
// the docs alone had not said, and this file now does too:
//   - the first /transactions/sync after a connection has nothing: NOT_READY, no accounts, an empty cursor;
//   - a token whose Item was removed fails ITEM_NOT_FOUND (a token that never existed: INVALID_ACCESS_TOKEN);
//   - /link/token/get for a link nobody has opened has no `link_sessions` key at all;
//   - an Item error carries `documentation_url` and `suggested_action`.
// Still from the docs only (SHAPES_FROM_DOCS): the SESSION_FINISHED and ITEM webhook bodies, a finished
// link session in /link/token/get, the verification key, and INVALID_PRODUCT for recurring without the add-on.
import { createHash, createSign, generateKeyPairSync } from "node:crypto";

export const SHAPES_FROM = "sandbox 2026-11-13";
export const SHAPES_FROM_DOCS = ["webhook bodies", "/link/token/get link_sessions", "/webhook_verification_key/get key", "/transactions/recurring/get INVALID_PRODUCT"];

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

export function makePlaid({ now = () => Date.now() } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const KID = "bfbd5111-8e33-4643-8ced-b2e642a72f3c";
  const state = {
    calls: [],            // { path, body } for every request, the secret and token included (asserted on, never printed)
    links: new Map(),     // link_token -> { finished, publicTokens, update }
    items: new Map(),     // access_token -> { item_id, institution, accounts, pages, recurring, failWith, removed }
    publicTokens: new Map(),
    n: 0,
    keyExpired: false,
  };
  const err = (error_code, error_type = "ITEM_ERROR", status = 400) => ({ status, body: { display_message: null, ...(error_type === "ITEM_ERROR" ? { documentation_url: `https://plaid.com/docs/errors/item/#${error_code.toLowerCase()}` } : {}), error_code, error_message: `${error_code} (fixture)`, error_type, request_id: "req_fixture", suggested_action: null } });

  /** A bank with one checking account, as /accounts/get documents it. `number` is a full account number that must never surface. */
  function addBank({ institution = "First Platypus Bank", mask = "0000", available = 100, current = 110, number = "1111222233330000", kind = "checking" } = {}) {
    const KIND = { checking: ["Plaid Checking", "depository", "checking"], savings: ["Plaid Saving", "depository", "savings"], credit: ["Plaid Credit Card", "credit", "credit card"], mortgage: ["Plaid Mortgage", "loan", "mortgage"] }[kind];
    const n = ++state.n;
    const access = `access-sandbox-${String(n).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`;
    const item = {
      item_id: `item_${n}_wz666MBjYWTp2PDzzggYhM6oWWmBb`, institution,
      accounts: [{ account_id: `acc_${n}_checking`, apy: null, balances: { available: KIND[1] === "depository" ? available : null, current, iso_currency_code: "USD", limit: kind === "credit" ? 2000 : null, unofficial_currency_code: null }, holder_category: "personal", mask, name: KIND[0], official_name: `Plaid Gold Standard 0% Interest ${number}`, subtype: KIND[2], type: KIND[1] }],
      // notReady: how many syncs answer NOT_READY before anything is served (the real first sync always does).
      // history: the transactions_update_status served after that.
      pages: [], recurring: null, failWith: null, removed: false, number, notReady: 1, history: "HISTORICAL_UPDATE_COMPLETE",
    };
    state.items.set(access, item);
    const pub = `public-sandbox-${n}-b0e2c4ee-a763-4df5-bfe9-46a46bce993d`;
    state.publicTokens.set(pub, access);
    return { access, item, publicToken: pub };
  }
  /** One transaction with every field the real /transactions/sync sent (test/fixtures/plaid/transactions-sync.page.json). */
  const tx = (item, id, date, amount, name, primary, detailed, extra = {}) => ({
    account_id: item.accounts[0].account_id, account_owner: null, amount, authorized_date: date, authorized_datetime: null, category: null, category_id: null, check_number: null,
    counterparties: [], date, datetime: null, iso_currency_code: "USD", location: { address: null, city: null, country: null, lat: null, lon: null, postal_code: null, region: null, store_number: null },
    logo_url: null, merchant_category_code: null, merchant_entity_id: null, merchant_name: name, name, payment_channel: "in store",
    payment_meta: { by_order_of: null, payee: null, payer: null, payment_method: null, payment_processor: null, ppd_id: null, reason: null, reference_number: null },
    pending: false, pending_transaction_id: null, personal_finance_category: { confidence_level: "VERY_HIGH", detailed: `${primary}_${detailed}`, primary, version: "v2" },
    personal_finance_category_icon_url: `https://plaid-category-icons.plaid.com/PFC_${primary}.png`, running_balance: null, transaction_code: null, transaction_id: id, transaction_type: "place", unofficial_currency_code: null, website: null, ...extra,
  });
  /** One recurring stream with every field the real /transactions/recurring/get sent (the amounts came with `amount` alone; no merchant is "" and not null). */
  const stream = (item, name, amount, frequency, last, next, primary, detailed, extra = {}) => ({
    account_id: item.accounts[0].account_id, average_amount: { amount }, category: null, category_id: null, description: name.toUpperCase(), first_date: "2026-01-01", frequency, is_active: true, is_user_modified: false,
    last_amount: { amount }, last_date: last, last_user_modified_datetime: "0001-01-01T00:00:00Z", merchant_name: name, personal_finance_category: { confidence_level: "HIGH", detailed: `${primary}_${detailed}`, primary },
    predicted_next_date: next, status: "MATURE", stream_id: `st_${name}`, transaction_ids: [], ...extra,
  });

  async function handle(path, body) {
    const item = body.access_token ? state.items.get(body.access_token) : null;
    if (body.access_token && !item) return err("INVALID_ACCESS_TOKEN", "INVALID_INPUT");
    if (item?.removed) return err("ITEM_NOT_FOUND");
    if (item?.failWith && path !== "/item/remove" && path !== "/link/token/create") return err(item.failWith);
    switch (path) {
      case "/link/token/create": {
        const token = `link-sandbox-${++state.n}-af1a0311-da53-4636-b754-dd15cc058176`;
        state.links.set(token, { finished: false, publicTokens: [], update: !!body.access_token });
        return { status: 200, body: { link_token: token, expiration: new Date(Date.now() + 1800_000).toISOString(), hosted_link_url: `https://secure.plaid.com/hl/fixture${state.n}`, request_id: "req_link" } };
      }
      case "/link/token/get": {
        const l = state.links.get(body.link_token);
        if (!l) return err("INVALID_LINK_TOKEN", "INVALID_INPUT");
        const session = l.finished ? [{ link_session_id: "356dbb28-7f98-44d1-8e6d-0cec580f3171", started_at: "2026-11-12T15:00:00Z", finished_at: "2026-11-12T15:02:00Z",
          ...(l.publicTokens.length ? { on_success: { public_token: l.publicTokens[0], metadata: {} }, results: { item_add_results: l.publicTokens.map(p => ({ public_token: p, accounts: [], institution: { institution_id: "ins_109508", name: "First Platypus Bank" } })) } }
            : l.update && !l.exited ? { on_success: { public_token: "public-sandbox-update-0000", metadata: {} }, results: { item_add_results: [{ public_token: "public-sandbox-update-0000", accounts: [], institution: { institution_id: "ins_109508", name: "First Platypus Bank" } }] } } : { on_exit: { error: null, metadata: { status: "requires_credentials" } }, exit: { error: null } }) }] : [];
        return { status: 200, body: { created_at: "2026-11-12T15:00:00Z", expiration: "2026-11-12T15:30:00Z", link_token: body.link_token, ...(session.length ? { link_sessions: session } : {}), metadata: { client_name: "Reason", country_codes: ["US"], initial_products: l.update ? [] : ["transactions"], language: "en", redirect_uri: null, webhook: "https://reason.test/plaid/webhook" }, request_id: "req_get" } };
      }
      case "/item/public_token/exchange": {
        const access = state.publicTokens.get(body.public_token);
        if (!access) return err("INVALID_PUBLIC_TOKEN", "INVALID_INPUT");
        return { status: 200, body: { access_token: access, item_id: state.items.get(access).item_id, request_id: "req_ex" } };
      }
      case "/accounts/get": case "/accounts/balance/get":
        return { status: 200, body: { accounts: item.accounts, item: { available_products: ["balance"], billed_products: ["transactions"], consent_expiration_time: null, error: null, institution_id: "ins_109508", institution_name: item.institution, item_id: item.item_id, products: ["transactions"], update_type: "background", webhook: "" }, request_id: "req_acc" } };
      case "/transactions/sync": {
        // The real first answer after a connection: nothing at all, and an empty cursor, so the next sync starts over.
        if (!body.cursor && item.notReady > 0) { item.notReady--; return { status: 200, body: { accounts: [], added: [], has_more: false, modified: [], next_cursor: "", removed: [], request_id: "req_sync", transactions_update_status: "NOT_READY" } }; }
        const i = body.cursor ? Number(String(body.cursor).split(":")[1]) : 0;
        const page = item.pages[i] ?? { added: [], modified: [], removed: [] };
        const next = Math.min(i + (item.pages[i] ? 1 : 0), item.pages.length);
        return { status: 200, body: { accounts: item.accounts, added: page.added ?? [], has_more: next < item.pages.length, modified: page.modified ?? [], next_cursor: `cur:${next}`, removed: page.removed ?? [], request_id: "req_sync", transactions_update_status: item.history } };
      }
      case "/transactions/recurring/get":
        // Asked in the first seconds after a connection, the real Sandbox answers PRODUCT_NOT_READY.
        if (item.notReady > 0) return err("PRODUCT_NOT_READY");
        if (!item.recurring) return err("INVALID_PRODUCT", "INVALID_INPUT");
        return { status: 200, body: { inflow_streams: [], outflow_streams: item.recurring, personal_finance_category_version: "v2", request_id: "req_rec", updated_datetime: "2026-11-12T00:00:00Z" } };
      case "/item/remove": item.removed = true; return { status: 200, body: { request_id: "req_rm" } };
      case "/webhook_verification_key/get":
        if (body.key_id !== KID) return err("INVALID_WEBHOOK_VERIFICATION_KEY_ID", "INVALID_INPUT");
        return { status: 200, body: { key: { alg: "ES256", created_at: 1560466150, crv: "P-256", expired_at: state.keyExpired ? 1560466999 : null, kid: KID, kty: "EC", use: "sig", x: jwk.x, y: jwk.y }, request_id: "req_key" } };
      default: return { status: 404, body: { error_type: "INVALID_REQUEST", error_code: "NOT_FOUND", error_message: path, display_message: null, request_id: "req_404" } };
    }
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const raw = init.body ?? (typeof input === "object" && input.body ? await new Response(input.body).text() : "{}");
    const body = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
    state.calls.push({ host: url.host, path: url.pathname, body });
    const out = await handle(url.pathname, body);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json", "plaid-request-id": "req_fixture" } });
  }

  /** A webhook body and its Plaid-Verification header, signed the documented way (ES256 over the body's SHA-256, `iat`). */
  function signed(event, { iat = Math.floor(now() / 1000), kid = KID, alg = "ES256", tamper = false } = {}) {
    const rawBody = JSON.stringify(event, null, 2);
    const head = b64({ alg, kid, typ: "JWT" });
    const claims = b64({ iat, request_body_sha256: createHash("sha256").update(rawBody).digest("hex") });
    const sig = createSign("SHA256").update(`${head}.${claims}`).sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return { rawBody: tamper ? rawBody.replace(/\}\s*$/, ', "x": 1}') : rawBody, headers: { "plaid-verification": `${head}.${claims}.${sig}` } };
  }

  return { state, fetchImpl, addBank, tx, stream, signed, err, KID, callsTo: (p) => state.calls.filter(c => c.path === p) };
}
