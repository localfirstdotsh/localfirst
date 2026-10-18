import { checkStatus, compatibilityLabel, evidenceLabel, humanize } from '../../lib/format';
import type { Assessment } from '../../lib/schemas';

/**
 * Outcome and evidence are shown together, and an unknown result is neither
 * "probably fits" nor a failure (FRONTEND_PRD section 9.2). No fit score.
 */
export function CompatibilityResult({ assessment }: { assessment: Assessment }) {
  return (
    <div className="panel stack gap-16" aria-labelledby="check-result">
      <div className="stack gap-8">
        <h3 id="check-result" className="section-title">
          {compatibilityLabel(assessment.outcome)}
        </h3>
        <p className="small muted">
          Evidence: {evidenceLabel(assessment.evidence_level)} · Scope: {humanize(assessment.evidence_scope)}. This is an
          assessment of stated requirements, not a benchmark or permission to install.
        </p>
      </div>

      {assessment.checks.length > 0 && (
        <ul className="row-list check-list">
          {assessment.checks.map((check, index) => {
            const status = checkStatus(check.status);
            return (
              <li key={`${check.requirement}-${index}`}>
                <span className="check-status">
                  <span aria-hidden="true">{status.symbol} </span>
                  {status.label}
                </span>
                <span className="check-detail">
                  {humanize(check.requirement)}
                  <span className="muted"> — source: {humanize(check.source)}</span>
                  {check.detail && <span className="muted">. {check.detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {assessment.blockers.length > 0 && <Bullets title="Requirements that failed" items={assessment.blockers} />}
      {assessment.missing_prerequisites.length > 0 && (
        <Bullets title="Needed to assess this" items={assessment.missing_prerequisites} />
      )}
      {assessment.uncertainties.length > 0 && <Bullets title="Uncertain" items={assessment.uncertainties} />}
    </div>
  );
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h4 className="check-bullet-title">{title}</h4>
      <ul className="compact-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
