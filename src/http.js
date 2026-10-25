// The listener inbound webhooks arrive on. node:http, no framework — a framework would be more
// code than the thing it wraps. Every route is matched by a regex in `createServer` below, and
// that is the list of record; this one is a reader's index and goes stale if nobody tends it.
//
//   GET  /health                      is it up, and what is it actually running
//   POST /channels/{name}/webhook     one provider delivery, verified and parsed by that adapter
//   POST /calls/{name}/webhook/{tok}  one call ended, pushed back by the call provider
//   POST /calls/elevenlabs/inbound    somebody is ringing: who are they, and what do we open with
//   POST /calls/elevenlabs/llm        one spoken turn, as SSE — Reason's own brain on the phone
//   POST /calls/elevenlabs/post-call  one call ended, with the transcript and the audio
//   GET  /p/{id}                      one page the owner opens from a link
//   POST /p/{id}                      the one-time code for a private page
//   POST /p/{id}/choice               the owner tapped an answer on their own page
//   GET  /p/{id}/card.png             the preview image iMessage draws for that link
//   GET  /p/{id}/preview.mp4          the animated preview, same link
//   GET  /img/{name}.(png|jpg|webp|gif)  one picture Reason generated or copied, off disk
//   GET  /f/{id}                      one document Reason wrote, by the owner's own keyed link
//   GET  /i/{token}                   an invite link (also /p/i/{token}); a read that never spends it
//   GET  /s/{token}                   a sign-in link: Reason's own browser, shown to one person
//   GET  /s/{token}/view              one picture of that browser, with the shape of its form
//   POST /s/{token}/{action}          start, tap, type, key, scroll, back, done, cancel
//   POST /access/web                  a number left on the website's form, signed by the form's server
//   POST /agentcard/webhook           a card landed in somebody's vault, or a payment was approved
//
// The raw body is handed to a channel adapter as the exact bytes that arrived. Signature schemes
// sign the body verbatim, so parsing and re-serialising here would break every one of them.
//
// The page routes are the only ones that answer HTML, and the only ones a stranger might reach by
// guessing. A page id is a capability — the owner's link is the whole authentication story — so
// whether an id is real is itself a secret, and these routes are deliberately dull about it: a
// page you are not allowed to see and a page that was never there answer identically, byte for
// byte. For `/p/{id}` that answer is 401 and the code gate (`pageRequest`); for `card.png`,
// `preview.mp4`, `/img/` and `/f/{id}` it is a flat 404. What matters is not which status it is
// but that the two cases cannot be told apart — until 2026-10-10 they could, because a missing
// page answered 404 while a private one answered 401, and that sorted guessed links into real and
// imaginary. Keep any new page route on the same footing.
import { createServer as nodeCreateServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as accounts from "./accounts.js";
import * as db from "./db.js";
import { renderPage, renderCodeGate, renderPasswordGate, renderNotFound } from "./pages/render.js";
import * as opspw from "./opspassword.js";
import { checkAccess, trySubmittedCode, requestCode, readCookie, cookieHeader, pageUrl, SESSION_TTL_MS, ATTEMPT_WINDOW_MS, MAX_FAILED_ATTEMPTS } from "./pages/access.js";
import { choiceBlock } from "./pages/content.js";
import * as ops from "./ops.js";
import * as subusage from "./subusage.js";
import { renderOps } from "./pages/ops.js";
import { settleCall, fillLateDetails, reconcileOrder } from "./tools.js";
import { LIVE_STATES } from "./calls/provider.js";
import { inboundRequest, INBOUND_PATH } from "./calls/inbound.js";
import { llmRequest, LLM_PATH } from "./calls/voice.js";
import { postCallRequest, POST_CALL_PATH } from "./calls/postcall.js";
import * as spotify from "./spotify.js";
import * as google from "./google.js";
import * as github from "./github.js";
import * as uber from "./uber.js";
import * as agentcard from "./agentcard.js";
import * as parallel from "./parallel.js";
import * as x from "./x.js";
import { renderNotice, renderConnected } from "./pages/render.js";
import { homePage, privacyPage, termsPage } from "./pages/site.js";
import { pageCard } from "./pages/card.js";
import { previewRequest } from "./pages/preview.js";
import { mimeForKind } from "./documents/store.js";
import { CONTACT_PATH, vcard, lineNumber } from "./contact.js";
import { inviteRequest } from "./invites.js";
import { eventPageRequest } from "./pages/event.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { remoteRequest, PATH as SIGNIN_PATH } from "./signin-remote.js";
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

      // ---------- the two public pages ----------
      // Google will not publish a consent screen without a home page and a privacy policy at
      // addresses anybody can open, and its verification asks for terms of service alongside them,
      // so these are the only routes here that are meant to be found rather than given out. All
      // three are exact paths and none can shadow anything: every other route is a longer prefix
      // (/p/, /s/, /channels/, /calls/, /health) or its own exact path (/spotify/callback,
      // /google/callback), and "", "privacy" and "terms" are not page ids — a page id is 8 or more
      // characters of [A-Za-z0-9_-] under /p/.
      const publicPage = { "/": homePage, "/privacy": privacyPage, "/terms": termsPage }[url.pathname];
      if ((req.method === "GET" || req.method === "HEAD") && publicPage) {
        const body = publicPage();
        // Cached, unlike everything else here. These two are the same for everybody and have nothing
        // of anybody's on them, and Google's reviewer will fetch them.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
        return res.end(req.method === "HEAD" ? "" : body);
      }

      // ---------- the things every page points at ----------
      // The icon, the site's picture and Reason's contact card. Same for everybody, nothing of
      // anybody's in them, fetched by phones and by Sendblue rather than by people.
      if (req.method === "GET" || req.method === "HEAD") {
        const asset = assetRequest({ pathname: url.pathname, router });
        if (asset) {
          res.writeHead(asset.status, asset.headers);
          return res.end(req.method === "HEAD" ? "" : asset.body);
        }
      }

      // ---------- a page's picture ----------
      const cardRoute = /^\/p\/([A-Za-z0-9_-]{8,64})\/card\.png$/.exec(url.pathname);
      if (cardRoute && (req.method === "GET" || req.method === "HEAD")) {
        const out = await cardRequest({ id: cardRoute[1], key: url.searchParams.get("k"), headers: req.headers, log });
        res.writeHead(out.status, out.headers);
        return res.end(req.method === "HEAD" ? "" : out.body);
      }

      // ---------- a page's animated preview ----------
      const previewRoute = /^\/p\/([A-Za-z0-9_-]{8,64})\/preview\.mp4$/.exec(url.pathname);
      if (previewRoute && (req.method === "GET" || req.method === "HEAD")) {
        const out = await previewRequest({ id: previewRoute[1], key: url.searchParams.get("k"), headers: req.headers, log });
        res.writeHead(out.status, out.headers);
        return res.end(req.method === "HEAD" ? "" : out.body);
      }

      // ---------- a generated image ----------
      const imgRoute = /^\/img\/([A-Za-z0-9_-]{8,64}\.(png|jpg|webp|gif))$/.exec(url.pathname);
      if (imgRoute && (req.method === "GET" || req.method === "HEAD")) {
        const out = imageRequest(imgRoute[1]);
        res.writeHead(out.status, out.headers);
        return res.end(req.method === "HEAD" ? "" : out.body);
      }

      // ---------- a document, downloaded ----------
      // The fallback for a channel that cannot carry an attachment. The owner's key or a 404.
      const fileRoute = /^\/f\/([A-Za-z0-9_-]{8,64})$/.exec(url.pathname);
      if (fileRoute && (req.method === "GET" || req.method === "HEAD")) {
        const out = documentRequest({ id: fileRoute[1], key: url.searchParams.get("k") });
        res.writeHead(out.status, out.headers);
        return res.end(req.method === "HEAD" ? "" : out.body);
      }

      // ---------- the status page ----------
      // The Mac's coding-subscription numbers, pushed and HMAC-signed (src/subusage.js ingest).
      if (url.pathname === "/ops/usage" && req.method === "POST") {
        const body = await readBody(req);
        const out = body == null || body.length > 4096 ? { status: 413, error: "too big" } : subusage.ingest({ body, headers: req.headers });
        if (out.status !== 204) log({ usage_ingest_refused: out.status, why: out.error });
        res.writeHead(out.status, { "content-type": "text/plain; charset=utf-8" });
        return res.end(out.status === 204 ? "" : `${out.error}\n`);
      }
      // The owner's own view of whether Reason is well. Same gate as a private page.
      if (url.pathname === "/ops" || url.pathname === "/ops.json") {
        const out = await opsRequest({
          json: url.pathname.endsWith(".json"),
          key: url.searchParams.get("k"),
          focus: url.searchParams.get("focus"),
          via: url.searchParams.get("via"),
          method: req.method,
          headers: req.headers,
          remoteAddress: req.socket?.remoteAddress ?? "",
          readBody: () => readBody(req),
          runtime,
          router,
          log,
        });
        res.writeHead(out.status, out.headers);
        return res.end(req.method === "HEAD" ? "" : out.body);
      }

      // ---------- an event's pages ----------
      // The public join page and the who's-going page (src/pages/event.js). `/p/e/…` is the same
      // link arriving through the files domain, which Caddy rewrites under /p.
      const eventRoute = /^(?:\/p)?\/e\/([A-Za-z0-9_-]{16})(?:\/(join|who))?$/.exec(url.pathname);
      if (eventRoute) {
        const out = await eventRequestFor({
          publicId: eventRoute[1], sub: eventRoute[2] || null, method: req.method,
          query: Object.fromEntries(url.searchParams), headers: req.headers, remoteAddress: req.socket?.remoteAddress ?? "",
          readBody: () => readBody(req), runtime, router, log,
        });
        res.writeHead(out.status, out.headers);
        return res.end(req.method === "HEAD" ? "" : out.body);
      }

      // ---------- an invite link ----------
      // A read and nothing else, so a link preview or a forward can never spend it (src/invites.js).
      // `/p/i/…` is the same link arriving through the files domain, which Caddy rewrites under /p.
      const inviteRoute = /^(?:\/p)?\/i\/([A-Za-z0-9_-]{32})$/.exec(url.pathname);
      if (inviteRoute) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain" });
          return res.end("method not allowed");
        }
        const out = inviteRequestFor({ token: inviteRoute[1], router });
        res.writeHead(out.status, out.headers);
        return res.end(req.method === "HEAD" ? "" : out.body);
      }

      // ---------- pages ----------
      const pageRoute = /^\/p\/([A-Za-z0-9_-]{8,64})(?:\/(choice))?$/.exec(url.pathname);
      if (pageRoute) {
        const out = await pageRequest({
          id: pageRoute[1],
          sub: pageRoute[2] || null,
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

      // ---------- signing in from a phone ----------
      // A private link showing the person Reason's own browser, so they sign in to a site
      // themselves. Nothing about these requests is logged beyond the fact that one happened: the
      // body of /type is what somebody typed into a sign-in page.
      if (url.pathname.startsWith(`${SIGNIN_PATH}/`)) {
        const m = /^\/s\/([A-Za-z0-9_-]{32,64})(?:\/([a-z]+))?$/.exec(url.pathname);
        if (!m) return send(404, { error: "not found" });
        const out = await remoteRequest({
          token: m[1], action: m[2] ?? "", method: req.method, headers: req.headers,
          // Only the hash of the picture the phone already has, so an unchanged one is not resent.
          query: { h: url.searchParams.get("h") ?? "" },
          readBody: () => readBody(req),
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

      // ---------- Reason itself on the phone ----------
      // Three routes, all ElevenLabs': the personalization webhook that answers during the ring, the
      // custom-LLM endpoint that generates every word said, and the post-call delivery. None of them
      // exists in any useful sense unless this install runs that provider AND has its keys — each
      // handler checks the provider that is really running and 404s otherwise, so on an install that
      // runs bland these are the same not-found as any address nobody was issued.
      if (req.method === "POST" && url.pathname === INBOUND_PATH) {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const out = inboundRequest({
          rawBody, headers: req.headers,
          provider: runtime?.turnExtras?.calls ?? null,
          router, log,
        });
        log({ call_inbound_webhook: out.status, conversation: out.conversationId ?? null });
        return send(out.status, out.body);
      }

      // The custom-LLM endpoint. Answers SSE rather than JSON, and streams as it goes: the first
      // sentence leaves while the rest of the reply is still being written, which is the difference
      // between a call that feels alive and one with a gap at the top of every turn.
      if (req.method === "POST" && url.pathname.startsWith(LLM_PATH)) {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const t0 = Date.now();
        const out = await llmRequest({ rawBody, headers: req.headers, log, extras: runtime?.turnExtras ?? {} });
        res.writeHead(out.status, out.headers);
        if (!out.stream) return res.end(out.body);
        // The platform closing the socket — it gave up waiting, the person spoke over this turn, or
        // the call ended — cancels the turn behind it, so its tools and model rounds stop too rather
        // than running on for a stream nobody is reading.
        res.on("close", () => out.abort?.());
        // The platform gives the custom LLM a fixed number of seconds to start talking and closes
        // the socket when it runs out — and a `break` below ends the turn's generator at its
        // current yield, so a turn the platform gave up on used to leave no line at all. The first
        // spoken content and any early close are logged with their timing, because "it went
        // silent" has to be answerable from the journal.
        let firstContentMs = null;
        let bytes = 0;
        try {
          for await (const chunk of out.stream) {
            // Somebody hung up mid-sentence. Stop writing into a socket that is gone rather than
            // throwing out of the middle of a model loop.
            if (res.writableEnded || res.destroyed) {
              log({ call_llm_closed_by_platform: true, ms: Date.now() - t0, first_content_ms: firstContentMs, bytes });
              break;
            }
            if (firstContentMs === null && String(chunk).includes('"content":')) {
              firstContentMs = Date.now() - t0;
              log({ call_llm_first_content_ms: firstContentMs });
            }
            bytes += Buffer.byteLength(String(chunk));
            res.write(chunk);
          }
        } catch (e) {
          log({ call_llm_stream_broke: (e?.message ?? String(e)).split("\n")[0], ms: Date.now() - t0 });
        }
        return res.end();
      }

      if (req.method === "POST" && url.pathname === POST_CALL_PATH) {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const out = await postCallRequest({
          rawBody, headers: req.headers,
          provider: runtime?.turnExtras?.calls ?? null,
          runtime, log, settle: settleCall,
        });
        log({ call_post_call: out.status, call: out.body?.call_id ?? null });
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

      // ---------- Spotify join: a non-owner enters their Spotify email so the operator can whitelist them ----------
      if (url.pathname === spotify.JOIN_PATH) {
        const token = url.searchParams.get("t") ?? "";
        if (req.method === "GET") {
          if (!token) return send(404, { error: "not found" });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          return res.end(spotify.joinPage({ token }));
        }
        if (req.method === "POST") {
          const rawBody = await readBody(req);
          if (rawBody === null) return send(413, { error: "body too large" });
          const params = new URLSearchParams(rawBody.toString());
          const email = (params.get("email") ?? "").trim();
          const t = params.get("t") ?? "";
          if (!email || !email.includes("@")) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            return res.end(spotify.joinPage({ token: t, error: "Enter a valid email address." }));
          }
          const row = db.spendOauthState(t);
          if (!row || row.provider !== "spotify_join") {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            return res.end(spotify.joinPage({ error: "This link has expired. Ask Reason for a new one." }));
          }
          db.addSpotifyJoinRequest(row.conversation_id, email);
          const who = accounts.ownerOf(row.conversation_id);
          log({ spotify_join: email, conversation: row.conversation_id });
          runtime.say(config.ownerConversation,
            `${who.name || "Someone"} wants to connect their Spotify. Their email is ${email}.`
            + ` Add it in the Spotify developer dashboard under User Management, then tell me and I will send them the link.`);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          return res.end(spotify.joinPage({ done: true }));
        }
      }

      // ---------- GitHub coming back after the person agreed ----------
      // Same shape as Spotify's: nothing is said in the thread from here, because the person is
      // looking at a browser, not their messages. The next thing they ask reads the connection off
      // the tokens table.
      if (req.method === "GET" && url.pathname === github.REDIRECT_PATH) {
        const out = await github.completeConnect({
          code: url.searchParams.get("code") ?? "",
          state: url.searchParams.get("state") ?? "",
          error: url.searchParams.get("error") ?? "",
        });
        log({ github_callback: out.ok ? "connected" : out.reason, conversation: out.conversationId ?? null });
        res.writeHead(out.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(github.callbackPage({
          ok: out.ok,
          message: out.ok
            ? `GitHub is connected${out.username ? ` as ${out.username}` : ""}. Reason can work with your repos now.`
            : out.error,
        }));
      }

      // ---------- Uber coming back after the person signed in ----------
      // Same shape as Spotify's and GitHub's: the state ties the callback to a conversation and is
      // spent on the way through, nothing about the tokens is ever on the page, and nothing is
      // texted from here — the person is looking at a browser, not at their messages.
      //
      // The one thing this page says that the others do not: whether Uber granted the privileged
      // scope a ride needs. Somebody who has just signed in and whose account is not one Uber's
      // Limited Access covers has a working connection that cannot book, and finding that out when
      // they next ask for a car would be the worst moment to find it out.
      if (req.method === "GET" && url.pathname === uber.REDIRECT_PATH) {
        const out = await uber.completeConnect({
          code: url.searchParams.get("code") ?? "",
          state: url.searchParams.get("state") ?? "",
          error: url.searchParams.get("error") ?? "",
        });
        log({ uber_callback: out.ok ? (out.can_book ? "ride_access" : "identity_only") : out.reason, conversation: out.conversationId ?? null });
        res.writeHead(out.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(uber.callbackPage({
          ok: out.ok,
          message: out.ok
            ? (out.can_book
              ? `Uber is connected${out.account ? ` as ${out.account}` : ""}. Reason can quote a fare and request a ride for you now — it will always show you the price and wait for a yes first.`
              : `Uber is connected${out.account ? ` as ${out.account}` : ""}, but only to see who you are: Uber did not grant the ride permission (${out.missing_privileged.join(", ")}), which they only give to the app owner's own Uber account and to developer accounts listed in the app's dashboard. Reason can still send you a link that opens Uber with your destination filled in.`)
            : out.error,
        }));
      }

      // ---------- X coming back after the person agreed ----------
      // Same shape as GitHub's: nothing is said in the thread from here. The next thing they ask
      // reads the connection off the tokens table.
      if (req.method === "GET" && url.pathname === x.REDIRECT_PATH) {
        const out = await x.completeConnect({
          code: url.searchParams.get("code") ?? "",
          state: url.searchParams.get("state") ?? "",
          error: url.searchParams.get("error") ?? "",
        });
        log({ x_callback: out.ok ? "connected" : out.reason, conversation: out.conversationId ?? null });
        res.writeHead(out.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(x.callbackPage({
          ok: out.ok,
          message: out.ok
            ? `X is connected${out.username ? ` as @${out.username}` : ""}. Reason can read your timeline and draft posts for you now.`
            : out.error,
        }));
      }

      // ---------- Google coming back after the person agreed ----------
      // Same shape as Spotify's and one difference that matters: this one does say something in the
      // thread afterwards. A connected mailbox is not a thing somebody watches succeed and then
      // knows the state of — they tapped a link, agreed on a Google page, and the useful fact is
      // WHICH address got attached, which is on Google's side and not on theirs. So the page says it
      // worked and one short text names the address, through the ordinary delivery path.
      if (req.method === "GET" && url.pathname === google.REDIRECT_PATH) {
        const out = await googleCallbackRequest({
          code: url.searchParams.get("code") ?? "",
          state: url.searchParams.get("state") ?? "",
          error: url.searchParams.get("error") ?? "",
          runtime,
          log,
        });
        res.writeHead(out.status, out.headers);
        return res.end(out.body);
      }

      // ---------- Parallel pushing back: a deep run finished, a monitor saw something ----------
      if (req.method === "POST" && url.pathname === "/parallel/webhook") {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const out = await parallelWebhookRequest({ rawBody, headers: req.headers, runtime, log });
        return send(out.status, out.body);
      }

      // ---------- AgentCard pushing back: a card landed, a payment was approved ----------
      if (req.method === "POST" && url.pathname === "/agentcard/webhook") {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const out = await agentcardWebhookRequest({ rawBody, headers: req.headers, runtime, log });
        return send(out.status, out.body);
      }

      // ---------- a number left on the website ----------
      if (url.pathname === WEB_ACCESS_PATH && req.method === "POST") {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const out = await webAccessRequest({ rawBody, headers: req.headers, router, log });
        return send(out.status, out.body);
      }

      const hook = /^\/channels\/([a-z0-9_-]+)\/webhook$/i.exec(url.pathname);
      if (hook && req.method === "POST") {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        // The router answers once the whole turn is over, which on a long one is past the
        // provider's own timeout (Sendblue: 45s, then retries). Whatever is wrong with a delivery —
        // a bad signature, a body that will not parse — is known in milliseconds, so the provider
        // still hears that. Anything slower is a turn under way: the message is already claimed
        // and held in the database (and the sweep finishes it if this process stops), so "I have
        // this" is true, and the turn carries on after the provider has its answer.
        const running = router.webhook({ channel: hook[1], rawBody, headers: req.headers });
        const done = (out) => log({ webhook: hook[1], status: out.status, delivered: out.body?.delivered ?? 0 });
        const early = await Promise.race([running, new Promise(r => setTimeout(r, config.webhookAnswerMs, null))]);
        if (early) {
          done(early);
          // Answer the provider with its own status. A 2xx means "I have this"; anything else is
          // an invitation to retry, which the dedupe in the router is there to make safe.
          return send(early.status, early.body);
        }
        running.then(done, (e) => log({ webhook: hook[1], threw: (e?.message ?? String(e)).split("\n")[0] }));
        return send(200, { ok: true, accepted: true });
      }

      return send(404, { error: "not found" });
    } catch (e) {
      log({ http: url.pathname, threw: (e?.message ?? String(e)).split("\n")[0] });
      return send(500, { error: "server error" });
    }
  });
}

const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra });
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function brandedPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--ground:#f3eee6;--bg:#fbf9f5;--fg:#1c1915;--mute:#6f675d;--line:#e6e0d7;--mark:#ff5a3c}
@media(prefers-color-scheme:dark){:root{--ground:#0b0a09;--bg:#12110f;--fg:#f3efe8;--mute:#a39c91;--line:#2c2924;--mark:#ff6b4f}}
*{box-sizing:border-box}body{margin:0;font:17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;background:var(--ground);color:var(--fg)}
.bar{display:flex;align-items:center;gap:.45rem;padding:14px 16px 10px;font:500 1rem/1.2 ui-serif,"New York","Iowan Old Style",Georgia,serif}
.dot{flex:none;width:.5rem;height:.5rem;border-radius:50%;background:var(--mark)}
.sheet{background:var(--bg);border-radius:1.5rem 1.5rem 0 0;min-height:100dvh}
main{max-width:32rem;margin:0 auto;padding:2rem 1.5rem}
h1{font-size:1.3rem;margin:0 0 .5rem}.lead{color:var(--mute);font-size:.9rem}
</style></head><body>
<div class="bar"><span class="dot"></span>Reason</div>
<div class="sheet"><main>${body}</main></div></body></html>`;
}

/** Whose page this is, for the top line: their name and the language they want it in. */
function whoseLine(page) {
  const whose = accounts.ownerOf(page.conversation_id);
  return { forName: whose.name, language: whose.language };
}

/**
 * The other pages of theirs this one links to at the bottom.
 *
 * Only for the owner's own view, and that is the whole privacy story: those links carry each page's
 * owner key, so on a shared copy — read by whoever has the link — there is nothing to compute. The
 * list itself is scoped to this page's own conversation inside db.relatedPages, so no request can
 * reach another person's pages whatever it sends.
 */
function relatedFor(page, interactive) {
  return interactive ? db.relatedPages(page.conversation_id, page.id) : [];
}

const ASSETS = new URL("../assets/", import.meta.url);
const assetCache = new Map();
function assetBytes(name) {
  if (!assetCache.has(name)) {
    try { assetCache.set(name, readFileSync(new URL(name, ASSETS))); } catch { assetCache.set(name, null); }
  }
  return assetCache.get(name);
}

/**
 * The fixed files: the icon a page names, the site's picture, and Reason's contact card. Null when
 * the path is not one of them, so the server carries on to the real routes.
 *
 * The card is built per request from the line the texting channel reports, never stored: the
 * number is a fact about this install's channel, and reading it each time is what keeps the card
 * right after the line changes. No live line, no card — a 404 rather than a card with no number.
 */
export function assetRequest({ pathname, router = null }) {
  const png = { "/apple-touch-icon.png": "apple-touch-icon.png", "/og.png": "og.png" }[pathname];
  if (png) {
    const bytes = assetBytes(png);
    if (!bytes) return { status: 404, headers: HTML(), body: renderNotFound() };
    return { status: 200, headers: { "Content-Type": "image/png", "Content-Length": bytes.length, "Cache-Control": "public, max-age=86400" }, body: bytes };
  }
  if (pathname === "/favicon.svg") {
    const bytes = assetBytes("favicon.svg");
    if (!bytes) return { status: 404, headers: HTML(), body: renderNotFound() };
    return { status: 200, headers: { "Content-Type": "image/svg+xml", "Content-Length": bytes.length, "Cache-Control": "public, max-age=86400" }, body: bytes };
  }
  if (pathname === CONTACT_PATH) {
    const live = (router?.list?.() ?? []).find(ch => ch.name !== "console" && ch.status?.().status === "live");
    const card = live ? vcard({ number: lineNumber(router, live.name), callNumber: config.elevenPhoneNumber }) : null;
    if (!card) return { status: 404, headers: HTML(), body: renderNotFound() };
    return {
      status: 200,
      headers: {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": 'inline; filename="Reason.vcf"',
        "Content-Length": Buffer.byteLength(card),
        "Cache-Control": "public, max-age=3600",
      },
      body: card,
    };
  }
  return null;
}

/** An event page, with the texting line's number for its "Text Reason to finish" button. */
export async function eventRequestFor({ router = null, ...rest }) {
  const live = (router?.list?.() ?? []).find(ch => ch.name !== "console" && ch.status?.().status === "live");
  return await eventPageRequest({ ...rest, lineNumber: live ? lineNumber(router, live.name) : null });
}

/**
 * An invite page, with the number of the texting line it should send its code to. Exported for the
 * tests; the route above is the only caller.
 */
export function inviteRequestFor({ token, router = null }) {
  const live = (router?.list?.() ?? []).find(ch => ch.name !== "console" && ch.status?.().status === "live");
  return inviteRequest({ token, lineNumber: live ? lineNumber(router, live.name) : null });
}

/**
 * One document Reason wrote, downloaded.
 *
 * This route is the FALLBACK and never the normal way. A document is meant to arrive in the thread
 * as an attachment (src/channels/channel.js sendMedia); this exists for the honest answer on a
 * channel that cannot carry a file, and for the owner who wants the file off the machine again.
 *
 * It is the owner's key or nothing. There is no code path, no cookie and no sharing: a document can
 * be somebody's lease, a letter or a draft, so unlike a page there is no version of it anybody else
 * may read. A wrong key, a missing key, an id that does not exist and a row whose file has gone all
 * answer the same 404, so the link space cannot be probed and a real id tells a guesser nothing.
 */
export function imageRequest(filename, { dir = config.imagenOutputDir, read = readFileSync } = {}) {
  const safe = filename.replace(/[^A-Za-z0-9_.-]/g, "");
  if (safe !== filename) return { status: 404, headers: HTML(), body: renderNotFound() };
  const ext = safe.endsWith(".jpg") ? "jpeg" : safe.endsWith(".webp") ? "webp" : safe.endsWith(".gif") ? "gif" : "png";
  let bytes;
  try { bytes = read(join(dir, safe)); } catch {
    return { status: 404, headers: HTML(), body: renderNotFound() };
  }
  return {
    status: 200,
    headers: { "Content-Type": `image/${ext}`, "Content-Length": String(bytes.length), "Cache-Control": "public, max-age=86400" },
    body: bytes,
  };
}

export function documentRequest({ id, key = null, read = readFileSync }) {
  const doc = db.getDocument(id);
  if (!doc) return { status: 404, headers: HTML(), body: renderNotFound() };
  const given = Buffer.from(String(key ?? ""));
  const want = Buffer.from(String(doc.owner_key ?? ""));
  // Constant time, and length-checked first, exactly as the page key is compared.
  if (!given.length || given.length !== want.length || !timingSafeEqual(given, want)) {
    return { status: 404, headers: HTML(), body: renderNotFound() };
  }
  let bytes;
  try { bytes = read(doc.path); } catch { bytes = null; }
  if (!bytes?.length) return { status: 404, headers: HTML(), body: renderNotFound() };
  return {
    status: 200,
    headers: {
      "Content-Type": mimeForKind(doc.kind) ?? "application/octet-stream",
      // attachment, not inline: this link exists to put the file on somebody's device.
      "Content-Disposition": `attachment; filename="${doc.filename.replace(/["\\]/g, "")}"`,
      "Content-Length": bytes.length,
      "Cache-Control": "private, no-store",
    },
    body: bytes,
  };
}

