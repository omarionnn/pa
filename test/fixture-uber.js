// A fake Uber, served from the test.
//
// Reproduces the routes Reason actually calls, with the documented response shapes and the edge
// cases that matter most:
//
//   - POST /oauth/v2/token with grant_type=authorization_code — returns an access token with a
//     configurable scope list, which is how Limited Access comes through: `request` is absent when
//     Uber refuses it.
//   - GET /v1.2/me — identity, used on connect.
//   - GET /v1.2/products — what is available at a pickup.
//   - POST /v1.2/requests/estimate — the upfront fare, with a fare_id that expires.
//   - POST /v1.2/requests — book the ride. 202 with a request_id and status "processing".
//   - GET /v1.2/requests/{id} — where the car is.
//   - DELETE /v1.2/requests/{id} — cancel. 204 no body.
//
// `state` is ground truth: which tokens arrived, which rides were created.
import { createServer } from "node:http";

const PRODUCTS = [
  { product_id: "uberx-123", display_name: "UberX", capacity: 4, shared: false, upfront_fare_enabled: true, short_description: "Affordable rides", price_details: { cancellation_fee: 5, currency_code: "USD" } },
  { product_id: "black-456", display_name: "Uber Black", capacity: 4, shared: false, upfront_fare_enabled: true, short_description: "Premium rides", price_details: { cancellation_fee: 10, currency_code: "USD" } },
];

export async function startUber({
  grantScopes = ["profile", "places", "offline_access", "request", "request_receipt"],
  firstName = "Omari",
  email = "test@example.com",
  accessTtlSeconds = 2592000,
  refreshTokenValid = true,
  fareValue = 14.32,
  fareCurrency = "USD",
  etaMinutes = 3,
} = {}) {
  const state = {
    tokenCalls: [],
    authHeaders: [],
    rides: [],
    cancels: [],
    fareIdCounter: 0,
    requestIdCounter: 0,
  };

  let fareIdSeq = 0;
  let requestIdSeq = 0;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => body += d);
    req.on("end", () => {
      const url = new URL(req.url, `http://localhost`);
      const auth = req.headers.authorization ?? "";
      if (auth) state.authHeaders.push(auth);

      // ---------- token ----------
      if (req.method === "POST" && url.pathname === "/oauth/v2/token") {
        const params = new URLSearchParams(body);
        const grant = params.get("grant_type");
        state.tokenCalls.push({ grant_type: grant, code: params.get("code"), refresh_token: params.get("refresh_token") });

        if (grant === "authorization_code") {
          const code = params.get("code");
          if (!code || code === "bad") return json(res, 400, { error: "invalid_grant", error_description: "Bad code" });
          const token = `tok_${Date.now()}`;
          return json(res, 200, {
            access_token: token,
            token_type: "Bearer",
            expires_in: accessTtlSeconds,
            refresh_token: "ref_test_123",
            scope: grantScopes.join(" "),
          });
        }
        if (grant === "refresh_token") {
          if (!refreshTokenValid) return json(res, 400, { error: "invalid_grant", error_description: "Refresh token revoked" });
          return json(res, 200, {
            access_token: `tok_refreshed_${Date.now()}`,
            token_type: "Bearer",
            expires_in: accessTtlSeconds,
            scope: grantScopes.join(" "),
          });
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }

      // Everything below needs a bearer token.
      if (!auth.startsWith("Bearer ")) return json(res, 401, { code: "unauthorized", message: "No token" });

      // ---------- identity ----------
      if (req.method === "GET" && url.pathname === "/v1.2/me") {
        return json(res, 200, { first_name: firstName, email, uuid: "uuid-test" });
      }

      // ---------- products ----------
      if (req.method === "GET" && url.pathname === "/v1.2/products") {
        return json(res, 200, { products: PRODUCTS });
      }

      // ---------- estimate ----------
      if (req.method === "POST" && url.pathname === "/v1.2/requests/estimate") {
        const input = body ? JSON.parse(body) : {};
        fareIdSeq++;
        return json(res, 200, {
          fare: {
            fare_id: `fare_${fareIdSeq}`,
            display: `$${fareValue.toFixed(2)}`,
            value: fareValue,
            currency_code: fareCurrency,
            expires_at: Math.floor(Date.now() / 1000) + 120,
          },
          pickup_estimate: etaMinutes,
          trip: { distance_estimate: 5.2, distance_unit: "mile", duration_estimate: 15 },
        });
      }

      // ---------- request ----------
      if (req.method === "POST" && url.pathname === "/v1.2/requests") {
        const input = body ? JSON.parse(body) : {};
        if (!input.fare_id) return json(res, 422, { code: "invalid_fare_id", message: "Missing fare_id" });
        requestIdSeq++;
        const rid = `req_${requestIdSeq}`;
        state.rides.push({ request_id: rid, fare_id: input.fare_id, product_id: input.product_id });
        return json(res, 202, {
          request_id: rid,
          status: "processing",
          product_id: input.product_id,
          eta: etaMinutes,
          driver: null,
          vehicle: null,
          surge_multiplier: 1,
        });
      }

      // ---------- status ----------
      const statusMatch = url.pathname.match(/^\/v1\.2\/requests\/([^/]+)$/);
      if (req.method === "GET" && statusMatch) {
        const rid = statusMatch[1];
        const ride = state.rides.find(r => r.request_id === rid);
        if (!ride) return json(res, 404, { code: "not_found", message: "No such request" });
        return json(res, 200, {
          request_id: rid,
          status: "accepted",
          eta: 2,
          driver: { name: "Marcus", rating: 4.9, phone_number: "+1234567890" },
          vehicle: { make: "Toyota", model: "Camry", license_plate: "ABC 1234" },
          surge_multiplier: 1,
        });
      }

      // ---------- cancel ----------
      if (req.method === "DELETE" && statusMatch) {
        const rid = statusMatch[1];
        state.cancels.push(rid);
        res.writeHead(204);
        return res.end();
      }

      // ---------- receipt ----------
      const receiptMatch = url.pathname.match(/^\/v1\.2\/requests\/([^/]+)\/receipt$/);
      if (req.method === "GET" && receiptMatch) {
        return json(res, 200, {
          request_id: receiptMatch[1],
          total_charged: { amount: fareValue, currency_code: fareCurrency },
          charge_adjustments: [],
          duration: "15 min",
          distance: "5.2 miles",
        });
      }

      json(res, 404, { code: "not_found", message: "Unknown route" });
    });
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, state, base, close: () => new Promise(r => server.close(r)) };
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
