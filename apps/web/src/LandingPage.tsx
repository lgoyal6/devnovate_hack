const proofFacts = [
  { label: "Recovered intent", value: "14 locked rules" },
  { label: "Recorded behavior", value: "84 boundary checks" },
  { label: "Candidates", value: "3 isolated rewrites" },
  { label: "Decision source", value: "Execution, not opinion" },
] as const;

const methodSteps = [
  {
    number: "01",
    title: "Recover the business rules",
    body: "Forge reads the legacy service, extracts its business rules, and identifies the inputs most likely to reveal a behavioral change.",
    output: "Rules locked",
  },
  {
    number: "02",
    title: "Run the same inputs",
    body: "The legacy service and each candidate process the same inputs in separate environments built from the same snapshot.",
    output: "Results recorded",
  },
  {
    number: "03",
    title: "Compare the recorded results",
    body: "IntentGuard compares outputs, security findings, and environment state. The verdict comes from those results, not from a model's opinion.",
    output: "Policy evaluated",
  },
  {
    number: "04",
    title: "Review the complete record",
    body: "The final record includes the selected candidate, the rejected candidates, the rules, the scan results, and the raw outputs used in the decision.",
    output: "Human approval",
  },
] as const;

export function LandingPage() {
  return (
    <div className="landing-page">
      <a className="skip-link" href="#landing-main">Skip to main content</a>

      <header className="landing-header">
        <a className="landing-brand" href="/" aria-label="IntentGuard home">
          <span className="brand-mark" aria-hidden="true">IG</span>
          <span>
            <strong>IntentGuard</strong>
          <small>Behavior verification for software rewrites</small>
          </span>
        </a>
        <nav className="landing-nav" aria-label="Primary navigation">
          <a href="#why">Why verify</a>
          <a href="#method">How it works</a>
          <a href="#evidence">Who decides</a>
        </nav>
        <a className="landing-header-action" href="/dashboard">
          <span className="landing-header-action-label">Open control room</span>
        </a>
      </header>

      <main className="landing-main" id="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="eyebrow">Software modernization / behavior verification</p>
            <h1 id="landing-title">
              Verify the rewrite against
              <span>the system it replaces.</span>
            </h1>
            <p className="landing-lead">
              IntentGuard runs the legacy service and every rewrite against the same business-rule
              tests. It records the results, flags any differences, and shows which candidate is
              ready for human review.
            </p>
            <div className="landing-actions">
              <a className="landing-primary-action" href="/dashboard">View a sample run</a>
              <a className="landing-text-action" href="#method">How verification works</a>
            </div>
            <p className="landing-quiet-proof">
              <span aria-hidden="true" /> Real executions only. If an environment fails, the result is inconclusive.
            </p>
          </div>

          <div className="proof-window" aria-label="Example IntentGuard behavior comparison">
            <div className="proof-window-header">
              <div>
                <span>Recorded execution workspace</span>
                <strong>Refund approval service</strong>
              </div>
              <span className="proof-run-state">Run complete</span>
            </div>

            <div className="proof-window-body">
              <div className="proof-candidates" aria-label="Candidate outcomes">
                <div className="proof-candidate" data-state="eligible">
                  <div><strong>Candidate A</strong><span>Eligible</span></div>
                  <small>84 behavior matches / security clean</small>
                  <span className="proof-meter"><i /><i /><i /></span>
                </div>
                <div className="proof-candidate" data-state="blocked">
                  <div><strong>Candidate B</strong><span>Blocked</span></div>
                  <small>Critical command-injection risk</small>
                  <span className="proof-meter"><i /><i /><i /></span>
                </div>
                <div className="proof-candidate" data-state="blocked">
                  <div><strong>Candidate C</strong><span>Blocked</span></div>
                  <small>Two legacy behaviors changed</small>
                  <span className="proof-meter"><i /><i /><i /></span>
                </div>
              </div>

              <div className="proof-comparison">
                <p><span>Selected boundary</span>Refund exactly $50.00 as an agent.</p>
                <div>
                  <span>Original service</span>
                  <strong>Approved / fee $2.50</strong>
                  <code>{'{ "status": 200, "approved": true }'}</code>
                </div>
                <div className="proof-match"><strong>Same result</strong><span>Behavior preserved</span></div>
                <div>
                  <span>Candidate A</span>
                  <strong>Approved / fee $2.50</strong>
                  <code>{'{ "status": 200, "approved": true }'}</code>
                </div>
              </div>
            </div>

            <div className="proof-chain" aria-label="Evidence chain">
              <span data-done="true">Rules</span>
              <span data-done="true">Corpus</span>
              <span data-done="true">Results</span>
              <span data-done="true">Scans</span>
              <span data-current="true">Approval</span>
            </div>
          </div>
        </section>

        <dl className="landing-fact-rail" aria-label="Example run facts">
          {proofFacts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>

        <section className="landing-tension" id="why" aria-labelledby="why-title">
          <div className="landing-section-index" aria-hidden="true">01 / THE RISK</div>
          <div className="landing-tension-title">
            <p className="eyebrow">Why existing tests are not enough</p>
            <h2 id="why-title">Most rewrite failures happen at the boundaries.</h2>
          </div>
          <div className="landing-tension-copy">
            <p>
              Legacy systems often contain behavior that was never documented: a fee applied at one
              exact threshold, an exception for a specific role, or a response field used by another
              service. A rewrite can pass its normal test suite and still change one of these details.
            </p>
            <p>
              IntentGuard makes those behaviors explicit and tests them directly. A candidate only
              passes when its recorded output matches the legacy service and its security checks are clean.
            </p>
          </div>
          <div className="boundary-register" aria-label="Example recovered boundary cases">
            <div><code>RULE 007</code><span>Amount equals approval limit</span><strong>Must match</strong></div>
            <div><code>RULE 011</code><span>Agent refund incurs fee</span><strong>Must match</strong></div>
            <div><code>RULE 014</code><span>Duplicate request is idempotent</span><strong>Must match</strong></div>
          </div>
        </section>

        <section className="landing-method" id="method" aria-labelledby="method-title">
          <div className="landing-method-intro">
            <div>
              <p className="eyebrow">How verification works</p>
              <h2 id="method-title">Every candidate goes through the same review.</h2>
            </div>
            <p>
              Each run follows the same sequence. IntentGuard locks the recovered rules, executes each
              target, compares the results, and applies the policy. The model can explain the record,
              but it cannot change the verdict.
            </p>
          </div>
          <ol className="method-list">
            {methodSteps.map((step) => (
              <li key={step.number}>
                <span className="method-number">{step.number}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <code>{step.output}</code>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-evidence" id="evidence" aria-labelledby="evidence-title">
          <div className="evidence-statement">
            <p className="eyebrow">Who makes the decision</p>
            <h2 id="evidence-title"><span>Recorded results decide.</span> A person approves.</h2>
            <p>
              The model helps recover business rules and explain the evidence. Pass or fail is determined
              by the recorded executions. A reviewer sees the complete record before approving a candidate.
            </p>
          </div>
          <div className="authority-record" aria-label="IntentGuard authority boundaries">
            <div><span>Model</span><strong>Find rules and explain results</strong><small>Does not vote</small></div>
            <div><span>Execution</span><strong>Run checks and apply policy</strong><small>Determines the result</small></div>
            <div><span>Reviewer</span><strong>Review the record and approve</strong><small>Makes the final call</small></div>
          </div>
        </section>

        <section className="landing-final" aria-labelledby="final-title">
          <p className="eyebrow">Review a complete run</p>
          <h2 id="final-title">See how each candidate performed.</h2>
          <p>Open the control room to review the comparisons, security findings, and final policy result.</p>
          <a className="landing-primary-action" href="/dashboard">Open the control room</a>
        </section>
      </main>

      <footer className="landing-footer">
        <span>INTENTGUARD / BEHAVIOR VERIFICATION FOR SOFTWARE REWRITES</span>
        <span>RECORDED RESULTS DETERMINE THE VERDICT / A REVIEWER APPROVES</span>
      </footer>
    </div>
  );
}
