import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GET as getProfession } from "../app/api/professions/[id]/route.ts";
import { GET as getProfessions } from "../app/api/professions/route.ts";
import { GET as getTrials } from "../app/api/trials/route.ts";
import {
  CatalogUnavailableError,
  adaptFreezeExport,
  loadRuntimeCatalog,
  professionTitle,
  publicProfessionRows,
  resetRuntimeCatalogCache,
} from "../lib/runtime-catalog.ts";

test("runtime catalog is Alice's freeze, with legacy names only as fallback", () => {
  resetRuntimeCatalogCache();
  const runtime = loadRuntimeCatalog();
  assert.equal(runtime.origin, "data_freeze_1");
  assert.equal(runtime.catalog.schema_version, "hybrid_v2");
  assert.equal(runtime.catalog.professions.length, 152);
  assert.equal(runtime.catalog.trials.length, 184);
  assert.equal(runtime.catalog.education_programs.length, 337);

  const professionIds = runtime.catalog.professions.map((profession) => profession.profession_id);
  const trialIds = new Set(runtime.catalog.trials.map((trial) => trial.trial_id));
  const programIds = new Set(runtime.catalog.education_programs.map((program) => program.program_id));
  const skillIds = new Set((runtime.catalog.skills ?? []).map((skill) => skill.skill_id));
  assert.equal(new Set(professionIds).size, professionIds.length);
  assert.equal(trialIds.size, 184);
  assert.equal(programIds.size, 337);

  for (const profession of runtime.catalog.professions) {
    assert.equal(professionIds.filter((id) => id === profession.profession_id).length, 1);
    for (const skill of profession.skills) assert.ok(skillIds.has(skill.skill_id));
    for (const trialId of profession.trial_ids) assert.ok(trialIds.has(trialId));
    for (const programId of profession.program_ids) assert.ok(programIds.has(programId));
    assert.ok(profession.skills.every((skill) => skill.matching_eligible === "yes_provisional"));
  }

  const legacy = JSON.parse(fs.readFileSync(new URL("../data/navigator_full_graph.json", import.meta.url), "utf8")) as {
    professions: Array<{ profession_id: string; name: string }>;
  };
  const freezeIds = new Set(professionIds);
  const absent = legacy.professions.filter((profession) => !freezeIds.has(profession.profession_id));
  assert.deepEqual(absent.map((profession) => profession.profession_id).sort(), ["prof_016", "prof_028", "prof_029"]);
  for (const profession of absent) {
    assert.equal(professionTitle(runtime, profession.profession_id), profession.name);
  }
  const rows = publicProfessionRows(runtime);
  assert.equal(rows.length, 152);
  assert.ok(rows.every((row) => row.id === null && row.profession_id && row.name === row.title));
  assert.equal(adaptFreezeExport({}), null);
});

test("an invalid freeze fails loudly unless the legacy fallback is explicitly allowed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vector-catalog-"));
  fs.mkdirSync(path.join(dir, "data", "export"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", "export", "navigator.json"), "{}");
  fs.writeFileSync(path.join(dir, "data", "catalog.normalized.json"), JSON.stringify({
    schema_version: "hybrid_v2",
    professions: [{ profession_id: "prof_legacy", name: "Старая профессия" }],
  }));
  fs.writeFileSync(path.join(dir, "data", "navigator_full_graph.json"), JSON.stringify({
    professions: [{ profession_id: "prof_016", name: "Лаборант" }],
  }));
  const previous = process.env.REQUIRE_FREEZE_CATALOG;
  try {
    // Без утверждённого каталога сервис не должен молча отдавать старые профессии.
    delete process.env.REQUIRE_FREEZE_CATALOG;
    resetRuntimeCatalogCache();
    assert.throws(() => loadRuntimeCatalog(dir), CatalogUnavailableError);

    process.env.REQUIRE_FREEZE_CATALOG = "false";
    resetRuntimeCatalogCache();
    const runtime = loadRuntimeCatalog(dir);
    assert.equal(runtime.origin, "legacy_normalized");
    assert.equal(runtime.catalog.professions[0]?.profession_id, "prof_legacy");
    assert.equal(professionTitle(runtime, "prof_016"), "Лаборант");
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_FREEZE_CATALOG;
    else process.env.REQUIRE_FREEZE_CATALOG = previous;
    resetRuntimeCatalogCache();
  }
});

test("GET /api/professions returns the freeze when PostgreSQL is unavailable", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  resetRuntimeCatalogCache();
  try {
    const response = await getProfessions();
    const body = await response.json() as { count: number; source: string; data: Array<{ profession_id: string; id: string | null }> };
    assert.equal(response.status, 200);
    assert.equal(body.source, "data_freeze_1");
    assert.equal(body.count, 152);
    assert.equal(body.data.length, 152);
    assert.equal(new Set(body.data.map((row) => row.profession_id)).size, 152);
    assert.ok(body.data.every((row) => row.id === null));
    const sampleId = body.data[0].profession_id;
    const detail = await getProfession(new NextRequest("http://localhost/api/professions/" + sampleId), {
      params: Promise.resolve({ id: sampleId }),
    });
    const card = await detail.json() as { data: { external_id: string; source: string; education_programs: unknown[]; trials: unknown[] } };
    assert.equal(detail.status, 200);
    assert.equal(card.data.external_id, sampleId);
    assert.equal(card.data.source, "data_freeze_1");
    assert.ok(Array.isArray(card.data.education_programs));
    assert.ok(Array.isArray(card.data.trials));

    const trials = await getTrials(new NextRequest("http://localhost/api/trials?limit=100"));
    const trialBody = await trials.json() as { source: string; count: number; data: Array<{ trial_id: string }> };
    assert.equal(trials.status, 200);
    assert.equal(trialBody.source, "data_freeze_1");
    assert.equal(trialBody.count, 100);
    assert.equal(new Set(trialBody.data.map((trial) => trial.trial_id)).size, 100);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
