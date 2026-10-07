// A fake airline, served from the test, shaped like the real ones.
//
// **No real airline has ever been checked in to through Reason, and nothing here goes near one.**
// Trying it to find out would mean putting somebody's actual booking at risk to prove a code path,
// which is the one thing nobody asked for. So the web rail is proved against this, which is built
// from the shapes an airline check-in really has (`src/airlines.js`):
//
//   - **A trip looked up with a confirmation code and a last name**, no account and no password.
//     That is the route almost every airline offers and the reason a check-in needs no sign-in — and
//     the fixture also has a real sign-in that gates the account page, so the OTHER branch (no code,
//     not signed in) is a real condition rather than a staged one.
//   - **A seat already on the booking.** 14C, which is an aisle. So "yes pls, aisle if u can" has
//     something true to be answered with, and "done. you kept 14C." is a sentence about what the
//     page said rather than a sentence about nothing.
//   - **A two-step check-in.** Step one is the trip, behind a plain "Continue" — which commits
//     nothing, so an ordinary click walks it and no yes is spent turning a page. Step two is the
//     screen that matters, with the passenger, the seat and a button called "Check in".
//   - **A confirmation worth reading.** The last page says "You're checked in", repeats the seat and
//     repeats the passenger — the three things `verifyCheckIn` insists on. Each of the knobs below
//     takes one of those away, which is how the hand-back half gets proved.
//
// `checkins` is the ground truth. A test asserting "nobody was checked in" is asserting on this
// array and not on what a tool result claimed.
import { createServer } from "node:http";

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;max-width:640px;margin:40px auto">${body}</body></html>`;

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

