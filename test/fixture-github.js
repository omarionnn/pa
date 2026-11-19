// A fake GitHub, served from the test.
//
// Every route is one GitHub really documents (docs.github.com/en/rest), with the method, the path,
// and the status codes their docs give. The pieces that matter:
//
//   - Token exchange at POST /login/oauth/access_token with Accept: application/json.
//   - Tokens do not expire on OAuth Apps — no refresh flow.
//   - API requests use Bearer auth and Accept: application/vnd.github+json.
//   - Rate limits are 5,000/hour per authenticated user.
//
// `state` is the ground truth the tests assert on: which bearer tokens arrived, which issues were
// created, which PRs were merged.
import { createServer } from "node:http";

const REPOS = [
  { id: 1, full_name: "omari/reason", name: "reason", description: "Personal AI assistant", private: true, language: "JavaScript", stargazers_count: 42, forks_count: 3, open_issues_count: 5, updated_at: "2026-10-10T12:00:00Z", html_url: "https://github.com/omari/reason", default_branch: "main" },
  { id: 2, full_name: "omari/website", name: "website", description: "Portfolio site", private: false, language: "TypeScript", stargazers_count: 10, forks_count: 1, open_issues_count: 2, updated_at: "2026-10-08T12:00:00Z", html_url: "https://github.com/omari/website", default_branch: "main" },
];

