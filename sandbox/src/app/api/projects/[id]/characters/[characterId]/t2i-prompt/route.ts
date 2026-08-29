import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { characters, projects } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { generateText } from "ai";
import { createLanguageModel, extractJSON, type ProviderConfig } from "@/lib/ai/ai-sdk";
import { buildCharacterFrontViewPrompt } from "@/lib/ai/prompts/character-image";
import { resolvePrompt } from "@/lib/ai/prompts/resolver";

/**
 * 单角色 T2I 提示词（t2iStructure）生成。
 * Template 行与 Phase 行采用不同的上下文与约束：
 * - Template → 仅用名称 + visualHint（不含 description，因其含弧线迁移内容），约束输出中性基准特征（素衣素履）
 * - Phase    → 以 Template 的 t2iStructure 为基准，仅输出本阶段相对基准的视觉偏移
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

  const [character] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, characterId));

  if (!character) {
    return NextResponse.json({ error: "Character not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    modelConfig?: { text: ProviderConfig | null };
    language?: "zh" | "en";
  };

  if (!body.modelConfig?.text) {
    return NextResponse.json({ error: "No text model configured" }, { status: 400 });
  }

  const language = body.language ?? "en";
  const isTemplate = !character.phaseName;

  // ── 项目时代美学 & 视觉风格 ──
  const [projStyle] = await db
    .select({ visualStyle: projects.visualStyle, eraAesthetic: projects.eraAesthetic })
    .from(projects)
    .where(eq(projects.id, projectId));
  const styleCtx = `\nPROJECT STYLE ANCHORS (authoritative — all output must conform):\n`
    + `视觉风格: ${projStyle?.visualStyle || "未指定"}\n`
    + `时代美学: ${projStyle?.eraAesthetic || "未指定"}\n`
    + `角色特征必须与上述时代/风格严格一致。\n`;

  let prompt: string;

  if (isTemplate) {
    // ── Template 行：只用名称 + visualHint，不用 description（含弧线迁移内容） ──
    const hint = character.visualHint
      ? `[visualHint] ${character.visualHint}`
      : "";
    prompt = styleCtx + `[Character] ${character.name}${hint}

IMPORTANT — TEMPLATE (baseline) card:
Output ONLY neutral baseline features: face shape, skin tone, eye/nose/lip shape, body type, height.
Use plain neutral clothing (white/gray). Do NOT include age progression, wardrobe evolution, or phase-specific details.
These belong to Phase cards.
MUST include "era" and "style" fields from the PROJECT STYLE ANCHORS above.`;
  } else {
    // ── Phase 行：以 Template 的 t2iStructure 为基准 ──
    const [template] = await db
      .select({ t2iStructure: characters.t2iStructure })
      .from(characters)
      .where(and(
        eq(characters.projectId, projectId),
        eq(characters.baseName, character.baseName),
        isNull(characters.episodeId),
        isNull(characters.phaseName),
      ));
    const baseline = template?.t2iStructure || character.t2iStructure;
    const baselineBlock = baseline
      ? `Template baseline:\n${JSON.stringify(JSON.parse(baseline), null, 2)}`
      : `Character: ${character.name}`;
    const hint = character.visualHint ? `\n[visualHint] ${character.visualHint}`   : "";
    prompt = styleCtx + `[Phase: ${character.phaseName}]
${baselineBlock}${hint}

IMPORTANT — Phase card:
Based on the Template baseline above, output ONLY the changes for this specific stage:
phase-specific age, costume, hairstyle, accessories, or body changes.
Do NOT repeat baseline fields. Keep face/lighting/shape unchanged unless explicitly noted.
MUST include "era" and "style" fields from the PROJECT STYLE ANCHORS above.`;
  }

  const t2iSystem = await resolvePrompt("t2i_prompt", { userId, projectId, language });
  const model = createLanguageModel(body.modelConfig.text);
  const result = await generateText({ model, system: t2iSystem, prompt });

  // Strip markdown code blocks and validate JSON before saving
  const t2iJson = extractJSON(result.text);
  try {
    JSON.parse(t2iJson);
    await db.update(characters).set({ t2iStructure: t2iJson }).where(eq(characters.id, characterId));
  } catch {
    console.warn(`[t2i-prompt] ${character.name}: output is not valid JSON, skipping`);
    return NextResponse.json({ prompt: t2iJson, saved: false });
  }

  return NextResponse.json({ prompt: t2iJson });
}