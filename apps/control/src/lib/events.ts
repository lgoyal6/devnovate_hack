import type { RunEvent } from "@intentguard/contracts";
import type { PendingRunEvent } from "./store.js";

export interface EventWriter {
  appendEvent(runId: string, event: PendingRunEvent): RunEvent;
}

let configuredWriter: EventWriter | undefined;

/** Configure the process-wide event sink once when the control plane starts. */
export function configureEventWriter(writer: EventWriter): void {
  if (configuredWriter !== undefined && configuredWriter !== writer) {
    throw new Error("The control event writer is already configured for this process.");
  }
  configuredWriter = writer;
}

/** Test-only reset for isolated in-memory stores. */
export function resetEventWriter(): void {
  configuredWriter = undefined;
}

/**
 * The single event entrypoint used by control-owned modules. Sequence allocation
 * and persistence happen atomically inside the configured store.
 */
export function emitEvent(runId: string, event: PendingRunEvent): RunEvent {
  if (configuredWriter === undefined) {
    throw new Error("emitEvent was called before configureEventWriter.");
  }
  return configuredWriter.appendEvent(runId, event);
}
