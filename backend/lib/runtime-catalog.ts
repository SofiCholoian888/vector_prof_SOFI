import fs from "node:fs";
import path from "node:path";

import type { NormalizedCatalog, NormalizedProfession } from "./ai/catalog.ts";

/** Alice's denormalized export. Excel remains the authoring source; this JSON is what runtime reads. */
export const FREEZE_CATALOG_PATH = "data/export/navigator.json";
export const LEGACY_NORMALIZED_PATH = "data/catalog.normalized.json";
export const LEGACY_GRAPH_PATH = "data/navigator_full_graph.json";

export type CatalogOrigin = "data_freeze_1" | "legacy_normalized";

export type RuntimeCatalog = {
  origin: CatalogOrigin;
  catalog: NormalizedCatalog;
  /** Names from the previous graph, used only to display ids the freeze no longer contains. */
  legacyNames: Map<string, string>;
};

type Row = Record<string, unknown>;

function row(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): Row[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const record = row(item);
    return record ? [record] : [];
  }) : [];
}

function ids(rows: Row[], key: string): string[] {
  return rows.map((item) => text(item[key])).filter(Boolean);
}

function fitLevel(value: unknown): "прямая" | "смежная" | "знакомство" | null {
  if (value === "прямая" || value === "смежная" || value === "знакомство") return value;
  if (value === "direct") return "прямая";
  if (value === "related") return "смежная";
  if (value === "exploratory") return "знакомство";
  return null;
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

/** Accept the freeze only when its own counts and references hold. Otherwise the caller uses the legacy catalog. */
export function adaptFreezeExport(data: unknown): NormalizedCatalog | null {
  const root = row(data);
  if (!root) return null;
  const meta = row(root.meta);
  const counts = row(meta?.counts);
  const industries = list(root.industries);
  const skills = list(root.skills);
  const organizations = list(root.organizations);
  const professions = list(root.professions);
  const programs = list(root.education_programs);
  const trials = list(root.trials);
  if (!meta || !counts || !professions.length) return null;
  const expected: Array<[Row[], string, unknown]> = [
    [industries, "industry_id", counts.industry],
    [skills, "skill_id", counts.skill],
    [organizations, "organization_id", counts.organization],
    [professions, "profession_id", counts.profession],
    [programs, "program_id", counts.education_program],
    [trials, "trial_id", counts.trial],
  ];
  for (const [rows, key, declared] of expected) {
    const values = ids(rows, key);
    if (!unique(values) || values.length !== rows.length) return null;
    if (declared !== undefined && declared !== rows.length) return null;
  }
  if (professions.length !== 152 || trials.length !== 184 || programs.length !== 337) return null;

  const industryIds = new Set(ids(industries, "industry_id"));
  const skillIds = new Set(ids(skills, "skill_id"));
  const programIds = new Set(ids(programs, "program_id"));
  const trialIds = new Set(ids(trials, "trial_id"));
  const trialsById = new Map(trials.map((trial) => [text(trial.trial_id), trial]));
  const programsById = new Map(programs.map((program) => [text(program.program_id), program]));
  const trialLinks = new Map<string, Array<{ profession_id: string; fit_level: ReturnType<typeof fitLevel> }>>();

  const normalizedProfessions: NormalizedProfession[] = [];
  for (const profession of professions) {
    const professionId = text(profession.profession_id);
    const industryId = text(profession.industry_id);
    if (!industryIds.has(industryId)) return null;
    const eligibleSkills = list(profession.skills).filter((skill) => {
      const id = text(skill.skill_id);
      if (!skillIds.has(id)) return false;
      const eligible = skill.matching_eligible;
      return eligible === "yes_provisional";
    });
    if (list(profession.skills).some((skill) => text(skill.skill_id) && !skillIds.has(text(skill.skill_id)))) return null;

    const professionPrograms = list(profession.programs).flatMap((link) => {
      const id = text(link.program_id);
      const full = programsById.get(id);
      if (!full) return [];
      return [{
        ...full,
        program_id: id,
        name: text(full.name || link.name),
        fit_level: fitLevel(link.fit_level),
        professions: [{ profession_id: professionId, fit_level: fitLevel(link.fit_level) ?? undefined }],
      }];
    });
    if (list(profession.programs).some((link) => !programIds.has(text(link.program_id)))) return null;

    const professionTrials = list(profession.trials).flatMap((link) => {
      const id = text(link.trial_id);
      const full = trialsById.get(id);
      if (!full) return [];
      const fit = fitLevel(link.connection_type) ?? fitLevel(link.fit_level);
      const links = trialLinks.get(id) ?? [];
      links.push({ profession_id: professionId, fit_level: fit });
      trialLinks.set(id, links);
      if (link.availability_status === "прошло" || full.availability_status === "прошло") return [];
      return [{
        ...full,
        trial_id: id,
        title: text(full.title || link.title),
        fit_level: fit,
        trial_type: text(full.activity_type || link.activity_type) || null,
        professions: [{ profession_id: professionId, fit_level: fit ?? undefined }],
      }];
    });
    if (list(profession.trials).some((link) => !trialIds.has(text(link.trial_id)))) return null;

    const market = row(profession.current_market_state) ?? {};
    const rankedSkills = eligibleSkills
      .slice()
      .sort((left, right) => (num(right.importance) ?? 0) - (num(left.importance) ?? 0));
    normalizedProfessions.push({
      profession_id: professionId,
      name: text(profession.name),
      industry_id: industryId,
      industry_name: text(profession.industry_name) || text(industries.find((item) => text(item.industry_id) === industryId)?.name),
      what_kid_does: text(profession.what_does_kid),
      description_1_4: text(profession.description_1_4),
      description_5_8: text(profession.description_5_8),
      description_9_11: text(profession.description_9_11),
      riasec_profile: row(profession.riasec) as Record<string, number> | null,
      key_skills: rankedSkills.slice(0, 4).map((skill) => text(skill.name)).filter(Boolean),
      skills: rankedSkills as NormalizedProfession["skills"],
      trial_ids: professionTrials.map((trial) => text(trial.trial_id)),
      program_ids: professionPrograms.map((program) => text(program.program_id)),
      trials: professionTrials as NormalizedProfession["trials"],
      programs: professionPrograms as NormalizedProfession["programs"],
      salary_median_rub: num(market.salary_median_region) ?? num(market.salary_median_rub),
      demand_level: text(market.demand_level_region) || null,
      vacancies_count: num(market.vacancies_count),
      source_id: null,
    });
  }

  const normalizedIndustries = industries.map((industry) => ({
    id: text(industry.industry_id),
    slug: text(industry.industry_id),
    name: text(industry.name),
    description_kid: text(industry.description_kid) || null,
    regional_importance: text(industry.regional_importance) || null,
  }));
  const normalizedTrials = trials.map((trial) => ({
    ...trial,
    trial_id: text(trial.trial_id),
    title: text(trial.title),
    trial_type: text(trial.activity_type) || null,
    professions: trialLinks.get(text(trial.trial_id)) ?? [],
  }));
  const chunks = [
    ...normalizedProfessions.map((profession) => ({
      type: "profession_core" as const,
      text: [
        profession.name, profession.industry_name, profession.what_kid_does,
        profession.description_1_4, profession.description_5_8, profession.description_9_11,
        ...profession.skills.map((skill) =>
          [skill.name, skill.applicability_condition].filter(Boolean).join(" — ")
        ),
      ].filter(Boolean).join(". "),
      metadata: { profession_id: profession.profession_id, industry_id: profession.industry_id, trial_ids: profession.trial_ids, program_ids: profession.program_ids },
    })),
    ...normalizedIndustries.map((industry) => ({
      type: "industry_card" as const,
      text: industry.name,
      metadata: { industry_id: industry.id },
    })),
  ];

  return {
    version: text(meta.version) || "data_freeze_1",
    schema_version: "hybrid_v2",
    built_at: text(meta.export_date) || "2026-11-23",
    industries: normalizedIndustries,
    professions: normalizedProfessions,
    skills: skills as NormalizedCatalog["skills"],
    organizations: organizations as NormalizedCatalog["organizations"],
    education_programs: programs as NormalizedCatalog["education_programs"],
    trials: normalizedTrials as NormalizedCatalog["trials"],
    source_registry: [],
    chunks,
  };
}

function readJson(cwd: string, relativePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(cwd, relativePath), "utf8")) as unknown;
  } catch {
    return null;
  }
}

