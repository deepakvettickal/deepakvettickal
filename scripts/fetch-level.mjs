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
  // Find the current KSEB PDF link (filename changes daily, e.g. KSEB-SITE-20.pdf).
  // The link is usually relative (/wp-content/...); the first KSEB-SITE match is the latest.
  const m = html.match(/(?:https?:\/\/[^"']*?|\/[^"']*?)KSEB-SITE-[^"']*?\.pdf/i);
  if (!m) throw new Error("no KSEB PDF link found on landing page");
  return new URL(m[0].replace(/&amp;/g, "&"), LANDING).href;
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
  const ftVals = [...row.matchAll(/([\d.]+)\s*ft/g)].map((m) => Number(m[1]));
  const pctMatch = row.match(/([\d.]+)\s*%/);
  if (ftVals.length < 2 || !pctMatch) throw new Error(`unexpected Idukki row: ${row.trim()}`);
  const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})/);
  const [frl, level, rule] = ftVals;
  return {
    reservoir: "Idukki",
    unit: "ft",
    frl,
    level,
    rule: rule ?? null,
    percent: Number(pctMatch[1]),
    reportDate: dateMatch ? dateMatch[1] : null,
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
