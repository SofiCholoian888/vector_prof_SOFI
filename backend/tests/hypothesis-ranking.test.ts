import assert from "node:assert/strict";
import test from "node:test";

import { buildQueries } from "../lib/ai/retrieval.ts";
import {
  compareProfessionRank,
  evidenceReason,
  postprocess,
  type PostprocessContext,
} from "../lib/ai/postprocess.ts";

const candidate = (id: string, name: string, industryId = "ind_001") => ({
  industry_id: industryId,
  name,
  trials: [],
  programs: [],
  trial_ids: [],
  program_ids: [],
});

function context(overrides: Partial<PostprocessContext>): PostprocessContext {
  return {
    tier: "9-11",
    dossierRefs: new Set(["A1"]),
    answersMap: { A1: { question: "Чем нравится заниматься?", questionId: "q1", selected: ["Чинить механизмы"] } },
    candidatesMap: {
      prof_001: candidate("prof_001", "Инженер-механик"),
      prof_002: candidate("prof_002", "Инженер-конструктор"),
      prof_003: candidate("prof_003", "Оператор станков"),
    },
    industriesMap: { ind_001: "Машиностроение" },
    industryIds: new Set(["ind_001"]),
    emptyShare: 0,
    coverageGap: false,
    inRegion: true,
    catalogVersion: "test",
    ...overrides,
  };
}

function hypothesis(id: string) {
  return {
    profession_id: id,
    industry_id: "ind_001",
    why: "Связано с ответами.",
    evidence_refs: ["A1"],
    match_strength: "moderate" as const,
    what_to_try: "Посмотреть, как работает мастерская.",
    trial_ids: [],
  };
}

test("nonidentical RRF scores outrank raw similarity", async () => {
  const { hypotheses } = await postprocess(
    [hypothesis("prof_001"), hypothesis("prof_002")],
    context({
      retrievalScores: { prof_001: 0.0320, prof_002: 0.0325 },
      retrievalRawScores: { prof_001: 0.30, prof_002: 0.20 },
    })
  );
  assert.deepEqual(hypotheses.map((item) => item.profession_id), ["prof_002", "prof_001"]);
});

test("a retrieval score gap wider than the tolerance wins over raw similarity", async () => {
  const { hypotheses } = await postprocess(
    [hypothesis("prof_001"), hypothesis("prof_002")],
    context({
      retrievalScores: { prof_001: 0.045, prof_002: 0.030 },
      retrievalRawScores: { prof_001: 0.10, prof_002: 0.20 },
    })
  );
  assert.deepEqual(hypotheses.map((item) => item.profession_id), ["prof_001", "prof_002"]);
});

test("identical signals keep a deterministic id order", async () => {
  const { hypotheses } = await postprocess(
    [hypothesis("prof_002"), hypothesis("prof_001")],
    context({
      retrievalScores: { prof_001: 0.03, prof_002: 0.03 },
      retrievalRawScores: { prof_001: 0.2, prof_002: 0.2 },
    })
  );
  assert.deepEqual(hypotheses.map((item) => item.profession_id), ["prof_001", "prof_002"]);
});

const dossierWith = (question: string, questionId: string, selected: string[]) => ({
  student: { tier: "9-11" as const, grade: 10, in_region: true },
  answers: [{
    ref: "A1",
    source: "bilet" as const,
    question,
    questionId,
    questionnaire: "Билет в будущее (10 класс)",
    selected,
  }],
  constraints: {},
  emptyShare: 0,
  warnings: [],
});

test("retrieval queries embed the chosen answers without the question wording", () => {
  const queries = buildQueries(dossierWith("Что тебе нравится делать?", "q_activity", ["Чинить механизмы"]));
  const parts = queries.flatMap((query) => query.parts);
  assert.ok(parts.includes("Чинить механизмы"));
  assert.ok(parts.every((part) => !part.includes("нравится")));
});

test("process questions about events, decisions and readiness do not shape the query", () => {
  const queries = buildQueries(
    dossierWith("В каких профориентационных мероприятиях участвовал?", "bilet_q3_events", ["Профпробы в колледже"])
  );
  assert.deepEqual(queries.flatMap((query) => query.parts), []);
});

