import { z } from "zod";
import type {
  ApprovalRecord,
  GateResult,
  LedgerRow,
  LedgerValue,
  PresentationError,
  RawResult,
  RunEvent,
  RunView,
  SandboxRef,
  ScanResult,
  Verdict,
} from "../types";

const isoTimestampSchema = z.string().refine(
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value)),
  "timestamp must be a parseable ISO-8601 date-time with a timezone",
);

const candidateIdSchema = z.string().min(1);
const digestSchema = z.string().regex(
  /^[0-9a-f]{64}$/u,
  "digest must be a 64-character lowercase SHA-256 value",
);
const runEventSchema = z.object({
  seq: z.number().int().positive(),
  ts: isoTimestampSchema,
  source: z.enum(["forge", "daytona", "snyk", "rocketride", "control"]),
  type: z.string().min(1),
  candidateId: candidateIdSchema.optional(),
  message: z.string().min(1),
  payload: z.unknown().optional(),
});

const sandboxSchema = z.object({
  candidateId: candidateIdSchema,
  sandboxId: z.string().min(1),
  snapshotId: z.string().min(1),
  commitSha: z.string().min(1),
  previewUrl: z.string().min(1),
  createdAt: isoTimestampSchema,
});

const rawResultSchema = z.object({
  candidateId: candidateIdSchema,
  inputId: z.string().min(1),
  status: z.number().int(),
  body: z.unknown(),
  latencyMs: z.number().nonnegative(),
});

const corpusReplayedSchema = z.object({ results: z.array(rawResultSchema) });

const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  title: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
});

const scanSchema = z.object({
  candidateId: candidateIdSchema,
  status: z.enum(["CLEAN", "FINDINGS", "ERROR"]),
  findings: z.array(findingSchema),
  raw: z.unknown(),
});

const gateSchema = z.object({
  candidateId: candidateIdSchema,
  key: z.string(),
  category: z.enum(["build", "health", "behavior", "security"]),
  ruleId: z.string().optional(),
  status: z.enum(["PASS", "FAIL"]),
  detail: z.string(),
  inputId: z.string().optional(),
});

const verdictSchema = z.object({
  outcome: z.enum(["RECOMMEND", "BLOCKED", "INCONCLUSIVE"]),
  recommended: candidateIdSchema.nullable(),
  perCandidate: z.array(z.object({
    candidateId: candidateIdSchema,
    eligible: z.boolean(),
    reasons: z.array(z.string()),
  })),
  policyVersion: z.string(),
});

const narrationSchema = z.object({ narration: z.string() });
const approvalSchema = z.object({
  runId: z.string(),
  reviewer: z.string(),
  comment: z.string(),
  approvedAt: isoTimestampSchema,
  policyVersion: z.string(),
  digest: digestSchema,
});
const divergenceSchema = z.object({
  ruleId: z.string(),
  inputId: z.string(),
  blocking: z.boolean(),
});
const teardownSchema = z.object({ sandboxCount: z.number().int().nonnegative() });

function payloadError(event: RunEvent, error: z.ZodError): PresentationError {
  const detail = error.issues
    .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
    .join("; ");
  return {
    seq: event.seq,
    eventType: event.type,
    message: `Event ${event.seq} ${event.type} has an unreadable presentation payload (${detail}).`,
  };
}

function missingCandidateError(event: RunEvent): PresentationError {
  return {
    seq: event.seq,
    eventType: event.type,
    message: `Event ${event.seq} ${event.type} did not report a candidateId.`,
  };
}

function normalizeGate(parsed: z.infer<typeof gateSchema>): GateResult {
  const gate: GateResult = {
    candidateId: parsed.candidateId,
    key: parsed.key,
    category: parsed.category,
    status: parsed.status,
    detail: parsed.detail,
  };
  if (parsed.ruleId !== undefined) gate.ruleId = parsed.ruleId;
  if (parsed.inputId !== undefined) gate.inputId = parsed.inputId;
  return gate;
}

function rawValue(result: RawResult): LedgerValue {
  const encodedBody = JSON.stringify(result.body) ?? String(result.body);
  const summary = `${result.status} ${encodedBody}`;
  return { summary, parts: [{ text: summary, different: true }] };
}

export function parseRunEvent(value: unknown): RunEvent {
  return runEventSchema.parse(value) as RunEvent;
}

