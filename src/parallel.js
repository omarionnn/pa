// Parallel, beyond search. One client for the rest of what api.parallel.ai does, so each caller in
// Reason adds a few lines where its own invariant lives rather than a second copy of the key, the
// header, the timeout and the error sentences:
//
//   extract        one or more pages as markdown, focused on an objective — src/weblookup.js
//   imageSearch    real pictures with the page they sit on — the image_search tool
//   answer         a cited answer from live research in 5–60s — research, kind "fact"
//   task*          an async research run that reads far more than Reason's page cap allows and
//                  comes back with citations and confidence — research, deep: true
//   monitor*       "tell me when X happens" with no page to point at — watch_set with a query
//   entitySearch   people and companies in seconds — the niche detour
//   findAll*       a verified list of entities, async — the find_all tool
//   verifyWebhook  the Standard Webhooks signature on anything Parallel pushes back
//
// Search itself stays in src/search.js, where the provider interface lives. Everything here was read
// off docs.parallel.ai on 2026-10-17 (the /v1 GA shapes; FindAll and Entity Search are /v1beta).
//
// Two rules the whole file keeps:
//
//   1. Nothing here decides what is TRUE. A citation Parallel hands back is a source log row the
//      same way a search snippet is: `basisSources` turns it into rows marked with where they came
//      from, and src/research.js says in words what may be claimed off each kind.
//   2. Every call fails as a sentence, never a throw. A missing key, a rejected key, used-up credit
//      and a timeout are different things to tell somebody, and the callers say them.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, clock } from "./config.js";

/** The one error sentence per status, shared by every endpoint. */
function whyFor(status, what) {
  if (status === 401 || status === 403) return "the Parallel key was rejected";
  if (status === 402) return "the Parallel credit is used up";
  if (status === 429) return "Parallel rate limit hit — retry after the cooldown";
  return `Parallel answered ${status} on ${what}`;
}

