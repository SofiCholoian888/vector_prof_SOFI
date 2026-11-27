import llmConfig from "@/config/llm.config.json" with { type: "json" };
import type { ChatMessage, LLMClient } from "./llm/client";
import { extractJson, type ValidationContext, type ValidationResult, validateResponse } from "./validate";
import { getRecommendationResponseFormat } from "./output-json-schema";
import { softSanitizeResponse } from "./soft-sanitize";

export interface GenerationCall {
  responseText: string;
  latencyMs: number;
  usage?: unknown;
  providerCostUsd?: number;
}

// Optional links are rendered from the catalog. Drop links the model attached
// to the wrong profession before checking the substantive recommendation.
function cleanOptionalLinks(raw: string, context: ValidationContext): string {
  let data;
  try {
    data = JSON.parse(extractJson(raw));
  } catch {
    return raw;
  }
  if (!Array.isArray(data?.hypotheses)) return raw;
  for (const item of data.hypotheses) {
    if (!item || typeof item.profession_id !== "string") continue;
    const trials = context.candidateTrialIds?.[item.profession_id];
    const programs = context.candidateProgramIds?.[item.profession_id];
    if (trials && Array.isArray(item.trial_ids)) {
      item.trial_ids = item.trial_ids.filter((id: unknown) => typeof id === "string" && trials.has(id));
    }
    if (programs && Array.isArray(item.program_ids)) {
      item.program_ids = item.program_ids.filter((id: unknown) => typeof id === "string" && programs.has(id));
    }
    if (context.activityTypes && Array.isArray(item.activity_links)) {
      item.activity_links = item.activity_links.filter((link: { type?: string; evidence_refs?: string[] } | null) =>
        link?.type && context.activityTypes?.has(link.type) &&
        Array.isArray(link.evidence_refs) && link.evidence_refs.length > 0 &&
        link.evidence_refs.every((ref) => context.answerRefs.has(ref))
      );
    }
  }
  return JSON.stringify(data);
}

function dropInvalidOptionalSections(raw: string, errors: string[]): string {
  const invalidIndustries = new Set<number>();
  for (const error of errors) {
    const match = /^(?:industries\[(\d+)\]|industries\.(\d+))[.:]/.exec(error);
    if (match) invalidIndustries.add(Number(match[1] ?? match[2]));
  }
  const invalidPathNote = errors.some((error) => error.startsWith("path_note:"));
  if (!invalidPathNote && !invalidIndustries.size) return raw;
  const data = JSON.parse(extractJson(raw));
  if (invalidPathNote && typeof data.path_note === "string") data.path_note = "";
  if (invalidIndustries.size && Array.isArray(data.industries)) {
    data.industries = data.industries.filter((_: unknown, index: number) => !invalidIndustries.has(index));
  }
  return JSON.stringify(data);
}

