# IntentGuard UI direction: Guided Control Room

> Status: revised design proposal for review. Do not implement until approved.

## Product in one sentence

IntentGuard shows whether an agent-rewritten service behaves like the legacy service, proves the answer with recorded execution evidence, and lets a human approve only an eligible candidate.

## The first-time-user test

An unfamiliar judge should understand these four facts within five seconds:

1. **The question:** Is this rewrite safe to ship?
2. **The method:** IntentGuard runs the original and every rewrite against the same business-rule tests.
3. **The result:** Candidate A matches; Candidates B and C are blocked for specific reasons.
4. **The human action:** Review the evidence and approve the eligible candidate.

If the interface requires the judge to understand `CORPUS_REPLAYED`, `GATE_RESULT`, sandbox IDs, or policy versions before those four facts, the hierarchy is wrong.

## Memorable idea

**Watch the proof happen.**

The dashboard's main visual feature is a live execution canvas inspired by operational control rooms. It shows candidates moving through the same checks in parallel, a selected original-versus-rewrite comparison, the latest system activity, and the evidence package being assembled.

The canvas is not a decorative systems diagram. Every region is rendered from recorded run events and disappears or changes honestly when data is missing.

## Design strategy

### Default mode: Overview

The default dashboard is written for a smart person who does not know IntentGuard's architecture. It uses plain-language labels, one-line explanations, large state changes, and progressive disclosure.

### Optional mode: Technical evidence

Engineers can open the existing reconciliation ledger, environment register, raw event timeline, policy details, and full approval digest. Technical data remains available, but it no longer competes with the product story in the first viewport.

### One run-level state machine

The product still has only this state machine:

`DRAFT → RULES_LOCKED → PROVISIONING → EVALUATING → AGGREGATING → AWAITING_APPROVAL → APPROVED | BLOCKED`

The overview may pair each canonical label with plain language:

| Canonical state | Overview label |
| --- | --- |
| `DRAFT` | Run created |
| `RULES_LOCKED` | Business rules locked |
| `PROVISIONING` | Test environments ready |
| `EVALUATING` | Comparing behavior |
| `AGGREGATING` | Combining evidence |
| `AWAITING_APPROVAL` | Ready for human review |
| `APPROVED` | Approved |
| `BLOCKED` | Blocked |

This is a wording layer, not a second state machine.

## Page hierarchy

### 1. Header

- IntentGuard logo and name.
- Short descriptor: “Behavior proof for software rewrites.”
- Active run ID and current state.
- `Overview` and `Technical evidence` view switcher.
- No extra navigation for features that do not exist.

### 2. Orientation strip

The top of the page answers the user's question before showing machinery.

- Eyebrow: service under review.
- Headline during evaluation: “Checking whether the rewrites behave like the original.”
- Headline after resolution: “Candidate A is safe to review.”
- One sentence explaining that the answer comes from recorded execution, not model opinion.
- One primary action only: `Review Candidate A` when approval is available.

Three compact facts sit beside the headline:

- `84 / 84 behavior checks matched`
- `Security scan clean`
- `Same test environment`

Do not show policy IDs, source mode, event count, or digest here.

### 3. Run progress

A single horizontal progress row shows the canonical run state using the plain-language labels above. Completed states are quiet green, the current state is orange, and future states are neutral.

On small screens, show only completed count, current state, and next state. The full sequence opens on demand.

### 4. Core viewing feature: Live execution canvas

This is the dashboard's visual anchor. It uses a dark, calm surface inside the warm-light application shell, echoing an observation window into the run. A light bridge header, shared typography, and the same semantic color tokens make the transition intentional rather than reading as a second product embedded in the page.

#### Candidate race

Purpose: answer “Which rewrite is still viable?”

- Three horizontal candidate lanes: A, B, and C.
- Each lane shows current phase, completed checks, and final status.
- Candidate A: eligible, 84 behavior matches, clean scan.
- Candidate B: blocked by a critical security finding.
- Candidate C: blocked by two behavior differences.
- Selecting a lane changes the live comparison panel.
- Use outcome words and short reasons. Do not require the user to decode raw events.

#### Live behavior check

Purpose: answer “What is IntentGuard actually comparing?”

- Show one test input in plain language: “Refund exactly $50.00 as an agent.”
- Show two adjacent outputs labeled `Original service` and `Candidate A`.
- A clear center relationship says `Same result` or `Different result`.
- Technical JSON is available through `Show raw response`.
- When the selected candidate diverges, highlight only the differing value and explain the business consequence.

