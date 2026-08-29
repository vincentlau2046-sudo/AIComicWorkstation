import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { characters } from "@/lib/db/schema";
import { eq, and, isNull, isNotNull } from "drizzle-orm";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";
import { getEpisodeCharacters } from "@/lib/db/episode-characters";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const view = searchParams.get("view");

  if (view === "episode") {
    const episodeId = searchParams.get("episodeId");
    if (episodeId) {
      const result = await getEpisodeCharacters(projectId, episodeId);
      return NextResponse.json(result);
    }
  }

  const result = await db
    .select()
    .from(characters)
    .where(
      view === "template"
        ? and(eq(characters.projectId, projectId), isNull(characters.episodeId), isNull(characters.phaseName))
        : view === "phase"
          ? and(eq(characters.projectId, projectId), isNull(characters.episodeId), isNotNull(characters.phaseName))
          : eq(characters.projectId, projectId)
    );
  return NextResponse.json(result);
}