export function sortRunEvents(events: readonly RunEvent[]): RunEvent[] {
  const bySequence = new Map<number, RunEvent>();
  for (const event of events) bySequence.set(event.seq, event);
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

export function deriveRunView(events: readonly RunEvent[]): RunView {
  const sandboxes = new Map<string, SandboxRef>();
  const activeSandboxIds = new Set<string>();
  const rawResults = new Map<string, Map<string, RawResult>>();
  const divergences = new Map<string, {
    candidateId: string;
    inputId: string;
    ruleId: string;
    message: string;
  }>();
  const gates = new Map<string, GateResult>();
  const scans = new Map<string, ScanResult>();
  const presentationErrors: PresentationError[] = [];
  let verdict: Verdict | undefined;
  let narration: string | undefined;
  let approval: ApprovalRecord | undefined;

  for (const event of sortRunEvents(events)) {
    if (event.type === "SANDBOX_CREATED") {
      const result = sandboxSchema.safeParse(event.payload);
      if (result.success) {
        sandboxes.set(result.data.sandboxId, result.data);
        activeSandboxIds.add(result.data.sandboxId);
      } else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "CORPUS_REPLAYED") {
      const result = corpusReplayedSchema.safeParse(event.payload);
      if (result.success) {
        for (const raw of result.data.results) {
          const candidateResults = rawResults.get(raw.candidateId) ?? new Map<string, RawResult>();
          candidateResults.set(raw.inputId, raw);
          rawResults.set(raw.candidateId, candidateResults);
        }
      } else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "DIVERGENCE_FOUND") {
      const result = divergenceSchema.safeParse(event.payload);
      if (!result.success) presentationErrors.push(payloadError(event, result.error));
      else if (event.candidateId === undefined) presentationErrors.push(missingCandidateError(event));
      else {
        divergences.set(`${event.candidateId}:${result.data.inputId}`, {
          candidateId: event.candidateId,
          inputId: result.data.inputId,
          ruleId: result.data.ruleId,
          message: event.message,
        });
      }
    }

    if (event.type === "GATE_RESULT") {
      const result = gateSchema.safeParse(event.payload);
      if (result.success) {
        const gate = normalizeGate(result.data);
        gates.set(`${gate.candidateId}:${gate.key}:${gate.inputId ?? "all"}`, gate);
      } else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "SCAN_COMPLETE") {
      const result = scanSchema.safeParse(event.payload);
      if (result.success) scans.set(result.data.candidateId, result.data);
      else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "VERDICT_READY") {
      const result = verdictSchema.safeParse(event.payload);
      if (result.success) verdict = result.data;
      else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "NARRATED") {
      const result = narrationSchema.safeParse(event.payload);
      if (result.success) narration = result.data.narration;
      else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "APPROVED") {
      const result = approvalSchema.safeParse(event.payload);
      if (result.success) approval = result.data;
      else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "TORN_DOWN") {
      const result = teardownSchema.safeParse(event.payload);
      if (result.success) activeSandboxIds.clear();
      else presentationErrors.push(payloadError(event, result.error));
    }
  }

  const ledgerRows: LedgerRow[] = [];
  const consumedDivergences = new Set<string>();
  for (const gate of gates.values()) {
    if (gate.category !== "behavior") continue;
    const directDivergence = gate.inputId === undefined
      ? undefined
      : divergences.get(`${gate.candidateId}:${gate.inputId}`);
    const ruleDivergence = directDivergence ?? [...divergences.values()].find(
      (item) => item.candidateId === gate.candidateId && item.ruleId === gate.ruleId,
    );
    const evidenceInputId = gate.inputId ?? ruleDivergence?.inputId;
    const divergenceKey = ruleDivergence === undefined
      ? undefined
      : `${ruleDivergence.candidateId}:${ruleDivergence.inputId}`;
    const legacyResult = evidenceInputId === undefined
      ? undefined
      : rawResults.get("legacy")?.get(evidenceInputId);
    const candidateResult = evidenceInputId === undefined
      ? undefined
      : rawResults.get(gate.candidateId)?.get(evidenceInputId);
    const hasRawPair = ruleDivergence !== undefined
      && legacyResult !== undefined
      && candidateResult !== undefined;
    const row: LedgerRow = {
      id: `${gate.candidateId}:${gate.key}:${evidenceInputId ?? "gate"}`,
      order: ledgerRows.length + 1,
      candidateId: gate.candidateId,
      ruleId: gate.ruleId ?? gate.key,
      probe: evidenceInputId ?? "Gate-level result",
      status: ruleDivergence !== undefined || gate.status === "FAIL" ? "DIVERGENT" : "MATCH",
      note: gate.detail,
      evidenceKind: hasRawPair ? "raw" : "gate",
    };
    if (evidenceInputId !== undefined) row.inputId = evidenceInputId;
    if (hasRawPair) {
      row.legacy = rawValue(legacyResult);
      row.candidate = rawValue(candidateResult);
    }
    if (divergenceKey !== undefined) consumedDivergences.add(divergenceKey);
    ledgerRows.push(row);
  }

  for (const [key, divergence] of divergences) {
    if (consumedDivergences.has(key)) continue;
    const legacyResult = rawResults.get("legacy")?.get(divergence.inputId);
    const candidateResult = rawResults.get(divergence.candidateId)?.get(divergence.inputId);
    const hasRawPair = legacyResult !== undefined && candidateResult !== undefined;
    const row: LedgerRow = {
      id: `${divergence.candidateId}:${divergence.ruleId}:${divergence.inputId}`,
      order: ledgerRows.length + 1,
      candidateId: divergence.candidateId,
      inputId: divergence.inputId,
      ruleId: divergence.ruleId,
      probe: divergence.inputId,
      status: "DIVERGENT",
      note: divergence.message,
      evidenceKind: hasRawPair ? "raw" : "gate",
    };
    if (hasRawPair) {
      row.legacy = rawValue(legacyResult);
      row.candidate = rawValue(candidateResult);
    }
    ledgerRows.push(row);
  }

  const view: RunView = {
    sandboxes: [...sandboxes.values()],
    activeSandboxIds,
    ledgerRows,
    gates: [...gates.values()],
    scans: [...scans.values()],
    presentationErrors,
  };
  if (verdict !== undefined) view.verdict = verdict;
  if (narration !== undefined) view.narration = narration;
  if (approval !== undefined) view.approval = approval;
  return view;
}
