import { posix as path } from "node:path";
import type {
  CandidateId,
  GateResult,
  SandboxRef,
  ScanResult,
  Verdict,
} from "@intentguard/contracts";
import {
  executionCandidateIds,
  type ExecutionCandidateId,
  type ProvisionConfig,
  validateRepositoryTargets,
} from "./lib/env.js";
import type { DaytonaPort, RuntimeDependencies, SandboxRecord } from "./lib/ports.js";
import { scanSandbox, type SnykConfig } from "./snyk.js";

type CandidateRuntimeTarget = {
  sourcePath: string;
  entrypoint: "server.py";
};

const candidateRuntimeTargets: Record<ExecutionCandidateId, CandidateRuntimeTarget> = {
  legacy: { sourcePath: "packages/fixture/legacy", entrypoint: "server.py" },
  A: { sourcePath: "packages/fixture/candidates/A", entrypoint: "server.py" },
  B: { sourcePath: "packages/fixture/candidates/B", entrypoint: "server.py" },
  C: { sourcePath: "packages/fixture/candidates/C", entrypoint: "server.py" },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 48) || "intentguard";
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function credentials(config: ProvisionConfig): { username: string; password: string } | undefined {
  if (config.gitUsername === undefined && config.gitToken === undefined) return undefined;
  if (config.gitUsername === undefined || config.gitToken === undefined) {
    throw new Error("EXECUTION_GIT_USERNAME and EXECUTION_GIT_TOKEN must be set together.");
  }
  return { username: config.gitUsername, password: config.gitToken };
}

function healthUrl(previewUrl: string, healthPath: string): string {
  const url = new URL(previewUrl);
  url.pathname = healthPath;
  return url.toString();
}

function executionCandidateId(candidateId: CandidateId): ExecutionCandidateId {
  if (!executionCandidateIds.includes(candidateId as ExecutionCandidateId)) {
    throw new Error(`Unknown execution candidate target: ${candidateId}.`);
  }
  return candidateId as ExecutionCandidateId;
}

function snykConfig(config: ProvisionConfig, candidateId: ExecutionCandidateId): SnykConfig {
  if (config.snyk.token === undefined) {
    throw new Error(`SNYK_TOKEN is required to provision scannable candidate ${candidateId}.`);
  }
  return {
    token: config.snyk.token,
    cliPath: config.snyk.cliPath,
    timeoutSeconds: config.snyk.timeoutSeconds,
  };
}

export class ExecutionRuntime {
  private daytona: DaytonaPort | undefined;
  private lastProvisionConfig: ProvisionConfig | undefined;
  private readonly runs = new Map<string, Map<CandidateId, SandboxRecord>>();
  private readonly providerContactedRuns = new Set<string>();
  private readonly tornDownRuns = new Set<string>();

  constructor(private readonly dependencies: RuntimeDependencies) {}

  private client(config: ProvisionConfig): DaytonaPort {
    this.daytona ??= this.dependencies.createDaytona(config.daytona);
    return this.daytona;
  }

