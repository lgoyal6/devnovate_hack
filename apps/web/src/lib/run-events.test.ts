import { describe, expect, it } from "vitest";
import type { RunEvent } from "../types";
import { deriveRunView, parseRunEvent, sortRunEvents } from "./run-events";

const TS = "2026-08-14T04:25:10.000Z";

function event(
  seq: number,
  type: string,
  payload: unknown,
  candidateId?: string,
): RunEvent {
  const value: RunEvent = {
    seq,
    ts: TS,
    source: type === "SANDBOX_CREATED" || type === "TORN_DOWN" ? "daytona" : "control",
    type,
    message: `${type} fixture event.`,
    payload,
  };
  if (candidateId !== undefined) value.candidateId = candidateId;
  return value;
}

function canonicalEvents(): RunEvent[] {
  const sandbox = (candidateId: string) => ({
    candidateId,
    sandboxId: `dt-${candidateId.toLowerCase()}-001`,
    snapshotId: "snap-legacy-refunds-4f1c",
    commitSha: `${candidateId.toLowerCase()}21f04e`,
    previewUrl: `https://${candidateId.toLowerCase()}.preview.example`,
    createdAt: TS,
  });
  const raw = (candidateId: string, approved: boolean) => ({
    candidateId,
    inputId: "IN-0042",
    status: 200,
    body: { amount: "500.49", approved, requiresManagerApproval: !approved },
    latencyMs: candidateId === "legacy" ? 74 : 35,
  });

  return [
    event(1, "SANDBOX_CREATED", sandbox("legacy"), "legacy"),
    event(2, "SANDBOX_CREATED", sandbox("A"), "A"),
    event(3, "SANDBOX_CREATED", sandbox("B"), "B"),
    event(4, "SANDBOX_CREATED", sandbox("C"), "C"),
    event(5, "CORPUS_REPLAYED", { results: [raw("legacy", false)] }, "legacy"),
    event(6, "CORPUS_REPLAYED", { results: [raw("C", true)] }, "C"),
    event(7, "DIVERGENCE_FOUND", {
      ruleId: "REQ-014",
      inputId: "IN-0042",
      blocking: true,
    }, "C"),
    event(8, "GATE_RESULT", {
      candidateId: "A",
      key: "behavior.REQ-014",
      category: "behavior",
      ruleId: "REQ-014",
      status: "PASS",
      detail: "5 boundary inputs matched legacy exactly",
    }, "A"),
    event(9, "GATE_RESULT", {
      candidateId: "C",
      key: "behavior.REQ-014",
      category: "behavior",
      ruleId: "REQ-014",
      status: "FAIL",
      detail: "input IN-0042 diverged from the legacy result",
    }, "C"),
    event(10, "SCAN_COMPLETE", {
      candidateId: "B",
      status: "FINDINGS",
      findings: [{
        id: "SNYK-JS-CHILDPROCESS-2841",
        severity: "critical",
        title: "Command injection",
        file: "src/routes/refund.ts",
        line: 88,
      }],
      raw: { projectId: "snyk-b" },
    }, "B"),
    event(11, "VERDICT_READY", {
      outcome: "RECOMMEND",
      recommended: "A",
      perCandidate: [
        { candidateId: "A", eligible: true, reasons: [] },
        { candidateId: "B", eligible: false, reasons: ["security gate failed"] },
        { candidateId: "C", eligible: false, reasons: ["REQ-014 diverged"] },
      ],
      policyVersion: "policy-1",
    }),
    event(12, "NARRATED", { narration: "Candidate A is the only eligible rewrite." }),
    event(13, "APPROVED", {
      runId: "RUN-TEST-0001",
      reviewer: "laksh",
      comment: "Shipping A.",
      approvedAt: TS,
      policyVersion: "policy-1",
      digest: "a".repeat(64),
    }),
    event(14, "TORN_DOWN", { sandboxCount: 4 }),
  ];
}

