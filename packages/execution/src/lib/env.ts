import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const nonNegativeInteger = z.coerce.number().int().nonnegative();
const optionalNonEmptyString = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional(),
);

const repositorySchema = z.object({
  url: z.string().url(),
  commitSha: z.string().regex(
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i,
    "must be a full 40- or 64-character Git commit SHA",
  ),
}).strict();

export const executionCandidateIds = ["legacy", "A", "B", "C"] as const;
export type ExecutionCandidateId = (typeof executionCandidateIds)[number];

const repositoriesSchema = z.object({
  legacy: repositorySchema,
  A: repositorySchema,
  B: repositorySchema,
  C: repositorySchema,
}).strict().superRefine((repositories, context) => {
  for (const candidateId of executionCandidateIds.slice(1)) {
    const target = repositories[candidateId];
    if (target.url !== repositories.legacy.url || target.commitSha !== repositories.legacy.commitSha) {
      context.addIssue({
        code: "custom",
        path: [candidateId],
        message: "must use the same monorepo URL and immutable commit as legacy",
      });
    }
  }
});

const provisionEnvSchema = z.object({
  DAYTONA_API_KEY: z.string().min(1),
  DAYTONA_API_URL: z.string().url().default("https://app.daytona.io/api"),
  DAYTONA_TARGET: z.string().min(1),
  DAYTONA_CPU: positiveInteger.default(2),
  DAYTONA_MEMORY_GIB: positiveInteger.default(4),
  DAYTONA_DISK_GIB: positiveInteger.default(20),
  DAYTONA_TTL_MINUTES: positiveInteger.default(45),
  DAYTONA_CREATE_TIMEOUT_SECONDS: positiveInteger.default(180),
  DAYTONA_COMMAND_TIMEOUT_SECONDS: positiveInteger.default(300),
  DAYTONA_PREVIEW_TTL_SECONDS: positiveInteger.default(3600),
  EXECUTION_REPOSITORIES_JSON: z.string().min(2),
  EXECUTION_REPOSITORY_DIR: z.string().min(1).default("/home/daytona/app"),
  EXECUTION_INSTALL_COMMAND: z.string().min(1).default("python3 -m compileall -q ."),
  EXECUTION_APP_PORT: positiveInteger.default(8080),
  EXECUTION_HEALTH_PATH: z.string().regex(/^\//, "must begin with /").default("/health"),
  EXECUTION_HEALTH_TIMEOUT_SECONDS: positiveInteger.default(120),
  EXECUTION_HEALTH_POLL_MS: positiveInteger.default(1000),
  EXECUTION_NETWORK_ALLOWLIST: z.string().default("github.com,*.snyk.io"),
  EXECUTION_GIT_USERNAME: optionalNonEmptyString,
  EXECUTION_GIT_TOKEN: optionalNonEmptyString,
  SNYK_TOKEN: optionalNonEmptyString,
  SNYK_CLI_PATH: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("snyk"),
  SNYK_TIMEOUT_SECONDS: positiveInteger.default(180),
}).strict();

const daytonaCleanupEnvSchema = provisionEnvSchema.pick({
  DAYTONA_API_KEY: true,
  DAYTONA_API_URL: true,
  DAYTONA_TARGET: true,
  DAYTONA_CPU: true,
  DAYTONA_MEMORY_GIB: true,
  DAYTONA_DISK_GIB: true,
  DAYTONA_TTL_MINUTES: true,
  DAYTONA_CREATE_TIMEOUT_SECONDS: true,
  DAYTONA_COMMAND_TIMEOUT_SECONDS: true,
  DAYTONA_PREVIEW_TTL_SECONDS: true,
});

const rocketRideEnvSchema = z.object({
  ROCKETRIDE_API_KEY: z.string().min(1),
  ROCKETRIDE_URI: z.string().min(1),
  ROCKETRIDE_PIPELINE_PATH: z.string().min(1),
  ROCKETRIDE_REQUEST_TIMEOUT_MS: positiveInteger.default(30000),
  ROCKETRIDE_PIPELINE_TTL_SECONDS: nonNegativeInteger.default(60),
}).strict();

export type RepositoryTarget = z.infer<typeof repositorySchema>;
export type RepositoryTargets = z.infer<typeof repositoriesSchema>;

export type ProvisionConfig = {
  daytona: {
    apiKey: string;
    apiUrl: string;
    target: string;
    resources: { cpu: number; memory: number; disk: number };
    ttlMinutes: number;
    createTimeoutSeconds: number;
    commandTimeoutSeconds: number;
    previewTtlSeconds: number;
  };
  repositories: RepositoryTargets;
  repositoryDir: string;
  installCommand: string;
  appPort: number;
  healthPath: string;
  healthTimeoutSeconds: number;
  healthPollMs: number;
  networkAllowList: string;
  gitUsername?: string;
  gitToken?: string;
  snyk: { token: string | undefined; cliPath: string; timeoutSeconds: number };
};

export type RocketRideConfig = z.infer<typeof rocketRideEnvSchema>;
export type DaytonaConfig = ProvisionConfig["daytona"];

function ownEnvironment(keys: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

export function validateRepositoryTargets(value: unknown): RepositoryTargets {
  return repositoriesSchema.parse(value);
}

function parseRepositories(value: string): RepositoryTargets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: unknown) {
    throw new Error("EXECUTION_REPOSITORIES_JSON must be valid JSON.", { cause: error });
  }
  return validateRepositoryTargets(parsed);
}

