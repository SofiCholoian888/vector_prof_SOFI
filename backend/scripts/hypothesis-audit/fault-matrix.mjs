// Матрица отказов: каждый сценарий выполняется отдельным процессом, чтобы
// кэш и переменные окружения одного прогона не влияли на другой.
//
// Запуск из backend (нужны LLM_BASE_URL, LLM_API_KEY, LLM_EMBEDDINGS_MODEL):
//   node scripts/hypothesis-audit/fault-matrix.mjs \
//     --profiles=15,7 --out=audit-results/semantic/fault-matrix.jsonl
import { spawn } from "node:child_process";
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

const profiles = (args.get("profiles") ?? "15,7").split(",").map(Number);
const outFile = path.resolve(root, args.get("out") ?? "audit-results/semantic/fault-matrix.jsonl");

const scenarios = [
  { id: "pass", expectRetrieval: "semantic" },
  { id: "embed_500", expectRetrieval: "lexical" },
  { id: "embed_timeout", expectRetrieval: "lexical" },
  { id: "embed_malformed", expectRetrieval: "lexical" },
  { id: "embed_wrong_dim", expectRetrieval: "lexical" },
  { id: "embed_wrong_model", expectRetrieval: "lexical" },
  { id: "chat_500", expectRetrieval: "semantic", expectGeneration: "retrieval_only" },
  { id: "chat_rate_limit", expectRetrieval: "semantic", expectGeneration: "retrieval_only" },
  { id: "no_credentials", expectRetrieval: "lexical" },
];

function runCase(scenario, profile) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./tests/register-app-alias.mjs",
        "scripts/hypothesis-audit/fault-case.mjs",
        `--scenario=${scenario}`,
        `--profile=${profile}`,
      ],
      { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      const lines = stdout.trim().split("\n").filter((line) => line.startsWith("{"));
      let record = null;
      try { record = JSON.parse(lines.at(-1) ?? ""); } catch { record = null; }
      resolve({ code, record, stderr: stderr.slice(-500) });
    });
  });
}

const rows = [];
for (const profile of profiles) {
  for (const scenario of scenarios) {
    const { code, record, stderr } = await runCase(scenario.id, profile);
    const row = record ?? { scenario: scenario.id, profile, error: `case failed: ${stderr}` };
    const problems = [];
    if (code !== 0) problems.push("case_exit");
    if (!row.error && row.retrievalMode !== scenario.expectRetrieval) {
      problems.push(`retrieval_mode=${row.retrievalMode}`);
    }
    if (scenario.expectGeneration && row.generationMode !== scenario.expectGeneration) {
      problems.push(`generation_mode=${row.generationMode}`);
    }
    if (!row.error && (row.hypothesisCount ?? 0) === 0) problems.push("empty_hypotheses");
    rows.push({ ...row, expectedRetrieval: scenario.expectRetrieval, problems });
    console.log(
      `${scenario.id.padEnd(18)} profile=${String(profile).padStart(2)} ` +
      `retrieval=${String(row.retrievalMode).padEnd(8)} generation=${String(row.generationMode).padEnd(14)} ` +
      `hypotheses=${String(row.hypothesisCount).padStart(2)} ms=${String(row.durationMs).padStart(6)} ` +
      `${problems.length ? `PROBLEMS=${problems.join(",")}` : "ok"}`
    );
  }
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

const failed = rows.filter((row) => row.problems.length > 0);
console.log(JSON.stringify({ scenarios: scenarios.length, profiles, rows: rows.length, failed: failed.length, out: path.relative(root, outFile) }));
process.exit(failed.length === 0 ? 0 : 1);
