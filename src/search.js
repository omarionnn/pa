// Searching the web, behind a provider interface.
//
// Reason could already read ONE page it was handed. That is not research: asked "iPhone 17 or 18?"
// it read Apple's own page and could not get a price, because the thing it was missing was the step
// before reading — finding out which pages to read. This is that step.
//
// A provider is three functions and nothing else:
//
//   name                      what to call it in a receipt
//   status()                  { connected, missing[], what } — asked before anything is spent
//   search(query, opts)       { ok, results[] } — ranked, normalized, never invented
//
// One real provider (Tavily) and one fake (for the tests) implement it. Everything above this file
// only ever sees the normalized shape, so swapping Tavily for Brave is a new file and a config line,
// not a change to the research flow.
import { config } from "./config.js";

/** One search hit, in the only shape the rest of Reason knows about. */
function hit({ title, url, snippet, date = null, score = null }) {
  return { title: title || "", url, snippet: snippet || "", date: date || null, ...(score === null ? {} : { score }) };
}

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

/**
 * Tavily Search. POST /search, the key as a bearer token, one JSON body, one JSON response.
 *
 * Read off docs.tavily.com on 2026-10-05:
 *   POST https://api.tavily.com/search
 *   Authorization: Bearer tvly-...
 *   body:     { query, search_depth, max_results, topic, include_domains, exclude_domains,
 *               time_range, include_published_date }
 *   response: { query, results: [{ title, url, content, score, published_date? }] }
 *
 * `content` is the snippet Tavily pulled from the source itself, which is why it is usable as a
 * quote when a page cannot be fetched. `published_date` only comes back when it is asked for, so it
 * always is — a review with no date is worth less than one from last month, and Reason has to be
 * able to say which it has.
 */