/**
 * A page's picture, for whoever may see the page: the owner's key, or a browser already signed in. Anyone else gets the same 404 as a page that does not exist — the picture
 * must not be a way to read a title off a link somebody was not given.
 *
 * `draw` is injectable so the route is provable without Chromium. When the picture cannot be made
 * the answer is 404 too: a phone that asked for a card's picture and got none draws the card
 * without one, which is what it did before this existed.
 */
export async function cardRequest({ id, key = null, headers = {}, draw = pageCard, log = () => {} }) {
  const page = db.getPage(id);
  if (!page) return { status: 404, headers: HTML(), body: renderNotFound() };
  // The owner's key is enough for the picture: the fetcher drawing the card under their own text
  // holds the link, and the card is the title, which the gate it may be fetching for already names.
  const access = checkAccess({ page, cookie: readCookie(headers?.cookie), key });
  if (!access.allow && !access.via_key) return { status: 404, headers: HTML(), body: renderNotFound() };
  try {
    const whose = accounts.ownerOf(page.conversation_id);
    const card = await draw(page, { forName: whose.name, language: whose.language });
    const bytes = readFileSync(card.file);
    return {
      status: 200,
      headers: { "Content-Type": "image/png", "Content-Length": bytes.length, "Cache-Control": "private, max-age=86400" },
      body: bytes,
    };
  } catch (e) {
    log({ page_card_failed: id, why: (e?.message ?? String(e)).split("\n")[0] });
    return { status: 404, headers: HTML(), body: renderNotFound() };
  }
}
const JSONH = { "Content-Type": "application/json", "Cache-Control": "no-store" };

