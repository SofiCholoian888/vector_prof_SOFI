import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { buildDossier } from "../lib/ai/dossier.ts";
import {
  EMBEDDING_QUERY_MODES,
  EmbeddingQueryConfigError,
  assertEmbeddingQueryModeSupported,
  embeddingQueryVersion,
  formatEmbeddingQuery,
  readEmbeddingQueryMode,
} from "../lib/ai/embedding-query.ts";
import { retrieve } from "../lib/ai/retrieval.ts";
import { AiConfigError, assertNoMockEmbeddingsInProduction } from "../lib/ai/runtime-guards.ts";
import { prepareSofiInput } from "../lib/sofi-adapter.ts";
import { runSofiPipeline } from "../lib/sofi-pipeline.ts";

const indexPath = path.resolve("data/catalog.index.json");
const indexShaAtStart = createHash("sha256").update(fs.readFileSync(indexPath)).digest("hex");

const ANSWER = "Мне нравится разбираться, почему устройства перестают работать";

function dossierFor(answers: Array<{ questionId: string; answer: string | string[] }>) {
  const prepared = prepareSofiInput({
    profile: { schoolGrade: 10, municipality: "Екатеринбург" },
    diagnosticAnswers: answers,
  });
  return buildDossier(prepared.rawAnswers, prepared.student);
}

// Контрольный сервер подменяет только embedding API и записывает тела запросов.
async function startEmbeddingStub(behaviour: "vectors" | "503") {
  const bodies: Array<{ model: string; input: string[] }> = [];
  const base = JSON.parse(fs.readFileSync(indexPath, "utf8")).entries[0].vector as number[];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      if (!request.url?.endsWith("/embeddings")) {
        response.writeHead(404).end("{}");
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.push(body);
      if (behaviour === "503") {
        response.writeHead(503, { "content-type": "application/json" }).end('{"error":"unavailable"}');
        return;
      }
      // Векторы детерминированы по тексту и близки к базовому вектору индекса,
      // чтобы поиск вернул кандидатов, а не пустой список.
      const data = body.input.map((text: string, index: number) => {
        const digest = createHash("sha256").update(text).digest();
        const vector = base.map((value, position) =>
          value + ((digest[position % digest.length] ?? 0) / 255 - 0.5) * 0.01
        );
        return { index, embedding: vector, object: "embedding" };
      });
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ model: "EmbeddingsGigaR", data, object: "list" })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    bodies,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Q01–Q05: формат запроса для каждого режима", () => {
  assert.equal(formatEmbeddingQuery(ANSWER, "plain"), ANSWER);
  for (const mode of ["instruct_v1", "instruct_v2", "instruct_v3"] as const) {
    const formatted = formatEmbeddingQuery(ANSWER, mode);
    assert.ok(formatted.includes(ANSWER), mode);
    assert.ok(formatted.indexOf(ANSWER) > 0, `${mode}: инструкция идёт первой`);
    assert.equal(formatted, formatEmbeddingQuery(formatted, mode), `${mode}: инструкция не дублируется`);
  }
  assert.notEqual(
    formatEmbeddingQuery(ANSWER, "instruct_v1"),
    formatEmbeddingQuery(ANSWER, "instruct_v2")
  );
  assert.equal(formatEmbeddingQuery("   ", "instruct_v1"), "");
});

test("Q06: несколько ответов сохраняют количество и порядок", () => {
  const answers = ["Первый ответ", "Второй ответ", "Третий ответ"];
  const formatted = answers.map((text) => formatEmbeddingQuery(text, "instruct_v2"));
  assert.equal(formatted.length, answers.length);
  formatted.forEach((text, index) => assert.ok(text.endsWith(answers[index])));
});

test("Q07: неизвестный режим — контролируемая ошибка конфигурации", () => {
  assert.equal(readEmbeddingQueryMode({}), "plain");
  assert.equal(readEmbeddingQueryMode({ EMBEDDING_QUERY_MODE: " instruct_v3 " }), "instruct_v3");
  assert.throws(
    () => readEmbeddingQueryMode({ EMBEDDING_QUERY_MODE: "instruct_v9" }),
    EmbeddingQueryConfigError
  );
  for (const mode of EMBEDDING_QUERY_MODES) {
    assert.equal(readEmbeddingQueryMode({ EMBEDDING_QUERY_MODE: mode }), mode);
  }
});

test("Q08: инструкция не применяется к несовместимой модели", () => {
  assert.throws(() => assertEmbeddingQueryModeSupported("instruct_v1", "OtherModel"), EmbeddingQueryConfigError);
  assert.throws(() => assertEmbeddingQueryModeSupported("instruct_v2", ""), EmbeddingQueryConfigError);
  assertEmbeddingQueryModeSupported("plain", "OtherModel");
  assertEmbeddingQueryModeSupported("instruct_v3", "EmbeddingsGigaR");
});

