// The sites Omari picked, as a registry rather than a script.
//
// Reason already has a browser it drives itself. What it did not have was any idea what the sites
// it would be sent to are *like*: where you start, whether the page even loads for an automated
// browser, how to tell whether it is signed in, and — the one that matters — what the button that
// actually commits is called on that particular site. "Complete reservation", "Place your order",
// "Request", "Buy tickets" all mean the same irreversible thing and none of them is the word
// `confirm`, which is what the generic gate was looking for.
//
// So this file is two things and deliberately not a third:
//
//   1. **Guidance the model reads.** Where to start, what the site wants, what is known to be hard
//      about it. The model still drives with the ordinary browser tools; nothing here is a
//      sequence of steps, because a scripted sequence breaks the first time a site moves a button
//      and lies about why.
//   2. **Commit labels that feed the gate.** `commitPattern()` is folded into the click guard in
//      `src/tools.js`, so a button labelled "Request ride" is treated as what it is. These are
//      matched on buttons only, never on links — see the long note on `clickCommits`: a link
//      navigates, and gating navigation spends the owner's yes on opening a form.
//
// It is NOT a claim that any of this works. `npm run probe:sites` opens each entry URL in the real
// headless browser from a scratch profile, signed out, and writes down what happened. Most of
// these sites refuse an automated browser outright. That is recorded as a refusal, and a refusal
// is a finding: `docs/unverified.md` carries the run, and nothing here tries to get around one.

/**
 * How Reason tells a signed-in page from a signed-out one, per site.
 *
 * Never a cookie: a cookie that exists says nothing about whether the site still honours it, so
 * "am I signed in" is answered by asking the site. And the two states are not symmetrical, which
 * the first draft of this got wrong —
 *
 *   **Signed OUT is what can be proved.** A signed-out account page either says "Sign in" or
 *   bounces to a sign-in URL, and both are checkable without an account. `when_out` and
 *   `when_out_url` are therefore written from pages really loaded (see `docs/unverified.md`).
 *
 *   **Signed IN is inferred** from the absence of every signed-out signal. `when_in` would be the
 *   stronger test, and it is left EMPTY wherever nobody could load a signed-in page to find out
 *   what it says — guessing at it is how you get a probe that reports "signed in" for a stranger.
 *   The first draft had `when_in: ["pickup", "where to"]` for Uber, and both of those are on
 *   m.uber.com while signed out, so it would have passed for anybody.
 *
 * A page that loads but shows neither is reported `unknown`, and so is a bot wall. Unknown is the
 * honest answer and several of these sites give nothing else.
 */

