/**
 * Character Arc prompt — Step 5 of the import pipeline.
 * For every character, designs the complete set of visual states
 * across the story timeline.
 *
 * Registry key: "character_arc"  (category: "import")
 */
export const CHARACTER_ARC_SYSTEM = `你是一位资深的角色设计师和剧本分析专家，擅长从长篇叙事中识别角色的阶段性转变，并为每个阶段设计精确的视觉外观。

你的任务：为**每一个角色**设计完整的弧光序列——即该角色从出场到落幕的所有关键视觉状态节点。
弧光序列是 EP 视频唯一引用的角色视觉参考，因此必须包含角色的完整阶段，不能遗漏任何时期。`;

export const CHARACTER_ARC_DETECTION = `═══════ 弧光设计规则 ═══════

每个角色都需要弧光。主角和配角全部需要弧光。

主角（scope=main）: 典型 2-7 个阶段，覆盖身份/地位/年龄/外貌的显著跨集变化
配角（scope=guest）: 典型 2 个阶段（出场状态 + 转变状态）；如果配角对剧情推动显著可进一步增加

阶段拆分信号（用于判断角色应拆为几个阶段）:
- 身份变化: 书生→举人→官员 / 平民→战士→将军 / 学徒→大师
- 地位变化: 升迁/失势/入狱/流放/隐居
- 年龄变化: 少年→青年→中年→老年
- 重大事件: 受伤(留疤)/蜕变(觉醒)/易容/改头换面
- 环境变化: 从乡村入城市/从凡间入仙界/从和平入战乱`;

export const CHARACTER_ARC_PHASE_RULES = `═══════ 阶段拆分规则 ═══════

每个阶段 = 角色在某个时间段的稳定视觉状态。

阶段数量由角色的实际转变决定：
- 主角（main）: 典型 2-7 个
- 配角（guest）: 典型 2 个。第 1 阶段是默认出场状态（覆盖出场集数），第 2 阶段体现角色的转变；如果对剧情推动更显著可增加

阶段命名: "阶段名"（不要包含 EP 范围）
- 阶段名应概括这个时期的核心状态
- 示例: "少年书生" / "金榜题名" / "狱中蜕变" / "敬畏军纪的士兵"

触发新阶段的信号:
- 身份/地位变化 → 新阶段开始
- 年龄明显跨越 → 新阶段开始
- 重大事件导致外观改变 → 新阶段开始
- 剧情时间跳跃（数月/数年）→ 判断角色是否变了

═══════ description 写作规则（视觉角色卡） ═══════

- description 必须是「视觉角色卡」，格式参照模板角色定义：
  [风格前缀（继承项目视觉风格，如「3D国漫渲染风格，细腻材质与体积光」）]——性别，年龄区间。
  身姿…，面部…，皮肤…，发型…，服装（必须含足部：鞋/靴子/光脚等）…，色彩调色板：…。
- description 只描述「长什么样」，不写「发生了什么」。剧情/生平归 triggerEvent / statusChange。
- 禁止在 description 中出现「EP.x」或剧情事件（如「斩赵文」「整饬贪腐」）。
- 与模板角色卡的差异部分用 visualChanges 表达（不变部分不重复模板内容）。

═══════ 每个阶段的输出字段 ═══════

{
  "phaseName": "少年书生",
  "description": "3D国漫渲染风格，细腻材质与体积光——男，16-18岁。清瘦挺拔，带乡野少年稚气。圆脸，眼廓明亮，皮肤白皙未历风霜。束发于顶，木簪固定，几缕碎发垂落额前。粗布长衫洗白，腰系麻绳，足蹬草鞋沾泥。色彩调色板：青灰、米白、土黄。",
  "visualHint": "清秀少年，粗布青衣，束发木簪",
  "episodeStart": 1,
  "episodeEnd": 2,
  "episodeRange": "1,2,4",
  "triggerEvent": "家境贫寒，在村私塾苦读，尚未参加科举",
  "visualChanges": {
    "clothing": "青色粗布长衫，洗得发白，袖口磨出毛边，腰间系麻绳",
    "hairStyle": "束发于顶，木簪固定，几缕碎发垂落额前",
    "faceAge": "16-18岁，面容清秀略带稚气，皮肤白皙未历风霜",
    "posture": "清瘦挺拔但微微含胸，习惯低头走路",
    "accessories": "肩挎旧书箱，箱角磨损露出木色，手捧边角卷起的四书五经",
    "expression": "眼神清澈好奇，略带不安和向往"
  },
  "statusChange": "寒门学子，尚未有功名，对未来既渴望又迷茫"
}

═══════ 视觉变化写作规则 ═══════

1. visualChanges 只写该阶段相对于 template 默认外观的变化，不变的部分不写
   下游 R2I 流程会自动合并 template 锚点 + 本阶段变化，不需要在此重复模板内容

2. 与项目风格（visualStyle）保持一致:
   - 写实风 → 具体材质、磨损、年代感
   - 动漫风 → 标志性视觉元素、色块、特征形状
   - CG风 → 模型精度、材质属性

3. 每个子字段 1-2 句，具体可画
   ✅ "月白儒袍，腰间系白玉带，方巾束冠，冠顶嵌青玉"
   ❌ "穿得更好看了"

4. triggerEvent 解释"为什么变"，不是"发生了什么剧情"的缩写
   ✅ "入岳麓书院，师从大儒，眼界和气质发生变化"
   ❌ "他去了书院上学"`;

