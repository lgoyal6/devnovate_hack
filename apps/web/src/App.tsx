import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LandingPage } from "./LandingPage";
import { ParallelProcessBoard } from "./components/ParallelProcessBoard";
import { ReconciliationLedger } from "./components/ReconciliationLedger";
import { RunTimeline } from "./components/RunTimeline";
import { SandboxRegister } from "./components/SandboxRegister";
import {
  EmptyState,
  ErrorState,
  EvidencePayloadErrors,
  type IngestedCandidateDraft,
} from "./components/RunState";
import { VerdictApproval } from "./components/VerdictApproval";
import { env } from "./lib/env";
import { createRunAdapter } from "./lib/run-adapter";
import { deriveRunView, sortRunEvents } from "./lib/run-events";
import type {
  ApproveRequest,
  ApproveResponse,
  IngestedCandidate,
  ModernCandidateId,
  RunEvent,
  Verdict,
} from "./types";

const EMPTY_CANDIDATE_DRAFT: IngestedCandidateDraft = { candidateId: "", repoUrl: "", ref: "" };

function draftToCandidates(draft: IngestedCandidateDraft): IngestedCandidate[] | undefined {
  const repoUrl = draft.repoUrl.trim();
  if (repoUrl === "") return undefined;
  return [{
    candidateId: draft.candidateId.trim() || "D",
    repoUrl,
    ref: draft.ref.trim() || "main",
  }];
}

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
  const [candidateDraft, setCandidateDraft] = useState<IngestedCandidateDraft>(EMPTY_CANDIDATE_DRAFT);
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
      const created = await runAdapter.createRun(draftToCandidates(candidateDraft));
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
  }, [candidateDraft]);

  const approve = useCallback(
    async (submission: ApproveRequest): Promise<ApproveResponse> => {
      if (runId === "") throw new Error("A run must exist before it can be approved.");
      return runAdapter.approve(runId, submission);
    },
    [runId],
  );

  const hasRun = appState !== "idle" && runId !== "";
  const ingestLabel = candidateDraft.repoUrl.trim() === ""
    ? "Standard candidate set"
    : candidateDraft.candidateId.trim() || "Submitted rewrite";

  const selectCandidate = useCallback((candidateId: ModernCandidateId) => {
    manualCandidateSelectionRef.current = true;
    setSelectedCandidate(candidateId);
  }, []);

  const updateCandidateDraft = useCallback((field: keyof IngestedCandidateDraft, value: string) => {
    setCandidateDraft((current) => ({ ...current, [field]: value }));
  }, []);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to reconciliation</a>

      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">IG</span>
          <div>
            <strong>IntentGuard</strong>
            <small>Legacy rewrite verification</small>
          </div>
        </div>
        <div className="header-run-state" aria-live="polite">
          <span>{runId === "" ? "RUN / NOT STARTED" : `RUN / ${runId}`}</span>
          <strong>{status}</strong>
        </div>
      </header>

      <main id="main-content">
        <section className="workspace-section verification-workspace" aria-labelledby="page-title">
          <div className="workspace-heading">
            <span className="workspace-number" aria-hidden="true">01</span>
            <div>
              <p className="eyebrow">Parallel verification</p>
              <h1 id="page-title">Execution race</h1>
            </div>
            <code>{orderedEvents.length} signals / {view.activeSandboxIds.size} live</code>
          </div>

          <div className="verification-body">
            {appState === "idle" || appState === "starting" ? (
              <EmptyState
                onStart={() => void startRun()}
                starting={appState === "starting"}
                candidateDraft={candidateDraft}
                onCandidateDraftChange={updateCandidateDraft}
              />
            ) : null}

            {appState === "error" ? (
              <ErrorState message={errorMessage} onRetry={() => void startRun()} />
            ) : null}

            <EvidencePayloadErrors errors={view.presentationErrors.map((error) => error.message)} />

            {hasRun ? (
              <>
                <ParallelProcessBoard
                  events={orderedEvents}
                  view={view}
                  runId={runId}
                  ingestLabel={ingestLabel}
                />

                <ReconciliationLedger
                  key={runId}
                  selectedCandidate={selectedCandidate}
                  onSelectCandidate={selectCandidate}
                  view={view}
                  hasRun={hasRun}
                />

                <SandboxRegister view={view} />

                <section className="record-section" aria-labelledby="timeline-title">
                  <RunTimeline events={orderedEvents} />
                </section>
              </>
            ) : null}
          </div>
        </section>

        <section className="workspace-section review-workspace" aria-labelledby="verdict-title">
          <div className="workspace-heading">
            <span className="workspace-number" aria-hidden="true">03</span>
            <div>
              <p className="eyebrow">Review workspace</p>
              <h2 id="review-workspace-title">Decision and approval</h2>
            </div>
            <code>{status.toLowerCase()}</code>
          </div>
          <div className="decision-panel">
            <VerdictApproval
              key={runId}
              runId={runId === "" ? "not started" : runId}
              view={view}
              onApprove={approve}
            />
          </div>
        </section>

        {view.approval === undefined ? null : (
          <div className="new-run-row">
            <button className="secondary-action" type="button" onClick={() => void startRun()}>
              Evaluate candidates again
            </button>
          </div>
        )}
      </main>

      <footer>
        <span>INTENTGUARD / REWRITE VERIFICATION RECORD</span>
        <span>Times shown in UTC / events ordered by sequence</span>
      </footer>
    </div>
  );
}

export default function App() {
  return window.location.pathname.startsWith("/dashboard") ? <DashboardPage /> : <LandingPage />;
}
