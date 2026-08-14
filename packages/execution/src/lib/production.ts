import { Daytona, type Sandbox } from "@daytona/sdk";
import type { GateResult, Verdict } from "@intentguard/contracts";
import { emitEvent } from "@intentguard/control/events";
import { Question, RocketRideClient } from "rocketride";
import { z } from "zod";
import type { ProvisionConfig, RocketRideConfig } from "./env.js";
import { loadDaytonaConfig, loadProvisionConfig, loadRocketRideConfig } from "./env.js";
import type {
  CommandResult,
  DaytonaPort,
  NarratorPort,
  RuntimeDependencies,
  SandboxPort,
} from "./ports.js";

class DaytonaSandboxAdapter implements SandboxPort {
  constructor(private readonly sandbox: Sandbox) {}

  get id(): string {
    return this.sandbox.id;
  }

  get createdAt(): string | undefined {
    return this.sandbox.createdAt;
  }

  async clone(
    url: string,
    path: string,
    commitSha: string,
    credentials?: { username: string; password: string },
  ): Promise<void> {
    await this.sandbox.git.clone(
      url,
      path,
      undefined,
      commitSha,
      credentials?.username,
      credentials?.password,
      false,
      1,
    );
  }

  async resize(
    resources: { cpu: number; memory: number; disk: number },
    timeoutSeconds: number,
  ): Promise<void> {
    await this.sandbox.resize(resources, timeoutSeconds);
  }

  async execute(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutSeconds: number,
  ): Promise<CommandResult> {
    const result = await this.sandbox.process.executeCommand(command, cwd, env, timeoutSeconds);
    return { exitCode: result.exitCode, output: result.result };
  }

  async start(command: string, timeoutSeconds: number): Promise<void> {
    const sessionId = `intentguard-app-${this.id}`;
    await this.sandbox.process.createSession(sessionId);
    await this.sandbox.process.executeSessionCommand(
      sessionId,
      { command, runAsync: true },
      timeoutSeconds,
    );
  }

  async signedPreviewUrl(port: number, expiresInSeconds: number): Promise<string> {
    const preview = await this.sandbox.getSignedPreviewUrl(port, expiresInSeconds);
    return preview.url;
  }

  async delete(timeoutSeconds: number): Promise<void> {
    await this.sandbox.delete(timeoutSeconds, true);
  }
}

class DaytonaAdapter implements DaytonaPort {
  private readonly client: Daytona;

  constructor(config: ProvisionConfig["daytona"]) {
    this.client = new Daytona({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      target: config.target,
    });
  }

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
    const sandbox = await this.client.create({
      name: input.name,
      snapshot: input.snapshotId,
      labels: input.labels,
      ttlMinutes: input.ttlMinutes,
      public: false,
      networkBlockAll: false,
      ...(input.networkAllowList.length === 0 ? {} : { domainAllowList: input.networkAllowList }),
    }, { timeout: timeoutSeconds });
    return new DaytonaSandboxAdapter(sandbox);
  }

  async *list(labels: Record<string, string>): AsyncIterable<SandboxPort> {
    for await (const sandbox of this.client.list({ labels })) {
      yield new DaytonaSandboxAdapter(sandbox);
    }
  }
}

const rocketResultSchema = z.object({
  result_types: z.record(z.string(), z.string()).optional(),
}).catchall(z.unknown());

function extractNarration(value: unknown): string {
  const parsed = rocketResultSchema.parse(value);
  const declared = parsed.result_types ?? {};
  for (const [field, type] of Object.entries(declared)) {
    if (type !== "answers" && type !== "text") continue;
    const candidate = parsed[field];
    if (Array.isArray(candidate)) {
      const text = candidate.filter((part): part is string => typeof part === "string").join("\n").trim();
      if (text.length !== 0) return text;
    }
  }
  throw new Error("RocketRide returned no declared answers or text result.");
}

class RocketRideNarrator implements NarratorPort {
  private readonly client: RocketRideClient;
  private token: string | undefined;

  constructor(private readonly config: RocketRideConfig) {
    this.client = new RocketRideClient({
      auth: config.ROCKETRIDE_API_KEY,
      uri: config.ROCKETRIDE_URI,
      persist: false,
      requestTimeout: config.ROCKETRIDE_REQUEST_TIMEOUT_MS,
      module: "intentguard-execution",
    });
  }

  async narrate(verdict: Verdict, gates: GateResult[]): Promise<string> {
    await this.client.connect(undefined, { timeout: this.config.ROCKETRIDE_REQUEST_TIMEOUT_MS });
    const pipeline = await this.client.use({
      filepath: this.config.ROCKETRIDE_PIPELINE_PATH,
      ttl: this.config.ROCKETRIDE_PIPELINE_TTL_SECONDS,
      name: "IntentGuard verdict narration",
    });
    this.token = pipeline.token;
    const question = new Question({ expectJson: false });
    question.addInstruction(
      "Evidence boundary",
      "Explain only the supplied verdict and gate evidence. Do not change, rank, or recompute the verdict.",
    );
    question.addContext({ verdict, gates });
    question.addQuestion("Explain this IntentGuard verdict in concise, plain English for a human reviewer.");
    const result: unknown = await this.client.chat({ token: pipeline.token, question });
    return extractNarration(result);
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    if (this.token !== undefined) {
      try {
        await this.client.terminate(this.token);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    try {
      await this.client.disconnect();
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length !== 0) throw new AggregateError(errors, "RocketRide cleanup failed.");
  }
}

export function productionDependencies(): RuntimeDependencies {
  return {
    loadProvisionConfig,
    loadDaytonaConfig,
    createDaytona: (config) => new DaytonaAdapter(config),
    loadRocketRideConfig,
    createNarrator: (config) => new RocketRideNarrator(config),
    emitEvent,
    fetch: globalThis.fetch,
    now: () => new Date(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}
