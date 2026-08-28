import { db } from "@/lib/db";
import { characters } from "@/lib/db/schema";
import { resolveImageProvider } from "@/lib/ai/provider-factory";
import type { ModelConfigPayload } from "@/lib/ai/provider-factory";
import { eq, and, isNull } from "drizzle-orm";
import type { Task } from "@/lib/task-queue";
import { buildCharacterFrontViewPrompt } from "@/lib/ai/prompts/character-image";
import { buildPhaseR2IPrompt } from "@/lib/ai/prompts/phase-image";
import { copyToUploads } from "@/lib/shot-asset-utils";

export async function handleCharacterImage(task: Task) {
  const payload = task.payload as { characterId: string; modelConfig?: ModelConfigPayload };

  const [character] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, payload.characterId));

  if (!character) {
    throw new Error("Character not found");
  }

  const ai = resolveImageProvider(payload.modelConfig);

  // ═══ Phase 行 → R2I ═══
  if (character.phaseName) {
    const [template] = await db
      .select()
      .from(characters)
      .where(and(
        eq(characters.projectId, character.projectId),
        eq(characters.baseName, character.baseName),
        isNull(characters.episodeId),
        isNull(characters.phaseName),
      ));

    if (!template?.frontViewImage) {
      throw new Error("Template frontViewImage not ready yet");
    }

    let visualChanges: Record<string, string> = {};
    try { visualChanges = JSON.parse(character.visualChanges || "{}"); } catch {}

    const phasePrompt = character.r2iStructure || buildPhaseR2IPrompt({
      characterName: character.baseName,
      phaseName: character.phaseName,
      visualChanges,
      templateDescription: template.description || "",
      r2iPrompt: character.r2iStructure || undefined,
    });

    const rawImagePath = await ai.generateImage(phasePrompt, {
      size: "2560x1440",
      pipeline: "phase-image",
      pipelineParams: {
        reference_image: template.frontViewImage,
        phase_prompt: phasePrompt,
        phase_name: character.phaseName,
        seed: Math.floor(Math.random() * 1000000),
      },
    });

    const imagePath = copyToUploads(rawImagePath, "character_reference");
    await db.update(characters).set({ referenceImage: imagePath }).where(eq(characters.id, character.id));
    return { imagePath, mode: "phase" };
  }

  // ═══ Template / Guest 行 → T2I ═══
  const prompt = buildCharacterFrontViewPrompt(character.t2iStructure ?? null, character.description || character.name);

  const rawImagePath = await ai.generateImage(prompt, {
    size: "2560x1440",
    aspectRatio: "16:9",
    quality: "hd",
    pipeline: "character-image",
    pipelineParams: {
      character_name: character.name,
      character_desc: character.description || character.name,
      character_prompt: prompt,
      seed: Math.floor(Math.random() * 1000000),
    },
  });

  const imagePath = copyToUploads(rawImagePath, "character_reference");

  // Extract front view from pipeline intermediates
  const frontViewRaw = (ai as any).lastPipelineResult?.intermediates?.["gen_front.front_image"];
  const frontViewPath = frontViewRaw ? copyToUploads(frontViewRaw, "character_front") : undefined;

  // Append to history
  let history: string[] = [];
  try {
    history = JSON.parse(character.referenceImageHistory || "[]");
  } catch {}
  if (character.referenceImage && !history.includes(character.referenceImage)) {
    history.push(character.referenceImage);
  }
  if (!history.includes(imagePath)) {
    history.push(imagePath);
  }

  await db
    .update(characters)
    .set({
      referenceImage: imagePath,
      ...(frontViewPath ? { frontViewImage: frontViewPath } : {}),
      referenceImageHistory: JSON.stringify(history),
      ...(character.episodeId ? {} : {
        // Template 行 — cascade frontViewImage to Phase rows
        frontViewImage: frontViewPath ?? undefined,
      }),
    })
    .where(eq(characters.id, character.id));

  // Cascade frontViewImage to Phase rows
  if (!character.episodeId && frontViewPath) {
    await db
      .update(characters)
      .set({ frontViewImage: frontViewPath })
      .where(and(
        eq(characters.projectId, character.projectId),
        eq(characters.baseName, character.baseName),
        isNull(characters.episodeId),
        isNotNull(characters.phaseName),
      ));
  }

  return { imagePath, mode: "template" };
}