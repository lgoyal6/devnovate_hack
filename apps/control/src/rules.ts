import { readFile } from "node:fs/promises";
import type { Rule } from "@intentguard/contracts";
import { z } from "zod";

const ruleSchema = z.object({
  id: z.string().regex(/^REQ-\d{3}$/u),
  title: z.string().min(1),
  behavior: z.string().min(1),
  boundaries: z.array(z.string().min(1)).min(1),
  blocking: z.boolean(),
}).strict();

const rulesSchema = z.array(ruleSchema).min(1).superRefine((rules, context) => {
  const ids = new Set<string>();
  rules.forEach((rule, index) => {
    if (ids.has(rule.id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `duplicate rule ID ${rule.id}`,
      });
    }
    ids.add(rule.id);
    if (new Set(rule.boundaries).size !== rule.boundaries.length) {
      context.addIssue({
        code: "custom",
        path: [index, "boundaries"],
        message: `rule ${rule.id} has duplicate boundaries`,
      });
    }
  });
});

export async function loadRulesFile(path: string): Promise<Rule[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    throw new Error(`Could not read Forge rules from ${path}.`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw new Error(`Forge rules file ${path} is not valid JSON.`, { cause: error });
  }
  const result = rulesSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "rules"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Forge rules file ${path} does not match Rule[]: ${detail}`);
  }
  return result.data;
}
