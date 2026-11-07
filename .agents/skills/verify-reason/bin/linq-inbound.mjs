#!/usr/bin/env node
// One signed Linq message.received into the caged Reason (features/inbound-message.md).
// Needs a cage started with REASON_VERIFY_LINQ_WEBHOOK=1, which writes $RUN/linq-secret.
//
//   node bin/linq-inbound.mjs dm "hi"       a 1:1 chat (chat.is_group false)  -> delivered 1
//   node bin/linq-inbound.mjs group "hi"    a group chat (chat.is_group true) -> ignored "group"
//
// The sender is the cage owner ($RUN/owner). A fresh event id every run, so it is never deduped.
// Prints the HTTP status and body. Loopback only.
import { readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RUN = process.env.REASON_VERIFY_RUN || join(process.env.TMPDIR || tmpdir(), "reason-verify");
const [kind = "dm", text = "hi"] = process.argv.slice(2);
if (!["dm", "group"].includes(kind)) { console.error("usage: linq-inbound.mjs dm|group [text]"); process.exit(2); }

let secret;
try { secret = readFileSync(join(RUN, "linq-secret"), "utf8").trim(); }
catch { console.error(`no ${RUN}/linq-secret: start the cage with REASON_VERIFY_LINQ_WEBHOOK=1`); process.exit(1); }
const port = readFileSync(join(RUN, "port"), "utf8").trim();
const owner = readFileSync(join(RUN, "owner"), "utf8").trim();

const eventId = `cage-linq-${kind}-${randomUUID()}`;
const body = JSON.stringify({
  api_version: "v3", webhook_version: "2026-02-03", event_type: "message.received", event_id: eventId,
  created_at: new Date().toISOString(),
  data: {
    chat: { id: kind === "group" ? "cage-group-chat" : "cage-dm-chat", is_group: kind === "group" },
    id: randomUUID(), direction: "inbound",
    sender_handle: { handle: owner, is_me: false },
    parts: [{ type: "text", value: text }],
    sent_at: new Date().toISOString(),
  },
});
const ts = String(Math.floor(Date.now() / 1000));
const sig = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
  .update(`${eventId}.${ts}.${body}`).digest("base64");

const res = await fetch(`http://127.0.0.1:${port}/channels/linq/webhook`, {
  method: "POST",
  headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` },
  body,
});
console.log(res.status, await res.text());
