// The organizer's own event page: /e/{id} opened on the organizer's own browser, as a place to run
// the event — the welcome, a message to everyone, the details, the guests, the password, and the
// rest of what they could already do by texting Reason.
//
// Nothing here decides who may do what, and nothing here changes an event by itself. Every change is
// the text tool's own call (src/eventtools.js runEventTool), as the organizer's conversation, so the
// page and a text do exactly the same thing: the same `managed` door, the same refusals, the same
// words to guests. What guests would be sent is previewed with the same builders the tools send with
// (blastBody, releaseBody, cancelBody, removedBody, planEventUpdate, events.welcomeText), so the
// preview is the text.
//
// Who gets here is decided by src/pages/event.js exactly as for every private event page: the
// browser's page session, then `events.roleIn` for THIS event. Every POST is checked again here —
// organizer of this event, signed in, same origin (the cookie is SameSite=Lax as well) — and anybody
// else gets the same not-found as an address nobody was given.
//
// Every action that texts guests, or cannot be taken back, is two posts: the first shows what will
// happen in a plain sentence (and the exact text, when there is one), the second does it.
import * as db from "../db.js";
import * as events from "../events.js";
import * as tools from "../eventtools.js";
import * as rides from "../eventrides.js";
import * as cover from "../eventcover.js";
import * as albums from "../albums.js";
import * as schedule from "../eventschedule.js";
import * as questions from "../eventquestions.js";
import * as eventpay from "../eventpay.js";
import * as helpline from "../eventhelpline.js";
import { qrSvg } from "./qr.js";
import { madeDoc, esc } from "./made.js";
import { sameOrigin } from "./websignin.js";
import { renderNotFound } from "./render.js";
import { config, clock } from "../config.js";

const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra });
const page = (status, body, extra = {}) => ({ status, headers: HTML({ "Content-Length": Buffer.byteLength(body), ...extra }), body });
const redirect = (location) => ({ status: 303, headers: HTML({ Location: location, "Content-Length": 0 }), body: "" });

const LIMITS = { name: 120, description: 2000, location: 500, welcome: 1000, message: 1500, password: 200, cancel: 500 };

const CSS = `<style>
.mg-hero{display:flex;flex-direction:column;gap:10px}
.mg-hero h1{font-size:38px}
.mg-nav{display:flex;flex-wrap:wrap;gap:8px 18px;margin:0;padding:0;list-style:none}
.mg-nav a{font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:.14em;color:var(--ink);text-decoration:none;min-height:32px;display:inline-flex;align-items:center;border-bottom:1px dotted var(--hair)}
.mg-sec{display:flex;flex-direction:column;gap:14px;scroll-margin-top:16px}
.mg-h{margin:0;font-family:'Reason Serif','Instrument Serif',Georgia,serif;font-style:italic;font-weight:400;font-size:30px;line-height:1.1;letter-spacing:-.01em}
.mg-n{color:var(--pen)}
.mg-p{margin:0;font-size:15px;line-height:1.55}
.mg-f{display:flex;flex-direction:column;gap:14px;margin:0}
.mg-f label{display:flex;flex-direction:column;gap:6px;font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:.14em;color:var(--mut)}
.mg-f input[type=text],.mg-f input[type=password],.mg-f input[type=datetime-local],.mg-f textarea{min-height:44px;border:0;border-bottom:2px solid var(--ink);background:transparent;color:var(--ink);font:16px 'Reason Sans',Inter,system-ui,sans-serif;padding:6px 0;caret-color:var(--pen);border-radius:0;width:100%;letter-spacing:0}
.mg-f textarea{border:1.5px solid var(--hair);border-radius:10px;padding:10px 12px;line-height:1.45;resize:vertical;min-height:110px;background:var(--lift)}
.mg-f input:focus,.mg-f textarea:focus{outline:none;border-color:var(--pen)}
.mg-f .check{flex-direction:row;align-items:flex-start;gap:10px;font-family:'Reason Sans',Inter,system-ui,sans-serif;font-size:14px;letter-spacing:0;color:var(--ink)}
.mg-f .check input{width:20px;height:20px;margin:1px 0 0;accent-color:var(--pen)}
.mg-count{align-self:flex-end;font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:.08em;color:var(--mut);margin-top:-8px}
.mg-count.over{color:var(--pen);font-weight:700}
.mg-row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.mg-row form{margin:0}
.mg-btn{min-height:46px;padding:0 20px;border-radius:999px;border:1.5px solid var(--pen);background:var(--pen);color:#fff;font:600 15px 'Reason Sans',Inter,system-ui,sans-serif;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
.mg-btn.alt{background:transparent;color:var(--ink);border-color:var(--ink)}
.mg-btn.quiet{background:transparent;color:var(--mut);border-color:var(--hair)}
.mg-btn.danger{background:transparent;color:var(--pen);border-color:var(--pen)}
.mg-btn[disabled]{opacity:.45;cursor:default}
.mg-btn.wide{width:100%}
.mg-bubble{margin:0;padding:12px 15px;border-radius:18px 18px 18px 6px;background:var(--lift);border:1px solid var(--hair);font:15px/1.45 'Reason Sans',Inter,system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;max-width:34rem}
.mg-bubble.empty{color:var(--mut);font-style:italic}
.mg-tag{font-family:'Courier New',Courier,monospace;font-size:10px;font-weight:700;letter-spacing:.08em;padding:2px 6px;border-radius:3px;border:1.5px solid var(--mut);color:var(--mut);white-space:nowrap}
.mg-tag.on{border-color:var(--pen);color:var(--pen)}
.mg-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.mg-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-top:1px dashed var(--hair)}
.mg-list li:last-child{border-bottom:1px dashed var(--hair)}
.mg-who{display:flex;flex-direction:column;gap:3px;min-width:0}
.mg-who b{font-weight:600;font-size:16px}
.mg-who span{font-size:13px;color:var(--mut)}
.mg-who a{color:var(--mut)}
.mg-msg{display:flex;flex-direction:column;gap:8px;padding:14px 0;border-top:1px dashed var(--hair)}
.mg-meta{font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:.1em;color:var(--mut)}
.mg-note{margin:0;padding:12px 14px;border-left:3px solid var(--pen);background:var(--lift);font-size:15px;line-height:1.5}
.mg-note.err{border-left-color:var(--pen);color:var(--pen);font-weight:600}
.mg-kv{display:flex;justify-content:space-between;gap:12px;align-items:baseline;font-size:14px}
.mg-kv .lbl{flex:none}
.mg-copy{display:flex;gap:8px;align-items:stretch}
.mg-qr{margin:12px 0 4px}.mg-qr svg{display:block;width:168px;height:168px;background:#fff;padding:8px;border-radius:10px}
.mg-ask{border-top:1px dashed var(--hair);padding-top:10px;margin-top:6px}
.mg-copy input{flex:1;min-width:0;min-height:44px;border:1.5px solid var(--hair);border-radius:10px;padding:0 10px;background:var(--lift);color:var(--ink);font:14px 'Courier New',Courier,monospace}
.mg-secret{font:700 24px 'Courier New',Courier,monospace;letter-spacing:.06em;color:var(--pen);margin:0;overflow-wrap:anywhere}
.mg-cover{display:block;box-sizing:border-box;width:calc(100% - 3px);max-width:420px;aspect-ratio:1200/630;object-fit:cover;background:var(--photo);border:6px solid var(--lift);box-shadow:2px 3px 0 var(--shp)}
.mg-confirm{display:flex;flex-direction:column;gap:18px}
.mg-confirm .mg-h{font-size:34px}
.mg-pick{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;min-width:0}
.mg-pick legend{padding:0;margin:0 0 4px}
.mg-picks{display:flex;flex-direction:column;gap:0;margin:0 0 4px 30px;border-left:1px dashed var(--hair);padding-left:14px}
.mg-picks .check{min-height:40px;align-items:center}
.mg-picks .check small{font-family:'Courier New',Courier,monospace;font-size:10px;letter-spacing:.1em;color:var(--mut);margin-left:auto;padding-left:10px;white-space:nowrap}
.mg-since{margin:0 0 4px 30px}
@supports selector(:has(*)){.mg-pick .mg-picks,.mg-pick .mg-since{display:none}.mg-pick:has(input[value=some]:checked) .mg-picks{display:flex}.mg-pick:has(input[value=since]:checked) .mg-since{display:flex}}
.mg-to{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.mg-to li{padding:6px 12px;border:1.5px solid var(--ink);border-radius:999px;font-size:14px;background:var(--lift)}
.mg-q{display:flex;flex-direction:column;gap:10px;padding:14px 0;border-top:1px dashed var(--hair)}
.mg-q .mg-kv b{font-weight:600;font-size:17px;line-height:1.35}
.mg-tally{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.mg-tally li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;align-items:baseline;font-size:15px}
.mg-tally .bar{grid-column:1/-1;height:6px;border-radius:3px;background:var(--hair);overflow:hidden}
.mg-tally .bar i{display:block;height:100%;background:var(--pen)}
.mg-tally small{grid-column:1/-1;font-size:13px;color:var(--mut)}
.mg-ans{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.mg-ans li{display:flex;gap:12px;padding:8px 0;border-top:1px dotted var(--hair);font-size:15px;line-height:1.45}
.mg-ans li b{flex:none;font-weight:600;min-width:6.5rem}
.mg-ans li span{overflow-wrap:anywhere}
.mg-kind{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.mg-kind legend{padding:0;margin:0 0 4px}
.mg-choices{margin:0}
@supports selector(:has(*)){.mg-qform .mg-choices{display:none}.mg-qform:has(input[name=kind][value=choice]:checked) .mg-choices{display:flex}}
.mg-qprev{display:flex;flex-direction:column;gap:10px;padding:16px;border:1.5px dashed var(--hair);border-radius:12px;background:var(--lift)}
.mg-qprev b{font-size:16px;font-weight:600}
.mg-qprev .line{height:30px;border-bottom:2px solid var(--ink);color:var(--mut);font-size:14px;display:flex;align-items:flex-end;padding-bottom:4px}
details.mg-more>summary{list-style:none;cursor:pointer;font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:.14em;min-height:44px;display:flex;align-items:center}
details.mg-more>summary::-webkit-details-marker{display:none}
@media (min-width:900px){.mg-hero h1{font-size:48px}}
</style>`;

const SCRIPT = `
document.querySelectorAll('[data-count]').forEach(function(t){var o=document.getElementById(t.getAttribute('data-count'));var max=+t.getAttribute('maxlength')||0;function u(){var n=t.value.length;o.textContent=n+' / '+max;o.classList.toggle('over',n>=max)}t.addEventListener('input',u);u()});
var w=document.getElementById('welcome_text'),wp=document.getElementById('welcome_live');
if(w&&wp){var rest=wp.getAttribute('data-rest');function lw(){var v=w.value.trim();wp.textContent=(v?v+'\\n\\n':'')+rest}w.addEventListener('input',lw)}
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var f=document.getElementById(b.getAttribute('data-copy'));var v=f.value!==undefined?f.value:f.textContent;function ok(){var was=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=was},1600)}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(v).then(ok,function(){f.select&&f.select()})}else{f.select&&f.select();try{document.execCommand('copy');ok()}catch(e){}}})});
document.querySelectorAll('.mg-pick').forEach(function(fs){function pick(v){var r=fs.querySelector('input[name=to][value='+v+']');if(r)r.checked=true}fs.querySelectorAll('.mg-picks input').forEach(function(c){c.addEventListener('change',function(){if(c.checked)pick('some')})});var s=fs.querySelector('.mg-since input');if(s)s.addEventListener('input',function(){if(s.value)pick('since')})});
document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){if(f.dataset.sent){e.preventDefault();return}f.dataset.sent='1';var b=e.submitter||f.querySelector('button[type=submit]');if(b&&b.getAttribute('data-busy')){b.textContent=b.getAttribute('data-busy')}setTimeout(function(){b&&(b.disabled=true)},0)})});
var pq=document.getElementById('price_in'),po=document.getElementById('price_quote');
if(pq&&po){function money(c){var s=(Math.round(c)/100).toFixed(2);return '$'+(s.slice(-3)==='.00'?s.slice(0,-3):s)}function lq(){var m=/^\\s*\\$?\\s*(\\d{1,6})(?:\\.(\\d{1,2}))?\\s*$/.exec(pq.value);if(!m){po.textContent='';return}var p=+m[1]*100+ +((m[2]||'').padEnd(2,'0'));if(p<${eventpay.MIN_PRICE_CENTS}||p>${eventpay.MAX_PRICE_CENTS}){po.textContent='From $5 to $500 per person.';return}var t=Math.ceil((p+${eventpay.STRIPE_FIXED_CENTS})*10000/(10000-${eventpay.STRIPE_RATE_BPS}));var fee=Math.round(p*${eventpay.APP_FEE_BPS}/10000);po.textContent='Guests pay '+money(t)+' ('+money(p)+' + '+money(t-p)+' processing). You get '+money(p-fee)+' per person.'}pq.addEventListener('input',lq);lq()}
`;

const managePath = (ev) => `/e/${ev.public_id}/manage`;
const homePath = (ev) => `/e/${ev.public_id}`;
const p = (s, cls = "mg-p") => `<p class="${cls}">${esc(s)}</p>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value ?? "")}">`;
const button = (label, { cls = "mg-btn", busy = "", name = "", value = "", disabled = false } = {}) =>
  `<button class="${cls}" type="submit"${busy ? ` data-busy="${esc(busy)}"` : ""}${name ? ` name="${esc(name)}" value="${esc(value)}"` : ""}${disabled ? " disabled" : ""}>${esc(label)}</button>`;
