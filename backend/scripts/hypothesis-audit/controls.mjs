// Expected industries and relevant profession sets are specified before scoring.
const themes = {
  mechanisms: ["ind_001", ["prof_001", "prof_002", "prof_003"], "Хочу проектировать механизмы, ремонтировать станки и разбираться в оборудовании"],
  design: ["ind_012", ["prof_020", "prof_021"], "Хочу создавать логотипы, макеты книг и оформление плакатов"],
  crops: ["ind_015", ["prof_150"], "Хочу выращивать сельскохозяйственные растения, изучать плодородие и повышать урожайность"],
  ecology: ["ind_016", ["prof_090", "prof_151"], "Хочу измерять загрязнение воды и воздуха и проводить экологический мониторинг"],
  laboratory: ["ind_009", ["prof_026"], "Хочу работать с реактивами в химической лаборатории и проверять свойства веществ"],
  code: ["ind_003", ["prof_006", "prof_008", "prof_009", "prof_010"], "Хочу программировать приложения, писать код и искать ошибки в программах"],
  social: ["ind_005", ["prof_018", "prof_019", "prof_129", "prof_130"], "Хочу организовывать кружки, объяснять темы детям и придумывать занятия для них"],
};

export function controlProfiles() {
  const controls = [];
  const pairs = [["mechanisms", "design"], ["crops", "ecology"], ["laboratory", "code"], ["social", "design"]];
  for (const [from, to] of pairs) {
    for (const grade of [7, 10]) {
      const [expected, relevant, text] = themes[from];
      const profile = {
        id: `control-${from}-${grade}`, grade, municipality: "Екатеринбург", questionnaire: "",
        expected, relevant,
        answers: { future_direction: [text], tasks: ["Хочу попробовать реальную задачу и обсудить, что получилось"] },
      };
      controls.push(profile);
      const [target, targetIds, targetText] = themes[to];
      controls.push({ ...profile, variant: "direction", expected: target, relevant: targetIds,
        answers: { ...profile.answers, future_direction: [targetText] } });
      if (from === "mechanisms") {
        controls.push({ ...profile, variant: "reorder", answers: Object.fromEntries(Object.entries(profile.answers).reverse()) });
        controls.push({ ...profile, variant: "punctuation", answers: { ...profile.answers, future_direction: [text + "!"] } });
        controls.push({ ...profile, variant: "paraphrase", answers: { ...profile.answers,
          future_direction: ["Интересно конструировать механические узлы, обслуживать оборудование и чинить станки"] } });
        for (const [variant, municipality] of [["region", "Нижний Тагил"], ["outside", "Москва"]]) {
          controls.push({ ...profile, variant, municipality });
        }
      }
    }
  }
  return [...controls,
    { id:"mixed-screenshot", grade:8, municipality:"Екатеринбург", questionnaire:"", answers:{
      bilet_q1_subjects:["Информатика", "Физика"], future_direction:["Творческие задачи", "Безопасность"],
      agent_q4_experience:["Участвовал в волонтёрском проекте"], agent_q2_work_style:["Самостоятельная и командная работа"],
    }},
    { id:"nature-general", grade:9, municipality:"Екатеринбург", questionnaire:"", answers:{
      future_direction:["Люблю природу"], tasks:["Гулять на свежем воздухе"],
    }},
    { id:"weak", grade:10, municipality:"Екатеринбург", questionnaire:"", answers:{future_direction:["Физика"]}},
    { id:"uninformative", grade:8, municipality:"Екатеринбург", questionnaire:"", answers:{
      future_direction:["Не знаю", "Другое"], agent_q5_format:["online"], agent_q6_constraints:["free_only"],
    }},
  ];
}
