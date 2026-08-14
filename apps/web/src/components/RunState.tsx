export function EmptyState({ onStart, starting }: { onStart: () => void; starting: boolean }) {
  return (
    <section className="empty-sheet" aria-labelledby="empty-title">
      <div>
        <p className="eyebrow">No evaluation in progress</p>
        <h2 id="empty-title">Reconcile the three candidates against the locked legacy rules.</h2>
        <p>
          Start a run to allocate one shared environment per target, replay the recovered
          boundaries, close security gates, and produce an approval packet.
        </p>
      </div>
      <ol>
        <li><span>01</span> Lock recovered rules and source commits.</li>
        <li><span>02</span> Replay boundary evidence in four matching sandboxes.</li>
        <li><span>03</span> Review the deterministic verdict and sign the packet.</li>
      </ol>
      <button className="primary-action" type="button" onClick={onStart} disabled={starting}>
        {starting ? "Starting evaluation…" : "Evaluate candidates"}
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
        <p>Recorded events remain below. Retry to start a new run with a new run ID.</p>
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
      <h2 id="payload-error-title">Some recorded events could not populate the reconciliation sheets.</h2>
      <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
    </section>
  );
}
