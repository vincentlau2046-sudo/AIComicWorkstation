/**
 * 视频发布说明生成（发布用 .md 文件）
 *
 * 输入 episode / project / characters 数据，调用 LLM 生成面向
 * 抖音 / B站 / 小红书等短视频平台的发布描述。
 *
 * 提供三个导出供不同路由使用：
 * - generatePublishMdPrompt -> 构建 Agent 可用的提示词（Agent 路由）
 * - saveMdContent           -> 将文本写入 .md 文件
 * - generatePublishMd       -> 完整的内置 LLM 流程（LLM 路由）
 */

import type { ModelConfigPayload } from "@/lib/ai/provider-factory";
import { resolveAIProvider } from "@/lib/ai/provider-factory";
import { db } from "@/lib/db";
import { episodes, projects, characters as charsTable } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { buildExportPath } from "./build-export-name";
import fs from "fs";
import path from "path";

export interface PublishMdInput {
  projectId: string;
  episodeId: string;
  modelConfig?: ModelConfigPayload;
}

export interface PublishMdResult {
  content: string;
  filePath: string;
}

interface ProjectEpisodeData {
  projectTitle: string;
  visualStyle: string;
  eraAesthetic: string;
  moodDirection: string;
  epTitle: string;
  epSequence: number;
  epDescription: string;
  epKeywords: string;
  screenplay: string;
  characters: Array<{ name: string; visualHint: string | null }>;
  estimatedSec: number;
}

/** 从 DB 捞取项目/集/角色原始数据 */
async function fetchProjectEpisodeData(input: {
  projectId: string;
  episodeId: string;
}): Promise<ProjectEpisodeData> {
  const { projectId, episodeId } = input;

  const [proj] = await db
    .select({
      title: projects.title,
      visualStyle: projects.visualStyle,
      eraAesthetic: projects.eraAesthetic,
      moodDirection: projects.moodDirection,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!proj) throw new Error("Project not found");

  const [ep] = await db
    .select({
      title: episodes.title,
      sequence: episodes.sequence,
      description: episodes.description,
      outline: episodes.outline,
      keywords: episodes.keywords,
      screenplay: episodes.screenplay,
    })
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  if (!ep) throw new Error("Episode not found");

  const allChars = await db
    .select({ name: charsTable.name, visualHint: charsTable.visualHint })
    .from(charsTable)
    .where(eq(charsTable.projectId, projectId))
    .orderBy(asc(charsTable.name));

  const { shots } = await import("@/lib/db/schema");
  const durRows = await db
    .select({ dur: shots.duration })
    .from(shots)
    .where(eq(shots.episodeId, episodeId));

  const estimatedSec = durRows.reduce((sum, r) => sum + (r.dur ?? 10), 0);

  return {
    projectTitle: proj.title,
    visualStyle: proj.visualStyle || "",
    eraAesthetic: proj.eraAesthetic || "",
    moodDirection: proj.moodDirection || "",
    epTitle: ep.title,
    epSequence: ep.sequence,
    epDescription: ep.description || "",
    epKeywords: ep.keywords || "",
    screenplay: ep.screenplay || "",
    characters: allChars,
    estimatedSec,
  };
}

/**
 * 构建 LLM / Agent 提示词（纯文本，不含 LLM 调用）
 * 返回格式：system prompt + 分隔线 + user prompt
 */
export async function generatePublishMdPrompt(input: {
  projectId: string;
  episodeId: string;
}): Promise<string> {
  const data = await fetchProjectEpisodeData(input);

  const systemPrompt = [
    "你是一位专业的短视频/中视频发布内容策划。请根据用户提供的剧集信息，",
    "生成一个 Markdown 格式的发布说明文件，包含 YAML front matter 和正文。",
    "目标是帮助内容创作者快速在抖音、B站、小红书等平台发布。",
    "",
    "要求：",
    "- 使用中文",
    "- 正文用 Markdown 格式，简洁有吸引力，适合短视频平台风格",
    "- 如果用户提供了剧本摘要，从中提取 2-3 个最有吸引力的爆点用于简介",
    "- YAML front matter 包含 title, description, keywords, characters, estimated_duration_sec",
    "- 正文包含：剧情简介、主要角色介绍、发布适配建议表",
    "- 发布适配表针对 抖音/快手（竖屏短剧 1-3min）、B站（横屏中视频 3-15min）、小红书（图文笔记）分别给出建议",
  ].join("\n");

  const promptParts: string[] = [
    "## 项目信息",
    `- 项目名称：${data.projectTitle}`,
    `- 集标题：${data.epTitle}`,
    `- 集序：${data.epSequence}`,
    `- 视觉风格：${data.visualStyle || "（未设定）"}`,
    `- 时代美学：${data.eraAesthetic || "（未设定）"}`,
    `- 情绪氛围：${data.moodDirection || "（未设定）"}`,
    `- 关键词：${data.epKeywords || "（未设定）"}`,
    `- 估算时长：${data.estimatedSec} 秒`,
    "",
    "## 剧情简介",
    data.epDescription || "（未设定）",
  ];

  if (data.screenplay) {
    promptParts.push("## 剧本摘要（前 10000 字）");
    promptParts.push(data.screenplay.slice(0, 10000));
    promptParts.push("");
  }

  if (data.characters.length > 0) {
    promptParts.push("## 主要角色");
    for (const c of data.characters) {
      promptParts.push(`- ${c.name}：${c.visualHint || ""}`);
    }
    promptParts.push("");
  }

  promptParts.push("请输出完整的 Markdown 内容，包含 YAML front matter 和正文。");

  return `${systemPrompt}\n\n---\n\n${promptParts.join("\n")}`;
}

/**
 * 保存内容到 .md 文件
 */
export async function saveMdContent(
  content: string,
  input: { projectId: string; episodeId: string }
): Promise<string> {
  const data = await fetchProjectEpisodeData(input);
  const mdPath = buildExportPath({
    projectTitle: data.projectTitle,
    epSequence: data.epSequence,
    epTitle: data.epTitle,
    ext: ".md",
  });
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, content, "utf-8");
  return mdPath;
}

/**
 * 完整的内置 LLM 流程：捞数据 -> 构建 prompt -> 调 LLM -> 存 .md -> 返回
 */
export async function generatePublishMd(
  input: PublishMdInput
): Promise<PublishMdResult> {
  const { projectId, episodeId, modelConfig } = input;

  // 构建 prompt，格式：system\n\n---\n\nuser
  const fullPrompt = await generatePublishMdPrompt({ projectId, episodeId });
  const sepIdx = fullPrompt.indexOf("\n\n---\n\n");
  const system = sepIdx >= 0 ? fullPrompt.slice(0, sepIdx) : fullPrompt;
  const user = sepIdx >= 0 ? fullPrompt.slice(sepIdx + 6) : "";

  // 调用 LLM
  const provider = resolveAIProvider(modelConfig);
  let raw: string;
  try {
    raw = await provider.generateText(user, { systemPrompt: system, temperature: 0.7 });
  } catch (err) {
    throw new Error(
      `LLM 调用失败: ${err instanceof Error ? err.message : "未知错误"}`,
    );
  }

  // 写入 .md
  const mdPath = await saveMdContent(raw, { projectId, episodeId });
  return { content: raw, filePath: mdPath };
}