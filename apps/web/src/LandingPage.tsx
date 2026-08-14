const proofStats = [
  { value: "84", label: "boundary checks", detail: "Legacy output compared directly" },
  { value: "4", label: "isolated environments", detail: "Built from one snapshot" },
  { value: "3", label: "security scans", detail: "One result per candidate" },
  { value: "1", label: "review record", detail: "Evidence preserved for approval" },
] as const;

const methodSteps = [
  {
    number: "01",
    title: "Recover what production does",
    body: "Forge turns legacy behavior into explicit business rules and boundary inputs.",
  },
  {
    number: "02",
    title: "Run every target the same way",
    body: "The legacy service and each rewrite process the same inputs in matching environments.",
  },
  {
    number: "03",
    title: "Approve from the record",
    body: "IntentGuard compares outputs and security results, then gives a reviewer the complete decision record.",
  },
] as const;

const evidenceSources = [
  { source: "Forge", evidence: "Recovered rules" },
  { source: "Daytona", evidence: "Isolated executions" },
  { source: "Snyk", evidence: "Security findings" },
  { source: "Control", evidence: "Policy and approval" },
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
        <p className="landing-header-note">Execution decides / a reviewer approves</p>
      </header>

      <main className="landing-main" id="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="eyebrow">Legacy rewrite verification</p>
            <h1 id="landing-title">
              Ship the rewrite that
              <span>behaves like production.</span>
            </h1>
            <p className="landing-lead">
              IntentGuard runs your legacy service and every rewrite against the same recovered
              business rules. You see exactly what changed, which candidates are safe, and the
              evidence behind the decision.
            </p>
            <a className="landing-primary-action" href="/dashboard">
              Review a verified run
              <span aria-hidden="true">01</span>
            </a>
            <ul className="landing-assurance" aria-label="Verification guarantees">
              <li>Recorded executions</li>
              <li>Matching environments</li>
              <li>Human approval</li>
            </ul>
          </div>

          <figure className="landing-product-visual" aria-labelledby="product-visual-title">
            <figcaption>
              <span id="product-visual-title">Product view / candidate review</span>
              <code>RUN-WEB-MOCK-001</code>
            </figcaption>

            <div className="product-verdict-strip">
              <div>
                <span>Policy result</span>
                <strong>Recommend Candidate A</strong>
              </div>
              <span className="product-run-state">Ready for review</span>
            </div>

            <div className="product-review-grid">
              <div className="product-candidate-list" aria-label="Candidate outcomes">
                <div data-result="eligible">
                  <span>Candidate A</span>
                  <strong>Eligible</strong>
                  <small>84 matches / security clean</small>
                </div>
                <div data-result="blocked">
                  <span>Candidate B</span>
                  <strong>Blocked</strong>
                  <small>Critical security finding</small>
                </div>
                <div data-result="blocked">
                  <span>Candidate C</span>
                  <strong>Blocked</strong>
                  <small>Legacy behavior changed</small>
                </div>
              </div>

              <div className="product-comparison">
                <div className="product-comparison-heading">
                  <span>Boundary check / REQ-014</span>
                  <strong>Refund at the manager threshold</strong>
                </div>
                <div className="product-output-grid">
                  <div>
                    <span>Legacy service</span>
                    <strong>Manager review required</strong>
                    <code>approved: false</code>
                  </div>
                  <div>
                    <span>Candidate A</span>
                    <strong>Manager review required</strong>
                    <code>approved: false</code>
                  </div>
                </div>
                <div className="product-match-row">
                  <span>Recorded result</span>
                  <strong>Behavior preserved</strong>
                </div>
              </div>
            </div>

            <div className="product-evidence-chain" aria-label="Evidence chain">
              <span data-complete="true">Rules locked</span>
              <span data-complete="true">Inputs replayed</span>
              <span data-complete="true">Scans complete</span>
              <span data-current="true">Review ready</span>
            </div>
          </figure>
        </section>

        <section className="landing-proof" aria-labelledby="proof-title">
          <div className="landing-proof-heading">
            <p className="eyebrow">Trust the record, not the pitch</p>
            <h2 id="proof-title">One decision, backed by evidence you can inspect.</h2>
            <p>
              Every recommendation links back to the rules, environments, outputs, and findings
              that produced it. Environment failures remain visible and never become synthetic passes.
            </p>
          </div>

          <dl className="landing-proof-stats" aria-label="Sample verification record">
            {proofStats.map((stat) => (
              <div key={stat.label}>
                <dt><strong>{stat.value}</strong> {stat.label}</dt>
                <dd>{stat.detail}</dd>
              </div>
            ))}
          </dl>

          <div className="landing-source-strip" aria-label="Evidence sources">
            <span>Evidence sources</span>
            {evidenceSources.map((item) => (
              <div key={item.source}>
                <strong>{item.source}</strong>
                <small>{item.evidence}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="landing-method" aria-labelledby="method-title">
          <div className="landing-method-intro">
            <div>
              <p className="eyebrow">From source code to approval</p>
              <h2 id="method-title">A repeatable review, not a model opinion.</h2>
            </div>
            <p>
              The model can recover rules and explain results. It cannot vote on pass or fail.
              Recorded execution and policy determine the result.
            </p>
          </div>

          <ol className="landing-method-steps">
            {methodSteps.map((step) => (
              <li key={step.number}>
                <span>{step.number}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="landing-footer">
        <span>INTENTGUARD / BEHAVIOR VERIFICATION FOR SOFTWARE REWRITES</span>
        <span>RECORDED EXECUTION / POLICY RESULT / HUMAN APPROVAL</span>
      </footer>
    </div>
  );
}
