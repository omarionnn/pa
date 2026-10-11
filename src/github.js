// GitHub, the documented way.
//
// Everything here was written from GitHub's current docs (docs.github.com/en/apps/oauth-apps),
// nothing is from memory and nothing is invented. The pieces that matter:
//
//   **Web application flow** (docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).
//   GET github.com/login/oauth/authorize with client_id, redirect_uri, state, and a space-separated
//   scope. GitHub redirects back with ?code&state. The code is exchanged at
//   POST github.com/login/oauth/access_token with client_id and client_secret in the body.
//   Accept: application/json to get JSON back.
//
//   **Tokens do not expire** on OAuth Apps. There is no refresh flow: a token is good until the
//   user revokes it or the app is removed from their account. This is simpler than Google and
//   Spotify — no refresh dance, no six-month expiry. But it also means a dead token is dead for
//   good, and the only fix is a new authorize.
//
//   **Scopes** (docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).
//   `repo` is full control of private repos (read/write code, issues, PRs, etc.). `read:user` reads
//   their profile. Public repos are readable with no scope, but issues and PRs on private repos need
//   `repo`.
//
//   **Rate limits.** Authenticated requests get 5,000 per hour. The API returns `X-RateLimit-Remaining`
//   and `X-RateLimit-Reset` headers.
import { config, clock, callbackUrl, stamp } from "./config.js";
import * as db from "./db.js";

export const PROVIDER = "github";
export const REDIRECT_PATH = "/github/callback";

export const SCOPES = {
  "repo": "read and write code, issues, and pull requests on private repos",
  "read:user": "see which GitHub account this is",
};
export const SCOPE_LIST = Object.keys(SCOPES);

export const TOOL_SCOPES = {
  github_repos: [],
  github_issues: ["repo"],
  github_issue_create: ["repo"],
  github_issue_comment: ["repo"],
  github_pulls: ["repo"],
  github_pr_merge: ["repo"],
  github_code_search: ["repo"],
  github_file_read: ["repo"],
  github_activity: ["repo"],
};

export function githubStatus({ clientId = config.githubClientId, clientSecret = config.githubClientSecret } = {}) {
  const missing = [];
  if (!clientId) missing.push("GITHUB_OAUTH_CLIENT_ID");
  if (!clientSecret) missing.push("GITHUB_OAUTH_CLIENT_SECRET");
  return {
    connected: missing.length === 0,
    missing,
    redirect_uri: callbackUrl(REDIRECT_PATH),
    what: "read and write repos, issues, and pull requests on GitHub",
  };
}

export function notConnected(extra = {}) {
  const st = githubStatus();
  return {
    ok: false,
    status: "not_connected",
    missing: st.missing,
    error: `GitHub is not connected: this machine has no ${st.missing.join(" or ")}.`
      + ` ${config.ownerName} has to make a GitHub OAuth App at github.com/settings/developers,`
      + ` add ${st.redirect_uri} to its Authorization callback URL exactly as written, and put the client id and secret in .env.`
      + ` Say that plainly and do not claim anything about their repos.`,
    ...extra,
  };
}

// ---------- connecting ----------

export function authorizeUrl(conversationId, { scopes = SCOPE_LIST } = {}) {
  const st = githubStatus();
  if (!st.connected) return notConnected();
  const want = scopes.filter(s => SCOPE_LIST.includes(s));
  if (!want.length) return { ok: false, error: `No known scopes asked for. Known: ${SCOPE_LIST.join(", ")}.` };
  const redirectUri = st.redirect_uri;
  db.clearOauthStates(conversationId, PROVIDER);
  const state = db.newOauthState({ conversationId, provider: PROVIDER, scope: want.join(" "), redirectUri });
  const q = new URLSearchParams({
    client_id: config.githubClientId,
    redirect_uri: redirectUri,
    state,
    scope: want.join(" "),
  });
  return {
    ok: true,
    url: `${config.githubBase}/login/oauth/authorize?${q}`,
    scopes: want.map(s => ({ scope: s, so_that: SCOPES[s] })),
    redirect_uri: redirectUri,
    reachable: config.publicUrl
      ? null
      : `This redirects to ${redirectUri}, which only opens on the Mac Reason runs on. Tapping the link from a phone will get as far as GitHub and then fail to come back. Set REASON_PUBLIC_URL for that to work from anywhere.`,
    note: "Nothing is connected until they open this and agree on GitHub's own page. The link works once.",
  };
}

