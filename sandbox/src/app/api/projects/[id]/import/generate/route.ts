import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, episodes, characters, episodeCharacters, characterRelations } from "@/lib/db/schema";
import { eq, and, isNull, max } from "drizzle-orm";
import { id as genId } from "@/lib/id";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { addImportLog } from "@/lib/import-utils";

export const maxDuration = 1200;

interface EpisodeData {
  title: string;
  description: string;
  keywords: string;
  idea: string;
  characters?: string[];
}

interface CharacterData {
  name: string;
  scope: "main" | "guest";
  description: string;
  visualHint?: string;
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
    episodes: EpisodeData[];
    characters: CharacterData[];
    relationships?: Array<{
      characterA: string;
      characterB: string;
      relationType: string;
      description?: string;
    }>;
    projectAssess?: {
      visualStyle?: string;
      eraAesthetic?: string;
      moodDirection?: string;
    };
    characterArcs?: Array<{
      characterName: string;
      phases: Array<{
        phaseName: string;
        description?: string;
        episodeStart?: number;
        episodeEnd?: number;
        episodeRange?: string;
        triggerEvent: string;
        visualChanges: Record<string, string>;
        statusChange: string;
      }>;
    }>;
    regenerate?: boolean;
  };

  await addImportLog(
    projectId, 6, "running",
    body.regenerate ? "重新导入：追加数据（不清理旧数据）..." : "正在创建数据..."
  );

  try {
    // B.6: 重新导入采用"只追加、不清理"策略。
    // 旧的 episodes / 非 template 角色 / 集-角色链接 全部保留，
    // 多出来的重复数据由用户在"角色管理"界面手动删减。

    // 1. Create all characters (main + guest), build name→id map
    const charIdByName = new Map<string, string>();
    for (const char of body.characters) {
      const charId = genId();
      await db.insert(characters).values({
        id: charId,
        projectId,
        baseName: char.name,
        name: char.name,
        description: char.description,
        visualHint: char.visualHint ?? "",
        scope: char.scope,
        episodeId: null,
      });
      charIdByName.set(char.name.toLowerCase().trim(), charId);
    }

    // 1b. Create character relationships
    if (body.relationships?.length) {
      for (const rel of body.relationships) {
        const aId = charIdByName.get(rel.characterA.toLowerCase().trim());
        const bId = charIdByName.get(rel.characterB.toLowerCase().trim());
        if (aId && bId && aId !== bId) {
          try {
            await db.insert(characterRelations).values({
              id: genId(),
              projectId,
              characterAId: aId,
              characterBId: bId,
              relationType: rel.relationType || "neutral",
              description: rel.description || "",
            });
          } catch {
            // skip duplicates
          }
        }
      }
    }

    // 2. Create episodes
    const [seqResult] = await db
      .select({ maxSeq: max(episodes.sequence) })
      .from(episodes)
      .where(eq(episodes.projectId, projectId));

    let seq = (seqResult?.maxSeq ?? 0) + 1;

    const created = [];
    for (const ep of body.episodes) {
      const rows = await db
        .insert(episodes)
        .values({
          id: genId(),
          projectId,
          title: ep.title,
          description: ep.description || "",
          keywords: ep.keywords || "",
          idea: ep.idea || "",
          sequence: seq++,
        })
        .returning();
      created.push(rows[0]);
    }

    // 3. Create episode_characters relations
    let relationCount = 0;
    for (let i = 0; i < body.episodes.length; i++) {
      const epData = body.episodes[i];
      const episodeId = created[i]?.id;
      if (!episodeId || !epData.characters) continue;

      for (const charName of epData.characters) {
        const charId = charIdByName.get(charName.toLowerCase().trim());
        if (!charId) continue;
        await db.insert(episodeCharacters).values({
          id: genId(),
          episodeId,
          characterId: charId,
        });
        relationCount++;
      }
    }

    // 4. Write project assess style fields to projects table
    if (body.projectAssess) {
      await db
        .update(projects)
        .set({
          visualStyle: body.projectAssess.visualStyle ?? "",
          visualStyleKey: (body.projectAssess as any)?.visualStyleKey ?? "",
          eraAesthetic: body.projectAssess.eraAesthetic ?? "",
          moodDirection: body.projectAssess.moodDirection ?? "",
        })
        .where(eq(projects.id, projectId));

      if (body.projectAssess.visualStyle || body.projectAssess.eraAesthetic || body.projectAssess.moodDirection) {
        await db
          .update(episodes)
          .set({
            visualStyle: body.projectAssess.visualStyle ?? "",
            eraAesthetic: body.projectAssess.eraAesthetic ?? "",
            moodDirection: body.projectAssess.moodDirection ?? "",
          })
          .where(eq(episodes.projectId, projectId));
      }
    }

    // 5. Write phase cards as characters rows
    if (body.characterArcs?.length) {
      let phaseCount = 0;
      for (const arc of body.characterArcs) {
        const charId = charIdByName.get(arc.characterName.toLowerCase().trim());
        if (!charId) continue;

        // ②: Template 行若已有 front_view_image，Phase 行创建时自动继承为参考图
        // （消除导入后到 D.2 执行前的"无图空窗"）
        const [templateRow] = await db
          .select({ frontViewImage: characters.frontViewImage })
          .from(characters)
          .where(
            and(
              eq(characters.projectId, projectId),
              eq(characters.baseName, arc.characterName),
              isNull(characters.episodeId),
              isNull(characters.phaseName)
            )
          );
        for (let i = 0; i < arc.phases.length; i++) {
          const p = arc.phases[i];
          const templateScope = body.characters.find(
            (c) => c.name.toLowerCase().trim() === arc.characterName.toLowerCase().trim()
          )?.scope || "main";
          await db.insert(characters).values({
            id: genId(),
            projectId,
            baseName: arc.characterName,
            name: `${arc.characterName}（${p.phaseName}）`,
            description: p.description || "",
            visualHint: (p as any).visualHint || "",
            referenceImage: templateRow?.frontViewImage || null,
            phaseName: p.phaseName,
            episodeStart: p.episodeStart || p.episodeEnd || 0,
            episodeEnd: p.episodeEnd || p.episodeStart || 0,
            episodeSequences: p.episodeRange
              ? p.episodeRange
              : (p.episodeStart != null && p.episodeEnd != null && p.episodeStart <= p.episodeEnd)
                ? Array.from({ length: (p.episodeEnd)! - (p.episodeStart)! + 1 }, (_, i) => (p.episodeStart!) + i).join(",")
                : "",
            visualChanges: typeof p.visualChanges === "string" ? p.visualChanges : (p.visualChanges ? JSON.stringify(p.visualChanges) : null),
            scope: templateScope,
            episodeId: null,
          });
          phaseCount++;
        }
      }
    }

    await addImportLog(
      projectId, 6, "done",
      `导入完成！创建了 ${body.characters.length} 个角色和 ${created.length} 集（${relationCount} 个角色分配）`,
      { episodeCount: created.length, characterCount: body.characters.length }
    );

    return NextResponse.json({
      episodes: created,
      characterCount: body.characters.length,
    }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await addImportLog(projectId, 6, "error", `导入失败: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}