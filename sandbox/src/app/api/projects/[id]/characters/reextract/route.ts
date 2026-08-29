import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, characters, episodes, episodeCharacters, importLogs } from "@/lib/db/schema";
import { eq, and, desc, inArray, isNull } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { generateText } from "ai";
import { createLanguageModel } from "@/lib/ai/ai-sdk";
import { parseLLMJSON } from "@/lib/ai/json-repair";
import { resolvePrompt } from "@/lib/ai/prompts/resolver";
import { buildCharacterFrontViewPrompt } from "@/lib/ai/prompts/character-image";
import { id as genId } from "@/lib/id";
import type { ProviderConfig } from "@/lib/ai/ai-sdk";

export const maxDuration = 1200;

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
    modelConfig: { text: ProviderConfig | null };
    language?: "zh" | "en";
  };

  if (!body.modelConfig?.text) {
    return NextResponse.json({ error: "No text model configured" }, { status: 400 });
  }

  // ── Step 1: Get source text ──
  let sourceText = "";

  // Try import Step 1 log first
  const step1Logs = await db
    .select()
    .from(importLogs)
    .where(and(eq(importLogs.projectId, projectId), eq(importLogs.step, 1), eq(importLogs.status, "done")))
    .orderBy(desc(importLogs.createdAt))
    .limit(1);

  if (step1Logs.length > 0 && step1Logs[0].metadata) {
    const meta = step1Logs[0].metadata as { fullText?: string };
    if (meta.fullText) sourceText = meta.fullText;
  }

  // Fallback: reconstruct from episode data
  if (!sourceText) {
    const eps = await db
      .select()
      .from(episodes)
      .where(eq(episodes.projectId, projectId))
      .orderBy(episodes.sequence);

    if (eps.length === 0) {
      return NextResponse.json({ error: "No source text or episodes found" }, { status: 400 });
    }

    // Build character-name map per episode
    const epCharRows = await db
      .select({
        episodeId: episodeCharacters.episodeId,
        charName: characters.name,
      })
      .from(episodeCharacters)
      .innerJoin(characters, eq(episodeCharacters.characterId, characters.id))
      .where(eq(characters.projectId, projectId));

    const charsByEp = new Map<string, string[]>();
    for (const row of epCharRows) {
      const list = charsByEp.get(row.episodeId) || [];
      list.push(row.charName);
      charsByEp.set(row.episodeId, list);
    }

    sourceText = eps
      .map((ep) => {
        const charList = charsByEp.get(ep.id) || [];
        const charStr = charList.length > 0 ? `角色：${charList.join("、")}` : "";
        return `EP.${ep.sequence}: ${ep.title} — ${ep.description || ""}\n${ep.idea ? `创意：${ep.idea}` : ""}${charStr ? `\n${charStr}` : ""}`;
      })
      .join("\n\n---\n\n");
  }

  // Detect language
  const lang = /[一-鿿]/.test(sourceText.slice(0, 1000)) ? "zh" as const : "en" as const;

  // ── Step 2: Extract characters ──
  const model = createLanguageModel(body.modelConfig.text);
  const extractSystem = await resolvePrompt("import_characters", { userId, projectId, language: lang });

  const styleBlock = project.visualStyle
    ? `\n\n项目风格: ${project.visualStyle}\n时代美学: ${project.eraAesthetic || "未指定"}`
    : "";

  const jsonMode = { openai: { response_format: { type: "json_object" as const } } };
  const prompt = `从以下文本中穷举提取所有出场角色，零遗漏。${styleBlock}

--- TEXT ---
${sourceText}
--- END ---

仅返回JSON对象。`;

  let extractedChars: Array<{ name: string; frequency: number; description: string; visualHint?: string; scope?: string }> = [];
  let extractedRels: Array<{ characterA: string; characterB: string; relationType: string; description?: string }> = [];

  try {
    const result = await generateText({ model, system: extractSystem, prompt, providerOptions: jsonMode });
    try {
      const parsed = parseLLMJSON(result.text);
      if (Array.isArray(parsed)) {
        extractedChars = parsed;
      } else {
        extractedChars = parsed.characters || [];
        extractedRels = parsed.relationships || [];
      }
    } catch {
      // Retry once
      const retry = await generateText({
        model, system: extractSystem,
        prompt: prompt + "\n\nIMPORTANT: Return COMPLETE, VALID JSON.",
        providerOptions: jsonMode,
      });
      const parsed = parseLLMJSON(retry.text);
      if (Array.isArray(parsed)) {
        extractedChars = parsed;
      } else {
        extractedChars = parsed.characters || [];
        extractedRels = parsed.relationships || [];
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Character extraction failed: ${msg}` }, { status: 500 });
  }

  // Apply scope fallback
  extractedChars = extractedChars.map((c) => ({
    ...c,
    scope: c.scope === "main" || c.scope === "guest" ? c.scope : c.frequency >= 2 ? "main" : "guest",
  }));

  // ── Step 3: Upsert template characters ──
  const updatedChars: any[] = [];
  const existingTemplates = await db
    .select()
    .from(characters)
    .where(
      and(
        eq(characters.projectId, projectId),
        isNull(characters.episodeId),
        isNull(characters.phaseName),
      )
    );

  const existingMap = new Map<string, typeof existingTemplates[0]>();
  for (const c of existingTemplates) {
    const key = (c.baseName || c.name).toLowerCase().trim();
    // Simple dedup: first occurrence wins (no createdAt column available)
    if (!existingMap.has(key)) {
      existingMap.set(key, c);
    }
  }

  for (const ec of extractedChars) {
    const matchKey = ec.name.toLowerCase().trim();
    const existing = existingMap.get(matchKey);
    if (existing) {
      // Update existing
      await db
        .update(characters)
        .set({
          name: ec.name,
          description: ec.description,
          visualHint: ec.visualHint ?? existing.visualHint,
          scope: (ec.scope as "main" | "guest") ?? existing.scope,
        })
        .where(eq(characters.id, existing.id));
      updatedChars.push({ ...existing, name: ec.name, description: ec.description, visualHint: ec.visualHint ?? existing.visualHint, scope: (ec.scope as "main" | "guest") ?? existing.scope });
    } else {
      // Insert new
      const newId = genId();
      await db.insert(characters).values({
        id: newId,
        projectId,
        baseName: ec.name,
        name: ec.name,
        description: ec.description,
        visualHint: ec.visualHint ?? "",
        scope: (ec.scope as "main" | "guest") ?? "main",
        episodeId: null,
      });
      updatedChars.push({ id: newId, projectId, baseName: ec.name, name: ec.name, description: ec.description, visualHint: ec.visualHint ?? "", scope: (ec.scope as "main" | "guest") ?? "main" });
    }
  }

  // ── Step 4: Generate T2I Structure for each template ──
  // T2I 结构输出语言跟随语言选择：zh → 中文标签，en/未指定 → 英文
  const language = body.language;
  const t2iSystem = language === "zh"
    ? "根据角色描述，用 [标签] 格式生成结构化的 Qwen Image 2512 提示词。所有 [标签] 及其内容必须用中文输出。只返回提示词文本，不要包含任何额外说明。"
    : "Generate a structured Qwen Image 2512 prompt using [tags] format based on the character description. Return ONLY the prompt text.";
  const t2iModel = createLanguageModel(body.modelConfig.text);
  let t2iCount = 0;
  for (const uc of updatedChars) {
    // 对齐 EP 链：t2iStructure 槽位（重新提取时尚未生成，传 null → 散文回退），description 槽位传描述
    const t2iPrompt = buildCharacterFrontViewPrompt(null, uc.description || uc.name);
    const t2iResult = await generateText({
      model: t2iModel,
      system: t2iSystem,
      prompt: t2iPrompt,
    });
    const t2iText = t2iResult.text.trim();
    if (t2iText) {
      await db.update(characters).set({ t2iStructure: t2iText }).where(eq(characters.id, uc.id));
      t2iCount++;
    }
  }

  return NextResponse.json({
    characters: updatedChars,
    count: updatedChars.length,
    t2iGenerated: t2iCount,
  });
}