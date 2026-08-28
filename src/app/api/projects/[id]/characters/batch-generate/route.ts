import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, characters } from "@/lib/db/schema";
import { eq, and, isNull, isNotNull } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { generateText } from "ai";
import { createLanguageModel, extractJSON } from "@/lib/ai/ai-sdk";
import { buildPhaseR2IPrompt } from "@/lib/ai/prompts/phase-image";
import { resolvePrompt, resolveSlotContents } from "@/lib/ai/prompts/resolver";
import type { ProviderConfig } from "@/lib/ai/ai-sdk";

export const maxDuration = 600;

type BatchType = "t2i_prompt" | "r2i_prompt" | "t2i_image" | "r2i_image";

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
    type: BatchType;
    modelConfig: { text: ProviderConfig | null; image?: ProviderConfig | null };
    language?: "zh" | "en";
  };

  if (!body.type) {
    return NextResponse.json({ error: "Missing type" }, { status: 400 });
  }

  const isTemplate = body.type.startsWith("t2i");
  const targetChars = await db
    .select()
    .from(characters)
    .where(and(
      eq(characters.projectId, projectId),
      isNull(characters.episodeId),
      isTemplate ? isNull(characters.phaseName) : isNotNull(characters.phaseName),
    ));

  const results: Array<{ id: string; name: string; status: string; error?: string }> = [];

  // 步骤2：基于 EP 链的 T2I structure 方式，为 template 角色卡生成 t2i_structure
  // 输入 = 角色 description + visualHint（不含 EP 剧本内容）
  const language = body.language ?? "en";
  console.log("[batch-generate] body.language =", body.language, "resolved language =", language);
  const t2iSystem = await resolvePrompt("t2i_prompt", { userId, projectId, language });

  // ── 项目时代美学 & 视觉风格（无条件注入，LLM 必须有锚定源） ──
  const styleCtx = `\nPROJECT STYLE ANCHORS (authoritative — all output must conform):\n`
    + `视觉风格: ${project.visualStyle || "未指定"}\n`
    + `时代美学: ${project.eraAesthetic || "未指定"}\n`
    + `角色服装、道具、建筑风格必须与上述时代/风格严格一致。\n`;

  if (body.type === "t2i_prompt" && body.modelConfig?.text) {
    const model = createLanguageModel(body.modelConfig.text);
    for (const item of targetChars) {
      try {
        // 单卡同款：只用名称 + visualHint，不用 description（含弧线迁移内容）
        const hint = item.visualHint ? ` [visualHint] ${item.visualHint}` : "";
        const prompt = styleCtx + `[Character] ${item.name}${hint}

IMPORTANT — TEMPLATE (baseline) card:
Output ONLY neutral baseline features: face shape, skin tone, eye/nose/lip shape, body type, height.
Use plain neutral clothing (white/gray). Do NOT include age progression, wardrobe evolution, or phase-specific details.
These belong to Phase cards.
MUST include "era" and "style" fields from the PROJECT STYLE ANCHORS above.`;
        const result = await generateText({ model, system: t2iSystem, prompt });
        // 保存 JSON — 对齐单卡：strip markdown code blocks
        const t2iJson = extractJSON(result.text);
        try {
          JSON.parse(t2iJson); // 校验是合法 JSON 才入库
          await db.update(characters).set({ t2iStructure: t2iJson }).where(eq(characters.id, item.id));
          results.push({ id: item.id, name: item.name, status: "ok" });
        } catch {
          console.warn(`[batch-generate] t2iStructure 不是合法 JSON（${item.name}），跳过入库`);
          results.push({ id: item.id, name: item.name, status: "error", error: "Invalid JSON" });
        }
      } catch (err) {
        results.push({ id: item.id, name: item.name, status: "error", error: String(err) });
      }
    }
  } else if (body.type === "r2i_prompt" && body.modelConfig?.text) {
    const r2iSystem = await resolvePrompt("r2i_prompt", { userId, projectId, language });
    const model = createLanguageModel(body.modelConfig.text);
    const templates = await db
      .select()
      .from(characters)
      .where(and(eq(characters.projectId, projectId), isNull(characters.episodeId), isNull(characters.phaseName)));
    const tmplByBase = new Map<string, typeof templates[0]>();
    for (const t of templates) tmplByBase.set(t.baseName || t.name, t);

    for (const item of targetChars) {
      try {
        const template = item.baseName ? tmplByBase.get(item.baseName) : undefined;
        const rawVC = item.visualChanges ? JSON.parse(item.visualChanges) : {};
        const changesStr = Object.entries(rawVC).map(function(kv) { return "- " + kv[0] + ": " + kv[1]; }).join("\n");

        var llmPrompt = styleCtx;
        if (language === "zh") {
          llmPrompt += "模板基准 —— 仅参考，不准复制：\n\n";
          llmPrompt += "基准中已有的字段：age、face、body、hair、clothing、lighting\n";
          llmPrompt += "（值已省略——存在于参考图中，禁止复述）\n\n";
          llmPrompt += "阶段：" + (item.phaseName || "") + "\n";
          llmPrompt += "视觉变更：\n";
          llmPrompt += changesStr + "\n\n";
          llmPrompt += "Picture 1\n";
          llmPrompt += "[character design sheet] [front view] [full body] [standing pose]\n";
          llmPrompt += "[pose: neutral standing, arms at sides, feet shoulder-width apart, neutral expression]\n";
          llmPrompt += "[environment: pure white background, no shadow]\n";
          llmPrompt += "[quality: sharp focus, high detail, character reference sheet]\n";
          llmPrompt += "[lighting: 3D国漫渲染风格, 柔和体积光, 细腻材质]\n";
          llmPrompt += "\n";
          llmPrompt += `[era: ${project.eraAesthetic || "未指定"}]\n`;
          llmPrompt += `[style: ${project.visualStyle || "未指定"}]\n`;
          llmPrompt += "\n";
          llmPrompt += "age: [年龄，仅数字或年龄段]\n";
          llmPrompt += "clothing: [从头到脚的完整穿着，含鞋履]\n";
          llmPrompt += "hair: [发型，不含临时状态]\n";
          llmPrompt += "facial: [仅新增面部变化：伤疤/光头/皱纹/老年斑/眼袋]\n";
          llmPrompt += "accessories: [仅新增的小型随身物品]\n";
          llmPrompt += "expression: [仅阶段神情气质]\n";
          llmPrompt += "posture: [仅站姿体态——挺拔/微躬/放松，不含动作]\n";
          llmPrompt += "\n";
          llmPrompt += "All other features match the reference.\n"
          + "\n"
          + "参考示例（适用于其他角色）：\n"
          + "Picture 1\n"
          + "[character design sheet] [front view] [full body] [standing pose]\n"
          + "[pose: neutral standing, arms at sides, feet shoulder-width apart]\n"
          + "[environment: pure white background, no shadow]\n"
          + "age: 21-23岁\n"
          + "clothing: 深青色官袍，外披狐裘，腰束革带，脚穿玄色短靴\n"
          + "hair: 官帽由精致转为务实\n"
          + "All other features match the reference.\n";
        } else {
          llmPrompt += "TEMPLATE BASELINE - REFERENCE DATA ONLY (DO NOT COPY):\n\n";
          llmPrompt += "Fields present in baseline: age, face, body, hair, clothing, lighting.\n";
          llmPrompt += "(Values intentionally omitted - exist in reference image, must NOT be re-described.)\n\n";
          llmPrompt += "Phase: " + (item.phaseName || "") + "\n";
          llmPrompt += "Visual changes:\n";
          llmPrompt += changesStr + "\n\n";
          llmPrompt += "Output exactly one line per element. Skip any line that did not change:\n\n";
          llmPrompt += "Picture 1, [age change]\n";
          llmPrompt += `[era: ${project.eraAesthetic || "unspecified"}]\n`;
          llmPrompt += `[style: ${project.visualStyle || "unspecified"}]\n`;
          llmPrompt += "wearing [clothing if changed]\n";
          llmPrompt += "with [hair if changed]\n";
          llmPrompt += "[Facial new features only: scars/baldness/wrinkles - NO baseline re-description]\n";
          llmPrompt += "[Accessories] [Expression] [Posture] [Lighting]\n";
          llmPrompt += "All othe features match the reference.\n";
        }

        const result = await generateText({ model: model, system: r2iSystem, prompt: llmPrompt });
        const r2iText = result.text.trim();
        if (r2iText.length > 10) {
          await db.update(characters).set({ r2iStructure: r2iText }).where(eq(characters.id, item.id));
          results.push({ id: item.id, name: item.name, status: "ok" });
        } else {
          throw new Error("Empty LLM response");
        }
      } catch (err) {
        // Fallback: heuristics with Picture 1 prefix
        try {
          const rawVC = item.visualChanges ? JSON.parse(item.visualChanges) : {};
          const r2iPrompt = buildPhaseR2IPrompt({
            characterName: item.baseName || item.name,
            phaseName: item.phaseName || "",
            visualChanges: rawVC,
            templateDescription: item.description || "",
          });
          const r2iFallback = "Picture 1, " + r2iPrompt;
          await db.update(characters).set({ r2iStructure: r2iFallback }).where(eq(characters.id, item.id));
          results.push({ id: item.id, name: item.name, status: "ok" });
        } catch (err2) {
          results.push({ id: item.id, name: item.name, status: "error", error: String(err) });
        }
      }
    }  } else if (body.type === "t2i_image" || body.type === "r2i_image") {
    return NextResponse.json({
      error: "Image batch not implemented here - use /api/projects/{id}/generate with action",
    }, { status: 400 });
  } else {
    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  }

  return NextResponse.json({
    results,
    total: targetChars.length,
    ok: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "error").length,
  });
}
