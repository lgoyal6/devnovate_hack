# IntentGuard execution plane

This package is the only code that talks to Daytona, Snyk, and RocketRide. Its
public entry point exports exactly `provision`, `scan`, `teardown`, and
`narrate`; every function takes `runId` first and emits its own canonical run
events through the control plane's central event writer.

## Lifecycle

`provision` creates all requested Daytona sandboxes concurrently from the same
snapshot. It applies identical CPU, memory, disk, TTL, timeout, and network
settings and checks out the same immutable monorepo commit in each sandbox. A
strict internal convention maps `legacy`, `A`, `B`, and `C` respectively to
`packages/fixture/legacy` and `packages/fixture/candidates/{A,B,C}`. Preparation,
Snyk, and `python3 server.py` all run from that candidate's source directory;
Snyk runs before preparation or application start. Missing, extra, unknown, or
cross-commit candidate targets are rejected. Partial provisioning failures are
cleaned up before the error is returned.

`scan` returns the scan captured before app startup and emits `SCAN_COMPLETE`.
Scanner crashes, timeouts, unsupported projects, malformed JSON, and incomplete
findings become `ERROR`; they are never reported as clean. The Snyk token is
passed only to `snyk code test --json` and is never persisted in the sandbox.
Any occurrence echoed by the CLI is redacted from normalized findings, raw
evidence, errors, and emitted scan events.
Legacy is not scanned and can be provisioned without a Snyk token. Snyk Code's
SARIF-shaped JSON is normalized from its rule, severity, and physical-location
fields. SARIF has no critical level: `error` maps to `high`, `warning` to
`medium`, and `note`/`info` to `low`. The default high blocking policy therefore
blocks SARIF errors; no greater severity fidelity is inferred than SARIF
supplies.

`teardown` deletes all run sandboxes in parallel. It is idempotent and can
rediscover unknown-run sandboxes by Daytona labels after a process restart. A
same-process run that fails before contacting Daytona emits one zero-count
teardown event without loading provider credentials.

`narrate` supplies the already-final verdict and gates to RocketRide with an
instruction that forbids recomputation. The frozen worker ABI requires a
string, so RocketRide failures return and emit an explicit
`Narration unavailable: ...` string rather than fabricated prose.

## Verification

The deterministic package smoke uses injected adapters and no external
services:

```powershell
pnpm --filter @intentguard/execution test
```

Credentialed live smoke scripts use the real SDKs and exit nonzero on failure:

```powershell
pnpm --filter @intentguard/execution smoke:daytona -- <snapshot-id>
pnpm --filter @intentguard/execution smoke:snyk -- <snapshot-id>
pnpm --filter @intentguard/execution smoke:rocketride
```

The Daytona smoke also checks signed previews, Python, the Snyk CLI, outbound
HTTPS, Snyk endpoint reachability, and cleanup. The Snyk smoke requires A and C
to be clean and B to contain a high finding, then prints the detected issue
IDs.

Copy `.env.example` to an ignored local environment file and replace every
placeholder before running them. `fixtures/sandboxes.json` and
`fixtures/scans.json` must be created only from those credentialed runs; this
repository does not fabricate third-party output when credentials are absent.
