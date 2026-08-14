/**
 * apps/control/src/mock-run.ts
 *
 * A runnable fake of a complete IntentGuard run. Not a JSON blob: it emits the
 * whole event sequence with realistic delays, four sandboxes (legacy plus
 * candidates A, B and C), one behavioral divergence on REQ-014, one Snyk block,
 * a verdict, and an approval.
 *
 * The event shapes in this file are the canonical wire format. Every real
 * module must match them. Bryan builds the entire interface against a live
 * stream from here, so integration means deleting this file, not rewriting the
 * UI.
 *
 * Two things are scripted rather than computed, because this is a fixture for
 * the wire format and not a simulation of the product:
 *
 *   - The divergence is pinned to input IN-0042 at 500.49 so the projector
 *     string matches the demo script. Real numbers come from Bryan's candidates.
 *   - Candidate B carries a critical Snyk finding so the security gate is
 *     exercised. Real findings come from Neel's adapter.
 *
 * Everything else, including the approval digest, is computed the same way the
 * real control plane computes it.
 */
import type {
  ApprovalRecord,
  CandidateId,
  CandidateRecord,
  CorpusInput,
  EvidenceBundle,
  GateResult,
  RawResult,
  Rule,
  RunEvent,
  RunSnapshot,
  SandboxRef,
  ScanResult,
  Verdict,
} from "@intentguard/contracts";
import { digestEvidence } from "./lib/evidence.js";

export const MOCK_POLICY_VERSION = "policy-1";
export const MOCK_CORPUS_VERSION = "corpus-1";
export const MOCK_SNAPSHOT_ID = "snap-legacy-refunds-4f1c";

/** Findings at or above this severity make a candidate ineligible. */
const BLOCKING_SEVERITY = "high";

const CANDIDATE_IDS: CandidateId[] = ["A", "B", "C"];
const ALL_SANDBOX_IDS: CandidateId[] = ["legacy", ...CANDIDATE_IDS];

const COMMITS: Record<CandidateId, string> = {
  legacy: "8d3a91c",
  A: "b21f04e",
  B: "5c7ae82",
  C: "e0946ad",
};

// ---------------------------------------------------------------------------
// Recovered rules
// ---------------------------------------------------------------------------

export const MOCK_RULES: Rule[] = [
  {
    id: "REQ-011",
    title: "Refunds require an open order",
    behavior: "A refund against an order that is already closed is rejected with 409.",
    boundaries: ["open", "closed"],
    blocking: true,
  },
  {
    id: "REQ-012",
    title: "Partial refunds cannot exceed the remaining balance",
    behavior:
      "The sum of all refunds on an order may never exceed the amount captured on it.",
    boundaries: ["0.00", "remaining", "remaining+0.01"],
    blocking: true,
  },
  {
    id: "REQ-013",
    title: "Refunds on suspended accounts are rejected",
    behavior: "An account in SUSPENDED state cannot receive a refund, regardless of amount.",
    boundaries: ["ACTIVE", "SUSPENDED", "CLOSED"],
    blocking: true,
  },
  {
    id: "REQ-014",
    title: "Refunds of 500.00 or more require manager approval",
    behavior:
      "A refund of 500.00 or more is held for manager approval and returns approved=false. Below 500.00 it is auto approved.",
    boundaries: ["499.99", "500.00", "500.49", "500.99", "501.00"],
    blocking: true,
  },
  {
    id: "REQ-015",
    title: "Duplicate refund requests are idempotent for 24 hours",
    behavior:
      "The same idempotency key replayed within 24 hours returns the original refund rather than issuing a second one.",
    boundaries: ["0h", "23h59m", "24h01m"],
    blocking: false,
  },
];

// ---------------------------------------------------------------------------
// Corpus, generated from the rule boundaries rather than by fuzzing.
// Random inputs never find REQ-014.
// ---------------------------------------------------------------------------

const REFUND_AMOUNTS = ["499.99", "500.00", "500.49", "500.99", "501.00"] as const;

