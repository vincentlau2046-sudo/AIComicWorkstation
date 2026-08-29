# 时代美学注入全链路改造 — 设计文档

> 日期：2026-08-25
> 涉及文件：13 个核心文件 + registry 多处常量 + 2 处 fallback 修复

---

## 问题

角色参考图有时产出东方风格、有时西方风格（铠甲、官袍的歧义解释），因为 `projects.eraAesthetic` / `projects.visualStyle` 只在剧本生成和角色提取阶段被 LLM 使用，最终发给图像模型的 prompt 缺少风格锚定。

## 核心原则

**what you see is what the model gets** — 时代美学必须是 LLM 输出的显式内容，出现在用户可查看的 prompt 文本中，不允许后端对 LLM 输出做隐藏拼接。

## DB 字段

```sql
-- projects 表
visualStyle    text — "3D国漫", "写实电影" 等
eraAesthetic   text — "明初洪武至永乐年间，宫廷建筑与官服礼仪"
moodDirection  text — "史诗悲壮，光影低沉"

-- episodes 表
visualStyle    text (同上，可覆盖项目级)
eraAesthetic   text (同上，可覆盖项目级)
```

## 改造要点

### 原则一：无条件注入 PROJECT STYLE ANCHORS

三个文本生成端点（r2i-prompt、t2i-prompt、batch-generate）的 LLM user prompt 头部**无条件**注入 `PROJECT STYLE ANCHORS`，无论 DB 字段是否有值（无值时用「未指定」兜底）：

```
PROJECT STYLE ANCHORS (authoritative — all output must conform):
视觉风格: 3D国漫渲染
时代美学: 明初洪武至永乐年间
角色服装、道具、建筑风格必须与上述时代/风格严格一致。
```

### 原则二：LLM 输出必须显式包含 era/style

R2I 输出格式（registry.ts `R2I_OUTPUT_ZH`）：

```
[lighting: ...]

[era: 明初洪武至永乐年间]
[style: 3D国漫渲染]

age: 17岁
clothing: ...
```

T2I 输出格式（registry.ts `T2I_PROMPT_OUTPUT_ZH`）：

```json
{ "era": "...", "style": "...", "age": "...", "subject": "...", "body": "...", ... }
```

### 原则三：T2I 字段隔离

T2I JSON 中 `era`/`style` 与 `subject`/`clothing`/`lighting` **严格隔离**：
- `era`/`style` 是样式锚定字段
- `subject`/`clothing`/`lighting` 只写角色/穿着/光照描述，禁止包含任何风格渲染词（"3D国漫渲染"、"体积光"、"细腻材质"、"CG" 等）

## 视频链路说明

H3 视频 prompt 的时代美学是以 **LLM 输入上下文**（Content Layer）的方式注入，不是对 LLM 输出的后处理。视频模型受参考帧图像的视觉锚定，文本 prompt 不承担风格锚定的核心职责。因此不需要像 R2I 那样要求显式 `[era:]` 标签。

## 架构图

```
projects.eraAesthetic / visualStyle
                │
    ┌───────────┼───────────┐
    │           │           │
    ▼           ▼           ▼
 r2i-prompt  t2i-prompt  batch-generate  ← LLM user prompt
    │           │           │              + PROJECT STYLE ANCHORS
    │           │           │
    ▼           ▼           ▼
 LLM output with [era:] [style:]
    or JSON { "era":..., "style":... }
    │
    ▼
 buildCharacterFrontViewPrompt()  ← 从 t2iStructure JSON 读 era/style
 buildPhaseR2IPrompt()            ← 也接受 r2iPrompt 参数，原样传递
    │
    ▼
 image model ← prompt 中包含 era/style，用户可直接看到
```

## 修改文件清单

| 文件 | 改动 |
|------|------|
| `lib/ai/prompts/registry.ts` R2I_TASK_ZH/EN | 加规则 3a：必须输出 `[era:]` `[style:]`，从 PROJECT STYLE ANCHORS 取值 |
| `lib/ai/prompts/registry.ts` R2I_OUTPUT_ZH/EN | 加第 1.5 段「时代锚定」输出模板 |
| `lib/ai/prompts/registry.ts` T2I_PROMPT_TASK_ZH/EN | 9 字段（+era/style），加字段隔离铁律，删"保留描述中的风格词"矛盾指令 |
| `lib/ai/prompts/registry.ts` T2I_PROMPT_OUTPUT_ZH/EN | 9 字段示例 + era/style 与其他字段隔离注释 |
| `lib/ai/prompts/character-image.ts` | 删隐藏注入的 `eraLine`/`styleLine`，改从 t2iStructure JSON 读 `s.era`/`s.style` |
| `lib/ai/prompts/phase-image.ts` | 删 `styleContext` 参数 + `eraStyleTag` 拼接。`r2iPrompt` 路径直接返回原文 |
| `lib/ai/prompts/keyframe-prompts.ts` | +eraText 参数（预留，当前调用方未用） |
| `lib/ai/prompts/h3/types.ts` | +`eraAesthetic?` 字段（LLM 输入上下文，非隐藏注入） |
| `lib/ai/prompts/h3/build-input.ts` | 读 DB `project.eraAesthetic` / `episode.eraAesthetic` |
| `lib/ai/prompts/h3/fl2v/prompt-template.ts` | Content Layer +时代行（LLM 上下文） |
| `app/api/projects/[id]/generate/route.ts` | 3 个 handler 删 `projStyle` DB 查询 + `styleContext` 变量，`buildPhaseR2IPrompt` 只传 `r2iPrompt` |
| `app/api/projects/[id]/characters/[characterId]/r2i-prompt/route.ts` | +styleCtx 无条件注入；else 分支加 era/style 输出模板；fallback 修复；缺括号语法修复 |
| `app/api/projects/[id]/characters/[characterId]/t2i-prompt/route.ts` | +styleCtx 无条件注入（两个分支）|
| `app/api/projects/[id]/characters/batch-generate/route.ts` | +styleCtx 无条件注入；R2I/T2I 分支分别加 era/style 输出要求；fallback 修复 |

## 验证要点

1. R2I 输出：`[era: xxx]` `[style: xxx]` 出现在 `[lighting:]` 之后、`age:` 之前
2. T2I 输出：`era`/`style` 是 JSON 前两个字段，且 `subject`/`clothing`/`lighting` 中无风格词
3. T2I 字段隔离：style 渲染词汇只出现在 `era`/`style` 字段，不污染描述字段
4. PROJECT STYLE ANCHORS 无条件注入（字段为空时显示"未指定"）