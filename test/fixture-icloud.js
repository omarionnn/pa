// A fake iCloud CalDAV server, served from the test.
//
// Every route is one CalDAV really documents (RFC 4791 + WebDAV RFC 4918), with the method, the
// path and the status codes the protocol gives — including the awkward ones:
//
//   - PROPFIND / answers a `current-user-principal` with a numeric dsid path, which is how iCloud
//     tells you where your data lives.
//   - A 401 on a bad password is Basic auth, the only auth CalDAV offers for third parties.
//   - REPORT with `calendar-query` returns only the events inside the time-range filter, which is
//     the server's job and not the client's — so the fixture checks the range and filters.
//   - PUT with `If-None-Match: *` refuses with 412 if the event already exists.
//   - PUT with `If-Match: {etag}` refuses with 412 if the etag changed (optimistic concurrency).
//   - DELETE answers 204 on success, 404 when the event is not there.
//
// `state` is the ground truth: every event stored, every auth header that arrived.
import { createServer } from "node:http";

const DSID = "12345678";
const PRINCIPAL = `/${DSID}/principal/`;
const HOME = `/${DSID}/calendars/`;
const DEFAULT_CAL = `${HOME}home/`;

export async function startICloud({ email = "test@icloud.com", password = "app-specific-pass" } = {}) {
  const state = {
    email,
    password,
    events: [],
    calendars: [{ href: DEFAULT_CAL, name: "Home" }],
    requests: [],
  };

  let etags = 1;

  function auth(req) {
    const hdr = req.headers.authorization ?? "";
    if (!hdr.startsWith("Basic ")) return false;
    const decoded = Buffer.from(hdr.slice(6), "base64").toString("utf8");
    return decoded === `${state.email}:${state.password}`;
  }

  function findEvent(href) {
    return state.events.find(e => e.href === href);
  }

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    state.requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });

    if (!auth(req)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    const method = req.method;
    const url = req.url;

    // PROPFIND — discovery
    if (method === "PROPFIND") {
      if (url === "/") {
        // Step 1: current-user-principal
        res.writeHead(207, { "Content-Type": "application/xml" });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
        return;
      }
      if (url === PRINCIPAL) {
        // Step 2: calendar-home-set
        res.writeHead(207, { "Content-Type": "application/xml" });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>${PRINCIPAL}</d:href>
    <d:propstat>
      <d:prop>
        <c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
        return;
      }
      if (url === HOME) {
        // Step 3: list calendars
        const responses = [
          `<d:response>
  <d:href>${HOME}</d:href>
  <d:propstat>
    <d:prop>
      <d:displayname>Calendars</d:displayname>
      <d:resourcetype><d:collection/></d:resourcetype>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`,
        ];
        for (const cal of state.calendars) {
          responses.push(`<d:response>
  <d:href>${cal.href}</d:href>
  <d:propstat>
    <d:prop>
      <d:displayname>${cal.name}</d:displayname>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <cs:getctag>ctag-1</cs:getctag>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`);
        }
        res.writeHead(207, { "Content-Type": "application/xml" });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
${responses.join("\n")}
</d:multistatus>`);
        return;
      }
    }

    // REPORT — calendar-query (list events)
    if (method === "REPORT" && url.startsWith(HOME)) {
      const calHref = url.endsWith("/") ? url : url + "/";
      const calEvents = state.events.filter(e => e.href.startsWith(calHref));

      // Parse time-range from the request body
      const rangeMatch = body.match(/time-range\s+start="([^"]+)"\s+end="([^"]+)"/);
      let filtered = calEvents;
      if (rangeMatch) {
        const rangeStart = parseUtcStamp(rangeMatch[1]);
        const rangeEnd = parseUtcStamp(rangeMatch[2]);
        filtered = calEvents.filter(e => {
          const eStart = eventStartMs(e);
          const eEnd = eventEndMs(e);
          // Overlap: event end > range start AND event start < range end
          return eEnd > rangeStart && eStart < rangeEnd;
        });
      }

      const responses = filtered.map(e => `<d:response>
  <d:href>${e.href}</d:href>
  <d:propstat>
    <d:prop>
      <d:gettag>"${e.etag}"</d:gettag>
      <c:calendar-data>${e.ical}</c:calendar-data>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`);

      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
${responses.join("\n")}
</d:multistatus>`);
      return;
    }

    // GET — single event
    if (method === "GET" && url.endsWith(".ics")) {
      const event = findEvent(url);
      if (!event) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/calendar", ETag: `"${event.etag}"` });
      res.end(event.ical);
      return;
    }

    // PUT — create or update event
    if (method === "PUT" && url.endsWith(".ics")) {
      const existing = findEvent(url);
      const ifNoneMatch = req.headers["if-none-match"];
      const ifMatch = req.headers["if-match"];

      // Create: If-None-Match: * means "only if it doesn't exist"
      if (ifNoneMatch === "*" && existing) {
        res.writeHead(412, { "Content-Type": "text/plain" });
        res.end("Precondition Failed: event already exists");
        return;
      }

      // Update: If-Match means "only if etag matches"
      if (ifMatch && existing && ifMatch !== `"${existing.etag}"`) {
        res.writeHead(412, { "Content-Type": "text/plain" });
        res.end("Precondition Failed: etag mismatch");
        return;
      }

      const newEtag = `etag-${etags++}`;
      if (existing) {
        existing.ical = body;
        existing.etag = newEtag;
      } else {
        state.events.push({ href: url, ical: body, etag: newEtag });
      }
      res.writeHead(existing ? 204 : 201, { ETag: `"${newEtag}"` });
      res.end();
      return;
    }

    // DELETE — remove event
    if (method === "DELETE" && url.endsWith(".ics")) {
      const idx = state.events.findIndex(e => e.href === url);
      if (idx < 0) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      state.events.splice(idx, 1);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    state,
    reset() {
      state.events = [];
      state.requests = [];
      state.calendars = [{ href: DEFAULT_CAL, name: "Home" }];
      etags = 1;
    },
    seedEvent({ uid, summary, start, end, location, description, calendarHref = DEFAULT_CAL }) {
      const ical = buildFakeIcal({ uid, summary, start, end, location, description });
      const href = `${calendarHref}${uid || `evt-${state.events.length + 1}`}.ics`;
      const etag = `etag-${etags++}`;
      state.events.push({ href, ical, etag });
      return href;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function buildFakeIcal({ uid, summary, start, end, location, description }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    "BEGIN:VEVENT",
    `UID:${uid || `test-${Date.now()}`}`,
    `DTSTAMP:20261009T120000Z`,
    `SUMMARY:${summary || "Test Event"}`,
  ];
  if (start) {
    if (start.dateTime) {
      const val = start.dateTime.replace(/[-:]/g, "").replace(/\.\d+$/, "");
      if (start.timeZone) lines.push(`DTSTART;TZID=${start.timeZone}:${val}`);
      else if (start.dateTime.endsWith("Z")) lines.push(`DTSTART:${val}Z`);
      else lines.push(`DTSTART:${val}`);
    } else if (start.date) {
      lines.push(`DTSTART;VALUE=DATE:${start.date.replace(/-/g, "")}`);
    }
  }
  if (end) {
    if (end.dateTime) {
      const val = end.dateTime.replace(/[-:]/g, "").replace(/\.\d+$/, "");
      if (end.timeZone) lines.push(`DTEND;TZID=${end.timeZone}:${val}`);
      else if (end.dateTime.endsWith("Z")) lines.push(`DTEND:${val}Z`);
      else lines.push(`DTEND:${val}`);
    } else if (end.date) {
      lines.push(`DTEND;VALUE=DATE:${end.date.replace(/-/g, "")}`);
    }
  }
  if (location) lines.push(`LOCATION:${location}`);
  if (description) lines.push(`DESCRIPTION:${description}`);
  lines.push("SEQUENCE:0", "END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function parseUtcStamp(s) {
  // "20261009T190000Z" → ms
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return 0;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
}

function eventStartMs(e) {
  const m = e.ical.match(/DTSTART[^:]*:(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?(Z)?/);
  if (!m) return 0;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}${m[7] || ""}`;
  return new Date(iso).getTime() || 0;
}

function eventEndMs(e) {
  const m = e.ical.match(/DTEND[^:]*:(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?(Z)?/);
  if (!m) return eventStartMs(e) + 3600_000;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}${m[7] || ""}`;
  return new Date(iso).getTime() || 0;
}
