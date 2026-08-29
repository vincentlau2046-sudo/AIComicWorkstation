import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { characters } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; characterId: string }> }
) {
  const { id: projectId, characterId } = await params;
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Ensure character belongs to this project
  const [existing] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.projectId, projectId)));
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json()) as Partial<{
    name: string;
    description: string;
    visualHint: string;
    t2iStructure: string | null;
    r2iStructure: string | null;
    scope: string;
    episodeId: string | null;
    referenceImage: string;
    phaseName: string | null;
    episodeSequences: string;
  }>;

  const updateData: Record<string, unknown> = {};
  if (body.name !== undefined) updateData.name = body.name;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.visualHint !== undefined) updateData.visualHint = body.visualHint;
  if (body.t2iStructure !== undefined) (updateData as any).t2iStructure = body.t2iStructure;
  if (body.referenceImage !== undefined) updateData.referenceImage = body.referenceImage;
  if (body.episodeSequences !== undefined) updateData.episodeSequences = body.episodeSequences;
  if (body.r2iStructure !== undefined) updateData.r2iStructure = body.r2iStructure;

  // Promote to Phase: when phaseName has a non-empty value
  if (body.phaseName !== undefined && body.phaseName !== null && body.phaseName !== "") {
    updateData.phaseName = body.phaseName;
    // If previously Guest (had episodeId), clear it and set scope to supporting by default
    if (existing.episodeId) {
      updateData.episodeId = null;
      updateData.scope = body.scope || "guest";
    }
    // Carry episode sequences if provided
    if (body.episodeSequences !== undefined) {
      updateData.episodeSequences = body.episodeSequences;
    }
  } else if (body.phaseName === null || body.phaseName === "") {
    // Allow clearing phaseName (downgrade from Phase)
    updateData.phaseName = body.phaseName;
  }

  if (body.scope !== undefined && !updateData.scope) {
    updateData.scope = body.scope;
    if (body.scope === "main") {
      updateData.episodeId = null;
    }
  }
  if (body.episodeId !== undefined && !updateData.episodeId) {
    updateData.episodeId = body.episodeId;
  }

  const [updated] = await db
    .update(characters)
    .set(updateData)
    .where(eq(characters.id, characterId))
    .returning();

  return NextResponse.json(updated);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; characterId: string }> }
) {
  const { id: projectId, characterId } = await params;
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await db
    .delete(characters)
    .where(and(eq(characters.id, characterId), eq(characters.projectId, projectId)));
  return new NextResponse(null, { status: 204 });
}
