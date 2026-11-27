import { stemmer } from "@orama/stemmers/russian";

const stopWords = new Set(
  ("это как что чем для чтобы уже или его они она этих этим себе своих свои " +
    "хочу любить люблю нравятся нравится интересно интересует заниматься делать стать " +
    "попробовать работать работа задача задачи профессия направление будущее получилось " +
    "разбираться узнать изучать создавать проводить обсуждать делать реальные реальный").match(/\p{L}+/gu)?.map(stemmer)
);

function terms(text: string): Set<string> {
  const tokens = text.toLowerCase().replaceAll("ё", "е").match(/[а-яa-z][а-яa-z0-9]{1,}/g) ?? [];
  return new Set(tokens.map((token) =>
    /^[а-я]+$/.test(token) ? stemmer(token) : token
  ).filter((token) => !stopWords.has(token)));
}

export function buildLexicalIndex(documents: Array<{ id: string; text: string; primaryText?: string }>) {
  const byId = new Map(documents.map(({ id, text }) => [id, terms(text)]));
  const primaryById = new Map(documents.map(({ id, primaryText }) => [id, terms(primaryText ?? "")]));
  const frequencies = new Map<string, number>();
  for (const vocabulary of byId.values()) {
    for (const term of vocabulary) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  const prefixesById = new Map([...byId].map(([id, vocabulary]) => [id,
    new Set([...vocabulary].filter((term) => term.length >= 6).map((term) => term.slice(0, 6))),
  ]));
  const averageLength = [...byId.values()].reduce((sum, vocabulary) => sum + vocabulary.size, 0) /
    Math.max(1, byId.size);

  return (query: string) => {
    // Unknown terms cannot support a match. Document frequency is computed
    // from the runtime catalog, so common vocabulary carries less weight.
    const weights = [...terms(query)].flatMap((term) => {
      const frequency = frequencies.get(term);
      return frequency === undefined ? [] : [{
        term, idf: Math.log1p((byId.size - frequency + 0.5) / (frequency + 0.5)) ** 2,
      }];
    });
    const total = weights.reduce((sum, term) => sum + term.idf, 0);
    return (id: string) => {
      const vocabulary = byId.get(id);
      if (!vocabulary || total === 0) return 0;
      const primary = primaryById.get(id);
      const matched = weights.reduce((sum, { term, idf }) =>
        sum + (vocabulary.has(term) ? idf * (primary?.has(term) ? 2 : 1)
          : term.length >= 6 && prefixesById.get(id)?.has(term.slice(0, 6)) ? idf * 0.35 : 0), 0);
      const lengthPenalty = Math.sqrt(1 + vocabulary.size / averageLength);
      return matched / (2 * total * lengthPenalty);
    };
  };
}
