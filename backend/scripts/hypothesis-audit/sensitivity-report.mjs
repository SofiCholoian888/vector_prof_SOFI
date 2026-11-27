// Чувствительность рекомендаций к изменению одного ответа: сравнивает пары
// base / flip из одного прогона audit.mjs.
//
// Запуск из backend:
//   node scripts/hypothesis-audit/sensitivity-report.mjs \
//     --file=audit-results/semantic/sensitivity-plain.jsonl [--out=...json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map(
  process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);
const file = path.resolve(root, args.get("file") ?? "audit-results/semantic/sensitivity-plain.jsonl");
const outFile = args.get("out") ? path.resolve(root, args.get("out")) : null;

const records = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const byProfile = new Map();
for (const record of records) {
  const key = record.profile.replace(/-flip$/, "");
  const entry = byProfile.get(key) ?? { profile: key, grade: record.grade, tier: record.tier };
  entry[record.variant] = record;
  byProfile.set(key, entry);
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  return [...a].filter((value) => b.has(value)).length / union.size;
}

const rows = [];
for (const entry of byProfile.values()) {
  if (!entry.base || !entry.flip) continue;
  const baseIds = (entry.base.hypotheses ?? []).map((item) => item.id);
  const flipIds = (entry.flip.hypotheses ?? []).map((item) => item.id);
  const baseTop1 = baseIds[0] ?? null;
  const flipTop1 = flipIds[0] ?? null;
  rows.push({
    profile: entry.profile,
    grade: entry.grade,
    tier: entry.tier,
    flippedQuestion: entry.flip.flippedQuestion,
    flippedTo: entry.flip.flippedTo,
    baseTop1,
    flipTop1,
    top1Changed: baseTop1 !== flipTop1,
    top5Jaccard: Number(jaccard(baseIds, flipIds).toFixed(3)),
    baseTop1StillPresent: baseTop1 ? flipIds.includes(baseTop1) : null,
    baseTop1NewRank: baseTop1 && flipIds.includes(baseTop1) ? flipIds.indexOf(baseTop1) + 1 : null,
    baseIndustries: (entry.base.retrieval?.industryIds ?? []).slice(0, 3),
    flipIndustries: (entry.flip.retrieval?.industryIds ?? []).slice(0, 3),
  });
}

const summary = {
  generatedAtUtc: new Date().toISOString(),
  file: path.relative(root, file),
  pairs: rows.length,
  top1ChangedRate: rows.length ? Number((rows.filter((row) => row.top1Changed).length / rows.length).toFixed(3)) : null,
  meanTop5Jaccard: rows.length
    ? Number((rows.reduce((sum, row) => sum + row.top5Jaccard, 0) / rows.length).toFixed(3))
    : null,
  baseTop1KeptRate: rows.length
    ? Number((rows.filter((row) => row.baseTop1StillPresent).length / rows.length).toFixed(3))
    : null,
  topIndustryChangedRate: rows.length
    ? Number((rows.filter((row) => row.baseIndustries[0] !== row.flipIndustries[0]).length / rows.length).toFixed(3))
    : null,
};

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify({ ...summary, rows }, null, 2)}\n`);
}
console.log(JSON.stringify(summary, null, 2));
for (const row of rows) {
  console.log(`${row.profile.padEnd(10)} top1=${String(row.baseTop1).padEnd(8)} -> ${String(row.flipTop1).padEnd(8)} jaccard=${row.top5Jaccard} kept=${row.baseTop1StillPresent}`);
}
