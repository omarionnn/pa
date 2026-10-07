// How each airline is checked in to, as a registry rather than a script. The sibling of
// `src/cancel-routes.js`, and built the same way for the same reason: the model decides what
// somebody MEANT ("i'm on delta friday"), and a lookup decides what Delta's check-in page is. A
// model guessing at a URL is a model landing on a 404 while telling somebody they are checked in.
//
// What is in an entry, and why each part is worth having:
//
//   1. **The route.** `web` (a page Reason can drive), `app` (check-in only happens inside the
//      airline's own app on their phone), `desk` (only at the airport), `unknown` (nobody has read
//      it). The route decides whether there is anything to walk at all, and an airline nobody has
//      written down is `unknown` rather than a guess.
//   2. **When check-in opens**, in hours before departure, and in the FLIGHT's zone — never the
//      server's. 24 hours is what nearly every carrier does; the field is per airline because they
//      do differ, and the honest state of this file is that none of these was read off an airline's
//      own page (see the provenance note below).
//   3. **The check-in page**, and what it asks for: a confirmation code and a last name, or a
//      signed-in account. `url_verified` is false on every entry here, because it is.
//   4. **The label on the button that commits**, which feeds `commitPattern()` — folded into
//      `browser_click`'s guard in src/tools.js, so the press that actually checks somebody in is
//      refused there and has to go through the gate. None of these labels is caught by the generic
//      commit words: "Check in", "Check in now" and "Get boarding pass" contain no `submit`,
//      `confirm`, `book` or `pay`.
//   5. **What a checked-in page says**, so the claim "done" is read off the page by code rather than
//      taken from a 200 (`checkedInWords`, used by `src/flights.js`).
//   6. **The limits worth saying out loud BEFORE a yes**: a fare that cannot self-check-in, a bag
//      fee wall, a seat that costs money. Reason never spends money on a check-in, so each of these
//      is a place it stops and hands back rather than a place it decides.
//
// **PROVENANCE, SAID PLAINLY: not one airline page was read to write this file.** The build it came
// from was explicitly not allowed to contact a real airline, so every address, every button label
// and every window below is written from general knowledge and marked `how: "not_read"`. That is a
// weaker thing than `src/cancel-routes.js`, where each entry carries the help page it came off and
// the date. Treat an address here as a starting point the browser has to read and check, never as a
// fact — the tools say exactly that in their results, and `docs/unverified.md` carries it in full.
//
// What this file is NOT: a promise that any of it works. Nothing in Reason has ever checked anybody
// in to anything. The browser tests drive a fixture airline on 127.0.0.1 that is shaped like these
// pages, which proves the rail and proves nothing about Delta.

/** Hours before departure that check-in opens, when nobody has read the airline's own rule. */
export const DEFAULT_WINDOW_HOURS = 24;

const NOT_READ = { url: "", read_on: "", how: "not_read" };

