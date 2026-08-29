// ═══════════════════════════════════════════════
// H3 R2V Prompt Template (v4) — Registry-backed
// ═══════════════════════════════════════════════

import type { H3PromptInput, H3Language } from "../types";
import { mapCameraDirection } from "../camera-map";
import { resolveLanguage } from "../shared/base-builder";
import { getDefaultSlotContents } from "@/lib/ai/prompts/registry";

export async function buildR2VPromptTemplate(
  input: H3PromptInput,
  systemOverride?: string,
): Promise<{ system: string; user: string }> {
  const lang = resolveLanguage(input);
  let system = systemOverride || "";
  if (!system) {
    const slots = getDefaultSlotContents("ref_video_prompt_h3");
    const role = slots?.role_definition || "";
    const rules = slots?.rules || "";
    system = [role, rules].filter(Boolean).join("\n\n");
  }
  const user = [
    buildContentLayer(input, lang),
    buildRefConstraintLayer(input, lang),
    buildOutputFormat(input, lang),
  ].join("\n\n");
  return { system, user };
}

// ═══ Layer 1: Content (Registry-backed) ═══════════════════

function buildContentLayer(input: H3PromptInput, lang: H3Language): string {
  const L = (zh: string, en: string) => lang === "zh" ? zh : en;
  const slots = getDefaultSlotContents("ref_video_h3_content") ?? {};
  const r = (key: string, fallback: string) => slots[key] || fallback;
  const out: string[] = [];

  out.push(r("role_task", L("你是R2V工程师", "You are an R2V engineer")));

  out.push("");
  out.push(r("image_mapping", L("=== 参考图映射 ===", "=== IMAGE MAPPING ===")));

  // Dynamic: iterate ALL scene reference images (R2V — not keyframes)
  let picIdx = 1;
  for (const sf of input.sceneFrames ?? []) {
    const label = sf.prompt || L("场景参考", "Scene reference");
    out.push(L(`<Picture ${picIdx}> = ${L("场景参考图", "Scene ref")}: ${label.slice(0, 80)}`,
      `<Picture ${picIdx}> = Scene ref: ${label.slice(0, 80)}`));
    picIdx++;
  }
  // Dynamic: iterate character reference images
  for (const ch of input.characters) {
    if (ch.referenceImage) {
      out.push(L(`<Picture ${picIdx}> = 角色 ${ch.name}`, `<Picture ${picIdx}> = ${ch.name}`));
      picIdx++;
    }
  }

  out.push("");
  out.push(r("characters", L("=== 登场角色 ===", "=== CHARACTERS ===")));
  for (let i = 0; i < input.characters.length; i++) {
    const ch = input.characters[i];
    if (!ch.referenceImage) continue;
    const desc = (ch.description || "").length > 80
      ? (ch.description || "").slice(0, 80) + "..." : (ch.description || "");
    const attrs = [desc, ch.visualHint,
      ch.heightCm && ch.heightCm > 0 ? `${ch.heightCm}cm/${ch.bodyType || "average"}` : null,
      ch.performanceStyle].filter(Boolean).join(" — ");
    out.push(L(`<Subject ${i+1}> = ${ch.name}: ${attrs}`, `<Subject ${i+1}> = ${ch.name}: ${attrs || "character"}`));
  }
  if (input.sceneDescription) {
    const si = input.characters.length + 1;
    out.push(L(`<Subject ${si}> = 场景: ${input.sceneDescription}`, `<Subject ${si}> = Scene: ${input.sceneDescription}`));
  }

  if (input.spatialHints?.length) {
    out.push("");
    out.push(L("=== 画面空间布局 ===", "=== SPATIAL LAYOUT ==="));
    for (const hint of input.spatialHints) {
      out.push(hint);
    }
    const multi = input.characters.filter(c => c.referenceImage).length;
    if (multi >= 2) {
      out.push(L(
        `⚠️ 硬性规则：同框角色必须明确标注每个角色的画面方位（左/右/上/下），禁止所有角色统一朝向（同向左或同向右）。`,
        `⚠️ HARD RULE: label every character's screen position (left/right/up/down). All characters must NOT face the same direction.`
      ));
    }
  }

  out.push("");
  out.push(r("scene_shot", L("=== 场景与分镜 ===", "=== SCENE & SHOT ===")));
  if (input.projectTitle) out.push(L(`项目: ${input.projectTitle}`, `Project: ${input.projectTitle}`));
  if (input.projectOutline) out.push(L(`大纲: ${input.projectOutline}`, `Outline: ${input.projectOutline}`));
  if (input.projectWorldSetting) out.push(L(`世界观: ${input.projectWorldSetting}`, `World: ${input.projectWorldSetting}`));

  out.push("");
  out.push(r("motion_camera", L("=== 动作脚本与运镜 ===", "=== MOTION & CAMERA ===")));
  if (input.motionScript) out.push(L(`动作: ${input.motionScript}`, `Motion: ${input.motionScript}`));
  if (input.videoScript) out.push(L(`视频: ${input.videoScript}`, `Video: ${input.videoScript}`));
  if (input.cameraDirection) {
    const cameraMapped = mapCameraDirection(input.cameraDirection);
    const dir = input.cameraDirection.toLowerCase();
    const isForward = dir.includes('zoom in') || dir.includes('push') || dir.includes('dolly in') || dir.includes('推');
    const isBackward = dir.includes('zoom out') || dir.includes('pull') || dir.includes('dolly out') || dir.includes('拉');
    const oppositeHint = isBackward
      ? L('⚠️ 禁止使用推近(push in/dolly in)或任何前进方向的运镜', '⚠️ DO NOT use push in/dolly in or any forward camera motion')
      : isForward
      ? L('⚠️ 禁止使用拉远(pull back/zoom out)或任何后退方向的运镜', '⚠️ DO NOT use pull back/zoom out or any backward camera motion')
      : '';
    out.push(L(`运镜方向: ${input.cameraDirection} → ${cameraMapped}`, `Camera Direction: ${input.cameraDirection} → ${cameraMapped}`));
    if (oppositeHint) out.push(oppositeHint);
  }
  out.push(L(`时长: ${input.duration || 10}s`, `Duration: ${input.duration || 10}s`));

  out.push("");
  if (input.dialogues?.length) {
    out.push(r("dialogue_header", L(`=== 对白 ===`, `=== DIALOGUES ===`)));
    for (const d of input.dialogues) {
      const si = input.characters.findIndex(c => c.name === d.characterName);
      const sl = si >= 0 ? ` (S${si+1})` : "";
      out.push(L(`${d.characterName}${sl} 说：<d>[中文] ${d.text}</d>`,
        `${d.characterName}${sl} says: <d>[English] ${d.text}</d>`));
    }
  } else {
    out.push(L("=== 对白 ===\n无对话", "=== DIALOGUES ===\nNo dialogue"));
  }

  if (input.narrations?.length) {
    out.push("");
    out.push(r("narration_header", L("=== 旁白（已预生成）===", "=== Narration ===")));
    out.push(input.narrations.join("\n"));
  }
  if (input.innerMonologues?.length) {
    out.push("");
    out.push(r("inner_monologue_header", L("=== 内心独白（已预生成）===", "=== Inner Monologue ===")));
    out.push(input.innerMonologues.join("\n"));
  }

  out.push("");
  out.push(r("audio_header", L("=== 音频参考 ===", "=== AUDIO ===")));
  if (input.bgmUrl) out.push(L(`BGM: ${input.bgmUrl}`, `BGM: ${input.bgmUrl}`));
  if (input.soundDesign) out.push(L(`音效: ${input.soundDesign}`, `Sound: ${input.soundDesign}`));

  // Voice guidance: when no pre-generated voice exists, guide the VL
  if (!input.dialogues?.length && !input.narrations?.length && !input.innerMonologues?.length) {
    out.push("");
    out.push(L(
      "=== 声音引导（无预生成声音，请根据场景补充）===\n" +
      "- 战斗/动作镜头：加入 1-2 句战斗呐喊、短命令或闷哼\n" +
      "- 情绪/过渡镜头：加入 1 句画外旁白或内心独白\n" +
      "- 场面/景观镜头：以 SFX + 环境音为主\n" +
      "- 所有镜头：必须至少包含 1 个声音事件（SFX 或角色声音）\n" +
      "禁止虚构与场景剧情无关的冗长对白。",
      "=== VOICE GUIDANCE (no pre-generated voice, supplement based on scene) ===\n" +
      "- Combat/action shots: add 1-2 battle cries, commands, or grunts\n" +
      "- Emotional/transitional shots: add 1 voiceover or inner monologue\n" +
      "- Spectacle/landscape shots: SFX + ambience primarily\n" +
      "- ALL shots: at least 1 sound event (SFX or character voice)\n" +
      "DO NOT invent lengthy dialogue unrelated to the scene."
    ));
  }

  return out.join("\n");
}

