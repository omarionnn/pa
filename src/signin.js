// Saved sign-ins. The person signs in themselves, once per site, in a real browser window.
//
// The design Omari approved, and the reason for each part of it:
//
//   **No password ever reaches Reason.** Not typed in chat, not held in a field, not stored
//   encrypted, not passed to a form. The browser window belongs to the person for as long as it is
//   open; Reason is not in it. What Reason keeps afterwards is the *profile directory* — the
//   cookies the site itself set — which is the same thing a laptop keeps when you tick "remember
//   me", and it is a credential for one site rather than a password that unlocks an email account
//   too. `refuseAPassword()` is the words Reason says if anybody offers one anyway, and the tool
//   returns it rather than leaving the model to improvise a refusal.
//
//   **Signed in is checked, never assumed.** A window that was closed proves nothing: somebody can
//   open a sign-in page, change their mind and close it. So the state is written from a probe that
//   loads the site's own account page and reads it (`src/sites.js`, `readSignedInState`), and the
//   evidence goes in the row next to the state.
//
//   **One profile per person.** `profileDirFor(conversationId)` is the same directory the errand
//   browser uses, which is what makes a hand sign-in usable by a later turn — and, because every
//   conversation gets its own, what makes one person's signed-in session unreachable from anybody
//   else's thread. There is no code path that opens somebody else's profile: the directory is
//   derived from the conversation id and nothing else.
//
//   **Only at this Mac.** Opening a window somebody can see needs a screen they are sitting at.
//   For anyone texting from elsewhere there is no safe way to do this yet and the tool says so in
//   those words — see `remoteSigninAnswer()`. The thing not built is a hosted browser the person
//   can watch and type into; the thing deliberately NOT built is a password box, which would move
//   the credential into Reason and is the one design this file exists to rule out.
import { config, clock, stamp } from "./config.js";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { profileDirFor, settle as settleBrowser } from "./browser.js";
import { SITES, site as findSite, siteFor, readSignedInState, siteNames } from "./sites.js";
import * as cancelRoutes from "./cancel-routes.js";
import * as airlines from "./airlines.js";
import * as signinPage from "./signinpage.js";

/**
 * The registry entry for a name, from any of the three registries.
 *
 * Three registries name things that can be signed in to. `src/sites.js` holds the ten errand sites
 * Omari picked; `src/cancel-routes.js` holds the services whose subscriptions Reason can cancel on
 * the web, and those are signed in to exactly the same way — the person does it themselves, once,
 * and the session lands in their own profile directory. Rather than copy any of this machinery,
 * a cancel-route service hands back a sites-shaped entry (`cancelRoutes.signinEntry`) and
 * everything below works on it unchanged.
 *
 * Errand sites win a name collision, because they were here first and their names are what
 * `signin_status`, the probe script and the capability list already print. The two lists do not
 * actually collide today — `spotify` is in PROVIDERS as an API account rather than a site, and
 * `amazon` and `amazon_prime` are different names — but a resolver that did not say which way it
 * would break is a resolver somebody has to read this file to understand.
 *
 * `src/airlines.js` is the third, added for flight check-in, and it DOES collide: `delta` and
 * `united` are errand sites already. The errand entry wins, and here that is the better answer
 * rather than merely the older one — those two were written from a real probe of those sites, and
 * what the probe found is that both refuse this browser outright. An airline entry that quietly
 * replaced one would hide the most useful fact anybody has about it.
 */
export function entryFor(name) {
  return findSite(name) ?? cancelRoutes.signinEntry(name) ?? airlines.signinEntry(name);
}

