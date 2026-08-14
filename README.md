# IntentGuard

IntentGuard checks whether an AI-rewritten service is safe to ship. It runs
every rewrite candidate against a set of test inputs built from the business
rules found in the legacy source, compares each candidate's behavior to what
the legacy system actually does, and turns any difference into evidence a
human can approve or block.

The expected values come from what the legacy system actually does, not from
anyone's opinion about what it should do. The rule-recovery model explains the
result. It never decides pass or fail. Running the code decides.

## Table of contents

- [Problem statement](#problem-statement)
- [Solution](#solution)
- [State machine](#state-machine)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
  - [Run the legacy and candidate fixtures](#run-the-legacy-and-candidate-fixtures)
  - [Verify fixture behavior](#verify-fixture-behavior)
  - [Run the interface against the mock](#run-the-interface-against-the-mock)
  - [Run the real control API](#run-the-real-control-api)
- [Module ownership](#module-ownership)
- [Events](#events)
- [Where fallbacks are and are not allowed](#where-fallbacks-are-and-are-not-allowed)
- [Verification commands](#verification-commands)
- [Non-negotiables](#non-negotiables)

## Problem statement

An agent can rewrite a legacy service in minutes. But nobody can tell, just
from reading the diff or the agent's own explanation, whether the rewrite
actually behaves the same as the old system. Legacy business rules are often
undocumented. The code itself is the only real record, including edge cases
nobody wrote down, like rounding, threshold boundaries, negative amounts, or
role checks. A rewrite can look correct and pass a hand-written test suite,
and still quietly change what happens at those edges. The first place that
shows up is production.

Trusting the agent's own explanation of its rewrite, or a model's opinion on
whether the diff "looks right," brings back the exact risk the rewrite was
supposed to fix.

## Solution

IntentGuard tests for correctness instead of guessing at it:

1. **Recover the rules.** Forge reads the legacy source and writes out a rules
   file (`forge/rules.json`), the business rules the legacy system actually
   follows, including the ones nobody wrote down.
2. **Build a corpus.** A generator turns those rules into concrete test
   inputs that target edge cases and boundaries (`packages/fixture`).
3. **Run it, don't ask about it.** Every candidate is set up in its own
   sandbox and run against the same corpus as the legacy service
   (`packages/execution`).
4. **Compare, don't guess.** Candidate responses are checked against legacy
   responses by HTTP status and by comparing JSON fields directly. Key order
   and whitespace never cause a false mismatch.
5. **Scan before trusting.** Every candidate is scanned (Snyk) before its
   comparison result is trusted. If the scan fails to run, that's a blocking
   error, never a silent pass.
6. **Decide with a plain function.** A policy function with no clock, no
   database, no network, and no model call turns the comparison and scan
   results into a verdict.
7. **Explain, don't decide.** A narration step writes up the already-final
   verdict in plain language. It's given the verdict and isn't allowed to
   recompute it.
8. **A human approves.** A person reviews the evidence and approves or blocks
   it. Approval only accepts a stored `RECOMMEND` verdict and produces a
   SHA-256 digest that ties the rules, test inputs, raw results, scans,
   gates, and verdict together, so the report can't drift from what actually
   ran.

## State machine

One run-level state machine drives every run:

```
DRAFT -> RULES_LOCKED -> PROVISIONING -> EVALUATING -> AGGREGATING -> AWAITING_APPROVAL -> APPROVED | BLOCKED
```

Each candidate additionally carries its own status string and failure reason.
There is no second state machine.

## Repository layout

```
apps/
  control/     durable run state, worker, comparison, policy, SSE, approval, reports
  web/         strict TypeScript reconciliation interface (React/Vite)
packages/
  contracts/   frozen, type-only wire/domain contracts shared by every module
  execution/   the only code that talks to Daytona, Snyk, and RocketRide
  fixture/     legacy service, candidates A/B/C, corpus generator, replay client
fixtures/      pinned expected outcomes for the required approval cases
forge/         Forge mission, recovered rules export, generated specs
```

## Prerequisites

- Node.js 22.5 or newer (the control plane uses the built-in `node:sqlite`
  module)
- pnpm 11
- Python 3.8 or newer to run the fixtures locally; the legacy fixture also
  stays compatible with Python 2.7

Install the workspace once from the repository root:

```sh
pnpm install
```

## Quick start

### Run the legacy and candidate fixtures

Each fixture is a standalone HTTP service (standard library only) and starts
with one command. Each listens on port 8080 unless you pass `--port` or set
`PORT`.

```sh
python packages/fixture/legacy/server.py
python packages/fixture/candidates/A/server.py --port 8081
python packages/fixture/candidates/B/server.py --port 8082
python packages/fixture/candidates/C/server.py --port 8083
```

Each exposes `GET /health`, `POST /refunds/approve`, `GET /audit`, and
`POST /fees/quote`. The full request contract, candidate behavior differences,
and the Candidate B security-scanner fixture are documented in
`packages/fixture/README.md`.

### Verify fixture behavior

```sh
pnpm --filter @intentguard/fixture build
pnpm --filter @intentguard/fixture exec tsx scripts/smoke-fixture.ts
pnpm --filter @intentguard/fixture exec tsx scripts/smoke-services.ts python
```

This starts and tears down every fixture, compares all 28 status/body outcomes
against `fixtures/expected.json`, and checks the four audit totals.

### Run the interface against the mock

`apps/control/src/mock-run.ts` is a runnable fake. Its event shapes are the
format every real module has to match. Run it and the web client in separate
terminals:

```sh
pnpm mock:serve
pnpm dev:web
```

The web client's dev mode reads the real SSE stream at
`http://localhost:4000`. The bundle itself contains no fake run evidence. Set
the values in `apps/web/.env.example` to point at a different control origin,
or switch to the real API mode. See `apps/web/README.md` for the full event
payload table.

```sh
pnpm --filter @intentguard/web typecheck
pnpm --filter @intentguard/web test
pnpm --filter @intentguard/web build
```

### Run the real control API

Place a real Forge export at `forge/rules.json` (or point `FORGE_RULES_PATH`
at it), configure `.env.example` as needed, then:

```sh
pnpm dev:control
```

The API persists queued runs and serves snapshots, named SSE events, approval,
and reports:

- `GET /health`
- `GET /api/rules`
- `POST /api/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/events` (resumable via `Last-Event-ID`)
- `POST /api/runs/:id/approve`
- `GET /api/runs/:id/report.json`
- `GET /api/runs/:id/report.md`

Real worker execution is built by injecting the Forge, corpus, execution,
scan, replay, narration, and teardown ports into `runWorkerLoop`. The API
never falls back to the mock if a Forge or execution adapter is missing. See
`apps/control/README.md` for the full route list and the rules that govern
events and evidence.

## Module ownership

Three people run parallel agent sessions against this repo. Ownership is
strict to avoid three divergent codebases:

| Owner | Owns | Paths |
| --- | --- | --- |
| Laksh | Forge, control API, worker, comparison, policy, evidence, report | `packages/contracts`, `apps/control`, `forge/` |
| Neel | Everything that talks to a third party: Daytona, Snyk, RocketRide | `packages/execution` |
| Bryan | Everything the user sees and everything being tested: legacy fixture, candidates, corpus, replay harness, frontend | `packages/fixture`, `apps/web` |

`packages/contracts` is frozen and type-only. It changes only when announced,
and it must never hold a runtime value. Data flows between modules through
imported contract types, not by reaching into another owner's module.

## Events

Every module emits its own events. A function that takes `runId` as its first
argument calls `emitEvent(runId, ...)` itself. For example, Neel's adapter
emits `SANDBOX_CREATED`; Laksh's worker does not emit it on Neel's behalf.
Events are append-only and carry a monotonic `seq`. Always render them in
`seq` order, never in the order they arrive. `source` tags each event with
the platform that produced it.

## Where fallbacks are and are not allowed

Allowed to degrade: RocketRide narration text, ForgeScore display, cosmetic
timeline detail, and the rules list (falls back to the committed
`forge/rules.json` if the live Forge export fails).

Never faked: sandbox creation, scan results, corpus replay, divergence
detection, or the verdict. A candidate that cannot run renders as
`ENVIRONMENT_ERROR` with an `INCONCLUSIVE` verdict rather than a synthetic
pass.

## Verification commands

```sh
pnpm typecheck:all       # root + every package
pnpm test                # every package's test suite
pnpm smoke:fixture       # legacy + candidate services against fixtures/expected.json
pnpm smoke:execution     # deterministic execution-plane smoke (injected adapters)
pnpm smoke:control       # canonical mock still satisfies the contract
pnpm smoke:control-core  # real SQLite-backed control plane, end to end
```

## Non-negotiables

- Strict TypeScript. No `any`, no unexplained `@ts-expect-error`.
- All environment variables flow through `src/lib/env.ts` with a zod schema.
  Never read `process.env` directly.
- No silent error swallowing. A swallowed Snyk failure becomes a false
  approval, which is exactly the failure this product exists to prevent.
- No `process.exit()` outside `scripts/`.
- Smoke tests live at `scripts/smoke-<module>.ts` and exit non-zero on
  failure.
- Commit format: `<type>(<module>): <imperative summary>`. Commit often, merge
  to main constantly.
