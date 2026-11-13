// What do these sites actually do when Reason's own browser knocks, signed out?
//
// Written because the alternative was guessing. The registry in `src/sites.js` says where to start
// on OpenTable, Uber, Amazon and the rest; whether any of those pages will load at all for a
// headless Chromium with no account is a fact about the real world, and the only way to have it is
// to go and look. So this opens each entry URL and each "am I signed in" URL in a scratch profile,
// writes down the status, the title and what the page said, and classifies the result.
//
//   npm run probe:sites                 # all of them
//   npm run probe:sites -- amazon uber  # just these
//
// It never signs in, never fills anything, never clicks anything, and stops at reading the page.
// A site that answers with a bot check is recorded as `blocked_automation` and left alone — that is
// the finding, not an obstacle. Nothing here spoofs a fingerprint or retries past a refusal.
//
// The report goes to stdout as JSON and to docs/site-probe-<date>.json when --save is passed.
//
// Browser setups (vault PR 2, design section E; src/probesetups.js): one load per sign-in page per
// setup, nothing typed, the never list refused by this script itself.
//   npm run probe:sites -- --setup A0 --list signin-1112 [--save]   # the 11-12 refused pages + controls
//   npm run probe:sites -- --setup A2 --list medium.com,canva.com
//   npm run probe:sites -- --merge docs/site-probe-<date>-setup-A0.json ... [--save]
// A0-A3 run on the server, A4 on the Mac. Without --setup or --merge this script is as it was.
import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const save = args.includes("--save");
const want = args.filter(a => !a.startsWith("--"));

process.env.REASON_DATA_DIR = process.env.REASON_DATA_DIR || mkdtempSync(join(tmpdir(), "reason-probe-"));
const scratch = process.env.REASON_DATA_DIR;