const form = (action, step, inner, extra = "") => `<form class="mg-f" method="POST" action="__ACTION__"${extra}>${hidden("action", action)}${step ? hidden("step", step) : ""}${inner}</form>`;
const bubble = (text) => `<p class="mg-bubble">${esc(text)}</p>`;
const counter = (id, value, max) => `<span class="mg-count" id="${id}" aria-live="polite">${String(value ?? "").length} / ${max}</span>`;
const noteHtml = (n) => n?.text ? `<p class="mg-note${n.error ? " err" : ""}" role="status">${esc(n.text)}</p>` : "";
/** A section, with the note about what was just done in it (or what went wrong) right under its label, where the page lands. */
const section = (id, n, title, inner, notice = null) => `<section class="mg-sec dash" id="${id}"><p class="lbl"><span class="mg-n">${n}</span> · ${esc(title.toUpperCase())}</p>${notice?.section === id ? noteHtml(notice) : ""}${inner}</section>`;

/** A guest's way in, as the organizer reads it. */
const VIA = { text: "joined by text", link: "joined from a pasted link", web: "joined on the join page", web_text: "joined on the join page" };
const KIND = { blast: "Message to everyone", update: "Update", release: "Shared detail", cancel: "Cancellation", scheduled: "Scheduled message", reminder: "Reminder" };
/** A sent message's label in the history: who it went to, when it was only some guests. */
const kindLabel = (ev, m) => m.audience && (m.kind === "blast" || m.kind === "scheduled")
  ? `${m.kind === "blast" ? "Message" : "Scheduled message"} to ${events.audienceLabel(ev, m.audience)}` : (KIND[m.kind] ?? m.kind);

// ---------------------------------------------------------------- only some guests

/** "Ama", "Ama and Kofi", "Ama, Kofi and Esi". */
const andList = (names) => names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * Who the organizer picked on a form: everyone (`to` everyone, or nothing), the guests they ticked
 * (`to` some, one `g` per guest — or the ids joined with commas, as a confirm step carries them), or
 * the guests who joined since a time (`to` since, `joined_after`). The draft puts the form back as it
 * was; `pick` is events.pickAudience's answer.
 */
function readPick(ev, f) {
  const to = f.get("to") === "some" ? "some" : f.get("to") === "since" ? "since" : "everyone";
  const ids = f.getAll("g").flatMap(v => String(v).split(",")).map(v => Number.parseInt(v, 10)).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
  const joinedAfter = String(f.get("joined_after") ?? "").trim().slice(0, 40);
  const draft = { to, g: ids, joined_after: joinedAfter };
  const pick = to === "some" ? events.pickAudience(ev, { guestIds: ids }) : to === "since" ? events.pickAudience(ev, { joinedAfter: joinedAfter || null }) : { ok: true, audience: null };
  // "Since" with no time ticked is no pick at all, not everyone.
  if (to === "since" && !joinedAfter) return { draft, pick: { ok: false, reason: "bad_time" } };
  return { draft, pick };
}
const PICK_OOPS = {
  none_picked: "Tick at least one guest, or send it to everyone.",
  not_guests: "One of the guests you picked isn't on the event any more. Check the list and pick again.",
  bad_time: "Pick the date and time they joined since.",
  both: "Pick guests by name or by when they joined, not both.",
};
/** The pick, as hidden fields a confirm step carries forward. */
const pickFields = (draft) => ({ to: draft.to, ...(draft.to === "some" ? { g: draft.g.join(",") } : {}), ...(draft.to === "since" ? { joined_after: draft.joined_after } : {}) });
/**
 * A fingerprint of exactly who a pick reaches right now. The confirm step carries it, and the send
 * step checks it again: if somebody the pick reaches joined, left or muted the event in between, the
 * organizer is shown the new list instead of it going to people they didn't see.
 */
const reachPin = (ev, audience, kind) => events.audience(ev, kind, audience).ids.join(".") || "none";

/** The "who gets it" choice on a message form. Only joined guests can be picked. */
function whoPicker(ev, prefix, draft = {}) {
  const joined = events.guestList(ev).filter(g => g.state === "joined");
  const all = events.audience(ev, "blast");
  const to = draft.to ?? "everyone";
  const ticked = new Set((draft.g ?? []).map(Number));
  const radio = (value, label, extra = "") => `<label class="check"><input type="radio" name="to" value="${value}"${to === value ? " checked" : ""}${extra}> <span>${label}</span></label>`;
  if (!joined.length) return hidden("to", "everyone");
  return `<fieldset class="mg-pick"><legend class="lbl">WHO GETS IT</legend>`
    + radio("everyone", esc(`Everyone · ${plural(all.guests, "guest")}`))
    + radio("some", "Only guests I pick")
    + `<div class="mg-picks" role="group" aria-label="Guests to send it to">${joined.map(g => `<label class="check"><input type="checkbox" name="g" value="${g.guest_id}"${ticked.has(g.guest_id) ? " checked" : ""}> <span>${esc(g.display_name || "A guest")}</span><small>${esc(`JOINED ${when(ev, Date.parse(g.joined)).toUpperCase()}`)}</small></label>`).join("")}</div>`
    + radio("since", "Guests who joined since…")
    + `<label class="mg-since" for="${prefix}_since">JOINED ON OR AFTER (${esc(ev.tz.replace(/_/g, " ").toUpperCase())} TIME)<input id="${prefix}_since" name="joined_after" type="datetime-local" value="${esc(draft.joined_after ?? "")}"></label>`
    + `</fieldset>`;
}

/** Who gets it, on a confirm step: the count, and for a pick each name. */
function whoSentences(ev, audience, reach, { later = false } = {}) {
  if (!audience) return [];
  const a = events.parseAudience(audience);
  const names = andList(reach.names);
  const first = !reach.guests ? "None of the guests you picked can get it right now."
    : !later ? `Only ${plural(reach.guests, "guest")} ${reach.guests === 1 ? "gets" : "get"} it: ${names}. Nobody else on the event does.`
    : a.joined_since != null ? `It goes only to guests who joined since then. Right now that's ${plural(reach.guests, "guest")}: ${names}.`
    : `It goes only to ${plural(reach.guests, "guest")}: ${names}. Nobody else on the event will get it.`;
  return [
    first,
    ...(later && a.joined_since != null ? ["Anybody else who joins before it goes gets it too, and anybody who leaves won't."] : []),
    ...(later && a.guests ? ["If one of them leaves before then, they won't get it."] : []),
    ...(reach.muted ? [`${plural(reach.muted, "guest")} you picked muted the event and won't get it.`] : []),
  ];
}
/** The pick, as the text tool takes it: the same ids, or the same wall-clock time, the organizer chose. */
const pickInput = (draft, audience) => {
  const a = events.parseAudience(audience);
  if (!a) return {};
  return a.guests ? { only_guest_ids: a.guests } : { only_joined_after: draft.joined_after };
};
/** A waiting message's pick, back as a form draft (to change it). */
function draftOf(ev, audience) {
  const a = events.parseAudience(audience);
  if (!a) return { to: "everyone" };
  return a.guests ? { to: "some", g: a.guests } : { to: "since", joined_after: schedule.localInput(ev, a.joined_since) };
}
const whoList = (reach) => reach.guests ? `<p class="lbl">${esc(`WHO GETS IT · ${reach.guests}`)}</p><ul class="mg-to">${reach.names.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : "";

/** What a new guest is sent on joining, for the preview. Their own who's-going link differs per guest. */
function welcomePreview(ev, welcome) {
  const sample = { token: "PREVIEW", display_name: "", in_directory: 1, instagram: null, muted: 0, state: "joined" };
  const text = events.welcomeText({ ...ev, welcome }, sample);
  return text.split(events.directoryUrl(ev, sample)).join("[their own who's-going link]");
}

/** The event as the page needs it, with the organizer's link in it so the tool's which-event check names exactly this one. */
const toolInput = (ev, more = {}) => ({ event_id: ev.id, event_named: events.eventUrl(ev), ...more });

function when(ev, at) {
  return new Date(at).toLocaleString("en-US", { timeZone: ev.tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function deliveryLine(m) {
  if (!m.total) return "Nobody was on the event yet";
  const bits = [`Reached ${m.sent} of ${m.total}`];
  if (m.sending) bits.push(`${m.sending} still sending`);
  if (m.held) bits.push(`${m.held} waiting while the event is paused`);
  if (m.failed) bits.push(`${m.failed} didn't go through`);
  return bits.join(" · ");
}

/** The fixed sentences a finished action lands back on the page with. Numbers only ever come from the query. */
const DONE_SECTION = { welcome: "welcome", welcome_cleared: "welcome", blast: "message",
  scheduled: "schedule", sched_changed: "schedule", sched_cancelled: "schedule", reminder_on: "schedule", reminder_off: "schedule", details: "details", details_quiet: "details", nothing: "details", release: "details", removed: "guests", list_shown: "guests", list_hidden: "guests", cap_saved: "guests", nothing_cap: "guests", rides_on: "more", rides_off: "more", cover_removed: "more", cover_discarded: "more",
  question_added: "questions", question_reworded: "questions", question_removed: "questions", question_required: "questions", question_optional: "questions", question_asked: "questions", question_not_asked: "questions",

  price_saved: "money", price_free: "money", refunded: "money", payouts_ready: "money", payouts_pending: "money",
  help_on: "help", help_off: "help", help_ticket: "help", help_ticket_cleared: "help", help_host: "help", help_replied: "help" };
function doneNote(q, ev) {
  const n = (k) => Math.max(0, Math.min(100000, Number.parseInt(q[k] ?? "0", 10) || 0));
  const reached = () => (n("g") ? `Reached ${n("n")} of ${n("g")}${n("f") ? `; ${n("f")} didn't go through` : ""}.` : "Nobody has joined yet, so nobody was texted.");
  switch (q.done) {
    case "welcome": return "Welcome saved. New guests get it when they join.";
    case "welcome_cleared": return "Welcome cleared. New guests get just the event's details when they join.";
    case "blast": return `Sent. ${reached()}`;
    case "details": return n("g") ? `Saved, and guests were told. ${reached()}` : "Saved.";
    case "details_quiet": return "Saved quietly. That detail is still hidden from guests, so nobody was texted.";
    case "nothing": case "nothing_cap": return "Nothing changed.";
    case "release": return `Shared with guests. ${reached()}`;
    case "removed": return "Taken off the event. They were told, and they can't rejoin with the password.";
    case "list_shown": return `Guests can see who's going now.${n("n") ? ` Reason is asking ${plural(n("n"), "guest")} who joined while it was private whether they want to be on it.` : ""}`;
    case "list_hidden": return "The guest list is private now. Nobody was texted.";
    case "cap_saved": {
      // Read off the event as it is now, never off the address.
      const st = ev ? events.capacityState(ev) : null;
      if (!st || st.capacity == null) return "No cap now. Anyone with the link and the password can join.";
      if (st.over) return `Saved. ${st.going} are already in, more than ${st.capacity}. Nobody was taken off, and new joins are closed until enough guests leave to get under ${st.capacity}.`;
      if (st.full) return "Saved. That's exactly how many are in, so new joins are closed. Nobody was taken off.";
      return `Saved. Room for ${plural(st.capacity - st.going, "more guest")}.`;
    }
    case "question_added": return `Added. New guests see it when they join, and nobody was texted.${n("g") ? ` The ${plural(n("g"), "guest")} already in can answer it on their event page.` : ""}`;
    case "question_reworded": return "Reworded. Nobody had answered it yet, and nobody was texted.";
    case "question_required": return "Saved. Everyone joining from now on answers it first. Guests already in aren't held to it, and nobody was texted.";
    case "question_optional": return "Saved. It's optional now; answers already given stand. Nobody was texted.";
    case "question_asked": return `Asked. Reason texts the ${plural(n("n"), "guest")} already in about it — not at night, and never twice. Their answers show up here.`;
    case "question_not_asked": return `Added. Nobody was texted; the ${plural(n("g"), "guest")} already in can answer it on their event page.`;
    case "question_removed": return `Removed. New guests aren't asked it.${n("n") ? ` ${plural(n("n"), "answer")} went with it.` : ""}`;
    case "rides_on": return "Ride sharing is on. Reason asks each guest once, the day before.";
    case "rides_off": return "Ride sharing is off.";
    case "cover_removed": return "The link's card is back to Reason's drawn cover.";
    case "cover_discarded": return "The waiting picture was dropped. The card is what it was.";
    case "scheduled":
    case "sched_changed": {
      // The time is read off the row this event owns, never off the address: nothing typed is echoed.
      const row = ev ? schedule.pendingFor(ev).find(m => m.id === n("s")) : null;
      return `${q.done === "scheduled" ? "Scheduled" : "Changed"}.${row ? ` It goes ${row.when}.` : ""} You can change or cancel it below until then.`;
    }
    case "sched_cancelled": return "Cancelled. Nobody was texted.";
    case "reminder_on": return "Reminder on.";
    case "reminder_off": return "Reminder off. Guests won't get that one.";
    // Tickets (src/eventpay.js): read off the event as it is now, never off the address.
    case "help_on": return "The help line is on. Put the link on your ticket page and socials; it's also on your event page now.";
    case "help_off": return "The help line is off. The old link and code stop working; turning it on again makes a new one.";
    case "help_ticket": return "Saved. Your event page shows Get tickets.";
    case "help_ticket_cleared": return "Ticket link removed.";
    case "help_host": return "Saved. The help line says it's run for that name.";
    case "help_replied": return "Sent. They got your answer in their texts.";
    case "price_saved": return ev && eventpay.priced(ev) ? `Set. ${eventpay.organizerPriceLine(ev.price_cents)} Guests who join from now on pay on a Stripe page; nobody already in is charged.` : "Saved.";
    case "price_free": return "Free to join from now on. Guests who already paid keep their spot and aren't refunded by this.";
    case "refunded": return "Refunded in full, including processing. They're off the event and were told; the money shows on their card in a few days.";
    case "payouts_ready": return "Payouts are set up with Stripe. You can put a price on this event now.";
    case "payouts_pending": return "Stripe hasn't finished setting up your payouts yet. Finish the steps with the button below, or come back in a few minutes if you did.";
    default: return "";
  }
}

// ---------------------------------------------------------------- tickets and payouts (src/eventpay.js)

/**
 * The organizer's money on this event: payouts setup (Stripe's own onboarding, one link), the price
 * per person with what guests pay and what they get, how many paid and the totals, one refund per
 * guest behind a confirm step, and their Stripe Express dashboard. Shown only where a price could be
 * set, or on an event that already has one.
 */
function ticketsSection(ev, { conversationId, drafts, sec, paused }) {
  const acct = eventpay.payoutAccount(conversationId);
  const ready = !!acct?.charges_enabled;
  const priced = eventpay.priced(ev);
  const s = eventpay.summary(ev);
  const setupBtn = (label) => `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "payouts")}${hidden("step", "do")}<div class="mg-row">${button(label, { busy: "Opening Stripe…" })}</div></form>`;
  let body;
  if (!ready) {
    body = p(acct
      ? "You started setting up payouts with Stripe but it isn't finished. Finish the steps and the price can be set right after."
      : "Charge guests to join. Guests pay on Stripe's secure page (Apple Pay works) and are on the event once the payment goes through. The money goes to your own Stripe account — set up once, a few minutes — and Reason keeps 2.5% of the price. Guests pay Stripe's processing on top, so your price is what you set.")
      + setupBtn(acct ? "Finish setting up payouts" : "Set up payouts with Stripe")
      + p("Stripe asks for your name, your bank and a few details. Reason never sees your bank; Stripe holds it.", "quiet");
  } else {
    const priceDraft = drafts.price ?? (priced ? String(ev.price_cents / 100).replace(/\.00$/, "") : "");
    const guests = eventpay.paidGuests(ev);
    const failed = guests.filter(g => g.refund_error);
    body = `<div class="mg-kv"><span class="quiet">${esc(priced ? eventpay.organizerPriceLine(ev.price_cents) : "Free to join. Set a price per person and guests pay on Stripe's page when they join.")}</span><span class="mg-tag${priced ? " on" : ""}">${esc(priced ? `${eventpay.dollars(ev.price_cents).toUpperCase()} PER PERSON` : "FREE")}</span></div>`
      + (paused ? p("Paused by Reason's operator, so the price can't change right now.", "quiet")
        : form("price", "review", `<label for="price_in">PRICE PER PERSON · $5 TO $500<input id="price_in" name="price" type="text" inputmode="decimal" autocomplete="off" maxlength="9" placeholder="25" value="${esc(priceDraft)}"></label>`
          + `<p class="quiet" id="price_quote" aria-live="polite"></p>`
          + `<div class="mg-row">${button(priced ? "Change the price" : "Set the price", { busy: "Checking…" })}${priced ? `</div></form><form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "free")}${hidden("step", "review")}<div class="mg-row">${button("Make it free again", { cls: "mg-btn quiet", busy: "Opening…" })}` : ""}</div>`))
      + (priced || s.paid_count
        ? `<p class="lbl" style="margin-top:8px">SO FAR</p>`
          + `<div class="mg-kv"><span class="lbl">PAID</span><span>${esc(plural(s.paid_count, "guest"))}${s.open_holds ? ` · ${esc(plural(s.open_holds, "spot"))} held while someone pays` : ""}</span></div>`
          + `<div class="mg-kv"><span class="lbl">GROSS</span><span>${esc(eventpay.dollars(s.gross_cents))}</span></div>`
          + `<div class="mg-kv"><span class="lbl">YOU GET</span><span>${esc(eventpay.dollars(s.organizer_net_cents))}${s.refunded_count ? ` · ${esc(plural(s.refunded_count, "refund"))}` : ""}</span></div>`
          + (guests.length
            ? `<p class="lbl" style="margin-top:8px">WHO PAID</p><ul class="mg-list">${guests.map(g => `<li><div class="mg-who"><b>${esc(g.display_name || "A guest")}</b><span>${esc(`paid ${eventpay.dollars(g.total_cents)} · ${when(ev, g.paid_at)}${g.refund_error ? " · the last refund didn't go through" : ""}`)}</span></div>`
              + `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "refund")}${hidden("step", "review")}${hidden("payment", g.payment_id)}${button(g.refund_error ? "Retry refund" : "Refund", { cls: "mg-btn quiet", busy: "…" })}</form></li>`).join("")}</ul>`
              + p("A refund gives them everything back, processing included, and takes them off the event. Cancelling the event refunds everyone.", "quiet")
            : p("Nobody has paid yet.", "quiet"))
          + (failed.length ? `<p class="mg-note err">${esc(`${plural(failed.length, "refund")} didn't go through on Stripe's side. Retry above, or check your Stripe dashboard.`)}</p>` : "")
        : "")
      + `<p class="lbl" style="margin-top:8px">YOUR STRIPE ACCOUNT</p>`
      + p("Your balance, payouts to your bank and every payment are in your Stripe dashboard. Stripe pays out on its own schedule.")
      + `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "dashboard")}${hidden("step", "do")}<div class="mg-row">${button("Open your Stripe dashboard", { cls: "mg-btn alt", busy: "Opening…" })}</div></form>`;
  }
  return sec("money", "07", "Tickets", `<h2 class="mg-h">${esc(priced ? `${eventpay.dollars(ev.price_cents)} a person` : "Tickets")}</h2>` + body);
}

