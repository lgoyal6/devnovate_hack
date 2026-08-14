import type {
  CandidateId,
  CorpusInput,
  GateResult,
  RawResult,
  Rule,
} from "@intentguard/contracts";
import { emitEvent } from "./lib/events.js";

type Difference = {
  path: string;
  legacy: unknown;
  candidate: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectDifferences(
  legacy: unknown,
  candidate: unknown,
  path: string,
  differences: Difference[],
): void {
  if (Object.is(legacy, candidate)) return;

  if (Array.isArray(legacy) && Array.isArray(candidate)) {
    const maximumLength = Math.max(legacy.length, candidate.length);
    for (let index = 0; index < maximumLength; index += 1) {
      collectDifferences(legacy[index], candidate[index], `${path}[${String(index)}]`, differences);
    }
    return;
  }

  if (isRecord(legacy) && isRecord(candidate)) {
    const keys = [...new Set([...Object.keys(legacy), ...Object.keys(candidate)])].sort();
    for (const key of keys) {
      collectDifferences(
        legacy[key],
        candidate[key],
        path === "" ? key : `${path}.${key}`,
        differences,
      );
    }
    return;
  }

  differences.push({ path: path || "body", legacy, candidate });
}

function displayValue(value: unknown): string {
  if (value === undefined) return "<missing>";
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function probeLabel(input: CorpusInput, legacy: RawResult | undefined): string {
  const amount = input.payload.amount;
  if (typeof amount === "string" || typeof amount === "number") return `refund ${String(amount)}`;
  if (isRecord(legacy?.body)) {
    const bodyAmount = legacy.body.amount ?? legacy.body.requested_amount;
    if (typeof bodyAmount === "string" || typeof bodyAmount === "number") {
      return `refund ${String(bodyAmount)}`;
    }
  }
  return `${input.method} ${input.path}`;
}

function inputMap(results: readonly RawResult[], label: string): Map<string, RawResult> {
  const mapped = new Map<string, RawResult>();
  for (const result of results) {
    if (mapped.has(result.inputId)) throw new Error(`${label} has duplicate result ${result.inputId}.`);
    mapped.set(result.inputId, result);
  }
  return mapped;
}

function resolveCorpus(
  legacy: readonly RawResult[],
  candidate: readonly RawResult[],
  rules: readonly Rule[],
  corpus: readonly CorpusInput[] | undefined,
): readonly CorpusInput[] {
  if (corpus !== undefined) return corpus;
  if (rules.length !== 1) {
    throw new Error("compare requires corpus inputs when more than one rule is present.");
  }
  const rule = rules[0];
  if (rule === undefined) throw new Error("compare requires at least one rule.");
  const inputIds = [...new Set([
    ...legacy.map((result) => result.inputId),
    ...candidate.map((result) => result.inputId),
  ])].sort();
  return inputIds.map((id) => ({
    id,
    ruleId: rule.id,
    method: "POST" as const,
    path: "/",
    payload: {},
  }));
}

/**
 * Pure field-by-field comparison. JSON object key order and whitespace have no
 * effect; missing results and status differences fail closed.
 */
export function compare(
  legacy: readonly RawResult[],
  candidate: readonly RawResult[],
  rules: readonly Rule[],
  corpus?: readonly CorpusInput[],
): GateResult[] {
  const inputs = resolveCorpus(legacy, candidate, rules, corpus);
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const baseline = inputMap(legacy, "Legacy replay");
  const rewrite = inputMap(candidate, "Candidate replay");
  const baselineIds = new Set(legacy.map((result) => result.candidateId));
  if (baselineIds.size !== 1 || legacy[0]?.candidateId !== "legacy") {
    throw new Error("Legacy replay must contain only the legacy candidate ID.");
  }
  const candidateIds = new Set(candidate.map((result) => result.candidateId));
  if (candidateIds.size !== 1) throw new Error("Candidate replay must contain exactly one candidate ID.");
  const candidateId = candidate[0]?.candidateId;
  if (candidateId === undefined) throw new Error("Candidate replay cannot be empty.");
  if (candidateId === "legacy") throw new Error("Candidate replay cannot use the legacy candidate ID.");

  const corpusIds = new Set(inputs.map((input) => input.id));
  if (corpusIds.size !== inputs.length) throw new Error("Locked corpus input IDs must be unique.");
  for (const result of [...legacy, ...candidate]) {
    if (!corpusIds.has(result.inputId)) {
      throw new Error(`Replay result ${result.inputId} is not present in the locked corpus.`);
    }
  }

  return inputs.map((input) => {
    if (!ruleIds.has(input.ruleId)) {
      throw new Error(`Corpus input ${input.id} references unknown rule ${input.ruleId}.`);
    }
    const legacyResult = baseline.get(input.id);
    const candidateResult = rewrite.get(input.id);
    const label = probeLabel(input, legacyResult);
    const common = {
      candidateId,
      key: `behavior.${input.ruleId}`,
      category: "behavior" as const,
      ruleId: input.ruleId,
      inputId: input.id,
    };

    if (legacyResult === undefined || candidateResult === undefined) {
      return {
        ...common,
        status: "FAIL" as const,
        detail: `input ${input.id} (${label}): legacy=${legacyResult === undefined ? "missing" : "present"}, candidate=${candidateResult === undefined ? "missing" : "present"}`,
      };
    }

    if (legacyResult.status !== candidateResult.status) {
      return {
        ...common,
        status: "FAIL" as const,
        detail: `input ${input.id} (${label}): legacy status=${String(legacyResult.status)}, candidate status=${String(candidateResult.status)}`,
      };
    }

    const differences: Difference[] = [];
    collectDifferences(legacyResult.body, candidateResult.body, "", differences);
    const first = differences[0];
    if (first !== undefined) {
      return {
        ...common,
        status: "FAIL" as const,
        detail: `input ${input.id} (${label}): legacy ${first.path}=${displayValue(first.legacy)}, candidate ${first.path}=${displayValue(first.candidate)}`,
      };
    }

    return {
      ...common,
      status: "PASS" as const,
      detail: `input ${input.id} (${label}): status and JSON body matched legacy`,
    };
  });
}

/** Compare and emit control-owned divergence and gate events. */
export function compareRun(
  runId: string,
  legacy: readonly RawResult[],
  candidate: readonly RawResult[],
  rules: readonly Rule[],
  corpus: readonly CorpusInput[],
  persist: (gates: readonly GateResult[]) => void,
): GateResult[] {
  const gates = compare(legacy, candidate, rules, corpus);
  persist(gates);
  for (const gate of gates) {
    if (gate.status === "FAIL") {
      emitEvent(runId, {
        source: "control",
        type: "DIVERGENCE_FOUND",
        candidateId: gate.candidateId,
        message: gate.detail,
        payload: {
          ruleId: gate.ruleId,
          inputId: gate.inputId,
          blocking: rules.find((rule) => rule.id === gate.ruleId)?.blocking ?? true,
        },
      });
    }
    emitEvent(runId, {
      source: "control",
      type: "GATE_RESULT",
      candidateId: gate.candidateId,
      message: `${gate.status} ${gate.key} for ${gate.candidateId}: ${gate.detail}`,
      payload: gate,
    });
  }
  return gates;
}

export function candidateFor(results: readonly RawResult[]): CandidateId {
  const candidates = new Set(results.map((result) => result.candidateId));
  if (candidates.size !== 1) throw new Error("Results do not belong to exactly one candidate.");
  const candidateId = results[0]?.candidateId;
  if (candidateId === undefined) throw new Error("Results are empty.");
  return candidateId;
}
