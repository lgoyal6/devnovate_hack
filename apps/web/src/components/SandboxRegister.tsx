import type { RunView } from "../types";

export function SandboxRegister({ view }: { view: RunView }) {
  return (
    <section className="register-section" aria-labelledby="sandbox-title">
      <div className="section-heading register-heading">
        <div>
          <p className="eyebrow">Environment parity</p>
          <h2 id="sandbox-title">Sandbox register</h2>
        </div>
        <p className="live-count" aria-live="polite">
          <span>{view.activeSandboxIds.size}</span> live sandboxes
        </p>
      </div>

      {view.sandboxes.length === 0 ? (
        <p className="sheet-placeholder">Sandbox IDs and shared resources appear when allocation begins.</p>
      ) : (
        <div className="register-scroll" tabIndex={0} aria-label="Sandbox environment metadata">
          <table className="register-table">
            <caption>Commit and environment metadata for every replay target.</caption>
            <thead>
              <tr>
                <th scope="col">Target</th>
                <th scope="col">Sandbox ID</th>
                <th scope="col">Snapshot</th>
                <th scope="col">Commit SHA</th>
                <th scope="col">Allocation</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {view.sandboxes.map((sandbox) => (
                <tr key={sandbox.sandboxId}>
                  <th scope="row">{sandbox.candidateId === "legacy" ? "Legacy" : `Candidate ${sandbox.candidateId}`}</th>
                  <td><code>{sandbox.sandboxId}</code></td>
                  <td><code>{sandbox.snapshotId}</code></td>
                  <td><code>{sandbox.commitSha}</code></td>
                  <td>
                    <code>not reported</code>
                  </td>
                  <td>
                    <span className="sandbox-state">
                      {view.activeSandboxIds.has(sandbox.sandboxId) ? "LIVE" : "RELEASED"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