/** One reminder's state, in a sentence the organizer reads. */
function reminderSentence(r) {
  switch (r.state) {
    case "off": return r.when ? `Off. If it were on, it would go ${r.when}.` : "Off.";
    case "no_time": return "The event has no start time, so there's nothing to remind guests about.";
    case "time_hidden": return `${r.on ? "On" : "Off"}, but guests can't see the time yet, so it can't go. Share the time with guests before ${r.when} and it goes then.`;
    case "night": return `Skipped for this event: ${r.when} is the middle of the night there. The day-before reminder covers it.`;
    case "sent": return r.sent ? `Went out. ${deliveryLine(r.sent)}.` : "Went out.";
    case "too_late": return "Its time has already passed for this event, so it won't go.";
    case "upcoming": return `On. It goes ${r.when} to everyone on the event then.`;
    default: return "";
  }
}

/** The "later" section: schedule a message, what's waiting (change or cancel it), what didn't go, the two reminders. */
function scheduleSection(ev, { query, drafts, paused, sec }) {
  const aud = events.audience(ev, "scheduled");
  const waiting = schedule.pendingFor(ev);
  const missed = schedule.missedFor(ev);
  // Changing one: picked by its number off this event's own waiting list, so another event's never shows.
  const editId = Number.parseInt(query.edit ?? drafts.schedule?.id ?? "", 10);
  const editing = Number.isInteger(editId) ? waiting.find(m => m.id === editId) ?? null : null;
  const d = drafts.schedule ?? (editing ? { message: editing.message, send_at: editing.local, ...draftOf(ev, editing.audience) } : {});
  const minAt = schedule.localInput(ev, clock.now() + schedule.SCHEDULE.minAheadMs);
  const scheduleForm = paused ? p("Paused by Reason's operator, so nothing can be scheduled right now.", "quiet")
    : form("schedule", "preview",
      (editing ? hidden("id", editing.id) + `<p class="mg-note">Changing the message set for ${esc(editing.when)}.</p>` : "")
      + `<label for="sched_text">YOUR MESSAGE<textarea id="sched_text" name="message" maxlength="${LIMITS.message}" data-count="sched_count" rows="4" required>${esc(d.message ?? "")}</textarea></label>`
      + counter("sched_count", d.message ?? "", LIMITS.message)
      + `<label for="sched_at">SEND IT AT (${esc(ev.tz.replace(/_/g, " ").toUpperCase())} TIME)<input id="sched_at" name="send_at" type="datetime-local" min="${esc(minAt)}" required value="${esc(d.send_at ?? "")}"></label>`
      + whoPicker(ev, "sched", d)
      + `<div class="mg-row">${button(editing ? "Preview the change" : "Preview message", { busy: "Opening preview…" })}${editing ? `<a class="mg-btn quiet" href="${esc(`${homePath(ev)}#schedule`)}">Stop changing it</a>` : ""}</div>`);
  const row = (m) => `<div class="mg-msg"><span class="mg-meta">${esc((m.audience ? `Goes ${m.when} · to ${m.to}: ${m.reach.names.join(", ") || "nobody right now"}` : `Goes ${m.when} · ${plural(aud.guests, "guest")} on it now`).toUpperCase())}</span>${bubble(m.preview)}`
    + `<div class="mg-row"><a class="mg-btn alt" href="${esc(`${homePath(ev)}?edit=${m.id}#schedule`)}">Change</a>`
    + `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "sched_cancel")}${hidden("step", "review")}${hidden("id", m.id)}${button("Cancel it", { cls: "mg-btn quiet", busy: "Opening…" })}</form></div></div>`;
  const reminderRow = (r) => {
    const toggle = r.state === "sent" || r.state === "no_time" || paused ? ""
      : `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "reminder")}${hidden("which", r.which)}${hidden("step", r.on ? "do" : "review")}${hidden("enabled", r.on ? "0" : "1")}<div class="mg-row">${button(r.on ? "Turn it off" : "Turn it on", { cls: "mg-btn alt", busy: "Saving…" })}</div></form>`;
    return `<div class="mg-msg"><div class="mg-kv"><span class="lbl">${esc(r.label.toUpperCase())}</span><span class="mg-tag${r.on ? " on" : ""}">${r.on ? "ON" : "OFF"}</span></div>`
      + p(reminderSentence(r)) + (r.preview ? bubble(r.preview) : "") + toggle + `</div>`;
  };
  return sec("schedule", "03", "Later",
    `<h2 class="mg-h">Send it later</h2>`
    + p(`Write a message and pick when it goes. It goes to everyone on the event at that moment${aud.muted ? ", except guests who muted it" : ""}, or only to the guests you pick, and you'll see exactly how it reads and who gets it before it's set.`)
    + scheduleForm
    + `<p class="lbl" style="margin-top:8px">WAITING TO GO</p>`
    + (waiting.length ? waiting.map(row).join("") : p("Nothing scheduled.", "quiet"))
    + missed.map(m => `<div class="mg-msg"><span class="mg-meta">${esc(`Didn't go · was set for ${m.when}`.toUpperCase())}</span>${bubble(m.preview)}${p(m.why === "the event was paused when it was due" ? "The event was paused when it was due, so it was dropped rather than sent late." : "Reason couldn't send it on time, so it was dropped rather than sent late.", "quiet")}</div>`).join("")
    + `<p class="lbl" style="margin-top:8px">AUTOMATIC REMINDERS</p>`
    + p("Reason texts guests a short reminder with the time, and the place once you've shared it. Turn each one on or off.")
    + schedule.reminders(ev).map(reminderRow).join(""));
}

// ---------------------------------------------------------------- who sees the list, and how many can join

/**
 * The two settings an organizer can change after the event is made (owner request 2026-11-08): who
 * sees the guest list, and the cap. Showing a private list asks the guests who joined while it was
 * private (a confirm step with the text); hiding it and changing the cap text nobody.
 */
function listAndCap(ev, { going, drafts }) {
  const shownNow = !!ev.guest_list_visible;
  const st = events.capacityState(ev);
  const capTag = st.capacity == null ? "NO CAP" : st.full ? `FULL · ${st.going} OF ${st.capacity}` : `${st.going} OF ${st.capacity}`;
  const capSentence = st.capacity == null ? "No cap: anyone with the link and the password can join."
    : st.over ? `${plural(st.going, "guest")} in, more than your cap of ${st.capacity}. Nobody is taken off; new joins stay closed until enough guests leave to get under ${st.capacity}.`
    : st.full ? `Full: ${plural(st.going, "guest")} in, your cap is ${st.capacity}. New joins are closed. If someone leaves, a spot opens.`
    : `Up to ${st.capacity} guests. ${going} in, room for ${st.capacity - going} more.`;
  const capDraft = drafts.cap ?? (st.capacity ?? "");
  return `<p class="lbl" style="margin-top:8px">WHO SEES THE GUEST LIST</p>`
    + `<div class="mg-kv"><span class="quiet">${esc(shownNow ? "Guests see who's going (only people who chose to be on it)." : "Private: guests don't see who else is going.")}</span><span class="mg-tag${shownNow ? " on" : ""}">${shownNow ? "SHOWN TO GUESTS" : "PRIVATE"}</span></div>`
    + `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "list")}${hidden("step", "review")}${hidden("visible", shownNow ? "0" : "1")}<div class="mg-row">${button(shownNow ? "Make the list private" : "Show the list to guests", { cls: "mg-btn alt", busy: "Opening…" })}</div></form>`
    + `<p class="lbl" style="margin-top:8px">HOW MANY CAN JOIN</p>`
    + `<div class="mg-kv"><span class="quiet">${esc(capSentence)}</span><span class="mg-tag${st.full ? " on" : ""}">${esc(capTag)}</span></div>`
    + form("cap", "review", `<label for="cap_n">CAP · LEAVE EMPTY FOR NO CAP<input id="cap_n" name="capacity" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" value="${esc(capDraft)}"></label>`
      + `<div class="mg-row">${button("Save cap", { cls: "mg-btn alt", busy: "Checking…" })}</div>`)
    + p("Guests never see the cap, and changing it never texts anyone. Lowering it below the number already in takes nobody off.", "quiet");
}

// ---------------------------------------------------------------- guest questions

/** A question's form: the words, free text or pick one, and the choices (one per line). `q` is a draft or the saved question. */
function questionForm(q = {}, { qid = null, label = "Preview question" } = {}) {
  const kind = q.kind === "choice" ? "choice" : "text";
  const choices = Array.isArray(q.choices) ? q.choices.join("\n") : String(q.choices ?? "");
  const id = qid ?? "new";
  return `<form class="mg-f mg-qform" method="POST" action="__ACTION__">${hidden("action", "question")}${hidden("step", "review")}${qid != null ? hidden("qid", qid) : ""}`
    + `<label for="q_prompt_${id}">THE QUESTION<input id="q_prompt_${id}" name="prompt" type="text" maxlength="${questions.LIMITS.prompt}" required value="${esc(q.prompt ?? "")}" placeholder="Any dietary needs?"></label>`
    + `<fieldset class="mg-kind"><legend class="lbl">GUESTS ANSWER BY</legend>`
    + `<label class="check"><input type="radio" name="kind" value="text"${kind === "text" ? " checked" : ""}> <span>Typing a short answer</span></label>`
    + `<label class="check"><input type="radio" name="kind" value="choice"${kind === "choice" ? " checked" : ""}> <span>Picking one of a few choices</span></label></fieldset>`
    + `<label class="mg-choices" for="q_choices_${id}">THE CHOICES · ONE PER LINE, ${questions.LIMITS.choicesMin} TO ${questions.LIMITS.choicesMax}<textarea id="q_choices_${id}" name="choices" rows="4" maxlength="400" placeholder="${esc("Vegetarian\nVegan\nNo restrictions")}">${esc(choices)}</textarea></label>`
    + `<label class="check mg-req"><input type="checkbox" name="required" value="1"${q.required ? " checked" : ""}> <span>Everyone has to answer this one to join</span></label>`
    + `<div class="mg-row">${button(label, { busy: "Opening preview…" })}</div></form>`;
}

/** How guests see one question, for the confirm step. */
function questionPreview(q) {
  return `<div class="mg-qprev"><p class="lbl">GUESTS SEE · ${q.required ? "REQUIRED" : "OPTIONAL"}</p><b>${esc(q.prompt)}</b>`
    + (q.kind === "choice" ? `<ul class="mg-to">${q.choices.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : `<span class="line">Their answer</span>`)
    + `</div>`;
}

/**
 * 06 · Guest questions (owner request 2026-11-08): up to three, every one optional for guests, the
 * answers only for the organizer — per question, how many answered, the count per choice, and each
 * answer with the guest's name. A question can be reworded until somebody answers it.
 */
function questionsSection(ev, { drafts }) {
  const list = questions.organizerSummary(ev);
  const draft = drafts.question ?? null;
  const items = list.map(q => {
    const pct = (k) => (q.answered ? Math.round((k / q.answered) * 100) : 0);
    const body = q.kind === "choice"
      ? `<ul class="mg-tally">${q.tally.map(t => {
        const who = q.answers.filter(a => a.answer === t.choice).map(a => a.name);
        return `<li><span>${esc(t.choice)}</span><span class="mg-meta">${esc(String(t.count))}</span><span class="bar" aria-hidden="true"><i style="width:${pct(t.count)}%"></i></span>${who.length ? `<small>${esc(andList(who.slice(0, 12)))}${who.length > 12 ? ` +${who.length - 12}` : ""}</small>` : ""}</li>`;
      }).join("")}</ul>`
      : (q.answers.length ? `<ul class="mg-ans">${q.answers.map(a => `<li><b>${esc(a.name)}</b><span>${esc(a.answer)}</span></li>`).join("")}</ul>` : "");
    const waiting = q.guests && q.not_answered.length
      ? p(`Not answered yet: ${andList(q.not_answered.slice(0, 15))}${q.not_answered.length > 15 ? ` and ${q.not_answered.length - 15} more` : ""}.`, "quiet") : "";
    const editing = draft?.qid === q.question_id;
    const reword = q.answered === 0
      ? `<details class="mg-more"${editing ? " open" : ""}><summary>REWORD IT →</summary>${questionForm(editing ? draft : q, { qid: q.question_id, label: "Preview the new wording" })}</details>`
      // Answered, so the words stay; one everyone has to answer can still be made optional (the answers stand).
      : q.required
        ? `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "question")}${hidden("step", "review")}${hidden("qid", q.question_id)}${hidden("prompt", q.prompt)}${hidden("kind", q.kind)}${hidden("choices", (q.choices ?? []).join("\n"))}<div class="mg-row">${button("Make it optional", { cls: "mg-btn quiet", busy: "…" })}</div></form>`
        : "";
    // The guests already in who have not answered and were never texted about it: one offer to ask them.
    const plan = questions.askPlan(ev, { id: q.question_id, version: q.version });
    const ask = plan.asked
      ? `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "question_ask")}${hidden("step", "review")}${hidden("qid", q.question_id)}<div class="mg-row">${button(`Ask the ${plural(plan.asked, "guest")} already in →`, { cls: "mg-btn quiet", busy: "…" })}</div></form>`
      : "";
    return `<div class="mg-q"><div class="mg-kv"><b>${esc(q.prompt)}</b><span class="mg-tag">${q.kind === "choice" ? "PICK ONE" : "FREE TEXT"}</span>${q.required ? `<span class="mg-tag">REQUIRED</span>` : ""}</div>`
      + `<span class="mg-meta">${esc(q.guests ? `ANSWERED · ${q.answered} OF ${q.guests}` : "NOBODY HAS JOINED YET")}</span>`
      + body + waiting + reword + ask
      + `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "question_remove")}${hidden("step", "review")}${hidden("qid", q.question_id)}<div class="mg-row">${button("Remove", { cls: "mg-btn quiet", busy: "…" })}</div></form>`
      + `</div>`;
  }).join("");
  const room = list.length < questions.LIMITS.questions;
  const adding = draft && draft.qid == null;
  return `<h2 class="mg-h">${esc(list.length ? "What you ask guests" : "Ask guests something")}</h2>`
    + p(`Up to ${questions.LIMITS.questions} short questions guests answer when they join, like dietary needs or a plus-one's name. Each is optional unless you say everyone has to answer it. Only you see the answers: never other guests, never the guest list.`)
    + items
    + (room
      ? (list.length
        ? `<details class="mg-more"${adding ? " open" : ""}><summary>ADD A QUESTION →</summary>${questionForm(adding ? draft : {})}</details>`
        : `<p class="lbl" style="margin-top:8px">ADD A QUESTION</p>${questionForm(adding ? draft : {})}`)
      : p(`That's the most an event can ask (${questions.LIMITS.questions}). Remove one to add another.`, "quiet"))
    + p("Adding a question texts nobody by itself. Guests already in see it on their event page and can answer there, and you can have Reason text them the question once. Reason asks it too when someone joins by text.", "quiet");
}

