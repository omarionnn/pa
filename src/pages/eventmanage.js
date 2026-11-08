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
import * as events from "../events.js";
import * as tools from "../eventtools.js";
import * as rides from "../eventrides.js";
import * as cover from "../eventcover.js";
import * as albums from "../albums.js";
import * as schedule from "../eventschedule.js";
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
  scheduled: "schedule", sched_changed: "schedule", sched_cancelled: "schedule", reminder_on: "schedule", reminder_off: "schedule", details: "details", details_quiet: "details", nothing: "details", release: "details", removed: "guests", rides_on: "more", rides_off: "more", cover_removed: "more", cover_discarded: "more" };
function doneNote(q, ev) {
  const n = (k) => Math.max(0, Math.min(100000, Number.parseInt(q[k] ?? "0", 10) || 0));
  const reached = () => (n("g") ? `Reached ${n("n")} of ${n("g")}${n("f") ? `; ${n("f")} didn't go through` : ""}.` : "Nobody has joined yet, so nobody was texted.");
  switch (q.done) {
    case "welcome": return "Welcome saved. New guests get it when they join.";
    case "welcome_cleared": return "Welcome cleared. New guests get just the event's details when they join.";
    case "blast": return `Sent. ${reached()}`;
    case "details": return n("g") ? `Saved, and guests were told. ${reached()}` : "Saved.";
    case "details_quiet": return "Saved quietly. That detail is still hidden from guests, so nobody was texted.";
    case "nothing": return "Nothing changed.";
    case "release": return `Shared with guests. ${reached()}`;
    case "removed": return "Taken off the event. They were told, and they can't rejoin with the password.";
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
    default: return "";
  }
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

  const hero = `<div class="mg-hero"><p class="lbl">ONLY YOU SEE THIS PAGE</p><h1>${esc(ev.name)}</h1>`
    + p([v.when ?? "No time set", plural(going, "guest"), v.capacity ? `cap ${v.capacity}` : ""].filter(Boolean).join(" · "), "quiet")
    + `</div>`;
  const banner = (paused ? `<p class="mg-note">Reason's operator has paused this event, so joining is closed and nothing goes out to guests until it's resumed. That isn't something you can undo from here.</p>` : "")
    + (done?.text && !done.section ? noteHtml(done) : "");
  const nav = `<ul class="mg-nav" aria-label="On this page">${[["welcome", "WELCOME"], ["message", "MESSAGE GUESTS"], ["schedule", "SCHEDULED"], ["details", "DETAILS"], ["guests", "GUESTS"], ["access", "SHARING"], ["more", "MORE"]]
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

  // 02 — message everyone
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
  const guests = sec("guests", "05", "Guests",
    `<h2 class="mg-h">${esc(joined.length ? `${plural(joined.length, "guest")} in` : "Nobody yet")}</h2>`
    + p("Names are what each guest chose to show. Phone numbers are never shown, here or anywhere.")
    + (list.length
      ? `<ul class="mg-list">${list.map(g => `<li><div class="mg-who"><b>${esc(g.display_name || "A guest")}</b><span>${esc([
        g.state === "removed" ? "taken off the event" : (g.in_directory ? "on the who's-going list" : "not on the who's-going list"),
        VIA[g.via] ?? "",
      ].filter(Boolean).join(" · "))}${g.instagram ? ` · <a href="${esc(events.instagramUrl(g.instagram))}" rel="noopener noreferrer" target="_blank">@${esc(g.instagram)}</a>` : ""}</span></div>`
        + (g.state === "joined" ? `<form class="mg-f" method="POST" action="__ACTION__">${hidden("action", "remove")}${hidden("step", "review")}${hidden("guest", g.guest_id)}${button("Remove", { cls: "mg-btn quiet", busy: "…" })}</form>` : "")
        + `</li>`).join("")}</ul>`
      : p("Share the link and the password, and guests show up here as they join.", "quiet"))
    + `<div class="mg-row"><a class="mg-btn alt" href="${esc(`/e/${ev.public_id}/who?t=${encodeURIComponent(ev.organizer_token)}`)}">Your guest list page</a></div>`
    + p(ev.guest_list_visible ? "Guests can see the who's-going page (only the people who chose to be on it)." : "You're keeping the guest list private: guests don't see who else is going.", "quiet"));

  // 05 — access and sharing
  const access = sec("access", "06", "Sharing",
    `<h2 class="mg-h">The link and the password</h2>`
    + p("Guests need both: the link opens the join page, and the password lets them in.")
    + `<label class="lbl" for="invite_link">INVITE LINK</label><div class="mg-copy"><input id="invite_link" type="text" readonly value="${esc(link)}"><button class="mg-btn alt" type="button" data-copy="invite_link">Copy</button></div>`
    + p("Reason doesn't keep the password in a form anyone can read back, so it can't be shown here. If you need to share it again, set a new one.", "quiet")
    + form("password", "review", `<label for="new_pw">NEW PASSWORD<input id="new_pw" name="password" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" minlength="4" maxlength="${LIMITS.password}" required></label>`
      + `<div class="mg-row">${button("Change password", { cls: "mg-btn alt", busy: "Opening…" })}</div>`));

  // 06 — the rest
  const hasPicture = cover.hasUploaded(ev);
  const pending = cover.pendingOf(ev);
  const ridesHere = rides.canEnable(ev);
  const more = sec("more", "07", "More",
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
    + p("Every guest is texted that it's cancelled, and the join page and the guest list close. This can't be undone.")
    + form("cancel", "review",
      `<label for="c_msg">A LINE FROM YOU (OPTIONAL)<textarea id="c_msg" name="message" maxlength="${LIMITS.cancel}" rows="2">${esc(drafts.cancel?.message ?? "")}</textarea></label>`
      + `<label for="c_name">TYPE THE EVENT'S NAME TO CONFIRM<input id="c_name" name="confirm_name" type="text" autocomplete="off" required></label>`
      + `<div class="mg-row">${button("Cancel the event", { cls: "mg-btn danger", busy: "Opening…" })}</div>`)
    + `</div></details>`);

  const signOut = `<form method="POST" action="${esc(`/e/${ev.public_id}/signout`)}" style="margin:0"><button class="typed mut" type="submit">SIGN OUT OF THIS BROWSER</button></form>`;
  const main = (hero + banner + nav + welcome + message + scheduled + details + guests + access + more + signOut).split("__ACTION__").join(esc(managePath(ev)));
  const side = `<span class="lbl d">AT A GLANCE</span><p class="quiet d">${esc(`${plural(going, "guest")} in. Time ${v.time_shown_to_guests ? "shared" : "hidden"}, location ${v.location_shown_to_guests ? "shared" : "hidden"}.`)}</p>`
    + `<a class="typed d" href="${esc(link)}">${esc("THE JOIN PAGE GUESTS SEE →")}</a>`;
  return madeDoc({ title: `Your event: ${ev.name}`, kicker: "YOUR EVENT", main, side, head: CSS, script: SCRIPT, foot: "Only you, the organizer, can see this page. Guests never see it. You can also change anything by texting Reason.", url: link });
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
  const SECTION = { welcome: "welcome", blast: "message", schedule: "schedule", sched_cancel: "schedule", reminder: "schedule", details: "details", release: "details", remove: "guests", password: "access", rides: "more", cover_remove: "more", cover_discard: "more", cancel: "more" };
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
      const out = await run("event_schedule", { message, send_at: sendAt, ...pickInput(pickDraft, pick.audience), ...(replacing ? { scheduled_id: replacing } : {}) });
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
      log({ event_manage_cancelled: own.id, guests: out.sent?.guests ?? 0 });
      return redirect(homePath(own));
    }
  }
  return redirect(homePath(own));
}
