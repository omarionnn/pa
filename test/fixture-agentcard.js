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
//   - GET  /buy/conversations/{id}        the conversation read: last checkout, orders[], carts.
//   - GET  /buy/orders/{id}               one order's own record (AgentCard support, 2026-10-24; not in
//                                         the public docs): status, status_updated_at, estimated_arrival,
//                                         tracking, placed_at. `orderRead` says what it answers: the
//                                         tracked order's status (default), "down" (503), "missing" (404),
//                                         or an object merged over the record. Hits in state.orderReads.
//   - GET  /buy/v1/merchants/retail/orders/{id}/track   RETIRED: 410 endpoint_retired, as the real one
//                                         has answered since 2026-10-24. Every hit is counted in
//                                         state.trackHits so a test can prove nothing calls it.
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

// A cart AgentCard might build for a vaguer ask: a different product than the one picked.
const OTHER_COFFEE = {
  ...COFFEE,
  items: [{ name: "Amazon Fresh Colombia Ground Coffee, 32 oz", qty: 1, priceCents: 1599, product_id: "https://www.amazon.com/dp/B072K4DQ9V", url: "https://www.amazon.com/dp/B072K4DQ9V" }],
  serviceFeesCents: 40, totalCents: 1639, hash: "0ther0ther0ther0",
};

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
    exchanges: [],
    exchanged: new Set(),
    refreshes: [],
    asks: [],
    confirmCalls: [],
    cardReads: [],
    tracks: [],
    trackHits: [],
    convReads: [],
    orderReads: [],
    liveOrgTokens: new Set(),
    liveBuyTokens: new Set(),
    liveRefresh: new Set(),
    tokenUser: new Map(),
    tokenCounter: 0,
    sessionCounter: 0,
    orderCounter: 0,
  };
  // `conversation`: what GET /buy/conversations/{id} answers (the reconcile read). Null → no orders.
  const cfg = { ask, confirms: [...confirms], cards, cardsByUser: null, knownUsers, sessionStatus, sessionUser, exchange: "ok", conversation: null, refresh: "ok", refreshDelayMs: 0 };
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
      // Each person's own vault. `cardsByUser` is what lets a test prove one person never sees
      // another's card; without an entry everybody shares `cards`, which is fine for single-user tests.
      return json(200, { object: "list", data: cfg.cardsByUser?.[userId] ?? cfg.cards });
    }

    // ---------- POST /api/v2/vault_sessions/{id}/exchange ----------
    //
    // The real one, and the shape matters: single use, `410 already_exchanged` on a second call, and
    // `403 account_verification_required` when the person signed in to an account that already
    // existed. The user id is nested under `user`, not flat.
    const exchange = /^\/api\/v2\/vault_sessions\/([^/]+)\/exchange$/.exec(url.pathname);
    if (exchange && req.method === "POST") {
      if (!orgOk()) return json(401, { error: { code: "invalid_token", message: "An organization token is required." } });
      return readJson(() => {
        const id = exchange[1];
        state.exchanges.push(id);
        if (cfg.exchange === "needs_verification") {
          return json(403, { error: { code: "account_verification_required", message: "That account already existed; verify it first." } });
        }
        if (state.exchanged.has(id)) {
          return json(410, { error: { code: "already_exchanged", message: "That session was already exchanged." } });
        }
        state.exchanged.add(id);
        const token = `acut_${++state.tokenCounter}`;
        state.liveBuyTokens.add(token);
        const refresh = `acrt_${state.tokenCounter}`;
        state.liveRefresh.add(refresh);
        // Whose token this is, so a test can prove a purchase ran as the right person rather than
        // merely that it ran. This is the fixture's half of the isolation question.
        state.tokenUser.set(token, cfg.sessionUser);
        state.tokenUser.set(refresh, cfg.sessionUser);
        return json(200, { access_token: token, refresh_token: refresh, expires_in: 3600, user: { id: cfg.sessionUser } });
      });
    }

    // ---------- POST /api/v2/connect/refresh ----------
    if (url.pathname === "/api/v2/connect/refresh" && req.method === "POST") {
      if (!orgOk()) return json(401, { error: { code: "invalid_token", message: "An organization token is required." } });
      return readJson(async (parsed) => {
        state.refreshes.push(parsed.refresh_token ?? "");
        // `refresh`: "ok" (default), "down" — a 503 that spends nothing — or "drop", the connection
        // cut with no answer at all. `refreshDelayMs` holds the answer back, for racing two callers.
        if (cfg.refreshDelayMs) await new Promise(r => setTimeout(r, cfg.refreshDelayMs));
        if (cfg.refresh === "down") return json(503, { error: { code: "service_unavailable", message: "Try again shortly." } });
        if (cfg.refresh === "drop") { req.socket.destroy(); return; }
        if (!state.liveRefresh.has(parsed.refresh_token)) {
          return json(401, { error: { code: "invalid_grant", message: "That refresh token is not valid." } });
        }
        const token = `acut_${++state.tokenCounter}`;
        state.liveBuyTokens.add(token);
        // A rotated token belongs to whoever the refresh token belonged to — never to whoever the
        // fixture happens to be configured for at this moment, which would hide a mix-up.
        const whose = state.tokenUser.get(parsed.refresh_token) ?? cfg.sessionUser;
        state.tokenUser.set(token, whose);
        // The documented ConnectionRefreshed: a NEW pair, no user, and the old refresh token is dead
        // (openapi.json, read 2026-10-24). Before then this fixture answered with a user and the same
        // refresh token, which hid that Reason threw every refreshed pair away.
        state.liveRefresh.delete(parsed.refresh_token);
        const next = `acrt_r${state.tokenCounter}`;
        state.liveRefresh.add(next);
        state.tokenUser.set(next, whose);
        return json(200, { object: "connection", access_token: token, refresh_token: next, token_type: "Bearer", expires_in: 3600 });
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
          state.confirmCalls.push({ ...parsed, conversation_id: conv, token: bearer, user: state.tokenUser.get(bearer) ?? "" });
          const behaviour = cfg.confirms.length > 1 ? cfg.confirms.shift() : (cfg.confirms[0] ?? "placed");
          const shown = carts.get(conv);

          if (behaviour === "hang") return; // never answers: the client's own timeout is the test
          // A scripted answer, for merchants this fake has no built-in shape for (a flight confirm):
          // `{ httpStatus?, body, placeOrder? }`. `placeOrder` records an order the way "placed" does,
          // and its id is put on the body as order_id.
          if (behaviour && typeof behaviour === "object") {
            let orderId = null;
            if (behaviour.placeOrder) {
              orderId = `order_${++state.orderCounter}`;
              state.tracks.push({ orderId, hash: parsed.confirm, conversation_id: conv });
            }
            return json(behaviour.httpStatus ?? 200, { ...behaviour.body, conversation_id: conv, ...(orderId ? { order_id: orderId } : {}) });
          }
          // The answer is lost but the order went through on AgentCard's side — the case a
          // reconcile read exists for. The order is recorded (so a "tracked" read lists it) and the
          // response never comes.
          if (behaviour === "hang_placed") {
            state.tracks.push({ orderId: `order_${++state.orderCounter}`, hash: parsed.confirm, conversation_id: conv });
            return;
          }
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
              approval_url: `https://vault.agentcard.sh/authorize?id=cauth_${conv}`,
              charge_status: "none",
            });
          }
          if (behaviour === "byoc_approval") {
            return json(200, {
              conversation_id: conv, status: "declined", decline_code: "byoc_approval_required",
              approval_url: `https://vault.agentcard.sh/authorize?id=cauth_${conv}`, charge_status: "none",
            });
          }
          if (behaviour === "declined_unknown") {
            return json(200, { conversation_id: conv, status: "declined", decline_code: "processor_error", charge_status: "unknown" });
          }
          // commerce_billing_required, as this install really got it on 2026-10-24 03:59Z: a declined
          // confirm with nothing charged. AgentCard support, 2026-10-24: the ORG has not set up how it pays
          // AgentCard's 1% commerce fee (Commerce SDK → Balance) — nothing to do with a free-order quota.
          if (behaviour === "billing_required") {
            return json(200, { conversation_id: conv, status: "declined", decline_code: "commerce_billing_required", charge_status: "none" });
          }
          // The same refusal as a flat error with a sibling code, the way AgentCard's other /buy refusals come.
          if (behaviour === "billing_required_http") {
            return json(403, { error: "Commerce billing is not configured for this organization.", code: "commerce_billing_required", conversation_id: conv });
          }
          // Prose that talks about a free order under some OTHER code: matched on nothing but the code,
          // and no free-order code is known yet (agentcard.FREE_ORDER_QUOTA_CODES is empty).
          if (behaviour === "free_words_other_code") {
            return json(403, { error: "Your one free order has been used.", code: "forbidden", conversation_id: conv });
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
          // `beforeConfirmAnswer`: something that happens at AgentCard while this answer is still on its
          // way — a webhook for the order this confirm just placed, say. The answer waits for it.
          const answer = () => json(200, {
            conversation_id: conv,
            status: behaviour === "partial" ? "partially_placed" : "order_placed",
            reply: `Order placed at Amazon. Charged $${((shown?.totalCents ?? 2306) / 100).toFixed(2)} to your Visa ending 4832.`,
            order_id: orderId,
            payment_source: { source: "vault", brand: "visa", last4: "4832" },
            charge_status: behaviour === "charge_unknown" ? "unknown" : "settled",
          });
          if (cfg.beforeConfirmAnswer) {
            Promise.resolve().then(() => cfg.beforeConfirmAnswer({ conversation_id: conv, order_id: orderId })).then(answer, answer);
            return;
          }
          return answer();
        }

        state.asks.push({ ...parsed, conversation_id: conv, token: bearer, user: state.tokenUser.get(bearer) ?? "" });
        // `turns`: whole recorded answers, one per ask, in order.
        // The conversation id is this fake's own so the turns chain; a cart on one is the cart a
        // confirm is checked against.
        if (cfg.turns?.length) {
          const b = cfg.turns.shift();
          if (b.cart) carts.set(conv, b.cart);
          return json(b.httpStatus ?? 200, { ...b, conversation_id: conv });
        }
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
        const base = cfg.ask === "dearer" ? COFFEE_DEARER : cfg.ask === "other" ? OTHER_COFFEE : COFFEE;
        // `ceilingCents`: the most the card may be held for, as the real API's `approvedCeilingCents`
        // (2026-10-26: $26.14 on a $16.78 Target cart). Same hash — the ceiling is not part of it.
        const cart = cfg.ceilingCents == null ? base : { ...base, approvedCeilingCents: cfg.ceilingCents, totalIsEstimate: true };
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

    // ---------- GET /buy/conversations/{id} ----------
    const convRead = /^\/buy\/conversations\/([^/]+)$/.exec(url.pathname);
    if (convRead && req.method === "GET") {
      if (!state.liveBuyTokens.has(bearer)) return json(401, { error: { code: "invalid_token", message: "A user token is required." } });
      const id = decodeURIComponent(convRead[1]);
      state.convReads.push(id);
      // "tracked": list the orders this fixture really placed on that conversation, by their real ids.
      // The order's own record, shaped like the real one (2026-10-24): retailer_order_id, delivery_window
      // and confirmed_at are null until the shop confirms. `orderStatus` / `orderFields` say what the
      // record reads now — "cancelled", or a confirmed order with its number and window.
      const tracked = state.tracks.filter(t => t.conversation_id === id).map(t => ({
        order_id: t.orderId, status: cfg.orderStatus ?? "placed", merchant: "retail", merchant_name: "Amazon", total_cents: 2306,
        retailer_order_id: null, delivery_window: null, confirmed_at: null, merchant_total_cents: null,
        placed_at: "2026-10-11T19:30:00.000Z", payment_source: { source: "vault", brand: "visa", last4: "4832" },
        ...(cfg.orderFields ?? {}),
      }));
      const extra = cfg.conversation === "tracked" ? { orders: tracked } : (cfg.conversation ?? {});
      return json(200, { conversation_id: id, status: "open", turn_in_progress: false, last_checkout: null, orders: [], carts: [], ...extra });
    }

    // ---------- GET /buy/orders/{id} ----------
    const orderRead = /^\/buy\/orders\/([^/]+)$/.exec(url.pathname);
    if (orderRead && req.method === "GET") {
      if (!state.liveBuyTokens.has(bearer)) return json(401, { error: "Invalid or expired token" });
      const id = decodeURIComponent(orderRead[1]);
      state.orderReads.push(id);
      if (cfg.orderRead === "down") return json(503, { error: "unavailable", code: "unavailable" });
      const placed = state.tracks.find(t => t.orderId === id);
      if (!placed || cfg.orderRead === "missing") return json(404, { error: "order_not_found", code: "order_not_found" });
      return json(200, {
        order_id: id, status: cfg.orderStatus ?? "placed", status_updated_at: "2026-10-11T19:40:00.000Z",
        estimated_arrival: null, tracking: null, placed_at: "2026-10-11T19:30:00.000Z",
        ...(cfg.orderRead && typeof cfg.orderRead === "object" ? cfg.orderRead : {}),
      });
    }

    // ---------- GET /buy/v1/merchants/retail/orders/{id}/track ----------
    const track = /^\/buy\/v1\/merchants\/retail\/orders\/([^/]+)\/track$/.exec(url.pathname);
    if (track && req.method === "GET") {
      state.trackHits.push(decodeURIComponent(track[1]));
      return json(410, { error: "endpoint_retired" });
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
      if (patch.turns) patch = { ...patch, turns: patch.turns.map(t => structuredClone(t)) };
      Object.assign(cfg, patch);
    },
    close: () => new Promise(r => server.close(r)),
  };
}