// ---------------------------------------------------------------- the page

/**
 * The organizer's page. `notice` is one line to show at the top ({ text, error }); `drafts` puts
 * back what they typed when a step sends them back to change it.
 */
export function renderManage({ ev, conversationId, query = {}, notice = null, drafts = {} }) {
  const v = events.organizerView(ev);
  const paused = ev.status === "paused";
  const done = notice ?? (query.done && DONE_SECTION[query.done] ? { text: doneNote(query, ev), section: DONE_SECTION[query.done] } : null);
  const link = events.eventUrl(ev);
  const going = v.going;
  const sec = (id, n, title, inner) => section(id, n, title, inner, done);

  // Tickets (src/eventpay.js): where a price could be set, or already is.
  const money = eventpay.paidEventsOn() && (eventpay.canPrice(conversationId) || eventpay.priced(ev));
  const hero = `<div class="mg-hero"><p class="lbl">ONLY YOU SEE THIS PAGE</p><h1>${esc(ev.name)}</h1>`
    + p([v.when ?? "No time set", plural(going, "guest"), v.capacity ? `cap ${v.capacity}${going >= v.capacity ? " (full)" : ""}` : "", eventpay.priced(ev) ? `${eventpay.dollars(ev.price_cents)} a person` : ""].filter(Boolean).join(" · "), "quiet")
    + `</div>`;
  const banner = (paused ? `<p class="mg-note">Reason's operator has paused this event, so joining is closed and nothing goes out to guests until it's resumed. That isn't something you can undo from here.</p>` : "")
    + (done?.text && !done.section ? noteHtml(done) : "");
  // REASON_EVENT_HELP_LINE: the Help line section only for an organizer the flag reaches.
  const helpHere = helpline.eventAllowed(ev);
  const nav = `<ul class="mg-nav" aria-label="On this page">${[["welcome", "WELCOME"], ["message", "MESSAGE GUESTS"], ["schedule", "SCHEDULED"], ["details", "DETAILS"], ["guests", "GUESTS"], ["questions", "QUESTIONS"], ...(money ? [["money", "TICKETS"]] : []), ["access", "SHARING"], ...(helpHere ? [["help", "HELP LINE"]] : []), ["more", "MORE"]]
    .map(([id, l]) => `<li><a href="#${id}">${l}</a></li>`).join("")}</ul>`;

  // 01 — the welcome
  const welcomeDraft = drafts.welcome ?? ev.welcome ?? "";
  const rest = welcomePreview(ev, "");
  const welcome = sec("welcome", "01", "Welcome message",
    `<h2 class="mg-h">What new guests get</h2>`
    + p("Reason texts this the moment somebody joins, followed by whatever details you've shared. Leave it empty to send just the details.")
    + form("welcome", "", `<label for="welcome_text">YOUR WELCOME<textarea id="welcome_text" name="welcome" maxlength="${LIMITS.welcome}" data-count="welcome_count" rows="4">${esc(welcomeDraft)}</textarea></label>`
      + counter("welcome_count", welcomeDraft, LIMITS.welcome)
      + `<p class="lbl">A NEW GUEST GETS</p><p class="mg-bubble" id="welcome_live" data-rest="${esc(rest)}">${esc(welcomePreview(ev, welcomeDraft.trim()))}</p>`
      + `<div class="mg-row">${button("Save welcome", { busy: "Saving…" })}${ev.welcome ? button("Clear it", { cls: "mg-btn quiet", name: "clear", value: "1", busy: "Clearing…" }) : ""}</div>`)
    + p("Saving changes what future guests get. People already in aren't texted. To tell them too, send it under Message guests.", "quiet"));

  // 02 — message guests
  const audience = events.audience(ev, "blast");
  const sent = events.sentMessages(ev, { limit: 8 });
  const msgDraft = drafts.message ?? (query.prefill === "welcome" ? ev.welcome ?? "" : "");
  const message = sec("message", "02", "Message guests",
    `<h2 class="mg-h">Text your guests</h2>`
    + p(`Goes to everyone — ${plural(audience.guests, "guest")}${audience.muted ? `, not counting ${audience.muted} who muted the event` : ""} — or only to the guests you pick, from Reason, with your name on it. You'll see exactly how it reads and who gets it before anything is sent.`)
    + (paused ? p("Paused by Reason's operator, so messages can't go out right now.", "quiet")
      : form("blast", "preview", `<label for="blast_text">YOUR MESSAGE<textarea id="blast_text" name="message" maxlength="${LIMITS.message}" data-count="blast_count" rows="4" required>${esc(msgDraft)}</textarea></label>`
        + counter("blast_count", msgDraft, LIMITS.message)
        + whoPicker(ev, "blast", drafts.blastPick ?? {})
        + `<div class="mg-row">${button("Preview message", { busy: "Opening preview…" })}</div>`))
    + `<p class="lbl" style="margin-top:8px">SENT SO FAR</p>`
    + (sent.length
      ? sent.map(m => `<div class="mg-msg"><span class="mg-meta">${esc(`${kindLabel(ev, m)} · ${when(ev, m.at)}`.toUpperCase())}</span>${bubble(m.body)}<span class="mg-meta">${esc(deliveryLine(m))}</span></div>`).join("")
      : p("Nothing sent to guests yet.", "quiet")));

  // 03 — later: messages the organizer scheduled, and the two automatic reminders
  const scheduled = scheduleSection(ev, { query, drafts, paused, sec });

  // 04 — details
  const d = drafts.details ?? {};
  const shown = (on) => `<span class="mg-tag${on ? " on" : ""}">${on ? "GUESTS SEE IT" : "HIDDEN FROM GUESTS"}</span>`;
  const zones = (() => { try { return Intl.supportedValuesOf("timeZone"); } catch { return [ev.tz]; } })();
  const releaseBtn = (detail, has, out) => !out && has && !paused
    ? `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "release")}${hidden("step", "review")}${hidden("detail", detail)}${button(detail === "time" ? "Share the time with guests" : "Share the location with guests", { cls: "mg-btn alt", busy: "Opening…" })}</form>`
    : "";
  const details = sec("details", "04", "Details",
    `<h2 class="mg-h">The event itself</h2>`
    + p("Change anything here. If guests can already see what you change, Reason texts them the update, and you'll see that text before it goes. A change to something still hidden is saved quietly.")
    + `<div class="mg-kv"><span class="lbl">TIME</span>${shown(v.time_shown_to_guests)}</div>`
    + `<div class="mg-kv"><span class="lbl">LOCATION</span>${shown(v.location_shown_to_guests)}</div>`
    + `<div class="mg-row">${releaseBtn("time", ev.starts_at != null, v.time_shown_to_guests)}${releaseBtn("location", !!ev.location, v.location_shown_to_guests)}</div>`
    + form("details", "review",
      `<label for="d_name">NAME<input id="d_name" name="name" type="text" maxlength="${LIMITS.name}" required value="${esc(d.name ?? ev.name)}"></label>`
      + `<label for="d_desc">DESCRIPTION<textarea id="d_desc" name="description" maxlength="${LIMITS.description}" data-count="desc_count" rows="3">${esc(d.description ?? ev.description)}</textarea></label>`
      + counter("desc_count", d.description ?? ev.description, LIMITS.description)
      + `<label for="d_when">STARTS<input id="d_when" name="starts_at" type="datetime-local" value="${esc(d.starts_at ?? v.starts_at_local ?? "")}"></label>`
      + `<label for="d_tz">TIME ZONE<input id="d_tz" name="timezone" type="text" list="tzs" autocapitalize="off" spellcheck="false" maxlength="64" value="${esc(d.timezone ?? ev.tz)}"></label>`
      + `<datalist id="tzs">${zones.map(z => `<option value="${esc(z)}">`).join("")}</datalist>`
      + `<label for="d_loc">LOCATION<input id="d_loc" name="location" type="text" maxlength="${LIMITS.location}" value="${esc(d.location ?? ev.location)}"></label>`
      + `<div class="mg-row">${button("Save details", { busy: "Checking…" })}</div>`));

  // 04 — guests
  const list = events.guestList(ev);
  const joined = list.filter(g => g.state === "joined");
  const paidBy = eventpay.priced(ev) ? new Map(eventpay.paidGuests(ev).map(g => [g.guest_id, g])) : new Map();
  const guests = sec("guests", "05", "Guests",
    `<h2 class="mg-h">${esc(joined.length ? `${plural(joined.length, "guest")} in` : "Nobody yet")}</h2>`
    + p("Names are what each guest chose to show. Phone numbers are never shown, here or anywhere.")
    + (list.length
      ? `<ul class="mg-list">${list.map(g => `<li><div class="mg-who"><b>${esc(g.display_name || "A guest")}</b><span>${esc([
        g.state === "removed" ? "taken off the event" : !g.in_directory ? "not on the who's-going list"
          : ev.guest_list_visible || g.list_chosen ? "on the who's-going list" : "joined while the list was private",
        VIA[g.via] ?? "",
        paidBy.get(g.guest_id) ? `paid ${eventpay.dollars(paidBy.get(g.guest_id).total_cents)}` : "",
      ].filter(Boolean).join(" · "))}${g.instagram ? ` · <a href="${esc(events.instagramUrl(g.instagram))}" rel="noopener noreferrer" target="_blank">@${esc(g.instagram)}</a>` : ""}</span></div>`
        + (g.state === "joined" ? `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "remove")}${hidden("step", "review")}${hidden("guest", g.guest_id)}${button("Remove", { cls: "mg-btn quiet", busy: "…" })}</form>` : "")
        + `</li>`).join("")}</ul>`
      : p("Share the link and the password, and guests show up here as they join.", "quiet"))
    + `<div class="mg-row"><a class="mg-btn alt" href="${esc(`/e/${ev.public_id}/who?t=${encodeURIComponent(ev.organizer_token)}`)}">Your guest list page</a></div>`
    + listAndCap(ev, { going, drafts }));

  // 06 — guest questions
  const asks = sec("questions", "06", "Guest questions", questionsSection(ev, { drafts }));

  // 07 — tickets and payouts (src/eventpay.js)
  const tickets = money ? ticketsSection(ev, { conversationId, drafts, sec, paused }) : "";

  // 08 — access and sharing
  const access = sec("access", money ? "08" : "07", "Sharing",
    `<h2 class="mg-h">The link and the password</h2>`
    + p("Guests need both: the link opens the join page, and the password lets them in.")
    + `<label class="lbl" for="invite_link">INVITE LINK</label><div class="mg-copy"><input id="invite_link" type="text" readonly value="${esc(link)}"><button class="mg-btn alt" type="button" data-copy="invite_link">Copy</button></div>`
    + p("Reason doesn't keep the password in a form anyone can read back, so it can't be shown here. If you need to share it again, set a new one.", "quiet")
    + form("password", "review", `<label for="new_pw">NEW PASSWORD<input id="new_pw" name="password" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" minlength="4" maxlength="${LIMITS.password}" required></label>`
      + `<div class="mg-row">${button("Change password", { cls: "mg-btn alt", busy: "Opening…" })}</div>`));

  // The help line (src/eventhelpline.js): one link for the ticket page and socials, its QR, the ticket link, and who texted in.
  const help = helpHere ? sec("help", money ? "09" : "08", "Help line", helpLineSection(ev, { drafts })) : "";
  const moreNo = (money ? 9 : 8) + (helpHere ? 1 : 0);

  // 06 — the rest
  const hasPicture = cover.hasUploaded(ev);
  const pending = cover.pendingOf(ev);
  const ridesHere = rides.canEnable(ev);
  const more = sec("more", String(moreNo).padStart(2, "0"), "More",
    `<h2 class="mg-h">The rest</h2>`
    + `<p class="lbl">THE LINK'S CARD</p>`
    + `<img class="mg-cover" src="${esc(cover.coverUrl(ev))}" alt="The picture on your event link's card">`
    + p(hasPicture ? "Your picture is on the card Messages shows when the link is sent." : "The card uses Reason's drawn cover with the event name. To use a photo or flyer instead, text it to Reason.")
    + (pending ? p("A new picture is waiting for your OK in your texts with Reason.", "quiet") : "")
    + `<div class="mg-row">`
    + (hasPicture ? `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "cover_remove")}${hidden("step", "review")}${button("Go back to Reason's cover", { cls: "mg-btn quiet", busy: "Opening…" })}</form>` : "")
    + (pending ? `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "cover_discard")}${hidden("step", "review")}${button("Drop the waiting picture", { cls: "mg-btn quiet", busy: "Opening…" })}</form>` : "")
    + `</div>`
    + (ridesHere
      ? `<p class="lbl">RIDE SHARING</p>`
        + p(ev.rides_enabled
          ? `On. Reason asks each guest once, the day before, whether they're driving or need a ride, and pairs them up only when both agree.${v.rides ? ` So far: ${v.rides.matched} matched, ${v.rides.still_looking} still looking.` : ""}`
          : "Off. Turn it on and Reason helps guests share rides: it asks each guest once, the day before, and pairs people up only when both agree.")
        + `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "rides")}${hidden("step", ev.rides_enabled ? "do" : "review")}${hidden("enabled", ev.rides_enabled ? "0" : "1")}<div class="mg-row">${button(ev.rides_enabled ? "Turn ride sharing off" : "Turn ride sharing on", { cls: "mg-btn alt", busy: "Saving…" })}</div></form>`
      : "")
    + (albums.albumFor(ev) ? `<p class="lbl">PHOTO ALBUM</p>${p("Check guests in, pin highlights and release the album to everyone who came.")}<div class="mg-row"><a class="mg-btn alt" href="${esc(`/e/${ev.public_id}/album/manage`)}">Open the album</a></div>` : "")
    + `<details class="mg-more"${drafts.cancel ? " open" : ""}><summary>CANCEL THE EVENT →</summary>`
    + `<div class="mg-sec" style="gap:14px">`
    + p(`Every guest is texted that it's cancelled, and the join page and the guest list close.${eventpay.summary(ev).paid_count ? " Everyone who paid is refunded in full, Reason's fee included." : ""} This can't be undone.`)
    + form("cancel", "review",
      `<label for="c_msg">A LINE FROM YOU (OPTIONAL)<textarea id="c_msg" name="message" maxlength="${LIMITS.cancel}" rows="2">${esc(drafts.cancel?.message ?? "")}</textarea></label>`
      + `<label for="c_name">TYPE THE EVENT'S NAME TO CONFIRM<input id="c_name" name="confirm_name" type="text" autocomplete="off" required></label>`
      + `<div class="mg-row">${button("Cancel the event", { cls: "mg-btn danger", busy: "Opening…" })}</div>`)
    + `</div></details>`);

  const signOut = `<form method="POST" action="${esc(`/e/${ev.public_id}/signout`)}" style="margin:0"><button class="typed mut" type="submit">SIGN OUT OF THIS BROWSER</button></form>`;
  const main = (hero + banner + nav + welcome + message + scheduled + details + guests + asks + tickets + access + help + more + signOut).split("__ACTION__").join(esc(managePath(ev)));
  const side = `<span class="lbl d">AT A GLANCE</span><p class="quiet d">${esc(`${plural(going, "guest")} in. Time ${v.time_shown_to_guests ? "shared" : "hidden"}, location ${v.location_shown_to_guests ? "shared" : "hidden"}.${eventpay.priced(ev) ? ` ${eventpay.dollars(ev.price_cents)} a person, ${plural(eventpay.summary(ev).paid_count, "guest")} paid.` : ""}`)}</p>`
    + `<a class="typed d" href="${esc(link)}">${esc("THE JOIN PAGE GUESTS SEE →")}</a>`;
  return madeDoc({ title: `Your event: ${ev.name}`, kicker: "YOUR EVENT", main, side, head: CSS, script: SCRIPT, foot: "Only you, the organizer, can see this page. Guests never see it. You can also change anything by texting Reason.", url: link });
}

