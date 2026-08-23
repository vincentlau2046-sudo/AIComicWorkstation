import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, characters, episodes, episodeCharacters } from "@/lib/db/schema";
import { eq, and, or, isNull, isNotNull } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { generateText } from "ai";
import { createLanguageModel } from "@/lib/ai/ai-sdk";
import { parseLLMJSON } from "@/lib/ai/json-repair";
import type { ProviderConfig } from "@/lib/ai/ai-sdk";

export const maxDuration = 1200;

interface Enrichment {
  characterName: string;
  phaseName: string;
  description: string;
  visualHint: string;
}

function parseEnrichments(text: string): Enrichment[] | null {
  try {
    const parsed = parseLLMJSON(text);
    if (parsed && Array.isArray(parsed.phaseEnrichments)) {
      return parsed.phaseEnrichments as Enrichment[];
    }
    if (Array.isArray(parsed)) {
      return parsed as Enrichment[];
    }
  } catch {
    // ignore
  }
  return null;
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
    modelConfig: { text: ProviderConfig | null };
  };

  if (!body.modelConfig?.text) {
    return NextResponse.json({ error: "No text model" }, { status: 400 });
  }

  const phaseChars = await db
    .select()
    .from(characters)
    .where(and(
      eq(characters.projectId, projectId),
      isNull(characters.episodeId),
      isNotNull(characters.phaseName),
    ))
    .orderBy(characters.baseName, characters.phaseName);

  if (phaseChars.length === 0) {
    return NextResponse.json({ phases: [], count: 0 });
  }

  const templateChars = await db
    .select()
    .from(characters)
    .where(and(
      eq(characters.projectId, projectId),
      isNull(characters.episodeId),
      isNull(characters.phaseName),
      or(eq(characters.scope, "main"), eq(characters.scope, "guest")),
    ));

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

  const allEps = await db
    .select()
    .from(episodes)
    .where(eq(episodes.projectId, projectId))
    .orderBy(episodes.sequence);

  const epSummaries = allEps
    .map((ep) => {
      const charList = charsByEp.get(ep.id) || [];
      const charStr = charList.length > 0 ? `角色：${charList.join("、")}` : "";
      return `EP.${ep.sequence}: ${ep.title} - ${ep.description || ""}${charStr ? `\n${charStr}` : ""}`;
    })
    .join("\n\n");

  const isZh = /[一-鿿]/.test(phaseChars[0]?.name || "");

  const templateBlock = templateChars
    .map((c) => `- ${c.name}（${c.scope === "main" ? "主角" : "配角"}）: ${(c.description || "").slice(0, 100)}`)
    .join("\n");

  const phaseBlock = phaseChars
    .map((pc) => {
      return `- ${pc.baseName || pc.name} / ${pc.phaseName}：${pc.episodeSequences || ""}
  current description：${pc.description || "（空）"}
  current visualHint：${pc.visualHint || "（空）"}`;
    })
    .join("\n\n");

  const prompt = isZh
    ? `为以下每个视觉阶段角色补充 description 和 visualHint。

规则：
1. 不要修改已有字段
2. description 2-3句，引用剧情
3. visualHint 10-15字，逗号分隔

[Template 角色]
${templateBlock}

[视觉阶段列表]
${phaseBlock}

[分集概要]
${epSummaries}

输出 JSON：
{
  "phaseEnrichments": [...]
}`
    : `Enrich each phase character with description and visualHint.

Rules:
1. Do not modify existing fields
2. description 2-3 sentences referencing story
3. visualHint 10-15 chars comma separated

[Template Characters]
${templateBlock}

[Phase List]
${phaseBlock}

[Episode Summaries]
${epSummaries}

Output JSON:
{
  "phaseEnrichments": [...]
}`;

  const model = createLanguageModel(body.modelConfig.text);
  const jsonMode = { openai: { response_format: { type: "json_object" as const } } };
  const system = isZh ? "你是一位角色设计师。根据剧情上下文为视觉阶段角色补充描述。" : "You are a character designer. Enrich phase descriptions based on story context.";

  try {
    const result = await generateText({ model, system, prompt, providerOptions: jsonMode });
    let enrichments = parseEnrichments(result.text);
    if (!enrichments) {
      const retry = await generateText({
        model, system,
        prompt: prompt + "\n\nIMPORTANT: Return COMPLETE, VALID JSON.",
        providerOptions: jsonMode,
      });
      enrichments = parseEnrichments(retry.text);
    }
    if (!enrichments) {
      return NextResponse.json({ error: "Failed to parse LLM response" }, { status: 500 });
    }

    let updatedCount = 0;
    for (const en of enrichments) {
      const nameKey = (en.characterName || "").toLowerCase().trim();
      const phaseKey = (en.phaseName || "").toLowerCase().trim();
      if (!nameKey || !phaseKey) continue;
      const match = phaseChars.find(
        (pc) =>
          (pc.baseName || pc.name).toLowerCase().trim() === nameKey &&
          (pc.phaseName || "").toLowerCase().trim() === phaseKey
      );
      if (!match) continue;
      await db
        .update(characters)
        .set({ description: en.description, visualHint: en.visualHint })
        .where(eq(characters.id, match.id));
      updatedCount++;
    }

    return NextResponse.json({
      phases: enrichments,
      total: enrichments.length,
      updated: updatedCount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
