import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, characters, episodes } from "@/lib/db/schema";
import { eq, and, isNull, isNotNull, or } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { generateText } from "ai";
import { createLanguageModel } from "@/lib/ai/ai-sdk";
import { parseLLMJSON } from "@/lib/ai/json-repair";
import { resolvePrompt } from "@/lib/ai/prompts/resolver";
import type { ProviderConfig } from "@/lib/ai/ai-sdk";

export const maxDuration = 1200;

interface Enrichment {
  phaseName: string;
  description: string;
  visualHint: string;
  t2iStructure?: Record<string, string> | string | null;
  visualChanges?: Record<string, string>;
  heightCm?: number | null;
  bodyType?: string | null;
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

  const language = body.language ?? (isZh ? "zh" : "en");
  const system = await resolvePrompt("enrich_phases", { userId, projectId, language });

  let updatedCount = 0;
  const failures: string[] = [];

  // Serial per-character LLM calls (one per baseName)
  for (const [baseName, chars] of groups) {
    const tpl = templateChars.find(
      (t) => (t.baseName || t.name) === baseName
    );
    const templateDesc = tpl?.description || "";

    // Relevant episodes for this character = union of [episodeStart, episodeEnd]
    // across this character's phase rows (authoritative, not name-matching).
    const relevantSeqs = new Set<number>();
    for (const pc of chars) {
      const s = pc.episodeStart;
      const e = pc.episodeEnd;
      if (s != null && e != null && s > 0 && e >= s) {
        for (let n = s; n <= e; n++) relevantSeqs.add(n);
      }
    }
    const appearingEps = allEps.filter((ep) => relevantSeqs.has(ep.sequence));
    const epContext = appearingEps
      .map((ep) => `EP.${ep.sequence}: ${ep.title || ""} - ${ep.description || ""}\n${ep.idea || ""}`)
      .join("\n\n");

    const phaseBlock = chars
      .map((pc) =>
        isZh
          ? `- ${pc.phaseName} | 现 description: ${pc.description || "（空）"} | 现 visualHint: ${pc.visualHint || "（空）"} | 现 visualChanges: ${pc.visualChanges || "{}"}`
          : `- ${pc.phaseName} | current description: ${pc.description || "(empty)"} | current visualHint: ${pc.visualHint || "(empty)"} | current visualChanges: ${pc.visualChanges || "{}"}`
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
${epContext}`
      : `[Character] ${baseName}

[Character Definition]
${templateDesc}
(style / material / lighting cues included — must be preserved)

[Visual Phases] (${chars.length} total, output one entry per phase)
${phaseBlock}

[Episode Context] (episodes this character actually appears in)
${epContext}`;

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
        // t2iStructure: object -> JSON string (aligns with batch-generate storage)
        const t2iRaw = en.t2iStructure;
        const t2iStr = t2iRaw
          ? (typeof t2iRaw === "string" ? t2iRaw : JSON.stringify(t2iRaw))
          : null;
        await db
          .update(characters)
          .set({
            description: en.description,
            visualHint: en.visualHint,
            t2iStructure: t2iStr,
            visualChanges: en.visualChanges ? JSON.stringify(en.visualChanges) : null,
            heightCm: en.heightCm ?? null,
            bodyType: en.bodyType ?? null,
          })
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