export const MOCK_CORPUS: CorpusInput[] = [
  {
    id: "IN-0011",
    ruleId: "REQ-011",
    method: "POST",
    path: "/refunds",
    payload: { orderId: "ORD-9001", orderState: "closed", amount: "25.00" },
  },
  {
    id: "IN-0012",
    ruleId: "REQ-012",
    method: "POST",
    path: "/refunds",
    payload: { orderId: "ORD-9002", captured: "80.00", alreadyRefunded: "80.00", amount: "0.01" },
  },
  {
    id: "IN-0013",
    ruleId: "REQ-013",
    method: "POST",
    path: "/refunds",
    payload: { orderId: "ORD-9003", accountState: "SUSPENDED", amount: "10.00" },
  },
  ...REFUND_AMOUNTS.map((amount, i) => ({
    id: `IN-004${i}`,
    ruleId: "REQ-014",
    method: "POST" as const,
    path: "/refunds",
    payload: { orderId: `ORD-91${i}0`, accountState: "ACTIVE", amount },
  })),
  {
    id: "IN-0015",
    ruleId: "REQ-015",
    method: "POST",
    path: "/refunds",
    payload: { orderId: "ORD-9005", idempotencyKey: "idem-77c1", replayedAfter: "23h59m", amount: "12.00" },
  },
];

/** IN-0040=499.99, IN-0041=500.00, IN-0042=500.49, IN-0043=500.99, IN-0044=501.00 */
const DIVERGENCE = {
  candidateId: "C",
  inputId: "IN-0042",
  ruleId: "REQ-014",
  detail:
    "input IN-0042 (refund 500.49): legacy approved=false, candidate approved=true",
} as const;

// ---------------------------------------------------------------------------
// Sandboxes
// ---------------------------------------------------------------------------

function sandboxFor(candidateId: CandidateId, createdAt: string): SandboxRef {
  return {
    candidateId,
    sandboxId: `dt-${candidateId.toLowerCase()}-3f${COMMITS[candidateId]?.slice(0, 4) ?? "0000"}`,
    snapshotId: MOCK_SNAPSHOT_ID,
    commitSha: COMMITS[candidateId] ?? "0000000",
    previewUrl: `https://${candidateId.toLowerCase()}-3f8c.preview.daytona.works`,
    createdAt,
  };
}

// ---------------------------------------------------------------------------
// Replay results
// ---------------------------------------------------------------------------

/** Legacy behavior for REQ-014: 500.00 and above is held for manager approval. */
function legacyApproves(amount: string): boolean {
  return Number(amount) < 500;
}

function bodyFor(candidateId: CandidateId, input: CorpusInput): unknown {
  if (input.ruleId === "REQ-014") {
    const amount = String(input.payload["amount"]);
    const diverges =
      candidateId === DIVERGENCE.candidateId && input.id === DIVERGENCE.inputId;
    const approved = diverges ? true : legacyApproves(amount);
    return {
      refundId: `RF-${input.id.slice(3)}`,
      amount,
      approved,
      requiresManagerApproval: !approved,
    };
  }

  switch (input.ruleId) {
    case "REQ-011":
      return { error: "order_closed", refundId: null };
    case "REQ-012":
      return { error: "exceeds_remaining_balance", refundId: null };
    case "REQ-013":
      return { error: "account_suspended", refundId: null };
    default:
      return { refundId: "RF-0015", replayed: true, approved: true };
  }
}

function statusFor(input: CorpusInput): number {
  switch (input.ruleId) {
    case "REQ-011":
      return 409;
    case "REQ-012":
    case "REQ-013":
      return 422;
    default:
      return 200;
  }
}

/** Deterministic, so the smoke test and Bryan's UI see the same numbers every run. */
function latencyFor(candidateId: CandidateId, index: number): number {
  const base = candidateId === "legacy" ? 74 : 31;
  return base + ((index * 13) % 29);
}

function resultsFor(candidateId: CandidateId): RawResult[] {
  return MOCK_CORPUS.map((input, index) => ({
    candidateId,
    inputId: input.id,
    status: statusFor(input),
    body: bodyFor(candidateId, input),
    latencyMs: latencyFor(candidateId, index),
  }));
}

export const MOCK_RAW_RESULTS: RawResult[] = ALL_SANDBOX_IDS.flatMap(resultsFor);

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

export const MOCK_SCANS: ScanResult[] = [
  { candidateId: "A", status: "CLEAN", findings: [], raw: { ok: true, projectId: "snyk-a" } },
  {
    candidateId: "B",
    status: "FINDINGS",
    findings: [
      {
        id: "SNYK-JS-CHILDPROCESS-2841",
        severity: "critical",
        title: "Command injection via unsanitised refund reference in child_process.exec",
        file: "src/routes/refund.ts",
        line: 88,
      },
      {
        id: "SNYK-JS-SEMVER-3247",
        severity: "medium",
        title: "Regular expression denial of service in semver",
        file: "package.json",
        line: 21,
      },
    ],
    raw: { ok: true, projectId: "snyk-b" },
  },
  { candidateId: "C", status: "CLEAN", findings: [], raw: { ok: true, projectId: "snyk-c" } },
];

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function blockingFindings(scan: ScanResult) {
  const threshold = SEVERITY_RANK[BLOCKING_SEVERITY] ?? 2;
  return scan.findings.filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= threshold);
}

