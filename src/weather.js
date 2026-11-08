// The weather at a point, read from Open-Meteo (free, no key), with the reading's age said.
//
// Call 80 (2026-11-08): "check the weather where I'm at" went to web_search, whose top result was a
// Central Park observation five hours old (52°F); the next search found 59°F. A snippet has no
// coordinates and no clock. This takes the coordinates — a shared pin, or a saved place's — and
// returns the current reading with the time it was taken, plus today's high, low and rain chance.
import { clock } from "./config.js";

export const WEATHER_BASE = process.env.REASON_WEATHER_BASE || "https://api.open-meteo.com";
const TIMEOUT_MS = 6_000;

// WMO weather codes (Open-Meteo's `weather_code`), in plain words.
const CODES = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "heavy freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
  82: "heavy showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with heavy hail",
};
export const describe = (code) => CODES[Number(code)] ?? "unknown";

const round = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : null);
const toC = (f) => (Number.isFinite(f) ? Math.round((f - 32) * 5 / 9) : null);

/** The URL asked for, exported for the tests. Fahrenheit and mph; Celsius is worked out here too. */
export function weatherUrl(lat, lng) {
  const q = new URLSearchParams({
    latitude: String(lat), longitude: String(lng),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
    temperature_unit: "fahrenheit", wind_speed_unit: "mph", timezone: "auto", forecast_days: "1",
  });
  return `${WEATHER_BASE}/v1/forecast?${q}`;
}

/** The weather at lat/lng. Never throws: `{ ok: false, error }` when it cannot be read. */
export async function weatherAt(lat, lng, { fetchImpl = fetch, now = clock.now(), label = "" } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, error: "no usable coordinates" };
  let body;
  try {
    const res = await fetchImpl(weatherUrl(lat, lng), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `the weather service answered ${res.status}` };
    body = await res.json();
  } catch (e) {
    return { ok: false, error: `could not reach the weather service (${(e?.message ?? String(e)).split("\n")[0]})` };
  }
  const c = body?.current ?? {};
  const d = body?.daily ?? {};
  const f = round(c.temperature_2m);
  if (f == null) return { ok: false, error: "the weather service sent no current reading" };
  // `current.time` is local to the point, with its offset beside it: the reading's age in minutes.
  const offset = Number(body.utc_offset_seconds) || 0;
  const at = c.time ? Date.parse(`${c.time}:00Z`) - offset * 1000 : NaN;
  const minutesOld = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : null;
  const high = round(d.temperature_2m_max?.[0]);
  const low = round(d.temperature_2m_min?.[0]);
  const feels = round(c.apparent_temperature);
  return {
    ok: true,
    ...(label ? { place: label } : {}),
    latitude: lat, longitude: lng,
    now: { temp_f: f, temp_c: toC(f), feels_like_f: feels, conditions: describe(c.weather_code), wind_mph: round(c.wind_speed_10m), precipitation_mm: Number(c.precipitation) || 0 },
    today: { high_f: high, high_c: toC(high), low_f: low, low_c: toC(low), conditions: describe(d.weather_code?.[0]), rain_chance_pct: round(d.precipitation_probability_max?.[0]) },
    reading_minutes_old: minutesOld,
    source: "Open-Meteo, by coordinates",
    note: "A live reading for these coordinates. Say it plainly — the temperature, the sky, and today's high or rain only if it matters. Use °F for someone in the US, °C elsewhere.",
  };
}
