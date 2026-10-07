// Checked in before you remember.
//
// The use case, in Omari's own words on Reason's site: *"It watches the airline, not your inbox, and
// asks before it touches anything."* Four messages long —
//
//     Reason: "check-in for your 7:15am to atlanta just opened. want me to do it?"
//     Omari:  "yes pls, aisle if u can"
//     Reason: "done. you kept 14C."
//     Reason: [link] Boarding pass · ATL 7:15 AM
//
// — and every one of those four is a different piece of machinery that already existed:
//
//   1. **Knowing about the flight.** A row in the `flights` table, with the departure time kept as
//      the FLIGHT's wall clock plus the zone it is in, stamped at save time. What put it there is
//      always the model reading something — what the person said, a confirmation email, a calendar
//      event — because the house rule is that AI reads meaning and never a regex. Anything it worked
//      out rather than was told is marked as a guess and never stated back as fact.
//   2. **Knowing when check-in opens.** `src/airlines.js` per airline, 24 hours by default, and
//      computed in the flight's own zone — not the server's. A flight out of Accra at 07:15 opens at
//      07:15 Accra time whatever clock this machine is on.
//   3. **The offer.** Through `src/notice.js`, which already owns every question worth asking about
//      an unprompted text: is it their waking window, is the day's budget spent, has this exact
//      thing been raised before. A bare timer would have none of that.
//   4. **The check-in itself**, behind the confirm gate, driven in the real browser on the airline's
//      own page — and claimed only when the page says so. "done" is read off the screen: the page
//      shows a checked-in state, the seat is a seat, and the name on it is the right passenger. Any
//      one of those missing and it is a hand-back (`src/furthest.js`), never a "done".
//
// **Nothing in here spends money. Ever.** No seat upgrade, no bag, no fare change. An airline that
// wants paying to carry on is where Reason stops and hands the page back with the one tap on it.
// That is a scope limit and not a missing feature: a check-in that can buy things is a different and
// much more frightening product.
//
// Nothing in this file reads anybody's words to decide what they meant. It reads rows, it reads a
// DOM snapshot's own text and values, and it does arithmetic on clocks. Deciding that "i'm flying to
// atlanta friday 7:15am on delta, conf ABC123" is a Delta flight on a date is the model's, and the
// tools in src/tools.js are where it says so.
import { rfc3339 } from "./google.js";
import { airline as airlineEntry, DEFAULT_WINDOW_HOURS } from "./airlines.js";
import { clock, stamp } from "./config.js";

const HOUR = 60 * 60 * 1000;

/** Where a flight has got to. `needs_them` is the honest-path state: it stopped and handed back. */
export const FLIGHT_STATUSES = ["booked", "offered", "checking_in", "checked_in", "needs_them", "missed", "cancelled"];

/** The states that still want something to happen, which is what "what's still open" is about. */
export const OPEN_STATUSES = new Set(["booked", "offered", "checking_in", "needs_them"]);

// ---------- clocks ----------

