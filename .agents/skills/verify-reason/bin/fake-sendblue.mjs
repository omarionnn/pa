#!/usr/bin/env node
// A stand-in for api.sendblue.com on 127.0.0.1, so a drive can watch what Reason (or
// scripts/watchdog.mjs) would have texted without any text reaching a phone.
//
//   node bin/fake-sendblue.mjs <port> <capture.jsonl> [ok|fail]
//
// Every request is appended to the capture file as one JSON line ({method, path, body}).
// `ok` (default) answers a send with 200 and a message handle; `fail` answers 400 with a Sendblue-
// shaped error (not retryable), which is a forced final send failure for the outbox. GETs (the
// catch-up poll, status lookups) answer 200 with an empty list either way.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const [port, file, mode = "ok"] = process.argv.slice(2);
if (!port || !file) { console.error("usage: fake-sendblue.mjs <port> <capture.jsonl> [ok|fail]"); process.exit(2); }

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = raw;
    try { body = JSON.parse(raw); } catch { /* kept as text */ }
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), method: req.method, path: req.url, body }) + "\n");
    res.setHeader("content-type", "application/json");
    if (req.method !== "POST") { res.end(JSON.stringify({ data: [], messages: [] })); return; }
    if (mode === "fail") {
      res.statusCode = 400;
      res.end(JSON.stringify({ status: "ERROR", error_key: "cage_forced_failure", error_message: "forced failure from fake-sendblue" }));
      return;
    }
    res.end(JSON.stringify({ status: "QUEUED", message_handle: `fake-${Date.now()}` }));
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`fake sendblue on 127.0.0.1:${port} (${mode}) → ${file}`));