export async function generateValidatedResponse(
  client: LLMClient,
  messages: ChatMessage[],
  context: ValidationContext,
  deadlineAt: number,
  observe?: (event: Record<string, unknown>) => void,
  auditMaxTokens?: number
): Promise<{
  validation: Extract<ValidationResult, { success: true }>;
  attempts: number;
  calls: GenerationCall[];
  sanitized: boolean;
}> {
  let correctionMessages = messages;
  let lastErrors: string[] = [];
  const calls: GenerationCall[] = [];
  const responseFormat = getRecommendationResponseFormat(context.tier);
  let sanitized = false;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) break;

    let response: Awaited<ReturnType<LLMClient["chat"]>>;
    try {
      response = await client.chat(correctionMessages, {
        timeoutMs: Math.min(llmConfig.attempt_timeout_ms, remaining),
        deadlineAt,
        maxAttempts: 1,
        temperature: attempt === 1 ? llmConfig.temperature : 0,
        topP: llmConfig.top_p,
        maxTokens: auditMaxTokens ?? llmConfig.max_tokens_by_tier[context.tier],
        responseFormat,
      });
    } catch (error) {
      observe?.({ status: "request_error", attempt, reason: error instanceof Error ? error.message : "unknown" });
      const cause = error instanceof Error ? error.message : "unknown LLM error";
      const transient = /LLM_FAILED_ALL_ATTEMPTS: (?:ECONNABORTED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|HTTP 50[0234])$/.test(cause);
      if (attempt === 1 && transient && deadlineAt - Date.now() >= 4000) continue;
      if (lastErrors.length > 0) {
        throw new Error(
          `LLM_CORRECTION_FAILED: ${cause}; предыдущие ошибки валидации: ${lastErrors.join("; ")}`
        );
      }
      throw error;
    }
    calls.push({
      responseText: response.text,
      latencyMs: response.latencyMs,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
      ...(response.providerCostUsd === undefined
        ? {}
        : { providerCostUsd: response.providerCostUsd }),
    });
    const cleaned = cleanOptionalLinks(response.text, context);
    const validation = validateResponse(cleaned, context);
    observe?.({ status: "response", attempt, latencyMs: response.latencyMs, usage: response.usage,
      finishReason: response.finishReason, errors: validation.success ? [] : validation.errors });

    if (validation.success) return { validation, attempts: attempt, calls, sanitized };

    let responseTextForCorrection = cleaned;
    let errorsForCorrection = validation.errors;
    // A schema error in an optional section can hide later text-validation
    // errors. Check once more after those structural errors are removed.
    for (let pass = 0; pass < 2; pass++) {
      const repairedText = dropInvalidOptionalSections(responseTextForCorrection, errorsForCorrection);
      if (repairedText === responseTextForCorrection) break;
      responseTextForCorrection = repairedText;
      const repaired = validateResponse(repairedText, context);
      if (repaired.success) return { validation: repaired, attempts: attempt, calls, sanitized: true };
      errorsForCorrection = repaired.errors;
    }
    if (errorsForCorrection.some((error) => error.includes("содержит цифры"))) {
      try {
        const sanitizedText = softSanitizeResponse(responseTextForCorrection, context);
        const sanitizedValidation = validateResponse(sanitizedText, context);
        if (sanitizedValidation.success) {
          sanitized = true;
          return {
            validation: sanitizedValidation,
            attempts: attempt,
            calls,
            sanitized,
          };
        }
        responseTextForCorrection = sanitizedText;
        errorsForCorrection = sanitizedValidation.errors;
        sanitized = true;
      } catch (error) {
        const cause = error instanceof Error ? error.message : "неизвестная ошибка";
        errorsForCorrection = [...errorsForCorrection, `softSanitize: ${cause}`];
      }
    }

    lastErrors = errorsForCorrection;
    if (attempt === 1) {
      correctionMessages = [
        ...messages,
        { role: "assistant", content: responseTextForCorrection },
        {
          role: "user",
          content: JSON.stringify({
            validation_errors: lastErrors,
            allowed_ids: {
              industries: [...context.industryIds],
              professions: [...context.candidateProfessionIds],
              profession_industries: Object.entries(
                context.professionIndustryById ?? {}
              ).filter(([professionId]) =>
                context.candidateProfessionIds.has(professionId)
              ).map(([profession_id, industry_id]) => ({
                profession_id,
                industry_id,
              })),
              evidence_refs: [...context.answerRefs],
              activity_types: [...(context.activityTypes ?? [])],
              evidence_by_profession: Object.fromEntries(Object.entries(context.candidateEvidenceRefs ?? {}).map(([id, refs]) => [id, [...refs]])),
            },
            instruction:
              "Исправь ответ. Верни ТОЛЬКО валидный JSON-объект, без markdown, без текста до или после JSON; если исправить невозможно — {}. Ошибки: " +
              lastErrors.slice(0, 8).join("; ") +
              ". Удали цифры и любые числовые значения из всех текстовых полей, сократи каждое предложение до возрастного лимита, добавь warning related_trial_warning при смежном пути. Используй только allowed_ids; industry_id должен соответствовать профессии. Сохрани обязательные поля.",
          }),
        },
      ];
    }
  }

  throw new Error(
    lastErrors.length
      ? `LLM_VALIDATION_FAILED: ${lastErrors.join("; ")}`
      : "LLM_DEADLINE_EXCEEDED"
  );
}
