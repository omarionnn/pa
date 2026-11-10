// One person's side of an onboarding drive (bin/onboarding-drive.sh), as a readable transcript:
// what they texted and what Reason sent back, with the gap before each of Reason's sends.
//   node onboarding-transcript.cjs <sends.jsonl> <said.jsonl> <number>
const fs = require("fs");
const [cap, saidFile, who] = process.argv.slice(2);
const lines = (f) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const sent = lines(cap).filter(r => r.method === "POST" && /send-message/.test(r.path) && r.body?.number === who)
  .map(r => ({ at: Date.parse(r.at), reason: r.body.media_url ? `${r.body.content ? `${r.body.content} ` : ""}[contact card ${r.body.media_url}]` : (r.body.content ?? "") }));
const said = lines(saidFile).filter(r => (r.who ?? who) === who).map(r => ({ at: Date.parse(r.at), you: r.you }));
if (!said.length) process.exit(0);
console.log(`=== ${who}`);
let prev = null;
for (const m of [...sent, ...said].sort((a, b) => a.at - b.at)) {
  if (m.you != null) { console.log(`\nThem              ${m.you}`); prev = m.at; continue; }
  const gap = prev ? `+${((m.at - prev) / 1000).toFixed(1)}s` : "";
  prev = m.at;
  console.log(`Reason ${gap.padStart(8)}  ${m.reason}`);
}
console.log("");
