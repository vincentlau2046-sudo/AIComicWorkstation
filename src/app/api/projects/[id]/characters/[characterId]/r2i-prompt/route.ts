import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { characters } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";
import { buildPhaseR2IPrompt } from "@/lib/ai/prompts/phase-image";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; characterId: string }> }
) {
  const { id: projectId, characterId } = await params;
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [phaseChar] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.projectId, projectId)));

  if (!phaseChar) {
    return NextResponse.json({ error: "Character not found" }, { status: 404 });
  }

  // Find the template row (same baseName, no episodeId, no phaseName)
  const [template] = await db
    .select()
    .from(characters)
    .where(and(
      eq(characters.projectId, projectId),
      eq(characters.baseName, phaseChar.baseName),
      isNull(characters.episodeId),
      isNull(characters.phaseName),
    ));

  let visualChanges: Record<string, string> = {};
  try { visualChanges = JSON.parse(phaseChar.visualChanges || "{}"); } catch {}

  const prompt = buildPhaseR2IPrompt({
    characterName: phaseChar.baseName || phaseChar.name,
    phaseName: phaseChar.phaseName || "",
    visualChanges,
    templateDescription: template?.description || "",
  });

  // Store to DB
  await db.update(characters).set({ r2iStructure: prompt }).where(eq(characters.id, characterId));

  return NextResponse.json({ prompt });
}