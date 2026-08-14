import type {
  CandidateId,
  CorpusInput,
  GateResult,
  RawResult,
  Rule,
  SandboxRef,
  ScanResult,
  Severity,
  Verdict,
} from "@intentguard/contracts";
import { compareRun } from "./comparison.js";
import { emitEvent } from "./lib/events.js";
import type { ControlStore, StartupReconciliation } from "./lib/store.js";
import { decideRun } from "./policy.js";

export type ReadinessResult = {
  build: { passed: boolean; detail: string };
  health: { passed: boolean; detail: string };
};

export interface WorkerDependencies {
  loadRules(runId: string): Promise<Rule[]>;
  generateCorpus(runId: string, rules: Rule[]): CorpusInput[];
  provision(runId: string, candidateIds: CandidateId[], snapshotId: string): Promise<SandboxRef[]>;
  verify(runId: string, sandbox: SandboxRef): Promise<ReadinessResult>;
  replay(
    runId: string,
    previewUrl: string,
    corpus: CorpusInput[],
    candidateId: CandidateId,
  ): Promise<RawResult[]>;
  scan(runId: string, sandbox: SandboxRef): Promise<ScanResult>;
  narrate(runId: string, verdict: Verdict, gates: GateResult[]): Promise<string>;
  teardown(runId: string): Promise<void>;
}

export type WorkerOptions = {
  blockingSeverity?: Severity;
};

type CandidateEvidence = {
  candidateId: CandidateId;
  readiness?: ReadinessResult;
  results?: RawResult[];
  scan?: ScanResult;
  error?: string;
};

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readinessGates(evidence: CandidateEvidence): GateResult[] {
  const readiness = evidence.readiness;
  if (readiness === undefined) return [];
  return [
    {
      candidateId: evidence.candidateId,
      key: "build",
      category: "build",
      status: readiness.build.passed ? "PASS" : "FAIL",
      detail: readiness.build.detail,
    },
    {
      candidateId: evidence.candidateId,
      key: "health",
      category: "health",
      status: readiness.health.passed ? "PASS" : "FAIL",
      detail: readiness.health.detail,
    },
  ];
}

