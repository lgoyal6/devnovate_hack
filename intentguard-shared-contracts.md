# IntentGuard, Shared Contracts

Read this first. Everything in the three individual briefs depends on it.

Three people building in parallel only works if the interfaces are frozen before anyone writes code. These types are the interfaces. Laksh commits `packages/contracts` in the first twenty minutes. After that they change only by announcement to both other people.

## Ownership rule

One sentence each, no overlap:

- **Laksh** owns the brain: Forge, control API, worker, comparison, policy, evidence, report.
- **Neel** owns everything that talks to a third party: Daytona, Snyk, RocketRide.
- **Bryan** owns everything the user sees and everything being tested: legacy fixture, candidates, corpus, replay harness, frontend.

If you find yourself editing a file outside your area, stop and message the owner.

## The mock rule

In your first hour, ship a mock implementation of your own exports. Nobody waits for anybody. Laksh's comparison engine develops against Bryan's fixture results; Neel's adapter is verified with a CLI script, not through the UI.

The important one is Laksh's `apps/control/src/mock-run.ts`: not a static JSON blob but a runnable fake that emits the entire event sequence with realistic delays, including one behavioral divergence and one security block. Bryan builds the whole interface against a live stream from it. The event shapes in that file are the canonical wire format, and every real module must match them. Integration means deleting the mock, not rewriting the UI.

Integration is at hour four and hour six, not continuously.

## Directory contract

Your code lives in your directory. Do not edit files in anyone else's, land your work in yours and coordinate through typed imports from `@/lib/<module>`. Laksh reserves every module directory with a placeholder `index.ts` in hour 0 so nobody creates a competing path.

If you need something from another module, message the owner and import their type. Do not reach around them.

## Repository

```
intentguard/
├── packages/contracts/      Laksh, frozen after hour 0
├── packages/execution/      Neel: daytona, snyk, rocketride adapters
├── packages/fixture/        Bryan: legacy service, candidates, corpus, replay
├── apps/control/            Laksh: API, worker, policy, evidence, SQLite
├── apps/web/                Bryan: UI
├── fixtures/                shared mock payloads
└── forge/                   Laksh: living spec, work orders, rules.json
```

pnpm workspace. No CI. Merge to main constantly. Long branches die.

## Types

```ts
// Recovered from the legacy source by Forge. Laksh commits forge/rules.json.
type Rule = {
  id: string;              // "REQ-014"
  title: string;
  behavior: string;        // plain English
  boundaries: string[];    // values that probe this rule: ["499.99","500.00","500.49"]
  blocking: boolean;
};

type CorpusInput = {
  id: string;              // "IN-0042"
  ruleId: string;          // which rule this probes
  method: "GET" | "POST";
  path: string;
  payload: Record<string, unknown>;
};

type SandboxRef = {
  candidateId: string;     // "legacy" | "A" | "B" | "C"
  sandboxId: string;
  snapshotId: string;
  commitSha: string;
  previewUrl: string;
  createdAt: string;
};

type RawResult = {
  candidateId: string;
  inputId: string;
  status: number;
  body: unknown;
  latencyMs: number;
};

type Finding = {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  file: string;
  line: number;
};

type ScanResult = {
  candidateId: string;
  status: "CLEAN" | "FINDINGS" | "ERROR";
  findings: Finding[];
  raw: unknown;
};

type GateResult = {
  candidateId: string;
  key: string;                                   // "behavior.REQ-014"
  category: "build" | "health" | "behavior" | "security";
  ruleId?: string;
  status: "PASS" | "FAIL";
  detail: string;                                // "input IN-0042: legacy 500.00, candidate 500.49"
  inputId?: string;
};

type Verdict = {
  outcome: "RECOMMEND" | "BLOCKED" | "INCONCLUSIVE";
  recommended: string | null;
  perCandidate: {
    candidateId: string;
    eligible: boolean;
    reasons: string[];
  }[];
  policyVersion: string;
};
```

## Module exports

Neel exports from `packages/execution`:

```ts
provision(candidateIds: string[], snapshotId: string): Promise<SandboxRef[]>  // parallel
scan(ref: SandboxRef): Promise<ScanResult>
teardown(runId: string): Promise<void>
narrate(verdict: Verdict, gates: GateResult[]): Promise<string>              // RocketRide
```

Bryan exports from `packages/fixture`:

```ts
generateCorpus(rules: Rule[]): CorpusInput[]
replay(previewUrl: string, corpus: CorpusInput[], candidateId: string): Promise<RawResult[]>
```

Laksh exports from `apps/control`:

```ts
compare(legacy: RawResult[], candidate: RawResult[], rules: Rule[]): GateResult[]
decide(gates: GateResult[], scans: ScanResult[]): Verdict   // pure, no network, no LLM
```

## HTTP API

Laksh implements, Bryan consumes.

```
POST   /api/runs                    -> { runId }
GET    /api/runs/:id                -> { run, candidates, gates, scans, verdict, narration }
GET    /api/runs/:id/events         -> SSE stream
POST   /api/runs/:id/approve        -> { digest }   body: { reviewer, comment }
GET    /api/rules                   -> Rule[]
GET    /api/runs/:id/report.json
GET    /api/runs/:id/report.md
```

SSE event:

```ts
type EventSource = "forge" | "daytona" | "snyk" | "rocketride" | "control";

type RunEvent = {
  seq: number;
  ts: string;
  source: EventSource;
  type: "RUN_QUEUED" | "RULES_LOCKED" | "SANDBOX_CREATED" | "SOURCE_READY"
      | "SCAN_COMPLETE" | "APP_HEALTHY" | "CORPUS_REPLAYED" | "DIVERGENCE_FOUND"
      | "GATE_RESULT" | "VERDICT_READY" | "NARRATED" | "APPROVED" | "TORN_DOWN";
  candidateId?: string;
  message: string;
  payload?: unknown;
};
```

Events are append-only and carry a monotonic `seq`. Bryan renders from `seq` order, never from arrival order.

`source` is not decoration. Bryan tags each timeline row with the platform that produced it, so a judge watching the demo sees their own product doing work in real time rather than taking our word for it in a slide.

**Every module emits its own events.** Each exported function takes `runId` as its first argument and calls `emitEvent(runId, ...)` itself. Neel's adapter emits `SANDBOX_CREATED`, not Laksh's worker on Neel's behalf. This keeps ownership clean and means integration is imports, not rewiring.

## Non-negotiables

Commit these as `CLAUDE.md` and `AGENTS.md` at the repo root so every Forge and Claude Code session inherits them. Three people running parallel agent sessions will otherwise produce three different codebases.

1. Strict TypeScript. No `any`, no `@ts-expect-error` without a comment saying why.
2. All environment variables flow through `src/lib/env.ts` with a zod schema. Never read `process.env` directly. New var means updating the schema and `.env.example`.
3. No silent error swallowing. `catch {}`, `catch { return [] }` and `return null` on failure are bugs. Throw with context or return a typed error. This matters most for the Snyk gate: a swallowed scanner failure becomes a false approval, which is the exact thing the product claims to prevent.
4. No `process.exit()` in library code, only in `scripts/`.
5. Smoke tests live in `scripts/smoke-<module>.ts` and exit non-zero on failure. A test that logs an error and exits 0 is a bug.
6. Commit format `<type>(<module>): <imperative summary>`. Commit often, merge to main constantly.
7. Never commit `.env.local` or real credentials.

## Where fallbacks are allowed

Graceful degradation keeps a demo alive, but faking the core claim loses the room if anyone asks a sharp question.

Allowed to fall back or degrade: RocketRide narration, ForgeScore display, cosmetic timeline detail, the rules list if Forge export fails (use the committed `rules.json`).

Never faked: sandbox creation, scan results, corpus replay, divergence detection, the verdict. If a candidate cannot run, it renders as `ENVIRONMENT_ERROR` and the verdict says INCONCLUSIVE. An environment failure shown honestly is a fine demo moment. A synthetic pass is not recoverable if a judge asks how it was produced.

## Integration points

**Hour 4, first integration.** Real Daytona sandboxes replace Neel's mock. One candidate plus legacy, real corpus, real comparison, rendered in the real UI. If this does not work at hour 4, cut candidate C.

**Hour 6, second integration.** All three candidates, Snyk gate live, policy engine wired, control plane deployed into a Daytona sandbox. Feature freeze immediately after.

## Tonight, August 13

Order matters. Bryan blocks Laksh.

| Time | Who | Deliverable |
|---|---|---|
| by 21:00 | Bryan | Legacy fixture v0 running with three rules, pushed |
| by 21:00 | Neel | Daytona SDK hello world, sandbox created, command executed, preview URL opened |
| by 23:00 | Bryan | All five rules, candidates A, B, C generated and hand-verified, commits pinned |
| by 23:00 | Neel | Snapshot built, network tier confirmed, Snyk fires reliably on B and is clean on A and C |
| by 23:00 | Laksh | Forge mission, living spec, rules.json extracted from Bryan's fixture, contracts package drafted |
| by 00:00 | all | Everyone has run the other two people's smoke script once |

If the Daytona free tier blocks outbound network, every dependency gets baked into the snapshot. Find that out tonight, not at 10am.

## Timeline, three people in parallel

| Hour | Laksh | Neel | Bryan |
|---|---|---|---|
| 0 to 1 | Freeze contracts, commit fixtures, scaffold control API and SQLite | Daytona adapter: provision from snapshot, exec, preview, teardown | UI shell, design tokens, static screen from fixture JSON |
| 1 to 2 | Worker loop and SSE, run state persisted | Parallel provisioning of four sandboxes, verified by CLI | Corpus generator from rules.json, replay client |
| 2 to 3 | Comparison engine against Bryan's fixture results | Snyk adapter, normalize to ScanResult, blocking severity policy | Live timeline wired to SSE, sandbox and commit metadata |
| 3 to 4 | **Integration 1** with Neel and Bryan | **Integration 1** | **Integration 1** |
| 4 to 5 | Policy engine, gate records, evidence bundle | Fan out to all three candidates, TTL cleanup | Reconciliation ledger view, divergence rendering |
| 5 to 6 | Approval, evidence digest, report export | RocketRide wrapper around the working loop | Verdict and approval panel |
| 6 to 7 | **Integration 2**, deploy control plane into Daytona | **Integration 2**, narration wired | **Integration 2**, empty and error states |
| 7 to 8 | Pitch, two clean-start rehearsals | Reliability fixes, teardown verification | Backup recording, README, polish pass |

Sync at hours 2, 4 and 6. Ten minutes, standing up.

Feature freeze after Integration 2. Nothing new until the full demo has run clean from a fresh start twice.