function buildGates(): GateResult[] {
  const gates: GateResult[] = [];

  for (const candidateId of CANDIDATE_IDS) {
    gates.push({
      candidateId,
      key: "build",
      category: "build",
      status: "PASS",
      detail: `candidate ${candidateId} built from commit ${COMMITS[candidateId]}`,
    });

    gates.push({
      candidateId,
      key: "health",
      category: "health",
      status: "PASS",
      detail: `candidate ${candidateId} answered GET /health with 200`,
    });

    for (const rule of MOCK_RULES) {
      const diverged =
        candidateId === DIVERGENCE.candidateId && rule.id === DIVERGENCE.ruleId;
      const probes = MOCK_CORPUS.filter((input) => input.ruleId === rule.id).length;

      gates.push({
        candidateId,
        key: `behavior.${rule.id}`,
        category: "behavior",
        ruleId: rule.id,
        status: diverged ? "FAIL" : "PASS",
        detail: diverged
          ? DIVERGENCE.detail
          : `${probes} boundary input${probes === 1 ? "" : "s"} matched legacy exactly`,
        ...(diverged ? { inputId: DIVERGENCE.inputId } : {}),
      });
    }

    const scan = MOCK_SCANS.find((s) => s.candidateId === candidateId);
    if (!scan) {
      throw new Error(`mock is inconsistent: no scan for candidate ${candidateId}`);
    }
    const blocking = blockingFindings(scan);
    gates.push({
      candidateId,
      key: "security",
      category: "security",
      status: scan.status === "ERROR" || blocking.length > 0 ? "FAIL" : "PASS",
      detail:
        scan.status === "ERROR"
          ? "scanner returned ERROR, failing closed"
          : blocking.length > 0
            ? `${blocking[0]?.severity} ${blocking[0]?.id} in ${blocking[0]?.file}:${blocking[0]?.line} is at or above the ${BLOCKING_SEVERITY} blocking severity`
            : `no findings at or above ${BLOCKING_SEVERITY}`,
    });
  }

  return gates;
}

export const MOCK_GATES: GateResult[] = buildGates();

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function buildVerdict(): Verdict {
  const perCandidate = CANDIDATE_IDS.map((candidateId) => {
    const reasons: string[] = [];

    for (const gate of MOCK_GATES) {
      if (gate.candidateId !== candidateId || gate.status !== "FAIL") continue;
      const rule = MOCK_RULES.find((r) => r.id === gate.ruleId);
      if (gate.category === "behavior" && rule && !rule.blocking) continue;
      reasons.push(`${gate.category}: ${gate.detail}`);
    }

    return { candidateId, eligible: reasons.length === 0, reasons };
  });

  const eligible = perCandidate.filter((c) => c.eligible);

  return {
    outcome: eligible.length === 1 ? "RECOMMEND" : eligible.length === 0 ? "BLOCKED" : "RECOMMEND",
    recommended: eligible[0]?.candidateId ?? null,
    perCandidate,
    policyVersion: MOCK_POLICY_VERSION,
  };
}

export const MOCK_VERDICT: Verdict = buildVerdict();

export const MOCK_NARRATION =
  "Candidate A is the only rewrite that reproduces the legacy system's behavior on every blocking rule and carries no security finding at or above high. " +
  "Candidate C auto approves a 500.49 refund that the legacy system holds for manager approval, which is REQ-014, a rule nobody had written down. " +
  "Candidate B is functionally correct but ships a critical command injection in its refund route. Recommend A.";

// ---------------------------------------------------------------------------
// Event sequence
// ---------------------------------------------------------------------------

type Timed = Omit<RunEvent, "seq" | "ts"> & { delayMs: number };

