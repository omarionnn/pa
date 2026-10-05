// A handful of fake sources, served from the test, shaped like the real ones a "which should I buy"
// question lands on: a maker's own page, two review sites, a forum, a page that 500s, and a host
// whose robots.txt forbids everything (which is Reddit's real policy, verified 2026-10-05).
//
// Nothing live is ever touched. The prices in here are the ground truth the tests assert on: if a
// number reaches an answer that is not in one of these pages, the source log leaked.
import { createServer } from "node:http";

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body>${body}</body></html>`;

/**
 * Each path is one source. `robots` is served verbatim at /robots.txt so the robots guard is
 * exercised against a real file rather than a stub.
 */
export const PAGES = {
  "/maker": {
    title: "Pixel 11 — the official page",
    html: page("Pixel 11 — the official page", `
      <h1>Pixel 11</h1>
      <p>From <strong>$899</strong>. 6.3-inch display, 48MP main camera, 4700mAh battery.</p>
      <p>Available now.</p>`),
  },
  "/review-a": {
    title: "Pixel 11 review — Tested Weekly",
    html: page("Pixel 11 review — Tested Weekly", `
      <h1>Pixel 11 review</h1>
      <p>We measured <strong>9 hours 40 minutes</strong> of screen time in our battery rundown.</p>
      <p>The camera is the best in its class. The charging speed is the weak point at 27W.</p>
      <p>Verdict: buy it if you take photos; skip it if you need fast charging.</p>`),
  },
  "/review-b": {
    title: "Pixel 11 vs Pixel 10 — Gear Bench",
    html: page("Pixel 11 vs Pixel 10 — Gear Bench", `
      <h1>Pixel 11 vs Pixel 10</h1>
      <p>The Pixel 10 is now <strong>$649</strong> and keeps 90% of the camera quality.</p>
      <p>Unless you want the brighter screen, the older one is the better buy.</p>`),
  },
  "/forum": {
    title: "Anyone regret upgrading? — Gadget Forum",
    html: page("Anyone regret upgrading? — Gadget Forum", `
      <h1>Anyone regret upgrading?</h1>
      <p>Three weeks in and the battery is genuinely better, but the charger situation annoys me.</p>`),
  },
  "/broken": { status: 500, title: "", html: page("Error", "<h1>500</h1>") },
};

export async function startSourceSite({ robots = "User-agent: *\nDisallow: /nothing-here\n" } = {}) {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    hits.push(url.pathname);

    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(robots);
    }
    const p = PAGES[url.pathname];
    if (!p) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      return res.end(page("Not found", "<h1>404</h1>"));
    }
    res.writeHead(p.status ?? 200, { "content-type": "text/html; charset=utf-8" });
    res.end(p.html);
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    // The same server under a second hostname. Research counts SITES, not pages, because four pages
    // off one blog is one opinion — so proving "it read several sites" needs more than one host
    // name, and `localhost` reaches a 127.0.0.1-bound server without binding anything wider.
    altUrl: `http://localhost:${port}`,
    port,
    hits,
    close: () => new Promise(r => server.close(r)),
  };
}
