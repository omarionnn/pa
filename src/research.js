// Research: several searches, the best pages actually read, a source log, and then an answer.
//
// The division of labour here is the whole point. The model plans the queries and writes the pick,
// because those need judgement. Everything that decides what is TRUE is code:
//
//   - a source exists only if a search returned it or a fetch succeeded;
//   - what a source "said" is text that came back, trimmed, never summarized on the way in;
//   - a site that forbids fetching is skipped, and the skip is in the log with the reason;
//   - the caps are counted here, so a question cannot quietly spend forty searches;
//   - a run is a database row, so a deep one survives a restart and its log is still there.
//
// The model then answers from the log it is handed. It cannot cite a source that is not in it,
// because the log is the only thing it is given to cite from.
import { config, clock } from "./config.js";
import * as db from "./db.js";
import { webSearch, searchProviderNow, searchStatus } from "./search.js";
import { webLookup } from "./weblookup.js";
import { robotsAllows } from "./robots.js";
import { NICHES, nicheFor, nichePlan, nicheView, safeSubject } from "./niche.js";
import { parallelClient, webhookUrl as parallelWebhookUrl } from "./parallel.js";

// How a source row says where it came from, and so what may be claimed off it. `page` and
// `search_snippet` are Reason's own reads and finds; the parallel_* ones are what Parallel's agents
// read or found on Reason's behalf (src/parallel.js), and the sentence on each is the whole point:
// a page Parallel read is a page Reason did not.
const VIA = {
  page: "read the page",
  parallel_report: "read by Parallel's research agent, not by you — `said` is the excerpt it quoted from this page, and that is all of it you have",
  search_snippet: "search snippet — this page was not read",
  parallel_answer: "cited by Parallel's quick answer — the page was not read; `said` is the sentence of the answer this page supports",
  parallel_entity: "found by Parallel's entity search — a name and a line about it, nobody read the page",
};

/** Site name from a URL, the way a person would say it: "rtings.com", "reddit.com". */
export function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/**
 * Which results are worth reading, best first.
 *
 * Deliberately one source per site before any site gets a second. Four pages off the same review
 * blog is one opinion wearing four hats, and the thing that makes an answer research rather than a
 * rewrite of one page is that the sources disagree with each other where they disagree.
 */
export function pickSources(results, { max, already = [] }) {
  const seen = new Set(already.map(u => u));
  const bySite = new Map();
  for (const u of already) bySite.set(siteOf(u), 1);

  const rounds = [];
  for (const r of results) {
    if (!r?.url || seen.has(r.url)) continue;
    seen.add(r.url);
    const site = siteOf(r.url);
    const n = bySite.get(site) ?? 0;
    bySite.set(site, n + 1);
    (rounds[n] ??= []).push(r);
  }
  return rounds.flat().slice(0, max);
}

/**
 * Start a run. The row is the run: a deep one is handed to the tasks machinery and whatever happens
 * to the process, the question, the remaining queries and every source read so far are still here.
 */
export function startRun(conversationId, { question, queries = [], taskId = null, niche = "" }) {
  return db.createResearch(conversationId, { question, queries, taskId, niche });
}

/**
 * Work a run until a cap stops it or it runs out of queries.
 *
 * Returns what the model is allowed to answer from, and nothing else: the source log, what was
 * skipped and why, and which cap ended it if one did. Called once for a one-turn question, and once
 * per task wake for a deep one — the caps are cumulative across calls because they live on the row.
 */