/** The sites, in the order Omari listed them. */
export const SITES = [
  {
    site: "opentable",
    label: "OpenTable",
    what: "book, change and cancel restaurant tables",
    hosts: ["opentable.com", "opentable.co.uk"],
    entry: "https://www.opentable.com",
    // Not verified: every opentable.com request from here is refused, so no URL on this site has
    // been seen to work. Kept as the best guess, with that said out loud rather than dropped.
    signin_url: "https://www.opentable.com/my/account/signin",
    urls_verified: false,
    // Searching and seeing times is public. The table itself is attached to an account.
    needs_signin: "to_commit",
    signed_in: {
      url: "https://www.opentable.com/my/reservations",
      when_in: [],
      when_out: ["sign in", "create an account", "log in"],
      when_out_url: "signin",
    },
    commit_labels: ["complete reservation", "confirm reservation", "reserve now"],
    limits: [
      "OpenTable refuses this browser outright, so none of the rest of this has been seen to happen.",
      "A table usually wants a name and a mobile number, and some restaurants hold a card against a no-show.",
      "Times go stale fast: a slot read a few minutes ago may be gone by the time the form is filled, and the site says so only at the last step.",
    ],
  },
  {
    site: "uber",
    label: "Uber",
    what: "book a ride",
    // riders.uber.com (the account's own site) and auth.uber.com (where uber.com, m.uber.com and
    // riders.uber.com all send a signed-out browser) are Uber's too: a page read on either is Uber.
    hosts: ["uber.com", "m.uber.com", "riders.uber.com", "auth.uber.com"],
    entry: "https://m.uber.com",
    signin_url: "https://auth.uber.com/login",
    // Most people's Uber is a Google sign-in (owner, 2026-11-10): the button on auth.uber.com is
    // "Continue with Google" (also "Continue with Apple"). src/socialsignin.js uberSocialPath.
    social: { likely: "google", buttons: ["Continue with Google", "Continue with Apple"] },
    urls_verified: true,
    needs_signin: "always",
    signed_in: {
      // Lands on m.uber.com/go/home. Signed out that page carries "Login" and "Sign up" next to a
      // pickup/dropoff form — which is why the form's own words are not used as a signed-in test.
      url: "https://m.uber.com/looking",
      when_in: [],
      when_out: ["log in", "sign up", "login"],
      when_out_url: "",
    },
    commit_labels: ["request ride", "request uber", "confirm ride", "confirm pickup", "request now", "schedule ride"],
    limits: [
      "The ride form is visible signed out, but no price and no car is: those need the account.",
      "A ride request is immediate and starts costing money; there is no hold step to stop at.",
    ],
    // Uber documents this and it needs no key: the link opens Uber with the destination already
    // filled in and the person taps Request themselves. Read 2026-10-05 from
    // developer.uber.com/docs/riders/ride-requests/tutorials/deep-links/introduction; re-read
    // 2026-10-15, when the link was also seen to land on m.uber.com/go/home with the destination
    // resolved to a named place.
    deep_link: "uber_ride",
    // Signed in is one question; "can a ride be booked from here" is another, and for a ride site
    // the two are reported apart (see `ride_access` in the file comment above the registry).
    // A ride is the link, every time (2026-10-23, on the owner's word). The Riders API connector
    // stays in the code for the day Uber grants Full Access, but as of that date nobody had ever
    // connected through it and its `request` scope is refused to everyone Uber has not listed, so
    // reaching for it first stalled most ride requests on a sign-in that could never book.
    ride_access: {
      state: "link",
      means: "A ride is uber_link, every time: the pickup from what is already known (where they said they are, then get_location's live share, recent pin or a saved place that clearly fits now), asking only when none of that is good enough; then uber_link with that pickup, and send the link. They tap Request in Uber themselves. No Uber connection is needed or asked for.",
      why: "Uber's ride-booking API is Limited Access — it refuses everyone Uber has not personally listed — so connecting Uber cannot book a ride for almost anybody. The link works for everyone with the Uber app.",
      handoff: "uber_link with the pickup coordinates from get_location (and the destination if they gave one). Only if they are ALREADY connected (uber_options works) may you offer a booked ride instead; never start uber_connect for a ride.",
    },
    // The sign-in page itself refuses Reason's browser from the server it runs on, which is a
    // different fact from `trust.SITE_REACHABLE` (the errand pages load fine). Seen with the owner
    // in front of it on 2026-10-15: the link opened auth.uber.com, Cloudflare's "Performing security
    // verification" page came up inside it and never went away, and a headless probe from the same
    // server gets HTTP 403 with that page every time. A fresh link hits the same wall, so no link
    // is made and the tools say why instead.
    signin_blocked: {
      why: "Uber's sign-in page (auth.uber.com) answers Reason's browser with a bot check that never clears — HTTP 403, \"Performing security verification\" — from the server Reason runs on. A link or a window would show that page and nothing else.",
      seen: "2026-10-15",
      say: "Uber won't let my browser onto its sign-in page — it stops it with a bot check before the form loads. That's Uber's call, not something you did, and a fresh link would hit the same wall.",
    },
  },
  // Lyft was here until 2026-10-15 and was taken out on the owner's word: it has no ride flow on
  // the web, no reachable developer programme, and its account page refuses Reason's browser from
  // the server, so there was nothing left for an entry to do but say no. A ride is Uber.
  {
    site: "doordash",
    label: "DoorDash",
    what: "order food for delivery",
    hosts: ["doordash.com"],
    entry: "https://www.doordash.com",
    signin_url: "https://identity.doordash.com",
    urls_verified: false,
    needs_signin: "to_commit",
    signed_in: {
      url: "https://www.doordash.com/orders",
      when_in: [],
      when_out: ["sign in", "sign up", "continue with"],
      when_out_url: "identity.doordash.com",
    },
    commit_labels: ["place order", "place your order", "complete order", "pay now"],
    limits: [
      "DoorDash answers this browser with 403 on every page, so nothing below has been seen to happen.",
      "An address is needed before anything is priced, and the address comes off the account.",
      "Fees, taxes and tip are added at the last step, so the total approved has to be the one on the final screen and not the subtotal.",
    ],
  },
  {
    site: "uber_eats",
    label: "Uber Eats",
    what: "order food for delivery",
    hosts: ["ubereats.com"],
    entry: "https://www.ubereats.com",
    signin_url: "https://auth.uber.com/login",
    urls_verified: false,
    needs_signin: "to_commit",
    signed_in: {
      url: "https://www.ubereats.com/orders",
      when_in: [],
      when_out: ["sign in", "log in", "create account"],
      when_out_url: "auth.uber.com",
    },
    commit_labels: ["place order", "place your order", "confirm order"],
    limits: [
      "Uber Eats answers this browser with 403 on every page, so nothing below has been seen to happen.",
      "Same shape as DoorDash: address first, total only at the end.",
      "Shares Uber's sign-in, so signing in to one may sign in to the other — which also means forgetting one may not forget the other.",
    ],
  },
  {
    site: "amazon",
    label: "Amazon",
    what: "find something and order it",
    hosts: ["amazon.com"],
    entry: "https://www.amazon.com",
    // The order-history page, not /ap/signin. The bare sign-in address loads, answers 200, and is
    // a dead "Looking for Something?" page with no form on it: Amazon's sign-in only works when it
    // is reached by redirect, carrying the parameters Amazon itself adds. Asking for a page that
    // needs an account is what gets a working form. Found by opening it, 2026-10-05.
    signin_url: "https://www.amazon.com/gp/css/order-history",
    urls_verified: true,
    needs_signin: "to_commit",
    signed_in: {
      // Signed out this redirects to /ap/signin and the page is titled "Sign in". Both checked.
      url: "https://www.amazon.com/gp/css/order-history",
      when_in: [],
      when_out: ["sign in", "email or mobile phone number"],
      when_out_url: "/ap/signin",
    },
    // "Buy now" and "Place your order" are the two that commit. Adding to a cart commits nothing.
    commit_labels: ["place your order", "place order", "buy now", "submit my order"],
    limits: [
      "Prices and availability are per-account and per-address, so a price read while signed out may not be the price on the account.",
      "One-click buying can skip the review screen entirely, which removes the page the total would have been read off. Prefer the cart route so there is a total to approve.",
    ],
  },
  {
    site: "delta",
    label: "Delta Air Lines",
    what: "look up and book flights on the airline's own site",
    hosts: ["delta.com"],
    entry: "https://www.delta.com",
    signin_url: "https://www.delta.com/login/index",
    urls_verified: false,
    needs_signin: "to_commit",
    signed_in: {
      url: "https://www.delta.com/mytrips/",
      when_in: [],
      when_out: ["log in", "skymiles number", "username"],
      when_out_url: "login",
    },
    commit_labels: ["complete purchase", "purchase", "confirm and purchase", "buy now"],
    limits: [
      "Delta answers this browser with Access Denied (HTTP 444) on every page, so nothing below has been seen to happen.",
      "An airline fare is quoted and then re-quoted at the last step; the number approved must be the one on the payment page.",
      "A traveller's legal name, date of birth and sometimes a passport are needed, and getting one wrong is not a cheap mistake to fix.",
    ],
  },
  {
    site: "united",
    label: "United Airlines",
    what: "look up and book flights on the airline's own site",
    hosts: ["united.com"],
    entry: "https://www.united.com",
    signin_url: "https://www.united.com/en/us/account/login",
    urls_verified: false,
    needs_signin: "to_commit",
    signed_in: {
      url: "https://www.united.com/en/us/manageres/mytrips",
      when_in: [],
      when_out: ["sign in", "mileageplus number"],
      when_out_url: "login",
    },
    commit_labels: ["complete purchase", "purchase", "confirm and purchase", "buy now"],
    limits: [
      "united.com drops the connection on this browser (ERR_HTTP2_PROTOCOL_ERROR) and on plain curl too, so nothing below has been seen to happen.",
      "Same as Delta: the fare moves, and the passenger details have to be exactly right.",
    ],
  },
  {
    site: "ticketmaster",
    label: "Ticketmaster",
    what: "find and buy event tickets",
    hosts: ["ticketmaster.com", "livenation.com"],
    entry: "https://www.ticketmaster.com",
    signin_url: "https://auth.ticketmaster.com/as/authorization.oauth2",
    urls_verified: false,
    needs_signin: "to_commit",
    signed_in: {
      url: "https://www.ticketmaster.com/member",
      when_in: [],
      when_out: ["sign in", "create account"],
      when_out_url: "auth.ticketmaster.com",
    },
    commit_labels: ["buy tickets", "place order", "complete purchase", "checkout", "get tickets now"],
    limits: [
      "Ticketmaster answers this browser with 403 on every page, so nothing below has been seen to happen.",
      "Tickets sit behind a countdown: a held seat is released after a few minutes, so an approval that arrives late is an approval for something that no longer exists.",
      "High-demand events put a queue and a bot check in front of everyone, automated or not.",
    ],
  },
  {
    site: "fandango",
    label: "Fandango",
    what: "find showtimes and buy cinema tickets",
    hosts: ["fandango.com"],
    entry: "https://www.fandango.com",
    // Both of these were read off Fandango's own homepage and then loaded. The first guesses
    // (/signin, /accounts/purchases) were 404s, which is why they are not the ones here.
    signin_url: "https://www.fandango.com/accounts/sign-in",
    urls_verified: true,
    // Showtimes are public; a seat is not.
    needs_signin: "to_commit",
    signed_in: {
      url: "https://www.fandango.com/accounts/dashboard",
      when_in: [],
      when_out: ["sign in to fandango", "forgot your password"],
      when_out_url: "/accounts/sign-in",
    },
    // "Get tickets" on a listing only navigates; the commit is the last button on checkout.
    commit_labels: ["place order", "complete purchase", "buy tickets", "confirm purchase"],
    limits: [
      "Seats are held for a few minutes while checkout is open, so the total and the seats can both expire mid-flow.",
      "Fees are added after the ticket price, so the subtotal is never the total.",
    ],
  },
];