#### Execution log

Purpose: answer “What just happened, and who did it?”

- Show the latest 5–7 events, newest last.
- Each row starts with a plain sentence such as “Snyk finished Candidate A's security scan.”
- Source and canonical event type are secondary metadata.
- Preserve monotonic sequence order.
- Keep the full raw timeline in Technical evidence.

#### Evidence chain

Purpose: answer “What proof will be attached to the decision?”

- A horizontal chain showing Rules → Test corpus → Raw results → Security scans → Policy verdict → Human approval.
- Completed evidence nodes use a check and a count, not an invented quality score.
- The chain ends at “Awaiting your approval” before sign-off and becomes “Signed evidence packet” afterward.
- The SHA-256 digest is hidden behind `View packet details` until approval is sealed.

### 5. Decision summary

Below the live canvas, present one simple comparison table:

| Candidate | Behavior | Security | Decision | Reason |
| --- | --- | --- | --- | --- |
| A | 84/84 matched | Clean | Eligible | All required checks passed |
| B | 84/84 matched | Critical finding | Blocked | Command-injection risk |
| C | 82/84 matched | Clean | Blocked | Two legacy behaviors changed |

This table is the novice-readable summary. Selecting a candidate connects back to the viewing canvas.

### 6. Approval

- Before approval, the section title is “Your decision.”
- State the exact action: “Approve Candidate A for this modernization run.”
- Reviewer name and comment have persistent labels.
- For `BLOCKED` and `INCONCLUSIVE`, do not show approval inputs.
- After approval, replace the form with a restrained sealed-packet receipt.

### 7. Technical evidence drawer

Contains the existing detailed modules:

- Legacy/candidate reconciliation ledger.
- Sandbox and snapshot register.
- Full source-tagged event timeline.
- Scan findings.
- Policy version and per-candidate reasons.
- Narration with an explicit “explains, does not decide” note.
- Approval digest and included sandbox IDs.

The drawer may be a view tab or an expanded page region. It must have a stable URL/query state if implemented as a tab.

## Visual language

The application shell remains warm, editorial, and readable. The live execution canvas is a contained dark workspace that creates a strong focal point without turning the whole product into a cyber-themed terminal.

The canvas must inherit the page's visual grammar:

- Use the same condensed headings, monospace metadata, square corners, and one-pixel rules.
- Begin with a light bridge header and teal top rule so the dark workspace grows out of the page hierarchy.
- Keep colors semantic across both surfaces: teal means verified or selected, coral means blocked, orange means awaiting human action, and blue is reserved for approval.
- Do not introduce a separate logo, navigation model, decorative terminal chrome, or partner-colored panels inside the canvas.

### Colors

| Token | Value | Usage |
| --- | --- | --- |
| `--paper` | `#F4F2EB` | Application canvas |
| `--surface` | `#FFFFFF` | Orientation and decision surfaces |
| `--band` | `#E8EAE3` | Secondary rows and quiet grouping |
| `--ink` | `#13201A` | Primary text |
| `--muted` | `#617068` | Secondary text |
| `--rule` | `#C8CEC8` | Light dividers |
| `--control` | `#101714` | Live canvas |
| `--control-raised` | `#17211C` | Canvas subregions |
| `--control-rule` | `#34473E` | Canvas dividers |
| `--verify` | `#11856F` | Eligible, match, complete |
| `--verify-bright` | `#58D2AE` | Dark-canvas verified state |
| `--signal` | `#E3653A` | Current activity and attention |
| `--diverge` | `#C64742` | Divergence and blocked |
| `--diverge-bright` | `#FF8A82` | Dark-canvas blocked state |
| `--sealed` | `#3955B8` | Signed packet and approval receipt |

Color is never the only state signal. Every status includes a word and a simple check, bar, or cross.

### Typography

- IBM Plex Sans for explanations, navigation, and actions.
- IBM Plex Sans Condensed for titles and large status language.
- IBM Plex Mono for IDs, JSON, sequence, timestamps, and canonical event names.
- Default body copy is at least 16px with 1.5 line height.
- Technical metadata is at least 12px and never the only explanation.

### Shape and spacing

- 8px base spacing for novice-facing regions; 4px base inside technical views.
- Main content width: 1440px maximum.
- 24–40px between major regions.
- 0–4px radii. Borders and background changes define grouping.
- No blurred shadows, glass effects, gradients, decorative icons, or dashboard card mosaic.

## Interaction model

### Candidate selection

