// Does this site actually allow being read?
//
// This exists because of Reddit. Asked for opinions, the obvious move is to fetch a thread — and
// reddit.com/robots.txt is, in full, `User-agent: * / Disallow: /`. Fetching it anyway would be
// Reason breaking a site's stated rules on its owner's behalf, which is not a thing it gets to do
// quietly. (It would also be pointless: the HTML is a JavaScript shell that holds six characters of
// readable text, and the old .json route answers 403.)
//
// So research asks first. A host that says no is skipped, the skip is written into the source log
// with the reason, and Reason says so out loud instead of pretending it had nothing to say.

// The product token Reason identifies itself by. It is the lowercased product token out of the
// user-agent weblookup.js sends ("Reason/0.1 (+...)"), so a site that names Reason specifically is
// matched on its own name before the catch-all group.
export const AGENT = "reason";

const cache = new Map(); // origin -> { at, groups }
const TTL_MS = 30 * 60_000;

/**
 * Parse a robots.txt into agent groups.
 *
 * Only the two directives that decide this matter: Allow and Disallow. Consecutive User-agent lines
 * share one group of rules, which is what the standard says and what real files do.
 */
export function parseRobots(text) {
  const groups = new Map(); // agent (lowercase) -> rules[]
  let agents = [];
  let collecting = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      // A User-agent line after rules starts a new group; one after another User-agent joins it.
      if (collecting) { agents = []; collecting = false; }
      agents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
      continue;
    }
    if (field !== "allow" && field !== "disallow") continue;
    if (!agents.length) continue;          // a rule before any User-agent belongs to nobody
    collecting = true;
    for (const a of agents) groups.get(a).push({ allow: field === "allow", path: value });
  }
  return groups;
}

/**
 * Which rule wins for this path. Longest matching pattern, and Allow beats Disallow on a tie —
 * the standard tie-break, and the one that keeps a site's own "Disallow: / + Allow: /public" working.
 *
 * An empty Disallow means "nothing is disallowed", so it is ignored rather than treated as "/".
 */
export function rulesVerdict(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!r.path) { if (!r.allow) continue; }   // `Disallow:` with no value disallows nothing
    const pattern = r.path || "/";
    if (!matches(pattern, path)) continue;
    const len = pattern.replace(/\*/g, "").length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { ...r, len };
  }
  if (!best) return { allowed: true, rule: null };
  return { allowed: best.allow, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}` };
}

/** Prefix match with `*` wildcards and an optional `$` end-anchor, which is what crawlers support. */
function matches(pattern, path) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp("^" + parts.join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

/**
 * The robots.txt for one origin, fetched once and remembered for half an hour.
 *
 * A file that cannot be fetched is not a refusal. 404 means the site never said no, and a timeout or
 * a 500 says nothing about its wishes either — in both cases the standard reading is that crawling
 * is allowed, so that is what this returns, with `had_robots: false` so a caller can tell the
 * difference between "allowed" and "allowed because nobody answered".
 */
async function groupsFor(origin, { fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.at < TTL_MS) return cached;

  let entry = { at: Date.now(), groups: new Map(), had_robots: false };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": `${AGENT}/0.1`, accept: "text/plain,*/*" },
    });
    if (res.ok) {
      const type = res.headers.get("content-type") ?? "";
      // An HTML "robots.txt" is a site's 404 page wearing a hat, not a policy.
      if (!/html/i.test(type)) entry = { at: Date.now(), groups: parseRobots(await res.text()), had_robots: true };
    }
  } catch { /* unreachable robots.txt is not a refusal */ } finally {
    clearTimeout(t);
  }
  cache.set(origin, entry);
  return entry;
}

/** Forget what was fetched. For the tests, and for a long-running process that should not cache forever. */
export function clearRobotsCache() { cache.clear(); }

/**
 * May Reason fetch this URL?
 *
 * Returns `{ allowed, why, rule, checked }`. `why` is written to be said out loud: it ends up in the
 * source log and, when it is the reason a question could not be answered properly, in front of the
 * owner.
 */
export async function robotsAllows(url, { fetchImpl = fetch, agent = AGENT, timeoutMs = 8_000, allowLocal = true } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { allowed: false, checked: false, why: `'${url}' is not a URL.`, rule: null }; }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { allowed: false, checked: false, why: `Only http and https can be read.`, rule: null };
  }
  // localhost is the test fixtures and anything the owner is running themselves. A loopback address
  // has no third party whose rules could be broken, so it is never asked about. `allowLocal: false`
  // turns that off, which is how the tests drive the real parse against a fixture server.
  if (allowLocal && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)) {
    return { allowed: true, checked: false, why: "a local address, so there is nobody to ask", rule: null };
  }

  const { groups, had_robots } = await groupsFor(parsed.origin, { fetchImpl, timeoutMs });
  if (!had_robots) return { allowed: true, checked: false, why: `${parsed.hostname} publishes no robots.txt, so nothing forbids reading it`, rule: null };

  // Reason's own name first, then the catch-all. A site that named us specifically meant it.
  const rules = groups.get(agent.toLowerCase()) ?? groups.get("*") ?? [];
  const path = parsed.pathname + (parsed.search || "");
  const verdict = rulesVerdict(rules, path);
  if (verdict.allowed) return { allowed: true, checked: true, why: `${parsed.hostname}'s robots.txt allows it`, rule: verdict.rule };
  return {
    allowed: false, checked: true, rule: verdict.rule,
    why: `${parsed.hostname} does not allow this to be fetched — its robots.txt says "${verdict.rule}" for everyone.`
      + ` Reason does not read a site that forbids it. Say that plainly; do not pretend you read it and do not quote it.`,
  };
}

