// The weather at a point, read from Open-Meteo (free, no key), with the reading's age said.
//
// Call 80 (2026-11-08): "check the weather where I'm at" went to web_search, whose top result was a
// Central Park observation five hours old (52°F); the next search found 59°F. A snippet has no
// coordinates and no clock. This takes the coordinates — a shared pin, or a saved place's — and
// returns the current reading with the time it was taken, plus today's high, low and rain chance.
import { clock } from "./config.js";

export const WEATHER_BASE = process.env.REASON_WEATHER_BASE || "https://api.open-meteo.com";
// The second source, used when Open-Meteo does not answer: MET Norway's free forecast (no key; its
// terms ask for an identifying User-Agent). 2026-11: the server's DNS sent api.open-meteo.com to a
// node that never accepted a connection, so every reading timed out after 6 s, then again on retry.
export const MET_BASE = process.env.REASON_WEATHER_MET_BASE || "https://api.met.no";
const UA = "Reason/1.0 (personal assistant; +https://app.heyreason.com)";
/** Open-Meteo answers in well under a second when it is up; then MET Norway gets the rest. */
export const OPEN_METEO_MS = 3_000;
export const MET_MS = 3_000;
/** Open-Meteo not answering: the next readings go straight to MET Norway for this long. */
const BREAKER_MS = 5 * 60_000;
let openMeteoDownUntil = 0;
/** For the tests. */
export function resetWeatherState() { openMeteoDownUntil = 0; }

// WMO weather codes (Open-Meteo's `weather_code`), in plain words.
const CODES = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "heavy freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
  82: "heavy showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with heavy hail",
};
export const describe = (code) => CODES[Number(code)] ?? "unknown";

const round = (n) => (n != null && n !== "" && Number.isFinite(Number(n)) ? Math.round(Number(n)) : null);
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

/** MET Norway's URL, exported for the tests. Coordinates to four decimals, as its terms ask. */
export function metUrl(lat, lng) {
  return `${MET_BASE}/weatherapi/locationforecast/2.0/compact?lat=${Number(lat).toFixed(4)}&lon=${Number(lng).toFixed(4)}`;
}

const MET_WORDS = {
  clearsky: "clear", fair: "mostly clear", partlycloudy: "partly cloudy", cloudy: "overcast", fog: "foggy",
  lightrain: "light rain", rain: "rain", heavyrain: "heavy rain", lightrainshowers: "light showers", rainshowers: "showers", heavyrainshowers: "heavy showers",
  lightsleet: "light sleet", sleet: "sleet", heavysleet: "heavy sleet", lightsleetshowers: "sleet showers", sleetshowers: "sleet showers", heavysleetshowers: "sleet showers",
  lightsnow: "light snow", snow: "snow", heavysnow: "heavy snow", lightsnowshowers: "snow showers", snowshowers: "snow showers", heavysnowshowers: "heavy snow showers",
};
/** A MET Norway symbol ("lightrainshowers_day", "rainandthunder") in plain words. */
export function metWords(symbol) {
  const s = String(symbol ?? "").replace(/_(day|night|polartwilight)$/, "");
  if (!s) return "unknown";
  if (/thunder/.test(s)) return "thunderstorms";
  return MET_WORDS[s] ?? s;
}

const errWords = (e) => (e?.message ?? String(e)).split("\n")[0];

