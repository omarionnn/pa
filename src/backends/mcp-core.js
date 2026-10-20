// Reason's tools as MCP, independent of how the bytes arrive.
//
// There is deliberately no logic here beyond translation. A tools/call becomes a `runTool` call
// and nothing else, which is the whole point: the confirm gate, the owner-thread check, the zod
// schemas and the ledger are the same code the API backend runs. A backend that reimplemented
// any of that would prove nothing about Reason.
import { tools, toolsFor, runTool, playbookExtra } from "../tools.js";
import { loadConversation } from "../db.js";

export const PROTOCOL_VERSION = "2024-11-05";

// A tool's own description, plus any feature rule it shares with the rest of its group (see
// playbookExtra in src/tools.js). The CLI defers tools, so the model reads this only when it loads
// the tool, which is exactly when the rule matters.
const asMcp = (t) => ({ name: t.name, description: t.description + playbookExtra(t.name), inputSchema: t.input_schema });

export const MCP_TOOLS = tools.map(asMcp);

/**
 * A result that carries a picture under `_image` ({ media_type, data, bytes }), split into the
 * picture and the rest. Shared with the API path (src/agent.js), which puts the same picture into
 * a tool_result as a Messages API image block. `shown` names the picture by size only.
 */
export function splitImage(out) {
  if (!out || typeof out !== "object" || !out._image) return { image: null, shown: out };
  const { _image: image, ...rest } = out;
  return { image, shown: { ...rest, image: { attached: true, media_type: image.media_type, bytes: image.bytes ?? null } } };
}

/**
 * The list one conversation is told about.
 *
 * `tools/list` is answered per conversation rather than from the static list, because some tools
 * exist only for the master and only when the install has switched them on (see `toolsFor`). The
 * guard that matters is in `runTool`, which refuses on the conversation whatever it was asked; this
 * is the half that means nobody else's model is ever told the tool is there to ask about.
 */
export function mcpToolsFor(conversationId) {
  return toolsFor(conversationId).map(asMcp);
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null for a notification, which
 * by the protocol gets no answer at all.
 *
 * The confirm gate reads the owner's own words rather than the model's report of them. On the
 * API path those words are the in-memory message list; here they are the conversation as the
 * database has it, which the caller writes the inbound message into before the model starts.
 * Same words, same order, same guard.
 *
 * `toolCtx` is everything else the turn was handed. The API path spreads those into every tool's
 * context (`runTurn`'s rest argument in src/agent.js), so this path has to as well or the two
 * backends are not the same thing: a fixture handed to a turn through `ctx.cancelRoutes` reached
 * the tools on one backend and silently did not on the other, which is how the cancel rails ended
 * up unprovable live. Production sets nothing here beyond `channels` and `calls`.
 */
export async function mcpDispatch(msg, { conversationId, channels = null, calls = null, onTool = () => {}, toolCtx = {} } = {}) {
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
      return reply({ tools: mcpToolsFor(conversationId) });

    case "tools/call": {
      const name = msg.params?.name;
      const input = msg.params?.arguments ?? {};
      const out = await runTool(name, input, {
        conversationId,
        messages: loadConversation(conversationId),
        channels,
        calls,
        // Everything the turn was handed, including `taskId` — the task this turn was woken for,
        // when it is a wake — under the same key the API backend uses.
        ...toolCtx,
      });
      // A tool that hands back a picture (photo_look) carries it under `_image`. The bytes go to
      // the model as an MCP image block, and never into the JSON or the log: a base64 photo in a
      // terminal's scrollback is somebody's photo in plain text.
      const { image, shown } = splitImage(out);
      onTool({ tool: name, input, out: shown });
      return reply({
        content: [
          ...(image ? [{ type: "image", data: image.data, mimeType: image.media_type }] : []),
          { type: "text", text: JSON.stringify(shown) },
        ],
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
