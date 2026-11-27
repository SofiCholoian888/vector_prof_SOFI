// Проверяет AI-пайплайн на синтетических профилях: реальный поиск и генерация.
// Запуск из backend:
//   node --experimental-strip-types --import ./tests/register-app-alias.mjs \
//     scripts/check-semantic-pipeline.mjs [--profiles=15,3,12] \
//     [--expect-retrieval=semantic|lexical|mock] [--expect-generation=llm|retrieval_only] \
//     [--out=audit-results/semantic/local-pipeline-smoke.jsonl]
//
// Коды выхода: 0 — все ожидания выполнены, 1 — расхождение, 2 — нет доступа к шлюзу.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareSofiInput } from "../lib/sofi-adapter.ts";
import { runSofiPipeline } from "../lib/sofi-pipeline.ts";
import { loadRuntimeCatalog } from "../lib/runtime-catalog.ts";
import { readChatGateway, readEmbeddingsGateway } from "../lib/ai/gateway-env.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map(
  process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);

const expectRetrieval = args.get("expect-retrieval") ?? null;
const expectGeneration = args.get("expect-generation") ?? null;
const outFile = args.get("out") ? path.resolve(root, args.get("out")) : null;

// 15 — 11 класс, ИТ-профиль; 3 — 6 класс, творческий; 12 — 10 класс, химико-биологический.
const defaultProfiles = [15, 3, 12];
const profileIds = (args.get("profiles") ?? defaultProfiles.join(","))
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value));

const students = JSON.parse(fs.readFileSync(path.join(root, "data/mock_students_data.json"), "utf8"));
const catalog = loadRuntimeCatalog().catalog;
const catalogProfessionIds = new Set(catalog.professions.map((profession) => profession.profession_id));

if (!readEmbeddingsGateway(process.env) || !readChatGateway(process.env)) {
  console.error("BLOCKED: нужны LLM_BASE_URL, LLM_API_KEY, LLM_MODEL и LLM_EMBEDDINGS_MODEL.");
  process.exit(2);
}

const results = [];
let failed = false;

for (const studentId of profileIds) {
  const student = students.find((item) => item.student_id === studentId);
  if (!student) throw new Error(`Профиль ${studentId} не найден в mock_students_data.json`);

  const diagnosticAnswers = Object.entries(student.answers).map(([questionId, answer]) => ({
    questionId,
    answer,
  }));
  const prepared = prepareSofiInput({
    profile: { schoolGrade: student.grade, municipality: student.city ?? "Екатеринбург" },
    diagnosticAnswers,
  });

  const startedAt = Date.now();
  const result = await runSofiPipeline({ prepared, professions: [] });
  const durationMs = Date.now() - startedAt;

  const hypothesisIds = result.hypotheses.map((item) => item.profession_id);
  const unknownIds = hypothesisIds.filter((id) => !catalogProfessionIds.has(id));
  const record = {
    environment: "local",
    checkedAtUtc: new Date().toISOString(),
    testProfileId: studentId,
    grade: student.grade,
    answers: diagnosticAnswers.length,
    retrievalMode: result.generation?.retrievalMode ?? null,
    generationMode: result.generation?.mode ?? null,
    catalogVersion: result.generation?.catalogVersion ?? null,
    configVersion: result.generation?.configVersion ?? null,
    attempts: result.generation?.attempts ?? null,
    status: result.status,
    hypothesisCount: result.hypotheses.length,
    catalogProfessionIds: hypothesisIds,
    unknownProfessionIds: unknownIds,
    warnings: result.warnings ?? [],
    durationMs,
  };
  results.push(record);

  const problems = [];
  if (result.generation?.catalogVersion !== catalog.version) problems.push("catalog_version");
  if (result.hypotheses.length === 0) problems.push("empty_hypotheses");
  if (unknownIds.length > 0) problems.push("unknown_profession_ids");
  if (expectRetrieval && record.retrievalMode !== expectRetrieval) problems.push("retrieval_mode");
  if (expectGeneration && record.generationMode !== expectGeneration) problems.push("generation_mode");
  if (problems.length > 0) failed = true;

  console.log(JSON.stringify({ ...record, problems }, null, 2));
  assert.deepEqual(unknownIds, [], `Профиль ${studentId}: гипотезы вне каталога`);
}

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${results.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

const modes = new Set(results.map((record) => `${record.retrievalMode}/${record.generationMode}`));
console.log(JSON.stringify({
  profiles: profileIds,
  modes: [...modes],
  failed,
  out: outFile ? path.relative(root, outFile) : null,
}, null, 2));
process.exit(failed ? 1 : 0);
