import { randomUUID } from "node:crypto";
import { readEmbeddingBatch } from "../lib/ai/embedding-response.ts";
import { gatewayEndpoint, readEmbeddingsGateway } from "../lib/ai/gateway-env.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FREEZE_EMBEDDING_DIMENSIONS, buildFreezeIndex, describeFreezeChunks, mockVector, validateFreezeEmbeddingIndex } from "../lib/ai/freeze-embedding.ts";
import { loadRuntimeCatalog } from "../lib/runtime-catalog.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = loadRuntimeCatalog(root);
if (runtime.origin !== "data_freeze_1") throw new Error("A valid freeze export is required.");
const catalog = runtime.catalog;
const described = describeFreezeChunks(catalog);
const dryRun = process.argv.includes("--dry-run");
const apply = process.argv.includes("--apply");
const mockFlag = process.argv.indexOf("--mock-out");
const mockOut = mockFlag >= 0 ? process.argv[mockFlag + 1] : "";

if (process.argv.includes("--check")) {
  const index = JSON.parse(await fs.readFile(path.join(root, "data/catalog.index.json"), "utf8"));
  const problems = validateFreezeEmbeddingIndex(index, catalog);
  const expected = new Set(catalog.professions.map((profession) => profession.profession_id));
  const indexed = new Set((Array.isArray(index?.entries) ? index.entries : [])
    .filter((entry) => entry?.type === "profession_core")
    .map((entry) => entry.metadata?.profession_id));
  const missing = [...expected].filter((id) => !indexed.has(id));
  console.log(JSON.stringify({
    accepted: problems.length === 0, catalogVersion: catalog.version, indexVersion: index?.catalog_version,
    model: index?.embedding_model ?? index?.model, dimensions: index?.dimensions,
    catalogProfessions: expected.size, overlappingProfessionIds: expected.size - missing.length,
    missingProfessionIds: missing, extraProfessionIds: [...indexed].filter((id) => !expected.has(id)),
    expectedChunks: described.chunkCount, indexEntries: index?.entries?.length, problems,
  }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

if (!dryRun && !apply && !mockOut) {
  console.error("Refusing to call the embedding gateway. Use --dry-run, --mock-out <file>, or --apply.");
  process.exit(2);
}

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    origin: runtime.origin,
    catalogVersion: described.catalogVersion,
    professionCount: described.professionCount,
    chunkCount: described.chunkCount,
    indexedProfessions: described.indexedProfessions,
    missingProfessions: described.missingProfessionIds.length,
    model: "EmbeddingsGigaR",
    dimensions: FREEZE_EMBEDDING_DIMENSIONS,
    network: false,
  }));
  process.exit(0);
}

const chunks = catalog.chunks ?? [];
let vectors;
let model;
let source;
let dimensions;
if (mockOut) {
  dimensions = 8;
  model = "mock-deterministic";
  source = "mock";
  vectors = chunks.map((chunk) => mockVector(chunk.text, dimensions));
} else {
  const settings = readEmbeddingsGateway(process.env);
  if (settings?.model !== "EmbeddingsGigaR") {
    throw new Error("Refusing --apply without the configured EmbeddingsGigaR gateway.");
  }
  model = settings.model;
  dimensions = FREEZE_EMBEDDING_DIMENSIONS;
  source = "provider";
  vectors = [];
  for (let offset = 0; offset < chunks.length; offset += 16) {
    const batch = chunks.slice(offset, offset + 16);
    const response = await fetch(gatewayEndpoint(settings.baseUrl, "embeddings"), {
      method: "POST",
      headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: batch.map((chunk) => chunk.text) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Embeddings API HTTP ${response.status}`);
    const result = await response.json();
    vectors.push(...readEmbeddingBatch(result, model, batch.length, dimensions));
  }
}

const index = buildFreezeIndex({
  catalog,
  origin: runtime.origin,
  model,
  dimensions,
  vectorSource: source,
  vectors,
});
const problems = validateFreezeEmbeddingIndex(index, catalog).filter((problem) =>
  source !== "mock" || problem !== "mock vectors are not provider embeddings"
);
if (problems.length) throw new Error(`Index validation failed: ${problems.join(", ")}`);

const target = path.resolve(root, mockOut || "data/catalog.index.json");
const relativeTarget = path.relative(root, target);
if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
  throw new Error("Index output must stay inside the backend directory.");
}
if (source === "mock" && target.endsWith(`${path.sep}data${path.sep}catalog.index.json`)) {
  throw new Error("Refusing to replace the provider index with mock vectors.");
}
const temporary = `${target}.${randomUUID()}.tmp`;
try {
  await fs.writeFile(temporary, JSON.stringify(index), { flag: "wx" });
  await fs.rename(temporary, target);
} finally {
  await fs.rm(temporary, { force: true });
}
console.log(JSON.stringify({
  wrote: path.relative(root, target),
  vectorSource: source,
  professionCount: index.profession_count,
  chunkCount: index.chunk_count,
  dimensions: index.dimensions,
  model: index.embedding_model,
}));
