// The listener inbound webhooks arrive on. node:http, no framework — there are three routes and
// a framework would be more code than the thing it wraps.
//
//   GET  /health                      is it up, and what is it actually running
//   POST /channels/{name}/webhook     one provider delivery, verified and parsed by that adapter
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
import { checkAccess, trySubmittedCode, readCookie, cookieHeader } from "./pages/access.js";
import { choiceBlock } from "./pages/content.js";
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
          method: req.method,
          headers: req.headers,
          readBody: () => readBody(req),
          runtime,
          log,
        });
        res.writeHead(out.status, out.headers);
        return res.end(out.body);
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
 * One request for a page. Pulled out of the server so a test can drive the whole access dance —
 * link, code, cookie, choice — without a socket.
 *
 * Nothing here leaks whether an id is real. A page that does not exist, a method that makes no
 * sense for it, and a choice on somebody else's page all answer the same way as a bad link.
 */
export async function pageRequest({ id, isChoice, method, headers, readBody, runtime, log = () => {} }) {
  const page = db.getPage(id);
  if (!page) return { status: 404, headers: HTML(), body: renderNotFound() };

  const cookie = readCookie(headers?.cookie);
  const access = checkAccess({ page, cookie });

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
    return {
      status: 200,
      headers: HTML(),
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
