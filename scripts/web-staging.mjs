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
});

const imp = (p) => import(new URL(p, root));
const ws = await imp("src/pages/websignin.js");
const wc = await imp("src/pages/webconvo.js");
const kit = await imp("src/pages/webkit.js");
const og = await imp("src/pages/webongoing.js");
const wm = await imp("src/pages/webmemory.js");
const st = await imp("src/pages/websettings.js");
const ongoingRows = await imp("src/ongoing.js");
const db = await imp("src/db.js");

// Reason's public line (on the marketing site too); the person and everyone in the thread are made up.
const LINE = "+16562167455";
const CONV = "dm:staging";
const EMPTY = "dm:staging-empty";
const YOU = "+1 (555) 010-0142";
db.upsertAccount({ conversationId: CONV, channel: "fake", address: "+15550100142", name: "Ama Owusu", isOperator: false });
db.upsertAccount({ conversationId: EMPTY, channel: "fake", address: "+15550100143", name: "Kojo Mensah", isOperator: false });
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
const reply = wc.rowOut({ id: 9999, role: "assistant", channel: "web", text: "Got it. (Staging: this is a sample reply, nothing was sent.)", media: [], at: now, external_id: null }, { conversationId: CONV });
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
  { invite: { token: "Qm7TzK2pLx9vBc4N", state: "unused" } }, { invite: { token: "Hd3RwA8sYe1uJf6P", state: "redeemed" } }, { invite: { token: "Vn5GkM0qTb2zXr7L", state: "canceled" } },
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
};
const OFFLINE_HEAD = `<script>try{Object.defineProperty(Navigator.prototype,'onLine',{get:function(){return false}})}catch(e){}</script>`;

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
  ["home", "Home and thread", "Home · in hand", "Greeting, composer, approval, slips, pick up from iMessage.", home(), {}],
  ["home-new", "Home and thread", "Home · new", "Nothing in hand yet: start-with examples.", wc.renderHome({ account: emptyAccount, csrf: "staging", sendId: "staging", items: [], pick: "" }), {}],
  ["conversation", "Home and thread", "Conversation", "Photo, voice note (▶ plays), PDF slip, list, page card, approval in chat, Ongoing margin. Sending works here.", convo(), {}],
  ["conversation-all", "Home and thread", "Conversation · Ongoing open", "See all, drawn open.", convo({ all: true }), {}],
  ["conversation-empty", "Home and thread", "Conversation · empty", "No messages, nothing in hand.", wc.renderConversation({ account: emptyAccount, csrf: "staging", lines: [], more: false, sendId: "staging", items: [], approvals: [] }), {}],

  ["sending", "Sending", "Sending…", "A message on its way (5A).", convo(), { state: STATE.sending }],
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
  ["ongoing-all", "Ongoing", "Ongoing · all", "", wc.renderOngoing({ csrf: "staging", items, approvals, back, all: true }), {}],
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

  ["settings", "Settings", "Settings", "Reach (text me for everything), browsers, connected, invites, theme.", settings(), {}],
  ["settings-reach-web", "Settings", "Settings · keep routine results here", "The other reach choice, just saved.", settings({ reach: "web", done: "reach" }), {}],
  ["settings-browser-out", "Settings", "Settings · signed a browser out", "", settings({ browsers: browsers.filter(b => b.token !== "staging-work"), done: "browsers" }), {}],
  ["settings-invite-made", "Settings", "Settings · invite made", "", settings({ invitesView: { ...invitesView, links_you_can_still_make: 1, links: [{ invite: { token: "Pw4XcN9rLd2kSt8Z", state: "unused" } }, ...invitesView.links] }, done: "invite" }), {}],
  ["settings-invite-name", "Settings", "Settings · invite needs a name", "", settings({ done: "invite-name" }), {}],
  ["settings-theme-night", "Settings", "Settings · theme Night", "", settings({ theme: "night", done: "theme" }), {}],
  ["settings-nothing-connected", "Settings", "Settings · nothing connected, no invites", "", settings({ connected: [], invitesView: null, browsers: browsers.slice(0, 1) }), {}],

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
    if (qs.get("tab") === "ongoing") return qs.has("all") ? "ongoing-all.html" : "ongoing.html";
    if (qs.has("thread")) return qs.has("all") ? "conversation-all.html" : "conversation.html";
    return signedOut ? "signin.html" : "home.html";
  }
  const d = /^\/web\/ongoing\/([a-z]+\/\d+)$/.exec(p);
  if (d) return DETAIL[d[1]] ? `${DETAIL[d[1]]}.html` : "ongoing.html";
  if (p === "/web/ongoing") return "ongoing.html";
  if (p === "/web/memory") {
    if (qs.get("correct") === AISLE) return "memory-correcting.html";
    if (qs.get("forget") === AISLE) return "memory-forget.html";
    return "memory.html";
  }
  if (mediaMap[p]) return mediaMap[p];
  return { "/web/memory/correct": "memory-got-it.html", "/web/memory/forget": "memory.html", "/web/memory/guess": "memory.html", "/web/settings": "settings.html",
    "/web/signin": "code.html", "/web/code": "home.html", "/web/signout": "signed-out.html", "/web/send": "conversation.html" }[p] ?? null;
}
// The memory page swaps a corrected line in place from the answer's html: the real row, "got it." beside it.
const GOT = wm.rowHtml({ key: "__K__", raw: "__T__", line: "__T__" }, { gotIt: true });
const SHIM = `<script>(function(){var f=window.fetch,sent=0,n=0,R=${JSON.stringify(reply)},GOT=${JSON.stringify(GOT)};
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function ans(b,st){return new Promise(function(r){setTimeout(function(){r(new Response(JSON.stringify(b),{status:st||200,headers:{'Content-Type':'application/json'}}))},700)})}
window.fetch=function(u,o){u=String(u);o=o||{};if(u.indexOf('/web/')!==0)return f.apply(this,arguments);var h=o.headers||{};
if(u.indexOf('/web/send')===0){if(window.STG_SEND==='hang')return new Promise(function(){});sent++;return ans({ok:true})}
if(u.indexOf('/web/upload')===0){var t=String(h['Content-Type']||''),nm=decodeURIComponent(h['X-Reason-Name']||'file');
if(window.STG_UPLOAD)return ans({ok:false,error:window.STG_UPLOAD},413);
if(!/^image\\/|^application\\/pdf|^audio\\//.test(t))return ans({ok:false,error:'unsupported'},415);
var k=/^image\\//.test(t)?'image':/^audio\\//.test(t)?'voice':'pdf';return ans({ok:true,id:'stg'+(++n),kind:k,name:nm,label:k==='voice'?'VOICE NOTE':nm.toUpperCase()+(k==='pdf'?' · 1 PAGE':''),src:k==='image'?'media/photo.svg':k==='voice'?'media/voice.wav':'media/lease-2026.pdf'})}
if(u.indexOf('/web/memory/correct')===0){var q=new URLSearchParams(String(o.body||''));return ans({ok:true,html:GOT.split('__K__').join(esc(q.get('k'))).split('__T__').join(esc(q.get('text')))})}
if(u.indexOf('/web/memory/')===0||u.indexOf('/web/ongoing/state')===0)return ans({ok:true});
var b={messages:[],more:false};if(sent){sent--;var m=Object.assign({},R,{id:R.id+Math.floor(Math.random()*1e6),at:Date.now()});b.messages=[m]}return ans(b)};
try{window.EventSource=undefined}catch(e){}})();</script>`;
const LOADER = `<script>try{sessionStorage.removeItem('reason-web-loaded')}catch(e){}</script>`;
const TAG = `<style>.stg-tag{position:fixed;right:10px;bottom:10px;z-index:9999;font:11px/1 "Courier New",Courier,monospace;letter-spacing:.12em;text-transform:uppercase;background:#b03030;color:#fff;padding:7px 9px;text-decoration:none;opacity:.9}.stg-tag:hover{color:#fff;opacity:1}</style><a class="stg-tag" href="index.html">STAGING · sample data · all screens</a>`;