export const WEB_ACCESS_PATH = "/access/web";
const WEB_ACCESS_MAX_BODY = 512;
const WEB_ACCESS_SKEW_MS = 5 * 60_000;

/** What the website's server puts in `x-reason-signature` for a body sent at `timestamp`. */
export function signWebAccess({ secret, timestamp, rawBody }) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/**
 * One number from the website's "request access" form.
 *
 * This is the one route here that takes input a stranger chose and turns it into a text on the
 * master's phone, so it trusts nothing about the request except the signature:
 *
 *   - with no REASON_WEB_ACCESS_SECRET set the route does not exist (the same 404 as any other
 *     path), so an install that never set the website up has no door to knock on;
 *   - the body is signed, with a timestamp, by the website's own server. The secret is in that
 *     server's settings and this install's — never in the page a browser loads — so a number
 *     cannot be pushed in from anywhere but the form;
 *   - a signature is only good for five minutes, and replaying one inside that window asks about a
 *     number that is already waiting, which changes nothing;
 *   - the number has to be a plain E.164 phone number and nothing else rides along with it.
 *
 * The body that goes back says whether it was taken and nothing about the number. Whether it was
 * new, already waiting, already a customer, declined or blocked is in the log, not in the answer.
 *
 * Pulled out of the server like `pageRequest` so the whole thing is drivable without a socket.
 */
