// Which refused sign-in pages does any honest browser setup reach? A load-only probe (vault PR 2,
// docs/account-access-design.md section E), run by `npm run probe:sites -- --setup A0..A4`.
//
// Load only: one page load per site per setup in a signed-out scratch profile that is deleted after
// the run. Nothing is typed, clicked, pressed or followed; no account, no CAPTCHA, no retry, no other
// address. A wall is the finding, recorded once. Per load it keeps the status, the final host, the
// page kind (src/signinpage.js pageKind), how long a sign-in form took to show, and which wall vendor
// the response NAMES point to (cookie and header names, never a value), plus the page title and
// nothing else of the page. A site on the never list (design section C) is not loaded at all.
//
// Everything outside is handed in (the browser, the guard, the address check, the setting), so the
// tests run it against stubs and a page on 127.0.0.1 and nothing here can reach a real site by itself.
// It imports nothing that holds a login.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as signinPage from "./signinpage.js";

/** Least disguised first. A5 (a signed agent identity) and B1 (a hosted, disguised browser) are not here. */
export const SETUP_ORDER = Object.freeze(["A0", "A1", "A2", "A3", "A4"]);

export const SETUPS = Object.freeze({
  A0: { label: "today's browser, from the server", where: "server", guarded: true,
    launch: () => ({ headless: true, viewport: { width: 1280, height: 900 }, serviceWorkers: "block" }) },
  A1: { label: "the same build with a window and the one launch setting", where: "server", guarded: true,
    launch: (setting) => ({ ...setting, headless: false }) },
  A2: { label: "the real Chrome build with a window", where: "server", guarded: true,
    launch: (setting) => ({ ...setting, headless: false, channel: "chrome" }) },
  A3: { label: "A2 without the in-page request guard; the probe checks each address before loading it", where: "server", guarded: false,
    launch: (setting) => ({ ...setting, headless: false, channel: "chrome" }) },
  A4: { label: "A2 from the Mac, a home connection", where: "home", guarded: true,
    launch: (setting) => ({ ...setting, headless: false, channel: "chrome" }) },
});

/** Section C's never list, as far as the 11-12 sites reach it. Refused by the probe itself, with the row. */
export const NEVER = Object.freeze([
  { row: "sites whose terms forbid giving an agent the login", names: ["uber", "uber_eats", "uber / uber eats", "uber.com", "ubereats.com"] },
  { row: "social networks", names: ["linkedin", "linkedin.com", "x", "x.com", "twitter.com", "reddit", "reddit.com"] },
  { row: "ticket buying", names: ["ticketmaster", "ticketmaster.com", "livenation.com"] },
]);

const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ""; } };

/** The never-list row a site name, a host or an address falls under, or "". A subdomain counts as its domain. */
export function neverRow(name) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return "";
  const host = /^https?:\/\//.test(n) ? hostOf(n) : n;
  for (const { row, names } of NEVER) {
    for (const x of names) {
      if (host === x || (x.includes(".") && host.endsWith(`.${x}`))) return row;
    }
  }
  return "";
}

/** The owner's first candidates (first-sites.md) and the registry's sites that are not on the never list. */
export const CONTROLS = Object.freeze(["amazon", "netflix.com", "coned.com", "notion.so", "linear.app", "railway.com", "delta", "united", "fandango"]);

function siteRow({ site, names = [], hosts = [], group, entryFor }) {
  const first = names[0] ?? site;
  let url = "";
  try { url = String(entryFor(first)?.signin_url ?? ""); } catch { url = ""; }
  if (!url) url = `https://${hosts[0] || first}/`;
  const never = [site, ...names, ...hosts, url].map(neverRow).find(Boolean) || "";
  return { site, group, url, never };
}

/**
 * The 20 sign-in pages refused on 2026-11-12 (docs/site-probe-2026-11-12-signin.json) and the
 * controls, named with the address each is loaded at: the runtime's own sign-in address for the name
 * (`entryFor`, src/signin.js anyEntryFor), else the site's first sign-in host.
 */
