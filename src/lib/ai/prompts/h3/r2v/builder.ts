// ═══════════════════════════════════════════════
// H3 R2V Builder — Vision LLM + text-LLM fallback (v0.3.10)
// VL call → throw on failure → caller tries text-LLM → failTask on both.
// ═══════════════════════════════════════════════

import type { AIProvider } from "@/lib/ai/types";
import type { H3PromptInput, H3PromptOutput } from "../types";
import { buildR2VPromptTemplate, buildR2VTextFallbackPrompt } from "./prompt-template";
import { resolveLanguage } from "../shared/base-builder";

/**
 * R2V Vision LLM builder.
 *
 * Sends scene reference images + context to the VL model.
 * On failure → throws (caller handles text-LLM fallback).
 *
 * @param input — full H3PromptInput (characters, scenes, motion, etc.)
 * @param visionProvider — AI provider with vision support
 * @param sceneFramePaths — file paths for scene frame images (0-4 per shot)
 * @param systemOverride — optional Registry slot override for system prompt
 */
export async function buildR2VPromptLLM(
  input: H3PromptInput,
  visionProvider: AIProvider,
  sceneFramePaths: string[],
  systemOverride?: string,
): Promise<{ output: H3PromptOutput; source: "vl" }> {
  const lang = resolveLanguage(input);

  const { system, user } = await buildR2VPromptTemplate(input, systemOverride);

  const raw = await visionProvider.generateText(user, {
    systemPrompt: system,
    images: sceneFramePaths,
    temperature: 0.7,
  });

  if (!raw?.trim()) throw new Error("[H3-R2V] Empty VL response");

  return {
    output: {
      mode: "ref2va" as const,
      taskType: "reference_generation" as const,
      languageUsed: lang === "zh" ? "zh" : "en",
      sections: [raw.trim()],
    },
    source: "vl",
  };
}

/**
 * LLM text fallback builder.
 *
 * Uses Qwen [tag] scene frame descriptions as image proxy.
 * No actual images are sent — the LLM understands the scene purely from the
 * structured T2I prompt text that describes each reference image.
 */
export async function buildR2VPromptTextLLM(
  input: H3PromptInput,
  textProvider: AIProvider,
  systemOverride?: string,
): Promise<H3PromptOutput> {
  const lang = resolveLanguage(input);

  const { system, user } = await buildR2VTextFallbackPrompt(input, systemOverride);

  const raw = await textProvider.generateText(user, {
    systemPrompt: system,
    temperature: 0.7,
  });

  if (!raw?.trim()) throw new Error("[H3-R2V-LLM] Empty LLM response");

  return {
    mode: "ref2va" as const,
    taskType: "reference_generation" as const,
    languageUsed: lang === "zh" ? "zh" : "en",
    sections: [raw.trim()],
  };
}