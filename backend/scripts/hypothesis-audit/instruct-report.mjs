// Считает метрики эксперимента с инструкцией по JSONL-файлам audit.mjs.
//
// Запуск из backend:
//   node scripts/hypothesis-audit/instruct-report.mjs \
//     --dir=audit-results/semantic --modes=plain,instruct_v1,instruct_v2,instruct_v3 \
//     [--out=audit-results/semantic/instruct-metrics.json]
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
const dir = path.resolve(root, args.get("dir") ?? "audit-results/semantic");
const modes = (args.get("modes") ?? "plain,instruct_v1,instruct_v2,instruct_v3").split(",");
const outFile = args.get("out") ? path.resolve(root, args.get("out")) : null;

function readMode(mode) {
  const file = path.join(dir, `instruct-${mode}.jsonl`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function round(value, digits = 3) {
  return value == null ? null : Number(value.toFixed(digits));
}

function top1Hypothesis(record) {
  return record.hypotheses?.[0]?.id ?? null;
}

function metricsFor(records, baseline) {
  const probes = records.filter((record) => record.profile.startsWith("probe-"));
  const mocks = records.filter((record) => record.profile.startsWith("mock-"));

  const probeTop1 = probes.filter((record) => record.retrieval.industryIds?.[0] === record.expected);
  const probeTop5 = probes.filter((record) => (record.retrieval.industryIds ?? []).slice(0, 5).includes(record.expected));
  const probeRanks = probes
    .map((record) => {
      const index = (record.retrieval.industryIds ?? []).indexOf(record.expected);
      return index < 0 ? null : index + 1;
    })
    .filter((rank) => rank != null)
    .sort((left, right) => left - right);

  // В тире 1–4 гипотез нет по устройству ответа: там направления и занятия.
  const gradable = mocks.filter((record) => record.tier !== "1-4");
  const mockEmpty = gradable.filter((record) => (record.hypotheses?.length ?? 0) === 0);
  const mockTop1 = gradable.map(top1Hypothesis).filter(Boolean);
  const topScores = mocks
    .map((record) => record.hypotheses?.[0]?.score ?? null)
    .filter((score) => score != null);

  const industryCounts = new Map();
  for (const record of mocks) {
    if (record.tier === "1-4") continue;
    for (const hypothesis of (record.hypotheses ?? []).slice(0, 5)) {
      industryCounts.set(hypothesis.industry_id, (industryCounts.get(hypothesis.industry_id) ?? 0) + 1);
    }
  }
  const professionCounts = new Map();
  for (const record of gradable) {
    for (const hypothesis of (record.hypotheses ?? []).slice(0, 5)) {
      const key = `${hypothesis.id} ${hypothesis.name}`;
      professionCounts.set(key, (professionCounts.get(key) ?? 0) + 1);
    }
  }
  const totalHypotheses = [...industryCounts.values()].reduce((sum, value) => sum + value, 0);
  const dominant = [...industryCounts.entries()].sort((left, right) => right[1] - left[1])[0] ?? null;

  let overlap = null;
  if (baseline) {
    const baselineById = new Map(baseline.map((record) => [record.profile, record]));
    const shares = [];
    for (const record of gradable) {
      const reference = baselineById.get(record.profile);
      if (!reference) continue;
      const left = new Set((record.hypotheses ?? []).map((item) => item.id));
      const right = new Set((reference.hypotheses ?? []).map((item) => item.id));
      const union = new Set([...left, ...right]);
      if (union.size === 0) continue;
      const intersection = [...left].filter((id) => right.has(id)).length;
      shares.push(intersection / union.size);
    }
    overlap = mean(shares);
  }

  return {
    mode: records[0]?.retrieval?.mode ?? null,
    records: records.length,
    probes: probes.length,
    probeTop1IndustryHit: round(probeTop1.length / Math.max(probes.length, 1)),
    probeTop5IndustryHit: round(probeTop5.length / Math.max(probes.length, 1)),
    probeMedianExpectedIndustryRank: probeRanks.length ? probeRanks[Math.floor(probeRanks.length / 2)] : null,
    mockProfiles: mocks.length,
    gradableProfiles: gradable.length,
    elementaryProfiles: mocks.length - gradable.length,
    mockEmptyRate: round(mockEmpty.length / Math.max(gradable.length, 1)),
    meanHypotheses: round(mean(gradable.map((record) => record.hypotheses?.length ?? 0))),
    mockDistinctTop1: new Set(mockTop1).size,
    mockMeanTopScore: round(mean(topScores), 4),
    mockTop1Frequency: Object.fromEntries(
      [...new Set(mockTop1)].map((id) => [id, mockTop1.filter((value) => value === id).length])
    ),
    mockMostFrequentTop5Professions: [...professionCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([profession, count]) => ({ profession, count })),
    mockIndustryConcentration: dominant && totalHypotheses
      ? { industry: dominant[0], share: round(dominant[1] / totalHypotheses) }
      : null,
    mockTop5JaccardVsBaseline: round(overlap),
    warnings: records.flatMap((record) => record.retrieval?.warnings ?? []).reduce((counts, warning) => {
      counts[warning] = (counts[warning] ?? 0) + 1;
      return counts;
    }, {}),
    catalogVersions: [...new Set(records.map((record) => record.catalogVersion))],
    catalogs: [...new Set(records.map((record) => record.catalog))],
  };
}

const loaded = new Map();
for (const mode of modes) {
  const records = readMode(mode);
  if (records) loaded.set(mode, records);
}
if (loaded.size === 0) {
  console.error(`Нет файлов instruct-*.jsonl в ${dir}`);
  process.exit(2);
}

const baseline = loaded.get("plain") ?? null;
const report = {
  generatedAtUtc: new Date().toISOString(),
  dir: path.relative(root, dir),
  modes: Object.fromEntries(
    [...loaded.entries()].map(([mode, records]) => [mode, metricsFor(records, mode === "plain" ? null : baseline)])
  ),
};

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
}

const header = "| Режим | Пустые (мок) | Top-1 отрасль (пробы) | Top-5 отрасль (пробы) | Медиана ранга | Разных top-1 | Jaccard к plain | Средний top-score |";
console.log(header);
console.log("|---|---|---|---|---|---|---|---|");
for (const [mode, value] of Object.entries(report.modes)) {
  console.log(
    `| ${mode} | ${value.mockEmptyRate} | ${value.probeTop1IndustryHit} | ${value.probeTop5IndustryHit} | ` +
    `${value.probeMedianExpectedIndustryRank} | ${value.mockDistinctTop1} | ${value.mockTop5JaccardVsBaseline ?? "—"} | ${value.mockMeanTopScore} |`
  );
}
console.log(JSON.stringify({ out: outFile ? path.relative(root, outFile) : null, modes: Object.keys(report.modes) }));
