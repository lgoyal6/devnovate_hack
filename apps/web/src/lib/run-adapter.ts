import { z } from "zod";
import type {
  ApproveRequest,
  ApproveResponse,
  RunEvent,
  RunEventType,
} from "../types";
import type { IntentGuardEnv } from "./env";
import { parseRunEvent } from "./run-events";

export interface RunCreated {
  runId: string;
}

export interface SubscriptionCallbacks {
  onEvent: (event: RunEvent) => void;
  onError: (error: Error) => void;
}

export interface RunAdapter {
  createRun(): Promise<RunCreated>;
  subscribe(runId: string, callbacks: SubscriptionCallbacks): () => void;
  approve(runId: string, submission: ApproveRequest): Promise<ApproveResponse>;
}

const RUN_EVENT_TYPES = [
  "RUN_QUEUED",
  "RULES_LOCKED",
  "SANDBOX_CREATED",
  "SOURCE_READY",
  "SCAN_COMPLETE",
  "APP_HEALTHY",
  "CORPUS_REPLAYED",
  "DIVERGENCE_FOUND",
  "GATE_RESULT",
  "VERDICT_READY",
  "NARRATED",
  "APPROVED",
  "TORN_DOWN",
] as const satisfies readonly RunEventType[];

const digestSchema = z.string().regex(
  /^[0-9a-f]{64}$/u,
  "digest must be a 64-character lowercase SHA-256 value",
);
const runCreatedSchema = z.object({ runId: z.string().min(1) });
const approvalReceiptSchema = z.object({ digest: digestSchema });
const snapshotApprovalSchema = z.object({
  approval: z.object({ digest: digestSchema }).nullable(),
});

function urlFor(baseUrl: string, path: string): string {
  return baseUrl === "" ? path : `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function jsonFrom(response: Response, context: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${context} failed with HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${context} returned invalid JSON: ${detail}`);
  }
}

function subscribeToRun(
  baseUrl: string,
  runId: string,
  query: string,
  callbacks: SubscriptionCallbacks,
): () => void {
  const path = `/api/runs/${encodeURIComponent(runId)}/events${query}`;
  const stream = new EventSource(urlFor(baseUrl, path));
  const listeners = new Map<string, EventListener>();
  let verdictObserved = false;
  let teardownObserved = false;

  const handleRunEvent = (message: MessageEvent<string>) => {
    try {
      const value: unknown = JSON.parse(message.data);
      const event = parseRunEvent(value);
      if (event.type === "VERDICT_READY") verdictObserved = true;
      if (event.type === "TORN_DOWN") teardownObserved = true;
      callbacks.onEvent(event);
      if (verdictObserved && teardownObserved) stream.close();
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      callbacks.onError(new Error(`Run event could not be read: ${detail}`));
      stream.close();
    }
  };

  const registerRunEvent = (name: string) => {
    const listener: EventListener = (event) => {
      if (event instanceof MessageEvent) handleRunEvent(event as MessageEvent<string>);
      else callbacks.onError(new Error(`SSE event ${name} did not contain message data.`));
    };
    listeners.set(name, listener);
    stream.addEventListener(name, listener);
  };

  for (const eventType of RUN_EVENT_TYPES) registerRunEvent(eventType);
  registerRunEvent("message");

  const onStreamError: EventListener = (event) => {
    if (event instanceof MessageEvent) {
      let detail = String(event.data);
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (
          typeof parsed === "object"
          && parsed !== null
          && "message" in parsed
          && typeof parsed.message === "string"
        ) detail = parsed.message;
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) detail = String(error);
      }
      callbacks.onError(new Error(`Control stream reported an error: ${detail}`));
      stream.close();
      return;
    }
    if (stream.readyState === EventSource.CLOSED) {
      callbacks.onError(new Error("The run event stream closed before teardown."));
    }
    // CONNECTING is transient. Native EventSource reconnection remains active.
  };
  stream.addEventListener("error", onStreamError);

  return () => {
    for (const [name, listener] of listeners) stream.removeEventListener(name, listener);
    stream.removeEventListener("error", onStreamError);
    stream.close();
  };
}

class ApiRunAdapter implements RunAdapter {
  constructor(private readonly baseUrl: string) {}

  async createRun(): Promise<RunCreated> {
    const response = await fetch(urlFor(this.baseUrl, "/api/runs"), {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    return runCreatedSchema.parse(await jsonFrom(response, "Starting evaluation"));
  }

  subscribe(runId: string, callbacks: SubscriptionCallbacks): () => void {
    return subscribeToRun(this.baseUrl, runId, "", callbacks);
  }

  async approve(runId: string, submission: ApproveRequest): Promise<ApproveResponse> {
    const response = await fetch(
      urlFor(this.baseUrl, `/api/runs/${encodeURIComponent(runId)}/approve`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(submission),
      },
    );
    return approvalReceiptSchema.parse(await jsonFrom(response, "Recording approval"));
  }
}

class LiveMockRunAdapter implements RunAdapter {
  private runCounter = 0;

  constructor(private readonly baseUrl: string) {}

  async createRun(): Promise<RunCreated> {
    this.runCounter += 1;
    return { runId: `RUN-WEB-MOCK-${String(this.runCounter).padStart(3, "0")}` };
  }

  subscribe(runId: string, callbacks: SubscriptionCallbacks): () => void {
    return subscribeToRun(this.baseUrl, runId, "?speed=6", callbacks);
  }

  async approve(runId: string, _submission: ApproveRequest): Promise<ApproveResponse> {
    const response = await fetch(
      urlFor(this.baseUrl, `/api/runs/${encodeURIComponent(runId)}`),
      { headers: { Accept: "application/json" } },
    );
    const snapshot = snapshotApprovalSchema.parse(
      await jsonFrom(response, "Reading mock approval"),
    );
    if (snapshot.approval === null) {
      throw new Error("The live mock has not emitted its automatic approval yet.");
    }
    return { digest: snapshot.approval.digest };
  }
}

export function createRunAdapter(config: IntentGuardEnv): RunAdapter {
  if (config.VITE_INTENTGUARD_DATA_MODE === "mock") {
    const baseUrl = config.VITE_INTENTGUARD_API_BASE_URL || "http://localhost:4000";
    return new LiveMockRunAdapter(baseUrl);
  }
  return new ApiRunAdapter(config.VITE_INTENTGUARD_API_BASE_URL);
}
