import assert from "node:assert/strict";
import test from "node:test";

import { generateValidatedResponse } from "../lib/ai/generate.ts";
import type { ValidationContext } from "../lib/ai/validate.ts";
import { prepareSofiInput } from "../lib/sofi-adapter.ts";
import { runSofiPipeline } from "../lib/sofi-pipeline.ts";

const context: ValidationContext = {
  tier: "9-11",
  catalogProfessionIds: new Set(["prof_001"]),
  candidateProfessionIds: new Set(["prof_001"]),
  industryIds: new Set(["ind_001"]),
  answerRefs: new Set(["A1"]),
  candidateEvidenceRefs: { prof_001: new Set(["A1"]) },
  professionIndustryById: { prof_001: "ind_001" },
  candidateTrialIds: { prof_001: new Set(["trial_024"]) },
  candidateProgramIds: { prof_001: new Set() },
  activityTypes: new Set(),
};

const why = "Интерес к ремонту механизмов можно проверить на практике. Инженер-механик ищет причины поломок оборудования.";
const payload = {
  schema_version: "1.0.0", status: "ok", summary: "Тебе интересно, как устроены механизмы.",
  next_step: "Рассмотри схему станка.", warnings: [],
  path_note: "Очень ".repeat(30) + "длинная рекомендация.",
  industries: [{ industry_id: "ind_001", why: "Поддерживает интерес.", evidence_refs: [] }],
  hypotheses: [{
    profession_id: "prof_001", industry_id: "ind_001", why, evidence_refs: ["A1"],
    activity_links: [{ type: "trial_099", evidence_refs: ["A1"] }],
    match_strength: "moderate", what_to_try: "Найди узлы на чертеже.",
    trial_ids: ["trial_024", "trial_999"], program_ids: ["prog_999"], watch_out: "",
  }],
};

test("a transient chat timeout gets a second attempt within the deadline without exposing invalid links", async () => {
  let calls = 0;
  const generated = await generateValidatedResponse({
    async chat() {
      if (++calls === 1) throw new Error("LLM_FAILED_ALL_ATTEMPTS: ECONNABORTED");
      return { text: JSON.stringify(payload), latencyMs: 1 };
    },
  }, [], context, Date.now() + 10000);
  const data = generated.validation.data;
  assert.equal(generated.attempts, 2);
  assert.ok("hypotheses" in data && "path_note" in data);
  assert.equal(data.hypotheses[0].why, why);
  assert.deepEqual(data.hypotheses[0].trial_ids, ["trial_024"]);
  assert.deepEqual(data.hypotheses[0].program_ids, []);
  assert.deepEqual(data.hypotheses[0].activity_links, []);
  assert.deepEqual(data.industries, []);
  assert.equal(data.path_note, "");
});

test("optional metadata repair does not make unsupported evidence valid", async () => {
  const answer = { ...payload, hypotheses: [{ ...payload.hypotheses[0], evidence_refs: ["A99"] }] };
  await assert.rejects(generateValidatedResponse({
    async chat() {
      return { text: JSON.stringify(answer), latencyMs: 1 };
    },
  }, [], context, Date.now() + 10000), /LLM_VALIDATION_FAILED.*A99/);
});

test("lexical fallback ranks a changed interest above the repeated generic answer", async (t) => {
  t.mock.method(console, "log", () => {});
  const oldModel = process.env.LLM_EMBEDDINGS_MODEL;
  const oldMock = process.env.USE_MOCK_EMBEDDINGS;
  delete process.env.LLM_EMBEDDINGS_MODEL;
  process.env.USE_MOCK_EMBEDDINGS = "false";
  t.after(() => {
    if (oldModel === undefined) delete process.env.LLM_EMBEDDINGS_MODEL;
    else process.env.LLM_EMBEDDINGS_MODEL = oldModel;
    if (oldMock === undefined) delete process.env.USE_MOCK_EMBEDDINGS;
    else process.env.USE_MOCK_EMBEDDINGS = oldMock;
  });
  const pairs = [
    ["Хочу проектировать механизмы, ремонтировать станки и разбираться в оборудовании", "ind_001"],
    ["Хочу создавать логотипы, макеты книг и оформление плакатов", "ind_012"],
    ["Хочу выращивать сельскохозяйственные растения, изучать плодородие и повышать урожайность", "ind_015"],
    ["Хочу измерять загрязнение воды и воздуха и проводить экологический мониторинг", "ind_016"],
  ];
  for (const [interest, expected] of pairs) {
    const prepared = prepareSofiInput({
      profile: { schoolGrade: 8, municipality: "Екатеринбург" },
      diagnosticAnswers: [
        { questionId: "future_direction", answer: interest },
        { questionId: "tasks", answer: "Хочу попробовать реальную задачу и обсудить, что получилось" },
      ],
    });
    const result = await runSofiPipeline({ prepared, professions: [] }, { retrievalOnly: true });
    assert.equal(result.generation?.retrievalMode, "lexical");
    const hypothesis = result.hypotheses?.[0] as { industry_id: string } | undefined;
    assert.equal(hypothesis?.industry_id, expected);
  }
});
