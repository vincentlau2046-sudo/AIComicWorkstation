/**
 * User-message builder for the `ref_video_prompt` AI call.
 *
 * NOTE: The system prompt is NOT defined here — it lives in
 * `registry.ts` under `refVideoPromptDef` (single source of truth, also
 * exposed in the prompt management UI so users can override it).
 * This file only builds the per-request user payload.
 *
 * Output style follows the official 即梦 / Seedance inline syntax:
 *   - References are written as `@图片N` (not `@图片N`)
 *   - Flowing natural-language prose, no structured mapping header, no
 *     "节拍 1/2/3" labels, no 【对白口型】tags
 *   - Dialogue inline as "角色台词：..." appended after the action prose
 */

export interface SceneFrameInfo {
  label: string;      // e.g. "宫殿外"、"竹林"
  index: number;      // 1-based position in the ordered reference list
}

export interface CharacterRefInfo {
  name: string;
  index: number;      // 1-based position in the ordered reference list
  visualHint?: string | null;
}

export function buildRefVideoPromptRequest(params: {
  motionScript: string;
  cameraDirection: string;
  duration: number;
  characters: CharacterRefInfo[];
  sceneFrames: SceneFrameInfo[];
  dialogues?: Array<{ characterName: string; text: string; offscreen?: boolean; visualHint?: string }>;
  textOnly?: boolean;  // skip @图片 references when no images are sent
}): string {
  const lines: string[] = [];

  if (!params.textOnly) {
    lines.push(
      `你会收到以下参考图（顺序严格对应 @图片1、@图片2、@图片3 ...，必须使用 \`@图片N\` 形式，**不能**写成 \`@图片N\`）：`
    );
    for (const c of params.characters) {
      const hint = c.visualHint ? `（${c.visualHint}）` : "";
      lines.push(`  @图片${c.index} = 角色：${c.name}${hint}`);
    }
    for (const s of params.sceneFrames) {
      lines.push(`  @图片${s.index} = 场景：${s.label}`);
    }
    lines.push(``);
  } else {
    // Text-only mode: describe characters without @图片 references
    if (params.characters.length > 0) {
      lines.push(`角色列表：`);
      for (const c of params.characters) {
        const hint = c.visualHint ? `（${c.visualHint}）` : "";
        lines.push(`  - ${c.name}${hint}`);
      }
      lines.push(``);
    }
  }

  if (params.sceneFrames.length > 1) {
    lines.push(
      `本镜头有 ${params.sceneFrames.length} 张场景参考图，按顺序对应镜头内的空间切换。散文中要依次经过这些场景并写清楚过渡。`
    );
    lines.push(``);
  }

  if (params.characters.length === 0) {
    lines.push(
      `注意：本镜头没有角色登场，只描述场景环境变化和镜头运动，不要编造任何人物。`
    );
    lines.push(``);
  }

  lines.push(`剧本动作：${params.motionScript}`);
  lines.push(`机位指令：${params.cameraDirection}`);
  lines.push(`时长：${params.duration}s`);

  if (params.dialogues?.length) {
    lines.push(
      `对白（保持原文语言，直接嵌入散文末尾，用"角色名台词：..."的格式）：${params.dialogues
        .map((d) => `${d.characterName}: "${d.text}"`)
        .join("; ")}`
    );
  }

  lines.push(``);
  lines.push(`严格要求（按 MiniMax H3 官方格式）：`);
  if (!params.textOnly) {
    lines.push(`1. 使用 \`@图片N\` 形式引用所有角色和场景（例：@图片1、@图片2），禁止写成带空格的 \`@图片 N\``);
    lines.push(`2. 输出必须包含 H3 分镜时间线：integrated_multimodal_description 用 [Shot 1]（不加时间戳）→ [Shot 2] At 00:0X.XXX 切镜 → … → [Shot N]，切镜时间严格递增，最后一镜在视频结束前落到尾帧`);
    lines.push(`3. 三个核心字段必须齐全：integrated_multimodal_description / overall_soundscape / non_diegetic_music（无配乐写 N/A）`);
    lines.push(`4. 运镜按"运动类型 + 幅度 + 速度"三维写成自然动作（例：the camera pushes in with small amplitude at slow speed）`);
  } else {
    lines.push(`1. 根据角色列表和场景描述，生成 H3 分镜时间线（[Shot 1]…[Shot N]）`);
    lines.push(`2. 禁止使用 @图片N 引用或任何图像标签`);
    lines.push(`3. 三个核心字段齐全；无配乐时 non_diegetic_music 写 N/A`);
  }
  lines.push(`5. 对白（如有）用说话人稳定 ID（S1/S2）+ [语言] 标签，原文逐字保留`);
  lines.push(`6. 仅输出提示词正文，无前言、无 markdown、无注释`);

  return lines.join("\n");
}
