/**
 * The only place in the control plane that reads process.env.
 * Adding a variable means updating this schema and .env.example in the same commit.
 */
import { z } from "zod";

const schema = z.object({
  CONTROL_PORT: z.coerce.number().int().positive().default(4000),
  CONTROL_DB_PATH: z.string().min(1).default("data/intentguard.db"),
  FORGE_RULES_PATH: z.string().min(1).default("forge/rules.json"),
  CONTROL_SNAPSHOT_ID: z.string().min(1).default("snap-legacy-refunds-4f1c"),
  CONTROL_CORPUS_VERSION: z.string().min(1).default("corpus-1"),
  CONTROL_POLICY_VERSION: z.string().min(1).default("policy-1"),
  CONTROL_CANDIDATE_IDS: z.string().min(1).default("legacy,A,B,C").transform((source, context) => {
    const ids = source.split(",").map((value) => value.trim()).filter((value) => value !== "");
    if (ids.length === 0 || new Set(ids).size !== ids.length || !ids.includes("legacy")) {
      context.addIssue({
        code: "custom",
        message: "must be a comma-separated unique list that includes legacy",
      });
      return z.NEVER;
    }
    return ids;
  }),
  CONTROL_BLOCKING_SEVERITY: z.enum(["low", "medium", "high", "critical"]).default("high"),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(250),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment. ${detail}. See .env.example.`);
}

export const env = parsed.data;
