// A second model backend: one Reason turn, run through the `claude` CLI instead of the API.
//
// Why it exists: the live tests prove the model reads real messages correctly, and they cost API
// credit. This lets the owner run them on their own machine with none. It is not a way to deploy
// Reason, it is not supported for anyone else, and src/agent.js — the API path — is untouched
// and still the default.
//
// The shape of a turn here differs from the API path in exactly one way: there is no in-process
// tool loop. The CLI runs the loop itself, calls the MCP server, and prints a final result. What
// that costs is written down honestly in the README — chiefly that the CLI owns the tool-round
// budget, and that each turn is a fresh process with no prompt cache.
//
// What it does not cost is the thing that matters: the tools, the confirm gate, the owner check
// and the ledger are the same code, because the MCP server calls `runTool` directly.
import { config, stamp } from "../config.js";
import { SYSTEM } from "../agent.js";
import { loadConversation, saveConversation, pendingConfirmations } from "../db.js";
import { runClaudeCli } from "./cli.js";
import { startMcpHttp } from "./mcp-http.js";

const MAX_HISTORY = 40;

/** One line per stored message, in the order they happened. */
function renderHistory(messages) {
  const lines = [];
  for (const m of messages.slice(-MAX_HISTORY)) {
    if (m.role === "user" && typeof m.content === "string") lines.push(m.content);
    else if (m.role === "assistant" && typeof m.content === "string") lines.push(`Reason: ${m.content}`);
    else if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = m.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      if (text) lines.push(`Reason: ${text}`);
    }
  }
  return lines.join("\n");
}

/**
 * Drop-in for `runTurn` from src/agent.js, selected by REASON_BACKEND=claude-cli.
 *
 * The inbound message is written to the conversation *before* the CLI starts, which is what lets
 * the MCP server hand the owner's real words to the confirm gate. The reply is appended after.
 */
export async function runTurnViaCli({ conversationId, text, kind = "user", log = () => {}, channels = null, calls = null }) {
  const prefix = kind === "event" ? `[event ${stamp()}]` : `[${stamp()}] ${config.ownerName}:`;
  const line = `${prefix} ${text}`;

  const before = loadConversation(conversationId);
  saveConversation(conversationId, [...before, { role: "user", content: line }]);

  // The API path keeps the model's own tool calls and their results in the message list, so it
  // can see the confirmation it opened two turns ago. A fresh CLI process cannot: the history
  // here is text only. Without this, Reason asks for a yes it already asked for, and the owner's
  // "yeah that's it" lands on a question that was never put to them. Spelling the open
  // confirmations out restores what the API path gets for free; it does not add anything the
  // model could not have had.
  const pending = pendingConfirmations(conversationId)
    .filter(x => !x.granted_at)
    .map(x => `  - confirmation #${x.id} (${x.action}), asked ${stamp(x.asked_at)}: ${x.summary}`);

  const history = renderHistory(before);
  const prompt = (history ? `The conversation so far:\n${history}\n\n` : "")
    + (pending.length ? `Questions you already asked and are still waiting on:\n${pending.join("\n")}\nIf the new message answers one of these, confirm_record THAT id. Do not ask again.\n\n` : "")
    + `The new message:\n${line}\n\n`
    + `Reply as Reason, in one short text. Use your tools for anything real.`
    + ` If nothing is worth sending, reply with exactly NO_REPLY.`;

  // One MCP server per turn, in this process, on a loopback port. Keeping the tools here is
  // what lets a browser stay open across turns and the database have one writer, and it means
  // every tool call lands in the same `log` the API backend uses — which is why the live tests,
  // which assert on which tools really ran, work unchanged against this backend.
  const mcp = await startMcpHttp({ conversationId, channels, calls, onTool: log });
  let r;
  try {
    r = await runClaudeCli({ prompt, system: SYSTEM, mcpUrl: mcp.url, log });
  } finally {
    await mcp.close();
  }

  if (!r.ok) {
    log({ cli_failed: r.error ?? r.envelope?.result });
    throw new Error(r.error ?? `the CLI reported an error: ${r.envelope?.result ?? "no detail"}`);
  }
  const reply = String(r.envelope.result ?? "").trim();

  // The conversation already has the inbound line; add what Reason said to it.
  saveConversation(conversationId, [
    ...loadConversation(conversationId),
    { role: "assistant", content: reply },
  ]);

  return reply === "NO_REPLY" || reply === "" ? null : reply;
}

/** Is the CLI backend selected? Checked by the runtime so the API path stays the default. */
export const usingCli = () => process.env.REASON_BACKEND === "claude-cli";
