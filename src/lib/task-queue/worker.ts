import { dequeueTask, dequeueTasks, completeTask, failTask, failTaskWithRetry } from "./queue";
import type { TaskHandlerMap, Task } from "./types";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { eq, lt } from "drizzle-orm";

const POLL_INTERVAL_MS = 2000;
const REAPER_INTERVAL_MS = 60_000;
const COMFYUI_BASE_URL = process.env.COMFYUI_BASE_URL || 'http://localhost:8188';
const MAX_CONCURRENCY = parseInt(process.env.TASK_MAX_CONCURRENCY || "4", 10);

// ─── Idle timeout per task category (from dequeue, not enqueue) ───
const TASK_IDLE_TIMEOUT_MS: Record<string, number> = {
  video:    parseInt(process.env.TASK_TIMEOUT_VIDEO || "1800000", 10),
  image:    parseInt(process.env.TASK_TIMEOUT_IMAGE || "600000", 10),
  llm:      parseInt(process.env.TASK_TIMEOUT_LLM || "600000", 10),
  default:  parseInt(process.env.TASK_TIMEOUT_DEFAULT || "900000", 10),
};

function getIdleTimeout(taskType: string): number {
  if (["video_generate", "reference_video_generate", "video_assemble"].includes(taskType)) return TASK_IDLE_TIMEOUT_MS.video;
  if (["frame_generate", "scene_frame_generate", "character_image"].includes(taskType)) return TASK_IDLE_TIMEOUT_MS.image;
  if (["ref_video_prompt_generate", "script_outline", "script_parse", "character_extract", "shot_split"].includes(taskType)) return TASK_IDLE_TIMEOUT_MS.llm;
  return TASK_IDLE_TIMEOUT_MS.default;
}

// ─── Process timeout (circuit breaker — very generous) ───
const TASK_PROCESS_TIMEOUT_MS: Record<string, number> = {
  video:    parseInt(process.env.TASK_PROCESS_TIMEOUT_VIDEO || "3600000", 10),  // 1h
  image:    parseInt(process.env.TASK_PROCESS_TIMEOUT_IMAGE || "1800000", 10),  // 30min
  llm:      parseInt(process.env.TASK_PROCESS_TIMEOUT_LLM || "900000", 10),     // 15min
  default:  parseInt(process.env.TASK_PROCESS_TIMEOUT_DEFAULT || "1800000", 10),// 30min
};

function getProcessTimeout(taskType: string): number {
  if (["video_generate", "reference_video_generate", "video_assemble"].includes(taskType)) return TASK_PROCESS_TIMEOUT_MS.video;
  if (["frame_generate", "scene_frame_generate", "character_image"].includes(taskType)) return TASK_PROCESS_TIMEOUT_MS.image;
  if (["ref_video_prompt_generate", "script_outline", "script_parse", "character_extract", "shot_split"].includes(taskType)) return TASK_PROCESS_TIMEOUT_MS.llm;
  return TASK_PROCESS_TIMEOUT_MS.default;
}

let isRunning = false;
let handlers: TaskHandlerMap = {};

// ─── Slot tracking ───
let activeCount = 0;
let comfyActive = false;

// ─── ComfyUI health cache ───
let comfyHealthy = true;
let comfyLastCheck = 0;

async function checkComfyHealth(): Promise<boolean> {
  const now = Date.now();
  const ttl = comfyHealthy ? 30_000 : 10_000;
  if (now - comfyLastCheck < ttl) return comfyHealthy;
  try {
    const res = await fetch(`${COMFYUI_BASE_URL}/system_stats`, { signal: AbortSignal.timeout(3000) });
    comfyHealthy = res.ok;
  } catch (err) {
    comfyHealthy = false;
    console.error(`[Worker] ComfyUI health check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  comfyLastCheck = now;
  return comfyHealthy;
}

/** Free ComfyUI GPU memory before each task — prevents OOM from stale model allocations. */
async function freeComfyMemory(): Promise<void> {
  try {
    await fetch(`${COMFYUI_BASE_URL}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // best-effort
  }
}

export function registerHandlers(newHandlers: TaskHandlerMap) {
  handlers = { ...handlers, ...newHandlers };
}

// ─── Process a single task with timeout protection ───
async function processTask(task: Task) {
  const handler = task.type ? handlers[task.type] : undefined;
  if (!handler) {
    await failTask(task.id, `No handler registered for task type: ${task.type}`);
    return;
  }

  const processTimeoutMs = getProcessTimeout(task.type);

  try {
    const result = await Promise.race([
      handler(task),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(
          `Process timeout after ${processTimeoutMs / 1000}s [type:${task.type}]`
        )), processTimeoutMs)
      ),
    ]);
    await completeTask(task.id, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Worker] Task ${task.id} [${task.type}] failed: ${message}`);
    await failTaskWithRetry(task.id, message);
  }
}

function runTask(task: Task, isComfy: boolean) {
  activeCount++;
  if (isComfy) comfyActive = true;
  processTask(task).finally(() => {
    activeCount--;
    if (isComfy) comfyActive = false;
  });
}

// ─── Reaper: periodically reset stale running tasks ───
async function reapStaleTasks() {
  try {
    const now = Date.now();
    const staleTasks = await db.select()
      .from(tasks)
      .where(eq(tasks.status, "running"))
      .all();

    for (const task of staleTasks) {
      const lastUpdate = task.updatedAt?.getTime() ?? task.createdAt?.getTime() ?? 0;
      const elapsed = now - lastUpdate;
      const idleTimeout = getIdleTimeout(task.type ?? "");

      if (elapsed > idleTimeout) {
        console.warn(`[Reaper] Resetting stale task ${task.id} [${task.type}] — idle ${(elapsed / 1000).toFixed(0)}s > threshold ${idleTimeout / 1000}s`);
        await failTaskWithRetry(task.id, `Reaper: idle timeout after ${(elapsed / 1000).toFixed(0)}s`);
      }
    }
  } catch (err) {
    console.error("[Reaper] error:", err);
  }
}

// ─── Polling loop ──
async function poll() {
  if (!isRunning) return;

  try {
    const ok = await checkComfyHealth();
    if (!ok) console.log("[Worker] ComfyUI ofine");

    // ── Pah A: ComfyUI tasks — serial, one at a time ──
    if (ok && !comfyActive) {
      await freeComfyMemory();
      const comfyTask = await dequeueTask({ skipComfy: false });
      if (comfyTask) runTask(comfyTask, true);
    }

    // ── Path B: LLM/VL tasks — concurrent, up to MAX_CONCURRENCY ─
    const llmSlots = MAX_CONCURRENCY - activeCount;
    if (llmSlots > 0) {
      const llmTasks = await dequeueTasks(llmSlots, { skipComfy: true });
      for (const t of llmTasks) runTask(t, false);
    }
  } catch (err) {
    console.error("[TaskWorker] Poll error:", err);
  }

  if (isRunning) {
    setTimeout(poll, POLL_INTERVAL_MS);
  }
}

export async function startWorker() {
  if (isRunning) return;
  // 清理残留 running → pending（worker 崩溃后恢复）
  await db.update(tasks).set({ status: "pending" }).where(eq(tasks.status, "running"));
  console.log("[Worker] Cleaned up stale running tasks");
  
  isRunning = true;
  console.log("[TskWorker] Started polling every", POLL_INTERVAL_MS, "ms");
  poll();
  // 启动 Reaper 循环
  setInterval(reapStaleTasks, REAPER_INTERVAL_MS);
}

export function stopWorker() {
  isRunning = false;
  console.log("[TskWorker] Stoped");
}