// AgentCard: a card the person keeps in somebody else's vault, and a purchase Reason can run.
//
// Everything here was written from AgentCard's current docs (docs.agentcard.sh, read 2026-10-11),
// nothing is from memory and nothing is invented. The pieces that matter:
//
//   **Two tokens, and they are not interchangeable.** The organization token comes from
//   POST /api/v2/oauth/token with grant_type=client_credentials and is this machine's — it mints
//   vault sessions and reads which cards a user has. The /buy endpoint refuses it outright, because
//   a purchase always runs as ONE user: that one is a buy token, minted per cardholder at
//   POST /api/v1/cardholders/{id}/buy_token. Reason keeps the two apart by name (`orgToken` vs
//   `userToken`) so a call can never be made with the wrong half.
//
//   **The card is never here.** The person types it on AgentCard's own page, their device encrypts
//   it before it leaves, and what comes back to this machine is a `user_id` and display fields —
//   brand, last four, expiry. There is no code path in this file that could receive a card number,
//   which is the whole reason for using a vault rather than asking somebody to text their card.
//
//   **A purchase is a turn-based loop** (POST /buy), tied together by AgentCard's own
//   `conversation_id`. Each turn carries an `ask` in plain words and comes back with a `status`
//   (needs_input, order_placed, partially_placed, declined), a `reply` to show the person, and —
//   once it has worked out what they mean — a `cart` with real prices and a `hash`. Nothing can be
//   charged during that loop. The charge happens on one call and one only: a confirm carrying that
//   exact hash. Branch on `status`, never on `reply` — the docs say so and it is the difference
//   between code that knows what happened and code that read a sentence.
//
//   **The person approves twice, and the two are different questions.** Reason's own gate asks
//   "buy this for $23.06?" and will not run the confirm without a yes on record (src/trust.js).
//   AgentCard then pauses the payment and asks their own device for a passkey — a confirm comes back
//   `declined` with `decline_code: vault_approval_required` and an `approval_url`, which is a pause
//   and not a verdict: nothing was charged. The same confirm is repeated after they approve.
//
//   **A cart is bound to its price and its address.** A confirm authorizes one cart at one total; if
//   anything drifted the confirm answers 409 with a fresh cart and a new hash, and the new total has
//   to be shown and agreed to again. `delivery_address` has to be sent on every call of a
//   conversation including the first, or the cart cannot be confirmed against it at all.
//
//   **Sandbox stops at the confirm** by design: the loop and the cart are identical to production
//   and the confirm answers `declined` with `decline_code: sandbox_mode`, because a sandbox card
//   cannot pay a real shop. So "it got all the way to the cart" is a real result on sandbox
//   credentials, and an order placed is not.
//
//   **Webhooks are the record**, SDK callbacks are not. Every delivery carries an
//   `AgentCard-Signature: t=…,v1=…` header: HMAC-SHA256 of `t` joined to the RAW body with a dot,
//   under the endpoint's own secret. Delivery is at least once, so events are deduplicated on id.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, clock } from "./config.js";

/** Whether this install has AgentCard credentials at all. Nothing below here works without both. */
export function isConfigured() {
  return !!(config.agentcardClientId && config.agentcardClientSecret);
}

export function status() {
  const missing = [];
  if (!config.agentcardClientId) missing.push("AGENTCARD_CLIENT_ID");
  if (!config.agentcardClientSecret) missing.push("AGENTCARD_CLIENT_SECRET");
  return { connected: missing.length === 0, missing };
}

/** Throws when the credentials are absent. Callers that can say something useful check isConfigured first. */
export function requireAgentCard() {
  if (!isConfigured()) {
    throw new Error("AgentCard is not configured on this install (AGENTCARD_CLIENT_ID and AGENTCARD_CLIENT_SECRET are not both set).");
  }
  return true;
}

/** The honest refusal for an install with no credentials. Nothing is claimed about anybody's card. */
export function notConfigured(extra = {}) {
  const st = status();
  return {
    ok: false,
    status: "not_configured",
    missing: st.missing,
    error: `Buying things is not set up on this install: this machine has no ${st.missing.join(" or ")}.`
      + ` ${config.ownerName} has to make an AgentCard organization at app.agentcard.sh and put the client id and secret in .env.`
      + ` Say that plainly and do not claim anything about their card or about an order.`,
    ...extra,
  };
}

// ---------- the organization token ----------
//
// Cached until it expires, because every vault session and every card read needs one and they are
// minted from the same two credentials every time. Keyed by the client id so a process whose
// credentials change — a test pointing at a fake, an install being re-keyed — can never be handed
// the token minted for the other one.
let cached = { key: "", token: "", expiresAt: 0 };

/** Clears the cached organization token. For tests, and for a re-key that should not wait an hour. */
export function forgetAccessToken() {
  cached = { key: "", token: "", expiresAt: 0 };
}

