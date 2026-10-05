// The listener inbound webhooks arrive on. node:http, no framework — there are three routes and
// a framework would be more code than the thing it wraps.
//
//   GET  /health                      is it up, and what is it actually running
//   POST /channels/{name}/webhook     one provider delivery, verified and parsed by that adapter
//   POST /calls/{name}/webhook/{tok}  one call ended, pushed back by the call provider
//   GET  /p/{id}                      one page the owner opens from a link
//   POST /p/{id}                      the one-time code for a private page
//   POST /p/{id}/choice               the owner tapped an answer on their own page
//
// The raw body is handed to a channel adapter as the exact bytes that arrived. Signature schemes
// sign the body verbatim, so parsing and re-serialising here would break every one of them.
//
// The page routes are the only ones that answer HTML, and the only ones a stranger might reach by
// guessing. They are deliberately dull about it: a page that does not exist and a page you are not
// allowed to see produce the same 404, so the link space cannot be probed for real ids.
import { createServer as nodeCreateServer } from "node:http";
import * as accounts from "./accounts.js";
import * as db from "./db.js";
import { renderPage, renderCodeGate, renderNotFound } from "./pages/render.js";
import { checkAccess, trySubmittedCode, readCookie, cookieHeader, startOwnerSession, SESSION_TTL_MS } from "./pages/access.js";
import { choiceBlock } from "./pages/content.js";
import { settleCall } from "./tools.js";
import { LIVE_STATES } from "./calls/provider.js";
import * as spotify from "./spotify.js";
import { config, stamp, clock } from "./config.js";

const MAX_BODY = 1_000_000;

export function createServer({ router, runtime, log = () => {} }) {
  return nodeCreateServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    };

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return send(200, health({ router, runtime }));
      }

      // ---------- pages ----------
      const pageRoute = /^\/p\/([A-Za-z0-9_-]{8,64})(\/choice)?$/.exec(url.pathname);
      if (pageRoute) {
        const out = await pageRequest({
          id: pageRoute[1],
          isChoice: !!pageRoute[2],
          key: url.searchParams.get("k"),
          method: req.method,
          headers: req.headers,
          readBody: () => readBody(req),
          runtime,
          log,
        });
        res.writeHead(out.status, out.headers);
        return res.end(out.body);
      }

      // ---------- a call ended ----------
      const callHook = /^\/calls\/([a-z0-9_-]+)\/webhook\/([A-Za-z0-9]{16,128})$/.exec(url.pathname);
      if (callHook && req.method === "POST") {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const out = await callWebhookRequest({
          provider: callHook[1], token: callHook[2], rawBody, headers: req.headers,
          calls: runtime?.turnExtras?.calls ?? null, log,
        });
        log({ call_webhook: callHook[1], status: out.status, call: out.body?.call_id ?? null });
        return send(out.status, out.body);
      }

      // ---------- a provider redirecting back after the person authorized ----------
      // Spotify sends the person here with ?code&state (or ?error&state). The `state` is the only
      // thing tying the callback to a conversation, and it is spent on the way through, so a link
      // that is opened twice connects nothing the second time. Nothing about the tokens is ever on
      // the page that comes back.
      if (req.method === "GET" && url.pathname === spotify.REDIRECT_PATH) {
        const out = await spotify.completeConnect({
          code: url.searchParams.get("code") ?? "",
          state: url.searchParams.get("state") ?? "",
          error: url.searchParams.get("error") ?? "",
        });
        log({ spotify_callback: out.ok ? "connected" : out.reason, conversation: out.conversationId ?? null });
        // No turn is fired from here. The person is looking at a browser, not at their messages,
        // and a proactive text saying "you just did the thing you are watching succeed" is noise.
        // The next thing they ask reads the connection off the tokens table.
        res.writeHead(out.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(spotify.callbackPage({
          ok: out.ok,
          message: out.ok
            ? `Spotify is connected. Reason can ${out.scopes.length} thing(s) with it now: ${out.scopes.join(", ")}.`
            : out.error,
        }));
      }

      const hook = /^\/channels\/([a-z0-9_-]+)\/webhook$/i.exec(url.pathname);
      if (hook && req.method === "POST") {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const out = await router.webhook({ channel: hook[1], rawBody, headers: req.headers });
        log({ webhook: hook[1], status: out.status, delivered: out.body?.delivered ?? 0 });
        // Answer the provider with its own status. A 2xx means "I have this"; anything else is
        // an invitation to retry, which the dedupe in the router is there to make safe.
        return send(out.status, out.body);
      }

      return send(404, { error: "not found" });
    } catch (e) {
      log({ http: url.pathname, threw: (e?.message ?? String(e)).split("\n")[0] });
      return send(500, { error: "server error" });
    }
  });
}

const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra });
const JSONH = { "Content-Type": "application/json", "Cache-Control": "no-store" };

