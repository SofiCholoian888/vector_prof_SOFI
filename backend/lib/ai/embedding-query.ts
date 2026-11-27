// Режим смысловой инструкции для EmbeddingsGigaR.
//
// Инструкция добавляется только к тексту поискового запроса перед обращением
// к embedding API. Тексты документов, индекс, лексический поиск, evidence refs
// и объяснения остаются без изменений.
//
// Управление только через окружение: значение из HTTP-запроса не принимается.

export type EmbeddingQueryMode = "plain" | "instruct_v1" | "instruct_v2" | "instruct_v3";

export const EMBEDDING_QUERY_MODES: readonly EmbeddingQueryMode[] = [
  "plain",
  "instruct_v1",
  "instruct_v2",
  "instruct_v3",
];

// Экспериментальные формулировки, а не официальные рекомендации провайдера.
const INSTRUCTIONS = {
  instruct_v1:
    "По ответу школьника найди описания профессий, соответствующих его интересам и предпочтительным видам деятельности.",
  instruct_v2:
    "Найди профессии, в которых профессиональные задачи и виды деятельности соответствуют указанным интересам школьника.",
  instruct_v3:
    "Дан ответ школьника. Найди описания профессий с близкими по смыслу профессиональными задачами и занятиями.",
} as const;

export const EMBEDDING_INSTRUCTION_VERSION = "1";

export class EmbeddingQueryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingQueryConfigError";
  }
}

export function readEmbeddingQueryMode(
  env: Record<string, string | undefined> = process.env
): EmbeddingQueryMode {
  const raw = (env.EMBEDDING_QUERY_MODE ?? "").trim();
  if (!raw) return "plain";
  if (!EMBEDDING_QUERY_MODES.includes(raw as EmbeddingQueryMode)) {
    throw new EmbeddingQueryConfigError(
      `EMBEDDING_QUERY_MODE должен быть одним из: ${EMBEDDING_QUERY_MODES.join(", ")}; получено «${raw}»`
    );
  }
  return raw as EmbeddingQueryMode;
}

/**
 * Инструкции проверены только для EmbeddingsGigaR. Для другой модели режим
 * инструкций не применяется неконтролируемо, а даёт ошибку конфигурации.
 */
export function assertEmbeddingQueryModeSupported(mode: EmbeddingQueryMode, model: string): void {
  if (mode !== "plain" && model !== "EmbeddingsGigaR") {
    throw new EmbeddingQueryConfigError(
      `Режим ${mode} разрешён только для EmbeddingsGigaR, а настроена модель «${model || "(пусто)"}»`
    );
  }
}

export function formatEmbeddingQuery(text: string, mode: EmbeddingQueryMode): string {
  const query = text.trim();
  if (!query || mode === "plain") return query;
  const instruction = INSTRUCTIONS[mode];
  // Повторный вызов не должен накапливать инструкции в одном тексте.
  if (query.startsWith(instruction)) return query;
  return `${instruction}\nОтвет школьника: ${query}`;
}

/** Версия для ключа кэша: разные режимы не должны переиспользовать результат. */
export function embeddingQueryVersion(mode: EmbeddingQueryMode): string {
  return mode === "plain" ? "plain" : `${mode}-${EMBEDDING_INSTRUCTION_VERSION}`;
}
