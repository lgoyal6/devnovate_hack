import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Server } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANDIDATE_IDS = ["legacy", "A", "B", "C"] as const;
const EXPECTED_CASE_COUNT = 7;
const EXPECTED_OUTCOME_COUNT = EXPECTED_CASE_COUNT * CANDIDATE_IDS.length;
const EXPECTED_AUDIT_COUNTS: Readonly<Record<CandidateId, number>> = {
  legacy: 6,
  A: 3,
  B: 6,
  C: 6,
};
const HEALTH_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_CAPTURED_LOG_CHARS = 20_000;

type CandidateId = (typeof CANDIDATE_IDS)[number];
type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

interface JsonObject {
  [key: string]: JsonValue;
}

interface ExpectedOutcome {
  readonly status: number;
  readonly body: JsonValue;
}

type ExpectedByCandidate = {
  readonly [Candidate in CandidateId]: ExpectedOutcome;
};

interface ExpectedCase {
  readonly id: string;
  readonly payload: JsonObject;
  readonly expected: ExpectedByCandidate;
}

interface ExpectedFixture {
  readonly method: "POST";
  readonly path: string;
  readonly cases: readonly ExpectedCase[];
}

interface ServiceSpec {
  readonly candidateId: CandidateId;
  readonly scriptPath: string;
}

interface CapturedLogs {
  stderr: string;
  stdout: string;
}

interface RunningService {
  readonly child: ChildProcess;
  readonly exitPromise: Promise<void>;
  readonly getSpawnError: () => Error | undefined;
  readonly isClosed: () => boolean;
  readonly logs: CapturedLogs;
}

interface HttpResult {
  readonly status: number;
  readonly body: JsonValue;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const scriptParentDirectory = dirname(scriptDirectory);
const fixturePackageRoot =
  basename(scriptParentDirectory) === "dist"
    ? dirname(scriptParentDirectory)
    : scriptParentDirectory;
const repositoryRoot = resolve(fixturePackageRoot, "..", "..");
const expectedFixturePath = join(repositoryRoot, "fixtures", "expected.json");

const serviceSpecs: readonly ServiceSpec[] = [
  {
    candidateId: "legacy",
    scriptPath: join(fixturePackageRoot, "legacy", "server.py"),
  },
  {
    candidateId: "A",
    scriptPath: join(fixturePackageRoot, "candidates", "A", "server.py"),
  },
  {
    candidateId: "B",
    scriptPath: join(fixturePackageRoot, "candidates", "B", "server.py"),
  },
  {
    candidateId: "C",
    scriptPath: join(fixturePackageRoot, "candidates", "C", "server.py"),
  },
];

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return value;
}

function requireField(
  record: Record<string, unknown>,
  field: string,
  context: string,
): unknown {
  if (!(field in record)) {
    throw new TypeError(`${context}.${field} is required`);
  }
  return record[field];
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
}

function requireStatus(value: unknown, context: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 100 ||
    value > 599
  ) {
    throw new TypeError(`${context} must be an HTTP status code`);
  }
  return value;
}

