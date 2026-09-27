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

// --- colour helpers ---
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const hexToRgb = (h) => h.replace("#", "").match(/../g).map((x) => parseInt(x, 16));
const rgbToHex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => rgbToHex(hexToRgb(a).map((av, i) => av + (hexToRgb(b)[i] - av) * t));

// The water colour for a given level (ft), keyed to the alert thresholds: light→blue
// below the Blue alert, then the Blue / Orange / Red colour once each is crossed.
function colourForLevel(lvl) {
  const s = cfg.water_scale;
  const a = level.alerts ?? {};
  if (a.red != null && lvl >= a.red) return s.red;
  if (a.orange != null && lvl >= a.orange) return s.orange;
  if (a.blue != null && lvl >= a.blue) return s.blue;
  const top = a.blue ?? level.frl;
  return mix(s.low, s.blue, clamp01((lvl - s.floor_ft) / (top - s.floor_ft)));
}

const water = colourForLevel(level.level);
const waterDots = mix(water, "#000000", 0.28); // slightly darker pattern dots

console.log(`style=${style} level=${level.level}ft (${level.percent}%) water=${water}`);

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

// --- write the level scale bar, then refresh the README ---
writeLevelBar();
updateReadme();
console.log("done: out/idukki.png + level-bar.svg + README updated");

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

// A blocky colour scale for the reservoir level. Most of the bar is the normal
// range (light→blue); the top is split into the Blue / Orange / Red alert zones,
// each a solid alert colour and labelled. A marker sits at the current level, and
// the map water uses the same colour — so the water itself reads the alert status.
function writeLevelBar() {
  const s = cfg.water_scale;
  const a = level.alerts ?? {};
  const W = 1000, H = 58, barY = 0, barH = 22, N = 50, gap = 2;
  // Zone widths as fractions of the bar: normal is the widest.
  const NORMAL = 0.52, ALERT = (1 - NORMAL) / 3; // 0.16 each
  const bounds = { blue: NORMAL, orange: NORMAL + ALERT, red: NORMAL + 2 * ALERT };
  const colourAt = (p) => {
    if (p < bounds.blue) return mix(s.low, s.blue, p / bounds.blue);
    if (p < bounds.orange) return s.blue;
    if (p < bounds.red) return s.orange;
    return s.red;
  };
  // Blocks.
  const cellW = W / N;
  let cells = "";
  for (let i = 0; i < N; i++) {
    const p = (i + 0.5) / N;
    cells += `  <rect x="${(i * cellW).toFixed(1)}" y="${barY}" width="${(cellW - gap).toFixed(1)}" height="${barH}" fill="${colourAt(p)}"/>\n`;
  }
  // Current-level position on the same zoned axis.
  const seg = (lvl) => {
    if (a.blue != null && lvl < a.blue) return NORMAL * clamp01((lvl - s.floor_ft) / (a.blue - s.floor_ft));
    if (a.orange != null && lvl < a.orange) return NORMAL + ALERT * clamp01((lvl - a.blue) / (a.orange - a.blue));
    if (a.red != null && lvl < a.red) return bounds.blue + ALERT * clamp01((lvl - a.orange) / (a.red - a.orange));
    return bounds.orange + ALERT * clamp01((lvl - a.red) / (level.frl - a.red));
  };
  const mx = (W * seg(level.level)).toFixed(1);
  // Alert labels centred under each alert zone.
  const label = (name, colour, ft, mid) =>
    `  <text x="${(W * mid).toFixed(1)}" y="${barY + barH + 15}" text-anchor="middle" font-family="${FONT}" font-size="12.5" font-weight="600" fill="${colour}">${name}</text>
  <text x="${(W * mid).toFixed(1)}" y="${barY + barH + 30}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#8a8f98">${ft ?? "—"} ft</text>`;
  const labels = [
    a.blue != null ? label("Blue alert", s.blue, a.blue, NORMAL + ALERT / 2) : "",
    a.orange != null ? label("Orange alert", s.orange, a.orange, NORMAL + ALERT * 1.5) : "",
    a.red != null ? label("Red alert", s.red, a.red, NORMAL + ALERT * 2.5) : "",
  ].join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Water level ${level.level} ft, ${level.percent}%">
${cells}  <g transform="translate(${mx},0)">
    <rect x="-1.5" y="${barY - 3}" width="3" height="${barH + 6}" fill="#111418"/>
    <path d="M0 ${barY - 3} L-5 ${barY - 11} L5 ${barY - 11} Z" fill="#111418"/>
    <text x="0" y="${barY + barH + 15}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="700" fill="#3a4048">${level.level} ft</text>
    <text x="0" y="${barY + barH + 30}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#8a8f98">${level.percent}%</text>
  </g>
${labels}
</svg>
`;
  writeFileSync(join(ROOT, "out", "level-bar.svg"), svg);
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
