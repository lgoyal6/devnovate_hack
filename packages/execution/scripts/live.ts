import type { PendingExecutionEvent, RuntimeDependencies } from "../src/lib/ports.js";
import { productionDependencies } from "../src/lib/production.js";
import { ExecutionRuntime } from "../src/runtime.js";

function redactPreviewUrl(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("previewUrl" in value)) return value;
  const previewUrl = value.previewUrl;
  if (typeof previewUrl !== "string") return value;
  return {
    ...value,
    previewUrl: "[redacted signed preview]",
  };
}

export function liveRuntime(): ExecutionRuntime {
  const production = productionDependencies();
  const dependencies: RuntimeDependencies = {
    ...production,
    emitEvent: (runId: string, event: PendingExecutionEvent) => {
      process.stdout.write(`${JSON.stringify({
        runId,
        ...event,
        payload: redactPreviewUrl(event.payload),
      })}\n`);
    },
  };
  return new ExecutionRuntime(dependencies);
}
