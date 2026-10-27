#!/usr/bin/env node
// Drive Reason Web's Memory screen end to end over REAL HTTP: src/http.js createServer on a loopback
// port, real Router + Runtime, the store in a throwaway database. Every request is one a browser
// makes — the page, CORRECT / FORGET as links (no script), the form posts, the script's JSON posts —
// and every claim is checked against the store and against what a turn would read (recall, the
// profile note). No model is called (the filer is given a scripted reader). Run under the cage:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/mem.db node .agents/skills/verify-reason/bin/web-memory-drive.mjs
//
// One line per step, `ok` or `FAIL`; exits non-zero on any FAIL.
process.env.REASON_WEB = "on";
process.env.REASON_PAGES_URL = process.env.REASON_PAGES_URL || "https://files.example.test";
process.env.REASON_SITE_URL = "http://127.0.0.1";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NAME = "Omari";
delete process.env.REASON_SITE_PROXY_SECRET;
delete process.env.REASON_BACKEND;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/mem.db");
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
const { ConsoleChannel } = await imp("src/channels/console.js");
const { makeDeliver } = await imp("src/deliver.js");
const { createServer } = await imp("src/http.js");
const db = await imp("src/db.js");
const groups = await imp("src/factgroups.js");
const { memoryNotes } = await imp("src/memorynote.js");

// Two ordinary accounts (REASON_WEB=on): the cage owns dm:owner's own account row.
const OWNER_C = "dm:fake:+13475550000", KOFI_C = "dm:fake:+14155559876";
db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+13475550000", name: "Omari" });
db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: "+14155559876", name: "Kofi" });

const router = new Router({});
const consoleChannel = new ConsoleChannel({ write: () => {} });
const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
const runtime = new Runtime({ channels: router, deliver, runTurn: async () => "ok" });
router.runtime = runtime;
router.register(consoleChannel);
const server = createServer({ router, runtime, log: (e) => { if (e?.threw) console.error("THREW", e.threw); } });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const signIn = (conv) => { const t = `drive-${conv.length}-${Math.random().toString(36).slice(2)}`; db.startPageSession(`wsign:${conv}`, t, { conversationId: conv }); return { cookie: `reason_page=${t}`, csrf: db.pageSessionCsrf(t) }; };
const H = (b, extra = {}) => ({ ...(b ? { cookie: b.cookie } : {}), origin: BASE, "sec-fetch-site": "same-origin", ...extra });
const get = async (b, q = "") => { const r = await fetch(`${BASE}/web/memory${q}`, { headers: H(b), redirect: "manual" }); return { status: r.status, body: await r.text(), loc: r.headers.get("location") }; };
const post = async (b, path, fields, extra = {}) => {
  const r = await fetch(`${BASE}/web/memory/${path}`, { method: "POST", redirect: "manual", headers: H(b, { "content-type": "application/x-www-form-urlencoded", ...extra }), body: new URLSearchParams(fields) });
  return { status: r.status, body: await r.text(), loc: r.headers.get("location") };
};
const J = (b) => ({ accept: "application/json", "x-reason-csrf": b.csrf });

const owner = signIn(OWNER_C);
// 1. Empty.
let p = await get(owner);
step("empty: Nothing saved yet + the Caveat line", p.status === 200 && p.body.includes("Nothing saved yet.") && p.body.includes("jot things down as i learn them"));

// 2. Facts, filed by the (scripted) filer, grouped.
const a = db.remember(OWNER_C, "Omari", "Aisle seats, never middle").factId;
const w = db.remember(OWNER_C, "Omari", "Weekend trips: under 3 hours' drive").factId;
db.remember(OWNER_C, "Juno", "Is your dog");
db.remember(OWNER_C, "Omari", "Gym on Mondays, 6 PM");
const kofis = db.remember(KOFI_C, "Kofi", "Runs on Saturdays").factId;
const pick = { "Aisle seats, never middle": "preferences", "Weekend trips: under 3 hours' drive": "preferences", "Is your dog": "people", "Gym on Mondays, 6 PM": "routines", "Runs on Saturdays": "routines" };
groups.setFilingReader(async (rows) => rows.map(r => ({ id: r.id, group: pick[r.fact] })));
const filed = (await groups.fileFacts()) + (await groups.fileFacts());
step("the filer files each conversation's facts, one conversation per read", filed === 5 && db.unfiledCount() === 0, `${filed} filed`);
p = await get(owner);
const at = (t) => p.body.search(new RegExp(`>${t} · \\d+</h2>`));
step("grouped PREFERENCES, PEOPLE, ROUTINES in order; PLACES and WHY not drawn",
  at("PREFERENCES") > 0 && at("PREFERENCES") < at("PEOPLE") && at("PEOPLE") < at("ROUTINES") && at("PLACES") < 0 && at("WHY") < 0);
