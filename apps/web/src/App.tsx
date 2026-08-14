import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LandingPage } from "./LandingPage";
import { ReconciliationLedger } from "./components/ReconciliationLedger";
import { RunTimeline } from "./components/RunTimeline";
import { SandboxRegister } from "./components/SandboxRegister";
import { EmptyState, ErrorState, EvidencePayloadErrors } from "./components/RunState";
import { VerdictApproval } from "./components/VerdictApproval";
import { env } from "./lib/env";
import { createRunAdapter } from "./lib/run-adapter";
import { deriveRunView, sortRunEvents } from "./lib/run-events";
import type {
  ApproveRequest,
  ApproveResponse,
  ModernCandidateId,
  RunEvent,
  Verdict,
} from "./types";

type AppState = "idle" | "starting" | "running" | "error";

const runAdapter = createRunAdapter(env);

function isModernCandidate(candidateId: string | undefined): candidateId is ModernCandidateId {
  return candidateId === "A" || candidateId === "B" || candidateId === "C";
}

function runStatusLabel(
  appState: AppState,
  verdictOutcome: Verdict["outcome"] | undefined,
  hasApproval: boolean,
  liveSandboxes: number,
): string {
  if (appState === "error") return "RUN INTERRUPTED";
  if (appState === "starting") return "STARTING";
  if (appState === "idle") return "READY";
  if (hasApproval) return "APPROVED";
  if (verdictOutcome !== undefined && liveSandboxes > 0) return "FINALIZING";
  if (verdictOutcome === "RECOMMEND") return "AWAITING APPROVAL";
  if (verdictOutcome === "BLOCKED") return "BLOCKED";
  if (verdictOutcome === "INCONCLUSIVE") return "INCONCLUSIVE";
  return "EVALUATING";
}

function DashboardPage() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [runId, setRunId] = useState("");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<ModernCandidateId>("A");
  const [errorMessage, setErrorMessage] = useState("");
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const runGenerationRef = useRef(0);
  const manualCandidateSelectionRef = useRef(false);

  const orderedEvents = useMemo(() => sortRunEvents(events), [events]);
  const view = useMemo(() => deriveRunView(orderedEvents), [orderedEvents]);
  const status = runStatusLabel(
    appState,
    view.verdict?.outcome,
    view.approval !== undefined,
    view.activeSandboxIds.size,
  );

  useEffect(() => {
    return () => {
      runGenerationRef.current += 1;
      unsubscribeRef.current?.();
    };
  }, []);

  const startRun = useCallback(async () => {
    const generation = runGenerationRef.current + 1;
    runGenerationRef.current = generation;
    unsubscribeRef.current?.();
    unsubscribeRef.current = undefined;
    setAppState("starting");
    setErrorMessage("");
    setEvents([]);
    setRunId("");
    setSelectedCandidate("A");
    manualCandidateSelectionRef.current = false;

    try {
      const created = await runAdapter.createRun();
      if (generation !== runGenerationRef.current) return;
      setRunId(created.runId);
      setAppState("running");
      unsubscribeRef.current = runAdapter.subscribe(created.runId, {
        onEvent: (event) => {
          if (generation !== runGenerationRef.current) return;
          if (
            event.type === "DIVERGENCE_FOUND"
            && isModernCandidate(event.candidateId)
            && !manualCandidateSelectionRef.current
          ) {
            setSelectedCandidate(event.candidateId);
          }
          setEvents((current) => [...current, event]);
        },
        onError: (error) => {
          if (generation !== runGenerationRef.current) return;
          setErrorMessage(error.message);
          setAppState("error");
        },
      });
    } catch (error: unknown) {
      if (generation !== runGenerationRef.current) return;
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setAppState("error");
    }
  }, []);

  const approve = useCallback(
    async (submission: ApproveRequest): Promise<ApproveResponse> => {
      if (runId === "") throw new Error("A run must exist before it can be approved.");
      return runAdapter.approve(runId, submission);
    },
    [runId],
  );

  const hasRun = appState !== "idle" && runId !== "";

  const selectCandidate = useCallback((candidateId: ModernCandidateId) => {
    manualCandidateSelectionRef.current = true;
    setSelectedCandidate(candidateId);
  }, []);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to reconciliation</a>

      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">IG</span>
          <div>
            <strong>IntentGuard</strong>
            <small>Legacy modernization control record</small>
          </div>
        </div>
        <div className="header-run-state" aria-live="polite">
          <span>{runId === "" ? "RUN / NOT STARTED" : `RUN / ${runId}`}</span>
          <strong>{status}</strong>
        </div>
      </header>

      <main id="main-content">
        <section className="run-masthead" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">Refund approval service / modernization review</p>
            <h1 id="page-title">Reconcile candidate behavior before approval.</h1>
            <p className="masthead-copy">
              Compare recovered boundary evidence, confirm identical environments, and sign
              the policy result. The interface presents recorded decisions; it does not make them.
            </p>
          </div>
          <dl className="run-facts">
            <div><dt>Source mode</dt><dd>{env.VITE_INTENTGUARD_DATA_MODE === "mock" ? "CONTROL MOCK SSE" : "CONTROL API"}</dd></div>
            <div><dt>Rules</dt><dd>{orderedEvents.some((event) => event.type === "RULES_LOCKED") ? "LOCKED" : "PENDING"}</dd></div>
            <div><dt>Evidence</dt><dd>{view.ledgerRows.length} ROWS</dd></div>
            <div><dt>Sandboxes</dt><dd>{view.activeSandboxIds.size} LIVE / {view.sandboxes.length} RECORDED</dd></div>
          </dl>
        </section>

        {appState === "idle" || appState === "starting" ? (
          <EmptyState onStart={() => void startRun()} starting={appState === "starting"} />
        ) : null}

        {appState === "error" ? (
          <ErrorState message={errorMessage} onRetry={() => void startRun()} />
        ) : null}

        <EvidencePayloadErrors errors={view.presentationErrors.map((error) => error.message)} />

        <ReconciliationLedger
          key={runId}
          selectedCandidate={selectedCandidate}
          onSelectCandidate={selectCandidate}
          view={view}
          hasRun={hasRun}
        />

        <SandboxRegister view={view} />

        <div className="lower-grid">
          <RunTimeline events={orderedEvents} />
          <VerdictApproval
            key={runId}
            runId={runId === "" ? "not started" : runId}
            view={view}
            onApprove={approve}
          />
        </div>

        {view.approval === undefined ? null : (
          <div className="new-run-row">
            <button className="secondary-action" type="button" onClick={() => void startRun()}>
              Evaluate candidates again
            </button>
          </div>
        )}
      </main>

      <footer>
        <span>INTENTGUARD / RECONCILIATION RECORD</span>
        <span>Times shown in UTC · events rendered by sequence</span>
      </footer>
    </div>
  );
}

export default function App() {
  return window.location.pathname.startsWith("/dashboard") ? <DashboardPage /> : <LandingPage />;
}
