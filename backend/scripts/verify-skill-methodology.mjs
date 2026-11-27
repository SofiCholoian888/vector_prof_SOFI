// Проверяет, что в текст карточки профессии попали только навыки со статусом
// matching_eligible === "yes_provisional", по убыванию importance и без весов.
// Запуск из backend/:
//   node --experimental-strip-types scripts/verify-skill-methodology.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

const navigator = read("data/export/navigator.json");
const index = read("data/catalog.index.json");

const skillDictionary = new Set(navigator.skills.map((skill) => skill.skill_id));
const statusCounts = {};
const unknownSkillIds = [];
const expectedTailByProfession = new Map();
let eligibleLinks = 0;

for (const profession of navigator.professions) {
  const links = Array.isArray(profession.skills) ? profession.skills : [];
  for (const link of links) {
    const status = typeof link.matching_eligible === "string" ? link.matching_eligible : "(missing)";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (!skillDictionary.has(link.skill_id)) unknownSkillIds.push(`${profession.profession_id}:${link.skill_id}`);
  }
  const eligible = links
    .filter((link) => link.matching_eligible === "yes_provisional")
    .slice()
    .sort((left, right) => (right.importance ?? 0) - (left.importance ?? 0));
  eligibleLinks += eligible.length;
  expectedTailByProfession.set(
    profession.profession_id,
    eligible.map((link) => [link.name, link.applicability_condition].filter(Boolean).join(" — ")).join(". ")
  );
}

const textByProfession = new Map();
for (const entry of index.entries) {
  if (entry.type !== "profession_core") continue;
  textByProfession.set(entry.metadata.profession_id, entry.metadata?.text_preview ?? "");
}

const weightsByProfession = new Map();
for (const profession of navigator.professions) {
  weightsByProfession.set(
    profession.profession_id,
    (Array.isArray(profession.skills) ? profession.skills : [])
      .flatMap((link) => [link.matching_weight, link.matching_prevalence_weight])
      .filter((value) => typeof value === "number" && Number.isFinite(value))
      .map((value) => String(value))
      // Значения вида 0 или 1 — обычные числа в тексте, ищем только точные веса.
      .filter((value) => value.includes(".") && value.length >= 5)
  );
}

const tailMismatches = [];
const weightLeaks = [];
let professionsWithSkills = 0;

for (const [professionId, expectedTail] of expectedTailByProfession) {
  const text = textByProfession.get(professionId) ?? "";
  if (expectedTail) professionsWithSkills += 1;
  if (!expectedTail) continue;
  if (!text.endsWith(`. ${expectedTail}`)) {
    tailMismatches.push({ professionId, expectedTail: expectedTail.slice(0, 120), actualTail: text.slice(-120) });
  }
  // Числовые веса в текст не попадают: сверяем с исходными значениями связей.
  for (const weight of weightsByProfession.get(professionId) ?? []) {
    if (weight && text.includes(weight)) weightLeaks.push(`${professionId}:${weight}`);
  }
}

const totalLinks = Object.values(statusCounts).reduce((sum, value) => sum + value, 0);
const report = {
  professionCount: navigator.professions.length,
  totalSkillLinks: totalLinks,
  statusCounts,
  eligibleLinks,
  unknownSkillIds,
  professionsWithSkills,
  // Текст карточки заканчивается ровно списком разрешённых навыков, поэтому
  // лишняя, запрещённая или переупорядоченная связь ломает сверку.
  tailMismatches,
  weightLeaks,
  ok:
    unknownSkillIds.length === 0 &&
    tailMismatches.length === 0 &&
    weightLeaks.length === 0 &&
    eligibleLinks === 588 &&
    totalLinks === 677 &&
    statusCounts.conditional_scope === 80 &&
    statusCounts.no_pending_review === 9,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
