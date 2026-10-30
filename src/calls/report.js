// The call audit's numbers, read from the database: per call and in aggregate. No words — no goal,
// no transcript, no summary — only lengths, reasons, costs and timings. Used by scripts/call-report.js.
import { percentile } from "./metrics.js";

/** The columns a table has, so a report against a database that predates a migration still runs. */
function columnsOf(sqlite, table) {
  return new Set(sqlite.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

/**
 * Per-call rows and aggregates. `sqlite` is a node:sqlite DatabaseSync (opened read-only by the
 * script). `since` is a ms timestamp; calls created before it are left out.
 */
export function buildCallReport(sqlite, { since = 0 } = {}) {
  const cols = columnsOf(sqlite, "calls");
  const pick = (c) => (cols.has(c) ? c : `NULL AS ${c}`);
  const hasTurns = columnsOf(sqlite, "call_turns").size > 0;
  const calls = sqlite.prepare(`SELECT id, provider, direction, is_owner, state, created_at, ended_at, duration_s, cost_cents,
      ${pick("end_reason")}, ${pick("end_detail")}, ${pick("cost_credits")}, ${pick("cost_raw")}
    FROM calls WHERE created_at >= ? ORDER BY id ASC`).all(since);

  const rows = calls.map(c => {
    const turns = hasTurns
      ? sqlite.prepare("SELECT * FROM call_turns WHERE call_id = ? ORDER BY turn_index ASC, id ASC").all(c.id)
      : [];
    const heard = turns.map(t => t.first_content_ms).filter(Number.isFinite);
    const real = turns.map(t => t.first_real_ms).filter(Number.isFinite);
    const sum = (k) => turns.reduce((n, t) => n + (Number.isFinite(t[k]) ? t[k] : 0), 0);
    return {
      id: c.id,
      provider: c.provider,
      direction: c.direction ?? "",
      owner: Number(c.is_owner) === 1,
      state: c.state,
      duration_s: c.duration_s ?? null,
      end_reason: c.end_reason ?? null,
      end_detail: c.end_detail || "",
      cost_cents: c.cost_cents ?? null,
      cost_credits: c.cost_credits ?? null,
      turns: turns.length,
      heard_p50_ms: percentile(heard, 50),
      heard_p95_ms: percentile(heard, 95),
      real_p50_ms: percentile(real, 50),
      real_p95_ms: percentile(real, 95),
      holding_lines: turns.filter(t => Number(t.holding_line) === 1).length,
      closed_early: turns.filter(t => Number(t.closed_early) === 1).length,
      llm_input_tokens: sum("input_tokens"),
      llm_output_tokens: sum("output_tokens"),
      llm_cache_read_tokens: sum("cache_read_tokens"),
      llm_cache_write_tokens: sum("cache_write_tokens"),
    };
  });

  const allTurns = hasTurns
    ? sqlite.prepare("SELECT t.* FROM call_turns t JOIN calls c ON c.id = t.call_id WHERE c.created_at >= ?").all(since)
    : [];
  const heard = allTurns.map(t => t.first_content_ms).filter(Number.isFinite);
  const real = allTurns.map(t => t.first_real_ms).filter(Number.isFinite);
  const durations = rows.map(r => r.duration_s).filter(Number.isFinite);
  const byReason = {};
  for (const r of rows) byReason[r.end_reason ?? "unrecorded"] = (byReason[r.end_reason ?? "unrecorded"] ?? 0) + 1;
  const priced = rows.filter(r => Number.isFinite(r.cost_cents));
  const credited = rows.filter(r => Number.isFinite(r.cost_credits));

  return {
    calls: rows,
    totals: {
      calls: rows.length,
      duration_p50_s: percentile(durations, 50),
      duration_p95_s: percentile(durations, 95),
      end_reasons: byReason,
      cost_cents_total: priced.length ? priced.reduce((n, r) => n + r.cost_cents, 0) : null,
      cost_cents_known_for: priced.length,
      cost_credits_total: credited.length ? credited.reduce((n, r) => n + r.cost_credits, 0) : null,
      cost_credits_known_for: credited.length,
      turns: allTurns.length,
      heard_p50_ms: percentile(heard, 50),
      heard_p95_ms: percentile(heard, 95),
      real_p50_ms: percentile(real, 50),
      real_p95_ms: percentile(real, 95),
      holding_lines: allTurns.filter(t => Number(t.holding_line) === 1).length,
      closed_early: allTurns.filter(t => Number(t.closed_early) === 1).length,
      llm_input_tokens: rows.reduce((n, r) => n + r.llm_input_tokens, 0),
      llm_output_tokens: rows.reduce((n, r) => n + r.llm_output_tokens, 0),
    },
  };
}

/** The report as plain text: one line per call, then the totals. */
export function formatCallReport(report) {
  const v = (x) => (x === null || x === undefined ? "-" : String(x));
  const head = ["call", "dir", "state", "dur_s", "end_reason", "cost_c", "credits", "turns", "heard_p50", "heard_p95", "real_p50", "real_p95", "holding", "closed"];
  const lines = [head.join("\t")];
  for (const r of report.calls) {
    lines.push([r.id, r.direction, r.state, r.duration_s, r.end_reason, r.cost_cents, r.cost_credits, r.turns,
      r.heard_p50_ms, r.heard_p95_ms, r.real_p50_ms, r.real_p95_ms, r.holding_lines, r.closed_early].map(v).join("\t"));
  }
  const t = report.totals;
  lines.push("");
  lines.push(`calls ${t.calls} · duration p50 ${v(t.duration_p50_s)}s p95 ${v(t.duration_p95_s)}s`);
  lines.push(`end reasons ${Object.entries(t.end_reasons).map(([k, n]) => `${k} ${n}`).join(", ") || "-"}`);
  lines.push(`cost ${v(t.cost_cents_total)}¢ (known for ${t.cost_cents_known_for}) · credits ${v(t.cost_credits_total)} (known for ${t.cost_credits_known_for})`);
  lines.push(`turns ${t.turns} · heard p50 ${v(t.heard_p50_ms)}ms p95 ${v(t.heard_p95_ms)}ms · real words p50 ${v(t.real_p50_ms)}ms p95 ${v(t.real_p95_ms)}ms`);
  lines.push(`holding lines ${t.holding_lines} · closed early ${t.closed_early} · LLM tokens in ${t.llm_input_tokens} out ${t.llm_output_tokens}`);
  return lines.join("\n");
}
