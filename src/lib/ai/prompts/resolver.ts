import { db } from "@/lib/db";
import { promptTemplates } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { getPromptDefinition, getDefaultSlotContents } from "./registry";

interface ResolveOptions {
  userId: string;
  projectId?: string;
  /** When "zh", swap slot defaults to Chinese for non-overridden slots */
  language?: "zh" | "en";
}

/**
 * Resolve a prompt's system content by merging:
 *   project-level overrides > global overrides > code defaults
 *
 * When language="zh", slot defaults are replaced with Chinese versions
 * for slots that haven't been overridden by the user.
 */
export async function resolvePrompt(
  promptKey: string,
  options: ResolveOptions
): Promise<string> {
  const def = getPromptDefinition(promptKey);
  if (!def) {
    throw new Error(`Unknown prompt key: ${promptKey}`);
  }

  const slotContents = getDefaultSlotContents(promptKey) ?? {};

  // Check for full-prompt override first (advanced mode, slotKey = null)
  const fullOverrides = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.userId, options.userId),
        eq(promptTemplates.promptKey, promptKey),
        isNull(promptTemplates.slotKey)
      )
    );

  // Find project-level full override, then global
  const projectFull = fullOverrides.find(
    (o) => o.scope === "project" && o.projectId === options.projectId
  );
  const globalFull = fullOverrides.find((o) => o.scope === "global");

  if (options.projectId && projectFull) {
    return projectFull.content;
  }
  if (globalFull) {
    return globalFull.content;
  }

  // No full override — resolve slot by slot
  const slotOverrides = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.userId, options.userId),
        eq(promptTemplates.promptKey, promptKey)
      )
    );

  // Track which slots were user-overridden
  const overriddenSlots = new Set<string>();

  for (const slotKey of Object.keys(slotContents)) {
    // Project-level slot override
    if (options.projectId) {
      const projectSlot = slotOverrides.find(
        (o) =>
          o.slotKey === slotKey &&
          o.scope === "project" &&
          o.projectId === options.projectId
      );
      if (projectSlot) {
        slotContents[slotKey] = projectSlot.content;
        overriddenSlots.add(slotKey);
        continue;
      }
    }
    // Global slot override
    const globalSlot = slotOverrides.find(
      (o) => o.slotKey === slotKey && o.scope === "global"
    );
    if (globalSlot) {
      slotContents[slotKey] = globalSlot.content;
      overriddenSlots.add(slotKey);
    }
  }

  // Swap language defaults: ZH/EN in either direction based on request
  if (options.language) {
    for (const slot of def.slots) {
      if (overriddenSlots.has(slot.key) || !slot.defaultContentZh) continue;
      const isZhContent = /[\u4e00-\u9fff]/.test(slot.defaultContentZh.slice(0, 20));
      const isZhDefault = /[\u4e00-\u9fff]/.test(slot.defaultContent.slice(0, 20));
      const swapNeeded = (isZhDefault && options.language === "en") || (!isZhDefault && options.language === "zh");
      if (swapNeeded) slotContents[slot.key] = slot.defaultContentZh;
    }
  }

  return def.buildFullPrompt(slotContents);
}

/**
 * Resolve slot contents without building the full prompt.
 * Used for prompts that need dynamic parameters (frame, video, etc.)
 */
export async function resolveSlotContents(
  promptKey: string,
  options: ResolveOptions
): Promise<Record<string, string>> {
  const def = getPromptDefinition(promptKey);
  if (!def) {
    throw new Error(`Unknown prompt key: ${promptKey}`);
  }

  const slotContents = getDefaultSlotContents(promptKey) ?? {};

  const overrides = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.userId, options.userId),
        eq(promptTemplates.promptKey, promptKey)
      )
    );

  const overriddenSlots = new Set<string>();

  for (const slotKey of Object.keys(slotContents)) {
    if (options.projectId) {
      const projectSlot = overrides.find(
        (o) =>
          o.slotKey === slotKey &&
          o.scope === "project" &&
          o.projectId === options.projectId
      );
      if (projectSlot) {
        slotContents[slotKey] = projectSlot.content;
        overriddenSlots.add(slotKey);
        continue;
      }
    }
    const globalSlot = overrides.find(
      (o) => o.slotKey === slotKey && o.scope === "global"
    );
    if (globalSlot) {
      slotContents[slotKey] = globalSlot.content;
      overriddenSlots.add(slotKey);
    }
  }

  // Swap language defaults: ZH/EN in either direction based on request
  if (options.language) {
    for (const slot of def.slots) {
      if (overriddenSlots.has(slot.key) || !slot.defaultContentZh) continue;
      const isZhContent = /[\u4e00-\u9fff]/.test(slot.defaultContentZh.slice(0, 20));
      const isZhDefault = /[\u4e00-\u9fff]/.test(slot.defaultContent.slice(0, 20));
      const swapNeeded = (isZhDefault && options.language === "en") || (!isZhDefault && options.language === "zh");
      if (swapNeeded) slotContents[slot.key] = slot.defaultContentZh;
    }
  }

  return slotContents;
}
