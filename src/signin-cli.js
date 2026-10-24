// npm run signin -- <site>        open a real window so you can sign in yourself
// npm run signin -- --list        what is signed in, and when it was last checked
// npm run signin -- --check <site>  re-check one site without opening a window
// npm run signin -- --forget <site>  clear that site's cookies and stop claiming it is connected
//
// This is the operator's command and it only makes sense here: it opens a window on this screen.
// It never types a password, never reads one, and never asks for one. What happens is:
//
//   1. A visible Chromium opens on the site's own sign-in page, running in the SAME profile
//      directory Reason's headless browser uses for this conversation. That is the whole trick:
//      the session the site gives you lands in the profile Reason will open later.
//   2. You sign in however you normally would. Password manager, a code by text, a passkey — it is
//      the site's own form in your own window and Reason is not in it.
//   3. You close the window. The command waits for exactly that and then exits.
//   4. Reason re-opens the profile headless and asks the SITE whether it is signed in, by loading
//      the account page and reading it. Only if the site agrees is it recorded as signed in.
//
// Step 4 is the one that matters. Without it, closing a sign-in page you gave up on would be
// recorded as a success, and the next errand would set off believing it had an account.
import { config, stamp } from "./config.js";
import * as db from "./db.js";
import * as signin from "./signin.js";
import { profileDirFor } from "./browser.js";
import { SITES, siteNames } from "./sites.js";
// Both registries: the errand sites and the services whose subscriptions cancel on the web. The
// window this command opens is the same window either way — the person signs in themselves and the
// session lands in their own profile. See signin.entryFor.
const findSite = (n) => signin.entryFor(n);
const allNames = () => signin.signinNames();

const LAUNCH = {
  viewport: null, // a window a person uses should be a window, not a 1280x900 screenshot frame
  // No launch flag that hides automation from the site (removed 2026-10-23): see src/browser.js.
};

async function chromium() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    throw new Error("Playwright is not installed. Run: npm install");
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/** Which conversation's profile this command writes to: the operator's, always. */
function operatorConversation() {
  return config.ownerConversation;
}

function printList(conversationId) {
  const rows = signin.savedSignins(conversationId);
  const w = Math.max(...rows.map(r => r.site.length));
  console.log(`Saved sign-ins for ${config.ownerName} (${conversationId})`);
  console.log(`Profile: ${profileDirFor(conversationId)}\n`);
  for (const r of rows) {
    const when = r.last_checked ? `checked ${r.last_checked}` : "never checked";
    console.log(`  ${r.site.padEnd(w)}  ${r.state.padEnd(16)} ${when}`);
    if (r.evidence) console.log(`  ${" ".repeat(w)}  ${r.evidence}`);
  }
  console.log(`\nSign in to one:  npm run signin -- <site>`);
  console.log(`Sites: ${siteNames().join(", ")}`);
  console.log(`\nNo password is ever typed into Reason, here or in a message. You sign in yourself in the window.`);
}

async function headlessProbe(conversationId, siteName) {
  const launcher = await chromium();
  const ctx = await launcher.launchPersistentContext(profileDirFor(conversationId), {
    headless: true, viewport: { width: 1280, height: 900 }, args: LAUNCH.args,
  });
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    page.setDefaultTimeout(config.browserTimeoutMs);
    return await signin.checkAndRecord(page, conversationId, siteName);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function openForSignin(conversationId, entry) {
  const launcher = await chromium();
  const dir = profileDirFor(conversationId);
  console.log(`Opening ${entry.label} in a window. Profile: ${dir}`);
  console.log(`Sign in however you normally would, then CLOSE THE WINDOW. Nothing is typed for you.\n`);

  let ctx;
  try {
    ctx = await launcher.launchPersistentContext(dir, { headless: false, ...LAUNCH });
  } catch (e) {
    if (/Executable doesn't exist|browserType.launch/i.test(e.message)) {
      fail("Chromium is not downloaded on this machine. Run: npx playwright install chromium");
    }
    throw e;
  }

  const page = ctx.pages()[0] ?? await ctx.newPage();
  try {
    await page.goto(entry.signin_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (e) {
    // Worth continuing rather than bailing: the window is open and the person can navigate it
    // themselves, which on a site that refuses an automated first request is the only way in.
    console.error(`Could not load ${entry.signin_url} — ${(e?.message ?? String(e)).split("\n")[0]}`);
    console.error(`The window is open; go to the site yourself and sign in, then close it.\n`);
  }

  // Wait for the window to go away, whichever way it goes: the browser closing, or the last page
  // being closed with the browser left running.
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    ctx.on("close", finish);
    const poll = setInterval(() => {
      if (ctx.pages().length === 0) { clearInterval(poll); finish(); }
    }, 500);
    ctx.on("close", () => clearInterval(poll));
  });
  await ctx.close().catch(() => {});
  console.log("Window closed. Asking the site whether you are signed in...\n");
}

// ---------- the command ----------
const args = process.argv.slice(2);
const conversationId = operatorConversation();

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log(`Saved sign-ins. You sign in; Reason keeps the session, never a password.

  npm run signin -- <site>           open a window on that site's sign-in page
  npm run signin -- --list           what is signed in, and when it was last checked
  npm run signin -- --check <site>   re-ask the site, without opening a window
  npm run signin -- --forget <site>  clear that site's cookies and mark it not connected

Sites: ${siteNames().join(", ")}`);
  process.exit(0);
}