/**
 * The Help line block (owner request 2026-11-11): the link that opens a text to Reason already naming
 * the event, its QR, the code; the ticket link shown as Get tickets on the event page; the name the
 * help line says it's run for; how many people texted in; and the questions waiting on the organizer,
 * each answerable here.
 */
function helpLineSection(ev, { drafts = {} } = {}) {
  const v = helpline.organizerHelpView(ev);
  const ticketDraft = drafts.ticket ?? ev.ticket_url ?? "";
  const hostDraft = drafts.host ?? ev.help_host ?? "";
  const ticketForm = form("help_ticket", "", `<label for="help_ticket">LINK TO YOUR TICKET PAGE (POSH, EVENTBRITE…)<input id="help_ticket" name="ticket_link" type="url" inputmode="url" autocapitalize="off" spellcheck="false" maxlength="${helpline.LIMITS.ticketUrl}" placeholder="https://posh.vip/e/…" value="${esc(ticketDraft)}"></label>`
    + `<div class="mg-row">${button("Save ticket link", { cls: "mg-btn alt", busy: "Saving…" })}${ev.ticket_url ? button("Remove it", { cls: "mg-btn quiet", name: "clear", value: "1", busy: "Removing…" }) : ""}</div>`);
  if (!v.on) {
    return `<h2 class="mg-h">One link for questions, the address and updates</h2>`
      + p("Turn this on and you get a link for your ticket page and socials — \"Questions, the address, updates? Text us →\". Tapping it opens a text to Reason that already names this event. Reason answers as your event's help line: what it is, how to get tickets, and the address once they give the event password. Anything it can't answer comes to you here and by text.")
      + p(`It says it's run for ${v.host_name}, so turning it on shows that name to anyone who texts or opens your event page. Change it below once it's on.`, "quiet")
      + form("help_on", "", `<div class="mg-row">${button("Turn on the help line", { busy: "Turning on…" })}</div>`)
      + `<p class="lbl">TICKET LINK</p>` + p("Selling tickets somewhere else? Add the link and your event page shows a Get tickets button.") + ticketForm;
  }
  const asks = v.open_questions.length
    ? `<p class="lbl">WAITING ON YOU</p>` + v.open_questions.map(a => `<div class="mg-ask"><p class="mg-p"><b>${esc(a.who)}</b> asked: ${esc(a.question)}</p>`
      + form("help_reply", "", `${hidden("ask_id", String(a.id))}<label for="hr_${a.id}">YOUR ANSWER<textarea id="hr_${a.id}" name="message" maxlength="${helpline.LIMITS.answer}" rows="2"></textarea></label><div class="mg-row">${button("Send answer", { cls: "mg-btn alt", busy: "Sending…" })}</div>`) + `</div>`).join("")
    : "";
  return `<h2 class="mg-h">${esc(plural(v.texted_in, "person", "people"))} texted in</h2>`
    + p("Put this link on your ticket page (Posh, Eventbrite) and socials. It opens a text to Reason that already names this event; Reason answers as your event's help line and passes on what it can't answer.")
    + `<label class="lbl" for="help_link">HELP LINE LINK</label><div class="mg-copy"><input id="help_link" type="text" readonly value="${esc(v.help_link)}"><button class="mg-btn alt" type="button" data-copy="help_link">Copy</button></div>`
    + `<div class="mg-qr">${qrSvg(v.help_link, { label: `QR code for the ${ev.name} help line`, size: 168 })}</div>`
    + p(`For a flyer: scan it, or text "code ${v.code}" to Reason. The first text reads: "${v.first_text}".`, "quiet")
    + p("Put the event password in your ticket confirmation, so buyers can get the address: Reason asks for it before it shares anything you keep for guests.", "quiet")
    + asks
    + `<p class="lbl">TICKET LINK</p>` + ticketForm
    + `<p class="lbl">RUN FOR</p>`
    + form("help_host", "", `<label for="help_host">THE NAME GUESTS HEAR<input id="help_host" name="host_name" type="text" maxlength="${helpline.LIMITS.host}" placeholder="${esc(events.organizerName(ev) || "")}" value="${esc(hostDraft)}"></label><div class="mg-row">${button("Save name", { cls: "mg-btn alt", busy: "Saving…" })}</div>`)
    + form("help_off", "", `<div class="mg-row">${button("Turn off the help line", { cls: "mg-btn quiet", busy: "Turning off…" })}</div>`);
}

/** A fingerprint of exactly who an ask would text right now, and the words it carries (the question's version). */
const askPin = (ev, q) => { const plan = questions.askPlan(ev, q); return `${q.version}:${plan.ids.join(".") || "none"}`; };

/** The offer to text the guests already in about a question: who, the exact text, and the two buttons. Declining texts nobody. */
function askConfirm(ev, q, notice = null) {
  const plan = events.questionAskPlan(ev, q);
  return page(200, renderConfirm({
    ev, title: `Ask the ${plural(plan.asked, "guest")} already in?`, notice,
    sentences: [
      `${plan.asked === 1 ? "One guest is" : `${plan.asked} guests are`} already in and ${plan.asked === 1 ? "hasn't" : "haven't"} answered it: ${andList(plan.names.slice(0, 15))}${plan.names.length > 15 ? ` and ${plan.names.length - 15} more` : ""}.`,
      "Reason texts each of them once, when it isn't night for them. Anyone who answers on their event page first isn't texted.",
      ...(plan.muted_not_asked ? [`${plural(plan.muted_not_asked, "guest")} muted the event and ${plan.muted_not_asked === 1 ? "isn't" : "aren't"} texted.`] : []),
      "If you'd rather not, nobody is texted: they can still answer on their own event page.",
    ],
    preview: plan.body, previewLabel: plan.asked === 1 ? "THEY GET THIS TEXT" : "EACH OF THEM GETS THIS TEXT",
    fields: { action: "question_ask", step: "do", qid: String(q.id), pin: askPin(ev, q) },
    confirm: `Text ${plural(plan.asked, "guest")}`, back: "Don't ask",
  }));
}

/** One question as the organizer's page reads it (joined guests' answers only), or null. */
function db_question(ev, qid) {
  return questions.organizerSummary(ev).find(q => q.question_id === qid) ?? null;
}

