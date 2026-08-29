import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { characters } from "@/lib/db/schema";
import { eq, and, isNull, isNotNull } from "drizzle-orm";
import { enqueueTask } from "@/lib/task-queue";
import { getUserIdFromRequest } from "@/lib/get-user-id";

/**
 * 批量角色参考图生成 — 入队模式。
 * 遍历 project 下所有缺少 referenceImage 的角色，逐个 enqueue character_image 任务。
 * 任务由 task worker 串行处理，不阻塞 API 响应，无超时风险。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const userId = getUserIdFromRequest(request);

  const body = (await request.json().catch(() => ({}))) as {
    modelConfig?: unknown;
    phaseOnly?: boolean;
  };

  // 查询缺少参考图的角色
  const baseFilters = [
    eq(characters.projectId, projectId),
    isNull(characters.episodeId),
    isNull(characters.referenceImage),
  ];

  if (body.phaseOnly) {
    baseFilters.push(isNotNull(characters.phaseName));
  } else {
    baseFilters.push(isNull(characters.phaseName));
  }

  const targetChars = await db
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(and(...baseFilters));

  if (targetChars.length === 0) {
    return NextResponse.json({ enqueued: 0, message: "所有角色已有参考图" });
  }

  let enqueued = 0;
  for (const ch of targetChars) {
    try {
      await enqueueTask({
        type: "character_image",
        projectId,
        payload: { characterId: ch.id, modelConfig: body.modelConfig },
      });
      enqueued++;
    } catch (err) {
      console.error(`[batch-image] Failed to enqueue ${ch.name}:`, err);
    }
  }

  return NextResponse.json({ enqueued, total: targetChars.length });
}