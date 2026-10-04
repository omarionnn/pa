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
import { mcpDispatch } from "./mcp-core.js";

/**
 * Start the server for one turn. Resolves to { url, close }. Nothing outside this machine can
 * reach it: it binds the loopback interface on a port the OS picks, and it is shut the moment
 * the turn is over.
 */
export function startMcpHttp({ conversationId, channels = null, calls = null, onTool = () => {} } = {}) {
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") { res.writeHead(204).end(); return; }       // session teardown
    if (req.method !== "POST") { res.writeHead(405).end(); return; }

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
        const r = await mcpDispatch(one, { conversationId, channels, calls, onTool });
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
      resolve({
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}