function securityGate(scan: ScanResult, blockingSeverity: Severity): GateResult {
  const blockingFinding = scan.findings.find(
    (finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[blockingSeverity],
  );
  if (scan.status === "ERROR") {
    return {
      candidateId: scan.candidateId,
      key: "security",
      category: "security",
      status: "FAIL",
      detail: "scanner returned ERROR; policy fails closed",
    };
  }
  if (blockingFinding !== undefined) {
    return {
      candidateId: scan.candidateId,
      key: "security",
      category: "security",
      status: "FAIL",
      detail: `${blockingFinding.severity} ${blockingFinding.id} in ${blockingFinding.file}:${String(blockingFinding.line)} is at or above the ${blockingSeverity} blocking severity`,
    };
  }
  return {
    candidateId: scan.candidateId,
    key: "security",
    category: "security",
    status: "PASS",
    detail: `no findings at or above ${blockingSeverity}`,
  };
}

function emitGate(runId: string, gate: GateResult): void {
  emitEvent(runId, {
    source: "control",
    type: "GATE_RESULT",
    candidateId: gate.candidateId,
    message: `${gate.status} ${gate.key} for ${gate.candidateId}: ${gate.detail}`,
    payload: gate,
  });
}

async function collectCandidateEvidence(
  runId: string,
  sandbox: SandboxRef,
  corpus: CorpusInput[],
  dependencies: WorkerDependencies,
  scanRequired: boolean,
): Promise<CandidateEvidence> {
  try {
    const readiness = await dependencies.verify(runId, sandbox);
    if (!readiness.build.passed || !readiness.health.passed) {
      return {
        candidateId: sandbox.candidateId,
        readiness,
        error: !readiness.build.passed ? readiness.build.detail : readiness.health.detail,
      };
    }
    const [replayOutcome, scanOutcome] = await Promise.allSettled([
      dependencies.replay(runId, sandbox.previewUrl, corpus, sandbox.candidateId),
      scanRequired ? dependencies.scan(runId, sandbox) : Promise.resolve(undefined),
    ]);
    const errors: string[] = [];
    if (replayOutcome.status === "rejected") {
      errors.push(`replay: ${failureMessage(replayOutcome.reason)}`);
    }
    if (scanOutcome.status === "rejected") {
      errors.push(`scan: ${failureMessage(scanOutcome.reason)}`);
    }
    return {
      candidateId: sandbox.candidateId,
      readiness,
      ...(replayOutcome.status === "fulfilled" ? { results: replayOutcome.value } : {}),
      ...(scanOutcome.status === "fulfilled" && scanOutcome.value !== undefined
        ? { scan: scanOutcome.value }
        : {}),
      ...(errors.length === 0 ? {} : { error: errors.join("; ") }),
    };
  } catch (error: unknown) {
    return {
      candidateId: sandbox.candidateId,
      error: failureMessage(error),
    };
  }
}

export async function evaluateRun(
  runId: string,
  store: ControlStore,
  dependencies: WorkerDependencies,
  options: WorkerOptions = {},
): Promise<Verdict> {
  const run = store.requireRun(runId);
  if (run.state !== "DRAFT") {
    throw new Error(`Worker expected run ${runId} to be DRAFT, got ${run.state}.`);
  }
  const allCandidateIds = store.getCandidates(runId).map((candidate) => candidate.candidateId);
  const modernCandidateIds = allCandidateIds.filter((candidateId) => candidateId !== "legacy");
  const blockingSeverity = options.blockingSeverity ?? "high";

  let teardownError: unknown;
  let primaryError: unknown;
  let retainForApproval = false;
  try {
    if (!allCandidateIds.includes("legacy")) throw new Error(`Run ${runId} has no legacy baseline.`);
    if (modernCandidateIds.length === 0) throw new Error(`Run ${runId} has no rewrite candidates.`);
    const rules = await dependencies.loadRules(runId);
    if (rules.length === 0) throw new Error("Forge returned no locked rules.");
    store.saveRules(runId, rules);
    const corpus = dependencies.generateCorpus(runId, rules);
    if (corpus.length === 0) throw new Error("Rule-derived corpus is empty.");
    store.saveCorpus(runId, corpus);
    store.transitionRun(runId, "RULES_LOCKED");
    emitEvent(runId, {
      source: "forge",
      type: "RULES_LOCKED",
      message: `${String(rules.length)} business rules recovered from the legacy source and locked.`,
      payload: { rules, corpusSize: corpus.length },
    });

    store.transitionRun(runId, "PROVISIONING");
    for (const candidateId of allCandidateIds) {
      store.updateCandidate(runId, candidateId, { status: "PROVISIONING" });
    }

    const sandboxes = await dependencies.provision(runId, allCandidateIds, run.snapshotId);
    const byCandidate = new Map(sandboxes.map((sandbox) => [sandbox.candidateId, sandbox]));
    const duplicateCount = sandboxes.length - byCandidate.size;
    if (duplicateCount !== 0) throw new Error("Provisioning returned duplicate candidate sandboxes.");
    const unexpectedSandboxes = sandboxes
      .filter((sandbox) => !allCandidateIds.includes(sandbox.candidateId))
      .map((sandbox) => sandbox.candidateId);
    if (unexpectedSandboxes.length !== 0) {
      throw new Error(`Provisioning returned unexpected sandboxes: ${unexpectedSandboxes.join(", ")}.`);
    }
    for (const candidateId of allCandidateIds) {
      const sandbox = byCandidate.get(candidateId);
      if (sandbox === undefined) {
        store.updateCandidate(runId, candidateId, {
          status: "ENVIRONMENT_ERROR",
          failureReason: "provisioning did not return a sandbox",
        });
      } else {
        store.updateCandidate(runId, candidateId, { status: "READY", sandbox });
      }
    }

    store.transitionRun(runId, "EVALUATING");
    const evidence = await Promise.all(
      sandboxes.map((sandbox) => collectCandidateEvidence(
        runId,
        sandbox,
        corpus,
        dependencies,
        sandbox.candidateId !== "legacy",
      )),
    );

    const allRawResults: RawResult[] = [];
    const scans: ScanResult[] = [];
    const gates: GateResult[] = [];
    for (const item of evidence) {
      const itemGates = readinessGates(item);
      gates.push(...itemGates);
      if (itemGates.length !== 0) store.saveGates(runId, itemGates);
      itemGates.forEach((gate) => emitGate(runId, gate));
      if (item.results !== undefined) {
        store.saveRawResults(runId, item.results);
        allRawResults.push(...item.results);
      }
      if (item.scan !== undefined) {
        store.saveScan(runId, item.scan);
        scans.push(item.scan);
        const gate = securityGate(item.scan, blockingSeverity);
        gates.push(gate);
        store.saveGates(runId, [gate]);
        emitGate(runId, gate);
      }
      if (item.error === undefined) {
        store.updateCandidate(runId, item.candidateId, { status: "REPLAYED" });
      } else {
        store.updateCandidate(runId, item.candidateId, {
          status: "ENVIRONMENT_ERROR",
          failureReason: item.error,
        });
      }
    }

    const legacyResults = evidence.find((item) => item.candidateId === "legacy")?.results;
    if (legacyResults !== undefined) {
      for (const candidateId of modernCandidateIds) {
        const candidateResults = evidence.find((item) => item.candidateId === candidateId)?.results;
        if (candidateResults !== undefined) {
          const compared = compareRun(
            runId,
            legacyResults,
            candidateResults,
            rules,
            corpus,
            (comparisonGates) => store.saveGates(runId, comparisonGates),
          );
          gates.push(...compared);
        }
      }
    }
    store.saveGates(runId, gates);
    store.transitionRun(runId, "AGGREGATING");

    const environmentFailures = store.getCandidates(runId)
      .filter((candidate) => candidate.status === "ENVIRONMENT_ERROR")
      .map((candidate) => `${candidate.candidateId}: ${candidate.failureReason ?? "unknown environment error"}`);
    const snapshotMismatch = sandboxes.some((sandbox) => sandbox.snapshotId !== run.snapshotId);
    const environmentConsistent = environmentFailures.length === 0 && !snapshotMismatch;
    const verdict = decideRun(
      runId,
      gates,
      scans,
      {
        policyVersion: run.policyVersion,
        candidateIds: modernCandidateIds,
        rules,
        rawResults: allRawResults,
        commitOrder: modernCandidateIds,
        blockingSeverity,
        environment: {
          consistent: environmentConsistent,
          ...(environmentConsistent
            ? {}
            : { detail: snapshotMismatch ? "sandbox snapshots differ" : environmentFailures.join("; ") }),
        },
      },
      (nextVerdict) => store.saveVerdict(runId, nextVerdict),
      (nextVerdict) => store.transitionRun(
        runId,
        nextVerdict.outcome === "RECOMMEND" ? "AWAITING_APPROVAL" : "BLOCKED",
      ),
    );

    for (const decision of verdict.perCandidate) {
      const current = store.getCandidates(runId).find(
        (candidate) => candidate.candidateId === decision.candidateId,
      );
      if (current?.status !== "ENVIRONMENT_ERROR") {
        store.updateCandidate(runId, decision.candidateId, {
          status: decision.eligible ? "PASSED" : "FAILED",
          ...(decision.reasons.length === 0 ? {} : { failureReason: decision.reasons.join("; ") }),
        });
      }
    }

    if (verdict.outcome === "RECOMMEND") retainForApproval = true;

    try {
      const narration = await dependencies.narrate(runId, verdict, gates);
      store.saveNarration(runId, narration);
    } catch (error: unknown) {
      store.saveNarration(runId, `Narration unavailable: ${failureMessage(error)}`);
    }
    return verdict;
  } catch (error: unknown) {
    primaryError = error;
    const detail = failureMessage(error);
    try {
      const failureVerdict: Verdict = {
        outcome: "INCONCLUSIVE",
        recommended: null,
        perCandidate: modernCandidateIds.map((candidateId) => ({
          candidateId,
          eligible: false,
          reasons: [`evaluation failed: ${detail}`],
        })),
        policyVersion: run.policyVersion,
      };
      store.saveVerdict(runId, failureVerdict);
      store.failRun(runId, detail);
      emitEvent(runId, {
        source: "control",
        type: "VERDICT_READY",
        message: `Verdict: INCONCLUSIVE because evaluation failed: ${detail}`,
        payload: failureVerdict,
      });
    } catch (failurePersistenceError: unknown) {
      primaryError = new AggregateError(
        [error, failurePersistenceError],
        `Run ${runId} failed and its terminal failure could not be fully persisted.`,
      );
    }
    throw primaryError;
  } finally {
    if (!retainForApproval) {
      try {
        await dependencies.teardown(runId);
      } catch (error: unknown) {
        teardownError = error;
      }
    }
    store.releaseClaim(runId);
    if (teardownError !== undefined) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, teardownError],
          `Run ${runId} evaluation and teardown both failed.`,
        );
      }
      throw new Error(`Teardown failed for run ${runId}: ${failureMessage(teardownError)}`, {
        cause: teardownError,
      });
    }
  }
}

