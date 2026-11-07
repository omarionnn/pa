// A URL somebody else chose never reaches this machine's own network (security audit 2026-11-06,
// leads 19 and 22): web_lookup and the watches/research that read through it, offer_check,
// video_understand, browser_open, and the inbound PDF / video / voice memo / contact card downloads.
// Each hop is checked, redirects included; in production the name is resolved and pinned too.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-netguard-"));
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.PARALLEL_API_KEY = "";
process.env.CONTEXTDEV_API_KEY = "";

const { webLookup } = await import("../src/weblookup.js");
const { fetchOfferPage } = await import("../src/offers.js");
const { fetchPdf } = await import("../src/media.js");
const { readContact } = await import("../src/contacts.js");
const { guardedFetch, publicAddresses, publicUrl, pinnedLookup } = await import("../src/netguard.js");
const { config } = await import("../src/config.js");

let inside, port;
before(async () => {
  // Something on this machine that answers anyone: what a link must never reach.
  inside = createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("internal-secret"); });
  await new Promise(r => inside.listen(0, "127.0.0.1", r));
  port = inside.address().port;
  config.lookupProvider = "plain";
});
after(() => { inside.close(); rmSync(dir, { recursive: true, force: true }); });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** The public internet, as far as a test is concerned: one host that redirects inward. Like a real
 * fetch it follows the redirect itself unless asked not to (redirect: "manual"). */
const redirector = (to) => async (url, init = {}) => {
  if (String(url).startsWith("https://public.example/")) {
    if (init.redirect === "manual") return new Response(null, { status: 302, headers: { location: to } });
    return realFetch(to, { signal: init.signal });
  }
  return realFetch(url, init);
};

test("web_lookup will not read this machine's own network, directly or by a redirect", async () => {
  const direct = await webLookup(`http://127.0.0.1:${port}/`, { provider: "plain" });
  assert.equal(direct.ok, false, "a loopback page was read");
  assert.doesNotMatch(JSON.stringify(direct), /internal-secret/);
  for (const u of ["http://localhost:1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]:1/", "http://10.0.0.1/", "http://user:pw@example.com/"]) {
    assert.equal((await webLookup(u, { provider: "plain" })).ok, false, u);
  }
  globalThis.fetch = redirector(`http://127.0.0.1:${port}/`);
  const hop = await webLookup("https://public.example/a", { provider: "plain" });
  assert.equal(hop.ok, false, "a redirect into loopback was followed");
  assert.doesNotMatch(JSON.stringify(hop), /internal-secret/);
});

test("offer_check's page fetch is under the same rule", async () => {
  assert.equal((await fetchOfferPage(`http://127.0.0.1:${port}/`)).ok, false);
  const hop = await fetchOfferPage("https://public.example/p", { fetchImpl: redirector(`http://127.0.0.1:${port}/`) });
  assert.equal(hop.ok, false);
  assert.doesNotMatch(JSON.stringify(hop), /internal-secret/);
});

test("an inbound PDF or contact card that redirects inward is not downloaded", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(String(url));
    if (init.redirect !== "manual" && String(url).startsWith("https://public.example/")) seen.push(`http://127.0.0.1:${port}/x`);
    return redirector(`http://127.0.0.1:${port}/x`)(url, init);
  };
  const pdf = await fetchPdf({ url: "https://public.example/a.pdf", filename: "a.pdf", fetchImpl, read: async () => ({ ok: true, text: "x" }) });
  assert.equal(pdf.ok, false);
  const card = await readContact({ url: "https://public.example/c.vcf", fetchImpl });
  assert.equal(card.ok, false);
  assert.ok(seen.every(u => !u.includes("127.0.0.1")), `an inward hop was fetched: ${seen.join(", ")}`);
});

test("a public name that resolves to a private address is refused, and the connect is pinned to what was checked", async () => {
  const lookup = async (h) => h === "rebind.example" ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "93.184.215.14", family: 4 }];
  assert.equal(await publicAddresses("rebind.example", { lookup }), null);
  assert.deepEqual(await publicAddresses("ok.example", { lookup }), [{ address: "93.184.215.14", family: 4 }]);
  assert.equal(await publicAddresses("mixed.example", { lookup: async () => [{ address: "93.184.215.14", family: 4 }, { address: "127.0.0.1", family: 4 }] }), null);
  const got = await guardedFetch("https://rebind.example/", { fetchImpl: async () => new Response("no"), lookup });
  assert.equal(got.ok, false);
  assert.equal((await publicUrl("https://rebind.example/", { lookup })).ok, false);
  for (const u of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8788/health", "https://[::ffff:127.0.0.1]/", "file:///etc/passwd"]) assert.equal((await publicUrl(u)).ok, false, u);
  // The pinned lookup answers only the checked address, whatever it is asked.
  const pin = pinnedLookup([{ address: "93.184.215.14", family: 4 }]);
  await new Promise((done) => pin("anything.example", {}, (err, addr) => { assert.equal(addr, "93.184.215.14"); done(); }));
});
