import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, characters, episodes } from "@/lib/db/schema";
import { eq, and, isNull, isNotNull, or } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { generateText } from "ai";
import { createLanguageModel } from "@/lib/ai/ai-sdk";
import { parseLLMJSON } from "@/lib/ai/json-repair";
import type { ProviderConfig } from "@/lib/ai/ai-sdk";

export const maxDuration = 1200;

interface Enrichment {
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

function epAppears(
  ep: { title?: string; description?: string | null; idea?: string | null },
  name: string
): boolean {
  return (
    (ep.title || "").includes(name) ||
    (ep.description || "").includes(name) ||
    (ep.idea || "").includes(name)
  );
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
    language?: "zh" | "en";
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
    return NextResponse.json({ characters: 0, updated: 0, failures: [] });
  }

  // Group phase rows by baseName (one LLM call per base character)
  const groups = new Map<string, (typeof phaseChars)[number][]>();
  for (const pc of phaseChars) {
    const key = pc.baseName || pc.name;
    const list = groups.get(key) || [];
    list.push(pc);
    groups.set(key, list);
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

  const allEps = await db
    .select()
    .from(episodes)
    .where(eq(episodes.projectId, projectId))
    .orderBy(episodes.sequence);

  const isZh = body.language ? body.language === "zh" : /[一-鿿]/.test(phaseChars[0]?.name || "");

  const model = createLanguageModel(body.modelConfig.text);
  const jsonMode = { openai: { response_format: { type: "json_object" as const  } } };

  const system = isZh
    ? "你是一位角色设计师。基于剧情上下文，为视觉阶段角色补充或优化 description 和 visualHint；若现有 description 为空或质量不足（过短/空泛/缺剧情锚点），请从专业视角重新生成，而非简单追加。"
    : "You are a character designer. Enrich or optimize the description and visualHint for the visual-phase characters from the story context; if the existing description is empty or low-quality (too short / vague / lacks story anchor), regenerate it from a professional perspective rather than simply appending.";

  let updatedCount = 0;
  const failures: string[] = [];

  // Serial per-character LLM calls (one per baseName)
  for (const [baseName, chars] of groups) {
    const tpl = templateChars.find(
      (t) => (t.baseName || t.name) === baseName
    );
    const templateDesc = tpl?.description || "";

    // Episodes this character actually appears in (name match against title/description/idea)
    const appearingEps = allEps.filter((ep) => epAppears(ep, baseName));
    const epContext = appearingEps
      .map((ep) => `EP.${ep.sequence}: ${ep.title || ""} - ${ep.description || ""}\n${ep.idea || ""}`)
      .join("\n\n");

    const phaseBlock = chars
      .map((pc) =>
        isZh
          ? `- ${pc.phaseName} | 现 description: ${pc.description || "（空）"} | 现 visualHint: ${pc.visualHint || "（空）"}`
          : `- ${pc.phaseName} | current description: ${pc.description || "(empty)"} | current visualHint: ${pc.visualHint || "(empty)"}`
      )
      .join("\n");

    const prompt = isZh
      ? `[角色] ${baseName}

[角色定义]
${templateDesc}
（其中含风格/材质/光位提示，需保留）

[视觉阶段]（共 ${chars.length} 个，每个阶段输出一条）
${phaseBlock}

[分集上下文]（该角色实际出场的集）
${epContext}

[输出要求]
1. 每个视觉阶段恰好输出一条，不遗漏、不新增。
2. description：2-3 句，必须引用该角色出场集的剧情；现有 description 为空或质量不足时，从专业角色设计师视角重新生成。
3. 保留角色定义中的风格/材质/光位提示（3D国漫渲染风格、细腻材质、体积光）。
4. visualHint：10-15 字，逗号分隔。
5. 只输出 JSON：
{
  "phaseEnrichments": [
    { "phaseName": "阶段名", "description": "...", "visualHint": "..." }
  ]
}`
      : `[Character] ${baseName}

[Character Definition]
${templateDesc}
(style / material / lighting cues included — must be preserved)

[Visual Phases] (${chars.length} total, output one entry per phase)
${phaseBlock}

[Episode Context] (episodes this character actually appears in)
${epContext}

[Output]
1. Output exactly one entry per visual phase — no omissions, no additions.
2. description: 2-3 sentences, must reference the story from this character's appearing episodes; if the existing description is empty or low-quality, regenerate from a professional character-designer perspective.
3. Preserve the style/material/lighting cues from the character definition (e.g. 3D guoman render style, fine materials, volumetric light).
4. visualHint: 10-15 chars, comma-separated.
5. Output JSON only:
{
  "phaseEnrichments": [
    { "phaseName": "phase", "description": "...", "visualHint": "..." }
  ]
}`;

    let enrichments: Enrichment[] | null = null;
    try {
      let result = await generateText({ model, system, prompt, providerOptions: jsonMode });
      enrichments = parseEnrichments(result.text);
      if (!enrichments) {
        const retry = await generateText({
          model,
          system,
          prompt: prompt + "\n\nIMPORTANT: Return COMPLETE, VALID JSON.",
          providerOptions: jsonMode,
        });
        enrichments = parseEnrichments(retry.text);
      }
      if (!enrichments) {
        failures.push(baseName);
        continue;
      }

      // Coverage check: every phaseName in this group must be present; targeted retry for missing ones
      const expected = new Set(
        chars.map((c) => (c.phaseName || "").toLowerCase().trim())
      );
      const returned = new Set(
        enrichments.map((e) => (e.phaseName || "").toLowerCase().trim())
      );
      const missing = [...expected].filter((p) => !returned.has(p));
      if (missing.length > 0) {
        const retryPrompt =
          prompt +
          `\n\nMissing phases (must include these): ${missing.join(", ")}.\nReturn complete valid JSON including all ${chars.length} phases.`;
        const retry2 = await generateText({ model, system, prompt: retryPrompt, providerOptions: jsonMode });
        const reparsed = parseEnrichments(retry2.text);
        if (reparsed) enrichments = reparsed;
      }

      // Match by phaseName only (unique within a character)
      for (const en of enrichments) {
        const phaseKey = (en.phaseName || "").toLowerCase().trim();
        const match = chars.find((c) => (c.phaseName || "").toLowerCase().trim() === phaseKey);
        if (!match) continue;
        await db
          .update(characters)
          .set({ description: en.description, visualHint: en.visualHint })
          .where(eq(characters.id, match.id));
        updatedCount++;
      }
    } catch (err) {
      failures.push(baseName);
      console.error(`[enrich-phases] ${baseName} error:`, err);
    }
  }

  return NextResponse.json({
    characters: groups.size,
    updated: updatedCount,
    failures,
  });
}
