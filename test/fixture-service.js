// A fake subscription service, served from the test, shaped like the real ones.
//
// Nothing about cancelling a subscription can be proved against Netflix. No account here has ever
// been cancelled, nothing in Reason has ever pressed one of those buttons, and trying it to find
// out would be doing the one thing nobody asked for. So the web rail is proved against this, which
// is built from the shapes the real help pages describe (`src/cancel-routes.js`):
//
//   - **A sign-in that really gates the account page.** Signed out, /account bounces to /login and
//     says "Sign in", which is exactly the pair `readSignedInState` reads. That is what makes
//     "Reason stops and says how to sign in" a real condition rather than a staged one.
//   - **A two-step cancellation.** Step one is the retention offer — pause for three months instead
//     — behind a plain "Continue", which is what Google Play's real flow does. Step two is the
//     screen that finally matters: the date access ends, the early-cancellation fee, and a button
//     called "Finish Cancellation", which is Netflix's own label for it.
//   - **A confirmation worth recording.** The last page gives a cancellation number and an end
//     date, which is what `confirmationIn` is looking for — and `quiet()` turns that off, so the
//     test can prove the other half: a press that goes through with no confirmation leaves the
//     subscription at `cancelling` and says so.
//
// `cancellations` is the ground truth. A test asserting "nothing was cancelled" is asserting on
// this array and not on what a tool result claimed.
import { createServer } from "node:http";

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;max-width:640px;margin:40px auto">${body}</body></html>`;

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

