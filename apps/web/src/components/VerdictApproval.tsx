import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  ApproveRequest,
  ApproveResponse,
  RunView,
} from "../types";

interface VerdictApprovalProps {
  runId: string;
  view: RunView;
  onApprove: (submission: ApproveRequest) => Promise<ApproveResponse>;
}

function verdictHeading(view: RunView): string {
  const verdict = view.verdict;
  if (verdict === undefined) return "Decision pending";
  if (verdict.outcome === "RECOMMEND" && verdict.recommended !== null) {
    return `Recommend Candidate ${verdict.recommended}`;
  }
  return verdict.outcome === "BLOCKED" ? "No candidate eligible" : "Evaluation inconclusive";
}

function SecurityRegister({ view }: { view: RunView }) {
  return (
    <div className="security-register">
      <p className="eyebrow">Security gate</p>
      {view.scans.length === 0 ? (
        <p className="sheet-placeholder">Scan results are pending.</p>
      ) : (
        <ul>
          {view.scans.map((scan) => (
            <li data-scan={scan.status.toLowerCase()} key={scan.candidateId}>
              <span>Candidate {scan.candidateId}</span>
              <strong>{scan.status === "CLEAN" ? "CLEAN" : scan.status}</strong>
              {scan.findings.map((finding) => (
                <small key={finding.id}>
                  <code>{finding.severity.toUpperCase()}</code> {finding.title} · <code>{finding.file}:{finding.line}</code>
                </small>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApprovalStamp({ view }: { view: RunView }) {
  const approval = view.approval;
  const stampRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (approval !== undefined) stampRef.current?.focus();
  }, [approval]);

  if (approval === undefined) return null;

  return (
    <div
      className="approval-stamp"
      ref={stampRef}
      role="status"
      aria-live="polite"
      aria-label="Approval recorded. Signed approval packet is sealed."
      tabIndex={-1}
    >
      <div className="stamp-title">Approved</div>
      <dl>
        <div><dt>Reviewer</dt><dd>{approval.reviewer}</dd></div>
        <div><dt>Recorded</dt><dd><time dateTime={approval.approvedAt}>{approval.approvedAt}</time></dd></div>
        <div><dt>Policy</dt><dd><code>{approval.policyVersion}</code></dd></div>
        <div><dt>Digest</dt><dd><code>{approval.digest}</code></dd></div>
        <div><dt>Sandboxes</dt><dd><code>{view.sandboxes.map((sandbox) => sandbox.sandboxId).join(" · ")}</code></dd></div>
        <div><dt>Comment</dt><dd>{approval.comment}</dd></div>
      </dl>
    </div>
  );
}

export function VerdictApproval({ runId, view, onApprove }: VerdictApprovalProps) {
  const [reviewer, setReviewer] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<ApproveResponse>();
  const [submitError, setSubmitError] = useState<string>();
  const canApprove =
    view.verdict?.outcome === "RECOMMEND" && view.verdict.recommended !== null;

  const submitApproval = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (receipt !== undefined || submitting) return;
    if (!canApprove) {
      setSubmitError("Only a recommended verdict can be approved.");
      return;
    }
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const nextReceipt = await onApprove({ reviewer: reviewer.trim(), comment: comment.trim() });
      setReceipt(nextReceipt);
    } catch (error: unknown) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="decision-section" aria-labelledby="verdict-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Deterministic policy result</p>
          <h2 id="verdict-title">Verdict and approval</h2>
        </div>
        <code className="policy-id">{view.verdict?.policyVersion ?? "policy pending"}</code>
      </div>

      <div className="verdict-block" data-outcome={view.verdict?.outcome.toLowerCase() ?? "pending"}>
        <p className="verdict-kicker">Policy engine</p>
        <h3>{verdictHeading(view)}</h3>
        {view.verdict === undefined ? (
          <p>All behavior and security gates must close before the policy engine decides.</p>
        ) : (
          <div className="candidate-decisions">
            {view.verdict.perCandidate.map((candidate) => (
              <div data-eligible={candidate.eligible} key={candidate.candidateId}>
                <span>Candidate {candidate.candidateId}</span>
                <strong>{candidate.eligible ? "ELIGIBLE" : "BLOCKED"}</strong>
                <small>
                  {candidate.reasons.length === 0
                    ? "All required gates passed."
                    : candidate.reasons.join(" · ")}
                </small>
              </div>
            ))}
          </div>
        )}
      </div>

      <SecurityRegister view={view} />

      <div className="narration-block">
        <p className="eyebrow">Explanation / rocketride</p>
        <p>{view.narration ?? "Narration follows the verdict and does not alter it."}</p>
        <small>Narration explains the recorded policy result; it does not decide it.</small>
      </div>

      <div className="approval-block">
        <p className="eyebrow">Reviewer sign-off</p>
        {view.approval === undefined ? (
          view.verdict !== undefined && !canApprove ? (
            <p className="sheet-placeholder" role="status">
              This {view.verdict.outcome.toLowerCase()} verdict cannot be approved.
            </p>
          ) : <form onSubmit={submitApproval}>
            <div className="form-grid">
              <label>
                Reviewer name
                <input
                  name="reviewer"
                  value={reviewer}
                  onChange={(event) => setReviewer(event.target.value)}
                  autoComplete="name"
                  required
                  disabled={!canApprove || submitting || receipt !== undefined}
                />
              </label>
              <label>
                Approval comment
                <textarea
                  name="comment"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  rows={3}
                  required
                  disabled={!canApprove || submitting || receipt !== undefined}
                />
              </label>
            </div>
            <div className="approval-actions">
              <button
                className="secondary-action"
                type="submit"
                disabled={!canApprove || submitting || receipt !== undefined || reviewer.trim() === "" || comment.trim() === ""}
              >
                {submitting ? "Recording approval…" : "Approve evidence packet"}
              </button>
              <span aria-live="polite">
                {receipt === undefined
                  ? `Run ${runId}`
                  : `Approval recorded as ${receipt.digest.slice(0, 22)}…; sealing packet.`}
              </span>
            </div>
            {submitError === undefined ? null : <p className="form-error" role="alert">{submitError}</p>}
          </form>
        ) : (
          <ApprovalStamp view={view} />
        )}
      </div>
    </section>
  );
}
