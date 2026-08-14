export interface IngestedCandidateDraft {
  candidateId: string;
  repoUrl: string;
  ref: string;
}

export function EmptyState({
  onStart,
  starting,
  candidateDraft,
  onCandidateDraftChange,
}: {
  onStart: () => void;
  starting: boolean;
  candidateDraft: IngestedCandidateDraft;
  onCandidateDraftChange: (field: keyof IngestedCandidateDraft, value: string) => void;
}) {
  return (
    <section className="empty-sheet" aria-labelledby="empty-title">
      <div>
        <p className="eyebrow">Ready for ingest</p>
        <h2 id="empty-title">Ingest a rewrite and watch every target run.</h2>
        <p>
          IntentGuard opens one execution lane for the legacy service and each candidate. Every
          lane advances from allocation to policy as its recorded events arrive.
        </p>
      </div>
      <ol>
        <li><span>01</span> Recover and lock the behavior contract.</li>
        <li><span>02</span> Start four matching execution lanes.</li>
        <li><span>03</span> Resolve each lane from recorded evidence.</li>
      </ol>

      <div className="ingest-block">
        <p className="eyebrow">Candidate ingest</p>
        <div className="form-grid">
          <label>
            Candidate label
            <input
              value={candidateDraft.candidateId}
              onChange={(event) => onCandidateDraftChange("candidateId", event.target.value)}
              placeholder="D"
              disabled={starting}
            />
          </label>
          <label>
            Git repository URL
            <input
              value={candidateDraft.repoUrl}
              onChange={(event) => onCandidateDraftChange("repoUrl", event.target.value)}
              placeholder="https://github.com/org/rewrite.git"
              disabled={starting}
            />
          </label>
          <label>
            Branch or commit
            <input
              value={candidateDraft.ref}
              onChange={(event) => onCandidateDraftChange("ref", event.target.value)}
              placeholder="main"
              disabled={starting}
            />
          </label>
        </div>
      </div>

      <button className="primary-action" type="button" onClick={onStart} disabled={starting}>
        {starting ? "Opening execution lanes..." : "Ingest and start run"}
      </button>
    </section>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <section className="error-sheet" role="alert" aria-labelledby="error-title">
      <div>
        <p className="eyebrow">Run interrupted</p>
        <h2 id="error-title">Evidence collection stopped before a verdict was available.</h2>
        <p>{message}</p>
        <p>The events recorded before the interruption remain available below. Retry to start a new run.</p>
      </div>
      <button className="secondary-action" type="button" onClick={onRetry}>Retry evaluation</button>
    </section>
  );
}

export function EvidencePayloadErrors({ errors }: { errors: readonly string[] }) {
  if (errors.length === 0) return null;
  return (
    <section className="payload-error-sheet" role="alert" aria-labelledby="payload-error-title">
      <p className="eyebrow">Evidence display error</p>
      <h2 id="payload-error-title">Some recorded events could not be shown in the comparison.</h2>
      <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
    </section>
  );
}
