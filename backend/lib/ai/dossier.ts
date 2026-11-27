import { isCoveredMunicipality } from "./municipality";
import { isCareerSignal, isInformativeChoice, signalType, type SignalType } from "./signals";
// lib/ai/dossier.ts
import patterns from "@/config/validation_patterns.json" with { type: "json" };
import agePolicy from "@/config/age_policy.json" with { type: "json" };
import questionMaster from "@/data/bilet_questions_master.json" with { type: "json" };
import clarificationMaster from "@/data/agent_clarification.json" with { type: "json" };
import primaryClarificationMaster from "@/data/agent_clarification_1-4.json" with { type: "json" };

// ---------- Типы (из задания) ----------
export type DossierAnswer = {
  ref: string;                 // "A1"
  source: "bilet" | "agent";
  question: string;
  questionId: string;
  questionnaire: string;
  selected: string[];
  signalType?: SignalType;
};

export type Dossier = {
  student: { tier: "1-4" | "5-8" | "9-11"; grade: number; in_region: boolean; municipality?: string };
  answers: DossierAnswer[];
  constraints: Record<string, string | boolean>;
  emptyShare: number;
  warnings: string[];
};

// Сырой ответ из БД
export type RawAnswer = {
  questionnaire?: string | null;
  question_id: string;
  answer: unknown; // JSONB, может быть строкой, массивом или объектом
};

// Контекст ученика
export type StudentContext = {
  school_grade: number;
  municipality: string;
};

// ---------- Утилиты ----------

// 2. Нормализация анкеты (trim)
function normalizeQuestionnaire(q: string): string {
  return q.trim();
}

// 3. Проверка «ничего не подходит» (регистронезависимо)
function isNothingFits(value: string): boolean {
  const normalized = patterns.nothing_fits_trim_whitespace ? value.trim() : value;
  const target = patterns.nothing_fits_case_insensitive ? normalized.toLowerCase() : normalized;

  return patterns.nothing_fits.some((p) => {
    const np = patterns.nothing_fits_trim_whitespace ? p.trim() : p;
    const tp = patterns.nothing_fits_case_insensitive ? np.toLowerCase() : np;
    return tp === target;
  });
}

// 3. Проверка проверочных вопросов (attention check)
function isAttentionCheck(questionId: string): boolean {
  if (patterns.attention_check_ids.includes(questionId)) return true;
  return patterns.attention_check_suffixes.some((suffix) => questionId.endsWith(suffix));
}

// 4. Структурные значения, которые уходят в constraints
function extractConstraints(answer: unknown): Record<string, string | boolean> | null {
  if (typeof answer === "object" && answer !== null && !Array.isArray(answer)) {
    const obj = answer as Record<string, unknown>;
    const constraints: Record<string, string | boolean> = {};
    let hasConstraint = false;

    // Если есть ключи free_only, time_limit и т.д.
    for (const key of Object.keys(obj)) {
      if (["free_only", "time_limit", "format", "place"].includes(key)) {
        const val = obj[key];
        if (typeof val === "boolean" || typeof val === "string") {
          constraints[key] = val;
          hasConstraint = true;
        }
      }
    }
    return hasConstraint ? constraints : null;
  }
  return null;
}

// 5. Фильтр свободного текста (prompt injection, ПД, длина > 200)
function sanitizeFreeText(text: string): string | null {
  if (typeof text !== "string") return null;

  // Обрезаем до 200 символов
  const sanitized = text.trim().slice(0, 200);

  // Фильтр на prompt injection (расширен русскими паттернами из Chaos-теста)
  const injectionPatterns = [
    /ignore\s+previous/i,
    /system\s+prompt/i,
    /you\s+are\s+now/i,
    /забудь\s+все/i,
    /забудь\s+правила/i,
    /игнорируй\s+правила/i, // Ловит фразу из теста
    /новые\s+правила/i,
    /назови\s+\d+\s+профессий/i, // Ловит "назови 10 профессий"
    /assistant\s*:/i,
    /user\s*:/i,
  ];
  if (injectionPatterns.some((re) => re.test(sanitized))) {
    return null; // выбрасываем подозрительный текст
  }

  // Простейший фильтр на ПД (email, телефон)
  const pdPatterns = [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email
    /\+?\d[\d\s\-()]{8,}\d/,                               // телефон
  ];
  if (pdPatterns.some((re) => re.test(sanitized))) {
    return null; // выбрасываем ПД
  }

  return sanitized.length > 0 ? sanitized : null;
}

// 1. Ключ вопроса (анкета, question_id) — по факту, мы уже группируем по question_id.
// В самом досье ключ не нужен, но для дедупликации — да.
function makeQuestionKey(questionnaire: string, questionId: string): string {
  return `${normalizeQuestionnaire(questionnaire)}:${questionId}`;
}

function getQuestionText(questionnaire: string, questionId: string, grade: number): string {
  if (questionnaire === "agent_clarification") {
    const master = grade <= 4 ? primaryClarificationMaster : clarificationMaster;
    return master.agent_clarification_questions.find((q) => q.question_id === questionId)?.text ?? questionId;
  }
  const configured = questionMaster.questionnaires.find(
    (item) => item.questionnaire_name === questionnaire
  );
  const question = configured?.blocks
    .flatMap((block) => block.questions)
    .find((item) => item.id === questionId);
  return question?.text ?? questionId;
}