export async function webAccessRequest({ rawBody, headers, router, log = () => {} }) {
  const secret = config.webAccessSecret;
  if (!secret) return { status: 404, body: { error: "not found" } };

  const given = String(headers?.["x-reason-signature"] ?? "");
  const timestamp = String(headers?.["x-reason-timestamp"] ?? "");
  const expected = signWebAccess({ secret, timestamp, rawBody: rawBody ?? "" });
  const a = Buffer.from(given), b = Buffer.from(expected);
  const signed = a.length === b.length && timingSafeEqual(a, b);
  const fresh = /^\d{13}$/.test(timestamp) && Math.abs(clock.now() - Number(timestamp)) <= WEB_ACCESS_SKEW_MS;
  if (!signed || !fresh) {
    log({ web_access_rejected: !signed ? "bad_signature" : "stale" });
    return { status: 401, body: { error: "not signed" } };
  }

  if (Buffer.byteLength(rawBody) > WEB_ACCESS_MAX_BODY) return { status: 413, body: { error: "body too large" } };
  let phone;
  try { phone = JSON.parse(rawBody)?.phone; } catch { phone = undefined; }

  const out = await router.webAccess({ address: phone });
  if (out.ok) return { status: 200, body: { ok: true } };
  if (out.reason === "bad_number") return { status: 400, body: { ok: false, error: "bad_number" } };
  if (out.reason === "full_today") return { status: 429, body: { ok: false, error: "full_today" } };
  return { status: 503, body: { ok: false, error: "not_ready" } };
}

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
    // A retry can still carry what the first delivery was too early to have — the summary and the
    // price are filled in after the call ends — so those are taken, and nothing else is redone.
    fillLateDetails(row.conversation_id, row, live);
    return { status: 200, body: { ok: true, call_id: row.id, state: row.state, already: true } };
  }

  const settled = await settleCall(row.conversation_id, row, live, fetchImpl ? { fetchImpl } : {});
  log({ call_settled: row.id, state: settled.state, recording: settled.recording_state, by: "webhook" });
  return { status: 200, body: { ok: true, call_id: row.id, state: settled.state, recording: settled.recording_state } };
}

