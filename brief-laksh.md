# Brief: Laksh, the brain

You own Forge, the control API, the worker, the comparison engine, the policy engine, evidence, and the pitch. You do not touch Daytona, Snyk, RocketRide, the fixture, or the UI.

Read `intentguard-shared-contracts.md` first. You author `packages/contracts` and you are the only person who changes it.

## Tonight

1. Forge account, mission created, IntentGuard captured as a living specification. Generate PRD, architecture, security requirements, and work orders. This is what the Forge judges will ask to see, so let Forge do the whole chain rather than prompting it for code.
2. Once Bryan pushes the fixture, run Forge's Modernize Legacy Code workflow against it. Export the recovered business rules to `forge/rules.json` in the `Rule[]` shape. Assign the IDs, and make sure REQ-014 is in there with boundaries `["499.99","500.00","500.49","500.99","501.00"]`.
3. Generate candidates A, B and C from the locked spec using Forge, with Bryan verifying behavior. Save the Forge mission link; you will show it on stage.
4. Run ForgeScore on the legacy fixture. Screenshot the result.
5. Draft `packages/contracts` and push it.

## Hour 0 to 1

Freeze contracts. Reserve every module directory with a placeholder `index.ts` so nobody invents a competing path. Commit `CLAUDE.md` and `AGENTS.md` with the non-negotiables from the shared doc, since all three of you will be running agent sessions and they will otherwise drift.

Then build `apps/control/src/mock-run.ts` before anything else. It is a runnable fake, not a JSON file: it emits the full event sequence with realistic delays, four candidates, one behavioral divergence on REQ-014, one Snyk block, a verdict, and an approval. Bryan builds the entire interface against a live stream from it, so its event shapes are the canonical wire format every real module must match. This is the single highest-leverage thing you do all day, because it unblocks a third of the team for six hours.

Scaffold `apps/control`: Next.js API routes, SQLite with WAL enabled, tables for runs, candidates, gates, scans, events, decisions. Central `emitEvent(runId, event)` helper that every module calls directly, with `source` set to the platform responsible.

## Hour 1 to 2

Worker loop and SSE. The worker claims a run, walks the state machine, and emits events with a monotonic `seq`. One run-level state machine only:

```
DRAFT -> RULES_LOCKED -> PROVISIONING -> EVALUATING -> AGGREGATING -> AWAITING_APPROVAL -> APPROVED | BLOCKED
```

Per candidate, a status string and a failure reason. No second state machine.

## Hour 2 to 3

The comparison engine. This is the core of the product and it is yours.

```ts
compare(legacy: RawResult[], candidate: RawResult[], rules: Rule[]): GateResult[]
```

For each input ID, match the legacy result to the candidate result and compare status code and body. Body comparison is field by field on the JSON, not string equality, so key order and whitespace never produce false divergences. Every divergence becomes a `GateResult` with `category: "behavior"`, the `ruleId` from the corpus input, and a `detail` string a human can read on a projector:

```
input IN-0042 (refund 500.49): legacy approved=false, candidate approved=true
```

That string ends up on screen during the demo. Write it for that.

## Hour 4 to 5

The policy engine. Pure function. No network, no database, no LLM call anywhere in the path, and be able to say that sentence in Q&A.

```
1. All candidates used the same snapshot, corpus and policy version, else INCONCLUSIVE.
2. A candidate is ineligible if any blocking gate failed: build, health,
   behavioral divergence on any rule where blocking is true, or a Snyk finding
   at or above the blocking severity.
3. Scanner status ERROR is a failure. Fail closed.
4. Exactly one eligible: RECOMMEND it.
5. None eligible: BLOCKED, with per-candidate reasons.
6. Several eligible: fewest warnings, then lowest median latency, then commit order.
   Report the tie, do not hide it.
7. Persist the verdict before Neel's narration is called.
```

## Hour 5 to 6

Approval. `POST /api/runs/:id/approve` stores reviewer, comment, timestamp, policy version, and a SHA-256 digest over the canonicalised evidence bundle: rules JSON, corpus, all raw results, all scan results, all gates, and the verdict. Approval binds to the digest, so a later change to any evidence invalidates the approval.

Report export as JSON and Markdown, generated from stored evidence, never from a fresh model call.

## Hour 6 to 7

Deploy the control plane into a Daytona sandbox with Neel and expose it through a signed preview URL. Keep the local instance running as demo fallback.

## Hour 7 to 8

The pitch is yours. Follow the runbook in the plan. Rehearse from a clean start twice and time it. Have the backup recording open in a tab before you walk up.

Q&A you should have answers ready for:

- How is this different from writing tests? The expected values come from the legacy system's actual behavior, not from anyone's belief about what it should do. Nobody wrote REQ-014 down. Forge recovered it from the code.
- Does it scale? Corpus size and candidate count both map to sandbox count, which is exactly what the runtime is built for.
- What was hardest? Generating an input corpus from recovered rule boundaries rather than fuzzing, because random inputs never find REQ-014.
- What decides pass or fail? Execution. The model recovers intent and explains the result. It never votes.

## Do not

Add GitHub, Slack, Jira, auth, RBAC, or live code generation. Touch `apps/web`. Change contracts after hour 1 without telling both other people.