async function postToken(body, { fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.githubTimeoutMs);
  try {
    const res = await fetchImpl(`${config.githubBase}/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* fall through */ }
    if (json?.error) {
      return { ok: false, httpStatus: res.status, error: json.error_description || json.error, code: json.error };
    }
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, error: text.slice(0, 200) || `HTTP ${res.status}`, code: "" };
    }
    return { ok: true, body: json ?? {} };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: `GitHub did not answer within ${config.githubTimeoutMs / 1000}s.` };
    return { ok: false, error: `Could not reach GitHub: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function completeConnect({ code, state, error = "", fetchImpl = fetch } = {}) {
  const row = db.spendOauthState(state);
  if (!row) return { ok: false, reason: "bad_state", error: "That link has already been used, or it is not one of ours. Ask Reason for a new one." };
  if (row.provider !== PROVIDER) return { ok: false, reason: "bad_state", error: "That link is not a GitHub one." };
  if (error) return { ok: false, reason: "declined", conversationId: row.conversation_id, error: `GitHub said: ${error}` };
  if (!code) return { ok: false, reason: "no_code", conversationId: row.conversation_id, error: "GitHub came back without a code." };

  const got = await postToken({
    client_id: config.githubClientId,
    client_secret: config.githubClientSecret,
    code,
    redirect_uri: row.redirect_uri,
  }, { fetchImpl });
  if (!got.ok) return { ok: false, reason: "token_exchange_failed", conversationId: row.conversation_id, error: got.error };

  const b = got.body;
  if (!b.access_token) return { ok: false, reason: "token_exchange_failed", conversationId: row.conversation_id, error: "GitHub returned no access token." };
  const granted = String(b.scope ?? "").split(/,/).filter(Boolean);

  // Learn which account this is so the connection names them.
  let username = "";
  try {
    const userRes = await api(b.access_token, "GET", "/user", { fetchImpl });
    if (userRes.ok) username = userRes.body?.login ?? "";
  } catch { /* the token works, the profile call did not — connect anyway */ }

  db.saveOauthTokens(row.conversation_id, PROVIDER, {
    accessToken: b.access_token,
    refreshToken: "",
    scope: granted.join(" "),
    expiresAt: null,
    account: username,
  });
  db.connectAccount(row.conversation_id, "github", granted, { account: username });
  return { ok: true, conversationId: row.conversation_id, scopes: granted, username };
}

export function disconnect(conversationId) {
  const tokens = db.deleteOauthTokens(conversationId, PROVIDER);
  db.clearOauthStates(conversationId, PROVIDER);
  const row = db.revokeAccount(conversationId, "github");
  return {
    ok: true,
    status: "revoked",
    tokens_deleted: tokens,
    was_connected: !!row || tokens > 0,
    note: "The tokens are gone from this machine. GitHub also keeps a record of the app on their side:"
      + " github.com/settings/applications is where it is taken away there too, and only they can do that.",
  };
}

// ---------- using it ----------

export function accessTokenFor(conversationId) {
  const st = githubStatus();
  if (!st.connected) return notConnected();
  const row = db.getOauthTokens(conversationId, PROVIDER);
  if (!row) {
    return {
      ok: false, status: "not_connected",
      error: `This person has not connected GitHub yet. Call github_connect and send them the link; nothing about their repos is knowable until they agree on GitHub's own page.`,
    };
  }
  return { ok: true, token: row.access_token, scopes: scopesOf(row), account: row.account_label };
}

function scopesOf(row) {
  return String(row?.scope ?? "").split(/[\s,]+/).filter(Boolean);
}

export function missingScopeFor(tool, scopes) {
  const need = TOOL_SCOPES[tool] ?? [];
  if (!need.length) return null;
  return need.some(s => scopes.includes(s)) ? null : need;
}

export async function api(token, method, path, { query = null, body = null, fetchImpl = fetch } = {}) {
  const url = new URL(`${config.githubApiBase}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.githubTimeoutMs);
  try {
    const res = await fetchImpl(url.href, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    });
    if (res.status === 204) return { ok: true, status: 204, body: null };
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* fall through */ }
    if (!res.ok) {
      const rateReset = res.headers.get("x-ratelimit-reset");
      return {
        ok: false, status: res.status,
        error: json?.message || text.slice(0, 200) || `HTTP ${res.status}`,
        ...(res.status === 403 && rateReset ? { rate_limit_resets_at: new Date(Number(rateReset) * 1000).toISOString() } : {}),
      };
    }
    return { ok: true, status: res.status, body: json };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: `GitHub did not answer within ${config.githubTimeoutMs / 1000}s.` };
    return { ok: false, error: `Could not reach GitHub: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- shaping what comes back ----------

export function repoView(r) {
  if (!r) return null;
  return {
    name: r.full_name,
    description: r.description || "",
    private: !!r.private,
    language: r.language || "",
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    open_issues: r.open_issues_count ?? 0,
    updated: r.updated_at ?? "",
    url: r.html_url ?? "",
    default_branch: r.default_branch ?? "main",
  };
}

export function issueView(i) {
  if (!i) return null;
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    author: i.user?.login ?? "",
    labels: (i.labels ?? []).map(l => typeof l === "string" ? l : l.name).filter(Boolean),
    assignees: (i.assignees ?? []).map(a => a.login).filter(Boolean),
    comments: i.comments ?? 0,
    created: i.created_at ?? "",
    updated: i.updated_at ?? "",
    url: i.html_url ?? "",
    is_pr: !!i.pull_request,
  };
}

export function prView(p) {
  if (!p) return null;
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    draft: !!p.draft,
    author: p.user?.login ?? "",
    head: p.head?.ref ?? "",
    base: p.base?.ref ?? "",
    mergeable: p.mergeable ?? null,
    labels: (p.labels ?? []).map(l => typeof l === "string" ? l : l.name).filter(Boolean),
    reviewers: (p.requested_reviewers ?? []).map(r => r.login).filter(Boolean),
    comments: p.comments ?? 0,
    review_comments: p.review_comments ?? 0,
    additions: p.additions ?? null,
    deletions: p.deletions ?? null,
    changed_files: p.changed_files ?? null,
    created: p.created_at ?? "",
    updated: p.updated_at ?? "",
    merged: p.merged_at ?? null,
    url: p.html_url ?? "",
  };
}

export function notificationView(n) {
  if (!n) return null;
  return {
    id: n.id,
    reason: n.reason,
    unread: n.unread,
    title: n.subject?.title ?? "",
    type: n.subject?.type ?? "",
    repo: n.repository?.full_name ?? "",
    updated: n.updated_at ?? "",
    url: n.subject?.url ?? "",
  };
}

export function callbackPage({ ok, message, ownerName = config.ownerName }) {
  const title = ok ? "GitHub connected" : "GitHub not connected";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
:root{color-scheme:light dark;--ground:#f3eee6;--bg:#fbf9f5;--fg:#1c1915;--mute:#6f675d;--line:#e6e0d7;--mark:#ff5a3c}
@media(prefers-color-scheme:dark){:root{--ground:#0b0a09;--bg:#12110f;--fg:#f3efe8;--mute:#a39c91;--line:#2c2924;--mark:#ff6b4f}}
*{box-sizing:border-box}body{margin:0;font:17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;background:var(--ground);color:var(--fg)}
.bar{display:flex;align-items:center;gap:.45rem;padding:14px 16px 10px;font:500 1rem/1.2 ui-serif,"New York","Iowan Old Style",Georgia,serif}
.dot{flex:none;width:.5rem;height:.5rem;border-radius:50%;background:var(--mark)}
.sheet{background:var(--bg);border-radius:1.5rem 1.5rem 0 0;min-height:100dvh}
main{max-width:32rem;margin:0 auto;padding:2rem 1.5rem}
h1{font-size:1.3rem;margin:0 0 .5rem}.lead{color:var(--mute);margin:0 0 .5rem;font-size:.9rem}
</style></head><body>
<div class="bar"><span class="dot"></span>Reason</div>
<div class="sheet"><main>
<h1>${esc(title)}</h1>
<p>${esc(message)}</p>
<p class="lead">You can close this.${ok ? " Go back to your messages." : ""}</p>
<p class="lead">${stamp()}</p>
</main></div></body></html>`;
}