function legacyNames(cwd: string): Map<string, string> {
  const graph = row(readJson(cwd, LEGACY_GRAPH_PATH));
  const names = new Map<string, string>();
  for (const profession of list(graph?.professions)) {
    const id = text(profession.profession_id);
    const name = text(profession.name);
    if (id && name) names.set(id, name);
  }
  return names;
}

let cached: { cwd: string; value: RuntimeCatalog } | null = null;

export function loadRuntimeCatalog(cwd = process.cwd()): RuntimeCatalog {
  if (cached?.cwd === cwd) return cached.value;
  const names = legacyNames(cwd);
  const freeze = adaptFreezeExport(readJson(cwd, FREEZE_CATALOG_PATH));
  if (freeze) {
    cached = { cwd, value: { origin: "data_freeze_1", catalog: freeze, legacyNames: names } };
    return cached.value;
  }
  const legacy = row(readJson(cwd, LEGACY_NORMALIZED_PATH));
  if (!legacy || !Array.isArray(legacy.professions)) {
    throw new Error("Neither the freeze catalog nor the legacy normalized catalog could be read");
  }
  cached = {
    cwd,
    value: { origin: "legacy_normalized", catalog: legacy as unknown as NormalizedCatalog, legacyNames: names },
  };
  return cached.value;
}

export function resetRuntimeCatalogCache() {
  cached = null;
}

export function professionTitle(catalog: RuntimeCatalog, professionId: string): string | null {
  const current = catalog.catalog.professions.find((profession) => profession.profession_id === professionId);
  if (current?.name) return current.name;
  return catalog.legacyNames.get(professionId) ?? null;
}

export function publicProfessionRows(catalog: RuntimeCatalog) {
  return catalog.catalog.professions.map((profession) => ({
    profession_id: profession.profession_id,
    external_id: profession.profession_id,
    id: null as string | null,
    name: profession.name,
    title: profession.name,
    description: profession.what_kid_does,
    industry_name: profession.industry_name,
    riasec: profession.riasec_profile,
    demand_level_region: profession.demand_level,
    salary_median_region: profession.salary_median_rub,
    vacancies_count: profession.vacancies_count,
    program_count: profession.program_ids.length,
    trial_count: profession.trial_ids.length,
  }));
}
