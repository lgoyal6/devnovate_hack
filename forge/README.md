# forge/

Owner: Laksh. Everything SoftwareForge produced from the legacy service, plus
the recovered rules the rest of the pipeline runs on.

## Contents

- `rules.json` - `Rule[]`, exported from Forge's Modernize Legacy Code workflow
  run against Bryan's legacy fixture. Not hand-written. The whole pitch is that
  nobody wrote REQ-014 down and Forge recovered it from the code, so a
  hand-authored rules file would be the one thing that loses the room in Q&A.
- `intent-document.pdf` - the Forge Intent Document, artifact
  `90e7970c-0d00-4d2e-b307-c5cb6868326d`, generated Aug 14 2026. Vision, five
  target personas, ten prioritized core features, technical constraints,
  per-section confidence scoring, the Modernization Analysis tech-stack
  proposals, and the Risk Register.
- `forgescore-legacy.pdf` - the ForgeScore report on `legacy.zip`. 70/100,
  "Established", scored across eight dimensions, with one high finding and no
  critical ones. Weakest dimensions are Trust Boundaries (56) and
  Future-Proofing (58); the high finding is that `approve_refund` is reachable
  through `do_POST` with no authentication or authorization pattern detected.

## Why the Intent Document matters to the demo

Forge wrote the parity thesis before any rewrite existed. The Intent Document
states that this is a behavior-preserving rewrite, not a product expansion,
and that "legacy observed behavior is authoritative, and execution against the
legacy service determines parity." IntentGuard is the machine that enforces
that sentence.

The Risk Register is sharper still. Forge ranked, in advance and without ever
seeing candidates A, B, or C:

- Risk 2, refund approval rules: threshold, `finance_admin`,
  last-business-day, role normalization, or negative-amount behavior "could be
  reimplemented incorrectly" (REQ-007, REQ-014).
- Risk 3, fee calculation: "a developer may replace legacy float truncation
  with rounded decimal arithmetic, changing settlement-visible fee values"
  (REQ-022).

Those are the exact divergences the corpus is built to catch. Forge predicted
the failure mode; IntentGuard proves by execution whether a given candidate
committed it.

## How it is used at run time

`rules.json` is the only Forge artifact the code reads. Forge runs at design
time and its export is committed; the control plane does not fetch rules at
run time, so there is no live-export failure to fall back from. The file is
revalidated on every run (`apps/control/src/rules.ts`) and the run fails at
`DRAFT` if it is unreadable, malformed, or empty.

The two PDFs are evidence for the demo and for Q&A. Nothing imports them.
