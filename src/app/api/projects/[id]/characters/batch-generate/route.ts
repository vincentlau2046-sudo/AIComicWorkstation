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

  // T2I 结构输出语言跟随语言选择：zh → 中文标签，en/未指定 → 英文
  const language = body.language;
  const t2iSystem = language === "zh"
    ? "根据角色描述，用 [标签] 格式生成结构化的 Qwen Image 2512 提示词。所有 [标签] 及其内容必须用中文输出。只返回提示词文本。"
    : "Generate a structured Qwen Image 2512 prompt using [tags] format.";

  if (body.type === "t2i_prompt" && body.modelConfig?.text) {
    const model = createLanguageModel(body.modelConfig.text);
    for (const item of targetChars) {
      try {
        const prompt = buildCharacterFrontViewPrompt(item.description || item.name, item.name, language);
        const result = await generateText({
          model,
          system: t2iSystem,
          prompt,
        });
        const t2iText = result.text.trim();
        if (t2iText) {
          await db.update(characters).set({ t2iStructure: t2iText }).where(eq(characters.id, item.id));
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
