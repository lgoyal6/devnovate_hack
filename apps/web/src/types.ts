import type {
  ApprovalRecord,
  ApproveRequest,
  ApproveResponse,
  CandidateId,
  GateResult,
  RawResult,
  RunEvent as CanonicalRunEvent,
  RunEventType,
  SandboxRef,
  ScanResult,
  Verdict,
} from "@intentguard/contracts";

export type {
  ApprovalRecord,
  ApproveRequest,
  ApproveResponse,
  CandidateId,
  GateResult,
  RawResult,
  RunEventType,
  SandboxRef,
  ScanResult,
  Verdict,
};

/** Canonical event envelope widened only so newer server event names remain timeline-visible. */
export type RunEvent = Omit<CanonicalRunEvent, "type"> & { type: string };

export type ModernCandidateId = "A" | "B" | "C";

export interface DiffPart {
  text: string;
  different: boolean;
}

export interface LedgerValue {
  summary: string;
  parts: DiffPart[];
}

export interface LedgerRow {
  id: string;
  order: number;
  candidateId: CandidateId;
  inputId?: string;
  ruleId: string;
  probe: string;
  legacy?: LedgerValue;
  candidate?: LedgerValue;
  status: "MATCH" | "DIVERGENT";
  note: string;
  evidenceKind: "raw" | "gate";
}

export interface PresentationError {
  seq: number;
  eventType: string;
  message: string;
}

export interface RunView {
  sandboxes: SandboxRef[];
  activeSandboxIds: Set<string>;
  ledgerRows: LedgerRow[];
  gates: GateResult[];
  scans: ScanResult[];
  presentationErrors: PresentationError[];
  verdict?: Verdict;
  narration?: string;
  approval?: ApprovalRecord;
}
