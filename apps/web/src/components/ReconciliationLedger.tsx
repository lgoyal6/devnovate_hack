import { useEffect, useRef } from "react";
import type {
  LedgerValue,
  ModernCandidateId,
  RunView,
} from "../types";

interface ReconciliationLedgerProps {
  selectedCandidate: ModernCandidateId;
  onSelectCandidate: (candidateId: ModernCandidateId) => void;
  view: RunView;
  hasRun: boolean;
}

const candidates: readonly ModernCandidateId[] = ["A", "B", "C"];

function DiffValue({ value }: { value: LedgerValue }) {
  return (
    <code className="diff-value" aria-label={value.summary}>
      {value.parts.map((part, index) =>
        part.different ? (
          <mark key={`${part.text}-${index}`}>{part.text}</mark>
        ) : (
          <span key={`${part.text}-${index}`}>{part.text}</span>
        ),
      )}
    </code>
  );
}

function candidateDisposition(candidateId: ModernCandidateId, view: RunView): string {
  const decision = view.verdict?.perCandidate.find(
    (candidate) => candidate.candidateId === candidateId,
  );
  if (decision === undefined) return "evaluating";
  return decision.eligible ? "eligible" : "blocked";
}

export function ReconciliationLedger({
  selectedCandidate,
  onSelectCandidate,
  view,
  hasRun,
}: ReconciliationLedgerProps) {
  const rows = view.ledgerRows.filter((row) => row.candidateId === selectedCandidate);
  const knownRowIdsRef = useRef(new Set<string>());
  const newlyResolvedIds = new Set(
    view.ledgerRows
      .filter((row) => !knownRowIdsRef.current.has(row.id))
      .map((row) => row.id),
  );

  useEffect(() => {
    for (const row of view.ledgerRows) knownRowIdsRef.current.add(row.id);
  }, [view.ledgerRows]);

  return (
    <section className="ledger-section" aria-labelledby="ledger-title">
      <div className="section-heading ledger-heading">
        <div>
          <p className="eyebrow">Behavior reconciliation</p>
          <h2 id="ledger-title">Legacy / candidate ledger</h2>
        </div>
        <p className="resolved-count" aria-live="polite">
          {rows.length} evidence rows resolved
        </p>
      </div>

      <div className="candidate-tabs" role="group" aria-label="Candidate ledger">
        {candidates.map((candidateId) => (
          <button
            className="candidate-tab"
            data-active={candidateId === selectedCandidate}
            type="button"
            aria-pressed={candidateId === selectedCandidate}
            onClick={() => onSelectCandidate(candidateId)}
            key={candidateId}
          >
            <span>Candidate {candidateId}</span>
            <small>{candidateDisposition(candidateId, view)}</small>
          </button>
        ))}
      </div>

      <div className="ledger-scroll" tabIndex={0} aria-label={`Candidate ${selectedCandidate} reconciliation evidence`}>
        <table className="ledger-table">
          <caption>
            Boundary replay results comparing legacy responses with Candidate {selectedCandidate}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Input</th>
              <th scope="col">Legacy response</th>
              <th scope="col">Candidate {selectedCandidate} response</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr className="ledger-empty-row">
                <td colSpan={5}>
                  {hasRun
                    ? "Replay is running. Evidence prints here as each gate resolves."
                    : "Evaluate candidates to print the paired legacy and candidate responses."}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  data-result={row.status.toLowerCase()}
                  data-new={newlyResolvedIds.has(row.id)}
                  key={row.id}
                >
                  <th scope="row" className="rule-margin" data-label="Rule">
                    <span>{row.ruleId}</span>
                    <small>{row.inputId ?? "RULE GATE"}</small>
                  </th>
                  <td className="probe-value" data-label="Input">
                    <code>{row.probe}</code>
                  </td>
                  {row.evidenceKind === "raw" && row.legacy !== undefined && row.candidate !== undefined ? (
                    <>
                      <td data-label="Legacy response"><DiffValue value={row.legacy} /></td>
                      <td data-label={`Candidate ${selectedCandidate} response`}>
                        <DiffValue value={row.candidate} />
                        <small className="ledger-note">{row.note}</small>
                      </td>
                    </>
                  ) : (
                    <td className="gate-evidence" colSpan={2} data-label="Gate evidence">
                      <span>{row.note}</span>
                      <small>Per-input raw responses were not reported for this rule gate.</small>
                    </td>
                  )}
                  <td className="row-result" data-label="Result">
                    {row.status === "MATCH" ? "MATCH" : "DIVERGED"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
