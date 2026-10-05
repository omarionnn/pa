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
export function startRun(conversationId, { question, queries = [], taskId = null }) {
  return db.createResearch(conversationId, { question, queries, taskId });
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
  sourceChars = config.researchSourceChars,
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

  while (pending.length) {
    if (run.searches + searched.length >= maxSearches) { cut = "searches"; break; }
    if (outOfTime()) { cut = "time"; break; }
    if (db.countResearchSources(researchId, { state: "read" }) >= maxPages) { cut = "pages"; break; }

    const query = pending.shift();
    const found = await webSearch(query, { provider, maxResults: config.searchMaxResults });
    db.countResearchSearch(researchId, query);
    searched.push({ query, ok: !!found.ok, results: found.results?.length ?? 0, ...(found.ok ? {} : { error: found.error }) });
    if (!found.ok) continue;

    // Every result goes in the log as a snippet straight away, before anything is read. That is what
    // makes a Reddit thread quotable at all: it can never be fetched, but the provider pulled those
    // words out of it, and a snippet labelled as a snippet is honest where a fetch would be a lie.
    for (const r of found.results) {
      db.addResearchSource(researchId, {
        url: r.url, site: siteOf(r.url), title: r.title, said: r.snippet.slice(0, 600),
        date: r.date ?? "", via: "search_snippet", state: "found", why: "",
      });
    }

    const readAlready = db.listResearchSources(researchId).filter(s => s.state === "read").map(s => s.url);
    const ranked = pickSources(found.results, { max: Number.POSITIVE_INFINITY, already: readAlready });
    const room = Math.max(maxPages - readAlready.length, 0);
    // More worth reading than the budget allows IS the cap cutting the run short, and it has to be
    // reported rather than quietly truncating the list — an answer off four of nine sources that
    // reads like an answer off all nine is the exact thing the caps are supposed to not produce.
    if (ranked.length > room) cut = "pages";

    for (const pick of ranked.slice(0, room)) {
      if (db.countResearchSources(researchId, { state: "read" }) >= maxPages) { cut = "pages"; break; }
      if (outOfTime()) { cut = "time"; break; }

      const may = await robots(pick.url);
      if (!may.allowed) {
        db.addResearchSource(researchId, {
          url: pick.url, site: siteOf(pick.url), title: pick.title, said: pick.snippet.slice(0, 600),
          date: pick.date ?? "", via: "search_snippet", state: "forbidden", why: may.why,
        });
        continue;
      }

      let page;
      try { page = await lookup(pick.url, { maxChars: sourceChars }); } catch (e) { page = { ok: false, error: e?.message ?? String(e) }; }
      if (!page?.ok) {
        // A page that will not load is said out loud, not quietly dropped. "I could not get into
        // Consumer Reports" is information; a four-source answer that was meant to be five is not.
        db.addResearchSource(researchId, {
          url: pick.url, site: siteOf(pick.url), title: pick.title, said: pick.snippet.slice(0, 600),
          date: pick.date ?? "", via: "search_snippet", state: "failed",
          why: page?.error ?? "the page could not be read",
        });
        continue;
      }
      db.addResearchSource(researchId, {
        url: page.url, site: siteOf(page.url), title: page.title || pick.title,
        said: String(page.text ?? "").slice(0, sourceChars), date: pick.date ?? "",
        via: "page", state: "read", why: "",
      });
      // Same rule as web_lookup: a picture may only reach a page if its address came back from a
      // tool, and these addresses did.
      db.rememberSeenUrls(conversationId, [page.url, ...(page.images ?? []).slice(0, 10)]);
    }
    if (cut === "pages" || cut === "time") break;
  }

  db.setResearchQueries(conversationId, researchId, pending);
  const more = pending.length > 0 && !!cut;
  if (!more) db.finishResearch(conversationId, researchId, { cutShort: cut ?? "" });
  else db.noteResearchCut(conversationId, researchId, cut);

  const fresh = db.getResearch(conversationId, researchId);
  return { ok: true, ...view(fresh), searched, provider: status.provider, more, cut_short: cut, note: noteFor(fresh, { cut, more, searched }) };
}

/** The run as the model sees it: the question, the log, and nothing it may treat as true beyond it. */
export function view(run) {
  const sources = db.listResearchSources(run.id);
  const read = sources.filter(s => s.state === "read");
  const snippets = sources.filter(s => s.state === "found");
  const skipped = sources.filter(s => s.state === "failed" || s.state === "forbidden");
  return {
    research_id: run.id,
    question: run.question,
    state: run.state,
    searches_used: run.searches,
    pages_read: read.length,
    queries_left: run.queries,
    sources: read.map(s => ({ site: s.site, url: s.url, title: s.title, date: s.date || null, said: s.said, via: "read the page" })),
    snippets_only: snippets.map(s => ({ site: s.site, url: s.url, title: s.title, date: s.date || null, said: s.said, via: "search snippet — this page was not read" })),
    skipped: skipped.map(s => ({ site: s.site, url: s.url, why: s.why, what_happened: s.state === "forbidden" ? "the site forbids fetching" : "it would not load" })),
  };
}

function noteFor(run, { cut, more, searched }) {
  const sources = db.listResearchSources(run.id);
  const read = sources.filter(s => s.state === "read").length;
  const sites = new Set(sources.filter(s => s.state === "read").map(s => s.site)).size;
  const lines = [];

  if (!read) {
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