step("somebody else's fact reads as a line (Juno: is your dog)", p.body.includes("Juno: is your dog"));
step("another account's facts are not on the page", !p.body.includes("Runs on Saturdays"));

// 3. Correct, no script: link → input → form post → got it.
p = await get(owner, `?correct=fact-${w}`);
step("CORRECT opens the line as an input (CORRECTING, Save →, CANCEL)", p.body.includes(">CORRECTING</label>") && p.body.includes('action="/web/memory/correct"') && p.body.includes(">CANCEL</a>"));
let r = await post(owner, "correct", { c: owner.csrf, k: `fact-${w}`, text: "Weekend trips: under 2 hours' drive" });
const fixed = db.memoryFacts(OWNER_C).find(f => f.fact.includes("2 hours"));
step("Save → replaces the row in the store and comes back with got it.", r.status === 303 && !!fixed && !db.getFact(OWNER_C, w) && r.loc === `/web/memory?fixed=fact-${fixed?.id}#f-fact-${fixed?.id}`);
p = await get(owner, `?fixed=fact-${fixed.id}`);
step("got it. sits beside the corrected line", /2 hours(&#39;|')? drive<\/p><span class="got" role="status">got it\.<\/span>/.test(p.body));
step("recall reads the new wording only", db.recall(OWNER_C, "Omari")[0].facts.every(f => !f.fact.includes("3 hours")));

// 4. Forget, with script (JSON).
db.saveProfile(OWNER_C, "**Omari**\n- Aisle seats, never middle", [a]);
p = await get(owner, `?forget=fact-${a}`);
step("FORGET shows the card with its scope", p.body.includes("FORGET THIS?") && p.body.includes("The message where you said it stays in your chat history.") && p.body.includes(">Forget it</button>"));
r = await post(owner, "forget", { k: `fact-${a}` }, J(owner));
const notes = await memoryNotes(OWNER_C, "book me a flight", { enabled: false });
step("Forget it: gone from the store, recall and the profile riding on every turn",
  r.status === 200 && !db.getFact(OWNER_C, a) && !db.recall(OWNER_C, "Omari")[0].facts.some(f => f.fact.includes("Aisle")) && !notes.join("\n").includes("Aisle"));
step("the extractor re-reading it does not bring it back", db.remember(OWNER_C, "Omari", "Aisle seats, never middle", { source: "inferred" }).refused === "taken_back");

// 5. Guesses.
const g1 = db.noteGuess(OWNER_C, { about: "Omari", guess: "you like places with a fireplace" });
const g2 = db.noteGuess(OWNER_C, { about: "Omari", guess: "Saturdays are for your family" });
p = await get(owner);
step("REASON THINKS… lists the real guesses", p.body.includes("REASON THINKS…") && p.body.includes("you like places with a fireplace.") && p.body.includes("Saturdays are for your family."));
r = await post(owner, "guess", { c: owner.csrf, id: String(g1.id), answer: "yes" });
step("Yes, that's right → a fact in their name", r.status === 303 && db.memoryFacts(OWNER_C).some(f => f.fact === "you like places with a fireplace" && f.source === "user_stated"));
r = await post(owner, "guess", { c: owner.csrf, id: String(g2.id), answer: "no" });
p = await get(owner);
step("No → dismissed, and the same words noted again are not suggested", r.status === 303 && !p.body.includes("REASON THINKS") && db.noteGuess(OWNER_C, { about: "Omari", guess: "Saturdays are for your family" }).already_guessed && !(await get(owner)).body.includes("Saturdays are for"));

// 6. At volume (Gap 6): counts, top 3 + Show N more, a filter, guesses in one card, search.
for (const x of ["Oat milk, always", "Morning flights", "No cilantro", "Dog-friendly places only when Juno comes"]) db.remember(OWNER_C, "Omari", x, { group: "preferences" });
db.remember(OWNER_C, "Juno", "Juno's vet is Dr. Lee, Thursdays", { group: "people" });
db.noteGuess(OWNER_C, { about: "Juno", guess: "you'd rather not leave Juno overnight" });
db.noteGuess(OWNER_C, { about: "Omari", guess: "you like jazz" });
p = await get(owner);
// Unfiled lines (a guess just confirmed) stand under their fallback heading, so count with the page's own groupOf.
const { groupOf } = await imp("src/pages/webmemory.js");
const facts = db.memoryFacts(OWNER_C), prefN = facts.filter(f => groupOf(f, db.personKey("Omari")) === "preferences").length;
step("6A: ALL n and per-group counts are the store's", p.body.includes(`>ALL ${facts.length}<`) && p.body.includes(`>PREFERENCES · ${prefN}</h2>`) && p.body.includes(`>PREFERENCES ${prefN}</a>`));
step("6A: three lines shown, Show N more → to the whole group", p.body.includes(`Show ${prefN - 3} more <span aria-hidden="true">→</span>`) && p.body.includes('href="/web/memory?g=preferences#gh-preferences"'));
const filt = await get(owner, "?g=preferences");
step("a filter shows the whole group, marked current", filt.body.includes('href="/web/memory?g=preferences" aria-current="true"') && !/class="fr" [^>]*hidden>/.test(filt.body));
step("6A: guesses in one card with the count and SEE ALL ↓", p.body.includes("REASON THINKS… · 2 GUESSES</h2>") && p.body.includes(">SEE ALL ↓</button>"));
const found = await get(owner, "?q=dog");
step("6B: search underlines in pen, brings Juno's vet, the guess in Caveat, the count, the no-match line",
  found.body.includes("<mark>dog</mark>") && found.body.includes("Dr. Lee") && found.body.includes("reason thinks: you") && /\d FACTS · 1 GUESS</.test(found.body)
  && found.body.includes("Nothing else matches. You can tell Reason something new in the chat.") && !found.body.includes("jazz"));
step("MANAGE CHAT HISTORY → leads to /web/memory/history", p.body.includes('href="/web/memory/history">MANAGE CHAT HISTORY'));

// 7. Chat history (Gap 7): days, a day read-only, search; only their own.
const now = Date.now();
db.writeMessage({ conversationId: OWNER_C, role: "user", channel: "web", externalId: "d1", text: "find me a table at the hudson inn", at: now - 60_000 });
db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "fake", outboxId: 9001, text: "on it. the hudson inn has 7pm.", at: now - 30_000 });
db.writeMessage({ conversationId: KOFI_C, role: "user", channel: "fake", externalId: "k1", text: "kofi hudson secret", at: now - 20_000 });
const hget = async (b, q = "") => { const r = await fetch(`${BASE}/web/memory/history${q}`, { headers: H(b), redirect: "manual" }); return { status: r.status, body: await r.text(), loc: r.headers.get("location") }; };
let h = await hget(owner);
step("7A: Today, WEB + IMESSAGE · 2 MESSAGES, FIND A MESSAGE, the note", h.status === 200 && h.body.includes('<span class="dy-d">Today</span>') && h.body.includes("WEB + IMESSAGE · 2 MESSAGES") && h.body.includes(">FIND A MESSAGE</label>") && h.body.includes("deleting history isn"));
const key = /href="\/web\/memory\/history\?day=([\d-]+)"/.exec(h.body)?.[1];
h = await hget(owner, `?day=${key}`);
step("7B: the day read-only, labels, no composer, Go to chat →", h.body.includes("READ-ONLY") && h.body.includes("YOU · WEB · ") && h.body.includes("REASON · ") && !h.body.includes("<textarea") && !h.body.includes("<form") && h.body.includes('href="/web?thread">Go to chat'));
h = await hget(owner, "?q=hudson");
step("search: both lines, underlined, never another account's", h.body.includes(">2 MESSAGES<") && h.body.includes("<mark>hudson</mark>") && !h.body.includes("kofi"));
const nod = await hget(owner, "?day=2001-01-01"), anonH = await hget(null);
step("an empty day is a 404; signed out → /web", nod.status === 404 && anonH.status === 303 && anonH.loc === "/web");

// 8. Refusals over the wire.
const x1 = await post(owner, "forget", { k: `fact-${kofis}` }, J(owner));
const x2 = await post(owner, "correct", { c: owner.csrf, k: `fact-${kofis}`, text: "x" });
step("another account's fact id: 404 both ways, untouched", x1.status === 404 && x2.status === 404 && db.getFact(KOFI_C, kofis)?.fact === "Runs on Saturdays");
const anon = await get(null);
const anonPost = await post(null, "forget", { k: `fact-${fixed.id}` }, { accept: "application/json" });
const xsite = await post(owner, "forget", { c: owner.csrf, k: `fact-${fixed.id}` }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
const nosecret = await post(owner, "forget", { c: "nope", k: `fact-${fixed.id}` });
step("signed out → /web; 401 JSON; cross-site 403; wrong secret 403", anon.status === 303 && anon.loc === "/web" && anonPost.status === 401 && xsite.status === 403 && nosecret.status === 403 && !!db.getFact(OWNER_C, fixed.id));

server.close();
process.exit(fails ? 1 : 0);
