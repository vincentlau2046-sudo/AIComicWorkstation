import { getUserId } from "./fingerprint";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

const DEFAULT_TIMEOUT = 120_000; // 2 minutes

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const userId = getUserId();
  const headers = new Headers(options.headers);
  if (userId) headers.set("x-user-id", userId);

  // Apply default timeout unless caller explicitly provides a signal
  const signal = options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT);

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
}
