// Один сценарий матрицы отказов: запускает прокси, гоняет пайплайн на одном
// профиле и печатает результат одной строкой JSON.
//
// Запуск из backend (обычно через fault-matrix.mjs):
//   node --experimental-strip-types --import ./tests/register-app-alias.mjs \
//     scripts/hypothesis-audit/fault-case.mjs --scenario=embed_500 --profile=15
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startFaultProxy } from "./fault-proxy.mjs";
import { prepareSofiInput } from "../../lib/sofi-adapter.ts";
import { runSofiPipeline } from "../../lib/sofi-pipeline.ts";
import { loadRuntimeCatalog } from "../../lib/runtime-catalog.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map(
  process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);

const scenario = args.get("scenario") ?? "pass";
const profileId = Number(args.get("profile") ?? 15);
const students = JSON.parse(fs.readFileSync(path.join(root, "data/mock_students_data.json"), "utf8"));
const student = students.find((item) => item.student_id === profileId);
if (!student) throw new Error(`Профиль ${profileId} не найден`);

const prepared = prepareSofiInput({
  profile: { schoolGrade: student.grade, municipality: student.city ?? "Екатеринбург" },
  diagnosticAnswers: Object.entries(student.answers).map(([questionId, answer]) => ({ questionId, answer })),
});

let proxy = null;
if (scenario === "no_credentials") {
  for (const key of ["LLM_BASE_URL", "LLM_API_KEY", "AI_API_BASE_URL", "AI_API_KEY", "LLM_EMBEDDINGS_MODEL"]) {
    delete process.env[key];
  }
} else if (scenario !== "pass") {
  proxy = await startFaultProxy({ mode: scenario });
  process.env.LLM_BASE_URL = proxy.baseUrl;
}

const startedAt = Date.now();
let result = null;
let error = null;
try {
  result = await runSofiPipeline({ prepared, professions: [] });
} catch (caught) {
  error = caught instanceof Error ? `${caught.name}: ${caught.message}` : "unknown";
}
const durationMs = Date.now() - startedAt;

const record = {
  scenario,
  profile: profileId,
  grade: student.grade,
  retrievalMode: result?.generation?.retrievalMode ?? null,
  generationMode: result?.generation?.mode ?? null,
  catalogVersion: result?.generation?.catalogVersion ?? null,
  configVersion: result?.generation?.configVersion ?? null,
  hypothesisCount: result?.hypotheses?.length ?? 0,
  catalogProfessionIds: result?.hypotheses?.map((item) => item.profession_id) ?? [],
  warnings: result?.warnings ?? [],
  error,
  durationMs,
  catalogProfessions: loadRuntimeCatalog().catalog.professions.length,
  proxyRequests: proxy ? proxy.log.map((entry) => ({ path: entry.path, status: entry.status })) : [],
};

if (proxy) await proxy.close();
console.log(JSON.stringify(record));
process.exit(0);
