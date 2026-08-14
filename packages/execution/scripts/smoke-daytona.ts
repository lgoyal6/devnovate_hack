import { executionCandidateIds, loadProvisionConfig } from "../src/lib/env.js";
import { productionDependencies } from "../src/lib/production.js";
import type { SandboxPort } from "../src/lib/ports.js";
import { liveRuntime } from "./live.js";

const config = loadProvisionConfig();
const snapshotId = process.argv[2];
if (snapshotId === undefined || snapshotId.length === 0) {
  throw new Error("Usage: pnpm smoke:daytona -- <snapshot-id>");
}
const runId = `smoke-daytona-${Date.now().toString(36)}`;
const runtime = liveRuntime();
const production = productionDependencies();
let egressProbe: SandboxPort | undefined;
let primaryError: unknown;
try {
  const probeClient = production.createDaytona(config.daytona);
  egressProbe = await probeClient.create({
    name: `${runId}-egress`,
    snapshotId,
    labels: { application: "intentguard", runId: `${runId}-egress`, candidateId: "egress" },
    ttlMinutes: config.daytona.ttlMinutes,
    networkAllowList: config.networkAllowList,
  }, config.daytona.createTimeoutSeconds);
  await egressProbe.resize(config.daytona.resources, config.daytona.createTimeoutSeconds);
  const probes = [
    {
      name: "Python runtime",
      command: "python3 --version",
    },
    {
      name: "Snyk CLI",
      command: `${config.snyk.cliPath} --version`,
    },
    {
      name: "outbound HTTPS",
      command: "curl --fail --silent --show-error --location https://github.com/robots.txt --output /tmp/intentguard-egress.txt",
    },
    {
      name: "Snyk API network",
      command: "curl --silent --show-error --output /dev/null https://api.snyk.io/rest/self",
    },
  ] as const;
  for (const probe of probes) {
    const result = await egressProbe.execute(probe.command, "/home/daytona", {}, config.daytona.commandTimeoutSeconds);
    if (result.exitCode !== 0) {
      throw new Error(`Daytona ${probe.name} probe failed with exit ${String(result.exitCode)}.`);
    }
  }

  const refs = await runtime.provision(runId, [...executionCandidateIds], snapshotId);
  if (refs.length !== executionCandidateIds.length) {
    throw new Error(`Expected four Daytona sandboxes, received ${String(refs.length)}.`);
  }
  for (const ref of refs) {
    const healthUrl = new URL(ref.previewUrl);
    healthUrl.pathname = config.healthPath;
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(config.healthTimeoutSeconds * 1000),
    });
    if (!response.ok) {
      throw new Error(`Signed preview health check failed for ${ref.candidateId}: HTTP ${String(response.status)}.`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    runId,
    target: config.daytona.target,
    resources: config.daytona.resources,
    pythonRuntime: "PASS",
    snykCli: "PASS",
    outboundHttps: "PASS",
    snykEndpointEgress: "PASS",
    sandboxes: refs.map((ref) => ({
      ...ref,
      previewUrl: "[redacted signed preview]",
      signedPreviewVerified: true,
    })),
  }, null, 2)}\n`);
} catch (error: unknown) {
  primaryError = error;
  throw error;
} finally {
  const cleanupErrors: unknown[] = [];
  try {
    await runtime.teardown(runId);
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  if (egressProbe !== undefined) {
    try {
      await egressProbe.delete(config.daytona.createTimeoutSeconds);
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length !== 0) {
    throw new AggregateError(
      primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      "Daytona smoke cleanup failed.",
    );
  }
}