export async function startAirlineSite({
  code = "ABC123",
  lastName = "Nyarko",
  passenger = "NYARKO/OMARI",
  seat = "14C",
} = {}) {
  const checkins = [];
  const logins = [];
  const lookups = [];
  const state = {
    signedIn: false,
    code, lastName, passenger, seat,
    flight: { number: "DL 1234", from: "JFK", to: "ATL", departs: "7:15 AM" },
    // The knobs. Each one removes exactly one thing the verification depends on, or adds exactly one
    // wall, so every honest path in src/tools.js has a real condition behind it in a test.
    confirms: true,          // the last page says "You're checked in"
    showsSeat: true,         // ...and repeats the seat
    showsName: true,         // ...and repeats the passenger
    wantsMoney: false,       // a card field on the step-two screen
    refusesFare: false,      // the airline's own "cannot check in online"
    secondPassenger: "",     // another traveller on the record
    refuseEverything: false, // the site turns this browser away, like delta.com really does
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (html, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); };
    const readBody = (then) => {
      let b = "";
      req.on("data", d => { b += d; });
      req.on("end", () => then(Object.fromEntries(new URLSearchParams(b))));
    };

    // The whole site refusing an automated browser. Not a 403 page: a destroyed socket, which is
    // what `page.goto` actually throws on and what united.com really does.
    if (state.refuseEverything) { req.destroy(); return; }

    if (url.pathname === "/") {
      return send(page("Fixture Air", `<h1>Fixture Air</h1><p><a href="/checkin">Check in</a></p><p><a href="/account">My trips</a></p>`));
    }

    // The sign-in page. It takes a password because real ones do, and the test never gives it one
    // through Reason: the whole promise is that the person types it themselves.
    if (url.pathname === "/login" && req.method === "GET") {
      return send(page("Sign in to Fixture Air", `
        <h1>Sign in</h1>
        <form action="/login" method="post">
          <p><label for="email">Email</label><br><input id="email" name="email" type="email" required></p>
          <p><label for="password">Password</label><br><input id="password" name="password" type="password" required></p>
          <p><button type="submit">Sign in</button></p>
        </form>`));
    }
    if (url.pathname === "/login" && req.method === "POST") {
      return readBody((form) => {
        logins.push({ email: form.email ?? "" });
        state.signedIn = true;
        redirect("/account");
      });
    }

    if (url.pathname === "/account") {
      // Signed out: the sign-in words AND a bounce, which is the pair `readSignedInState` reads.
      if (!state.signedIn) return redirect("/login");
      return send(page("My trips — Fixture Air", `
        <h1>My trips</h1>
        <p>${esc(state.flight.number)} ${esc(state.flight.from)} to ${esc(state.flight.to)}, ${esc(state.flight.departs)}</p>
        <p><a href="/checkin/review?code=${encodeURIComponent(state.code)}">Check in for this trip</a></p>`));
    }

    // Step zero: look the trip up. A confirmation code and a last name, no account.
    if (url.pathname === "/checkin" && req.method === "GET") {
      return send(page("Check in — Fixture Air", `
        <h1>Check in</h1>
        <p>Enter your confirmation code and last name.</p>
        <form action="/checkin/review" method="get">
          <p><label for="code">Confirmation code</label><br><input id="code" name="code" required></p>
          <p><label for="last">Last name</label><br><input id="last" name="last" required></p>
          <p><button type="submit">Continue</button></p>
        </form>`));
    }

    // Step one: the trip. The button out of here is a plain "Continue", which commits nothing — so an
    // ordinary click walks it and no yes is spent turning a page.
    if (url.pathname === "/checkin/review") {
      const given = String(url.searchParams.get("code") ?? "").trim().toUpperCase();
      const last = String(url.searchParams.get("last") ?? "").trim().toLowerCase();
      lookups.push({ code: given, last });
      if (given !== state.code.toUpperCase() || (last && last !== state.lastName.toLowerCase())) {
        return send(page("Not found — Fixture Air", `
          <h1>We couldn't find that booking</h1>
          <p>Check the confirmation code and the last name and try again.</p>
          <p><a href="/checkin">Back</a></p>`), 200);
      }
      if (state.refusesFare) {
        return send(page("Check in — Fixture Air", `
          <h1>${esc(state.flight.number)}</h1>
          <p>${esc(state.passenger)}</p>
          <p><strong>This fare cannot check in online.</strong> Please see an agent at the airport.</p>
          <p><a href="/checkin">Back to check in</a></p>`));
      }
      const others = state.secondPassenger ? `<p>${esc(state.secondPassenger)}</p>` : "";
      const money = state.wantsMoney
        ? `<h2>Add a checked bag</h2>
           <p>Checked bag: <strong>$35.00</strong>. Payment required to continue.</p>
           <p><label for="card">Card number</label><br><input id="card" name="card" autocomplete="cc-number" required></p>`
        : "";
      return send(page("Your trip — Fixture Air", `
        <h1>Your trip</h1>
        <p>${esc(state.flight.number)} · ${esc(state.flight.from)} to ${esc(state.flight.to)} · ${esc(state.flight.departs)}</p>
        <p>${esc(state.passenger)}</p>
        ${others}
        <p>Seat ${esc(state.seat)}</p>
        ${money}
        <form action="/checkin/finish" method="post">
          <input type="hidden" name="code" value="${esc(state.code)}">
          <p><button type="submit">Check in</button></p>
        </form>
        <p><a href="/">Not now</a></p>`));
    }

    if (url.pathname === "/checkin/finish" && req.method === "POST") {
      return readBody((form) => {
        if (String(form.code ?? "").toUpperCase() !== state.code.toUpperCase()) {
          return send(page("Something went wrong — Fixture Air", `<h1>Something went wrong</h1>`), 200);
        }
        if (state.wantsMoney) {
          // A real airline would not take the press either. Here so a test that somehow got past the
          // code-side guard still cannot produce a check-in out of a payment wall.
          return send(page("Payment required — Fixture Air", `<h1>Payment required</h1><p>Total due $35.00.</p>`), 402);
        }
        checkins.push({ at: Date.now(), code: state.code, seat: state.seat, passenger: state.passenger });
        const lines = [
          state.confirms ? `<h1>You're checked in</h1>` : `<h1>Thanks</h1><p>We'll see you at the airport.</p>`,
          state.showsName ? `<p>${esc(state.passenger)}</p>` : "",
          state.showsSeat ? `<p>Seat ${esc(state.seat)}</p>` : "",
          state.secondPassenger && state.showsName ? `<p>${esc(state.secondPassenger)} — not checked in</p>` : "",
          `<p>${esc(state.flight.number)} · ${esc(state.flight.from)} to ${esc(state.flight.to)} · ${esc(state.flight.departs)}</p>`,
        ].filter(Boolean).join("\n");
        return send(page(state.confirms ? "Checked in — Fixture Air" : "Thanks — Fixture Air", lines));
      });
    }

    return send(page("Not found", "<h1>Not found</h1>"), 404);
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    port,
    checkins,
    logins,
    lookups,
    /** Sign in the way the person would: on the site's own form, not through Reason. */
    signIn: () => { state.signedIn = true; },
    signOut: () => { state.signedIn = false; },
    /** Each of these takes away one thing `verifyCheckIn` insists on, or adds one wall. */
    set: (patch) => Object.assign(state, patch),
    state,
    reset: () => {
      checkins.length = 0;
      logins.length = 0;
      lookups.length = 0;
      Object.assign(state, {
        signedIn: false, confirms: true, showsSeat: true, showsName: true,
        wantsMoney: false, refusesFare: false, secondPassenger: "", refuseEverything: false,
        // `passenger` is reset along with the rest: a test that puts somebody else's name on the
        // booking must not leave it there for the next one, or the happy path starts passing or
        // failing for a reason that is not in the test you are reading.
        seat, passenger,
      });
    },
    /**
     * The registry entry for this fixture, in the shape `src/airlines.js` uses, handed to the tools
     * through `ctx.airlines` (see `withExtra`). Production never sets that, so this entry exists
     * only inside a test.
     */
    entry: () => ({
      airline: "fixture_air",
      label: "Fixture Air",
      names: ["fixture air", "fixtureair"],
      iata: "FX",
      route: "web",
      checkin_url: `${base}/checkin`,
      url_verified: true,
      checkin_opens_hours: 24,
      finds_trip_by: "code_and_name",
      hosts: [`127.0.0.1:${port}`, "127.0.0.1"],
      signin_url: `${base}/login`,
      account_url: `${base}/account`,
      signed_out_says: ["sign in", "password"],
      signed_out_url: "/login",
      steps: ["Open check-in.", "Enter the code and last name.", "Continue.", "Check in."],
      commit_labels: ["check in"],
      commits: "Check in",
      checked_in_words: ["checked in", "you're checked in"],
      limits: ["A fixture. It proves the rail and says nothing about any real airline."],
      source: { url: "test/fixture-airline.js", read_on: "2026-10-07", how: "read" },
    }),
    close: () => new Promise(r => server.close(r)),
  };
}
