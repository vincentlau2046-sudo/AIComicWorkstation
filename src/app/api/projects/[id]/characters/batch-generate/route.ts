import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, characters } from "@/lib/db/schema";
import { eq, and, isNull, isNotNull } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { generateText } from "ai";
import { createLanguageModel } from "@/lib/ai/ai-sdk";
import { buildCharacterFrontViewPrompt } from "@/lib/ai/prompts/character-image";
import { buildPhaseR2IPrompt } from "@/lib/ai/prompts/phase-image";
import type { ProviderConfig } from "@/lib/ai/ai-sdk";

export const maxDuration = 600;

type BatchType = "t2i_prompt" | "r2i_prompt" | "t2i_image" | "r2i_image";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const userId = getUserIdFromRequest(request);

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json()) as {
    type: BatchType;
    modelConfig: { text: ProviderConfig | null; image?: ProviderConfig | null };
    language?: "zh" | "en";
  };

  if (!body.type) {
    return NextResponse.json({ error: "Missing type" }, { status: 400 });
  }

  const isTemplate = body.type.startsWith("t2i");
  const targetChars = await db
    .select()
    .from(characters)
    .where(and(
      eq(characters.projectId, projectId),
      isNull(characters.episodeId),
      isTemplate ? isNull(characters.phaseName) : isNotNull(characters.phaseName),
    ));

  const results: Array<{ id: string; name: string; status: string; error?: string }> = [];

  // 步骤2：基于 EP 链的 T2I structure 方式，为 template 角色卡生成 t2i_structure
  // 输入 = 角色 description + visualHint（不含 EP 剧本内容）
  const language = body.language;
  const t2iSystem = language === "zh"
    ? "根据角色档案（description + visualHint），生成该角色的 t2iStructure JSON。" +
      "输出必须是 JSON 对象，含 7 个字段：age/subject/body/face/hair/clothing/lighting。" +
      "标签名用英文，字段值用中文。必须保留 description 中的风格/材质/光照提示（如 3D 国漫渲染风格、细腻材质、体积光）。只返回 JSON。"
    : "From the character profile (description + visualHint), generate the character's t2iStructure JSON. " +
      "Output MUST be a JSON object with 7 fields: age/subject/body/face/hair/clothing/lighting. " +
      "Tag names in English, field values in the source language. Preserve the style/material/lighting hints from the description. Return JSON only.";

  if (body.type === "t2i_prompt" && body.modelConfig?.text) {
    const model = createLanguageModel(body.modelConfig.text);
    for (const item of targetChars) {
      try {
        // 对齐 EP 链：t2iStructure 槽位传已存结构（null 则走散文回退），description 槽位传描述
        let prompt = buildCharacterFrontViewPrompt(item.t2iStructure ?? null, item.description || item.name);
        // 输入补充 visualHint（角色 DB 有用字段），不含 EP 剧本内容
        if (item.visualHint) {
          prompt = `${prompt}\n[visualHint] ${item.visualHint}`;
        }
        const result = await generateText({ model, system: t2iSystem, prompt });
        // 保存 JSON（而非纯文本），让 builder 的结构化路径可解析
        const t2iJson = result.text.trim();
        try {
          JSON.parse(t2iJson); // 校验是合法 JSON 才入库
          await db.update(characters).set({ t2iStructure: t2iJson }).where(eq(characters.id, item.id));
        } catch {
          console.warn(`[batch-generate] t2iStructure 不是合法 JSON（${item.name}），跳过入库`);
        }
        results.push({ id: item.id, name: item.name, status: "ok" });
      } catch (err) {
        results.push({ id: item.id, name: item.name, status: "error", error: String(err) });
      }
    }
  } else if (body.type === "r2i_prompt" && body.modelConfig?.text) {
    const model = createLanguageModel(body.modelConfig.text);
    const templates = await db
      .select()
      .from(characters)
      .where(and(eq(characters.projectId, projectId), isNull(characters.episodeId), isNull(characters.phaseName)));
    const tmplByBase = new Map<string, typeof templates[0]>();
    for (const t of templates) tmplByBase.set(t.baseName || t.name, t);

    for (const item of targetChars) {
      try {
        const template = item.baseName ? tmplByBase.get(item.baseName) : undefined;
        const visualChanges = item.visualChanges ? JSON.parse(item.visualChanges) : {};
        const r2iPrompt = buildPhaseR2IPrompt({
          characterName: item.baseName || item.name,
          phaseName: item.phaseName || "",
          visualChanges,
          templateDescription: template?.description || item.description || "",
        });
        await db.update(characters).set({ r2iStructure: r2iPrompt }).where(eq(characters.id, item.id));
        results.push({ id: item.id, name: item.name, status: "ok" });
      } catch (err) {
        results.push({ id: item.id, name: item.name, status: "error", error: String(err) });
      }
    }
  } else if (body.type === "t2i_image" || body.type === "r2i_image") {
    return NextResponse.json({
      error: "Image batch not implemented here - use /api/projects/{id}/generate with action",
    }, { status: 400 });
  } else {
    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  }

  return NextResponse.json({
    results,
    total: targetChars.length,
    ok: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "error").length,
  });
}
