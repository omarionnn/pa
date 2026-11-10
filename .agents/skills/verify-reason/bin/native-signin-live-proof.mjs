// Live proof of Reason's own sign-in page (native panel), on the SERVER, against the real Notion and
// the real Google sign-in pages, in a throwaway copy: empty database, a /tmp profile, nothing of
// anybody's. A real model (claude-cli, the subscription token the service already uses — never the API
// key) reads one plain ask and picks the tool call; the real signin_link mints the link; the real HTTP
// server serves /s/<token>; a second headless browser plays the phone, taps the NATIVE controls, and
// types only a made-up address that does not exist. Never a real credential. Screenshots of the
// phone's page at each native step go to OUT.
//
//   cd /tmp/np-proof && node .agents/skills/verify-reason/bin/native-signin-live-proof.mjs OUT_DIR
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT = process.argv[2] || "/tmp/np-proof-shots";
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "np-proof-"));
Object.assign(process.env, {
  REASON_DB_PATH: join(dir, "reason.db"), REASON_PROFILE_ROOT: join(dir, "profiles"), REASON_DATA_DIR: dir,
  REASON_SOCIAL_SIGNIN: "owner", REASON_CONVERSATION: "dm:owner", REASON_OWNER_NAME: "Owner",
  REASON_OWNER_NUMBER: "+12025550100", REASON_MASTER_NUMBER: "+12025550100", REASON_TZ: "America/New_York",
  REASON_SITE_URL: "", REASON_PAGES_URL: "",
});
for (const k of ["ANTHROPIC_API_KEY", "SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "REASON_TOKEN_KEY"]) delete process.env[k];
const root = process.cwd();
const db = await import(`${root}/src/db.js`);
const { config } = await import(`${root}/src/config.js`);
const { runTool } = await import(`${root}/src/tools.js`);
const { createServer } = await import(`${root}/src/http.js`);
const social = await import(`${root}/src/socialsignin.js`);
const { chromium } = createRequire(join(root, "package.json"))("playwright");
const CONV = config.ownerConversation;
db.upsertAccount({ conversationId: CONV, channel: "fake", address: "+12025550100", name: "Owner", isOperator: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 1. The real model picks the call, from Reason's own sign-in rules and the tool's own description.
const tools = (await import(`${root}/src/tools.js`)).tools ?? [];
const desc = (n) => JSON.stringify((tools.find?.(t => t.name === n)) ?? { name: n });
const prompt = `You are Reason, a texting assistant. Rules for sign-in:\n${String(social.RULES)}\n\nTools you can call:\n${desc("signin_link")}\n\nThe person texts: "find my notes on the Q4 launch plan in Notion — I log into notion with google"\n\nReply with ONLY a JSON object {"tool": "<name>", "input": {...}} for the one tool call you make first. No prose.`;
const cli = spawnSync("claude", ["-p", prompt, "--output-format", "text"], { encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "" } });
const said = String(cli.stdout ?? "").trim();
const call = JSON.parse(said.slice(said.indexOf("{"), said.lastIndexOf("}") + 1));
log("model chose:", JSON.stringify(call));
if (call.tool !== "signin_link") throw new Error(`model chose ${call.tool}, not signin_link`);

// 2. The real server and the real tool.
const server = createServer({ router: { statuses: () => [] }, runtime: null });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
config.publicUrl = base; config.siteUrl = ""; config.pagesUrl = "";
const made = await runTool(call.tool, call.input, { conversationId: CONV, messages: [] });
log("link:", made.ok, made.site, "offered", JSON.stringify(made.offered ?? []));
if (!made.ok) throw new Error(JSON.stringify(made).slice(0, 300));
const url = made.link || made.url;
const token = url.split("/").pop();

// 3. The phone: proved as the owner's own browser (the same Reason sign-in a person's phone carries).
const sess = `proof-${Math.random().toString(36).slice(2)}`;
db.startPageSession(`wsign:${CONV}`, sess, { conversationId: CONV });
const phoneB = await chromium.launch();
const phone = await phoneB.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" });
await phone.addCookies([{ name: "reason_page", value: sess, domain: "127.0.0.1", path: "/" }]);
const p = await phone.newPage();
await p.goto(`${base}/s/${token}`);
await p.screenshot({ path: join(OUT, "00-intro.png"), fullPage: true });
// The intro: "Use my Notion email" opens the site's own page without pressing a provider, so the
// NATIVE chooser is what the person sees first (the provider-button intro is proven in #452).
const emailBtn = p.locator('button[name="via"][value=""]');
if (await emailBtn.count()) await emailBtn.first().click(); else await p.locator("form#ss-start button").last().click();
await p.waitForSelector("#np-panel", { timeout: 90_000 });

const DUMMY = `reason.native.proof.${Date.now().toString(36)}.nobody@gmail.com`;
const seen = [];
const shot = async (name) => { await p.waitForTimeout(400); await p.screenshot({ path: join(OUT, name), fullPage: true }); };
let lastKey = "", acted = new Set(), n = 1;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  if (!(await p.locator("#np-panel").count())) { await shot(`${String(n).padStart(2, "0")}-ended.png`); seen.push("ended:" + (await p.locator("h1").first().innerText().catch(() => ""))); break; }
  const st = await p.evaluate(() => { const e = document.querySelector("#np-panel .np-eye"); return { eye: e ? e.textContent : "", say: (document.getElementById("np-say") || {}).textContent || "", html: document.getElementById("np-panel").innerHTML.length, open: !!(document.getElementById("np-page") || {}).open, choose: !!document.getElementById("np-choose"), input: !!document.getElementById("np-in") } });
  const key = st.eye + "|" + st.say;
  if (key !== lastKey) {
    lastKey = key;
    const tag = st.choose ? "chooser" : st.input ? (st.eye.includes("PASSWORD") ? "password" : st.eye.includes("CODE") ? "code" : "email") : st.open ? "page" : st.eye.toLowerCase().replace(/[^a-z]+/g, "-");
    seen.push(`${tag}: ${st.eye} — ${st.say}`.trim());
    log("phone sees:", tag, "|", st.eye, "|", st.say, st.open ? "(page open)" : "");
    await shot(`${String(n++).padStart(2, "0")}-${tag}.png`);
    if (st.choose && !acted.has("choose")) { acted.add("choose"); await p.locator('#np-choose [data-via="google"]').click(); }
    else if (tag === "email" && !acted.has("email")) { acted.add("email"); await p.fill("#np-in", DUMMY); await shot(`${String(n++).padStart(2, "0")}-email-typed.png`); await p.click("#np-go"); }
    else if (tag === "password" || tag === "code") break; // never a real credential, and the dummy never gets here
    else if (acted.has("email") && Date.now() > deadline - 100_000) { /* keep watching for Google's answer */ }
  }
  if (acted.has("email") && seen.length >= 2 && Date.now() - (globalThis.__after ??= Date.now()) > 25_000) break;
  await p.waitForTimeout(700);
}
await shot(`${String(n++).padStart(2, "0")}-last.png`);
await p.locator("#stop").click().catch(() => {});
await p.waitForTimeout(3000);
await phoneB.close();
server.close();
writeFileSync(join(OUT, "steps.txt"), seen.join("\n") + "\n");
log("STEPS:\n" + seen.join("\n"));
process.exit(0);
