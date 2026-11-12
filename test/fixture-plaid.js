// A fake Plaid for the offline suite: a `fetch` handed to the real `plaid` SDK (v51), answering
// with the response shapes Plaid documents (plaid.com/docs, read 2026-11-12). No network, no keys.
// SHAPES_FROM says where each shape came from: "docs" until a real Sandbox run has replaced it.
import { createHash, createSign, generateKeyPairSync } from "node:crypto";

export const SHAPES_FROM = "docs";

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
  const err = (error_code, error_type = "ITEM_ERROR", status = 400) => ({ status, body: { error_type, error_code, error_message: `${error_code} (fixture)`, display_message: null, request_id: "req_fixture" } });

  /** A bank with one checking account, as /accounts/get documents it. `number` is a full account number that must never surface. */
  function addBank({ institution = "First Platypus Bank", mask = "0000", available = 100, current = 110, number = "1111222233330000", kind = "checking" } = {}) {
    const KIND = { checking: ["Plaid Checking", "depository", "checking"], savings: ["Plaid Saving", "depository", "savings"], credit: ["Plaid Credit Card", "credit", "credit card"] }[kind];
    const n = ++state.n;
    const access = `access-sandbox-${String(n).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`;
    const item = {
      item_id: `item_${n}_wz666MBjYWTp2PDzzggYhM6oWWmBb`, institution,
      accounts: [{ account_id: `acc_${n}_checking`, balances: { available: kind === "credit" ? null : available, current, limit: kind === "credit" ? 2000 : null, iso_currency_code: "USD", unofficial_currency_code: null }, mask, name: KIND[0], official_name: `Plaid Gold Standard 0% Interest ${number}`, type: KIND[1], subtype: KIND[2] }],
      pages: [], recurring: null, failWith: null, removed: false, number,
    };
    state.items.set(access, item);
    const pub = `public-sandbox-${n}-b0e2c4ee-a763-4df5-bfe9-46a46bce993d`;
    state.publicTokens.set(pub, access);
    return { access, item, publicToken: pub };
  }
  /** One transaction as /transactions/sync documents it. */
  const tx = (item, id, date, amount, name, primary, detailed, extra = {}) => ({
    account_id: item.accounts[0].account_id, transaction_id: id, date, authorized_date: date, amount, iso_currency_code: "USD", unofficial_currency_code: null,
    name, merchant_name: name, pending: false, payment_channel: "in store",
    personal_finance_category: { primary, detailed: `${primary}_${detailed}`, confidence_level: "VERY_HIGH", version: "v2" }, ...extra,
  });

  async function handle(path, body) {
    const item = body.access_token ? state.items.get(body.access_token) : null;
    if (body.access_token && (!item || item.removed)) return err("INVALID_ACCESS_TOKEN", "INVALID_INPUT");
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
        return { status: 200, body: { link_token: body.link_token, created_at: "2026-11-12T15:00:00Z", expiration: "2026-11-12T15:30:00Z", link_sessions: session, metadata: {}, request_id: "req_get" } };
      }
      case "/item/public_token/exchange": {
        const access = state.publicTokens.get(body.public_token);
        if (!access) return err("INVALID_PUBLIC_TOKEN", "INVALID_INPUT");
        return { status: 200, body: { access_token: access, item_id: state.items.get(access).item_id, request_id: "req_ex" } };
      }
      case "/accounts/get": case "/accounts/balance/get":
        return { status: 200, body: { accounts: item.accounts, item: { item_id: item.item_id, institution_id: "ins_109508", institution_name: item.institution, webhook: "", available_products: ["balance"], billed_products: ["transactions"], error: null }, request_id: "req_acc" } };
      case "/transactions/sync": {
        const i = body.cursor ? Number(String(body.cursor).split(":")[1]) : 0;
        const page = item.pages[i] ?? { added: [], modified: [], removed: [] };
        const next = Math.min(i + (item.pages[i] ? 1 : 0), item.pages.length);
        return { status: 200, body: { added: page.added ?? [], modified: page.modified ?? [], removed: page.removed ?? [], next_cursor: `cur:${next}`, has_more: next < item.pages.length, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE", accounts: item.accounts, request_id: "req_sync" } };
      }
      case "/transactions/recurring/get":
        if (!item.recurring) return err("INVALID_PRODUCT", "INVALID_REQUEST");
        return { status: 200, body: { inflow_streams: [], outflow_streams: item.recurring, updated_datetime: "2026-11-12T00:00:00Z", request_id: "req_rec" } };
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

  return { state, fetchImpl, addBank, tx, signed, err, KID, callsTo: (p) => state.calls.filter(c => c.path === p) };
}