export function tavilyProvider({ key = config.tavilyKey, base = config.tavilyBase, depth = config.tavilyDepth, fetchImpl = fetch } = {}) {
  return {
    name: "tavily",
    status: () => key
      ? { connected: true, missing: [], what: "Tavily" }
      : { connected: false, missing: ["TAVILY_API_KEY"], what: "Tavily" },

    async search(query, { maxResults = config.searchMaxResults, sites = [], recent = null, timeoutMs = config.searchTimeoutMs } = {}) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${base}/search`, {
          method: "POST",
          signal: ac.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            query,
            search_depth: depth,
            max_results: Math.min(Math.max(maxResults, 1), 20),
            include_published_date: true,
            ...(sites.length ? { include_domains: sites.slice(0, 300) } : {}),
            // day | week | month | year. Anything else is left off rather than guessed at.
            ...(["day", "week", "month", "year"].includes(recent) ? { time_range: recent } : {}),
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          // 401/403 is the key; 429 is the free allowance. Both are things the owner has to act on,
          // so neither is flattened into "search failed".
          const why = res.status === 401 || res.status === 403
            ? "the Tavily key was rejected"
            : res.status === 429
              ? "the Tavily allowance is used up for now"
              : `Tavily answered ${res.status}`;
          return { ok: false, provider: "tavily", error: `${why}${body ? `: ${body.slice(0, 200)}` : ""}` };
        }
        const json = await res.json();
        const results = (Array.isArray(json?.results) ? json.results : [])
          .filter(r => typeof r?.url === "string")
          .map(r => hit({ title: r.title, url: r.url, snippet: r.content, date: r.published_date, score: r.score }));
        return { ok: true, provider: "tavily", results };
      } catch (e) {
        if (e.name === "AbortError") return { ok: false, provider: "tavily", error: `Tavily did not answer within ${timeoutMs / 1000}s.` };
        return { ok: false, provider: "tavily", error: `Could not reach Tavily: ${e.message}` };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Context.dev
// ---------------------------------------------------------------------------

/**
 * Context.dev Web Search. POST /web/search, bearer auth, JSON in and out.
 *
 *   POST https://api.context.dev/v1/web/search
 *   Authorization: Bearer ctxt_secret_...
 *   body:     { query, numResults, includeDomains, freshness }
 *   response: { results: [{ url, title, description, relevance }] }
 *
 * `description` is the snippet. `relevance` is "high" / "medium" / "low".
 */
export function contextDevProvider({ key = config.contextDevKey, base = config.contextDevBase, fetchImpl = fetch } = {}) {
  const FRESHNESS = { day: "last_24_hours", week: "last_week", month: "last_month", year: "last_year" };
  const SCORE = { high: 0.9, medium: 0.6, low: 0.3 };
  return {
    name: "contextdev",
    status: () => key
      ? { connected: true, missing: [], what: "Context.dev" }
      : { connected: false, missing: ["CONTEXT_DEV_API_KEY"], what: "Context.dev" },

    async search(query, { maxResults = config.searchMaxResults, sites = [], recent = null, timeoutMs = config.searchTimeoutMs } = {}) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${base}/web/search`, {
          method: "POST",
          signal: ac.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            query,
            numResults: Math.min(Math.max(maxResults, 10), 100),
            ...(sites.length ? { includeDomains: sites.slice(0, 100) } : {}),
            ...(FRESHNESS[recent] ? { freshness: FRESHNESS[recent] } : {}),
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const why = res.status === 401 || res.status === 403
            ? "the Context.dev key was rejected"
            : res.status === 429
              ? "Context.dev rate limit hit — retry after the cooldown"
              : `Context.dev answered ${res.status}`;
          return { ok: false, provider: "contextdev", error: `${why}${body ? `: ${body.slice(0, 200)}` : ""}` };
        }
        const json = await res.json();
        const results = (Array.isArray(json?.results) ? json.results : [])
          .filter(r => typeof r?.url === "string")
          .map(r => hit({ title: r.title, url: r.url, snippet: r.description, score: SCORE[r.relevance] ?? null }));
        return { ok: true, provider: "contextdev", results };
      } catch (e) {
        if (e.name === "AbortError") return { ok: false, provider: "contextdev", error: `Context.dev did not answer within ${timeoutMs / 1000}s.` };
        return { ok: false, provider: "contextdev", error: `Could not reach Context.dev: ${e.message}` };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The fake, for the tests
// ---------------------------------------------------------------------------

/**
 * A provider that answers from a table instead of the network.
 *
 * The tests use this rather than a recorded HTTP response because what is being tested is the
 * research flow's behaviour — the caps, the source log, a source that will not load — and that
 * behaviour has to be identical whichever provider is underneath. `calls` is the record of what was
 * really asked, so "the cap stopped it searching again" is assertable.
 */
export function fakeProvider({ answers = {}, connected = true, fail = null } = {}) {
  const calls = [];
  return {
    name: "fake",
    calls,
    status: () => connected
      ? { connected: true, missing: [], what: "a fake search provider" }
      : { connected: false, missing: ["TAVILY_API_KEY"], what: "a fake search provider" },
    async search(query, opts = {}) {
      calls.push({ query, ...opts });
      if (fail) return { ok: false, provider: "fake", error: typeof fail === "function" ? fail(query) : String(fail) };
      const found = answers[query] ?? answers["*"] ?? [];
      const results = found.map(r => hit(r)).filter(r => !opts.sites?.length || opts.sites.some(s => r.url.includes(s)));
      return { ok: true, provider: "fake", results: results.slice(0, opts.maxResults ?? config.searchMaxResults) };
    },
  };
}

// ---------------------------------------------------------------------------
// Picking one
// ---------------------------------------------------------------------------

const PROVIDERS = { contextdev: contextDevProvider, tavily: tavilyProvider };

// Context.dev primary, Tavily backup. Only called when the named provider fails at runtime.
const FALLBACK = { contextdev: "tavily" };

/**
 * The provider this machine is set up for, or null when the one it names is not built.
 *
 * Deliberately not "whichever provider has a key": `REASON_SEARCH_PROVIDER` names one, and if its
 * key is missing the answer is "not connected" rather than a quiet fall back to something else. An
 * owner who set up Brave should not find out from a receipt that Reason used Tavily instead.
 */
export function searchProviderNow({ name = config.searchProvider } = {}) {
  const make = PROVIDERS[name];
  return make ? make() : null;
}

/**
 * Is search actually usable right now, and what to say when it is not.
 *
 * Every caller asks this before spending anything, and the answer is the same object the
 * capabilities tool reads, so the tool and the capability list cannot disagree about it.
 */
export function searchStatus({ provider = searchProviderNow() } = {}) {
  if (!provider) {
    return {
      connected: false, provider: config.searchProvider, missing: [],
      error: `No search provider called '${config.searchProvider}' is built. Known: ${Object.keys(PROVIDERS).join(", ")}.`,
    };
  }
  const st = provider.status();
  if (st.connected) return { connected: true, provider: provider.name, missing: [], what: st.what };
  return {
    connected: false, provider: provider.name, missing: st.missing, what: st.what,
    error: `Web search is not connected: this machine has no ${st.missing.join(", ")}.`
      + ` You cannot search. You can still read a page whose address you can name yourself with web_lookup — do that instead, and say plainly that you could not search, only read the pages you already knew about.`,
  };
}

/** What the capabilities tool says about search. Written from the real status, never from a list. */
export function searchCapability({ status = searchStatus() } = {}) {
  if (!status.connected) {
    const missing = status.missing?.length
      ? `this machine has no ${status.missing.join(", ")}`
      : `no provider called '${status.provider}' is built here`;
    return {
      status: "not connected",
      what: `no web search: ${missing}. Reason cannot search for anything.`
        + ` It can still read a page whose address it can name itself (web_lookup) — and when it does that it says so plainly rather than calling it research.`,
    };
  }
  return {
    status: "live",
    what: `search the web through ${status.what} and get back ranked results — title, link, a snippet pulled from the source, and a date when there is one.`
      + ` It is what makes research possible: several searches, then the best pages read in full with web_lookup, then an answer with a source list.`
      + ` Reddit forbids fetching its pages (its robots.txt disallows everything), so what Reddit threads say arrives as search snippets and is labelled that way — never fetched, never invented.`,
  };
}

/**
 * One search. Returns the normalized shape, or an honest not_connected.
 *
 * `provider` is injectable for the tests; production passes nothing and gets what config names.
 */
export async function webSearch(query, { provider = searchProviderNow(), ...opts } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return { ok: false, error: "A search needs a query." };

  const status = searchStatus({ provider });
  if (!status.connected) {
    return { ok: false, status: "not_connected", provider: status.provider, missing: status.missing, error: status.error };
  }

  let out = await provider.search(q, opts);
  if (!out.ok) {
    const fbName = FALLBACK[provider.name];
    const fbMake = fbName && PROVIDERS[fbName];
    if (fbMake) {
      const fb = fbMake();
      const fbStatus = fb.status();
      if (fbStatus.connected) {
        out = await fb.search(q, opts);
        if (out.ok) out.fallback = true;
      }
    }
  }
  if (!out.ok) return { ok: false, provider: out.provider ?? provider.name, query: q, error: out.error };
  return {
    ok: true, provider: out.provider ?? provider.name, query: q,
    results: out.results,
    count: out.results.length,
    note: out.results.length
      ? "These are real results. A snippet is what the provider pulled from that page — it is quotable as a snippet, but to say what a page really claims, read it with web_lookup."
      : "Nothing came back for that query. Try different words rather than answering from memory.",
  };
}
