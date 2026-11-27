import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CatalogUnavailableError,
  loadRuntimeCatalog,
  readCatalogPolicy,
  resetRuntimeCatalogCache,
} from "../lib/runtime-catalog.ts";

test("по умолчанию переход на legacy-каталог запрещён", () => {
  assert.deepEqual(readCatalogPolicy({}), { requireFreeze: true });
  assert.deepEqual(readCatalogPolicy({ REQUIRE_FREEZE_CATALOG: "true" }), { requireFreeze: true });
  assert.deepEqual(readCatalogPolicy({ REQUIRE_FREEZE_CATALOG: "FALSE" }), { requireFreeze: false });
  assert.throws(() => readCatalogPolicy({ REQUIRE_FREEZE_CATALOG: "maybe" }), CatalogUnavailableError);
});

test("при повреждённом Data Freeze каталог не подменяется молча", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-policy-"));
  fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "data/catalog.normalized.json"),
    JSON.stringify({ schema_version: "hybrid_v2", professions: [{ profession_id: "prof_legacy" }] })
  );

  const previous = process.env.REQUIRE_FREEZE_CATALOG;
  try {
    delete process.env.REQUIRE_FREEZE_CATALOG;
    resetRuntimeCatalogCache();
    assert.throws(() => loadRuntimeCatalog(cwd), CatalogUnavailableError);

    // Явный opt-out нужен только для сравнительных экспериментов.
    process.env.REQUIRE_FREEZE_CATALOG = "false";
    resetRuntimeCatalogCache();
    const legacy = loadRuntimeCatalog(cwd);
    assert.equal(legacy.origin, "legacy_normalized");
    assert.equal(legacy.catalog.professions[0]?.profession_id, "prof_legacy");
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_FREEZE_CATALOG;
    else process.env.REQUIRE_FREEZE_CATALOG = previous;
    resetRuntimeCatalogCache();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Data Freeze загружается независимо от режима строгости", () => {
  resetRuntimeCatalogCache();
  const runtime = loadRuntimeCatalog();
  assert.equal(runtime.origin, "data_freeze_1");
  assert.equal(runtime.catalog.professions.length, 152);
  assert.equal(runtime.catalog.version, "data_freeze_1_json_v1");
});
