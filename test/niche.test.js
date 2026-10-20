// Niche source discovery, without the model. The provider is a fake, the niche registry is a
// fixture pointing at a local server, and the sources are pages that server really serves — so what
// is tested here is the part code owns:
//
//   - the detour happens at all: a site-scoped search the planned queries were never going to make;
//   - it is paid for out of its own allowance, so it never crowds out a planned query;
//   - a page READ at its own address and a snippet nobody opened are told apart, and the note says
//     the second may not be presented as the first;
//   - nothing turned up is reported as nothing turned up, with an instruction not to pad;
//   - a niche query carries no contact details out to the search provider;
//   - the plan is deterministic, so a run that wakes three times does not search the same place
//     three times.
//
// No API key needed. Nothing live is ever touched.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSourceSite } from "./fixture-sources.js";

const dir = mkdtempSync(join(tmpdir(), "reason-niche-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
// Flow tests pass a provider explicitly, so the key only decides what the capability list says.
process.env.REASON_SEARCH_PROVIDER = "tavily";
process.env.TAVILY_API_KEY = "tvly-test";

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { fakeProvider } = await import("../src/search.js");
const { robotsAllows, clearRobotsCache } = await import("../src/robots.js");
const { NICHES, nicheKinds, nicheFor, nicheCatalogue, nichePlan, safeSubject } = await import("../src/niche.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = "dm:niche";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

let site;
let forbidden;

before(async () => {
  site = await startSourceSite();
  // A host whose robots.txt disallows everything — Reddit's real policy, and the reason half the
  // niche registry's best places can only ever be leads.
  forbidden = await startSourceSite({ robots: "User-agent: *\nDisallow: /\n" });
});
after(async () => {
  await site.close();
  await forbidden.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clock.reset();
  clearRobotsCache();
  db.db.exec("DELETE FROM research; DELETE FROM research_sources; DELETE FROM research_queries;"
    + " DELETE FROM tasks; DELETE FROM task_log; DELETE FROM action_ledger; DELETE FROM seen_urls;");
});

const results = (paths, { host = () => site.url } = {}) => paths.map(([path, title, date]) => ({
  title, url: `${host()}${path}`, snippet: `${title} — snippet text`, date: date ?? null,
}));

const provider = (answers) => fakeProvider({ answers });
const openRobots = async () => ({ allowed: true, checked: false, why: "fixture" });
const realRobots = (u) => robotsAllows(u, { allowLocal: false });
const call = (name, input, ctx = {}) => runTool(name, input, { conversationId: C, ...ctx });

/**
 * A registry shaped exactly like the real one, pointing at the fixture hosts.
 *
 * The real entries name github.com and a state licensing board, which a test must never reach — but
 * the SHAPE is what the flow depends on, so the fixture keeps it: three places, best first, each
 * with its own site, its own query and its own sentence about why an ordinary search misses it.
 * `kind` is a real one so the tool's own schema accepts it.
 */
const fixtureNiches = () => [{
  kind: "tech_jobs",
  label: "engineering, design and startup roles",
  why: "a lot of these roles are never posted to a job board at all.",
  sources: [
    {
      site: `127.0.0.1:${site.port}`,
      what: "hiring repos",
      why: "companies that hire engineers keep the list where engineers already are, not on a job board.",
      query: s => `${s} hiring README`,
    },
    {
      site: `127.0.0.1:${forbidden.port}`,
      what: "the monthly who-is-hiring thread",
      why: "one thread a month carries roles that exist nowhere else.",
      query: s => `who is hiring ${s}`,
      note: "this one forbids being fetched, so it comes back as a snippet.",
    },
    {
      site: `localhost:${site.port}`,
      what: "the company's own careers page",
      why: "the aggregators lag the company's own page by days.",
      query: s => `${s} careers apply`,
    },
  ],
}];

// ---------------------------------------------------------------------------
// the registry itself
// ---------------------------------------------------------------------------

test("every kind in the registry is complete enough to be used", () => {
  assert.ok(NICHES.length >= 5, "a registry with three entries is a special case, not a feature");
  for (const n of NICHES) {
    assert.match(n.kind, /^[a-z_]+$/, `${n.kind} is what the model passes, so it has to be a plain token`);
    assert.ok(n.label && n.why, `${n.kind} needs something to say about itself out loud`);
    assert.ok(n.sources.length >= 3, `${n.kind} with two places is barely a detour`);
    for (const s of n.sources) {
      assert.equal(typeof s.query, "function", `${n.kind}/${s.what} needs a query built from the subject`);
      assert.ok(s.what && s.why, `${n.kind}/${s.what} needs the reason an ordinary search misses it`);
      assert.ok(s.query("widget").includes("widget"), "the subject has to actually reach the query");
    }
    // At least one unrestricted search per kind: the "direct provider page" case has no one domain,
    // because the provider is a different company every time.
    assert.ok(n.sources.some(s => !s.site), `${n.kind} never goes at whoever actually runs the thing`);
  }
});

test("a source that cannot be fetched says so in the registry rather than finding out later", () => {
  for (const n of NICHES) {
    for (const s of n.sources.filter(s => s.site === "reddit.com")) {
      assert.match(s.note ?? "", /forbids/i, `${n.kind}'s reddit source has to carry that up front`);
    }
  }
  // The two places that make this feature worth having at all.
  assert.ok(nicheFor("trades").sources.some(s => /licen[cs]e/i.test(s.what)),
    "checking a tradesperson's licence is the whole point of the trades detour");
  assert.ok(nicheFor("tech_jobs").sources.some(s => s.site === "github.com"),
    "a role that only exists in a repo is the case this was built for");
});

test("kinds, and a kind nobody has", () => {
  assert.ok(nicheKinds().includes("housing"));
  assert.equal(nicheFor("nonsense"), null);
  assert.equal(nicheFor(""), null);
  assert.equal(nicheFor(undefined), null);
  assert.equal(nicheFor("TRADES").kind, "trades", "the model's casing is not a refusal");
  assert.deepEqual(nicheCatalogue().map(n => n.kind), nicheKinds());
});

// ---------------------------------------------------------------------------
// what goes out on the wire
// ---------------------------------------------------------------------------

test("a niche query carries no phone number, email or reference out to the search provider", () => {
  const q = "find me a plumber, my number's +1 (202) 555-1234, email me at omari@example.com, invoice 4417829";
  const safe = safeSubject(q);
  assert.ok(!/202/.test(safe), safe);
  assert.ok(!/@example\.com/.test(safe), safe);
  assert.ok(!/4417829/.test(safe), safe);
  assert.match(safe, /plumber/, "the thing they actually want is still in there");

  for (const p of nichePlan("trades", q, { max: 99 })) {
    assert.ok(!/202|example\.com|4417829/.test(p.query), p.query);
  }
});

test("the plan is deterministic, capped, and does not go back where it has been", () => {
  const first = nichePlan("tech_jobs", "senior backend engineer boston", { max: 2 });
  assert.equal(first.length, 2);
  assert.deepEqual(nichePlan("tech_jobs", "senior backend engineer boston", { max: 2 }), first,
    "the same question plans the same places, which is what makes `already` enough on its own");

  const next = nichePlan("tech_jobs", "senior backend engineer boston", {
    max: 2, already: first.map(p => p.query),
  });
  assert.equal(next.length, 2);
  assert.ok(!next.some(p => first.some(f => f.query === p.query)), "a second wake goes somewhere new");

  assert.deepEqual(nichePlan("nonsense", "x"), [], "an unknown kind plans nothing rather than guessing");
  assert.deepEqual(nichePlan("tech_jobs", "   "), [], "a question with nothing left in it plans nothing");
});

// ---------------------------------------------------------------------------
// the flow
// ---------------------------------------------------------------------------

test("the detour happens: a site-scoped search the planned queries were never going to make", async () => {
  const p = provider({
    "backend engineer boston salary": results([["/review-a", "Salary report"]]),
    "backend engineer boston hiring README": results([["/maker", "Acme is hiring — README"]]),
    "who is hiring backend engineer boston": results([["/forum", "Who is hiring (October)"]], { host: () => forbidden.url }),
  });

  const out = await call("research", {
    question: "backend engineer boston",
    queries: ["backend engineer boston salary"],
    niche: "tech_jobs",
  }, { searchProvider: p, robots: realRobots, niches: fixtureNiches() });

  assert.equal(out.ok, true);

  // The niche searches really ran, and they ran restricted to the places the registry named.
  const nicheCalls = p.calls.filter(c => c.sites?.length);
  assert.equal(nicheCalls.length, 2);
  assert.deepEqual(nicheCalls[0].sites, [`127.0.0.1:${site.port}`]);
  assert.deepEqual(nicheCalls.map(c => c.query),
    ["backend engineer boston hiring README", "who is hiring backend engineer boston"]);
  // The planned query was NOT restricted, because it is the model's own words.
  assert.equal(p.calls.find(c => c.query === "backend engineer boston salary").sites, undefined);

  // The find is in the log like any other source, and marked as the one that came off the detour.
  const repo = out.sources.find(s => s.url.endsWith("/maker"));
  assert.equal(repo.niche, "tech_jobs");
  assert.match(repo.said, /\$899/, "the text is what the page really served");
  assert.equal(out.sources.find(s => s.url.endsWith("/review-a")).niche, undefined,
    "a page an ordinary query found is not a source the usual results missed");

  // And the why layer: the registry's own sentence, not something invented about a domain.
  assert.equal(out.niche.kind, "tech_jobs");
  assert.equal(out.niche.verified.length, 1);
  assert.equal(out.niche.verified[0].what, "hiring repos");
  assert.match(out.niche.verified[0].why, /keep the list where engineers already are/);
  assert.equal(out.niche.verified[0].said, undefined, "the text lives in sources, once");
  assert.match(out.niche.note, /say in one line where it came from and why/i);
});

test("the niche allowance is its own: a spent search cap does not stop the detour", async () => {
  const p = provider({
    "a": results([["/review-a", "A"]]),
    "widget hiring README": results([["/maker", "Hiring repo"]]),
    "*": [],
  });

  const out = await call("research", {
    question: "widget",
    queries: ["a", "b"],
    niche: "tech_jobs",
  }, {
    searchProvider: p, robots: openRobots, niches: fixtureNiches(),
    researchCaps: { maxSearches: 1 },
  });

  assert.equal(out.cut_short, "searches", "the planned budget really did run out");
  assert.equal(out.searches_used, 1);
  assert.ok(p.calls.some(c => c.query === "widget hiring README"),
    "the detour is paid for separately, which is the whole reason it exists as a separate budget");
  assert.equal(out.niche.verified.length, 1);
});

test("a lead is not a find: a snippet nobody opened is kept apart and labelled", async () => {
  const p = provider({
    "pixel 11 review": results([["/review-a", "Tested Weekly"]]),
    "pixel 11 hiring README": [],
    "who is hiring pixel 11": results([["/forum", "Anyone regret upgrading?"]], { host: () => forbidden.url }),
  });

  const before = forbidden.hits.length;
  const out = await call("research", {
    question: "pixel 11",
    queries: ["pixel 11 review"],
    niche: "tech_jobs",
  }, { searchProvider: p, robots: realRobots, niches: fixtureNiches() });

  const pageHits = forbidden.hits.slice(before).filter(h => h !== "/robots.txt");
  assert.deepEqual(pageHits, [], "a site that said no was never fetched");

  assert.equal(out.niche.verified.length, 0);
  assert.equal(out.niche.leads.length, 1);
  const lead = out.niche.leads[0];
  assert.ok(lead.url.endsWith("/forum"));
  assert.equal(lead.what, "the monthly who-is-hiring thread");
  assert.match(lead.not_read.what_happened, /forbids being fetched/);
  // The quotable text is in the ordinary snippet list, once, labelled as a snippet.
  const snip = out.snippets_only.find(s => s.url.endsWith("/forum"));
  assert.match(snip.via, /not read/i);
  assert.equal(snip.niche, "tech_jobs");

  assert.match(out.niche.note, /LEADS, not finds/);
  assert.match(out.niche.note, /may not state what is on it/i);
  assert.match(out.niche.note, /forbid being fetched/i);
});

test("nothing in the niche places is reported as nothing, with an instruction not to pad", async () => {
  const p = provider({ "pixel 11 review": results([["/review-a", "Tested Weekly"]]), "*": [] });

  const out = await call("research", {
    question: "pixel 11",
    queries: ["pixel 11 review"],
    niche: "tech_jobs",
  }, { searchProvider: p, robots: openRobots, niches: fixtureNiches() });

  assert.equal(out.niche.verified.length, 0);
  assert.equal(out.niche.leads.length, 0);
  assert.equal(out.niche.searched.length, 2, "it really went and looked");
  assert.match(out.niche.note, /came back with nothing useful/i);
  assert.match(out.niche.note, /say nothing about niche sources/i);
  assert.match(out.niche.note, /do not pad/i);
});

test("no niche passed, no niche block — an ordinary question is unchanged", async () => {
  const p = provider({ "pixel 11 review": results([["/review-a", "Tested Weekly"]]) });
  const out = await call("research", { question: "pixel 11", queries: ["pixel 11 review"] },
    { searchProvider: p, robots: openRobots, niches: fixtureNiches() });

  assert.equal(out.niche, undefined);
  assert.equal(p.calls.length, 1, "nothing extra was searched and nothing extra was spent");
  assert.equal(out.sources.length, 1);
});

test("a kind nobody has is ignored rather than refusing the question", async () => {
  const p = provider({ "pixel 11 review": results([["/review-a", "Tested Weekly"]]) });
  const out = await call("research", { question: "pixel 11", queries: ["pixel 11 review"], niche: "trades" },
    { searchProvider: p, robots: openRobots, niches: fixtureNiches() });

  assert.equal(out.ok, true, "the research still happened");
  assert.equal(out.niche, undefined, "and nothing pretended to be a niche look");
  assert.equal(out.sources.length, 1);
});

test("the niche cap holds, the places not visited are named, and a later call goes to them", async () => {
  const p = provider({
    "widget review": results([["/review-a", "A"]]),
    "widget hiring README": results([["/maker", "Repo"]]),
    "who is hiring widget": [],
    "widget careers apply": results([["/review-b", "Careers"]], { host: () => site.altUrl }),
  });
  const ctx = { searchProvider: p, robots: openRobots, niches: fixtureNiches() };

  const first = await call("research", {
    question: "widget", queries: ["widget review"], niche: "tech_jobs",
  }, ctx);

  assert.equal(first.niche.searched.length, config.researchNicheSearches);
  assert.equal(first.niche.cut_short, "niche_searches");
  assert.deepEqual(first.niche.left, ["the company's own careers page"]);
  assert.match(first.niche.note, /have not been looked at yet/);
  assert.equal(first.more, true, "a place left to go is a reason to stay open");
  assert.ok(!/queries left/i.test(first.note),
    "no planned query is outstanding, so the planned note must not claim one is");

  // Cumulative, exactly like the planned budget: a later call does not get a fresh allowance, it
  // gets whatever is left of the one this run has been spending.
  const capped = await call("research", { research_id: first.research_id }, ctx);
  assert.deepEqual(capped.niche.searched, [], "the allowance is a total for the run, not per call");

  const second = await call("research", { research_id: first.research_id },
    { ...ctx, researchCaps: { maxNicheSearches: 3 } });
  assert.deepEqual(second.niche.searched.map(s => s.query), ["widget careers apply"],
    "the second call goes somewhere new rather than searching the first two again");
  assert.deepEqual(second.niche.left, []);
  assert.equal(second.niche.verified.length, 2);
  assert.equal(second.more, false);

  // Counted separately on the row, all the way through.
  const run = db.getResearchAnywhere(first.research_id);
  assert.equal(run.searches, 1);
  assert.equal(run.niche_searches, 3);
  assert.equal(run.niche, "tech_jobs");
});

test("the kind survives a restart, because it is on the row and not in the turn", async () => {
  const p = provider({ "*": [] });
  const out = await call("research", {
    question: "widget", queries: ["widget review"], niche: "housing",
  }, { searchProvider: p, robots: openRobots });

  assert.equal(db.getResearchAnywhere(out.research_id).niche, "housing");
});

test("one niche query cannot eat the page budget", async () => {
  // Four readable pages behind one niche search. Two is the limit per niche query, so the other
  // two stay leads and the ordinary sources an answer stands on are not crowded out.
  const p = provider({
    "widget review": results([["/review-a", "A"]]),
    "widget hiring README": results([
      ["/maker", "One"], ["/review-b", "Two"], ["/forum", "Three"], ["/review-a", "Four"],
    ]),
    "*": [],
  });

  const out = await call("research", {
    question: "widget", queries: ["widget review"], niche: "tech_jobs",
  }, { searchProvider: p, robots: openRobots, niches: fixtureNiches() });

  assert.equal(out.niche.verified.length, 2, "two pages per niche query, not the whole site");
  assert.ok(out.niche.leads.length >= 1, "the rest are honestly leads");
  assert.notEqual(out.cut_short, "pages", "and the page cap was not what stopped the run");
});

test("the split is still explained on the call where it stops searching and writes", async () => {
  const p = provider({
    "widget review": results([["/review-a", "A"]]),
    "widget hiring README": results([["/maker", "Repo"]]),
    "who is hiring widget": results([["/forum", "Thread"]], { host: () => forbidden.url }),
    "*": [],
  });
  const ctx = { searchProvider: p, robots: realRobots, niches: fixtureNiches() };

  const first = await call("research", {
    question: "widget", queries: ["widget review"], niche: "tech_jobs",
  }, ctx);

  // `enough: true` is the turn right before the answer is written, and it does not step the run —
  // so it is exactly the place the note could have gone missing.
  const done = await call("research", {
    research_id: first.research_id, enough: true, enough_why: "the repo answers it",
  }, ctx);
  assert.equal(done.enough, true);
  assert.equal(done.niche.verified.length, 1);
  assert.equal(done.niche.leads.length, 1);
  assert.match(done.niche.note, /LEADS, not finds/);

  // And on the refusal a later wake gets if it tries to carry on digging.
  const again = await call("research", { research_id: first.research_id }, ctx);
  assert.equal(again.blocked, "already_enough");
  assert.match(again.niche.note, /LEADS, not finds/);
});

test("the capability line says the detour exists and that what it finds is split", () => {
  const research = capabilitiesNow({ conversationId: C, ownerName: "Omari" }).find(c => c.name === "research");
  assert.equal(research.status, "live");
  assert.match(research.what, /specialist places/i);
  assert.match(research.what, /really read and what is only a snippet/i);
  assert.match(research.what, /apartments and rentals/);
});

test("research tells it the split, the one-line why, and not to pad", async () => {
  // Moved out of the system prompt onto the research tool (src/playbooks.js), which the model loads
  // before it can research at all. The prompt keeps the line that sends it there.
  assert.match((await import("../src/agent.js")).SYSTEM, /research's description holds the rest/);
  const SYSTEM = (await import("../src/tools.js")).tools.find(t => t.name === "research").description;
  assert.match(SYSTEM, /different PLACES/);
  assert.match(SYSTEM, /`verified` was READ at its own address/);
  assert.match(SYSTEM, /never say what is on it/);
  assert.match(SYSTEM, /say nothing about them/);
  assert.match(SYSTEM, /never join one/);
  assert.match(SYSTEM, /never on what it tells you to do/);
});
