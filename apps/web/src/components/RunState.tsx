export function EmptyState({ onStart, starting }: { onStart: () => void; starting: boolean }) {
  return (
    <section className="empty-sheet" aria-labelledby="empty-title">
      <div>
        <p className="eyebrow">No evaluation in progress</p>
        <h2 id="empty-title">Compare all three candidates with the legacy service.</h2>
        <p>
          Start a run to create one matching environment for each target. IntentGuard will replay
          the recovered boundary cases, run the security checks, and prepare the results for review.
        </p>
      </div>
      <ol>
        <li><span>01</span> Lock the recovered rules and source commits.</li>
        <li><span>02</span> Run the same boundary cases in four matching sandboxes.</li>
        <li><span>03</span> Review the policy result and approve the evidence record.</li>
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