function toJsonValue(value: unknown, context: string): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${context} contains a non-finite number`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      toJsonValue(entry, `${context}[${String(index)}]`),
    );
  }

  if (isUnknownRecord(value)) {
    const object: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      object[key] = toJsonValue(entry, `${context}.${key}`);
    }
    return object;
  }

  throw new TypeError(`${context} is not a JSON value`);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue): value is JsonValue[] {
  return Array.isArray(value);
}

function parseOutcome(value: unknown, context: string): ExpectedOutcome {
  const record = requireRecord(value, context);
  return {
    status: requireStatus(requireField(record, "status", context), `${context}.status`),
    body: toJsonValue(requireField(record, "body", context), `${context}.body`),
  };
}

function parseExpectedCase(value: unknown, index: number): ExpectedCase {
  const context = `expected.cases[${String(index)}]`;
  const record = requireRecord(value, context);
  const payloadValue = toJsonValue(
    requireField(record, "payload", context),
    `${context}.payload`,
  );
  if (!isJsonObject(payloadValue)) {
    throw new TypeError(`${context}.payload must be an object`);
  }

  const expectedRecord = requireRecord(
    requireField(record, "expected", context),
    `${context}.expected`,
  );
  const expected: ExpectedByCandidate = {
    legacy: parseOutcome(
      requireField(expectedRecord, "legacy", `${context}.expected`),
      `${context}.expected.legacy`,
    ),
    A: parseOutcome(
      requireField(expectedRecord, "A", `${context}.expected`),
      `${context}.expected.A`,
    ),
    B: parseOutcome(
      requireField(expectedRecord, "B", `${context}.expected`),
      `${context}.expected.B`,
    ),
    C: parseOutcome(
      requireField(expectedRecord, "C", `${context}.expected`),
      `${context}.expected.C`,
    ),
  };

  return {
    id: requireString(requireField(record, "id", context), `${context}.id`),
    payload: payloadValue,
    expected,
  };
}

async function loadExpectedFixture(): Promise<ExpectedFixture> {
  const source = await readFile(expectedFixturePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw new Error(`Could not parse ${expectedFixturePath}`, { cause: error });
  }

  const record = requireRecord(parsed, "expected");
  const schemaVersion = requireField(record, "schemaVersion", "expected");
  if (schemaVersion !== 1) {
    throw new TypeError("expected.schemaVersion must be 1");
  }

  const method = requireString(
    requireField(record, "method", "expected"),
    "expected.method",
  );
  if (method !== "POST") {
    throw new TypeError("expected.method must be POST");
  }

  const rawCases = requireField(record, "cases", "expected");
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new TypeError("expected.cases must be a non-empty array");
  }
  const cases = rawCases.map((testCase, index) =>
    parseExpectedCase(testCase, index),
  );
  assert.equal(cases.length, EXPECTED_CASE_COUNT, "pinned fixture case count");
  assert.equal(
    cases.length * CANDIDATE_IDS.length,
    EXPECTED_OUTCOME_COUNT,
    "pinned fixture outcome count",
  );
  const caseIds = new Set(cases.map((testCase) => testCase.id));
  if (caseIds.size !== cases.length) {
    throw new TypeError("expected.cases contains duplicate ids");
  }

  return {
    method,
    path: requireString(
      requireField(record, "path", "expected"),
      "expected.path",
    ),
    cases,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      reject(error);
    };
    server.once("error", handleError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", handleError);
      resolve();
    });
  });

  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Could not determine allocated localhost port");
    }
    return (address as AddressInfo).port;
  } finally {
    await closeServer(server);
  }
}

function appendLog(current: string, chunk: string): string {
  return (current + chunk).slice(-MAX_CAPTURED_LOG_CHARS);
}

function startService(
  spec: ServiceSpec,
  pythonExecutable: string,
  port: number,
): RunningService {
  const child = spawn(
    pythonExecutable,
    [spec.scriptPath, "--bind", "127.0.0.1", "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const logs: CapturedLogs = { stderr: "", stdout: "" };
  let closed = false;
  let spawnError: Error | undefined;

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    logs.stdout = appendLog(logs.stdout, chunk);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    logs.stderr = appendLog(logs.stderr, chunk);
  });
  child.once("error", (error: Error) => {
    spawnError = error;
  });
  const exitPromise = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });

  return {
    child,
    exitPromise,
    getSpawnError: () => spawnError,
    isClosed: () => closed,
    logs,
  };
}

function formatLogs(running: RunningService): string {
  const stdout = running.logs.stdout.trim() || "<empty>";
  const stderr = running.logs.stderr.trim() || "<empty>";
  return `stdout:\n${stdout}\nstderr:\n${stderr}`;
}

function describeUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function requestJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const source = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error: unknown) {
      throw new Error(`Response from ${url} was not JSON: ${source}`, {
        cause: error,
      });
    }
    return {
      status: response.status,
      body: toJsonValue(parsed, `response from ${url}`),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForHealth(
  running: RunningService,
  candidateId: CandidateId,
  baseUrl: string,
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastFailure: unknown = new Error("health request has not run");

  while (Date.now() < deadline) {
    const spawnError = running.getSpawnError();
    if (spawnError !== undefined) {
      throw new Error(`Could not start ${candidateId} service`, {
        cause: spawnError,
      });
    }
    if (running.isClosed()) {
      throw new Error(
        `${candidateId} exited before becoming healthy\n${formatLogs(running)}`,
      );
    }

    try {
      const health = await requestJson(`${baseUrl}/health`, {}, 500);
      if (
        health.status === 200 &&
        isJsonObject(health.body) &&
        health.body.status === "ok"
      ) {
        return;
      }
      lastFailure = new Error(
        `Unexpected health response: ${JSON.stringify(health)}`,
      );
    } catch (error: unknown) {
      lastFailure = error;
    }
    await delay(75);
  }

  throw new Error(
    `${candidateId} did not become healthy: ${describeUnknown(lastFailure)}\n` +
      formatLogs(running),
  );
}

async function resolvesWithin(
  promise: Promise<void>,
  milliseconds: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      }
    };
    const timeout = setTimeout(() => {
      finish(false);
    }, milliseconds);
    void promise.then(() => {
      finish(true);
    });
  });
}

async function terminateService(running: RunningService): Promise<void> {
  if (running.isClosed()) {
    await running.exitPromise;
    return;
  }

  running.child.kill("SIGTERM");
  if (await resolvesWithin(running.exitPromise, 2_000)) {
    return;
  }

  running.child.kill("SIGKILL");
  if (!(await resolvesWithin(running.exitPromise, 2_000))) {
    throw new Error(
      `Service process ${String(running.child.pid)} did not terminate`,
    );
  }
}

function expectedAuditRecords(
  fixture: ExpectedFixture,
  candidateId: CandidateId,
): JsonObject[] {
  const audits: JsonObject[] = [];
  for (const testCase of fixture.cases) {
    const body = testCase.expected[candidateId].body;
    if (isJsonObject(body) && body.approved === true) {
      const audit = body.audit;
      if (audit === undefined || !isJsonObject(audit)) {
        throw new TypeError(
          `${testCase.id}/${candidateId} is approved without an audit object`,
        );
      }
      audits.push(audit);
    }
  }
  return audits;
}

async function replayExpectedCases(
  running: RunningService,
  spec: ServiceSpec,
  fixture: ExpectedFixture,
  baseUrl: string,
): Promise<number> {
  for (const testCase of fixture.cases) {
    if (running.isClosed()) {
      throw new Error(
        `${spec.candidateId} exited during ${testCase.id}\n${formatLogs(running)}`,
      );
    }
    const actual = await requestJson(`${baseUrl}${fixture.path}`, {
      method: fixture.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(testCase.payload),
    });
    const expected = testCase.expected[spec.candidateId];
    assert.equal(
      actual.status,
      expected.status,
      `${spec.candidateId}/${testCase.id} status`,
    );
    assert.deepStrictEqual(
      actual.body,
      expected.body,
      `${spec.candidateId}/${testCase.id} body`,
    );
  }

  const expectedAudits = expectedAuditRecords(fixture, spec.candidateId);
  const auditResponse = await requestJson(`${baseUrl}/audit`);
  assert.equal(auditResponse.status, 200, `${spec.candidateId}/audit status`);
  if (!isJsonObject(auditResponse.body)) {
    throw new TypeError(`${spec.candidateId}/audit body must be an object`);
  }
  const records = auditResponse.body.records;
  if (records === undefined || !isJsonArray(records)) {
    throw new TypeError(`${spec.candidateId}/audit records must be an array`);
  }
  assert.equal(
    records.length,
    expectedAudits.length,
    `${spec.candidateId}/audit record count`,
  );
  assert.equal(
    records.length,
    EXPECTED_AUDIT_COUNTS[spec.candidateId],
    `${spec.candidateId}/pinned audit total`,
  );
  assert.deepStrictEqual(
    records,
    expectedAudits,
    `${spec.candidateId}/audit records`,
  );
  return records.length;
}

async function testService(
  spec: ServiceSpec,
  fixture: ExpectedFixture,
  pythonExecutable: string,
): Promise<void> {
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const running = startService(spec, pythonExecutable, port);

  try {
    await waitForHealth(running, spec.candidateId, baseUrl);
    const auditCount = await replayExpectedCases(
      running,
      spec,
      fixture,
      baseUrl,
    );
    console.log(
      `${spec.candidateId} service smoke passed: ` +
        `${String(fixture.cases.length)} cases, ${String(auditCount)} audit records`,
    );
  } finally {
    await terminateService(running);
    assert.equal(running.isClosed(), true, `${spec.candidateId} process teardown`);
  }
}

async function main(): Promise<void> {
  const pythonExecutable = process.argv[2] ?? "python";
  const fixture = await loadExpectedFixture();

  for (const spec of serviceSpecs) {
    await testService(spec, fixture, pythonExecutable);
  }

  console.log(
    `service regression smoke test passed: ${String(EXPECTED_OUTCOME_COUNT)} pinned outcomes`,
  );
}

main().catch((error: unknown) => {
  console.error("service regression smoke test failed", error);
  process.exitCode = 1;
});
