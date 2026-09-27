// Render the day's Idukki reservoir poster and refresh the README caption.
// Reads styles.yaml + level.json, picks the style-of-the-day, computes the water
// colour from the live storage %, then shells out to the map-paper CLI (the submodule)
// to produce out/idukki.png. All rendering knowledge lives in map-paper; this only
// orchestrates.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

// --- all rotation styles are rendered; the hourly job picks which one shows ---
// Normalise each entry to { id, style, hue, chroma, lighten }. A bare string is a
// plain style; an object is an OKLCH palette variant of a base style.
const rotation = cfg.rotation.map((e) =>
  typeof e === "string"
    ? { id: e, style: e, hue: 0, chroma: 1, lighten: 0 }
    : { id: e.id, style: e.style, hue: e.hue ?? 0, chroma: e.chroma ?? 1, lighten: e.lighten ?? 0 },
);
const ids = rotation.map((r) => r.id);
const current = ids[Math.floor(Date.now() / 3600000) % ids.length];

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

console.log(`${ids.length} styles · level=${level.level}ft (${level.percent}%) water=${water}`);

// --- start the map-paper dev server, render every style, then stop it ---
const outStyles = join(ROOT, "out", "styles");
mkdirSync(outStyles, { recursive: true });
const fw = 1100, fh = Math.round((fw * cfg.view.height) / cfg.view.width);
// One small image per day is archived as a permanent record (survives the weekly
// history purge); the daily record uses the pencil style at a modest size.
const archiveDir = join(ROOT, "archive");
mkdirSync(archiveDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const render = (style, w, h, out) =>
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
      "--width", String(w),
      "--height", String(h),
      "--water", water,
      "--waterDots", waterDots,
      "--out", out,
    ],
    { cwd: MAP_PAPER, stdio: "inherit" },
  );
const server = spawn("npm", ["run", "dev", "--", "--port", String(PORT), "--strictPort"], {
  cwd: MAP_PAPER,
  stdio: "ignore",
});
try {
  await waitForServer(BASE, 60000);
  for (const r of rotation) {
    console.log("rendering", r.id);
    execFileSync(
      "node",
      [
        "scripts/render-cli.mjs",
        "--base", BASE,
        "--style", r.style,
        "--lat", String(cfg.view.lat),
        "--lng", String(cfg.view.lng),
        "--zoom", String(cfg.view.zoom),
        "--size", cfg.view.size,
        "--width", String(fw),
        "--height", String(fh),
        "--water", water,
        "--waterDots", waterDots,
        "--hueShift", String(r.hue),
        "--chroma", String(r.chroma),
        "--lighten", String(r.lighten),
        "--out", join(outStyles, `${r.id}.png`),
      ],
      { cwd: MAP_PAPER, stdio: "inherit" },
    );
  }
  console.log("archiving", today);
  render("pencil", fw, fh, join(archiveDir, `${today}.png`)); // same quality as displayed
} finally {
  server.kill();
}
// The ordered id list the hourly rotate job reads (no YAML/npm needed there).
writeFileSync(join(outStyles, "index.json"), JSON.stringify(ids) + "\n");

// --- point the README at the current style, write the level bar, refresh text ---
setPoster(current);
writeLevelBar();
updateReadme();
console.log(`done: ${ids.length} styles + level-bar.svg + README (showing ${current})`);

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
  const W = 1000, H = 58, barY = 0, barH = 22, N = 50, gap = 0.8;
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
    <rect x="-2" y="${barY}" width="4" height="${barH}" fill="#ffffff"/>
    <rect x="-2" y="${barY}" width="4" height="${barH}" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="1"/>
    <text x="0" y="${barY + barH + 15}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="#57606a">${level.level} ft</text>
    <text x="0" y="${barY + barH + 30}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#8a8f98">${level.percent}% capacity</text>
  </g>
${labels}
</svg>
`;
  writeFileSync(join(ROOT, "out", "level-bar.svg"), svg);
}

// Point the README poster <img> at a given style (same swap the rotate job does).
function setPoster(id) {
  const readmePath = join(ROOT, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const img = `<img src="out/styles/${id}.png" alt="Idukki reservoir, water level shown by colour" width="100%">`;
  writeFileSync(
    readmePath,
    readme.replace(/<!--POSTER:START-->[\s\S]*?<!--POSTER:END-->/, `<!--POSTER:START-->${img}<!--POSTER:END-->`),
  );
}

function updateReadme() {
  const readmePath = join(ROOT, "README.md");
  let readme = readFileSync(readmePath, "utf8");

  const remarks = level.remarks ? ` · Remarks: ${level.remarks}` : "";
  const stamp = [level.reportDate, level.reportTime].filter(Boolean).join(" ");
  const caption =
    `Location: [Idukki reservoir](https://en.wikipedia.org/wiki/Idukki_Dam) · ` +
    `Water level: \`${level.level} ft\` / \`${level.frl} ft\` (${level.percent}%)${remarks} · ` +
    `Last updated: ${stamp || "unknown"}`;
  readme = replaceBlock(readme, "LEVEL", caption);

  const wx = weather ? `${weather.label}, ${weather.tempC}°C` : "unavailable";
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
