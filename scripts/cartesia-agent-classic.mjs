// The owner agent's saved settings as on call 112 (REASON_CALL_FEEL=classic, src/calls/callclassic.js): the
// config of version av_f1C22VxgaAQd8zn2MFk8RS, read from Cartesia, sent back through PATCH (their documented
// restore: docs.cartesia.ai/agents/versions), with one setting kept from later: the silence check-in at 20 s
// (call 113: "You still there?" four times at 8 s). Prints ids, sizes and hashes only, never the key.
//
//   node scripts/cartesia-agent-classic.mjs --agent <id> [--save <dir>]          the plan; saves the agent as it is now
//   node scripts/cartesia-agent-classic.mjs --agent <id> [--save <dir>] --yes    PATCHes it, reads it back, checks it
//   node scripts/cartesia-agent-classic.mjs --agent <id> --restore <agent.json> --yes   puts a saved config back
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { api, loadKey } from "./cartesia-agent-setup.mjs";

export const REF_VERSION = "av_f1C22VxgaAQd8zn2MFk8RS";
/** The one setting not as on call 112. */
export const CLASSIC_CHECK_IN_SECS = 20;

const hash = (s) => createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16);
const copy = (o) => JSON.parse(JSON.stringify(o ?? null));

/** Call 112's config with the check-in at 20 s. Pure. */
export function classicConfig(ref) {
  const c = copy(ref);
  c.turn = { ...(c.turn ?? {}), inactivity_check_in_secs: CLASSIC_CHECK_IN_SECS };
  return c;
}

/** Every leaf of a config, as path → value. */
function leaves(v, p = "", out = {}) {
  if (v && typeof v === "object" && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) leaves(x, `${p}.${k}`, out); }
  else if (Array.isArray(v)) { v.forEach((x, i) => leaves(x, `${p}[${i}]`, out)); }
  else out[p] = v;
  return out;
}
/** Paths where two configs differ (values never printed). */
export function differences(a, b) {
  const A = leaves(a), B = leaves(b);
  return [...new Set([...Object.keys(A), ...Object.keys(B)])].sort().filter(k => JSON.stringify(A[k]) !== JSON.stringify(B[k]));
}

/** The read-back check: equal to `want` everywhere. `{ ok, diff, facts }` (facts: hashes and ids only). */
export function check(got, want) {
  const diff = differences(got, want);
  const facts = {
    instructions: `${String(got?.instructions ?? "").length} chars sha ${hash(got?.instructions)}`,
    skip_turn: `description sha ${hash(got?.system_tools?.skip_turn?.description)}, wait_timeout_secs ${JSON.stringify(got?.system_tools?.skip_turn?.wait_timeout_secs ?? null)}`,
    check_in_secs: got?.turn?.inactivity_check_in_secs, voice: got?.audio?.output?.voice_id, model: got?.model?.id,
    tools: (got?.tools ?? []).map(t => t.id).join(","),
  };
  return { ok: diff.length === 0, diff, facts };
}

export async function main(argv = process.argv.slice(2), { log = console.log, call = api, key = null } = {}) {
  const { values: o } = parseArgs({ args: argv, options: { agent: { type: "string" }, save: { type: "string" }, restore: { type: "string" }, yes: { type: "boolean" } } });
  if (!o.agent) { log("--agent <id> is needed"); return 2; }
  const k = key ?? loadKey();
  if (!k) { log("No CARTESIA_API_KEY."); return 2; }
  const path = `/v1/agents/${encodeURIComponent(o.agent)}`;
  const now = await call(k, path);
  if (!now.ok) { log(`Could not read the agent: ${now.error}`); return 1; }
  if (o.save) {
    mkdirSync(o.save, { recursive: true, mode: 0o700 });
    writeFileSync(join(o.save, "cartesia-agent-before.json"), JSON.stringify(now.json, null, 1), { mode: 0o600 });
  }
  log(`Now: version ${now.json?.version?.id}, ${JSON.stringify(check(now.json?.config, now.json?.config).facts)}`);
  let want, what;
  if (o.restore) {
    want = copy(JSON.parse(readFileSync(o.restore, "utf8"))?.config);
    what = `config put back from ${o.restore}`;
  } else {
    const ref = await call(k, `${path}/versions/${REF_VERSION}`);
    if (!ref.ok || !ref.json?.config) { log(`Could not read version ${REF_VERSION}: ${ref.error}`); return 1; }
    if (o.save) writeFileSync(join(o.save, "cartesia-version-ref.json"), JSON.stringify(ref.json, null, 1), { mode: 0o600 });
    want = classicConfig(ref.json.config);
    what = `classic feel: config of ${REF_VERSION} (call 112), check-in ${CLASSIC_CHECK_IN_SECS} s`;
    log(`Reference ${REF_VERSION}: ${JSON.stringify(check(ref.json.config, ref.json.config).facts)}`);
  }
  log(`Plan: ${what}. Fields that change: ${differences(now.json?.config, want).join(" ") || "none"}`);
  if (!o.yes) { log("Nothing changed (add --yes)."); return 0; }
  const r = await call(k, path, { method: "PATCH", body: { config: want, version_description: `Reason: ${what}`.slice(0, 200) } });
  if (!r.ok) { log(`PATCH refused: ${r.error}`); return 1; }
  const back = await call(k, path);
  if (!back.ok) { log(`Could not read it back: ${back.error}`); return 1; }
  const c = check(back.json?.config, want);
  log(`After: version ${back.json?.version?.id}, ${JSON.stringify(c.facts)}`);
  log(c.ok ? "Read back: equal to the plan in every field." : `Read back differs at: ${c.diff.join(" ")}`);
  return c.ok ? 0 : 3;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().then((c) => { process.exitCode = c; });
