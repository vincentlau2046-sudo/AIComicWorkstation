import { getUserId } from "./fingerprint";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

const DEFAULT_TIMEOUT = 1_200_000; // 20 minutes (matches server maxDuration for import routes)

/**
 * Creates an AbortSignal that auto-aborts after `ms` milliseconds.
 * Uses AbortController + setTimeout for maximum browser compatibility.
 */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const userId = getUserId();
  const headers = new Headers(options.headers);
  if (userId) headers.set("x-user-id", userId);

  // Use the caller's signal if provided, otherwise apply a default timeout
  const { signal, clear } = options.signal
    ? { signal: options.signal, clear: () => {} }
    : timeoutSignal(DEFAULT_TIMEOUT);

  try {
    const response = await fetch(url, { ...options, headers, signal });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body = await response.clone().json();
        if (body.error) message = body.error;
      } catch {}
      throw new ApiError(response.status, message);
    }
    return response;
  } finally {
    clear(); // Always clear the timer once fetch settles
  }
}