/**
 * One call-finished delivery from the call provider.
 *
 * This is a head start on `call_status`, not a second way of finding things out: it writes the row
 * through the same `settleCall` the polling path uses, so a pushed outcome and a polled one are the
 * same row. An install with no REASON_PUBLIC_URL never gets one of these and loses nothing except
 * the time between the call ending and somebody asking.
 *
 * What it deliberately does NOT do is start a turn. The audio and the outcome are waiting on the
 * call row either way, and the recording rides out on the next message Reason sends — so a webhook
 * that arrives at three in the morning does not text anybody at three in the morning.
 *
 * Pulled out of the server like `pageRequest` so the whole thing is drivable without a socket.
 */
export async function callWebhookRequest({ provider, token, rawBody, headers, calls = null, fetchImpl = null, log = () => {} }) {
  // The provider that is actually running has to be the one this URL names. A delivery for a
  // provider nobody configured is not a late webhook, it is somebody poking the listener.
  const st = calls?.status?.();
  if (!calls || typeof calls.receiveWebhook !== "function" || st?.name !== provider) {
    return { status: 404, body: { error: "not found" } };
  }
  // Same dull 404 as a page that does not exist, and for the same reason: a token that is real and
  // a token that is not must not be told apart from the outside.
  const row = db.callByWebhookToken(token);
  if (!row) return { status: 404, body: { error: "not found" } };

  const parsed = calls.receiveWebhook({ rawBody, headers, call: row });
  if (!parsed.ok) {
    log({ call_webhook_rejected: row.id, why: parsed.error });
    return { status: parsed.status ?? 401, body: { error: parsed.error } };
  }

  const live = parsed.live;
  // The token says which call this is. If the payload disagrees, something is wrong enough that
  // writing it down would put one call's outcome on another call's row, so nothing is written.
  if (row.external_id && live.externalId && String(live.externalId) !== String(row.external_id)) {
    log({ call_webhook_mismatch: row.id, said: live.externalId, expected: row.external_id });
    return { status: 409, body: { error: "that token belongs to a different call" } };
  }

  // Nothing has finished yet. Acknowledged so the provider stops retrying, and nothing is written:
  // a call still ringing has no outcome to write.
  if (LIVE_STATES.includes(live.state)) {
    return { status: 200, body: { ok: true, call_id: row.id, state: live.state } };
  }
  // Already settled. Providers retry, and settling twice would count the same minutes twice.
  if (!LIVE_STATES.includes(row.state) && row.recording_state !== "pending") {
    return { status: 200, body: { ok: true, call_id: row.id, state: row.state, already: true } };
  }

  const settled = await settleCall(row.conversation_id, row, live, fetchImpl ? { fetchImpl } : {});
  log({ call_settled: row.id, state: settled.state, recording: settled.recording_state, by: "webhook" });
  return { status: 200, body: { ok: true, call_id: row.id, state: settled.state, recording: settled.recording_state } };
}

/**
 * One request for a page. Pulled out of the server so a test can drive the whole access dance —
 * link, code, cookie, choice — without a socket.
 *
 * Nothing here leaks whether an id is real. A page that does not exist, a method that makes no
 * sense for it, and a choice on somebody else's page all answer the same way as a bad link.
 */
