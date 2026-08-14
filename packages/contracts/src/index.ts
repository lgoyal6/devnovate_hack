/**
 * IntentGuard shared contracts.
 *
 * Owner: Laksh. Frozen after hour 0. Changes only by announcement to Neel and Bryan.
 * These types are the only interface between the three workstreams. If you need
 * something from another module, import its type from here; do not reach around
 * the owner.
 *
 * Type-only module. It must never gain a runtime value, so that importing it
 * from a browser bundle, a worker, or a script costs nothing.
 */

// ---------------------------------------------------------------------------
// Recovered intent
// ---------------------------------------------------------------------------

/**
 * A business rule recovered from the legacy source by Forge.
 * Laksh commits the canonical set to forge/rules.json.
 */
export type Rule = {
  /** "REQ-014" */
  id: string;
  title: string;
  /** Plain English, written to be read off a projector. */
  behavior: string;
  /** Values that probe this rule: ["499.99", "500.00", "500.49"] */
  boundaries: string[];
  /** A behavioral divergence on a blocking rule makes a candidate ineligible. */
  blocking: boolean;
};

/** One request in the generated corpus. Bryan generates these from Rule.boundaries. */
export type CorpusInput = {
  /** "IN-0042" */
  id: string;
  /** Which rule this input probes. */
  ruleId: string;
  method: "GET" | "POST";
  path: string;
  payload: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** "legacy" is the baseline. "A" | "B" | "C" are the candidate rewrites. */
export type CandidateId = string;

export type SandboxRef = {
  candidateId: CandidateId;
  sandboxId: string;
  snapshotId: string;
  commitSha: string;
  previewUrl: string;
  createdAt: string;
};

/** One replayed corpus input against one candidate. */
export type RawResult = {
  candidateId: CandidateId;
  inputId: string;
  status: number;
  body: unknown;
  latencyMs: number;
};

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export type Severity = "low" | "medium" | "high" | "critical";

export type Finding = {
  id: string;
  severity: Severity;
  title: string;
  file: string;
  line: number;
};

export type ScanResult = {
  candidateId: CandidateId;
  /** ERROR is a failure, not a pass. The policy engine fails closed on it. */
  status: "CLEAN" | "FINDINGS" | "ERROR";
  findings: Finding[];
  raw: unknown;
};

// ---------------------------------------------------------------------------
// Adjudication
// ---------------------------------------------------------------------------

export type GateCategory = "build" | "health" | "behavior" | "security";

export type GateResult = {
  candidateId: CandidateId;
  /** "behavior.REQ-014" */
  key: string;
  category: GateCategory;
  ruleId?: string;
  status: "PASS" | "FAIL";
  /**
   * Human readable, rendered on a projector during the demo.
   * "input IN-0042 (refund 500.49): legacy approved=false, candidate approved=true"
   */
  detail: string;
  inputId?: string;
};

export type Verdict = {
  outcome: "RECOMMEND" | "BLOCKED" | "INCONCLUSIVE";
  /** Set only when outcome is RECOMMEND. */
  recommended: CandidateId | null;
  perCandidate: {
    candidateId: CandidateId;
    eligible: boolean;
    reasons: string[];
  }[];
  policyVersion: string;
};

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

/**
 * The one and only state machine, at run level.
 * DRAFT -> RULES_LOCKED -> PROVISIONING -> EVALUATING -> AGGREGATING
 *       -> AWAITING_APPROVAL -> APPROVED | BLOCKED
 *
 * Candidates do not get a second state machine. They get a status string and a
 * failure reason.
 */
export type RunState =
  | "DRAFT"
  | "RULES_LOCKED"
  | "PROVISIONING"
  | "EVALUATING"
  | "AGGREGATING"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "BLOCKED";

export type CandidateStatus =
  | "PENDING"
  | "PROVISIONING"
  | "READY"
  | "REPLAYED"
  | "PASSED"
  | "FAILED"
  | "ENVIRONMENT_ERROR";

export type CandidateRecord = {
  candidateId: CandidateId;
  status: CandidateStatus;
  /** Populated when status is FAILED or ENVIRONMENT_ERROR, null otherwise. */
  failureReason: string | null;
  sandbox: SandboxRef | null;
};

export type RunRecord = {
  runId: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  snapshotId: string;
  corpusVersion: string;
  policyVersion: string;
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * The platform responsible for the event. Not decoration: Bryan tags each
 * timeline row with it so a judge sees their own product doing work in real
 * time rather than taking our word for it in a slide.
 */
export type EventSource = "forge" | "daytona" | "snyk" | "rocketride" | "control";

export type RunEventType =
  | "RUN_QUEUED"
  | "RULES_LOCKED"
  | "SANDBOX_CREATED"
  | "SOURCE_READY"
  | "SCAN_COMPLETE"
  | "APP_HEALTHY"
  | "CORPUS_REPLAYED"
  | "DIVERGENCE_FOUND"
  | "GATE_RESULT"
  | "VERDICT_READY"
  | "NARRATED"
  | "APPROVED"
  | "TORN_DOWN";

/**
 * Append-only, monotonic `seq`. Bryan renders from seq order, never from
 * arrival order.
 *
 * Every module emits its own events. Each exported function takes runId as its
 * first argument and calls emitEvent(runId, ...) itself. Neel's adapter emits
 * SANDBOX_CREATED, not Laksh's worker on Neel's behalf.
 */
export type RunEvent = {
  seq: number;
  /** ISO 8601. */
  ts: string;
  source: EventSource;
  type: RunEventType;
  candidateId?: CandidateId;
  message: string;
  payload?: unknown;
};

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

/** POST /api/runs */
export type CreateRunResponse = { runId: string };

/** GET /api/runs/:id */
export type RunSnapshot = {
  run: RunRecord;
  candidates: CandidateRecord[];
  gates: GateResult[];
  scans: ScanResult[];
  verdict: Verdict | null;
  narration: string | null;
  approval: ApprovalRecord | null;
};

/**
 * Approval binds to a SHA-256 digest over the canonicalised evidence bundle:
 * rules, corpus, all raw results, all scan results, all gates, and the verdict.
 * A later change to any evidence invalidates the approval.
 */
export type ApprovalRecord = {
  runId: string;
  reviewer: string;
  comment: string;
  approvedAt: string;
  policyVersion: string;
  /** Lowercase hex SHA-256. */
  digest: string;
};

/** POST /api/runs/:id/approve, body: { reviewer, comment } */
export type ApproveRequest = { reviewer: string; comment: string };
export type ApproveResponse = { digest: string };

/** The exact bytes the digest is taken over. Canonicalised: sorted keys, no whitespace. */
export type EvidenceBundle = {
  runId: string;
  policyVersion: string;
  rules: Rule[];
  corpus: CorpusInput[];
  rawResults: RawResult[];
  scans: ScanResult[];
  gates: GateResult[];
  verdict: Verdict;
};
