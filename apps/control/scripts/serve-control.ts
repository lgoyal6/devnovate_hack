import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { narrate, provision, scan, teardown } from "@intentguard/execution";
import { generateCorpus, replay } from "@intentguard/fixture";
import { composeProductionWorkerDependencies } from "../src/composition.js";
import { configureEventWriter } from "../src/lib/events.js";
import { env } from "../src/lib/env.js";
import { resolveRepositoryPath } from "../src/lib/paths.js";
import { ControlStore } from "../src/lib/store.js";
import { loadRulesFile } from "../src/rules.js";
import { createControlServer, listenControlServer } from "../src/server.js";
import {
  reconcileStartupRuns,
  runWorkerLoop,
  teardownApprovedRun,
} from "../src/worker.js";

const controlPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = env.CONTROL_DB_PATH === ":memory:"
  ? env.CONTROL_DB_PATH
  : resolve(env.CONTROL_DB_PATH);
if (databasePath !== ":memory:") await mkdir(dirname(databasePath), { recursive: true });

const store = new ControlStore(databasePath);
configureEventWriter(store);
const rulesPath = resolveRepositoryPath(env.FORGE_RULES_PATH, controlPackageRoot);
const loadRules = () => loadRulesFile(rulesPath);
const workerDependencies = composeProductionWorkerDependencies(store, {
  loadRules,
  generateCorpus,
  provision,
  replay,
  scan,
  narrate,
  teardown,
});
const reportWorkerError = (runId: string, error: unknown): void => {
  console.error(`[control] worker failed run ${runId}`, error);
};
await reconcileStartupRuns(store, workerDependencies, reportWorkerError);
const server = createControlServer({
  store,
  defaults: {
    snapshotId: env.CONTROL_SNAPSHOT_ID,
    corpusVersion: env.CONTROL_CORPUS_VERSION,
    policyVersion: env.CONTROL_POLICY_VERSION,
    candidateIds: env.CONTROL_CANDIDATE_IDS,
  },
  loadRules,
  afterApproval: (runId) => teardownApprovedRun(runId, store, workerDependencies),
  onError: (error) => console.error("[control] request failed", error),
});
const listening = await listenControlServer(server, env.CONTROL_PORT, "0.0.0.0");
const workerController = new AbortController();
const workerPromise = runWorkerLoop(
  store,
  workerDependencies,
  workerController.signal,
  reportWorkerError,
  { blockingSeverity: env.CONTROL_BLOCKING_SEVERITY },
  env.WORKER_POLL_MS,
);
console.log(`IntentGuard control API listening at ${listening.url}`);
console.log(`SQLite journal mode: ${store.getJournalMode()}`);

let closePromise: Promise<void> | undefined;
const close = (): Promise<void> => {
  closePromise ??= (async () => {
    workerController.abort();
    const [serverResult, workerResult] = await Promise.allSettled([
      listening.close(),
      workerPromise,
    ]);
    store.close();
    const errors = [serverResult, workerResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length !== 0) throw new AggregateError(errors, "Control server shutdown failed.");
  })();
  return closePromise;
};

void workerPromise.catch((error: unknown) => {
  console.error("[control] worker loop stopped unexpectedly", error);
  process.exitCode = 1;
  void close().catch((shutdownError: unknown) => {
    console.error("[control] shutdown after worker failure failed", shutdownError);
  });
});

process.once("SIGINT", () => void close().catch((error: unknown) => {
  console.error("[control] shutdown failed", error);
  process.exitCode = 1;
}));
process.once("SIGTERM", () => void close().catch((error: unknown) => {
  console.error("[control] shutdown failed", error);
  process.exitCode = 1;
}));
