import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getUploadDir } from "@/lib/env";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".json": "application/json",
  ".md": "text/markdown",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;

  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: "No path specified" }, { status: 400 });
  }

  const relativePath = segments.join("/");
  const filePath = path.resolve(getUploadDir(), relativePath);

  // Prevent directory traversal — uploaded file must stay under UPLOAD_DIR
  if (!filePath.startsWith(getUploadDir())) {
    return NextResponse.json({ error: "Invalid path" }, { status: 403 });
  }

  try {
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 404 });
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const buffer = fs.readFileSync(filePath);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    console.error(`[UploadsRoute] Error serving ${filePath}:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}