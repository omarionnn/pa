#!/usr/bin/env node
// The brain test line's own process (src/calls/braintest.js). Run by the reason-brain-test unit, never by
// the live service. Its environment is the live .env with every sending, paying and acting credential taken
// out, the database opened read-only, and nothing started but this one HTTP listener on 127.0.0.1.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createServer } from "node:http";
import { join } from "node:path";

// Only what reading memory and speaking needs: model keys, the at-rest keys, the owner's numbers.
const KEEP = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CARTESIA_API_KEY|REASON_MODEL|REASON_CONVERSATION|REASON_MASTER_NUMBER|REASON_OWNER_NUMBER|REASON_OWNER_NAME|REASON_OWNER_LANGUAGE|REASON_TZ|REASON_ENCRYPT_REST\d?|REASON_REST_[A-Z_]+|REASON_GCP_[A-Z_]+|REASON_TOKEN_KEY|REASON_KEEP_[A-Z_]+|REASON_CALL_CARRYOVER|REASON_CALL_MANNER|REASON_CALL_TRUST|REASON_CALL_IDENTITY|REASON_THREADING|REASON_ONE_IDENTITY|REASON_CONTEXT_FIRST)$/;
const live = parseEnv(readFileSync(process.env.BRAIN_TEST_LIVE_ENV || "/opt/reason/.env", "utf8"));
for (const [k, v] of Object.entries(live)) if (KEEP.test(k) && process.env[k] === undefined) process.env[k] = v;
process.env.REASON_DB_READONLY = "1";
// Writes that modules make while they load are skipped until the whole brain is loaded (below); after that
// every write throws.
process.env.REASON_DB_READONLY_HOLD = "1";
process.env.REASON_DATA_DIR = process.env.REASON_DATA_DIR || "/opt/reason/data";
process.env.REASON_DB_PATH = process.env.REASON_DB_PATH || join(process.env.REASON_DATA_DIR, "reason.db");
process.env.REASON_CALL_BRAIN = "owner";
// Belt and braces: no messaging or payment credential exists in this process.
for (const k of Object.keys(process.env)) if (/^(SENDBLUE|TWILIO|STRIPE|PLAID|AGENTCARD|UBER|CROSSMINT|BLAND|SPOTIFY|GITHUB_OAUTH|GOOGLE_OAUTH|PARALLEL|TAVILY|SERPAPI|CLAUDE_CODE)/.test(k)) delete process.env[k];

const secretFile = process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, "brain-test-secret") : process.env.BRAIN_TEST_SECRET_FILE;
const secret = readFileSync(secretFile, "utf8").trim();
const port = Number(process.env.BRAIN_TEST_PORT || 8790);

const { handle } = await import("../src/calls/braintest.js");
const db = await import("../src/db.js");
await (await import("../src/calls/voice.js")).prime();
db.readOnlyLoaded();
const log = (o) => { try { console.log(JSON.stringify({ at: new Date().toISOString(), ...o })); } catch { /* never breaks a call */ } };
log({ brain_test_boot: true, read_only: db.READ_ONLY, schema_skipped: db.readOnlySkipped, port, timers: process.getActiveResourcesInfo().filter(r => /Timeout|Interval/.test(r)).length });

const server = createServer(async (req, res) => {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 256 * 1024) { res.writeHead(413); return res.end(); } chunks.push(c); }
  let out;
  try { out = await handle({ method: req.method, path: new URL(req.url, "http://x").pathname, headers: req.headers, rawBody: Buffer.concat(chunks).toString("utf8"), secret, deps: { log } }); }
  catch (e) { log({ brain_test_error: (e?.message ?? String(e)).split("\n")[0] }); out = { status: 500, body: "error" }; }
  res.writeHead(out.status, out.headers ?? {});
  if (!out.stream) return res.end(out.body ?? "");
  let gone = false;
  res.on("close", () => { gone = true; });
  try { for await (const line of out.stream) { if (gone) break; res.write(line); } } catch (e) { log({ brain_test_stream_error: (e?.message ?? String(e)).split("\n")[0] }); }
  res.end();
});
server.listen(port, "127.0.0.1", () => log({ brain_test_listening: port }));
