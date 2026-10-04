// Reason's tools as MCP, independent of how the bytes arrive.
//
// There is deliberately no logic here beyond translation. A tools/call becomes a `runTool` call
// and nothing else, which is the whole point: the confirm gate, the owner-thread check, the zod
// schemas and the ledger are the same code the API backend runs. A backend that reimplemented
// any of that would prove nothing about Reason.
import { tools, runTool } from "../tools.js";
import { loadConversation } from "../db.js";

export const PROTOCOL_VERSION = "2024-11-05";

export const MCP_TOOLS = tools.map(t => ({
  name: t.name,
  description: t.description,
  inputSchema: t.input_schema,
}));

/**
 * Handle one JSON-RPC message. Returns the response object, or null for a notification, which
 * by the protocol gets no answer at all.
 *
 * The confirm gate reads the owner's own words rather than the model's report of them. On the
 * API path those words are the in-memory message list; here they are the conversation as the
 * database has it, which the caller writes the inbound message into before the model starts.
 * Same words, same order, same guard.
 */
export async function mcpDispatch(msg, { conversationId, channels = null, calls = null, onTool = () => {} } = {}) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "reason", version: "0.1.0" },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return reply({});

    case "tools/list":
      return reply({ tools: MCP_TOOLS });

    case "tools/call": {
      const name = msg.params?.name;
      const input = msg.params?.arguments ?? {};
      const out = await runTool(name, input, {
        conversationId,
        messages: loadConversation(conversationId),
        channels,
        calls,
      });
      onTool({ tool: name, input, out });
      return reply({
        content: [{ type: "text", text: JSON.stringify(out) }],
        // A refusal is a result, not a transport error: the model is meant to read it and say
        // what it said. Only a tool that could not run at all is an error here.
        isError: !!out?.error && out?.ok === undefined,
      });
    }

    default:
      if (msg.id === undefined) return null;
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}
