// Recommendation audit on checked-in synthetic profiles. Run from backend:
//   node --experimental-strip-types --import ./tests/register-app-alias.mjs \
//     scripts/hypothesis-audit/audit.mjs <dataDir> <out.jsonl> \
//     [--variants=base,flip] [--profile=<id>] [--mode=lexical|semantic]
//
// <dataDir> must contain data/ (catalog.index.json, navigator.json or
// catalog.normalized.json). Config and prompts always come from backend/.
// Default: retrieval_only. --pipeline=full calls runSofiPipeline. Use
// --catalog=legacy only with the historical catalog/index in an isolated directory.
import fs from "node:fs";
import path from "node:path";
import { controlProfiles } from "./controls.mjs";
import axios from "axios";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const backendRoot = fileURLToPath(new URL("../..", import.meta.url));
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

const option = (name) => flags.find((flag) => flag.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const modeFlag = option("mode") ?? "lexical";
const pipeline = option("pipeline") ?? "retrieval_only";
const cap = option("max-tokens");
if (cap !== undefined && (!/^\d+$/.test(cap) || Number(cap) < 1)) throw new Error("--max-tokens must be positive");
if (!["semantic", "lexical"].includes(modeFlag) || !["full", "retrieval_only"].includes(pipeline)) {
  throw new Error("Use --mode=semantic|lexical and --pipeline=full|retrieval_only");
}
const cacheDir = option("embedding-cache") && path.resolve(option("embedding-cache"));
if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
const adapter = axios.getAdapter(axios.defaults.adapter);
let httpEvents = [];
axios.defaults.adapter = async (request) => {
  const body = JSON.parse(request.data);
  const embedding = request.url.endsWith("/embeddings");
  const cacheFile = embedding && cacheDir
    ? path.join(cacheDir, createHash("sha256").update(JSON.stringify({ model:body.model, input:body.input })).digest("hex") + ".json")
    : null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    return { config:request, status:200, statusText:"OK", headers:{}, data:fs.readFileSync(cacheFile,"utf8") };
  }
  const start = performance.now();
  try {
    const response = await adapter(request);
    const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
    if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(data));
    if (!embedding) {
      const choice = data.choices?.[0];
      httpEvents.push({ latencyMs:Math.round(performance.now()-start), status:response.status,
        usage:data.usage, finishReason:choice?.finish_reason, raw:choice?.message?.content });
    }
    return response;
  } catch (error) {
    httpEvents.push({ endpoint:embedding ? "embeddings" : "chat", latencyMs:Math.round(performance.now()-start),
      status:error.response?.status, code:error.code });
    throw error;
  }
};
process.env.USE_MOCK_EMBEDDINGS = "false";
process.env.EMBEDDING_QUERY_MODE = "plain";
process.env.REQUIRE_FREEZE_CATALOG = option("catalog") === "legacy" ? "false" : "true";
if (modeFlag === "lexical") delete process.env.LLM_EMBEDDINGS_MODEL;
else process.env.LLM_EMBEDDINGS_MODEL = "EmbeddingsGigaR";
process.chdir(dataDir);