/** One confirm step: what happens, in a sentence, the exact text when there is one, and the two buttons. */
export function renderConfirm({ ev, title, sentences = [], preview = null, previewLabel = "GUESTS GET THIS TEXT", fields = {}, confirm, back = "Go back", danger = false, disabled = false, extra = "", notice = null }) {
  const keep = Object.entries(fields).map(([k, val]) => hidden(k, val)).join("");
  const main = `<div class="mg-confirm"><p class="lbl">YOUR EVENT · ${esc(String(ev.name).toUpperCase())}</p><h1 class="mg-h">${esc(title)}</h1>`
    + (notice ? noteHtml({ text: notice, error: true }) : "")
    + sentences.map(s => p(s)).join("")
    + extra
    + (preview != null ? `<p class="lbl">${esc(previewLabel)}</p>${bubble(preview)}` : "")
    + `<form class="mg-f" method="POST" action="${esc(managePath(ev))}">${keep}<div class="mg-row">${button(confirm, { cls: danger ? "mg-btn danger" : "mg-btn", busy: "Working…", disabled })}</div></form>`
    + `<form class="mg-f" method="POST" action="${esc(managePath(ev))}">${keep.replace(/name="step" value="[^"]*"/, `name="step" value="edit"`)}<div class="mg-row">${button(back, { cls: "mg-btn quiet" })}</div></form>`
    + `</div>`;
  return madeDoc({ title: `${ev.name} — confirm`, kicker: "YOUR EVENT", main, head: CSS, script: SCRIPT, foot: "Nothing has happened yet. Only you, the organizer, can see this page.", url: events.eventUrl(ev) });
}

/** The new password, shown this once, with the words to forward. */
function renderNewPassword({ ev, password }) {
  const share = events.shareText(ev, password);
  const main = `<div class="mg-confirm"><p class="lbl">YOUR EVENT · ${esc(String(ev.name).toUpperCase())}</p><h1 class="mg-h">New password set</h1>`
    + p("Everyone already in stays in. The old password no longer works for new joins.")
    + `<p class="lbl">THE NEW PASSWORD</p><p class="mg-secret">${esc(password)}</p>`
    + p("This is the only time it's shown. Reason doesn't keep it in a form it can read back.", "quiet")
    + `<p class="lbl">TO FORWARD</p><div class="mg-f"><textarea id="share_text" readonly rows="3">${esc(share)}</textarea></div>`
    + `<div class="mg-row"><button class="mg-btn" type="button" data-copy="share_text">Copy the invite</button></div>`
    + `<label class="lbl" for="invite_link">THEN THE LINK, AS ITS OWN MESSAGE</label><div class="mg-copy"><input id="invite_link" type="text" readonly value="${esc(events.eventUrl(ev))}"><button class="mg-btn alt" type="button" data-copy="invite_link">Copy</button></div>`
    + `<div class="mg-row"><a class="mg-btn quiet" href="${esc(`${homePath(ev)}#access`)}">Back to your event</a></div></div>`;
  return madeDoc({ title: `${ev.name} — new password`, kicker: "YOUR EVENT", main, head: CSS, script: SCRIPT, foot: "Only you, the organizer, can see this page.", url: events.eventUrl(ev) });
}

// ---------------------------------------------------------------- the posts

/**
 * Is this post from our own pages? The cookie is SameSite=Lax, so a form on another site carries no
 * session at all; this is the second lock, the same check Reason Web's posts use, with the events
 * domain counted as ours too.
 */
export function ownOrigin(headers = {}) {
  if (sameOrigin(headers)) return true;
  const origin = String(headers.origin ?? "").trim();
  const site = String(headers["sec-fetch-site"] ?? "").toLowerCase();
  if (!origin || origin === "null" || (site && !["same-origin", "same-site", "none"].includes(site))) return false;
  try { return !!config.eventsUrl && new URL(origin).host === new URL(config.eventsUrl).host; } catch { return false; }
}

const back = (ev, anchor, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return redirect(`${homePath(ev)}${qs ? `?${qs}` : ""}#${anchor}`);
};
const counts = (sent) => (sent ? { n: String(sent.sent ?? 0), f: String(sent.failed ?? 0), g: String(sent.guests ?? 0) } : {});

/**
 * POST /e/{id}/manage. `account` and `mine` are what src/pages/event.js read off the page session.
 * Anybody who is not this event's organizer, on a signed-in browser, gets the flat not-found.
 */
