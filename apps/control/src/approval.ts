import type { ApprovalRecord, ApproveRequest, ApproveResponse } from "@intentguard/contracts";
import { emitEvent } from "./lib/events.js";
import { digestEvidence } from "./lib/evidence.js";
import type { ControlStore } from "./lib/store.js";

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} is required.`);
  return normalized;
}

export function approveRun(
  runId: string,
  request: ApproveRequest,
  store: ControlStore,
  approvedAt = new Date().toISOString(),
): ApproveResponse {
  const reviewer = requiredText(request.reviewer, "reviewer");
  const comment = requiredText(request.comment, "comment");
  const evidence = store.getEvidenceBundle(runId);
  if (evidence.verdict.outcome !== "RECOMMEND" || evidence.verdict.recommended === null) {
    throw new Error(`Run ${runId} does not have a recommendation that can be approved.`);
  }
  const digest = digestEvidence(evidence);
  const approval: ApprovalRecord = {
    runId,
    reviewer,
    comment,
    approvedAt,
    policyVersion: evidence.policyVersion,
    digest,
  };
  store.recordApproval(approval);
  emitEvent(runId, {
    source: "control",
    type: "APPROVED",
    message: `Approved by ${reviewer}, bound to evidence digest ${digest.slice(0, 12)}.`,
    payload: approval,
  });
  return { digest };
}

export function approvalIsValid(runId: string, store: ControlStore): boolean {
  const approval = store.getApproval(runId);
  if (approval === undefined) return false;
  return approval.digest === digestEvidence(store.getEvidenceBundle(runId));
}
