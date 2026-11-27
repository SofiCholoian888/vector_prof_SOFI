// Проверяет реальный EmbeddingsGigaR через настроенный шлюз и совместимость
// текущего индекса с этим шлюзом. Секреты не печатаются и не сохраняются.
//
// Запуск из backend/:
//   LLM_BASE_URL=... LLM_API_KEY=... LLM_EMBEDDINGS_MODEL=EmbeddingsGigaR \
//     node --experimental-strip-types scripts/check-live-embeddings.mjs
//
// Коды выхода: 0 — проверка пройдена, 1 — расхождение, 2 — нет доступа к шлюзу.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readEmbeddingBatch } from "../lib/ai/embedding-response.ts";
import { gatewayEndpoint, readEmbeddingsGateway } from "../lib/ai/gateway-env.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "audit-results/semantic/live-embedding-check.json");
const EXPECTED_MODEL = "EmbeddingsGigaR";
const EXPECTED_DIMENSIONS = 2560;
// Порог выбран проектом, а не провайдером: он отделяет «тот же шлюз и та же
// модель» от «другое пространство эмбеддингов».
const STORED_SIMILARITY_FLOOR = 0.995;

const controlTexts = [
  "Ремонт и настройка механического оборудования",
  "Обслуживание и ремонт двигателей и механизмов",
  "Написание программного обеспечения",
  "Исследование состояния окружающей среды",
];

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function l2Norm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function maxAbsDiff(left, right) {
  let worst = 0;
  for (let index = 0; index < left.length; index += 1) {
    worst = Math.max(worst, Math.abs(left[index] - right[index]));
  }
  return worst;
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
}

