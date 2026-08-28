import { NextResponse } from "next/server";
import { generateText } from "ai";
import { createLanguageModel, extractJSON } from "@/lib/ai/ai-sdk";
import type { ProviderConfig } from "@/lib/ai/ai-sdk";
import { db } from "@/lib/db";
import { projects, episodes } from "@/lib/db/schema";
import { eq, and, max } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { id as genId } from "@/lib/id";
import { buildScriptSplitPrompt } from "@/lib/ai/prompts/script-split";
import { resolvePrompt } from "@/lib/ai/prompts/resolver";

export const maxDuration = 300;

// ---------------------------------------------------------------------------
// File parsing helpers
// ---------------------------------------------------------------------------

async function parseTxt(buffer: Buffer): Promise<string> {
  return buffer.toString("utf-8");
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const { extractText } = await import("unpdf");
  const result = await extractText(new Uint8Array(buffer), { mergePages: true });
  return result.text;
}

async function extractText(buffer: Buffer, filename: string): Promise<string> {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "txt":
      return parseTxt(buffer);
    case "docx":
      return parseDocx(buffer);
    case "pdf":
      return parsePdf(buffer);
    default:
      throw new Error(`Unsupported file type: .${ext}`);
  }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 10000; // ~10000 chars per chunk

/** Split text at paragraph boundaries, each chunk ≤ CHUNK_SIZE chars */
function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > CHUNK_SIZE && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += (current ? "\n\n" : "") + para;
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

interface EpisodeResult {
  title: string;
  description: string;
  keywords: string;
  idea: string;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------
// The script_split prompt asks for structured text markers, not JSON:
//   === 分集 1 ===  (or === Episode 1 ===)
//   标题: ...        Title: ...
//   描述: ...        Description: ...
//   关键词: ...      Keywords: ...
//   角色: ...        Characters: ...
//   剧情构思:        Plot idea:
//   <multi-line body until next === separator>
// Parse that marker format into EpisodeResult[]. Falls back to JSON.parse
// when the model ignored the prompt and emitted JSON anyway (issue #2).
function parseEpisodeMarkers(text: string): EpisodeResult[] {
  const blockRe = /={2,}\s*(?:分集|Episode)\s*(\d+)\s*={2,}/g;
  const indices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    indices.push(m.index);
  }
  if (indices.length === 0) return [];
  indices.push(text.length);

  const labelRe = /^\s*(标题|Title)\s*[:：]\s*(.*)$/i;
  const descRe = /^\s*(描述|Description)\s*[:：]\s*(.*)$/i;
  const kwRe = /^\s*(关键词|Keywords)\s*[:：]\s*(.*[^\s].*)$/i;
  const charRe = /^\s*(角色|Characters)\s*[:：]\s*(.*)$/i;
  const ideaRe = /^\s*(剧情构思|Plot idea)\s*[:：]\s*$/i;

  const results: EpisodeResult[] = [];
  for (let i = 0; i < indices.length - 1; i++) {
    const block = text.slice(indices[i], indices[i + 1]);
    // Drop the leading separator line so it does not pollute the body.
    const body = block.split(/\n/).slice(1).join("\n");
    let title = "";
    let description = "";
    let keywords = "";
    let characters = "";
    const ideaLines: string[] = [];
    let inIdea = false;
    for (const line of body.split(/\n/)) {
      if (inIdea) {
        ideaLines.push(line);
        continue;
      }
      let lm: RegExpMatchArray | null;
      if ((lm = line.match(labelRe))) { title = lm[2].trim(); }
      else if ((lm = line.match(descRe))) { description = lm[2].trim(); }
      else if ((lm = line.match(kwRe))) { keywords = lm[2].trim(); }
      else if ((lm = line.match(charRe))) { characters = lm[2].trim(); }
      else if (ideaRe.test(line)) { inIdea = true; }
    }
    const idea = ideaLines.join("\n").trim();
    if (!title && !description && !idea) continue;
    const fullIdea = characters
      ? `角色: ${characters}\n${idea}`
      : idea;
    results.push({ title, description, keywords, idea: fullIdea });
  }
  return results;
}

function parseEpisodes(text: string): EpisodeResult[] {
  const markers = parseEpisodeMarkers(text);
  if (markers.length > 0) return markers;
  try {
    const parsed = JSON.parse(extractJSON(text)) as EpisodeResult[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error("[UploadScript] failed to parse response (no markers, JSON.parse failed). head:", text.slice(0, 200));
    return [];
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const userId = getUserIdFromRequest(request);

  // Verify project ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Parse form data
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const modelConfigRaw = formData.get("modelConfig") as string | null;

  if (!file) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  if (!modelConfigRaw) {
    return NextResponse.json(
      { error: "No model config provided" },
      { status: 400 }
    );
  }

  const modelConfig = JSON.parse(modelConfigRaw) as {
    text: ProviderConfig | null;
  };

  if (!modelConfig.text) {
    return NextResponse.json(
      { error: "No text model configured" },
      { status: 400 }
    );
  }

  // Extract text from file
  const buffer = Buffer.from(await file.arrayBuffer());
  let fullText: string;
  try {
    fullText = await extractText(buffer, file.name);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to parse file";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!fullText.trim()) {
    return NextResponse.json(
      { error: "File contains no text" },
      { status: 400 }
    );
  }

  // Chunk the text
  const chunks = chunkText(fullText);
  const model = createLanguageModel(modelConfig.text);
  const scriptSplitSystem = await resolvePrompt("script_split", { userId, projectId });

  // Process all chunks concurrently
  let episodeOffset = 0;
  const chunkPromises = chunks.map(async (chunk, idx) => {
    const prompt = buildScriptSplitPrompt(chunk, {
      chunkIndex: idx,
      totalChunks: chunks.length,
      episodeOffset, // approximate — exact offset tricky with concurrency
    });

    const result = await generateText({
      model,
      system: scriptSplitSystem,
      prompt,
      temperature: 0.5,
    });

    const parsed = parseEpisodes(result.text);
    return parsed;
  });

  // Wait for all chunks, flatten results in order
  const chunkResults = await Promise.all(chunkPromises);
  const allEpisodes = chunkResults.flat();

  if (allEpisodes.length === 0) {
    return NextResponse.json(
      { error: "AI could not split the script into episodes" },
      { status: 422 }
    );
  }

  // Get current max sequence
  const [seqResult] = await db
    .select({ maxSeq: max(episodes.sequence) })
    .from(episodes)
    .where(eq(episodes.projectId, projectId));

  let seq = (seqResult?.maxSeq ?? 0) + 1;

  // Create all episodes in DB
  const created = [];
  for (const ep of allEpisodes) {
    const [row] = await db
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
    created.push(row);
  }

  console.log(
    `[UploadScript] Created ${created.length} episodes from ${chunks.length} chunks`
  );

  return NextResponse.json(
    { episodes: created, count: created.length },
    { status: 201 }
  );
}
