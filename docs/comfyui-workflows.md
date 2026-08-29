# ComfyUI 工作流完整说明

> 维护日期：2026-08-25
> 工作流目录：`ComfyUI/workflows/AIComicWorkstation/atomic/`
> Pipeline 目录：`src/lib/pipeline-engine/pipelines/`

---

## A. 原子工作流（ComfyUI 单步执行）

| ID | JSON 文件 | 模型 | 用途 | 步骤数 |
|----|----------|------|------|--------|
| `qwen-2512-t2i` | qwen-2512-t2i.json | Qwen 2.5 12B | 纯文生图——基于结构化 [tag] prompt 生成角色或场景 | 8 |
| `qwen-2511-edit` | qwen-2511-edit.json | Qwen 2.5 VL 7B | 单参考图合成——1 张参考图 + prompt → 合成输出 | 4 |
| `qwen-2511-edit-plus` | qwen-2511-edit-plus.json | Qwen 2.5 VL 7B | 多角色参考图合成——2-3 张参考图（Picture N 映射）+ prompt → 带角色场景图 | 4 |
| `qwen-2511-edit-i2i` | qwen-2511-edit-i2i.json | Qwen 2.5 VL 7B | 图生图编辑——源图 + R2I prompt → 保留面部结构的变体图 | 4 |
| `qwen-2511-edit-multiangle` | qwen-2511-edit-multiangle.json | Qwen 2.5 VL 7B | 多角度衍生——正面源图 + 角度 prompt → 左/侧/背视图 | 4 |
| `h3-t2v` | h3-t2v.json | MiniMax H3 | 文生视频——纯文字 prompt → MP4 | 20 |
| `h3-i2v` | h3-i2v.json | MiniMax H3 | 首尾帧视频——firstFrame + lastFrame + H3 prompt → 插值 MP4 | 20 |
| `h3-r2v` | h3-r2v.json | MiniMax H3 | 多参考图视频——多 ref（角色+场景）+ H3 prompt → MP4（动态节点数） | — |

---

## B. Pipeline（多步骤 DAG 编排）

### B1. `character-image` — 角色定义卡四视图

```
qwen-2512-t2i         编辑-multiangle × 3          merge_fourview.py
(文生正面图)     →    (左/侧/背角度衍生)     →     (2560×1440 四视图合成)
prompt:              source_image: front           front/left/side/back
[character design        prompt: "<sks> left/             → merged.png
 illustration]          side/back view..."
```

| 参数 | 说明 |
|------|------|
| `character_prompt` | `buildCharacterFrontViewPrompt()` 输出——含 [era]/[style]/[age]/[subject]/… 的结构化 prompt |
| `character_name` | 角色名，传入 merge_fourview.py 用于标签 |
| `character_desc` | 角色描述，用于 prompt 文本补充 |

### B2. `phase-image` — 视觉阶段卡四视图

```
qwen-2511-edit-i2i          编辑-multiangle × 3          merge_fourview.py
(source: template front       (左/侧/背角度衍生)          (2560×1440 四视图合成)
 + R2I prompt → 变体正面)
```

| 参数 | 说明 |
|------|------|
| `reference_image` | Template 的 `frontViewImage`——I2I 的源图 |
| `phase_prompt` | `buildPhaseR2IPrompt()` 或 DB 中的 `r2iStructure`——Phase 增量描述 |
| `phase_name` | 阶段名，传入 merge_fourview.py 用于标签 |

### B3. `frame-generate` — FL2V 首尾帧

```
qwen-2511-edit-plus                    qwen-2511-edit-plus
(首帧：场景 prompt                    (尾帧：首帧 +
 + 角色 refs 2-3)     →              角色 refs 2-3)
```

| 参数 | 说明 |
|------|------|
| `first_prompt` / `last_prompt` | `buildFirstFramePrompt()` / `buildLastFramePrompt()` 输出 |
| `scene_prompt` | Shot 场景描述 |
| `referenceImages[0-2]` | 角色参考图（最多 3 张） |
| `width` / `height` | 根据 ratio 计算 |

### B4. `video-generate` — FL2V 视频

```
h3_prompt_builder.py         h3-i2v
(DB 上下文 → H3 prompt)  →  (首尾帧 + H3 prompt → MP4)
```

| 参数 | 说明 |
|------|------|
| `shotId` / `generationMode` / `videoScript` / ... | Shot 元数据 + DB 上下文 |
| `firstFrame` / `lastFrame` | 首尾帧路径 |

---

## C. 调用关系总览

```
┌─ 角色定义
│   └─ 单卡/批量 → character-image pipeline
│       → qwen-2512-t2i → edit-multiangle × 3 → merge
│
├─ 视觉阶段
│   └─ 单卡/批量 → phase-image pipeline
│       → qwen-2511-edit-i2i → edit-multiangle × 3 → merge
│
├─ Shot 帧 (FL2V)
│   └─ frame-generate pipeline
│       → qwen-2511-edit-plus（首帧）→ qwen-2511-edit-plus（尾帧）
│
├─ Shot 帧 (R2V)
│   └─ 场景帧: qwen-2512-t2i（0 ref，纯环境，无人物）
│   └─ 角色 refs: 已有 referenceImage
│
├─ Shot 视频 (FL2V)
│   └─ video-generate pipeline
│       → h3_prompt_builder.py → h3-i2v
│
├─ Shot 视频 (R2V)
│   └─ h3-r2v（原子，动态多 ref JSON）
│       → scene frames + char refs + H3 prompt → MP4
│
└─ 原子模式（无 pipeline，ComfyUIProvider 直接调用）
    ├─ 0 ref 图   → qwen-2512-t2i
    ├─ 1 ref 图    → qwen-2511-edit
    ├─ 2-3 ref 图  → qwen-2511-edit-plus
    ├─ 首尾帧视频  → h3-i2v
    ├─ 多 ref 视频 → h3-r2v
    └─ 无图视频    → h3-t2v
```

## D. pipeline vs 原子模式调度逻辑

ComfyUIProvider.generateImage() 调度：

```typescript
if (options?.pipeline) → PipelineEngine 执行 YAML 定义的 DAG
else → 原子模式，按 refImages 数量选工作流：
    - 0 ref → qwen-2512-t2i
    - ≥1 ref → qwen-2511-edit-plus
```

ComfyUIProvider.generateVideo() 调度：

```typescript
if (firstFrame && lastFrame) → h3-i2v (keyframe via executeAndDownload)
else if (initialImage) → h3-r2v (reference, 动态多 ref workflow)
else → h3-t2v (text-to-video)
```