test("the visible reason quotes the answers behind the hypothesis", async () => {
  const { hypotheses } = await postprocess(
    [hypothesis("prof_001")],
    context({ retrievalScores: { prof_001: 0.03 }, retrievalRawScores: { prof_001: 0.2 } })
  );
  const reason = evidenceReason(hypotheses[0]);
  assert.match(reason, /Чинить механизмы/);
  assert.match(reason, /Инженер-механик/);
});

test("ranking comparator is antisymmetric, transitive and independent of candidate order", () => {
  const ids = ["prof_001", "prof_002", "prof_003"];
  const ctx = { retrievalScores: { prof_001: 0.03, prof_002: 0.031, prof_003: 0.032 },
    retrievalRawScores: { prof_001: 0.7, prof_002: 0.2, prof_003: 0.1 } };
  const compare = (a: string, b: string) => compareProfessionRank(a, b, ctx);
  assert.deepEqual([...ids].sort(compare), [...ids].reverse().sort(compare));
  assert.deepEqual([].sort(compare), []);
  for (const a of ids) for (const b of ids) {
    assert.equal(Math.sign(compare(a, b)) + Math.sign(compare(b, a)), 0);
    for (const c of ids) {
      if (compare(a, b) <= 0 && compare(b, c) <= 0) assert.ok(compare(a, c) <= 0);
    }
  }
});

test("preferred methods of solving tasks reach retrieval and logistics do not", () => {
  const task = dossierWith("Как тебе нравится решать задачи?", "agent_q3_tasks", ["Собирать механизмы"]);
  assert.ok(buildQueries(task).some((query) => query.parts.includes("Собирать механизмы")));
  assert.deepEqual(buildQueries(dossierWith("Где удобно заниматься?", "agent_q5_format", ["Онлайн за компьютером"])), []);
  assert.deepEqual(buildQueries(dossierWith("Что тебе интересно?", "agent_q1_likes", ["Другое"])), []);
});

test("zero RIASEC dimensions are omitted from profession evidence", async () => {
  const ctx = context({});
  ctx.candidatesMap.prof_001.riasec_profile = { I:1, R:0.6667, S:0, A:0, E:0, C:0 };
  const result = await postprocess([hypothesis("prof_001")], ctx);
  assert.equal(result.hypotheses[0].explainability?.riasec_types.length, 2);
});

test("equal RRF prefers the higher raw similarity even when the ID sorts later", () => {
  const scores = { prof_001: 0.031, prof_002: 0.031 };
  assert.ok(compareProfessionRank("prof_002", "prof_001", {
    retrievalScores: scores, retrievalRawScores: { prof_001: 0.2, prof_002: 0.4 },
  }) < 0);
});

test("fallback considers candidates after the first five before capping each industry", async () => {
  const { buildFallbackResponse } = await import("../lib/ai/fallback.ts");
  const ctx = context({
    industryIds: new Set(["ind_001", "ind_002"]),
    dossierRefs: new Set(["A1", "A2"]),
    answersMap: {
      A1: { question:"Интерес", selected:["Чинить механизмы"] },
      A2: { question:"Деятельность", selected:["Чертить схему"] },
    },
  });
  const ids = ["p1","p2","p3","p4","p5","p6"];
  ctx.candidatesMap = Object.fromEntries(ids.map((id, index) =>
    [id, candidate(id, id, index < 5 ? "ind_001" : "ind_002")]
  ));
  const dossier = dossierWith("Что интересно?", "future_direction", ["Чинить механизмы"]);
  dossier.answers.push({ ...dossier.answers[0], ref:"A2", questionId:"task", selected:["Чертить схему"] });
  const result = await buildFallbackResponse({
    dossier, ctx,
    retrieval: {
      industryIds:[], industryScores:{}, professionIds:ids,
      professionScores:Object.fromEntries(ids.map((id,index) => [id, 1/(index+1)])),
      professionSources:{}, professionRawScores:{}, coverageGap:false, uncoveredAnswerRefs:[],
      mode:"lexical", warnings:[], evidence:Object.fromEntries(ids.map((id) => [id, ["A1","A2"]])),
    },
  });
  assert.deepEqual(result.hypotheses.map((item) => item.profession_id), ["p1","p2","p6"]);
  assert.ok(result.hypotheses.every((item) => item.confidence?.level === "low"));
});
