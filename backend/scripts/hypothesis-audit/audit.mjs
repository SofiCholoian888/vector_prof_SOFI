// Offline audit of the recommendation ranking. Run from backend:
//   node --experimental-strip-types --import ./tests/register-app-alias.mjs \
//     scripts/hypothesis-audit/audit.mjs <dataDir> <out.jsonl> \
//     [--variants=base,flip] [--profile=<id>] [--mode=lexical|semantic]
//
// <dataDir> must contain data/ (catalog.index.json, navigator.json or
// catalog.normalized.json). Config and prompts always come from backend/.
// No generation model is called: hypotheses come from the retrieval-only path,
// so a lexical run is fully reproducible and a semantic run only needs the
// embedding gateway.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const backendRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const [dataDirArg, outArg, ...flags] = process.argv.slice(2);
if (!dataDirArg || !outArg) {
  console.error("usage: audit.mjs <dataDir> <out.jsonl> [--variants=base,flip] [--profile=<id>] [--mode=lexical|semantic]");
  process.exit(1);
}
const dataDir = path.resolve(dataDirArg);
const outPath = path.resolve(outArg);
const variantFlag = flags.find((flag) => flag.startsWith("--variants="));
const variants = (variantFlag?.slice("--variants=".length) ?? "base,flip").split(",");
const profileFilter = flags.find((flag) => flag.startsWith("--profile="))?.slice("--profile=".length);

