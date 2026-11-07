// Drive the remote sign-in link (/s/<token>) down the real path, offline: the signin_link tool
// mints the link, the real HTTP server answers it, and only the browser is a stand-in (no Playwright,
// no site touched). Run from the repo root under the cage's env:
//
//   eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
//   node .agents/skills/verify-reason/bin/signin-link-drive.mjs
//
// Proves who may tap Start (security audit lead 6): a stranger's browser and a browser signed in to
// Reason as somebody else get a code step, never the session; the code goes to the person's own
// thread; the right code starts it; the person's own proved browser starts at once.
const { runTool } = await import(`${process.cwd()}/src/tools.js`);
const remote = await import(`${process.cwd()}/src/signin-remote.js`);
const { createServer } = await import(`${process.cwd()}/src/http.js`);
const db = await import(`${process.cwd()}/src/db.js`);
const { config } = await import(`${process.cwd()}/src/config.js`);

const CONV = config.ownerConversation;
const launched = [];
const stub = async (a) => {
  launched.push(a.conversationId);
  const page = { screenshot: async () => Buffer.from([0xff, 0xd8, 0x2a]), evaluate: async () => ({ fields: [], url: "https://example.test/signin", text: "Sign in to continue please" }), mouse: { click: async () => {}, wheel: async () => {} }, keyboard: { type: async () => {}, press: async () => {} }, goBack: async () => {} };
  return { page, close: async () => {} };
};
const told = [];
const server = createServer({ router: { statuses: () => [] }, runtime: { _tell: async (c, text) => { told.push([c, text]); } } });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`); };
const mint = async () => {
  const out = await runTool("signin_link", { site: "amazon" }, { conversationId: CONV, messages: [], createRemoteSignin: (a) => remote.createRemoteSignin({ ...a, launch: stub, check: async () => ({ ok: true, state: "signed_out", why: "stub" }) }) });
  return new URL(out.link).pathname;
};
const post = (path, { cookie = "", body = "" } = {}) => fetch(`${base}${path}/start`, { method: "POST", redirect: "manual", headers: { ...(cookie ? { cookie } : {}), "Content-Type": "application/x-www-form-urlencoded" }, body });

try {
  db.db.exec("DELETE FROM page_codes WHERE page_id LIKE 'signin:%'; DELETE FROM page_attempts WHERE page_id LIKE 'signin:%';");
  // 1. A stranger: no Reason session at all.
  let path = await mint();
  let r = await post(path);
  check("stranger Start → code step, no session cookie, nothing launched", r.status === 401 && !r.headers.get("set-cookie") && launched.length === 0, `status ${r.status}`);
  await new Promise(res => setTimeout(res, 20));
  check("the code went to the person's own thread only", told.length === 1 && told[0][0] === CONV);
  const view = await fetch(`${base}${path}/view`);
  check("no picture without the session", view.status === 404, `status ${view.status}`);

  // 2. Signed in to Reason, but as somebody else.
  const other = `other-${Date.now()}`;
  db.startPageSession("web", other, { conversationId: "dm:fake:+15550000002" });
  r = await post(path, { cookie: `reason_page=${other}`, body: "code=000001" });
  check("somebody else's Reason browser + wrong code → refused", r.status === 401 && !r.headers.get("set-cookie") && launched.length === 0, `status ${r.status}`);

  // 3. The right code from the person's own text.
  const code = /code is (\d{6})/.exec(told[0][1])?.[1];
  r = await post(path, { body: `code=${code}` });
  const rs = (r.headers.get("set-cookie") ?? "").split(";")[0];
  check("the texted code starts it", r.status === 303 && /^rs_/.test(rs) && launched.length === 1, `status ${r.status}`);
  const live = await fetch(`${base}${path}/view`, { headers: { cookie: rs } });
  check("and that browser drives it", live.status === 200, `status ${live.status}`);
  await fetch(`${base}${path}/cancel`, { method: "POST", headers: { cookie: rs, "Content-Type": "application/json" }, body: "{}" });

  // 4. The person's own proved browser: no code.
  const mine = `mine-${Date.now()}`;
  db.startPageSession("web", mine, { conversationId: CONV });
  const n = told.length;
  path = await mint();
  r = await post(path, { cookie: `reason_page=${mine}` });
  check("own proved browser starts at once, no text", r.status === 303 && told.length === n && launched.length === 2, `status ${r.status}`);
  await fetch(`${base}${path}/cancel`, { method: "POST", headers: { cookie: (r.headers.get("set-cookie") ?? "").split(";")[0], "Content-Type": "application/json" }, body: "{}" });
  db.db.prepare("DELETE FROM page_sessions WHERE token IN (?, ?)").run(other, mine);
} finally {
  await remote.endAllRemoteSignins("shutdown");
  await new Promise(r => server.close(r));
}
const ok = results.every(Boolean);
console.log(ok ? `ALL ${results.length} PASS` : "SOME FAILED");
process.exit(ok ? 0 : 1);
