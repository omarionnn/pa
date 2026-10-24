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
import { SITES, site as findSite, readSignedInState, siteNames } from "./sites.js";
import * as cancelRoutes from "./cancel-routes.js";
import * as airlines from "./airlines.js";

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
export async function probeSignedIn(page, siteName, { entry: given = null } = {}) {
  // `given` is the registry entry already in hand, for the one caller that has one: the cancel rail
  // resolves a service through its own registry (which a test can stand a fixture in) and then asks
  // this to read the page. Everything else passes a name and this looks it up.
  const entry = given ?? entryFor(siteName);
  if (!entry) return { ok: false, error: `No site called '${siteName}'. Known: ${signinNames().join(", ")}.` };
  let status = null;
  let error = null;
  let text = "";
  let landed = entry.signed_in.url;
  // Twice, because the page is shared. There is one Chromium per conversation, so this probe can
  // start while the tab is still carrying a navigation that failed a moment ago — and Chromium
  // reports THAT as an error against THIS one ("interrupted by another navigation"). Read
  // literally, the answer comes back `unknown`, and every caller reads unknown as "they are not
  // signed in" and asks somebody to sign in to a site they were already signed in to. So on that
  // one error the tab is parked and the question asked again; a site that genuinely will not load
  // fails the same way the second time and is reported honestly.
  for (let attempt = 0; attempt < 2; attempt++) {
    status = null;
    error = null;
    try {
      const res = await page.goto(entry.signed_in.url, { waitUntil: "domcontentloaded" });
      status = res?.status() ?? null;
      await page.waitForTimeout(1500);
      text = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
      landed = page.url();
      break;
    } catch (e) {
      error = (e?.message ?? String(e)).split("\n")[0];
      if (attempt === 1 || !/interrupted by another navigation/i.test(error)) break;
      await settleBrowser(page);
    }
  }
  const read = readSignedInState(entry, { url: landed, text, status, error });
  return { ok: true, site: entry.site, checked_url: entry.signed_in.url, landed, status, ...read };
}

/** Probe, then write the result down. The only way a sign-in state gets recorded. */
export async function checkAndRecord(page, conversationId, siteName, { entry = null } = {}) {
  const out = await probeSignedIn(page, siteName, { entry });
  if (!out.ok) return out;
  db.recordSiteSignin(conversationId, out.site, { state: out.state, evidence: out.why });
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
  const entry = entryFor(siteName);
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
      const origin = `https://${host.startsWith("www.") ? host : `www.${host}`}`;
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
