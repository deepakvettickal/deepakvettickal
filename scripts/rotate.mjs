// Hourly style rotation: point the README poster at the style-of-the-hour.
// Deliberately tiny — reads the pre-rendered style list and only rewrites the
// README <img> src (a few bytes), so hourly commits stay trivial. No deps, no
// browser, no rendering; the daily job does all the heavy work.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const styles = JSON.parse(readFileSync(join(ROOT, "out", "styles", "index.json"), "utf8"));
if (!styles.length) throw new Error("no styles in out/styles/index.json");

// Same index formula as build.mjs, so the daily and hourly jobs agree.
const id = styles[Math.floor(Date.now() / 3600000) % styles.length];

const readmePath = join(ROOT, "README.md");
const readme = readFileSync(readmePath, "utf8");
const img = `<img src="out/styles/${id}.png" alt="Idukki reservoir, water level shown by colour" width="100%">`;
const next = readme.replace(
  /<!--POSTER:START-->[\s\S]*?<!--POSTER:END-->/,
  `<!--POSTER:START-->${img}<!--POSTER:END-->`,
);
if (next === readme) {
  console.log(`no change (already showing ${id})`);
} else {
  writeFileSync(readmePath, next);
  console.log(`rotated to ${id}`);
}
