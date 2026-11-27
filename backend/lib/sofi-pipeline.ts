import agePolicy from "@/config/age_policy.json" with { type: "json" };
import llmConfig from "@/config/llm.config.json" with { type: "json" };
import ragConfig from "@/config/rag.config.json" with { type: "json" };
import validationPatterns from "@/config/validation_patterns.json" with { type: "json" };
import promptManifest from "@/prompts/manifest.json" with { type: "json" };
import { estimateAgeFromGrade, isTrialEligibleForGrade } from "@/lib/ai/age";
import { readChatGateway } from "@/lib/ai/gateway-env";
import { getFromCache, makeCacheKey, setCache } from "@/lib/ai/cache";
import { type NormalizedCatalog, type NormalizedProfession } from "@/lib/ai/catalog";
import { buildDossier, careerAnswers } from "@/lib/ai/dossier";
import { buildFallbackResponse } from "@/lib/ai/fallback";
import { buildElementaryTargets } from "@/lib/ai/elementary";
import { EmbeddingQueryConfigError, embeddingQueryVersion, readEmbeddingQueryMode } from "@/lib/ai/embedding-query";
import { AiConfigError, assertNoMockEmbeddingsInProduction } from "@/lib/ai/runtime-guards";
import { generateValidatedResponse } from "@/lib/ai/generate";
import { OpenAICompatibleClient } from "@/lib/ai/llm/openaiCompatible";
import { postprocess, type PostprocessContext } from "@/lib/ai/postprocess";
import { buildPrompt } from "@/lib/ai/prompts";
import { retrieve, type RetrievalResult } from "@/lib/ai/retrieval";
import { loadRuntimeCatalog } from "@/lib/runtime-catalog";
import { extractDigitWhitelist, type ValidationContext } from "@/lib/ai/validate";

import type { LLMClient } from "./ai/llm/client";
import type { PreparedSofiInput, SofiModuleResult } from "./sofi-adapter.ts";

export type SofiPipelineInput = {
  prepared: PreparedSofiInput;
  professions: Array<{ id: string; graphProfessionId: string | null }>;
};

function buildCandidates(
  catalog: NormalizedCatalog,
  grade: number
): Record<string, NormalizedProfession> {
  return Object.fromEntries(
    catalog.professions.map((profession) => {
      const trials = profession.trials.filter((trial) =>
        isTrialEligibleForGrade(trial, grade)
      );
      return [
        profession.profession_id,
        {
          ...profession,
          trials,
          trial_ids: trials.map((trial) => trial.trial_id),
        },
      ];
    })
  );
}

function emptyRetrieval(reason: string) {
  return {
    industryIds: [] as string[],
    professionIds: [] as string[],
    evidence: {} as Record<string, string[]>,
    professionScores: {} as Record<string, number>,
    professionRawScores: {} as Record<string, number>,
    professionSources: {} as Record<string, string[]>,
    industryScores: {} as Record<string, number>,
    coverageGap: true,
    uncoveredAnswerRefs: [] as string[],
    mode: "lexical" as const,
    warnings: [reason],
  };
}

function isSofiResult(value: unknown): value is SofiModuleResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "summary" in value &&
      "generation" in value
  );
}

export type SofiAudit = {
  onRetrieval?: (retrieval: RetrievalResult) => void;
  onGeneration?: (event: Record<string, unknown>) => void;
  retrievalOnly?: boolean;
  diversification?: PostprocessContext["auditDiversification"];
  client?: LLMClient;
  maxTokens?: number;
};