export function signin1112List({ refusedJson, entryFor = () => null }) {
  const refused = (refusedJson?.sites ?? []).map((s) => siteRow({ site: s.site, names: s.names, hosts: s.signin_hosts, group: "refused", entryFor }));
  const controls = CONTROLS.map((n) => siteRow({ site: n, names: [n], group: "control", entryFor }));
  return [...refused, ...controls];
}

/** `--list`: "signin-1112", or site names and addresses separated by commas. */
export function parseList(value, { refusedJson, entryFor = () => null } = {}) {
  const v = String(value ?? "").trim();
  if (v === "signin-1112") return signin1112List({ refusedJson, entryFor });
  return v.split(",").map((s) => s.trim()).filter(Boolean).map((n) => siteRow({ site: n, names: [n], group: "named", entryFor }));
}

/** Which wall vendor the response's cookie and header NAMES point to. Names only: a value is never read. */
const VENDORS = [
  [/^cf-ray$|^cf-mitigated$/i, "cloudflare"],
  [/^_abck$|^ak_bmsc$/i, "akamai"],
  [/^datadome$/i, "datadome"],
  [/^_px/i, "perimeterx"],
  [/^x-kpsdk-/i, "kasada"],
  [/^incap_ses|^reese84$/i, "imperva"],
];
export function wallVendors(names = []) {
  const out = new Set();
  for (const n of names) for (const [re, vendor] of VENDORS) if (re.test(String(n))) out.add(vendor);
  return [...out].sort();
}

