import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunEvent } from "@intentguard/contracts";
import {
  configureEventWriter,
  resetEventWriter,
} from "@intentguard/control/events";

import {
  generateCorpus,
  replay,
  REPLAY_TIMEOUT_MS,
  ReplayRequestError,
  type CorpusInput,
  type Rule,
} from "../src/index.js";

const RUN_ID = "run-smoke-fixture";
const EVENT_TIMESTAMP = "2026-08-14T12:00:00.000Z";

interface EmittedEvent {
  runId: string;
  event: RunEvent;
}

const rules: Rule[] = [
  {
    id: "REQ-001",
    title: "Finance administrator threshold",
    behavior: "Refunds over 500 require the finance_admin role",
    boundaries: ["500.00", "501.00"],
    blocking: true,
  },
  {
    id: "REQ-007",
    title: "Audit actor",
    behavior: "Approval audit records contain the actor",
    boundaries: ["smoke-actor"],
    blocking: true,
  },
  {
    id: "REQ-014",
    title: "Truncated threshold",
    behavior: "Amounts from 500.00 to 500.99 remain under the threshold",
    boundaries: ["499.99", "500.00", "500.49", "500.99", "501.00"],
    blocking: true,
  },
  {
    id: "REQ-022",
    title: "Last business day",
    behavior: "The role check is skipped on the final business day",
    boundaries: ["2026-01-29", "2026-01-30T12:00:00Z"],
    blocking: true,
  },
  {
    id: "REQ-031",
    title: "Negative amount clamp",
    behavior: "Negative amounts are accepted and clamped to zero",
    boundaries: ["-50.00", "0.00"],
    blocking: true,
  },
];

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = raw === "" ? null : JSON.parse(raw);
  return parsed;
}

