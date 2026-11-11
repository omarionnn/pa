#!/usr/bin/env node
// Drive the events feature end to end, in process, through the real Runtime, Router, outbox and a
// FakeChannel — the real delivery path with no way off this machine. Run under the cage's env so it
// gets its own database and every texting credential blanked:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/events.db node .agents/skills/verify-reason/bin/events-drive.mjs
//
// Prints one line per step, `ok` or `FAIL`, and exits non-zero on any FAIL. No model is called: every
// step is a tool call or a request a person's phone or browser would make.
process.env.REASON_EVENTS = process.env.REASON_EVENTS || "owner";
process.env.REASON_PAGES_URL = process.env.REASON_PAGES_URL || "https://files.example.test";
process.env.REASON_CADDY_SECRET = process.env.REASON_CADDY_SECRET || "verify-caddy"; // what Caddy adds beside its marker
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
// The events path with the first-chat onboarding off (no model read in this drive): welcome → card →
// the one thing to try. The onboarding path for event joiners is test/event-web.test.js + features/onboarding.md.
process.env.REASON_ONBOARDING ??= "off";
// Paid events (src/eventpay.js): on for the `pay:` steps, against a fake Stripe on this machine. The API
// base is forced to the fake whatever key the env carries, so nothing here can reach Stripe.
process.env.REASON_PAID_EVENTS = "on";
process.env.STRIPE_SECRET_KEY = "sk_test_drive_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_drive_fake";
const stripeCalls = [];
let stripeN = 0;
const fakeStripe = (await import("node:http")).createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const form = Object.fromEntries(new URLSearchParams(body));
    stripeCalls.push({ method: req.method, path: req.url, form });
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v1/accounts") return res.end(JSON.stringify({ id: `acct_drive_${++stripeN}`, object: "account", type: "express", charges_enabled: false, details_submitted: false }));
    if (req.method === "POST" && req.url === "/v1/account_links") return res.end(JSON.stringify({ object: "account_link", url: `https://connect.stripe.test/setup/${form.account}` }));
    if (/^\/v1\/accounts\/[^/]+$/.test(req.url) && req.method === "GET") return res.end(JSON.stringify({ id: req.url.split("/").pop(), object: "account", charges_enabled: true, details_submitted: true, payouts_enabled: true }));
    if (/^\/v1\/accounts\/[^/]+\/login_links$/.test(req.url)) return res.end(JSON.stringify({ object: "login_link", url: "https://connect.stripe.test/express/x" }));
    if (req.method === "POST" && req.url === "/v1/checkout/sessions") return res.end(JSON.stringify({ id: `cs_drive_${++stripeN}`, object: "checkout.session", url: `https://checkout.stripe.test/c/pay/cs_drive_${stripeN}` }));
    if (/\/expire$/.test(req.url)) return res.end(JSON.stringify({ object: "checkout.session", status: "expired" }));
    if (req.method === "POST" && req.url === "/v1/refunds") return res.end(JSON.stringify({ id: `re_drive_${++stripeN}`, object: "refund", status: "succeeded" }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `no such route in the fake: ${req.method} ${req.url}` } }));
  });
});
await new Promise(r => fakeStripe.listen(0, "127.0.0.1", r));
process.env.STRIPE_API_BASE = `http://127.0.0.1:${fakeStripe.address().port}`;
// A throwaway database only: a new file in a temp directory. Never a real one.
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/events.db");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}

// The contact card is served from REASON_PUBLIC_URL; without one it is skipped and the card step
// fails on a checkout with no .env. A fake address is enough — the card goes to the fake channel.
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { FakeChannel } = await imp("src/channels/fake.js");
const { ConsoleChannel } = await imp("src/channels/console.js");
const { makeDeliver } = await imp("src/deliver.js");
const { runTool } = await imp("src/tools.js");
const events = await imp("src/events.js");
const db = await imp("src/db.js");
const { config, clock } = await imp("src/config.js");
const { eventRequestFor, opsRequest } = await imp("src/http.js");
const { withYes } = await imp("test/fixture-yes.js");

const OWNER = process.env.REASON_MASTER_NUMBER || "+12025551234";
const KOFI = "+14155550001", AMA = "+14155550002", YAW = "+14155550003";
const C = { owner: config.ownerConversation, kofi: `dm:fake:${KOFI}`, ama: `dm:fake:${AMA}`, yaw: `dm:fake:${YAW}` };

let failed = 0;
const step = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

const runtime = new Runtime({ runTurn: async () => "ok" });
const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
router.runtime = runtime;
const fake = router.register(new FakeChannel({ number: "+16562167455", failFor: YAW, failWith: "unreachable" }));
runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
for (const [c, addr, name, op] of [[C.owner, OWNER, "Omari", true], [C.kofi, KOFI, "Kofi"], [C.ama, AMA, "Ama"], [C.yaw, YAW, "Yaw"]]) {
  db.upsertAccount({ conversationId: c, channel: "fake", address: addr, name, isOperator: !!op });
  db.upsertThread({ conversationId: c, channel: "fake", address: addr, isOwner: true });
}
const tool = (name, input, c) => runTool(name, input, { conversationId: c, messages: [], events: runtime });
const blastYes = (input, c) => withYes(runTool, "event_blast", input, { conversationId: c, messages: [], events: runtime });
const toNum = (n) => fake.sent.filter(m => m.to === n).map(m => m.text);

