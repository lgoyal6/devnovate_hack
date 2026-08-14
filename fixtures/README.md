# fixtures/

Shared mock payloads, readable by all three workstreams.

Path reserved in hour 0. Anything committed here is demo scaffolding and must
never reach the verdict path. See "Where fallbacks are allowed" in CLAUDE.md:
sandbox creation, scan results, corpus replay, divergence detection and the
verdict are never faked.

## `expected.json`

`expected.json` is Bryan's hand-verified regression oracle for the legacy
service and candidates A, B, and C. It pins the seven required boundary cases,
all 28 HTTP status/body outcomes, and the inputs used by
`packages/fixture/scripts/smoke-services.ts`.

It is test evidence only. The control plane must build verdicts from live
replay and scan results; it must never read this file as a production result.
