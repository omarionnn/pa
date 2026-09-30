// Terminal console: talk to Reason before any phone number exists.
//   /skip 2h     move Reason's clock forward (fires timers that come due)
//   /plans       dump plans from the DB
//   /timers      dump pending timers
//   /ledger      every action that touched the outside world, with receipts
//   /accounts    what Reason can reach, and what it can't
//   /reset       wipe this conversation's history (plans stay)
//   /log         toggle tool + usage logging
import readline from "node:readline";
import { Runtime } from "./runtime.js";
import { clock, stamp, config } from "./config.js";
import { listPlans, listTimers, clearConversation, listActions } from "./db.js";
import { listAccounts } from "./trust.js";

const CONV = process.env.REASON_CONVERSATION || "dm:owner";
let verbose = process.argv.includes("--log");
const rt = new Runtime({ log: (e) => { if (verbose) console.log("   ·", JSON.stringify(e)); } });
rt.on("outbound", ({ text, fromTimer }) => console.log(`${fromTimer ? "⏰ " : ""}reason> ${text}\n`));
rt.on("error", (e) => console.error("runtime error:", e));
rt.start(5_000);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`Reason console · model ${config.model} · conversation ${CONV} · clock ${stamp()}\n(type /help for commands)\n`);

function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/i.exec(s?.trim() ?? "");
  if (!m) return null;
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()];
}

async function command(line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case "help": console.log("/skip 2h · /plans · /timers · /ledger · /accounts · /reset · /log · /quit\n"); break;
    case "skip": {
      const ms = parseDuration(rest.join(" "));
      if (!ms) { console.log("usage: /skip 90m | /skip 2h | /skip 1d\n"); break; }
      clock.skip(ms);
      console.log(`clock → ${stamp()}`);
      const n = await rt.tick();
      if (!n) console.log("(no timers due)\n");
      break;
    }
    case "plans": console.log(JSON.stringify(listPlans(CONV, { includeClosed: true }), null, 2), "\n"); break;
    case "timers": console.log(JSON.stringify(listTimers(CONV).map(t => ({ ...t, fires: stamp(t.fire_at) })), null, 2), "\n"); break;
    case "ledger": {
      const rows = listActions(CONV, { limit: 50 });
      if (!rows.length) console.log("(ledger empty — nothing outside this machine has been touched here)\n");
      else console.log(rows.map(a => `#${a.id} ${stamp(a.at)} [${a.outcome}] ${a.receipt}`).join("\n"), "\n");
      break;
    }
    case "accounts": console.log(JSON.stringify(listAccounts(), null, 2), "\n"); break;
    case "reset": clearConversation(CONV); console.log("conversation cleared\n"); break;
    case "log": verbose = !verbose; console.log(`logging ${verbose ? "on" : "off"}\n`); break;
    case "quit": case "exit": process.exit(0);
    default: console.log("unknown command; /help\n");
  }
}

function prompt() {
  rl.question("you> ", async (line) => {
    line = line.trim();
    try {
      if (!line) {}
      else if (line.startsWith("/")) await command(line);
      else {
        const reply = await rt.inbound(CONV, line);
        if (reply === null) console.log("reason> (chose not to reply)\n");
      }
    } catch (e) { console.error("error:", e.message ?? e); }
    prompt();
  });
}
prompt();