// ═══ Layer 2: Constraints (Registry-backed) ═══════════════

function buildRefConstraintLayer(input: H3PromptInput, lang: H3Language): string {
  const L = (zh: string, en: string) => lang === "zh" ? zh : en;
  const camera = mapCameraDirection(input.cameraDirection);
  const duration = input.duration || 10;
  const segments = computeSegments(duration);
  const segLabels = segments.map(s => s.label);
  const hasDialogues = !!input.dialogues?.length;
  const hasNarrations = !!input.narrations?.length;
  const hasInnerMonologues = !!input.innerMonologues?.length;

  const slots = getDefaultSlotContents("ref_video_h3_constraints") ?? {};
  function r(key: string, fallback: string): string {
    return (slots[key] || fallback)
      .replaceAll("{{CAMERA_DIRECTION}}", camera)
      .replaceAll("{{SEGMENT_COUNT}}", String(segments.length))
      .replaceAll("{{SEGMENT_LABELS}}", segLabels.join(" / "));
  }

  const core: string[] = [];
  core.push(r("core_format", L("[6-Section 格式]", "[6-Section Format]")));
  core.push(r("core_subject", L("[Subject/Picture 闭环]", "[Subject/Picture Closure]")));
  core.push(r("core_env", L("[环境-标签引用]", "[Environment-Reference]")));

  const detail: string[] = [];
  detail.push(r("time_structure", L("[时间结构]", "[Time Structure]")));
  detail.push(r("camera", L("[运镜优先]", "[Camera Priority]")));
  detail.push(r("action_detail", L("[动作颗粒度]", "[Action Detail]")));
  detail.push(r("body_vocab", L("[身体动词]", "[Body Vocab]")));
  detail.push(r("spatial", L("[画面空间]", "[Spatial Layout]")));
  detail.push(r("voice", L("[声音]", "[Voice]")));
  detail.push(r("format", L("[格式]", "[Format]")));

  return L("=== 核心约束 — 必须严格遵守 ===", "=== CORE CONSTRAINTS ===") + "\n\n"
    + core.join("\n\n")
    + "\n\n" + L("=== 详细约束", "=== DETAILED CONSTRAINTS") + "\n\n"
    + detail.join("\n\n");
}