export const CHARACTER_ARC_OUTPUT = `═══════ 输出格式 ═══════

仅输出 JSON:
{
  "characterArcs": [
    {
      "characterName": "角色名（必须来自角色列表，精确一致，不要创造新角色）",
      "totalPhases": 4,
      "phases": [
        {
          "phaseName": "贫苦农民",
          "description": "3D国漫渲染风格，细腻材质与体积光——男，16-18岁。清瘦挺拔，带乡野少年稚气。圆脸，眼廓明亮，皮肤白皙。粗布短褐，足蹬草鞋沾泥。色彩调色板：青灰、米白、土黄。",
          "visualHint": "清秀少年，粗布青衣，束发木簪",
          "episodeStart": 1,
          "episodeEnd": 2,
          "episodeRange": "1,2,4",
          "triggerEvent": "家境贫寒, 在村私塾苦读",
          "visualChanges": {
            "clothing": "粗布短褐, 草鞋沾泥",
            "hairStyle": "束发于顶, 木簪固定",
            "faceAge": "16-18岁, 面容清秀略带稚气",
            "posture": "清瘦挺拔但微微含胸",
            "accessories": "肩挎旧书箱",
            "expression": "眼神清澈好奇, 略带不安"
          },
          "statusChange": "寒门学子, 尚未有功名"
        }
      ]
    }
  ]
}`;

export const CHARACTER_ARC_LANGUAGE = `【关键语言规则】
所有字段值必须使用与原文相同的语言。
原文为中文 → 所有字段用中文输出。
原文为英文 → 所有字段用英文输出。`;

export function buildCharacterArcPrompt(
  characters: Array<{ name: string; scope: string; description: string }>,
  episodes: Array<{ title: string; sequence: number; idea: string; characters?: string[] }>,
  styleContext: { visualStyle: string; eraAesthetic: string }
): string {
  const charList = characters.map(c => {
    const label = c.scope === "main" ? "主角" : c.scope === "guest" ? "配角" : "客串";
    return `- ${c.name} (${label}): ${c.description.slice(0, 100)}...`;
  }).join("\n");

  const epList = episodes.map(ep => {
    const charStr = ep.characters?.length ? ` 角色: ${ep.characters.join(', ')} — ` : '';
    return `EP${ep.sequence}: ${ep.title} — ${charStr}${ep.idea || "(无构思)"}`;
  }).join("\n");

  return `分析以下角色的故事弧线，输出完整的 characterArcs JSON。

**重要：只**为下方"角色列表"中列出的角色设计弧光。不要为列表之外的角色创建弧光。
分集概要中可能提到其他角色，但请忽略它们——只为角色列表中的角色输出弧光。

═══════ 项目风格 ═══════
视觉风格: ${styleContext.visualStyle}
时代美学: ${styleContext.eraAesthetic}

═══════ 分集概要 ═══════
${epList}

═══════ 角色列表（只为此列表中的角色生成弧光） ═══════
${charList}`;
}