export async function manageRequest({ ev, method, headers = {}, readBody, account = null, mine = null, runtime = null, log = () => {} }) {
  if (!account || mine?.role !== "organizer") return page(404, renderNotFound());
  const c = account.conversation_id;
  // The one door, asked again in so many words: this conversation organizes this event.
  const own = events.managed(c, ev.id);
  if (!own || own.status === "cancelled") return page(404, renderNotFound());
  if (method !== "POST") return redirect(homePath(own));
  if (!ownOrigin(headers)) return page(403, renderNotFound());
  const body = await readBody();
  if (body != null && String(body).length > 20000) return page(413, renderNotFound());
  const f = new URLSearchParams(body ?? "");
  const action = f.get("action");
  const step = f.get("step") ?? "";
  const ctx = { conversationId: c, events: runtime, log };
  const run = (name, input) => tools.runEventTool(name, toolInput(own, input), ctx);
  const again = (notice, drafts = {}) => page(200, renderManage({ ev: own, conversationId: c, notice, drafts }));
  const SECTION = { welcome: "welcome", blast: "message", schedule: "schedule", sched_cancel: "schedule", reminder: "schedule", details: "details", release: "details", remove: "guests", list: "guests", cap: "guests", question: "questions", question_remove: "questions", question_ask: "questions", password: "access", rides: "more", cover_remove: "more", cover_discard: "more", cancel: "more",

    payouts: "money", price: "money", free: "money", refund: "money", dashboard: "money",
    help_on: "help", help_off: "help", help_ticket: "help", help_host: "help", help_reply: "help" };
  // Tickets (src/eventpay.js): only where a price could be set, or already is; anybody else's post is a redirect home.
  const money = eventpay.paidEventsOn() && (eventpay.canPrice(c) || eventpay.priced(own));
  const oops = (text, drafts = {}) => again({ text, error: true, section: SECTION[action] ?? null }, drafts);
  const valid = (name, input) => tools.EVENT_SCHEMAS[name].safeParse(toolInput(own, input)).success;
  log({ event_manage: own.id, action, step });

  switch (action) {
    case "welcome": {
      const text = f.get("clear") === "1" ? "" : String(f.get("welcome") ?? "");
      if (text.length > LIMITS.welcome) return oops(`The welcome can be up to ${LIMITS.welcome} characters.`, { welcome: text });
      const out = await run("event_update", { welcome_message: text });
      if (!out?.ok) return oops("That didn't save. Try again.", { welcome: text });
      return back(own, "welcome", { done: text.trim() ? "welcome" : "welcome_cleared" });
    }

    case "blast": {
      const message = String(f.get("message") ?? "");
      const { draft: pickDraft, pick } = readPick(own, f);
      const drafts = { message, blastPick: pickDraft };
      if (step === "edit") return again(null, drafts);
      if (!message.trim()) return oops("Write the message first.", drafts);
      if (!valid("event_blast", { message })) return oops(`A message can be up to ${LIMITS.message} characters.`, drafts);
      if (own.status === "paused") return oops("Reason's operator has paused this event, so nothing goes out to guests right now.", drafts);
      if (!pick.ok) return oops(PICK_OOPS[pick.reason] ?? "That pick of guests didn't read.", drafts);
      const aud = events.audience(own, "blast", pick.audience);
      const pin = reachPin(own, pick.audience, "blast");
      const preview = (notice = null) => page(200, renderConfirm({
        ev: own, title: pick.audience ? `Send this to ${plural(aud.guests, "guest")}?` : "Send this to everyone?", notice,
        sentences: pick.audience
          ? [...whoSentences(own, pick.audience, aud), "Once it's sent it can't be taken back."]
          : [
            aud.guests ? `Reason texts this to ${plural(aud.guests, "guest")}, exactly as it reads below.` : "Nobody has joined yet, so nobody would get it.",
            ...(aud.muted ? [`${plural(aud.muted, "guest")} muted this event and won't get it.`] : []),
            "Once it's sent it can't be taken back.",
          ],
        extra: pick.audience ? whoList(aud) : "",
        preview: tools.blastBody(own, message),
        fields: { action: "blast", step: "send", message, ...pickFields(pickDraft), pin },
        confirm: aud.guests ? `Send to ${plural(aud.guests, "guest")}` : "Nobody to send to", back: "Change the message", disabled: !aud.guests,
      }));
      if (step === "preview") return preview();
      if (step !== "send") return redirect(homePath(own));
      // Who it reaches is checked again: a guest who joined, left or muted since the preview is shown first.
      if (pick.audience && f.get("pin") !== pin) return preview("Who gets it changed since you looked. Check the list again before sending.");
      const out = await run("event_blast", { message, ...pickInput(pickDraft, pick.audience) });
      if (!out?.ok) return oops("That didn't send. Nothing went out.", drafts);
      log({ event_manage_blast: own.id, guests: out.sent?.guests ?? 0, failed: out.sent?.failed ?? 0 });
      return back(own, "message", { done: "blast", ...counts(out.sent) });
    }

    case "schedule": {
      const message = String(f.get("message") ?? "");
      const sendAt = String(f.get("send_at") ?? "").trim();
      const idRaw = Number.parseInt(f.get("id") ?? "", 10);
      const replacing = Number.isInteger(idRaw) && idRaw > 0 ? idRaw : null;
      const { draft: pickDraft, pick } = readPick(own, f);
      const draft = { message, send_at: sendAt, ...pickDraft, ...(replacing ? { id: String(replacing) } : {}) };
      if (step === "edit") return again(null, { schedule: draft });
      if (!valid("event_schedule", { message: message || " ", send_at: sendAt })) return oops(message.length > LIMITS.message ? schedule.WHY.too_long : schedule.WHY.bad_time, { schedule: draft });
      if (!pick.ok) return oops(PICK_OOPS[pick.reason] ?? "That pick of guests didn't read.", { schedule: draft });
      const plan = schedule.plan(own, { message, sendAt, replacing, audience: pick.audience });
      if (!plan.ok) return oops(schedule.WHY[plan.reason] ?? "That can't be scheduled.", { schedule: draft });
      const pin = reachPin(own, pick.audience, "scheduled");
      const preview = (notice = null) => page(200, renderConfirm({
        ev: own, title: replacing ? "Change this scheduled message?" : pick.audience ? "Schedule this for the guests you picked?" : "Schedule this for everyone?", notice,
        sentences: pick.audience
          ? [`Reason texts this at ${plan.when}, exactly as it reads below.`, ...whoSentences(own, pick.audience, plan.reach, { later: true }), "Until then you can change it or cancel it here. Once it's sent it can't be taken back."]
          : [
            `Reason texts this to everyone on the event at ${plan.when}, exactly as it reads below. That's ${plural(plan.reach.guests, "guest")} right now; anybody who joins before then gets it too, and anybody who leaves won't.`,
            ...(plan.reach.muted ? [`${plural(plan.reach.muted, "guest")} muted this event and won't get it.`] : []),
            "Until then you can change it or cancel it here. Once it's sent it can't be taken back.",
          ],
        extra: pick.audience ? whoList(plan.reach) : "",
        preview: plan.body,
        fields: { action: "schedule", step: "set", message, send_at: sendAt, ...pickFields(pickDraft), pin, ...(replacing ? { id: String(replacing) } : {}) },
        confirm: replacing ? "Save the change" : `Schedule for ${plan.when}`, back: "Change the message",
      }));
      if (step === "preview") return preview();
      if (step !== "set") return redirect(homePath(own));
      if (pick.audience && f.get("pin") !== pin) return preview("Who gets it changed since you looked. Check the list again before setting it.");
      const out = await run("event_schedule", { message, send_at: sendAt, ...pickInput(pickDraft, pick.audience), ...(replacing ? { scheduled_id: replacing, ...(pick.audience ? {} : { to_everyone: true }) } : {}) });
      if (!out?.ok) return oops(out?.reason && schedule.WHY[out.reason] ? schedule.WHY[out.reason] : "That didn't save. Nothing is scheduled.", { schedule: draft });
      log({ event_manage_scheduled: own.id, changed: !!out.changed });
      return back(own, "schedule", { done: out.changed ? "sched_changed" : "scheduled", s: String(out.scheduled_id) });
    }

    case "sched_cancel": {
      const id = Number.parseInt(f.get("id") ?? "", 10);
      const m = Number.isInteger(id) ? schedule.pendingFor(own).find(x => x.id === id) : null;
      if (!m) return oops(schedule.WHY.not_found);
      if (step === "edit") return back(own, "schedule");
      if (step === "review") {
        return page(200, renderConfirm({
          ev: own, title: "Cancel this scheduled message?",
          sentences: [`It was set to go ${m.when}. Nobody is texted, and it won't go out.`],
          preview: m.preview, previewLabel: "THE MESSAGE", fields: { action: "sched_cancel", step: "do", id: String(m.id) },
          confirm: "Cancel it", back: "Keep it", danger: true,
        }));
      }
      const out = await run("event_scheduled", { action: "cancel", scheduled_id: m.id });
      if (!out?.ok) return oops(schedule.WHY.not_found);
      return back(own, "schedule", { done: "sched_cancelled" });
    }

    case "reminder": {
      const which = f.get("which") === "day_before" ? "day_before" : f.get("which") === "two_hours" ? "two_hours" : null;
      if (!which) return redirect(homePath(own));
      const enabled = f.get("enabled") === "1";
      if (step === "edit") return back(own, "schedule");
      if (enabled && step === "review") {
        const r = schedule.reminderStatus({ ...own, [schedule.WHICH[which].column]: 1 }, which);
        const aud = events.audience(own, "reminder");
        const when = {
          upcoming: `It goes ${r.when} to everyone on the event then — ${plural(aud.guests, "guest")} right now${aud.muted ? `, not counting ${aud.muted} who muted the event` : ""}.`,
          time_hidden: `Guests can't see the time yet, so it only goes if you share the time before ${r.when}.`,
          night: `For this event it would land at ${r.when}, the middle of the night there, so it's skipped. It goes if the start time moves.`,
          too_late: "Its time for this event has already passed, so nothing goes now. It would go if the start time moves later.",
          no_time: "The event has no start time, so nothing goes until it has one.",
        }[r.state] ?? "";
        return page(200, renderConfirm({
          ev: own, title: `Turn on the ${which === "day_before" ? "day-before" : "two-hours-before"} reminder?`,
          sentences: [when, "You can turn it off here any time before it goes."].filter(Boolean),
          preview: r.preview, fields: { action: "reminder", step: "do", which, enabled: "1" },
          confirm: "Turn it on", back: "Leave it off",
        }));
      }
      const out = await run("event_scheduled", { action: "reminder", reminder: which, enabled });
      if (!out?.ok) return oops("That didn't go through.");
      return back(own, "schedule", { done: enabled ? "reminder_on" : "reminder_off" });
    }

    case "details": {
      const v = events.organizerView(own);
      const draft = {
        name: String(f.get("name") ?? ""), description: String(f.get("description") ?? ""),
        starts_at: String(f.get("starts_at") ?? ""), timezone: String(f.get("timezone") ?? "").trim(), location: String(f.get("location") ?? ""),
      };
      if (step === "edit") return again(null, { details: draft });
      // Only what they changed goes to the tool, so an untouched field is never "changed" to itself.
      const input = {};
      if (draft.name.trim() && draft.name.trim() !== own.name) input.name = draft.name;
      if (draft.description.trim() && draft.description.trim() !== own.description) input.description = draft.description;
      if (draft.location.trim() && draft.location.trim() !== own.location) input.location = draft.location;
      const timeChanged = draft.starts_at && draft.starts_at !== v.starts_at_local;
      const zoneChanged = draft.timezone && draft.timezone !== own.tz;
      if (timeChanged || zoneChanged) { input.starts_at = draft.starts_at || v.starts_at_local; input.timezone = draft.timezone || own.tz; }
      if (!valid("event_update", input)) return oops("Something there is too long. Shorten it and try again.", { details: draft });
      const plan = tools.planEventUpdate(own, input);
      if (!plan.ok) {
        const why = /timezone/.test(plan.error) ? "That time zone isn't one Reason knows. Pick one from the list, like America/New_York."
          : /no letters/.test(plan.error) ? "The name needs at least one letter or number." : "The start time didn't read as a date and time.";
        return oops(why, { details: draft });
      }
      if (!Object.keys(plan.fields).length) return back(own, "details", { done: "nothing" });
      const fields = { action: "details", step: "save", ...draft };
      if (plan.told.length && step === "review") {
        const aud = events.audience(own, "update");
        return page(200, renderConfirm({
          ev: own, title: "Save, and tell your guests?",
          sentences: [
            `Guests can see what you changed, so Reason texts ${aud.guests ? plural(aud.guests, "guest") : "your guests (nobody has joined yet)"} this update when you save.`,
            ...(plan.quiet.length ? [`The ${plan.quiet.join(" and ")} is still hidden from guests, so that part is saved quietly.`] : []),
            ...(own.status === "paused" ? ["The event is paused, so the text waits until it's resumed."] : []),
          ],
          preview: plan.body, fields, confirm: "Save and text guests", back: "Change it",
        }));
      }
      if (step !== "review" && step !== "save") return redirect(homePath(own));
      const out = await run("event_update", input);
      if (!out?.ok) return oops("That didn't save. Try again.", { details: draft });
      if (out.sent) return back(own, "details", { done: "details", ...counts(out.sent) });
      return back(own, "details", { done: out.saved_quietly?.length ? "details_quiet" : "details" });
    }

    case "release": {
      const detail = f.get("detail") === "location" ? "location" : f.get("detail") === "time" ? "time" : null;
      if (!detail) return redirect(homePath(own));
      const col = detail === "time" ? "time_released" : "location_released";
      if (own[col]) return back(own, "details");
      if (detail === "time" ? own.starts_at == null : !own.location) return oops(`There's no ${detail} set to share yet.`);
      if (own.status === "paused") return oops("Reason's operator has paused this event, so nothing goes out to guests right now.");
      if (step === "review") {
        const aud = events.audience(own, "release");
        return page(200, renderConfirm({
          ev: own, title: `Share the ${detail} with guests?`,
          sentences: [
            `Reason texts ${aud.guests ? plural(aud.guests, "guest") : "your guests (nobody has joined yet)"} the ${detail} now, and everyone who joins later sees it too.`,
            "Once it's shared it can't be hidden from guests again.",
          ],
          preview: tools.releaseBody(own, detail), fields: { action: "release", step: "do", detail },
          confirm: `Share the ${detail}`, back: "Not yet",
        }));
      }
      if (step === "edit") return back(own, "details");
      const out = await run("event_release", { detail });
      if (!out?.ok) return oops("That didn't go through. Nothing was sent.");
      return back(own, "details", { done: "release", ...counts(out.sent) });
    }

    case "remove": {
      const id = Number.parseInt(f.get("guest") ?? "", 10);
      const g = Number.isInteger(id) && id > 0 ? events.guestList(own).find(x => x.guest_id === id && x.state === "joined") : null;
      if (!g) return oops("That guest isn't on the event any more.");
      if (step === "review") {
        return page(200, renderConfirm({
          ev: own, title: `Take ${g.display_name || "this guest"} off the event?`,
          sentences: [
            "They lose the guest list page and the event's updates, and they can't rejoin with the password.",
            "Their own Reason is untouched. Reason texts them this:",
          ],
          preview: tools.removedBody(own), previewLabel: "THEY GET THIS TEXT", fields: { action: "remove", step: "do", guest: g.guest_id },
          confirm: "Take them off", back: "Keep them", danger: true,
        }));
      }
      if (step === "edit") return back(own, "guests");
      const out = await run("event_guest_remove", { guest_id: g.guest_id });
      if (!out?.ok) return oops("That didn't go through.");
      return back(own, "guests", { done: "removed" });
    }

    case "list": {
      const visible = f.get("visible") === "1";
      if (step === "edit") return back(own, "guests");
      if (!!own.guest_list_visible === visible) return back(own, "guests");
      const plan = events.listOpenPlan(own);
      const pin = plan.ids.join(".") || "none";
      const host = visible ? events.hostWouldList(own) : null;
      const review = (notice = null) => page(200, renderConfirm({
        ev: own, notice,
        title: visible ? "Show the guest list to guests?" : "Make the guest list private?",
        sentences: visible
          ? [
            "Guests will see who's going: only the people who chose to be on it, by the name they picked. Never a phone number.",
            ...(plan.off
              ? [`${plural(plan.off, "guest")} joined while it was private, so they never chose it. They stay off it unless they say they want to be on it.`,
                plan.asked ? `Reason texts ${plan.asked === plan.off ? (plan.asked === 1 ? "them" : "each of them") : `${plan.asked} of them`} once to ask, never at night.${plan.off > plan.asked ? ` ${plan.off - plan.asked} won't be texted: they muted the event or were already asked.` : ""}` : "None of them will be texted: they muted the event or were already asked."]
              : ["Nobody gets a text."]),
            ...(host ? [`You go on it too, as ${host}. You can take yourself off on your guest list page.`] : []),
          ]
          : ["Guests stop seeing who else is going. Nobody is texted.", "Everyone's own choice is kept, so if you show it again, the people who chose to be on it are back on it."],
        extra: visible && plan.asked ? whoList({ guests: plan.asked, names: plan.names }).replace("WHO GETS IT", "WHO GETS ASKED") : "",
        preview: visible && plan.asked ? plan.body : null, previewLabel: plan.asked === 1 ? "THEY GET THIS TEXT" : "EACH OF THEM GETS THIS TEXT",
        fields: { action: "list", step: "do", visible: visible ? "1" : "0", pin },
        confirm: visible ? (plan.asked ? `Show it and ask ${plural(plan.asked, "guest")}` : "Show the list") : "Make it private", back: "Leave it as it is",
      }));
      if (step === "review") return review();
      if (step !== "do") return redirect(homePath(own));
      // Who gets asked is checked again: a guest who joined or muted since the review is shown first.
      if (visible && f.get("pin") !== pin) return review("Who gets asked changed since you looked. Check it again.");
      const out = await run("event_settings", { guest_list_visible: visible });
      if (!out?.ok) return oops("That didn't go through. Nothing changed.");
      log({ event_manage_list: own.id, visible, asked: out.asked ?? 0 });
      return back(own, "guests", visible ? { done: "list_shown", n: String(out.asked ?? 0) } : { done: "list_hidden" });
    }

    case "cap": {
      const raw = String(f.get("capacity") ?? "").trim();
      if (step === "edit") return again(null, { cap: raw });
      const cap = raw === "" ? null : /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
      if (cap !== null && !(cap >= 1 && cap <= 100000)) return oops("The cap has to be a whole number from 1 to 100,000, or empty for no cap.", { cap: raw });
      if ((own.capacity ?? null) === cap) return back(own, "guests", { done: "nothing_cap" });
      const going = events.capacityState(own).going;
      // Only a cap that closes joining is asked about first: it is the one that changes who can get in.
      if (step === "review" && cap != null && cap <= going) {
        return page(200, renderConfirm({
          ev: own, title: `Set the cap to ${cap}?`,
          sentences: [
            cap < going ? `${plural(going, "guest")} are already in, more than ${cap}. Nobody is taken off the event.` : `That's exactly how many are in now (${going}).`,
            `New joins close: anyone who tries is told the event is full. A spot opens only once enough guests leave to get under ${cap}.`,
            "Guests aren't told about the cap, and nobody is texted.",
          ],
          fields: { action: "cap", step: "do", capacity: String(cap) },
          confirm: "Set the cap", back: "Change it",
        }));
      }
      if (step !== "review" && step !== "do") return redirect(homePath(own));
      const out = await run("event_settings", cap == null ? { no_cap: true } : { capacity: cap });
      if (!out?.ok) return oops("That didn't save. The cap is what it was.", { cap: raw });
      log({ event_manage_cap: own.id, capacity: cap });
      return back(own, "guests", { done: "cap_saved" });
    }

    case "question": {
      const qidRaw = f.get("qid");
      const qid = qidRaw != null && /^\d{1,12}$/.test(qidRaw) ? Number(qidRaw) : null;
      const kind = f.get("kind") === "choice" ? "choice" : "text";
      const required = f.get("required") === "1";
      const draft = { qid, prompt: String(f.get("prompt") ?? "").slice(0, 400), kind, choices: String(f.get("choices") ?? "").slice(0, 600), required };
      if (step === "edit") return again(null, { question: draft });
      const input = { questionId: qid, kind, prompt: draft.prompt, choices: kind === "choice" ? draft.choices : null, required };
      const plan = questions.planQuestion(own, input);
      if (!plan.ok) return oops(questions.WHY[plan.problem] ?? "That question can't be saved.", { question: draft });
      const q = plan.question;
      const onlyRequired = qid != null && !plan.words_change;
      if (step === "review") {
        if (onlyRequired && !plan.required_change) return back(own, "questions");
        const already = questions.alreadyIn(own);
        return page(200, renderConfirm({
          ev: own, title: onlyRequired ? (q.required ? "Ask everyone this one?" : "Make it optional?") : qid != null ? "Change it to this?" : "Ask guests this?",
          sentences: [
            q.required
              ? "New guests have to answer it to join: the join page won't go through without it, and by text Reason asks it before they're in."
              : "New guests see it on the join page, under their name. It's optional: they can skip it, and joining never waits on it.",
            ...(q.required ? [] : ["When someone joins by text, Reason asks it right after they're in."]),
            ...(qid == null && already ? [`The ${plural(already, "guest")} already in aren't texted by this${q.required ? ", and aren't held to it" : ""}. You can have Reason text them the question next.`] : []),
            ...(onlyRequired && q.required ? ["Guests already in aren't held to it, and nobody is texted."] : []),
            ...(onlyRequired && !q.required ? ["Answers already given stand, and nobody is texted."] : []),
            "Only you will see the answers.",
          ],
          extra: questionPreview(q),
          fields: { action: "question", step: "do", ...(qid != null ? { qid: String(qid) } : {}), prompt: q.prompt, kind: q.kind, choices: (q.choices ?? []).join("\n"), ...(q.required ? { required: "1" } : {}) },
          confirm: onlyRequired ? (q.required ? "Ask everyone" : "Make it optional") : qid != null ? "Save the new wording" : "Add the question", back: "Change it",
        }));
      }
      if (step !== "do") return redirect(homePath(own));
      const out = await run("event_questions", qid != null
        ? { action: "change", question_id: qid, prompt: q.prompt, kind: q.kind, ...(q.choices ? { choices: q.choices } : {}), required: q.required }
        : { action: "add", prompt: q.prompt, kind: q.kind, ...(q.choices ? { choices: q.choices } : {}), required: q.required });
      if (!out?.ok) return oops(questions.WHY[out?.problem] ?? "That didn't save.", { question: draft });
      log({ event_manage_question: own.id, reworded: qid != null, required: q.required });
      if (qid != null) return back(own, "questions", onlyRequired ? { done: q.required ? "question_required" : "question_optional" } : { done: "question_reworded" });
      // Added: the offer to text the guests already in, as a confirm step of its own (declining texts nobody).
      const added = db.eventQuestion(own.id, out.question.question_id);
      if (added && questions.askPlan(own, added).asked) return askConfirm(own, added);
      return back(own, "questions", { done: "question_added", g: String(questions.alreadyIn(own)) });
    }

    case "question_ask": {
      const qid = Number(f.get("qid"));
      const q = Number.isInteger(qid) ? db.eventQuestion(own.id, qid) : null;
      if (!q) return oops(questions.WHY.not_found);
      if (step === "edit" || step === "skip") return back(own, "questions", { done: "question_not_asked", g: String(questions.alreadyIn(own)) });
      if (step === "review") return questions.askPlan(own, q).asked ? askConfirm(own, q) : oops(questions.WHY.nobody_to_ask);
      if (step !== "do") return redirect(homePath(own));
      if (own.status === "paused") return oops("Reason's operator has paused this event, so nothing goes out to guests right now.");
      // Who gets it is checked again: a guest who joined, answered, left or muted since the preview is shown first.
      if (f.get("pin") !== askPin(own, q)) {
        return questions.askPlan(own, q).asked ? askConfirm(own, q, "Who gets it changed since you looked. Check the list again before sending.") : oops(questions.WHY.nobody_to_ask);
      }
      const out = await run("event_questions", { action: "ask_guests", question_id: q.id });
      if (!out?.ok) return oops(out?.error ?? "That didn't go through. Nobody was texted.");
      log({ event_manage_question_ask: own.id, asked: out.asked });
      return back(own, "questions", { done: "question_asked", n: String(out.asked ?? 0) });
    }

    case "question_remove": {
      const qid = Number(f.get("qid"));
      if (step === "edit") return back(own, "questions");
      const q = Number.isInteger(qid) ? db_question(own, qid) : null;
      if (!q) return oops(questions.WHY.not_found);
      const n = questions.answerCount(qid);
      const confirmRemove = (count, notice = null) => page(200, renderConfirm({
        ev: own, title: "Remove this question?", danger: true, notice,
        sentences: [`${plural(count, "guest")} answered it. Removing it deletes ${count === 1 ? "that answer" : "those answers"} for good.`, "New guests won't be asked it. Nobody is texted."],
        extra: questionPreview(q),
        fields: { action: "question_remove", step: "do", qid: String(qid), n: String(count) },
        confirm: count === 1 ? "Remove it and its answer" : `Remove it and ${count} answers`, back: "Keep it",
      }));
      if (step === "review" && n > 0) return confirmRemove(n);
      if (step !== "review" && step !== "do") return redirect(homePath(own));
      // The answers that go are the ones the organizer was shown: more since then, and they see it again.
      if (n > 0 && f.get("n") !== String(n)) return confirmRemove(n, "More guests answered since you looked. Check it again.");
      const out = await run("event_questions", { action: "remove", question_id: qid, delete_answers: n > 0 });
      // The first answer landed between the check and the removal: shown the count, never the model's words.
      if (out?.problem === "has_answers") return confirmRemove(out.answers, "A guest answered it just now. Check it again.");
      if (!out?.ok) return oops("That didn't go through. The question is still there.");
      return back(own, "questions", { done: "question_removed", n: String(out.answers_deleted ?? 0) });
    }

    case "password": {
      const pw = String(f.get("password") ?? "");
      if (step === "edit") return back(own, "access");
      const problem = events.passwordProblem(pw);
      if (problem || pw.length > LIMITS.password) return oops(problem === "too_short" ? "The password needs at least 4 characters." : "That password is too long.");
      if (step === "review") {
        return page(200, renderConfirm({
          ev: own, title: "Change the password?",
          sentences: [
            "Everyone already in stays in. The old password stops working for new joins, including anybody halfway through the join page.",
            "Nobody is texted. You'll see the new password once, with an invite ready to forward.",
          ],
          fields: { action: "password", step: "do", password: pw },
          confirm: "Change it", back: "Keep the old one",
        }));
      }
      const out = await run("event_password_rotate", { new_password: pw });
      if (!out?.ok) return oops("That didn't go through. The old password still works.");
      log({ event_manage_password: own.id });
      return page(200, renderNewPassword({ ev: own, password: pw }));
    }

    // ---- the help line (src/eventhelpline.js), through the same tools a text uses ----
    case "help_on":
    case "help_off": {
      const out = await run("event_help_line", { action: action === "help_on" ? "on" : "off" });
      if (!out?.ok) return oops("That didn't go through.");
      return back(own, "help", { done: action });
    }
    case "help_ticket": {
      const raw = f.get("clear") === "1" ? "" : String(f.get("ticket_link") ?? "");
      const out = await run("event_help_line", { action: "ticket_link", ticket_link: raw.slice(0, 600) });
      if (!out?.ok) return oops("That doesn't look like a web link. Paste the ticket page's link, starting with https://", { ticket: raw });
      return back(own, "help", { done: raw.trim() ? "help_ticket" : "help_ticket_cleared" });
    }
    case "help_host": {
      const raw = String(f.get("host_name") ?? "");
      const out = await run("event_help_line", { action: "host_name", host_name: raw.slice(0, 120) });
      if (!out?.ok) return oops("That didn't save.", { host: raw });
      return back(own, "help", { done: "help_host" });
    }
    case "help_reply": {
      const message = String(f.get("message") ?? "");
      if (!message.trim()) return oops("Write the answer first.");
      // This event's questions only, from this event's page.
      const out = await helpline.replyToAsk({ runtime, organizerConversationId: c, askId: Number(f.get("ask_id")) || 0, message: message.slice(0, 1500), eventId: own.id });
      if (!out?.ok) return oops("That question isn't on this event any more.");
      return back(own, "help", { done: "help_replied" });
    }

    case "rides": {
      if (!rides.canEnable(own)) return redirect(homePath(own));
      const enabled = f.get("enabled") === "1";
      if (step === "edit") return back(own, "more");
      if (enabled && step === "review") {
        return page(200, renderConfirm({
          ev: own, title: "Turn on ride sharing?",
          sentences: [
            "Reason asks each guest once, the day before, whether they're driving with a seat or need a ride, and suggests one match at a time. Nothing is set until both guests agree.",
            "You only ever see counts, never who rides with whom.",
          ],
          fields: { action: "rides", step: "do", enabled: "1" }, confirm: "Turn it on", back: "Leave it off",
        }));
      }
      const out = await run("event_rides_setting", { enabled });
      if (!out?.ok) return oops("That didn't go through.");
      return back(own, "more", { done: enabled ? "rides_on" : "rides_off" });
    }

    case "cover_remove":
    case "cover_discard": {
      const removing = action === "cover_remove";
      if (step === "edit") return back(own, "more");
      if (step === "review") {
        return page(200, renderConfirm({
          ev: own, title: removing ? "Go back to Reason's cover?" : "Drop the waiting picture?",
          sentences: [removing
            ? "Your picture comes off the link's card and Reason's drawn cover with the event name goes back on. Phones that already showed the old card may keep it until the link is sent again. Nobody is texted."
            : "The picture waiting for your OK is dropped. The card stays as it is now. Nobody is texted."],
          fields: { action, step: "do" }, confirm: removing ? "Use Reason's cover" : "Drop it", back: "Keep it",
        }));
      }
      const out = await run("event_cover", { action: removing ? "remove" : "discard" });
      if (!out?.ok) return oops("That didn't go through.");
      return back(own, "more", { done: removing ? "cover_removed" : "cover_discarded" });
    }

    case "cancel": {
      const message = String(f.get("message") ?? "");
      if (step === "edit") return again(null, { cancel: { message } });
      if (message.length > LIMITS.cancel) return oops(`The line to guests can be up to ${LIMITS.cancel} characters.`, { cancel: { message } });
      // The typed name is the deliberate act, checked on both posts: a confirm page cannot be skipped to.
      if (events.nameKey(f.get("confirm_name")) !== own.name_key) return oops("To cancel, type the event's name exactly as it's shown at the top.", { cancel: { message } });
      if (step === "review") {
        const aud = events.audience(own, "cancel");
        return page(200, renderConfirm({
          ev: own, title: "Cancel the event for good?",
          sentences: [
            `Reason texts ${aud.guests ? `all ${plural(aud.guests, "guest")} (muted ones too)` : "your guests (nobody has joined yet)"} that it's cancelled. The join page and the guest list close.`,
            "This can't be undone.",
          ],
          preview: tools.cancelBody(own, message, { wasPaused: own.status === "paused" }),
          fields: { action: "cancel", step: "do", message, confirm_name: f.get("confirm_name") ?? "" },
          confirm: "Cancel the event", back: "Keep the event", danger: true,
        }));
      }
      if (step !== "do") return redirect(homePath(own));
      const out = await run("event_cancel", { ...(message.trim() ? { message } : {}) });
      if (!out?.ok) return oops("That didn't go through. The event is still on.");
      log({ event_manage_cancelled: own.id, guests: out.sent?.guests ?? 0, refunds: out.refunds?.refunded ?? 0 });
      return redirect(homePath(own));
    }

    // ---------- tickets and payouts (src/eventpay.js) ----------

    case "payouts": {
      if (!money) return redirect(homePath(own));
      if (eventpay.payoutsReady(c)) return back(own, "money", { done: "payouts_ready" });
      // Stripe's own onboarding for their Express account; back to this page after (GET /payouts).
      const link = await eventpay.onboardingLink(c, own, { fetchImpl: globalThis.fetch });
      if (!link.ok) {
        log({ event_manage_payouts_failed: own.id, status: link.status ?? null, code: link.code ?? null, error: String(link.error ?? "").slice(0, 200) });
        return oops("Stripe couldn't start the payouts setup just now. Try again in a few minutes.");
      }
      log({ event_manage_payouts: own.id, made: !!link.row });
      return redirect(link.url);
    }

    case "price": {
      if (!money) return redirect(homePath(own));
      const raw = String(f.get("price") ?? "").trim();
      if (step === "edit") return again(null, { price: raw });
      const cents = eventpay.parseDollars(raw);
      const problem = cents == null ? "bad_price" : eventpay.priceProblem(cents);
      if (problem) return oops({ too_low: `The lowest price is ${eventpay.dollars(eventpay.MIN_PRICE_CENTS)} per person.`, too_high: `The highest price is ${eventpay.dollars(eventpay.MAX_PRICE_CENTS)} per person for now.`, bad_price: "Put in a price in dollars, like 25 or 12.50." }[problem], { price: raw });
      if (!eventpay.payoutsReady(c)) return oops("Set up payouts with Stripe first; then the price.", { price: raw });
      if ((own.price_cents ?? null) === cents) return back(own, "money", { done: "price_saved" });
      const qt = eventpay.quote(cents);
      if (step === "review") {
        return page(200, renderConfirm({
          ev: own, title: eventpay.priced(own) ? `Change the price to ${eventpay.dollars(cents)}?` : `Charge ${eventpay.dollars(cents)} a person?`,
          sentences: [
            `Guests pay ${eventpay.dollars(qt.total)}: your ${eventpay.dollars(qt.price)} plus ${eventpay.dollars(qt.processing)} of Stripe's processing, shown to them as one line. You get ${eventpay.dollars(qt.organizer_gets)} per person; Reason keeps 2.5% (${eventpay.dollars(qt.reason_fee)}).`,
            "Guests pay on Stripe's secure page when they join (Apple Pay works) and are on the event once the payment goes through. Their spot is held for 15 minutes while they pay.",
            eventpay.priced(own) ? "People already in paid the old price and aren't charged or refunded. Nobody is texted." : "Nobody already in is charged. Nobody is texted.",
          ],
          fields: { action: "price", step: "do", price: raw }, confirm: eventpay.priced(own) ? "Change the price" : `Charge ${eventpay.dollars(cents)}`, back: "Change it",
        }));
      }
      if (step !== "do") return redirect(homePath(own));
      const out = await run("event_price", { price_dollars: cents / 100 });
      if (!out?.ok) return oops("That didn't save. The price is what it was.", { price: raw });
      log({ event_manage_price: own.id, cents });
      return back(own, "money", { done: "price_saved" });
    }

    case "free": {
      if (!money) return redirect(homePath(own));
      if (step === "edit") return back(own, "money");
      if (!eventpay.priced(own)) return back(own, "money", { done: "price_free" });
      if (step === "review") {
        const s = eventpay.summary(own);
        return page(200, renderConfirm({
          ev: own, title: "Make it free to join?",
          sentences: ["Guests who join from now on pay nothing.", s.paid_count ? `The ${plural(s.paid_count, "guest")} who already paid keep their spot and aren't refunded by this. To give one their money back, refund them in Tickets.` : "Nobody has paid, so nobody is affected.", "Nobody is texted."],
          fields: { action: "free", step: "do" }, confirm: "Make it free", back: "Keep the price",
        }));
      }
      if (step !== "do") return redirect(homePath(own));
      const out = await run("event_price", { free: true });
      if (!out?.ok) return oops("That didn't save. The price is what it was.");
      return back(own, "money", { done: "price_free" });
    }

    case "refund": {
      if (!money) return redirect(homePath(own));
      const id = Number.parseInt(f.get("payment") ?? "", 10);
      const g = Number.isInteger(id) && id > 0 ? eventpay.paidGuests(own).find(x => x.payment_id === id) : null;
      if (!g) return oops("That payment isn't one that can be refunded any more.");
      if (step === "edit") return back(own, "money");
      if (step === "review") {
        return page(200, renderConfirm({
          ev: own, title: `Refund ${g.display_name || "this guest"} ${eventpay.dollars(g.total_cents)}?`,
          sentences: [
            `They get the whole ${eventpay.dollars(g.total_cents)} back — your ${eventpay.dollars(g.price_cents)} and the processing — on their card in a few days. Reason's fee goes back too; Stripe keeps its processing, which comes out of Reason, not you.`,
            "They come off the event and lose its updates; they could join again by paying again. Reason texts them this:",
          ],
          preview: eventpay.refundedBody(own, g.total_cents), previewLabel: "THEY GET THIS TEXT",
          fields: { action: "refund", step: "do", payment: String(g.payment_id) }, confirm: `Refund ${eventpay.dollars(g.total_cents)}`, back: "Keep it", danger: true,
        }));
      }
      if (step !== "do") return redirect(homePath(own));
      if (!g.guest_id) return oops("That guest's row is gone; refund them from your Stripe dashboard.");
      const out = await run("event_refund", { guest_id: g.guest_id });
      if (!out?.ok) return oops(out?.error ? "Stripe didn't take the refund just now. Nothing changed; try again in a few minutes." : "That didn't go through.");
      log({ event_manage_refund: own.id, payment: g.payment_id });
      return back(own, "money", { done: "refunded" });
    }

    case "dashboard": {
      if (!money) return redirect(homePath(own));
      const link = await eventpay.dashboardLink(c, { fetchImpl: globalThis.fetch });
      if (!link.ok) return oops(link.reason === "no_account" ? "Set up payouts first." : "Stripe couldn't open your dashboard just now. Try again in a minute.");
      return redirect(link.url);
    }
  }
  return redirect(homePath(own));
}
