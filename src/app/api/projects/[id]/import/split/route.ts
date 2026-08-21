import { NextResponse } from 'next/server'
import { generateText } from 'ai'
import { createLanguageModel } from '@/lib/ai/ai-sdk'
import type { ProviderConfig } from '@/lib/ai/ai-sdk'
import { RetryStrategy } from '@/lib/retry'
import { db } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getUserIdFromRequest } from '@/lib/get-user-id'
import { addImportLog, chunkText, CHUNK_SIZE } from '@/lib/import-utils'
import { resolvePrompt } from '@/lib/ai/prompts/resolver'

export const maxDuration = 300;

interface SplitEpisode {
  title: string;
  description: string;
  keywords: string;
  idea: string;
  characters?: string[];
}

interface CharacterSummary {
  name: string;
  scope: string;
}

// --- Deterministic text parser (prompt asks for structured text, not JSON) ---

const EPISODE_SEP = /^=== (?:分集|Episode|episode|EPISODE) \d+ ===\r?$/m;
const FIELD_TITLE = /^\u6807\u9898[\uFF1A:] (.+)/m;
const FIELD_DESC = /^\u63cf\u8ff0[\uFF1A:] (.+)/m;
const FIELD_KW = /^\u5173\u952e\u8bcd[\uFF1A:] (.+)/m;
const FIELD_CHARS = /^\u89d2\u8272[\uFF1A:] (.+)/m;
const FIELD_IDEA_LABEL = /^\u5267\u60c5\u6784\u601d[\uFF1A:]/m;

function parseSplitText(text: string): SplitEpisode[] {
  const episodes: SplitEpisode[] = [];

  // Normalize: replace CRLF with LF, full-width colon with half-width
  let normalized = text.replace(/\r\n/g, "\n").replace(/\uff1a/g, ":");

  // Split by episode markers
  const blocks = normalized.split(EPISODE_SEP);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Find the header portion: everything before 剧情构思: label
    // This prevents idea content from polluting field regex matches.
    const ideaMatch = trimmed.match(FIELD_IDEA_LABEL);
    const header = ideaMatch ? trimmed.slice(0, ideaMatch.index!).trim() : trimmed;
    const idea = ideaMatch
      ? trimmed.slice(ideaMatch.index! + ideaMatch[0].length).trim()
      : "";

    // Only extract single-line fields from the header (not from idea content)
    const title = header.match(FIELD_TITLE)?.[1]?.trim();
    if (!title) continue;  // Skip blocks that don't look like episode data

    const description = header.match(FIELD_DESC)?.[1]?.trim() ?? "";
    const keywords = header.match(FIELD_KW)?.[1]?.trim() ?? "";

    // characters is comma-separated on one line
    const charsLine = header.match(FIELD_CHARS)?.[1];
    const characters = charsLine
      ? charsLine.split(/[,，]\s*/).filter(Boolean)
      : undefined;

    episodes.push({ title, description, keywords, idea, characters });
  }

  if (episodes.length === 0) {
    console.error(`[ImportSplit] parseSplitText produced 0 episodes. Raw:\n${text.slice(0, 500)}...`);
  }

  return episodes;
}

// --- Handler ---

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
    text: string;
    allCharacters: CharacterSummary[];
    modelConfig: { text: ProviderConfig | null };
    styleContext?: { visualStyle?: string; eraAesthetic?: string; moodDirection?: string; worldSetting?: string };
  };

  if (!body.modelConfig?.text) {
    return NextResponse.json({ error: "No text model" }, { status: 400 });
  }

  // Detect language
  const lang = /[一-鿿]/.test(body.text.slice(0, 1000)) ? "zh" as const : "en" as const;

  const model = createLanguageModel(body.modelConfig.text)
  const scriptSplitSystem = await resolvePrompt('import_split', { userId, projectId, language: lang })
  const retryStrategy = new RetryStrategy({ maxRetries: 2, baseDelay: 1000, jitter: true })

  // Build character context
  const allNames = body.allCharacters.map((c) => c.name)
  const charContext =
    allNames.length > 0
      ? `\n\n所有已提取角色 (每集只列出实际出场的): ${allNames.join(', ')}`
      : ''

  // Build style context
  const sc = body.styleContext;
  const styleBlock = sc?.visualStyle || sc?.worldSetting
    ? `\n\n【项目定位】\n${sc.visualStyle ? `视觉风格: ${sc.visualStyle}\n` : ``}${sc.eraAesthetic ? `时代美学: ${sc.eraAesthetic}\n` : ``}${sc.moodDirection ? `情绪基调: ${sc.moodDirection}\n` : ``}${sc.worldSetting ? `世界观: ${sc.worldSetting}\n` : ``}分集时请保持与以上定位一致。`
    : '';

  const chunks = chunkText(body.text);
  await addImportLog(projectId, 4, 'running',
    `开始自动分集 | 全文 ${body.text.length} 字 → ${chunks.length} 块 (每块 ≤${CHUNK_SIZE} 字)`
  );

  let episodeOffset = 0;
  const chunkResults: SplitEpisode[][] = [];

  try {
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx];
      await addImportLog(projectId, 4, 'running',
        `[${idx + 1}/${chunks.length}] 处理中 (${chunk.length} 字)...`
      );

      const chunkInfo = chunks.length > 1
        ? `\n这是第 ${idx + 1}/${chunks.length} 块。当前已处理 ${episodeOffset} 集，本块分集编号从 ${episodeOffset + 1} 开始。`
        : '';

      const prompt = `将以下文本拆分为分集。每集应是自然叙事单元。${chunkInfo}${charContext}${styleBlock}

--- TEXT ---
${chunk}
--- END ---

请按 === 分集 N === 格式输出。每集必须包含 标题/描述/关键词/角色/剧情构思 五个字段。`;

      const result = await retryStrategy.execute(async () => {
        return generateText({
          model,
          system: scriptSplitSystem,
          prompt,
          maxOutputTokens: 32768,
        });
      });

      let episodes = parseSplitText(result.text);

      if (episodes.length === 0) {
        console.error(`[ImportSplit] Chunk ${idx + 1} parse produced 0 episodes. Raw:\n${result.text.slice(0, 500)}...`);
        await addImportLog(projectId, 4, 'running', `第 ${idx + 1} 块解析失败，正在重试...`);
        const retryResult = await retryStrategy.execute(async () => {
          return generateText({
            model,
            system: scriptSplitSystem,
            prompt: prompt + '\n\nIMPORTANT: Use EXACTLY the === 分集 N === format with field labels as specified.',
            maxOutputTokens: 32768,
          });
        });
        episodes = parseSplitText(retryResult.text);
      }

      chunkResults.push(episodes);
      episodeOffset += episodes.length;
      await addImportLog(projectId, 4, 'running',
        `[${idx + 1}/${chunks.length}] 完成 → ${episodes.length} 集 (累计 ${episodeOffset} 集)`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await addImportLog(projectId, 4, "error", `分集失败: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const allEpisodes = chunkResults.flat();

  const perChunk = chunkResults.map((eps, i) => `${i + 1}:${eps.length}集`).join(', ');
  await addImportLog(
    projectId, 4, "done",
    `分集完成 | ${chunks.length} 块 → ${allEpisodes.length} 集 | 分布: ${perChunk}`,
    { episodes: allEpisodes }
  );

  return NextResponse.json({ episodes: allEpisodes });
}