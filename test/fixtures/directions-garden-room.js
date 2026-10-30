// The design hand-off's sample trip, as a payload. The prototype draws its map in a local pixel
// grid; here that grid is placed on the ground near Osu, Accra at about 1.9 m a pixel, so the route
// is 910 m as the prototype says. Sample data only: the Garden Room is not a real place.
//
// demo: true unlocks the #escort/<state> preview hashes. Real payloads never carry it.

const ORIGIN_PX = { x: 240, y: 200 };
const ORIGIN_LL = { lat: 5.557, lng: -0.183 };
const M_PER_PX = 1.9;
const DEG_LAT_PER_M = 1 / 110540;
const DEG_LNG_PER_M = 1 / (111320 * Math.cos((ORIGIN_LL.lat * Math.PI) / 180));

/** Prototype pixel → [lng, lat], GeoJSON order. */
export function px([x, y]) {
  const lng = ORIGIN_LL.lng + (x - ORIGIN_PX.x) * M_PER_PX * DEG_LNG_PER_M;
  const lat = ORIGIN_LL.lat - (y - ORIGIN_PX.y) * M_PER_PX * DEG_LAT_PER_M;
  return [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
}

const ROUTE_PX = [[320, 365], [320, 260], [150, 260], [150, 72], [170, 72]];

const ROAD_MINOR_PX = [
  [[-300, 180], [700, 180]], [[-300, 100], [700, 100]], [[60, -300], [60, 700]],
  [[230, 180], [230, 700]], [[150, -300], [150, 700]], [[30, 135], [270, 135]], [[400, -300], [400, 700]],
];
const ROAD_MAJOR_PX = [[[320, -300], [320, 700]], [[-300, 260], [700, 260]]];

/** The sample trip. A fresh object each call, so a test can change it. */
export function gardenRoomPayload() {
  return {
    v: 1,
    id: "garden-room-sample",
    demo: true,
    madeAt: "6:20 PM",
    destination: {
      name: "The Garden Room",
      address: "14 Oxford St, Osu, Accra",
      lat: px([170, 72])[1],
      lng: px([170, 72])[0],
      entry: "Green gate, next to the tailor’s shop.",
    },
    walk: { minutes: 12, meters: 910 },
    drive: { minutes: 20 },
    route: {
      coordinates: ROUTE_PX.map(px),
      distanceM: 910,
      durationS: 720,
    },
    steps: [
      { instr: "Walk up Cantonments Rd", mark: "Past the petrol station on your right.", landmark: "", street: "Cantonments Rd", distanceM: 200, turn: "depart", location: px([320, 365]) },
      { instr: "Turn left on Oxford St", mark: "At the traffic lights.", landmark: "the pharmacy", street: "Oxford St", distanceM: 350, turn: "left", location: px([320, 260]) },
      { instr: "Take the second right", mark: "Just after the pharmacy. The lane has no name.", landmark: "the pharmacy", street: "", distanceM: 120, turn: "right", location: px([150, 260]) },
      { instr: "Roundabout: second exit", mark: "Straight across, toward the park.", landmark: "the park", street: "", distanceM: 180, turn: "roundabout", location: px([150, 135]) },
      { instr: "The Garden Room, on your right", mark: "Green gate, next to the tailor’s shop.", landmark: "", street: "", distanceM: 0, turn: "arrive", location: px([170, 72]) },
    ],
    roads: {
      major: ROAD_MAJOR_PX.map((line) => line.map(px)),
      minor: ROAD_MINOR_PX.map((line) => line.map(px)),
    },
    event: { label: "Garden Room", href: "https://example.com/event", startsAt: "2026-10-29T19:00:00.000Z" },
    nearby: ["Café across the road, 1 min", "Bench in the park, 3 min"],
    rerouteUrl: "/directions/garden-room-sample/reroute",
  };
}