- Candidate lanes are real buttons with `aria-pressed`.
- Selection changes the comparison and explanation without moving the viewport.
- A first detected divergence may auto-select its candidate once. User selection wins afterward.

### Overview / Technical evidence

- Overview is the default.
- The view switcher is always visible in the header.
- Switching views preserves candidate selection and scrolls to the top of the chosen workspace.
- Technical evidence is not a modal; users can link to it and use browser navigation.

### Plain language with technical provenance

Every technical event maps to a visible sentence, but the original `source`, `type`, `seq`, and UTC timestamp remain available. Plain language never changes or guesses the underlying result.

### Motion

- A candidate lane advances with a 180ms stepped fill when a new event arrives.
- The newest execution-log row receives one 240ms entrance highlight.
- A comparison result crossfades in 160ms when candidate selection changes.
- No continuous pulsing or decorative terminal typing.
- Respect `prefers-reduced-motion`.

## Responsive behavior

### Desktop, 1200px+

- Orientation strip above the canvas.
- Canvas grid: Candidate race 42%, Live behavior check 33%, Execution log 25%.
- Evidence chain spans the full canvas width below those regions.
- Decision summary and approval sit below the canvas.

### Tablet, 768–1199px

- Candidate race spans full width.
- Behavior check and execution log form a two-column row.
- Evidence chain remains horizontal and scrolls within its labeled region if necessary.

### Mobile, below 768px

- Headline, three facts, and primary action stack in that order.
- Progress collapses to current and next state.
- Candidate lanes appear first.
- Live comparison appears second.
- Execution log defaults to the latest three items with `Show all activity`.
- Evidence chain becomes a vertical checked list.
- Technical evidence opens as a separate page view, not a wall of stacked tables.
- Touch targets are at least 44px and body text remains at least 16px.

## Accessibility

- Landmarks and heading order tell the same story as the visual layout.
- The live canvas has a concise `aria-label`: “Live run evidence.”
- Latest-event announcements are terse; the full log is not an `aria-live` region.
- Candidate status does not rely on red/green alone.
- Raw JSON uses wrapping and horizontal scrolling only inside its own disclosed region.
- Focus stays on the selected candidate control when its content changes.
- The view switcher, disclosure buttons, and approval controls all have visible focus states.

## Honest-data rules

- Never invent sandbox metrics, scan findings, replay counts, or evidence states.
- Missing values say `Not reported` with upstream context.
- Environment errors render as `ENVIRONMENT_ERROR`; the verdict remains `INCONCLUSIVE`.
- RocketRide narration may be absent without affecting the verdict display.
- Forge rule-list failure may fall back to committed rules, clearly labeled.
- The verdict is rendered from the deterministic policy result only.

## Implementation boundaries

- UI work stays in `apps/web`; fixture/corpus work stays in `packages/fixture`.
- Do not edit frozen `packages/contracts`.
- Preserve the current mock SSE stream as the canonical UI integration fixture.
- Import shared types from `@intentguard/contracts` and keep UI-only types local.
- Preserve strict TypeScript and environment parsing in `apps/web/src/lib/env.ts`.
- Do not add new third-party product integrations or synthetic demo evidence.

## Acceptance criteria

1. A person unfamiliar with IntentGuard can explain what is being checked and which candidate won after viewing the first screen for five seconds.
2. The live execution canvas visibly updates from existing run events and never requires synthetic state.
3. Candidate A/B/C selection changes the comparison and explanation while preserving accessibility.
4. The default overview contains no raw JSON table, sandbox register, full digest, or canonical event wall.
5. All detailed evidence remains reachable in one obvious action.
6. At 375px, Candidate race → Live comparison → Latest activity → Evidence chain form a coherent story without horizontal page scrolling.
7. Idle, evaluating, recommend, blocked, inconclusive, approved, and error states remain honest and comprehensible.
8. Existing web behaviors and tests remain intact; typecheck, tests, and build pass after implementation.

## Agent handoff prompt

Read `AGENTS.md`, `README.md`, `apps/web/README.md`, and this file before changing UI code. Implement the Guided Control Room in `apps/web` without changing contracts or fabricating data. Make Overview the default and place the current dense ledger, register, timeline, policy details, and approval receipt under Technical evidence. Derive every canvas state from the existing sorted event view. Preserve candidate auto-selection rules, timeline sequence ordering, approval constraints, error visibility, and accessibility. Verify at 375, 768, 1024, and 1440 pixels, then run the web typecheck, tests, and build.