/** Release sandboxes after approval; the execution adapter emits TORN_DOWN. */
export async function teardownApprovedRun(
  runId: string,
  store: ControlStore,
  dependencies: Pick<WorkerDependencies, "teardown">,
): Promise<void> {
  const run = store.requireRun(runId);
  if (run.state !== "APPROVED") {
    throw new Error(`Run ${runId} cannot be torn down after approval while it is ${run.state}.`);
  }
  await dependencies.teardown(runId);
}

export async function reconcileStartupRuns(
  store: ControlStore,
  dependencies: Pick<WorkerDependencies, "teardown">,
  onError: (runId: string, error: unknown) => void,
): Promise<StartupReconciliation> {
  const reconciliation = store.reconcileStartup();
  const teardownResults = await Promise.allSettled(
    reconciliation.interruptedRuns.map(
      (interrupted) => dependencies.teardown(interrupted.runId),
    ),
  );
  teardownResults.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    const interrupted = reconciliation.interruptedRuns[index];
    if (interrupted === undefined) {
      throw new Error("Startup teardown result had no matching interrupted run.");
    }
    onError(
      interrupted.runId,
      new Error(
        `Startup recovery persisted ${interrupted.runId} as INCONCLUSIVE but teardown failed.`,
        { cause: result.reason },
      ),
    );
  });
  return reconciliation;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runWorkerLoop(
  store: ControlStore,
  dependencies: WorkerDependencies,
  signal: AbortSignal,
  onError: (runId: string, error: unknown) => void,
  options: WorkerOptions = {},
  pollMilliseconds = 250,
): Promise<void> {
  while (!signal.aborted) {
    const runId = store.claimNextDraftRun();
    if (runId === undefined) {
      await delay(pollMilliseconds, signal);
      continue;
    }
    try {
      await evaluateRun(runId, store, dependencies, options);
    } catch (error: unknown) {
      onError(runId, error);
    }
  }
}
