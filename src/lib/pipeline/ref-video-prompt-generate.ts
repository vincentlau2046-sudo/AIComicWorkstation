/**
 * Reference Video Prompt Generate Pipeline Handler (v3).
 *
 * Generates H3 R2V 6-section video prompt via Vision LLM.
 * Fallback: text-LLM with Qwen [tag] scene descriptions as image proxy.
 * Both fail → failTask (user-visible error).
 */

import { db } from "@/lib/db";
import { shots } from "@/lib/db/schema";
import { resolveAIProvider } from "@/lib/ai/provider-factory";
import type { ModelConfigPayload } from "@/lib/ai/provider-factory";
import { getActiveAssets } from "@/lib/shot-asset-utils";
import { getEpisodeCharacters, assertEpisodeCharactersHaveReferences } from "@/lib/db/episode-characters";
import { buildR2VPromptLLM, buildR2VPromptTextLLM } from "@/lib/ai/prompts/h3/r2v/builder";
import { resolvePrompt } from "@/lib/ai/prompts/resolver";
import { eq } from "drizzle-orm";
import type { Task } from "@/lib/task-queue";
import { failTask } from "@/lib/task-queue";

export async function handleRefVideoPromptGenerate(task: Task) {
  const payload = task.payload as {
    shotId: string;
    projectId: string;
    userId?: string;
    modelConfig?: ModelConfigPayload;
  };

  const userId = payload.userId ?? "";
  const projectId = payload.projectId;

  // 1. Load shot
  const [shot] = await db.select().from(shots).where(eq(shots.id, payload.shotId));
  if (!shot) { await failTask(task.id, "Shot not found"); return; }

  // 2. Collect scene frames (for images + firstFrame/lastFrame context)
  const allRefs = await getActiveAssets(shot.id, "reference");
  const pendingRefs = allRefs.filter(r => r.status === "pending");
  if (pendingRefs.length > 0) {
    await failTask(task.id, `${pendingRefs.length} scene frames pending`);
    return;
  }
  const sceneFrames = allRefs.filter(r => r.fileUrl).sort((a, b) => a.sequenceInType - b.sequenceInType);
  const sceneFramePaths = sceneFrames.map(r => r.fileUrl as string);
  if (sceneFramePaths.length === 0) {
    await failTask(task.id, "No scene reference images");
    return;
  }

  // 3. Load full context via buildH3Input (same as FL2V path)
  const projectCharacters = await getEpisodeCharacters(projectId, shot.episodeId);
  // ⑧ guard: Phase/Guest 行缺参考图 → 直接报错（failTask），倒逼先完成 D.2
  try {
    await assertEpisodeCharactersHaveReferences(projectId, shot.episodeId);
  } catch (err) {
    await failTask(task.id, err instanceof Error ? err.message : "Character reference images missing");
    return;
  }
  const shotCharacters = projectCharacters.filter(c => c.referenceImage);

  const { buildH3Input } = await import("@/lib/ai/prompts/h3");
  const h3Input = await buildH3Input({
    userId,
    projectId,
    shot,
    shotCharacters,
    sceneFrames: sceneFrames.map(sf => ({ prompt: sf.prompt || null })),
    extraFields: {
      bgmUrl: undefined,  // buildH3Input loads this from episode/project
      costumes: projectCharacters
        .filter(c => c.referenceImage)
        .map(c => ({ name: c.name, description: c.description, referenceImage: c.referenceImage, characterId: c.id })),
    },
  });

  // 4. Resolve H3 system prompt from Registry (like FL2V)
  const h3System = await resolvePrompt("ref_video_prompt_h3", { userId, projectId })
    .catch(() => undefined);

  // 5. Generate: VL first → LLM text fallback → fail
  const aiProvider = resolveAIProvider(payload.modelConfig);

  let promptText: string;
  let source: "vl" | "text_fallback";

  try {
    const result = await buildR2VPromptLLM(h3Input, aiProvider, sceneFramePaths, h3System);
    source = "vl";
    promptText = "[R2V-VL] " + result.output.sections.join("\n\n");
  } catch (vlErr) {
    // VL failed — try text-LLM fallback with Qwen [tag] scene descriptions
    console.warn(`[RefVideoPrompt] VL failed, trying text-LLM fallback: ${vlErr}`);
    try {
      const textResult = await buildR2VPromptTextLLM(h3Input, aiProvider, h3System);
      source = "text_fallback";
      promptText = "[R2V-LLM] " + textResult.sections.join("\n\n");
    } catch (llmErr) {
      const msg = `R2V failed — VL: ${vlErr instanceof Error ? vlErr.message : String(vlErr)} | LLM fallback: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`;
      await failTask(task.id, msg);
      return;
    }
  }

  // 6. Store
  await db.update(shots).set({ videoPrompt: promptText }).where(eq(shots.id, shot.id));

  return { shotId: shot.id, source };
}