async function embed(settings, texts) {
  const startedAt = Date.now();
  const response = await fetch(gatewayEndpoint(settings.baseUrl, "embeddings"), {
    method: "POST",
    headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: settings.model, input: texts }),
    signal: AbortSignal.timeout(30000),
  });
  const bodyText = await response.text();
  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${bodyText.slice(0, 200)}`);
  }
  const parsed = JSON.parse(bodyText);
  return {
    durationMs,
    modelReported: typeof parsed?.model === "string" ? parsed.model : null,
    vectors: readEmbeddingBatch(parsed, settings.model, texts.length, EXPECTED_DIMENSIONS),
  };
}

const settings = readEmbeddingsGateway(process.env);
const baseReport = {
  checkedAtUtc: new Date().toISOString(),
  gatewayHost: settings ? new URL(settings.baseUrl).host : null,
  requestedModel: settings?.model ?? null,
  mockMode: process.env.USE_MOCK_EMBEDDINGS === "true",
  indexSha256: null,
};

if (!settings || settings.model !== EXPECTED_MODEL) {
  writeReport({
    ...baseReport,
    status: "BLOCKED",
    reason: "configuration_missing",
    detail: "Нужны LLM_BASE_URL, LLM_API_KEY и LLM_EMBEDDINGS_MODEL=EmbeddingsGigaR.",
  });
  console.error("BLOCKED: шлюз эмбеддингов не настроен в окружении.");
  process.exit(2);
}

const index = JSON.parse(fs.readFileSync(path.join(root, "data/catalog.index.json"), "utf8"));
baseReport.indexSha256 = (await import("node:crypto"))
  .createHash("sha256")
  .update(fs.readFileSync(path.join(root, "data/catalog.index.json")))
  .digest("hex");

try {
  const control = await embed(settings, controlTexts);
  const pairCosines = [];
  for (let left = 0; left < controlTexts.length; left += 1) {
    for (let right = left + 1; right < controlTexts.length; right += 1) {
      pairCosines.push({
        left: controlTexts[left],
        right: controlTexts[right],
        cosine: Number(cosine(control.vectors[left], control.vectors[right]).toFixed(4)),
      });
    }
  }

  // Пять профессий из разных отраслей: берём первую профессию каждой отрасли.
  const byIndustry = new Map();
  for (const entry of index.entries) {
    if (entry.type !== "profession_core") continue;
    const industryId = entry.metadata?.industry_id;
    if (!byIndustry.has(industryId)) byIndustry.set(industryId, entry);
  }
  const sampleEntries = [...byIndustry.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .slice(0, 5)
    .map(([, entry]) => entry);

  const reembed = await embed(
    settings,
    sampleEntries.map((entry) => entry.metadata.text_preview)
  );
  const compatibility = sampleEntries.map((entry, position) => {
    const stored = entry.vector;
    const live = reembed.vectors[position];
    return {
      professionId: entry.metadata.profession_id,
      industryId: entry.metadata.industry_id,
      storedDimensions: stored.length,
      liveDimensions: live.length,
      cosine: Number(cosine(stored, live).toFixed(6)),
      l2Stored: Number(l2Norm(stored).toFixed(4)),
      l2Live: Number(l2Norm(live).toFixed(4)),
      maxAbsCoordinateDiff: Number(maxAbsDiff(stored, live).toFixed(6)),
    };
  });

  // Числовой дрейф самого шлюза: один и тот же текст три раза подряд.
  const driftText = sampleEntries[0].metadata.text_preview;
  const driftRuns = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const run = await embed(settings, [driftText]);
    driftRuns.push(run.vectors[0]);
  }
  const drift = [
    { pair: "1-2", cosine: Number(cosine(driftRuns[0], driftRuns[1]).toFixed(6)), maxAbsCoordinateDiff: Number(maxAbsDiff(driftRuns[0], driftRuns[1]).toFixed(6)) },
    { pair: "1-3", cosine: Number(cosine(driftRuns[0], driftRuns[2]).toFixed(6)), maxAbsCoordinateDiff: Number(maxAbsDiff(driftRuns[0], driftRuns[2]).toFixed(6)) },
    { pair: "2-3", cosine: Number(cosine(driftRuns[1], driftRuns[2]).toFixed(6)), maxAbsCoordinateDiff: Number(maxAbsDiff(driftRuns[1], driftRuns[2]).toFixed(6)) },
  ];

  const worstStoredSimilarity = Math.min(...compatibility.map((item) => item.cosine));
  const worstDriftSimilarity = Math.min(...drift.map((item) => item.cosine));
  const report = {
    ...baseReport,
    status: worstStoredSimilarity >= STORED_SIMILARITY_FLOOR ? "PASS" : "FAIL",
    controlRequest: {
      httpStatus: 200,
      modelReportedByGateway: control.modelReported,
      modelConfirmedByProvider: control.modelReported === EXPECTED_MODEL,
      vectorCount: control.vectors.length,
      dimensions: [...new Set(control.vectors.map((vector) => vector.length))],
      durationMs: control.durationMs,
      pairCosines,
    },
    indexCompatibility: {
      sampleSize: compatibility.length,
      worstStoredSimilarity,
      worstDriftSimilarity,
      threshold: STORED_SIMILARITY_FLOOR,
      note: "Порог выбран проектом как граница «та же модель и то же пространство», а не как гарантия провайдера.",
      samples: compatibility,
      drift,
    },
    limitations: [
      "Имя модели подтверждено только если шлюз возвращает поле model.",
      "Совпадение векторов не побайтовое: провайдер не гарантирует детерминированность.",
    ],
  };
  writeReport(report);
  console.log(JSON.stringify({
    status: report.status,
    modelReported: control.modelReported,
    dimensions: report.controlRequest.dimensions,
    worstStoredSimilarity,
    worstDriftSimilarity,
    out: path.relative(root, outFile),
  }, null, 2));
  process.exit(report.status === "PASS" ? 0 : 1);
} catch (error) {
  writeReport({
    ...baseReport,
    status: "FAIL",
    reason: "gateway_error",
    error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
  });
  console.error(`FAIL: ${error instanceof Error ? error.message.slice(0, 300) : "unknown"}`);
  process.exit(1);
}