export async function pageRequest({ id, isChoice, key = null, method, headers, readBody, runtime, log = () => {} }) {
  const page = db.getPage(id);
  if (!page) return { status: 404, headers: HTML(), body: renderNotFound() };

  const cookie = readCookie(headers?.cookie);
  const access = checkAccess({ page, cookie, key });

  // ---- the owner tapped an answer ----
  if (isChoice) {
    if (method !== "POST") return { status: 405, headers: JSONH, body: JSON.stringify({ ok: false, error: "post only" }) };
    // Only the owner's own proved browser may answer. On a shared page a choice is for reading:
    // letting a stranger press it would feed somebody else's answer back as though it were theirs.
    if (!access.allow || !access.interactive) {
      return { status: 403, headers: JSONH, body: JSON.stringify({ ok: false, error: "answers can only be given on the owner's own page" }) };
    }
    let body;
    try { body = JSON.parse((await readBody()) ?? "{}"); } catch { body = null; }
    const block = choiceBlock(page.blocks, body?.key);
    if (!block) return { status: 400, headers: JSONH, body: JSON.stringify({ ok: false, error: "no such question on this page" }) };
    const picked = block.options.find(o => o.label === body?.label);
    if (!picked) return { status: 400, headers: JSONH, body: JSON.stringify({ ok: false, error: "that is not one of the options" }) };

    db.recordPageChoice(page.id, {
      conversationId: page.conversation_id, blockKey: block.key,
      question: block.question, picked: picked.label,
    });
    log({ page_choice: page.id, key: block.key, picked: picked.label });
    // The turn itself is fired by the sweep, not here: an HTTP handler should not wait on a model
    // call, and the sweep is what makes "exactly once" true across a restart.
    return { status: 200, headers: JSONH, body: JSON.stringify({ ok: true, picked: picked.label }) };
  }

  // ---- the code for a private page ----
  if (method === "POST") {
    let code = "";
    const raw = (await readBody()) ?? "";
    const ct = String(headers?.["content-type"] ?? "");
    if (ct.includes("application/json")) {
      try { code = JSON.parse(raw)?.code ?? ""; } catch { code = ""; }
    } else {
      code = new URLSearchParams(raw).get("code") ?? "";
    }
    const tried = trySubmittedCode({ page, code });
    if (tried.ok) {
      log({ page_opened: page.id });
      return {
        status: 200,
        headers: HTML({ "Set-Cookie": cookieHeader(tried.token) }),
        body: renderPage(page, { interactive: true, picked: db.pageChoicesFor(page.id), forName: accounts.ownerOf(page.conversation_id).name }),
      };
    }
    const why = tried.reason === "rate_limited"
      ? `Too many wrong codes. Try again in about ${Math.ceil((tried.retry_after_s ?? 900) / 60)} minutes.`
      : tried.reason === "expired"
        ? `That code has expired. Ask ${config.ownerName === "" ? "the owner" : "Reason"} for a new one.`
        : `That code is not right.${tried.tries_left ? ` ${tried.tries_left} ${tried.tries_left === 1 ? "try" : "tries"} left.` : ""}`;
    log({ page_code_failed: page.id, reason: tried.reason });
    return {
      status: tried.reason === "rate_limited" ? 429 : 401,
      headers: HTML(),
      body: renderCodeGate({ title: "Private page", error: why, ownerName: config.ownerName }),
    };
  }

  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, headers: HTML(), body: renderNotFound() };
  }

  // ---- showing it ----
  if (access.allow) {
    // Arrived by the owner's link on a browser that is not signed in yet: sign it in, so the taps
    // on the page (which carry the cookie, not the key) are theirs. A GET with the key is safe to
    // repeat — a link preview fetching it changes nothing the owner can see — and a browser that
    // already has the cookie is not given another.
    const signIn = access.via_key && method === "GET" && !db.pageSessionValid(page.id, cookie, SESSION_TTL_MS);
    if (signIn) log({ page_opened: page.id });
    return {
      status: 200,
      headers: HTML(signIn ? { "Set-Cookie": cookieHeader(startOwnerSession(page)) } : {}),
      body: renderPage(page, {
        interactive: access.interactive,
        picked: access.interactive ? db.pageChoicesFor(page.id) : {},
        forName: accounts.ownerOf(page.conversation_id).name,
      }),
    };
  }
  if (access.reason === "rate_limited") {
    return {
      status: 429,
      headers: HTML(),
      body: renderCodeGate({
        error: `Too many wrong codes. Try again in about ${Math.ceil((access.retry_after_s ?? 900) / 60)} minutes.`,
        ownerName: config.ownerName,
      }),
    };
  }
  return { status: 401, headers: HTML(), body: renderCodeGate({ ownerName: config.ownerName }) };
}

/** What is really running, read from the database and the adapters rather than from uptime. */
export function health({ router, runtime }) {
  return {
    ok: true,
    now: stamp(),
    now_ms: clock.now(),
    owner: config.ownerName,
    sweeping: !!runtime?.interval,
    channels: router?.statuses?.() ?? [],
    // What is still owed to somebody. `failed` here means a message that is never arriving and
    // whose bad news may not have been delivered yet, which is worth seeing at a glance.
    outbox: db.outboxCounts(),
    // Messages that have arrived and are waiting out their quiet window to see whether more of the
    // same thought is coming. A row here with `due: true` and nothing happening means the sweep is
    // not running — which is the one way a held message could sit unanswered.
    holding: db.pendingInboundSummary(),
    // What this install has learned a provider will not do — a line with no read receipts, a number
    // that cannot send tapbacks. Permanent refusals only, so this is a short list that explains why
    // a feature is quietly absent rather than leaving somebody to wonder.
    channel_limits: db.listChannelLimits().map(l => ({ channel: l.channel, feature: l.feature, scope: l.scope, why: l.why })),
    // Whether a Spotify developer app is set up, and the exact address that has to be in its
    // Redirect URIs. Here because a redirect URI that does not match is the failure this will
    // actually hit, and it fails on Spotify's side with nothing useful said about why.
    spotify: (() => {
      const st = spotify.spotifyStatus();
      return { app_configured: st.connected, missing: st.missing, redirect_uri: st.redirect_uri };
    })(),
    open_tasks: db.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE state IN ('running','waiting')").get().n,
    due_tasks: db.dueTasks().length,
    pending_timers: db.db.prepare("SELECT COUNT(*) AS n FROM timers WHERE fired_at IS NULL AND cancelled_at IS NULL").get().n,
    live_watches: db.db.prepare("SELECT COUNT(*) AS n FROM watches WHERE met_at IS NULL AND cancelled_at IS NULL AND gave_up_at IS NULL").get().n,
    threads: db.listThreads().length,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
