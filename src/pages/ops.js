// How the status page looks. The verdicts come from src/ops.js; nothing here decides anything.
//
// One word at the top, then the checks as cards on a grid, so a laptop sees the whole thing at
// once and a phone sees one card after another (2026-10-18, Omari: "I have to just keep
// scrolling"). Inside a card the rows are sorted worst first, so what is wrong is at the top of
// every card and the dimmed "not set up" rows sit at the bottom. Each row is a light, a name, and
// the one line that says why. Rows for things not set up are dimmed rather than hidden, so "why
// is X not on here" has an answer on the page.
//
// Two buttons, both only on the owner's own view: "Check again" runs the pass now, for right
// after a fix; "Clear" on a windowed row restarts its count from this moment, for a red that is
// about things that already happened and have been dealt with.
import { shell, esc } from "./render.js";
import { STALE_AFTER_MS, CLEARABLE, ago } from "../ops.js";

export const GROUPS = [
  ["alive", "Is it alive"],
  ["people", "People"],
  ["memory", "Memory"],
  ["money", "Money"],
  ["quality", "How it is behaving"],
  ["services", "Services and credit"],
];

const RANK = { bad: 0, warn: 1, ok: 2, off: 3 };

const CSS = `
.wrap{max-width:86rem;padding-top:1rem;padding-bottom:1.5rem}
.status{margin:0 0 .9rem;padding:.85rem 1.1rem}
.status .sh{font-size:1.2rem;margin-top:.3rem}
.status .sx{margin-top:.3rem;font-size:.88rem}
.status .sx p{margin:0}
.off{color:var(--dim);font-size:.8rem;margin:.45rem 0 .5rem;opacity:.75}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}
.top .status{flex:1}
/* Cards packed into columns, so a short card sits under another instead of leaving a hole beside a
   tall one; the services card spans the lot at the bottom. On a laptop a row is one line — name,
   then the reason — which is what gets forty checks onto one screen. */
.grid{columns:3 20rem;column-gap:.9rem}
.g{border:1px solid var(--line);border-radius:.75rem;background:var(--card);padding:.7rem 1rem .25rem;min-width:0;break-inside:avoid;margin:0 0 .9rem}
.g h2{margin:0 0 .25rem;font-size:1.02rem}
.g.wide{column-span:all}
.g.wide .rows{display:grid;grid-template-columns:repeat(auto-fit,minmax(19rem,1fr));column-gap:1.6rem}
@media(min-width:60rem){
.ck{padding:.24rem 0}
.g{padding:.6rem .9rem .2rem}
.g h2{font-size:.98rem}
.ck .rm{display:flex;flex-direction:row;flex-wrap:wrap;align-items:baseline;gap:0 .5rem}
.ck .rd{margin-top:0}
.led{margin-top:.42rem}
.g.wide .rows{grid-template-columns:repeat(auto-fit,minmax(17rem,1fr))}
}
.rows{margin:0}
.ck{align-items:flex-start;padding:.5rem 0;gap:.5rem}
.led{flex:none;width:.58rem;height:.58rem;border-radius:50%;margin-top:.45rem;background:var(--dim)}
.ck-ok .led{background:#17794a}
.ck-warn .led{background:#b25f00}
.ck-bad .led{background:#b4232a}
.ck-off{opacity:.5}
.ck .rn{font-size:.92rem;line-height:1.3}
.ck .rd{font-size:.82rem;margin-top:.05rem;color:var(--dim)}
.ck-bad .rd,.ck-warn .rd{color:var(--ink)}
.ck .rv{display:flex;flex-direction:column;align-items:flex-end;gap:.3rem;max-width:none;font-weight:500;font-size:.8rem;white-space:nowrap;margin-top:.1rem}
.ck .rv a{color:var(--dim);text-decoration:none}
.ck .rv a:hover{color:var(--ink)}
.since{color:var(--dim);font-size:.76rem;margin-left:.35rem;font-weight:400}
.s-warn{--sc:#b25f00}
.op{color:var(--dim);font-weight:400;font-size:.76rem;margin-left:.3rem}
form.act{margin:0}
.btn{font:inherit;font-size:.8rem;font-weight:600;padding:.4rem .75rem;border-radius:.5rem;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--ink)}
.btn.sm{padding:.2rem .55rem;font-size:.74rem}
.g .scroll{margin:.4rem 0 .6rem}
.g table{font-size:.84rem}
.g th,.g td{padding:.45rem .55rem}
/* Laptop and up: four columns, and the services card is a column of its own beside the rest
   rather than a band below them — the page is then as tall as its tallest card, one screen. */
@media(min-width:78rem){.grid{columns:4 17rem}.g.wide{column-span:none}.g.wide .rows{display:block}}
@media(max-width:34rem){.top{flex-direction:column}.grid{columns:1}.g.wide .rows{display:block}}
`;

