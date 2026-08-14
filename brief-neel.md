# Brief: Neel, the execution plane

You own every line of code that talks to a third party: Daytona, Snyk, RocketRide. Nobody else calls those APIs. You do not touch the UI, the policy engine, the fixture, or the comparison logic.

Read `intentguard-shared-contracts.md` first. You implement four functions and nothing else leaks out of `packages/execution`.

```ts
provision(candidateIds: string[], snapshotId: string): Promise<SandboxRef[]>
scan(ref: SandboxRef): Promise<ScanResult>
teardown(runId: string): Promise<void>
narrate(verdict: Verdict, gates: GateResult[]): Promise<string>
```

Every function takes `runId` as its first argument and emits its own events through `emitEvent(runId, { source: "daytona" | "snyk" | "rocketride", ... })`. You emit `SANDBOX_CREATED`, not Laksh on your behalf. The `source` tag is what puts each sponsor's activity on screen individually during the demo.

Verify everything with `scripts/smoke-<module>.ts`. Each exits non-zero on failure; a smoke test that logs an error and exits 0 is a bug. Never wait for the UI to test your work.

## Tonight, and this is the highest-risk work in the project

1. Daytona account, SDK installed, hello world: create a sandbox, execute one command, read the output, delete it.
2. Start a server inside a sandbox and open its signed preview URL from your laptop. If preview URLs do not work, the entire demo architecture changes, so find out now.
3. **Check outbound network on the event account tier.** Try `pip install` and an outbound HTTPS call from inside a sandbox. Reports suggest the free tier may block egress. If it does, every dependency gets baked into the snapshot and nothing installs at runtime. This single check is the most likely thing to sink tomorrow.
4. Build the snapshot `intentguard-refund-fixture-v1`: Python 2.7, Node, pnpm, pinned Snyk CLI, git, curl, jq, all cached dependencies, all fixture git refs. No API keys, no user data.
5. Snyk CLI authenticated. Run `snyk code test` against Bryan's candidates. Confirm B produces a high or critical finding consistently and A and C come back clean. Record the exact issue ID. If B's issue does not fire reliably, tell Bryan tonight so he can swap the pattern.
6. RocketRide smoke pipeline: a `.pipe` that accepts JSON and returns a result through the TypeScript SDK.
7. Commit `fixtures/sandboxes.json` and `fixtures/scans.json` so Laksh can develop against mocks.

## Hour 0 to 1

Daytona adapter, single sandbox: create from snapshot, checkout a commit SHA, execute a command with a working directory, start the app in the background, wait for health, return a `SandboxRef` with a preview URL. Verified by `scripts/smoke-daytona.ts`, not by anything else in the repo.

## Hour 1 to 2

Parallel provisioning. Four sandboxes from one snapshot, concurrently, each recording sandbox ID, snapshot ID, commit SHA, resource allocation, and timestamps.

Fairness is a judged property, so enforce it in code: identical CPU and memory allocation, identical timeouts, identical environment variables apart from candidate metadata, identical network policy. If any candidate provisions with different parameters, throw rather than continue, because an unfair comparison is worse than no comparison.

## Hour 2 to 3

Snyk adapter. Run `snyk code test --json` immediately after checkout and before the application starts. Normalize to `ScanResult`, preserve the raw output for the evidence bundle.

Rules that are not optional:

- Inject the Snyk token only into the scan command. It never sits in the sandbox environment.
- Never put Daytona or RocketRide credentials into a candidate sandbox.
- A scanner crash, timeout or unparseable output is `status: "ERROR"`, never `"CLEAN"`. Laksh's policy engine fails closed on it, and that behavior only holds if you never lie about a failed scan.

## Hour 4 to 5

Fan out to all three candidates plus legacy. TTL on every sandbox so an abandoned run cleans itself up, plus explicit `teardown(runId)` after evidence collection. Emit a sandbox count that Bryan can render live; watching it climb to four and drop to zero is worth real points with the Daytona judges.

## Hour 5 to 6

RocketRide. Wrap the loop that already works. Two constraints:

- It receives the computed verdict and explains it. It never selects a candidate and never alters a gate.
- Its output is schema validated before storage or display. Treat model output as untrusted data.
- If RocketRide is down, `narrate` returns null and the product still reaches the same verdict. Prove this by disabling it once before the demo.

## Hour 6 to 7

Deploy the control plane into a Daytona sandbox with Laksh. Signed preview URL for the demo. Verify teardown actually deletes sandboxes, because a judge may ask and an orphaned sandbox list is a bad answer.

## Talking points you own

When a Daytona judge stops by, these are yours: four sandboxes from one snapshot for reproducibility, parallel differential execution as a use case they have not productized, TTL and explicit teardown so cost falls to zero between runs, the control plane itself running inside Daytona with the demo served from a signed preview.

## Do not

Use RocketRide's Daytona tool for candidate execution; use the SDK directly for independent parallel lifecycle control. Let a scanner error pass as clean. Give candidate sandboxes any credential. Touch `apps/web` or the policy engine.