describe("canonical run event presentation model", () => {
  it("deduplicates and renders events in sequence order", () => {
    const events = canonicalEvents();
    const shuffled = [events[2], events[0], events[1], events[2]].filter(
      (item): item is RunEvent => item !== undefined,
    );
    expect(sortRunEvents(shuffled).map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("retains all sandbox references while the single teardown clears the live count", () => {
    const events = canonicalEvents();
    const view = deriveRunView(events);
    const liveCounts = events.map((_, index) =>
      deriveRunView(events.slice(0, index + 1)).activeSandboxIds.size,
    );
    expect(view.sandboxes).toHaveLength(4);
    expect(view.activeSandboxIds.size).toBe(0);
    expect(Math.max(...liveCounts)).toBe(4);
    expect(liveCounts.at(-1)).toBe(0);
    expect(view.sandboxes.map((sandbox) => sandbox.sandboxId)).toContain("dt-legacy-001");
  });

  it("shows raw bodies only for the upstream-identified divergent input", () => {
    const view = deriveRunView(canonicalEvents());
    const pass = view.ledgerRows.find((row) => row.candidateId === "A");
    const divergence = view.ledgerRows.find((row) => row.candidateId === "C");
    expect(view.gates).toHaveLength(2);
    expect(pass?.evidenceKind).toBe("gate");
    expect(pass?.legacy).toBeUndefined();
    expect(divergence?.evidenceKind).toBe("raw");
    expect(divergence?.legacy?.summary).toContain('"approved":false');
    expect(divergence?.candidate?.summary).toContain('"approved":true');
    expect(view.verdict?.recommended).toBe("A");
    expect(view.scans[0]?.raw).toEqual({ projectId: "snyk-b" });
  });

  it("does not infer a raw divergence when the upstream marker is absent", () => {
    const events = canonicalEvents().filter((item) => item.type !== "DIVERGENCE_FOUND");
    const row = deriveRunView(events).ledgerRows.find((item) => item.candidateId === "C");
    expect(row?.status).toBe("DIVERGENT");
    expect(row?.evidenceKind).toBe("gate");
    expect(row?.candidate).toBeUndefined();
  });

  it("accepts direct canonical approval metadata", () => {
    const view = deriveRunView(canonicalEvents());
    expect(view.approval?.approvedAt).toBe(TS);
    expect(view.approval?.digest).toBe("a".repeat(64));
  });

  it("does not seal malformed approval digests", () => {
    const malformed = event(1, "APPROVED", {
      runId: "RUN-TEST-0001",
      reviewer: "laksh",
      comment: "Shipping A.",
      approvedAt: TS,
      policyVersion: "policy-1",
      digest: "NOT-A-SHA256",
    });
    const view = deriveRunView([malformed]);
    expect(view.approval).toBeUndefined();
    expect(view.presentationErrors[0]?.eventType).toBe("APPROVED");
  });

  it("rejects malformed envelopes and timestamps", () => {
    expect(() => parseRunEvent({ seq: 0, source: "unknown" })).toThrow();
    expect(() => parseRunEvent({
      seq: 1,
      ts: "not-a-date",
      source: "control",
      type: "RUN_QUEUED",
      message: "Queued.",
    })).toThrow();
  });

  it("keeps newer event types as timeline-only records", () => {
    const future = parseRunEvent({
      seq: 99,
      ts: TS,
      source: "control",
      type: "FUTURE_EVIDENCE_EVENT",
      message: "A newer control-plane event arrived.",
      payload: { version: 2 },
    });
    expect(future.type).toBe("FUTURE_EVIDENCE_EVENT");
    expect(deriveRunView([future]).presentationErrors).toEqual([]);
  });

  it("surfaces unreadable presentation-critical payloads", () => {
    const malformed = event(3, "SANDBOX_CREATED", { unexpected: true }, "A");
    expect(deriveRunView([malformed]).presentationErrors[0]?.eventType)
      .toBe("SANDBOX_CREATED");
  });

  it("orders ledger rows by originating event seq, not by construction pass", () => {
    const events: RunEvent[] = [
      event(1, "DIVERGENCE_FOUND", { ruleId: "REQ-99", inputId: "IN-99", blocking: true }, "B"),
      event(2, "GATE_RESULT", {
        candidateId: "A",
        key: "behavior.REQ-1",
        category: "behavior",
        ruleId: "REQ-1",
        status: "PASS",
        detail: "matched legacy",
      }, "A"),
    ];
    const view = deriveRunView(events);
    expect(view.ledgerRows.map((row) => row.candidateId)).toEqual(["B", "A"]);
    expect(view.ledgerRows.map((row) => row.order)).toEqual([1, 2]);
  });

  it("clears live sandboxes on TORN_DOWN even when the payload fails validation", () => {
    const events: RunEvent[] = [
      event(1, "SANDBOX_CREATED", {
        candidateId: "A",
        sandboxId: "dt-a-001",
        snapshotId: "snap-1",
        commitSha: "abc123",
        previewUrl: "https://a.preview.example",
        createdAt: TS,
      }, "A"),
      event(2, "TORN_DOWN", { bogus: true }),
    ];
    const view = deriveRunView(events);
    expect(view.activeSandboxIds.size).toBe(0);
    expect(view.presentationErrors[0]?.eventType).toBe("TORN_DOWN");
  });

  it("only marks the fields that actually differ, not the whole response", () => {
    const view = deriveRunView(canonicalEvents());
    const divergence = view.ledgerRows.find((row) => row.candidateId === "C");
    const amountPart = divergence?.legacy?.parts.find((part) => part.text.includes(".amount"));
    const approvedPart = divergence?.legacy?.parts.find((part) => part.text.includes(".approved:"));
    expect(amountPart?.different).toBe(false);
    expect(approvedPart?.different).toBe(true);
  });
});