async function readJson(url, { fetchImpl, timeoutMs, headers }) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers });
  if (!res.ok) { const e = new Error(`answered ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

/** MET Norway's forecast in Open-Meteo's shape (so the rest reads one shape). Fahrenheit and mph. No rain chance: compact has none. */
function metAsOpenMeteo(body, lng) {
  const series = Array.isArray(body?.properties?.timeseries) ? body.properties.timeseries : [];
  const first = series[0];
  const t = first?.data?.instant?.details?.air_temperature;
  if (!first || !Number.isFinite(t)) return null;
  const F = (c) => c * 9 / 5 + 32;
  // The point's day, by its longitude (MET gives no zone): the hours left of it, or the next 12 if none.
  const offsetS = Math.round(Number(lng) / 15) * 3600;
  const dayOf = (iso) => new Date(Date.parse(iso) + offsetS * 1000).toISOString().slice(0, 10);
  const today = dayOf(first.time);
  let hours = series.filter(s => dayOf(s.time) === today);
  if (hours.length < 2) hours = series.slice(0, 12);
  const temps = hours.map(s => s.data?.instant?.details?.air_temperature).filter(Number.isFinite);
  const nextSym = first.data?.next_1_hours?.summary?.symbol_code ?? first.data?.next_6_hours?.summary?.symbol_code;
  const daySym = series.find(s => s.data?.next_12_hours?.summary?.symbol_code)?.data.next_12_hours.summary.symbol_code ?? nextSym;
  return {
    utc_offset_seconds: 0,
    current: {
      time: first.time.slice(0, 16),
      temperature_2m: F(t),
      apparent_temperature: null,
      weather_code: null, _words: metWords(nextSym),
      wind_speed_10m: Number.isFinite(first.data.instant.details.wind_speed) ? first.data.instant.details.wind_speed * 2.23694 : null,
      precipitation: first.data?.next_1_hours?.details?.precipitation_amount ?? 0,
    },
    daily: {
      temperature_2m_max: [temps.length ? F(Math.max(...temps)) : null],
      temperature_2m_min: [temps.length ? F(Math.min(...temps)) : null],
      precipitation_probability_max: [null],
      weather_code: [null], _words: metWords(daySym),
    },
  };
}

/** The weather at lat/lng. Never throws: `{ ok: false, error }` when it cannot be read. */
export async function weatherAt(lat, lng, { fetchImpl = fetch, now = clock.now(), label = "" } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, error: "no usable coordinates" };
  // Open-Meteo first; MET Norway when it gave no answer at all (a timeout, no connection). While
  // Open-Meteo is marked down, MET first and Open-Meteo after it. An answer from Open-Meteo that
  // says no (4xx) or failed (5xx) is returned as before (the retry layer takes a 5xx).
  const openMeteo = async () => {
    try {
      const b = await readJson(weatherUrl(lat, lng), { fetchImpl, timeoutMs: OPEN_METEO_MS });
      openMeteoDownUntil = 0;
      return { body: b, source: "Open-Meteo, by coordinates" };
    } catch (e) {
      if (e?.status) return { final: { ok: false, error: `the weather service answered ${e.status}` } };
      openMeteoDownUntil = clock.now() + BREAKER_MS;
      return { error: `could not reach the weather service (${errWords(e)})` };
    }
  };
  const met = async () => {
    try {
      const b = metAsOpenMeteo(await readJson(metUrl(lat, lng), { fetchImpl, timeoutMs: MET_MS, headers: { "user-agent": UA } }), lng);
      return b ? { body: b, source: "MET Norway, by coordinates" } : { error: "the weather service sent no current reading" };
    } catch (e) {
      return { error: e?.status ? `the weather service answered ${e.status}` : `could not reach the weather service (${errWords(e)})` };
    }
  };
  const order = clock.now() < openMeteoDownUntil ? [met, openMeteo] : [openMeteo, met];
  let body = null;
  let source = null;
  let firstError = null;
  for (const ask of order) {
    const got = await ask();
    if (got.body) { body = got.body; source = got.source; break; }
    if (got.final) return got.final;
    firstError ??= got.error;
  }
  if (!body) return { ok: false, error: firstError };
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
    now: { temp_f: f, temp_c: toC(f), feels_like_f: feels, conditions: c._words ?? describe(c.weather_code), wind_mph: round(c.wind_speed_10m), precipitation_mm: Number(c.precipitation) || 0 },
    today: { high_f: high, high_c: toC(high), low_f: low, low_c: toC(low), conditions: d._words ?? describe(d.weather_code?.[0]), rain_chance_pct: round(d.precipitation_probability_max?.[0]) },
    reading_minutes_old: minutesOld,
    source,
    note: "A live reading for these coordinates. Say it plainly — the temperature, the sky, and today's high or rain only if it matters. Use °F for someone in the US, °C elsewhere.",
  };
}

// ---------- their unit (call 117 and 119, 2026-11-14/15) ----------
// The reading came back in both units with "°F for someone in the US, °C elsewhere", and nothing on a
// call said where they are: a US caller heard "6 degrees". The voice is told not to name the unit, so
// a bare number went out. The tool now decides the unit for the person and hands back only that one.

// Where Fahrenheit is the everyday unit: the US and its territories, and the few others that use it.
const FAHRENHEIT_ZONES = /^(?:America\/(?:New_York|Detroit|Kentucky\/.+|Indiana\/.+|Chicago|Menominee|North_Dakota\/.+|Denver|Boise|Phoenix|Los_Angeles|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak|Puerto_Rico|St_Thomas|Cayman|Nassau|Belize)|Pacific\/(?:Honolulu|Guam|Saipan|Pago_Pago|Palau|Majuro|Kwajalein|Pohnpei|Chuuk|Kosrae)|Africa\/Monrovia|US\/.+)$/;

/** "F" or "C" for a person whose clock is `tz` (an IANA zone). Unknown: Fahrenheit, the install's. */
export function unitForZone(tz) {
  const z = String(tz ?? "").trim();
  if (!z) return "F";
  return FAHRENHEIT_ZONES.test(z) ? "F" : "C";
}

/**
 * A weather result in ONE unit, theirs: the other unit's fields off, `temperature_unit` on, and a note
 * that says the unit by name every time ("43 degrees Fahrenheit" out loud, "43°F" in a text).
 */
export function inTheirUnit(out, unit = "F") {
  if (!out?.ok || !out.now) return out;
  const u = unit === "C" ? "C" : "F";
  const c = (f) => (Number.isFinite(f) ? Math.round((f - 32) * 5 / 9) : null);
  const now = u === "F"
    ? { temp_f: out.now.temp_f, feels_like_f: out.now.feels_like_f, conditions: out.now.conditions, wind_mph: out.now.wind_mph, precipitation_mm: out.now.precipitation_mm }
    : { temp_c: out.now.temp_c ?? c(out.now.temp_f), feels_like_c: c(out.now.feels_like_f), conditions: out.now.conditions, wind_mph: out.now.wind_mph, precipitation_mm: out.now.precipitation_mm };
  const t = out.today ?? {};
  const today = u === "F"
    ? { high_f: t.high_f, low_f: t.low_f, conditions: t.conditions, rain_chance_pct: t.rain_chance_pct }
    : { high_c: t.high_c ?? c(t.high_f), low_c: t.low_c ?? c(t.low_f), conditions: t.conditions, rain_chance_pct: t.rain_chance_pct };
  const name = u === "F" ? "Fahrenheit" : "Celsius";
  const deg = (n) => (Number.isFinite(n) ? `${n}°${u}` : null);
  return {
    ...out,
    temperature_unit: u,
    now, today,
    say: { now: deg(u === "F" ? now.temp_f : now.temp_c), high: deg(u === "F" ? today.high_f : today.high_c), low: deg(u === "F" ? today.low_f : today.low_c) },
    note: `A live reading for these coordinates, in ${name} — their unit. Say it plainly — the temperature, the sky, and today's high or rain only if it matters.`
      + ` Always name the unit with the number: "${deg(u === "F" ? now.temp_f : now.temp_c)?.replace(`°${u}`, ` degrees ${name}`) ?? `N degrees ${name}`}" out loud on a call, "${deg(u === "F" ? now.temp_f : now.temp_c) ?? `N°${u}`}" in a text. Never a bare number, and never the other unit unless they ask.`,
  };
}
