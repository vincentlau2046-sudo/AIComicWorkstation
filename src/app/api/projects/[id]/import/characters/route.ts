import { NextResponse } from "next/server";
import { generateText } from "ai";
import { createLanguageModel } from "@/lib/ai/ai-sdk";
import { parseLLMJSON } from "@/lib/ai/json-repair";
import type { ProviderConfig } from "@/lib/ai/ai-sdk";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { addImportLog } from "@/lib/import-utils";
import { resolvePrompt } from "@/lib/ai/prompts/resolver";

export const maxDuration = 1200;

interface ExtractedChar {
  name: string;
  frequency: number;
  description: string;
  visualHint?: string;
}

interface ExtractedRelation {
  characterA: string;
  characterB: string;
  relationType: string;
  description?: string;
}

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
    text: string;
    modelConfig: { text: ProviderConfig | null };
    styleContext?: { visualStyle: string; eraAesthetic: string };
  };

  if (!body.modelConfig?.text) {
    return NextResponse.json({ error: "No text model" }, { status: 400 });
  }

  // Detect language: check if first 1000 chars contain CJK characters
  const lang = /[一-鿿]/.test(body.text.slice(0, 1000)) ? "zh" as const : "en" as const;

  const model = createLanguageModel(body.modelConfig.text);
  const importCharSystem = await resolvePrompt("import_characters", { userId, projectId, language: lang });

  await addImportLog(
    projectId, 3, "running",
    `开始角色提取 (语言: ${lang})`
  );

  const styleBlock = body.styleContext?.visualStyle
    ? `\n\n项目风格: ${body.styleContext.visualStyle}\n时代美学: ${body.styleContext.eraAesthetic || "未指定"}`
    : "";

  let chars: ExtractedChar[];
  let rels: ExtractedRelation[];

  try {
    const jsonMode = {
      openai: { response_format: { type: "json_object" } },
    };
    const prompt = `从以下文本中穷举提取所有出场角色，零遗漏。${styleBlock}

--- TEXT ---
${body.text}
--- END ---

仅返回JSON对象。`;

    const result = await generateText({
      model,
      system: importCharSystem,
      prompt,
      providerOptions: jsonMode,
    });

    try {
      const parsed = parseLLMJSON(result.text);
      if (Array.isArray(parsed)) {
        chars = parsed as ExtractedChar[];
        rels = [];
      } else {
        chars = (parsed.characters || []) as ExtractedChar[];
        rels = (parsed.relationships || []) as ExtractedRelation[];
      }
    } catch {
      console.error(`[ImportChars] JSON parse failed. Raw:\n${result.text.slice(0, 500)}...`);
      await addImportLog(projectId, 3, "running", `JSON 解析失败，正在重试...`);
      const retry = await generateText({
        model,
        system: importCharSystem,
        prompt: prompt + "\n\nIMPORTANT: Return COMPLETE, VALID JSON.",
        providerOptions: jsonMode,
      });
      const parsed = parseLLMJSON(retry.text);
      if (Array.isArray(parsed)) {
        chars = parsed as ExtractedChar[];
        rels = [];
      } else {
        chars = (parsed.characters || []) as ExtractedChar[];
        rels = (parsed.relationships || []) as ExtractedRelation[];
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await addImportLog(projectId, 3, "error", `角色提取失败: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Sort by frequency, apply scope fallback
  const result = chars
    .sort((a, b) => b.frequency - a.frequency)
    .map((c) => ({
      ...c,
      scope: (c as any).scope === "main" || (c as any).scope === "guest"
        ? (c as any).scope
        : (c.frequency >= 2 ? "main" as const : "guest" as const),
    }));

  // Deduplicate relationships
  const relSet = new Set<string>();
  const uniqueRelations = rels.filter((r) => {
    const key = [r.characterA, r.characterB].sort().join("↔");
    if (relSet.has(key)) return false;
    relSet.add(key);
    return true;
  });

  await addImportLog(
    projectId, 3, "done",
    `提取完成，共 ${result.length} 个角色（主角 ${result.filter((c) => c.scope === "main").length}，配角 ${result.filter((c) => c.scope === "guest").length}），${uniqueRelations.length} 个关系`,
    { characters: result, relationships: uniqueRelations }
  );

  return NextResponse.json({ characters: result, relationships: uniqueRelations });
}