if (args.includes("--list")) {
  printList(conversationId);
  process.exit(0);
}

const flagValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const forget = flagValue("--forget");
if (args.includes("--forget")) {
  const entry = findSite(forget);
  if (!entry) fail(`--forget needs a site. Known: ${allNames().join(", ")}`);
  const launcher = await chromium();
  const ctx = await launcher.launchPersistentContext(profileDirFor(conversationId), {
    headless: true, viewport: { width: 1280, height: 900 }, args: LAUNCH.args,
  });
  const out = await signin.forgetSite(ctx, conversationId, entry.site);
  await ctx.close().catch(() => {});
  console.log(`Forgot ${entry.label}.`);
  console.log(`  cookies cleared for: ${out.cleared_cookies_for?.join(", ") || "nothing"}`);
  if (out.cleared_storage_for?.length) console.log(`  local storage cleared for: ${out.cleared_storage_for.join(", ")}`);
  if (out.problems?.length) for (const p of out.problems) console.log(`  could not reach ${p.domain ?? p.origin}: ${p.error}`);
  console.log(`\n${out.also_check}`);
  process.exit(0);
}

const check = flagValue("--check");
if (args.includes("--check")) {
  const entry = findSite(check);
  if (!entry) fail(`--check needs a site. Known: ${allNames().join(", ")}`);
  const out = await headlessProbe(conversationId, entry.site);
  if (!out.ok) fail(out.error);
  console.log(`${entry.label}: ${out.state}`);
  console.log(`  ${out.why}`);
  console.log(`  checked ${out.checked_url} at ${stamp()}${out.landed !== out.checked_url ? `, landed on ${out.landed}` : ""}`);
  process.exit(0);
}

const name = args.find(a => !a.startsWith("--"));
const entry = findSite(name);
if (!entry) fail(`No site called '${name}'. Known: ${allNames().join(", ")}`);

if (!entry.urls_verified) {
  console.log(`Heads up: no URL on ${entry.label} has ever loaded from this machine`
    + ` (${entry.limits[0]}). The window will open anyway; you may have to navigate there yourself.\n`);
}

await openForSignin(conversationId, entry);
const out = await headlessProbe(conversationId, entry.site);

if (!out.ok) fail(out.error);
if (out.state === "signed_in") {
  console.log(`${entry.label}: signed in. Recorded.`);
  console.log(`  ${out.why}`);
  if (out.inferred) {
    console.log(`  Read from what is NOT on the page rather than from anything positive on it — nobody has`);
    console.log(`  ever loaded a signed-in ${entry.label} page here to learn what that looks like.`);
  }
} else if (out.state === "signed_out") {
  console.log(`${entry.label}: still signed OUT. Nothing recorded.`);
  console.log(`  ${out.why}`);
  console.log(`  If you did sign in, the site may not have kept it in this profile. Try again and leave the window open a moment longer before closing it.`);
} else {
  console.log(`${entry.label}: could not tell. Nothing recorded.`);
  console.log(`  ${out.why}`);
  console.log(`  Recording "signed in" on a page nobody could read would be a guess, so it is left alone.`);
}
const row = db.lastSigninCheck(conversationId, entry.site);
if (row) console.log(`\nRow: state=${row.state} checked_at=${stamp(row.checked_at)}${row.revoked_at ? " (not connected)" : " (connected)"}`);
process.exit(0);
