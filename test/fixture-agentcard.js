// A fake AgentCard, served from the test.
//
// Every route matches what AgentCard documents at docs.agentcard.sh (read 2026-10-11):
//
//   - POST /api/v2/oauth/token            client_credentials → a platform token, expires_in 3600.
//   - POST /api/v2/vault_sessions         Bearer org token → { id, url, poll_interval, expires_at }.
//   - GET  /api/v2/vault_sessions/{id}    status pending | linked (+ user_id once linked).
//   - GET  /api/v2/vault_cards?user_id=   display fields only; 404 connection_not_found for a user
//                                         this organization never enrolled.
//   - POST /api/v1/cardholders/{id}/buy_token   Bearer org token → a user-scoped token.
//   - POST /buy                           the turn loop. An org token is REFUSED here, like the real
//                                         one: /buy always runs as a single user.
//   - GET  /buy/v1/merchants/retail/orders/{id}/track
//
// `state` is the ground truth the tests assert on, and `set()` is how a test says what the next turn
// should do — a cart, a question, an approval pause, a decline, a price that moved, a confirm that
// never answers. The shapes are the documented ones, including the 409 that carries a fresh cart.
import { createServer } from "node:http";

const COFFEE = {
  merchant: "retail",
  merchant_name: "Amazon",
  items: [
    { name: "Cafe Mesa de los Santos Colombian Ground Coffee, 16 oz", qty: 1, priceCents: 2250, product_id: "https://www.amazon.com/dp/B07ZQ5C4RB" },
  ],
  serviceFeesCents: 56,
  tipCents: 0,
  totalCents: 2306,
  approvedCeilingCents: null,
  hash: "9f2c4a1b8e3d5f07",
};

// The same cart after the shop moved the price. A new total means a new hash, which is the thing the
// confirm gate leans on: a yes for the old total cannot be spent on this one.
const COFFEE_DEARER = { ...COFFEE, items: [{ ...COFFEE.items[0], priceCents: 2650 }], totalCents: 2706, hash: "aa11bb22cc33dd44" };

const CATALOG = {
  merchant: "retail",
  merchant_name: "Amazon",
  items: [{ id: "https://www.amazon.com/dp/B07ZQ5C4RB", name: "Cafe Mesa de los Santos Colombian Ground Coffee, 16 oz", priceCents: 2250, image_url: "https://m.media-amazon.com/images/I/71x.jpg" }],
  as_of: "2026-10-11T19:26:04Z",
};

