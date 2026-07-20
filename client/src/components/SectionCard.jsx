import { memo, useState } from "react";
import { humanizeStatus } from "../lib/formatters.js";

function scoreLabel(score) {
  return Number.isFinite(score) ? `${score}/100` : "Pending";
}

export default memo(function SectionCard({ fallbackLabel, section, sectionId }) {
  const [isOpen, setIsOpen] = useState(sectionId === "llm");

  if (!section) {
    return (
      <details className={`section-card is-pending ${sectionId === "llm" ? "is-featured" : ""}`} open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
        <summary className="section-card-summary">
          <div className="section-card-header">
            <div>
              <div className="eyebrow">Section</div>
              <h4>{fallbackLabel}</h4>
            </div>
            <div className="section-card-summary-meta">
              <span className="status-pill pending">Pending</span>
              <span className="disclosure-indicator" aria-hidden="true" />
            </div>
          </div>
        </summary>
        <div className="section-card-body">
          <div className="placeholder-lines">
            <span />
            <span />
            <span />
          </div>
        </div>
      </details>
    );
  }

  return (
    <details className={`section-card ${section.id === "llm" ? "is-featured" : ""}`} open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
      <summary className="section-card-summary">
        <div className="section-card-header">
          <div>
            <div className="eyebrow">Section</div>
            <h4>{section.label}</h4>
          </div>
          <div className="section-card-summary-meta">
            <span className={`status-pill ${section.status || "pending"}`}>{humanizeStatus(section.status)}</span>
            <span className="disclosure-indicator" aria-hidden="true" />
          </div>
        </div>
      </summary>

      <div className="section-card-body">
        <div className="section-card-meta">
          <span>Score: {scoreLabel(section.score)}</span>
          <span>{section.findings?.length ?? 0} findings</span>
        </div>

        <p className="section-summary">{section.summary}</p>

        <div className="section-findings">
          {(section.findings ?? []).map((finding) => (
            <div className="finding-row" key={finding.id}>
              <span className={`finding-marker ${finding.status}`} />
              <div>
                <strong>{finding.title}</strong>
                <p>{finding.detail}</p>
                {finding.location?.label ? <p className="finding-location">Location: {finding.location.label}</p> : null}
                {finding.recommendation ? <p className="finding-recommendation">Action: {finding.recommendation}</p> : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
});
