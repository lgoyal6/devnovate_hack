# Brief: Bryan, the fixture and the interface

You own everything being tested and everything the user sees: the legacy system, the three candidates, the corpus generator, the replay harness, and the UI. You do not touch Daytona, Snyk, RocketRide, the policy engine, or the comparison logic.

Read `intentguard-shared-contracts.md` first. Your fixture blocks Laksh, so it ships first.

## Tonight, part one: the legacy system, by 21:00

A Python 2.7 refund and fee service. Roughly 300 to 500 lines, no framework, HTTP over the standard library, JSON in and out, SQLite or an in-memory store. It must start with one command and expose `/health`.

Write it the way a real 2009 system looks: no type hints, inconsistent naming, a few commented-out blocks, a function that is 90 lines long. That texture matters, because a judge glancing at the screen should recognise it instantly.

The rules, and the whole demo depends on the last three being ones nobody would guess:

| ID | Rule |
|---|---|
| REQ-001 | Refunds over $500 require the `finance_admin` role |
| REQ-007 | Every approval writes an audit record with actor, action, refund ID, timestamp |
| REQ-014 | Amounts from $500.00 to $500.99 are treated as under the threshold, because a 2009 truncation bug that downstream reconciliation now depends on |
| REQ-022 | Approvals on the last business day of a month skip the role check, a 2011 hotfix that was never removed |
| REQ-031 | Negative amounts are accepted and silently clamped to zero rather than rejected |

Implement REQ-014 as an actual truncation in the code, not as a special case with a comment saying "bug." It should look like an accident, because that is what it is.

Push by 21:00 so Laksh can point Forge at it.

## Tonight, part two: the candidates, by 23:00

Laksh generates these with Forge. You verify behavior by hand and pin the commits.

- **A**: clean, modern, and it fixes the rounding. Diverges on REQ-014 and REQ-031. This is the candidate any good engineer would write, which is the point.
- **B**: matches legacy behavior exactly, contains one security issue that Snyk reliably flags at high or critical. Coordinate the pattern with Neel; he tests what actually fires.
- **C**: matches legacy behavior exactly, clean scan.

Verify by hand: run each against `$499.99`, `$500.00`, `$500.49`, `$500.99`, `$501.00`, a last-business-day date, and `-50.00`. Write the expected results into `fixtures/expected.json`.

## Hour 0 to 1: UI shell

Build the whole interface against `apps/control/src/mock-run.ts`, which Laksh ships in his first hour. It streams real SSE events with realistic timing, including a divergence and a security block, so you are developing against a live run rather than a static file. You are not blocked by anyone all morning, and integration should mean deleting the mock, not rewriting your components.

### Design direction

The subject is enterprise reconciliation. The artifact this product replaces is a business analyst's spreadsheet of test cases, and the artifact it produces is a signed approval packet. Design from that world, not from the dev-tool dashboard world.

**Palette**, greenbar accounting paper, which is where the alternating-row device actually comes from:

```
--paper:      #F7F8F4    page
--band:       #E4EBDF    alternating ledger band
--ink:        #16211B    primary text
--ink-soft:   #5C6B62    secondary text
--rule:       #C3CDC0    hairlines
--divergent:  #8C2E2A    red pen, divergence and failure
--sealed:     #2F3A8F    stamp blue, approval only
```

Nothing else. The blue appears exactly once in the entire app, on the approval stamp.

**Type**: IBM Plex. Plex was drawn for IBM, the subject is mainframe-era enterprise software, so it is a justified choice rather than a default. Plex Mono for every value, ID, SHA, timestamp and diff, since all of it is data. Plex Sans for prose. Plex Sans Condensed 600, uppercase, wide tracking for section labels.

**Signature element**: the reconciliation ledger. Legacy value and candidate value sit in paired columns on alternating greenbar rows. When they match, the row is quiet. When they diverge, the row gets a red hairline on the left, the two values sit side by side in mono with the differing characters marked, and the rule ID stamps into the left margin. This is the one thing the demo is remembered by, so it gets your time. Everything else stays plain.

**Motion**: one idea only. Evidence rows resolve in sequence as SSE events arrive, like a printout advancing line by line. No fades on load, no spring physics, no counters ticking up. Respect `prefers-reduced-motion`.

### Things that will make it look AI-generated, do not do them

Gradient headers. Purple or indigo anything. Rounded-2xl cards with soft drop shadows floating on a grey page. Emoji as icons. A centred hero with a big number and a small label. Untouched shadcn defaults. Inter. Glassmorphism. A dark mode nobody asked for. Three evenly spaced feature cards.

### Copy

Plain, active, no selling. "Evaluate candidates," not "Launch AI-powered analysis." A failure says what diverged and on which input, in the interface's voice, without apologising. The empty state before a run is an instruction, not a decoration.

## Hour 1 to 2: corpus and replay

```ts
generateCorpus(rules: Rule[]): CorpusInput[]
```

Read `forge/rules.json` and emit inputs from each rule's `boundaries` array. For REQ-014 that means five inputs around the threshold. Random fuzzing never finds REQ-014, which is exactly why the boundary approach is the technically interesting part of the build and worth saying out loud.

```ts
replay(previewUrl, corpus, candidateId): Promise<RawResult[]>
```

Fire the corpus at a preview URL, collect status, body and latency. Fixed timeout per request. Never mutate the body. Laksh's comparison engine does all interpretation; you return raw results only.

## Hour 2 to 3: live timeline

Subscribe to `/api/runs/:id/events`, render in `seq` order, never arrival order. Show sandbox IDs, snapshot ID, commit SHAs and resource allocation as soon as they arrive, because identical environment metadata across candidates is a judged property and it needs to be visible.

Tag every row with its `source`. Forge, Daytona, Snyk and RocketRide each get a small mono label in the left margin, set in `--ink-soft` so it reads as metadata rather than branding. A judge from Daytona should be able to watch their own product working without you narrating it.

Include the live sandbox count. Watching it climb to four and fall to zero earns real points.

## Hour 4 to 5: the ledger

The reconciliation view described above. This is the screen the demo lives on. Budget the whole hour.

## Hour 5 to 6: verdict and approval

Verdict panel with the deterministic result first and the RocketRide explanation beneath it, visually subordinate, because the machine decided and the model explained. Approval panel: reviewer name, comment, then the stamp showing digest, policy version, sandbox IDs and timestamp.

## Hour 6 to 7

Empty state, error state, and a working state that still reads well when the run is halfway done. Keyboard focus visible, responsive down to a laptop screen, since you may be presenting on someone else's display.

## Hour 7 to 8

Record the backup video the moment the full demo works. Not at the end.

## Do not

Put business logic in the UI. Interpret raw results. Call Daytona, Snyk or RocketRide directly. Add a chart nobody asked for.