export const AIRLINES = [
  {
    airline: "delta",
    label: "Delta",
    // The strings that mean this airline on a confirmation email's From line, in a calendar event's
    // title, or in what somebody typed. Matched by `match()` below, which is a lookup on a NAME and
    // never a reading of anything a person said.
    names: ["delta", "delta air lines", "dl"],
    iata: "DL",
    route: "web",
    checkin_url: "https://www.delta.com/mytrips/",
    url_verified: false,
    checkin_opens_hours: DEFAULT_WINDOW_HOURS,
    // What the page wants before it will show a trip. `code_and_name` is the one that needs no
    // account at all, which is why it is preferred wherever an airline offers it.
    finds_trip_by: "code_and_name",
    hosts: ["delta.com"],
    signin_url: "https://www.delta.com/login",
    account_url: "https://www.delta.com/mytrips/",
    signed_out_says: ["sign in", "log in", "skymiles number"],
    signed_out_url: "login",
    steps: [
      "Open My Trips.",
      "Find the trip by confirmation number and last name.",
      "Press Check In.",
      "Read the seat and the passenger name back off the screen before the last press.",
    ],
    commit_labels: ["check in", "check in now", "complete check-in", "get boarding pass"],
    commits: "Check In",
    checked_in_words: ["checked in", "you're checked in", "boarding pass"],
    // This one is not general knowledge — it is a thing that was actually tried. `src/sites.js`'s
    // Delta entry records that delta.com answers this browser with Access Denied (HTTP 444) on
    // every page. So the most likely outcome of a Delta check-in is the site refusing, and that is
    // the site's decision and a finding worth telling somebody, not something to route around.
    refuses_this_browser: "delta.com answered this browser with Access Denied (HTTP 444) on every page when src/sites.js was written. A check-in here will very likely not load at all.",
    limits: [
      "Delta sells seat changes on most fares. A seat that costs money is not a seat Reason takes — it stops and hands it back.",
      "A basic economy fare has no seat choice at all until check-in, and what it gives is what it gives.",
    ],
    source: NOT_READ,
  },
  {
    airline: "united",
    label: "United",
    names: ["united", "united airlines", "ua"],
    iata: "UA",
    route: "web",
    checkin_url: "https://www.united.com/en/us/checkin",
    url_verified: false,
    checkin_opens_hours: DEFAULT_WINDOW_HOURS,
    finds_trip_by: "code_and_name",
    hosts: ["united.com"],
    signin_url: "https://www.united.com/en/us/account/login",
    account_url: "https://www.united.com/en/us/manageres/mytrips",
    signed_out_says: ["sign in", "mileageplus number", "password"],
    signed_out_url: "login",
    steps: [
      "Open the check-in page.",
      "Enter the confirmation number and last name.",
      "Press Check in.",
      "Read the seat and the passenger name back off the screen before the last press.",
    ],
    commit_labels: ["check in", "check-in", "get boarding pass"],
    commits: "Check in",
    checked_in_words: ["checked in", "boarding pass"],
    // Also tried rather than assumed: src/sites.js records that united.com drops the connection on
    // this browser (ERR_HTTP2_PROTOCOL_ERROR) and on plain curl too.
    refuses_this_browser: "united.com dropped the connection on this browser (ERR_HTTP2_PROTOCOL_ERROR) when src/sites.js was written, and on plain curl too. A check-in here will very likely not load at all.",
    limits: [
      "United puts bag purchases in the middle of its check-in flow. Reason spends nothing: a wall asking for payment stops it.",
    ],
    source: NOT_READ,
  },
  {
    airline: "american",
    label: "American Airlines",
    names: ["american airlines", "american", "aa"],
    iata: "AA",
    route: "web",
    checkin_url: "https://www.aa.com/reservation/view/find-your-trip",
    url_verified: false,
    checkin_opens_hours: DEFAULT_WINDOW_HOURS,
    finds_trip_by: "code_and_name",
    hosts: ["aa.com"],
    signin_url: "https://www.aa.com/loyalty/login",
    account_url: "https://www.aa.com/reservation/viewReservationsAccess.do",
    signed_out_says: ["log in", "aadvantage number", "password"],
    signed_out_url: "login",
    steps: [
      "Open Find your trip.",
      "Enter the record locator and last name.",
      "Press Check in.",
      "Read the seat and the passenger name back off the screen before the last press.",
    ],
    commit_labels: ["check in", "check-in", "get boarding pass"],
    commits: "Check in",
    checked_in_words: ["checked in", "boarding pass"],
    limits: [
      "American calls a confirmation code a record locator. Same six characters.",
      "A basic economy fare is checked in like any other, but there is no seat to choose.",
    ],
    source: NOT_READ,
  },
  {
    airline: "southwest",
    label: "Southwest",
    names: ["southwest", "southwest airlines", "wn"],
    iata: "WN",
    route: "web",
    checkin_url: "https://www.southwest.com/air/check-in/",
    url_verified: false,
    checkin_opens_hours: DEFAULT_WINDOW_HOURS,
    finds_trip_by: "code_and_name",
    hosts: ["southwest.com"],
    signin_url: "https://www.southwest.com/loginFlow",
    account_url: "https://www.southwest.com/myaccount/trips",
    signed_out_says: ["log in", "rapid rewards", "password"],
    signed_out_url: "login",
    steps: [
      "Open Check in.",
      "Enter the confirmation number, first name and last name.",
      "Press Check in.",
      "Read the boarding position off the screen — on Southwest that is what check-in is for.",
    ],
    commit_labels: ["check in", "check-in", "retrieve boarding pass"],
    commits: "Check in",
    checked_in_words: ["checked in", "boarding pass", "boarding position"],
    limits: [
      "Southwest has no assigned seats: what check-in gets is a BOARDING POSITION (A, B or C plus a number), and being a minute late costs real positions. A seat preference means nothing here, and saying 'you kept 14C' about a Southwest flight would be inventing a seat.",
      "Southwest's own check-in asks for a first name as well as a last one.",
    ],
    source: NOT_READ,
  },
  {
    airline: "jetblue",
    label: "JetBlue",
    names: ["jetblue", "jet blue", "b6"],
    iata: "B6",
    route: "web",
    checkin_url: "https://www.jetblue.com/checkin",
    url_verified: false,
    checkin_opens_hours: DEFAULT_WINDOW_HOURS,
    finds_trip_by: "code_and_name",
    hosts: ["jetblue.com"],
    signin_url: "https://www.jetblue.com/login",
    account_url: "https://www.jetblue.com/my-trips",
    signed_out_says: ["sign in", "trueblue", "password"],
    signed_out_url: "login",
    steps: [
      "Open Check in.",
      "Enter the confirmation code and last name.",
      "Press Check in.",
      "Read the seat and the passenger name back off the screen before the last press.",
    ],
    commit_labels: ["check in", "check-in", "get boarding pass"],
    commits: "Check in",
    checked_in_words: ["checked in", "boarding pass"],
    limits: [
      "A Blue Basic fare boards last and its seat is assigned at check-in. Nothing to pick.",
    ],
    source: NOT_READ,
  },
  {
    airline: "alaska",
    label: "Alaska Airlines",
    names: ["alaska airlines", "alaska", "as"],
    iata: "AS",
    route: "web",
    checkin_url: "https://www.alaskaair.com/checkin",
    url_verified: false,
    checkin_opens_hours: DEFAULT_WINDOW_HOURS,
    finds_trip_by: "code_and_name",
    hosts: ["alaskaair.com"],
    signin_url: "https://www.alaskaair.com/account/login",
    account_url: "https://www.alaskaair.com/account/trips",
    signed_out_says: ["sign in", "mileage plan", "password"],
    signed_out_url: "login",
    steps: [
      "Open Check in.",
      "Enter the confirmation code and last name.",
      "Press Check in.",
      "Read the seat and the passenger name back off the screen before the last press.",
    ],
    commit_labels: ["check in", "check-in", "get boarding pass"],
    commits: "Check in",
    checked_in_words: ["checked in", "boarding pass"],
    limits: [],
    source: NOT_READ,
  },
  {
    airline: "spirit",
    label: "Spirit",
    names: ["spirit", "spirit airlines", "nk"],
    iata: "NK",
    route: "web",
    checkin_url: "https://www.spirit.com/check-in",
    url_verified: false,
    checkin_opens_hours: DEFAULT_WINDOW_HOURS,
    finds_trip_by: "code_and_name",
    hosts: ["spirit.com"],
    signin_url: "https://www.spirit.com/login",
    account_url: "https://www.spirit.com/my-trips",
    signed_out_says: ["log in", "password"],
    signed_out_url: "login",
    steps: [
      "Open Check in.",
      "Enter the confirmation code and last name.",
      "Press Check in.",
      "Expect to be asked to buy a bag or a seat. That is where Reason stops.",
    ],
    commit_labels: ["check in", "check-in", "get boarding pass"],
    commits: "Check in",
    checked_in_words: ["checked in", "boarding pass"],
    limits: [
      "Spirit charges for a carry-on, a checked bag and any seat, and puts all of it inside check-in. Reason spends nothing, so a Spirit check-in is the one most likely to come back as a hand-back rather than a done.",
    ],
    source: NOT_READ,
  },
  {
    airline: "frontier",
    label: "Frontier",
    names: ["frontier", "frontier airlines", "f9"],
    iata: "F9",
    route: "web",
    checkin_url: "https://www.flyfrontier.com/check-in/",
    url_verified: false,
    checkin_opens_hours: DEFAULT_WINDOW_HOURS,
    finds_trip_by: "code_and_name",
    hosts: ["flyfrontier.com"],
    signin_url: "https://www.flyfrontier.com/login/",
    account_url: "https://www.flyfrontier.com/my-trips/",
    signed_out_says: ["log in", "password"],
    signed_out_url: "login",
    steps: [
      "Open Check in.",
      "Enter the confirmation code and last name.",
      "Press Check in.",
      "Expect a bag and seat upsell. That is where Reason stops.",
    ],
    commit_labels: ["check in", "check-in", "get boarding pass"],
    commits: "Check in",
    checked_in_words: ["checked in", "boarding pass"],
    limits: [
      "Frontier charges for bags and seats inside check-in, same as Spirit.",
    ],
    source: NOT_READ,
  },
  {
    airline: "british_airways",
    label: "British Airways",
    names: ["british airways", "ba"],
    iata: "BA",
    route: "web",
    checkin_url: "https://www.britishairways.com/travel/managebooking/public/en_gb",
    url_verified: false,
    checkin_opens_hours: DEFAULT_WINDOW_HOURS,
    finds_trip_by: "code_and_name",
    hosts: ["britishairways.com"],
    signin_url: "https://www.britishairways.com/travel/loginr/public/en_gb",
    account_url: "https://www.britishairways.com/travel/managebooking/public/en_gb",
    signed_out_says: ["log in", "sign in", "password"],
    signed_out_url: "login",
    steps: [
      "Open Manage my booking.",
      "Enter the booking reference and last name.",
      "Check in.",
      "Read the seat and the passenger name back off the screen before the last press.",
    ],
    commit_labels: ["check in", "check-in", "get boarding pass"],
    commits: "Check in",
    checked_in_words: ["checked in", "boarding pass"],
    limits: [
      "A booking reference on BA is six characters, same shape as everybody else's.",
      "A flight on a partner's metal is checked in with that partner, not with BA — and which one that is is on the booking, not something to assume.",
    ],
    source: NOT_READ,
  },
  {
    airline: "air_canada",
    label: "Air Canada",
    names: ["air canada", "ac"],
    iata: "AC",
    route: "web",
    checkin_url: "https://www.aircanada.com/ca/en/aco/home/book/check-in.html",
    url_verified: false,
    checkin_opens_hours: DEFAULT_WINDOW_HOURS,
    finds_trip_by: "code_and_name",
    hosts: ["aircanada.com"],
    signin_url: "https://www.aircanada.com/ca/en/aco/home/aeroplan/sign-in.html",
    account_url: "https://www.aircanada.com/ca/en/aco/home/manage-booking.html",
    signed_out_says: ["sign in", "aeroplan number", "password"],
    signed_out_url: "sign-in",
    steps: [
      "Open Check in.",
      "Enter the booking reference and last name.",
      "Check in.",
      "Read the seat and the passenger name back off the screen before the last press.",
    ],
    commit_labels: ["check in", "check-in", "get boarding pass"],
    commits: "Check in",
    checked_in_words: ["checked in", "boarding pass"],
    limits: [],
    source: NOT_READ,
  },
];

