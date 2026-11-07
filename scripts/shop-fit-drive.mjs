// Real-model check of store_checkout's variant read (src/shoptools.js checkFit) on the subscription CLI:
//   CLAUDE_CODE_OAUTH_TOKEN=… REASON_BACKEND=claude-cli node scripts/shop-fit-drive.mjs "$PWD" [rounds] [parallel]
// The CLI child runs in a scratch REASON_CLI_HOME of its own (src/backends/cli.js sealedCliHome), never the
// shared ~/.reason-cli: a CLAUDE_CONFIG_DIR set outside is replaced by the sealed one. A failed read prints why.
// 2026-11-07: 6/6 (haiku). After the retry (fit-errors): see the PR.
const wt = process.argv[2];
const rounds = Number(process.argv[3] || 1), parallel = Number(process.argv[4] || 1);
const os = await import("node:os"), fs = await import("node:fs"), path = await import("node:path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fit-drive-"));
process.env.REASON_DB_PATH = `${tmp}/reason.db`; process.env.REASON_DATA_DIR = tmp;
process.env.REASON_CLI_HOME ||= path.join(tmp, "cli");
const { checkFit } = await import(`${wt}/src/shoptools.js`);
const cases = [
  ["mismatch", { texts: ["Buy me the CeraVe face wash, the one for dry skin"], need: "for dry skin", item: "CeraVe Foaming Facial Cleanser 16 oz", what: "One CeraVe Foaming Facial Cleanser, 16 oz" }],
  ["fits", { texts: ["Buy me the CeraVe face wash, the one for dry skin"], need: "for dry skin", item: "CeraVe Hydrating Facial Cleanser 16 oz", what: "One CeraVe Hydrating Facial Cleanser, 16 oz" }],
  ["unclear|fits", { texts: ["get me a cerave face wash"], need: "", item: "CeraVe Foaming Facial Cleanser 16 oz", what: "One CeraVe Foaming Facial Cleanser" }],
  ["mismatch", { texts: ["I need a MagSafe case for my iPhone 16 Pro"], need: "iPhone 16 Pro", item: "OtterBox Symmetry for iPhone 15", what: "OtterBox Symmetry Series case for iPhone 15, MagSafe" }],
  ["fits|unclear", { texts: ["my skin gets really oily by noon, grab me a cleanser"], need: "oily skin", item: "CeraVe Foaming Facial Cleanser 16 oz", what: "One CeraVe Foaming Facial Cleanser" }],
  ["fits|unclear", { texts: ["the cheapest one is fine, any store"], need: "", item: "CeraVe Hydrating Facial Cleanser 12 oz at Walmart", what: "One 12 oz" }],
];
const jobs = Array.from({ length: rounds }, () => cases).flat();
let ok = 0, errors = 0, next = 0;
await Promise.all(Array.from({ length: parallel }, async () => {
  while (next < jobs.length) {
    const [want, c] = jobs[next++];
    const t0 = Date.now();
    const r = await checkFit(c);
    const pass = want.split("|").includes(r.verdict) && !r.error;
    ok += pass; errors += r.error ? 1 : 0;
    console.log(pass ? "PASS" : "FAIL", want, "->", r.verdict, `${((Date.now() - t0) / 1000).toFixed(1)}s`, r.error ? `ERROR ${r.why}` : "");
  }
}));
console.log(`${ok}/${jobs.length} right, ${errors} errors`);