async function runSmoke(emittedEvents: EmittedEvent[]): Promise<void> {
  const rulesBeforeGeneration = structuredClone(rules);
  const corpus = generateCorpus(RUN_ID, rules);

  assert.deepEqual(rules, rulesBeforeGeneration);
  assert.equal(corpus.length, 12);
  assert.deepEqual(
    corpus.map((input) => input.id),
    Array.from({ length: 12 }, (_, index) =>
      `IN-${String(index + 1).padStart(4, "0")}`),
  );
  assert.deepEqual(
    corpus.map((input) => input.ruleId),
    [
      "REQ-001",
      "REQ-001",
      "REQ-007",
      "REQ-014",
      "REQ-014",
      "REQ-014",
      "REQ-014",
      "REQ-014",
      "REQ-022",
      "REQ-022",
      "REQ-031",
      "REQ-031",
    ],
  );
  assert.deepEqual(
    corpus.slice(0, 2).map((input) => input.payload.amount),
    ["500.00", "501.00"],
  );
  assert.equal(corpus[2]?.payload.actor, "smoke-actor");
  assert.deepEqual(
    corpus.slice(3, 8).map((input) => input.payload.amount),
    ["499.99", "500.00", "500.49", "500.99", "501.00"],
  );
  assert.equal(corpus[8]?.payload.requested_at, "2026-01-29");
  assert.equal(corpus[9]?.payload.requested_at, "2026-01-30T12:00:00Z");
  assert.ok(corpus.slice(8, 10).every((input) => input.payload.amount === "501.00"));
  assert.deepEqual(
    corpus.slice(10).map((input) => input.payload.amount),
    ["-50.00", "0.00"],
  );
  assert.ok(corpus.every(
    (input) => input.method === "POST" && input.path === "/refunds/approve",
  ));
  assert.throws(
    () =>
      generateCorpus(RUN_ID, [
        {
          id: "REQ-022",
          title: "Last business day",
          behavior: "The role check is skipped on the final business day",
          boundaries: ["2026-01-30T12:00:00.000Z"],
          blocking: true,
        },
      ]),
    /run-smoke-fixture.*REQ-022.*YYYY-MM-DDTHH:MM:SSZ/u,
  );
  assert.throws(
    () =>
      generateCorpus(RUN_ID, [
        {
          id: "REQ-022",
          title: "Last business day",
          behavior: "The role check is skipped on the final business day",
          boundaries: ["2026-02-29"],
          blocking: true,
        },
      ]),
    /run-smoke-fixture.*REQ-022.*not a valid calendar date/u,
  );

  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (request.url === "/invalid-json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{");
        return;
      }

      const requestBody = await readRequestBody(request);
      response.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ method: request.method, requestBody }));
    } catch (error: unknown) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const previewUrl = `http://127.0.0.1:${address.port}`;
    const replayInputs = corpus.slice(0, 2);
    const replayInputsBeforeRequest = structuredClone(replayInputs);
    const results = await replay(
      RUN_ID,
      previewUrl,
      replayInputs,
      "smoke-candidate",
    );

    assert.deepEqual(replayInputs, replayInputsBeforeRequest);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.candidateId, "smoke-candidate");
    assert.equal(results[0]?.inputId, "IN-0001");
    assert.equal(results[0]?.status, 202);
    assert.ok((results[0]?.latencyMs ?? -1) >= 0);
    assert.deepEqual(results[0]?.body, {
      method: "POST",
      requestBody: corpus[0]?.payload,
    });
    assert.equal(emittedEvents.length, 1);
    assert.equal(emittedEvents[0]?.runId, RUN_ID);
    assert.deepEqual(emittedEvents[0]?.event, {
      seq: 1,
      ts: EVENT_TIMESTAMP,
      source: "control",
      type: "CORPUS_REPLAYED",
      candidateId: "smoke-candidate",
      message: "Replayed 2 corpus inputs against smoke-candidate.",
      payload: { results },
    });

    const healthInput: CorpusInput = {
      id: "IN-HEALTH",
      ruleId: "health",
      method: "GET",
      path: "/health",
      payload: {},
    };
    const [health] = await replay(
      RUN_ID,
      previewUrl,
      [healthInput],
      "smoke-candidate",
    );

    assert.equal(health?.status, 200);
    assert.deepEqual(health?.body, { status: "ok" });
    assert.equal(emittedEvents.length, 2);
    assert.deepEqual(emittedEvents[1]?.event.payload, {
      results: [health],
    });

    await assert.rejects(
      replay(RUN_ID, "not a URL", [healthInput], "broken-candidate"),
      (error: unknown) =>
        error instanceof ReplayRequestError &&
        error.runId === RUN_ID &&
        error.candidateId === "broken-candidate" &&
        error.inputId === "IN-HEALTH",
    );
    assert.equal(emittedEvents.length, 2);

    const invalidJsonInput: CorpusInput = {
      id: "IN-INVALID-JSON",
      ruleId: "transport",
      method: "GET",
      path: "/invalid-json",
      payload: {},
    };
    await assert.rejects(
      replay(RUN_ID, previewUrl, [invalidJsonInput], "broken-candidate"),
      (error: unknown) =>
        error instanceof ReplayRequestError &&
        error.inputId === invalidJsonInput.id &&
        error.cause instanceof SyntaxError,
    );
    assert.equal(emittedEvents.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  const originalFetch = globalThis.fetch;
  const neverCompletingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        reject(new Error("Replay request did not provide an abort signal"));
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  globalThis.fetch = neverCompletingFetch;
  try {
    const timeoutInput: CorpusInput = {
      id: "IN-TIMEOUT",
      ruleId: "transport",
      method: "GET",
      path: "/health",
      payload: {},
    };
    await assert.rejects(
      replay(RUN_ID, "http://127.0.0.1", [timeoutInput], "slow-candidate"),
      (error: unknown) =>
        error instanceof ReplayRequestError &&
        error.inputId === timeoutInput.id &&
        error.message.includes(`timed out after ${String(REPLAY_TIMEOUT_MS)}ms`),
    );
    assert.equal(emittedEvents.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }

}

async function main(): Promise<void> {
  const emittedEvents: EmittedEvent[] = [];
  let sequence = 0;
  configureEventWriter({
    appendEvent: (runId, pending) => {
      const event: RunEvent = {
        ...pending,
        seq: sequence + 1,
        ts: pending.ts ?? EVENT_TIMESTAMP,
      };
      sequence = event.seq;
      emittedEvents.push({ runId, event });
      return event;
    },
  });

  try {
    await runSmoke(emittedEvents);
  } finally {
    resetEventWriter();
  }

  console.log("fixture smoke test passed");
}

main().catch((error: unknown) => {
  console.error("fixture smoke test failed", error);
  process.exitCode = 1;
});
