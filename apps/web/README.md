# IntentGuard web

Strict TypeScript React/Vite client for the IntentGuard control plane. Canonical wire and
domain types come from `@intentguard/contracts`. `src/types.ts` adds only UI presentation
types; candidate comparison, policy, security decisions, verdict selection, and narration
stay outside the browser.

## Live development mock

The development mock is the real SSE fixture from `apps/control/src/mock-run.ts`; the web
bundle contains no synthetic run evidence. The intended development workflow is two
processes:

```text
# terminal 1 — control-owned mock HTTP/SSE server on port 4000
pnpm mock:serve

# terminal 2
pnpm --filter @intentguard/web dev
```

Development defaults to `mock` mode and connects to
`http://localhost:4000/api/runs/:id/events?speed=6`. It chooses a run ID locally rather than
POSTing, because the live fixture constructs a deterministic run for the requested ID. The
fixture auto-approves; the adapter reads `GET /api/runs/:id` when it needs the recorded digest.

Set `VITE_INTENTGUARD_DATA_MODE=api` for the real workflow:

- `POST /api/runs`
- `GET /api/runs/:id/events` through browser `EventSource`
- `POST /api/runs/:id/approve`

Production defaults to `api` when no mode is set. Configure
`VITE_INTENTGUARD_API_BASE_URL` only when the control API is not same-origin.

## Canonical event payloads

`src/lib/run-events.ts` is the only payload-normalization boundary. It consumes the direct
canonical payloads emitted by the control fixture:

| Event | Payload |
| --- | --- |
| `SANDBOX_CREATED` | `SandboxRef` |
| `CORPUS_REPLAYED` | `{ results: RawResult[] }` |
| `DIVERGENCE_FOUND` | `{ ruleId, inputId, blocking }` |
| `GATE_RESULT` | `GateResult` |
| `SCAN_COMPLETE` | `ScanResult` |
| `VERDICT_READY` | `Verdict` |
| `NARRATED` | `{ narration }` |
| `APPROVED` | `ApprovalRecord` |
| `TORN_DOWN` | `{ sandboxCount }` |

Events always render in `seq` order. Unknown event objects delivered through the SSE
`message` compatibility channel remain timeline-only; canonical named events are registered
explicitly. Malformed payloads for presentation-critical known events produce a visible
evidence-display error.

The canonical `SandboxRef` currently reports sandbox, snapshot, commit, preview URL, and
creation time, but not CPU, memory, disk, or region. The environment register therefore says
`not reported` for allocation rather than inventing resource parity data.

The ledger never compares bodies or parses human-readable gate details. It shows a raw
legacy/candidate pair only when upstream identifies a divergent `inputId` and both recorded
`RawResult` values are present. Rule gates without per-input evidence show the canonical gate
detail and state that raw responses were not reported.

## Commands

```text
pnpm --filter @intentguard/web typecheck
pnpm --filter @intentguard/web test
pnpm --filter @intentguard/web build
```
