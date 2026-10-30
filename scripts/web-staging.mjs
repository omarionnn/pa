#!/usr/bin/env node
// Reason Web STAGING: every Web screen and state, drawn by the real current code (src/pages/websignin.js,
// webconvo.js, webongoing.js, webmemory.js, websettings.js, webcompose.js) with made-up data, written
// out as a static site a designer can open without signing in. Nothing here reads the live database,
// .env, or any real person: a throwaway database in a temp directory, one fictional person (Ama Owusu,
// +1 555 numbers), and Reason's public line on the join screen. No server, no texts, no model calls.
//
//   npm run web:staging                  → writes dist/web-staging/ (index.html + one page per screen)
//   npm run web:staging -- --deploy      → also deploys it to the reason-web-staging Netlify site
//
// The sample person's tasks, reminders, approval, memory and guesses are written into the throwaway
// database and read back through the same functions the live pages use (src/ongoing.js, memoryView),
// so a screen here is what that data really looks like on Web. Each page keeps its real markup, CSS and
// script; only the links are rewritten so they move between the static pages, forms submit with GET to
// the next screen, and a small stand-in answers /web/send, /web/history, /web/upload and the memory
// posts. States the page's own script draws (drop, dictating, Listening, offline, sending, didn't go,
// signed out mid-task) are set by calling that same script once the page has loaded. Every page carries
// noindex and a fixed STAGING · sample data tag.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const outDir = process.argv.find(a => a.startsWith("--out="))?.slice(6) || new URL("dist/web-staging/", root).pathname;
// The folder is wiped and rewritten each run: only ever one named web-staging.
if (!/\/web-staging\/?$/.test(outDir)) { console.error(`--out must end in /web-staging (got ${outDir})`); process.exit(1); }
const deploy = process.argv.includes("--deploy");
// reason-web-staging.netlify.app: its own Netlify site, never the marketing site.
const SITE = process.env.REASON_STAGING_SITE || "c749fa22-03a3-4a51-9b80-1081b789fede";

const dir = mkdtempSync(join(tmpdir(), "reason-web-staging-"));
for (const k of Object.keys(process.env)) if (/^(SENDBLUE|LINQ|ANTHROPIC|AGENTCARD|OPENAI|GEMINI|ELEVENLABS|TWILIO|BLAND)_/.test(k)) delete process.env[k];
delete process.env.REASON_BACKEND;
Object.assign(process.env, {
  TZ: "America/New_York",
  REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: join(dir, "data"), REASON_OWNER_NAME: "Ama", REASON_TZ: "America/New_York",
  REASON_CONVERSATION: "dm:staging", REASON_MASTER_NUMBER: "+15550100100", REASON_PAGES_URL: "https://files.heyreason.com",
  REASON_EVENTS_URL: "https://events.heyreason.com", REASON_PUBLIC_URL: "https://reason.example.test", REASON_SITE_URL: "https://heyreason.com", REASON_WEB: "on",
  // No background title-writing (a model call) for a row without a label: every sample row has one.
  REASON_ITEM_TITLES: "0",
  // Staging shows the wax-seal book (prod keeps it behind REASON_STAMPS_WAX until the owner says go).
  REASON_STAMPS_WAX: "on",
  // …and the everyday seals (a call that got what it was for, research), REASON_STAMPS_EVERYDAY.
  REASON_STAMPS_EVERYDAY: "on",
  // …and one seal per kind, milestone tiers (REASON_STAMPS_TIERS); the older screens draw their rows unfolded.
  REASON_STAMPS_TIERS: "on",
});

const imp = (p) => import(new URL(p, root));
const ws = await imp("src/pages/websignin.js");
const wc = await imp("src/pages/webconvo.js");
const kit = await imp("src/pages/webkit.js");
const og = await imp("src/pages/webongoing.js");
const wm = await imp("src/pages/webmemory.js");
const wh = await imp("src/pages/webhistory.js");
const st = await imp("src/pages/websettings.js");
const sv = await imp("src/pages/websaved.js");
const wd = await imp("src/pages/webdaily.js");
const { dailySamples } = await imp("scripts/web-daily-sample.mjs");
const { stampMarkup } = await imp("src/stamps.js");
const ongoingRows = await imp("src/ongoing.js");
const db = await imp("src/db.js");

