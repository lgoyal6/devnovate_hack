import type { ModernCandidateId, RunEvent, RunView } from "../types";

type LaneTarget = "legacy" | ModernCandidateId;
type StageKey = "sandbox" | "source" | "health" | "inspection" | "replay" | "decision";

interface LaneDefinition {
  target: LaneTarget;
  label: string;
  role: string;
}

interface StageDefinition {
  key: StageKey;
  label: string;
}

const lanes: readonly LaneDefinition[] = [
  { target: "legacy", label: "Legacy", role: "Reference behavior" },
  { target: "A", label: "Candidate A", role: "Rewrite hypothesis" },
  { target: "B", label: "Candidate B", role: "Rewrite hypothesis" },
  { target: "C", label: "Candidate C", role: "Rewrite hypothesis" },
] as const;

function stagesFor(target: LaneTarget): readonly StageDefinition[] {
  return [
    { key: "sandbox", label: "Environment allocated" },
    { key: "source", label: "Source checked out" },
    { key: "health", label: "Service responding" },
    {
      key: "inspection",
      label: target === "legacy" ? "Baseline captured" : "Security scan complete",
    },
    {
      key: "replay",
      label: target === "legacy" ? "Reference locked" : "Boundary replay complete",
    },
    {
      key: "decision",
      label: target === "legacy" ? "Evidence sealed" : "Policy resolved",
    },
  ];
}

function matchesTarget(event: RunEvent, target: LaneTarget): boolean {
  return event.candidateId === target;
}

function eventForStage(
  events: readonly RunEvent[],
  target: LaneTarget,
  stage: StageKey,
): RunEvent | undefined {
  if (stage === "decision") return events.find((event) => event.type === "VERDICT_READY");
  if (stage === "sandbox") {
    return events.find((event) => event.type === "SANDBOX_CREATED" && matchesTarget(event, target));
  }
  if (stage === "source") {
    return events.find((event) => event.type === "SOURCE_READY" && matchesTarget(event, target));
  }
  if (stage === "health") {
    return events.find((event) => event.type === "APP_HEALTHY" && matchesTarget(event, target));
  }
  if (stage === "inspection") {
    const eventType = target === "legacy" ? "CORPUS_REPLAYED" : "SCAN_COMPLETE";
    return events.find((event) => event.type === eventType && matchesTarget(event, target));
  }
  if (target === "legacy") return events.find((event) => event.type === "GATE_RESULT");
  return events.find((event) => event.type === "CORPUS_REPLAYED" && matchesTarget(event, target));
}

function laneOutcome(target: LaneTarget, view: RunView): string {
  if (target === "legacy") return view.verdict === undefined ? "reference" : "sealed";
  const decision = view.verdict?.perCandidate.find((candidate) => candidate.candidateId === target);
  if (decision === undefined) return "running";
  return decision.eligible ? "eligible" : "blocked";
}

function laneStatus(target: LaneTarget, view: RunView, completed: number): string {
  const outcome = laneOutcome(target, view);
  if (outcome === "eligible") return "Eligible";
  if (outcome === "blocked") return "Blocked";
  if (outcome === "sealed") return "Sealed";
  if (completed === 0) return "Queued";
  return "Running";
}

function latestLaneEvent(events: readonly RunEvent[], target: LaneTarget): RunEvent | undefined {
  return [...events].reverse().find((event) => {
    if (matchesTarget(event, target)) return true;
    if (target !== "legacy") return event.type === "VERDICT_READY";
    return event.type === "RULES_LOCKED" || event.type === "VERDICT_READY";
  });
}

export function ParallelProcessBoard({
  events,
  view,
  runId,
  ingestLabel,
}: {
  events: readonly RunEvent[];
  view: RunView;
  runId: string;
  ingestLabel: string;
}) {
  const rulesLocked = events.some((event) => event.type === "RULES_LOCKED");
  const verdictReady = view.verdict !== undefined;

  return (
    <section className="parallel-board" aria-labelledby="parallel-board-title">
      <div className="parallel-board-header">
        <div>
          <p className="eyebrow">Parallel execution fabric</p>
          <h2 id="parallel-board-title">Four targets. One behavior contract.</h2>
        </div>
        <dl>
          <div><dt>Ingest</dt><dd>{ingestLabel}</dd></div>
          <div><dt>Run</dt><dd>{runId}</dd></div>
          <div><dt>Events</dt><dd>{events.length}</dd></div>
        </dl>
      </div>

      <div className="parallel-global-track" aria-label="Run-level progress">
        <div data-state={events.length > 0 ? "complete" : "active"}>
          <span>01</span>
          <strong>Ingest received</strong>
          <small>{events.length > 0 ? "Run queued" : "Preparing run"}</small>
        </div>
        <div data-state={rulesLocked ? "complete" : events.length > 0 ? "active" : "waiting"}>
          <span>02</span>
          <strong>Rules locked</strong>
          <small>{rulesLocked ? "Contract fixed" : "Recovering intent"}</small>
        </div>
        <div data-state={verdictReady ? "complete" : rulesLocked ? "active" : "waiting"}>
          <span>03</span>
          <strong>Parallel evaluation</strong>
          <small>{verdictReady ? "All lanes resolved" : "Targets advancing independently"}</small>
        </div>
        <div data-state={verdictReady ? "active" : "waiting"}>
          <span>04</span>
          <strong>Decision record</strong>
          <small>{verdictReady ? "Ready for review" : "Waiting for policy"}</small>
        </div>
      </div>

      <div className="parallel-lanes">
        {lanes.map((lane) => {
          const stages = stagesFor(lane.target);
          const completed = stages.filter(
            (stage) => eventForStage(events, lane.target, stage.key) !== undefined,
          ).length;
          const outcome = laneOutcome(lane.target, view);
          const latest = latestLaneEvent(events, lane.target);
          const progress = Math.round((completed / stages.length) * 100);

          return (
            <article className="process-lane" data-outcome={outcome} key={lane.target}>
              <header>
                <div>
                  <span>{lane.role}</span>
                  <h3>{lane.label}</h3>
                </div>
                <strong>{laneStatus(lane.target, view, completed)}</strong>
              </header>

              <div className="lane-progress" aria-label={`${lane.label} ${progress}% complete`}>
                <span style={{ width: `${progress}%` }} />
              </div>

              <ol className="lane-stages">
                {stages.map((stage, index) => {
                  const stageEvent = eventForStage(events, lane.target, stage.key);
                  const state = stageEvent !== undefined
                    ? stage.key === "decision" && outcome === "blocked" ? "blocked" : "complete"
                    : index === completed ? "active" : "waiting";
                  return (
                    <li data-state={state} key={stage.key}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <strong>{stage.label}</strong>
                        <small>
                          {stageEvent === undefined
                            ? state === "active" ? "In progress" : "Waiting"
                            : `${stageEvent.source} / event ${String(stageEvent.seq).padStart(3, "0")}`}
                        </small>
                      </div>
                    </li>
                  );
                })}
              </ol>

              <footer>
                <span>Latest signal</span>
                <p>{latest?.message ?? "Waiting for the first execution event."}</p>
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