/** Is this a zone Intl knows? A bad one has to be refused rather than silently read as UTC. */
export function knownZone(timeZone) {
  const z = String(timeZone ?? "").trim();
  if (!z) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real instant a flight leaves, from its own wall clock and its own zone.
 *
 * This is the whole of requirement 2 and it is why the zone is stamped on the row at save time. A
 * 07:15 departure is 07:15 where the airport is; working it out against the server's clock is how a
 * check-in offer arrives five hours late for somebody flying out of London. `rfc3339` (src/google.js)
 * already does the two-pass offset lookup that gets this right either side of a daylight change, so
 * it is borrowed rather than written again.
 *
 * Returns `{ ok: true, at }` or `{ ok: false, error }`. A wall-clock time that already carries an
 * offset is taken as it is — somebody who said "+05:30" has answered the question.
 */
export function departureInstant(departsLocal, timeZone) {
  const wall = String(departsLocal ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(wall)) {
    return { ok: false, error: `'${wall}' is not a departure time. It wants the flight's own wall clock, as 2026-10-09T07:15:00 — no zone on the end, because the zone is its own field.` };
  }
  const carriesOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(wall);
  if (!carriesOffset && !knownZone(timeZone)) {
    return { ok: false, error: `'${timeZone}' is not a time zone Reason knows. It wants an IANA name like America/New_York or Europe/London — the zone the AIRPORT is in, which is what decides when check-in opens.` };
  }
  const at = Date.parse(carriesOffset ? wall : rfc3339(wall, timeZone));
  if (!Number.isFinite(at)) return { ok: false, error: `'${wall}' in '${timeZone}' did not come out as a real moment.` };
  return { ok: true, at };
}

/** When check-in opens: the airline's own window before departure, or 24 hours. */
export function windowHoursFor(airlineKey, { airlines = null } = {}) {
  const entry = airlines ? airlines.airline(airlineKey) : airlineEntry(airlineKey);
  const hours = Number(entry?.checkin_opens_hours);
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_WINDOW_HOURS;
}

/** The instant check-in opens, as arithmetic on the departure instant. */
export function opensAt(departsAt, windowHours = DEFAULT_WINDOW_HOURS) {
  return Number(departsAt) - Number(windowHours) * HOUR;
}

/**
 * Where this flight stands against the clock, as a decision with the times in it.
 *
 * `open` is the only state a check-in may run in. `too_early` says when it will open, in the
 * person's words, because "not yet" on its own is a useless answer.
 */
export function checkInWindow(row, now = clock.now()) {
  const departsAt = Number(row?.departs_at);
  const opens = Number(row?.checkin_opens_at ?? opensAt(departsAt, windowHoursFor(row?.airline_key)));
  if (!Number.isFinite(departsAt)) return { state: "no_time", opens_at: null, departs_at: null };
  if (now >= departsAt) return { state: "departed", opens_at: opens, departs_at: departsAt };
  if (now < opens) return { state: "too_early", opens_at: opens, departs_at: departsAt, opens_in_hours: Math.max(1, Math.round((opens - now) / HOUR)) };
  return { state: "open", opens_at: opens, departs_at: departsAt, hours_to_departure: Math.max(0, Math.round((departsAt - now) / HOUR)) };
}

// ---------- how a flight is said out loud ----------

/**
 * The departure time the way somebody says it: "7:15am".
 *
 * Read off the stored wall clock rather than formatted out of the instant, because the stored wall
 * clock IS the local time and running it back through a formatter in some other zone is exactly the
 * bug this feature is about.
 */
export function saidTime(departsLocal) {
  const m = /T(\d{2}):(\d{2})/.exec(String(departsLocal ?? ""));
  if (!m) return "";
  const h24 = Number(m[1]);
  const mins = m[2];
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mins}${h24 < 12 ? "am" : "pm"}`;
}

/** The day, from the stored wall clock, in the flight's own zone. */
export function saidDay(departsLocal, timeZone) {
  const d = Date.parse(`${String(departsLocal ?? "").slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(d)) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: knownZone(timeZone) ? timeZone : "UTC", weekday: "long" }).format(new Date(d));
  } catch {
    return "";
  }
}

/**
 * The flight in the words the offer needs: "your 7:15am to atlanta".
 *
 * Built by code off the row, so the line the person reads carries the real time and the real place
 * rather than whatever the model remembered. The model still writes the sentence — this is the
 * material it is handed, and the test asserts the real flight is in what went out.
 */
export function inWords(row) {
  const time = saidTime(row?.departs_local);
  const to = String(row?.destination_name || row?.destination || "").trim();
  const bits = [time && `${time}`, to && `to ${to.toLowerCase()}`].filter(Boolean);
  return bits.join(" ") || String(row?.airline || "that flight");
}

/** The same, with the airline and the number on it, for anything that wants to be exact. */
export function exactly(row) {
  const parts = [
    String(row?.airline || "").trim(),
    String(row?.flight_number || "").trim(),
    inWords(row),
    saidDay(row?.departs_local, row?.time_zone),
  ].filter(Boolean);
  return parts.join(" ");
}

