/**
 * Evidence canonicalisation and digest.
 *
 * An approval binds to a SHA-256 digest over the canonicalised evidence bundle,
 * so a later change to any piece of evidence invalidates the approval. That
 * property only holds if the serialisation is deterministic, which is what
 * canonicalJson is for: key order and whitespace must never change the digest.
 */
import { createHash } from "node:crypto";
import type { EvidenceBundle } from "@intentguard/contracts";

/** Deterministic JSON: object keys sorted by code unit at every depth, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    // JSON.stringify returns undefined for undefined, functions and symbols.
    return encoded === undefined ? "null" : encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

/** Lowercase hex SHA-256 over the canonicalised bundle. */
export function digestEvidence(bundle: EvidenceBundle): string {
  return createHash("sha256").update(canonicalJson(bundle), "utf8").digest("hex");
}
