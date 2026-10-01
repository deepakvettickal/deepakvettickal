// Fetch the latest KSEB daily reservoir report, parse the Idukki reservoir row,
// and write level.json. If anything fails, the previous level.json is kept so the
// daily render never breaks.
//
// Data source: https://sdma.kerala.gov.in/dam-water-level/  (links to a daily
// KSEB-SITE-NN.pdf). The PDF is a Print-to-PDF of an Excel sheet; `pdftotext -layout`
// recovers a clean table. The Idukki reservoir (Idukki + Cheruthoni + Kulamavu, one
// impounded pool) is the only row measured in feet with FRL 2403.00 ft — a stable anchor.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LANDING = "https://sdma.kerala.gov.in/dam-water-level/";
const OUT = new URL("../level.json", import.meta.url);

async function resolvePdfUrl() {
  const res = await fetch(LANDING, { headers: { "user-agent": "profile-readme/1.0" } });
  if (!res.ok) throw new Error(`landing ${res.status}`);
  const html = await res.text();
  // Find the current KSEB PDF link. The filename varies over time (e.g. KSEB-SITE-20.pdf,
  // KSEB-Site.pdf) and stale links to older months can linger on the page, so match any
  // KSEB*.pdf and pick the one under the most recent /wp-content/uploads/YYYY/MM/ path.
  const links = [...html.matchAll(/(?:https?:\/\/[^"']*?|\/[^"']*?)KSEB[^"']*?\.pdf/gi)].map(
    (m) => m[0].replace(/&amp;/g, "&"),
  );
  if (!links.length) throw new Error("no KSEB PDF link found on landing page");
  const monthOf = (u) => {
    const d = u.match(/uploads\/(\d{4})\/(\d{2})\//);
    return d ? Number(d[1]) * 12 + Number(d[2]) : 0;
  };
  const latest = links.reduce((a, b) => (monthOf(b) > monthOf(a) ? b : a));
  return new URL(latest, LANDING).href;
}

async function downloadPdf(url) {
  const res = await fetch(url, { headers: { "user-agent": "profile-readme/1.0" } });
  if (!res.ok) throw new Error(`pdf ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), "kseb-"));
  const file = join(dir, "kseb.pdf");
  writeFileSync(file, buf);
  return file;
}

function parseIdukki(text) {
  const lines = text.split("\n");
  // The Idukki data row is the line carrying FRL 2403.00 ft.
  const row = lines.find((l) => /2403\.00\s*ft/.test(l));
  if (!row) throw new Error("Idukki row not found in PDF text");
  const pctMatch = row.match(/([\d.]+)\s*%/);
  if (!pctMatch) throw new Error(`unexpected Idukki row: ${row.trim()}`);
  // All numeric tokens in column order: [serial, FRL, level, rule, blue, orange,
  // red, capacity, liveStorage, percent]. Idukki fills every column, and we anchor
  // on the FRL=2403 row, so positional mapping is safe here.
  const nums = (row.match(/[\d.]+/g) ?? []).map(Number);
  const [, frl, level, rule, blue, orange, red] = nums;
  // Remarks: whatever trails the percentage. "-" or blank means none.
  const remarksRaw = row.slice(row.indexOf(pctMatch[0]) + pctMatch[0].length).trim();
  const remarks = /^[-–—\s]*$/.test(remarksRaw) ? null : remarksRaw;
  const stamp = text.match(/(\d{2}\/\d{2}\/\d{4})\s*-?\s*([\d.]+\s*(?:AM|PM))/i);
  return {
    reservoir: "Idukki",
    unit: "ft",
    frl,
    level,
    rule: rule ?? null,
    alerts: { blue: blue ?? null, orange: orange ?? null, red: red ?? null },
    percent: Number(pctMatch[1]),
    remarks,
    reportDate: stamp ? stamp[1] : (text.match(/(\d{2}\/\d{2}\/\d{4})/)?.[1] ?? null),
    reportTime: stamp ? stamp[2].replace(/\./g, ":").toUpperCase().replace(/\s+/g, " ") : null,
    fetchedAt: new Date().toISOString(),
  };
}

try {
  const url = await resolvePdfUrl();
  const pdf = await downloadPdf(url);
  const text = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
  const data = { ...parseIdukki(text), source: url };
  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  console.log("level.json:", data.level, "ft /", data.frl, "ft ·", data.percent + "%", "·", data.reportDate);
} catch (err) {
  console.error("fetch-level failed, keeping previous level.json:", err.message);
  process.exit(1);
}