/**
 * Any other site, by its web address: a sites-shaped entry for a site no registry knows (Notion,
 * Airbnb, a gym's booking site…), so the person can sign in to it through the same secure link.
 *
 * Why this exists (2026-11-10): the owner asked for his notes in Notion, and Reason said it could
 * not get in — a sign-in link only reached the registry sites, and the prompt told it to say so
 * upfront. A Google/Apple/Facebook/Microsoft login opens far more sites than any list will hold,
 * so the list cannot be the door. The site is named by its address, which the model knows.
 *
 * `raw` is a domain ("notion.so") or a URL ("https://www.notion.so/login"); a bare word, an IP, a
 * port, credentials in the URL or anything but https gives null. The key is the domain without
 * "www.", so the same site is one row however it was written. A path is kept as the sign-in page;
 * without one the entry points at the site's front page, and a caller that is about to show that
 * page to a person finds the site's own sign-in page first (src/signinpage.js, entryOnItsPage).
 * Signed in needs POSITIVE evidence (src/sites.js readUnknownSite): a log-out or account control, or
 * the site's own sign-in page passing the browser straight through. Until 2026-11-12 it was read
 * from the front page no longer saying "sign in", which a marketing page never satisfies and an
 * app's blank shell always does. Without evidence the answer is "unknown".
 * Callers that navigate must still ask src/netguard.js publicUrl: a name that resolves to this
 * machine's own network is never opened.
 */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"]);
/** The registrable part of a host: "app.notion.so" → "notion.so", "www.bbc.co.uk" → "bbc.co.uk". */
function registrable(host) {
  const parts = host.split(".");
  const twoLevel = parts.length >= 3 && parts.at(-1).length === 2 && SECOND_LEVEL.has(parts.at(-2));
  return parts.slice(twoLevel ? -3 : -2).join(".");
}
export function genericEntry(raw) {
  let s = String(raw ?? "").trim();
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length < 2 || labels.some(l => !/^[a-z0-9-]+$/.test(l)) || /^\d+$/.test(labels.at(-1))) return null;
  // A bare public suffix ("co.uk") is not a site.
  if (labels.length === 2 && labels[1].length === 2 && SECOND_LEVEL.has(labels[0])) return null;
  // Keyed by the registrable domain, so app.notion.so and notion.so are one site, and a revoke
  // clears the cookies the whole site shares (they sit on .notion.so, not on a sub-host).
  const bare = registrable(host);
  const word = bare.split(".")[0];
  const label = word.charAt(0).toUpperCase() + word.slice(1);
  const front = `https://${bare}/`;
  // The query string is dropped: a sign-in URL can carry an email, a token or a redirect, and the
  // entry is logged and written to the ledger. The page itself is all the link needs.
  const page = u.pathname && u.pathname !== "/" ? `${u.origin}${u.pathname}` : front;
  return {
    site: bare,
    label,
    what: `do what they ask on ${label}`,
    hosts: host === bare || host === `www.${bare}` ? [bare] : [bare, host],
    entry: front,
    signin_url: page,
    urls_verified: false,
    needs_signin: "always",
    signed_in: {
      // Asked on the sign-in page itself when one is known: a site shows its form there to anybody
      // not signed in and sends a signed-in browser on. A marketing front page says neither.
      url: page,
      when_in: [],
      when_out: ["log in", "sign in", "sign up", "create an account", "create account"],
      when_out_url: "/login",
    },
    commit_labels: [],
    limits: [`${label} is not one of the sites Reason has a playbook for: nobody has seen its signed-in pages here, so "signed in" is only said on positive evidence (a log-out or account control, or its own sign-in page passing the browser straight through). Without that the answer is "unknown".`],
    generic: true,
  };
}

/**
 * The entry on the page the person's sign-in is really on. A site named only by its bare domain
 * ("link.com") resolves to its front page; when an attempt for this person was on a specific sign-in
 * page (https://app.link.com/login), that page is what every later link, window, emailed-code run
 * and check opens. Carried here, in code, from src/signinpage.js: on 2026-11-12 it was left to the
 * model to retype, and the link opened a marketing home page.
 * An entry that already names a page, and any registry entry, comes back untouched.
 */
export function entryOnItsPage(conversationId, entry) {
  if (!entry?.generic || !signinPage.isFrontPage(entry.signin_url)) return entry;
  const page = signinPage.signinPageFor(conversationId, entry);
  if (!page) return entry;
  const there = genericEntry(page);
  return there && there.site === entry.site ? there : entry;
}

