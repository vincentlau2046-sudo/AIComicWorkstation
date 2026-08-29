import { db } from "@/lib/db";
import { importLogs } from "@/lib/db/schema";
import { id as genId } from "@/lib/id";

export async function addImportLog(
  projectId: string,
  step: number,
  status: "running" | "done" | "error",
  message: string,
  metadata?: unknown
) {
  await db.insert(importLogs).values({
    id: genId(),
    projectId,
    step,
    status,
    message,
    metadata: metadata ?? {},
  });
}

export const CHUNK_SIZE = 6000;

/**
 * Split text at semantic boundaries, each chunk ≤ CHUNK_SIZE chars.
 * Cascades through boundary types in priority order:
 *   L1: double-newline paragraphs (standard prose)
 *   L2: episode/chapter markers (EP001, 第1集, Chapter X, ###)
 *   L3: single newline line breaks (scripts, poetry, PDF-extracted)
 *   L4: character-level forced split (no boundaries found)
 */
export function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];

  // L1: double newlines (paragraphs)
  const paraChunks = buildChunks(text.split(/\n{2,}/));
  if (paraChunks.length > 1) return paraChunks;

  // L2: episode/chapter markers — preserve markers in output
  const markerRegex = /(EP\d+|第[一二三四五六七八九十百千\d]+集|[Cc]hapter\s+\d+|Episode\s+\d+|^#{1,3}\s+)/gm;
  const isMarker = (s: string) => /^(EP\d+|第[一二三四五六七八九十百千\d]+集|[Cc]hapter\s+\d+|Episode\s+\d+|#{1,3}\s+)/.test(s);
  const markerSegments = text.split(markerRegex);
  if (markerSegments.filter(s => s.trim()).length > 1) {
    // Merge adjacent segments (marker + content) and build chunks
    const merged: string[] = [];
    for (let i = 0; i < markerSegments.length; i++) {
      const s = markerSegments[i];
      if (!s) continue;
      // If this segment is a marker and next segment exists, merge them
      if (isMarker(s) && i + 1 < markerSegments.length) {
        merged.push(s + (markerSegments[i + 1] || ''));
        i++; // skip next — already merged
      } else if (!isMarker(s)) {
        merged.push(s);
      }
    }
    const markerChunks = buildChunks(merged);
    if (markerChunks.length > 1) return markerChunks;
  }

  // L3: single newlines (line breaks)
  const lineChunks = buildChunks(text.split(/\n/));
  if (lineChunks.length > 1) return lineChunks;

  // L4: force-split by character count
  const forced: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    forced.push(text.slice(i, i + CHUNK_SIZE));
  }
  return forced;
}

/** Accumulate segments into chunks ≤ CHUNK_SIZE, discarding empty ones */
function buildChunks(segments: string[]): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;
    if (current && current.length + s.length + 1 > CHUNK_SIZE) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + s;
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function extractTextFromFile(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "txt":
      return buffer.toString("utf-8");
    case "docx": {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case "pdf": {
      const { extractText } = await import("unpdf");
      const result = await extractText(new Uint8Array(buffer), {
        mergePages: true,
      });
      return result.text;
    }
    case "md":
    case "markdown":
      return buffer.toString("utf-8");
    default:
      throw new Error(`Unsupported file type: .${ext}`);
  }
}
