// Проверка «смешанных» профилей: если интересы относятся к двум разным
// отраслям, выдача не должна схлопываться в одну.
//
// Запуск из backend (нужен доступ к embedding API):
//   node --experimental-strip-types --import ./tests/register-app-alias.mjs \
//     scripts/hypothesis-audit/mixed-profile-check.mjs [--out=...json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDossier } from "../../lib/ai/dossier.ts";
import { buildFallbackResponse } from "../../lib/ai/fallback.ts";
import { retrieve } from "../../lib/ai/retrieval.ts";
import { prepareSofiInput } from "../../lib/sofi-adapter.ts";
import { loadRuntimeCatalog } from "../../lib/runtime-catalog.ts";
import { isTrialEligibleForGrade } from "../../lib/ai/age.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map(
  process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);
const outFile = args.get("out") ? path.resolve(root, args.get("out")) : null;

const MIXED = [
  {
    id: "mixed-tech-art",
    industries: ["ind_003", "ind_012"],
    answers: [
      "Хочу писать код, делать программы и разбираться в алгоритмах",
      "Хочу рисовать макеты, придумывать дизайн интерфейсов и рекламы",
    ],
  },
  {
    id: "mixed-bio-it",
    industries: ["ind_004", "ind_003"],
    answers: [
      "Хочу лечить людей, ставить диагнозы и помогать пациентам",
      "Интересуют компьютеры, базы данных и разработка сайтов",
    ],
  },
  {
    id: "mixed-social-eng",
    industries: ["ind_005", "ind_001"],
    answers: [
      "Хочу учить детей, объяснять темы и вести уроки",
      "Мне нравится разбирать и чинить механизмы, станки и двигатели",
    ],
  },
];

const runtime = loadRuntimeCatalog();
const catalog = runtime.catalog;
const industriesMap = Object.fromEntries(catalog.industries.map((industry) => [industry.slug, industry.name]));
const candidatesMap = Object.fromEntries(
  catalog.professions.map((profession) => [
    profession.profession_id,
    { ...profession, trials: profession.trials.filter((trial) => isTrialEligibleForGrade(trial, 11)) },
  ])
);

const rows = [];
for (const probe of MIXED) {
  const prepared = prepareSofiInput({
    profile: { schoolGrade: 9, municipality: "Екатеринбург" },
    diagnosticAnswers: probe.answers.map((answer, index) => ({ questionId: `mixed_q${index + 1}`, answer: [answer] })),
  });
  const dossier = buildDossier(prepared.rawAnswers, prepared.student);
  const retrieval = await retrieve(dossier);
  const ctx = {
    tier: dossier.student.tier,
    dossierRefs: new Set(dossier.answers.map((answer) => answer.ref)),
    answersMap: Object.fromEntries(
      dossier.answers.map((answer) => [answer.ref, {
        question: answer.question,
        questionId: answer.questionId,
        questionnaire: answer.questionnaire,
        selected: answer.selected,
      }])
    ),
    candidatesMap,
    industriesMap,
    industryIds: new Set(Object.keys(industriesMap)),
    retrievedIndustryIds: new Set(retrieval.industryIds),
    retrievalScores: retrieval.professionScores,
    emptyShare: dossier.emptyShare,
    coverageGap: retrieval.coverageGap,
    inRegion: dossier.student.in_region,
    catalogVersion: catalog.version,
  };
  const response = await buildFallbackResponse({ dossier, retrieval, ctx, catalogVersion: catalog.version });
  const topIndustries = (response.hypotheses ?? []).slice(0, 5).map((hypothesis) => hypothesis.industry_id);
  const covered = probe.industries.filter((industry) => topIndustries.includes(industry));
  rows.push({
    profile: probe.id,
    retrievalMode: retrieval.mode,
    expectedIndustries: probe.industries,
    industryIds: retrieval.industryIds.slice(0, 5),
    top5: (response.hypotheses ?? []).slice(0, 5).map((hypothesis) => `${hypothesis.industry_id} ${hypothesis.name}`),
    coveredExpectedIndustries: covered,
    coversBoth: covered.length === probe.industries.length,
    warnings: retrieval.warnings,
  });
}

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify({ generatedAtUtc: new Date().toISOString(), catalogVersion: catalog.version, rows }, null, 2)}\n`);
}
console.log(JSON.stringify(rows, null, 2));
const failed = rows.filter((row) => !row.coversBoth);
console.log(JSON.stringify({ profiles: rows.length, coversBoth: rows.length - failed.length, failed: failed.length }));
process.exit(failed.length === 0 ? 0 : 1);