/**
 * The entry for a name OR a web address: a registry name first, then a URL on a registry site (so
 * "https://www.amazon.com/…" keeps Amazon's own entry and what is known about it), then any other
 * site by its address. Where the generic door is allowed is the caller's decision, not this one's.
 */
export function anyEntryFor(name) {
  const known = entryFor(name);
  if (known) return known;
  const g = genericEntry(name);
  if (!g) return null;
  return siteFor(g.signin_url) ?? registryByHost(new URL(g.signin_url).hostname) ?? g;
}

/** A cancel-route service or an airline whose own hosts this is: its entry, never a second row. */
function registryByHost(hostname) {
  const h = String(hostname ?? "").toLowerCase().replace(/^www\./, "");
  const on = (e) => (e?.hosts ?? []).some(x => h === x || h.endsWith(`.${x}`));
  for (const n of cancelRoutes.routeNames()) { const e = cancelRoutes.signinEntry(n); if (on(e)) return e; }
  for (const n of airlines.airlineNames()) { const e = airlines.signinEntry(n); if (on(e)) return e; }
  return null;
}

/**
 * Sites signed in to by their address (genericEntry), as savedSignins rows: the registry list is
 * what "what's signed in" always meant, and a Notion signed in through the link belongs on it too.
 */
export function savedGenericSignins(conversationId) {
  const out = [];
  const seen = new Set(signinNames());
  for (const r of db.accountHistory(conversationId)) {
    if (seen.has(r.name) || !String(r.name).includes(".")) continue;
    seen.add(r.name);
    const e = genericEntry(r.name);
    if (!e) continue;
    const row = db.lastSigninCheck(conversationId, e.site);
    if (!row) continue;
    const live = !row.revoked_at && row.state === "signed_in";
    out.push({
      site: e.site, label: e.label, what: e.what,
      state: live ? "signed_in" : (row.state || "never_signed_in"),
      needs_signin: e.needs_signin,
      last_checked: row.checked_at ? stamp(row.checked_at) : null,
      checked_minutes_ago: row.checked_at ? Math.round((clock.now() - row.checked_at) / 60_000) : null,
      evidence: row.evidence || "",
      ...(live && row.provider ? { provider: row.provider } : {}),
      // The page their last sign-in there was on, when one is known: never the bare name alone.
      ...(live ? {} : { how_to_sign_in: `signin_link with site '${signinPage.signinPageFor(conversationId, e) || e.site}', which they open on their phone` }),
      by_address: true,
    });
  }
  return out;
}

