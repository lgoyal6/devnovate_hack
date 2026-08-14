import { z } from "zod";

const envSchema = z.object({
  VITE_INTENTGUARD_DATA_MODE: z.enum(["mock", "api"]).optional(),
  VITE_INTENTGUARD_API_BASE_URL: z
    .string()
    .refine(
      (value) => value === "" || URL.canParse(value),
      "VITE_INTENTGUARD_API_BASE_URL must be empty or an absolute URL",
    )
    .default(""),
});

const parsedEnv = envSchema.parse(import.meta.env);

export interface IntentGuardEnv {
  VITE_INTENTGUARD_DATA_MODE: "mock" | "api";
  VITE_INTENTGUARD_API_BASE_URL: string;
}

export const env: IntentGuardEnv = {
  VITE_INTENTGUARD_DATA_MODE:
    parsedEnv.VITE_INTENTGUARD_DATA_MODE ?? (import.meta.env.DEV ? "mock" : "api"),
  VITE_INTENTGUARD_API_BASE_URL: parsedEnv.VITE_INTENTGUARD_API_BASE_URL,
};