export function loadProvisionConfig(): ProvisionConfig {
  const keys = Object.keys(provisionEnvSchema.shape);
  const env = provisionEnvSchema.parse(ownEnvironment(keys));
  return {
    daytona: {
      apiKey: env.DAYTONA_API_KEY,
      apiUrl: env.DAYTONA_API_URL,
      target: env.DAYTONA_TARGET,
      resources: {
        cpu: env.DAYTONA_CPU,
        memory: env.DAYTONA_MEMORY_GIB,
        disk: env.DAYTONA_DISK_GIB,
      },
      ttlMinutes: env.DAYTONA_TTL_MINUTES,
      createTimeoutSeconds: env.DAYTONA_CREATE_TIMEOUT_SECONDS,
      commandTimeoutSeconds: env.DAYTONA_COMMAND_TIMEOUT_SECONDS,
      previewTtlSeconds: env.DAYTONA_PREVIEW_TTL_SECONDS,
    },
    repositories: parseRepositories(env.EXECUTION_REPOSITORIES_JSON),
    repositoryDir: env.EXECUTION_REPOSITORY_DIR,
    installCommand: env.EXECUTION_INSTALL_COMMAND,
    appPort: env.EXECUTION_APP_PORT,
    healthPath: env.EXECUTION_HEALTH_PATH,
    healthTimeoutSeconds: env.EXECUTION_HEALTH_TIMEOUT_SECONDS,
    healthPollMs: env.EXECUTION_HEALTH_POLL_MS,
    networkAllowList: env.EXECUTION_NETWORK_ALLOWLIST,
    ...(env.EXECUTION_GIT_USERNAME === undefined ? {} : { gitUsername: env.EXECUTION_GIT_USERNAME }),
    ...(env.EXECUTION_GIT_TOKEN === undefined ? {} : { gitToken: env.EXECUTION_GIT_TOKEN }),
    snyk: {
      token: env.SNYK_TOKEN,
      cliPath: env.SNYK_CLI_PATH,
      timeoutSeconds: env.SNYK_TIMEOUT_SECONDS,
    },
  };
}

export function loadDaytonaConfig(): DaytonaConfig {
  const keys = Object.keys(daytonaCleanupEnvSchema.shape);
  const env = daytonaCleanupEnvSchema.parse(ownEnvironment(keys));
  return {
    apiKey: env.DAYTONA_API_KEY,
    apiUrl: env.DAYTONA_API_URL,
    target: env.DAYTONA_TARGET,
    resources: {
      cpu: env.DAYTONA_CPU,
      memory: env.DAYTONA_MEMORY_GIB,
      disk: env.DAYTONA_DISK_GIB,
    },
    ttlMinutes: env.DAYTONA_TTL_MINUTES,
    createTimeoutSeconds: env.DAYTONA_CREATE_TIMEOUT_SECONDS,
    commandTimeoutSeconds: env.DAYTONA_COMMAND_TIMEOUT_SECONDS,
    previewTtlSeconds: env.DAYTONA_PREVIEW_TTL_SECONDS,
  };
}

export function loadRocketRideConfig(): RocketRideConfig {
  const keys = Object.keys(rocketRideEnvSchema.shape);
  return rocketRideEnvSchema.parse(ownEnvironment(keys));
}
