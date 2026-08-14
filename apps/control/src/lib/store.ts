import { EventEmitter } from "node:events";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
import type {
  ApprovalRecord,
  CandidateId,
  CandidateRecord,
  CandidateStatus,
  CorpusInput,
  EvidenceBundle,
  GateResult,
  RawResult,
  Rule,
  RunEvent,
  RunEventType,
  RunRecord,
  RunSnapshot,
  RunState,
  SandboxRef,
  ScanResult,
  Verdict,
  EventSource as RunEventSource,
} from "@intentguard/contracts";

export type PendingRunEvent = Omit<RunEvent, "seq" | "ts"> & { ts?: string };

export type CreateStoredRun = {
  runId: string;
  snapshotId: string;
  corpusVersion: string;
  policyVersion: string;
  candidateIds: CandidateId[];
  createdAt?: string;
};

export type InterruptedRunState = Extract<
  RunState,
  "RULES_LOCKED" | "PROVISIONING" | "EVALUATING" | "AGGREGATING"
>;

export type InterruptedRunRecovery = {
  runId: string;
  previousState: InterruptedRunState;
  reason: string;
  verdict: Verdict;
};

export type StartupReconciliation = {
  releasedDraftRunIds: string[];
  interruptedRuns: InterruptedRunRecovery[];
};

const RUN_STATES = new Set<RunState>([
  "DRAFT",
  "RULES_LOCKED",
  "PROVISIONING",
  "EVALUATING",
  "AGGREGATING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "BLOCKED",
]);

const CANDIDATE_STATUSES = new Set<CandidateStatus>([
  "PENDING",
  "PROVISIONING",
  "READY",
  "REPLAYED",
  "PASSED",
  "FAILED",
  "ENVIRONMENT_ERROR",
]);

const EVENT_SOURCES = new Set<RunEventSource>([
  "forge",
  "daytona",
  "snyk",
  "rocketride",
  "control",
]);

const EVENT_TYPES = new Set<RunEventType>([
  "RUN_QUEUED",
  "RULES_LOCKED",
  "SANDBOX_CREATED",
  "SOURCE_READY",
  "SCAN_COMPLETE",
  "APP_HEALTHY",
  "CORPUS_REPLAYED",
  "DIVERGENCE_FOUND",
  "GATE_RESULT",
  "VERDICT_READY",
  "NARRATED",
  "APPROVED",
  "TORN_DOWN",
]);

const NEXT_STATES: Readonly<Record<RunState, readonly RunState[]>> = {
  DRAFT: ["RULES_LOCKED"],
  RULES_LOCKED: ["PROVISIONING"],
  PROVISIONING: ["EVALUATING", "BLOCKED"],
  EVALUATING: ["AGGREGATING", "BLOCKED"],
  AGGREGATING: ["AWAITING_APPROVAL", "BLOCKED"],
  AWAITING_APPROVAL: ["APPROVED", "BLOCKED"],
  APPROVED: [],
  BLOCKED: [],
};

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`Database column ${key} must be text.`);
  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`Database column ${key} must be text or null.`);
  return value;
}

function requiredNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Database column ${key} must be a finite number.`);
  }
  return value;
}

function parseJson<T>(source: string, context: string): T {
  try {
    return JSON.parse(source) as T;
  } catch (error: unknown) {
    throw new Error(`Stored ${context} is not valid JSON.`, { cause: error });
  }
}

function asRunState(value: string): RunState {
  if (!RUN_STATES.has(value as RunState)) throw new TypeError(`Unknown stored run state ${value}.`);
  return value as RunState;
}

function asInterruptedRunState(value: string): InterruptedRunState {
  const state = asRunState(value);
  if (
    state !== "RULES_LOCKED"
    && state !== "PROVISIONING"
    && state !== "EVALUATING"
    && state !== "AGGREGATING"
  ) {
    throw new TypeError(`Run state ${state} is not recoverable as an interrupted evaluation.`);
  }
  return state;
}

function asCandidateStatus(value: string): CandidateStatus {
  if (!CANDIDATE_STATUSES.has(value as CandidateStatus)) {
    throw new TypeError(`Unknown stored candidate status ${value}.`);
  }
  return value as CandidateStatus;
}

function asEventSource(value: string): RunEventSource {
  if (!EVENT_SOURCES.has(value as RunEventSource)) {
    throw new TypeError(`Unknown stored event source ${value}.`);
  }
  return value as RunEventSource;
}

function asEventType(value: string): RunEventType {
  if (!EVENT_TYPES.has(value as RunEventType)) throw new TypeError(`Unknown stored event type ${value}.`);
  return value as RunEventType;
}

function changes(result: StatementResultingChanges): number {
  return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
}

function runFromRow(row: Record<string, unknown>): RunRecord {
  return {
    runId: requiredString(row, "run_id"),
    state: asRunState(requiredString(row, "state")),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    snapshotId: requiredString(row, "snapshot_id"),
    corpusVersion: requiredString(row, "corpus_version"),
    policyVersion: requiredString(row, "policy_version"),
  };
}

export class ControlStore {
  readonly database: DatabaseSync;
  private readonly events = new EventEmitter();

  constructor(path: string) {
    this.events.setMaxListeners(0);
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA busy_timeout = 5000;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    const journalMode = this.getJournalMode().toLowerCase();
    if (path !== ":memory:" && journalMode !== "wal") {
      this.database.close();
      throw new Error(`SQLite WAL mode is required, but ${path} opened in ${journalMode} mode.`);
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('DRAFT', 'RULES_LOCKED', 'PROVISIONING', 'EVALUATING', 'AGGREGATING', 'AWAITING_APPROVAL', 'APPROVED', 'BLOCKED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        corpus_version TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        worker_claimed_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS candidates (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROVISIONING', 'READY', 'REPLAYED', 'PASSED', 'FAILED', 'ENVIRONMENT_ERROR')),
        failure_reason TEXT,
        sandbox_json TEXT,
        commit_order INTEGER NOT NULL,
        PRIMARY KEY (run_id, candidate_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS rules (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        rule_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        rule_json TEXT NOT NULL,
        PRIMARY KEY (run_id, rule_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS corpus (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        input_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        input_json TEXT NOT NULL,
        PRIMARY KEY (run_id, input_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS raw_results (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL,
        input_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (run_id, candidate_id, input_id),
        FOREIGN KEY (run_id, candidate_id) REFERENCES candidates(run_id, candidate_id),
        FOREIGN KEY (run_id, input_id) REFERENCES corpus(run_id, input_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS scans (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL,
        scan_json TEXT NOT NULL,
        PRIMARY KEY (run_id, candidate_id),
        FOREIGN KEY (run_id, candidate_id) REFERENCES candidates(run_id, candidate_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS gates (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL,
        gate_key TEXT NOT NULL,
        input_id TEXT NOT NULL DEFAULT '',
        gate_json TEXT NOT NULL,
        PRIMARY KEY (run_id, candidate_id, gate_key, input_id),
        FOREIGN KEY (run_id, candidate_id) REFERENCES candidates(run_id, candidate_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        ts TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('forge', 'daytona', 'snyk', 'rocketride', 'control')),
        type TEXT NOT NULL CHECK (type IN ('RUN_QUEUED', 'RULES_LOCKED', 'SANDBOX_CREATED', 'SOURCE_READY', 'SCAN_COMPLETE', 'APP_HEALTHY', 'CORPUS_REPLAYED', 'DIVERGENCE_FOUND', 'GATE_RESULT', 'VERDICT_READY', 'NARRATED', 'APPROVED', 'TORN_DOWN')),
        candidate_id TEXT,
        message TEXT NOT NULL,
        payload_json TEXT,
        PRIMARY KEY (run_id, seq)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS decisions (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        verdict_json TEXT NOT NULL,
        narration TEXT,
        persisted_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS approvals (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        reviewer TEXT NOT NULL,
        comment TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        digest TEXT NOT NULL CHECK (length(digest) = 64)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS events_run_seq ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS runs_claimable ON runs(state, worker_claimed_at, created_at);
    `);
  }

  close(): void {
    this.events.removeAllListeners();
    this.database.close();
  }

  getJournalMode(): string {
    const row = this.database.prepare("PRAGMA journal_mode").get();
    if (row === undefined) throw new Error("SQLite did not return a journal mode.");
    return requiredString(row, "journal_mode");
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this.database.exec("COMMIT;");
      return result;
    } catch (error: unknown) {
      try {
        this.database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], "SQLite transaction and rollback both failed.");
      }
      throw error;
    }
  }

  createRun(input: CreateStoredRun): RunRecord {
    if (input.candidateIds.length === 0) throw new Error("A run needs at least one candidate.");
    if (new Set(input.candidateIds).size !== input.candidateIds.length) {
      throw new Error("A run cannot contain duplicate candidate IDs.");
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO runs (
          run_id, state, created_at, updated_at, snapshot_id, corpus_version, policy_version
        ) VALUES (?, 'DRAFT', ?, ?, ?, ?, ?)
      `).run(
        input.runId,
        createdAt,
        createdAt,
        input.snapshotId,
        input.corpusVersion,
        input.policyVersion,
      );
      const insertCandidate = this.database.prepare(`
        INSERT INTO candidates (
          run_id, candidate_id, status, failure_reason, sandbox_json, commit_order
        ) VALUES (?, ?, 'PENDING', NULL, NULL, ?)
      `);
      input.candidateIds.forEach((candidateId, index) => {
        insertCandidate.run(input.runId, candidateId, index);
      });
    });
    return this.requireRun(input.runId);
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    return row === undefined ? undefined : runFromRow(row);
  }

  requireRun(runId: string): RunRecord {
    const run = this.getRun(runId);
    if (run === undefined) throw new Error(`Run ${runId} does not exist.`);
    return run;
  }

  transitionRun(runId: string, next: RunState, at = new Date().toISOString()): RunRecord {
    return this.transaction(() => {
      const current = this.requireRun(runId);
      if (!NEXT_STATES[current.state].includes(next)) {
        throw new Error(`Run ${runId} cannot transition from ${current.state} to ${next}.`);
      }
      this.database.prepare(
        "UPDATE runs SET state = ?, updated_at = ? WHERE run_id = ?",
      ).run(next, at, runId);
      return this.requireRun(runId);
    });
  }

  /** Terminal failure path for infrastructure errors that interrupt the normal state machine. */
  failRun(runId: string, reason: string, at = new Date().toISOString()): RunRecord {
    return this.transaction(() => {
      const run = this.requireRun(runId);
      if (run.state === "APPROVED") {
        throw new Error(`Approved run ${runId} cannot be marked failed.`);
      }
      if (run.state !== "BLOCKED") {
        this.database.prepare(`
          UPDATE runs
          SET state = 'BLOCKED', updated_at = ?, worker_claimed_at = NULL
          WHERE run_id = ?
        `).run(at, runId);
      }
      this.database.prepare(`
        UPDATE candidates
        SET status = 'ENVIRONMENT_ERROR', failure_reason = COALESCE(failure_reason, ?)
        WHERE run_id = ? AND status NOT IN ('PASSED', 'FAILED')
      `).run(reason, runId);
      return this.requireRun(runId);
    });
  }

  claimNextDraftRun(at = new Date().toISOString()): string | undefined {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT run_id FROM runs
        WHERE state = 'DRAFT' AND worker_claimed_at IS NULL
        ORDER BY created_at, run_id
        LIMIT 1
      `).get();
      if (row === undefined) return undefined;
      const runId = requiredString(row, "run_id");
      const result = this.database.prepare(`
        UPDATE runs SET worker_claimed_at = ?
        WHERE run_id = ? AND worker_claimed_at IS NULL
      `).run(at, runId);
      return changes(result) === 1 ? runId : undefined;
    });
  }

  releaseClaim(runId: string): void {
    this.database.prepare("UPDATE runs SET worker_claimed_at = NULL WHERE run_id = ?").run(runId);
  }

  reconcileStartup(at = new Date().toISOString()): StartupReconciliation {
    return this.transaction(() => {
      const releasedDraftRunIds = this.database.prepare(`
        SELECT run_id FROM runs
        WHERE state = 'DRAFT' AND worker_claimed_at IS NOT NULL
        ORDER BY created_at, run_id
      `).all().map((row) => requiredString(row, "run_id"));
      this.database.prepare(`
        UPDATE runs SET worker_claimed_at = NULL
        WHERE state = 'DRAFT' AND worker_claimed_at IS NOT NULL
      `).run();

      const interruptedRuns = this.database.prepare(`
        SELECT run_id, state FROM runs
        WHERE state IN ('RULES_LOCKED', 'PROVISIONING', 'EVALUATING', 'AGGREGATING')
        ORDER BY created_at, run_id
      `).all().map((row): InterruptedRunRecovery => {
        const runId = requiredString(row, "run_id");
        const previousState = asInterruptedRunState(requiredString(row, "state"));
        const run = this.requireRun(runId);
        const reason = `Control process restarted while run ${runId} was ${previousState}; interrupted evaluation cannot be resumed safely.`;
        const candidateIds = this.database.prepare(`
          SELECT candidate_id FROM candidates
          WHERE run_id = ? AND candidate_id <> 'legacy'
          ORDER BY commit_order, candidate_id
        `).all(runId).map((candidate) => requiredString(candidate, "candidate_id"));
        const verdict: Verdict = {
          outcome: "INCONCLUSIVE",
          recommended: null,
          perCandidate: candidateIds.map((candidateId) => ({
            candidateId,
            eligible: false,
            reasons: [reason],
          })),
          policyVersion: run.policyVersion,
        };
        this.database.prepare(`
          INSERT INTO decisions (run_id, verdict_json, narration, persisted_at)
          VALUES (?, ?, NULL, ?)
          ON CONFLICT (run_id) DO UPDATE SET
            verdict_json = excluded.verdict_json,
            narration = NULL,
            persisted_at = excluded.persisted_at
        `).run(runId, JSON.stringify(verdict), at);
        this.database.prepare(`
          UPDATE runs
          SET state = 'BLOCKED', updated_at = ?, worker_claimed_at = NULL
          WHERE run_id = ?
        `).run(at, runId);
        this.database.prepare(`
          UPDATE candidates
          SET status = 'ENVIRONMENT_ERROR', failure_reason = ?
          WHERE run_id = ?
        `).run(reason, runId);
        this.appendEventWithinTransaction(runId, {
          ts: at,
          source: "control",
          type: "VERDICT_READY",
          message: `Verdict: INCONCLUSIVE because ${reason}`,
          payload: verdict,
        });
        return { runId, previousState, reason, verdict };
      });

      return { releasedDraftRunIds, interruptedRuns };
    });
  }

  updateCandidate(
    runId: string,
    candidateId: CandidateId,
    update: { status: CandidateStatus; failureReason?: string; sandbox?: SandboxRef },
  ): void {
    const result = this.database.prepare(`
      UPDATE candidates
      SET status = ?, failure_reason = ?, sandbox_json = COALESCE(?, sandbox_json)
      WHERE run_id = ? AND candidate_id = ?
    `).run(
      update.status,
      update.failureReason ?? null,
      update.sandbox === undefined ? null : JSON.stringify(update.sandbox),
      runId,
      candidateId,
    );
    if (changes(result) !== 1) throw new Error(`Candidate ${candidateId} does not exist in run ${runId}.`);
  }

  getCandidates(runId: string): CandidateRecord[] {
    return this.database.prepare(`
      SELECT * FROM candidates WHERE run_id = ? ORDER BY commit_order, candidate_id
    `).all(runId).map((row) => {
      const sandboxJson = optionalString(row, "sandbox_json");
      return {
        candidateId: requiredString(row, "candidate_id"),
        status: asCandidateStatus(requiredString(row, "status")),
        failureReason: optionalString(row, "failure_reason") ?? null,
        sandbox: sandboxJson === undefined ? null : parseJson<SandboxRef>(sandboxJson, "sandbox"),
      };
    });
  }

  saveRules(runId: string, rules: readonly Rule[]): void {
    this.transaction(() => {
      this.database.prepare("DELETE FROM rules WHERE run_id = ?").run(runId);
      const insert = this.database.prepare(
        "INSERT INTO rules (run_id, rule_id, ordinal, rule_json) VALUES (?, ?, ?, ?)",
      );
      rules.forEach((rule, index) => insert.run(runId, rule.id, index, JSON.stringify(rule)));
    });
  }

  getRules(runId: string): Rule[] {
    return this.database.prepare(
      "SELECT rule_json FROM rules WHERE run_id = ? ORDER BY ordinal",
    ).all(runId).map((row) => parseJson<Rule>(requiredString(row, "rule_json"), "rule"));
  }

  saveCorpus(runId: string, corpus: readonly CorpusInput[]): void {
    this.transaction(() => {
      this.database.prepare("DELETE FROM corpus WHERE run_id = ?").run(runId);
      const insert = this.database.prepare(
        "INSERT INTO corpus (run_id, input_id, ordinal, input_json) VALUES (?, ?, ?, ?)",
      );
      corpus.forEach((input, index) => insert.run(runId, input.id, index, JSON.stringify(input)));
    });
  }

  getCorpus(runId: string): CorpusInput[] {
    return this.database.prepare(
      "SELECT input_json FROM corpus WHERE run_id = ? ORDER BY ordinal",
    ).all(runId).map((row) => parseJson<CorpusInput>(requiredString(row, "input_json"), "corpus input"));
  }

  saveRawResults(runId: string, results: readonly RawResult[]): void {
    this.transaction(() => {
      const insert = this.database.prepare(`
        INSERT INTO raw_results (run_id, candidate_id, input_id, result_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (run_id, candidate_id, input_id)
        DO UPDATE SET result_json = excluded.result_json
      `);
      for (const result of results) {
        insert.run(runId, result.candidateId, result.inputId, JSON.stringify(result));
      }
    });
  }

  getRawResults(runId: string, candidateId?: CandidateId): RawResult[] {
    const rows = candidateId === undefined
      ? this.database.prepare(`
          SELECT result_json FROM raw_results
          WHERE run_id = ? ORDER BY candidate_id, input_id
        `).all(runId)
      : this.database.prepare(`
          SELECT result_json FROM raw_results
          WHERE run_id = ? AND candidate_id = ? ORDER BY input_id
        `).all(runId, candidateId);
    return rows.map((row) => parseJson<RawResult>(requiredString(row, "result_json"), "raw result"));
  }

  saveScan(runId: string, scan: ScanResult): void {
    this.database.prepare(`
      INSERT INTO scans (run_id, candidate_id, scan_json) VALUES (?, ?, ?)
      ON CONFLICT (run_id, candidate_id) DO UPDATE SET scan_json = excluded.scan_json
    `).run(runId, scan.candidateId, JSON.stringify(scan));
  }

  getScans(runId: string): ScanResult[] {
    return this.database.prepare(
      "SELECT scan_json FROM scans WHERE run_id = ? ORDER BY candidate_id",
    ).all(runId).map((row) => parseJson<ScanResult>(requiredString(row, "scan_json"), "scan result"));
  }

  saveGates(runId: string, gates: readonly GateResult[]): void {
    this.transaction(() => {
      const insert = this.database.prepare(`
        INSERT INTO gates (run_id, candidate_id, gate_key, input_id, gate_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (run_id, candidate_id, gate_key, input_id)
        DO UPDATE SET gate_json = excluded.gate_json
      `);
      for (const gate of gates) {
        insert.run(runId, gate.candidateId, gate.key, gate.inputId ?? "", JSON.stringify(gate));
      }
    });
  }

  getGates(runId: string): GateResult[] {
    return this.database.prepare(`
      SELECT gate_json FROM gates
      WHERE run_id = ? ORDER BY candidate_id, gate_key, input_id
    `).all(runId).map((row) => parseJson<GateResult>(requiredString(row, "gate_json"), "gate"));
  }

  saveVerdict(runId: string, verdict: Verdict, at = new Date().toISOString()): void {
    this.database.prepare(`
      INSERT INTO decisions (run_id, verdict_json, narration, persisted_at)
      VALUES (?, ?, NULL, ?)
      ON CONFLICT (run_id) DO UPDATE SET
        verdict_json = excluded.verdict_json,
        persisted_at = excluded.persisted_at
    `).run(runId, JSON.stringify(verdict), at);
  }

  saveNarration(runId: string, narration: string): void {
    const result = this.database.prepare(
      "UPDATE decisions SET narration = ? WHERE run_id = ?",
    ).run(narration, runId);
    if (changes(result) !== 1) throw new Error(`Run ${runId} has no persisted verdict to narrate.`);
  }

  getVerdict(runId: string): Verdict | undefined {
    const row = this.database.prepare(
      "SELECT verdict_json FROM decisions WHERE run_id = ?",
    ).get(runId);
    return row === undefined
      ? undefined
      : parseJson<Verdict>(requiredString(row, "verdict_json"), "verdict");
  }

  getNarration(runId: string): string | undefined {
    const row = this.database.prepare(
      "SELECT narration FROM decisions WHERE run_id = ?",
    ).get(runId);
    return row === undefined ? undefined : optionalString(row, "narration");
  }

  private saveApproval(approval: ApprovalRecord): void {
    if (!/^[0-9a-f]{64}$/u.test(approval.digest)) {
      throw new Error("Approval digest must be a 64-character lowercase SHA-256 value.");
    }
    this.database.prepare(`
      INSERT INTO approvals (
        run_id, reviewer, comment, approved_at, policy_version, digest
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      approval.runId,
      approval.reviewer,
      approval.comment,
      approval.approvedAt,
      approval.policyVersion,
      approval.digest,
    );
  }

  recordApproval(approval: ApprovalRecord): RunRecord {
    return this.transaction(() => {
      const run = this.requireRun(approval.runId);
      if (run.state !== "AWAITING_APPROVAL") {
        throw new Error(
          `Run ${approval.runId} cannot be approved while it is ${run.state}.`,
        );
      }
      if (approval.policyVersion !== run.policyVersion) {
        throw new Error(
          `Approval policy ${approval.policyVersion} does not match run policy ${run.policyVersion}.`,
        );
      }
      this.saveApproval(approval);
      this.database.prepare(
        "UPDATE runs SET state = 'APPROVED', updated_at = ? WHERE run_id = ?",
      ).run(approval.approvedAt, approval.runId);
      return this.requireRun(approval.runId);
    });
  }

  getApproval(runId: string): ApprovalRecord | undefined {
    const row = this.database.prepare("SELECT * FROM approvals WHERE run_id = ?").get(runId);
    if (row === undefined) return undefined;
    return {
      runId,
      reviewer: requiredString(row, "reviewer"),
      comment: requiredString(row, "comment"),
      approvedAt: requiredString(row, "approved_at"),
      policyVersion: requiredString(row, "policy_version"),
      digest: requiredString(row, "digest"),
    };
  }

  private appendEventWithinTransaction(runId: string, pending: PendingRunEvent): RunEvent {
    this.requireRun(runId);
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS last_seq FROM events WHERE run_id = ?",
    ).get(runId);
    if (row === undefined) throw new Error(`Could not allocate an event sequence for run ${runId}.`);
    const seq = requiredNumber(row, "last_seq") + 1;
    const ts = pending.ts ?? new Date().toISOString();
    this.database.prepare(`
      INSERT INTO events (
        run_id, seq, ts, source, type, candidate_id, message, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      seq,
      ts,
      pending.source,
      pending.type,
      pending.candidateId ?? null,
      pending.message,
      pending.payload === undefined ? null : JSON.stringify(pending.payload),
    );
    const stored: RunEvent = {
      seq,
      ts,
      source: pending.source,
      type: pending.type,
      message: pending.message,
    };
    if (pending.candidateId !== undefined) stored.candidateId = pending.candidateId;
    if (pending.payload !== undefined) stored.payload = pending.payload;
    return stored;
  }

  appendEvent(runId: string, pending: PendingRunEvent): RunEvent {
    const event = this.transaction(() => this.appendEventWithinTransaction(runId, pending));
    this.events.emit(`run:${runId}`, event);
    return event;
  }

  listEvents(runId: string, afterSeq = 0): RunEvent[] {
    return this.database.prepare(`
      SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq
    `).all(runId, afterSeq).map((row) => {
      const event: RunEvent = {
        seq: requiredNumber(row, "seq"),
        ts: requiredString(row, "ts"),
        source: asEventSource(requiredString(row, "source")),
        type: asEventType(requiredString(row, "type")),
        message: requiredString(row, "message"),
      };
      const candidateId = optionalString(row, "candidate_id");
      const payloadJson = optionalString(row, "payload_json");
      if (candidateId !== undefined) event.candidateId = candidateId;
      if (payloadJson !== undefined) event.payload = parseJson<unknown>(payloadJson, "event payload");
      return event;
    });
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    this.requireRun(runId);
    const channel = `run:${runId}`;
    const wrapped = (value: unknown): void => listener(value as RunEvent);
    this.events.on(channel, wrapped);
    return () => this.events.off(channel, wrapped);
  }

  getEvidenceBundle(runId: string): EvidenceBundle {
    const run = this.requireRun(runId);
    const verdict = this.getVerdict(runId);
    if (verdict === undefined) throw new Error(`Run ${runId} has no verdict, so its evidence is incomplete.`);
    return {
      runId,
      policyVersion: run.policyVersion,
      rules: this.getRules(runId),
      corpus: this.getCorpus(runId),
      rawResults: this.getRawResults(runId),
      scans: this.getScans(runId),
      gates: this.getGates(runId),
      verdict,
    };
  }

  getSnapshot(runId: string): RunSnapshot {
    return {
      run: this.requireRun(runId),
      candidates: this.getCandidates(runId),
      gates: this.getGates(runId),
      scans: this.getScans(runId),
      verdict: this.getVerdict(runId) ?? null,
      narration: this.getNarration(runId) ?? null,
      approval: this.getApproval(runId) ?? null,
    };
  }
}