// Reason's public line (on the marketing site too); the person and everyone in the thread are made up.
const LINE = "+16562167455";
const CONV = "dm:staging";
const EMPTY = "dm:staging-empty";
const YOU = "+1 (555) 010-0142";
db.upsertAccount({ conversationId: CONV, channel: "fake", address: "+15550100142", name: "Ama Owusu", isOperator: false });
db.upsertAccount({ conversationId: EMPTY, channel: "fake", address: "+15550100143", name: "Kojo Mensah", isOperator: false });
// Both were texting long before Web history began, so each thread's top says the rest stays in the texts.
db.db.prepare("UPDATE accounts SET created_at = ?").run(Date.now() - 60 * 864e5);
db.db.prepare("INSERT INTO pages (id, conversation_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("lisbon4", CONV, "Four days in Lisbon", "[]", Date.now(), Date.now());
const account = db.getAccount(CONV);
const emptyAccount = db.getAccount(EMPTY);

const now = Date.now();
const H = 3_600_000, day = 864e5;
const at = (d, h, m) => { const x = new Date(now - d * day); x.setHours(h, m, 0, 0); return x.getTime(); };
/** The next `weekday` (0 = Sunday) at h:m, local, after now. */
const nextDay = (weekday, h, m) => { const x = new Date(now); x.setHours(h, m, 0, 0); while (x.getDay() !== weekday || x.getTime() <= now) x.setDate(x.getDate() + 1); return x.getTime(); };

// ---------------------------------------------------------------- the sample person's Ongoing
const blank = { constraints: {}, options: [], decisions: [], waiting: [], steers: [], routes: [], left: [], conflicts: [], prices: [], furthest: [], steps: [], needs: null, blocked: null };
function task(label, goal, state, sheet = {}) {
  const t = db.createTask(CONV, { title: label, goal, maxAttempts: 5, label });
  const id = t.id ?? t.task?.id;
  db.db.prepare("UPDATE tasks SET state = ?, sheet = ? WHERE id = ?").run(state, JSON.stringify({ ...blank, ...sheet }), id);
  return id;
}
function closed(label, state, result, hoursAgo) {
  const id = task(label, label, "running");
  db.finishTask(CONV, id, { state, outcome: result.headline ?? result.why ?? label, result });
  db.db.prepare("UPDATE tasks SET finished_at = ? WHERE id = ?").run(now - hoursAgo * H, id);
  return id;
}
const T = {
  needs: task("Choose a Lisbon hotel", "Find a hotel in Alfama for Mar 11–15 under $220 a night.", "waiting_on_you", {
    needs: { question: "Casa Amora is quieter; Memmo Alfama has the pool and the view. Which one should I hold?", tradeoff: "Casa Amora is $40 a night less.", asked_at: now - 2 * H } }),
  working: task("Birthday gift for Esi", "Find a gift like the photo, under $80, that arrives before Saturday.", "running", {
    steps: [
      { id: "1", text: "Looked at the photo you sent", state: "done", at: now - 50 * 60_000 },
      { id: "2", text: "Found nine like it under $80", state: "done", at: now - 35 * 60_000 },
      { id: "3", text: "Checking which arrive by Saturday", state: "doing", live: "4 of 9 so far" },
      { id: "4", text: "Hold the best three for you", state: "todo" },
    ] }),
  waiting: task("Refund for the Boston flight", "Get the refund for the cancelled Boston flight.", "waiting_on_other", {
    waiting: [{ on: "Delta", for: "the refund on the cancelled Boston flight", since: now - 26 * H, next_check: now + 5 * H }] }),
  stuck: task("Renew the parking permit", "Renew the residential parking permit before it lapses.", "blocked", {
    blocked: { what: "the city's site wants a login only you have.", unblock: "Sign in once on the city's site, or send me the permit number.", at: now - 3 * H } }),
  ready: closed("Find a plumber for Saturday", "done", { headline: "Kwame's Plumbing · Sat 10:00 AM", facts: ["$95 call-out, parts extra", "Confirmed by text"], note: "They'll text you when they're on the way." }, 3),
  failed: closed("Table at Osteria Nonna, Friday", "failed", { why: "they're full friday and don't keep a waitlist.", next: "I'll look at Saturday at 7:30 and ask you before I book anything." }, 20),
};
const TM = {
  reminder: db.createTimer(CONV, { fireAt: nextDay(4, 9, 0), note: "Call the dentist about moving the cleaning", label: "Call the dentist" }).id,
  call: db.createTimer(CONV, { fireAt: nextDay(5, 14, 30), note: "Call the landlord about the lease renewal", callGoal: "Ask the landlord whether the lease can renew for 12 months at the same rent.", label: "A call about the lease" }).id,
};
const SR = db.createSeries(CONV, { what: "Weekly grocery order: the usual, plus whatever's on the list", rule: { kind: "weekly", weekdays: [1], hour: 9, minute: 0 }, tz: "America/New_York", nextAt: nextDay(1, 9, 0), label: "Weekly grocery order" }).id;
// The one approval: a purchase, with the card purchase row that gives its receipt real fields.
const appr = db.askConfirmation({ conversationId: CONV, action: "purchase_confirm", summary: "Buy the linen throw from Hearth & Co for $68", stakes: "money", target: "", askedAfterMsgs: 3, amount: 68 });
{
  const cols = new Set(db.db.prepare("PRAGMA table_info(agentcard_purchases)").all().map(c => c.name));
  const row = { conversation_id: CONV, buy_conversation_id: "staging-buy-1", status: "awaiting_confirmation", amount_cents: 6800, merchant: "Hearth & Co", what: "Linen throw, oat",
    confirmation_id: appr.id, created_at: now - H, updated_at: now - H, cart_json: JSON.stringify({ items: [{ name: "Linen throw, oat", qty: 1 }], ceiling_cents: 7500 }),
    address_json: JSON.stringify({ city: "Brooklyn", state: "NY", zip: "11201" }), kind: "shop" };
  const keys = Object.keys(row).filter(k => cols.has(k));
  db.db.prepare(`INSERT INTO agentcard_purchases (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map(k => row[k]));
}
const { items, approvals, back } = ongoingRows.ongoing(CONV, now);
const detail = (kind, id) => og.renderDetail(ongoingRows.findItem(CONV, kind, id, now), { now });

// ---------------------------------------------------------------- the sample person's Saved
// What Reason made for her, written into the throwaway store and read back through src/saved.js: two
// pages, two calls it placed to others, a placed purchase, an event she organised and its album.
const SV = {};
{
  const page = (title, blocks, when) => { const pg = db.createPage(CONV, { title, blocks }); db.db.prepare("UPDATE pages SET created_at = ?, updated_at = ? WHERE id = ?").run(when, when, pg.id); return pg.id; };
  SV.dinner = page("Dinner for six, Friday", [{ type: "text", text: "Three places near Fort Greene that take a table of six on a Friday, quietest first." },
    { type: "rows", numbered: true, items: [{ name: "Olea", detail: "the back room", value: "7:30 PM" }, { name: "Walter's", detail: "a long table", value: "8:00 PM" }, { name: "Lucia", detail: "no music", value: "7:00 PM" }] }], at(1, 16, 15));
  SV.lisbon = page("Lisbon, four days", [{ type: "text", text: "Alfama first, Belém on the quiet morning, Sintra if the weather holds." }], at(9, 11, 40));
  db.db.prepare("UPDATE pages SET created_at = ?, updated_at = ? WHERE id = 'lisbon4'").run(at(16, 10, 5), at(16, 10, 5));
  const call = (goal, summary, outcome, dur, when, label) => {
    const c = db.createCall(CONV, { provider: "fake", toNumber: "+12125550188", isOwner: false, goal, facts: [] });
    db.db.prepare("UPDATE calls SET state = 'completed', outcome_kind = 'confirmed', outcome = ?, summary = ?, duration_s = ?, created_at = ?, ended_at = ?, label = ? WHERE id = ?").run(outcome, summary, dur, when, when + dur * 1000, label, c.id);
    return c.id;
  };
  SV.call = call("Book a cleaning at Dr. Patel's office", "They had Tuesday at 10:00 AM open and booked it under your name. Bring the new insurance card.", "Booked for Tuesday at 10:00 AM.", 132, at(0, 11, 20), "A cleaning at Dr. Patel's");
  call("Ask Kwame's Plumbing about Saturday", "They can come Saturday between 10 and 12. $95 call-out, parts extra.", "Saturday, 10–12.", 88, at(3, 15, 5), "Kwame's Plumbing, Saturday");
  const r = db.db.prepare(`INSERT INTO agentcard_purchases (conversation_id, buy_conversation_id, status, amount_cents, merchant, what, created_at, updated_at) VALUES (?, 'staging-buy-2', 'placed', 4200, 'Hearth & Co', 'Beeswax candles, set of four', ?, ?)`).run(CONV, at(2, 13, 0), at(2, 13, 0));
  SV.receipt = Number(r.lastInsertRowid);
  const e = db.db.prepare(`INSERT INTO events (public_id, organizer_conversation_id, name, name_key, starts_at, tz, password_hash, organizer_token, status, location, created_at, updated_at)
    VALUES ('stgevent01', ?, 'Esi turns 30', 'esi turns 30', ?, 'America/New_York', 'x', 'stg-org-token', 'active', 'Olea, Fort Greene', ?, ?)`).run(CONV, nextDay(6, 19, 30), at(4, 18, 0), at(4, 18, 0));
  SV.event = Number(e.lastInsertRowid);
  for (let i = 0; i < 5; i++) db.db.prepare("INSERT INTO event_attendees (event_id, conversation_id, via, token, joined_at, updated_at) VALUES (?, ?, 'text', ?, ?, ?)").run(SV.event, `dm:fake:+155501009${i}`, `stg-t${i}`, at(3, 12, i), at(3, 12, i));
  db.db.prepare("INSERT INTO event_albums (event_id, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(SV.event, CONV, at(4, 18, 1), at(4, 18, 1));
  db.db.prepare("INSERT INTO saved_marks (conversation_id, kind, item_id, pinned_at, removed_at, updated_at) VALUES (?, 'page', ?, ?, NULL, ?)").run(CONV, SV.dinner, now, now);
}
const savedCount = og.countOf({ items, approvals, back });
const saved = (o = {}) => sv.renderSaved({ account: o.account ?? account, csrf: "staging", query: o.query ?? {}, openKey: o.open ?? null, now, count: savedCount });

// ---------------------------------------------------------------- the sample person's memory
const mem = (about, fact, group) => db.remember(CONV, about, fact, { group, category: "", source: "user_stated" }).factId;
const AISLE = `fact-${mem("Ama Owusu", "Prefers an aisle seat on anything over two hours", "preferences")}`;
mem("Ama Owusu", "Doesn't fly before 9 AM", "preferences");
mem("Ama Owusu", "Likes oat milk in coffee, never sweetened", "preferences");
mem("Esi", "Esi's birthday is November 1", "people");
mem("Esi", "Is Ama's younger sister and lives in Philadelphia", "people");
mem("Kwame", "Kwame is the plumber who fixed the kitchen sink", "people");
mem("Ama Owusu", "Lives in Brooklyn, near Atlantic Avenue", "places");
mem("Ama Owusu", "Works from the office on Tuesdays and Thursdays", "places");
mem("Ama Owusu", "Orders groceries on Monday mornings", "routines");
mem("Ama Owusu", "Runs on Saturday mornings before 8", "routines");
db.stateWhy(CONV, { about: "Ama Owusu", why: "Saving for a trip home to Accra in December", said: "i'm saving for accra in december" });
db.noteGuess(CONV, { about: "Ama Owusu", guess: "You'd rather a hotel be quiet than central" });
db.noteGuess(CONV, { about: "Ama Owusu", guess: "You plan trips about six weeks ahead", how: "i_noticed_a_pattern" });
const memory = (state = {}, a = account) => wm.renderMemory({ account: a, csrf: "staging", state });
// Chat history (Gap 7): the sample person's messages across both channels, written straight into the
// throwaway store (the history switch is off here), read back through webhistory.js.
{
  const put = db.db.prepare("INSERT INTO messages (conversation_id, role, channel, external_id, outbox_id, text, media, at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?)");
  let k = 0;
  const say = (role, channel, text, when) => put.run(CONV, role, channel, role === "user" ? `stg-${++k}` : null, role === "user" ? null : 50_000 + ++k, text, when);
  const talk = [["user", "Can you find a quiet hotel in Lisbon for March?"], ["assistant", "On it. I'll look near Príncipe Real and keep it under $220 a night."], ["user", "And the dentist, can you get me in this week?"], ["assistant", "Calling now. I'll tell them it's recorded."], ["assistant", "Thursday 3pm with Dr. Patel. Here's the call."], ["user", "perfect"]];
  for (let d = 0; d < 9; d++) talk.forEach(([r, x], i) => { if (d === 3 && i > 3) return; say(r, d === 0 && i < 3 ? "web" : "fake", x, at(d, 9 + i, 5 * i)); });
  for (let d = 35; d < 60; d += 2) talk.slice(0, 3).forEach(([r, x], i) => say(r, "fake", x, at(d, 12, i)));
}
const DAYKEY = wh.dayKey(at(2, 12, 0));
const history = (query = {}) => wh.renderHistory({ account, query, now });

// ---------------------------------------------------------------- the thread
let id = 0;
const row = (role, channel, text, when, media = []) => ({ id: ++id, role, channel, text, media, at: when, external_id: null });
const rows = [
  row("user", "fake", "Something like this for my sister's birthday?", at(2, 18, 40), [{ mimeType: "image/jpeg", filename: "IMG_3307.JPG", url: "staging:photo" }]),
  row("assistant", "fake", "Lovely. I'll find a few like it under $80 that arrive before Saturday.", at(2, 18, 41)),
  row("user", "fake", "", at(1, 8, 2), [{ mimeType: "audio/x-caf", filename: "Audio Message.caf", url: "staging:voice", seconds: 7, transcript: "also flights to lisbon in march, nothing before 9am" }]),
  row("assistant", "fake", "On it. I'll keep the early ones out and hold the best two for you to look at.", at(1, 8, 3)),
  row("user", "web", "Here's the lease, can you check the renewal terms?", at(0, 9, 50), [{ mimeType: "application/pdf", filename: "lease-2026.pdf", url: "staging:pdf", pages: 6 }]),
  row("assistant", "web", "It renews for 12 months unless either of you says otherwise by Dec 1. I'll ask the landlord about the rent on Friday's call.", at(0, 9, 52)),
  row("user", "web", "What did you find for Lisbon?", at(0, 10, 15)),
  row("assistant", "web", "Two that fit, both after 9:\n1. Tue Mar 10, 10:40 AM nonstop, back Sat — $612\n2. Wed Mar 11, 1:15 PM nonstop, back Sun — $574\nI put the hotel shortlist here too:\nhttps://files.heyreason.com/lisbon4", at(0, 10, 17)),
  row("user", "web", "Hold the Wednesday one.", at(0, 10, 19)),
];
const lines = rows.map(r => wc.rowOut(r, { conversationId: CONV, service: "iMessage" }));
// REASON_WEB_DRAFTS is on here: the sample reply grows a sentence at a time over a stand-in live
// stream, each piece drawn by the real wc.draftHtml, then the saved line replaces it.
const REPLY = "Got it, I'll hold the Wednesday one. I'll check the fare again tonight and tell you before I book anything. If it drops before then, you'll hear from me first. (Staging: a sample reply, nothing was sent.)";
const reply = wc.rowOut({ id: 9999, role: "assistant", channel: "web", text: REPLY, media: [], at: now, external_id: null }, { conversationId: CONV });
// The person's own line as the live stream confirms it (prod sends this row before Reason starts).
const MINE = wc.rowOut({ id: 9998, role: "user", channel: "web", text: "__T__", media: [], at: now, external_id: `${CONV}:__C__` }, { conversationId: CONV });
const PIECES = REPLY.match(/[^.!?]+[.!?)]+\)?\s*/g).map(x => x).reduce((a, x) => [...a, (a.at(-1) ?? "") + x], []).map(t => wc.draftHtml(t.trim(), { conversationId: CONV, service: "iMessage" }));
const MEDIA = { "staging:photo": "media/photo.svg", "staging:voice": "media/voice.wav", "staging:pdf": "media/lease-2026.pdf" };
// The thread's media addresses (/web/media/m/<row>/<i>) point at the sample files written below.
const mediaMap = {};
for (const r of rows) r.media.forEach((m, i) => { mediaMap[`/web/media/m/${r.id}/${i}`] = MEDIA[m.url]; });

const pick = `<a class="pick" href="/web?thread" aria-label="Pick up from iMessage: continue the thread"><span class="pick-h"><span class="hand">pick up from iMessage</span><span class="dash" aria-hidden="true"></span><span class="lbl">LAST TEXT · 8:03 AM</span></span><span class="pick-q"><span class="y">also flights to lisbon in march, nothing before 9am</span><span class="r">On it. I'll keep the early ones out and hold the best two for you to look at.</span></span><span class="pick-go">Continue the thread <span aria-hidden="true">→</span></span><span class="pick-n">Same Reason, same thread. What you send here stays on Web.</span></a>`;
const convo = (o = {}) => wc.renderConversation({ account, csrf: "staging", lines, more: true, sendId: "staging", items, approvals, back, now, ...o });
const home = () => wc.renderHome({ account, csrf: "staging", sendId: "staging", items, approvals, back, pick });

// ---------------------------------------------------------------- settings
const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};
const browsers = [
  { token: "staging-here", user_agent: UA.mac, last_seen_at: now, created_at: now - 2 * day },
  { token: "staging-phone", user_agent: UA.iphone, last_seen_at: now - 2 * H, created_at: now - 9 * day },
  { token: "staging-work", user_agent: UA.win, last_seen_at: now - 4 * day, created_at: now - 12 * day },
  { token: "staging-old-1", user_agent: null, last_seen_at: now - 6 * day, created_at: now - 20 * day },
  { token: "staging-old-2", user_agent: null, last_seen_at: now - 8 * day, created_at: now - 21 * day },
];
const connected = [{ name: "AGENTCARD", phone: "CARD · AGENTCARD", on: true }, { name: "GOOGLE", on: true }, { name: "SPOTIFY", on: true }, { name: "UBER", on: true }];
const invitesView = { links_you_can_still_make: 2, links: [
  { invite: { id: 1, token: "Qm7TzK2pLx9vBc4N", state: "unused" } }, { invite: { id: 2, token: "Hd3RwA8sYe1uJf6P", state: "redeemed" } }, { invite: { id: 3, token: "Vn5GkM0qTb2zXr7L", state: "canceled" } },
] };
const settings = (o = {}) => st.renderSettings({ csrf: "staging", reach: "text", browsers, current: "staging-here", connected, invitesView, theme: "auto", now, ...o });

// ---------------------------------------------------------------- states the page's own script draws
// Run once the page's script has run, through that script's own hooks (REASON_WEB.api, the composer's
// drop handler, reasonMidTask). Dictating and Listening need a real microphone, so those two show the
// composer's own markup in the state its script puts it in (the .dictating line, the .listen screen).
const after = (js) => `<script>window.addEventListener('load',function(){setTimeout(function(){${js}},900)})</script>`;
const photoFile = `function stgPhoto(cb){var c=document.createElement('canvas');c.width=640;c.height=480;var x=c.getContext('2d'),g=x.createLinearGradient(0,0,640,480);g.addColorStop(0,'#d9b38c');g.addColorStop(1,'#8c5a3c');x.fillStyle=g;x.fillRect(0,0,640,480);x.fillStyle='rgba(255,255,255,.55)';x.beginPath();x.arc(420,190,90,0,7);x.fill();c.toBlob(function(b){cb(new File([b],'IMG_4410.PNG',{type:'image/png'}))},'image/png')}`;
const pdf = `new File(['%PDF-1.4 sample'],'menu-for-friday.pdf',{type:'application/pdf'})`;
const drop = (files) => `var d=new DataTransfer();${files}document.dispatchEvent(new DragEvent('dragenter',{dataTransfer:d,bubbles:true}));document.dispatchEvent(new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true}))`;
const STATE = {
  slips: after(`${photoFile};stgPhoto(function(p){${drop(`d.items.add(p);d.items.add(${pdf});`)};document.getElementById('c-input').value='which of these would Esi like more?'})`),
  drop: after(`var d=new DataTransfer();d.items.add(${pdf});document.dispatchEvent(new DragEvent('dragenter',{dataTransfer:d,bubbles:true}))`),
  unsupported: after(drop(`d.items.add(new File(['sample'],'notes.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));`)),
  tooBig: after(`window.STG_UPLOAD='too_big';${drop(`d.items.add(new File(['sample'],'scan-of-everything.pdf',{type:'application/pdf'}));`)}`),
  dictating: after(`var c=document.querySelector('.composer'),d=c.querySelector('.dict'),p='';c.classList.add('dictating');d.hidden=false;d.querySelector('.d-clock').textContent='0:04';for(var i=0;i<29;i++){var h=Math.max(2,Math.round(Math.abs(Math.sin(i*1.7))*24));p+='M'+(4+i*8)+' '+(16-h/2)+'v'+h}d.querySelector('.d-bars').setAttribute('d',p)`),
  listening: after(`var l=document.querySelector('.listen');l.hidden=false;document.body.classList.add('listening');l.querySelector('.ls-t').textContent='0:06';l.querySelector('.ls-fin').textContent='book the dentist for thursday morning';l.querySelector('.ls-int').textContent='and remind me the night before'`),
  sending: after(`window.STG_SEND='hang';var A=REASON_WEB.api;A.post({id:A.uid(),text:'Can you also check trains from Lisbon to Porto?'})`),
  failed: after(`window.STG_SEND='hang';var A=REASON_WEB.api,li=A.pendingLine({id:A.uid(),text:'Can you also check trains from Lisbon to Porto?'});A.state(li,'failed')`),
  offline: after(`var A=REASON_WEB.api;A.post({id:A.uid(),text:'Can you also check trains from Lisbon to Porto?'})`),
  nineD: after(`window.reasonMidTask(true)`),
  // §4h: "take it back" under a message just sent (the pen line draining), and tapped: "taken back. nothing sent."
  takeBack: after(`window.STG_SEND='hang';var A=REASON_WEB.api;A.post({id:A.uid(),text:'Book the 7:30 at Peaches.'})`),
  takenBack: after(`window.STG_SEND='hang';var A=REASON_WEB.api;A.post({id:A.uid(),text:'Book the 7:30 at Peaches.'});setTimeout(function(){var b=document.querySelector('.tb-b');if(b)b.click()},300)`),
  // §4h: the working line counting real files as they are read (src/doing.js counter).
  counts: after(`var o=document.querySelector('.onit');if(o)o.hidden=false;REASON_WEB.doing('reading the lease\u2026 2 of 3 files')`),
};
const OFFLINE_HEAD = `<script>try{Object.defineProperty(Navigator.prototype,'onLine',{get:function(){return false}})}catch(e){}</script>`;

// ---------------------------------------------------------------- Stamps (REASON_WEB_DAILY), sample stamps only
const wst = await imp("src/pages/webstamps.js");
const stampsMod = await imp("src/stamps.js");
const madeMod = await imp("src/pages/made.js");
const STAMP_DAY = 86_400_000;
const stampSample = (list) => list.map(([type, detail], i) => {
  const row = { id: 9000 + i, conversation_id: CONV, type, ref: `sample:${i}`, earned_at: now - (list.length - i) * 4 * STAMP_DAY, detail_json: JSON.stringify(detail), rotation: stampsMod.rotationFor(CONV, type, `sample:${i}`), message_id: 0 };
  return { ...stampsMod.summarize(row), href: "/web?thread", row };
});
const STAMPS_MANY = stampSample([["first", {}], ["night_shift", { time: now }], ["three_in_one", { count: 3 }], ["early", { days: 9 }], ["human", { place: "a cable company" }], ["price_drop", { savedCents: 4000 }],
  ["night_shift", { time: now }], ["long_hold", { minutes: 41 }], ["early", { days: 12 }], ["human", { place: "the airline" }], ["price_drop", { savedCents: 1800 }], ["long_hold", { minutes: 52 }]]);
// The everyday book: a first errand, four weeks of research and one call that got what it was for.
const STAMPS_EVERYDAY = stampSample([["first", {}], ["looked_into", {}], ["looked_into", {}], ["looked_into", {}], ["looked_into", {}], ["rang", { place: "" }]]);
// One seal per kind (REASON_STAMPS_TIERS): rows as the record would hold them, folded the way the book does.
const repeated = (spec) => {
  let k = 0;
  const rows = spec.flatMap(([type, n, detail = {}]) => Array.from({ length: n }, () => {
    const i = k++, ref = `sample:${i}`;
    return { id: 9100 + i, conversation_id: CONV, type, ref, earned_at: now - (200 - i) * 3_600_000, detail_json: JSON.stringify(detail), rotation: stampsMod.rotationFor(CONV, type, ref), message_id: 0 };
  }));
  rows.sort((a, b) => a.earned_at - b.earned_at);
  return stampsMod.foldBook(rows.map(row => ({ ...stampsMod.summarize(row), href: "/web?thread", row })));
};
// Omari's book today, folded: the first errand outside, research at its true count (62, plain until 500), one call.
const STAMPS_TIERS_OWNER = repeated([["first", 1], ["looked_into", 62], ["rang", 1, { place: "" }]]);
// The brief's example: research at four, one call.
const STAMPS_TIERS_FOUR = repeated([["first", 1], ["looked_into", 4], ["rang", 1, { place: "" }]]);
// Every tier side by side (a design board, not a real book): green at 62/500/1000/2140, black at 1/25/100/250.
const tierBoard = () => {
  const base = repeated([["looked_into", 1], ["rang", 1, { place: "" }]]);
  const at = (s, count, j) => {
    const t = s.type;
    return { ...s, id: 9300 + j, count, tier: stampsMod.tierOf(count, t), level: stampsMod.levelOf(count, t), next: stampsMod.nextTier(count, t), countLine: stampsMod.countLine(count, t), earnedAt: now - j * STAMP_DAY,
      date: stampsMod.monthDay(now - j * STAMP_DAY, "America/New_York"), rotation: [-4, 3, -2, 5, -6, 2, -3, 4][j] };
  };
  const [li, rang] = [base.find(s => s.type === "looked_into"), base.find(s => s.type === "rang")];
  return [[li, 62], [li, 500], [li, 1000], [li, 2140], [rang, 1], [rang, 25], [rang, 100], [rang, 250]].map(([s, n], j) => at(s, n, j)).reverse(); // the book draws newest first
};
const STAMPS_TIERS_BOARD = tierBoard();
const wx = await imp("src/pages/webseals.js");
const stampsPage = (all, o = {}) => wx.renderSealBook({ all, first: "Ama", csrf: "staging", now, ...o });
const SEAL_PUB = stampsMod.publicSeal(STAMPS_MANY.at(-1).row, "Ama");
const sharePublic = wx.renderSealSharePage({ pub: SEAL_PUB, shareId: "Sample12abcd" });
const shareMissing = (await imp("src/pages/webedge.js")).renderShareNotFound({ thing: "seal" });
// Home's "New in your book", in wax: the newest seal (a held call, yesterday).
const WAX_NEWEST = stampSample([["long_hold", { minutes: 52, place: "the airline" }]]).map(s => ({ ...s, earnedAt: now - STAMP_DAY }))[0];
const picture = (src, alt, w) => kit.webPage({ title: alt, body: `<main style="padding:32px;display:flex;flex-direction:column;gap:16px;align-items:flex-start">${kit.label(alt.toUpperCase())}<img src="${src}" alt="${alt}" style="max-width:100%;width:${w}px;height:auto;border-radius:3px"></main>` });

// ---------------------------------------------------------------- every screen
// [file, group, title, note, html, { signedOut, state, head }]
const so = { signedOut: true };
const S = [
  ["signin", "Signed out", "Sign-in", "Phone number, join column with QR.", ws.renderSignin({ joinNumber: LINE, formToken: "staging" }), so],
  ["signin-pause", "Signed out", "Sign-in · pause", "Too many codes asked for: counts down live.", ws.renderSignin({ joinNumber: LINE, formToken: "staging", number: YOU, error: { kind: "pause", waitMs: 59_000 } }), so],
  ["signin-origin", "Signed out", "Sign-in · form came from elsewhere", "", ws.renderSignin({ joinNumber: LINE, formToken: "staging", number: YOU, error: { kind: "origin" } }), so],
  ["code", "Signed out", "Code", "Six digits sent by text.", ws.renderCode({ number: YOU, joinNumber: LINE, formToken: "staging" }), so],
  ["code-wrong", "Signed out", "Code · wrong", "", ws.renderCode({ number: YOU, joinNumber: LINE, formToken: "staging", error: { kind: "wrong" } }), so],
  ["code-expired", "Signed out", "Code · expired", "", ws.renderCode({ number: YOU, formToken: "staging", error: { kind: "expired" } }), so],
  ["code-tries", "Signed out", "Code · too many tries", "Counts down live.", ws.renderCode({ number: YOU, formToken: "staging", error: { kind: "tries", waitMs: 299_000 } }), so],
  ["code-resend", "Signed out", "Code · resend limit", "", ws.renderCode({ number: YOU, formToken: "staging", error: { kind: "resend", leftMs: 600_000 } }), so],
  ["join", "Signed out", "New to Reason", "", ws.renderJoin({ joinNumber: LINE }), so],
  ["line-not-connected", "Signed out", "Line not connected", "", ws.renderJoin({ joinNumber: null }), so],
  ["signed-out", "Signed out", "Signed out", "", ws.renderSignin({ joinNumber: LINE, formToken: "staging", out: true }), so],

  ["first-visit", "Home and thread", "First visit", "Shown once.", wc.renderFirstVisit({ account }), {}],
  ["home", "Home and thread", "Home · in hand", "Greeting, composer, approval on paper, in-hand rows between dashed rules, pick up from iMessage.", home(), {}],
  ["home-new", "Home and thread", "Home · new", "Nothing in hand yet: start-with examples.", wc.renderHome({ account: emptyAccount, csrf: "staging", sendId: "staging", items: [], pick: "" }), {}],
  ["conversation", "Home and thread", "Conversation", "Photo, voice note (▶ plays), PDF slip, list, page card, approval in chat, Ongoing margin. Sending works here.", convo(), {}],
  ["conversation-empty", "Home and thread", "Conversation · empty", "No messages, nothing in hand.", wc.renderConversation({ account: emptyAccount, csrf: "staging", lines: [], more: false, sendId: "staging", items: [], approvals: [] }), {}],

  // The daily edition (REASON_WEB_DAILY): Home as a morning paper. Sample editions (scripts/web-daily-sample.mjs).
  ...Object.entries({ full: ["Daily edition", "Overnight (decision / update / done), Lines out, One question, New in your book, pick up."], first: ["Daily edition · first day", "NO. 1, \"Nothing yet.\""], quiet: ["Daily edition · quiet night", "Nothing happened overnight."], missed: ["Daily edition · missed days", "\"welcome back. here's what happened since Friday.\""] })
    .map(([k, [title, note]]) => [`daily-${k}`, "Home and thread", title, note, wd.renderDaily({ edition: { ...dailySamples()[k], newestStamp: dailySamples()[k].newestStamp ? WAX_NEWEST : undefined }, csrf: "staging", now: Date.UTC(2026, 9, 27, 13, 0), stampMarkup }), {}]),

  ["sending", "Sending", "Sending…", "A message on its way (5A).", convo(), { state: STATE.sending }],
  ["take-it-back", "Sending", "Take it back", "§4h: for 5 s after a send, until Reason starts on it; the pen line drains right to left.", convo(), { state: STATE.takeBack }],
  ["taken-back", "Sending", "Taken back", "§4h: tapped in time: \"taken back. nothing sent.\" for 2 s.", convo(), { state: STATE.takenBack }],
  ["while-you-were-out", "Home and thread", "While you were out", "§4h: back after 3+ hours with something changed: one line under TODAY, once per return.", convo({ away: "while you were out: 2 done, 1 needs you." }), {}],
  ["working-counts", "Sending", "Working line counts", "§4h: real counts only (several files read one by one); the status label follows at most every 3 s.", convo(), { state: STATE.counts }],
  ["didnt-go", "Sending", "Didn't go", "Tap to try again; it won't send twice (5A).", convo(), { state: STATE.failed }],
  ["offline", "Sending", "Offline · waiting to send", "You're offline; the message waits (9C).", convo(), { state: STATE.offline, head: OFFLINE_HEAD }],

  ["compose-slips", "Composer", "Slips on the line", "A photo and a PDF attached, words typed.", convo(), { state: STATE.slips }],
  ["compose-drop", "Composer", "Drop anywhere", "\"let go. i'll read it.\" (04).", convo(), { state: STATE.drop }],
  ["compose-unsupported", "Composer", "File error · can't read it", "Not a photo or PDF.", convo(), { state: STATE.unsupported }],
  ["compose-too-big", "Composer", "File error · too big", "", convo(), { state: STATE.tooBig }],
  ["compose-dictating", "Composer", "Dictating on the line", "Tap the mic (03).", convo(), { state: STATE.dictating }],
  ["compose-listening", "Composer", "Listening", "Hold the mic: full screen, words as they're heard (D).", convo(), { state: STATE.listening }],
  ["home-slips", "Composer", "Home · slips on the line", "The same composer on the arrival.", home(), { state: STATE.slips }],

  ["ongoing", "Ongoing", "Ongoing · list", "Mobile tab: NEEDS YOU, IN HAND, BACK TO YOU.", wc.renderOngoing({ csrf: "staging", items, approvals, back }), {}],
  ...(og.groupRows({ items, back }, "hand").length ? [["ongoing-hand", "Ongoing", "See all · in hand", "2B: newest first, filter words with counts, a meta line on every row.", og.renderSeeAll({ items, approvals, back }, "hand", { tabBar: wc.tabBar("ongoing", og.countOf({ items, approvals, back })), css: wc.CONVO_CSS }), {}]] : []),
  ...(back.length ? [["ongoing-back", "Ongoing", "See all · back to you", "", og.renderSeeAll({ items, approvals, back }, "back", { tabBar: wc.tabBar("ongoing", og.countOf({ items, approvals, back })), css: wc.CONVO_CSS }), {}]] : []),
  ["ongoing-empty", "Ongoing", "Ongoing · empty", "Nothing left to chase.", wc.renderOngoing({ csrf: "staging", items: [] }), {}],
  ["detail-approval", "Ongoing", "Approval", "Receipt, NOTHING CHARGED YET, reply in chat.", detail("approval", appr.id), {}],
  ["detail-working", "Ongoing", "2A · Working", "Steps with times, the live line.", detail("task", T.working), {}],
  ["detail-waiting", "Ongoing", "2B · Waiting", "Asked, for, next check.", detail("task", T.waiting), {}],
  ["detail-scheduled", "Ongoing", "2C · Scheduled · every Monday", "9:00 EVERY MONDAY, NEXT.", detail("series", SR), {}],
  ["detail-reminder", "Ongoing", "2C · Scheduled · one reminder", "", detail("timer", TM.reminder), {}],
  ["detail-call", "Ongoing", "2C · Scheduled call", "", detail("timer", TM.call), {}],
  ["detail-ready", "Ongoing", "2D · Ready", "The DONE card.", detail("task", T.ready), {}],
  ["detail-failed", "Ongoing", "2E · Didn't work", "Why, and what happens next.", detail("task", T.failed), {}],
  ["detail-needs", "Ongoing", "Waiting on you", "One question with the tradeoff.", detail("task", T.needs), {}],
  ["detail-stuck", "Ongoing", "Stuck", "What would get it going.", detail("task", T.stuck), {}],
  ["signed-out-mid-task", "Ongoing", "Signed out mid-task", "9D over the working detail.", detail("task", T.working), { state: STATE.nineD }],
  ["signed-out-mid-task-chat", "Ongoing", "Signed out mid-task · thread", "9D from the conversation.", convo(), { state: STATE.nineD }],

  ["memory", "Memory", "Memory", "Grouped facts, REASON THINKS… guesses. CORRECT / FORGET work here.", memory(), {}],
  ["memory-correcting", "Memory", "Memory · correcting", "7B.", memory({ correct: AISLE }), {}],
  ["memory-correct-error", "Memory", "Memory · correcting, didn't save", "", memory({ correct: AISLE, error: "that didn't save. try again?" }), {}],
  ["memory-got-it", "Memory", "Memory · got it", "\"got it.\" beside the corrected line.", memory({ fixed: AISLE }), {}],
  ["memory-forget", "Memory", "Memory · forget card", "7C.", memory({ forget: AISLE }), {}],
  ["memory-empty", "Memory", "Memory · empty", "Nothing saved yet.", memory({}, emptyAccount), {}],
  ["memory-guesses", "Memory", "6A · Guesses, see all", "SEE ALL ↓ opened.", memory({ guesses: "all" }), {}],
  ["memory-filter", "Memory", "6A · Filtered to People", "A filter shows its whole group.", memory({ g: "people" }), {}],
  ["memory-search", "Memory", "6B · Searching", "Matches underlined in pen, the same person's lines after, the count.", memory({ q: "esi" }), {}],
  ["memory-nomatch", "Memory", "6B · No match", "", memory({ q: "zebra" }), {}],
  ["history", "Memory", "7A · Chat history", "Days of this month, earlier months grouped, FIND A MESSAGE.", history(), {}],
  ["history-day", "Memory", "7B · A day, read-only", "No composer, Go to chat →.", history({ day: DAYKEY }), {}],
  ["history-search", "Memory", "Chat history · search", "Matches underlined in pen.", history({ q: "dentist" }), {}],

  ["saved", "Saved", "Saved · list (S-A / desk-saved)", "FIND SOMETHING, kinds with counts, PINNED, THIS WEEK / EARLIER; on a desktop the pinned item opens beside it.", saved(), {}],
  ["saved-page", "Saved", "Saved · a page opened", "The real page on paper, PIN · OPEN THE PAGE ↗, REMOVE FROM SAVED.", saved({ open: `page-${SV.lisbon}` }), {}],
  ["saved-call", "Saved", "Saved · a call opened", "What happened, how it ended, BOOKED.", saved({ open: `call-${SV.call}` }), {}],
  ["saved-receipt", "Saved", "Saved · a receipt opened", "PAID.", saved({ open: `receipt-${SV.receipt}` }), {}],
  ["saved-event", "Saved", "Saved · an event opened", "", saved({ open: `event-${SV.event}` }), {}],
  ["saved-calls", "Saved", "Saved · only calls", "A kind picked.", saved({ query: { kind: "calls" } }), {}],
  ["saved-search", "Saved", "Saved · searching", "", saved({ query: { q: "dinner" } }), {}],
  ["saved-nomatch", "Saved", "Saved · no match", "", saved({ query: { q: "zebra" } }), {}],
  ["saved-removed", "Saved", "Saved · taken out", "PUT IT BACK.", saved({ query: { removed: `receipt-${SV.receipt}` } }), {}],
  ["saved-empty", "Saved", "Saved · empty (S-B)", "Nothing saved yet.", saved({ account: emptyAccount }), {}],

  ["settings", "Settings", "Settings", "Reach (text me for everything), browsers, connected, invites, theme.", settings(), {}],
  ["settings-reach-web", "Settings", "Settings · keep routine results here", "Reach at timely decisions.", settings({ reach: "web" }), {}],
  ["settings-reach-edit", "Settings", "Settings · 5A reach choices", "The radio list of four, Save → / CANCEL.", st.renderReachEdit({ csrf: "staging", reach: "web" }), {}],
  ["settings-reach-saved", "Settings", "Settings · 5B saved", "Only what needs a yes, just saved.", st.renderReachSaved({ reach: "yes" }), {}],
  ["settings-signout-all", "Settings", "Settings · 5C sign out everywhere?", "", st.renderSignOutAll({ csrf: "staging", count: 5 }), {}],
  ["settings-invite-just-made", "Settings", "Settings · 5D invite just made", "Copy it → / SHARE show where the browser can do them.", st.renderInviteMade({ invite: { id: 1, token: "Qm7TzK2pLx9vBc4NabcdEFGH12345678", state: "unused" }, left: 1 }), {}],
  ["settings-notify", "Settings", "Settings · 8C browser notifications", "", st.renderNotifySub({ csrf: "staging", reach: "web" }), {}],
  ["settings-notify-on", "Settings", "Settings · 8C on in this browser", "", settings({ notify: true }), {}],
  ["settings-browser-out", "Settings", "Settings · signed a browser out", "", settings({ browsers: browsers.filter(b => b.token !== "staging-work"), done: "browsers" }), {}],
  ["settings-invite-canceled", "Settings", "Settings · invite canceled", "", settings({ done: "invite-canceled" }), {}],
  ["settings-invite-name", "Settings", "Settings · invite needs a name", "", settings({ done: "invite-name" }), {}],
  ["settings-theme-night", "Settings", "Settings · theme Night", "", settings({ theme: "night", done: "theme" }), {}],
  ["settings-nothing-connected", "Settings", "Settings · nothing connected, no invites", "", settings({ connected: [], invitesView: null, browsers: browsers.slice(0, 1) }), {}],

  ["stamps", "Stamps", "Stamps · the book, last page", "Wax seals tilted on a paper sheet, NEW on the newest, two not-yet spots engraved, the aside: story, SHARE IT (the compliments card), the first-errand patch kept outside.", stampsPage(STAMPS_MANY), {}],
  ["stamps-everyday", "Stamps", "Stamps · everyday seals", "Research (one a week) and a call that got what it was for land in the book: five seals plus the patch outside, two not-yet spots, the patch outside.", stampsPage(STAMPS_EVERYDAY), {}],
  ["stamps-page1", "Stamps", "Stamps · an earlier page", "A full page of eight: no not-yet spots.", stampsPage(STAMPS_MANY, { page: 1 }), {}],
  ["stamps-tiers-owner", "Stamps", "Stamps · one per kind (Omari's book)", "REASON_STAMPS_TIERS: research at its true count (62, the plain seal: \"62 times · next at 500\") and one call (\"Once · next at 25\"), each once.", stampsPage(STAMPS_TIERS_OWNER), {}],
  ["stamps-tiers-four", "Stamps", "Stamps · one per kind (research at four)", "The plain seal until 500: \"4 times · next at 500\".", stampsPage(STAMPS_TIERS_FOUR), {}],
  ["stamps-tiers-board", "Stamps", "Stamps · every tier side by side", "Design board: research at 62 / 500 / 1000 / 2140, a call at 1 / 25 / 100 / 250. Tier 2 rust ribbon, tier 3 gold ribbon + gold ring, tier 4 + double ring and gilded edge; the ribbon carries the real count.", stampsPage(STAMPS_TIERS_BOARD), {}],
  ["stamps-first", "Stamps", "Stamps · first seal", "One seal, two not-yet spots, the patch outside the book.", stampsPage(STAMPS_MANY.slice(0, 2)), {}],
  ["stamps-patch-only", "Stamps", "Stamps · only the first errand", "No seals yet; the first-errand patch kept outside the book.", stampsPage(STAMPS_MANY.slice(0, 1)), {}],
  ["stamps-empty", "Stamps", "Stamps · empty", "Nothing earned yet: two not-yet spots.", stampsPage([]), {}],
  ["stamps-shared", "Stamps", "Stamps · a link exists", "The link written out, STOP SHARING.", stampsPage(STAMPS_MANY, { share: { share_id: "Sample12abcd", show_name: 1 } }), {}],
  ["stamp-card", "Stamps", "Share card · 1200×630", "Save image and the link preview (og:image), first name on.", picture("media/stamp-card.png", "Share card", 1200), {}],
  ["stamp-card-noname", "Stamps", "Share card · first name off", "“…on my behalf.”", picture("media/stamp-card-noname.png", "Share card, no name", 1200), {}],
  ["stamp-story", "Stamps", "Story image · 9:16", "1080×1920: the sealed card, the line, HEYREASON.COM.", picture("media/stamp-story.png", "Story image", 405), {}],
  ["stamp-share-public", "Stamps", "Shared seal · public page", "heyreason.com/s/<id>: no sign-in, noindex.", sharePublic, so],
  ["stamp-share-missing", "Stamps", "Shared seal · not here (404)", "heyreason.com/s/<id> never existed, turned off, or malformed: one page, 404, noindex.", shareMissing, so],
  ["stamp-share-off", "Stamps", "Shared seal · turned off", "Stop sharing → 410.", madeMod.renderTurnedOff({ host: "HEYREASON.COM", siteUrl: "https://heyreason.com" }), so],

  ["loader", "Global", "Loader", "The reas◯n·ing loader (plays on every load here).", home(), {}],
  ["error", "Global", "Something went wrong", "", wc.renderError(), {}],
];
const MISSING = [
  "Menu (phones): the ··· button on any signed-in page at phone width.",
  "Private by default (Settings): not drawn on main until it's true (SCOPE Q5).",
];

// ---------------------------------------------------------------- static rewrites
const DETAIL = {
  [`approval/${appr.id}`]: "detail-approval", [`task/${T.working}`]: "detail-working", [`task/${T.waiting}`]: "detail-waiting", [`task/${T.ready}`]: "detail-ready",
  [`task/${T.failed}`]: "detail-failed", [`task/${T.needs}`]: "detail-needs", [`task/${T.stuck}`]: "detail-stuck", [`series/${SR}`]: "detail-scheduled",
  [`timer/${TM.reminder}`]: "detail-reminder", [`timer/${TM.call}`]: "detail-call",
};
function local(url, signedOut) {
  const [p, q = ""] = url.replace(/&amp;/g, "&").split("?");
  const qs = new URLSearchParams(q);
  if (p === "/web") {
    if (qs.has("out")) return "signed-out.html";
    if (qs.has("join")) return "join.html";
    if (qs.get("tab") === "ongoing") return "ongoing.html";
    if (qs.has("thread")) return "conversation.html";
    return signedOut ? "signin.html" : "home.html";
  }
  const d = /^\/web\/ongoing\/([a-z]+\/\d+)$/.exec(p);
  if (d) return DETAIL[d[1]] ? `${DETAIL[d[1]]}.html` : "ongoing.html";
  if (p === "/web/ongoing") return "ongoing.html";
  if (p === "/web/memory/history") return qs.get("day") ? "history-day.html" : qs.get("q") ? "history-search.html" : "history.html";
  if (p === "/web/ongoing/hand") return "ongoing-hand.html";
  if (p === "/web/ongoing/back") return "ongoing-back.html";
  if (p === "/web/memory") {
    if (qs.get("q")) return "memory-search.html";
    if (qs.get("g")) return "memory-filter.html";
    if (qs.get("guesses")) return "memory-guesses.html";
    if (qs.get("correct") === AISLE) return "memory-correcting.html";
    if (qs.get("forget") === AISLE) return "memory-forget.html";
    return "memory.html";
  }
  const svf = /^\/web\/saved\/page\/([^/]+)\/frame$/.exec(p);
  if (svf) return `saved-frame-${decodeURIComponent(svf[1])}.html`;
  const svo = /^\/web\/saved\/([a-z]+)\/([^/]+)$/.exec(p);
  if (svo) return { [`page/${SV.lisbon}`]: "saved-page.html", [`call/${SV.call}`]: "saved-call.html", [`receipt/${SV.receipt}`]: "saved-receipt.html", [`event/${SV.event}`]: "saved-event.html" }[`${svo[1]}/${decodeURIComponent(svo[2])}`] ?? "saved.html";
  if (p === "/web/saved") return qs.get("q") ? (/dinner/i.test(qs.get("q")) ? "saved-search.html" : "saved-nomatch.html") : qs.get("kind") === "calls" ? "saved-calls.html" : "saved.html";
  if (p === "/web/saved/remove") return "saved-removed.html";
  if (p === "/web/saved/pin" || p === "/web/saved/restore") return "saved.html";
  if (mediaMap[p]) return mediaMap[p];
  const sp = /^\/web\/api\/stamps\/\d+\/(image|story)\.png$/.exec(p);
  if (sp) return `media/stamp-${sp[1] === "image" ? "card" : "story"}${sp[1] === "image" && qs.get("name") === "0" ? "-noname" : ""}.png`;
  return { "/web/memory/correct": "memory-got-it.html", "/web/memory/forget": "memory.html", "/web/memory/guess": "memory.html", "/web/settings": "settings.html",
    "/web/signin": "code.html", "/web/code": "home.html", "/web/signout": "signed-out.html", "/web/send": "conversation.html" }[p] ?? null;
}
// The memory page swaps a corrected line in place from the answer's html: the real row, "got it." beside it.
const GOT = wm.rowHtml({ key: "__K__", raw: "__T__", line: "__T__" }, { gotIt: true });
const SHIM = `<script>(function(){var f=window.fetch,sent=0,n=0,R=${JSON.stringify(reply)},GOT=${JSON.stringify(GOT)},P=${JSON.stringify(PIECES)},U=${JSON.stringify(MINE)},es=null;
function now(h){return h.replace(/datetime="[^"]*"/,'datetime="'+new Date().toISOString()+'"')}
function ES(){var me=this;me.l={};es=me;setTimeout(function(){if(me.onopen)me.onopen()},0);setInterval(function(){me.fire('ping',{})},10000)}
ES.prototype.addEventListener=function(t,fn){(this.l[t]=this.l[t]||[]).push(fn)};ES.prototype.close=function(){};
ES.prototype.fire=function(t,d){(this.l[t]||[]).forEach(function(fn){fn({data:JSON.stringify(d)})})};
function play(q){if(!es){sent++;return}var e=es,t=esc(q.get('text')||''),c=q.get('id')||'';
e.fire('message',Object.assign({},U,{id:U.id+Math.floor(Math.random()*1e6),at:Date.now(),cid:c,text:t,plain:t,html:now(U.html.split('__T__').join(t))}));
e.fire('typing',{on:true,until:Date.now()+60000,doing:null});var i=0;
setTimeout(function step(){if(i<P.length){e.fire('draft',{html:now(P[i++])});setTimeout(step,650);return}
var m=Object.assign({},R,{id:R.id+Math.floor(Math.random()*1e6),at:Date.now(),html:now(R.html)});e.fire('message',m);e.fire('draft',{html:null});e.fire('typing',{on:false,until:0})},2200)}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function ans(b,st){return new Promise(function(r){setTimeout(function(){r(new Response(JSON.stringify(b),{status:st||200,headers:{'Content-Type':'application/json'}}))},700)})}
window.fetch=function(u,o){u=String(u);o=o||{};if(u.indexOf('/web/')!==0)return f.apply(this,arguments);var h=o.headers||{};
if(u.indexOf('/web/send/cancel')===0)return ans(window.STG_CANCEL==='late'?{ok:false,error:'too_late'}:{ok:true,cancelled:true},window.STG_CANCEL==='late'?409:200);
if(u.indexOf('/web/send')===0){if(window.STG_SEND==='hang')return new Promise(function(){});var q=new URLSearchParams(String(o.body||''));setTimeout(function(){play(q)},750);return ans({ok:true})}
if(u.indexOf('/web/upload')===0){var t=String(h['Content-Type']||''),nm=decodeURIComponent(h['X-Reason-Name']||'file');
if(window.STG_UPLOAD)return ans({ok:false,error:window.STG_UPLOAD},413);
if(!/^image\\/|^application\\/pdf|^audio\\//.test(t))return ans({ok:false,error:'unsupported'},415);
var k=/^image\\//.test(t)?'image':/^audio\\//.test(t)?'voice':'pdf';return ans({ok:true,id:'stg'+(++n),kind:k,name:nm,label:k==='voice'?'VOICE NOTE':nm.toUpperCase()+(k==='pdf'?' · 1 PAGE':''),src:k==='image'?'media/photo.svg':k==='voice'?'media/voice.wav':'media/lease-2026.pdf'})}
if(!o.method||o.method==='GET'){if(u.indexOf('/web/memory/history')===0)return f(/[?&]q=./.test(u)?'history-search.html':'history.html');if(u.indexOf('/web/memory')===0)return f(/[?&]q=./.test(u)?'memory-search.html':'memory.html')}
if(u.indexOf('/web/memory/correct')===0){var q=new URLSearchParams(String(o.body||''));return ans({ok:true,html:GOT.split('__K__').join(esc(q.get('k'))).split('__T__').join(esc(q.get('text')))})}
if(u.indexOf('/web/memory/')===0||u.indexOf('/web/ongoing/state')===0)return ans({ok:true});
if(/^\/web\/api\/stamps\/\d+\/share\/revoke/.test(u))return ans({ok:true,revoked:true});
if(/^\/web\/api\/stamps\/\d+\/share/.test(u))return ans({url:'https://heyreason.com/s/Sample12abcd'});
var b={messages:[],more:false};if(sent){sent--;var m=Object.assign({},R,{id:R.id+Math.floor(Math.random()*1e6),at:Date.now()});b.messages=[m]}return ans(b)};
try{window.EventSource=ES}catch(e){}})();</script>`;
const LOADER = `<script>try{sessionStorage.removeItem('reason-web-loaded')}catch(e){}</script>`;
const TAG = `<style>.stg-tag{position:fixed;right:10px;bottom:10px;z-index:9999;font:11px/1 "Courier New",Courier,monospace;letter-spacing:.12em;text-transform:uppercase;background:#9c3b2e;color:#fff;padding:7px 9px;text-decoration:none;opacity:.9}.stg-tag:hover{color:#fff;opacity:1}</style><a class="stg-tag" href="index.html">STAGING · sample data · all screens</a>`;

function stage(html, { signedOut = false, loader = false, state = "", head = "" } = {}) {
  let out = html
    .replace(/(href|action|src|data-src)="(\/web(?:\/[A-Za-z0-9_-]+)*(?:\?[^"#]*)?)(#[^"]*)?"/g, (m, attr, url, hash = "") => { const to = local(url, signedOut); return to ? `${attr}="${to}${hash}"` : m; })
    .replace(/location\.(href|replace)(=|\()'(\/web[^']*)'/g, (m, how, op, url) => { const to = local(url, signedOut); return to ? `location.${how}${op}'${to}'` : m; })
    .replace(/<form([^>]*?) method="POST"/g, `<form$1 method="GET"`)
    .replace(`save.href='/web/api/stamps/'+id+'/image.png?name='+(on()?1:0)`, `save.href='media/stamp-card'+(on()?'':'-noname')+'.png'`);
  if (!/<meta name="robots" content="[^"]*noindex/.test(out)) out = out.replace("<head>", `<head>\n<meta name="robots" content="noindex">`);
  out = out.replace("<head>", `<head>\n${head}${loader ? LOADER : ""}${SHIM}`);
  return out.replace(/<\/body>/, `${state}${TAG}</body>`);
}

// ---------------------------------------------------------------- sample media
const PHOTO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e7cfae"/><stop offset="1" stop-color="#9a6a46"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/><rect x="250" y="170" width="300" height="300" rx="14" fill="#f4ece0" stroke="#7a4f33" stroke-width="6"/><path d="M250 260h300M400 170v300" stroke="#9c3b2e" stroke-width="18"/><circle cx="400" cy="160" r="34" fill="none" stroke="#9c3b2e" stroke-width="12"/></svg>`;
/** One second of quiet, 8 kHz mono: enough for ▶ to play something. */
function silentWav(seconds = 1, rate = 8000) {
  const n = seconds * rate, b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
}
const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 58>>stream\nBT /F1 24 Tf 72 700 Td (Sample lease - staging, not real) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

// ---------------------------------------------------------------- write
try {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "web", "fonts"), { recursive: true });
  mkdirSync(join(outDir, "media"), { recursive: true });
  for (const name of Object.keys(kit.WEB_FONTS)) writeFileSync(join(outDir, "web", "fonts", `${name}.woff2`), kit.WEB_FONTS[name]);
  for (const f of ["favicon.svg", "apple-touch-icon.png"]) copyFileSync(new URL(`assets/${f}`, root), join(outDir, f));
  writeFileSync(join(outDir, "media", "photo.svg"), PHOTO_SVG);
  writeFileSync(join(outDir, "media", "voice.wav"), silentWav());
  writeFileSync(join(outDir, "media", "lease-2026.pdf"), PDF);
  // The seal's pictures, drawn by the server's own renderer (src/pages/card.js headless Chromium).
  {
    const { shootWithChromium } = await imp("src/pages/card.js");
    const fontCss = wx.sealFontCss();
    const draw = async (name, html, size) => writeFileSync(join(outDir, "media", name), await shootWithChromium(html, size));
    await draw("stamp-card.png", wx.sealCardHtml({ pub: SEAL_PUB, first: "Ama", fontCss }), { width: 1200, height: 630 });
    await draw("stamp-card-noname.png", wx.sealCardHtml({ pub: SEAL_PUB, first: "", fontCss }), { width: 1200, height: 630 });
    await draw("stamp-story.png", wx.sealStoryHtml({ pub: SEAL_PUB, first: "", fontCss }), { width: 1080, height: 1920 });
  }
  // Saved's paper card frames the real page, as /web/saved/page/<id>/frame draws it.
  for (const id of new Set([SV.dinner, SV.lisbon, "lisbon4"])) writeFileSync(join(outDir, `saved-frame-${id}.html`), sv.renderFrame(db.getPageIn(CONV, id)));
  for (const [file, , , , html, o] of S) writeFileSync(join(outDir, `${file}.html`), stage(html, { ...o, loader: file === "loader" }));

  const groups = [...new Set(S.map(s => s[1]))];
  const list = groups.map(g => `<section class="g">${kit.label(g.toUpperCase())}<ul>${S.filter(s => s[1] === g).map(([file, , title, note]) =>
    `<li><a href="${file}.html">${title}</a>${note ? `<span>${note}</span>` : ""}</li>`).join("")}</ul></section>`).join("");
  const body = `<main class="ix"><p class="lbl">STAGING · SAMPLE DATA</p><h1>Reason <em>Web</em> — every screen</h1>`
    + `<p class="q">Drawn by the real code on main with a made-up person (Ama Owusu, +1 555 numbers). Nothing here is signed in or connected: forms move to the next screen, sending gets one sample reply, uploads are pretend. Paper · Night · Auto at the foot of every page.</p>`
    + list + `<section class="g">${kit.label("NOT HERE")}<ul>${MISSING.map(m => `<li><span>${m}</span></li>`).join("")}</ul></section>`
    + `<p class="q">${S.length} screens. Built ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.</p></main>`;
  const css = `.ix{max-width:760px;margin:0 auto;padding:48px var(--gut) 80px}.ix h1{font:italic 44px/1.05 var(--serif);margin:8px 0 16px}.ix h1 em{color:var(--pen)}.q{color:var(--muted);font:15px/1.5 var(--sans)}.g{margin:32px 0 0}.g ul{list-style:none;padding:0;margin:8px 0 0}.g li{padding:10px 0;border-bottom:1px dashed var(--hair);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}.g a{font:italic 22px/1.2 var(--serif);color:var(--ink)}.g span{color:var(--muted);font:14px/1.4 var(--sans)}`;
  writeFileSync(join(outDir, "index.html"), stage(kit.webPage({ title: "Reason Web — staging", body, css }), {}));

  writeFileSync(join(outDir, "robots.txt"), "User-agent: *\nDisallow: /\n");
  // The real security headers, minus the framing ban (a design tool may embed a page) and no-store.
  // Saved frames its pages from this origin (frame-src 'self', as /web/saved does live); a frame carries Saved's own frame policy too.
  const csp = ws.SECURITY_HEADERS["Content-Security-Policy"].replace(/; frame-ancestors 'none'/, "; frame-src 'self'");
  writeFileSync(join(outDir, "_headers"), `/*\n  X-Robots-Tag: noindex, nofollow\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  Cache-Control: no-cache\n`
    + `/saved-frame-*\n  Content-Security-Policy: ${sv.FRAME_CSP}\n`);
  console.log(`wrote ${S.length} screens + index.html to ${outDir}`);

  if (deploy) {
    execFileSync("npx", ["--no-install", "netlify", "deploy", "--prod", "--no-build", "--dir", outDir, "--site", SITE, "--message", `web:staging ${new Date().toISOString()}`], { stdio: "inherit", cwd: dir });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