/**
 * One AgentCard webhook delivery → the rows it changes, and the one line worth texting.
 *
 * Verified before it is parsed and refused with a 401 when it cannot be, like every other inbound
 * hook here: this route marks purchases approved and stores user ids, so an install that cannot
 * prove who is calling it must not act on the call. Unknown event types get a flat 200 and are
 * dropped — AgentCard's `enabled_events` can be set to `*`, and a cards or rewards event arriving
 * on the same URL is not a failure worth retrying.
 *
 * Deduplicated on the envelope's own id, because delivery is at least once with five retries: a
 * redelivered `checkout_authorization.declined` would otherwise text somebody twice about one
 * refusal.
 *
 * What this never does is say something is bought. An approval is a payment taken, not a shop that
 * has the order — AgentCard's own docs are explicit that none of these events confirms a merchant
 * order and only the merchant does. The order comes back on the confirm call, which the tool
 * records; this route moves the row to approved and stays quiet.
 */
/**
 * Something Parallel finished or noticed (src/parallel.js). The signature is checked first and a
 * missing secret refuses everything: a forged "your deep run is done" would only make a task wake
 * early and find nothing, but a forged monitor event would make Reason text somebody a sentence
 * nobody's monitor said. Nothing in the payload is believed beyond the id it names: the row is
 * looked up by that id, and what is then said comes from Parallel's API, fetched afresh.
 *
 * What a delivery does is make the right thing DUE now — the research task wakes, the watch is
 * checked — rather than doing the work in the request. The same wake and the same check happen on
 * the schedule with no webhook at all, only later; this is what makes "later" "now".
 */
export async function parallelWebhookRequest({ rawBody, headers = {}, runtime = null, log = () => {} } = {}) {
  const v = parallel.verifyWebhook({ rawBody, headers });
  if (!v.ok) {
    log({ parallel_webhook_rejected: v.why });
    return { status: 401, body: { error: `rejected: ${v.why}` } };
  }
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "bad json" } }; }
  const type = String(parsed?.type ?? "");
  const data = parsed?.data ?? {};
  if (!type) return { status: 400, body: { error: "no event type" } };

  if (type === "task_run.status" || type.startsWith("findall.run.")) {
    const remoteId = String(data.run_id ?? data.findall_id ?? "");
    const row = remoteId ? db.parallelRunByRemote(remoteId) : null;
    if (!row) {
      log({ parallel_webhook: type, unknown_run: remoteId });
      return { status: 200, body: { ok: true, unknown: true } };
    }
    const status = type === "task_run.status"
      ? String(data.status ?? "")
      : { "findall.run.completed": "completed", "findall.run.cancelled": "cancelled", "findall.run.failed": "failed" }[type];
    // Only the status word is taken from the push, and only as far as "stop waiting": the result
    // itself is fetched when the task wakes, so a completed-looking delivery with nothing behind it
    // costs one wake and claims nothing.
    if (["failed", "cancelled"].includes(status)) db.setParallelRunStatus(row.id, { status, error: data.error?.message ?? `the run ${status}` });
    else if (status === "running") db.setParallelRunStatus(row.id, { status });
    if (row.task_id) db.scheduleTask(row.task_id, clock.now());
    log({ parallel_webhook: type, run: row.id, status, task: row.task_id ?? null });
    return { status: 200, body: { ok: true } };
  }

  if (type.startsWith("monitor.")) {
    const watch = data.monitor_id ? db.watchForMonitor(String(data.monitor_id)) : null;
    if (!watch) {
      log({ parallel_webhook: type, unknown_monitor: data.monitor_id ?? null });
      return { status: 200, body: { ok: true, unknown: true } };
    }
    if (type === "monitor.event.detected") {
      db.markWatchDue(watch.id);
      // The check itself is the sweep's: it reads the events off Parallel's API and says what
      // they said. Kicked now rather than left to the next sweep, and not awaited, so a slow
      // check never holds Parallel's delivery open.
      if (runtime?.checkWatches) runtime.checkWatches().catch(e => log({ parallel_webhook_check_failed: (e?.message ?? String(e)).split("\n")[0] }));
    }
    log({ parallel_webhook: type, watch: watch.id });
    return { status: 200, body: { ok: true } };
  }

  log({ parallel_webhook: type, ignored: true });
  return { status: 200, body: { ok: true, ignored: true } };
}

