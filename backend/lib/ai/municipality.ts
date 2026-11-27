// Municipalities covered by the regional opportunity catalog. Unknown names
// remain outside this coverage, so they cannot unlock local-only activities.
const covered = new Set([
  "екатеринбург", "нижний тагил", "каменск-уральский", "первоуральск", "верхняя пышма",
  "асбест", "серов", "краснотурьинск", "полевской", "тавда", "с. рудянское", "с. костино",
  "артемовский", "верхняя синячиха", "березовский", "ревда", "североуральск",
  "верхняя тура", "сухой лог", "ачитский муниципальный округ", "ирбит", "новоуральск",
  "красноуфимск",
]);

export function normalizeMunicipality(value: string) {
  return value.trim().toLowerCase().replaceAll("ё", "е").replace(/\s+/g, " ");
}

export function isCoveredMunicipality(value: string) {
  return covered.has(normalizeMunicipality(value));
}
