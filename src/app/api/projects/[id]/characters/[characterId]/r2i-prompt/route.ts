import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { characters, projects } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { generateText } from "ai";
import { createLanguageModel, type ProviderConfig } from "@/lib/ai/ai-sdk";
import { resolvePrompt } from "@/lib/ai/prompts/resolver";
import { buildPhaseR2IPrompt } from "@/lib/ai/prompts/phase-image";

/**
 * 单角色 Phase R2I 提示词（r2iStructure）生成。
 *
 * 优先调用 LLM + r2i_prompt system prompt 输出自然文本（含 "Picture 1" 锚点、增量描述）；
 * LLM 失败时 fallback 到本地启发式 buildPhaseR2IPrompt（已加 "Picture 1" 前缀）。
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; characterId: string }> }
) {
  const { id: projectId, characterId } = await params;
  const userId = getUserIdFromRequest(request);
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [phaseChar] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.projectId, projectId)));

  if (!phaseChar) {
    return NextResponse.json({ error: "Character not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    modelConfig?: { text: ProviderConfig | null };
    language?: "zh" | "en";
  };

  const [template] = await db
    .select()
    .from(characters)
    .where(and(
      eq(characters.projectId, projectId),
      eq(characters.baseName, phaseChar.baseName),
      isNull(characters.episodeId),
      isNull(characters.phaseName),
    ));

  let visualChanges: Record<string, string> = {};
  try { visualChanges = JSON.parse(phaseChar.visualChanges || "{}"); } catch {}

  // ── 项目时代美学 & 视觉风格 ──
  const [projStyle] = await db
    .select({ visualStyle: projects.visualStyle, eraAesthetic: projects.eraAesthetic })
    .from(projects)
    .where(eq(projects.id, projectId));
  const styleCtx = `\nPROJECT STYLE ANCHORS (authoritative — all output must conform):\n`
    + `视觉风格: ${projStyle?.visualStyle || "未指定"}\n`
    + `时代美学: ${projStyle?.eraAesthetic || "未指定"}\n`
    + `角色服装、道具、建筑风格必须与上述时代/风格严格一致。\n`;

  // ── LLM path: natural text (Picture 1 + delta) via r2i_prompt ──
  if (body.modelConfig?.text) {
    const language = body.language ?? "en";
    const templateT2I = template?.t2iStructure;

    const changesStr = Object.entries(visualChanges)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n");

    const llmPrompt = styleCtx + (templateT2I
      ? `TEMPLATE BASELINE — REFERENCE DATA ONLY (DO NOT COPY):

Fields present in baseline: age, face, body, hair, clothing, lighting.
(Values intentionally omitted — exist in reference image, must NOT be re-described.)

Phase: ${phaseChar.phaseName || ""}
Visual changes:
${changesStr || "(none)"}
Phase description: ${phaseChar.description || ""}

Follow this exact format. Replace the EXAMPLE values below with this phase's actual values.
CRITICAL: Only describe what CHANGED from the baseline. Skip any line that hasn't changed.

EXAMPLE OUTPUT (for reference only - replace values with this phase's actual changes):
[character design sheet] [front view] [full body] [standing pose]
[pose: neutral standing, arms at sides, feet shoulder-width apart, neutral expression]
[environment: pure white background, no shadow]
[quality: sharp focus, high detail, character reference sheet]
[lighting: 3D国漫渲染风格, 柔和体积光, 细腻材质]

[era: 明代中国]
[style: 3D国漫渲染]

age: 21-23岁
clothing: 深青色官袍，外披狐裘，腰束革带，脚穿玄色短靴（从头到脚完整穿着）
hair: 官帽由精致转为务实
facial: （无新增面部特征，跳过此行）
accessories: 随身携带简单文书档案、精致护身符
expression: 目光低调专业，透着对未来的预见
posture: 挺拔沉稳

All other features match the reference.
Only describe what CHANGES from the baseline for this phase.
If nothing changed for a feature, skip it entirely.
End with: "All other features match the reference."`
      + (language === "zh"
          ? "\n\n严格按照以下模板输出，没有变化的整行跳过：\n\n"
          + "Picture 1\n"
          + "[character design sheet] [front view] [full body] [standing pose]\n"
          + "[pose: neutral standing, arms at sides, feet shoulder-width apart]\n"
          + "[environment: pure white background, no shadow]\n"
          + "[quality: sharp focus, high detail, character reference sheet]\n"
          + "[lighting: 3D国漫渲染风格, 柔和体积光, 细腻材质]\n"
          + "\n"
          + "[era: 明代中国]\n"
          + "[style: 3D国漫渲染]\n"
          + "\n"
          + "age: [年龄，仅数字或年龄段]\n"
          + "clothing: [从头到脚的完整穿着，含鞋履]\n"
          + "hair: [发型，不含临时状态]\n"
          + "facial: [仅新增面部变化：伤疤/光头/皱纹/老年斑/眼袋]\n"
          + "accessories: [仅新增的小型随身物品]\n"
          + "expression: [仅阶段神情气质]\n"
          + "posture: [仅站姿体态——挺拔/微躬/放松，不含动作]\n"
          + "\n"
          + "All other features match the eference."
          : "")
      : `Character: ${phaseChar.baseName || phaseChar.name}
Phase: ${phaseChar.phaseName || ""}
Visual changes:
${changesStr || "(none)"}
Phase description: ${phaseChar.description || ""}

Generate the R2I prompt for this phase as natural text.
Start with:
[era: ${projStyle?.eraAesthetic || "未指定"}]
[style: ${projStyle?.visualStyle || "未指定"}]

Picture 1
[character design sheet] [front view] [full body] [standing pose]
[pose: neutral standing, arms at sides, feet shoulder-width apart, neutral expression]
[environment: pure white background, no shadow]
[quality: sharp focus, high detail, character reference sheet]
[lighting: 3D国漫渲染风格, 柔和体积光, 细腻材质]

Then list only what changes. End with "All other features match the reference."`);

    try {
      const r2iSystem = await resolvePrompt("r2i_prompt", { userId, projectId, language });
      const model = createLanguageModel(body.modelConfig.text);
      const result = await generateText({ model, system: r2iSystem, prompt: llmPrompt });
      const r2iText = result.text.trim();

      if (r2iText.length > 10) {
        await db.update(characters).set({ r2iStructure: r2iText }).where(eq(characters.id, characterId));
        return NextResponse.json({ prompt: r2iText });
      }
    } catch (err) {
      console.warn(`[r2i-prompt] ${phaseChar.name}: LLM path failed (${err instanceof Error ? err.message : "unknown"}), falling back to heuristics`);
    }
  }

  // ── Fallback: legacy heuristics (prose, with Picture 1 prefix) ──
  const prompt = buildPhaseR2IPrompt({
    characterName: phaseChar.baseName || phaseChar.name,
    phaseName: phaseChar.phaseName || "",
    visualChanges,
    templateDescription: template?.description || "",
  });
  const r2iFallback = "Picture 1, " + prompt;
  await db.update(characters).set({ r2iStructure: r2iFallback }).where(eq(characters.id, characterId));
  return NextResponse.json({ prompt: r2iFallback });
}
