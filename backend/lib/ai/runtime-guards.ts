// Защита от конфигураций, которые незаметно подменяют AI-поведение.

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === "production" ||
    env.APP_ENV === "production" ||
    env.VERCEL_ENV === "production"
  );
}

/**
 * Mock-эмбеддинги возвращают один и тот же вектор для любого запроса.
 * В production это означало бы «поиск не работает, но выглядит работающим».
 */
export function assertNoMockEmbeddingsInProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env.USE_MOCK_EMBEDDINGS === "true" && isProduction(env)) {
    throw new AiConfigError(
      "USE_MOCK_EMBEDDINGS=true недопустим в production: тестовые векторы подменяют реальный поиск"
    );
  }
}

export function isMockEmbeddingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.USE_MOCK_EMBEDDINGS === "true";
}
