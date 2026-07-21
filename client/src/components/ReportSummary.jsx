import { memo, useState } from "react";
import { downloadComplianceDocx, downloadComplianceMarkdown, getComplianceIssues } from "../lib/reportExports.js";
import { formatBytes, humanizeStatus } from "../lib/formatters.js";
import { summarizeDiff } from "../lib/reportDiff.js";

export default memo(function ReportSummary({ report, runDiff = null }) {
  const [isExportingDocx, setIsExportingDocx] = useState(false);
  const [exportError, setExportError] = useState("");
  const complianceIssueCount = getComplianceIssues(report).length;
  const reviewModeLabel = report.review?.label || "Standard";

  function handleMarkdownDownload() {
    try {
      setExportError("");
      downloadComplianceMarkdown(report);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Unable to download markdown report.");
    }
  }

  async function handleDocxDownload() {
    setIsExportingDocx(true);
    setExportError("");

    try {
      await downloadComplianceDocx(report);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Unable to download DOCX report.");
    } finally {
      setIsExportingDocx(false);
    }
  }

  return (
    <section className="panel report-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Final Report</div>
          <h3>Hybrid APA compliance summary</h3>
        </div>
        <div className={`status-pill ${report.summary.overallStatus}`}>{humanizeStatus(report.summary.overallStatus)}</div>
      </div>

      {report.cached ? (
        <p className="report-cached-note">Instant result — this exact file was reviewed recently.</p>
      ) : null}

      {runDiff ? (
        <div className="run-diff-strip">
          <div className="run-diff-heading">
            <span className="eyebrow">Since your last run</span>
            <strong>{summarizeDiff(runDiff)}</strong>
          </div>
          <div className="run-diff-stats">
            <span className="run-diff-stat is-resolved">{runDiff.resolved.length} resolved</span>
            <span className="run-diff-stat is-added">{runDiff.added.length} new</span>
            <span className="run-diff-stat is-persisting">{runDiff.persisting.length} remaining</span>
          </div>
        </div>
      ) : null}

      <div className="report-actions">
        <div className="report-action-copy">
          <strong>{complianceIssueCount} item-level issue{complianceIssueCount === 1 ? "" : "s"} available for export</strong>
          <span>{reviewModeLabel} mode. Download every warning/fail issue with its best-effort DOCX location as Markdown or Word.</span>
        </div>
        <div className="report-action-buttons">
          <button className="secondary-button" onClick={handleMarkdownDownload} type="button">
            Download .md
          </button>
          <button className="primary-button" disabled={isExportingDocx} onClick={handleDocxDownload} type="button">
            {isExportingDocx ? "Building .docx..." : "Download .docx"}
          </button>
        </div>
      </div>

      <div className="summary-grid">
        <div className="summary-card">
          <span>Overall score</span>
          <strong>{report.summary.overallScore}/100</strong>
        </div>
        <div className="summary-card">
          <span>Warnings</span>
          <strong>{report.summary.warningCount}</strong>
        </div>
        <div className="summary-card">
          <span>Failures</span>
          <strong>{report.summary.failCount}</strong>
        </div>
        <div className="summary-card">
          <span>References missing</span>
          <strong>{report.document.referencesMissing ? "Yes" : "No"}</strong>
        </div>
        {report.summary.aiAssessment ? (
          <div className="summary-card">
            <span>AI assessment</span>
            <strong>{report.summary.aiAssessment.overallScore}/100</strong>
            <span className="summary-card-note">{report.summary.aiAssessment.confidence} confidence</span>
          </div>
        ) : null}
      </div>

      <p className="report-headline">{report.summary.headline}</p>

      <div className="report-columns">
        <div>
          <h4>Priority actions</h4>
          <ul className="report-list">
            {report.priorityActions.length > 0 ? (
              report.priorityActions.map((action) => <li key={action}>{action}</li>)
            ) : (
              <li>No priority actions were generated.</li>
            )}
          </ul>
        </div>

        <div>
          <h4>Document metrics</h4>
          <ul className="report-list">
            <li>Filename: {report.document.filename}</li>
            <li>File size: {formatBytes(report.document.sizeBytes)}</li>
            <li>Source format: {report.document.sourceFormat ? report.document.sourceFormat.toUpperCase() : "Unknown"}</li>
            <li>Review mode: {reviewModeLabel}</li>
            <li>Total words parsed: {report.document.totalWords}</li>
            <li>Reference entries: {report.document.metrics.referenceEntryCount}</li>
            <li>Model: {report.llm.model || "Rule-based only"}</li>
          </ul>
        </div>
      </div>

      <div className="report-columns">
        <div>
          <h4>Limitations</h4>
          <ul className="report-list">
            {report.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div>
          <h4>Cross-checks</h4>
          <ul className="report-list">
            <li>Unmatched citations: {report.crossChecks.unmatchedCitations.length}</li>
            <li>Uncited references: {report.crossChecks.uncitedReferences.length}</li>
            <li>Rule-based status: {humanizeStatus(report.summary.ruleBasedStatus)}</li>
            <li>LLM status: {report.summary.llmStatus ? humanizeStatus(report.summary.llmStatus) : "Skipped"}</li>
          </ul>
        </div>
      </div>

      {exportError ? <p className="app-error">{exportError}</p> : null}
    </section>
  );
});