/**
 * The page. `report` is the last saved pass (or null before the first); `now` decides whether it
 * is stale, which is itself a red: a green from forty minutes ago is not a green.
 */
export function renderOps({ report, now = Date.now() }) {
  const head = `<meta http-equiv="refresh" content="120">`;
  const checkAgain = `<form class="act" method="POST" action="/ops"><button class="btn" name="action" value="check">Check again</button></form>`;
  if (!report) {
    const body = `<div class="top">${status("working", "Checking", "First check runs a few seconds after start.", "This page refreshes itself.")}${checkAgain}</div>`;
    return shell({ title: "Reason status", body, pill: "Checking", css: CSS, head });
  }
  const age = now - report.at;
  const stale = age > STALE_AFTER_MS;
  const bad = report.checks.filter(c => c.state === "bad").length;
  const warn = report.checks.filter(c => c.state === "warn").length;
  const verdict = stale ? "bad" : report.verdict;
  const meta = `Checked ${ago(age)} ago · ${report.checks.length} checks · refreshes itself`;

  const top = stale
    ? status("failed", "Needs you", `The checks themselves have stopped: the last pass was ${ago(age)} ago.`, "Reason may be down or stuck. The rows below are from that last pass.")
    : verdict === "ok"
      ? status("done", "All green", "Reason is healthy.", `${meta}, every one fine`)
      : verdict === "bad"
        ? status("failed", "Needs you", `${count(bad, "thing")} ${bad === 1 ? "is" : "are"} wrong${warn ? `, ${count(warn, "more")} to look at` : ""}.`, meta)
        : status("warn", "Look at this", `Reason is up. ${count(warn, "thing")} to look at.`, meta);

  const cards = GROUPS.map(([key, title]) => {
    const all = report.checks.filter(c => c.group === key).sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9));
    if (!all.length) return "";
    // Things not set up are one dim line naming them, not a row each: they are an answer to
    // "why is X not on here", and eight of them were a third of the page.
    const off = all.filter(c => c.state === "off");
    const rows = off.length > 1 ? all.filter(c => c.state !== "off") : all;
    const offLine = off.length > 1 ? `<p class="off">Not set up: ${off.map(c => esc(c.label)).join(", ")}</p>` : "";
    const extra = key === "people" ? peopleTable(report.people ?? [], now) : "";
    return `<section class="g${key === "services" ? " wide" : ""}"><h2>${esc(title)}</h2><div class="rows">${rows.map(r => row(r, now)).join("")}</div>${offLine}${extra}</section>`;
  }).join("");

  const body = `<div class="top">${top}${checkAgain}</div><div class="grid">${cards}</div>`;
  return shell({ title: "Reason status", body, pill: pillFor(verdict), css: CSS, head });
}

function status(kind, label, headline, meta) {
  return `<div class="status s-${esc(kind)}"><div class="sl"><span class="sd"></span>${esc(label)}</div>`
    + `<div class="sh">${esc(headline)}</div><div class="sx"><p>${esc(meta)}</p></div></div>`;
}

function row(c, now) {
  const wrong = c.state === "bad" || c.state === "warn";
  const since = c.since && wrong ? `<span class="since">for ${esc(ago(now - c.since))}</span>` : "";
  const link = c.link ? `<a href="${esc(c.link)}" rel="noopener">Dashboard ›</a>` : "";
  const clear = wrong && CLEARABLE.has(c.id)
    ? `<form class="act" method="POST" action="/ops"><input type="hidden" name="action" value="clear"><button class="btn sm" name="id" value="${esc(c.id)}">Clear</button></form>`
    : "";
  const side = link || clear ? `<div class="rv">${link}${clear}</div>` : "";
  return `<div class="row ck ck-${esc(c.state)}"><span class="led" aria-label="${esc(c.state)}"></span>`
    + `<div class="rm"><div class="rn">${esc(c.label)}${since}</div><div class="rd">${esc(c.detail)}</div></div>${side}</div>`;
}

function peopleTable(people, now) {
  if (!people.length) return "";
  const body = people.map(p => `<tr><td>${esc(p.name || p.address || p.conversation)}${p.operator ? `<span class="op">you</span>` : ""}${p.state !== "active" ? `<span class="op">${esc(p.state)}</span>` : ""}</td>`
    + `<td>${p.last_seen_at ? `${esc(ago(now - p.last_seen_at))} ago` : "never"}</td>`
    + `<td>${p.turns_today}</td><td>${p.open_tasks}</td><td>${p.texts_owed}</td></tr>`).join("");
  return `<div class="scroll"><table><thead><tr><th>Who</th><th>Last seen</th><th>Turns today</th><th>Open tasks</th><th>Texts owed</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function pillFor(verdict) {
  return verdict === "ok" ? "Healthy" : verdict === "bad" ? "Needs you" : "Look";
}

function count(k, one) { return `${k} ${k === 1 ? one : `${one}s`}`; }
