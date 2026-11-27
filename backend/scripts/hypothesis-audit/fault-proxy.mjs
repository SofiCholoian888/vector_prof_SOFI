// Локальный сбойный прокси перед шлюзом AI. Нужен, чтобы проверить поведение
// приложения при недоступном или испорченном embedding API, не меняя настройки
// самого шлюза.
//
// Режимы:
//   pass            — прозрачно проксирует
//   embed_500       — 500 на /embeddings
//   embed_timeout   — не отвечает на /embeddings
//   embed_malformed — 200 с невалидным телом
//   embed_wrong_dim — 200 с векторами другой размерности
//   embed_wrong_model — 200 с другим именем модели
//   chat_500        — 500 на /chat/completions, эмбеддинги проходят
//   chat_rate_limit — 429 на /chat/completions
import http from "node:http";

const target = process.env.PROXY_TARGET ?? "https://litellmru.ds-hub-cf.ru/v1";
const mode = process.env.PROXY_MODE ?? "pass";
const WRONG_DIMENSIONS = 128;

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function forward(request, response, path) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const upstream = await fetch(`${target}${path}`, {
    method: request.method,
    headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
    body: chunks.length ? Buffer.concat(chunks) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const text = await upstream.text();
  response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
  response.end(text);
  return upstream.status;
}

export async function startFaultProxy({ mode: proxyMode = mode, target: proxyTarget = target } = {}) {
  process.env.PROXY_TARGET = proxyTarget;
  const log = [];

  const server = http.createServer(async (request, response) => {
    const path = (request.url ?? "").replace(/^\/v1/, "");
    const isEmbedding = path.endsWith("/embeddings");
    const isChat = path.endsWith("/chat/completions");
    const entry = { mode: proxyMode, path, at: Date.now() };
    log.push(entry);

    try {
      if (isEmbedding) {
        if (proxyMode === "embed_500") {
          entry.status = 500;
          return json(response, 500, { error: { message: "proxy: embeddings unavailable" } });
        }
        if (proxyMode === "embed_timeout") {
          entry.status = "hang";
          // Клиент прервёт запрос по своему таймауту; прокси просто не отвечает.
          request.on("close", () => entry.closedByClient = true);
          return;
        }
        if (proxyMode === "embed_malformed") {
          entry.status = 200;
          return json(response, 200, { model: "EmbeddingsGigaR", data: [{ embedding: "not-a-vector" }] });
        }
        if (proxyMode === "embed_wrong_dim" || proxyMode === "embed_wrong_model") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const data = body.input.map((_text, index) => ({
            index,
            object: "embedding",
            embedding: Array.from({ length: WRONG_DIMENSIONS }, (_value, position) => Math.sin(index + position) / 10),
          }));
          entry.status = 200;
          return json(response, 200, {
            model: proxyMode === "embed_wrong_model" ? "SomeOtherEmbeddingModel" : "EmbeddingsGigaR",
            data,
            object: "list",
          });
        }
      }
      if (isChat && proxyMode === "chat_500") {
        entry.status = 500;
        return json(response, 500, { error: { message: "proxy: chat unavailable" } });
      }
      if (isChat && proxyMode === "chat_rate_limit") {
        entry.status = 429;
        return json(response, 429, { error: { message: "proxy: rate limited" } });
      }
      entry.status = await forward(request, response, path);
    } catch (error) {
      entry.status = "error";
      entry.error = error instanceof Error ? error.name : "unknown";
      if (!response.headersSent) json(response, 502, { error: { message: "proxy: upstream failure" } });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.unref();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    log,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const proxy = await startFaultProxy();
  console.log(JSON.stringify({ listening: proxy.baseUrl, mode }));
}