export async function startAgentCard({
  // What the next `ask` turn does: "cart" hands back a cart, "needs_input" asks a question instead.
  ask = "cart",
  // What the next `confirm` does, in order. Shifted one per confirm; the last one repeats.
  confirms = ["placed"],
  cards = [{ id: "vc_7f3a9c2e1b4d6f8a0c2e4b6d", brand: "visa", last4: "4832", expiry_month: 12, expiry_year: 2029, created_at: "2026-09-02T18:41:07Z" }],
  // Which user ids this organization has enrolled. Anything else is a 404, like the real API.
  knownUsers = ["usr_8f3k2m"],
  sessionStatus = "pending",
  sessionUser = "usr_8f3k2m",
} = {}) {
  const state = {
    tokenCalls: [],
    vaultSessions: [],
    buyTokenCalls: [],
    asks: [],
    confirmCalls: [],
    cardReads: [],
    tracks: [],
    liveOrgTokens: new Set(),
    liveBuyTokens: new Set(),
    tokenCounter: 0,
    sessionCounter: 0,
    orderCounter: 0,
  };
  const cfg = { ask, confirms: [...confirms], cards, knownUsers, sessionStatus, sessionUser };
  // Carts handed out per conversation, so a confirm can be checked against the hash really shown.
  const carts = new Map();

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readJson = (fn) => {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body || "{}"); } catch { parsed = {}; }
        fn(parsed, body);
      });
    };
    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    // ---------- POST /api/v2/oauth/token ----------
    if (url.pathname === "/api/v2/oauth/token" && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        const params = Object.fromEntries(new URLSearchParams(body));
        state.tokenCalls.push(params);
        if (params.grant_type !== "client_credentials") {
          return json(400, { error: { code: "unsupported_grant_type", message: `Unknown grant_type: ${params.grant_type}` } });
        }
        if (!params.client_id || !params.client_secret) {
          return json(401, { error: { code: "invalid_client", message: "client_id and client_secret are required." } });
        }
        if (params.client_secret === "wrong-secret") {
          return json(401, { error: { code: "invalid_client", message: "Those credentials are not valid." } });
        }
        const token = `acat_${++state.tokenCounter}`;
        state.liveOrgTokens.add(token);
        return json(200, { access_token: token, token_type: "bearer", expires_in: 3600 });
      });
      return;
    }

    const orgOk = () => state.liveOrgTokens.has(bearer);

    // ---------- POST /api/v2/vault_sessions ----------
    if (url.pathname === "/api/v2/vault_sessions" && req.method === "POST") {
      if (!orgOk()) return json(401, { error: { code: "invalid_token", message: "An organization token is required." } });
      return readJson((parsed) => {
        const id = `vs_${++state.sessionCounter}`;
        state.vaultSessions.push({ id, body: parsed });
        return json(200, {
          object: "vault_session",
          id,
          user_id: parsed.user_id ?? null,
          url: `https://vault.agentcard.sh/v?vs=${id}.3k1vsigned`,
          expires_at: "2026-10-12T19:00:00Z",
          poll_interval: 3,
          test_mode: false,
        });
      });
    }

    // ---------- GET /api/v2/vault_sessions/{id} ----------
    const sessionRead = /^\/api\/v2\/vault_sessions\/([^/]+)$/.exec(url.pathname);
    if (sessionRead && req.method === "GET") {
      if (!orgOk()) return json(401, { error: { code: "invalid_token", message: "An organization token is required." } });
      return json(200, {
        object: "vault_session",
        id: sessionRead[1],
        status: cfg.sessionStatus,
        user_id: cfg.sessionStatus === "linked" ? cfg.sessionUser : null,
        expires_at: "2026-10-12T19:00:00Z",
      });
    }

    // ---------- GET /api/v2/vault_cards?user_id= ----------
    if (url.pathname === "/api/v2/vault_cards" && req.method === "GET") {
      if (!orgOk()) return json(401, { error: { code: "invalid_token", message: "An organization token is required." } });
      const userId = url.searchParams.get("user_id") ?? "";
      state.cardReads.push(userId);
      if (!cfg.knownUsers.includes(userId)) {
        return json(404, { error: { code: "connection_not_found", message: "No production connection exists for that user." } });
      }
      return json(200, { object: "list", data: cfg.cards });
    }

    // ---------- POST /api/v1/cardholders/{id}/buy_token ----------
    const buyToken = /^\/api\/v1\/cardholders\/([^/]+)\/buy_token$/.exec(url.pathname);
    if (buyToken && req.method === "POST") {
      if (!orgOk()) return json(401, { error: { code: "invalid_token", message: "An organization token is required." } });
      return readJson(() => {
        state.buyTokenCalls.push(buyToken[1]);
        const token = `acbt_${buyToken[1]}_${++state.tokenCounter}`;
        state.liveBuyTokens.add(token);
        return json(200, { access_token: token, token_type: "bearer", expires_in: 3600 });
      });
    }

    // ---------- POST /buy ----------
    if (url.pathname === "/buy" && req.method === "POST") {
      // The real API refuses an organization token here, and that refusal is worth having in the
      // fixture: it is what proves Reason never reaches a purchase with the wrong half.
      if (state.liveOrgTokens.has(bearer)) {
        return json(403, { error: { code: "user_token_required", message: "/buy runs as a single user; an organization token cannot be used." } });
      }
      if (!state.liveBuyTokens.has(bearer)) return json(401, { error: { code: "invalid_token", message: "A user token is required." } });

      return readJson((parsed) => {
        const conv = parsed.conversation_id || `conv_${state.asks.length + 1}abc`;

        if (parsed.confirm) {
          state.confirmCalls.push({ ...parsed, conversation_id: conv });
          const behaviour = cfg.confirms.length > 1 ? cfg.confirms.shift() : (cfg.confirms[0] ?? "placed");
          const shown = carts.get(conv);

          if (behaviour === "hang") return; // never answers: the client's own timeout is the test
          if (behaviour === "turn_in_progress") {
            return json(409, { error: "a turn is already running on this conversation", code: "turn_in_progress", conversation_id: conv });
          }
          if (behaviour === "price_changed") {
            carts.set(conv, COFFEE_DEARER);
            return json(409, {
              error: "the cart's price changed since it was shown",
              code: "cart_price_changed",
              conversation_id: conv,
              cart: COFFEE_DEARER,
              carts: [COFFEE_DEARER],
            });
          }
          if (behaviour === "approval_required") {
            return json(200, {
              conversation_id: conv,
              status: "declined",
              decline_code: "vault_approval_required",
              approval_url: "https://vault.agentcard.sh/authorize?id=cauth_2q9d1x8f3k2m4t7w",
              charge_status: "none",
            });
          }
          if (behaviour === "sandbox") {
            return json(200, { conversation_id: conv, status: "declined", decline_code: "sandbox_mode", charge_status: "none" });
          }
          if (behaviour === "unavailable") {
            return json(200, { conversation_id: conv, status: "declined", decline_code: "items_unavailable", charge_status: "none" });
          }
          if (behaviour === "needs_input") {
            return json(200, { conversation_id: conv, status: "needs_input", reply: "Which size did you want?" });
          }
          // Placed. The hash really sent is echoed back on the order so a test can prove the cart
          // that was confirmed is the cart that was shown.
          const orderId = `order_${++state.orderCounter}`;
          state.tracks.push({ orderId, hash: parsed.confirm, conversation_id: conv });
          return json(200, {
            conversation_id: conv,
            status: behaviour === "partial" ? "partially_placed" : "order_placed",
            reply: `Order placed at Amazon. Charged $${((shown?.totalCents ?? 2306) / 100).toFixed(2)} to your Visa ending 4832.`,
            order_id: orderId,
            payment_source: { source: "vault", brand: "visa", last4: "4832" },
            charge_status: "settled",
          });
        }

        state.asks.push({ ...parsed, conversation_id: conv });
        if (cfg.ask === "needs_input") {
          return json(200, {
            conversation_id: conv,
            status: "needs_input",
            reply: "Which roast did you mean — the Colombian or the Ethiopian?",
            catalog: CATALOG,
            unmatched: [],
          });
        }
        if (cfg.ask === "bad_address") {
          return json(400, { error: "zip is required", code: "invalid_delivery_address", message: "zip is required" });
        }
        const cart = cfg.ask === "dearer" ? COFFEE_DEARER : COFFEE;
        carts.set(conv, cart);
        return json(200, {
          conversation_id: conv,
          status: "needs_input",
          reply: `Found it. ${cart.items[0].name}, at $${(cart.items[0].priceCents / 100).toFixed(2)}. Total $${(cart.totalCents / 100).toFixed(2)}. Want me to place it?`,
          cart,
          carts: [cart],
          catalog: CATALOG,
          unmatched: [],
        });
      });
    }

    // ---------- GET /buy/v1/merchants/retail/orders/{id}/track ----------
    const track = /^\/buy\/v1\/merchants\/retail\/orders\/([^/]+)\/track$/.exec(url.pathname);
    if (track && req.method === "GET") {
      if (!state.liveBuyTokens.has(bearer)) return json(401, { error: { code: "invalid_token", message: "A user token is required." } });
      if (cfg.trackEmpty) return json(200, { order_number: "", delivery_window: "", total: "", shipments: [] });
      return json(200, {
        order_number: "112-9988776-5544332",
        delivery_window: "Tue 14 Oct — Wed 15 Oct",
        total: "$23.06",
        shipments: [{ carrier: "UPS", tracking_number: "1Z999AA10123456784", status: "in_transit" }],
      });
    }

    return json(404, { error: { code: "not_found", message: `No such route: ${req.method} ${url.pathname}` } });
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    carts,
    CART: COFFEE,
    CART_DEARER: COFFEE_DEARER,
    set(patch) {
      if (patch.confirms) patch = { ...patch, confirms: [...patch.confirms] };
      Object.assign(cfg, patch);
    },
    close: () => new Promise(r => server.close(r)),
  };
}
