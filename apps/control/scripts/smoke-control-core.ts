import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  CandidateId,
  CorpusInput,
  RawResult,
  Rule,
  RunEvent,
  SandboxRef,
  ScanResult,
} from "@intentguard/contracts";
import { approvalIsValid } from "../src/approval.js";
import { compare } from "../src/comparison.js";
import {
  composeProductionWorkerDependencies,
  type ProductionWorkerPorts,
} from "../src/composition.js";
import { configureEventWriter, emitEvent, resetEventWriter } from "../src/lib/events.js";
import { resolveRepositoryPath } from "../src/lib/paths.js";
import { ControlStore } from "../src/lib/store.js";
import { decide } from "../src/policy.js";
import { loadRulesFile } from "../src/rules.js";
import { createControlServer, listenControlServer } from "../src/server.js";
import {
  evaluateRun,
  reconcileStartupRuns,
  runWorkerLoop,
  teardownApprovedRun,
  type WorkerDependencies,
} from "../src/worker.js";

type InterruptedState = "RULES_LOCKED" | "PROVISIONING" | "EVALUATING" | "AGGREGATING";

const rules: Rule[] = [{
  id: "REQ-014",
  title: "Approval boundary",
  behavior: "Refund approval must match the legacy service at the locked boundary.",
  boundaries: ["500.49"],
  blocking: true,
}];

const corpus: CorpusInput[] = [{
  id: "IN-0001",
  ruleId: "REQ-014",
  method: "POST",
  path: "/refunds/approve",
  payload: { amount: "500.49" },
}];

