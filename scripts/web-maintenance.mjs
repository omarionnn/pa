// Reason Web's maintenance switch (E5, src/pages/webedge.js), from the server's shell.
//
// Owner/ops CLI, run on the server (`/opt/reason`). While it is on, every /web page answers the calm
// "Tidying up for a few minutes" page with BACK BY ABOUT {time} ET, until that time, when it turns
// itself off. Texting Reason is untouched. It writes one row of ops_state in the database — never
// .env — and the running server reads it on the next request, so no restart is needed.
//
//   status:  sudo -u reason node --env-file=.env scripts/web-maintenance.mjs
//   on:      sudo -u reason node --env-file=.env scripts/web-maintenance.mjs on 15:30   (Eastern, 24-hour)
//            sudo -u reason node --env-file=.env scripts/web-maintenance.mjs on 45      (minutes from now)
//   off:     sudo -u reason node --env-file=.env scripts/web-maintenance.mjs off
import { pathToFileURL } from "node:url";
import { maintenance, startMaintenance, endMaintenance, parseUntil, etTime } from "../src/pages/webedge.js";

export function run(argv, now = Date.now()) {
  const [what, when] = argv;
  if (what === "on") {
    const until = parseUntil(when, now);
    if (!until) return { code: 2, out: "Give the time Web should be back: HH:MM in Eastern time (24-hour), or a number of minutes." };
    const r = startMaintenance({ until, by: "cli", now });
    if (!r.ok) return { code: 2, out: r.reason === "too_far" ? "That's more than a day away. Pick a time within the next day." : "That time has already passed." };
    return { code: 0, out: `Web is paused. Back by about ${etTime(until)} ET (turns itself off then).` };
  }
  if (what === "off") {
    endMaintenance();
    return { code: 0, out: "Web is open." };
  }
  if (what && what !== "status") return { code: 2, out: "Use: on <HH:MM|minutes> | off | status" };
  const m = maintenance(now);
  return { code: 0, out: m.on ? `Web is paused. Back by about ${etTime(m.until)} ET (set by ${m.by ?? "?"}).` : "Web is open." };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = run(process.argv.slice(2));
  console.log(r.out);
  process.exit(r.code);
}
