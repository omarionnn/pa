// The directions page's colours, for the map style. The CSS variables for the same two themes live
// in directions.css; test/directions-tokens.test.js holds the two in step so the map and the page
// can never drift apart. Source of truth: the design hand-off's prototype/tokens.json and reason.css.

export const THEMES = Object.freeze({
  paper: Object.freeze({
    bg: "#f2ebe0", paper: "#faf6ee", text: "#2a2520", text2: "#78705f", stamp: "#9c3b2e",
    border: "#d4c9b5",
    mapLand: "#ede5d8", mapRoad: "#faf6ee", mapCasing: "#d4c9b5", mapLabel: "#78705f",
    mapDone: "#78705f", route: "#9c3b2e", dot: "#2a2520", dotRing: "#faf6ee", dest: "#faf6ee",
  }),
  night: Object.freeze({
    bg: "#1c1814", paper: "#27211b", text: "#efe6d6", text2: "#a89d88", stamp: "#d46a5c",
    border: "#3e362c",
    mapLand: "#151210", mapRoad: "#27211b", mapCasing: "#3e362c", mapLabel: "#a89d88",
    mapDone: "#a89d88", route: "#d46a5c", dot: "#efe6d6", dotRing: "#1c1814", dest: "#27211b",
  }),
});

const EMPTY = { type: "FeatureCollection", features: [] };

/**
 * The MapLibre style for a theme. No basemap tiles and no key: the streets come embedded in the
 * payload (roads.major / roads.minor), and the route, the done trail, the destination and the dot
 * are GeoJSON the page sets after load. Every layer colour comes from THEMES.
 */
export function mapStyle(theme) {
  const t = THEMES[theme] ?? THEMES.paper;
  const src = () => ({ type: "geojson", data: EMPTY });
  const classFilter = (c) => ["==", ["get", "c"], c];
  return {
    version: 8,
    name: `reason-directions-${theme}`,
    sources: { roads: src(), done: src(), route: src(), dest: src(), dot: src() },
    layers: [
      { id: "land", type: "background", paint: { "background-color": t.mapLand } },
      { id: "roads-minor-case", type: "line", source: "roads", filter: classFilter("minor"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": t.mapCasing, "line-width": 9 } },
      { id: "roads-minor", type: "line", source: "roads", filter: classFilter("minor"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": t.mapRoad, "line-width": 6.5 } },
      { id: "roads-major-case", type: "line", source: "roads", filter: classFilter("major"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": t.mapCasing, "line-width": 15 } },
      { id: "roads-major", type: "line", source: "roads", filter: classFilter("major"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": t.mapRoad, "line-width": 12 } },
      { id: "done", type: "line", source: "done", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": t.mapDone, "line-width": 4, "line-opacity": 0.45 } },
      { id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": t.route, "line-width": 6 } },
      { id: "dest-ring", type: "circle", source: "dest", paint: { "circle-radius": 6, "circle-color": t.dest, "circle-stroke-color": t.route, "circle-stroke-width": 3 } },
      { id: "dest-dot", type: "circle", source: "dest", paint: { "circle-radius": 2, "circle-color": t.text } },
      { id: "dot-halo", type: "circle", source: "dot", paint: { "circle-radius": 22, "circle-color": t.route, "circle-opacity": 0.12 } },
      { id: "dot", type: "circle", source: "dot", paint: { "circle-radius": 8, "circle-color": t.dot, "circle-stroke-color": t.dotRing, "circle-stroke-width": 3.5 } },
    ],
  };
}
