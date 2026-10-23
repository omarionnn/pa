// Car services Reason may offer to ring for a pickup, alongside the Uber link.
//
// Only entries whose number was read off the company's own website, with the date it was read. A
// number that is not in here is never offered: a guessed dispatch line rung on somebody's behalf
// is a stranger's phone. Yellow cabs in New York are hailed in the street and have no dispatch
// line, so what is here is car services (livery), and Reason says "car service", not "taxi".
//
// To add a city: read the number on the company's own site, add the entry with `verified`, and a
// box that covers where they actually pick up.

export const CAR_SERVICES = [
  {
    name: "Dial 7",
    phone: "+12127777777",
    say: "212 777 7777",
    area: "nyc",
    hours: "24/7",
    verified: "dial7.com, read 2026-10-23: 'book … 24/7 by phone … 212-777-7777'; serves Manhattan, Brooklyn, Queens, the Bronx",
  },
  {
    name: "Carmel Car & Limo",
    phone: "+12126666666",
    say: "212 666 6666",
    area: "nyc",
    hours: "24/7",
    verified: "carmellimo.com, read 2026-10-23: 212-666-6666 on its own home page",
  },
];

/** The five boroughs, as a box. Generous on purpose: a pickup a block over the line still gets the offer. */
const AREAS = {
  nyc: { label: "New York City", south: 40.49, north: 40.92, west: -74.27, east: -73.68 },
};

/** Which known area a point is in, or null. */
export function areaOf(latitude, longitude) {
  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const [id, b] of Object.entries(AREAS)) {
    if (lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east) return { id, label: b.label };
  }
  return null;
}

/** The car services Reason may offer for a pickup at this point. Empty when it knows none there. */
export function carServicesAt(latitude, longitude) {
  const area = areaOf(latitude, longitude);
  if (!area) return [];
  return CAR_SERVICES.filter(s => s.area === area.id).map(({ name, phone, say, hours }) => ({ name, phone, say, hours, area: area.label }));
}

/** Is this one of the verified dispatch numbers? */
export const isKnownCarService = (e164) => CAR_SERVICES.some(s => s.phone === String(e164 ?? "").replace(/[^\d+]/g, ""));
