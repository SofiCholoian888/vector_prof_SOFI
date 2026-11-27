// IDs from the active BvB and clarification banks. Free text on other
// situational questions describes a preferred activity unless specified here.
const questionSignals = {
  interest: ["bilet_q16_future_direction", "bilet_q32_future_direction", "bilet_q34_future_direction",
    "elementary_q2_free_time", "elementary_q3_dream_profession", "elementary_q4_curious",
    "elementary_q5_books_cartoons", "elementary_q7_interesting_profession", "elementary_q8_want_to_learn",
    "elementary_q11_dream", "elementary_q12_nature_interest", "elementary_q13_future_direction",
    "agent_q1_likes", "future_direction"],
  education_context: ["bilet_q1_subjects", "bilet_q2_profile", "elementary_q1_subjects"],
  experience: ["agent_q4_experience"],
  work_preference: ["agent_q2_work_style"],
  constraint: ["agent_q5_format", "agent_q6_constraints"],
  decision_readiness: ["bilet_q3_events", "bilet_q4_decision", "bilet_q5_readiness"],
} as const;

export type SignalType = keyof typeof questionSignals | "preferred_activity" | "uninformative";

export function signalType(questionId: string): SignalType {
  for (const [type, ids] of Object.entries(questionSignals)) {
    if ((ids as readonly string[]).includes(questionId)) return type as SignalType;
  }
  return "preferred_activity";
}

export function isInformativeChoice(value: string): boolean {
  return !/^(?:другое|other|true|false|не знаю|не уверен(?:\(а\)|а)?|не определил(?:ся|ась|\(а\))?|не думал(?:\(а\)|а)?|ничего не подходит|нет опыта|пока ничего|не пробовал(?:\(а\)|а)?|\d+)[.!? ]*$/iu.test(value.trim());
}

export function isCareerSignal(type: SignalType): boolean {
  return type !== "constraint" && type !== "decision_readiness" && type !== "uninformative";
}