export async function agentcardWebhookRequest({ rawBody, headers = {}, runtime = null, log = () => {} } = {}) {
  const v = agentcard.verifyWebhook({ rawBody, headers });
  if (!v.ok) {
    log({ agentcard_webhook_rejected: v.why });
    return { status: 401, body: { error: `rejected: ${v.why}` } };
  }

  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "bad json" } }; }
  const event = agentcard.readEvent(parsed);
  if (!event.type) return { status: 400, body: { error: "no event type" } };

  // Deduped on the id, and the FIRST copy is the one acted on and kept: on 2026-10-24 AgentCard
  // re-posted order e66d7f2b…'s cancellation 48 ms later under the same id with canceled_reason and
  // status_detail both null (their bug; their advice: the first copy of an id is authoritative).
  if (!db.firstAgentcardEvent({ eventId: event.id, type: event.type, data: event.data })) {
    log({ agentcard_webhook: event.type, duplicate: event.id });
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  const data = event.data ?? {};
  const say = (conversationId, text) => {
    if (!runtime?.say || !conversationId) return;
    try { runtime.say(conversationId, text); } catch (e) {
      log({ agentcard_webhook_text_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] });
    }
  };

  switch (event.type) {
    // The session Reason minted got its person. This is the id every purchase runs as, and the only
    // thing tying it to a conversation is the session id — which is why the row is found by that and
    // never by anything the payload claims about who it is.
    case "vault.session_linked": {
      const sessionId = data.vault_session_id ?? "";
      const row = db.linkAgentcardUser({ vaultSessionId: sessionId, userId: data.user_id ?? "" });
      if (!row) {
        log({ agentcard_webhook: event.type, linked: "unknown session" });
        return { status: 200, body: { ok: true, linked: false } };
      }

      // A linked session is worth exactly one exchange, and it is what turns a stored card into a
      // person this install can buy as. Claimed before the call because `vault.card_stored` and any
      // tool polling at the same moment are racing for the same single-use endpoint; whoever loses
      // simply leaves it, because the winner's tokens are the same tokens.
      // Connected means a live token FROM THIS SESSION. An old pair left on the row — expired, or
      // refused — is not this link, and reading it as connected (2026-10-25: the owner's re-link
      // logged connected:true over a dead token) skipped the exchange the link was for.
      let connected = !!row.access_token && Number(row.token_expires_at ?? 0) > clock.now() && row.exchanged_session === sessionId;
      if (!connected && db.claimAgentcardExchange(sessionId)) {
        const got = await agentcard.exchangeVaultSession(sessionId);
        if (got.ok) {
          db.saveAgentcardConnection({
            conversationId: row.conversation_id, userId: got.userId, accessToken: got.accessToken,
            refreshToken: got.refreshToken, expiresAt: got.expiresAt, sessionId,
          });
          connected = true;
        } else if (!got.alreadyExchanged) {
          // Handed back so a later attempt is not locked out of a session that was never cashed in.
          db.releaseAgentcardExchange(sessionId);
          // Said only when the person has to do something about it. A verification wall is theirs to
          // clear; anything else is this machine's problem and a line about it would be noise.
          if (got.needsVerification) {
            say(row.conversation_id, `almost — agentcard needs to check that account is yours before i can use the card. say the word and i'll start that.`);
          }
          log({ agentcard_webhook: event.type, exchange_failed: got.error });
        }
      }
      log({ agentcard_webhook: event.type, linked: row.conversation_id, connected });
      return { status: 200, body: { ok: true, linked: true, connected } };
    }

    // A card landed. Brand and last four, which is all AgentCard sends and all Reason wants. Said in
    // the thread because the person is looking at a browser tab rather than at their messages, and
    // the useful fact — that it worked, and which card — is on AgentCard's side, not theirs.
    case "vault.card_stored": {
      const row = db.noteAgentcardCard({ userId: data.user_id ?? "", brand: data.brand ?? "", last4: data.last4 ?? "" });
      if (row) {
        const label = agentcard.cardLabel({ brand: data.brand, last4: data.last4 });
        say(row.conversation_id, `card saved — ${label} is in your vault. i can buy things with it now. i'll always show you the exact cart first, and you approve the payment on your phone.`);
      }
      log({ agentcard_webhook: event.type, stored: row ? row.conversation_id : "unknown user" });
      return { status: 200, body: { ok: true, stored: !!row } };
    }

    // checkout_authorization.* -- what happened to a paused checkout. Keyed on data.authorization_id
    // and nothing else (the id is on the row from the approval link), and never proof an order was
    // placed: AgentCard's own docs say none of these confirms a merchant order. So they write
    // authorization_state, never `status` -- except declined/expired on a row still waiting, which
    // does mean this confirm cannot finish. Before 2026-10-23 the row was found by the person and the
    // amount, with a fallback to their newest waiting purchase.
    case "checkout_authorization.approved":
    case "checkout_authorization.submitted":
    case "checkout_authorization.declined":
    case "checkout_authorization.expired":
    case "checkout_authorization.amount_mismatch":
    case "checkout_authorization.settled":
    case "checkout_authorization.settlement_unconfirmed":
    case "checkout_authorization.watched":
    case "checkout_authorization.refused": {
      const kind = event.type.slice("checkout_authorization.".length);
      const authId = data.authorization_id ?? "";
      const row = db.agentcardPurchaseByAuthorization(authId);
      const user = db.agentcardUserById(data.user_id ?? "");
      // The id has to belong to the person the event names. An id from somebody else's purchase is
      // not acted on.
      if (!row || !user || row.conversation_id !== user.conversation_id) {
        log({ agentcard_webhook: event.type, unmatched_authorization: authId || "none", known_user: !!user });
        return { status: 200, body: { ok: true, matched: false } };
      }
      const ends = (kind === "declined" || kind === "expired") && row.status === "awaiting_approval";
      db.markAgentcardPurchase(row.buy_conversation_id, {
        authorizationState: kind,
        chargeStatus: data.settlement?.status || undefined,
        ...(ends ? {
          status: "failed",
          declineCode: kind === "expired" ? "approval_expired" : (data.reason || data.decline_code || "declined"),
        } : {}),
      });
      // Approved, on a purchase waiting for it: the same confirm has to be sent again (AgentCard's
      // flow), and until 2026-10-23 nothing did — authorization_state was written and nothing read
      // it, so the purchase sat there. Now a one-off event turn is due at once, telling Reason to
      // repeat the SAME confirm with the SAME confirmation_id. That goes through the gate like any
      // other confirm (the yes is still unspent, inside its window, or it asks again), and an
      // approval is never said to be an order: only that confirm's answer can say so.
      if (kind === "approved" && row.status === "awaiting_approval") {
        db.createTimer(row.conversation_id, {
          fireAt: clock.now(),
          note: (`AgentCard reports ${user.conversation_id === row.conversation_id ? "the" : "a"} passkey approval went through for ${row.what || "the purchase"} (${row.merchant || "the shop"}).`
            + ` An approval is an authorization, not an order. Call purchase_confirm again NOW with conversation_id ${row.buy_conversation_id}, cart_hash ${row.cart_hash}`
            + ` and confirmation_id ${row.confirmation_id ?? "the one already granted"} — the same ones — and tell them only what that call says.`
            + ` If it is refused for an expired yes, ask them again with the cart; never say it is bought before an order comes back.`).slice(0, 1000),
        });
      }
      // The rest: nothing is said. The confirm call that is about to be repeated is the
      // only thing that knows whether the shop took the order. Declined/expired on a purchase that was
      // waiting IS said: the person tapped a link and walked away and is owed the news.
      if (ends) {
        const what = row.what ? `the ${row.what}` : "that purchase";
        say(user.conversation_id, kind === "expired"
          ? (row.kind === "flight"
            ? `heads up — the approval link for ${what} ran out, so nothing was booked and nothing was charged. fares move, so if you still want it i'll get a fresh price first and show it to you again.`
            : `heads up — the approval link for ${what} ran out, so nothing was bought and nothing was charged. say the word and i'll set it up again.`)
          : `${what} didn't go through — the payment was declined, so nothing was charged. want me to try a different card or a different shop?`);
      }
      log({ agentcard_webhook: event.type, purchase: row.buy_conversation_id, authorization: authId, ended: ends });
      return { status: 200, body: { ok: true, matched: true } };
    }

    // order.* -- keyed on data.order_id, and on data.conversation_id when that order is not on a row
    // yet. What happened to the order is never taken from the event: AgentCard's record of the order
    // is read (GET /buy/orders/{id}, then the conversation's `orders[]`) and that status is what the
    // row gets (reconcileOrder in src/tools.js). WHY it was cancelled is the one thing the event
    // carries that the reads may not: `canceled_reason` and `status_detail` are kept off the event
    // (first copy, never erased by a later null) before anybody is told, so the text can say it. Before 2026-10-24 this wrote `order_state = 'updated'` and
    // nothing else, and an order AgentCard cancelled stayed "placed". A cancellation moves the row to
    // cancelled and is said once. order.failed usually carries order_id null and so matches nothing;
    // it is logged, never pinned on a purchase by amount or time.
    case "order.placed":
    case "order.confirmed":
    case "order.updated":
    case "order.failed": {
      const kind = event.type.slice("order.".length);
      const orderId = data.order_id ?? "";
      const user = db.agentcardUserById(data.user_id ?? "");
      const byOrder = db.agentcardPurchaseByOrder(orderId);
      // order.placed can arrive before the confirm that placed it has written the order id (13:00:31
      // against 13:00:49 on 2026-10-24). Then the conversation finds the row, and the read below has
      // to list this order on it before anything is written.
      const row = byOrder ?? (orderId && data.conversation_id ? db.getAgentcardPurchase(data.conversation_id) : null);
      if (!row || (user && row.conversation_id !== user.conversation_id)) {
        log({ agentcard_webhook: event.type, unmatched_order: orderId || "none", code: data.code ?? undefined, billing_setup: agentcard.billingSetupRequired(data.code) || undefined });
        return { status: 200, body: { ok: true, matched: false } };
      }
      // The reason, as this event gives it. `status_detail` is the store's line for whatever stage the
      // order is at ("Your Dasher is nearby"), so it is only a cancellation's detail on a cancellation.
      const cancelling = agentcard.orderCancelled(data.status) || !!data.canceled_reason;
      const eventReason = cancelling ? { code: data.canceled_reason ?? "", detail: data.status_detail ?? "" } : null;
      if (byOrder && eventReason) db.noteAgentcardCancelReason(row.buy_conversation_id, eventReason);
      const annotate = {
        orderState: kind,
        chargeStatus: data.charge_status || undefined,
        // order.confirmed carries the shop's number and window itself.
        retailerOrderId: data.retailer_order_id || undefined,
        deliveryWindow: data.delivery_window || undefined,
      };
      if (byOrder) db.markAgentcardPurchase(row.buy_conversation_id, annotate);
      // A flight's order event, kept whole the first time: what a flight order.confirmed carries
      // (ticketing status, the airline's locator, ticket numbers) is not documented and has never been
      // seen. The row's ticketing state is never raised from it — only read from known fields, of
      // which there are none yet (src/flightbook.js TICKETING_FIELDS).
      if (row.kind === "flight") db.keepAgentcardOrderRaw(row.buy_conversation_id, { event: event.type, ...data });
      let r;
      try {
        r = await reconcileOrder({ buyConversationId: row.buy_conversation_id, orderId, say, eventStatus: data.status ?? "", eventReason });
      } catch (e) {
        r = { matched: !!byOrder, error: (e?.message ?? String(e)).split("\n")[0] };
      }
      if (!r.matched) {
        log({ agentcard_webhook: event.type, unmatched_order: orderId, conversation: row.buy_conversation_id, listed: r.listed ?? undefined, why: r.error ?? undefined });
        return { status: 200, body: { ok: true, matched: false } };
      }
      if (!byOrder) db.markAgentcardPurchase(row.buy_conversation_id, { chargeStatus: annotate.chargeStatus, retailerOrderId: annotate.retailerOrderId, deliveryWindow: annotate.deliveryWindow });
      log({
        agentcard_webhook: event.type, purchase: row.buy_conversation_id, order: orderId, via: byOrder ? "order" : "conversation",
        order_status: r.status ?? undefined, cancelled: r.cancelled || undefined, told: r.told || undefined,
        cancel_reason: r.cancelled ? (db.getAgentcardPurchase(row.buy_conversation_id)?.cancel_reason || "none") : undefined,
        read_failed: r.read === false ? (r.error || true) : undefined,
      });
      return { status: 200, body: { ok: true, matched: true, ...(r.cancelled ? { cancelled: true, told: !!r.told } : {}) } };
    }

    // connection.created arrives alongside vault.session_linked (seen in the real sandbox run,
    // 2026-10-23). The link is attached and exchanged on vault.session_linked, keyed on the session
    // Reason minted; this one carries nothing that handler needs, so it is logged and nothing else.
    case "connection.created":
      log({ agentcard_webhook: event.type, ignored: true, why: "handled by vault.session_linked" });
      return { status: 200, body: { ok: true, ignored: event.type } };

    default:
      log({ agentcard_webhook: event.type, ignored: true });
      return { status: 200, body: { ok: true, ignored: event.type } };
  }
}