/** What may never be touched on a probed page. Asking for one throws, and the run counts it. */
const NOT_ON_A_PROBE = new Set([
  "fill", "type", "press", "pressSequentially", "click", "dblclick", "tap", "check", "uncheck", "setChecked",
  "selectOption", "setInputFiles", "dragAndDrop", "hover", "focus", "dispatchEvent",
  "keyboard", "mouse", "touchscreen", "locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder",
  "getByTestId", "getByTitle", "getByAltText", "$", "$$", "$eval", "$$eval", "goBack", "goForward", "reload",
]);
/** The page as the probe holds it: reading only. Anything that could type or press throws before it can. */
export function readOnlyPage(page, counter) {
  return new Proxy(page, {
    get(target, prop) {
      if (typeof prop === "string" && NOT_ON_A_PROBE.has(prop)) {
        counter.refused_calls += 1;
        throw new Error(`the probe never uses page.${prop}`);
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const firstLine = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One load of one site: one goto, then reading until a sign-in form shows or the wait runs out. */
async function loadOne(context, row, { setup, counter, formWaitMs, pollMs, now, readPage }) {
  const started = now();
  const page = readOnlyPage(await context.newPage(), counter);
  counter.loads[row.site] = (counter.loads[row.site] ?? 0) + 1;
  const out = { site: row.site, group: row.group, url: row.url, setup, status: null, final_host: "", page_kind: "error", ms_to_form: null, wall_vendor: [], walled: false, title: "" };
  try {
    let res = null;
    try {
      res = await page.goto(row.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (e) {
      out.error = firstLine(e);
    }
    out.status = res?.status?.() ?? null;
    let headerNames = [];
    try { headerNames = Object.keys((await res?.allHeaders?.()) ?? res?.headers?.() ?? {}); } catch { headerNames = []; }
    if (!out.error) {
      let kind = "loading";
      const deadline = started + formWaitMs;
      for (;;) {
        kind = (await readPage(page))?.kind ?? "loading";
        if (kind === "signin_form") { out.ms_to_form = Math.max(0, now() - started); break; }
        // A wall is the answer: no more looking at it.
        if (kind === "challenge" || out.status === 403 || out.status === 429 || now() >= deadline) break;
        await sleep(pollMs);
      }
      out.page_kind = kind;
    }
    let landed = row.url;
    try { landed = page.url(); } catch { /* the load's own address */ }
    out.final_host = hostOf(landed);
    let cookieNames = [];
    try { cookieNames = (await context.cookies([landed])).map((c) => c.name); } catch { cookieNames = []; }
    out.wall_vendor = wallVendors([...headerNames, ...cookieNames]);
    out.walled = out.status === 403 || out.status === 429 || out.page_kind === "challenge";
    try { out.title = String(await page.title()).slice(0, 120); } catch { out.title = ""; }
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

/**
 * Run one setup over `sites` (rows from signin1112List / parseList). Every dependency is handed in.
 *   → { probed_at, setup, label, where, platform, launch, guarded, guard, sites_named, loads, skipped,
 *       typed_characters, refused_calls, scratch_profile_deleted }
 */
export async function runSetups({
  setup, sites = [], launcher, guard = async () => {}, setting = {}, publicUrl, platform = process.platform,
  scratchDir, now = () => Date.now(), formWaitMs = 15_000, pollMs = 500, readPage = signinPage.readPage,
}) {
  const s = SETUPS[setup];
  if (!s) throw new Error(`no setup called '${setup}': the honest ones are ${SETUP_ORDER.join(", ")}`);
  if (setup === "A4" && platform !== "darwin") throw new Error("A4 is the Mac's home connection: run it on the Mac");
  if (setup !== "A4" && platform === "darwin") throw new Error(`${setup} is the server's: run it on the server (A4 is the Mac)`);
  if (typeof publicUrl !== "function") throw new Error("runSetups needs publicUrl");
  const launch = s.launch(setting);
  const counter = { typed_characters: 0, refused_calls: 0, loads: {} };
  const result = {
    probed_at: new Date(now()).toISOString(), setup, label: s.label, where: s.where, platform,
    launch, guarded: s.guarded, guard: s.guarded ? "guardContext" : "probe_precheck",
    sites_named: sites.map(({ site, group, url, never }) => ({ site, group, url, never: never || null })),
    loads: [], skipped: [], typed_characters: 0, refused_calls: 0, scratch_profile_deleted: false,
  };
  const profile = mkdtempSync(join(scratchDir, "probe-setup-"));
  let context = null;
  try {
    context = await launcher.launchPersistentContext(profile, launch);
    if (s.guarded) await guard(context);
    for (const row of sites) {
      if (row.never) { result.skipped.push({ site: row.site, reason: `never list: ${row.never}` }); continue; }
      const pub = await publicUrl(row.url);
      if (!pub?.ok) { result.skipped.push({ site: row.site, reason: `refused by probe: ${pub?.why ?? "not a public address"}` }); continue; }
      // One load per site per setup, whatever it answered: no retry, no second address.
      if (counter.loads[row.site]) continue;
      result.loads.push(await loadOne(context, row, { setup, counter, formWaitMs, pollMs, now, readPage }));
    }
  } finally {
    await context?.close?.().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
    result.scratch_profile_deleted = !existsSync(profile);
    result.typed_characters = counter.typed_characters;
    result.refused_calls = counter.refused_calls;
  }
  return result;
}

/**
 * Several setups' results, one row per site: what each setup's load came to, and the least disguised
 * setup that reached a sign-in form (null when none did). A load proves nothing about a sign-in.
 */
export function mergeSetups(results = []) {
  const bySite = new Map();
  const ordered = [...results].sort((a, b) => SETUP_ORDER.indexOf(a.setup) - SETUP_ORDER.indexOf(b.setup));
  for (const r of ordered) {
    for (const n of r.sites_named ?? []) if (!bySite.has(n.site)) bySite.set(n.site, { site: n.site, group: n.group, url: n.url, never: n.never ?? null, by_setup: {}, first_form_setup: null });
    for (const l of r.loads ?? []) {
      const row = bySite.get(l.site) ?? { site: l.site, group: l.group, url: l.url, never: null, by_setup: {}, first_form_setup: null };
      row.by_setup[r.setup] = { status: l.status, final_host: l.final_host, page_kind: l.page_kind, ms_to_form: l.ms_to_form, wall_vendor: l.wall_vendor, walled: l.walled };
      if (!row.first_form_setup && l.page_kind === "signin_form") row.first_form_setup = r.setup;
      bySite.set(l.site, row);
    }
  }
  return {
    setups: ordered.map((r) => ({ setup: r.setup, probed_at: r.probed_at, where: r.where, guard: r.guard, typed_characters: r.typed_characters, scratch_profile_deleted: r.scratch_profile_deleted })),
    typed_characters: ordered.reduce((n, r) => n + (r.typed_characters ?? 0), 0),
    sites: [...bySite.values()],
  };
}
