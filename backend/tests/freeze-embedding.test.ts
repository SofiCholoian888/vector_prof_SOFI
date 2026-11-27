import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

import { buildFreezeIndex, describeFreezeChunks, mockVector, validateFreezeEmbeddingIndex } from "../lib/ai/freeze-embedding.ts";
import { loadRuntimeCatalog, resetRuntimeCatalogCache } from "../lib/runtime-catalog.ts";

test("freeze embedding builder describes 152 professions and keeps mock vectors out of the provider index", () => {
  resetRuntimeCatalogCache();
  const runtime = loadRuntimeCatalog();
  const described = describeFreezeChunks(runtime.catalog);
  assert.equal(described.professionCount, 152);
  assert.equal(described.indexedProfessions, 152);
  assert.deepEqual(described.missingProfessionIds, []);
  const mock = buildFreezeIndex({
    catalog: runtime.catalog,
    origin: runtime.origin,
    model: "mock-deterministic",
    dimensions: 8,
    vectorSource: "mock",
    vectors: runtime.catalog.chunks.map((chunk) => mockVector(chunk.text, 8)),
  });
  assert.equal(mock.vector_source, "mock");
  assert.ok(validateFreezeEmbeddingIndex(mock, runtime.catalog).includes("mock vectors are not provider embeddings"));
  assert.deepEqual(mockVector("same", 4), mockVector("same", 4));
  assert.notDeepEqual(mockVector("same", 4), mockVector("other", 4));

  const indexPath = new URL("../data/catalog.index.json", import.meta.url);
  const before = fs.statSync(indexPath).mtimeMs;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/build-embedding-index.mjs", "--dry-run"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { professionCount: number; network: boolean; chunkCount: number };
  assert.equal(report.professionCount, 152);
  assert.equal(report.network, false);
  assert.ok(report.chunkCount >= 152);
  assert.equal(fs.statSync(indexPath).mtimeMs, before);
});

test("embedding responses preserve input identity and reject invalid batches", async () => {
  const { readEmbeddingBatch } = await import("../lib/ai/embedding-response.ts");
  const rows = [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }];
  assert.deepEqual(readEmbeddingBatch({ data: rows }, "model", 2, 2), [[1, 0], [0, 1]]);
  assert.throws(() => readEmbeddingBatch({ data: [rows[0], rows[0]] }, "model", 2, 2));
  assert.throws(() => readEmbeddingBatch({ data: rows, model: "other" }, "model", 2, 2));
  assert.throws(() => readEmbeddingBatch({ data: rows }, "model", 2, 3));
  assert.throws(() => readEmbeddingBatch({ data: [{ index: 0, embedding: [0, 0] }] }, "model", 1, 2));
});

test("profession chunks include every eligible skill and its scope from the export", () => {
  const source = JSON.parse(fs.readFileSync("data/export/navigator.json", "utf8")) as {
    professions: Array<{ profession_id: string; skills: Array<{
      name: string; matching_eligible: string; applicability_condition: string | null;
    }> }>;
  };
  const catalog = loadRuntimeCatalog().catalog;
  for (const profession of source.professions) {
    const chunk = catalog.chunks.find((item) => item.metadata.profession_id === profession.profession_id);
    assert.ok(chunk);
    const allowed = profession.skills.filter((skill) => skill.matching_eligible === "yes_provisional");
    const normalized = catalog.professions.find((item) => item.profession_id === profession.profession_id);
    assert.deepEqual(normalized?.skills.map((skill) => skill.name).sort(), allowed.map((skill) => skill.name).sort());
    for (const skill of allowed) {
      assert.ok(chunk.text.includes(skill.name));
      if (skill.applicability_condition) assert.ok(chunk.text.includes(skill.applicability_condition));
    }
  }
});
