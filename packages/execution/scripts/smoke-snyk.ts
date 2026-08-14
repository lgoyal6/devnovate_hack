import { executionCandidateIds, loadProvisionConfig } from "../src/lib/env.js";
import { liveRuntime } from "./live.js";

loadProvisionConfig();
const snapshotId = process.argv[2];
if (snapshotId === undefined || snapshotId.length === 0) {
  throw new Error("Usage: pnpm smoke:snyk -- <snapshot-id>");
}
const runId = `smoke-snyk-${Date.now().toString(36)}`;
const runtime = liveRuntime();
try {
  const refs = await runtime.provision(runId, [...executionCandidateIds], snapshotId);
  const scans = await Promise.all(
    refs.filter((ref) => ref.candidateId !== "legacy").map((ref) => runtime.scan(runId, ref)),
  );
  process.stdout.write(`${JSON.stringify({ scans }, null, 2)}\n`);
  if (scans.some((scan) => scan.status === "ERROR")) throw new Error("At least one Snyk scan returned ERROR.");
  for (const candidateId of ["A", "C"]) {
    const scan = scans.find((value) => value.candidateId === candidateId);
    if (scan?.status !== "CLEAN") throw new Error(`Expected candidate ${candidateId} to be CLEAN.`);
  }
  const candidateB = scans.find((scan) => scan.candidateId === "B");
  if (candidateB?.status !== "FINDINGS") throw new Error("Expected candidate B to have Snyk findings.");
  const blockingIds = candidateB.findings
    .filter((finding) => finding.severity === "high")
    .map((finding) => finding.id);
  if (blockingIds.length === 0) throw new Error("Candidate B produced no high Snyk Code finding.");
  process.stdout.write(`${JSON.stringify({ candidateBBlockingIssueIds: blockingIds }, null, 2)}\n`);
} finally {
  await runtime.teardown(runId);
}
