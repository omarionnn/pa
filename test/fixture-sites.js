// Local pages shaped like the real sites, so the gate can be exercised against their own wording.
//
// The point is narrow and specific. `test/fixture-booking.js` already proves the gate holds on a
// page whose button says "Confirm reservation" — a word the generic guard was written for. These
// pages say what the real sites say instead:
//
//     OpenTable   Complete reservation
//     Uber        Request ride
//     DoorDash    Place your order        ← `place (the )?order` does not match "place YOUR order"
//     Amazon      Place your order
//     Ticketmaster Buy tickets
//     Fandango    Place Order
//     Delta       Complete Purchase
//
// Two of those would have gone straight through the old guard, which is why these exist. Every
// page also carries a **total**, because the other half of the law is that a yes has to name the
// money, and a total that moves between the ask and the click has to void the yes.
//
// Nothing here touches a real site. `orders` is the ground truth the tests assert on.
import { createServer } from "node:http";

/** What each real site calls the button that commits. Mirrors `commit_labels` in src/sites.js. */
export const COMMIT_LABELS = {
  opentable: "Complete reservation",
  uber: "Request ride",
  doordash: "Place your order",
  uber_eats: "Place order",
  amazon: "Place your order",
  delta: "Complete Purchase",
  united: "Complete Purchase",
  ticketmaster: "Buy tickets",
  fandango: "Place Order",
};

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;max-width:640px;margin:40px auto">${body}</body></html>`;

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

export async function startSiteFixtures() {
  const orders = [];
  // The total the checkout page shows. A test moves this between the ask and the click to prove a
  // yes does not survive the price changing underneath it.
  const totals = {};

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (html, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    const parts = url.pathname.split("/").filter(Boolean);
    const site = parts[0];
    const label = COMMIT_LABELS[site];

    if (!label) return send(page("Not found", "<h1>404</h1>"), 404);

    // Browsing. Links and a search box: nothing here commits anything, and the test proves the
    // gate lets all of it through without spending a yes.
    if (parts.length === 1) {
      return send(page(`${site} — browse`, `
        <h1>${esc(site)}</h1>
        <form action="/${esc(site)}/results" method="get">
          <p><label for="q">What are you after?</label><br>
             <input id="q" name="q" type="text" required></p>
          <p><button type="submit">Search</button></p>
        </form>`));
    }

    if (parts[1] === "results") {
      const q = url.searchParams.get("q") ?? "";
      return send(page(`${site} — results`, `
        <h1>3 results for ${esc(q)}</h1>
        <p><a href="/${esc(site)}/checkout?pick=first">The first one</a></p>
        <p><a href="/${esc(site)}/checkout?pick=second">The second one</a></p>
        <p><a href="/${esc(site)}/checkout?pick=third">The third one</a></p>`));
    }

    if (parts[1] === "checkout") {
      const pick = url.searchParams.get("pick") ?? "first";
      const total = totals[site] ?? 58.4;
      return send(page(`${site} — checkout`, `
        <h1>Nearly there</h1>
        <p>You picked: ${esc(pick)}</p>
        <p>Subtotal $49.00 · fees and tax $9.40</p>
        <p><strong>Total $${total.toFixed(2)}</strong></p>
        <form action="/${esc(site)}/done" method="post">
          <input type="hidden" name="pick" value="${esc(pick)}">
          <input type="hidden" name="total" value="${total.toFixed(2)}">
          <p><label for="name">Name</label><br>
             <input id="name" name="name" type="text" required></p>
          <p><label for="phone">Mobile</label><br>
             <input id="phone" name="phone" type="tel" required></p>
          <p><button type="button">Add a note</button></p>
          <p><button type="submit">${esc(label)}</button></p>
        </form>
        <p><a href="/${esc(site)}">Start over</a></p>`));
    }

    if (parts[1] === "done" && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        const f = Object.fromEntries(new URLSearchParams(body));
        if (!f.name || !f.phone) return send(page("Missing details", "<h1>We need a bit more</h1>"), 400);
        const code = `${site.toUpperCase().slice(0, 2)}-${1000 + orders.length}`;
        orders.push({ site, ...f, code });
        return send(page("Done", `
          <h1>All set</h1>
          <p>Reference <strong>${code}</strong></p>
          <p>${esc(site)} · ${esc(f.pick)} · $${esc(f.total)} · under ${esc(f.name)}</p>`));
      });
      return;
    }

    send(page("Not found", "<h1>404</h1>"), 404);
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    orders,
    /** Move the price on a checkout page, the way a real site does while you are reading it. */
    setTotal(site, amount) { totals[site] = amount; },
    close: () => new Promise(r => server.close(r)),
  };
}
