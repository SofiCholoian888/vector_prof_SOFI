import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assessEmbeddingIndex,
  embeddingStartupPlan,
} from "../lib/ai/index-contract.ts";
import { validateFreezeEmbeddingIndex } from "../lib/ai/freeze-embedding.ts";
import { loadRuntimeCatalog } from "../lib/runtime-catalog.ts";

const index = JSON.parse(fs.readFileSync(new URL("../data/catalog.index.json", import.meta.url), "utf8"));

test("shipped provider index covers the exact runtime freeze", () => {
  const runtime = loadRuntimeCatalog();
  assert.equal(runtime.origin, "data_freeze_1");
  assert.equal(runtime.catalog.professions.length, 152);
  assert.deepEqual(validateFreezeEmbeddingIndex(index, runtime.catalog), []);
  const swapped = { ...index.entries[0], chunkId: index.entries[1].chunkId };
  assert.ok(validateFreezeEmbeddingIndex({ ...index, entries: [swapped, ...index.entries.slice(1)] }, runtime.catalog)
    .includes("chunk identity or content mismatch"));
});

test("stale, mock, and unconfigured freeze indexes stay lexical", () => {
  const runtime = loadRuntimeCatalog();
  const decision = assessEmbeddingIndex({
    index: { ...index, catalog_version: "old" },
    catalogVersion: runtime.catalog.version,
    chunkCount: runtime.catalog.chunks.length,
    configuredModel: "EmbeddingsGigaR",
  });
  assert.equal(decision.action, "rebuild");
  assert.equal(embeddingStartupPlan({ origin: "data_freeze_1", decision }), "incomplete-lexical");
  assert.equal(embeddingStartupPlan({
    origin: "data_freeze_1",
    decision: { action: "refuse", reason: "model unset" },
  }), "incomplete-lexical");
  assert.equal(embeddingStartupPlan({ origin: "legacy_normalized", decision }), "rebuild-legacy");
  assert.equal(embeddingStartupPlan({
    origin: "data_freeze_1",
    decision: { action: "use", model: "EmbeddingsGigaR", field: "embedding_model", entries: 1, dimensions: 2560, reason: "match" },
    vectorSource: "mock",
    professionCount: 152,
  }), "incomplete-lexical");
  assert.equal(embeddingStartupPlan({
    origin: "data_freeze_1",
    decision: { action: "use", model: "EmbeddingsGigaR", field: "embedding_model", entries: 1, dimensions: 2560, reason: "match" },
    vectorSource: "provider",
    professionCount: 152,
  }), "use");
});

test("SOFI reports actual retrieval mode for a working batch and for a gateway outage", async (t) => {
  const { createServer } = await import("node:http");
  const { prepareSofiInput } = await import("../lib/sofi-adapter.ts");
  const { runSofiPipeline } = await import("../lib/sofi-pipeline.ts");
  const vector = index.entries[0].vector;
  let outage = false;
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    if (outage) {
      res.writeHead(503).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const { input, model } = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model, data: input.map((_: string, index: number) => ({ index, embedding: vector })).reverse() }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const settings = {
    LLM_BASE_URL: `http://127.0.0.1:${address.port}`, LLM_API_KEY: "fixture",
    LLM_EMBEDDINGS_MODEL: "EmbeddingsGigaR", USE_MOCK_EMBEDDINGS: "false",
  };
  for (const [key, value] of Object.entries(settings)) {
    const before = process.env[key];
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
    process.env[key] = value;
  }
  const prepared = prepareSofiInput({
    profile: { schoolGrade: 8, municipality: "Екатеринбург" },
    diagnosticAnswers: [{ questionId: "bilet_q1", answer: "Чтение технических чертежей и схем" }],
  });
  const input = { prepared, professions: [] };
  assert.equal((await runSofiPipeline(input)).generation?.retrievalMode, "semantic");
  outage = true;
  const degraded = await runSofiPipeline(input);
  assert.equal(degraded.generation?.retrievalMode, "lexical");
  assert.ok(degraded.warnings?.includes("embedding_unavailable_lexical_fallback"));
  assert.equal(calls, 2);
});
