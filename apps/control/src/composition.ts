import type { SandboxRef } from "@intentguard/contracts";
import type { ControlStore } from "./lib/store.js";
import type { WorkerDependencies } from "./worker.js";

export type ProductionWorkerPorts = Omit<WorkerDependencies, "verify">;

function sameSandbox(left: SandboxRef, right: SandboxRef): boolean {
  return left.candidateId === right.candidateId
    && left.sandboxId === right.sandboxId
    && left.snapshotId === right.snapshotId
    && left.commitSha === right.commitSha
    && left.previewUrl === right.previewUrl
    && left.createdAt === right.createdAt;
}

function healthyPreviewUrl(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("previewUrl" in payload)) return undefined;
  return typeof payload.previewUrl === "string" ? payload.previewUrl : undefined;
}

/**
 * Adapts the execution package's provision contract to the worker contract.
 *
 * Execution only returns a SandboxRef after dependency installation exits
 * successfully, the app starts, and its health endpoint responds successfully.
 * A rejected provision never reaches verify, so no second readiness probe is
 * needed and no readiness failure is converted into a passing gate here.
 */
export function composeProductionWorkerDependencies(
  store: ControlStore,
  ports: ProductionWorkerPorts,
): WorkerDependencies {
  return {
    ...ports,
    verify: async (runId, sandbox) => {
      const stored = store.getCandidates(runId)
        .find((candidate) => candidate.candidateId === sandbox.candidateId)?.sandbox;
      if (stored === null || stored === undefined || !sameSandbox(stored, sandbox)) {
        throw new Error(
          `Sandbox ${sandbox.sandboxId} is not the persisted provision result for ${runId}/${sandbox.candidateId}.`,
        );
      }
      const healthyEvent = store.listEvents(runId).find(
        (event) => event.type === "APP_HEALTHY"
          && event.candidateId === sandbox.candidateId
          && healthyPreviewUrl(event.payload) === sandbox.previewUrl,
      );
      if (healthyEvent === undefined) {
        const detail = `sandbox ${sandbox.sandboxId} has no matching APP_HEALTHY execution evidence for ${runId}/${sandbox.candidateId}`;
        return {
          build: {
            passed: false,
            detail: `${detail}; dependency installation and startup cannot be attested`,
          },
          health: {
            passed: false,
            detail: `${detail}; startup health cannot be attested`,
          },
        };
      }
      return {
        build: {
          passed: true,
          detail: `execution reached APP_HEALTHY at event ${String(healthyEvent.seq)} after dependency installation`,
        },
        health: {
          passed: true,
          detail: `execution APP_HEALTHY event ${String(healthyEvent.seq)} confirms its startup health check passed`,
        },
      };
    },
  };
}