const BY_SITE = new Map(SITES.map(s => [s.site, s]));

export function siteNames() {
  return SITES.map(s => s.site);
}

export function site(name) {
  return BY_SITE.get(String(name ?? "").trim().toLowerCase()) ?? null;
}

/** Hostname, lowercased, with the port kept — a fixture lives on 127.0.0.1:PORT. */
function hostOf(url) {
  try {
    const u = new URL(String(url));
    return u.host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Which registry site is this URL on?
 *
 * `extraHosts` maps a host to a site name, and exists so an offline test can stand a fixture page
 * up on 127.0.0.1 and have the site-specific guards apply to it. Production passes nothing: a real
 * host matches by domain suffix or it is not one of these sites.
 */
export function siteFor(url, extraHosts = null) {
  const host = hostOf(url);
  if (!host) return null;
  if (extraHosts) {
    const named = extraHosts[host] ?? extraHosts[host.split(":")[0]];
    if (named && BY_SITE.has(named)) return BY_SITE.get(named);
  }
  const bare = host.split(":")[0];
  for (const s of SITES) {
    if (s.hosts.some(h => bare === h || bare.endsWith(`.${h}`))) return s;
  }
  return null;
}

/**
 * Every commit label any of these sites uses, as one pattern for the click guard.
 *
 * Deliberately NOT keyed by host. A button that says "Place your order" commits an order wherever
 * it is, and a guard that only recognises that on doordash.com is a guard that fails on the one
 * host nobody thought of — which, for something irreversible, is the wrong way round. The labels
 * are collected here so there is one list to read and one place to add to.
 */
export function commitPattern() {
  const labels = [...new Set(SITES.flatMap(s => s.commit_labels))]
    .sort((a, b) => b.length - a.length)
    .map(l => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return new RegExp(`\\b(${labels.join("|")})\\b`, "i");
}

/**
 * Read a loaded account page and say which state it is in.
 *
 * Shared by the probe, the sign-in command and the tool the model calls, so all three answer the
 * same question the same way. `signed_in` is only ever returned when the page really loaded and
 * carried none of the signed-out signals — and the evidence line says that is what happened,
 * rather than claiming something was seen that was not.
 */
export function readSignedInState(entry, { url = "", text = "", status = null, error = null } = {}) {
  const spec = entry.signed_in;
  if (error) return { state: "unknown", why: `could not load ${spec.url}: ${error}` };
  if (status && status >= 400) return { state: "unknown", why: `${spec.url} answered HTTP ${status}` };
  const body = String(text ?? "").toLowerCase();
  const landed = String(url ?? "").toLowerCase();
  // The landing URL is checked BEFORE the page is judged for having enough text on it. A site that
  // bounced the request to its own sign-in page has answered the question, and how much of that
  // page rendered for a headless browser is beside the point — Amazon's sign-in page comes back as
  // a few hundred characters, and an earlier version of this called that "unknown" and threw away
  // the clearest signal there is.
  if (spec.when_out_url && landed.includes(spec.when_out_url.toLowerCase())) {
    return { state: "signed_out", why: `it bounced to ${url}, which is the sign-in page` };
  }
  if (body.trim().length < 50) {
    return { state: "unknown", why: `${spec.url} came back with almost no readable text (${body.trim().length} characters), so neither state can be read off it` };
  }
  const outHit = spec.when_out.find(t => body.includes(t.toLowerCase()));
  if (outHit) return { state: "signed_out", why: `the page still says "${outHit}"` };
  const inHit = spec.when_in.find(t => body.includes(t.toLowerCase()));
  if (inHit) return { state: "signed_in", why: `the page says "${inHit}", which only shows when signed in` };
  return {
    state: "signed_in",
    why: `${spec.url} loaded and asked for no sign-in (none of ${spec.when_out.map(t => `"${t}"`).join(", ")} on it). Inferred from what is absent, not from anything positive on the page`,
    inferred: true,
  };
}

/**
 * Uber's documented universal deep link, which needs no key and no account here: it opens Uber
 * with the destination already filled in and the person taps Request themselves. Reason never
 * requests the ride, which is exactly why this is worth having — it is the whole errand minus the
 * one step that should not be automated at all.
 *
 * Shape read 2026-10-05 from Uber's deep-link docs: `drop[0]` is a URL-encoded JSON Location with
 * `latitude`, `longitude` and `addressLine1`. With no coordinates, only `addressLine1` goes in —
 * Uber's docs recommend as many parameters as possible and mark none of them required.
 */
/**
 * The ride link: Uber's mobile web booking page, with pickup and drop-off filled in.
 *
 * What Omari's taps showed (2026-10-23): the Uber APP ignores every pre-fill we tried — the JSON
 * shape, the documented `action=setPickup` bracketed keys, `/looking` and `/ul/` alike — and opens
 * empty. That matches years of reports that the app stopped honouring setPickup around iOS 13
 * (developer.apple.com/forums/thread/124243, stackoverflow 57038944). The WEB booking page does
 * honour the JSON shape: on his Mac the same link opened with "Racket NYC → 3247 Bruner Ave" and
 * live prices. `https://m.uber.com/looking` and `/ul` are claimed by the app in m.uber.com's
 * apple-app-site-association, so a tap on an iPhone goes to the app and loses everything;
 * `/go/looking` is not claimed, so it opens in the browser, on the page that reads it.
 * `format: "app"` keeps the setPickup shape, and `base` the address, for comparison only.
 */
export function uberRideLink({ address, latitude = null, longitude = null, pickup_latitude = null, pickup_longitude = null, pickup_address = null, client_id = null, base = "https://m.uber.com/go/looking", format = "web" } = {}) {
  const label = String(address ?? "").trim();
  const pickupLabel = String(pickup_address ?? "").trim();
  const hasCoords = pickup_latitude != null && pickup_longitude != null;
  const hasPickup = hasCoords || !!pickupLabel;
  if (!label && !hasPickup) return { ok: false, error: "A deep link needs a pickup (their coordinates from get_location) or somewhere to go." };
  const dropCoords = !!label && latitude != null && longitude != null;
  const q = new URLSearchParams();
  const id = client_id ?? process.env.UBER_CLIENT_ID ?? "";
  if (id) q.set("client_id", id);
  if (format !== "app") {
    if (hasPickup) {
      const p = hasCoords ? { latitude: Number(pickup_latitude), longitude: Number(pickup_longitude) } : {};
      if (pickupLabel) p.addressLine1 = pickupLabel;
      q.set("pickup", JSON.stringify(p));
    }
    if (label) {
      const d = { addressLine1: label };
      if (dropCoords) { d.latitude = Number(latitude); d.longitude = Number(longitude); }
      q.set("drop[0]", JSON.stringify(d));
    }
  } else {
    q.set("action", "setPickup");
    // Uber's own pickup when there is no point to give: the app uses the phone's location.
    if (hasCoords) {
      q.set("pickup[latitude]", String(Number(pickup_latitude)));
      q.set("pickup[longitude]", String(Number(pickup_longitude)));
      if (pickupLabel) {
        q.set("pickup[nickname]", pickupLabel.split(",")[0].trim());
        q.set("pickup[formatted_address]", pickupLabel);
      }
    } else {
      q.set("pickup", "my_location");
    }
    if (label) {
      if (dropCoords) {
        q.set("dropoff[latitude]", String(Number(latitude)));
        q.set("dropoff[longitude]", String(Number(longitude)));
      }
      q.set("dropoff[nickname]", label.split(",")[0].trim());
      q.set("dropoff[formatted_address]", label);
    }
  }
  const url = `${base}?${q.toString().replace(/\+/g, "%20")}`;
  const notes = [
    hasCoords ? "The pickup is set." : "No pickup point could be set, so Uber will pick them up wherever their phone says they are — say so, and say which address you meant.",
    !label ? "No destination is filled in; they type it in Uber."
      : dropCoords ? "The destination is filled in."
        : "The destination is typed in as text; Uber may not resolve it to the right place without coordinates, so say which address it was.",
    "Nothing is requested and nothing is charged until they tap Request themselves.",
    "It opens Uber's booking page in their browser with the trip filled in (the Uber app ignores pre-filled trips). Say that in one short line, and that the first time they may need to sign in to Uber there.",
  ];
  return {
    ok: true,
    url,
    opens: label || null,
    has_pickup: hasPickup,
    has_coordinates: dropCoords,
    note: notes.join(" "),
  };
}

export const DEEP_LINKS = { uber_ride: uberRideLink };

/** What the model is told about one site, without the internals of the probe. */
export function playbook(name) {
  const s = site(name);
  if (!s) return null;
  return {
    site: s.site,
    label: s.label,
    what: s.what,
    start_at: s.entry,
    needs_signin: s.needs_signin,
    signin_url: s.signin_url,
    urls_verified: s.urls_verified,
    how_to_tell_signed_in: `Open ${s.signed_in.url}. Signed out it says ${s.signed_in.when_out.map(t => `"${t}"`).join(" / ")}${s.signed_in.when_out_url ? ` or bounces to a URL containing "${s.signed_in.when_out_url}"` : ""}. Signed in is inferred from none of that being there.`,
    commits_are_called: s.commit_labels,
    limits: s.limits,
    ...(s.deep_link ? { official_fallback: s.deep_link } : {}),
    ...(s.ride_access ? { ride_access: s.ride_access } : {}),
  };
}