export async function step(conversationId, researchId, {
  provider = searchProviderNow(),
  lookup = webLookup,
  robots = robotsAllows,
  maxSearches = config.researchMaxSearches,
  maxPages = config.researchMaxPages,
  maxSeconds = config.researchMaxSeconds,
  maxNicheSearches = config.researchNicheSearches,
  niches = NICHES,
  sourceChars = config.researchSourceChars,
  parallel = parallelClient(),
  now = () => clock.now(),
} = {}) {
  const run = db.getResearch(conversationId, researchId);
  if (!run) return { ok: false, error: `There is no research #${researchId} here.` };
  if (run.state !== "open") return { ok: false, error: `Research #${researchId} is already ${run.state}.` };

  const status = searchStatus({ provider });
  const startedAt = now();
  const outOfTime = () => (now() - startedAt) / 1000 >= maxSeconds;

  let cut = null;
  const searched = [];
  let pending = [...run.queries];
  const entry = nicheFor(run.niche, { niches });

  // No search provider: the run is not a failure, it is a smaller thing said honestly. Whatever the
  // model already put in the log (pages it named itself) still counts; nothing is invented to fill it.
  if (!status.connected) {
    db.finishResearch(conversationId, researchId, { cutShort: "no_search_provider" });
    return {
      ...view(db.getResearch(conversationId, researchId)),
      ok: true, searched: [], status: "not_connected", missing: status.missing,
      note: `There is no web search on this machine (${status.missing.join(", ") || "no provider"} is missing), so nothing was searched.`
        + ` Do not present this as research. If you can name a page yourself, read it with web_lookup and say plainly that is what you did: you looked at the one page you knew about, you could not search.`,
    };
  }

  /**
   * One search, and the best of what it returned read in full.
   *
   * Shared by the planned queries and the niche pass, because the two differ only in where the
   * query came from and in the mark that goes on the rows. Everything that decides what is TRUE —
   * the robots guard, the snippet-before-read order, a failure written down rather than dropped —
   * has to be identical for both, and the surest way to keep it identical is for there to be one
   * copy of it. Returns the cap that stopped it, or null.
   */
  const runQuery = async (query, { niche = "", sites = [], maxReads = Number.POSITIVE_INFINITY } = {}) => {
    const found = await webSearch(query, { provider, maxResults: config.searchMaxResults, ...(sites.length ? { sites } : {}) });
    db.countResearchSearch(researchId, query, { niche });
    const log = niche ? nicheSearched : searched;
    log.push({ query, ok: !!found.ok, results: found.results?.length ?? 0, ...(niche ? { niche } : {}), ...(found.ok ? {} : { error: found.error }) });
    if (!found.ok) return null;

    // Every result goes in the log as a snippet straight away, before anything is read. That is what
    // makes a Reddit thread quotable at all: it can never be fetched, but the provider pulled those
    // words out of it, and a snippet labelled as a snippet is honest where a fetch would be a lie.
    //
    // The `niche` mark rides along, and only sticks when this search is the first thing to find the
    // url — which is the right way round. A page the ordinary queries already turned up is not a
    // source the usual results missed, however the niche pass happens to rank it.
    for (const r of found.results) {
      db.addResearchSource(researchId, {
        url: r.url, site: siteOf(r.url), title: r.title, said: r.snippet.slice(0, 600),
        date: r.date ?? "", via: "search_snippet", state: "found", why: "", niche,
      });
    }

    let stop = null;
    const readAlready = db.listResearchSources(researchId).filter(s => s.state === "read").map(s => s.url);
    const ranked = pickSources(found.results, { max: Number.POSITIVE_INFINITY, already: readAlready });
    const room = Math.min(Math.max(maxPages - readAlready.length, 0), maxReads);
    // More worth reading than the budget allows IS the cap cutting the run short, and it has to be
    // reported rather than quietly truncating the list — an answer off four of nine sources that
    // reads like an answer off all nine is the exact thing the caps are supposed to not produce.
    if (ranked.length > room && maxPages - readAlready.length <= maxReads) stop = "pages";

    for (const pick of ranked.slice(0, room)) {
      if (db.countResearchSources(researchId, { state: "read" }) >= maxPages) { stop = "pages"; break; }
      if (outOfTime()) { stop = "time"; break; }

      const may = await robots(pick.url);
      if (!may.allowed) {
        db.addResearchSource(researchId, {
          url: pick.url, site: siteOf(pick.url), title: pick.title, said: pick.snippet.slice(0, 600),
          date: pick.date ?? "", via: "search_snippet", state: "forbidden", why: may.why, niche,
        });
        continue;
      }

      // The question rides along as the objective: a reader that can focus (Parallel Extract) hands
      // back the 2,500 characters ABOUT it rather than the top of the page; the others ignore it.
      let page;
      try { page = await lookup(pick.url, { maxChars: sourceChars, objective: run.question }); } catch (e) { page = { ok: false, error: e?.message ?? String(e) }; }
      if (!page?.ok) {
        // A page that will not load is said out loud, not quietly dropped. "I could not get into
        // Consumer Reports" is information; a four-source answer that was meant to be five is not.
        db.addResearchSource(researchId, {
          url: pick.url, site: siteOf(pick.url), title: pick.title, said: pick.snippet.slice(0, 600),
          date: pick.date ?? "", via: "search_snippet", state: "failed",
          why: page?.error ?? "the page could not be read", niche,
        });
        continue;
      }
      db.addResearchSource(researchId, {
        url: page.url, site: siteOf(page.url), title: page.title || pick.title,
        said: String(page.text ?? "").slice(0, sourceChars), date: pick.date ?? "",
        via: "page", state: "read", why: "", niche,
      });
      // Same rule as web_lookup: a picture may only reach a page if its address came back from a
      // tool, and these addresses did.
      db.rememberSeenUrls(conversationId, [page.url], { kind: "page" });
      db.rememberSeenUrls(conversationId, (page.images ?? []).slice(0, 10), { kind: "page", from: page.url });
    }
    return stop;
  };

  // The niche plan is deterministic from (kind, question), so which of its searches are still owed
  // is read off the queries that really ran rather than kept in a second place that could disagree
  // with them. A deep run waking for the third time picks up the places it has not been to yet.
  const ranAlready = db.listResearchQueries(researchId).map(q => q.query);
  let nichePending = entry
    ? nichePlan(run.niche, run.question, { niches, max: Number.POSITIVE_INFINITY, already: ranAlready })
    : [];
  const nicheSearched = [];
  let nicheCut = null;

  while (pending.length) {
    if (run.searches + searched.length >= maxSearches) { cut = "searches"; break; }
    if (outOfTime()) { cut = "time"; break; }
    if (db.countResearchSources(researchId, { state: "read" }) >= maxPages) { cut = "pages"; break; }

    cut = await runQuery(pending.shift()) ?? cut;
    if (cut === "pages" || cut === "time") break;
  }

  // The detour. It runs AFTER the planned queries and on its own allowance, so it is never what
  // crowds a good query out — and it is skipped when the shared budgets are the thing that ran out,
  // because reading nothing in an unusual place is not a niche find, it is a line about having
  // looked. `cut === "searches"` deliberately does not skip it: that cap is the planned one.
  if (entry && nichePending.length && cut !== "time" && cut !== "pages") {
    while (nichePending.length) {
      if (run.niche_searches + nicheSearched.length >= maxNicheSearches) { nicheCut = "niche_searches"; break; }
      if (outOfTime()) { nicheCut = "time"; break; }
      if (db.countResearchSources(researchId, { state: "read" }) >= maxPages) { nicheCut = "pages"; break; }

      // Two pages per niche query at most. A site-scoped search returns one site, and letting one
      // forum eat the whole page budget would buy depth in the odd place at the cost of the
      // ordinary sources an answer still has to stand on.
      const place = nichePending.shift();
      const stop = await runQuery(place.query, { niche: entry.kind, sites: place.sites, maxReads: 2 });
      if (stop === "time" || stop === "pages") { nicheCut = stop; break; }
    }
    nichePending = nichePlan(run.niche, run.question, {
      niches, max: Number.POSITIVE_INFINITY, already: db.listResearchQueries(researchId).map(q => q.query),
    });
  }

  // A kind of ask that is really "which people or companies" — a plumber, a local place, who is
  // hiring — gets one entity search on top of the site-scoped ones (src/parallel.js). Once per run:
  // the rows it leaves are the record that it ran, so a wake does not ask the same thing again.
  // Not counted against the niche allowance, and never on the shared budgets' way: it is a list of
  // names with a line each, logged as leads, and a lead may only be offered as something to look at.
  if (entry?.entities && parallel?.status?.().connected && cut !== "time" && cut !== "pages"
    && !db.listResearchSources(researchId).some(s => s.via === "parallel_entity")) {
    const subject = safeSubject(run.question);
    const found = subject ? await parallel.entitySearch({ objective: subject, entityType: entry.entities, limit: 8 }) : { ok: false, error: "nothing to ask" };
    nicheSearched.push({ query: `entities: ${subject}`, ok: !!found.ok, results: found.entities?.length ?? 0, niche: entry.kind, via: "parallel_entity", ...(found.ok ? {} : { error: found.error }) });
    for (const e of found.ok ? found.entities : []) {
      if (!/^https?:\/\//.test(e.url)) continue;
      db.addResearchSource(researchId, {
        url: e.url, site: siteOf(e.url), title: e.name, said: e.description.slice(0, 600),
        date: "", via: "parallel_entity", state: "found", why: "", niche: entry.kind,
      });
    }
  }

  db.setResearchQueries(conversationId, researchId, pending);
  // Places left to go is a reason to stay open too: a deep run that closed with the licensing board
  // unvisited would have spent its niche allowance and then thrown away the knowledge that there
  // was more of it to spend. So is a Parallel run still researching this question: the row stays
  // open until its report has landed, or the wake that brings it would find a finished run.
  const parallelRun = db.parallelRunForResearch(researchId);
  const parallelPending = !!parallelRun && ["queued", "running"].includes(parallelRun.status);
  const more = (pending.length > 0 && !!cut) || (nichePending.length > 0 && nicheCut === "niche_searches") || parallelPending;
  if (!more) db.finishResearch(conversationId, researchId, { cutShort: cut ?? "" });
  else db.noteResearchCut(conversationId, researchId, cut ?? nicheCut);

  const fresh = db.getResearch(conversationId, researchId);
  const nicheOut = entry
    ? {
      niche: {
        ...nicheView(entry, db.listResearchSources(researchId), {
          searched: nicheSearched, left: nichePending.map(p => p.what),
        }),
        cut_short: nicheCut,
      },
    }
    : {};
  return {
    ok: true, ...view(fresh), ...nicheOut, searched, provider: status.provider, more, cut_short: cut,
    ...(parallelPending ? { parallel_pending: true } : {}),
    // `more` is passed as the planned queries alone. A run kept open only because niche places are
    // left has no planned query outstanding, and "there are queries left" would be a false sentence
    // about the thing the model is about to go and do.
    note: noteFor(fresh, { cut, more: pending.length > 0 && !!cut, searched, parallelPending }),
  };
}

// ---------------------------------------------------------------------------
// Parallel's agents doing part of the work (src/parallel.js)
// ---------------------------------------------------------------------------

/**
 * A quick cited answer before any searching, for a question that is one fact rather than a choice.
 *
 * What comes back is two different things and they are logged as two different things: the pages
 * Parallel cited go in the source log as `parallel_answer` snippets — found, not read — and the
 * answer text is returned as what Parallel's agent WROTE, which is not a source and is said back
 * as "Parallel's research says", never as something Reason read. Returns null when there is no key
 * or nothing came back with a citation, and then the ordinary searches run as if this never happened.
 */
export async function answerFirst(conversationId, researchId, { parallel = parallelClient(), sites = [] } = {}) {
  const run = db.getResearch(conversationId, researchId);
  if (!run || !parallel?.status?.().connected) return null;
  const out = await parallel.answer(run.question, { sites });
  if (!out.ok || !out.text || !out.sources.length) return null;
  for (const s of out.sources) {
    db.addResearchSource(researchId, {
      url: s.url, site: siteOf(s.url), title: s.title, said: s.said.slice(0, 600),
      date: "", via: "parallel_answer", state: "found", why: "",
    });
  }
  // The planned queries are dropped and the run closed: the answer IS the run. A thin answer is the
  // model's to notice and say, and a genuinely different question is a new run.
  db.setResearchQueries(conversationId, researchId, []);
  db.finishResearch(conversationId, researchId, { cutShort: "" });
  return { text: out.text, sources: out.sources.length, searches: out.searches };
}

/**
 * Hand a deep question to the Task API as one run. Reason's own slice still runs now; this is the
 * part that reads far past the page cap and comes back with citations and a confidence. The run
 * row (parallel_runs) is what a webhook or a wake finds its way back by.
 */
export async function startDeep(conversationId, researchId, { parallel = parallelClient(), taskId = null, processor = config.parallelDeepProcessor } = {}) {
  const run = db.getResearch(conversationId, researchId);
  if (!run || !parallel?.status?.().connected) return null;
  const started = await parallel.taskStart(
    `${run.question}\n\nWrite a short report that answers this for one person deciding: the pick or the answer first with the reason, then what would change it, then the facts that matter (prices, specs, dates) each with where it came from.`,
    { processor, outputSchema: { type: "text" }, webhookUrl: parallelWebhookUrl(), metadata: { reason_research_id: String(researchId) } },
  );
  if (!started.ok) return { ok: false, error: started.error };
  const row = db.createParallelRun(conversationId, { kind: "task", remoteId: started.run_id, researchId, taskId, objective: run.question });
  return { ok: true, run: row };
}

/**
 * Where the Task API run for this research stands, fetching and logging its report the first time
 * it is found finished. Safe to call on every wake: a report is imported once (the row's `output`
 * says so) and a run still going is simply still going.
 */
export async function pollDeep(conversationId, researchId, { parallel = parallelClient() } = {}) {
  const row = db.parallelRunForResearch(researchId);
  if (!row) return null;
  if (row.status === "completed" && row.output) return { status: "completed", report: row.output };
  if (["failed", "cancelled"].includes(row.status)) return { status: row.status, error: row.error };

  const st = await parallel.taskStatus(row.remote_id);
  if (!st.ok) return { status: row.status, pending: true, error: st.error };
  if (st.status === "failed" || st.status === "cancelled") {
    db.setParallelRunStatus(row.id, { status: st.status, error: st.error || `the run ${st.status}` });
    return { status: st.status, error: st.error || `the run ${st.status}` };
  }
  if (st.status !== "completed") {
    db.setParallelRunStatus(row.id, { status: st.status === "unknown" ? row.status : st.status });
    return { status: st.status, pending: true };
  }
  const res = await parallel.taskResult(row.remote_id);
  if (!res.ok) return { status: "completed", pending: true, error: res.error };
  const report = importReport(conversationId, researchId, res);
  db.setParallelRunStatus(row.id, { status: "completed", output: report });
  return { status: "completed", report };
}

/** The report's citations into the source log, as pages Parallel read; the report itself as the row's output. */
function importReport(conversationId, researchId, { text, sources, confidence }) {
  for (const s of sources) {
    db.addResearchSource(researchId, {
      url: s.url, site: siteOf(s.url), title: s.title, said: [s.said, s.reasoning ? `(its reasoning: ${s.reasoning})` : ""].filter(Boolean).join("\n").slice(0, config.researchSourceChars),
      date: "", via: "parallel_report", state: "read", why: "",
    });
  }
  db.rememberSeenUrls(conversationId, sources.map(s => s.url));
  return { text: String(text ?? "").slice(0, 12_000), confidence: confidence || "", pages: sources.length, by: "Parallel's research agent" };
}

/**
 * The niche block for a run as it stands, with no searching.
 *
 * Needed because the moment the model most needs the verified/leads split explained is the moment
 * it stops searching and writes — `enough: true`, or a carry-on that was refused for being settled.
 * Those paths return the log without stepping, and a log whose niche rows arrived with no note
 * about what may be said of them is the log that turns a snippet into a claim.
 */
export function nicheOf(run, { niches = NICHES } = {}) {
  const entry = run?.niche ? nicheFor(run.niche, { niches }) : null;
  if (!entry) return {};
  const searched = db.listResearchQueries(run.id).filter(q => q.niche).map(q => ({ query: q.query, niche: q.niche }));
  return { niche: nicheView(entry, db.listResearchSources(run.id), { searched }) };
}

/** The run as the model sees it: the question, the log, and nothing it may treat as true beyond it. */
export function view(run) {
  const sources = db.listResearchSources(run.id);
  const read = sources.filter(s => s.state === "read");
  const snippets = sources.filter(s => s.state === "found");
  const skipped = sources.filter(s => s.state === "failed" || s.state === "forbidden");
  const parallelRun = db.parallelRunForResearch(run.id);
  const report = parallelRun?.status === "completed" && parallelRun.output ? parallelRun.output : null;
  return {
    research_id: run.id,
    question: run.question,
    state: run.state,
    searches_used: run.searches,
    pages_read: read.length,
    queries_left: run.queries,
    // `niche` on a row says this source came out of the detour rather than the ordinary queries —
    // see src/niche.js. It is the thing that lets an answer say which find was the unusual one
    // without Reason having to remember which search it came from.
    sources: read.map(s => ({ site: s.site, url: s.url, title: s.title, date: s.date || null, said: s.said, via: VIA[s.via] ?? VIA.page, ...(s.niche ? { niche: s.niche } : {}) })),
    snippets_only: snippets.map(s => ({ site: s.site, url: s.url, title: s.title, date: s.date || null, said: s.said, via: VIA[s.via] ?? VIA.search_snippet, ...(s.niche ? { niche: s.niche } : {}) })),
    skipped: skipped.map(s => ({ site: s.site, url: s.url, why: s.why, what_happened: s.state === "forbidden" ? "the site forbids fetching" : "it would not load" })),
    // The deep run's report, when Parallel's agent has finished one. It is a thing an agent WROTE
    // from the pages it cites, and those pages are in `sources` above marked as read by it.
    ...(report ? { report } : {}),
    ...(parallelRun && ["queued", "running"].includes(parallelRun.status) ? { parallel_pending: true } : {}),
  };
}

function noteFor(run, { cut, more, searched, parallelPending = false }) {
  const sources = db.listResearchSources(run.id);
  const read = sources.filter(s => s.state === "read").length;
  const sites = new Set(sources.filter(s => s.state === "read").map(s => s.site)).size;
  const byParallel = sources.filter(s => s.via === "parallel_report").length;
  const lines = [];

  if (byParallel) {
    lines.push(`Parallel's research agent read ${byParallel} page(s) for this and wrote the report in \`report\`. Say that is where it came from ("the research says", not "I read"). Quote a price, a spec or a date only if it is in a source's \`said\`; the report's own sentences are its claims, cite them as that.`);
  }
  if (parallelPending) {
    lines.push("Parallel's deep run on this question is still going. Do not wait on it in this turn: answer from what is here, say more is coming, and on the task wake call research with this research_id to pick up the report.");
  }
  if (!read && !byParallel) {
    lines.push("Nothing was read. You have search snippets and nothing else, so you do not have research — say what you could not get into and offer to try a different angle. Never answer a 'which should I buy' question off snippets alone as though you had looked properly.");
  } else if (sites < 2) {
    lines.push(`Only ${sites} site was actually read. That is one source, not research: say so plainly rather than presenting it as a verdict from several places.`);
  } else {
    lines.push(`${read} page(s) across ${sites} sites were read. Answer from them: a real pick first in one or two lines with the reason, then what would change it, then the sites named plainly.`);
  }

  if (cut === "searches") lines.push(`The search cap (${config.researchMaxSearches}) stopped this, and ${run.queries.length} planned quer(ies) never ran. Tell them the answer is based on a partial look and say what you did not get to.`);
  if (cut === "pages") lines.push(`The page cap (${config.researchMaxPages}) stopped this. Say the answer is based on the pages you got, not everything there is.`);
  if (cut === "time") lines.push(`This ran out of time (${config.researchMaxSeconds}s). Say so, and say what is missing.`);
  if (more) lines.push("There are queries left. For a question worth more work, carry on with research(research_id) — if it is a deep run, that is what the task wake is for.");

  const failed = sources.filter(s => s.state === "failed");
  const forbidden = sources.filter(s => s.state === "forbidden");
  if (failed.length) lines.push(`${failed.length} source(s) would not load (${failed.map(s => s.site).join(", ")}). Mention that you could not get into them; do not pretend you did.`);
  if (forbidden.length) lines.push(`${forbidden.length} source(s) forbid fetching (${[...new Set(forbidden.map(s => s.site))].join(", ")}). For those you have ONLY the search snippet: you may quote the snippet and say it is from a ${forbidden[0].site} thread, and you may not describe anything else as being on that page.`);
  if (searched?.some(s => !s.ok)) lines.push("Some searches themselves failed; say the look was incomplete.");

  lines.push("Every price, spec, date and quote you say has to appear in a source above. If it is not there, you do not have it — say what you could not find.");
  return lines.join(" ");
}