async function request(path, { method = "GET", token = "", json = null, form = null, query = null, fetchImpl = fetch } = {}) {
  const url = new URL(`${config.agentcardApiBase}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.agentcardTimeoutMs);
  try {
    const res = await fetchImpl(url.href, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(json ? { "Content-Type": "application/json" } : {}),
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      signal: ctl.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not json; the message below carries the text */ }
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        // AgentCard answers errors two ways: a nested `error` object with a code and a message, and
        // a flat `error` string with a sibling `code` — the delivery-address refusals are the flat
        // kind and they carry a fresh cart alongside. Both are read, and the body is kept whole so a
        // caller that needs the cart out of a 409 has it.
        code: body?.error?.code || body?.code || "",
        error: body?.error?.message || (typeof body?.error === "string" ? body.error : "") || body?.message || text.slice(0, 300) || `HTTP ${res.status}`,
        body: body ?? {},
      };
    }
    return { ok: true, httpStatus: res.status, body: body ?? {} };
  } catch (e) {
    if (e.name === "AbortError") {
      return { ok: false, timedOut: true, error: `AgentCard did not answer within ${Math.round(config.agentcardTimeoutMs / 1000)}s.` };
    }
    return { ok: false, unreachable: true, error: `Could not reach AgentCard: ${e.message.split("\n")[0]}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * This machine's organization token, minted or reused.
 *
 * Reused until a minute before AgentCard says it expires, so a call never goes out on a token that
 * dies in flight. Returns { ok, token } rather than throwing: every caller has something honest to
 * say about credentials that do not work, and none of them can say it from an exception.
 */
export async function getAccessToken({ fetchImpl = fetch, force = false } = {}) {
  if (!isConfigured()) return notConfigured();
  const key = config.agentcardClientId;
  if (!force && cached.key === key && cached.token && cached.expiresAt > clock.now()) {
    return { ok: true, token: cached.token, cached: true };
  }
  const got = await request("/api/v2/oauth/token", {
    method: "POST",
    form: {
      grant_type: "client_credentials",
      client_id: config.agentcardClientId,
      client_secret: config.agentcardClientSecret,
    },
    fetchImpl,
  });
  if (!got.ok) return { ok: false, error: `AgentCard would not issue a token: ${got.error}`, code: got.code ?? "" };
  const token = got.body?.access_token ?? "";
  if (!token) return { ok: false, error: "AgentCard returned no access token." };
  const ttl = Number(got.body?.expires_in ?? 0);
  cached = {
    key,
    token,
    // A minute of slack, and an hour's assumption when AgentCard says nothing — the cache being
    // short is harmless and a token that outlives its row is not.
    expiresAt: clock.now() + (ttl > 0 ? ttl * 1000 : 3600_000) - 60_000,
  };
  return { ok: true, token, cached: false };
}

// ---------- the vault: storing a card ----------

/**
 * A vault session: one link, for one person, for one enrollment.
 *
 * Open rather than connected (no `user_id` sent), which is AgentCard's own default and the right one
 * here: the person sees the card form straight away with no account to make and no code to type, and
 * a returning person unlocks with the passkey they already have. The `user_id` comes back afterwards
 * — on the `vault.session_linked` webhook, or by reading the session.
 */
export async function createVaultSession({ fetchImpl = fetch } = {}) {
  if (!isConfigured()) return notConfigured();
  const tok = await getAccessToken({ fetchImpl });
  if (!tok.ok) return tok;
  const got = await request("/api/v2/vault_sessions", { method: "POST", token: tok.token, json: {}, fetchImpl });
  if (!got.ok) return { ok: false, error: `AgentCard would not open a vault session: ${got.error}`, code: got.code ?? "" };
  const b = got.body ?? {};
  if (!b.id || !b.url) return { ok: false, error: "AgentCard opened a vault session with no id or link on it." };
  return {
    ok: true,
    id: b.id,
    url: b.url,
    poll_interval: Number(b.poll_interval ?? 3),
    expires_at: b.expires_at ?? "",
    test_mode: !!b.test_mode,
  };
}

/**
 * One vault session, read back.
 *
 * The other half of learning that a card landed, and the half that works on an install with no
 * webhook secret: `status` goes pending → linked, and `user_id` is set once it is linked. Read by
 * the session's `id`, never by the token inside its url.
 */
export async function readVaultSession(sessionId, { fetchImpl = fetch } = {}) {
  if (!isConfigured()) return notConfigured();
  const tok = await getAccessToken({ fetchImpl });
  if (!tok.ok) return tok;
  const got = await request(`/api/v2/vault_sessions/${encodeURIComponent(sessionId)}`, { token: tok.token, fetchImpl });
  if (!got.ok) return { ok: false, error: `Could not read that vault session: ${got.error}`, code: got.code ?? "" };
  const b = got.body ?? {};
  return { ok: true, id: b.id ?? sessionId, status: b.status ?? "", user_id: b.user_id ?? "", expires_at: b.expires_at ?? "" };
}

/**
 * What this person already has in the vault — display fields only, newest first.
 *
 * Two different answers mean the same next step and are deliberately reported the same way: an empty
 * list is a vault with nothing in it, and a 404 (`connection_not_found`) is somebody this
 * organization has never enrolled. Both are `enrolled: false`, because both are answered by sending
 * a vault link. Everything else is a real error and says so rather than quietly reading as "no card".
 */
export async function checkStoredCards(userId, { fetchImpl = fetch } = {}) {
  if (!isConfigured()) return notConfigured();
  if (!userId) return { ok: true, enrolled: false, cards: [], why: "no AgentCard user id saved for this person yet" };
  const tok = await getAccessToken({ fetchImpl });
  if (!tok.ok) return tok;
  const got = await request("/api/v2/vault_cards", { token: tok.token, query: { user_id: userId }, fetchImpl });
  if (!got.ok) {
    if (got.httpStatus === 404) return { ok: true, enrolled: false, cards: [], why: "AgentCard has no vault for that user id" };
    return { ok: false, error: `Could not read their stored cards: ${got.error}`, code: got.code ?? "" };
  }
  const cards = (got.body?.data ?? []).map(c => ({
    id: c.id ?? "",
    brand: c.brand ?? "",
    last4: c.last4 ?? "",
    expires: c.expiry_month && c.expiry_year ? `${String(c.expiry_month).padStart(2, "0")}/${c.expiry_year}` : "",
    stored_at: c.created_at ?? "",
  }));
  return { ok: true, enrolled: cards.length > 0, cards };
}

/** How a card reads to a person: "Visa ••••4832". Never anything a card could be used from. */
export function cardLabel(card) {
  if (!card) return "their card";
  const brand = card.brand ? card.brand.replace(/^./, s => s.toUpperCase()) : "card";
  return card.last4 ? `${brand} ••••${card.last4}` : brand;
}

// ---------- buying ----------

/**
 * A finished vault link, turned into that one person's own tokens.
 *
 * This is how somebody becomes buyable-for, and it is the ONLY way: /buy runs as a single person and
 * refuses an organization token, so every call below goes out on the pair this returns.
 *
 * Deliberately not the cardholder route (`POST /api/v1/cardholders/{id}/buy_token`). That endpoint is
 * real and it works, but cardholders are AgentCard's card-ISSUING product and live in a different id
 * space from vault users: a `usr_…` is a 404 there and a `ch_…` is `connection_not_found` at
 * `vault_cards`. There is no documented lookup from one to the other, so using it would mean listing
 * every cardholder the organization owns and minting tokens until one matched — which across several
 * people is a way to pay with the WRONG person's card. One exchange per person, tied to the session
 * their own link created, cannot confuse two people.
 *
 * SINGLE USE. A second exchange of the same session is refused `410 already_exchanged`, and the
 * `vault.session_linked` and `vault.card_stored` events race to be the one that calls it — so the
 * caller must claim the session before calling and treat `already_exchanged` as "somebody else won",
 * not as an error worth showing anybody.
 */
export async function exchangeVaultSession(sessionId, { fetchImpl = fetch } = {}) {
  if (!isConfigured()) return notConfigured();
  if (!sessionId) return { ok: false, error: "No vault session to exchange." };
  const tok = await getAccessToken({ fetchImpl });
  if (!tok.ok) return tok;
  const got = await request(`/api/v2/vault_sessions/${encodeURIComponent(sessionId)}/exchange`, {
    method: "POST", token: tok.token, json: {}, fetchImpl,
  });
  if (!got.ok) {
    // Both of these are ordinary states rather than faults, and each has its own next step: one is
    // already done, the other needs the person to prove the account is theirs.
    if (got.httpStatus === 410 || got.code === "already_exchanged") {
      return { ok: false, alreadyExchanged: true, error: "That vault link was already exchanged for this person's tokens." };
    }
    if (got.httpStatus === 403 || got.code === "account_verification_required") {
      return {
        ok: false, needsVerification: true,
        error: "They signed in to an AgentCard account that already existed, so the link alone does not prove it is theirs."
          + " AgentCard has to send them a code before their card can be used.",
      };
    }
    return { ok: false, error: `AgentCard would not connect that vault link: ${got.error}`, code: got.code ?? "" };
  }
  return readConnection(got.body);
}

/**
 * A fresh access token from the refresh token, before the old one dies mid-purchase.
 *
 * A turn against a live merchant takes twenty seconds or more, so a token with a minute left is a
 * token that can expire in flight. Callers rotate on that minute rather than on expiry.
 *
 * The answer is a token pair and nothing else — AgentCard's ConnectionRefreshed schema
 * (openapi.json, read 2026-10-24) has no `user`, unlike the exchange — and each refresh INVALIDATES
 * the refresh token it was given. So `userId` is the id the caller already holds, and the pair is
 * kept against it. Until 2026-10-24 a pair with no user on it was refused here as "a token with no
 * user id on it": every refresh spent the stored refresh token and threw the new pair away, so a
 * connection died an hour after it was made and could not come back without a new vault link.
 */
export async function refreshConnection(refreshToken, { userId = "", fetchImpl = fetch } = {}) {
  if (!isConfigured()) return notConfigured();
  if (!refreshToken) return { ok: false, error: "No refresh token for this person." };
  const tok = await getAccessToken({ fetchImpl });
  // The organization token failing is this install's problem, not theirs: their refresh token was
  // never sent, so it is still good and the connection is not dead.
  if (!tok.ok) return { ...tok, transient: true };
  const got = await request("/api/v2/connect/refresh", {
    method: "POST", token: tok.token, json: { refresh_token: refreshToken }, fetchImpl,
  });
  if (!got.ok) {
    return {
      ok: false, error: `AgentCard would not refresh their connection: ${got.error}`, code: got.code ?? "",
      httpStatus: got.httpStatus ?? 0,
      // Only AgentCard saying no to THIS refresh token means the connection is gone. A timeout, a
      // dropped connection, a 5xx or a 429 says nothing about the token, and treating one as dead
      // is how a network blip used to send the owner a reconnect link (2026-10-24).
      ...(refreshRefused(got) ? { refused: true } : { transient: true }),
    };
  }
  const read = readConnection(got.body, { userId });
  // A 200 that rotated the refresh token but is missing something else still carries the only
  // refresh token that works now. It is handed back so the caller can keep it: never discard it.
  if (!read.ok && got.body?.refresh_token) return { ...read, refreshToken: got.body.refresh_token };
  return read;
}

/**
 * Did AgentCard refuse the refresh token itself? A 4xx other than 408/429 does (`invalid_grant`,
 * `connection_not_found`, revoked); a 401 that names the organization token does not, because the
 * user's token was never judged.
 */
export function refreshRefused(got = {}) {
  if (got.timedOut || got.unreachable) return false;
  const s = Number(got.httpStatus ?? 0);
  if (!(s >= 400 && s < 500) || s === 408 || s === 429) return false;
  if (s === 401 && /organi[sz]ation|client|platform/i.test(`${got.code ?? ""} ${got.error ?? ""}`) && !/refresh/i.test(`${got.code ?? ""} ${got.error ?? ""}`)) return false;
  return true;
}

/**
 * When a token AgentCard just handed over really dies, as an epoch ms with slack taken off.
 *
 * `expires_in` is seconds (a number or a numeric string); an absolute `expires_at` (ISO or epoch
 * seconds/ms) is accepted too. With neither, an hour, which is what AgentCard issues. The slack is a
 * minute, or a tenth of the life of a short-lived token — a flat minute off a 45-second token would
 * write an expiry already in the past and every call would refresh.
 */
export function expiryFrom(body = {}, now = clock.now()) {
  let lifeMs = 0;
  const ttl = Number(body?.expires_in);
  if (Number.isFinite(ttl) && ttl > 0) lifeMs = ttl * 1000;
  else if (body?.expires_at !== undefined && body?.expires_at !== null && body?.expires_at !== "") {
    const raw = body.expires_at;
    const n = Number(raw);
    const at = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(String(raw));
    if (Number.isFinite(at) && at > now) lifeMs = at - now;
  }
  if (!lifeMs) lifeMs = 3600_000;
  return now + lifeMs - Math.min(60_000, Math.floor(lifeMs / 10));
}

/**
 * One connection response → the four fields worth keeping.
 *
 * `user_id` is read from `user.id` with a flat `user_id` accepted too. A refresh answers with no user
 * at all (see refreshConnection), so the id the caller already holds is the fallback; with neither,
 * a token pair belongs to nobody and is refused.
 */
function readConnection(body = {}, { userId: known = "" } = {}) {
  const b = body ?? {};
  const accessToken = b.access_token ?? "";
  const userId = b.user?.id || b.user_id || known || "";
  if (!accessToken) return { ok: false, error: "AgentCard returned no access token for that person." };
  if (!userId) return { ok: false, error: "AgentCard returned a token with no user id on it." };
  return {
    ok: true,
    userId,
    accessToken,
    refreshToken: b.refresh_token ?? "",
    // Slack off, and an hour's assumption when AgentCard says nothing (see expiryFrom): short is
    // harmless, outliving the real token is not.
    expiresAt: expiryFrom(b),
  };
}

/**
 * One turn of a purchase: say what is wanted, in plain words, and read what came back.
 *
 * `conversationId` is AgentCard's own and ties the turns together; left out, this starts a new one.
 * `deliveryAddress` has to go on EVERY call of a conversation including the first — a cart is bound
 * to the address that was set when it was shown, and one sent late makes the cart unconfirmable
 * (`delivery_address_bound_after_cart`). So it is passed straight through on every turn rather than
 * remembered here.
 *
 * Nothing can be charged by this call. The whole of the money is in buyConfirm below.
 */
export async function buyConversation(userToken, ask, { conversationId = "", deliveryAddress = null, productId = "", fetchImpl = fetch } = {}) {
  if (!userToken) return { ok: false, error: "No buy token, so nothing can be asked for." };
  const got = await request("/buy", {
    method: "POST",
    token: userToken,
    json: {
      ask,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(deliveryAddress ? { delivery_address: deliveryAddress } : {}),
      // The exact product the person picked from a search AgentCard showed, by AgentCard's own id
      // (docs: BuyRequest.pick, "goes with an ask, never with confirm"). Without it AgentCard
      // searches again from the words, which is how a different product ends up in the cart.
      ...(productId ? { pick: { product_id: productId } } : {}),
    },
    fetchImpl,
  });
  // A 400 on the address is refused before any turn runs, and it names the problem — worth keeping
  // as its own shape so the tool can say which field rather than "it failed".
  if (!got.ok) {
    return {
      ok: false, code: got.code ?? "", httpStatus: got.httpStatus ?? 0,
      timedOut: !!got.timedOut, unreachable: !!got.unreachable,
      error: got.error, body: got.body ?? {},
    };
  }
  return { ok: true, ...readTurn(got.body) };
}

/**
 * Confirm one cart, at one price, and pay for it.
 *
 * The hash is the agreement: a free-form yes is not accepted by AgentCard and must not be sent, and
 * the hash that is sent is the hash of the cart the person was shown. `payment_source: "vault"` is
 * what says to pay with their own stored card.
 *
 * This is the call that can spend money. Everything the caller has to do before it — the gate, the
 * caps, the ledger — is in src/tools.js, where the person and their limits are.
 */
export async function buyConfirm(userToken, conversationId, cartHash, paymentSource = "vault", { deliveryAddress = null, fetchImpl = fetch } = {}) {
  if (!userToken) return { ok: false, error: "No buy token, so nothing can be confirmed." };
  if (!conversationId || !cartHash) return { ok: false, error: "A confirm needs both the conversation and the exact cart hash." };
  const got = await request("/buy", {
    method: "POST",
    token: userToken,
    json: {
      conversation_id: conversationId,
      confirm: cartHash,
      payment_source: paymentSource,
      ...(deliveryAddress ? { delivery_address: deliveryAddress } : {}),
    },
    fetchImpl,
  });
  if (!got.ok) {
    return {
      ok: false, code: got.code ?? "", httpStatus: got.httpStatus ?? 0,
      timedOut: !!got.timedOut, unreachable: !!got.unreachable,
      error: got.error, body: got.body ?? {},
      // A 409 is a refusal with a fresh cart on it: the price drifted, or the address did. The new
      // cart is read out the same way as any other so the caller can show the new total.
      ...(got.httpStatus === 409 ? readTurn(got.body) : {}),
    };
  }
  return { ok: true, ...readTurn(got.body) };
}

/**
 * One order, read on its own: GET /buy/orders/{order_id}, on the person's connection token.
 *
 * AgentCard support named this on 2026-10-24 as the order read that replaces the retired
 * GET /buy/v1/merchants/retail/orders/{id}/track (410 `endpoint_retired`). It is NOT in the public
 * docs: docs.agentcard.com (read 2026-10-24) has no page for it and openapi.json no path, and the URL
 * support linked (/api-reference/purchases/overview) now redirects to the Commerce SDK overview. So
 * the fields read are the ones support named — `status`, `status_updated_at`, `estimated_arrival`,
 * `tracking` and `placed_at` — plus `canceled_reason` and `status_detail` (order.updated's names)
 * when they are there. Its `status` is the order's own and wins over the conversation's copy.
 * Sends nothing and cannot place anything.
 */
export async function readOrder(userToken, orderId, { fetchImpl = fetch } = {}) {
  if (!userToken) return { ok: false, error: "No buy token, so nothing can be read." };
  if (!orderId) return { ok: false, error: "No order id to read." };
  const got = await request(`/buy/orders/${encodeURIComponent(orderId)}`, { token: userToken, fetchImpl });
  if (!got.ok) {
    return { ok: false, error: `Could not read that order: ${got.error}`, code: got.code ?? "", httpStatus: got.httpStatus ?? 0, timedOut: !!got.timedOut, unreachable: !!got.unreachable };
  }
  const b = got.body ?? {};
  const str = (v) => (v == null ? "" : String(v));
  const eta = b.estimated_arrival && typeof b.estimated_arrival === "object"
    ? { earliest: str(b.estimated_arrival.earliest), latest: str(b.estimated_arrival.latest) }
    : null;
  return {
    ok: true,
    // The record exactly as it came. A flight order's ticketing fields have never been seen; this is
    // what src/flightbook.js keeps whole on the row so the first live booking shows them.
    raw: b,
    order: {
      order_id: str(b.order_id) || orderId,
      status: str(b.status),
      status_updated_at: str(b.status_updated_at),
      estimated_arrival: eta && (eta.earliest || eta.latest) ? eta : null,
      // Whatever AgentCard put there (a carrier and number, a link), kept as sent; null when none.
      tracking: b.tracking ?? null,
      placed_at: str(b.placed_at),
      canceled_reason: str(b.canceled_reason),
      status_detail: str(b.status_detail),
      ...(b.retailer_order_id ? { retailer_order_id: str(b.retailer_order_id) } : {}),
      ...(b.delivery_window ? { delivery_window: str(b.delivery_window) } : {}),
      ...(b.merchant_name || b.merchant ? { merchant_name: str(b.merchant_name || b.merchant) } : {}),
      ...(b.total_cents != null ? { total_cents: Number(b.total_cents) } : {}),
    },
  };
}

/**
 * AgentCard's record of one order, from both places it lives, as ONE conversation-shaped read.
 *
 * GET /buy/orders/{id} (readOrder) is the order's own record, and its `status` wins. The purchase
 * conversation (GET /buy/conversations/{id}, `orders[]`) is the fallback when that read fails, and is
 * where `retailer_order_id` and `delivery_window` come from. The conversation's `last_checkout` is
 * never an order's status — it is a stale snapshot of the last checkout attempt (AgentCard support,
 * 2026-10-24) — and reconcileLine does not read it once any order exists.
 *
 * `read` has readConversation's shape with the order's own record laid over its `orders[]` entry, so
 * everything downstream (reconcileLine, the row) reads one thing. `via` says which read the status
 * came from. Sends nothing.
 */
export async function readOrderRecord(userToken, orderId, { conversationId = "", fetchImpl = fetch } = {}) {
  if (!userToken) return { ok: false, error: "No buy token, so nothing can be read." };
  const own = orderId ? await readOrder(userToken, orderId, { fetchImpl }) : { ok: false, error: "no order id" };
  const conv = conversationId
    ? await readConversation(userToken, conversationId, { fetchImpl })
    : { ok: false, error: "No purchase conversation to read that order from." };
  if (!own.ok && !conv.ok) return { ...conv, order_read_error: orderId ? own.error : "" };
  let read;
  if (conv.ok) {
    let listed = false;
    const orders = conv.orders.map(o => {
      if (!own.ok || o.order_id !== orderId) return o;
      listed = true;
      return mergeOrder(o, own.order);
    });
    if (own.ok && !listed) orders.push(mergeOrder(null, own.order));
    read = { ...conv, orders };
  } else {
    // Only the order's own record answered. It is an order, so nothing here needs the checkout.
    read = { ok: true, conversation_id: conversationId, status: "", turn_in_progress: false, last_checkout: null, orders: [mergeOrder(null, own.order)], carts: [] };
  }
  if (own.ok) read = { ...read, order_raw: own.raw ?? null };
  return { ok: true, read, via: own.ok ? "order" : "conversation", order_read_error: own.ok || !orderId ? "" : own.error };
}

/** An order's own record laid over the conversation's entry for it: each non-empty field it has wins. */
function mergeOrder(listed, own) {
  const out = { ...(listed ?? {
    order_id: own.order_id, status: "", merchant_name: "", total_cents: null, placed_at: "",
    retailer_order_id: "", delivery_window: "", confirmed_at: "", payment_source: null,
  }) };
  for (const [k, v] of Object.entries(own)) {
    if (v !== "" && v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Where a placed order is: the shop's own order number, the delivery window, and AgentCard's status
 * for it — readOrderRecord, as the fields a person is told.
 *
 * Until 2026-10-24 this was GET /buy/v1/merchants/retail/orders/{id}/track, which AgentCard retired
 * (410 `endpoint_retired`). The order's own record (GET /buy/orders/{id}) is read first and the
 * purchase conversation's `orders[]` second: the shop's number and window are on the conversation.
 *
 * `read` is the merged record, handed back so a caller reconciling the row does not read it twice. A
 * field the record leaves null comes back "" and is the caller's to say is missing.
 */
export async function trackOrder(userToken, orderId, { conversationId = "", fetchImpl = fetch } = {}) {
  if (!userToken) return { ok: false, error: "No buy token, so nothing can be tracked." };
  if (!conversationId && !orderId) return { ok: false, error: "No order and no purchase conversation to read." };
  const rec = await readOrderRecord(userToken, orderId, { conversationId, fetchImpl });
  if (!rec.ok) return { ...rec, read: rec };
  const read = rec.read;
  const order = orderId ? read.orders.find(o => o.order_id === orderId) : (read.orders.at(-1) ?? null);
  if (!order) return { ok: true, found: false, order: null, read, via: rec.via };
  return { ok: true, found: true, order, read, via: rec.via, ...orderView(order) };
}

/**
 * What AgentCard calls an order that is not coming. Its docs spell it `canceled` (order.updated); the
 * live record on 2026-10-24 said `cancelled`. `failed` and `refunded` end an order the same way.
 */
export const CANCELLED_ORDER = new Set(["cancelled", "canceled", "failed", "refunded"]);

export function orderCancelled(status) {
  return CANCELLED_ORDER.has(String(status ?? "").trim().toLowerCase());
}

/** One order from a conversation read, as the fields a person is told. "" for anything not on it. */
export function orderView(order) {
  if (!order) return null;
  return {
    status: order.status || "",
    cancelled: orderCancelled(order.status),
    order_number: order.retailer_order_id || "",
    delivery_window: order.delivery_window || "",
    total: order.total_cents == null ? "" : money(order.total_cents),
    placed_at: order.placed_at || "",
    confirmed_at: order.confirmed_at || "",
    card: order.payment_source ? cardLabel(order.payment_source) : "",
    estimated_arrival: arrivalLine(order.estimated_arrival),
    tracking: order.tracking ?? null,
    status_updated_at: order.status_updated_at || "",
    cancel_reason: order.canceled_reason || "",
    cancel_detail: order.status_detail || "",
  };
}

/** An arrival window as one line, from the ISO pair AgentCard sends. "" when there is none. */
function arrivalLine(eta) {
  if (!eta || (!eta.earliest && !eta.latest)) return "";
  const fmt = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString("en-US", { timeZone: config.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  if (eta.earliest && eta.latest && eta.earliest !== eta.latest) return `${fmt(eta.earliest)} – ${fmt(eta.latest)}`;
  return fmt(eta.earliest || eta.latest);
}

/**
 * Why an order was cancelled, in plain words.
 *
 * `canceled_reason` is AgentCard's code for it (order.updated: "the merchant's reason when it gives
 * one"); `status_detail` is the merchant's own line, "ready to show as is". A known code is said in
 * Reason's words, then the merchant's line as written, then "no reason given". `fix` names what the
 * person can put right — for an address the store could not use, the address — and the caller offers
 * that. Putting it right is a NEW purchase: a new cart, and a new yes before anything is bought.
 */
export const CANCEL_REASONS = {
  // Walmart order e66d7f2b…, 2026-10-24: "canceled_reason": "invalid_shipping_address",
  // "status_detail": "The store could not use this shipping address."
  invalid_shipping_address: { words: "the store couldn't use the shipping address", fix: "address" },
};

export function cancelReason({ code = "", detail = "" } = {}) {
  const c = String(code ?? "").trim();
  const d = String(detail ?? "").trim().replace(/[.\s]+$/, "");
  const known = CANCEL_REASONS[c];
  if (known) return { code: c, words: known.words, fix: known.fix, given: true };
  if (d) return { code: c, words: d, fix: "", given: true };
  return { code: c, words: "no reason given", fix: "", given: false };
}

/**
 * Where one purchase conversation stands, read rather than re-sent: GET /buy/conversations/{id}.
 *
 * This is the read AgentCard's docs say to make after a confirm whose answer never came back
 * ("whether the turn ran is then unknown, so read the conversation before you call again") and the
 * one that answers a charge_status of "unknown". It sends nothing and cannot place anything. The
 * orders it lists are what a reconcile is keyed on, by order_id.
 */
export async function readConversation(userToken, conversationId, { fetchImpl = fetch } = {}) {
  if (!userToken) return { ok: false, error: "No buy token, so nothing can be read." };
  if (!conversationId) return { ok: false, error: "No conversation to read." };
  const got = await request(`/buy/conversations/${encodeURIComponent(conversationId)}`, { token: userToken, fetchImpl });
  if (!got.ok) {
    return { ok: false, error: `Could not read that purchase: ${got.error}`, code: got.code ?? "", httpStatus: got.httpStatus ?? 0, timedOut: !!got.timedOut, unreachable: !!got.unreachable };
  }
  const b = got.body ?? {};
  const lc = b.last_checkout && typeof b.last_checkout === "object" ? b.last_checkout : null;
  return {
    ok: true,
    conversation_id: b.conversation_id ?? conversationId,
    status: b.status ?? "",
    turn_in_progress: !!b.turn_in_progress,
    last_checkout: lc ? {
      status: lc.status ?? "", order_id: lc.order_id ?? "", decline_code: lc.decline_code ?? "",
      code: lc.code ?? "", approval_in_progress: !!lc.approval_in_progress, charge_status: lc.charge_status ?? "",
      total_cents: lc.total_cents == null ? null : Number(lc.total_cents), at: lc.at ?? "",
    } : null,
    orders: (Array.isArray(b.orders) ? b.orders : []).map(o => ({
      order_id: o.order_id ?? "", status: o.status ?? "", merchant_name: o.merchant_name ?? o.merchant ?? "",
      total_cents: o.total_cents == null ? null : Number(o.total_cents), placed_at: o.placed_at ?? "",
      // Not in the SDK's documented BuyOrder, but on the real record (2026-10-24), under the names
      // order.confirmed uses. Null until the shop confirms; kept as "" so a null is never read as a value.
      retailer_order_id: o.retailer_order_id ?? "", delivery_window: o.delivery_window ?? "", confirmed_at: o.confirmed_at ?? "",
      payment_source: o.payment_source && typeof o.payment_source === "object"
        ? { source: o.payment_source.source ?? "", brand: o.payment_source.brand ?? "", last4: o.payment_source.last4 ?? "" }
        : null,
    })),
    carts: Array.isArray(b.carts) ? b.carts.map(readCart).filter(Boolean) : [],
  };
}

/**
 * The words a conversation read uses for a checkout that was refused. The docs say "declined"; the
 * real sandbox answered "denied" (GET /buy/conversations, last_checkout.status, 2026-10-23) for a
 * sandbox_mode refusal. Both mean the same thing here.
 */
export const DECLINED_CHECKOUT = new Set(["declined", "denied"]);

/** Decline codes that are a pause for the person's passkey, not a refusal. */
const APPROVAL_PAUSES = new Set(["vault_approval_required", "byoc_approval_required"]);

/**
 * What a conversation read says about one order, in plain terms. Keyed on order_id when there is
 * one; with none, on the last checkout. Every field it cannot see is said to be unknown — this is
 * the answer to "did it go through?", and a guess there is how somebody pays twice.
 */
export function reconcileLine(read, orderId = "") {
  if (!read?.ok) return { known: false, placed: null, line: `AgentCard could not be read either (${read?.error ?? "no answer"}), so whether it was placed is still unknown.` };
  const order = orderId ? read.orders.find(o => o.order_id === orderId) : (read.orders.at(-1) ?? null);
  if (order && orderCancelled(order.status)) {
    // Placed once and then called off. Never "placed": nothing is coming, and that is the news.
    const why = cancelReason({ code: order.canceled_reason, detail: order.status_detail });
    return {
      known: true, placed: false, cancelled: true, order,
      line: `AgentCard lists order ${order.order_id || "(no id)"}${order.merchant_name ? ` at ${order.merchant_name}` : ""} as '${order.status}'`
        + ` — it was cancelled and is not coming. ${why.given ? `Reason: ${why.words}.` : "AgentCard gave no reason."} Any hold on the card should drop off by itself.`,
    };
  }
  if (order) {
    return {
      known: true, placed: true, order,
      line: `AgentCard lists order ${order.order_id || "(no id)"}${order.merchant_name ? ` at ${order.merchant_name}` : ""}`
        + `${order.status ? `, status '${order.status}'` : ""}${order.total_cents != null ? `, ${money(order.total_cents)}` : ""}.`
        + ` Whether the card has actually been charged is not in that read.`,
    };
  }
  if (read.turn_in_progress) return { known: false, placed: null, line: "AgentCard is still working on that confirm, so it is not known yet whether an order was placed." };
  // `last_checkout` is a stale snapshot of the last checkout attempt, never an order's status
  // (AgentCard support, 2026-10-24). Once the conversation lists any order it is not read at all —
  // its charge_status included — so a "confirming" there can never outvote an order's own record.
  const lc = read.orders.length ? null : read.last_checkout;
  if (lc && (lc.decline_code || DECLINED_CHECKOUT.has(lc.status))) {
    // Definite only when every part of it says so: the turn is over (above), no order is listed
    // (above), the last checkout carries a decline code that is a refusal rather than a passkey
    // pause, it has no order id, no approval is still running, and AgentCard does not call the
    // charge unknown. Only that settles an unknown outcome to declined (reconcilePurchase in
    // src/tools.js); anything short of it stays unknown, because a guess there is how somebody pays twice.
    const definite = !!lc.decline_code && !APPROVAL_PAUSES.has(lc.decline_code) && !lc.order_id
      && !lc.approval_in_progress && lc.charge_status !== "unknown";
    return {
      known: true, placed: false,
      ...(definite ? { declined: true, decline_code: lc.decline_code, charge_status: lc.charge_status || "" } : {}),
      line: `AgentCard lists no order, and its last checkout was declined (${lc.decline_code || lc.code || "no code"}).`,
    };
  }
  return { known: false, placed: null, line: `AgentCard lists no order on that purchase${lc?.status ? ` and its last checkout reads '${lc.status}'` : ""}. That is not proof nothing was charged.` };
}

/**
 * One /buy response, as the fields worth branching on.
 *
 * `status`, `cart.hash`, `decline_code`, `approval_url`, `charge_status` and `order_id` are the
 * contract; `reply` is prose for the person and nothing here decides anything from it. The cart is
 * normalised into money as well as cents, because the number that gets said to somebody out loud
 * should be formatted in one place rather than in every caller.
 */
/**
 * The checkout authorization an approval link is for: the `id` on
 * https://vault.agentcard.sh/authorize?id=cauth_..., which is the `authorization_id` every
 * checkout_authorization.* webhook carries. "" when there is none.
 */
export function authorizationIdFrom(url) {
  try { return new URL(String(url ?? "")).searchParams.get("id") ?? ""; } catch { return ""; }
}

export function readTurn(body = {}) {
  const b = body ?? {};
  return {
    conversation_id: b.conversation_id ?? "",
    status: b.status ?? "",
    reply: b.reply ?? "",
    cart: readCart(b.cart),
    carts: Array.isArray(b.carts) ? b.carts.map(readCart).filter(Boolean) : [],
    catalog: readCatalog(b.catalog),
    unmatched: Array.isArray(b.unmatched) ? b.unmatched : [],
    decline_code: b.decline_code ?? "",
    approval_url: b.approval_url ?? "",
    approval_in_progress: !!b.approval_in_progress,
    error_code: b.error_code ?? "",
    pick: b.pick && typeof b.pick === "object" ? { product_id: b.pick.product_id ?? "", ref: b.pick.ref ?? "", in_cart: !!b.pick.in_cart } : null,
    charge_status: b.charge_status ?? "",
    order_id: b.order_id ?? "",
    authorization_id: b.authorization_id || authorizationIdFrom(b.approval_url),
    payment_source: b.payment_source ?? null,
    // When the approval link stops working (an ISO time; docs: "about 15 minutes"), and the one step
    // AgentCard waits on next (`guest_details` for a flight's passenger, `confirm`, `approve`…). Both
    // were on the real answers all along (sandbox, 2026-10-25) and nothing read them until flights.
    approval_expires_at: b.approval_expires_at ?? "",
    next_action: b.next_action ?? "",
  };
}

function readCart(cart) {
  if (!cart || typeof cart !== "object") return null;
  const total = Number(cart.totalCents ?? 0);
  return {
    merchant: cart.merchant ?? "",
    merchant_name: cart.merchant_name ?? "",
    items: (cart.items ?? []).map(i => ({
      name: i.name ?? "",
      qty: Number(i.qty ?? 1),
      price_cents: Number(i.priceCents ?? 0),
      price: money(Number(i.priceCents ?? 0)),
      link: i.product_id ?? "",
      // The three ids AgentCard puts on a cart line (docs: BuyCartLine). A picked offer is matched
      // against these and nothing else — never against the line's name.
      product_id: i.product_id ?? "",
      ref: i.ref ?? "",
      url: i.url ?? "",
    })),
    fee_lines: Array.isArray(cart.merchantFeeLines)
      ? cart.merchantFeeLines.map(f => ({ label: String(f.label ?? ""), amount_cents: Number(f.amountCents ?? 0), amount: money(Number(f.amountCents ?? 0)) }))
      : [],
    total_is_estimate: !!cart.totalIsEstimate,
    // Whether AgentCard sent the estimate flag at all. A real flight cart (sandbox, 2026-10-25) has no
    // `totalIsEstimate` key; "not flagged" is not the same as "final", so src/flightbook.js keeps them apart.
    estimate_flag_sent: Object.hasOwn(cart, "totalIsEstimate"),
    subtotal_cents: cart.subtotalCents == null ? null : Number(cart.subtotalCents),
    ceiling_cents: cart.approvedCeilingCents == null ? null : Number(cart.approvedCeilingCents),
    currency: cart.currency ?? "",
    service_fees_cents: Number(cart.serviceFeesCents ?? 0),
    tip_cents: Number(cart.tipCents ?? 0),
    total_cents: total,
    total: money(total),
    hash: cart.hash ?? "",
  };
}

function readCatalog(catalog) {
  if (!catalog || typeof catalog !== "object") return null;
  return {
    merchant: catalog.merchant ?? "",
    merchant_name: catalog.merchant_name ?? catalog.merchant ?? "",
    as_of: catalog.as_of ?? "",
    items: (catalog.items ?? []).map(i => ({
      name: i.name ?? "",
      price_cents: Number(i.priceCents ?? 0),
      price: money(Number(i.priceCents ?? 0)),
      link: i.id ?? "",
      product_id: i.ref || i.id || "",
      url: i.url ?? (/^https?:/i.test(String(i.id ?? "")) ? i.id : ""),
      image_url: i.image_url ?? "",
      // A flight option's itinerary (docs: BuyFlightItinerary): legs of origin, destination and the
      // wall-clock departure and arrival. Only on a flight; no flight numbers are sent.
      ...(i.flight && Array.isArray(i.flight.legs) ? { flight: {
        fare_cabin_class: i.flight.fareCabinClass ?? null,
        legs: i.flight.legs.map(l => ({
          origin: l?.origin ?? "", destination: l?.destination ?? "",
          departureAt: l?.departureAt ?? "", arrivalAt: l?.arrivalAt ?? "",
          cabinClasses: Array.isArray(l?.cabinClasses) ? l.cabinClasses : [],
        })),
      } } : {}),
    })),
  };
}

const money = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

/** One line naming the merchant, what is in the cart and the total — what a yes is pinned to. */
export function cartLine(cart) {
  if (!cart) return "";
  const what = cart.items.length
    ? cart.items.map(i => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)).join(", ")
    : "an empty cart";
  return `${cart.merchant_name || cart.merchant || "a shop"}: ${what} (${cart.total})`;
}

/**
 * What a decline code means, in the words to say it in.
 *
 * `vault_approval_required` is deliberately not in here: it is a pause rather than a decline and is
 * handled on its own, before anything reads this map. `sandbox_mode` is the one every test-mode
 * install will see, and reading it as "the card was refused" would send somebody to their bank over
 * a credential setting.
 */
export const DECLINE_REASONS = {
  // byoc_approval_required / vault_approval_required are pauses, handled before this map is read.
  sandbox_mode: "this install is on AgentCard's sandbox credentials, and a sandbox card cannot pay a real shop."
    + " Everything up to the confirm was real — the cart and the total are what a live run would have charged."
    + " Nothing was charged and nothing was ordered.",
  // The Commerce SDK quickstart (docs.agentcard.com, read 2026-10-23) names this one for the
  // sandbox's last answer; sandbox_mode is the older name. Same meaning, same words.
  sandbox_unavailable: "this install is on AgentCard's sandbox credentials, which run everything up to the confirm and stop before payment."
    + " Nothing was charged and nothing was ordered.",
  items_unavailable: "the shop no longer has what was in the cart.",
  unsupported_currency: "the shop wanted a currency AgentCard cannot pay in.",
  currency_changed: "the price changed currency between the cart and the confirm.",
  no_cart: "there was no cart to confirm — the conversation has to get back to a cart first.",
  // AgentCard support, 2026-10-24: the ORG — this install's AgentCard account — has not set up how it
  // pays AgentCard's 1% commerce fee (Commerce SDK → Balance). A setup problem on Reason's side. It is
  // not the person's card, not the shop, and has nothing to do with any plan or free-order quota of
  // theirs (#96 read it as "your one free order has been used"; that was wrong).
  commerce_billing_required: "this is a setup problem on Reason's side, not the card or the shop: Reason's AgentCard account isn't set up yet to pay AgentCard's commerce fee, so AgentCard won't place orders through it."
    + " Nothing was charged and nothing was ordered.",
};

export function declineLine(code) {
  const c = String(code ?? "").trim();
  // An unknown code is said as what it is — a decline — and nothing is guessed about why.
  return DECLINE_REASONS[c] || `AgentCard declined it${c ? ` (${c})` : ""}.`;
}

/** True when a refusal is the commerce-fee billing setup on Reason's side (see DECLINE_REASONS). */
export function billingSetupRequired(code) {
  return String(code ?? "").trim() === "commerce_billing_required";
}

/**
 * The code(s) AgentCard sends when a user's free plan has used its one lifetime order. NOT KNOWN YET —
 * waiting for AgentCard to confirm it. The docs name the quota (get_plan's `ordersPlaced` and
 * `maxLifetimeOrders`) but give the refusal no code. #96 took `commerce_billing_required` for it;
 * AgentCard support said on 2026-10-24 that code is the org's commerce-fee billing setup, so it is in
 * DECLINE_REASONS instead. Until AgentCard names the real code this stays empty, nothing is ever read
 * as the free-order quota, and an unknown code gets declineLine's neutral "declined" line.
 */
export const FREE_ORDER_QUOTA_CODES = [];

// ---------- webhooks ----------

/**
 * Is this delivery really AgentCard's?
 *
 * HMAC-SHA256 over `${t}.${rawBody}` under the endpoint's secret, compared in constant time, with
 * the timestamp refused once it is older than the replay window. The raw bytes are what is signed,
 * so this takes the body as it arrived and never a re-serialised object.
 *
 * Fails closed with no secret, like every other inbound hook here (src/channels/sendblue.js): a
 * route that marks a purchase approved is not one to leave open on an install that cannot prove who
 * is calling it.
 */
export function verifyWebhook({ rawBody, headers = {}, now = clock.now() }) {
  if (!config.agentcardWebhookSecret) return { ok: false, why: "no AGENTCARD_WEBHOOK_SECRET on this machine" };
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const header = String(lower["agentcard-signature"] ?? "");
  if (!header) return { ok: false, why: "no AgentCard-Signature header" };

  const parts = Object.fromEntries(header.split(",").map(p => {
    const i = p.indexOf("=");
    return i === -1 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const t = parts.t ?? "";
  const v1 = parts.v1 ?? "";
  if (!t || !v1) return { ok: false, why: "the signature header has no t or v1 in it" };
  if (!/^\d+$/.test(t)) return { ok: false, why: "the signature timestamp is not a number" };

  // Seconds, per the docs' own example. Older than the window is refused so a delivery somebody
  // kept cannot be replayed into a second purchase row.
  const ageMs = Math.abs(now - Number(t) * 1000);
  if (ageMs > config.agentcardWebhookSkewMs) {
    return { ok: false, why: `the signature is ${Math.round(ageMs / 60_000)} minutes out of date` };
  }

  const expected = createHmac("sha256", config.agentcardWebhookSecret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, why: "the signature did not match" };
  return { ok: true };
}

/** The envelope, as the fields this install acts on. `type` is stable and is what everything branches on. */
export function readEvent(body = {}) {
  const b = body ?? {};
  return {
    id: b.id ?? "",
    type: b.type ?? "",
    created: Number(b.created ?? 0),
    livemode: !!b.livemode,
    data: b.data ?? {},
  };
}