// ═══ Layer 3: Output Format ═══════════════════════════════

function buildOutputFormat(input: H3PromptInput, lang: H3Language): string {
  const L = (zh: string, en: string) => lang === "zh" ? zh : en;
  return L(
    `=== 输出格式要求（必须严格按照官方 Ref2VA 6 段格式）===

【1】subject_definitions:
中文。为每个被引用的 Subject、Picture 各一行，标注 in <Picture N>。
然后紧接着输出图片对齐声明。对齐时间 = 该参考图的关联内容在视频中**首次出现的时刻**。

对齐规则（按 Picture 类型分别判定）：
- 场景帧 (<Picture N=场景>)：始终对齐 0.00s。场景环境从视频第 0 秒就存在。
- 角色参考图 (<Picture N=角色>)：对齐到该角色在视频中**首次出场的时间**。
  判定方法：读上方「动作脚本」中的时间标注（如 "4-7秒：押解军汉出现在画面上方"）。
  若角色从视频开始就出场 → 0.00s。若角色在第 4.0 秒才出现 → 4.00s。

格式:
  <Picture 1> (from [Shot 1]) aligns with the 0.00-second mark of the target video;   ← 场景帧
  <Picture 2> (from [Shot 1]) aligns with the 4.00-second mark of the target video;   ← 角色第4秒出场
  <Picture 3> (from [Shot 1]) aligns with the 0.00-second mark of the target video.   ← 角色第0秒出场

【2】summary:
中文。首行 [reference_generation]，一句话。

【3】retention_analysis:
中文。每条必须包含 "appears in [Shot N]" + 保留级别 + 理由。
格式: <Subject N> (appears in [Shot 1]): fully_preserved — 理由。
     <Picture 1> ([Shot 1] 首帧): fully_preserved — 理由。
     <Audio 1>: reference — 理由。
若画面中存在未绑定参考图的背景人物（群演、路人、其他囚犯/士兵等），
retention_analysis 末尾追加: Background figures: no character references apply — faces are diverse and indistinct.

【4】detailed_description:
（字段名就是这个，不是 integrated_multimodal_description，只有 base mode 才用那个）
中文。风格开头（1-2句中文建立场景和视觉风格），然后起 [Shot 1]。格式:
  [场景风格描述。] [Shot 1] [中文视觉描述]. Camera: [H3 camera motion].
  对白嵌入: <Subject N> (S1) says: <d>[Chinese] 中文对白</d>
  旁白嵌入: (S1) says in an off-screen voiceover: <d>[Chinese] 中文旁白</d>
  切镜: [Shot 2] At MM:SS.mmm, [视觉描述].

运镜规则: 全程同一运镜只写一次 Camera: 在 [Shot 1] 行尾，后面每段不重复。

时间分段: 12s内按3-4s分，每段只写视觉进展不写运镜。按叙事节奏分段，不机械等分。

若画面中有背景群演（如队列中的其他士兵/囚犯、围观路人等），detailed_description 末尾追加一行:
  注意：画面中除已定义的 <Subject N> 外，其余人物不受角色参考图约束——他们的面孔各不相同、互不雷同。

【5】overall_soundscape:
中文。整体环境声总结，不含 shot 级音效（那些在 detailed_description 里）。
含时间段标签: [0.0s-3.0s] 寒风... [3.0s-6.0s] 踏雪声...

【6】non_diegetic_music:
中文。乐器+速度+动态。例如: 大提琴缓慢弦乐，极轻(pp)开始，6.0s渐强至中弱(mp)，12.0s渐弱至无声。

禁止: 省略section, markdown, 重复运镜, 中文body内的冗长英文叙述`,
    `=== OUTPUT FORMAT (FOLLOW OFFICIAL Ref2VA 6-SECTION ORDER) ===

【1】subject_definitions:
Chinese. One line per Subject/Picture, ending with "in <Picture N>".
Then, immediately after, output picture alignment declarations. Alignment time = when the reference image's content FIRST APPEARS in the target video.

Alignment rules (by Picture type):
- Scene frame (<Picture N=scene>): always 0.00s. The environment is present from second 0.
- Character ref (<Picture N=character>): aligns with the character's FIRST APPEARANCE in the video.
  How to determine: read the "Motion Script" timestamps above (e.g., "4-7s: Guard appears above").
  If the character appears from the start → 0.00s. If they enter at 4.0s → 4.00s.

Format:
  <Picture 1> (from [Shot 1]) aligns with the 0.00-second mark of the target video;   ← scene frame
  <Picture 2> (from [Shot 1]) aligns with the 4.00-second mark of the target video;   ← character enters at 4s
  <Picture 3> (from [Shot 1]) aligns with the 0.00-second mark of the target video.   ← character present from start

【2】summary:
Chinese. Start with [reference_generation]. One sentence.

【3】retention_analysis:
Chinese. Every entry: (appears in [Shot N]) + retention level + reason.
Format: <Subject N> (appears in [Shot 1]): fully_preserved — reason.
        <Picture 1> ([Shot 1] first frame): fully_preserved — reason.
If the frame contains background figures not bound to any reference,
append at end: Background figures: no character references apply — faces are diverse and indistinct.

【4】detailed_description:
(This IS the official Ref2VA field name. NOT integrated_multimodal_description.)
Chinese. Style opening (1-2 Chinese sentences), then [Shot 1].
Format: [Style context.] [Shot 1] [Chinese visual]. Camera: [H3 motion].
  Cut: [Shot 2] At MM:SS.mmm, [visual].
  Dialogue: <Subject N> (S1) says: <d>[Chinese] text</d>
  Voiceover: (S1) says off-screen: <d>[Chinese] text</d>
If same camera throughout, write Camera: ONCE only in [Shot 1]. Do NOT repeat per segment.

If the frame contains background extras (e.g., other soldiers/prisoners in a column, bystanders),
append to detailed_description: Note: figures other than the defined <Subject N> are NOT constrained by any character reference — their faces are diverse and distinct from one another.

【5】overall_soundscape:
Chinese. Ambience summary. Time-anchored. No shot-specific SFX (they go in detailed_description).

【6】non_diegetic_music:
Chinese. Instrument + tempo + dynamics + fade.

FORBIDDEN: skip sections, markdown, repeated camera, English content in Chinese body
  `
  );
}

// ═══ Helpers ═════════════════════════════════════════════

function computeSegments(duration: number): Array<{ label: string }> {
  if (duration <= 5) return [{ label: "0-5s" }];
  if (duration <= 8) { const m = Math.floor(duration / 2); return [{ label: `0-${m}s` }, { label: `${m}-${duration}s` }]; }
  if (duration <= 14) { const s = Math.floor(duration / 3); return [{ label: `0-${s}s` }, { label: `${s}-${s*2}s` }, { label: `${s*2}-${duration}s` }]; }
  const s = Math.floor(duration / 4);
  return [{ label: `0-${s}s` }, { label: `${s}-${s*2}s` }, { label: `${s*2}-${s*3}s` }, { label: `${s*3}-${duration}s` }];
}