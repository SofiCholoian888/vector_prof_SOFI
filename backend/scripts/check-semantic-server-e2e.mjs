// Полный E2E-прогон против развёрнутого API: сессия → анкета → генерация →
// сохранённая рекомендация. Проверяет именно рабочий маршрут приложения,
// а не отдельный embedding API.
//
// Запуск из backend:
//   node scripts/check-semantic-server-e2e.mjs \
//     --base=https://vector-app.ai4edu.ru --grade=11 --profile=15 \
//     --expect-retrieval=semantic [--expect-generation=llm] \
//     --out=audit-results/semantic/server-semantic-e2e.jsonl
//
// Скрипт не отключает проверку владения сессией: cookie выдаёт сервер.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map(
  process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);

const base = (args.get("base") ?? "https://vector-app.ai4edu.ru").replace(/\/+$/, "");
const grade = Number(args.get("grade") ?? 11);
const profileId = Number(args.get("profile") ?? 15);
const expectRetrieval = args.get("expect-retrieval") ?? null;
const expectGeneration = args.get("expect-generation") ?? null;
const outFile = args.get("out") ? path.resolve(root, args.get("out")) : null;
const waitTimeoutMs = Number(args.get("timeout") ?? 180000);

const students = JSON.parse(fs.readFileSync(path.join(root, "data/mock_students_data.json"), "utf8"));
const catalog = JSON.parse(fs.readFileSync(path.join(root, "data/export/navigator.json"), "utf8"));
const catalogIds = new Set(catalog.professions.map((profession) => profession.profession_id));
const catalogVersion = catalog.meta?.version ?? null;

const jar = new Map();
const trace = [];
const startedAt = Date.now();

