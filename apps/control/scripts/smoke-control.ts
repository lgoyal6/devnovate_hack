/**
 * Smoke test for the control plane's committed surface: the canonical wire
 * format and the evidence digest. Exits non-zero on failure.
 *
 *   pnpm smoke:control
 *
 * Run this before you push a change to mock-run.ts. Bryan's UI is written
 * against these shapes and Neel's adapter emits into them.
 */
import type { RunEvent } from "@intentguard/contracts";
import { canonicalJson, digestEvidence } from "../src/lib/evidence.js";
import {
  MOCK_CORPUS,
  MOCK_GATES,
  MOCK_RULES,
  MOCK_VERDICT,
  buildMockRun,
  mockEvidenceBundle,
  streamMockRun,
} from "../src/mock-run.js";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

const RUN_ID = "smoke-run";
const { events, snapshot } = buildMockRun(RUN_ID, 0);

console.log("\nwire format");

check("events are non-empty", events.length > 0, `got ${events.length}`);

check(
  "seq is monotonic from 1",
  events.every((e, i) => e.seq === i + 1),
  events
    .map((e, i) => (e.seq === i + 1 ? null : `index ${i} has seq ${e.seq}`))
    .filter(Boolean)
    .join(", "),
);

check(
  "ts is non-decreasing",
  events.every((e, i) => i === 0 || Date.parse(e.ts) >= Date.parse(events[i - 1]!.ts)),
);

check(
  "every event has a source and a human readable message",
  events.every((e) => e.source.length > 0 && e.message.trim().length > 0),
);

const sources = new Set(events.map((e) => e.source));
check(
  "all four platforms appear as an event source",
  ["forge", "daytona", "snyk", "rocketride"].every((s) => sources.has(s as RunEvent["source"])),
  `saw ${[...sources].join(", ")}`,
);

const byType = (type: RunEvent["type"]) => events.filter((e) => e.type === type);

check("four sandboxes are created", byType("SANDBOX_CREATED").length === 4);
check("three candidates are scanned", byType("SCAN_COMPLETE").length === 3);
check("four candidates are replayed", byType("CORPUS_REPLAYED").length === 4);
check("exactly one verdict", byType("VERDICT_READY").length === 1);
check("exactly one approval", byType("APPROVED").length === 1);
check(
  "run ends torn down",
  events[events.length - 1]?.type === "TORN_DOWN",
  `last event is ${events[events.length - 1]?.type}`,
);

console.log("\ndivergence");

const divergences = byType("DIVERGENCE_FOUND");
check("exactly one behavioral divergence", divergences.length === 1);
check(
  "divergence is REQ-014 on candidate C",
  divergences[0]?.candidateId === "C" &&
    (divergences[0]?.payload as { ruleId?: string })?.ruleId === "REQ-014",
);
check(
  "divergence message is the projector string",
  divergences[0]?.message ===
    "input IN-0042 (refund 500.49): legacy approved=false, candidate approved=true",
  `got: ${divergences[0]?.message}`,
);
check(
  "REQ-014 is a blocking rule with the five agreed boundaries",
  MOCK_RULES.find((r) => r.id === "REQ-014")?.blocking === true &&
    canonicalJson(MOCK_RULES.find((r) => r.id === "REQ-014")?.boundaries) ===
      canonicalJson(["499.99", "500.00", "500.49", "500.99", "501.00"]),
);
check(
  "the corpus probes every REQ-014 boundary",
  MOCK_CORPUS.filter((i) => i.ruleId === "REQ-014").length ===
    (MOCK_RULES.find((r) => r.id === "REQ-014")?.boundaries.length ?? 0),
);

console.log("\ngates and verdict");

check(
  "every gate key is prefixed by its category",
  MOCK_GATES.every((g) => g.key === g.category || g.key.startsWith(`${g.category}.`)),
);
check(
  "exactly one security gate fails",
  MOCK_GATES.filter((g) => g.category === "security" && g.status === "FAIL").length === 1,
);
check(
  "exactly one behavior gate fails",
  MOCK_GATES.filter((g) => g.category === "behavior" && g.status === "FAIL").length === 1,
);
check("verdict recommends A", MOCK_VERDICT.outcome === "RECOMMEND" && MOCK_VERDICT.recommended === "A");
check(
  "B and C are ineligible with stated reasons",
  MOCK_VERDICT.perCandidate
    .filter((c) => c.candidateId !== "A")
    .every((c) => !c.eligible && c.reasons.length > 0),
);
check(
  "every ineligible candidate has a failure reason on its record",
  snapshot.candidates
    .filter((c) => c.status !== "PASSED")
    .every((c) => c.failureReason !== null && c.failureReason.length > 0),
);

console.log("\nevidence digest");

const digest = digestEvidence(mockEvidenceBundle(RUN_ID));
check("digest is 64 lowercase hex characters", /^[0-9a-f]{64}$/.test(digest), digest);
check(
  "digest is stable across builds",
  digest === digestEvidence(mockEvidenceBundle(RUN_ID)),
);
check(
  "digest is independent of key order",
  canonicalJson({ b: 1, a: { d: 2, c: 3 } }) === canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
);

const tampered = mockEvidenceBundle(RUN_ID);
tampered.gates = tampered.gates.map((g) =>
  g.category === "behavior" && g.status === "FAIL" ? { ...g, status: "PASS" as const } : g,
);
check(
  "tampering with a gate invalidates the digest",
  digestEvidence(tampered) !== digest,
);
check("approval binds to the digest", snapshot.approval?.digest === digest);

console.log("\nstream");

const streamed: RunEvent[] = [];
for await (const event of streamMockRun(RUN_ID, { speed: 400, startedAt: 0 })) {
  streamed.push(event);
}

const withoutTs = (list: RunEvent[]) => list.map(({ ts: _ts, ...rest }) => rest);
check(
  "stream yields the same events as the build",
  canonicalJson(withoutTs(streamed)) === canonicalJson(withoutTs(events)),
  `streamed ${streamed.length}, built ${events.length}`,
);
check(
  "streamed ts is non-decreasing",
  streamed.every((e, i) => i === 0 || Date.parse(e.ts) >= Date.parse(streamed[i - 1]!.ts)),
);
check(
  "streamed ts follows the scaled schedule, not the nominal one",
  Date.parse(streamed[streamed.length - 1]!.ts) - Date.parse(streamed[0]!.ts) <
    (Date.parse(events[events.length - 1]!.ts) - Date.parse(events[0]!.ts)) / 100,
  "a client computing elapsed time from ts must agree with when the event arrived",
);

if (failures > 0) {
  console.error(`\n${failures} check${failures === 1 ? "" : "s"} failed\n`);
  process.exit(1);
}

console.log(`\nall checks passed: ${events.length} events, digest ${digest.slice(0, 12)}\n`);