/**
 * Google's redirect back, as a function, so a test can drive the whole handshake without a socket.
 *
 * Nothing about a token is on the page that comes back, in the log line, or in the text. What the
 * person sees in their browser is that it worked; what they get in their messages is which address
 * is connected, which is the one fact they cannot see for themselves.
 *
 * The text is best-effort on purpose. If delivery fails, the connection is still real and the next
 * thing they ask will use it — so a failed text is logged and the page still says yes, rather than
 * the browser being shown an error about something that worked.
 */
export async function googleCallbackRequest({ code, state, error = "", runtime = null, log = () => {}, fetchImpl = null } = {}) {
  const out = await google.completeConnect({ code, state, error, ...(fetchImpl ? { fetchImpl } : {}) });
  log({ google_callback: out.ok ? "connected" : out.reason, conversation: out.conversationId ?? null });

  if (out.ok && runtime?.say) {
    try {
      runtime.say(out.conversationId, google.connectedLine(out));
    } catch (e) {
      log({ google_connected_text_failed: out.conversationId, why: (e?.message ?? String(e)).split("\n")[0] });
    }
  }

  return {
    status: out.ok ? 200 : 400,
    headers: HTML(),
    body: renderConnected({
      ok: out.ok,
      title: out.ok ? "Google connected" : "Not connected",
      lines: out.ok
        ? [out.email ? `Reason can now work with ${out.email}.` : "Reason can now work with this account."]
        : [out.error],
      back: { text: out.ok ? "connected google, keep going" : "google didn't connect" },
    }),
  };
}

/**
 * One request for a page. Pulled out of the server so a test can drive the whole access dance —
 * link, code, cookie, choice — without a socket.
 *
 * Nothing here leaks whether an id is real. A page that does not exist, a method that makes no
 * sense for it, and a choice on somebody else's page all answer the same way as a bad link.
 *
 * That was not true until 2026-10-10: an id with no row answered 404 "Not found" while a real
 * private page answered 401 and the code gate, so anybody could sort guessed links into real and
 * imaginary without ever opening one. An id is a capability here — the owner's link is the whole
 * authentication story — so telling a stranger that one is live is telling them what to attack.
 * A missing row is therefore served as a page that exists and can never be opened: the same 401,
 * the same gate, the same wrong-code answer, the same rate limit counted against the same table.
 * `checkAccess` can never allow a ghost (no owner key to match, no session to find, never shared),
 * so this cannot hand out a page that is not there.
 */
export async function pageRequest({ id, sub = null, isChoice, key = null, method, headers, readBody, runtime, log = () => {} }) {
  const real = db.getPage(id);
  const page = real ?? { id, conversation_id: null, title: "", blocks: [], shared: 0, owner_key: null };

  const cookie = readCookie(headers?.cookie);
  const access = checkAccess({ page, cookie, key });
  const cookiePath = headers?.["x-files-domain"] ? "/" : "/p/";

  // ---- the owner tapped an answer ----
  if (sub === "choice" || isChoice) {
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
    let send = false;
    const raw = (await readBody()) ?? "";
    const ct = String(headers?.["content-type"] ?? "");
    if (ct.includes("application/json")) {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      code = parsed?.code ?? "";
      send = !!parsed?.send;
    } else {
      const form = new URLSearchParams(raw);
      code = form.get("code") ?? "";
      send = form.has("send");
    }

    // "Text me the code". Only the owner's own link may ask, and only a real page has anyone to
    // text; a bare link or a ghost id gets the plain gate back, and nothing goes anywhere.
    if (send) {
      if (!access.via_key || !real || access.reason === "rate_limited") return gateFor(access, page, { real });
      const asked = requestCode(page);
      if (!asked.ok) {
        log({ page_code_refused: page.id, reason: asked.reason });
        return gateFor(access, page, {
          real, sent: true,
          error: `Reason has already texted ${config.ownerName} a code. Use that one, or try again in about ${Math.ceil(asked.retry_after_s / 60)} minutes.`,
        });
      }
      if (runtime?.say) {
        try { runtime.say(page.conversation_id, asked.line); } catch (e) { log({ page_code_text_failed: page.id, why: (e?.message ?? String(e)).split("\n")[0] }); }
      }
      log({ page_code_sent: page.id });
      return gateFor(access, page, { real, sent: true });
    }

    const tried = trySubmittedCode({ page, code });
    if (tried.ok) {
      log({ page_opened: page.id });
      return {
        status: 200,
        headers: HTML({ "Set-Cookie": cookieHeader(tried.token, { path: cookiePath }) }),
        body: renderPage(page, {
          interactive: true, picked: db.pageChoicesFor(page.id),
          related: relatedFor(page, true), ...whoseLine(page),
        }),
      };
    }
    const why = tried.reason === "rate_limited"
      ? `Too many wrong codes. Try again in about ${Math.ceil((tried.retry_after_s ?? 900) / 60)} minutes.`
      : tried.reason === "expired"
        ? `That code has expired. Ask ${config.ownerName === "" ? "the owner" : "Reason"} for a new one.`
        : `That code is not right.${tried.tries_left ? ` ${tried.tries_left} ${tried.tries_left === 1 ? "try" : "tries"} left.` : ""}`;
    log({ page_code_failed: page.id, reason: tried.reason });
    return gateFor(access, page, { real, status: tried.reason === "rate_limited" ? 429 : 401, error: why });
  }

  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, headers: HTML(), body: renderNotFound() };
  }

  // ---- showing it ----
  // A GET never signs a browser in and never texts anything, however many times a link preview
  // fetches it: the only way in is the code, and the only thing that sends one is the button.
  if (access.allow) {
    return {
      status: 200,
      headers: HTML(),
      body: renderPage(page, {
        interactive: access.interactive,
        picked: access.interactive ? db.pageChoicesFor(page.id) : {},
        related: relatedFor(page, access.interactive),
        ...whoseLine(page),
      }),
    };
  }
  if (access.reason === "rate_limited") {
    return gateFor(access, page, {
      real, status: 429,
      error: `Too many wrong codes. Try again in about ${Math.ceil((access.retry_after_s ?? 900) / 60)} minutes.`,
    });
  }
  return gateFor(access, page, { real });
}

/**
 * The locked screen, shaped by what the request proved. With the owner's key on a real page it
 * offers the code and carries the page's preview tags (the card under the owner's own text stays
 * the page's). Without, it is the plain gate: the same bytes for a real id and an imaginary one.
 */
function gateFor(access, page, { real, status = 401, sent = false, error = "" }) {
  const canSend = !!(access.via_key && real);
  return {
    status,
    headers: HTML(),
    body: renderCodeGate({
      title: "Private page", error, ownerName: config.ownerName,
      canSend, sent: canSend && sent, preview: canSend ? page : null,
    }),
  };
}

/**
 * One request for the status page (src/ops.js).
 *
 * The owner's proved browser — a session cookie whose conversation is an operator's, earned on any
 * page of theirs — sees it. Anyone else gets the private-page gate, with "Text me the code" on
 * offer only to a request carrying the key from the link Reason itself hands out, so a stranger
 * who finds /ops can make nothing happen on the owner's phone. The page carries people's names
 * and numbers, which is why it is not simply the key.
 *
 * Pulled out of the server for the same reason pageRequest is: the whole dance is drivable in a
 * test without a socket.
 */