if (args.includes("--setup") || args.includes("--merge")) {
  try {
    await setups();
  } finally {
    // Only the data directory this script made for itself is removed; one handed in is left alone.
    if (!process.env.REASON_KEEP_PROBE_PROFILE && scratch.startsWith(join(tmpdir(), "reason-probe-"))) rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(0);
}

async function setups() {
  const { readFileSync } = await import("node:fs");
  const probe = await import("../src/probesetups.js");
  const valueOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const day = new Date().toISOString().slice(0, 10);
  let out, file;
  if (args.includes("--merge")) {
    const files = args.slice(args.indexOf("--merge") + 1).filter((a) => !a.startsWith("--"));
    out = { merged_at: new Date().toISOString(), ...probe.mergeSetups(files.map((f) => JSON.parse(readFileSync(f, "utf8")))) };
    file = `docs/site-probe-${day}-setups.json`;
  } else {
    const setup = valueOf("--setup");
    const { chromium } = await import("playwright");
    const { guardContext, stableSetting } = await import("../src/browser.js");
    const { publicUrl } = await import("../src/netguard.js");
    const signin = await import("../src/signin.js");
    const refusedJson = JSON.parse(readFileSync(new URL("../docs/site-probe-2026-11-12-signin.json", import.meta.url), "utf8"));
    const sites = probe.parseList(valueOf("--list") ?? "signin-1112", { refusedJson, entryFor: (n) => signin.anyEntryFor(n) });
    // The one launch setting, for no one's account: the install's time zone.
    out = await probe.runSetups({ setup, sites, launcher: chromium, guard: guardContext, setting: stableSetting(null), publicUrl, scratchDir: tmpdir() });
    file = `docs/site-probe-${day}-setup-${setup}.json`;
    for (const l of out.loads) process.stderr.write(`${l.site.padEnd(22)} ${String(l.status ?? "-").padEnd(4)} ${l.page_kind.padEnd(16)} form:${String(l.ms_to_form ?? "-").padEnd(6)} ${l.wall_vendor.join(",")}\n`);
    for (const k of out.skipped) process.stderr.write(`${k.site.padEnd(22)} skipped: ${k.reason}\n`);
  }
  const json = JSON.stringify(out, null, 2);
  if (save) {
    writeFileSync(file, json + "\n");
    process.stderr.write(`\nwrote ${file}\n`);
  }
  process.stdout.write(json + "\n");
}

const { SITES, readSignedInState } = await import("../src/sites.js");
const { chromium } = await import("playwright");

// What a page says when it is a wall rather than a page. Matched on the visible text, because that
// is what a person would see; a 403 is caught separately off the status.
const WALL = [
  [/are you a human|verify (that )?you('re| are) (a )?human|i am not a robot|press (&|and) hold/i, "bot check"],
  [/unusual traffic|automated (requests|traffic)|suspicious activity/i, "automated-traffic notice"],
  [/access denied|request blocked|you have been blocked|reference ?#?\d|error 1020/i, "access denied"],
  [/enable javascript and cookies to continue|checking your browser|just a moment/i, "JS/cookie interstitial"],
  [/captcha/i, "captcha"],
];

const SIGNIN_HINT = /sign in|log ?in|create (an )?account|sign up|continue with (google|apple|facebook)/i;

function classify({ status, text, title, error }) {
  if (error) return { verdict: "error", why: error };
  if (status === 403 || status === 429) return { verdict: "blocked_automation", why: `HTTP ${status}` };
  for (const [re, why] of WALL) {
    const hit = re.exec(text);
    if (hit) return { verdict: "blocked_automation", why: `${why}: "${hit[0].slice(0, 60)}"` };
  }
  if (status && status >= 400) return { verdict: "error", why: `HTTP ${status}` };
  // A page with almost no text is a JavaScript shell that never rendered for us, which is a
  // different failure from a refusal and worth saying so rather than calling it loaded.
  if (text.trim().length < 200) return { verdict: "empty", why: `only ${text.trim().length} characters of readable text` };
  return { verdict: "loaded", why: `${text.trim().length} characters of readable text, titled "${title}"` };
}

async function look(context, url) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // A beat for the JavaScript-heavy ones to paint something. Not a retry, not a workaround:
    // just not judging a single-page app by its empty shell.
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
    const title = await page.title().catch(() => "");
    const landed = page.url();
    return { status: res?.status() ?? null, title, text, landed, error: null };
  } catch (e) {
    return { status: null, title: "", text: "", landed: url, error: (e?.message ?? String(e)).split("\n")[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

const sites = want.length ? SITES.filter(s => want.includes(s.site)) : SITES;
const context = await chromium.launchPersistentContext(join(scratch, "probe-profile"), {
  headless: true,
  viewport: { width: 1280, height: 900 },
  // No launch flag that hides automation from the site (removed 2026-10-23): see src/browser.js.
});

const out = { probed_at: new Date().toISOString(), signed_in: false, results: [] };
for (const s of sites) {
  const entry = await look(context, s.entry);
  const entryVerdict = classify(entry);
  const acct = await look(context, s.signed_in.url);
  const acctVerdict = classify(acct);
  // The real test of the registry: run the SAME reader the runtime uses against a page we know is
  // signed out. It has to come back `signed_out`. Anything else means the markers are wrong, and a
  // signed-in probe that cannot recognise a signed-out page would report every stranger as signed
  // in. `probe_reads` is that check, and it is the column worth looking at.
  const read = readSignedInState(s, { url: acct.landed, text: acct.text, status: acct.status, error: acct.error });
  const row = {
    site: s.site,
    label: s.label,
    entry: { url: s.entry, ...entryVerdict, status: entry.status, title: entry.title, landed: entry.landed },
    account_page: {
      url: s.signed_in.url, ...acctVerdict, status: acct.status, title: acct.title, landed: acct.landed,
      looks_like_a_signin_page: SIGNIN_HINT.test(acct.text),
    },
    probe_reads: read.state,
    probe_why: read.why,
    probe_correct: read.state === "signed_out",
  };
  out.results.push(row);
  process.stderr.write(`${s.site.padEnd(12)} entry:${row.entry.verdict.padEnd(19)} account:${row.account_page.verdict.padEnd(19)} reads:${read.state.padEnd(11)} correct:${row.probe_correct}\n`);
}

await context.close();
if (!process.env.REASON_KEEP_PROBE_PROFILE) rmSync(scratch, { recursive: true, force: true });

const json = JSON.stringify(out, null, 2);
if (save) {
  const file = `docs/site-probe-${out.probed_at.slice(0, 10)}.json`;
  writeFileSync(file, json + "\n");
  process.stderr.write(`\nwrote ${file}\n`);
}
process.stdout.write(json + "\n");
