// How the status page looks. The verdicts come from src/ops.js; nothing here decides anything.
//
// One word at the top, then the checks in the order somebody worried would want them: is it
// alive, who is using it, are the services it leans on working, is its memory working, what is
// money doing, and how it has been behaving. Each row is a light, a name, and the one line that
// says why. Rows for things not set up are dimmed rather than hidden, so "why is X not on here"
// has an answer on the page.
import { shell, esc } from "./render.js";
import { STALE_AFTER_MS, ago } from "../ops.js";

export const GROUPS = [
  ["alive", "Is it alive"],
  ["people", "People"],
  ["services", "Services and credit"],
  ["memory", "Memory"],
  ["money", "Money"],
  ["quality", "How it is behaving"],
];

const CSS = `
.ck{align-items:flex-start}
.led{flex:none;width:.62rem;height:.62rem;border-radius:50%;margin-top:.5rem;background:var(--dim)}
.ck-ok .led{background:#17794a}
.ck-warn .led{background:#b25f00}
.ck-bad .led{background:#b4232a}
.ck-off{opacity:.55}
.ck .rd{font-size:.92rem;margin-top:.1rem}
.ck .rv{font-weight:500;color:var(--dim);text-decoration:none;font-size:.86rem;white-space:nowrap;margin-top:.15rem}
.ck .rv:hover{color:var(--ink)}
.since{color:var(--dim);font-size:.8rem;margin-left:.4rem;font-weight:400}
.s-warn{--sc:#b25f00}
.status .sx p{margin:.3rem 0 0}
.op{color:var(--dim);font-weight:400;font-size:.8rem;margin-left:.3rem}
`;

/**
 * The page. `report` is the last saved pass (or null before the first); `now` decides whether it
 * is stale, which is itself a red: a green from forty minutes ago is not a green.
 */
export function renderOps({ report, now = Date.now() }) {
  const head = `<meta http-equiv="refresh" content="120">`;
  if (!report) {
    const body = status("working", "Checking", "First check runs a few seconds after start.", "This page refreshes itself.");
    return shell({ title: "Reason status", body, pill: "Checking", css: CSS, head });
  }
  const age = now - report.at;
  const stale = age > STALE_AFTER_MS;
  const bad = report.checks.filter(c => c.state === "bad").length;
  const warn = report.checks.filter(c => c.state === "warn").length;
  const verdict = stale ? "bad" : report.verdict;

  const top = stale
    ? status("failed", "Needs you", `The checks themselves have stopped: the last pass was ${ago(age)} ago.`, "Reason may be down or stuck. The rows below are from that last pass.")
    : verdict === "ok"
      ? status("done", "All green", "Reason is healthy.", `Checked ${ago(age)} ago · ${report.checks.length} checks, every one fine · refreshes itself`)
      : verdict === "bad"
        ? status("failed", "Needs you", `${count(bad, "thing")} ${bad === 1 ? "is" : "are"} wrong${warn ? `, ${count(warn, "more")} to look at` : ""}.`, `Checked ${ago(age)} ago · ${report.checks.length} checks · refreshes itself`)
        : status("warn", "Look at this", `Reason is up. ${count(warn, "thing")} to look at.`, `Checked ${ago(age)} ago · ${report.checks.length} checks · refreshes itself`);

  const groups = GROUPS.map(([key, title]) => {
    const rows = report.checks.filter(c => c.group === key);
    if (!rows.length) return "";
    const extra = key === "people" ? peopleTable(report.people ?? [], now) : "";
    return `<h2>${esc(title)}</h2><div class="rows">${rows.map(r => row(r, now)).join("")}</div>${extra}`;
  }).join("");

  return shell({ title: "Reason status", body: top + groups, pill: pillFor(verdict), css: CSS, head });
}

function status(kind, label, headline, meta) {
  return `<div class="status s-${esc(kind)}"><div class="sl"><span class="sd"></span>${esc(label)}</div>`
    + `<div class="sh">${esc(headline)}</div><div class="sx"><p>${esc(meta)}</p></div></div>`;
}

function row(c, now) {
  const since = c.since && c.state !== "ok" && c.state !== "off" ? `<span class="since">for ${esc(ago(now - c.since))}</span>` : "";
  const link = c.link ? `<a class="rv" href="${esc(c.link)}" rel="noopener">Dashboard ›</a>` : "";
  return `<div class="row ck ck-${esc(c.state)}"><span class="led" aria-label="${esc(c.state)}"></span>`
    + `<div class="rm"><div class="rn">${esc(c.label)}${since}</div><div class="rd">${esc(c.detail)}</div></div>${link}</div>`;
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