export async function opsRequest({ json = false, key = null, focus = null, via = null, method, headers, remoteAddress = "", readBody, runtime, router = null, log = () => {} }) {
  const page = { ...ops.PAGE, conversation_id: config.ownerConversation };
  const cookie = readCookie(headers?.cookie);
  const owner = db.pageSessionOwner(cookie, SESSION_TTL_MS);
  const signedIn = !!owner && accounts.isOperatorConversation(owner);
  const via_key = ops.keyMatches(key);
  const focusId = typeof focus === "string" && /^[a-z0-9_:.-]{1,64}$/i.test(focus) ? focus : null;
  // With a password set the gate asks for it, unless the owner followed "Text me a code instead".
  const usePassword = opspw.passwordEnabled() && via !== "code";
  // Where "Text me a code instead" goes, and where the password gate goes back to: this address
  // with the key kept, so the code can still be sent.
  const here = (extra = {}) => {
    const q = new URLSearchParams();
    if (key) q.set("k", key);
    if (focusId) q.set("focus", focusId);
    for (const [k, v] of Object.entries(extra)) if (v != null) q.set(k, v);
    const s = q.toString();
    return `/ops${s ? `?${s}` : ""}`;
  };
  const gate = ({ status = 401, sent = false, error = "" } = {}) => ({
    status,
    headers: HTML(),
    body: usePassword
      ? renderPasswordGate({ error, codeHref: via_key ? here({ via: "code" }) : null })
      : renderCodeGate({ title: page.title, error, ownerName: config.ownerName, canSend: via_key, sent: via_key && sent, preview: null,
        passwordHref: opspw.passwordEnabled() ? here() : null }),
  });
  const signIn = (token) => ({
    // 303 back to the page: a refresh afterwards is a GET, not the password posted again. Path "/"
    // rather than the pages' "/p/": this cookie has to come back on /ops, and a session is valid
    // for every page of the owner's anyway.
    status: 303,
    headers: { ...HTML(), Location: focusId ? `/ops?focus=${encodeURIComponent(focusId)}` : "/ops", "Set-Cookie": cookieHeader(token, { path: "/" }) },
    body: "",
  });

  // ---- the owner's two buttons ----
  // Only a signed-in browser gets here; the cookie is SameSite=Lax, so a form on some other site
  // cannot press them. "Check again" is the scheduled pass, now. "Clear" restarts one windowed
  // row's count from this moment and runs the pass with that row kept quiet — they know.
  //
  // The page's own script asks for JSON (2026-10-24: the pass takes as long as the slowest provider,
  // and a button that shows nothing for that long reads as broken). Then the pass is started and
  // not waited for: the answer is 202 at once, and the page follows the rows in /ops.json as they
  // are decided. Without script the form posts as it always has and the answer is the finished page.
  if (method === "POST" && signedIn) {
    const form = new URLSearchParams((await readBody()) ?? "");
    const action = form.get("action");
    const wantsJson = /application\/json/i.test(headers?.accept ?? "");
    const run = (opts) => {
      const pass = ops.runOnce({ runtime, router, log, ...opts });
      if (!wantsJson) return pass;
      pass.catch(() => {}); // runOnce answers null rather than throwing; this is only belt and braces
      return null;
    };
    let cleared = false;
    if (action === "check") {
      await run({});
      log({ ops_checked_by_owner: true });
    } else if (action === "clear") {
      const id = form.get("id") ?? "";
      if ((cleared = ops.clearCheck(id))) {
        await run({ silent: new Set([id]) });
        log({ ops_cleared_by_owner: id });
      }
    }
    if (wantsJson) {
      const running = ops.progress();
      return { status: running ? 202 : 200, headers: JSONH, body: JSON.stringify({ ok: true, action, cleared, running }) };
    }
    return { status: 200, headers: HTML(), body: renderOps({ report: ops.snapshot(), now: clock.now(), focus: focusId }) };
  }

  if (method === "POST" && !signedIn) {
    const form = new URLSearchParams((await readBody()) ?? "");
    // ---- the password ----
    if (form.has("password") && opspw.passwordEnabled()) {
      const ip = opspw.clientIp(headers ?? {}, remoteAddress);
      const tried = await opspw.tryPassword({ password: form.get("password"), ip });
      if (tried.ok) {
        const token = randomBytes(32).toString("base64url");
        db.startPageSession(page.id, token, { conversationId: page.conversation_id ?? null });
        log({ ops_opened: "password", ip });
        return signIn(token);
      }
      // Never what was typed: only that it was wrong, and from where.
      log({ ops_password_failed: tried.reason, ip });
      if (tried.reason === "locked") {
        return gate({ status: 429, error: `Too many wrong passwords. Try again in about ${Math.ceil(tried.retry_after_s / 60)} minutes.` });
      }
      return gate({ error: `That password is not right.${tried.tries_left ? ` ${tried.tries_left} ${tried.tries_left === 1 ? "try" : "tries"} left.` : ""}` });
    }
    if (form.has("send")) {
      if (!via_key) return gate();
      const asked = requestCode(page);
      if (!asked.ok) {
        log({ ops_code_refused: asked.reason });
        return gate({ sent: true, error: `Reason has already texted ${config.ownerName} a code. Use that one, or try again in about ${Math.ceil(asked.retry_after_s / 60)} minutes.` });
      }
      if (runtime?.say) {
        try { runtime.say(page.conversation_id, asked.line); } catch (e) { log({ ops_code_text_failed: (e?.message ?? String(e)).split("\n")[0] }); }
      }
      log({ ops_code_sent: true });
      return gate({ sent: true });
    }
    const tried = trySubmittedCode({ page, code: form.get("code") ?? "" });
    if (tried.ok) {
      log({ ops_opened: "code" });
      return signIn(tried.token);
    }
    const why = tried.reason === "rate_limited"
      ? `Too many wrong codes. Try again in about ${Math.ceil((tried.retry_after_s ?? 900) / 60)} minutes.`
      : `That code is not right.${tried.tries_left ? ` ${tried.tries_left} ${tried.tries_left === 1 ? "try" : "tries"} left.` : ""}`;
    log({ ops_code_failed: tried.reason });
    return gate({ status: tried.reason === "rate_limited" ? 429 : 401, error: why });
  }

  if (method !== "GET" && method !== "HEAD") return { status: 405, headers: HTML(), body: renderNotFound() };
  if (!signedIn) {
    if (!usePassword && db.failedPageAttempts(page.id, ATTEMPT_WINDOW_MS) >= MAX_FAILED_ATTEMPTS) {
      return gate({ status: 429, error: `Too many wrong codes. Try again in about ${Math.ceil(ATTEMPT_WINDOW_MS / 60000)} minutes.` });
    }
    return gate();
  }
  const report = ops.snapshot();
  if (json) {
    const now = clock.now();
    const running = ops.progress();
    return {
      status: 200,
      headers: JSONH,
      body: JSON.stringify({
        ok: true, now, stale: !!report && now - report.at > ops.STALE_AFTER_MS,
        // The pass in flight, for the page to fill rows in as they are decided: { started_at,
        // checks: [{ id, state, detail, … }] } in the order decided, and `total` — how many rows the
        // last pass had — so the page can say "12 of 41". Null between passes.
        running: running ? { ...running, total: report?.checks?.length ?? null } : null,
        report,
      }),
    };
  }
  return { status: 200, headers: HTML(), body: renderOps({ report, now: clock.now(), focus: focusId }) };
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
    // The same for Uber, and one extra field: whether this install is pointed at Uber's sandbox,
    // where a request creates no real trip. "Did that book a real car" must be answerable from the
    // health page and not from whoever remembers what is in the environment.
    uber: (() => {
      const st = uber.uberStatus();
      return { app_configured: st.connected, missing: st.missing, redirect_uri: st.redirect_uri, sandbox: st.sandbox };
    })(),
    open_tasks: db.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE state IN ('running','waiting')").get().n,
    due_tasks: db.dueTasks().length,
    pending_timers: db.db.prepare("SELECT COUNT(*) AS n FROM timers WHERE fired_at IS NULL AND cancelled_at IS NULL").get().n,
    // A timer whose turn has failed at least once and is still owed, and the ones Reason gave up
    // on and said so about. Anything other than zero in the first is a reminder running late.
    retrying_timers: db.db.prepare("SELECT COUNT(*) AS n FROM timers WHERE attempts > 0 AND last_error IS NOT NULL AND fired_at IS NULL AND cancelled_at IS NULL").get().n,
    missed_timers: db.db.prepare("SELECT COUNT(*) AS n FROM timers WHERE gave_up_at IS NOT NULL").get().n,
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
