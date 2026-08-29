import { db } from "@/lib/db";
import { characters, episodeCharacters } from "@/lib/db/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";

/**
 * Get characters relevant to a specific episode.
 *
 * Priority:
 *   1. Linked via episode_characters join table → Phase or Guest rows
 *   2. Direct lookup by episode_id (legacy Guest rows)
 *   3. Fallback to project-level template rows (episode_id = NULL, phase_name = NULL)
 *
 * Without episodeId, returns all project characters.
 */
export async function getEpisodeCharacters(
  projectId: string,
  epId?: string | null
) {
  if (epId) {
    // Priority 1: linked via episode_characters join table
    const links = await db
      .select({ characterId: episodeCharacters.characterId })
      .from(episodeCharacters)
      .where(eq(episodeCharacters.episodeId, epId));
    if (links.length > 0) {
      return db
        .select()
        .from(characters)
        .where(
          inArray(
            characters.id,
            links.map((r) => r.characterId)
          )
        );
    }
    // Priority 2: direct lookup by episode_id on characters table (legacy Guest rows)
    const directInstances = await db
      .select()
      .from(characters)
      .where(eq(characters.episodeId, epId));
    if (directInstances.length > 0) {
      return directInstances;
    }
    // Priority 3: fallback to project-level template rows
    return db
      .select()
      .from(characters)
      .where(
        and(
          eq(characters.projectId, projectId),
          isNull(characters.episodeId),
          isNull(characters.phaseName)
        )
      );
  }
  return db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId));
}

/**
 * ⑧ Read-time guard (v0.0.6): when an EP-scoped read returns rows without
 * `referenceImage`, throw immediately so the S stage surfaces a clear error
 * instead of silently dropping the character. The fix path is D.2 (generate
 * the Phase row's reference image) — no silent merge.
 */
export class CharacterReferenceMissingError extends Error {
  readonly missingNames: string[];

  constructor(missingNames: string[]) {
    super(
      `${missingNames.length} 个角色缺少参考图（reference_image 为空）：${missingNames.join("、")}。请先在角色面板完成 D.2 参考图生成（Phase 行生成参考图），再重跑本环节。`
    );
    this.name = "CharacterReferenceMissingError";
    this.missingNames = missingNames;
  }
}

export async function assertEpisodeCharactersHaveReferences(
  projectId: string,
  episodeId?: string | null
): Promise<void> {
  if (!episodeId) return; // 项目级读取不强制
  const rows = await getEpisodeCharacters(projectId, episodeId);
  const missing = rows.filter((c) => !c.referenceImage).map((c) => c.name);
  if (missing.length > 0) {
    throw new CharacterReferenceMissingError(missing);
  }
}