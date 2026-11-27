import assert from "node:assert/strict";
import test from "node:test";

import { buildQueries } from "../lib/ai/retrieval.ts";
import {
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

test("near-equal retrieval scores are ordered by raw similarity, not by profession id", async () => {
  // 0.0005 apart is inside the 5% tolerance of the best score, so RRF alone
  // cannot separate them. Raw similarity must decide instead of the id.
  const { hypotheses } = await postprocess(
    [hypothesis("prof_001"), hypothesis("prof_002")],
    context({
      retrievalScores: { prof_001: 0.0320, prof_002: 0.0325 },
      retrievalRawScores: { prof_001: 0.10, prof_002: 0.20 },
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
