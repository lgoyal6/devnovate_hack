# IntentGuard control plane

The control package owns durable run state, append-only events, behavioral
comparison, deterministic policy, approval receipts, and stored-evidence
reports. The committed mock remains a separate development path.

## Requirements

- Node.js 22.5 or newer (`node:sqlite` is used directly)
- pnpm 11
- A Forge-exported `Rule[]` file at `forge/rules.json` or `FORGE_RULES_PATH`

Forge artifacts are intentionally not synthesized by this package. If the
rules export is absent or invalid, `GET /api/rules` and worker rule loading fail
with the artifact path and parse context instead of substituting demo data.
Relative `FORGE_RULES_PATH` values are resolved from the repository root, not
from the package-manager working directory.

## Real API

From the repository root:

```sh
pnpm dev:control
```

This is intentionally a `tsx` source entrypoint. The execution package imports
the control event-writer source, so emitting a plain-Node `serve-control.js`
artifact would risk loading source-only workspace exports or a second event
writer singleton. The control build emits the library and Node-based smoke
artifacts, but excludes the deployed server script.

Configuration is documented in the root `.env.example`. The server enables
SQLite WAL mode for file-backed databases and exposes:

- `GET /health`
- `GET /api/rules`
- `POST /api/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/events` (named SSE records, resumable with `Last-Event-ID`)
- `POST /api/runs/:id/approve`
- `GET /api/runs/:id/report.json`
- `GET /api/runs/:id/report.md`

`POST /api/runs` persists a `DRAFT` run. The production entrypoint starts
`runWorkerLoop`, which claims queued drafts and composes the fixture corpus and
replay exports with the execution provision, scan, narration, and teardown
exports. `CONTROL_BLOCKING_SEVERITY` is passed into the deterministic policy
path.

At startup, stale claims on `DRAFT` runs are released so the worker can reclaim
them. Runs interrupted in `RULES_LOCKED`, `PROVISIONING`, `EVALUATING`, or
`AGGREGATING` are atomically persisted as `BLOCKED` with an `INCONCLUSIVE`
verdict and contextual candidate failures. Their run IDs are then handed to
execution teardown. Teardown errors are reported and never converted into a
synthetic `TORN_DOWN`. Reconciliation assumes one active control process per
database; do not overlap two servers against the same SQLite file.

Execution provision returns only after dependency installation, app startup,
and its health probe succeed. The control composition requires both the
persisted sandbox reference and its matching `APP_HEALTHY` event before
creating explicit build and health gates; it does not issue a mismatched
second-port probe or manufacture a pass after a provision failure.

Recommended runs retain their sandboxes during human review. Approval persists
and returns its receipt before scheduling teardown. The server tracks that task
and waits for it during shutdown; only the execution adapter can emit
`TORN_DOWN`. Blocked and failed runs are torn down by the worker immediately.

## Event and evidence invariants

- All control-owned events go through the configured `emitEvent` writer.
- Event sequence allocation and insertion share one immediate transaction.
- Comparison uses HTTP status plus recursive JSON field comparison; object key
  order and whitespace do not create false divergences.
- Policy is a pure function with no clock, database, network, or model call.
- A verdict is stored before `VERDICT_READY` and before narration.
- SSE closes only after both `VERDICT_READY` and `TORN_DOWN` have been observed,
  in either order. This preserves a post-cleanup INCONCLUSIVE verdict when
  execution tears down during a provisioning failure.
- Approval is atomic and only accepts a stored `RECOMMEND` verdict in
  `AWAITING_APPROVAL`.
- Approval SHA-256 binds canonical rules, corpus, raw results, scans, gates,
  and verdict. Reports are regenerated only from those stored records.

## Verification

```sh
pnpm --filter @intentguard/control typecheck
pnpm --filter @intentguard/control smoke
pnpm smoke:control
```

The core smoke uses a real temporary SQLite database and exercises WAL,
comparison, policy, worker success/failure paths, HTTP, SSE, approval,
post-approval teardown, tamper detection, and both report formats. The existing
`smoke:control` command continues to verify the canonical timed mock used by the
web package.
