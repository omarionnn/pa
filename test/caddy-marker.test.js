// Caddy's X-Files-Domain marker is not proof on its own (security lead after #377). The Tailscale
// Funnel lands on the same port as Caddy, from the same loopback address, and passes a browser's
// headers straight through. So a browser on the Funnel can write `X-Files-Domain: true` and any
// `X-Forwarded-For` it likes, and before this every guess, every code request, was counted under
// the address it chose: a fresh count per request, or somebody else's count filled on purpose.
// Now the marker counts only with the secret Caddy itself sets (REASON_CADDY_SECRET, header
// `X-Reason-Caddy`), the same way the website's requests count only when Netlify signed them.
// Everything else unsigned is one shared count: the socket's own address.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-caddy-marker-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_EVENTS = "on";
process.env.REASON_CADDY_SECRET = "caddy-test-secret";

const events = await import("../src/events.js");
const db = await import("../src/db.js");
const { eventPageRequest, eventActor } = await import("../src/pages/event.js");
const { clock, config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const CADDY = "caddy-test-secret";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = true;
  config.caddySecret = CADDY;
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_join_attempts;
    DELETE FROM outbox; DELETE FROM threads; DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
});

const party = () => events.create(OWNER_C, {
  name: "Halloween Party", description: "x", starts_at: "2026-10-31T21:00", location: "12 Elm St",
  password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true,
}).event;
const form = (o) => new URLSearchParams(o).toString();
/** Through the Funnel: loopback socket, and whatever headers the browser chose to write. */
const funnel = (ip) => ({ "x-files-domain": "true", "x-forwarded-for": ip });
/** Through Caddy: the same, plus the secret only Caddy holds. */
const caddy = (ip) => ({ ...funnel(ip), "x-reason-caddy": CADDY });
const ask = (ev, headers) => eventPageRequest({
  publicId: ev.public_id, sub: "signin", method: "POST", query: {}, headers, remoteAddress: "127.0.0.1",
  readBody: async () => form({ number: "+13475550000" }), runtime: { async _tell() { return { ok: true }; } }, log: () => {},
});

test("the marker alone names nobody: a forged one is the shared loopback count, Caddy's own is the visitor", () => {
  assert.equal(eventActor(funnel("203.0.113.7"), "127.0.0.1"), "ip:127.0.0.1");
  assert.equal(eventActor({ ...funnel("203.0.113.7"), "x-reason-caddy": "guess" }, "127.0.0.1"), "ip:127.0.0.1");
  assert.equal(eventActor(caddy("203.0.113.7"), "127.0.0.1"), "ip:203.0.113.7");
  // Caddy's secret from off the machine is still not Caddy.
  assert.equal(eventActor(caddy("203.0.113.7"), "198.51.100.1"), "ip:198.51.100.1");
  // No secret configured: nothing is Caddy, whatever the request carries.
  config.caddySecret = "";
  assert.equal(eventActor(caddy("203.0.113.7"), "127.0.0.1"), "ip:127.0.0.1");
});

test("rotating a forged address on the Funnel does not buy fresh sign-in requests", async () => {
  const ev = party();
  for (let i = 0; i < events.SIGNIN_PER_BROWSER_HOUR; i++) assert.equal((await ask(ev, funnel(`198.18.0.${i}`))).status, 200);
  assert.equal((await ask(ev, funnel("198.18.0.250"))).status, 429, "a new claimed address is the same count");
});

test("a forged address cannot fill a real visitor's count, and Caddy's visitors keep their own", async () => {
  const ev = party();
  for (let i = 0; i < events.SIGNIN_PER_BROWSER_HOUR + 2; i++) await ask(ev, funnel("203.0.113.7"));
  assert.equal((await ask(ev, caddy("203.0.113.7"))).status, 200, "the real 203.0.113.7, through Caddy, is not held");
  assert.equal((await ask(ev, caddy("203.0.113.8"))).status, 200, "nor anybody else through Caddy");
});
