import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Daytona, type Sandbox } from "@daytona/sdk";
import type { GateResult, Verdict } from "@intentguard/contracts";
import { emitEvent } from "@intentguard/control/events";
import { Question, RocketRideClient, TASK_STATE } from "rocketride";
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
      resources: { cpu: number; memory: number; disk: number };
    },
    timeoutSeconds: number,
  ): Promise<SandboxPort> {
    // Snapshot creates have no resources field. Passing one makes the SDK POST
    // /sandbox/{id}/resize after create, which 404s and leaves the sandbox
    // occupying org memory. Identical sizing comes from the shared snapshot.
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
  answers: z.array(z.string()).optional(),
  data: z.object({ answer: z.string().optional() }).passthrough().optional(),
}).catchall(z.unknown());

function textFromField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length === 0 ? undefined : text;
  }
  if (!Array.isArray(value)) return undefined;
  const text = value.filter((part): part is string => typeof part === "string").join("\n").trim();
  return text.length === 0 ? undefined : text;
}

function extractNarration(value: unknown): string {
  const parsed = rocketResultSchema.parse(value);
  const declared = parsed.result_types ?? {};
  let text: string | undefined;
  for (const [field, type] of Object.entries(declared)) {
    if (type !== "answers" && type !== "text") continue;
    text = textFromField(parsed[field]);
    if (text !== undefined) break;
  }
  text ??= textFromField(parsed.answers) ?? parsed.data?.answer?.trim();
  if (text === undefined || text.length === 0) {
    throw new Error("RocketRide returned no declared answers or text result.");
  }
  if (text.includes("**LLM error**")) throw new Error(text);
  return text;
}

function resolvePipelinePath(configured: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = isAbsolute(configured)
    ? [configured]
    : [
      resolve(process.cwd(), configured),
      resolve(here, "../../../../", configured),
      resolve(here, "../../", configured),
    ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`RocketRide pipeline file not found: ${configured}.`);
  }
  return found;
}

function verdictHeadline(verdict: Verdict): string {
  if (verdict.outcome === "RECOMMEND" && verdict.recommended !== null) {
    return `Verdict: RECOMMEND ${verdict.recommended}`;
  }
  return `Verdict: ${verdict.outcome}`;
}

function candidateLine(verdict: Verdict, decision: Verdict["perCandidate"][number]): string {
  const role = verdict.recommended === decision.candidateId
    ? "recommended"
    : decision.eligible ? "eligible" : "blocked";
  const reasons = decision.reasons.length === 0
    ? "all required gates passed"
    : decision.reasons.join("; ");
  return `${decision.candidateId} — ${role}: ${reasons}`;
}

function structureNarration(verdict: Verdict, explanation: string): string {
  const cleaned = explanation.replace(/^Verdict:.*\n*/u, "").trim();
  return [
    verdictHeadline(verdict),
    "",
    cleaned,
    "",
    ...verdict.perCandidate.map((decision) => candidateLine(verdict, decision)),
  ].join("\n");
}

function rocketRideClientEnv(config: RocketRideConfig): Record<string, string> {
  return {
    ROCKETRIDE_APIKEY: config.ROCKETRIDE_API_KEY,
    ROCKETRIDE_URI: config.ROCKETRIDE_URI,
    ...(config.ROCKETRIDE_OPENAI_KEY === undefined
      ? {}
      : { ROCKETRIDE_OPENAI_KEY: config.ROCKETRIDE_OPENAI_KEY }),
  };
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
      env: rocketRideClientEnv(config),
    });
  }

  async narrate(verdict: Verdict, gates: GateResult[]): Promise<string> {
    if (this.config.ROCKETRIDE_OPENAI_KEY === undefined) {
      throw new Error("ROCKETRIDE_OPENAI_KEY is required for the narration pipeline.");
    }
    await this.client.connect(this.config.ROCKETRIDE_API_KEY, {
      timeout: this.config.ROCKETRIDE_REQUEST_TIMEOUT_MS,
    });
    const pipeline = await this.client.use({
      filepath: resolvePipelinePath(this.config.ROCKETRIDE_PIPELINE_PATH),
      source: "chat_1",
      ttl: this.config.ROCKETRIDE_PIPELINE_TTL_SECONDS,
      name: "IntentGuard verdict narration",
      env: rocketRideClientEnv(this.config),
    });
    this.token = pipeline.token;
    const readyDeadline = Date.now() + this.config.ROCKETRIDE_REQUEST_TIMEOUT_MS;
    let status = await this.client.getTaskStatus(pipeline.token);
    while (status.state !== TASK_STATE.RUNNING && !status.completed && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = await this.client.getTaskStatus(pipeline.token);
    }
    if (status.state !== TASK_STATE.RUNNING) {
      const detail = status.exitMessage || status.status || `state ${String(status.state)}`;
      throw new Error(`RocketRide pipeline is not running: ${detail}`);
    }
    const question = new Question({ expectJson: false });
    question.addInstruction(
      "Evidence boundary",
      "Explain only the supplied verdict and gate evidence. Do not change, rank, or recompute the verdict.",
    );
    question.addInstruction(
      "Voice",
      "Write 2-3 sentences for a human reviewer. Do not add headings, bullets, or a different recommendation.",
    );
    question.addContext({ verdict, gates });
    question.addQuestion(
      [
        "Explain why this recorded IntentGuard verdict was reached. The structured verdict lines will be added around your prose.",
        `Recorded headline: ${verdictHeadline(verdict)}`,
        `Verdict JSON: ${JSON.stringify(verdict)}`,
        `Gate evidence JSON: ${JSON.stringify(gates)}`,
      ].join("\n\n"),
    );
    const result: unknown = await this.client.chat({ token: pipeline.token, question });
    return structureNarration(verdict, extractNarration(result));
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