export function parallelClient({ key = config.parallelKey, base = config.parallelBase, fetchImpl = fetch } = {}) {
  const status = () => key
    ? { connected: true, missing: [], what: "Parallel" }
    : { connected: false, missing: ["PARALLEL_API_KEY"], what: "Parallel" };

  /**
   * One request, one shape back: { ok, json } or { ok: false, error }. `bearer` is for the
   * Responses API, which is OpenAI-compatible and so takes the key as a Bearer token rather than
   * in x-api-key like everything else.
   */
  async function call(method, path, { body = null, timeoutMs = 20_000, bearer = false, what = path } = {}) {
    if (!key) return { ok: false, error: "no PARALLEL_API_KEY on this machine" };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        signal: ac.signal,
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${key}` } : { "x-api-key": key }),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, status: res.status, error: `${whyFor(res.status, what)}${text ? `: ${text.slice(0, 200)}` : ""}` };
      }
      return { ok: true, json: await res.json() };
    } catch (e) {
      if (e.name === "AbortError") return { ok: false, error: `Parallel did not answer within ${timeoutMs / 1000}s on ${what}.` };
      return { ok: false, error: `Could not reach Parallel: ${e.message}` };
    } finally {
      clearTimeout(t);
    }
  }

  return {
    name: "parallel",
    status,

    // ---------- Extract: POST /v1/extract ----------
    /**
     * Pages as markdown. With an `objective`, `excerpts` are the passages that bear on it, which is
     * what a research run wants: 2,500 characters ABOUT the question, not the page's cookie banner.
     * Without one, `full_content` is asked for so a plain web_lookup still reads the whole page.
     */
    async extract(urls, { objective = "", maxChars = 6_000, timeoutMs = config.parallelExtractTimeoutMs } = {}) {
      const list = (Array.isArray(urls) ? urls : [urls]).filter(u => typeof u === "string" && u);
      if (!list.length) return { ok: false, error: "nothing to extract" };
      const r = await call("POST", "/v1/extract", {
        timeoutMs, what: "extract",
        body: {
          urls: list.slice(0, 10),
          ...(objective ? { objective: objective.slice(0, 5_000) } : {}),
          advanced_settings: objective
            ? { excerpt_settings: { max_chars_per_result: maxChars } }
            : { full_content: { max_chars_per_result: maxChars } },
        },
      });
      if (!r.ok) return r;
      const results = (Array.isArray(r.json?.results) ? r.json.results : [])
        .filter(x => typeof x?.url === "string")
        .map(x => {
          const excerpts = (Array.isArray(x.excerpts) ? x.excerpts : []).filter(e => typeof e === "string");
          const text = typeof x.full_content === "string" && x.full_content ? x.full_content : excerpts.join("\n\n");
          return { url: x.url, title: x.title ?? "", date: x.publish_date ?? "", text, images: markdownImages(text) };
        });
      const errors = (Array.isArray(r.json?.errors) ? r.json.errors : []).map(e => ({ url: e?.url ?? "", error: e?.message ?? e?.error ?? "could not be read" }));
      return { ok: true, results, errors };
    },

    // ---------- Image Search: POST /v1/images/search ----------
    async imageSearch({ objective = "", queries = [], maxResults = 10, mode = config.parallelImageMode, timeoutMs = config.searchTimeoutMs } = {}) {
      const list = queries.map(q => String(q ?? "").trim().slice(0, 200)).filter(Boolean).slice(0, 5);
      if (!list.length && !objective) return { ok: false, error: "an image search needs a query" };
      const r = await call("POST", "/v1/images/search", {
        timeoutMs, what: "image search",
        body: {
          ...(objective ? { objective: objective.slice(0, 5_000) } : {}),
          search_queries: list.length ? list : [objective.slice(0, 200)],
          mode,
          max_results: Math.min(Math.max(maxResults, 1), 20),
        },
      });
      if (!r.ok) return r;
      const results = (Array.isArray(r.json?.results) ? r.json.results : [])
        .filter(x => typeof x?.image_url === "string" && /^https:\/\//.test(x.image_url))
        .map(x => ({
          image_url: x.image_url, page_url: x.source_page_url ?? "", title: x.title ?? "",
          width: Number.isFinite(x.width) ? x.width : null, height: Number.isFinite(x.height) ? x.height : null,
        }));
      return { ok: true, results };
    },

    // ---------- Responses: POST /v1/responses (OpenAI-compatible) ----------
    /**
     * A question in, a cited answer out. The citations come back as url_citation annotations on the
     * message text; they are returned as `sources` rows so the research log can hold them, and the
     * answer text is returned separately as what Parallel's agent WROTE — which is not a source.
     */
    async answer(question, { effort = config.parallelAnswerEffort, sites = [], timeoutMs = config.parallelAnswerTimeoutMs } = {}) {
      const r = await call("POST", "/v1/responses", {
        timeoutMs, bearer: true, what: "answer",
        body: {
          model: "parallel",
          input: String(question ?? "").slice(0, 5_000),
          reasoning: { effort },
          ...(sites.length ? { tools: [{ type: "web_search", filters: { allowed_domains: sites.slice(0, 20) } }] } : {}),
        },
      });
      if (!r.ok) return r;
      const items = Array.isArray(r.json?.output) ? r.json.output : [];
      const parts = items.filter(i => i?.type === "message").flatMap(i => Array.isArray(i.content) ? i.content : []).filter(p => p?.type === "output_text");
      const text = parts.map(p => String(p.text ?? "")).join("\n").trim();
      const seen = new Set();
      const sources = [];
      for (const p of parts) {
        for (const a of Array.isArray(p.annotations) ? p.annotations : []) {
          if (a?.type !== "url_citation" || typeof a.url !== "string" || seen.has(a.url)) continue;
          seen.add(a.url);
          const span = Number.isFinite(a.start_index) && Number.isFinite(a.end_index) ? String(p.text ?? "").slice(a.start_index, a.end_index) : "";
          sources.push({ url: a.url, title: a.title ?? "", said: span });
        }
      }
      const searches = items.filter(i => i?.type === "web_search_call").length;
      return { ok: true, text, sources, searches, response_id: r.json?.id ?? "" };
    },

    // ---------- Task API: POST /v1/tasks/runs, GET .../{id}, GET .../{id}/result ----------
    async taskStart(input, { processor = config.parallelDeepProcessor, outputSchema = null, webhookUrl = "", metadata = {}, timeoutMs = 20_000 } = {}) {
      const r = await call("POST", "/v1/tasks/runs", {
        timeoutMs, what: "task start",
        body: {
          input: String(input ?? "").slice(0, 10_000),
          processor,
          task_spec: { output_schema: outputSchema ?? { type: "text" } },
          ...(Object.keys(metadata).length ? { metadata } : {}),
          ...(webhookUrl ? { webhook: { url: webhookUrl, event_types: ["task_run.status"] } } : {}),
        },
      });
      if (!r.ok) return r;
      if (typeof r.json?.run_id !== "string") return { ok: false, error: "Parallel started no run" };
      return { ok: true, run_id: r.json.run_id, status: r.json.status ?? "queued" };
    },

    async taskStatus(runId, { timeoutMs = 15_000 } = {}) {
      const r = await call("GET", `/v1/tasks/runs/${encodeURIComponent(runId)}`, { timeoutMs, what: "task status" });
      if (!r.ok) return r;
      return { ok: true, status: r.json?.status ?? "unknown", active: !!r.json?.is_active, error: r.json?.error?.message ?? "" };
    },

    /**
     * The result of a finished run: `text` is the report (or the JSON as a string), `sources` the
     * citations flattened out of its basis, `confidence` the lowest field confidence.
     */
    async taskResult(runId, { timeoutMs = 30_000 } = {}) {
      const r = await call("GET", `/v1/tasks/runs/${encodeURIComponent(runId)}/result?timeout=${Math.max(1, Math.floor(timeoutMs / 1000) - 5)}`, { timeoutMs, what: "task result" });
      if (!r.ok) return r;
      const out = r.json?.output ?? {};
      const text = typeof out.content === "string" ? out.content : JSON.stringify(out.content ?? "", null, 1);
      const basis = Array.isArray(out.basis) ? out.basis : [];
      return { ok: true, text, sources: basisSources(basis), confidence: lowestConfidence(basis), status: r.json?.run?.status ?? "completed" };
    },

    // ---------- Monitor: /v1/monitors ----------
    async monitorCreate({ query, frequency = "1d", processor = config.parallelMonitorProcessor, webhookUrl = "", metadata = {}, sites = [], timeoutMs = 20_000 } = {}) {
      const r = await call("POST", "/v1/monitors", {
        timeoutMs, what: "monitor create",
        body: {
          type: "event_stream", frequency, processor,
          settings: {
            query: String(query ?? "").slice(0, 1_000),
            ...(sites.length ? { advanced_settings: { source_policy: { include_domains: sites.slice(0, 200) } } } : {}),
          },
          ...(webhookUrl ? { webhook: { url: webhookUrl, event_types: ["monitor.event.detected"] } } : {}),
          ...(Object.keys(metadata).length ? { metadata } : {}),
        },
      });
      if (!r.ok) return r;
      if (typeof r.json?.monitor_id !== "string") return { ok: false, error: "Parallel made no monitor" };
      return { ok: true, monitor_id: r.json.monitor_id, status: r.json.status ?? "active" };
    },

    async monitorCancel(monitorId, { timeoutMs = 15_000 } = {}) {
      const r = await call("POST", `/v1/monitors/${encodeURIComponent(monitorId)}/cancel`, { timeoutMs, what: "monitor cancel" });
      return r.ok ? { ok: true } : r;
    },

    /** Detected events, newest first. Each is { id, group, date, text, sources }. */
    async monitorEvents(monitorId, { eventGroupId = "", timeoutMs = 20_000 } = {}) {
      const q = eventGroupId ? `?event_group_id=${encodeURIComponent(eventGroupId)}` : "";
      const r = await call("GET", `/v1/monitors/${encodeURIComponent(monitorId)}/events${q}`, { timeoutMs, what: "monitor events" });
      if (!r.ok) return r;
      const events = (Array.isArray(r.json?.events) ? r.json.events : [])
        .filter(e => e?.event_type === "event_stream" && typeof e.event_id === "string")
        .map(e => ({
          id: e.event_id, group: e.event_group_id ?? "", date: e.event_date ?? "",
          text: typeof e.output?.content === "string" ? e.output.content : JSON.stringify(e.output?.content ?? ""),
          sources: basisSources(Array.isArray(e.output?.basis) ? e.output.basis : []),
        }));
      return { ok: true, events };
    },

    // ---------- Entity Search: POST /v1beta/findall/entity-search ----------
    async entitySearch({ objective, entityType = "companies", limit = 10, timeoutMs = config.searchTimeoutMs } = {}) {
      const r = await call("POST", "/v1beta/findall/entity-search", {
        timeoutMs, what: "entity search",
        body: { entity_type: entityType, objective: String(objective ?? "").slice(0, 2_000), match_limit: Math.min(Math.max(limit, 5), 1000) },
      });
      if (!r.ok) return r;
      const entities = (Array.isArray(r.json?.entities) ? r.json.entities : [])
        .filter(e => typeof e?.name === "string")
        .map(e => ({ name: e.name, url: typeof e.url === "string" ? e.url : "", description: e.description ?? "" }));
      return { ok: true, entities: entities.slice(0, limit) };
    },

    // ---------- FindAll: /v1beta/findall/ingest, /runs, /runs/{id}, /runs/{id}/result ----------
    async findAllIngest(objective, { timeoutMs = 30_000 } = {}) {
      const r = await call("POST", "/v1beta/findall/ingest", { timeoutMs, what: "findall ingest", body: { objective: String(objective ?? "").slice(0, 2_000) } });
      if (!r.ok) return r;
      const j = r.json ?? {};
      return {
        ok: true, objective: j.objective ?? objective, entity_type: j.entity_type ?? "companies",
        match_conditions: Array.isArray(j.match_conditions) ? j.match_conditions : [],
      };
    },

    async findAllStart({ objective, entityType, matchConditions, generator = config.parallelFindAllGenerator, matchLimit = config.parallelFindAllLimit, webhookUrl = "", metadata = {}, timeoutMs = 20_000 } = {}) {
      const r = await call("POST", "/v1beta/findall/runs", {
        timeoutMs, what: "findall start",
        body: {
          objective, entity_type: entityType, match_conditions: matchConditions, generator, match_limit: matchLimit,
          ...(Object.keys(metadata).length ? { metadata } : {}),
          ...(webhookUrl ? { webhook: { url: webhookUrl, event_types: ["findall.run.completed", "findall.run.cancelled", "findall.run.failed"] } } : {}),
        },
      });
      if (!r.ok) return r;
      if (typeof r.json?.findall_id !== "string") return { ok: false, error: "Parallel started no FindAll run" };
      return { ok: true, run_id: r.json.findall_id, status: r.json.status?.status ?? "queued" };
    },

    async findAllStatus(runId, { timeoutMs = 15_000 } = {}) {
      const r = await call("GET", `/v1beta/findall/runs/${encodeURIComponent(runId)}`, { timeoutMs, what: "findall status" });
      if (!r.ok) return r;
      const s = r.json?.status ?? {};
      return { ok: true, status: s.status ?? "unknown", active: !!s.is_active, matched: s.metrics?.matched_candidates_count ?? 0, generated: s.metrics?.generated_candidates_count ?? 0 };
    },

    /** Matched candidates only, each with the citations that decided it. */
    async findAllResult(runId, { timeoutMs = 30_000 } = {}) {
      const r = await call("GET", `/v1beta/findall/runs/${encodeURIComponent(runId)}/result`, { timeoutMs, what: "findall result" });
      if (!r.ok) return r;
      const all = Array.isArray(r.json?.candidates) ? r.json.candidates : [];
      const matches = all.filter(c => c?.match_status === "matched").map(c => ({
        name: c.name ?? "", url: typeof c.url === "string" ? c.url : "", description: c.description ?? "",
        why: Object.values(c.output ?? {}).map(o => o?.value).filter(v => typeof v === "string").join("; "),
        sources: basisSources(Array.isArray(c.basis) ? c.basis : []),
      }));
      return { ok: true, status: r.json?.run?.status?.status ?? "completed", matches, candidates: all.length };
    },
  };
}

/**
 * Citations out of a Parallel `basis`, as source-log rows. One per url: the first title wins and
 * the excerpts are joined, so a page cited under three fields is one source that said three things.
 */
export function basisSources(basis) {
  const byUrl = new Map();
  for (const field of Array.isArray(basis) ? basis : []) {
    for (const c of Array.isArray(field?.citations) ? field.citations : []) {
      if (typeof c?.url !== "string" || !c.url) continue;
      const excerpts = (Array.isArray(c.excerpts) ? c.excerpts : []).filter(e => typeof e === "string");
      const row = byUrl.get(c.url) ?? { url: c.url, title: c.title ?? "", said: "", reasoning: "" };
      row.said = [row.said, ...excerpts].filter(Boolean).join("\n");
      if (!row.reasoning && typeof field?.reasoning === "string") row.reasoning = field.reasoning;
      byUrl.set(c.url, row);
    }
  }
  return [...byUrl.values()];
}

const CONFIDENCE = { low: 0, medium: 1, high: 2 };
function lowestConfidence(basis) {
  const levels = (Array.isArray(basis) ? basis : []).map(f => f?.confidence).filter(c => c in CONFIDENCE);
  if (!levels.length) return "";
  return levels.sort((a, b) => CONFIDENCE[a] - CONFIDENCE[b])[0];
}

/** Every https image address in a markdown body, the way src/weblookup.js lists them for HTML. */
export function markdownImages(md, max = 40) {
  const out = [];
  const seen = new Set();
  for (const m of String(md ?? "").matchAll(/!\[[^\]]*\]\((https:\/\/[^\s)]+)\)/g)) {
    const u = m[1];
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Standard Webhooks (what Parallel signs with, read 2026-10-17): headers webhook-id,
 * webhook-timestamp (seconds) and webhook-signature ("v1,<base64>", space-separated when a secret
 * was rotated); the HMAC-SHA256 key is the secret with its whsec_ prefix stripped, base64-decoded;
 * the signed string is "<id>.<timestamp>.<body>". Fails closed on a missing secret.
 */
export function verifyWebhook({ rawBody, headers = {}, secret = config.parallelWebhookSecret, now = clock.now(), skewMs = 5 * 60_000 } = {}) {
  if (!secret) return { ok: false, why: "no PARALLEL_WEBHOOK_SECRET on this machine" };
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const id = String(lower["webhook-id"] ?? "");
  const ts = String(lower["webhook-timestamp"] ?? "");
  const sig = String(lower["webhook-signature"] ?? "");
  if (!id || !ts || !sig) return { ok: false, why: "the webhook-id, webhook-timestamp or webhook-signature header is missing" };
  if (!/^\d+$/.test(ts)) return { ok: false, why: "the webhook timestamp is not a number" };
  const ageMs = Math.abs(now - Number(ts) * 1000);
  if (ageMs > skewMs) return { ok: false, why: `the signature is ${Math.round(ageMs / 60_000)} minutes out of date` };

  const keyBytes = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = Buffer.from(createHmac("sha256", keyBytes).update(`${id}.${ts}.${rawBody}`).digest("base64"));
  for (const part of sig.split(" ")) {
    const [version, given] = part.split(",", 2);
    if (version !== "v1" || !given) continue;
    const b = Buffer.from(given);
    if (b.length === expected.length && timingSafeEqual(b, expected)) return { ok: true, id };
  }
  return { ok: false, why: "the signature did not match" };
}

/** What a test or a webhook rehearsal would send: the headers for a body, signed with the secret. */
export function signWebhook({ rawBody, secret, id = `whevent_${Date.now()}`, now = clock.now() }) {
  const ts = String(Math.floor(now / 1000));
  const keyBytes = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const sig = createHmac("sha256", keyBytes).update(`${id}.${ts}.${rawBody}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` };
}

/** Which minutes-between-checks a watcher asked for, as the nearest frequency Monitor offers. */
export function monitorFrequency(everyMin) {
  if (everyMin <= 60 * 6) return "1h";
  if (everyMin <= 60 * 24 * 3) return "1d";
  return "1w";
}

/** The address Parallel pushes to, or "" when this install has no public one (then Reason polls). */
export function webhookUrl() {
  return config.publicUrl ? `${config.publicUrl}/parallel/webhook` : "";
}
