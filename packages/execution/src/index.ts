import type { CandidateId, GateResult, SandboxRef, ScanResult, Verdict } from "@intentguard/contracts";
import { productionDependencies } from "./lib/production.js";
import { ExecutionRuntime } from "./runtime.js";

const runtime = new ExecutionRuntime(productionDependencies());

export function provision(
  runId: string,
  candidateIds: CandidateId[],
  snapshotId: string,
): Promise<SandboxRef[]> {
  return runtime.provision(runId, candidateIds, snapshotId);
}

export function scan(runId: string, ref: SandboxRef): Promise<ScanResult> {
  return runtime.scan(runId, ref);
}

export function teardown(runId: string): Promise<void> {
  return runtime.teardown(runId);
}

export function narrate(runId: string, verdict: Verdict, gates: GateResult[]): Promise<string> {
  return runtime.narrate(runId, verdict, gates);
}
