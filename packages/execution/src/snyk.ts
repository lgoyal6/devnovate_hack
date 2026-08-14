import type { CandidateId, Finding, ScanResult, Severity } from "@intentguard/contracts";
import { z } from "zod";
import type { CommandResult, SandboxPort } from "./lib/ports.js";

const severitySchema = z.enum(["low", "medium", "high", "critical"]);
const locationSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
}).strict();
const findingSchema = z.object({
  id: z.string().min(1),
  severity: severitySchema,
  title: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  locations: z.array(locationSchema).optional(),
}).passthrough();
const legacyResultSchema = z.object({
  vulnerabilities: z.array(findingSchema).optional(),
  issues: z.array(findingSchema).optional(),
}).passthrough().refine(
  (value) => value.vulnerabilities !== undefined || value.issues !== undefined,
  "must contain vulnerabilities or issues",
);

const sarifLevelSchema = z.enum(["error", "warning", "note", "info"]);
const sarifTextSchema = z.object({ text: z.string().min(1) }).passthrough();
const sarifRuleSchema = z.object({
  id: z.string().min(1),
  shortDescription: sarifTextSchema.optional(),
  fullDescription: sarifTextSchema.optional(),
  defaultConfiguration: z.object({ level: sarifLevelSchema.optional() }).passthrough().optional(),
}).passthrough();
const sarifResultSchema = z.object({
  ruleId: z.string().min(1),
  level: sarifLevelSchema.optional(),
  message: sarifTextSchema,
  locations: z.array(z.object({
    physicalLocation: z.object({
      artifactLocation: z.object({ uri: z.string().min(1) }).passthrough(),
      region: z.object({ startLine: z.number().int().positive() }).passthrough(),
    }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();
const sarifSchema = z.object({
  runs: z.array(z.object({
    tool: z.object({
      driver: z.object({
        rules: z.array(sarifRuleSchema).default([]),
      }).passthrough(),
    }).passthrough(),
    results: z.array(sarifResultSchema),
  }).passthrough()).min(1),
}).passthrough();

export type SnykConfig = { token: string; cliPath: string; timeoutSeconds: number };

const redactedToken = "[REDACTED SNYK_TOKEN]";

function redactText(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length !== 0)
    .reduce((redacted, secret) => redacted.replaceAll(secret, redactedToken), value);
}

function redactRaw(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactRaw(item, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactText(key, secrets),
      redactRaw(item, secrets),
    ]),
  );
}

function redactFindings(findings: Finding[], secrets: readonly string[]): Finding[] {
  return findings.map((finding) => ({
    ...finding,
    id: redactText(finding.id, secrets),
    title: redactText(finding.title, secrets),
    file: redactText(finding.file, secrets),
  }));
}

function rawError(candidateId: CandidateId, raw: unknown, secrets: readonly string[] = []): ScanResult {
  return { candidateId, status: "ERROR", findings: [], raw: redactRaw(raw, secrets) };
}

function findingLocation(value: z.infer<typeof findingSchema>): { file: string; line: number } | undefined {
  if (value.file !== undefined && value.line !== undefined) return { file: value.file, line: value.line };
  return value.locations?.[0];
}

function mapFindings(values: z.infer<typeof findingSchema>[]): Finding[] | undefined {
  const findings: Finding[] = [];
  for (const value of values) {
    const location = findingLocation(value);
    if (location === undefined) return undefined;
    findings.push({
      id: value.id,
      severity: value.severity as Severity,
      title: value.title,
      file: location.file,
      line: location.line,
    });
  }
  return findings;
}

function sarifSeverity(level: z.infer<typeof sarifLevelSchema>): Severity {
  if (level === "error") return "high";
  if (level === "warning") return "medium";
  return "low";
}

function mapSarifFindings(value: z.infer<typeof sarifSchema>): Finding[] | undefined {
  const findings: Finding[] = [];
  for (const run of value.runs) {
    const rules = new Map(run.tool.driver.rules.map((rule) => [rule.id, rule]));
    for (const result of run.results) {
      const rule = rules.get(result.ruleId);
      const level = result.level ?? rule?.defaultConfiguration?.level;
      const location = result.locations[0]?.physicalLocation;
      if (rule === undefined || level === undefined || location === undefined) return undefined;
      findings.push({
        id: result.ruleId,
        severity: sarifSeverity(level),
        title: rule.shortDescription?.text ?? rule.fullDescription?.text ?? result.message.text,
        file: location.artifactLocation.uri,
        line: location.region.startLine,
      });
    }
  }
  return findings;
}

export function parseSnykResult(
  candidateId: CandidateId,
  command: CommandResult,
  secrets: readonly string[] = [],
): ScanResult {
  let raw: unknown;
  try {
    raw = JSON.parse(command.output);
  } catch (error: unknown) {
    return rawError(candidateId, {
      exitCode: command.exitCode,
      output: command.output,
      parseError: error instanceof Error ? error.message : String(error),
    }, secrets);
  }
  if (command.exitCode !== 0 && command.exitCode !== 1) {
    return rawError(candidateId, raw, secrets);
  }
  const legacy = legacyResultSchema.safeParse(raw);
  const sarif = sarifSchema.safeParse(raw);
  const findings = legacy.success
    ? mapFindings(legacy.data.vulnerabilities ?? legacy.data.issues ?? [])
    : sarif.success
      ? mapSarifFindings(sarif.data)
      : undefined;
  if (findings === undefined) return rawError(candidateId, raw, secrets);
  if (command.exitCode === 1 && findings.length === 0) return rawError(candidateId, raw, secrets);
  return {
    candidateId,
    status: findings.length === 0 ? "CLEAN" : "FINDINGS",
    findings: redactFindings(findings, secrets),
    raw: redactRaw(raw, secrets),
  };
}

export async function scanSandbox(
  candidateId: CandidateId,
  sandbox: SandboxPort,
  cwd: string,
  config: SnykConfig,
): Promise<ScanResult> {
  try {
    const command = await sandbox.execute(
      `${config.cliPath} code test --json`,
      cwd,
      { SNYK_TOKEN: config.token },
      config.timeoutSeconds,
    );
    return parseSnykResult(candidateId, command, [config.token]);
  } catch (error: unknown) {
    return rawError(candidateId, {
      executionError: error instanceof Error ? error.message : String(error),
    }, [config.token]);
  }
}
