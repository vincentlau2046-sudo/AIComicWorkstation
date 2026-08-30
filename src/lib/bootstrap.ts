import { runMigrations } from "@/lib/db";
import { initializeProviders } from "@/lib/ai/setup";
import { registerPipelineHandlers } from "@/lib/pipeline";
import { startWorker } from "@/lib/task-queue";

let bootstrapped = false;

export async function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;

  console.log("[Bootstrap] Running database migrations...");
  runMigrations();

  console.log("[Bootstrap] Initializing AI providers...");
  initializeProviders();

  console.log("[Bootstrap] Registering pipeline handlers...");
  registerPipelineHandlers();

  console.log("[Bootstrap] Starting task worker...");
  await startWorker();

  console.log("[Bootstrap] Ready.");
}
