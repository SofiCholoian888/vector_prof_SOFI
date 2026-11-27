// lib/ai/retrieval.ts
import { readEmbeddingBatch } from "./embedding-response";
import fs from "node:fs/promises";
import { validateFreezeEmbeddingIndex, type FreezeEmbeddingIndex } from "./freeze-embedding";
import { careerAnswers, type Dossier } from "./dossier";
import { isInformativeChoice, signalType } from "./signals";
import ragConfig from "@/config/rag.config.json" with { type: "json" };
import axios from "axios";
import { embeddingVectorsUsable, readRecordedEmbeddingModel } from "./index-contract";
import { gatewayEndpoint, readEmbeddingsGateway } from "./gateway-env";
import { cosineSimilarity, lexicalSimilarity, selectRetrievalMode } from "./retrieval-mode";
import {
  assertEmbeddingQueryModeSupported,
  formatEmbeddingQuery,
  readEmbeddingQueryMode,
} from "./embedding-query";
import { assertNoMockEmbeddingsInProduction, isMockEmbeddingsEnabled } from "./runtime-guards";
import { buildLexicalIndex } from "./lexical-index";
import { countMetric, logEvent } from "../observe";

// ---------- Типы ----------
export type ProfessionEvidence = {
  answerRef: string;
  queryGroup: string;
  signalType: ReturnType<typeof signalType>;
  similarity: number;
  retrievalMode: RetrievalResult["mode"];
};

export interface RetrievalResult {
  professionEvidence?: Record<string, ProfessionEvidence[]>;
  embeddingDurationMs?: number | null;
  industryIds: string[];
  professionIds: string[];
  // Маппинг: ID результата -> массив refs (A1, A2...), которые его вытянули
  evidence: Record<string, string[]>;
  professionScores: Record<string, number>;
  // Лучшее сырое сходство до RRF: RRF теряет величину сигнала, поэтому
  // именно оно решает ничьи между профессиями с одинаковым рангом.
  professionRawScores: Record<string, number>;
  // Группы запросов, которые вытянули профессию: нужны для разбора перекосов.
  professionSources: Record<string, string[]>;
  industryScores: Record<string, number>;
  coverageGap: boolean;
  uncoveredAnswerRefs: string[];
  mode: "semantic" | "mock" | "lexical";
  warnings: string[];
}

interface IndexEntry {
  chunkId: string;
  type: "profession_core" | "profession_paths" | "industry_card";
  vector: number[];
  metadata: {
    profession_id?: string;
    industry_id?: string;
    text_preview?: string;
    [key: string]: unknown;
  };
}

interface CatalogIndex {
  catalog_version: string;
  entries: IndexEntry[];
  model?: unknown;
  embedding_model?: unknown;
}

interface NormalizedCatalogSnapshot {
  version: string;
  chunks: {
    type: IndexEntry["type"];
    text: string;
    metadata: IndexEntry["metadata"];
  }[];
}

// ---------- Утилиты ----------