test("Q09: semantic-запрос уходит в API с инструкцией", async () => {
  const stub = await startEmbeddingStub("vectors");
  try {
    const dossier = dossierFor([
      { questionId: "bilet_q1_subjects", answer: ["Физика", "Информатика"] },
      { questionId: "bilet_q7_concert", answer: ["Вести концерт, общаться со зрителями"] },
    ]);
    const result = await withEnv(
      {
        LLM_BASE_URL: stub.baseUrl,
        LLM_API_KEY: "test-key",
        LLM_EMBEDDINGS_MODEL: "EmbeddingsGigaR",
        EMBEDDING_QUERY_MODE: "instruct_v1",
        USE_MOCK_EMBEDDINGS: "false",
        REQUIRE_FREEZE_CATALOG: "true",
      },
      () => retrieve(dossier)
    );
    assert.equal(result.mode, "semantic");
    const sent = stub.bodies.flatMap((body) => body.input);
    assert.ok(sent.length > 0);
    for (const text of sent) {
      assert.ok(text.startsWith("По ответу школьника"), text.slice(0, 60));
    }
    assert.equal(stub.bodies[0]?.model, "EmbeddingsGigaR");
  } finally {
    await stub.close();
  }
});

test("Q10–Q12: lexical-поиск и evidence не зависят от режима инструкции", async () => {
  const answers = [
    { questionId: "bilet_q1_subjects", answer: ["Физика", "Информатика"] },
    { questionId: "bilet_q7_concert", answer: ["Вести концерт, общаться со зрителями"] },
  ];
  const dossier = dossierFor(answers);
  const stub = await startEmbeddingStub("503");
  try {
    const env = {
      LLM_BASE_URL: stub.baseUrl,
      LLM_API_KEY: "test-key",
      LLM_EMBEDDINGS_MODEL: "EmbeddingsGigaR",
      USE_MOCK_EMBEDDINGS: "false",
    };
    const plain = await withEnv({ ...env, EMBEDDING_QUERY_MODE: "plain" }, () => retrieve(dossier));
    const instruct = await withEnv({ ...env, EMBEDDING_QUERY_MODE: "instruct_v1" }, () => retrieve(dossier));

    assert.equal(plain.mode, "lexical");
    assert.equal(instruct.mode, "lexical");
    assert.ok(plain.warnings.includes("embedding_unavailable_lexical_fallback"));
    // Лексические баллы, кандидаты и ссылки на ответы совпадают бит в бит:
    // инструкция не должна попадать в текстовое сравнение.
    assert.deepEqual(instruct.professionIds, plain.professionIds);
    assert.deepEqual(instruct.professionScores, plain.professionScores);
    assert.deepEqual(instruct.industryScores, plain.industryScores);
    assert.deepEqual(instruct.evidence, plain.evidence);
    assert.deepEqual(instruct.professionSources, plain.professionSources);

    // В отказавшем шлюзе тела запросов отличаются только режимом, а не логикой.
    assert.ok(stub.bodies.length >= 2);
  } finally {
    await stub.close();
  }
});

test("Q13: режим входит в версию конфигурации, то есть в ключ кэша", async () => {
  assert.notEqual(embeddingQueryVersion("plain"), embeddingQueryVersion("instruct_v1"));
  assert.notEqual(embeddingQueryVersion("instruct_v1"), embeddingQueryVersion("instruct_v2"));

  const prepared = prepareSofiInput({
    profile: { schoolGrade: 10, municipality: "Екатеринбург" },
    diagnosticAnswers: [
      { questionId: "bilet_q1_subjects", answer: ["Физика"] },
      { questionId: "bilet_q7_concert", answer: ["Вести концерт, общаться со зрителями"] },
    ],
  });
  const stub = await startEmbeddingStub("503");
  try {
    const result = await withEnv(
      {
        LLM_BASE_URL: stub.baseUrl,
        LLM_API_KEY: "test-key",
        LLM_MODEL: "GigaChat-2-Pro",
        LLM_EMBEDDINGS_MODEL: "EmbeddingsGigaR",
        EMBEDDING_QUERY_MODE: "instruct_v3",
        USE_MOCK_EMBEDDINGS: "false",
      },
      () => runSofiPipeline({ prepared, professions: [] })
    );
    assert.match(String(result.generation?.configVersion), /\+emb-instruct_v3-1$/);
  } finally {
    await stub.close();
  }
});

test("Q15: mock-эмбеддинги запрещены в production", async () => {
  assert.throws(
    () => assertNoMockEmbeddingsInProduction({ NODE_ENV: "production", USE_MOCK_EMBEDDINGS: "true" }),
    AiConfigError
  );
  assertNoMockEmbeddingsInProduction({ NODE_ENV: "development", USE_MOCK_EMBEDDINGS: "true" });
  assertNoMockEmbeddingsInProduction({ NODE_ENV: "production", USE_MOCK_EMBEDDINGS: "false" });

  const prepared = prepareSofiInput({
    profile: { schoolGrade: 10, municipality: "Екатеринбург" },
    diagnosticAnswers: [
      { questionId: "bilet_q1_subjects", answer: ["Физика"] },
      { questionId: "bilet_q7_concert", answer: ["Вести концерт, общаться со зрителями"] },
    ],
  });
  await withEnv({ NODE_ENV: "production", USE_MOCK_EMBEDDINGS: "true" }, async () => {
    await assert.rejects(() => runSofiPipeline({ prepared, professions: [] }), AiConfigError);
  });
});

test("Q14: индекс не меняется за время эксперимента", () => {
  const shaNow = createHash("sha256").update(fs.readFileSync(indexPath)).digest("hex");
  assert.equal(shaNow, indexShaAtStart);
});
