// Render the day's Idukki reservoir poster and refresh the README caption.
// Reads styles.yaml + level.json, picks the style-of-the-day, computes the water
// colour from the live storage %, then shells out to the map-paper CLI (the submodule)
// to produce out/idukki.png. All rendering knowledge lives in map-paper; this only
// orchestrates.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_PAPER = join(ROOT, "map-paper");
const PORT = 5199;
const BASE = `http://localhost:${PORT}`;

const cfg = parseYaml(readFileSync(join(ROOT, "styles.yaml"), "utf8"));
const level = JSON.parse(readFileSync(join(ROOT, "level.json"), "utf8"));
const weatherPath = join(ROOT, "weather.json");
const weather = existsSync(weatherPath) ? JSON.parse(readFileSync(weatherPath, "utf8")) : null;

// --- pick style-of-the-day ---
const dayOfYear = Math.floor(
  (Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86400000,
);
const style = cfg.rotation[dayOfYear % cfg.rotation.length];

// --- water colour from live storage % (clamped 0..1) ---
const t = Math.max(0, Math.min(1, level.percent / 100));
const hexToRgb = (h) => h.replace("#", "").match(/../g).map((x) => parseInt(x, 16));
const rgbToHex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const lerp = (a, b) => rgbToHex(hexToRgb(a).map((av, i) => av + (hexToRgb(b)[i] - av) * t));
const water = lerp(cfg.water_ramp.low, cfg.water_ramp.full);
const waterDots = lerp(cfg.water_ramp.dots_low, cfg.water_ramp.dots_full);

console.log(`style=${style} percent=${level.percent}% water=${water}`);

// --- start the map-paper dev server, render, then stop it ---
const server = spawn("npm", ["run", "dev", "--", "--port", String(PORT), "--strictPort"], {
  cwd: MAP_PAPER,
  stdio: "ignore",
});
try {
  await waitForServer(BASE, 60000);
  execFileSync(
    "node",
    [
      "scripts/render-cli.mjs",
      "--base", BASE,
      "--style", style,
      "--lat", String(cfg.view.lat),
      "--lng", String(cfg.view.lng),
      "--zoom", String(cfg.view.zoom),
      "--size", cfg.view.size,
      "--width", String(cfg.view.width),
      "--height", String(cfg.view.height),
      "--water", water,
      "--waterDots", waterDots,
      "--out", join(ROOT, "out", "idukki.png"),
    ],
    { cwd: MAP_PAPER, stdio: "inherit" },
  );
} finally {
  server.kill();
}

// --- refresh the README caption between markers ---
updateReadme();
console.log("done: out/idukki.png + README updated");

async function waitForServer(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("dev server did not start in time");
}

function updateReadme() {
  const readmePath = join(ROOT, "README.md");
  let readme = readFileSync(readmePath, "utf8");
  const caption =
    `Location: [Idukki reservoir](https://en.wikipedia.org/wiki/Idukki_Dam) · ` +
    `Water level: ${level.level} ft / ${level.frl} ft (**${level.percent}%**) · ${level.reportDate}`;
  readme = readme.replace(
    /<!--LEVEL:START-->[\s\S]*?<!--LEVEL:END-->/,
    `<!--LEVEL:START-->\n${caption}\n<!--LEVEL:END-->`,
  );
  const wx = weather ? `${weather.label}, ${weather.tempC}°C` : "—";
  readme = readme.replace(
    /<!--WEATHER:START-->[\s\S]*?<!--WEATHER:END-->/,
    `<!--WEATHER:START-->${wx}<!--WEATHER:END-->`,
  );
  writeFileSync(readmePath, readme);
}
