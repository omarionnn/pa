// The listener inbound webhooks arrive on. node:http, no framework — there are three routes and
// a framework would be more code than the thing it wraps.
//
//   GET  /health                      is it up, and what is it actually running
//   POST /channels/{name}/webhook     one provider delivery, verified and parsed by that adapter
//
// The raw body is handed to the adapter as the exact bytes that arrived. Signature schemes sign
// the body verbatim, so parsing and re-serialising here would break every one of them.
import { createServer as nodeCreateServer } from "node:http";
import * as db from "./db.js";
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

/** What is really running, read from the database and the adapters rather than from uptime. */
export function health({ router, runtime }) {
  return {
    ok: true,
    now: stamp(),
    now_ms: clock.now(),
    owner: config.ownerName,
    sweeping: !!runtime?.interval,
    channels: router?.statuses?.() ?? [],
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