export async function startServiceSite({ confirms = true } = {}) {
  const cancellations = [];
  const logins = [];
  const state = { signedIn: false, confirms, plan: { name: "Streamly Premium", price: "$17.99", renews: "November 6, 2026", endsOn: "November 6, 2026", fee: "$5.00" } };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (html, status = 200, headers = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(html);
    };
    const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); };
    const readBody = (then) => {
      let b = "";
      req.on("data", d => { b += d; });
      req.on("end", () => then(b));
    };

    if (url.pathname === "/") {
      return send(page("Streamly", `<h1>Streamly</h1><p>Everything, all the time.</p><p><a href="/account">Your account</a></p>`));
    }

    // The sign-in page. It takes a password because real ones do, and the test never gives it one
    // through Reason: the whole promise is that the person types it themselves. The test signs in
    // by POSTing here directly, which is the stand-in for them doing it in the sign-in window.
    if (url.pathname === "/login" && req.method === "GET") {
      return send(page("Sign in to Streamly", `
        <h1>Sign in</h1>
        <form action="/login" method="post">
          <p><label for="email">Email</label><br><input id="email" name="email" type="email" required></p>
          <p><label for="password">Password</label><br><input id="password" name="password" type="password" required></p>
          <p><button type="submit">Sign in</button></p>
        </form>`));
    }
    if (url.pathname === "/login" && req.method === "POST") {
      return readBody((body) => {
        const form = Object.fromEntries(new URLSearchParams(body));
        logins.push({ email: form.email ?? "" });
        state.signedIn = true;
        redirect("/account");
      });
    }

    if (url.pathname === "/account") {
      // Signed out: the sign-in words AND a bounce, which is the pair the probe reads.
      if (!state.signedIn) return redirect("/login");
      const done = cancellations.length
        ? `<p><strong>Your membership is cancelled.</strong> Access ends on ${esc(state.plan.endsOn)}.</p>`
        : `<p><a href="/cancel">Manage plan</a></p>`;
      return send(page("Your account — Streamly", `
        <h1>Your account</h1>
        <p>${esc(state.plan.name)} — ${esc(state.plan.price)} a month. Renews ${esc(state.plan.renews)}.</p>
        ${done}`));
    }

    // Step one: the retention offer. The button out of here is a plain "Continue", exactly as
    // Google Play's documented flow has it — so an ordinary click walks it and no yes is spent on
    // turning a page.
    if (url.pathname === "/cancel" && req.method === "GET") {
      if (!state.signedIn) return redirect("/login");
      return send(page("Before you go — Streamly", `
        <h1>Before you go</h1>
        <p><strong>Pause for 3 months instead?</strong> Keep your watchlist and pay nothing until February.</p>
        <form action="/cancel/review" method="get">
          <p><button type="submit">Continue</button></p>
        </form>
        <p><a href="/account">Keep my membership</a></p>`));
    }

    // Step two: the screen that actually matters. The end date and the fee are both here and
    // nowhere earlier, which is the point — a yes collected before this page would be a yes to
    // details nobody had seen.
    if (url.pathname === "/cancel/review") {
      if (!state.signedIn) return redirect("/login");
      return send(page("Confirm cancellation — Streamly", `
        <h1>Confirm cancellation</h1>
        <p>${esc(state.plan.name)}, ${esc(state.plan.price)} a month.</p>
        <p>Access ends on <strong>${esc(state.plan.endsOn)}</strong>.</p>
        <p>Early cancellation fee: <strong>${esc(state.plan.fee)}</strong>.</p>
        <form action="/cancel/finish" method="post">
          <p><button type="submit">Finish Cancellation</button></p>
        </form>
        <p><a href="/account">Never mind</a></p>`));
    }

    if (url.pathname === "/cancel/finish" && req.method === "POST") {
      if (!state.signedIn) return redirect("/login");
      const code = `ST-${String(4000 + cancellations.length * 7).padStart(4, "0")}K`;
      cancellations.push({ at: Date.now(), code, ends: state.plan.endsOn });
      return send(state.confirms
        ? page("Cancelled — Streamly", `
          <h1>Your membership has been cancelled</h1>
          <p>Cancellation number: <strong>${esc(code)}</strong></p>
          <p>You can watch until ${esc(state.plan.endsOn)}.</p>`)
        // The other half: a service that takes the press and says nothing useful back. Reason has
        // to leave this at `cancelling`, and the test proves it does.
        : page("Thanks — Streamly", `
          <h1>Thanks</h1>
          <p>We'll be sorry to see you go. Check your email.</p>`));
    }

    return send(page("Not found", "<h1>Not found</h1>"), 404);
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    port,
    cancellations,
    logins,
    /** Sign in the way the person would: on the site's own form, not through Reason. */
    signIn: () => { state.signedIn = true; },
    signOut: () => { state.signedIn = false; },
    /** Take the confirmation off the last page, so the `cancelling` half can be proved. */
    quiet: (off = true) => { state.confirms = !off; },
    reset: () => {
      cancellations.length = 0;
      logins.length = 0;
      state.signedIn = false;
      state.confirms = confirms;
    },
    /**
     * The registry entry for this fixture, in the shape `src/cancel-routes.js` uses, handed to the
     * tools through `ctx.cancelRoutes` (see `withExtra`). Production never sets that, so this entry
     * exists only inside a test.
     */
    entry: () => ({
      service: "streamly",
      label: "Streamly",
      merchant_names: ["streamly"],
      route: "web",
      cancel_url: `${base}/cancel`,
      url_verified: true,
      hosts: [`127.0.0.1:${port}`, "127.0.0.1"],
      signin_url: `${base}/login`,
      account_url: `${base}/account`,
      signed_out_says: ["sign in", "password"],
      signed_out_url: "/login",
      steps: ["Open the account page.", "Manage plan.", "Continue past the pause offer.", "Finish Cancellation."],
      commit_labels: ["finish cancellation"],
      commits: "Finish Cancellation",
      confirmation: "A cancellation number on the page, and the date access ends.",
      notice: "",
      // Deliberately empty, and the fixture's last page shows a fee anyway. That is the realistic
      // and more interesting case: a service whose help page says nothing about a charge for
      // leaving, which is why the final screen has to be read and said back rather than trusted to
      // the registry. It also keeps the fee guard in src/tools.js testable where it belongs — on a
      // registry entry that really does document one (Adobe).
      fees: "",
      limits: ["A fixture. It proves the rail and says nothing about any real service."],
      source: { url: "test/fixture-service.js", read_on: "2026-10-06", how: "read" },
    }),
    close: () => new Promise(r => server.close(r)),
  };
}
