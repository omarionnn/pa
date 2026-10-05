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
import { profileDirFor } from "./browser.js";
import { SITES, site as findSite, readSignedInState, siteNames } from "./sites.js";

/** Reason's answer when somebody offers a password. Returned by the tool, not left to the model. */
export function refuseAPassword() {
  return {
    rule: "no_passwords_in_chat",
    say: `I don't take passwords — not here, not anywhere. Even if you sent one I would not use it.`
      + ` Two reasons: a password in a text message is in your messages forever and in my logs too, and a password to one site is usually the password to your email as well.`
      + ` You sign in yourself in a window on the Mac and I keep the session the site gives you, the same way your laptop does.`,
    why: "A password typed into a conversation is stored by the messaging app, by this process, and in any transcript of either. The sign-in window never hands one to Reason, so there is nothing to leak.",
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
  return {
    possible: false,
    why: "Signing in needs a browser window you can see and type into. Reason's browser runs on Omari's Mac, so there is no window to show you from here — and there is no way to do this safely from a text message yet.",
    never: "Reason will not take a password in chat to sign in on your behalf. That is not a missing feature; it is the one way of doing this that is ruled out.",
    what_it_would_take: "A hosted browser you could watch and type into from a link — your own session, visible to you, with the keystrokes going to the site and not through Reason. That is real work (a streamed browser, a per-person sandbox, and a way to prove the link is yours) and none of it is built.",
    for_now: `Ask ${config.ownerName} to do the bit that needs an account, or pick something Reason can do without signing in as you.`,
  };
}

/**
 * Open the site's account page in a page we already have and read which state it is in.
 *
 * Takes a Playwright page rather than making one, so the same function serves the headless errand
 * browser, the visible sign-in window and the probe script. It navigates — there is no way to ask
 * a site whether a cookie is still good without asking it.
 */
export async function probeSignedIn(page, siteName) {
  const entry = findSite(siteName);
  if (!entry) return { ok: false, error: `No site called '${siteName}'. Known: ${siteNames().join(", ")}.` };
  let status = null;
  let error = null;
  let text = "";
  let landed = entry.signed_in.url;
  try {
    const res = await page.goto(entry.signed_in.url, { waitUntil: "domcontentloaded" });
    status = res?.status() ?? null;
    await page.waitForTimeout(1500);
    text = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
    landed = page.url();
  } catch (e) {
    error = (e?.message ?? String(e)).split("\n")[0];
  }
  const read = readSignedInState(entry, { url: landed, text, status, error });
  return { ok: true, site: entry.site, checked_url: entry.signed_in.url, landed, status, ...read };
}

/** Probe, then write the result down. The only way a sign-in state gets recorded. */
export async function checkAndRecord(page, conversationId, siteName) {
  const out = await probeSignedIn(page, siteName);
  if (!out.ok) return out;
  db.recordSiteSignin(conversationId, out.site, { state: out.state, evidence: out.why });
  return out;
}

/**
 * Forget one site: clear what the site stored in this person's profile, and stop claiming it is
 * connected.
 *
 * Honest about its edges, because a half-clear that reads as a full one is worse than no clear at
 * all. Cookies go by domain and localStorage/sessionStorage go per origin. IndexedDB, Cache
 * Storage and service workers are NOT cleared — Playwright has no per-origin call for them on a
 * persistent profile, and a site that kept a token in IndexedDB may still be signed in. That is
 * returned as `also_check`, and the only way to be certain is to delete the whole profile, which
 * `npm run data:delete` does.
 */
export async function forgetSite(context, conversationId, siteName) {
  const entry = findSite(siteName);
  if (!entry) return { ok: false, error: `No site called '${siteName}'. Known: ${siteNames().join(", ")}.` };

  const cleared = { cookies: [], storage: [], failed: [] };
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
        await page.evaluate(() => {
          try { localStorage.clear(); } catch { /* a site may forbid it */ }
          try { sessionStorage.clear(); } catch { /* same */ }
        });
        cleared.storage.push(origin);
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
    problems: cleared.failed,
    also_check: "IndexedDB, Cache Storage and service workers are not cleared — Playwright has no per-origin call for them on a saved profile. If the site kept a token there it may still be signed in. The only certain way is to delete the whole profile: npm run data:delete -- <conversation> --yes",
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
      ...(live ? {} : { how_to_sign_in: signinCommand(s.site) }),
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
      sites: siteNames(),
      never: refuseAPassword().say,
    };
  }
  return { can_sign_in: false, ...remoteSigninAnswer(""), never: refuseAPassword().say };
}

/** The directory one person's logins are in. Named, never guessed at twice. */
export const profileDir = profileDirFor;