/** Every name `entryFor` will resolve, for an error message that is actually useful. */
export function signinNames() {
  const seen = new Set(siteNames());
  const out = [...siteNames()];
  for (const n of cancelRoutes.routeNames()) {
    if (!seen.has(n) && cancelRoutes.signinEntry(n)) { seen.add(n); out.push(n); }
  }
  for (const n of airlines.airlineNames()) {
    if (!seen.has(n) && airlines.signinEntry(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

/** Reason's answer when somebody offers a password. Returned by the tool, not left to the model. */
export function refuseAPassword() {
  return {
    rule: "no_passwords_in_chat",
    say: `I don't take passwords — not here, not anywhere. Even if you sent one I would not use it.`
      + ` Two reasons: a password in a text message is in your messages forever and in my logs too, and a password to one site is usually the password to your email as well.`
      + ` You sign in yourself, on the site's own page — through a private link I send you or in a window on the Mac — and I keep the session the site gives you, the same way your laptop does.`,
    why: "A password typed into a conversation is stored by the messaging app, by this process, and in any transcript of either. Signing in on the site's own page leaves nothing of it anywhere: nothing typed there is saved or logged.",
  };
}

/** The command the operator runs, by site. One place, so the tool and the README cannot disagree. */
export function signinCommand(siteName) {
  return `npm run signin -- ${siteName}`;
}

/**
 * What to tell somebody who is not at this Mac.
 *
 * Deliberately not a workaround. Everything that would work is either "sit at the Mac" or
 * something nobody has built, and offering a password form would be building the wrong thing.
 */
export function remoteSigninAnswer(siteName) {
  void siteName;
  if (config.publicUrl) {
    return {
      possible: true,
      how: "signin_link makes a private link. It shows them Reason's own browser on the site's real sign-in page, they sign in there themselves from their phone, and the session stays in their own saved profile.",
      never: "Reason will not take a password in a message to sign in on your behalf. That is not a missing feature; it is the one way of doing this that is ruled out.",
    };
  }
  return {
    possible: false,
    why: `Signing in needs a browser you can see and type into. Reason's browser runs on ${config.ownerName}'s machine, and the link that would show it to you only opens on that machine, because Reason has no public address set — so there is no window to show you from here.`,
    never: "Reason will not take a password in a message to sign in on your behalf. That is not a missing feature; it is the one way of doing this that is ruled out.",
    what_it_would_take: "A public address for Reason (REASON_PUBLIC_URL). The hosted browser you sign in through is built; it just cannot be reached from outside the machine without one.",
    for_now: `Ask ${config.ownerName} to do the bit that needs an account, or pick something Reason can do without signing in as you.`,
  };
}

/**
 * Signing in through a link, for whoever asks: is it available, and what is true about it.
 *
 * The honest part is `what_passes_through`. On this path what the person types does travel through
 * Reason on its way to the site, which is a different promise from the window on the Mac, and the
 * model is given the sentence rather than left to round it up to "I never see your password".
 */
export function linkSignin() {
  if (!config.publicUrl) {
    return { available: false, why: "Reason has no public address (REASON_PUBLIC_URL), so a sign-in link would only open on the machine it runs on." };
  }
  return {
    available: true,
    how: "Call signin_link with the site and send them the link whole. It opens a page showing your own browser on that site's real sign-in page; they tap and type there themselves, tap Done, and you are told what the site says.",
    what_passes_through: "What they type is relayed to the site through you and is never saved, logged or shown to you. So say that you do not keep or see their password — not that it never passes through anything.",
    limits: "A password, or a code by text or email, works. Face ID, passkeys and security keys do not, because the browser is on your machine and not on their phone. The link works once, on one device, for a few minutes.",
  };
}

/**
 * Open the site's account page in a page we already have and read which state it is in.
 *
 * Takes a Playwright page rather than making one, so the same function serves the headless errand
 * browser, the visible sign-in window and the probe script. It navigates — there is no way to ask
 * a site whether a cookie is still good without asking it.
 */
export async function probeSignedIn(page, siteName, { entry: given = null, waitMs = null } = {}) {
  // `given` is the registry entry already in hand, for the one caller that has one: the cancel rail
  // resolves a service through its own registry (which a test can stand a fixture in) and then asks
  // this to read the page. Everything else passes a name and this looks it up.
  // A site with no registry entry is named by its domain (genericEntry), so the probe after a
  // sign-in through the link resolves it the same way the link did.
  const entry = given ?? anyEntryFor(siteName);
  if (!entry) return { ok: false, error: `No site called '${siteName}'. Known: ${signinNames().join(", ")}.` };
  // Twice, because the page is shared and a page load can be cut off. There is one Chromium per
  // conversation, so this probe can start while the tab is still carrying a navigation that failed
  // a moment ago — Chromium reports THAT as an error against THIS one ("interrupted by another
  // navigation") — and on a loaded machine the account page can simply fail to come back. Either
  // way the answer is `unknown`: the page could not be read, which says nothing about the account.
  // So an unknown is asked once more before it is reported, and when it is still unknown it is
  // reported AS unknown — every caller tells the person Reason could not check, never that they are
  // signed out (#279). A site that genuinely answers signed in or signed out is read on the first go.
  let read = null;
  let status = null;
  let landed = entry.signed_in.url;
  for (let attempt = 0; attempt < 2; attempt++) {
    status = null;
    let error = null;
    let text = "";
    let acct = "", form = false;
    landed = entry.signed_in.url;
    try {
      const res = await page.goto(entry.signed_in.url, { waitUntil: "domcontentloaded" });
      status = res?.status() ?? null;
      await page.waitForTimeout(1500);
      if (entry.generic) {
        // A site with no playbook: the page is read for POSITIVE evidence (its shape, a log-out or
        // account control), and given the same bounded time to draw itself a sign-in form gets
        // (src/signinpage.js) — a page still blank at 1.5 s is not "no sign-in prompt".
        const seen = await readUnknownSitePage(page, entry, { waitMs: waitMs ?? Math.max(0, signinPage.formWaitMs() - 1500) });
        text = seen.text; acct = seen.acct; form = seen.form;
      } else {
        text = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
      }
      landed = page.url();
    } catch (e) {
      error = (e?.message ?? String(e)).split("\n")[0];
    }
    read = readSignedInState(entry, { url: landed, text, status, error, acct, form });
    if (read.state !== "unknown") break;
    // A page that loaded and simply proves nothing is not a failed load: asking again changes nothing.
    if (read.no_evidence) break;
    // A load that threw can leave the tab on an error page with a navigation still in flight, so
    // it is parked before the second try. `settle` waits for its own blank page to land, so the
    // park cannot be what interrupts the retry.
    if (attempt === 0 && error) await settleBrowser(page);
  }
  // Only a bare name is known, and its front page proves nothing either way: the site's
  // conventional sign-in page is asked once. A site passes a signed-in browser straight through that
  // page to an inside one; only that POSITIVE answer is taken from a guessed address (a form there,
  // a 404, or a bounce back to the front page leave the answer "unknown").
  if (entry.generic && read.state === "unknown" && read.no_evidence && signinPage.isFrontPage(entry.signed_in.url)) {
    const atLogin = genericEntry(`${entry.entry}login`);
    if (atLogin && atLogin.site === entry.site) {
      const second = await probeSignedIn(page, siteName, { entry: atLogin, waitMs });
      const inside = (() => { try { return !signinPage.isFrontPage(second.landed); } catch { return false; } })();
      if (second.ok && second.state === "signed_in" && inside) return { ...second, via_signin_page: true };
    }
  }
  return { ok: true, site: entry.site, checked_url: entry.signed_in.url, landed, status, ...read };
}

/**
 * One reading of a page on a site with no playbook, for the probe: its words, whether a sign-in form
 * is in view, and whether the document has a log-out or account control. Waited for (bounded) until
 * the page shows what it is: a real step, an account control, or — having left the sign-in page —
 * something drawn. Never reads what is in a box.
 */
async function readUnknownSitePage(page, entry, { waitMs = 0 } = {}) {
  let last = null;
  await signinPage.waitFor(page, async () => {
    last = await signinPage.readPage(page);
    if (signinPage.isStep(last.kind) || last.raw.acct) return last;
    let url = last.raw.url;
    try { url = page.url() || url; } catch { /* the reading's own address stands */ }
    const drawn = String(last.raw.text ?? "").trim().length >= 50;
    return drawn && (signinPage.isFrontPage(entry.signed_in.url) || signinPage.leftSigninPage(url, { signin_url: entry.signed_in.url })) ? last : null;
  }, { waitMs });
  return { text: String(last?.raw?.text ?? ""), acct: String(last?.raw?.acct ?? ""), form: last?.kind === "signin_form" };
}

/**
 * Probe, then write the result down. The only way a sign-in state gets recorded.
 *
 * `provider` is which button the sign-in went through (google/apple/facebook/microsoft,
 * src/socialsignin.js), when the caller knows; it reaches the row only with a signed-in reading.
 */
export async function checkAndRecord(page, conversationId, siteName, { entry = null, provider = "", waitMs = null } = {}) {
  // A site named by its bare domain is asked on the page this person's sign-in there was on.
  const out = await probeSignedIn(page, siteName, { entry: entry ?? entryOnItsPage(conversationId, anyEntryFor(siteName)), waitMs });
  if (!out.ok) return out;
  const row = db.recordSiteSignin(conversationId, out.site, { state: out.state, evidence: out.why, provider });
  if (row?.provider && out.state === "signed_in") out.provider = row.provider;
  return out;
}

/**
 * Runs inside the page: everything one origin keeps besides cookies. Browser globals only —
 * Playwright serializes it across. Exported so a test can run it against a fake window.
 */
/* eslint-env browser */
export async function clearOriginInPage() {
  const out = { deleted: [], failed: [] };
  try { localStorage.clear(); } catch { /* a site may forbid it */ }
  try { sessionStorage.clear(); } catch { /* same */ }
  try {
    const dbs = typeof indexedDB?.databases === "function" ? await indexedDB.databases() : [];
    for (const d of dbs) {
      if (!d?.name) continue;
      const verdict = await new Promise((done) => {
        const req = indexedDB.deleteDatabase(d.name);
        req.onsuccess = () => done("deleted");
        req.onerror = () => done("error");
        req.onblocked = () => done("blocked");
      });
      if (verdict === "deleted") out.deleted.push(d.name);
      else out.failed.push(`IndexedDB '${d.name}' was ${verdict === "blocked" ? "held open by the page" : "not deleted"}`);
    }
  } catch (e) { out.failed.push(`IndexedDB could not be listed: ${String(e?.message ?? e).split("\n")[0]}`); }
  try {
    if (typeof caches !== "undefined") for (const k of await caches.keys()) await caches.delete(k);
  } catch { /* Cache Storage is optional */ }
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    for (const r of regs) await r.unregister();
  } catch { /* so are service workers */ }
  return out;
}

/**
 * Forget one site: clear what the site stored in this person's profile, and stop claiming it is
 * connected.
 *
 * Honest about its edges, because a half-clear that reads as a full one is worse than no clear at
 * all. Cookies go by domain. Everything else an origin keeps — localStorage, sessionStorage,
 * IndexedDB (where a single-page app usually keeps its sign-in token), Cache Storage and service
 * workers — is cleared from inside a page opened on that origin (clearOriginInPage), so an origin
 * that will not open cannot be cleared and is listed under `problems`. Before 2026-10-23 IndexedDB
 * was left alone and a site that kept its token there stayed signed in. Deleting the whole
 * profile (`npm run data:delete`) is still the only certain way.
 */
export async function forgetSite(context, conversationId, siteName) {
  // A site signed in to by its address (genericEntry) is forgotten the same way, by its domain.
  const entry = anyEntryFor(siteName);
  if (!entry) return { ok: false, error: `No site called '${siteName}'. Known: ${signinNames().join(", ")}.` };

  const cleared = { cookies: [], storage: [], indexeddb: [], failed: [] };
  for (const host of entry.hosts) {
    for (const domain of [host, `.${host}`, `www.${host}`]) {
      try {
        await context.clearCookies({ domain });
        cleared.cookies.push(domain);
      } catch (e) {
        cleared.failed.push({ domain, error: (e?.message ?? String(e)).split("\n")[0] });
      }
    }
  }
  // localStorage is per origin, so the origin has to be open to clear it.
  const page = await context.newPage().catch(() => null);
  if (page) {
    for (const host of entry.hosts) {
      // A site known only by its address is opened as it is named; it follows its own redirect.
      const origin = `https://${entry.generic || host.startsWith("www.") ? host : `www.${host}`}`;
      try {
        await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 15_000 });
        const gone = await page.evaluate(clearOriginInPage);
        cleared.storage.push(origin);
        // IndexedDB is where a single-page app keeps the token it signs in with, so leaving it is
        // leaving the sign-in. Each database is deleted by name; one that is held open by the page
        // ("blocked") is counted as a problem rather than as cleared.
        for (const name of gone.deleted) cleared.indexeddb.push(`${origin} → ${name}`);
        for (const p of gone.failed) cleared.failed.push({ origin, error: p });
      } catch (e) {
        // A site that refuses an automated browser cannot have its storage cleared this way. Worth
        // saying: the cookies are gone, and that is usually what the session was.
        cleared.failed.push({ origin, error: (e?.message ?? String(e)).split("\n")[0] });
      }
    }
    await page.close().catch(() => {});
  }

  db.recordSiteSignin(conversationId, entry.site, {
    state: "signed_out",
    evidence: `forgotten by hand at ${stamp()}: cookies cleared for ${cleared.cookies.join(", ") || "nothing"}`,
  });

  return {
    ok: true,
    site: entry.site,
    cleared_cookies_for: cleared.cookies,
    cleared_storage_for: cleared.storage,
    cleared_indexeddb: cleared.indexeddb,
    problems: cleared.failed,
    also_check: "Cookies, localStorage, sessionStorage, IndexedDB, Cache Storage and service workers were cleared for each origin that would open. An origin listed under problems was not, and a site that refuses an automated browser cannot be cleared this way. The only certain way is to delete the whole profile: npm run data:delete -- <conversation> --yes",
    state: "signed_out",
  };
}

/**
 * Where each site stands for one person, from the record rather than from a fresh probe.
 *
 * Every row carries when it was last checked, because a sign-in that worked a month ago is not a
 * fact about now and the difference is the whole value of the field.
 */
export function savedSignins(conversationId) {
  return SITES.map(s => {
    const row = db.lastSigninCheck(conversationId, s.site);
    const live = !row?.revoked_at && row?.state === "signed_in";
    return {
      site: s.site,
      label: s.label,
      what: s.what,
      state: live ? "signed_in" : (row?.state || "never_signed_in"),
      needs_signin: s.needs_signin,
      last_checked: row?.checked_at ? stamp(row.checked_at) : null,
      checked_minutes_ago: row?.checked_at ? Math.round((clock.now() - row.checked_at) / 60_000) : null,
      evidence: row?.evidence || "",
      // Which button that login went through ("google"…), or "" for the site's own form. Only on a
      // live sign-in: a revoked row's provider is history, not a way in.
      ...(live && row?.provider ? { provider: row.provider } : {}),
      // A site whose sign-in page refuses this browser has no "how to sign in": offering one is
      // how the owner ended up staring at a bot-check spinner. The finding travels instead.
      ...(live ? {} : s.signin_blocked ? { signin_blocked: s.signin_blocked } : { how_to_sign_in: signinCommand(s.site) }),
      // A ride site says what a sign-in gets you, next to whether they are signed in: being signed
      // in is not the same as a ride being bookable from here, and the two travel together.
      ...(s.ride_access ? { ride_access: s.ride_access } : {}),
    };
  });
}

/**
 * Can this conversation's person sign in at all, and how?
 *
 * The operator is at the Mac the window would open on; nobody else is. That is the only thing this
 * decides, and it reads it off the account rather than off anything a message says.
 */
export function signinRoute(conversationId) {
  const me = accounts.ownerOf(conversationId);
  if (me.isOperator) {
    return {
      can_sign_in: true,
      how: `Call signin_open with the site and a real Chromium window opens on the Mac you run on, on that site's sign-in page, in ${me.name}'s own saved profile. They sign in however they normally would — password manager, a code by text, Face ID, whatever the site asks — and close the window. You are then told what the site says. The window is on the Mac's screen, not on their phone, so say that. The same thing can be started from a terminal with the command below.`,
      command: "npm run signin -- <site>",
      by_link: linkSignin(),
      sites: siteNames(),
      never: refuseAPassword().say,
    };
  }
  return { can_sign_in: false, by_link: linkSignin(), ...remoteSigninAnswer(""), never: refuseAPassword().say };
}

/** The directory one person's logins are in. Named, never guessed at twice. */
export const profileDir = profileDirFor;
