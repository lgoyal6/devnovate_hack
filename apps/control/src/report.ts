import type {
  ApprovalRecord,
  CandidateRecord,
  EvidenceBundle,
  RunRecord,
} from "@intentguard/contracts";
import { approvalIsValid } from "./approval.js";
import { digestEvidence } from "./lib/evidence.js";
import type { ControlStore } from "./lib/store.js";

export type StoredRunReport = {
  run: RunRecord;
  candidates: CandidateRecord[];
  evidence: EvidenceBundle;
  narration: string | null;
  approval: ApprovalRecord | null;
  currentDigest: string;
  approvalValid: boolean;
};

export function buildStoredReport(runId: string, store: ControlStore): StoredRunReport {
  const snapshot = store.getSnapshot(runId);
  const evidence = store.getEvidenceBundle(runId);
  return {
    run: snapshot.run,
    candidates: snapshot.candidates,
    evidence,
    narration: snapshot.narration,
    approval: snapshot.approval,
    currentDigest: digestEvidence(evidence),
    approvalValid: approvalIsValid(runId, store),
  };
}

function markdownText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/([`*_[\]{}()#+.!|<>-])/gu, "\\$1")
    .replaceAll("\n", " ");
}

function indentedCode(value: string): string[] {
  return value.split("\n").map((line) => `    ${line}`);
}

export function renderStoredReportMarkdown(runId: string, store: ControlStore): string {
  const report = buildStoredReport(runId, store);
  const verdict = report.evidence.verdict;
  const lines = [
    `# IntentGuard run ${markdownText(report.run.runId)}`,
    "",
    `- State: **${report.run.state}**`,
    `- Snapshot: ${markdownText(report.run.snapshotId)}`,
    `- Corpus: ${markdownText(report.run.corpusVersion)}`,
    `- Policy: ${markdownText(report.run.policyVersion)}`,
    `- Verdict: **${verdict.outcome}**${verdict.recommended === null ? "" : ` candidate **${markdownText(verdict.recommended)}**`}`,
    "",
    "## Candidates",
    "",
    "| Candidate | Status | Failure reason | Sandbox | Commit |",
    "| --- | --- | --- | --- | --- |",
    ...report.candidates.map((candidate) =>
      `| ${markdownText(candidate.candidateId)} | ${candidate.status} | ${markdownText(candidate.failureReason ?? "")} | ${markdownText(candidate.sandbox?.sandboxId ?? "")} | ${markdownText(candidate.sandbox?.commitSha ?? "")} |`,
    ),
    "",
    "## Gates",
    "",
    "| Candidate | Category | Key | Status | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...report.evidence.gates.map((gate) =>
      `| ${markdownText(gate.candidateId)} | ${gate.category} | ${markdownText(gate.key)} | ${gate.status} | ${markdownText(gate.detail)} |`,
    ),
    "",
    "## Security scans",
    "",
    ...report.evidence.scans.flatMap((scan) => [
      `### Candidate ${markdownText(scan.candidateId)}: ${scan.status}`,
      "",
      ...(scan.findings.length === 0
        ? ["No findings."]
        : scan.findings.map((finding) =>
          `- **${finding.severity.toUpperCase()}** ${markdownText(finding.id)}: ${markdownText(finding.title)} (${markdownText(finding.file)}:${String(finding.line)})`,
        )),
      "",
    ]),
    "## Approval",
    "",
    report.approval === null
      ? "Not approved."
      : `Approved by **${markdownText(report.approval.reviewer)}** at ${markdownText(report.approval.approvedAt)}.`,
    report.approval === null ? "" : `Digest: ${report.approval.digest}`,
    report.approval === null ? "" : `Evidence unchanged: **${report.approvalValid ? "yes" : "no"}**`,
    "",
    "## Stored narration",
    "",
    ...(report.narration === null ? ["No narration stored."] : indentedCode(report.narration)),
    "",
  ];
  return lines.join("\n");
}