// ---------- the offer ----------

/**
 * Flights whose check-in is open and has not been done, as src/notice.js candidates.
 *
 * Deliberately WITHOUT a `starts` field, and that is the one subtle thing here. `notice.momentFor`
 * parks a candidate that has a start time until two hours before the thing — right for a meeting,
 * badly wrong for a check-in, which is useful the moment it opens and pointless at the gate. These
 * rows only turn up here once check-in is really open, so the moment is now, and leaving `starts`
 * off is what says so.
 *
 * One candidate per flight per day of the window, so a flight nobody answered about is not a fresh
 * nudge every two hours — `notice.send`'s one-nudge-per-`thing` rule does the rest.
 */
export function candidates({ rows = [], now = clock.now() } = {}) {
  const out = [];
  for (const row of rows) {
    if (row.status === "checked_in" || row.status === "cancelled" || row.status === "missed") continue;
    const w = checkInWindow(row, now);
    if (w.state !== "open") continue;
    const day = new Date(now).toISOString().slice(0, 10);
    out.push({
      kind: "flight_checkin",
      key: `flight:${row.id}@${day}`,
      // The THING is the flight, so a second day's candidate is not a second licence to nudge.
      thing: `flight:${row.id}`,
      what: `check-in for their ${inWords(row)}${row.flight_number ? ` (${row.airline} ${row.flight_number})` : ` on ${row.airline}`} is open`
        + ` — it opened ${stamp(w.opens_at)} and the flight leaves in about ${w.hours_to_departure}h`,
      detail: `flight #${row.id}; flight_checkin_start is what does it, and the last press needs their yes.`
        + ` Offer it in one line with the real time and the real place in it — never "a flight"`
        + (row.seat_preference ? `. They said before: ${row.seat_preference}` : ""),
      flight_id: row.id,
      state: String(row.status ?? ""),
    });
  }
  return out;
}

// ---------- what the airline's own page says ----------

const CHECKED_IN_FALLBACK = ["checked in", "you're checked in", "boarding pass", "boarding position"];

/**
 * A seat, as the page wrote it. "14C".
 *
 * The labelled form first — "Seat 14C", "Seat: 14C" — because a bare row/letter pair appears in
 * timetables, gate numbers and fare codes, and picking one of those up would turn into Reason saying
 * "you kept 31B" about a flight number. A bare one is taken only when the page has no labelled seat
 * anywhere, and the caller is told which of the two it was.
 */
export function seatIn(text) {
  const hay = String(text ?? "");
  const labelled = /\bseats?\b[^0-9A-Za-z]{0,12}(\d{1,3}[A-K])\b/i.exec(hay);
  if (labelled) return { seat: labelled[1].toUpperCase(), how: "labelled" };
  const bare = /\b(\d{1,2}[A-K])\b/.exec(hay);
  if (bare) return { seat: bare[1].toUpperCase(), how: "unlabelled" };
  return { seat: "", how: "none" };
}

/** Is a seat an aisle, a window or a middle? Letter only — no row, no aircraft layout, no guessing. */
export function seatKind(seat, { layout = "3-3" } = {}) {
  const letter = String(seat ?? "").trim().toUpperCase().slice(-1);
  if (!/[A-K]/.test(letter)) return "";
  // A 3-3 single-aisle cabin, which is what a domestic narrowbody is. Anything else is not something
  // a seat number alone can tell you, so it comes back empty rather than wrong.
  if (layout !== "3-3") return "";
  if (letter === "A" || letter === "F") return "window";
  if (letter === "C" || letter === "D") return "aisle";
  if (letter === "B" || letter === "E") return "middle";
  return "";
}

/**
 * Whose name is on this page? Mechanical: every word of the passenger's name has to appear.
 *
 * Airlines write a name five different ways — "NYARKO/OMARI", "Omari Nyarko", "O. Nyarko" — so this
 * does not try to parse the format. It asks whether each part of the name on the flight row is
 * somewhere in the page's text, which is enough to catch the failure that matters: a page showing
 * somebody else's booking.
 */
