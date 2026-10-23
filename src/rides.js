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

/**
 * The five boroughs, as a few boxes that stay on the New York side of the Hudson and the Kill van
 * Kull: one box over the whole city took in Newark, Jersey City and Hoboken (caught by
 * test/rides.test.js). Tight at the edges on purpose — a pickup just over a line misses the offer,
 * which costs nothing, while a New Jersey pickup sent a New York car service is a wrong call made.
 */
const AREAS = {
  nyc: {
    label: "New York City",
    boxes: [
      { south: 40.49, north: 40.56, west: -74.26, east: -74.05 }, // Staten Island, south (Tottenville)
      { south: 40.56, north: 40.65, west: -74.20, east: -74.05 }, // Staten Island, north — Carteret NJ is at -74.23
      { south: 40.54, north: 40.75, west: -74.03, east: -73.70 }, // Brooklyn, Queens, Manhattan below 34th
      { south: 40.75, north: 40.80, west: -74.01, east: -73.70 }, // Midtown to the 90s, Queens
      { south: 40.80, north: 40.915, west: -73.96, east: -73.70 }, // Harlem, Washington Heights, the Bronx
    ],
  },
};

/** Which known area a point is in, or null. */
export function areaOf(latitude, longitude) {
  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const [id, a] of Object.entries(AREAS)) {
    if (a.boxes.some(b => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east)) return { id, label: a.label };
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
