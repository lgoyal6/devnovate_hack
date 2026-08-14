import type {
  CandidateId,
  GateResult,
  RawResult,
  Rule,
  ScanResult,
  Severity,
  Verdict,
} from "@intentguard/contracts";
import { emitEvent } from "./lib/events.js";

export type PolicyOptions = {
  policyVersion?: string;
  candidateIds?: readonly CandidateId[];
  rules?: readonly Rule[];
  rawResults?: readonly RawResult[];
  commitOrder?: readonly CandidateId[];
  blockingSeverity?: Severity;
  environment?: { consistent: boolean; detail?: string };
};

type CandidateAssessment = {
  candidateId: CandidateId;
  eligible: boolean;
  reasons: string[];
  warnings: number;
  medianLatency: number;
  commitIndex: number;
};

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const current = sorted[middle];
  if (current === undefined) return Number.POSITIVE_INFINITY;
  if (sorted.length % 2 === 1) return current;
  const previous = sorted[middle - 1];
  return previous === undefined ? current : (previous + current) / 2;
}

function compareFiniteMetric(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function candidateIdsFrom(
  gates: readonly GateResult[],
  scans: readonly ScanResult[],
  configured: readonly CandidateId[] | undefined,
): CandidateId[] {
  const ids = configured === undefined
    ? [...new Set([...gates.map((gate) => gate.candidateId), ...scans.map((scan) => scan.candidateId)])]
    : [...configured];
  if (ids.length === 0) throw new Error("Policy evaluation requires at least one candidate.");
  if (new Set(ids).size !== ids.length) throw new Error("Policy candidate IDs must be unique.");
  return ids;
}

function blockingBehaviorRule(gate: GateResult, rules: readonly Rule[]): boolean {
  if (gate.ruleId === undefined) return true;
  return rules.find((rule) => rule.id === gate.ruleId)?.blocking ?? true;
}

/** Pure deterministic policy. No database, network, clock, or model call. */
export function decide(
  gates: readonly GateResult[],
  scans: readonly ScanResult[],
  options: PolicyOptions = {},
): Verdict {
  const policyVersion = options.policyVersion ?? "policy-1";
  const candidateIds = candidateIdsFrom(gates, scans, options.candidateIds);
  const rules = options.rules ?? [];
  const rawResults = options.rawResults ?? [];
  const blockingSeverity = options.blockingSeverity ?? "high";
  const commitOrder = options.commitOrder ?? candidateIds;

  if (options.environment?.consistent === false) {
    const detail = options.environment.detail ?? "snapshot, corpus, or policy versions differ";
    return {
      outcome: "INCONCLUSIVE",
      recommended: null,
      perCandidate: candidateIds.map((candidateId) => ({
        candidateId,
        eligible: false,
        reasons: [`environment: ${detail}`],
      })),
      policyVersion,
    };
  }

  const assessments: CandidateAssessment[] = candidateIds.map((candidateId) => {
    const candidateGates = gates.filter((gate) => gate.candidateId === candidateId);
    const candidateScans = scans.filter((item) => item.candidateId === candidateId);
    if (candidateScans.length > 1) throw new Error(`Candidate ${candidateId} has duplicate scan results.`);
    const scan = candidateScans[0];
    const reasons: string[] = [];
    let warnings = 0;

    for (const category of ["build", "health"] as const) {
      if (!candidateGates.some((gate) => gate.category === category)) {
        reasons.push(`${category}: gate result missing`);
      }
    }
    for (const rule of rules.filter((item) => item.blocking)) {
      if (!candidateGates.some((gate) => gate.category === "behavior" && gate.ruleId === rule.id)) {
        reasons.push(`behavior: blocking rule ${rule.id} has no gate result`);
      }
    }

    for (const gate of candidateGates) {
      if (gate.status !== "FAIL") continue;
      const blocking =
        gate.category === "build"
        || gate.category === "health"
        || gate.category === "security"
        || (gate.category === "behavior" && blockingBehaviorRule(gate, rules));
      if (blocking) reasons.push(`${gate.category}: ${gate.detail}`);
      else warnings += 1;
    }

    if (scan === undefined) {
      reasons.push("security: scan result missing");
    } else if (scan.status === "ERROR") {
      reasons.push("security: scanner returned ERROR");
    } else {
      for (const finding of scan.findings) {
        if (SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[blockingSeverity]) {
          reasons.push(
            `security: ${finding.severity} ${finding.id} in ${finding.file}:${String(finding.line)} is at or above the ${blockingSeverity} blocking severity`,
          );
        } else {
          warnings += 1;
        }
      }
    }

    const latencies = rawResults
      .filter((result) => result.candidateId === candidateId)
      .map((result) => result.latencyMs)
      .filter(Number.isFinite);
    const commitIndex = commitOrder.indexOf(candidateId);
    return {
      candidateId,
      eligible: reasons.length === 0,
      reasons: [...new Set(reasons)],
      warnings,
      medianLatency: median(latencies),
      commitIndex: commitIndex === -1 ? Number.MAX_SAFE_INTEGER : commitIndex,
    };
  });

  const eligible = assessments.filter((assessment) => assessment.eligible);
  if (eligible.length === 0) {
    return {
      outcome: "BLOCKED",
      recommended: null,
      perCandidate: assessments.map(({ candidateId, eligible: isEligible, reasons }) => ({
        candidateId,
        eligible: isEligible,
        reasons,
      })),
      policyVersion,
    };
  }

  eligible.sort((left, right) =>
    left.warnings - right.warnings
    || compareFiniteMetric(left.medianLatency, right.medianLatency)
    || left.commitIndex - right.commitIndex
    || left.candidateId.localeCompare(right.candidateId),
  );
  const recommended = eligible[0];
  if (recommended === undefined) throw new Error("Policy could not select an eligible candidate.");

  if (eligible.length > 1) {
    const tieDetail = `tie-break: ${String(eligible.length)} candidates were eligible; selected ${recommended.candidateId} by warnings, median latency, then commit order`;
    for (const assessment of eligible) assessment.reasons.push(tieDetail);
  }

  return {
    outcome: "RECOMMEND",
    recommended: recommended.candidateId,
    perCandidate: assessments.map(({ candidateId, eligible: isEligible, reasons }) => ({
      candidateId,
      eligible: isEligible,
      reasons,
    })),
    policyVersion,
  };
}

/** Persist first, then emit. The caller may safely invoke narration afterward. */
export function decideRun(
  runId: string,
  gates: readonly GateResult[],
  scans: readonly ScanResult[],
  options: PolicyOptions,
  persist: (verdict: Verdict) => void,
  beforeEmit?: (verdict: Verdict) => void,
): Verdict {
  const verdict = decide(gates, scans, options);
  persist(verdict);
  beforeEmit?.(verdict);
  emitEvent(runId, {
    source: "control",
    type: "VERDICT_READY",
    message: verdict.outcome === "RECOMMEND"
      ? `Verdict: RECOMMEND candidate ${verdict.recommended ?? "<missing>"}.`
      : `Verdict: ${verdict.outcome}.`,
    payload: verdict,
  });
  return verdict;
}
