// Real-model check of store_checkout's variant read (src/shoptools.js checkFit) on the subscription CLI:
//   CLAUDE_CODE_OAUTH_TOKEN=… CLAUDE_CONFIG_DIR=<scratch> REASON_BACKEND=claude-cli node scripts/shop-fit-drive.mjs "$PWD"
// 2026-11-07: 6/6 (haiku).
const wt = process.argv[2];
const tmp = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "fit-drive-"));
process.env.REASON_DB_PATH = `${tmp}/reason.db`; process.env.REASON_DATA_DIR = tmp;
const { checkFit } = await import(`${wt}/src/shoptools.js`);
const cases = [
  ["mismatch", { texts: ["Buy me the CeraVe face wash, the one for dry skin"], need: "for dry skin", item: "CeraVe Foaming Facial Cleanser 16 oz", what: "One CeraVe Foaming Facial Cleanser, 16 oz" }],
  ["fits", { texts: ["Buy me the CeraVe face wash, the one for dry skin"], need: "for dry skin", item: "CeraVe Hydrating Facial Cleanser 16 oz", what: "One CeraVe Hydrating Facial Cleanser, 16 oz" }],
  ["unclear|fits", { texts: ["get me a cerave face wash"], need: "", item: "CeraVe Foaming Facial Cleanser 16 oz", what: "One CeraVe Foaming Facial Cleanser" }],
  ["mismatch", { texts: ["I need a MagSafe case for my iPhone 16 Pro"], need: "iPhone 16 Pro", item: "OtterBox Symmetry for iPhone 15", what: "OtterBox Symmetry Series case for iPhone 15, MagSafe" }],
  ["fits|unclear", { texts: ["my skin gets really oily by noon, grab me a cleanser"], need: "oily skin", item: "CeraVe Foaming Facial Cleanser 16 oz", what: "One CeraVe Foaming Facial Cleanser" }],
  ["fits|unclear", { texts: ["the cheapest one is fine, any store"], need: "", item: "CeraVe Hydrating Facial Cleanser 12 oz at Walmart", what: "One 12 oz" }],
];
let ok = 0;
for (const [want, c] of cases) { const r = await checkFit(c); const pass = want.split("|").includes(r.verdict); ok += pass; console.log(pass ? "PASS" : "FAIL", want, "->", JSON.stringify(r)); }
console.log(`${ok}/${cases.length}`);
