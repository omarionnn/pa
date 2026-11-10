# Flights booked end to end (Duffel + Stripe), behind REASON_FLIGHT_DUFFEL

Off by default. `owner` or `on`, plus DUFFEL_ACCESS_TOKEN (a `duffel_test_` key, or a live one with
REASON_FLIGHT_DUFFEL_LIVE=1, not to be set until a lawyer has answered the seller-of-travel question), DUFFEL_WEBHOOK_SECRET, STRIPE_SECRET_KEY, and Face ID allowed for them
(REASON_PASSKEY_PAY). Reason's fee: REASON_FLIGHT_FEE_CENTS.

Code: `src/duffel.js` (API, what an answer proves), `src/flightorders.js` (state, money, sweep,
webhook), `src/flighttools.js` (the model's tools), kind `flight` in `src/passkey.js` and
`src/pages/webapprove.js`, `POST /duffel/webhook` in `src/http.js`.

Order of a booking: Face ID, count against today, Stripe manual hold, POST /air/orders from Duffel
Balance, capture, GET the order back, text. Unclear answers (timeout, 500, 502, 504, 200, 202) become
`unknown`: never resent, not charged, settled by webhook or the 60 s sweep, released after 24 h.

Offline: `test/flight-orders.test.js` (fake Duffel and Stripe from documented shapes, software
authenticator). Not yet driven against Duffel's sandbox: no test key existed when it was built.
Register the webhook for: order.airline_initiated_change_detected, order.created,
order.creation_failed, order_cancellation.confirmed, air.order.changed.