// Запрос эмбеддинга через API (или мок для обхода VPN)
async function getEmbeddings(
  texts: string[],
  indexEntries: IndexEntry[],
  timeoutMs: number
): Promise<number[][]> {
  if (process.env.USE_MOCK_EMBEDDINGS === "true") {
    console.log("[Retrieval] Используются тестовые эмбеддинги.");
    const itEntry = indexEntries.find(e => e.metadata.profession_id === "prof_010");
    const vector = itEntry?.vector ?? indexEntries[0]?.vector;
    if (!vector) throw new Error("Индекс эмбеддингов пуст");
    return texts.map(() => vector);
  }

  const settings = readEmbeddingsGateway(process.env);

  if (!settings) {
    throw new Error("Нужны LLM_BASE_URL, LLM_API_KEY, LLM_EMBEDDINGS_MODEL");
  }

  try {
    const response = await axios.post(
      gatewayEndpoint(settings.baseUrl, "embeddings"),
      { model: settings.model, input: texts },
      {
        headers: {
          "Authorization": `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: timeoutMs,
      }
    );

    return readEmbeddingBatch(response.data, settings.model, texts.length, indexEntries[0].vector.length);
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(`Embedding API error: ${error.response.status}`);
    }
    throw error;
  }
}

// RRF из задания
export function rrf(lists: string[][], k = ragConfig.rrf_k, weights: number[] = []): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [index, list] of lists.entries()) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + (weights[index] ?? 1) / (k + rank + 1));
    });
  }
  return scores;
}

function isUninformativeAnswer(part: string): boolean {
  const selected = (part.split(":").slice(1).join(":") || part)
    .trim()
    .toLocaleLowerCase("ru");
  return /не знаю|не определил|не думал|ни в чем не перечисленном|ничего не подходит/.test(selected);
}

function selectedAnswerText(part: string): string {
  return (part.split(":").slice(1).join(":") || part).trim();
}

function hasCatalogTerm(text: string, catalogText: string): boolean {
  const ignoredTerms = new Set([
    "который", "которая", "которые", "профессия", "профессии", "профиль",
    "направление", "образование", "поступление", "профиспытаниями",
    "гуманитарное", "техническое", "творческое", "физико", "математическое",
    "например", "разные", "новые", "работа", "работать", "будущем",
  ]);
  const tokenize = (value: string) =>
    value.toLocaleLowerCase("ru").match(/[а-яё]{5,}/g)?.filter((token) => !ignoredTerms.has(token)) ?? [];
  const catalogTerms = tokenize(catalogText);
  const terms = tokenize(text);
  if (terms.length === 0) return true;
  const coveredTerms = terms.filter((term) =>
    catalogTerms.some((catalogTerm) =>
      term === catalogTerm ||
      (Math.min(term.length, catalogTerm.length) >= 5 &&
        (term.startsWith(catalogTerm) || catalogTerm.startsWith(term)))
    )
  );
  return coveredTerms.length / terms.length >= 0.6;
}

// ---------- Сборка запросов ----------

interface QueryGroup {
  groupName: string;
  parts: string[];
  refs: string[];
}

export function buildQueries(dossier: Dossier): QueryGroup[] {
  const groups: QueryGroup[] = [];
  const generalTexts: string[] = [];
  const generalRefs: string[] = [];

  // Группируем ответы по префиксам question_id (логика из задания)
  const subjects: string[] = [];
  const subjectsRefs: string[] = [];
  const situations: string[] = [];
  const situationsRefs: string[] = [];
  const direction: string[] = [];
  const directionRefs: string[] = [];

  for (const ans of careerAnswers(dossier)) {
    const type = ans.signalType ?? signalType(ans.questionId);
    const selectedText = ans.selected.filter(isInformativeChoice).join(", ");
    if (!selectedText) continue;
    generalTexts.push(selectedText);
    generalRefs.push(ans.ref);

    if (type === "education_context") {
      subjects.push(selectedText);
      subjectsRefs.push(ans.ref);
    } else if (type === "interest") {
      direction.push(selectedText);
      directionRefs.push(ans.ref);
    } else {
      situations.push(selectedText);
      situationsRefs.push(ans.ref);
    }
  }

  if (subjects.length > 0) {
    groups.push({
      groupName: "subjects",
      parts: subjects,
      refs: subjectsRefs,
    });
  }
  if (situations.length > 0) {
    groups.push({
      groupName: "situations",
      parts: situations,
      refs: situationsRefs,
    });
  }
  if (direction.length > 0) {
    groups.push({
      groupName: "direction",
      parts: direction,
      refs: directionRefs,
    });
  }

  // Общий запрос
  if (generalTexts.length > 0) {
    groups.push({
      groupName: "general",
      parts: generalTexts,
      refs: generalRefs,
    });
  }

  return groups;
}

// ---------- Основная функция ----------

export async function retrieve(
  dossier: Dossier,
  options: { deadlineAt?: number; auditAggregation?: "mean2" | "dedup" } = {}
): Promise<RetrievalResult> {
  const queries = buildQueries(dossier);
  if (queries.length === 0) {
    return {
      industryIds: [],
      professionIds: [],
      evidence: {},
      professionScores: {},
      professionRawScores: {},
      professionSources: {},
      industryScores: {},
      coverageGap: false,
      uncoveredAnswerRefs: [],
      mode: selectRetrievalMode({
        queryCount: 0,
        mockEmbeddings: process.env.USE_MOCK_EMBEDDINGS === "true",
        vectorsUsable: false,
        semanticAvailable: false,
      }),
      warnings: [],
    };
  }

  // 1. Загружаем индекс
  let index: CatalogIndex;
  try { index = JSON.parse(await fs.readFile("data/catalog.index.json", "utf8")); }
  catch { index = {catalog_version:"",entries:[]}; }
  if(!Array.isArray(index?.entries)) index={catalog_version:"",entries:[]};
  const { loadRuntimeCatalog } = await import("../runtime-catalog.ts");
  const runtimeCatalog = loadRuntimeCatalog();
  const catalog = runtimeCatalog.catalog as NormalizedCatalogSnapshot;
  const coverageValid = runtimeCatalog.origin !== "data_freeze_1" || validateFreezeEmbeddingIndex(index as unknown as FreezeEmbeddingIndex, runtimeCatalog.catalog).length === 0;
  const indexIsCurrent = index.catalog_version === catalog.version && coverageValid;
  // The query and index MUST use the same embedding model.
  // `model` is the legacy field; `embedding_model` is the current one.
  const recorded = readRecordedEmbeddingModel(index);
  const configuredModel = readEmbeddingsGateway(process.env)?.model ?? null;
  const vectorsUsable = embeddingVectorsUsable({
    catalogVersionMatches: indexIsCurrent,
    recordedModel: recorded.conflict ? null : recorded.model,
    configuredModel,
    allowMock: process.env.USE_MOCK_EMBEDDINGS === "true",
    vectors: indexIsCurrent ? index.entries.map((entry) => entry.vector) : [],
  });
  const entries = indexIsCurrent
    ? index.entries
    : catalog.chunks.map((chunk, index) => ({
        chunkId: `${chunk.type}:${index}`,
        type: chunk.type,
        vector: [],
        metadata: {
          ...chunk.metadata,
          text_preview: chunk.text,
        },
      }));

  const industryEntries = entries.filter((e) => e.type === "industry_card");
  const professionEntries = entries.filter(
    (e) => e.type === "profession_core" || e.type === "profession_paths"
  );

  // 2. Собираем запросы
  console.log(`[Retrieval] Сформировано запросов: ${queries.length} (${queries.map(q => q.groupName).join(", ")})`);

  // 3. Для каждого запроса ищем top-k
  const industryLists: string[][] = [];
  const professionLists: string[][] = [];
  const evidenceMap = new Map<string, Set<string>>(); // ID -> Set of refs
  const warnings = new Set<string>();
  const uncoveredAnswerRefs = new Set<string>();
  assertNoMockEmbeddingsInProduction();
  const isMock = isMockEmbeddingsEnabled();
  let semanticAvailable = vectorsUsable && isMock;
  let queryVectors: number[][] = [];
  let embeddingDurationMs: number | null = null;
  // Embed each answer on its own. A group text concatenates up to twenty
  // answers and turns into a generic "school" description that every education
  // profession matches; per-answer vectors keep the specific signal and let a
  // hypothesis cite the answer that actually matched.
  const queryOffsets = queries.map((_, index) =>
    queries.slice(0, index).reduce((sum, query) => sum + query.parts.length, 0)
  );
  const allQueryTexts = queries.flatMap((query) => query.parts);
  // Инструкция живёт только в тексте для embedding API. Исходные ответы
  // остаются нетронутыми: по ним считаются lexical, evidence refs и покрытие.
  const queryMode = readEmbeddingQueryMode();
  assertEmbeddingQueryModeSupported(queryMode, configuredModel ?? "");
  if (queryMode !== "plain" && isMock) {
    throw new Error("EMBEDDING_QUERY_MODE не применяется к тестовым (mock) эмбеддингам");
  }
  const embeddingQueryTexts = allQueryTexts.map((text) => formatEmbeddingQuery(text, queryMode));
  if (!indexIsCurrent) warnings.add("catalog_index_stale_lexical_fallback");
  else if (recorded.conflict && process.env.USE_MOCK_EMBEDDINGS !== "true") warnings.add("catalog_index_model_conflict_lexical_fallback");
  else if (!vectorsUsable) warnings.add("catalog_index_model_unverified_lexical_fallback");
  if (vectorsUsable && isMock) {
    try {
      queryVectors = await getEmbeddings(allQueryTexts, entries, 1);
    } catch (error) {
      semanticAvailable = false;
      warnings.add("embedding_unavailable_lexical_fallback");
      console.warn(
        "[Retrieval] Тестовые эмбеддинги недоступны; используется локальный поиск.",
        error instanceof Error ? error.name : "unknown"
      );
    }
  } else if (vectorsUsable) {
    const remaining = options.deadlineAt === undefined
      ? ragConfig.embedding_timeout_ms
      : options.deadlineAt - Date.now();
    if (remaining <= 0) {
      warnings.add("embedding_deadline_exceeded_lexical_fallback");
    } else {
      try {
        const embeddingStartedAt = Date.now();
        queryVectors = await getEmbeddings(
          embeddingQueryTexts,
          entries,
          Math.min(ragConfig.embedding_timeout_ms, remaining)
        );
        embeddingDurationMs = Date.now() - embeddingStartedAt;
        semanticAvailable = true;
      } catch (error) {
        warnings.add("embedding_unavailable_lexical_fallback");
        console.warn(
          "[Retrieval] Эмбеддинги недоступны; используется локальный поиск по тексту.",
          error instanceof Error ? error.message : "unknown error"
        );
      }
    }
  }

  const answerByRef = new Map(dossier.answers.map((answer) => [answer.ref, answer]));
  const professionEvidence: NonNullable<RetrievalResult["professionEvidence"]> = {};
  const lexicalProfessionScores = new Map<string, number>();
  const rawScoreById = new Map<string, number>();
  const sourcesById = new Map<string, Set<string>>();
  const addEvidence = (id: string, refs: string[]) => {
    if (!evidenceMap.has(id)) evidenceMap.set(id, new Set());
    refs.forEach((ref) => evidenceMap.get(id)!.add(ref));
  };

  const useWeightedLexical = !semanticAvailable && queries.some((query) => query.groupName === "direction");
  const lexical = useWeightedLexical
    ? buildLexicalIndex(entries.map((entry) => {
        const profession = runtimeCatalog.catalog.professions.find(
          (item) => item.profession_id === entry.metadata.profession_id
        );
        return {
          id: entry.chunkId,
          text: entry.metadata.text_preview ?? "",
          primaryText: profession && entry.type === "profession_core"
            ? `${profession.name}. ${profession.what_kid_does}`
            : undefined,
        };
      }))
    : null;
  for (const [queryIndex, query] of queries.entries()) {
    const qVectors = semanticAvailable
      ? queryVectors.slice(queryOffsets[queryIndex], queryOffsets[queryIndex] + query.parts.length)
      : undefined;
    const lexicalScores = lexical ? query.parts.map(lexical) : [];
    const minimumScore = qVectors
      ? ragConfig.min_similarity
      : ragConfig.lexical_min_similarity;
    const scoreEntry = (entry: IndexEntry): { score: number; partIndex: number; similarity: number } => {
      let score = 0;
      let partIndex = -1;
      let second = 0;
      query.parts.forEach((part, index) => {
        const value = qVectors
          ? cosineSimilarity(qVectors[index] ?? [], entry.vector)
          : lexicalScores[index]?.(entry.chunkId) ?? lexicalSimilarity(part, entry.metadata.text_preview ?? "");
        if (value > score) {
          second = score;
          score = value;
          partIndex = index;
        } else {
          second = Math.max(second, value);
        }
      });
      return { score: options.auditAggregation === "mean2" && query.parts.length > 1 ? (score + second) / 2 : score, partIndex, similarity: score };
    };
    // Cite only the answer that actually matched.
    const refsFor = (partIndex: number) =>
      partIndex >= 0 && query.refs[partIndex] ? [query.refs[partIndex]] : query.refs;

    // Ищем отрасли
    const industryScores = industryEntries.map((e) => ({
      id: e.metadata.industry_id!,
      ...scoreEntry(e),
    }))
    .filter((x) => x.score >= minimumScore)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, ragConfig.top_k_industries);

    industryLists.push(industryScores.map((x) => x.id));

    for (const item of industryScores) addEvidence(item.id, refsFor(item.partIndex));

    // Ищем профессии
    const professionBestById = new Map<string, { score: number; partIndex: number; similarity: number }>();
    for (const entry of professionEntries) {
      const id = entry.metadata.profession_id;
      if (!id) continue;
      const scored = scoreEntry(entry);
      const current = professionBestById.get(id);
      if (!current || scored.score > current.score) professionBestById.set(id, scored);
    }
    const professionScores = [...professionBestById.entries()]
      .map(([id, scored]) => ({ id, ...scored }))
      .filter((item) => item.score >= minimumScore)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, ragConfig.top_k_professions);

    professionLists.push(professionScores.map((x) => x.id));

    for (const item of professionScores) {
      if (lexical && query.groupName !== "general") {
        const weight = query.groupName === "direction" ? 2 : 1;
        lexicalProfessionScores.set(item.id, (lexicalProfessionScores.get(item.id) ?? 0) + weight * item.score);
      }
      rawScoreById.set(item.id, Math.max(rawScoreById.get(item.id) ?? 0, item.score));
      const sources = sourcesById.get(item.id) ?? new Set<string>();
      sources.add(query.groupName);
      sourcesById.set(item.id, sources);
      const [ref] = refsFor(item.partIndex);
      const answer = answerByRef.get(ref);
      if (answer) {
        addEvidence(item.id, [ref]);
        (professionEvidence[item.id] ??= []).push({
          answerRef: ref, queryGroup: query.groupName,
          signalType: answer.signalType ?? signalType(answer.questionId),
          similarity: item.similarity,
          retrievalMode: qVectors ? isMock ? "mock" : "semantic" : "lexical",
        });
      }
    }

    if (dossier.student.tier !== "1-4" && query.groupName === "direction") {
      const catalogText = entries
        .filter((entry) => entry.type === "profession_core")
        .map((entry) => entry.metadata.text_preview ?? "")
        .join(" ");
      query.parts.forEach((part, partIndex) => {
        if (isUninformativeAnswer(part)) return;
        const answerText = selectedAnswerText(part);
        const coveredByCatalog = hasCatalogTerm(answerText, catalogText);
        const ref = query.refs[partIndex];
        if (!coveredByCatalog && ref) uncoveredAnswerRefs.add(ref);
      });
    }
  }

  // Merge group ranks or use the accumulated lexical scores for professions.
  const weights = lexical ? queries.map((query) => {
    if (query.groupName === "direction") return 2;
    // General repeats the same answers. Keep it as a backstop without letting
    // it double the vote of a general-purpose situational answer.
    return query.groupName === "general" ? 0.5 : 1;
  }) : [];
  const industryRrf = rrf(industryLists, ragConfig.rrf_k, weights);
  const professionRanking = lexical ? lexicalProfessionScores : rrf(professionLists);
  if (!lexical && options.auditAggregation === "dedup") {
    const general = queries.findIndex((query) => query.groupName === "general");
    professionLists[general]?.forEach((id, rank) => {
      const evidence = professionEvidence[id] ?? [];
      const repeated = evidence.find((entry) => entry.queryGroup === "general")?.answerRef;
      if (evidence.some((entry) => entry.queryGroup !== "general" && entry.answerRef === repeated)) {
        professionRanking.set(id, (professionRanking.get(id) ?? 0) - 1 / (ragConfig.rrf_k + rank + 1));
      }
    });
  }

  // Raw similarity breaks ties in the combined score.
  const sortedIndustries = [...industryRrf.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
  const sortedProfessions = [...professionRanking.entries()]
    .sort((a, b) =>
      b[1] - a[1] ||
      (rawScoreById.get(b[0]) ?? 0) - (rawScoreById.get(a[0]) ?? 0) ||
      a[0].localeCompare(b[0])
    )
    .map(([id]) => id);

  // 5. Формируем evidence (массив refs)
  const evidence: Record<string, string[]> = {};
  for (const [id, refsSet] of evidenceMap.entries()) {
    evidence[id] = Array.from(refsSet);
  }

  const mode = selectRetrievalMode({
    queryCount: queries.length,
    mockEmbeddings: isMock,
    vectorsUsable,
    semanticAvailable,
  });
  console.log("[RAG E2E] retrieval mode:", mode, "professions:", sortedProfessions.length, "warnings:", [...warnings].join(","));
  countMetric(`retrieval_mode_${mode}`);
  if (!semanticAvailable && vectorsUsable) countMetric("retrieval_semantic_fallback");
  logEvent("semantic_retrieval_completed", {
    catalogVersion: catalog.version,
    catalogOrigin: runtimeCatalog.origin,
    professionCount: entries.filter((entry) => entry.type === "profession_core").length,
    indexEntryCount: index.entries.length,
    indexCurrent: indexIsCurrent,
    embeddingModel: configuredModel,
    embeddingDimensions: entries[0]?.vector.length ?? null,
    embeddingQueryMode: queryMode,
    embeddingStatus: semanticAvailable ? "success" : "fallback",
    retrievalMode: mode,
    candidateCount: sortedProfessions.length,
    embeddingDurationMs,
    warnings: [...warnings],
  });
  return {
    industryIds: sortedIndustries,
    professionIds: sortedProfessions,
    professionEvidence,
    embeddingDurationMs,
    evidence,
    professionScores: Object.fromEntries(professionRanking),
    professionRawScores: Object.fromEntries(rawScoreById),
    professionSources: Object.fromEntries(
      [...sourcesById.entries()].map(([id, sources]) => [id, [...sources]])
    ),
    industryScores: Object.fromEntries(industryRrf),
    coverageGap: uncoveredAnswerRefs.size > 0,
    uncoveredAnswerRefs: [...uncoveredAnswerRefs],
    mode,
    warnings: [...warnings],
  };
}