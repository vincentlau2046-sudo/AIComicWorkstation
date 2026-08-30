/**
 * User-message builder for the `ref_image_prompts` AI call.
 *
 * NOTE: The system prompt is NOT defined here — it lives in
 * `registry.ts` under `refImagePromptsDef` (single source of truth, also
 * exposed in the prompt management UI so users can override it).
 * This file only constructs the per-request user payload: visual style,
 * character context (for reasoning, not drawing), and shot list.
 */

export function buildRefImagePromptsRequest(
  shots: Array<{
    sequence: number;
    prompt: string;
    environmentPrompts?: string[] | null;
    characters?: string[] | null;
    motionScript?: string | null;
    cameraDirection?: string | null;
    duration?: number | null;
  }>,
  characters: Array<{ name: string; description?: string | null }>,
  visualStyle?: string,
  eraText?: string
): string {
  // Characters are passed as CONTEXT for the AI to reason about which
  // characters will act in which shot → populates the `characters` field
  // in the JSON output. The scene prompts themselves must NOT depict any
  // characters.
  const charContext = characters
    .map((c) => `- ${c.name}${c.description ? `：${c.description}` : ""}`)
    .join("\n");

  const shotDescriptions = shots
    .map((s) => {
      const duration = s.duration ?? 10;
      const lines = [
        `镜头 ${s.sequence}（时长 ${duration}s）：${s.prompt}`,
      ];
      if (s.environmentPrompts && s.environmentPrompts.length > 0) {
        lines.push(`  场景环境描述（${s.environmentPrompts.length} 帧，已预提取，直接用于场景参考帧生成）：`);
        s.environmentPrompts.forEach((ep, i) => lines.push(`    [帧 ${i + 1}] ${ep}`));
      }
      if (s.characters && s.characters.length > 0) {
        lines.push(`  登场角色：${s.characters.join("、")}`);
      }
      if (s.motionScript) lines.push(`  剧情动作（用于判断角色所处的物理地点，不要画人）：${s.motionScript}`);
      if (s.cameraDirection) lines.push(`  镜头运动：${s.cameraDirection}`);
      return lines.join("\n");
    })
    .join("\n\n");

  return [
    visualStyle ? `项目视觉风格基调：${visualStyle}` : "",
    ``,
    `角色列表（仅用于思考：（1）他们所处的物理地点决定场景（2）判断哪些角色在每个镜头登场。图像 prompt 中不要提及他们）：`,
    charContext || "（无）",
    ``,
    `## 什么是"场景图"`,
    `场景图 = **角色所在的物理地点 / 环境空间**（例如：太和殿广场、竹林深处、悬崖边缘、破败宫门前、禅房内部）。`,
    `场景图**不是**：抽象特效（能量光、烙印闪耀）、单独的道具特写（只有一把剑、只有一个符咒）、角色肖像、人物配饰。`,
    `判断标准：如果你只看这张图能说出"这是一个 XX 地方"，那就是场景图；如果只能说出"这是一团光/一个物件"，那就不是。`,
    ``,
    `## ⚠️ 时代锚定`,
    eraText ? `项目时代背景：${eraText}` : null,
    ``,
    `以下规则适用于任何时代，非针对本项目的定制清单：`,
    ``,
    `① 命名具体化 — 禁止泛化词汇`,
    `  场景中所有物件必须用该时代的真实具体名称描述。`,
    `  不得使用「建筑」「船只」「车辆」「光源」「道路」等跨时代泛化词。`,
    `  正确做法：从时代背景推导具体物件名（如古代→「青砖瓦房」「木质楼船」「油灯」）`,
    `  错误做法：使用泛化词导致图像模型代入现代默认形态`,
    ``,
    `② 材质匹配 — 必须属于该时代的技术水平`,
    `  从时代背景推断该时代可用的建筑材料、纺织物、金属等。`,
    `  禁止使用该时代技术水平无法生产的材质。`,
    ``,
    `③ 光源匹配 — 必须属于该时代的照明方式`,
    `  禁止使用该时代不存在的照明技术。`,
    ``,
    `④ 存疑处理 — 不确定某元素是否属于该时代 → 从时代信息推导最接近的替代物`,
    ``,
    `## 场景图数量 — 决策流程`,
    ``,
    `⚠️ **必须按以下顺序判断，不得跳过检查清单。**`,
    ``,
    `### 第一步：多帧判定（满足任一 → 必须生成 2-4 条场景图）`,
    ``,
    `**条件 A — 物理地点跨越**：镜头内角色从地点 X 移动到地点 Y，且 X 和 Y 是不同的物理空间。`,
    `- 判定方法：看 motionScript，如果必须用 ≥2 个不同的地点名词才能说完整个镜头 → 跨地点。`,
    `- 触发例：地面→空中、室内→室外、桥上→水下、书房→走廊→庭院`,
    `- 不触发：同一空间内走动（帅帐踱步、殿堂来回）、坐下/站起、原地转身`,
    ``,
    `**条件 B — 光线/时间质变**：镜头内发生光线条件或时间段的根本性改变。`,
    `- 判定方法：首帧和尾帧的 time_of_day 或主光方向/色温是否不同。`,
    `- 触发阈值：时段跨越 ≥2 档（如"黄昏→深夜"、"清晨→午后→傍晚"）`,
    `- 不触发：同一时段光影微调（云遮太阳后复出）、光源小幅移动`,
    `- 每跨越一档 → 至少 1 条独立的场景帧`,
    ``,
    `**条件 C — 多节点空间**：同一地点但包含 ≥2 个视觉上不重叠的关键空间区域，一张图无法同时有效覆盖。`,
    `- 触发信号：街巷有转角/暗门/岔路、阶梯有 ≥2 层平台、≥3 房间且角色入镜内穿梭、桥面+桥下双视角`,
    `- 判定标准：试想用一张全景覆盖所有关键区域 → 每个区域的细节会丢 → 拆多帧分别拍`,
    `- 不触发：单一大空间（殿堂大厅、单层广场、空旷无结构分隔的场所）`,
    ``,
    `**数量规则**：`,
    `- 命中 1 个条件 → 2 条`,
    `- 命中 2 个条件 → 3 条`,
    `- 命中 3 个条件 → 4 条`,
    `- 上限 4 条，按时间顺序排列，第 0 条 = 镜头起始地点`,
    ``,
    `### 第二步：单帧场景（以上条件全部不满足）`,
    ``,
    `**生成 1 条场景图**。`,
    ``,
    `单帧场景的典型特征：`,
    `- 动作全程在同一可命名空间内`,
    `- 光线稳定，无时段跨越`,
    `- 空间结构单一，无需要分视角覆盖的盲区`,
    ``,
    `⚠️ 注意：对话/站立/近景特写/蓄力/挥拳/开门/转身都是单帧场景——这些改变的是角色动作，不是场景空间本身。不要因为"镜头情绪起伏大"或"动作很复杂"就拆多帧。`,
    ``,
    `## 场景推断规则（当本帧环境信息不足时）`,
    ``,
    `分镜列表中部分特写/近景镜头的描述可能以角色为主体，环境词汇较少。你必须通过以下方法推断场景，不得因描述含角色就跳过该帧：`,
    ``,
    `1. **本帧提取**：从当前镜头描述中提取所有非角色的环境信号——地点名词、天气、时间段、光线方向/色温、地面材质、道具位置、空间大小。忽略角色名和角色专属描述。`,
    `2. **上下帧参照**：查看当前镜头前后相邻的 1-2 个镜头。若它们在同一场景内（地点名词相同或相邻），复用它们的空间定义。`,
    `   例：Shot #3 描述为 "雪原特写，重点在于林策的脸部"，环境描述不足 → Shot #2 和 Shot #4 都是 "山海关外雪原" → 场景就是这片雪原。`,
    `3. **空间缩放**：若上下帧为全景/中景描述了大空间，本帧为特写——缩小空间范围，保留相同的地点/天气/光线/色调，增加 "背景虚化""地面特写""微小空间" 等近景提示。`,
    `4. **道具锚定**：若本帧提到了具体道具（如水囊、武器、火堆、铁链），以该道具为锚点推断周围空间——道具所在的物理位置就是场景。`,
    `5. **推断优先级**：本帧环境词 → 上下帧同场景描述 → 上一帧的空间定义（保留地点/天气/色调，缩放空间）。`,
    ``,
    `## 分镜列表`,
    shotDescriptions,
    ``,
    `再次强调：`,
    `- 先过检查清单 → 命中条件 A/B/C 则生成 2-4 条 → 全部不命中则 1 条`,
    `- 场景图必须是"地点/环境"，不是"特效/道具/光效/符号"`,
    `- 图像中不出现任何人物（没有人、没有背影、没有剪影、没有手脚）`,
    `- characters 字段必须列出会在此镜头登场的角色名，名字要和上方角色列表完全一致`,
    `- 禁止真实人名（导演/演员/艺术家/品牌/IP）——违反会导致图像 API 400 报错`,
    `- 输出格式严格按 system prompt 要求的 scenes 数组（{ name, prompt }），无 markdown 包裹`,
    `- 每条 prompt 必须使用 Qwen [tag] 结构化格式：按 [shot][era][scene][lighting][color][atmosphere][style] 顺序排列，每标签一行`,
    `- prompt 必须覆盖全部 7 个标签（shot/era/scene/lighting/color/atmosphere/style），不得遗漏`,
  ]
    .filter(Boolean)
    .join("\n");
}
