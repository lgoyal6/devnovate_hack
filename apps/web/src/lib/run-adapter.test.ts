import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntentGuardEnv } from "./env";
import { createRunAdapter } from "./run-adapter";
import type { RunEvent } from "../types";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static latest: FakeEventSource | undefined;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.latest = this;
  }

  addEventListener(name: string, listener: EventListener): void {
    const listeners = this.listeners.get(name) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: EventListener): void {
    this.listeners.get(name)?.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(name: string, data: unknown): void {
    const message = new MessageEvent(name, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(name) ?? []) listener(message);
  }

  emitTransportError(): void {
    const error = new Event("error");
    for (const listener of this.listeners.get("error") ?? []) listener(error);
  }

  registered(name: string): boolean {
    return (this.listeners.get(name)?.size ?? 0) > 0;
  }
}

const mockConfig: IntentGuardEnv = {
  VITE_INTENTGUARD_DATA_MODE: "mock",
  VITE_INTENTGUARD_API_BASE_URL: "http://control.test",
};

beforeEach(() => {
  FakeEventSource.latest = undefined;
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});

afterEach(() => vi.unstubAllGlobals());

describe("live run adapters", () => {
  it("waits for a verdict when teardown arrives first", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createRunAdapter(mockConfig);
    const created = await adapter.createRun();
    const events: RunEvent[] = [];
    const errors: Error[] = [];
    adapter.subscribe(created.runId, {
      onEvent: (runEvent) => events.push(runEvent),
      onError: (error) => errors.push(error),
    });

    const stream = FakeEventSource.latest;
    expect(stream?.url).toContain(`/api/runs/${created.runId}/events?speed=6`);
    expect(stream?.registered("SANDBOX_CREATED")).toBe(true);
    expect(stream?.registered("GATE_RESULT")).toBe(true);
    expect(stream?.registered("message")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    stream?.emit("RUN_QUEUED", {
      seq: 1,
      ts: "2026-08-14T04:25:10.000Z",
      source: "control",
      type: "RUN_QUEUED",
      message: "Run queued.",
    });
    expect(events[0]?.type).toBe("RUN_QUEUED");

    stream?.emitTransportError();
    expect(errors).toEqual([]);
    expect(stream?.closed).toBe(false);

    stream?.emit("TORN_DOWN", {
      seq: 2,
      ts: "2026-08-14T04:25:11.000Z",
      source: "daytona",
      type: "TORN_DOWN",
      message: "All sandboxes torn down.",
      payload: { sandboxCount: 4 },
    });
    expect(stream?.closed).toBe(false);

    stream?.emit("VERDICT_READY", {
      seq: 3,
      ts: "2026-08-14T04:25:12.000Z",
      source: "control",
      type: "VERDICT_READY",
      message: "Provisioning failed; evaluation is inconclusive.",
      payload: {
        outcome: "INCONCLUSIVE",
        recommended: null,
        perCandidate: [],
        policyVersion: "policy-1",
      },
    });
    expect(stream?.closed).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "RUN_QUEUED",
      "TORN_DOWN",
      "VERDICT_READY",
    ]);
  });

  it("waits for teardown when the verdict arrives first", async () => {
    const adapter = createRunAdapter(mockConfig);
    const { runId } = await adapter.createRun();
    const events: RunEvent[] = [];
    adapter.subscribe(runId, {
      onEvent: (event) => events.push(event),
      onError: () => undefined,
    });
    const stream = FakeEventSource.latest;

    stream?.emit("VERDICT_READY", {
      seq: 1,
      ts: "2026-08-14T04:25:10.000Z",
      source: "control",
      type: "VERDICT_READY",
      message: "Candidate C is eligible.",
      payload: {
        outcome: "RECOMMEND",
        recommended: "C",
        perCandidate: [],
        policyVersion: "policy-1",
      },
    });
    expect(stream?.closed).toBe(false);

    stream?.emit("TORN_DOWN", {
      seq: 2,
      ts: "2026-08-14T04:25:11.000Z",
      source: "daytona",
      type: "TORN_DOWN",
      message: "All sandboxes torn down.",
      payload: { sandboxCount: 4 },
    });
    expect(stream?.closed).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "VERDICT_READY",
      "TORN_DOWN",
    ]);
  });

  it("treats a named error message as fatal without confusing it with reconnect", async () => {
    const adapter = createRunAdapter(mockConfig);
    const { runId } = await adapter.createRun();
    const errors: Error[] = [];
    adapter.subscribe(runId, { onEvent: () => undefined, onError: (error) => errors.push(error) });
    const stream = FakeEventSource.latest;
    stream?.emit("error", { message: "mock stream fixture failed" });
    expect(errors[0]?.message).toContain("mock stream fixture failed");
    expect(stream?.closed).toBe(true);
  });

  it("reads the automatic mock approval digest from the run snapshot", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      approval: { digest: "a".repeat(64) },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createRunAdapter(mockConfig);
    const receipt = await adapter.approve("RUN-WEB-MOCK-001", {
      reviewer: "Bryan",
      comment: "Reviewed.",
    });
    expect(receipt.digest).toBe("a".repeat(64));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://control.test/api/runs/RUN-WEB-MOCK-001",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("rejects a malformed automatic mock approval digest", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ approval: { digest: "not-a-sha256" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    const adapter = createRunAdapter(mockConfig);
    await expect(adapter.approve("RUN-WEB-MOCK-001", {
      reviewer: "Bryan",
      comment: "Reviewed.",
    })).rejects.toThrow(/64-character lowercase SHA-256/u);
  });

  it("runs the real API POST, named SSE, approval, and cleanup lifecycle", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ runId: "RUN-API-001" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ digest: "b".repeat(64) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createRunAdapter({
      VITE_INTENTGUARD_DATA_MODE: "api",
      VITE_INTENTGUARD_API_BASE_URL: "",
    });
    const created = await adapter.createRun();
    const events: RunEvent[] = [];
    const errors: Error[] = [];
    const unsubscribe = adapter.subscribe(created.runId, {
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });
    const stream = FakeEventSource.latest;
    expect(stream?.url).toBe("/api/runs/RUN-API-001/events");
    stream?.emit("VERDICT_READY", {
      seq: 21,
      ts: "2026-08-14T04:25:10.000Z",
      source: "control",
      type: "VERDICT_READY",
      message: "Candidate C is eligible.",
      payload: {
        outcome: "RECOMMEND",
        recommended: "C",
        perCandidate: [],
        policyVersion: "policy-1",
      },
    });
    expect(stream?.closed).toBe(false);

    const receipt = await adapter.approve(created.runId, {
      reviewer: "Bryan",
      comment: "Ship it.",
    });
    stream?.emit("APPROVED", {
      seq: 22,
      ts: "2026-08-14T04:25:11.000Z",
      source: "control",
      type: "APPROVED",
      message: "Approval recorded.",
      payload: {
        runId: created.runId,
        reviewer: "Bryan",
        comment: "Ship it.",
        approvedAt: "2026-08-14T04:25:11.000Z",
        policyVersion: "policy-1",
        digest: receipt.digest,
      },
    });
    expect(stream?.closed).toBe(false);

    expect(events.map((event) => event.type)).toEqual(["VERDICT_READY", "APPROVED"]);
    expect(errors).toEqual([]);
    expect(receipt.digest).toBe("b".repeat(64));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/runs");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/runs/RUN-API-001/approve");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({
      reviewer: "Bryan",
      comment: "Ship it.",
    }));

    unsubscribe();
    expect(stream?.closed).toBe(true);
    expect(stream?.registered("VERDICT_READY")).toBe(false);
    stream?.emit("VERDICT_READY", {
      seq: 23,
      ts: "2026-08-14T04:25:12.000Z",
      source: "control",
      type: "VERDICT_READY",
      message: "Late duplicate.",
    });
    expect(events).toHaveLength(2);
  });

  it("rejects a malformed real API approval digest", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ digest: "ABC" }), { status: 200 }),
    ));
    const adapter = createRunAdapter({
      VITE_INTENTGUARD_DATA_MODE: "api",
      VITE_INTENTGUARD_API_BASE_URL: "",
    });
    await expect(adapter.approve("RUN-API-001", {
      reviewer: "Bryan",
      comment: "Ship it.",
    })).rejects.toThrow(/64-character lowercase SHA-256/u);
  });
});