export function nameOnPage(text, passengerName) {
  const hay = String(text ?? "").toLowerCase();
  const parts = String(passengerName ?? "").toLowerCase().split(/[^a-z'-]+/i).filter(w => w.length >= 2);
  if (!parts.length) return { ok: false, why: "there is no passenger name on the flight to check against", missing: [] };
  const missing = parts.filter(p => !hay.includes(p));
  return missing.length
    ? { ok: false, why: `the page does not say ${missing.join(" or ")}`, missing }
    : { ok: true, why: `the page carries ${parts.join(" ")}`, missing: [] };
}

// All-caps pairs that are not somebody's name. A page footer is full of "Terms/Privacy" and
// "AND/OR", and a false "there are two of you on this booking" would stop a check-in that was
// perfectly finishable — so the pair shape alone is not enough and these are named.
const NOT_A_NAME = new Set(["AND", "OR", "TERMS", "PRIVACY", "POLICY", "CONDITIONS", "FAQ", "HELP", "US", "UK", "EN", "CA", "AM", "PM", "TSA", "ID", "YES", "NO"]);

/**
 * More than one traveller on this record?
 *
 * Two ways, both mechanical: the page saying so in a number, and more than one name in the
 * ALL-CAPS "SURNAME/FIRST" shape airlines print passengers in. Narrow on purpose — both sides in
 * capitals, three letters each, and a stoplist — because the cost of a false positive here is
 * stopping a check-in that would have finished, which is a worse outcome than the problem.
 */
export function passengersOn(text) {
  const hay = String(text ?? "");
  const counted = /\b([2-9])\s+(?:passengers|travelers|travellers|guests)\b/i.exec(hay);
  const pairs = [...hay.matchAll(/\b([A-Z][A-Z'-]{2,20})\s*\/\s*([A-Z][A-Z'-]{2,20})\b/g)]
    .filter(m => !NOT_A_NAME.has(m[1]) && !NOT_A_NAME.has(m[2]))
    .map(m => `${m[1]}/${m[2]}`);
  const names = [...new Set(pairs)];
  const n = counted ? Number(counted[1]) : names.length;
  return { count: n, names, said_so: !!counted };
}

/**
 * The names on the page that are NOT the passenger on this flight.
 *
 * The thing that actually matters for "two passengers on one record": not how many name-shaped
 * strings there are, but whether one of them is somebody else. Every part of the flight's own
 * passenger name is checked against each pair, so "NYARKO/OMARI" is theirs and "MENSAH/AKUA" is not.
 */
export function otherPassengers(text, passengerName) {
  const { names, count, said_so } = passengersOn(text);
  const parts = String(passengerName ?? "").toLowerCase().split(/[^a-z'-]+/i).filter(w => w.length >= 2);
  const isTheirs = (n) => parts.length > 0 && parts.every(p => n.toLowerCase().includes(p));
  const mine = names.filter(isTheirs);
  const others = names.filter(n => !isTheirs(n));

  // A page that says the number out loud — "2 passengers on this booking" — has answered the
  // question and is believed on its own. There may be no name-shaped string anywhere on it to tell
  // apart, and a check-in that pressed on because it could not name the second traveller would be
  // the worst reading of the clearest signal there is.
  //
  // Names are the weaker evidence and they get the extra test. "More than one traveller" only means
  // anything if THIS traveller is one of them: a page carrying a single name that is not theirs is
  // not a shared booking, it is the WRONG booking, and the name check in `verifyCheckIn` is what
  // says so. Reading it as a second passenger would send them "want me to check Akua in too?" about
  // a record that was never theirs, which reads as if the check-in half worked. With no name on the
  // flight row nothing can be told apart, so there the old reading stands: every name is somebody
  // else's.
  const theyAreOnIt = mine.length > 0 || (parts.length === 0 && names.length > 0);
  return { others, mine, count, names, said_so, more_than_one: said_so || (theyAreOnIt && others.length > 0) };
}

/** Fee amounts and fee words on the page: something to say FIRST, not on its own a reason to stop. */
export function feesMentioned(text) {
  const hay = String(text ?? "");
  const amounts = [...new Set([...hay.matchAll(/[$£€]\s?\d[\d,]*(?:\.\d{2})?/g)].map(m => m[0].replace(/\s+/g, "")))].slice(0, 8);
  const words = [...new Set([...hay.matchAll(/\b(bag fee|baggage fee|checked bag|carry-?on|seat fee|upgrade|extra legroom)\b/gi)].map(m => m[0].toLowerCase()))].slice(0, 8);
  return { amounts, words };
}

/**
 * Is this page asking to be PAID before it will go further? The hard stop.
 *
 * Deliberately narrow, and the narrowness is the point. A check-in page that merely mentions what a
 * bag costs is an ordinary check-in page; refusing on a dollar sign would make the feature refuse
 * every Spirit and most United flights it could actually have finished. So a wall is one of three
 * concrete things:
 *
 *   - a card field on the page, which only ever means one thing;
 *   - the page's own words saying payment is needed to continue;
 *   - the button about to be pressed being a pay button.
 *
 * Read off the snapshot's own elements and text (src/browser.js), never off anything the model said.
 */
const PAY_TO_CONTINUE = /\b(payment required|pay(?:ment)? to continue|complete (?:your )?payment|total due|amount due|enter (?:your )?card|payment method required)\b/i;
const CARD_FIELD = /\b(card ?number|credit ?card|cvv|cvc|security code|expiry|expiration)\b/i;
const PAY_BUTTON = /\b(pay|purchase|buy|checkout|check ?out|add to (?:cart|order))\b/i;

export function moneyWall({ text = "", elements = [], pressing = "" } = {}) {
  const field = elements.find(el => ["input", "select"].includes(el?.tag)
    && (CARD_FIELD.test(String(el.name ?? "")) || /^(cc-number|cc-csc|cc-exp)$/i.test(String(el.autocomplete ?? ""))));
  if (field) return { wall: true, why: `the page has a card field on it ("${String(field.name ?? "").slice(0, 60)}")` };
  const says = PAY_TO_CONTINUE.exec(String(text ?? ""));
  if (says) return { wall: true, why: `the page says "${says[0]}"` };
  if (pressing && PAY_BUTTON.test(pressing)) return { wall: true, why: `the button is labelled '${pressing}', which takes money` };
  return { wall: false, why: "" };
}

/** Did the airline refuse self check-in for this ticket? Its own words, read by code. */
const FARE_REFUSAL = /\b(cannot check in online|can't check in online|not eligible for online check-?in|check in at the airport|please see an agent|visit the (?:airport|ticket) counter)\b/i;

export function fareRefusal(text) {
  const m = FARE_REFUSAL.exec(String(text ?? ""));
  return m ? { refused: true, said: m[0] } : { refused: false, said: "" };
}

/**
 * Is this person really checked in? The whole of "verify before claiming".
 *
 * Three things have to be true on the page, and each one is reported separately so a half-success is
 * reported as exactly that rather than rounded up to "done":
 *
 *   1. the page shows a checked-in state, in the airline's own words;
 *   2. there is a seat on it, or — on an airline with no assigned seats — a boarding position;
 *   3. the name on it is the passenger on the flight row.
 *
 * `ok` is all three. Anything less and the caller hands back the furthest point instead.
 */
export function verifyCheckIn({ snapshot = {}, flight = {}, entry = null } = {}) {
  const text = `${snapshot.title ?? ""}\n${snapshot.text ?? ""}`;
  const words = (entry?.checked_in_words?.length ? entry.checked_in_words : CHECKED_IN_FALLBACK)
    .map(w => String(w).toLowerCase());
  const hay = text.toLowerCase();
  const saidIt = words.find(w => hay.includes(w)) ?? "";
  const seat = seatIn(text);
  const who = nameOnPage(text, flight.passenger_name);
  const position = /\b([ABC])\s?(\d{1,2})\b/.exec(text);
  const missing = [];
  if (!saidIt) missing.push("the page never says it is checked in");
  if (!seat.seat && !position) missing.push("there is no seat or boarding position on it");
  if (!who.ok) missing.push(who.why);
  return {
    ok: missing.length === 0,
    checked_in_because: saidIt ? `the page says "${saidIt}"` : "",
    seat: seat.seat,
    seat_read: seat.how,
    seat_kind: seatKind(seat.seat),
    boarding_position: position ? `${position[1]}${position[2]}` : "",
    name_ok: who.ok,
    name_why: who.why,
    passengers: otherPassengers(text, flight.passenger_name),
    missing,
  };
}

/**
 * Did they get what they asked for? "aisle if u can" against the seat the airline gave.
 *
 * Only ever a comparison, and it NEVER blocks anything: a middle seat is a real outcome and a
 * check-in that landed one is still a check-in. What this does is make sure the thing they said in
 * the same breath is answered out loud, which is the difference between "done" and "done, and you
 * got the aisle".
 */
export function againstPreference(seat, preference) {
  const want = String(preference ?? "").toLowerCase();
  const kind = seatKind(seat);
  if (!want || !kind) return { say: "", matched: null };
  const asked = /\baisle\b/.test(want) ? "aisle" : /\bwindow\b/.test(want) ? "window" : /\bexit|legroom|front\b/.test(want) ? "other" : "";
  if (!asked || asked === "other") return { say: "", matched: null };
  if (asked === kind) return { matched: true, say: `${seat} is ${kind}, which is what they asked for — say so.` };
  return {
    matched: false,
    say: `They asked for ${asked} and ${seat} is ${kind}. Say that plainly: it is a worse outcome than they wanted`
      + ` and pretending otherwise is the one thing that would make them stop trusting the word "done".`
      + ` Reason does not buy a different seat, so do not offer to move it for money.`,
  };
}

// ---------- the boarding pass ----------

/**
 * The label on the boarding-pass link: "Boarding pass · ATL 7:15 AM".
 *
 * Verbatim from the use-case card, which is the acceptance spec for this feature, so it is built by
 * CODE off the row rather than written by the model: the airport code and the time in a boarding
 * pass's label are the two things nobody wants a model's memory of.
 */
export function boardingPassTitle(row) {
  // The three-letter code when the row has one, and the place's own name when it does not. A flight
  // told to Reason in a sentence — "flying to atlanta friday at 7:15am" — does not always arrive
  // with an IATA code on it, and "Boarding pass · 7:15 AM" is a label that has lost the one thing it
  // was for. Where you are going is not optional; which of its two names it wears is.
  const code = String(row?.destination || "").trim().toUpperCase()
    || String(row?.destination_name || "").trim();
  const t = saidTime(row?.departs_local).replace(/(am|pm)$/, m => ` ${m.toUpperCase()}`);
  return ["Boarding pass", [code, t].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}

/**
 * The boarding pass as page blocks, built by code from the row.
 *
 * Code's rather than the model's for the same reason the title is: every value on it is something an
 * airline's page said, and a model writing the blocks is a model that could round a seat or a time.
 * The caller passes these to `page_create` unchanged.
 */
export function boardingPassBlocks(row, { ownerName = "" } = {}) {
  const seat = String(row?.seat || "").trim();
  const position = String(row?.boarding_position || "").trim();
  const blocks = [
    {
      type: "status",
      state: "done",
      headline: `Checked in${seat ? ` — seat ${seat}` : position ? ` — boarding ${position}` : ""}`,
      detail: `${row?.airline ?? ""}${row?.flight_number ? ` ${row.flight_number}` : ""}`.trim()
        + `, ${saidDay(row?.departs_local, row?.time_zone)} ${saidTime(row?.departs_local)} local.`,
    },
    {
      type: "rows",
      title: "Your flight",
      items: [
        { name: "Passenger", value: String(row?.passenger_name || ownerName || "").trim() || "—" },
        { name: "Flight", detail: String(row?.airline || "").trim(), value: String(row?.flight_number || "—").trim() },
        {
          name: "From",
          detail: String(row?.origin_name || "").trim(),
          value: String(row?.origin || "—").trim().toUpperCase(),
        },
        {
          name: "To",
          detail: String(row?.destination_name || "").trim(),
          value: String(row?.destination || "—").trim().toUpperCase(),
        },
        {
          name: "Departs",
          detail: `${saidDay(row?.departs_local, row?.time_zone)}, local time at the airport (${row?.time_zone ?? ""})`,
          value: saidTime(row?.departs_local) || "—",
        },
        ...(seat ? [{ name: "Seat", detail: seatKind(seat) || "", value: seat }] : []),
        ...(position ? [{ name: "Boarding position", value: position }] : []),
        ...(row?.confirmation_code ? [{ name: "Confirmation", value: String(row.confirmation_code).toUpperCase() }] : []),
      ],
    },
    {
      type: "callout",
      tone: "note",
      title: "What this is",
      text: `Reason checked in on ${String(row?.airline || "the airline")}'s own site and read this straight off the screen.`
        + ` It is not the airline's boarding pass: the scannable one is in your email or the airline's app, and that is the one the gate wants.`,
    },
  ];
  return blocks;
}

// ---------- what is still open ----------

/**
 * The one line a flight mid-check-in adds to an ordinary turn, or "".
 *
 * Here rather than in src/openwork.js's own body so the wording lives with the feature, and read off
 * rows only. A flight that has been handed back (`needs_them`) is the case this exists for: the
 * person is holding a filled-in form and one tap, and the next thing they say is very likely about
 * it.
 */
export function openNote(rows = [], { now = clock.now() } = {}) {
  const open = rows.filter(r => OPEN_STATUSES.has(r.status) && checkInWindow(r, now).state === "open");
  if (!open.length) return "";
  const lines = open.map(r => {
    const w = checkInWindow(r, now);
    return `flight #${r.id}: ${exactly(r)}, check-in open since ${stamp(w.opens_at)}, leaves in about ${w.hours_to_departure}h`
      + `, currently ${r.status}${r.seat_preference ? `, they said "${r.seat_preference}"` : ""}`
      + (r.status === "needs_them" && r.notes ? ` — handed back to them: ${r.notes}` : "");
  });
  return `check-in is open on ${open.length === 1 ? "a flight" : `${open.length} flights`} of theirs: ${lines.join("; ")}.`
    + ` If what they just said is about one of those — "yes", "do it", "aisle if u can", "did you do it" — it is about THAT flight`
    + ` and flight_checkin_start is how it gets done; do not ask them which flight.`;
}

/**
 * The capability line, from whether this person has a flight written down and whether the browser is
 * there at all. Written here so the capability and the tools' own refusals come from one place.
 */
export function statusNow({ rows = [], browserReady = true } = {}) {
  if (!browserReady) {
    return {
      status: "not connected",
      what: "there is no browser on this machine, so nothing can be checked in. Say that rather than offering it",
    };
  }
  const open = rows.filter(r => OPEN_STATUSES.has(r.status));
  return {
    status: "live",
    what: `keep a flight (flight_save), notice when its check-in opens — the airline's window in the FLIGHT's own time zone, usually 24h —`
      + ` offer it in one line, and then check in on the airline's own site with flight_checkin_start and flight_checkin_commit,`
      + ` which needs their yes for the exact details. "done" is only said when the page itself shows checked in, a seat, and their name.`
      + ` It NEVER spends money: no seat upgrade, no bag, no fare change — an airline that wants paying is where it stops and hands the page back.`
      + ` Then boarding_pass makes the page they keep.`
      + ` No real airline has ever been checked in to through this: ${rows.length ? `${rows.length} flight(s) written down, ${open.length} with something still open` : "nothing written down yet"}.`,
  };
}
