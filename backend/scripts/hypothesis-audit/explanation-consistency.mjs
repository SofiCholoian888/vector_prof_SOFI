// Проверяет два свойства качества гипотез на уже собранных JSONL:
//  1) объяснение опирается на ответы школьника, а не на общие слова;
//  2) ссылки evidence существуют в анкете и не выдуманы.
//
// Запуск из backend:
//   node scripts/hypothesis-audit/explanation-consistency.mjs \
//     --files=audit-results/semantic/instruct-plain.jsonl [--out=...json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map(
  process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);
const files = (args.get("files") ?? "audit-results/semantic/instruct-plain.jsonl").split(",");
const outFile = args.get("out") ? path.resolve(root, args.get("out")) : null;

function normalize(text) {
  return String(text ?? "").toLowerCase().replace(/[«»"'`]/g, "").replace(/\s+/g, " ").trim();
}

const summary = [];
for (const file of files) {
  const full = path.resolve(root, file);
  const records = fs.readFileSync(full, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  let hypotheses = 0;
  let refsValid = 0;
  let whyMentionsAnswer = 0;
  let whyNonEmpty = 0;
  const problems = [];

  for (const record of records) {
    const dossierRefs = new Set((record.answers ?? []).map((answer) => answer.ref));
    const answerTexts = (record.answers ?? []).map((answer) => normalize((answer.selected ?? []).join(" ")));
    for (const hypothesis of record.hypotheses ?? []) {
      hypotheses += 1;
      const refs = hypothesis.evidence_refs ?? [];
      const refsOk = refs.length > 0 && refs.every((ref) => dossierRefs.has(ref));
      if (refsOk) refsValid += 1;
      else problems.push(`${record.profile}:${hypothesis.id} refs=${JSON.stringify(refs)}`);

      const why = normalize(hypothesis.why);
      if (why) whyNonEmpty += 1;
      const selected = (hypothesis.evidence_selected ?? []).flat().map(normalize).filter((text) => text.length > 3);
      const mentions = selected.some((text) => why.includes(text)) || answerTexts.some((text) => text.length > 3 && why.includes(text));
      if (mentions) whyMentionsAnswer += 1;
    }
  }

  summary.push({
    file,
    records: records.length,
    hypotheses,
    evidenceRefsValid: hypotheses ? Number((refsValid / hypotheses).toFixed(3)) : null,
    whyNonEmpty: hypotheses ? Number((whyNonEmpty / hypotheses).toFixed(3)) : null,
    whyMentionsAnswer: hypotheses ? Number((whyMentionsAnswer / hypotheses).toFixed(3)) : null,
    problems: problems.slice(0, 10),
  });
}

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify({ generatedAtUtc: new Date().toISOString(), summary }, null, 2)}\n`);
}
console.log(JSON.stringify(summary, null, 2));
