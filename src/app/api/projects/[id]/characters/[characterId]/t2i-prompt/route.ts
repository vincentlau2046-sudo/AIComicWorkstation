import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { characters } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { generateText } from "ai";
import { createLanguageModel, extractJSON, type ProviderConfig } from "@/lib/ai/ai-sdk";
import { buildCharacterFrontViewPrompt } from "@/lib/ai/prompts/character-image";
import { resolvePrompt } from "@/lib/ai/prompts/resolver";

/**
 * 单角色 T2I 提示词（t2iStructure）生成。
 * 弥补批量生成时个别角色失效——单角色手动生成 7 字段 JSON。
 * 输入 = 角色 description + visualHint（不含 EP 剧本内容）。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; characterId: string }> }
) {
  const { id: projectId, characterId } = await params;
  const userId = getUserIdFromRequest(request);
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [character] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, characterId));

  if (!character) {
    return NextResponse.json({ error: "Character not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    modelConfig?: { text: ProviderConfig | null };
    language?: "zh" | "en";
  };

  if (!body.modelConfig?.text) {
    return NextResponse.json({ error: "No text model configured" }, { status: 400 });
  }

  // 对齐 EP 链：t2iStructure 槽位传已存结构（null 走散文回退），description 槽位传描述；再补 visualHint
  let prompt = buildCharacterFrontViewPrompt(
    character.t2iStructure ?? null,
    character.description || character.name
  );
  if (character.visualHint) {
    prompt = `${prompt}\n[visualHint] ${character.visualHint}`;
  }

  const language = body.language ?? "en";
  const t2iSystem = await resolvePrompt("t2i_prompt", { userId, projectId, language });

  const model = createLanguageModel(body.modelConfig.text);
  const result = await generateText({ model, system: t2iSystem, prompt });

  // 剥离 markdown 代码块后校验 JSON，再入库
  const t2iJson = extractJSON(result.text);
  try {
    JSON.parse(t2iJson);
    await db.update(characters).set({ t2iStructure: t2iJson }).where(eq(characters.id, characterId));
  } catch {
    console.warn(`[t2i-prompt] ${character.name}: 输出不是合法 JSON，跳过入库`);
    return NextResponse.json({ prompt: t2iJson, saved: false });
  }

  return NextResponse.json({ prompt: t2iJson });
}