// ---- creation (flag at owner: only the owner creates) ----
const kofiTry = await tool("event_create", { name: "x", description: "x", starts_at: "2026-10-31T21:00", location: "x", password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }, C.kofi);
step("REASON_EVENTS=owner: Kofi cannot create", kofiTry.blocked === "not_available");
const made = await tool("event_create", { name: "Halloween Party", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St", welcome_message: "so glad you're coming!", password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true }, C.owner);
step("owner creates with per-detail release", made.ok && made.event.time_shown_to_guests === true && made.event.location_shown_to_guests === false, made.share?.link);
step("organizer result carries manage_page (the event link) beside guest_list_page", made.event?.manage_page === made.share?.link && /\/who\?t=/.test(made.event?.guest_list_page ?? ""));
const ev = db.getEventRow(made.event.event_id);
step("password stored only as scrypt", /^scrypt\$/.test(ev.password_hash) && !JSON.stringify(ev).includes("pumpkin"));

// ---- joining by text (existing users) ----
const bad = await tool("event_join", { name: "halloween party", password: "nope" }, C.ama);
step("Ama wrong password refused", bad.reason === "no_match");
const ama = await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, C.ama);
step("Ama joins by text; welcome sent through the outbox", ama.ok && ama.welcome_text === "sent" && toNum(AMA).some(t => /so glad you're coming/.test(t)));
step("Ama's welcome has the time, not the hidden address", toNum(AMA).some(t => /Oct 31/.test(t)) && !toNum(AMA).some(t => /Elm/.test(t)));
const link = events.eventUrl(ev);
const look = await tool("event_lookup", { link }, C.yaw);
step("pasted link shows name + description only", look.ok && Object.keys(look.event).sort().join() === "description,link,name,status");
const yaw = await tool("event_join", { link, password: "pumpkin" }, C.yaw);
step("Yaw joins by link (his line is set to fail)", yaw.ok && yaw.welcome_text === "failed");

// ---- the page: a stranger, a signed-in existing user, an existing user with no session ----
const NEW = "+14155550009", KWAME = "+14155550010";
db.upsertAccount({ conversationId: `dm:fake:${KWAME}`, channel: "fake", address: KWAME, name: "Kwame" });
db.upsertThread({ conversationId: `dm:fake:${KWAME}`, channel: "fake", address: KWAME, isOwner: true });
db.db.prepare("UPDATE accounts SET contact_card_sent_at = 1 WHERE address IN (?, ?, ?, ?)").run(KWAME, AMA, YAW, KOFI);
const web = (o) => eventRequestFor({ publicId: ev.public_id, method: "GET", query: {}, headers: { "x-files-domain": "true", "x-reason-caddy": process.env.REASON_CADDY_SECRET, "x-forwarded-for": "203.0.113.1", ...(o.headers ?? {}) }, remoteAddress: "127.0.0.1", readBody: async () => o.body ?? null, runtime, router, ...o });
const cold = await web({});
step("join page before the password: name + description only", /costumes mandatory/.test(cold.body) && !/Elm|Oct 31|Ama|\+1\d{10}/.test(cold.body) && /Joining gives you access to Reason/.test(cold.body) && /starts a text conversation between you and Reason/.test(cold.body) && !/signs you up/.test(cold.body));
const claimPage = await web({ sub: "join", method: "POST", body: new URLSearchParams({ password: "pumpkin", display_name: "Esi", in_directory: "1" }).toString() });
const sms = /href="(sms:[^"]+)"/.exec(claimPage.body)?.[1]?.replace(/&#39;/g, "'").replace(/&amp;/g, "&");
step("stranger: everything on the page, last step is one text", !!sms && sms.startsWith("sms:+16562167455?&body="));
const code = decodeURIComponent(sms.split("body=")[1]);
const joinedNew = await router.deliver({ channel: "fake", externalId: "web-1", from: NEW, text: code });
const newGot = toNum(NEW);
const iW = newGot.findIndex(t => /so glad you're coming/.test(t)), iC = fake.sent.filter(m => m.to === NEW).findIndex(m => m.media?.url), iQ = newGot.findIndex(t => /set up and run an event/.test(t));
step("stranger's text proves the phone: account made through the event, 0 invites", joinedNew.newAccount === true && db.accountByAddress("fake", NEW)?.joined_via_event === ev.id && db.inviteAllowance(`dm:fake:${NEW}`) === 0);
step("then welcome → card → one thing to try (a call or an event), no question about them, released details only", iW >= 0 && iC > iW && iQ > iC && !newGot.some(t => /Elm|what do you do/.test(t)), JSON.stringify([iW, iC, iQ]));
db.startPageSession("drive-page", "drive-session-token-kwame-0001", { conversationId: `dm:fake:${KWAME}` });
const cookie = "reason_page=drive-session-token-kwame-0001";
const signed = await web({ headers: { cookie } });
step("existing user with a page session: no new-guest notice on the page", /signed in to Reason as Kwame/.test(signed.body) && !/Joining gives you access/.test(signed.body));
const inNow = await web({ sub: "join", method: "POST", headers: { cookie }, body: new URLSearchParams({ password: "pumpkin" }).toString() });
step("…tap Join: in on the spot, welcome to their thread, no card/question, no new account", /You're in/.test(inNow.body) && toNum(KWAME).some(t => /so glad/.test(t)) && !toNum(KWAME).some(t => /what do you do/.test(t)) && db.attendeeRow(ev.id, `dm:fake:${KWAME}`)?.via === "web");
const kofiPage = await web({ sub: "join", method: "POST", body: new URLSearchParams({ password: "pumpkin", display_name: "Kofi" }).toString(), headers: { "x-forwarded-for": "203.0.113.2" } });
const kofiCode = decodeURIComponent(/body=([^"]+)"/.exec(kofiPage.body)[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
const accountsBefore = db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
const kofiJoin = await router.deliver({ channel: "fake", externalId: "web-2", from: KOFI, text: kofiCode });
step("existing user with no session: the same text just joins their account", kofiJoin.newAccount === false && db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n === accountsBefore && !toNum(KOFI).some(t => /what do you do/.test(t)));
const att = db.attendeeRow(ev.id, `dm:fake:${NEW}`);
// spec v3 §12: a new browser on Esi's link gets a gate, and the code goes to Esi's phone.
const gate = await web({ sub: "who", query: { t: att.token } });
step("who's going on a new browser: a gate with the name only", /This page is private/.test(gate.body) && !/Esi|Elm|Who's going/.test(gate.body.replace(/Halloween Party/g, "")));
const sentBeforeCode = fake.sent.length;
await web({ sub: "who", method: "POST", body: new URLSearchParams({ t: att.token, step: "send" }).toString() });
const codeText = fake.sent.slice(sentBeforeCode).find(m => m.to === NEW)?.text ?? "";
const esiCode = /code is ([0-9]{6}),/.exec(codeText)?.[1];
step("…'Text me a code' texts Esi, stored hashed", !!esiCode && /^sha256:/.test(db.db.prepare("SELECT code FROM page_codes ORDER BY id DESC LIMIT 1").get()?.code ?? ""));
// Six digits, and Apple's domain-bound last line naming the host the gate is on (2026-10-25).
step("…six digits, ending in the blank line and `@<pages host> #code`", /^[0-9]{6}$/.test(esiCode ?? "") && codeText.endsWith(`\n\n@${new URL(process.env.REASON_PAGES_URL).hostname} #${esiCode}`));
// Two taps in the SAME millisecond (clock held still): each mints a code, the second expiring the
// first, and both texts must go — the text is keyed on the code's row, not the time. Before #147 the
// key was `esign:<conv>:<ms>`, the second text was deduped away, and the person held a dead code.
const sentBeforeResend = fake.sent.filter(m => m.to === NEW).length;
const heldNow = clock.now, at = clock.now();
clock.now = () => at;
let boxPage;
try {
  boxPage = await web({ sub: "who", method: "POST", body: new URLSearchParams({ t: att.token, step: "send" }).toString() });
  await web({ sub: "who", method: "POST", body: new URLSearchParams({ t: att.token, step: "send" }).toString() });
} finally { clock.now = heldNow; }
step("…the gate's box is one numeric one-time-code field", /<input[^>]*name="code"[^>]*autocomplete="one-time-code"[^>]*inputmode="numeric"[^>]*maxlength="6"/.test(boxPage.body));
// The send is not awaited by the route: wait for the new texts, never a fixed sleep (100 ms lost
// the race about one run in three on 2026-10-25 and pasted the old, replaced code).
for (let i = 0; i < 100 && fake.sent.filter(m => m.to === NEW).length < sentBeforeResend + 2; i++) await new Promise(r => setTimeout(r, 50));
step("…two taps in one millisecond: both codes are texted, none deduped", fake.sent.filter(m => m.to === NEW).length === sentBeforeResend + 2);
const latest = fake.sent.filter(m => m.to === NEW).at(-1)?.text ?? "";
// Pasting the whole text (or autofill) opens it, the same as typing the six digits.
const opened = await web({ sub: "who", method: "POST", body: new URLSearchParams({ t: att.token, step: "code", code: latest }).toString() });
const esiCookie = `reason_page=${/reason_page=([^;]+)/.exec(opened.headers?.["Set-Cookie"] ?? "")?.[1]}`;
const who = await web({ sub: "who", query: { t: att.token }, headers: { cookie: esiCookie } });
step("who's going: opted-in names, never a phone number", /Esi/.test(who.body) && !/\+1\d{10}|4155550/.test(who.body));
const gone = await web({ sub: "signout", method: "POST", headers: { cookie: esiCookie } });
step("sign out of this browser: the next visit is gated again", gone.status === 303 && /This page is private/.test((await web({ sub: "who", query: { t: att.token }, headers: { cookie: esiCookie } })).body));
step("who's going: no token, no page", (await web({ sub: "who" })).status === 404);

// ---- organizer actions and delivery tracking ----
// Every blast needs the organizer's yes to the exact words (audit lead 28): with none, nobody is texted.
const unasked = await tool("event_blast", { event_id: ev.id, message: "bring snacks" }, C.owner);
step("a blast with no yes texts nobody and hands back the target", unasked.blocked === "needs_confirmation" && /bring snacks/.test(unasked.use_target ?? "") && !fake.sent.some(m => /bring snacks/.test(m.text ?? "")), JSON.stringify(unasked).slice(0, 200));
const blast = await blastYes({ event_id: ev.id, message: "bring snacks" }, C.owner);
step("blast tracked per guest: all but Yaw sent, Yaw failed", blast.sent?.failed === 1 && blast.sent?.sent === blast.sent?.guests - 1, JSON.stringify(blast.sent));
const before = fake.sent.length;
await blastYes({ event_id: ev.id, message: "bring snacks" }, C.owner);
step("the same blast again (on a fresh yes) sends nothing new", fake.sent.length === before);
const rel = await tool("event_release", { event_id: ev.id, detail: "location" }, C.owner);
step("release texts the address", rel.ok && toNum(AMA).some(t => /where: 12 Elm St/.test(t)));
const iso = await tool("event_blast", { event_id: ev.id, message: "hijack" }, C.ama);
step("a guest cannot blast the organizer's event", iso.ok === false && !toNum(AMA).some(t => /hijack/.test(t)));
fake.failFor = "+10000000000"; // Yaw's line comes back
const retried = await events.retryFailed({ runtime, ev });
step("retry reaches Yaw once per failed message", retried.retried >= 2 && toNum(YAW).filter(t => /bring snacks/.test(t)).length === 1, JSON.stringify(retried));
const again = await events.retryFailed({ runtime, ev });
step("a second retry finds nothing failed", again.retried === 0);
const rot = await tool("event_password_rotate", { event_id: ev.id, new_password: "ghosts" }, C.owner);
step("rotation: old password dead", rot.ok && (await tool("event_join", { name: "Halloween Party", password: "pumpkin" }, C.kofi)).ok === false);
// ---- the status page: pause, held update, resume ----
db.startPageSession("ops", "drive-ops-owner", { conversationId: C.owner });
const press = (action) => opsRequest({ method: "POST", headers: { cookie: "reason_page=drive-ops-owner" }, readBody: async () => `action=${action}&event_id=${ev.id}`, runtime, router, log: () => {} });
const opsPage = await opsRequest({ method: "GET", headers: { cookie: "reason_page=drive-ops-owner" }, readBody: async () => "", runtime, router, log: () => {} });
step("status page shows the event, its deliveries and the buttons, no hash/phone", /<h2>Events<\/h2>/.test(opsPage.body) && /value="event_pause"/.test(opsPage.body) && !/scrypt|4155550/.test(opsPage.body));
await press("event_pause");
const pausedJoin = await tool("event_join", { name: "Halloween Party", password: "ghosts" }, C.kofi);
step("paused from the status page: joining stops, the page says so", db.getEventRow(ev.id).status === "paused" && pausedJoin.reason === "paused" && /Joining is paused/.test((await web({})).body));
const sentBefore = fake.sent.length;
await tool("event_update", { event_id: ev.id, starts_at: "2026-10-31T23:00" }, C.owner);
step("an update while paused is held", fake.sent.length === sentBefore);
await press("event_resume");
step("resume sends what was held, once per guest", db.getEventRow(ev.id).status === "active" && fake.sent.filter(m => /11:00/.test(m.text ?? "")).length === db.joinedCount(ev.id));
// ---- spec v3 §11: a role per event; "which event?" ----
config.events = true; // just for this section: Kofi may make one too
const kb = await tool("event_create", { name: "Kofi's Birthday", description: "cake", starts_at: "2026-11-02T20:00", location: "Kofi's place", password: "candles", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }, C.kofi);
const kev = db.getEventRow(kb.event.event_id);
step("roles: Kofi organizes his birthday and is a guest at the Halloween party", events.roleIn(C.kofi, kev.id)?.role === "organizer" && events.roleIn(C.kofi, ev.id)?.role === "guest" && db.joinedCount(kev.id) === 0);
const asGuest = await tool("event_blast", { event_id: ev.id, event_named: "Halloween Party", message: "hijack" }, C.kofi);
step("roles: an organizer command on the event he's a guest at says so, sends nothing", asGuest.reason === "guest_there" && !fake.sent.some(m => /hijack/.test(m.text ?? "")));
const second = await tool("event_create", { name: "Rooftop Party", description: "views", starts_at: "2026-11-07T21:00", location: "the roof", password: "skyline", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }, C.owner);
const unnamed = await tool("event_update", { event_id: second.event.event_id, location: "another roof" }, C.owner);
step("which event: two of his own and no name → asked, nothing changed", unnamed.reason === "which_event" && unnamed.choices?.length === 2 && db.getEventRow(second.event.event_id).location === "the roof");
const named = await tool("event_update", { event_id: second.event.event_id, event_named: "the rooftop party", location: "another roof" }, C.owner);
step("which event: named in his words → done, the other untouched", named.ok && db.getEventRow(second.event.event_id).location === "another roof" && db.getEventRow(ev.id).location === "12 Elm St");
// ---- spec v3 §13: rides between guests ----
const rides = await imp("src/eventrides.js");
config.eventRides = "owner";
rides._setGeocoder(async (q) => ({ "fort greene": { lat: 40.6895, lng: -73.976 }, "clinton hill": { lat: 40.6897, lng: -73.9655 } })[String(q).toLowerCase()] ?? null);
const rday = new Date(Date.now() + 3 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
// Rides say nothing unprompted in the night (21:00–09:00 in the event's zone): drive this part at noon
// the day before, whatever time the drive itself runs.
const { atLocal } = await imp("src/series.js");
const [ry, rm, rd] = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" }).split("-").map(Number);
clock.skip(atLocal({ year: ry, month: rm, day: rd, hour: 12, minute: 0 }, "America/New_York") - clock.now());
const rmade = await tool("event_create", { name: "Ride Test Party", description: "rides", starts_at: `${rday}T21:00`, location: "1 Party Pl", password: "rideon", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }, C.owner);
const rev = db.getEventRow(rmade.event.event_id);
const notYet = await tool("event_ride", { event_id: rev.id, event_named: "Ride Test Party", action: "offer", area: "Fort Greene", leave_at: `${rday}T20:30`, seats: 1 }, C.ama);
step("rides off by default: no ride tool use until the organizer turns it on", notYet.ok === false);
const kRide = await tool("event_rides_setting", { event_id: rev.id, enabled: true }, C.kofi);
step("only the organizer turns rides on", kRide.ok === false);
const on = await tool("event_rides_setting", { event_id: rev.id, event_named: "Ride Test Party", enabled: true }, C.owner);
step("REASON_EVENT_RIDES=owner: the owner turns rides on for his event", on.ok && on.rides_on === true);
for (const who of [C.ama, `dm:fake:${KWAME}`]) await events.joinExisting({ conversationId: who, name: "Ride Test Party", password: "rideon" });
await tool("event_ride", { event_id: rev.id, event_named: "Ride Test Party", action: "offer", area: "Fort Greene", leave_at: `${rday}T20:30`, seats: 1 }, C.ama);
await tool("event_ride", { event_id: rev.id, event_named: "Ride Test Party", action: "need", area: "Clinton Hill", leave_at: `${rday}T20:30` }, `dm:fake:${KWAME}`);
const mText = toNum(KWAME).find(t => /ride match/.test(t)) ?? "";
step("one match suggested, first name + area only", /Ama is driving from around Fort Greene/.test(mText) && !/4155550|Party Pl/.test(mText));
await tool("event_ride", { event_id: rev.id, event_named: "Ride Test Party", action: "answer", yes: true }, C.ama);
step("one yes sets nothing", db.rideMatchesFor(rev.id, ["agreed"]).length === 0);
await tool("event_ride", { event_id: rev.id, event_named: "Ride Test Party", action: "answer", yes: true }, `dm:fake:${KWAME}`);
const cnt = await tool("event_rides_setting", { event_id: rev.id, event_named: "Ride Test Party" }, C.owner);
step("both yes: agreed, plan to both; the organizer sees counts only", toNum(AMA).some(t => /you're set: you're giving Kwame a ride/.test(t)) && cnt.counts?.matched === 2 && !/Kwame|Ama|Greene/.test(JSON.stringify(cnt)));
await tool("event_ride", { event_id: rev.id, event_named: "Ride Test Party", action: "cancel" }, C.ama);
step("a cancellation tells the other side at once", toNum(KWAME).some(t => /Ama can't do the ride you'd sorted anymore/.test(t)));
config.eventRides = false;
rides._setGeocoder(null);
clock.reset();
config.events = "owner";

// ---- the guest-list note for somebody already on Reason (owner decision 2026-10-25) ----
// Driven at noon tomorrow, then at 11pm, whatever time the drive runs: the note never goes at night.
{
  const [ny, nm, nd] = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" }).split("-").map(Number);
  const noon = atLocal({ year: ny, month: nm, day: nd, hour: 12, minute: 0 }, "America/New_York");
  clock.skip(noon - clock.now());
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 5)); };
  const notes = (n) => toNum(n).filter(t => /who's-going list/.test(t));
  const mk = async (name, password, over = {}) => db.getEventRow((await tool("event_create", { name, description: "x", starts_at: `${rday}T21:00`, location: "x", password, show_time_on_join: true, show_location_on_join: true, guest_list_visible: true, ...over }, C.owner)).event.event_id);
  const ownerBefore = notes(OWNER).length;
  const g1 = await mk("Note Test One", "noteone");
  await settle();
  step("note: the organizer is on his own list, one note after creating", notes(OWNER).length === ownerBefore + 1 && events.directoryEntries(g1)[0]?.organizer === true);
  const yBefore = toNum(KOFI).length;
  const j = await tool("event_join", { name: "Note Test One", password: "noteone" }, C.kofi);
  await settle();
  const after = toNum(KOFI).slice(yBefore);
  step("note: text join → welcome, then ONE note asking for Instagram once; listed by default", j.ok && after.filter(t => /who's-going list/.test(t)).length === 1 && /you're in for Note Test One/.test(after[0]) && /as Kofi .*send your handle if so, no worries if not\./.test(after.at(-1)) && events.directoryEntries(g1).some(e => e.name === "Kofi"), JSON.stringify(after));
  step("links: the who's-going link left as its own bubble, in full, after the words", /:$/.test(after[0]) && !/https?:/.test(after[0]) && /^https?:\/\/\S+\/who\?t=\S+$/.test(after[1] ?? ""), JSON.stringify(after.slice(0, 2)).slice(0, 200));
  step("note: in his thread as the last thing Reason said", db.loadConversation(C.kofi).at(-1)?.content === after.at(-1), JSON.stringify(db.loadConversation(C.kofi).slice(-2)).slice(0, 300));
  const share = await tool("event_directory", { event_id: g1.id, event_named: "Note Test One", instagram: "@kofi.b" }, C.kofi);
  step("note: a handle he sends is kept on his profile and shown", share.ok && db.getAccount(C.kofi).instagram === "kofi.b");
  const g2 = await mk("Note Test Two", "notetwo");
  await tool("event_join", { name: "Note Test Two", password: "notetwo" }, C.kofi);
  await settle();
  step("note: next event carries it over and says so instead of asking", /i'll show your instagram @kofi\.b on this guest list too/.test(notes(KOFI).at(-1) ?? "") && events.directoryEntries(g2).find(e => e.name === "Kofi")?.instagram === "kofi.b");
  const g3 = await mk("Note Test Three", "notethree", { guest_list_visible: false });
  const n3 = notes(KOFI).length, t3 = toNum(KOFI).length;
  await tool("event_join", { name: "Note Test Three", password: "notethree" }, C.kofi);
  await settle();
  step("note: guest list off → welcome only, no list, no Instagram", notes(KOFI).length === n3 && toNum(KOFI).length === t3 + 1 && !/instagram/i.test(toNum(KOFI).at(-1)) && db.organizerListing(g3.id) === null);
  const g4 = await mk("Note Test Four", "notefour");
  // To a fixed local hour, not "+N hours" from whenever the drive runs (the 2026-11-01 clock change
  // and an evening start both landed the "morning" inside quiet hours).
  const toLocal = (hour, nextDay = false) => {
    const tz = "America/New_York";
    const h = (t) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit" }).format(t));
    let t = clock.now() - (clock.now() % 3_600_000) + 3_600_000;
    let crossed = false;
    for (let i = 0; i < 72 && !(h(t) === hour && (!nextDay || crossed)); i++) { if (h(t) === 0) crossed = true; t += 3_600_000; }
    clock.skip(t - clock.now());
  };
  toLocal(23);
  const n4 = notes(KOFI).length;
  await tool("event_join", { name: "Note Test Four", password: "notefour" }, C.kofi);
  await settle();
  clock.skip(11 * 60_000); // past the note's own 10-minute due time (LIST_NOTE.backstopMs)
  const night = await runtime.eventListNotes();
  step("note: at 11pm nothing goes, the sweep holds it", notes(KOFI).length === n4 && night.later >= 1, JSON.stringify(night));
  toLocal(10, true);
  const m1 = await runtime.eventListNotes();
  const m2 = await runtime.eventListNotes();
  await settle();
  // n4 + 2: his Halloween join earlier in this drive was owed one too (the drive runs at any hour).
  step("note: the morning sweep sends it once", notes(KOFI).length > n4 && db.db.prepare("SELECT COUNT(*) AS n FROM event_deliveries d JOIN event_messages m ON m.id = d.message_id WHERE m.event_id = ? AND m.kind = 'list_note' AND d.conversation_id = ?").get(g4.id, C.kofi).n === 1 && db.attendeeRow(g4.id, C.kofi).list_note === "sent" && m2.sent === 0, JSON.stringify({ m1, m2, row: db.attendeeRow(g4.id, C.kofi).list_note, at: new Date(clock.now()).toISOString() }));
  const gone = await tool("event_instagram", { remove: true }, C.kofi);
  step("note: remove my Instagram → off his profile and every list", gone.ok && db.getAccount(C.kofi).instagram === null && !events.directoryEntries(g2).some(e => e.instagram));
  for (const g of [g1, g2, g3, g4]) await tool("event_cancel", { event_id: g.id, event_named: g.name }, C.owner);
  clock.reset();
}

// ---- scheduled messages and the automatic reminders (src/eventschedule.js) ----
{
  const sched = await imp("src/eventschedule.js");
  const tz = "America/New_York";
  const wall = (days, hh) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(clock.now() + days * 86_400_000)).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${String(hh).padStart(2, "0")}:00`;
  };
  const made = await tool("event_create", { name: "Sched Test Supper", description: "x", starts_at: wall(5, 20), timezone: tz, location: "9 Oak Ave", password: "supper-pw", show_time_on_join: true, show_location_on_join: false, guest_list_visible: false }, C.owner);
  const sev = db.getEventRow(made.event.event_id);
  const j = await tool("event_join", { name: "Sched Test Supper", password: "supper-pw" }, C.ama);
  step("sched: a new event has both reminders on", sev.remind_day_before === 1 && sev.remind_soon === 1 && j.ok, JSON.stringify(j).slice(0, 120));
  const input = { event_id: sev.id, event_named: sev.name, message: "bring a chair", send_at: wall(2, 10) };
  const unasked = await tool("event_schedule", input, C.owner);
  step("sched: no yes sets nothing and hands back a target with the time", unasked.blocked === "needs_confirmation" && /at .*10:00 AM/.test(unasked.use_target ?? "") && db.scheduledFor(sev.id).length === 0);
  const past = await tool("event_schedule", { ...input, send_at: wall(-1, 10) }, C.owner);
  step("sched: a past time is refused before any yes", past.reason === "past" && !past.use_target);
  const set = await withYes(runTool, "event_schedule", input, { conversationId: C.owner, messages: [], events: runtime });
  step("sched: with a yes it waits", set.ok && db.scheduledFor(sev.id, ["pending"]).length === 1, JSON.stringify(set).slice(0, 160));
  const body = events.blastBody(sev, "bring a chair");
  const due = db.scheduledRow(set.scheduled_id).send_at;
  clock.reset(); clock.skip(due + 1000 - Date.now());
  await runtime.sweep(); await runtime.sweep();
  await new Promise(r => setTimeout(r, 50));
  step("sched: the sweep sends it at its time, once", toNum(AMA).filter(t => t === body).length === 1 && db.scheduledRow(set.scheduled_id).state === "sent");
  const dayBefore = sched.reminderAt(sev, "day_before");
  clock.reset(); clock.skip(dayBefore + 60_000 - Date.now());
  await runtime.sweep(); await runtime.sweep();
  await new Promise(r => setTimeout(r, 50));
  step("sched: the day-before reminder goes once, no hidden address", toNum(AMA).filter(t => /^reminder: Sched Test Supper is tomorrow/.test(t)).length === 1 && !toNum(AMA).some(t => /Oak Ave/.test(t)));
  clock.reset();
  await withYes(runTool, "event_schedule", { ...input, message: "never sent", send_at: wall(4, 9) }, { conversationId: C.owner, messages: [], events: runtime });
  await tool("event_cancel", { event_id: sev.id, event_named: sev.name }, C.owner);
  step("sched: cancelling the event cancels what was waiting", db.scheduledFor(sev.id, ["pending"]).length === 0 && db.scheduledFor(sev.id, ["cancelled"]).length === 1);

  // A stopped organizer (lead R2-A): the master pauses Kofi's number on ANOTHER line; his event's
  // scheduled message and reminders hold (a stop is per number, db.stoppedStateOf), and go once he is let go.
  clock.reset();
  config.events = true;
  const kev = events.create(C.kofi, { name: "Kofi Stop Supper", description: "x", starts_at: wall(5, 20), timezone: tz, location: "4 Elm", password: "kofi-pw", show_time_on_join: true, show_location_on_join: false, guest_list_visible: false }).event;
  config.events = "owner";
  db.addAttendee({ eventId: kev.id, conversationId: C.ama, displayName: "Ama", via: "text" });
  const ks = sched.schedule({ ev: kev, conversationId: C.kofi, message: "kofi says hi", sendAt: wall(2, 10) });
  db.upsertAccount({ conversationId: `dm:linq:${KOFI}`, channel: "linq", address: KOFI, name: "Kofi" });
  db.setAccountState(`dm:linq:${KOFI}`, "paused");
  const kbody = events.blastBody(kev, "kofi says hi");
  clock.reset(); clock.skip(ks.row.send_at + 1000 - Date.now());
  await runtime.sweep();
  await new Promise(r => setTimeout(r, 50));
  step("sched: a paused organizer's message holds (paused on the other line)", !toNum(AMA).includes(kbody) && db.scheduledRow(ks.row.id).state === "pending");
  clock.reset(); clock.skip(sched.reminderAt(kev, "day_before") + 60_000 - Date.now());
  await runtime.sweep();
  await new Promise(r => setTimeout(r, 50));
  step("sched: no reminder for a paused organizer's event", !toNum(AMA).some(t => /^reminder: Kofi Stop Supper/.test(t)));
  db.setAccountState(`dm:linq:${KOFI}`, "active");
  await runtime.sweep();
  await new Promise(r => setTimeout(r, 50));
  step("sched: let go in its window, the reminder goes once", toNum(AMA).filter(t => /^reminder: Kofi Stop Supper is tomorrow/.test(t)).length === 1);
  db.db.prepare("DELETE FROM accounts WHERE conversation_id = ?").run(`dm:linq:${KOFI}`);
  clock.reset();
}

// ---- messages to only some guests (src/events.js recipients / pickAudience) ----
{
  const tz = "America/New_York";
  const wall = (days, hh) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(clock.now() + days * 86_400_000)).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${String(hh).padStart(2, "0")}:00`;
  };
  const made = await tool("event_create", { name: "Some Guests Supper", description: "x", starts_at: wall(5, 20), timezone: tz, location: "4 Pine St", password: "some-pw", show_time_on_join: true, show_location_on_join: false, guest_list_visible: false }, C.owner);
  const sev = db.getEventRow(made.event.event_id);
  for (const c of [C.ama, C.kofi, C.yaw]) await tool("event_join", { name: "Some Guests Supper", password: "some-pw" }, c);
  await tool("event_mute", { event_id: sev.id, event_named: sev.name, muted: true }, C.yaw);
  const list = await tool("event_guests", { event_id: sev.id, event_named: sev.name }, C.owner);
  const idOf = (c) => db.attendeeRow(sev.id, c).id;
  step("some: the guest list hands the model a guest_id per guest", list.ok && list.guests.length === 3 && list.guests.every(g => Number.isInteger(g.guest_id)), JSON.stringify(list).slice(0, 160));
  const before = fake.sent.length;
  const input = { event_id: sev.id, event_named: sev.name, message: "ama + kofi: come at 7", only_guest_ids: [idOf(C.ama), idOf(C.kofi), idOf(C.yaw)] };
  const unasked = await tool("event_blast", input, C.owner);
  step("some: no yes texts nobody; target and reaches name the count and who (muted one out)", unasked.blocked === "needs_confirmation" && /2 get it: /.test(unasked.use_target ?? "") && unasked.reaches?.guests === 2 && unasked.reaches?.skipped_muted === 1 && fake.sent.length === before, JSON.stringify(unasked.reaches));
  const bad = await tool("event_blast", { ...input, only_guest_ids: [999999] }, C.owner);
  step("some: a pick that isn't a guest is refused before any yes", bad.reason === "not_guests" && !bad.use_target);
  const sent = await blastYes(input, C.owner);
  await new Promise(r => setTimeout(r, 50));
  const body = events.blastBody(sev, "ama + kofi: come at 7");
  step("some: with a yes only the picked, unmuted guests get it", sent.ok && sent.sent.guests === 2 && toNum(AMA).includes(body) && toNum(KOFI).includes(body) && !toNum(YAW).includes(body), JSON.stringify(sent.sent));
  const sset = await withYes(runTool, "event_schedule", { event_id: sev.id, event_named: sev.name, message: "ama only, later", send_at: wall(2, 10), only_guest_ids: [idOf(C.ama)] }, { conversationId: C.owner, messages: [], events: runtime });
  const later = events.blastBody(sev, "ama only, later");
  const due = db.scheduledRow(sset.scheduled_id).send_at;
  clock.reset(); clock.skip(due + 1000 - Date.now());
  await runtime.sweep(); await runtime.sweep();
  await new Promise(r => setTimeout(r, 50));
  step("some: a scheduled pick goes at its time to the picked guest only, once", sset.ok && toNum(AMA).filter(t => t === later).length === 1 && !toNum(KOFI).includes(later) && db.scheduledRow(sset.scheduled_id).state === "sent", JSON.stringify(sset).slice(0, 160));
  clock.reset();
  // Owner decision 2026-11-08: "joined since" reads the FIRST join, so leaving and coming back is not new.
  const sinceParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(clock.now() + 60_000)).map(x => [x.type, x.value]));
  const sinceWall = `${sinceParts.year}-${sinceParts.month}-${sinceParts.day}T${sinceParts.hour}:${sinceParts.minute}`;
  clock.skip(3 * 60_000);
  db.leaveAttendee(idOf(C.kofi));
  const back = await tool("event_join", { name: "Some Guests Supper", password: "some-pw" }, C.kofi);
  const row = db.attendeeRow(sev.id, C.kofi);
  const nSince = fake.sent.length;
  const since = await tool("event_blast", { event_id: sev.id, event_named: sev.name, message: "newcomers only", only_joined_after: sinceWall }, C.owner);
  step("some: joined since doesn't count a guest who left and came back as new", back.ok && row.joined_at > row.first_joined_at && since.reaches?.guests === 0 && fake.sent.length === nSince, JSON.stringify({ reaches: since.reaches, joined: row.joined_at, first: row.first_joined_at }));
  clock.reset();
  await tool("event_cancel", { event_id: sev.id, event_named: sev.name }, C.owner);
}

// ---- the guest list's privacy and the cap, after the event is made (src/events.js setListVisible / setCapacity) ----
{
  // Noon in New York, so a list note may go (never 21:00–09:00 in the event's zone).
  clock.reset();
  const noon = new Date(); noon.setUTCHours(17, 0, 0, 0);
  clock.skip(noon.getTime() + 86_400_000 - Date.now());
  const made = await tool("event_create", { name: "Limits Lounge", description: "x", starts_at: "2027-07-10T20:00", timezone: "America/New_York", location: "1 Oak St", password: "limits-pw", show_time_on_join: true, show_location_on_join: false, guest_list_visible: false }, C.owner);
  const lev = db.getEventRow(made.event.event_id);
  for (const c of [C.ama, C.kofi]) await tool("event_join", { name: "Limits Lounge", password: "limits-pw" }, c);
  await new Promise(r => setTimeout(r, 50));
  const n0 = fake.sent.length;
  const cap = await tool("event_settings", { event_id: lev.id, event_named: lev.name, capacity: 1 }, C.owner);
  const third = await tool("event_join", { name: "Limits Lounge", password: "limits-pw" }, C.yaw);
  step("limits: a cap under the number in takes nobody off and closes joins, texting nobody", cap.ok && !cap.blocked && cap.joins_closed && db.joinedCount(lev.id) === 2 && third.reason === "full" && fake.sent.length === n0, cap.capacity_note);
  // Owner decision 2026-11-08: the full-event wording stays as written — full right now, same password if a spot opens, no waitlist.
  step("limits: a full event says so plainly, offers no waitlist", /full right now/.test(third.error ?? "") && /same password works/.test(third.error ?? "") && /no waitlist/.test(third.error ?? ""), third.error);
  const open = await tool("event_settings", { event_id: lev.id, event_named: lev.name, no_cap: true }, C.owner);
  step("limits: taking the cap off opens joining again", open.ok && open.capacity === null && db.getEventRow(lev.id).capacity === null);
  const show = { event_id: lev.id, event_named: lev.name, guest_list_visible: true };
  const unasked = await tool("event_settings", show, C.owner);
  step("limits: showing a private list asks for the yes first, naming who gets asked; nothing changes", unasked.blocked === "needs_confirmation" && unasked.asks?.guests === 2 && /ask 2 guests who joined while it was private/.test(unasked.use_target ?? "") && db.getEventRow(lev.id).guest_list_visible === 0 && fake.sent.length === n0, JSON.stringify(unasked.asks).slice(0, 160));
  const shown = await withYes(runTool, "event_settings", show, { conversationId: C.owner, messages: [], events: runtime });
  const lev2 = db.getEventRow(lev.id);
  const names = events.directoryEntries(lev2).filter(e => !e.organizer).map(e => e.name);
  step("limits: with the yes, nobody who joined while it was private shows on it", shown.ok && lev2.guest_list_visible === 1 && shown.asked === 2 && names.length === 0, JSON.stringify(names));
  // Owner decision 2026-11-08: the organizer goes on their own list when they show it, as at creation.
  const host = events.directoryEntries(lev2).filter(e => e.organizer).map(e => e.name);
  step("limits: the organizer is on their own list once it's shown, and is told so", host.length === 1 && /on it themselves, as /.test(shown.list_note ?? ""), JSON.stringify({ host, note: shown.list_note }));
  await events.sweepListNotes({ runtime });
  await new Promise(r => setTimeout(r, 80));
  await events.sweepListNotes({ runtime });
  await new Promise(r => setTimeout(r, 80));
  const asks = (n) => toNum(n).filter(t => /turned on a who's-going list for Limits Lounge/.test(t)).length;
  // Owner decision 2026-11-08: guests who joined while it was private are asked once (gated above).
  step("limits: each of them is asked once, in plain words", asks(AMA) === 1 && asks(KOFI) === 1, JSON.stringify(toNum(AMA).slice(-1)));
  const n1 = fake.sent.length;
  const hid = await tool("event_settings", { event_id: lev.id, event_named: lev.name, guest_list_visible: false }, C.owner);
  await new Promise(r => setTimeout(r, 50));
  step("limits: hiding it again is quiet", hid.ok && !hid.blocked && db.getEventRow(lev.id).guest_list_visible === 0 && fake.sent.length === n1, hid.list_note);
  await tool("event_cancel", { event_id: lev.id, event_named: lev.name }, C.owner);
  clock.reset();
}

// ---- guest questions (src/eventquestions.js): asked on joining, all optional, answers the organizer's alone ----
{
  const qs = await imp("src/eventquestions.js");
  const made = await tool("event_create", { name: "Questions Brunch", description: "x", starts_at: "2027-08-01T11:00", timezone: "America/New_York", location: "3 Elm St", password: "brunch-pw", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true }, C.owner);
  const qev = db.getEventRow(made.event.event_id);
  await tool("event_join", { name: "Questions Brunch", password: "brunch-pw" }, C.ama);
  await new Promise(r => setTimeout(r, 50));
  const n0 = fake.sent.length;
  const add = { event_id: qev.id, event_named: qev.name, action: "add", kind: "choice", prompt: "Any dietary needs?", choices: ["Vegetarian", "Vegan", "No restrictions"] };
  const unasked = await tool("event_questions", add, C.owner);
  step("ask: adding a question by text asks for the yes first, showing what guests see; nothing saved", unasked.blocked === "needs_confirmation" && /pick one: Vegetarian \/ Vegan \/ No restrictions/.test(unasked.asks?.guests_see ?? "") && db.eventQuestions(qev.id).length === 0, unasked.use_target);
  const saved = await withYes(runTool, "event_questions", add, { conversationId: C.owner, messages: [], events: runtime });
  await withYes(runTool, "event_questions", { event_id: qev.id, event_named: qev.name, action: "add", kind: "text", prompt: "Your plus-one's name" }, { conversationId: C.owner, messages: [], events: runtime });
  await new Promise(r => setTimeout(r, 50));
  step("ask: with the yes it's saved, and nobody is texted", saved.ok && db.eventQuestions(qev.id).length === 2 && fake.sent.length === n0, saved.note);
  await withYes(runTool, "event_questions", { event_id: qev.id, event_named: qev.name, action: "add", kind: "text", prompt: "Arriving when?" }, { conversationId: C.owner, messages: [], events: runtime });
  const fourth = await tool("event_questions", { event_id: qev.id, event_named: qev.name, action: "add", kind: "text", prompt: "One more?" }, C.owner);
  step("ask: a fourth question is refused before any yes", fourth.problem === "too_many" && !fourth.blocked, fourth.error);
  const [food, plus, arrive] = qs.questionsOf(qev);
  await tool("event_questions", { event_id: qev.id, event_named: qev.name, action: "remove", question_id: arrive.question_id }, C.owner);
  const qweb = (o) => web({ publicId: qev.public_id, ...o });
  const open = await qweb({});
  step("ask: the join page shows them under the name, all optional", /THE HOST ASKS · ALL OPTIONAL/i.test(open.body) && /Any dietary needs\?/.test(open.body) && !/name="q_\d+"[^>]*required/.test(open.body));
  const NEWQ = "+14155550021";
  const claim = await qweb({ sub: "join", method: "POST", headers: { "x-forwarded-for": "203.0.113.21" }, body: new URLSearchParams({ password: "brunch-pw", display_name: "Nana", [`q_${food.question_id}`]: "1", [`qv_${food.question_id}`]: "1", [`q_${plus.question_id}`]: "Akos", [`qv_${plus.question_id}`]: "1" }).toString() });
  const qcode = decodeURIComponent(/body=([^"]+)"/.exec(claim.body)[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
  await router.deliver({ channel: "fake", externalId: "web-q1", from: NEWQ, text: qcode });
  const nana = db.attendeeRow(qev.id, `dm:fake:${NEWQ}`);
  step("ask: a new guest's page answers reach their row through the finishing text", nana?.state === "joined" && JSON.stringify(db.answersOf(qev.id, nana.id).map(a => a.answer)) === '["Vegan","Akos"]');
  const kofiIn = await tool("event_join", { name: "Questions Brunch", password: "brunch-pw" }, C.kofi);
  step("ask: a text join hands the model the questions, one at a time, all optional", kofiIn.ok && kofiIn.questions?.length === 2 && /every one optional/.test(kofiIn.say) && /ask only the first/.test(kofiIn.say));
  const pick = await tool("event_answer", { event_id: qev.id, event_named: qev.name, question_id: food.question_id, choice: 1 }, C.kofi);
  step("ask: event_answer saves a pick by its number", pick.ok && pick.saved === "Vegetarian", JSON.stringify(pick).slice(0, 120));
  db.startPageSession("drive-q-ama", "drive-session-token-ama-q-0001", { conversationId: C.ama });
  const amaCookie = "reason_page=drive-session-token-ama-q-0001";
  const ch = await qweb({ sub: "answers", method: "POST", headers: { cookie: amaCookie }, body: new URLSearchParams({ [`q_${food.question_id}`]: "2", [`q_${plus.question_id}`]: "Yaw M." }).toString() });
  step("ask: a guest changes their answers on their own page", ch.status === 303 && JSON.stringify(db.answersOf(qev.id, db.attendeeRow(qev.id, C.ama).id).map(a => a.answer)) === '["No restrictions","Yaw M."]');
  // The organizer's own page, drawn as /e/<id> draws it for their browser (the drive's owner has no page session of its own).
  const host = (await imp("src/pages/eventmanage.js")).renderManage({ ev: db.getEventRow(qev.id), conversationId: C.owner });
  const who = (await qweb({ sub: "who", headers: { cookie: amaCookie } })).body + (await qweb({ headers: { cookie: amaCookie } })).body + open.body;
  step("ask: the organizer sees the count per choice and each answer; no guest page shows another's", /ANSWERED · 3 OF 3/.test(host) && /Akos/.test(host) && /Yaw M\./.test(host) && !/Akos/.test(who), "");
  const rw = await tool("event_questions", { event_id: qev.id, event_named: qev.name, action: "change", question_id: plus.question_id, kind: "text", prompt: "Who are you bringing?" }, C.owner);
  const rm = await tool("event_questions", { event_id: qev.id, event_named: qev.name, action: "remove", question_id: plus.question_id }, C.owner);
  step("ask: an answered question can't be reworded; removing it says how many answers go first", rw.problem === "answered" && !rw.blocked && rm.problem === "has_answers" && rm.answers === 2, rm.error);

  // ---- required questions + asking the guests already in (owner decisions 2026-11-11) ----
  const reqIn = { event_id: qev.id, event_named: qev.name, action: "add", kind: "choice", prompt: "Bringing a plus-one?", choices: ["Yes", "No"], required: true };
  const reqAsk = await tool("event_questions", reqIn, C.owner);
  step("ask: a required question's yes names it as required; optional is a different target", reqAsk.blocked === "needs_confirmation" && /, required\) \{/.test(reqAsk.use_target) && reqAsk.asks?.required === true && (await imp("src/eventtools.js")).questionsTarget(C.owner, { ...reqIn, required: false }) !== reqAsk.use_target, reqAsk.use_target);
  const reqSaved = await withYes(runTool, "event_questions", reqIn, { conversationId: C.owner, messages: [], events: runtime });
  const reqQ = qs.questionsOf(qev).find(q => q.required);
  const nReq = fake.sent.length;
  await new Promise(r => setTimeout(r, 50));
  step("ask: saved as required; nobody texted; the note offers to text the guests already in", reqSaved.ok && reqQ && fake.sent.length === nReq && reqSaved.can_ask_guests === 3 && /offer, in one short line/.test(reqSaved.note), reqSaved.note);
  const openReq = await qweb({});
  step("ask: the join page marks it REQUIRED and makes the browser insist; the optional one stays optional", /(THE HOST ASKS|The host asks)<\/p>/.test(openReq.body) && new RegExp(`name="q_${reqQ.question_id}" value="0" required`).test(openReq.body) && /OPTIONAL<\/small>/.test(openReq.body) && !new RegExp(`name="q_${food.question_id}"[^>]*required`).test(openReq.body));
  const blankReq = await qweb({ sub: "join", method: "POST", headers: { "x-forwarded-for": "203.0.113.22" }, body: new URLSearchParams({ password: "brunch-pw", display_name: "Adwoa" }).toString() });
  step("ask: the join page won't go through without the required answer", /the host asks everyone this one before they/.test(blankReq.body) && !/Last step/.test(blankReq.body));
  const yaw0 = toNum(YAW).length;
  const heldJoin = await tool("event_join", { name: "Questions Brunch", password: "brunch-pw" }, C.yaw);
  await new Promise(r => setTimeout(r, 50));
  step("ask: a text join isn't finished until the required one is answered: not in, no welcome, the question handed over", heldJoin.ok === false && heldJoin.reason === "needs_answers" && heldJoin.questions?.length === 1 && heldJoin.questions[0].required === true && /not in yet/.test(heldJoin.error) && db.attendeeRow(qev.id, C.yaw) === null && toNum(YAW).length === yaw0, heldJoin.error);
  const yawIn = await tool("event_join", { name: "Questions Brunch", answers: [{ question_id: reqQ.question_id, choice: 2 }] }, C.yaw);
  await new Promise(r => setTimeout(r, 50));
  const yawRow = db.attendeeRow(qev.id, C.yaw);
  step("ask: answered (no password again) → in, the answer filed, the welcome sent, only optional ones left to ask", yawIn.ok && yawRow?.state === "joined" && JSON.stringify(db.answersOf(qev.id, yawRow.id).map(a => a.answer)) === '["No"]' && toNum(YAW).length > yaw0 && !(yawIn.questions ?? []).some(q => q.required), JSON.stringify(yawIn).slice(0, 160));
  const noClear = await tool("event_answer", { event_id: qev.id, event_named: qev.name, question_id: reqQ.question_id, clear: true }, C.yaw);
  step("ask: a required answer can be changed, never taken back", noClear.ok === false && noClear.problem === "required", noClear.error);
  // Already in and never asked: Ama, Kofi and Nana (Yaw answered to get in). One yes pinned to those three.
  const askIn = { event_id: qev.id, event_named: qev.name, action: "ask_guests", question_id: reqQ.question_id };
  const askFirst = await tool("event_questions", askIn, C.owner);
  step("ask: texting the guests already in asks for the yes with who and the exact text; nothing owed yet", askFirst.blocked === "needs_confirmation" && askFirst.asks?.guests === 3 && /added a question for everyone going to Questions Brunch/.test(askFirst.asks?.text_they_get ?? "") && db.questionAskRows(reqQ.question_id).length === 0, askFirst.use_target);
  const askDone = await withYes(runTool, "event_questions", askIn, { conversationId: C.owner, messages: [], events: runtime });
  const nAsk = fake.sent.length;
  await new Promise(r => setTimeout(r, 50));
  step("ask: with the yes, three are owed to the sweep; nothing goes in the turn", askDone.ok && askDone.asked === 3 && db.questionAskRows(reqQ.question_id).filter(r => r.state === "owed").length === 3 && fake.sent.length === nAsk, askDone.note);
  // Night in the event's zone holds it; the morning sends it once each.
  const toNY = (hour) => { const h = (t) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit" }).format(t)); let t = clock.now() - (clock.now() % 3_600_000) + 3_600_000; for (let i = 0; i < 72 && h(t) !== hour; i++) t += 3_600_000; clock.skip(t - clock.now()); };
  toNY(23);
  const night = await events.sweepQuestionAsks({ runtime });
  await new Promise(r => setTimeout(r, 50));
  step("ask: at night the sweep holds it", night.later === 3 && fake.sent.length === nAsk, JSON.stringify(night));
  toNY(10);
  const morning = await events.sweepQuestionAsks({ runtime });
  await new Promise(r => setTimeout(r, 80));
  const askedTexts = fake.sent.slice(nAsk).filter(m => /added a question for everyone going to Questions Brunch/.test(m.text));
  step("ask: the morning sweep texts each once; a second ask has nobody left", askedTexts.length === 3 && new Set(askedTexts.map(m => m.to)).size === 3 && db.questionAskRows(reqQ.question_id).every(r => r.state === "sent") && (await tool("event_questions", askIn, C.owner)).problem === "nobody_to_ask", JSON.stringify({ morning, to: askedTexts.map(m => m.to) }));
  // Off again goes any time, the answer standing.
  const offAgain = await withYes(runTool, "event_questions", { event_id: qev.id, event_named: qev.name, action: "change", question_id: reqQ.question_id, required: false }, { conversationId: C.owner, messages: [], events: runtime });
  step("ask: making it optional again goes with answers on it, and they stand", offAgain.ok && offAgain.required_change !== true && db.eventQuestion(qev.id, reqQ.question_id).required === 0 && db.questionAnswerCount(reqQ.question_id) === 1, offAgain.note);
  clock.reset();
  await tool("event_cancel", { event_id: qev.id, event_named: qev.name }, C.owner);
}

// ---- paid events (src/eventpay.js, REASON_PAID_EVENTS=on, Stripe = the fake above) ----
{
  clock.reset();
  const eventpay = await imp("src/eventpay.js");
  const stripe = await imp("src/stripe.js");
  const { stripeWebhookRequest } = await imp("src/http.js");
  let evt = 0;
  const webhook = (type, object) => {
    const raw = JSON.stringify({ id: `evt_drive_${++evt}`, type, data: { object } });
    return stripeWebhookRequest({ rawBody: raw, headers: { "stripe-signature": stripe.sign(raw, process.env.STRIPE_WEBHOOK_SECRET, Math.floor(clock.now() / 1000)), "content-type": "application/json" }, runtime });
  };
  const made = await tool("event_create", { name: "Paid Supper", description: "five courses", starts_at: "2027-08-14T19:00", timezone: "America/New_York", location: "9 Pine St", welcome_message: "glad you're coming!", password: "paid-pw", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true }, C.owner);
  const pev = db.getEventRow(made.event.event_id);
  const n0 = fake.sent.length;
  const early = await tool("event_price", { event_id: pev.id, event_named: pev.name, price_dollars: 25 }, C.owner);
  step("pay: a price before payouts gets one Stripe setup link on the events domain and sets nothing", early.ok === false && early.reason === "payouts_setup" && /^https:\/\/connect\.stripe\.test\/setup\/acct_drive_/.test(early.setup_link ?? "") && db.getEventRow(pev.id).price_cents == null
    && stripeCalls.some(c => c.path === "/v1/account_links" && /\/payouts\?back=1$/.test(c.form.return_url) && c.form.return_url.startsWith(events.eventUrl(pev))), JSON.stringify({ reason: early.reason, link: early.setup_link }));
  const acct = eventpay.payoutAccount(C.owner);
  const ready = await webhook("account.updated", { id: acct.stripe_account_id, object: "account", charges_enabled: true, details_submitted: true, payouts_enabled: true });
  await new Promise(r => setTimeout(r, 50));
  step("pay: account.updated with charges on readies payouts and tells the organizer", ready.status === 200 && eventpay.payoutsReady(C.owner) && fake.sent.length > n0 && toNum(OWNER).some(t => /payouts are set up with Stripe/.test(t)), JSON.stringify(ready.body));
  const priced = await tool("event_price", { event_id: pev.id, event_named: pev.name, price_dollars: 25 }, C.owner);
  const qt = eventpay.quote(2500);
  step("pay: $25 a person: guests pay price + Stripe processing, the organizer gets $24.37 (price less 2.5%, rounded)", priced.ok && db.getEventRow(pev.id).price_cents === 2500 && qt.organizer_gets === 2437 && qt.total === 2606 && /You get \$24\.37 per person/.test(priced.per_person ?? ""), priced.per_person);
  const look = await tool("event_lookup", { link: events.eventUrl(pev) }, C.ama);
  step("pay: the price is public on a pasted link, before any password", look.ok && look.event.paid_event === true && /\$25 per person/.test(look.event.price ?? ""), look.event?.price);
  const nA = fake.sent.length;
  const join = await tool("event_join", { name: "Paid Supper", password: "paid-pw" }, C.ama);
  const hold = eventpay.openRow(pev.id, C.ama);
  const cs = stripeCalls.filter(c => c.path === "/v1/checkout/sessions").at(-1);
  step("pay: the right password by text gets the Checkout link and a 15-minute hold, not a join", join.ok && join.payment_required === true && join.joined === false && /^https:\/\/checkout\.stripe\.test\//.test(join.pay_link ?? "") && !!hold && hold.expires_at - hold.created_at === 15 * 60_000 && db.joinedCount(pev.id) === 0 && fake.sent.length === nA, JSON.stringify({ reason: join.reason, link: join.pay_link }));
  step("pay: the Checkout is a destination charge to the organizer's account with Reason's fee, two lines, back to the events domain",
    !!cs && cs.form["payment_intent_data[transfer_data][destination]"] === acct.stripe_account_id && Number(cs.form["payment_intent_data[application_fee_amount]"]) === qt.application_fee
    && Number(cs.form["line_items[0][price_data][unit_amount]"]) === 2500 && Number(cs.form["line_items[1][price_data][unit_amount]"]) === qt.processing && cs.form["line_items[1][price_data][product_data][name]"] === "Processing"
    && cs.form.success_url === `${events.eventUrl(pev)}/paid` && cs.form.cancel_url === `${events.eventUrl(pev)}/pay-back`, JSON.stringify(cs?.form).slice(0, 300));
  const again = await tool("event_join", { name: "Paid Supper", password: "paid-pw" }, C.ama);
  step("pay: asked twice, the same open link comes back (one hold per person)", again.ok && again.pay_link === join.pay_link && eventpay.openHolds(pev.id) === 1, again.pay_link);
  const done = await webhook("checkout.session.completed", { id: hold.checkout_session_id, object: "checkout.session", payment_status: "paid", payment_intent: `pi_drive_${hold.id}`, amount_total: qt.total, client_reference_id: `evpay:${hold.id}`, metadata: { reason_kind: "event_ticket", event_payment_id: String(hold.id) } });
  await new Promise(r => setTimeout(r, 80));
  step("pay: checkout.session.completed does the join: Ama is in, paid, and gets the receipt and the welcome", done.status === 200 && db.attendeeRow(pev.id, C.ama)?.state === "joined" && eventpay.paidRow(pev.id, C.ama)?.status === "paid" && toNum(AMA).some(t => /paid \$26\.06 for Paid Supper — you're in/.test(t)) && toNum(AMA).some(t => /glad you're coming/.test(t)), JSON.stringify(done.body));
  const dup = await webhook("checkout.session.completed", { id: hold.checkout_session_id, object: "checkout.session", payment_status: "paid", payment_intent: `pi_drive_${hold.id}`, client_reference_id: `evpay:${hold.id}` });
  step("pay: the same payment landing again changes nothing", dup.status === 200 && db.joinedCount(pev.id) === 1 && eventpay.paidRows(pev.id).length === 1, JSON.stringify(dup.body));
  // the hold counts against the cap, and is released by the sweep
  await tool("event_settings", { event_id: pev.id, event_named: pev.name, capacity: 2 }, C.owner);
  const kofi = await tool("event_join", { name: "Paid Supper", password: "paid-pw" }, C.kofi);
  const yaw = await tool("event_join", { name: "Paid Supper", password: "paid-pw" }, C.yaw);
  step("pay: a spot being paid for counts against the cap: Kofi's open Checkout makes it full for Yaw", kofi.ok && kofi.payment_required && yaw.ok === false && yaw.reason === "full" && /full right now/.test(yaw.error ?? "") && !/waitlist you|waitlist them/.test(yaw.error ?? ""), yaw.error);
  clock.skip(16 * 60_000);
  const swept = await eventpay.sweep({ log: () => {} });
  const yaw2 = await tool("event_join", { name: "Paid Supper", password: "paid-pw" }, C.yaw);
  step("pay: after 15 minutes the sweep lets the hold go, expires the page on Stripe, and the spot is open again", swept.expired === 1 && eventpay.paymentRow(eventpay.openRow(pev.id, C.kofi)?.id ?? 0) === null && stripeCalls.some(c => /\/expire$/.test(c.path)) && yaw2.ok && yaw2.payment_required === true, JSON.stringify(swept));
  const yawHold = eventpay.openRow(pev.id, C.yaw);
  await webhook("checkout.session.completed", { id: yawHold.checkout_session_id, object: "checkout.session", payment_status: "paid", payment_intent: `pi_drive_${yawHold.id}`, amount_total: qt.total, client_reference_id: `evpay:${yawHold.id}` });
  await new Promise(r => setTimeout(r, 80));
  // a refund by text: the yes first, pinned to the guest and the amount
  const amaId = db.attendeeRow(pev.id, C.ama).id;
  const guests = await tool("event_guests", { event_id: pev.id, event_named: pev.name }, C.owner);
  step("pay: event_guests shows who paid what, and the money on the event", guests.ok && guests.tickets?.paid === 2 && guests.tickets?.gross === "$50" && guests.tickets?.you_get === "$48.74" && guests.guests.find(g => g.guest_id === amaId)?.paid === "$26.06", JSON.stringify(guests.tickets));
  const unasked = await tool("event_refund", { event_id: pev.id, event_named: pev.name, guest_id: amaId }, C.owner);
  step("pay: a refund by text needs the yes, pinned to the guest and the amount; nothing moves first", unasked.blocked === "needs_confirmation" && /^refund \$26\.06 to Ama for Paid Supper/.test(unasked.use_target ?? "") && eventpay.paidRow(pev.id, C.ama)?.status === "paid", unasked.use_target);
  const notPaid = await tool("event_refund", { event_id: pev.id, event_named: pev.name, guest_id: 999999 }, C.owner);
  step("pay: a refund for a guest who isn't there is refused before any yes", notPaid.ok === false && /No guest #999999/.test(notPaid.error ?? ""), notPaid.error);
  const refunded = await withYes(runTool, "event_refund", { event_id: pev.id, event_named: pev.name, guest_id: amaId }, { conversationId: C.owner, messages: [], events: runtime });
  await new Promise(r => setTimeout(r, 80));
  const rf = stripeCalls.filter(c => c.path === "/v1/refunds").at(-1);
  step("pay: with the yes the guest gets everything back (transfer reversed, fee refunded), leaves, and is told", refunded.ok && refunded.refunded === "$26.06" && !!rf && rf.form.reverse_transfer === "true" && rf.form.refund_application_fee === "true" && rf.form.payment_intent === `pi_drive_${hold.id}`
    && db.attendeeRow(pev.id, C.ama)?.state === "left" && eventpay.paidRow(pev.id, C.ama) === null && toNum(AMA).some(t => /refunded your \$26\.06 for Paid Supper/.test(t)), JSON.stringify({ refunded, state: db.attendeeRow(pev.id, C.ama)?.state }));
  const dash = await tool("event_payouts", { event_id: pev.id, event_named: pev.name, action: "dashboard" }, C.owner);
  step("pay: the organizer gets a one-time Stripe Express dashboard link", dash.ok && /^https:\/\/connect\.stripe\.test\/express\//.test(dash.dashboard_link ?? ""), dash.dashboard_link);
  // cancelling refunds everyone who paid, fee included
  const nR = stripeCalls.filter(c => c.path === "/v1/refunds").length;
  const cancelled = await tool("event_cancel", { event_id: pev.id, event_named: pev.name }, C.owner);
  await new Promise(r => setTimeout(r, 80));
  step("pay: cancelling refunds everyone who paid, application fee included, and the guest hears it's cancelled and refunded", cancelled.ok && cancelled.refunds?.refunded === 1 && cancelled.refunds?.failed === 0 && stripeCalls.filter(c => c.path === "/v1/refunds").length === nR + 1 && eventpay.paidRows(pev.id).length === 0 && toNum(YAW).some(t => /is cancelled, so your \$26\.06 has been refunded in full/.test(t)), JSON.stringify(cancelled.refunds));
  clock.reset();
}

// ---- an event's help line (src/eventhelpline.js): one link, a brand-new number served without onboarding ----
{
  const helpline = await imp("src/eventhelpline.js");
  const made = await tool("event_create", { name: "Help Line Night", description: "posh tickets, reason help line", starts_at: "2027-03-06T21:00", timezone: "America/New_York", location: "77 Dock St", password: "harbor", show_time_on_join: true, show_location_on_join: true, guest_list_visible: false }, C.owner);
  const hev0 = db.getEventRow(made.event?.event_id);
  const on = await tool("event_help_line", { event_id: hev0.id, action: "on" }, C.owner);
  await tool("event_help_line", { event_id: hev0.id, action: "ticket_link", ticket_link: "posh.vip/e/help-line-night" }, C.owner);
  const hev = db.getEventRow(hev0.id);
  step("hl: the organizer turns the help line on and gets one link under the event's own /e/ path", on.ok && on.help_line?.help_link === `${events.eventUrl(hev)}/text` && /^[A-HJKMNP-Z2-9]{6}$/.test(hev.help_code ?? ""), on.help_line?.help_link);
  const hweb = (o = {}) => eventRequestFor({ publicId: hev.public_id, method: "GET", query: {}, headers: { "x-files-domain": "true", "x-reason-caddy": process.env.REASON_CADDY_SECRET, "x-forwarded-for": "203.0.113.7", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", ...(o.headers ?? {}) }, remoteAddress: "127.0.0.1", readBody: async () => null, runtime, router, ...o });
  const tp = await hweb({ sub: "text" });
  const first = `Hi! I'm coming to Help Line Night (code ${hev.help_code})`;
  step("hl: /text opens Messages to the line with the first text written, iOS shape, nothing about passwords on it", tp.status === 200 && tp.body.replace(/&amp;/g, "&").replace(/&#39;/g, "'").includes(`&body=${encodeURIComponent(first)}`) && !/password/i.test(tp.body.slice(tp.body.indexOf("<body"))));
  const pub = await hweb({});
  step("hl: the public page shows Get tickets, Get the address and updates, Questions? Text the host; the preview mentions tickets and the text", /Get tickets( →)?</.test(pub.body) && /Get the address and updates( →)?</.test(pub.body) && /Questions\? <a/.test(pub.body) && /og:description" content="Get tickets, then text for the address and updates\."/.test(pub.body) && !/77 Dock/.test(pub.body));
  const HNEW = "+14155550091";
  const before = db.db.prepare("SELECT COUNT(*) AS n FROM access_requests").get().n;
  await router.deliver({ channel: "fake", externalId: "hl-drive-1", from: HNEW, text: first, at: clock.now() });
  await new Promise(r => setTimeout(r, 80));
  const hacct = db.accountByAddress("fake", HNEW);
  step("hl: a brand-new number's code text makes a help-line account — no access request, no onboarding, no card, not 'joined via event'", !!hacct && hacct.helpline_event === hev.id && hacct.joined_via_event == null && (hacct.onboarding ?? null) === null && db.db.prepare("SELECT COUNT(*) AS n FROM access_requests").get().n === before && !fake.sent.some(m => m.to === HNEW && m.mediaUrl), JSON.stringify({ he: hacct?.helpline_event, ob: hacct?.onboarding }));
  const hc = hacct?.conversation_id;
  const pre = await tool("event_help", {}, hc);
  step("hl: before the password the help line has the ticket link and the host, never the address", pre.ok && /posh\.vip\/e\/help-line-night/.test(JSON.stringify(pre)) && !/77 Dock/.test(JSON.stringify(pre)));
  const joined = await tool("event_join", { link: events.eventUrl(hev), password: "harbor", display_name: "Tolu" }, hc);
  const post = await tool("event_help", {}, hc);
  step("hl: with the password from the ticket confirmation they're a guest and the address is theirs", joined.ok && db.attendeeRow(hev.id, hc)?.state === "joined" && /77 Dock/.test(JSON.stringify(post)));
  const asked = await tool("event_help_ask", { question: "can i bring my cousin?" }, hc);
  await new Promise(r => setTimeout(r, 60));
  const toOwner = toNum(OWNER).join("\n");
  const reply = await tool("event_help_reply", { ask_id: asked.ask_id, message: "yes, add her name at the door" }, C.owner);
  await new Promise(r => setTimeout(r, 60));
  step("hl: a question goes to the organizer as '<name> asked …' (no number), the answer comes back as '<host>: …'", asked.ok && /Tolu asked on the Help Line Night help line/.test(toOwner) && !toOwner.includes(HNEW) && reply.ok && toNum(HNEW).includes("Omari: yes, add her name at the door"));
  await tool("event_help_line", { event_id: hev.id, action: "off" }, C.owner);
  step("hl: off — the link 404s and the old code matches nothing", (await hweb({ sub: "text" })).status === 404 && helpline.eventForCode(hev.help_code) === null);
}

const cancel = await tool("event_cancel", { event_id: ev.id, event_named: "Halloween Party" }, C.owner);
step("cancellation reaches every guest", cancel.ok && toNum(AMA).some(t => /is cancelled/.test(t)) && toNum(YAW).some(t => /is cancelled/.test(t)));

await runtime.shutdown?.();
console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
