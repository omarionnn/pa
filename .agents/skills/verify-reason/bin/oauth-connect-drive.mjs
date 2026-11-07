#!/usr/bin/env node
// OAuth connect links finish only in the asker's browser (security lead 1, PR #358), driven over
// real HTTP against a cage, with a loopback fake GitHub and the loopback fake Sendblue. No model,
// no real provider, no phone.
//
//   node .agents/skills/verify-reason/bin/oauth-connect-drive.mjs github <url-file>
//       start the fake GitHub (test/fixture-github.js) and write its URL to <url-file>; stays up.
//   eval "$(bin/caged.sh env)"; GITHUB_BASE=… GITHUB_API_BASE=… GITHUB_OAUTH_CLIENT_ID=cage \
//   GITHUB_OAUTH_CLIENT_SECRET=cage node …/oauth-connect-drive.mjs drive <cage-base> <capture.jsonl>
//       mint links into the cage's own DB (same as github_connect does) and walk them.
//
// The cage must be started with the same GITHUB_* values (they are inherited by caged.sh) and with
// REASON_VERIFY_FAKE_SENDBLUE, so the texted code lands in <capture.jsonl>.
import { request } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [mode, ...args] = process.argv.slice(2);

if (mode === "github") {
  const { startGitHub } = await import(new URL("../../../../test/fixture-github.js", import.meta.url));
  const gh = await startGitHub();
  writeFileSync(args[0], gh.url);
  console.log(`fake GitHub on ${gh.url}`);
  await new Promise(() => {});
}
if (mode !== "drive") { console.error("usage: oauth-connect-drive.mjs github <url-file> | drive <cage-base> <capture.jsonl>"); process.exit(2); }

const [base, capture] = args;
const db = await import(new URL("../../../../src/db.js", import.meta.url));
const github = await import(new URL("../../../../src/github.js", import.meta.url));

const ASKER = "dm:sendblue:+12125550171";
const OTHER = "dm:sendblue:+12125550172";
db.upsertAccount({ conversationId: ASKER, channel: "sendblue", address: "+12125550171", name: "Asker", isOperator: false });
db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+12125550172", name: "Other", isOperator: false });
// A thread is what deliver routes by (src/deliver.js whereTo); without one the code goes to the console.
db.upsertThread({ conversationId: ASKER, channel: "sendblue", address: "+12125550171", isOwner: false });
db.upsertThread({ conversationId: OTHER, channel: "sendblue", address: "+12125550172", isOwner: false });

let failed = 0;
const step = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

function hit(pathAndQuery, { method = "GET", cookie = "", body = null, extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...extra, ...(cookie ? { cookie } : {}), ...(body != null ? { "content-type": "application/x-www-form-urlencoded" } : {}) };
    const r = request(`${base}${pathAndQuery}`, { method, headers }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on("error", reject);
    r.end(body ?? undefined);
  });
}
const pathOf = (u) => { const p = new URL(u); return p.pathname + p.search; };
const stateOf = (u) => new URL(u).searchParams.get("state");
const tokens = (c) => db.listOauthTokens(c, "github").length;
const texts = () => existsSync(capture) ? readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(e => e.method === "POST") : [];
function signedInAs(conversationId) {
  const token = `drive-${Math.random().toString(36).slice(2)}`;
  db.startPageSession("web", token, { conversationId });
  return `reason_page=${token}`;
}
const mint = () => {
  const r = github.authorizeUrl(ASKER);
  if (!r?.url) { console.error("authorizeUrl gave no url — GitHub not configured in this shell?", r); process.exit(1); }
  return r.url;
};

// 1. A forwarded link opened in a browser with no Reason cookie.
let link = mint();
step(new URL(link).pathname === "/connect/start", `link Reason texts is its own start page (${pathOf(link).split("?")[0]})`);
let res = await hit(pathOf(link));
step(res.status === 401 && /Text me the code/.test(res.text) && !res.text.includes("login/oauth/authorize"), `no-cookie browser: start ${res.status}, gate shown, provider address not on the page`);
res = await hit(`/github/callback?code=stolen&state=${stateOf(link)}`);
step(res.status === 400 && tokens(ASKER) === 0, `no-cookie callback: ${res.status}, ${tokens(ASKER)} tokens on the asker`);

// 2. A browser signed in to Reason as a different person.
link = mint();
const other = signedInAs(OTHER);
res = await hit(pathOf(link), { cookie: other });
step(res.status === 401, `browser signed in as someone else: start ${res.status}`);
res = await hit(`/github/callback?code=stolen&state=${stateOf(link)}`, { cookie: other });
step(res.status === 400 && tokens(ASKER) === 0 && tokens(OTHER) === 0, `their callback: ${res.status}, tokens asker ${tokens(ASKER)} / other ${tokens(OTHER)}`);

// 3. The asker in a new browser: Text me the code, type it, go on, come back connected.
link = mint();
const before = texts().length;
res = await hit(pathOf(link));
step(texts().length === before, "a GET of the start page texted nothing");
res = await hit(pathOf(link), { method: "POST", body: "send=1" });
await new Promise(r => setTimeout(r, 1500));
const sent = texts().slice(before);
const body = JSON.stringify(sent.at(-1)?.body ?? "");
const code = /\b(\d{6})\b/.exec(body)?.[1];
step(res.status === 200 && sent.length === 1 && body.includes("+12125550171") && !!code, `Text me the code: ${res.status}, ${sent.length} text to the asker's number, code ${code ? "found" : "missing"}`);
// The same code posted from a page elsewhere (login CSRF from a victim's browser): refused, no cookie.
res = await hit(pathOf(link), { method: "POST", body: `code=${code}`, extra: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
step(res.status === 403 && ![].concat(res.headers["set-cookie"] ?? []).some(c => c.startsWith("reason_page=")), `cross-site POST of the right code: ${res.status}, no session cookie`);
res = await hit(pathOf(link), { method: "POST", body: `code=${code}`, extra: { origin: base, "sec-fetch-site": "same-origin" } });
const cookie = [].concat(res.headers["set-cookie"] ?? []).map(c => /^reason_page=([^;]+)/.exec(c)?.[1]).find(Boolean);
step(res.status === 303 && /login\/oauth\/authorize/.test(res.headers.location ?? "") && !!cookie, `code accepted: ${res.status} → ${String(res.headers.location ?? "").split("?")[0]}, Set-Cookie ${cookie ? "reason_page" : "none"}`);
res = await hit(`/github/callback?code=good-code&state=${stateOf(link)}`, { cookie: `reason_page=${cookie}` });
step(res.status === 200 && tokens(ASKER) === 1, `callback in that browser: ${res.status}, ${tokens(ASKER)} token on the asker`);

// 4. Same browser, the next link: straight through.
link = mint();
const n = texts().length;
res = await hit(pathOf(link), { cookie: `reason_page=${cookie}` });
step(res.status === 302 && /login\/oauth\/authorize/.test(res.headers.location ?? "") && texts().length === n, `next link, same browser: start ${res.status} straight to GitHub, nothing texted`);

console.log(failed ? `${failed} FAILED` : "all ok");
process.exit(failed ? 1 : 0);