const ISSUES = [
  { number: 1, title: "Fix login bug", state: "open", user: { login: "omari" }, labels: [{ name: "bug" }], assignees: [{ login: "omari" }], comments: 3, created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-10T12:00:00Z", html_url: "https://github.com/omari/reason/issues/1" },
  { number: 2, title: "Add dark mode", state: "open", user: { login: "kofi" }, labels: [{ name: "enhancement" }], assignees: [], comments: 0, created_at: "2026-10-05T12:00:00Z", updated_at: "2026-10-09T12:00:00Z", html_url: "https://github.com/omari/reason/issues/2" },
  { number: 3, title: "Old issue", state: "closed", user: { login: "omari" }, labels: [], assignees: [{ login: "omari" }], comments: 1, created_at: "2026-09-01T12:00:00Z", updated_at: "2026-09-15T12:00:00Z", html_url: "https://github.com/omari/reason/issues/3" },
];

const PULLS = [
  { number: 10, title: "Add GitHub integration", state: "open", draft: false, user: { login: "omari" }, head: { ref: "feat/github" }, base: { ref: "main" }, mergeable: true, labels: [{ name: "feature" }], requested_reviewers: [{ login: "kofi" }], comments: 2, review_comments: 1, additions: 150, deletions: 10, changed_files: 5, created_at: "2026-10-09T12:00:00Z", updated_at: "2026-10-10T12:00:00Z", merged_at: null, html_url: "https://github.com/omari/reason/pull/10" },
  { number: 11, title: "Fix typo in readme", state: "open", draft: true, user: { login: "kofi" }, head: { ref: "fix/typo" }, base: { ref: "main" }, mergeable: true, labels: [], requested_reviewers: [], comments: 0, review_comments: 0, additions: 1, deletions: 1, changed_files: 1, created_at: "2026-10-10T12:00:00Z", updated_at: "2026-10-10T12:00:00Z", merged_at: null, html_url: "https://github.com/omari/reason/pull/11" },
  { number: 9, title: "Ship onboarding copy", state: "closed", draft: false, user: { login: "omari" }, head: { ref: "feat/onboarding" }, base: { ref: "main" }, mergeable: null, labels: [], requested_reviewers: [], comments: 0, review_comments: 0, additions: 20, deletions: 4, changed_files: 2, created_at: "2026-10-02T12:00:00Z", updated_at: "2026-10-04T12:00:00Z", merged_at: "2026-10-04T12:00:00Z", html_url: "https://github.com/omari/reason/pull/9" },
  { number: 8, title: "Drop old importer", state: "closed", draft: false, user: { login: "omari" }, head: { ref: "chore/importer" }, base: { ref: "main" }, mergeable: null, labels: [], requested_reviewers: [], comments: 0, review_comments: 0, additions: 0, deletions: 90, changed_files: 3, created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-03T12:00:00Z", merged_at: null, html_url: "https://github.com/omari/reason/pull/8" },
];

const FILES = {
  "omari/reason": {
    "src/index.js": { content: Buffer.from("console.log('hello reason');").toString("base64"), encoding: "base64", size: 27, sha: "abc123", type: "file", name: "index.js", path: "src/index.js" },
    "README.md": { content: Buffer.from("# Reason\nPersonal AI assistant.").toString("base64"), encoding: "base64", size: 31, sha: "def456", type: "file", name: "README.md", path: "README.md" },
  },
};

const NOTIFICATIONS = [
  { id: "1", reason: "review_requested", unread: true, subject: { title: "Add GitHub integration", type: "PullRequest", url: "https://api.github.com/repos/omari/reason/pulls/10" }, repository: { full_name: "omari/reason" }, updated_at: "2026-10-10T12:00:00Z" },
  { id: "2", reason: "assign", unread: true, subject: { title: "Fix login bug", type: "Issue", url: "https://api.github.com/repos/omari/reason/issues/1" }, repository: { full_name: "omari/reason" }, updated_at: "2026-10-09T12:00:00Z" },
  { id: "3", reason: "mention", unread: false, subject: { title: "Old discussion", type: "Issue", url: "https://api.github.com/repos/omari/reason/issues/3" }, repository: { full_name: "omari/reason" }, updated_at: "2026-10-01T12:00:00Z" },
  { id: "4", reason: "author", unread: false, subject: { title: "Ship onboarding copy", type: "PullRequest", url: "https://api.github.com/repos/omari/reason/pulls/9" }, repository: { full_name: "omari/reason" }, updated_at: "2026-10-04T12:00:00Z" },
  { id: "5", reason: "author", unread: false, subject: { title: "Drop old importer", type: "PullRequest", url: "https://api.github.com/repos/omari/reason/pulls/8" }, repository: { full_name: "omari/reason" }, updated_at: "2026-10-03T12:00:00Z" },
];

export async function startGitHub({
  grantScopes = "repo,read:user",
} = {}) {
  const state = {
    tokenCalls: [],
    authHeaders: [],
    issuesCreated: [],
    commentsPosted: [],
    prsMerged: [],
    liveTokens: new Set(),
    accessCounter: 0,
  };
  const cfg = { grantScopes };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const err = (status, message) => json(status, { message });

    const auth = req.headers.authorization ?? "";

    // ---------- github.com (OAuth) ----------
    if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        state.tokenCalls.push(parsed);
        if (parsed.code !== "good-code") return json(200, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
        const token = `ghp_access${++state.accessCounter}`;
        state.liveTokens.add(token);
        return json(200, { access_token: token, token_type: "bearer", scope: cfg.grantScopes });
      });
      return;
    }

    // ---------- api.github.com ----------
    if (url.pathname.startsWith("/")) {
      state.authHeaders.push({ path: url.pathname, auth });
    }
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    // Auth check for API routes (not the token exchange)
    if (url.pathname !== "/login/oauth/access_token") {
      if (!bearer) return err(401, "Requires authentication");
      if (!state.liveTokens.has(bearer)) return err(401, "Bad credentials");
    }

    // GET /user
    if (url.pathname === "/user" && req.method === "GET") {
      return json(200, { login: "omari", id: 12345, name: "Omari", email: "omari@example.com" });
    }

    // GET /user/repos
    if (url.pathname === "/user/repos" && req.method === "GET") {
      const limit = Number(url.searchParams.get("per_page") ?? 30);
      return json(200, REPOS.slice(0, limit));
    }

    // GET /repos/:owner/:repo/issues
    const issuesMatch = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname);
    if (issuesMatch && req.method === "GET") {
      const st = url.searchParams.get("state") ?? "open";
      const limit = Number(url.searchParams.get("per_page") ?? 30);
      let filtered = [...ISSUES, ...state.issuesCreated.filter(i => i._repo === issuesMatch[1])];
      if (st !== "all") filtered = filtered.filter(i => i.state === st);
      return json(200, filtered.slice(0, limit));
    }

    // POST /repos/:owner/:repo/issues
    if (issuesMatch && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        if (!parsed.title) return err(422, "Validation Failed");
        const num = 100 + state.issuesCreated.length;
        const created = {
          _repo: issuesMatch[1],
          number: num, title: parsed.title, body: parsed.body ?? "", state: "open",
          user: { login: "omari" },
          labels: (parsed.labels ?? []).map(l => ({ name: l })),
          assignees: (parsed.assignees ?? []).map(a => ({ login: a })),
          comments: 0,
          created_at: "2026-10-11T12:00:00Z", updated_at: "2026-10-11T12:00:00Z",
          html_url: `https://github.com/${issuesMatch[1]}/issues/${num}`,
        };
        state.issuesCreated.push(created);
        return json(201, created);
      });
      return;
    }

    // POST /repos/:owner/:repo/issues/:number/comments
    const commentMatch = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentMatch && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        if (!parsed.body) return err(422, "Validation Failed");
        const comment = {
          id: 1000 + state.commentsPosted.length,
          body: parsed.body,
          user: { login: "omari" },
          html_url: `https://github.com/${commentMatch[1]}/issues/${commentMatch[2]}#issuecomment-${1000 + state.commentsPosted.length}`,
          created_at: "2026-10-11T12:00:00Z",
        };
        state.commentsPosted.push({ repo: commentMatch[1], issue: Number(commentMatch[2]), ...comment });
        return json(201, comment);
      });
      return;
    }

    // GET /repos/:owner/:repo/pulls
    const pullsMatch = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname);
    if (pullsMatch && req.method === "GET") {
      const st = url.searchParams.get("state") ?? "open";
      const limit = Number(url.searchParams.get("per_page") ?? 30);
      let filtered = [...PULLS];
      if (st !== "all") filtered = filtered.filter(p => p.state === st);
      return json(200, filtered.slice(0, limit));
    }

    // GET /repos/:owner/:repo/pulls/:number
    const pullMatch = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
    if (pullMatch && req.method === "GET") {
      state.pullReads = (state.pullReads ?? 0) + 1;
      const pr = PULLS.find(p => p.number === Number(pullMatch[2]));
      if (!pr) return err(404, "Not Found");
      return json(200, pr);
    }

    // PUT /repos/:owner/:repo/pulls/:number/merge
    const mergeMatch = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(url.pathname);
    if (mergeMatch && req.method === "PUT") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        const prNum = Number(mergeMatch[2]);
        const pr = PULLS.find(p => p.number === prNum);
        if (!pr) return err(404, "Not Found");
        if (!pr.mergeable) return err(405, "Pull Request is not mergeable");
        state.prsMerged.push({ repo: mergeMatch[1], number: prNum, method: parsed.merge_method ?? "merge" });
        return json(200, { sha: "abc123def456", merged: true, message: "Pull Request successfully merged" });
      });
      return;
    }

    // GET /search/code
    if (url.pathname === "/search/code" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("per_page") ?? 10);
      const items = [
        { name: "index.js", path: "src/index.js", repository: { full_name: "omari/reason" }, html_url: "https://github.com/omari/reason/blob/main/src/index.js", score: 1.0 },
      ];
      return json(200, { total_count: items.length, incomplete_results: false, items: items.slice(0, limit) });
    }

    // GET /repos/:owner/:repo/contents/:path
    const contentsMatch = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(url.pathname);
    if (contentsMatch && req.method === "GET") {
      const repo = contentsMatch[1];
      const path = contentsMatch[2];
      const repoFiles = FILES[repo];
      if (!repoFiles || !repoFiles[path]) return err(404, "Not Found");
      return json(200, repoFiles[path]);
    }

    // GET /notifications
    if (url.pathname === "/notifications" && req.method === "GET") {
      const all = url.searchParams.get("all") === "true";
      const limit = Number(url.searchParams.get("per_page") ?? 50);
      let filtered = all ? NOTIFICATIONS : NOTIFICATIONS.filter(n => n.unread);
      return json(200, filtered.slice(0, limit));
    }

    return err(404, `No such route: ${req.method} ${url.pathname}`);
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    set(patch) { Object.assign(cfg, patch); },
    close: () => new Promise(r => server.close(r)),
  };
}
