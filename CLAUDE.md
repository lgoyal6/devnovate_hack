# IntentGuard, agent instructions

Three people are running parallel agent sessions against this repo. Without
these rules we produce three different codebases. `AGENTS.md` is the same file;
keep them identical.

## What this product is

An agent rewrites a legacy service. IntentGuard decides whether the rewrite is
safe to ship, by executing every candidate against a corpus of inputs generated
from business rules that Forge recovered from the legacy source, and comparing
the results to what the legacy system actually does.

The expected values come from the legacy system's behavior, not from anyone's
belief about what it should be. The model recovers intent and explains the
result. It never votes on pass or fail. Execution decides.

## Ownership

One sentence each, no overlap.

- **Laksh** owns the brain: Forge, control API, worker, comparison, policy,
  evidence, report. `packages/contracts`, `apps/control`, `forge/`.
- **Neel** owns everything that talks to a third party: Daytona, Snyk,
  RocketRide. `packages/execution`.
- **Bryan** owns everything the user sees and everything being tested: legacy
  fixture, candidates, corpus, replay harness, frontend. `packages/fixture`,
  `apps/web`.

If you find yourself editing a file outside your area, stop and message the
owner. If you need something from another module, import its type from
`@intentguard/contracts`. Do not reach around the owner.

## Contracts are frozen

`packages/contracts` is Laksh's and was frozen at hour 0. It changes only by
announcement to both other people. Do not add a type there to unblock yourself;
message Laksh.

It is a type-only module. It must never gain a runtime value.

## Non-negotiables

1. Strict TypeScript. No `any`, no `@ts-expect-error` without a comment saying
   why.
2. All environment variables flow through `src/lib/env.ts` with a zod schema.
   Never read `process.env` directly. A new variable means updating the schema
   and `.env.example` in the same commit.
3. No silent error swallowing. `catch {}`, `catch { return [] }` and
   `return null` on failure are bugs. Throw with context or return a typed
   error. This matters most for the Snyk gate: a swallowed scanner failure
   becomes a false approval, which is the exact thing this product claims to
   prevent.
4. No `process.exit()` in library code, only in `scripts/`.
5. Smoke tests live in `scripts/smoke-<module>.ts` and exit non-zero on failure.
   A test that logs an error and exits 0 is a bug.
6. Commit format `<type>(<module>): <imperative summary>`. Commit often, merge
   to main constantly. Long branches die.
7. Never commit `.env.local` or real credentials.
8. Do not add AI or tool co-author trailers to commits.

## Events

Every module emits its own events. Each exported function takes `runId` as its
first argument and calls `emitEvent(runId, ...)` itself. Neel's adapter emits
`SANDBOX_CREATED`; Laksh's worker does not emit it on Neel's behalf. This keeps
ownership clean and means integration is imports, not rewiring.

Events are append-only and carry a monotonic `seq`. Render from `seq` order,
never from arrival order.

`source` is not decoration. It tags each timeline row with the platform that
produced the event, so a judge watching the demo sees their own product doing
work in real time rather than taking our word for it in a slide.

## State machine

One run-level state machine only:

```
DRAFT -> RULES_LOCKED -> PROVISIONING -> EVALUATING -> AGGREGATING -> AWAITING_APPROVAL -> APPROVED | BLOCKED
```

Per candidate, a status string and a failure reason. There is no second state
machine.

## Where fallbacks are allowed

Graceful degradation keeps a demo alive. Faking the core claim loses the room
the moment anyone asks a sharp question.

Allowed to degrade: RocketRide narration, ForgeScore display, cosmetic timeline
detail, the rules list if the live Forge export fails (fall back to the
committed `forge/rules.json`).

Never faked: sandbox creation, scan results, corpus replay, divergence
detection, the verdict. If a candidate cannot run it renders as
`ENVIRONMENT_ERROR` and the verdict is `INCONCLUSIVE`. An environment failure
shown honestly is a fine demo moment. A synthetic pass is not recoverable if a
judge asks how it was produced.

## The mock

`apps/control/src/mock-run.ts` is a runnable fake, not a JSON blob. Its event
shapes are the canonical wire format and every real module must match them.
Bryan builds the whole interface against a live stream from it.

Integration means deleting the mock, not rewriting the UI.

```
pnpm mock            # print the event sequence with realistic delays
pnpm mock:serve      # serve it over SSE on CONTROL_PORT
pnpm smoke:control   # assert the mock still satisfies the contract
```

## Do not

Add GitHub, Slack, Jira, auth, RBAC, or live code generation. There is no CI.
Do not introduce one.
