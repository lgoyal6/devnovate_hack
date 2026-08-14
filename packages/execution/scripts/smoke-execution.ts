import assert from "node:assert/strict";
import type {
  CandidateId,
  GateResult,
  RunEvent,
  ScanResult,
  Verdict,
} from "@intentguard/contracts";
import {
  type ProvisionConfig,
  type RocketRideConfig,
  validateRepositoryTargets,
} from "../src/lib/env.js";
import type {
  DaytonaPort,
  NarratorPort,
  PendingExecutionEvent,
  RuntimeDependencies,
  SandboxPort,
} from "../src/lib/ports.js";
import { ExecutionRuntime } from "../src/runtime.js";
import { parseSnykResult } from "../src/snyk.js";

const trace: string[] = [];
const fakeSnykToken = "snyk-token-must-never-leak";

class FakeSandbox implements SandboxPort {
  readonly createdAt = "2026-08-14T12:00:00.000Z";
  readonly deleted: string[] = [];

  constructor(
    readonly id: string,
    private readonly snykOutput: string,
    private readonly snykExit = 0,
    private readonly installExit = 0,
  ) {}

  async clone(_url: string, clonePath: string, commitSha: string): Promise<void> {
    trace.push(`${this.id}:clone:${clonePath}:${commitSha}`);
  }

  async resize(resources: { cpu: number; memory: number; disk: number }, timeoutSeconds: number): Promise<void> {
    trace.push(`${this.id}:resize:${JSON.stringify(resources)}:${String(timeoutSeconds)}`);
  }

  async execute(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutSeconds: number,
  ): Promise<{ exitCode: number; output: string }> {
    trace.push(`${this.id}:execute:${cwd}:${command}:${Object.keys(env).join(",")}:${String(timeoutSeconds)}`);
    if (command.includes("snyk")) return { exitCode: this.snykExit, output: this.snykOutput };
    return { exitCode: this.installExit, output: this.installExit === 0 ? "installed" : "install failed" };
  }

  async start(command: string, timeoutSeconds: number): Promise<void> {
    trace.push(`${this.id}:start:${command}:${String(timeoutSeconds)}`);
  }

  async signedPreviewUrl(port: number, expiresInSeconds: number): Promise<string> {
    trace.push(`${this.id}:preview:${String(port)}:${String(expiresInSeconds)}`);
    return `https://${String(port)}-fake-signed-token.${this.id}.example.test/`;
  }

  async delete(): Promise<void> {
    this.deleted.push(this.id);
    trace.push(`${this.id}:delete`);
  }
}

class FakeDaytona implements DaytonaPort {
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly listQueries: Record<string, string>[] = [];

  constructor(private readonly failInstallCandidate?: string) {}

  async create(
    input: {
      name: string;
      snapshotId: string;
      labels: Record<string, string>;
      ttlMinutes: number;
      networkAllowList: string;
    },
    timeoutSeconds: number,
  ): Promise<SandboxPort> {
    const candidateId = input.labels.candidateId ?? "unknown";
    trace.push(`create:${candidateId}:${input.snapshotId}:${String(input.ttlMinutes)}:${input.networkAllowList}:${String(timeoutSeconds)}`);
    const output = candidateId === "B"
      ? JSON.stringify({
        diagnostic: { echoedToken: fakeSnykToken },
        vulnerabilities: [{
          id: "SNYK-CMDI-001",
          severity: "high",
          title: `Command injection (${fakeSnykToken})`,
          file: "server.py",
          line: 231,
        }],
      })
      : JSON.stringify({ vulnerabilities: [] });
    const sandbox = new FakeSandbox(
      `sb-${candidateId}`,
      output,
      candidateId === "B" ? 1 : 0,
      candidateId === this.failInstallCandidate ? 9 : 0,
    );
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async *list(labels: Record<string, string>): AsyncIterable<SandboxPort> {
    this.listQueries.push(labels);
    yield* this.sandboxes.values();
  }
}

class FakeNarrator implements NarratorPort {
  async narrate(verdict: Verdict, gates: GateResult[]): Promise<string> {
    assert.equal(verdict.outcome, "RECOMMEND");
    assert.equal(gates.length, 1);
    return "Candidate C is recommended because every blocking gate passed.";
  }

