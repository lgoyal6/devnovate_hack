import type { CandidateId, GateResult, RunEvent, ScanResult, Verdict } from "@intentguard/contracts";
import type { DaytonaConfig, ProvisionConfig, RocketRideConfig } from "./env.js";

export type PendingExecutionEvent = Omit<RunEvent, "seq" | "ts">;
export type EventSink = (runId: string, event: PendingExecutionEvent) => unknown;

export type CommandResult = { exitCode: number; output: string };

export interface SandboxPort {
  readonly id: string;
  readonly createdAt: string | undefined;
  clone(
    url: string,
    path: string,
    commitSha: string,
    credentials?: { username: string; password: string },
  ): Promise<void>;
  resize(resources: { cpu: number; memory: number; disk: number }, timeoutSeconds: number): Promise<void>;
  execute(command: string, cwd: string, env: Record<string, string>, timeoutSeconds: number): Promise<CommandResult>;
  start(command: string, timeoutSeconds: number): Promise<void>;
  signedPreviewUrl(port: number, expiresInSeconds: number): Promise<string>;
  delete(timeoutSeconds: number): Promise<void>;
}

export interface DaytonaPort {
  create(
    input: {
      name: string;
      snapshotId: string;
      labels: Record<string, string>;
      ttlMinutes: number;
      networkAllowList: string;
    },
    timeoutSeconds: number,
  ): Promise<SandboxPort>;
  list(labels: Record<string, string>): AsyncIterable<SandboxPort>;
}

export interface NarratorPort {
  narrate(verdict: Verdict, gates: GateResult[]): Promise<string>;
  close(): Promise<void>;
}

export type RuntimeDependencies = {
  loadProvisionConfig(): ProvisionConfig;
  loadDaytonaConfig(): DaytonaConfig;
  createDaytona(config: ProvisionConfig["daytona"]): DaytonaPort;
  loadRocketRideConfig(): RocketRideConfig;
  createNarrator(config: RocketRideConfig): NarratorPort;
  emitEvent: EventSink;
  fetch: typeof globalThis.fetch;
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
};

export type SandboxRecord = {
  candidateId: CandidateId;
  snapshotId: string;
  sourceDir: string;
  sandbox: SandboxPort;
  scan?: ScanResult;
};
