// Run from backend with --experimental-strip-types --import ./tests/register-app-alias.mjs.
import assert from "node:assert/strict";
import { prepareSofiInput } from "../lib/sofi-adapter.ts";
import { runSofiPipeline } from "../lib/sofi-pipeline.ts";
import { loadRuntimeCatalog } from "../lib/runtime-catalog.ts";

const expected = process.argv.includes("--expect-lexical") ? "lexical" : "semantic";
const prepared = prepareSofiInput({
  profile: { schoolGrade: 8, municipality: "Екатеринбург" },
  diagnosticAnswers: [{ questionId: "bilet_q1", answer: "Чтение технических чертежей и схем" }],
});
const { generation, warnings } = await runSofiPipeline({ prepared, professions: [] });
console.log(JSON.stringify({ retrievalMode: generation?.retrievalMode, catalogVersion: generation?.catalogVersion, warnings }));
assert.equal(generation?.catalogVersion, loadRuntimeCatalog().catalog.version);
assert.equal(generation?.retrievalMode, expected);
