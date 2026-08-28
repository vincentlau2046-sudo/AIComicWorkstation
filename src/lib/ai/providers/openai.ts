import OpenAI from "openai";
import type { AIProvider, TextOptions, ImageOptions } from "../types";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { id as genId } from "@/lib/id";
import { getUploadDir } from "@/lib/env";

// ─── VL image compression: resize to max 2048px, JPEG@85% ───
// VL models downscale input to fixed dimensions anyway (e.g. 448×448),
// so 2560px originals waste bandwidth with zero quality gain.
// Target: keep each image well under 1MB base64 to stay within IFF 10MB limit.
async function compressImageForVL(filePath: string): Promise<{ buffer: Buffer; width: number; height: number } | null> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return null;

  const originalSize = fs.statSync(resolved).size;
  // For images already small enough, pass through as-is
  if (originalSize < 256 * 1024) {
    const ext = path.extname(resolved).toLowerCase();
    return {
      buffer: fs.readFileSync(resolved),
      width: 0, height: 0, // metadata not needed for pass-through
    };
  }

  const image = sharp(resolved);
  const meta = await image.metadata();
  const maxDim = Math.max(meta.width || 0, meta.height || 0);

  // If original is already small, don't resize
  if (maxDim <= 2048 && originalSize < 512 * 1024 && meta.format !== "png") {
    return { buffer: fs.readFileSync(resolved), width: meta.width || 0, height: meta.height || 0 };
  }

  // Resize to max 2048px longest side, convert to JPEG@85%
  const buffer = await image
    .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  const outMeta = await sharp(buffer).metadata();
  return { buffer, width: outMeta.width || 0, height: outMeta.height || 0 };
}

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private defaultModel: string;
  private uploadDir: string;

  constructor(params?: { apiKey?: string; baseURL?: string; model?: string; uploadDir?: string; }) {
    this.client = new OpenAI({
      apiKey: params?.apiKey || process.env.OPENAI_API_KEY,
      baseURL: params?.baseURL || process.env.OPENAI_BASE_URL,
      timeout: 600000,  // 10 min timeout for long video prompt generation
      maxRetries: 2,
    });
    this.defaultModel = params?.model || process.env.OPENAI_MODEL || "gpt-4o";
    this.uploadDir = params?.uploadDir || getUploadDir();
  }

  async generateText(prompt: string, options?: TextOptions): Promise<string> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    if (options?.images?.length) {
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
      for (const imgPath of options.images) {
        try {
          const compressed = await compressImageForVL(imgPath);
          if (compressed) {
            const data = compressed.buffer.toString("base64");
            content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } });
          }
        } catch { /* skip unreadable */ }
      }
      content.push({ type: "text", text: prompt });
      messages.push({ role: "user", content });
    } else {
      messages.push({ role: "user", content: prompt });
    }

    const response = await this.client.chat.completions.create({
      model: options?.model || this.defaultModel,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens,
    });
    const msg = response.choices[0]?.message;
    // deepseek models may return content=null with everything in reasoning_content
    const content = (msg as any)?.content as string | null;
    const reasoning = (msg as any)?.reasoning_content as string | null;
    if (content) return content;
    if (reasoning) return reasoning;
    return "";
  }

  async generateImage(prompt: string, options?: ImageOptions): Promise<string> {
    const model = options?.model || this.defaultModel;
    const isDallE = model.startsWith("dall-e");

    // Build extra params for non-DALL-E OpenAI-compatible providers (e.g. seedream, doubao).
    // These APIs typically accept `size` as "WxH" and/or `aspect_ratio` as "W:H".
    const compatParams: Record<string, unknown> = {};
    if (!isDallE) {
      if (options?.size) compatParams.size = options.size;
      if (options?.aspectRatio) compatParams.aspect_ratio = options.aspectRatio;
      if (!options?.size && !options?.aspectRatio) compatParams.aspect_ratio = "16:9";
    }

    const response = await ((this.client.images.generate as unknown) as (params: Record<string, unknown>) => Promise<OpenAI.ImagesResponse>)({
      model,
      prompt,
      ...(isDallE && {
        size: (["1024x1024", "1792x1024", "1024x1792"].includes(options?.size ?? "")
          ? options!.size
          : "1792x1024") as "1024x1024" | "1792x1024" | "1024x1792",
        quality: (options?.quality as "standard" | "hd") || "standard",
      }),
      ...compatParams,
      n: 1,
    });

    const imageUrl = response.data?.[0]?.url;
    if (!imageUrl) throw new Error("No image URL returned from OpenAI");

    const imageResponse = await fetch(imageUrl);
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    const filename = `${genId()}.png`;
    const dir = path.join(this.uploadDir, "frames");
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);

    return filepath;
  }
}
