// Fetch current weather at the Idukki reservoir and write weather.json.
// Source: Open-Meteo (keyless, free). If it fails, the previous weather.json is kept
// so the daily render never breaks.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = parseYaml(readFileSync(join(ROOT, "styles.yaml"), "utf8"));
const OUT = join(ROOT, "weather.json");

// WMO weather codes -> short human label (grouped).
const WMO = {
  0: "Clear sky",
  1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Light showers", 81: "Showers", 82: "Heavy showers",
  85: "Snow showers", 86: "Snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};

try {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${cfg.view.lat}` +
    `&longitude=${cfg.view.lng}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,precipitation` +
    `&timezone=auto`;
  const res = await fetch(url, { headers: { "user-agent": "profile-readme/1.0" } });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const j = await res.json();
  const c = j.current;
  const data = {
    tempC: c.temperature_2m,
    humidity: c.relative_humidity_2m,
    precipitationMm: c.precipitation,
    code: c.weather_code,
    label: WMO[c.weather_code] ?? "—",
    observedAt: c.time,
    fetchedAt: new Date().toISOString(),
  };
  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  console.log("weather.json:", data.label + ",", data.tempC + "°C,", data.precipitationMm + "mm");
} catch (err) {
  console.error("fetch-weather failed, keeping previous weather.json:", err.message);
  process.exit(1);
}
