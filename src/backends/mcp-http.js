// Reason's tools served to the `claude` CLI over MCP's streamable-HTTP transport, from inside
// the Reason process that is running the turn.
//
// The obvious way to do this is a stdio server the CLI spawns itself, and that works — but it
// is a *separate process*, which costs the two things a turn most needs to keep: the browser
// (a fresh process has a blank Chromium, so a booking cannot be worked across two turns) and a
// single writer to the database. Serving over a loopback port instead keeps the tools inside
// the process that owns both. One turn, one server, bound to 127.0.0.1 on an ephemeral port,
// closed when the turn ends.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mcpDispatch } from "./mcp-core.js";

/**
 * Start the server for one turn. Resolves to { url, headers, close }. Nothing outside this machine
 * can reach it: it binds the loopback interface on a port the OS picks, and it is shut the moment
 * the turn is over.
 *
 * Loopback is not a caller check, though (security audit 2026-11-06, lead 3): any process on the
 * machine, or a page open in Reason's own Chromium posting text/plain no-cors, could run a tool as
 * this turn's person. So every request must carry this turn's secret (`headers`, handed to the CLI
 * in its 0600 MCP config file), name this very host:port, come with no browser Origin, and be JSON.
 */
export function startMcpHttp({ conversationId, channels = null, calls = null, onTool = () => {}, onToolStart = () => {}, toolCtx = {} } = {}) {
  const secret = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${secret}`);
  let hostport = "";
  const allowed = (req) => {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return false;
    if (req.headers.origin != null) return false;
    if (String(req.headers.host ?? "") !== hostport) return false;
    return true;
  };
  const server = createServer(async (req, res) => {
    if (!allowed(req)) { req.resume(); res.writeHead(401).end(); return; }
    if (req.method === "DELETE") { res.writeHead(204).end(); return; }       // session teardown
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) { req.resume(); res.writeHead(415).end(); return; }

    let raw = "";
    for await (const chunk of req) raw += chunk;

    let msg;
    try { msg = JSON.parse(raw); } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
    }

    // A batch is legal JSON-RPC; the CLI does not send one today, but answering it costs a line.
    const batch = Array.isArray(msg) ? msg : [msg];
    const out = [];
    for (const one of batch) {
      try {
        const r = await mcpDispatch(one, { conversationId, channels, calls, onTool, onToolStart, toolCtx });
        if (r) out.push(r);
      } catch (e) {
        if (one.id !== undefined) {
          out.push({ jsonrpc: "2.0", id: one.id, error: { code: -32603, message: (e?.message ?? String(e)).split("\n")[0] } });
        }
      }
    }

    // Notifications only: the protocol wants 202 and an empty body.
    if (!out.length) { res.writeHead(202).end(); return; }
    const body = JSON.stringify(Array.isArray(msg) ? out : out[0]);
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      hostport = `127.0.0.1:${server.address().port}`;
      resolve({
        url: `http://${hostport}/mcp`,
        headers: { Authorization: `Bearer ${secret}` },
        close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}