function sandbox(runId: string, candidateId: CandidateId): SandboxRef {
  return {
    candidateId,
    sandboxId: `sandbox-${runId}-${candidateId}`,
    snapshotId: "snapshot-smoke",
    commitSha: `commit-${candidateId}`,
    previewUrl: `http://${candidateId}.smoke.local`,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

function replay(candidateId: CandidateId): RawResult[] {
  return [{
    candidateId,
    inputId: "IN-0001",
    status: 200,
    body: { approved: true, audit: { rule: "REQ-014" } },
    latencyMs: candidateId === "A" ? 8 : 10,
  }];
}

function scan(candidateId: CandidateId): ScanResult {
  return candidateId === "B"
    ? {
        candidateId,
        status: "FINDINGS",
        findings: [{
          id: "SNYK-CMDI-001",
          severity: "critical",
          title: "Shell command injection",
          file: "server.py",
          line: 233,
        }],
        raw: { tool: "smoke" },
      }
    : { candidateId, status: "CLEAN", findings: [], raw: { tool: "smoke" } };
}

function buildDependencies(store: ControlStore): WorkerDependencies {
  const ports: ProductionWorkerPorts = {
    loadRules: async () => rules,
    generateCorpus: () => corpus,
    provision: async (runId, candidateIds) => candidateIds.map((candidateId) => {
      const reference = sandbox(runId, candidateId);
      emitEvent(runId, {
        source: "daytona",
        type: "SANDBOX_CREATED",
        candidateId,
        message: `Created ${reference.sandboxId}.`,
        payload: reference,
      });
      emitEvent(runId, {
        source: "daytona",
        type: "APP_HEALTHY",
        candidateId: reference.candidateId,
        message: `${reference.candidateId} is healthy.`,
        payload: { previewUrl: reference.previewUrl },
      });
      return reference;
    }),
    replay: async (runId, _previewUrl, _corpus, candidateId) => {
      const results = replay(candidateId);
      emitEvent(runId, {
        source: "rocketride",
        type: "CORPUS_REPLAYED",
        candidateId,
        message: `Replayed ${String(results.length)} input for ${candidateId}.`,
        payload: { results },
      });
      return results;
    },
    scan: async (runId, reference) => {
      const result = scan(reference.candidateId);
      emitEvent(runId, {
        source: "snyk",
        type: "SCAN_COMPLETE",
        candidateId: reference.candidateId,
        message: `Scan ${result.status} for ${reference.candidateId}.`,
        payload: result,
      });
      return result;
    },
    narrate: async (runId, verdict) => {
      const narration = `Candidate ${verdict.recommended ?? "none"} is the stored recommendation.`;
      emitEvent(runId, {
        source: "rocketride",
        type: "NARRATED",
        message: narration,
        payload: { narration },
      });
      return narration;
    },
    teardown: async (runId) => {
      emitEvent(runId, {
        source: "daytona",
        type: "TORN_DOWN",
        message: "Released all run sandboxes.",
        payload: { sandboxCount: store.getCandidates(runId).filter((item) => item.sandbox !== null).length },
      });
    },
  };
  return composeProductionWorkerDependencies(store, ports);
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function advanceRunTo(store: ControlStore, runId: string, target: InterruptedState): void {
  store.transitionRun(runId, "RULES_LOCKED");
  if (target === "RULES_LOCKED") return;
  store.transitionRun(runId, "PROVISIONING");
  if (target === "PROVISIONING") return;
  store.transitionRun(runId, "EVALUATING");
  if (target === "EVALUATING") return;
  store.transitionRun(runId, "AGGREGATING");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return {
    promise,
    resolve: () => {
      if (release === undefined) throw new Error("Deferred promise was not initialized.");
      release();
    },
  };
}

function eventData(stream: string): RunEvent[] {
  return stream
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as RunEvent);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "intentguard-control-"));
const store = new ControlStore(join(temporaryDirectory, "control.sqlite"));
configureEventWriter(store);

try {
  assert.equal(store.getJournalMode().toLowerCase(), "wal");

  const rulesPath = join(temporaryDirectory, "rules.json");
  writeFileSync(rulesPath, JSON.stringify(rules), "utf8");
  assert.deepEqual(await loadRulesFile(rulesPath), rules);
  writeFileSync(rulesPath, "not-json", "utf8");
  await assert.rejects(loadRulesFile(rulesPath), /not valid JSON/u);

  const fakeControlRoot = join(temporaryDirectory, "repository", "apps", "control");
  assert.equal(
    resolveRepositoryPath("forge/rules.json", fakeControlRoot),
    resolve(temporaryDirectory, "repository", "forge", "rules.json"),
  );
  assert.equal(resolveRepositoryPath(rulesPath, fakeControlRoot), resolve(rulesPath));

  const restartPath = join(temporaryDirectory, "restart.sqlite");
  let restartStore: ControlStore | undefined = new ControlStore(restartPath);
  try {
    resetEventWriter();
    configureEventWriter(restartStore);
    restartStore.createRun({
      runId: "RUN-restart-draft",
      snapshotId: "snapshot-smoke",
      corpusVersion: "corpus-smoke",
      policyVersion: "policy-smoke",
      candidateIds: ["legacy", "A"],
    });
    assert.equal(restartStore.claimNextDraftRun(), "RUN-restart-draft");
    const interruptedStates: InterruptedState[] = [
      "RULES_LOCKED",
      "PROVISIONING",
      "EVALUATING",
      "AGGREGATING",
    ];
    for (const state of interruptedStates) {
      const runId = `RUN-restart-${state.toLowerCase()}`;
      restartStore.createRun({
        runId,
        snapshotId: "snapshot-smoke",
        corpusVersion: "corpus-smoke",
        policyVersion: "policy-smoke",
        candidateIds: ["legacy", "A"],
      });
      advanceRunTo(restartStore, runId, state);
    }
    const teardownFailureRunId = "RUN-restart-teardown-failure";
    restartStore.createRun({
      runId: teardownFailureRunId,
      snapshotId: "snapshot-smoke",
      corpusVersion: "corpus-smoke",
      policyVersion: "policy-smoke",
      candidateIds: ["legacy", "A"],
    });
    advanceRunTo(restartStore, teardownFailureRunId, "PROVISIONING");
    restartStore.close();
    restartStore = undefined;

    restartStore = new ControlStore(restartPath);
    resetEventWriter();
    configureEventWriter(restartStore);
    const recoveredTeardowns: string[] = [];
    const recoveryErrors: Array<{ runId: string; error: unknown }> = [];
    const recovery = await reconcileStartupRuns(
      restartStore,
      {
        teardown: async (runId) => {
          recoveredTeardowns.push(runId);
          if (runId === teardownFailureRunId) throw new Error("Daytona credentials unavailable");
          emitEvent(runId, {
            source: "daytona",
            type: "TORN_DOWN",
            message: `Recovered teardown for ${runId}.`,
          });
        },
      },
      (runId, error) => recoveryErrors.push({ runId, error }),
    );
    assert.deepEqual(recovery.releasedDraftRunIds, ["RUN-restart-draft"]);
    assert.equal(restartStore.claimNextDraftRun(), "RUN-restart-draft");
    restartStore.releaseClaim("RUN-restart-draft");
    restartStore.failRun("RUN-restart-draft", "restart claim smoke complete");
    assert.equal(recovery.interruptedRuns.length, interruptedStates.length + 1);
    assert.equal(recoveredTeardowns.length, interruptedStates.length + 1);
    for (const interrupted of recovery.interruptedRuns) {
      assert.equal(restartStore.requireRun(interrupted.runId).state, "BLOCKED");
      assert.equal(restartStore.getVerdict(interrupted.runId)?.outcome, "INCONCLUSIVE");
      assert.match(interrupted.reason, new RegExp(interrupted.previousState, "u"));
      assert.ok(
        restartStore.getCandidates(interrupted.runId)
          .every((candidate) => candidate.status === "ENVIRONMENT_ERROR"),
      );
    }
    assert.equal(recoveryErrors.length, 1);
    assert.equal(recoveryErrors[0]?.runId, teardownFailureRunId);
    assert.match(
      recoveryErrors[0]?.error instanceof Error ? recoveryErrors[0].error.message : "",
      /persisted.+INCONCLUSIVE but teardown failed/u,
    );
    assert.deepEqual(
      restartStore.listEvents(teardownFailureRunId).map((event) => event.type),
      ["VERDICT_READY"],
    );
  } finally {
    restartStore?.close();
    resetEventWriter();
    configureEventWriter(store);
  }

  const legacy = replay("legacy");
  const divergent = replay("A").map((result) => ({
    ...result,
    body: { audit: { rule: "REQ-014" }, approved: false },
  }));
  const compared = compare(legacy, divergent, rules, corpus);
  assert.equal(compared.length, 1);
  assert.equal(compared[0]?.status, "FAIL");
  assert.match(compared[0]?.detail ?? "", /legacy approved=true, candidate approved=false/u);
  const statusMismatch = compare(
    legacy,
    replay("A").map((result) => ({ ...result, status: 403 })),
    rules,
    corpus,
  );
  assert.match(statusMismatch[0]?.detail ?? "", /legacy status=200, candidate status=403/u);

  const inconclusive = decide([], [], {
    candidateIds: ["A"],
    environment: { consistent: false, detail: "snapshot mismatch" },
  });
  assert.equal(inconclusive.outcome, "INCONCLUSIVE");
  const missingReadiness = decide([], [scan("A")], { candidateIds: ["A"], rules });
  assert.equal(missingReadiness.outcome, "BLOCKED");
  assert.match(missingReadiness.perCandidate[0]?.reasons.join("; ") ?? "", /build: gate result missing/u);
  const passingGates = (candidateId: CandidateId) => ([
    { candidateId, key: "build", category: "build" as const, status: "PASS" as const, detail: "ok" },
    { candidateId, key: "health", category: "health" as const, status: "PASS" as const, detail: "ok" },
    {
      candidateId,
      key: "behavior.REQ-014",
      category: "behavior" as const,
      ruleId: "REQ-014",
      inputId: "IN-0001",
      status: "PASS" as const,
      detail: "matched",
    },
  ]);
  const tied = decide(
    [...passingGates("A"), ...passingGates("B")],
    [scan("A"), { ...scan("A"), candidateId: "B" }],
    {
      candidateIds: ["A", "B"],
      rules,
      rawResults: [...replay("A"), ...replay("B")].map((result) => ({ ...result, latencyMs: 10 })),
      commitOrder: ["B", "A"],
    },
  );
  assert.equal(tied.recommended, "B");
  assert.match(tied.perCandidate[0]?.reasons.join("; ") ?? "", /tie-break/u);
  const scannerError = decide(passingGates("A"), [{
    candidateId: "A",
    status: "ERROR",
    findings: [],
    raw: { error: "scanner unavailable" },
  }], { candidateIds: ["A"], rules });
  assert.equal(scannerError.outcome, "BLOCKED");

  const dependencies = buildDependencies(store);
  const unattestedRunId = "RUN-readiness-attestation-smoke";
  store.createRun({
    runId: unattestedRunId,
    snapshotId: "snapshot-smoke",
    corpusVersion: "corpus-smoke",
    policyVersion: "policy-smoke",
    candidateIds: ["legacy", "A"],
  });
  const unattestedSandbox = sandbox(unattestedRunId, "A");
  store.updateCandidate(unattestedRunId, "A", { status: "READY", sandbox: unattestedSandbox });
  const unattestedReadiness = await dependencies.verify(unattestedRunId, unattestedSandbox);
  assert.equal(unattestedReadiness.build.passed, false);
  assert.equal(unattestedReadiness.health.passed, false);
  assert.match(unattestedReadiness.health.detail, /no matching APP_HEALTHY execution evidence/u);
  emitEvent(unattestedRunId, {
    source: "daytona",
    type: "APP_HEALTHY",
    candidateId: "A",
    message: "A is healthy.",
    payload: { previewUrl: unattestedSandbox.previewUrl },
  });
  assert.equal((await dependencies.verify(unattestedRunId, unattestedSandbox)).health.passed, true);
  await assert.rejects(
    dependencies.verify(unattestedRunId, {
      ...unattestedSandbox,
      previewUrl: "http://mutated.smoke.local",
    }),
    /is not the persisted provision result/u,
  );
  store.failRun(unattestedRunId, "readiness attestation smoke complete");

  const readinessFailureRunId = "RUN-readiness-failure-smoke";
  store.createRun({
    runId: readinessFailureRunId,
    snapshotId: "snapshot-smoke",
    corpusVersion: "corpus-smoke",
    policyVersion: "policy-smoke",
    candidateIds: ["legacy", "A"],
  });
  const readinessFailureVerdict = await evaluateRun(readinessFailureRunId, store, {
    ...dependencies,
    provision: async (runId, candidateIds) => candidateIds.map(
      (candidateId) => sandbox(runId, candidateId),
    ),
  });
  assert.equal(readinessFailureVerdict.outcome, "INCONCLUSIVE");
  const failedReadinessGates = store.getGates(readinessFailureRunId);
  assert.deepEqual(
    failedReadinessGates
      .filter((gate) => gate.candidateId === "A")
      .map((gate) => [gate.key, gate.status]),
    [["build", "FAIL"], ["health", "FAIL"]],
  );

  const serverErrors: unknown[] = [];
  const approvalBarriers = new Map<string, Promise<void>>();
  const approvalTeardownFailures = new Set<string>();
  const server = createControlServer({
    store,
    defaults: {
      snapshotId: "snapshot-smoke",
      corpusVersion: "corpus-smoke",
      policyVersion: "policy-smoke",
      candidateIds: ["legacy", "A", "B"],
    },
    loadRules: async () => rules,
    afterApproval: async (runId) => {
      await approvalBarriers.get(runId);
      if (approvalTeardownFailures.has(runId)) {
        throw new Error(`teardown transport failed for ${runId}`);
      }
      await teardownApprovedRun(runId, store, dependencies);
    },
    onError: (error) => serverErrors.push(error),
  });
  const listening = await listenControlServer(server, 0);
  let listeningClosed = false;
  try {
    const health = await fetch(`${listening.url}/health`);
    assert.equal(health.status, 200);

    const teardownFirstRunId = "RUN-teardown-before-verdict-smoke";
    store.createRun({
      runId: teardownFirstRunId,
      snapshotId: "snapshot-smoke",
      corpusVersion: "corpus-smoke",
      policyVersion: "policy-smoke",
      candidateIds: ["legacy", "A"],
    });
    emitEvent(teardownFirstRunId, {
      source: "daytona",
      type: "TORN_DOWN",
      message: "Provisioning failure cleanup completed.",
    });
    emitEvent(teardownFirstRunId, {
      source: "control",
      type: "VERDICT_READY",
      message: "Verdict: INCONCLUSIVE because provisioning failed.",
    });
    const teardownFirstStream = await fetch(
      `${listening.url}/api/runs/${teardownFirstRunId}/events`,
    );
    assert.deepEqual(
      eventData(await teardownFirstStream.text()).map((event) => event.type),
      ["TORN_DOWN", "VERDICT_READY"],
    );
    store.failRun(teardownFirstRunId, "provisioning failed");

    const created = await fetch(`${listening.url}/api/runs`, { method: "POST" });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { runId: string };
    assert.match(createdBody.runId, /^RUN-/u);

    const workerController = new AbortController();
    const workerErrors: Array<{ runId: string; error: unknown }> = [];
    const workerPromise = runWorkerLoop(
      store,
      dependencies,
      workerController.signal,
      (runId, error) => workerErrors.push({ runId, error }),
      { blockingSeverity: "low" },
      1,
    );
    try {
      await waitFor(
        () => store.requireRun(createdBody.runId).state === "AWAITING_APPROVAL",
        "the production-composed worker to claim and evaluate the queued run",
      );
    } finally {
      workerController.abort();
      await workerPromise;
    }
    assert.deepEqual(workerErrors, []);
    assert.equal(getEventListeners(workerController.signal, "abort").length, 0);
    const verdict = store.getVerdict(createdBody.runId);
    assert.ok(verdict !== undefined);
    assert.equal(verdict.outcome, "RECOMMEND");
    assert.equal(verdict.recommended, "A");
    assert.equal(store.requireRun(createdBody.runId).state, "AWAITING_APPROVAL");
    assert.equal(store.listEvents(createdBody.runId).some((event) => event.type === "TORN_DOWN"), false);
    assert.match(
      store.getGates(createdBody.runId).find((gate) => gate.key === "build")?.detail ?? "",
      /execution reached APP_HEALTHY.+after dependency installation/u,
    );
    assert.match(
      store.getGates(createdBody.runId)
        .find((gate) => gate.candidateId === "A" && gate.key === "security")?.detail ?? "",
      /no findings at or above low/u,
    );

    const approvalBarrier = deferred();
    approvalBarriers.set(createdBody.runId, approvalBarrier.promise);
    const approval = await fetch(`${listening.url}/api/runs/${createdBody.runId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "Bryan", comment: "Evidence reviewed." }),
    });
    assert.equal(approval.status, 200);
    const approvalBody = await approval.json() as { digest: string };
    assert.match(approvalBody.digest, /^[0-9a-f]{64}$/u);
    assert.equal(store.requireRun(createdBody.runId).state, "APPROVED");
    assert.equal(approvalIsValid(createdBody.runId, store), true);
    assert.equal(
      store.listEvents(createdBody.runId).some((event) => event.type === "TORN_DOWN"),
      false,
    );
    approvalBarrier.resolve();
    await waitFor(
      () => store.listEvents(createdBody.runId).some((event) => event.type === "TORN_DOWN"),
      "scheduled post-approval teardown",
    );
    const approvedEventCount = store.listEvents(createdBody.runId).length;
    await assert.rejects(
      evaluateRun(createdBody.runId, store, dependencies),
      /expected run.+to be DRAFT, got APPROVED/u,
    );
    assert.equal(store.requireRun(createdBody.runId).state, "APPROVED");
    assert.equal(store.getVerdict(createdBody.runId)?.outcome, "RECOMMEND");
    assert.equal(store.listEvents(createdBody.runId).length, approvedEventCount);

    const duplicateApproval = await fetch(`${listening.url}/api/runs/${createdBody.runId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "Bryan", comment: "Duplicate." }),
    });
    assert.equal(duplicateApproval.status, 409);
    const invalidApproval = await fetch(`${listening.url}/api/runs/${createdBody.runId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "Bryan", comment: "", extra: true }),
    });
    assert.equal(invalidApproval.status, 400);
    assert.equal((await fetch(`${listening.url}/api/runs/RUN-does-not-exist`)).status, 404);

    const streamResponse = await fetch(`${listening.url}/api/runs/${createdBody.runId}/events`);
    assert.equal(streamResponse.status, 200);
    const events = eventData(await streamResponse.text());
    assert.ok(events.length > 10);
    assert.ok(events.every((event, index) => event.seq === index + 1));
    assert.equal(events.filter((event) => event.type === "VERDICT_READY").length, 1);
    assert.equal(events.at(-2)?.type, "APPROVED");
    assert.equal(events.at(-1)?.type, "TORN_DOWN");

    const resumedResponse = await fetch(`${listening.url}/api/runs/${createdBody.runId}/events`, {
      headers: { "last-event-id": String(events.length - 2) },
    });
    const resumed = eventData(await resumedResponse.text());
    assert.deepEqual(resumed.map((event) => event.type), ["APPROVED", "TORN_DOWN"]);

    const jsonReport = await fetch(`${listening.url}/api/runs/${createdBody.runId}/report.json`);
    assert.equal(jsonReport.status, 200);
    const reportBody = await jsonReport.json() as { approvalValid: boolean; currentDigest: string };
    assert.equal(reportBody.approvalValid, true);
    assert.equal(reportBody.currentDigest, approvalBody.digest);

    const markdownReport = await fetch(`${listening.url}/api/runs/${createdBody.runId}/report.md`);
    assert.equal(markdownReport.status, 200);
    assert.match(await markdownReport.text(), /Verdict: \*\*RECOMMEND\*\* candidate \*\*A\*\*/u);

    const failedRunId = "RUN-failure-smoke";
    store.createRun({
      runId: failedRunId,
      snapshotId: "snapshot-smoke",
      corpusVersion: "corpus-smoke",
      policyVersion: "policy-smoke",
      candidateIds: ["legacy", "A"],
    });
    emitEvent(failedRunId, {
      source: "control",
      type: "RUN_QUEUED",
      message: "Failure-path run queued.",
    });
    await assert.rejects(
      evaluateRun(failedRunId, store, {
        ...dependencies,
        loadRules: async () => { throw new Error("Forge artifact unavailable"); },
      }),
      /Forge artifact unavailable/u,
    );
    assert.equal(store.requireRun(failedRunId).state, "BLOCKED");
    assert.equal(store.getVerdict(failedRunId)?.outcome, "INCONCLUSIVE");
    assert.equal(store.listEvents(failedRunId).at(-1)?.type, "TORN_DOWN");
    assert.equal(serverErrors.length, 0);

    const approvalFailureRunId = "RUN-approval-teardown-failure-smoke";
    store.createRun({
      runId: approvalFailureRunId,
      snapshotId: "snapshot-smoke",
      corpusVersion: "corpus-smoke",
      policyVersion: "policy-smoke",
      candidateIds: ["legacy", "A"],
    });
    assert.equal(
      (await evaluateRun(approvalFailureRunId, store, dependencies)).outcome,
      "RECOMMEND",
    );
    approvalTeardownFailures.add(approvalFailureRunId);
    const failedTeardownApproval = await fetch(
      `${listening.url}/api/runs/${approvalFailureRunId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewer: "Laksh", comment: "Failure visibility smoke." }),
      },
    );
    assert.equal(failedTeardownApproval.status, 200);
    await waitFor(() => serverErrors.length === 1, "post-approval teardown error reporting");
    assert.match(
      serverErrors[0] instanceof Error ? serverErrors[0].message : "",
      /Post-approval teardown.+failed/u,
    );
    assert.equal(
      store.listEvents(approvalFailureRunId).some((event) => event.type === "TORN_DOWN"),
      false,
    );

    const degradedRunId = "RUN-degraded-smoke";
    store.createRun({
      runId: degradedRunId,
      snapshotId: "snapshot-smoke",
      corpusVersion: "corpus-smoke",
      policyVersion: "policy-smoke",
      candidateIds: ["legacy", "A"],
    });
    emitEvent(degradedRunId, {
      source: "control",
      type: "RUN_QUEUED",
      message: "Degraded-path run queued.",
    });
    const degradedVerdict = await evaluateRun(degradedRunId, store, {
      ...dependencies,
      scan: async () => { throw new Error("scanner transport failed"); },
    });
    assert.equal(degradedVerdict.outcome, "INCONCLUSIVE");
    assert.equal(store.requireRun(degradedRunId).state, "BLOCKED");

    store.saveGates(createdBody.runId, [{
      candidateId: "A",
      key: "behavior.REQ-014",
      category: "behavior",
      ruleId: "REQ-014",
      inputId: "IN-0001",
      status: "FAIL",
      detail: "evidence changed after approval",
    }]);
    assert.equal(approvalIsValid(createdBody.runId, store), false);

    const shutdownRun = await fetch(`${listening.url}/api/runs`, { method: "POST" });
    const shutdownRunBody = await shutdownRun.json() as { runId: string };
    assert.equal(
      (await evaluateRun(shutdownRunBody.runId, store, dependencies)).outcome,
      "RECOMMEND",
    );
    const shutdownBarrier = deferred();
    approvalBarriers.set(shutdownRunBody.runId, shutdownBarrier.promise);
    const shutdownApproval = await fetch(
      `${listening.url}/api/runs/${shutdownRunBody.runId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewer: "Laksh", comment: "Shutdown tracking smoke." }),
      },
    );
    assert.equal(shutdownApproval.status, 200);

    const openRun = await fetch(`${listening.url}/api/runs`, { method: "POST" });
    const openRunBody = await openRun.json() as { runId: string };
    const openStream = await fetch(`${listening.url}/api/runs/${openRunBody.runId}/events`);
    const drained = openStream.text().catch((error: unknown) => String(error));
    let closeFinished = false;
    const closePromise = listening.close().then(() => {
      closeFinished = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    assert.equal(closeFinished, false);
    shutdownBarrier.resolve();
    await closePromise;
    listeningClosed = true;
    await drained;
    assert.equal(
      store.listEvents(shutdownRunBody.runId).some((event) => event.type === "TORN_DOWN"),
      true,
    );
  } finally {
    if (!listeningClosed) await listening.close();
  }

  console.log("control core smoke passed: persistence, worker, API, SSE, approval, reports, failure recovery");
} finally {
  resetEventWriter();
  store.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
