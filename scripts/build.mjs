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
const FONT = "system-ui,Segoe UI,Helvetica,Arial,sans-serif";

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

// --- write the level bar + alert legend, then refresh the README ---
writeLevelBar();
writeAlertsBar();
updateReadme();
console.log("done: out/idukki.png + level-bar.svg + alerts.svg + README updated");

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

// A full-width rectangular colour scale (low→full) with a subtle marker + % at
// the current level. SVG so it stays crisp and tiny; GitHub serves it as an image.
function writeLevelBar() {
  const W = 1000, H = 40, barY = 0, barH = 22;
  const x = W * Math.max(0, Math.min(1, level.percent / 100));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Water level ${level.percent}%">
  <defs>
    <linearGradient id="ramp" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${cfg.water_ramp.low}"/>
      <stop offset="1" stop-color="${cfg.water_ramp.full}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${barY}" width="${W}" height="${barH}" fill="url(#ramp)"/>
  <g transform="translate(${x.toFixed(1)},0)">
    <rect x="-1" y="${barY}" width="2" height="${barH}" fill="#ffffff" opacity="0.9"/>
    <text x="0" y="${H - 4}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="#8a8f98">${level.percent}<tspan font-size="9" fill="#b0b4ba">%</tspan></text>
  </g>
</svg>
`;
  writeFileSync(join(ROOT, "out", "level-bar.svg"), svg);
}

// Alert thresholds as small coloured dashes with their level values.
function writeAlertsBar() {
  const a = level.alerts ?? {};
  const items = [
    ["#2f81f7", "Blue", a.blue],
    ["#e8901b", "Orange", a.orange],
    ["#e5484d", "Red", a.red],
  ].filter(([, , v]) => v != null);
  const W = 1000, H = 26, colW = W / 3;
  const cells = items
    .map(([col, name, v], i) => {
      const x = i * colW + 2;
      return `  <rect x="${x}" y="10" width="26" height="4" rx="2" fill="${col}"/>
  <text x="${x + 34}" y="17" font-family="${FONT}" font-size="14" fill="#57606a"><tspan fill="${col}" font-weight="600">${name}</tspan> ${v} ft</text>`;
    })
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Alert levels">
${cells}
</svg>
`;
  writeFileSync(join(ROOT, "out", "alerts.svg"), svg);
}

function updateReadme() {
  const readmePath = join(ROOT, "README.md");
  let readme = readFileSync(readmePath, "utf8");

  const remarks = level.remarks ? ` · Remarks: ${level.remarks}` : "";
  const stamp = [level.reportDate, level.reportTime].filter(Boolean).join(" ");
  const caption =
    `Location: [Idukki reservoir](https://en.wikipedia.org/wiki/Idukki_Dam) · ` +
    `Water level: \`${level.level} ft\` / \`${level.frl} ft\` (${level.percent}%)${remarks} · ` +
    `Last updated: ${stamp || "—"}`;
  readme = replaceBlock(readme, "LEVEL", caption);

  const wx = weather ? `${weather.label}, ${weather.tempC}°C` : "—";
  readme = readme.replace(
    /<!--WEATHER:START-->[\s\S]*?<!--WEATHER:END-->/,
    `<!--WEATHER:START-->${wx}<!--WEATHER:END-->`,
  );
  writeFileSync(readmePath, readme);
}

function replaceBlock(text, name, body) {
  return text.replace(
    new RegExp(`<!--${name}:START-->[\\s\\S]*?<!--${name}:END-->`),
    `<!--${name}:START-->\n${body}\n<!--${name}:END-->`,
  );
}
