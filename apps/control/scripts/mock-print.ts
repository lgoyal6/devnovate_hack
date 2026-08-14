/**
 * Print the mock run to stdout with realistic delays.
 *
 *   pnpm mock
 *   pnpm mock -- --speed=6
 *   pnpm mock -- --json | jq
 */
import { buildMockRun, streamMockRun } from "../src/mock-run.js";

const args = process.argv.slice(2);
const speedArg = args.find((a) => a.startsWith("--speed="));
const speed = speedArg ? Number(speedArg.split("=")[1]) : 1;
const asJson = args.includes("--json");
const runId = args.find((a) => !a.startsWith("--")) ?? "mock-run-001";

if (!Number.isFinite(speed) || speed <= 0) {
  console.error(`Invalid --speed. Expected a positive number, got ${speedArg}.`);
  process.exit(2);
}

if (asJson) {
  const { events, snapshot, durationMs } = buildMockRun(runId, 0);
  console.log(JSON.stringify({ events, snapshot, durationMs }, null, 2));
} else {
  const { events, durationMs } = buildMockRun(runId, 0);
  console.error(
    `${events.length} events, ${(durationMs / 1000 / speed).toFixed(1)}s at speed ${speed}\n`,
  );
  for await (const event of streamMockRun(runId, { speed })) {
    const who = event.candidateId ? ` ${event.candidateId}` : "";
    console.log(
      `${String(event.seq).padStart(2, " ")}  ${event.source.padEnd(10)} ${event.type.padEnd(18)}${who.padEnd(8)} ${event.message}`,
    );
  }
}