function timedEvents(runId: string, createdAt: string): Timed[] {
  const events: Timed[] = [];

  events.push({
    delayMs: 0,
    source: "control",
    type: "RUN_QUEUED",
    message: `Run ${runId} queued: 3 candidates against the legacy baseline.`,
    payload: {
      snapshotId: MOCK_SNAPSHOT_ID,
      corpusVersion: MOCK_CORPUS_VERSION,
      policyVersion: MOCK_POLICY_VERSION,
      candidateIds: CANDIDATE_IDS,
    },
  });

  events.push({
    delayMs: 700,
    source: "forge",
    type: "RULES_LOCKED",
    message: `${MOCK_RULES.length} business rules recovered from the legacy source and locked.`,
    payload: { rules: MOCK_RULES, corpusSize: MOCK_CORPUS.length },
  });

  const provisionDelays = [900, 300, 250, 280];
  ALL_SANDBOX_IDS.forEach((candidateId, i) => {
    events.push({
      delayMs: provisionDelays[i] ?? 300,
      source: "daytona",
      type: "SANDBOX_CREATED",
      candidateId,
      message: `Sandbox created for ${candidateId} from snapshot ${MOCK_SNAPSHOT_ID}.`,
      payload: sandboxFor(candidateId, createdAt),
    });
  });

  const sourceDelays = [1200, 400, 350, 380];
  ALL_SANDBOX_IDS.forEach((candidateId, i) => {
    events.push({
      delayMs: sourceDelays[i] ?? 400,
      source: "daytona",
      type: "SOURCE_READY",
      candidateId,
      message: `Source at ${COMMITS[candidateId]} checked out and installed in ${candidateId}.`,
      payload: { commitSha: COMMITS[candidateId] },
    });
  });

  const healthDelays = [1500, 700, 650, 720];
  ALL_SANDBOX_IDS.forEach((candidateId, i) => {
    events.push({
      delayMs: healthDelays[i] ?? 700,
      source: "daytona",
      type: "APP_HEALTHY",
      candidateId,
      message: `${candidateId} answered GET /health with 200.`,
      payload: { previewUrl: sandboxFor(candidateId, createdAt).previewUrl },
    });
  });

  const scanDelays = [1100, 800, 600];
  CANDIDATE_IDS.forEach((candidateId, i) => {
    const scan = MOCK_SCANS.find((s) => s.candidateId === candidateId);
    if (!scan) throw new Error(`mock is inconsistent: no scan for candidate ${candidateId}`);
    events.push({
      delayMs: scanDelays[i] ?? 800,
      source: "snyk",
      type: "SCAN_COMPLETE",
      candidateId,
      message:
        scan.status === "CLEAN"
          ? `Snyk found no issues in ${candidateId}.`
          : `Snyk found ${scan.findings.length} issues in ${candidateId}, highest severity ${scan.findings[0]?.severity}.`,
      payload: scan,
    });
  });

  const replayDelays = [1400, 900, 850, 880];
  ALL_SANDBOX_IDS.forEach((candidateId, i) => {
    events.push({
      delayMs: replayDelays[i] ?? 900,
      source: "control",
      type: "CORPUS_REPLAYED",
      candidateId,
      message: `Replayed ${MOCK_CORPUS.length} corpus inputs against ${candidateId}.`,
      payload: { results: resultsFor(candidateId) },
    });
  });

  events.push({
    delayMs: 500,
    source: "control",
    type: "DIVERGENCE_FOUND",
    candidateId: DIVERGENCE.candidateId,
    message: DIVERGENCE.detail,
    payload: {
      ruleId: DIVERGENCE.ruleId,
      inputId: DIVERGENCE.inputId,
      blocking: MOCK_RULES.find((r) => r.id === DIVERGENCE.ruleId)?.blocking ?? true,
    },
  });

  for (const gate of MOCK_GATES) {
    events.push({
      delayMs: 90,
      source: "control",
      type: "GATE_RESULT",
      candidateId: gate.candidateId,
      message: `${gate.status} ${gate.key} for ${gate.candidateId}: ${gate.detail}`,
      payload: gate,
    });
  }

  events.push({
    delayMs: 700,
    source: "control",
    type: "VERDICT_READY",
    message:
      MOCK_VERDICT.outcome === "RECOMMEND"
        ? `Verdict: RECOMMEND candidate ${MOCK_VERDICT.recommended}.`
        : `Verdict: ${MOCK_VERDICT.outcome}.`,
    payload: MOCK_VERDICT,
  });

  events.push({
    delayMs: 1600,
    source: "rocketride",
    type: "NARRATED",
    message: "Narration generated from the stored verdict and gates.",
    payload: { narration: MOCK_NARRATION },
  });

  events.push({
    delayMs: 2500,
    source: "control",
    type: "APPROVED",
    message: `Approved by ${mockApproval(runId, createdAt).reviewer}, bound to evidence digest ${mockApproval(runId, createdAt).digest.slice(0, 12)}.`,
    payload: mockApproval(runId, createdAt),
  });

  events.push({
    delayMs: 900,
    source: "daytona",
    type: "TORN_DOWN",
    message: `All ${ALL_SANDBOX_IDS.length} sandboxes torn down.`,
    payload: { sandboxCount: ALL_SANDBOX_IDS.length },
  });

  return events;
}