  async close(): Promise<void> {
    trace.push("narrator:close");
  }
}

const provisionConfig: ProvisionConfig = {
  daytona: {
    apiKey: "test",
    apiUrl: "https://daytona.example.test/api",
    target: "us",
    resources: { cpu: 2, memory: 4, disk: 20 },
    ttlMinutes: 45,
    createTimeoutSeconds: 30,
    commandTimeoutSeconds: 30,
    previewTtlSeconds: 3600,
  },
  repositories: {
    legacy: { url: "https://example.test/intentguard.git", commitSha: "1111111111111111111111111111111111111111" },
    A: { url: "https://example.test/intentguard.git", commitSha: "1111111111111111111111111111111111111111" },
    B: { url: "https://example.test/intentguard.git", commitSha: "1111111111111111111111111111111111111111" },
    C: { url: "https://example.test/intentguard.git", commitSha: "1111111111111111111111111111111111111111" },
  },
  repositoryDir: "/workspace/app",
  installCommand: "python3 -m compileall -q .",
  appPort: 8080,
  healthPath: "/health",
  healthTimeoutSeconds: 2,
  healthPollMs: 1,
  networkAllowList: "example.test",
  snyk: { token: fakeSnykToken, cliPath: "snyk", timeoutSeconds: 30 },
};

const rocketRideConfig: RocketRideConfig = {
  ROCKETRIDE_API_KEY: "test",
  ROCKETRIDE_URI: "https://rocketride.example.test",
  ROCKETRIDE_PIPELINE_PATH: "narrate.pipe",
  ROCKETRIDE_REQUEST_TIMEOUT_MS: 1000,
  ROCKETRIDE_PIPELINE_TTL_SECONDS: 60,
};

const events: Array<{ runId: string; event: PendingExecutionEvent }> = [];
const daytona = new FakeDaytona();
const dependencies: RuntimeDependencies = {
  loadProvisionConfig: () => provisionConfig,
  loadDaytonaConfig: () => provisionConfig.daytona,
  createDaytona: () => daytona,
  loadRocketRideConfig: () => rocketRideConfig,
  createNarrator: () => new FakeNarrator(),
  emitEvent: (runId, event) => events.push({ runId, event }),
  fetch: async () => new Response("ok", { status: 200 }),
  now: () => new Date("2026-08-14T12:00:00.000Z"),
  sleep: async () => undefined,
};

const runtime = new ExecutionRuntime(dependencies);
const refs = await runtime.provision("run-smoke", ["legacy", "A", "B", "C"], "snap-1");
assert.deepEqual(refs.map((ref) => ref.candidateId), ["legacy", "A", "B", "C"]);
assert.ok(refs.every((ref) => ref.snapshotId === "snap-1" && ref.previewUrl.includes("fake-signed-token")));
const sourcePaths: Record<string, string> = {
  legacy: "/workspace/app/packages/fixture/legacy",
  A: "/workspace/app/packages/fixture/candidates/A",
  B: "/workspace/app/packages/fixture/candidates/B",
  C: "/workspace/app/packages/fixture/candidates/C",
};
for (const candidateId of ["legacy", "A", "B", "C"]) {
  const sourcePath = sourcePaths[candidateId];
  assert.ok(sourcePath !== undefined);
  assert.ok(trace.includes(`sb-${candidateId}:clone:/workspace/app:1111111111111111111111111111111111111111`));
  assert.ok(trace.includes(`sb-${candidateId}:execute:${sourcePath}:python3 -m compileall -q .::30`));
  assert.ok(trace.includes(
    `sb-${candidateId}:start:cd -- '${sourcePath}' && exec python3 'server.py' --port 8080:30`,
  ));
  assert.ok(trace.includes(`create:${candidateId}:snap-1:45:example.test:30`));
  assert.ok(trace.includes(`sb-${candidateId}:resize:{"cpu":2,"memory":4,"disk":20}:30`));
  assert.ok(trace.includes(`sb-${candidateId}:preview:8080:3600`));
}
assert.ok(!trace.some((entry) => entry.startsWith("sb-legacy:execute:") && entry.includes(":snyk ")));
for (const candidateId of ["A", "B", "C"]) {
  const sourcePath = sourcePaths[candidateId];
  const scanIndex = trace.findIndex((entry) =>
    entry === `sb-${candidateId}:execute:${sourcePath}:snyk code test --json:SNYK_TOKEN:30`
  );
  const installIndex = trace.findIndex((entry) =>
    entry === `sb-${candidateId}:execute:${sourcePath}:python3 -m compileall -q .::30`
  );
  const startIndex = trace.findIndex((entry) =>
    entry === `sb-${candidateId}:start:cd -- '${sourcePath}' && exec python3 'server.py' --port 8080:30`
  );
  assert.ok(scanIndex >= 0 && scanIndex < startIndex, `${candidateId} must be scanned before app start`);
  assert.ok(scanIndex < installIndex, `${candidateId} must be scanned before source preparation`);
}
const bRef = refs.find((ref) => ref.candidateId === "B");
assert.ok(bRef !== undefined);
const scan = await runtime.scan("run-smoke", bRef);
assert.equal(scan.status, "FINDINGS");
assert.equal(scan.findings[0]?.id, "SNYK-CMDI-001");
assert.equal(JSON.stringify(scan.raw).includes(fakeSnykToken), false);
assert.equal(JSON.stringify(scan).includes(fakeSnykToken), false);
assert.match(scan.findings[0]?.title ?? "", /\[REDACTED SNYK_TOKEN\]/);
const emittedScan = events.find(({ event }) =>
  event.type === "SCAN_COMPLETE" && event.candidateId === "B"
);
assert.ok(emittedScan !== undefined);
assert.equal(JSON.stringify(emittedScan.event.payload).includes(fakeSnykToken), false);
assert.match(JSON.stringify(emittedScan.event.payload), /\[REDACTED SNYK_TOKEN\]/);
const legacyRef = refs.find((ref) => ref.candidateId === "legacy");
assert.ok(legacyRef !== undefined);
await assert.rejects(runtime.scan("run-smoke", legacyRef), /not Snyk-scanned/);
const verdict: Verdict = {
  outcome: "RECOMMEND",
  recommended: "C",
  perCandidate: [{ candidateId: "C", eligible: true, reasons: [] }],
  policyVersion: "policy-1",
};
const gates: GateResult[] = [{
  candidateId: "C",
  key: "security",
  category: "security",
  status: "PASS",
  detail: "clean",
}];
const narration = await runtime.narrate("run-smoke", verdict, gates);
assert.match(narration, /Candidate C/);
await runtime.teardown("run-smoke");
await runtime.teardown("run-smoke");
assert.ok([...daytona.sandboxes.values()].every((sandbox) => sandbox.deleted.length === 1));
assert.equal(events.filter(({ event }) => event.type === "TORN_DOWN").length, 1);

const clean = parseSnykResult("C", { exitCode: 0, output: JSON.stringify({ vulnerabilities: [] }) });
const malformed = parseSnykResult(
  "C",
  { exitCode: 0, output: `not json ${fakeSnykToken}` },
  [fakeSnykToken],
);
const crashed = parseSnykResult(
  "C",
  { exitCode: 2, output: JSON.stringify({ error: `offline: ${fakeSnykToken}` }) },
  [fakeSnykToken],
);
const sarifFinding = parseSnykResult("B", {
  exitCode: 1,
  output: JSON.stringify({
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          rules: [{
            id: "SNYK-PYTHON-CMDINJECTION-001",
            shortDescription: { text: "Command injection" },
          }],
        },
      },
      results: [{
        ruleId: "SNYK-PYTHON-CMDINJECTION-001",
        level: "error",
        message: { text: "Unsanitized input reaches a shell command." },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: "server.py" },
            region: { startLine: 231 },
          },
        }],
      }],
    }],
  }),
});
const sarifClean = parseSnykResult("C", {
  exitCode: 0,
  output: JSON.stringify({
    version: "2.1.0",
    runs: [{ tool: { driver: {} }, results: [] }],
  }),
});
const unknownShape = parseSnykResult("C", { exitCode: 0, output: JSON.stringify({ ok: true }) });
assert.equal(clean.status, "CLEAN");
assert.equal(malformed.status, "ERROR");
assert.equal(crashed.status, "ERROR");
assert.equal(JSON.stringify(malformed.raw).includes(fakeSnykToken), false);
assert.equal(JSON.stringify(crashed.raw).includes(fakeSnykToken), false);
assert.equal(sarifFinding.status, "FINDINGS");
assert.equal(sarifFinding.findings[0]?.severity, "high");
assert.equal(sarifFinding.findings[0]?.id, "SNYK-PYTHON-CMDINJECTION-001");
assert.equal(sarifClean.status, "CLEAN");
assert.equal(unknownShape.status, "ERROR");
assert.ok(events.some(({ event }) => event.type === "SANDBOX_CREATED" && event.source === "daytona"));
assert.ok(events.some(({ event }) => event.type === "SCAN_COMPLETE" && event.source === "snyk"));
assert.ok(events.some(({ event }) => event.type === "NARRATED" && event.source === "rocketride"));

