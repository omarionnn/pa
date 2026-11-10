// The listener inbound webhooks arrive on. node:http, no framework — a framework would be more
// code than the thing it wraps. Every route is matched by a regex in `createServer` below, and
// that is the list of record; this one is a reader's index and goes stale if nobody tends it.
//
//   GET  /health                      is it up, and what is it actually running
//   GET  /alive                       the watchdog's cheap liveness read (loop lag, sweep age)
//   POST /channels/{name}/webhook     one provider delivery, verified and parsed by that adapter
//   POST /calls/{name}/webhook/{tok}  one call ended, pushed back by the call provider
//   POST /calls/gptlive/inbound       somebody is ringing: the number's Twilio voice webhook (GPT-Live)
//   POST /calls/gptlive/status/{tok}  one GPT-Live call's Twilio status (and /amd/{tok}, its machine verdict)
//   GET  /p/{id}                      one page the owner opens from a link
//   POST /p/{id}                      the one-time code for a private page
//   POST /p/{id}/choice               the owner tapped an answer on their own page
//   GET  /p/{id}/card.png             the preview image iMessage draws for that link
//   GET  /p/{id}/preview.mp4          the animated preview, same link
//   GET  /img/{name}.(png|jpg|webp|gif)  one picture Reason generated or copied, off disk
//   GET  /f/{id}                      one document Reason wrote, by the owner's own keyed link
//   GET  /i/{token}                   an invite link (also /p/i/{token}); a read that never spends it
//   GET  /e/{id}/cover.jpg            an event link's card picture (src/eventcover.js); public, versioned
//   GET  /e/{id}/cover-preview.jpg?k= the organizer's look at a cover still waiting on them
//   GET  /e/{id}/album[/manage]       the event's private photo album (src/pages/album.js); role read per request
//   GET  /e/{id}/album/photo/{n}      one photo's bytes; /album/download the whole album as a ZIP
//   GET  /s/{shareId}[/og.png]        a shared stamp (12 base62, src/pages/webstamps.js); no live share → the 404 page (picture: plain 404)
//   GET  /s/{token}                   a sign-in link: Reason's own browser, shown to one person
//   GET  /s/{token}/view              one picture of that browser, with the shape of its form
//   POST /s/{token}/{action}          start, tap, type, key, scroll, back, done, cancel
//   POST /access/web                  a number left on the website's form, signed by the form's server
//   /ios/v1/…                         the iPhone app's JSON API (src/ios/, docs/ios-api.md); REASON_IOS_API, off by default
//   GET  /web                         Reason Web (src/pages/websignin.js): sign in by number, or (signed in) the conversation
//   POST /web/signin|code|signout     ask for the code, type it, sign this browser out — all 404 while REASON_WEB is off
//   GET  /web/history|stream, POST /web/send   the conversation: older/newer lines, live events, a message (src/pages/webconvo.js)
//   POST /web/send/cancel             §4h "take it back": a Web message taken back before Reason starts on it
//   POST /web/about                   Reason speaks first about one Ongoing row (an item's "… in the chat →")
//   GET  /web/live                    the same live events, asked for on the pages host by the website's page (CORS: that origin only)
//   POST /web/upload, GET /web/media/…   a photo, PDF or voice note in; files back, signed in only (src/webmedia.js)
//   GET  /web/memory, POST /web/memory/correct|forget|guess   what Reason remembers (src/pages/webmemory.js)
//   GET  /web/memory/history          chat history by day, a day read-only, message search (src/pages/webhistory.js)
//   GET/POST /web/settings            Settings (src/pages/websettings.js)
//   GET  /web/approve/{token}, POST …/verify|decline|cvc, GET /web/connect/passkey, POST …/verify   purchase approval by passkey (src/pages/webapprove.js; REASON_PASSKEY_PAY)
//   GET  /web/connect/{token}[/state], POST …/answer|card, GET /web/connect/island.js|jwks.json|new-card   store sign-in + card for Crossmint checkouts (src/pages/webconnect.js; REASON_SHOP_CONNECT)
//   GET  /web/stamps, POST /web/api/stamps/{id}/share[/revoke], GET …/{id}/image.png, …/{id}/story.png   Stamps (src/pages/webstamps.js; REASON_WEB_DAILY or REASON_STAMPS_ALL)
//   GET  /web/signal                  what needs them / just finished, for the tab title and notifications (src/pages/webnotify.js)
//   GET  /web/icons/{file}            Web's favicons and home-screen icon (src/pages/webnotify.js)
//   GET  /web/saved[/<kind>/<id>], POST /web/saved/pin|remove|restore   Saved (src/pages/websaved.js; index src/saved.js)
//   GET  /web/ongoing/{approval|task|timer|series}/{id}   one Ongoing row's detail; /web/ongoing/{hand|back} a group's See all; /web/ongoing/state (src/pages/webongoing.js)
//   GET  /web/fonts/{serif|roman|hand|handbold|sans}.woff2  Web's own faces (src/pages/webkit.js; 404 while off)
//        /web…  on the pages host, not signed by the website: 301 to {REASON_SITE_URL}/web… (src/pages/siteproxy.js)
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
import * as zonescope from "./zonescope.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as accounts from "./accounts.js";
import * as db from "./db.js";
import { renderPage, renderCodeGate, renderPasswordGate, renderNotFound, esc as escapeAttr } from "./pages/render.js";
import * as opspw from "./opspassword.js";
import { webMovedTo } from "./pages/siteproxy.js";
import { checkAccess, trySubmittedCode, requestCode, codeHost, readCookie, readCookies, cookieHeader, clearCookieHeader, pageUrl, SESSION_TTL_MS, ATTEMPT_WINDOW_MS, MAX_FAILED_ATTEMPTS } from "./pages/access.js";
import { choiceBlock } from "./pages/content.js";
import * as ops from "./ops.js";
import { guardResponse } from "./opsredact.js";
import * as subusage from "./subusage.js";
import { renderOps } from "./pages/ops.js";
import { settleCall, fillLateDetails, reconcileOrder } from "./tools.js";
import { LIVE_STATES } from "./calls/provider.js";
import * as gptlive from "./calls/gptlive.js";
import { acceptUpgrade } from "./calls/wsserver.js";
import * as spotify from "./spotify.js";
import * as google from "./google.js";
import * as github from "./github.js";
import * as uber from "./uber.js";
import * as agentcard from "./agentcard.js";
import * as parallel from "./parallel.js";
import * as x from "./x.js";
import { connectStartRequest, refuseForeignBrowser, START_PATH as CONNECT_START_PATH } from "./connectgate.js";
import { renderNotice, renderConnected, dark, THEME, iconLinks } from "./pages/render.js";
import { wordmark, WORDMARK_CSS } from "./pages/wordmark.js";
import { BRAND_PEN, BRAND_PEN_DARK, PAPER, PAPER_GRAIN } from "./pages/brand.js";
import { homePage, privacyPage, termsPage } from "./pages/site.js";
import { pageCard, shootWithChromium } from "./pages/card.js";
import { madeKind, renderMadePage, callAudio, notYoursFor, archivedFor, privateHead, privateOgPng, PRIVATE_OG_VERSION } from "./pages/madedata.js";
import { previewRequest } from "./pages/preview.js";
import { securedImageRequest } from "./pages/securedcard.js";
import { mimeForKind } from "./documents/store.js";
import { isContactPath, contactPathParts, vcard, lineNumber, liveLineNumber, cardName } from "./contact.js";
import { inviteRequest, inviteCardName } from "./invites.js";
import { inviteCard } from "./invitecard.js";
import { eventPageRequest } from "./pages/event.js";
import { webRequest, webFont, webSignedIn, sameOrigin, SECURITY_HEADERS as WEB_SECURITY_HEADERS } from "./pages/websignin.js";
// Web chats' titles are written as their first reply lands (src/webchats.js installs that listener on import).
import "./webchats.js";
import { webOn, joinNumber, siteOrigin } from "./web.js";
import * as eventsmod from "./events.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { remoteRequest, PATH as SIGNIN_PATH } from "./signin-remote.js";
// Stamps (REASON_WEB_DAILY, or everyone at REASON_STAMPS_ALL): awarded as errands finish (src/stamps.js listens on db.completionBus once loaded).
import * as stamps from "./stamps.js";
// The free trial and the subscription (REASON_PAYWALL): Stripe's webhook and the two pages it sends people back to.
import * as plan from "./plan.js";
import * as stripeapi from "./stripe.js";
import { config, stamp, clock } from "./config.js";

