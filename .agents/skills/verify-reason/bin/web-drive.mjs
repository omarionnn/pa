#!/usr/bin/env node
// Drive Reason Web's sign-in end to end, in process, through the real routes (src/http.js
// webRequestFor → src/pages/websignin.js), the real Runtime, Router, outbox and a FakeChannel — the
// real code-text path with no way off this machine. Run under the cage's env so it gets its own
// database and every texting credential blanked:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/web.db node .agents/skills/verify-reason/bin/web-drive.mjs
//
// Prints one line per step, `ok` or `FAIL`, and exits non-zero on any FAIL. No model is called: every
// step is a request a browser would make, or the text a phone would receive.
process.env.REASON_WEB = process.env.REASON_WEB || "on";
process.env.REASON_PAGES_URL = process.env.REASON_PAGES_URL || "https://files.example.test";
process.env.REASON_SITE_URL = process.env.REASON_SITE_URL || "https://heyreason.example.test";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
delete process.env.REASON_AUTO_ADMIT;
// A throwaway database only: a new file in a temp directory. Never a real one.
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/web.db");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { FakeChannel } = await imp("src/channels/fake.js");
const { ConsoleChannel } = await imp("src/channels/console.js");
const { makeDeliver } = await imp("src/deliver.js");
const { webRequestFor } = await imp("src/http.js");
const ws = await imp("src/pages/websignin.js");
const db = await imp("src/db.js");
const { config } = await imp("src/config.js");

const MASTER = process.env.REASON_MASTER_NUMBER || "+12025551234";
const KOFI = "+14155559876", NOBODY = "+16465550101", LINE = "+16562167455";
const KOFI_C = `dm:fake:${KOFI}`;
db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi" });
db.upsertThread({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, isOwner: true });
db.upsertThread({ conversationId: KOFI_C, channel: "fake", address: KOFI, isOwner: true });

const runtime = new Runtime({ runTurn: async () => "ok" });
const router = new Router({ runtime });
router.runtime = runtime;
const channel = router.register(new FakeChannel({ number: LINE }));
runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
  await runtime.deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
});

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const form = (o) => new URLSearchParams(o).toString();
const req = ({ sub = null, method = "GET", body = null, cookie = "", origin = "https://heyreason.example.test" } = {}) =>
  webRequestFor({ sub, method, query: {}, headers: { host: "heyreason.example.test", cookie, origin, "x-forwarded-for": "203.0.113.9", "x-files-domain": "true" }, remoteAddress: "127.0.0.1", readBody: async () => body, runtime, router });
const cookies = (out) => [].concat(out.headers["Set-Cookie"] ?? []);
const cookieValue = (out, name) => cookies(out).map(c => new RegExp(`^${name}=([^;]*)`).exec(c)?.[1]).find(Boolean) ?? null;
const until = async (pred, ms = 2000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); return pred(); };

// 1. A fresh browser: the number form, the join block with the fake line's number, the form token.
const first = await req();
const f = cookieValue(first, ws.FORM_COOKIE);
step("GET /web: sign-in form + join block + form token", first.status === 200 && /Text me a code/.test(first.body) && first.body.includes(`sms:${LINE}`) && /<figure class="qr">/.test(first.body) && !!f);
step("security headers on the page", Object.entries(ws.SECURITY_HEADERS).every(([k, v]) => first.headers[k] === v));
const jar = `${ws.FORM_COOKIE}=${f}`;

// 2. A stranger's number: the same words, no text, no account.
const accountsBefore = db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
const stranger = await req({ sub: "signin", method: "POST", body: form({ number: NOBODY, f }), cookie: jar });
await new Promise(r => setTimeout(r, 50));
step("stranger: 200, 'Check your texts.', nothing texted, no account", stranger.status === 200 && /Check your texts\./.test(stranger.body) && channel.sent.length === 0 && db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n === accountsBefore);

