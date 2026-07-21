import { memo, useState } from "react";
import { annotateDocument } from "../lib/api.js";
import { downloadComplianceDocx, downloadComplianceMarkdown, getComplianceIssues, triggerDownload } from "../lib/reportExports.js";
import { formatBytes, humanizeStatus } from "../lib/formatters.js";
import { summarizeDiff } from "../lib/reportDiff.js";

function getAnnotatableIssues(report) {
  return (Array.isArray(report.issueInventory) ? report.issueInventory : []).filter(
    (issue) =>
      (issue.status === "warning" || issue.status === "fail") && Boolean(issue.location?.excerpt || issue.evidence),
  );
}

/**
 * Opens every collapsed <details> in the report region (the raw-JSON panel is
 * excluded — it is hidden in print anyway) and returns a restore function.
 * CSS alone cannot reliably force closed <details> content to render in
 * print, so the print button expands them for the duration of the dialog.
 */
function openReportDetailsForPrint() {
  const closedDetails = Array.from(document.querySelectorAll(".results-column details:not(.json-panel)")).filter(
    (node) => !node.open,
  );

  for (const node of closedDetails) {
    node.open = true;
  }

  return () => {
    for (const node of closedDetails) {
      node.open = false;
    }
  };
}

export default memo(function ReportSummary({ report, runDiff = null, sourceFile = null }) {
  const [isExportingDocx, setIsExportingDocx] = useState(false);
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [annotationNote, setAnnotationNote] = useState("");
  const [exportError, setExportError] = useState("");
  const complianceIssueCount = getComplianceIssues(report).length;
  const reviewModeLabel = report.review?.label || "Standard";
  const annotatableIssues = getAnnotatableIssues(report);
  // Only offer in-document comments while the original DOCX is still the one
  // this report was generated from.
  const canAnnotate =
    report.document.sourceFormat === "docx" &&
    Boolean(sourceFile) &&
    sourceFile.name === report.document.filename &&
    sourceFile.size === report.document.sizeBytes;

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

  async function handleAnnotatedDownload() {
    setIsAnnotating(true);
    setExportError("");
    setAnnotationNote("");

    try {
      const { blob, anchoredCount, unanchoredCount } = await annotateDocument(sourceFile, annotatableIssues);
      const baseName = sourceFile.name.replace(/\.docx$/i, "") || "document";

      triggerDownload(blob, `${baseName}-annotated.docx`);
      setAnnotationNote(
        `${anchoredCount} comment${anchoredCount === 1 ? "" : "s"} anchored; ${unanchoredCount} issue${
          unanchoredCount === 1 ? "" : "s"
        } could not be anchored (see the report list).`,
      );
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Unable to build the annotated document.");
    } finally {
      setIsAnnotating(false);
    }
  }

  function handlePrint() {
    const restoreDetails = openReportDetailsForPrint();

    try {
      window.print();
    } finally {
      restoreDetails();
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
          <button className="secondary-button" onClick={handlePrint} type="button">
            Print / Save PDF
          </button>
          <button className="secondary-button" onClick={handleMarkdownDownload} type="button">
            Download .md
          </button>
          <button className="primary-button" disabled={isExportingDocx} onClick={handleDocxDownload} type="button">
            {isExportingDocx ? "Building .docx..." : "Download .docx"}
          </button>
          {canAnnotate ? (
            <button
              className="secondary-button"
              disabled={isAnnotating || annotatableIssues.length === 0}
              onClick={handleAnnotatedDownload}
              type="button"
            >
              {isAnnotating ? "Annotating..." : "Download annotated .docx"}
            </button>
          ) : null}
        </div>
      </div>

      {annotationNote ? <p className="annotation-note">{annotationNote}</p> : null}

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