const modeFlag = flags.find((flag) => flag.startsWith("--mode="))?.slice("--mode=".length) ?? "lexical";
process.env.USE_MOCK_EMBEDDINGS = "false";
// Сравнительные прогоны намеренно работают и на legacy-каталоге.
process.env.REQUIRE_FREEZE_CATALOG = process.env.REQUIRE_FREEZE_CATALOG ?? "false";
if (modeFlag !== "semantic") {
  for (const key of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_EMBEDDINGS_MODEL"]) delete process.env[key];
}
process.chdir(dataDir);

const { prepareSofiInput } = await import(pathToFileURL(path.join(backendRoot, "lib/sofi-adapter.ts")).href);
const { buildDossier } = await import(pathToFileURL(path.join(backendRoot, "lib/ai/dossier.ts")).href);
const { retrieve } = await import(pathToFileURL(path.join(backendRoot, "lib/ai/retrieval.ts")).href);
const { buildFallbackResponse } = await import(pathToFileURL(path.join(backendRoot, "lib/ai/fallback.ts")).href);
const { loadRuntimeCatalog } = await import(pathToFileURL(path.join(backendRoot, "lib/runtime-catalog.ts")).href);
const { isTrialEligibleForGrade } = await import(pathToFileURL(path.join(backendRoot, "lib/ai/age.ts")).href);
const { buildElementaryTargets } = await import(pathToFileURL(path.join(backendRoot, "lib/ai/elementary.ts")).href);

const mockStudents = JSON.parse(
  fs.readFileSync(path.join(backendRoot, "data/mock_students_data.json"), "utf8")
);
const questionMaster = JSON.parse(
  fs.readFileSync(path.join(backendRoot, "data/bilet_questions_master.json"), "utf8")
);

const runtime = loadRuntimeCatalog(dataDir);
const catalog = runtime.catalog;
const industriesMap = Object.fromEntries(catalog.industries.map((industry) => [industry.slug, industry.name]));
const candidatesMap = Object.fromEntries(
  catalog.professions.map((profession) => {
    const trials = profession.trials.filter((trial) => isTrialEligibleForGrade(trial, 11));
    return [profession.profession_id, { ...profession, trials }];
  })
);

function questionOptions(questionnaireName, questionId) {
  const questionnaire = questionMaster.questionnaires.find(
    (item) => item.questionnaire_name.trim() === questionnaireName.trim()
  );
  const question = questionnaire?.blocks
    .flatMap((block) => block.questions)
    .find((item) => item.id === questionId);
  return question?.options?.map((option) => (typeof option === "string" ? option : option.label ?? option.value)) ?? [];
}

function mockProfiles() {
  return mockStudents.map((student) => ({
    id: `mock-${student.student_id}`,
    grade: student.grade,
    municipality: student.city,
    questionnaire: student.questionnaire_name,
    answers: student.answers,
    expected: null,
  }));
}

// Synthetic probes: one explicit answer per industry. They test whether a clear
// interest reaches the matching industry instead of the catalog's first rows.
const PROBES = [
  { industry: "ind_001", answers: ["Мне нравится разбирать и чинить механизмы, станки и двигатели", "Хочу чертить детали и придумывать, как устроена машина"] },
  { industry: "ind_002", answers: ["Хочу проектировать дома и мосты, считать конструкции", "Интересует стройка, монтаж и архитектурные проекты"] },
  { industry: "ind_003", answers: ["Хочу писать код, делать программы и разбираться в алгоритмах", "Интересуют компьютеры, базы данных и разработка сайтов"] },
  { industry: "ind_004", answers: ["Хочу лечить людей, ставить диагнозы и помогать пациентам", "Интересует анатомия, медицина и уход за больными"] },
  { industry: "ind_005", answers: ["Хочу учить детей, объяснять темы и вести уроки", "Интересует педагогика, воспитание и работа с классом"] },
  { industry: "ind_006", answers: ["Интересует добыча руды, металлургия и работа на горном производстве", "Хочу работать с металлом, сплавами и плавильными печами"] },
  { industry: "ind_007", answers: ["Хочу управлять транспортом, организовывать перевозки и логистику", "Интересуют поезда, машины, склады и доставка грузов"] },
  { industry: "ind_008", answers: ["Интересует электричество, энергосистемы и электростанции", "Хочу монтировать проводку, обслуживать оборудование и сети"] },
  { industry: "ind_009", answers: ["Нравится химия, опыты и химическое производство", "Хочу работать с реактивами, лабораторией и технологиями веществ"] },
  { industry: "ind_010", answers: ["Интересуют деньги, банки, налоги и финансовые расчёты", "Хочу считать бюджет, вести учёт и работать с отчётностью"] },
  { industry: "ind_011", answers: ["Хочу работать с покупателями, продажами и обслуживанием клиентов", "Интересует торговля, сервис и общение с людьми в магазине"] },
  { industry: "ind_012", answers: ["Хочу рисовать макеты, придумывать дизайн интерфейсов и рекламы", "Интересует графический дизайн, вёрстка и оформление"] },
  { industry: "ind_013", answers: ["Хочу заниматься музыкой, театром, кино и искусством", "Интересуют выставки, сцена, творческие проекты и культура"] },
  { industry: "ind_014", answers: ["Интересуют законы, суды, права людей и государственное управление", "Хочу разбираться в документах, правилах и защите прав"] },
  { industry: "ind_015", answers: ["Хочу работать с растениями, животными и сельским хозяйством", "Интересует ферма, урожай, уход за животными и агрономия"] },
  { industry: "ind_016", answers: ["Хочу изучать экологию, природу, геологию и охрану окружающей среды", "Интересуют исследования природы, вода, воздух и экологические проекты"] },
];

function probeProfiles() {
  return PROBES.map((probe) => ({
    id: `probe-${probe.industry}`,
    grade: 9,
    municipality: "Екатеринбург",
    questionnaire: "",
    answers: Object.fromEntries(
      probe.answers.map((answer, index) => [`probe_q${index + 1}`, [answer]])
    ),
    expected: probe.industry,
  }));
}

function flipAnswers(profile) {
  // Replace the first answer that has an alternative option with that option.
  // This measures how much the result depends on a single answer.
  for (const [questionId, value] of Object.entries(profile.answers)) {
    const options = questionOptions(profile.questionnaire, questionId);
    const current = Array.isArray(value) ? value : [value];
    const alternative = options.find((option) => !current.includes(option));
    if (!alternative) continue;
    return {
      ...profile,
      id: `${profile.id}-flip`,
      variant: "flip",
      answers: { ...profile.answers, [questionId]: [alternative] },
      flippedQuestion: questionId,
      flippedFrom: current,
      flippedTo: alternative,
    };
  }
  return null;
}

function toDiagnosticAnswers(profile) {
  return Object.entries(profile.answers).map(([questionId, answer]) => ({
    questionId,
    answer,
    questionnaire: profile.questionnaire,
  }));
}

async function runProfile(profile, variant) {
  const prepared = prepareSofiInput({
    profile: { schoolGrade: profile.grade, municipality: profile.municipality },
    diagnosticAnswers: toDiagnosticAnswers(profile),
  });
  const dossier = buildDossier(prepared.rawAnswers, prepared.student);
  const retrieval = await retrieve(dossier);
  const answersMap = Object.fromEntries(
    dossier.answers.map((answer) => [
      answer.ref,
      {
        question: answer.question,
        questionId: answer.questionId,
        questionnaire: answer.questionnaire,
        selected: answer.selected,
      },
    ])
  );
  const ctx = {
    tier: dossier.student.tier,
    dossierRefs: new Set(dossier.answers.map((answer) => answer.ref)),
    answersMap,
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
  // The pipeline replaces the fallback tags for grades 1-4 with the deterministic
  // ZIP mapping, so measure that mapping instead of the retrieval industries.
  const elementary = dossier.student.tier === "1-4" ? buildElementaryTargets(dossier, catalog) : null;
  return {
    catalog: runtime.origin,
    catalogVersion: catalog.version,
    catalogProfessions: catalog.professions.length,
    profile: profile.id,
    grade: profile.grade,
    tier: dossier.student.tier,
    variant,
    expected: profile.expected,
    flippedQuestion: profile.flippedQuestion ?? null,
    flippedTo: profile.flippedTo ?? null,
    answerCount: dossier.answers.length,
    answers: dossier.answers.map((answer) => ({
      ref: answer.ref,
      questionId: answer.questionId,
      question: answer.question,
      selected: answer.selected,
    })),
    retrieval: {
      mode: retrieval.mode,
      warnings: retrieval.warnings,
      professionIds: retrieval.professionIds,
      professionScores: retrieval.professionScores,
      professionRawScores: retrieval.professionRawScores ?? {},
      professionSources: retrieval.professionSources ?? {},
      industryIds: retrieval.industryIds,
      industryScores: retrieval.industryScores,
    },
    status: elementary ? (elementary.targets.length ? "mapped" : "no_match") : response.status,
    warnings: elementary
      ? [...new Set([...response.warnings, ...elementary.warnings])]
      : response.warnings,
    // Grades 1-4 answer with directions and activities instead of hypotheses.
    interestTags: (elementary ? elementary.targets : response.interest_tags ?? []).map((tag) => ({
      industry_id: tag.industry_id,
      tag: tag.tag,
      evidence_refs: tag.evidence_refs,
    })),
    activityIds: elementary
      ? [...new Set(elementary.targets.flatMap((target) => target.activity_ids))].slice(0, 3)
      : response.activity_ids ?? [],
    hypotheses: (response.hypotheses ?? []).map((hypothesis) => ({
      rank: hypothesis.rank,
      id: hypothesis.profession_id,
      name: hypothesis.name,
      industry_id: hypothesis.industry_id,
      industry_name: hypothesis.industry_name,
      score: retrieval.professionScores[hypothesis.profession_id] ?? null,
      rawScore: (retrieval.professionRawScores ?? {})[hypothesis.profession_id] ?? null,
      sources: (retrieval.professionSources ?? {})[hypothesis.profession_id] ?? [],
      confidence: hypothesis.confidence?.level ?? null,
      why: hypothesis.why,
      evidence_refs: hypothesis.evidence_refs,
      evidence_selected: (hypothesis.evidence ?? []).map((item) => item.selected),
    })),
  };
}

const profiles = [
  ...mockProfiles(),
  ...probeProfiles(),
].filter((profile) => !profileFilter || profile.id === profileFilter);

const out = fs.createWriteStream(outPath, { flags: "w" });
let count = 0;
for (const profile of profiles) {
  const jobs = [{ profile, variant: "base" }];
  if (variants.includes("flip") && !profile.expected) {
    const flipped = flipAnswers(profile);
    if (flipped) jobs.push({ profile: flipped, variant: "flip" });
  }
  for (const job of jobs) {
    const record = await runProfile(job.profile, job.variant);
    out.write(`${JSON.stringify(record)}\n`);
    count++;
  }
}
out.end();
console.log(JSON.stringify({ dataDir, outPath, records: count, origin: runtime.origin, professions: catalog.professions.length, requestedMode: modeFlag }));
