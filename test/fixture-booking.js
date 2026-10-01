// A fake reservation site, served from the test. Shaped like a real one — search, results
// with time slots, a details form, a final confirm — so the browser loop is exercised for real
// without any live site ever being touched. `bookings` is the ground truth the tests assert on.
import { createServer } from "node:http";

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;max-width:640px;margin:40px auto">${body}</body></html>`;

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

const PLACES = [
  // 8:00 and 9:00 both exist so "make it 9 instead" has a real slot to move to.
  { id: "carbone", name: "Carbone", area: "Greenwich Village", cuisine: "italian", slots: ["6:45 PM", "8:00 PM", "9:00 PM", "9:30 PM"] },
  { id: "lilia", name: "Lilia", area: "Williamsburg", cuisine: "italian", slots: ["7:15 PM", "8:45 PM"] },
  { id: "kochi", name: "Kochi", area: "Hell's Kitchen", cuisine: "korean", slots: ["6:30 PM", "8:15 PM"] },
];

export async function startBookingSite() {
  const bookings = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const send = (html, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };

    if (url.pathname === "/") {
      return send(page("Tablesmith — find a table", `
        <h1>Tablesmith</h1>
        <p>Find a table in New York.</p>
        <form action="/search" method="get">
          <p><label for="q">Restaurant, cuisine or neighborhood</label><br>
             <input id="q" name="q" type="text" placeholder="e.g. italian" required></p>
          <p><label for="date">Date</label><br>
             <input id="date" name="date" type="text" placeholder="YYYY-MM-DD" required></p>
          <p><label for="party">Party size</label><br>
             <select id="party" name="party">
               <option value="1">1</option><option value="2" selected>2</option>
               <option value="3">3</option><option value="4">4</option><option value="6">6</option>
             </select></p>
          <p><button type="submit">Search</button></p>
        </form>`));
    }

    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const date = url.searchParams.get("date") ?? "";
      const party = url.searchParams.get("party") ?? "2";
      const hits = PLACES.filter(p => !q || p.name.toLowerCase().includes(q) || p.cuisine.includes(q) || p.area.toLowerCase().includes(q));
      if (!hits.length) return send(page("No tables", `<h1>No tables</h1><p>Nothing matches “${esc(q)}”.</p><p><a href="/">Search again</a></p>`));
      return send(page(`Tables for ${esc(party)} on ${esc(date)}`, `
        <h1>${hits.length} restaurants</h1>
        <p>Party of ${esc(party)} · ${esc(date)}</p>
        ${hits.map(p => `
          <div style="border:1px solid #ccc;padding:12px;margin:12px 0">
            <h2>${p.name}</h2>
            <p>${p.cuisine} · ${p.area}</p>
            <p>${p.slots.map(s => `<a href="/reserve?place=${p.id}&time=${encodeURIComponent(s)}&date=${encodeURIComponent(date)}&party=${encodeURIComponent(party)}" style="margin-right:10px">${s}</a>`).join("")}</p>
          </div>`).join("")}`));
    }

    if (url.pathname === "/reserve") {
      const p = PLACES.find(x => x.id === url.searchParams.get("place"));
      if (!p) return send(page("Not found", "<h1>No such restaurant</h1>"), 404);
      const time = url.searchParams.get("time") ?? "";
      const date = url.searchParams.get("date") ?? "";
      const party = url.searchParams.get("party") ?? "2";
      return send(page(`Reserve ${p.name}`, `
        <h1>${p.name}</h1>
        <p>Party of ${esc(party)} · ${esc(date)} · ${esc(time)}</p>
        <p><strong>$25 per person cancellation hold.</strong> You will not be charged if you show up.</p>
        <form action="/confirm" method="post">
          <input type="hidden" name="place" value="${p.id}">
          <input type="hidden" name="time" value="${esc(time)}">
          <input type="hidden" name="date" value="${esc(date)}">
          <input type="hidden" name="party" value="${esc(party)}">
          <p><label for="name">Name on the reservation</label><br>
             <input id="name" name="name" type="text" required></p>
          <p><label for="phone">Mobile number</label><br>
             <input id="phone" name="phone" type="tel" required></p>
          <p><label for="notes">Anything we should know?</label><br>
             <textarea id="notes" name="notes" rows="3"></textarea></p>
          <p><button type="submit">Confirm reservation</button></p>
        </form>
        <p><a href="/">Start over</a></p>`));
    }

    if (url.pathname === "/confirm" && req.method === "POST") {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        const f = Object.fromEntries(new URLSearchParams(body));
        const p = PLACES.find(x => x.id === f.place);
        if (!p || !f.name || !f.phone) {
          return send(page("Missing details", `<h1>We need a bit more</h1><p>Name and mobile number are required.</p>`), 400);
        }
        const code = `TS-${1000 + bookings.length}`;
        bookings.push({ ...f, place_name: p.name, code, at: Date.now() });
        return send(page("Reservation confirmed", `
          <h1>You're booked</h1>
          <p>Confirmation <strong>${code}</strong></p>
          <p>${p.name} · party of ${esc(f.party)} · ${esc(f.date)} at ${esc(f.time)}</p>
          <p>Under ${esc(f.name)}, ${esc(f.phone)}</p>`));
      });
      return;
    }

    send(page("Not found", "<h1>404</h1>"), 404);
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    bookings,
    close: () => new Promise(r => server.close(r)),
  };
}