const { prepareSofiInput } = await import(pathToFileURL(path.join(backendRoot, "lib/sofi-adapter.ts")).href);
const { runSofiPipeline } = await import(pathToFileURL(path.join(backendRoot, "lib/sofi-pipeline.ts")).href);
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
      id: profile.id,
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
  httpEvents = [];
  const start = performance.now();
  const generationEvents = [];
  let retrieval;
  let fullResponse;
  if (pipeline === "full" || option("diversification")) {
    fullResponse = await runSofiPipeline({ prepared, professions:[] }, {
      onRetrieval: (value) => { retrieval = value; },
      onGeneration: (event) => generationEvents.push(event),
      retrievalOnly:pipeline === "retrieval_only",
      diversification:option("diversification"),
      maxTokens:cap ? Number(cap) : undefined,
    });
  }
  retrieval ??= await retrieve(dossier, { auditAggregation: option("aggregation") });
  const candidatesMap = Object.fromEntries(catalog.professions.map((profession) => {
    const trials = profession.trials.filter((trial) => isTrialEligibleForGrade(trial, profile.grade));
    return [profession.profession_id, { ...profession, trials, trial_ids:trials.map((trial) => trial.trial_id) }];
  }));
  const answersMap = Object.fromEntries(
    dossier.answers.map((answer) => [
      answer.ref,
      {
        question: answer.question,
        questionId: answer.questionId,
        questionnaire: answer.questionnaire,
        selected: answer.selected,
      signalType:answer.signalType,
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
  const response = fullResponse ?? await buildFallbackResponse({ dossier, retrieval, ctx, catalogVersion: catalog.version });
  // The pipeline replaces the fallback tags for grades 1-4 with the deterministic
  // ZIP mapping, so measure that mapping instead of the retrieval industries.
  const elementary = !fullResponse && response.status !== "low_signal" && dossier.student.tier === "1-4" ? buildElementaryTargets(dossier, catalog) : null;
  return {
    catalog: runtime.origin,
    requestedMode:modeFlag,
    semanticSkipped:modeFlag === "semantic" && retrieval.mode === "lexical" && retrieval.warnings.length === 0 && !retrieval.professionIds.length,
    technicalFailure:retrieval.mode !== modeFlag && retrieval.professionIds.length > 0 ||
      (modeFlag === "semantic" && retrieval.warnings.some((w) => /fallback|failed/.test(w))),
    pipeline, maxTokensOverride:cap, generation:response.generation, summary:response.summary,
    latencyMs: Math.round(performance.now() - start), generationEvents, httpEvents,
    municipality:profile.municipality,
    relevant:profile.relevant ?? [],
    inputHash:createHash("sha256").update(JSON.stringify(profile.answers)).digest("hex"),
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
      signalType:answer.signalType,
    })),
    retrieval: {
      mode: retrieval.mode,
      warnings: retrieval.warnings,
      professionIds: retrieval.professionIds,
      professionScores: retrieval.professionScores,
      professionRawScores: retrieval.professionRawScores ?? {},
      professionSources: retrieval.professionSources ?? {},
      industryIds: retrieval.industryIds,
      evidence:retrieval.professionEvidence,
      embeddingDurationMs:retrieval.embeddingDurationMs,
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
      trial_ids:hypothesis.trial_ids,
      allowed_trials:candidatesMap[hypothesis.profession_id]?.trial_ids ?? [],
      explanation_source:response.generation?.mode === "llm" ? "llm" : "fallback",
      evidence_selected: (hypothesis.evidence ?? []).map((item) => item.selected),
    })),
  };
}

const profiles = [
  ...mockProfiles(),
  ...probeProfiles(),
  ...(flags.includes("--controls") ? controlProfiles() : []),
].filter((profile) => !profileFilter || profileFilter.split(",").includes(profile.id));

const out = fs.createWriteStream(outPath, { flags: "w" });
let count = 0;
for (const profile of profiles) {
  if (profile.variant && !variants.includes(profile.variant)) continue;
  const jobs = [{ profile, variant: profile.variant ?? "base" }];
  if (variants.includes("flip") && profile.id.startsWith("mock-")) {
    const flipped = flipAnswers(profile);
    if (flipped) jobs.push({ profile: flipped, variant: "flip" });
  }
  for (const job of jobs) {
    let record;
    try {
      record = await runProfile(job.profile, job.variant);
    } catch (error) {
      record = { profile:job.profile.id, grade:job.profile.grade, variant:job.variant,
        tier:job.profile.grade <= 4 ? "1-4" : job.profile.grade <= 8 ? "5-8" : "9-11",
        expected:job.profile.expected, relevant:job.profile.relevant ?? [],
        inputHash:createHash("sha256").update(JSON.stringify(job.profile.answers)).digest("hex"),
        requestedMode:modeFlag, pipeline, catalogVersion:catalog.version, technicalFailure:true,
        municipality:job.profile.municipality,
        status:"error", warnings:[error instanceof Error ? error.message : "unknown"],
        retrieval:{professionIds:[]}, hypotheses:[] };
    }
    out.write(`${JSON.stringify(record)}\n`);
    count++;
  }
}
await new Promise((resolve, reject) => { out.once("error", reject); out.end(resolve); });
console.log(JSON.stringify({ dataDir, outPath, records: count, origin: runtime.origin, professions: catalog.professions.length, requestedMode: modeFlag }));