export async function runSofiPipeline(
  input: SofiPipelineInput,
  audit?: SofiAudit
): Promise<SofiModuleResult> {
  assertNoMockEmbeddingsInProduction();
  const { prepared } = input;
  const grade = prepared.student.school_grade;
  const dossier = buildDossier(prepared.rawAnswers, prepared.student);
  const tier = dossier.student.tier;
  const signalAnswers = careerAnswers(dossier);
  const catalog = loadRuntimeCatalog().catalog;
  if (catalog.schema_version !== "hybrid_v2") {
    throw new Error(`Ожидалась схема каталога hybrid_v2, получена ${catalog.schema_version}`);
  }

  const candidates = buildCandidates(catalog, grade);
  const elementary = tier === "1-4" ? buildElementaryTargets(dossier, catalog) : null;
  const elementaryActivityIds = new Set(elementary?.targets.flatMap(target=>target.activity_ids) ?? []);
  const industriesMap = Object.fromEntries(
    catalog.industries.map((industry) => [industry.slug, industry.name])
  );
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

  let retrieval;
  try {
    retrieval = await retrieve(dossier, {
      deadlineAt: Date.now() + ragConfig.embedding_timeout_ms,
    });
  } catch (error) {
    // Ошибка конфигурации не должна превращаться в тихую деградацию поиска.
    if (error instanceof EmbeddingQueryConfigError || error instanceof AiConfigError) throw error;
    console.warn(
      "[AI] Подбор по каталогу не выполнен; включён retrieval-only fallback.",
      error instanceof Error ? error.message : "unknown error"
    );
    retrieval = emptyRetrieval("retrieval_failed");
  }

  audit?.onRetrieval?.(retrieval);
  const catalogVersion = catalog.version;
  const promptVersion = promptManifest[tier].prompt;
  const configVersion =
    `${agePolicy.version}+rag-${ragConfig.version}+llm-${llmConfig.version}` +
    `+validation-${validationPatterns.version}` +
    // Разные режимы инструкции не должны переиспользовать кэш друг друга.
    `+emb-${embeddingQueryVersion(readEmbeddingQueryMode())}`;
  const cacheKey = makeCacheKey(
    [dossier, { ...retrieval, embeddingDurationMs: undefined }, readChatGateway(process.env)?.model],
    promptVersion,
    catalogVersion,
    configVersion
  );
  const cached = getFromCache(cacheKey);
  if (!audit && isSofiResult(cached)) {
    return cached;
  }

  const postprocessContext: PostprocessContext = {
    tier,
    auditDiversification: audit?.diversification,
    dossierRefs: new Set(signalAnswers.map((answer) => answer.ref)),
    answersMap,
    candidatesMap: candidates,
    industriesMap,
    industryIds: new Set(Object.keys(industriesMap)),
    retrievedIndustryIds: new Set(retrieval.industryIds),
    retrievalScores: retrieval.professionScores,
    retrievalRawScores: retrieval.professionRawScores,
    emptyShare: dossier.emptyShare,
    coverageGap: retrieval.coverageGap,
    inRegion: dossier.student.in_region,
    catalogVersion,
  };

  let result: SofiModuleResult;
  let mode: "llm" | "retrieval_only" = "llm";
  let attempts = 0;
  const juniorWhy = new Map<string, string>();

  if (audit?.retrievalOnly || signalAnswers.length < agePolicy.min_signal_answers) {
    audit?.onGeneration?.({ status: signalAnswers.length < agePolicy.min_signal_answers ? "low_signal" : "retrieval_only_requested" });
    mode = "retrieval_only";
    result = await buildFallbackResponse({
      dossier,
      retrieval,
      ctx: postprocessContext,
      catalogVersion,
    });
  } else {
    try {
      const fullCatalog = catalog.professions.length <= ragConfig.full_catalog_threshold;
      const candidateIds = fullCatalog
        ? catalog.professions.map((profession) => profession.profession_id)
        : retrieval.professionIds.slice(0, llmConfig.candidate_limit);
      const industryCandidateIds = elementary
        ? elementary.targets.map((target) => target.industry_id)
        : fullCatalog
        ? Object.keys(industriesMap)
        : [...new Set([
            ...retrieval.industryIds.slice(0, ragConfig.top_k_industries),
            ...candidateIds.map((id) => candidates[id].industry_id),
          ])];
      const candidateSet = new Set(candidateIds);
      const tierCandidates = tier === "1-4"
        ? []
        : candidateIds.flatMap((id) => {
            const candidate = candidates[id];
            if (!candidate) return [];
            return [{
              profession_id: candidate.profession_id,
              industry_id: candidate.industry_id,
              name: candidate.name,
              description: tier === "5-8"
                ? candidate.description_5_8
                : candidate.description_9_11,
              key_skills: candidate.key_skills,
              evidence_refs: (retrieval.evidence[id] ?? []).filter((ref) => postprocessContext.dossierRefs.has(ref)),
              trials: candidate.trials.slice(0, 2).map((trial) => ({
                trial_id: trial.trial_id,
                title: trial.title,
                trial_type: trial.trial_type,
                fit_level: trial.fit_level,
              })),
              programs: tier === "9-11" ? candidate.programs.slice(0, 2).map((program) => ({
                program_id: program.program_id, title: program.name, fit_level: program.fit_level,
              })) : [],
            }];
          });
      const supportingRefs = new Set(tierCandidates.flatMap((candidate) => candidate.evidence_refs));
      const promptAnswers = elementary
        ? signalAnswers
        : signalAnswers.filter((answer) => supportingRefs.has(answer.ref) || answer.signalType === "interest");
      const juniorActivities = tier === "1-4"
        ? catalog.trials.filter((trial) => elementaryActivityIds.has(trial.trial_id) && isTrialEligibleForGrade({ ...trial, trial_type: trial.trial_type ?? null }, grade))
        : [];
      const activityOptions = tier === "1-4" ? juniorActivities : [];
      const validationContext: ValidationContext = {
        tier,
        catalogProfessionIds: new Set(Object.keys(candidates)),
        candidateProfessionIds: candidateSet,
        industryIds: new Set(industryCandidateIds),
        answerRefs: new Set(promptAnswers.map((answer) => answer.ref)),
        activityTypes: new Set(activityOptions.map((trial) => trial.trial_id)),
        candidateEvidenceRefs: Object.fromEntries(tierCandidates.map((p) => [p.profession_id, new Set(p.evidence_refs)])),

        professionIndustryById: Object.fromEntries(
          catalog.professions.map((profession) => [
            profession.profession_id,
            profession.industry_id,
          ])
        ),
        candidateTrialIds: Object.fromEntries(
          tierCandidates.map((p) => [p.profession_id, new Set(p.trials.map((trial) => trial.trial_id))])
        ),
        candidateProgramIds: Object.fromEntries(
          tierCandidates.map((p) => [p.profession_id, new Set(p.programs.map((program) => program.program_id))])
        ),
        candidateTrialFitLevels: Object.fromEntries(
          [...candidateSet].map((id) => [
            id,
            Object.fromEntries(
              (candidates[id]?.trials ?? []).map((trial) => [
                trial.trial_id,
                trial.fit_level ?? null,
              ])
            ),
          ])
        ),
        candidateProgramFitLevels: Object.fromEntries(
          [...candidateSet].map((id) => [
            id,
            Object.fromEntries(
              (candidates[id]?.programs ?? []).map((program) => [
                program.program_id,
                program.fit_level ?? null,
              ])
            ),
          ])
        ),
        digitWhitelist: extractDigitWhitelist(tierCandidates),
      };
      const generated = await generateValidatedResponse(
        audit?.client ?? new OpenAICompatibleClient(),
        [
          { role: "system", content: await buildPrompt(tier) },
          {
            role: "user",
            content: JSON.stringify({
              student: {
                tier,
                grade,
                in_region: dossier.student.in_region,
                estimated_age: estimateAgeFromGrade(grade),
              },
              answers: promptAnswers.map(({ ref, signalType, selected }) => ({
                ref,
                signal_type: signalType,
                selected,
              })),
              constraints: dossier.constraints,
              industries: industryCandidateIds.map((industryId) => ({
                industry_id: industryId,
                name: industriesMap[industryId] ?? industryId,
                hit_strength: retrieval.industryScores[industryId] ?? 0,
              })),
              candidates: tierCandidates,
              activity_link_contract: "activity_links[].type must be an activity_id from activity_types; use only supplied evidence refs",
              activity_types: activityOptions.map((trial) => ({
                activity_id: trial.trial_id,
                title: trial.title,
                description: tier === "1-4" ? trial.description_1_4 : tier === "5-8" ? trial.description_5_8 : trial.description_9_11,
                format: trial.format,
                municipality: trial.municipality,
                cost: trial.cost,
              })),
            }),
          },
        ],
        validationContext,
        Date.now() + llmConfig.total_deadline_ms,
        audit?.onGeneration,
        audit?.maxTokens
      );
      attempts = generated.attempts;
      const data = generated.validation.data;
      audit?.onGeneration?.({ status: "validated", data });

      if (tier === "1-4" && "interest_tags" in data) {
        for (const tag of data.interest_tags) {
          const target = elementary?.targets.find((item) => item.industry_id === tag.industry_id);
          if (tag.why.trim() && target && tag.evidence_refs.every((ref) => target.evidence_refs.includes(ref))) {
            juniorWhy.set(tag.industry_id, tag.why);
          }
        }
        result = {
          status: data.interest_tags.length === 0 && data.status === "ok"
            ? "no_match"
            : data.status,
          summary: data.summary,
          industries: [],
          interest_tags: data.interest_tags,
          activity_ids: data.activity_ids,
          hypotheses: [],
          next_step: data.next_step,
          warnings: [...new Set([
            ...dossier.warnings,
            ...retrieval.warnings,
            ...data.warnings,
          ])],
          disclaimer: "Это предварительная подсказка, а не диагностика.",
        };
      } else if ("hypotheses" in data && "industries" in data) {
        const processed = await postprocess(data.hypotheses, postprocessContext);
        const nextStep = "path_note" in data
          ? `${data.path_note} ${data.next_step}`.trim()
          : data.next_step;
        result = {
          status: processed.hypotheses.length === 0 && data.status === "ok"
            ? "no_match"
            : data.status,
          summary: data.summary,
          industries: data.industries.map((industry) => ({
            industryId: industry.industry_id,
            name: industriesMap[industry.industry_id] ?? industry.industry_id,
            why: industry.why,
          })),
          interest_tags: [],
          hypotheses: processed.hypotheses,
          next_step: nextStep,
          warnings: [...new Set([
            ...dossier.warnings,
            ...retrieval.warnings,
            ...data.warnings,
            ...processed.warnings,
            ...(retrieval.coverageGap ? ["coverage_gap"] : []),
          ])],
          disclaimer: "Это предварительная подсказка, а не диагностика.",
        };
      } else {
        throw new Error("Ответ LLM не соответствует возрастной схеме");
      }
    } catch (error) {
      mode = "retrieval_only";
      audit?.onGeneration?.({ status: "fallback", reason: error instanceof Error ? error.message : "unknown" });
      console.warn(
        "[AI] Генерация не прошла; включён retrieval-only fallback.",
        error instanceof Error ? error.message : "unknown error"
      );
      result = await buildFallbackResponse({
        dossier,
        retrieval,
        ctx: postprocessContext,
        catalogVersion,
      });
    }
  }

  // Preserve the ZIP elementary.ts evidence threshold and explicit trial mappings.
  // The LLM writes age-friendly explanations, not the final catalog ID selection.
  if (elementary && signalAnswers.length >= agePolicy.min_signal_answers) {

    const mappedTags = elementary.targets.map(target=>({
      industry_id:target.industry_id,
      tag:target.tag,
      why: juniorWhy.get(target.industry_id) || "Это направление связано с твоими ответами.",
      evidence_refs:target.evidence_refs
    }));
    const selectedIds = [...new Set(elementary.targets.flatMap(target=>target.activity_ids))].slice(0,3);
    result.interest_tags = mappedTags;
    result.activity_ids = selectedIds;
    result.warnings = [...new Set([...(result.warnings ?? []),...elementary.warnings])];
    if (!mappedTags.length) result.status = "no_match";
  }
  result.generation = {
    retrievalMode: retrieval.mode,
    mode,
    tier,
    promptVersion: mode === "llm" ? promptVersion : result.generation?.promptVersion ?? null,
    catalogVersion,
    configVersion,
    attempts,
  };
  // Do not cache degraded retrieval-only responses: a transient gateway outage
  // must not keep masking a recovered LLM or semantic retrieval service.
  if (!audit && mode === "llm" && retrieval.mode === "semantic") {
    setCache(cacheKey, result);
  }
  return result;
}
