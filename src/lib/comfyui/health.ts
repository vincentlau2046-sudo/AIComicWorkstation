/**
 * Standalone ComfyUI health check.
 * Stateless — no caching. Intended for one-shot API-route preflight checks
 * before enqueuing ComfyUI-dependent batch tasks.
 */

const COMFYUI_BASE_URL = process.env.COMFYUI_BASE_URL || "http://localhost:8188";

export async function checkComfyHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${COMFYUI_BASE_URL}/system_stats`, {
      signal: AbortSignal.timeout(3000),
    });
    return { ok: res.ok };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}