function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function absorbCookies(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const item of raw) {
    const [pair] = item.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function call(step, method, route, { body, headers = {}, expectStatus = [200, 202] } = {}) {
  const started = Date.now();
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(jar.size > 0 ? { cookie: cookieHeader() } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  absorbCookies(response);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  const record = {
    step,
    method,
    route,
    httpStatus: response.status,
    durationMs: Date.now() - started,
    ...(json && typeof json === "object" && "error" in json ? { error: json.error } : {}),
  };
  trace.push(record);
  if (!expectStatus.includes(response.status)) {
    throw new Error(`${step}: HTTP ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { status: response.status, json, headers: response.headers };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const sessionId = randomUUID();
const requestId = randomUUID();
const evidence = {
  environment: base,
  checkedAtUtc: new Date().toISOString(),
  sessionId,
  requestId,
  testProfileId: profileId,
  grade,
  steps: trace,
};

try {
  const health = await call("health", "GET", "/api/health");
  evidence.serverHealth = {
    status: health.json?.status ?? null,
    database: health.json?.database ?? null,
    revision: health.json?.revision ?? null,
    generationWorker: health.json?.generationWorker ?? null,
    aiConfigured: health.json?.aiConfigured ?? null,
    embeddingsConfigured: health.json?.readiness?.embeddingsConfigured ?? null,
    sessionProofEnforced: health.json?.readiness?.sessionProofEnforced ?? null,
  };

  const questionnaire = await call("questions", "GET", `/api/diagnostic/questions?grade=${grade}`);
  const questions = (questionnaire.json?.questionnaire?.blocks ?? []).flatMap((block) => block.questions ?? []);
  const allowed = new Map(questions.map((question) => [question.id, new Set(question.options ?? [])]));

  const student = students.find((item) => item.student_id === profileId);
  if (!student) throw new Error(`Профиль ${profileId} не найден в mock_students_data.json`);
  const answers = Object.entries(student.answers)
    .filter(([questionId]) => allowed.has(questionId))
    .map(([questionId, answer]) => {
      const options = allowed.get(questionId);
      const values = (Array.isArray(answer) ? answer : [answer]).filter((value) => options.has(value));
      return values.length ? { questionId, answer: values } : null;
    })
    .filter(Boolean);
  if (answers.length === 0) throw new Error("Ни один ответ профиля не подошёл к анкете сервера");
  evidence.answersSent = answers.length;

  await call("track_select", "POST", "/api/track/select", {
    body: { trackType: "interests", schoolGrade: grade },
    headers: { "X-Session-ID": sessionId },
  });
  evidence.proofCookieIssued = [...jar.keys()].length > 0;

  await call("diagnostic_submit", "POST", "/api/diagnostic/submit", {
    body: { answers },
    headers: { "X-Session-ID": sessionId },
    expectStatus: [200, 201],
  });

  const latest = await call("diagnostic_latest", "GET", "/api/diagnostic/latest", {
    headers: { "X-Session-ID": sessionId },
    expectStatus: [200, 404],
  });
  evidence.answersStored = latest.status === 200
    ? (latest.json?.answers?.length ?? latest.json?.data?.answers?.length ?? null)
    : null;

  const generateStarted = Date.now();
  const generate = await call("generate", "POST", "/api/recommendations/generate", {
    body: {},
    headers: { "X-Session-ID": sessionId, "Idempotency-Key": requestId },
    expectStatus: [200, 202],
  });
  evidence.generateHttpStatus = generate.status;
  evidence.jobStatus = generate.json?.jobStatus ?? (generate.status === 200 ? "completed" : "pending");

  let final = generate.json;
  let polls = 0;
  while (generate.status === 202 && polls < 60) {
    polls += 1;
    const retryAfterMs = Number(final?.retryAfterMs ?? 2000);
    await sleep(Math.min(Math.max(retryAfterMs, 1000), 10000));
    const job = await call(`job_poll_${polls}`, "GET", `/api/recommendations/jobs/${requestId}`, {
      headers: { "X-Session-ID": sessionId },
      expectStatus: [200, 202, 404],
    });
    if (job.status === 404) break;
    final = job.json;
    evidence.jobStatus = job.json?.jobStatus ?? evidence.jobStatus;
    if (job.json?.jobStatus === "completed" || job.json?.jobStatus === "failed") break;
    if (Date.now() - generateStarted > waitTimeoutMs) break;
  }
  evidence.generationDurationMs = Date.now() - generateStarted;
  evidence.polls = polls;

  const saved = await call("recommendations_get", "GET", "/api/recommendations", {
    headers: { "X-Session-ID": sessionId },
    expectStatus: [200, 404],
  });
  const savedBody = saved.status === 200 ? saved.json : null;

  const hypotheses = (savedBody?.hypotheses ?? final?.hypotheses ?? []).map((item) => ({
    professionId: item.profession_id ?? item.professionId ?? null,
    catalogProfessionId: item.catalogProfessionId ?? item.catalog_profession_id ?? item.profession_id ?? null,
    name: item.name ?? null,
  }));
  const generation = savedBody?.generation ?? final?.generation ?? {};

  evidence.recommendationId = savedBody?.recommendationId ?? final?.recommendationId ?? null;
  evidence.catalogVersion = generation.catalogVersion ?? null;
  evidence.retrievalMode = generation.retrievalMode ?? null;
  evidence.generationMode = generation.mode ?? null;
  evidence.hypothesisCount = hypotheses.length;
  evidence.catalogProfessionIds = hypotheses.map((item) => item.catalogProfessionId);
  evidence.warnings = savedBody?.warnings ?? final?.warnings ?? [];
  evidence.status = savedBody?.status ?? final?.status ?? null;

  const problems = [];
  if (evidence.retrievalMode !== (expectRetrieval ?? "semantic")) problems.push(`retrieval_mode=${evidence.retrievalMode}`);
  if (evidence.catalogVersion !== (catalogVersion ?? "data_freeze_1_json_v1")) {
    problems.push(`catalog_version=${evidence.catalogVersion}`);
  }
  if (!evidence.recommendationId) problems.push("no_recommendation_id");
  if (hypotheses.length === 0) problems.push("empty_hypotheses");
  const unknown = evidence.catalogProfessionIds.filter((id) => id && !catalogIds.has(id));
  if (unknown.length) problems.push(`unknown_profession_ids=${unknown.join(",")}`);
  if (new Set(evidence.catalogProfessionIds).size !== evidence.catalogProfessionIds.length) {
    problems.push("duplicate_professions");
  }
  if (expectGeneration && evidence.generationMode !== expectGeneration) {
    problems.push(`generation_mode=${evidence.generationMode}`);
  }
  if (final?.recommendationId && savedBody?.recommendationId && final.recommendationId !== savedBody.recommendationId) {
    problems.push("recommendation_id_mismatch");
  }

  evidence.problems = problems;
  evidence.verdict = problems.length === 0 ? "PASS" : "FAIL";
  evidence.durationMs = Date.now() - startedAt;

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.appendFileSync(outFile, `${JSON.stringify(evidence)}\n`);
  }
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(problems.length === 0 ? 0 : 1);
} catch (error) {
  evidence.verdict = "FAIL";
  evidence.error = error instanceof Error ? error.message : "unknown";
  evidence.durationMs = Date.now() - startedAt;
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.appendFileSync(outFile, `${JSON.stringify(evidence)}\n`);
  }
  console.error(JSON.stringify(evidence, null, 2));
  process.exit(1);
}
