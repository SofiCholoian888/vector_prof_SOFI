/** Restore input order using the gateway's batch-local indices. */
export function readEmbeddingBatch(
  result: { model?: unknown; data?: Array<{ index?: unknown; embedding?: unknown }> },
  model: string,
  count: number,
  dimensions: number
): number[][] {
  if (result?.model !== undefined && result.model !== model) throw new Error("Embedding model mismatch");
  if (!Array.isArray(result?.data) || result.data.length !== count) throw new Error("Embedding count mismatch");
  const vectors: number[][] = new Array(count);
  for (const row of result.data) {
    const index = row?.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count || vectors[index]) {
      throw new Error("Invalid embedding response index");
    }
    const vector = row.embedding;
    if (!Array.isArray(vector) || vector.length !== dimensions ||
        !vector.every(Number.isFinite) || !vector.some((value) => value !== 0)) {
      throw new Error("Invalid embedding vector");
    }
    vectors[index] = vector;
  }
  return vectors;
}