// The code page names the number typed (last four digits, masked) and when this browser asked; everything else is byte for byte.
const norm = (body, n) => body.replaceAll(n, "N").replace(/••• ••• \d{4}/, "M").replace(/name="t" value="\d+"/, "t");
// 3. Kofi's number: the same words, and a code text through the outbox to his number.
const kofi = await req({ sub: "signin", method: "POST", body: form({ number: KOFI, f }), cookie: jar });
const texted = await until(() => channel.sent.some(m => m.to === KOFI));
const code = /\b(\d{6})\b/.exec(channel.sent.find(m => m.to === KOFI)?.text ?? "")?.[1];
step("Kofi: same page bytes (number aside), one six-digit code texted to him", kofi.status === 200 && texted && !!code && norm(kofi.body, KOFI) === norm(stranger.body, NOBODY));
const row = db.db.prepare("SELECT idem_key, state FROM outbox ORDER BY id DESC LIMIT 1").get();
step("the text is keyed wsign: and marked sent; nothing in the per-message history", /^wsign:/.test(row?.idem_key ?? "") && row?.state === "sent" && db.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n === 0, row?.idem_key);
step("the text ends in the Web host's AutoFill line", channel.sent.find(m => m.to === KOFI).text.split("\n").at(-1) === `@heyreason.example.test #${code}`);

// 4. Wrong code, then the right one.
const wrong = await req({ sub: "code", method: "POST", body: form({ number: KOFI, code: code === "000000" ? "000001" : "000000", f }), cookie: jar });
step("a wrong code: 200, 'that's not it', no session", wrong.status === 200 && /that(&#39;|')s not it/.test(wrong.body) && db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions").get().n === 0);
const right = await req({ sub: "code", method: "POST", body: form({ number: KOFI, code, f }), cookie: jar });
const token = cookieValue(right, "reason_page");
step("the right code: 303 to /web with an HttpOnly, Secure, SameSite=Lax cookie on /", right.status === 303 && !!token && /Path=\/; .*HttpOnly; SameSite=Lax; Secure/.test(cookies(right).find(c => c.startsWith("reason_page="))));
const reused = await req({ sub: "code", method: "POST", body: form({ number: KOFI, code, f }), cookie: jar });
step("the same code again: just wrong", reused.status === 200 && /that(&#39;|')s not it/.test(reused.body));

// 5. The landing, as Kofi; never as anybody else.
const session = `reason_page=${token}`;
const firstVisit = await req({ cookie: session });
const landing = await req({ cookie: session });
const csrf = /name="c" value="([^"]+)"/.exec(landing.body)?.[1];
step("GET /web signed in: 5C once, then the arrival (What's good, Kofi?) with the session's secret", firstVisit.status === 200 && /One Reason\.<br><em>Pick up anywhere\.<\/em>/.test(firstVisit.body) && landing.status === 200 && /What(&#39;|')s good, Kofi\?/.test(landing.body) && !/Pick up anywhere/.test(landing.body) && !!csrf);
step("the session row is Kofi's, under wsign:", db.db.prepare("SELECT conversation_id, page_id FROM page_sessions WHERE token = ?").get(token)?.conversation_id === KOFI_C);

// 6. Sign out: refused without the secret or from elsewhere; done with both.
const noSecret = await req({ sub: "signout", method: "POST", body: form({}), cookie: session });
const elsewhere = await req({ sub: "signout", method: "POST", body: form({ c: csrf }), cookie: session, origin: "https://evil.example" });
step("sign-out without the secret, or from another site: 403, still signed in", noSecret.status === 403 && elsewhere.status === 403 && /What(&#39;|')s good, Kofi\?/.test((await req({ cookie: session })).body));
const out = await req({ sub: "signout", method: "POST", body: form({ c: csrf }), cookie: session });
step("sign-out: 303, cookie cleared, row gone, cookie opens nothing", out.status === 303 && /^reason_page=; .*Max-Age=0/.test(cookies(out)[0] ?? "") && db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions").get().n === 0 && /Text me a code/.test((await req({ cookie: session })).body));

// 7. Owner-only mode: Kofi gets the page and no text.
config.web = "owner";
const before = channel.sent.length;
const ownerOnly = await req({ sub: "signin", method: "POST", body: form({ number: KOFI, f }), cookie: jar });
await new Promise(r => setTimeout(r, 50));
step("REASON_WEB=owner: Kofi's number gets the same page and no text", ownerOnly.status === 200 && /Check your texts\./.test(ownerOnly.body) && channel.sent.length === before);
config.web = true;

await runtime.idle?.().catch(() => {});
process.exit(fails ? 1 : 0);