const BY_AIRLINE = new Map(AIRLINES.map(a => [a.airline, a]));

export const ROUTE_KINDS = ["web", "app", "desk", "unknown"];

export function airlineNames() {
  return AIRLINES.map(a => a.airline);
}

export function airline(name) {
  return BY_AIRLINE.get(String(name ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")) ?? null;
}

/**
 * Which registry entry a name is about, or null.
 *
 * A lookup on the name of an airline, not a reading of anything a person said. Deciding that "i'm
 * flying to atlanta friday on delta" is about a Delta flight is the model's job (house rule);
 * turning the string "delta" into Delta's check-in page is this.
 *
 * Longest name first, so "american airlines" wins over "american". A bare two-letter code is
 * matched only when it is the WHOLE string or the front of a flight number ("DL 1234", "DL1234"):
 * "as" and "aa" appear inside ordinary words, and an entry picked out of the middle of a sentence
 * would be the registry guessing.
 */
export function match(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  const hay = raw.toLowerCase();
  let best = null;
  for (const a of AIRLINES) {
    for (const n of a.names) {
      const hit = n.length <= 2
        ? new RegExp(`^${n}\\s*\\d*$`, "i").test(raw)
        : hay.includes(n);
      if (!hit) continue;
      if (!best || n.length > best.len) best = { entry: a, len: n.length };
    }
  }
  return best?.entry ?? null;
}

// One-word labels that never go into the click guard, however an airline uses them. "Continue" is
// the button out of every upsell screen on every airline site and it commits nothing on almost all
// of them; a guard that treated it as irreversible would refuse to turn a page and spend a yes on
// navigation, which is the failure the guard in src/tools.js was rewritten to avoid.
const TOO_GENERIC = new Set(["continue", "next", "done", "ok", "go"]);

/**
 * Every check-in commit label as one pattern for the click guard, the way `sites.commitPattern()`
 * and `cancelRoutes.commitPattern()` do. Built once at load; the registry does not change at runtime.
 */
export function commitPattern() {
  const labels = [...new Set(AIRLINES.flatMap(a => a.commit_labels ?? []))]
    .map(l => String(l).trim().toLowerCase())
    .filter(l => l && !TOO_GENERIC.has(l))
    .sort((a, b) => b.length - a.length)
    .map(l => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]+"));
  return new RegExp(`\\b(${labels.join("|")})\\b`, "i");
}

/** Every label in the guard, for a test that wants to check one is in there. */
export function commitWords() {
  return [...new Set(AIRLINES.flatMap(a => a.commit_labels ?? []))]
    .map(l => String(l).trim().toLowerCase())
    .filter(l => l && !TOO_GENERIC.has(l));
}

/**
 * A sites.js-shaped entry, so an airline can use the sign-in machinery that already exists.
 *
 * Exactly `cancelRoutes.signinEntry`'s reasoning: the saved sign-ins, the phone sign-in link and the
 * "is this signed in" probe are all written against the shape in src/sites.js, so an airline is
 * handed back in that shape rather than any of that being copied.
 *
 * `when_in` is empty on every one of them, on purpose: nobody here has loaded a signed-in page on
 * any airline, so there is nothing positive to test for, and inventing one is how a probe reports
 * "signed in" for a stranger. Signed-OUT is what can be proved.
 */
export function signinEntry(name) {
  return signinEntryFrom(airline(name));
}

function signinEntryFrom(a) {
  if (!a || a.route !== "web") return null;
  if (!a.signin_url || !a.account_url) return null;
  return {
    site: a.airline,
    label: a.label,
    what: `see their ${a.label} trips and check in`,
    hosts: a.hosts ?? [],
    entry: a.account_url,
    signin_url: a.signin_url,
    urls_verified: !!a.url_verified,
    // A confirmation code and a last name get into most of these without an account at all, which
    // is the whole reason a check-in needs no password. An account is the fallback, not the route.
    needs_signin: "sometimes",
    signed_in: {
      url: a.account_url,
      when_in: [],
      when_out: a.signed_out_says ?? ["sign in", "log in"],
      when_out_url: a.signed_out_url ?? "",
    },
    commit_labels: a.commit_labels ?? [],
    limits: a.limits ?? [],
    // So anything reading an entry can tell these apart from the errand sites and the cancel routes
    // without guessing from the name.
    from_airlines: true,
  };
}

/** What the model is told about one airline. The internals of the source record stay here. */
export function playbook(name) {
  return playbookFrom(airline(name));
}

function playbookFrom(a) {
  if (!a) return null;
  return {
    airline: a.airline,
    label: a.label,
    route: a.route,
    check_in_opens: `${a.checkin_opens_hours}h before departure, in the FLIGHT's own time zone`,
    ...(a.route === "web"
      ? {
        check_in_page: a.checkin_url,
        check_in_page_address_verified: !!a.url_verified,
        finds_trip_by: a.finds_trip_by === "code_and_name"
          ? "a confirmation code and a last name — no account and no password needed"
          : "a signed-in account",
      }
      : {}),
    steps: a.steps ?? [],
    the_button_that_commits: a.commits,
    what_a_checked_in_page_says: a.checked_in_words ?? [],
    ...(a.refuses_this_browser ? { refuses_this_browser: a.refuses_this_browser } : {}),
    limits: a.limits ?? [],
    read_from: a.source?.how === "not_read"
      ? "NOBODY READ THIS AIRLINE'S OWN PAGE. Everything here — the address, the button label, the window — is"
        + " general knowledge written down, not something checked. Read the page you land on and go by what it"
        + " actually says; if it does not look like this, say so rather than pressing on."
      : `${a.source.url} on ${a.source.read_on}`,
  };
}

/**
 * The honest answer for a check-in Reason cannot do, per kind.
 *
 * Returned by the tool rather than left for the model to improvise, because every one of these is a
 * place where the temptation is to offer a workaround and there is not one. Each carries the line to
 * say, why, and what would change it — and none of them promises anything before then.
 *
 * `costs_money` is the hard scope limit of the whole feature: Reason never buys a seat, a bag or an
 * upgrade, so an airline that wants paying to carry on is a stop and not a decision.
 */
export function cannotDo(kind, label, { detail = "" } = {}) {
  const who = label || "that airline";
  switch (kind) {
    case "app":
      return {
        kind: "app",
        say: `${who} only does check-in in their own app, and I can't tap your phone. It's three taps — want me to walk you through it?`,
        why: "The airline has no web check-in Reason can drive.",
        when: "There is no build that changes this. Say the steps and stop.",
      };
    case "desk":
      return {
        kind: "desk",
        say: `${who} wants this one done at the airport desk — nothing online will do it. Give yourself the extra half hour.`,
        why: "The fare or the route is one the airline does not allow online check-in for.",
        when: "Nothing changes this. Say it plainly and stop.",
      };
    case "fare_class":
      return {
        kind: "fare_class",
        say: `the page says this fare can't check in online${detail ? ` — ${detail}` : ""}. That's the airline's rule, not mine. You'll have to do it at the airport.`,
        why: "The airline's own page refused self check-in for this ticket.",
        when: "Nothing changes this. Report what the page said, word for word, and stop.",
      };
    case "costs_money":
      return {
        kind: "costs_money",
        say: `it wants paying to go further${detail ? ` (${detail})` : ""} and I don't spend your money without you. The form's filled in and it's one tap from here — want to take it?`,
        why: "A bag fee, a seat fee or an upsell wall. Reason never spends money on a check-in, by design.",
        when: "Nothing changes this and nothing should. Hand back the page and the one tap.",
      };
    case "two_passengers":
      return {
        kind: "two_passengers",
        say: `there are two of you on this booking${detail ? ` (${detail})` : ""} — want me to check you both in, or just you?`,
        why: "Checking somebody else in is a decision about somebody else, and it is not Reason's to take quietly.",
        when: "One answer from them and it carries on.",
      };
    case "site_changed":
      return {
        kind: "site_changed",
        say: `${who}'s check-in page isn't where I expected it${detail ? ` — ${detail}` : ""}, so I stopped rather than clicking around your booking.`,
        why: "The page did not look like what is written down for this airline, and none of this file has been checked against a real airline page.",
        when: "Somebody has to read the airline's own page and correct src/airlines.js.",
      };
    default:
      return {
        kind: "unknown",
        say: `I don't have ${who}'s check-in page written down, so I'd be guessing at a URL on your booking. Send me the check-in link and I'll take it from there?`,
        why: "No route is recorded for this airline, and a guess at one is worse than not knowing.",
        when: "Adding the airline to src/airlines.js, or being handed the real link.",
      };
  }
}

/**
 * The same lookups over this registry plus some extra entries.
 *
 * Here for the same reason `cancelRoutes.withExtra` is: an offline test has to be able to stand an
 * airline up on 127.0.0.1 and have the real rail run against it. Nothing about checking in can be
 * proven against Delta — nothing in Reason has ever checked anybody in anywhere — so the only
 * honest way to test the web rail end to end is a fixture shaped like these pages, with its own
 * entry resolved exactly as a real one is.
 *
 * Production passes nothing and never calls this: the tools reach for `ctx.airlines` and fall back
 * to this module, so a real conversation can only ever see the entries above.
 */
export function withExtra(extra = []) {
  const map = new Map([...BY_AIRLINE, ...extra.map(e => [e.airline, e])]);
  const all = [...map.values()];
  const self = {
    AIRLINES: all,
    DEFAULT_WINDOW_HOURS,
    ROUTE_KINDS,
    airlineNames: () => all.map(a => a.airline),
    airline: (name) => map.get(String(name ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")) ?? null,
    match: (name) => {
      const raw = String(name ?? "").trim();
      if (!raw) return null;
      const hay = raw.toLowerCase();
      let best = null;
      for (const a of all) {
        for (const n of a.names) {
          const hit = n.length <= 2
            ? new RegExp(`^${n}\\s*\\d*$`, "i").test(raw)
            : hay.includes(n);
          if (!hit) continue;
          if (!best || n.length > best.len) best = { entry: a, len: n.length };
        }
      }
      return best?.entry ?? null;
    },
    signinEntry: (name) => signinEntryFrom(self.airline(name)),
    playbook: (name) => playbookFrom(self.airline(name)),
    cannotDo,
    commitPattern,
    commitWords,
  };
  return self;
}