// ---------- Основная функция ----------

export function buildDossier(
  rawAnswers: RawAnswer[],
  student: StudentContext,
  // справочник вопросов: question_id -> { text: string, questionnaire: string }
  // В реальном проекте это можно брать из bilet_questions_master.json или из БД
  questionsDict: Record<string, Record<string, { text: string }>> = {}
): Dossier {
  // 1. Определяем tier
  const tier = determineTier(student.school_grade);
  const in_region = isCoveredMunicipality(student.municipality);

  const answers: DossierAnswer[] = [];
  const constraints: Record<string, string | boolean> = {};
  const seenKeys = new Set<string>();
  const warnings = new Set<string>();
  let significantQuestionCount = 0;
  let emptyQuestionCount = 0;
  let refCounter = 1;

  for (const raw of rawAnswers) {
    const questionnaire = normalizeQuestionnaire(raw.questionnaire ?? "");
    const questionId = raw.question_id;

    // 1. Ключ для дедупликации
    const key = makeQuestionKey(questionnaire, questionId);
    if (seenKeys.has(key)) continue; // если дубликат — пропускаем
    seenKeys.add(key);

    // 3. Отсеиваем attention check
    if (isAttentionCheck(questionId)) continue;

    // 4. Пробуем извлечь constraints (структурные значения)
    const extracted = extractConstraints(raw.answer);
    if (extracted) {
      Object.assign(constraints, extracted);
      continue; // в досье не добавляем
    }

    if (
      patterns.validation_questions.some((question) => question.id === questionId) ||
      questionId.startsWith("validation_")
    ) {
      continue;
    }
    significantQuestionCount++;

    // Приводим ответ к массиву строк
    let selectedStrings: string[] = [];
    if (Array.isArray(raw.answer)) {
      selectedStrings = raw.answer.filter((x) => typeof x === "string") as string[];
    } else if (typeof raw.answer === "string") {
      selectedStrings = [raw.answer];
    } else if (typeof raw.answer === "number") {
      selectedStrings = [String(raw.answer)];
    }

    // 3. Отсеиваем «ничего не подходит»
    selectedStrings = selectedStrings.filter((s) => !isNothingFits(s));
    if (selectedStrings.length === 0) {
      emptyQuestionCount++;
    }
    if (selectedStrings.length === 0) continue; // если ничего не осталось — пропускаем

    // 5. Обрабатываем «Другое» (свободный текст)
    selectedStrings = selectedStrings
      .map((s) => {
        if (s.toLowerCase() === "другое") {
          return null;
        }
        const sanitized = sanitizeFreeText(s);
        if (sanitized === null) warnings.add("untrusted_input_ignored");
        return sanitized;
      })
      .filter((s): s is string => s !== null);

    if (selectedStrings.length === 0) continue;

    if (questionnaire === "agent_clarification") {
      const master = student.school_grade <= 4 ? primaryClarificationMaster : clarificationMaster;
      const question = master.agent_clarification_questions.find((q) => q.question_id === questionId);
      if (question) {
        selectedStrings = selectedStrings.map((value) => question.options.find((option) => option.value === value)?.label ?? value);
      }
    }

    const type = signalType(questionId);
    if (type === "constraint") {
      // Read option codes separately from their display labels.
      const values = Array.isArray(raw.answer) ? raw.answer : [raw.answer];
      if (questionId === "agent_q5_format") {
        const format = values.find((value) => value === "online" || value === "offline" || value === "any");
        if (typeof format === "string") constraints.format = format;
      } else {
        for (const key of ["free_only", "time_limit"]) {
          if (values.includes(key)) constraints[key] = true;
        }
        if (values.includes("location") || values.includes("near_home")) constraints.place = "near_home";
      }
    }
    selectedStrings = selectedStrings.filter((value) => isInformativeChoice(value) &&
      (type !== "experience" || !/^(?:none|пока ничего из этого не пробовал)/iu.test(value)));
    if (!selectedStrings.length) {
      emptyQuestionCount++;
      continue;
    }

    // Получаем текст вопроса
    const qText =
      questionsDict[questionnaire]?.[questionId]?.text ??
      getQuestionText(questionnaire, questionId, student.school_grade);

    // 6. Добавляем в досье с ref
    answers.push({
      ref: `A${refCounter++}`,
      source: questionnaire.toLowerCase().includes("билет") || questionnaire.startsWith("mock_") || questionnaire.startsWith("bilet_") ? "bilet" : "agent",
      question: qText,
      questionId,
      questionnaire,
      selected: selectedStrings,
      signalType: type,
    });
  }

  return {
    student: { tier, grade: student.school_grade, in_region, municipality: student.municipality },
    answers,
    constraints,
    emptyShare: significantQuestionCount === 0 ? 0 : emptyQuestionCount / significantQuestionCount,
    warnings: [...warnings],
  };
}

// ---------- Вспомогательные ----------

function determineTier(grade: number): "1-4" | "5-8" | "9-11" {
  for (const t of agePolicy.tiers) {
    if (grade >= t.grade[0] && grade <= t.grade[1]) {
      return t.id as "1-4" | "5-8" | "9-11";
    }
  }
  // fallback для 1-11
  return "5-8";
}
export function careerAnswers(dossier: Dossier): DossierAnswer[] {
  return dossier.answers.filter((answer) => isCareerSignal(answer.signalType ?? signalType(answer.questionId)));
}
