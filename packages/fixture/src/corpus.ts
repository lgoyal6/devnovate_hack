import type { CorpusInput, Rule } from "@intentguard/contracts";

const APPROVAL_PATH = "/refunds/approve";
const DEFAULT_AMOUNT = "100.00";
const DEFAULT_ACTOR = "fixture-replay";
const DEFAULT_REQUESTED_AT = "2026-01-15T12:00:00Z";
const REQUESTED_AT_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})Z)?$/u;

type ApprovalPayload = {
  refund_id: string;
  amount: string;
  actor: string;
  roles: string[];
  requested_at: string;
};

function inputId(sequence: number): string {
  return `IN-${sequence.toString().padStart(4, "0")}`;
}

function corpusContext(runId: string, rule: Rule): string {
  return `run ${JSON.stringify(runId)}, rule ${rule.id}`;
}

function requireAmount(runId: string, rule: Rule, boundary: string): string {
  const amount = Number(boundary);

  if (boundary.trim() === "" || !Number.isFinite(amount)) {
    throw new Error(
      `Cannot generate corpus input for ${corpusContext(runId, rule)}: boundary ${JSON.stringify(boundary)} is not a finite amount`,
    );
  }

  return boundary;
}

function requireRequestedAt(
  runId: string,
  rule: Rule,
  boundary: string,
): string {
  const requestedAt = boundary.trim();
  const match = REQUESTED_AT_PATTERN.exec(requestedAt);
  const parts = match?.groups;

  if (parts === undefined) {
    throw new Error(
      `Cannot generate corpus input for ${corpusContext(runId, rule)}: boundary ${JSON.stringify(boundary)} must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ`,
    );
  }

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const maximumDay = daysInMonth[month - 1];
  const calendarDateIsValid =
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    maximumDay !== undefined &&
    day >= 1 &&
    day <= maximumDay;
  const timeIsValid =
    parts.hour === undefined ||
    (Number(parts.hour) <= 23 &&
      Number(parts.minute) <= 59 &&
      Number(parts.second) <= 59);

  if (!calendarDateIsValid || !timeIsValid) {
    throw new Error(
      `Cannot generate corpus input for ${corpusContext(runId, rule)}: boundary ${JSON.stringify(boundary)} is not a valid calendar date in YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ form`,
    );
  }

  return requestedAt;
}

function requireActor(runId: string, rule: Rule, boundary: string): string {
  const actor = boundary.trim();

  if (actor === "") {
    throw new Error(
      `Cannot generate corpus input for ${corpusContext(runId, rule)}: the audit actor boundary is empty`,
    );
  }

  return actor;
}

function looksLikeDate(boundary: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(boundary.trim());
}

function applyBoundary(
  runId: string,
  rule: Rule,
  boundary: string,
  payload: ApprovalPayload,
): ApprovalPayload {
  switch (rule.id) {
    case "REQ-001":
    case "REQ-014":
    case "REQ-031":
      return { ...payload, amount: requireAmount(runId, rule, boundary) };
    case "REQ-007":
      return { ...payload, actor: requireActor(runId, rule, boundary) };
    case "REQ-022":
      return {
        ...payload,
        amount: "501.00",
        requested_at: requireRequestedAt(runId, rule, boundary),
      };
    default:
      if (looksLikeDate(boundary)) {
        return {
          ...payload,
          requested_at: requireRequestedAt(runId, rule, boundary),
        };
      }

      if (boundary.trim() !== "" && Number.isFinite(Number(boundary))) {
        return { ...payload, amount: requireAmount(runId, rule, boundary) };
      }

      return { ...payload, actor: requireActor(runId, rule, boundary) };
  }
}

/**
 * Emits one stable approval request for every boundary, preserving rule and
 * boundary order. No randomness, clock reads, or environment state are used.
 */
export function generateCorpus(runId: string, rules: Rule[]): CorpusInput[] {
  const corpus: CorpusInput[] = [];

  for (const rule of rules) {
    for (const boundary of rule.boundaries) {
      const id = inputId(corpus.length + 1);
      const basePayload: ApprovalPayload = {
        refund_id: `refund-${id}`,
        amount: DEFAULT_AMOUNT,
        actor: DEFAULT_ACTOR,
        roles: [],
        requested_at: DEFAULT_REQUESTED_AT,
      };
      const payload = applyBoundary(runId, rule, boundary, basePayload);

      corpus.push({
        id,
        ruleId: rule.id,
        method: "POST",
        path: APPROVAL_PATH,
        payload: {
          refund_id: payload.refund_id,
          amount: payload.amount,
          actor: payload.actor,
          roles: payload.roles,
          requested_at: payload.requested_at,
        },
      });
    }
  }

  return corpus;
}