const MAX_BODY = 1_000_000;

export function createServer({ router, runtime, log = () => {} }) {
  // A new stamp is mentioned in the thread through the runtime's own send, and only while REASON_WEB_DAILY is on (never at REASON_STAMPS_ALL alone).
  stamps.installStamps({ tell: typeof runtime?._tell === "function" ? (c, text, meta) => runtime._tell(c, text, meta) : null, log });
  // Each request opens a scope with no person in it; the moment a signed-in cookie names one
  // (db.pageSessionOwner / pageSessionPeek), times on that page are drawn on their clock.
  const server = nodeCreateServer((req, res) => zonescope.runOpen(() => handleRequest(req, res)));
  // The one WebSocket Reason accepts: Twilio's media stream for a GPT-Live call (src/calls/gptlive.js).
  // Only listened for with REASON_CALL_VOICE set (gptlive / on / owner); otherwise an upgrade is
  // refused by Node exactly as it always was.
  if (gptlive.gptliveOn()) {
    server.on("upgrade", (req, socket) => {
      socket.on("error", () => { /* a dropped stream is the call ending, never the process */ });
      // Nothing thrown here may escape: an upgrade listener's throw is an uncaught exception, and
      // anybody on the internet can send an upgrade with a URL that will not parse.
      try {
        const path = new URL(req.url, "http://localhost").pathname;
        if (!path.startsWith(gptlive.STREAM_PATH)) return void socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        const ws = acceptUpgrade(req, socket);
        if (!ws) return;
        try {
          gptlive.acceptStream({ token: path.slice(gptlive.STREAM_PATH.length), socket: ws, settle: settleCall, runtime, log });
        } catch (e) {
          log({ gptlive_stream_failed: (e?.message ?? String(e)).split("\n")[0] });
          ws.close(1011);
        }
      } catch {
        socket.destroy();
      }
    });
  }
  return server;
  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    // The status page's key goes out on the status page only: never on Web, a page, or anything else (src/opsredact.js).
    if (url.pathname !== "/ops" && url.pathname !== "/ops.json") guardResponse(res);
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    };

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        // Anybody can ask, so a stranger gets counts and kinds, never a person (security lead 17).
        // The rows themselves are for the operator's signed-in browser: the status page's session.
        return send(200, health({ router, runtime, full: operatorSignedIn(req.headers) }));
      }
      // What the watchdog asks every minute (scripts/watchdog.mjs): answering at all says the event
      // loop is turning; the body says how late it is and whether the sweep is still finishing.
      if (req.method === "GET" && url.pathname === "/alive") {
        return send(200, ops.alive({ runtime }));
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
        const asset = assetRequest({ pathname: url.pathname, router }) ?? securedImageRequest(url.pathname);
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
          bounced: url.searchParams.get("r") === "1",
          method: req.method,
          headers: req.headers,
          remoteAddress: req.socket?.remoteAddress ?? "",
          readBody: () => readBody(req),
          runtime,
          router,
          log,
        });
        // Never framed by another site (security run-3 hardening): the page is the owner's control panel.
        // Only frame-ancestors, so the page's inline CSS and script are untouched.
        res.writeHead(out.status, { ...out.headers, "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });
        return res.end(req.method === "HEAD" ? "" : out.body);
      }

      // ---------- an event's pages ----------
      // The public join page and the who's-going page (src/pages/event.js). `/p/e/…` is the same
      // link arriving through the files domain, which Caddy rewrites under /p.
      const eventRoute = /^(?:\/p)?\/e\/([A-Za-z0-9_-]{16})(?:\/(join|who|signin|signout|manage|cover\.jpg|cover-preview\.jpg|album|album\/manage|album\/download|album\/photo\/\d{1,12}|calendar\.ics))?$/.exec(url.pathname);
      if (eventRoute) {
        const out = await eventRequestFor({
          publicId: eventRoute[1], sub: eventRoute[2] || null, method: req.method,
          query: Object.fromEntries(url.searchParams), headers: req.headers, remoteAddress: req.socket?.remoteAddress ?? "",
          readBody: () => readBody(req), runtime, router, log,
        });
        res.writeHead(out.status, out.headers);
        return res.end(req.method === "HEAD" ? "" : out.body);
      }

      // ---------- the iPhone app's API (src/ios/, docs/ios-api.md) ----------
      // Off (the default): these paths fall through to the same flat 404 as any path nobody was issued.
      if (config.iosApi && /^\/ios\/v1(?:\/|$)/.test(url.pathname)) {
        let out;
        try {
          const { iosApiRequest } = await import("./ios/api.js");
          out = await iosApiRequest({ path: url.pathname.slice("/ios/v1".length) || "/", method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers, remoteAddress: req.socket?.remoteAddress ?? "", readBody: () => readAllBody(req), runtime, router, log });
        } catch (e) {
          log({ http: "/ios/v1", threw: (e?.message ?? String(e)).split("\n")[0] });
          return send(500, { ok: false, error: "server_error" });
        }
        // null: REASON_IOS_API=owner and this isn't the owner. It falls through to what an unissued path answers.
        if (out) {
          res.writeHead(out.status, out.headers);
          if (out.stream) {
            if (req.method === "HEAD") return res.end();
            try { return out.stream(res, req); } catch (e) { log({ http: "/ios/v1/live", threw: (e?.message ?? String(e)).split("\n")[0] }); return res.end(); }
          }
          return res.end(req.method === "HEAD" ? "" : out.body);
        }
      }

      // ---------- Reason Web ----------
      // Sign in by number, the code, the signed-in landing, sign out (src/pages/websignin.js). While
      // REASON_WEB is off these paths fall through to the same flat 404 as any path nobody was issued.
      // The site's two display faces for these pages, cached a week; off, the same flat 404.
      // Web's home is the website (heyreason.com/web, proxied here and signed). The same paths asked of
      // the pages host directly answer 301 to it, same path and query (src/pages/siteproxy.js).
      // One exception: /web/live, the conversation's live stream, which the website's page opens on this
      // host on purpose — the website's proxy buffers a stream (src/web.js webStreamOrigin).
      const webMoved = /^\/web(?:\/|$)/.test(url.pathname) && url.pathname !== "/web/live" && webOn() ? webMovedTo(req.headers, `${url.pathname}${url.search}`) : null;
      if (webMoved) {
        res.writeHead(301, { Location: webMoved, "Content-Length": 0, "Cache-Control": "no-store" });
        return res.end();
      }
      // Web's own icons (src/pages/webnotify.js): the favicons, their filled "needs you" twins, the home-screen icon.
      const webIconRoute = /^\/web\/icons\/([a-z-]+\.(?:svg|png))$/.exec(url.pathname);
      const iconOut = webIconRoute && webOn() && (req.method === "GET" || req.method === "HEAD") ? (await import("./pages/webnotify.js")).webIcon(webIconRoute[1]) : null;
      if (iconOut) {
        res.writeHead(iconOut.status, iconOut.headers);
        return res.end(req.method === "HEAD" ? "" : iconOut.body);
      }
      const webFontRoute = /^\/web\/fonts\/([a-z]+)\.woff2$/.exec(url.pathname);
      const fontOut = webFontRoute && webOn() && (req.method === "GET" || req.method === "HEAD") ? webFont(webFontRoute[1]) : null;
      if (fontOut) {
        res.writeHead(fontOut.status, fontOut.headers);
        return res.end(req.method === "HEAD" ? "" : fontOut.body);
      }
      // E5 (src/pages/webedge.js): the owner's maintenance switch is on, so every /web address answers
      // "Tidying up for a few minutes" (503) until the time it names. The faces above still load; a
      // page's own script asking for JSON is told the same in JSON. Texting Reason is untouched.
      if (webOn() && /^\/web(?:\/|$)/.test(url.pathname)) {
        const edge = await import("./pages/webedge.js");
        const m = edge.maintenance(clock.now());
        if (m.on) {
          const retry = String(Math.max(60, Math.ceil((m.until - clock.now()) / 1000)));
          if (String(req.headers.accept ?? "").includes("application/json") || req.method === "OPTIONS") {
            return send(503, { ok: false, error: "maintenance", until: m.until });
          }
          const body = edge.renderMaintenance({ until: m.until, joinNumber: joinNumber(router) });
          res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", ...WEB_SECURITY_HEADERS, "Retry-After": retry, "Content-Length": Buffer.byteLength(body) });
          return res.end(req.method === "HEAD" ? "" : body);
        }
      }
      // A browser reconnecting the live stream across hosts sends Last-Event-ID, which needs a preflight:
      // answered for the website's own origin only, carrying nothing (src/pages/webconvo.js liveStreamRequest).
      if (url.pathname === "/web/live" && req.method === "OPTIONS" && webOn()) {
        const site = siteOrigin();
        const ok = !!site && String(req.headers.origin ?? "") === site;
        res.writeHead(ok ? 204 : 403, ok ? { "Access-Control-Allow-Origin": site, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "last-event-id", "Access-Control-Max-Age": "600", Vary: "Origin", "Content-Length": 0 } : { "Content-Length": 0 });
        return res.end();
      }
      // Photos, PDFs and voice notes (src/webmedia.js): POST /web/upload, and GET /web/media/… behind
      // sign-in only — the conversation's own files and what was texted in, never a public address.
      if (webOn() && (url.pathname === "/web/upload" || url.pathname.startsWith("/web/media/"))) {
        let out;
        try {
          const { webMediaRoute, readRaw } = await import("./webmedia.js");
          out = await webMediaRoute({ path: url.pathname, method: req.method, headers: req.headers, readBody: (max) => readRaw(req, max), log });
        } catch (e) {
          // An approval link's token is a bearer secret: never in the journal.
      log({ http: url.pathname.replace(/^(\/web\/approve\/)[^/]+/, "$1…"), threw: (e?.message ?? String(e)).split("\n")[0] });
          return send(500, { ok: false, error: "server error" });
        }
        res.writeHead(out.status, out.headers);
        return res.end(req.method === "HEAD" ? "" : out.body);
      }
      // Connect (src/pages/webconnect.js): sign in to a store, add a card, for Crossmint checkouts. Behind
      // REASON_SHOP_CONNECT; off, the same flat 404 as any path nobody was issued.
      // Purchase approval by passkey (src/pages/webapprove.js, src/passkey.js): the Face ID link for one
      // payment, and setting Face ID up. Behind REASON_PASSKEY_PAY and REASON_SHOP_CONNECT; off, a flat 404.
      const approveRoute = /^\/web\/approve\/([A-Za-z0-9_-]{20,64}(?:\/(?:verify|decline|cvc))?)$/.exec(url.pathname);
      const setupRoute = /^\/web\/connect\/passkey(?:\/(verify))?$/.exec(url.pathname);
      if ((approveRoute || setupRoute) && webOn() && (await import("./shopconnect.js")).connectMode() !== "off" && (await import("./passkey.js")).passkeyMode() !== "off") {
        let out = null;
        try {
          const pages = await import("./pages/webapprove.js");
          if (approveRoute) out = await pages.approveRequest({ sub: approveRoute[1], method: req.method, headers: req.headers, readBody: () => readBody(req), log });
          else {
            const { sessionAccount } = await import("./pages/websignin.js");
            out = await pages.passkeySetupRequest({ verb: setupRoute[1] ?? "", method: req.method, headers: req.headers, account: sessionAccount(req.headers), readBody: () => readBody(req), log });
          }
        } catch (e) {
          log({ http: "/web/approve", threw: (e?.message ?? String(e)).split("\n")[0] });
          return send(500, { ok: false, error: "server error" });
        }
        if (out) {
          res.writeHead(out.status, out.headers);
          return res.end(req.method === "HEAD" ? "" : out.body);
        }
      }
      const connectRoute = /^\/web\/connect\/([A-Za-z0-9_-]{1,64}(?:\/(?:state|answer|card))?|island\.js|jwks\.json)$/.exec(url.pathname);
      // /web/connect/passkey is never a store-link token: a setup page that answered nothing falls to the plain 404.
      if (connectRoute && !setupRoute && webOn() && (await import("./shopconnect.js")).connectMode() !== "off") {
        let out = null;
        try {
          const { connectRequest } = await import("./pages/webconnect.js");
          const { sessionAccount } = await import("./pages/websignin.js");
          out = await connectRequest({ sub: connectRoute[1], method: req.method, account: sessionAccount(req.headers), readBody: () => readBody(req), log });
        } catch (e) {
          log({ http: "/web/connect", threw: (e?.message ?? String(e)).split("\n")[0] });
          return send(500, { ok: false, error: "server error" });
        }
        if (out) {
          res.writeHead(out.status, out.headers);
          return res.end(req.method === "HEAD" ? "" : out.body);
        }
      }
      // Ongoing's own pages (src/pages/webongoing.js): one row's detail, and the small state the Ongoing pages poll.
      const ongoingRoute = /^\/web\/ongoing(?:\/(state|hand|back)|\/(approval|task|timer|series)(?:\/(\d{1,12}))?)?$/.exec(url.pathname);
      const webRoute = ongoingRoute ?? /^\/web(?:\/(signin|code|signout|history|stream|live|send|about|memory|settings|signal))?$/.exec(url.pathname)
        ?? /^\/web\/(memory\/(?:correct|forget|guess|history))$/.exec(url.pathname)
        ?? /^\/web\/(chats\/recent)$/.exec(url.pathname)
        ?? /^\/web\/(daily\/(?:answer|later))$/.exec(url.pathname)
        ?? /^\/web\/(send\/cancel)$/.exec(url.pathname)
        ?? /^\/web\/(stamps|api\/stamps\/\d{1,12}\/(?:share(?:\/revoke)?|image\.png|story\.png))$/.exec(url.pathname)
        ?? /^\/web\/(saved(?:\/(?:pin|remove|restore|(?:page|call|receipt|event|album)\/[A-Za-z0-9_-]{1,40}|page\/[A-Za-z0-9_-]{1,40}\/frame))?)$/.exec(url.pathname);
      if (webRoute && webOn()) {
        let out;
        try {
          out = ongoingRoute
            ? webSignedIn(await (await import("./pages/webongoing.js")).ongoingRequest({ kind: ongoingRoute[1] || ongoingRoute[2] || null, id: ongoingRoute[3] || null, method: req.method, headers: req.headers, query: Object.fromEntries(url.searchParams) }), req.headers)
            : await webRequestFor({
              sub: webRoute[1] || null, method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers,
              remoteAddress: req.socket?.remoteAddress ?? "", readBody: () => readBody(req), runtime, router, log,
            });
        } catch (e) {
          // A page asks for the calm one (9B: "Something went wrong. Nothing was lost."); the page's own
          // script asking for JSON gets JSON, which it already knows how to treat as a missed beat.
          // An approval link's token is a bearer secret: never in the journal.
      log({ http: url.pathname.replace(/^(\/web\/approve\/)[^/]+/, "$1…"), threw: (e?.message ?? String(e)).split("\n")[0] });
          if (String(req.headers.accept ?? "").includes("application/json")) return send(500, { error: "server error" });
          const body = (await import("./pages/webconvo.js")).renderError();
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8", ...WEB_SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) });
          return res.end(req.method === "HEAD" ? "" : body);
        }
        // The live stream (W2) stays open and writes as the conversation moves; everything else is one answer.
        if (out.stream) {
          res.writeHead(out.status, out.headers);
          if (req.method === "HEAD") return res.end();
          // Headers are gone by now: a failure here can only end the stream, never answer 500.
          try { return out.stream(res, req); } catch (e) { log?.(`web stream: ${e?.message ?? e}`); return res.end(); }
        }
        res.writeHead(out.status, out.headers);
        return res.end(req.method === "HEAD" ? "" : out.body);
      }
      // E1 (src/pages/webedge.js): any other /web address is "This page isn't here. Nothing's lost.",
      // with the way back to the thread only for a browser that is signed in.
      if (webOn() && /^\/web\//.test(url.pathname) && (req.method === "GET" || req.method === "HEAD")) {
        const { renderWebNotFound } = await import("./pages/webedge.js");
        const { sessionAccount } = await import("./pages/websignin.js");
        const body = renderWebNotFound({ signedIn: !!sessionAccount(req.headers) });
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", ...WEB_SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) });
        return res.end(req.method === "HEAD" ? "" : body);
      }

      // ---------- an invite link's card picture ----------
      // The forwarded link's preview (src/invitecard.js): one picture per inviter name, drawn once.
      // Public like the page itself, and a read: an unknown token is the same flat 404.
      const inviteCardRoute = /^(?:\/p)?\/i\/([A-Za-z0-9_-]{32})\/card\.png$/.exec(url.pathname);
      if (inviteCardRoute) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain" });
          return res.end("method not allowed");
        }
        const name = inviteCardName(inviteCardRoute[1]);
        if (!name) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found"); }
        // No browser to draw with: the site's own og picture rather than a preview with no image.
        const png = await inviteCard(name).catch((e) => { log?.(`invite card: ${e?.message ?? e}`); return readFileSync(new URL("../assets/og.png", import.meta.url)); });
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "public, max-age=86400" });
        return res.end(req.method === "HEAD" ? "" : png);
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

      // ---------- Pages v2: the faces and the one private card (held behind REASON_PAGES_V2) ----------
      // The designed pages draw in Web's own faces, served here for the pages and events hosts (the
      // files domain rewrites under /p, so both spellings answer). The private card is the one picture
      // every private page's link preview shows (LP2): the same bytes for every page.
      if (config.pagesV2 && (req.method === "GET" || req.method === "HEAD")) {
        const madeFont = /^(?:\/p)?(?:\/e)?\/fonts\/([a-z]+)\.woff2$/.exec(url.pathname);
        const fontBody = madeFont ? webFont(madeFont[1]) : null;
        if (fontBody) { res.writeHead(fontBody.status, fontBody.headers); return res.end(req.method === "HEAD" ? "" : fontBody.body); }
        if (/^(?:\/p)?\/og\/private\.png$/.test(url.pathname)) {
          const out = await privateOgRequest({ log });
          res.writeHead(out.status, out.headers);
          return res.end(req.method === "HEAD" ? "" : out.body);
        }
      }

      // ---------- Directions: the walking page (held behind REASON_DIRECTIONS; src/pages/directions.js) ----------
      // Off unless the flag is on: directionsRequest answers nothing for any /d/ path then, so the request falls
      // through to the normal not-found page exactly as before.
      // `/p/d/…` is the same page arriving through the files domain, which Caddy rewrites under /p.
      if (config.directionsOn && (url.pathname.startsWith("/d/") || url.pathname.startsWith("/p/d/"))) {
        const { directionsRequest } = await import("./pages/directions.js");
        const out = await directionsRequest({ method: req.method, pathname: url.pathname, req, config, key: url.searchParams.get("k"), headers: req.headers, runtime, log });
        if (out) { res.writeHead(out.status, out.headers); return res.end(req.method === "HEAD" ? "" : out.body); }
      }

      // ---------- pages ----------
      const pageRoute = /^\/p\/([A-Za-z0-9_-]{8,64})(?:\/(choice|audio|signout))?$/.exec(url.pathname);
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
      // A shared stamp first (src/pages/webstamps.js): 12 base62, never the 32–64 of a sign-in token. A
      // page of that shape with no live share behind it is the stamps' 404 page (its picture, a plain
      // 404). Signed by the website's proxy or not, it answers the same: nothing depends on who asks.
      const stampShare = /^\/s\/([0-9A-Za-z]{12})(?:\/(og\.png))?$/.exec(url.pathname);
      if (stampShare) {
        const { shareRequest } = await import("./pages/webstamps.js");
        const out = await shareRequest({ shareId: stampShare[1], sub: stampShare[2] ?? null, method: req.method, log });
        if (out) {
          res.writeHead(out.status, out.headers);
          return res.end(req.method === "HEAD" ? "" : out.body);
        }
      }
      if (url.pathname.startsWith(`${SIGNIN_PATH}/`)) {
        const m = /^\/s\/([A-Za-z0-9_-]{32,64})(?:\/([a-z]+))?$/.exec(url.pathname);
        if (!m) {
          // Not a sign-in link nor a share id: a page asked for gets the same 404 page as a missing share.
          if ((req.method === "GET" || req.method === "HEAD") && !/\.png$/i.test(url.pathname)) {
            const { shareNotFound } = await import("./pages/webstamps.js");
            const out = shareNotFound();
            res.writeHead(out.status, out.headers);
            return res.end(req.method === "HEAD" ? "" : out.body);
          }
          return send(404, { error: "not found" });
        }
        const out = await remoteRequest({
          token: m[1], action: m[2] ?? "", method: req.method, headers: req.headers,
          // Only the hash of the picture the phone already has, so an unchanged one is not resent.
          query: { h: url.searchParams.get("h") ?? "" },
          readBody: () => readBody(req),
          // Start on a browser not proved as the person's own texts them a code first (lead 6).
          tell: typeof runtime?._tell === "function" ? (c, text, meta) => runtime._tell(c, text, meta) : null,
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

      // ---------- Reason itself on the phone: GPT-Live's Twilio webhooks (src/calls/gptlive.js) ----------
      // A call's status, its machine verdict, and the number's voice webhook. All Twilio-signed; all
      // absent unless GPT-Live is the provider or one of its flags is on.
      if (gptlive.gptliveOn() && req.method === "POST" && url.pathname.startsWith(gptlive.STATUS_PATH)) {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const out = await gptlive.statusRequest({
          token: url.pathname.slice(gptlive.STATUS_PATH.length), rawBody, headers: req.headers,
          settle: settleCall, runtime, log,
        });
        res.writeHead(out.status);
        return res.end(out.body);
      }
      // Twilio's answering-machine verdict for a third-party GPT-Live call (phase 3).
      if (gptlive.gptliveOn() && req.method === "POST" && url.pathname.startsWith(gptlive.AMD_PATH)) {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const out = await gptlive.amdRequest({ token: url.pathname.slice(gptlive.AMD_PATH.length), rawBody, headers: req.headers, log });
        res.writeHead(out.status);
        return res.end(out.body);
      }
      if (gptlive.gptliveOn() && req.method === "POST" && url.pathname === gptlive.INBOUND_PATH) {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const out = await gptlive.inboundTwimlReady({ rawBody, headers: req.headers, router, log });
        res.writeHead(out.status, out.type ? { "Content-Type": out.type } : {});
        return res.end(out.body);
      }

      // ---------- a provider redirecting back after the person authorized ----------
      // Spotify sends the person here with ?code&state (or ?error&state). The `state` is the only
      // thing tying the callback to a conversation, and it is spent on the way through, so a link
      // that is opened twice connects nothing the second time. Nothing about the tokens is ever on
      // the page that comes back.
      if (req.method === "GET" && url.pathname === spotify.REDIRECT_PATH) {
        // Only the asker's own browser finishes (src/connectgate.js); anyone else's connects nothing.
        const out = refuseForeignBrowser({ provider: "spotify", state: url.searchParams.get("state") ?? "", error: url.searchParams.get("error") ?? "", headers: req.headers })
          ?? await spotify.completeConnect({
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

      // ---------- the link Reason texts for a connect: proves the browser is the asker's first ----------
      if (url.pathname === CONNECT_START_PATH) {
        const out = await connectStartRequest({
          state: url.searchParams.get("state") ?? "",
          method: req.method, headers: req.headers, readBody: () => readBody(req), runtime, log,
        });
        res.writeHead(out.status, out.headers);
        return res.end(out.body);
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
            + ` Add it in the Spotify developer dashboard under User Management, then tell me and I will send them the link.`, { toMaster: true });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          return res.end(spotify.joinPage({ done: true }));
        }
      }

      // ---------- GitHub coming back after the person agreed ----------
      // Same shape as Spotify's: nothing is said in the thread from here, because the person is
      // looking at a browser, not their messages. The next thing they ask reads the connection off
      // the tokens table.
      if (req.method === "GET" && url.pathname === github.REDIRECT_PATH) {
        // Only the asker's own browser finishes (src/connectgate.js); anyone else's connects nothing.
        const out = refuseForeignBrowser({ provider: "github", state: url.searchParams.get("state") ?? "", error: url.searchParams.get("error") ?? "", headers: req.headers })
          ?? await github.completeConnect({
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
        // Only the asker's own browser finishes (src/connectgate.js); anyone else's connects nothing.
        const out = refuseForeignBrowser({ provider: "uber", state: url.searchParams.get("state") ?? "", error: url.searchParams.get("error") ?? "", headers: req.headers })
          ?? await uber.completeConnect({
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
        // Only the asker's own browser finishes (src/connectgate.js); anyone else's connects nothing.
        const out = refuseForeignBrowser({ provider: "x", state: url.searchParams.get("state") ?? "", error: url.searchParams.get("error") ?? "", headers: req.headers })
          ?? await x.completeConnect({
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
          headers: req.headers,
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

      // ---------- Stripe pushing back: somebody paid for Reason, renewed, cancelled (src/plan.js) ----------
      if (req.method === "POST" && url.pathname === "/stripe/webhook") {
        const rawBody = await readBody(req);
        if (rawBody === null) return send(413, { error: "body too large" });
        const out = await stripeWebhookRequest({ rawBody, headers: req.headers, runtime, log });
        return send(out.status, out.body);
      }
      // Where Stripe sends them back after paying, or after changing their mind. Said once, plainly;
      // the thread is where the real confirmation lands (the webhook's line).
      if (req.method === "GET" && (url.pathname === "/pay/done" || url.pathname === "/pay/back")) {
        // Switch off (Reason is free for everyone): no page about paying, just the home page.
        if (plan.mode() === "off") { res.writeHead(302, { Location: `${(config.siteUrl || "https://heyreason.com").replace(/\/+$/, "")}/` }); return res.end(); }
        res.writeHead(200, HTML());
        return res.end(brandedPage(url.pathname === "/pay/done" ? "You're all set" : "No charge",
          url.pathname === "/pay/done"
            ? `<h1>You're all set.</h1><p>Thank you. Everything is back on.</p><p class="lead">Head back to Messages — Reason will text you there in a moment, and whatever you were in the middle of picks up right where it was.</p>`
            : `<h1>Nothing was charged.</h1><p>No worries. Whenever you want to keep going, just text Reason and ask for the link again.</p>`));
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
        // The exact bytes too: a body signature (Sendblue's X-Sendblue-Signature) is over these,
        // not over whatever a utf8 round-trip makes of them.
        const rawBytes = await readBody(req, { bytes: true });
        if (rawBytes === null) return send(413, { error: "body too large" });
        const rawBody = rawBytes.toString("utf8");
        // The router answers once the whole turn is over, which on a long one is past the
        // provider's own timeout (Sendblue: 45s, then retries). Whatever is wrong with a delivery —
        // a bad signature, a body that will not parse — is known in milliseconds, so the provider
        // still hears that. Anything slower is a turn under way: the message is already claimed
        // and held in the database (and the sweep finishes it if this process stops), so "I have
        // this" is true, and the turn carries on after the provider has its answer.
        const running = router.webhook({ channel: hook[1], rawBody, rawBytes, headers: req.headers });
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
      // An approval link's token is a bearer secret: never in the journal.
      log({ http: url.pathname.replace(/^(\/web\/approve\/)[^/]+/, "$1…"), threw: (e?.message ?? String(e)).split("\n")[0] });
      return send(500, { error: "server error" });
    }
  }
}

const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra });
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function brandedPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${iconLinks()}
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<script>${THEME.head}</script>
<style>
:root{color-scheme:light dark;--ground:${PAPER.ground};--bg:${PAPER.bg};--fg:${PAPER.ink};--mute:${PAPER.dim};--grain:${PAPER_GRAIN};--line:${PAPER.line};--mark:${BRAND_PEN}}
${dark([["", `--grain:none;--ground:#0b0a09;--bg:#12110f;--fg:#f3efe8;--mute:#a39c91;--line:#2c2924;--mark:${BRAND_PEN_DARK}`]])}
*{box-sizing:border-box}body{margin:0;font:17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;background:var(--grain) var(--ground);color:var(--fg)}
.bar{display:flex;align-items:center;gap:.45rem;padding:14px 16px 10px;font:500 1rem/1.2 ui-serif,"New York","Iowan Old Style",Georgia,serif}
${WORDMARK_CSS}
${THEME.css}
.sheet{background:var(--grain) var(--bg);border-radius:1.5rem 1.5rem 0 0;min-height:100dvh}
main{max-width:32rem;margin:0 auto;padding:2rem 1.5rem}
h1{font-size:1.3rem;margin:0 0 .5rem}.lead{color:var(--mute);font-size:.9rem}
</style></head><body>
<div class="bar">${wordmark()}</div>
<div class="sheet"><main>${body}${THEME.markup}</main></div><script>${THEME.js}</script></body></html>`;
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
  if (isContactPath(pathname)) {
    // With two live lines, the card whose hash is in the address (a Linq person's card carries the
    // Linq number); an old hash or /reason.vcf gets the first live line's.
    // A token in the address is one person's card under the name they chose for Reason in their
    // first chat (src/onboarding.js): only that name changes, and an unknown token gets the plain card.
    const { hash: want, token } = contactPathParts(pathname);
    const name = cardName(db.contactCardNameByToken(token));
    const cards = (router?.list?.() ?? []).filter(ch => ch.name !== "console" && ch.status?.().status === "live")
      .map(ch => vcard({ number: lineNumber(router, ch.name), callNumber: config.twilioFrom, name })).filter(Boolean);
    const card = cards.find(c => createHash("sha256").update(c).digest("hex").slice(0, 8) === want) ?? cards[0] ?? null;
    if (!card) return { status: 404, headers: HTML(), body: renderNotFound() };
    const file = name.replace(/[^A-Za-z0-9 ._-]/g, "").trim() || "Reason";
    return {
      status: 200,
      headers: {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": `inline; filename="${file}.vcf"`,
        "Content-Length": Buffer.byteLength(card),
        // No long cache: the address is what changes with the card, and an old hash still answers.
        "Cache-Control": "no-cache",
      },
      body: card,
    };
  }
  return null;
}

/** An event page, with the texting line's number for its "Text Reason to finish" button. */
export async function eventRequestFor({ router = null, ...rest }) {
  return await eventPageRequest({ ...rest, lineNumber: liveLineNumber(router) });
}

/**
 * A Reason Web request, with the number its join block tells a new person to text: the live line's,
 * through the one helper every join surface uses (src/web.js joinNumber), never a string here.
 */
export async function webRequestFor({ router = null, ...rest }) {
  return await webRequest({ ...rest, router, joinNumber: joinNumber(router) });
}

/**
 * An invite page, with the number of the texting line it should send its code to. Exported for the
 * tests; the route above is the only caller.
 */
export function inviteRequestFor({ token, router = null }) {
  return inviteRequest({ token, lineNumber: liveLineNumber(router) });
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

/** The one private card (Pages v2, LP2). `shoot` is injectable so a test needs no browser. */
export async function privateOgRequest({ shoot = (html) => shootWithChromium(html), log = () => {} } = {}) {
  try {
    const bytes = await privateOgPng({ shoot });
    if (!bytes?.length) return { status: 404, headers: HTML(), body: renderNotFound() };
    return { status: 200, headers: { "Content-Type": "image/png", "Content-Length": bytes.length, "Cache-Control": "public, max-age=86400" }, body: bytes };
  } catch (e) {
    log({ private_og_failed: (e?.message ?? String(e)).split("\n")[0] });
    return { status: 404, headers: HTML(), body: renderNotFound() };
  }
}

/** Where the private card is fetched from: absolute, as a link preview needs. */
export const privateOgUrl = () => `${pageUrl("og/private.png")}?v=${PRIVATE_OG_VERSION}`;

/**
 * The owner's page, drawn. With REASON_PAGES_V2 a designed page (src/pages/madedata.js) draws in the
 * v2 frame, and every page carries the one generic preview (LP2) instead of its own title and card.
 */
function ownerPageHtml(page, { interactive, picked }) {
  if (config.pagesV2) {
    const head = privateHead(privateOgUrl());
    const designed = renderMadePage(page, { picked, interactive, head });
    if (designed) return designed;
    return renderPage(page, { interactive, picked, related: relatedFor(page, interactive), ...whoseLine(page), previewHead: head });
  }
  return renderPage(page, { interactive, picked, related: relatedFor(page, interactive), ...whoseLine(page) });
}

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
  let phone, ref, name;
  try { ({ phone, ref, name } = JSON.parse(rawBody) ?? {}); } catch { phone = undefined; }

  const out = await router.webAccess({ address: phone, name: typeof name === "string" ? name : "" });
  // A join that came from a shared stamp's "Get your own Reason" (`ref=s_<shareId>`), when the form passes it on.
  if (out.ok && ref) { try { stamps.noteShareSignup(ref, { log }); } catch { /* never costs a join */ } }
  // `waiting` is how many people are in the queue in all, for the page's "you're #N". It is the same
  // number whatever happened to this one, so it says nothing about the number that was typed.
  if (out.ok) return { status: 200, body: { ok: true, waiting: db.pendingRequestCount() } };
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

/**
 * POST /stripe/webhook. The signature first (STRIPE_WEBHOOK_SECRET over the raw body, src/stripe.js),
 * then the event id — a redelivered event is answered 200 and does nothing twice — then src/plan.js
 * acts on it. A 401 for a bad signature and a 400 for a body that will not read; everything else is a
 * 200, because Stripe retries anything else for days and the row already says what happened.
 */
export async function stripeWebhookRequest({ rawBody, headers = {}, runtime = null, log = () => {} } = {}) {
  const v = stripeapi.verifyWebhook({ rawBody, headers, nowMs: clock.now() });
  if (!v.ok) {
    log({ stripe_webhook_rejected: v.why });
    return { status: 401, body: { error: `rejected: ${v.why}` } };
  }
  let event;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "bad json" } }; }
  if (!event?.id || !event?.type) return { status: 400, body: { error: "no event id or type" } };
  const say = runtime?.say ? (c, text) => runtime.say(c, text) : null;
  const out = await plan.handleStripeEvent(event, { say, log });
  // A 500 is the one answer that makes Stripe try again, which is what an event nothing acted on needs.
  if (out.ok === false) return { status: 500, body: { error: "not handled; try again" } };
  return { status: 200, body: { ok: true, ...(out.duplicate ? { duplicate: true } : {}), ...(out.matched === false ? { matched: false } : {}) } };
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
      // order.failed with NO order id, on a purchase waiting for its approval: the store refused to
      // place the cart after the person approved (2026-10-26 03:20 ET: Target, `code: "place"`,
      // 2 s after each Face ID approval, twice). That attempt consumed the approval, so the next
      // confirm of the same cart comes back asking for a fresh one — and until this was matched,
      // Reason read that as "the first approval didn't count", which was false. Matched by the buy
      // conversation the event names, only for the person it names, and never for an approval pause
      // (order.failed is also sent for `vault_approval_required`, which is not a failure). Nothing is
      // said here: the confirm that is about to be repeated (the approval's own timer) is the one
      // voice, and it reads this off the row. If that confirm has already gone out before this
      // lands, it still knows — the row's approval was consumed and a new authorization came back.
      // Only once the row's approval HAS gone through: before that, a confirm that ended without an
      // order is Reason's own confirm, which gets its answer directly and marks the row itself, and
      // "after your approval" would be a lie. (The two-second race the other way — the failure
      // landing before its approval — is covered by the consumed-approval evidence, without a code.)
      if (kind === "failed" && !orderId && data.conversation_id && !agentcard.isApprovalPause(data.code)) {
        const waiting = db.getAgentcardPurchase(data.conversation_id);
        if (waiting && user && waiting.conversation_id === user.conversation_id && waiting.status === "awaiting_approval" && waiting.authorization_state === "approved") {
          const noted = db.noteAgentcardPlacementFailure(waiting.buy_conversation_id, { code: data.code ?? "", reason: data.message ?? "" });
          log({
            agentcard_webhook: event.type, purchase: waiting.buy_conversation_id, via: "conversation", placement_failed: true,
            code: data.code ?? "none", reason: data.message || "none", failures: noted?.placement_failures ?? undefined,
            charge_status: data.charge_status ?? undefined, retryable: data.retryable ?? undefined,
          });
          return { status: 200, body: { ok: true, matched: true, placement_failed: true, failures: noted?.placement_failures ?? 1 } };
        }
      }
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
export async function googleCallbackRequest({ code, state, error = "", headers = {}, runtime = null, log = () => {}, fetchImpl = null } = {}) {
  // Only the asker's own browser finishes (src/connectgate.js): nothing is exchanged, saved or texted
  // for anyone else's.
  const out = refuseForeignBrowser({ provider: "google", state, error, headers })
    ?? await google.completeConnect({ code, state, error, ...(fetchImpl ? { fetchImpl } : {}) });
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
    const rawChoice = (await readBody()) ?? "";
    // Pages v2 posts the pick as a plain form when script is off; the answer is then the page again.
    const asForm = config.pagesV2 && !String(headers?.["content-type"] ?? "").includes("application/json");
    if (asForm) {
      const f = new URLSearchParams(rawChoice);
      body = { key: f.get("key"), label: f.get("label") };
    } else {
      try { body = JSON.parse(rawChoice || "{}"); } catch { body = null; }
    }
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
    if (asForm) return { status: 303, headers: HTML({ Location: `../${page.id}` }), body: "" };
    return { status: 200, headers: JSONH, body: JSON.stringify({ ok: true, picked: picked.label }) };
  }

  // ---- Pages v2: a call page's recording, for its owner only ----
  if (sub === "audio") {
    if (!config.pagesV2 || (method !== "GET" && method !== "HEAD") || !access.allow || !access.interactive || madeKind(real) !== "call") {
      return { status: 404, headers: HTML(), body: renderNotFound() };
    }
    const audio = callAudio(db.getCall(page.conversation_id, page.blocks[0].call_id));
    if (!audio) return { status: 404, headers: HTML(), body: renderNotFound() };
    const bytes = readFileSync(audio.file);
    // A byte range, because Safari will not play a recording served without one.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(headers?.range ?? "").trim());
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      if (start > end || start >= bytes.length) return { status: 416, headers: { "Content-Range": `bytes */${bytes.length}`, "Cache-Control": "private, no-store" }, body: "" };
      const part = bytes.subarray(start, end + 1);
      return { status: 206, headers: { "Content-Type": audio.mime, "Content-Length": part.length, "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" }, body: part };
    }
    return { status: 200, headers: { "Content-Type": audio.mime, "Content-Length": bytes.length, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" }, body: bytes };
  }

  // ---- Pages v2, E3: "Sign in as someone else" — this browser forgets who it is, then the gate ----
  if (sub === "signout") {
    if (!config.pagesV2 || method !== "POST") return { status: 404, headers: HTML(), body: renderNotFound() };
    // Every session this browser presented, and the cookie at both paths it can live under (pages
    // set it at /p/ or /, the event pages at /), so the gate is what comes next — not the same 403.
    for (const t of new Set([cookie, ...readCookies(headers?.cookie)].filter(Boolean))) db.endPageSession(t);
    log({ page_browser_signed_out: true });
    return { status: 303, headers: HTML({ Location: `../${id}`, "Set-Cookie": [clearCookieHeader({ path: "/p/", headers }), clearCookieHeader({ path: "/", headers })] }), body: "" };
  }

  // ---- the code for a private page ----
  if (method === "POST") {
    // Only from the gate itself. On the files domain the session is set at Path=/ under the shared
    // cookie domain, where a connect callback reads it too (src/connectgate.js): a page elsewhere
    // posting the owner's code from someone else's browser must not sign that browser in.
    if (!sameOrigin(headers)) return gateFor(access, page, { real, status: 403 });
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
      // Keyed `pcode:` on the code's own row, as event sign-in keys `esign:`: the key is what keeps a
      // code text out of the per-message history (db.js HISTORY_EXCLUDED_KEYS) — a code is a secret,
      // never a line in the conversation — and it is what stops a retried send texting a code twice.
      if (runtime?._tell) {
        Promise.resolve(runtime._tell(page.conversation_id, asked.line, { idempotencyKey: `pcode:${page.id}:${asked.id}` }))
          .catch(e => log({ page_code_text_failed: page.id, why: (e?.message ?? String(e)).split("\n")[0] }));
      } else if (runtime?.say) {
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
        headers: HTML({ "Set-Cookie": cookieHeader(tried.token, { path: cookiePath, headers }) }),
        body: config.pagesV2 && page.state === "archived" ? archivedFor(page) : ownerPageHtml(page, { interactive: true, picked: db.pageChoicesFor(page.id) }),
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
    // E4: its owner opened a page that has been put away. Only ever its owner: anybody else is at the
    // gate below and learns nothing about the page's state.
    if (config.pagesV2 && page.state === "archived") return { status: 200, headers: HTML(), body: archivedFor(page) };
    return {
      status: 200,
      headers: HTML(),
      body: ownerPageHtml(page, {
        interactive: access.interactive,
        picked: access.interactive ? db.pageChoicesFor(page.id) : {},
      }),
    };
  }
  // E3: a browser already signed in as somebody else, without the page's own key. Decided from the
  // browser's session alone, so a real page and an id that never existed draw the same screen.
  if (config.pagesV2 && !access.via_key && access.reason !== "rate_limited") {
    const viewer = db.pageSessionOwner(cookie, SESSION_TTL_MS);
    if (viewer && viewer !== page.conversation_id) return { status: 403, headers: HTML(), body: notYoursFor(viewer, id) };
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
      canSend, sent: canSend && sent,
      // v2 (LP2): every private link previews the same — never the page's own title or card.
      preview: canSend && !config.pagesV2 ? page : null,
      head: canSend && config.pagesV2 ? privateHead(privateOgUrl()) : "",
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
/**
 * The status page's own cookie (2026-11-08, security). Only a session the status page itself signed
 * in (its password or its code, page_id "ops") opens it, and it travels in its own cookie: host-only
 * on the address /ops is served from (heyreason.com), never the shared heyreason.com one, so it is
 * never sent to files. or events., where pages and event guests live; SameSite=Strict, so no other
 * site's link or form carries it. A Web or page sign-in no longer opens /ops.
 */
export const OPS_COOKIE = "reason_ops";
const opsCookieHeader = (token) => `${OPS_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Strict${(config.publicUrl || "").startsWith("https://") ? "; Secure" : ""}`;
const cookieValues = (header, name) => String(header ?? "").split(";").map(p => p.trim().split("=")).filter(([k, ...v]) => k === name && v.join("=")).map(([, ...v]) => v.join("="));

/**
 * The status page's session this browser holds: `{ token, legacy }` or null. `legacy` is a session
 * the status page signed in before it had its own cookie, carried in the shared `reason_page` one
 * (host-only on heyreason.com, as /ops always set it): still honoured so nobody is signed out, and
 * moved to the status page's cookie the next time it is opened.
 */
export function opsSession(headers = {}) {
  for (const t of cookieValues(headers?.cookie, OPS_COOKIE)) if (db.pageSessionSource(t) === ops.PAGE.id) return { token: t, legacy: false };
  for (const t of readCookies(headers?.cookie)) if (db.pageSessionSource(t) === ops.PAGE.id) return { token: t, legacy: true };
  return null;
}

/**
 * Did this post come from the status page itself? (2026-11-08, security.) A browser that says it is
 * not same-origin (Sec-Fetch-Site, which no page can set) is refused; one that names its Origin, or
 * failing that its Referer, must name the status page's own host — never the pages or events host,
 * which are the same site and so would pass a SameSite check. A request with none of the three is
 * not a browser's, and a forged post needs a browser.
 */
export function opsSameOrigin(headers = {}) {
  const site = String(headers["sec-fetch-site"] ?? "").toLowerCase();
  // "none" is the browser's own doing (a reload, a resubmit from history), never another page's.
  if (site && site !== "same-origin" && site !== "none") return false;
  const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
  const notOps = new Set([hostOf(config.pagesUrl), hostOf(config.eventsUrl)].filter(Boolean));
  // Only the status page's own addresses, never whatever Host the request names: another host that
  // reaches this server and serves somebody's page must not count as the status page.
  const ours = new Set([hostOf(config.opsUrl), hostOf(config.publicUrl)].filter(h => h && !notOps.has(h)));
  const origin = String(headers.origin ?? "").trim();
  if (origin === "null") return site === "same-origin";
  if (origin) return ours.has(hostOf(origin));
  const referer = String(headers.referer ?? "").trim();
  if (referer) return ours.has(hostOf(referer));
  return true;
}

/** Is this request addressed to the pages or events host? Those serve people's pages: never /ops. */
export function onPeopleHost(headers = {}) {
  const host = String(headers?.host ?? "").toLowerCase().replace(/:\d+$/, "");
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
  return !!host && [hostOf(config.pagesUrl), hostOf(config.eventsUrl)].filter(Boolean).includes(host);
}

export async function opsRequest({ json = false, key = null, focus = null, via = null, bounced = false, method, headers, remoteAddress = "", readBody, runtime, router = null, log = () => {} }) {
  const page = { ...ops.PAGE, conversation_id: config.ownerConversation };
  if (onPeopleHost(headers)) return { status: 404, headers: HTML(), body: renderNotFound() };
  const session = opsSession(headers);
  const owner = session ? db.pageSessionOwner(session.token, SESSION_TTL_MS) : null;
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
    // 303 back to the page: a refresh afterwards is a GET, not the password posted again. The status
    // page's own cookie (OPS_COOKIE): host-only, Path "/" so it comes back on /ops and /ops.json.
    status: 303,
    headers: { ...HTML(), Location: focusId ? `/ops?focus=${encodeURIComponent(focusId)}` : "/ops", "Set-Cookie": opsCookieHeader(token) },
    body: "",
  });

  // ---- a post from anywhere but the status page itself: refused before anything is read ----
  if (method === "POST" && !opsSameOrigin(headers ?? {})) {
    log({ ops_post_refused: "origin" });
    return { status: 403, headers: HTML(), body: renderNotFound() };
  }

  // ---- the owner's two buttons ----
  // Only a signed-in browser from the status page itself gets here (opsSameOrigin above, and the
  // cookie is SameSite=Strict), so a form on some other site, or on a page of ours, cannot press them. "Check again" is the scheduled pass, now. "Clear" restarts one windowed
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
    // ---- events: pause, resume, retry what failed (src/events.js) ----
    const eventId = Number(form.get("event_id"));
    if (action === "event_pause" || action === "event_resume" || action === "event_retry") {
      const out = action === "event_pause" ? eventsmod.pause(eventId)
        : action === "event_resume" ? await eventsmod.resume({ runtime, eventId })
          : db.getEventRow(eventId) ? { ok: true, ...(await eventsmod.retryFailed({ runtime, ev: db.getEventRow(eventId) })) } : { ok: false, reason: "not_found" };
      log({ ops_event_action: action, event: eventId, ok: out.ok, ...(out.reason ? { why: out.reason } : {}) });
      if (wantsJson) return { status: 200, headers: JSONH, body: JSON.stringify({ ok: out.ok, action, result: out }) };
      return { status: 303, headers: { ...HTML(), Location: "/ops?focus=events#events" }, body: "" };
    }
    // ---- Reason Web's maintenance switch (E5): on until a time, or off ----
    if (action === "web_maint_on" || action === "web_maint_off") {
      const edge = await import("./pages/webedge.js");
      const out = action === "web_maint_off" ? edge.endMaintenance()
        : (() => { const until = edge.parseUntil(form.get("until"), clock.now()); return until ? edge.startMaintenance({ until, by: "ops", now: clock.now() }) : { ok: false, reason: "time" }; })();
      log({ ops_web_maintenance: action === "web_maint_on" ? "on" : "off", ok: out.ok, ...(out.until ? { until: out.until } : {}), ...(out.reason ? { why: out.reason } : {}) });
      if (wantsJson) return { status: out.ok ? 200 : 400, headers: JSONH, body: JSON.stringify({ ok: out.ok, action, result: out }) };
      if (!out.ok) return { status: 400, headers: HTML(), body: renderOps({ report: ops.snapshot(), now: clock.now(), focus: focusId, events: eventsOps(), web: await webOps(out.reason === "too_far" ? "That's more than a day away. Pick a time within the next day." : "That time didn't read. Use HH:MM in Eastern time, or a number of minutes.") }) };
      return { status: 303, headers: { ...HTML(), Location: "/ops?focus=web#web" }, body: "" };
    }
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
    return { status: 200, headers: HTML(), body: renderOps({ report: ops.snapshot(), now: clock.now(), focus: focusId, events: eventsOps(), web: await webOps() }) };
  }

  if (method === "POST" && !signedIn) {
    const form = new URLSearchParams((await readBody()) ?? "");
    // ---- the password ----
    if (form.has("password") && opspw.passwordEnabled()) {
      const ip = opspw.clientIp(headers ?? {}, remoteAddress);
      // The keyed link, and an address the website signed for, are each counted apart from
      // everyone else, so a stranger's wrong guesses cannot lock the owner out (audit lead 23).
      const source = opspw.verifiedSource(headers ?? {});
      const tried = await opspw.tryPassword({ password: form.get("password"), ip, keyed: via_key, source });
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
      // Bound to the host the status page is opened on (the website's /ops), not the pages host.
      const asked = requestCode(page, { host: codeHost(ops.opsUrl()) });
      if (!asked.ok) {
        log({ ops_code_refused: asked.reason });
        return gate({ sent: true, error: `Reason has already texted ${config.ownerName} a code. Use that one, or try again in about ${Math.ceil(asked.retry_after_s / 60)} minutes.` });
      }
      // `pcode:` key, as above: keeps the code out of the per-message history and out of a double send.
      if (runtime?._tell) {
        Promise.resolve(runtime._tell(page.conversation_id, asked.line, { idempotencyKey: `pcode:${page.id}:${asked.id}` }))
          .catch(e => log({ ops_code_text_failed: (e?.message ?? String(e)).split("\n")[0] }));
      } else if (runtime?.say) {
        try { runtime.say(page.conversation_id, asked.line); } catch (e) { log({ ops_code_text_failed: (e?.message ?? String(e)).split("\n")[0] }); }
      }
      log({ ops_code_sent: true });
      return gate({ sent: true });
    }
    // A code is only taken with the key, as one is only sent with it (audit lead 23). The form
    // posts back to the keyed address, so the owner's browser always carries it. Without the key
    // nothing is compared or counted: the five tries on "ops" are the owner's, not a stranger's.
    if (!via_key) return gate();
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
    // A tap on a link from another site (a mail app's web page) does not carry a SameSite=Strict
    // cookie on that first hop. Once, the page asks for itself again from here, which does.
    // `r=1` marks the second ask, so a browser that still calls it cross-site gets the gate, not a loop.
    if (!json && !bounced && method === "GET" && String(headers?.["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") {
      const again = escapeAttr(here({ ...(via === "code" ? { via } : {}), r: "1" }));
      return { status: 200, headers: HTML(), body: `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${again}"><title>Reason status</title>` };
    }
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
        // Only once events exist or are switched on, so an install without them reads as it did.
        // And not while a pass is running: the page polls this every half second then, and never
        // reads events from it.
        ...((ev) => ev ? { events: ev } : {})(running ? null : eventsOps()),
      }),
    };
  }
  // A session from before the status page had its own cookie: moved to it now (opsSession).
  // The old host-only copy is cleared in the same answer (never the shared Web one, which has a Domain).
  return { status: 200, headers: { ...HTML(), ...(session?.legacy ? { "Set-Cookie": [opsCookieHeader(session.token), clearCookieHeader({ path: "/" })] } : {}) }, body: renderOps({ report, now: clock.now(), focus: focusId, events: eventsOps(), web: await webOps() }) };
}

/** The status page's events section, or null while events are off and none exist. */
/** Reason Web's maintenance switch, for the status page (null while Web is off altogether). */
async function webOps(error = "") {
  if (!webOn()) return null;
  const edge = await import("./pages/webedge.js");
  const m = edge.maintenance(clock.now());
  return { on: m.on, label: m.on ? edge.etTime(m.until) : "", error };
}

function eventsOps() {
  if (!eventsmod.eventsOn() && !db.allEvents({ limit: 1 }).length) return null;
  try { return eventsmod.opsSummary(); } catch { return null; }
}

/** What is really running, read from the database and the adapters rather than from uptime. */
/** Text with any phone number or email address in it (and `known`, if given) replaced by "…". */
function noAddresses(text, known = null) {
  let s = String(text ?? "");
  if (known) s = s.split(known).join("…");
  return s.replace(/[^\s@()<>"',;]+@[^\s@()<>"',;]+\.[A-Za-z]{2,}/g, "…").replace(/\+?\d[\d\s().-]{6,}\d/g, "…");
}

/** Is this request the operator's own signed-in browser? The same session /ops takes (opsRequest). */
function operatorSignedIn(headers) {
  if (onPeopleHost(headers)) return false;
  const session = opsSession(headers);
  const owner = session ? db.pageSessionOwner(session.token, SESSION_TTL_MS) : null;
  return !!owner && accounts.isOperatorConversation(owner);
}

/**
 * Is it up, and what is it running. `full` is the operator only: by default this is what a stranger
 * may see — GET /health is answered to anybody who can reach the listener, and through the Funnel
 * that is the internet (whose requests arrive from the local tailscaled, so the remote address
 * proves nothing). Nobody's number, email or name is in that answer: a held conversation keeps its
 * channel, count and times but not its id (`dm:<channel>:<address>`), a contact's channel limit
 * keeps its kind but not the address, and the operator's name is null. Every key and count the
 * doctor and monitoring read is where it was.
 */
export function health({ router, runtime, full = false }) {
  const name = config.ownerName;
  const unnamed = (s) => (typeof s === "string" && name ? s.split(name).join("the operator") : s);
  const channels = router?.statuses?.() ?? [];
  return {
    ok: true,
    now: stamp(),
    now_ms: clock.now(),
    owner: full ? name : null,
    sweeping: !!runtime?.interval,
    channels: full ? channels : channels.map(c => ("what" in c ? { ...c, what: unnamed(c.what) } : c)),
    // What is still owed to somebody. `failed` here means a message that is never arriving and
    // whose bad news may not have been delivered yet, which is worth seeing at a glance.
    outbox: db.outboxCounts(),
    // Messages that have arrived and are waiting out their quiet window to see whether more of the
    // same thought is coming. A row here with `due: true` and nothing happening means the sweep is
    // not running — which is the one way a held message could sit unanswered.
    holding: db.pendingInboundSummary().map(({ conversation_id, ...r }) => (full ? { conversation_id, ...r } : r)),
    // What this install has learned a provider will not do — a line with no read receipts, a number
    // that cannot send tapbacks. Permanent refusals only, so this is a short list that explains why
    // a feature is quietly absent rather than leaving somebody to wonder.
    // A line is Reason's own number (already under `channels`); a contact is somebody, so a
    // stranger is told only that it is one. `why` carries the provider's own words, which can quote
    // the recipient, so a stranger's copy has any address in it taken out.
    channel_limits: db.listChannelLimits().map(l => {
      const contact = String(l.scope).startsWith("contact:");
      if (full) return { channel: l.channel, feature: l.feature, scope: l.scope, why: l.why };
      return { channel: l.channel, feature: l.feature, scope: contact ? "contact" : l.scope, why: noAddresses(l.why, contact ? String(l.scope).slice(8) : null) };
    }),
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

/** A body read to its end even when it's too big (null): the connection stays up and gets a normal answer. */
function readAllBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on("end", () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readBody(req, { bytes = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => { const buf = Buffer.concat(chunks); resolve(bytes ? buf : buf.toString("utf8")); });
    req.on("error", reject);
  });
}