function stage(html, { signedOut = false, loader = false, state = "", head = "" } = {}) {
  let out = html
    .replace(/(href|action|src|data-src)="(\/web(?:\/[a-z0-9_-]+)*(?:\?[^"#]*)?)(#[^"]*)?"/g, (m, attr, url, hash = "") => { const to = local(url, signedOut); return to ? `${attr}="${to}${hash}"` : m; })
    .replace(/location\.(href|replace)(=|\()'(\/web[^']*)'/g, (m, how, op, url) => { const to = local(url, signedOut); return to ? `location.${how}${op}'${to}'` : m; })
    .replace(/<form method="POST"/g, `<form method="GET"`);
  if (!/<meta name="robots" content="[^"]*noindex/.test(out)) out = out.replace("<head>", `<head>\n<meta name="robots" content="noindex">`);
  out = out.replace("<head>", `<head>\n${head}${loader ? LOADER : ""}${SHIM}`);
  return out.replace(/<\/body>/, `${state}${TAG}</body>`);
}

// ---------------------------------------------------------------- sample media
const PHOTO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e7cfae"/><stop offset="1" stop-color="#9a6a46"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/><rect x="250" y="170" width="300" height="300" rx="14" fill="#f4ece0" stroke="#7a4f33" stroke-width="6"/><path d="M250 260h300M400 170v300" stroke="#b03030" stroke-width="18"/><circle cx="400" cy="160" r="34" fill="none" stroke="#b03030" stroke-width="12"/></svg>`;
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
  const csp = ws.SECURITY_HEADERS["Content-Security-Policy"].replace(/; frame-ancestors 'none'/, "");
  writeFileSync(join(outDir, "_headers"), `/*\n  X-Robots-Tag: noindex, nofollow\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  Cache-Control: no-cache\n`);
  console.log(`wrote ${S.length} screens + index.html to ${outDir}`);

  if (deploy) {
    execFileSync("npx", ["--no-install", "netlify", "deploy", "--prod", "--no-build", "--dir", outDir, "--site", SITE, "--message", `web:staging ${new Date().toISOString()}`], { stdio: "inherit", cwd: dir });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