const degradedEvents: Array<Omit<RunEvent, "seq" | "ts">> = [];
const degradedRuntime = new ExecutionRuntime({
  ...dependencies,
  createNarrator: () => { throw new Error("service unavailable"); },
  emitEvent: (_runId, event) => degradedEvents.push(event),
});
const degraded = await degradedRuntime.narrate("run-degraded", verdict, gates);
assert.match(degraded, /^Narration unavailable: service unavailable$/);
assert.equal(degradedEvents[0]?.type, "NARRATED");

assert.throws(
  () => validateRepositoryTargets({
    legacy: provisionConfig.repositories.legacy,
    A: provisionConfig.repositories.A,
    B: provisionConfig.repositories.B,
  }),
  /C/,
);
assert.throws(
  () => validateRepositoryTargets({
    ...provisionConfig.repositories,
    D: provisionConfig.repositories.C,
  }),
  /Unrecognized key/,
);
assert.throws(
  () => validateRepositoryTargets({
    ...provisionConfig.repositories,
    B: {
      ...provisionConfig.repositories.B,
      commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  }),
  /same monorepo URL and immutable commit/,
);

const unknownTargetDaytona = new FakeDaytona();
const unknownTargetRuntime = new ExecutionRuntime({
  ...dependencies,
  createDaytona: () => unknownTargetDaytona,
});
await assert.rejects(
  unknownTargetRuntime.provision("run-unknown", ["D"], "snap-1"),
  /Unknown execution candidate target: D/,
);
assert.equal(unknownTargetDaytona.sandboxes.size, 0);

const preflightFailureEvents: Array<{ runId: string; event: PendingExecutionEvent }> = [];
let preflightDaytonaLoads = 0;
let preflightDaytonaCreates = 0;
const preflightFailureRuntime = new ExecutionRuntime({
  ...dependencies,
  loadProvisionConfig: () => {
    throw new Error("local Daytona credentials are invalid");
  },
  loadDaytonaConfig: () => {
    preflightDaytonaLoads += 1;
    throw new Error("teardown must not load credentials for a locally known zero-provider run");
  },
  createDaytona: () => {
    preflightDaytonaCreates += 1;
    throw new Error("teardown must not create a Daytona client for a locally known zero-provider run");
  },
  emitEvent: (runId, event) => preflightFailureEvents.push({ runId, event }),
});
await assert.rejects(
  preflightFailureRuntime.provision("run-preflight-failure", ["legacy"], "snap-1"),
  /local Daytona credentials are invalid/,
);
await preflightFailureRuntime.teardown("run-preflight-failure");
await preflightFailureRuntime.teardown("run-preflight-failure");
assert.equal(preflightDaytonaLoads, 0);
assert.equal(preflightDaytonaCreates, 0);
const preflightTeardowns = preflightFailureEvents.filter(({ event }) => event.type === "TORN_DOWN");
assert.equal(preflightTeardowns.length, 1);
assert.deepEqual(preflightTeardowns[0]?.event.payload, { sandboxCount: 0 });

const orphanDaytona = new FakeDaytona();
const orphan = new FakeSandbox(
  "sb-orphan",
  JSON.stringify({ vulnerabilities: [] }),
);
orphanDaytona.sandboxes.set(orphan.id, orphan);
const restartEvents: Array<{ runId: string; event: PendingExecutionEvent }> = [];
let restartDaytonaLoads = 0;
let restartDaytonaCreates = 0;
const restartedRuntime = new ExecutionRuntime({
  ...dependencies,
  loadDaytonaConfig: () => {
    restartDaytonaLoads += 1;
    return provisionConfig.daytona;
  },
  createDaytona: () => {
    restartDaytonaCreates += 1;
    return orphanDaytona;
  },
  emitEvent: (runId, event) => restartEvents.push({ runId, event }),
});
await restartedRuntime.teardown("run-after-restart");
await restartedRuntime.teardown("run-after-restart");
assert.equal(restartDaytonaLoads, 1);
assert.equal(restartDaytonaCreates, 1);
assert.deepEqual(orphanDaytona.listQueries, [{ application: "intentguard", runId: "run-after-restart" }]);
assert.equal(orphan.deleted.length, 1);
const restartTeardowns = restartEvents.filter(({ event }) => event.type === "TORN_DOWN");
assert.equal(restartTeardowns.length, 1);
assert.deepEqual(restartTeardowns[0]?.event.payload, { sandboxCount: 1 });

const noTokenConfig: ProvisionConfig = {
  ...provisionConfig,
  snyk: { ...provisionConfig.snyk, token: undefined },
};
const noTokenDaytona = new FakeDaytona();
const noTokenRuntime = new ExecutionRuntime({
  ...dependencies,
  loadProvisionConfig: () => noTokenConfig,
  createDaytona: () => noTokenDaytona,
});
const legacyOnlyRefs = await noTokenRuntime.provision("run-legacy-only", ["legacy"], "snap-1");
assert.equal(legacyOnlyRefs.length, 1);
await noTokenRuntime.teardown("run-legacy-only");
await assert.rejects(
  new ExecutionRuntime({
    ...dependencies,
    loadProvisionConfig: () => noTokenConfig,
    createDaytona: () => new FakeDaytona(),
  }).provision("run-missing-token", ["A"], "snap-1"),
  /SNYK_TOKEN is required/,
);

const failingDaytona = new FakeDaytona("B");
const failingRuntime = new ExecutionRuntime({
  ...dependencies,
  createDaytona: () => failingDaytona,
});
await assert.rejects(
  failingRuntime.provision("run-partial-failure", ["legacy", "A", "B", "C"], "snap-1"),
  /Provisioning failed for 1 candidate/,
);
assert.ok([...failingDaytona.sandboxes.values()].every((sandbox) => sandbox.deleted.length === 1));

const statuses: ScanResult["status"][] = [
  clean.status,
  malformed.status,
  crashed.status,
  sarifFinding.status,
  sarifClean.status,
  unknownShape.status,
  scan.status,
];
process.stdout.write(`execution smoke passed: ${String(refs.length)} sandboxes, scans ${statuses.join(", ")}\n`);
