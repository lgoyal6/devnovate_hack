# Refund and fee fixtures

Each fixture is a standalone standard-library HTTP service. From the repository
root, start one with a single command:

```sh
python packages/fixture/legacy/server.py
python packages/fixture/candidates/A/server.py
python packages/fixture/candidates/B/server.py
python packages/fixture/candidates/C/server.py
```

They listen on `0.0.0.0:8080` by default. Use `--port <port>` or the `PORT`
environment variable to select another port. The legacy service is compatible
with Python 2.7 and Python 3; candidates require Python 3.8 or newer.

## HTTP contract

- `GET /health` returns `{"service":"refund-fee","status":"ok"}`.
- `POST /refunds/approve` accepts the approval payload below.
- `GET /audit` returns approval audit records. An optional `refund_id` query
  parameter filters the records.
- `POST /fees/quote` accepts `{"amount":"125.00"}`.

```json
{
  "refund_id": "refund-1042",
  "amount": "500.49",
  "actor": "bryan",
  "roles": [],
  "requested_at": "2026-08-13T12:00:00Z"
}
```

Money enters and leaves the approval API as decimal strings, making replay
responses stable. Audit timestamps echo the validated `requested_at` value.
Successful approvals return HTTP 200, and role denials return HTTP 403.

## Candidate behavior

| Service | Threshold behavior | Negative amounts | Security scan |
| --- | --- | --- | --- |
| legacy | Whole-dollar truncation | Clamp to zero | Baseline |
| A | Exact amount above $500 | HTTP 422 | Clean |
| B | Matches legacy | Matches legacy | Command-injection fixture |
| C | Matches legacy | Matches legacy | Clean |

Candidate B exposes `POST /admin/diagnostics` solely as the scanner fixture. It
passes its `target` field to a shell command and must only run in a disposable,
network-isolated sandbox. The approval corpus never calls that route.

The seven pinned approval cases and complete response bodies are in
`fixtures/expected.json`.