// ---------------------------------------------------------------------------
// Evidence and approval
// ---------------------------------------------------------------------------

export function mockEvidenceBundle(runId: string): EvidenceBundle {
  return {
    runId,
    policyVersion: MOCK_POLICY_VERSION,
    rules: MOCK_RULES,
    corpus: MOCK_CORPUS,
    rawResults: MOCK_RAW_RESULTS,
    scans: MOCK_SCANS,
    gates: MOCK_GATES,
    verdict: MOCK_VERDICT,
  };
}

function mockApproval(runId: string, approvedAt: string): ApprovalRecord {
  return {
    runId,
    reviewer: "laksh",
    comment: "Reviewed the REQ-014 divergence and the B finding. Shipping A.",
    approvedAt,
    policyVersion: MOCK_POLICY_VERSION,
    digest: digestEvidence(mockEvidenceBundle(runId)),
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type MockRun = {
  events: RunEvent[];
  snapshot: RunSnapshot;
  /** Wall clock milliseconds the streamed version takes end to end at speed 1. */
  durationMs: number;
};

/**
 * The whole run with no delays applied. `startedAt` is exposed so tests and
 * repeated demo runs produce byte identical output.
 */
export function buildMockRun(runId: string, startedAt = Date.now()): MockRun {
  const createdAt = new Date(startedAt).toISOString();
  const timed = timedEvents(runId, createdAt);

  let elapsed = 0;
  const events: RunEvent[] = timed.map((event, i) => {
    const { delayMs, ...rest } = event;
    elapsed += delayMs;
    return { seq: i + 1, ts: new Date(startedAt + elapsed).toISOString(), ...rest };
  });

  const candidates: CandidateRecord[] = CANDIDATE_IDS.map((candidateId) => {
    const entry = MOCK_VERDICT.perCandidate.find((c) => c.candidateId === candidateId);
    return {
      candidateId,
      status: entry?.eligible ? "PASSED" : "FAILED",
      failureReason: entry?.eligible ? null : (entry?.reasons[0] ?? "ineligible"),
      sandbox: sandboxFor(candidateId, createdAt),
    };
  });

  const snapshot: RunSnapshot = {
    run: {
      runId,
      state: "APPROVED",
      createdAt,
      updatedAt: new Date(startedAt + elapsed).toISOString(),
      snapshotId: MOCK_SNAPSHOT_ID,
      corpusVersion: MOCK_CORPUS_VERSION,
      policyVersion: MOCK_POLICY_VERSION,
    },
    candidates,
    gates: MOCK_GATES,
    scans: MOCK_SCANS,
    verdict: MOCK_VERDICT,
    narration: MOCK_NARRATION,
    approval: mockApproval(runId, createdAt),
  };

  return { events, snapshot, durationMs: elapsed };
}

/**
 * The same sequence, yielded with realistic delays. This is what the SSE route
 * pipes and what Bryan builds against.
 *
 * `speed` divides every delay: speed 4 replays the run four times faster, which
 * is what you want on the fiftieth iteration of a UI change.
 */
export async function* streamMockRun(
  runId: string,
  options: { speed?: number; startedAt?: number } = {},
): AsyncGenerator<RunEvent> {
  const speed = options.speed && options.speed > 0 ? options.speed : 1;
  const startedAt = options.startedAt ?? Date.now();
  const createdAt = new Date(startedAt).toISOString();
  const timed = timedEvents(runId, createdAt);

  // ts is stamped from the scaled schedule, not the nominal one, so a client
  // computing elapsed time from ts agrees with when the event actually arrived.
  let elapsed = 0;
  for (let i = 0; i < timed.length; i += 1) {
    const step = timed[i];
    if (!step) continue;
    const { delayMs, ...rest } = step;
    const delay = delayMs / speed;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    elapsed += delay;
    yield { seq: i + 1, ts: new Date(startedAt + elapsed).toISOString(), ...rest };
  }
}
