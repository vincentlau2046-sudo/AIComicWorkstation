// ═══════════════════════════════════════════════
// H3 Prompt Input Builder — shared helper
// Used by both Pipeline and Route paths to keep
// dialogue/narration/scene/project context in sync.
// ═══════════════════════════════════════════════

import { db } from "@/lib/db";
import { characters, characterRelations, dialogues, episodes, projects, scenes, shotAssets } from "@/lib/db/schema";
import { getEpisodeCharacters } from "@/lib/db/episode-characters";
import { eq, and, asc, inArray, or, desc } from "drizzle-orm";
import { stripCharHint } from "@/lib/shot-asset-utils";
import type { H3PromptInput } from "./types";

interface ShotRow {
  id: string;
  episodeId: string | null;
  projectId: string;
  videoScript: string | null;
  motionScript: string | null;
  prompt: string | null;
  cameraDirection: string | null;
  duration: number | null;
  soundDesign: string | null;
  musicCue: string | null;
  compositionGuide: string | null;
  narrations: string | null;
  innerMonologues: string | null;
  sceneId: string | null;
}

/** Parse voice lines from JSON string */
function parseVoiceField(raw: string | null | undefined): Array<{ text: string; type: string; character?: string; timeHint?: string }> {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

function voiceLinesToH3(lines: Array<{ text: string; type: string; character?: string }>): string[] {
  return lines.map(v => {
    if (v.type === "narration") return `(Background voiceover) ${v.text}`;
    if (v.type === "inner_monologue") return `${v.character ? `(${v.character} inner voice) ` : ""}${v.text}`;
    return v.text;
  });
}

export interface BuildH3InputOptions {
  userId: string;
  projectId: string;
  shot: ShotRow;
  /** Optional: pre-loaded project characters (avoids duplicate DB query) */
  shotCharacters?: Array<{ id: string; name: string; baseName?: string | null; description?: string | null; visualHint?: string | null; referenceImage?: string | null; performanceStyle?: string | null; scope: "main" | "guest" | "support"; heightCm?: number | null; bodyType?: string | null }>;
  /** Optional: frame file URLs (pipeline has these, route may not) */
  firstFrame?: { fileUrl: string; prompt?: string | null };
  lastFrame?: { fileUrl: string; prompt?: string | null };
  sceneFrames?: { prompt: string | null }[];
  /** Optional: additional fields from pipeline */
  extraFields?: Partial<H3PromptInput>;
}

/**
 * Build H3PromptInput with all shared context fields.
 * Both Pipeline and Route paths should use this to stay in sync.
 */
export async function buildH3Input(opts: BuildH3InputOptions): Promise<H3PromptInput> {
  const { userId, projectId, shot, shotCharacters: maybeChars, firstFrame, lastFrame, sceneFrames, extraFields } = opts;

  // ── Characters ──
  const episodeId = shot.episodeId;
  let shotCharacters = maybeChars ?? await getEpisodeCharacters(projectId, episodeId);

  // ── Shot-level character filtering (match pipeline behavior) ──
  // Read characters[] from first_frame and last_frame shot_assets
  const frameAssets = await db.select({ characters: shotAssets.characters })
    .from(shotAssets)
    .where(and(eq(shotAssets.shotId, shot.id), eq(shotAssets.isActive, 1)))
    .limit(2);
  const frameCharNames = new Set<string>();
  for (const a of frameAssets) {
    if (!a.characters) continue;
    const names: string[] = typeof a.characters === 'string' ? JSON.parse(a.characters) : a.characters;
    for (const n of names) frameCharNames.add(stripCharHint(n));
  }
  if (frameCharNames.size > 0) {
    shotCharacters = shotCharacters.filter(c =>
      frameCharNames.has(c.name) || frameCharNames.has(c.baseName || stripCharHint(c.name))
    );
    if (shotCharacters.length === 0) {
      // Fallback: if frame character lists don't match any DB characters,
      // use all episode characters (e.g. before frames are generated)
      shotCharacters = maybeChars ?? await getEpisodeCharacters(projectId, episodeId);
    }
  }

  // ── Spatial hints (from character_relations) ──
  const spatialHints: string[] = [];
  if (shotCharacters.length >= 2) {
    const RELATION_GUIDANCE: Record<string, string> = {
      enemy: "A与B为敌对关系，应**相对而立**，目光对视，画面中轴线左右分布",
      rival: "A与B为竞争关系，应彼此面向形成张力轴",
      ally: "A与B为同盟，可**并肩同向**站位，错位前后排列",
      mentor: "A与B为师徒/上下级，应有**上下层级**站位（高位俯视/低位仰视）",
      lover: "A与B为伴侣/亲密关系，应彼此面向，可近距离对立",
      family: "A与B为亲缘关系，可**同侧**排列",
    };
    for (let i = 0; i < shotCharacters.length; i++) {
      for (let j = i + 1; j < shotCharacters.length; j++) {
        const a = shotCharacters[i];
        const b = shotCharacters[j];
        const [rel] = await db.select()
          .from(characterRelations)
          .where(and(
            eq(characterRelations.projectId, projectId),
            or(
              and(eq(characterRelations.characterAId, a.id), eq(characterRelations.characterBId, b.id)),
              and(eq(characterRelations.characterAId, b.id), eq(characterRelations.characterBId, a.id)),
            )
          ))
          .orderBy(desc(characterRelations.createdAt))
          .limit(1);
        if (rel && RELATION_GUIDANCE[rel.relationType]) {
          spatialHints.push(`${a.name} ↔ ${b.name}（${rel.relationType}）: ${RELATION_GUIDANCE[rel.relationType]}`);
        }
      }
    }
  }

  // ── Dialogues ──
  let dialoguesList: H3PromptInput["dialogues"] = undefined;
  const shotDialogues = await db.select().from(dialogues).where(eq(dialogues.shotId, shot.id)).orderBy(asc(dialogues.sequence));
  if (shotDialogues.length > 0) {
    const dialogueCharIds = [...new Set(shotDialogues.map(d => d.characterId))];
    const dialogueCharacters = dialogueCharIds.length > 0
      ? await db.select().from(characters).where(inArray(characters.id, dialogueCharIds))
      : [];
    const charMap = new Map(dialogueCharacters.map(c => [c.id, c]));
    dialoguesList = shotDialogues.map(d => ({
      characterName: d.characterId ? (charMap.get(d.characterId)?.name ?? "Unknown") : "Unknown",
      text: d.text,
      sequence: d.sequence,
      startRatio: d.startRatio ?? "0",
      endRatio: d.endRatio ?? "1",
      audioUrl: d.audioUrl,
      offscreen: false,
    })).sort((a, b) => a.sequence - b.sequence);
  }

  // ── Narrations & Inner Monologues ──
  const narrations = voiceLinesToH3(parseVoiceField(shot.narrations));
  const innerMonologues = voiceLinesToH3(parseVoiceField(shot.innerMonologues));

  // ── Scene context ──
  let sceneDescription: string | undefined;
  let sceneLighting: string | undefined;
  let sceneColorPalette: string | undefined;
  if (shot.sceneId) {
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, shot.sceneId));
    sceneDescription = scene?.description || undefined;
    sceneLighting = scene?.lighting || undefined;
    sceneColorPalette = scene?.colorPalette || undefined;
  }

  // ── Project & Episode context ──
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  let episodeTitle: string | undefined;
  let episodeKeywords: string | undefined;
  let episodeEraAesthetic: string | undefined;
  if (episodeId) {
    const [ep] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    episodeTitle = ep?.title || undefined;
    episodeKeywords = ep?.keywords || undefined;
    episodeEraAesthetic = ep?.eraAesthetic || undefined;
  }

  // ── Generation mode ──
  let genMode: "keyframe" | "reference" = "keyframe";
  if (episodeId) {
    const [ep] = await db.select({ gm: episodes.generationMode }).from(episodes).where(eq(episodes.id, episodeId));
    genMode = (ep?.gm as "keyframe" | "reference") || "keyframe";
  } else if (project) {
    genMode = (project.generationMode as "keyframe" | "reference") || "keyframe";
  }

  return {
    videoScript: shot.videoScript || shot.motionScript || shot.prompt || "",
    motionScript: shot.motionScript,
    duration: shot.duration ?? 10,
    cameraDirection: shot.cameraDirection || "static",
    generationMode: genMode,
    characters: shotCharacters.map(c => ({
      id: c.id, name: c.name, description: c.description,
      visualHint: c.visualHint, referenceImage: c.referenceImage,
      performanceStyle: c.performanceStyle, scope: c.scope,
      heightCm: c.heightCm, bodyType: c.bodyType,
    })),
    firstFrame,
    lastFrame,
    sceneFrames,
    dialogues: dialoguesList,
    narrations: narrations.length > 0 ? narrations : undefined,
    innerMonologues: innerMonologues.length > 0 ? innerMonologues : undefined,
    soundDesign: shot.soundDesign || undefined,
    musicCue: shot.musicCue || undefined,
    sceneDescription: sceneDescription || shot.prompt || undefined,
    sceneLighting,
    sceneColorPalette,
    compositionGuide: shot.compositionGuide || undefined,
    projectTitle: project?.title || undefined,
    projectOutline: project?.outline || undefined,
    projectWorldSetting: project?.worldSetting || undefined,
    episodeTitle,
    episodeKeywords,
    projectIdea: project?.idea || undefined,
    visualStyleKey: project?.visualStyleKey || undefined,
    eraAesthetic: project?.eraAesthetic || episodeEraAesthetic || undefined,
    activeModules: process.env.H3_FL2V_NARRATION !== "off" ? ["narration"] : [],
    spatialHints: spatialHints.length > 0 ? spatialHints : undefined,
    languageMode: (process.env.H3_LANGUAGE as "auto" | "en" | "zh" | undefined) || "auto",
    ...extraFields,
  };
}