  private async waitForHealth(previewUrl: string, config: ProvisionConfig): Promise<void> {
    const url = healthUrl(previewUrl, config.healthPath);
    const deadline = Date.now() + config.healthTimeoutSeconds * 1000;
    let lastFailure = "no response";
    while (Date.now() < deadline) {
      try {
        const response = await this.dependencies.fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(Math.min(config.healthPollMs, 5000)),
        });
        if (response.ok) return;
        lastFailure = `HTTP ${String(response.status)}`;
      } catch (error: unknown) {
        lastFailure = errorMessage(error);
      }
      await this.dependencies.sleep(config.healthPollMs);
    }
    throw new Error(`Health check ${url} timed out: ${lastFailure}.`);
  }

  private async provisionOne(
    runId: string,
    candidateId: ExecutionCandidateId,
    snapshotId: string,
    config: ProvisionConfig,
    records: Map<CandidateId, SandboxRecord>,
  ): Promise<SandboxRef> {
    const runtimeTarget = candidateRuntimeTargets[candidateId];
    const target = config.repositories[candidateId];
    const sourceDir = path.join(config.repositoryDir, runtimeTarget.sourcePath);
    const client = this.client(config);
    this.providerContactedRuns.add(runId);
    const sandbox = await client.create({
      name: safeName(`ig-${runId}-${candidateId}`),
      snapshotId,
      labels: { application: "intentguard", runId, candidateId },
      ttlMinutes: config.daytona.ttlMinutes,
      networkAllowList: config.networkAllowList,
    }, config.daytona.createTimeoutSeconds);
    const record: SandboxRecord = { candidateId, snapshotId, sourceDir, sandbox };
    records.set(candidateId, record);
    await sandbox.resize(config.daytona.resources, config.daytona.createTimeoutSeconds);
    const previewUrl = await sandbox.signedPreviewUrl(config.appPort, config.daytona.previewTtlSeconds);
    const ref: SandboxRef = {
      candidateId,
      sandboxId: sandbox.id,
      snapshotId,
      commitSha: target.commitSha,
      previewUrl,
      createdAt: sandbox.createdAt ?? this.dependencies.now().toISOString(),
    };
    this.dependencies.emitEvent(runId, {
      source: "daytona",
      type: "SANDBOX_CREATED",
      candidateId,
      message: `Daytona sandbox ${sandbox.id} created for ${candidateId}.`,
      payload: ref,
    });
    await sandbox.clone(target.url, config.repositoryDir, target.commitSha, credentials(config));
    this.dependencies.emitEvent(runId, {
      source: "daytona",
      type: "SOURCE_READY",
      candidateId,
      message: `${candidateId} checked out at ${target.commitSha}.`,
      payload: { commitSha: target.commitSha },
    });
    if (candidateId !== "legacy") {
      record.scan = await scanSandbox(candidateId, sandbox, sourceDir, snykConfig(config, candidateId));
    }
    const install = await sandbox.execute(
      config.installCommand,
      sourceDir,
      {},
      config.daytona.commandTimeoutSeconds,
    );
    if (install.exitCode !== 0) {
      throw new Error(`Dependency installation failed for ${candidateId} with exit ${String(install.exitCode)}.`);
    }
    const startCommand = [
      "cd --",
      shellArgument(sourceDir),
      "&& exec python3",
      shellArgument(runtimeTarget.entrypoint),
      "--port",
      String(config.appPort),
    ].join(" ");
    await sandbox.start(startCommand, config.daytona.commandTimeoutSeconds);
    await this.waitForHealth(previewUrl, config);
    this.dependencies.emitEvent(runId, {
      source: "daytona",
      type: "APP_HEALTHY",
      candidateId,
      message: `${candidateId} is healthy on its signed Daytona preview.`,
      payload: { previewUrl },
    });
    return ref;
  }

  async provision(runId: string, candidateIds: CandidateId[], snapshotId: string): Promise<SandboxRef[]> {
    if (this.runs.has(runId)) throw new Error(`Run ${runId} already owns execution sandboxes.`);
    const records = new Map<CandidateId, SandboxRecord>();
    this.runs.set(runId, records);
    this.providerContactedRuns.delete(runId);
    this.tornDownRuns.delete(runId);
    if (candidateIds.length === 0) throw new Error("Provisioning requires at least one candidate.");
    if (new Set(candidateIds).size !== candidateIds.length) throw new Error("Candidate IDs must be unique.");
    const config = this.dependencies.loadProvisionConfig();
    // Revalidate injected configurations as well as production environment input.
    validateRepositoryTargets(config.repositories);
    credentials(config);
    const internalCandidateIds = candidateIds.map((candidateId) => executionCandidateId(candidateId));
    for (const internalCandidateId of internalCandidateIds) {
      if (internalCandidateId !== "legacy") snykConfig(config, internalCandidateId);
    }
    this.lastProvisionConfig = config;
    const settled = await Promise.allSettled(
      internalCandidateIds.map((candidateId) => this.provisionOne(runId, candidateId, snapshotId, config, records)),
    );
    const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failures.length !== 0) {
      const provisioningError = new AggregateError(
        failures.map((failure) => failure.reason),
        `Provisioning failed for ${String(failures.length)} candidate(s).`,
      );
      try {
        await this.teardown(runId);
      } catch (cleanupError: unknown) {
        throw new AggregateError([provisioningError, cleanupError], "Provisioning and cleanup both failed.");
      }
      throw provisioningError;
    }
    return settled.map((item) => (item as PromiseFulfilledResult<SandboxRef>).value);
  }

  async scan(runId: string, ref: SandboxRef): Promise<ScanResult> {
    const record = this.runs.get(runId)?.get(ref.candidateId);
    if (record === undefined || record.sandbox.id !== ref.sandboxId) {
      throw new Error(`Sandbox ${ref.sandboxId} is not registered to ${runId}/${ref.candidateId}.`);
    }
    if (ref.candidateId === "legacy") {
      throw new Error("Legacy is the behavioral baseline and is not Snyk-scanned.");
    }
    const config = this.dependencies.loadProvisionConfig();
    record.scan ??= await scanSandbox(
      ref.candidateId,
      record.sandbox,
      record.sourceDir,
      snykConfig(config, executionCandidateId(ref.candidateId)),
    );
    this.dependencies.emitEvent(runId, {
      source: "snyk",
      type: "SCAN_COMPLETE",
      candidateId: ref.candidateId,
      message: `Snyk scan for ${ref.candidateId}: ${record.scan.status}.`,
      payload: record.scan,
    });
    return record.scan;
  }

  async teardown(runId: string): Promise<void> {
    if (this.tornDownRuns.has(runId)) return;
    const locallyKnownRun = this.runs.has(runId);
    if (locallyKnownRun && !this.providerContactedRuns.has(runId)) {
      this.runs.delete(runId);
      this.tornDownRuns.add(runId);
      this.dependencies.emitEvent(runId, {
        source: "daytona",
        type: "TORN_DOWN",
        message: "0 Daytona sandbox(es) torn down.",
        payload: { sandboxCount: 0 },
      });
      return;
    }
    const daytonaConfig = this.lastProvisionConfig?.daytona ?? this.dependencies.loadDaytonaConfig();
    const client = this.daytona ??= this.dependencies.createDaytona(daytonaConfig);
    const registered = [...(this.runs.get(runId)?.values() ?? [])].map((record) => record.sandbox);
    const sandboxes = registered.length === 0 ? [] : registered;
    if (sandboxes.length === 0) {
      for await (const sandbox of client.list({ application: "intentguard", runId })) sandboxes.push(sandbox);
    }
    const unique = [...new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox])).values()];
    const settled = await Promise.allSettled(
      unique.map((sandbox) => sandbox.delete(daytonaConfig.createTimeoutSeconds)),
    );
    const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failures.length !== 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Failed to delete ${String(failures.length)} Daytona sandbox(es) for ${runId}.`,
      );
    }
    this.runs.delete(runId);
    this.providerContactedRuns.delete(runId);
    this.tornDownRuns.add(runId);
    this.dependencies.emitEvent(runId, {
      source: "daytona",
      type: "TORN_DOWN",
      message: `${String(unique.length)} Daytona sandbox(es) torn down.`,
      payload: { sandboxCount: unique.length },
    });
  }

  async narrate(runId: string, verdict: Verdict, gates: GateResult[]): Promise<string> {
    let narration = "Narration unavailable: RocketRide did not produce a response.";
    let narrator;
    try {
      narrator = this.dependencies.createNarrator(this.dependencies.loadRocketRideConfig());
      narration = await narrator.narrate(verdict, gates);
    } catch (error: unknown) {
      narration = `Narration unavailable: ${errorMessage(error)}`;
    } finally {
      if (narrator !== undefined) {
        try {
          await narrator.close();
        } catch (error: unknown) {
          if (!narration.startsWith("Narration unavailable:")) {
            narration = `Narration unavailable: RocketRide cleanup failed: ${errorMessage(error)}`;
          }
        }
      }
    }
    this.dependencies.emitEvent(runId, {
      source: "rocketride",
      type: "NARRATED",
      message: narration.startsWith("Narration unavailable:") ? narration : "RocketRide explained the verdict.",
      payload: { narration },
    });
    return narration;
  }
}
